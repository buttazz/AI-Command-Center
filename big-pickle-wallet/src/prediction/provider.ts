/**
 * Prediction-market provider interface — READ-ONLY BY CONSTRUCTION.
 *
 * This interface has five methods and every one of them reads. There is no
 * `placeOrder`, no `createOrder`, no `cancelOrder`, no `buy`, no `sign`, no
 * `authenticate`, no `apiKey`, no `credentials`. That is not an oversight and it
 * is not a TODO: an interface that has no order-submission member is an
 * interface that *cannot* be wired to a live venue without someone deliberately
 * editing it, which is a code review someone has to perform. An interface with
 * `placeOrder(order)` and a comment saying "unused for now" is one autocomplete
 * away from a real order.
 *
 * Consequences, all intended:
 *
 *  - No API keys are required, read, or accepted. A provider constructor takes
 *    no credential of any kind.
 *  - A Kalshi or Polymarket adapter can be added later as another implementation
 *    of this interface, and the strategy layer above cannot tell them apart.
 *  - Nothing in the strategy or execution path has any capability to move
 *    money, so "paper only" is a property of the type graph rather than a
 *    runtime flag that could be flipped.
 */

import type {
  MarketQuote,
  OrderBookSnapshot,
  PredictionMarket,
  PredictionProviderId,
  PublicTrade,
  ResolvedMarket,
} from "./types.js";

/** A read-only window onto one prediction-market venue. */
export interface PredictionMarketProvider {
  /** Stable provider id, e.g. `fixture`, `kalshi`, `polymarket`. */
  readonly id: PredictionProviderId;

  /** True only when the provider holds no execution capability at all. */
  readonly readOnly: true;

  /** Every market the provider currently lists. */
  listMarkets(): Promise<readonly PredictionMarket[]>;

  /** One market by id, or null when the provider does not list it. */
  getMarket(marketId: string): Promise<PredictionMarket | null>;

  /** Current two-sided depth for one contract outcome. */
  getOrderBook(contractId: string, outcomeId: string): Promise<OrderBookSnapshot | null>;

  /**
   * The best two-sided price for one outcome, with derived spread, depth and
   * freshness. Null when the outcome is not quoted on both sides.
   */
  getQuote(contractId: string, outcomeId: string): Promise<MarketQuote | null>;

  /** Recent public prints, oldest first. */
  getRecentTrades(contractId: string, limit?: number): Promise<readonly PublicTrade[]>;

  /** The resolution of a contract, or null while it is unresolved. */
  getResolution(contractId: string): Promise<ResolvedMarket | null>;

  /** Provider's own clock. Deterministic providers return a fixture clock. */
  now(): Date;
}

/**
 * The complete member set of `PredictionMarketProvider`, at the type level.
 *
 * This exists so a test can assert that no execution capability ever appears on
 * the interface, and so that adding one is a deliberate act that fails here
 * rather than a silent widening at some call site.
 */
export const PREDICTION_PROVIDER_METHODS = [
  "listMarkets",
  "getMarket",
  "getOrderBook",
  "getQuote",
  "getRecentTrades",
  "getResolution",
  "now",
] as const;

/**
 * Method names that must never appear on a provider. Enforced in tests and by
 * the cockpit source-hygiene check.
 *
 * Deliberately broad: it covers both the obvious verbs and the obvious nouns, so
 * a rename cannot smuggle a capability past it.
 */
export const FORBIDDEN_PROVIDER_CAPABILITIES: readonly string[] = [
  "placeOrder",
  "createOrder",
  "submitOrder",
  "sendOrder",
  "postOrder",
  "buy",
  "sell",
  "marketBuy",
  "marketSell",
  "cancelOrder",
  "cancelAll",
  "replaceOrder",
  "amendOrder",
  "closePosition",
  "redeem",
  "withdraw",
  "deposit",
  "transfer",
  "sign",
  "signOrder",
  "signTransaction",
  "authenticate",
  "login",
  "apiKey",
  "apikey",
  "apiSecret",
  "secret",
  "privateKey",
  "wallet",
] as const;

/** Members of `T` that are not part of the read-only method set. */
export function extraProviderMembers<T extends object>(provider: T): string[] {
  const allowed = new Set<string>([...PREDICTION_PROVIDER_METHODS, "id", "readOnly"]);
  return Object.keys(provider as Record<string, unknown>).filter((k) => !allowed.has(k));
}

/**
 * Assert a value satisfies the read-only contract.
 *
 * Throws rather than warns. A provider that grows an order-submission member
 * fails loudly at construction, in tests and in the experiment loop, instead of
 * quietly becoming capable of something the type graph says it cannot do.
 */
export function assertReadOnlyProvider(provider: PredictionMarketProvider): void {
  if (provider.readOnly !== true) {
    throw new Error(
      `provider ${provider.id} must declare readOnly: true. A provider that can submit orders does not satisfy this interface.`,
    );
  }
  const extra = extraProviderMembers(provider);
  const forbidden = extra.filter((m) =>
    FORBIDDEN_PROVIDER_CAPABILITIES.some((f) => m.toLowerCase() === f.toLowerCase()),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `provider ${provider.id} exposes execution-capable member(s) ${forbidden.join(", ")}. ` +
        "PredictionMarketProvider is read-only by construction; a provider that can place, cancel, " +
        "redeem, transfer, sign or authenticate an order does not implement it.",
    );
  }
}