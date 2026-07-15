/**
 * Kraken provider — spot OHLC via the keyless public REST API
 * (`/0/public/OHLC`). Kraken's OHLC endpoint returns up to ~720 of the most
 * recent bars for the requested interval (a `since` cursor advances the window
 * but Kraken does not serve arbitrarily deep history here), so `range` is applied
 * as a filter over what Kraken returns.
 */
import type { Bar, InstrumentInfo } from '../provider.js';
import {
  applyRange,
  dropUnclosedBars,
  type HistoryProvider,
  type HistoryRange,
} from '../provider.js';
import { parseTimeframe, type Timeframe } from '../timeframe.js';
import { fetchJson } from '../http.js';
import { normalizeKrakenSpot } from '../symbols.js';

export interface KrakenProviderOptions {
  /** Override the REST base. Default https://api.kraken.com */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

// Kraken OHLC row: [time(sec), open, high, low, close, vwap, volume, count].
type KrakenRow = [number, string, string, string, string, string, string, number];

export class KrakenProvider implements HistoryProvider {
  readonly id = 'kraken';
  readonly assetClass = 'crypto' as const;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: KrakenProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.kraken.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const pair = normalizeKrakenSpot(symbol);
    const interval = toKrakenInterval(timeframe);

    const url = new URL('/0/public/OHLC', this.baseUrl);
    url.searchParams.set('pair', pair);
    url.searchParams.set('interval', String(interval));
    if (range?.from != null) url.searchParams.set('since', String(range.from));

    const payload = await fetchJson<{ error?: string[]; result?: Record<string, unknown> }>(
      url.toString(),
      {
        label: 'kraken /OHLC',
        fetchImpl: this.fetchImpl,
      },
    );
    if (Array.isArray(payload.error) && payload.error.length > 0) {
      throw new Error(`kraken /OHLC: ${payload.error.join(', ')}`);
    }

    const rows = firstOhlcArray(payload.result);
    const bars = rows
      .map(toBar)
      .filter((b): b is Bar => b !== null)
      .sort((a, b) => a.time - b.time);
    // Kraken's last OHLC entry is the current, not-yet-committed frame.
    return applyRange(dropUnclosedBars(bars, timeframe), range);
  }

  /** AssetPairs: lot_decimals → minQty (10^-decimals), tick_size → mintick. */
  async instrument(symbol: string): Promise<InstrumentInfo | undefined> {
    const pair = normalizeKrakenSpot(symbol);
    const url = new URL('/0/public/AssetPairs', this.baseUrl);
    url.searchParams.set('pair', pair);
    const payload = await fetchJson<{
      error?: string[];
      result?: Record<string, { lot_decimals?: number; tick_size?: string }>;
    }>(url.toString(), { label: 'kraken /AssetPairs', fetchImpl: this.fetchImpl });
    if (Array.isArray(payload.error) && payload.error.length > 0) {
      throw new Error(`kraken /AssetPairs: ${payload.error.join(', ')}`);
    }
    const row = payload.result ? Object.values(payload.result)[0] : undefined;
    if (!row) return undefined;
    const minQty = row.lot_decimals != null ? Math.pow(10, -row.lot_decimals) : NaN;
    const mintick = Number(row.tick_size);
    return {
      ...(Number.isFinite(minQty) && minQty > 0 ? { minQty } : {}),
      ...(Number.isFinite(mintick) && mintick > 0 ? { mintick } : {}),
    };
  }
}

/** Kraken supports these OHLC intervals (minutes). */
function toKrakenInterval(tf: Timeframe): number {
  const { n, unit } = parseTimeframe(tf);
  const minutes =
    unit === 'm'
      ? n
      : unit === 'h'
        ? n * 60
        : unit === 'd'
          ? n * 1440
          : unit === 'w'
            ? n * 10080
            : NaN;
  const supported = new Set([1, 5, 15, 30, 60, 240, 1440, 10080, 21600]);
  if (!supported.has(minutes)) {
    throw new Error(`kraken: unsupported timeframe "${tf}" (supported: 1m 5m 15m 30m 1h 4h 1d 1w)`);
  }
  return minutes;
}

/** The OHLC result object is `{ "<pairkey>": rows, last: n }`; return the rows array. */
function firstOhlcArray(result: Record<string, unknown> | undefined): KrakenRow[] {
  if (!result) return [];
  for (const [key, value] of Object.entries(result)) {
    if (key !== 'last' && Array.isArray(value)) return value as KrakenRow[];
  }
  return [];
}

function toBar(r: KrakenRow): Bar | null {
  const time = Number(r[0]);
  if (!Number.isFinite(time)) return null;
  const bar: Bar = {
    time,
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[6]),
  };
  return [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) ? bar : null;
}
