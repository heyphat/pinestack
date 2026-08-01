import {
  BarUpdateValidator,
  liveTimeframeSeconds,
  validateBarsExact,
  type Bar,
  type BarUpdate,
  type LiveSourcePolicy,
} from '@heyphat/pinery';

export type IntrabarEvaluationReason = 'eligible' | 'recovered-final' | 'startup-discontinuity';

export type IntrabarUpdateIdentity =
  | {
      readonly kind: 'live-update';
      /** Provider chart-bar open in UNIX seconds. */
      readonly barTime: number;
      readonly revision: number;
      readonly eventTime: number;
      readonly isClose: boolean;
      readonly source: LiveSourcePolicy;
      readonly recovered: boolean;
      readonly coalescedCount: number;
    }
  | {
      readonly kind: 'closed-bar';
      /** Provider chart-bar open in UNIX seconds. */
      readonly barTime: number;
      readonly revision: 1;
      readonly isClose: true;
      readonly recovered: false;
    };

/** One provider event admitted to the compute engine. */
export interface AcceptedIntrabarUpdate {
  readonly bar: Readonly<Bar>;
  readonly identity: IntrabarUpdateIdentity;
  /** True exactly once for each accepted chart time. */
  readonly finalCommit: boolean;
  readonly executable: boolean;
  readonly reason: IntrabarEvaluationReason;
}

export interface IntrabarStateOptions {
  readonly timeframe: string;
  /** Exclusive finalized chart-open cursor established by finite warmup. */
  readonly cutoverCursor: number;
  /** Earliest chart open that cannot overlap the final historical interval. */
  readonly firstAdmissibleLiveOpen?: number;
  /** Durable authoritative-final cursor restored after authority comparison. */
  readonly finalizedCursor?: number;
  /** Provider/session chart-grid phase in UNIX seconds. Default zero. */
  readonly anchorTime?: number;
  /** Required when accepting revisioned live updates; absent for closedBars(). */
  readonly source?: LiveSourcePolicy;
  /** Inhibit the first observed live chart time through its authoritative final. */
  readonly startupDiscontinuity?: boolean;
}

export class IntrabarStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IntrabarStateError';
  }
}

/**
 * Pinelive's independent trust-boundary state for chart updates. Pinery owns the
 * update protocol validator; this class adds the historical cutover and
 * executable/inhibited decision state without repairing or reordering events.
 */
export class IntrabarState {
  private readonly validator?: BarUpdateValidator;
  private readonly cutoverCursor: number;
  private readonly firstAdmissibleLiveOpen: number;
  private readonly anchorTime: number;
  private readonly durationSeconds: number;
  private finalizedCursorValue: number;
  private discontinuityPending: boolean;
  private discontinuityBarTime: number | undefined;

  constructor(private readonly options: IntrabarStateOptions) {
    if (!Number.isSafeInteger(options.cutoverCursor) || options.cutoverCursor < 0) {
      throw new IntrabarStateError(
        'intrabar cutover cursor must be a non-negative safe UNIX second',
      );
    }
    this.cutoverCursor = options.cutoverCursor;
    this.durationSeconds = liveTimeframeSeconds(options.timeframe);
    this.anchorTime = options.anchorTime ?? 0;
    if (!Number.isSafeInteger(this.anchorTime)) {
      throw new IntrabarStateError('intrabar chart anchor must be a safe UNIX second');
    }
    this.firstAdmissibleLiveOpen =
      options.firstAdmissibleLiveOpen ?? options.cutoverCursor + this.durationSeconds;
    if (
      !Number.isSafeInteger(this.firstAdmissibleLiveOpen) ||
      this.firstAdmissibleLiveOpen <= options.cutoverCursor
    ) {
      throw new IntrabarStateError(
        'first admissible live open must be a safe UNIX second after the cutover cursor',
      );
    }
    const finalizedCursor = options.finalizedCursor ?? options.cutoverCursor;
    if (
      !Number.isSafeInteger(finalizedCursor) ||
      finalizedCursor < options.cutoverCursor ||
      (finalizedCursor - this.anchorTime) % this.durationSeconds !== 0
    ) {
      throw new IntrabarStateError(
        'restored finalized cursor must be aligned at or after the historical cutover',
      );
    }
    this.finalizedCursorValue = finalizedCursor;
    this.discontinuityPending = options.startupDiscontinuity === true;
    if (options.source) {
      this.validator = new BarUpdateValidator({
        timeframe: options.timeframe,
        source: options.source,
        anchorTime: this.anchorTime,
      });
    }
  }

  get finalizedCursor(): number {
    return this.finalizedCursorValue;
  }

  /**
   * Validate one revisioned live update. Undefined is returned only for
   * Pinery's validated equivalent-duplicate-final exception.
   */
  acceptUpdate(input: BarUpdate): AcceptedIntrabarUpdate | undefined {
    if (!this.validator) {
      throw new IntrabarStateError('intrabar state was not configured for live updates');
    }
    if (input.bar.time < this.firstAdmissibleLiveOpen) {
      throw new IntrabarStateError(
        `live update ${String(input.bar.time)} crossed the exclusive warmup cutover ${this.cutoverCursor} / final close ${this.firstAdmissibleLiveOpen}`,
      );
    }

    const update = this.validator.accept(input);
    if (!update) return undefined;
    const eligibility = this.eligibility(
      update.bar.time,
      update.isClose,
      update.recovered === true,
    );
    if (update.isClose) this.finalizedCursorValue = update.bar.time;

    return Object.freeze({
      bar: update.bar,
      identity: Object.freeze({
        kind: 'live-update',
        barTime: update.bar.time,
        revision: update.revision,
        eventTime: update.eventTime,
        isClose: update.isClose,
        source: update.source,
        recovered: update.recovered === true,
        coalescedCount: update.coalescedCount ?? 0,
      }),
      finalCommit: update.isClose,
      executable: eligibility.executable,
      reason: eligibility.reason,
    });
  }

  /** Validate one authoritative closedBars() value and admit one final commit. */
  acceptClosedBar(input: Bar): AcceptedIntrabarUpdate {
    const bar = Object.freeze({ ...input });
    try {
      validateBarsExact([bar]);
    } catch (error) {
      throw new IntrabarStateError(
        error instanceof Error ? error.message : 'closedBars emitted a malformed bar',
        { cause: error },
      );
    }
    if (bar.time >= 1e12) {
      throw new IntrabarStateError('closedBars must emit whole UNIX-second chart opens');
    }
    if (bar.time < this.firstAdmissibleLiveOpen) {
      throw new IntrabarStateError(
        `closedBars chart time ${bar.time} crossed the exclusive warmup final close ${this.firstAdmissibleLiveOpen}`,
      );
    }
    if ((bar.time - this.anchorTime) % this.durationSeconds !== 0) {
      throw new IntrabarStateError(
        `closedBars chart time ${bar.time} is not aligned to the historical chart grid`,
      );
    }
    if (bar.time <= this.finalizedCursorValue) {
      throw new IntrabarStateError(
        `closedBars chart time ${bar.time} did not advance finalized cursor ${this.finalizedCursorValue}`,
      );
    }

    const eligibility = this.eligibility(bar.time, true, false);
    this.finalizedCursorValue = bar.time;
    return Object.freeze({
      bar,
      identity: Object.freeze({
        kind: 'closed-bar',
        barTime: bar.time,
        revision: 1,
        isClose: true,
        recovered: false,
      }),
      finalCommit: true,
      executable: eligibility.executable,
      reason: eligibility.reason,
    });
  }

  private eligibility(
    barTime: number,
    isClose: boolean,
    recovered: boolean,
  ): { readonly executable: boolean; readonly reason: IntrabarEvaluationReason } {
    if (this.discontinuityPending && this.discontinuityBarTime === undefined) {
      this.discontinuityBarTime = barTime;
    }
    const startupDiscontinuity = this.discontinuityPending && this.discontinuityBarTime === barTime;
    if (startupDiscontinuity && isClose) {
      this.discontinuityPending = false;
      this.discontinuityBarTime = undefined;
    }
    if (recovered) return { executable: false, reason: 'recovered-final' };
    if (startupDiscontinuity) {
      return { executable: false, reason: 'startup-discontinuity' };
    }
    return { executable: true, reason: 'eligible' };
  }
}
