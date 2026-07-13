import { test, expect } from 'bun:test';
import { StaticProvider, type Bar, type HistoryProvider, type HistoryRange } from '@heyphat/pinery';
import { sweep, sortRanked, LocalRunner, parseAxes } from '../src/index.js';
import { T0, makeSine } from './fixtures.js';

const SMA_PARAM = `//@version=6
strategy("SMA cross (param)", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
fastLen = input.int(10, "fast")
slowLen = input.int(30, "slow")
fast = ta.sma(close, fastLen)
slow = ta.sma(close, slowLen)
if ta.crossover(fast, slow)
    strategy.entry("long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("long")
plot(fast, title="fast")
`;

const RSI_PARAM = `//@version=6
indicator("rsi param")
len = input.int(14, "len")
plot(ta.rsi(close, len), title="rsi")
`;

function provider(): HistoryProvider {
  return new StaticProvider({ A: makeSine(200, T0, 25) });
}

test('sweep runs every combo and ranks by strategy.netProfit', async () => {
  const report = await sweep({
    source: SMA_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['fast=5,10', 'slow=30,50']),
    rank: 'strategy.netProfit',
    runner: new LocalRunner(),
  });

  expect(report.total).toBe(4);
  expect(report.points).toHaveLength(4);
  expect(report.errors).toHaveLength(0);
  expect(report.fetchError).toBeUndefined();

  // Every point carries its combo and a strategy summary.
  for (const p of report.points) {
    expect(p.result.strategy).toBeDefined();
    expect(typeof p.inputs.fast).toBe('number');
    expect(typeof p.inputs.slow).toBe('number');
  }

  // Ranked descending by default.
  for (let i = 1; i < report.ranked.length; i++) {
    expect(report.ranked[i - 1]!.value).toBeGreaterThanOrEqual(report.ranked[i]!.value);
  }
  // The winner's value equals its strategy netProfit.
  const top = report.ranked[0]!;
  expect(top.value).toBeCloseTo(top.result.strategy!.netProfit, 6);
});

test('distinct input combos produce distinct runs (overrides really apply)', async () => {
  const report = await sweep({
    source: SMA_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['fast=5,10,15', 'slow=20,40']),
    rank: 'strategy.netProfit',
    runner: new LocalRunner(),
  });
  // If inputs did NOT flow through, every combo would be identical. Assert variety.
  const netProfits = new Set(report.points.map((p) => p.result.strategy!.netProfit.toFixed(4)));
  expect(netProfits.size).toBeGreaterThan(1);
  // Trade counts should also differ across lookbacks.
  const tradeCounts = new Set(report.points.map((p) => p.result.strategy!.closedTrades));
  expect(tradeCounts.size).toBeGreaterThan(1);
});

test('combo inputs map to the right point (id encodes the combo)', async () => {
  const report = await sweep({
    source: SMA_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['fast=5,10', 'slow=30,50']),
    runner: new LocalRunner(),
  });
  // points are in cartesian (odometer) order: (5,30),(5,50),(10,30),(10,50).
  expect(report.points.map((p) => [p.inputs.fast, p.inputs.slow])).toEqual([
    [5, 30],
    [5, 50],
    [10, 30],
    [10, 50],
  ]);
  // The job id (result.id) reflects the combo.
  expect(report.points[0]!.result.id).toBe('fast=5|slow=30');
  expect(report.points[3]!.result.id).toBe('fast=10|slow=50');
});

test('top + asc slicing', async () => {
  const report = await sweep({
    source: SMA_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['fast=5,10,15', 'slow=20,40,60']),
    rank: 'strategy.netProfit',
    direction: 'asc',
    top: 2,
    runner: new LocalRunner(),
  });
  expect(report.total).toBe(9);
  expect(report.ranked).toHaveLength(2);
  // Ascending: first is the worst.
  expect(report.ranked[0]!.value).toBeLessThanOrEqual(report.ranked[1]!.value);
});

test('maxCombos guard throws BEFORE any fetch', async () => {
  let fetched = false;
  const spy: HistoryProvider = {
    id: 'spy',
    async history(): Promise<Bar[]> {
      fetched = true;
      return [];
    },
  };
  await expect(
    sweep({
      source: SMA_PARAM,
      symbol: 'A',
      timeframe: '1h',
      provider: spy,
      axes: parseAxes(['fast=1:100', 'slow=1:100']), // 10_000 combos
      maxCombos: 100,
      runner: new LocalRunner(),
    }),
  ).rejects.toThrow(/exceeds max 100/);
  expect(fetched).toBe(false);
});

test('fetch failure is reported, not thrown', async () => {
  const boom: HistoryProvider = {
    id: 'boom',
    async history(): Promise<Bar[]> {
      throw new Error('network down');
    },
  };
  const report = await sweep({
    source: SMA_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: boom,
    axes: parseAxes(['fast=5,10']),
    runner: new LocalRunner(),
  });
  expect(report.fetchError).toContain('network down');
  expect(report.ranked).toHaveLength(0);
  expect(report.points).toHaveLength(0);
});

test('compile error surfaces in errors, dropped from ranked', async () => {
  const bad = `//@version=6
strategy("bad")
x = input.int(1, "fast")
plot(ta.
`;
  const report = await sweep({
    source: bad,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['fast=5,10']),
    runner: new LocalRunner(),
  });
  expect(report.total).toBe(2);
  expect(report.errors.length).toBe(2);
  expect(report.points.every((p) => !p.result.ok)).toBe(true);
  expect(report.ranked).toHaveLength(0); // NaN values dropped
});

test('baseInputs are merged under every combo', async () => {
  // Sweep only fast; pin slow via baseInputs. Compare to sweeping both.
  const withBase = await sweep({
    source: SMA_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['fast=5,10']),
    baseInputs: { slow: 50 },
    rank: 'strategy.netProfit',
    runner: new LocalRunner(),
  });
  const explicit = await sweep({
    source: SMA_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['fast=5,10', 'slow=50']),
    rank: 'strategy.netProfit',
    runner: new LocalRunner(),
  });
  // Same effective inputs → same results per fast value.
  const byFastBase = new Map(
    withBase.points.map((p) => [p.inputs.fast, p.result.strategy!.netProfit]),
  );
  for (const p of explicit.points) {
    expect(byFastBase.get(p.inputs.fast)).toBeCloseTo(p.result.strategy!.netProfit, 6);
  }
});

test('indicator sweep ranks by a plot aggregate', async () => {
  const report = await sweep({
    source: RSI_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['len=7,14,21']),
    rank: 'last(rsi)',
    runner: new LocalRunner(),
  });
  expect(report.total).toBe(3);
  expect(report.ranked).toHaveLength(3);
  for (const p of report.ranked) {
    expect(Number.isFinite(p.value)).toBe(true);
    expect(p.result.strategy).toBeUndefined();
  }
});

test('an axis name that matches no input() title fails fast, before any fetch', async () => {
  let fetched = false;
  const spy: HistoryProvider = {
    id: 'spy',
    async history(): Promise<Bar[]> {
      fetched = true;
      return [];
    },
  };
  await expect(
    sweep({
      source: SMA_PARAM,
      symbol: 'A',
      timeframe: '1h',
      provider: spy,
      axes: parseAxes(['fastLen=5,10']), // script's input title is "fast"
      runner: new LocalRunner(),
    }),
  ).rejects.toThrow(/input "fastLen" not found/);
  expect(fetched).toBe(false);
});

test('a non-numeric value for an int input fails fast', async () => {
  await expect(
    sweep({
      source: SMA_PARAM,
      symbol: 'A',
      timeframe: '1h',
      provider: provider(),
      axes: parseAxes(['fast=close,5']), // "close" reaches an input.int
      runner: new LocalRunner(),
    }),
  ).rejects.toThrow(/is int but axis value "close" is not a number/);
});

test('numeric-looking tokens are stringified for string-kind inputs', async () => {
  const MODE_PARAM = `//@version=6
indicator("mode param")
mode = input.string("a", "mode")
plot(mode == "5" ? 1 : 0, title="flag")
`;
  const report = await sweep({
    source: MODE_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['mode=5,a']), // "5" coerces to number 5, must reach piner as "5"
    rank: 'last(flag)',
    runner: new LocalRunner(),
  });
  expect(report.errors).toHaveLength(0);
  const byMode = new Map(report.points.map((p) => [p.inputs.mode, p.value]));
  expect(byMode.get('5')).toBe(1);
  expect(byMode.get('a')).toBe(0);
});

test('an omitted rank defaults to strategy.netProfit for strategies (report.rank says so)', async () => {
  const report = await sweep({
    source: SMA_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['fast=5,10']),
    runner: new LocalRunner(),
  });
  expect(report.rank).toBe('strategy.netProfit');
  const top = report.ranked[0]!;
  expect(top.value).toBeCloseTo(top.result.strategy!.netProfit, 6);
});

test('non-finite top/concurrency/maxCombos are rejected, not silently misused', async () => {
  const base = {
    source: SMA_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['fast=5,10']),
    runner: new LocalRunner(),
  };
  await expect(sweep({ ...base, top: NaN })).rejects.toThrow(/top must be a finite number/);
  await expect(sweep({ ...base, concurrency: NaN })).rejects.toThrow(
    /concurrency must be a finite number/,
  );
  await expect(sweep({ ...base, maxCombos: NaN })).rejects.toThrow(/positive number/);
});

test('sortRanked keeps ±Infinity (an all-wins profitFactor) and drops only NaN', () => {
  const rows = [{ value: 1 }, { value: Infinity }, { value: NaN }, { value: -Infinity }];
  expect(sortRanked(rows).map((r) => r.value)).toEqual([Infinity, 1, -Infinity]);
  expect(sortRanked(rows, { direction: 'asc' }).map((r) => r.value)).toEqual([
    -Infinity,
    1,
    Infinity,
  ]);
  expect(() => sortRanked(rows, { top: NaN })).toThrow(/top must be a finite number/);
});

test('a range respects the HistoryRange window', async () => {
  const range: HistoryRange = { limit: 120 };
  const report = await sweep({
    source: SMA_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    range,
    axes: parseAxes(['fast=5', 'slow=30']),
    runner: new LocalRunner(),
  });
  expect(report.points[0]!.result.bars).toBe(120);
});

// ── multi-symbol grid ───────────────────────────────────────

test('multi-symbol grid: symbols × combos, one fetch per symbol, points labeled', async () => {
  const calls: string[] = [];
  const inner = new StaticProvider({
    A: makeSine(200, T0, 25),
    B: makeSine(200, T0, 10), // different amplitude → different results
  });
  const counting: HistoryProvider = {
    id: 'counting',
    async history(symbol, tf, range): Promise<Bar[]> {
      calls.push(symbol);
      return inner.history(symbol, tf, range);
    },
  };
  const report = await sweep({
    source: SMA_PARAM,
    symbols: ['A', 'B'],
    timeframe: '1h',
    provider: counting,
    axes: parseAxes(['fast=5,10', 'slow=30,50']),
    rank: 'strategy.netProfit',
    runner: new LocalRunner(),
  });

  expect(report.symbols).toEqual(['A', 'B']);
  expect(report.symbol).toBe('A,B');
  expect(report.total).toBe(8); // 2 symbols × 4 combos
  expect(report.combos).toBe(4);
  expect(report.gridTotal).toBe(4);
  expect(report.points).toHaveLength(8);
  expect(report.fetchErrors).toHaveLength(0);

  // Bars fetched ONCE per symbol, not once per combo.
  expect(calls.sort()).toEqual(['A', 'B']);

  // Points: symbols outermost, cartesian order inside; result.symbol agrees.
  expect(report.points.slice(0, 4).every((p) => p.symbol === 'A')).toBe(true);
  expect(report.points.slice(4).every((p) => p.symbol === 'B')).toBe(true);
  for (const p of report.points) expect(p.result.symbol).toBe(p.symbol);
  expect(report.points[4]!.inputs).toEqual({ fast: 5, slow: 30 });

  // The two symbols' series differ, so at least one combo ranks differently.
  const aValues = report.points.slice(0, 4).map((p) => p.value);
  const bValues = report.points.slice(4).map((p) => p.value);
  expect(aValues).not.toEqual(bValues);
});

test('multi-symbol grid: one failed fetch skips that symbol, the rest still run', async () => {
  const inner = new StaticProvider({ A: makeSine(200, T0, 25) });
  const flaky: HistoryProvider = {
    id: 'flaky',
    async history(symbol, tf, range): Promise<Bar[]> {
      if (symbol === 'B') throw new Error('B is down');
      return inner.history(symbol, tf, range);
    },
  };
  const report = await sweep({
    source: SMA_PARAM,
    symbols: ['A', 'B'],
    timeframe: '1h',
    provider: flaky,
    axes: parseAxes(['fast=5,10']),
    runner: new LocalRunner(),
  });
  expect(report.fetchError).toBeUndefined(); // not fatal: A ran
  expect(report.fetchErrors).toEqual([{ symbol: 'B', error: 'B is down' }]);
  expect(report.total).toBe(2); // A's combos only
  expect(report.points.every((p) => p.symbol === 'A')).toBe(true);
});

test('multi-symbol grid: every fetch failing sets fetchError', async () => {
  const boom: HistoryProvider = {
    id: 'boom',
    async history(): Promise<Bar[]> {
      throw new Error('network down');
    },
  };
  const report = await sweep({
    source: SMA_PARAM,
    symbols: ['A', 'B'],
    timeframe: '1h',
    provider: boom,
    axes: parseAxes(['fast=5,10']),
    runner: new LocalRunner(),
  });
  expect(report.fetchError).toContain('network down');
  expect(report.fetchErrors).toHaveLength(2);
  expect(report.points).toHaveLength(0);
});

test('multi-symbol budget: the guard counts combos × symbols, before any fetch', async () => {
  let fetched = false;
  const spy: HistoryProvider = {
    id: 'spy',
    async history(): Promise<Bar[]> {
      fetched = true;
      return [];
    },
  };
  await expect(
    sweep({
      source: SMA_PARAM,
      symbols: ['A', 'B', 'C'],
      timeframe: '1h',
      provider: spy,
      axes: parseAxes(['fast=5,10']), // 2 combos × 3 symbols = 6 runs
      maxCombos: 5,
      runner: new LocalRunner(),
    }),
  ).rejects.toThrow(/exceeds max 5/);
  expect(fetched).toBe(false);
});

test('pre-fetched bars reject a multi-symbol grid; no symbol at all throws', async () => {
  await expect(
    sweep({
      source: SMA_PARAM,
      symbols: ['A', 'B'],
      timeframe: '1h',
      provider: provider(),
      bars: makeSine(50, T0, 25),
      axes: parseAxes(['fast=5']),
      runner: new LocalRunner(),
    }),
  ).rejects.toThrow(/single symbol/);
  await expect(
    sweep({
      source: SMA_PARAM,
      timeframe: '1h',
      provider: provider(),
      axes: parseAxes(['fast=5']),
      runner: new LocalRunner(),
    }),
  ).rejects.toThrow(/no symbol/);
});

// ── smart search (random sampling) ──────────────────────────

test('sample runs a seeded random subset of the grid', async () => {
  const report = await sweep({
    source: SMA_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['fast=5:9', 'slow=20:60:10']), // 5 × 5 = 25 combos
    rank: 'strategy.netProfit',
    sample: 6,
    seed: 7,
    runner: new LocalRunner(),
  });
  expect(report.gridTotal).toBe(25);
  expect(report.combos).toBe(6);
  expect(report.total).toBe(6);
  expect(report.points).toHaveLength(6);
  // Distinct combos, all from the declared grid.
  const ids = report.points.map((p) => p.result.id);
  expect(new Set(ids).size).toBe(6);
  for (const p of report.points) {
    expect([5, 6, 7, 8, 9]).toContain(p.inputs.fast as number);
    expect([20, 30, 40, 50, 60]).toContain(p.inputs.slow as number);
  }

  // Same seed → identical subset; the sweep is reproducible.
  const again = await sweep({
    source: SMA_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['fast=5:9', 'slow=20:60:10']),
    rank: 'strategy.netProfit',
    sample: 6,
    seed: 7,
    runner: new LocalRunner(),
  });
  expect(again.points.map((p) => p.inputs)).toEqual(report.points.map((p) => p.inputs));
});

test('sample lets a grid larger than maxCombos run (the guard applies to the sample)', async () => {
  const report = await sweep({
    source: SMA_PARAM,
    symbol: 'A',
    timeframe: '1h',
    provider: provider(),
    axes: parseAxes(['fast=2:99', 'slow=30,50']), // 196 combos
    maxCombos: 10,
    sample: 8,
    runner: new LocalRunner(),
  });
  expect(report.gridTotal).toBe(196);
  expect(report.total).toBe(8);
});

test('a non-integer sample is rejected before any work', async () => {
  await expect(
    sweep({
      source: SMA_PARAM,
      symbol: 'A',
      timeframe: '1h',
      provider: provider(),
      axes: parseAxes(['fast=5,10']),
      sample: 2.5,
      runner: new LocalRunner(),
    }),
  ).rejects.toThrow(/sample must be a positive integer/);
});
