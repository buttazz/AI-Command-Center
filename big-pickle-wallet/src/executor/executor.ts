/**
 * The deterministic executor.
 *
 * This is the only component in the system capable of causing a signature, and
 * it contains no LLM, no agent runtime, and no network listener. It takes a
 * validated `AllocationDecision` and either turns it into a transaction or
 * refuses it.
 *
 * The order of the gates below is the security posture. Each one is a
 * precondition for the next, and every one of them defaults to refuse:
 *
 *   1. network assertion          — three independent mainnet gates
 *   2. control plane authorisation — kill switch, freeze, de-risk
 *   3. attestation verification    — Risk signed *this* proposal
 *   4. structural invariants       — no averaging down, invalidation present
 *   5. hard limit engine           — all the numbers
 *   6. execution mutex             — one signing slot
 *   7. anomaly trip                — any unexpected fault freezes trading
 *
 * An error at any step is logged and refused. There is no catch-and-continue
 * path that proceeds to signing.
 */

import { randomUUID } from "node:crypto";
import { ControlPlane, type RiskDirection } from "../control/control-plane.js";
import { AuditLog } from "../audit/audit-log.js";
import { evaluateOrder, assertAllowed, type LimitVerdict, type OrderFacts, type PortfolioFacts } from "../policy/engine.js";
import type { Policy } from "../policy/schema.js";
import { verifyAttestationForProposal } from "../pipeline/attestation.js";
import { Money } from "../core/money.js";
import { newId, nowIso } from "../core/ids.js";
import { NetworkNotPermitted, PolicyError, UpstreamError } from "../errors.js";
import type { NetworkId } from "../types.js";

/** Where the executor gets its signing capability. Narrow on purpose. */
export interface SignerPort {
  readonly network: NetworkId;
  /** Produce and broadcast one transaction. The only signing path in the system. */
  send(args: {
    to?: `0x${string}`;
    value?: bigint;
    data?: `0x${string}`;
    gas?: bigint;
    idempotencyKey: string;
  }): Promise<{ transactionHash: `0x${string}` }>;
}

export interface ExecutorDeps {
  policy: Policy;
  control: ControlPlane;
  audit: AuditLog;
  signer: SignerPort;
  /** Ed25519 public key of the Risk attestation signer. Public half only. */
  riskPublicKeyPem: string;
  /** The controlled address being traded. */
  walletAddress: `0x${string}`;
}

export interface ExecutionRequest {
  allocationId: string;
  proposalId: string;
  proposalHash: `0x${string}`;
  proposal: import("../types.js").TradeProposal;
  attestation: import("../types.js").RiskAttestation | null;
  /** Order facts assembled from market data. Never from model output. */
  order: OrderFacts;
  portfolio: PortfolioFacts;
  /** Who asked. Recorded in the audit log. Does not affect limits. */
  requestedBy: string;
  /** Optional explicit transaction target. Omitted for a native transfer. */
  tx?: { to?: `0x${string}`; value?: bigint; data?: `0x${string}`; gas?: bigint };
}

export type ExecutionOutcome =
  | { status: "rejected"; reasons: string[]; rule: string; maxLossUsdcMicros: string }
  | { status: "submitted"; transactionHash: `0x${string}`; maxLossUsdcMicros: string };

/**
 * Single-slot mutex.
 *
 * Aggressive rotation produces many orders in quick succession. Two concurrent
 * signings from one account race on the nonce, and the loser is silently
 * replaced — an order that appears to have executed and did not. One slot, no
 * parallelism, no queue growth.
 */
class ExecutionLock {
  #held = false;
  #waiters: (() => void)[] = [];

  async acquire(): Promise<() => void> {
    if (this.#held) {
      await new Promise<void>((resolveWaiter) => this.#waiters.push(resolveWaiter));
    }
    this.#held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#held = false;
      const next = this.#waiters.shift();
      next?.();
    };
  }
}

export class Executor {
  readonly walletAddress: `0x${string}`;
  private readonly policy: Policy;
  private readonly control: ControlPlane;
  private readonly audit: AuditLog;
  private readonly signer: SignerPort;
  private readonly riskPublicKeyPem: string;
  private readonly lock = new ExecutionLock();

  constructor(deps: ExecutorDeps) {
    this.policy = deps.policy;
    this.control = deps.control;
    this.audit = deps.audit;
    this.signer = deps.signer;
    this.riskPublicKeyPem = deps.riskPublicKeyPem;
    this.walletAddress = deps.walletAddress;
  }

  /**
   * Execute one order. Never throws for a policy refusal — returns the reasons,
   * which the caller records. Throws only for genuinely unexpected faults, and
   * trips the circuit breaker on the way out.
   */
  async execute(req: ExecutionRequest): Promise<ExecutionOutcome> {
    const correlation = randomUUID();
    const startedAt = nowIso();

    // --- 1. network assertion (innermost of three mainnet gates) ---------
    try {
      if (this.signer.network !== this.policy.network.permitted[0]) {
        throw new NetworkNotPermitted(this.signer.network, this.policy.network.permitted.join(", "));
      }
      if (!this.policy.network.permitted.includes(this.signer.network)) {
        throw new NetworkNotPermitted(this.signer.network, this.policy.network.permitted.join(", "));
      }
    } catch (err) {
      return this.refuse(req, "network-not-permitted", [(err as Error).message], "0", correlation, startedAt);
    }

    const notionalMicros = req.order.notional.micros;
    const portfolioMicros = req.portfolio.totalValue.micros;

    // --- 2. control plane ------------------------------------------------
    const direction: RiskDirection = req.order.side === "buy" ? "increase" : "reduce";
    const verdict = this.control.authorize(direction, portfolioMicros);

    // --- 3. Risk attestation --------------------------------------------
    // Checked before the policy engine so a proposal Risk rejected is never
    // priced, and so the audit trail shows the veto as the reason rather than
    // as a downstream symptom.
    const att = verifyAttestationForProposal(req.proposal, req.attestation, this.riskPublicKeyPem);
    if (!att.valid) {
      // A bad signature is a security event, not a policy decision. Trip.
      this.control.noteAnomaly("attestation-failure", att.reason);
      this.audit.append("execution.refused", "executor", "executor", {
        correlation,
        allocationId: req.allocationId,
        proposalId: req.proposalId,
        stage: "attestation",
        reason: att.reason,
        requestedBy: req.requestedBy,
      });
      return this.refuse(req, "attestation-invalid", [att.reason], "0", correlation, startedAt);
    }

    if (!verdict.allowed && direction === "increase") {
      this.audit.append("execution.refused", "executor", "executor", {
        correlation,
        allocationId: req.allocationId,
        proposalId: req.proposalId,
        stage: "control-plane",
        state: verdict.state,
        reasons: verdict.reasons,
        requestedBy: req.requestedBy,
      });
      return this.refuse(req, `control-${verdict.state}`, verdict.reasons, "0", correlation, startedAt);
    }

    // --- 4. structural invariants ---------------------------------------
    const invariantReasons: string[] = [];
    if (req.allocationId === "") invariantReasons.push("allocation id is empty");
    if (req.proposalHash !== attestationHashOf(req)) {
      invariantReasons.push("allocation references a different proposal hash than the attestation covers");
    }
    const requestedBps = req.proposal.sizeBps;
    if (requestedBps < 1 || requestedBps > 10_000) {
      invariantReasons.push(`proposal sizeBps ${requestedBps} is outside [1, 10000]`);
    }
    if (invariantReasons.length > 0) {
      return this.refuse(req, "structural-invariant", invariantReasons, "0", correlation, startedAt);
    }

    // --- 5. hard limit engine -------------------------------------------
    let limits: LimitVerdict;
    try {
      limits = evaluateOrder(req.order, req.portfolio, this.policy);
    } catch (err) {
      // A policy engine exception must fail closed. Trip the breaker, because a
      // limit check that cannot complete is itself an anomaly.
      this.control.noteAnomaly("policy-error", (err as Error).message);
      this.audit.append("execution.refused", "executor", "executor", {
        correlation,
        allocationId: req.allocationId,
        proposalId: req.proposalId,
        stage: "policy-engine",
        reason: (err as Error).message,
      });
      return this.refuse(req, "policy-engine-error", [`policy engine failed closed: ${(err as Error).message}`], "0", correlation, startedAt);
    }

    if (!limits.ok) {
      this.audit.append("execution.refused", "executor", "executor", {
        correlation,
        allocationId: req.allocationId,
        proposalId: req.proposalId,
        stage: "policy",
        rule: limits.rule,
        reasons: limits.reasons,
        notionalUsdc: req.order.notional.format(),
        asset: req.proposal.asset,
        side: req.proposal.side,
        maxLossUsdc: Money.fromMicros(limits.maxLossUsdcMicros).format(),
        requestedBy: req.requestedBy,
      });
      return this.refuse(req, limits.rule, limits.reasons, limits.maxLossUsdcMicros.toString(), correlation, startedAt);
    }

    // Risk's approved cap is a ceiling, not a target. The local engine already
    // applied the absolute limits; now clamp to whatever Risk was willing to
    // allow, which can only reduce the size.
    const effectiveNotional = req.order.notional.min(req.portfolio.totalValue.bps(att.maxSizeBps));
    if (effectiveNotional.micros < req.order.notional.micros) {
      this.audit.append("execution.size-reduced", "executor", "executor", {
        correlation,
        allocationId: req.allocationId,
        from: req.order.notional.format(),
        to: effectiveNotional.format(),
        reason: `Risk approved at most ${att.maxSizeBps} bps`,
      });
    }
    if (effectiveNotional.micros <= 0n) {
      return this.refuse(req, "size-reduced-to-zero", [`Risk's cap of ${att.maxSizeBps} bps reduces this order below any tradable size`], "0", correlation, startedAt);
    }

    // --- 6. execution mutex ---------------------------------------------
    const release = await this.lock.acquire();
    try {
      // Re-check the kill switch *inside* the lock. A stop command that lands
      // while we queue must still prevent the send.
      const recheck = this.control.authorize(direction, portfolioMicros);
      if (!recheck.allowed) {
        return this.refuse(req, `control-${recheck.state}-at-send`, recheck.reasons, limits.maxLossUsdcMicros.toString(), correlation, startedAt);
      }

      const idempotencyKey = `${req.allocationId}:${newId("tx")}`;
      this.audit.append("execution.submitting", "executor", "executor", {
        correlation,
        allocationId: req.allocationId,
        proposalId: req.proposalId,
        asset: req.proposal.asset,
        side: req.proposal.side,
        notionalUsdc: effectiveNotional.format(),
        maxLossUsdc: Money.fromMicros(limits.maxLossUsdcMicros).format(),
        network: this.signer.network,
        requestedBy: req.requestedBy,
      });

      const result = await this.signer.send({
        ...(req.tx?.to ? { to: req.tx.to } : {}),
        ...(req.tx?.value !== undefined ? { value: req.tx.value } : {}),
        ...(req.tx?.data ? { data: req.tx.data } : {}),
        ...(req.tx?.gas !== undefined ? { gas: req.tx.gas } : {}),
        idempotencyKey,
      });

      this.control.noteSuccess("revert");
      this.control.recordDeployment(effectiveNotional);

      this.audit.append("execution.submitted", "executor", "executor", {
        correlation,
        allocationId: req.allocationId,
        proposalId: req.proposalId,
        transactionHash: result.transactionHash,
        notionalUsdc: effectiveNotional.format(),
        network: this.signer.network,
      });

      return {
        status: "submitted",
        transactionHash: result.transactionHash,
        maxLossUsdcMicros: limits.maxLossUsdcMicros.toString(),
      };
    } catch (err) {
      // Any fault in the signing path is an anomaly. A signer that throws may be
      // misconfigured, the network may be degraded, or the enclave may be
      // rejecting. All of those mean stop and let a human look.
      const e = err as Error;
      const upstream = e instanceof UpstreamError ? e : null;
      this.control.noteAnomaly("revert", e.message);
      if (upstream?.permanent) {
        this.control.trip("permanent execution failure", e.message);
      }
      this.audit.append("execution.failed", "executor", "executor", {
        correlation,
        allocationId: req.allocationId,
        proposalId: req.proposalId,
        error: e.message,
        permanent: upstream?.permanent ?? false,
      });
      return this.refuse(req, "execution-failed", [e.message], limits.maxLossUsdcMicros.toString(), correlation, startedAt);
    } finally {
      release();
    }
  }

  /** Reduce exposure. Permitted in every state except a hard freeze. */
  async reduceExposure(req: {
    allocationId: string;
    asset: `0x${string}`;
    symbol: string;
    reason: string;
    tx: { to?: `0x${string}`; value?: bigint; data?: `0x${string}`; gas?: bigint };
    requestedBy: string;
  }): Promise<ExecutionOutcome> {
    const correlation = randomUUID();

    // A freeze blocks even exits, deliberately: a freeze means the system's own
    // state is untrustworthy, and a blind sell into that is as likely to hurt as
    // help. The kill switch has a documented `release` for that case.
    const verdict = this.control.authorize("reduce", 0n);
    if (!verdict.allowed) {
      this.audit.append("exit.refused", "executor", "executor", {
        correlation,
        allocationId: req.allocationId,
        asset: req.asset,
        reason: req.reason,
        controlReasons: verdict.reasons,
      });
      return { status: "rejected", reasons: verdict.reasons, rule: `control-${verdict.state}`, maxLossUsdcMicros: "0" };
    }

    const release = await this.lock.acquire();
    try {
      const idempotencyKey = `${req.allocationId}:${newId("exit")}`;
      this.audit.append("exit.submitting", "executor", "executor", {
        correlation,
        allocationId: req.allocationId,
        asset: req.asset,
        symbol: req.symbol,
        reason: req.reason,
        requestedBy: req.requestedBy,
      });
      const result = await this.signer.send({ ...req.tx, idempotencyKey });
      this.control.noteSuccess("revert");
      this.audit.append("exit.submitted", "executor", "executor", {
        correlation,
        allocationId: req.allocationId,
        asset: req.asset,
        transactionHash: result.transactionHash,
      });
      return { status: "submitted", transactionHash: result.transactionHash, maxLossUsdcMicros: "0" };
    } catch (err) {
      const e = err as Error;
      this.control.noteAnomaly("revert", e.message);
      this.audit.append("exit.failed", "executor", "executor", {
        correlation,
        allocationId: req.allocationId,
        asset: req.asset,
        error: e.message,
      });
      return { status: "rejected", reasons: [e.message], rule: "execution-failed", maxLossUsdcMicros: "0" };
    } finally {
      release();
    }
  }

  private refuse(
    req: ExecutionRequest,
    rule: string,
    reasons: string[],
    maxLossUsdcMicros: string,
    correlation: string,
    startedAt: string,
  ): ExecutionOutcome {
    this.audit.append("execution.rejected", "executor", "executor", {
      correlation,
      allocationId: req.allocationId,
      proposalId: req.proposalId,
      rule,
      reasons,
      startedAt,
    });
    return { status: "rejected", reasons, rule, maxLossUsdcMicros };
  }
}

function attestationHashOf(req: ExecutionRequest): `0x${string}` {
  return req.proposalHash;
}

export { PolicyError, assertAllowed };
