/**
 * Fixture-backed prediction-market provider.
 *
 * PAPER ONLY. Deterministic, offline, credential-free. It implements the
 * read-only `PredictionMarketProvider` interface and nothing more — there is no
 * method here that could place, cancel, redeem, transfer or sign anything,
 * because the interface does not have one.
 *
 * Time is a fixture clock, not the wall clock. `advance()` moves both the tick
 * index and the provider's own `now()`, which is what makes a run replayable and
 * what lets a resolution land on an exact tick in a test.
 */

import { assertReadOnlyProvider, type PredictionMarketProvider } from "../provider.js";
import { midpointMicros, sellProceedsMicros, spreadBps } from "../precision.js";
import type {
  MarketQuote,
  OrderBookSnapshot,
  PredictionContract,
  PredictionMarket,
  PublicTrade,
  ResolvedMarket,
} from "../types.js";
import {
  FIXTURE_EPOCH_MS,
  FIXTURE_MARKETS,
  FIXTURE_PRIMARY_OUTCOME,
  fixtureBook,
  fixtureById,
  fixtureMidPrice,
  fixturePrints,
  type FixtureMarketSpec,
} from "./fixtures.js";

export interface FixtureProviderOptions {
  /** Milliseconds of provider time per tick. Default 60s. */
  tickMs?: number;
  /** Markets to expose. Defaults to the whole fixture universe. */
  markets?: readonly FixtureMarketSpec[];
}

export const FIXTURE_PROVIDER_ID = "fixture";

export class FixturePredictionProvider implements PredictionMarketProvider {
  readonly id = FIXTURE_PROVIDER_ID;
  readonly readOnly = true as const;

  private readonly tickMs: number;
  private readonly specs: readonly FixtureMarketSpec[];
  private tickIndex = 0;

  constructor(options: FixtureProviderOptions = {}) {
    this.tickMs = options.tickMs ?? 60_000;
    this.specs = options.markets ?? FIXTURE_MARKETS;
    assertReadOnlyProvider(this);
  }

  // --- clock ---------------------------------------------------------------

  get tick(): number {
    return this.tickIndex;
  }

  /** Move the fixture clock forward one tick. Returns the new tick index. */
  advance(): number {
    this.tickIndex += 1;
    return this.tickIndex;
  }

  /** Rewind to the fixture epoch. */
  rewind(): void {
    this.tickIndex = 0;
  }

  now(): Date {
    return new Date(FIXTURE_EPOCH_MS + this.tickIndex * this.tickMs);
  }

  /** ISO timestamp the provider would stamp on its own data right now. */
  nowIso(): string {
    return this.now().toISOString();
  }

  /** Epoch milliseconds the provider would stamp on its own data. */
  nowMs(): number {
    return FIXTURE_EPOCH_MS + this.tickIndex * this.tickMs;
  }

  // --- reads ---------------------------------------------------------------

  async listMarkets(): Promise<readonly PredictionMarket[]> {
    return this.specs.map((spec) => this.buildMarket(spec));
  }

  async getMarket(marketId: string): Promise<PredictionMarket | null> {
    const spec = this.specs.find((m) => m.marketId === marketId);
    return spec ? this.buildMarket(spec) : null;
  }

  async getOrderBook(contractId: string, outcomeId: string): Promise<OrderBookSnapshot | null> {
    const spec = this.specFromContract(contractId, outcomeId);
    if (!spec || !this.isListed(spec)) return null;
    const { bids, asks } = fixtureBook(spec, this.tickIndex);
    return {
      provider: this.id,
      marketId: spec.marketId,
      contractId,
      outcomeId,
      bids,
      asks,
      dataTimestamp: this.dataTimestampIso(spec),
      sequence: this.tickIndex,
    };
  }

  async getQuote(contractId: string, outcomeId: string): Promise<MarketQuote | null> {
    const spec = this.specFromContract(contractId, outcomeId);
    if (!spec || !this.isListed(spec)) return null;
    const { bids, asks } = fixtureBook(spec, this.tickIndex);
    const bestBid = bids[0];
    const bestAsk = asks[0];
    // A one-sided book is not a quote. Returning null is how the provider says
    // "there is no bounded way in or out", which the engine refuses.
    if (!bestBid || !bestAsk) return null;

    const depthMicros = (levels: readonly { priceMicros: bigint; qtyAtomic: bigint }[]): bigint =>
      levels.reduce((acc, l) => acc + sellProceedsMicros(l.qtyAtomic, l.priceMicros), 0n);

    const timestamp = this.dataTimestampIso(spec);
    return {
      provider: this.id,
      marketId: spec.marketId,
      contractId,
      outcomeId,
      bestBid: bestBid.priceMicros,
      bestAsk: bestAsk.priceMicros,
      bestBidQty: bestBid.qtyAtomic,
      bestAskQty: bestAsk.qtyAtomic,
      mid: midpointMicros(bestBid.priceMicros, bestAsk.priceMicros),
      spreadBps: spreadBps(bestBid.priceMicros, bestAsk.priceMicros),
      bidDepthMicros: depthMicros(bids),
      askDepthMicros: depthMicros(asks),
      dataTimestamp: timestamp,
      freshnessMs: Math.max(0, this.nowMs() - Date.parse(timestamp)),
    };
  }

  async getRecentTrades(contractId: string, limit = 20): Promise<readonly PublicTrade[]> {
    const spec = this.specFromContract(contractId, FIXTURE_PRIMARY_OUTCOME);
    if (!spec || !this.isListed(spec)) return [];
    return fixturePrints(spec, this.tickIndex).slice(-limit);
  }

  async getResolution(contractId: string): Promise<ResolvedMarket | null> {
    const spec = this.specFromContract(contractId, FIXTURE_PRIMARY_OUTCOME);
    if (!spec) return null;
    const resolvedAtMs = FIXTURE_EPOCH_MS + spec.resolutionOffsetMs;
    if (this.nowMs() < resolvedAtMs) return null;
    return {
      provider: this.id,
      marketId: spec.marketId,
      contractId,
      resolvedAt: new Date(resolvedAtMs).toISOString(),
      winningOutcomeId: spec.resolutionOutcomeId,
      resolutionSource: spec.resolutionSource,
      final: true,
    };
  }

  // --- fixture-specific helpers (not part of the provider interface) -------

  /** The fixture spec behind a contract id, or null. */
  specFor(contractId: string): FixtureMarketSpec | null {
    return this.specs.find((spec) => `${spec.marketId}:${FIXTURE_PRIMARY_OUTCOME}` === contractId) ?? null;
  }

  /** True once the fixture clock has passed this market's resolution. */
  hasResolved(spec: FixtureMarketSpec): boolean {
    return this.nowMs() >= FIXTURE_EPOCH_MS + spec.resolutionOffsetMs;
  }

  /** The scenario string each fixture exists to exercise. */
  scenarioOf(marketId: string): string {
    return fixtureById(marketId).scenario;
  }

  /** Raw book levels at the current tick, for the paper fill model. */
  rawBook(contractId: string): { bids: readonly { priceMicros: bigint; qtyAtomic: bigint }[]; asks: readonly { priceMicros: bigint; qtyAtomic: bigint }[] } | null {
    const spec = this.specFromContract(contractId, FIXTURE_PRIMARY_OUTCOME);
    if (!spec || !this.isListed(spec)) return null;
    return fixtureBook(spec, this.tickIndex);
  }

  /** Prints at the current tick, for the paper fill model. */
  rawPrints(contractId: string): readonly PublicTrade[] {
    const spec = this.specFromContract(contractId, FIXTURE_PRIMARY_OUTCOME);
    if (!spec || !this.isListed(spec)) return [];
    return fixturePrints(spec, this.tickIndex);
  }

  /** Mid price at the current tick. */
  midPrice(contractId: string): bigint | null {
    const spec = this.specFromContract(contractId, FIXTURE_PRIMARY_OUTCOME);
    if (!spec || !this.isListed(spec)) return null;
    return fixtureMidPrice(spec, this.tickIndex);
  }

  // --- internals -----------------------------------------------------------

  private specFromContract(contractId: string, outcomeId: string): FixtureMarketSpec | null {
    if (outcomeId !== FIXTURE_PRIMARY_OUTCOME) return null;
    const sep = contractId.lastIndexOf(":");
    if (sep <= 0) return null;
    const marketId = contractId.slice(0, sep);
    return this.specs.find((m) => m.marketId === marketId) ?? null;
  }

  private isListed(spec: FixtureMarketSpec): boolean {
    return !(spec.closeAfterResolution && this.hasResolved(spec));
  }

  private dataTimestampIso(spec: FixtureMarketSpec): string {
    return new Date(this.nowMs() - spec.stalenessMs).toISOString();
  }

  private buildMarket(spec: FixtureMarketSpec): PredictionMarket {
    const contract: PredictionContract = {
      contractId: `${spec.marketId}:${FIXTURE_PRIMARY_OUTCOME}`,
      marketId: spec.marketId,
      question: spec.question,
      category: spec.category,
      structure: spec.structure,
      outcomes: spec.outcomes.map((o) => ({
        outcomeId: o.outcomeId,
        label: o.label,
        shortLabel: o.shortLabel,
        payoutMicros: o.payoutMicros,
        isResolvedWinner: this.hasResolved(spec) ? o.outcomeId === spec.resolutionOutcomeId : null,
      })),
      correlationGroup: spec.correlationGroup,
      resolutionTime: new Date(FIXTURE_EPOCH_MS + spec.resolutionOffsetMs).toISOString(),
      open: this.isListed(spec),
      tickRule: "continuous",
    };
    return {
      provider: this.id,
      marketId: spec.marketId,
      question: spec.question,
      category: spec.category,
      ticker: spec.ticker,
      contracts: [contract],
      volume24hMicros: spec.volume24hMicros,
      dataTimestamp: this.dataTimestampIso(spec),
    };
  }
}