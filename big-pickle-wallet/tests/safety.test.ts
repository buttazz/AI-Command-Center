import { strict as nodeAssert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { AuditLog } from "../src/audit/audit-log.js";
import { ControlPlane, defaultControlPaths } from "../src/control/control-plane.js";
import { Money } from "../src/core/money.js";
import { evaluateOrder, type OrderFacts, type PortfolioFacts } from "../src/policy/engine.js";
import { loadPolicy } from "../src/policy/schema.js";
import { attest, validateProposal, verifyAttestationForProposal } from "../src/pipeline/attestation.js";
import { generateAttestationKeyPair } from "../src/secrets/vault.js";
import type { Hex, TradeProposal } from "../src/types.js";

const policy = loadPolicy(resolve(process.cwd(), "config/policy.aggressive.json"));
const asset = "0x0000000000000000000000000000000000000001" as Hex;
const otherAsset = "0x0000000000000000000000000000000000000002" as Hex;

function order(overrides: Partial<OrderFacts> = {}): OrderFacts {
  return {
    asset,
    symbol: "SMOKE",
    side: "buy",
    notional: Money.fromMicros(10_000_000n),
    distanceToInvalidationBps: 9_500,
    expectedGrossEdgeBps: 200,
    slippageBps: 10,
    priceImpactBps: 10,
    gasWei: 0n,
    gasPriceUsdcMicros: 0n,
    liquidityUsd: 100_000n,
    volume24hUsd: 100_000n,
    topHolderConcentrationBps: 1_000,
    tokenVerified: true,
    honeypotSuspected: false,
    transferSimulationPassed: true,
    ...overrides,
  };
}

function portfolio(overrides: Partial<PortfolioFacts> = {}): PortfolioFacts {
  return {
    totalValue: Money.fromMicros(100_000_000n),
    deployable: Money.fromMicros(100_000_000n),
    gasReserveWei: 0n,
    currentGasPriceWei: 0n,
    openPositions: [],
    openExposure: Money.zero(),
    deployedTodayMicros: 0n,
    ...overrides,
  };
}

function hasRule(verdict: ReturnType<typeof evaluateOrder>, rule: string): boolean {
  return verdict.reasons.some((reason) => reason.toLowerCase().includes(rule.toLowerCase()));
}

describe("deterministic policy safety gates", () => {
  test("rejects a trade above maximum size", () => {
    const verdict = evaluateOrder(order({ notional: Money.fromMicros(21_000_000n) }), portfolio(), policy);
    expect(verdict.ok).toBe(false);
    expect(hasRule(verdict, "maxSingleTradeBps")).toBe(true);
  });

  test("rejects a new position above the concurrent-position limit", () => {
    const positions = Array.from({ length: 4 }, (_, i) => ({
      asset: `0x${String(i + 10).padStart(40, "0")}` as Hex,
      symbol: `P${i}`,
      markValueUsdcMicros: 10_000_000n,
      costBasisUsdcMicros: 10_000_000n,
      holdsInventory: true,
    }));
    const verdict = evaluateOrder(order(), portfolio({ openPositions: positions }), policy);
    expect(verdict.ok).toBe(false);
    expect(hasRule(verdict, "already holding 4 positions")).toBe(true);
  });

  test("rejects daily deployment beyond the policy cap", () => {
    const verdict = evaluateOrder(
      order(),
      portfolio({ deployedTodayMicros: 85_000_000n }),
      policy,
    );
    expect(verdict.ok).toBe(false);
    expect(hasRule(verdict, "daily deployment")).toBe(true);
  });

  test("rejects excessive slippage", () => {
    const verdict = evaluateOrder(order({ slippageBps: policy.execution.maxSlippageBps + 1 }), portfolio(), policy);
    expect(verdict.ok).toBe(false);
    expect(hasRule(verdict, "slippage")).toBe(true);
  });

  test("rejects insufficient liquidity", () => {
    const verdict = evaluateOrder(order({ liquidityUsd: policy.assets.minLiquidityUsd - 1n }), portfolio(), policy);
    expect(verdict.ok).toBe(false);
    expect(hasRule(verdict, "liquidity")).toBe(true);
  });

  test("rejects excessive holder concentration", () => {
    const verdict = evaluateOrder(
      order({ topHolderConcentrationBps: policy.assets.maxTopHolderConcentrationBps + 1 }),
      portfolio(),
      policy,
    );
    expect(verdict.ok).toBe(false);
    expect(hasRule(verdict, "top holder")).toBe(true);
  });

  test("mechanically rejects averaging down", () => {
    const verdict = evaluateOrder(
      order(),
      portfolio({
        openPositions: [{
          asset,
          symbol: "SMOKE",
          markValueUsdcMicros: 10_000_000n,
          costBasisUsdcMicros: 12_000_000n,
          holdsInventory: true,
        }],
        openExposure: Money.fromMicros(10_000_000n),
      }),
      policy,
    );
    expect(verdict.ok).toBe(false);
    expect(hasRule(verdict, "averaging down")).toBe(true);
  });

  test("rejects missing invalidation", () => {
    const verdict = evaluateOrder(order({ distanceToInvalidationBps: 0 }), portfolio(), policy);
    expect(verdict.ok).toBe(false);
    expect(hasRule(verdict, "invalidation")).toBe(true);
  });

  test("rejects correlated concentration for a new asset", () => {
    const verdict = evaluateOrder(
      order({ asset: otherAsset }),
      portfolio({
        openPositions: [{
          asset,
          symbol: "SMOKE",
          markValueUsdcMicros: 10_000_000n,
          costBasisUsdcMicros: 10_000_000n,
          holdsInventory: true,
          correlationToProposalBps: policy.concurrency.maxCorrelationBetweenOpenPositions + 1,
        }],
      }),
      policy,
    );
    expect(verdict.ok).toBe(false);
    expect(hasRule(verdict, "correlates above")).toBe(true);
  });
});

describe("control plane and audit safety", () => {
  test("kill switch blocks all directions and owner release is explicit", () => {
    const root = mkdtempSync(join(tmpdir(), "bpw-control-test-"));
    try {
      const control = new ControlPlane(policy, defaultControlPaths(root));
      control.seedDay(100_000_000n);
      control.engageKillSwitch("owner", "test stop");
      expect(control.authorize("increase", 100_000_000n).allowed).toBe(false);
      expect(control.authorize("reduce", 100_000_000n).allowed).toBe(false);
      expect(() => control.releaseKillSwitch("agent", "bad release")).toThrow();
      control.releaseKillSwitch("owner", "reviewed release");
      expect(control.authorize("reduce", 100_000_000n).allowed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("freeze is sticky until owner resumes it", () => {
    const root = mkdtempSync(join(tmpdir(), "bpw-freeze-test-"));
    try {
      const control = new ControlPlane(policy, defaultControlPaths(root));
      control.trip("test anomaly", "must stop");
      expect(control.authorize("reduce", 100_000_000n).allowed).toBe(false);
      expect(() => control.resume("system", "not human")).toThrow();
      control.resume("owner", "reviewed anomaly");
      expect(control.freezeInfo().frozen).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("daily drawdown and ledger are deterministic", () => {
    const root = mkdtempSync(join(tmpdir(), "bpw-ledger-test-"));
    try {
      const control = new ControlPlane(policy, defaultControlPaths(root));
      control.seedDay(100_000_000n);
      control.recordDeployment(Money.fromMicros(3_000_000n));
      control.recordRealised(Money.fromMicros(-1_000_000n), 100_000_000n);
      expect(control.getLedger().deployedTodayMicros).toBe("3000000");
      expect(control.drawdownBps(92_000_000n)).toBe(800);
      expect(control.authorize("increase", 92_000_000n).allowed).toBe(false);
      expect(control.authorize("reduce", 92_000_000n).allowed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("audit chain detects tampering", () => {
    const root = mkdtempSync(join(tmpdir(), "bpw-audit-test-"));
    try {
      const audit = new AuditLog(root);
      audit.append("test.one", "system", "test", { ok: true });
      audit.append("test.two", "system", "test", { ok: true });
      expect(audit.verifyAll().ok).toBe(true);
      const file = audit.files()[0];
      nodeAssert.ok(file);
      const original = readFileSync(file, "utf8");
      writeFileSync(file, original.replace("test.one", "tampered"));
      expect(audit.verifyAll().ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("attestation and fixed-point input validation", () => {
  const rawProposal = {
    id: "proposal_test",
    candidateId: "candidate_test",
    asset,
    assetSymbol: "SMOKE",
    side: "buy",
    sizeBps: 900,
    thesis: "test",
    entry: { kind: "market" },
    invalidation: ["close below invalidation"],
    exit: { kind: "target", price: "1.25", note: "target" },
    expectedRiskReward: 2,
    confidence: 80,
    horizon: "intraday",
    createdBy: "test",
    createdAt: new Date().toISOString(),
  };

  test("rejects malformed proposals and attestations", () => {
    expect(() => validateProposal({ ...rawProposal, invalidation: [] })).toThrow();
    expect(() => validateProposal({ ...rawProposal, sizeBps: 0 })).toThrow();
    expect(() => validateProposal({ ...rawProposal, entry: { kind: "unknown" } })).toThrow();
  });

  test("rejects tampered and malformed attestations", () => {
    const proposal = validateProposal(rawProposal) as TradeProposal;
    const keys = generateAttestationKeyPair();
    const attestation = attest(
      proposal,
      {
        verdict: "approve",
        vetoReasons: [],
        maxSizeBps: 900,
        confidence: 80,
        notes: [],
        findings: {
          liquidityOk: true,
          volatilityOk: true,
          concentrationOk: true,
          slippageOk: true,
          contractRiskOk: true,
          duplicateExposureOk: true,
          maxLossOk: true,
        },
      },
      keys.privateKeyPem,
      keys.keyId,
    );
    expect(verifyAttestationForProposal(proposal, attestation, keys.publicKeyPem).valid).toBe(true);
    expect(verifyAttestationForProposal(proposal, null, keys.publicKeyPem).valid).toBe(false);
    expect(verifyAttestationForProposal(proposal, { ...attestation, signature: "not-a-signature" }, keys.publicKeyPem).valid).toBe(false);
    expect(verifyAttestationForProposal({ ...proposal, sizeBps: 901 }, attestation, keys.publicKeyPem).valid).toBe(false);
  });

  test("keeps monetary arithmetic exact", () => {
    const amount = Money.parseUsdc("0.000001");
    expect(amount.micros).toBe(1n);
    expect(amount.add(Money.parseUsdc("1.25")).format()).toBe("1.250001");
    expect(() => Money.parseUsdc("1e-6")).toThrow();
  });
});
