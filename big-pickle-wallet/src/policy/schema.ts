/**
 * Policy schema: parse and validate the on-disk policy file.
 *
 * This module fails closed. A malformed policy is a startup error, never a
 * silently-relaxed default. There is no permissive fallback anywhere in this
 * file — if a field is missing, the process refuses to start rather than assume
 * a limit.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { BigPickleError, SchemaError } from "../errors.js";
import { Money } from "../core/money.js";

export interface BpsRange {
  min: number;
  max: number;
}

export interface NetworkPolicy {
  permitted: string[];
  mainnetEnabled: boolean;
}

export interface CapitalPolicy {
  targetDeploymentBps: BpsRange;
  defaultPositionBps: BpsRange;
  maxPositionBps: number;
  maxConcurrentPositions: number;
  gasReserveWei: bigint;
  minDeployableUsdcMicros: bigint;
}

export interface RiskPolicy {
  maxDailyDrawdownBps: number;
  maxSingleTradeBps: number;
  maxDailyDeployBps: number;
  maxOpenExposureBps: number;
  consecutiveMaterialLossTrigger: number;
  materialLossBpsOfPortfolio: number;
  cooldownMs: number;
  dailyLossResponse: "de-risk" | "halt";
}

export interface ExecutionPolicy {
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  minExpectedEdgeBps: number;
  assumedFeeBps: number;
  maxGasWei: bigint;
  requireInvalidation: boolean;
  forbidAveragingDown: boolean;
  requirePositiveEdgeAfterCosts: boolean;
  maxOpenOrdersInFlight: number;
  minNotionalUsdcMicros: bigint;
}

export interface AssetsPolicy {
  allowSmallCaps: boolean;
  minLiquidityUsd: bigint;
  minVolume24hUsd: bigint;
  allowlist: string[];
  denylist: string[];
  rejectIfNoVerifiedSource: boolean;
  rejectIfHoneypotSuspected: boolean;
  rejectIfTransferSimulated: boolean;
  maxTopHolderConcentrationBps: number;
}

export interface ExitsPolicy {
  allowTrailingStops: boolean;
  trailingStopBps: number;
  allowPartialProfits: boolean;
  partialProfitAtBps: number[];
  partialProfitSizeBps: number;
  forceExitOnInvalidationBreach: boolean;
  allowDiscretionaryEarlyExit: boolean;
}

export interface ConcurrencyPolicy {
  maxCorrelationBetweenOpenPositions: number;
  enforceCorrelationLimit: boolean;
}

export interface CircuitBreakerPolicy {
  enabled: boolean;
  tripOnAttestationFailure: boolean;
  tripOnBalanceMismatch: boolean;
  tripOnPositionBookDrift: boolean;
  tripOnRepeatedReverts: boolean;
  tripOnRpcInconsistency: boolean;
  tripOnGasPriceSpike: boolean;
  tripOnPolicyError: boolean;
  maxConsecutiveReverts: number;
  positionBookDriftToleranceBps: number;
}

/**
 * Fees as a venue would charge them.
 *
 * `flatFeeMicrosPerContract` exists because that is how at least one real venue
 * charges: a fixed amount per contract, not a percentage of notional. On a $0.62
 * contract a 0.7% notional fee is under a cent, while a fixed fee can be a large
 * fraction of the premium. Modelling only the percentage would make a
 * per-contract fee schedule look harmless.
 */
export interface PredictionFeesPolicy {
  takerFeeBps: number;
  makerFeeBps: number;
  flatFeeMicrosPerContract: bigint;
}

/**
 * Prediction-market limits. Optional section, additive to every existing one.
 *
 * Calibration note, and it is the reason this section exists at all: the
 * `assets` limits are denominated for on-chain token markets — a $50,000
 * liquidity floor, a $100,000 daily volume floor, holder-concentration and
 * honeypot checks. Those numbers describe an ERC-20 pool. A prediction contract
 * on a regulated venue has no pool, no holders and no honeypot, and a $50 book
 * will never see $50,000 of depth without absurd risk. Reusing those floors
 * would either veto every opportunity (honest but useless) or require weakening
 * them (unacceptable).
 *
 * So prediction instruments get their own calibrated section, and the on-chain
 * section is left exactly as it was. Loading a prediction policy is *stricter*
 * than before, because every limit here is new and additional.
 */
export interface PredictionPolicy {
  /** Master switch for prediction-market instruments. */
  enabled: boolean;
  /** Minimum resting depth at top of book, micro-USDC, both sides combined. */
  minTopOfBookLiquidityUsdcMicros: bigint;
  /** Minimum 24h traded notional, micro-USDC. */
  minVolume24hUsdcMicros: bigint;
  /** Maximum spread, in basis points of the midpoint. */
  maxSpreadBps: number;
  /** Minimum net expected edge, in basis points of return on cost. */
  minNetEdgeBps: number;
  /** Discount applied to the estimate for model error and data staleness. */
  safetyMarginBps: number;
  /** Maximum age of any market datum before the candidate is refused. */
  maxDataAgeMs: number;
  /** Minimum time remaining until resolution before an entry is permitted. */
  minMsToResolution: number;
  /**
   * Maximum loss on one contract as a fraction of bankroll, in bps.
   *
   * A binary contract's true worst case is the whole premium: it can resolve
   * worthless. This is the bound the policy enforces, independent of any
   * stop-out assumption.
   */
  maxSingleContractLossBps: number;
  /** Maximum size of one contract position, bps of portfolio. */
  maxPositionBps: number;
  /** Maximum total open exposure, bps of portfolio. */
  maxOpenExposureBps: number;
  /** Maximum simultaneously open contract positions. */
  maxConcurrentPositions: number;
  /** Maximum open exposure in one category, bps of portfolio. */
  maxCategoryExposureBps: number;
  /** Maximum open exposure in one correlation group, bps of portfolio. */
  maxCorrelationGroupExposureBps: number;
  /** Correlation above which two positions are the same bet, bps. */
  maxCorrelationBps: number;
  /** Minimum estimator confidence, 0..100. */
  minConfidence: number;
  /** Minimum tradable size in atomic contract units (1e6 = 1 contract). */
  minContractsAtomic: bigint;
  /** Maximum tradable size in atomic contract units. */
  maxContractsAtomic: bigint;
  /** Fractional-Kelly multiplier for sizing, bps of full Kelly. */
  kellyFractionBps: number;
  /** Maker orders permitted. */
  allowMaker: boolean;
  /** Taker orders permitted. */
  allowTaker: boolean;
  fees: PredictionFeesPolicy;
}

export interface Policy {
  profile: string;
  version: number;
  network: NetworkPolicy;
  capital: CapitalPolicy;
  risk: RiskPolicy;
  execution: ExecutionPolicy;
  assets: AssetsPolicy;
  exits: ExitsPolicy;
  concurrency: ConcurrencyPolicy;
  circuitBreaker: CircuitBreakerPolicy;
  /**
   * Prediction-market limits. Absent in a policy that predates this feature,
   * in which case prediction instruments are refused outright by the engine
   * rather than evaluated against limits that do not exist.
   */
  prediction?: PredictionPolicy;
  /** Absolute path this policy was loaded from. */
  sourcePath: string;
}

export class PolicyConfigError extends BigPickleError {
  constructor(message: string) {
    super("POLICY_CONFIG", message);
  }
}

// --- primitive validators. Each throws rather than defaulting. --------------

function req(obj: Record<string, unknown>, key: string, where: string): unknown {
  const v = obj[key];
  if (v === undefined || v === null) {
    throw new PolicyConfigError(`missing required field ${where}.${key}`);
  }
  return v;
}

function reqInt(o: Record<string, unknown>, key: string, where: string): number {
  const v = req(o, key, where);
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new PolicyConfigError(`${where}.${key} must be an integer, got ${JSON.stringify(v)}`);
  }
  return v;
}

function reqBool(o: Record<string, unknown>, key: string, where: string): boolean {
  const v = req(o, key, where);
  if (typeof v !== "boolean") {
    throw new PolicyConfigError(`${where}.${key} must be a boolean, got ${JSON.stringify(v)}`);
  }
  return v;
}

function reqStr(o: Record<string, unknown>, key: string, where: string): string {
  const v = req(o, key, where);
  if (typeof v !== "string" || v.length === 0) {
    throw new PolicyConfigError(`${where}.${key} must be a non-empty string`);
  }
  return v;
}

/** Bigint from a decimal string. Rejects floats and negatives. */
function reqBigIntStr(o: Record<string, unknown>, key: string, where: string): bigint {
  const s = reqStr(o, key, where);
  if (!/^\d+$/.test(s)) {
    throw new PolicyConfigError(
      `${where}.${key} must be a non-negative integer decimal string (no sign, no exponent), got ${JSON.stringify(s)}`,
    );
  }
  return BigInt(s);
}

/** A 1..10000 basis-point value. */
function reqBps(o: Record<string, unknown>, key: string, where: string, max = 10_000): number {
  const v = reqInt(o, key, where);
  if (v < 0 || v > max) {
    throw new PolicyConfigError(`${where}.${key} must be between 0 and ${max}, got ${v}`);
  }
  return v;
}

function reqBpsRange(o: Record<string, unknown>, key: string, where: string): BpsRange {
  const r = req(o, key, where) as Record<string, unknown>;
  if (typeof r !== "object" || r === null) {
    throw new PolicyConfigError(`${where}.${key} must be an object with min and max`);
  }
  const min = reqBps(r, "min", `${where}.${key}`);
  const max = reqBps(r, "max", `${where}.${key}`);
  if (min > max) {
    throw new PolicyConfigError(`${where}.${key}.min (${min}) must be <= max (${max})`);
  }
  return { min, max };
}

function reqStrArray(o: Record<string, unknown>, key: string, where: string): string[] {
  const v = req(o, key, where);
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new PolicyConfigError(`${where}.${key} must be an array of strings`);
  }
  return v as string[];
}

function reqIntArray(o: Record<string, unknown>, key: string, where: string): number[] {
  const v = req(o, key, where);
  if (!Array.isArray(v) || v.some((x) => !Number.isInteger(x))) {
    throw new PolicyConfigError(`${where}.${key} must be an array of integers`);
  }
  return v as number[];
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function reqAddressArray(o: Record<string, unknown>, key: string, where: string): string[] {
  const arr = reqStrArray(o, key, where);
  for (const a of arr) {
    if (!ADDRESS_RE.test(a)) {
      throw new PolicyConfigError(`${where}.${key} contains a non-address: ${a}`);
    }
  }
  // Normalise to lowercase for comparison. Address casing must never be a
  // bypass: 0xAbC... and 0xabc... are the same account.
  return arr.map((a) => a.toLowerCase());
}

// --- section parsers --------------------------------------------------------

function parseNetwork(raw: unknown): NetworkPolicy {
  const o = raw as Record<string, unknown>;
  if (typeof o !== "object" || o === null) throw new PolicyConfigError("network must be an object");
  const permitted = reqStrArray(o, "permitted", "network");
  if (permitted.length === 0) {
    throw new PolicyConfigError("network.permitted must list at least one network");
  }
  for (const n of permitted) {
    if (n !== "base" && n !== "base-sepolia") {
      throw new PolicyConfigError(
        `network.permitted contains unsupported network ${JSON.stringify(n)}; only "base" and "base-sepolia" are implemented`,
      );
    }
  }
  // Structural consistency: mainnet may not be permitted while disabled.
  const mainnetEnabled = reqBool(o, "mainnetEnabled", "network");
  if (permitted.includes("base") && !mainnetEnabled) {
    throw new PolicyConfigError(
      "network.permitted includes mainnet (\"base\") but network.mainnetEnabled is false. Refusing to load: an inconsistent policy is how a testnet policy silently becomes a mainnet policy.",
    );
  }
  return { permitted, mainnetEnabled };
}

function parseCapital(raw: unknown): CapitalPolicy {
  const o = raw as Record<string, unknown>;
  if (typeof o !== "object" || o === null) throw new PolicyConfigError("capital must be an object");
  const p: CapitalPolicy = {
    targetDeploymentBps: reqBpsRange(o, "targetDeploymentBps", "capital"),
    defaultPositionBps: reqBpsRange(o, "defaultPositionBps", "capital"),
    maxPositionBps: reqBps(o, "maxPositionBps", "capital"),
    maxConcurrentPositions: reqInt(o, "maxConcurrentPositions", "capital"),
    gasReserveWei: reqBigIntStr(o, "gasReserveWei", "capital"),
    minDeployableUsdcMicros: reqBigIntStr(o, "minDeployableUsdcMicros", "capital"),
  };
  if (p.maxConcurrentPositions < 1) {
    throw new PolicyConfigError("capital.maxConcurrentPositions must be at least 1");
  }
  if (p.defaultPositionBps.max > p.maxPositionBps) {
    throw new PolicyConfigError(
      `capital.defaultPositionBps.max (${p.defaultPositionBps.max}) exceeds capital.maxPositionBps (${p.maxPositionBps})`,
    );
  }
  return p;
}

function parseRisk(raw: unknown): RiskPolicy {
  const o = raw as Record<string, unknown>;
  if (typeof o !== "object" || o === null) throw new PolicyConfigError("risk must be an object");
  const response = reqStr(o, "dailyLossResponse", "risk");
  if (response !== "de-risk" && response !== "halt") {
    throw new PolicyConfigError(
      `risk.dailyLossResponse must be "de-risk" or "halt", got ${JSON.stringify(response)}`,
    );
  }
  const p: RiskPolicy = {
    maxDailyDrawdownBps: reqBps(o, "maxDailyDrawdownBps", "risk"),
    maxSingleTradeBps: reqBps(o, "maxSingleTradeBps", "risk"),
    maxDailyDeployBps: reqBps(o, "maxDailyDeployBps", "risk"),
    maxOpenExposureBps: reqBps(o, "maxOpenExposureBps", "risk"),
    consecutiveMaterialLossTrigger: reqInt(o, "consecutiveMaterialLossTrigger", "risk"),
    materialLossBpsOfPortfolio: reqBps(o, "materialLossBpsOfPortfolio", "risk"),
    cooldownMs: reqInt(o, "cooldownMs", "risk"),
    dailyLossResponse: response,
  };
  if (p.consecutiveMaterialLossTrigger < 1) {
    throw new PolicyConfigError("risk.consecutiveMaterialLossTrigger must be at least 1");
  }
  if (p.cooldownMs < 0) throw new PolicyConfigError("risk.cooldownMs must be non-negative");
  if (p.maxSingleTradeBps > p.maxOpenExposureBps) {
    throw new PolicyConfigError(
      `risk.maxSingleTradeBps (${p.maxSingleTradeBps}) exceeds risk.maxOpenExposureBps (${p.maxOpenExposureBps})`,
    );
  }
  return p;
}

function parseExecution(raw: unknown): ExecutionPolicy {
  const o = raw as Record<string, unknown>;
  if (typeof o !== "object" || o === null) throw new PolicyConfigError("execution must be an object");
  const p: ExecutionPolicy = {
    maxSlippageBps: reqBps(o, "maxSlippageBps", "execution"),
    maxPriceImpactBps: reqBps(o, "maxPriceImpactBps", "execution"),
    minExpectedEdgeBps: reqBps(o, "minExpectedEdgeBps", "execution", 100_000),
    assumedFeeBps: reqBps(o, "assumedFeeBps", "execution", 100_000),
    maxGasWei: reqBigIntStr(o, "maxGasWei", "execution"),
    requireInvalidation: reqBool(o, "requireInvalidation", "execution"),
    forbidAveragingDown: reqBool(o, "forbidAveragingDown", "execution"),
    requirePositiveEdgeAfterCosts: reqBool(o, "requirePositiveEdgeAfterCosts", "execution"),
    maxOpenOrdersInFlight: reqInt(o, "maxOpenOrdersInFlight", "execution"),
    minNotionalUsdcMicros: reqBigIntStr(o, "minNotionalUsdcMicros", "execution"),
  };
  if (p.maxOpenOrdersInFlight < 1) {
    throw new PolicyConfigError(
      "execution.maxOpenOrdersInFlight must be at least 1. Concurrent signings from one account race the nonce and one order silently replaces the other.",
    );
  }
  // If positive edge is required, the minimum must be strictly positive. Zero
  // would admit a trade that merely breaks even, which pays fees to do nothing.
  if (p.requirePositiveEdgeAfterCosts && p.minExpectedEdgeBps === 0) {
    throw new PolicyConfigError(
      "execution.requirePositiveEdgeAfterCosts is true but execution.minExpectedEdgeBps is 0, which admits break-even trades that pay fees for nothing",
    );
  }
  return p;
}

function parseAssets(raw: unknown): AssetsPolicy {
  const o = raw as Record<string, unknown>;
  if (typeof o !== "object" || o === null) throw new PolicyConfigError("assets must be an object");
  return {
    allowSmallCaps: reqBool(o, "allowSmallCaps", "assets"),
    minLiquidityUsd: reqBigIntStr(o, "minLiquidityUsd", "assets"),
    minVolume24hUsd: reqBigIntStr(o, "minVolume24hUsd", "assets"),
    allowlist: reqAddressArray(o, "allowlist", "assets"),
    denylist: reqAddressArray(o, "denylist", "assets"),
    rejectIfNoVerifiedSource: reqBool(o, "rejectIfNoVerifiedSource", "assets"),
    rejectIfHoneypotSuspected: reqBool(o, "rejectIfHoneypotSuspected", "assets"),
    rejectIfTransferSimulated: reqBool(o, "rejectIfTransferSimulated", "assets"),
    maxTopHolderConcentrationBps: reqBps(o, "maxTopHolderConcentrationBps", "assets"),
  };
}

function parseExits(raw: unknown): ExitsPolicy {
  const o = raw as Record<string, unknown>;
  if (typeof o !== "object" || o === null) throw new PolicyConfigError("exits must be an object");
  const p: ExitsPolicy = {
    allowTrailingStops: reqBool(o, "allowTrailingStops", "exits"),
    trailingStopBps: reqBps(o, "trailingStopBps", "exits"),
    allowPartialProfits: reqBool(o, "allowPartialProfits", "exits"),
    partialProfitAtBps: reqIntArray(o, "partialProfitAtBps", "exits"),
    partialProfitSizeBps: reqBps(o, "partialProfitSizeBps", "exits"),
    forceExitOnInvalidationBreach: reqBool(o, "forceExitOnInvalidationBreach", "exits"),
    allowDiscretionaryEarlyExit: reqBool(o, "allowDiscretionaryEarlyExit", "exits"),
  };
  for (const b of p.partialProfitAtBps) {
    if (b < 0 || b > 100_000) {
      throw new PolicyConfigError(`exits.partialProfitAtBps values must be 0..100000, got ${b}`);
    }
  }
  if (p.partialProfitAtBps.length > 0) p.partialProfitAtBps.sort((a, b) => a - b);
  if (p.allowPartialProfits && p.partialProfitSizeBps === 0) {
    throw new PolicyConfigError("exits.allowPartialProfits is true but exits.partialProfitSizeBps is 0");
  }
  return p;
}

function parseConcurrency(raw: unknown): ConcurrencyPolicy {
  const o = raw as Record<string, unknown>;
  if (typeof o !== "object" || o === null) throw new PolicyConfigError("concurrency must be an object");
  return {
    maxCorrelationBetweenOpenPositions: reqBps(o, "maxCorrelationBetweenOpenPositions", "concurrency"),
    enforceCorrelationLimit: reqBool(o, "enforceCorrelationLimit", "concurrency"),
  };
}

function parseCircuitBreaker(raw: unknown): CircuitBreakerPolicy {
  const o = raw as Record<string, unknown>;
  if (typeof o !== "object" || o === null) {
    throw new PolicyConfigError("circuitBreaker must be an object");
  }
  const p: CircuitBreakerPolicy = {
    enabled: reqBool(o, "enabled", "circuitBreaker"),
    tripOnAttestationFailure: reqBool(o, "tripOnAttestationFailure", "circuitBreaker"),
    tripOnBalanceMismatch: reqBool(o, "tripOnBalanceMismatch", "circuitBreaker"),
    tripOnPositionBookDrift: reqBool(o, "tripOnPositionBookDrift", "circuitBreaker"),
    tripOnRepeatedReverts: reqBool(o, "tripOnRepeatedReverts", "circuitBreaker"),
    tripOnRpcInconsistency: reqBool(o, "tripOnRpcInconsistency", "circuitBreaker"),
    tripOnGasPriceSpike: reqBool(o, "tripOnGasPriceSpike", "circuitBreaker"),
    tripOnPolicyError: reqBool(o, "tripOnPolicyError", "circuitBreaker"),
    maxConsecutiveReverts: reqInt(o, "maxConsecutiveReverts", "circuitBreaker"),
    positionBookDriftToleranceBps: reqBps(o, "positionBookDriftToleranceBps", "circuitBreaker"),
  };
  if (p.maxConsecutiveReverts < 1) {
    throw new PolicyConfigError("circuitBreaker.maxConsecutiveReverts must be at least 1");
  }
  return p;
}

// --- entry point ------------------------------------------------------------

function parsePrediction(raw: unknown): PredictionPolicy {
  const o = raw as Record<string, unknown>;
  if (typeof o !== "object" || o === null || Array.isArray(o)) {
    throw new PolicyConfigError("prediction must be an object");
  }
  const feesRaw = req(o, "fees", "prediction") as Record<string, unknown>;
  if (typeof feesRaw !== "object" || feesRaw === null || Array.isArray(feesRaw)) {
    throw new PolicyConfigError("prediction.fees must be an object");
  }
  const p: PredictionPolicy = {
    enabled: reqBool(o, "enabled", "prediction"),
    minTopOfBookLiquidityUsdcMicros: reqBigIntStr(o, "minTopOfBookLiquidityUsdcMicros", "prediction"),
    minVolume24hUsdcMicros: reqBigIntStr(o, "minVolume24hUsdcMicros", "prediction"),
    maxSpreadBps: reqBps(o, "maxSpreadBps", "prediction"),
    minNetEdgeBps: reqBps(o, "minNetEdgeBps", "prediction", 100_000),
    safetyMarginBps: reqBps(o, "safetyMarginBps", "prediction"),
    maxDataAgeMs: reqInt(o, "maxDataAgeMs", "prediction"),
    minMsToResolution: reqInt(o, "minMsToResolution", "prediction"),
    maxSingleContractLossBps: reqBps(o, "maxSingleContractLossBps", "prediction"),
    maxPositionBps: reqBps(o, "maxPositionBps", "prediction"),
    maxOpenExposureBps: reqBps(o, "maxOpenExposureBps", "prediction"),
    maxConcurrentPositions: reqInt(o, "maxConcurrentPositions", "prediction"),
    maxCategoryExposureBps: reqBps(o, "maxCategoryExposureBps", "prediction"),
    maxCorrelationGroupExposureBps: reqBps(o, "maxCorrelationGroupExposureBps", "prediction"),
    maxCorrelationBps: reqBps(o, "maxCorrelationBps", "prediction"),
    minConfidence: reqInt(o, "minConfidence", "prediction"),
    minContractsAtomic: reqBigIntStr(o, "minContractsAtomic", "prediction"),
    maxContractsAtomic: reqBigIntStr(o, "maxContractsAtomic", "prediction"),
    kellyFractionBps: reqInt(o, "kellyFractionBps", "prediction"),
    allowMaker: reqBool(o, "allowMaker", "prediction"),
    allowTaker: reqBool(o, "allowTaker", "prediction"),
    fees: {
      takerFeeBps: reqBps(feesRaw, "takerFeeBps", "prediction.fees", 100_000),
      makerFeeBps: reqBps(feesRaw, "makerFeeBps", "prediction.fees", 100_000),
      flatFeeMicrosPerContract: reqBigIntStr(feesRaw, "flatFeeMicrosPerContract", "prediction.fees"),
    },
  };

  if (p.maxDataAgeMs < 0) throw new PolicyConfigError("prediction.maxDataAgeMs must be non-negative");
  if (p.minMsToResolution < 0) throw new PolicyConfigError("prediction.minMsToResolution must be non-negative");
  if (p.minConfidence < 0 || p.minConfidence > 100) {
    throw new PolicyConfigError(`prediction.minConfidence must be 0..100, got ${p.minConfidence}`);
  }
  if (p.maxConcurrentPositions < 1) {
    throw new PolicyConfigError("prediction.maxConcurrentPositions must be at least 1");
  }
  if (p.kellyFractionBps < 0 || p.kellyFractionBps > 10_000) {
    throw new PolicyConfigError(
      `prediction.kellyFractionBps must be 0..10000 (full Kelly to zero), got ${p.kellyFractionBps}`,
    );
  }
  if (!p.allowMaker && !p.allowTaker) {
    throw new PolicyConfigError(
      "prediction.allowMaker and prediction.allowTaker are both false: prediction instruments would be untradeable",
    );
  }
  if (p.minContractsAtomic <= 0n) {
    throw new PolicyConfigError("prediction.minContractsAtomic must be at least 1 atomic unit");
  }
  if (p.maxContractsAtomic < p.minContractsAtomic) {
    throw new PolicyConfigError(
      `prediction.maxContractsAtomic (${p.maxContractsAtomic}) is below prediction.minContractsAtomic (${p.minContractsAtomic})`,
    );
  }
  if (p.minNetEdgeBps === 0 && p.safetyMarginBps === 0) {
    throw new PolicyConfigError(
      "prediction.minNetEdgeBps is 0 and prediction.safetyMarginBps is 0: a zero-edge candidate could be traded, " +
        "paying fees to do nothing",
    );
  }
  if (p.maxPositionBps > p.maxOpenExposureBps) {
    throw new PolicyConfigError(
      `prediction.maxPositionBps (${p.maxPositionBps}) exceeds prediction.maxOpenExposureBps (${p.maxOpenExposureBps}); ` +
        "a single position could be larger than the whole book",
    );
  }
  if (p.maxCorrelationGroupExposureBps > p.maxOpenExposureBps) {
    throw new PolicyConfigError(
      `prediction.maxCorrelationGroupExposureBps (${p.maxCorrelationGroupExposureBps}) exceeds ` +
        `prediction.maxOpenExposureBps (${p.maxOpenExposureBps}); the group cap could never bind`,
    );
  }
  return p;
}

export function parsePolicy(raw: unknown, sourcePath: string): Policy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PolicyConfigError("policy file must contain a JSON object");
  }
  const o = raw as Record<string, unknown>;

  const policy: Policy = {
    profile: reqStr(o, "profile", "<root>"),
    version: reqInt(o, "version", "<root>"),
    network: parseNetwork(o["network"]),
    capital: parseCapital(o["capital"]),
    risk: parseRisk(o["risk"]),
    execution: parseExecution(o["execution"]),
    assets: parseAssets(o["assets"]),
    exits: parseExits(o["exits"]),
    concurrency: parseConcurrency(o["concurrency"]),
    circuitBreaker: parseCircuitBreaker(o["circuitBreaker"]),
    ...(o["prediction"] === undefined ? {} : { prediction: parsePrediction(o["prediction"]) }),
    sourcePath,
  };

  assertPolicyCoherence(policy);
  return policy;
}

/**
 * Cross-field checks that catch policies which are individually valid but
 * collectively incoherent. These are the mistakes that actually happen.
 */
function assertPolicyCoherence(p: Policy): void {
  if (p.capital.maxPositionBps > p.risk.maxSingleTradeBps) {
    throw new PolicyConfigError(
      `capital.maxPositionBps (${p.capital.maxPositionBps}) exceeds risk.maxSingleTradeBps (${p.risk.maxSingleTradeBps}); a position could be opened larger than a single trade is allowed`,
    );
  }

  if (p.capital.maxConcurrentPositions * p.capital.maxPositionBps < p.capital.targetDeploymentBps.min) {
    // Not fatal, and deliberately not thrown. The deployment band is advisory:
    // if only a few setups qualify, running under-deployed is a valid outcome,
    // and forcing deployment to hit a number is how a system opens bad trades.
    // The allocator surfaces the gap against target instead. See
    // docs/AGGRESSIVE-MODE.md 2.1.
  }

  // A basis-point position limit is relative to the live portfolio value, so it
  // cannot be compared to an absolute minimum notional at policy-load time.
  // The executor performs this check after deriving notional from the live
  // portfolio. The only statically invalid case is a zero maximum trade limit.
  if (p.execution.minNotionalUsdcMicros > 0n && p.risk.maxSingleTradeBps === 0) {
    throw new PolicyConfigError(
      `execution.minNotionalUsdcMicros (${p.execution.minNotionalUsdcMicros}) is non-zero but risk.maxSingleTradeBps is zero; every trade would be rejected as dust.`,
    );
  }

  if (p.execution.maxSlippageBps + p.execution.assumedFeeBps + p.execution.minExpectedEdgeBps > 100_000) {
    throw new PolicyConfigError("execution cost parameters are nonsensical (sum exceeds 100%)");
  }

  const assetOverlap = p.assets.allowlist.filter((a) => p.assets.denylist.includes(a));
  if (assetOverlap.length > 0) {
    throw new PolicyConfigError(
      `assets.allowlist and assets.denylist both contain: ${assetOverlap.join(", ")}. An address on both lists is ambiguous and is refused rather than silently resolved.`,
    );
  }

  // Prediction fee model versus the engine's edge arithmetic.
  //
  // `netEdgeBps()` in the engine subtracts `execution.assumedFeeBps`, the flat
  // assumption the existing crypto path was calibrated on. If a prediction fee
  // schedule came in below it, the engine's edge check would be *more*
  // permissive than the strategy that produced the proposal — the exact inversion
  // of what this layer exists to prevent. Refuse to load rather than clamp.
  const pr = p.prediction;
  if (pr?.enabled) {
    if (pr.fees.takerFeeBps < p.execution.assumedFeeBps) {
      throw new PolicyConfigError(
        `prediction.fees.takerFeeBps (${pr.fees.takerFeeBps}) is below execution.assumedFeeBps ` +
          `(${p.execution.assumedFeeBps}). The hard-limit engine would then net out a smaller fee than the ` +
          "strategy actually pays, which weakens an existing control. Refusing to load.",
      );
    }
    if (pr.maxSingleContractLossBps > p.risk.maxSingleTradeBps) {
      throw new PolicyConfigError(
        `prediction.maxSingleContractLossBps (${pr.maxSingleContractLossBps}) exceeds ` +
          `risk.maxSingleTradeBps (${p.risk.maxSingleTradeBps}); a contract could lose more than one trade is allowed to risk`,
      );
    }
    if (pr.minNetEdgeBps < p.execution.minExpectedEdgeBps) {
      throw new PolicyConfigError(
        `prediction.minNetEdgeBps (${pr.minNetEdgeBps}) is below execution.minExpectedEdgeBps ` +
          `(${p.execution.minExpectedEdgeBps}); the prediction edge gate would be looser than the existing one`,
      );
    }
  }
}

export function loadPolicy(path: string): Policy {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new PolicyConfigError(
      `policy file not found at ${abs}. Refusing to start with no policy rather than assuming permissive limits.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    throw new PolicyConfigError(`policy file ${abs} is not valid JSON: ${(err as Error).message}`);
  }
  return parsePolicy(parsed, abs);
}
