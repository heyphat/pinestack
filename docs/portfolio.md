# `pinerun portfolio`

> Combine: one strategy across N symbols against ONE pot of capital.

Runs one strategy across a basket of symbols out of a single account. Each symbol's slice is a **sleeve**. The fetch fans out exactly like `scan`, then piner's `PortfolioEngine` drives N per-symbol engines on the union clock of all sleeves' bar times, reading back one portfolio equity curve, a merged symbol-tagged ledger, and a combined tearsheet. Two capital models select how sleeves share the pot: `isolated` (N sub-accounts; equals the per-symbol runs summed) and `shared` (one pot; sizing, funds checks, margin, and risk rules all read portfolio equity). For the full semantics and math, see [How the portfolio model works](./portfolio-model.md).

## Synopsis

```bash
pinerun portfolio <script.pine> --symbols <a,b,c> [options]
```

## Parameters

| Flag                 | Default             | Description                                                                                                                                                                          |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--symbols a,b,c`    | —                   | Basket in PRIORITY order — at equal timestamps earlier symbols fill first (spec S4). Supports full [instrument addresses](./common-options.md#symbol-addressing).                    |
| `--universe <file>`  | —                   | Read the basket from a file, one symbol per line (blank lines and `#` comments ignored). Alternative to `--symbols`.                                                                 |
| `--mode <m>`         | `isolated`          | Capital model — `isolated` or `shared`. See [Capital models](#capital-models---mode).                                                                                                |
| `--capital <P>`      | N × initial_capital | Total pot. Defaults to N times the script's `initial_capital`.                                                                                                                       |
| `--weights s=f,...`  | equal               | Per-symbol funding fractions, **isolated mode only** (e.g. `BTCUSDT=0.5,ETHUSDT=0.3,SOLUSDT=0.2`). Normalized; default equal-weight.                                                 |
| `--input name=value` | —                   | Fixed input override applied to every sleeve. One value each; **repeatable** (pass the flag once per input).                                                                         |
| `--trades`           | off                 | Also print the merged, symbol-tagged ledger. Over 20 trades elide to the first/last 5 rows.                                                                                          |
| `--no-chart`         | off                 | Skip the in-terminal equity/drawdown/sleeve charts and the trade P/L histogram. MONTHLY RETURNS, TOP DRAWDOWNS, and the isolated-mode SLEEVE RETURN CORRELATION matrix always print. |
| `--csv <dir>`        | —                   | Write `portfolio-trades.csv` + `portfolio-equity.csv` plus per-sleeve CSVs into `<dir>`.                                                                                             |
| `--plot <dir>`       | —                   | Write `portfolio.html` plus per-sleeve equity/drawdown charts into `<dir>`.                                                                                                          |

### Capital models (`--mode`)

- **`isolated`** (default) — N sub-accounts, each funded `wᵢ·P`. This equals running each symbol standalone and summing the equity curves; it is the equal-weight (or, with `--weights`, weighted-allocation) baseline. The engine reproduces that per-symbol sum bit-for-bit.
- **`shared`** — ONE pot. `percent_of_equity` sizing, funds checks, margin, and `strategy.risk.*` rules all read **portfolio** equity, and sleeves compete for capital in basket (priority) order at each timestamp. This is a genuinely different backtest: one symbol's gains fund another's next entry, and an order can be rejected because an earlier sleeve already spent the cash. Trades can differ from any per-symbol run.

A symbol that fails to fetch is dropped with a warning; under `shared` mode a smaller basket is a _different_ backtest, so the drop is called out loudly. Strategy scripts only.

## Common options

Plus shared flags — see [common options](./common-options.md):

- **Data:** `--tf` · `--from` · `--to` · `--limit` · `--provider` · `--asset-class` (+ [credentials](./common-options.md#credentials-equities-providers--alpaca--massive))
- **Execution:** `--backend` · `--concurrency` · `--no-security`
- **Cache:** `--no-cache` · `--cache-dir` · `--refresh`
- **Metrics:** `--periods-per-year` · `--risk-free-rate`
- **Output:** `--json`

## Output

The terminal report opens with a combined tearsheet — RETURNS, RISK, and TRADES blocks computed on the portfolio equity curve and merged ledger — followed by a per-sleeve contribution table (`SYMBOL`, `FUNDING`, `NET P/L`, `TRADES`, `CONTRIB%`, `RET-CORR`). `RET-CORR` is each sleeve's per-bar return correlation with the portfolio in `isolated` mode (a diversification read); it reads `na` in `shared` mode, where every sleeve samples the one pot.

The tearsheet also prints **MONTHLY RETURNS** and **TOP DRAWDOWNS**, plus — for an isolated-mode basket of two or more sleeves — the **SLEEVE RETURN CORRELATION** matrix of every pairwise per-bar return correlation (skipped in `shared` mode, where every pair reads 1.00). Unless `--no-chart` is set, it ends with in-terminal charts: the combined equity curve (braille line with a dashed initial-capital guide), the underwater drawdown, one cumulative-P/L sparkline per sleeve, and the trade P/L histogram — plain unicode, safe to pipe.

**Portfolio drawdown/run-up are close-to-close** on the combined curve in both modes: the sleeves' worst intrabar moments don't coincide and cross-symbol intrabar paths are unknowable, so this is the honest number. Per-sleeve reports keep their own intrabar extremes. There is no buy-&-hold benchmark — it's meaningless for a basket.

**Artifacts.** `--csv <dir>` writes `portfolio-equity.csv` (its `bar` column is the master clock) and `portfolio-trades.csv` (symbol-tagged, exit-time sorted; its `entryBar`/`exitBar` are _sleeve-local_ indices, so join trades to the combined curve on `entryTime`/`exitTime`) plus per-sleeve `<SYMBOL>-equity.csv`/`<SYMBOL>-trades.csv`. `--plot <dir>` writes `portfolio.html` plus per-sleeve equity/drawdown charts.

**JSON.** `--json` emits the full `PortfolioReport` instead of the tearsheet: `equityCurve` and `times` (master clock), `initialCapital`, `summary`, `metrics`, `trades` (merged, symbol-tagged), `sleeves` (contribution), `fetchErrors` (dropped symbols), `mode`, and `elapsedMs`.

## Examples

Isolated baseline (default) — N equal-weight sub-accounts; equals running each symbol standalone and summing the curves, with `RET-CORR` reading diversification:

```bash
pinerun portfolio examples/sma-cross-param.pine \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT --tf 1h --limit 500
```

Which prints the combined tearsheet, the per-sleeve contribution table, the
sleeve-correlation matrix, and the equity / drawdown / per-sleeve charts:

```text
  portfolio: 3 symbols @ 1h — mode=isolated, 30000.00 initial, 2026-06-21 → 2026-07-12

  RETURNS
    net profit                 -969.60      -3.23%
    gross profit               3169.21      10.56%
    gross loss                 4138.81      13.80%
    CAGR                                   -43.92%

  RISK
    max drawdown               2824.37       9.36%
    max runup                  3508.08      12.82%
    volatility (annual)                     39.62%
    sharpe                       -1.26
    sortino                      -0.95
    calmar                       -4.69
    exposure                                63.13%
    (portfolio drawdown/run-up are close-to-close on the combined curve)

  TRADES
    closed trades                   29 (8W 21L 0E)
    win rate                                27.59%
    profit factor                 0.77
    expectancy                -33.4346
    avg win / loss        396.15 / 197.09
    commission paid             0.0000
    margin calls                     0

  SYMBOL               FUNDING     NET P/L  TRADES  CONTRIB%  RET-CORR
  --------------------------------------------------------------------
  BTCUSDT           10000.00     -474.42       9      48.9      0.91
  ETHUSDT           10000.00     -119.68       9      12.3      0.93
  SOLUSDT           10000.00     -375.51      11      38.7      0.89

  SLEEVE RETURN CORRELATION
             BTCUSDT  ETHUSDT  SOLUSDT
    BTCUSDT     1.00     0.87     0.68
    ETHUSDT     0.87     1.00     0.70
    SOLUSDT     0.68     0.70     1.00

  MONTHLY RETURNS %
            JAN    FEB    MAR    APR    MAY    JUN    JUL    AUG    SEP    OCT    NOV    DEC     YEAR
    2026      ·      ·      ·      ·      ·   -6.3    3.2      ·      ·      ·      ·      ·     -3.2

  TOP DRAWDOWNS
     #   DEPTH%  PEAK        TROUGH      RECOVERY     BARS
    ------------------------------------------------------
     1   -9.36%  2026-06-24  2026-06-25  2026-07-03    215
     2   -6.83%  2026-07-04  2026-07-09  —            >183
     3   -0.90%  2026-07-04  2026-07-04  2026-07-04     11
     4   -0.82%  2026-07-03  2026-07-04  2026-07-04      8
     5   -0.59%  2026-07-03  2026-07-03  2026-07-03      5

  TRADE P/L DISTRIBUTION
       857.56 → 1,029  ▇▇▇▇ 1
      686.05 → 857.56  ▇▇▇▇ 1
      514.54 → 686.05  ▇▇▇▇ 1
      343.03 → 514.54   0
      171.51 → 343.03  ▇▇▇▇▇▇▇▇▇▇▇ 3
        0.00 → 171.51  ▇▇▇▇▇▇▇ 2
       -154.77 → 0.00  ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇ 8
    -309.54 → -154.77  ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇ 11
    -464.30 → -309.54  ▇▇▇▇▇▇▇ 2

  EQUITY  30000.00 → 29030.40  (dashed = initial capital)
  30,864 ┤                                     ⢠⣤⡄⡖⢦⣤⣀⣀
         │                                    ⢀⣸ ⠉⠁   ⠸⢤
  30,000 ┤⠤⠤⠤⠤⠤⠤⠤⠤⠤⡤  ⠤  ⠤  ⠤  ⠤  ⠤  ⠤  ⠤  ⢴⣆⡀⡼  ⠤  ⠤  ⠼⣆⡀⠤  ⠤  ⠤  ⠤  ⠤  ⠤
         │         ⢧                       ⢸⠉⠉⠁          ⢹⣀        ⢀⣀   ⣀
         │         ⢸⣀⣀⡀                    ⡼             ⠘⠋⠹⣄     ⢠⠞⢸⡤⠖⠚⢹
         │            ⢳                  ⣰⣦⠇                ⠘⠒⠒⠒⠒⠦⠞     ⠘⠋
         │            ⢸    ⢀⣸⡇     ⡟⡆    ⡇
         │            ⢸  ⢸⠙⠋⠉⠧⠤⠤⡄⣀⣤⡇⠙⠦⠤⢤⣸⠁
         │            ⠈⠉⠉⠛      ⠙⠃
  27,356 ┤
         └2026-06-21                 2026-07-01                 2026-07-12

  DRAWDOWN (close-to-close)
      0% ┤⠉⠉⠉⠉⠉⠉⠉⠉⠉⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠿⠿⠋⠋⠉⠛⠉⠻⠛⠛⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
         │         ⠘⠛⠛⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⣿⠃           ⠈⠛⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
         │            ⢸⣿⣿⡿⠿⠟⠏⣿⣿⣿⣿⣿⣿⠉⠿⣿⣿⣿⡿                ⠈⠈⠘⠻⠿⠿⠿⠿⠿⠏⠁⠘⠉⠉⠉⠸⠻
  -9.36% ┤               ⠁      ⠉

  SLEEVE cum P/L (closed trades)
  BTCUSDT  ██████▅▅▂▂▂▂▂▂▂▂▂▁▁▁▁▁▁▁▁▁███▄▂▂▁▁▁▁▁▁▁▃      -474.42
  ETHUSDT  ▆▆▆▆▆▆▄▄▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁██▇▇▆▄▄▄▄▄▄▄▄▅      -119.68
  SOLUSDT  ▆▆▆▆▆▆▃▃▁▁▁▁▂▂▂▁▁▂▂▂▂▂▂▂▂███▇▇▆▅▅▅▅▅▅▅▅▃      -375.51

  3/3 sleeves combined  annualized at 8766.00 periods/yr  in 17ms
```

Shared pot — one account, sleeves compete for capital in basket (priority) order:

```bash
pinerun portfolio examples/sma-cross-param.pine \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT --tf 1h --limit 500 --mode shared --capital 30000
```

Weighted isolated — fund BTC 50%, ETH 30%, SOL 20% of the pot (normalized):

```bash
pinerun portfolio examples/sma-cross-param.pine \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT --tf 1h --limit 500 \
  --capital 30000 --weights BTCUSDT=0.5,ETHUSDT=0.3,SOLUSDT=0.2
```

Basket from a universe file with a fixed input override applied to every sleeve:

```bash
pinerun portfolio examples/sma-cross-param.pine \
  --universe universe.txt --tf 1d --limit 365 --input fast=10 --input slow=50
```

Merged ledger plus CSV/HTML exports (`portfolio-*.csv`, `portfolio.html`, per-sleeve files):

```bash
pinerun portfolio examples/sma-cross-param.pine \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT --tf 1h --limit 500 --mode shared \
  --trades --csv out/ --plot out/
```

JSON — full report (`equityCurve`, `summary`, `metrics`, `sleeves`, `fetchErrors`) for piping:

```bash
pinerun portfolio examples/sma-cross-param.pine \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT --tf 1h --limit 500 --mode shared --json
```

## See also

- [How the portfolio model works](./portfolio-model.md) — the capital models, union clock, and math in detail.
- [`backtest`](./backtest.md) — single-symbol tearsheet (a portfolio sleeve in isolation).
- [`scan`](./scan.md) — screen symbols independently instead of pooling capital.
- [Command index](./README.md)
