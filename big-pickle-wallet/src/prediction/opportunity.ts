/**
 * Opportunity construction and the research-stage refusal layer.
 *
 * Everything here is deterministic given its inputs. The only non-deterministic
 * input in the research stage is the `ProbabilityEstimate` produced upstream,
 * and that is a value rather than a code path — the same estimate always yields
 * the same edge, the same size and the same verdict.
 *
 * Two jobs:
 *
 *   1. Turn a quote plus an estimate into a full cost decomposition, so a
 *      decision rests on `netExpectedEdgeBps` rather than on a raw probability
 *      disagreement.
 *   2. Refuse anything that should never become a proposal, *before* it reaches
 *      the Constitution.
 *
 * That ordering is deliberate. This layer owns research quality — is there an
 * edge, is it big enough, is there any size worth taking. The policy engine owns
 * limits. Duplicating the limits here would mean two places to change them and a
 * guarantee that they would eventually disagree, so liquidity floors, spread
 * caps, freshness, exposure, correlation, daily loss and drawdown are all left
 * to `evaluateOrder` with `instrument: "prediction-contract"`. This file only
 * refuses what the engine has no way to see.
 *
 * On sizing: fractional Kelly, scaled down, then scaled again by confidence.
 * Kelly is the right answer to "how much" given a probability, but it assumes the
 * probability is right, which no estimate here is. `policy.prediction.kellyFractionBps`
 * is 2500 — a quarter — and the confidence multiplier shrinks it further for a
 * view the estimator does not trust. Full Kelly on a 62%-accurate estimate is how
 * a $50 bankroll becomes $0.
 */

import type { Policy } from "../policy/schema.js";
import type { ControlVerdict } from "../control/control-plane.js";
import {
  BPS_DENOM,
  PRICE_SCALE,
  QTY_SCALE,
  buyCostMicros,
  clampBigInt,
  feeMicros,
  floorDiv,
  impliedProbabilityBps,
  priceFromProbabilityBps,
  probabilityEdgeBps,
  returnOnCostBps,
} from "./precision.js";
import type {
  EdgeEstimate,
  ExecutionIntent,
  MarketQuote,
  OrderBookSnapshot,
  PredictionContract,
  PredictionMarket,
  PredictionOpportunity,
  PredictionRejectionReason,
  ProbabilityEstimate,
} from "./types.js";

/** Basis points of haircut per percentage point of missing confidence. */
export const CONFIDENCE_HAIRCUT_WEIGHT_BPS = 200;

export interface OpportunityContext {
  policy: Policy;
  /** Result of asking the control plane for permission to trade at all. */
  controlVerdict: ControlVerdict;
  /** Current drawdown from peak equity, basis points. Reported, not enforced here. */
  drawdownBps: number;
  /** Day-to-date loss against the policy budget, basis points. Reported, not enforced here. */
  dayLossBps: number;
  /** Total capital currently committed to open positions, micro-USDC. */
  openExposureMicros: bigint;
  /** Total marked equity including idle cash, micro-USDC. */
  totalEquityMicros: bigint;
  /** Cash not already committed, micro-USDC. */
  deployableMicros: bigint;
  /** Number of prediction positions currently open. Reported, not enforced here. */
  openPredictionPositions: number;
}

export interface OpportunityInput {
  market: PredictionMarket;
  contract: PredictionContract;
  quote: MarketQuote;
  book: OrderBookSnapshot;
  estimate: ProbabilityEstimate | null;
  outcomeId: string;
  intent: ExecutionIntent;
  nowMs: number;
  context: OpportunityContext;
}

export interface OpportunityAssessment {
  /** Stable across runs: `${contractId}:${intent}`. */
  opportunityId: string;
  opportunity: PredictionOpportunity | null;
  /** Rejection reasons, in the order the checks ran. Empty when accepted. */
  rejections: PredictionRejectionReason[];
  accepted: boolean;
  /**
   * The full cost decomposition, present whenever an estimate existed —
   * including on a refusal, because "refused" is much easier to trust when the
   * numbers that caused it are right there.
   */
  edge: EdgeEstimate | null;
  /** Human-readable explanation of each refusal. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Book arithmetic
// ---------------------------------------------------------------------------

/**
 * Walk levels for a taker order and return the volume-weighted average price.
 *
 * A partial answer is the honest one. Truncating to the depth that actually
 * exists, rather than assuming the whole size fills at the best price, is what
 * keeps the estimate from living in a world where the book is infinitely deep.
 */
export function walkBook(
  levels: readonly { priceMicros: bigint; qtyAtomic: bigint }[],
  qtyAtomic: bigint,
): { vwapMicros: bigint | null; filledQtyAtomic: bigint; notionalMicros: bigint; exhausted: boolean } {
  let remaining = qtyAtomic;
  let notional = 0n;
  for (const level of levels) {
    if (remaining <= 0n) break;
    const take = level.qtyAtomic < remaining ? level.qtyAtomic : remaining;
    if (take <= 0n) continue;
    notional += (take * level.priceMicros) / QTY_SCALE;
    remaining -= take;
  }
  const filled = qtyAtomic - remaining;
  if (filled <= 0n) {
    return { vwapMicros: null, filledQtyAtomic: 0n, notionalMicros: 0n, exhausted: true };
  }
  return {
    vwapMicros: floorDiv(notional * QTY_SCALE, filled * PRICE_SCALE),
    filledQtyAtomic: filled,
    notionalMicros: notional,
    exhausted: remaining > 0n,
  };
}

/**
 * Expected slippage for a taker order, in bps of the best price.
 *
 * Zero for a maker: a maker chooses its own price, so the real costs of a
 * resting order — queue position and adverse selection — belong to the fill
 * model, where they can be modelled honestly, rather than here where they would
 * have to be guessed.
 */
export function slippageBps(book: OrderBookSnapshot, intent: ExecutionIntent, qtyAtomic: bigint): number {
  if (intent === "maker" || qtyAtomic <= 0n) return 0;
  const levels = book.asks;
  const best = levels[0]?.priceMicros ?? 0n;
  if (best <= 0n || levels.length === 0) return 0;
  const walk = walkBook(levels, qtyAtomic);
  if (walk.vwapMicros === null) return 0;
  const delta = walk.vwapMicros - best;
  if (delta <= 0n) return 0;
  return Number(floorDiv(delta * BPS_DENOM, best));
}

// ---------------------------------------------------------------------------
// Cost decomposition
// ---------------------------------------------------------------------------

/**
 * The full cost decomposition for one candidate.
 *
 * Expressed as a subtraction chain from gross return *on the midpoint*, rather
 * than as a profit figure compared against a price. That ordering matters: it
 * charges the spread exactly once, as the difference between what the midpoint
 * implies and what we actually pay. Computing the profit at the entry price and
 * then also subtracting a spread cost would double-count it and quietly inflate
 * the edge of every taker order.
 */
export function decomposeEdge(input: {
  estimateBps: number;
  quote: MarketQuote;
  book: OrderBookSnapshot;
  intent: ExecutionIntent;
  qtyAtomic: bigint;
  feeBps: number;
  flatFeeMicrosPerContract: bigint;
  baseSafetyMarginBps: number;
  confidence: number;
}): EdgeEstimate {
  const mid = input.quote.mid > 0n ? input.quote.mid : input.quote.bestAsk;
  const entryPrice = input.intent === "taker" ? input.quote.bestAsk : input.quote.bestBid;

  // Gross: what the estimate is worth per contract, measured at the midpoint.
  const probabilityMicros = floorDiv(
    BigInt(clampBigInt(BigInt(clampInteger(input.estimateBps)), 0n, BPS_DENOM)) * PRICE_SCALE,
    BPS_DENOM,
  );
  const expectedPayoutPerContract = floorDiv(probabilityMicros * PRICE_SCALE, PRICE_SCALE);
  const grossProfitPerContract = expectedPayoutPerContract - mid;
  const grossReturnBps = returnOnCostBps(grossProfitPerContract, mid) ?? 0;

  // Spread: what is given up by crossing, or by being filled, away from the mid.
  const crossing = entryPrice - mid;
  const spreadCostBps = returnOnCostBps(crossing, mid) ?? 0;

  // Fees: proportional plus any per-contract flat, expressed as a combined rate.
  const flatFeeTotal = floorDiv(input.qtyAtomic * input.flatFeeMicrosPerContract, QTY_SCALE);
  const notionalEstimate = floorDiv(input.qtyAtomic * mid, QTY_SCALE);
  const flatFeeBps = notionalEstimate > 0n ? returnOnCostBps(flatFeeTotal, notionalEstimate) ?? 0 : 0;
  const totalFeeBps = input.feeBps + flatFeeBps;

  const slip = slippageBps(input.book, input.intent, input.qtyAtomic);

  // Safety margin: a flat buffer plus a haircut proportional to how little the
  // estimator trusts itself. Confidence 100 pays nothing extra; confidence 50
  // pays twice the weight.
  const safetyMarginBps =
    input.baseSafetyMarginBps + confidenceHaircutBps(input.confidence);

  const netExpectedEdgeBps = grossReturnBps - spreadCostBps - totalFeeBps - slip - safetyMarginBps;

  // The same decomposition per contract in micro-USDC, so it can be compared
  // against a minimum position size and, later, against realised P&L.
  const feePerContract = feeMicros(mid, input.feeBps, input.flatFeeMicrosPerContract, QTY_SCALE);
  const slipPerContract = slip > 0 ? floorDiv((mid * BigInt(slip)) / BPS_DENOM, 1n) : 0n;
  const safetyPerContract = floorDiv((mid * BigInt(safetyMarginBps)) / BPS_DENOM, 1n);
  const netProfitPerContractMicros =
    grossProfitPerContract - crossing - feePerContract - slipPerContract - safetyPerContract;

  return {
    grossEdgeBps: 0, // filled in by the caller, which knows the implied probability
    expectedProfitPerContractMicros: grossProfitPerContract,
    spreadCostBps,
    feeBps: totalFeeBps,
    slippageBps: slip,
    safetyMarginBps,
    netExpectedEdgeBps,
    netProfitPerContractMicros,
  };
}

/** Extra safety-margin bps owed for a view held at `confidence`. */
export function confidenceHaircutBps(confidence: number): number {
  const c = clampInteger(confidence);
  const missing = Math.max(0, Math.min(100, 100 - c));
  return Math.ceil((missing * CONFIDENCE_HAIRCUT_WEIGHT_BPS) / 100);
}

function clampInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * Fractional Kelly position size, in basis points of full Kelly.
 *
 * `f* = (q − p) / (1 − p)`, with `p` the entry price expressed as a probability.
 * Returns zero for a non-positive edge or a degenerate payout denominator,
 * because a position size is never a reason to override a negative expectation.
 */
export function kellyFractionBps(estimatedTrueBps: number, entryPriceMicros: bigint): number {
  if (entryPriceMicros <= 0n || entryPriceMicros >= PRICE_SCALE) return 0;
  const q = clampBigInt(BigInt(clampInteger(estimatedTrueBps)), 0n, BPS_DENOM);
  const p = floorDiv(entryPriceMicros * BPS_DENOM, PRICE_SCALE);
  if (q <= p) return 0;
  const denom = BPS_DENOM - p;
  if (denom <= 0n) return 0;
  return Number(((q - p) * BPS_DENOM) / denom);
}

/** Kelly size scaled by policy fraction and by confidence, capped by policy. */
export function sizePositionBps(input: {
  estimatedTrueBps: number;
  entryPriceMicros: bigint;
  confidence: number;
  deployableMicros: bigint;
  kellyFractionBps: number;
  maxPositionBps: number;
}): number {
  const f = kellyFractionBps(input.estimatedTrueBps, input.entryPriceMicros);
  if (f <= 0) return 0;
  const confidenceScale = Math.max(0, Math.min(100, clampInteger(input.confidence))) / 100;
  const scaled = Math.floor((f * input.kellyFractionBps * confidenceScale) / 10_000);
  return Math.max(0, Math.min(scaled, input.maxPositionBps));
}

/**
 * Convert a size in bps of deployable cash into an atomic contract count.
 *
 * Rounds down, twice: the budget is floored, then the contract count is floored.
 * Never request a size the cash cannot cover.
 */
export function qtyFromSizeBps(sizeBps: number, deployableMicros: bigint, entryPriceMicros: bigint): bigint {
  if (sizeBps <= 0 || deployableMicros <= 0n || entryPriceMicros <= 0n) return 0n;
  const budget = floorDiv(deployableMicros * BigInt(clampInteger(sizeBps)), BPS_DENOM);
  return floorDiv(budget * QTY_SCALE, entryPriceMicros);
}

// ---------------------------------------------------------------------------
// The research-stage refusal layer
// ---------------------------------------------------------------------------

function addRejection(reasons: PredictionRejectionReason[], reason: PredictionRejectionReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/** Structural validity of the quote itself. Engine-level floors are not checked. */
export function quoteIsStructurallyValid(book: OrderBookSnapshot, quote: MarketQuote): boolean {
  if (quote.bestBid <= 0n || quote.bestAsk <= 0n) return false;
  if (quote.bestBid >= quote.bestAsk) return false;
  if (quote.bestAsk >= PRICE_SCALE) return false;
  if (book.bids.length === 0 || book.asks.length === 0) return false;
  // Bids must descend and asks must ascend, or the midpoint is a fiction.
  for (let i = 1; i < book.bids.length; i++) {
    if ((book.bids[i]?.priceMicros ?? 0n) >= (book.bids[i - 1]?.priceMicros ?? 0n)) return false;
  }
  for (let i = 1; i < book.asks.length; i++) {
    if ((book.asks[i]?.priceMicros ?? 0n) <= (book.asks[i - 1]?.priceMicros ?? 0n)) return false;
  }
  return true;
}

/**
 * Build an opportunity, or refuse it.
 *
 * Every applicable rejection is collected rather than short-circuiting, so the
 * dashboard can show a candidate refused for three independent reasons instead
 * of forcing a reviewer to bisect the code to find the others. `rejections[0]` is
 * the first check that fired and is the one worth reading first.
 */
export function buildOpportunity(input: OpportunityInput): OpportunityAssessment {
  const pp = input.context.policy.prediction;
  const { contract, quote, book, estimate, context, intent, nowMs } = input;
  const opportunityId = `${contract.contractId}:${intent}`;
  const rejections: PredictionRejectionReason[] = [];
  const notes: string[] = [];

  // Prediction policy absent or disabled fails closed. Without limits there is no
  // limit system to run against, and the answer to "no policy" is "no trade".
  if (!pp || !pp.enabled) {
    addRejection(rejections, "CONTROL_PLANE_BLOCKED");
    notes.push("prediction policy is absent or disabled");
    return { opportunityId, opportunity: null, rejections, accepted: false, edge: null, notes };
  }

  // --- structural validity --------------------------------------------------
  if (!contract.open) addRejection(rejections, "MARKET_NOT_OPEN");
  if (book.bids.length === 0 || book.asks.length === 0) {
    addRejection(rejections, "NO_TWO_SIDED_QUOTE");
  } else if (!quoteIsStructurallyValid(book, quote)) {
    addRejection(rejections, "INVALID_MARKET_DATA");
  }
  if (intent === "maker" && !pp.allowMaker) addRejection(rejections, "CONTROL_PLANE_BLOCKED");
  if (intent === "taker" && !pp.allowTaker) addRejection(rejections, "CONTROL_PLANE_BLOCKED");

  // --- structure ------------------------------------------------------------
  // A contract whose winning payout is not $1.00 has different arithmetic, and
  // the engine declines to pretend the arithmetic generalises.
  const outcome = contract.outcomes.find((o) => o.outcomeId === input.outcomeId);
  if (!outcome) {
    addRejection(rejections, "UNSUPPORTED_STRUCTURE");
  } else if (contract.structure === "multi" && outcome.payoutMicros !== PRICE_SCALE) {
    addRejection(rejections, "UNSUPPORTED_STRUCTURE");
    notes.push(`multi-outcome contract with a non-unit payout (${outcome.payoutMicros} of ${PRICE_SCALE}) is out of scope`);
  }

  // --- estimator ------------------------------------------------------------
  if (!estimate) {
    addRejection(rejections, "INVALID_ESTIMATE");
    notes.push("estimator abstained; abstention is a decision, not a gap");
  } else if (!Number.isInteger(estimate.probabilityBps) || estimate.probabilityBps < 0 || estimate.probabilityBps > 10_000) {
    addRejection(rejections, "INVALID_ESTIMATE");
    notes.push(`probability ${estimate.probabilityBps} is outside 0..10000 bps`);
  } else if (estimate.confidence < pp.minConfidence) {
    addRejection(rejections, "LOW_CONFIDENCE");
    notes.push(`confidence ${estimate.confidence} is below the ${pp.minConfidence} floor`);
  }

  // --- control plane --------------------------------------------------------
  // Checked here as well as in the engine because there is no point building a
  // full cost decomposition for a trade that is already forbidden.
  if (!context.controlVerdict.allowed) {
    addRejection(rejections, "CONTROL_PLANE_BLOCKED");
    notes.push(context.controlVerdict.reasons.join("; "));
  }

  // --- horizon --------------------------------------------------------------
  const resolutionMs = Date.parse(contract.resolutionTime);
  const msToResolution = resolutionMs - nowMs;
  if (!Number.isFinite(resolutionMs)) {
    addRejection(rejections, "INVALID_MARKET_DATA");
    notes.push("contract has no parseable resolution time");
  } else if (msToResolution < pp.minMsToResolution) {
    addRejection(rejections, "MARKET_TOO_CLOSE_TO_RESOLUTION");
    notes.push(`${msToResolution} ms to resolution is inside the ${pp.minMsToResolution} ms floor`);
  }

  // --- size, then edge ------------------------------------------------------
  //
  // Size has to exist before the edge can be decomposed, and the edge has to
  // clear the floor before the size can be trusted. Resolved in that order: a
  // provisional Kelly size sizes the edge, and the edge test then gates the whole
  // candidate. Two passes, no circularity.
  const impliedBps = impliedProbabilityBps(quote.mid);
  const entryPrice = intent === "taker" ? quote.bestAsk : quote.bestBid;
  const feeRateBps = intent === "taker" ? pp.fees.takerFeeBps : pp.fees.makerFeeBps;

  let sizeBps = 0;
  let qtyAtomic = 0n;
  let edge: EdgeEstimate | null = null;

  if (estimate && entryPrice > 0n) {
    sizeBps = sizePositionBps({
      estimatedTrueBps: estimate.probabilityBps,
      entryPriceMicros: entryPrice,
      confidence: estimate.confidence,
      deployableMicros: context.deployableMicros,
      kellyFractionBps: pp.kellyFractionBps,
      maxPositionBps: pp.maxPositionBps,
    });
    qtyAtomic = qtyFromSizeBps(sizeBps, context.deployableMicros, entryPrice);
    if (qtyAtomic > pp.maxContractsAtomic) qtyAtomic = pp.maxContractsAtomic;

    const notional = buyCostMicros(qtyAtomic, entryPrice);
    const fee = feeMicros(notional, feeRateBps, pp.fees.flatFeeMicrosPerContract, qtyAtomic);
    const cost = notional + fee;

    if (qtyAtomic < pp.minContractsAtomic || qtyAtomic <= 0n) {
      addRejection(rejections, "POSITION_TOO_SMALL");
      notes.push(
        `the edge supports ${qtyAtomic} atomic units against a ${pp.minContractsAtomic} minimum; ` +
          "on this bankroll there is no tradable size",
      );
    } else if (cost > context.deployableMicros) {
      addRejection(rejections, "POSITION_TOO_SMALL");
      notes.push(`order cost ${cost} exceeds deployable ${context.deployableMicros}`);
    }

    edge = decomposeEdge({
      estimateBps: estimate.probabilityBps,
      quote,
      book,
      intent,
      qtyAtomic,
      feeBps: feeRateBps,
      flatFeeMicrosPerContract: pp.fees.flatFeeMicrosPerContract,
      baseSafetyMarginBps: pp.safetyMarginBps,
      confidence: estimate.confidence,
    });
    edge.grossEdgeBps = probabilityEdgeBps(estimate.probabilityBps, impliedBps);

    if (edge.netExpectedEdgeBps === null || edge.netExpectedEdgeBps <= pp.minNetEdgeBps) {
      addRejection(rejections, "EDGE_TOO_SMALL");
      notes.push(
        `net edge ${edge.netExpectedEdgeBps ?? "undefined"} bps does not clear the ${pp.minNetEdgeBps} bps floor ` +
          `(gross ${edge.grossEdgeBps} − spread ${edge.spreadCostBps} − fee ${edge.feeBps} ` +
          `− slippage ${edge.slippageBps} − margin ${edge.safetyMarginBps})`,
      );
    }
  }

  if (rejections.length > 0 || !estimate || !edge) {
    return { opportunityId, opportunity: null, rejections, accepted: false, edge, notes };
  }

  const opportunity: PredictionOpportunity = {
    provider: input.market.provider,
    marketId: input.market.marketId,
    contractId: contract.contractId,
    outcomeId: input.outcomeId,
    question: contract.question,
    category: contract.category,
    correlationGroup: contract.correlationGroup,
    structure: contract.structure,
    quote,
    estimate,
    impliedProbabilityBps: impliedBps,
    edge,
    intent,
    requestedQtyAtomic: qtyAtomic,
    requestedSizeBps: sizeBps,
    priceAtEntryMicros: entryPrice,
    msToResolution,
    dataTimestamp: quote.dataTimestamp,
    freshnessMs: quote.freshnessMs,
  };

  return { opportunityId, opportunity, rejections, accepted: true, edge, notes };
}

/** The first reason a candidate was refused. Null when accepted. */
export function primaryRejection(rejections: readonly PredictionRejectionReason[]): PredictionRejectionReason | null {
  return rejections.length > 0 ? rejections[0] ?? null : null;
}

/** The price the estimate implies, for display beside the market's own quote. */
export function impliedPriceFor(estimateBps: number): bigint {
  return priceFromProbabilityBps(estimateBps);
}