import type { Account, Fill, Instrument, OrderRequest, OrderType, Position } from './types.js';

export interface Capabilities {
  positionModel: 'netting' | 'hedging';
  orderTypes: ReadonlyArray<OrderType>;
  supportsNativeFlatten: boolean;
  fractionalQuantity: boolean;
  transport: 'poll' | 'stream';
}

export type BrokerErrorCode =
  'reject' | 'connectivity' | 'timeout' | 'rate-limit' | 'auth' | 'unknown-symbol' | 'precondition';

/** Expected operational adapter failure. Invariant/programmer errors remain ordinary errors. */
export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: BrokerErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      cause?: unknown;
      details?: Readonly<Record<string, unknown>>;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'BrokerError';
    this.code = code;
    this.retryable = options.retryable ?? ['connectivity', 'timeout', 'rate-limit'].includes(code);
    this.details = options.details;
  }
}

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
  flatten(symbol: string, signal?: AbortSignal): Promise<void>;
}

export function isBrokerError(value: unknown): value is BrokerError {
  return value instanceof BrokerError;
}
