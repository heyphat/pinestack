import type { Account, Fill, Instrument, OrderRequest, OrderType, Position } from './types.js';

export interface Capabilities {
  positionModel: 'netting' | 'hedging';
  orderTypes: ReadonlyArray<OrderType>;
  supportsNativeFlatten: boolean;
  fractionalQuantity: boolean;
  transport: 'poll' | 'stream';
  /** True only when `Broker.cancel` is implemented. Conformance checks the two agree. */
  supportsCancel: boolean;
}

export type BrokerErrorCode =
  'reject' | 'connectivity' | 'timeout' | 'rate-limit' | 'auth' | 'unknown-symbol' | 'precondition';

/** Whether a failed submit is proven not to have crossed the transmission boundary. */
export type SubmitFailureCertainty = 'definitely-not-sent' | 'possibly-sent';

/** Authoritative, read-only resolution of one exact durable order identity. */
export type ExactOrderLookupResult =
  | { status: 'filled'; fill: Fill }
  | { status: 'rejected'; message: string }
  | { status: 'not-found' }
  | { status: 'ambiguous'; detail?: string }
  | { status: 'unsupported'; detail?: string };

/** Expected operational adapter failure. Invariant/programmer errors remain ordinary errors. */
export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  readonly retryable: boolean;
  /**
   * Set only by a submit implementation that knows whether transmission began. At a submit
   * boundary omission is deliberately interpreted as `possibly-sent`; non-submit callers must
   * not infer anything from this optional field.
   */
  readonly submitFailureCertainty?: SubmitFailureCertainty;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: BrokerErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      submitFailureCertainty?: SubmitFailureCertainty;
      cause?: unknown;
      details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'BrokerError';
    this.code = code;
    this.retryable = options.retryable ?? ['connectivity', 'timeout', 'rate-limit'].includes(code);
    this.submitFailureCertainty = options.submitFailureCertainty;
    this.details = options.details;
  }
}

/** Conservative certainty at the submit boundary; adapters must opt in to safe retransmission. */
export function submitFailureCertainty(error: unknown): SubmitFailureCertainty {
  return error instanceof BrokerError && error.submitFailureCertainty === 'definitely-not-sent'
    ? 'definitely-not-sent'
    : 'possibly-sent';
}

/**
 * The contract every pinelive broker must satisfy. `id`, `capabilities`, `instrument`,
 * `getPosition`, `getAccount`, `submit`, and `flatten` are required; `connect`,
 * `disconnect`, exact `lookupOrder`, and `cancel` are optional but, when present, must honour the
 * documented semantics. `runBrokerConformance` from `@heyphat/pinelive/testing` enforces the
 * behavioural half of this contract; the type system enforces the shape.
 *
 * See `docs/pinelive-adapter-contract.md` for the full obligations of each method.
 */
export interface Broker {
  readonly id: string;
  connect?(signal?: AbortSignal): Promise<void>;
  disconnect?(): Promise<void>;
  capabilities(): Capabilities;
  instrument(symbol: string, signal?: AbortSignal): Promise<Instrument>;
  getPosition(symbol: string, signal?: AbortSignal): Promise<Position>;
  getAccount(signal?: AbortSignal): Promise<Account>;
  /** Resolve to a terminal fill and deduplicate for the lifetime of the adapter by clientId. */
  submit(order: OrderRequest, signal?: AbortSignal): Promise<Fill>;
  /**
   * Read-only exact lookup for the complete durable request identity. Implementations may return
   * terminal filled/rejected/not-found only when authoritative. Any bounded/recent search must
   * return ambiguous or leave this method unsupported; it must never submit, cancel, or flatten.
   */
  lookupOrder?(
    order: Readonly<OrderRequest>,
    signal?: AbortSignal,
  ): Promise<ExactOrderLookupResult>;
  flatten(symbol: string, signal?: AbortSignal): Promise<void>;
  /**
   * Request cancellation of the order carrying `clientId`, addressed by pinelive's own
   * identity rather than a venue id. Cancellation is a request, never a guarantee: a fill
   * may already be in flight, so implementations must re-read the order and report the
   * settled state. Resolves once the order is terminal; a fill that won the race is not an
   * error. Required whenever `capabilities().supportsCancel` is true, and gated by arming
   * exactly like `submit` and `flatten`.
   */
  cancel?(clientId: string, signal?: AbortSignal): Promise<CancelOutcome>;
}

/** Settled state of a cancellation request. */
export interface CancelOutcome {
  clientId: string;
  /** `cancelled` includes a partially filled order whose remainder was cancelled. */
  status: 'cancelled' | 'filled' | 'not-found';
  /** Cumulative filled quantity at the time the order settled. */
  filledQty: number;
}

export function isBrokerError(value: unknown): value is BrokerError {
  return value instanceof BrokerError;
}
