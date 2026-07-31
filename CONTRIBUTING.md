# Contributing to pinestack

Thanks for your interest in contributing. Pinestack is the data, analysis,
interactive, and forward-execution stack around the
[piner](https://github.com/heyphat/piner) Pine Script v6 engine. We welcome bug
reports, fixes, data or broker adapters, tests, and documentation.

## Scope

Pinestack contains four workspace packages:

- **`@heyphat/pinery`** — historical and forward market data, exact instrument
  resolution, replay, timeframe helpers, and Node-only CSV/cache/SDK adapters.
- **`@heyphat/pinerun`** — deterministic jobs and runners plus
  `init`/`scan`/`backtest`/`compare`/`portfolio`/`sweep`/`walkforward` and the
  standalone `pinerun` CLI.
- **`@heyphat/pinetop`** — the interactive layer: a terminal UI over that CLI.
  It computes nothing — it composes argv, spawns `pinerun … --json`, and renders
  the payload, reusing the CLI's own chart and table builders.
- **`@heyphat/pinelive`** — closed-bar forward orchestration, exact position
  mirroring, PaperBroker, Tiger execution adapters, JSONL ledger, parity, and
  broker conformance utilities.

Pinelive consumes pinery's `MarketDataProvider` and `ReplayProvider`; it does not
own CSV parsing, bar-closure policy, or replay timing. Its Node entry defaults to
the official Tiger OpenAPI SDK adapters while retaining transport injection for
fixtures and reviewed custom transports.

The Tiger adapters have offline injected-SDK-facade coverage only. No
credentialed quote/history, entitlement, demo/live order, cancellation, or fill
validation has been completed, and the adapters are not sandbox- or
production-approved. Do not weaken arming, exact-instrument, redaction,
idempotency, cancellation, or fail-closed checks in order to make a demo pass.

Language-engine changes—Pine parsing, code generation, builtins, and strategy
semantics—belong in [piner](https://github.com/heyphat/piner). `@heyphat/piner`
is a peer dependency; pinestack orchestrates the engine rather than
reimplementing it.

By the same rule, a new metric belongs in piner or pinerun, never in pinetop: if
the TUI ever computes a number the CLI cannot print, the two surfaces can
disagree, which is the one failure the architecture exists to prevent.

## Development setup

Use **Bun 1.2.5**, matching mainline CI and the release workflow:

```bash
git clone https://github.com/heyphat/pinestack.git
cd pinestack
bun install --frozen-lockfile
```

Workspace exports point at TypeScript source, so tests and CLIs need no build:

```bash
bun test           # full suite across every package
bun test packages/pinelive/test # offline forward runner + broker suite
bun run typecheck  # tsc -b across every package
bun run format     # prettier --write .
```

Run either CLI from the repository root:

```bash
bun packages/pinerun/src/cli.ts scan examples/rsi.pine \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT --tf 1h --limit 300 \
  --rank "last(rsi)" --top 3

bun packages/pinelive/src/cli.ts --help
```

Or the TUI, which needs a `pinerun` it can spawn:

```bash
bun packages/pinetop/src/cli.ts --pinerun ./dist/pinerun
bun packages/pinetop/src/cli.ts --check-flags   # diff its flag schema vs pinerun --help
```

`pinetop` models pinerun's flags by hand (see the note in
`packages/pinetop/src/flags/schema.ts`), so **when you add or rename a `pinerun`
flag, run `--check-flags`** — it diffs the schema against `pinerun <cmd> --help`
and fails on drift. The release workflow runs it too.

Self-update is shared, not duplicated: `pinetop upgrade` calls pinerun's
`runUpgrade({ binary: 'pinetop' })`. Checksum verification and the atomic swap
over a running executable live in one place on purpose — if you touch
`packages/pinerun/src/upgrade.ts`, you are touching both binaries.

Pinelive is source-checkout/workspace-only. The release installer provides only
the standalone `pinerun` and `pinetop` binaries.

## Determinism and identity are contracts

An analysis run is a function of source, bars, inputs, instrument metadata, and
backend. Pinerun keys and fans out that exact work. If you change the job model,
hash, cache, security-history planning, or a runner, preserve reproducibility and
add coverage for the changed behavior.

Forward execution adds external identity and lifecycle constraints. Preserve the
frozen `RunInstrumentBinding`, strategy-versus-execution symbol distinction,
framed client ids, durable ledger evidence, exact account/position reads, and
bounded shutdown drainage. An error before reconciliation must not silently
become an order.

The durable v3 ledger is a compatibility surface: a change that stops an existing
ledger from replaying is breaking. Two invariants are easy to break by accident
and are covered by tests — a journaled-only decision (a forming revision, a
compute-only skip) must never consume the per-bar **admission** budget that gates
real broker corrections, and dropping an authoritative final must never be silent.
Both have been broken before; keep `packages/pinelive/test/forming-budget.test.ts`
and `intrabar-forming-budget-e2e.test.ts` passing.

## Data providers

Historical adapters implement `HistoryProvider` in
`packages/pinery/src/provider.ts`. Forward adapters implement
`MarketDataProvider`, including strict instrument resolution, warmup history,
exclusive-after closed-bar streaming, cancellation, and cleanup. An adapter may
additionally advertise `liveBars()` for forming-bar updates; if it does, pinery
alone decides finality, and every update must satisfy the strict
`BarUpdateValidator` contract (aligned opens, monotonic event time, one active
forming bar, strictly increasing revisions, `isClose` only for an authoritative
final). Never infer a bar close from elapsed time or child-bar count.

Keep network access behind an injectable transport or the shared retrying HTTP
helper. Read credentials from environment variables or local profiles; never
hardcode, log, ledger, snapshot, or commit them. Tests must be deterministic and
fixture/facade-driven unless a separately approved credentialed validation plan
explicitly says otherwise.

Node-only filesystem or vendor-SDK code belongs behind `@heyphat/pinery/node` or
`@heyphat/pinelive/node`, not in a browser-safe barrel.

## Broker adapters

A broker implements the contract in `packages/pinelive/src/core/broker.ts` and
must pass `runBrokerConformance()`. Its reported capabilities must match the
surface actually implemented. Follow
[`docs/pinelive-adapter-contract.md`](./docs/pinelive-adapter-contract.md) for
account/position identity, terminal fills, cancellation, flattening,
idempotency, arming, error classes, and redaction requirements.

Broker or market-data work that changes readiness claims must update the
[forward guide](./docs/pinelive.md) with the exact evidence and remaining limits.

## Workflow

1. Fork and branch from current `main` (`fix/...`, `feat/...`).
2. Add or update tests for behavior changes; bug fixes need regression coverage.
3. Run the focused tests, then `bun test`, `bun run typecheck`, and formatting.
4. Keep network/credentialed tests out of the default suite.
5. Use [Conventional Commits](https://www.conventionalcommits.org/) such as
   `feat(pinerun): ...`, `fix(pinery): ...`, `feat(pinetop): ...`, or
   `fix(pinelive): ...` — the changelog depends on it.
6. Open a PR explaining what changed, why, safety implications, and validation.

Do not bump versions, create release tags, or modify published assets as part of
a feature PR. Release preparation follows [`RELEASING.md`](./RELEASING.md).

## Reporting bugs

Open an issue with the exact command or a minimal program, symbol/timeframe,
provider/broker mode, expected result, actual result, and sanitized logs. Remove
credentials, account identifiers, tokens, private keys, and proprietary order
data before attaching anything.

For execution issues, state whether the broker was Paper or Tiger, whether the
run was armed, and whether any order outcome was ambiguous. Do not retry an
ambiguous live submission merely to produce a reproduction.

For a `pinetop` bug, the command line at the bottom of the frame **is** the
repro — it is composed from the same state the screen renders, so paste it along
with your terminal size (`echo $COLUMNS×$LINES`), which decides how the page
degrades. `.pinetop/session.jsonl` in the project also logs every invocation
with its exit code and duration.

## License

By contributing, you agree that your contributions are licensed under the
[GNU AGPL-3.0](./LICENSE).
