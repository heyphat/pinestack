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

| Flag                          | Default                | Description                                       |
| ----------------------------- | ---------------------- | ------------------------------------------------- |
| `--calc-on-order-fills`       | script header decides  | Force fill-triggered recalculation ON (`=true`).  |
| `--no-calc-on-order-fills`    | script header decides  | Force it OFF (`=false` also works).               |

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
  walk-forward JSON carries it per window as `calcOnOrderFills`) and as a
  `fill model: calc_on_order_fills` line in the backtest tearsheet, since a
  multiple-fills-per-bar trade list reads surprisingly without it.
  **`portfolio` results carry no fill-model marker** — the command has no
  host override channel; a source-declared flag still executes on a capable
  engine but is not surfaced in the portfolio summary.

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
