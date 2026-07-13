/**
 * Static in-memory provider — for tests, offline replay, and fixtures. Keyed by
 * `symbol` (any timeframe) or the exact `symbol|timeframe` pair when present.
 */
import type { Bar } from '../provider.js';
import { applyRange, type HistoryProvider, type HistoryRange } from '../provider.js';

export class StaticProvider implements HistoryProvider {
  readonly id = 'static';
  private readonly data = new Map<string, Bar[]>();

  constructor(seed?: Record<string, Bar[]> | Map<string, Bar[]>) {
    if (seed) {
      const entries = seed instanceof Map ? seed.entries() : Object.entries(seed);
      for (const [key, bars] of entries) this.set(key, bars);
    }
  }

  /** Register bars under a `symbol` or a specific `symbol|timeframe` key. */
  set(key: string, bars: Bar[]): this {
    this.data.set(key, [...bars].sort((a, b) => a.time - b.time));
    return this;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const bars = this.data.get(`${symbol}|${timeframe}`) ?? this.data.get(symbol);
    if (!bars) throw new Error(`static: no bars for "${symbol}" (${timeframe})`);
    return applyRange(bars, range);
  }
}

/**
 * Parse OHLCV rows from CSV text. Expects a header row containing the columns
 * `time,open,high,low,close,volume` (order-independent, extra columns ignored).
 * `time` may be unix seconds, unix millis (auto-detected), or an ISO string.
 */
export function barsFromCsv(text: string): Bar[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
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
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r]!.split(',');
    bars.push({
      time: parseTime(cells[iTime]!.trim()),
      open: Number(cells[iOpen]),
      high: Number(cells[iHigh]),
      low: Number(cells[iLow]),
      close: Number(cells[iClose]),
      volume: iVol >= 0 ? Number(cells[iVol]) : 0,
    });
  }
  return bars.sort((a, b) => a.time - b.time);
}

function parseTime(raw: string): number {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 1e11 ? Math.floor(n / 1000) : n; // millis vs seconds heuristic
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new Error(`barsFromCsv: bad time "${raw}"`);
  return Math.floor(ms / 1000);
}
