import type { AgentState, Principal } from "./types.js";
import { canAgentTrade, ownerMayAct } from "./mode.js";
import { usdc } from "./money.js";
import type { Address } from "viem";

/**
 * Risk and spending limits.
 *
 * The owner sets these; the agent obeys them. Owner-initiated trades bypass the
 * *policy* gates (limits, allowlist, strategy toggles, rate caps) because the
 * owner is the authority, but never the *solvency* gates — you cannot spend
 * money the wallet does not have, whoever is asking.
 */

export interface OrderIntent {
  side: "buy" | "sell";
  /** Asset being sold. */
  tokenIn: Address;
  /** Asset being bought. */
  tokenOut: Address;
  /** USDC value at risk for this order, in plain decimal USDC. */
  notionalUsdc: string;
  /** True when the order increases exposure, false when it reduces it. */
  increasesExposure: boolean;
  strategy: string;
}

export interface Balances {
  /** Integer micro-USDC. */
  usdc: bigint;
  /** Wei. */
  eth: bigint;
  byToken: Record<Address, bigint>;
}

export interface PolicyVerdict {
  ok: boolean;
  reasons: string[];
}

function openExposureUsdc(state: AgentState): bigint {
  return state.positions
    .filter((p) => p.status === "open")
    .reduce((sum, p) => sum + usdc.parse(p.costBasisUsdc), 0n);
}

function tradesInLastHour(state: AgentState): number {
  const cutoff = Date.now() - 3_600_000;
  return state.recentTradeTimestamps.filter((t) => new Date(t).getTime() >= cutoff).length;
}

export function todaySpendUsdc(state: AgentState): bigint {
  const today = new Date().toISOString().slice(0, 10);
  return state.dailySpend.day === today ? usdc.parse(state.dailySpend.usdc) : 0n;
}

/**
 * Decide whether an order may proceed. Returns every violated rule, not just the
 * first, so the audit log explains the whole picture.
 */
export function checkOrder(state: AgentState, intent: OrderIntent, balances: Balances, by: Principal): PolicyVerdict {
  const reasons: string[] = [];
  const isOwner = by === "owner";

  // --- authority gates -------------------------------------------------
  if (isOwner) {
    // Deliberately no mode check. The owner is never blocked.
    void ownerMayAct(state);
  } else {
    if (!canAgentTrade(state)) {
      reasons.push(
        state.pendingReconcile
          ? `trading suspended: reconcile pending after owner intervention (mode=${state.mode})`
          : `trading suspended: mode=${state.mode}`,
      );
    }
  }

  let notional = 0n;
  try {
    notional = usdc.parse(intent.notionalUsdc);
  } catch (err) {
    return { ok: false, reasons: [`invalid notional: ${(err as Error).message}`] };
  }
  if (notional <= 0n) reasons.push("notional must be positive");

  // --- solvency gates (apply to everyone, including the owner) ---------
  if (intent.side === "buy") {
    const spendable = balances.usdc - usdc.parse(state.policy.reserveUsdc);
    if (notional > spendable) {
      reasons.push(
        `inspendable USDC: need ${intent.notionalUsdc}, have ${usdc.format(balances.usdc)} minus reserve ${state.policy.reserveUsdc}`,
      );
    }
  } else {
    const held = balances.byToken[intent.tokenIn.toLowerCase() as Address] ?? 0n;
    if (held <= 0n) {
      reasons.push(`no ${intent.tokenIn} balance to sell`);
    }
  }

  // Gas must remain for the wallet to be usable at all.
  const reserveEth = BigInt(state.policy.reserveEthWei);
  if (balances.eth < reserveEth) {
    reasons.push(`ETH below gas reserve: have ${balances.eth} wei, need ${reserveEth} wei`);
  }

  // --- policy gates (agent only) ---------------------------------------
  if (!isOwner) {
    const allowed = state.policy.allowedTokens.map((t) => t.toLowerCase());
    for (const token of [intent.tokenIn, intent.tokenOut]) {
      if (!allowed.includes(token.toLowerCase() as Address)) {
        reasons.push(`token not allowed by policy: ${token}`);
      }
    }

    if (!state.policy.enabledStrategies.includes(intent.strategy as never)) {
      reasons.push(`strategy disabled by owner: ${intent.strategy}`);
    }

    if (notional < usdc.parse(state.policy.minTradeUsdc)) {
      reasons.push(`below minTradeUsdc ${state.policy.minTradeUsdc}`);
    }
    if (notional > usdc.parse(state.policy.maxTradeUsdc)) {
      reasons.push(`above maxTradeUsdc ${state.policy.maxTradeUsdc}`);
    }

    if (intent.increasesExposure) {
      const exposure = openExposureUsdc(state) + notional;
      if (exposure > usdc.parse(state.policy.maxTotalExposureUsdc)) {
        reasons.push(
          `would exceed maxTotalExposureUsdc: ${usdc.format(exposure)} > ${state.policy.maxTotalExposureUsdc}`,
        );
      }
      const daily = todaySpendUsdc(state) + notional;
      if (daily > usdc.parse(state.policy.maxDailySpendUsdc)) {
        reasons.push(`would exceed maxDailySpendUsdc: ${usdc.format(daily)} > ${state.policy.maxDailySpendUsdc}`);
      }
    }

    if (tradesInLastHour(state) >= state.policy.maxTradesPerHour) {
      reasons.push(`rate limit: ${state.policy.maxTradesPerHour} trades/hour already used`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export function recordTrade(state: AgentState, notionalUsdc: string): void {
  const day = new Date().toISOString().slice(0, 10);
  const notional = usdc.parse(notionalUsdc);
  if (state.dailySpend.day !== day) {
    state.dailySpend = { day, usdc: "0", trades: 0 };
  }
  state.dailySpend.usdc = usdc.format(usdc.parse(state.dailySpend.usdc) + notional);
  state.dailySpend.trades += 1;
  state.recentTradeTimestamps = [...state.recentTradeTimestamps, new Date().toISOString()].slice(-200);
}

export { openExposureUsdc };
