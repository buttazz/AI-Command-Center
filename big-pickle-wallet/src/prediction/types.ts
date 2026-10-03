/**
 * Prediction-market domain types.
 *
 * Provider-neutral by construction: nothing here names a venue, a chain, a
 * token address or an exchange API. A Kalshi adapter and a Polymarket adapter
 * both have to be expressible in these shapes, and the strategy layer above has
 * to be unable to tell which one it is talking to. If a field can only be
 * filled in for one venue, it does not belong in this file.
 *
 * Two rules hold throughout:
 *
 *  1. Prices and probabilities are `bigint` on the micro-USDC-per-$1 scale from
 *     precision.ts. Money that is accounted uses the existing `Money`
 *     abstraction. No float ever reaches an accounting or limit check.
 *  2. Everything carries the timestamp it was observed at. Freshness is a
 *     first-class field, not something reconstructed later from a wall clock,
 *     because a stale quote is one of the most expensive mistakes a
 *     market-making-adjacent strategy can make.
 */

import type { ProbabilityBps } from "./precision.js";

/** A venue identifier. Free-form on purpose: no provider is privileged. */
export type PredictionProviderId = string;

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

/**
 * Outcome structure of a contract.
 *
 * `binary` is the common case (YES/NO). `multi` covers outright or
 * "one-of-N" markets, where several contracts are listed against the same
 * event and only one pays out. Both are represented by the same
 * `PredictionOutcome` list — the distinction is whether the outcome set is
 * exhaustive-and-exclusive.
 */
export type PredictionStructure = "binary" | "multi";

/** One outcome of a contract: the thing that either happens or does not. */
export interface PredictionOutcome {
  /** Stable within the contract. */
  outcomeId: string;
  /** "Yes", "No", or a leg label on a multi-outcome market. */
  label: string;
  /** Human shorthand, used as the synthetic `symbol` in the policy engine. */
  shortLabel: string;
  /**
   * Payout if this outcome is the resolved winner, in micro-USDC. Normally
   * exactly $1.00, but a multi-outcome contract can carry a different payout
   * and the arithmetic must not assume otherwise.
   */
  payoutMicros: bigint;
  /** True when the contract's resolution criteria name this outcome. */
  isResolvedWinner: boolean | null;
}

/** A tradable contract on an event. */
export interface PredictionContract {
  contractId: string;
  marketId: string;
  /** The market question or title, verbatim from the provider. */
  question: string;
  category: string;
  structure: PredictionStructure;
  outcomes: readonly PredictionOutcome[];
  /**
   * Positions whose resolution is driven by the same underlying fact. Used by
   * the correlation gate; a provider that cannot supply it must leave it empty
   * and the gate will simply not fire, which is honest rather than permissive
   * by accident because the size cap still applies.
   */
  correlationGroup: string;
  /** Resolution time, ISO-8601. */
  resolutionTime: string;
  /** True while the contract is listed and accepting orders. */
  open: boolean;
  /** Venue-specific tick/close behaviour, if any. Null when continuous. */
  tickRule: "continuous" | "close-only" | null;
}

/** A listed market: the event plus every contract currently tradeable on it. */
export interface PredictionMarket {
  provider: PredictionProviderId;
  marketId: string;
  question: string;
  category: string;
  /** Human label for the dashboard and the audit log. */
  ticker: string;
  contracts: readonly PredictionContract[];
  /** 24h traded notional in micro-USDC, as reported by the provider. */
  volume24hMicros: bigint;
  /** When the provider last refreshed this market's metadata. */
  dataTimestamp: string;
}

// ---------------------------------------------------------------------------
// Book and quotes
// ---------------------------------------------------------------------------

/** One resting price level. Sizes are atomic contract units, not dollars. */
export interface OrderBookLevel {
  priceMicros: bigint;
  qtyAtomic: bigint;
}

export interface OrderBookSnapshot {
  provider: PredictionProviderId;
  marketId: string;
  contractId: string;
  outcomeId: string;
  /** Bids, best (highest) first. */
  bids: readonly OrderBookLevel[];
  /** Asks, best (lowest) first. */
  asks: readonly OrderBookLevel[];
  /** When the book itself was produced by the provider. */
  dataTimestamp: string;
  /** Provider sequence number, when it has one. Used for stale-book checks. */
  sequence: number;
}

/** A two-sided price and the derived figures a decision needs. */
export interface MarketQuote {
  provider: PredictionProviderId;
  marketId: string;
  contractId: string;
  outcomeId: string;
  bestBid: bigint;
  bestAsk: bigint;
  /** Resting quantity at the best bid, atomic units. */
  bestBidQty: bigint;
  /** Resting quantity at the best ask, atomic units. */
  bestAskQty: bigint;
  mid: bigint;
  /** Spread in basis points of the midpoint. */
  spreadBps: number;
  /** Sum of bid-side depth within `depthLevels`, in micro-USDC. */
  bidDepthMicros: bigint;
  /** Sum of ask-side depth within `depthLevels`, in micro-USDC. */
  askDepthMicros: bigint;
  dataTimestamp: string;
  /** Age of the quote at decision time. Derived, never stored stale. */
  freshnessMs: number;
}

export interface PublicTrade {
  provider: PredictionProviderId;
  contractId: string;
  outcomeId: string;
  priceMicros: bigint;
  qtyAtomic: bigint;
  side: "buy" | "sell";
  at: string;
}

/** The resolution of a contract, once known. */
export interface ResolvedMarket {
  provider: PredictionProviderId;
  marketId: string;
  contractId: string;
  resolvedAt: string;
  /** The outcome the contract settled on. */
  winningOutcomeId: string;
  /** Free-text resolution criteria/source, verbatim from the provider. */
  resolutionSource: string;
  /** True when resolution was final, not provisional. */
  final: boolean;
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

/** What the research layer believes, and how much it is willing to trust it. */
export interface ProbabilityEstimate {
  provider: PredictionProviderId;
  marketId: string;
  contractId: string;
  outcomeId: string;
  /** The estimate. Basis points, 0..10_000. */
  probabilityBps: ProbabilityBps;
  /** 0..100. How much the estimator trusts its own number. */
  confidence: number;
  /** Which estimator produced this, for audit. */
  estimator: string;
  /** What the estimate is based on. Never a private key or a credential. */
  rationale: string;
  at: string;
}

/**
 * The full cost decomposition for one opportunity.
 *
 * Every term is already pessimistic. `netExpectedEdgeBps` is what is left after
 * all of them and is the only figure permitted to make a proposal.
 */
export interface EdgeEstimate {
  /** Probability-space disagreement, `estimated true − market implied`. */
  grossEdgeBps: number;
  /** What the estimate is worth per contract, in micro-USDC, before costs. */
  expectedProfitPerContractMicros: bigint;
  /** Crossing the spread: best ask less midpoint, in bps of cost. */
  spreadCostBps: number;
  /** Provider fee schedule for the intended role, in bps of notional. */
  feeBps: number;
  /** Expected walking-the-book cost for this size, in bps of notional. */
  slippageBps: number;
  /** Discount applied to the estimate for model error and staleness. */
  safetyMarginBps: number;
  /**
   * What survives all of it. Basis points of return on cost. Null when the
   * cost basis is zero, which is not the same as zero edge.
   */
  netExpectedEdgeBps: number | null;
  /** Expected profit per contract after every cost, micro-USDC. */
  netProfitPerContractMicros: bigint;
}

/** Maker or taker. Determines how the fill model behaves and what it costs. */
export type ExecutionIntent = "maker" | "taker";

/** A research candidate: everything needed to judge, and to refuse, a trade. */
export interface PredictionOpportunity {
  provider: PredictionProviderId;
  marketId: string;
  contractId: string;
  outcomeId: string;
  question: string;
  category: string;
  correlationGroup: string;
  structure: PredictionStructure;
  quote: MarketQuote;
  estimate: ProbabilityEstimate;
  /** Market-implied probability, from the midpoint. Basis points. */
  impliedProbabilityBps: ProbabilityBps;
  edge: EdgeEstimate;
  /** Intended execution role for the paper order. */
  intent: ExecutionIntent;
  /** Requested size in contracts, atomic units. */
  requestedQtyAtomic: bigint;
  /** Requested size in basis points of deployable bankroll. */
  requestedSizeBps: number;
  /** Asked model. Display only; never an input to a limit. */
  priceAtEntryMicros: bigint;
  /** Milliseconds from now until resolution. Negative once past. */
  msToResolution: number;
  dataTimestamp: string;
  freshnessMs: number;
}

// ---------------------------------------------------------------------------
// Rejection reasons
// ---------------------------------------------------------------------------

/**
 * Why a candidate was refused.
 *
 * These are enumerated rather than free text so that (a) rejection counts can
 * be aggregated on the dashboard and (b) a test can assert that a specific
 * class of bad opportunity was refused for the *right* reason. "Refused" with
 * no attribution is indistinguishable from "broken".
 *
 * Mapping note: these map onto the existing Constitution's outcomes rather than
 * replacing them. Anything below the research stage never becomes a proposal;
 * anything at or above it is refused by the policy engine and recorded as a
 * VETOED with the matching rule id.
 */
export type PredictionRejectionReason =
  /** Net edge after every cost is at or below the minimum. */
  | "EDGE_TOO_SMALL"
  /** Book or quote data is older than the policy freshness budget. */
  | "STALE_DATA"
  /** Book sequence or timestamp went backwards; the data cannot be trusted. */
  | "INVALID_MARKET_DATA"
  /** Top-of-book depth is below the policy minimum. */
  | "LOW_LIQUIDITY"
  /** Spread is wider than the policy maximum. */
  | "SPREAD_TOO_WIDE"
  /** Estimator confidence is below the policy minimum. */
  | "LOW_CONFIDENCE"
  /** The size the edge supports is below the minimum tradable size. */
  | "POSITION_TOO_SMALL"
  /** Adding this position would breach the open-exposure cap. */
  | "EXPOSURE_LIMIT"
  /** Correlated with an open position beyond the policy limit. */
  | "CORRELATED_EXPOSURE"
  /** Day-to-date loss budget is exhausted. */
  | "DAILY_LOSS_LIMIT"
  /** Drawdown is at or beyond the policy maximum. */
  | "DRAWDOWN_LIMIT"
  /** Resolution is too near to enter. */
  | "MARKET_TOO_CLOSE_TO_RESOLUTION"
  /** No two-sided quote, so there is no bounded way in or out. */
  | "NO_TWO_SIDED_QUOTE"
  /** The contract is not currently listed. */
  | "MARKET_NOT_OPEN"
  /** The estimator produced a probability outside [0, 1]. */
  | "INVALID_ESTIMATE"
  /** A control-plane stop (kill switch, freeze, de-risk) is engaged. */
  | "CONTROL_PLANE_BLOCKED"
  /** Contract structure this engine does not support. */
  | "UNSUPPORTED_STRUCTURE";

export const PREDICTION_REJECTION_REASONS: readonly PredictionRejectionReason[] = [
  "EDGE_TOO_SMALL",
  "STALE_DATA",
  "INVALID_MARKET_DATA",
  "LOW_LIQUIDITY",
  "SPREAD_TOO_WIDE",
  "LOW_CONFIDENCE",
  "POSITION_TOO_SMALL",
  "EXPOSURE_LIMIT",
  "CORRELATED_EXPOSURE",
  "DAILY_LOSS_LIMIT",
  "DRAWDOWN_LIMIT",
  "MARKET_TOO_CLOSE_TO_RESOLUTION",
  "NO_TWO_SIDED_QUOTE",
  "MARKET_NOT_OPEN",
  "INVALID_ESTIMATE",
  "CONTROL_PLANE_BLOCKED",
  "UNSUPPORTED_STRUCTURE",
] as const;

/** Human-readable one-liners, used by the dashboard and the audit log. */
export const PREDICTION_REJECTION_TEXT: Record<PredictionRejectionReason, string> = {
  EDGE_TOO_SMALL: "net edge after fees, spread, slippage and safety margin is not positive enough to trade",
  STALE_DATA: "market data is older than the freshness budget",
  INVALID_MARKET_DATA: "book data is inconsistent, out of order, or otherwise untrustworthy",
  LOW_LIQUIDITY: "top-of-book depth is below the minimum",
  SPREAD_TOO_WIDE: "spread is wider than the maximum",
  LOW_CONFIDENCE: "estimator confidence is below the minimum",
  POSITION_TOO_SMALL: "the size this edge supports is below the minimum tradable size",
  EXPOSURE_LIMIT: "open exposure would exceed the cap",
  CORRELATED_EXPOSURE: "correlated with an open position beyond the limit",
  DAILY_LOSS_LIMIT: "day-to-date loss budget is exhausted",
  DRAWDOWN_LIMIT: "drawdown is at or beyond the maximum",
  MARKET_TOO_CLOSE_TO_RESOLUTION: "resolution is too near to enter",
  NO_TWO_SIDED_QUOTE: "no two-sided quote, so there is no bounded way in or out",
  MARKET_NOT_OPEN: "the contract is not currently listed",
  INVALID_ESTIMATE: "the probability estimate is outside [0, 1]",
  CONTROL_PLANE_BLOCKED: "a control-plane stop is engaged",
  UNSUPPORTED_STRUCTURE: "contract structure is not supported by this engine",
};

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/**
 * SOVEREIGN's output.
 *
 * Note what is absent: no dollar amount, no absolute contract count, no fee
 * schedule, no fill price, no limit override. SOVEREIGN expresses size as a
 * bounded `sizeBps` of deployable bankroll and expresses *intent* (maker or
 * taker); every absolute number, every price and every cap is derived
 * downstream by deterministic code the SOVEREIGN does not control.
 *
 * This is the same discipline as the existing crypto `TradeProposal`: a model
 * may only ever author a bounded, content-free-enough request. If a model could
 * emit an absolute notional it could also emit "all of it".
 */
export interface PredictionTradeProposal {
  id: string;
  opportunityId: string;
  provider: PredictionProviderId;
  marketId: string;
  contractId: string;
  outcomeId: string;
  /** 1..10_000 basis points of deployable bankroll. Schema-capped. */
  sizeBps: number;
  /** Which outcome is being bought. Always a `buy` in this phase. */
  outcomeLabel: string;
  intent: ExecutionIntent;
  /** Model's stated reasoning. Advisory; never an input to a limit. */
  thesis: string;
  /**
   * Conditions that void the trade. Mandatory and non-empty, mirroring the
   * existing proposal schema: a trade with no defined invalidation has no
   * bounded maximum loss, and the Constitution refuses those.
   */
  invalidation: string[];
  /** Distance from entry to the model-level invalidation, in basis points. */
  distanceToInvalidationBps: number;
  /** 0..100, advisory. Mirrored into the estimate's confidence. */
  confidence: number;
  /** Nominal holding period, for reporting only. */
  horizon: "till-resolution" | "intraday" | "multi-day";
  createdBy: string;
  createdAt: string;
}

/** The Constitution's outcome. The only four values that exist. */
export type PredictionVerdict = "APPROVED" | "RESIZED" | "VETOED" | "NO_TRADE";

/** A Constitution verdict on one proposal, with everything needed to audit it. */
export interface PredictionDecision {
  id: string;
  at: string;
  proposalId: string | null;
  opportunityId: string;
  provider: PredictionProviderId;
  marketId: string;
  contractId: string;
  outcomeId: string;
  question: string;
  category: string;
  verdict: PredictionVerdict;
  /** Present when a proposal existed. */
  requestedSizeBps: number | null;
  /** Present when APPROVED or RESIZED. */
  finalSizeBps: number | null;
  notionalMicros: string | null;
  /** The deterministic rule that decided it. `none` when nothing objected. */
  rule: string;
  reasons: string[];
  /** Rejection reasons when the candidate never became a proposal. */
  rejectionReasons: PredictionRejectionReason[];
  netExpectedEdgeBps: number | null;
  intent: ExecutionIntent | null;
  simulation: true;
  paper: true;
}

// ---------------------------------------------------------------------------
// Paper execution
// ---------------------------------------------------------------------------

export type PaperOrderStatus =
  | "resting"
  | "partially-filled"
  | "filled"
  | "unfilled"
  | "cancelled"
  | "settled";

export type PaperOrderKind = "maker-limit" | "taker";

/**
 * A simulated order. There is no counterpart to this anywhere in the codebase:
 * no venue adapter, no client, no key. `PaperRef` is the only identifier the
 * order has, and it is prefixed so it can never be mistaken for a real one.
 */
export interface PaperOrder {
  paperRef: string;
  proposalId: string;
  provider: PredictionProviderId;
  marketId: string;
  contractId: string;
  outcomeId: string;
  kind: PaperOrderKind;
  intent: ExecutionIntent;
  side: "buy";
  /** Limit price for a maker order, micro-USDC. Null for a taker order. */
  limitPriceMicros: bigint | null;
  /** Best available price when the order was placed. Null for a taker. */
  referencePriceMicros: bigint;
  qtyAtomic: bigint;
  filledQtyAtomic: bigint;
  /** USDC committed to the order, fees included. Released on cancel/settle. */
  reservedMicros: bigint;
  /** Depth already resting ahead of us at our price when we joined. */
  queueAheadAtomic: bigint;
  status: PaperOrderStatus;
  placedAt: string;
  /** Fixture tick the order was placed on. Age is measured in ticks, not wall time. */
  placedTick: number;
  updatedAt: string;
  /** Why the order ended where it did. */
  statusReason: string;
  simulation: true;
  paper: true;
}

export interface PaperFill {
  paperRef: string;
  orderPaperRef: string;
  provider: PredictionProviderId;
  contractId: string;
  outcomeId: string;
  side: "buy";
  intent: ExecutionIntent;
  priceMicros: bigint;
  qtyAtomic: bigint;
  notionalMicros: bigint;
  feeMicros: bigint;
  at: string;
  /** Tick the fill happened on. Deterministic in fixture mode. */
  tick: number;
  /** Why the simulator believes this fill happened. */
  why: string;
  simulation: true;
  paper: true;
}

/** An open position in one contract outcome. */
export interface PaperPosition {
  provider: PredictionProviderId;
  marketId: string;
  contractId: string;
  outcomeId: string;
  question: string;
  category: string;
  correlationGroup: string;
  outcomeLabel: string;
  qtyAtomic: bigint;
  /** Total USDC paid, fees included. The cost basis for P&L. */
  costBasisMicros: bigint;
  /** USDC paid for principal alone, fees excluded. Used for turnover. */
  principalMicros: bigint;
  /** Mark price used for unrealised P&L. */
  markPriceMicros: bigint;
  openedAt: string;
  openedTick: number;
  fills: number;
  /** True once the contract has resolved either way. */
  resolved: boolean;
  /** Set when the contract resolves in our favour. */
  winning: boolean | null;
}

/** A closed position, retained for the win/loss and per-category statistics. */
export interface ResolvedPosition {
  provider: PredictionProviderId;
  marketId: string;
  contractId: string;
  outcomeId: string;
  question: string;
  category: string;
  correlationGroup: string;
  outcomeLabel: string;
  qtyAtomic: bigint;
  /** Realised P&L in micro-USDC, fees included. The only realised figure. */
  realizedPnlMicros: bigint;
  feesMicros: bigint;
  won: boolean;
  openedAt: string;
  closedAt: string;
  heldMs: number;
  tick: number;
}