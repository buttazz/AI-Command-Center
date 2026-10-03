/**
 * Prediction experiment wiring test.
 */
import { describe, expect, test } from "vitest";
import { PredictionExperiment } from "../src/prediction/experiment.js";
import { FixturePredictionProvider } from "../src/prediction/fixtures/provider.js";
import { loadPolicy } from "../src/policy/schema.js";
import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";

describe("prediction experiment", () => {
  test("runs paper-only loop and produces audit/decisions", async () => {
    const policy = loadPolicy(resolve("config", "policy.aggressive.json"));
    const prov = new FixturePredictionProvider();
    const work = ".tmp-test-pred-experiment";
    if (existsSync(work)) rmSync(work, { recursive: true, force: true });
    const exp = new PredictionExperiment({ policy, provider: prov, workingDir: work });
    await exp.init();
    const r = await exp.run({ ticks: 4, sample: 6 });
    expect(r.decisions.length).toBeGreaterThan(0);
    expect(r.summary.bankrollBps).toBeGreaterThanOrEqual(0);
    expect(r.summary.noTrade + r.summary.vetoed + r.summary.approved + r.summary.resized).toBe(r.decisions.length);
  });
});
