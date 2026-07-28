import { BrokerError } from '../core/broker.js';
import type { Broker, Capabilities } from '../core/broker.js';
import type { Account, Fill, Instrument, OrderRequest, Position, Side } from '../core/types.js';

export interface TigerTradingAccount {
  id: string;
  currency: string;
  balance: number;
  equity: number;
  available?: number;
}

export interface TigerTradingInstrument {
  symbol: string;
  mintick: number;
  qtyStep: number;
  minOrderQty: number;
  pointValue?: number;
  exchange?: string;
  expiry?: string;
}

export interface TigerTradingPosition {
  symbol: string;
  /** Signed net contracts. */
  qty: number;
  avgPrice?: number;
  unrealizedPnl?: number;
  realizedPnl?: number;
  updatedAt?: number;
}

export interface TigerOrderResult {
  clientId: string;
  orderId?: string;
  symbol: string;
  side: Side;
  /** `partially-filled` is still working; the cancelled variant is terminal. */
  status:
    | 'filled'
    | 'partially-filled'
    | 'partially-filled-cancelled'
    | 'rejected'
    | 'cancelled'
    | 'unknown';
  requestedQty: number;
  /** Cumulative filled quantity. */
  filledQty?: number;
  price?: number;
  commission?: number;
  commissionCurrency?: string;
  time?: number;
  message?: string;
}

/** Execution-only production seam. Implementations hide SDK/account details. */
export interface TigerTradingTransport {
  connect?(signal?: AbortSignal): Promise<void>;
  disconnect?(): Promise<void>;
  account(accountId?: string, signal?: AbortSignal): Promise<TigerTradingAccount>;
  instrument(symbol: string, signal?: AbortSignal): Promise<TigerTradingInstrument>;
  position(accountId: string, symbol: string, signal?: AbortSignal): Promise<TigerTradingPosition>;
  findOrderByClientId(
    accountId: string,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<TigerOrderResult | undefined>;
  submitMarket(
    accountId: string,
    request: { symbol: string; side: Side; qty: number; clientId: string },
    signal?: AbortSignal,
  ): Promise<TigerOrderResult>;
}

export interface TigerBrokerOptions {
  transport: TigerTradingTransport;
  /** Real submission and flatten are independently gated. */
  armed: boolean;
  accountId?: string;
  orderPollIntervalMs?: number;
  maxOrderPolls?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Test/custom persistence seam. The default is collision-resistant across restarts. */
  operationIdFactory?: () => string;
}

interface CachedFill {
  fingerprint: string;
  fill: Fill;
}

export class TigerBroker implements Broker {
  readonly id = 'tiger';
  private accountValue?: TigerTradingAccount;
  private readonly fills = new Map<string, CachedFill>();
  private readonly pending = new Map<string, string>();

  constructor(private readonly options: TigerBrokerOptions) {
    if (!options.transport) throw new Error('tiger broker: a trading transport is required');
    if (
      options.orderPollIntervalMs != null &&
      (!Number.isFinite(options.orderPollIntervalMs) || options.orderPollIntervalMs < 0)
    )
      throw new RangeError('tiger broker: orderPollIntervalMs must be non-negative');
    if (
      options.maxOrderPolls != null &&
      (!Number.isInteger(options.maxOrderPolls) || options.maxOrderPolls < 0)
    )
      throw new RangeError('tiger broker: maxOrderPolls must be a non-negative integer');
  }

  capabilities(): Capabilities {
    return {
      positionModel: 'netting',
      orderTypes: ['market'],
      supportsNativeFlatten: true,
      fractionalQuantity: false,
      transport: 'poll',
    };
  }

  async connect(signal?: AbortSignal): Promise<void> {
    try {
      await this.options.transport.connect?.(signal);
      const account = await this.options.transport.account(this.options.accountId, signal);
      if (this.options.accountId && account.id !== this.options.accountId)
        throw new BrokerError('precondition', 'tiger: configured trading account was not returned');
      this.accountValue = account;
    } catch (error) {
      throw classifyTigerBrokerError(error, 'connect');
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.options.transport.disconnect?.();
    } catch (error) {
      throw classifyTigerBrokerError(error, 'disconnect');
    }
  }

  async instrument(symbol: string, signal?: AbortSignal): Promise<Instrument> {
    try {
      const value = await this.options.transport.instrument(symbol, signal);
      if (value.symbol !== symbol)
        throw new BrokerError(
          'precondition',
          'tiger: transport returned a different execution contract',
        );
      return {
        symbol: value.symbol,
        brokerSymbol: value.symbol,
        dataSymbol: value.symbol,
        minQty: value.qtyStep,
        qtyStep: value.qtyStep,
        minOrderQty: value.minOrderQty,
        mintick: value.mintick,
        pointValue: value.pointValue,
        brokerQtyPerNative: 1,
        brokerQtyStep: value.qtyStep,
        exchange: value.exchange,
        expiry: value.expiry,
      };
    } catch (error) {
      throw classifyTigerBrokerError(error, 'instrument');
    }
  }

  async getPosition(symbol: string, signal?: AbortSignal): Promise<Position> {
    const account = await this.ensureAccount(signal);
    try {
      const value = await this.options.transport.position(account.id, symbol, signal);
      if (value.symbol !== symbol)
        throw new BrokerError(
          'precondition',
          'tiger: position response changed execution contract',
        );
      if (!Number.isFinite(value.qty))
        throw new BrokerError('precondition', 'tiger: position quantity is invalid');
      return { ...value };
    } catch (error) {
      throw classifyTigerBrokerError(error, 'position');
    }
  }

  async getAccount(signal?: AbortSignal): Promise<Account> {
    const account = await this.ensureAccount(signal);
    return { ...account };
  }

  async submit(order: OrderRequest, signal?: AbortSignal): Promise<Fill> {
    this.ensureArmed('submit');
    this.throwIfAborted(signal);
    if (order.type !== 'market')
      throw new BrokerError('reject', 'tiger: only market orders are supported');
    if (!Number.isFinite(order.qty) || order.qty <= 0)
      throw new BrokerError('precondition', 'tiger: order quantity must be positive');
    const fingerprint = orderFingerprint(order);
    const cached = this.fills.get(order.clientId);
    if (cached) {
      if (cached.fingerprint !== fingerprint)
        throw new BrokerError('precondition', 'tiger: client id was reused with a different order');
      return structuredClone(cached.fill);
    }
    const pendingFingerprint = this.pending.get(order.clientId);
    if (pendingFingerprint && pendingFingerprint !== fingerprint)
      throw new BrokerError('precondition', 'tiger: pending client id has a different order');
    const account = await this.ensureAccount(signal);
    this.throwIfAborted(signal);
    let result: TigerOrderResult | undefined;
    try {
      result = await this.options.transport.findOrderByClientId(account.id, order.clientId, signal);
      this.throwIfAborted(signal);
      if (result) validateOrderIdentity(result, order);
      if (!result && pendingFingerprint) {
        throw new BrokerError('timeout', 'tiger: prior order outcome is still unknown', {
          retryable: true,
        });
      }
      if (!result) {
        // Once transmission starts, absence from an eventually-consistent lookup is not
        // proof of non-acceptance. Retries query this id but never retransmit it.
        this.pending.set(order.clientId, fingerprint);
        result = await this.options.transport.submitMarket(
          account.id,
          {
            symbol: order.symbol,
            side: order.side,
            qty: order.qty,
            clientId: order.clientId,
          },
          signal,
        );
        validateOrderIdentity(result, order);
      }
      result = await this.awaitTerminal(account.id, result, order, signal);
    } catch (error) {
      const classified = classifyTigerBrokerError(error, 'submit');
      if (!classified.retryable) throw classified;
      result = undefined;
      try {
        const recovered = await this.options.transport.findOrderByClientId(
          account.id,
          order.clientId,
          signal,
        );
        if (recovered) {
          validateOrderIdentity(recovered, order);
          result = await this.awaitTerminal(account.id, recovered, order, signal);
        }
      } catch (recoveryError) {
        const recovery = classifyTigerBrokerError(recoveryError, 'submit recovery');
        if (!recovery.retryable) throw recovery;
      }
      if (!result) throw classified;
    }
    const fill = terminalFill(result, order);
    this.pending.delete(order.clientId);
    this.fills.set(order.clientId, { fingerprint, fill });
    return structuredClone(fill);
  }

  async flatten(symbol: string, signal?: AbortSignal): Promise<void> {
    this.ensureArmed('flatten');
    const operationId =
      this.options.operationIdFactory?.() ?? globalThis.crypto.randomUUID().replaceAll('-', '');
    if (!operationId) throw new BrokerError('precondition', 'tiger: flatten operation id is empty');
    for (let attempt = 1; attempt <= 10; attempt++) {
      const position = await this.getPosition(symbol, signal);
      if (position.qty === 0) return;
      await this.submit(
        {
          symbol,
          side: position.qty > 0 ? 'sell' : 'buy',
          qty: Math.abs(position.qty),
          type: 'market',
          clientId: `flatten:${symbol}:${operationId}:${attempt}:${position.qty}`,
        },
        signal,
      );
    }
    const remaining = await this.getPosition(symbol, signal);
    if (remaining.qty !== 0)
      throw new BrokerError('precondition', 'tiger: flatten did not reach zero exposure');
  }

  private async awaitTerminal(
    accountId: string,
    initial: TigerOrderResult,
    order: OrderRequest,
    signal?: AbortSignal,
  ): Promise<TigerOrderResult> {
    let result = initial;
    for (let poll = 0; result.status === 'partially-filled'; poll++) {
      if (poll >= (this.options.maxOrderPolls ?? 20))
        throw new BrokerError('timeout', 'tiger: partially filled order is still working', {
          retryable: true,
        });
      await this.sleep(this.options.orderPollIntervalMs ?? 250, signal);
      this.throwIfAborted(signal);
      const next = await this.options.transport.findOrderByClientId(
        accountId,
        order.clientId,
        signal,
      );
      if (!next) continue;
      validateOrderIdentity(next, order);
      result = next;
    }
    return result;
  }

  private async ensureAccount(signal?: AbortSignal): Promise<TigerTradingAccount> {
    if (!this.accountValue) await this.connect(signal);
    return this.accountValue!;
  }

  private ensureArmed(operation: string): void {
    if (!this.options.armed)
      throw new BrokerError('precondition', `tiger: ${operation} requires explicit arming`, {
        retryable: false,
      });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted)
      throw new BrokerError('precondition', 'tiger: submission aborted', { retryable: false });
  }

  private sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return (this.options.sleep ?? abortableSleep)(milliseconds, signal);
  }
}

function terminalFill(result: TigerOrderResult, order: OrderRequest): Fill {
  if (result.status === 'rejected' || result.status === 'cancelled')
    throw new BrokerError('reject', `tiger: order ${result.status}`, { retryable: false });
  if (result.status === 'unknown')
    throw new BrokerError('timeout', 'tiger: order outcome is unknown', { retryable: true });
  if (result.status === 'partially-filled')
    throw new BrokerError('timeout', 'tiger: partially filled order is still working', {
      retryable: true,
    });
  if (
    !Number.isFinite(result.filledQty) ||
    result.filledQty! <= 0 ||
    result.filledQty! > order.qty ||
    !Number.isFinite(result.price) ||
    result.price! <= 0
  )
    throw new BrokerError('precondition', 'tiger: terminal order response has invalid fill data');
  if (result.status === 'filled' && result.filledQty !== order.qty)
    throw new BrokerError(
      'precondition',
      'tiger: filled order did not report the requested quantity',
    );
  if (result.status === 'partially-filled-cancelled' && result.filledQty === order.qty)
    throw new BrokerError('precondition', 'tiger: terminal partial order reported a complete fill');
  return {
    clientId: order.clientId,
    brokerOrderId: result.orderId,
    symbol: order.symbol,
    side: order.side,
    status: result.status === 'filled' ? 'filled' : 'partially-filled',
    requestedQty: order.qty,
    filledQty: result.filledQty!,
    price: result.price!,
    commission: result.commission ?? 0,
    commissionCurrency: result.commissionCurrency,
    time: result.time ?? Math.floor(Date.now() / 1000),
  };
}

function orderFingerprint(order: Pick<OrderRequest, 'symbol' | 'side' | 'qty' | 'type'>): string {
  return `${order.symbol}\0${order.side}\0${order.qty}\0${order.type}`;
}

function validateOrderIdentity(result: TigerOrderResult, order: OrderRequest): void {
  if (
    ![
      'filled',
      'partially-filled',
      'partially-filled-cancelled',
      'rejected',
      'cancelled',
      'unknown',
    ].includes(result.status)
  )
    throw new BrokerError('precondition', 'tiger: order response has an unknown status');
  if (
    result.clientId !== order.clientId ||
    result.symbol !== order.symbol ||
    result.side !== order.side ||
    result.requestedQty !== order.qty
  ) {
    throw new BrokerError('precondition', 'tiger: order response identity does not match request');
  }
}

function classifyTigerBrokerError(error: unknown, operation: string): BrokerError {
  if (error instanceof BrokerError) return error;
  const value = error as { code?: string; message?: string } | null;
  const raw = `${value?.code ?? ''} ${value?.message ?? ''}`.toLowerCase();
  const code =
    raw.includes('auth') || raw.includes('credential')
      ? 'auth'
      : raw.includes('rate') || raw.includes('429')
        ? 'rate-limit'
        : raw.includes('timeout')
          ? 'timeout'
          : raw.includes('reject')
            ? 'reject'
            : raw.includes('symbol') || raw.includes('contract')
              ? 'unknown-symbol'
              : 'connectivity';
  return new BrokerError(code, `tiger: ${operation} failed`);
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || milliseconds === 0) return resolve();
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
