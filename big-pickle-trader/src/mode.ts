import type { AgentState, Mode, Principal, ModeChange } from "./types.js";
import { audit } from "./audit.js";

/**
 * Control-mode state machine.
 *
 * Design rules, in priority order:
 *
 *  1. OWNER IS NEVER BLOCKED. No mode, flag, or error in this module can stop an
 *     owner action. `ownerMayAct` is intentionally unconditional, and the
 *     agent-facing transitions are enumerated such that none of them can
 *     produce a state from which the owner is locked out.
 *
 *  2. DISABLED IS A LATCH. Only the owner can leave it. The agent has no
 *     transition out of DISABLED. In particular the agent cannot convert a
 *     self-pause into a resume, so a crash-restart cannot silently re-enable
 *     trading that the owner switched off.
 *
 *  3. AGENT MAY ONLY DE-ESCALATE. The single agent transition is
 *     AUTONOMOUS -> PAUSED (self-pause on anomaly). The agent can never reach
 *     AUTONOMOUS by itself, so autonomy is never widened without the owner.
 *
 *  4. OVERRIDE RESTORES THE OUTER INTENT. Entering OWNER_OVERRIDE records the
 *     mode it interrupted; finishing returns there. If the outer mode was
 *     DISABLED, it stays DISABLED — an owner trade does not silently re-enable
 *     autonomous trading. The owner can still explicitly resume afterwards.
 *
 *  5. A RECONCILE IS OWED BEFORE TRADING RESUMES. Owner wallet-touching actions
 *     set `pendingReconcile`, which independently gates agent trading even if
 *     the mode is AUTONOMOUS.
 */

/** Transitions the agent is permitted to request. Everything else is refused. */
const AGENT_TRANSITIONS: ReadonlyArray<{ from: Mode; to: Mode }> = [
  { from: "AUTONOMOUS", to: "PAUSED" },
];

export class AuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityError";
  }
}

export interface ModeChangeRequest {
  to: Mode;
  by: Principal;
  reason: string;
  /** Owner may name the resting mode explicitly; otherwise the interrupted mode is restored. */
  resumeTo?: Mode;
}

function agentMayTransition(from: Mode, to: Mode): boolean {
  return AGENT_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/**
 * May the owner act? Always yes.
 *
 * Kept as an explicit function so the invariant is asserted in tests rather
 * than implied by the absence of a check. There is deliberately no branch here.
 */
export function ownerMayAct(_state: AgentState): true {
  return true;
}

/** Can the agent send a transaction right now? */
export function canAgentTrade(state: AgentState): boolean {
  if (state.mode !== "AUTONOMOUS") return false;
  if (state.pendingReconcile) return false;
  return true;
}

/** Can the agent keep reading markets and forming decisions? */
export function canAgentResearch(state: AgentState): boolean {
  return state.mode !== "DISABLED";
}

/** Is a resting mode one the owner chose deliberately, so the agent must not leave it? */
function isDeliberateRestingMode(mode: Mode): boolean {
  return mode === "PAUSED" || mode === "DISABLED";
}

/**
 * Apply a mode change. Mutates `state` in place; the caller persists it.
 * Throws AuthorityError if the principal is not allowed to make this change.
 */
export function applyModeChange(state: AgentState, req: ModeChangeRequest): ModeChange {
  const { to, by, reason } = req;

  if (by === "agent" && !agentMayTransition(state.mode, to)) {
    throw new AuthorityError(
      `agent may not move ${state.mode} -> ${to}; permitted: ` +
        AGENT_TRANSITIONS.map((t) => `${t.from}->${t.to}`).join(", "),
    );
  }

  const from = state.mode;
  let resumeTo: Mode;

  if (to === "OWNER_OVERRIDE") {
    if (from === "OWNER_OVERRIDE") {
      resumeTo = state.resumeTo; // nested override: keep the original outer intent
    } else {
      // Remember what we interrupted. If that was DISABLED we must come back to it.
      resumeTo = from === "DISABLED" ? "DISABLED" : from;
    }
  } else {
    // An explicit resting mode. Default to resting there.
    resumeTo = req.resumeTo ?? to;
  }

  state.mode = to;
  state.resumeTo = resumeTo;
  state.modeChangedAt = new Date().toISOString();
  state.modeChangedBy = by;
  state.modeReason = reason;

  // Entering or leaving an override always owes a reconcile.
  if (to === "OWNER_OVERRIDE" || from === "OWNER_OVERRIDE") {
    state.pendingReconcile = true;
  }

  const change: ModeChange = { from, to, by, reason, at: state.modeChangedAt, resumeTo };
  audit({ kind: "mode.change", modeChange: change, revision: state.revision });
  return change;
}

/**
 * Called after reconciliation succeeds to clear the reconcile debt and, unless
 * the owner left the system deliberately stopped, return to the resting mode.
 */
export function finishOverride(state: AgentState, by: Principal = "system"): ModeChange | null {
  if (state.mode !== "OWNER_OVERRIDE") {
    // Nothing to finish, but still clear the debt so trading is not wedged.
    const hadDebt = state.pendingReconcile;
    state.pendingReconcile = false;
    return hadDebt
      ? { from: state.mode, to: state.mode, by, reason: "cleared reconcile debt", at: new Date().toISOString(), resumeTo: state.resumeTo }
      : null;
  }

  const target: Mode = isDeliberateRestingMode(state.resumeTo) ? state.resumeTo : "AUTONOMOUS";

  if (by === "agent") {
    // The agent finishing its own override may return to AUTONOMOUS but must
    // never drag the system out of a deliberate owner stop.
    if (isDeliberateRestingMode(state.resumeTo)) {
      throw new AuthorityError(`agent cannot leave owner-set ${state.resumeTo} via override completion`);
    }
  }

  const from = state.mode;
  state.mode = target;
  state.resumeTo = target;
  state.modeChangedAt = new Date().toISOString();
  state.modeChangedBy = by;
  state.modeReason = "owner override reconciled";
  state.pendingReconcile = false;

  const change: ModeChange = { from, to: target, by, reason: "owner override reconciled", at: state.modeChangedAt, resumeTo: target };
  audit({ kind: "mode.change", modeChange: change, revision: state.revision });
  return change;
}

/** Mark a reconcile as owed without changing mode (owner action while autonomous). */
export function requireReconcile(state: AgentState, reason: string): void {
  state.pendingReconcile = true;
  audit({ kind: "reconcile.start", reason, by: "owner", at: new Date().toISOString() });
}

/**
 * Agent plans are built against a state revision. If the owner intervened after
 * the plan was made, the revision moves and the plan is discarded rather than
 * executed against a stale balance snapshot.
 */
export function planIsStale(state: AgentState, planRevision: number): boolean {
  return state.revision !== planRevision || state.pendingReconcile || state.mode !== "AUTONOMOUS";
}

/** Throw unless this principal is allowed to change modes. Owner path always passes. */
export function assertMayChangeMode(state: AgentState, by: Principal, to: Mode): void {
  if (by === "owner" || by === "system") return;
  if (!agentMayTransition(state.mode, to)) {
    throw new AuthorityError(`agent may not move ${state.mode} -> ${to}`);
  }
}
