# `pinerun backtest`

> Analyze: one strategy on one symbol — a full tearsheet.

Where [`scan`](./scan.md) answers _"which symbols does this strategy work on?"_, `backtest` answers _"how good is this strategy, exactly?"_ — one Pine strategy script, one symbol, full detail. It is a single run (no worker pool) that prints a complete tearsheet: returns, risk, and trade quality, followed by MONTHLY RETURNS, TOP DRAWDOWNS, a TRADE P/L DISTRIBUTION histogram, and PRICE / EQUITY / DRAWDOWN charts. Indicator scripts are rejected with a pointer to `scan`; strategies only.

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
| `--no-chart`         | off          | Skip the in-terminal PRICE / EQUITY / DRAWDOWN charts and the trade P/L histogram. The MONTHLY RETURNS and TOP DRAWDOWNS tables always print.                                                                                |
| `--csv <dir>`        | —            | Write the trade ledger + equity curve as `<label>-trades.csv` / `<label>-equity.csv` into `<dir>`.                                                                                                                           |
| `--plot <dir>`       | —            | Write a self-contained `<label>.html` equity + drawdown chart into `<dir>`.                                                                                                                                                  |

The ledger and equity curve are **always** computed, so `--csv`, `--plot`, and `--json` need no extra flags (unlike `scan`).

## Common options

Plus shared flags — see [common options](./common-options.md):

- **Data:** `--tf` · `--from` · `--to` · `--limit` · `--provider` · `--asset-class` (+ [credentials](./common-options.md#credentials-equities-providers--alpaca--massive))
- **Execution:** `--backend` · `--no-security`
- **Cache:** `--no-cache` · `--cache-dir` · `--refresh`
- **Metrics:** `--periods-per-year` · `--risk-free-rate`
- **Output:** `--json`

## Output

The tearsheet prints in sections, in order:

1. **RETURNS** — net / gross profit (absolute and %), gross loss, buy & hold, outperformance, and CAGR.
2. **RISK** — max drawdown, max runup, annualized volatility, Sharpe, Sortino, Calmar, and market exposure.
3. **TRADES** — closed trades (W/L/E), win rate, profit factor, expectancy, avg and largest win/loss, max consecutive win/loss streaks, avg bars in trade, commission, and max contracts held.

Then three analysis tables (always printed, even with `--no-chart`):

- **MONTHLY RETURNS** — a year × month % grid, green/red on a TTY.
- **TOP DRAWDOWNS** — the five deepest episodes with peak / trough / recovery dates and durations; `—` + `>N` marks one still underwater.
- **TRADE P/L DISTRIBUTION** — a bucketed histogram of closed-trade profits (zero is always a bucket edge, so every bar is purely wins or purely losses).

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

Which prints the full tearsheet — returns, risk, and trade quality, then the
MONTHLY RETURNS grid, TOP DRAWDOWNS, the TRADE P/L DISTRIBUTION histogram, and
the PRICE / EQUITY / DRAWDOWN charts:

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
