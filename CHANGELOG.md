# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `pinerun` CLI is distributed as a prebuilt, self-contained binary (see the
README). The workspace packages run from TypeScript source and version in
lockstep with the release tag; publishing the library to npm remains a possible
follow-up.

## [0.2.0] - 2026-07-15

### Changed (breaking)

- **piner engine `0.8.1` → `0.9.0`** — backtest **results change** for
  margin-enabled and derived-quantity (`cash` / `percent_of_equity`)
  strategies: the margin-call simulation now matches TradingView's broker
  emulator exactly (worst-extreme evaluation and fill, lot-step-truncated ×4
  liquidations, one-unit fallback, directional liquidation-price rounding),
  and derived order quantities truncate to the symbol's lot step. Verified
  against a 42-event TradingView margin-call ledger. See piner's 0.9.0
  changelog for the full details; pass `--min-qty 0` to disable quantity
  truncation.

### Added

- **Per-symbol instrument metadata** (`minQty` lot step + `mintick` tick size),
  fetched from the provider's exchange rules and applied to every run
  automatically:
  - pinery: optional `HistoryProvider.instrument(symbol)` — implemented for
    Binance (spot + USDⓈ-M futures `exchangeInfo`: `LOT_SIZE.stepSize`,
    `PRICE_FILTER.tickSize`), OKX (`/public/instruments`; swap lot steps
    convert via `ctVal` to base units), Kraken (`AssetPairs`), and the
    equities providers (whole-share lots), plus `StaticProvider.setInstrument`
    for tests. `cached()` caches instrument lookups on disk (daily-keyed).
  - pinerun: every command (backtest/scan/sweep/walkforward/portfolio)
    resolves the symbol's lot step and tick size before running — explicit
    `--min-qty` / `--mintick` flags override, provider metadata fills the
    gaps, piner defaults (0.001 / 0.01) remain the last resort. `--mintick`
    previously parsed but was only honored by `portfolio`; it now applies
    everywhere.

  The lot step drives piner ≥0.9's TV-parity quantity truncation (derived
  order sizes and margin-call liquidations truncate to the symbol's minimum
  contract size), so per-symbol resolution keeps multi-symbol scans honest —
  SOLUSDT perps trade in 0.01 steps, DOGE perps in whole contracts, spot BTC
  in 1e-5.

## [0.1.2] - 2026-07-15

### Fixed

- **Engine correctness (via `@heyphat/piner` 0.8.1).** Bumped the piner engine
  to pick up four Pine v6 conformance fixes that affect computed `scan` /
  `sweep` / `backtest` / `walkforward` / `portfolio` results:
  - String compound assignment (`s += "x"`) now concatenates instead of
    lowering to numeric addition (which produced `na` and could serialize
    `text` as `null`).
  - `==` / `!=` round float operands to nine fractional digits, so
    `0.1 + 0.2 == 0.3` is `true` (and `switch` subject matching inherits it).
  - `[]` floors a float offset (`close[2.9]` → `close[2]`); a non-finite
    offset reads `na`.
  - `±Infinity` is falsy in conditions.

## [0.1.1] - 2026-07-13

### Added

- **`pinerun upgrade`** — self-update the installed binary in place: resolves
  the latest GitHub release, downloads this platform's asset, verifies its
  sha256 against the release's `checksums.txt`, and atomically swaps the
  executable. `--check` only reports whether a newer release exists. (Binaries
  from v0.1.0 predate this command — re-run the install one-liner once to get
  it.)
- **`pinerun --version`** (also `-v` / `version`) — prints the CLI version and,
  in compiled binaries, the build commit (both injected at build time from the
  package manifest and git).

## [0.1.0] - 2026-07-13

First public open-source release.

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

[0.2.0]: https://github.com/heyphat/pinestack/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/heyphat/pinestack/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/heyphat/pinestack/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/heyphat/pinestack/releases/tag/v0.1.0
