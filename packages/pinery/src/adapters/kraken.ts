/*
 * Kraken provider — spot OHLC via the keyless public REST API
 * (`/0/public/OHLC`). Kraken exposes only a recent window (about 720 bars), so
 * exact acquisitions explicitly report a leading limitation when that window
 * does not reach the requested start.
 */
import type {
  Bar,
  HistoryAcquisition,
  HistoryProvider,
  HistoryRange,
  HistoryRequest,
  HistoryTruncation,
  InstrumentInfo,
  ResolvedHistorySource,
} from '../provider.js';
import {
  applyExactQueryRange,
  applyRange,
  dropUnclosedBars,
  historyRequestRange,
  unixSecond,
} from '../provider.js';
import { parseTimeframe, type Timeframe } from '../timeframe.js';
import { fetchJson } from '../http.js';
import { normalizeKrakenSpot } from '../symbols.js';
import {
  createHistoryCacheIdentity,
  historyAcquisitionFromBars,
  nonSecretBaseUrl,
  snapshotHistoryCapabilities,
  snapshotResolvedHistorySource,
} from '../coverage.js';

const KRAKEN_MAX_BARS = 720;
/** Kraken's 10080-minute OHLC candles are anchored at Unix epoch Thursday UTC. */
const KRAKEN_WEEK_ANCHOR_SEC = unixSecond(0);
const KRAKEN_EXACT_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '15d'] as const;

export interface KrakenProviderOptions {
  /** Override the REST base. Default https://api.kraken.com */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

// Kraken OHLC row: [time(sec), open, high, low, close, vwap, volume, count].
type KrakenRow = [number, string, string, string, string, string, string, number];

interface LoadedHistory {
  readonly bars: Bar[];
  readonly truncated?: HistoryTruncation;
}

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
    return (await this.loadHistory(normalizeKrakenSpot(symbol), timeframe, range)).bars;
  }

  async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
    const normalizedSymbol = normalizeKrakenSpot(symbol);
    const capabilities = snapshotHistoryCapabilities({
      timeframes: [...KRAKEN_EXACT_TIMEFRAMES],
      maxBarsPerRequest: KRAKEN_MAX_BARS,
      maxBarsPerAcquisition: KRAKEN_MAX_BARS,
      alignment: 'utc-24x7',
      weekAnchorSec: KRAKEN_WEEK_ANCHOR_SEC,
    });
    const cacheIdentity = createHistoryCacheIdentity(this.id, {
      symbol: normalizedSymbol,
      baseUrl: nonSecretBaseUrl(this.baseUrl),
      endpoint: '/0/public/OHLC',
      recentWindowBars: KRAKEN_MAX_BARS,
      capabilities,
    });

    return snapshotResolvedHistorySource({
      provider: this,
      normalizedSymbol,
      cacheIdentity,
      capabilities,
      history: async (request: HistoryRequest): Promise<HistoryAcquisition> => {
        const loaded = await this.loadHistory(
          normalizedSymbol,
          request.timeframe,
          historyRequestRange(request),
          true,
        );
        return historyAcquisitionFromBars({
          bars: loaded.bars,
          request,
          cacheIdentity,
          normalizedSymbol,
          alignment: capabilities.alignment,
          weekAnchorSec: capabilities.weekAnchorSec,
          truncated: loaded.truncated,
        });
      },
    });
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

  private async loadHistory(
    pair: string,
    timeframe: string,
    range?: HistoryRange,
    exactTimestamps = false,
  ): Promise<LoadedHistory> {
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

    const completeBars = dropUnclosedBars(
      firstOhlcArray(payload.result)
        .map(toBar)
        .filter((bar): bar is Bar => bar !== null)
        .sort((a, b) => a.time - b.time),
      timeframe,
    );
    const earliest = completeBars[0]?.time;
    const truncated =
      range?.from != null && (earliest == null || range.from < earliest)
        ? ({
            side: 'before',
            reason: 'kraken-recent-window',
            limit: KRAKEN_MAX_BARS,
          } satisfies HistoryTruncation)
        : undefined;

    const bars = exactTimestamps
      ? applyExactQueryRange(completeBars, range)
      : applyRange(completeBars, range);
    return {
      bars,
      ...(truncated ? { truncated } : {}),
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
    throw new Error(
      `kraken: unsupported timeframe "${tf}" (supported: 1m 5m 15m 30m 1h 4h 1d 1w 15d)`,
    );
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

function toBar(row: KrakenRow): Bar | null {
  const time = Number(row[0]);
  if (!Number.isFinite(time)) return null;
  const bar: Bar = {
    time,
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[6]),
  };
  return [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) ? bar : null;
}
