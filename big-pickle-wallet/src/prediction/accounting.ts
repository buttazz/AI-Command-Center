/**
 * Paper accounting for prediction contracts.
 *
 * PAPER ONLY. This is a ledger, not a broker. It holds no credential, signs
 * nothing, talks to nothing, and its only client is the simulator that drives it.
 *
 * The invariants, stated because everything else depends on them:
 *
 *   equity  = cash + reserved + Σ(position mark value)
 *
 * and, for every fill, cash falls by exactly notional + fee while reserved falls
 * by the same amount, so `reserved` is always a subset of `cash` and
 * `available = cash − reserved` can never go negative. A settlement pays out and
 * removes the position in the same step, so realised P&L is always
 * `payout − costBasis` with fees already inside the cost basis. Nothing in this
 * file ever rounds in its own favour: cash moves in whole micro-USDC, and any
 * quantity that cannot be represented exactly is refused rather than approximated.
 *
 * Mark-to-market is supplied from outside. The ledger has no price feed, so it
 * cannot mark a position the simulator has not quoted — and an unmarkable
 * position falls back to cost basis, which is the pessimistic direction.
 */

import { BPS_DENOM } from "./precision.js";
import { syntheticContractAddress } from "./constitution.js";
import type { OpenPositionView } from "../policy/engine.js";
import type {
  PaperFill,
  PaperPosition,
  PredictionMarket,
  ResolvedPosition,
} from "./types.js";

/** Default bankroll for the survival experiment: $50.00. */
export const SURVIVAL_STARTING_CASH_MICROS = 50_000_000n;

export interface PaperBankOptions {
  startingCashMicros?: bigint;
  nowIso: string;
}

export interface PaperBankStats {
  equityMicros: bigint;
  cashMicros: bigint;
  reservedMicros: bigint;
  availableMicros: bigint;
  openExposureMicros: bigint;
  peakEquityMicros: bigint;
  drawdownBps: number;
  dayLossBps: number;
  realizedPnlMicros: bigint;
  unrealizedPnlMicros: bigint;
  feesPaidMicros: bigint;
  turnoverMicros: bigint;
  openPositions: number;
  resolvedPositions: number;
  wins: number;
  losses: number;
  winRateBps: number;
  settledCashMicros: bigint;
  bankrollMicros: bigint;
  survivalBps: number;
}

export class PaperBank {
  /** Free cash, micro-USDC. Never negative. */
  private cash: bigint;
  /** Cash committed to resting or pending paper orders. */
  private reserved = 0n;
  /** Cost basis the run started with. */
  readonly startingCashMicros: bigint;

  private readonly open = new Map<string, PaperPosition>();
  private readonly closed: ResolvedPosition[] = [];
  private readonly fillLog: PaperFill[] = [];

  private peakEquity: bigint;
  private dayStartEquity: bigint;
  private realized = 0n;
  private unrealized = 0n;
  private fees = 0n;
  private turnover = 0n;
  private settledCash = 0n;

  constructor(options: PaperBankOptions) {
    this.startingCashMicros = options.startingCashMicros ?? SURVIVAL_STARTING_CASH_MICROS;
    this.cash = this.startingCashMicros;
    this.peakEquity = this.startingCashMicros;
    this.dayStartEquity = this.startingCashMicros;
  }

  // --- reads ---------------------------------------------------------------

  get cashMicros(): bigint {
    return this.cash;
  }

  get reservedMicros(): bigint {
    return this.reserved;
  }

  /** Cash not committed to any open order. This is what a new order may spend. */
  get availableMicros(): bigint {
    return this.cash - this.reserved;
  }

  get realizedPnlMicros(): bigint {
    return this.realized;
  }

  get feesPaidMicros(): bigint {
    return this.fees;
  }

  positions(): readonly PaperPosition[] {
    return [...this.open.values()];
  }

  resolvedPositions(): readonly ResolvedPosition[] {
    return [...this.closed];
  }

  fills(): readonly PaperFill[] {
    return [...this.fillLog];
  }

  position(contractId: string): PaperPosition | undefined {
    return this.open.get(contractId);
  }

  /** Mark value of one position, or null when it is not open. */
  markValueMicros(contractId: string): bigint | null {
    const p = this.open.get(contractId);
    return p ? (p.qtyAtomic * p.markPriceMicros) / 1_000_000n : null;
  }

  /**
   * Equity at the given marks.
   *
   * Falls back to cost basis for any position with no mark, which understates
   * rather than overstates a loss. A ledger that guessed a price to flatter
   * itself would be worse than one that admits it does not know.
   */
  equityMicros(marks: ReadonlyMap<string, bigint> = new Map()): bigint {
    let total = this.cash + this.reserved;
    for (const p of this.open.values()) {
      const mark = marks.get(p.contractId);
      total += (p.qtyAtomic * (mark ?? p.markPriceMicros)) / 1_000_000n;
    }
    return total;
  }

  /** Open exposure at cost, micro-USDC. What the risk limits are measured against. */
  openExposureMicros(): bigint {
    let total = 0n;
    for (const p of this.open.values()) total += p.costBasisMicros;
    return total;
  }

  categoryExposureMicros(category: string): bigint {
    let total = 0n;
    for (const p of this.open.values()) if (p.category === category) total += p.costBasisMicros;
    return total;
  }

  correlationGroupExposureMicros(group: string): bigint {
    let total = 0n;
    for (const p of this.open.values()) if (p.correlationGroup === group) total += p.costBasisMicros;
    return total;
  }

  /** Drawdown from peak equity, bps. Zero at a new high. */
  drawdownBps(marks?: ReadonlyMap<string, bigint>): number {
    const equity = this.equityMicros(marks);
    if (equity > this.peakEquity) this.peakEquity = equity;
    if (this.peakEquity <= 0n) return 10_000;
    const dd = ((this.peakEquity - equity) * BPS_DENOM) / this.peakEquity;
    return dd < 0n ? 0 : Number(dd);
  }

  /** Day-to-date loss against the day-start equity, bps. Zero or positive. */
  dayLossBps(marks?: ReadonlyMap<string, bigint>): number {
    const equity = this.equityMicros(marks);
    if (equity >= this.dayStartEquity) return 0;
    return Number(((this.dayStartEquity - equity) * BPS_DENOM) / this.dayStartEquity);
  }

  /** Total realised P&L plus current unrealised P&L, micro-USDC. */
  totalPnlMicros(marks?: ReadonlyMap<string, bigint>): bigint {
    let unrealized = 0n;
    for (const p of this.open.values()) {
      const mark = marks?.get(p.contractId) ?? p.markPriceMicros;
      unrealized += (p.qtyAtomic * mark) / 1_000_000n - p.costBasisMicros;
    }
    this.unrealized = unrealized;
    return this.realized + unrealized;
  }

  stats(marks?: ReadonlyMap<string, bigint>): PaperBankStats {
    const equity = this.equityMicros(marks);
    if (equity > this.peakEquity) this.peakEquity = equity;
    let unrealized = 0n;
    for (const p of this.open.values()) {
      const mark = marks?.get(p.contractId) ?? p.markPriceMicros;
      unrealized += (p.qtyAtomic * mark) / 1_000_000n - p.costBasisMicros;
    }
    this.unrealized = unrealized;

    const wins = this.closed.filter((c) => c.won).length;
    const losses = this.closed.length - wins;

    return {
      equityMicros: equity,
      cashMicros: this.cash,
      reservedMicros: this.reserved,
      availableMicros: this.cash - this.reserved,
      openExposureMicros: this.openExposureMicros(),
      peakEquityMicros: this.peakEquity,
      drawdownBps: this.peakEquity <= 0n ? 10_000 : Number(((this.peakEquity - equity) * BPS_DENOM) / this.peakEquity),
      dayLossBps: this.dayLossBps(marks),
      realizedPnlMicros: this.realized,
      unrealizedPnlMicros: unrealized,
      feesPaidMicros: this.fees,
      turnoverMicros: this.turnover,
      openPositions: this.open.size,
      resolvedPositions: this.closed.length,
      wins,
      losses,
      winRateBps: this.closed.length > 0 ? Math.round((wins / this.closed.length) * Number(BPS_DENOM)) : 0,
      settledCashMicros: this.settledCash,
      bankrollMicros: this.startingCashMicros,
      survivalBps:
        this.startingCashMicros > 0n
          ? Number((equity * BPS_DENOM) / this.startingCashMicros)
          : 0,
    };
  }

  /**
   * Adapt to the policy engine's `PortfolioFacts.openPositions`.
   *
   * `holdsInventory` is true for every open position, which is what makes the
   * engine's existing `forbidAveragingDown` rule apply: a second order in a
   * contract already held is refused. That rule was written for tokens and it is
   * correct here for the same reason — adding to a position you are already
   * wrong about is not research, it is hope with extra steps.
   */
  toOpenPositionViews(marks: ReadonlyMap<string, bigint> = new Map()): OpenPositionView[] {
    return this.positions().map((p) => ({
      asset: syntheticContractAddress(p.contractId),
      symbol: `${p.marketId}/${p.outcomeId}`,
      markValueUsdcMicros: (p.qtyAtomic * (marks.get(p.contractId) ?? p.markPriceMicros)) / 1_000_000n,
      costBasisUsdcMicros: p.costBasisMicros,
      holdsInventory: true,
    }));
  }

  // --- writes --------------------------------------------------------------

  /** Commit cash to a resting order. Throws if it would overcommit. */
  reserve(amountMicros: bigint): void {
    if (amountMicros < 0n) throw new RangeError(`cannot reserve a negative amount: ${amountMicros}`);
    if (this.availableMicros < amountMicros) {
      throw new RangeError(
        `cannot reserve ${amountMicros} micro-USDC with only ${this.availableMicros} available`,
      );
    }
    this.reserved += amountMicros;
  }

  /** Release committed cash that was never spent. */
  release(amountMicros: bigint): void {
    if (amountMicros <= 0n) return;
    const release = amountMicros > this.reserved ? this.reserved : amountMicros;
    this.reserved -= release;
  }

  /**
   * Apply a fill: move committed cash into a position.
   *
   * `spendMicros` must equal `fill.notionalMicros + fill.feeMicros`. The ledger
   * spends what it is told and records what it was told, so a caller cannot quietly
   * under-charge a fee — the totals below will simply not add up, which is
   * visible in `stats()`.
   */
  applyFill(fill: PaperFill, meta: { market: PredictionMarket; correlationGroup: string; question: string; category: string }): PaperPosition {
    const spend = fill.notionalMicros + fill.feeMicros;
    if (spend > this.reserved) {
      throw new RangeError(`fill costs ${spend} but only ${this.reserved} is reserved`);
    }
    this.reserved -= spend;
    this.cash -= spend;
    this.fees += fill.feeMicros;
    this.turnover += fill.notionalMicros;
    this.fillLog.push(fill);

    const existing = this.open.get(fill.contractId);
    if (existing) {
      existing.qtyAtomic += fill.qtyAtomic;
      existing.costBasisMicros += spend;
      existing.principalMicros += fill.notionalMicros;
      existing.markPriceMicros = fill.priceMicros;
      existing.fills += 1;
      return existing;
    }

    const position: PaperPosition = {
      provider: fill.provider,
      marketId: meta.market.marketId,
      contractId: fill.contractId,
      outcomeId: fill.outcomeId,
      question: meta.question,
      category: meta.category,
      correlationGroup: meta.correlationGroup,
      outcomeLabel: fill.outcomeId,
      qtyAtomic: fill.qtyAtomic,
      costBasisMicros: spend,
      principalMicros: fill.notionalMicros,
      markPriceMicros: fill.priceMicros,
      openedAt: fill.at,
      openedTick: fill.tick,
      fills: 1,
      resolved: false,
      winning: null,
    };
    this.open.set(fill.contractId, position);
    return position;
  }

  /**
   * Settle an open position against a resolution.
   *
   * Pays `qtyAtomic` contracts worth $1.00 each if the held outcome won, nothing
   * if it did not, and books the difference as realised P&L. Fees stay inside the
   * cost basis, so a winning trade that cost 1% in fees reports that.
   *
   * Settling a position that is not open is a no-op rather than an error: the
   * simulator may observe a resolution for a contract it never traded, and that
   * is not a fault.
   */
  settle(input: {
    contractId: string;
    winningOutcomeId: string;
    at: string;
    tick: number;
    heldQtyAtomic: bigint;
  }): ResolvedPosition | null {
    const position = this.open.get(input.contractId);
    if (!position) return null;

    const won = input.winningOutcomeId === position.outcomeId;
    const payout = won ? (position.qtyAtomic * 1_000_000n) / 1_000_000n : 0n;
    this.cash += payout;
    if (won) this.settledCash += payout;

    const pnl = payout - position.costBasisMicros;
    this.realized += pnl;

    const closed: ResolvedPosition = {
      provider: position.provider,
      marketId: position.marketId,
      contractId: position.contractId,
      outcomeId: position.outcomeId,
      question: position.question,
      category: position.category,
      correlationGroup: position.correlationGroup,
      outcomeLabel: position.outcomeLabel,
      qtyAtomic: position.qtyAtomic,
      realizedPnlMicros: pnl,
      feesMicros: position.costBasisMicros - position.principalMicros,
      won,
      openedAt: position.openedAt,
      closedAt: input.at,
      heldMs: Math.max(0, Date.parse(input.at) - Date.parse(position.openedAt)),
      tick: input.tick,
    };

    this.open.delete(input.contractId);
    this.closed.push(closed);
    return closed;
  }

  /** Mark every open position to a price. Positions without a mark keep the old one. */
  markAll(marks: ReadonlyMap<string, bigint>): void {
    for (const [contractId, price] of marks) {
      const p = this.open.get(contractId);
      if (p) p.markPriceMicros = price;
    }
  }

  /** Mark a single position, e.g. at the instant its contract resolves. */
  markPosition(contractId: string, priceMicros: bigint): void {
    const p = this.open.get(contractId);
    if (p) p.markPriceMicros = priceMicros;
  }

  /** Reset the day-start equity baseline. Used when the experiment rolls a day. */
  markDayStart(): void {
    this.dayStartEquity = this.equityMicros();
  }
}