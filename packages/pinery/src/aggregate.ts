import type { Bar } from '@heyphat/piner';
import {
  ExactHistoryError,
  halfOpenIntervalSec,
  type CoverageGapReason,
  type CoverageGapSec,
  type HalfOpenIntervalSec,
  type HistoryAcquisition,
  type HistorySessionCalendar,
  type UnixSecond,
} from './provider.js';
import {
  alignmentIdentity,
  assertCalendarPeriodCoverage,
  calendarPeriodIntersects,
  calendarSessionPeriods,
  complementIntervals,
  covers,
  fixedDuration,
  floorTo,
  intersect,
  isCalendarSessionTimeframe,
  mergeIntervals,
  safeSecondAdd,
  utcTimeframeAnchor,
  utcTimeframesNest,
  validateBarsExact,
  validateHistoryAcquisition,
  type CalendarSessionPeriod,
} from './coverage.js';
import { parseCanonicalTimeframeExact } from './timeframe.js';

export const HISTORY_AGGREGATION_VERSION = 4;

export type AggregateAlignment =
  | {
      readonly kind: 'utc';
      /** Week anchor of the target/output grid. */
      readonly weekAnchorSec?: UnixSecond;
      /** Week anchor advertised by the raw source; omitted by legacy direct callers. */
      readonly sourceWeekAnchorSec?: UnixSecond;
    }
  | {
      readonly kind: 'session';
      readonly calendarId: string;
      readonly version: string;
      readonly coverage: HalfOpenIntervalSec;
      readonly sessions: readonly HalfOpenIntervalSec[];
      readonly periods?: HistorySessionCalendar['periods'];
    };

export interface AggregateSpec {
  readonly sourceTimeframe: string;
  readonly targetTimeframe: string;
  readonly alignment: AggregateAlignment;
}

/** Strict, coverage-preserving OHLCV aggregation. It never repairs source bars. */
export function aggregateBars(
  acquisition: HistoryAcquisition,
  spec: AggregateSpec,
): HistoryAcquisition {
  const calendar = aggregateCalendar(spec.alignment);
  const sourceWeekAnchorSec =
    spec.alignment.kind === 'utc'
      ? 'sourceWeekAnchorSec' in spec.alignment
        ? spec.alignment.sourceWeekAnchorSec
        : spec.alignment.weekAnchorSec
      : undefined;
  validateHistoryAcquisition(acquisition, {
    sourceTimeframe: spec.sourceTimeframe,
    targetTimeframe: spec.sourceTimeframe,
    aggregationVersion: 0,
    alignment: spec.alignment.kind === 'utc' ? 'utc-24x7' : 'exchange-calendar',
    weekAnchorSec: sourceWeekAnchorSec,
    calendar,
    coverageSemantics: acquisition.provenance.coverageSemantics,
    recordSpan: acquisition.provenance.recordSpan,
  });
  const sourceDuration = fixedDuration(spec.sourceTimeframe);
  const targetDuration = fixedDuration(spec.targetTimeframe);
  const calendarTarget =
    spec.alignment.kind === 'session' && isCalendarSessionTimeframe(spec.targetTimeframe);
  const utcNested =
    spec.alignment.kind !== 'utc' ||
    utcTimeframesNest(
      spec.sourceTimeframe,
      spec.targetTimeframe,
      sourceWeekAnchorSec,
      spec.alignment.weekAnchorSec,
    );
  if (
    !calendarTarget &&
    (!utcNested || targetDuration < sourceDuration || targetDuration % sourceDuration !== 0)
  ) {
    throw new ExactHistoryError({
      kind: 'unsupported',
      code: utcNested ? 'non-divisor-timeframe' : 'non-nesting-timeframe-grid',
      message: utcNested
        ? `pinery: ${spec.sourceTimeframe} is not an exact divisor of ${spec.targetTimeframe}`
        : `pinery: ${spec.sourceTimeframe} UTC buckets do not tile ${spec.targetTimeframe} boundaries`,
      details: { sourceTimeframe: spec.sourceTimeframe, targetTimeframe: spec.targetTimeframe },
    });
  }

  validateBarsExact(
    acquisition.bars,
    sourceDuration,
    spec.alignment.kind === 'utc' ? 'utc-24x7' : 'exchange-calendar',
    calendar,
    spec.sourceTimeframe,
    sourceWeekAnchorSec,
  );

  const completeRecord =
    (acquisition.provenance.coverageSemantics ?? 'bars-only') === 'complete-record';
  const recordSpan = acquisition.provenance.recordSpan;
  const barsByOpen = new Map(acquisition.bars.map((bar) => [bar.time, bar] as const));
  const bars: Bar[] = [];
  const covered: HalfOpenIntervalSec[] = [];
  const explicitGapReasons: Array<CoverageGapSec> = [];

  if (calendarTarget) {
    const result = aggregateCalendarPeriods(
      acquisition,
      spec,
      sourceDuration,
      barsByOpen,
      spec.alignment as Extract<AggregateAlignment, { kind: 'session' }>,
    );
    bars.push(...result.bars);
    covered.push(...result.covered);
    explicitGapReasons.push(...result.gaps);
  } else {
    const targetBuckets =
      spec.alignment.kind === 'utc'
        ? utcBuckets(
            acquisition.requested,
            targetDuration,
            utcTimeframeAnchor(spec.targetTimeframe, spec.alignment.weekAnchorSec),
          )
        : sessionBuckets(acquisition.requested, targetDuration, spec.alignment);
    const ratio = targetDuration / sourceDuration;

    for (const bucket of targetBuckets) {
      const members: Bar[] = [];
      let missing = false;
      const completeRecordBucket =
        completeRecord && recordSpan !== undefined && covers([recordSpan], bucket);
      for (let i = 0; i < ratio; i++) {
        const open = bucket.from + i * sourceDuration;
        const bar = barsByOpen.get(open);
        const sourceInterval = halfOpenIntervalSec(
          open,
          safeSecondAdd(open, sourceDuration, 'source bar close'),
        );
        const logicalPart = intersect(sourceInterval, acquisition.requested);
        const proven = !logicalPart || covers(acquisition.covered, logicalPart);
        if (bar && (completeRecordBucket || proven)) {
          members.push(bar);
        } else if (!completeRecordBucket) {
          missing = true;
        }
      }

      const expectedClose = safeSecondAdd(bucket.from, targetDuration, 'aggregate bucket close');
      const full =
        expectedClose === bucket.to &&
        (completeRecordBucket || (!missing && members.length === ratio));
      const clipped = intersect(bucket, acquisition.requested);
      if (!clipped) continue;

      if (full) {
        if (members.length > 0) bars.push(aggregateBucket(bucket.from, members));
        covered.push(clipped);
      } else {
        explicitGapReasons.push({
          ...clipped,
          reason: aggregateGapReason(
            bucket,
            acquisition.requested,
            acquisition,
            members.length > 0,
          ),
        });
      }
    }
  }

  if (spec.alignment.kind === 'session') {
    const closures = closedSessionIntervals(spec.alignment, acquisition.requested);
    covered.push(
      ...(completeRecord && recordSpan
        ? closures
            .map((closure) => intersect(closure, recordSpan))
            .filter((value): value is HalfOpenIntervalSec => value !== null)
        : closures),
    );
  }

  const mergedCovered = mergeIntervals(covered);
  const uncovered = complementIntervals(acquisition.requested, mergedCovered);
  const gaps = reasonedCoverageGaps(uncovered, explicitGapReasons, acquisition.gaps);

  return {
    bars,
    requested: acquisition.requested,
    covered: mergedCovered,
    gaps,
    ...(acquisition.truncated ? { truncated: acquisition.truncated } : {}),
    complete: gaps.length === 0,
    provenance: {
      ...acquisition.provenance,
      sourceTimeframe: spec.sourceTimeframe,
      targetTimeframe: spec.targetTimeframe,
      alignment:
        spec.alignment.kind === 'utc'
          ? 'utc-24x7'
          : alignmentIdentity('exchange-calendar', calendar),
      ...(spec.alignment.kind === 'utc' && spec.alignment.weekAnchorSec !== undefined
        ? { weekAnchorSec: spec.alignment.weekAnchorSec }
        : {}),
      aggregationVersion: HISTORY_AGGREGATION_VERSION,
    },
  };
}

function aggregateBucket(open: number, bars: readonly Bar[]): Bar {
  const first = bars[0]!;
  const last = bars[bars.length - 1]!;
  let high = first.high;
  let low = first.low;
  let volume = 0;
  for (const bar of bars) {
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
    volume += bar.volume;
  }
  if (!Number.isFinite(volume)) {
    throw new ExactHistoryError({
      kind: 'malformed',
      code: 'aggregate-volume',
      message: 'pinery: aggregated volume is not finite',
      details: { open },
    });
  }
  return { time: open, open: first.open, high, low, close: last.close, volume };
}

function utcBuckets(
  requested: HalfOpenIntervalSec,
  duration: number,
  anchor: number,
): HalfOpenIntervalSec[] {
  const out: HalfOpenIntervalSec[] = [];
  let open = floorTo(requested.from, duration, anchor);
  while (open < requested.to) {
    const close = safeSecondAdd(open, duration, 'UTC bucket close');
    out.push(halfOpenIntervalSec(open, close));
    open = close;
  }
  return out;
}

function sessionBuckets(
  requested: HalfOpenIntervalSec,
  duration: number,
  alignment: Extract<AggregateAlignment, { kind: 'session' }>,
): HalfOpenIntervalSec[] {
  const out: HalfOpenIntervalSec[] = [];
  for (const session of alignment.sessions) {
    if (!intersect(session, requested)) continue;
    let open = session.from as number;
    while (open < session.to) {
      const close = safeSecondAdd(open, duration, 'session bucket close');
      if (close > session.to) {
        const partial = intersect(halfOpenIntervalSec(open, session.to), requested);
        if (partial) out.push(halfOpenIntervalSec(open, session.to));
        break;
      }
      out.push(halfOpenIntervalSec(open, close));
      open = close;
    }
  }
  return out;
}

interface CalendarAggregationResult {
  readonly bars: readonly Bar[];
  readonly covered: readonly HalfOpenIntervalSec[];
  readonly gaps: readonly CoverageGapSec[];
}

interface ExpectedCalendarMember {
  readonly open: number;
  readonly interval: HalfOpenIntervalSec;
}

function aggregateCalendarPeriods(
  acquisition: HistoryAcquisition,
  spec: AggregateSpec,
  sourceDuration: number,
  barsByOpen: ReadonlyMap<number, Bar>,
  alignment: Extract<AggregateAlignment, { kind: 'session' }>,
): CalendarAggregationResult {
  const source = parseCanonicalTimeframeExact(spec.sourceTimeframe);
  if (source.kind !== 'ok' || source.value.domain !== 'fixed') {
    throw new ExactHistoryError({
      kind: source.kind === 'malformed' ? 'malformed' : 'unsupported',
      code: source.kind === 'ok' ? 'calendar-source-timeframe' : source.code,
      message:
        source.kind === 'ok'
          ? `pinery: ${spec.sourceTimeframe} cannot tile exchange-calendar periods`
          : source.message,
      details: { sourceTimeframe: spec.sourceTimeframe, targetTimeframe: spec.targetTimeframe },
    });
  }

  const dailySource = source.value.canonical === '1d';
  const intradaySource =
    source.value.unit === 's' || source.value.unit === 'm' || source.value.unit === 'h';
  if (!dailySource && !intradaySource) {
    throw new ExactHistoryError({
      kind: 'unsupported',
      code: 'calendar-source-timeframe',
      message:
        `pinery: ${spec.sourceTimeframe} cannot enumerate exact source members for ` +
        `${spec.targetTimeframe}`,
      details: { sourceTimeframe: spec.sourceTimeframe, targetTimeframe: spec.targetTimeframe },
    });
  }
  if (intradaySource) {
    const untiled = alignment.sessions.find(
      (session) => (session.to - session.from) % sourceDuration !== 0,
    );
    if (untiled) {
      throw new ExactHistoryError({
        kind: 'unsupported',
        code: 'calendar-source-does-not-tile-session',
        message: `pinery: ${spec.sourceTimeframe} does not exactly tile every declared exchange session`,
        details: { sourceTimeframe: spec.sourceTimeframe, session: untiled },
      });
    }
  }

  const calendar = aggregateCalendar(alignment)!;
  const periods = calendarSessionPeriods(calendar, spec.targetTimeframe).filter((period) =>
    calendarPeriodIntersects(period, acquisition.requested),
  );
  const bars: Bar[] = [];
  const covered: HalfOpenIntervalSec[] = [];
  const gaps: CoverageGapSec[] = [];

  const completeRecord =
    (acquisition.provenance.coverageSemantics ?? 'bars-only') === 'complete-record';
  const recordSpan = acquisition.provenance.recordSpan;
  for (const period of periods) {
    assertCalendarPeriodCoverage(calendar, period);
    const expected = expectedCalendarMembers(period, dailySource, sourceDuration, calendar);
    const members: Bar[] = [];
    let missing = false;
    const completeRecordPeriod =
      completeRecord &&
      recordSpan !== undefined &&
      covers([recordSpan], halfOpenIntervalSec(period.from, period.to));
    for (const member of expected) {
      const bar = barsByOpen.get(member.open);
      const logicalPart = intersect(member.interval, acquisition.requested);
      const proven = !logicalPart || covers(acquisition.covered, logicalPart);
      if (bar && (completeRecordPeriod || proven)) {
        members.push(bar);
      } else if (!completeRecordPeriod) {
        missing = true;
      }
    }

    if (completeRecordPeriod || (!missing && members.length === expected.length)) {
      if (members.length > 0) bars.push(aggregateBucket(period.from, members));
      for (const session of period.sessions) {
        const clipped = intersect(session, acquisition.requested);
        if (clipped) covered.push(clipped);
      }
      continue;
    }

    for (const session of period.sessions) {
      const clipped = intersect(session, acquisition.requested);
      if (!clipped) continue;
      const sourceGap = acquisition.gaps.find((gap) => intersects(gap, clipped));
      gaps.push({
        ...clipped,
        reason:
          sourceGap?.reason ?? (members.length > 0 ? 'partial-aggregate' : 'provider-missing'),
      });
    }
  }

  return { bars, covered, gaps };
}

function expectedCalendarMembers(
  period: CalendarSessionPeriod,
  dailySource: boolean,
  sourceDuration: number,
  calendar: HistorySessionCalendar,
): readonly ExpectedCalendarMember[] {
  if (dailySource) {
    const targetSessions = new Set(
      period.sessions.map((session) => `${session.from}:${session.to}`),
    );
    const dailyPeriods = calendarSessionPeriods(calendar, '1d').filter((daily) =>
      daily.sessions.some((session) => targetSessions.has(`${session.from}:${session.to}`)),
    );
    for (const daily of dailyPeriods) {
      const nested = daily.sessions.every((session) =>
        targetSessions.has(`${session.from}:${session.to}`),
      );
      if (!nested || daily.from < period.from || daily.nominalTo > period.nominalTo) {
        throw new ExactHistoryError({
          kind: 'malformed',
          code: 'calendar-period-hierarchy',
          message: 'pinery: authoritative daily period crosses its target calendar period',
          details: {
            daily: { from: daily.from, to: daily.to, nominalTo: daily.nominalTo },
            target: { from: period.from, to: period.to, nominalTo: period.nominalTo },
          },
        });
      }
    }
    const assigned = new Set(
      dailyPeriods.flatMap((daily) =>
        daily.sessions.map((session) => `${session.from}:${session.to}`),
      ),
    );
    if (assigned.size !== targetSessions.size) {
      throw new ExactHistoryError({
        kind: 'malformed',
        code: 'calendar-period-hierarchy',
        message: 'pinery: authoritative daily periods do not partition the target calendar period',
        details: {
          target: { from: period.from, to: period.to, nominalTo: period.nominalTo },
        },
      });
    }
    return dailyPeriods.map((daily) => ({
      open: daily.from,
      interval: halfOpenIntervalSec(daily.from, daily.to),
    }));
  }

  const expected: ExpectedCalendarMember[] = [];
  for (const session of period.sessions) {
    let open = session.from as number;
    while (open < session.to) {
      const close = safeSecondAdd(open, sourceDuration, 'calendar source bar close');
      if (close > session.to) {
        throw new ExactHistoryError({
          kind: 'unsupported',
          code: 'calendar-source-does-not-tile-session',
          message: 'pinery: source timeframe leaves a partial exchange-session interval',
          details: { sourceDuration, session },
        });
      }
      expected.push({ open, interval: halfOpenIntervalSec(open, close) });
      open = close;
    }
  }
  return expected;
}

function aggregateGapReason(
  bucket: HalfOpenIntervalSec,
  requested: HalfOpenIntervalSec,
  acquisition: HistoryAcquisition,
  hasSomeMembers: boolean,
): CoverageGapReason {
  const sourceGap = acquisition.gaps.find((gap) => intersects(gap, bucket));
  if (sourceGap?.reason === 'provider-truncated') return 'provider-truncated';
  const partialLogicalEdge = bucket.from < requested.from || bucket.to > requested.to;
  if (partialLogicalEdge && hasSomeMembers) return 'partial-aggregate';
  if (sourceGap) return sourceGap.reason;
  return hasSomeMembers ? 'partial-aggregate' : 'provider-missing';
}

function reasonedCoverageGaps(
  uncovered: readonly HalfOpenIntervalSec[],
  aggregateGaps: readonly CoverageGapSec[],
  sourceGaps: readonly CoverageGapSec[],
): CoverageGapSec[] {
  const out: CoverageGapSec[] = [];
  const candidates = [...aggregateGaps, ...sourceGaps];

  for (const gap of uncovered) {
    const boundaries = new Set<number>([gap.from, gap.to]);
    for (const candidate of candidates) {
      if (!intersects(candidate, gap)) continue;
      boundaries.add(Math.max(candidate.from, gap.from));
      boundaries.add(Math.min(candidate.to, gap.to));
    }

    const points = [...boundaries].sort((a, b) => a - b);
    for (let index = 1; index < points.length; index++) {
      const from = points[index - 1]!;
      const to = points[index]!;
      if (from >= to) continue;
      const explicit = aggregateGaps.find(
        (candidate) => candidate.from <= from && candidate.to >= to,
      );
      const source = sourceGaps.find((candidate) => candidate.from <= from && candidate.to >= to);
      const reason = explicit?.reason ?? source?.reason ?? 'partial-aggregate';
      const last = out[out.length - 1];
      if (last && last.to === from && last.reason === reason) {
        out[out.length - 1] = { from: last.from, to: halfOpenIntervalSec(from, to).to, reason };
      } else {
        out.push({ ...halfOpenIntervalSec(from, to), reason });
      }
    }
  }
  return out;
}

function closedSessionIntervals(
  alignment: Extract<AggregateAlignment, { kind: 'session' }>,
  requested: HalfOpenIntervalSec,
): HalfOpenIntervalSec[] {
  const declared = intersect(alignment.coverage, requested);
  if (!declared) return [];
  const active = mergeIntervals(
    alignment.sessions
      .map((session) => intersect(session, declared))
      .filter((value): value is HalfOpenIntervalSec => value !== null),
  );
  return complementIntervals(declared, active);
}

function aggregateCalendar(alignment: AggregateAlignment): HistorySessionCalendar | undefined {
  if (alignment.kind === 'utc') return undefined;
  return {
    calendarId: alignment.calendarId,
    version: alignment.version,
    coverage: alignment.coverage,
    sessions: alignment.sessions,
    ...(alignment.periods ? { periods: alignment.periods } : {}),
  };
}

function intersects(a: HalfOpenIntervalSec, b: HalfOpenIntervalSec): boolean {
  return a.from < b.to && b.from < a.to;
}
