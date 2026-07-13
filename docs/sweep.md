# `pinerun sweep`

> Optimize: one script's input grid, over one or more symbols.

Runs one script across a cartesian grid of `input()` values — parameter optimization. Each combo becomes a job whose inputs override the script's `input(...)` values **by title**, run in parallel and ranked. Pass several symbols and the grid widens to `symbols × combos` — the symbol becomes an implicit axis, with bars fetched once per symbol. Same fan-out core as [`scan`](./scan.md); only the job generation differs.

Any hardcoded constant you want to sweep must first be lifted into an `input(...)` whose title matches the `--input` name.

## Synopsis

```bash
pinerun sweep <script.pine> --symbol <sym> --input <name=spec> ... [options]
```

## Parameters

| Flag                  | Default                       | Description                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--symbol <sym>`      | —                             | Single symbol to grid over.                                                                                                                                                                                                                                                                                                                                                 |
| `--symbols a,b,c`     | —                             | Multi-symbol grid; every combo runs on every symbol. Symbol becomes an implicit axis (adds a `SYMBOL` column); bars fetched once per symbol, a failed fetch is reported (`fetchErrors`) and skipped without sinking the rest. [Instrument addresses](./common-options.md#symbol-addressing) supported.                                                                      |
| `--universe <file>`   | —                             | File of symbols for the multi-symbol grid, one per line (blank lines and `#` comments ignored).                                                                                                                                                                                                                                                                             |
| `--input name=spec`   | —                             | Swept axis, repeatable. `spec` is a list (`fast=5,10,20`), a range (`slow=30:100:10` = `start:stop:step`), or a mix (`len=5,10:20:5`); also booleans (`useStop=true,false`) and quoted literals (`sess="'09:30'"`). Each `name` must match a Pine `input()` title — validated before any fetch. See [Swept input grammar](./common-options.md#swept-input-grammar---input). |
| `--sample <n>`        | exhaustive                    | Smart search: run `n` randomly sampled distinct combos instead of the full grid, so a huge grid stays tractable. The `--max-combos` guard then applies to `n`, not the grid.                                                                                                                                                                                                |
| `--seed <n>`          | `42`                          | PRNG seed for `--sample`; deterministic — the same seed reruns the same combos.                                                                                                                                                                                                                                                                                             |
| `--heatmap`           | off                           | Print the 2-axis optimization surface as a value grid (requires exactly two `--input` axes; missing / sampled-out cells print `·`; one grid per symbol on a multi-symbol sweep; cells grade red → green by value on a TTY).                                                                                                                                                 |
| `--points-csv <file>` | —                             | Write EVERY run as one CSV row (symbol, axes, value, strategy stats, error) — the whole surface, pandas-ready; cheap (no ledgers, unlike `--csv`).                                                                                                                                                                                                                          |
| `--rank <spec>`       | `strategy.netProfit` / `last` | Metric to optimize; strategies default to `strategy.netProfit`, indicators to `last`. See [Ranking spec](./common-options.md#ranking-spec---rank).                                                                                                                                                                                                                          |
| `--top <n>`           | —                             | Keep only the top `n` combos after ranking.                                                                                                                                                                                                                                                                                                                                 |
| `--asc`               | descending                    | Sort ascending instead of descending.                                                                                                                                                                                                                                                                                                                                       |
| `--trades`            | off                           | Attach ledger + equity curve; adds an `EQUITY` sparkline column and prints the winning combo's PRICE chart + ledger.                                                                                                                                                                                                                                                        |
| `--csv <dir>`         | —                             | Per ranked combo CSV export (trades + equity), labeled `<symbol>-<combo>`. Implies `--trades`.                                                                                                                                                                                                                                                                              |
| `--plot <dir>`        | —                             | Per ranked combo HTML equity/drawdown chart, labeled `<symbol>-<combo>`. Implies `--trades`.                                                                                                                                                                                                                                                                                |
| `--no-chart`          | off                           | Skip the table sparklines and the winning combo's PRICE chart.                                                                                                                                                                                                                                                                                                              |
| `--max-combos <n>`    | `5000`                        | Cap on total runs: combos × symbols. Checked before any fetch.                                                                                                                                                                                                                                                                                                              |

## Common options

Plus shared flags — see [common options](./common-options.md):

- **Data:** `--tf` · `--from` · `--to` · `--limit` · `--provider` · `--asset-class` (+ [credentials](./common-options.md#credentials-equities-providers--alpaca--massive))
- **Execution:** `--backend` · `--concurrency` · `--workers` · `--no-security`
- **Cache:** `--no-cache` · `--cache-dir` · `--refresh`
- **Metrics:** `--periods-per-year` · `--risk-free-rate`
- **Output:** `--json`

## Output

The default output is a **ranked table** with one row per combo and one column per swept axis (an indicator sweep prints a single `VALUE` column), followed by the backtest stats and a footer echoing the rank spec and run counts. A multi-symbol sweep adds a `SYMBOL` column and ranks across all symbols. With `--trades` the table gains an `EQUITY` sparkline column and the winning combo's PRICE chart + ledger print below.

`--heatmap` prints the 2-axis surface below the table: the first axis down the rows, the second across the columns, the ranked metric in each cell. Failed or sampled-out cells show `·`; on a TTY cells grade red → yellow → plain → green → bright green by value quintile (so a broad green plateau stands out from a lucky spike), while piped output stays plain. One grid per symbol on a multi-symbol sweep.

`--points-csv <file>` writes every run (not just the ranked top) as one row — symbol, a column per axis, the ranked value, the strategy summary block, and the error for failed runs — needing no trade ledgers, so it is cheap on huge grids and pivots straight into pandas / Excel. `--csv` / `--plot` write per-combo artifacts labeled `<symbol>-<combo>`.

`--json` emits the full report instead of the table, including `symbols`, `combos`, `gridTotal`, `sample`, and per-point fields (with the `symbol` on each point).

The `--max-combos` guard (default `5000`) counts `combos × symbols` and fails fast before any fetch; an oversized exhaustive grid is rejected with a suggestion to use `--sample`.

## Examples

Basic 2-axis grid on one symbol, keeping the top 10 combos:

```bash
pinerun sweep examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h --limit 500 \
  --input fast=5,10,15,20 --input slow=30:100:10 --top 10
```

Which prints the ranked grid (one row per combo, one column per swept axis):

```text
  sweep: BTCUSDT — 32 runs, ranked by strategy.netProfit (fast × slow)

  #  fast  slow       NET P/L      NET %  TRADES    WIN%    MAXDD%       PF   SHARPE
  ----------------------------------------------------------------------------------
   1   20    30        391.91      3.92%      10  60.00%     5.98%     1.54     2.52
   2   20    90        384.33      3.84%       3  100.00%     4.57%      inf     3.80
   3   10   100        309.80      3.10%       2  50.00%     4.21%     3.90     3.10
   4    5    50        258.01      2.58%       7  28.57%     3.78%     1.68     2.14
   5   20    80        194.16      1.94%       2  50.00%     4.57%     2.09     2.49
   6   20    70        189.30      1.89%       2  50.00%     4.57%     2.15     2.34
   7    5    60        187.11      1.87%       6  33.33%     4.61%     1.53     1.57
   8   20   100        165.33      1.65%       2  50.00%     4.57%     2.17     2.34
   9   15   100        118.32      1.18%       2  50.00%     4.61%     1.85     1.77
  10   15    90       94.6279      0.95%       3  33.33%     4.73%     1.61     1.56

  32/32 ran  10 ranked  in 93ms
```

Multi-symbol grid, heatmap, and full-surface CSV in one run:

```bash
pinerun sweep examples/sma-cross-param.pine --symbols BTCUSDT,ETHUSDT --tf 1h --limit 500 \
  --input fast=5:20:5 --input slow=30:100:10 --heatmap --points-csv out/points.csv
```

Smart search — an 11k-combo grid sampled down to 50 runs:

```bash
pinerun sweep examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h --limit 500 \
  --input fast=2:60 --input slow=10:200 --sample 50 --top 10
```

Reproducible sample — the same `--seed` always picks the same combos:

```bash
pinerun sweep examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h --limit 500 \
  --input fast=2:60 --input slow=10:200 --sample 10 --seed 7
```

Multi-symbol heatmap — one grid per symbol:

```bash
pinerun sweep examples/sma-cross-param.pine --symbols BTCUSDT,ETHUSDT --tf 1h --limit 500 \
  --input fast=5,10,15 --input slow=30,50 --heatmap
```

Budget guard — 4 combos × 2 symbols = 8 runs exceeds the cap, so this fails fast before any fetch:

```bash
pinerun sweep examples/sma-cross-param.pine --symbols BTCUSDT,ETHUSDT --tf 1h \
  --input fast=5,10 --input slow=30,50 --max-combos 5
```

## See also

- [`walkforward`](./walkforward.md) — the anti-overfitting counterpart (validates the swept winner OOS).
- [`backtest`](./backtest.md) — deep-dive a single chosen combo. · [`scan`](./scan.md)
- [Command index](./README.md)
