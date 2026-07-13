# `pinerun scan`

> Screen: one script across N symbols, ranked.

Runs one script across many symbols in parallel and prints a table with one row per symbol, sorted by a ranking value. For an indicator the rank is a plot value (e.g. current RSI); for a `strategy()` it defaults to `strategy.netProfit`, so `scan` doubles as a batch backtester across a universe. History is fetched per symbol through the (cached) data provider, jobs run on a worker pool, and per-symbol fetch failures are collected rather than aborting the run.

## Synopsis

```bash
pinerun scan <script.pine> [options]
```

## Parameters

| Flag                | Default                       | Description                                                                                                                                                                                                                                                                                                |
| ------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--symbols a,b,c`   | —                             | Inline symbol list, comma- or space-separated. A symbol may be a full instrument address `PREFIX[:CODE]:TICKER` that overrides `--provider`/`--asset-class` for that symbol (see [Symbol addressing](./common-options.md#symbol-addressing)). Combines with `--universe`; the merged set is de-duplicated. |
| `--universe <file>` | —                             | File of symbols, one per line; blank lines and `#` comments are ignored. Combines with `--symbols`.                                                                                                                                                                                                        |
| `--rank <spec>`     | `last` / `strategy.netProfit` | Ranking spec that reduces each run to one sortable value — e.g. `last(rsi)`, `mean(rsi)`, `max(#0)`, `strategy.netProfit`, `strategy.sharpe`. Indicators default to `last`; strategies default to `strategy.netProfit`. See [Ranking spec](./common-options.md#ranking-spec---rank) for the grammar.       |
| `--top <n>`         | —                             | Keep only the top `n` rows after sorting (all ranked rows shown otherwise).                                                                                                                                                                                                                                |
| `--asc`             | descending                    | Sort ascending instead of descending.                                                                                                                                                                                                                                                                      |
| `--trades`          | off                           | Attach the closed-trade ledger + equity curve. Printed for a single-symbol scan (with its PRICE chart, trades marked at fill prices); always emitted in `--json`; adds an EQUITY sparkline column to the table.                                                                                            |
| `--no-chart`        | off                           | Skip the table sparklines (the SERIES / EQUITY columns) and the single-result PRICE chart.                                                                                                                                                                                                                 |
| `--csv <dir>`       | —                             | Write `<label>-trades.csv` + `<label>-equity.csv` per ranked strategy result into `<dir>`. Implies `--trades`.                                                                                                                                                                                             |
| `--plot <dir>`      | —                             | Write a self-contained `<label>.html` equity + drawdown chart per ranked strategy result into `<dir>`. Implies `--trades`.                                                                                                                                                                                 |

## Common options

Plus the shared data-source, credential, execution, cache, metrics, and output
flags — see [common options](./common-options.md):

- **Data:** `--tf` · `--from` · `--to` · `--limit` · `--provider` · `--asset-class` (+ [credentials](./common-options.md#credentials-equities-providers--alpaca--massive))
- **Execution:** `--backend` · `--concurrency` · `--workers` · `--no-security`
- **Cache:** `--no-cache` · `--cache-dir` · `--refresh`
- **Metrics:** `--periods-per-year` · `--risk-free-rate`
- **Output:** `--json`

## Output

The default output is a ranked table: `#` (rank position), `SYMBOL`, `VALUE` (the
`--rank` value), and `BARS` (bars processed), followed by a footer line echoing
the rank spec and run counts (e.g. `rank="last(rsi)"  5/5 ran  3 ranked  in 56ms`).
Unless `--no-chart` is set, each row also gets a `SERIES` sparkline of the ranked
plot; with `--trades` (or `--csv`/`--plot`, which imply it) an `EQUITY` sparkline
column of the retained equity curve is added instead.

A single-symbol scan run with `--trades` additionally prints a PRICE chart with
trades marked at their fill prices, above the closed-trade ledger.

With `--json`, the full report is emitted as JSON instead of the table —
including the trade ledger and equity curve — for piping into other tools.

## Examples

Rank a symbol list by current RSI, top 10, across worker threads:

```bash
pinerun scan examples/rsi.pine \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT \
  --tf 1h --limit 300 --rank "last(rsi)" --top 10
```

Which prints a ranked table (one row per symbol, with a plot sparkline):

```text
  #  SYMBOL            VALUE  BARS  SERIES
  ------------------------------------------------------
   1 ETHUSDT         50.9528  299    ▂▆▇█▇█▇▅▆▄▄▅▄▄▅█▆█▅
   2 BTCUSDT         47.3813  299    ▂▅██▆█▇▅▅▄▅▆▄▄▇█▆▆▅
   3 BNBUSDT         43.2215  299    ▂▅▇█▆█▇▅█▄▅▆▃▅▆▇▅▇▅
   4 SOLUSDT         40.1425  299    ▂▆▇▇▆▇▄▃▅▄▅▅▂▃▅▇▄▅▄
   5 XRPUSDT         38.3130  299    ▂▆▇█▆█▇▄▄▄▄▄▂▄▅▇▅▆▃

  rank="last(rsi)"  5/5 ran  5 ranked  in 48ms
```

Read symbols from a file over a fixed date range, ranked by mean RSI, as JSON for piping:

```bash
pinerun scan rsi.pine \
  --universe universe.txt --tf 1d --from 2023-01-01 --to 2024-01-01 \
  --rank "mean(rsi)" --json
```

Deterministic in-process run (no worker threads):

```bash
pinerun scan rsi.pine --symbols BTCUSDT --workers local
```

Backtest a strategy across a universe, ranked by net profit, top 3:

```bash
pinerun scan examples/sma-cross-param.pine \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT \
  --tf 1h --limit 500 --rank "strategy.netProfit" --top 3
```

Screen US equities via Alpaca (credentials read from env vars):

```bash
export ALPACA_API_KEY_ID=…
export ALPACA_API_SECRET_KEY=…
pinerun scan strat.pine --provider alpaca --symbols AAPL,MSFT --tf 1d
```

## See also

- [`sweep`](./sweep.md) — same idea, but a parameter grid on one symbol.
- [`backtest`](./backtest.md) — deep tearsheet for a single symbol.
- [`portfolio`](./portfolio.md) · [Command index](./README.md)
