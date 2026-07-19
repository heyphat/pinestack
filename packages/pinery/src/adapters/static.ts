/**
 * Static in-memory provider — for tests, offline replay, and fixtures. Keyed by
 * `symbol` (any timeframe) or the exact `symbol|timeframe` pair when present.
 */
import type { Bar, InstrumentInfo } from '../provider.js';
import { applyRange, type HistoryProvider, type HistoryRange } from '../provider.js';

export class StaticProvider implements HistoryProvider {
  readonly id = 'static';
  private readonly data = new Map<string, Bar[]>();
  private readonly instruments = new Map<string, InstrumentInfo>();

  constructor(seed?: Record<string, Bar[]> | Map<string, Bar[]>) {
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

  /** Register instrument metadata for a symbol (tests / offline fixtures). */
  setInstrument(symbol: string, info: InstrumentInfo): this {
    this.instruments.set(symbol, info);
    return this;
  }

  async instrument(symbol: string): Promise<InstrumentInfo | undefined> {
    return this.instruments.get(symbol);
  }
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
 * Parse OHLCV rows from CSV text. Expects a header row containing the columns
 * `time,open,high,low,close,volume` (order-independent, extra columns ignored).
 * Fields may be RFC 4180-quoted (see `splitCsvLine`). `time` is the bar OPEN
 * time: unix seconds, unix millis (auto-detected), or an ISO string. Rows are
 * sorted ascending; duplicate timestamps keep the last occurrence (a re-export
 * overwrites, it does not double bars). A row with a missing/non-numeric OHLC
 * cell throws with its line number — bad data in a backtest should fail loudly,
 * not run on NaNs.
 */
export function barsFromCsv(text: string): Bar[] {
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
  const byTime = new Map<number, Bar>();
  for (let r = 1; r < rows.length; r++) {
    const { line, no } = rows[r]!;
    const cells = splitCsvLine(line);
    const num = (i: number, name: string): number => {
      const value = Number(cells[i] ?? '');
      if (cells[i] == null || cells[i]!.trim() === '' || !Number.isFinite(value)) {
        throw new Error(`barsFromCsv: line ${no}: bad ${name} "${cells[i] ?? ''}"`);
      }
      return value;
    };
    const rawTime = cells[iTime];
    if (rawTime == null || rawTime.trim() === '') {
      throw new Error(`barsFromCsv: line ${no}: missing time`);
    }
    const bar: Bar = {
      time: parseTime(rawTime.trim(), no),
      open: num(iOpen, 'open'),
      high: num(iHigh, 'high'),
      low: num(iLow, 'low'),
      close: num(iClose, 'close'),
      volume: iVol >= 0 ? num(iVol, 'volume') : 0,
    };
    byTime.set(bar.time, bar);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function parseTime(raw: string, lineNo?: number): number {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 1e11 ? Math.floor(n / 1000) : n; // millis vs seconds heuristic
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    const at = lineNo != null ? `line ${lineNo}: ` : '';
    throw new Error(`barsFromCsv: ${at}bad time "${raw}"`);
  }
  return Math.floor(ms / 1000);
}
