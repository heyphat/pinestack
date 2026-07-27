# @heyphat/pinelive

SDK-free forward execution for piner strategies. pinelive advances a compiled strategy on closed bars, reads piner's signed target position, and reconciles a broker through one narrow protocol. It includes deterministic CSV replay and a full PaperBroker; no network adapter or broker SDK is bundled.

```bash
bun packages/pinelive/src/cli.ts run strategy.pine \
  --broker paper --feed csv --data bars.csv --symbol BTCUSDT --tf 1h \
  --warmup 100 --ledger .pinelive/ledger.jsonl
```

The CLI is paper-only and dry by construction in this release. Future real adapters must be registered as `real`, require `--arm`, independently gate submission, and pass the shared conformance suite. See [the guide](../../docs/pinelive.md) and [adapter contract](../../docs/pinelive-adapter-contract.md).

Public entry points: `@heyphat/pinelive` (SDK-free core), `@heyphat/pinelive/node` (JSONL/file helpers), and `@heyphat/pinelive/testing` (adapter conformance utilities).
