import { BrokerError } from './broker.js';
import type { Broker, BrokerErrorCode } from './broker.js';
import type { Fill, Instrument, OrderRequest, Position } from './types.js';
import { nativeQtyStep, snap } from './units.js';

export interface ReconcileContext {
  strategySymbol: string;
  executionSymbol: string;
  bindingId: string;
  barTime: number;
  timeframe: string;
  /** Stable operator-defined deployment/stream namespace. */
  executionId?: string;
  strategyId: string;
  /** Ledger ordering only; logical order identity is derived from observed state. */
  sequence: number;
  signal?: AbortSignal;
}

export interface ReconcileError {
  code: BrokerErrorCode;
  message: string;
  retryable: boolean;
  stage: 'position' | 'submit' | 'position-refresh';
}

export type ReconcileOutcome =
  | { action: 'noop'; target: number; actualBefore: number; actualAfter: number; delta: number }
  | {
      action: 'order';
      target: number;
      actualBefore: number;
      actualAfter: number | null;
      delta: number;
      order: OrderRequest;
      fill: Fill;
      /** A fill is authoritative even if the subsequent position refresh fails. */
      positionError?: ReconcileError;
    }
  | {
      action: 'reject';
      target: number;
      actualBefore: number | null;
      actualAfter: number | null;
      delta: number | null;
      order?: OrderRequest;
      error: ReconcileError;
    };

export interface PositionMirrorOptions {
  maxOrderQty?: number;
  epsilon?: number;
  transientRetries?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function stableNumber(value: number): string {
  return Object.is(value, -0) ? '0' : value.toString();
}

/**
 * Identify one logical correction, not merely one bar. Including observed and
 * target state means a retry of an unknown submission reuses the same id, while
 * a restart after a capped/partial fill gets a new id for the remaining delta.
 */
function stableClientId(
  ctx: ReconcileContext,
  actual: number,
  target: number,
  quantity: number,
): string {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  return [
    ctx.executionId ?? 'default',
    ctx.strategyId,
    ctx.strategySymbol,
    ctx.executionSymbol,
    ctx.bindingId,
    ctx.timeframe,
    Math.floor(ctx.barTime),
    stableNumber(actual),
    stableNumber(target),
    stableNumber(quantity),
    'reconcile',
  ]
    .map((value) => safe(String(value)))
    .join(':');
}

export class PositionMirror {
  private readonly step: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly broker: Broker,
    private readonly instrument: Instrument,
    private readonly options: PositionMirrorOptions = {},
  ) {
    this.step = nativeQtyStep(instrument);
    if (
      options.maxOrderQty != null &&
      (!Number.isFinite(options.maxOrderQty) || options.maxOrderQty < this.step)
    ) {
      throw new RangeError(
        `maxOrderQty must be finite and at least one quantity step (${this.step})`,
      );
    }
    if (options.epsilon != null && (!Number.isFinite(options.epsilon) || options.epsilon < 0)) {
      throw new RangeError('epsilon must be a non-negative finite number');
    }
    if (
      options.transientRetries != null &&
      (!Number.isInteger(options.transientRetries) || options.transientRetries < 0)
    ) {
      throw new RangeError('transientRetries must be a non-negative integer');
    }
    if (
      options.retryDelayMs != null &&
      (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs < 0)
    ) {
      throw new RangeError('retryDelayMs must be a non-negative finite number');
    }
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async reconcile(targetInput: number, ctx: ReconcileContext): Promise<ReconcileOutcome> {
    this.ensureActive(ctx.signal);
    if (!Number.isFinite(targetInput)) throw new RangeError('target position must be finite');
    const target = snap(targetInput, this.step);
    let actual: Position;
    try {
      actual = await this.broker.getPosition(ctx.executionSymbol, ctx.signal);
    } catch (error) {
      if (!(error instanceof BrokerError)) throw error;
      return this.rejection(target, null, null, error, 'position', undefined, null);
    }
    if (!Number.isFinite(actual.qty))
      throw new Error(`${this.broker.id}: getPosition returned a non-finite quantity`);
    this.ensureActive(ctx.signal);

    const rawDelta = target - actual.qty;
    const epsilon = this.options.epsilon ?? this.step / 2;
    if (Math.abs(rawDelta) < epsilon) {
      return {
        action: 'noop',
        target,
        actualBefore: actual.qty,
        actualAfter: actual.qty,
        delta: 0,
      };
    }

    let quantity = Math.abs(snap(rawDelta, this.step));
    if (this.options.maxOrderQty != null) {
      quantity = Math.min(quantity, Math.abs(snap(this.options.maxOrderQty, this.step)));
    }
    const minimum = this.instrument.minOrderQty ?? this.step;
    if (quantity < minimum || quantity === 0) {
      return {
        action: 'noop',
        target,
        actualBefore: actual.qty,
        actualAfter: actual.qty,
        delta: rawDelta,
      };
    }

    const order: OrderRequest = {
      symbol: ctx.executionSymbol,
      side: rawDelta > 0 ? 'buy' : 'sell',
      qty: quantity,
      type: 'market',
      clientId: stableClientId(ctx, actual.qty, target, quantity),
    };

    const attempts = Math.max(1, (this.options.transientRetries ?? 0) + 1);
    let fill: Fill | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.ensureActive(ctx.signal);
      try {
        fill = await this.broker.submit(order, ctx.signal);
        break;
      } catch (error) {
        if (!(error instanceof BrokerError)) throw error;
        if (!error.retryable || attempt === attempts) {
          let actualAfter: number | null = actual.qty;
          try {
            actualAfter = (await this.broker.getPosition(ctx.executionSymbol, ctx.signal)).qty;
          } catch (positionError) {
            if (!(positionError instanceof BrokerError)) throw positionError;
            actualAfter = null;
          }
          return this.rejection(target, actual.qty, rawDelta, error, 'submit', order, actualAfter);
        }
        await this.sleep((this.options.retryDelayMs ?? 250) * attempt);
      }
    }
    if (!fill) throw new Error('unreachable reconcile state');

    try {
      const after = await this.broker.getPosition(ctx.executionSymbol, ctx.signal);
      if (!Number.isFinite(after.qty))
        throw new Error(`${this.broker.id}: getPosition returned a non-finite quantity`);
      return {
        action: 'order',
        target,
        actualBefore: actual.qty,
        actualAfter: after.qty,
        delta: rawDelta,
        order,
        fill,
      };
    } catch (error) {
      if (!(error instanceof BrokerError)) throw error;
      return {
        action: 'order',
        target,
        actualBefore: actual.qty,
        actualAfter: null,
        delta: rawDelta,
        order,
        fill,
        positionError: this.error(error, 'position-refresh'),
      };
    }
  }

  private ensureActive(signal?: AbortSignal): void {
    if (signal?.aborted)
      throw new BrokerError('precondition', 'reconciliation aborted', { retryable: false });
  }

  private error(error: BrokerError, stage: ReconcileError['stage']): ReconcileError {
    return { code: error.code, message: error.message, retryable: error.retryable, stage };
  }

  private rejection(
    target: number,
    actualBefore: number | null,
    delta: number | null,
    error: BrokerError,
    stage: 'position' | 'submit',
    order?: OrderRequest,
    actualAfter: number | null = actualBefore,
  ): ReconcileOutcome {
    return {
      action: 'reject',
      target,
      actualBefore,
      actualAfter,
      delta,
      order,
      error: this.error(error, stage),
    };
  }
}
