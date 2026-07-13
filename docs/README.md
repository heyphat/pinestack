# pinerun command reference

`pinerun` is the CLI around the [piner](https://github.com/heyphat/piner) Pine
Script v6 engine: run one script across many symbols, timeframes, or parameter
combinations — in parallel, ranked, and deterministic. Install it with the
`curl | sh` one-liner in the [project README](../README.md#install), then:

```bash
pinerun --help
```

## Commands

| Command                           | One-liner                                                         |
| --------------------------------- | ----------------------------------------------------------------- |
| [`init`](./init.md)               | Scaffold a commented starter strategy.                            |
| [`scan`](./scan.md)               | Screen one script across N symbols, ranked.                       |
| [`backtest`](./backtest.md)       | Analyze one strategy on one symbol — a full tearsheet.            |
| [`compare`](./compare.md)         | Two strategies (or one, two ways) on the same bars, side by side. |
| [`portfolio`](./portfolio.md)     | One strategy across N symbols against ONE shared pot of capital.  |
| [`sweep`](./sweep.md)             | Optimize one script's input grid over one or more symbols.        |
| [`walkforward`](./walkforward.md) | Validate a swept edge out of sample (anti-overfitting).           |

## Shared flags

Data-source, credential, cache, execution, metrics, ranking, and input-grammar
flags are shared across the analysis commands and documented once in
[**common options**](./common-options.md). Each command page documents its own
flags in full and links there for the rest.

## Concepts

- [**How the portfolio model works**](./portfolio-model.md) — capital models
  (isolated vs shared), the union clock, per-bar execution order, and the exact
  identities behind the `portfolio` numbers.

## Typical flow

```bash
pinerun init strategy.pine                       # 1. scaffold
pinerun backtest strategy.pine --symbol BTCUSDT --tf 1h --limit 500   # 2. inspect on one symbol
pinerun sweep strategy.pine --symbol BTCUSDT --tf 1h --limit 500 \
  --input fast=5:20:5 --input slow=30:100:10 --top 10                 # 3. optimize
pinerun walkforward strategy.pine --symbol BTCUSDT --tf 1h --limit 2000 \
  --input fast=5:20:5 --input slow=30:100:10 --windows 5              # 4. validate OOS
pinerun scan strategy.pine --symbols BTCUSDT,ETHUSDT,SOLUSDT --tf 1h --limit 500   # 5. screen a universe
```

> The full narrative guide — architecture, concepts, programmatic API — lives in
> [`packages/pinerun/README.md`](../packages/pinerun/README.md). These pages are
> the per-command flag reference.
