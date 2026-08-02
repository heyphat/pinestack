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

/**
 * Broker-confirmed account identity. `opaqueAccountId` is sensitive and may be used only for
 * equality and domain-separated hashing; it must never enter logs, status payloads, or claim
 * paths in clear text.
 */
export interface CanonicalAccountIdentity {
  readonly identityVersion: 1;
  readonly brokerId: string;
  readonly opaqueAccountId: string;
  readonly environment?: string;
}

/** One complete working-order observation from the synchronized account boundary. */
export interface VenueOpenOrder {
  readonly brokerOrderId?: string;
  /** Full durable client identity only when the venue/adapter can recover it authoritatively. */
  readonly clientId?: string;
  /** Opaque venue metadata such as Tiger userMark; never treated as an idempotency key. */
  readonly venueIdentity?: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: 'market' | 'limit';
  readonly requestedQty: number;
  readonly filledQty: number;
  readonly limitPrice?: number;
  readonly status: 'working' | 'partially-filled' | 'unknown';
  readonly observedAt: string;
}

/**
 * One logical account boundary: account, position, and the complete open-order inventory are tied
 * to a stream resume point. A collection of unrelated REST reads does not satisfy this contract.
 */
export interface AccountSynchronizationSnapshot {
  readonly synchronizationVersion: 1;
  readonly accountIdentity: CanonicalAccountIdentity;
  readonly account: Readonly<Account>;
  readonly position: Readonly<Position>;
  readonly openOrders: readonly VenueOpenOrder[];
  readonly inventoryComplete: true;
  readonly exactOrderLookup: 'authoritative';
  readonly snapshotToken: string;
  readonly resumeFrom: string;
  readonly observedAt: string;
}

/**
 * A live, gap-free account view established from `snapshot.resumeFrom`. Implementations must turn
 * disconnect, rejected resume, sequence gaps, overflow, or staleness into an assertion failure
 * until a new complete snapshot/stream boundary has been established. They must also maintain a
 * current synchronized execution-safety view: any working/uncertain order or exact-position change
 * not attributable to a terminal mutation completed through this guarded broker must latch
 * `assertSafeToExecute` failed until a new complete boundary is established.
 */
export interface AccountSynchronizationSession {
  readonly snapshot: AccountSynchronizationSnapshot;
  /** Proves transport continuity only; it must not silently resnapshot across a gap. */
  assertSynchronized(signal?: AbortSignal): void | Promise<void>;
  /** Proves the current synchronized account view is still safe for another broker mutation. */
  assertSafeToExecute(signal?: AbortSignal): void | Promise<void>;
  close(): void | Promise<void>;
}

export type ProductionSynchronizationResult =
  | { readonly status: 'synchronized'; readonly session: AccountSynchronizationSession }
  | { readonly status: 'blocked'; readonly reasons: readonly string[] };

/** Rechecked by a safety-gated adapter immediately before every broker mutation. */
export interface ExecutionSafetyGuard {
  assertExecutionSafe(signal?: AbortSignal): void | Promise<void>;
}

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
 * The contract every pinelive broker must satisfy. Armed production additionally requires
 * synchronization and safety activation through `ProductionSafetyBroker`.
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
   * return ambiguous or unsupported; it must never submit, cancel, or flatten.
   */
  lookupOrder?(
    order: Readonly<OrderRequest>,
    signal?: AbortSignal,
  ): Promise<ExactOrderLookupResult>;
  /** Broker-confirmed sensitive identity used to derive the same-host account claim. */
  getCanonicalAccountIdentity?(signal?: AbortSignal): Promise<CanonicalAccountIdentity>;
  /** Complete snapshot plus already-established gap-free account stream. */
  synchronizeAccount?(
    symbol: string,
    signal?: AbortSignal,
  ): Promise<ProductionSynchronizationResult>;
  /** Install the runtime-owned claim/synchronization interlock before enabling any mutation. */
  setExecutionSafetyGuard?(guard: ExecutionSafetyGuard): void;
  /** Synchronously remove effect capability before claims are released. */
  clearExecutionSafetyGuard?(): void;
  flatten(symbol: string, signal?: AbortSignal): Promise<void>;
  /**
   * Request cancellation of the order carrying `clientId`, addressed by pinelive's own
   * identity rather than a venue id. Cancellation is a request, never a guarantee.
   */
  cancel?(clientId: string, signal?: AbortSignal): Promise<CancelOutcome>;
}

export interface ProductionSafetyBroker extends Broker {
  getCanonicalAccountIdentity(signal?: AbortSignal): Promise<CanonicalAccountIdentity>;
  synchronizeAccount(
    symbol: string,
    signal?: AbortSignal,
  ): Promise<ProductionSynchronizationResult>;
  setExecutionSafetyGuard(guard: ExecutionSafetyGuard): void;
  clearExecutionSafetyGuard(): void;
  lookupOrder(order: Readonly<OrderRequest>, signal?: AbortSignal): Promise<ExactOrderLookupResult>;
}

export function isProductionSafetyBroker(value: Broker): value is ProductionSafetyBroker {
  return (
    typeof value.getCanonicalAccountIdentity === 'function' &&
    typeof value.synchronizeAccount === 'function' &&
    typeof value.setExecutionSafetyGuard === 'function' &&
    typeof value.clearExecutionSafetyGuard === 'function' &&
    typeof value.lookupOrder === 'function'
  );
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
