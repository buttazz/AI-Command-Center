/**
 * Shared types for the Big Pickle wallet control plane.
 *
 * Design rule enforced throughout: an LLM may only ever *author* a `TradeProposal`.
 * Nothing an LLM produces is ever passed to a signing function directly. Every
 * monetary quantity an LLM supplies is a bounded `number` in basis points; all
 * absolute amounts are derived here, in deterministic code, at execution time.
 */

export type NetworkId = "base-sepolia" | "base";

export type Hex = `0x${string}`;

/** USDC on Base has 6 decimals. All policy money is integer micro-USDC. */
export const USDC_DECIMALS = 6;

// ---------------------------------------------------------------------------
// Actor / role model
// ---------------------------------------------------------------------------

/**
 * The four LLM agents, plus the human owner and the deterministic services.
 *
 * `Principal` is the identity recorded in the audit log and is the only thing
 * that distinguishes "an agent asked" from "the owner asked". It is set by the
 * gateway from the presented token, never from model output.
 */
export type Role =
  | "scout"
  | "strategist"
  | "risk"
  | "big-pickle"
  | "owner"
  | "executor"
  | "monitor"
  | "system";

export interface Principal {
  role: Role;
  /** Stable per-caller id, e.g. `agent:scout` or `owner`. */
  id: string;
  /** True only for the human owner. Owner may exceed policy limits (not solvency). */
  isOwner: boolean;
}

export const AGENT_PRINCIPALS: Record<Exclude<Role, "owner" | "executor" | "monitor" | "system">, Principal> = {
  scout: { role: "scout", id: "agent:scout", isOwner: false },
  strategist: { role: "strategist", id: "agent:strategist", isOwner: false },
  risk: { role: "risk", id: "agent:risk", isOwner: false },
  "big-pickle": { role: "big-pickle", id: "agent:big-pickle", isOwner: false },
};

export const OWNER_PRINCIPAL: Principal = { role: "owner", id: "owner", isOwner: true };

// ---------------------------------------------------------------------------
// Scout -> Strategist
// ---------------------------------------------------------------------------

/**
 * A Scout candidate. Read-only output. Carries its evidence so the Strategist
 * and Risk can both audit *why* it was surfaced, and so a reviewer can check
 * whether the reasoning was sound after the fact.
 */
export interface TradeCandidate {
  id: string;
  asset: Hex;
  assetSymbol: string;
  side: "buy" | "sell";
  /** Rank 1 = most interesting. */
  rank: number;
  /** Bounded 0..100. Model-supplied, advisory only. */
  score: number;
  evidence: {
    price?: string;
    volume24h?: string;
    liquidityUsd?: string;
    momentum?: string;
    onchainSignal?: string;
    notes: string[];
  };
  observedAt: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Strategist -> Risk
// ---------------------------------------------------------------------------

export type TimeHorizon = "scalp" | "intraday" | "swing" | "position";

/**
 * A structured trade proposal.
 *
 * Note what is *absent*: there is no dollar amount and no token quantity. The
 * Strategist expresses size only as `sizeBps`, an integer in [1, 10000]. There
 * is therefore no representation of "all of it" or "unbounded" available to the
 * model. Notional is computed later from live portfolio value.
 */
export interface TradeProposal {
  id: string;
  candidateId: string;
  asset: Hex;
  assetSymbol: string;
  side: "buy" | "sell";
  /** 1..10000 basis points of deployable portfolio. Schema-capped. */
  sizeBps: number;
  thesis: string;
  entry: {
    /** Human/machine readable trigger description. */
    kind: "market" | "limit";
    price?: string;
  };
  /** Conditions that, if hit, void the trade. */
  invalidation: string[];
  exit: {
    kind: "target" | "stop" | "time" | "condition";
    price?: string;
    note: string;
  };
  expectedRiskReward: number;
  /** 0..100, advisory. */
  confidence: number;
  horizon: TimeHorizon;
  createdBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Risk -> Big Pickle
// ---------------------------------------------------------------------------

export type RiskVerdict = "approve" | "veto";

/**
 * What Risk concluded, in structured form. `vetoReasons` must be non-empty when
 * the verdict is `veto`; this is validated before attestation is produced.
 */
export interface RiskAssessment {
  verdict: RiskVerdict;
  /** Populated when verdict is `veto`. */
  vetoReasons: string[];
  /** Risk's own view of a safe size, in bps. May be lower than proposed. */
  maxSizeBps: number;
  /** 0..100. Advisory. */
  confidence: number;
  notes: string[];
  findings: {
    liquidityOk: boolean;
    volatilityOk: boolean;
    concentrationOk: boolean;
    slippageOk: boolean;
    contractRiskOk: boolean;
    duplicateExposureOk: boolean;
    maxLossOk: boolean;
  };
}

/**
 * Cryptographic proof that Risk reviewed a specific proposal.
 *
 * The executor refuses to price or sign anything without a valid attestation
 * whose `proposalHash` matches the proposal it was handed. This is what makes
 * Risk's veto real rather than advisory: Big Pickle cannot manufacture one.
 */
export interface RiskAttestation {
  proposalId: string;
  /** SHA-256 (hex) of the canonical proposal JSON. */
  proposalHash: Hex;
  verdict: RiskVerdict;
  maxSizeBps: number;
  /** Ed25519 signature by the Risk attestation key. */
  signature: string;
  signerKeyId: string;
  issuedAt: string;
}

// ---------------------------------------------------------------------------
// Big Pickle -> Executor
// ---------------------------------------------------------------------------

/**
 * Big Pickle's allocation decision. This is the last thing an LLM produces.
 * It references a Risk-attested proposal; the executor independently re-verifies
 * the attestation and re-checks the hard limits.
 */
export interface AllocationDecision {
  id: string;
  proposalId: string;
  proposalHash: Hex;
  /** Final size in bps, at or below the Risk-approved cap. */
  sizeBps: number;
  /** Notional in micro-USDC, derived from live portfolio value by deterministic code. */
  notionalUsdcMicros: string;
  rationale: string;
  createdBy: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type ExecutionStatus =
  | "blocked"
  | "rejected-policy"
  | "pending-approval"
  | "approved"
  | "submitted"
  | "confirmed"
  | "failed"
  | "reconciled-away";

export interface ExecutionRecord {
  id: string;
  allocationId: string;
  proposalId: string;
  status: ExecutionStatus;
  /** Present when status is `blocked` or `rejected-policy`. */
  reasons: string[];
  /** Present once submitted. */
  txHash?: Hex;
  network: NetworkId;
  notionalUsdcMicros: string;
  requestedBy: string;
  decidedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A transaction awaiting a human decision. */
export interface PendingApproval {
  id: string;
  kind: "execution" | "policy-change" | "mainnet-enable" | "agent-enable";
  summary: string;
  detail: Record<string, unknown>;
  requestedBy: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "rejected" | "expired";
  resolvedBy?: string;
  resolvedAt?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Portfolio
// ---------------------------------------------------------------------------

export interface Position {
  asset: Hex;
  symbol: string;
  /** Cost basis in micro-USDC. */
  costBasisUsdcMicros: string;
  /** Current mark value in micro-USDC, as last reconciled. */
  markValueUsdcMicros: string;
  /** Balance in token atomic units, as last reconciled from chain. */
  balanceAtomic: string;
  openedAt: string;
  status: "open" | "closed";
}

export interface PortfolioSnapshot {
  network: NetworkId;
  address: Hex;
  /** Total portfolio value in micro-USDC. */
  totalValueUsdcMicros: string;
  /** USDC available to deploy, after reserves. */
  deployableUsdcMicros: string;
  /** ETH held, in wei, retained for gas. */
  gasReserveWei: string;
  positions: Position[];
  reconciledAt: string;
  /** True when internal state and on-chain state disagreed and self-healing occurred. */
  healed: boolean;
  healNotes: string[];
}
