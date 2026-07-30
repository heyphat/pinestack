# @heyphat/pinery

The **data layer** for the [piner](https://github.com/heyphat/piner) engine.
Pinery supplies OHLCV bars to piner (and to [`@heyphat/pinerun`](../pinerun)) via
a small provider contract, canonical timeframe helpers, network and in-memory
adapters, and a Node-only on-disk cache.

It is deliberately narrower than piner's own `DataFeed`: historical callers use
`HistoryProvider`, while forward consumers use `MarketDataProvider` to resolve one
exact data instrument and consume both warmup history and closed bars. `toDataFeed`
bridges historical providers into the `DataFeed` piner's `Engine` consumes.

- **Browser-safe core** (`@heyphat/pinery`): contracts/config, timeframe helpers,
  browser-capable historical adapters, `ReplayProvider`, and transport-injected
  `TigerProvider`. No Node built-ins.
- **Node entry** (`@heyphat/pinery/node`): filesystem cache/CSV live construction,
  the official Tiger OpenAPI SDK adapter, and custom transport registration.
  Never bundled into a browser.

`piner` (`@heyphat/piner`) is a **peer dependency** — pinery implements its
`Bar`/`DataFeed` types and expects the host to provide the engine.

## Install

```bash
bun add @heyphat/pinery @heyphat/piner
```

## Core concepts

### `Bar`

Re-exported from piner. `time` is unix **seconds** at pinery's surface:

```ts
interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
```

> **Time units.** pinery emits `time` in unix **seconds** (ergonomic for CLI dates
> and cache keys). piner's engine expects **milliseconds** (its daily/weekly/session
> bucketing uses ms), so `toDataFeed` — and pinerun's execution boundary — convert
> seconds→ms before handing bars to the engine. Feed pinery bars to piner only
> through `toDataFeed` (or pinerun), not a raw provider, so the conversion happens.

### `HistoryProvider`

The one interface every data source implements.

```ts
interface HistoryRange {
  from?: number; // inclusive lower bound, unix seconds
  to?: number; // inclusive upper bound, unix seconds
  limit?: number; // hard cap on bar count (most-recent when only limit is set)
}

interface HistoryProvider {
  readonly id: string; // stable id used in cache keys / diagnostics
  history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]>;
  // Optional: the symbol's exchange trading rules. Providers that don't know
  // return undefined; callers fall back to engine defaults.
  instrument?(symbol: string): Promise<InstrumentInfo | undefined>;
}

interface InstrumentInfo {
  minQty?: number; // minimum order-quantity step (lot step / min contract size)
  mintick?: number; // minimum price increment (piner's syminfo.mintick)
}
```

Bars are returned ascending by time.

`instrument()` matters for TradingView parity: the piner broker truncates
derived order sizes and margin-call liquidation quantities to the symbol's
minimum contract size, so hosts should resolve the real lot step per symbol
(SOLUSDT perps trade in 0.01 steps, DOGE perps in whole contracts, spot BTC in
1e-5). Implemented by:

| Provider                             | Source                                                        | Notes                                                                 |
| ------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `BinanceProvider` (spot + futures)   | `exchangeInfo` → `LOT_SIZE.stepSize`, `PRICE_FILTER.tickSize` | full map fetched once per instance and memoized                       |
| `OkxProvider` (spot + swap)          | `/api/v5/public/instruments` → `lotSz`, `tickSz`              | swap lot steps are in contracts — converted to base units via `ctVal` |
| `KrakenProvider`                     | `AssetPairs` → `lot_decimals` (step = 10^-n), `tick_size`     |                                                                       |
| `AlpacaProvider` / `MassiveProvider` | static                                                        | whole-share lots (`minQty: 1`), one-cent tick — no credentials needed |
| `StaticProvider`                     | `setInstrument(symbol, info)`                                 | test / fixture seam                                                   |
| `InstrumentRouter`                   | routes like `history()`                                       | prefix stripped, per-pair adapter answers                             |

### `toDataFeed(provider, range?) → DataFeed`

Bridges a provider + a fixed range into the `DataFeed` piner's `Engine` expects
(piner calls `feed.history(symbol, timeframe)` with no range, so the range is
bound here):

```ts
import { Engine, ArrayFeed } from '@heyphat/piner';
import { toDataFeed, BinanceProvider } from '@heyphat/pinery';

const feed = toDataFeed(new BinanceProvider(), { limit: 500 });
// const engine = new Engine(compiled, feed); await engine.run({ symbol, timeframe });
```

### `applyRange(bars, range?) → Bar[]`

Filter an already-materialized, ascending bar array by `from`/`to`/`limit`. Used
internally by `StaticProvider`; exported for adapter authors.

## Timeframes

Pinery uses canonical timeframe tokens: `1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d
3d 1w 1M`. Providers map these to their own vocabulary.

```ts
import { timeframeSeconds, toPinerTimeframe } from '@heyphat/pinery';

timeframeSeconds('15m'); // 900
timeframeSeconds('4h'); // 14400
timeframeSeconds('1d'); // 86400

// Map a canonical token onto piner's timeframe-string convention
// (minutes as a bare number, or D/W/M multiples):
toPinerTimeframe('1h'); // "60"
toPinerTimeframe('15m'); // "15"
toPinerTimeframe('1d'); // "D"
toPinerTimeframe('1w'); // "W"
```

`toPinerTimeframe` only affects piner's `timeframe.*` builtins and
`request.security` labels; it does not change plain series math.

## Adapters

| Provider | Class             | Markets              | Auth            | Notes                               |
| -------- | ----------------- | -------------------- | --------------- | ----------------------------------- |
| Binance  | `BinanceProvider` | spot, USDⓈ-M futures | none            | keyless public klines               |
| OKX      | `OkxProvider`     | spot, swap (perps)   | none            | keyless v5 candles                  |
| Kraken   | `KrakenProvider`  | spot                 | none            | keyless public OHLC (recent window) |
| Alpaca   | `AlpacaProvider`  | US equities          | key id + secret | Market Data v2                      |
| Massive  | `MassiveProvider` | US equities          | api key         | Polygon-compatible aggregates       |
| —        | `StaticProvider`  | any                  | n/a             | in-memory / fixtures                |
| —        | `CsvProvider`     | any                  | n/a             | local CSV files (`/node` entry)     |

All network adapters accept an injectable `fetchImpl` (for tests) and return
ascending `Bar[]` in unix seconds. Crypto symbols are normalized to each
exchange's instrument-id form, so a user can type `BTCUSDT`, `BTC/USDT`, or
`XBTUSD` and each provider receives its canonical form.

## Asset classes

Asset class is orthogonal to the provider: one provider can serve more than one
class (Binance serves crypto spot _and_ USDⓈ-M futures). The closed universe is
`equities | crypto | futures | forex`; `ASSET_CLASS_REGISTRY` declares which
(provider, assetClass) pairs pinery serves and each provider's default class.
Every adapter instance exposes the class it serves as `provider.assetClass`.

```ts
import { createProvider, resolveInstrument, supportsPair } from '@heyphat/pinery';

createProvider('binance'); // spot klines    (id "binance",         assetClass "crypto")
createProvider('binance', 'futures'); // USDⓈ-M perps   (id "binance-futures", assetClass "futures")
createProvider('okx', 'futures'); // OKX swaps      (id "okx-swap",        assetClass "futures")
createProvider('kraken', 'futures'); // throws — kraken does not serve "futures"
supportsPair('alpaca', 'equities'); // true
```

Instruments have one canonical address, `PREFIX[:CODE]:TICKER` — the same
prefixes (`BI OK KR AL MA`) and 2-letter class codes (`EQ CR FU FX`) as
fractal-chart, with the code omitted when it equals the provider's default:

```ts
import {
  encodeInstrumentAddress,
  canonicalizeInstrumentAddress,
  resolveInstrument,
} from '@heyphat/pinery';

encodeInstrumentAddress('binance', 'futures', 'BTCUSDT'); // "BI:FU:BTCUSDT"
encodeInstrumentAddress('binance', 'crypto', 'BTCUSDT'); // "BI:BTCUSDT" (default class collapses)
canonicalizeInstrumentAddress('bi:cr:btcusdt'); // "BI:BTCUSDT" (idempotent)

const { provider, ticker } = resolveInstrument('BI:FU:BTCUSDT');
const bars = await provider.history(ticker, '4h', { limit: 500 });
```

`resolveInstrument` never throws on an unserved class — it degrades to the
provider's default, so untrusted input (CLI flags, saved configs) stays usable.

### `BinanceProvider`

Binance **Spot** and **USDⓈ-M Futures** klines over the keyless REST endpoint —
works in the browser and Node with no credentials.

```ts
import { BinanceProvider } from '@heyphat/pinery';

const spot = new BinanceProvider(); // market: 'spot' (default)
const perps = new BinanceProvider({ market: 'futures' }); // USDⓈ-M perpetuals

// Most-recent N bars (single request):
await spot.history('BTCUSDT', '1h', { limit: 500 });

// A time range (pages forward from `from`):
await spot.history('ETHUSDT', '1d', {
  from: Math.floor(new Date('2023-01-01').getTime() / 1000),
  to: Math.floor(new Date('2024-01-01').getTime() / 1000),
});
```

```ts
interface BinanceProviderOptions {
  market?: 'spot' | 'futures'; // default 'spot'
  baseUrl?: string; // override the REST base. Defaults per market
  maxBars?: number; // safety cap when paging a range. Default 50_000
  fetchImpl?: typeof fetch;
}
```

- Canonical timeframes map 1:1 onto Binance intervals (`1m … 12h`, `1d`, `3d`, `1w`, `1M`).
- With no `from`/`to`, returns the most-recent `limit` bars (default 500, capped 1000/request).
- With a range, pages forward in 1000-bar requests until `to` (or now), dedupes, sorts ascending.
- `id` is `"binance"` (spot) or `"binance-futures"`.

### `OkxProvider`

OKX **SPOT** and **SWAP** (USDⓈ-margined perpetuals) candles over the keyless v5
REST API. Pages newest→oldest via the `after` cursor, falling through from
`/market/candles` to `/market/history-candles` for deep history.

```ts
import { OkxProvider } from '@heyphat/pinery';

const spot = new OkxProvider(); // market: 'spot' (default)
const perps = new OkxProvider({ market: 'swap' });

await spot.history('BTCUSDT', '1h', { limit: 300 }); // → instId BTC-USDT
await perps.history('ETHUSDT', '4h', { limit: 300 }); // → instId ETH-USDT-SWAP
```

```ts
interface OkxProviderOptions {
  market?: 'spot' | 'swap'; // default 'spot'
  baseUrl?: string; // default https://www.okx.com
  maxBars?: number; // default 50_000
  fetchImpl?: typeof fetch;
}
```

- Timeframes map to OKX bars (`1m … 30m`, `1H … 12H`, `1Dutc`, `1Wutc`, UTC-aligned for day/week).
- A non-zero OKX response `code` is surfaced as an error. `id` is `"okx"` or `"okx-swap"`.

### `KrakenProvider`

Kraken **spot** OHLC over the keyless public REST API. Kraken serves up to ~720
of the most-recent bars for the requested interval (no arbitrarily deep history
on this endpoint), so `range` is applied as a filter over what Kraken returns.

```ts
import { KrakenProvider } from '@heyphat/pinery';

const kraken = new KrakenProvider();
await kraken.history('XBTUSD', '1h', { limit: 500 }); // → pair BTC/USD
```

```ts
interface KrakenProviderOptions {
  baseUrl?: string; // default https://api.kraken.com
  fetchImpl?: typeof fetch;
}
```

- Supported timeframes: `1m 5m 15m 30m 1h 4h 1d 1w` (Kraken's OHLC intervals);
  others throw. Legacy asset codes are translated (`XBT`→`BTC`, `XDG`→`DOGE`).

### `AlpacaProvider`

**US equities** bars via the Alpaca Market Data v2 REST API. Requires an API key
id + secret (a data plan). Pages via `next_page_token`.

> **Credentials — prefer env vars.** Leave `keyId`/`secretKey` unset and export
> `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` instead. Hard-coding a key in a
> constructor (or passing it as a CLI flag) risks committing it to source or
> leaking it into shell history. The env vars are read in Node/Bun and ignored in
> the browser.

```ts
import { AlpacaProvider } from '@heyphat/pinery';

// Preferred: credentials come from ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY.
const alpaca = new AlpacaProvider({ feed: 'iex' });
await alpaca.history('AAPL', '1h', { from: 1_700_000_000, to: 1_700_600_000 });
```

```ts
interface AlpacaProviderOptions {
  keyId?: string; // falls back to env ALPACA_API_KEY_ID
  secretKey?: string; // falls back to env ALPACA_API_SECRET_KEY
  feed?: 'iex' | 'sip'; // default 'iex'
  baseUrl?: string; // default https://data.alpaca.markets
  fetchImpl?: typeof fetch;
}
```

- Timeframes map to Alpaca's form (`1Min … 30Min`, `1Hour … 4Hour`, `1Day`, `1Week`).
- Alpaca requires start/end; when no `range` is given, a window covering ~`limit`
  bars is derived (padded for market closures). Throws if credentials are missing.

### `MassiveProvider`

**US equities** aggregates via the Massive REST API (Polygon-compatible
`/v2/aggs`). Requires an API key. Called directly over REST so pinery stays
dependency-free (fractal-chart uses the `@massive.com/client-js` SDK; the wire
format is identical).

> **Credentials — prefer env vars.** Leave `apiKey` unset and export
> `MASSIVE_API_KEY` instead, so the key never lives in source or shell history.
> Read in Node/Bun, ignored in the browser.

```ts
import { MassiveProvider } from '@heyphat/pinery';

// Preferred: the key comes from MASSIVE_API_KEY.
const massive = new MassiveProvider();
await massive.history('AAPL', '1d', { from: 1_690_000_000, to: 1_700_000_000 });
```

```ts
interface MassiveProviderOptions {
  apiKey?: string; // falls back to env MASSIVE_API_KEY
  baseUrl?: string; // default https://api.massive.com
  fetchImpl?: typeof fetch;
}
```

- Timeframes map to `{multiplier, timespan}` (`minute`/`hour`/`day`/`week`/`month`).
- Authenticated with a `Bearer` token. Throws if the API key is missing.

### `StaticProvider`

In-memory provider for tests, offline replay, and fixtures. Keyed by `symbol`
(any timeframe) or the exact `symbol|timeframe` pair when present.

```ts
import { StaticProvider, barsFromCsv } from '@heyphat/pinery';

const provider = new StaticProvider({
  BTCUSDT: bars, // matches any timeframe for BTCUSDT
  'ETHUSDT|1h': hourlyEthBars, // matches only ETHUSDT @ 1h
});

provider.set('SOLUSDT', moreBars); // register/replace after construction

await provider.history('BTCUSDT', '1h', { limit: 100 });
```

Lookup order for `history(symbol, tf)`: `symbol|tf` first, then `symbol`. Throws
if neither is present. The result is filtered through `applyRange`.

### `barsFromCsv(text) → Bar[]`

Parse OHLCV rows from CSV text. The header row must include
`time,open,high,low,close` (`volume` optional; order-independent; extra columns
ignored). `time` may be unix seconds, unix millis (auto-detected), or an ISO
string.

```ts
const bars = barsFromCsv(`time,open,high,low,close,volume
2024-01-01T00:00:00Z,100,101,99,100.5,1200
1704070800,100.5,102,100,101.2,900`);
```

## Node entry — `@heyphat/pinery/node`

### `cached(provider, opts?) → HistoryProvider`

Wraps a provider so identical `(symbol, timeframe, range)` requests are served
from disk (fetch-once / replay-many). Essential for scans and sweeps so you don't
re-hit provider APIs.

```ts
import { BinanceProvider } from '@heyphat/pinery';
import { cached } from '@heyphat/pinery/node';

const provider = cached(new BinanceProvider(), { dir: '.pinery-cache' });
await provider.history('BTCUSDT', '1h', { limit: 500 }); // fetch + write
await provider.history('BTCUSDT', '1h', { limit: 500 }); // served from disk
```

Options:

```ts
interface DiskCacheOptions {
  dir?: string; // cache directory. Default `<cwd>/.pinery-cache`
  refresh?: boolean; // bypass reads (still writes) — forced refresh. Default false
}
```

Cache entries are JSON files keyed by a hash of `providerId + symbol + timeframe +
range`. A corrupt entry falls back to a fresh fetch. The wrapped provider's `id`
becomes `"<providerId>+cache"`.

`instrument()` lookups are cached too (when the wrapped provider supports them):
one JSON file per `(provider, symbol)` keyed by UTC day, so exchange trading-rule
changes surface within a day. `refresh: true` bypasses instrument reads as well.

## API summary

The lists below highlight the main public surface; the TypeScript declarations
remain authoritative.

**`@heyphat/pinery`**

- Historical contracts: `Bar`, `HistoryProvider`, `HistoryRange`,
  `InstrumentInfo`, `toDataFeed`, and `applyRange`.
- Forward contracts: `MarketDataProvider`, `ResolvedDataInstrument`,
  `MarketDataError`, provider config types, and cancellation/lifecycle types.
- Timeframes: `timeframeSeconds`, `toPinerTimeframe`, `parseTimeframe`, and
  `pinerTimeframeToCanonical`.
- Addressing/factories: asset-class registry and instrument-address helpers,
  `createProvider`, `createMarketDataProvider`, `resolveInstrument`, and
  `InstrumentRouter`.
- Historical adapters: `BinanceProvider`, `OkxProvider`, `KrakenProvider`,
  `AlpacaProvider`, `MassiveProvider`, `StaticProvider`, and `barsFromCsv`.
- Forward adapters: `ReplayProvider`, transport-injected `TigerProvider`, and
  Tiger market-data transport types.
- Shared HTTP/symbol helpers, including `fetchJson` and exchange normalization.

**`@heyphat/pinery/node`**

- `cached` and `DiskCacheOptions`, including source-identity-keyed legacy
  history, exact-acquisition, and instrument metadata caching.
- `CsvProvider` and `CsvProviderOptions` — serve history from a directory of
  `<SYMBOL>_<TF>.csv` files (header `time,open,high,low,close,volume`; optional
  `instruments.csv` sidecar for lot step / tick size). Node-only because it
  reads the filesystem; route it through `InstrumentRouter` via
  `InstrumentRouterOptions.providers`. Exact acquisition stays fail-closed by
  default (unknown alignment, no advertised exact timeframes, bars-only
  coverage); opt in explicitly with `timeframes`, `alignment: 'utc-24x7'` plus
  optional `weekAnchorSec`, or a `calendar`, plus
  `coverageSemantics: 'complete-record'` to treat missing bars inside an exact
  file's authenticated record span as no-trade intervals. `cacheIdentity`
  versions the dataset; all claims join the fingerprinted source identity.
- `createNodeMarketDataProvider` for Node-only CSV/Replay and official Tiger
  construction.
- The official Tiger OpenAPI market-data adapter and
  `registerTigerMarketDataTransport` override for fixtures/custom transports.

## Writing a historical provider

Implement `HistoryProvider`. Return ascending bars in Unix seconds and honor
`range` (or apply `applyRange` after materializing). Keep the core browser-safe;
put filesystem or vendor-SDK work behind a `/node` entry. If the venue exposes
lot/tick rules, implement `instrument()` so hosts use real quantization.

```ts
import type { Bar, HistoryProvider, HistoryRange } from '@heyphat/pinery';
import { applyRange } from '@heyphat/pinery';

export class MyProvider implements HistoryProvider {
  readonly id = 'myprovider';

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const bars = await fetchSomehow(symbol, timeframe);
    return applyRange(bars, range);
  }
}
```

Forward providers have a stricter contract: exact instrument resolution,
resolved warmup history, exclusive-after closed-bar streaming, cancellation,
and cleanup. Follow the existing `ReplayProvider`/`TigerProvider` behavior and
add deterministic transport-level coverage for closure, gaps, pagination,
identity, cancellation, and malformed data.

## Forward market data

`MarketDataProvider` extends the historical surface with strict resolution,
resolved history, an exclusive-after stream of closed bars, cancellation, and
optional cleanup. `ResolvedDataInstrument` freezes the strategy symbol, opaque
provider handle, exact venue symbol, tick size, native quantity step, minimum
order, and available point-value/exchange/expiry metadata. `MarketDataError`
classifies connectivity, authentication, rate-limit, invalid-symbol,
entitlement, and malformed-data failures without exposing credentials.

### Replay

`ReplayProvider` wraps any historical provider with an explicit `cutoverTime`.
`historyResolved({ limit })` returns the most recent bars before cutover, while
`closedBars({ after })` emits later closed bars in ascending unique order. With
a virtual clock it waits and rechecks a not-yet-closed bar instead of dropping
it; cancellation interrupts that wait. The Node factory combines CSV data with
ReplayProvider, so CSV parsing and replay timing remain in pinery rather than
pinelive.

```ts
import { ReplayProvider, StaticProvider } from '@heyphat/pinery';

const history = new StaticProvider({ MGC: bars }).setInstrument('MGC', {
  minQty: 1,
  mintick: 0.1,
});
const data = new ReplayProvider(history, {
  cutoverTime: 1_704_067_200,
  instrument: { minOrderQty: 1, pointValue: 10 },
});
```

`ProviderConfig` is a strict discriminated union. The browser-safe
`createMarketDataProvider` handles compatible core providers;
`createNodeMarketDataProvider` handles CSV/filesystem and the default official
Tiger transport. Existing `createProvider` remains the permissive historical
factory. Forward symbol/provider or asset-class mismatches fail instead of
coercing to another instrument.

### Tiger

Tiger is registered as `TG:` and futures-only. `TigerProvider` uses an injected
`TigerMarketDataTransport` to resolve and freeze one exact contract, fetch
closed history, and poll with overlap, deduplication, paged gap recovery, retry,
and cancellation. `nextCursor` identifies an older page; its absence declares
the requested range complete. History continues paging when conservative
finality filtering would otherwise underfill a limit, and live polling drains
all pages before yielding a recovered gap.

`@heyphat/pinery/node` defaults to the pinned official
[`@tigeropenapi/tigeropen`](https://github.com/tigerfintech/openapi-typescript-sdk)
adapter. `registerTigerMarketDataTransport` remains an override for fixtures and
reviewed custom transports.

Supported timeframes are `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, and
`6h`. Their K-line timestamps are treated as bar opens. `1d`, `1w`, and `1M` are
rejected because Tiger stamps them at a session-close boundary that cannot be
safely converted into a session open. `8h`, `12h`, and `3d` are not offered.
The newest bar on the newest page is conservatively withheld as still forming,
which can add up to one bar of latency. Pagination cursors retain the first
page's request parameters because Tiger rejects a cursor request with changed
parameters. The SDK has no request-level `AbortSignal`, so cancellation is
checked immediately before and after, not during, an in-flight SDK call.

> **Readiness:** Tiger coverage is offline only, using injected SDK facades. No
> credentialed contract resolution, quote/history response, entitlement,
> demo/live order, cancellation, or fill was validated by this audit. The data
> and execution adapters are not sandbox- or production-approved. See the
> [pinelive forward guide](../../docs/pinelive.md#paper-and-tiger) and permanent
> [`feat/pinelive` audit](../../docs/feat-pinelive-audit.md).

## License

[GNU AGPL-3.0](../../LICENSE) © Phat Huynh.
