import type { Address } from "viem";

/**
 * The four operating states from the operating model.
 *
 * Precedence, highest first: DISABLED > PAUSED > OWNER_OVERRIDE > AUTONOMOUS.
 * `effectiveCanTrade` is false unless the mode is exactly AUTONOMOUS, so the
 * precedence ordering above is enforced in one place rather than scattered.
 */
export type Mode = "AUTONOMOUS" | "OWNER_OVERRIDE" | "PAUSED" | "DISABLED";

/** Who requested a state change. Authority is derived from this, never from a flag. */
export type Principal = "owner" | "agent" | "system";

export type StrategyId = "spot-swap" | "rebalance";

export interface ModeChange {
  from: Mode;
  to: Mode;
  by: Principal;
  reason: string;
  at: string;
  /** Mode to return to when an owner override finishes, unless owner says otherwise. */
  resumeTo?: Mode;
}

export interface RiskPolicy {
  /** Max USDC value of a single agent-initiated buy. */
  maxTradeUsdc: string;
  /** Max USDC value the agent may commit across all open positions. */
  maxTotalExposureUsdc: string;
  /** Max agent spend within one UTC day, reset daily. */
  maxDailySpendUsdc: string;
  /** Minimum USDC value of any agent trade; below this, gas is wasted. */
  minTradeUsdc: string;
  /** Extra slippage tolerance on top of the quoted price, e.g. 0.005 = 0.5%. */
  slippageToleranceBps: number;
  /** Minimum USDC balance that must remain untouched for fees/gas. */
  reserveUsdc: string;
  /** Minimum ETH (wei) that must remain for gas. */
  reserveEthWei: string;
  /** Cap on how often the agent may trade, to damp runaway loops. */
  maxTradesPerHour: number;
  /** Tokens the agent may trade. Anything else is rejected. */
  allowedTokens: Address[];
  /** Strategies the owner has left enabled. */
  enabledStrategies: StrategyId[];
}

export interface Position {
  id: string;
  token: Address;
  symbol: string;
  /** Cost basis in USDC at open, as a decimal string. */
  costBasisUsdc: string;
  /** Token amount held for this position, raw units as string. */
  amount: string;
  decimals: number;
  openedAt: string;
  /** "agent" or "owner" — owner-opened positions are never auto-closed. */
  openedBy: Principal;
  status: "open" | "closed";
  closedAt?: string;
  closedBy?: Principal;
  realizedPnlUsdc?: string;
}

export interface DailySpend {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  usdc: string;
  trades: number;
}

export interface AgentState {
  version: 1;
  mode: Mode;
  modeChangedAt: string;
  modeChangedBy: Principal;
  modeReason: string;
  /** Mode to restore when an owner override completes. */
  resumeTo: Mode;
  /**
   * True once the owner has touched the system and a reconcile is owed.
   * While true the agent cannot trade, even if mode is AUTONOMOUS.
   */
  pendingReconcile: boolean;
  /** Bumped on every state mutation. Agent plans carry the hash they were built under. */
  revision: number;
  policy: RiskPolicy;
  positions: Position[];
  dailySpend: DailySpend;
  recentTradeTimestamps: string[];
  /** Highest nonce we have sent, so we never reuse one after a restore. */
  lastSentNonce: number;
  lastReconciledBlock: bigint;
  noncesAtReconcile: bigint | null;
  pendingTxs: string[];
  ownerAddress: Address | null;
  agentAddress: Address | null;
}

export type AuditEvent =
  | { kind: "mode.change"; modeChange: ModeChange; revision: number }
  | { kind: "policy.change"; before: RiskPolicy; after: RiskPolicy; by: Principal; reason: string }
  | { kind: "decision"; decision: string; inputs: Record<string, unknown>; by: Principal; at: string }
  | { kind: "order.rejected"; intent: Record<string, unknown>; reasons: string[]; by: Principal; at: string }
  | { kind: "order.submitted"; intent: Record<string, unknown>; txHash: string; by: Principal; at: string }
  | { kind: "order.confirmed"; txHash: string; blockNumber: bigint; gasUsed: bigint; effectivePrice: string | null }
  | { kind: "order.failed"; txHash: string | null; error: string; intent: Record<string, unknown> }
  | { kind: "reconcile.start"; reason: string; by: Principal; at: string }
  | { kind: "reconcile.done"; changes: string[]; at: string; balances: Record<string, string> }
  | { kind: "owner.command"; command: string; args: Record<string, unknown>; at: string }
  | { kind: "engine.tick"; at: string; note: string };

export interface Decision {
  action: "buy" | "sell" | "hold";
  /** Token to buy or sell. Ignored for hold. */
  token?: Address;
  /** USDC amount to spend (buy) or expect to receive (sell). */
  amountUsdc?: string;
  /** Free-form reasoning, captured in the audit log. */
  rationale: string;
}
