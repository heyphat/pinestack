# `pinerun init`

> Scaffold: write a commented starter strategy.

Writes a complete, heavily commented Pine v6 `strategy()` you can run immediately — no Pine writing required. It's the fastest way to get a real, runnable script: the scaffold explains how a strategy works (inputs, per-bar execution, entries/exits) and opens with copy-paste `backtest` / `scan` / `sweep` / `walkforward` recipes whose `--input` names already match the script's `input()` titles. This command only writes a file; it does not fetch data or run the engine.

## Synopsis

```bash
pinerun init [file.pine] [options]
```

## Parameters

| Parameter           | Default         | Description                                                                                                                                                                                                                                                                |
| ------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[file.pine]`       | `strategy.pine` | Output path for the scaffolded script; missing parent directories are created.                                                                                                                                                                                             |
| `--template <name>` | `sma-cross`     | Which starter to scaffold: `sma-cross` (SMA crossover, trend following) · `rsi` (RSI mean-reversion, fade oversold/overbought extremes) · `bollinger` (Bollinger-band breakout, trade volatility expansion) · `macd` (MACD crossover, momentum via the signal-line cross). |
| `--name "Title"`    | per-template    | The `strategy()` title. Defaults to a per-template label (e.g. `My SMA cross`).                                                                                                                                                                                            |
| `--force`           | off             | Overwrite the output file if it already exists (otherwise `init` refuses to clobber it).                                                                                                                                                                                   |
| `--stdout`          | off             | Print the source to stdout instead of writing a file (pipe or preview).                                                                                                                                                                                                    |

## Examples

Write the default SMA-cross starter to `strategy.pine`:

```bash
pinerun init
```

```text
  wrote strategy.pine — SMA crossover — trend following (the classic starter)

  next steps:
    pinerun backtest strategy.pine --symbol BTCUSDT --tf 1h --limit 500
    pinerun scan strategy.pine --symbols BTCUSDT,ETHUSDT,SOLUSDT --tf 1h --limit 500

  the file opens with commented run recipes (sweep + walkforward included).
```

Scaffold a commented RSI mean-reversion starter to a named file:

```bash
pinerun init rsi-bot.pine --template rsi
```

Scaffold into a nested path (parent dirs are created) with a custom title:

```bash
pinerun init strategies/macd.pine --template macd --name "Momentum MACD"
```

Preview the source without writing a file:

```bash
pinerun init --template bollinger --stdout
```

Backtest the scaffolded strategy on one symbol:

```bash
pinerun backtest strategy.pine --symbol BTCUSDT --tf 1h --limit 500
```

## See also

- [`backtest`](./backtest.md) — inspect the scaffolded strategy on one symbol.
- [`sweep`](./sweep.md) — optimize its inputs. · [`scan`](./scan.md) — screen a universe.
- [Command index](./README.md)
