# `pinerun walkforward`

> Validate: does the swept edge survive out of sample?

`walkforward` is the anti-overfitting counterpart to [`sweep`](./sweep.md). A sweep picks the best combo on historical data, but that combo is usually fit to noise; walk-forward asks whether the edge holds on data the optimizer never saw. History is split into N windows — each window sweeps the grid on its **in-sample** (IS) segment, picks the winner by `--rank`, then measures that winner on the following **out-of-sample** (OOS) segment. The verdict is **WFE** (walk-forward efficiency, per-bar OOS ÷ IS profit): ≈ 1 means a real edge, ≪ 1 means overfit. Strategy scripts only.

## Synopsis

```bash
pinerun walkforward <script.pine> --symbol <sym> --input <name=spec> ... [options]
```

## Parameters

| Flag                | Default              | Description                                                                                                                                                  |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--symbol <sym>`    | — (required)         | Single symbol to validate. A bare ticker or full instrument address (see [symbol addressing](./common-options.md#symbol-addressing)). Strategy scripts only. |
| `--input name=spec` | —                    | Swept axis, repeatable — same grammar as [`sweep`](./sweep.md). See [Swept input grammar](./common-options.md#swept-input-grammar---input).                  |
| `--windows <n>`     | `5`                  | Number of walk-forward windows. `1` = a plain single IS/OOS split.                                                                                           |
| `--oos <f>`         | `0.25`               | OOS share of each window, `0 < f < 1`.                                                                                                                       |
| `--anchored`        | rolling              | Expanding in-sample from bar 0 (default: rolling IS of fixed width).                                                                                         |
| `--no-chart`        | off                  | Skip the per-window OOS EQUITY sparkline column.                                                                                                             |
| `--rank <spec>`     | `strategy.netProfit` | Metric that picks each window's winner. See [Ranking spec](./common-options.md#ranking-spec---rank).                                                         |
| `--max-combos <n>`  | `5000`               | Cap on total grid runs; the sweep refuses to start above it.                                                                                                 |

## Common options

Plus shared flags — see [common options](./common-options.md):

- **Data:** `--tf` · `--from` · `--to` · `--limit` · `--provider` · `--asset-class` (+ [credentials](./common-options.md#credentials-equities-providers--alpaca--massive))
- **Execution:** `--backend` · `--concurrency` · `--workers` · `--no-security`
- **Cache:** `--no-cache` · `--cache-dir` · `--refresh`
- **Broker:** `--mintick` · `--min-qty` · `--calc-on-order-fills` / `--no-calc-on-order-fills` ([fill model](./common-options.md#fill-model--calc_on_order_fills)) · `--bar-magnifier` / `--no-bar-magnifier` ([Bar Magnifier exact mode](./common-options.md#fill-model--bar-magnifier))
- **Metrics:** `--periods-per-year` · `--risk-free-rate`
- **Output:** `--json`

## How it works

**Window planning.** History is divided into `--windows` windows. Each window is an IS segment followed by an OOS segment; `--oos` sets the OOS share of the window (default `0.25`, so IS is 3× OOS). OOS segments tile the tail of history back to back, so every OOS bar is traded by parameters chosen strictly on earlier data — no bar is ever both optimized on and measured on.

**Rolling vs anchored.** By default the IS is _rolling_: a fixed-width window that slides forward alongside its OOS. With `--anchored`, the IS is _expanding_ — it always starts at bar 0 and grows, so later windows optimize on more history.

**IS as warmup.** Each window's winner runs over the full window (IS + OOS): the IS stretch doubles as indicator warmup. Because a piner run is deterministic bar by bar, the winner's IS prefix is identical to the sweep run that selected it. OOS performance is the equity-curve difference across the IS/OOS boundary; OOS trades are those that exit inside the segment (a position opened in-sample and carried across counts, as it would live).

**Bar Magnifier fold rule.** When requested, each fold resolves one exact
dataset over its complete IS+OOS chart envelope before candidate ranking. The
IS sweep receives only a prefix view of that same immutable acquisition and the
winner reuses the full dataset. A fold with 200,000 eligible mapped target bars
is allowed; 200,001 is a typed permanent failure, including when the retained-
suffix boundary would be inside IS. Failed folds remain in `windows[]` with a
serializable `failure` diagnostic.

**Reading the verdict.** WFE is per-bar OOS profit ÷ per-bar IS profit across all windows. ≈ 1 means the edge holds out of sample; ≪ 1 means the sweep was fitting noise. Also watch the OOS-positive count and whether the winning combo is _stable_ across windows — a different winner every window is itself a red flag.

## Output

A header names the run (symbol, window count, IS/OOS bar sizes, rolling vs anchored, rank metric), followed by one row per window:

- **IS SPAN** / **OOS SPAN** — the date ranges of each segment.
- **WINNER** — the combo chosen on the IS segment (e.g. `fast=10|slow=30`).
- **IS NET%** / **OOS NET%** — the winner's net profit in-sample vs out-of-sample.
- **TRADES** — OOS trade count.
- **EFF** — that window's OOS/IS efficiency (`na` when IS profit is non-positive).
- **OOS EQUITY** — a sparkline of the winner's out-of-sample equity segment, so "did the edge survive" is visible per row. Dropped by `--no-chart`.

The closing **aggregate** line is the verdict: OOS-positive count, mean IS%, mean OOS%, and the headline **WFE**.

`--json` emits the structured verdict instead of the table: `windows[]`
(each with bar indices/times, winner and IS/OOS metrics, plus any typed
`failure`; the heavy full-window result is omitted, while authoritative
`calcOnOrderFills` / `barMagnifier` markers are projected) and `aggregate`
(`oosPositive`, means, WFE, window count, and failed count).

## Examples

Validate a two-axis SMA-cross grid across 5 rolling windows:

```bash
pinerun walkforward examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h \
  --limit 2000 --input fast=5,10,15,20 --input slow=30:100:10 --windows 5
```

Which prints one row per window — each with a per-window OOS EQUITY sparkline —
and the aggregate verdict:

```text
  walk-forward: BTCUSDT — 5 windows (IS 754 → OOS 249 bars, rolling), rank strategy.netProfit

  #  IS SPAN                   OOS SPAN                  WINNER            IS NET%  OOS NET%  TRADES     EFF  OOS EQUITY
  --------------------------------------------------------------------------------------------------------------------------
   1 2026-04-20 → 2026-05-21   2026-05-21 → 2026-05-31   fast=10|slow=70     1.33%    -1.83%       3   -4.16  ▆▇▅▅▄▇▅▂▂▂▂▂▂▁
   2 2026-04-30 → 2026-05-31   2026-05-31 → 2026-06-11   fast=20|slow=50    -1.37%    -3.29%       2      na  ▇▅▅▅▅▅▅▅▅▆▇▁▁▁
   3 2026-05-10 → 2026-06-11   2026-06-11 → 2026-06-21   fast=20|slow=40    -1.22%     6.41%       1      na  ▁▂▂▃▄▆▇▆▆▆▆▆▇▇
   4 2026-05-21 → 2026-06-21   2026-06-21 → 2026-07-01   fast=20|slow=40     8.70%    -7.15%       4   -2.49  ██▅▃▃▃▃▄▄▄▄▂▁▁
   5 2026-05-31 → 2026-07-02   2026-07-02 → 2026-07-12   fast=10|slow=40     5.48%     0.38%       5    0.21  ▂▅▆▇█▇▄▃▁▁▂▃▃▃

  aggregate: OOS positive 2/5 · mean IS 2.59% · mean OOS -1.10% · WFE -1.28 · in 387ms
  WFE ≈ 1: the edge holds out of sample · WFE ≪ 1: the sweep fit noise · WFE is per-bar OOS profit ÷ per-bar IS profit
```

Use an expanding in-sample (each window optimizes on all history from bar 0):

```bash
pinerun walkforward examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h \
  --limit 2000 --input fast=5,10,15,20 --input slow=30:100:10 --windows 5 --anchored
```

More windows with a larger OOS share, ranked by Sharpe:

```bash
pinerun walkforward examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h \
  --limit 3000 --input fast=5,10,15,20 --input slow=30:100:10 \
  --windows 8 --oos 0.35 --rank strategy.sharpe
```

Emit the structured report for scripting:

```bash
pinerun walkforward examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h \
  --limit 2000 --input fast=5,10,15,20 --input slow=30:100:10 --json
```

## See also

- [`sweep`](./sweep.md) — the in-sample optimizer this validates.
- [`backtest`](./backtest.md) — inspect the surviving parameters on full history.
- [Command index](./README.md)
