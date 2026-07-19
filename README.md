# pinestack

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

A programmable, parallel execution surface for the [piner](https://github.com/heyphat/piner)
Pine Script v6 engine. Where TradingView keeps Pine locked inside one chart, one
symbol, one timeframe, pinestack turns the engine into a headless fan-out you can
script: scan one indicator or strategy across hundreds of symbols, backtest a
strategy into a full tearsheet, and sweep parameter grids — all off the
deterministic piner core.

This is the "terminal" layer around the engine. piner stays a pure, browser-safe
library; pinestack adds the data and orchestration rings on top.

## Install

The `pinerun` CLI ships as a single self-contained binary — the Bun runtime, the
piner engine, and the pinery data layer are all baked in, so there is nothing
else to install (no Node, no Bun, no npm):

```bash
curl -fsSL https://raw.githubusercontent.com/heyphat/pinestack/main/scripts/install.sh | sh
```

This downloads the right binary for your platform from the
[latest release](https://github.com/heyphat/pinestack/releases/latest) and drops
it in `~/.local/bin` (override with `PINERUN_INSTALL_DIR`; pin a version with
`PINERUN_VERSION=v0.1.0`). Prebuilt targets: Linux and macOS on x64/arm64, plus a
Windows x64 `.exe` you can download directly from the Releases page.

```bash
pinerun --version
pinerun --help
pinerun scan --help
```

Later, update in place with `pinerun upgrade` — it downloads the latest
release's binary for your platform, verifies its checksum, and swaps the
executable atomically (`--check` to just look).

Prefer to build it yourself? See [Getting started](#getting-started) below, then
`bun run build:bin --install`.

## Packages

| Package                                  | Role                                                                                                                                                                                                                | Entry points                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`@heyphat/pinery`](./packages/pinery)   | **Data layer.** OHLCV history providers (Binance spot/futures, OKX spot/swap, Kraken, Alpaca, Massive, static/CSV) implementing piner's `DataFeed` contract, canonical timeframe helpers, and a Node on-disk cache. | `@heyphat/pinery` (browser-safe), `@heyphat/pinery/node`                    |
| [`@heyphat/pinerun`](./packages/pinerun) | **Orchestration layer.** The job model, a determinism cache, in-process and worker-thread runners, the ranker, the `scan` fan-out, and the `pinerun` CLI.                                                           | `@heyphat/pinerun` (browser-safe), `@heyphat/pinerun/node`, `pinerun` (CLI) |

```
piner            (engine — separate repo, pure, browser-safe)
  ▲   ▲
  │   └── @heyphat/pinery   depends on piner (implements DataFeed / Bar)
  │            ▲
  └────────────┴── @heyphat/pinerun   depends on piner + pinery (orchestrates)
                       ▲
                       └── consumers: the pinerun CLI, a charting frontend, your scripts
```

`piner` is declared a **peer dependency** of both packages, so there is only ever
one engine copy in a consumer's tree.

## Repository layout

```
pinestack/
├── package.json              workspaces root (packages/*)
├── tsconfig.base.json        shared compiler options (strict, ES2022, bundler res)
├── tsconfig.json             solution file: references both packages (tsc -b)
├── examples/
│   ├── rsi.pine              sample indicator used by the scan demo
│   ├── sma-cross-param.pine  MA crossover, parameterized (scan + sweep demo)
│   ├── rsi-mean-reversion.pine   RSI mean-reversion strategy (parameterized)
│   ├── bollinger-breakout.pine   Bollinger-band breakout strategy (parameterized)
│   ├── macd.pine             MACD crossover strategy (parameterized)
│   └── rs-vs-eth.pine        cross-symbol request.security demo
└── packages/
    ├── pinery/               @heyphat/pinery  — data layer
    │   ├── src/
    │   │   ├── index.ts          browser-safe barrel
    │   │   ├── provider.ts       HistoryProvider contract, toDataFeed, applyRange
    │   │   ├── timeframe.ts       canonical timeframe parsing + piner mapping
    │   │   ├── http.ts            shared retrying JSON GET
    │   │   ├── symbols.ts         crypto pair normalization (OKX/Kraken)
    │   │   ├── node.ts            @heyphat/pinery/node — on-disk cache
    │   │   └── adapters/
    │   │       ├── binance.ts     Binance spot + USDⓈ-M futures klines
    │   │       ├── okx.ts         OKX spot + swap candles
    │   │       ├── kraken.ts      Kraken spot OHLC
    │   │       ├── alpaca.ts      Alpaca US-equities bars (key + secret)
    │   │       ├── massive.ts     Massive US-equities aggregates (api key)
    │   │       ├── static.ts      in-memory provider + barsFromCsv
    │   │       └── csv.ts         local CSV-file provider (Node-only, /node entry)
    │   └── README.md
    └── pinerun/              @heyphat/pinerun — orchestration layer
        ├── src/
        │   ├── index.ts          browser-safe barrel
        │   ├── job.ts            Job model
        │   ├── result.ts         RunResult contract
        │   ├── hash.ts           jobHash — determinism key
        │   ├── execute.ts        executeJob — the pure run primitive
        │   ├── runner.ts         Runner interface, fanOut, LocalRunner
        │   ├── rank.ts           extractor/ranker grammar
        │   ├── scan.ts           the scan fan-out
        │   ├── params.ts         sweep axis grammar (cartesian input expansion)
        │   ├── sweep.ts          the parameter-sweep fan-out
        │   ├── backtest.ts       single-strategy deep run (tearsheet data)
        │   ├── walkforward.ts    out-of-sample / walk-forward validation
        │   ├── export.ts         CSV + equity/drawdown plot builders
        │   ├── scaffold.ts       `init` starter-strategy source builders
        │   ├── pool.ts           WorkerPoolRunner (node:worker_threads)
        │   ├── worker-entry.ts   worker thread entry
        │   ├── node.ts           @heyphat/pinerun/node barrel
        │   └── cli.ts            the `pinerun` CLI
        ├── test/
        └── README.md
```

## Requirements

- [Bun](https://bun.sh) ≥ 1.2 (used for install, test, build, and running the CLI).
- `piner` (`@heyphat/piner`) available as a peer — installed from the npm
  registry by the workspace root (`bun install`).

## Getting started

With `pinerun` on your PATH (see [Install](#install)), scaffold a starter strategy
and backtest it on one symbol — no API key needed for crypto:

```bash
pinerun init strategy.pine
pinerun backtest strategy.pine --symbol BTCUSDT --tf 1h --limit 500
```

`init` writes a runnable, commented SMA-crossover strategy; `backtest` runs it on
500 hourly BTC bars and prints a full tearsheet — returns, risk, and trade quality,
then monthly returns, top drawdowns, and in-terminal price / equity / drawdown
charts (abbreviated here):

```text
  backtest: BTCUSDT @ 1h — 499 bars, 2026-06-21 → 2026-07-12

  RETURNS
    net profit                 -474.42      -4.74%
    gross profit                765.46       7.65%
    gross loss                 1239.88      12.40%
    buy & hold                               2.08%
    outperformance             -682.47
    CAGR                                   -57.50%

  RISK
    max drawdown                843.34       8.36%
    max runup                   827.41       8.95%
    volatility (annual)                     33.86%
    sharpe                       -2.36
    sortino                      -1.51
    calmar                       -6.88
    exposure                                53.51%

  TRADES
    closed trades                    9  (2W 7L 0E)
    win rate                                22.22%
    profit factor                 0.62
    …
```

From there: screen a universe with `pinerun scan`, optimize a parameter grid with
`pinerun sweep`, validate it out-of-sample with `pinerun walkforward`, or pool one
pot across symbols with `pinerun portfolio`. See the
[command reference](./docs/README.md) (or `pinerun <command> --help`) for every
flag, and [`packages/pinerun/README.md`](./packages/pinerun/README.md) for the
programmatic API.

### Developing from source

Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
bun install        # links workspaces + the piner peer
bun test           # runs every package's test suite
bun run typecheck  # tsc -b across both packages
```

Build a standalone `pinerun` binary from your checkout and drop it on your PATH
with `bun run build:bin --install`.

## Design principles

1. **piner stays pure.** No I/O, no orchestration leaks into the engine. pinery
   and pinerun are the rings around it.
2. **Determinism is the moat.** A piner run is a pure function of
   `(source, bars, inputs, backend)`. That makes runs cacheable (`jobHash`),
   reproducible, and trivially parallel — the things TradingView can't offer.
3. **Browser-safe core, Node extras behind `/node`.** Neither package drags Node
   built-ins into a browser bundle; filesystem cache and worker threads live in
   the separate `/node` entry. The same `scan` runs in the CLI (worker threads)
   or later in a browser (Web Workers) over the identical `Runner` contract.
4. **One engine copy.** `piner` is a peer dependency everywhere.

## License

[GNU AGPL-3.0](./LICENSE) © Phat Huynh.
