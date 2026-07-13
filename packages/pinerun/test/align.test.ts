import { test, expect } from 'bun:test';
import {
  unionTimes,
  alignEquity,
  combineEquity,
  returnCorrelation,
  type Sleeve,
} from '../src/index.js';

/** The portfolio plan's Phase-1 alignment gate (§6): union/forward-fill/
 *  pre-activation-cash, on hand-built sleeves (no piner). This is the pure
 *  ORACLE piner's PortfolioEngine isolated mode is validated against — so the
 *  arithmetic must be pinned independently here. */

test('unionTimes dedupes and sorts across sleeves', () => {
  expect(unionTimes([{ barTimes: [3, 1, 2] }, { barTimes: [2, 4] }, { barTimes: [1, 5] }])).toEqual(
    [1, 2, 3, 4, 5],
  );
});

test('unionTimes on identical axes is that axis; empty on no sleeves', () => {
  expect(unionTimes([{ barTimes: [10, 20] }, { barTimes: [10, 20] }])).toEqual([10, 20]);
  expect(unionTimes([])).toEqual([]);
});

test('alignEquity forward-fills, seeding pre-activation with initialCapital (NOT 0)', () => {
  const sleeve: Sleeve = {
    symbol: 'X',
    barTimes: [2, 3, 5],
    equityCurve: [100, 110, 130],
    initialCapital: 90,
  };
  // axis extends before (t=1), between (t=4, a gap), and after (t=6) the sleeve
  const out = alignEquity(sleeve, [1, 2, 3, 4, 5, 6]);
  expect(out).toEqual([
    90, // before first bar → cash (initialCapital), not 0
    100, // t=2 mark
    110, // t=3 mark
    110, // t=4 gap → carry last
    130, // t=5 mark
    130, // t=6 ragged tail → hold final equity
  ]);
});

test('alignEquity carries the last value across NaN holes (sparse pre-activation)', () => {
  const sleeve: Sleeve = {
    symbol: 'X',
    barTimes: [1, 2, 3, 4],
    equityCurve: [NaN, NaN, 200, 210], // strategy activated at bar 3
    initialCapital: 150,
  };
  expect(alignEquity(sleeve, [1, 2, 3, 4])).toEqual([150, 150, 200, 210]);
});

test('combineEquity: combined[0] === Σ initialCapital exactly (no distortion)', () => {
  const sleeves: Sleeve[] = [
    { symbol: 'A', barTimes: [1, 2, 3], equityCurve: [1000, 1010, 1005], initialCapital: 1000 },
    { symbol: 'B', barTimes: [2, 3, 4], equityCurve: [2000, 2020, 2010], initialCapital: 2000 },
  ];
  const { times, equity, perSleeve } = combineEquity(sleeves);
  expect(times).toEqual([1, 2, 3, 4]);
  // t=1: A active (1000) + B pre-activation cash (2000) = 3000 = Σ Cᵢ
  expect(equity[0]).toBe(3000);
  // t=2: 1010 + 2000 ; t=3: 1005 + 2020 ; t=4: A ragged tail 1005 + 2010
  expect(equity).toEqual([3000, 3010, 3025, 3015]);
  expect(perSleeve[0]).toEqual([1000, 1010, 1005, 1005]);
  expect(perSleeve[1]).toEqual([2000, 2000, 2020, 2010]);
});

test('combineEquity: two identical-axis sleeves sum pointwise', () => {
  const s = (sym: string): Sleeve => ({
    symbol: sym,
    barTimes: [1, 2, 3],
    equityCurve: [100, 120, 90],
    initialCapital: 100,
  });
  expect(combineEquity([s('A'), s('B')]).equity).toEqual([200, 240, 180]);
});

test('combineEquity: a single sleeve round-trips unchanged', () => {
  const sleeve: Sleeve = {
    symbol: 'A',
    barTimes: [10, 20, 30],
    equityCurve: [500, 480, 530],
    initialCapital: 500,
  };
  const { times, equity } = combineEquity([sleeve]);
  expect(times).toEqual([10, 20, 30]);
  expect(equity).toEqual([500, 480, 530]);
});

test('returnCorrelation: a sleeve perfectly correlated with itself is 1', () => {
  const curve = [100, 110, 105, 130, 125];
  expect(returnCorrelation(curve, curve)).toBeCloseTo(1, 9);
});

test('returnCorrelation: opposed series → -1; constant/flat deltas → NaN', () => {
  // deltas must VARY or the return variance is zero; make b's deltas = −a's.
  const a = [100, 110, 105, 130];
  const b = [100, 90, 95, 70];
  expect(returnCorrelation(a, b)).toBeCloseTo(-1, 9);
  // a linear ramp has constant deltas → zero return-variance → undefined corr
  expect(returnCorrelation([100, 110, 120, 130], [100, 90, 80, 70])).toBeNaN();
  expect(returnCorrelation([100, 100, 100], [100, 110, 120])).toBeNaN(); // no variance
  expect(returnCorrelation([100], [100])).toBeNaN(); // < 2 deltas
});
