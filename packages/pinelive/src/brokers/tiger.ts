import { BrokerError } from '../core/broker.js';
import type {
  AccountSynchronizationSession,
  Broker,
  CancelOutcome,
  CanonicalAccountIdentity,
  Capabilities,
  ExactOrderLookupResult,
  ExecutionSafetyGuard,
  ProductionSynchronizationResult,
} from '../core/broker.js';
import type { Account, Fill, Instrument, OrderRequest, Position, Side } from '../core/types.js';
import { isStepAligned } from '../core/units.js';

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
  /** Optional for market responses; required when validating a limit order. */
  type?: 'market' | 'limit';
  limitPrice?: number;
  /** `working` and `partially-filled` are non-terminal; the cancelled variant is terminal. */
  status:
    | 'working'
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
  /** Exact transport-resolved account identity, when known from a credential profile. */
  readonly accountId?: string;
  /** Distinguishes demo/live/region when the same account text can name different resources. */
  readonly accountEnvironment?: string;
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
  /**
   * Authoritative lookup of the complete durable order identity. A recent/bounded userMark scan
   * does not implement this method. Returning not-found proves absence at the venue boundary.
   */
  lookupOrderExact?(
    accountId: string,
    order: Readonly<OrderRequest>,
    signal?: AbortSignal,
  ): Promise<ExactOrderLookupResult>;
  /**
   * Resolve only after account, position, complete open-order inventory, exact terminal lookup,
   * and a gap-free resumable account stream are established as one logical boundary.
   */
  synchronizeAccount?(
    accountId: string,
    symbol: string,
    signal?: AbortSignal,
  ): Promise<AccountSynchronizationSession>;
  submitMarket(
    accountId: string,
    request: { symbol: string; side: Side; qty: number; clientId: string },
    signal?: AbortSignal,
  ): Promise<TigerOrderResult>;
  /** Optional native limit path; responses and lookups must preserve type and limitPrice. */
  submitLimit?(
    accountId: string,
    request: {
      symbol: string;
      side: Side;
      qty: number;
      clientId: string;
      limitPrice: number;
    },
    signal?: AbortSignal,
  ): Promise<TigerOrderResult>;
  /**
   * Cancel a still-working order by its broker order id. Cancellation is a request,
   * not a guarantee: a fill may already be in flight, so callers must re-read state.
   * Optional so transports can omit cancellation when the venue does not support it.
   */
  cancelOrder?(accountId: string, orderId: string, signal?: AbortSignal): Promise<void>;
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
  /**
   * Ask the venue to cancel an order that is still working after `maxOrderPolls`,
   * instead of leaving it live. Off by default: cancelling mutates venue state and
   * races an in-flight fill, so it is an explicit operator choice.
   */
  cancelStuckOrders?: boolean;
  /**
   * Require a runtime-installed claim/synchronization guard in addition to operator arming.
   * Armed production runtimes set this to true.
   */
  requireExecutionSafety?: boolean;
}

interface CachedFill {
  fingerprint: string;
  fill: Fill;
}

interface RetiredClientId {
  /** Missing only when cancellation discovered an order created outside this adapter instance. */
  fingerprint?: string;
  message: string;
}

export class TigerBroker implements Broker {
  readonly id = 'tiger';
  private accountValue?: TigerTradingAccount;
  private readonly instruments = new Map<string, Instrument>();
  private readonly fills = new Map<string, CachedFill>();
  /** Terminal non-fill identities remain retired even if bounded venue history later forgets them. */
  private readonly retiredClientIds = new Map<string, RetiredClientId>();
  private readonly pending = new Map<string, string>();
  private submitTail: Promise<void> = Promise.resolve();
  private executionSafetyGuard?: ExecutionSafetyGuard;

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
    // Only expose cancel when the transport can honour it, so the capability declaration
    // and the implemented surface cannot drift apart.
    if (typeof options.transport.cancelOrder === 'function')
      this.cancel = (clientId, signal) => this.cancelByClientId(clientId, signal);
  }

  capabilities(): Capabilities {
    return {
      positionModel: 'netting',
      orderTypes:
        typeof this.options.transport.submitLimit === 'function' &&
        typeof this.options.transport.cancelOrder === 'function' &&
        this.options.cancelStuckOrders === true
          ? ['market', 'limit']
          : ['market'],
      supportsNativeFlatten: false,
      fractionalQuantity: false,
      transport: 'poll',
      supportsCancel: typeof this.options.transport.cancelOrder === 'function',
    };
  }

  async connect(signal?: AbortSignal): Promise<void> {
    try {
      await this.options.transport.connect?.(signal);
      const expectedAccountId = this.options.accountId ?? this.options.transport.accountId;
      const account = await this.options.transport.account(expectedAccountId, signal);
      if (expectedAccountId && account.id !== expectedAccountId)
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
    const cached = this.instruments.get(symbol);
    if (cached) return { ...cached };
    try {
      const value = await this.options.transport.instrument(symbol, signal);
      if (value.symbol !== symbol)
        throw new BrokerError(
          'precondition',
          'tiger: transport returned a different execution contract',
        );
      const instrument: Instrument = {
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
      this.instruments.set(symbol, instrument);
      return { ...instrument };
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

  async getCanonicalAccountIdentity(signal?: AbortSignal): Promise<CanonicalAccountIdentity> {
    const account = await this.ensureAccount(signal);
    return {
      identityVersion: 1,
      brokerId: this.id,
      opaqueAccountId: account.id,
      ...(this.options.transport.accountEnvironment
        ? { environment: this.options.transport.accountEnvironment }
        : {}),
    };
  }

  async synchronizeAccount(
    symbol: string,
    signal?: AbortSignal,
  ): Promise<ProductionSynchronizationResult> {
    const synchronize = this.options.transport.synchronizeAccount;
    const missingGuarantees: string[] = [];
    if (!synchronize) {
      missingGuarantees.push(
        'Tiger transport cannot prove complete open-order inventory and snapshot-to-stream continuity',
      );
    }
    if (!this.options.transport.lookupOrderExact) {
      missingGuarantees.push('Tiger transport cannot perform authoritative exact order lookup');
    }
    if (missingGuarantees.length > 0) {
      return { status: 'blocked', reasons: missingGuarantees };
    }

    const synchronizeAccount = synchronize!;
    let session: AccountSynchronizationSession | undefined;
    try {
      const account = await this.ensureAccount(signal);
      session = await synchronizeAccount.call(this.options.transport, account.id, symbol, signal);
      validateSynchronizationSession(session, account.id, symbol, this.options.transport);
      await session.assertSynchronized(signal);
      await session.assertSafeToExecute(signal);
      return { status: 'synchronized', session };
    } catch (error) {
      const reasons = [
        `Tiger account synchronization failed: ${classifyTigerBrokerError(error, 'synchronize').message}`,
      ];
      if (session && typeof session.close === 'function') {
        try {
          await session.close();
        } catch (closeError) {
          reasons.push(
            `Tiger account synchronization cleanup failed: ${classifyTigerBrokerError(closeError, 'synchronize cleanup').message}`,
          );
        }
      }
      return { status: 'blocked', reasons };
    }
  }

  async lookupOrder(
    order: Readonly<OrderRequest>,
    signal?: AbortSignal,
  ): Promise<ExactOrderLookupResult> {
    const lookup = this.options.transport.lookupOrderExact;
    if (!lookup) {
      return {
        status: 'unsupported',
        detail: 'Tiger transport exposes only a bounded recent-order search',
      };
    }
    try {
      validateOrderRequest(order);
      const account = await this.ensureAccount(signal);
      const result = await lookup.call(this.options.transport, account.id, order, signal);
      return validateExactLookupResult(result, order);
    } catch (error) {
      return {
        status: 'ambiguous',
        detail: classifyTigerBrokerError(error, 'exact order lookup').message,
      };
    }
  }

  setExecutionSafetyGuard(guard: ExecutionSafetyGuard): void {
    if (!guard || typeof guard.assertExecutionSafe !== 'function')
      throw new TypeError('tiger: execution safety guard is invalid');
    this.executionSafetyGuard = guard;
  }

  clearExecutionSafetyGuard(): void {
    this.executionSafetyGuard = undefined;
  }

  async submit(order: OrderRequest, signal?: AbortSignal): Promise<Fill> {
    try {
      await this.assertExecutionSafe('submit', signal);
      this.throwIfAborted(signal);
      validateOrderRequest(order);
      return await this.withSubmitLock(() => this.submitLocked(order, signal), signal);
    } catch (error) {
      if (error instanceof BrokerError && (error.code === 'reject' || error.submitFailureCertainty))
        throw error;
      throw tigerSubmitFailure(error, 'definitely-not-sent');
    }
  }

  private async submitLocked(order: OrderRequest, signal?: AbortSignal): Promise<Fill> {
    this.throwIfAborted(signal);
    if (order.type === 'limit') {
      if (typeof this.options.transport.submitLimit !== 'function')
        throw new BrokerError('reject', 'tiger: transport does not support limit orders');
      if (!this.options.cancelStuckOrders || !this.options.transport.cancelOrder)
        throw new BrokerError(
          'precondition',
          'tiger: limit orders require cancelStuckOrders and transport cancellation support',
        );
    }
    const fingerprint = orderFingerprint(order);
    const cached = this.fills.get(order.clientId);
    if (cached) {
      if (cached.fingerprint !== fingerprint)
        throw new BrokerError('precondition', 'tiger: client id was reused with a different order');
      return structuredClone(cached.fill);
    }
    const retired = this.retiredClientIds.get(order.clientId);
    if (retired) {
      if (retired.fingerprint != null && retired.fingerprint !== fingerprint)
        throw new BrokerError('precondition', 'tiger: client id was reused with a different order');
      throw new BrokerError('reject', retired.message, {
        retryable: false,
        submitFailureCertainty: 'definitely-not-sent',
      });
    }
    const pendingFingerprint = this.pending.get(order.clientId);
    if (pendingFingerprint && pendingFingerprint !== fingerprint)
      throw tigerSubmitFailure(
        new BrokerError('precondition', 'tiger: pending client id has a different order'),
        'possibly-sent',
      );
    if (!pendingFingerprint && this.pending.size > 0)
      throw new BrokerError(
        'timeout',
        'tiger: another submitted order is still unresolved; refusing a second live correction',
        { retryable: true },
      );

    let possiblySent = pendingFingerprint != null;
    let result: TigerOrderResult | undefined;
    try {
      const instrument = await this.instrument(order.symbol, signal);
      const qtyStep = instrument.qtyStep ?? instrument.minQty;
      if (!isStepAligned(order.qty, qtyStep) || order.qty < (instrument.minOrderQty ?? qtyStep))
        throw new BrokerError('precondition', 'tiger: order quantity is off-step or below minimum');
      if (order.type === 'limit' && !isStepAligned(order.limitPrice, instrument.mintick))
        throw new BrokerError('precondition', 'tiger: limit price is not aligned to mintick');
      const account = await this.ensureAccount(signal);
      this.throwIfAborted(signal);
      result = await this.options.transport.findOrderByClientId(account.id, order.clientId, signal);
      this.throwIfAborted(signal);
      if (result) {
        possiblySent = true;
        validateOrderIdentity(result, order);
        if (!isProvenTerminal(result.status)) this.pending.set(order.clientId, fingerprint);
      }
      if (!result && pendingFingerprint) {
        throw new BrokerError('timeout', 'tiger: prior order outcome is still unknown', {
          retryable: true,
          submitFailureCertainty: 'possibly-sent',
        });
      }
      if (!result) {
        // Recheck both cooperative claims and stream health at the final pre-transmission
        // boundary. A failure here remains definitely-not-sent because no pending marker or
        // transport call has occurred yet.
        await this.assertExecutionSafe('submit', signal);
        // Reserve before transmission. From this assignment onward every failure is possibly sent.
        this.pending.set(order.clientId, fingerprint);
        possiblySent = true;
        result =
          order.type === 'limit'
            ? await this.options.transport.submitLimit!(
                account.id,
                {
                  symbol: order.symbol,
                  side: order.side,
                  qty: order.qty,
                  clientId: order.clientId,
                  limitPrice: order.limitPrice,
                },
                signal,
              )
            : await this.options.transport.submitMarket(
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
      if (classified.code === 'reject') throw classified;
      if (!possiblySent) throw tigerSubmitFailure(classified, 'definitely-not-sent');
      result = undefined;
      try {
        const account = await this.ensureAccount(signal);
        const recovered = await this.options.transport.findOrderByClientId(
          account.id,
          order.clientId,
          signal,
        );
        if (recovered) {
          validateOrderIdentity(recovered, order);
          if (!isProvenTerminal(recovered.status)) this.pending.set(order.clientId, fingerprint);
          result = await this.awaitTerminal(account.id, recovered, order, signal);
        }
      } catch {
        // A failed bounded recovery read cannot prove absence or permit retransmission.
      }
      if (!result) throw tigerSubmitFailure(classified, 'possibly-sent');
    }
    let fill: Fill;
    try {
      fill = terminalFill(result, order);
    } catch (error) {
      if (error instanceof BrokerError && error.code === 'reject') {
        this.retiredClientIds.set(order.clientId, {
          fingerprint,
          message: error.message,
        });
        this.pending.delete(order.clientId);
        throw error;
      }
      // A malformed or non-terminal response is not proof that the effect is absent. Keep the
      // pending marker so a bounded lookup miss can never reopen transmission for this client id.
      throw tigerSubmitFailure(error, 'possibly-sent');
    }
    this.pending.delete(order.clientId);
    this.fills.set(order.clientId, { fingerprint, fill });
    return structuredClone(fill);
  }

  private async withSubmitLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.submitTail;
    let release!: () => void;
    this.submitTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.throwIfAborted(signal);
      return await operation();
    } finally {
      release();
    }
  }

  async flatten(symbol: string, signal?: AbortSignal): Promise<void> {
    await this.assertExecutionSafe('flatten', signal);
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

  /**
   * Protocol-level cancellation, addressed by pinelive's client id. Present only when the
   * transport can cancel, so `capabilities().supportsCancel` and this method never disagree.
   * The venue read after the cancel decides the outcome, so a fill that beat the request is
   * reported as filled rather than raised as an error.
   */
  cancel?: (clientId: string, signal?: AbortSignal) => Promise<CancelOutcome>;

  private async cancelByClientId(clientId: string, signal?: AbortSignal): Promise<CancelOutcome> {
    await this.assertExecutionSafe('cancel', signal);
    this.throwIfAborted(signal);
    const cancelOrder = this.options.transport.cancelOrder!;
    const account = await this.ensureAccount(signal);
    try {
      const existing = await this.options.transport.findOrderByClientId(
        account.id,
        clientId,
        signal,
      );
      if (!existing) {
        if (this.pending.has(clientId))
          throw new BrokerError(
            'timeout',
            'tiger: pending order is not yet visible; cancel outcome is unknown',
            { retryable: true },
          );
        return { clientId, status: 'not-found', filledQty: 0 };
      }
      if (
        existing.orderId &&
        (existing.status === 'working' ||
          existing.status === 'partially-filled' ||
          existing.status === 'unknown')
      ) {
        this.throwIfAborted(signal);
        try {
          await this.assertExecutionSafe('cancel', signal);
          await cancelOrder.call(this.options.transport, account.id, existing.orderId, signal);
        } catch (error) {
          const classified = classifyTigerBrokerError(error, 'cancel');
          // A refused cancel usually means the order already settled; the re-read decides.
          if (!classified.retryable && classified.code !== 'reject') throw classified;
        }
      }
      const settled =
        (await this.options.transport.findOrderByClientId(account.id, clientId, signal)) ??
        existing;
      if (settled.status === 'working' || settled.status === 'partially-filled')
        throw new BrokerError('timeout', 'tiger: order is still working after cancel', {
          retryable: true,
        });
      if (settled.status === 'unknown')
        throw new BrokerError('timeout', 'tiger: cancel outcome is still unknown', {
          retryable: true,
        });
      const pendingFingerprint = this.pending.get(clientId);
      this.pending.delete(clientId);
      this.retiredClientIds.set(clientId, {
        ...(pendingFingerprint == null ? {} : { fingerprint: pendingFingerprint }),
        message: `tiger: order is already terminal (${settled.status})`,
      });
      return {
        clientId,
        status: settled.status === 'filled' ? 'filled' : 'cancelled',
        filledQty: settled.filledQty ?? 0,
      };
    } catch (error) {
      throw classifyTigerBrokerError(error, 'cancel');
    }
  }

  private async awaitTerminal(
    accountId: string,
    initial: TigerOrderResult,
    order: OrderRequest,
    signal?: AbortSignal,
  ): Promise<TigerOrderResult> {
    let result = initial;
    for (
      let poll = 0;
      result.status === 'working' || result.status === 'partially-filled';
      poll++
    ) {
      if (poll >= (this.options.maxOrderPolls ?? 20)) {
        const settled = await this.cancelStuck(accountId, result, order, signal);
        if (settled) return settled;
        throw new BrokerError('timeout', 'tiger: order is still working', {
          retryable: true,
        });
      }
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

  /**
   * Request cancellation of an order still working after the poll budget, then re-read it.
   * A cancel can lose the race against a fill, so the re-read decides the outcome and the
   * caller keeps the same client id either way. Returns a terminal result, or undefined
   * when the order is still not terminal and the caller should surface a timeout.
   */
  private async cancelStuck(
    accountId: string,
    working: TigerOrderResult,
    order: OrderRequest,
    signal?: AbortSignal,
  ): Promise<TigerOrderResult | undefined> {
    if (!this.options.cancelStuckOrders) return undefined;
    const cancel = this.options.transport.cancelOrder;
    if (!cancel || !working.orderId) return undefined;
    await this.assertExecutionSafe('cancel', signal);
    try {
      await cancel.call(this.options.transport, accountId, working.orderId, signal);
    } catch (error) {
      // A rejected cancel usually means the order already reached a terminal state;
      // the re-read below is authoritative either way.
      const classified = classifyTigerBrokerError(error, 'cancel');
      if (!classified.retryable && classified.code !== 'reject') throw classified;
    }
    for (let poll = 0; poll <= (this.options.maxOrderPolls ?? 20); poll++) {
      const settled = await this.options.transport.findOrderByClientId(
        accountId,
        order.clientId,
        signal,
      );
      if (settled) {
        validateOrderIdentity(settled, order);
        if (settled.status !== 'working' && settled.status !== 'partially-filled') return settled;
      }
      if (poll < (this.options.maxOrderPolls ?? 20)) {
        await this.sleep(this.options.orderPollIntervalMs ?? 250, signal);
        this.throwIfAborted(signal);
      }
    }
    return undefined;
  }

  private async ensureAccount(signal?: AbortSignal): Promise<TigerTradingAccount> {
    if (!this.accountValue) await this.connect(signal);
    return this.accountValue!;
  }

  private async assertExecutionSafe(operation: string, signal?: AbortSignal): Promise<void> {
    this.ensureArmed(operation);
    this.throwIfAborted(signal);
    const guard = this.executionSafetyGuard;
    if (this.options.requireExecutionSafety && !guard) {
      throw new BrokerError(
        'precondition',
        `tiger: ${operation} is blocked until production safety synchronization completes`,
        { retryable: false },
      );
    }
    try {
      await guard?.assertExecutionSafe(signal);
    } catch {
      throw new BrokerError('precondition', `tiger: ${operation} safety interlock is unavailable`, {
        retryable: false,
      });
    }
    this.throwIfAborted(signal);
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

function validateSynchronizationSession(
  session: AccountSynchronizationSession,
  accountId: string,
  symbol: string,
  transport: TigerTradingTransport,
): void {
  if (
    !session ||
    typeof session !== 'object' ||
    typeof session.assertSynchronized !== 'function' ||
    typeof session.assertSafeToExecute !== 'function'
  )
    throw new BrokerError('precondition', 'tiger: synchronization session is invalid');
  if (typeof session.close !== 'function')
    throw new BrokerError('precondition', 'tiger: synchronization session cannot be closed');
  const snapshot = session.snapshot;
  if (
    !snapshot ||
    snapshot.synchronizationVersion !== 1 ||
    snapshot.inventoryComplete !== true ||
    snapshot.exactOrderLookup !== 'authoritative' ||
    !snapshot.snapshotToken ||
    !snapshot.resumeFrom ||
    !Number.isFinite(Date.parse(snapshot.observedAt))
  )
    throw new BrokerError('precondition', 'tiger: account snapshot is incomplete');
  if (
    snapshot.accountIdentity.identityVersion !== 1 ||
    snapshot.accountIdentity.brokerId !== 'tiger' ||
    snapshot.accountIdentity.opaqueAccountId !== accountId ||
    snapshot.accountIdentity.environment !== transport.accountEnvironment ||
    snapshot.account.id !== accountId
  )
    throw new BrokerError('precondition', 'tiger: synchronized account identity changed');
  if (snapshot.position.symbol !== symbol || !Number.isFinite(snapshot.position.qty))
    throw new BrokerError('precondition', 'tiger: synchronized position is invalid');
  if (!Array.isArray(snapshot.openOrders))
    throw new BrokerError('precondition', 'tiger: synchronized order inventory is invalid');
  for (const order of snapshot.openOrders) {
    if (
      order.symbol !== symbol ||
      !['buy', 'sell'].includes(order.side) ||
      !['market', 'limit'].includes(order.type) ||
      !['working', 'partially-filled', 'unknown'].includes(order.status) ||
      !Number.isFinite(order.requestedQty) ||
      order.requestedQty <= 0 ||
      !Number.isFinite(order.filledQty) ||
      order.filledQty < 0 ||
      order.filledQty > order.requestedQty ||
      !Number.isFinite(Date.parse(order.observedAt))
    )
      throw new BrokerError('precondition', 'tiger: synchronized open order is invalid');
  }
}

function validateExactLookupResult(
  result: ExactOrderLookupResult,
  order: Readonly<OrderRequest>,
): ExactOrderLookupResult {
  if (!result || typeof result !== 'object')
    return { status: 'ambiguous', detail: 'exact lookup returned an invalid response' };
  if (result.status === 'filled') {
    const fill = result.fill;
    if (
      fill.clientId !== order.clientId ||
      fill.symbol !== order.symbol ||
      fill.side !== order.side ||
      fill.requestedQty !== order.qty ||
      (fill.status !== 'filled' && fill.status !== 'partially-filled') ||
      !Number.isFinite(fill.filledQty) ||
      fill.filledQty <= 0 ||
      fill.filledQty > order.qty ||
      !Number.isFinite(fill.price) ||
      !Number.isFinite(fill.commission) ||
      !Number.isFinite(fill.time)
    )
      return { status: 'ambiguous', detail: 'exact lookup returned a mismatched fill' };
    return { status: 'filled', fill: structuredClone(fill) };
  }
  if (result.status === 'rejected') {
    return result.message.trim()
      ? { status: 'rejected', message: result.message }
      : { status: 'ambiguous', detail: 'exact lookup returned an empty rejection' };
  }
  if (result.status === 'not-found') return { status: 'not-found' };
  if (result.status === 'ambiguous' || result.status === 'unsupported')
    return result.detail
      ? { status: result.status, detail: result.detail }
      : { status: result.status };
  return { status: 'ambiguous', detail: 'exact lookup returned an unknown status' };
}

function isProvenTerminal(status: TigerOrderResult['status']): boolean {
  return (
    status === 'filled' ||
    status === 'partially-filled-cancelled' ||
    status === 'rejected' ||
    status === 'cancelled'
  );
}

function terminalFill(result: TigerOrderResult, order: OrderRequest): Fill {
  if (result.status === 'rejected' || result.status === 'cancelled')
    throw new BrokerError('reject', `tiger: order ${result.status}`, { retryable: false });
  if (result.status === 'unknown')
    throw new BrokerError('timeout', 'tiger: order outcome is unknown', { retryable: true });
  if (result.status === 'working' || result.status === 'partially-filled')
    throw new BrokerError('timeout', 'tiger: order is still working', {
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
  if (order.type === 'limit') {
    const worse =
      order.side === 'buy' ? result.price! > order.limitPrice : result.price! < order.limitPrice;
    if (worse)
      throw new BrokerError('precondition', 'tiger: limit fill price is worse than requested');
  }
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

function orderFingerprint(order: OrderRequest): string {
  return `${order.symbol}\0${order.side}\0${order.qty}\0${order.type}\0${
    order.type === 'limit' ? order.limitPrice : ''
  }`;
}

function validateOrderRequest(order: OrderRequest): void {
  if (!order || typeof order !== 'object')
    throw new BrokerError('precondition', 'tiger: order must be an object');
  if (typeof order.symbol !== 'string' || !order.symbol.trim())
    throw new BrokerError('precondition', 'tiger: order symbol is required');
  if (typeof order.clientId !== 'string' || !order.clientId.trim())
    throw new BrokerError('precondition', 'tiger: order client id is required');
  if (order.side !== 'buy' && order.side !== 'sell')
    throw new BrokerError('precondition', 'tiger: order side must be "buy" or "sell"');
  if (order.type !== 'market' && order.type !== 'limit')
    throw new BrokerError('reject', `tiger: ${String(order.type)} orders are not supported`);
  if (!Number.isFinite(order.qty) || order.qty <= 0)
    throw new BrokerError('precondition', 'tiger: order quantity must be positive');
  if (order.type === 'limit' && (!Number.isFinite(order.limitPrice) || order.limitPrice <= 0))
    throw new BrokerError('precondition', 'tiger: limit price must be positive and finite');
}

function validateOrderIdentity(result: TigerOrderResult, order: OrderRequest): void {
  if (
    ![
      'working',
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
    result.requestedQty !== order.qty ||
    (result.type != null && result.type !== order.type) ||
    (order.type === 'limit' && (result.type !== 'limit' || result.limitPrice !== order.limitPrice))
  ) {
    throw new BrokerError('precondition', 'tiger: order response identity does not match request');
  }
}

function tigerSubmitFailure(
  error: unknown,
  certainty: 'definitely-not-sent' | 'possibly-sent',
): BrokerError {
  const classified = classifyTigerBrokerError(error, 'submit');
  return new BrokerError(classified.code, classified.message, {
    retryable: classified.retryable,
    submitFailureCertainty: certainty,
    details: classified.details,
  });
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
