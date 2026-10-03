/**
 * Paper-trading simulation accounts for the Big Pickle cockpit.
 *
 * SIMULATION / PAPER ONLY. There is no CDP client, no signer, no RPC, no
 * exchange and no chain anywhere in this module. A "fill" here is a bookkeeping
 * entry in a local file under `state/cockpit/<account>/`, and every identifier
 * it produces is prefixed `PAPER-` so a fake order can never be mistaken for a
 * real one.
 *
 * What this module deliberately reuses from the real system:
 *
 *   - `ControlPlane` (kill switch, freeze, day ledger, drawdown, loss budget)
 *   - `AuditLog` (hash-chained activity feed)
 *   - `loadPolicy` + `evaluateOrder` (the Constitution's hard limits)
 *   - `Money` bigint micro-USDC arithmetic
 *
 * Two experiment shapes are supported by this one implementation:
 *
 *   legacy / Trial 1  `kind: "sovereign" | "constitution"`, independent
 *                     starting balances, roots `state/cockpit/{sovereign,
 *                     constitution}`. Behaviour is unchanged by Trial 2.
 *   Trial 2           adds `kind: "constitution-v2"`, a capital-recycling
 *                     variant of the Constitution, plus an optional shared
 *                     candidate-symbol selector so all three accounts see the
 *                     same deterministic opportunity. Trial 2 roots live under
 *                     `state/cockpit/trial-2/` and are chosen by the caller —
 *                     this module never picks a root itself.
 *
 * Every account is fully isolated: separate control-plane roots, separate
 * audit directories, independent cash, positions and counters. No account
 * touches the real wallet or trader runtime state (`state/` at the package
 * root is the live runtime location and is never opened here).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { AuditLog } from "../audit/audit-log.js";
import { ControlPlane, defaultControlPaths } from "../control/control-plane.js";
import { nowIso } from "../core/ids.js";
import { Money } from "../core/money.js";
import {
  evaluateOrder,
  type OpenPositionView,
  type OrderFacts,
  type PortfolioFacts,
} from "../policy/engine.js";
import type { Policy } from "../policy/schema.js";
import type { Hex } from "../types.js";
import {
  MARKET_SYMBOLS,
  fmtUsdc,
  pickIndex,
  type MarketSymbol,
  type SyntheticMarket,
} from "./market.js";

export type SimAccountKind = "sovereign" | "constitution" | "constitution-v2";

/**
 * What a book is experimenting with. Derived from `kind`, never from the root,
 * so moving a root cannot change how an account is labelled or gated.
 */
export type SimAccountVariant = "control" | "constitution-v1" | "constitution-v2";

export const SIM_ACCOUNT_VARIANTS: Record<SimAccountKind, SimAccountVariant> = {
  sovereign: "control",
  constitution: "constitution-v1",
  "constitution-v2": "constitution-v2",
};

/**
 * Independent starting balances for the original two-account experiment, so
 * isolation is visible on the dashboard. Trial 2 never reads these: it passes
 * an explicit `startingBalanceUsdc` (all three Trial 2 accounts start equal).
 */
export const SIM_STARTING_BALANCES: Record<"sovereign" | "constitution", string> = {
  sovereign: "150",
  constitution: "150",
};

/** Trial 2: every one of the three accounts starts with exactly this much. */
export const TRIAL2_STARTING_BALANCE_USDC = "100000";

/** Per-kind default. Legacy defaults above are never mutated by Trial 2. */
export function defaultStartingBalanceUsdc(kind: SimAccountKind): string {
  return kind === "constitution-v2"
    ? TRIAL2_STARTING_BALANCE_USDC
    : SIM_STARTING_BALANCES[kind];
}

/**
 * The $1,500 settled-cash objective, in plain decimal USDC.
 *
 * This is an OBSERVATION THRESHOLD, not a risk input. It is deliberately kept
 * out of every sizing, limit and exit rule: neither engine reads it except at
 * the single point in `decide()` where it stops opening new positions. Reaching
 * it never loosens a limit, never resizes a position, never replenishes a
 * losing account and never counts turnover or unrealised P&L — only *free
 * settled cash* counts toward it. See `targetReached` in `decide()`.
 */
export const SIM_TARGET_CASH_USDC = "1500";

const ACCOUNT_LABELS: Record<SimAccountKind, string> = {
  sovereign: "Sovereign — direct paper execution",
  constitution: "Constitution — policy-gated paper execution",
  "constitution-v2": "Constitution V2 — capital-recycling paper execution",
};

const ACCOUNT_MODES: Record<SimAccountKind, string> = {
  sovereign: "Unilateral: control-plane gate only; the hard-limit engine is not consulted.",
  constitution: "Constitutional: every proposal runs through ControlPlane.authorize() and evaluateOrder().",
  "constitution-v2":
    "Constitutional + capital recycling: identical to V1, except the daily deployment gate measures " +
    "current open exposure (recyclable capital) instead of cumulative day-ledger deployment.",
};

/** Which accounts are gated by the Constitution's hard-limit engine. */
export function isConstitutionalKind(kind: SimAccountKind): boolean {
  return kind !== "sovereign";
}

export type DecisionVerdict =
  | "APPROVED"
  | "RESIZED"
  | "VETOED"
  | "NO_TRADE"
  | "PAPER_FILL"
  | "HOLD"
  | "PAPER_EXIT";

export interface SimDecision {
  id: string;
  at: string;
  tick: number;
  account: SimAccountKind;
  symbol: MarketSymbol | null;
  side: "buy" | "sell";
  verdict: DecisionVerdict;
  /** Requested size in bps of portfolio, when a candidate existed. */
  requestedBps: number | null;
  /** Final size in bps of portfolio. */
  finalBps: number | null;
  notionalUsdcMicros: string | null;
  notionalUsdc: string | null;
  /** Always a `PAPER-…` reference. Never a transaction hash. */
  paperRef: string | null;
  /** Deterministic rule id that decided the outcome (`none` when nothing ran). */
  rule: string;
  reasons: string[];
  execution: string;
  simulation: true;
  paper: true;
}

export interface SimPosition {
  symbol: MarketSymbol;
  asset: Hex;
  /** Token units scaled by 1e6. */
  qtyMicro: bigint;
  /** micro-USDC spent to open (sum of paper fills). */
  costBasisMicros: bigint;
  markMicros: bigint;
  openedAt: string;
  openedTick: number;
  fills: number;
}

export interface PositionView {
  symbol: string;
  asset: string;
  qty: string;
  avgEntryUsdc: string;
  markUsdc: string;
  costBasisUsdc: string;
  markValueUsdc: string;
  unrealizedPnlUsdc: string;
  unrealizedPnlBps: number;
  openedAt: string;
  heldTicks: number;
  fills: number;
}

/**
 * The settled-cash objective, as the dashboard reads it.
 *
 * `currentCashUsdc` is free settled simulation cash only. Open-position market
 * value, unrealised P&L and gross turnover are deliberately NOT part of the
 * progress figure — they are reported separately so the target cannot be met
 * by counting things that were never actually realised as cash.
 */
export interface TargetView {
  targetCashUsdc: string;
  status: "ACTIVE" | "REACHED";
  reached: boolean;
  /** Free settled cash — the only figure that counts toward the target. */
  currentCashUsdc: string;
  /** Progress toward the target, 0-100 (may exceed 100 on the reaching tick). */
  progressPct: number;
  progressBps: number;
  /** Target minus settled cash, floored at 0. */
  remainingUsdc: string;
  reachedAt: string | null;
  reachedTick: number | null;
  /** Ticks between this account's first step and now. */
  elapsedTicks: number;
  elapsedWallMs: number;
  /** Open positions still being closed by the existing exit rules at the latch. */
  openPositionsAtReach: number;
  /** Frozen record of the moment the target was met. Immutable once set. */
  final: TargetFinal | null;
  /**
   * A simulated OWNER SWEEP instruction. Preparation only: there is no
   * transfer, no signing and no venue in this process, and `executed` is
   * permanently false.
   */
  ownerSweep: OwnerSweepView | null;
}

export interface TargetFinal {
  at: string;
  tick: number;
  cashUsdc: string;
  equityUsdc: string;
  realizedPnlUsdc: string;
  unrealizedPnlUsdc: string;
  totalPnlUsdc: string;
  returnBps: number;
  drawdownBps: number;
  maxDrawdownBps: number;
  closedTrades: number;
  paperFills: number;
  grossTurnoverUsdc: string;
  elapsedTicks: number;
  elapsedWallMs: number;
  openPositionsAtReach: number;
  simulation: true;
  paper: true;
}

export interface OwnerSweepView {
  preparedAt: string;
  preparedAtTick: number;
  /** What a sweep WOULD move. Never moved by this process. */
  sweepableCashUsdc: string;
  targetCashUsdc: string;
  retainedForOpenPositionsUsdc: string;
  destination: "owner-wallet (simulated instruction only)";
  executed: false;
  live: false;
  transferPerformed: false;
  note: string;
}

export interface AccountSnapshot {
  id: SimAccountKind;
  /** Same value as `id`; spelled out so API consumers do not have to guess. */
  accountId: SimAccountKind;
  variant: SimAccountVariant;
  /** Short card heading. Falls back to `label`. */
  title: string;
  label: string;
  mode: string;
  root: string;
  simulation: true;
  paper: true;
  /** True only for the capital-recycling V2 book. */
  capitalRecycling: boolean;
  startingBalanceUsdc: string;
  cashUsdc: string;
  /** Free cash after the gas reserve — what a new entry may actually spend. */
  deployableUsdc: string;
  /** Mark value of everything currently held. */
  openExposureUsdc: string;
  equityUsdc: string;
  realizedPnlUsdc: string;
  unrealizedPnlUsdc: string;
  totalPnlUsdc: string;
  returnBps: number;
  drawdownBps: number;
  /** Peak-to-current drawdown over the whole persisted session. */
  maxDrawdownBps: number;
  maxDailyDrawdownBps: number;
  remainingDailyLossBudgetUsdc: string;
  /**
   * Gross capital cycled through the book: every entry notional plus every
   * exit proceed. Keeps rising after cash has been recycled, which is the
   * evidence that V2 is re-using capital rather than minting it.
   */
  grossTurnoverUsdc: string;
  /** Total sale proceeds returned to cash on exits. */
  recycledProceedsUsdc: string;
  /** What `dailyDeployBasisUsdc` is measured against. */
  dailyDeployBasis: "cumulative-day-ledger" | "open-exposure";
  dailyDeployBasisUsdc: string;
  wins: number;
  losses: number;
  /** gross profit ÷ gross loss. `null` when nothing has lost. */
  profitFactor: number | null;
  expectancyUsdc: string;
  avgWinnerUsdc: string;
  avgLoserUsdc: string;
  top1WinnerExcludedRealizedUsdc: string;
  top3WinnerExcludedRealizedUsdc: string;
  top5WinnerExcludedRealizedUsdc: string;
  control: {
    state: string;
    killSwitchEngaged: boolean;
    killSwitchReason: string | null;
    frozen: boolean;
    freezeReason: string | null;
    cooldownUntil: string | null;
    dailyLossResponse: string;
    tradeCountToday: number;
    deployedTodayUsdc: string;
  };
  /** A local, explicit owner override. This can only ever be active for SOVEREIGN. */
  ownerOverride: {
    active: boolean;
    at: string | null;
    by: string | null;
    reason: string | null;
  };
  experiment: {
    id: string | null;
    trial: string;
    variant: SimAccountVariant;
    accountId: SimAccountKind;
    capitalRecycling: boolean;
  };
  /** The $1,500 settled-cash objective and the account's progress toward it. */
  target: TargetView;
  positions: PositionView[];
  tradeCount: number;
  fillCount: number;
  decisions: SimDecision[];
  decisionCounts: Record<string, number>;
  activity: { at: string; action: string; actor: string; summary: string }[];
  audit: { ok: boolean; files: number; checkedAt: string };
}

// ---------------------------------------------------------------------------
// Deterministic candidate scan
// ---------------------------------------------------------------------------

export type ScanTier = "clean" | "oversized" | "weak" | "none";

export interface SimCandidate {
  tier: Exclude<ScanTier, "none">;
  symbol: MarketSymbol;
  side: "buy";
  sizeBps: number;
  distanceToInvalidationBps: number;
  expectedGrossEdgeBps: number;
  slippageBps: number;
  priceImpactBps: number;
}

/** The scan runs every third tick; the cycle is 4 phases. */
export const CANDIDATE_EVERY = 3;

/** Phase 3 of the cycle deliberately finds nothing, so NO_TRADE is reachable. */
export function scanTier(tick: number): ScanTier {
  if (tick % CANDIDATE_EVERY !== 0) return "none";
  const phase = Math.floor(tick / CANDIDATE_EVERY) % 4;
  if (phase === 3) return "none";
  if (phase === 0) return "clean";
  if (phase === 1) return "oversized";
  return "weak";
}

/** Why the scan produced no candidate for this tick. */
export function scanMissReason(tick: number): string {
  if (tick % CANDIDATE_EVERY !== 0) {
    return "deterministic scan window is every 3rd tick; no window this tick";
  }
  return "deterministic scan ran and found no setup in this cycle";
}

/**
 * The candidate a tier produces. Sizes and edges are fixed per tier, which is
 * what makes the four verdicts reproducible:
 *
 *   clean     → passes every limit at face value      → APPROVED
 *   oversized → exceeds single-trade/loss limits      → RESIZED (or VETOED)
 *   weak      → no edge after costs (size-independent)→ VETOED
 */
export function buildCandidate(tick: number, symbol: MarketSymbol): SimCandidate {
  const phase = Math.floor(tick / CANDIDATE_EVERY) % 4;
  if (phase === 1) {
    return {
      tier: "oversized",
      symbol,
      side: "buy",
      sizeBps: 4_800,
      distanceToInvalidationBps: 9_800,
      expectedGrossEdgeBps: 320,
      slippageBps: 12,
      priceImpactBps: 14,
    };
  }
  if (phase === 2) {
    return {
      tier: "weak",
      symbol,
      side: "buy",
      sizeBps: 700,
      distanceToInvalidationBps: 9_600,
      expectedGrossEdgeBps: 25,
      slippageBps: 55,
      priceImpactBps: 45,
    };
  }
  return {
    tier: "clean",
    symbol,
    side: "buy",
    sizeBps: 900,
    distanceToInvalidationBps: 9_700,
    expectedGrossEdgeBps: 300,
    slippageBps: 10,
    priceImpactBps: 12,
  };
}

// ---------------------------------------------------------------------------
// Static simulation metadata
// ---------------------------------------------------------------------------

const addr = (suffix: string): Hex => `0x${suffix.padStart(40, "0")}` as Hex;

/** Placeholder, non-contract addresses. Nothing is deployed anywhere. */
const ASSET_ADDRESS: Record<MarketSymbol, Hex> = {
  BTC: addr("b1"),
  ETH: addr("e7"),
  SOL: addr("50"),
};

/** Pairwise correlation, in bps. Drives the Constitution's concentration rule. */
const CORRELATION_BPS: Record<MarketSymbol, Record<MarketSymbol, number>> = {
  BTC: { BTC: 10_000, ETH: 8_600, SOL: 7_400 },
  ETH: { BTC: 8_600, ETH: 10_000, SOL: 8_100 },
  SOL: { BTC: 7_400, ETH: 8_100, SOL: 10_000 },
};

const TAKE_PROFIT_BPS = 300;
const STOP_LOSS_BPS = 500;
/** A paper position is always flattened after this many ticks. */
const TIME_EXIT_TICKS = 30;
/** Failure rules a smaller size can actually fix. */
const SIZE_DEPENDENT_RULES = new Set([
  "below-dust",
  "trade-too-large",
  "position-too-large",
  "exposure-too-high",
  "daily-deploy-exceeded",
  "insufficient-funds",
  "max-loss-too-large",
]);

const PAPER_PREFIX = "PAPER-SIM";

function usdc(micros: bigint): string {
  return fmtUsdc(micros);
}

function parseOptionalMicros(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  return BigInt(value);
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

interface PersistedState {
  version: 1;
  kind: SimAccountKind;
  startingBalanceMicros: string;
  cashMicros: string;
  realizedPnlMicros: string;
  tradeCount: number;
  fillCount: number;
  seq: number;
  positions: {
    symbol: MarketSymbol;
    asset: Hex;
    qtyMicro: string;
    costBasisMicros: string;
    markMicros: string;
    openedAt: string;
    openedTick: number;
    fills: number;
  }[];
  decisions: SimDecision[];
  decisionCounts: Record<string, number>;
  ownerOverrideActive?: boolean;
  ownerOverrideAt?: string | null;
  ownerOverrideReason?: string | null;
  // --- Trial 2 telemetry. Optional on read so legacy state files still load. ---
  /** Peak equity seen this session, micro-USDC. */
  peakEquityMicros?: string;
  /** Entry notionals + exit proceeds, micro-USDC. Monotonic. */
  grossTurnoverMicros?: string;
  /** Total sale proceeds returned to cash, micro-USDC. */
  recycledProceedsMicros?: string;
  /** Realised P&L of every closed round trip, oldest first, micro-USDC. */
  closedTradePnlMicros?: string[];
  // --- Settled-cash target. Optional on read so pre-target state still loads. ---
  /** Target this account was initialised with, micro-USDC. */
  targetCashMicros?: string;
  /** Sticky latch: once true, no new position may ever be opened. */
  targetReached?: boolean;
  targetReachedAt?: string | null;
  targetReachedTick?: number | null;
  targetOpenPositionsAtReach?: number;
  targetFinal?: TargetFinal | null;
  ownerSweep?: OwnerSweepView | null;
  /** Tick of this account's first step, for elapsed-ticks reporting. */
  startedTick?: number;
  startedAt?: string | null;
  savedAt: string;
}

export interface SimAccountOptions {
  kind: SimAccountKind;
  /** Isolated runtime root for this account, e.g. `state/cockpit/sovereign`. */
  root: string;
  policy: Policy;
  /** Decimal USDC string. Defaults to the per-kind starting balance. */
  startingBalanceUsdc?: string;
  /** Discard any persisted simulation state on construction. */
  fresh?: boolean;
  /** Card heading shown on the dashboard. Defaults to the kind's label. */
  title?: string;
  /** Experiment identifier recorded in the snapshot and decision telemetry. */
  experiment?: { id: string; trial: string } | null;
  /**
   * Settled-cash objective in decimal USDC. Defaults to `SIM_TARGET_CASH_USDC`
   * ($1,500). Pass `null` to run an account with no target at all.
   */
  targetCashUsdc?: string | null;
  /**
   * Deterministic candidate symbol for this tick, shared by every account in
   * the experiment. When supplied it replaces each account's own symbol
   * selection so all books see the same opportunity; the hard-limit engine is
   * still what decides whether that opportunity may be taken.
   *
   * Legacy mode leaves this undefined, which preserves the original
   * two-account symbol-selection behaviour exactly.
   */
  sharedCandidateSymbol?: (tick: number) => MarketSymbol;
}

export class SimAccount {
  readonly kind: SimAccountKind;
  readonly variant: SimAccountVariant;
  readonly label: string;
  readonly title: string;
  readonly mode: string;
  readonly root: string;
  readonly policy: Policy;
  readonly startingBalanceMicros: bigint;
  readonly statePath: string;
  readonly experiment: { id: string; trial: string } | null;
  /** True only for the capital-recycling Constitution V2 book. */
  readonly capitalRecycling: boolean;

  private control: ControlPlane;
  private readonly audit: AuditLog;
  private readonly actor: string;
  private readonly sharedCandidateSymbol: ((tick: number) => MarketSymbol) | null;

  private cashMicros = 0n;
  private realizedPnlMicros = 0n;
  private tradeCount = 0;
  private fillCount = 0;
  private seq = 0;
  private decisions: SimDecision[] = [];
  /** Lifetime verdict totals, persisted so the dashboard counts survive restarts. */
  private counts: Record<string, number> = {};
  private readonly positions = new Map<MarketSymbol, SimPosition>();
  private auditCache: { at: number; ok: boolean; files: number } | null = null;
  private ownerOverrideActive = false;
  private ownerOverrideAt: string | null = null;
  private ownerOverrideReason: string | null = null;

  // --- Trial 2 / telemetry state (all additive, never feeds a V1 decision) ---
  private peakEquityMicros = 0n;
  private grossTurnoverMicros = 0n;
  private recycledProceedsMicros = 0n;
  private closedTradePnlMicros: bigint[] = [];
  /** Refreshed once per step/snapshot so audit telemetry has current numbers. */
  private lastEquityMicros = 0n;
  private lastExposureMicros = 0n;
  private lastDeployableMicros = 0n;

  // --- Settled-cash target (observation only; never a risk input) ---
  /** The objective, micro-USDC. Read by exactly one gate in `decide()`. */
  private readonly targetCashMicros: bigint;
  /** Sticky. Once set, `decide()` refuses every new position for good. */
  private targetReached = false;
  private targetReachedAt: string | null = null;
  private targetReachedTick: number | null = null;
  private targetOpenPositionsAtReach = 0;
  private targetFinal: TargetFinal | null = null;
  private ownerSweep: OwnerSweepView | null = null;
  private startedTick = 0;
  private startedAtMs = Date.now();

  constructor(options: SimAccountOptions) {
    this.kind = options.kind;
    this.variant = SIM_ACCOUNT_VARIANTS[options.kind];
    this.capitalRecycling = options.kind === "constitution-v2";
    this.experiment = options.experiment ?? null;
    this.sharedCandidateSymbol = options.sharedCandidateSymbol ?? null;
    this.root = resolve(options.root);
    this.policy = options.policy;
    this.startingBalanceMicros = Money.parseUsdc(
      options.startingBalanceUsdc ?? defaultStartingBalanceUsdc(options.kind),
    ).micros;
    this.statePath = resolve(this.root, "sim-state.json");
    this.actor = `cockpit:${options.kind}`;
    this.label = ACCOUNT_LABELS[options.kind];
    this.title = options.title ?? this.label;
    this.mode = ACCOUNT_MODES[options.kind];
    this.targetCashMicros =
      options.targetCashUsdc === null
        ? 0n
        : Money.parseUsdc(options.targetCashUsdc ?? SIM_TARGET_CASH_USDC).micros;

    mkdirSync(this.root, { recursive: true });
    this.control = new ControlPlane(this.policy, defaultControlPaths(this.root));
    this.audit = new AuditLog(resolve(this.root, "audit"));
    this.peakEquityMicros = this.startingBalanceMicros;

    if (options.fresh) {
      this.cashMicros = this.startingBalanceMicros;
      this.control.seedDay(this.startingBalanceMicros);
    } else if (!this.loadPersisted()) {
      this.cashMicros = this.startingBalanceMicros;
      this.control.seedDay(this.startingBalanceMicros);
    }
    this.lastEquityMicros = this.startingBalanceMicros;
    this.lastDeployableMicros = this.startingBalanceMicros;
  }

  // --- persistence --------------------------------------------------------

  private loadPersisted(): boolean {
    if (!existsSync(this.statePath)) return false;
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedState;
      if (raw.version !== 1 || raw.kind !== this.kind) return false;
      // Balances are independent per account. A file saved with a different
      // starting balance means this root was reused with another configuration;
      // restart flat rather than silently importing someone else's numbers.
      if (BigInt(raw.startingBalanceMicros) !== this.startingBalanceMicros) return false;
      this.cashMicros = BigInt(raw.cashMicros);
      this.realizedPnlMicros = BigInt(raw.realizedPnlMicros);
      this.tradeCount = raw.tradeCount;
      this.fillCount = raw.fillCount;
      this.seq = raw.seq;
      this.decisions = Array.isArray(raw.decisions) ? raw.decisions.slice(0, 40) : [];
      this.counts =
        raw.decisionCounts && typeof raw.decisionCounts === "object" ? { ...raw.decisionCounts } : {};
      this.ownerOverrideActive = this.kind === "sovereign" && raw.ownerOverrideActive === true;
      this.ownerOverrideAt = this.ownerOverrideActive && typeof raw.ownerOverrideAt === "string" ? raw.ownerOverrideAt : null;
      this.ownerOverrideReason =
        this.ownerOverrideActive && typeof raw.ownerOverrideReason === "string" ? raw.ownerOverrideReason : null;
      // Trial 2 telemetry is optional: a legacy state file simply starts these
      // counters from zero instead of failing to load.
      this.peakEquityMicros = maxBigInt(
        parseOptionalMicros(raw.peakEquityMicros) ?? this.startingBalanceMicros,
        this.startingBalanceMicros,
      );
      this.grossTurnoverMicros = parseOptionalMicros(raw.grossTurnoverMicros) ?? 0n;
      this.recycledProceedsMicros = parseOptionalMicros(raw.recycledProceedsMicros) ?? 0n;
      this.closedTradePnlMicros = Array.isArray(raw.closedTradePnlMicros)
        ? raw.closedTradePnlMicros.slice(-500).map((v) => BigInt(v))
        : [];
      // Target latch is also optional on read: a pre-target state file simply
      // has no target yet. The latch is sticky once restored.
      this.targetReached = raw.targetReached === true;
      this.targetReachedAt = typeof raw.targetReachedAt === "string" ? raw.targetReachedAt : null;
      this.targetReachedTick = typeof raw.targetReachedTick === "number" ? raw.targetReachedTick : null;
      this.targetOpenPositionsAtReach =
        typeof raw.targetOpenPositionsAtReach === "number" ? raw.targetOpenPositionsAtReach : 0;
      this.targetFinal = raw.targetFinal ?? null;
      this.ownerSweep = raw.ownerSweep ?? null;
      this.startedTick = typeof raw.startedTick === "number" ? raw.startedTick : 0;
      this.startedAtMs = typeof raw.startedAt === "string" ? Date.parse(raw.startedAt) || Date.now() : Date.now();
      this.positions.clear();
      for (const p of raw.positions ?? []) {
        this.positions.set(p.symbol, {
          symbol: p.symbol,
          asset: p.asset,
          qtyMicro: BigInt(p.qtyMicro),
          costBasisMicros: BigInt(p.costBasisMicros),
          markMicros: BigInt(p.markMicros),
          openedAt: p.openedAt,
          openedTick: typeof p.openedTick === "number" ? p.openedTick : 0,
          fills: p.fills,
        });
      }
      this.control.seedDay(this.startingBalanceMicros);
      return true;
    } catch {
      // A corrupt simulation state is not a security event — restart flat.
      this.cashMicros = this.startingBalanceMicros;
      this.realizedPnlMicros = 0n;
      this.positions.clear();
      this.decisions = [];
      this.counts = {};
      this.ownerOverrideActive = false;
      this.ownerOverrideAt = null;
      this.ownerOverrideReason = null;
      this.tradeCount = 0;
      this.fillCount = 0;
      this.seq = 0;
      this.peakEquityMicros = this.startingBalanceMicros;
      this.grossTurnoverMicros = 0n;
      this.recycledProceedsMicros = 0n;
      this.closedTradePnlMicros = [];
      this.clearTarget();
      this.control.seedDay(this.startingBalanceMicros);
      return false;
    }
  }

  persist(): void {
    const payload: PersistedState = {
      version: 1,
      kind: this.kind,
      startingBalanceMicros: this.startingBalanceMicros.toString(),
      cashMicros: this.cashMicros.toString(),
      realizedPnlMicros: this.realizedPnlMicros.toString(),
      tradeCount: this.tradeCount,
      fillCount: this.fillCount,
      seq: this.seq,
      positions: [...this.positions.values()].map((p) => ({
        symbol: p.symbol,
        asset: p.asset,
        qtyMicro: p.qtyMicro.toString(),
        costBasisMicros: p.costBasisMicros.toString(),
        markMicros: p.markMicros.toString(),
        openedAt: p.openedAt,
        openedTick: p.openedTick,
        fills: p.fills,
      })),
      decisions: this.decisions,
      decisionCounts: { ...this.counts },
      ownerOverrideActive: this.ownerOverrideActive,
      ownerOverrideAt: this.ownerOverrideAt,
      ownerOverrideReason: this.ownerOverrideReason,
      peakEquityMicros: this.peakEquityMicros.toString(),
      grossTurnoverMicros: this.grossTurnoverMicros.toString(),
      recycledProceedsMicros: this.recycledProceedsMicros.toString(),
      closedTradePnlMicros: this.closedTradePnlMicros.slice(-500).map((v) => v.toString()),
      targetCashMicros: this.targetCashMicros.toString(),
      targetReached: this.targetReached,
      targetReachedAt: this.targetReachedAt,
      targetReachedTick: this.targetReachedTick,
      targetOpenPositionsAtReach: this.targetOpenPositionsAtReach,
      targetFinal: this.targetFinal,
      ownerSweep: this.ownerSweep,
      startedTick: this.startedTick,
      startedAt: new Date(this.startedAtMs).toISOString(),
      savedAt: nowIso(),
    };
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * Wipe this account's simulation book and start flat.
   *
   * The audit log is never truncated — it is append-only evidence — but the
   * control-plane files (kill/freeze/ledger/cooldown) are recreated so the demo
   * returns to a known `normal` state.
   */
  reset(): void {
    rmSync(resolve(this.root, "control"), { recursive: true, force: true });
    this.control = new ControlPlane(this.policy, defaultControlPaths(this.root));
    this.cashMicros = this.startingBalanceMicros;
    this.realizedPnlMicros = 0n;
    this.tradeCount = 0;
    this.fillCount = 0;
    this.seq = 0;
    this.decisions = [];
    this.counts = {};
    this.ownerOverrideActive = false;
    this.ownerOverrideAt = null;
    this.ownerOverrideReason = null;
    this.peakEquityMicros = this.startingBalanceMicros;
    this.grossTurnoverMicros = 0n;
    this.recycledProceedsMicros = 0n;
    this.closedTradePnlMicros = [];
    this.positions.clear();
    this.auditCache = null;
    this.clearTarget();
    this.control.seedDay(this.startingBalanceMicros);
    this.audit.append("sim.reset", "system", this.actor, {
      paper: true,
      simulation: true,
      startingBalanceUsdc: usdc(this.startingBalanceMicros),
      targetCashUsdc: usdc(this.targetCashMicros),
      note: "simulation book reset; audit history preserved",
    });
    this.persist();
  }

  // --- settled-cash target -------------------------------------------------

  /**
   * Drop the target latch and restart the clock. Used by `reset()` and by the
   * corrupt-state recovery path so a new run always begins with no target and a
   * zero elapsed tick count.
   */
  private clearTarget(): void {
    this.targetReached = false;
    this.targetReachedAt = null;
    this.targetReachedTick = null;
    this.targetOpenPositionsAtReach = 0;
    this.targetFinal = null;
    this.ownerSweep = null;
    this.startedTick = 0;
    this.startedAtMs = Date.now();
  }

  /** True when this account must not open another position, ever. */
  get isTargetLocked(): boolean {
    return this.targetReached;
  }

  private elapsedTicks(tick: number): number {
    return Math.max(0, tick - this.startedTick);
  }

  private elapsedWallMs(): number {
    return Math.max(0, Date.now() - this.startedAtMs);
  }

  /**
   * Latch the target the moment free settled cash reaches it.
   *
   * Deliberately narrow. It reads settled cash only — never equity, never
   * unrealised P&L, never turnover — and it does exactly three things: freeze a
   * final record, prepare a (never-executed) OWNER SWEEP instruction, and set
   * the sticky flag that makes `decide()` refuse new positions. It does not
   * touch sizing, limits, exits or the control plane, and it never replenishes
   * the account.
   */
  private latchTarget(market: SyntheticMarket, tick: number): void {
    if (this.targetReached) return;
    this.targetReached = true;
    this.targetReachedAt = nowIso();
    this.targetReachedTick = tick;
    this.targetOpenPositionsAtReach = this.positions.size;

    const equity = this.equityMicros(market);
    const unrealized = this.unrealizedPnlMicros(market);
    const total = this.realizedPnlMicros + unrealized;
    const control = this.control.snapshot(equity);

    this.targetFinal = {
      at: this.targetReachedAt,
      tick,
      cashUsdc: usdc(this.cashMicros),
      equityUsdc: usdc(equity),
      realizedPnlUsdc: usdc(this.realizedPnlMicros),
      unrealizedPnlUsdc: usdc(unrealized),
      totalPnlUsdc: usdc(total),
      returnBps:
        this.startingBalanceMicros > 0n
          ? Number((total * 10_000n) / this.startingBalanceMicros)
          : 0,
      drawdownBps: control.drawdownBps,
      maxDrawdownBps: this.maxDrawdownBps(equity),
      closedTrades: this.tradeCount,
      paperFills: this.fillCount,
      grossTurnoverUsdc: usdc(this.grossTurnoverMicros),
      elapsedTicks: this.elapsedTicks(tick),
      elapsedWallMs: this.elapsedWallMs(),
      openPositionsAtReach: this.targetOpenPositionsAtReach,
      simulation: true,
      paper: true,
    };

    // Open positions keep their existing exit rules; the mark value they hold is
    // deliberately excluded from the sweepable figure so a sweep can never be
    // sized against capital that is still at risk.
    let atRisk = 0n;
    for (const position of this.positions.values()) {
      atRisk += this.markMicros(position, market.price(position.symbol));
    }
    this.ownerSweep = {
      preparedAt: this.targetReachedAt,
      preparedAtTick: tick,
      sweepableCashUsdc: usdc(this.cashMicros),
      targetCashUsdc: usdc(this.targetCashMicros),
      retainedForOpenPositionsUsdc: usdc(atRisk),
      destination: "owner-wallet (simulated instruction only)",
      executed: false,
      live: false,
      transferPerformed: false,
      note:
        "SIMULATION ONLY — a prepared instruction, not a transfer. No signing, no venue, " +
        "no on-chain movement and no withdrawal capability exists in this process.",
    };

    this.audit.append("sim.target.reached", "system", this.actor, {
      tick,
      targetCashUsdc: usdc(this.targetCashMicros),
      settledCashUsdc: usdc(this.cashMicros),
      openPositionsAtReach: this.targetOpenPositionsAtReach,
      closedTrades: this.tradeCount,
      paperFills: this.fillCount,
      grossTurnoverUsdc: usdc(this.grossTurnoverMicros),
      elapsedTicks: this.elapsedTicks(tick),
      note: "settled-cash target reached; new positions are locked for the rest of the run",
      paper: true,
      simulation: true,
      live: false,
    });
    this.audit.append("sim.owner_sweep.prepared", "owner", this.actor, {
      tick,
      sweepableCashUsdc: usdc(this.cashMicros),
      targetCashUsdc: usdc(this.targetCashMicros),
      retainedForOpenPositionsUsdc: usdc(atRisk),
      executed: false,
      transferPerformed: false,
      live: false,
      note: this.ownerSweep.note,
      paper: true,
      simulation: true,
    });
    this.auditCache = null;
  }

  /** Peak-to-current drawdown over the whole session, in bps. */
  private maxDrawdownBps(equity: bigint): number {
    const peak = maxBigInt(this.peakEquityMicros, this.startingBalanceMicros);
    if (peak <= 0n) return 0;
    const below = peak - equity;
    return below > 0n ? Number((below * 10_000n) / peak) : 0;
  }

  // --- local-only control actions (file state, no trading) -----------------

  controlAction(action: "kill" | "release" | "freeze" | "resume", reason: string): void {
    const why = `${reason} [simulation cockpit, paper only]`;
    // An emergency kill/freeze always suspends the local owner override. The
    // override never outranks the existing control-plane stop controls.
    if (action === "kill" || action === "freeze") {
      this.ownerOverrideActive = false;
      this.ownerOverrideAt = null;
      this.ownerOverrideReason = null;
    }
    if (action === "kill") this.control.engageKillSwitch("owner", why);
    if (action === "release") this.control.releaseKillSwitch("owner", why);
    if (action === "freeze") this.control.trip("simulation anomaly", why);
    if (action === "resume") this.control.resume("owner", why);
    this.audit.append(`sim.control.${action}`, "owner", this.actor, {
      paper: true,
      simulation: true,
      reason: why,
    });
    this.auditCache = null;
    this.persist();
  }

  /**
   * Explicit local-owner override for the SOVEREIGN paper account only.
   *
   * This deliberately does not alter ControlPlane itself. It removes only the
   * SOVEREIGN simulation's persisted loss-streak cooldown, recreates the local
   * ControlPlane so its in-memory cooldown cache is gone, and leaves the kill
   * switch, freeze, ledger, positions, P&L and audit chain untouched. The
   * loopback-only cockpit endpoint is the manual owner boundary and the actor
   * is fixed here to `owner`, rather than accepted from the request body.
   */
  forceOwnerResume(reason: string): void {
    if (this.kind !== "sovereign") {
      throw new Error("OWNER_FORCE_RESUME is available for the SOVEREIGN account only");
    }

    const paths = defaultControlPaths(this.root);
    const kill = this.control.killSwitchInfo();
    const freeze = this.control.freezeInfo();
    if (kill.engaged || freeze.frozen) {
      throw new Error("OWNER_FORCE_RESUME cannot bypass an engaged kill switch or freeze");
    }

    const previousCooldownUntil = this.control.cooldownUntilIso();
    rmSync(resolve(this.root, "control", "cooldown.json"), { force: true });
    // ControlPlane intentionally keeps cooldown state private. Reconstructing
    // this isolated simulation instance is the narrowest way to clear its
    // in-memory cache without weakening the real control-plane implementation.
    this.control = new ControlPlane(this.policy, paths);

    const overrideReason = reason.trim().slice(0, 200) || "manual owner force resume";
    this.ownerOverrideActive = true;
    this.ownerOverrideAt = nowIso();
    this.ownerOverrideReason = overrideReason;
    this.audit.append("OWNER_OVERRIDE", "owner", this.actor, {
      override: "OWNER_FORCE_RESUME",
      account: "sovereign",
      reason: overrideReason,
      clearedCooldownUntil: previousCooldownUntil,
      paper: true,
      simulation: true,
      live: false,
    });
    this.auditCache = null;
    this.persist();
  }

  // --- valuation ----------------------------------------------------------

  private markMicros(position: SimPosition, priceMicros: bigint): bigint {
    return (position.qtyMicro * priceMicros) / 1_000_000n;
  }

  equityMicros(market: SyntheticMarket): bigint {
    let total = this.cashMicros;
    for (const [symbol, position] of this.positions) {
      total += this.markMicros(position, market.price(symbol));
    }
    return total;
  }

  unrealizedPnlMicros(market: SyntheticMarket): bigint {
    let total = 0n;
    for (const [symbol, position] of this.positions) {
      total += this.markMicros(position, market.price(symbol)) - position.costBasisMicros;
    }
    return total;
  }

  get cash(): bigint {
    return this.cashMicros;
  }

  /** Number of paper fills this account has executed. */
  get fills(): number {
    return this.fillCount;
  }

  /** Number of completed round trips (realised paper exits). */
  get closedTrades(): number {
    return this.tradeCount;
  }

  get openPositionCount(): number {
    return this.positions.size;
  }

  private portfolioFacts(
    market: SyntheticMarket,
    proposalSymbol: MarketSymbol,
  ): { facts: PortfolioFacts; equity: bigint } {
    const equity = this.equityMicros(market);
    const open: OpenPositionView[] = [];
    let exposure = 0n;
    for (const [symbol, position] of this.positions) {
      const mark = this.markMicros(position, market.price(symbol));
      exposure += mark;
      open.push({
        asset: ASSET_ADDRESS[symbol],
        symbol,
        markValueUsdcMicros: mark,
        costBasisUsdcMicros: position.costBasisMicros,
        holdsInventory: true,
        correlationToProposalBps: CORRELATION_BPS[symbol][proposalSymbol],
      });
    }
    const ethPrice = market.price("ETH");
    const reserveCost = (this.policy.capital.gasReserveWei * ethPrice) / 10n ** 18n;
    const deployable = this.cashMicros > reserveCost ? this.cashMicros - reserveCost : 0n;
    return {
      equity,
      facts: {
        totalValue: Money.fromMicros(equity),
        deployable: Money.fromMicros(deployable),
        gasReserveWei: this.policy.capital.gasReserveWei,
        currentGasPriceWei: 1_000_000_000n,
        openPositions: open,
        openExposure: Money.fromMicros(exposure),
        deployedTodayMicros: BigInt(this.control.getLedger().deployedTodayMicros),
      },
    };
  }

  // --- decision helpers ---------------------------------------------------

  private record(decision: Omit<SimDecision, "id" | "at" | "account" | "simulation" | "paper" | "execution">): SimDecision {
    this.seq += 1;
    const full: SimDecision = {
      ...decision,
      id: `SIM-DEC-${this.kind}-${String(this.seq).padStart(5, "0")}`,
      at: nowIso(),
      account: this.kind,
      execution: "paper-fill simulated locally — never submitted to any venue",
      simulation: true,
      paper: true,
    };
    this.decisions.unshift(full);
    if (this.decisions.length > 40) this.decisions = this.decisions.slice(0, 40);
    this.counts[full.verdict] = (this.counts[full.verdict] ?? 0) + 1;
    this.audit.append("sim.decision", "monitor", this.actor, {
      decisionId: full.id,
      tick: full.tick,
      verdict: full.verdict,
      symbol: full.symbol,
      side: full.side,
      requestedBps: full.requestedBps,
      finalBps: full.finalBps,
      notionalUsdc: full.notionalUsdc,
      paperRef: full.paperRef,
      rule: full.rule,
      reasons: full.reasons,
      paper: true,
      simulation: true,
    });
    this.auditCache = null;
    return full;
  }

  /** Symbols with no open position. */
  private freeSymbols(): MarketSymbol[] {
    return MARKET_SYMBOLS.filter((symbol) => !this.positions.has(symbol));
  }

  /** Free symbols that also clear the correlation limit against what is held. */
  private viableSymbols(): MarketSymbol[] {
    const held = [...this.positions.keys()];
    const limit = this.policy.concurrency.maxCorrelationBetweenOpenPositions;
    return this.freeSymbols().filter((symbol) =>
      held.every((h) => (CORRELATION_BPS[h]?.[symbol] ?? 0) <= limit),
    );
  }

  private paperRef(tick: number, seq: number): string {
    return `${PAPER_PREFIX}-${this.kind}-${tick}-${seq}`;
  }

  private applyFill(
    symbol: MarketSymbol,
    notional: bigint,
    priceMicros: bigint,
    tick: number,
    why: string,
  ): string {
    const qtyMicro = (notional * 1_000_000n) / priceMicros;
    const ref = this.paperRef(tick, this.fillCount + 1);
    const existing = this.positions.get(symbol);
    if (existing) {
      existing.qtyMicro += qtyMicro;
      existing.costBasisMicros += notional;
      existing.markMicros = this.markMicros(existing, priceMicros);
      existing.fills += 1;
    } else {
      const position: SimPosition = {
        symbol,
        asset: ASSET_ADDRESS[symbol],
        qtyMicro,
        costBasisMicros: notional,
        markMicros: (qtyMicro * priceMicros) / 1_000_000n,
        openedAt: nowIso(),
        openedTick: tick,
        fills: 1,
      };
      this.positions.set(symbol, position);
    }
    this.cashMicros -= notional;
    this.fillCount += 1;
    // Gross turnover counts entry notional. It is telemetry for the "did the
    // book actually cycle capital?" question and is never read by a limit, a
    // sizing rule or the target.
    this.grossTurnoverMicros += notional;
    this.control.recordDeployment(Money.fromMicros(notional));
    this.audit.append("sim.paper_fill", "system", this.actor, {
      paperRef: ref,
      tick,
      symbol,
      notionalUsdc: usdc(notional),
      priceUsdc: usdc(priceMicros),
      why,
      paper: true,
      simulation: true,
      live: false,
    });
    this.auditCache = null;
    return ref;
  }

  // --- exits --------------------------------------------------------------

  private runExits(market: SyntheticMarket, tick: number): SimDecision[] {
    const out: SimDecision[] = [];
    for (const [symbol, position] of [...this.positions]) {
      const price = market.price(symbol);
      const mark = this.markMicros(position, price);
      if (position.costBasisMicros <= 0n) continue;
      const change = Money.fromMicros(mark).changeBps(Money.fromMicros(position.costBasisMicros)) ?? 0;
      const heldTicks = tick - position.openedTick;
      const takeProfit = change >= TAKE_PROFIT_BPS;
      const stopOut = change <= -STOP_LOSS_BPS;
      const timedOut = heldTicks >= TIME_EXIT_TICKS;
      if (!takeProfit && !stopOut && !timedOut) continue;

      const pnl = mark - position.costBasisMicros;
      this.cashMicros += mark;
      this.realizedPnlMicros += pnl;
      this.positions.delete(symbol);
      this.tradeCount += 1;
      // Exit proceeds count toward gross turnover, and are the only capital
      // recycling this V1 book performs.
      this.grossTurnoverMicros += mark;
      this.recycledProceedsMicros += mark;
      this.closedTradePnlMicros.push(pnl);
      if (this.closedTradePnlMicros.length > 500) this.closedTradePnlMicros.shift();

      const equity = this.equityMicros(market);
      const streak = this.control.recordRealised(Money.fromMicros(pnl), equity);
      const rule = takeProfit
        ? "paper-take-profit"
        : stopOut
          ? "paper-stop-out"
          : "paper-time-exit";
      const reason = takeProfit
        ? `paper take-profit at ${change} bps (>= ${TAKE_PROFIT_BPS} bps)`
        : stopOut
          ? `paper stop-out at ${change} bps (<= -${STOP_LOSS_BPS} bps)`
          : `paper time exit after ${heldTicks} ticks (>= ${TIME_EXIT_TICKS} ticks)`;
      const ref = this.paperRef(tick, this.fillCount);
      this.audit.append("sim.paper_exit", "system", this.actor, {
        paperRef: ref,
        tick,
        symbol,
        realizedPnlUsdc: usdc(pnl),
        why: reason,
        materialLossStreak: streak.streak,
        cooldownOpened: streak.cooldownOpened,
        paper: true,
        simulation: true,
        live: false,
      });
      this.auditCache = null;
      out.push(
        this.record({
          tick,
          symbol,
          side: "sell",
          verdict: "PAPER_EXIT",
          requestedBps: null,
          finalBps: null,
          notionalUsdcMicros: mark.toString(),
          notionalUsdc: usdc(mark),
          paperRef: ref,
          rule,
          reasons: [reason, `realised P&L ${usdc(pnl)} USDC (simulated fill)`],
        }),
      );
    }
    return out;
  }

  // --- main loop ----------------------------------------------------------

  /**
   * One deterministic step for this account.
   *
   * Order: exits first (realise P&L), then the control-plane gate, then the
   * scan, then the policy evaluation for the Constitution.
   */
  step(market: SyntheticMarket, tick: number): SimDecision[] {
    // First step of this account's life fixes the elapsed-ticks origin.
    if (this.startedTick === 0 && this.seq === 0) this.startedTick = tick;
    // Roll the day ledger over at UTC midnight: seedDay is a no-op while the
    // ledger already holds today's opening value.
    this.control.seedDay(this.equityMicros(market));
    const produced = this.runExits(market, tick);
    // Track peak equity after exits, then test the settled-cash objective. Both
    // are pure observation: neither feeds a limit, a size or an exit rule.
    const equityNow = this.equityMicros(market);
    this.peakEquityMicros = maxBigInt(this.peakEquityMicros, equityNow);
    this.lastEquityMicros = equityNow;
    if (this.targetCashMicros > 0n && this.cashMicros >= this.targetCashMicros) {
      this.latchTarget(market, tick);
    }
    produced.push(...this.decide(market, tick));
    this.persist();
    return produced;
  }

  private decide(market: SyntheticMarket, tick: number): SimDecision[] {
    const equity = this.equityMicros(market);
    const gate = this.control.authorize("increase", equity);
    if (!gate.allowed) {
      return [
        this.record({
          tick,
          symbol: null,
          side: "buy",
          verdict: this.kind === "constitution" ? "VETOED" : "HOLD",
          requestedBps: null,
          finalBps: null,
          notionalUsdcMicros: null,
          notionalUsdc: null,
          paperRef: null,
          rule: `control-${gate.state}`,
          reasons: [
            ...gate.reasons,
            `control state is ${gate.state}; simulation gate blocks new risk`,
          ],
        }),
      ];
    }

    // The settled-cash target, and the ONLY place it can affect behaviour.
    // Reached is a sticky latch set in `step()`: once true this account opens no
    // further positions, so the protected cash can never be redeployed. Exits
    // are untouched — `runExits()` already ran above, so open positions still
    // close under the existing take-profit / stop-out / time-exit rules.
    if (this.targetReached) {
      return [
        this.record({
          tick,
          symbol: null,
          side: "buy",
          verdict: this.kind === "constitution" ? "VETOED" : "HOLD",
          requestedBps: null,
          finalBps: null,
          notionalUsdcMicros: null,
          notionalUsdc: null,
          paperRef: null,
          rule: "target-reached",
          reasons: [
            `settled-cash target ${usdc(this.targetCashMicros)} USDC was reached at tick ${
              this.targetReachedTick ?? tick
            }; new positions are locked and the cash is protected from redeployment`,
            "existing exit rules remain active for any position still open",
          ],
        }),
      ];
    }

    const tier = scanTier(tick);
    if (tier === "none") {      return [
        this.record({
          tick,
          symbol: null,
          side: "buy",
          verdict: "NO_TRADE",
          requestedBps: null,
          finalBps: null,
          notionalUsdcMicros: null,
          notionalUsdc: null,
          paperRef: null,
          rule: "scan-empty",
          reasons: [scanMissReason(tick)],
        }),
      ];
    }

    // Prefer a symbol that is both free and inside the correlation limit. If
    // nothing passes both, still propose a free one: the hard-limit engine then
    // vetoes it with the real reason instead of hiding the candidate.
    const free = this.freeSymbols();
    if (free.length === 0 && this.kind === "constitution") {
      return [
        this.record({
          tick,
          symbol: null,
          side: "buy",
          verdict: "NO_TRADE",
          requestedBps: null,
          finalBps: null,
          notionalUsdcMicros: null,
          notionalUsdc: null,
          paperRef: null,
          rule: "no-free-slot",
          reasons: ["every simulation slot is held; no candidate symbol remains this tick"],
        }),
      ];
    }

    let symbol: MarketSymbol;
    if (this.kind === "constitution") {
      const viable = this.viableSymbols();
      const pool = viable.length > 0 ? viable : free;
      const picked = pool[pickIndex(`scan:${tick}`, pool.length)];
      if (!picked) {
        return [
          this.record({
            tick,
            symbol: null,
            side: "buy",
            verdict: "NO_TRADE",
            requestedBps: null,
            finalBps: null,
            notionalUsdcMicros: null,
            notionalUsdc: null,
            paperRef: null,
            rule: "no-free-slot",
            reasons: ["no symbol passed the free-slot screen"],
          }),
        ];
      }
      symbol = picked;
    } else {
      // Sovereign mode is unilateral: it may add to a symbol it already holds.
      symbol = MARKET_SYMBOLS[Math.floor(tick / CANDIDATE_EVERY) % MARKET_SYMBOLS.length] ?? "BTC";
    }
    const candidate = buildCandidate(tick, symbol);
    if (candidate.tier !== tier) {
      // Defensive: scanTier and buildCandidate must agree on the phase.
      return [
        this.record({
          tick,
          symbol: null,
          side: "buy",
          verdict: "NO_TRADE",
          requestedBps: null,
          finalBps: null,
          notionalUsdcMicros: null,
          notionalUsdc: null,
          paperRef: null,
          rule: "scan-inconsistent",
          reasons: ["deterministic scan phases disagreed; refusing to act"],
        }),
      ];
    }

    return this.kind === "constitution"
      ? this.decideConstitution(market, tick, candidate, equity)
      : this.decideSovereign(market, tick, candidate, equity);
  }

  // --- Constitution: hard-limit evaluation --------------------------------

  private decideConstitution(
    market: SyntheticMarket,
    tick: number,
    candidate: SimCandidate,
    equity: bigint,
  ): SimDecision[] {
    const { facts } = this.portfolioFacts(market, candidate.symbol);
    const price = market.price(candidate.symbol);
    const requested = (equity * BigInt(candidate.sizeBps)) / 10_000n;

    const baseOrder: OrderFacts = {
      asset: ASSET_ADDRESS[candidate.symbol],
      symbol: candidate.symbol,
      side: candidate.side,
      notional: Money.fromMicros(requested),
      distanceToInvalidationBps: candidate.distanceToInvalidationBps,
      expectedGrossEdgeBps: candidate.expectedGrossEdgeBps,
      slippageBps: candidate.slippageBps,
      priceImpactBps: candidate.priceImpactBps,
      gasWei: 30_000_000_000_000n,
      gasPriceUsdcMicros: market.price("ETH"),
      liquidityUsd: 25_000_000n,
      volume24hUsd: 90_000_000n,
      topHolderConcentrationBps: 1_800,
      tokenVerified: true,
      honeypotSuspected: false,
      transferSimulationPassed: true,
    };

    const first = evaluateOrder(baseOrder, facts, this.policy);
    if (first.ok) {
      const ref = this.applyFill(candidate.symbol, baseOrder.notional.micros, price, tick, "constitution approved at face size");
      return [
        this.record({
          tick,
          symbol: candidate.symbol,
          side: "buy",
          verdict: "APPROVED",
          requestedBps: candidate.sizeBps,
          finalBps: candidate.sizeBps,
          notionalUsdcMicros: baseOrder.notional.micros.toString(),
          notionalUsdc: usdc(baseOrder.notional.micros),
          paperRef: ref,
          rule: "none",
          reasons: [
            `${candidate.tier} candidate cleared every hard limit at ${candidate.sizeBps} bps`,
            `worst-case loss ${usdc(first.maxLossUsdcMicros)} USDC inside the daily budget`,
          ],
        }),
      ];
    }

    if (!SIZE_DEPENDENT_RULES.has(first.rule)) {
      return [this.veto(tick, candidate, first.rule, first.reasons)];
    }

    // Resize: halve until it fits, or until nothing legal remains.
    let notional = baseOrder.notional.micros;
    for (let attempt = 0; attempt < 12; attempt++) {
      notional /= 2n;
      if (notional < this.policy.execution.minNotionalUsdcMicros) {
        return [
          this.veto(tick, candidate, "below-dust", [
            ...first.reasons,
            "every resize that satisfies the limits falls below the minimum notional",
          ]),
        ];
      }
      const attemptOrder: OrderFacts = { ...baseOrder, notional: Money.fromMicros(notional) };
      const verdict = evaluateOrder(attemptOrder, facts, this.policy);
      if (verdict.ok) {
        const finalBps = equity > 0n ? Number((notional * 10_000n) / equity) : 0;
        const ref = this.applyFill(candidate.symbol, notional, price, tick, "constitution approved after resize");
        return [
          this.record({
            tick,
            symbol: candidate.symbol,
            side: "buy",
            verdict: "RESIZED",
            requestedBps: candidate.sizeBps,
            finalBps,
            notionalUsdcMicros: notional.toString(),
            notionalUsdc: usdc(notional),
            paperRef: ref,
            rule: first.rule,
            reasons: [
              `requested ${candidate.sizeBps} bps rejected: ${first.reasons[0] ?? first.rule}`,
              `resized to ${finalBps} bps (${usdc(notional)} USDC) and re-evaluated clean`,
            ],
          }),
        ];
      }
      if (!SIZE_DEPENDENT_RULES.has(verdict.rule)) {
        return [this.veto(tick, candidate, verdict.rule, verdict.reasons)];
      }
    }
    return [
      this.veto(tick, candidate, first.rule, [
        ...first.reasons,
        "no halving sequence stayed inside every limit",
      ]),
    ];
  }

  private veto(
    tick: number,
    candidate: SimCandidate,
    rule: string,
    reasons: string[],
  ): SimDecision {
    return this.record({
      tick,
      symbol: candidate.symbol,
      side: "buy",
      verdict: "VETOED",
      requestedBps: candidate.sizeBps,
      finalBps: null,
      notionalUsdcMicros: null,
      notionalUsdc: null,
      paperRef: null,
      rule,
      reasons: reasons.length > 0 ? reasons : [`rule ${rule} refused the order`],
    });
  }

  // --- Sovereign: direct paper execution ----------------------------------

  private decideSovereign(
    market: SyntheticMarket,
    tick: number,
    candidate: SimCandidate,
    equity: bigint,
  ): SimDecision[] {
    const sizeBps = Math.min(candidate.sizeBps, 2_500);
    const notional = (equity * BigInt(sizeBps)) / 10_000n;
    const price = market.price(candidate.symbol);

    if (notional > this.cashMicros) {
      return [
        this.record({
          tick,
          symbol: candidate.symbol,
          side: "buy",
          verdict: "HOLD",
          requestedBps: candidate.sizeBps,
          finalBps: null,
          notionalUsdcMicros: null,
          notionalUsdc: null,
          paperRef: null,
          rule: "insufficient-simulation-cash",
          reasons: [
            `requested ${usdc(notional)} USDC but only ${usdc(this.cashMicros)} simulation cash is free`,
            "sovereign mode still refuses to spend money it does not have",
          ],
        }),
      ];
    }
    if (notional < this.policy.execution.minNotionalUsdcMicros) {
      return [
        this.record({
          tick,
          symbol: candidate.symbol,
          side: "buy",
          verdict: "HOLD",
          requestedBps: candidate.sizeBps,
          finalBps: null,
          notionalUsdcMicros: null,
          notionalUsdc: null,
          paperRef: null,
          rule: "below-dust",
          reasons: [`notional ${usdc(notional)} USDC is below the ${this.policy.profile} minimum`],
        }),
      ];
    }

    const ref = this.applyFill(candidate.symbol, notional, price, tick, "sovereign direct decision");
    return [
      this.record({
        tick,
        symbol: candidate.symbol,
        side: "buy",
        verdict: "PAPER_FILL",
        requestedBps: candidate.sizeBps,
        finalBps: sizeBps,
        notionalUsdcMicros: notional.toString(),
        notionalUsdc: usdc(notional),
        paperRef: ref,
        rule: "none",
        reasons: [
          `sovereign executed ${candidate.tier} candidate at ${sizeBps} bps without the hard-limit engine`,
          "control plane was normal; no kill switch, freeze or de-risk state",
        ],
      }),
    ];
  }

  // --- reporting ----------------------------------------------------------

  private activity(limit: number): { at: string; action: string; actor: string; summary: string }[] {
    return this.audit.tail(limit).map((entry) => {
      const detail = JSON.stringify(entry.detail);
      return {
        at: entry.at,
        action: entry.action,
        actor: entry.actor,
        summary: detail.length > 220 ? `${detail.slice(0, 217)}…` : detail,
      };
    });
  }

  private auditHealth(): { ok: boolean; files: number; checkedAt: string } {
    const now = Date.now();
    if (this.auditCache && now - this.auditCache.at < 10_000) {
      return { ok: this.auditCache.ok, files: this.auditCache.files, checkedAt: new Date(this.auditCache.at).toISOString() };
    }
    const result = this.audit.verifyAll();
    this.auditCache = { at: now, ok: result.ok, files: result.files.length };
    return { ok: result.ok, files: result.files.length, checkedAt: new Date(now).toISOString() };
  }

  snapshot(market: SyntheticMarket): AccountSnapshot {
    const equity = this.equityMicros(market);
    const unrealized = this.unrealizedPnlMicros(market);
    const total = this.realizedPnlMicros + unrealized;
    const control = this.control.snapshot(equity);
    const ledger = control.ledger;

    const positions: PositionView[] = [...this.positions.values()].map((p) => {
      const mark = this.markMicros(p, market.price(p.symbol));
      const pnl = mark - p.costBasisMicros;
      const bps =
        p.costBasisMicros > 0n ? Number((pnl * 10_000n) / p.costBasisMicros) : 0;
      return {
        symbol: p.symbol,
        asset: p.asset,
        qty: fmtUsdc(p.qtyMicro),
        avgEntryUsdc: p.qtyMicro > 0n ? usdc((p.costBasisMicros * 1_000_000n) / p.qtyMicro) : "0",
        markUsdc: usdc(market.price(p.symbol)),
        costBasisUsdc: usdc(p.costBasisMicros),
        markValueUsdc: usdc(mark),
        unrealizedPnlUsdc: usdc(pnl),
        unrealizedPnlBps: bps,
        openedAt: p.openedAt,
        heldTicks: Math.max(0, market.tick - p.openedTick),
        fills: p.fills,
      };
    });

    // Lifetime totals, not just the retained window of recent decisions.
    const decisionCounts: Record<string, number> = { ...this.counts };

    // Closed-trade statistics, derived only from already-recorded round trips.
    const closed = this.closedTradePnlMicros;
    const winsArr = closed.filter((v) => v > 0n);
    const lossesArr = closed.filter((v) => v < 0n);
    const grossProfit = winsArr.reduce((a, b) => a + b, 0n);
    const grossLoss = lossesArr.reduce((a, b) => a + b, 0n);
    const totalAbsLoss = -grossLoss;
    const profitFactor = totalAbsLoss > 0n ? Number((grossProfit * 1_000n) / totalAbsLoss) / 1000 : null;
    const avgWinner = winsArr.length > 0 ? grossProfit / BigInt(winsArr.length) : 0n;
    const avgLoser = lossesArr.length > 0 ? grossLoss / BigInt(lossesArr.length) : 0n;
    // Expectancy per closed trade, in micro-USDC.
    const expectancy = closed.length > 0 ? this.realizedPnlMicros / BigInt(closed.length) : 0n;
    const topNExcluded = (n: number): bigint => {
      const sorted = [...closed].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      const kept = sorted.slice(n);
      return kept.reduce((a, b) => a + b, 0n);
    };

    let deployable = 0n;
    let exposure = 0n;
    for (const [symbol, position] of this.positions) {
      exposure += this.markMicros(position, market.price(symbol));
    }
    {
      const ethPrice = market.price("ETH");
      const reserveCost = (this.policy.capital.gasReserveWei * ethPrice) / 10n ** 18n;
      deployable = this.cashMicros > reserveCost ? this.cashMicros - reserveCost : 0n;
      this.lastExposureMicros = exposure;
      this.lastDeployableMicros = deployable;
    }

    const target: TargetView = {
      targetCashUsdc: usdc(this.targetCashMicros),
      status: this.targetReached ? "REACHED" : "ACTIVE",
      reached: this.targetReached,
      currentCashUsdc: usdc(this.cashMicros),
      progressPct:
        this.targetCashMicros > 0n
          ? Number((this.cashMicros * 10_000n) / this.targetCashMicros) / 100
          : 0,
      progressBps:
        this.targetCashMicros > 0n ? Number((this.cashMicros * 10_000n) / this.targetCashMicros) : 0,
      remainingUsdc: usdc(
        this.targetCashMicros > this.cashMicros ? this.targetCashMicros - this.cashMicros : 0n,
      ),
      reachedAt: this.targetReachedAt,
      reachedTick: this.targetReachedTick,
      elapsedTicks: this.elapsedTicks(market.tick),
      elapsedWallMs: this.elapsedWallMs(),
      openPositionsAtReach: this.targetOpenPositionsAtReach,
      final: this.targetFinal,
      ownerSweep: this.ownerSweep,
    };

    return {
      id: this.kind,
      accountId: this.kind,
      variant: this.variant,
      title: this.title,
      label: this.label,
      mode: this.mode,
      root: relative(process.cwd(), this.root) || this.root,
      simulation: true,
      paper: true,
      capitalRecycling: this.capitalRecycling,
      startingBalanceUsdc: usdc(this.startingBalanceMicros),
      cashUsdc: usdc(this.cashMicros),
      deployableUsdc: usdc(deployable),
      openExposureUsdc: usdc(exposure),
      equityUsdc: usdc(equity),
      realizedPnlUsdc: usdc(this.realizedPnlMicros),
      unrealizedPnlUsdc: usdc(unrealized),
      totalPnlUsdc: usdc(total),
      returnBps:
        this.startingBalanceMicros > 0n
          ? Number((total * 10_000n) / this.startingBalanceMicros)
          : 0,
      drawdownBps: control.drawdownBps,
      maxDrawdownBps: this.maxDrawdownBps(equity),
      maxDailyDrawdownBps: control.maxDailyDrawdownBps,
      remainingDailyLossBudgetUsdc: usdc(BigInt(control.remainingDailyLossBudgetMicros)),
      grossTurnoverUsdc: usdc(this.grossTurnoverMicros),
      recycledProceedsUsdc: usdc(this.recycledProceedsMicros),
      dailyDeployBasis: this.capitalRecycling ? "open-exposure" : "cumulative-day-ledger",
      dailyDeployBasisUsdc: usdc(this.capitalRecycling ? exposure : equity),
      wins: winsArr.length,
      losses: lossesArr.length,
      profitFactor,
      expectancyUsdc: usdc(expectancy),
      avgWinnerUsdc: usdc(avgWinner),
      avgLoserUsdc: usdc(avgLoser),
      top1WinnerExcludedRealizedUsdc: usdc(topNExcluded(1)),
      top3WinnerExcludedRealizedUsdc: usdc(topNExcluded(3)),
      top5WinnerExcludedRealizedUsdc: usdc(topNExcluded(5)),
      control: {
        state: control.state,
        killSwitchEngaged: control.killSwitch.engaged,
        killSwitchReason: control.killSwitch.reason,
        frozen: control.freeze.frozen,
        freezeReason: control.freeze.tripReason,
        cooldownUntil: control.cooldownUntil,
        dailyLossResponse: this.policy.risk.dailyLossResponse,
        tradeCountToday: ledger.tradeCount,
        deployedTodayUsdc: usdc(BigInt(ledger.deployedTodayMicros)),
      },
      ownerOverride: {
        active: this.ownerOverrideActive,
        at: this.ownerOverrideAt,
        by: this.ownerOverrideActive ? "owner" : null,
        reason: this.ownerOverrideReason,
      },
      experiment: {
        id: this.experiment?.id ?? null,
        trial: this.experiment?.trial ?? "cockpit-simulation",
        variant: this.variant,
        accountId: this.kind,
        capitalRecycling: this.capitalRecycling,
      },
      target,
      positions,
      tradeCount: this.tradeCount,
      fillCount: this.fillCount,
      decisions: this.decisions.slice(0, 12),
      decisionCounts,
      activity: this.activity(14),
      audit: this.auditHealth(),
    };
  }
}
