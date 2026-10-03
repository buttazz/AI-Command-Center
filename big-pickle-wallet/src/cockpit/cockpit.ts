/**
 * The simulation cockpit: one deterministic market, two isolated accounts.
 *
 * SIMULATION / PAPER TRADING ONLY — no live funds, no exchange, no chain, no
 * RPC, no CDP credentials. See `src/cockpit/README` banner in server.ts.
 *
 * Isolation contract:
 *   state/cockpit/sovereign/     ControlPlane + audit + book  (independent)
 *   state/cockpit/constitution/  ControlPlane + audit + book  (independent)
 *
 * The two accounts share only the synthetic price feed. Cash, positions,
 * day ledgers, kill switches, freezes, cooldowns and audit chains are separate.
 */

import { resolve } from "node:path";

import { loadPolicy, type Policy } from "../policy/schema.js";
import { SimAccount, SIM_STARTING_BALANCES, SIM_TARGET_CASH_USDC, type SimAccountKind } from "./account.js";
import { SyntheticMarket, type MarketQuote } from "./market.js";

/** Simulation roots, relative to the wallet working directory. */
export const COCKPIT_STATE_BASE = "state/cockpit";

export interface CockpitRoots {
  sovereign: string;
  constitution: string;
}

/** Both simulation roots for a given *working directory*. */
export function cockpitRoots(baseDir: string = process.cwd()): CockpitRoots {
  return rootsForBase(resolve(baseDir, COCKPIT_STATE_BASE));
}

/** Both simulation roots for a given cockpit base directory. */
export function rootsForBase(base: string): CockpitRoots {
  return {
    sovereign: resolve(base, "sovereign"),
    constitution: resolve(base, "constitution"),
  };
}

export interface CockpitOptions {
  /** Policy file. Defaults to the aggressive profile shipped with the wallet. */
  policyPath?: string;
  /** Directory that holds both simulation roots. Defaults to cwd/state/cockpit. */
  stateBaseDir?: string;
  /** Refresh period for the auto loop. */
  intervalMs?: number;
  /**
   * Settled-cash objective handed to both accounts, decimal USDC. Defaults to
   * `SIM_TARGET_CASH_USDC` ($1,500). Pass `null` for an untargeted run.
   */
  targetCashUsdc?: string | null;
  /** Experiment label surfaced in each account snapshot. */
  experiment?: { id: string; trial: string } | null;
}

export interface CockpitState {
  simulation: true;
  paper: true;
  liveFunds: false;
  mode: string;
  disclaimer: string;
  startedAt: string;
  serverTime: string;
  tick: number;
  intervalMs: number;
  policy: {
    profile: string;
    sourcePath: string;
    maxDailyDrawdownBps: number;
    maxSingleTradeBps: number;
    maxOpenExposureBps: number;
    dailyLossResponse: string;
  };
  market: { tick: number; quotes: MarketQuoteView[] };
  accounts: ReturnType<SimAccount["snapshot"]>[];
}

interface MarketQuoteView {
  symbol: string;
  priceUsdc: string;
  changeBps: number;
  priceMicros: string;
}

export const DISCLAIMER =
  "SIMULATION / PAPER TRADING ONLY — synthetic prices, fake paper fills, no live funds, " +
  "no exchange, no blockchain, no CDP credentials. Nothing in this cockpit can move money.";

export class Cockpit {
  readonly policy: Policy;
  readonly market: SyntheticMarket;
  readonly sovereign: SimAccount;
  readonly constitution: SimAccount;
  readonly startedAt: string;
  readonly roots: CockpitRoots;
  readonly intervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;
  private stepCount = 0;

  constructor(options: CockpitOptions = {}) {
    const policyPath =
      options.policyPath ?? resolve(process.cwd(), "config/policy.aggressive.json");
    this.policy = loadPolicy(policyPath);
    const base = options.stateBaseDir ?? resolve(process.cwd(), COCKPIT_STATE_BASE);
    this.roots = rootsForBase(base);
    this.intervalMs = options.intervalMs ?? 1_500;
    this.market = new SyntheticMarket();
    // The $1,500 settled-cash objective is passed identically to both books, so
    // the race is head-to-head on equal capital with equal opportunity. It is an
    // observation threshold only: no sizing, limit or exit rule reads it.
    this.sovereign = new SimAccount({
      kind: "sovereign",
      root: this.roots.sovereign,
      policy: this.policy,
      startingBalanceUsdc: SIM_STARTING_BALANCES.sovereign,
      targetCashUsdc: options.targetCashUsdc ?? SIM_TARGET_CASH_USDC,
      experiment: options.experiment ?? null,
    });
    this.constitution = new SimAccount({
      kind: "constitution",
      root: this.roots.constitution,
      policy: this.policy,
      startingBalanceUsdc: SIM_STARTING_BALANCES.constitution,
      targetCashUsdc: options.targetCashUsdc ?? SIM_TARGET_CASH_USDC,
      experiment: options.experiment ?? null,
    });
    this.startedAt = new Date().toISOString();
  }

  accounts(): SimAccount[] {
    return [this.sovereign, this.constitution];
  }

  account(kind: SimAccountKind): SimAccount {
    return kind === "sovereign" ? this.sovereign : this.constitution;
  }

  /** Advance the shared market by one tick, then step both accounts. */
  step(): number {
    const tick = this.market.step();
    for (const account of this.accounts()) account.step(this.market, tick);
    this.stepCount += 1;
    return tick;
  }

  /** Reset both books and the market. Audit history is preserved. */
  reset(): void {
    this.market.reset();
    for (const account of this.accounts()) account.reset();
  }

  state(): CockpitState {
    const quotes: MarketQuoteView[] = this.market.quotes().map((q: MarketQuote) => ({
      symbol: q.symbol,
      priceUsdc: q.priceUsdc,
      changeBps: q.changeBps,
      priceMicros: q.priceMicros.toString(),
    }));
    return {
      simulation: true,
      paper: true,
      liveFunds: false,
      mode: "PAPER TRADING",
      disclaimer: DISCLAIMER,
      startedAt: this.startedAt,
      serverTime: new Date().toISOString(),
      tick: this.market.tick,
      intervalMs: this.intervalMs,
      policy: {
        profile: this.policy.profile,
        sourcePath: this.policy.sourcePath,
        maxDailyDrawdownBps: this.policy.risk.maxDailyDrawdownBps,
        maxSingleTradeBps: this.policy.risk.maxSingleTradeBps,
        maxOpenExposureBps: this.policy.risk.maxOpenExposureBps,
        dailyLossResponse: this.policy.risk.dailyLossResponse,
      },
      market: { tick: this.market.tick, quotes },
      accounts: this.accounts().map((a) => a.snapshot(this.market)),
    };
  }

  start(intervalMs = this.intervalMs): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.step();
      } catch {
        // A simulation tick must never take the HTTP server down. The error is
        // surfaced on the next snapshot through the audit/decision feed.
        this.stepCount += 1;
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get steps(): number {
    return this.stepCount;
  }
}
