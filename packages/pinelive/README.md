# @heyphat/pinelive

`@heyphat/pinelive` is pinestack's forward-execution layer. It advances a piner
strategy over market data supplied by `@heyphat/pinery`, reads piner's target
position, and either computes without a broker or mirrors authoritative bar-close
targets through a broker while writing an auditable JSONL ledger.

Pinelive has one strict run configuration: `"configVersion": 3`. All durable
run records use one ledger format whose events contain `schemaVersion: 3`.

## Availability and safety status

Pinelive ships as a standalone binary alongside `pinerun` and `pinetop`, with a
deliberately conservative distribution posture:

- It is not published to npm.
- Pinestack GitHub Releases carry `pinelive` for all five targets, and the binary
  self-updates with `pinelive upgrade` using the shared checksum-verified update
  implementation.
- The `curl | sh` installer does **not** fetch it by default. Opt in with
  `PINESTACK_BINS="pinerun pinetop pinelive"`; the default install remains
  analysis-only because Pinelive can place orders.
- From a source checkout it runs with
  `bun packages/pinelive/src/cli.ts --help` (Bun 1.2.5). Build a binary with
  `bun run build:bin` inside `packages/pinelive`, or pass `--product pinelive`
  from the repository root.

> **Official Tiger safety verdict:** the built-in official Tiger adapter is
> intentionally blocked and ineligible for armed production execution. It
> cannot prove complete open-order inventory, authoritative exact order absence,
> or closure of the snapshot/account-stream gap. Armed startup therefore
> reports structured blocked data and performs no broker mutation. See the
> [production-safety runbook](../../docs/pinelive-production-safety.md).

Mirrored execution uses a non-stealable ledger lease. Armed Tiger additionally
uses a non-stealable account/exact-instrument claim. These are cooperative
same-host exclusion mechanisms, not venue fencing or cross-host coordination;
existing ownership files are never stolen automatically. Paper account state
does not survive a restart. Possibly sent orders remain durable and are never
retransmitted without definite proof that they were not sent. Use read-only
`status` and confirmation-gated `recover` only as documented in the
[production-safety runbook](../../docs/pinelive-production-safety.md).

### Current capability matrix

| Surface        | Current support                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compute-only   | `bar-close`, or `every-update` with compiled `calc_on_every_tick` support and an authoritative provider `liveBars()` contract. This posture constructs no broker and cannot submit broker effects; the CLI still uses internal durable compute-state storage and a temporary file lock.    |
| Paper mirrored | `execution.mirrorOn: "bar-close"` only. With every-update data, forming decisions are computed and durably skipped; only the authoritative final can affect Paper. Paper account state remains process-local.                                                                              |
| Exact history  | Standard or finite Bar Magnifier warmup on the characterized non-`calc_on_order_fills` path. Exact static `request.security` feeds use explicit feed, per-feed-bar, and total-bar budgets and are close-only.                                                                              |
| Tiger monitor  | `execution.armed: false` connects read-only, acquires no account claim, journals `execution-ineligible` decisions, and performs no mutation.                                                                                                                                               |
| Tiger armed    | Requires cooperative ownership, complete venue bootstrap, authoritative exact lookup, and gap-free account synchronization. Missing proof returns structured blocked data. The official transport cannot satisfy these requirements and remains ineligible for armed production execution. |

Piner does not currently expose the typed pending-order snapshot and per-fill
stream needed for forming-revision Paper effects, and complete Bar Magnifier
data is inactive with `calc_on_order_fills=true`. Those paths remain unavailable.
Repository tests do not constitute TradingView, broker, exchange, venue, release,
or production evidence. The opt-in credentialed Tiger test is read-only and
does not authorize mutation.

## Architecture boundaries

Pinelive coordinates three owners without duplicating their responsibilities:

1. **pinery owns market data.** A `MarketDataProvider` resolves one exact
   instrument, returns finite warmup history, and supplies closed bars or an
   explicitly advertised revision/finality stream. CSV parsing, bar closure,
   overlap, deduplication, and gap recovery stay in pinery.
2. **piner owns strategy state.** Pinelive advances piner for admitted forming or
   final snapshots and reads `strategy.position_size` as the target.
3. **pinelive owns execution orchestration.** A `Broker` reports the exact
   position and account, submits corrections, and exposes truthful capabilities.
   The runner binds identities, enforces execution gates, drains provider work,
   and writes the ledger.

```text
pinery MarketDataProvider ──closed bars / explicit updates──▶ piner strategy
          │                                                       │ target position
          │ exact resolved instrument                             ▼
          └─────────────────────────────────────────────────▶ pinelive runner ──▶ Broker
                                                                      │
                                                                      └──▶ JSONL ledger
```

A run freezes one `RunInstrumentBinding`. The Pine strategy sees its configured
strategy symbol, while pinery and the broker retain the opaque exact venue
identity. Pinelive does not silently roll contracts or substitute a nearby
instrument.

## Run from source

From the repository root:

```bash
bun install --frozen-lockfile
bun packages/pinelive/src/cli.ts --help
```

The CLI commands are:

```text
run --config <path>
validate --config <path>
status --ledger <path> [--json] [--recent <n>]
status --all [--json] [--recent <n>]
status --instance <instance-id> [--json] [--recent <n>]
recover --ledger <path> --lease <path> [--account-claim <path>] --confirm [--json]
parity <live.jsonl> <expected.jsonl>
upgrade [--check]
--version
```

## Paper quick start

This canonical example uses checked-in CSV fixtures and `PaperBroker`; it does
not contact a market-data or broker service.

Create `pinelive.json` in the repository root:

```json
{
  "configVersion": 3,
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
  "security": { "enabled": false },
  "execution": {
    "kind": "mirrored",
    "mirrorOn": "bar-close",
    "broker": { "id": "paper" },
    "ledger": { "path": ".pinelive/ledger.jsonl", "durability": "sync" },
    "lease": { "path": ".pinelive/ledger.lock" }
  }
}
```

Validate the source and configuration without constructing a provider, broker,
ledger, lease, credential profile, or network client, then run it:

```bash
bun packages/pinelive/src/cli.ts validate --config pinelive.json
bun packages/pinelive/src/cli.ts run --config pinelive.json
```

`cutoverTime` is a Unix-seconds replay boundary. The CSV provider returns the 20
most recent `BTCUSDT` one-hour bars before it as warmup, then `ReplayProvider`
yields later closed bars in order. `examples/data/instruments.csv` supplies tick
and quantity metadata. Warmup establishes piner state without submitting an
order; later authoritative closes are reconciled through PaperBroker and
recorded in `.pinelive/ledger.jsonl`.

To calculate targets without a broker, replace the entire `execution` object
with:

```json
{ "kind": "compute-only" }
```

The CLI still writes durable compute-state events and uses a temporary file lock
to keep recovery and sequence allocation safe. Their paths are derived from the
strategy, symbol, and timeframe rather than configured in `execution`.

## Configuration

Pinelive rejects unknown keys and invalid combinations instead of silently
coercing them. The current top-level sections are:

| Section         | Purpose                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `configVersion` | Required literal `3`.                                                                                                |
| `strategy`      | Path to a Pine strategy.                                                                                             |
| `symbol`        | Strategy-facing symbol; the provider resolves the exact execution instrument.                                        |
| `timeframe`     | Canonical pinery chart timeframe such as `5m` or `1h`.                                                               |
| `warmupBars`    | Optional non-negative number of chart bars replayed before forward evaluation.                                       |
| `inputs`        | Optional fixed Pine input values for the run.                                                                        |
| `data`          | Strict pinery provider configuration, including any provider-specific `profile`.                                     |
| `historical`    | `standard`, or finite `bar-magnifier` history with explicit target/raw budgets.                                      |
| `live`          | `bar-close`, or `every-update` with an explicit native or lower-bars source and bounded reconnect settings.          |
| `security`      | Disabled, or exact static secondary-feed resolution with explicit budgets and bounded I/O.                           |
| `execution`     | Exactly `compute-only` or strict mirrored execution; mirrored order, broker, ledger, lease, and gates all live here. |
| `alerts`        | Optional bounded webhook or Telegram delivery configuration.                                                         |

The pure validation boundary normalizes this structure and compiles the strategy
before opening any runtime resource. `every-update` requires
`strategy(calc_on_every_tick=true)` and an authoritative provider update
contract. It rejects `request.security` dependencies. Mirrored execution remains
final-only with `mirrorOn: "bar-close"`.

Mirrored order and broker policy are nested under `execution`. Market is the
default order type. Bar-close startup reconciliation, when intentionally used,
is `execution.reconcileOnStart`; it is disabled by default. `execution.armed`
applies only to Tiger: `false` selects monitor posture and `true` requests the
armed gate. It is not valid for Paper.

Advanced provider, history, live-source, alert, and shutdown settings are
covered by the [forward-testing guide](../../docs/pinelive.md). Configuration is
fail-closed: unknown or incompatible provider, symbol, cadence, security,
history, broker, and asset-class combinations do not become a different live
instrument or execution posture.

### Exact historical data and `request.security`

Bar Magnifier history requires explicit finite budgets:

```json
{
  "historical": {
    "mode": "bar-magnifier",
    "maxMagnifierTargetBars": 100000,
    "maxMagnifierRawBars": 500000
  },
  "security": {
    "enabled": true,
    "maxExactSecurityFeeds": 8,
    "maxExactSecurityBarsPerFeed": 10000,
    "maxExactSecurityTotalBars": 40000,
    "concurrency": 4,
    "requestTimeoutMs": 30000,
    "maxStaleRefreshes": 0
  }
}
```

Exact security is available only for close-only cadence with statically and
completely classified dependencies. Resolution, history, timeout, malformed
data, insufficient depth, and budget failures abort startup. A dependency first
discovered during live evaluation stops the run before broker reconciliation.
A refresh failure records a durable security-health event and, by default,
stops before reconciliation. Provider work and shutdown drainage are bounded.

Pinelive deduplicates call sites into pinery feed states, fetches the finest
required base timeframe, injects warmup before chart replay, and performs
bounded overlap/catch-up refreshes before each chart tick. A self-reference
reuses the chart's exact resolved instrument. See
[`request.security` secondary feeds](../../docs/pinelive.md#requestsecurity-secondary-feeds)
for addressing, planning, health snapshots, and limits.

## Lifecycle, reconciliation, and ledger

A run proceeds through one fail-closed lifecycle:

1. Strictly normalize the configuration and compile the strategy without runtime
   resources.
2. Freeze the prepared finite-history authority and exact pinery instrument.
3. For mirrored execution, recover only the crash-safe JSONL prefix, compare the
   recovered authority, serialize startup against confirmed recovery, acquire
   the non-stealable lease, and durably record ownership before constructing the
   broker.
4. Compare the strong execution binding before any mark, position read, or order
   effect. Armed Tiger must also satisfy the account/instrument claim and venue
   synchronization gate.
5. Load chart and eligible static secondary-feed warmup without ordering.
6. Evaluate admitted updates. Forming, recovered, and discontinuous updates are
   journaled but cannot bypass the final-only mirror gate.
7. On shutdown, cancel scheduling first, disconnect the provider, drain bounded
   secondary-feed work, revoke broker mutation capability, and attempt all
   broker/ledger cleanup. Shutdown never flattens automatically.

Mirrored runs write schema version 3 authority, binding, lease, account-claim,
eligibility, recovery, decision, breaker, intent, attempt, result, and
transmission-certainty events. The append-only ledger is never pruned. Only
in-memory finalized per-bar decision state is bounded; bars with unresolved
orders or position uncertainty remain retained.

Mirrored execution has fixed safety budgets: 8 admitted target changes per bar,
4 order intents per bar, 20 submit attempts per rolling minute, and 3
consecutive errors before the breaker latches. Journal-only skips do not consume
the target budget. Refusing an authoritative final latches `target-limit`
because the mirrored position has stopped tracking the strategy.

Deterministic client IDs frame each identity component with its length. Binding,
side, quantity, order type, and snapped limit price cannot collide merely
because user strings contain separators. Before transmission, Pinelive durably
records intent and attempt. A retry is allowed only after explicit
`definitely-not-sent` proof. An unknown or possibly sent outcome remains
unresolved, is not retransmitted after restart, and keeps execution blocked
until authoritative exact venue evidence resolves it.

### Ownership, status, and recovery

The ledger lease and Tiger account/exact-instrument claim coordinate cooperative
processes on one host. They are not broker-enforced fencing, distributed
consensus, or protection against another host, application, manual broker
session, or equally privileged local user. Ordinary startup never steals an
existing lease or claim, regardless of apparent age.

Status is read-only and opens no provider, broker, alert channel, lease, or
claim. The explicit-ledger form remains the durable primitive:

```bash
pinelive status --ledger .pinelive/ledger.jsonl --json --recent 20
```

Pinelive also maintains a private discovery registry at `~/.pinelive/runs`
(or `PINELIVE_RUNS_DIR`). Active registrations are advisory process and path
evidence; each advisory registry operation is time-bounded so it cannot hold
runtime cancellation or ownership cleanup open. Terminal history is published
with an atomic no-replace operation before the active record is removed. Its
captured final sequence identifies that run's validated ledger prefix, so later
rows appended by a restart do not invalidate retained history.
Registry directories use mode `0700` and records mode `0600` where supported,
readers refuse symlinks and non-regular files, and each record is bounded to
64 KiB. Enumeration is capped at 1,000 entries. Terminal history is retained
best-effort within all three limits: 500 records, 8 MiB, and 30 days. Retention
never removes a ledger, claim, lease, or recovery quarantine artifact.

Use aggregate or exact-instance discovery with:

```bash
pinelive status --all
pinelive status --all --json --recent 20
pinelive status --instance <instance-id> --json --recent 20
```

`--ledger`, `--all`, and `--instance` are mutually exclusive. Aggregate status
isolates malformed registry records or unreadable ledgers as per-entry errors,
combines active and terminal history, probes process and supplied physical claim
paths conservatively, and reports conflicts without changing anything. It does
not construct a provider or broker, acquire/release a claim, prune the registry,
invoke recovery, or query the venue.

The five-second heartbeat and lifecycle registration are **discovery evidence
only**. A fresh heartbeat does not prove the trading loop is progressing,
claims are held, synchronization is current, or execution is safe; a stale
heartbeat does not prove death. Registry failure emits a normalized warning but
never grants or revokes execution authority. Durable
`executionEligibility` remains the execution evidence when available.

Neither explicit nor aggregate status proves another host inactive or proves a
clean account has no orders. Automation must inspect durable posture,
eligibility, ownership, breaker, and unresolved-effect evidence rather than a
process exit code or heartbeat alone. Registry/Pinetop discovery never replaces
venue synchronization, the V3 ledger, or exact-owner execution/account claims.

Recovery is only for abandoned local ownership artifacts, never broker-effect
ambiguity. It requires `--confirm`, conservative proof that the exact prior
process instance is gone, matching physical and durable ownership identities,
and no unresolved broker effect. It quarantines stale artifacts rather than
deleting them and records the ownership loss. If stable-storage acknowledgement
of a lease or account-claim acquisition is uncertain, Pinelive retains the
physical ownership layers instead of creating a false handoff; recovery accepts
an otherwise unrecorded claim only when owner, PID, and boot identity exactly
match the durable and physical execution lease. Failed pre-journal validation
restores stale administrative evidence without overwriting a concurrent owner.
Never delete a lock as a recovery procedure. Follow the
[confirmed recovery workflow](../../docs/pinelive-production-safety.md#explicit-stale-claim-recovery).

Paper state is process-local. Ledger recovery restores scheduler and effect
history, not the simulated Paper position, basis, or PnL. A restarted Paper run
can therefore surface a position mismatch and must not be treated as a durable
brokerage account.

## Market and limit orders

Market orders are the default. To mirror target changes with limits, place the
policy under `execution.order`:

```json
{
  "execution": {
    "kind": "mirrored",
    "mirrorOn": "bar-close",
    "order": {
      "type": "limit",
      "limitOffsetTicks": 0
    },
    "broker": { "id": "paper" },
    "ledger": { "path": ".pinelive/ledger.jsonl", "durability": "sync" },
    "lease": { "path": ".pinelive/ledger.lock" }
  }
}
```

The authoritative closed bar's close is the reference. A buy limit subtracts
`limitOffsetTicks * mintick`; a sell limit adds it. Side-aware rounding keeps the
result on the passive side of the venue tick grid.

PaperBroker does not simulate an order book. It fills only an immediately
marketable limit, caps the fill so it cannot violate the limit, and rejects a
non-marketable limit instead of inventing a resting order.

Tiger sends native futures `LMT` orders. Limit mode requires
`execution.broker.cancelStuckOrders: true` and cancellation-capable transport.
If an order outlives the initial polling budget, the broker requests
cancellation and continues bounded terminal-state polling; it refuses a
different correction while the earlier submission remains unresolved. A fill
that wins the cancellation race remains authoritative. `flatten()` is always
market-only.

## Alerts

Pine `alert()` calls reach registered channels, the headless counterpart of
TradingView alert firing. Conditions live in Pine; Pinelive owns bounded
delivery:

```jsonc
"alerts": {
  "channels": [{ "id": "webhook", "name": "ops", "url": "https://example.com/hook" }]
}
```

Warmup and replay alerts remain data. Only fresh authoritative bar closes
dispatch, so forming revisions and recovered replays do not double-send.
Delivery is fail-open and bounded and runs after reconciliation, so it cannot
delay trading. Every gated alert is journaled with per-channel outcomes; channel
secrets do not appear in ledger rows, logs, or errors. Built-in channels are
`webhook` and `telegram`. Custom channels implement `AlertChannel` and must pass
`runAlertChannelConformance()` from `@heyphat/pinelive/testing`. See
[Pinelive alerts](../../docs/pinelive-alerts.md).

## Paper broker

PaperBroker models signed net quantity, weighted basis, realized/unrealized PnL,
point value, commission, quantity/tick validation, and client-ID idempotency. It
is deterministic and intended for replay, development, conformance, and parity
work, not as evidence that bar-close fills model live execution quality.

There is no margin or buying-power model: `available` equals equity, so Paper
cannot validate margin-sensitive behavior. Limit mirroring assumes tick-aligned
reference closes. Because the derived limit is snapped passively, an off-grid
zero-offset buy can land one tick below the mark and be rejected as
non-marketable.

## Tiger readiness

The Node entry defaults to the pinned official
[`@tigeropenapi/tigeropen`](https://github.com/tigerfintech/openapi-typescript-sdk)
SDK adapters. Transport registration remains available for fixtures and custom
implementations.

Tiger has two explicit execution postures under `execution`:

- `armed: false` is a broker-connected read-only monitor with no account claim,
  scheduler, or mutation. Decisions are journaled as execution-ineligible.
- `armed: true` requests the complete ownership and synchronization gate. It
  does not imply eligibility or authorization.

An armed custom adapter must prove complete open/uncertain-order inventory,
authoritative exact terminal lookup including exact absence, and an
account/position/order snapshot tied to a gap-free resumable account stream. It
must maintain a current execution-safety assertion and recheck the composite
lease, claim, and synchronization guard immediately before every mutation.
Unrelated REST reads, bounded recent-order searches, or client metadata do not
satisfy these requirements.

The built-in official transport cannot prove complete inventory or exact
absence, and the SDK exposes no resumable account event sequence for closing the
snapshot/account-stream gap. It therefore remains intentionally blocked and
ineligible for armed production execution. It stays connected long enough to
report precise blocking reasons but performs no mutation. Any durable ambiguous
effect remains unresolved because exact lookup is `unsupported`.

Offline tests cover safety gates, restart no-retransmit behavior, SDK mapping,
polling, cancellation, redaction, claim contention, status, and recovery. The
opt-in credentialed test is read-only: it checks connectivity, creates ambiguity
only against an injected offline transport, and proves the official restart
remains blocked without mutation or another attempt. Demo/live placement,
cancellation, fills, real after-send recovery, venue operational approval, and
automatic futures rolling remain unauthorized or unimplemented. `userMark` is
searchable metadata, not venue-enforced idempotency, and SDK HTTP calls lack
request-level `AbortSignal` support.

For market-data testing, prefer Tiger data with a Paper broker. For credentialed
execution-side inspection, use Tiger monitor posture. Do not represent the
official adapter as sandbox- or production-approved. Follow the
[production-safety runbook](../../docs/pinelive-production-safety.md) for gate
semantics, status, incident recovery, and the credentialed test procedure.

### Tiger credentials

Keep provider and broker secrets in local mode-0600 profile files or preferred
`TIGEROPEN_*` environment variables. In the strict configuration, a Tiger data
profile is `data.profile`; a Tiger execution profile is
`execution.broker.profile`. Paths beginning with `~` are expanded, a directory
resolves to `tiger_openapi_config.properties` within it, and a nonexistent
explicit path fails immediately.

Preferred environment variables are:

- `TIGEROPEN_TIGER_ID`
- `TIGEROPEN_PRIVATE_KEY`
- `TIGEROPEN_ACCOUNT`
- `TIGEROPEN_TOKEN`
- optional `TIGEROPEN_LICENSE`
- optional institutional `TIGEROPEN_SECRET_KEY`

Never commit credentials or include them in logs, ledgers, fixtures, or error
messages. The credentialed test in the production-safety runbook is read-only;
mutation remains unauthorized while the official adapter is synchronization-
ineligible.

## Parity

Expected JSONL rows use `{ "barTime": 1700000000, "target": 1 }`. Compare them
with one live or replay ledger:

```bash
bun packages/pinelive/src/cli.ts parity \
  .pinelive/ledger.jsonl expected-targets.jsonl
```

Parity scopes one run, strategy, binding, and timeframe and reports missing or
duplicate cycles, target mismatches, rejects, and execution drift. It does not
claim fill-price parity.

## Public entry points

- `@heyphat/pinelive` — browser-safe strict configuration, prepared runtime,
  authority/binding, scheduler/recovery/lease contracts, brokers, units, parity,
  and shared types.
- `@heyphat/pinelive/node` — durable JSONL prefix/recovery helpers,
  `FileExecutionLease`, account/instrument claims, private active-run registry
  and terminal history, aggregate/exact-instance read-only discovery,
  explicit-ledger status, explicit stale-claim recovery, Node factories,
  official Tiger SDK adapters, and transport overrides.
- `@heyphat/pinelive/config` — strict normalization and compiled-source
  validation contracts.
- `@heyphat/pinelive/intrabar` — focused live configuration, authority, state,
  runner, and server exports.
- `@heyphat/pinelive/testing` — `runBrokerConformance()` and conformance helpers
  for broker and alert-channel implementations.
- `packages/pinelive/src/cli.ts` — source-checkout `run`, `validate`, `status`,
  `recover`, and `parity` CLI.

A broker implements `Broker` (`id`, `capabilities`, `instrument`, `getPosition`,
`getAccount`, `submit`, `flatten`, and optional lifecycle/cancel methods) and
must pass `runBrokerConformance()`. Capabilities must describe the behavior the
adapter actually implements. Production execution additionally requires the
proofs described above. See the
[broker adapter contract](../../docs/pinelive-adapter-contract.md).

## More documentation

- [Forward-testing guide](../../docs/pinelive.md)
- [Production-safety operations](../../docs/pinelive-production-safety.md)
- [Broker adapter contract](../../docs/pinelive-adapter-contract.md)
- [Pinery market-data API](../pinery/README.md)

## License

[GNU AGPL-3.0](../../LICENSE) © Phat Huynh.
