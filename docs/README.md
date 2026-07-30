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
| [`upgrade`](./upgrade.md)         | Update pinerun to the latest release, in place.                   |

`pinetop` has the same `upgrade` verb for itself (`pinetop upgrade [--check]`).

## Forward testing

[`pinelive`](./pinelive.md) consumes pinery `MarketDataProvider` closed bars,
advances piner, and reconciles one resolved exact contract through PaperBroker or
a broker adapter.

> **Source-only:** the GitHub release installer provides `pinerun`, not
> `pinelive`. Pinelive is not published to npm and has no prebuilt release asset.
> From a checkout, invoke it with
> `bun packages/pinelive/src/cli.ts run --config <path>`. The
> [pinelive package README](../packages/pinelive/README.md#paper-quick-start)
> contains a runnable Paper/CSV example.

Broker implementers should read the
[adapter contract](./pinelive-adapter-contract.md). The permanent
[`feat/pinelive` audit and remediation record](./feat-pinelive-audit.md)
documents confirmed findings, offline validation evidence, Tiger readiness
limits, and the remaining mainline integration action.

## Shared flags

Data-source, credential, cache, execution, metrics, ranking, and input-grammar
flags are shared across the analysis commands and documented once in
[**common options**](./common-options.md). Each command page documents its own
flags in full and links there for the rest.

## Concepts

- [**Bar Magnifier exact mode**](./common-options.md#fill-model--bar-magnifier) —
  strict tri-state overrides, automatic piner mapping, the shipped
  contract-capable engine's authoritative active/inactive reporting, provider
  support matrices, typed outcomes, and the 200k fold guard.
- [**How the portfolio model works**](./portfolio-model.md) — capital models
  (isolated vs shared), the union clock, per-bar execution order, and the exact
  identities behind the `portfolio` numbers.
- [**CSV data files**](./csv-data.md) — run any command on local CSV history
  (`--provider csv --data-dir <dir>`, or `CSV:` symbols in a mixed universe):
  file naming, row format, instrument-metadata sidecar, and the exact-mode
  evidence flags (`--csv-alignment`, `--csv-week-anchor`, `--csv-calendar`,
  `--csv-complete-record`) that enable Bar Magnifier over CSV files.

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

## Running that flow interactively

Those five steps are one loop you walk repeatedly against the same script, and
the CLI makes you retype the invocation each turn. `pinetop` is a terminal UI over
these same commands — one page per command, the flags editable beside the report,
`w` on a swept winner carrying the grid into `walkforward`:

```bash
pinetop
```

It adds no flags and no analytics of its own: every page composes a real
invocation, spawns `pinerun … --json`, and renders that payload, so anything you
see is reproducible with the command it prints at the bottom of the frame. It
installs from the same `curl | sh` as the CLI and self-updates with
`pinetop upgrade`. See [`packages/pinetop/README.md`](../packages/pinetop#readme).

> The full narrative guide — architecture, concepts, programmatic API — lives in
> [`packages/pinerun/README.md`](../packages/pinerun/README.md). These pages are
> the per-command flag reference.
