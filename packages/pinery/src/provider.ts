/**
 * The pinery data contract. A `HistoryProvider` yields OHLCV bars for a
 * (symbol, timeframe) over an optional time range. It is deliberately narrower
 * than piner's `DataFeed` (which is what the *engine* consumes) so providers stay
 * simple; `toDataFeed` bridges a provider + a fixed range into a piner `DataFeed`.
 */
import type { Bar, DataFeed } from '@heyphat/piner';
import type { AssetClass } from './asset-class.js';
import { parseTimeframe, timeframeSeconds } from './timeframe.js';

export type { Bar };

/** Half-open-ish selection over a symbol's history. All times are UNIX seconds. */
export interface HistoryRange {
  /** Inclusive lower bound (unix seconds). */
  from?: number;
  /** Inclusive upper bound (unix seconds). */
  to?: number;
  /** Hard cap on the number of bars returned (most-recent when only `limit` is set). */
  limit?: number;
}

/** Per-symbol instrument metadata — the exchange's trading rules for a symbol. */
export interface InstrumentInfo {
  /** Minimum order-quantity step (lot step / minimum contract size). Drives the
   *  broker's TV-parity quantity truncation: derived order sizes and margin-call
   *  liquidation quantities truncate to this step. */
  minQty?: number;
  /** Minimum price increment (tick size) — piner's `syminfo.mintick`. */
  mintick?: number;
}

export interface HistoryProvider {
  /** Stable id used in cache keys and diagnostics (e.g. "binance", "static"). */
  readonly id: string;
  /** Asset class this instance serves; unset for class-agnostic providers (static). */
  readonly assetClass?: AssetClass;
  history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]>;
  /** Optional: the symbol's exchange trading rules (lot step, tick size).
   *  Providers that don't know return undefined; callers fall back to defaults. */
  instrument?(symbol: string): Promise<InstrumentInfo | undefined>;
}

/**
 * Bridge a provider + fixed range into the `DataFeed` piner's `Engine` expects.
 * pinery carries bar times in unix SECONDS; piner expects MILLISECONDS (its
 * daily/weekly/session bucketing uses ms), so times are converted here at the
 * engine boundary. Values already in ms pass through unchanged.
 */
export function toDataFeed(provider: HistoryProvider, range?: HistoryRange): DataFeed {
  return {
    history: async (symbol: string, timeframe: string) => {
      const bars = await provider.history(symbol, timeframe, range);
      return bars.map((b) => (b.time >= 1e12 ? b : { ...b, time: b.time * 1000 }));
    },
  };
}

/**
 * Drop bars whose interval hasn't closed yet (the exchange's in-progress candle).
 * Live endpoints (Binance klines, OKX /market/candles, Kraken OHLC, intraday
 * aggregates) include the currently-forming bar; a backtest that ingests it runs
 * its last bar on incomplete OHLCV. Time-ascending input; trims from the tail.
 */
export function dropUnclosedBars(
  bars: Bar[],
  timeframe: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Bar[] {
  let end = bars.length;
  while (end > 0 && barCloseTime(bars[end - 1]!.time, timeframe) > nowSec) end--;
  return end === bars.length ? bars : bars.slice(0, end);
}

/** Close time (unix seconds) of a bar opened at `openSec`. Months use calendar arithmetic. */
function barCloseTime(openSec: number, timeframe: string): number {
  const { n, unit } = parseTimeframe(timeframe);
  if (unit === 'M') {
    const d = new Date(openSec * 1000);
    return (
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth() + n,
        d.getUTCDate(),
        d.getUTCHours(),
        d.getUTCMinutes(),
        d.getUTCSeconds(),
      ) / 1000
    );
  }
  return openSec + timeframeSeconds(timeframe);
}

/** Apply a `HistoryRange` to an already-materialized, time-ascending bar array. */
export function applyRange(bars: Bar[], range?: HistoryRange): Bar[] {
  if (!range) return bars;
  let out = bars;
  if (range.from != null) out = out.filter((b) => b.time >= range.from!);
  if (range.to != null) out = out.filter((b) => b.time <= range.to!);
  if (range.limit != null && out.length > range.limit) out = out.slice(out.length - range.limit);
  return out;
}
