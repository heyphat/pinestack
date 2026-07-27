import { barsFromCsv } from '@heyphat/pinery';
import type { LiveFeed } from '../core/feed.js';
import { normalizeClosedBars } from '../core/feed.js';
import { isBarClosed } from '../core/time.js';
import type { Bar } from '../core/types.js';

export interface CsvReplayFeedOptions {
  /** Explicit warmup partition. history() returns at most this many bars. */
  warmupBars?: number;
  paceMs?: number;
  nowSec?: number | (() => number);
}

export class CsvReplayFeed implements LiveFeed {
  readonly id = 'csv-replay';
  private readonly bars: Bar[];
  private historyEnd = 0;
  private stopped = false;

  constructor(
    csvOrBars: string | readonly Bar[],
    private readonly options: CsvReplayFeedOptions = {},
  ) {
    this.bars = normalizeClosedBars(
      typeof csvOrBars === 'string' ? barsFromCsv(csvOrBars) : csvOrBars,
    );
    if (
      options.warmupBars != null &&
      (!Number.isInteger(options.warmupBars) || options.warmupBars < 0)
    ) {
      throw new RangeError('warmupBars must be a non-negative integer');
    }
    if (options.paceMs != null && (!Number.isFinite(options.paceMs) || options.paceMs < 0)) {
      throw new RangeError('paceMs must be non-negative');
    }
  }

  async history(_symbol: string, timeframe: string, limit: number): Promise<Bar[]> {
    if (!Number.isInteger(limit) || limit < 0)
      throw new RangeError('history limit must be a non-negative integer');
    const closed = this.closed(timeframe);
    const configured = this.options.warmupBars ?? limit;
    this.historyEnd = Math.min(closed.length, limit, configured);
    return closed.slice(0, this.historyEnd).map((bar) => ({ ...bar }));
  }

  async *closedBars(_symbol: string, timeframe: string, signal?: AbortSignal): AsyncIterable<Bar> {
    let lastTime =
      this.historyEnd > 0 ? this.closed(timeframe)[this.historyEnd - 1]!.time : -Infinity;
    for (const bar of this.closed(timeframe).slice(this.historyEnd)) {
      if (this.stopped || signal?.aborted) return;
      if (bar.time <= lastTime) continue;
      if ((this.options.paceMs ?? 0) > 0) await wait(this.options.paceMs!, signal);
      if (this.stopped || signal?.aborted) return;
      lastTime = bar.time;
      yield { ...bar };
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  private closed(timeframe: string): Bar[] {
    const now =
      typeof this.options.nowSec === 'function'
        ? this.options.nowSec()
        : (this.options.nowSec ?? Date.now() / 1000);
    return this.bars.filter((bar) => isBarClosed(bar, timeframe, now));
  }
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
