# CSV data files

Run any pinerun analysis command on local CSV files. Point `--data-dir` at the
directory, then either select CSV as the fallback provider or address only the
CSV instruments in a mixed universe:

```bash
# Every bare ticker comes from files.
pinerun backtest strategy.pine --symbol BTCUSDT --tf 1h \
  --provider csv --data-dir ./data

# Only AAPL comes from CSV; BTCUSDT still uses Binance.
pinerun scan strategy.pine --symbols CSV:AAPL,BI:BTCUSDT --tf 1d \
  --provider binance --data-dir ./data
```

CSV-specific evidence flags configure the CSV leaf created by `--data-dir`.
They do **not** require `--provider csv`, so they also work with `CSV:` symbols
in mixed routing.

A runnable sample lives in [`examples/data/`](../examples/data/):

```bash
pinerun backtest examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h \
  --provider csv --data-dir examples/data
```

## File layout

Use one file per symbol and canonical timeframe:

```text
data/
  BTCUSDT_10m.csv
  BTCUSDT_1h.csv
  BTCUSDT_1d.csv
  BTC_USD_1h.csv        # symbol BTC/USD; non-alphanumerics become _
  instruments.csv      # optional sidecar
```

- Exact filenames are `<SYMBOL>_<TF>.csv`, where `<TF>` is a canonical token
  such as `1m`, `10m`, `1h`, `1d`, or `1w`. Matching is case-insensitive.
- Symbols use `_` for each run of non-alphanumeric characters (`BTC/USD` →
  `BTC_USD`), matching `.pinery-cache` naming.
- A CLI-created CSV leaf advertises `timeframes: 'arbitrary'`: exact planning
  discovers every canonical `<SYMBOL>_<TF>.csv` available for that symbol. It
  can therefore use the mapped target file directly or select the largest
  exact divisor available for aggregation.
- A bare `<SYMBOL>.csv` remains a legacy fallback. Its median spacing must match
  the requested timeframe, and one-row fallback files are rejected because
  their spacing cannot be inferred. Complete-record mode never accepts a bare
  fallback; use an explicit `<SYMBOL>_<TF>.csv` contract.

## Row format

```csv
time,open,high,low,close,volume
2024-01-01T00:00:00Z,42000,42500,41800,42350,1234.5
2024-01-01T01:00:00Z,42350,42600,42200,42500,987.1
```

- The header is required. Columns are case-insensitive and order-independent;
  extra columns are ignored. `volume` is optional and defaults to `0`; the
  other five fields are required.
- RFC 4180-quoted fields are accepted. Newlines inside quoted fields are not.
- `time` is the bar **open**. Unix seconds, auto-detected Unix milliseconds,
  and ISO-8601 strings are accepted by ordinary CSV loading. Exact acquisition
  requires the resulting open to be a whole, safe Unix second.
- Every OHLCV value must be finite, with valid OHLC bounds. Exact rows must also
  be strictly ascending, have unique opens, and lie on the asserted UTC or
  exchange-session grid.
- Ordinary `history()` preserves the compatibility behavior: it sorts rows and
  keeps the last row at a duplicate timestamp. Exact acquisition deliberately
  never sorts or deduplicates. An out-of-order or duplicate exact record fails
  rather than silently changing the authenticated dataset.
- Missing or invalid cells fail with their CSV line number.
- `--from`, `--to`, and `--limit` select from the file as usual. In
  complete-record mode the full exact file is parsed and validated before the
  requested range is selected so its authenticated record span is stable.

## Exact acquisition and Bar Magnifier

CSV exact mode is disabled by default because a file alone does not prove its
market-session alignment. Supply one explicit host assertion:

```bash
# Fixed UTC 24×7 grids.
pinerun backtest strategy.pine --symbol CSV:BTCUSDT --tf 1h \
  --data-dir ./data --csv-alignment utc-24x7

# Weekly files may identify any opening timestamp on their weekly grid.
pinerun backtest strategy.pine --symbol CSV:BTCUSDT --tf 1w \
  --data-dir ./data --csv-alignment utc-24x7 --csv-week-anchor 2024-01-01

# Exchange-session grids use a strict calendar document.
pinerun backtest strategy.pine --symbol CSV:AAPL --tf 1d \
  --data-dir ./data --csv-calendar ./data/xnys-calendar.json
```

| Flag                                      | Meaning                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--csv-alignment utc-24x7`                | Assert that every CSV bar uses the UTC fixed 24×7 grid. No other value is accepted.                                                         |
| `--csv-week-anchor <YYYY-MM-DD\|seconds>` | Identify an opening timestamp on the weekly grid. Requires UTC alignment; accepts only a real strict UTC date or safe integer Unix seconds. |
| `--csv-calendar <file.json>`              | Load authoritative exchange-session metadata. The path is required and conflicts with alignment/week-anchor flags.                          |
| `--csv-complete-record`                   | Assert complete-record semantics within each exact file's authenticated span. Requires an explicit alignment or calendar claim.             |

These are assertions about host data. Pinerun validates observed source and
chart grids, but cannot prove that session-market bars were correctly labelled
as 24×7 or that a vendor omitted every no-trade interval consistently. Exact CSV
also does not imply TradingView-feed parity.

A chart-grid failure and a lower-timeframe failure are different diagnostics:
the chart bars themselves must open on the authenticated chart grid, while the
mapped target/source files must independently satisfy their lower-timeframe
grid and coverage. Correctly aligned LTF files cannot make off-grid chart opens
valid, and aligned chart bars cannot repair malformed LTF rows.

Without an alignment/calendar assertion, Bar Magnifier and exact static
`request.security` fail with `unknown-alignment`. Unsupported native/divisor
sets, unsafe timestamps, missing coverage, and malformed grids also fail closed;
nonempty fragments are never treated as exact success.

## Exchange calendar JSON

`--csv-calendar` requires an explicit JSON path. The document mirrors the
history-session contract exactly:

```json
{
  "calendarId": "XNYS",
  "version": "2026a",
  "coverage": { "from": 1767225600, "to": 1798761600 },
  "sessions": [{ "from": 1767364200, "to": 1767387600 }],
  "periods": {
    "1d": [{ "from": 1767364200, "to": 1767387600 }]
  }
}
```

Only `calendarId`, `version`, `coverage`, `sessions`, and optional `periods`
are allowed. Every interval contains only `from` and `to`, uses safe integer
Unix seconds, is half-open (`from < to`), ordered, non-overlapping, and covered
by the calendar envelope. `periods` keys must be canonical day/week timeframes;
their intervals must satisfy the declared session partition. Unknown keys,
unsafe boundaries, overlap, missing files, invalid JSON, and semantic calendar
errors are rejected with the file path and reason. Calendar identity, version,
sessions, and `periods` participate in exact source/proof identity.

## Complete-record assertion

By default CSV uses **bars-only** coverage: only returned bar intervals and
calendar closures prove coverage. A missing active source bar is therefore a
gap, preserving existing fail-closed behavior.

`--csv-complete-record` makes the stronger assertion that each explicit exact
file is the complete source record over its own span, so a missing bar inside
that span means “no trade,” not “missing data.” The span begins at the first bar
open and ends at the final bar's exact effective close. It is authenticated in
source/acquisition identities, magnifier and static-security proofs, worker
transport, and walk-forward prefixes.

Consequences:

- sparse source buckets inside the span may remain covered;
- a partially populated aggregate uses its available source rows in order;
- an empty aggregate bucket emits no target bar but remains covered, allowing
  piner's chart-OHLC fallback for that target bucket;
- a bucket crossing either record edge remains incomplete;
- requests before or after the span remain gaps;
- empty exact files and bare fallback files are rejected;
- a one-row explicitly named file is valid and spans exactly that source bar.

Use this flag only when the producer guarantees the claim. It does not prove
that missing lower-timeframe bars match TradingView's feed.

## Instrument metadata

Exchange providers report lot step and tick size automatically. CSV runs use
piner's defaults (`minQty 0.001`, `mintick 0.01`) unless you pass
`--min-qty`/`--mintick` or provide `instruments.csv`:

```csv
symbol,minQty,mintick
BTCUSDT,0.001,0.1
AAPL,1,0.01
```

`symbol` plus at least one metadata field is required. Blank fields fall through
to defaults; non-blank nonnumeric, zero, or negative values fail with their line
number. Lot step affects derived order sizes and margin-call liquidation; tick
size affects levels and slippage.

## Notes

- CSV files are the storage, so their direct history path bypasses the ordinary
  on-disk cache. Exact identities fingerprint relevant file content and verify
  it again during acquisition.
- Cross-symbol `request.security` follows normal routing. A bare dependency
  resolves against `--provider`; qualify it as `CSV:MSFT` in a mixed universe
  when the dependency must use the CSV leaf. Lower-timeframe requests on the
  addressed chart symbol preserve that symbol address.
- Outside Bar Magnifier exact mode, an unavailable security dependency degrades
  to `na`/`[]` with a warning. Exact mode requires every static dependency and
  does not permit that degradation; `--no-security` cannot bypass it.
- Programmatic use remains backward compatible: `new CsvProvider({ dir })` from
  `@heyphat/pinery/node` defaults to unknown alignment, no advertised exact
  timeframes, and bars-only semantics. Supply `timeframes`, `alignment` or
  `calendar`, and optional `coverageSemantics` explicitly when exact behavior
  is intended.
