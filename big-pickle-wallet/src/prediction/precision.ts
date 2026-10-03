/**
 * Integer arithmetic for prediction-market instruments.
 *
 * Everything a prediction market has to express is a rational number:
 *
 *   price          a probability in [0, 1] that also happens to be a price
 *   quantity       a count of contracts, and fills are routinely partial
 *   probability    an estimate, in [0, 1]
 *   edge           a return on cost, which is unbounded as the price goes to 0
 *
 * None of that is safe in floating point at the scale of a $50 bankroll, where
 * a single float rounding error is a measurable fraction of a position. So every
 * quantity here is a `bigint`:
 *
 *   price    micro-USDC per $1.00 of payout      0 .. 1_000_000
 *   quantity atomic contract units                1_000_000 atomic = 1 contract
 *   payout   exactly 1_000_000 micro-USDC ($1.00) for a winning contract
 *
 * Money that is actually *accounted* uses the existing `Money` abstraction from
 * src/core/money.ts, which is also micro-USDC. The two agree on scale, so a
 * `bigint` here converts to `Money.fromMicros` with no arithmetic.
 *
 * Rounding is uniformly pessimistic: costs round up, proceeds round down, and
 * reported edges round down. A simulation that rounds in its own favour is a
 * simulation that lies, and the whole purpose of this engine is to be believed.
 */

/** micro-USDC denominated in $1.00 of payout. A price of 620_000 is $0.62. */
export const PRICE_SCALE = 1_000_000n;

/** Atomic contract units per whole contract. Allows sub-contract partials. */
export const QTY_SCALE = 1_000_000n;

/** A winning contract pays exactly $1.00, in micro-USDC. */
export const PAYOUT_MICROS = PRICE_SCALE;

/** Basis-point denominator, matching src/core/money.ts. */
export const BPS_DENOM = 10_000n;

/** Probability expressed in basis points: 0..10_000 is 0%..100%. */
export type ProbabilityBps = number;

/**
 * Probability expressed in micro-USDC per $1.00 payout: 0..1_000_000.
 *
 * Same scale as a price, which is the point: in a prediction market a
 * probability *is* a price, so one integer type carries both and there is no
 * conversion step that could introduce a rounding error between "what I believe"
 * and "what the market pays".
 */
export type ProbabilityMicros = bigint;

// ---------------------------------------------------------------------------
// Division helpers
// ---------------------------------------------------------------------------

/** Floor division for non-negative operands. */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError(`floorDiv divisor must be positive, got ${b}`);
  return a / b;
}

/**
 * Ceiling division for non-negative operands — used for every cost we charge
 * ourselves, so the simulation never understates what a real venue would take.
 */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError(`ceilDiv divisor must be positive, got ${b}`);
  return (a + b - 1n) / b;
}

/** Clamp a bigint into an inclusive integer range. */
export function clampBigInt(value: bigint, min: bigint, max: bigint): bigint {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Clamp a probability-bps number into [0, 10_000], truncating fractions. */
export function clampBps(value: number): ProbabilityBps {
  if (!Number.isFinite(value)) return 0;
  const bounded = clampBigInt(BigInt(Math.round(value)), 0n, BPS_DENOM);
  return Number(bounded);
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/** Validate a price is inside the tradeable band. Throws rather than clamps. */
export function assertPrice(priceMicros: bigint, field = "price"): bigint {
  if (priceMicros <= 0n || priceMicros >= PRICE_SCALE) {
    throw new RangeError(
      `${field} must be strictly inside (0, $1.00): got ${priceMicros} of ${PRICE_SCALE}`,
    );
  }
  return priceMicros;
}

/** Price as a plain decimal fraction string, for display only. */
export function formatPrice(priceMicros: bigint): string {
  const whole = priceMicros / PRICE_SCALE;
  const frac = (priceMicros % PRICE_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

// ---------------------------------------------------------------------------
// Quantities and money
// ---------------------------------------------------------------------------

/** Atomic contract units as a whole-number string, for display. */
export function formatQty(qtyAtomic: bigint): string {
  const whole = qtyAtomic / QTY_SCALE;
  const frac = (qtyAtomic % QTY_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Cash required to *buy* `qtyAtomic` contracts at `priceMicros`.
 *
 * Rounds up: a real venue charges on the greater of the two, and rounding the
 * cost down would silently manufacture capital.
 */
export function buyCostMicros(qtyAtomic: bigint, priceMicros: bigint): bigint {
  if (qtyAtomic <= 0n) return 0n;
  return ceilDiv(qtyAtomic * priceMicros, QTY_SCALE);
}

/**
 * Cash returned for *selling* `qtyAtomic` contracts at `priceMicros`.
 *
 * Rounds down, for the same reason `buyCostMicros` rounds up.
 */
export function sellProceedsMicros(qtyAtomic: bigint, priceMicros: bigint): bigint {
  if (qtyAtomic <= 0n) return 0n;
  return floorDiv(qtyAtomic * priceMicros, QTY_SCALE);
}

/** Payout for a position that resolves in our favour, before fees. */
export function payoutMicros(qtyAtomic: bigint): bigint {
  if (qtyAtomic <= 0n) return 0n;
  return floorDiv(qtyAtomic * PAYOUT_MICROS, QTY_SCALE);
}

/**
 * Fee charged on a trade, in micro-USDC.
 *
 * Rounds up so a fee is never under-counted. `flatPerContractMicros` models the
 * per-contract schedules some venues use; it is charged in addition to the
 * proportional rate, never instead of it.
 */
export function feeMicros(notionalMicros: bigint, feeBps: number, flatPerContractMicros: bigint, qtyAtomic: bigint): bigint {
  const proportional = ceilDiv(notionalMicros * BigInt(Math.max(0, Math.trunc(feeBps))), BPS_DENOM);
  const flat = qtyAtomic > 0n ? floorDiv(qtyAtomic * flatPerContractMicros, QTY_SCALE) : 0n;
  return proportional + flat;
}

/** Cash actually leaving the account for a buy, fees included. */
export function buySpendMicros(notionalMicros: bigint, feeBps: number, flatPerContractMicros: bigint, qtyAtomic: bigint): bigint {
  return notionalMicros + feeMicros(notionalMicros, feeBps, flatPerContractMicros, qtyAtomic);
}

// ---------------------------------------------------------------------------
// Probabilities
// ---------------------------------------------------------------------------

/**
 * Market-implied probability, in basis points, from a price.
 *
 * Exact: a price is a probability, so this is a scale change, not an estimate.
 * 620_000 micros ($0.62) becomes 6_200 bps (62%).
 */
export function impliedProbabilityBps(priceMicros: bigint): ProbabilityBps {
  return Number(floorDiv(clampBigInt(priceMicros, 0n, PRICE_SCALE) * BPS_DENOM, PRICE_SCALE));
}

/** Price in micro-USDC that corresponds to a probability in basis points. */
export function priceFromProbabilityBps(bps: ProbabilityBps): bigint {
  return floorDiv(BigInt(clampBps(bps)) * PRICE_SCALE, BPS_DENOM);
}

/** A probability in basis points, on the same micro-USDC scale as a price. */
export function probabilityMicros(bps: ProbabilityBps): ProbabilityMicros {
  return floorDiv(BigInt(clampBps(bps)) * PRICE_SCALE, BPS_DENOM);
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

/**
 * Expected profit per contract, in micro-USDC, before any costs.
 *
 * For a contract bought at `entryPriceMicros` that pays `PAYOUT_MICROS` on a
 * correct outcome, the expected profit of one contract is
 * `q * payout − price`. `q` is the estimated true probability, converted from
 * bps into the same micro scale as the price so the subtraction is exact.
 */
export function expectedProfitMicrosPerContract(estimatedTrueBps: ProbabilityBps, entryPriceMicros: bigint): bigint {
  const payout = floorDiv(probabilityMicros(estimatedTrueBps) * PAYOUT_MICROS, PRICE_SCALE);
  return payout - entryPriceMicros;
}

/**
 * Expected return on cost, in basis points.
 *
 * Truncates toward zero, so a reported edge is never larger than the truth.
 * Undefined (returns `null`) at zero cost rather than dividing.
 */
export function returnOnCostBps(expectedProfitMicros: bigint, costMicros: bigint): number | null {
  if (costMicros <= 0n) return null;
  const v = expectedProfitMicros * BPS_DENOM;
  return Number(v >= 0n ? v / costMicros : -((-v) / costMicros));
}

/**
 * Probability-space edge, in basis points.
 *
 * `estimated true − market implied`. This is the raw disagreement between the
 * research model and the market, and on its own it is never a reason to trade:
 * it says nothing about whether the disagreement is large enough to survive
 * fees, spread, slippage and a safety margin. That is what `netEdgeBps` is for.
 */
export function probabilityEdgeBps(estimatedTrueBps: ProbabilityBps, impliedBps: ProbabilityBps): number {
  return clampBps(estimatedTrueBps) - clampBps(impliedBps);
}

/** Spread of a two-sided quote, in basis points of the midpoint. */
export function spreadBps(bestBid: bigint, bestAsk: bigint): number {
  if (bestBid <= 0n || bestAsk <= 0n) return Number(BPS_DENOM);
  const mid = (bestBid + bestAsk) / 2n;
  if (mid <= 0n) return Number(BPS_DENOM);
  return Number(floorDiv((bestAsk - bestBid) * BPS_DENOM, mid));
}

/** Midpoint of a two-sided quote, floored to the pessimistic side. */
export function midpointMicros(bestBid: bigint, bestAsk: bigint): bigint {
  return floorDiv(bestBid + bestAsk, 2n);
}