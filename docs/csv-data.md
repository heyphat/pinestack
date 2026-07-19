# CSV data files

Run any pinerun command on **local CSV files** instead of a live provider —
exported exchange data, vendor downloads, or synthetic series. Point
`--data-dir` at a directory of files and either make csv the provider for every
bare ticker (`--provider csv`) or address individual symbols with the `CSV:`
prefix inside a mixed universe.

```bash
# everything from files
pinerun backtest strategy.pine --symbol BTCUSDT --tf 1h \
  --provider csv --data-dir ./data

# mixed: AAPL from a file, BTCUSDT live from binance
pinerun scan strategy.pine --symbols CSV:AAPL,BI:BTCUSDT --tf 1d --data-dir ./data
```

A runnable sample lives in [`examples/data/`](../examples/data/):

```bash
pinerun backtest examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h \
  --provider csv --data-dir examples/data
```

## File layout

One file per (symbol, timeframe), named `<SYMBOL>_<TF>.csv`, all in the data
directory:

```
data/
  BTCUSDT_1h.csv
  BTCUSDT_1d.csv
  BTC_USD_1h.csv        # symbol BTC/USD — non-alphanumerics become _
  instruments.csv       # optional sidecar (see below)
```

- Symbols are sanitized for the filename: every run of non-alphanumeric
  characters becomes `_` (`BTC/USD` → `BTC_USD`), the same convention as the
  `.pinery-cache` filenames. Matching is case-insensitive.
- `<TF>` is the canonical timeframe token you pass to `--tf`: `1m 5m 15m 1h 4h
1d 1w …`.
- A bare `<SYMBOL>.csv` (no timeframe suffix) is accepted as a fallback for any
  timeframe, but only if its median bar spacing roughly matches the requested
  timeframe — a file of 1h bars will refuse to serve a `--tf 1d` run instead of
  silently producing wrong results. A single-row file has no spacing to verify,
  so the fallback refuses it; give it the explicit `<SYMBOL>_<TF>.csv` name.

## Row format

```csv
time,open,high,low,close,volume
2024-01-01T00:00:00Z,42000,42500,41800,42350,1234.5
2024-01-01T01:00:00Z,42350,42600,42200,42500,987.1
```

- **Header row required.** Columns are matched by name (case-insensitive), in
  any order; extra columns are ignored. `volume` is optional (defaults to 0);
  the other five are required.
- Fields may be RFC 4180-quoted (`"time","open",…` — the style most vendor
  exports use); `""` inside a quoted field is a literal quote. Newlines inside
  quoted fields are not supported.
- **`time` is the bar OPEN time**, as unix seconds (`1704067200`), unix
  milliseconds (auto-detected), or an ISO-8601 string (`2024-01-01T00:00:00Z`).
- Rows may be in any order — they are sorted ascending. Duplicate timestamps
  keep the last row (a re-export overwrites, it does not double bars).
- A row with a missing or non-numeric cell fails the run with its line number —
  bad data errors loudly rather than backtesting on NaNs.
- `--from`/`--to`/`--limit` apply as usual, as a filter over the file's rows.

## Instrument metadata

Exchange providers report each symbol's lot step and tick size automatically;
files can't, so runs on CSV data use piner's defaults (`minQty 0.001`, `mintick
0.01`) unless you say otherwise. Either pass `--min-qty`/`--mintick`, or drop an
`instruments.csv` sidecar in the data directory:

```csv
symbol,minQty,mintick
BTCUSDT,0.001,0.1
AAPL,1,0.01
```

`symbol` plus at least one of `minQty`/`mintick`; blank cells fall through to
the defaults, but a non-blank invalid value (non-numeric, zero, or negative)
fails the run with its line number — a typo'd lot step must not silently become
the default. This matters for TradingView parity — the broker truncates derived
order sizes and margin-call liquidation quantities to the lot step, and rounds
levels/slippage to the tick size.

## Notes

- CSV history bypasses the on-disk cache (`.pinery-cache`) — the files _are_
  the storage, so `--no-cache`/`--refresh` don't apply to them.
- Cross-symbol `request.security` dependencies follow the same addressing
  rules as `--symbols`: a bare ticker resolves against `--provider`, so with
  `--provider csv` a script that requests `ETHUSDT` at `1d` needs
  `ETHUSDT_1d.csv` present. In a **mixed universe** (csv addressed per symbol,
  another provider as fallback), qualify the dependency —
  `request.security("CSV:MSFT", …)` — or it goes to the fallback provider. A
  dependency that can't be fetched (e.g. a missing file) degrades to `na` and
  prints a warning naming the dependency — this happens whenever resolution is
  enabled, not only under `--no-security` (which skips resolution entirely and
  degrades everything silently by design). Lower-timeframe requests on the
  chart symbol itself keep its address and need no qualifying.
- Programmatic use: `new CsvProvider({ dir })` from `@heyphat/pinery/node` is a
  regular `HistoryProvider` — pass it straight to `backtest()`, `scan()`, etc.
