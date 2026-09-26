import { describe, expect, test } from "vitest";
import { canAgentResearch, canAgentTrade, ownerMayAct } from "../src/mode.js";
import type { AgentState } from "../src/types.js";

describe("trader authority mode gates", () => {
  test("owner authority is never blocked by mode", () => {
    expect(ownerMayAct({} as AgentState)).toBe(true);
  });

  test("agent trading requires autonomous mode without reconcile debt", () => {
    expect(canAgentTrade({ mode: "AUTONOMOUS", pendingReconcile: false } as AgentState)).toBe(true);
    expect(canAgentTrade({ mode: "PAUSED", pendingReconcile: false } as AgentState)).toBe(false);
    expect(canAgentTrade({ mode: "AUTONOMOUS", pendingReconcile: true } as AgentState)).toBe(false);
  });

  test("disabled mode blocks agent market research", () => {
    expect(canAgentResearch({ mode: "AUTONOMOUS" } as AgentState)).toBe(true);
    expect(canAgentResearch({ mode: "DISABLED" } as AgentState)).toBe(false);
  });
});
