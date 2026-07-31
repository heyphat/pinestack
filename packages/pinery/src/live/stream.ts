import { MarketDataError, type BarUpdate } from '../provider.js';
import {
  BarUpdateValidator,
  equivalentFinalBarUpdate,
  type BarUpdateValidationOptions,
} from './validation.js';

export const DEFAULT_MAX_PENDING_FINALS = 256;
export const DEFAULT_LIVE_TEARDOWN_TIMEOUT_MS = 5_000;

export interface ConformLiveBarUpdatesOptions extends BarUpdateValidationOptions {
  /** Exclusive finalized chart-open cursor. */
  readonly after?: number;
  readonly signal?: AbortSignal;
  readonly throttleMs?: number;
  readonly maxPendingFinals?: number;
}

/**
 * Validate and deterministically throttle a provider stream. Only forming
 * snapshots coalesce. Finals bypass throttling and equivalent duplicate finals
 * are the only events deduplicated.
 */
export async function* conformLiveBarUpdates(
  source: AsyncIterable<BarUpdate> | Iterable<BarUpdate>,
  options: ConformLiveBarUpdatesOptions,
): AsyncIterable<BarUpdate> {
  assertLiveStreamOptions(options);
  const validator = new BarUpdateValidator(options);
  const throttleMs = options.throttleMs ?? 0;
  let pending: BarUpdate | undefined;
  let activeTime: number | undefined;
  let lastFormingEmitTime = Number.NEGATIVE_INFINITY;

  for await (const input of source) {
    if (options.signal?.aborted) return;
    const accepted = validator.accept(input);
    if (!accepted) continue;
    const time = accepted.bar.time;
    const visible = options.after == null || time > options.after;

    if (accepted.isClose) {
      const output = pending ? mergeCoalescedFinal(accepted, pending) : accepted;
      pending = undefined;
      activeTime = undefined;
      lastFormingEmitTime = Number.NEGATIVE_INFINITY;
      if (visible) yield output;
      continue;
    }

    if (activeTime !== time) {
      activeTime = time;
      lastFormingEmitTime = Number.NEGATIVE_INFINITY;
      pending = undefined;
    }
    if (!visible) continue;
    if (throttleMs === 0 || accepted.eventTime - lastFormingEmitTime >= throttleMs) {
      const output = pending ? mergeCoalescedForming(accepted, pending) : accepted;
      pending = undefined;
      lastFormingEmitTime = accepted.eventTime;
      yield output;
    } else {
      pending = pending ? mergeCoalescedForming(accepted, pending) : accepted;
    }
  }

  if (!options.signal?.aborted && activeTime != null) {
    throw discontinuity(activeTime, options.timeframe);
  }
}

export interface BufferLiveBarUpdatesOptions {
  readonly maxPendingFinals?: number;
  readonly signal?: AbortSignal;
  /** Total time allowed for iterator return and producer settlement. Default 5,000ms. */
  readonly teardownTimeoutMs?: number;
}

/**
 * Decouple an independently advancing producer from its consumer while keeping
 * exactly one forming snapshot and every final up to the explicit hard bound.
 */
export function bufferLiveBarUpdates(
  source: AsyncIterable<BarUpdate> | Iterable<BarUpdate>,
  options: BufferLiveBarUpdatesOptions = {},
): AsyncIterable<BarUpdate> {
  assertBufferOptions(options);
  return {
    [Symbol.asyncIterator]: () => createBufferedIterator(source, options),
  };
}

function createBufferedIterator(
  source: AsyncIterable<BarUpdate> | Iterable<BarUpdate>,
  options: BufferLiveBarUpdatesOptions,
): AsyncIterableIterator<BarUpdate> {
  const buffer = new LiveBarUpdateBuffer(options.maxPendingFinals ?? DEFAULT_MAX_PENDING_FINALS);
  const teardownTimeoutMs = options.teardownTimeoutMs ?? DEFAULT_LIVE_TEARDOWN_TIMEOUT_MS;
  const asyncSource = source as AsyncIterable<BarUpdate>;
  const sourceIterator: AsyncIterator<BarUpdate> | Iterator<BarUpdate> =
    typeof asyncSource[Symbol.asyncIterator] === 'function'
      ? asyncSource[Symbol.asyncIterator]()
      : (source as Iterable<BarUpdate>)[Symbol.iterator]();
  let completed = false;
  let sourceDone = false;
  let cancelled = false;
  let failed = false;
  let failure: unknown;
  let closed = false;
  let externalStopRequested = false;
  let wake: (() => void) | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let returnPromise: Promise<IteratorResult<BarUpdate>> | undefined;
  let readTail: Promise<void> = Promise.resolve();

  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const abort = () => {
    cancelled = true;
    notify();
    queueMicrotask(() => {
      void ensureCleanup().catch(() => {
        // A pending or future next() observes the classified cleanup failure.
      });
    });
  };
  options.signal?.addEventListener('abort', abort, { once: true });

  const producer = (async () => {
    try {
      while (!cancelled && !options.signal?.aborted) {
        const result = await sourceIterator.next();
        if (result.done) {
          sourceDone = true;
          break;
        }
        if (cancelled || options.signal?.aborted) break;
        buffer.push(result.value);
        notify();
      }
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      completed = true;
      notify();
    }
  })();

  const ensureCleanup = (): Promise<void> => {
    if (!cleanupPromise) {
      cancelled = true;
      notify();
      options.signal?.removeEventListener('abort', abort);
      cleanupPromise = teardownLiveIterator(
        sourceIterator,
        producer,
        !sourceDone,
        teardownTimeoutMs,
      );
      void cleanupPromise.catch(() => {
        // Keep late iterator failures observed even when a caller abandons teardown.
      });
    }
    return cleanupPromise;
  };

  const readNext = async (): Promise<IteratorResult<BarUpdate>> => {
    while (true) {
      if (closed || externalStopRequested) return { done: true, value: undefined };
      if (options.signal?.aborted || cancelled) {
        try {
          await ensureCleanup();
        } finally {
          closed = true;
        }
        return { done: true, value: undefined };
      }
      if (failed && buffer.finalCount === 0) {
        const primaryFailure = failure;
        try {
          await ensureCleanup();
        } catch {
          // Cleanup must not mask the primary stream failure.
        }
        closed = true;
        throw primaryFailure;
      }
      const update = buffer.shift();
      if (update) return { done: false, value: update };
      if (failed) continue;
      if (completed) {
        try {
          await ensureCleanup();
        } finally {
          closed = true;
        }
        return { done: true, value: undefined };
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (
          buffer.size > 0 ||
          completed ||
          failed ||
          cancelled ||
          externalStopRequested ||
          options.signal?.aborted
        ) {
          notify();
        }
      });
    }
  };

  const iterator: AsyncIterableIterator<BarUpdate> = {
    next(): Promise<IteratorResult<BarUpdate>> {
      const result = readTail.then(readNext);
      readTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    return(value?: unknown): Promise<IteratorResult<BarUpdate>> {
      if (!returnPromise) {
        externalStopRequested = true;
        cancelled = true;
        notify();
        returnPromise = (async () => {
          try {
            await ensureCleanup();
            return { done: true, value: value as BarUpdate };
          } finally {
            closed = true;
          }
        })();
        void returnPromise.catch(() => {
          // The returned promise still rejects; this observer prevents abandonment leaks.
        });
      }
      return returnPromise;
    },
    throw(error?: unknown): Promise<IteratorResult<BarUpdate>> {
      externalStopRequested = true;
      cancelled = true;
      notify();
      const thrown = (async (): Promise<IteratorResult<BarUpdate>> => {
        try {
          await ensureCleanup();
        } catch {
          // Preserve the caller-supplied primary error.
        } finally {
          closed = true;
        }
        throw error;
      })();
      void thrown.catch(() => {
        // The returned promise still rejects; this observer prevents abandonment leaks.
      });
      return thrown;
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<BarUpdate> {
      return iterator;
    },
  };

  if (options.signal?.aborted) abort();
  return iterator;
}

async function teardownLiveIterator(
  iterator: AsyncIterator<BarUpdate> | Iterator<BarUpdate>,
  producer: Promise<void>,
  closeUpstream: boolean,
  timeoutMs: number,
): Promise<void> {
  let returnSettled = !closeUpstream || typeof iterator.return !== 'function';
  let returnRejected = false;
  let returnFailure: unknown;
  const returned = returnSettled
    ? Promise.resolve()
    : Promise.resolve()
        .then(() => iterator.return!())
        .then(
          () => {
            returnSettled = true;
          },
          (error: unknown) => {
            returnSettled = true;
            returnRejected = true;
            returnFailure = error;
          },
        );

  let producerSettled = false;
  let producerRejected = false;
  let producerFailure: unknown;
  const produced = producer.then(
    () => {
      producerSettled = true;
    },
    (error: unknown) => {
      producerSettled = true;
      producerRejected = true;
      producerFailure = error;
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    Promise.all([returned, produced]).then(() => 'settled' as const),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (result === 'timeout') {
    throw cleanupFailure('live iterator teardown timed out', {
      teardownTimeoutMs: timeoutMs,
      pendingNextOrProducer: !producerSettled,
      pendingReturn: !returnSettled,
    });
  }
  if (returnRejected) {
    throw cleanupFailure('live iterator return failed', {}, returnFailure);
  }
  if (producerRejected) {
    throw cleanupFailure('live producer cleanup failed', {}, producerFailure);
  }
}

function assertBufferOptions(options: BufferLiveBarUpdatesOptions): void {
  if (
    options.teardownTimeoutMs != null &&
    (!Number.isSafeInteger(options.teardownTimeoutMs) || options.teardownTimeoutMs < 0)
  ) {
    throw new RangeError('pinery: teardownTimeoutMs must be a non-negative safe integer');
  }
}

function cleanupFailure(
  message: string,
  details: Readonly<Record<string, unknown>>,
  cause?: unknown,
): MarketDataError {
  return new MarketDataError('live-cleanup', `pinery: ${message}`, {
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
    details,
  });
}

function discontinuity(activeBarTime: number, timeframe: string): MarketDataError {
  return new MarketDataError(
    'live-discontinuity',
    `pinery: live stream ended before bar ${activeBarTime} received an authoritative final`,
    {
      retryable: false,
      details: { activeBarTime, timeframe },
    },
  );
}

/**
 * Backpressure/recovery buffer with one replaceable forming slot and a bounded,
 * non-droppable final queue. Final overflow is fatal rather than lossy.
 */
export class LiveBarUpdateBuffer {
  private readonly maxFinals: number;
  private readonly finals: BarUpdate[] = [];
  private forming: BarUpdate | undefined;

  constructor(maxPendingFinals = DEFAULT_MAX_PENDING_FINALS) {
    if (!Number.isSafeInteger(maxPendingFinals) || maxPendingFinals <= 0) {
      throw new RangeError('pinery: maxPendingFinals must be a positive safe integer');
    }
    this.maxFinals = maxPendingFinals;
  }

  get size(): number {
    return this.finals.length + (this.forming ? 1 : 0);
  }

  get finalCount(): number {
    return this.finals.length;
  }

  get formingCount(): number {
    return this.forming ? 1 : 0;
  }

  push(update: BarUpdate): void {
    const queuedFinal = this.finals.find((entry) => entry.bar.time === update.bar.time);
    if (queuedFinal) {
      if (update.isClose && equivalentFinalBarUpdate(queuedFinal, update)) return;
      throw malformed(
        update.isClose
          ? `live bar ${update.bar.time} has conflicting buffered finals`
          : `live bar ${update.bar.time} was buffered after finalization`,
      );
    }

    if (!update.isClose) {
      if (this.forming && this.forming.bar.time !== update.bar.time) {
        throw malformed('a newer forming bar was buffered before the active bar finalized');
      }
      this.forming = this.forming ? mergeCoalescedForming(update, this.forming) : update;
      return;
    }

    let queued = update;
    if (this.forming) {
      if (this.forming.bar.time !== update.bar.time) {
        throw malformed('a final did not match the active buffered bar');
      }
      queued = mergeCoalescedFinal(update, this.forming);
      this.forming = undefined;
    }
    if (this.finals.length >= this.maxFinals) {
      throw malformed('live final queue overflow', {
        maxPendingFinals: this.maxFinals,
        time: update.bar.time,
      });
    }
    this.finals.push(queued);
  }

  shift(): BarUpdate | undefined {
    const final = this.finals.shift();
    if (final) return final;
    const forming = this.forming;
    this.forming = undefined;
    return forming;
  }

  drain(): readonly BarUpdate[] {
    const entries = [...this.finals];
    this.finals.length = 0;
    if (this.forming) {
      entries.push(this.forming);
      this.forming = undefined;
    }
    return entries;
  }
}

function assertLiveStreamOptions(options: ConformLiveBarUpdatesOptions): void {
  if (options.after != null && (!Number.isSafeInteger(options.after) || options.after < 0)) {
    throw new RangeError('pinery: live bars after must be a non-negative integer unix second');
  }
  for (const [name, value] of [
    ['throttleMs', options.throttleMs],
    ['maxPendingFinals', options.maxPendingFinals],
  ] as const) {
    if (value == null) continue;
    if (!Number.isSafeInteger(value) || (name === 'throttleMs' ? value < 0 : value <= 0)) {
      throw new RangeError(
        `pinery: ${name} must be a ${name === 'throttleMs' ? 'non-negative' : 'positive'} safe integer`,
      );
    }
  }
}

function mergeCoalescedForming(latest: BarUpdate, previous: BarUpdate): BarUpdate {
  return Object.freeze({
    ...latest,
    coalescedCount: (latest.coalescedCount ?? 0) + (previous.coalescedCount ?? 0) + 1,
  });
}

function mergeCoalescedFinal(final: BarUpdate, pending: BarUpdate): BarUpdate {
  return Object.freeze({
    ...final,
    coalescedCount: (final.coalescedCount ?? 0) + (pending.coalescedCount ?? 0) + 1,
  });
}

function malformed(message: string, details?: Readonly<Record<string, unknown>>): MarketDataError {
  return new MarketDataError('malformed-data', `pinery: ${message}`, {
    retryable: false,
    details,
  });
}
