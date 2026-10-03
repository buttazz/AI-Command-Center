/**
 * Prediction-market experiment orchestrator (PAPER ONLY).
 *
 * Deterministic by construction: uses a fixture clock and fixture provider.
 * Integrates estimator, opportunity builder, Constitution, paper executor,
 * accounting bank, audit log, and control plane.
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AuditLog, correlationId } from "../audit/audit-log.js";
import { ControlPlane, defaultControlPaths } from "../control/control-plane.js";
import { Money } from "../core/money.js";
import { loadPolicy, type Policy } from "../policy/schema.js";
import {
  FixturePredictionProvider,
  FIXTURE_PROVIDER_ID,
} from "./fixtures/provider.js";
import {
  FixtureResearchModel,
  MarketImpliedEstimator,
  type ProbabilityEstimator,
} from "./estimator.js";
import { buildOpportunity } from "./opportunity.js";
import {
  askConstitution,
  recordRefusal,
  syntheticContractAddress,
  type PredictionConstitutionResult,
  type PredictionPortfolioFacts,
} from "./constitution.js";
import { PaperBank, SURVIVAL_STARTING_CASH_MICROS } from "./accounting.js";
import { PaperExecutor } from "./execution.js";
import { FIXTURE_MARKETS, FIXTURE_PRIMARY_OUTCOME } from "./fixtures/fixtures.js";
import type {
  PaperFill,
  PaperOrder,
  PaperPosition,
  PredictionDecision,
  PredictionOpportunity,
} from "./types.js";

export interface PredictionExperimentOptions {
  policy: Policy;
  provider: FixturePredictionProvider;
  workingDir?: string;
  estimator?: ProbabilityEstimator;
  auditRoot?: string;
  controlRoot?: string;
}

export interface RunOptions {
  ticks?: number;
  sample?: number;
  startTick?: number;
}

export interface StepResult {
  tick: number;
  decisions: PredictionDecision[];
  orders: PaperOrder[];
  fills: PaperFill[];
  positions: PaperPosition[];
  summary: {
    equityMicros: bigint;
    availableMicros: bigint;
    openPositions: number;
    decisions: number;
    fills: number;
    refusals: number;
  };
}

export interface ExperimentRunResult {
  decisions: PredictionDecision[];
  orders: PaperOrder[];
  fills: PaperFill[];
  positions: PaperPosition[];
  summary: {
    ticks: number;
    decisions: number;
    approved: number;
    resized: number;
    vetoed: number;
    noTrade: number;
    fills: number;
    openPositions: number;
    equityMicros: bigint;
    bankrollBps: number;
    decisionCounts: Record<string, number>;
    rejectionCounts: Record<string, number>;
  };
}

function bump(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

export class PredictionExperiment {
  readonly policy: Policy;
  readonly provider: FixturePredictionProvider;
  readonly bank: PaperBank;
  readonly executor: PaperExecutor;
  readonly audit: AuditLog;
  readonly control: ControlPlane;
  readonly estimator: ProbabilityEstimator;
  private orders: PaperOrder[] = [];
  private decisions: PredictionDecision[] = [];
  private idPrefix = correlationId().slice(0, 12);

  constructor(opts: PredictionExperimentOptions) {
    this.policy = opts.policy;
    this.provider = opts.provider;

    const working = opts.workingDir ?? resolve(".tmp-prediction-experiment");
    rmSync(working, { recursive: true, force: true });
    mkdirSync(working, { recursive: true });
    mkdirSync(resolve(working, "audit"), { recursive: true });
    mkdirSync(resolve(working, "control"), { recursive: true });

    this.audit = new AuditLog(opts.auditRoot ?? resolve(working, "audit"));
    this.control = new ControlPlane(
      this.policy,
      defaultControlPaths(opts.controlRoot ?? resolve(working, "control")),
    );

    this.bank = new PaperBank({ nowIso: this.provider.nowIso() });

    const research = new Map(
      FIXTURE_MARKETS.map((m) => [
        m.marketId,
        {
          probabilityBps: m.modelProbabilityBps,
          confidence: m.modelConfidence,
          note: m.scenario,
        },
      ]),
    );
    this.estimator =
      opts.estimator ??
      new ConsensusEstimatorOrFallback(
        new FixtureResearchModel(research),
        new MarketImpliedEstimator(),
      );

    this.executor = new PaperExecutor(this.policy);
  }

  async init(): Promise<void> {
    // no-op; provider already initialized
  }

  async step(tick: number): Promise<StepResult> {
    this.provider.advance();
    const nowIso = this.provider.nowIso();
    const marks = new Map<string, bigint>();

    // mark open positions to mid price if known
    for (const p of this.bank.positions()) {
      const mid = this.provider.midPrice(p.contractId);
      if (mid) marks.set(p.contractId, mid);
    }
    this.bank.markAll(marks);

    const decisions: PredictionDecision[] = [];
    const fills: PaperFill[] = [];

    // advance existing orders
    const remainingOrders: PaperOrder[] = [];
    for (const order of this.orders) {
      const book = this.provider.rawBook(order.contractId);
      const prints = this.provider.rawPrints(order.contractId);
      const adv = this.executor.advance({
        order,
        book: book as any ?? null,
        prints,
        tick,
        nowIso,
      });
      for (const f of adv.fills) {
          const m = await this.provider.getMarket(order.marketId);
          if (m) {
            const c = m.contracts.find((x: any) => x.contractId === f.contractId);
            fills.push(f);
            this.bank.applyFill(f, {
              market: m as any,
              correlationGroup: c?.correlationGroup ?? "",
              question: c?.question ?? m.question,
              category: c?.category ?? m.category,
            });
            this.audit.append("prediction.fill", "executor", "paper-executor", {
              paperRef: f.paperRef,
              contractId: f.contractId,
              qtyAtomic: f.qtyAtomic.toString(),
              priceMicros: f.priceMicros.toString(),
              feeMicros: f.feeMicros.toString(),
            });
          }
      }
      if (adv.releaseMicros) this.bank.release(adv.releaseMicros);
      const status = this.executor.finalStatus(
        {
          ...order,
          filledQtyAtomic:
            order.filledQtyAtomic +
            adv.fills.reduce((a, x) => a + x.qtyAtomic, 0n),
        } as any,
        adv.fills.length > 0 || adv.releaseMicros > 0n,
      );
      const updated: PaperOrder = {
        ...order,
        filledQtyAtomic:
          order.filledQtyAtomic +
          adv.fills.reduce((a, x) => a + x.qtyAtomic, 0n),
        status: status as PaperOrder["status"],
        updatedAt: nowIso,
        statusReason:
          adv.statusReason ?? order.statusReason,
      };
      if (updated.status === "resting" || updated.status === "partially-filled") {
        remainingOrders.push(updated);
      }
    }
    this.orders = remainingOrders;

    // scan sample of markets
    const markets = await this.provider.listMarkets();
    const sample = Math.min(markets.length, 6);
    for (let i = 0; i < sample; i++) {
      const m = markets[i] as any;
      const c = m.contracts[0] as any;
      if (!c) continue;
      const quote = await this.provider.getQuote(c.contractId, FIXTURE_PRIMARY_OUTCOME);
      const book = await this.provider.getOrderBook(c.contractId, FIXTURE_PRIMARY_OUTCOME);
      const trades = await this.provider.getRecentTrades(c.contractId);
      if (!quote || !book) continue;

      const est = this.estimator.estimate({
        market: m,
        contract: c,
        outcomeId: FIXTURE_PRIMARY_OUTCOME,
        quote,
        book,
        trades,
        nowMs: this.provider.nowMs(),
      });

      const ctx = this.buildContext();
      const opp = buildOpportunity({
        market: m,
        contract: c,
        quote,
        book,
        estimate: est,
        outcomeId: FIXTURE_PRIMARY_OUTCOME,
        intent: (this.policy.prediction?.allowMaker ?? true) ? "maker" : "taker",
        nowMs: this.provider.nowMs(),
        context: ctx,
      });

      if (!opp.accepted || !opp.opportunity) {
        const d = recordRefusal({
          idPrefix: this.idPrefix,
          nowIso,
          opportunityId: opp.opportunityId,
          provider: m.provider,
          marketId: m.marketId,
          contractId: c.contractId,
          outcomeId: FIXTURE_PRIMARY_OUTCOME,
          question: c.question,
          category: c.category,
          rejections: opp.rejections,
          notes: opp.notes,
          netExpectedEdgeBps: opp.edge?.netExpectedEdgeBps ?? null,
          intent: opp.opportunity?.intent ?? null,
        });
        decisions.push(d);
        this.decisions.push(d);
        this.audit.append("prediction.decision", "big-pickle", "paper", {
          verdict: d.verdict,
          marketId: m.marketId,
          rule: d.rule,
        });
        continue;
      }

      const res = askConstitution({
        opportunity: opp.opportunity,
        policy: this.policy,
        portfolio: this.buildPortfolio(c, quote.mid),
        nowIso,
        idPrefix: this.idPrefix,
      });
      decisions.push(res.decision);
      this.decisions.push(res.decision);
      this.audit.append("prediction.decision", "big-pickle", "paper", {
        verdict: res.decision.verdict,
        marketId: m.marketId,
        rule: res.decision.rule,
        notionalMicros: res.decision.notionalMicros,
      });

      if (res.decision.verdict === "APPROVED" || res.decision.verdict === "RESIZED") {
        if (res.finalQtyAtomic && res.notionalMicros) {
          const feeBps = opp.opportunity.intent === "taker"
            ? this.policy.prediction?.fees.takerFeeBps ?? 0
            : this.policy.prediction?.fees.makerFeeBps ?? 0;
          const flat = this.policy.prediction?.fees.flatFeeMicrosPerContract ?? 0n;
          const ord = this.executor.place({
            proposalId: res.proposal?.id ?? `pred-${this.idPrefix}-${m.marketId}`,
            provider: m.provider,
        market: m as any,
            contractId: c.contractId,
            outcomeId: FIXTURE_PRIMARY_OUTCOME,
            intent: opp.opportunity.intent,
            qtyAtomic: res.finalQtyAtomic,
            limitPriceMicros: opp.opportunity.intent === "maker" ? quote.bestBid : undefined,
            referencePriceMicros: quote.mid,
            book,
            tick,
            nowIso,
          });
          this.bank.reserve(ord.reservedMicros);
          this.orders.push(ord);
          this.audit.append("prediction.order.placed", "executor", "paper-executor", {
            paperRef: ord.paperRef,
            contractId: c.contractId,
            qtyAtomic: ord.qtyAtomic.toString(),
          });
        }
      }
    }

    return {
      tick,
      decisions,
      orders: [...this.orders],
      fills,
      positions: this.bank.positions() as any,
      summary: {
        equityMicros: this.bank.equityMicros(marks),
        availableMicros: this.bank.availableMicros,
        openPositions: this.bank.positions().length,
        decisions: decisions.length,
        fills: fills.length,
        refusals: decisions.filter((d) => d.verdict === "NO_TRADE" || d.verdict === "VETOED").length,
      },
    };
  }

  async run(opts: RunOptions = {}): Promise<ExperimentRunResult> {
    const ticks = opts.ticks ?? 12;
    const start = opts.startTick ?? 0;
    for (let t = start + 1; t <= start + ticks; t++) {
      await this.step(t);
    }
    const marks = new Map<string, bigint>();
    for (const p of this.bank.positions()) {
      const mid = this.provider.midPrice(p.contractId);
      if (mid) marks.set(p.contractId, mid);
    }
    const equity = this.bank.equityMicros(marks);
    const bankroll = SURVIVAL_STARTING_CASH_MICROS;
    const counts: Record<string, number> = {};
    const rej: Record<string, number> = {};
    for (const d of this.decisions) {
      bump(counts, d.verdict);
      if (d.rule) bump(rej, d.rule);
      for (const r of d.rejectionReasons) bump(rej, r);
      for (const r of d.reasons) bump(rej, r);
    }
    return {
      decisions: this.decisions,
      orders: this.orders,
      fills: this.bank.fills() as any,
      positions: this.bank.positions() as any,
      summary: {
        ticks,
        decisions: this.decisions.length,
        approved: counts.APPROVED ?? 0,
        resized: counts.RESIZED ?? 0,
        vetoed: counts.VETOED ?? 0,
        noTrade: counts.NO_TRADE ?? 0,
        fills: this.bank.fills().length,
        openPositions: this.bank.positions().length,
        equityMicros: equity,
        bankrollBps: bankroll > 0n ? Number((equity * 10_000n) / bankroll) : 0,
        decisionCounts: counts,
        rejectionCounts: rej,
      },
    };
  }

  private buildContext() {
    const marks = new Map<string, bigint>();
    for (const p of this.bank.positions()) {
      const mid = this.provider.midPrice(p.contractId);
      if (mid) marks.set(p.contractId, mid);
    }
    const equity = this.bank.equityMicros(marks);
    return {
      policy: this.policy,
      controlVerdict: this.control.authorize('buy' as any, equity),
      drawdownBps: this.bank.drawdownBps(marks),
      dayLossBps: this.bank.dayLossBps(marks),
      openExposureMicros: this.bank.openExposureMicros(),
      totalEquityMicros: equity,
      deployableMicros: this.bank.availableMicros,
      openPredictionPositions: this.bank.positions().length,
    };
  }

  private buildPortfolio(contract: any, mid: bigint): PredictionPortfolioFacts {
    const marks = new Map<string, bigint>();
    for (const p of this.bank.positions()) {
      const m2 = this.provider.midPrice(p.contractId);
      if (m2) marks.set(p.contractId, m2);
    }
    const equity = this.bank.equityMicros(marks);
    return {
      totalValue: Money.fromMicros(equity),
      deployable: Money.fromMicros(this.bank.availableMicros),
      gasReserveWei: 0n,
      currentGasPriceWei: 0n,
      openPositions: this.bank.toOpenPositionViews(marks),
      openExposure: Money.fromMicros(this.bank.openExposureMicros()),
      deployedTodayMicros: 0n,
      volume24hMicros: 0n,
      topOfBookLiquidityMicros: 0n,
      openPredictionPositions: this.bank.positions().length,
      categoryExposureMicros: this.bank.categoryExposureMicros(contract.category),
      correlationGroupExposureMicros: this.bank.correlationGroupExposureMicros(
        contract.correlationGroup,
      ),
      correlationToOpenBps: 0,
    };
  }
}

class ConsensusEstimatorOrFallback implements ProbabilityEstimator {
  readonly name = "consensus-or-fallback";
  constructor(
    private primary: ProbabilityEstimator,
    private fallback: ProbabilityEstimator,
  ) {}
  estimate(input: any) {
    const v = this.primary.estimate(input);
    return v ?? this.fallback.estimate(input);
  }
}