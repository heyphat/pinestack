/*
 * Static in-memory provider — for tests, offline replay, and fixtures. Keyed by
 * `symbol` (any timeframe) or the exact `symbol|timeframe` pair when present.
 */
import type {
  Bar,
  HistoryAcquisition,
  HistoryAlignment,
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
  createHistoryCacheIdentity,
  historyAcquisitionFromBars,
  snapshotHistoryCapabilities,
  snapshotHistorySessionCalendar,
  snapshotHistoryTimeframes,
  snapshotResolvedHistorySource,
  validateBarsExact,
} from '../coverage.js';

export type StaticProviderSeed = Record<string, Bar[]> | Map<string, Bar[]>;

/** Optional evidence supplied by a fixture owner. Defaults deliberately fail closed. */
export interface StaticProviderOptions {
  /** Proven bar alignment. Default `unknown`. */
  alignment?: HistoryAlignment;
  /** Opening anchor for UTC week-unit bars; absent means weekly exact mode is unsupported. */
  weekAnchorSec?: UnixSecond;
  /** Required metadata when alignment is `exchange-calendar`. */
  calendar?: HistorySessionCalendar;
  /** Canonical timeframes the fixture can serve exactly. Default none. */
  timeframes?: readonly string[] | 'arbitrary';
  /** Stable caller-owned dataset/version label, e.g. `fixture-2025-01`. */
  cacheIdentity?: string;
}

export class StaticProvider implements HistoryProvider {
  readonly id = 'static';
  private readonly data = new Map<string, Bar[]>();
  private readonly instruments = new Map<string, InstrumentInfo>();
  private readonly alignment: HistoryAlignment;
  private readonly weekAnchorSec?: UnixSecond;
  private readonly calendar?: HistorySessionCalendar;
  private readonly timeframes: readonly string[] | 'arbitrary';
  private readonly datasetIdentity?: string;

  constructor(seed?: StaticProviderSeed, opts: StaticProviderOptions = {}) {
    this.alignment = opts.alignment ?? 'unknown';
    this.weekAnchorSec =
      opts.weekAnchorSec === undefined ? undefined : unixSecond(opts.weekAnchorSec);
    this.calendar = opts.calendar ? snapshotHistorySessionCalendar(opts.calendar) : undefined;
    this.timeframes = snapshotHistoryTimeframes(opts.timeframes ?? []);
    this.datasetIdentity = opts.cacheIdentity;
    if (seed) {
      const entries = seed instanceof Map ? seed.entries() : Object.entries(seed);
      for (const [key, bars] of entries) this.set(key, bars);
    }
  }

  /** Register bars under a `symbol` or a specific `symbol|timeframe` key. */
  set(key: string, bars: Bar[]): this {
    this.data.set(
      key,
      [...bars].sort((a, b) => a.time - b.time),
    );
    return this;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const bars = this.data.get(`${symbol}|${timeframe}`) ?? this.data.get(symbol);
    if (!bars) throw new Error(`static: no bars for "${symbol}" (${timeframe})`);
    return applyRange(bars, range);
  }

  async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
    const normalizedSymbol = symbol.trim();
    if (!normalizedSymbol) throw new Error('static: cannot resolve an empty symbol');
    const resolvedData = snapshotStaticData(this.data, normalizedSymbol);
    const resolvedTimeframes = resolveStaticTimeframes(
      resolvedData,
      normalizedSymbol,
      this.timeframes,
    );
    const capabilities = snapshotHistoryCapabilities({
      timeframes: resolvedTimeframes,
      alignment: this.alignment,
      ...(this.weekAnchorSec !== undefined ? { weekAnchorSec: this.weekAnchorSec } : {}),
      ...(this.calendar ? { calendar: this.calendar } : {}),
    });
    const contentFingerprint = await fingerprintStaticData(resolvedData, normalizedSymbol);
    const cacheIdentity = createHistoryCacheIdentity(this.id, {
      symbol: normalizedSymbol,
      dataset: this.datasetIdentity ?? null,
      content: contentFingerprint,
      alignment: capabilities.alignment,
      calendar: capabilities.calendar,
      declaredTimeframes: this.timeframes,
      resolvedTimeframes: capabilities.timeframes,
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
            code: 'static-timeframe-unavailable',
            message: `static: no exact ${request.timeframe} dataset for "${normalizedSymbol}"`,
            details: { normalizedSymbol, timeframe: request.timeframe },
          });
        }
        const sourceBars =
          resolvedData.get(`${normalizedSymbol}|${request.timeframe}`) ??
          resolvedData.get(normalizedSymbol);
        if (!sourceBars) {
          throw new ExactHistoryError({
            kind: 'provider-limited',
            code: 'static-data-unavailable',
            message: `static: resolved data for "${normalizedSymbol}" (${request.timeframe}) is no longer available`,
            details: { normalizedSymbol, timeframe: request.timeframe },
          });
        }
        const bars = applyExactQueryRange(sourceBars, historyRequestRange(request));
        return historyAcquisitionFromBars({
          bars,
          request,
          cacheIdentity,
          normalizedSymbol,
          alignment: capabilities.alignment,
          weekAnchorSec: capabilities.weekAnchorSec,
          calendar: capabilities.calendar,
        });
      },
    });
  }

  /** Register instrument metadata for a symbol (tests / offline fixtures). */
  setInstrument(symbol: string, info: InstrumentInfo): this {
    this.instruments.set(symbol, info);
    return this;
  }

  async instrument(symbol: string): Promise<InstrumentInfo | undefined> {
    return this.instruments.get(symbol);
  }
}

function snapshotStaticData(
  data: ReadonlyMap<string, Bar[]>,
  symbol: string,
): ReadonlyMap<string, Bar[]> {
  const snapshot = new Map<string, Bar[]>();
  for (const [key, bars] of data) {
    if (key !== symbol && !key.startsWith(`${symbol}|`)) continue;
    const immutableBars = bars.map((bar) => Object.freeze({ ...bar }) as Bar);
    snapshot.set(key, Object.freeze(immutableBars) as unknown as Bar[]);
  }
  return snapshot;
}

function resolveStaticTimeframes(
  data: ReadonlyMap<string, Bar[]>,
  symbol: string,
  declared: readonly string[] | 'arbitrary',
): readonly string[] | 'arbitrary' {
  if (data.has(symbol)) return declared === 'arbitrary' ? 'arbitrary' : [...declared];

  const prefix = `${symbol}|`;
  const available = new Set(
    [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)),
  );
  const resolved =
    declared === 'arbitrary'
      ? [...available]
      : declared.filter((timeframe) => available.has(timeframe));
  return [...new Set(resolved)].sort((a, b) => a.localeCompare(b));
}

/** Collision-resistant browser-safe fingerprint over canonical fixture content. */
async function fingerprintStaticData(
  data: ReadonlyMap<string, Bar[]>,
  symbol: string,
): Promise<string> {
  const relevant = [...data.entries()]
    .filter(([key]) => key === symbol || key.startsWith(`${symbol}|`))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bars]) => [
      key,
      bars.map((bar) => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume]),
    ]);
  const bytes = new TextEncoder().encode(JSON.stringify(relevant));
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new ExactHistoryError({
      kind: 'unsupported',
      code: 'static-content-digest-unavailable',
      message: 'static: exact source identity requires the standard Web Crypto digest API',
    });
  }
  const digest = await subtle.digest('SHA-256', bytes);
  return `sha256-${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Split one CSV line into fields, honoring RFC 4180 quoting: a quoted field may
 * contain commas, and `""` inside quotes is a literal quote — so vendor exports
 * that quote every field (`"time","open",…`) parse the same as bare ones.
 * Embedded newlines inside quoted fields are NOT supported (input is pre-split
 * on newlines); OHLCV rows never need them. The quote-free fast path keeps the
 * common case a plain split.
 */
export function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/**
 * Parse OHLCV rows from CSV text for the legacy `history()` surface. Expects a
 * header containing `time,open,high,low,close,volume` (order-independent, extra
 * columns ignored). Fields may be RFC 4180-quoted (see `splitCsvLine`). `time`
 * is the bar OPEN time: unix seconds, unix millis (auto-detected), or an ISO
 * string. Legacy rows are sorted ascending and duplicate timestamps keep the
 * last occurrence (a re-export overwrites, it does not double bars).
 */
export function barsFromCsv(text: string, preserveSubseconds = false): Bar[] {
  const bars = parseCsvRows(text, preserveSubseconds, false);
  const byTime = new Map<number, Bar>();
  for (const bar of bars) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Parse an exact CSV dataset without sorting, deduplicating, or repairing it.
 * Validation deliberately runs over raw file order so malformed rows cannot be
 * hidden by query filtering or legacy normalization.
 */
export function barsFromCsvExact(text: string): Bar[] {
  const bars = parseCsvRows(text, true, true);
  validateBarsExact(bars);
  return bars;
}

function parseCsvRows(
  text: string,
  preserveSubseconds: boolean,
  deferFiniteValidation: boolean,
): Bar[] {
  const rows = text
    .replace(/^\uFEFF/, '') // strip a UTF-8 BOM so the first header cell matches
    .split(/\r?\n/)
    .map((line, i) => ({ line, no: i + 1 }))
    .filter((r) => r.line.trim().length > 0);
  if (rows.length === 0) return [];
  const header = splitCsvLine(rows[0]!.line).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iTime = col('time');
  const iOpen = col('open');
  const iHigh = col('high');
  const iLow = col('low');
  const iClose = col('close');
  const iVol = col('volume');
  if ([iTime, iOpen, iHigh, iLow, iClose].some((i) => i < 0)) {
    throw new Error('barsFromCsv: header must include time,open,high,low,close (volume optional)');
  }

  const bars: Bar[] = [];
  for (let r = 1; r < rows.length; r++) {
    const { line, no } = rows[r]!;
    const cells = splitCsvLine(line);
    const num = (i: number, name: string): number => {
      const value = Number(cells[i] ?? '');
      if (
        cells[i] == null ||
        cells[i]!.trim() === '' ||
        (!deferFiniteValidation && !Number.isFinite(value))
      ) {
        throw new Error(`barsFromCsv: line ${no}: bad ${name} "${cells[i] ?? ''}"`);
      }
      return value;
    };
    const rawTime = cells[iTime];
    if (rawTime == null || rawTime.trim() === '') {
      throw new Error(`barsFromCsv: line ${no}: missing time`);
    }
    bars.push({
      time: parseTime(rawTime.trim(), no, preserveSubseconds),
      open: num(iOpen, 'open'),
      high: num(iHigh, 'high'),
      low: num(iLow, 'low'),
      close: num(iClose, 'close'),
      volume: iVol >= 0 ? num(iVol, 'volume') : 0,
    });
  }
  return bars;
}

function parseTime(raw: string, lineNo?: number, preserveSubseconds = false): number {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 1e11 ? (preserveSubseconds ? n / 1000 : Math.floor(n / 1000)) : n;
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    const at = lineNo != null ? `line ${lineNo}: ` : '';
    throw new Error(`barsFromCsv: ${at}bad time "${raw}"`);
  }
  return preserveSubseconds ? ms / 1000 : Math.floor(ms / 1000);
}
