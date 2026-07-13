import { test, expect } from 'bun:test';
import {
  monthlyReturnsAscii,
  topDrawdownsAscii,
  drawdownEpisodes,
  profitHistogramAscii,
  correlationMatrixAscii,
} from '../src/index.js';

const DAY = 86_400;
const T0 = Date.UTC(2025, 0, 1) / 1000; // 2025-01-01 unix seconds

/** Daily bar times covering `n` days from T0. */
const dailyTimes = (n: number): number[] => Array.from({ length: n }, (_, i) => T0 + i * DAY);

test('monthlyReturnsAscii: month cells and YEAR compound correctly', () => {
  // 90 daily bars: +10% over January, -5% over February, flat March.
  const times = dailyTimes(90);
  const equity = times.map((t) => {
    const d = new Date(t * 1000);
    const m = d.getUTCMonth();
    if (m === 0) return 10_000 + (1_000 * (d.getUTCDate() - 1)) / 30;
    if (m === 1) return 11_000 - (550 * (d.getUTCDate() - 1)) / 27;
    return 10_450;
  });
  const out = monthlyReturnsAscii(equity, times);
  expect(out).toContain('2025');
  expect(out).toContain('JAN');
  expect(out).toContain('YEAR');
  // Jan: 10_000 → 11_000 = +10.0%; Feb: 11_000 → 10_450 = -5.0%; Mar flat.
  const row = out.split('\n').find((l) => l.includes('2025'))!;
  expect(row).toContain('10.0');
  expect(row).toContain('-5.0');
  expect(row).toContain('0.0'); // March
  expect(row).toContain('4.5'); // YEAR: 10_450 / 10_000 - 1
  expect(out).not.toMatch(/\x1b/); // monochrome by default
});

test('monthlyReturnsAscii: color wraps cells without touching layout', () => {
  const times = dailyTimes(60);
  const equity = times.map((_, i) => 10_000 + i * 10);
  const plain = monthlyReturnsAscii(equity, times);
  const colored = monthlyReturnsAscii(equity, times, { color: true });
  expect(colored).toContain('\x1b[32m'); // rising months are green
  expect(colored.replace(/\x1b\[\d+m/g, '')).toBe(plain);
});

test('monthlyReturnsAscii: months with no bars print a dot; empty input → empty string', () => {
  // January and March bars, February missing entirely.
  const jan = dailyTimes(31);
  const mar = Array.from({ length: 31 }, (_, i) => Date.UTC(2025, 2, 1) / 1000 + i * DAY);
  const times = [...jan, ...mar];
  const equity = times.map((_, i) => 10_000 + i * 5);
  const out = monthlyReturnsAscii(equity, times);
  const row = out.split('\n').find((l) => l.includes('2025'))!;
  expect(row).toContain('·'); // FEB (and later months) empty
  expect(monthlyReturnsAscii([], [])).toBe('');
  expect(monthlyReturnsAscii([1], [T0])).toBe('');
});

test('drawdownEpisodes: finds, orders, and bounds episodes', () => {
  //         peak      trough   recover      peak  trough (unrecovered)
  const eq = [100, 110, 99, 105, 111, 112, 120, 100, 90, 95];
  const eps = drawdownEpisodes(eq);
  expect(eps).toHaveLength(2);
  // Deepest first: 120 → 90 = -25%; then 110 → 99 = -10%.
  expect(eps[0]!.depthPercent).toBeCloseTo(-25, 5);
  expect(eps[0]!.peakIndex).toBe(6);
  expect(eps[0]!.troughIndex).toBe(8);
  expect(eps[0]!.recoveryIndex).toBeNull(); // still underwater at the end
  expect(eps[1]!.depthPercent).toBeCloseTo(-10, 5);
  expect(eps[1]!.recoveryIndex).toBe(4); // 111 regains the 110 peak
});

test('topDrawdownsAscii: renders dates, unrecovered marker, and respects top', () => {
  const eq = [100, 110, 99, 105, 111, 112, 120, 100, 90, 95];
  const times = dailyTimes(eq.length);
  const out = topDrawdownsAscii(eq, times);
  expect(out).toContain('-25.00%');
  expect(out).toContain('-10.00%');
  expect(out).toContain('—'); // unrecovered episode has no recovery date
  expect(out).toContain('2025-01-07'); // the 120 peak (index 6)
  const top1 = topDrawdownsAscii(eq, times, { top: 1 });
  expect(top1).toContain('-25.00%');
  expect(top1).not.toContain('-10.00%');
  // A monotone rise never draws down.
  expect(topDrawdownsAscii([1, 2, 3, 4], dailyTimes(4))).toBe('');
});

test('profitHistogramAscii: zero is a bucket edge; counts and scaling hold', () => {
  const profits = [-300, -120, -80, -10, 5, 40, 60, 90, 150, 500, 500, 500];
  const out = profitHistogramAscii(profits, { width: 20, buckets: 6 });
  const lines = out.split('\n');
  expect(lines.length).toBeGreaterThanOrEqual(4);
  // Every trade lands in exactly one bucket.
  const total = lines.reduce((sum, l) => sum + Number(l.trim().split(' ').pop() ?? 0), 0);
  expect(total).toBe(profits.length);
  // No bucket label straddles zero: every range is [x → y] with x,y same-signed
  // (or a zero endpoint).
  for (const l of lines) {
    const m = l.match(/(-?[\d,.]+) → (-?[\d,.]+)/);
    expect(m).toBeTruthy();
    const lo = Number(m![1]!.replaceAll(',', ''));
    const hi = Number(m![2]!.replaceAll(',', ''));
    expect(lo < 0 && hi > 0).toBe(false);
  }
  expect(out).not.toMatch(/\x1b/);
});

test('profitHistogramAscii: color = green wins, red losses; strip → plain', () => {
  const profits = [-50, -20, 10, 30, 80];
  const plain = profitHistogramAscii(profits, { width: 10, buckets: 4 });
  const colored = profitHistogramAscii(profits, { width: 10, buckets: 4, color: true });
  expect(colored).toContain('\x1b[32m');
  expect(colored).toContain('\x1b[31m');
  expect(colored.replace(/\x1b\[\d+m/g, '')).toBe(plain);
  expect(profitHistogramAscii([])).toBe('');
});

test('correlationMatrixAscii: identical series correlate at 1, inverted at -1', () => {
  const up = Array.from({ length: 50 }, (_, i) => 100 + i + Math.sin(i) * 3);
  const down = up.map((v) => 300 - v);
  const out = correlationMatrixAscii([
    { label: 'AAA', series: up },
    { label: 'BBB', series: [...up] },
    { label: 'CCC', series: down },
  ]);
  const rows = out.split('\n');
  expect(rows).toHaveLength(4); // header + 3
  const aaa = rows[1]!;
  expect(aaa).toContain('1.00'); // diagonal and the identical pair
  expect(aaa).toContain('-1.00'); // the inverted pair
  expect(correlationMatrixAscii([{ label: 'AAA', series: up }])).toBe(''); // <2 series
});
