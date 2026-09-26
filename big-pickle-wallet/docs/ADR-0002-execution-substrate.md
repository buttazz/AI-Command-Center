# ADR 0002 — Execution substrate for Big Pickle

Date: 2026-09-26
Status: accepted
Supersedes: nothing. Refines §1 of `ARCHITECTURE.md`.

---

## 1. Summary

The primary execution rail is the **Coinbase Advanced Trade REST API, called
directly by deterministic TypeScript**, authenticated with a per-request ES256
JWT.

The previous session evaluated two options (Coinbase for Agents, CDP Server
Wallets) and selected Option B (CDP on-chain) for its single decisive
advantage: no LLM in the signing path. That advantage is real, and this ADR
keeps it. But the previous session did not consider a third option, and its
choice of on-chain DeFi as the *only* deterministic rail is wrong for the
strategy that was actually specified.

**Option C — Advanced Trade REST, driven directly** — satisfies the
determinism requirement just as well as Option B, and is a far better fit for
momentum, breakout, volume expansion and fast capital rotation.

| | A: for Agents (MCP/CLI) | B: CDP on-chain | **C: Advanced Trade REST** |
| --- | --- | --- | --- |
| No LLM in signing path | **No** | Yes | **Yes** |
| Real order book | Yes | No (AMM pool) | **Yes** |
| Gas per trade | None | Yes | **None** |
| Slippage on target size | n/a | Pool depth | **Book depth** |
| 24/7 | Yes | Yes | **Yes** |
| Testnet available | No | **Yes** (`base-sepolia`) | **No** |
| Own audit log | No | Yes | **Yes** |
| Limits in version-controlled code | No | Enclave policy | **Yes** |
| Human override | Disable key | Owner key | **Disable key + kill switch** |
| Listing risk handled by | n/a | You (honeypot, holders) | **Coinbase, before listing** |

Decision: **C is primary. B is retained, intact, as a secondary on-chain
settlement rail. A is rejected.**

---

## 2. Why A is rejected — with Coinbase's own documentation as evidence

Option A places the LLM in the signing path. This is disqualifying on its own,
and it is no longer a matter of opinion: Coinbase's `coinbase-for-agents`
documentation reports measured failures of exactly this path.

> "remote MCP has known issues with high-reasoning models blocking trades on
> certain platforms"

> "On hosted chat clients, high-reasoning and extended-thinking modes sometimes
> draft an order but stop short of executing it."

> "Claude Desktop refuses most orders that the web client creates; `Sonnet 4.6`
> is the exception."

> "Lower-tier models may create orders with the wrong product, for example,
> `ETH-USD` instead of `ETH-USDC`."

The last of these is the instructive one. `ETH-USD` and `ETH-USDC` are different
products with different settlement assets. A model choosing the wrong one is not
a recoverable error, and no amount of prompt engineering makes that class of
failure disappear — it is a property of routing a value-bearing instruction
through a stochastic system.

Option A is also *not* a thing we can wrap. There is no server-side
"deterministic mode" to opt into. The reliability problem is inherent to the
architecture.

A is retained only as an **out-of-band fiat rail** for the owner: on-ramp,
off-ramp, and manual owner trading in Coinbase's own UI.

---

## 3. Why C, not B, for this strategy

The specified strategy is momentum, breakout, volume expansion, relative
strength, and trend continuation, with fast capital rotation, 4–6 concurrent
positions at 8–12% each, and smaller/high-volatility assets explicitly in scope.

That strategy needs: a deep real order book, tight spreads, cheap frequent
turnover, reliable 24/7 liquidity, and no per-trade overhead that compounds over
many rotations per day.

- On Base, every rotation is an AMM swap. Cost = gas + pool fee + price impact
  against pool depth. A memecoin with a thin pool cannot absorb even a 10% clip
  without the trade being eaten by impact. A memecoin *does* have a book on
  Coinbase, and that book is deeper.
- Gas is irrelevant at 5 bps and annoying at 30. Fast rotation makes it matter.
- The on-chain risk surface the previous session built for — honeypot
  simulation, top-holder concentration, transfer simulation — exists to manage
  *listing* risk. A Coinbase-listed spot pair has already been vetted by the
  venue. That is a large, real reduction in risk, and it is the single largest
  argument for C.

B is not wasted. It remains correct for on-chain settlement, x402 payments, and
DeFi interactions, and the existing implementation in `src/cdp/` and
`src/executor/executor.ts` is preserved unchanged for that use.

---

## 4. The real cost of C: there is no testnet

The Advanced Trade OpenAPI spec declares exactly one server:

```yaml
servers:
- url: https://api.coinbase.com
```

There is no sandbox, no paper environment, no simulated matching engine. Every
order placed against Advanced Trade is a real order against a real book.

This inverts the previous session's advantage. Option B had `base-sepolia`; C has
nothing. Therefore:

> **The paper broker is not a convenience feature. It is the primary
> development and validation environment, and it is the default.**

This is resolved structurally, not by discipline:

- `src/exchange/broker.ts` defines the only interface through which any order
  can reach any venue.
- `PaperBroker` and `CoinbaseBroker` both implement it.
- The venue is selected by policy, not by argument or environment variable.
- `Policy.network.mainnetEnabled` gates `CoinbaseBroker` construction, and is
  `false` in every committed policy file.
- There are exactly three ways to reach a real order, all requiring the human:
  `mainnetEnabled: true` in policy **and** a live key in the vault **and** an
  explicit `bpw control live-enable` that writes a signed, audited record.

An agent cannot promote itself to live execution. The promotion path requires
editing a version-controlled file, and that edit is visible in `git diff`.

---

## 5. Determinism contract

The requirement is that no LLM output reaches an order. In option C that is
enforced by the shape of the code, not by convention:

```
LLM ──emits──> integer bps only  ──> deterministic sizing ──> Broker.place()
                                          │
                                          └─ zero LLM calls exist past this line
```

An LLM may emit a size of `900` bps. It may not emit `$450.32`, because the
proposal schema has no field for it, and the notional is computed downstream
from live portfolio value. This is the previous session's correction §2.3, and it
carries over unchanged.

`PaperBroker` and `CoinbaseBroker` are the *only* code permitted to construct an
exchange order payload. Neither is importable by an agent process. Neither reads
LLM output directly; both receive already-validated, already-risk-attested,
already-limit-checked intents.

---

## 6. Consequences

**Accepted:**

- Strategy validation happens against a simulator, so measured paper performance
  is a model of the exchange, not the exchange. The simulator is deliberately
  pessimistic (see `paper-broker.ts` header) and its assumptions are enumerated
  and tested. It is not evidence of profitability.
- No on-chain execution until separately enabled.
- Higher custody centralisation: assets sit with Coinbase, not self-custodied.
  Accepted in exchange for liquidity and fee efficiency, and mitigated by
  portfolio isolation plus the key-permission scoping described in the runbook.

**Rejected:**

- The MCP/CLI path, permanently, on determinism grounds.
- On-chain AMM swaps as the primary venue for this strategy.

**Unchanged from the previous session:**

- Risk attestation as a *structural* veto, not a conversational one (§2.1).
- Two separate veto layers: hard limits fail-closed, soft critique advisory (§2.2).
- Size in basis points, never dollars (§2.3).
- Kill switch and reconciler independent of all four agents (§2.4).
- Mainnet disabled, enforced in more than one place.
