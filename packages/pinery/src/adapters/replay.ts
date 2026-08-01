import {
  applyRange,
  assertResolvedDataInstrument,
  barCloseTime,
  MarketDataError,
  normalizeBars,
  throwIfAborted,
  type Bar,
  type BarUpdate,
  type ClosedBarsOptions,
  type HistoryProvider,
  type HistoryRange,
  type LiveBarsOptions,
  type LiveSourcePolicy,
  type MarketDataProvider,
  type ResolvedDataInstrument,
  type ResolvedHistorySource,
  type ResolveDataInstrumentOptions,
} from '../provider.js';
import {
  ExactChildBarAggregator,
  type ExactChildAggregationOptions,
  type ExactChildBucket,
} from '../live/aggregation.js';
import { recoverLiveBarUpdates } from '../live/recovery.js';
import { bufferLiveBarUpdates, conformLiveBarUpdates } from '../live/stream.js';
import {
  liveTimeframeSeconds,
  snapshotLiveSourcePolicy,
  validateBarUpdate,
} from '../live/validation.js';

export interface ReplayBarUpdateTrace {
  readonly symbol: string;
  readonly timeframe: string;
  readonly updates: readonly BarUpdate[];
}

export type ReplayBarUpdateTraces =
  | Readonly<Record<string, readonly BarUpdate[]>>
  | ReadonlyMap<string, readonly BarUpdate[]>
  | readonly ReplayBarUpdateTrace[];

export interface ReplayLowerBarBucketContext {
  readonly symbol: string;
  readonly sourceTimeframe: string;
  readonly targetTimeframe: string;
}

/** Exact provider/session evidence used only by lower-bars Replay subscriptions. */
export interface ReplayLowerBarsOptions {
  /** Explicit fixed grid anchor for UTC/offline fixtures. */
  readonly anchorTime?: number;
  /** Provider/session resolver for chart buckets without one fixed UTC anchor. */
  readonly bucketFor?: (
    childOpen: number,
    context: ReplayLowerBarBucketContext,
  ) => ExactChildBucket;
}

export interface ReplayProviderOptions {
  /** First possible live bar open time, unix seconds. Required. */
  cutoverTime: number;
  /** Virtual venue clock in unix seconds used only to gate closedBars(). */
  clock?: () => number;
  /** Optional unix-millisecond clock used to gate explicit live update events. */
  eventClock?: () => number;
  /** Delay between virtual-clock checks. Default 1,000ms. */
  clockPollIntervalMs?: number;
  /** Injectable cancellation-aware delay for deterministic virtual-clock tests. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  paceMs?: number;
  /** Explicit chart-update fixtures keyed by `symbol|timeframe`. */
  updates?: ReplayBarUpdateTraces;
  /** Alias for callers that name the fixtures by their role. */
  liveUpdates?: ReplayBarUpdateTraces;
  /** Alias for descriptor-style trace fixtures. */
  updateTraces?: ReplayBarUpdateTraces;
  /** Required exact bucket evidence when consuming child-timeframe traces. */
  lowerBars?: ReplayLowerBarsOptions;
  /** Required metadata defaults when the historical source has no instrument() values. */
  instrument?: {
    venueSymbol?: string;
    mintick?: number;
    qtyStep?: number;
    minOrderQty?: number;
    pointValue?: number;
    exchange?: string;
    expiry?: string;
  };
}

/** Cutover-based offline provider implementing the same contract as a network provider. */
export class ReplayProvider implements MarketDataProvider {
  readonly id: string;
  readonly assetClass;
  readonly resolveHistorySource?: (symbol: string) => Promise<ResolvedHistorySource>;
  private stopped = false;
  private readonly issued = new WeakSet<object>();
  private readonly traces: ReadonlyMap<string, readonly BarUpdate[]>;

  constructor(
    private readonly source: HistoryProvider,
    private readonly options: ReplayProviderOptions,
  ) {
    this.id = `${source.id}-replay`;
    this.assetClass = source.assetClass;
    if (!Number.isFinite(options.cutoverTime) || options.cutoverTime < 0) {
      throw new RangeError('replay cutoverTime must be a non-negative unix timestamp');
    }
    for (const [name, value] of [
      ['paceMs', options.paceMs],
      ['clockPollIntervalMs', options.clockPollIntervalMs],
    ] as const) {
      if (value != null && (!Number.isFinite(value) || value < 0)) {
        throw new RangeError(`replay ${name} must be non-negative`);
      }
    }
    const supplied = [options.updates, options.liveUpdates, options.updateTraces].filter(
      (value) => value != null,
    );
    if (supplied.length > 1) {
      throw new RangeError('replay accepts only one of updates, liveUpdates, or updateTraces');
    }
    this.traces = snapshotTraces(supplied[0]);
    if (source.resolveHistorySource) {
      this.resolveHistorySource = (symbol: string) => source.resolveHistorySource!(symbol);
    }
  }

  async resolve(
    strategySymbol: string,
    options: ResolveDataInstrumentOptions = {},
  ): Promise<ResolvedDataInstrument> {
    throwIfAborted(options.signal);
    if (!strategySymbol.trim()) {
      throw new MarketDataError('invalid-symbol', 'replay symbol is required', {
        retryable: false,
      });
    }
    const info = await this.source.instrument?.(strategySymbol);
    throwIfAborted(options.signal);
    const qtyStep = this.options.instrument?.qtyStep ?? info?.minQty;
    const resolved = {
      strategySymbol,
      providerHandle: `${this.source.id}:${strategySymbol}`,
      venueSymbol: this.options.instrument?.venueSymbol ?? strategySymbol,
      mintick: this.options.instrument?.mintick ?? info?.mintick,
      qtyStep,
      minOrderQty: this.options.instrument?.minOrderQty ?? qtyStep,
      pointValue: this.options.instrument?.pointValue,
      exchange: this.options.instrument?.exchange,
      expiry: this.options.instrument?.expiry,
    };
    const instrument = Object.freeze(
      assertResolvedDataInstrument(resolved as ResolvedDataInstrument),
    );
    this.issued.add(instrument);
    return instrument;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const resolved = await this.resolve(symbol);
    return this.historyResolved(resolved, timeframe, range);
  }

  async instrument(symbol: string) {
    return this.source.instrument?.(symbol);
  }

  async historyResolved(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    range?: HistoryRange,
    signal?: AbortSignal,
  ): Promise<Bar[]> {
    this.assertOwned(instrument);
    throwIfAborted(signal);
    const capAtCutover = range?.to == null;
    const sourceRange = {
      ...range,
      ...(capAtCutover ? { to: this.options.cutoverTime - 1 } : {}),
      limit: undefined,
    };
    const bars = normalizeBars(
      await this.source.history(instrument.strategySymbol, timeframe, sourceRange),
    );
    throwIfAborted(signal);
    return applyRange(
      capAtCutover ? bars.filter((bar) => bar.time < this.options.cutoverTime) : bars,
      range,
    ).map((bar) => ({ ...bar }));
  }

  async *closedBars(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    options: ClosedBarsOptions = {},
  ): AsyncIterable<Bar> {
    this.assertOwned(instrument);
    throwIfAborted(options.signal);
    const from = Math.max(this.options.cutoverTime, (options.after ?? -Infinity) + 1);
    const bars = normalizeBars(
      await this.source.history(instrument.strategySymbol, timeframe, { from }),
    );
    let last = options.after ?? -Infinity;
    for (const bar of bars) {
      if (this.stopped || options.signal?.aborted) return;
      if (bar.time < this.options.cutoverTime || bar.time <= last) continue;
      while (barCloseTime(bar.time, timeframe) > this.clock()) {
        await this.sleep(this.options.clockPollIntervalMs ?? 1_000, options.signal);
        if (this.stopped || options.signal?.aborted) return;
      }
      if ((this.options.paceMs ?? 0) > 0) {
        await this.sleep(this.options.paceMs!, options.signal);
      }
      if (this.stopped || options.signal?.aborted) return;
      last = bar.time;
      yield { ...bar };
    }
  }

  liveBars(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    options: LiveBarsOptions,
  ): AsyncIterable<BarUpdate> {
    return bufferLiveBarUpdates(this.replayLiveBarUpdates(instrument, timeframe, options), {
      maxPendingFinals: options?.maxPendingFinals,
      signal: options?.signal,
      teardownTimeoutMs: options?.teardownTimeoutMs,
    });
  }

  private async *replayLiveBarUpdates(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    options: LiveBarsOptions,
  ): AsyncIterable<BarUpdate> {
    this.assertOwned(instrument);
    throwIfAborted(options?.signal);
    if (!options || typeof options !== 'object') {
      throw new RangeError('replay liveBars options are required');
    }
    const source = assertReplayLiveOptions(options, timeframe);
    const traceTimeframe = source.kind === 'native' ? timeframe : source.timeframe;
    const trace = this.traceFor(instrument.strategySymbol, traceTimeframe);
    if (!trace) return;

    // Target-timeframe history is separate final authority. It never creates a
    // forming path, and lower-bars subscriptions consume only the child trace.
    const authoritativeBars = await this.loadAuthoritativeBars(
      instrument.strategySymbol,
      timeframe,
      options,
    );
    if (this.stopped || options.signal?.aborted) return;
    const authoritative = new Map(authoritativeBars.map((bar) => [bar.time, bar] as const));
    const alignedChartOpens = new Set<number>();
    const recovered =
      source.kind === 'native'
        ? recoverLiveBarUpdates(trace, {
            timeframe,
            source,
            cutoverTime: this.options.cutoverTime,
            after: options.after,
            authoritativeBars,
          })
        : this.aggregateLowerBarTrace(
            trace,
            instrument.strategySymbol,
            timeframe,
            source,
            authoritativeBars,
            options,
            alignedChartOpens,
          );
    const conformed = conformLiveBarUpdates(recovered, {
      timeframe,
      source,
      signal: options.signal,
      throttleMs: options.throttleMs,
      maxPendingFinals: options.maxPendingFinals,
      ...(source.kind === 'lower-bars'
        ? { isAlignedOpen: (open: number) => alignedChartOpens.has(open) }
        : {}),
    });
    const deliverable = this.prepareLiveDelivery(conformed, authoritative, options);
    for await (const update of deliverable) {
      if (this.stopped || options.signal?.aborted) return;
      yield update;
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if ('disconnect' in this.source && typeof this.source.disconnect === 'function') {
      await this.source.disconnect();
    }
  }

  private async *aggregateLowerBarTrace(
    trace: readonly BarUpdate[],
    symbol: string,
    targetTimeframe: string,
    source: Extract<LiveSourcePolicy, { readonly kind: 'lower-bars' }>,
    authoritativeBars: readonly Bar[],
    options: LiveBarsOptions,
    alignedChartOpens: Set<number>,
  ): AsyncIterable<BarUpdate> {
    const evidence = this.options.lowerBars;
    if (!evidence || (evidence.anchorTime == null && typeof evidence.bucketFor !== 'function')) {
      throw new RangeError(
        'replay lower-bars requires an explicit anchorTime or provider bucketFor evidence',
      );
    }
    if (evidence.bucketFor != null && typeof evidence.bucketFor !== 'function') {
      throw new RangeError('replay lower-bars bucketFor must be a function');
    }
    const context = Object.freeze({
      symbol,
      sourceTimeframe: source.timeframe,
      targetTimeframe,
    });
    const aggregationOptions: ExactChildAggregationOptions = {
      sourceTimeframe: source.timeframe,
      targetTimeframe,
      ...(evidence.anchorTime == null ? {} : { anchorTime: evidence.anchorTime }),
      ...(evidence.bucketFor
        ? { bucketFor: (childOpen: number) => evidence.bucketFor!(childOpen, context) }
        : {}),
    };
    const aggregator = new ExactChildBarAggregator(aggregationOptions);
    const authoritative = new Map(authoritativeBars.map((bar) => [bar.time, bar] as const));
    const orderedAuthority = [...authoritativeBars].sort((left, right) => left.time - right.time);
    const finalized = new Set<number>();
    let activeParent: number | undefined;
    let activeRevision = 0;
    let activeEventTime = 0;

    for (const input of trace) {
      const rawTime = input?.bar?.time;
      let bucket: ExactChildBucket | undefined;
      if (typeof rawTime === 'number' && Number.isSafeInteger(rawTime) && rawTime >= 0) {
        bucket = aggregator.bucketFor(rawTime);
        if (
          bucket.open < this.options.cutoverTime ||
          (options.after != null && bucket.open <= options.after)
        ) {
          continue;
        }
      }

      const child = validateBarUpdate(input, {
        timeframe: source.timeframe,
        source,
        anchorTime: aggregationOptions.anchorTime,
        sourceEvent: true,
      });
      bucket ??= aggregator.bucketFor(child.bar.time);
      if (activeParent != null && bucket.open > activeParent) {
        throw lowerBarDiscontinuity(
          activeParent,
          targetTimeframe,
          source.timeframe,
          activeEventTime,
        );
      }

      const output = aggregator.accept(child);
      const ownsParent = aggregator.hasParent(bucket.open);
      if (activeParent == null && ownsParent) {
        for (const bar of orderedAuthority) {
          if (bar.time < this.options.cutoverTime || bar.time >= bucket.open) continue;
          if (options.after != null && bar.time <= options.after) continue;
          if (finalized.has(bar.time)) continue;
          const exactBucket = aggregator.bucketFor(bar.time);
          if (exactBucket.open !== bar.time) {
            throw new MarketDataError(
              'malformed-data',
              `replay: authoritative chart bar ${bar.time} lacks exact provider bucket evidence`,
              { retryable: false, details: { time: bar.time } },
            );
          }
          alignedChartOpens.add(bar.time);
          finalized.add(bar.time);
          yield recoveredChartFinal(bar, child.eventTime, source);
        }
        activeParent = bucket.open;
      }

      if (ownsParent) {
        activeEventTime = child.eventTime;
        if (output) activeRevision = output.revision;
      }
      if (output) {
        alignedChartOpens.add(output.bar.time);
        yield output;
      }

      if (activeParent === bucket.open && aggregator.isComplete(bucket.open)) {
        const finalBar = authoritative.get(bucket.open);
        if (!finalBar) continue;
        const final = aggregator.finalize(
          Object.freeze({
            bar: Object.freeze({ ...finalBar }),
            isClose: true,
            revision: 1,
            eventTime: child.eventTime,
            source,
            provenance: Object.freeze({ authority: 'historical-chart' }),
          }),
        );
        alignedChartOpens.add(final.bar.time);
        finalized.add(final.bar.time);
        yield final;
        activeParent = undefined;
        activeRevision = 0;
        activeEventTime = 0;
      }
    }

    if (activeParent != null) {
      throw lowerBarDiscontinuity(
        activeParent,
        targetTimeframe,
        source.timeframe,
        activeEventTime,
        activeRevision,
      );
    }
  }

  private async loadAuthoritativeBars(
    symbol: string,
    timeframe: string,
    options: LiveBarsOptions,
  ): Promise<Bar[]> {
    const retries = options.reconnectAttempts ?? 0;
    const baseDelay = options.reconnectDelayMs ?? 250;
    const maxDelay = options.reconnectMaxDelayMs ?? 30_000;
    let attempt = 0;
    while (true) {
      try {
        return normalizeBars(
          await this.source.history(symbol, timeframe, {
            from: this.options.cutoverTime,
          }),
        );
      } catch (error) {
        if (this.stopped || options.signal?.aborted) return [];
        const classified =
          error instanceof MarketDataError
            ? error
            : new MarketDataError('connectivity', 'replay: live recovery history failed');
        if (!classified.retryable || attempt >= retries) throw classified;
        const delay = Math.min(maxDelay, baseDelay * 2 ** attempt);
        attempt++;
        await this.sleep(delay, options.signal);
        if (this.stopped || options.signal?.aborted) return [];
      }
    }
  }

  private async *prepareLiveDelivery(
    updates: AsyncIterable<BarUpdate>,
    authoritative: ReadonlyMap<number, Bar>,
    options: LiveBarsOptions,
  ): AsyncIterable<BarUpdate> {
    for await (const update of updates) {
      if (this.stopped || options.signal?.aborted) return;
      if (update.isClose) this.assertAuthoritativeFinal(update, authoritative);
      if (options.after != null && update.bar.time <= options.after) continue;
      await this.waitForEvent(update.eventTime, options.signal);
      if ((this.options.paceMs ?? 0) > 0) {
        await this.sleep(this.options.paceMs!, options.signal);
      }
      if (this.stopped || options.signal?.aborted) return;
      yield update;
    }
  }

  private traceFor(symbol: string, timeframe: string): readonly BarUpdate[] | undefined {
    return this.traces.get(`${symbol}|${timeframe}`);
  }

  private assertAuthoritativeFinal(
    update: BarUpdate,
    authoritative: ReadonlyMap<number, Bar>,
  ): void {
    const expected = authoritative.get(update.bar.time);
    if (!expected) {
      throw new MarketDataError(
        'malformed-data',
        `replay: final update ${update.bar.time} has no authoritative history fixture`,
        { retryable: false },
      );
    }
    if (!sameBar(expected, update.bar)) {
      throw new MarketDataError(
        'malformed-data',
        `replay: final update ${update.bar.time} conflicts with authoritative history`,
        { retryable: false },
      );
    }
  }

  private async waitForEvent(eventTime: number, signal?: AbortSignal): Promise<void> {
    if (!this.options.eventClock) return;
    while (eventTime > this.eventClock()) {
      await this.sleep(this.options.clockPollIntervalMs ?? 1_000, signal);
      if (this.stopped || signal?.aborted) return;
    }
  }

  private clock(): number {
    if (!this.options.clock) return Number.POSITIVE_INFINITY;
    const now = this.options.clock();
    if (!Number.isFinite(now) || now < 0) {
      throw new MarketDataError('malformed-data', 'replay clock returned an invalid unix time', {
        retryable: false,
      });
    }
    return now;
  }

  private eventClock(): number {
    const now = this.options.eventClock!();
    if (!Number.isFinite(now) || now < 0) {
      throw new MarketDataError(
        'malformed-data',
        'replay eventClock returned an invalid unix-millisecond time',
        { retryable: false },
      );
    }
    return now;
  }

  private sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return (this.options.sleep ?? wait)(milliseconds, signal);
  }

  private assertOwned(instrument: ResolvedDataInstrument): void {
    if (!this.issued.has(instrument)) {
      throw new MarketDataError(
        'invalid-symbol',
        'resolved instrument was not issued by this provider',
        { retryable: false },
      );
    }
  }
}

function recoveredChartFinal(
  bar: Bar,
  eventTime: number,
  source: Extract<LiveSourcePolicy, { readonly kind: 'lower-bars' }>,
): BarUpdate {
  return Object.freeze({
    bar: Object.freeze({ ...bar }),
    isClose: true,
    revision: 1,
    eventTime,
    source,
    provenance: Object.freeze({ recovery: 'authoritative-history-gap' }),
    recovered: true,
  });
}

function lowerBarDiscontinuity(
  activeBarTime: number,
  targetTimeframe: string,
  sourceTimeframe: string,
  eventTime: number,
  revision?: number,
): MarketDataError {
  return new MarketDataError(
    'live-discontinuity',
    `replay: child trace ended or advanced before chart bar ${activeBarTime} had an authoritative final`,
    {
      retryable: false,
      details: {
        activeBarTime,
        targetTimeframe,
        sourceTimeframe,
        lastEventTime: eventTime,
        ...(revision == null ? {} : { lastRevision: revision }),
      },
    },
  );
}

function assertReplayLiveOptions(options: LiveBarsOptions, timeframe: string): LiveSourcePolicy {
  const targetDuration = liveTimeframeSeconds(timeframe);
  const source = snapshotLiveSourcePolicy(options.source);
  if (source.kind === 'lower-bars') {
    const sourceDuration = liveTimeframeSeconds(source.timeframe);
    if (sourceDuration >= targetDuration || targetDuration % sourceDuration !== 0) {
      throw new RangeError(
        `replay ${source.timeframe} is not an exact child timeframe of ${timeframe}`,
      );
    }
  }
  if (options.after != null && (!Number.isSafeInteger(options.after) || options.after < 0)) {
    throw new RangeError('replay liveBars after must be a non-negative integer unix second');
  }
  for (const [name, value, positive] of [
    ['throttleMs', options.throttleMs, false],
    ['maxPendingFinals', options.maxPendingFinals, true],
    ['teardownTimeoutMs', options.teardownTimeoutMs, false],
    ['reconnectAttempts', options.reconnectAttempts, false],
    ['reconnectDelayMs', options.reconnectDelayMs, false],
    ['reconnectMaxDelayMs', options.reconnectMaxDelayMs, false],
  ] as const) {
    if (value == null) continue;
    if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) {
      throw new RangeError(
        `replay ${name} must be a ${positive ? 'positive' : 'non-negative'} safe integer`,
      );
    }
  }
  if (
    options.reconnectDelayMs != null &&
    options.reconnectMaxDelayMs != null &&
    options.reconnectMaxDelayMs < options.reconnectDelayMs
  ) {
    throw new RangeError('replay reconnectMaxDelayMs must be >= reconnectDelayMs');
  }
  return source;
}

function snapshotTraces(
  input: ReplayBarUpdateTraces | undefined,
): ReadonlyMap<string, readonly BarUpdate[]> {
  const traces = new Map<string, readonly BarUpdate[]>();
  if (!input) return traces;
  const entries: Iterable<readonly [string, readonly BarUpdate[]]> = Array.isArray(input)
    ? input.map((trace) => [`${trace.symbol}|${trace.timeframe}`, trace.updates] as const)
    : input instanceof Map
      ? input.entries()
      : Object.entries(input);
  for (const [key, updates] of entries) {
    const separator = key.lastIndexOf('|');
    if (!key.trim() || separator <= 0 || separator === key.length - 1 || !Array.isArray(updates)) {
      throw new RangeError(
        'replay update traces require an exact symbol|timeframe key and update array',
      );
    }
    if (traces.has(key)) throw new RangeError(`replay update trace key is duplicated: ${key}`);
    traces.set(key, Object.freeze(updates.map(snapshotTraceUpdate)));
  }
  return traces;
}

function snapshotTraceUpdate(update: BarUpdate): BarUpdate {
  const provenance = update?.provenance ? Object.freeze({ ...update.provenance }) : undefined;
  const source =
    update?.source?.kind === 'lower-bars'
      ? Object.freeze({ kind: 'lower-bars' as const, timeframe: update.source.timeframe })
      : Object.freeze({ kind: update?.source?.kind } as { readonly kind: 'native' });
  return Object.freeze({
    ...update,
    bar: update?.bar ? Object.freeze({ ...update.bar }) : update?.bar,
    source,
    ...(provenance ? { provenance } : {}),
  }) as BarUpdate;
}

function sameBar(left: Readonly<Bar>, right: Readonly<Bar>): boolean {
  return (
    left.time === right.time &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    left.volume === right.volume
  );
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
