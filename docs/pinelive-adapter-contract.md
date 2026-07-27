# pinelive Broker adapter contract

A Broker adapter is the only venue-specific layer. Core code must never inspect venue identity or position model.

## Required behavior

- `id` is stable. `connect`/`disconnect` are repeat-safe when supplied.
- `instrument(strategySymbol)` resolves one instrument used consistently for both market data and execution. It returns positive `minQty`/`qtyStep`, `mintick`, optional `pointValue`, and explicit broker quantity conversion/granularity.
- `getPosition(symbol)` returns one signed **net** quantity in strategy-native units. Hedging adapters sum all venue positions. Long is positive, short negative, flat zero.
- `getAccount()` reports account-currency balance and equity without leaking secrets.
- `submit(order)` accepts unsigned native quantity and explicit side. It converts and rounds toward zero, supports market orders, waits for a terminal filled/partial result, and returns native filled quantity. It must persist/deduplicate each `clientId` for the adapter's documented retention window. A timeout after transmission is `timeout` and retryable with the same id, never an unconditional new order.
- Reducing orders on hedging venues close/reduce existing opposing positions rather than blindly stacking exposure. `flatten` reaches zero using venue-appropriate operations.
- Expected failures are `BrokerError` with `reject`, `connectivity`, `timeout`, `rate-limit`, `auth`, `unknown-symbol`, or `precondition`. Only connectivity/timeout/rate-limit are retryable by default. Invariant/programmer errors must not be disguised.
- `capabilities()` truthfully declares position model, transport, quantity and flatten support.

## Safety boundary

Real adapters accept an `armed` constructor flag. Both `submit` and `flatten` must reject with `BrokerError('precondition', ...)` while unarmed, even if a caller bypasses the CLI. Registry entries are additionally marked `real`, providing a second gate. Credentials come from environment/local config, are redacted from errors, and are never written to the ledger.

## Conformance

Use `runBrokerConformance()` from `@heyphat/pinelive/testing` with a controllable mock transport or credentialed demo harness. The harness must set arbitrary actual net exposure and marks; the suite covers noop/open/add/reduce/close/flip and restart drift. Add adapter-specific tests for rejects, duplicate client ids, partial/unknown outcomes, conservative unit conversion, hedging reduction, auth errors, and unarmed refusal.

Tiger and IC Markets transports are intentionally unspecified until their SDK/protocol and sandbox environments are selected. A skeleton that pretends to send orders is not conformant.
