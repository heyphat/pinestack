# @heyphat/pinelive

`@heyphat/pinelive` is pinestack's forward-execution layer. Its V1
compatibility runtime advances a piner strategy on closed bars supplied by
`@heyphat/pinery`; its V2 runtime can also evaluate accepted forming revisions.
Pinelive reads piner's target position and, only in a supported mirrored mode,
reconciles that target through a broker while writing an auditable JSONL ledger.

## Availability and safety status

Pinelive ships as a standalone binary alongside `pinerun` and `pinetop`, with a
deliberately conservative distribution posture:

- It is not published to npm.
- Pinestack GitHub Releases carry `pinelive` for all five targets, and the
  binary self-updates with `pinelive upgrade` (checksum-verified, the shared
  pinerun implementation).
- The `curl | sh` installer does **not** fetch it by default: opt in with
  `PINESTACK_BINS="pinerun pinetop pinelive"`. The default install stays
  analysis-only because this is the binary that can place orders.
- From a source checkout it runs without any install:
  `bun packages/pinelive/src/cli.ts --help` (Bun 1.2.5). Build your own binary
  with `bun run build:bin` inside `packages/pinelive` (or
  `--product pinelive` from anywhere; `--local` builds against a sibling
  piner checkout, like pinerun).
- Its version is bumped in lockstep with the other workspace packages, so a
  checkout's four manifests never disagree.

`PaperBroker` is the safe default. The Tiger market-data and execution adapters
have extensive offline tests against injected SDK facades, but no credentialed
quote/history, entitlement, demo/live order, cancellation, or fill validation.
They are **not sandbox- or production-approved**. See
[Tiger readiness](#tiger-readiness) before configuring Tiger.

### Current capability matrix

| Surface               | Current support                                                                                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 compatibility      | Close-only evaluation from `closedBars()` with the existing eager broker path.                                                                                                                                                                                                |
| V2 compute-only       | `bar-close`, or `every-update` with compiled `calc_on_every_tick` support and an authoritative provider `liveBars()` contract; compute-only has no broker factory.                                                                                                            |
| V2 Paper              | `mirrorOn: "bar-close"` only. With every-update cadence, forming decisions are computed and durably skipped; only the authoritative final can affect Paper. `mirrorOn: "every-update"` is rejected during pure validation/preparation before provider or broker construction. |
| Exact historical data | Standard or finite Bar Magnifier warmup on the characterized non-COOF path. Exact static security, including separate feed/per-feed/total budgets, is close-only; every-update security is rejected before data I/O.                                                          |
| Piner blockers        | Piner 0.11.1 has no typed public pending-order snapshot or per-fill stream and reports complete magnifier data inactive with `calc_on_order_fills=true`; forming Paper effects and active magnifier+COOF remain unavailable.                                                  |
| Tiger blockers        | Tiger `liveBars()` remains unadvertised, and V2 Tiger execution is rejected before execution credentials or broker construction. Credentialed data/finality and demo/live execution gates were not run and are not authorized.                                                |

All stated evidence is repository-owned and offline. It is not TradingView,
broker, exchange, venue, credentialed Tiger, release, or production evidence.

## Architecture boundaries

Pinelive coordinates three owners without duplicating their responsibilities:

1. **pinery owns market data.** A `MarketDataProvider` resolves one exact
   instrument and returns warmup history. V1 consumes `closedBars()`; a V2
   every-update run requires an explicitly advertised `liveBars()` stream with
   revision and authoritative-final semantics. CSV parsing, closure decisions,
   overlap, deduplication, and gap recovery stay in pinery.
2. **piner owns strategy state.** V1 advances piner once per yielded closed chart
   bar. V2 advances accepted forming/final snapshots according to its prepared
   cadence and reads `strategy.position_size` as the target.
3. **pinelive owns execution orchestration.** A `Broker` reports the exact
   position/account, submits corrections, and exposes truthful capabilities.
   The runner binds identities, enforces arming, drains provider work, and writes
   the ledger.

```text
pinery MarketDataProvider ──closed bars / explicit updates──▶ piner strategy
          │                                                       │ target position
          │ exact resolved instrument                             ▼
          └─────────────────────────────────────────────────▶ pinelive runner ──▶ Broker
                                                                      │
                                                                      └──▶ JSONL ledger
```

A run freezes one `RunInstrumentBinding`. The Pine strategy sees its configured
strategy symbol, while pinery and the broker retain the opaque/exact venue
identity. Pinelive does not silently roll contracts or substitute a nearby
instrument.

## Run from source

From the repository root:

```bash
bun install --frozen-lockfile
bun packages/pinelive/src/cli.ts --help
```

The CLI commands:

```text
run --config <path> [--tiger-profile <path>]
validate --config <path>
parity <live.jsonl> <expected.jsonl>
upgrade [--check]
--version
```

## Paper quick start (v1 compatibility)

This example uses only checked-in CSV fixtures and `PaperBroker`; it does not
contact a market-data or broker service.

Create `pinelive.paper.json` in the repository root:

```json
{
  "configVersion": 1,
  "strategy": "examples/rsi-mean-reversion.pine",
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "warmupBars": 20,
  "data": {
    "provider": "csv",
    "dataDir": "examples/data",
    "cutoverTime": 1704139200
  },
  "broker": {
    "id": "paper"
  },
  "armed": false,
  "ledger": ".pinelive/ledger.jsonl"
}
```

Run it:

```bash
bun packages/pinelive/src/cli.ts run --config pinelive.paper.json
```

`cutoverTime` is a Unix-seconds replay boundary. The CSV provider returns the 20
most recent `BTCUSDT` one-hour bars before it as warmup, then `ReplayProvider`
yields later closed bars in order. `examples/data/instruments.csv` supplies the
instrument tick and quantity metadata. Warmup establishes piner state without
submitting an order; subsequent bars are reconciled through PaperBroker and
recorded in `.pinelive/ledger.jsonl`.

Keep `armed: false` for Paper runs. Real Tiger submission and flatten paths
require explicit arming, but arming alone does not make the adapter safe for
sandbox or production use.

## Configuration

The v1 compatibility CLI accepts the fields below. V2 uses the stricter
configuration shown in the next section.

| Field              | Purpose                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `configVersion`    | `1` for this compatibility runtime.                                              |
| `strategy`         | Path to a Pine strategy.                                                         |
| `symbol`           | Strategy-facing symbol; the provider resolves the exact execution instrument.    |
| `timeframe`        | Canonical pinery timeframe such as `5m` or `1h`.                                 |
| `warmupBars`       | Chart bars replayed before forward reconciliation.                               |
| `data`             | Strict pinery provider configuration (`csv`, replay-backed providers, or Tiger). |
| `broker`           | `{"id":"paper"}` or a configured Tiger broker.                                   |
| `order`            | Optional execution policy; market is the default, limit is explicit.             |
| `armed`            | Global execution gate. Tiger also applies independent submit/flatten gates.      |
| `ledger`           | JSONL output path.                                                               |
| `reconcileOnStart` | Optional explicit startup drift correction; disabled by default.                 |
| `tigerProfile`     | Optional shared Tiger profile path for both data and broker sections.            |

Advanced secondary-feed, shutdown, Tiger polling, and credential fields are
documented in the [forward-testing guide](../../docs/pinelive.md).
Configuration is fail-closed: unknown or incompatible provider/symbol/asset-class
combinations do not silently coerce into a different live instrument.

### V2 intrabar runtime

V2 performs a pure normalization/compile preflight before opening a provider,
credential profile, broker, ledger, or lease. A compute-only bar-close config is:

```json
{
  "configVersion": 2,
  "strategy": "examples/rsi-mean-reversion.pine",
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "warmupBars": 20,
  "data": {
    "provider": "csv",
    "dataDir": "examples/data",
    "cutoverTime": 1704139200
  },
  "historical": { "mode": "standard" },
  "live": { "cadence": "bar-close" },
  "execution": { "kind": "compute-only" }
}
```

Validate without constructing any runtime resource, then run:

```bash
bun packages/pinelive/src/cli.ts validate --config pinelive.v2.json
bun packages/pinelive/src/cli.ts run --config pinelive.v2.json
```

For Paper mirroring, replace `execution` with:

```json
{
  "kind": "mirrored",
  "mirrorOn": "bar-close",
  "broker": { "id": "paper" },
  "ledger": { "path": ".pinelive/v2.jsonl", "durability": "sync" },
  "lease": { "path": ".pinelive/v2.lock" }
}
```

V2 persists schema-v3 authority, binding, recovery, lease, decision, and order
events. It recovers only the crash-safe JSONL prefix and requires a non-stealable
file lease for mirrored execution. Compute-only output contains no account
fields; mirrored output is printed only when execution remains safe. V2 Tiger
broker execution is deliberately unavailable before any Tiger execution
credentials or profile are read. Tiger may still be selected as the data
provider, subject to the provider's own readiness restrictions.

#### Execution safety limits

Mirrored execution runs under fixed per-bar and per-minute budgets — 8 admitted
target changes per bar, 4 order intents per bar, 20 submit attempts per rolling
minute, and 3 consecutive errors before the breaker latches. They are not
configurable while the every-update mirror cadence is fail-closed.

The per-bar target budget counts only evaluations **admitted** for broker
correction. Journal-only skips never consume it, so an every-update bar that
computes hundreds of forming revisions cannot starve its own authoritative close.
Should an authoritative final ever be refused by that budget, the breaker latches
with reason `target-limit` and the runtime logs it, because a dropped final means
the mirrored position has stopped tracking the strategy.

`TargetScheduler` retains finalized per-bar decision state for a bounded window
(`retainBars`, default 512 bars per binding) so multi-day runs do not grow
without limit. Pruning is in-memory only — the durable ledger is never pruned,
and a bar is retained while any of its orders is unresolved or its position
uncertainty has not been reset.

## Lifecycle, reconciliation, and ledger

V1 startup performs these steps in order:

1. Validate the config and compile the strategy.
2. Resolve and freeze the exact pinery instrument.
3. Connect the broker and verify contract, tick, quantity, minimum-order, and
   point-value compatibility.
4. Load chart and `request.security` warmup without ordering.
5. Optionally perform the separately recorded `reconcileOnStart` correction.
6. For each yielded closed chart bar, refresh dependencies, tick piner once,
   read the target, reconcile, and append one cycle record.

Schema-v2 ledgers start with a binding record and preserve the provider/broker
ids, strategy and execution symbols, metadata, stable binding fingerprint, and
the complete requested order economics. Existing schema-v1 cycle JSON remains
readable by parity tooling.

V2 first freezes a prepared authority from finite history, compares recovered
authority before lease or broker ownership, records lease acquisition before the
lazy Paper broker factory, and compares the strong execution binding before any
mark, position read, or order. Forming/recovered/discontinuous updates are
journaled but cannot bypass the configured final-only mirror gate.

Shutdown cancels first, asks the provider to disconnect, and drains real
secondary-feed operations before broker/ledger cleanup. A provider that ignores
abort and disconnect produces a bounded cleanup failure instead of a false
successful shutdown. Remaining cleanup is still attempted. Shutdown never
flattens automatically.

Deterministic client ids frame every identity component with its length. The
binding, side, quantity, order type, and snapped limit price therefore cannot
collide merely because user strings contain separators. Ambiguous Tiger
submissions are not retransmitted within the same process, but durable
crash/restart pending state is not implemented.

## Market and limit orders

Market orders are the default. To mirror target changes with limits:

```json
{
  "order": {
    "type": "limit",
    "limitOffsetTicks": 0
  }
}
```

The closed chart bar's close is the reference. A buy limit subtracts
`limitOffsetTicks * mintick`; a sell limit adds it. Side-aware rounding keeps the
result on the passive side of the venue tick grid.

PaperBroker does not simulate an order book. It fills only an immediately
marketable limit, caps the fill so it cannot violate the limit, and rejects a
non-marketable limit instead of inventing a resting order.

Tiger sends native futures `LMT` orders. Limit mode requires
`broker.cancelStuckOrders: true` and cancellation-capable transport. If an order
outlives the initial polling budget, the broker requests cancellation and
continues bounded terminal-state polling; it refuses a different correction
while the previous submission remains unresolved. A fill that wins the
cancellation race remains authoritative. `flatten()` is always market-only.

## `request.security` secondary feeds

Pinelive supports static dependencies and runtime inputs that remain fixed for
the run. It deduplicates call sites into pinery feed states, fetches the finest
required base timeframe, injects warmup before chart replay, and performs
bounded overlap/catch-up refreshes before each live chart tick. A self-reference
reuses the chart's exact resolved instrument.

Safety is fail-closed by default:

- Resolution, history, timeout, malformed-data, and insufficient-depth failures
  abort startup.
- A dependency first discovered during live evaluation stops the run before
  broker reconciliation rather than trading on `na` or `[]`.
- The first refresh failure records a durable security-health event and stops
  before reconciliation unless `maxSecurityStaleRefreshes` explicitly permits a
  bounded stale window.
- `maxSecurityBars` stops the run instead of silently truncating stateful
  indicator history.
- Provider work and shutdown drainage are concurrency- and timeout-bounded.

See [`request.security` secondary feeds](../../docs/pinelive.md#requestsecurity-secondary-feeds)
for addressing, timeframe planning, health snapshots, and configuration limits.

## Alerts

Pine `alert()` calls in the running strategy reach registered channels — the
headless counterpart of TradingView alert firing, mirroring the fractal web
app's host semantics. Conditions live in Pine; pinelive owns delivery:

```jsonc
"alerts": {
  "channels": [{ "id": "webhook", "name": "ops", "url": "https://example.com/hook" }]
}
```

Warmup/replay alerts stay data. Only fresh authoritative bar closes dispatch —
forming revisions and recovered replays never do, so restarts cannot
double-send. A pure sample-time frequency gate (`all` / `once_per_bar` /
`once_per_bar_close`, default close) keys per message; delivery is fail-open
and bounded (per-alert deadline, transient-only retries, per-bar cap) and runs
after the bar's reconcile so it can never delay trading. Every gated alert is
journaled with per-channel outcomes; channel secrets (webhook URL/headers,
Telegram bot token/chat id) appear in no ledger row, log, or error. Built-in
channels: `webhook` and `telegram`. Custom
channels implement `AlertChannel` and must pass `runAlertChannelConformance()`
from `@heyphat/pinelive/testing`. Full semantics:
[docs/pinelive-alerts.md](../../docs/pinelive-alerts.md).

## Paper broker

PaperBroker models signed net quantity, weighted basis, realized/unrealized PnL,
point value, commission, quantity/tick validation, and client-id idempotency. It
is deterministic and intended for replay, development, conformance, and parity
work—not as a claim that bar-close fills model live execution quality.

There is no margin or buying-power model: the account's `available` equals its
equity, so margin-sensitive strategy behavior cannot be validated in paper mode.
Limit mirroring also assumes tick-aligned reference closes. Because the derived
limit is snapped passively (a buy never rounds up, a sell never rounds down), a
reference close that sits off the mintick grid puts a zero-offset buy limit one
tick below the mark, and Paper rejects it as non-marketable with both prices in
the message.

## Tiger readiness

The Node entry defaults to the pinned official
[`@tigeropenapi/tigeropen`](https://github.com/tigerfintech/openapi-typescript-sdk)
SDK adapters. Transport registration remains available for fixtures and custom
implementations.

Offline SDK-facade tests cover futures resolution, intraday timeframe and
end-time conversion, conservative pagination/finality, account/contract/position
mapping, exact `userMark` lookup, market/limit placement response handling,
working/partial/terminal polling, cancellation races, redaction, and ambiguous
same-process submission suppression. They do not contact Tiger.

The following remain unvalidated or unimplemented:

- Credentialed quote/history and entitlement behavior.
- Demo or live order placement, cancellation, and fills.
- Production operational procedures and market-access checks.
- Durable pending-transmission state across crashes/restarts.
- Armed-restart stale-contract and existing-exposure preflight.
- Automatic futures contract rolling.

`userMark` is searchable metadata, not a venue-enforced idempotency key. The SDK
also lacks request-level `AbortSignal` support, so in-flight HTTP calls cannot be
interrupted. Operators must not treat this adapter as sandbox- or
production-approved.

For a future reviewed data dry run, use Tiger data with a Paper broker. In v1
that is `broker.id: "paper"`; in v2 it is
`execution: { "kind": "mirrored", "broker": { "id": "paper" }, ... }`. V2
Tiger broker execution is fail-closed and does not read Tiger execution
credentials. Do not enable real Tiger execution until credentialed validation
and the missing restart controls have been completed and separately approved.

### Tiger credentials

Prefer one local mode-0600 properties file at
`~/.tigeropen/tiger_openapi_config.properties` (or the working directory). To
use another location for v1, set top-level `tigerProfile`, pass
`--tiger-profile <path>`, or set `TIGEROPEN_CONFIG_PATH`; a per-section `profile`
overrides it. V2 accepts profiles only in its strict data section, and V2 Tiger
broker execution remains unavailable. `~` is expanded, a directory resolves to
the standard filename, and a nonexistent explicit path fails immediately.

Environment alternatives are:

- `TIGEROPEN_TIGER_ID`
- `TIGEROPEN_PRIVATE_KEY`
- `TIGEROPEN_ACCOUNT`
- `TIGEROPEN_TOKEN`
- optional `TIGEROPEN_LICENSE`
- optional institutional `TIGEROPEN_SECRET_KEY`

Legacy `TIGER_ID`, `TIGER_PRIVATE_KEY`, and `TIGER_ACCOUNT` remain fallbacks.
Never commit credentials or include them in logs, ledgers, fixtures, or error
messages. Entitlement and live-operation instructions remain intentionally
undocumented until credentialed validation exists.

## Parity

Expected JSONL rows use `{ "barTime": 1700000000, "target": 1 }`. Compare them
with one live/replay ledger:

```bash
bun packages/pinelive/src/cli.ts parity \
  .pinelive/ledger.jsonl expected-targets.jsonl
```

Parity scopes one run/strategy/binding/timeframe and reports missing or duplicate
cycles, target mismatches, rejects, and execution drift. It does not claim
fill-price parity.

## Public entry points

- `@heyphat/pinelive` — browser-safe v1/v2 config, prepared intrabar runtime,
  authority/binding, scheduler/recovery/lease contracts, brokers, units, parity,
  and shared types.
- `@heyphat/pinelive/node` — durable JSONL prefix/recovery helpers,
  `FileExecutionLease`, Node factories, official Tiger SDK adapters, and
  transport overrides.
- `@heyphat/pinelive/config` — strict v1/v2 normalization and compiled-source
  validation contracts.
- `@heyphat/pinelive/intrabar` — focused intrabar config, authority, state,
  runner, and server exports.
- `@heyphat/pinelive/testing` — `runBrokerConformance()` and test helpers for
  broker implementations.
- `packages/pinelive/src/cli.ts` — source-checkout `run`, `validate`, and
  `parity` CLI.

A broker implements `Broker` (`id`, `capabilities`, `instrument`, `getPosition`,
`getAccount`, `submit`, `flatten`, and optional lifecycle/cancel methods) and
must pass `runBrokerConformance()`. Capabilities must describe the behavior the
adapter actually implements. See the
[broker adapter contract](../../docs/pinelive-adapter-contract.md).

## Data-boundary migration

The former pinelive `LiveFeed` and `CsvReplayFeed` APIs were removed. Use
pinery's `MarketDataProvider`, `ReplayProvider`, and Node CSV provider/factory.
This is a deliberate breaking migration: pinelive consumes resolved closed bars
but no longer parses CSV or owns replay timing.

## More documentation

- [Forward-testing guide](../../docs/pinelive.md)
- [Broker adapter contract](../../docs/pinelive-adapter-contract.md)
- [Pinery market-data API](../pinery/README.md)

## License

[GNU AGPL-3.0](../../LICENSE) © Phat Huynh.
