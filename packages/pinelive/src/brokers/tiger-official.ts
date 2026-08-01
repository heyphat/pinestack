import { createHash } from 'node:crypto';
import { normalizeExpiryDate } from '@heyphat/pinery';
import { resolveTigerProfilePath } from '@heyphat/pinery/node';
import {
  TradeClient,
  TigerError,
  createClientConfig,
  limitOrder,
  marketOrder,
  type Asset,
  type ClientConfigOptions,
  type Contract,
  type Order,
  type OrderIdResult,
  type OrderRequest,
  type PlaceOrderResult,
  type Position,
} from '@tigeropenapi/tigeropen';
import { BrokerError } from '../core/broker.js';
import type { Side } from '../core/types.js';
import type {
  TigerOrderResult,
  TigerTradingAccount,
  TigerTradingInstrument,
  TigerTradingPosition,
  TigerTradingTransport,
} from './tiger.js';

/** Minimal official trade-client surface, exported for offline testing/custom facades. */
export interface OfficialTigerTradeClient {
  getAssets(request: { account?: string; segment?: boolean }): Promise<Asset[]>;
  getContract(symbol: string, secType: string): Promise<Contract[]>;
  getPositions(request: {
    account?: string;
    symbol?: string;
    secType?: string;
  }): Promise<Position[]>;
  getOrders(request: {
    account?: string;
    secType?: string;
    limit?: number;
    sortBy?: string;
  }): Promise<Order[]>;
  placeOrder(request: OrderRequest): Promise<PlaceOrderResult | undefined>;
  cancelOrder(id: number | string, secretKey?: string): Promise<OrderIdResult | undefined>;
}

export interface OfficialTigerTradingOptions {
  tigerId?: string;
  privateKey?: string;
  account?: string;
  secretKey?: string;
  license?: string;
  token?: string;
  propertiesFilePath?: string;
}

export function createOfficialTigerTradingTransport(
  options: OfficialTigerTradingOptions = {},
): OfficialTigerTradingTransport {
  const configOptions: ClientConfigOptions = {
    tigerId: options.tigerId,
    privateKey: options.privateKey,
    account: options.account,
    secretKey: options.secretKey,
    license: options.license,
    token: options.token,
    propertiesFilePath:
      options.propertiesFilePath == null
        ? undefined
        : resolveTigerTradingProfilePath(options.propertiesFilePath),
  };
  const config = createClientConfig(configOptions);
  for (const field of [
    'tigerId',
    'privateKey',
    'account',
    'secretKey',
    'license',
    'token',
  ] as const) {
    const expected = options[field];
    if (expected != null && config[field] !== expected)
      throw new BrokerError(
        'auth',
        `tiger: SDK environment overrides explicit ${field} configuration`,
        { retryable: false },
      );
  }
  if (!config.account)
    throw new BrokerError('auth', 'tiger: trading account is required', { retryable: false });
  return new OfficialTigerTradingTransport(
    TradeClient.fromConfig(config, config.account, config.secretKey),
    config.account,
  );
}

/** Node-only Tiger OpenAPI v0.5.x futures execution adapter. */
export class OfficialTigerTradingTransport implements TigerTradingTransport {
  constructor(
    private readonly client: OfficialTigerTradeClient,
    readonly accountId: string,
  ) {
    if (!accountId) throw new BrokerError('auth', 'tiger: trading account is required');
  }

  async connect(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
  }

  async account(accountId = this.accountId, signal?: AbortSignal): Promise<TigerTradingAccount> {
    return this.request('fetch account', signal, async () => {
      const assets = await this.client.getAssets({ account: accountId, segment: true });
      const asset = assets.find((value) => value.account === accountId);
      if (!asset || !asset.currency)
        throw new BrokerError(
          'precondition',
          'tiger: configured trading account was not returned',
          {
            retryable: false,
          },
        );
      const balance = requiredNumber(asset.cashValue, 'account cash value');
      const equity = requiredNumber(asset.netLiquidation, 'account net liquidation');
      return {
        id: asset.account ?? accountId,
        currency: asset.currency,
        balance,
        equity,
        available: optionalNumber(asset.buyingPower, 'account buying power'),
      };
    });
  }

  async instrument(symbol: string, signal?: AbortSignal): Promise<TigerTradingInstrument> {
    return this.request('fetch contract', signal, async () => {
      // Tiger resolves futures contracts by product root: getContract('MGC2612') is empty
      // while getContract('MGC') returns MGC2612. Try the exact code first, then the root,
      // and still require the response to name the exact requested contract.
      let contracts = await this.client.getContract(symbol, 'FUT');
      const root = futuresRoot(symbol);
      if (contracts.length === 0 && root) contracts = await this.client.getContract(root, 'FUT');
      const contract = contracts.find(
        (value) =>
          contractCode(value) === symbol && (value.secType ?? 'FUT').toUpperCase() === 'FUT',
      );
      if (!contract || contract.tradeable === false)
        throw new BrokerError('unknown-symbol', 'tiger: futures contract was not returned', {
          retryable: false,
        });
      const ticks = (contract.tickSizes ?? [])
        .map((value) => value.tickSize)
        .filter((value): value is number => Number.isFinite(value) && value! > 0);
      // Futures contracts carry a single `minTick` instead of the staged `tickSizes`
      // ladder stocks use. It is a real wire field the SDK's Contract type omits.
      const minTick = (contract as { minTick?: number }).minTick;
      const mintick = ticks.length > 0 ? Math.min(...ticks) : minTick;
      if (!Number.isFinite(mintick) || mintick! <= 0)
        throw new BrokerError('precondition', 'tiger: futures contract has no valid tick size', {
          retryable: false,
        });
      return {
        symbol,
        mintick: mintick!,
        qtyStep: 1,
        minOrderQty: 1,
        pointValue: optionalPositiveNumber(contract.multiplier, 'contract multiplier'),
        exchange: contract.exchange ?? contract.primaryExchange,
        expiry: normalizeExpiryDate(contract.expiry),
      };
    });
  }

  async position(
    accountId: string,
    symbol: string,
    signal?: AbortSignal,
  ): Promise<TigerTradingPosition> {
    return this.request('fetch position', signal, async () => {
      const positions = await this.client.getPositions({
        account: accountId,
        symbol,
        secType: 'FUT',
      });
      const position = positions.find(
        (value) =>
          contractCode(value) === symbol && (value.secType ?? 'FUT').toUpperCase() === 'FUT',
      );
      if (!position) return { symbol, qty: 0 };
      const scale = position.positionScale ?? 0;
      if (!Number.isInteger(scale) || scale < 0 || scale > 12)
        throw new BrokerError('precondition', 'tiger: position scale is invalid', {
          retryable: false,
        });
      const rawQty = position.positionQty ?? position.position;
      const qty =
        requiredNumber(rawQty, 'position quantity') /
        (position.positionQty == null ? 10 ** scale : 1);
      return {
        symbol,
        qty,
        avgPrice: optionalNumber(position.averageCost, 'position average cost'),
        unrealizedPnl: optionalNumber(position.unrealizedPnl, 'position unrealized PnL'),
        realizedPnl: optionalNumber(position.realizedPnl, 'position realized PnL'),
        updatedAt: normalizeTime(position.updateTimestamp),
      };
    });
  }

  async findOrderByClientId(
    accountId: string,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<TigerOrderResult | undefined> {
    return this.request('find order', signal, async () => {
      const userMark = tigerUserMark(clientId);
      const orders = await this.client.getOrders({
        account: accountId,
        secType: 'FUT',
        limit: 1_000,
        sortBy: 'LATEST_STATUS_UPDATED',
      });
      const order = orders.find((value) => value.userMark === userMark);
      return order ? normalizeOrder(order, clientId) : undefined;
    });
  }

  async submitMarket(
    accountId: string,
    request: { symbol: string; side: Side; qty: number; clientId: string },
    signal?: AbortSignal,
  ): Promise<TigerOrderResult> {
    assertSide(request.side);
    return this.request('submit market order', signal, async () => {
      const sdkOrder = marketOrder(
        accountId,
        request.symbol,
        'FUT',
        request.side === 'buy' ? 'BUY' : 'SELL',
        request.qty,
      );
      sdkOrder.userMark = tigerUserMark(request.clientId);
      sdkOrder.outsideRth = false;
      const placed = await this.client.placeOrder(sdkOrder);
      if (!placed)
        throw new BrokerError('timeout', 'tiger: order submission outcome is unknown', {
          retryable: true,
        });
      const returnedOrder = placed.orders?.find((value) => value.userMark === sdkOrder.userMark);
      if (returnedOrder) return normalizeOrder(returnedOrder, request.clientId);
      return normalizePlacement(placed, { ...request, type: 'market' });
    });
  }

  async submitLimit(
    accountId: string,
    request: {
      symbol: string;
      side: Side;
      qty: number;
      clientId: string;
      limitPrice: number;
    },
    signal?: AbortSignal,
  ): Promise<TigerOrderResult> {
    assertSide(request.side);
    return this.request('submit limit order', signal, async () => {
      const sdkOrder = limitOrder(
        accountId,
        request.symbol,
        'FUT',
        request.side === 'buy' ? 'BUY' : 'SELL',
        request.qty,
        request.limitPrice,
      );
      sdkOrder.userMark = tigerUserMark(request.clientId);
      sdkOrder.outsideRth = false;
      const placed = await this.client.placeOrder(sdkOrder);
      if (!placed)
        throw new BrokerError('timeout', 'tiger: order submission outcome is unknown', {
          retryable: true,
        });
      const returnedOrder = placed.orders?.find((value) => value.userMark === sdkOrder.userMark);
      if (returnedOrder) return normalizeOrder(returnedOrder, request.clientId);
      return normalizePlacement(placed, { ...request, type: 'limit' });
    });
  }

  async cancelOrder(_accountId: string, orderId: string, signal?: AbortSignal): Promise<void> {
    await this.request('cancel order', signal, async () => {
      // Int64 ids are carried as strings; the SDK accepts either form.
      const result = await this.client.cancelOrder(orderId);
      if (!result)
        throw new BrokerError('timeout', 'tiger: cancel outcome is unknown', { retryable: true });
      return result;
    });
  }

  private async request<T>(
    operation: string,
    signal: AbortSignal | undefined,
    call: () => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    try {
      const result = await call();
      throwIfAborted(signal);
      return result;
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw classifyOfficialTigerTradingError(error, operation);
    }
  }
}

export function tigerUserMark(clientId: string): string {
  return `pinelive:${createHash('sha256').update(clientId).digest('hex').slice(0, 24)}`;
}

function assertSide(side: unknown): asserts side is Side {
  if (side !== 'buy' && side !== 'sell')
    throw new BrokerError('precondition', 'tiger: order side must be "buy" or "sell"', {
      retryable: false,
    });
}

function futuresRoot(symbol: string): string | undefined {
  const normalized = symbol.trim().toUpperCase();
  const monthCode = /^([A-Z]+?)[FGHJKMNQUVXZ]\d{1,4}$/.exec(normalized);
  if (monthCode) return monthCode[1];
  return /^([A-Z]+?)\d{4,8}$/.exec(normalized)?.[1];
}

/**
 * Exact venue contract for a futures record. Tiger reports the product root in `symbol`
 * (e.g. MGC) and the tradable contract in `identifier` (e.g. MGC2612).
 */
function contractCode(record: {
  identifier?: string;
  localSymbol?: string;
  symbol?: string;
}): string | undefined {
  return record.identifier ?? record.localSymbol ?? record.symbol;
}

/** Reuse pinery's path resolution but report it as a broker credential failure. */
function resolveTigerTradingProfilePath(profile: string): string {
  try {
    return resolveTigerProfilePath(profile);
  } catch (error) {
    throw new BrokerError(
      'auth',
      error instanceof Error ? error.message : 'tiger: credential profile not found',
      { retryable: false },
    );
  }
}

function normalizePlacement(
  placed: PlaceOrderResult,
  request:
    | { symbol: string; side: Side; qty: number; clientId: string; type: 'market' }
    | {
        symbol: string;
        side: Side;
        qty: number;
        clientId: string;
        type: 'limit';
        limitPrice: number;
      },
): TigerOrderResult {
  const id = placed.id ?? placed.order_id;
  return {
    clientId: request.clientId,
    orderId: id == null ? undefined : String(id),
    symbol: request.symbol,
    side: request.side,
    type: request.type,
    ...(request.type === 'limit' ? { limitPrice: request.limitPrice } : {}),
    status: 'working',
    requestedQty: request.qty,
    filledQty: 0,
  };
}

function normalizeOrder(order: Order, clientId: string): TigerOrderResult {
  // Futures orders report the product root in `symbol` and the exact contract in
  // `identifier`; pinelive binds to the exact contract.
  const symbol = contractCode(order);
  if (!symbol || (order.action !== 'BUY' && order.action !== 'SELL'))
    throw new BrokerError('precondition', 'tiger: order identity is malformed', {
      retryable: false,
    });
  const requestedQty = scaledQuantity(
    order.totalQuantity,
    order.totalQuantityScale,
    'order quantity',
  );
  const filledQty =
    order.filledQuantity == null
      ? 0
      : scaledQuantity(order.filledQuantity, order.filledQuantityScale, 'order filled quantity');
  if (requestedQty <= 0 || filledQty < 0 || filledQty > requestedQty)
    throw new BrokerError('precondition', 'tiger: order quantities are invalid', {
      retryable: false,
    });
  if (order.status === 'Filled' && filledQty !== requestedQty)
    throw new BrokerError('precondition', 'tiger: filled order quantity is incomplete', {
      retryable: false,
    });
  const orderType =
    order.orderType === 'LMT' ? 'limit' : order.orderType === 'MKT' ? 'market' : undefined;
  return {
    clientId,
    orderId:
      order.id == null
        ? order.orderId == null
          ? undefined
          : String(order.orderId)
        : String(order.id),
    symbol,
    side: order.action === 'BUY' ? 'buy' : 'sell',
    type: orderType,
    limitPrice: optionalNumber(order.limitPrice, 'order limit price'),
    status: normalizeOrderStatus(order.status, filledQty, requestedQty),
    requestedQty,
    filledQty,
    price: optionalNumber(order.avgFillPrice, 'order average fill price'),
    commission: optionalNumber(order.commission, 'order commission'),
    commissionCurrency: order.currency,
    time: normalizeTime(order.updateTime ?? order.latestTime ?? order.openTime),
    message: order.remark,
  };
}

function normalizeOrderStatus(
  status: string | undefined,
  filledQty: number,
  requestedQty: number,
): TigerOrderResult['status'] {
  if (status === 'Filled') return filledQty === requestedQty ? 'filled' : 'unknown';
  if (status === 'Cancelled') return filledQty > 0 ? 'partially-filled-cancelled' : 'cancelled';
  if (status === 'Inactive' || status === 'Invalid')
    return filledQty > 0 ? 'partially-filled-cancelled' : 'rejected';
  if (
    status === 'Submitted' ||
    status === 'PendingSubmit' ||
    status === 'Initial' ||
    status === 'PendingCancel'
  )
    return filledQty > 0 ? 'partially-filled' : 'working';
  return 'unknown';
}

function scaledQuantity(
  value: number | undefined,
  scale: number | undefined,
  field: string,
): number {
  const quantity = requiredNumber(value, field);
  const quantityScale = scale ?? 0;
  if (!Number.isInteger(quantityScale) || quantityScale < 0 || quantityScale > 12)
    throw new BrokerError('precondition', `tiger: ${field} scale is invalid`, {
      retryable: false,
    });
  return quantity / 10 ** quantityScale;
}

function requiredNumber(value: number | undefined, field: string): number {
  if (!Number.isFinite(value))
    throw new BrokerError('precondition', `tiger: ${field} is invalid`, { retryable: false });
  return value!;
}

function optionalNumber(value: number | undefined, field: string): number | undefined {
  return value == null ? undefined : requiredNumber(value, field);
}

function optionalPositiveNumber(value: number | undefined, field: string): number | undefined {
  const result = optionalNumber(value, field);
  if (result != null && result <= 0)
    throw new BrokerError('precondition', `tiger: ${field} is invalid`, { retryable: false });
  return result;
}

function normalizeTime(value: number | undefined): number | undefined {
  const time = optionalNumber(value, 'timestamp');
  return time == null ? undefined : Math.floor(time >= 1e12 ? time / 1_000 : time);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new BrokerError('precondition', 'tiger: request aborted', { retryable: false });
}

function classifyOfficialTigerTradingError(error: unknown, operation: string): BrokerError {
  if (error instanceof TigerError) {
    const message = error.message.toLowerCase();
    // Gateway rejections such as an ip-whitelist miss arrive under a generic code;
    // they are terminal configuration failures, never worth retrying.
    const code =
      message.includes('whitelist') ||
      message.includes('forbidden') ||
      message.includes('signature') ||
      error.category === 'token_error' ||
      error.category === 'permission_error'
        ? 'auth'
        : error.category === 'rate_limit'
          ? 'rate-limit'
          : error.category.startsWith('trade_')
            ? 'reject'
            : error.category === 'common_param_error' || error.category === 'biz_param_error'
              ? 'precondition'
              : 'connectivity';
    return new BrokerError(code, `tiger: ${operation} failed`, {
      retryable: code === 'rate-limit' || code === 'connectivity',
    });
  }
  return new BrokerError('connectivity', `tiger: ${operation} failed`);
}
