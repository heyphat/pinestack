/**
 * The pinery data contract. A `HistoryProvider` yields OHLCV bars for a
 * (symbol, timeframe) over an optional time range. It is deliberately narrower
 * than piner's `DataFeed` (which is what the *engine* consumes) so providers stay
 * simple; `toDataFeed` bridges a provider + a fixed range into a piner `DataFeed`.
 */
import type { Bar, DataFeed } from '@heyphat/piner';
import type { AssetClass } from './asset-class.js';
import { parseTimeframe, timeframeSeconds } from './timeframe.js';

export type { Bar };

/** Existing provider selector. `from` and `to` are inclusive UNIX seconds. */
export interface HistoryRange {
  /** Inclusive lower bound (unix seconds). */
  from?: number;
  /** Inclusive upper bound (unix seconds). */
  to?: number;
  /** Hard cap on the number of bars returned (most-recent when only `limit` is set). */
  limit?: number;
}

declare const unixSecondBrand: unique symbol;
declare const unixMillisecondBrand: unique symbol;

/** Integer UNIX timestamp in seconds. */
export type UnixSecond = number & { readonly [unixSecondBrand]: 'UnixSecond' };
/** Integer UNIX timestamp in milliseconds. */
export type UnixMillisecond = number & { readonly [unixMillisecondBrand]: 'UnixMillisecond' };

export interface InclusiveRangeSec {
  readonly from: UnixSecond;
  readonly toInclusive: UnixSecond;
}

export interface HalfOpenIntervalSec {
  /** Inclusive start. */
  readonly from: UnixSecond;
  /** Exclusive end. */
  readonly to: UnixSecond;
}

export interface HalfOpenIntervalMs {
  /** Inclusive start. */
  readonly from: UnixMillisecond;
  /** Exclusive end. */
  readonly to: UnixMillisecond;
}

export type CoverageGapReason = 'provider-missing' | 'partial-aggregate' | 'provider-truncated';

export interface CoverageGapSec extends HalfOpenIntervalSec {
  readonly reason: CoverageGapReason;
}

export interface CoverageGapMs extends HalfOpenIntervalMs {
  readonly reason: CoverageGapReason;
}

export interface HistoryTruncation {
  readonly side: 'before' | 'after';
  readonly reason: string;
  readonly limit?: number;
}

/** Explicit exchange-session metadata. Its declared coverage bounds when closed time is provable. */
export interface HistorySessionCalendar {
  readonly calendarId: string;
  readonly version: string;
  /** Bounds over which `sessions` is a complete calendar declaration. */
  readonly coverage: HalfOpenIntervalSec;
  /** Open trading sessions, ascending and non-overlapping. */
  readonly sessions: readonly HalfOpenIntervalSec[];
  /**
   * Optional authoritative day/week buckets keyed by canonical timeframe (for
   * example `1d` or `1w`). A bucket starts at its native bar open and ends at
   * the calendar boundary through which the session declaration is complete;
   * its effective bar close is the final contained session close. Declaring
   * buckets lets multiple open intervals belong to one daily/weekly bar.
   */
  readonly periods?: Readonly<Record<string, readonly HalfOpenIntervalSec[]>>;
}

export type HistoryAlignment = 'utc-24x7' | 'exchange-calendar' | 'unknown';

/** How absence of a returned bar may be interpreted as coverage evidence. */
export type HistoryCoverageSemantics = 'bars-only' | 'complete-record';

/** Authenticated evidence describing the source record represented by an acquisition. */
export interface RecordCoverageEvidence {
  readonly coverageSemantics: HistoryCoverageSemantics;
  readonly recordSpan?: HalfOpenIntervalSec;
}

export interface HistoryCapabilities {
  /** Canonical timeframes requestable from this exact resolved source. */
  readonly timeframes: readonly string[] | 'arbitrary';
  readonly maxBarsPerRequest?: number;
  readonly maxBarsPerAcquisition?: number;
  readonly alignment: HistoryAlignment;
  /**
   * Explicit opening anchor for UTC week-unit bars. Required before a `w`
   * timeframe can be fetched or formed exactly; non-week UTC bars remain
   * anchored at the Unix epoch.
   */
  readonly weekAnchorSec?: UnixSecond;
  /** Required whenever `alignment` is `exchange-calendar`. */
  readonly calendar?: HistorySessionCalendar;
  /** Defaults to `bars-only` when omitted by a backward-compatible provider. */
  readonly coverageSemantics?: HistoryCoverageSemantics;
  /** Optional source-wide span; per-timeframe spans belong in acquisition provenance. */
  readonly recordSpan?: HalfOpenIntervalSec;
  /** Trusted per-timeframe spans for sources serving multiple exact datasets. */
  readonly recordSpans?: Readonly<Record<string, HalfOpenIntervalSec>>;
}

/** Exact-source request. `requested` is logical; `query` may add bucket padding. */
export interface HistoryRequest {
  readonly timeframe: string;
  readonly requested: HalfOpenIntervalSec;
  readonly query?: HalfOpenIntervalSec;
}

export interface AcquisitionProvenance {
  readonly cacheIdentity: string;
  readonly normalizedSymbol: string;
  readonly sourceTimeframe: string;
  readonly targetTimeframe: string;
  readonly alignment: string;
  /** Exact UTC week-unit opening anchor carried from the resolved capability. */
  readonly weekAnchorSec?: UnixSecond;
  /** Explicit on newly produced acquisitions; omitted legacy evidence means `bars-only`. */
  readonly coverageSemantics?: HistoryCoverageSemantics;
  /** Required and authenticated whenever coverageSemantics is `complete-record`. */
  readonly recordSpan?: HalfOpenIntervalSec;
  readonly aggregationVersion: number;
}

export interface HistoryAcquisition {
  /** Source/target bars in pinery UNIX seconds. May include validated query padding. */
  readonly bars: readonly Bar[];
  /** Unpadded logical interval. */
  readonly requested: HalfOpenIntervalSec;
  /** Proven complete coverage, clipped to `requested`. */
  readonly covered: readonly HalfOpenIntervalSec[];
  /** Uncovered portions of `requested`. */
  readonly gaps: readonly CoverageGapSec[];
  readonly truncated?: HistoryTruncation;
  readonly complete: boolean;
  readonly provenance: AcquisitionProvenance;
}

/** A symbol-specific leaf source. Router/wrapper resolution must preserve this identity. */
export interface ResolvedHistorySource {
  /** Actual provider behind routing; cache wrappers preserve the underlying leaf here. */
  readonly provider: HistoryProvider;
  readonly normalizedSymbol: string;
  readonly cacheIdentity: string;
  readonly capabilities: HistoryCapabilities;
  history(request: HistoryRequest): Promise<HistoryAcquisition>;
}

export type ExactHistoryFailureKind = 'unsupported' | 'malformed' | 'provider-limited';

export interface ExactHistoryFailure {
  readonly type: 'exact-history-error';
  readonly kind: ExactHistoryFailureKind;
  readonly code: string;
  readonly permanent: true;
  readonly message: string;
  readonly details?: unknown;
  readonly requested?: HalfOpenIntervalSec;
  readonly covered?: readonly HalfOpenIntervalSec[];
  readonly gaps?: readonly CoverageGapSec[];
  readonly truncated?: HistoryTruncation;
}

/** Serializable, discriminated permanent failure for exact acquisition. */
export class ExactHistoryError extends Error {
  readonly type = 'exact-history-error' as const;
  readonly kind: ExactHistoryFailureKind;
  readonly code: string;
  readonly permanent = true as const;
  readonly details?: unknown;
  readonly requested?: HalfOpenIntervalSec;
  readonly covered?: readonly HalfOpenIntervalSec[];
  readonly gaps?: readonly CoverageGapSec[];
  readonly truncated?: HistoryTruncation;

  constructor(failure: Omit<ExactHistoryFailure, 'type' | 'permanent'>) {
    super(failure.message);
    this.name = 'ExactHistoryError';
    this.kind = failure.kind;
    this.code = failure.code;
    this.details = failure.details;
    this.requested = failure.requested;
    this.covered = failure.covered;
    this.gaps = failure.gaps;
    this.truncated = failure.truncated;
  }

  toJSON(): ExactHistoryFailure {
    return {
      type: this.type,
      kind: this.kind,
      code: this.code,
      permanent: this.permanent,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(this.requested ? { requested: this.requested } : {}),
      ...(this.covered ? { covered: this.covered } : {}),
      ...(this.gaps ? { gaps: this.gaps } : {}),
      ...(this.truncated ? { truncated: this.truncated } : {}),
    };
  }

  static fromJSON(value: unknown): ExactHistoryError {
    if (!isExactHistoryFailure(value)) {
      throw new TypeError('pinery: invalid serialized exact-history error');
    }
    return new ExactHistoryError(value);
  }
}

/** Per-symbol instrument metadata — the exchange's trading rules for a symbol. */
export interface InstrumentInfo {
  /** Minimum order-quantity step (lot step / minimum contract size). Drives the
   * broker's TV-parity quantity truncation. */
  minQty?: number;
  /** Minimum price increment (tick size) — piner's `syminfo.mintick`. */
  mintick?: number;
}

export interface HistoryProvider {
  /** Stable id used in legacy cache keys and diagnostics (e.g. "binance", "static"). */
  readonly id: string;
  /** Asset class this instance serves; unset for class-agnostic providers (static). */
  readonly assetClass?: AssetClass;
  history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]>;
  /**
   * Additive exact-history seam. Optional so existing third-party providers and
   * current `history()` callers remain source-compatible; the exported resolver
   * fails closed for providers that do not implement it.
   */
  resolveHistorySource?(symbol: string): Promise<ResolvedHistorySource>;
  /** Optional symbol trading rules. */
  instrument?(symbol: string): Promise<InstrumentInfo | undefined>;
}

/** Brand and validate a UNIX-second timestamp. */
export function unixSecond(value: number): UnixSecond {
  return checkedInteger(value, 'UNIX second') as UnixSecond;
}

/** Brand and validate a UNIX-millisecond timestamp. */
export function unixMillisecond(value: number): UnixMillisecond {
  return checkedInteger(value, 'UNIX millisecond') as UnixMillisecond;
}

export function halfOpenIntervalSec(from: number, to: number): HalfOpenIntervalSec {
  const interval = { from: unixSecond(from), to: unixSecond(to) };
  if (interval.from >= interval.to) {
    throw new RangeError(
      `pinery: half-open second interval must satisfy from < to (${from}, ${to})`,
    );
  }
  return interval;
}

export function halfOpenIntervalMs(from: number, to: number): HalfOpenIntervalMs {
  const interval = { from: unixMillisecond(from), to: unixMillisecond(to) };
  if (interval.from >= interval.to) {
    throw new RangeError(
      `pinery: half-open millisecond interval must satisfy from < to (${from}, ${to})`,
    );
  }
  return interval;
}

export function inclusiveRangeSec(from: number, toInclusive: number): InclusiveRangeSec {
  const range = { from: unixSecond(from), toInclusive: unixSecond(toInclusive) };
  if (range.from > range.toInclusive) {
    throw new RangeError(
      `pinery: inclusive second range must satisfy from <= toInclusive (${from}, ${toInclusive})`,
    );
  }
  return range;
}

/** `[from,toInclusive]` seconds → `[from,toInclusive+1)` seconds. */
export function inclusiveRangeSecToHalfOpen(range: InclusiveRangeSec): HalfOpenIntervalSec {
  return halfOpenIntervalSec(range.from, checkedAdd(range.toInclusive, 1, 'inclusive range end'));
}

/** `[from,toInclusive]` seconds → exact coarse millisecond interval. */
export function inclusiveRangeSecToHalfOpenMs(range: InclusiveRangeSec): HalfOpenIntervalMs {
  const toExclusive = checkedAdd(range.toInclusive, 1, 'inclusive range end');
  return halfOpenIntervalMs(
    checkedMultiply(range.from, 1000, 'range start'),
    checkedMultiply(toExclusive, 1000, 'range end'),
  );
}

/**
 * Padded logical milliseconds `[A,B)` → provider inclusive seconds
 * `[floor(A/1000), ceil(B/1000)-1]`. This is query arithmetic, never coverage proof.
 */
export function halfOpenMsToInclusiveRangeSec(interval: HalfOpenIntervalMs): InclusiveRangeSec {
  return inclusiveRangeSec(Math.floor(interval.from / 1000), Math.ceil(interval.to / 1000) - 1);
}

/**
 * Convert semantic millisecond bounds to seconds only when both are exactly
 * aligned. Exact mode rejects, rather than rounds, subsecond chart/bar bounds.
 */
export function halfOpenMsToHalfOpenSecExact(interval: HalfOpenIntervalMs): HalfOpenIntervalSec {
  if (interval.from % 1000 !== 0 || interval.to % 1000 !== 0) {
    throw new ExactHistoryError({
      kind: 'unsupported',
      code: 'subsecond-boundary',
      message: 'pinery: exact history boundaries must align to whole UNIX seconds',
      details: interval,
    });
  }
  return halfOpenIntervalSec(interval.from / 1000, interval.to / 1000);
}

/** Exact half-open seconds → the legacy inclusive provider selector. */
export function halfOpenSecToHistoryRange(interval: HalfOpenIntervalSec): HistoryRange {
  return { from: interval.from, to: checkedAdd(interval.to, -1, 'half-open range end') };
}

/** The coarse provider selector for an exact request, including optional padding. */
export function historyRequestRange(request: HistoryRequest): HistoryRange {
  return halfOpenSecToHistoryRange(request.query ?? request.requested);
}

/** Convert a bounded legacy inclusive-second selector to its full coarse ms interval. */
export function boundedHistoryRangeToHalfOpenMs(range: HistoryRange): HalfOpenIntervalMs {
  if (range.from == null || range.to == null) {
    throw new RangeError('pinery: bounded history range requires both from and to');
  }
  return inclusiveRangeSecToHalfOpenMs(inclusiveRangeSec(range.from, range.to));
}

/**
 * Apply a coarse inclusive-second query to exact timestamps without clamping
 * fractional provider opens. Unlike legacy `applyRange`, the final selected
 * second is the full interval `[to,to+1)`, allowing validation to reject a
 * subsecond bar boundary rather than hiding it.
 */
export function applyExactQueryRange(bars: Bar[], range?: HistoryRange): Bar[] {
  if (!range) return bars;
  let out = bars;
  if (range.from != null) {
    const from = unixSecond(range.from);
    out = out.filter((bar) => bar.time >= from);
  }
  if (range.to != null) {
    const toExclusive = checkedAdd(unixSecond(range.to), 1, 'exact query range end');
    out = out.filter((bar) => bar.time < toExclusive);
  }
  if (range.limit != null && out.length > range.limit) out = out.slice(out.length - range.limit);
  return out;
}

/**
 * Bridge a provider + fixed range into the `DataFeed` piner's `Engine` expects.
 * pinery carries bar times in unix SECONDS; piner expects MILLISECONDS.
 */
export function toDataFeed(provider: HistoryProvider, range?: HistoryRange): DataFeed {
  return {
    history: async (symbol: string, timeframe: string) => {
      const bars = await provider.history(symbol, timeframe, range);
      return bars.map((b) => (b.time >= 1e12 ? b : { ...b, time: b.time * 1000 }));
    },
  };
}

/** Drop bars whose interval has not closed yet. */
export function dropUnclosedBars(
  bars: Bar[],
  timeframe: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Bar[] {
  let end = bars.length;
  while (end > 0 && barCloseTime(bars[end - 1]!.time, timeframe) > nowSec) end--;
  return end === bars.length ? bars : bars.slice(0, end);
}

/** Close time (unix seconds) of a bar opened at `openSec`. Months use calendar arithmetic. */
function barCloseTime(openSec: number, timeframe: string): number {
  const { n, unit } = parseTimeframe(timeframe);
  if (unit === 'M') {
    const d = new Date(openSec * 1000);
    return (
      Date.UTC(
        d.getUTCFullYear(),
        d.getUTCMonth() + n,
        d.getUTCDate(),
        d.getUTCHours(),
        d.getUTCMinutes(),
        d.getUTCSeconds(),
      ) / 1000
    );
  }
  return openSec + timeframeSeconds(timeframe);
}

/** Apply a `HistoryRange` to an already-materialized, time-ascending bar array. */
export function applyRange(bars: Bar[], range?: HistoryRange): Bar[] {
  if (!range) return bars;
  let out = bars;
  if (range.from != null) out = out.filter((b) => b.time >= range.from!);
  if (range.to != null) out = out.filter((b) => b.time <= range.to!);
  if (range.limit != null && out.length > range.limit) out = out.slice(out.length - range.limit);
  return out;
}

function isExactHistoryFailure(value: unknown): value is ExactHistoryFailure {
  if (!isRecord(value)) return false;
  if (
    value.type !== 'exact-history-error' ||
    value.permanent !== true ||
    (value.kind !== 'unsupported' &&
      value.kind !== 'malformed' &&
      value.kind !== 'provider-limited') ||
    typeof value.code !== 'string' ||
    value.code.length === 0 ||
    typeof value.message !== 'string' ||
    value.message.length === 0
  ) {
    return false;
  }
  if (value.requested !== undefined && !isHalfOpenSecondInterval(value.requested)) return false;
  if (
    value.covered !== undefined &&
    (!Array.isArray(value.covered) || !value.covered.every(isHalfOpenSecondInterval))
  ) {
    return false;
  }
  if (
    value.gaps !== undefined &&
    (!Array.isArray(value.gaps) ||
      !value.gaps.every(
        (gap) =>
          isHalfOpenSecondInterval(gap) &&
          isRecord(gap) &&
          (gap.reason === 'provider-missing' ||
            gap.reason === 'partial-aggregate' ||
            gap.reason === 'provider-truncated'),
      ))
  ) {
    return false;
  }
  if (value.truncated !== undefined) {
    if (
      !isRecord(value.truncated) ||
      (value.truncated.side !== 'before' && value.truncated.side !== 'after') ||
      typeof value.truncated.reason !== 'string' ||
      value.truncated.reason.length === 0 ||
      (value.truncated.limit !== undefined &&
        (typeof value.truncated.limit !== 'number' ||
          !Number.isSafeInteger(value.truncated.limit) ||
          value.truncated.limit <= 0))
    ) {
      return false;
    }
  }
  return true;
}

function isHalfOpenSecondInterval(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.from) &&
    Number.isSafeInteger(value.to) &&
    (value.from as number) < (value.to as number)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkedInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`pinery: ${label} must be a finite safe integer (received ${value})`);
  }
  return value;
}

function checkedAdd(value: number, delta: number, label: string): number {
  return checkedInteger(value + delta, label);
}

function checkedMultiply(value: number, multiplier: number, label: string): number {
  return checkedInteger(value * multiplier, label);
}
