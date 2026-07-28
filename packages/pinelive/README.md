# @heyphat/pinelive

Forward orchestration and broker execution for piner strategies. Market data is owned by `@heyphat/pinery`: pinelive consumes a resolved `MarketDataProvider`, advances piner once per yielded closed bar, reads `strategy.position_size`, and reconciles an exact execution contract.

The canonical CLI uses a versioned JSON config:

```json
{
  "configVersion": 1,
  "strategy": "strategy.pine",
  "symbol": "BTCUSDT",
  "timeframe": "1h",
  "warmupBars": 100,
  "data": {
    "provider": "csv",
    "dataDir": "examples/data",
    "cutoverTime": 1704067200,
    "mintick": 0.01,
    "qtyStep": 1
  },
  "broker": { "id": "paper" },
  "armed": false,
  "ledger": ".pinelive/ledger.jsonl"
}
```

```bash
bun packages/pinelive/src/cli.ts run --config pinelive.local.json
```

Warmup establishes piner state without submitting an order. `reconcileOnStart: true` is an explicit drift-correction mode and writes a separate startup record. Each normal cycle follows one pinery yield and records a schema-v2 binding id, strategy symbol, and exact execution symbol. Shutdown cancels first, attempts provider/broker/ledger cleanup, and never flattens automatically.

`PaperBroker` is the safe default. `TigerBroker` is execution-only and uses an injected `TigerTradingTransport`; it implements exact-contract account/position reads, deterministic reconciliation client-id submission, working-partial polling, terminal fill mapping, collision-resistant flatten operation ids, classified errors, and independent submit/flatten arming gates. No unverified production Tiger SDK transport is bundled or claimed as validated. A real run requires a separately registered, credentialed transport, stale-contract exposure preflight, and demo validation.

The former pinelive `LiveFeed` and `CsvReplayFeed` APIs were intentionally removed. Use pinery's `MarketDataProvider` and `ReplayProvider`; this is a breaking data-boundary migration.

Public entry points: `@heyphat/pinelive` (broker/runner core), `@heyphat/pinelive/node` (JSONL and optional production transport registration), and `@heyphat/pinelive/testing` (broker conformance).

See [the forward guide](../../docs/pinelive.md) and [adapter contract](../../docs/pinelive-adapter-contract.md).
