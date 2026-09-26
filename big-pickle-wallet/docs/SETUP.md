# Big Pickle foundation setup

This document describes the current development and validation foundation. It
does not enable live trading and contains no credentials.

## Prerequisites

- Node.js 20 or newer
- npm
- A checkout of this repository

The current foundation uses the existing CDP/Base modules and the committed
aggressive policy. The permitted network is `base-sepolia`; mainnet is disabled.

## Install

```bash
cd big-pickle-wallet
npm ci
```

Do not copy `node_modules`, `state`, `logs`, vaults, private keys, or `.env`
files into git. Runtime state is kept under `state/` by default and is ignored.
Set `BPW_RUNTIME_ROOT` to use another local runtime directory.

## Safe validation commands

```bash
npm run typecheck
npm test
npm run smoke
```

The smoke test uses temporary directories, generated ephemeral attestation keys,

## CLI

The CLI is intentionally limited to inspection and safety controls:

```bash
npm run cli -- status
npm run cli -- policy
npm run cli -- freeze "operator review"
npm run cli -- unfreeze "review complete"
npm run cli -- kill "emergency stop"
npm run cli -- audit
npm run cli -- smoke
```

`status` accepts `--portfolio-micros` for deterministic drawdown inspection and
all commands accept `--root` and `--policy`. There are currently no trading
commands.

## Credentials and CDP use

The CDP client reads credentials from the process environment only when a future
wallet operation explicitly constructs it. Never put values in source, policy
files, documentation, shell history, or audit details. The smoke test and the
foundation CLI do not require CDP credentials.

When CDP integration is later exercised, use a dedicated Base Sepolia wallet and
keep the human emergency stop available. Do not enable Base mainnet or fund a
live wallet as part of this stage.

## Runtime safety

- A present or unreadable kill-switch file fails closed.
- A present or unreadable freeze file fails closed.
- Freeze release is owner-only.
- Audit logs are hash chained and written with restrictive permissions.
- Policy failures are refusals, not fallback defaults.
- No LLM or agent runtime is imported by the deterministic executor.

## Project layout

- `src/control/` — kill switch, freeze state, daily ledger, circuit breakers
- `src/policy/` — strict policy parsing and deterministic hard limits
- `src/pipeline/` — proposal validation and Risk attestations
- `src/executor/` — deterministic CDP execution boundary
- `src/audit/` — tamper-evident local audit log
- `scripts/smoke-test.ts` — no-money foundation smoke test
- `tests/` — focused safety tests

Advanced Trade is documented as the primary **future exchange rail** in
`docs/ADR-0002-execution-substrate.md`; it is not implemented or enabled by this
stage. CDP/Base remains the secondary on-chain rail and must not be removed.
