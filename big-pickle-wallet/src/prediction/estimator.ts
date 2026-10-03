/**
 * Probability estimation — the SOVEREIGN half of the pipeline.
 *
 * This is the one place a *belief* enters the system, and it is deliberately
 * narrow: an estimator returns a probability and a confidence, never a size,
 * never a price and never a limit. Everything that can be checked afterwards is
 * computed afterwards, in deterministic code.
 *
 * The interface exists so the same strategy code can run against a real research
 * model later without touching anything downstream. Two implementations ship
 * here, and the contrast between them is the point:
 *
 *   `MarketImpliedEstimator`  believes exactly what the market believes. It can
 *                             never produce a trade, and that is the correct
 *                             behaviour for a strategy with no genuine edge. It
 *                             is the default.
 *   `FixtureResearchModel`    a synthetic opinion, deliberately noisy. It is a
 *                             stand-in for a real model, NOT an oracle: it is
 *                             wrong often enough that a strategy which treats it
 *                             as ground truth loses money, which is the whole
 *                             question the experiment exists to answer.
 */

import type { ProbabilityBps } from "./precision.js";
import { impliedProbabilityBps } from "./precision.js";
import type {
  OrderBookSnapshot,
  PredictionContract,
  PredictionMarket,
  ProbabilityEstimate,
  PublicTrade,
  MarketQuote,
} from "./types.js";

export interface ProbabilityEstimationInput {
  market: PredictionMarket;
  contract: PredictionContract;
  outcomeId: string;
  quote: MarketQuote;
  book: OrderBookSnapshot;
  trades: readonly PublicTrade[];
  nowMs: number;
}

export interface ProbabilityEstimator {
  readonly name: string;
  /**
   * Return an estimate, or `null` to abstain.
   *
   * Abstention is a first-class outcome. An estimator that cannot form a view
   * should say so; forcing a number to keep the pipeline busy is how a research
   * system manufactures trades out of nothing.
   */
  estimate(input: ProbabilityEstimationInput): ProbabilityEstimate | null;
}

function baseEstimate(input: ProbabilityEstimationInput, name: string, bps: ProbabilityBps, confidence: number, rationale: string): ProbabilityEstimate {
  return {
    provider: input.market.provider,
    marketId: input.market.marketId,
    contractId: input.contract.contractId,
    outcomeId: input.outcomeId,
    probabilityBps: bps,
    confidence,
    estimator: name,
    rationale,
    at: new Date(input.nowMs).toISOString(),
  };
}

/**
 * Believes the market.
 *
 * Structurally incapable of generating a trade: an estimate equal to the
 * implied probability leaves net edge at zero minus costs, and costs are never
 * negative. Useful as the default, and as a control in tests — with this
 * estimator the engine must refuse every single candidate.
 */
export class MarketImpliedEstimator implements ProbabilityEstimator {
  readonly name = "market-implied";

  estimate(input: ProbabilityEstimationInput): ProbabilityEstimate {
    const bps = impliedProbabilityBps(input.quote.mid);
    return baseEstimate(
      input,
      this.name,
      bps,
      50,
      `no independent view; adopting the midpoint of ${bps} bps as the estimate, which yields no edge by construction`,
    );
  }
}

/**
 * A fixed synthetic opinion supplied per fixture market.
 *
 * `byMarketId` maps a market to a probability and confidence. The value is a
 * *model output*, and the model is fallible on purpose — several fixtures have
 * it confidently wrong, so the experiment measures the cost of being wrong
 * rather than assuming it away.
 */
export class FixtureResearchModel implements ProbabilityEstimator {
  readonly name = "fixture-research-model";

  constructor(
    private readonly byMarketId: ReadonlyMap<string, { probabilityBps: ProbabilityBps; confidence: number; note?: string }>,
  ) {}

  estimate(input: ProbabilityEstimationInput): ProbabilityEstimate | null {
    const view = this.byMarketId.get(input.market.marketId);
    if (!view) return null;
    return baseEstimate(
      input,
      this.name,
      view.probabilityBps,
      view.confidence,
      view.note ?? `synthetic research view of ${view.probabilityBps} bps at ${view.confidence}% confidence`,
    );
  }
}

/**
 * Blend two estimators, refusing when they disagree beyond `maxDisagreementBps`.
 *
 * The refusal is the valuable part. Two models that disagree by 30 points are
 * not an average — they are two incompatible claims, and averaging them
 * manufactures a number that neither model believes.
 */
export class ConsensusEstimator implements ProbabilityEstimator {
  readonly name = "consensus";

  constructor(
    private readonly members: readonly ProbabilityEstimator[],
    private readonly maxDisagreementBps: number,
  ) {}

  estimate(input: ProbabilityEstimationInput): ProbabilityEstimate | null {
    const views: ProbabilityEstimate[] = [];
    for (const member of this.members) {
      const view = member.estimate(input);
      if (view) views.push(view);
    }
    if (views.length === 0) return null;
    if (views.length === 1) {
      const only = views[0];
      return only ?? null;
    }

    let min = views[0]?.probabilityBps ?? 0;
    let max = min;
    for (const v of views) {
      if (v.probabilityBps < min) min = v.probabilityBps;
      if (v.probabilityBps > max) max = v.probabilityBps;
    }
    if (max - min > this.maxDisagreementBps) {
      // Abstain rather than average. See the note above.
      return null;
    }

    let sum = 0;
    let confidence = 0;
    for (const v of views) {
      sum += v.probabilityBps;
      confidence = Math.min(confidence === 0 ? v.confidence : Math.min(confidence, v.confidence), v.confidence);
    }
    const mean = Math.trunc(sum / views.length);
    return baseEstimate(
      input,
      this.name,
      mean,
      confidence,
      `${views.length} estimators agreed within ${max - min} bps; weakest member's confidence carried through`,
    );
  }
}