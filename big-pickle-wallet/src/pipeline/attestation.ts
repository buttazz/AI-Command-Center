/**
 * Risk attestation: the mechanism that makes Risk's veto real.
 *
 * The problem this solves: a veto held in a prompt is advisory. If the Risk
 * process is unavailable, misconfigured, or has been talked into approving
 * something dangerous, a pipeline that merely *asks* Risk before executing will
 * do whatever it does next. "Risk has absolute veto authority" is not a property
 * you get from instructions.
 *
 * So Risk does not give permission. Risk *attests* that it examined a specific
 * proposal, and the executor independently verifies the signature before it will
 * price or sign anything. Consequences:
 *
 *  - Big Pickle cannot manufacture an approval. It has no signing key.
 *  - Risk being down does not mean approved. Absence of an attestation is a
 *    refusal, because the executor's default is deny.
 *  - Tampering with a proposal after attestation invalidates it, because the
 *    signed hash covers the whole canonical proposal.
 *  - A compromised Risk process can only *veto* (sign "veto"). It cannot widen a
 *    size beyond the proposal it was asked about, and the hard limit engine
 *    applies to its approvals anyway.
 */

import { canonicalJson, hashObject, nowIso } from "../core/ids.js";
import { signAttestation, verifyAttestation } from "../secrets/vault.js";
import { AttestationError, SchemaError } from "../errors.js";
import { clampInt } from "../core/money.js";
import type {
  RiskAssessment,
  RiskAttestation,
  TradeProposal,
  Hex,
} from "../types.js";

/** The exact bytes that get signed. Exported so tests can assert on it. */
export function attestationPayload(
  proposalHash: Hex,
  proposalId: string,
  verdict: "approve" | "veto",
  maxSizeBps: number,
  issuedAt: string,
): string {
  // Field order is fixed by construction, and the object is additionally
  // canonicalised, so the signed bytes cannot drift with property order.
  return canonicalJson({
    v: 1,
    proposalHash,
    proposalId,
    verdict,
    maxSizeBps,
    issuedAt,
  });
}

/**
 * Validate a proposal's shape before it is ever hashed or signed.
 *
 * This is the second structural defence. Beyond bounding `sizeBps`, it rejects
 * anything that cannot be checked later: an entry with no invalidation, a
 * non-finite price, a confidence outside 0..100. A proposal that fails here
 * never reaches Risk, so Risk is never asked to reason about nonsense.
 */
export function validateProposal(raw: unknown): TradeProposal {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SchemaError("proposal", "expected an object");
  }
  const o = raw as Record<string, unknown>;

  const str = (v: unknown, field: string, maxLen = 2000): string => {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new SchemaError(field, "expected a non-empty string");
    }
    if (v.length > maxLen) {
      // A runaway string from a confused model is both a log-bloat and a
      // prompt-injection surface for the next stage.
      throw new SchemaError(field, `exceeds ${maxLen} characters`);
    }
    return v;
  };

  const addr = (v: unknown, field: string): Hex => {
    const s = str(v, field, 42);
    if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
      throw new SchemaError(field, `not a 20-byte hex address: ${JSON.stringify(s)}`);
    }
    return s as Hex;
  };

  const side = str(o["side"], "side", 8);
  if (side !== "buy" && side !== "sell") {
    throw new SchemaError("side", `must be "buy" or "sell", got ${JSON.stringify(side)}`);
  }

  // The critical bound. 10000 = 100% of portfolio. There is no representation
  // of "unbounded" or "all available" available to the model.
  const sizeBps = clampInt(o["sizeBps"], 1, 10_000, "sizeBps");

  const confidence = clampInt(o["confidence"], 0, 100, "confidence");

  if (typeof o["expectedRiskReward"] !== "number" || !Number.isFinite(o["expectedRiskReward"] as number)) {
    throw new SchemaError("expectedRiskReward", "expected a finite number");
  }
  const rr = o["expectedRiskReward"] as number;
  if (rr <= 0) {
    throw new SchemaError("expectedRiskReward", "must be positive; a trade with no defined upside is not a proposal");
  }

  const horizon = str(o["horizon"], "horizon", 16);
  if (!["scalp", "intraday", "swing", "position"].includes(horizon)) {
    throw new SchemaError("horizon", `unsupported horizon ${JSON.stringify(horizon)}`);
  }

  const entryRaw = o["entry"];
  if (typeof entryRaw !== "object" || entryRaw === null) {
    throw new SchemaError("entry", "expected an object");
  }
  const entry = entryRaw as Record<string, unknown>;
  const entryKind = str(entry["kind"], "entry.kind", 16);
  if (entryKind !== "market" && entryKind !== "limit") {
    throw new SchemaError("entry.kind", `must be "market" or "limit"`);
  }
  if (entryKind === "limit") {
    // A limit entry without a price is meaningless and would be a market entry
    // wearing a limit label, which would quietly defeat the slippage gate.
    const p = entry["price"];
    if (typeof p !== "string" || !/^\d+(\.\d+)?$/.test(p)) {
      throw new SchemaError("entry.price", "a limit entry requires a plain decimal price");
    }
  }

  // Invalidation is mandatory. This is what makes the max-loss figure a bound
  // rather than a hope.
  const invalRaw = o["invalidation"];
  if (!Array.isArray(invalRaw) || invalRaw.length === 0) {
    throw new SchemaError(
      "invalidation",
      "required and must be non-empty: a trade with no defined invalidation has no bounded maximum loss and will not be executed",
    );
  }
  const invalidation = invalRaw.map((v, i) => str(v, `invalidation[${i}]`, 500));
  if (invalidation.length > 10) {
    throw new SchemaError("invalidation", "at most 10 conditions");
  }

  const exitRaw = o["exit"];
  if (typeof exitRaw !== "object" || exitRaw === null) {
    throw new SchemaError("exit", "expected an object");
  }
  const exitObj = exitRaw as Record<string, unknown>;
  const exitKind = str(exitObj["kind"], "exit.kind", 16);
  if (!["target", "stop", "time", "condition"].includes(exitKind)) {
    throw new SchemaError("exit.kind", `unsupported kind ${JSON.stringify(exitKind)}`);
  }
  if (exitKind === "target" && typeof exitObj["price"] !== "string") {
    throw new SchemaError("exit.price", "a target exit requires a price");
  }

  const id = str(o["id"], "id", 80);
  const candidateId = str(o["candidateId"], "candidateId", 80);

  return {
    id,
    candidateId,
    asset: addr(o["asset"], "asset"),
    assetSymbol: str(o["assetSymbol"], "assetSymbol", 24),
    side,
    sizeBps,
    thesis: str(o["thesis"], "thesis", 4000),
    entry: { kind: entryKind, ...(typeof entry["price"] === "string" ? { price: entry["price"] as string } : {}) },
    invalidation,
    exit: {
      kind: exitKind as TradeProposal["exit"]["kind"],
      ...(typeof exitObj["price"] === "string" ? { price: exitObj["price"] as string } : {}),
      note: str(exitObj["note"], "exit.note", 1000),
    },
    expectedRiskReward: rr,
    confidence,
    horizon: horizon as TradeProposal["horizon"],
    createdBy: str(o["createdBy"], "createdBy", 120),
    createdAt: str(o["createdAt"], "createdAt", 40),
  };
}

/** Validate a Risk assessment. Symmetric with `validateProposal`. */
export function validateAssessment(raw: unknown): RiskAssessment {
  if (typeof raw !== "object" || raw === null) {
    throw new SchemaError("assessment", "expected an object");
  }
  const o = raw as Record<string, unknown>;
  const verdict = o["verdict"];
  if (verdict !== "approve" && verdict !== "veto") {
    throw new SchemaError("verdict", `must be "approve" or "veto", got ${JSON.stringify(verdict)}`);
  }
  const vetoReasonsRaw = o["vetoReasons"];
  if (!Array.isArray(vetoReasonsRaw)) {
    throw new SchemaError("vetoReasons", "expected an array");
  }
  const vetoReasons = vetoReasonsRaw.map((v, i) => {
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new SchemaError(`vetoReasons[${i}]`, "expected a non-empty string");
    }
    return v;
  });

  // A veto with no reason is unauditable. An approve carrying veto reasons is
  // self-contradictory and is treated as a veto, because ambiguity must resolve
  // toward refusing.
  if (verdict === "veto" && vetoReasons.length === 0) {
    throw new SchemaError(
      "vetoReasons",
      "a veto must state at least one reason; an unexplained refusal cannot be reviewed or learned from",
    );
  }
  if (verdict === "approve" && vetoReasons.length > 0) {
    throw new SchemaError(
      "vetoReasons",
      `approve contradicts ${vetoReasons.length} veto reason(s); resolve to a single verdict`,
    );
  }

  const maxSizeBps = clampInt(o["maxSizeBps"], 0, 10_000, "maxSizeBps");
  if (verdict === "approve" && maxSizeBps === 0) {
    throw new SchemaError("maxSizeBps", "an approval with a zero size approves nothing; use a veto instead");
  }

  const notesRaw = o["notes"];
  if (!Array.isArray(notesRaw)) throw new SchemaError("notes", "expected an array");
  const notes = notesRaw.map((v, i) => {
    if (typeof v !== "string") throw new SchemaError(`notes[${i}]`, "expected a string");
    return v;
  });

  const findingsRaw = o["findings"];
  if (typeof findingsRaw !== "object" || findingsRaw === null || Array.isArray(findingsRaw)) {
    throw new SchemaError("findings", "expected an object of boolean checks");
  }
  const f = findingsRaw as Record<string, unknown>;
  // Anything other than an explicit `true` counts as not satisfied. A missing
  // or malformed check must not read as a pass.
  const findings: RiskAssessment["findings"] = {
    liquidityOk: f["liquidityOk"] === true,
    volatilityOk: f["volatilityOk"] === true,
    concentrationOk: f["concentrationOk"] === true,
    slippageOk: f["slippageOk"] === true,
    contractRiskOk: f["contractRiskOk"] === true,
    duplicateExposureOk: f["duplicateExposureOk"] === true,
    maxLossOk: f["maxLossOk"] === true,
  };

  return {
    verdict,
    vetoReasons,
    maxSizeBps,
    confidence: clampInt(o["confidence"], 0, 100, "confidence"),
    notes,
    findings,
  };
}

/**
 * Produce an attestation. Only the Risk process holds `privateKeyPem`.
 *
 * Note the shape: the attestation commits to the *proposal hash*, not to the
 * assessment narrative. Risk can change its mind about its reasoning between runs
 * without invalidating prior attestations, but any change to the trade itself
 * invalidates them.
 */
export function attest(
  proposal: TradeProposal,
  assessment: RiskAssessment,
  privateKeyPem: string,
  keyId: string,
): RiskAttestation {
  const validated = validateAssessment(assessment);
  const proposalHash = hashObject(proposal);
  const issuedAt = nowIso();

  const payload = attestationPayload(
    proposalHash,
    proposal.id,
    validated.verdict,
    validated.maxSizeBps,
    issuedAt,
  );

  return {
    proposalId: proposal.id,
    proposalHash,
    verdict: validated.verdict,
    maxSizeBps: validated.maxSizeBps,
    signature: signAttestation(privateKeyPem, payload),
    signerKeyId: keyId,
    issuedAt,
  };
}

export interface VerificationResult {
  valid: boolean;
  reason: string;
  maxSizeBps: number;
  verdict: "approve" | "veto";
}

/**
 * Verify an attestation against the proposal in hand.
 *
 * Recomputes the hash from the proposal it is given rather than trusting the
 * `proposalHash` field, so an attacker cannot attach a genuine signature for one
 * proposal to a different, larger proposal.
 *
 * Fails closed: every failure path returns `valid: false` with a reason. There
 * is no code path that returns `valid: true` on anything other than a verified
 * signature over a matching hash.
 */
export function verifyAttestationForProposal(
  proposal: TradeProposal,
  attestation: RiskAttestation | null | undefined,
  publicKeyPem: string,
): VerificationResult {
  if (!attestation) {
    return {
      valid: false,
      reason: "no Risk attestation present. Absence of an attestation is a refusal, never an implicit approval.",
      maxSizeBps: 0,
      verdict: "veto",
    };
  }

  if (attestation.proposalId !== proposal.id) {
    return {
      valid: false,
      reason: `attestation is for proposal ${attestation.proposalId}, but the proposal supplied is ${proposal.id}`,
      maxSizeBps: 0,
      verdict: "veto",
    };
  }

  // Recompute rather than trust. This is the check that stops a real signature
  // being replayed onto a larger proposal.
  const recomputed = hashObject(proposal);
  if (recomputed !== attestation.proposalHash) {
    return {
      valid: false,
      reason: `proposal has been altered since attestation: recomputed hash ${recomputed} does not match the signed hash ${attestation.proposalHash}`,
      maxSizeBps: 0,
      verdict: "veto",
    };
  }

  const payload = attestationPayload(
    attestation.proposalHash,
    attestation.proposalId,
    attestation.verdict,
    attestation.maxSizeBps,
    attestation.issuedAt,
  );

  if (!verifyAttestation(publicKeyPem, payload, attestation.signature)) {
    return {
      valid: false,
      reason: `signature does not verify against Risk public key ${attestation.signerKeyId}. The attestation was forged, or was signed by a different key than the executor trusts.`,
      maxSizeBps: 0,
      verdict: "veto",
    };
  }

  if (attestation.verdict === "veto") {
    return {
      valid: false,
      reason: `Risk vetoed this proposal (attestation ${attestation.proposalId}).`,
      maxSizeBps: 0,
      verdict: "veto",
    };
  }

  if (attestation.maxSizeBps <= 0) {
    return {
      valid: false,
      reason: "attestation approves a zero size, which approves nothing.",
      maxSizeBps: 0,
      verdict: "veto",
    };
  }

  return {
    valid: true,
    reason: `Risk approved up to ${attestation.maxSizeBps} bps (attestation ${attestation.proposalId}, key ${attestation.signerKeyId}).`,
    maxSizeBps: attestation.maxSizeBps,
    verdict: "approve",
  };
}

/** Convenience wrapper that throws `AttestationError` on any failure. */
export function assertAttested(
  proposal: TradeProposal,
  attestation: RiskAttestation | null | undefined,
  publicKeyPem: string,
): VerificationResult {
  const result = verifyAttestationForProposal(proposal, attestation, publicKeyPem);
  if (!result.valid) {
    throw new AttestationError(result.reason);
  }
  return result;
}
