import { test, expect } from 'bun:test';
import {
  equityChartAscii,
  priceChartAscii,
  overlayChartAscii,
  drawdownChartAscii,
  sparkline,
  type PriceChartTrade,
} from '../src/index.js';

const ramp = (n: number, from: number, to: number): number[] =>
  Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));

test('equityChartAscii: layout invariants (rows, gutter labels, rails, no ANSI)', () => {
  const equity = ramp(100, 10_000, 15_000);
  const out = equityChartAscii(equity, { width: 32, height: 8 });
  const lines = out.split('\n');
  expect(lines).toHaveLength(8); // no times → no date row
  expect(out).toContain('15,000'); // max label, en-US grouped
  expect(out).toContain('10,000'); // min label
  expect(lines[0]).toContain('┤'); // labeled rows get a tick rail
  expect(lines[7]).toContain('┤');
  expect(lines[1]).toContain('│'); // unlabeled rows get a plain rail
  expect(out).not.toMatch(/\x1b/); // pipe-safe: no ANSI escapes
  expect(out).not.toMatch(/NaN|undefined/);
});

test('equityChartAscii: a rising ramp starts bottom-left and ends top-right', () => {
  const out = equityChartAscii(ramp(100, 0, 100), { width: 32, height: 8 });
  const lines = out.split('\n').map((l) => l.slice(l.indexOf('┤') + 1 || l.indexOf('│') + 1));
  const firstInk = (s: string): number => s.search(/[^\s]/);
  // top row's ink is at the right edge, bottom row's at the left edge
  expect(firstInk(lines[0]!)).toBeGreaterThan(24);
  expect(firstInk(lines[7]!)).toBeLessThan(4);
});

test('equityChartAscii: date row appears when times are provided', () => {
  const n = 50;
  const t0 = 1_700_000_000; // unix seconds
  const times = Array.from({ length: n }, (_, i) => t0 + i * 86400);
  const out = equityChartAscii(ramp(n, 1, 2), { width: 32, height: 6, times });
  const lines = out.split('\n');
  expect(lines).toHaveLength(7);
  expect(lines[6]).toContain('└');
  expect(lines[6]).toContain('2023-11-14'); // first bar's date
  expect(lines[6]).toContain('2024-01-02'); // last bar's date (49 days later)
});

test('equityChartAscii: capital guide gets its own gutter label and dashed dots', () => {
  // flat series well below the capital → the guide row is distinct and dashed
  const equity = Array.from({ length: 64 }, () => 1_000);
  const out = equityChartAscii(equity, { width: 32, height: 8, capital: 2_000 });
  expect(out).toContain('2,000'); // the guide is labeled
  const guideRow = out.split('\n').find((l) => l.includes('2,000'))!;
  const body = guideRow.slice(guideRow.indexOf('┤') + 1);
  const inked = [...body].filter((ch) => ch !== ' ').length;
  expect(inked).toBeGreaterThan(4); // dashes present…
  expect(inked).toBeLessThan(body.length / 2); // …but dashed, not solid
});

test('equityChartAscii: NaN points break the line without leaking text', () => {
  const equity = [...ramp(30, 1, 2), NaN, NaN, ...ramp(30, 2, 1)];
  const out = equityChartAscii(equity, { width: 32, height: 6 });
  expect(out).not.toContain('NaN');
  expect(out.split('\n')).toHaveLength(6);
});

test('equityChartAscii: fewer than two finite points → empty string', () => {
  expect(equityChartAscii([])).toBe('');
  expect(equityChartAscii([1])).toBe('');
  expect(equityChartAscii([NaN, NaN, 5])).toBe('');
});

test('drawdownChartAscii: flat-at-peak equity draws only the 0-line; drop shows the floor', () => {
  const flat = drawdownChartAscii(ramp(40, 100, 200), { width: 24, height: 3 });
  const flatLines = flat.split('\n');
  expect(flatLines[0]).toContain('0%');
  // rising equity → underwater is 0 everywhere → rows below the top stay empty
  const body = (l: string): string => l.slice(Math.max(l.indexOf('│'), l.indexOf('┤')) + 1);
  const below = flatLines
    .slice(1)
    .map((l) => body(l).trim())
    .join('');
  expect(below).toBe('');

  const dropped = drawdownChartAscii([100, 100, 50, 50], { width: 24, height: 3 });
  expect(dropped).toContain('-50.0%'); // the floor label is the deepest drawdown
});

const trade = (t: Partial<PriceChartTrade>): PriceChartTrade => ({
  dir: 1,
  entryBar: 0,
  exitBar: 0,
  entryPrice: 0,
  exitPrice: 0,
  profit: 0,
  ...t,
});

test('priceChartAscii: layout matches the equity chart contract (rows, rails, no ANSI)', () => {
  const out = priceChartAscii(ramp(100, 100, 200), { width: 32, height: 8 });
  const lines = out.split('\n');
  expect(lines).toHaveLength(8);
  expect(lines[0]).toContain('┤'); // max price label row
  expect(lines[7]).toContain('┤'); // min price label row
  expect(out).toContain('200.00');
  expect(out).toContain('100.00');
  expect(out).not.toMatch(/\x1b/); // pipe-safe without color
});

test('priceChartAscii: trades mark entries/exits at their fill prices', () => {
  const closes = ramp(100, 100, 200);
  const trades = [
    trade({ dir: 1, entryBar: 10, entryPrice: 110, exitBar: 40, exitPrice: 140, profit: 30 }),
    trade({ dir: -1, entryBar: 50, entryPrice: 150, exitBar: 90, exitPrice: 190, profit: -40 }),
  ];
  const out = priceChartAscii(closes, { width: 32, height: 8, trades });
  expect(out).toContain('▲'); // long entry
  expect(out).toContain('▼'); // short entry
  expect(out).toContain('●'); // winning exit
  expect(out).toContain('○'); // losing exit
  // a winning long on a rising ramp: entry sits low-left, exit above it
  const rowOf = (glyph: string): number => out.split('\n').findIndex((l) => l.includes(glyph));
  expect(rowOf('●')).toBeLessThan(rowOf('▲')); // exit at a higher price → higher row
});

test('priceChartAscii: color wraps only the markers in ANSI green/red', () => {
  const closes = ramp(60, 100, 200);
  const trades = [
    trade({ entryBar: 5, entryPrice: 105, exitBar: 20, exitPrice: 130, profit: 25 }),
    trade({ entryBar: 30, entryPrice: 150, exitBar: 50, exitPrice: 140, profit: -10 }),
  ];
  const plain = priceChartAscii(closes, { width: 32, height: 8, trades });
  const colored = priceChartAscii(closes, { width: 32, height: 8, trades, color: true });
  expect(colored).toContain('\x1b[32m●\x1b[39m'); // green win exit
  expect(colored).toContain('\x1b[31m○\x1b[39m'); // red loss exit
  expect(colored).toContain('\x1b[36m▲\x1b[39m'); // cyan entry
  // stripping the ANSI codes recovers the plain chart exactly
  expect(colored.replace(/\x1b\[\d+m/g, '')).toBe(plain);
});

test('priceChartAscii: an exit wins the cell when it collides with an entry', () => {
  const closes = ramp(50, 100, 200);
  // exit of trade 1 and entry of trade 2 on the same bar at the same price
  const trades = [
    trade({ entryBar: 5, entryPrice: 110, exitBar: 25, exitPrice: 150, profit: 40 }),
    trade({ entryBar: 25, entryPrice: 150, exitBar: 45, exitPrice: 190, profit: 40 }),
  ];
  const out = priceChartAscii(closes, { width: 32, height: 8, trades });
  expect(out.split('●')).toHaveLength(3); // both exits survive…
  expect(out.split('▲')).toHaveLength(2); // …the colliding entry does not
});

test('priceChartAscii: sub-dollar prices label with precision, not 0', () => {
  const out = priceChartAscii(ramp(50, 0.4, 0.6), { width: 32, height: 6 });
  expect(out).toContain('0.6000');
  expect(out).toContain('0.4000');
  expect(out).not.toMatch(/^\s*0 /m); // never a bare rounded-to-zero label
});

test('priceChartAscii: trade prices outside the close range widen the scale', () => {
  const closes = ramp(50, 100, 110);
  const trades = [trade({ entryBar: 10, entryPrice: 90, exitBar: 30, exitPrice: 130, profit: 1 })];
  const out = priceChartAscii(closes, { width: 32, height: 8, trades });
  expect(out).toContain('130.00'); // hi includes the exit fill
  expect(out).toContain('90.00'); // lo includes the entry fill
});

test('priceChartAscii: fewer than two finite points → empty string', () => {
  expect(priceChartAscii([])).toBe('');
  expect(priceChartAscii([1])).toBe('');
  expect(priceChartAscii([NaN, NaN, 5])).toBe('');
});

test('overlayChartAscii: shared scale, per-series color, strip → plain', () => {
  const a = ramp(80, 0, 10);
  const b = ramp(80, 0, -5);
  const plain = overlayChartAscii(a, b, { width: 32, height: 8, guide: 0 });
  expect(plain.split('\n')).toHaveLength(8);
  expect(plain).not.toMatch(/\x1b/);
  const colored = overlayChartAscii(a, b, { width: 32, height: 8, guide: 0, color: true });
  expect(colored).toContain('\x1b[36m'); // series A cyan
  expect(colored).toContain('\x1b[33m'); // series B yellow
  expect(colored.replace(/\x1b\[\d+m/g, '')).toBe(plain);
});

test('overlayChartAscii: custom label formatter and single-series fallback', () => {
  const a = ramp(50, 0, 12.5);
  const out = overlayChartAscii(a, [], {
    width: 24,
    height: 6,
    guide: 0,
    fmtLabel: (v) => `${v.toFixed(1)}%`,
  });
  expect(out).toContain('12.5%'); // hi label via fmtLabel
  expect(out).toContain('0.0%'); // the guide labels its own row
  expect(overlayChartAscii([], [], {})).toBe('');
});

test('sparkline: exact blocks for a linear ramp; flat and NaN handling', () => {
  expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7], 8)).toBe('▁▂▃▄▅▆▇█');
  expect(sparkline([5, 5, 5, 5], 6)).toBe('▁▁▁▁▁▁'); // flat → baseline
  expect(sparkline([], 5)).toBe('     '); // nothing to draw
  expect(sparkline([1, NaN, 3], 3)).toBe('▁ █'); // NaN sample → gap
});
