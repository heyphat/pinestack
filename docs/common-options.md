# Common options

Flags shared by the analysis commands (`scan`, `backtest`, `compare`,
`portfolio`, `sweep`, `walkforward`). Each command's own page documents its
command-specific flags in full and links back here for these. In `pinerun --help`
these appear as "(as scan)".

## Data source

| Flag                  | Default          | Description                                                                                                    |
| --------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `--tf <tf>`           | `1h`             | Timeframe. One of `1m 5m 15m 1h 4h 1d 1w` (and the other canonical steps).                                     |
| `--from <date>`       | —                | Start of history. ISO date (`2024-01-01`) or unix seconds.                                                     |
| `--to <date>`         | —                | End of history. ISO date or unix seconds.                                                                      |
| `--limit <n>`         | —                | Max bars to fetch (per symbol).                                                                                |
| `--provider <p>`      | `binance`        | Data provider: `binance`, `okx`, `kraken`, `alpaca`, `massive`. Legacy aliases: `binance-futures`, `okx-swap`. |
| `--asset-class <cls>` | provider default | For providers that serve more than one class (`binance`/`okx`: `crypto` \| `futures`).                         |

Give history as either an explicit range (`--from`/`--to`) or a bar count
(`--limit`), or both. With no range, providers return their most recent bars.

### Symbol addressing

A symbol can be a bare ticker (`BTCUSDT`) resolved against `--provider` /
`--asset-class`, or a full **instrument address** that overrides them per symbol
— so one `scan`/`portfolio`/`sweep` can mix providers:

```
PREFIX[:CODE]:TICKER
```

- **Prefixes:** `BI` binance · `OK` okx · `KR` kraken · `AL` alpaca · `MA` massive
- **Codes:** `EQ` equity · `CR` crypto · `FU` futures · `FX` fx

Examples: `BI:FU:BTCUSDT` (binance futures), `KR:BTC/USD` (kraken), `AL:AAPL`
(alpaca equity).

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
`/public/instruments`, Kraken `AssetPairs`; equities are whole-share). The lot
step is what the broker truncates derived order sizes and margin-call
liquidation quantities to (TradingView parity), so multi-symbol scans get the
right quantization per symbol (SOL perps 0.01, DOGE perps whole contracts, spot
BTC 1e-5). Lookups ride the history cache (daily-keyed).

| Flag            | Default                         | Description                                                            |
| --------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `--min-qty <n>` | provider metadata, else `0.001` | Lot-step override — the broker's quantity truncation unit.             |
| `--mintick <n>` | provider metadata, else `0.01`  | Tick-size override (`syminfo.mintick`, level rounding, slippage unit). |

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
