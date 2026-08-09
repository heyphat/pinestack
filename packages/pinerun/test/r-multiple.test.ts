import { test, expect, describe } from 'bun:test';
import type { ClosedTrade, StrategyMetrics as PinerStrategyMetrics } from '@heyphat/piner';
import { projectStrategyTrade, withRMultipleMetrics } from '../src/r-multiple.js';

// The cross-engine-version normalization contract: R is always recomputed here
// from net profit and a validated initial risk — engine-provided values are
// never trusted, and missing fields degrade to null/NaN, never to a guess.

function mkTrade(over: Partial<ClosedTrade> & { initialRisk?: unknown } = {}): ClosedTrade {
  return {
    entryId: 'L',
    dir: 1,
    qty: 1,
    entryPrice: 100,
    exitPrice: 105,
    entryBar: 0,
    exitBar: 4,
    entryTime: 0,
    exitTime: 4 * 60_000,
    profit: 5,
    cumProfit: 5,
    commission: 0,
    maxRunup: 5,
    maxDrawdown: 1,
    ...over,
  } as ClosedTrade;
}

describe('projectStrategyTrade — row normalization', () => {
  test('an old-engine row (no risk fields) projects to null, never a derived value', () => {
    const t = projectStrategyTrade(mkTrade());
    expect(t.initialRisk).toBeNull();
    expect(t.rMultiple).toBeNull();
    // maxDrawdown (realized MAE) is present and must NOT be used as risk
    expect(t.maxDrawdown).toBe(1);
  });

  test('a valid risk passes through and R is recomputed, not trusted from the row', () => {
    const t = projectStrategyTrade(mkTrade({ profit: 5, initialRisk: 10, rMultiple: 99 }));
    expect(t.initialRisk).toBe(10);
    expect(t.rMultiple).toBeCloseTo(0.5, 12); // 5/10 — the row's 99 is ignored
  });

  test.each([
    ['zero', 0],
    ['negative', -5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['non-numeric', 'oops'],
    ['null', null],
  ])('a degenerate risk (%s) projects to null/null', (_name, risk) => {
    const t = projectStrategyTrade(mkTrade({ profit: 5, initialRisk: risk }));
    expect(t.initialRisk).toBeNull();
    expect(t.rMultiple).toBeNull();
  });
});

describe('withRMultipleMetrics — metrics normalization', () => {
  const baseMetrics = { sharpe: 1.2, expectancy: 40 } as PinerStrategyMetrics;

  test('old-engine metrics: return trio becomes NaN, R is null with zero coverage', () => {
    const m = withRMultipleMetrics(baseMetrics, []);
    expect(m.arithmeticReturnPercent).toBeNaN();
    expect(m.geometricReturnPercent).toBeNaN();
    expect(m.volatilityDragPercent).toBeNaN();
    expect(m.rMultipleExpectancy).toBeNull();
    expect(m.rMultipleTradeCount).toBe(0);
    expect(m.sharpe).toBe(1.2); // everything else passes through
  });

  test('new-engine return metrics pass through untouched, NaN included', () => {
    const m = withRMultipleMetrics(
      {
        ...baseMetrics,
        arithmeticReturnPercent: 34,
        geometricReturnPercent: NaN, // r < −1 run: NaN is a real answer, keep it
        volatilityDragPercent: NaN,
      } as PinerStrategyMetrics,
      [],
    );
    expect(m.arithmeticReturnPercent).toBe(34);
    expect(m.geometricReturnPercent).toBeNaN();
    expect(m.volatilityDragPercent).toBeNaN();
  });

  test("R expectancy is pinerun's own mean over covered rows — engine values are overridden", () => {
    const withEngineR = {
      ...baseMetrics,
      rMultipleExpectancy: 99, // must not leak through
      rMultipleTradeCount: 99,
    } as PinerStrategyMetrics;
    const trades = [
      projectStrategyTrade(mkTrade({ profit: 20, initialRisk: 10 })), // +2R
      projectStrategyTrade(mkTrade({ profit: -10, initialRisk: 10 })), // −1R
      projectStrategyTrade(mkTrade({ profit: 50 })), // no stop → excluded
    ];
    const m = withRMultipleMetrics(withEngineR, trades);
    expect(m.rMultipleExpectancy).toBeCloseTo(0.5, 12); // (2 − 1) / 2
    expect(m.rMultipleTradeCount).toBe(2);
  });
});
