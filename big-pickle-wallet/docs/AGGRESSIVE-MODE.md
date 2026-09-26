# Aggressive Mode — Risk Profile & Engineering Corrections

Project: `big-pickle-wallet`
Date: 2026-09-26
Status: accepted
Supersedes: the neutral risk posture in `ARCHITECTURE.md` §2

---

## 1. Profile as specified

Captured in `config/policy.aggressive.json`, which is the machine-readable
source of truth. Summary:

| Dimension | Setting |
| --- | --- |
| Target deployment | 70–90% of deployable capital |
| Default position | 8–12% of portfolio |
| Max single position | 20% |
| Max concurrent positions | 4 |
| Max daily portfolio drawdown | 8% |
| Concentration | high-conviction, not diversified |
| Rotation | rapid, many trades/day permitted |
| Universe | large / mid / small Coinbase-listed |
| Strategy bias | breakout, volume expansion, relative strength, trend continuation, pullbacks, fast rotation |
| Averaging down | never |
| Invalidation per entry | mandatory |
| Veto basis | structural risk only, never volatility |

## 2. Three conflicts found, and how each is resolved

Each of these is a place where implementing the spec literally would *increase*
the probability of the outcome the spec exists to prevent. I have implemented the
corrected behaviour and left the correction visible rather than silent.

### 2.1 A hard deployment target becomes a forcing function

Four positions capped at 20% each totals 80%, and the default 8–12% size totals
32–48%. So 70–90% deployment is only reachable by sizing most positions near the
20% ceiling. There is a worse failure mode: **a system required to keep 90%
deployed will open a marginal trade purely to fill the quota.** That is not
aggression, it is a systematic loss generator, and it is the single most common
way an "aggressive" bot underperforms a boring one.

**Implemented:** `targetDeploymentBps` is a *target the allocator reports against*,
never a justification to enter. The hard invariant is the opposite direction — a
proposal that fails any quality gate is rejected regardless of current
deployment. If only two setups qualify, the book runs 40% deployed and the
portfolio view states plainly that it is under-deployed by choice. Under-deployed
is a valid outcome. Forcing deployment is not.

`policy.ts` asserts this: deployment targets are read only by the allocator for
attribution, and the quality gates do not read them.

### 2.2 An 8% daily limit will be hit by ordinary market behaviour, and "stop all trading" is the wrong response

Base small-caps routinely move 20–30% in a session. With ~80% deployed across four
momentum alts that are all correlated to BTC, a broad alt flush reaches −8% without
any bug, any bad trade, or any software failure. On a momentum system this happens
regularly.

The literal response — "at the daily loss limit, stop initiating new trades", with
no distinction — creates a second-order problem. Blocking *everything* means the
system also cannot cut a position that is bleeding. It then sits on a large loss
with no ability to respond, and misses the recovery when the market turns.

**Implemented:** the daily loss limit triggers **de-risk mode**, not a full stop.
De-risk mode permits actions that reduce risk and blocks actions that increase it:

| Action | Normal | De-risk | Freeze |
| --- | --- | --- | --- |
| Open / increase position | allow | **block** | block |
| Partial exit | allow | allow | block |
| Full exit / stop | allow | allow | block |
| Close gas reserve, rebalance to idle | allow | allow | block |
| Read balances / history | allow | allow | allow |
| Edit policy | allow | allow | allow |

This is strictly safer than a blanket stop, because a position that must be cut can
still be cut. The 8% limit itself is unchanged, and it is still fail-closed.

The same de-risk response applies to the **three-consecutive-material-losses**
cooldown, with the same reasoning: a losing streak means stop adding risk, not stop
managing it.

### 2.3 A raw slippage cap blocks exactly the trades this strategy wants

Momentum breakouts are most attractive after the move has started, which is also
when book depth is thinnest. A tight slippage cap rejects the breakout entries and
permits only the calm, uninteresting fills — inverting the strategy bias.

**Implemented:** slippage is gated by **net expected edge after costs**, not by an
absolute cap alone:

```
requiredEdge = (expectedGrossEdge − slippageAllowance − fees − priceImpact) 
accepted iff requiredEdge >= minExpectedEdgeBps
```

A trade with a 5% target and 1.2% expected slippage passes on edge. A trade with a
0.4% target and 0.3% slippage fails, because it is not worth the risk regardless of
how well it filled. Absolute bounds (`maxSlippageBps`, `maxPriceImpactBps`) remain
as circuit breakers against a broken or hostile pool, so a mispriced quote cannot
leak through the edge test.

## 3. Invariants added to make the profile survivable

These are required to satisfy "prevent a single bad trade or software failure from
wiping out the account" at 80% deployed in volatile alts. All are deterministic
code, not prompt instructions.

### 3.1 Averaging down is mechanically impossible

Hard rule in the executor: **an order that increases exposure to an asset which
already has an open position is rejected.** No prompt, no LLM, and no exception
path can add to a losing position. Rotations into new assets and partial reductions
remain fully available, so the strategy is unaffected.

### 3.2 Invalidation breach forces an exit, unoverrideable

Every entry carries a mandatory invalidation. When the monitor observes the
invalidation condition met, the exit is **forced** and Big Pickle cannot decline it.
Big Pickle may still exit early for discretionary reasons; it may never decline a
forced exit. This is what makes the maximum-loss calculation enforceable rather
than aspirational.

### 3.3 Anomaly circuit breaker

Immediate freeze on any of:

- attestation verification failure (tampering or a compromised Risk process)
- on-chain balance disagrees with the reconciled position book beyond dust
- repeated reverts or nonce anomalies from the executor
- RPC returning inconsistent state across two consecutive reads
- gas price above `maxGasWei`
- any policy engine error (fails closed, never open)
- any unexpected exception in the signing path

The freeze is sticky: it requires an explicit human resume, and it is written to the
audit log as a first-class event. Wallet/API/execution anomalies freezing trading is
implemented as a real circuit breaker rather than an aspiration.

### 3.4 Serialised execution

Aggressive rotation means many orders in quick succession. Two concurrent signings
from one account race on the nonce and one silently replaces the other — an order
that looks successful and is not. The executor holds a single-slot execution mutex
and reconciles the nonce from `pending` before each send. No parallelism in the
signing path.

### 3.5 Correlation-aware concentration

Four "different" small-caps in a momentum regime are often one leveraged bet on
alt-beta. Risk checks proposed assets against open positions for realised return
correlation and beta similarity. A proposal that stacks exposure onto an existing
correlated position is treated as a concentration veto, not a diversification.

## 4. Max-loss arithmetic, computed every time

Before any order, deterministically:

```
maxLoss = notional × (1 − distanceToInvalidation) + feeCost + slippageCost + gasCost
if maxLoss > remainingDailyLossBudget: reject
if maxLoss > maxLossBpsOfPortfolio: reject
```

The daily loss budget is `maxDailyDrawdownBps` minus drawdown already realised
today. This is why the 8% limit is a real circuit breaker rather than a
suggestion: once the budget is consumed, further entries are rejected by arithmetic
before any agent opinion is consulted.

## 5. Deployment sequence — unchanged, and enforced

1. **Foundation smoke/tests** — local temporary state, generated ephemeral
   attestation keys, no network calls, no signatures, and no real money.
2. **On-chain testnet (`base-sepolia`)** — real signatures, real transactions,
   worthless ETH. Proves CDP custody, policy enforcement, execution, and
   reconciliation for the secondary on-chain rail.
3. **Advanced Trade paper simulation** — required before any exchange adapter;
   Advanced Trade has no testnet and every live order reaches a real venue.
4. **Mainnet/live exchange** — **disabled.** Requires an explicit human command
   (`control mainnet-enable`) *and* a separate mainnet policy with its own lower
   limits *and* a completed validation record. Three independent gates: the CDP
   Policy Engine, the local policy engine, and the executor's own network
   assertion.

The same aggressive strategy code runs at every stage. Only the network and the
money differ, so what is validated on testnet is what executes on mainnet.
