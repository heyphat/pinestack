/**
 * CSV file provider — serves OHLCV history from a directory of CSV files, for
 * backtests on exported/offline data. Node-only (reads the filesystem), so it is
 * exported from `@heyphat/pinery/node`, never the browser-safe main entry.
 *
 * File layout: one file per (symbol, timeframe) named `<SYMBOL>_<TF>.csv` with
 * the symbol sanitized like the disk cache (`[^A-Za-z0-9]+ → _`), e.g.
 * `BTCUSDT_1h.csv`, `BTC_USD_1d.csv`. Matching is case-insensitive. A bare
 * `<SYMBOL>.csv` serves any timeframe, but only after its median bar spacing is
 * checked against the requested timeframe — silently feeding 1h bars to a 1d
 * backtest is the failure mode this provider must not have.
 *
 * Row format (see `barsFromCsv`): header `time,open,high,low,close,volume`,
 * order-independent, extra columns ignored; `time` is the bar OPEN time as unix
 * seconds, unix millis, or an ISO string.
 *
 * Instrument metadata: an optional `instruments.csv` sidecar in the same
 * directory (header `symbol,minQty,mintick`) feeds `instrument()` for TV-parity
 * lot-step / tick-size resolution.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bar, InstrumentInfo } from '../provider.js';
import { applyRange, type HistoryProvider, type HistoryRange } from '../provider.js';
import { timeframeSeconds } from '../timeframe.js';
import { barsFromCsv, splitCsvLine } from './static.js';

export interface CsvProviderOptions {
  /** Directory holding `<SYMBOL>_<TF>.csv` files (+ optional `instruments.csv`). */
  dir: string;
}

export class CsvProvider implements HistoryProvider {
  readonly id = 'csv';
  private readonly dir: string;
  /** lowercase filename → actual filename, scanned once per instance. */
  private files: Map<string, string> | null = null;
  private readonly parsed = new Map<string, Bar[]>();
  private instruments: Map<string, InstrumentInfo> | null = null;

  constructor(opts: CsvProviderOptions) {
    if (!opts.dir) throw new Error('csv: a data directory is required (options.dir)');
    this.dir = opts.dir;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const exact = `${sanitize(symbol)}_${sanitize(timeframe)}.csv`.toLowerCase();
    const fallback = `${sanitize(symbol)}.csv`.toLowerCase();
    const files = this.scan();
    // Validate the instruments.csv sidecar on the history path as well: pinerun
    // treats instrument() metadata as advisory and swallows its errors, so a
    // typo'd lot step must fail the run here, not silently become defaults.
    this.ensureInstruments();

    const exactFile = files.get(exact);
    if (exactFile) return applyRange(this.parse(exactFile), range);

    const fallbackFile = files.get(fallback);
    if (fallbackFile) {
      const bars = this.parse(fallbackFile);
      assertSpacingMatches(bars, timeframe, fallbackFile);
      return applyRange(bars, range);
    }

    const listing = [...files.values()].sort().slice(0, 12);
    throw new Error(
      `csv: no data for "${symbol}" (${timeframe}) in ${this.dir} — ` +
        `looked for ${exact} or ${fallback}` +
        (listing.length > 0 ? `; found: ${listing.join(', ')}` : '; directory has no .csv files'),
    );
  }

  /** Lot step / tick size from the optional `instruments.csv` sidecar. */
  async instrument(symbol: string): Promise<InstrumentInfo | undefined> {
    return this.ensureInstruments().get(sanitize(symbol).toLowerCase());
  }

  private ensureInstruments(): Map<string, InstrumentInfo> {
    if (this.instruments === null) this.instruments = this.loadInstruments();
    return this.instruments;
  }

  private scan(): Map<string, string> {
    if (this.files) return this.files;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (err) {
      throw new Error(`csv: cannot read data directory ${this.dir}: ${message(err)}`);
    }
    this.files = new Map();
    for (const name of names) {
      if (name.toLowerCase().endsWith('.csv')) this.files.set(name.toLowerCase(), name);
    }
    return this.files;
  }

  private parse(filename: string): Bar[] {
    let bars = this.parsed.get(filename);
    if (!bars) {
      const path = join(this.dir, filename);
      try {
        bars = barsFromCsv(readFileSync(path, 'utf8'));
      } catch (err) {
        throw new Error(`csv: ${path}: ${message(err)}`);
      }
      if (bars.length === 0) throw new Error(`csv: ${path}: no data rows`);
      this.parsed.set(filename, bars);
    }
    return bars;
  }

  /**
   * Parse the `instruments.csv` sidecar. Blank cells keep fallback semantics
   * (piner's defaults), but a NON-blank invalid value \u2014 non-numeric, zero, or
   * negative \u2014 throws with its line and column: a typo'd lot step silently
   * becoming the default materially alters fills, truncation, and liquidation
   * while producing plausible-looking results.
   */
  private loadInstruments(): Map<string, InstrumentInfo> {
    const out = new Map<string, InstrumentInfo>();
    const filename = this.scan().get('instruments.csv');
    if (!filename) return out;
    const path = join(this.dir, filename);
    const rows = readFileSync(path, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line, i) => ({ line, no: i + 1 }))
      .filter((r) => r.line.trim().length > 0);
    if (rows.length === 0) return out;
    const header = splitCsvLine(rows[0]!.line).map((h) => h.trim().toLowerCase());
    const iSymbol = header.indexOf('symbol');
    const iMinQty = header.indexOf('minqty');
    const iMintick = header.indexOf('mintick');
    if (iSymbol < 0 || (iMinQty < 0 && iMintick < 0)) {
      throw new Error(`csv: ${path}: header must include symbol plus minQty and/or mintick`);
    }
    for (let r = 1; r < rows.length; r++) {
      const { line, no } = rows[r]!;
      const cells = splitCsvLine(line);
      const symbol = cells[iSymbol]?.trim();
      if (!symbol) throw new Error(`csv: ${path}: line ${no}: missing symbol`);
      const num = (i: number, name: string): number | undefined => {
        if (i < 0) return undefined;
        const raw = (cells[i] ?? '').trim();
        if (raw === '') return undefined; // blank \u2192 piner's defaults
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(
            `csv: ${path}: line ${no}: bad ${name} "${raw}" (must be a positive number)`,
          );
        }
        return value;
      };
      const minQty = num(iMinQty, 'minQty');
      const mintick = num(iMintick, 'mintick');
      const info: InstrumentInfo = {
        ...(minQty != null ? { minQty } : {}),
        ...(mintick != null ? { mintick } : {}),
      };
      if (Object.keys(info).length > 0) out.set(sanitize(symbol).toLowerCase(), info);
    }
    return out;
  }
}

/** Same sanitization as the disk cache, so filenames stay predictable. */
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_');
}

/**
 * Guard the any-timeframe `<SYMBOL>.csv` fallback: the file's median bar spacing
 * must roughly match the requested timeframe. The band is deliberately loose —
 * weekday-only daily data still medians at 86400s, and calendar months wobble
 * around the 30-day nominal — while an order-of-magnitude mismatch (1h bars for
 * a 1d request) is always caught. A single-row file has no interval to measure,
 * so it is unverifiable and refused: the explicit `<SYMBOL>_<TF>.csv` name is
 * how the caller vouches for its timeframe.
 */
function assertSpacingMatches(bars: Bar[], timeframe: string, filename: string): void {
  const explicitName = `${filename.replace(/\.csv$/i, '')}_${timeframe}.csv`;
  if (bars.length < 2) {
    throw new Error(
      `csv: ${filename} has a single row — too few bars to verify its timeframe; ` +
        `name the file ${explicitName} to serve it explicitly`,
    );
  }
  const diffs: number[] = [];
  const n = Math.min(bars.length, 500);
  for (let i = 1; i < n; i++) diffs.push(bars[i]!.time - bars[i - 1]!.time);
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)]!;
  const expected = timeframeSeconds(timeframe);
  if (median < expected * 0.75 || median > expected * 1.35) {
    throw new Error(
      `csv: ${filename} has ~${median}s between bars but the run asked for ${timeframe} ` +
        `(~${expected}s); rename the file ${explicitName} if this is intentional`,
    );
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
