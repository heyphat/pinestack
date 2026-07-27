import type { Bar } from './types.js';

/** A serialized stream of closed, ascending, unix-second bars. */
export interface LiveFeed {
  readonly id: string;
  history(symbol: string, timeframe: string, limit: number): Promise<Bar[]>;
  closedBars(symbol: string, timeframe: string, signal?: AbortSignal): AsyncIterable<Bar>;
  stop(): Promise<void>;
}

export function normalizeClosedBars(bars: readonly Bar[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of bars) {
    if (!Number.isFinite(bar.time) || bar.time < 0)
      throw new RangeError('bar time must be a non-negative unix timestamp');
    for (const key of ['open', 'high', 'low', 'close', 'volume'] as const) {
      if (!Number.isFinite(bar[key])) throw new RangeError(`bar ${bar.time} has invalid ${key}`);
    }
    byTime.set(Math.floor(bar.time >= 1e12 ? bar.time / 1000 : bar.time), {
      ...bar,
      time: Math.floor(bar.time >= 1e12 ? bar.time / 1000 : bar.time),
    });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
