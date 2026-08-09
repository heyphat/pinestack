import type { ClosedTrade, StrategyMetrics as PinerStrategyMetrics } from '@heyphat/piner';
import type { StrategyMetrics, StrategyTrade } from './result.js';

type RiskAwareClosedTrade = ClosedTrade & {
  initialRisk?: unknown;
  rMultiple?: unknown;
};

type ReturnAwareStrategyMetrics = PinerStrategyMetrics & {
  arithmeticReturnPercent?: unknown;
  geometricReturnPercent?: unknown;
  volatilityDragPercent?: unknown;
};

function numericMetric(value: unknown): number {
  return typeof value === 'number' ? value : NaN;
}

/** Normalize piner trade rows across engine versions. R is always recomputed
 * from net trade profit and immutable initial risk, never from realized MAE. */
export function projectStrategyTrade(trade: ClosedTrade): StrategyTrade {
  const risk = (trade as RiskAwareClosedTrade).initialRisk;
  const initialRisk = typeof risk === 'number' && Number.isFinite(risk) && risk > 0 ? risk : null;
  return {
    ...trade,
    initialRisk,
    rMultiple: initialRisk != null ? trade.profit / initialRisk : null,
  };
}

/** Normalize metrics added by newer piner engines while compiling against an
 * older piner declaration. Missing return metrics become NaN (`na` in text,
 * `null` in JSON); R still reports null expectancy with zero coverage. */
export function withRMultipleMetrics(
  metrics: PinerStrategyMetrics,
  trades: readonly StrategyTrade[],
): StrategyMetrics {
  let sum = 0;
  let count = 0;
  for (const trade of trades) {
    if (trade.initialRisk == null) continue;
    sum += trade.profit / trade.initialRisk;
    count++;
  }
  const returnMetrics = metrics as ReturnAwareStrategyMetrics;
  return {
    ...metrics,
    arithmeticReturnPercent: numericMetric(returnMetrics.arithmeticReturnPercent),
    geometricReturnPercent: numericMetric(returnMetrics.geometricReturnPercent),
    volatilityDragPercent: numericMetric(returnMetrics.volatilityDragPercent),
    rMultipleExpectancy: count > 0 ? sum / count : null,
    rMultipleTradeCount: count,
  };
}
