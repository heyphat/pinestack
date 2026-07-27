export interface Bar {
  /** Bar open time, as unix seconds at the LiveFeed boundary. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';

export interface OrderRequest {
  symbol: string;
  side: Side;
  /** Unsigned quantity in strategy-native units. */
  qty: number;
  type: OrderType;
  clientId: string;
}

export interface Fill {
  clientId: string;
  brokerOrderId?: string;
  symbol: string;
  side: Side;
  status: 'filled' | 'partially-filled';
  requestedQty: number;
  filledQty: number;
  price: number;
  commission: number;
  commissionCurrency?: string;
  time: number;
}

export interface Position {
  symbol: string;
  /** Signed net exposure in strategy-native units. */
  qty: number;
  avgPrice?: number;
  unrealizedPnl?: number;
  realizedPnl?: number;
  updatedAt?: number;
}

export interface Account {
  id: string;
  currency: string;
  balance: number;
  equity: number;
  available?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
}

export interface Instrument {
  /** Symbol used by the strategy and public Broker API. */
  symbol: string;
  /** Optional resolved symbols. Adapters must use these consistently for data and orders. */
  dataSymbol?: string;
  brokerSymbol?: string;
  /** Native quantity step used by piner and the reconciler. */
  minQty: number;
  /** Alias for venues that distinguish minimum size and increment. Defaults to minQty. */
  qtyStep?: number;
  minOrderQty?: number;
  mintick: number;
  pointValue?: number;
  /** Broker order units per one strategy-native unit. Defaults to 1. */
  brokerQtyPerNative?: number;
  /** Broker-unit order increment. If absent, native qtyStep is converted. */
  brokerQtyStep?: number;
}
