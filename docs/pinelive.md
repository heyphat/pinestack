# pinelive forward testing

`@heyphat/pinelive` orchestrates three strict boundaries: pinery resolves and
yields market data, piner owns strategy calculations and target position, and a
pinelive `Broker` owns execution. Pinelive never parses CSV, polls quote APIs,
decides bar closure, deduplicates bars, or recovers data gaps.

> **Availability:** pinelive is source-checkout/workspace-only. It is not
> published to npm, has no standalone GitHub Release asset, and is not installed
> by the `pinerun` installer. Use Bun 1.2.5 from the repository root:
>
> ```bash
> bun install --frozen-lockfile
> bun packages/pinelive/src/cli.ts --help
> ```
>
> The shorthand `pinelive` used in later snippets can be enabled for the current
> shell with `alias pinelive='bun packages/pinelive/src/cli.ts'`.

For a checked-in, runnable Paper/CSV configuration, start with the
[package README quick start](../packages/pinelive/README.md#paper-quick-start).
Tiger coverage is offline SDK-facade coverage only and is not sandbox- or
production-approved.

## Current runtime capability matrix

| Surface               | Supported behavior                                                                                                                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 compatibility      | Close-only evaluation from `closedBars()` with the existing eager broker path.                                                                                                                                                                                                                  |
| V2 compute-only       | `bar-close`, or `every-update` when compiled `calc_on_every_tick` metadata and an authoritative provider `liveBars()` contract are present; this branch cannot own a broker factory.                                                                                                            |
| V2 Paper              | `execution.mirrorOn: "bar-close"` only. An every-update cadence may compute forming revisions, but they are durably skipped and only the authoritative final can reach Paper. `mirrorOn: "every-update"` is rejected during pure validation/preparation before provider or broker construction. |
| Exact historical data | Standard or finite Bar Magnifier warmup is supported for the characterized non-COOF path. Exact static-security proofs and independent feed/per-feed/total budgets are supported only with close-only cadence; every-update rejects all security dependencies before data I/O.                  |
| Upstream piner limits | Piner 0.11.1 exposes no typed public pending-order snapshot or per-fill stream, and reports complete Bar Magnifier data inactive with `calc_on_order_fills=true`. Forming-revision Paper effects and active magnifier+COOF therefore remain unavailable.                                        |
| Tiger                 | `liveBars()` is unadvertised and V2 Tiger execution is rejected before execution credentials or broker construction. Credentialed data/finality and demo/live execution gates were not run and are not authorized.                                                                              |

These are repository-owned offline regression capabilities, not TradingView,
broker, exchange, venue, credentialed Tiger, release, or production evidence.

## Canonical v1 compatibility run config

```json
{
  "configVersion": 1,
  "strategy": "strategy.pine",
  "symbol": "MGC",
  "timeframe": "5m",
  "warmupBars": 500,
  "data": {
    "provider": "csv",
    "dataDir": "data",
    "cutoverTime": 1704067200,
    "mintick": 0.1,
    "qtyStep": 1,
    "minOrderQty": 1,
    "pointValue": 10
  },
  "broker": { "id": "paper" },
  "armed": false,
  "ledger": ".pinelive/ledger.jsonl"
}
```

```bash
bun packages/pinelive/src/cli.ts validate --config pinelive.local.json
bun packages/pinelive/src/cli.ts run --config pinelive.local.json
```

This example is the preserved v1 compatibility path. The strict v2
compute-only/Paper configuration, pure validation boundary, schema-v3 recovery,
and fail-closed Tiger execution gate are documented in the
[package README](../packages/pinelive/README.md#v2-intrabar-runtime). `validate`
reads and compiles the configured strategy but constructs no provider, broker,
ledger, lease, credential profile, or network client.

The `data` object is validated and constructed by `@heyphat/pinery/node`. CSV
replay requires an explicit cutover: warmup returns the most recent bars before
it, while the stream emits closed bars after it. Direct `--data` parsing and the
old pinelive `CsvReplayFeed` are removed.

## Lifecycle and exact identity

For v1, startup compiles the strategy, strictly resolves a pinery instrument, connects the broker, verifies exact contract/tick/quantity/minimum/point-value metadata, freezes a `RunInstrumentBinding`, then loads warmup history. Piner receives the strategy symbol; pinery receives the opaque resolved object; broker marks, positions, orders and final reads receive the exact execution symbol.

Warmup places no order by default. Every later pinery yield causes exactly one `engine.tick(..., true)`, target read, reconcile, and cycle record. Optional `reconcileOnStart` writes a distinct startup event. Cancellation is checked before reconciliation/order paths. Shutdown cancels first, attempts provider disconnect, then waits for every real secondary-feed provider operation to settle. A provider that ignores both abort and disconnect produces a bounded cleanup failure instead of a false successful shutdown. Ledger flush/close and broker disconnect are still attempted after cleanup failures, and shutdown never auto-flattens.

Schema-v2 ledgers on the v1 path begin with a binding record containing provider and broker ids, provider handle, strategy/execution symbols, exchange/expiry metadata and a stable fingerprint. Every cycle references the binding, preserves both symbols, and includes the complete requested order (`type` and `limitPrice` when applicable) for execution audit. Schema-v1 cycle JSON remains readable by existing JSONL/parity consumers.

V2 instead freezes a prepared finite-history authority before runtime ownership,
recovers a schema-v3 JSONL prefix, checks recovered authority before lease or
broker creation, and records lease acquisition before its lazy Paper broker
factory. Its strong binding is compared before mark, position, or order effects.
Shutdown never flattens; compute-only results omit account fields, and an unsafe
mirrored result is not printed as success.

## Market and limit order policy

Market remains the default when `order` is omitted. Limit execution is explicit:

```json
{
  "order": {
    "type": "limit",
    "limitOffsetTicks": 0
  },
  "broker": {
    "id": "tiger",
    "cancelStuckOrders": true,
    "orderPollIntervalMs": 250,
    "maxOrderPolls": 20
  },
  "armed": true
}
```

Pinelive mirrors piner's target position, not the original `strategy.entry()` order object, so this is a host execution policy. The current closed bar's close is the reference price. Buy limits subtract `limitOffsetTicks * mintick`; sell limits add it. The result is rounded to the bound broker instrument's tick grid without becoming more aggressive. The offset defaults to zero and must be a non-negative integer. Every deterministic client id frames each component with its length, so arbitrary deployment/strategy symbols and embedded delimiters cannot collide. A limit's type and snapped price are also identity components. This intentionally changes market-order IDs from the earlier sanitized format; roll out only when no old-format order is working or has an ambiguous outcome.

`PaperBroker` does not simulate an order book. It fills an immediately marketable limit at the marked price plus configured slippage, capped so execution never violates the limit; a non-marketable limit is rejected rather than left as a fictional resting order. Tiger's official transport sends native futures `LMT` orders. Because `Broker.submit()` returns only terminal fills, Tiger limit mode requires `cancelStuckOrders: true` and transport cancellation support. If the order remains working after `maxOrderPolls`, Tiger requests cancellation and polls until the venue reports a terminal fill/cancel state. Until that happens, a different correction is refused. `flatten()` always uses a market order.

## `request.security` (secondary feeds)

piner never fetches: it declares dependencies and reads host-supplied bars from `ctx.securityBars`. pinelive plans those dependencies, deduplicates call sites into provider feed states, and resolves every state through the **same** pinery provider as the chart.

Planning is static-first and uses the same rules as pinerun:

| Dependency                                                | Fetched at                                  | `securityBars` key |
| --------------------------------------------------------- | ------------------------------------------- | ------------------ |
| `request.security("OTHER", "D", …)`                       | chart TF, then piner resamples upward       | `OTHER`            |
| `request.security("OTHER", "5", …)` on a 1h chart         | `5m` (the finest required bare-symbol base) | `OTHER`            |
| `request.security(syminfo.tickerid, "D", …)`              | `1d`                                        | `<symbol>@D`       |
| `request.security(syminfo.tickerid, timeframe.period, …)` | not fetched                                 | —                  |
| `request.security_lower_tf(…, "5", …)`                    | `5m`                                        | `<symbol>@5`       |

A self-reference reuses the chart's exact resolved instrument, so a futures run cannot bind two contract months. Runtime-computed arguments get one sentinel discovery replay during startup. Inputs fixed for the life of the run work normally. If a symbol, timeframe, or conditional call site first changes later, the runner detects the newly declared requirement after evaluation and stops **before broker reconciliation**; it never lets an un-warmed request silently trade as `na`/`[]`.

Secondary history is fetched before piner's warmup replay. The requested depth must fit under `maxSecurityBars`, and startup fails if the provider returns fewer required bars. During live operation every closed chart bar triggers a bounded catch-up request with an explicit overlap, `from`, and `to`. Existing timestamps are revision-aware, every missed returned bar is appended, and a truncated response that omits the prior tail fails closed. Bars are independently filtered by close time before injection, including calendar-aware month boundaries. piner then performs its own close-time alignment and invalidates its security caches on each chart tick.

Failure policy is safety-first:

- Resolution, timeout, insufficient warmup, malformed data, and history errors abort startup.
- A refresh failure emits `onSecurityError` and a durable `recordType: "security"` ledger event. By default (`maxSecurityStaleRefreshes: 0`) the first failure stops the run before reconciliation.
- A nonzero stale allowance permits that many failed refreshes. Cycle records include a `securityFeeds` health snapshot. A successful response with no new bar is valid when the dependency market is closed, but it does not clear an earlier failure; only actual append/revision progress restores healthy state.
- Historical feed bars are never silently truncated because that would reset stateful security expressions. Reaching `maxSecurityBars` stops the run and tells the operator to raise the limit.

Config keys:

| Key                         | Default                | Meaning                                                                               |
| --------------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `resolveSecurity`           | `true`                 | `false` refuses any strategy that declares security dependencies.                     |
| `securityWarmupBars`        | received chart history | Required startup bars per dependency feed.                                            |
| `maxSecurityBars`           | `5000`                 | Hard per-feed history ceiling; reaching it stops rather than truncates.               |
| `maxSecurityFeeds`          | `32`                   | Maximum deduplicated feed states opened by one strategy.                              |
| `securityConcurrency`       | `4`                    | Maximum simultaneous secondary-provider requests.                                     |
| `securityRequestTimeoutMs`  | `30000`                | Timeout for each resolve/history request and the overall provider-shutdown deadline.  |
| `maxSecurityStaleRefreshes` | `0`                    | Failed refreshes tolerated before stopping; zero is fail-closed on the first failure. |

A coarse chart plus `request.security_lower_tf` can need substantial warmup—for example, 200 one-hour bars require roughly 12,000 one-minute bars. With the 5,000 default, startup now refuses the incomplete run. Raise `maxSecurityBars`, reduce warmup, or use a coarser intrabar timeframe.

Cross-symbol addressing follows [common options](./common-options.md#symbol-addressing): a bare ticker resolves against `data.provider`; qualify it in a mixed setup.

## Paper and Tiger

Paper is the default and supports market orders plus immediately marketable limits at the current closed bar's mark. It models signed net quantity, weighted basis, PnL, point value, commission and client-id idempotency; it never pretends a non-marketable limit is resting. Paper has no margin or buying-power model: the account's `available` equals its equity, so margin-sensitive behavior cannot be validated in paper mode. Limit execution assumes tick-aligned reference closes; because the derived limit is snapped passively (a buy never rounds up, a sell never rounds down), data whose closes are off the mintick grid makes every zero-offset limit non-marketable, and Paper rejects each one with the limit and mark prices in the message.

Pinery ships a transport-injected `TigerProvider`; pinelive ships an execution-only, transport-injected `TigerBroker`. Their Node factories now default to the official [`@tigeropenapi/tigeropen`](https://github.com/tigerfintech/openapi-typescript-sdk) TypeScript SDK adapters, pinned at `0.5.4`; registration functions still override those defaults for fixtures and custom transports. The official execution transport supports native `MKT` and `LMT` futures orders; a custom transport advertises limits only by implementing `submitLimit`. Offline facade tests cover futures resolution, timeframe/end-time conversion, paged conservative finality, account/position/contract mapping, `userMark` restart lookup, official order states, eventual fill polling, cancellation checkpoints, redaction, and ambiguous-order no-retransmit behavior.

This implementation is **not** a production-readiness claim. Validation in this branch is offline only: injected SDK facades cover futures resolution, timeframe/end-time conversion, conservative pagination/finality, account/position/contract mapping, exact `userMark` matching, official order states, polling, cancellation races, redaction, and ambiguous same-process submission handling. No credentialed Tiger quote/history, entitlement, demo order, cancellation, or fill was validated by this audit. Supported adapter timeframes are `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`; `1d`/`1w`/`1M` are refused because the venue stamps them with a session-close boundary rather than a bar open. The SDK HTTP methods do not accept `AbortSignal`, so adapters check cancellation immediately before and after each call but cannot interrupt an in-flight request. The newest returned bar is treated as still forming and withheld, costing up to one bar of latency. `userMark` is searchable metadata, not a server-enforced idempotency key: the broker never retransmits an ambiguous client id within the same process, but a crash loses that pending marker and the SDK exposes only a bounded latest-order query. Armed restart remains unsafe until durable transmission state and stale-contract/exposure preflight are implemented. See the [`feat/pinelive` audit](./feat-pinelive-audit.md) for the full evidence and integration status.

For a future Tiger data dry run, use Tiger data with a Paper broker. V2 Tiger
broker execution is explicitly rejected during pure preparation before any
Tiger execution credential or profile is read. Real v1 Tiger execution additionally requires `armed: true`; both the registry and TigerBroker reject unarmed execution. Automatic contract rolling is not implemented: a binding is fixed for one run, and operators must stop, inspect exposure, and perform a reviewed manual migration before changing contracts.

## Parity

Create expected JSONL rows shaped as `{ "barTime": 1700000000, "target": 1 }`, then run:

```bash
pinelive parity .pinelive/ledger.jsonl expected-targets.jsonl
```

Parity compares one run/strategy/binding/timeframe scope and reports missing/duplicate cycles, target mismatch, rejects and execution drift. It does not claim fill-price parity.

## Credentials

Keep provider and broker secrets in environment variables or local mode-0600 profiles. The simplest setup is a single credential file and nothing else: put `tiger_openapi_config.properties` in `~/.tigeropen/` (the SDK's default search path, along with the working directory) and no configuration is needed at all. On v1, to keep it elsewhere, set one top-level `tigerProfile` path — or pass `--tiger-profile <path>` / `TIGEROPEN_CONFIG_PATH` — and it applies to both the Tiger `data` and `broker` sections; a per-section `profile` still wins. V2 accepts a profile only in its strict data section and does not expose Tiger broker execution. `~` is expanded, a directory resolves to `tiger_openapi_config.properties` inside it, and a path that does not exist fails immediately with an `auth` error instead of a confusing missing-credential message. The file's `private_key_pk8` value must be one line of bare base64 with the PEM header/footer and newlines stripped; a multi-line PEM is not accepted.

For environment variables instead, the preferred names are `TIGEROPEN_TIGER_ID`, `TIGEROPEN_PRIVATE_KEY`, `TIGEROPEN_ACCOUNT`, `TIGEROPEN_TOKEN`, optional `TIGEROPEN_LICENSE`, and optional institutional `TIGEROPEN_SECRET_KEY`; legacy `TIGER_ID`, `TIGER_PRIVATE_KEY`, and `TIGER_ACCOUNT` remain fallbacks. Custom transport factories receive only provider- or broker-specific credential objects. The official SDK also applies its documented environment-over-code precedence; when explicit values are supplied, the adapters compare the resolved identity/account/credentials and fail closed on an override mismatch. Errors and ledgers must never include credentials or account identifiers. Entitlement, market-access, demo arming, and live operations instructions remain intentionally undocumented until credentialed validation is completed.
