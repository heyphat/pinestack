/*
 * Binance live provider — public kline WebSocket streams plus the keyless REST
 * history already implemented by `BinanceProvider`.
 *
 * This is the piece that makes `live.cadence: "every-update"` reachable from a
 * configuration instead of only from a hand-built replay trace. It implements the
 * complete `MarketDataProvider` contract, including the optional `liveBars`
 * intrabar stream, for both source policies:
 *
 *   native      subscribe to the chart interval; forming klines become forming
 *               updates and `x: true` becomes the one authoritative final.
 *   lower-bars  subscribe to the child interval and fold children into chart bars
 *               with `ExactChildBarAggregator`. The chart final is published only
 *               once every child slot in the bucket has closed, and its bar is the
 *               exact child aggregation — the children are the authority for a
 *               lower-bars subscription, so no separate REST bar can contradict it.
 *
 * Validation, forming-update throttling, equivalent-final dedupe, the bounded
 * non-droppable final queue, and bounded teardown are NOT reimplemented here. They
 * are the shared `conformLiveBarUpdates` / `bufferLiveBarUpdates` pipeline.
 *
 * Selecting this provider is a DATA decision only. Execution authority remains
 * entirely with `execution.broker` and the pinelive gates above it.
 */
import {
  MarketDataError,
  assertResolvedDataInstrument,
  throwIfAborted,
  type Bar,
  type BarUpdate,
  type ClosedBarsOptions,
  type HistoryRange,
  type LiveBarsOptions,
  type LiveSourcePolicy,
  type MarketDataProvider,
  type ResolveDataInstrumentOptions,
  type ResolvedDataInstrument,
  type ResolvedHistorySource,
} from '../provider.js';
import { ExactChildBarAggregator } from '../live/aggregation.js';
import { bufferLiveBarUpdates, conformLiveBarUpdates } from '../live/stream.js';
import { liveTimeframeSeconds, snapshotLiveSourcePolicy } from '../live/validation.js';
import { BinanceProvider, type BinanceProviderOptions } from './binance.js';

/** One decoded Binance kline payload field set that this adapter depends on. */
interface KlineEvent {
  readonly openTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly closed: boolean;
  readonly eventTime: number;
  readonly interval: string;
}

export interface BinanceLiveProviderOptions extends BinanceProviderOptions {
  /** WebSocket base URL. Defaults per market. */
  wsBaseUrl?: string;
  /**
   * Injectable message transport. Yields raw JSON-decoded stream messages and
   * completes when the connection closes. Tests supply this to stay offline; the
   * default opens a WebSocket to `wsBaseUrl`.
   */
  openStream?: (url: string, signal?: AbortSignal) => AsyncIterable<unknown>;
  /** Injectable cancellation-aware delay. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_WS_SPOT = 'wss://stream.binance.com:9443';
const DEFAULT_WS_FUTURES = 'wss://fstream.binance.com';
const DEFAULT_RECONNECT_ATTEMPTS = 8;
const DEFAULT_RECONNECT_DELAY_MS = 250;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;
/** Hard bound on a single reconnect catch-up so a long outage cannot page forever. */
const MAX_RECOVERY_BARS = 1_000;
/**
 * Extra bars requested so a `limit` of N still yields N CLOSED bars. Two covers the
 * forming bar plus a request that lands across a bar boundary.
 */
const UNCLOSED_BAR_HEADROOM = 2;

export class BinanceLiveProvider implements MarketDataProvider {
  readonly id: string;
  readonly assetClass;
  readonly resolveHistorySource?: (symbol: string) => Promise<ResolvedHistorySource>;
  private readonly history_: BinanceProvider;
  private readonly wsBaseUrl: string;
  private readonly issued = new WeakSet<object>();
  private readonly resolvedCache = new Map<string, ResolvedDataInstrument>();
  private stopped = false;

  constructor(private readonly options: BinanceLiveProviderOptions = {}) {
    this.history_ = new BinanceProvider(options);
    this.id = this.history_.id;
    this.assetClass = this.history_.assetClass;
    this.wsBaseUrl = (
      options.wsBaseUrl ?? (options.market === 'futures' ? DEFAULT_WS_FUTURES : DEFAULT_WS_SPOT)
    ).replace(/\/$/, '');
    if (this.history_.resolveHistorySource) {
      this.resolveHistorySource = (symbol: string) => this.history_.resolveHistorySource!(symbol);
    }
  }

  async resolve(
    symbol: string,
    options: ResolveDataInstrumentOptions = {},
  ): Promise<ResolvedDataInstrument> {
    throwIfAborted(options.signal);
    const cached = this.resolvedCache.get(symbol);
    if (cached) return cached;
    const venueSymbol = symbol.trim().toUpperCase();
    if (!venueSymbol) {
      throw new MarketDataError('invalid-symbol', 'binance: symbol is required', {
        retryable: false,
      });
    }
    const info = await this.history_.instrument(symbol);
    throwIfAborted(options.signal);
    if (!info?.mintick || !info.minQty) {
      throw new MarketDataError(
        'invalid-symbol',
        `binance: exchangeInfo has no tick/step metadata for ${venueSymbol}`,
        { retryable: false },
      );
    }
    const resolved = Object.freeze(
      assertResolvedDataInstrument({
        strategySymbol: symbol,
        providerHandle: `${this.id}:${venueSymbol}`,
        venueSymbol,
        mintick: info.mintick,
        qtyStep: info.minQty,
        minOrderQty: info.minQty,
      }),
    );
    this.resolvedCache.set(symbol, resolved);
    this.issued.add(resolved);
    return resolved;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    return this.history_.history(symbol, timeframe, range);
  }

  async instrument(symbol: string) {
    return this.history_.instrument(symbol);
  }

  /**
   * A live consumer asking for `limit` bars needs `limit` CLOSED bars. The REST
   * endpoint counts the still-forming bar toward its own limit and history then
   * drops it, so a bare pass-through returns one bar short mid-bar. Over-fetch and
   * keep the most recent `limit` closed bars.
   */
  async historyResolved(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    range: HistoryRange = {},
    signal?: AbortSignal,
  ): Promise<Bar[]> {
    this.assertOwned(instrument);
    throwIfAborted(signal);
    if (range.limit == null) {
      return this.history_.history(instrument.strategySymbol, timeframe, range);
    }
    const bars = await this.history_.history(instrument.strategySymbol, timeframe, {
      ...range,
      limit: range.limit + UNCLOSED_BAR_HEADROOM,
    });
    throwIfAborted(signal);
    return bars.length > range.limit ? bars.slice(-range.limit) : bars;
  }

  /** Closed chart bars only — the bar-close cadence path. */
  async *closedBars(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    options: ClosedBarsOptions = {},
  ): AsyncIterable<Bar> {
    this.assertOwned(instrument);
    let cursor = options.after;
    for await (const update of this.streamKlines(
      instrument,
      timeframe,
      { kind: 'native' },
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(cursor != null ? { after: cursor } : {}),
      },
    )) {
      if (!update.isClose) continue;
      if (cursor != null && update.bar.time <= cursor) continue;
      cursor = update.bar.time;
      yield { ...update.bar };
    }
  }

  liveBars(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    options: LiveBarsOptions,
  ): AsyncIterable<BarUpdate> {
    this.assertOwned(instrument);
    if (!options || typeof options !== 'object') {
      throw new RangeError('binance liveBars options are required');
    }
    const source = snapshotLiveSourcePolicy(options.source);
    const chartSeconds = liveTimeframeSeconds(timeframe);
    if (source.kind === 'lower-bars') {
      const childSeconds = liveTimeframeSeconds(source.timeframe);
      if (childSeconds >= chartSeconds || chartSeconds % childSeconds !== 0) {
        throw new MarketDataError(
          'malformed-data',
          `binance: ${source.timeframe} is not an exact child of ${timeframe}`,
          { retryable: false },
        );
      }
    }

    const raw =
      source.kind === 'native'
        ? this.streamKlines(instrument, timeframe, source, options)
        : this.aggregateChildren(
            this.streamKlines(instrument, source.timeframe, source, options),
            timeframe,
            source,
            (bucketOpen, upToExclusive) =>
              this.seedBucketChildren(instrument, source, bucketOpen, upToExclusive),
          );

    const conformed = conformLiveBarUpdates(raw, {
      timeframe,
      source,
      // Binance kline opens are UTC-aligned for every interval this adapter accepts.
      anchorTime: 0,
      ...(options.after == null ? {} : { after: options.after }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.throttleMs == null ? {} : { throttleMs: options.throttleMs }),
      ...(options.maxPendingFinals == null ? {} : { maxPendingFinals: options.maxPendingFinals }),
    });

    return bufferLiveBarUpdates(conformed, {
      ...(options.maxPendingFinals == null ? {} : { maxPendingFinals: options.maxPendingFinals }),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.teardownTimeoutMs == null
        ? {}
        : { teardownTimeoutMs: options.teardownTimeoutMs }),
    });
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
  }

  /**
   * Fold child updates into chart bars. A chart final is emitted only once every
   * child slot has closed, carrying the exact aggregation of those children.
   *
   * Children are dropped until one opens a bucket, so a subscription that starts
   * mid-bucket never produces a chart bar built from a partial child set.
   */
  private async *aggregateChildren(
    children: AsyncIterable<BarUpdate>,
    timeframe: string,
    source: Extract<LiveSourcePolicy, { readonly kind: 'lower-bars' }>,
    seed: (bucketOpen: number, upToExclusive: number) => Promise<readonly BarUpdate[]>,
  ): AsyncIterable<BarUpdate> {
    const aggregator = new ExactChildBarAggregator({
      sourceTimeframe: source.timeframe,
      targetTimeframe: timeframe,
      anchorTime: 0,
    });
    let aligned = false;
    for await (const child of children) {
      // A lower-bars subscription is DEFINED by its child bars: exactly one chart
      // re-evaluation per completed child, so `timeframe: '1m'` means 1m granularity.
      // Binance also streams forming child klines (measured at ~30 per minute, mostly
      // re-reporting an unchanged price). Forwarding those would make the declared
      // child timeframe meaningless, multiply durable ledger rows ~30x, and disagree
      // with ReplayProvider, whose lower-bars traces are completed bars. Sub-child
      // granularity is what `source: { kind: 'native' }` is for.
      if (!child.isClose) continue;
      const bucket = aggregator.bucketFor(child.bar.time);
      if (!aligned) {
        // Subscribing mid-bucket would otherwise cost up to a full chart period of
        // silence, because the aggregator can publish nothing until slot 0 is present
        // and its bounded forming state forbids carrying a partial bucket into the
        // next one. Backfill this bucket's already-closed children from REST so the
        // first snapshot lands immediately and the first final lands at this bucket's
        // own close. An incomplete or non-contiguous backfill is discarded rather than
        // used, which falls back to waiting for the next bucket boundary.
        if (child.bar.time !== bucket.open) {
          const backfill = await seed(bucket.open, child.bar.time).catch(() => []);
          const expected = bucket.slots.filter((slot) => slot < child.bar.time);
          const contiguous =
            backfill.length === expected.length &&
            backfill.every((entry, index) => entry.bar.time === expected[index] && entry.isClose);
          if (!contiguous) continue;
          for (const seeded of backfill) {
            const snapshot = aggregator.accept(seeded);
            if (snapshot) yield snapshot;
          }
        }
        aligned = true;
      }
      const forming = aggregator.accept(child);
      const complete = aggregator.isComplete(bucket.open);
      // On the closing child the forming snapshot and the authoritative final carry
      // the identical aggregated bar, so only the final is published.
      if (forming && !complete) yield forming;
      if (!complete) continue;
      if (!forming) {
        throw new MarketDataError(
          'malformed-data',
          `binance: chart bucket ${bucket.open} completed without an aggregate snapshot`,
          { retryable: false },
        );
      }
      // `forming.bar` is already the exact aggregation of every closed child, which
      // is what `finalize` independently recomputes and compares.
      yield aggregator.finalize(
        Object.freeze({
          bar: Object.freeze({ ...forming.bar }),
          isClose: true,
          revision: 1,
          eventTime: child.eventTime,
          source,
          provenance: Object.freeze({ authority: 'exact-child-aggregation' }),
        }),
      );
    }
  }

  /**
   * One reconnecting kline subscription on `streamTimeframe`. Each reconnect first
   * republishes any closed bar missed while disconnected, read from REST, so a gap
   * surfaces as recovered finals rather than as a silently skipped bar.
   */
  private async *streamKlines(
    instrument: ResolvedDataInstrument,
    streamTimeframe: string,
    source: LiveSourcePolicy,
    options: {
      readonly signal?: AbortSignal;
      readonly after?: number;
      readonly reconnectAttempts?: number;
      readonly reconnectDelayMs?: number;
      readonly reconnectMaxDelayMs?: number;
    },
  ): AsyncIterable<BarUpdate> {
    const duration = liveTimeframeSeconds(streamTimeframe);
    const attempts = options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
    const baseDelay = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    const maxDelay = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    const url =
      `${this.wsBaseUrl}/ws/` + `${instrument.venueSymbol.toLowerCase()}@kline_${streamTimeframe}`;
    const revisions = new Map<number, number>();
    const nextRevision = (open: number): number => {
      const revision = (revisions.get(open) ?? 0) + 1;
      revisions.set(open, revision);
      // Bounded: only the active bar and its immediate predecessor can still revise.
      for (const key of revisions.keys()) if (key < open - duration) revisions.delete(key);
      return revision;
    };

    let cursor = options.after;
    let continuityCursor: number | undefined;
    let attempt = 0;
    let connected = false;
    while (!this.stopped && !options.signal?.aborted) {
      try {
        // Republish bars closed during the outage before resuming the live stream.
        if (connected && cursor != null) {
          for (const bar of await this.recoverClosedBars(instrument, streamTimeframe, cursor)) {
            if (this.stopped || options.signal?.aborted) return;
            cursor = bar.time;
            yield Object.freeze({
              bar: Object.freeze({ ...bar }),
              isClose: true,
              revision: nextRevision(bar.time),
              eventTime: (bar.time + duration) * 1_000,
              source,
              provenance: Object.freeze({ recovery: 'binance-rest-catchup' }),
              recovered: true,
            });
          }
          // A configured history cap can return only the forming tail, which the
          // history provider correctly drops. Keep the cursor until the first
          // adjacent live open proves that an empty/partial catch-up hid no final.
          continuityCursor = cursor;
        }

        for await (const message of this.open(url, options.signal)) {
          if (this.stopped || options.signal?.aborted) return;
          attempt = 0;
          connected = true;
          const kline = decodeKlineMessage(message);
          if (!kline || kline.interval !== streamTimeframe) continue;
          if (continuityCursor != null) {
            const expectedNextOpen = continuityCursor + duration;
            if (kline.openTime > expectedNextOpen) {
              throw new MarketDataError(
                'live-discontinuity',
                `binance: first live ${streamTimeframe} open after recovery is not contiguous`,
                {
                  retryable: false,
                  details: {
                    recoveryCursor: continuityCursor,
                    expectedNextOpen,
                    actualOpen: kline.openTime,
                  },
                },
              );
            }
            if (kline.openTime === expectedNextOpen) continuityCursor = undefined;
          }
          if (kline.closed) cursor = kline.openTime;
          yield Object.freeze({
            bar: Object.freeze({
              time: kline.openTime,
              open: kline.open,
              high: kline.high,
              low: kline.low,
              close: kline.close,
              volume: kline.volume,
            }),
            isClose: kline.closed,
            revision: nextRevision(kline.openTime),
            eventTime: kline.eventTime,
            source,
          });
        }
        if (this.stopped || options.signal?.aborted) return;
        connected = true;
      } catch (error) {
        if (this.stopped || options.signal?.aborted) return;
        const classified =
          error instanceof MarketDataError
            ? error
            : new MarketDataError('connectivity', 'binance: live kline stream failed', {
                cause: error,
              });
        if (!classified.retryable) throw classified;
        if (attempt >= attempts) throw classified;
      }
      if (attempt >= attempts) {
        throw new MarketDataError(
          'connectivity',
          `binance: live kline stream exhausted ${attempts} reconnect attempts`,
        );
      }
      const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
      attempt++;
      await this.delay(delay, options.signal);
    }
  }

  /**
   * The already-closed children of a chart bucket, in order, for `[bucketOpen,
   * upToExclusive)`. Used once at subscription time so a mid-bucket start does not
   * have to discard the current bucket.
   */
  private async seedBucketChildren(
    instrument: ResolvedDataInstrument,
    source: Extract<LiveSourcePolicy, { readonly kind: 'lower-bars' }>,
    bucketOpen: number,
    upToExclusive: number,
  ): Promise<readonly BarUpdate[]> {
    const duration = liveTimeframeSeconds(source.timeframe);
    const bars = await this.history_.history(instrument.strategySymbol, source.timeframe, {
      from: bucketOpen,
      to: upToExclusive - duration,
    });
    return bars
      .filter((bar) => bar.time >= bucketOpen && bar.time < upToExclusive)
      .sort((left, right) => left.time - right.time)
      .map((bar) =>
        Object.freeze({
          bar: Object.freeze({ ...bar }),
          isClose: true,
          revision: 1,
          eventTime: (bar.time + duration) * 1_000,
          source,
          provenance: Object.freeze({ recovery: 'binance-bucket-seed' }),
          recovered: true,
        }),
      );
  }

  /**
   * Bars strictly newer than `after`, in a complete contiguous prefix. Binance
   * history is newest-first, so a capped query can omit the oldest part of a long
   * outage. Reject that condition instead of resuming from discontinuous state.
   */
  private async recoverClosedBars(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    after: number,
  ): Promise<readonly Bar[]> {
    const duration = liveTimeframeSeconds(timeframe);
    const bars = await this.history_.history(instrument.strategySymbol, timeframe, {
      from: after + duration,
      // Headroom exposes a forming tail and lets us distinguish exactly-at-cap
      // recovery from a gap that exceeds the bounded catch-up policy.
      limit: MAX_RECOVERY_BARS + UNCLOSED_BAR_HEADROOM,
    });
    const recovered = bars
      .filter((bar) => bar.time > after)
      .sort((left, right) => left.time - right.time);
    const firstUnexpected = recovered.find(
      (bar, index) => bar.time !== after + duration * (index + 1),
    );
    if (firstUnexpected || recovered.length > MAX_RECOVERY_BARS) {
      throw new MarketDataError(
        'live-discontinuity',
        `binance: reconnect recovery after ${after} is not a contiguous bounded ${timeframe} prefix`,
        {
          retryable: false,
          details: {
            after,
            timeframe,
            maxRecoveryBars: MAX_RECOVERY_BARS,
            recoveredBars: recovered.length,
            ...(firstUnexpected ? { firstUnexpectedTime: firstUnexpected.time } : {}),
          },
        },
      );
    }
    return recovered;
  }

  private open(url: string, signal?: AbortSignal): AsyncIterable<unknown> {
    return this.options.openStream
      ? this.options.openStream(url, signal)
      : openWebSocketStream(url, signal);
  }

  private async delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (this.options.sleep) return this.options.sleep(milliseconds, signal);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  private assertOwned(instrument: ResolvedDataInstrument): void {
    if (!this.issued.has(instrument)) {
      throw new MarketDataError(
        'malformed-data',
        'binance: resolved instrument was not issued by this provider',
        { retryable: false },
      );
    }
  }
}

/** Strict decode. An unrecognized or malformed payload is ignored, never guessed. */
export function decodeKlineMessage(message: unknown): KlineEvent | undefined {
  const envelope = message as { readonly e?: unknown; readonly E?: unknown; readonly k?: unknown };
  if (!envelope || typeof envelope !== 'object') return undefined;
  const kline = envelope.k as Record<string, unknown> | undefined;
  if (envelope.e !== 'kline' || !kline || typeof kline !== 'object') return undefined;
  const openTimeMs = numeric(kline.t);
  const eventTime = numeric(envelope.E) ?? openTimeMs;
  const open = numeric(kline.o);
  const high = numeric(kline.h);
  const low = numeric(kline.l);
  const close = numeric(kline.c);
  const volume = numeric(kline.v);
  const interval = typeof kline.i === 'string' ? kline.i : undefined;
  if (
    openTimeMs == null ||
    eventTime == null ||
    open == null ||
    high == null ||
    low == null ||
    close == null ||
    volume == null ||
    interval == null ||
    typeof kline.x !== 'boolean' ||
    openTimeMs % 1_000 !== 0
  ) {
    return undefined;
  }
  return {
    openTime: openTimeMs / 1_000,
    open,
    high,
    low,
    close,
    volume,
    closed: kline.x,
    eventTime,
    interval,
  };
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Default transport. Completes on close; rejects on socket error. */
function openWebSocketStream(url: string, signal?: AbortSignal): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      const SocketImpl = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
      if (!SocketImpl) {
        throw new MarketDataError(
          'connectivity',
          'binance: no global WebSocket is available; supply openStream',
          { retryable: false },
        );
      }
      const socket = new SocketImpl(url);
      const queue: unknown[] = [];
      let notify: (() => void) | undefined;
      let done = false;
      let failure: unknown;
      const wake = (): void => {
        notify?.();
        notify = undefined;
      };
      socket.onmessage = (event: MessageEvent) => {
        try {
          queue.push(JSON.parse(String(event.data)) as unknown);
        } catch {
          // A single unparsable frame is skipped rather than killing the stream.
        }
        wake();
      };
      socket.onerror = () => {
        failure = new MarketDataError('connectivity', 'binance: kline socket error');
        done = true;
        wake();
      };
      socket.onclose = () => {
        done = true;
        wake();
      };
      const abort = (): void => {
        done = true;
        wake();
        try {
          socket.close();
        } catch {
          // Already closing.
        }
      };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        while (!done || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            continue;
          }
          yield queue.shift();
        }
        if (failure) throw failure;
      } finally {
        signal?.removeEventListener('abort', abort);
        try {
          socket.close();
        } catch {
          // Already closed.
        }
      }
    },
  };
}
