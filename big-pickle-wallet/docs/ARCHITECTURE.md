# Architecture Decision Record

Project: `big-pickle-wallet`
Date: 2026-09-26
Status: accepted

---

## 1. Coinbase architecture selection: A vs B

Two official Coinbase products were evaluated against the actual requirements.

### Option A — Coinbase for Agents

`@coinbase/coinbase-cli` / remote MCP at `https://agents.coinbase.com/mcp`.

- Auth: OAuth (remote MCP) or a CDP API key scoped with **Trade + Transfer**.
- Connects to a **Coinbase Advanced Trade brokerage account**, trading spot, eligible
  equities and US derivatives inside a Coinbase portfolio.
- Supports portfolio isolation: the agent can be fenced inside a dedicated Advanced
  portfolio with no visibility of other holdings.

### Option B — CDP Agentic Wallets / Server Wallets

CDP Wallets v2. `@coinbase/cdp-sdk`, optionally surfaced through AgentKit.

- Custody: private keys are generated, encrypted and used **only inside an AWS Nitro
  Enclave (TEE)**. No persistent storage, no interactive access, no external
  networking. Keys are never returned to the developer or to Coinbase.
- Auth: CDP Secret API Key (Ed25519, `Authorization: Bearer` JWT) plus a
  **Wallet Secret** (P-256, `X-Wallet-Auth` JWT) for any signing operation.
- **Policy Engine**: declarative `accept`/`reject` rules enforced **inside the
  enclave** at signing time, surviving credential compromise.
- KYT screening and paymaster (gasless USDC) support.

### Comparison against the stated requirements

| Requirement | Option A | Option B | Winner |
| --- | --- | --- | --- |
| Agents never receive private keys / seed | Yes | Yes (keys do not exist outside the enclave) | B |
| **Deterministic transaction execution** | **No** — the agent drives the CLI/MCP, so an LLM is in the signing path | **Yes** — `signTransaction` / `sendTransaction` are plain SDK calls any deterministic process can make | **B, decisively** |
| Full logging / audit trail | Coinbase-side only; you do not own the log | You own every call; hash-chained local audit log is possible | **B** |
| Configurable spending + position limits | Limits live in Coinbase UI/settings, not in code you can audit, diff, or roll back | Policy Engine is code + API, version-controlled, and enforced in the enclave | **B** |
| Human override / emergency stop | Not a programmable primitive | Deletable/overridable policy, plus we add a local kill switch | **B** |
| Ability to manually intervene | **Yes** — the owner can trade in Coinbase's own UI | Manual on-chain action, or AgentKit/CLI, or swap-in owner authority in our control plane | A |
| Eventual real capital | Strong fiat rails, real custody, best liquidity for listed pairs | Self-custody on-chain, requires prefunded gas and manual on-ramp | A |
| Testnet-first development | Not applicable (exchange accounts are mainnet-only) | Native `base-sepolia` | **B** |
| On-chain programmable settlement | No | Yes (smart accounts, x402, paymaster) | **B** |

### Decision: **Option B is the primary architecture. Option A is retained as a
deliberately out-of-band fiat rail.**

Reasoning, stated plainly: the single hardest requirement is *deterministic
transaction execution*. Option A structurally cannot satisfy it, because the
interface an agent uses to trade **is** the tool an LLM drives. Every additional
safety measure would sit in front of a thing whose control surface is a model.

Option B inverts that. The signing primitive is a normal SDK call. Deterministic
code calls it. LLMs emit *proposals*, never signatures.

Option A is kept because it genuinely solves something Option B does not: fiat
on-ramp, custody of the reserve, and a human-facing trading surface for the owner.

### Separation of responsibilities

```
┌──────────────────────────────────────────────────────────────────────┐
│  COINBASE FOR AGENTS (Option A)  —  OUT OF THE EXECUTION PATH        │
│  • fiat on-ramp / off-ramp between the owner's bank and on-chain      │
│  • manual owner trading surface (Coinbase UI)                        │
│  • long-tail / low-liquidity spot products we do not self-execute    │
│  Rule: may NEVER move funds into or out of the CDP wallet without    │
│  explicit, logged, human-approved, policy-gated operation.           │
└──────────────────────────────────────────────────────────────────────┘
            ▲  human-approved bridge only (never automatic)
            │
┌───────────┴──────────────────────────────────────────────────────────┐
│  CDP AGENTIC WALLETS (Option B)  —  TREASURY + EXECUTION RAIL         │
│  • self-custody TEE accounts, base-sepolia now, mainnet later         │
│  • Policy Engine enforced in the enclave                             │
│  • deterministic executor calls the SDK; no LLM in the signing path   │
└──────────────────────────────────────────────────────────────────────┘
```

The bridge between A and B is a one-way, human-gated operation. This is the
entire integration surface, and it is intentionally small.

---

## 2. The 4-agent LLM pipeline

The requested shape is accepted: four specialised agents, no more.

```
MARKET DATA
    ↓
SCOUT            observes. never transacts. emits ranked candidates + evidence.
    ↓
STRATEGIST       forms a structured proposal. no wallet authority.
    ↓
RISK / CRITIC    attacks the proposal. veto authority. cannot execute.
    ↓
BIG PICKLE       portfolio manager. allocates capital across the whole book.
    ↓
DETERMINISTIC EXECUTOR   signs and submits. no LLM in this process.
    ↓
POSITION / PORTFOLIO MONITOR   reconciles on-chain truth, self-heals.
    ↺
```

### Where the 4 agents are technically sound

- **Separating generation from evaluation** is correct and well-supported. An
  agent that proposes cannot adversarially review itself; two roles with
  genuinely different prompts and objectives is a real, if partial, diversity
  gain. This is the most valuable of the four splits and is worth the cost.
- **Big Pickle as portfolio manager above the pair** is correct. Per-trade
  decisions optimised independently genuinely underperform a portfolio-level
  allocator, and an agent that can see the whole book can reject a good trade
  because it is the wrong *size* for current exposure. That capability requires
  the top-level role.
- **A continuously running Scout** is the correct always-on component. It is
  read-only, cheap, and its failure mode is benign.
- **Execution as deterministic code, not a fifth LLM**, is unambiguously right,
  and is the highest-leverage decision in the whole design.

### Where the design as stated is unsafe, and the four corrections applied

These are not stylistic. Each closes a real bypass.

#### 2.1 "Risk has absolute veto authority" is not enforceable as a role

A veto held in a prompt is advisory. If Risk is unavailable, misconfigured, or
manipulated, the pipeline either stalls entirely or — worse — fails open.

**Correction: veto authority is structural, not conversational.** Risk signs a
cryptographic *attestation* over a canonical hash of the proposal. The executor
verifies the signature before it will price or sign anything. Big Pickle is
physically unable to submit an executable proposal that Risk did not sign. Risk
can remove authority; it can never add it, and its absence never means "approved".

Attestation signing lives in a process that holds no execution capability. Risk
can say no. Risk cannot say yes-and-do.

#### 2.2 "Absolute veto" is conflated with the hard limit layer

An LLM critique is stochastic and slow. It is not a safety boundary.

**Correction: two distinct veto layers, clearly separated.**

| Layer | Implemented in | Can be bypassed by an LLM? | Failure mode |
| --- | --- | --- | --- |
| **Hard limits** (spend, position, concentration, daily cap, allowlist, testnet-only) | Deterministic code + CDP Policy Engine in the enclave | **No** | Fail-closed |
| **Soft critique** (thesis quality, crowding, narrative risk, duplicate exposure) | Risk / Critic LLM | Yes — and that is fine, it is advisory | May miss things; never causes loss beyond hard limits |

Risk's attestation asserts it reviewed the proposal. The hard limits then apply
*anyway*, to the owner, to Risk, and to Big Pickle alike. A prompt injection into
Big Pickle therefore produces at worst a bad trade **within limits** — never a
drained wallet. That is the correct and honest threat model.

#### 2.3 A proposal schema that permits "sell everything" is an outage waiting to happen

If a proposal carries an absolute dollar amount or an unbounded size, a
hallucinating or injected Strategist can emit an unbounded instruction, and the
damage is limited only by how far downstream code bothers to clamp it.

**Correction: proposals are expressed in basis points of portfolio, not
dollars.** `sizeBps` is a `uint16` in `[1, 10000]`, hard-capped by the schema
before any code runs. Absolute notional is *derived* from portfolio value at
execution time. The dangerous quantity is never present in model output; it
cannot be, structurally.

#### 2.4 A single always-on process per role is a liveness and safety problem

If all four agents crash, or if Big Pickle can disable the monitor, the system
loses both its decision-making and its ability to stop.

**Correction: the safety-critical services are independent of all four agents.**

- The **kill switch** is a file plus a control-plane operation. It works when
  every agent process is dead. This is the reason it is not implemented inside
  the executor.
- The **monitor/reconciler** is deterministic and independent. It treats the
  chain as truth and discards its own phantom positions.
- The **executor** and the **hard limit engine** never import an agent runtime.

There are four LLM agents. There are also four deterministic services. That is
plumbing, not additional agents.

#### 2.5 Accepted as specified, and worth stating

- Big Pickle holds no wallet authority. It emits allocation decisions; the
  executor turns them into transactions.
- Scout and Strategist have no wallet access at all, by gateway token scope.
- Risk cannot execute.
- Mainnet is not enabled. `base-sepolia` only, enforced in three independent
  places: the Policy Engine in the enclave, the hard limit engine, and the
  executor's own network assertion.

---

## 3. Trust boundaries

| Boundary | Mechanism |
| --- | --- |
| LLM → signing | Type/capability separation. No agent process imports the CDP signing path. |
| Proposal → execution | Ed25519 risk attestation, verified by the executor. |
| Agent → secrets | Gateway issues scoped bearer tokens. No agent ever reads the vault. |
| Any code → fund movement | CDP Policy Engine evaluated inside the enclave, on every signature. |
| Anyone → fund movement | Deterministic hard limits + kill switch, independent of all agents. |
| Owner → everything | Owner authority key in the vault; can override, halt, and audit. |

## 4. What "no agent gets unrestricted access" concretely means

The gateway is the only component exposed to agent processes. It holds the CDP
credentials in memory and exposes a fixed, read-mostly surface:

- read: wallet address, balances, position book, own audit trail
- write: *submit a proposal* and *read your own proposals*

There is deliberately no "send" method on the agent surface. The only path to a
signed transaction is proposal → risk attestation → Big Pickle allocation →
executor. An agent cannot call it directly at any privilege level, because the
gateway does not expose it and the executor does not listen to the gateway's
write surface for transactions.
