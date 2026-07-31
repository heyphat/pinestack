import { MarketDataError, type Bar, type BarUpdate, type LiveSourcePolicy } from '../provider.js';
import {
  BarUpdateValidator,
  DEFAULT_MAX_FORMING_BARS,
  liveTimeframeSeconds,
  validateBarUpdate,
} from './validation.js';

export interface ExactChildBucket {
  readonly open: number;
  /** Exact ordered child opens belonging to this provider/session bucket. */
  readonly slots: readonly number[];
}

export interface ExactChildAggregationOptions {
  readonly sourceTimeframe: string;
  readonly targetTimeframe: string;
  /** UTC fixture anchor. Production/session sources should provide `bucketFor`. */
  readonly anchorTime?: number;
  readonly maxFormingBars?: number;
  /** Provider calendar/session evidence converted to an exact slot resolver. */
  readonly bucketFor?: (childOpen: number) => ExactChildBucket;
}

interface ParentState {
  readonly bucket: ExactChildBucket;
  readonly children: Map<number, BarUpdate>;
  revision: number;
}

/**
 * Incrementally aggregate exact lower-timeframe snapshots. Each child slot is a
 * replaceable snapshot keyed by its open, so revised OHLCV (including volume)
 * replaces the previous revision instead of being accumulated twice.
 *
 * Child count never proves chart finality. `finalize()` requires a separate
 * authoritative chart final and rejects any aggregate mismatch.
 */
export class ExactChildBarAggregator {
  private readonly sourceDuration: number;
  private readonly targetDuration: number;
  private readonly ratio: number;
  private readonly anchor: number;
  private readonly maxForming: number;
  private readonly sourcePolicy: LiveSourcePolicy;
  private readonly validator: BarUpdateValidator;
  private readonly outputValidator: BarUpdateValidator;
  private readonly parents = new Map<number, ParentState>();

  constructor(private readonly options: ExactChildAggregationOptions) {
    this.sourceDuration = liveTimeframeSeconds(options.sourceTimeframe);
    this.targetDuration = liveTimeframeSeconds(options.targetTimeframe);
    this.anchor = options.anchorTime ?? 0;
    if (!Number.isSafeInteger(this.anchor)) {
      throw new RangeError('pinery: live aggregate anchorTime must be a safe unix second');
    }
    if (
      this.sourceDuration >= this.targetDuration ||
      this.targetDuration % this.sourceDuration !== 0
    ) {
      throw malformed(
        `${options.sourceTimeframe} is not an exact child timeframe of ${options.targetTimeframe}`,
      );
    }
    this.ratio = this.targetDuration / this.sourceDuration;
    this.maxForming = options.maxFormingBars ?? DEFAULT_MAX_FORMING_BARS;
    if (!Number.isSafeInteger(this.maxForming) || this.maxForming <= 0) {
      throw new RangeError('pinery: maxFormingBars must be a positive safe integer');
    }
    this.sourcePolicy = Object.freeze({
      kind: 'lower-bars',
      timeframe: options.sourceTimeframe,
    });
    this.validator = new BarUpdateValidator({
      timeframe: options.sourceTimeframe,
      source: this.sourcePolicy,
      anchorTime: this.anchor,
      maxFormingBars: 1,
      sourceEvent: true,
    });
    this.outputValidator = new BarUpdateValidator({
      timeframe: options.targetTimeframe,
      source: this.sourcePolicy,
      anchorTime: this.anchor,
      isAlignedOpen: options.bucketFor ? (open) => this.parents.has(open) : undefined,
      maxFormingBars: 1,
    });
  }

  get formingCount(): number {
    return this.parents.size;
  }

  /** Resolve and snapshot the exact provider/session bucket for one child open. */
  bucketFor(childOpen: number): ExactChildBucket {
    const raw = this.options.bucketFor
      ? this.options.bucketFor(childOpen)
      : utcBucket(childOpen, this.sourceDuration, this.targetDuration, this.ratio, this.anchor);
    if (
      !raw ||
      !Number.isSafeInteger(raw.open) ||
      raw.open < 0 ||
      (!this.options.bucketFor && (raw.open - this.anchor) % this.targetDuration !== 0) ||
      !Array.isArray(raw.slots) ||
      raw.slots.length !== this.ratio
    ) {
      throw malformed('provider returned invalid live child bucket evidence', { childOpen });
    }
    const slots = raw.slots.map((slot) => slot);
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]!;
      if (
        !Number.isSafeInteger(slot) ||
        slot < 0 ||
        slot !== raw.open + index * this.sourceDuration
      ) {
        throw malformed('provider returned an invalid live child slot', { childOpen, slot });
      }
    }
    if (!slots.includes(childOpen)) {
      throw malformed('source update does not belong to its provider live bucket', { childOpen });
    }
    return Object.freeze({ open: raw.open, slots: Object.freeze(slots) });
  }

  /** Whether this aggregator currently owns child state for the chart open. */
  hasParent(open: number): boolean {
    return this.parents.has(open);
  }

  /** True only when every provider-proven child slot has an authoritative child final. */
  isComplete(open: number): boolean {
    const parent = this.parents.get(open);
    return Boolean(
      parent && parent.bucket.slots.every((slot) => parent.children.get(slot)?.isClose === true),
    );
  }

  /** Return the next forming chart snapshot, or undefined until the first exact slot exists. */
  accept(input: BarUpdate): BarUpdate | undefined {
    const child = this.validator.accept(input);
    if (!child) return undefined;

    const bucket = this.bucketFor(child.bar.time);
    let parent = this.parents.get(bucket.open);
    if (!parent) {
      if (this.parents.size >= this.maxForming) {
        throw malformed('live aggregation exceeded its bounded forming-bar state', {
          maxFormingBars: this.maxForming,
          time: child.bar.time,
        });
      }
      parent = { bucket, children: new Map(), revision: 0 };
      this.parents.set(bucket.open, parent);
    } else if (!sameSlots(parent.bucket, bucket)) {
      throw malformed('provider live bucket evidence changed within a chart bar', {
        time: bucket.open,
      });
    }
    parent.children.set(child.bar.time, child);

    const members = contiguousMembers(parent);
    if (members.length === 0 || !members.some((member) => member.bar.time === child.bar.time)) {
      return undefined;
    }
    return this.snapshot(parent, members, child.eventTime, false);
  }

  /**
   * Compare and emit a separate authoritative chart final. Expected child slots
   * must all be authoritative; slot count alone never calls this method.
   */
  finalize(input: BarUpdate): BarUpdate {
    const final = validateBarUpdate(input, {
      timeframe: this.options.targetTimeframe,
      source: this.sourcePolicy,
      anchorTime: this.anchor,
      isAlignedOpen: this.options.bucketFor ? (open) => this.parents.has(open) : undefined,
    });
    if (!final.isClose) throw malformed('live aggregate finalization requires isClose=true');

    const parent = this.parents.get(final.bar.time);
    if (!parent) {
      throw malformed('authoritative chart final has no live child aggregation state', {
        time: final.bar.time,
      });
    }
    const members = parent.bucket.slots.map((slot) => parent.children.get(slot));
    if (members.some((member) => !member || !member.isClose)) {
      throw malformed('authoritative chart final arrived before every exact child slot finalized', {
        time: final.bar.time,
      });
    }
    const expected = aggregateBar(parent.bucket.open, members as BarUpdate[]);
    if (!sameBar(expected, final.bar)) {
      throw malformed('authoritative chart final conflicts with exact child aggregation', {
        time: final.bar.time,
      });
    }

    const revision = parent.revision + 1;
    const output = this.outputValidator.accept(
      Object.freeze({
        ...final,
        bar: Object.freeze({ ...final.bar }),
        revision,
        source: this.sourcePolicy,
      }),
    );
    if (!output) throw malformed('authoritative aggregate final was unexpectedly duplicated');
    parent.revision = revision;
    this.parents.delete(final.bar.time);
    return output;
  }

  private snapshot(
    parent: ParentState,
    members: readonly BarUpdate[],
    eventTime: number,
    isClose: boolean,
  ): BarUpdate {
    const revision = parent.revision + 1;
    const output = this.outputValidator.accept(
      Object.freeze({
        bar: Object.freeze(aggregateBar(parent.bucket.open, members)),
        isClose,
        revision,
        eventTime,
        source: this.sourcePolicy,
      }),
    );
    if (!output) throw malformed('forming aggregate was unexpectedly deduplicated');
    parent.revision = revision;
    return output;
  }
}

/** Lazily produce forming aggregates; authoritative finals must use `finalize()`. */
export async function* aggregateExactChildBarUpdates(
  updates: AsyncIterable<BarUpdate> | Iterable<BarUpdate>,
  options: ExactChildAggregationOptions,
): AsyncIterable<BarUpdate> {
  const aggregator = new ExactChildBarAggregator(options);
  for await (const update of updates) {
    const aggregated = aggregator.accept(update);
    if (aggregated) yield aggregated;
  }
}

function contiguousMembers(parent: ParentState): BarUpdate[] {
  const members: BarUpdate[] = [];
  for (const slot of parent.bucket.slots) {
    const member = parent.children.get(slot);
    if (!member) break;
    members.push(member);
  }
  return members;
}

function aggregateBar(open: number, members: readonly BarUpdate[]): Bar {
  const first = members[0]!.bar;
  const last = members[members.length - 1]!.bar;
  let high = first.high;
  let low = first.low;
  let volume = 0;
  for (const member of members) {
    high = Math.max(high, member.bar.high);
    low = Math.min(low, member.bar.low);
    volume += member.bar.volume;
  }
  if (!Number.isFinite(volume)) {
    throw malformed('live aggregate volume is not finite', { time: open });
  }
  return { time: open, open: first.open, high, low, close: last.close, volume };
}

function utcBucket(
  childOpen: number,
  sourceDuration: number,
  targetDuration: number,
  ratio: number,
  anchor: number,
): ExactChildBucket {
  const open = anchor + Math.floor((childOpen - anchor) / targetDuration) * targetDuration;
  return {
    open,
    slots: Array.from({ length: ratio }, (_, index) => open + index * sourceDuration),
  };
}

function sameSlots(left: ExactChildBucket, right: ExactChildBucket): boolean {
  return (
    left.open === right.open &&
    left.slots.length === right.slots.length &&
    left.slots.every((slot, index) => slot === right.slots[index])
  );
}

function sameBar(left: Readonly<Bar>, right: Readonly<Bar>): boolean {
  return (
    left.time === right.time &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close &&
    volumesEquivalent(left.volume, right.volume)
  );
}

/**
 * OHLC values are selected, so they compare exactly; volume is SUMMED, and floating-point
 * summation is order-sensitive, so a provider that totalled the same children differently can
 * disagree in the last bits. Only relative noise is tolerated — a real conflict (a missing or
 * revised child) moves volume by far more than 1e-9 of its magnitude.
 */
function volumesEquivalent(left: number, right: number): boolean {
  if (left === right) return true;
  return Math.abs(left - right) <= Math.max(Math.abs(left), Math.abs(right)) * 1e-9;
}

function malformed(message: string, details?: Readonly<Record<string, unknown>>): MarketDataError {
  return new MarketDataError('malformed-data', `pinery: ${message}`, {
    retryable: false,
    details,
  });
}
