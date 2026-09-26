/**
 * The hard limit engine.
 *
 * This is where the numbers live. Every check is deterministic arithmetic over
 * integers, and none of it can be influenced by agent output. The LLM pipeline
 * above it may be wrong, adversarial, or prompt-injected; the worst outcome it
 * can produce is a bad trade *within these limits*.
 *
 * Two things this module deliberately does NOT do:
 *
 *  1. It does not read `capital.targetDeploymentBps`. Deployment targets are a
 *     reporting concern for the allocator. If a quality gate consulted them, a
 *     system told to keep 90% deployed would open marginal trades to fill the
 *     quota. See docs/AGGRESSIVE-MODE.md 2.1.
 *  2. It does not consult the Risk agent. Risk's attestation is a gate the
 *     executor checks separately. Risk can only ever *remove* authority, so
 *     letting it influence this layer would let a compromised Risk process
 *     widen limits. The dependency is one-directional: Risk -> executor.
 */

import type { Policy } from "./schema.js";
import { Money } from "../core/money.js";
import { PolicyError } from "../errors.js";
import type { Hex } from "../types.js";

export interface OpenPositionView {
  asset: Hex;
  symbol: string;
  /** Current mark value in micro-USDC. */
  markValueUsdcMicros: bigint;
  costBasisUsdcMicros: bigint;
  /** True when this position already holds inventory in the asset. */
  holdsInventory: boolean;
  /** Realised return correlation to BTC over the lookback window, in bps. 0..10000. */
  correlationBps?: number;
  /** Absolute correlation to the proposed asset, in bps. 0..10000. */
  correlationToProposalBps?: number;
}

export interface OrderFacts {
  asset: Hex;
  symbol: string;
  side: "buy" | "sell";
  /** Absolute notional in micro-USDC. Derived from sizeBps by deterministic code. */
  notional: Money;
  /** Distance from entry to the invalidation level, in bps. Larger = safer. */
  distanceToInvalidationBps: number;
  /** Expected gross move to target, in bps. */
  expectedGrossEdgeBps: number;
  /** Realised or quoted slippage for this specific order, in bps. */
  slippageBps: number;
  /** Price impact against pool depth, in bps. */
  priceImpactBps: number;
  /** Gas cost of this order, in wei. */
  gasWei: bigint;
  /** USDC price of one gas unit in micro-USDC, for cost conversion. */
  gasPriceUsdcMicros: bigint;
  liquidityUsd: bigint;
  volume24hUsd: bigint;
  /** Highest holder's share of supply, in bps. */
  topHolderConcentrationBps: number;
  tokenVerified: boolean;
  honeypotSuspected: boolean;
  transferSimulationPassed: boolean;
  /** Extra facts assembled by the caller from Risk's structured findings. */
  riskFindings?: Record<string, boolean>;
}

export interface PortfolioFacts {
  totalValue: Money;
  /** USDC not committed to a position, after the gas reserve. */
  deployable: Money;
  gasReserveWei: bigint;
  currentGasPriceWei: bigint;
  openPositions: OpenPositionView[];
  /** Sum of open position mark values, micro-USDC. */
  openExposure: Money;
  /** Gross capital already deployed today, micro-USDC, from the day ledger. */
  deployedTodayMicros: bigint;
}

export interface LimitVerdict {
  ok: boolean;
  /** Every violated rule, not just the first. */
  reasons: string[];
  /** The single most specific rule identifier that failed. */
  rule: string;
  /** Worst-case loss for this order, in micro-USDC. Filled even on rejection. */
  maxLossUsdcMicros: bigint;
  /** How the notional was clamped, if it was. */
  clampedFromUsdcMicros?: bigint;
}

const noop = (): LimitVerdict => ({ ok: true, reasons: [], rule: "none", maxLossUsdcMicros: 0n });

/** Micro-USDC cost of `wei` of native gas. */
export function gasCostUsdcMicros(gasWei: bigint, gasPriceUsdcMicros: bigint): Money {
  if (gasPriceUsdcMicros === 0n) return Money.zero();
  // gasWei * usdcPerGas / 1e18
  return Money.fromMicros((gasWei * gasPriceUsdcMicros) / 10n ** 18n);
}

/**
 * Worst-case loss for an order.
 *
 * `notional × (1 − distanceToInvalidation)` is the loss if the invalidation is
 * hit and the exit fills exactly there — the assumption the whole risk budget
 * rests on, which is why an entry with no invalidation is refused outright.
 * Fees, slippage and gas are added because they are spent regardless of
 * direction.
 */
export function computeMaxLoss(
  notional: Money,
  distanceToInvalidationBps: number,
  policy: Policy,
  slippageBps: number,
  priceImpactBps: number,
  gasWei: bigint,
  gasPriceUsdcMicros: bigint,
): Money {
  const distanceBps = Math.min(10_000, Math.max(0, distanceToInvalidationBps));
  // Loss if stopped out: notional minus the distance we expect to travel first.
  const principalLoss = notional.bps(10_000 - distanceBps);
  const fees = notional.bps(policy.execution.assumedFeeBps);
  const slippage = notional.bps(slippageBps);
  const impact = notional.bps(priceImpactBps);
  const gas = gasCostUsdcMicros(gasWei, gasPriceUsdcMicros);
  return principalLoss.add(fees).add(slippage).add(impact).add(gas);
}

/**
 * Net edge after every cost. Positive is the only acceptable value.
 *
 * Gating on this rather than on a raw slippage cap is what lets a momentum
 * system take breakout entries: a 5% target with 1.2% slippage clears, while a
 * 0.4% target with 0.3% slippage does not, regardless of how well either filled.
 */
export function netEdgeBps(order: OrderFacts, policy: Policy): number {
  return (
    order.expectedGrossEdgeBps -
    order.slippageBps -
    order.priceImpactBps -
    policy.execution.assumedFeeBps
  );
}

/**
 * The full hard-limit evaluation. Additive: it collects every violation so an
 * operator sees the whole picture in one audit entry.
 */
export function evaluateOrder(
  order: OrderFacts,
  portfolio: PortfolioFacts,
  policy: Policy,
): LimitVerdict {
  const reasons: string[] = [];
  let rule = "none";
  const fail = (r: string, reason: string) => {
    reasons.push(reason);
    // Keep the first, most specific rule: it is the one an operator acts on.
    if (rule === "none") rule = r;
  };

  const maxLoss = computeMaxLoss(
    order.notional,
    order.distanceToInvalidationBps,
    policy,
    order.slippageBps,
    order.priceImpactBps,
    order.gasWei,
    order.gasPriceUsdcMicros,
  );

  const assetKey = order.asset.toLowerCase();
  const existing = portfolio.openPositions.find((p) => p.asset.toLowerCase() === assetKey);

  // --- 1. asset admissibility -------------------------------------------
  // Checked first: a denylisted or structurally unsafe token should never reach
  // the sizing arithmetic, and reporting "position too large" for a honeypot
  // would be misleading.

  if (policy.assets.denylist.includes(assetKey)) {
    fail("asset-denylisted", `asset ${order.symbol} (${order.asset}) is on the denylist`);
  }
  if (policy.assets.allowlist.length > 0 && !policy.assets.allowlist.includes(assetKey)) {
    fail("asset-not-allowlisted", `asset ${order.symbol} (${order.asset}) is not on the allowlist`);
  }
  if (policy.assets.rejectIfNoVerifiedSource && !order.tokenVerified) {
    fail("asset-unverified", `asset ${order.symbol} has no verified contract source`);
  }
  if (policy.assets.rejectIfHoneypotSuspected && order.honeypotSuspected) {
    fail("asset-honeypot", `asset ${order.symbol} is suspected of honeypot behaviour (sell-blocking)`);
  }
  if (policy.assets.rejectIfTransferSimulated && !order.transferSimulationPassed) {
    fail("asset-transfer-reverts", `simulated transfer of ${order.symbol} reverted`);
  }
  if (order.topHolderConcentrationBps > policy.assets.maxTopHolderConcentrationBps) {
    fail(
      "asset-holder-concentration",
      `top holder holds ${order.topHolderConcentrationBps} bps of ${order.symbol}, above the ${policy.assets.maxTopHolderConcentrationBps} bps limit`,
    );
  }
  if (order.liquidityUsd < policy.assets.minLiquidityUsd) {
    fail(
      "insufficient-liquidity",
      `${order.symbol} liquidity ${order.liquidityUsd} USD below the ${policy.assets.minLiquidityUsd} USD minimum`,
    );
  }
  if (order.volume24hUsd < policy.assets.minVolume24hUsd) {
    fail(
      "insufficient-volume",
      `${order.symbol} 24h volume ${order.volume24hUsd} USD below the ${policy.assets.minVolume24hUsd} USD minimum`,
    );
  }

  // Risk's structured findings, when the caller supplied them. An explicit
  // false is a veto; absence is not a pass, so only `false` is treated as a fail.
  for (const [name, passed] of Object.entries(order.riskFindings ?? {})) {
    if (passed === false) fail(`risk-finding:${name}`, `Risk reported ${name} is not satisfied`);
  }

  // --- 2. structural trade requirements ----------------------------------

  if (policy.execution.requireInvalidation && order.distanceToInvalidationBps <= 0) {
    fail(
      "missing-invalidation",
      "entry has no usable invalidation level; a trade that cannot be proven to lose a bounded amount is not permitted",
    );
  }

  if (policy.execution.requirePositiveEdgeAfterCosts) {
    const edge = netEdgeBps(order, policy);
    if (edge < policy.execution.minExpectedEdgeBps) {
      fail(
        "insufficient-edge",
        `net edge ${edge} bps after costs (gross ${order.expectedGrossEdgeBps}, slippage ${order.slippageBps}, impact ${order.priceImpactBps}, fees ${policy.execution.assumedFeeBps}) is below the required ${policy.execution.minExpectedEdgeBps} bps`,
      );
    }
  }

  if (order.slippageBps > policy.execution.maxSlippageBps) {
    fail(
      "excessive-slippage",
      `slippage ${order.slippageBps} bps exceeds the ${policy.execution.maxSlippageBps} bps circuit breaker`,
    );
  }
  if (order.priceImpactBps > policy.execution.maxPriceImpactBps) {
    fail(
      "excessive-price-impact",
      `price impact ${order.priceImpactBps} bps exceeds the ${policy.execution.maxPriceImpactBps} bps circuit breaker`,
    );
  }
  if (order.gasWei > policy.execution.maxGasWei) {
    fail("gas-price-spike", `gas cost ${order.gasWei} wei exceeds the ${policy.execution.maxGasWei} wei limit`);
  }

  // --- 3. averaging down (structural, unoverrideable) --------------------

  if (policy.execution.forbidAveragingDown && order.side === "buy" && existing?.holdsInventory) {
    fail(
      "averaging-down",
      `order would increase exposure to ${order.symbol}, which already holds an open position. Averaging down is structurally impossible: no agent can add to a losing position.`,
    );
  }

  // --- 4. notional bounds ------------------------------------------------

  if (order.notional.micros < policy.execution.minNotionalUsdcMicros) {
    fail(
      "below-dust",
      `notional ${order.notional.format()} USDC is below the ${Money.fromMicros(policy.execution.minNotionalUsdcMicros).format()} USDC minimum, where gas and fees dominate`,
    );
  }

  if (order.side === "buy") {
    const maxTrade = portfolio.totalValue.bps(policy.risk.maxSingleTradeBps);
    if (order.notional.gt(maxTrade)) {
      fail(
        "trade-too-large",
        `notional ${order.notional.format()} USDC exceeds maxSingleTradeBps ${policy.risk.maxSingleTradeBps} (${maxTrade.format()} USDC at current portfolio value)`,
      );
    }

    const maxPosition = portfolio.totalValue.bps(policy.capital.maxPositionBps);
    if (existing) {
      const combined = existing.markValueUsdcMicros + order.notional.micros;
      if (combined > maxPosition.micros) {
        fail(
          "position-too-large",
          `resulting position ${Money.fromMicros(combined).format()} USDC exceeds maxPositionBps ${policy.capital.maxPositionBps} (${maxPosition.format()} USDC)`,
        );
      }
    } else if (order.notional.gt(maxPosition)) {
      fail(
        "position-too-large",
        `notional ${order.notional.format()} USDC exceeds maxPositionBps ${policy.capital.maxPositionBps} (${maxPosition.format()} USDC)`,
      );
    }
  }

  // --- 5. portfolio exposure --------------------------------------------

  if (order.side === "buy") {
    const isNewAsset = !existing;
    if (isNewAsset && portfolio.openPositions.length >= policy.capital.maxConcurrentPositions) {
      fail(
        "too-many-positions",
        `already holding ${portfolio.openPositions.length} positions, at the ${policy.capital.maxConcurrentPositions} limit`,
      );
    }

    const newExposure = portfolio.openExposure.micros + order.notional.micros;
    const maxExposure = portfolio.totalValue.bps(policy.risk.maxOpenExposureBps);
    if (newExposure > maxExposure.micros) {
      fail(
        "exposure-too-high",
        `open exposure would reach ${Money.fromMicros(newExposure).format()} USDC, above maxOpenExposureBps ${policy.risk.maxOpenExposureBps} (${maxExposure.format()} USDC)`,
      );
    }

    // Correlation: four small-caps in a momentum regime are often one leveraged
    // bet on alt-beta. Treated as a concentration limit, not diversification.
    if (policy.concurrency.enforceCorrelationLimit && existing === undefined) {
      const tooCorrelated = portfolio.openPositions.filter(
        (p) =>
          typeof p.correlationToProposalBps === "number" &&
          p.correlationToProposalBps > policy.concurrency.maxCorrelationBetweenOpenPositions,
      );
      if (tooCorrelated.length > 0) {
        fail(
          "correlated-concentration",
          `correlates above ${policy.concurrency.maxCorrelationBetweenOpenPositions} bps with ${tooCorrelated.map((p) => p.symbol).join(", ")}; this is one leveraged bet, not diversification`,
        );
      }
    }
  }

  // --- 6. daily deployment cap -------------------------------------------

  if (order.side === "buy") {
    const maxDaily = portfolio.totalValue.bps(policy.risk.maxDailyDeployBps);
    const projected = portfolio.deployedTodayMicros + order.notional.micros;
    if (projected > maxDaily.micros) {
      fail(
        "daily-deploy-exceeded",
        `daily deployment would reach ${Money.fromMicros(projected).format()} USDC, above maxDailyDeployBps ${policy.risk.maxDailyDeployBps} (${maxDaily.format()} USDC); ${Money.fromMicros(portfolio.deployedTodayMicros).format()} USDC already deployed today`,
      );
    }
  }

  // --- 7. solvency (applies to every principal, owner included) -----------

  if (order.side === "buy" && order.notional.gt(portfolio.deployable)) {
    fail(
      "insufficient-funds",
      `notional ${order.notional.format()} USDC exceeds deployable ${portfolio.deployable.format()} USDC`,
    );
  }
  if (order.side === "sell" && !existing?.holdsInventory) {
    fail("no-inventory", `no open ${order.symbol} position to sell`);
  }

  // --- 8. max-loss budget -------------------------------------------------

  const maxLossCap = portfolio.totalValue.bps(policy.risk.materialLossBpsOfPortfolio * 2);
  if (maxLoss.gt(maxLossCap)) {
    fail(
      "max-loss-too-large",
      `worst-case loss ${maxLoss.format()} USDC exceeds ${maxLossCap.format()} USDC (${policy.risk.materialLossBpsOfPortfolio * 2} bps of portfolio)`,
    );
  }

  if (reasons.length > 0) {
    return { ok: false, reasons, rule, maxLossUsdcMicros: maxLoss.micros };
  }
  return { ok: true, reasons: [], rule: "none", maxLossUsdcMicros: maxLoss.micros };
}

/**
 * Clamp a requested size to what the policy permits, reporting what was
 * removed. Used by the allocator so it can prefer trimming to rejecting.
 */
export function clampSizeBps(
  requestedBps: number,
  portfolio: PortfolioFacts,
  policy: Policy,
  riskApprovedMaxBps: number,
): { bps: number; clampedFrom: number | null; reasons: string[] } {
  const reasons: string[] = [];
  let bps = requestedBps;
  const cap = (limit: number, label: string) => {
    if (bps > limit) {
      reasons.push(`clamped from ${bps} to ${limit} bps (${label})`);
      bps = limit;
    }
  };

  cap(riskApprovedMaxBps, "Risk's approved maximum for this proposal");
  cap(policy.risk.maxSingleTradeBps, "risk.maxSingleTradeBps");
  cap(policy.capital.maxPositionBps, "capital.maxPositionBps");

  // A new asset must leave room inside the concurrent-position limit; an
  // existing one does not consume a slot, so it is not clamped on that basis.
  if (portfolio.openPositions.length >= policy.capital.maxConcurrentPositions) {
    reasons.push(
      `at the ${policy.capital.maxConcurrentPositions}-position limit; a new asset cannot be opened`,
    );
    bps = 0;
  }

  if (bps <= 0) {
    reasons.push("clamped to zero: no permitted size remains");
  }
  return { bps: Math.max(0, Math.min(10_000, bps)), clampedFrom: null, reasons };
}

/** Throw if the verdict is a rejection, with the full reason list attached. */
export function assertAllowed(verdict: LimitVerdict): void {
  if (!verdict.ok) {
    throw new PolicyError(verdict.rule, verdict.reasons);
  }
}

export { noop as alwaysAllow };
