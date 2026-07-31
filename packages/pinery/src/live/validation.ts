import { MarketDataError, type Bar, type BarUpdate, type LiveSourcePolicy } from '../provider.js';
import { canonicalTimeframeSecondsExact } from '../timeframe.js';

export const DEFAULT_MAX_FORMING_BARS = 1;
export const DEFAULT_FINAL_DEDUPE_BARS = 256;

export interface BarUpdateValidationOptions {
  readonly timeframe: string;
  readonly source?: LiveSourcePolicy;
  /** Explicit provider/session grid anchor in unix seconds. Default 0 for UTC fixtures. */
  readonly anchorTime?: number;
  /** Exact provider/session evidence for chart opens that do not share one fixed anchor. */
  readonly isAlignedOpen?: (open: number) => boolean;
  readonly maxFormingBars?: number;
  /** Internal raw-child validation: the policy timeframe is the event grid itself. */
  readonly sourceEvent?: boolean;
  /** Bounded equivalent-final dedupe window. Default 256 bars. */
  readonly maxFinalizedBars?: number;
}

interface FormingState {
  readonly revision: number;
}

/** Validate one update's shape and return a detached, deeply frozen snapshot. */
export function validateBarUpdate(
  input: BarUpdate,
  options: Pick<
    BarUpdateValidationOptions,
    'timeframe' | 'source' | 'anchorTime' | 'isAlignedOpen' | 'sourceEvent'
  >,
): BarUpdate {
  const duration = liveTimeframeSeconds(options.timeframe);
  const anchor = options.anchorTime ?? 0;
  if (!Number.isSafeInteger(anchor)) {
    throw malformed('live bar anchorTime must be a safe unix second', { anchorTime: anchor });
  }

  const value = input as BarUpdate;
  const bar = value?.bar as Readonly<Bar>;
  if (!bar || typeof bar !== 'object') throw malformed('live update bar is required');
  if (!Number.isSafeInteger(bar.time) || bar.time < 0) {
    throw malformed('live bar open must be a non-negative integer unix second', {
      time: bar.time,
    });
  }
  const aligned = options.isAlignedOpen
    ? options.isAlignedOpen(bar.time) === true
    : (bar.time - anchor) % duration === 0;
  if (!aligned) {
    throw malformed(`live bar open ${bar.time} is not aligned to ${options.timeframe}`, {
      time: bar.time,
      timeframe: options.timeframe,
      anchorTime: anchor,
    });
  }
  for (const field of ['open', 'high', 'low', 'close', 'volume'] as const) {
    if (!Number.isFinite(bar[field])) {
      throw malformed(`live bar ${bar.time} has invalid ${field}`, {
        time: bar.time,
        field,
      });
    }
  }
  if (bar.volume < 0) {
    throw malformed(`live bar ${bar.time} has negative volume`, { time: bar.time });
  }
  if (
    bar.high < Math.max(bar.open, bar.close, bar.low) ||
    bar.low > Math.min(bar.open, bar.close, bar.high)
  ) {
    throw malformed(`live bar ${bar.time} has inconsistent OHLC values`, { time: bar.time });
  }

  if (!Number.isSafeInteger(value.revision) || value.revision <= 0) {
    throw malformed('live bar revision must be a positive safe integer', {
      time: bar.time,
      revision: value.revision,
    });
  }
  if (!Number.isFinite(value.eventTime) || value.eventTime < 0) {
    throw malformed('live bar eventTime must be a non-negative finite unix millisecond', {
      time: bar.time,
      eventTime: value.eventTime,
    });
  }
  if (typeof value.isClose !== 'boolean') {
    throw malformed('live bar isClose must be a boolean', { time: bar.time });
  }

  const source = snapshotLiveSourcePolicy(value.source);
  if (options.source && !sameLiveSourcePolicy(source, options.source)) {
    throw malformed('live update source does not match the subscribed source policy', {
      time: bar.time,
      expected: sourceIdentity(options.source),
      actual: sourceIdentity(source),
    });
  }
  if (source.kind === 'lower-bars') {
    const sourceDuration = liveTimeframeSeconds(source.timeframe);
    if (
      sourceDuration > duration ||
      (sourceDuration === duration && options.sourceEvent !== true) ||
      duration % sourceDuration !== 0
    ) {
      throw malformed(
        `${source.timeframe} is not an exact child timeframe of ${options.timeframe}`,
        {
          sourceTimeframe: source.timeframe,
          targetTimeframe: options.timeframe,
        },
      );
    }
  }

  let provenance: Readonly<Record<string, string | number | boolean>> | undefined;
  if (value.provenance != null) {
    if (!isPlainRecord(value.provenance)) {
      throw malformed('live update provenance must be a plain record');
    }
    const copy: Record<string, string | number | boolean> = {};
    for (const [key, field] of Object.entries(value.provenance)) {
      if (typeof field !== 'string' && typeof field !== 'number' && typeof field !== 'boolean') {
        throw malformed('live update provenance values must be string, number, or boolean', {
          key,
        });
      }
      if (typeof field === 'number' && !Number.isFinite(field)) {
        throw malformed('live update provenance numbers must be finite', { key });
      }
      copy[key] = field;
    }
    provenance = Object.freeze(copy);
  }
  if (
    value.coalescedCount != null &&
    (!Number.isSafeInteger(value.coalescedCount) || value.coalescedCount < 0)
  ) {
    throw malformed('live update coalescedCount must be a non-negative safe integer', {
      coalescedCount: value.coalescedCount,
    });
  }
  if (value.recovered != null && typeof value.recovered !== 'boolean') {
    throw malformed('live update recovered must be a boolean');
  }
  if (value.recovered === true && !value.isClose) {
    throw malformed('a recovered live update must be authoritative final');
  }

  return Object.freeze({
    bar: Object.freeze({
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }),
    isClose: value.isClose,
    revision: value.revision,
    eventTime: value.eventTime,
    source,
    ...(provenance ? { provenance } : {}),
    ...(value.coalescedCount != null ? { coalescedCount: value.coalescedCount } : {}),
    ...(value.recovered != null ? { recovered: value.recovered } : {}),
  });
}

export function snapshotLiveSourcePolicy(source: LiveSourcePolicy): LiveSourcePolicy {
  if (!source || typeof source !== 'object') {
    throw malformed('live source policy is required');
  }
  if (source.kind === 'native') return Object.freeze({ kind: 'native' });
  if (source.kind === 'lower-bars') {
    liveTimeframeSeconds(source.timeframe);
    return Object.freeze({ kind: 'lower-bars', timeframe: source.timeframe });
  }
  throw malformed('live source policy kind is unsupported');
}

/** OHLCV/source equivalence used only for idempotent duplicate authoritative finals. */
export function equivalentFinalBarUpdate(left: BarUpdate, right: BarUpdate): boolean {
  return (
    left.isClose &&
    right.isClose &&
    sameBar(left.bar, right.bar) &&
    sameLiveSourcePolicy(left.source, right.source)
  );
}

/**
 * Stateful protocol validator. It never repairs or reorders input. Equivalent
 * duplicate finals are the sole deduplication exception to strict revisions.
 */
export class BarUpdateValidator {
  private readonly maxForming: number;
  private readonly maxFinalized: number;
  private readonly forming = new Map<number, FormingState>();
  private readonly finalized = new Map<number, BarUpdate>();
  private readonly finalizedOrder: number[] = [];
  private activeTime: number | undefined;
  private latestFinalTime = Number.NEGATIVE_INFINITY;
  private lastEventTime = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: BarUpdateValidationOptions) {
    liveTimeframeSeconds(options.timeframe);
    if (options.source) snapshotLiveSourcePolicy(options.source);
    const anchor = options.anchorTime ?? 0;
    if (!Number.isSafeInteger(anchor)) {
      throw new RangeError('pinery: live bar anchorTime must be a safe unix second');
    }
    this.maxForming = options.maxFormingBars ?? DEFAULT_MAX_FORMING_BARS;
    if (!Number.isSafeInteger(this.maxForming) || this.maxForming <= 0) {
      throw new RangeError('pinery: maxFormingBars must be a positive safe integer');
    }
    this.maxFinalized = options.maxFinalizedBars ?? DEFAULT_FINAL_DEDUPE_BARS;
    if (!Number.isSafeInteger(this.maxFinalized) || this.maxFinalized <= 0) {
      throw new RangeError('pinery: maxFinalizedBars must be a positive safe integer');
    }
  }

  get formingCount(): number {
    return this.forming.size;
  }

  get finalizedCount(): number {
    return this.finalized.size;
  }

  /** Return a frozen accepted update, or undefined for an equivalent duplicate final. */
  accept(input: BarUpdate): BarUpdate | undefined {
    const update = validateBarUpdate(input, this.options);
    const time = update.bar.time;
    if (update.eventTime < this.lastEventTime) {
      throw malformed('live bar eventTime decreased', {
        previousEventTime: this.lastEventTime,
        eventTime: update.eventTime,
        time,
      });
    }
    this.lastEventTime = update.eventTime;

    const authoritative = this.finalized.get(time);
    if (authoritative) {
      if (update.isClose && equivalentFinalBarUpdate(authoritative, update)) return undefined;
      throw malformed(
        update.isClose
          ? `live bar ${time} has conflicting authoritative finals`
          : `live bar ${time} was updated after finalization`,
        { time },
      );
    }
    if (time <= this.latestFinalTime) {
      throw malformed('live chart time did not strictly increase after finalization', {
        latestFinalTime: this.latestFinalTime,
        time,
      });
    }
    if (this.activeTime != null && time !== this.activeTime) {
      throw malformed('a newer live bar arrived before the active bar had an authoritative final', {
        activeTime: this.activeTime,
        time,
      });
    }

    const previous = this.forming.get(time);
    if (previous && update.revision <= previous.revision) {
      throw malformed(`live bar ${time} revision did not strictly increase`, {
        time,
        previousRevision: previous.revision,
        revision: update.revision,
      });
    }

    if (update.isClose) {
      this.forming.delete(time);
      this.finalized.set(time, update);
      this.finalizedOrder.push(time);
      while (this.finalizedOrder.length > this.maxFinalized) {
        this.finalized.delete(this.finalizedOrder.shift()!);
      }
      this.activeTime = undefined;
      this.latestFinalTime = time;
      return update;
    }

    if (!previous && this.forming.size >= this.maxForming) {
      throw malformed('live stream exceeded its bounded forming-bar state', {
        maxFormingBars: this.maxForming,
        time,
      });
    }
    this.forming.set(time, { revision: update.revision });
    this.activeTime = time;
    return update;
  }
}

/** Fixed exact live duration; calendar bars require an authoritative session policy. */
export function liveTimeframeSeconds(timeframe: string): number {
  const parsed = canonicalTimeframeSecondsExact(timeframe);
  if (parsed.kind !== 'ok') {
    throw malformed(
      parsed.kind === 'unsupported'
        ? `live bars do not support non-fixed timeframe ${JSON.stringify(timeframe)}`
        : parsed.message,
      { timeframe, code: parsed.code },
    );
  }
  return parsed.value;
}

function sameLiveSourcePolicy(left: LiveSourcePolicy, right: LiveSourcePolicy): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== 'lower-bars' ||
      (right.kind === 'lower-bars' && left.timeframe === right.timeframe))
  );
}

function sourceIdentity(source: LiveSourcePolicy): string {
  return source.kind === 'native' ? 'native' : `lower-bars:${source.timeframe}`;
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

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function malformed(message: string, details?: Readonly<Record<string, unknown>>): MarketDataError {
  return new MarketDataError('malformed-data', `pinery: ${message}`, {
    retryable: false,
    details,
  });
}
