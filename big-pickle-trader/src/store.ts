import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentState, RiskPolicy } from "./types.js";
import { USDC, WETH } from "./addresses.js";

export const STATE_DIR = process.env.BP_STATE_DIR ?? join(process.cwd(), "state");
export const STATE_PATH = join(STATE_DIR, "state.json");
export const LOCK_PATH = join(STATE_DIR, "state.lock");
const LOCK_STALE_MS = 15_000;

export const DEFAULT_POLICY: RiskPolicy = {
  maxTradeUsdc: "10.00",
  maxTotalExposureUsdc: "50.00",
  maxDailySpendUsdc: "50.00",
  minTradeUsdc: "1.00",
  slippageToleranceBps: 50,
  reserveUsdc: "2.00",
  reserveEthWei: "1000000000000000",
  maxTradesPerHour: 6,
  allowedTokens: [WETH, USDC],
  enabledStrategies: ["spot-swap", "rebalance"],
};

export function defaultState(): AgentState {
  return {
    version: 1,
    mode: "AUTONOMOUS",
    modeChangedAt: new Date().toISOString(),
    modeChangedBy: "owner",
    modeReason: "initial state",
    resumeTo: "AUTONOMOUS",
    pendingReconcile: false,
    revision: 0,
    policy: { ...DEFAULT_POLICY, allowedTokens: [...DEFAULT_POLICY.allowedTokens], enabledStrategies: [...DEFAULT_POLICY.enabledStrategies] },
    positions: [],
    dailySpend: { day: new Date().toISOString().slice(0, 10), usdc: "0", trades: 0 },
    recentTradeTimestamps: [],
    lastSentNonce: -1,
    lastReconciledBlock: 0n,
    noncesAtReconcile: null,
    pendingTxs: [],
    ownerAddress: null,
    agentAddress: null,
  };
}

function ensureDir(path: string) {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
}

/**
 * Cross-process advisory lock. The engine and the owner CLI are separate
 * processes sharing one state file; without this, a reconcile could read a
 * half-written state and resume trading on stale balances.
 */
export function acquireLock(timeoutMs = 10_000): () => void {
  ensureDir(LOCK_PATH);
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(LOCK_PATH, "wx");
      closeSync(fd);
      break;
    } catch {
      // Break a lock left behind by a crashed process.
      try {
        const age = Date.now() - statSync(LOCK_PATH).mtimeMs;
        if (age > LOCK_STALE_MS) {
          unlinkSync(LOCK_PATH);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`could not acquire state lock at ${LOCK_PATH} after ${timeoutMs}ms`);
      }
      // Synchronous sleep is fine here: this runs once per state mutation.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return () => {
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* already gone */
    }
  };
}

export function loadState(): AgentState {
  if (!existsSync(STATE_PATH)) return defaultState();
  const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as AgentState;
  // bigint round-trips as string in JSON; restore the two bigint fields.
  raw.lastReconciledBlock = BigInt(raw.lastReconciledBlock ?? 0);
  raw.noncesAtReconcile = raw.noncesAtReconcile == null ? null : BigInt(raw.noncesAtReconcile);
  return raw;
}

/** Atomically persist. Bumps `revision` so in-flight agent plans can detect staleness. */
export function saveState(state: AgentState): AgentState {
  ensureDir(STATE_PATH);
  const next: AgentState = { ...state, revision: state.revision + 1 };
  const tmp = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  renameSync(tmp, STATE_PATH);
  return next;
}

/** Read-modify-write under the lock, so concurrent owner/engine updates cannot interleave. */
export function mutate<T>(fn: (state: AgentState) => T): T {
  const release = acquireLock();
  try {
    const state = loadState();
    const result = fn(state);
    saveState(state);
    return result;
  } finally {
    release();
  }
}
