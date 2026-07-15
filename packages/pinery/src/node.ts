/**
 * @heyphat/pinery/node — Node-only additions. Currently a fetch-once/replay-many
 * on-disk cache so scans and sweeps don't re-hit provider APIs. Never bundled
 * into the browser build.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bar, HistoryProvider, HistoryRange, InstrumentInfo } from './provider.js';

export interface DiskCacheOptions {
  /** Cache directory. Default `.pinery-cache` under the current working directory. */
  dir?: string;
  /** Bypass reads (still writes) — useful for a forced refresh. Default false. */
  refresh?: boolean;
}

/** Wrap a provider so identical (symbol, timeframe, range) requests are served from disk. */
export function cached(provider: HistoryProvider, opts: DiskCacheOptions = {}): HistoryProvider {
  const dir = opts.dir ?? join(process.cwd(), '.pinery-cache');
  const wrapped: HistoryProvider = {
    id: `${provider.id}+cache`,
    async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
      const key = cacheKey(provider.id, symbol, timeframe, range);
      const file = join(dir, `${key}.json`);
      if (!opts.refresh && existsSync(file)) {
        try {
          return JSON.parse(readFileSync(file, 'utf8')) as Bar[];
        } catch {
          // fall through to a fresh fetch on a corrupt cache entry
        }
      }
      const bars = await provider.history(symbol, timeframe, range);
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(bars));
      return bars;
    },
  };
  // Instrument metadata caches like an open-ended range: keyed by UTC day so
  // exchange trading-rule changes surface within a day. Only exposed when the
  // wrapped provider knows how to answer, so capability detection stays honest.
  if (provider.instrument) {
    wrapped.instrument = async (symbol: string): Promise<InstrumentInfo | undefined> => {
      const day = new Date().toISOString().slice(0, 10);
      const safeSym = symbol.replace(/[^a-zA-Z0-9]+/g, '_');
      const file = join(dir, `${provider.id}_${safeSym}_instrument_${day}.json`);
      if (!opts.refresh && existsSync(file)) {
        try {
          return JSON.parse(readFileSync(file, 'utf8')) as InstrumentInfo;
        } catch {
          // fall through on a corrupt entry
        }
      }
      const info = await provider.instrument!(symbol);
      if (info) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, JSON.stringify(info));
      }
      return info;
    };
  }
  return wrapped;
}

function cacheKey(
  providerId: string,
  symbol: string,
  timeframe: string,
  range?: HistoryRange,
): string {
  const payload = JSON.stringify({
    providerId,
    symbol,
    timeframe,
    from: range?.from ?? null,
    to: range?.to ?? null,
    limit: range?.limit ?? null,
    // An open-ended range (no `to`) means "history up to now" — bucket the key by
    // UTC day so the entry expires daily instead of freezing that moment forever.
    day: range?.to == null ? new Date().toISOString().slice(0, 10) : null,
  });
  const hash = createHash('sha1').update(payload).digest('hex').slice(0, 16);
  const safeSym = symbol.replace(/[^a-zA-Z0-9]+/g, '_');
  return `${providerId}_${safeSym}_${timeframe}_${hash}`;
}
