import { test, expect } from 'bun:test';
import { StaticProvider } from '@heyphat/pinery';
import { backtest, validateAxes, parseAxes } from '../src/index.js';
import { T0, makeSine } from './fixtures.js';

const SMA_PARAM_STRATEGY = `//@version=6
strategy("SMA cross", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
fastLen = input.int(5, "fast")
slowLen = input.int(20, "slow")
fast = ta.sma(close, fastLen)
slow = ta.sma(close, slowLen)
if ta.crossover(fast, slow)
    strategy.entry("long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("long")
plot(fast, title="fast")
`;

test('backtest runs one strategy with full detail always attached', async () => {
  const provider = new StaticProvider({ A: makeSine(200, T0, 25) });
  const report = await backtest({
    source: SMA_PARAM_STRATEGY,
    symbol: 'A',
    timeframe: '1h',
    provider,
  });
  expect(report.fetchError).toBeUndefined();
  const r = report.result!;
  expect(r.ok).toBe(true);
  const s = r.strategy!;
  expect(s.closedTrades).toBeGreaterThan(0);
  expect(Number.isFinite(s.metrics.sharpe)).toBe(true);
  // No includeTrades flag — a backtest always carries the tearsheet inputs.
  expect(r.trades!.length).toBe(s.closedTrades);
  expect(r.equityCurve!.length).toBeGreaterThan(0);
  expect(r.barTimes!.length).toBe(r.bars);
  expect(r.closes!.length).toBe(r.bars);
});

test('backtest applies fixed input overrides + metrics conventions', async () => {
  const provider = new StaticProvider({ A: makeSine(200, T0, 25) });
  const base = await backtest({
    source: SMA_PARAM_STRATEGY,
    symbol: 'A',
    timeframe: '1h',
    provider,
  });
  const tuned = await backtest({
    source: SMA_PARAM_STRATEGY,
    symbol: 'A',
    timeframe: '1h',
    provider,
    inputs: { fast: 8, slow: 30 },
    metrics: { periodsPerYear: 252 },
  });
  expect(tuned.result!.strategy!.netProfit).not.toBe(base.result!.strategy!.netProfit);
  expect(tuned.result!.strategy!.metrics.periodsPerYear).toBe(252);
});

test('backtest surfaces fetch failures without running', async () => {
  const provider = new StaticProvider({}); // symbol unknown → history() throws
  const report = await backtest({
    source: SMA_PARAM_STRATEGY,
    symbol: 'MISSING',
    timeframe: '1h',
    provider,
  });
  expect(report.result).toBeUndefined();
  expect(report.fetchError).toBeTruthy();
});

test('an indicator backtests fine programmatically — just no strategy summary', async () => {
  const provider = new StaticProvider({ A: makeSine(50, T0, 25) });
  const report = await backtest({
    source: '//@version=6\nindicator("rsi")\nplot(ta.rsi(close, 14), title="rsi")\n',
    symbol: 'A',
    timeframe: '1h',
    provider,
  });
  expect(report.result!.ok).toBe(true);
  expect(report.result!.strategy).toBeUndefined(); // the CLI turns this into an error
});

test('validateAxes labels errors for the calling command', () => {
  expect(() => validateAxes(SMA_PARAM_STRATEGY, parseAxes(['bogus=1']), 'backtest')).toThrow(
    /^backtest: input "bogus" not found/,
  );
});
