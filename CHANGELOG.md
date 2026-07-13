# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `pinerun` CLI is distributed as a prebuilt, self-contained binary (see the
README). The packages themselves are pre-release (`0.0.0`) and run from
TypeScript source; publishing the library to npm remains a possible follow-up.
Until the first tagged release, changes are tracked here under **Unreleased**.

## [Unreleased]

### Added

- **`@heyphat/pinery` — the data layer.** OHLCV history providers implementing
  piner's `DataFeed` contract: Binance (spot + USDⓈ-M futures), OKX (spot +
  swap), Kraken spot, Alpaca US equities, Massive US equities, and an in-memory
  static/CSV provider. Canonical timeframe parsing + piner mapping, crypto pair
  normalization, a shared retrying JSON fetch, and a Node on-disk history cache
  behind `@heyphat/pinery/node`. Browser-safe core; Node built-ins stay behind
  the `/node` entry.
- **`@heyphat/pinerun` — the orchestration layer.** The `Job` model, the
  `jobHash` determinism key, the pure `executeJob` primitive, the `Runner`
  contract with an in-process `LocalRunner` and a `WorkerPoolRunner`
  (`node:worker_threads`), and the extractor/ranker grammar.
- **Milestone A — `scan`.** Fan one indicator or strategy across N symbols in
  parallel and rank the results (e.g. `--rank "last(rsi)" --top 3`).
- **Milestone B — `sweep`.** Run one strategy across a cartesian grid of input
  values on one symbol, in parallel, ranked — the same job core as `scan`.
- **Milestone C — `backtest`.** Single strategy × single symbol with
  risk-adjusted metrics (Sharpe/Sortino/Calmar, CAGR, exposure, buy & hold),
  trade/equity CSV export, and a self-contained equity + drawdown plot.
- **Milestone D — `walkforward`.** Per-window in-sample sweep → out-of-sample
  verdict with a walk-forward-efficiency aggregate — the anti-overfitting
  counterpart to `sweep`.
- **`portfolio`.** Run one strategy across N symbols against one shared pot of
  capital (piner's `PortfolioEngine`), with isolated and shared capital modes.
- **Terminal analytics suite** — tearsheet tables, `compare`, `watch`, and a
  PRICE terminal chart with trade markers.
- **`pinerun init`** — starter-strategy scaffolding.
- **Prebuilt CLI binaries** — `bun run build:bin all` cross-compiles the
  `pinerun` CLI for Linux/macOS (x64 + arm64) and Windows (x64) into single
  self-contained executables, a `curl | sh` installer (`scripts/install.sh`),
  and a tag-triggered release workflow that attaches them to a GitHub Release.
- Repository set up for open-source release: AGPL-3.0 `LICENSE`, contributing /
  security / conduct guides, issue & PR templates, and CI.
