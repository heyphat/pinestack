# Pinery market-data and pinelive Broker adapter contracts

Market data adapters belong to `@heyphat/pinery`; execution adapters belong to `@heyphat/pinelive`. A broker must not expose history or live-bar methods, and pinelive must not implement venue data recovery.

## MarketDataProvider

A live provider preserves `HistoryProvider` compatibility and adds strict `resolve`, resolved-only `historyResolved`, `closedBars({ after, signal })`, and optional `disconnect`. `ResolvedDataInstrument` includes strategy symbol, opaque provider handle, exact venue symbol, tick size, quantity step, minimum order quantity, and available point-value/exchange/expiry metadata.

Providers emit valid unix-second bars that are closed, ascending and unique. `after` is exclusive. Polling adapters intentionally overlap the previous timestamp, suppress duplicates, backfill every returned missed bar, and own retry/reconnect policy. Failures are redacted `MarketDataError` values classified as connectivity, auth, rate-limit, invalid-symbol, entitlement, or malformed-data. Cancellation must stop waits and in-flight transport calls where supported.

Node-only filesystem/profile/SDK construction belongs behind `@heyphat/pinery/node`. Wrappers must preserve the complete live surface and lifecycle or reject live wrapping. A historical-only provider must fail clearly when selected for a live run.

Tiger market data uses `TigerMarketDataTransport`. The provider freezes one exact futures contract and requires authoritative venue finality or server time. Historical and live requests drain opaque older-page cursors; history keeps paging when an unclosed tail would otherwise underfill `limit`, and live polling finishes the complete gap before yielding buffered bars. Cancellation is checked before requests and between those yields. The public repository currently provides the interface, provider logic, registry seam, and fixture tests—not a claimed production SDK wrapper.

## Broker

- `id` is stable; lifecycle methods are repeat-safe when supplied.
- `instrument(executionSymbol)` verifies one exact venue contract. It does not choose a front month. It returns positive quantity/tick/minimum metadata and optional point value/exchange/expiry.
- `getPosition(executionSymbol)` returns signed net strategy-native exposure. Long is positive, short negative, flat zero.
- `submit` accepts unsigned quantity plus side, submits at most one market correction, returns a terminal native-unit fill, and deduplicates deterministic `clientId` values. A timeout after transmission must query the same id before any new order. A working partial fill is polled under that id and is never cached as terminal; a transport must explicitly report that the unfilled remainder was cancelled before returning a terminal partial fill.
- `flatten(executionSymbol)` reaches zero using the same exact contract and idempotency rules. Tiger flatten operation ids are collision-resistant across process restarts; durable stale-contract exposure preflight remains a separate unresolved requirement.
- Expected failures are classified `BrokerError` values. Credentials and account ids are redacted.
- `capabilities()` truthfully describes position model, transport, fractional units and flatten support.

## Binding and safety

Pinelive compares provider and broker symbols, tick size, quantity step, minimum order and point value before warmup reconciliation or any order. The immutable `RunInstrumentBinding` and client ids preserve strategy and execution identities.

Real adapters receive `armed`. Both `submit` and `flatten` independently fail with a non-retryable precondition while unarmed, even if a caller bypasses CLI/registry checks. Shutdown never flattens. Futures contract changes require a stopped run and reviewed exposure migration; automatic rolling is deferred.

## Conformance

Use `runBrokerConformance()` from `@heyphat/pinelive/testing` with a controllable transport. It covers noop/open/add/reduce/close/flip, rejection, idempotency and restart/capped progression. Adapter tests must additionally cover auth/connectivity/unknown outcomes, cancellation, exact-symbol metadata mismatch, unarmed submit/flatten and redaction.

TigerBroker passes this harness through its injected transport. Production Tiger market-data/trading wrappers and credentialed demo validation remain unresolved and must not be represented as sandbox-approved.
