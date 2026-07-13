import { test, expect } from 'bun:test';
import { backtest } from '../src/index.js';
import {
  FIXTURE_BARS,
  FIXTURE_SYMBOLS,
  FIXTURE_T0,
  FIXTURE_STEP,
  FIXTURE_BAR_COUNT,
  FIXTURE_SPECS,
  fixtureProvider,
  raggedFixtureProvider,
  genBars,
} from './fixtures.js';

/** Guards the shared fixture (invariants + a freeze check so a generator edit
 *  can't silently drift the data) and demonstrates it across strategy families. */

// ── invariants every series must satisfy (the engine's data contract) ────────
test('every fixture series is ascending, unique, positive, OHLC-valid', () => {
  for (const sym of FIXTURE_SYMBOLS) {
    const bars = FIXTURE_BARS[sym]!;
    expect(bars.length).toBe(FIXTURE_BAR_COUNT);
    let prev = -Infinity;
    for (const b of bars) {
      expect(b.time).toBeGreaterThan(prev); // strictly ascending & unique
      prev = b.time;
      expect(b.low).toBeGreaterThan(0); // strictly positive prices
      expect(b.low).toBeLessThanOrEqual(Math.min(b.open, b.close));
      expect(b.high).toBeGreaterThanOrEqual(Math.max(b.open, b.close));
      expect(b.volume).toBeGreaterThan(0);
    }
  }
});

test('full-length symbols share one 1h clock starting at T0', () => {
  const grid = Array.from({ length: FIXTURE_BAR_COUNT }, (_, i) => FIXTURE_T0 + i * FIXTURE_STEP);
  for (const sym of FIXTURE_SYMBOLS) {
    expect(FIXTURE_BARS[sym]!.map((b) => b.time)).toEqual(grid);
  }
});

// ── determinism + freeze guard ───────────────────────────────────────────────
test('genBars is deterministic; FIXTURE_BARS matches a fresh generation', () => {
  for (const [sym, spec] of Object.entries(FIXTURE_SPECS)) {
    expect(genBars(spec)).toEqual(FIXTURE_BARS[sym]!);
    expect(genBars(spec)).toEqual(genBars(spec));
  }
});

test('freeze guard: pinned first/last closes (a generator change must be intentional)', () => {
  // If this fails, the dataset changed. Update the pins ONLY if the change is deliberate.
  const pinned: Record<string, [first: number, last: number]> = {
    UPTREND: [100.254148, 150.019036],
    DOWNTREND: [241.349285, 201.759361],
    CHOP: [50.33034, 48.995863],
    VOLATILE: [307.625452, 348.266061],
    MEANREV: [20.15182, 19.582358],
  };
  for (const sym of FIXTURE_SYMBOLS) {
    const bars = FIXTURE_BARS[sym]!;
    const [first, last] = pinned[sym]!;
    expect(bars[0]!.close).toBeCloseTo(first, 4);
    expect(bars.at(-1)!.close).toBeCloseTo(last, 4);
  }
});

// ── providers ────────────────────────────────────────────────────────────────
test('fixtureProvider serves the basket; subset scopes it; unknown symbol throws', async () => {
  const p = fixtureProvider();
  for (const sym of FIXTURE_SYMBOLS)
    expect((await p.history(sym, '1h')).length).toBe(FIXTURE_BAR_COUNT);

  const sub = fixtureProvider(['UPTREND', 'CHOP']);
  expect((await sub.history('UPTREND', '1h')).length).toBe(FIXTURE_BAR_COUNT);
  await expect(sub.history('VOLATILE', '1h')).rejects.toThrow(); // not in the subset

  expect(() => fixtureProvider(['NOPE'])).toThrow(/unknown symbol/);
});

test('raggedFixtureProvider yields disjoint clocks on the shared grid', async () => {
  const rp = raggedFixtureProvider();
  const len = async (s: string) => (await rp.history(s, '1h')).length;
  expect(await len('UPTREND')).toBe(600); // full
  expect(await len('DOWNTREND')).toBe(500); // lists late
  expect(await len('CHOP')).toBe(514); // 600 − ⌈600/7⌉ holiday bars
  expect(await len('MEANREV')).toBe(500); // delists early

  // every remaining bar still lands on the shared grid, ascending & unique
  const grid = new Set(
    Array.from({ length: FIXTURE_BAR_COUNT }, (_, i) => FIXTURE_T0 + i * FIXTURE_STEP),
  );
  for (const sym of FIXTURE_SYMBOLS) {
    const bars = await rp.history(sym, '1h');
    let prev = -Infinity;
    for (const b of bars) {
      expect(grid.has(b.time)).toBe(true);
      expect(b.time).toBeGreaterThan(prev);
      prev = b.time;
    }
  }
  // the union clock spans the longest sleeve
  expect(await len('VOLATILE')).toBe(600);
});

// ── usage: the whole point — run different strategies on the same data ────────
const SMA_CROSS = `//@version=6
strategy("sma", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=95)
fast = ta.sma(close, 10)
slow = ta.sma(close, 30)
if ta.crossover(fast, slow)
    strategy.entry("L", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("L")`;

const RSI_MEANREV = `//@version=6
strategy("rsi", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=95)
r = ta.rsi(close, 14)
if ta.crossover(r, 30)
    strategy.entry("L", strategy.long)
if ta.crossunder(r, 70)
    strategy.close("L")`;

const BREAKOUT = `//@version=6
strategy("breakout", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=95)
hh = ta.highest(high, 20)[1]
ll = ta.lowest(low, 20)[1]
if close > hh
    strategy.entry("L", strategy.long)
if close < ll
    strategy.close("L")`;

async function tradesOn(source: string, symbol: string): Promise<number> {
  const r = (await backtest({ source, symbol, timeframe: '1h', provider: fixtureProvider() }))
    .result!;
  expect(r.ok).toBe(true);
  return r.strategy!.closedTrades;
}

test('each strategy family finds tradable structure on the fixture', async () => {
  // trend-following trades the trends; mean-reversion trades the oscillators;
  // breakout trades the volatile series — proving the fixture exercises them all.
  expect(await tradesOn(SMA_CROSS, 'UPTREND')).toBeGreaterThan(0);
  expect(await tradesOn(SMA_CROSS, 'DOWNTREND')).toBeGreaterThan(0);
  expect(await tradesOn(RSI_MEANREV, 'CHOP')).toBeGreaterThan(0);
  expect(await tradesOn(RSI_MEANREV, 'MEANREV')).toBeGreaterThan(0);
  expect(await tradesOn(BREAKOUT, 'VOLATILE')).toBeGreaterThan(0);

  // and every strategy trades SOMEWHERE in the basket (no dead fixture)
  for (const src of [SMA_CROSS, RSI_MEANREV, BREAKOUT]) {
    let total = 0;
    for (const sym of FIXTURE_SYMBOLS) total += await tradesOn(src, sym);
    expect(total).toBeGreaterThan(0);
  }
});
