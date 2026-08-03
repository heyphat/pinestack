# pinelive forward testing

`@heyphat/pinelive` orchestrates three strict boundaries: pinery resolves and
yields market data, piner owns strategy calculations and target position, and a
pinelive `Broker` owns execution. Pinelive never parses CSV or calls
provider-specific quote APIs; its temporary every-update transport uses only
provider-neutral history/closed-bar contracts.

> **Availability:** releases ship a standalone `pinelive` binary, but the
> installer fetches it only with an explicit opt-in
> (`PINESTACK_BINS="pinerun pinetop pinelive"`); it is not published to npm.
> Paper supports mirrored forward testing. Tiger supports broker-connected
> monitoring and fail-closed production-safety gates, but the built-in official
> Tiger transport is intentionally blocked and ineligible for armed production
> execution because it cannot prove complete open-order inventory,
> authoritative exact absence, or snapshot/account-stream gap closure. From a
> source checkout (Bun 1.2.5):
>
> ```bash
> bun install --frozen-lockfile
> bun packages/pinelive/src/cli.ts --help
> ```
>
> The shorthand `pinelive` used below is either the installed binary or
> `alias pinelive='bun packages/pinelive/src/cli.ts'` from a checkout.

For a checked-in, runnable Paper/CSV configuration, start with the
[package README quick start](../packages/pinelive/README.md#paper-quick-start).
Tiger has offline SDK-facade coverage plus an opt-in credentialed read-only
connectivity and ambiguity-restart test. The official adapter remains blocked
for armed production execution; see the
[production-safety runbook](./pinelive-production-safety.md).

## Current runtime capability matrix

| Surface               | Supported behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compute-only          | `bar-close`, or `every-update` when compiled `calc_on_every_tick` metadata is present. Native `every-update` currently admits authoritative chart finals; `lower-bars` polls closed child history and emits forming chart revisions plus a separately verified final. Lower-bars polling requires provider-attested UTC-24×7 history alignment and `throttleMs >= 250`. Neither path invokes provider `liveBars()`. Compute-only runs cannot own a broker factory or submit broker effects; the CLI still maintains durable compute state under a temporary file lock. |
| Paper mirrored        | `execution.mirrorOn: "bar-close"` only. Lower-bars forming revisions may be evaluated and journaled, but only authoritative finals can produce broker effects. `mirrorOn: "every-update"` is rejected during pure validation/preparation before provider or broker construction.                                                                                                                                                                                                                                                                                       |
| Tiger monitor         | Broker-connected `monitor` posture resolves the exact instrument and journals decisions, but takes no account execution claim, creates no execution scheduler, and performs no mutation. It makes no execution-readiness claim.                                                                                                                                                                                                                                                                                                                                        |
| Tiger armed           | Startup takes cooperative ownership and requires complete venue bootstrap, authoritative exact order lookup, and gap-free account synchronization. Missing proof produces structured `blocked` data, never a weaker success. The built-in official transport cannot prove complete open-order inventory, authoritative exact absence, or snapshot/account-stream gap closure, so it is intentionally blocked and production-ineligible.                                                                                                                                |
| Exact historical data | Standard or finite Bar Magnifier warmup is supported for the characterized non-COOF path. Exact static-security proofs and independent feed, per-feed, and total budgets are supported only with close-only cadence; every-update rejects all security dependencies before data I/O.                                                                                                                                                                                                                                                                                   |
| Upstream piner limits | Piner 0.11.1 exposes no typed public pending-order snapshot or per-fill stream, and reports complete Bar Magnifier data inactive with `calc_on_order_fills=true`. Forming-revision Paper effects and active magnifier+COOF therefore remain unavailable.                                                                                                                                                                                                                                                                                                               |

These are repository-owned offline regression capabilities, not TradingView,
broker, exchange, venue, credentialed Tiger, release, or production evidence.

Pine `alert()` delivery to webhook channels is documented separately in
[pinelive alerts](./pinelive-alerts.md). The `alerts` section dispatches only on
fresh authoritative bar closes.

## Operational limits

An armed Tiger run takes a cooperative same-host account/exact-instrument claim
in addition to the non-stealable ledger lease. Existing claim, lease, and
recovery artifacts are never stolen automatically, and ordinary startup is
serialized against explicit recovery by `<lease>.admin.lock`. This prevents two
cooperative processes on the same host from intentionally owning the same
account and exact instrument, but it is not venue fencing or distributed
coordination: another host, application, manual broker session, or local user
with equivalent filesystem permissions remains outside the boundary.

Restart limits, stated plainly:

- **Paper account state is process-local and does not survive a restart.**
  Recovery restores durable decision, order, and scheduler state exactly, but
  the `PaperBroker` account itself (position, basis, and realized PnL) starts
  fresh in every process. A recovered ledger whose last position was nonzero
  surfaces a position mismatch rather than silently resuming.
- **Broker-effect uncertainty is durable.** A possibly sent order is never
  retransmitted, the breaker remains latched, and inconclusive exact lookup
  cannot clear it. A terminal exact result can clear it only after durable
  completion and synchronized position validation; an interruption before
  reset resumes only from that narrowly proven prefix.
- **Monitor and blocked are evidence postures, not degraded execution modes.**
  Monitor performs no mutations. A blocked armed startup does not silently
  switch to execution, claim success, or weaken a required proof.
- **The official Tiger transport remains intentionally blocked.** Credentials
  do not remedy its inability to prove complete open-order inventory,
  authoritative exact absence, or snapshot/account-stream gap closure.

Use `pinelive status --ledger <path> --json` for read-only evidence; status does
not acquire runtime ownership or mutate broker state. Stale local ownership
recovery is an explicit, confirmation-gated procedure that requires
conservative process-owner proof, refuses unresolved broker effects, and
quarantines rather than deletes existing artifacts. Uncertain ownership-record
acknowledgement retains the physical lease/claim layers; exact recovery binds an
otherwise unrecorded claim to the same execution owner, PID, and boot identity,
and stale administrative evidence is restored without clobbering a concurrent
owner. Full file layout, recovery
commands, claim semantics, and the incident checklist are in the
[production-safety runbook](./pinelive-production-safety.md).

## Current run configuration

Pinelive accepts one strict configuration shape with `"configVersion": 3`.
Use `pinelive.json` as the run file:

```json
{
  "configVersion": 3,
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
  "historical": {
    "mode": "standard"
  },
  "live": {
    "cadence": "bar-close"
  },
  "security": {
    "enabled": false
  },
  "execution": {
    "kind": "mirrored",
    "mirrorOn": "bar-close",
    "broker": {
      "id": "paper"
    },
    "order": {
      "type": "market"
    },
    "reconcileOnStart": false,
    "ledger": {
      "path": ".pinelive/ledger.jsonl",
      "durability": "sync"
    },
    "lease": {
      "path": ".pinelive/ledger.lock"
    }
  }
}
```

```bash
bun packages/pinelive/src/cli.ts validate --config pinelive.json
bun packages/pinelive/src/cli.ts run --config pinelive.json
```

`validate` reads and compiles the configured strategy but constructs no
provider, broker, ledger, lease, credential profile, or network client. Unknown
keys and invalid historical/live/security/execution combinations are rejected.

The `data` object is validated and constructed by `@heyphat/pinery/node`. CSV
replay requires an explicit cutover: warmup returns the most recent bars before
it, while the stream emits closed bars after it. Pinelive does not own a second
CSV parsing path.

## Lifecycle and exact identity

Startup compiles the strategy, prepares a finite historical authority, and
recovers the valid schema version 3 JSONL prefix. It checks recovered authority
before lease or broker creation, then records lease acquisition before invoking
a lazy mirrored broker factory. The non-stealable lease and, for armed Tiger,
the same-host account/exact-instrument claim must both be held before any
execution effect.

The runner strictly resolves a pinery instrument, verifies exact
contract/tick/quantity/minimum/point-value metadata, and freezes a strong
`RunInstrumentBinding`. Piner receives the strategy symbol; pinery receives the
opaque resolved object; broker marks, positions, orders, exact lookup, and final
reads receive the exact execution symbol. The recovered binding is compared
before mark, position, or order effects.

Warmup places no order. Bar-close and native every-update currently consume
authoritative chart finals. A lower-bars every-update source instead requires
provider-attested UTC-24×7 history alignment, polls closed child history at
`live.throttleMs` (minimum 250 ms), and requests the oldest unprocessed child
slots in forward-bounded pages capped at the smaller of 1,000 and the
provider's advertised per-acquisition limit. It validates an exact contiguous
child grid, emits one forming chart revision per newly closed child, and commits only a separately polled chart final that exactly matches the child
aggregation. Providers with unknown or exchange-session alignment are rejected
before subscription rather than treating a legitimate session closure as a
missing bar. Pinelive does not invoke provider `liveBars()` in either path. An
optional nested `execution.reconcileOnStart: true` writes a distinct startup
correction event; it is available only for bar-close mirrored execution.
Cancellation is checked before reconciliation and order paths. Shutdown cancels
first, attempts provider disconnect, then waits for every real secondary-feed
provider operation to settle. A provider that ignores both abort and disconnect
produces a bounded cleanup failure instead of a false successful shutdown.
Ledger flush/close and broker disconnect are still attempted after cleanup
failures, and shutdown never auto-flattens.

The ledger uses one format: every durable event carries `schemaVersion: 3` and
a monotonic sequence. Binding, decision, scheduler, order, uncertainty,
security, and alert evidence share that sequenced event stream. Compute-only
results omit account fields, and an unsafe mirrored result is not printed as
success.

## Market and limit order policy

Market remains the default when `execution.order` is omitted. Limit execution
is an explicit nested execution policy:

```json
{
  "execution": {
    "kind": "mirrored",
    "mirrorOn": "bar-close",
    "broker": {
      "id": "paper"
    },
    "order": {
      "type": "limit",
      "limitOffsetTicks": 0
    },
    "reconcileOnStart": false,
    "ledger": {
      "path": ".pinelive/ledger.jsonl",
      "durability": "sync"
    },
    "lease": {
      "path": ".pinelive/ledger.lock"
    }
  }
}
```

Pinelive mirrors piner's target position, not the original `strategy.entry()`
order object, so this is a host execution policy. The current closed bar's close
is the reference price. Buy limits subtract `limitOffsetTicks * mintick`; sell
limits add it. The result is rounded to the bound broker instrument's tick grid
without becoming more aggressive. The offset defaults to zero and must be a
non-negative integer. Every deterministic client id frames each component with
its length, so arbitrary deployment/strategy symbols and embedded delimiters
cannot collide. A limit's type and snapped price are also identity components.

`PaperBroker` does not simulate an order book. It fills an immediately
marketable limit at the marked price plus configured slippage, capped so
execution never violates the limit; a non-marketable limit is rejected rather
than left as a fictional resting order. Tiger's official transport sends native
futures `LMT` orders. Because `Broker.submit()` returns only terminal fills,
Tiger limit mode requires `execution.broker.cancelStuckOrders: true` and
transport cancellation support. If the order remains working after
`maxOrderPolls`, Tiger requests cancellation and polls until the venue reports a
terminal fill/cancel state. Until that happens, a different correction is
refused. `flatten()` always uses a market order. These mechanics do not make the
official Tiger adapter eligible for armed production execution.

## `request.security` (secondary feeds)

piner never fetches: it declares dependencies and reads host-supplied bars from
`ctx.securityBars`. Pinelive plans those dependencies, deduplicates call sites
into provider feed states, and resolves every state through the **same** pinery
provider as the chart.

Exact security is available only when `live.cadence` is `bar-close`,
`historical.mode` is `bar-magnifier`, and every dependency is statically and
completely classified. Every-update requires `security.enabled: false` and
rejects `request.security` and `request.security_lower_tf` dependencies before
data I/O.

| Dependency                                                | Fetched at                                  | `securityBars` key |
| --------------------------------------------------------- | ------------------------------------------- | ------------------ |
| `request.security("OTHER", "D", …)`                       | chart TF, then piner resamples upward       | `OTHER`            |
| `request.security("OTHER", "5", …)` on a 1h chart         | `5m` (the finest required bare-symbol base) | `OTHER`            |
| `request.security(syminfo.tickerid, "D", …)`              | `1d`                                        | `<symbol>@D`       |
| `request.security(syminfo.tickerid, timeframe.period, …)` | not fetched                                 | —                  |
| `request.security_lower_tf(…, "5", …)`                    | `5m`                                        | `<symbol>@5`       |

A self-reference reuses the chart's exact resolved instrument, so a futures run
cannot bind two contract months. Secondary history is fetched before piner's
warmup replay. Required history must fit both the per-feed and aggregate exact
budgets, and startup fails if the provider returns fewer required bars. During
live operation each closed chart bar triggers a bounded catch-up request with
explicit overlap, `from`, and `to`. Existing timestamps are revision-aware,
every missed returned bar is appended, and a truncated response that omits the
prior tail fails closed. Bars are independently filtered by close time before
injection, including calendar-aware month boundaries. piner performs its own
close-time alignment and invalidates its security caches on each chart tick.

Failure policy is safety-first:

- Resolution, timeout, insufficient warmup, malformed data, budget exhaustion,
  and history errors abort startup or stop before reconciliation.
- A refresh failure emits `onSecurityError` and, for a mirrored run, a durable
  `recordType: "security"` event. By default (`security.maxStaleRefreshes: 0`)
  the first failure stops the run before reconciliation.
- A nonzero stale allowance permits that many failed refreshes. Decision events
  include a security-feed health snapshot. A successful response with no new
  bar is valid when the dependency market is closed, but it does not clear an
  earlier failure; only actual append or revision progress restores healthy
  state.
- Historical feed bars are never silently truncated because that would reset
  stateful security expressions. Exhausting an exact budget stops the run and
  requires an operator-reviewed configuration change.

Strict `security.*` keys:

| Key                                    | Default               | Meaning                                                                             |
| -------------------------------------- | --------------------- | ----------------------------------------------------------------------------------- |
| `security.enabled`                     | `false`               | `false` rejects a strategy that declares security dependencies.                     |
| `security.maxExactSecurityFeeds`       | required when enabled | Maximum deduplicated exact feed states for one strategy.                            |
| `security.maxExactSecurityBarsPerFeed` | required when enabled | Hard exact-history ceiling for each dependency feed.                                |
| `security.maxExactSecurityTotalBars`   | required when enabled | Hard aggregate exact-history ceiling across all dependency feeds.                   |
| `security.concurrency`                 | `4`                   | Maximum simultaneous secondary-provider requests; cannot exceed feed count.         |
| `security.requestTimeoutMs`            | `30000`               | Timeout for each resolve/history request and the provider-shutdown deadline.        |
| `security.maxStaleRefreshes`           | `0`                   | Failed refreshes tolerated before stopping; zero fails closed on the first failure. |

For example, 200 one-hour bars can require roughly 12,000 one-minute bars for a
lower-timeframe dependency. Set both exact per-feed and total budgets high
enough for the declared history, or use a coarser intrabar timeframe.

Cross-symbol addressing follows
[common options](./common-options.md#symbol-addressing): a bare ticker resolves
against `data.provider`; qualify it in a mixed setup.

## Paper and Tiger

Paper supports market orders plus immediately marketable limits at the current
authoritative closed bar's mark. It models signed net quantity, weighted basis,
PnL, point value, commission, and client-id idempotency; it never pretends a
non-marketable limit is resting. Paper has no margin or buying-power model: the
account's `available` equals its equity, so margin-sensitive behavior cannot be
validated in paper mode. Limit execution assumes tick-aligned reference closes;
because the derived limit is snapped passively (a buy never rounds up, a sell
never rounds down), data whose closes are off the mintick grid makes every
zero-offset limit non-marketable, and Paper rejects each one with the limit and
mark prices in the message.

Pinery ships a transport-injected `TigerProvider`; pinelive ships an
execution-only, transport-injected `TigerBroker`. Their Node factories default
to the official
[`@tigeropenapi/tigeropen`](https://github.com/tigerfintech/openapi-typescript-sdk)
TypeScript SDK adapters, pinned at `0.5.4`; registration functions can supply
custom transports. The official execution transport maps native `MKT` and
`LMT` futures orders, but its bounded recent-order query is not authoritative
exact lookup and it exposes no complete snapshot-to-account-stream
synchronization boundary.

A Tiger run with `execution.armed: false` therefore remains in broker-connected
`monitor` posture: it resolves the exact instrument and journals decisions, but
acquires no account execution claim, creates no execution scheduler, and
performs no mutation. Armed startup requires canonical account identity,
same-host account/exact-instrument exclusion, complete synchronized
account/order/position bootstrap, gap-free stream continuity, complete
open-order inventory, authoritative exact presence or absence, no unexplained
position or open order, no unresolved durable effect, and an unlatched breaker.
Missing any proof returns `executionEligibility: "blocked"`; it does not
silently weaken the proof or report execution success.

The built-in official adapter is intentionally and unconditionally ineligible
for armed production execution because its SDK cannot prove complete open-order
inventory, authoritative exact absence, or snapshot/account-stream gap closure.
A custom adapter is not trusted merely because it is custom: it must provide
those proofs through the broker contract, preserve account-stream continuity,
honor abort/cancellation behavior, keep exact instrument identity, and pass the
published adapter/conformance and restart-ambiguity evidence. Eligibility
follows demonstrated proofs, not adapter name, credentials, or successful
connectivity.

This is **not** a production-readiness claim. Offline injected-facade tests
cover mapping, polling, cancellation races, redaction, guard enforcement,
restart no-retransmit behavior, claim contention, status, explicit recovery,
and custom-adapter proof failures. The opt-in credentialed test performs
read-only account/instrument/position checks, seeds ambiguity only against an
offline transport, and proves an official-adapter restart remains blocked
without a new attempt or mutation; ordinary CI needs no secrets. No
credentialed demo/live placement, cancellation, fill, or real after-send
recovery is authorized. Supported data-adapter timeframes remain `1m`, `3m`,
`5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`; `1d`/`1w`/`1M` are refused because
the venue timestamps them at a session-close boundary. SDK HTTP calls still
have no request-level `AbortSignal`.

For Tiger data testing, prefer Tiger data with a Paper broker. For
execution-side credential/connectivity inspection, use Tiger with
`execution.armed: false` and treat the result as monitor evidence only.
Automatic contract rolling is not implemented: stop, inspect orders and
exposure, and complete a reviewed contract change before resuming. See the
[production-safety runbook](./pinelive-production-safety.md) for status,
recovery, claim paths, and the credentialed read-only test.

## Parity

Create expected JSONL rows shaped as
`{ "barTime": 1700000000, "target": 1 }`, then run:

```bash
pinelive parity .pinelive/ledger.jsonl expected-targets.jsonl
```

Parity compares one run/strategy/binding/timeframe scope in the schema version
3 ledger and reports missing or duplicate decisions, target mismatch, rejects,
and execution drift. It does not claim fill-price parity.

## Credentials

Keep provider and broker secrets in environment variables or local mode-0600
profiles. In the strict config, a Tiger data profile belongs only at
`data.profile`, and a Tiger execution profile belongs only at
`execution.broker.profile`. `~` is expanded, a directory resolves to
`tiger_openapi_config.properties` inside it, and a path that does not exist
fails immediately with an `auth` error. The file's `private_key_pk8` value must
be one line of bare base64 with the PEM header/footer and newlines stripped; a
multi-line PEM is not accepted.

For environment variables, use `TIGEROPEN_TIGER_ID`,
`TIGEROPEN_PRIVATE_KEY`, `TIGEROPEN_ACCOUNT`, `TIGEROPEN_TOKEN`, optional
`TIGEROPEN_LICENSE`, and optional institutional `TIGEROPEN_SECRET_KEY`. Custom
transport factories receive only provider- or broker-specific credential
objects. The official SDK also applies its documented environment-over-code
precedence; when explicit values are supplied, the adapters compare the
resolved identity/account/credentials and fail closed on an override mismatch.
Errors and ledgers must never include credentials or clear-text account
identifiers. Credentialed read-only testing is opt-in as documented in the
production-safety runbook; demo/live order mutation remains unauthorized while
the official adapter is synchronization-ineligible.
