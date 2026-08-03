import type { Bar } from '@heyphat/piner';
import { bufferLiveBarUpdates, conformLiveBarUpdates } from '../live/stream.js';
import { liveTimeframeSeconds, snapshotLiveSourcePolicy } from '../live/validation.js';
import {
  applyRange,
  assertResolvedDataInstrument,
  barCloseTime,
  MarketDataError,
  normalizeBars,
  throwIfAborted,
  type BarUpdate,
  type ClosedBarsOptions,
  type HistoryRange,
  type LiveBarsOptions,
  type LiveSourcePolicy,
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

/** Transport-neutral snapshot from Tiger's current-minute K-line push. */
export interface TigerKlineUpdate {
  readonly symbol: string;
  /** Bar open as unix seconds or unix milliseconds. */
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  /** Observation time as unix seconds or unix milliseconds. */
  readonly eventTime: number;
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
  /**
   * Optional official push capability. One iterable represents one socket lifetime;
   * completion tells TigerProvider to perform bounded recovery and reconnect.
   */
  openKlineStream?(contract: string, signal?: AbortSignal): AsyncIterable<TigerKlineUpdate>;
  disconnect?(): Promise<void>;
}

export interface TigerProviderOptions {
  transport: TigerMarketDataTransport;
  /** Stable non-secret namespace for caches shared by multiple Tiger profiles. */
  cacheIdentity?: string;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
  now?: () => Date;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const TIGER_PUSH_TIMEFRAME = '1m';
const TIGER_PUSH_SECONDS = 60;
const DEFAULT_RECONNECT_ATTEMPTS = 8;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_RECOVERY_BARS = 1_000;
const RECOVERY_HEADROOM = 2;

export class TigerProvider implements MarketDataProvider {
  readonly id = 'tiger';
  readonly cacheIdentity?: string;
  readonly assetClass = 'futures' as const;
  readonly liveBars?: (
    instrument: ResolvedDataInstrument,
    timeframe: string,
    options: LiveBarsOptions,
  ) => AsyncIterable<BarUpdate>;
  private readonly contracts = new Map<string, Readonly<TigerFutureContract>>();
  private readonly resolved = new Map<string, ResolvedDataInstrument>();
  private readonly issued = new WeakSet<object>();
  private readonly liveControllers = new Set<AbortController>();
  private connected = false;
  private stopped = false;

  constructor(private readonly options: TigerProviderOptions) {
    if (!options.transport) throw new Error('tiger: a market-data transport is required');
    if (
      options.cacheIdentity != null &&
      (typeof options.cacheIdentity !== 'string' || !options.cacheIdentity.trim())
    )
      throw new RangeError('tiger: cacheIdentity must be a non-empty string');
    this.cacheIdentity = options.cacheIdentity;
    for (const [name, value] of [
      ['pollIntervalMs', options.pollIntervalMs],
      ['retryDelayMs', options.retryDelayMs],
      ['maxRetries', options.maxRetries],
    ] as const) {
      if (value != null && (!Number.isFinite(value) || value < 0))
        throw new RangeError(`tiger: ${name} must be non-negative`);
    }
    if (typeof options.transport.openKlineStream === 'function') {
      this.liveBars = (instrument, timeframe, liveOptions) =>
        this.createLiveBars(instrument, timeframe, liveOptions);
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
    this.stopped = true;
    this.connected = false;
    for (const controller of this.liveControllers) controller.abort();
    this.liveControllers.clear();
    try {
      await this.options.transport.disconnect?.();
    } catch (error) {
      throw classifyTigerError(error, 'disconnect');
    }
  }

  private createLiveBars(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    options: LiveBarsOptions,
  ): AsyncIterable<BarUpdate> {
    this.assertOwned(instrument);
    if (!options || typeof options !== 'object') {
      throw new RangeError('tiger liveBars options are required');
    }
    const source = snapshotLiveSourcePolicy(options.source);
    liveTimeframeSeconds(timeframe);
    if (source.kind !== 'native' || timeframe !== TIGER_PUSH_TIMEFRAME) {
      throw new MarketDataError(
        'malformed-data',
        source.kind === 'lower-bars'
          ? 'tiger: lower-bars live aggregation requires authoritative session buckets and is not supported'
          : `tiger: native push supports only ${TIGER_PUSH_TIMEFRAME}`,
        { retryable: false },
      );
    }
    assertReconnectOptions(options);

    const provider = this;
    const liveOptions: LiveBarsOptions = { ...options, source };
    return {
      [Symbol.asyncIterator](): AsyncIterator<BarUpdate> {
        const lifecycle = new AbortController();
        const abort = (): void => lifecycle.abort();
        liveOptions.signal?.addEventListener('abort', abort, { once: true });
        if (liveOptions.signal?.aborted) lifecycle.abort();
        provider.liveControllers.add(lifecycle);
        const cleanup = (): void => {
          liveOptions.signal?.removeEventListener('abort', abort);
          provider.liveControllers.delete(lifecycle);
        };
        try {
          const ownedOptions: LiveBarsOptions = { ...liveOptions, signal: lifecycle.signal };
          const raw = provider.streamMinuteKlines(instrument, source, ownedOptions);
          const conformed = conformLiveBarUpdates(raw, {
            timeframe,
            source,
            anchorTime: 0,
            ...(liveOptions.after == null ? {} : { after: liveOptions.after }),
            signal: lifecycle.signal,
            ...(liveOptions.throttleMs == null ? {} : { throttleMs: liveOptions.throttleMs }),
            ...(liveOptions.maxPendingFinals == null
              ? {}
              : { maxPendingFinals: liveOptions.maxPendingFinals }),
          });
          const buffered = bufferLiveBarUpdates(conformed, {
            ...(liveOptions.maxPendingFinals == null
              ? {}
              : { maxPendingFinals: liveOptions.maxPendingFinals }),
            signal: lifecycle.signal,
            ...(liveOptions.teardownTimeoutMs == null
              ? {}
              : { teardownTimeoutMs: liveOptions.teardownTimeoutMs }),
          });
          return ownLiveStream(buffered, lifecycle, cleanup)[Symbol.asyncIterator]();
        } catch (error) {
          lifecycle.abort();
          cleanup();
          throw error;
        }
      },
    };
  }

  private async *streamMinuteKlines(
    instrument: ResolvedDataInstrument,
    source: LiveSourcePolicy,
    options: LiveBarsOptions,
  ): AsyncIterable<BarUpdate> {
    const openStream = this.options.transport.openKlineStream;
    if (!openStream) {
      throw new MarketDataError('connectivity', 'tiger: push K-line transport is unavailable', {
        retryable: false,
      });
    }
    const attempts = options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
    const baseDelay = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    const maxDelay = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const revisions = new Map<number, number>();
    const nextRevision = (open: number): number => {
      const revision = (revisions.get(open) ?? 0) + 1;
      revisions.set(open, revision);
      for (const key of revisions.keys()) {
        if (key < open - TIGER_PUSH_SECONDS) revisions.delete(key);
      }
      return revision;
    };

    let cursor = options.after;
    let active: BarUpdate | undefined;
    let activeNeedsRefresh = false;
    let attempt = 0;
    let shouldRecover = cursor != null;

    while (!this.stopped && !options.signal?.aborted) {
      try {
        if (shouldRecover) {
          const recoveryAfter =
            cursor ?? (active ? active.bar.time - TIGER_PUSH_SECONDS : undefined);
          if (recoveryAfter != null) {
            const recovered = await this.recoverClosedBars(
              instrument,
              recoveryAfter,
              options.signal,
            );
            if (active && recovered[0] && recovered[0].time !== active.bar.time) {
              throw new MarketDataError(
                'live-discontinuity',
                'tiger: reconnect recovery omitted the active pushed K-line',
                {
                  retryable: false,
                  details: {
                    activeOpen: active.bar.time,
                    firstRecoveredOpen: recovered[0].time,
                  },
                },
              );
            }
            for (const bar of recovered) {
              if (this.stopped || options.signal?.aborted) return;
              const matchingActive = active?.bar.time === bar.time ? active : undefined;
              const eventTime = Math.max(
                (bar.time + TIGER_PUSH_SECONDS) * 1_000,
                matchingActive?.eventTime ?? 0,
              );
              yield Object.freeze({
                bar: Object.freeze({ ...bar }),
                isClose: true,
                revision: nextRevision(bar.time),
                eventTime,
                source,
                provenance: Object.freeze({ recovery: 'tiger-rest-catchup' }),
                recovered: true,
              });
              if (matchingActive) {
                active = undefined;
                activeNeedsRefresh = false;
              }
              cursor = bar.time;
            }
          }
          shouldRecover = false;
        }

        for await (const input of openStream.call(
          this.options.transport,
          instrument.venueSymbol,
          options.signal,
        )) {
          if (this.stopped || options.signal?.aborted) return;
          const kline = normalizeTigerKline(input, instrument.venueSymbol);
          if (cursor != null && kline.bar.time <= cursor) continue;
          if (active && kline.bar.time === active.bar.time && kline.eventTime <= active.eventTime) {
            continue;
          }

          if (active && kline.bar.time < active.bar.time) {
            throw new MarketDataError(
              'malformed-data',
              'tiger: pushed K-line open moved backwards',
              { retryable: false },
            );
          }
          if (active && kline.bar.time > active.bar.time) {
            if (activeNeedsRefresh) {
              throw new MarketDataError(
                'live-discontinuity',
                'tiger: a newer pushed K-line arrived before the active pre-outage bar was refreshed',
                {
                  retryable: false,
                  details: {
                    activeOpen: active.bar.time,
                    newerOpen: kline.bar.time,
                  },
                },
              );
            }
            yield Object.freeze({
              bar: Object.freeze({ ...active.bar }),
              isClose: true,
              revision: nextRevision(active.bar.time),
              eventTime: Math.max(active.eventTime, kline.eventTime),
              source,
              provenance: Object.freeze({ authority: 'tiger-kline-rollover' }),
            });
            cursor = active.bar.time;
            active = undefined;
          }

          const forming: BarUpdate = Object.freeze({
            bar: kline.bar,
            isClose: false,
            revision: nextRevision(kline.bar.time),
            eventTime: kline.eventTime,
            source,
          });
          active = forming;
          activeNeedsRefresh = false;
          attempt = 0;
          yield forming;
        }
        if (this.stopped || options.signal?.aborted) return;
        if (active) activeNeedsRefresh = true;
        shouldRecover = true;
      } catch (error) {
        if (this.stopped || options.signal?.aborted) return;
        if (active) activeNeedsRefresh = true;
        const classified = classifyTigerError(error, 'live K-line stream');
        if (!classified.retryable) throw classified;
        shouldRecover = true;
        if (attempt >= attempts) throw classified;
      }
      if (attempt >= attempts) {
        throw new MarketDataError(
          'connectivity',
          `tiger: live K-line stream exhausted ${attempts} reconnect attempts`,
        );
      }
      const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
      attempt++;
      if (delay === 0) await yieldForRetry(options.signal);
      else await this.sleep(delay, options.signal);
    }
  }

  private async recoverClosedBars(
    instrument: ResolvedDataInstrument,
    after: number,
    signal?: AbortSignal,
  ): Promise<readonly Bar[]> {
    const closedThrough = Math.max(
      0,
      Math.floor((this.options.now?.() ?? new Date()).getTime() / 1_000) - TIGER_PUSH_SECONDS,
    );
    const bars = await this.fetchClosedPages(
      instrument,
      TIGER_PUSH_TIMEFRAME,
      {
        from: after + TIGER_PUSH_SECONDS,
        to: closedThrough,
        limit: MAX_RECOVERY_BARS + RECOVERY_HEADROOM,
      },
      signal,
      true,
    );
    const recovered = bars
      .filter((bar) => bar.time > after)
      .sort((left, right) => left.time - right.time);
    if (recovered.length > MAX_RECOVERY_BARS) {
      throw new MarketDataError(
        'live-discontinuity',
        `tiger: reconnect recovery after ${after} exceeded the bounded 1m result`,
        {
          retryable: false,
          details: {
            after,
            maxRecoveryBars: MAX_RECOVERY_BARS,
            recoveredBars: recovered.length,
          },
        },
      );
    }
    return recovered;
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
      const result = await abortableRequest(
        this.options.transport.bars(
          instrument.venueSymbol,
          timeframe,
          { ...range, ...(cursor ? { cursor } : {}) },
          signal,
        ),
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
          { retryable: false },
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

function normalizeTigerKline(
  input: TigerKlineUpdate,
  contract: string,
): {
  readonly bar: Readonly<Bar>;
  readonly eventTime: number;
} {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.symbol !== 'string' ||
    input.symbol.trim().toUpperCase() !== contract.toUpperCase()
  ) {
    throw new MarketDataError(
      'malformed-data',
      'tiger: pushed K-line symbol does not match subscription',
      {
        retryable: false,
      },
    );
  }
  const time = normalizeUnixTime(input.time, 'bar open');
  if (time % TIGER_PUSH_SECONDS !== 0) {
    throw new MarketDataError('malformed-data', 'tiger: pushed K-line open is not minute-aligned', {
      retryable: false,
    });
  }
  const eventTime = normalizeEventTime(input.eventTime);
  const bar: Bar = {
    time,
    open: input.open,
    high: input.high,
    low: input.low,
    close: input.close,
    volume: input.volume,
  };
  const normalized = normalizeBars([bar])[0]!;
  if (normalized.volume < 0) {
    throw new MarketDataError('malformed-data', 'tiger: pushed K-line has negative volume', {
      retryable: false,
    });
  }
  return { bar: Object.freeze(normalized), eventTime };
}

function normalizeUnixTime(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MarketDataError('malformed-data', `tiger: pushed K-line has invalid ${label}`, {
      retryable: false,
    });
  }
  if (value >= 1e12) {
    if (value % 1_000 !== 0) {
      throw new MarketDataError('malformed-data', `tiger: pushed K-line ${label} is sub-second`, {
        retryable: false,
      });
    }
    return value / 1_000;
  }
  return value;
}

function normalizeEventTime(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new MarketDataError('malformed-data', 'tiger: pushed K-line has invalid event time', {
      retryable: false,
    });
  }
  const milliseconds = value < 1e12 ? value * 1_000 : value;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new MarketDataError('malformed-data', 'tiger: pushed K-line event time is not integral', {
      retryable: false,
    });
  }
  return milliseconds;
}

function assertReconnectOptions(options: LiveBarsOptions): void {
  for (const [name, value] of [
    ['reconnectAttempts', options.reconnectAttempts],
    ['reconnectDelayMs', options.reconnectDelayMs],
    ['reconnectMaxDelayMs', options.reconnectMaxDelayMs],
  ] as const) {
    if (value != null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new RangeError(`tiger: ${name} must be a non-negative safe integer`);
    }
  }
}

function ownLiveStream(
  source: AsyncIterable<BarUpdate>,
  controller: AbortController,
  cleanup: () => void,
): AsyncIterable<BarUpdate> {
  return {
    [Symbol.asyncIterator](): AsyncIterableIterator<BarUpdate> {
      const iterator = source[Symbol.asyncIterator]();
      let closed = false;
      const finish = (): void => {
        if (closed) return;
        closed = true;
        cleanup();
      };
      const owned: AsyncIterableIterator<BarUpdate> = {
        async next() {
          try {
            const result = await iterator.next();
            if (result.done) finish();
            return result;
          } catch (error) {
            finish();
            throw error;
          }
        },
        async return(value?: unknown) {
          controller.abort();
          try {
            return iterator.return
              ? await iterator.return(value as BarUpdate)
              : { done: true, value: value as BarUpdate };
          } finally {
            finish();
          }
        },
        async throw(error?: unknown) {
          controller.abort();
          try {
            if (iterator.throw) return await iterator.throw(error);
            throw error;
          } finally {
            finish();
          }
        },
        [Symbol.asyncIterator]() {
          return owned;
        },
      };
      return owned;
    },
  };
}

function abortableRequest<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = (): void =>
      finish(() =>
        reject(
          new MarketDataError('connectivity', 'market-data request aborted', {
            retryable: false,
          }),
        ),
      );
    signal.addEventListener('abort', abort, { once: true });
    request.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
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

function yieldForRetry(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, 0);
    const abort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
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
