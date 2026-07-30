import { BrokerError } from '../core/broker.js';
import type { Broker, Capabilities } from '../core/broker.js';
import type { Account, Fill, Instrument, OrderRequest, Position } from '../core/types.js';
import { isStepAligned, nativeQtyStep } from '../core/units.js';

export interface PaperBrokerOptions {
  instruments?: Readonly<Record<string, Instrument>>;
  /** Lazy exact-contract metadata, useful when pinery resolves the contract at runner startup. */
  instrumentResolver?: (symbol: string) => Instrument | Promise<Instrument>;
  accountId?: string;
  currency?: string;
  initialBalance?: number;
  slippageBps?: number;
  commissionPerUnit?: number;
  reject?: (order: OrderRequest) => string | undefined;
}

interface PaperState {
  qty: number;
  avgPrice?: number;
  realizedPnl: number;
  mark?: { price: number; time: number };
}

/** Optional venue-neutral pricing hook used by simulated brokers. */
export interface MarkableBroker {
  mark(symbol: string, price: number, time: number): void | Promise<void>;
}

export function isMarkableBroker(broker: Broker): broker is Broker & MarkableBroker {
  return typeof (broker as Broker & Partial<MarkableBroker>).mark === 'function';
}

interface CachedFill {
  fingerprint: string;
  fill: Fill;
}

function orderFingerprint(order: OrderRequest): string {
  return `${order.symbol}\u0000${order.side}\u0000${order.qty}\u0000${order.type}\u0000${
    order.type === 'limit' ? order.limitPrice : ''
  }`;
}

function isTickAligned(price: number, mintick: number): boolean {
  if (!Number.isFinite(price) || !Number.isFinite(mintick) || mintick <= 0) return false;
  const units = price / mintick;
  const nearestUnits = Math.round(units);
  // Beyond safe-integer precision JavaScript cannot prove which venue tick was requested.
  if (!Number.isSafeInteger(nearestUnits)) return false;
  const nearest = nearestUnits * mintick;
  const tolerance = Math.min(
    mintick * 0.01,
    Math.max(mintick * 1e-9, Number.EPSILON * 16 * Math.max(1, Math.abs(price), Math.abs(nearest))),
  );
  return Math.abs(price - nearest) <= tolerance;
}

export class PaperBroker implements Broker, MarkableBroker {
  readonly id = 'paper';
  private readonly states = new Map<string, PaperState>();
  private readonly instruments = new Map<string, Instrument>();
  private readonly fills = new Map<string, CachedFill>();
  private readonly initialBalance: number;
  private commissions = 0;
  private orderSequence = 0;
  private flattenSequence = 0;

  constructor(private readonly options: PaperBrokerOptions) {
    this.initialBalance = options.initialBalance ?? 100_000;
    if (!Number.isFinite(this.initialBalance) || this.initialBalance < 0)
      throw new RangeError('initialBalance must be a non-negative finite number');
    if (
      options.slippageBps != null &&
      (!Number.isFinite(options.slippageBps) ||
        options.slippageBps < 0 ||
        options.slippageBps >= 10_000)
    ) {
      throw new RangeError('slippageBps must be finite and in [0, 10000)');
    }
    if (
      options.commissionPerUnit != null &&
      (!Number.isFinite(options.commissionPerUnit) || options.commissionPerUnit < 0)
    ) {
      throw new RangeError('commissionPerUnit must be a non-negative finite number');
    }
    for (const [symbol, instrument] of Object.entries(options.instruments ?? {})) {
      this.validateInstrument(symbol, instrument);
      this.instruments.set(symbol, instrument);
    }
  }

  capabilities(): Capabilities {
    return {
      positionModel: 'netting',
      orderTypes: ['market', 'limit'],
      supportsNativeFlatten: false,
      fractionalQuantity: true,
      transport: 'poll',
      // Paper fills at the current mark, so no order ever rests to be cancelled.
      supportsCancel: false,
    };
  }

  async instrument(symbol: string): Promise<Instrument> {
    let instrument = this.instruments.get(symbol);
    if (!instrument && this.options.instrumentResolver) {
      instrument = await this.options.instrumentResolver(symbol);
      this.validateInstrument(symbol, instrument);
      this.instruments.set(symbol, instrument);
    }
    if (!instrument) throw new BrokerError('unknown-symbol', `paper: unknown symbol ${symbol}`);
    return instrument;
  }

  mark(symbol: string, price: number, time: number): void {
    if (!Number.isFinite(price) || price <= 0)
      throw new RangeError('mark price must be positive and finite');
    if (!Number.isFinite(time) || time < 0)
      throw new RangeError('mark time must be a non-negative finite number');
    const state = this.state(symbol);
    if (state.mark && time < state.mark.time)
      throw new BrokerError('precondition', 'paper: marks must be monotonic');
    state.mark = { price, time };
  }

  async getPosition(symbol: string): Promise<Position> {
    const instrument = await this.instrument(symbol);
    const state = this.state(symbol);
    return {
      symbol,
      qty: state.qty,
      avgPrice: state.avgPrice,
      realizedPnl: state.realizedPnl,
      unrealizedPnl: this.unrealized(state, instrument),
      updatedAt: state.mark?.time,
    };
  }

  async getAccount(): Promise<Account> {
    let realizedPnl = 0;
    let unrealizedPnl = 0;
    for (const [symbol, state] of this.states) {
      realizedPnl += state.realizedPnl;
      const instrument = this.instruments.get(symbol);
      if (instrument) unrealizedPnl += this.unrealized(state, instrument);
    }
    const balance = this.initialBalance + realizedPnl - this.commissions;
    return {
      id: this.options.accountId ?? 'paper',
      currency: this.options.currency ?? 'USD',
      balance,
      equity: balance + unrealizedPnl,
      available: balance + unrealizedPnl,
      realizedPnl,
      unrealizedPnl,
    };
  }

  async submit(order: OrderRequest): Promise<Fill> {
    if (!order || typeof order !== 'object')
      throw new BrokerError('precondition', 'paper: order must be an object');
    if (typeof order.symbol !== 'string' || !order.symbol.trim())
      throw new BrokerError('precondition', 'paper: order symbol is required');
    if (typeof order.clientId !== 'string' || !order.clientId.trim())
      throw new BrokerError('precondition', 'paper: order client id is required');
    if (order.side !== 'buy' && order.side !== 'sell')
      throw new BrokerError('precondition', 'paper: order side must be "buy" or "sell"');
    if (order.type !== 'market' && order.type !== 'limit')
      throw new BrokerError('reject', `paper: ${String(order.type)} orders are not supported`);
    if (!Number.isFinite(order.qty) || order.qty <= 0)
      throw new BrokerError('precondition', 'paper: order qty must be positive');

    const prior = this.fills.get(order.clientId);
    if (prior) {
      if (prior.fingerprint !== orderFingerprint(order)) {
        throw new BrokerError(
          'precondition',
          `paper: client id ${order.clientId} was reused with a different order`,
        );
      }
      return structuredClone(prior.fill);
    }
    const instrument = await this.instrument(order.symbol);
    const state = this.state(order.symbol);
    if (!state.mark)
      throw new BrokerError('precondition', `paper: ${order.symbol} must be marked before submit`);
    if (order.type === 'limit') {
      if (!Number.isFinite(order.limitPrice) || order.limitPrice <= 0)
        throw new BrokerError('precondition', 'paper: limit price must be positive and finite');
      if (!isTickAligned(order.limitPrice, instrument.mintick))
        throw new BrokerError('precondition', 'paper: limit price is not aligned to mintick');
      const marketable =
        order.side === 'buy'
          ? order.limitPrice >= state.mark.price
          : order.limitPrice <= state.mark.price;
      if (!marketable)
        throw new BrokerError(
          'reject',
          'paper: resting limit orders are not simulated; limit is not marketable at the mark',
        );
    }
    const rejection = this.options.reject?.(order);
    if (rejection) throw new BrokerError('reject', rejection);

    const step = nativeQtyStep(instrument);
    if (!isStepAligned(order.qty, step))
      throw new BrokerError('precondition', 'paper: order quantity is not aligned to its step');
    const qty = order.qty;
    if (qty < (instrument.minOrderQty ?? step)) {
      throw new BrokerError(
        'reject',
        `paper: quantity is below the ${instrument.minOrderQty ?? step} minimum`,
      );
    }
    const slippage = (this.options.slippageBps ?? 0) / 10_000;
    const slippedPrice = state.mark.price * (order.side === 'buy' ? 1 + slippage : 1 - slippage);
    const price =
      order.type === 'limit'
        ? order.side === 'buy'
          ? Math.min(slippedPrice, order.limitPrice)
          : Math.max(slippedPrice, order.limitPrice)
        : slippedPrice;
    const signedFill = order.side === 'buy' ? qty : -qty;
    this.applyFill(state, signedFill, price, instrument.pointValue ?? 1);
    const commission = qty * (this.options.commissionPerUnit ?? 0);
    this.commissions += commission;
    const fill: Fill = {
      clientId: order.clientId,
      brokerOrderId: `paper-${++this.orderSequence}`,
      symbol: order.symbol,
      side: order.side,
      status: 'filled',
      requestedQty: order.qty,
      filledQty: qty,
      price,
      commission,
      commissionCurrency: this.options.currency ?? 'USD',
      time: state.mark.time,
    };
    this.fills.set(order.clientId, { fingerprint: orderFingerprint(order), fill });
    return structuredClone(fill);
  }

  async flatten(symbol: string): Promise<void> {
    const state = this.state(symbol);
    if (state.qty === 0) return;
    if (!state.mark)
      throw new BrokerError('precondition', `paper: ${symbol} must be marked before flatten`);
    await this.submit({
      symbol,
      side: state.qty > 0 ? 'sell' : 'buy',
      qty: Math.abs(state.qty),
      type: 'market',
      clientId: `flatten:${symbol}:${state.mark.time}:${Math.abs(state.qty)}:${++this.flattenSequence}`,
    });
  }

  /** Test/conformance setup; not part of the Broker protocol. */
  setPosition(symbol: string, qty: number, avgPrice?: number): void {
    if (!Number.isFinite(qty)) throw new RangeError('position qty must be finite');
    if (avgPrice != null && (!Number.isFinite(avgPrice) || avgPrice < 0))
      throw new RangeError('average price must be a non-negative finite number');
    const state = this.state(symbol);
    state.qty = qty;
    state.avgPrice = qty === 0 ? undefined : (avgPrice ?? state.mark?.price ?? 0);
  }

  private validateInstrument(symbol: string, instrument: Instrument): void {
    nativeQtyStep(instrument);
    if (!Number.isFinite(instrument.mintick) || instrument.mintick <= 0)
      throw new RangeError(`${symbol}: mintick must be a positive finite number`);
    if (
      instrument.pointValue != null &&
      (!Number.isFinite(instrument.pointValue) || instrument.pointValue <= 0)
    )
      throw new RangeError(`${symbol}: pointValue must be a positive finite number`);
    if (
      instrument.minOrderQty != null &&
      (!Number.isFinite(instrument.minOrderQty) || instrument.minOrderQty <= 0)
    )
      throw new RangeError(`${symbol}: minOrderQty must be a positive finite number`);
  }

  private state(symbol: string): PaperState {
    let state = this.states.get(symbol);
    if (!state) {
      state = { qty: 0, realizedPnl: 0 };
      this.states.set(symbol, state);
    }
    return state;
  }

  private applyFill(
    state: PaperState,
    signedFill: number,
    price: number,
    pointValue: number,
  ): void {
    const oldQty = state.qty;
    const newQty = oldQty + signedFill;
    if (oldQty === 0 || Math.sign(oldQty) === Math.sign(signedFill)) {
      const oldNotional = Math.abs(oldQty) * (state.avgPrice ?? price);
      state.avgPrice = (oldNotional + Math.abs(signedFill) * price) / Math.abs(newQty);
    } else {
      const closingQty = Math.min(Math.abs(oldQty), Math.abs(signedFill));
      state.realizedPnl +=
        (price - (state.avgPrice ?? price)) * Math.sign(oldQty) * closingQty * pointValue;
      if (newQty === 0) state.avgPrice = undefined;
      else if (Math.sign(newQty) !== Math.sign(oldQty)) state.avgPrice = price;
    }
    state.qty = newQty;
  }

  private unrealized(state: PaperState, instrument: Instrument): number {
    if (!state.mark || state.qty === 0 || state.avgPrice == null) return 0;
    return (state.mark.price - state.avgPrice) * state.qty * (instrument.pointValue ?? 1);
  }
}
