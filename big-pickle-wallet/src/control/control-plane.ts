/**
 * The control plane: kill switch, de-risk mode, and anomaly circuit breaker.
 *
 * This module is the reason a total agent failure is survivable. It imports no
 * agent runtime, talks to no LLM, and holds no wallet credential. It is
 * consulted before every signing decision, and it fails closed.
 *
 * Three independent states, each stricter than the last:
 *
 *   normal    trading permitted within limits
 *   de-risk   risk-reducing actions only  (daily loss, loss streak, cooldown)
 *   frozen    nothing moves until a human resumes (anomaly circuit breaker)
 *
 * Plus an orthogonal `killSwitch` which overrides all three, in both directions.
 * A human can engage it with no credentials beyond local file access, and it is
 * effective even when every agent process and the executor are dead.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { Policy } from "../policy/schema.js";
import { Money } from "../core/money.js";
import { newId, nowIso, isExpired } from "../core/ids.js";
import { KillSwitchEngaged } from "../errors.js";

export type ControlState = "normal" | "de-risk" | "frozen";

/** An action's effect on risk. This is the axis de-risk mode gates on. */
export type RiskDirection = "increase" | "reduce" | "neutral";

export interface KillSwitchFile {
  engaged: boolean;
  /** null when disengaged. */
  engagedAt: string | null;
  engagedBy: string | null;
  reason: string | null;
}

export interface FreezeFile {
  frozen: boolean;
  frozenAt: string | null;
  /** Why the breaker tripped. Kept verbatim for the audit log. */
  tripReason: string | null;
  tripDetail: string | null;
  /** Set when a human resumes, with their reason. */
  resumedAt: string | null;
  resumedBy: string | null;
  resumeNote: string | null;
}

export interface DayLedger {
  /** UTC date, `YYYY-MM-DD`. Resets on date change. */
  day: string;
  startPortfolioValueMicros: string;
  /** Realised P/L today, signed, micro-USDC. */
  realisedPnlMicros: string;
  /** Gross capital deployed today, micro-USDC. */
  deployedTodayMicros: string;
  /** Realised P/L of the most recent closed trades, oldest last. */
  recentRealisedPnlMicros: string[];
  tradeCount: number;
}

export interface AnomalyCounters {
  consecutiveReverts: number;
  lastRpcReadAt: string | null;
  lastRpcReadSignature: string | null;
  rpcInconsistencyStreak: number;
  attestationFailures: number;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyLedger(startMicros: bigint): DayLedger {
  return {
    day: todayUtc(),
    startPortfolioValueMicros: startMicros.toString(),
    realisedPnlMicros: "0",
    deployedTodayMicros: "0",
    recentRealisedPnlMicros: [],
    tradeCount: 0,
  };
}

/**
 * Atomic file write. Write to a temp file then rename, so a crash mid-write
 * cannot leave a half-written kill switch that parses as "not engaged".
 *
 * A truncated kill switch read as disengaged would be a total security failure,
 * so the engaged flag is written first and the file is fsync-free but atomic.
 */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // A corrupt control file is treated as absent, which for the kill switch
    // means "not engaged". The constructor therefore treats a corrupt kill
    // switch as engaged. See loadKillSwitch.
    return null;
  }
}

export interface ControlPaths {
  root: string;
  killSwitch: string;
  freeze: string;
  ledger: string;
}

export function defaultControlPaths(root: string): ControlPaths {
  return {
    root,
    killSwitch: resolve(root, "control", "KILL_SWITCH"),
    freeze: resolve(root, "control", "FREEZE"),
    ledger: resolve(root, "control", "day-ledger.json"),
  };
}

export interface ControlVerdict {
  allowed: boolean;
  state: ControlState;
  reasons: string[];
}

/**
 * Owns all trading-state authority on disk.
 *
 * Construct once per process. Every signing path must call `authorize()`.
 */
export class ControlPlane {
  readonly policy: Policy;
  readonly paths: ControlPaths;

  private kill: KillSwitchFile;
  private freeze: FreezeFile;
  private ledger: DayLedger;
  private counters: AnomalyCounters = {
    consecutiveReverts: 0,
    lastRpcReadAt: null,
    lastRpcReadSignature: null,
    rpcInconsistencyStreak: 0,
    attestationFailures: 0,
  };
  private cooldownUntil: string | null = null;

  constructor(policy: Policy, paths: ControlPaths) {
    this.policy = policy;
    this.paths = paths;
    this.kill = this.loadKillSwitch();
    this.freeze = this.loadFreeze();
    this.ledger = this.loadLedger();
  }

  // --- kill switch --------------------------------------------------------

  /**
   * Load the kill switch, treating a *corrupt* file as engaged.
   *
   * This is deliberate. An unreadable kill switch is far more likely to be
   * tampering or disk damage than a legitimate disengaged state, and the safe
   * interpretation of "I cannot tell whether trading is halted" is "halt".
   */
  private loadKillSwitch(): KillSwitchFile {
    if (!existsSync(this.paths.killSwitch)) {
      return { engaged: false, engagedAt: null, engagedBy: null, reason: null };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.paths.killSwitch, "utf8")) as KillSwitchFile;
      return { ...parsed, engaged: parsed.engaged === true };
    } catch {
      return {
        engaged: true,
        engagedAt: nowIso(),
        engagedBy: "system",
        reason: "kill switch file present but unreadable; failing safe to engaged",
      };
    }
  }

  isKillSwitchEngaged(): boolean {
    // Re-read every time. The file may have been flipped by a human while this
    // process was running, and a cached value would mean a stale "not engaged".
    this.kill = this.loadKillSwitch();
    return this.kill.engaged;
  }

  /**
   * Engage the kill switch. No credentials required beyond filesystem access.
   * This is the emergency stop, and it works with every agent process dead.
   */
  engageKillSwitch(by: string, reason: string): KillSwitchFile {
    this.kill = {
      engaged: true,
      engagedAt: nowIso(),
      engagedBy: by,
      reason,
    };
    writeJsonAtomic(this.paths.killSwitch, this.kill);
    return this.kill;
  }

  /**
   * Release the kill switch.
   *
   * Only the owner may do this. Guarded by requiring an explicit reason, which
   * is recorded in the file and therefore in the audit log: releasing a freeze
   * should never be an unreviewed action.
   */
  releaseKillSwitch(by: string, reason: string): KillSwitchFile {
    if (this.kill.engagedBy && this.kill.engagedBy !== "owner" && by !== "owner") {
      throw new KillSwitchEngaged("all", this.kill.engagedAt ?? nowIso());
    }
    this.kill = { engaged: false, engagedAt: null, engagedBy: null, reason: null };
    writeJsonAtomic(this.paths.killSwitch, { ...this.kill, releaseReason: reason, releasedBy: by, releasedAt: nowIso() });
    return this.kill;
  }

  killSwitchInfo(): KillSwitchFile {
    this.kill = this.loadKillSwitch();
    return this.kill;
  }

  // --- freeze / circuit breaker ------------------------------------------

  private loadFreeze(): FreezeFile {
    if (!existsSync(this.paths.freeze)) {
      return { frozen: false, frozenAt: null, tripReason: null, tripDetail: null, resumedAt: null, resumedBy: null, resumeNote: null };
    }
    try {
      return JSON.parse(readFileSync(this.paths.freeze, "utf8")) as FreezeFile;
    } catch {
      return {
        frozen: true,
        frozenAt: nowIso(),
        tripReason: "freeze file present but unreadable; failing safe to frozen",
        tripDetail: null,
        resumedAt: null,
        resumedBy: null,
        resumeNote: null,
      };
    }
  }

  isFrozen(): boolean {
    this.freeze = this.loadFreeze();
    return this.freeze.frozen;
  }

  freezeInfo(): FreezeFile {
    this.freeze = this.loadFreeze();
    return this.freeze;
  }

  /**
   * Trip the circuit breaker. Sticky: nothing but an explicit human resume
   * clears it. Called on any wallet/API/execution anomaly.
   */
  trip(reason: string, detail?: string): FreezeFile {
    if (this.freeze.frozen) return this.freeze;
    this.freeze = {
      frozen: true,
      frozenAt: nowIso(),
      tripReason: reason,
      tripDetail: detail ?? null,
      resumedAt: null,
      resumedBy: null,
      resumeNote: null,
    };
    writeJsonAtomic(this.paths.freeze, this.freeze);
    return this.freeze;
  }

  /** Owner-only. Clears the freeze and records who cleared it and why. */
  resume(by: string, note: string): FreezeFile {
    if (by !== "owner") {
      throw new KillSwitchEngaged("all", this.freeze.frozenAt ?? nowIso());
    }
    this.freeze = { ...this.freeze, frozen: false, resumedAt: nowIso(), resumedBy: by, resumeNote: note };
    writeJsonAtomic(this.paths.freeze, this.freeze);
    return this.freeze;
  }

  // --- day ledger --------------------------------------------------------

  private loadLedger(): DayLedger {
    const l = readJson<DayLedger>(this.paths.ledger);
    if (!l || l.day !== todayUtc()) return emptyLedger(0n);
    return l;
  }

  private saveLedger(): void {
    writeJsonAtomic(this.paths.ledger, this.ledger);
  }

  /** Seed the day's opening portfolio value. No-op if already seeded today. */
  seedDay(portfolioValueMicros: bigint): DayLedger {
    this.ledger = this.loadLedger();
    if (this.ledger.day !== todayUtc() || this.ledger.startPortfolioValueMicros === "0") {
      this.ledger = emptyLedger(portfolioValueMicros);
      this.saveLedger();
    }
    return this.ledger;
  }

  getLedger(): DayLedger {
    this.ledger = this.loadLedger();
    return this.ledger;
  }

  recordDeployment(notional: Money): void {
    this.ledger = this.loadLedger();
    this.ledger.deployedTodayMicros = Money.fromMicros(this.ledger.deployedTodayMicros).add(notional).micros.toString();
    this.saveLedger();
  }

  /**
   * Record a closed trade's realised P/L, and update the loss streak.
   * A streak of `consecutiveMaterialLossTrigger` materially-losing trades
   * opens a cooldown.
   */
  recordRealised(pnl: Money, portfolioValueMicros: bigint): { streak: number; cooldownOpened: boolean } {
    this.ledger = this.loadLedger();
    if (this.ledger.day !== todayUtc()) this.ledger = emptyLedger(portfolioValueMicros);

    this.ledger.realisedPnlMicros = Money.fromMicros(this.ledger.realisedPnlMicros).add(pnl).micros.toString();
    this.ledger.recentRealisedPnlMicros.push(pnl.micros.toString());
    this.ledger.tradeCount += 1;
    this.saveLedger();

    // A material loss is a loss of at least `materialLossBpsOfPortfolio`
    // measured against current portfolio value. Using the portfolio rather than
    // the trade notional means the same threshold applies to a 3% trade and a
    // 20% trade, which is the point: it measures damage to the account.
    const threshold = Money.fromMicros(portfolioValueMicros)
      .bps(this.policy.risk.materialLossBpsOfPortfolio)
      .micros;
    const material = pnl.micros <= -threshold;

    if (material) {
      // Consecutive count = length of the trailing run of material losses.
      let streak = 0;
      for (let i = this.ledger.recentRealisedPnlMicros.length - 1; i >= 0; i--) {
        const v = this.ledger.recentRealisedPnlMicros[i];
        if (v === undefined) break;
        if (BigInt(v) <= -threshold) streak += 1;
        else break;
      }
      if (streak >= this.policy.risk.consecutiveMaterialLossTrigger) {
        this.cooldownUntil = new Date(Date.now() + this.policy.risk.cooldownMs).toISOString();
        writeJsonAtomic(resolve(this.paths.root, "control", "cooldown.json"), {
          until: this.cooldownUntil,
          streak,
          openedAt: nowIso(),
          reason: `${streak} consecutive material losses (threshold ${this.policy.risk.materialLossBpsOfPortfolio} bps of portfolio)`,
        });
        return { streak, cooldownOpened: true };
      }
      return { streak, cooldownOpened: false };
    }

    // A non-material result breaks the streak.
    this.ledger.recentRealisedPnlMicros = this.ledger.recentRealisedPnlMicros.slice(-50);
    this.saveLedger();
    return { streak: 0, cooldownOpened: false };
  }

  cooldownActive(): boolean {
    if (!this.cooldownUntil) {
      const p = resolve(this.paths.root, "control", "cooldown.json");
      const c = readJson<{ until: string }>(p);
      this.cooldownUntil = c?.until ?? null;
    }
    if (!this.cooldownUntil) return false;
    if (isExpired(this.cooldownUntil)) {
      this.cooldownUntil = null;
      return false;
    }
    return true;
  }

  cooldownUntilIso(): string | null {
    this.cooldownActive();
    return this.cooldownUntil;
  }

  // --- drawdown -----------------------------------------------------------

  /**
   * Current drawdown for the day, in bps, from the day's opening value.
   *
   * Mark-to-market on live portfolio value, so it captures both realised losses
   * and unrealised declines on open positions. Using mark-to-market rather than
   * realised-only is deliberate: a book that is down 8% on paper has already
   * lost the money whether or not the positions have been closed.
   *
   * Never returns a negative drawdown — a gain resets the measure to zero.
   */
  drawdownBps(currentPortfolioValueMicros: bigint): number {
    const start = BigInt(this.getLedger().startPortfolioValueMicros || "0");
    if (start <= 0n) return 0;
    if (currentPortfolioValueMicros >= start) return 0;
    return Number(((start - currentPortfolioValueMicros) * 10_000n) / start);
  }

  /** Loss budget still available today, in micro-USDC. Zero once exhausted. */
  remainingDailyLossBudgetMicros(currentPortfolioValueMicros: bigint): bigint {
    const start = BigInt(this.getLedger().startPortfolioValueMicros || "0");
    if (start <= 0n) return 0n;
    const maxLoss = (start * BigInt(this.policy.risk.maxDailyDrawdownBps)) / 10_000n;
    const currentLoss = start - currentPortfolioValueMicros;
    const remaining = maxLoss - (currentLoss > 0n ? currentLoss : 0n);
    return remaining > 0n ? remaining : 0n;
  }

  // --- combined state -----------------------------------------------------

  currentState(currentPortfolioValueMicros: bigint): ControlState {
    if (this.isKillSwitchEngaged()) return "frozen";
    if (this.isFrozen()) return "frozen";
    if (
      this.policy.risk.dailyLossResponse === "de-risk" &&
      this.drawdownBps(currentPortfolioValueMicros) >= this.policy.risk.maxDailyDrawdownBps
    ) {
      return "de-risk";
    }
    if (this.cooldownActive()) return "de-risk";
    return "normal";
  }

  /**
   * THE gate. Every signing path calls this before doing anything else.
   *
   * Returns a verdict rather than throwing, so the caller can log the full
   * reason list. Callers that proceed on `allowed === true` are responsible for
   * treating the decision as final.
   */
  authorize(
    direction: RiskDirection,
    currentPortfolioValueMicros: bigint,
  ): ControlVerdict {
    const reasons: string[] = [];
    const state = this.currentState(currentPortfolioValueMicros);

    if (this.isKillSwitchEngaged()) {
      reasons.push(
        `kill switch engaged by ${this.kill.engagedBy ?? "unknown"} at ${this.kill.engagedAt ?? "unknown"}: ${this.kill.reason ?? "no reason given"}`,
      );
      return { allowed: false, state: "frozen", reasons };
    }

    if (this.isFrozen()) {
      reasons.push(
        `circuit breaker frozen at ${this.freeze.frozenAt ?? "unknown"}: ${this.freeze.tripReason ?? "unknown"}${this.freeze.tripDetail ? ` (${this.freeze.tripDetail})` : ""}`,
      );
      reasons.push("a human must resume trading with `bpw control resume`");
      return { allowed: false, state: "frozen", reasons };
    }

    if (state === "de-risk") {
      const dd = this.drawdownBps(currentPortfolioValueMicros);
      if (dd >= this.policy.risk.maxDailyDrawdownBps) {
        reasons.push(
          `daily drawdown ${dd} bps reached the ${this.policy.risk.maxDailyDrawdownBps} bps limit; de-risk mode blocks new risk but permits exits`,
        );
      }
      if (this.cooldownActive()) {
        reasons.push(
          `loss-streak cooldown active until ${this.cooldownUntil}; new entries blocked, exits permitted`,
        );
      }
      if (direction === "increase") {
        return { allowed: false, state, reasons };
      }
    }

    return { allowed: true, state, reasons };
  }

  /** Throwing form of `authorize`, for signing paths that must not proceed. */
  authorizeOrThrow(direction: RiskDirection, currentPortfolioValueMicros: bigint): ControlState {
    const v = this.authorize(direction, currentPortfolioValueMicros);
    if (!v.allowed) {
      if (v.state === "frozen" && this.isKillSwitchEngaged()) {
        throw new KillSwitchEngaged("all", this.kill.engagedAt ?? nowIso());
      }
      throw new KillSwitchEngaged(`${v.state}/${direction}`, nowIso());
    }
    return v.state;
  }

  // --- anomaly recording -------------------------------------------------

  noteAnomaly(kind: AnomalyKind, detail: string): FreezeFile | null {
    const cb = this.policy.circuitBreaker;
    if (!cb.enabled) return null;

    const shouldTrip =
      (kind === "attestation-failure" && cb.tripOnAttestationFailure) ||
      (kind === "balance-mismatch" && cb.tripOnBalanceMismatch) ||
      (kind === "position-book-drift" && cb.tripOnPositionBookDrift) ||
      (kind === "rpc-inconsistency" && cb.tripOnRpcInconsistency) ||
      (kind === "gas-price-spike" && cb.tripOnGasPriceSpike) ||
      (kind === "policy-error" && cb.tripOnPolicyError);

    if (kind === "revert") {
      this.counters.consecutiveReverts += 1;
      if (cb.tripOnRepeatedReverts && this.counters.consecutiveReverts >= cb.maxConsecutiveReverts) {
        return this.trip(
          "repeated reverts",
          `${this.counters.consecutiveReverts} consecutive failed transactions (limit ${cb.maxConsecutiveReverts})`,
        );
      }
      return null;
    }

    if (kind === "rpc-inconsistency") {
      this.counters.rpcInconsistencyStreak += 1;
      if (this.counters.rpcInconsistencyStreak >= 2) {
        return this.trip(
          "rpc inconsistency",
          `${this.counters.rpcInconsistencyStreak} consecutive inconsistent RPC reads`,
        );
      }
      return null;
    }

    if (kind === "attestation-failure") {
      this.counters.attestationFailures += 1;
    }

    if (shouldTrip) return this.trip(kind, detail);
    return null;
  }

  noteSuccess(kind: "revert" | "rpc-inconsistency"): void {
    if (kind === "revert") this.counters.consecutiveReverts = 0;
    if (kind === "rpc-inconsistency") {
      this.counters.rpcInconsistencyStreak = 0;
      this.counters.lastRpcReadSignature = null;
    }
  }

  anomalyState(): AnomalyCounters {
    return { ...this.counters };
  }

  /** Full control-plane state for the status command and the agent gateway. */
  snapshot(currentPortfolioValueMicros: bigint): {
    state: ControlState;
    killSwitch: KillSwitchFile;
    freeze: FreezeFile;
    drawdownBps: number;
    maxDailyDrawdownBps: number;
    remainingDailyLossBudgetMicros: string;
    cooldownUntil: string | null;
    ledger: DayLedger;
    anomalies: AnomalyCounters;
  } {
    return {
      state: this.currentState(currentPortfolioValueMicros),
      killSwitch: this.killSwitchInfo(),
      freeze: this.freezeInfo(),
      drawdownBps: this.drawdownBps(currentPortfolioValueMicros),
      maxDailyDrawdownBps: this.policy.risk.maxDailyDrawdownBps,
      remainingDailyLossBudgetMicros: this.remainingDailyLossBudgetMicros(
        currentPortfolioValueMicros,
      ).toString(),
      cooldownUntil: this.cooldownUntilIso(),
      ledger: this.getLedger(),
      anomalies: this.anomalyState(),
    };
  }
}

export type AnomalyKind =
  | "attestation-failure"
  | "balance-mismatch"
  | "position-book-drift"
  | "revert"
  | "rpc-inconsistency"
  | "gas-price-spike"
  | "policy-error";

/** Convenience: engage the kill switch via the filesystem alone. */
export function emergencyStop(root: string, by: string, reason: string): KillSwitchFile {
  const paths = defaultControlPaths(root);
  mkdirSync(dirname(paths.killSwitch), { recursive: true });
  const file: KillSwitchFile = { engaged: true, engagedAt: nowIso(), engagedBy: by, reason };
  writeJsonAtomic(paths.killSwitch, file);
  return file;
}

export { newId };
