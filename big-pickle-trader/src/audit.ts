import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEvent } from "./types.js";
import { STATE_DIR } from "./store.js";

const AUDIT_PATH = process.env.BP_AUDIT_PATH ?? `${STATE_DIR}/audit.jsonl`;

/**
 * Append-only audit log. One JSON object per line, fsync'd.
 *
 * The owner must be able to inspect every decision, order and transaction, and
 * must never be able to be hidden from this log. So: nothing in this module
 * rewrites or truncates the file. Rotation, if ever added, must copy-then-append
 * and be owner-triggered only.
 */
export function audit(event: AuditEvent & { at?: string }): void {
  if (!existsSync(dirname(AUDIT_PATH))) mkdirSync(dirname(AUDIT_PATH), { recursive: true });
  const record = { at: new Date().toISOString(), pid: process.pid, ...event };
  appendFileSync(AUDIT_PATH, JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
}

export interface AuditQuery {
  kinds?: string[];
  since?: string;
  limit?: number;
}

export function readAudit(query: AuditQuery = {}): Record<string, unknown>[] {
  if (!existsSync(AUDIT_PATH)) return [];
  const lines = readFileSync(AUDIT_PATH, "utf8").split("\n").filter(Boolean);
  let out: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (query.kinds && !query.kinds.includes(String(rec.kind))) continue;
      if (query.since && String(rec.at) < query.since) continue;
      out.push(rec);
    } catch {
      // A torn final line can happen if the process died mid-write; skip it.
    }
  }
  if (query.limit && out.length > query.limit) out = out.slice(-query.limit);
  return out;
}

export function auditPath(): string {
  return AUDIT_PATH;
}
