# `pinerun backtest`

> Analyze: one strategy on one symbol — a full tearsheet.

Where [`scan`](./scan.md) answers _"which symbols does this strategy work on?"_, `backtest` answers _"how good is this strategy, exactly?"_ — one Pine strategy script, one symbol, full detail. It is a single run (no worker pool) that prints a complete tearsheet: returns, risk, and trade quality, followed by MONTHLY RETURNS, MONTHLY TRADES, TOP DRAWDOWNS, a TRADE P/L DISTRIBUTION histogram, and PRICE / EQUITY / DRAWDOWN charts. Indicator scripts are rejected with a pointer to `scan`; strategies only.

## Synopsis

```bash
pinerun backtest <script.pine> --symbol <sym> [options]
```

## Parameters

| Flag                 | Default      | Description                                                                                                                                                                                                                  |
| -------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--symbol <sym>`     | — (required) | Single symbol to backtest. A bare ticker or full instrument address (see [symbol addressing](./common-options.md#symbol-addressing)).                                                                                        |
| `--input name=value` | —            | Fixed input override, repeatable, one value each (grids → [`sweep`](./sweep.md)). Validated against the script's `input()` titles before anything runs. See [input syntax](./common-options.md#swept-input-grammar---input). |
| `--trades`           | off          | Also print the closed-trade ledger under the tearsheet. More than 20 trades elide to the first and last 5 rows.                                                                                                              |
| `--watch [sec]`      | `60` (min 5) | Live mode: refresh history, rerun, and redraw the tearsheet in place every `<sec>` seconds. Requires a live terminal (refuses when piped); Ctrl-C exits. Incompatible with `--json`.                                         |
| `--no-chart`         | off          | Skip the in-terminal PRICE / EQUITY / DRAWDOWN charts and the trade P/L histogram. The MONTHLY RETURNS, MONTHLY TRADES, and TOP DRAWDOWNS tables always print.                                                               |
| `--csv <dir>`        | —            | Write the trade ledger + equity curve as `<label>-trades.csv` / `<label>-equity.csv` into `<dir>`.                                                                                                                           |
| `--plot <dir>`       | —            | Write a self-contained `<label>.html` equity + drawdown chart into `<dir>`.                                                                                                                                                  |

The ledger and equity curve are **always** computed, so `--csv`, `--plot`, and `--json` need no extra flags (unlike `scan`).

With Bar Magnifier requested, metadata and the complete exact/static-security
plan must resolve before execution. A permanent exact-mode failure is emitted as
a typed failed `RunResult`; live `--watch` stops instead of retrying an
unsupported configuration forever. The shipped self-contained binary pins the
contract-capable `@heyphat/piner` 0.11.1 engine: after exact preparation, piner
is the authority for active/inactive state, coverage, counters, and fills.

## Common options

Plus shared flags — see [common options](./common-options.md):

- **Data:** `--tf` · `--from` · `--to` · `--limit` · `--provider` · `--asset-class` · `--data-dir` · `--csv-alignment` · `--csv-week-anchor` · `--csv-calendar` · `--csv-complete-record` ([exact CSV](./csv-data.md#exact-acquisition-and-bar-magnifier)) (+ [credentials](./common-options.md#credentials-equities-providers--alpaca--massive))
- **Execution:** `--backend` · `--no-security`
- **Cache:** `--no-cache` · `--cache-dir` · `--refresh`
- **Broker:** `--mintick` · `--min-qty` · `--calc-on-order-fills` / `--no-calc-on-order-fills` ([fill model](./common-options.md#fill-model--calc_on_order_fills)) · `--bar-magnifier` / `--no-bar-magnifier` ([Bar Magnifier](./common-options.md#fill-model--bar-magnifier))
- **Metrics:** `--periods-per-year` · `--risk-free-rate`
- **Output:** `--json`

## Output

The tearsheet prints in sections, in order:

1. **RETURNS** — net / gross profit (absolute and %), gross loss, buy & hold, outperformance, and CAGR.
2. **RISK** — max drawdown, max runup, annualized volatility, Sharpe, Sortino, Calmar, and market exposure.
3. **TRADES** — closed trades (W/L/E), win rate, profit factor, expectancy, avg and largest win/loss, max consecutive win/loss streaks, avg bars in trade, commission, and max contracts held.

Then the analysis tables (always printed, even with `--no-chart`):

- **MONTHLY RETURNS** — a year × month % grid, green/red on a TTY.
- **MONTHLY TRADES** — the same year × month grid tallying closed trades by
  exit month in win/loss/even order: `5/3`, or `5/2/1E` when a month has
  break-even trades (zero tallies are omitted, so all-even is `3E`). Wins are
  green and losses red on a TTY; evens keep their `E` suffix because they have
  no color. The YEAR column totals the row.
- **TOP DRAWDOWNS** — the five deepest episodes with peak / trough / recovery dates and durations; `—` + `>N` marks one still underwater.

And a **TRADE P/L DISTRIBUTION** — a bucketed histogram of closed-trade profits (zero is always a bucket edge, so every bar is purely wins or purely losses). It is a drawing, so `--no-chart` skips it like the charts below.

Then three in-terminal charts (skipped with `--no-chart`):

- **PRICE** — the close series as a braille line with every trade marked at its actual fill price: `▲` long entry / `▼` short entry, `●` winning exit / `○` losing exit, colored green/red on a TTY (piped output stays plain unicode — the glyphs carry the same information).
- **EQUITY** — braille line with a dashed initial-capital guide and a date axis.
- **DRAWDOWN** — an underwater strip.

**Artifacts:** `--csv <dir>` exports the ledger and equity curve as CSV, `--plot <dir>` writes a self-contained `<label>.html` (equity curve with an initial-capital guide + drawdown), and `--json` emits the full `RunResult` (with `result.trades`, `result.equityCurve`, `result.barTimes`, and `result.closes` attached). None require `--trades`.

## Examples

Basic backtest of a strategy on one symbol over 500 hourly bars:

```bash
pinerun backtest examples/sma-cross-param.pine --symbol SOLUSDT --tf 1h --limit 500
```

Run a source-requested Bar Magnifier strategy over exact UTC CSV files (for
example `BTCUSDT_1h.csv` plus its mapped lower-timeframe file):

```bash
pinerun backtest strategy.pine --symbol CSV:BTCUSDT --tf 1h \
  --data-dir ./data --csv-alignment utc-24x7
```

Add `--csv-complete-record` only when the producer guarantees that missing rows
inside each exact file's full span mean no trades; the bars-only default treats
those rows as coverage gaps.

Which prints the full tearsheet — returns, risk, and trade quality, then the
MONTHLY RETURNS and MONTHLY TRADES grids, TOP DRAWDOWNS, the TRADE P/L
DISTRIBUTION histogram, and the PRICE / EQUITY / DRAWDOWN charts:

```text
  backtest: SOLUSDT @ 1h — 499 bars, 2026-06-21 → 2026-07-12

  RETURNS
    net profit                 -375.51      -3.76%
    gross profit               1120.47      11.20%
    gross loss                 1495.98      14.96%
    buy & hold                              10.55%
    outperformance            -1430.56
    CAGR                                   -49.02%

  RISK
    max drawdown               1155.02      11.38%
    max runup                  1581.00      17.57%
    volatility (annual)                     52.12%
    sharpe                       -1.03
    sortino                      -0.73
    calmar                       -4.31
    exposure                                51.10%

  TRADES
    closed trades                   11  (3W 8L 0E)
    win rate                                27.27%
    profit factor                 0.75
    expectancy                -34.1368
    avg win / loss        373.49 / 187.00
    largest win / loss    851.54 / -384.98
    max consecutive       2 win / 5 loss
    avg bars in trade            23.18
    commission paid             0.0000
    max contracts held          144.13

  MONTHLY RETURNS %
            JAN    FEB    MAR    APR    MAY    JUN    JUL    AUG    SEP    OCT    NOV    DEC     YEAR
    2026      ·      ·      ·      ·      ·   -4.9    1.2      ·      ·      ·      ·      ·     -3.8

  MONTHLY TRADES  (win/loss/E even)
            JAN    FEB    MAR    APR    MAY    JUN    JUL    AUG    SEP    OCT    NOV    DEC     YEAR
    2026      ·      ·      ·      ·      ·    1/5    2/3      ·      ·      ·      ·      ·      3/8

  TOP DRAWDOWNS
     #   DEPTH%  PEAK        TROUGH      RECOVERY     BARS
    ------------------------------------------------------
     1  -10.32%  2026-06-24  2026-06-25  2026-07-02    191
     2   -8.48%  2026-07-04  2026-07-12  —            >196
     3   -2.27%  2026-07-02  2026-07-03  2026-07-03     32
     4   -0.93%  2026-07-03  2026-07-04  2026-07-04      7
     5   -0.62%  2026-06-24  2026-06-24  2026-06-24      3

  TRADE P/L DISTRIBUTION
      709.62 → 851.54  ▇▇▇▇▇▇▇▇▇▇ 1
      567.69 → 709.62   0
      425.77 → 567.69   0
      283.85 → 425.77   0
      141.92 → 283.85  ▇▇▇▇▇▇▇▇▇▇ 1
        0.00 → 141.92  ▇▇▇▇▇▇▇▇▇▇ 1
       -128.33 → 0.00  ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇ 4
    -256.65 → -128.33  ▇▇▇▇▇▇▇▇▇▇ 1
    -384.98 → -256.65  ▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇▇ 3

  PRICE  (close · ▲ long / ▼ short entry · ● win / ○ loss exit)
  83.48 ┤                                     ⢠⠼⢧●⡀  ▲ ⢀▲ ▲
        │                                 ⢸⠷⠦⠞⠉ ⠈⠁⠹⠤⠟⠛○⠏⠘○○⢳
        │                               ⢠⣄⡏                ⠘⣆  ▲⣀⣰⠒⢲○⣀▲⣀
        │                              ⢀⡏                   ⠈⠓⠛⠃   ⠈⠉⠁ ○⡤
        │⣀⡀                       ⡟⢦⡀ ▲⠋
        │ ⠛⠉⠙⢦          ⢠⢶⣀⣠⡄ ▲⡀▲⠞⠁ ●⠋⠁
        │    ⠈⢳ ⢀⣀     ▲⣸  ⠉●⠴⠃⢧○
        │     ⠘⠲⠞▲⢦ ▲⣆ ⣸⠿
        │         ○⡏⠁○⣸⠁
  64.23 ┤         ⠘⠃
        └2026-06-21                 2026-07-01                 2026-07-12

  EQUITY  (dashed = initial capital)
  10,516 ┤                                     ⢀⣸⡇
         │                                 ⢠⡄ ⢠⠼⠉⠹⠏⠉⠉⠉⢳⣀
         │                                 ⢸⠓⠲⠏        ⠸⠤⢤         ⣀⡀
  10,000 ┤⠒⠒⠒⠒⠒⠒⠒⠒⠲⣖  ⠒  ⠒  ⠒  ⠒  ⠒  ⠒  ⠒  ⡞  ⠒  ⠒  ⠒  ⠒ ⠘⠛⢻⣀⣒⣀⣀⣒⣀⣸⠓⢹ ⠒  ⠒
         │         ⢸               ⣀     ⣰⠲⠇                        ⠘⠋⠉⠙⢻
         │         ⠘⠒⠒⡆  ⢀⣶⣀⣰⡆     ⡏⢧    ⡇                              ⢸⣀
         │            ⢹  ⢸⠘⠃⠛⣇⣀⣀⡀ ⣰⠃⠈⠳⠤⢤⡴⠃
         │            ⢸⣀⣀⢸      ⣇⡶⠇
         │              ⠈⣿      ⠘⠃
   9,024 ┤
         └2026-06-21                 2026-07-01                 2026-07-12

  DRAWDOWN (close-to-close)
      0% ┤⠉⠉⠉⠉⠉⠉⠉⠉⠉⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠻⣿⣿⡟⠋⠋⢿⠿⠿⠿⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
         │         ⠘⠛⠛⣿⣿⣿⡿⢻⠿⡟⣿⣿⣿⣿⣿⣿⠙⢿⣿⣿⣿⣿⠁            ⠈⠙⠛⢻⢿⣿⣿⣿⣿⣿⣿⣿⡿⠿⢿⣿⣿⣿⣿⣿
         │            ⢸⣿⣿⡇   ⠋⠉⠉⣿⠻⠁  ⠈⠉⠉⠁                  ⠈⠉⠉⠉⠉⠉⠉⠁ ⠘⠉⠉⠙⢻⣿
  -10.3% ┤               ⠃      ⠈                                       ⠈⠉

  initial capital 10000.00 · annualized at 8766.00 periods/yr · in 20ms
```

Write a self-contained HTML equity + drawdown chart to `out/`:

```bash
pinerun backtest examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h --limit 500 --plot out/
```

Override inputs (validated against the script) and print the trade ledger:

```bash
pinerun backtest examples/sma-cross-param.pine --symbol SOLUSDT --tf 1h \
  --input fast=10 --input slow=50 --trades
```

Live paper-trading dashboard — refresh and redraw every 30 seconds:

```bash
pinerun backtest examples/sma-cross-param.pine --symbol SOLUSDT --tf 1h --watch 30
```

Export the ledger and equity curve as CSV:

```bash
pinerun backtest examples/sma-cross-param.pine --symbol SOLUSDT --tf 1h --limit 500 --csv out/
```

Emit the full result as JSON and pipe into `jq`:

```bash
pinerun backtest examples/sma-cross-param.pine --symbol SOLUSDT --tf 1h --json | jq '.strategy'
```

## See also

- [`compare`](./compare.md) — two strategies side by side on the same bars.
- [`sweep`](./sweep.md) — optimize the inputs. · [`walkforward`](./walkforward.md) — validate OOS.
- [Command index](./README.md)
