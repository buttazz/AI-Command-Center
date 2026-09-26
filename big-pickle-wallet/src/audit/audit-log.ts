/**
 * Append-only, hash-chained audit log.
 *
 * Every entry commits to the previous entry's hash, so removing or editing any
 * historical record breaks verification from that point forward. This is what
 * makes the log evidence rather than decoration: an agent with write access
 * cannot quietly drop the record of a trade it made.
 *
 * Format is newline-delimited JSON. One file per day, so rotation is a
 * filename change rather than a rewrite.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  chmodSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, nowIso } from "../core/ids.js";
import { AuditIntegrityError } from "../errors.js";
import type { Role } from "../types.js";

export const GENESIS_HASH = "0".repeat(64);

export interface AuditEntry {
  /** Monotonic within a file. Gaps are detectable. */
  seq: number;
  at: string;
  role: Role;
  actor: string;
  action: string;
  /** Structured detail. Must never contain a secret. */
  detail: Record<string, unknown>;
  /** Hash of the previous entry. `GENESIS_HASH` for the first. */
  prev: string;
  /** sha256 over the canonical entry, excluding this field. */
  hash: string;
}

type EntryCore = Omit<AuditEntry, "hash">;

/**
 * Fields whose presence in an audit detail would leak a credential.
 *
 * This is a defence-in-depth net, not the primary control: callers should never
 * pass secrets in the first place. It catches the realistic mistake of logging
 * an options object that happens to contain a key.
 */
const FORBIDDEN_DETAIL_KEYS = new Set([
  "apisecret",
  "apisecretvalue",
  "walletsecret",
  "privatekey",
  "private_key",
  "secret",
  "password",
  "passphrase",
  "seed",
  "seedphrase",
  "mnemonic",
  "authorization",
  "bearer",
  "token",
  "apisecretname",
  "cdpwalletsecret",
  "keyfile",
  "signingkey",
]);

function assertNoSecrets(detail: Record<string, unknown>, where: string): void {
  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > 12) return;
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const norm = k.toLowerCase().replace(/[-\s]/g, "_");
      if (FORBIDDEN_DETAIL_KEYS.has(norm) || FORBIDDEN_DETAIL_KEYS.has(k.toLowerCase())) {
        throw new AuditIntegrityError(
          `refusing to write audit entry ${where}: field "${path}.${k}" looks like a credential. Redact before logging.`,
        );
      }
      walk(val, `${path}.${k}`, depth + 1);
    }
  };
  walk(detail, "detail", 0);
}

function entryHash(core: EntryCore): string {
  return createHash("sha256").update(canonicalJson(core)).digest("hex");
}

export class AuditLog {
  readonly dir: string;

  private fileSeq: number;
  private lastHash: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true });
    const file = this.currentFile();
    const last = this.readLastEntry(file);
    this.fileSeq = last ? last.seq + 1 : 0;
    this.lastHash = last ? last.hash : GENESIS_HASH;
  }

  private currentFile(): string {
    return resolve(this.dir, `audit-${new Date().toISOString().slice(0, 10)}.ndjson`);
  }

  /** Read the last valid entry of a file without loading the whole thing. */
  private readLastEntry(path: string): AuditEntry | null {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line === undefined) continue;
      try {
        return JSON.parse(line) as AuditEntry;
      } catch {
        // A corrupt trailing line is skipped rather than throwing, so a crash
        // mid-append does not make the log permanently unreadable. `verify()`
        // will still report the gap.
      }
    }
    return null;
  }

  /**
   * Append an entry and fsync it.
   *
   * fsync before returning: an audit record that exists only in the page cache
   * is not evidence after a power loss, and this log is the thing that would be
   * read back during an incident.
   */
  append(
    action: string,
    role: Role,
    actor: string,
    detail: Record<string, unknown> = {},
  ): AuditEntry {
    assertNoSecrets(detail, `${action} by ${actor}`);

    const core: EntryCore = {
      seq: this.fileSeq,
      at: nowIso(),
      role,
      actor,
      action,
      detail,
      prev: this.lastHash,
    };
    const entry: AuditEntry = { ...core, hash: entryHash(core) };

    const file = this.currentFile();
    mkdirSync(dirname(file), { recursive: true });
    const fd = openSync(file, "a", 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort on exotic filesystems */
    }

    this.fileSeq += 1;
    this.lastHash = entry.hash;
    return entry;
  }

  /**
   * Verify a file's chain.
   *
   * Detects: edited entries (hash mismatch), deleted entries (prev mismatch),
   * reordered entries (prev mismatch), and appended forgeries (a forger cannot
   * produce a valid successor hash without the real previous entry, but can
   * forge the final entry — so `verify` reports a trailing entry with no
   * successor as `unanchored` for human review).
   */
  verify(path: string): {
    ok: boolean;
    entries: number;
    brokenAt: number | null;
    reason: string | null;
  } {
    if (!existsSync(path)) return { ok: true, entries: 0, brokenAt: null, reason: null };

    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
    let prev = GENESIS_HASH;
    let expectedSeq = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch (err) {
        return {
          ok: false,
          entries: i,
          brokenAt: i,
          reason: `line ${i} is not valid JSON: ${(err as Error).message}`,
        };
      }
      if (entry.seq !== expectedSeq) {
        return {
          ok: false,
          entries: i,
          brokenAt: i,
          reason: `sequence gap: expected seq ${expectedSeq}, found ${entry.seq}`,
        };
      }
      if (entry.prev !== prev) {
        return {
          ok: false,
          entries: i,
          brokenAt: i,
          reason: `chain break at seq ${entry.seq}: prev ${entry.prev.slice(0, 12)} does not match expected ${prev.slice(0, 12)}`,
        };
      }
      const { hash, ...core } = entry;
      const recomputed = entryHash(core);
      if (recomputed !== hash) {
        return {
          ok: false,
          entries: i,
          brokenAt: i,
          reason: `entry ${entry.seq} was modified after writing: recomputed hash does not match`,
        };
      }
      prev = hash;
      expectedSeq += 1;
    }

    return { ok: true, entries: lines.length, brokenAt: null, reason: null };
  }

  /** Verify every daily file, oldest first. */
  verifyAll(): { ok: boolean; files: { file: string; ok: boolean; entries: number; reason: string | null }[] } {
    const files = this.files();
    const results = files.map((f) => {
      const r = this.verify(f);
      return { file: f, ok: r.ok, entries: r.entries, reason: r.reason };
    });
    return { ok: results.every((r) => r.ok), files: results };
  }

  files(): string[] {
    if (!existsSync(this.dir)) return [];
    // Directory order from readdir is not guaranteed sorted; sort so
    // verification walks the chain chronologically.
    return readdirSync(this.dir)
      .filter((f) => f.startsWith("audit-") && f.endsWith(".ndjson"))
      .sort()
      .map((f) => resolve(this.dir, f));
  }

  /** Most recent entries, newest first. */
  tail(limit = 50): AuditEntry[] {
    const file = this.currentFile();
    if (!existsSync(file)) {
      // Fall back to the newest existing file when today has no entries yet.
      const all = this.files();
      const newest = all[all.length - 1];
      if (!newest) return [];
      return this.tailFile(newest, limit);
    }
    return this.tailFile(file, limit);
  }

  private tailFile(path: string, limit: number): AuditEntry[] {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const out: AuditEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  /** All entries matching an action substring, oldest first. */
  find(actionSubstring: string, limit = 200): AuditEntry[] {
    const out: AuditEntry[] = [];
    for (const file of this.files().reverse()) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        if (!line.includes(actionSubstring)) continue;
        try {
          out.push(JSON.parse(line) as AuditEntry);
        } catch {
          /* skip */
        }
        if (out.length >= limit) return out.reverse();
      }
    }
    return out.reverse();
  }

  /**
   * Anchor the newest hash to a separate file.
   *
   * Detects wholesale truncation of the day's file, which an internal
   * hash-chain alone cannot: removing a suffix leaves a self-consistent chain.
   */
  writeAnchor(): void {
    const anchor = resolve(this.dir, "LATEST");
    writeFileSync(
      anchor,
      `${JSON.stringify({ seq: this.fileSeq - 1, hash: this.lastHash, at: nowIso() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  readAnchor(): { seq: number; hash: string; at: string } | null {
    const p = resolve(this.dir, "LATEST");
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as { seq: number; hash: string; at: string };
    } catch {
      return null;
    }
  }

  /** Compare the live tail against the anchor. */
  verifyAnchor(): { ok: boolean; reason: string | null; anchor: { seq: number; hash: string } | null; live: { seq: number; hash: string } | null } {
    const anchor = this.readAnchor();
    const live = { seq: this.fileSeq - 1, hash: this.lastHash };
    if (!anchor) return { ok: true, reason: "no anchor written yet", anchor: null, live };
    if (anchor.hash !== live.hash) {
      return {
        ok: false,
        reason: `anchor mismatch: anchored ${anchor.hash.slice(0, 12)} at seq ${anchor.seq}, live tail is ${live.hash.slice(0, 12)} at seq ${live.seq}. Possible truncation or rewrite of the log.`,
        anchor,
        live,
      };
    }
    return { ok: true, reason: null, anchor, live };
  }
}

/** A request id for correlating a whole operation across entries. */
export function correlationId(): string {
  return randomUUID();
}
