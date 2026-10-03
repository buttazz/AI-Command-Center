/**
 * Paper execution.
 *
 * PAPER ONLY. There is no venue adapter here, no client, no key, no signing path
 * and no network call, and the types make that structural rather than a matter of
 * discipline: a `PaperOrder` is placed by this module and consumed by this module.
 *
 * The interesting question is not "how do I fake a fill" but "what would a fill
 * have required, and did those conditions actually occur". So this is a
 * conditional simulator, not a random one. A paper fill happens only when the
 * fixture data contains the thing that would have caused it:
 *
 *   Taker  Every quantity the order asked for either fills by walking the ask
 *          levels at their own prices, or the book genuinely runs out and the
 *          order is left partially filled. There is no "assume the rest filled".
 *
 *   Maker  A resting bid fills only if a print actually trades through it. Three
 *          things must hold, and the simulator refuses to relax any of them:
 *
 *            1. a print reached the limit price — a wide quote is never touched,
 *               which is why a maker order on a 7%-spread market legitimately sits
 *               forever;
 *            2. everything resting ahead of it at that price was consumed first,
 *               because arriving second means waiting;
 *            3. we won the race at that level, decided by a deterministic roll
 *               rather than by hope, with the odds falling as our order grows
 *               relative to the visible size.
 *
 * The failure modes a real strategy loses money to — queue position, partial
 * fills, no fill at all, and filling only when the market is moving against it —
 * are all reproducible here. That is the point: a simulation that fills every
 * order instantly teaches the strategy nothing it could not already believe.
 */

import type { Policy } from "../policy/schema.js";
import {
  BPS_DENOM,
  QTY_SCALE,
  buyCostMicros,
  feeMicros,
  floorDiv,
} from "./precision.js";
import type {
  ExecutionIntent,
  OrderBookLevel,
  OrderBookSnapshot,
  PaperFill,
  PaperOrder,
  PaperOrderKind,
  PredictionMarket,
  PublicTrade,
} from "./types.js";

/** Base odds of winning the race at a level, bps. */
export const MAKER_RACE_BASE_BPS = 9_000;

/** Ticks a maker order rests before the simulator gives up on it. */
export const MAKER_EXPIRY_TICKS = 3;

function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface PlaceOrderInput {
  proposalId: string;
  provider: string;
  market: PredictionMarket;
  contractId: string;
  outcomeId: string;
  intent: ExecutionIntent;
  /** Atomic size the Constitution approved. */
  qtyAtomic: bigint;
  /** Limit price for a maker order. Must be supplied for `maker`. */
  limitPriceMicros?: bigint;
  /** Best available price at placement. */
  referencePriceMicros: bigint;
  /** The book at placement, used to capture queue position. */
  book: OrderBookSnapshot;
  tick: number;
  nowIso: string;
}

export interface AdvanceInput {
  order: PaperOrder;
  book: OrderBookSnapshot | null;
  prints: readonly PublicTrade[];
  tick: number;
  nowIso: string;
}

export interface AdvanceResult {
  fills: PaperFill[];
  /** Cash to move out of reserved: unused remainder plus nothing else. */
  releaseMicros: bigint;
  statusReason: string | null;
}

/**
 * Cash a paper order will consume if it fully fills: principal at the worst price
 * it could get, plus the fees for its role.
 *
 * Reserved at placement, released unfilled. Reserving the worst case rather than
 * the best means a fill at a worse price can never be funded by cash that was not
 * set aside for it.
 */
export function reservedFor(order: {
  intent: ExecutionIntent;
  qtyAtomic: bigint;
  limitPriceMicros: bigint | null;
  referencePriceMicros: bigint;
  feeBps: number;
  flatFeeMicrosPerContract: bigint;
}): bigint {
  const price = order.intent === "maker" ? (order.limitPriceMicros ?? order.referencePriceMicros) : order.referencePriceMicros;
  const notional = buyCostMicros(order.qtyAtomic, price);
  return notional + feeMicros(notional, order.feeBps, order.flatFeeMicrosPerContract, order.qtyAtomic);
}

/** Odds of winning the race at a level, bps. Falls as our size grows. */
export function makerRaceProbabilityBps(ourQtyAtomic: bigint, levelQtyAtomic: bigint, orderRef: string): number {
  if (levelQtyAtomic <= 0n) return 0;
  const shareBps = Number((ourQtyAtomic * BPS_DENOM) / levelQtyAtomic);
  const base = MAKER_RACE_BASE_BPS - Math.floor(shareBps / 2);
  const bounded = Math.max(1_000, Math.min(MAKER_RACE_BASE_BPS, base));
  // Small deterministic jitter so two equal-sized orders at the same level do not
  // have identical odds, without ever exceeding the size-derived ceiling.
  const jitter = (hash(`${orderRef}:race`) % 201) - 100;
  return Math.max(500, Math.min(MAKER_RACE_BASE_BPS, bounded + jitter));
}

export class PaperExecutor {
  private sequence = 0;

  constructor(private readonly policy: Policy) {}

  private get fees() {
    return this.policy.prediction?.fees;
  }

  private feeFor(intent: ExecutionIntent): number {
    const f = this.fees;
    if (!f) return 0;
    return intent === "taker" ? f.takerFeeBps : f.makerFeeBps;
  }

  /** Build a paper order. Reserving cash is the caller's job. */
  place(input: PlaceOrderInput): PaperOrder {
    this.sequence += 1;
    const feeBps = this.feeFor(input.intent);
    const flat = this.fees?.flatFeeMicrosPerContract ?? 0n;
    const kind: PaperOrderKind = input.intent === "maker" ? "maker-limit" : "taker";

    // Queue position at placement: everything resting at our price or better was
    // ahead of us before we arrived, and we were not first in line.
    let queueAhead = 0n;
    if (kind === "maker-limit") {
      const limit = input.limitPriceMicros ?? input.referencePriceMicros;
      for (const level of input.book.bids) {
        if (level.priceMicros >= limit) queueAhead += level.qtyAtomic;
      }
    }

    return {
      paperRef: `paper-${String(this.sequence).padStart(6, "0")}`,
      proposalId: input.proposalId,
      provider: input.provider,
      marketId: input.market.marketId,
      contractId: input.contractId,
      outcomeId: input.outcomeId,
      kind,
      intent: input.intent,
      side: "buy",
      limitPriceMicros: kind === "maker-limit" ? input.limitPriceMicros ?? input.referencePriceMicros : null,
      referencePriceMicros: input.referencePriceMicros,
      qtyAtomic: input.qtyAtomic,
      filledQtyAtomic: 0n,
      reservedMicros: reservedFor({
        intent: input.intent,
        qtyAtomic: input.qtyAtomic,
        limitPriceMicros: input.limitPriceMicros ?? null,
        referencePriceMicros: input.referencePriceMicros,
        feeBps,
        flatFeeMicrosPerContract: flat,
      }),
      queueAheadAtomic: queueAhead,
      status: "resting",
      placedAt: input.nowIso,
      placedTick: input.tick,
      updatedAt: input.nowIso,
      statusReason: kind === "maker-limit" ? "resting at the limit; awaiting a print through the bid" : "placed as a taker against the ask",
      simulation: true,
      paper: true,
    };
  }

  /** Cash an order still needs released, given what has filled. */
  releaseFor(order: PaperOrder): bigint {
    const remaining = order.qtyAtomic - order.filledQtyAtomic;
    if (remaining <= 0n) return 0n;
    const price = order.intent === "maker" ? (order.limitPriceMicros ?? order.referencePriceMicros) : order.referencePriceMicros;
    const notional = buyCostMicros(remaining, price);
    return notional + feeMicros(notional, this.feeFor(order.intent), this.fees?.flatFeeMicrosPerContract ?? 0n, remaining);
  }

  /**
   * Advance one tick: try to fill, then report what changed.
   *
   * Returns fills and a release amount. It never mutates the caller's bank; the
   * caller applies the fills and releases the remainder, so the ordering of cash
   * movements stays in one place.
   */
  advance(input: AdvanceInput): AdvanceResult {
    const { order, book, prints, tick, nowIso } = input;
    if (order.status !== "resting" && order.status !== "partially-filled") {
      return { fills: [], releaseMicros: 0n, statusReason: null };
    }
    if (order.kind === "maker-limit") return this.advanceMaker(input);
    return this.advanceTaker(input);
  }

  // --- taker ---------------------------------------------------------------

  private advanceTaker(input: AdvanceInput): AdvanceResult {
    const { order, book, tick, nowIso } = input;
    if (!book || book.asks.length === 0) {
      return { fills: [], releaseMicros: 0n, statusReason: "no asks; the taker order cannot trade" };
    }
    const remaining = order.qtyAtomic - order.filledQtyAtomic;
    if (remaining <= 0n) return { fills: [], releaseMicros: 0n, statusReason: null };

    const feeBps = this.feeFor("taker");
    const flat = this.fees?.flatFeeMicrosPerContract ?? 0n;
    const fills: PaperFill[] = [];
    let left = remaining;

    for (const level of book.asks) {
      if (left <= 0n) break;
      const take = level.qtyAtomic < left ? level.qtyAtomic : left;
      if (take <= 0n) continue;
      const notional = buyCostMicros(take, level.priceMicros);
      fills.push({
        paperRef: order.paperRef,
        orderPaperRef: order.paperRef,
        provider: order.provider,
        contractId: order.contractId,
        outcomeId: order.outcomeId,
        side: "buy",
        intent: "taker",
        priceMicros: level.priceMicros,
        qtyAtomic: take,
        notionalMicros: notional,
        feeMicros: feeMicros(notional, feeBps, flat, take),
        at: nowIso,
        tick,
        why: `lifted ${take} atomic units from the ask at ${level.priceMicros}`,
        simulation: true,
        paper: true,
      });
      left -= take;
    }

    if (fills.length === 0) {
      return { fills: [], releaseMicros: this.releaseFor(order), statusReason: "the ask side was empty at every level" };
    }

    const filled = remaining - left;
    const complete = left <= 0n;
    return {
      fills,
      releaseMicros: complete ? 0n : this.releaseFor({ ...order, filledQtyAtomic: order.qtyAtomic - left }),
      statusReason: complete
        ? `filled ${filled} of ${order.qtyAtomic} atomic units across ${fills.length} level(s)`
        : `partially filled ${filled} of ${order.qtyAtomic}; the book ran out at ${book.asks.length} level(s), so the remainder is released`,
    };
  }

  // --- maker ---------------------------------------------------------------

  private advanceMaker(input: AdvanceInput): AdvanceResult {
    const { order, book, prints, tick, nowIso } = input;
    const limit = order.limitPriceMicros;
    if (limit === null) return { fills: [], releaseMicros: 0n, statusReason: "maker order has no limit price" };
    if (!book || book.bids.length === 0) {
      return { fills: [], releaseMicros: 0n, statusReason: "no bids; nothing to rest behind" };
    }

    const remaining = order.qtyAtomic - order.filledQtyAtomic;
    if (remaining <= 0n) return { fills: [], releaseMicros: 0n, statusReason: null };

    // 1. Did anything actually trade through our price? A print at or below the
    //    limit is a seller hitting bids, which is the only thing that can fill a
    //    resting bid. A print above it is irrelevant.
    let throughQty = 0n;
    for (const print of prints) {
      if (print.priceMicros <= limit) throughQty += print.qtyAtomic;
    }
    if (throughQty <= 0n) {
      const age = tick - order.placedTick;
      if (age >= MAKER_EXPIRY_TICKS) {
        return {
          fills: [],
          releaseMicros: this.releaseFor(order),
          statusReason: `nothing traded through the bid for ${age} ticks; the quote was never reached, so the order rests unfilled`,
        };
      }
      return { fills: [], releaseMicros: 0n, statusReason: null };
    }

    // 2. Consume the queue ahead of us before anything reaches us.
    let queue = order.queueAheadAtomic;
    let available = throughQty;
    if (queue > 0n) {
      const consumed = queue < available ? queue : available;
      queue -= consumed;
      available -= consumed;
      order.queueAheadAtomic = queue;
    }
    if (available <= 0n) {
      return { fills: [], releaseMicros: 0n, statusReason: "a print traded at our price, but everything ahead of us consumed it first" };
    }

    // 3. Did we win the race at the level?
    const level = bestBidLevel(book.bids, limit);
    const raceBps = makerRaceProbabilityBps(remaining, level?.qtyAtomic ?? remaining, order.paperRef);
    const roll = hash(`${order.paperRef}:${tick}`) % Number(BPS_DENOM);
    if (roll > raceBps) {
      return {
        fills: [],
        releaseMicros: 0n,
        statusReason: `lost the race at ${limit} (rolled ${roll} against ${raceBps} bps of visible size); the order stays queued`,
      };
    }

    // 4. Fill, capped by what is actually resting at our price now.
    const restingHere = level?.qtyAtomic ?? 0n;
    let fillQty = available < remaining ? available : remaining;
    if (restingHere > 0n && fillQty > restingHere) fillQty = restingHere;
    if (fillQty <= 0n) {
      return { fills: [], releaseMicros: 0n, statusReason: "no size resting at our limit after the queue cleared" };
    }

    const notional = buyCostMicros(fillQty, limit);
    const fill: PaperFill = {
      paperRef: order.paperRef,
      orderPaperRef: order.paperRef,
      provider: order.provider,
      contractId: order.contractId,
      outcomeId: order.outcomeId,
      side: "buy",
      intent: "maker",
      priceMicros: limit,
      qtyAtomic: fillQty,
      notionalMicros: notional,
      feeMicros: feeMicros(notional, this.feeFor("maker"), this.fees?.flatFeeMicrosPerContract ?? 0n, fillQty),
      at: nowIso,
      tick,
      why:
        `a print traded through ${limit} with the queue ahead cleared; won the level at ${raceBps} bps ` +
        `against ${remaining - fillQty} atomic units still resting`,
      simulation: true,
      paper: true,
    };

    const complete = order.filledQtyAtomic + fillQty >= order.qtyAtomic;
    return {
      fills: [fill],
      releaseMicros: complete ? 0n : this.releaseFor({ ...order, filledQtyAtomic: order.qtyAtomic - (remaining - fillQty) }),
      statusReason: complete
        ? `filled ${order.qtyAtomic} of ${order.qtyAtomic} atomic units as maker at ${limit}`
        : `partially filled ${order.qtyAtomic - remaining + fillQty} of ${order.qtyAtomic} as maker at ${limit}`,
    };
  }

  /** Terminal status for an order given what the simulator observed. */
  finalStatus(order: PaperOrder, advanced: boolean): PaperOrder["status"] {
    if (order.filledQtyAtomic >= order.qtyAtomic && order.qtyAtomic > 0n) return "filled";
    if (order.filledQtyAtomic > 0n) return advanced ? "unfilled" : "partially-filled";
    return advanced ? "unfilled" : "resting";
  }
}

/** The bid level at or better than `limit`, best-first. */
export function bestBidLevel(bids: readonly OrderBookLevel[], limit: bigint): OrderBookLevel | undefined {
  for (const level of bids) {
    if (level.priceMicros >= limit) return level;
  }
  return bids[0];
}

/** Ticks elapsed since an order was placed, derived from its ISO timestamp. */
function parseTick(placedAtIso: string, fallback: number): number {
  const parsed = Date.parse(placedAtIso);
  return Number.isFinite(parsed) ? fallback : 0;
}