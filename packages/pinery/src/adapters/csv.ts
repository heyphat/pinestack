/*
 * CSV file provider — serves OHLCV history from a directory of CSV files, for
 * backtests on exported/offline data. Node-only (reads the filesystem), so it is
 * exported from `@heyphat/pinery/node`, never the browser-safe main entry.
 *
 * File layout: one file per (symbol, timeframe) named `<SYMBOL>_<TF>.csv` with
 * the symbol sanitized like the disk cache (`[^A-Za-z0-9]+ → _`), e.g.
 * `BTCUSDT_1h.csv`, `BTC_USD_1d.csv`. Matching is case-insensitive. A bare
 * `<SYMBOL>.csv` serves any timeframe, but only after its median bar spacing is
 * checked against the requested timeframe.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type {
  Bar,
  HalfOpenIntervalSec,
  HistoryAcquisition,
  HistoryAlignment,
  HistoryCoverageSemantics,
  HistoryProvider,
  HistoryRange,
  HistoryRequest,
  HistorySessionCalendar,
  InstrumentInfo,
  ResolvedHistorySource,
  UnixSecond,
} from '../provider.js';
import {
  ExactHistoryError,
  applyExactQueryRange,
  applyRange,
  historyRequestRange,
  unixSecond,
} from '../provider.js';
import {
  canonicalTimeframeSecondsExact,
  parseCanonicalTimeframeExact,
  timeframeSeconds,
} from '../timeframe.js';
import {
  createHistoryCacheIdentity,
  historyAcquisitionFromBars,
  historyRecordSpanFromBars,
  snapshotHistoryCapabilities,
  snapshotHistorySessionCalendar,
  snapshotHistoryTimeframes,
  snapshotResolvedHistorySource,
} from '../coverage.js';
import { barsFromCsv, barsFromCsvExact, splitCsvLine } from './static.js';

export interface CsvProviderOptions {
  /** Directory holding `<SYMBOL>_<TF>.csv` files (+ optional `instruments.csv`). */
  dir: string;
  /** Proven bar alignment. Default `unknown`. */
  alignment?: HistoryAlignment;
  /** Opening anchor for UTC week-unit bars; absent means weekly exact mode is unsupported. */
  weekAnchorSec?: UnixSecond;
  /** Required metadata when alignment is `exchange-calendar`. */
  calendar?: HistorySessionCalendar;
  /** Coverage interpretation. Default `bars-only`; complete-record requires explicit alignment. */
  coverageSemantics?: HistoryCoverageSemantics;
  /** Canonical timeframes the files can serve exactly. Default none. */
  timeframes?: readonly string[] | 'arbitrary';
  /** Stable caller-owned dataset/version label for cache separation. */
  cacheIdentity?: string;
}

export class CsvProvider implements HistoryProvider {
  readonly id = 'csv';
  private readonly dir: string;
  private readonly resolvedDir: string;
  private readonly alignment: HistoryAlignment;
  private readonly weekAnchorSec?: UnixSecond;
  private readonly calendar?: HistorySessionCalendar;
  private readonly coverageSemantics: HistoryCoverageSemantics;
  private readonly timeframes: readonly string[] | 'arbitrary';
  private readonly datasetIdentity?: string;
  private readonly parsed = new Map<string, { text: string; bars: Bar[] }>();
  private instruments: Map<string, InstrumentInfo> | null = null;

  constructor(opts: CsvProviderOptions) {
    if (!opts.dir) throw new Error('csv: a data directory is required (options.dir)');
    this.dir = opts.dir;
    this.resolvedDir = resolvePath(opts.dir);
    this.alignment = opts.alignment ?? 'unknown';
    this.weekAnchorSec =
      opts.weekAnchorSec === undefined ? undefined : unixSecond(opts.weekAnchorSec);
    this.calendar = opts.calendar ? snapshotHistorySessionCalendar(opts.calendar) : undefined;
    this.coverageSemantics = opts.coverageSemantics ?? 'bars-only';
    if (this.coverageSemantics !== 'bars-only' && this.coverageSemantics !== 'complete-record') {
      throw new Error(`csv: unsupported coverage semantics "${String(this.coverageSemantics)}"`);
    }
    if (this.coverageSemantics === 'complete-record' && this.alignment === 'unknown') {
      throw new ExactHistoryError({
        kind: 'unsupported',
        code: 'csv-complete-record-alignment-required',
        message:
          'csv: complete-record semantics require explicit UTC or exchange-calendar alignment',
      });
    }
    this.timeframes = snapshotHistoryTimeframes(opts.timeframes ?? []);
    this.datasetIdentity = opts.cacheIdentity;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    return this.loadHistory(symbol, timeframe, range, false);
  }

  private loadHistory(
    symbol: string,
    timeframe: string,
    range: HistoryRange | undefined,
    exactTimestamps: boolean,
  ): Bar[] {
    const exact = `${sanitize(symbol)}_${sanitize(timeframe)}.csv`.toLowerCase();
    const fallback = `${sanitize(symbol)}.csv`.toLowerCase();
    const files = this.scan();
    // Validate the instruments.csv sidecar on the history path as well: pinerun
    // treats instrument() metadata as advisory and swallows its errors, so a
    // typo'd lot step must fail the run here, not silently become defaults.
    this.ensureInstruments();

    const selectRange = exactTimestamps ? applyExactQueryRange : applyRange;
    const selectBars = (bars: Bar[]): Bar[] => {
      const selected = selectRange(bars, range);
      return exactTimestamps ? snapshotExactBars(selected) : selected;
    };
    const exactFile = files.get(exact);
    if (exactFile) return selectBars(this.parse(exactFile, exactTimestamps));

    const fallbackFile = files.get(fallback);
    if (fallbackFile) {
      const bars = this.parse(fallbackFile, exactTimestamps);
      assertSpacingMatches(bars, timeframe, fallbackFile);
      return selectBars(bars);
    }

    const listing = [...files.values()].sort().slice(0, 12);
    throw new Error(
      `csv: no data for "${symbol}" (${timeframe}) in ${this.dir} — ` +
        `looked for ${exact} or ${fallback}` +
        (listing.length > 0 ? `; found: ${listing.join(', ')}` : '; directory has no .csv files'),
    );
  }

  private loadCompleteRecordHistory(
    symbol: string,
    timeframe: string,
    range: HistoryRange | undefined,
  ): { readonly bars: Bar[]; readonly recordSpan: HalfOpenIntervalSec } {
    const exact = `${sanitize(symbol)}_${sanitize(timeframe)}.csv`.toLowerCase();
    const fallback = `${sanitize(symbol)}.csv`.toLowerCase();
    const files = this.scan();
    this.ensureInstruments();
    const exactFile = files.get(exact);
    if (!exactFile) {
      if (files.has(fallback)) {
        throw new ExactHistoryError({
          kind: 'unsupported',
          code: 'csv-complete-record-requires-exact-file',
          message:
            `csv: complete-record semantics require an explicit ${sanitize(symbol)}_` +
            `${timeframe}.csv dataset; bare fallback files are not authoritative`,
          details: { symbol, timeframe },
        });
      }
      throw new Error(`csv: no data for "${symbol}" (${timeframe}) in ${this.dir}`);
    }

    const fullRecord = this.parse(exactFile, true);
    const recordSpan = historyRecordSpanFromBars({
      bars: fullRecord,
      timeframe,
      alignment: this.alignment,
      weekAnchorSec: this.weekAnchorSec,
      calendar: this.calendar,
    });
    const selected = applyExactQueryRange(fullRecord, range);
    return { bars: snapshotExactBars(selected), recordSpan };
  }

  async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
    const normalizedSymbol = sanitize(symbol.trim()).toUpperCase();
    if (!normalizedSymbol) throw new Error('csv: cannot resolve an empty symbol');
    const resolvedTimeframes = this.resolveTimeframes(normalizedSymbol);
    const resolvedRecordSpans = this.resolveRecordSpans(normalizedSymbol, resolvedTimeframes);
    const soleRecordSpan =
      Object.keys(resolvedRecordSpans).length === 1
        ? resolvedRecordSpans[Object.keys(resolvedRecordSpans)[0]!]
        : undefined;
    const resolvedFingerprint = this.fingerprintRelevantFiles(normalizedSymbol);
    const capabilities = snapshotHistoryCapabilities({
      timeframes: resolvedTimeframes,
      alignment: this.alignment,
      ...(this.weekAnchorSec !== undefined ? { weekAnchorSec: this.weekAnchorSec } : {}),
      ...(this.calendar ? { calendar: this.calendar } : {}),
      coverageSemantics: this.coverageSemantics,
      ...(soleRecordSpan ? { recordSpan: soleRecordSpan } : {}),
      ...(Object.keys(resolvedRecordSpans).length > 0 ? { recordSpans: resolvedRecordSpans } : {}),
    });
    const cacheIdentity = createHistoryCacheIdentity(this.id, {
      symbol: normalizedSymbol,
      directory: this.resolvedDir,
      files: resolvedFingerprint,
      dataset: this.datasetIdentity ?? null,
      alignment: capabilities.alignment,
      calendar: capabilities.calendar,
      declaredTimeframes: this.timeframes,
      resolvedTimeframes: capabilities.timeframes,
      filenameMatching: 'case-insensitive-sanitized-v1',
      coverageSemantics: capabilities.coverageSemantics,
      recordSpans: resolvedRecordSpans,
      capabilities,
    });

    return snapshotResolvedHistorySource({
      provider: this,
      normalizedSymbol,
      cacheIdentity,
      capabilities,
      history: async (request: HistoryRequest): Promise<HistoryAcquisition> => {
        if (
          capabilities.timeframes !== 'arbitrary' &&
          !capabilities.timeframes.includes(request.timeframe)
        ) {
          throw new ExactHistoryError({
            kind: 'unsupported',
            code: 'csv-timeframe-unavailable',
            message: `csv: no exact ${request.timeframe} dataset for "${normalizedSymbol}"`,
            details: { normalizedSymbol, timeframe: request.timeframe },
          });
        }
        this.assertResolvedFingerprint(normalizedSymbol, resolvedFingerprint);
        let bars: Bar[];
        let recordSpan: HalfOpenIntervalSec | undefined;
        try {
          if (this.coverageSemantics === 'complete-record') {
            const loaded = this.loadCompleteRecordHistory(
              normalizedSymbol,
              request.timeframe,
              historyRequestRange(request),
            );
            bars = loaded.bars;
            recordSpan = loaded.recordSpan;
          } else {
            bars = this.loadHistory(
              normalizedSymbol,
              request.timeframe,
              historyRequestRange(request),
              true,
            );
          }
        } catch (error) {
          if (error instanceof ExactHistoryError) throw error;
          throw exactCsvLoadError(error, normalizedSymbol, request.timeframe);
        }
        this.assertResolvedFingerprint(normalizedSymbol, resolvedFingerprint);
        return historyAcquisitionFromBars({
          bars,
          request,
          cacheIdentity,
          normalizedSymbol,
          alignment: capabilities.alignment,
          weekAnchorSec: capabilities.weekAnchorSec,
          calendar: capabilities.calendar,
          coverageSemantics: capabilities.coverageSemantics,
          recordSpan,
        });
      },
    });
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
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (err) {
      throw new Error(`csv: cannot read data directory ${this.dir}: ${message(err)}`);
    }
    const files = new Map<string, string>();
    for (const name of names) {
      if (name.toLowerCase().endsWith('.csv')) files.set(name.toLowerCase(), name);
    }
    return files;
  }

  private parse(filename: string, exactTimestamps: boolean): Bar[] {
    const path = join(this.dir, filename);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(`csv: ${path}: ${message(err)}`);
    }
    const key = `${filename}|${exactTimestamps ? 'exact' : 'legacy'}`;
    const cached = this.parsed.get(key);
    if (cached?.text === text) return cached.bars;

    let bars: Bar[];
    try {
      bars = exactTimestamps ? snapshotExactBars(barsFromCsvExact(text)) : barsFromCsv(text, false);
    } catch (err) {
      if (err instanceof ExactHistoryError) throw err;
      throw new Error(`csv: ${path}: ${message(err)}`);
    }
    if (bars.length === 0) throw new Error(`csv: ${path}: no data rows`);
    this.parsed.set(key, { text, bars });
    return bars;
  }

  private resolveTimeframes(symbol: string): readonly string[] {
    const files = this.scan();
    const sanitized = sanitize(symbol).toLowerCase();
    const exactPrefix = `${sanitized}_`;
    const exactTimeframes = new Set<string>();
    for (const name of files.values()) {
      const lower = name.toLowerCase();
      if (!lower.startsWith(exactPrefix) || lower === `${sanitized}.csv`) continue;
      const suffix = lower.slice(exactPrefix.length, -4);
      const parsed = parseCanonicalTimeframeExact(suffix);
      // Matching is case-insensitive, but the timeframe token itself must be
      // canonical. Otherwise discovery could advertise (for example) `01h` as
      // `1h` even though exact loading correctly looks for `<SYMBOL>_1h.csv`.
      if (parsed.kind === 'ok' && parsed.value.canonical === suffix) {
        exactTimeframes.add(parsed.value.canonical);
      }
    }

    const fallbackFile = files.get(`${sanitized}.csv`);
    let fallbackBars: Bar[] | undefined;
    const fallbackSupports = (timeframe: string): boolean => {
      if (!fallbackFile) return false;
      try {
        fallbackBars ??= this.parse(fallbackFile, true);
        assertSpacingMatches(fallbackBars, timeframe, fallbackFile);
        return true;
      } catch {
        return false;
      }
    };

    if (this.timeframes !== 'arbitrary') {
      return [...new Set(this.timeframes)].filter((timeframe) => {
        const hasExact = files.has(`${sanitized}_${sanitize(timeframe)}`.toLowerCase() + '.csv');
        return hasExact || (this.coverageSemantics === 'bars-only' && fallbackSupports(timeframe));
      });
    }

    if (fallbackFile && this.coverageSemantics === 'bars-only') {
      try {
        fallbackBars ??= this.parse(fallbackFile, true);
        const inferred = inferCanonicalTimeframe(fallbackBars);
        if (inferred) exactTimeframes.add(inferred);
      } catch {
        // A malformed fallback cannot advertise exact support; an exact named
        // file for this symbol can still be used independently.
      }
    }
    return [...exactTimeframes].sort((a, b) => a.localeCompare(b));
  }

  private resolveRecordSpans(
    symbol: string,
    timeframes: readonly string[],
  ): Readonly<Record<string, HalfOpenIntervalSec>> {
    if (this.coverageSemantics === 'bars-only') return Object.freeze({});
    const spans: Record<string, HalfOpenIntervalSec> = {};
    for (const timeframe of timeframes) {
      spans[timeframe] = this.loadCompleteRecordHistory(symbol, timeframe, undefined).recordSpan;
    }
    return Object.freeze(spans);
  }

  private fingerprintRelevantFiles(symbol: string): string {
    const sanitized = sanitize(symbol).toLowerCase();
    const names = [...this.scan().values()]
      .filter((name) => {
        const lower = name.toLowerCase();
        return lower === `${sanitized}.csv` || lower.startsWith(`${sanitized}_`);
      })
      .sort((a, b) => a.localeCompare(b));
    const hash = createHash('sha256');
    for (const name of names) {
      hash.update(name.toLowerCase());
      hash.update('\0');
      hash.update(readFileSync(join(this.dir, name)));
      hash.update('\0');
    }
    return hash.digest('hex');
  }

  private assertResolvedFingerprint(symbol: string, expected: string): void {
    let actual: string;
    try {
      actual = this.fingerprintRelevantFiles(symbol);
    } catch (error) {
      throw new ExactHistoryError({
        kind: 'provider-limited',
        code: 'csv-source-changed',
        message: `csv: resolved exact dataset for "${symbol}" is no longer readable; resolve the source again`,
        details: { symbol, reason: message(error) },
      });
    }
    if (actual !== expected) {
      throw new ExactHistoryError({
        kind: 'provider-limited',
        code: 'csv-source-changed',
        message: `csv: resolved exact dataset for "${symbol}" changed; resolve the source again`,
        details: { symbol },
      });
    }
  }

  /**
   * Parse the `instruments.csv` sidecar. Blank cells keep fallback semantics,
   * but a non-blank invalid value throws with its line and column.
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
        if (raw === '') return undefined; // blank → piner's defaults
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
 * must roughly match the requested timeframe. A single-row file has no interval
 * to measure, so it is unverifiable and refused.
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
  const exactDuration = canonicalTimeframeSecondsExact(timeframe);
  const expected = exactDuration.kind === 'ok' ? exactDuration.value : timeframeSeconds(timeframe);
  if (median < expected * 0.75 || median > expected * 1.35) {
    throw new Error(
      `csv: ${filename} has ~${median}s between bars but the run asked for ${timeframe} ` +
        `(~${expected}s); rename the file ${explicitName} if this is intentional`,
    );
  }
}

function inferCanonicalTimeframe(bars: readonly Bar[]): string | undefined {
  if (bars.length < 2) return undefined;
  const diffs: number[] = [];
  const count = Math.min(bars.length, 500);
  for (let index = 1; index < count; index++) {
    diffs.push(bars[index]!.time - bars[index - 1]!.time);
  }
  diffs.sort((a, b) => a - b);
  const seconds = diffs[Math.floor(diffs.length / 2)];
  if (seconds == null || !Number.isSafeInteger(seconds) || seconds <= 0) return undefined;
  const units = [
    ['w', 604800],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ] as const;
  for (const [unit, unitSeconds] of units) {
    if (seconds % unitSeconds === 0) return `${seconds / unitSeconds}${unit}`;
  }
  return undefined;
}

function exactCsvLoadError(
  error: unknown,
  normalizedSymbol: string,
  timeframe: string,
): ExactHistoryError {
  const reason = message(error);
  const unavailable = /no data for|ENOENT|no such file|cannot read data directory/i.test(reason);
  const unsupported = /too few bars|single row|between bars.*asked for/i.test(reason);
  return new ExactHistoryError({
    kind: unavailable ? 'provider-limited' : unsupported ? 'unsupported' : 'malformed',
    code: unavailable
      ? 'csv-data-unavailable'
      : unsupported
        ? 'csv-timeframe-unavailable'
        : 'csv-data-malformed',
    message: `csv: exact data for "${normalizedSymbol}" (${timeframe}) failed: ${reason}`,
    details: { normalizedSymbol, timeframe, reason },
  });
}

function snapshotExactBars(bars: readonly Bar[]): Bar[] {
  const snapshot = bars.map((bar) => Object.freeze({ ...bar }) as Bar);
  return Object.freeze(snapshot) as unknown as Bar[];
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
