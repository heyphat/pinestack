import { test, expect } from 'bun:test';
import { StaticProvider, type Bar } from '@heyphat/pinery';
import { walkforward, planWindows, executeJob, parseAxes } from '../src/index.js';

const T0 = 1_700_000_000;

/** Oscillating close so the fast/slow SMA cross repeatedly → the broker trades. */
function makeSine(n: number, start: number, amplitude: number): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + amplitude * Math.sin(i / 5);
    const open = 100 + amplitude * Math.sin((i - 1) / 5);
    bars.push({
      time: start + i * 3600,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 1000,
    });
  }
  return bars;
}

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

/** Last defined equity value at or before `bar` (mirrors walkforward's reader). */
function equityAt(curve: number[], bar: number): number | undefined {
  for (let i = Math.min(bar, curve.length - 1); i >= 0; i--) {
    const v = curve[i];
    if (v != null && Number.isFinite(v)) return v;
  }
  return undefined;
}

test('planWindows tiles OOS segments across the tail exactly', () => {
  const plans = planWindows(1000, 4, 0.25, false);
  expect(plans).toHaveLength(4);
  const isLen = plans[0]!.isTo - plans[0]!.isFrom;
  const oosLen = plans[0]!.oosTo - plans[0]!.oosFrom;
  // Coverage: I + N·O consumes every bar.
  expect(isLen + 4 * oosLen).toBe(1000);
  for (const [k, p] of plans.entries()) {
    expect(p.isTo).toBe(p.oosFrom); // IS ends where OOS starts
    expect(p.isTo - p.isFrom).toBe(isLen); // rolling: fixed IS length
    if (k > 0) expect(p.oosFrom).toBe(plans[k - 1]!.oosTo); // OOS tiles, no gap
  }
  expect(plans[3]!.oosTo).toBe(1000); // last OOS ends at the last bar

  // Anchored: IS always starts at 0 and expands.
  const anchored = planWindows(1000, 4, 0.25, true);
  for (const p of anchored) expect(p.isFrom).toBe(0);
  expect(anchored[3]!.isTo).toBeGreaterThan(anchored[0]!.isTo);

  // windows=1 → the plain IS/OOS split.
  const split = planWindows(1000, 1, 0.3, false);
  expect(split).toHaveLength(1);
  expect(split[0]!.oosTo).toBe(1000);
  expect(split[0]!.oosTo - split[0]!.oosFrom).toBe(300);
});

test('planWindows rejects bad shapes', () => {
  expect(() => planWindows(1000, 0, 0.25, false)).toThrow(/windows/);
  expect(() => planWindows(1000, 2.5, 0.25, false)).toThrow(/windows/);
  expect(() => planWindows(1000, 5, 1.2, false)).toThrow(/oos fraction/);
  expect(() => planWindows(10, 20, 0.5, false)).toThrow(/too few/);
});

test('walkforward: winners per window, OOS verdicts, aggregate', async () => {
  const provider = new StaticProvider({ A: makeSine(600, T0, 25) });
  const report = await walkforward({
    source: SMA_PARAM_STRATEGY,
    symbol: 'A',
    timeframe: '1h',
    provider,
    axes: parseAxes(['fast=5,8', 'slow=15,25']),
    windows: 3,
    oosFraction: 0.25,
  });

  expect(report.fetchError).toBeUndefined();
  expect(report.windows).toHaveLength(3);
  expect(report.totalBars).toBe(600);
  for (const w of report.windows) {
    expect(w.error).toBeUndefined();
    expect(w.winner).toBeDefined();
    expect(w.winnerId).toMatch(/^fast=\d+\|slow=\d+$/);
    expect(Number.isFinite(w.isProfitPercent!)).toBe(true);
    expect(Number.isFinite(w.oosProfitPercent!)).toBe(true);
    expect(w.oosTrades!).toBeGreaterThanOrEqual(0);
    expect(w.oosTrades!).toBeLessThanOrEqual(w.result!.trades!.length);
  }
  const a = report.aggregate;
  expect(a.windows).toBe(3);
  expect(a.failed).toBe(0);
  expect(a.oosPositive).toBeLessThanOrEqual(3);
  expect(Number.isFinite(a.meanIsProfitPercent)).toBe(true);
});

test('determinism invariant: full-window IS prefix equals the IS-only run', async () => {
  const bars = makeSine(600, T0, 25);
  const provider = new StaticProvider({ A: bars });
  const report = await walkforward({
    source: SMA_PARAM_STRATEGY,
    symbol: 'A',
    timeframe: '1h',
    provider,
    axes: parseAxes(['fast=5,8', 'slow=15,25']),
    windows: 2,
    oosFraction: 0.25,
  });
  const w = report.windows[0]!;

  // Re-run window 0's winner on the IS slice ONLY and compare equity at the
  // boundary — bar-by-bar determinism makes them identical, which is what
  // justifies using the full-window run's IS stretch as warmup.
  const isOnly = await executeJob({
    source: SMA_PARAM_STRATEGY,
    symbol: 'A',
    timeframe: '60',
    bars: bars.slice(w.isFrom, w.isTo),
    inputs: w.winner,
    includeTrades: true,
  });
  const boundary = w.oosFrom - w.isFrom - 1;
  expect(equityAt(w.result!.equityCurve!, boundary)).toBe(equityAt(isOnly.equityCurve!, boundary)!);
});

test('walkforward rejects indicators and surfaces fetch failures', async () => {
  const provider = new StaticProvider({ A: makeSine(100, T0, 25) });
  await expect(
    walkforward({
      source: '//@version=6\nindicator("rsi")\nplot(ta.rsi(close, 14))\n',
      symbol: 'A',
      timeframe: '1h',
      provider,
      axes: [],
    }),
  ).rejects.toThrow(/needs a strategy/);

  const report = await walkforward({
    source: SMA_PARAM_STRATEGY,
    symbol: 'MISSING',
    timeframe: '1h',
    provider: new StaticProvider({}),
    axes: parseAxes(['fast=5,8']),
  });
  expect(report.fetchError).toBeTruthy();
  expect(report.windows).toHaveLength(0);
});
