/**
 * Error taxonomy.
 *
 * The distinction that matters: `PolicyError` means the system correctly refused
 * to act. Those are expected, logged, and are a sign the controls are working.
 * Anything else is a fault.
 */

export class BigPickleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Credentials absent, malformed, or rejected. */
export class CredentialError extends BigPickleError {
  constructor(message: string) {
    super("CREDENTIALS", message);
  }
}

/** Secret could not be sealed or unsealed. */
export class VaultError extends BigPickleError {
  constructor(message: string) {
    super("VAULT", message);
  }
}

/**
 * A control refused an action. This is the system working correctly.
 *
 * `reasons` is a complete list, not just the first violation, so an operator
 * reading the audit log understands the whole picture in one entry.
 */
export class PolicyError extends BigPickleError {
  readonly reasons: string[];
  readonly rule: string;

  constructor(rule: string, reasons: string[], message?: string) {
    super(
      "POLICY_DENIED",
      message ?? `denied by ${rule}: ${reasons.join("; ")}`,
    );
    this.rule = rule;
    this.reasons = reasons;
  }
}

/** The kill switch is engaged. Highest-precedence refusal in the system. */
export class KillSwitchEngaged extends BigPickleError {
  constructor(scope: string, at: string) {
    super(
      "KILL_SWITCH",
      `kill switch engaged for scope=${scope} at ${at}; all signing is refused`,
    );
  }
}

/** A proposal reached the executor without a valid Risk attestation. */
export class AttestationError extends BigPickleError {
  constructor(message: string) {
    super("ATTESTATION_INVALID", message);
  }
}

/** Proposal failed schema validation. Typically a malformed LLM response. */
export class SchemaError extends BigPickleError {
  readonly field: string;
  constructor(field: string, message: string) {
    super("SCHEMA_INVALID", `${field}: ${message}`);
    this.field = field;
  }
}

/** Network is not permitted. Mainnet is refused unless explicitly enabled. */
export class NetworkNotPermitted extends BigPickleError {
  constructor(requested: string, permitted: string) {
    super(
      "NETWORK_NOT_PERMITTED",
      `network ${requested} is not permitted; permitted: ${permitted}`,
    );
  }
}

/** The wallet does not hold the funds. Applies to the owner as well as agents. */
export class InsufficientFunds extends BigPickleError {
  constructor(needed: string, available: string, asset: string) {
    super(
      "INSUFFICIENT_FUNDS",
      `insufficient ${asset}: need ${needed}, available ${available}`,
    );
  }
}

/** A gateway caller presented a bad or unknown token. */
export class Unauthorized extends BigPickleError {
  constructor(message: string) {
    super("UNAUTHORIZED", message);
  }
}

/** Upstream CDP or RPC failure. Retryable unless `permanent`. */
export class UpstreamError extends BigPickleError {
  readonly permanent: boolean;
  constructor(provider: string, message: string, permanent = false) {
    super("UPSTREAM", `${provider}: ${message}`);
    this.permanent = permanent;
  }
}

/** Audit log integrity check failed — tampering suspected. */
export class AuditIntegrityError extends BigPickleError {
  constructor(message: string) {
    super("AUDIT_INTEGRITY", message);
  }
}
