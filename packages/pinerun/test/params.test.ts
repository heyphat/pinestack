import { test, expect } from 'bun:test';
import {
  coerceToken,
  expandRange,
  parseSpec,
  parseAxis,
  parseAxes,
  cartesian,
  comboAt,
  sampleCombos,
  comboId,
  countCombos,
  assertComboBudget,
  DEFAULT_MAX_COMBOS,
  DEFAULT_SAMPLE_SEED,
} from '../src/params.js';

// ── coerceToken ─────────────────────────────────────────────

test('coerceToken: numbers, booleans, strings', () => {
  expect(coerceToken('5')).toBe(5);
  expect(coerceToken('1.5')).toBe(1.5);
  expect(coerceToken('-3')).toBe(-3);
  expect(coerceToken('-2.25')).toBe(-2.25);
  expect(coerceToken('true')).toBe(true);
  expect(coerceToken('FALSE')).toBe(false);
  expect(coerceToken('close')).toBe('close');
  expect(coerceToken('  10  ')).toBe(10); // trims
});

test('coerceToken: leading-dot, trailing-dot, sign, and exponent numerics', () => {
  expect(coerceToken('.5')).toBe(0.5);
  expect(coerceToken('5.')).toBe(5);
  expect(coerceToken('+2')).toBe(2);
  expect(coerceToken('1e3')).toBe(1000);
  expect(coerceToken('-1.5E-2')).toBe(-0.015);
});

// ── expandRange ─────────────────────────────────────────────

test('expandRange: inclusive integer range', () => {
  expect(expandRange(5, 20, 5)).toEqual([5, 10, 15, 20]);
  expect(expandRange(5, 8)).toEqual([5, 6, 7, 8]); // default step 1
  expect(expandRange(3, 3)).toEqual([3]); // single point
});

test('expandRange: float steps are cleaned of binary noise', () => {
  expect(expandRange(1, 2, 0.5)).toEqual([1, 1.5, 2]);
  // 0.1 steps would drift without rounding; assert clean values.
  expect(expandRange(0, 0.3, 0.1)).toEqual([0, 0.1, 0.2, 0.3]);
});

test('expandRange: stop not on the grid stops before overshooting', () => {
  expect(expandRange(0, 9, 2)).toEqual([0, 2, 4, 6, 8]);
});

test('expandRange: rejects bad bounds', () => {
  expect(() => expandRange(0, 10, 0)).toThrow();
  expect(() => expandRange(0, 10, -1)).toThrow();
  expect(() => expandRange(10, 5)).toThrow(); // stop < start
  expect(() => expandRange(0, 1e9, 0.001)).toThrow(); // exceeds range cap
});

// ── parseSpec (disambiguation order) ────────────────────────

test('parseSpec: comma always means a list', () => {
  expect(parseSpec('5,10,20')).toEqual([5, 10, 20]);
  expect(parseSpec('true,false')).toEqual([true, false]);
  expect(parseSpec('fast,slow')).toEqual(['fast', 'slow']);
  expect(parseSpec('1.5, 2, 2.5')).toEqual([1.5, 2, 2.5]); // spaces tolerated
});

test('parseSpec: colon means a numeric range', () => {
  expect(parseSpec('5:20:5')).toEqual([5, 10, 15, 20]);
  expect(parseSpec('5:8')).toEqual([5, 6, 7, 8]);
  expect(parseSpec('-2:2')).toEqual([-2, -1, 0, 1, 2]);
});

test('parseSpec: a list member may itself be a range', () => {
  expect(parseSpec('5,10:20:5')).toEqual([5, 10, 15, 20]);
  expect(parseSpec('1:3,10')).toEqual([1, 2, 3, 10]);
  expect(parseSpec('1:2,5:6')).toEqual([1, 2, 5, 6]);
});

test('parseSpec: colon tokens that are not numeric ranges stay strings', () => {
  expect(parseSpec('NASDAQ:AAPL,NYSE:F')).toEqual(['NASDAQ:AAPL', 'NYSE:F']);
  expect(parseSpec('NASDAQ:AAPL')).toEqual(['NASDAQ:AAPL']);
});

test('parseSpec: single value becomes a one-element list', () => {
  expect(parseSpec('close')).toEqual(['close']);
  expect(parseSpec('42')).toEqual([42]);
  expect(parseSpec('true')).toEqual([true]);
});

test('parseSpec: empty spec throws', () => {
  expect(() => parseSpec('')).toThrow();
  expect(() => parseSpec('   ')).toThrow();
});

// ── parseAxis / parseAxes ───────────────────────────────────

test('parseAxis: splits name=spec', () => {
  expect(parseAxis('fast=5,10,20')).toEqual({ name: 'fast', values: [5, 10, 20] });
  expect(parseAxis('slow=30:100:10')).toEqual({
    name: 'slow',
    values: [30, 40, 50, 60, 70, 80, 90, 100],
  });
});

test('parseAxis: names with spaces (Pine titles) are preserved', () => {
  expect(parseAxis('RSI Length=7,14')).toEqual({ name: 'RSI Length', values: [7, 14] });
});

test('parseAxis: rejects missing = or empty name', () => {
  expect(() => parseAxis('fast')).toThrow();
  expect(() => parseAxis('=5,10')).toThrow();
});

test('parseAxes: multiple axes, rejects duplicate names', () => {
  const axes = parseAxes(['fast=5,10', 'slow=30,50']);
  expect(axes).toHaveLength(2);
  expect(axes[0]!.name).toBe('fast');
  expect(axes[1]!.values).toEqual([30, 50]);
  expect(() => parseAxes(['fast=5,10', 'fast=20,30'])).toThrow();
});

// ── countCombos ─────────────────────────────────────────────

test('countCombos: product of axis lengths', () => {
  expect(countCombos([])).toBe(1);
  expect(countCombos([{ name: 'a', values: [1, 2, 3] }])).toBe(3);
  expect(
    countCombos([
      { name: 'a', values: [1, 2, 3] },
      { name: 'b', values: [1, 2] },
    ]),
  ).toBe(6);
});

// ── cartesian ───────────────────────────────────────────────

test('cartesian: empty axes yields a single empty combo', () => {
  expect(cartesian([])).toEqual([{}]);
});

test('cartesian: single axis', () => {
  expect(cartesian([{ name: 'fast', values: [5, 10] }])).toEqual([{ fast: 5 }, { fast: 10 }]);
});

test('cartesian: two axes, last varies fastest (odometer order)', () => {
  const combos = cartesian([
    { name: 'fast', values: [5, 10] },
    { name: 'slow', values: [30, 50] },
  ]);
  expect(combos).toEqual([
    { fast: 5, slow: 30 },
    { fast: 5, slow: 50 },
    { fast: 10, slow: 30 },
    { fast: 10, slow: 50 },
  ]);
});

test('cartesian: count matches countCombos', () => {
  const axes = [
    { name: 'a', values: [1, 2, 3] },
    { name: 'b', values: [true, false] },
    { name: 'c', values: ['x', 'y', 'z', 'w'] },
  ];
  expect(cartesian(axes)).toHaveLength(countCombos(axes));
});

// ── comboId ─────────────────────────────────────────────────

test('comboId: stable, key-sorted label', () => {
  expect(comboId({ slow: 50, fast: 10 })).toBe('fast=10|slow=50');
  expect(comboId({ fast: 10, slow: 50 })).toBe('fast=10|slow=50'); // order-independent
  expect(comboId({ useStop: true, mult: 1.5 })).toBe('mult=1.5|useStop=true');
});

test('comboId: empty combo', () => {
  expect(comboId({})).toBe('(defaults)');
});

// ── assertComboBudget ───────────────────────────────────────

test('assertComboBudget: returns the count under the cap, throws over it', () => {
  const axes = [
    { name: 'a', values: [1, 2, 3] },
    { name: 'b', values: [1, 2] },
  ];
  expect(assertComboBudget(axes, 10)).toBe(6);
  expect(() => assertComboBudget(axes, 5)).toThrow(/exceeds max 5/);
  expect(assertComboBudget(axes)).toBe(6); // default cap
});

test('assertComboBudget: rejects a non-finite cap instead of silently passing', () => {
  const axes = [{ name: 'a', values: [1, 2] }];
  expect(() => assertComboBudget(axes, NaN)).toThrow(/positive number/);
  expect(() => assertComboBudget(axes, 0)).toThrow(/positive number/);
});

// ── sanity ──────────────────────────────────────────────────

test('DEFAULT_MAX_COMBOS is a sane positive cap', () => {
  expect(DEFAULT_MAX_COMBOS).toBeGreaterThan(0);
});

// ── quoted literals ─────────────────────────────────────────

test('coerceToken: quoted tokens are literal strings', () => {
  expect(coerceToken("'09:30'")).toBe('09:30');
  expect(coerceToken('"true"')).toBe('true');
  expect(coerceToken("'5'")).toBe('5');
});

test('parseSpec: quoting suppresses range expansion and coercion', () => {
  expect(parseSpec("'09:30'")).toEqual(['09:30']);
  expect(parseSpec("'1:5'")).toEqual(['1:5']);
  expect(parseSpec("'5','10'")).toEqual(['5', '10']);
  expect(parseSpec("'09:30',5:6")).toEqual(['09:30', 5, 6]); // mixed list
});

// ── comboAt / sampleCombos (smart search) ───────────────────

test('comboAt decodes the same combo cartesian materializes, at every index', () => {
  const axes = [
    { name: 'a', values: [1, 2, 3] },
    { name: 'b', values: ['x', 'y'] },
    { name: 'c', values: [true, false] },
  ];
  const grid = cartesian(axes);
  grid.forEach((combo, i) => expect(comboAt(axes, i)).toEqual(combo));
});

test('comboAt: empty axes → the single empty combo; out-of-range throws', () => {
  expect(comboAt([], 0)).toEqual({});
  const axes = [{ name: 'a', values: [1, 2] }];
  expect(() => comboAt(axes, 2)).toThrow(/out of range/);
  expect(() => comboAt(axes, -1)).toThrow(/out of range/);
  expect(() => comboAt(axes, 0.5)).toThrow(/out of range/);
});

test('sampleCombos: distinct grid members, ascending grid order, deterministic per seed', () => {
  const axes = [
    { name: 'a', values: [1, 2, 3, 4, 5] },
    { name: 'b', values: [10, 20, 30, 40] },
  ];
  const grid = cartesian(axes).map((c) => comboId(c));
  const sampled = sampleCombos(axes, 7, 123);
  expect(sampled).toHaveLength(7);
  const ids = sampled.map((c) => comboId(c));
  expect(new Set(ids).size).toBe(7); // distinct
  for (const id of ids) expect(grid).toContain(id); // real grid members
  // Ascending grid order: indices in the materialized grid strictly increase.
  const indices = ids.map((id) => grid.indexOf(id));
  for (let i = 1; i < indices.length; i++) expect(indices[i]!).toBeGreaterThan(indices[i - 1]!);
  // Deterministic: the same seed reproduces the same combos.
  expect(sampleCombos(axes, 7, 123)).toEqual(sampled);
  // The default seed is applied when omitted (still deterministic).
  expect(sampleCombos(axes, 7)).toEqual(sampleCombos(axes, 7, DEFAULT_SAMPLE_SEED));
});

test('sampleCombos: count >= grid size returns the full grid; bad count/seed throw', () => {
  const axes = [
    { name: 'a', values: [1, 2] },
    { name: 'b', values: [3, 4] },
  ];
  expect(sampleCombos(axes, 4, 1)).toEqual(cartesian(axes));
  expect(sampleCombos(axes, 99, 1)).toEqual(cartesian(axes));
  expect(() => sampleCombos(axes, 0, 1)).toThrow(/positive integer/);
  expect(() => sampleCombos(axes, 1.5, 1)).toThrow(/positive integer/);
  expect(() => sampleCombos(axes, 2, NaN)).toThrow(/finite/);
});

test('assertComboBudget: symbols multiply the budget; sample caps it', () => {
  const axes = [
    { name: 'a', values: [1, 2, 3] },
    { name: 'b', values: [1, 2] },
  ]; // grid = 6
  expect(assertComboBudget(axes, 12, { symbols: 2 })).toBe(12);
  expect(() => assertComboBudget(axes, 11, { symbols: 2 })).toThrow(/12 combos .* exceeds max 11/);
  expect(() => assertComboBudget(axes, 11, { symbols: 2 })).toThrow(/× 2 symbols/);
  // Sampling shrinks the per-symbol count below the grid size…
  expect(assertComboBudget(axes, 4, { sample: 4 })).toBe(4);
  expect(assertComboBudget(axes, 8, { symbols: 2, sample: 4 })).toBe(8);
  // …but never inflates it past the grid.
  expect(assertComboBudget(axes, 10, { sample: 100 })).toBe(6);
  // An over-cap exhaustive grid suggests --sample.
  expect(() => assertComboBudget(axes, 5)).toThrow(/--sample/);
});
