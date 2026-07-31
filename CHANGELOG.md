# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `pinerun` CLI and the `pinetop` TUI are distributed as prebuilt,
self-contained binaries (see the README). The workspace packages run from
TypeScript source and version in lockstep with the release tag; publishing the
libraries to npm remains a possible follow-up.

## [0.7.0] - 2026-07-31

### Added

- **`pinetop` — a terminal UI over the `pinerun` CLI.** A new workspace package
  (`@heyphat/pinetop`) that keeps a strategy's report resident on screen and makes
  the command's own flags the thing you edit, so the edit → rerun → reread loop
  happens in place instead of through repeated shell invocations and scrollback.
  It adds no analytics: every number comes from `pinerun --json`, and the braille
  charts and monthly grids are the CLI's own renderers, imported — so the screen
  and the printed command cannot disagree.
  - Seven pages in workflow order, `1`–`7`: BACKTEST, SWEEP, WALKFORWARD, SCAN,
    PORTFOLIO, COMPARE, and TRADES (the ledger + engine log for the loaded run).
  - Flags are editable in place: `tab` to the config pane, `↵` to edit a row,
    `.` to reveal the advanced ones. `r` then `↵` runs. Nothing runs, and nothing
    changes the config, without a keypress.
  - Flags a choice makes mandatory surface with it — `--provider csv` reveals
    `--data-dir` and the `--csv-*` assertions, and a csv run without a directory
    is refused before the spawn rather than failing on its first fetch.
  - The BACKTEST rail mirrors the CLI tearsheet's three sections (RETURNS, RISK,
    TRADES) row for row, with the CLI's labels and formatters; the monthly grids
    carry its green/red grading.
  - Workflow hand-offs: `w` carries a sweep grid into WALKFORWARD, `↵` on a
    ranked combo, a scanned symbol, or a portfolio sleeve deep-dives it in
    BACKTEST.
  - An opt-in Ask drawer (`a`) answers questions grounded in the loaded report and
    returns any recommended change as a reviewable parameter diff — `↵` applies,
    `ctrl-x` rejects, and an applied edit raises a "not yet re-run" banner until
    you re-run. It sends derived metrics only: never OHLCV bars, never script
    source, never credentials.
  - Per-project state in `.pinetop/`: saved flags, so reopening resumes where you
    were, plus a session log of every invocation with its exit code and duration.
  - `pinetop --check-flags` diffs its flag schema against `pinerun <cmd> --help`
    and exits non-zero on drift.
  - `pinetop --version` (also `-v` / `version`, matching the CLI) reports both its
    own version + commit **and** the `pinerun` it spawns — every number on screen
    came out of that binary, so a stale one on PATH explains a stale number. The
    same pair heads the `?` overlay.
  - `pinetop upgrade` (`--check` to just look) self-updates the installed binary
    in place, resolving the latest release, verifying the download's sha256
    against the release's `checksums.txt`, and swapping the executable
    atomically — the same implementation `pinerun upgrade` uses, asked to operate
    on the `pinetop` asset.

  See [`packages/pinetop/README.md`](./packages/pinetop#readme).

### Changed

- **Releases now ship both binaries.** A release carries 10 assets (`pinerun-*`
  and `pinetop-*`, 5 targets each) under one `checksums.txt`, and the workflow
  executes the built linux-x64 assets to assert each self-reports the tag before
  publishing. `scripts/build-bin.ts` grew `--product pinerun|pinetop` (defaulting
  to whichever package you run it from); existing `bun run build:bin` invocations
  are unaffected.
- **The installer installs `pinerun` and `pinetop`.** `PINESTACK_BINS` selects
  (default `"pinerun pinetop"`), alongside `PINESTACK_VERSION` and
  `PINESTACK_INSTALL_DIR`. The older `PINERUN_VERSION` / `PINERUN_INSTALL_DIR`
  names keep working.

## [0.6.1] - 2026-07-29

### Changed

- MONTHLY TRADES break-even tallies are now bare counts like wins and losses
  (`5/2/1` instead of `5/2/1E`): color alone tells the segments apart — wins
  green, losses red, evens uncolored — and the header legend reads
  `(win/loss/even)`.

## [0.6.0] - 2026-07-29

### Added

- **MONTHLY TRADES tearsheet table.** `backtest` and `portfolio` print a year ×
  month grid in the MONTHLY RETURNS layout tallying closed trades by exit month
  in win/loss/even order (`5/3`, `5/2/1E`; zero tallies are omitted), with a
  YEAR total column. Wins paint green and losses red on a TTY; evens keep an
  `E` suffix because they carry no color. Like the other stats tables it always
  prints, independent of `--no-chart`.
- **Exact CSV CLI evidence for Bar Magnifier and static security.** Every CSV
  leaf created by `--data-dir` now discovers canonical `<SYMBOL>_<TF>.csv`
  datasets for native or exactly aggregatable acquisition. `--csv-alignment
utc-24x7`, strict `--csv-week-anchor <YYYY-MM-DD|seconds>`, and
  `--csv-calendar <file.json>` provide explicit alignment evidence; strict
  calendar loading rejects unknown keys, unsafe intervals, and invalid
  `periods`. Claims work for `CSV:` symbols in mixed routing without making CSV
  the fallback provider, and duplicate/conflicting scalar options fail early.
- **Authenticated CSV complete-record semantics.** `--csv-complete-record`
  asserts that absent bars inside an explicit exact file's full record span mean
  no trades. The bars-only default is unchanged. Semantics and record spans are
  content- and identity-bound through native/aggregated acquisition, magnifier
  and static-security proofs, local/worker execution, and walk-forward prefix
  derivation. Bare fallback and empty files fail closed; requests and buckets
  crossing the record edge remain incomplete.

### Changed

- Repeating any scalar CLI option (for example `--symbol a --symbol b`) is now
  rejected with a `duplicate scalar option` error on every command instead of
  silently using the last value. The repeatable options (`--input`,
  `--input-a`/`--input-b`, `--weights`) are unchanged.
- Exact CSV documentation now distinguishes compatibility `history()` row
  normalization from strict exact acquisition, documents whole-second/grid and
  OHLCV validation, strict exchange calendars, mixed routing, and the risk of
  complete-record assertions. CLI help exposes the same evidence flags on every
  analysis command. Bar Magnifier docs now describe the shipped
  contract-capable piner 0.11.1 runtime (active-traversal reporting) instead of
  the pre-0.5.0 capability-rejection state.

## [0.5.0] - 2026-07-28

### Added

- **`--bar-magnifier` / `--no-bar-magnifier`** on `backtest`, `compare`,
  `scan`, `sweep`, and `walkforward` — TradingView's Bar Magnifier Properties
  toggle. Tri-state: absent → the `strategy()` header decides; `true`/`false`
  force it either way. When effective, historical no-COOF fills use **real
  lower-timeframe OHLC** acquired exactly by `pinery` (native target bars or
  provably aligned aggregation, coverage- and provenance-checked, newest-first
  toward TradingView's 200,000-target-bar limit) and injected into
  `@heyphat/piner`, whose report block is presented as authoritative —
  `fill model: bar magnifier` with per-run coverage, or an explicit
  requested-but-inactive line. Requires `@heyphat/piner` ≥ 0.11.1; an explicit
  override on an older engine fails with an actionable error.
  - **Exact mode fails closed.** Unknown provider alignment, incomplete
    required coverage, non-divisor timeframes, and off-grid chart opens are
    typed permanent failures — never a silent fallback, a clamped timeframe,
    or a dropped portfolio sleeve. Runtime-dynamic `request.security`
    identities (symbol/timeframe/lookahead not statically resolvable) are
    rejected with `dynamic-security-unsupported-with-bar-magnifier` across
    every command, including shared-account portfolios.
  - **Deterministic and transport-safe:** the resolved LTF dataset joins the
    strong content digest (memoized results can never alias across symbols,
    windows, feeds, or sessions), hydrates once per worker with
    authentication, and local and worker runs produce identical reports.
    Walk-forward rejects folds whose full IS+OOS envelope exceeds the 200k
    cap rather than silently ranking on differing suffixes.
  - Programmatic equivalents: `useBarMagnifier` on `Job`, `BacktestOptions`,
    `CompareOptions`, `ScanOptions`, `SweepOptions`, `WalkforwardOptions`;
    per-sleeve resolution for `portfolio` (no portfolio-wide CLI override).
  - Validated end-to-end against piner's 352-run PineForge differential
    corpus: the full CsvProvider → pinery aggregation → resolver → worker →
    piner pipeline reproduces the reference trades exactly, including
    sub-bar fill timestamps. **Proxy-validated partial support, not
    TradingView parity** — COOF, realtime, and risk/margin cadence keep the
    established chart-OHLC behavior.

  - **CSV exact acquisition:** the CLI now accepts explicit UTC or strict
    exchange-calendar evidence for `--data-dir` leaves, including mixed
    `CSV:` routing. Bars-only remains the default; callers may opt into the
    stronger authenticated complete-record assertion when their file producer
    guarantees it. Targets needing aggregation still fail with
    `incomplete-required-coverage` whenever the selected evidence cannot cover
    the complete requested envelope.

### Changed

- `@heyphat/piner` pinned to **0.11.1** (Bar Magnifier engine support and a
  stop-limit entry fill correction — far-side stop-limits no longer fill at
  untraded prices, so affected backtests report different, correct fills).
- CLI `--help` and error text now reference the embedded engine as 0.11.1.

## [0.4.0] - 2026-07-26

### Added

- **`--calc-on-order-fills` / `--no-calc-on-order-fills`** on `backtest`,
  `scan`, `sweep`, and `walkforward` — override the script's
  `calc_on_order_fills` declaration (TradingView's "After order is filled"
  Properties checkbox) without editing the source. Tri-state: absent → the
  `strategy()` header decides; `true`/`false` force it either way (also
  `--calc-on-order-fills=true|false`). Walk-forward applies the override to
  both the in-sample sweeps and each window's winner run. `portfolio` has no
  host override — the script header still applies there. Programmatic
  equivalents: `calcOnOrderFills` on `Job`, `BacktestOptions`, `ScanOptions`,
  `SweepOptions`, and `WalkforwardOptions`; the override joins the
  determinism key, so sweep/scan variants never share memoized results.
  Requires `@heyphat/piner` ≥ 0.10.0 (the engine that models the flag) — on
  an older engine an explicit override **fails with an actionable error**
  rather than running inertly; a source-declared header flag still runs
  (ignored) but is never reported as active. See
  [`docs/common-options.md`](./docs/common-options.md#fill-model--calc_on_order_fills).
- **Effective fill-model reporting** — `strategy.calcOnOrderFills` in JSON
  results and a `fill model: calc_on_order_fills` tearsheet line, read from
  the engine's actual state (never the requested configuration); walk-forward
  `--json` carries the marker per window as `calcOnOrderFills`. `portfolio`
  results intentionally carry no fill-model marker.

### Changed

- **`@heyphat/piner` pinned to 0.10.0** (was 0.9.0), and `@heyphat/pinerun`'s
  peer dependency floor is now `>=0.10.0`. piner 0.10.0 brings the
  TV-parity `calc_on_order_fills` engine (path-point fill model verified
  fill-for-fill and excursion-for-excursion against a TradingView export)
  plus chronological account marks, exposure-interval margin, and per-pass
  risk timing — see piner's 0.10.0 changelog. Flag-off backtest results are
  unchanged.

## [0.3.0] - 2026-07-19

### Added

- **CSV file provider** — run any command on local CSV files (exported exchange
  data, vendor downloads, synthetic series) instead of a live provider:
  - pinerun: `--provider csv --data-dir <dir>` serves every bare ticker from
    the directory; `CSV:TICKER` instrument addresses pull individual symbols
    from files inside a mixed universe (`CSV:AAPL,BI:BTCUSDT`). CSV history
    bypasses the on-disk cache — the files are the storage. See the new
    [`docs/csv-data.md`](./docs/csv-data.md) and the runnable sample data in
    `examples/data/`.
  - File layout: one `<SYMBOL>_<TF>.csv` per instrument (header
    `time,open,high,low,close,volume`, order-independent; unix seconds/millis
    or ISO times; RFC 4180-quoted fields accepted). A timeframe-less
    `<SYMBOL>.csv` fallback serves any timeframe only after its median bar
    spacing matches the request — wrong-resolution data errors instead of
    silently backtesting. An optional `instruments.csv` sidecar
    (`symbol,minQty,mintick`) supplies per-symbol lot step + tick size;
    malformed values fail the run with their line number rather than silently
    becoming defaults.
  - pinery: `CsvProvider` behind `@heyphat/pinery/node` (browser-safe core
    untouched); `csv` joins the provider registry with the `CSV:` address
    prefix; `InstrumentRouter` accepts pre-built provider instances via the
    new `providers` option.
- **`request.security` degradation warnings.** A dependency that fails to
  fetch still degrades to `na`/`[]` (one flaky dependency must not kill a
  100-symbol scan), but the CLI now prints a stderr warning naming the
  dependency and the underlying error instead of degrading silently — a
  strategy condition reading an unexpectedly-`na` series is otherwise
  invisible. Programmatic callers get an `onSecurityError` callback on
  `scan` / `backtest` / `portfolio` / `sweep` / `walkforward`.

### Changed

- `barsFromCsv` is stricter and more capable: RFC 4180-quoted fields, UTF-8
  BOM stripping, duplicate timestamps keep the last row (a re-export
  overwrites instead of doubling bars), and a malformed cell throws with its
  line number instead of producing NaN bars.

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

[0.7.0]: https://github.com/heyphat/pinestack/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/heyphat/pinestack/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/heyphat/pinestack/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/heyphat/pinestack/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/heyphat/pinestack/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/heyphat/pinestack/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/heyphat/pinestack/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/heyphat/pinestack/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/heyphat/pinestack/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/heyphat/pinestack/releases/tag/v0.1.0
