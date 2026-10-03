/**
 * The Constitution, applied to prediction contracts.
 *
 * This file does not decide anything. It translates a research opportunity into
 * the existing engine's own `OrderFacts` shape, calls `evaluateOrder`, and
 * translates the verdict back. Every limit that binds is a limit in
 * `config/policy.aggressive.json`, and every number that limits is derived here
 * by arithmetic the SOVEREIGN does not control.
 *
 * The translation is the interesting part, and it is deliberately lossy in one
 * direction only. The opportunity can supply a *smaller* notional than the
 * policy allows; it can never supply a larger one, a different price, a
 * different contract, or a different size. The policy is the ceiling and the
 * opportunity is the request.
 *
 * On the synthetic address: `OrderFacts` requires an `asset: Hex`, because it
 * was written for ERC-20 pools where an address is the identity. A prediction
 * contract has an identity — its contract id — and no address. Rather than
 * pretend otherwise, the contract id is hashed into a clearly-labelled synthetic
 * address. It is used for denylist matching, position lookup and the correlation
 * scan, never for a call. It cannot be mistaken for a real contract because
 * nothing in this process ever signs anything.
 *
 * Note what a decision does not contain: the verdict, the rule that decided it,
 * every violation, and the final size. A `RESIZED` is not a quieter `APPROVED` —
 * it records the requested size, the final size and the reason they differ.
 */

import { Money } from "../core/money.js";
import {
  clampSizeBps,
  evaluateOrder,
  type OrderFacts,
  type PortfolioFacts,
} from "../policy/engine.js";
import type { Policy } from "../policy/schema.js";
import { BPS_DENOM, QTY_SCALE, buyCostMicros, feeMicros, floorDiv } from "./precision.js";
import type {
  PredictionDecision,
  PredictionOpportunity,
  PredictionTradeProposal,
  PredictionVerdict,
} from "./types.js";

/**
 * A deterministic, clearly-synthetic stand-in for a contract address.
 *
 * Two FNV-1a passes give 64 bits, padded to the 40 hex characters an address
 * needs. Deterministic per contract id, so the same contract always maps to the
 * same key across runs and across processes, and different contracts never
 * collide in the position lookup.
 */
export function syntheticContractAddress(contractId: string): `0x${string}` {
  const h1 = fnv1a(contractId).toString(16).padStart(8, "0");
  const h2 = fnv1a(`${contractId}#2`).toString(16).padStart(8, "0");
  const body = `${h1}${h2}${h1}${h2}${h1}`; // 40 characters
  return `0x${body}`;
}

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface PredictionPortfolioFacts extends PortfolioFacts {
  /** 24h traded notional on the contract, micro-USDC. */
  volume24hMicros: bigint;
  /** Resting depth at top of book, both sides, micro-USDC. */
  topOfBookLiquidityMicros: bigint;
  /** Prediction positions currently open. */
  openPredictionPositions: number;
  /** Open exposure in this contract's category, micro-USDC. */
  categoryExposureMicros: bigint;
  /** Open exposure in this contract's correlation group, micro-USDC. */
  correlationGroupExposureMicros: bigint;
  /** Correlation to the closest open position, bps. Null when none is open. */
  correlationToOpenBps: number | null;
  /** Gross capital deployed today, micro-USDC, for the daily deployment cap. */
  deployedTodayMicros: bigint;
}

export interface PredictionConstitutionInput {
  opportunity: PredictionOpportunity;
  policy: Policy;
  portfolio: PredictionPortfolioFacts;
  /** Wall-clock-free ISO timestamp for the decision record. */
  nowIso: string;
  /** Deterministic id prefix, e.g. the experiment tick. */
  idPrefix: string;
}

export interface PredictionConstitutionResult {
  decision: PredictionDecision;
  /** Final notional in micro-USDC when APPROVED or RESIZED. Null otherwise. */
  notionalMicros: bigint | null;
  /** Final contract size in atomic units when APPROVED or RESIZED. */
  finalQtyAtomic: bigint | null;
  /** The proposal the Constitution judged. Null when there was nothing to judge. */
  proposal: PredictionTradeProposal | null;
}

// ---------------------------------------------------------------------------
// Proposal construction
// ---------------------------------------------------------------------------

/**
 * Turn an accepted opportunity into a bounded proposal.
 *
 * The proposal carries `sizeBps` and an *intent*, never a notional, a contract
 * count or a fill price. That is the same discipline as the existing crypto
 * `TradeProposal`: a model may author a bounded request, and everything absolute
 * is derived afterwards by code the model does not control. If a proposal could
 * carry a dollar amount it could carry "all of it".
 *
 * `distanceToInvalidationBps` is derived, not chosen, and it is not what it is
 * for a token. A token can be exited when price moves against it; a binary
 * contract cannot be exited at all, it settles. The worst case is therefore the
 * whole premium, and reporting that as 10_000 bps — 100% of cost at risk — is the
 * only honest value. `computeMaxLoss` then contributes nothing beyond fees, which
 * is exactly why the engine checks `prediction.maxSingleContractLossBps` against
 * `predictionFacts.fullPremiumLossMicros` separately: for this instrument the
 * premium itself is the risk, not the distance to a stop.
 */
export function buildProposal(
  opportunity: PredictionOpportunity,
  idPrefix: string,
  nowIso: string,
): PredictionTradeProposal {
  return {
    id: `pred-${idPrefix}-${opportunity.marketId}-${opportunity.intent}`,
    opportunityId: `${opportunity.contractId}:${opportunity.intent}`,
    provider: opportunity.provider,
    marketId: opportunity.marketId,
    contractId: opportunity.contractId,
    outcomeId: opportunity.outcomeId,
    // Clamped by `prediction.maxPositionBps` in buildOpportunity; the schema
    // ceiling of 10_000 is asserted here so a policy edit cannot exceed it.
    sizeBps: Math.max(0, Math.min(10_000, Math.trunc(opportunity.requestedSizeBps))),
    outcomeLabel: opportunity.outcomeId,
    intent: opportunity.intent,
    thesis:
      `model ${opportunity.estimate.probabilityBps} bps against market ${opportunity.impliedProbabilityBps} bps; ` +
      `net edge ${opportunity.edge.netExpectedEdgeBps ?? 0} bps after spread, fees, slippage and margin`,
    invalidation: [
      "the contract resolves against the held outcome, losing the full premium plus fees",
      "quote freshness exceeds the policy budget before entry, so the estimate is no longer about this book",
      `net expected edge falls to or below ${opportunity.edge.netExpectedEdgeBps ?? 0} bps at entry`,
    ],
    // A contract has no stop. See the note above: 100% of the premium is the
    // maximum loss, and the engine enforces the premium bound separately.
    distanceToInvalidationBps: 10_000,
    confidence: Math.max(0, Math.min(100, Math.trunc(opportunity.estimate.confidence))),
    horizon: "till-resolution",
    createdBy: `sovereign:${opportunity.estimate.estimator}`,
    createdAt: nowIso,
  };
}

// ---------------------------------------------------------------------------
// The Constitution call
// ---------------------------------------------------------------------------

/**
 * Ask the Constitution.
 *
 * Returns `NO_TRADE` for a candidate that never earned a proposal, `VETOED` for
 * one the policy refused, `RESIZED` for one trimmed to fit, and `APPROVED` for one
 * permitted at the requested size. All four are outcomes. Only the first two
 * happen most of the time, and a run where most candidates are refused is a
 * working system rather than a broken one.
 */
export function askConstitution(input: PredictionConstitutionInput): PredictionConstitutionResult {
  const { opportunity, policy, portfolio, nowIso, idPrefix } = input;
  const pp = policy.prediction;

  const baseDecision = {
    id: `pdec-${idPrefix}-${opportunity.marketId}-${opportunity.intent}`,
    at: nowIso,
    proposalId: null,
    opportunityId: `${opportunity.contractId}:${opportunity.intent}`,
    provider: opportunity.provider,
    marketId: opportunity.marketId,
    contractId: opportunity.contractId,
    outcomeId: opportunity.outcomeId,
    question: opportunity.question,
    category: opportunity.category,
    rejectionReasons: [] as PredictionDecision["rejectionReasons"],
    netExpectedEdgeBps: opportunity.edge.netExpectedEdgeBps,
    intent: opportunity.intent,
    simulation: true as const,
    paper: true as const,
  };

  if (!pp || !pp.enabled) {
    const decision: PredictionDecision = {
      ...baseDecision,
      verdict: "NO_TRADE",
      requestedSizeBps: null,
      finalSizeBps: null,
      notionalMicros: null,
      rule: "prediction-not-enabled",
      reasons: ["this policy does not enable prediction-market instruments"],
    };
    return { decision, notionalMicros: null, finalQtyAtomic: null, proposal: null };
  }

  const proposal = buildProposal(opportunity, idPrefix, nowIso);
  const asset = syntheticContractAddress(opportunity.contractId);

  const entryPrice = opportunity.priceAtEntryMicros;
  const notional = buyCostMicros(opportunity.requestedQtyAtomic, entryPrice);
  const feeBps = opportunity.intent === "taker" ? pp.fees.takerFeeBps : pp.fees.makerFeeBps;
  const fees = feeMicros(notional, feeBps, pp.fees.flatFeeMicrosPerContract, opportunity.requestedQtyAtomic);
  const spend = notional + fees;

  // Cost of the smallest permitted position, used by the prediction-path dust
  // rule in the engine. Derived here because only this layer knows the price.
  const minContractNotional = buyCostMicros(pp.minContractsAtomic, entryPrice);
  const minContractCost =
    minContractNotional + feeMicros(minContractNotional, feeBps, pp.fees.flatFeeMicrosPerContract, pp.minContractsAtomic);

  // `distanceToInvalidationBps` on the proposal is the fraction of the premium at
  // risk, so `computeMaxLoss` reduces to the premium. Passed as the full premium
  // rather than a stop-out distance: a binary contract does not stop out.
  const facts: OrderFacts = {
    asset,
    symbol: `${opportunity.marketId}/${opportunity.outcomeId}`,
    side: "buy",
    notional: Money.fromMicros(spend),
    distanceToInvalidationBps: proposal.distanceToInvalidationBps,
    // The engine's own edge check runs on this figure. The prediction floor is
    // checked separately from the true net edge, so the two never disagree.
    expectedGrossEdgeBps: Math.max(0, opportunity.edge.netExpectedEdgeBps ?? 0),
    slippageBps: opportunity.edge.slippageBps,
    // Spread crossing, fees and the safety margin are charged as price impact
    // here. They are the same costs, already itemised in the edge decomposition;
    // re-deriving them in the engine would double-charge, so they are passed
    // through rather than recomputed.
    priceImpactBps: opportunity.edge.spreadCostBps + opportunity.edge.feeBps + opportunity.edge.safetyMarginBps,
    gasWei: 0n,
    gasPriceUsdcMicros: 0n,
    liquidityUsd: portfolio.topOfBookLiquidityMicros / 1_000_000n,
    volume24hUsd: portfolio.volume24hMicros / 1_000_000n,
    topHolderConcentrationBps: 0,
    // Left false on purpose. Nothing here is a token; the checks that would
    // consume these facts are skipped for prediction contracts, and asserting
    // otherwise would be a false claim in an audit record.
    tokenVerified: false,
    honeypotSuspected: false,
    transferSimulationPassed: false,
    instrument: "prediction-contract",
    predictionFacts: {
      topOfBookLiquidityMicros: portfolio.topOfBookLiquidityMicros,
      volume24hMicros: portfolio.volume24hMicros,
      spreadBps: opportunity.quote.spreadBps,
      dataAgeMs: opportunity.freshnessMs,
      msToResolution: opportunity.msToResolution,
      correlationGroup: opportunity.correlationGroup,
      category: opportunity.category,
      fullPremiumLossMicros: spend,
      openPredictionPositions: portfolio.openPredictionPositions,
      categoryExposureMicros: portfolio.categoryExposureMicros,
      correlationGroupExposureMicros: portfolio.correlationGroupExposureMicros,
      correlationToOpenBps: portfolio.correlationToOpenBps,
      minContractCostMicros: minContractCost,
      netExpectedEdgeBps: opportunity.edge.netExpectedEdgeBps ?? 0,
    },
  };

  const portfolioFacts: PortfolioFacts = {
    totalValue: portfolio.totalValue,
    deployable: portfolio.deployable,
    gasReserveWei: portfolio.gasReserveWei,
    currentGasPriceWei: portfolio.currentGasPriceWei,
    openPositions: portfolio.openPositions,
    openExposure: portfolio.openExposure,
    deployedTodayMicros: portfolio.deployedTodayMicros,
  };

  const verdict = evaluateOrder(facts, portfolioFacts, policy);

  if (!verdict.ok) {
    const decision: PredictionDecision = {
      ...baseDecision,
      proposalId: proposal.id,
      verdict: "VETOED",
      requestedSizeBps: proposal.sizeBps,
      finalSizeBps: 0,
      notionalMicros: "0",
      rule: verdict.rule,
      reasons: verdict.reasons,
    };
    return { decision, notionalMicros: null, finalQtyAtomic: null, proposal };
  }

  // Permitted. Try to keep the requested size before trimming: a trim is a real
  // change to the trade, so it should happen only when the policy demands it.
  const deployableBps =
    portfolio.deployable.micros > 0n
      ? Number((portfolio.deployable.micros * BPS_DENOM) / portfolio.totalValue.micros || 0n)
      : 0;
  const clamp = clampSizeBps(
    proposal.sizeBps,
    portfolioFacts,
    policy,
    Math.min(10_000, pp.maxPositionBps, deployableBps > 0 ? deployableBps : 10_000),
  );

  if (clamp.bps <= 0) {
    const decision: PredictionDecision = {
      ...baseDecision,
      proposalId: proposal.id,
      verdict: "VETOED",
      requestedSizeBps: proposal.sizeBps,
      finalSizeBps: 0,
      notionalMicros: "0",
      rule: "no-permitted-size",
      reasons: clamp.reasons.length > 0 ? clamp.reasons : ["no permitted size remains after clamping"],
    };
    return { decision, notionalMicros: null, finalQtyAtomic: null, proposal };
  }

  const finalQty = floorDiv(floorDiv(portfolio.deployable.micros * BigInt(clamp.bps), BPS_DENOM) * QTY_SCALE, entryPrice);
  if (finalQty < pp.minContractsAtomic) {
    const decision: PredictionDecision = {
      ...baseDecision,
      proposalId: proposal.id,
      verdict: "VETOED",
      requestedSizeBps: proposal.sizeBps,
      finalSizeBps: clamp.bps,
      notionalMicros: "0",
      rule: "below-dust",
      reasons: [
        ...clamp.reasons,
        `the clamped size supports only ${finalQty} atomic units against the ${pp.minContractsAtomic} minimum`,
      ],
    };
    return { decision, notionalMicros: null, finalQtyAtomic: null, proposal };
  }

  const cappedQty = finalQty > pp.maxContractsAtomic ? pp.maxContractsAtomic : finalQty;
  const finalNotional = buyCostMicros(cappedQty, entryPrice);
  const finalFees = feeMicros(finalNotional, feeBps, pp.fees.flatFeeMicrosPerContract, cappedQty);
  const finalSpend = finalNotional + finalFees;
  const resized = clamp.bps < proposal.sizeBps || cappedQty < opportunity.requestedQtyAtomic;

  const decision: PredictionDecision = {
    ...baseDecision,
    proposalId: proposal.id,
    verdict: resized ? "RESIZED" : "APPROVED",
    requestedSizeBps: proposal.sizeBps,
    finalSizeBps: clamp.bps,
    notionalMicros: finalSpend.toString(),
    rule: resized ? "size-clamped-by-policy" : "none",
    reasons: resized
      ? [
          ...clamp.reasons,
          `final size ${cappedQty} atomic units (${finalSpend} micro-USDC) after clamping from ${proposal.sizeBps} bps`,
        ]
      : [],
  };

  return { decision, notionalMicros: finalSpend, finalQtyAtomic: cappedQty, proposal };
}

/**
 * Record a candidate the research stage refused, as a `NO_TRADE` decision.
 *
 * Refusals belong in the audit log alongside approvals. A system that only
 * records what it did cannot be reviewed for what it declined to do, and the
 * decline rate is the more interesting number: it is the direct measure of how
 * much the cost gates are doing their job.
 */
export function recordRefusal(input: {
  idPrefix: string;
  nowIso: string;
  opportunityId: string;
  provider: string;
  marketId: string;
  contractId: string;
  outcomeId: string;
  question: string;
  category: string;
  rejections: PredictionDecision["rejectionReasons"];
  notes: readonly string[];
  netExpectedEdgeBps: number | null;
  intent: PredictionDecision["intent"];
}): PredictionDecision {
  return {
    id: `pdec-${input.idPrefix}-${input.marketId}-${input.intent ?? "none"}`,
    at: input.nowIso,
    proposalId: null,
    opportunityId: input.opportunityId,
    provider: input.provider,
    marketId: input.marketId,
    contractId: input.contractId,
    outcomeId: input.outcomeId,
    question: input.question,
    category: input.category,
    verdict: "NO_TRADE",
    requestedSizeBps: null,
    finalSizeBps: null,
    notionalMicros: null,
    rule: input.rejections[0] ?? "none",
    reasons: input.notes.length > 0 ? [...input.notes] : [...input.rejections],
    rejectionReasons: [...input.rejections],
    netExpectedEdgeBps: input.netExpectedEdgeBps,
    intent: input.intent,
    simulation: true,
    paper: true,
  };
}

export type { PredictionVerdict };