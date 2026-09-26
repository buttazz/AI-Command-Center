import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "../src/audit/audit-log.js";
import { ControlPlane, defaultControlPaths } from "../src/control/control-plane.js";
import { Money } from "../src/core/money.js";
import { validateProposal, attest, verifyAttestationForProposal } from "../src/pipeline/attestation.js";
import { loadPolicy } from "../src/policy/schema.js";
import { generateAttestationKeyPair } from "../src/secrets/vault.js";

const here = dirname(fileURLToPath(import.meta.url));
const policyPath = resolve(here, "../config/policy.aggressive.json");

function validProposal(): Record<string, unknown> {
  return {
    id: "proposal_smoke_001",
    candidateId: "candidate_smoke_001",
    asset: "0x0000000000000000000000000000000000000001",
    assetSymbol: "SMOKE",
    side: "buy",
    sizeBps: 900,
    thesis: "deterministic smoke-test proposal",
    entry: { kind: "market" },
    invalidation: ["price closes below the test invalidation level"],
    exit: { kind: "target", price: "1.25", note: "test target" },
    expectedRiskReward: 2,
    confidence: 80,
    horizon: "intraday",
    createdBy: "smoke-test",
    createdAt: new Date().toISOString(),
  };
}

function expectFailure(fn: () => unknown, label: string): void {
  assert.throws(fn, `${label} must fail closed`);
}

export async function runSmokeTest(): Promise<void> {
  const policy = loadPolicy(policyPath);
  assert.deepEqual(policy.network.permitted, ["base-sepolia"]);
  assert.equal(policy.network.mainnetEnabled, false);

  const exact = Money.parseUsdc("12.500001");
  assert.equal(exact.micros, 12_500_001n);
  assert.equal(exact.format(), "12.500001");
  expectFailure(() => Money.parseUsdc("1e3"), "exponent money");
  expectFailure(() => Money.parseUsdc("1.0000001"), "over-precise money");

  const proposal = validateProposal(validProposal());
  const keys = generateAttestationKeyPair();
  const assessment = {
    verdict: "approve" as const,
    vetoReasons: [],
    maxSizeBps: 900,
    confidence: 90,
    notes: ["all smoke checks passed"],
    findings: {
      liquidityOk: true,
      volatilityOk: true,
      concentrationOk: true,
      slippageOk: true,
      contractRiskOk: true,
      duplicateExposureOk: true,
      maxLossOk: true,
    },
  };
  const attestation = attest(proposal, assessment, keys.privateKeyPem, keys.keyId);
  assert.equal(verifyAttestationForProposal(proposal, attestation, keys.publicKeyPem).valid, true);
  const tampered = { ...proposal, sizeBps: 2_000 };
  assert.equal(verifyAttestationForProposal(tampered, attestation, keys.publicKeyPem).valid, false);
  assert.equal(verifyAttestationForProposal(proposal, { ...attestation, signature: "bad" }, keys.publicKeyPem).valid, false);
  expectFailure(() => validateProposal({ ...validProposal(), invalidation: [] }), "missing invalidation");
  expectFailure(() => validateProposal({ ...validProposal(), sizeBps: 10_001 }), "oversized proposal");

  const root = mkdtempSync(join(tmpdir(), "big-pickle-smoke-"));
  try {
    const audit = new AuditLog(join(root, "audit"));
    audit.append("smoke.start", "system", "smoke-test", { safe: true });
    audit.append("smoke.attestation", "risk", "smoke-test", { verified: true });
    assert.equal(audit.verifyAll().ok, true);
    const auditFile = audit.files()[0];
    assert.ok(auditFile);
    const original = readFileSync(auditFile, "utf8");
    writeFileSync(auditFile, original.replace("smoke.start", "tampered"));
    assert.equal(audit.verifyAll().ok, false);
    writeFileSync(auditFile, original);
    assert.equal(audit.verifyAll().ok, true);

    const control = new ControlPlane(policy, defaultControlPaths(root));
    const startingValue = 100_000_000n;
    control.seedDay(startingValue);
    control.recordDeployment(Money.fromMicros(10_000_000n));
    assert.equal(control.getLedger().deployedTodayMicros, "10000000");
    assert.equal(control.authorize("increase", startingValue).allowed, true);

    control.trip("smoke freeze", "expected test freeze");
    assert.equal(control.freezeInfo().frozen, true);
    assert.equal(control.authorize("reduce", startingValue).allowed, false);
    expectFailure(() => control.resume("agent", "not authorized"), "non-owner resume");
    control.resume("owner", "smoke resume");
    assert.equal(control.freezeInfo().frozen, false);

    control.engageKillSwitch("owner", "smoke kill");
    assert.equal(control.authorize("reduce", startingValue).allowed, false);
    control.releaseKillSwitch("owner", "smoke release");
    assert.equal(control.authorize("reduce", startingValue).allowed, true);

    control.seedDay(startingValue);
    assert.equal(control.drawdownBps(92_000_000n), 800);
    assert.equal(control.authorize("increase", 92_000_000n).allowed, false);

    console.log("Big Pickle smoke test: PASS (no real-money or network operation performed)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSmokeTest().catch((error: unknown) => {
    console.error(`Big Pickle smoke test: FAIL — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
