import { MarketDataError, type Bar, type BarUpdate, type LiveSourcePolicy } from '../provider.js';
import { snapshotLiveSourcePolicy, validateBarUpdate } from './validation.js';

export interface RecoverLiveBarUpdatesOptions {
  readonly timeframe: string;
  readonly source: LiveSourcePolicy;
  readonly cutoverTime: number;
  readonly after?: number;
  readonly authoritativeBars: readonly Bar[];
}

/**
 * Repair only gaps proven by a newer explicit source event. Recovery emits
 * authoritative finals and never reconstructs a missed forming path.
 */
export async function* recoverLiveBarUpdates(
  trace: AsyncIterable<BarUpdate> | Iterable<BarUpdate>,
  options: RecoverLiveBarUpdatesOptions,
): AsyncIterable<BarUpdate> {
  if (!Number.isFinite(options.cutoverTime) || options.cutoverTime < 0) {
    throw new RangeError('pinery: live recovery cutoverTime must be non-negative');
  }
  if (options.after != null && (!Number.isSafeInteger(options.after) || options.after < 0)) {
    throw new RangeError('pinery: live recovery after must be a non-negative unix second');
  }
  const source = snapshotLiveSourcePolicy(options.source);
  const authoritative = [...options.authoritativeBars].sort(
    (left, right) => left.time - right.time,
  );
  const byTime = new Map(authoritative.map((bar) => [bar.time, bar] as const));
  const finalized = new Set<number>();
  let activeTime: number | undefined;
  let activeRevision = 0;
  let activeEventTime = 0;

  const recoveredFinal = (
    time: number,
    eventTime: number,
    recovery: 'authoritative-history' | 'authoritative-history-eof' = 'authoritative-history',
  ): BarUpdate => {
    const bar = byTime.get(time);
    if (!bar) {
      throw malformed(`cannot recover missing authoritative final ${time}`);
    }
    const revision = activeTime === time ? activeRevision + 1 : 1;
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw malformed('recovered revision overflow');
    }
    return Object.freeze({
      bar: Object.freeze({ ...bar }),
      isClose: true,
      revision,
      eventTime,
      source,
      provenance: Object.freeze({ recovery }),
      recovered: true,
    });
  };

  for await (const input of trace) {
    const rawTime = input?.bar?.time;
    if (
      typeof rawTime === 'number' &&
      Number.isSafeInteger(rawTime) &&
      (rawTime < options.cutoverTime || (options.after != null && rawTime <= options.after))
    ) {
      continue;
    }
    const update = validateBarUpdate(input, {
      timeframe: options.timeframe,
      source,
    });
    const time = update.bar.time;

    if (activeTime != null && time > activeTime) {
      const recovered = recoveredFinal(activeTime, update.eventTime);
      finalized.add(activeTime);
      activeTime = undefined;
      activeRevision = 0;
      activeEventTime = 0;
      yield recovered;
    }

    if (activeTime == null || time >= activeTime) {
      for (const bar of authoritative) {
        if (bar.time < options.cutoverTime || bar.time >= time) continue;
        if (options.after != null && bar.time <= options.after) continue;
        if (finalized.has(bar.time)) continue;
        const recovered = recoveredFinal(bar.time, update.eventTime);
        finalized.add(bar.time);
        yield recovered;
      }
    }

    yield update;
    if (update.isClose) {
      finalized.add(time);
      if (activeTime === time) {
        activeTime = undefined;
        activeRevision = 0;
        activeEventTime = 0;
      }
    } else if (activeTime == null || activeTime === time) {
      activeTime = time;
      activeRevision = update.revision;
      activeEventTime = update.eventTime;
    }
  }

  if (activeTime != null) {
    if (!byTime.has(activeTime)) {
      throw discontinuity(activeTime, options.timeframe, source);
    }
    yield recoveredFinal(activeTime, activeEventTime, 'authoritative-history-eof');
  }
}

function discontinuity(
  activeBarTime: number,
  timeframe: string,
  source: LiveSourcePolicy,
): MarketDataError {
  return new MarketDataError(
    'live-discontinuity',
    `pinery: live stream ended before bar ${activeBarTime} received an authoritative final`,
    {
      retryable: false,
      details: {
        activeBarTime,
        timeframe,
        source: source.kind === 'native' ? 'native' : `lower-bars:${source.timeframe}`,
      },
    },
  );
}

function malformed(message: string): MarketDataError {
  return new MarketDataError('malformed-data', `pinery: live recovery ${message}`, {
    retryable: false,
  });
}
