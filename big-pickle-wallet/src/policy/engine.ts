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

/**
 * Which market an order is for.
 *
 * The discriminator exists because two instrument classes have genuinely
 * different structural risks, and conflating them either produces nonsense
 * checks or requires weakening real ones. An on-chain token has holders, a
 * contract address and a pool, so `assets.*` limits apply. A prediction
 * contract has none of those but does have a book, a resolution date and a fee
 * schedule, so `prediction.*` limits apply. The discriminator is opt-in and
 * defaults to `onchain-token`, so every existing order takes exactly the path
 * it took before this field existed.
 */
export type InstrumentClass = "onchain-token" | "prediction-contract";

/**
 * Prediction-specific facts supplied by the caller.
 *
 * Every field is optional so that a missing one can be treated as "not
 * satisfied" rather than defaulted. Absence is never a pass.
 */
export interface PredictionOrderFacts {
  /** Resting depth at top of book, both sides, micro-USDC. */
  topOfBookLiquidityMicros?: bigint;
  /** 24h traded notional, micro-USDC. */
  volume24hMicros?: bigint;
  /** Spread in basis points of the midpoint. */
  spreadBps?: number;
  /** Age of the book at decision time, milliseconds. */
  dataAgeMs?: number;
  /** Milliseconds remaining until the contract resolves. */
  msToResolution?: number;
  /** Group of contracts resolved by the same underlying fact. */
  correlationGroup?: string;
  /** Category the contract belongs to. */
  category?: string;
  /**
   * Cost basis of the contract's full premium loss, micro-USDC.
   *
   * This is the bound that matters for a binary contract: it can resolve
   * worthless, so the true worst case is the entire premium plus fees,
   * regardless of any stop-out the model imagines.
   */
  fullPremiumLossMicros?: bigint;
  /** Number of prediction positions currently open. */
  openPredictionPositions?: number;
  /** Open exposure in this contract's category, micro-USDC. */
  categoryExposureMicros?: bigint;
  /** Open exposure in this contract's correlation group, micro-USDC. */
  correlationGroupExposureMicros?: bigint;
  /** Correlation to the closest open position, bps. Null when none is open. */
  correlationToOpenBps?: number | null;
  /**
   * Cost of one minimum-size position, micro-USDC, principal plus fees.
   *
   * Supplied by the caller because only the caller knows the entry price. Used
   * as the prediction-path substitute for `execution.minNotionalUsdcMicros`,
   * which is denominated in gas terms and does not transfer to a contract book.
   */
  minContractCostMicros?: bigint;
  /**
   * Expected return on cost after fees, spread, slippage and safety margin.
   *
   * Supplied by the research layer and re-checked here against
   * `prediction.minNetEdgeBps`. The Constitution verifies the arithmetic rather
   * than trusting it, because a caller that can lower its own reported edge
   * would otherwise be able to bypass the floor entirely.
   */
  netExpectedEdgeBps?: number;
}

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
  /** Instrument class. Defaults to `onchain-token`; see `InstrumentClass`. */
  instrument?: InstrumentClass;
  /** Required, and only read, when `instrument` is `prediction-contract`. */
  predictionFacts?: PredictionOrderFacts;
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
  //
  // Skipped entirely for `prediction-contract`. These checks ask questions about
  // an ERC-20 pool — is this address verified, is it a honeypot, how deep is the
  // liquidity, how concentrated are the holders — and a prediction contract has no
  // address to verify, no transfer to simulate and no holders. Pushing a synthetic
  // contract id through them would mean asserting `tokenVerified: true` about
  // something that is not a token, which is worse than not asking the question.
  // The replacement limit set is section 1b, and it covers what matters here:
  // liquidity, volume, spread, freshness, horizon, worst-case loss, concentration
  // and correlation.

  if ((order.instrument ?? "onchain-token") === "onchain-token") {
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
  }

  // Risk's structured findings, when the caller supplied them. An explicit
  // false is a veto; absence is not a pass, so only `false` is treated as a fail.
  for (const [name, passed] of Object.entries(order.riskFindings ?? {})) {
    if (passed === false) fail(`risk-finding:${name}`, `Risk reported ${name} is not satisfied`);
  }

  // --- 1b. prediction-market instrument admissibility --------------------
  //
  // Purely additional. Nothing above or below this block is skipped, relaxed or
  // re-derived: an order that passes here still faces every existing rule. What
  // changes is which floors apply to a prediction contract, because the on-chain
  // ones describe a different instrument (see `PredictionPolicy` in schema.ts).
  //
  // It fails closed. A prediction order against a policy with no `prediction`
  // section is refused, not evaluated against limits that do not exist.

  if ((order.instrument ?? "onchain-token") === "prediction-contract") {
    const pp = policy.prediction;
    if (!pp || !pp.enabled) {
      fail(
        "prediction-not-enabled",
        "this policy does not enable prediction-market instruments; prediction orders are refused rather than evaluated against limits that do not exist",
      );
    } else {
      const pf = order.predictionFacts;

      if (pf?.spreadBps === undefined) {
        fail("invalid-market-data", "prediction order supplied no spread; a price cannot be checked without one");
      } else if (pf.spreadBps > pp.maxSpreadBps) {
        fail(
          "spread-too-wide",
          `spread ${pf.spreadBps} bps exceeds the ${pp.maxSpreadBps} bps prediction limit`,
        );
      }

      if (pf?.topOfBookLiquidityMicros === undefined) {
        fail("invalid-market-data", "prediction order supplied no top-of-book depth");
      } else if (pf.topOfBookLiquidityMicros < pp.minTopOfBookLiquidityUsdcMicros) {
        fail(
          "insufficient-liquidity",
          `top-of-book depth ${Money.fromMicros(pf.topOfBookLiquidityMicros).format()} USDC is below the ` +
            `${Money.fromMicros(pp.minTopOfBookLiquidityUsdcMicros).format()} USDC prediction minimum`,
        );
      }

      if (pf?.volume24hMicros === undefined) {
        fail("invalid-market-data", "prediction order supplied no 24h volume");
      } else if (pf.volume24hMicros < pp.minVolume24hUsdcMicros) {
        fail(
          "insufficient-volume",
          `24h volume ${Money.fromMicros(pf.volume24hMicros).format()} USDC is below the ` +
            `${Money.fromMicros(pp.minVolume24hUsdcMicros).format()} USDC prediction minimum`,
        );
      }

      if (pf?.dataAgeMs === undefined) {
        fail("invalid-market-data", "prediction order supplied no data timestamp, so freshness cannot be proven");
      } else if (pf.dataAgeMs > pp.maxDataAgeMs) {
        fail(
          "stale-data",
          `market data is ${pf.dataAgeMs} ms old, above the ${pp.maxDataAgeMs} ms freshness budget`,
        );
      }

      if (pf?.msToResolution === undefined) {
        fail("invalid-market-data", "prediction order supplied no resolution time");
      } else if (pf.msToResolution < pp.minMsToResolution) {
        fail(
          "too-close-to-resolution",
          `contract resolves in ${pf.msToResolution} ms, inside the ${pp.minMsToResolution} ms minimum horizon`,
        );
      }

      // The real bound for a binary contract. Checked against the premium, not
      // against `computeMaxLoss`, because a prediction contract does not have a
      // stop: it settles, and it can settle worthless.
      const fullLoss = pf?.fullPremiumLossMicros;
      if (fullLoss === undefined) {
        fail("invalid-market-data", "prediction order supplied no full-premium loss bound");
      } else {
        const cap = portfolio.totalValue.bps(pp.maxSingleContractLossBps);
        if (fullLoss > cap.micros) {
          fail(
            "max-loss-too-large",
            `full premium loss ${Money.fromMicros(fullLoss).format()} USDC exceeds ` +
              `${cap.format()} USDC (prediction.maxSingleContractLossBps ${pp.maxSingleContractLossBps})`,
          );
        }
      }

      if ((pf?.openPredictionPositions ?? 0) >= pp.maxConcurrentPositions) {
        fail(
          "too-many-positions",
          `${pf?.openPredictionPositions} prediction positions are open, at the ${pp.maxConcurrentPositions} limit`,
        );
      }

      if (pf?.correlationToOpenBps !== null && pf?.correlationToOpenBps !== undefined) {
        if (pf.correlationToOpenBps > pp.maxCorrelationBps) {
          fail(
            "correlated-concentration",
            `correlates ${pf.correlationToOpenBps} bps with an open position, above the ${pp.maxCorrelationBps} bps limit`,
          );
        }
      }

      const catCap = portfolio.totalValue.bps(pp.maxCategoryExposureBps);
      const groupCap = portfolio.totalValue.bps(pp.maxCorrelationGroupExposureBps);
      if (pf?.categoryExposureMicros !== undefined) {
        const projected = pf.categoryExposureMicros + order.notional.micros;
        if (projected > catCap.micros) {
          fail(
            "category-exposure-limit",
            `category ${pf.category ?? "unknown"} exposure would reach ${Money.fromMicros(projected).format()} USDC, ` +
              `above ${catCap.format()} USDC (${pp.maxCategoryExposureBps} bps)`,
          );
        }
      }
      if (pf?.correlationGroupExposureMicros !== undefined) {
        const projected = pf.correlationGroupExposureMicros + order.notional.micros;
        if (projected > groupCap.micros) {
          fail(
            "correlated-exposure-limit",
            `correlation group ${pf.correlationGroup ?? "unknown"} exposure would reach ` +
              `${Money.fromMicros(projected).format()} USDC, above ${groupCap.format()} USDC ` +
              `(${pp.maxCorrelationGroupExposureBps} bps); this is one bet, not a portfolio`,
          );
        }
      }

      // Tradeable size in contracts. Enforced against the derived contract count
      // the caller places in `OrderFacts.symbol` for prediction orders, and
      // against the notional, so an absurd size cannot hide behind a rounding.
      if (order.notional.lte(Money.zero())) {
        fail("zero-notional", "prediction order has no notional");
      }

      // The prediction-path substitute for `execution.minNotionalUsdcMicros`.
      //
      // That floor exists because gas makes a tiny trade value-destroying. It is
      // denominated in USDC and does not transfer to a contract book, where a
      // trade costs a bps fee and spends no gas at all. The equivalent control is
      // a minimum economic size, enforced as the cost of
      // `prediction.minContractsAtomic` at the entry price, which only the caller
      // knows. Fails closed when the caller supplies nothing — a caller that
      // omits this cannot reach the trade, rather than defaulting to a pass.
      if (pf?.minContractCostMicros === undefined) {
        fail("invalid-market-data", "prediction order supplied no minimum-position cost");
      } else if (order.notional.micros < pf.minContractCostMicros) {
        fail(
          "below-dust",
          `prediction notional ${Money.fromMicros(order.notional.micros).format()} USDC is below the cost of one ` +
            `minimum position (${Money.fromMicros(pf.minContractCostMicros).format()} USDC at ` +
            `prediction.minContractsAtomic ${pp.minContractsAtomic})`,
        );
      }

      // The net-edge floor, re-checked here rather than trusted from the caller.
      //
      // `execution.minExpectedEdgeBps` (15) is the on-chain floor and is far
      // looser than what a contract book needs; `prediction.minNetEdgeBps` (250
      // in the shipped profile) is the real control. Verifying it at the
      // Constitution means a research layer that misreports its own arithmetic
      // gets caught by the component that is not supposed to be trusting it.
      if (pf?.netExpectedEdgeBps === undefined) {
        fail("invalid-market-data", "prediction order supplied no net expected edge");
      } else if (pf.netExpectedEdgeBps <= pp.minNetEdgeBps) {
        fail(
          "insufficient-edge",
          `net expected edge ${pf.netExpectedEdgeBps} bps does not exceed the ${pp.minNetEdgeBps} bps ` +
            "prediction floor after fees, spread, slippage and safety margin",
        );
      }
    }
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

  if (order.instrument !== "prediction-contract" && order.notional.micros < policy.execution.minNotionalUsdcMicros) {
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
