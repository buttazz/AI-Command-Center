/**
 * Fixed-point money helpers.
 *
 * USDC on Base has 6 decimals, so all USDC accounting in this system is done in
 * integer micro-USDC (bigint). Never use JS floats for balances: 0.1 + 0.2
 * problems in a trading bot become unaccounted-for dust that later blocks
 * reconciliation.
 */

const USDC_DECIMALS = 6;
const ETH_DECIMALS = 18;

export type DecimalString = string;

/** Parse a plain decimal string ("12.34") into integer units at `decimals`. Throws on garbage. */
export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`not a decimal number: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", frac = ""] = body.split(".");
  if (frac.length > decimals) {
    throw new Error(`too many decimal places for ${decimals}-decimal unit: ${value}`);
  }
  const padded = frac.padEnd(decimals, "0");
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === "" ? "0" : padded);
  return negative ? -units : units;
}

export function formatUnits(value: bigint, decimals: number): DecimalString {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${fracStr ? `.${fracStr}` : ""}`;
}

export const usdc = {
  decimals: USDC_DECIMALS,
  parse: (v: DecimalString) => parseUnits(v, USDC_DECIMALS),
  format: (u: bigint) => formatUnits(u, USDC_DECIMALS),
};

export const eth = {
  decimals: ETH_DECIMALS,
  parse: (v: DecimalString) => parseUnits(v, ETH_DECIMALS),
  format: (w: bigint) => formatUnits(w, ETH_DECIMALS),
};

/** Multiply by an integer amount, then divide by a denominator, keeping integers. */
export function mulDiv(value: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("mulDiv: division by zero");
  return (value * numerator) / denominator;
}

/** Apply a bps tolerance to a minimum amount: floor(minOut * (10000 - bps) / 10000). */
export function applySlippage(minOut: bigint, bps: number): bigint {
  return (minOut * BigInt(10_000 - bps)) / 10_000n;
}

export function usdcPerEth(usdcAmount: bigint, ethAmount: bigint): DecimalString {
  if (ethAmount === 0n) return "0";
  // usdcAmount is 6dp, ethAmount is 18dp -> ratio * 1e6
  return formatUnits((usdcAmount * 10n ** BigInt(ETH_DECIMALS)) / ethAmount, USDC_DECIMALS);
}
