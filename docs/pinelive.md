# pinelive forward testing

`@heyphat/pinelive` orchestrates three strict boundaries: pinery resolves and yields market data, piner owns strategy calculations and target position, and a pinelive Broker owns execution. Pinelive never parses CSV, polls quote APIs, decides bar closure, deduplicates bars, or recovers data gaps.

## Canonical run config

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
pinelive run --config pinelive.local.json
```

The `data` object is validated and constructed by `@heyphat/pinery/node`. CSV replay requires an explicit cutover: warmup returns the most recent bars before it, while the stream emits closed bars after it. Direct `--data` parsing and the old pinelive `CsvReplayFeed` are removed.

## Lifecycle and exact identity

Startup compiles the strategy, strictly resolves a pinery instrument, connects the broker, verifies exact contract/tick/quantity/minimum/point-value metadata, freezes a `RunInstrumentBinding`, then loads warmup history. Piner receives the strategy symbol; pinery receives the opaque resolved object; broker marks, positions, orders and final reads receive the exact execution symbol.

Warmup places no order by default. Every later pinery yield causes exactly one `engine.tick(..., true)`, target read, reconcile, and cycle record. Optional `reconcileOnStart` writes a distinct startup event. Cancellation is checked before reconciliation/order paths. Shutdown cancels first, attempts provider disconnect, ledger flush/close and broker disconnect even after cleanup failures, and never auto-flattens.

Schema-v2 ledgers begin with a binding record containing provider and broker ids, provider handle, strategy/execution symbols, exchange/expiry metadata and a stable fingerprint. Every cycle references the binding and preserves both symbols. Schema-v1 cycle JSON remains readable by existing JSONL/parity consumers.

## Paper and Tiger

Paper is the default and fills at the current closed bar's close plus configured slippage. It models signed net quantity, weighted basis, PnL, point value, commission and client-id idempotency.

Pinery ships a transport-injected `TigerProvider`; pinelive ships an execution-only, transport-injected `TigerBroker`. Fixture tests cover resolution, paged history/finality, complete paged live-gap recovery, overlap/dedup/retry/cancellation, exact-contract reads, arming, idempotency, working-partial polling, terminal fill mapping, collision-resistant flatten operation ids, and broker conformance. These seams do **not** constitute a production Tiger connection. No official SDK/protocol wrapper, credentialed quote test, or Tiger demo-order validation is included yet; `@heyphat/pinery/node` and `@heyphat/pinelive/node` require separately registered verified transports.

For a future Tiger dry run, use Tiger data with `broker.id: "paper"`. Real Tiger execution additionally requires `armed: true`; both the registry and TigerBroker reject unarmed execution. Automatic contract rolling is not implemented: a binding is fixed for one run, and operators must stop, inspect exposure, and perform a reviewed manual migration before changing contracts.

## Parity

Create expected JSONL rows shaped as `{ "barTime": 1700000000, "target": 1 }`, then run:

```bash
pinelive parity .pinelive/ledger.jsonl expected-targets.jsonl
```

Parity compares one run/strategy/binding/timeframe scope and reports missing/duplicate cycles, target mismatch, rejects and execution drift. It does not claim fill-price parity.

## Credentials

Keep provider and broker secrets in environment variables or local mode-0600 profiles. Node transport factories receive explicit provider- or broker-specific credential objects, never the full process environment. Errors and ledgers must never include credentials or account identifiers. Tiger entitlement, supported-market/timeframe, and demo arming instructions remain intentionally undocumented until credentialed validation is completed.
