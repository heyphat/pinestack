# Common options

Flags shared by the analysis commands (`scan`, `backtest`, `compare`,
`portfolio`, `sweep`, `walkforward`). Each command's own page documents its
command-specific flags in full and links back here for these. In `pinerun --help`
these appear as "(as scan)".

## Data source

| Flag                  | Default          | Description                                                                                                           |
| --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `--tf <tf>`           | `1h`             | Timeframe. One of `1m 5m 15m 1h 4h 1d 1w` (and the other canonical steps).                                            |
| `--from <date>`       | —                | Start of history. ISO date (`2024-01-01`) or unix seconds.                                                            |
| `--to <date>`         | —                | End of history. ISO date or unix seconds.                                                                             |
| `--limit <n>`         | —                | Max bars to fetch (per symbol).                                                                                       |
| `--provider <p>`      | `binance`        | Data provider: `binance`, `okx`, `kraken`, `alpaca`, `massive`, `csv`. Legacy aliases: `binance-futures`, `okx-swap`. |
| `--asset-class <cls>` | provider default | For providers that serve more than one class (`binance`/`okx`: `crypto` \| `futures`).                                |
| `--data-dir <dir>`    | —                | Directory of local CSV history for `--provider csv` / `CSV:` symbols — see [CSV data files](./csv-data.md).           |

Give history as either an explicit range (`--from`/`--to`) or a bar count
(`--limit`), or both. With no range, providers return their most recent bars.

### Symbol addressing

A symbol can be a bare ticker (`BTCUSDT`) resolved against `--provider` /
`--asset-class`, or a full **instrument address** that overrides them per symbol
— so one `scan`/`portfolio`/`sweep` can mix providers:

```
PREFIX[:CODE]:TICKER
```

- **Prefixes:** `BI` binance · `OK` okx · `KR` kraken · `AL` alpaca · `MA` massive · `CSV` local files
- **Codes:** `EQ` equity · `CR` crypto · `FU` futures · `FX` fx

Examples: `BI:FU:BTCUSDT` (binance futures), `KR:BTC/USD` (kraken), `AL:AAPL`
(alpaca equity), `CSV:AAPL` (local [CSV file](./csv-data.md), needs `--data-dir`).

The same rules apply to cross-symbol `request.security` dependencies inside a
script: a bare ticker there resolves against `--provider`, not the chart
symbol's provider. In a mixed universe, qualify it —
`request.security("CSV:MSFT", …)`.

### Credentials (equities providers — Alpaca / Massive)

Crypto providers (binance/okx/kraken) need no key. Alpaca and Massive do. **Prefer
environment variables** — a key on the command line lands in shell history and
process listings:

```bash
export ALPACA_API_KEY_ID=…  ALPACA_API_SECRET_KEY=…    # Alpaca
export MASSIVE_API_KEY=…                                # Massive
```

| Flag                    | Description                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `--api-key <key>`       | Alpaca key id / Massive key. **Discouraged** (leaks via history); overrides the env var. |
| `--api-secret <secret>` | Alpaca secret key. **Discouraged**; prefer `ALPACA_API_SECRET_KEY`.                      |
| `--feed iex\|sip`       | Alpaca data feed (default `iex`).                                                        |

## Execution

| Flag                   | Default     | Description                                                                                                             |
| ---------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `--backend js\|interp` | `js`        | piner backend — generated JS or the AST interpreter. Output is identical; `interp` is a cross-check.                    |
| `--concurrency <n>`    | = workers   | Max jobs in flight. _(scan, portfolio, sweep, walkforward)_                                                             |
| `--workers <n\|local>` | = CPU count | Worker threads; `local` runs in-process (no threads). _(scan, sweep, walkforward)_                                      |
| `--no-security`        | off         | Skip `request.security` dependency resolution (cross-symbol / lower-TF fetch + inject); those requests degrade to `na`. |

`backtest` and `compare` are single runs, so they have no `--workers` /
`--concurrency`.

## Instrument metadata

Each run resolves the symbol's exchange trading rules automatically —
lot step and tick size — from the provider (Binance `exchangeInfo`, OKX
`/public/instruments`, Kraken `AssetPairs`; equities are whole-share; csv reads
an optional [`instruments.csv` sidecar](./csv-data.md#instrument-metadata)). The lot
step is what the broker truncates derived order sizes and margin-call
liquidation quantities to (TradingView parity), so multi-symbol scans get the
right quantization per symbol (SOL perps 0.01, DOGE perps whole contracts, spot
BTC 1e-5). Lookups ride the history cache (daily-keyed).

| Flag            | Default                         | Description                                                            |
| --------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `--min-qty <n>` | provider metadata, else `0.001` | Lot-step override — the broker's quantity truncation unit.             |
| `--mintick <n>` | provider metadata, else `0.01`  | Tick-size override (`syminfo.mintick`, level rounding, slippage unit). |

## Fill model — `calc_on_order_fills`

Pine's `strategy(calc_on_order_fills = true)` re-executes a strategy after
each order fill on **historical** bars — the broker walks each bar's intrabar
path and a script can fill several times per bar (TradingView's "After order
is filled" Properties checkbox). The host override mirrors that checkbox
without editing the script:

| Flag                       | Default               | Description                                      |
| -------------------------- | --------------------- | ------------------------------------------------ |
| `--calc-on-order-fills`    | script header decides | Force fill-triggered recalculation ON (`=true`). |
| `--no-calc-on-order-fills` | script header decides | Force it OFF (`=false` also works).              |

Semantics and caveats:

- **Tri-state.** Absent → the script's own `strategy()` declaration decides;
  `true`/`false` override the header either way. The override joins the
  determinism cache key, so sweep/scan variants never share memoized results.
- **Commands.** Supported on `backtest`, `scan`, `sweep`, and `walkforward`
  (the walk-forward in-sample search and winner run use the same setting).
  **`portfolio` has no host override** — the script header still applies
  there. Programmatic equivalents: the `calcOnOrderFills` field on
  `BacktestOptions`, `ScanOptions`, `SweepOptions`, `WalkforwardOptions`,
  and `Job`.
- **Historical only.** The flag models TradingView's historical intrabar
  fill points; there is no realtime/tick execution in pinerun.
- **Engine requirement.** Needs a `@heyphat/piner` release newer than 0.9.0
  (the historical `calc_on_order_fills` engine). On an older engine the
  override is **rejected with an error** rather than silently ignored — and
  a source-declared header flag runs (inertly) but is never reported as
  active.
- **Reporting.** The effective mode — read from the engine's actual state,
  never from the requested configuration — appears as
  `strategy.calcOnOrderFills` in JSON results (backtest/scan/sweep results;
  walk-forward JSON carries it per window as `calcOnOrderFills`) and in the
  human fill-model line (for example,
  `fill model: standard chart OHLC + calc on order fills`), since a
  multiple-fills-per-bar trade list reads surprisingly without it.
  **`portfolio` results carry no fill-model marker** — the command has no
  host override channel; a source-declared flag still executes on a capable
  engine but is not surfaced in the portfolio summary.

## Fill model — Bar Magnifier

`strategy(use_bar_magnifier = true)` requests TradingView's Bar Magnifier
Properties setting. piner is the semantic authority: pinerun resolves and
injects exact lower-timeframe history, but never calculates fills or infers that
magnification was active.

| Flag                 | Default               | Description                                               |
| -------------------- | --------------------- | --------------------------------------------------------- |
| `--bar-magnifier`    | script header decides | Force the strategy setting on (`=true` is also accepted). |
| `--no-bar-magnifier` | script header decides | Force it off (`--bar-magnifier=false` is equivalent).     |

The flags are strict booleans on `backtest`, `compare`, `scan`, `sweep`, and
`walkforward`. They are tri-state: absent preserves each source declaration;
`true` or `false` wins in either direction. `compare` uses one shared override
for both sides while the two source headers remain independent. There is no
custom target-timeframe argument: `--bar-magnifier=10m` is an error. `portfolio`
has no basket-wide override in v1; every sleeve follows the source declaration.
The effective override, mapping/report contract versions, exact dataset, and
result projection are part of the strong job/worker determinism key.

### Automatic mapping and exact support

Piner's versioned TradingView mapping chooses the target timeframe from the
chart timeframe. Exact mode proceeds only when the provider can prove all of the
following:

- chart interval alignment (`utc-24x7`, a complete provider exchange calendar,
  or explicit chart closes);
- a native mapped target timeframe or an exactly aggregatable divisor;
- complete symbol/window/session coverage, with no missing internal intervals;
- every static `request.security` / `request.security_lower_tf` dependency
  fetched before execution.

Unknown alignment, unsupported/non-divisor timeframes, incomplete calendars or
coverage, malformed timestamps, and provider safety limits fail closed. Runtime-
dynamic security symbol/timeframe/lookahead identities are rejected with
`dynamic-security-unsupported-with-bar-magnifier`; `--no-security` cannot bypass
that exact-mode requirement. These are serializable permanent
`unsupported`/`malformed`/`provider-limited` outcomes. Backtest/compare fail,
watch stops, portfolio aborts atomically, and scan/sweep/walk-forward retain an
explicit failed-run or failed-fold diagnostic rather than silently reporting a
smaller successful universe. Ordinary transient provider/network failures keep
the existing bounded-retry behavior.

The newest **200,000 eligible target bars** are piner's execution limit. A
walk-forward fold is stricter: its one complete IS+OOS chart envelope must
contain at most 200,000 eligible target bars before candidate ranking begins.
`200,000` is accepted; `200,001` is rejected, including when the moving suffix
boundary would land inside IS. This preserves the existing IS-prefix identity
used to rank candidates.

### Runtime and release matrix

The runtime gate runs before exact source routing, static-security acquisition,
or lower-timeframe provider I/O. The release and future contract states are
intentionally distinct:

| Runtime state                                                                                   | Effective Bar Magnifier request                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shipped self-contained `pinerun` binary and this root checkout:** `@heyphat/piner` **0.10.0** | Fails metadata capability preflight with permanent code `piner-bar-magnifier-capability-unavailable`. No exact dataset or static-security dataset is prepared and piner does not execute the job. An explicit/source-effective false setting still follows the ordinary chart-OHLC path. |
| **Future contract-capable piner, traversal disabled**                                           | May map, acquire, validate, and inject exact data, then must authoritatively report `requested: true`, `active: false`; fills remain chart OHLC. This is the only state in which “exact data prepared, requested/inactive” is valid.                                                     |
| **Future contract-capable piner, traversal enabled**                                            | Magnification is presented as active only when piner's report says `active: true`. Its target, counters, coverage, and timestamps remain authoritative; pinerun does not infer activity from injected data.                                                                              |

Release binaries are self-contained: the Bun runtime, pinery, and the exact
root-pinned piner version are baked into one artifact. The workspace package
names are source/API entry points, not separately released npm artifacts whose
peer resolution could silently change a binary's engine contract.

### Provider exact-acquisition matrix

Provider capability matters only after a compatible runtime passes the gate
above. “Exact” here means pinery can prove its own interval alignment,
provenance, and complete requested coverage; it does **not** mean the bars are
the same feed as TradingView.

| Provider                                                  | Exact evidence and advertised source timeframes                                                           | Bounds and fail-closed posture                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Binance spot**                                          | UTC 24×7; `1s`, `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`     | 1,000 bars/page; newest-first; 50,000 source bars per acquisition by default. A cap-shortened envelope is rejected.                                                                                                                                                                                 |
| **Binance USDⓈ-M futures**                                | UTC 24×7; the same list **except `1s`**                                                                   | 1,000 bars/page; newest-first; 50,000 source bars by default; partial leading history is rejected.                                                                                                                                                                                                  |
| **OKX spot / swap**                                       | UTC variants; `1s`, `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `12h`, `1d`, `2d`, `3d`, `1w` | Recent endpoint: 300/page; history endpoint: 100/page; at most 200 pages. Default effective safety cap is 50,000 source bars (configured values are still bounded by the 60,000-page capacity).                                                                                                     |
| **Kraken spot**                                           | UTC 24×7; `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, `1w`, `15d`                                         | The API exposes only the most recent 720 bars. Any requested start outside that window is a provider-limited permanent outcome.                                                                                                                                                                     |
| **Alpaca equities**                                       | Advertises `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, `1w`; 10,000/page and 50,000 bars by default       | Alignment is deliberately `unknown` without a versioned exchange-session calendar, so exact planning fails closed even though those cadences are available. Feed and adjustment choices are part of source identity.                                                                                |
| **Massive equities**                                      | Advertises the same equity cadences; one descending aggregate request, at most 50,000 bars                | Alignment is deliberately `unknown` without versioned session evidence, so exact planning fails closed. Adjustment policy is part of source identity.                                                                                                                                               |
| **Static provider**                                       | Defaults to unknown alignment and no declared exact timeframes                                            | Programmatic callers must supply proven `alignment`, declared `timeframes`, and `calendar` when exchange-calendar aligned. Content is fingerprinted; an optional caller-owned `cacheIdentity` versions fixture semantics. Missing rows/gaps still fail coverage.                                    |
| **CSV provider**                                          | Same fail-closed defaults as Static                                                                       | Programmatic `CsvProvider` callers can supply `alignment`, `calendar`, `timeframes`, and `cacheIdentity`. The current CLI exposes only `--data-dir`, not evidence flags, so CLI CSV cannot establish exact-mode support. Relevant files are content-fingerprinted and rechecked during acquisition. |
| **Legacy/custom provider without `resolveHistorySource`** | No exact alignment, timeframe, provenance, or coverage contract                                           | Ordinary `history(): Bar[]` behavior remains available outside magnifier mode; exact mode rejects the provider and never treats a nonempty fragment as complete.                                                                                                                                    |

Provider limits count acquired **source** bars and can reject an envelope before
piner's independent newest-200,000 **eligible target-bar** execution rule. Exact
mode never converts either limit into a partial success. `--refresh` bypasses
disk reads and command-local sharing never survives into a later operation or
watch cycle.

### Authoritative reporting

JSON mirrors piner's optional authoritative `strategy.barMagnifier` block;
human output distinguishes:

```text
fill model: standard chart OHLC
fill model: standard chart OHLC (bar magnifier requested for 10m; inactive, no covered bars)
fill model: bar magnifier + calc on order fills
magnifier: 10m; 8,120/10,000 chart bars (81.20%); 48,720 intrabars; coverage=tv-cap-fallback
```

Coverage and counters are printed only from that piner block, never from the
presence of injected data. Under the shipped 0.10.0 runtime an effective request
fails before this block or exact data exists. A future compatible but traversal-
disabled runtime may produce the requested/inactive line after preparation; an
active line requires piner itself to report active traversal.

Finally, provider exactness is not TradingView-feed parity. Matching fills also
requires the same exchange feed, session/calendar, timezone, adjustment policy,
and OHLC construction. Pinery fixtures prove acquisition behavior;
TradingView-observed fixtures remain the semantic parity evidence.

## History cache

pinerun caches fetched bars on disk so repeat runs are instant and offline.

| Flag                | Default         | Description                           |
| ------------------- | --------------- | ------------------------------------- |
| `--no-cache`        | cache on        | Disable the on-disk history cache.    |
| `--cache-dir <dir>` | `.pinery-cache` | Cache directory.                      |
| `--refresh`         | off             | Refetch and overwrite cached history. |

## Metrics annualization

Applies wherever risk-adjusted metrics (Sharpe/Sortino/Calmar, CAGR, volatility)
are computed.

| Flag                     | Default                       | Description                                                               |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------- |
| `--periods-per-year <n>` | empirical bar times / 24-7 tf | Annualization override — e.g. `252` for daily US equities.                |
| `--risk-free-rate <r>`   | `0`                           | Annual risk-free rate as a fraction (e.g. `0.02`), subtracted per period. |

## Output

| Flag     | Description                                                              |
| -------- | ------------------------------------------------------------------------ |
| `--json` | Emit JSON instead of a formatted table/tearsheet (for piping / scripts). |

## Ranking spec (`--rank`)

Used by `scan`, `sweep`, and `walkforward` to reduce each run to one comparable
number. Default `last` for indicators, `strategy.netProfit` for strategies.

**Plot extractors** (read a plotted series):

- `last(title)` — the series' final value (`last` = the first/only plot)
- `first(#0)` — the series' first value (`#0` selects a plot by index)
- `min(title)` · `max(title)` · `mean(title)` · `sum(title)` · `count(title)`

**Strategy metrics** (strategy scripts):

`strategy.netProfit` · `strategy.winRate` · `strategy.profitFactor` ·
`strategy.sharpe` · `strategy.sortino` · `strategy.calmar` ·
`strategy.cagrPercent` · `strategy.outperformance` · … (the full
`StrategyMetrics` surface).

Pair with `--top <n>` to keep the best N and `--asc` to sort ascending (default
descending).

## Swept input grammar (`--input`)

Used by `sweep` and `walkforward`. `--input` is **repeatable**; each defines one
axis whose name must match a Pine `input()` title (validated against the script
before anything runs). The value is a list, a range, or a mix:

```
--input fast=5,10,20        # list
--input slow=30:100:10      # range start:stop:step
--input len=5,10:20:5       # list members may themselves be ranges
--input useStop=true,false  # booleans
--input sess="'09:30'"      # quoted → literal string (an unquoted 09:30 is a range)
```

In `backtest`, `compare`, and `portfolio`, `--input` (and `--input-a`/`--input-b`)
instead takes a **single** fixed value per name — grids are `sweep`'s job.

## See also

- [`scan`](./scan.md) · [`backtest`](./backtest.md) · [`compare`](./compare.md) ·
  [`portfolio`](./portfolio.md) · [`sweep`](./sweep.md) ·
  [`walkforward`](./walkforward.md) · [`init`](./init.md)
