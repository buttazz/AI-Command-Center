/**
 * Integer money arithmetic.
 *
 * Every policy decision is made in integer micro-USDC (1 USDC = 1_000_000).
 * No float ever touches a limit check, a balance comparison, or an amount that
 * will be signed. Floating point is used in exactly one place, `formatBps`, and
 * only for human display.
 */

import { USDC_DECIMALS } from "../types.js";
import { SchemaError } from "../errors.js";

const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);

export class Money {
  /** Integer micro-USDC. */
  readonly micros: bigint;

  private constructor(micros: bigint) {
    this.micros = micros;
  }

  static zero(): Money {
    return new Money(0n);
  }

  static fromMicros(micros: bigint | string | number): Money {
    const v = typeof micros === "bigint" ? micros : BigInt(micros);
    return new Money(v);
  }

  /**
   * Parse a plain decimal USDC string such as "12.5" or "0.000001".
   * Rejects exponent notation and anything non-numeric — an LLM emitting
   * "1e18" is a bug we want to surface, not silently reinterpret.
   */
  static parseUsdc(input: string): Money {
    const s = input.trim();
    if (!/^\d+(\.\d+)?$/.test(s)) {
      throw new SchemaError("amount", `not a plain decimal USDC value: ${JSON.stringify(input)}`);
    }
    const [whole = "0", frac = ""] = s.split(".");
    if (frac.length > USDC_DECIMALS) {
      throw new SchemaError(
        "amount",
        `more than ${USDC_DECIMALS} decimal places would lose precision: ${JSON.stringify(input)}`,
      );
    }
    const padded = frac.padEnd(USDC_DECIMALS, "0");
    return new Money(BigInt(whole) * USDC_SCALE + BigInt(padded || "0"));
  }

  /** Parse a wei-denominated native amount. */
  static fromWei(wei: bigint): Money {
    return new Money(wei);
  }

  /** Exact basis-point portion of this amount, floored. */
  bps(basisPoints: number): Money {
    return new Money((this.micros * BigInt(Math.trunc(basisPoints))) / 10_000n);
  }

  add(other: Money): Money {
    return new Money(this.micros + other.micros);
  }

  sub(other: Money): Money {
    return new Money(this.micros - other.micros);
  }

  /** Absolute value. */
  abs(): Money {
    return new Money(this.micros < 0n ? -this.micros : this.micros);
  }

  /** Positive percentage change from `base` to this, in bps. Undefined for base 0. */
  changeBps(base: Money): number | null {
    if (base.micros === 0n) return null;
    return Number(((this.micros - base.micros) * 10_000n) / base.micros);
  }

  min(other: Money): Money {
    return this.micros <= other.micros ? this : other;
  }

  max(other: Money): Money {
    return this.micros >= other.micros ? this : other;
  }

  isZero(): boolean {
    return this.micros === 0n;
  }

  isPositive(): boolean {
    return this.micros > 0n;
  }

  gt(other: Money): boolean {
    return this.micros > other.micros;
  }

  gte(other: Money): boolean {
    return this.micros >= other.micros;
  }

  lt(other: Money): boolean {
    return this.micros < other.micros;
  }

  lte(other: Money): boolean {
    return this.micros <= other.micros;
  }

  eq(other: Money): boolean {
    return this.micros === other.micros;
  }

  /** Sum a list of amounts. */
  static sum(items: readonly Money[]): Money {
    return items.reduce((acc, m) => acc.add(m), Money.zero());
  }

  /** Human-readable USDC, trimmed of trailing zeros. Never used in a limit check. */
  format(): string {
    const whole = this.micros / USDC_SCALE;
    const frac = (this.micros % USDC_SCALE).toString().padStart(USDC_DECIMALS, "0");
    return `${whole}.${frac.replace(/0+$/, "")}`;
  }

  toString(): string {
    return `${this.format()} USDC`;
  }

  toJSON(): { micros: string; usdc: string } {
    return { micros: this.micros.toString(), usdc: this.format() };
  }
}

/** Clamp a number into an inclusive integer range, or throw. */
export function clampInt(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SchemaError(field, `expected a finite number, got ${JSON.stringify(value)}`);
  }
  const i = Math.trunc(value);
  if (i < min || i > max) {
    throw new SchemaError(field, `must be between ${min} and ${max}, got ${i}`);
  }
  return i;
}

/** Format wei as ETH for display only. */
export function formatWei(wei: bigint): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
