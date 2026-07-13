/**
 * The result contract. A `RunResult` is a serializable projection of a piner run:
 * per-plot series (title + values), alerts, optional strategy summary, and any
 * error. This is what workers return and what the ranker consumes.
 */

import type { SecurityRequest, StrategyMetrics } from '@heyphat/piner';

export type { StrategyMetrics };

export interface PlotResult {
  id: number;
  title: string;
  /** Per-bar values (NaN where the plot produced `na`). */
  data: number[];
}

export interface AlertResult {
  bar: number;
  message: string;
}

/** Strategy performance metrics, sourced directly from piner's broker (the same
 *  values a Pine script reads via the `strategy.*` namespace / TradingView reports). */
export interface StrategySummary {
  initialCapital: number;
  netProfit: number;
  netProfitPercent: number;
  grossProfit: number;
  grossProfitPercent: number;
  grossLoss: number;
  grossLossPercent: number;
  /** grossProfit / |grossLoss| (derived; piner exposes no builtin). Infinity if no losses. */
  profitFactor: number;
  wins: number;
  losses: number;
  /** Break-even closed trades. */
  evens: number;
  closedTrades: number;
  /** wins / (wins + losses), 0..1 (derived). */
  winRate: number;
  avgTrade: number;
  avgTradePercent: number;
  avgWinningTrade: number;
  avgLosingTrade: number;
  maxDrawdown: number;
  /** Peak-equity-based (piner's max_drawdown_percent), matching TradingView. */
  maxDrawdownPercent: number;
  maxRunup: number;
  maxRunupPercent: number;
  maxContractsHeld: number;
  /** All commission charged, both sides (TradingView's "Commission Paid"). */
  totalCommission: number;
  /** Bars processed while the strategy was active (the exposure denominator). */
  barsProcessed: number;
  /** Bars on which a position was open after the bar's fill pass. */
  barsInMarket: number;
  /** Derived risk-adjusted analytics (Sharpe, Sortino, CAGR, Calmar, exposure,
   *  expectancy, buy-&-hold benchmark, …) — piner's `Engine.strategyMetrics()`
   *  projected verbatim, kept distinct from the broker-verbatim stats above. */
  metrics: StrategyMetrics;
}

/** One closed trade in the strategy ledger (mirrors piner's ClosedTrade). */
export interface StrategyTrade {
  entryId: string;
  /** +1 long, -1 short. */
  dir: number;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryBar: number;
  exitBar: number;
  /** Fill times (bar time, ms) of the entry/exit. */
  entryTime: number;
  exitTime: number;
  profit: number;
  cumProfit: number;
  /** Both sides' commission booked on this row (entry share + exit share). */
  commission: number;
  /** Trade-life intrabar extremes for this row's quantity (money, ≥ 0). */
  maxRunup: number;
  maxDrawdown: number;
  /** Set on portfolio-merged ledgers only: which sleeve produced this row. */
  symbol?: string;
}

export interface RunResult {
  id: string;
  symbol: string;
  timeframe: string;
  ok: boolean;
  /** Number of bars actually executed. */
  bars: number;
  plots: PlotResult[];
  alerts: AlertResult[];
  strategy?: StrategySummary;
  /** Full closed-trade ledger — only when the run requested `includeTrades`. */
  trades?: StrategyTrade[];
  /** Per-bar equity curve — only when the run requested `includeTrades`. */
  equityCurve?: number[];
  /** Per-bar times aligned with `equityCurve` indices, as given in the job's bars
   *  (pinery convention: unix seconds) — only when the run requested `includeTrades`. */
  barTimes?: number[];
  /** Per-bar close prices aligned with `barTimes` (the price-chart input) —
   *  only when the run requested `includeTrades`. */
  closes?: number[];
  /** request.security[_lower_tf] dependencies the script declared during this run. */
  securityRequests?: SecurityRequest[];
  /** Compile/runtime diagnostics (errors first). */
  diagnostics?: string[];
  /** Present when `ok === false`. */
  error?: string;
  /** Wall-clock milliseconds spent executing this job. */
  elapsedMs?: number;
}
