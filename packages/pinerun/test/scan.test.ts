import { test, expect } from 'bun:test';
import { StaticProvider, type Bar } from '@heyphat/pinery';
import { scan, LocalRunner, parseRankSpec, jobHash, executeJob, type Job } from '../src/index.js';
import { T0, makeSine } from './fixtures.js';

const RSI = `//@version=6
indicator("rsi scan")
r = ta.rsi(close, 14)
plot(r, title="rsi")
`;

/** Build `n` synthetic hourly bars with a per-bar close delta (trend). */
function makeBars(n: number, start: number, step: number): Bar[] {
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = Math.max(1, close + step);
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    bars.push({ time: start + i * 3600, open, high, low, close, volume: 1000 });
  }
  return bars;
}

/** Oscillating series → mid-range RSI. */
function makeChoppy(n: number, start: number): Bar[] {
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = 100 + (i % 2 === 0 ? 2 : -2);
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    bars.push({ time: start + i * 3600, open, high, low, close, volume: 1000 });
  }
  return bars;
}

const provider = new StaticProvider({
  UP: makeBars(120, T0, +1), // steadily rising → RSI high
  DOWN: makeBars(120, T0, -1), // steadily falling → RSI low
  CHOP: makeChoppy(120, T0), // oscillating → RSI mid
});

test('scan ranks UP > CHOP > DOWN by last(rsi)', async () => {
  const report = await scan({
    source: RSI,
    symbols: ['UP', 'DOWN', 'CHOP'],
    timeframe: '1h',
    provider,
    rank: 'last(rsi)',
    runner: new LocalRunner(),
  });

  expect(report.errors).toHaveLength(0);
  expect(report.fetchErrors).toHaveLength(0);
  expect(report.ranked).toHaveLength(3);

  const order = report.ranked.map((r) => r.result.symbol);
  expect(order[0]).toBe('UP');
  expect(order[2]).toBe('DOWN');

  const up = report.ranked[0]!.value;
  const down = report.ranked[2]!.value;
  expect(up).toBeGreaterThan(70);
  expect(down).toBeLessThan(30);
  expect(up).toBeGreaterThan(down);
});

test('--asc / top slicing works via direction+top', async () => {
  const report = await scan({
    source: RSI,
    symbols: ['UP', 'DOWN', 'CHOP'],
    timeframe: '1h',
    provider,
    rank: 'last(rsi)',
    direction: 'asc',
    top: 1,
    runner: new LocalRunner(),
  });
  expect(report.ranked).toHaveLength(1);
  expect(report.ranked[0]!.result.symbol).toBe('DOWN');
});

test('rank by plot index selector #0', async () => {
  const report = await scan({
    source: RSI,
    symbols: ['UP', 'DOWN'],
    timeframe: '1h',
    provider,
    rank: 'max(#0)',
    runner: new LocalRunner(),
  });
  expect(report.ranked[0]!.result.symbol).toBe('UP');
});

test('compile error surfaces as a failed result, not a throw', async () => {
  const bad = `//@version=6
indicator("bad")
plot(ta.
`;
  const report = await scan({
    source: bad,
    symbols: ['UP'],
    timeframe: '1h',
    provider,
    runner: new LocalRunner(),
  });
  expect(report.results).toHaveLength(1);
  expect(report.results[0]!.ok).toBe(false);
  expect(report.results[0]!.error).toBeTruthy();
  expect(report.ranked).toHaveLength(0); // NaN dropped
});

test('parseRankSpec understands the grammar', () => {
  expect(parseRankSpec('last')).toEqual({ kind: 'plot', aggregate: 'last', selector: null });
  expect(parseRankSpec('max(#0)')).toEqual({ kind: 'plot', aggregate: 'max', selector: '#0' });
  expect(parseRankSpec('mean(rsi)')).toEqual({ kind: 'plot', aggregate: 'mean', selector: 'rsi' });
  expect(parseRankSpec('strategy.netProfit')).toEqual({
    kind: 'strategy',
    aggregate: 'last',
    selector: 'netProfit',
  });
  expect(() => parseRankSpec('bogus(x)')).toThrow();
});

test('jobHash is deterministic and input-sensitive', async () => {
  const bars = await provider.history('UP', '1h');
  const base: Job = { source: RSI, symbol: 'UP', timeframe: '60', bars };
  expect(jobHash(base)).toBe(jobHash({ ...base, bars: bars.slice() }));
  expect(jobHash(base)).not.toBe(jobHash({ ...base, inputs: { len: 7 } }));
  // Metrics options change the projected result, so they are part of the key.
  expect(jobHash(base)).not.toBe(jobHash({ ...base, metrics: { riskFreeRate: 0.02 } }));
});

test('executeJob projects plots and bar count', async () => {
  const bars = await provider.history('UP', '1h');
  const result = await executeJob({ source: RSI, symbol: 'UP', timeframe: '60', bars });
  expect(result.ok).toBe(true);
  expect(result.bars).toBe(bars.length);
  const rsi = result.plots.find((p) => p.title === 'rsi');
  expect(rsi).toBeDefined();
  expect(rsi!.data).toHaveLength(bars.length);
});

const SMA_STRATEGY = `//@version=6
strategy("SMA cross", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
fast = ta.sma(close, 5)
slow = ta.sma(close, 20)
if ta.crossover(fast, slow)
    strategy.entry("long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("long")
plot(fast, title="fast")
`;

test('scan runs a strategy and ranks by strategy.netProfit', async () => {
  const provider = new StaticProvider({
    A: makeSine(200, T0, 25),
    B: makeSine(200, T0, 10),
  });
  const report = await scan({
    source: SMA_STRATEGY,
    symbols: ['A', 'B'],
    timeframe: '1h',
    provider,
    rank: 'strategy.netProfit',
    runner: new LocalRunner(),
  });

  expect(report.errors).toHaveLength(0);
  expect(report.ranked).toHaveLength(2);
  for (const { result, value } of report.ranked) {
    expect(result.strategy).toBeDefined();
    expect(Number.isFinite(value)).toBe(true);
    expect(result.strategy!.closedTrades).toBeGreaterThan(0);
    expect(result.strategy!.winRate).toBeGreaterThanOrEqual(0);
    expect(result.strategy!.winRate).toBeLessThanOrEqual(1);
  }
  // Descending by net profit.
  expect(report.ranked[0]!.value).toBeGreaterThanOrEqual(report.ranked[1]!.value);
});

test('includeTrades attaches the ledger + equity curve', async () => {
  const provider = new StaticProvider({ A: makeSine(200, T0, 25) });
  const report = await scan({
    source: SMA_STRATEGY,
    symbols: ['A'],
    timeframe: '1h',
    provider,
    rank: 'strategy.netProfit',
    includeTrades: true,
    runner: new LocalRunner(),
  });
  const r = report.results[0]!;
  expect(r.trades).toBeDefined();
  expect(r.trades!.length).toBe(r.strategy!.closedTrades);
  expect(r.equityCurve!.length).toBeGreaterThan(0);
  // closes ride along under the same flag, aligned with barTimes (price chart input)
  expect(r.closes!.length).toBe(r.barTimes!.length);
  expect(r.closes!.every((c) => Number.isFinite(c))).toBe(true);
  const last = r.trades![r.trades!.length - 1]!;
  // cumProfit of the final trade equals net profit.
  expect(last.cumProfit).toBeCloseTo(r.strategy!.netProfit, 6);
});

test('enriched strategy summary + rank selectors', async () => {
  const provider = new StaticProvider({ A: makeSine(200, T0, 25) });
  const byPf = await scan({
    source: SMA_STRATEGY,
    symbols: ['A'],
    timeframe: '1h',
    provider,
    rank: 'strategy.profitFactor',
    runner: new LocalRunner(),
  });
  const s = byPf.results[0]!.strategy!;
  expect(s.netProfitPercent).toBeCloseTo((s.netProfit / s.initialCapital) * 100, 6);
  expect(s.avgTrade).toBeCloseTo(s.netProfit / s.closedTrades, 6);
  expect(Number.isFinite(s.profitFactor) || s.profitFactor === Infinity).toBe(true);
});

test('derived risk-adjusted metrics are projected from piner', async () => {
  const provider = new StaticProvider({ A: makeSine(200, T0, 25) });
  const report = await scan({
    source: SMA_STRATEGY,
    symbols: ['A'],
    timeframe: '1h',
    provider,
    rank: 'strategy.sharpe',
    runner: new LocalRunner(),
  });
  expect(report.errors).toHaveLength(0);
  const s = report.results[0]!.strategy!;

  // New broker-verbatim fields.
  expect(s.evens).toBeGreaterThanOrEqual(0);
  expect(s.wins + s.losses + s.evens).toBe(s.closedTrades);
  expect(s.totalCommission).toBe(0); // no commission configured in the script
  expect(s.barsInMarket).toBeGreaterThan(0);
  expect(s.barsInMarket).toBeLessThanOrEqual(s.barsProcessed);

  // Derived metrics, piner-computed.
  const m = s.metrics;
  expect(Number.isFinite(m.sharpe)).toBe(true);
  expect(m.exposurePercent).toBeCloseTo((s.barsInMarket / s.barsProcessed) * 100, 6);
  expect(m.expectancy).toBeCloseTo(s.avgTrade, 6);
  expect(m.maxConsecutiveWins + m.maxConsecutiveLosses).toBeGreaterThan(0);
  expect(Number.isFinite(m.buyHoldReturnPercent)).toBe(true);
  expect(m.periodsPerYear).toBeGreaterThan(0);

  // The rank selector read the nested metric.
  expect(report.ranked[0]!.value).toBe(m.sharpe);

  // Host conventions plumb through to piner's annualization.
  const conv = await scan({
    source: SMA_STRATEGY,
    symbols: ['A'],
    timeframe: '1h',
    provider,
    rank: 'strategy.sharpe',
    metrics: { periodsPerYear: 252, riskFreeRate: 0.02 },
    runner: new LocalRunner(),
  });
  const cm = conv.results[0]!.strategy!.metrics;
  expect(cm.periodsPerYear).toBe(252);
  expect(cm.sharpe).not.toBe(m.sharpe);
});

test('trade ledger carries fills detail (times, commission, excursions)', async () => {
  const provider = new StaticProvider({ A: makeSine(200, T0, 25) });
  const report = await scan({
    source: SMA_STRATEGY,
    symbols: ['A'],
    timeframe: '1h',
    provider,
    includeTrades: true,
    runner: new LocalRunner(),
  });
  const trades = report.results[0]!.trades!;
  expect(trades.length).toBeGreaterThan(0);
  for (const t of trades) {
    expect(t.exitTime).toBeGreaterThan(t.entryTime);
    expect(t.commission).toBe(0); // no commission configured in the script
    expect(t.maxRunup).toBeGreaterThanOrEqual(0);
    expect(t.maxDrawdown).toBeGreaterThanOrEqual(0);
  }
});
