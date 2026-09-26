/**
 * Identifiers and canonical hashing.
 *
 * `canonicalJson` is the security-relevant function here: Risk signs a hash of
 * the proposal, and the executor recomputes that hash from the proposal object it
 * was handed. If the serialisation is not canonical — if key order or spacing
 * changes between the two — a legitimate proposal will fail verification, and
 * worse, a tampered one could evade a naive comparison.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Hex } from "../types.js";

/**
 * Deterministically serialise a JSON value.
 *
 * Object keys are sorted at every depth. `undefined` values are dropped, matching
 * JSON semantics. No whitespace. Arrays keep their order, because order is
 * semantically meaningful in this system.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    // `undefined` inside an object is dropped by JSON.stringify; normalise it to
    // null at the top so behaviour is identical here and in JSON.stringify.
    return value === undefined ? null : value;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = sortValue(v);
  }
  return out;
}

export function sha256Hex(input: string): Hex {
  return `0x${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

/** Canonical hash of any JSON value. This is what gets signed and verified. */
export function hashObject(value: unknown): Hex {
  return sha256Hex(canonicalJson(value));
}

/** Prefixed, sortable, non-guessable id. e.g. `prop_01JQ...`. */
export function newId(prefix: string): string {
  const ts = Date.now().toString(36).padStart(9, "0");
  const rand = randomBytes(8).toString("hex");
  return `${prefix}_${ts}${rand}`;
}

/** ISO-8601 timestamp, the only time format written to the audit log. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export function isExpired(iso: string, atMs = Date.now()): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= atMs;
}
