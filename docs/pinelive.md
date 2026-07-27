# pinelive forward testing

`@heyphat/pinelive` mirrors piner's `strategy.position_size` into a Broker after every closed bar. It does not infer strategy intent or replay simulated orders. The actual account is read each cycle, making drift self-correcting.

## Offline run

```bash
pinelive run strategy.pine --broker paper --feed csv --data BTCUSDT_1h.csv \
  --symbol BTCUSDT --tf 1h --warmup 100 --min-qty 0.001 \
  --ledger .pinelive/ledger.jsonl
```

CSV parsing reuses pinery's strict `barsFromCsv`: timestamps are sorted, duplicates keep the final row, malformed OHLC data fails loudly, and only closed bars are emitted. History is a prefix and the stream is the non-overlapping tail. The runner serializes ticks and orders and suppresses repeated/non-monotonic bars defensively.

Paper fills use the current closed bar's close, plus configured slippage. The broker is marked before each reconcile. It models signed net quantity, weighted entry price, realized/unrealized PnL, point value, commission, and client-id idempotency.

## Safety and recovery

- The shipped CLI supports only PaperBroker, so it cannot place a network order.
- Registry entries capable of real execution must be marked `real`; construction is refused without `--arm`. A real adapter must enforce the same flag inside `submit` and `flatten`.
- Client ids derive from execution identity, strategy, symbol, timeframe, bar time, observed position, target, and submitted quantity—not a process-local counter. An unknown-outcome retry reuses the exact id, while a capped or partial fill changes observed state and receives a new logical-attempt id on restart. Conflicting payload reuse is rejected.
- A shutdown signal synchronously cancels reconciliation before effectful feed cleanup, including during warmup. Cleanup attempts feed stop, ledger flush/close, and broker disconnect even when one operation fails; positions are never flattened.
- `request.security` is rejected in v1 because a single feed cannot faithfully supply dependency series.

## Ledger parity

Create expected JSONL rows shaped as `{ "barTime": 1700000000, "target": 1 }`, then run:

```bash
pinelive parity .pinelive/ledger.jsonl expected-targets.jsonl
```

The utility reports missing or duplicate cycles, mixed run/symbol/timeframe scopes, target differences (engine/data parity), rejected orders, and execution drift. Run one comparison per live scope; append-only ledger files containing multiple runs are rejected rather than silently merged. It does not claim fill-price parity: slippage and commission are expected live differences.

## Credentials

No credential is needed for offline runs. Future adapters must read secrets from environment variables or a local `pinelive.local.json` with mode `0600`; never put credentials in CLI output, ledger records, source, or checked-in config. `.pinelive/` and `pinelive*.local.*` are ignored.

Tiger and IC Markets remain pending: SDK/transport choice, credentials, and sandbox validation are unresolved. No network integration or sandbox claim is made by this package.
