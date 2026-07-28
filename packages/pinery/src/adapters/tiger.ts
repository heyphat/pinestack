import type { Bar } from '@heyphat/piner';
import {
  applyRange,
  assertResolvedDataInstrument,
  barCloseTime,
  MarketDataError,
  normalizeBars,
  throwIfAborted,
  type ClosedBarsOptions,
  type HistoryRange,
  type MarketDataProvider,
  type ResolvedDataInstrument,
  type ResolveDataInstrumentOptions,
} from '../provider.js';

export interface TigerFutureContract {
  contract: string;
  root: string;
  mintick: number;
  qtyStep: number;
  minOrderQty: number;
  pointValue?: number;
  exchange?: string;
  expiry?: string;
}

export interface TigerBarsRequest extends HistoryRange {
  /** Opaque cursor returned by the preceding page. */
  cursor?: string;
}

export interface TigerBarsResult {
  bars: readonly Bar[];
  /** Authoritative Tiger/venue clock, unix seconds. Required when finality is absent. */
  serverTime?: number;
  /** Per-row venue finality, aligned with bars. */
  finality?: readonly boolean[];
  /** Opaque cursor for an older page. Absence means the requested range is complete. */
  nextCursor?: string;
}

/** Production adapters implement this seam without leaking SDK types. */
export interface TigerMarketDataTransport {
  connect?(signal?: AbortSignal): Promise<void>;
  resolveFuture(root: string, now: Date, signal?: AbortSignal): Promise<TigerFutureContract>;
  bars(
    contract: string,
    timeframe: string,
    range: TigerBarsRequest,
    signal?: AbortSignal,
  ): Promise<TigerBarsResult>;
  disconnect?(): Promise<void>;
}

export interface TigerProviderOptions {
  transport: TigerMarketDataTransport;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
  now?: () => Date;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export class TigerProvider implements MarketDataProvider {
  readonly id = 'tiger';
  readonly assetClass = 'futures' as const;
  private readonly contracts = new Map<string, Readonly<TigerFutureContract>>();
  private readonly resolved = new Map<string, ResolvedDataInstrument>();
  private readonly issued = new WeakSet<object>();
  private connected = false;

  constructor(private readonly options: TigerProviderOptions) {
    if (!options.transport) throw new Error('tiger: a market-data transport is required');
    for (const [name, value] of [
      ['pollIntervalMs', options.pollIntervalMs],
      ['retryDelayMs', options.retryDelayMs],
      ['maxRetries', options.maxRetries],
    ] as const) {
      if (value != null && (!Number.isFinite(value) || value < 0))
        throw new RangeError(`tiger: ${name} must be non-negative`);
    }
  }

  async resolve(
    symbol: string,
    options: ResolveDataInstrumentOptions = {},
  ): Promise<ResolvedDataInstrument> {
    throwIfAborted(options.signal);
    const cached = this.resolved.get(symbol);
    if (cached) return cached;
    const root = normalizeRoot(symbol);
    let contract = this.contracts.get(root);
    if (!contract) {
      await this.connect(options.signal);
      throwIfAborted(options.signal);
      try {
        contract = Object.freeze({
          ...(await this.options.transport.resolveFuture(
            root,
            this.options.now?.() ?? new Date(),
            options.signal,
          )),
        });
      } catch (error) {
        throw classifyTigerError(error, 'resolve');
      }
      throwIfAborted(options.signal);
      if (!contract || normalizeRoot(contract.root) !== root || !contract.contract) {
        throw new MarketDataError(
          'invalid-symbol',
          `tiger: could not resolve futures root ${root}`,
          {
            retryable: false,
          },
        );
      }
      this.contracts.set(root, contract);
    }
    const resolved = Object.freeze(
      assertResolvedDataInstrument({
        strategySymbol: symbol,
        providerHandle: `tiger:futures:${contract.contract}`,
        venueSymbol: contract.contract,
        mintick: contract.mintick,
        qtyStep: contract.qtyStep,
        minOrderQty: contract.minOrderQty,
        pointValue: contract.pointValue,
        exchange: contract.exchange,
        expiry: contract.expiry,
      }),
    );
    this.resolved.set(symbol, resolved);
    this.issued.add(resolved);
    return resolved;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const resolved = await this.resolve(symbol, { strict: true });
    return this.historyResolved(resolved, timeframe, range);
  }

  async instrument(symbol: string) {
    const resolved = await this.resolve(symbol, { strict: true });
    return { minQty: resolved.qtyStep, mintick: resolved.mintick };
  }

  async historyResolved(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    range: HistoryRange = {},
    signal?: AbortSignal,
  ): Promise<Bar[]> {
    this.assertOwned(instrument);
    throwIfAborted(signal);
    await this.connect(signal);
    try {
      return await this.fetchClosedPages(instrument, timeframe, range, signal, true);
    } catch (error) {
      throw classifyTigerError(error, 'history');
    }
  }

  async *closedBars(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    options: ClosedBarsOptions = {},
  ): AsyncIterable<Bar> {
    this.assertOwned(instrument);
    let lastSeen = options.after ?? -Infinity;
    let retries = 0;
    while (!options.signal?.aborted) {
      try {
        await this.connect(options.signal);
        const from = Number.isFinite(lastSeen) ? lastSeen : undefined;
        const bars = await this.fetchClosedPages(
          instrument,
          timeframe,
          { ...(from != null ? { from } : {}) },
          options.signal,
          false,
        );
        for (const bar of bars) {
          if (options.signal?.aborted) return;
          if (bar.time <= lastSeen) continue;
          lastSeen = bar.time;
          yield { ...bar };
        }
        retries = 0;
        await this.sleep(this.options.pollIntervalMs ?? 1_000, options.signal);
      } catch (error) {
        if (options.signal?.aborted) return;
        const classified = classifyTigerError(error, 'live bars');
        if (!classified.retryable || retries >= (this.options.maxRetries ?? 5)) throw classified;
        retries++;
        this.connected = false;
        await this.sleep((this.options.retryDelayMs ?? 250) * retries, options.signal);
      }
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    try {
      await this.options.transport.disconnect?.();
    } catch (error) {
      throw classifyTigerError(error, 'disconnect');
    }
  }

  private async fetchClosedPages(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    range: HistoryRange,
    signal: AbortSignal | undefined,
    stopWhenLimitSatisfied: boolean,
  ): Promise<Bar[]> {
    let cursor: string | undefined;
    let bars: Bar[] = [];
    const seenCursors = new Set<string>();
    for (let page = 0; ; page++) {
      if (page >= 10_000)
        throw new MarketDataError(
          'malformed-data',
          'tiger: bars pagination exceeded safety limit',
          {
            retryable: false,
          },
        );
      throwIfAborted(signal);
      const result = await this.options.transport.bars(
        instrument.venueSymbol,
        timeframe,
        { ...range, ...(cursor ? { cursor } : {}) },
        signal,
      );
      throwIfAborted(signal);
      bars = normalizeBars([...bars, ...closedTigerBars(result, timeframe)]);
      if (
        stopWhenLimitSatisfied &&
        range.limit != null &&
        applyRange(bars, range).length >= range.limit
      )
        break;
      const nextCursor = result.nextCursor;
      if (nextCursor == null) break;
      if (!nextCursor || seenCursors.has(nextCursor))
        throw new MarketDataError(
          'malformed-data',
          'tiger: bars pagination cursor did not advance',
          {
            retryable: false,
          },
        );
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return applyRange(bars, range).map((bar) => ({ ...bar }));
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    if (this.connected) return;
    throwIfAborted(signal);
    try {
      await this.options.transport.connect?.(signal);
      this.connected = true;
    } catch (error) {
      throw classifyTigerError(error, 'connect');
    }
  }

  private assertOwned(instrument: ResolvedDataInstrument): void {
    if (!this.issued.has(instrument))
      throw new MarketDataError(
        'invalid-symbol',
        'resolved instrument was not issued by this provider',
        { retryable: false },
      );
  }

  private sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return (this.options.sleep ?? abortableSleep)(milliseconds, signal);
  }
}

function normalizeRoot(symbol: string): string {
  const root = symbol
    .trim()
    .toUpperCase()
    .replace(/^TG(?::FU)?:/, '');
  if (!root || !/^[A-Z0-9._-]+$/.test(root))
    throw new MarketDataError('invalid-symbol', 'tiger: invalid futures root', {
      retryable: false,
    });
  return root;
}

function closedTigerBars(result: TigerBarsResult, timeframe: string): Bar[] {
  if (!result || !Array.isArray(result.bars))
    throw new MarketDataError('malformed-data', 'tiger: malformed bars response', {
      retryable: false,
    });
  if (result.finality && result.finality.length !== result.bars.length)
    throw new MarketDataError('malformed-data', 'tiger: finality length does not match bars', {
      retryable: false,
    });
  if (!result.finality && !Number.isFinite(result.serverTime))
    throw new MarketDataError(
      'malformed-data',
      'tiger: bars response lacks authoritative finality',
      { retryable: false },
    );
  const closed = result.bars.filter((bar, index) =>
    result.finality
      ? result.finality[index] === true
      : barCloseTime(bar.time >= 1e12 ? Math.floor(bar.time / 1000) : bar.time, timeframe) <=
        result.serverTime!,
  );
  return normalizeBars(closed);
}

function classifyTigerError(error: unknown, operation: string): MarketDataError {
  if (error instanceof MarketDataError) return error;
  const value = error as { code?: string; message?: string } | null;
  const raw = `${value?.code ?? ''} ${value?.message ?? ''}`.toLowerCase();
  const code =
    raw.includes('auth') || raw.includes('credential')
      ? 'auth'
      : raw.includes('entitle') || raw.includes('permission')
        ? 'entitlement'
        : raw.includes('rate') || raw.includes('429')
          ? 'rate-limit'
          : raw.includes('symbol') || raw.includes('contract')
            ? 'invalid-symbol'
            : raw.includes('malformed') || raw.includes('parse')
              ? 'malformed-data'
              : 'connectivity';
  return new MarketDataError(code, `tiger: ${operation} failed`);
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || milliseconds === 0) return resolve();
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
