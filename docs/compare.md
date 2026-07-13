# `pinerun compare`

> Compare: two strategies on the same bars, side by side.

`backtest` answers _"how good is this strategy?"_; `compare` answers _"which of these two?"_. It runs two scripts — or one script under two input sets — on the same symbol and bars, then prints a side-by-side metric table (A vs B columns) and an overlaid, normalized equity chart. Because equity is normalized to % return, strategies with different `initial_capital` values still compare fairly. Single-symbol, two-run only: no worker pool, no ranking.

## Synopsis

```bash
pinerun compare <a.pine> <b.pine> --symbol <sym> [options]
```

## Parameters

| Flag                              | Default           | Description                                                                                                                                                                   |
| --------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<a.pine> <b.pine>`               | — (both required) | The two scripts to compare. Pass the same path twice to compare one strategy under two different input sets (see `--input-a` / `--input-b`). Strategy scripts only.           |
| `--symbol <sym>`                  | — (required)      | The symbol both strategies run on. Fetched once and shared across both runs.                                                                                                  |
| `--input-a name=value`            | —                 | Fixed input override for script A, repeatable (one `name=value` per flag), validated against A's inputs. See [input syntax](./common-options.md#swept-input-grammar---input). |
| `--input-b name=value`            | —                 | Fixed input override for script B, repeatable — same grammar as `--input-a`, validated against B's inputs.                                                                    |
| `--label-a <l>` / `--label-b <l>` | script filenames  | Column and legend labels for A and B. Handy when both scripts are the same file distinguished only by their inputs.                                                           |
| `--no-chart`                      | off               | Skip the equity overlay; print the metric table only.                                                                                                                         |

## Common options

Plus shared flags — see [common options](./common-options.md):

- **Data:** `--tf` · `--from` · `--to` · `--limit` · `--provider` · `--asset-class` (+ [credentials](./common-options.md#credentials-equities-providers--alpaca--massive))
- **Execution:** `--backend` · `--no-security`
- **Cache:** `--no-cache` · `--cache-dir` · `--refresh`
- **Metrics:** `--periods-per-year` · `--risk-free-rate`
- **Output:** `--json`

## Output

Two blocks. First, a side-by-side metric table with an `A` and a `B` column
(headed by `--label-a` / `--label-b`, or the filenames), covering returns, risk,
and trade quality for both runs — net profit %, profit factor, max drawdown %,
sharpe, and so on.

Second, unless `--no-chart` is set, an overlaid equity chart. Both curves are
normalized to % return and drawn on one shared scale — **A cyan, B yellow** on a
TTY. Piped (non-TTY) output can't rely on color, so it prints two stacked
monochrome charts instead.

With `--json`, both sides are emitted as full `RunResult` reports (ledger and
equity curve included) for piping into other tools, instead of the table and
chart.

## Examples

Two different strategies on the same bars:

```bash
pinerun compare examples/sma-cross-param.pine examples/rsi-mean-reversion.pine \
  --symbol BTCUSDT --tf 1h --limit 500
```

Which prints the side-by-side metric table and the normalized equity overlay —
piped (non-TTY) output stacks the two curves instead of overlaying them in color:

```text
  compare: BTCUSDT @ 1h — 499 bars, 2026-06-21 → 2026-07-12

                               A: sma-cross-param  B: rsi-mean-reversion
    --------------------------------------------------------------------
    net profit                            -474.42                33.9226
    net profit %                           -4.74%                  0.34%
    profit factor                            0.62                   1.13
    win rate                               22.22%                 50.00%
    closed trades                               9                      2
    max drawdown %                          8.36%                  8.60%
    sharpe                                  -2.36                   0.35
    sortino                                 -1.51                   0.26
    calmar                                  -6.88                   0.71
    CAGR %                                -57.50%                  6.14%
    volatility %                           33.86%                 41.71%
    exposure %                             53.51%                 56.91%
    expectancy                           -52.7134                16.9613
    buy & hold %                            2.11%                  2.41%

  EQUITY %  A: sma-cross-param  (dashed = 0%)
   0.5% ┤⠤⠤⠤⠤⠤⠤⠤⠤⠤⡤  ⠤  ⠤  ⠤  ⠤  ⠤  ⠤  ⠤  ⠤  ⠤⢀⣀⡤⡼⢧⣤  ⠤  ⠤  ⠤  ⠤  ⠤  ⠤  ⠤
        │         ⡇                          ⢀⣸ ⠉⠁ ⠈⠉⠹⣄
        │         ⠳⠤⠤⣄                    ⢸⠓⣦⠞        ⠸⡄
        │            ⢸                  ⢠⣄⡏            ⠧⡄
        │            ⢸    ⢀⣠⡄           ⡞⠛              ⢹         ⣰⢲⣀⣠⢤⣤⡤
        │            ⠈⠉⠉⠹⣤⠞⠉⠳⠖⠒⠒⠒⢲⡏⢧   ⢰⠃               ⠘⠋⠙⢦     ⣰⠃⠈⠁  ⠈⠁
  -7.2% ┤                ⠉       ⠘⠃⠈⠉⠉⠉⠉                   ⠘⠒⠒⠒⠒⠚⠁
        └2026-06-21                 2026-07-01                 2026-07-12

  EQUITY %  B: rsi-mean-reversion  (dashed = 0%)
   1.2% ┤       ⣠⢤⡀                                     ⣤         ⣀⣀⣀⣀⣀⣀⣀
   0.0% ┤⠉⠉⠉⠉⠉⠉⠙⠃ ⡏  ⠉  ⠉  ⠉  ⠉  ⠉  ⠉  ⠉  ⠉  ⠉  ⠉  ⠉  ⠉⡞⢹⡭⠞⢳⠉  ⠉⢀⣸⠉  ⠉  ⠉
        │         ⢧ ⡼⣇                                 ⡇   ⠈⢧  ⡼⠉
        │         ⢸⡟⠃⢸    ⢀⣰⡆           ⢰⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠒⠃    ⠈⠿⢹⡇
        │         ⢸⡇ ⢸⢀⡼⣷⣶⠋⠉⠓⠚⠹⡄⣰⢲⡏⢧    ⡞
        │         ⠘⠃ ⠘⠚ ⠿      ⢹⡇⠘⠃⠈⢳ ⢠⣼⠁
  -6.7% ┤                           ⠸⠖⠋
        └2026-06-21                 2026-07-01                 2026-07-12

  in 14ms
```

One strategy under two parameterizations — same file passed twice, distinguished
by inputs and labels:

```bash
pinerun compare strat.pine strat.pine --symbol BTCUSDT --tf 1h \
  --input-a fast=5 --input-b fast=20 --label-a fast-5 --label-b fast-20
```

Table only, no equity overlay:

```bash
pinerun compare a.pine b.pine --symbol ETHUSDT --tf 1h --limit 500 --no-chart
```

Emit both runs as JSON for downstream processing:

```bash
pinerun compare a.pine b.pine --symbol BTCUSDT --tf 1h --limit 500 --json
```

## See also

- [`backtest`](./backtest.md) — full tearsheet for one strategy.
- [`sweep`](./sweep.md) — grid-search one script's inputs instead of hand-picking two.
- [Command index](./README.md)
