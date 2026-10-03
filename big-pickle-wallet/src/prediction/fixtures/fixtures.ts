/**
 * Deterministic prediction-market fixtures.
 *
 * PAPER ONLY. These are synthetic market definitions used to exercise the whole
 * pipeline offline. There is no network, no venue, no credential and no
 * dependency on any real market data. Every value below is a pure function of a
 * tick index, so a reviewer can replay a run and get byte-identical numbers.
 *
 * The set is chosen to cover every rejection reason the engine can produce, plus
 * the four execution outcomes (full fill, partial fill, unfilled maker, settled
 * win, settled loss) and the correlated-exposure case. A gap in coverage here is
 * a gap in what the Constitution is ever tested against.
 *
 * Determinism uses a local FNV-1a rather than an import from src/cockpit. That
 * is deliberate layering, not duplication for its own sake: the cockpit is the
 * presentation layer, the prediction layer must be able to run — and be tested —
 * with no cockpit present at all.
 */

import { PRICE_SCALE, QTY_SCALE, ceilDiv, clampBigInt } from "../precision.js";
import type { OrderBookLevel, PublicTrade } from "../types.js";

/** FNV-1a, 32-bit. Stable across platforms and Node versions. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic value in [-1, 1] for a key. */
function noise(key: string): number {
  return (hash32(key) / 0xffffffff) * 2 - 1;
}

/** Cumulative drift of a market at `tick`, in basis points, bounded. */
function cumulativeDrift(spec: FixtureMarketSpec, tick: number): number {
  let sum = 0;
  for (let i = 1; i <= tick; i++) {
    const n = noise(`${spec.marketId}:drift:${i}`);
    const step = n === 0 ? 1 : Math.sign(n) * Math.max(1, Math.round(Math.abs(n) * spec.driftBpsPerTick));
    sum += step;
    if (sum > 1_200) sum = 1_200;
    else if (sum < -1_200) sum = -1_200;
  }
  return sum;
}

export interface FixtureOutcomeSpec {
  outcomeId: string;
  label: string;
  shortLabel: string;
  /** Micro-USDC paid if this outcome resolves the contract. Usually $1.00. */
  payoutMicros: bigint;
}

export interface FixtureMarketSpec {
  marketId: string;
  ticker: string;
  question: string;
  category: string;
  correlationGroup: string;
  structure: "binary" | "multi";
  outcomes: FixtureOutcomeSpec[];
  /** Mid price of the primary outcome at tick 0, micro-USDC. */
  baseYesPriceMicros: bigint;
  /** Maximum per-tick drift, basis points. */
  driftBpsPerTick: number;
  /** Half-spread, basis points of the midpoint. */
  halfSpreadBps: number;
  /** Size resting at each level, atomic contract units. */
  levelQtyAtomic: bigint;
  /** Levels per side. */
  levels: number;
  /**
   * How far a public print may stray from the midpoint, basis points.
   *
   * This is what makes maker fills honest. A maker order resting at the bid
   * fills only when a print actually trades through it. With a narrow spread and
   * a wide print drift the bid gets hit; with a wide spread and a narrow drift
   * the book can sit untouched, which is exactly what an unfilled maker order
   * is supposed to look like.
   */
  printDriftBps: number;
  printCount: number;
  /** Age the provider reports on its own data, milliseconds. */
  stalenessMs: number;
  volume24hMicros: bigint;
  /**
   * The research model's opinion of the primary outcome, in basis points.
   *
   * A synthetic model output, NOT ground truth. It is deliberately noisy and
   * frequently wrong, because the experiment is about what survives costs, not
   * about a perfect oracle.
   */
  modelProbabilityBps: number;
  /** Model confidence, 0..100. */
  modelConfidence: number;
  /** Milliseconds from the fixture epoch to resolution. */
  resolutionOffsetMs: number;
  resolutionOutcomeId: string;
  resolutionSource: string;
  /** Stops quoting after resolution. */
  closeAfterResolution: boolean;
  /** What this fixture exists to exercise. */
  scenario: string;
}

const ONE_DOLLAR = PRICE_SCALE;
const CONTRACTS = QTY_SCALE;

function yesNo(outcomeSuffix = ""): FixtureOutcomeSpec[] {
  return [
    { outcomeId: `YES${outcomeSuffix}`, label: "Yes", shortLabel: "Y", payoutMicros: ONE_DOLLAR },
    { outcomeId: `NO${outcomeSuffix}`, label: "No", shortLabel: "N", payoutMicros: ONE_DOLLAR },
  ];
}

function contracts(n: number): bigint {
  return BigInt(Math.trunc(n)) * CONTRACTS;
}

/** Depth and spread shared by the "normal" fixtures. */
const DEEP_LEVELS = 6;
const DEEP_SIZE = contracts(40);
const THIN_LEVELS = 3;
const THIN_SIZE = contracts(2);

export const FIXTURE_EPOCH_ISO = "2026-01-05T00:00:00.000Z";

export const FIXTURE_EPOCH_MS = Date.parse(FIXTURE_EPOCH_ISO);

/**
 * The fixture universe.
 *
 * Ordered so the deterministic scan walks them in a fixed order and produces the
 * same rejection counts on every run.
 */
export const FIXTURE_MARKETS: readonly FixtureMarketSpec[] = [
  {
    marketId: "FIX-EDGE-CLEAR",
    ticker: "CLEAR",
    question: "Will the sample device ship before the end of the quarter?",
    category: "tech",
    correlationGroup: "grp-device-shipping",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 620_000n,
    driftBpsPerTick: 4,
    halfSpreadBps: 60,
    levelQtyAtomic: DEEP_SIZE,
    levels: DEEP_LEVELS,
    printDriftBps: 220,
    printCount: 6,
    stalenessMs: 4_000,
    volume24hMicros: 180_000_000n,
    modelProbabilityBps: 7_400,
    modelConfidence: 82,
    resolutionOffsetMs: 40 * 60 * 60 * 1000,
    resolutionOutcomeId: "YES",
    resolutionSource: "fixture: vendor ship announcement",
    closeAfterResolution: true,
    scenario: "obvious positive-edge opportunity: deep book, tight spread, fresh data, model well above market",
  },
  {
    marketId: "FIX-EDGE-NEGATIVE",
    ticker: "NEG",
    question: "Will the central bank cut rates at the next scheduled meeting?",
    category: "macro",
    correlationGroup: "grp-central-bank",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 710_000n,
    driftBpsPerTick: 3,
    halfSpreadBps: 70,
    levelQtyAtomic: DEEP_SIZE,
    levels: DEEP_LEVELS,
    printDriftBps: 200,
    printCount: 6,
    stalenessMs: 3_000,
    volume24hMicros: 240_000_000n,
    modelProbabilityBps: 5_200,
    modelConfidence: 80,
    resolutionOffsetMs: 72 * 60 * 60 * 1000,
    resolutionOutcomeId: "NO",
    resolutionSource: "fixture: rate decision",
    closeAfterResolution: true,
    scenario: "negative-edge opportunity: the model is far BELOW the market, so buying would be a bad trade",
  },
  {
    marketId: "FIX-SPREAD-WIDE",
    ticker: "WIDE",
    question: "Will a third party win the league final?",
    category: "sports",
    correlationGroup: "grp-league-final",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 500_000n,
    driftBpsPerTick: 8,
    halfSpreadBps: 900,
    levelQtyAtomic: DEEP_SIZE,
    levels: DEEP_LEVELS,
    printDriftBps: 900,
    printCount: 4,
    stalenessMs: 5_000,
    volume24hMicros: 90_000_000n,
    modelProbabilityBps: 7_900,
    modelConfidence: 78,
    resolutionOffsetMs: 30 * 60 * 60 * 1000,
    resolutionOutcomeId: "YES",
    resolutionSource: "fixture: final result",
    closeAfterResolution: true,
    scenario: "wide-spread market: a large headline edge that the spread alone eats",
  },
  {
    marketId: "FIX-LIQUIDITY-THIN",
    ticker: "THIN",
    question: "Will the regional referendum pass?",
    category: "politics",
    correlationGroup: "grp-regional-referendum",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 480_000n,
    driftBpsPerTick: 6,
    halfSpreadBps: 120,
    levelQtyAtomic: THIN_SIZE,
    levels: THIN_LEVELS,
    printDriftBps: 200,
    printCount: 2,
    stalenessMs: 6_000,
    volume24hMicros: 4_000_000n,
    modelProbabilityBps: 8_200,
    modelConfidence: 70,
    resolutionOffsetMs: 60 * 60 * 60 * 1000,
    resolutionOutcomeId: "NO",
    resolutionSource: "fixture: referendum result",
    closeAfterResolution: true,
    scenario: "low-liquidity market: depth and volume are both below the floors",
  },
  {
    marketId: "FIX-STALE",
    ticker: "STALE",
    question: "Will the merger close on schedule?",
    category: "markets",
    correlationGroup: "grp-merger",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 660_000n,
    driftBpsPerTick: 5,
    halfSpreadBps: 80,
    levelQtyAtomic: DEEP_SIZE,
    levels: DEEP_LEVELS,
    printDriftBps: 200,
    printCount: 6,
    stalenessMs: 600_000,
    volume24hMicros: 150_000_000n,
    modelProbabilityBps: 8_100,
    modelConfidence: 84,
    resolutionOffsetMs: 90 * 60 * 60 * 1000,
    resolutionOutcomeId: "YES",
    resolutionSource: "fixture: merger completion",
    closeAfterResolution: true,
    scenario: "stale market: an attractive headline edge carried by ten-minute-old data",
  },
  {
    marketId: "FIX-NEAR-RESOLUTION",
    ticker: "SOON",
    question: "Will the count be certified before midnight?",
    category: "politics",
    correlationGroup: "grp-certification",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 580_000n,
    driftBpsPerTick: 12,
    halfSpreadBps: 90,
    levelQtyAtomic: DEEP_SIZE,
    levels: DEEP_LEVELS,
    printDriftBps: 240,
    printCount: 5,
    stalenessMs: 2_000,
    volume24hMicros: 120_000_000n,
    modelProbabilityBps: 8_600,
    modelConfidence: 86,
    resolutionOffsetMs: 4 * 60 * 1000,
    resolutionOutcomeId: "YES",
    resolutionSource: "fixture: certification",
    closeAfterResolution: true,
    scenario: "market near resolution: a large edge with no time left to earn it",
  },
  {
    marketId: "FIX-DEPTH-SHALLOW",
    ticker: "SHAL",
    question: "Will the bill clear its committee?",
    category: "politics",
    correlationGroup: "grp-committee",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 550_000n,
    driftBpsPerTick: 7,
    halfSpreadBps: 100,
    levelQtyAtomic: contracts(1),
    levels: 2,
    printDriftBps: 200,
    printCount: 3,
    stalenessMs: 3_000,
    volume24hMicros: 60_000_000n,
    modelProbabilityBps: 7_800,
    modelConfidence: 75,
    resolutionOffsetMs: 48 * 60 * 60 * 1000,
    resolutionOutcomeId: "NO",
    resolutionSource: "fixture: committee vote",
    closeAfterResolution: true,
    scenario: "partial-fill scenario: two contracts resting total, so any real order fills partially or not at all",
  },
  {
    marketId: "FIX-MAKER-UNFILLED",
    ticker: "MAKER",
    question: "Will the pilot programme be renewed for a second season?",
    category: "culture",
    correlationGroup: "grp-pilot-renewal",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 520_000n,
    driftBpsPerTick: 5,
    halfSpreadBps: 700,
    levelQtyAtomic: DEEP_SIZE,
    levels: DEEP_LEVELS,
    // Prints never stray far enough from the midpoint to reach the top of book,
    // so a passive bid rests untouched. This is what an unfilled maker order is.
    printDriftBps: 30,
    printCount: 5,
    stalenessMs: 4_000,
    volume24hMicros: 80_000_000n,
    modelProbabilityBps: 7_700,
    modelConfidence: 76,
    resolutionOffsetMs: 120 * 60 * 60 * 1000,
    resolutionOutcomeId: "YES",
    resolutionSource: "fixture: renewal decision",
    closeAfterResolution: true,
    scenario: "unfilled maker order: the quote is fine but nothing ever trades through it",
  },
  {
    marketId: "FIX-RESOLVE-YES",
    ticker: "WIN",
    question: "Will the pilot's measured effect exceed the threshold?",
    category: "science",
    correlationGroup: "grp-pilot-effect",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 600_000n,
    driftBpsPerTick: 4,
    halfSpreadBps: 80,
    levelQtyAtomic: DEEP_SIZE,
    levels: DEEP_LEVELS,
    printDriftBps: 200,
    printCount: 5,
    stalenessMs: 2_000,
    volume24hMicros: 110_000_000n,
    modelProbabilityBps: 7_600,
    modelConfidence: 81,
    resolutionOffsetMs: 6 * 60 * 60 * 1000,
    resolutionOutcomeId: "YES",
    resolutionSource: "fixture: measurement above threshold",
    closeAfterResolution: true,
    scenario: "winning resolution: the position settles at $1.00",
  },
  {
    marketId: "FIX-RESOLVE-NO",
    ticker: "LOSS",
    question: "Will the second trial site open before the funding review?",
    category: "science",
    correlationGroup: "grp-second-site",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 600_000n,
    driftBpsPerTick: 4,
    halfSpreadBps: 80,
    levelQtyAtomic: DEEP_SIZE,
    levels: DEEP_LEVELS,
    printDriftBps: 200,
    printCount: 5,
    stalenessMs: 2_000,
    volume24hMicros: 100_000_000n,
    modelProbabilityBps: 7_300,
    modelConfidence: 80,
    resolutionOffsetMs: 5 * 60 * 60 * 1000,
    resolutionOutcomeId: "NO",
    resolutionSource: "fixture: funding review closed the second site",
    closeAfterResolution: true,
    scenario: "losing resolution: the position settles at $0.00",
  },
  {
    marketId: "FIX-CORR-A",
    ticker: "CRA",
    question: "Will the northern coalition hold its majority after the recount?",
    category: "politics",
    correlationGroup: "grp-northern-coalition",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 560_000n,
    driftBpsPerTick: 6,
    halfSpreadBps: 90,
    levelQtyAtomic: DEEP_SIZE,
    levels: DEEP_LEVELS,
    printDriftBps: 220,
    printCount: 5,
    stalenessMs: 3_000,
    volume24hMicros: 130_000_000n,
    modelProbabilityBps: 7_500,
    modelConfidence: 79,
    resolutionOffsetMs: 20 * 60 * 60 * 1000,
    resolutionOutcomeId: "YES",
    resolutionSource: "fixture: recount certified",
    closeAfterResolution: true,
    scenario: "correlated exposure, leg A: the same underlying fact as FIX-CORR-B",
  },
  {
    marketId: "FIX-CORR-B",
    ticker: "CRB",
    question: "Will the coalition still control the chamber after the recount?",
    category: "politics",
    correlationGroup: "grp-northern-coalition",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 570_000n,
    driftBpsPerTick: 6,
    halfSpreadBps: 90,
    levelQtyAtomic: DEEP_SIZE,
    levels: DEEP_LEVELS,
    printDriftBps: 220,
    printCount: 5,
    stalenessMs: 3_000,
    volume24hMicros: 130_000_000n,
    modelProbabilityBps: 7_500,
    modelConfidence: 79,
    resolutionOffsetMs: 20 * 60 * 60 * 1000,
    resolutionOutcomeId: "YES",
    resolutionSource: "fixture: recount certified",
    closeAfterResolution: true,
    scenario: "correlated exposure, leg B: opens the same correlation group as FIX-CORR-A",
  },
  {
    marketId: "FIX-QUIET",
    ticker: "QUIET",
    question: "Will the archive be digitised by the end of the fiscal year?",
    category: "culture",
    correlationGroup: "grp-archive",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 500_000n,
    driftBpsPerTick: 3,
    halfSpreadBps: 70,
    levelQtyAtomic: DEEP_SIZE,
    levels: DEEP_LEVELS,
    printDriftBps: 180,
    printCount: 5,
    stalenessMs: 2_000,
    volume24hMicros: 70_000_000n,
    // The model agrees with the market. Nothing to do, which is the point.
    modelProbabilityBps: 5_050,
    modelConfidence: 88,
    resolutionOffsetMs: 200 * 60 * 60 * 1000,
    resolutionOutcomeId: "NO",
    resolutionSource: "fixture: fiscal year close",
    closeAfterResolution: true,
    scenario: "no disagreement: model and market agree, so the correct outcome is NO_TRADE",
  },
  {
    marketId: "FIX-LOW-CONFIDENCE",
    ticker: "SHY",
    question: "Will the format be adopted for the next tournament cycle?",
    category: "sports",
    correlationGroup: "grp-format-adoption",
    structure: "binary",
    outcomes: yesNo(),
    baseYesPriceMicros: 540_000n,
    driftBpsPerTick: 5,
    halfSpreadBps: 100,
    levelQtyAtomic: DEEP_SIZE,
    levels: DEEP_LEVELS,
    printDriftBps: 200,
    printCount: 4,
    stalenessMs: 3_000,
    volume24hMicros: 95_000_000n,
    modelProbabilityBps: 8_200,
    // A big disagreement asserted with almost no conviction. Must be refused.
    modelConfidence: 22,
    resolutionOffsetMs: 80 * 60 * 60 * 1000,
    resolutionOutcomeId: "NO",
    resolutionSource: "fixture: governing body decision",
    closeAfterResolution: true,
    scenario: "low confidence: a large asserted edge the estimator does not believe",
  },
  {
    marketId: "FIX-STRUCT-ODDS",
    ticker: "ODDS",
    question: "Which of four candidates reaches the runoff?",
    category: "politics",
    correlationGroup: "grp-runoff-field",
    structure: "multi",
    outcomes: [
      // A prize split, not a clean $1.00 binary. The engine refuses this rather
      // than pretending the arithmetic generalises.
      { outcomeId: "A", label: "Candidate A", shortLabel: "A", payoutMicros: 250_000n },
      { outcomeId: "B", label: "Candidate B", shortLabel: "B", payoutMicros: 250_000n },
      { outcomeId: "C", label: "Candidate C", shortLabel: "C", payoutMicros: 250_000n },
      { outcomeId: "D", label: "Neither", shortLabel: "D", payoutMicros: 250_000n },
    ],
    baseYesPriceMicros: 300_000n,
    driftBpsPerTick: 5,
    halfSpreadBps: 150,
    levelQtyAtomic: DEEP_SIZE,
    levels: DEEP_LEVELS,
    printDriftBps: 200,
    printCount: 4,
    stalenessMs: 3_000,
    volume24hMicros: 45_000_000n,
    modelProbabilityBps: 8_000,
    modelConfidence: 74,
    resolutionOffsetMs: 14 * 24 * 60 * 60 * 1000,
    resolutionOutcomeId: "A",
    resolutionSource: "fixture: runoff result",
    closeAfterResolution: true,
    scenario: "unsupported structure: a multi-outcome contract with a split payout",
  },
];

export const FIXTURE_PRIMARY_OUTCOME = "YES";

/** Mid price of the primary outcome at `tick`, micro-USDC. Pure function. */
export function fixtureMidPrice(spec: FixtureMarketSpec, tick: number): bigint {
  const factor = 10_000 + cumulativeDrift(spec, tick);
  return clampBigInt((spec.baseYesPriceMicros * BigInt(factor)) / 10_000n, 20_000n, 980_000n);
}

/** The book for the primary outcome at `tick`. Bids best-first, asks best-first. */
export function fixtureBook(spec: FixtureMarketSpec, tick: number): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } {
  const mid = fixtureMidPrice(spec, tick);
  const half = ceilDiv((mid * BigInt(spec.halfSpreadBps)) / 10_000n, 1n);
  const bidTop = clampBigInt(mid - half, 5_000n, PRICE_SCALE - 1n);
  const askTop = clampBigInt(mid + half, bidTop + 1_000n, PRICE_SCALE - 1n);

  const step = Math.max(1, spec.halfSpreadBps);
  const bids: OrderBookLevel[] = [];
  const asks: OrderBookLevel[] = [];
  for (let level = 0; level < spec.levels; level++) {
    const bidPrice = clampBigInt(bidTop - BigInt(level * step) * BigInt(mid / 10_000n), 3_000n, PRICE_SCALE - 1n);
    const askPrice = clampBigInt(askTop + BigInt(level * step) * BigInt(mid / 10_000n), bidPrice + 1_000n, PRICE_SCALE - 1n);
    // Size decays with depth, as it does on a real book.
    const decay = BigInt(10_000 - level * 900);
    const qty = (spec.levelQtyAtomic * decay) / 10_000n;
    if (qty > 0n) bids.push({ priceMicros: bidPrice, qtyAtomic: qty });
    if (qty > 0n) asks.push({ priceMicros: askPrice, qtyAtomic: qty });
  }
  if (bids.length === 0) bids.push({ priceMicros: bidTop, qtyAtomic: spec.levelQtyAtomic });
  if (asks.length === 0) asks.push({ priceMicros: askTop, qtyAtomic: spec.levelQtyAtomic });
  return { bids, asks };
}

/**
 * Public prints for the primary outcome, oldest first.
 *
 * Each print is deterministically displaced from the midpoint by at most
 * `printDriftBps`. That bound is the mechanism behind the maker-fill model: a
 * print only reaches a resting bid when the displacement exceeds the
 * half-spread, so a wide-quote market leaves passive orders untouched.
 */
export function fixturePrints(spec: FixtureMarketSpec, tick: number): PublicTrade[] {
  const mid = fixtureMidPrice(spec, tick);
  const prints: PublicTrade[] = [];
  for (let i = 0; i < spec.printCount; i++) {
    const n = noise(`${spec.marketId}:print:${tick}:${i}`);
    const displacementBps = Math.round(n * spec.printDriftBps);
    const price = clampBigInt(
      mid + (mid * BigInt(displacementBps)) / 10_000n,
      2_000n,
      PRICE_SCALE - 2_000n,
    );
    const qty = (spec.levelQtyAtomic * BigInt(200 + (hash32(`${spec.marketId}:qty:${tick}:${i}`) % 900))) / 10_000n;
    prints.push({
      provider: "fixture",
      contractId: `${spec.marketId}:${FIXTURE_PRIMARY_OUTCOME}`,
      outcomeId: FIXTURE_PRIMARY_OUTCOME,
      priceMicros: price,
      qtyAtomic: qty > 0n ? qty : 1n,
      side: n >= 0 ? "buy" : "sell",
      at: new Date(FIXTURE_EPOCH_MS + tick * 60_000 + i * 1_000).toISOString(),
    });
  }
  return prints;
}

/** Look a fixture up by market id. Throws rather than returning undefined. */
export function fixtureById(marketId: string): FixtureMarketSpec {
  const found = FIXTURE_MARKETS.find((m) => m.marketId === marketId);
  if (!found) throw new Error(`unknown fixture market ${JSON.stringify(marketId)}`);
  return found;
}