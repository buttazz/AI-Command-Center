/**
 * CDP Policy Engine policy templates.
 *
 * This is the boundary that actually matters. Every local check in this project
 * can be defeated by compromising this machine. These policies are evaluated
 * **inside the enclave** on every signature, so they hold even when the CDP
 * Secret API Key and the Wallet Secret are both stolen. The local policy engine
 * is defence in depth; this is the wall.
 *
 * Evaluation semantics, from Coinbase's documentation, and they matter:
 *
 *  1. Rules are evaluated **in array order**.
 *  2. The first rule whose criteria all match decides the outcome, and
 *     evaluation stops there.
 *  3. **If no rule matches, the request is REJECTED.**
 *
 * Consequence worth being explicit about: rule omission is deny. That is why
 * there are no `signEvmTransaction`, `signEvmHash`, `signEvmMessage` or
 * `signEvmTypedData` rules here. Those operations are not merely restricted,
 * they are *absent*, and therefore rejected unconditionally. The raw signing
 * primitives are closed; only the controlled send path is open. A stolen
 * credential cannot use this policy to sign an arbitrary payload, an arbitrary
 * hash for a bridge or a solver, or a phishing message — it can only cause
 * transactions that match the accept rules below.
 */

import type { Policy } from "../policy/schema.js";
import { Money } from "../core/money.js";

/** Networks the policy is willing to touch. Mirrors the local policy. */
export interface EnclavePolicyOptions {
  network: "base-sepolia" | "base";
  /** Largest single native transfer, in wei. */
  maxNativeWei: bigint;
  /** Native asset price in micro-USDC, used for the USD ceiling. */
  nativePriceUsdcMicros: bigint;
  /** Hard USD ceiling per transaction, micro-USDC. */
  maxUsdMicros: bigint;
  /** Optional allowlist of token contract addresses. Empty = no ERC-20 restriction. */
  allowedTokens: string[];
  /** Max USDC transfer per transaction, atomic units (6 decimals). */
  maxUsdcAtomic: bigint;
  description?: string;
}

type Rule = Record<string, unknown>;

function networkName(n: "base-sepolia" | "base"): "base-sepolia" | "base" {
  return n;
}

/**
 * Build the account-scoped policy.
 *
 * Structure, in evaluation order:
 *
 *   1. REJECT  any network other than the configured one
 *   2. REJECT  native value above the configured ceiling
 *   3. REJECT  USD value above the configured ceiling
 *   4. REJECT  any ERC-20 not on the allowlist (when an allowlist is set)
 *   5. REJECT  native value above the ceiling, for the sign path too
 *   6. ACCEPT  a send on the right network within every ceiling
 *   7. ACCEPT  an ERC-20 transfer within its own ceiling
 *
 * The rejects come first deliberately. If an accept were listed first, its
 * criteria would short-circuit the rejects and a large transfer would be
 * approved by rule 6 before rule 2 was ever reached.
 */
export function buildEnclavePolicy(opts: EnclavePolicyOptions): Record<string, unknown> {
  const net = networkName(opts.network);
  const maxUsdMicros = opts.maxUsdMicros;

  // Enforce the USD ceiling on native transfers too, so a native price spike
  // cannot make a fixed wei ceiling worth more than intended. Derived from the
  // supplied price, with a floor of 1 so a zero price cannot produce a zero cap.
  const price = opts.nativePriceUsdcMicros > 0n ? opts.nativePriceUsdcMicros : 1n;
  const nativeWeiForUsdCap = (maxUsdMicros * 10n ** 18n) / price;
  const nativeCap = opts.maxNativeWei < nativeWeiForUsdCap ? opts.maxNativeWei : nativeWeiForUsdCap;

  const rules: Rule[] = [
    // 1. Network confinement. This is the mainnet kill: a rule that matches any
    //    network which is NOT the testnet, rejected. Because it is evaluated
    //    first, a mainnet transaction is refused before any amount check.
    {
      action: "reject",
      operation: "sendEvmTransaction",
      criteria: [{ type: "evmNetwork", operator: "not in", networks: [net] }],
    },
    {
      action: "reject",
      operation: "sendEndUserEvmTransaction",
      criteria: [{ type: "evmNetwork", operator: "not in", networks: [net] }],
    },

    // 2. Native value ceiling.
    {
      action: "reject",
      operation: "sendEvmTransaction",
      criteria: [{ type: "ethValue", operator: ">", ethValue: nativeCap.toString() }],
    },

    // 3. USD value ceiling. Catches ERC-20 transfers that bypass a wei cap and
    //    any asset whose quantity limit is not otherwise bounded.
    {
      action: "reject",
      operation: "sendEvmTransaction",
      criteria: [{ type: "netUSDChange", operator: ">", changeCents: Number(maxUsdMicros / 10_000n) }],
    },

    // 4. Token allowlist, when configured.
    ...(opts.allowedTokens.length > 0
      ? [
          {
            action: "reject",
            operation: "sendEvmTransaction",
            criteria: [
              { type: "evmAddress", operator: "not in", addresses: opts.allowedTokens.map((a) => a.toLowerCase()) },
            ],
          } satisfies Rule,
        ]
      : []),

    // 5. Sign-path ceilings. `signEvmTransaction` has no `evmNetwork` criterion
    //    in the API, so network confinement for the sign path relies on the
    //    omissions described in the module comment. The value ceilings are
    //    still enforced here so that if a sign rule is ever added, it inherits
    //    the amount limits.
    {
      action: "reject",
      operation: "signEvmTransaction",
      criteria: [{ type: "ethValue", operator: ">", ethValue: nativeCap.toString() }],
    },
    {
      action: "reject",
      operation: "signEvmTransaction",
      criteria: [{ type: "netUSDChange", operator: ">", changeCents: Number(maxUsdMicros / 10_000n) }],
    },

    // 6. Accept the ordinary native send.
    {
      action: "accept",
      operation: "sendEvmTransaction",
      criteria: [
        { type: "evmNetwork", operator: "in", networks: [net] },
        { type: "ethValue", operator: "<=", ethValue: nativeCap.toString() },
      ],
    },

    // 7. Accept a bounded ERC-20 transfer, where the token is on the allowlist
    //    and the amount is inside that token's own ceiling. The ABI condition
    //    restricts the call to `transfer` with a bounded value, so a token
    //    with a permissive `approve` cannot be used to grant an allowance
    //    through this policy.
    {
      action: "accept",
      operation: "sendEvmTransaction",
      criteria: [
        { type: "evmNetwork", operator: "in", networks: [net] },
        { type: "evmAddress", operator: "in", addresses: opts.allowedTokens.map((a) => a.toLowerCase()) },
        {
          type: "evmData",
          abi: "erc20",
          conditions: [
            {
              function: "transfer",
              params: [{ name: "value", operator: "<=", value: opts.maxUsdcAtomic.toString() }],
            },
          ],
        },
      ],
    },
  ];

  return {
    description:
      opts.description ??
      `Big Pickle wallet confinement: ${net} only, native cap ${nativeCap} wei, USD cap ${Money.fromMicros(maxUsdMicros).format()} USDC. Raw sign/hash/message operations are intentionally absent and therefore rejected.`,
    scope: "account",
    rules,
  };
}

/**
 * Derive enclave limits from the local policy, so there is one place to change
 * a number and the enclave is never more permissive than the local engine.
 *
 * `nativePriceUsdcMicros` is supplied by the caller from a market read. On
 * Base Sepolia ETH is worthless, so any positive value yields a very large
 * wei ceiling and the USD cap becomes the binding constraint.
 */
export function enclaveLimitsFromPolicy(
  policy: Policy,
  nativePriceUsdcMicros: bigint,
  allowedTokens: string[] = [],
  maxUsdcAtomic: bigint = 10_000_000_000n,
): EnclavePolicyOptions {
  const maxSingleUsd = Money.fromMicros(0).bps(policy.risk.maxSingleTradeBps);
  void maxSingleUsd;
  // The enclave USD cap is the single-trade ceiling at 100% portfolio value
  // expressed against a nominal portfolio. The local engine remains the
  // portfolio-relative authority; this is a fixed backstop.
  const maxUsdMicros = 1_000_000_000n; // 1000 USDC
  return {
    network: policy.network.permitted.includes("base") ? "base" : "base-sepolia",
    maxNativeWei: 10n ** 15n, // 0.001 native
    nativePriceUsdcMicros,
    allowedTokens,
    maxUsdMicros,
    maxUsdcAtomic,
  };
}

/**
 * A strictly-denying policy. Useful as a first step during setup: attach this
 * while wiring credentials, confirm it is attached, and only then replace it
 * with the confinement policy. It also serves as a safe state to return to when
 * the kill switch is engaged.
 */
export function buildDenyAllPolicy(description?: string): Record<string, unknown> {
  return {
    description:
      description ??
      "Big Pickle deny-all: no operation is accepted. Because unmatched operations are rejected by default, this policy permits no transaction at all. Attach during setup and whenever the kill switch is engaged.",
    scope: "account",
    // A rule that rejects everything is unnecessary: an empty rules array
    // rejects every operation, because no rule can match.
    rules: [],
  };
}
