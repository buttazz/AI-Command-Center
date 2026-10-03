import { strict as nodeAssert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

import { Cockpit, cockpitRoots, COCKPIT_STATE_BASE } from "../src/cockpit/cockpit.js";
import {
  buildCandidate,
  scanTier,
  SIM_STARTING_BALANCES,
  SIM_TARGET_CASH_USDC,
  SimAccount,
} from "../src/cockpit/account.js";
import { MARKET_SYMBOLS, SyntheticMarket, syntheticPriceMicros } from "../src/cockpit/market.js";
import { COCKPIT_HOST, startCockpit, type RunningCockpit } from "../src/cockpit/server.js";
import { Money } from "../src/core/money.js";
import { loadPolicy } from "../src/policy/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const policyPath = resolve(pkgRoot, "config/policy.aggressive.json");
const policy = loadPolicy(policyPath);

const tempDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Entries in the wallet's real runtime state dir, if any. */
function runtimeStateEntries(): string[] {
  const dir = resolve(pkgRoot, "state");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("cockpit simulation roots", () => {
  test("uses exactly state/cockpit/{sovereign,constitution} under the wallet cwd", () => {
    expect(COCKPIT_STATE_BASE).toBe("state/cockpit");
    const roots = cockpitRoots(pkgRoot);
    expect(relative(pkgRoot, roots.sovereign)).toBe("state/cockpit/sovereign");
    expect(relative(pkgRoot, roots.constitution)).toBe("state/cockpit/constitution");
    expect(roots.sovereign).not.toBe(roots.constitution);
    // Defaults resolve against the current working directory.
    const defaults = cockpitRoots();
    expect(relative(process.cwd(), defaults.sovereign)).toBe("state/cockpit/sovereign");
    expect(relative(process.cwd(), defaults.constitution)).toBe("state/cockpit/constitution");
  });

  test("accounts are isolated: separate control plane, audit log and books", () => {
    const base = tempDir("bpw-cockpit-isolation-");
    const sovereign = new SimAccount({
      kind: "sovereign",
      root: join(base, "sovereign"),
      policy,
    });
    const constitution = new SimAccount({
      kind: "constitution",
      root: join(base, "constitution"),
      policy,
    });
    const market = new SyntheticMarket();

    // Equal opening capital, held as exact micro-USDC integers. The $150/$150
    // head-to-head starts both books at the same balance on purpose, so balance
    // is no longer what distinguishes the accounts — see the control-plane and
    // audit-chain assertions below for the actual isolation contract.
    expect(sovereign.cash).toBe(Money.parseUsdc(SIM_STARTING_BALANCES.sovereign).micros);
    expect(constitution.cash).toBe(Money.parseUsdc(SIM_STARTING_BALANCES.constitution).micros);
    expect(sovereign.cash).toBe(constitution.cash);
    expect(sovereign.equityMicros(market)).toBe(sovereign.cash);
    expect(constitution.equityMicros(market)).toBe(constitution.cash);

    // Separate control-plane roots on disk.
    const sovereignKill = join(base, "sovereign", "control", "KILL_SWITCH");
    const constitutionKill = join(base, "constitution", "control", "KILL_SWITCH");
    expect(existsSync(sovereignKill)).toBe(false);
    expect(existsSync(constitutionKill)).toBe(false);
    sovereign.controlAction("kill", "isolation check");
    expect(existsSync(sovereignKill)).toBe(true);
    expect(existsSync(constitutionKill)).toBe(false);
    expect(sovereign.snapshot(market).control.killSwitchEngaged).toBe(true);
    expect(constitution.snapshot(market).control.killSwitchEngaged).toBe(false);

    // Separate audit directories with separate chains.
    const sovereignAudit = join(base, "sovereign", "audit");
    const constitutionAudit = join(base, "constitution", "audit");
    expect(existsSync(sovereignAudit)).toBe(true);
    expect(existsSync(constitutionAudit)).toBe(true);
    nodeAssert.notEqual(sovereignAudit, constitutionAudit);
    const sovereignCashBefore = sovereign.cash;
    for (let i = 0; i < 6; i++) constitution.step(market, market.step());
    // Driving one book must not move a single micro-USDC in the other.
    expect(sovereign.cash).toBe(sovereignCashBefore);
    expect(constitution.cash).toBeLessThan(Money.parseUsdc(SIM_STARTING_BALANCES.constitution).micros);
    const constitutionEntries = readdirSync(constitutionAudit).filter((f) => f.endsWith(".ndjson"));
    expect(constitutionEntries.length).toBeGreaterThan(0);
    const sovereignText = readdirSync(sovereignAudit)
      .filter((f) => f.endsWith(".ndjson"))
      .map((f) => readFileSync(join(sovereignAudit, f), "utf8"))
      .join("");
    expect(sovereignText).toContain("sim.control.kill");
    const constitutionText = constitutionEntries
      .map((f) => readFileSync(join(constitutionAudit, f), "utf8"))
      .join("");
    expect(constitutionText).not.toContain("sim.control.kill");
  });

  test("running the cockpit never writes the wallet's real runtime state", () => {
    const before = runtimeStateEntries();
    const base = tempDir("bpw-cockpit-runtime-");
    const cockpit = new Cockpit({ stateBaseDir: base, policyPath });
    for (let i = 0; i < 30; i++) cockpit.step();
    expect(cockpit.market.tick).toBe(30);
    expect(runtimeStateEntries()).toEqual(before);
    // Everything the cockpit produced lives under its own temp roots.
    expect(cockpit.sovereign.root.startsWith(base)).toBe(true);
    expect(cockpit.constitution.root.startsWith(base)).toBe(true);
    expect(existsSync(join(base, "sovereign", "sim-state.json"))).toBe(true);
    expect(existsSync(join(base, "constitution", "sim-state.json"))).toBe(true);
  });
});

describe("deterministic synthetic market", () => {
  test("prices are pure functions of the tick and visibly change", () => {
    expect(syntheticPriceMicros("BTC", 7)).toBe(syntheticPriceMicros("BTC", 7));
    const atSeven = syntheticPriceMicros("BTC", 7);
    const atEight = syntheticPriceMicros("BTC", 8);
    expect(atEight).not.toBe(atSeven);

    const market = new SyntheticMarket();
    const first = market.quotes().map((q) => q.priceMicros);
    expect(first.length).toBe(MARKET_SYMBOLS.length);
    const ticks = new Set<number>();
    let changed = false;
    for (let i = 0; i < 10; i++) {
      const tick = market.step();
      ticks.add(tick);
      const next = market.quotes().map((q) => q.priceMicros);
      if (JSON.stringify(next.map(String)) !== JSON.stringify(first.map(String))) changed = true;
      for (const q of market.quotes()) {
        // Every quote is a formatted, non-negative synthetic price.
        expect(q.priceUsdc.length).toBeGreaterThan(0);
        expect(q.priceMicros > 0n).toBe(true);
      }
    }
    expect(market.tick).toBe(10);
    expect(ticks.size).toBe(10);
    expect(changed).toBe(true);
  });

  test("the candidate scan is a fixed four-phase cycle", () => {
    expect(scanTier(1)).toBe("none");
    expect(scanTier(2)).toBe("none");
    expect(scanTier(3)).toBe("oversized");
    expect(scanTier(6)).toBe("weak");
    expect(scanTier(9)).toBe("none");
    expect(scanTier(12)).toBe("clean");
    const clean = buildCandidate(12, "BTC");
    expect(clean.tier).toBe("clean");
    expect(clean.sizeBps).toBeLessThan(policy.risk.maxSingleTradeBps);
    const oversized = buildCandidate(3, "BTC");
    expect(oversized.tier).toBe("oversized");
    expect(oversized.sizeBps).toBeGreaterThan(policy.risk.maxSingleTradeBps);
    const weak = buildCandidate(6, "BTC");
    expect(weak.tier).toBe("weak");
    expect(
      weak.expectedGrossEdgeBps - weak.slippageBps - weak.priceImpactBps - policy.execution.assumedFeeBps,
    ).toBeLessThan(policy.execution.minExpectedEdgeBps);
  });
});

describe("constitution decisions", () => {
  test("produces APPROVED, RESIZED, VETOED and NO_TRADE with deterministic reasons", () => {
    const base = tempDir("bpw-cockpit-decisions-");
    const cockpit = new Cockpit({ stateBaseDir: base, policyPath });
    for (let i = 0; i < 120; i++) cockpit.step();

    const snapshot = cockpit.constitution.snapshot(cockpit.market);
    const counts = snapshot.decisionCounts;
    expect(counts["APPROVED"] ?? 0).toBeGreaterThan(0);
    expect(counts["RESIZED"] ?? 0).toBeGreaterThan(0);
    expect(counts["VETOED"] ?? 0).toBeGreaterThan(0);
    expect(counts["NO_TRADE"] ?? 0).toBeGreaterThan(0);

    for (const d of snapshot.decisions) {
      expect(d.simulation).toBe(true);
      expect(d.paper).toBe(true);
      if (d.paperRef !== null) expect(d.paperRef.startsWith("PAPER-")).toBe(true);
      if (d.verdict === "VETOED") {
        expect(d.reasons.length).toBeGreaterThan(0);
        expect(d.rule).not.toBe("none");
      }
      if (d.verdict === "NO_TRADE") expect(d.paperRef).toBeNull();
    }
    // Approved/resized decisions must actually have moved paper money.
    const fills = snapshot.decisions.filter(
      (d) => d.verdict === "APPROVED" || d.verdict === "RESIZED",
    );
    for (const fill of fills) {
      expect(fill.notionalUsdc).not.toBeNull();
      expect(fill.paperRef?.startsWith("PAPER-")).toBe(true);
    }
    expect(cockpit.constitution.fills).toBeGreaterThan(0);
  });

  test("resized decisions stay inside the single-trade limit", () => {
    const base = tempDir("bpw-cockpit-resize-");
    const cockpit = new Cockpit({ stateBaseDir: base, policyPath });
    for (let i = 0; i < 120; i++) cockpit.step();
    const snapshot = cockpit.constitution.snapshot(cockpit.market);
    expect(snapshot.decisionCounts["RESIZED"] ?? 0).toBeGreaterThan(0);
    const resized = snapshot.decisions.filter((d) => d.verdict === "RESIZED");
    for (const d of resized) {
      expect(d.finalBps).not.toBeNull();
      expect(d.finalBps as number).toBeLessThanOrEqual(policy.risk.maxSingleTradeBps);
      expect(d.finalBps as number).toBeLessThan(d.requestedBps as number);
    }
  });

  test("kill switch, freeze and de-risk state surface as vetoes", () => {
    const base = tempDir("bpw-cockpit-control-");
    const cockpit = new Cockpit({ stateBaseDir: base, policyPath });
    for (let i = 0; i < 14; i++) cockpit.step();
    cockpit.constitution.controlAction("kill", "test kill");
    cockpit.step();
    const snapshot = cockpit.constitution.snapshot(cockpit.market);
    expect(snapshot.control.state).toBe("frozen");
    expect(snapshot.control.killSwitchEngaged).toBe(true);
    const last = snapshot.decisions[0];
    nodeAssert.ok(last);
    expect(last.verdict).toBe("VETOED");
    expect(last.rule).toBe("control-frozen");

    cockpit.constitution.controlAction("release", "test release");
    cockpit.constitution.controlAction("freeze", "test freeze");
    cockpit.step();
    const frozen = cockpit.constitution.snapshot(cockpit.market);
    expect(frozen.control.frozen).toBe(true);
    expect(frozen.decisions[0]?.rule).toBe("control-frozen");

    cockpit.constitution.controlAction("resume", "test resume");
    const resumed = cockpit.constitution.snapshot(cockpit.market);
    expect(resumed.control.state).toBe("normal");
    expect(resumed.control.killSwitchEngaged).toBe(false);
    expect(resumed.control.frozen).toBe(false);

    // The sovereign book is untouched by constitution-side control actions.
    expect(cockpit.sovereign.snapshot(cockpit.market).control.killSwitchEngaged).toBe(false);
  });

  test("OWNER_FORCE_RESUME clears only Sovereign cooldown and preserves its book", () => {
    const base = tempDir("bpw-cockpit-owner-override-");
    const cockpit = new Cockpit({ stateBaseDir: base, policyPath });
    const market = cockpit.market;
    for (let i = 0; i < 18; i++) cockpit.step();

    const sovereignBefore = cockpit.sovereign.snapshot(market);
    const constitutionBefore = cockpit.constitution.snapshot(market);
    const sovereignControl = join(cockpit.sovereign.root, "control");
    writeFileSync(
      join(sovereignControl, "cooldown.json"),
      JSON.stringify({
        until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        streak: 3,
        openedAt: new Date().toISOString(),
        reason: "test loss-streak cooldown",
      }),
      { mode: 0o600 },
    );

    const cooldown = cockpit.sovereign.snapshot(market);
    expect(cooldown.control.state).toBe("de-risk");
    expect(cooldown.control.cooldownUntil).not.toBeNull();

    cockpit.sovereign.forceOwnerResume("manual owner test");
    const resumed = cockpit.sovereign.snapshot(market);
    expect(resumed.control.state).toBe("normal");
    expect(resumed.control.cooldownUntil).toBeNull();
    expect(resumed.ownerOverride).toEqual({
      active: true,
      at: expect.any(String),
      by: "owner",
      reason: "manual owner test",
    });
    expect(resumed.cashUsdc).toBe(sovereignBefore.cashUsdc);
    expect(resumed.realizedPnlUsdc).toBe(sovereignBefore.realizedPnlUsdc);
    expect(resumed.tradeCount).toBe(sovereignBefore.tradeCount);
    expect(resumed.positions).toEqual(sovereignBefore.positions);
    expect(resumed.activity.some((entry) => entry.action === "OWNER_OVERRIDE")).toBe(true);

    // The override is an actual manual gate: the next Sovereign step may enter
    // paper risk immediately, while Constitution remains entirely unchanged.
    const fillsBeforeResumeSteps = resumed.fillCount;
    for (let i = 0; i < 6; i++) cockpit.step();
    const sovereignAfterResumeSteps = cockpit.sovereign.snapshot(cockpit.market);
    expect(sovereignAfterResumeSteps.fillCount).toBeGreaterThan(fillsBeforeResumeSteps);
    const constitutionAfter = cockpit.constitution.snapshot(cockpit.market);
    expect(constitutionAfter.ownerOverride.active).toBe(false);
    expect(constitutionAfter.control.cooldownUntil).toBe(constitutionBefore.control.cooldownUntil);
    expect(constitutionAfter.control.killSwitchEngaged).toBe(constitutionBefore.control.killSwitchEngaged);
  });

  test("OWNER_FORCE_RESUME is Sovereign-only and never bypasses a stop", () => {
    const base = tempDir("bpw-cockpit-owner-boundary-");
    const cockpit = new Cockpit({ stateBaseDir: base, policyPath });

    expect(() => cockpit.constitution.forceOwnerResume("must fail")).toThrow(
      "SOVEREIGN account only",
    );

    cockpit.sovereign.controlAction("freeze", "owner boundary test");
    expect(() => cockpit.sovereign.forceOwnerResume("must not bypass freeze")).toThrow(
      "kill switch or freeze",
    );
    expect(cockpit.sovereign.snapshot(cockpit.market).control.frozen).toBe(true);
  });

  test("reset returns a book to the starting balance without touching the other", () => {
    const base = tempDir("bpw-cockpit-reset-");
    const cockpit = new Cockpit({ stateBaseDir: base, policyPath });
    for (let i = 0; i < 40; i++) cockpit.step();
    const constitutionBefore = cockpit.constitution.snapshot(cockpit.market);
    const sovereignBefore = cockpit.sovereign.snapshot(cockpit.market);

    cockpit.sovereign.reset();
    const sovereignAfter = cockpit.sovereign.snapshot(cockpit.market);
    const constitutionAfter = cockpit.constitution.snapshot(cockpit.market);

    expect(sovereignAfter.startingBalanceUsdc).toBe(sovereignBefore.startingBalanceUsdc);
    expect(sovereignAfter.positions).toHaveLength(0);
    expect(sovereignAfter.tradeCount).toBe(0);
    expect(sovereignAfter.control.killSwitchEngaged).toBe(false);
    expect(constitutionAfter.positions).toHaveLength(constitutionBefore.positions.length);
    expect(constitutionAfter.fillCount).toBe(constitutionBefore.fillCount);
    expect(constitutionAfter.decisions.length).toBe(constitutionBefore.decisions.length);
  });
});

describe("cockpit source hygiene", () => {
  test("cockpit never imports live-trading, credential or RPC modules", () => {
    const sourceDir = resolve(pkgRoot, "src", "cockpit");
    const files = readdirSync(sourceDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const forbidden =
      /from\s+["'][^"']*(?:\/cdp\/|\/executor\/|secrets\/vault|pipeline\/attestation|big-pickle-trader|@coinbase\/|viem)/;
    const network =
      /from\s+["'](?:node:(?:dgram|dns|tls|net|https|http2)|dgram|dns|tls|net|https?:)["']/;
    for (const file of files) {
      const text = readFileSync(join(sourceDir, file), "utf8");
      expect(forbidden.test(text), `${file} must not import live/credential modules`).toBe(false);
      expect(network.test(text), `${file} must not open a network transport`).toBe(false);
    }
    const server = readFileSync(join(sourceDir, "server.ts"), "utf8");
    expect(server).toContain('from "node:http"');
    expect(server).toContain("COCKPIT_HOST");
    expect(server).toContain('127.0.0.1');
  });

  test("runtime secrets stay ignored while src/secrets/vault.ts is trackable", () => {
    const repoRoot = resolve(pkgRoot, "..");
    const check = (path: string): boolean => {
      try {
        execFileSync("git", ["check-ignore", "-q", path], { cwd: repoRoot });
        return true;
      } catch (error) {
        const err = error as { status?: number };
        if (err.status === 1) return false;
        throw error;
      }
    };
    expect(check("big-pickle-wallet/src/secrets/vault.ts")).toBe(false);
    expect(check("big-pickle-wallet/secrets/wallet.vault")).toBe(true);
    expect(check("secrets/wallet.vault")).toBe(true);
    expect(check("big-pickle-wallet/state/cockpit/sovereign/sim-state.json")).toBe(true);
    expect(check("big-pickle-wallet/.env")).toBe(true);
  });
});

describe("cockpit HTTP API (loopback only)", () => {
  let running: RunningCockpit | null = null;

  afterAll(async () => {
    if (running) await running.close();
  });

  test("serves the dashboard and a paper-only state API on 127.0.0.1", async () => {
    const base = tempDir("bpw-cockpit-api-");
    running = await startCockpit({
      port: 0,
      stateBaseDir: base,
      policyPath,
      intervalMs: 600_000, // keep the auto loop quiet so assertions are stable
    });

    const address = running.server.address();
    nodeAssert.ok(address && typeof address === "object");
    expect(address.address).toBe(COCKPIT_HOST);
    expect(COCKPIT_HOST).toBe("127.0.0.1");

    const page = await fetch(running.url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("SIMULATION");
    expect(html).toContain("PAPER TRADING");
    expect(html).toContain("NO LIVE FUNDS");

    const css = await fetch(new URL("/style.css", running.url));
    expect(css.status).toBe(200);
    const js = await fetch(new URL("/app.js", running.url));
    expect(js.status).toBe(200);
    expect(await js.clone().text()).toContain("OWNER FORCE RESUME");

    // Drive the local simulation so the payload carries real decisions.
    for (let i = 0; i < 15; i++) {
      const stepped = await fetch(new URL("/api/sim/step", running.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(stepped.status).toBe(200);
    }

    const stateRes = await fetch(new URL("/api/state", running.url));
    expect(stateRes.status).toBe(200);
    const state = (await stateRes.json()) as {
      simulation: boolean;
      paper: boolean;
      liveFunds: boolean;
      tick: number;
      market: { quotes: { symbol: string; priceUsdc: string }[] };
      accounts: {
        id: string;
        startingBalanceUsdc: string;
        equityUsdc: string;
        positions: unknown[];
        decisions: { paperRef: string | null; simulation: boolean }[];
        drawdownBps: number;
        remainingDailyLossBudgetUsdc: string;
      }[];
    };

    expect(state.simulation).toBe(true);
    expect(state.paper).toBe(true);
    expect(state.liveFunds).toBe(false);
    expect(state.accounts).toHaveLength(2);
    const sovereign = state.accounts.find((a) => a.id === "sovereign");
    const constitution = state.accounts.find((a) => a.id === "constitution");
    nodeAssert.ok(sovereign && constitution);
    // Equal capital: both prototypes start the $150/$150 head-to-head. The
    // accounts stay fully isolated — same opening balance, independent books.
    expect(sovereign.startingBalanceUsdc).toBe("150");
    expect(constitution.startingBalanceUsdc).toBe("150");
    expect(sovereign.startingBalanceUsdc).toBe(constitution.startingBalanceUsdc);
    expect(sovereign.equityUsdc).not.toBe(constitution.equityUsdc);
    // Constitution surfaces the governance numbers the dashboard requires.
    expect(constitution.remainingDailyLossBudgetUsdc.length).toBeGreaterThan(0);
    expect(constitution.drawdownBps).toBeGreaterThanOrEqual(0);
    expect(state.market.quotes.length).toBe(3);

    // The manual owner route is explicit and Sovereign-only.
    writeFileSync(
      join(running.cockpit.sovereign.root, "control", "cooldown.json"),
      JSON.stringify({ until: new Date(Date.now() + 60 * 60 * 1000).toISOString(), streak: 3 }),
      { mode: 0o600 },
    );
    const ownerResume = await fetch(new URL("/api/sim/sovereign/force-resume", running.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "OWNER_FORCE_RESUME", reason: "HTTP owner test" }),
    });
    expect(ownerResume.status).toBe(200);
    const resumedState = (await (await fetch(new URL("/api/state", running.url))).json()) as {
      accounts: { id: string; ownerOverride: { active: boolean }; control: { state: string; cooldownUntil: string | null } }[];
    };
    const resumedSovereign = resumedState.accounts.find((a) => a.id === "sovereign");
    const untouchedConstitution = resumedState.accounts.find((a) => a.id === "constitution");
    nodeAssert.ok(resumedSovereign && untouchedConstitution);
    expect(resumedSovereign.ownerOverride.active).toBe(true);
    expect(resumedSovereign.control.state).toBe("normal");
    expect(resumedSovereign.control.cooldownUntil).toBeNull();
    expect(untouchedConstitution.ownerOverride.active).toBe(false);

    const constitutionRoute = await fetch(new URL("/api/sim/constitution/force-resume", running.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "OWNER_FORCE_RESUME" }),
    });
    expect(constitutionRoute.status).toBe(404);

    // Every order reference is explicitly paper, and no tx hash exists anywhere.
    const raw = JSON.stringify(state);
    const collectRefs = (value: unknown, out: string[]): void => {
      if (Array.isArray(value)) {
        value.forEach((v) => collectRefs(v, out));
        return;
      }
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (k === "paperRef" && typeof v === "string") out.push(v);
          else collectRefs(v, out);
        }
      }
    };
    const refs: string[] = [];
    collectRefs(state, refs);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref.startsWith("PAPER-")).toBe(true);
    expect(raw).not.toContain("txHash");
    expect(raw).not.toMatch(/"hash"\s*:/);

    // A local step advances the loop; no live endpoint exists by design.
    const before = state.tick;
    const step = await fetch(new URL("/api/sim/step", running.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const stepBody = (await step.json()) as { ok: boolean; tick: number };
    expect(stepBody.ok).toBe(true);
    expect(stepBody.tick).toBe(before + 1);

    const trade = await fetch(new URL("/api/trade", running.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side: "buy" }),
    });
    expect(trade.status).toBe(404);
    const tradeBody = (await trade.json()) as { note?: string };
    expect(tradeBody.note).toContain("no live-trade endpoint");

    const health = (await (await fetch(new URL("/api/health", running.url))).json()) as {
      liveTradeEndpoint: boolean;
      host: string;
    };
    expect(health.liveTradeEndpoint).toBe(false);
    expect(health.host).toBe("127.0.0.1");

    await running.close();
    running = null;
  });
});

describe("settled-cash target", () => {
  test("latches on settled cash, locks new entries, and prepares a non-executed sweep", () => {
    const base = tempDir("bpw-target-");
    // A target just above the opening balance, so a handful of profitable exits
    // can cross it. The engines' own rules are untouched.
    const account = new SimAccount({
      kind: "sovereign",
      root: join(base, "sovereign"),
      policy,
      startingBalanceUsdc: "150",
      targetCashUsdc: "151",
    });
    const market = new SyntheticMarket();

    // Before the target: nothing is locked and the gate is inactive.
    const before = account.snapshot(market);
    expect(before.target.targetCashUsdc).toBe("151");
    expect(before.target.status).toBe("ACTIVE");
    expect(before.target.reached).toBe(false);
    expect(before.target.ownerSweep).toBeNull();
    expect(before.target.elapsedTicks).toBe(0);

    // Run until the latch fires.
    let reachedAtTick: number | null = null;
    for (let i = 0; i < 400 && reachedAtTick === null; i++) {
      const tick = market.step();
      account.step(market, tick);
      if (account.isTargetLocked) reachedAtTick = tick;
    }
    nodeAssert.ok(reachedAtTick !== null, "target should have been reached");

    const after = account.snapshot(market);
    expect(after.target.status).toBe("REACHED");
    expect(after.target.reached).toBe(true);
    expect(after.target.reachedTick).toBe(reachedAtTick);
    expect(after.target.elapsedTicks).toBeGreaterThan(0);

    // It was settled CASH that crossed the line, not equity or open value.
    expect(Number(after.target.currentCashUsdc)).toBeGreaterThanOrEqual(151);
    const final = after.target.final;
    nodeAssert.ok(final);
    expect(Number(final.cashUsdc)).toBeGreaterThanOrEqual(151);
    expect(final.simulation).toBe(true);
    expect(final.paper).toBe(true);
    expect(final.grossTurnoverUsdc.length).toBeGreaterThan(0);

    // The sweep is prepared and explicitly never executed.
    const sweep = after.target.ownerSweep;
    nodeAssert.ok(sweep);
    expect(sweep.executed).toBe(false);
    expect(sweep.live).toBe(false);
    expect(sweep.transferPerformed).toBe(false);
    expect(Number(sweep.sweepableCashUsdc)).toBeGreaterThanOrEqual(151);

    // Locked for good: run far longer and no new position may be opened.
    const fillsAtLatch = after.fillCount;
    const cashAtLatch = after.cashUsdc;
    for (let i = 0; i < 300; i++) {
      const tick = market.step();
      account.step(market, tick);
    }
    const later = account.snapshot(market);
    expect(later.fillCount).toBe(fillsAtLatch);
    // Cash can drift down via an open position's stop-out, but the latch holds
    // and no fresh capital is ever deployed again.
    expect(later.target.reached).toBe(true);
    expect(later.target.reachedTick).toBe(reachedAtTick);
    expect(later.target.final?.tick).toBe(reachedAtTick);
    expect(cashAtLatch.length).toBeGreaterThan(0);
  });

  test("target does not count turnover, equity or unrealised P&L", () => {
    const base = tempDir("bpw-target-basis-");
    const account = new SimAccount({
      kind: "sovereign",
      root: join(base, "sovereign"),
      policy,
      startingBalanceUsdc: "150",
      // Unreachable: proves a large turnover/equity figure alone never latches.
      targetCashUsdc: "100000",
    });
    const market = new SyntheticMarket();
    for (let i = 0; i < 400; i++) {
      const tick = market.step();
      account.step(market, tick);
    }
    const s = account.snapshot(market);
    expect(s.target.status).toBe("ACTIVE");
    expect(s.target.reached).toBe(false);
    // Large turnover and a real equity figure were both generated, yet neither
    // moved the gate: only settled cash counts.
    expect(Number(s.grossTurnoverUsdc)).toBeGreaterThan(150);
    expect(s.fillCount).toBeGreaterThan(0);
    expect(Number(s.target.currentCashUsdc)).toBeLessThan(100000);
    expect(Number(s.equityUsdc)).toBeLessThan(100000);
    expect(Number(s.target.progressPct)).toBeLessThan(100);
  });

  test("default target is $1,500 and both cockpit books get the same one", () => {
    const base = tempDir("bpw-target-default-");
    const sovereign = new SimAccount({
      kind: "sovereign",
      root: join(base, "sovereign"),
      policy,
    });
    expect(sovereign.snapshot(new SyntheticMarket()).target.targetCashUsdc).toBe(
      SIM_TARGET_CASH_USDC,
    );
    expect(SIM_TARGET_CASH_USDC).toBe("1500");

    const cockpit = new Cockpit({ stateBaseDir: base });
    const a = cockpit.sovereign.snapshot(cockpit.market).target.targetCashUsdc;
    const b = cockpit.constitution.snapshot(cockpit.market).target.targetCashUsdc;
    expect(a).toBe(b);
    expect(a).toBe(SIM_TARGET_CASH_USDC);
  });

  test("reset clears the latch and the elapsed clock", () => {
    const base = tempDir("bpw-target-reset-");
    const account = new SimAccount({
      kind: "sovereign",
      root: join(base, "sovereign"),
      policy,
      startingBalanceUsdc: "150",
      targetCashUsdc: "151",
    });
    const market = new SyntheticMarket();
    for (let i = 0; i < 400; i++) {
      const tick = market.step();
      account.step(market, tick);
      if (account.isTargetLocked) break;
    }
    expect(account.isTargetLocked).toBe(true);
    account.reset();
    const fresh = account.snapshot(market);
    expect(fresh.target.status).toBe("ACTIVE");
    expect(fresh.target.reached).toBe(false);
    expect(fresh.target.final).toBeNull();
    expect(fresh.target.ownerSweep).toBeNull();
    expect(fresh.cashUsdc).toBe("150");
  });
});
