/**
 * Shared, deterministic OHLCV fixtures for pinerun tests.
 *
 * A fixed set of synthetic bars across several symbols, each with a distinct
 * price *regime* so different strategy families exercise real behaviour on the
 * same data: trend-followers trade UPTREND/DOWNTREND, mean-reversion trades
 * CHOP/MEANREV, breakout/volatility logic trades VOLATILE. Feed it to `scan`,
 * `backtest`, `sweep`, or `portfolio` via `fixtureProvider()`.
 *
 * "Fixed" without a 3000-row CSV: the bars are produced by a **seeded** PRNG, so
 * every run yields byte-identical data. `fixtures.test.ts` pins invariants and a
 * few spot values so an accidental edit to the generator can't silently drift
 * the dataset. Times are unix SECONDS (pinery's convention); one shared 1h clock.
 *
 * All series are ascending, unique-timestamped, strictly positive, and OHLC-valid
 * (low ≤ min(open,close) ≤ max(open,close) ≤ high) — the contract the engine
 * assumes. `raggedFixtureProvider()` breaks the shared clock (late listing, gaps,
 * early delisting) for portfolio union-clock / disjoint-clock tests.
 */
import { StaticProvider, type Bar } from '@heyphat/pinery';

export const FIXTURE_T0 = 1_700_000_000; // unix seconds — matches the other pinerun tests
export const FIXTURE_TF = '1h';
export const FIXTURE_STEP = 3600; // seconds per bar
export const FIXTURE_BAR_COUNT = 600; // ≈ 25 days of 1h bars — ample warmup + many trades

/** Seeded PRNG (mulberry32) — reproducible "noise", never `Math.random()`. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BarSpec {
  base: number; // starting price level
  drift: number; // per-bar linear trend (absolute, added each bar)
  cycleAmp: number; // sine amplitude (absolute price units)
  cyclePeriod: number; // sine period in bars
  noise: number; // fractional close jitter (± this fraction of the level)
  wick: number; // fractional high/low wick beyond the body
  vol: number; // base volume
  seed: number; // PRNG seed (per symbol → independent but reproducible noise)
  count?: number; // bars (default FIXTURE_BAR_COUNT)
  t0?: number; // first bar time, unix seconds (default FIXTURE_T0)
  step?: number; // seconds per bar (default FIXTURE_STEP)
}

/**
 * Deterministic OHLCV from a spec:
 *   level(i) = base + drift·i + cycleAmp·sin(2π·i / cyclePeriod)
 *   close(i) = level·(1 ± noise),  open(i) = close(i−1)  (continuous),
 *   wicks bracket the body.
 * Guarantees ascending-unique times, positive prices, and valid OHLC.
 */
export function genBars(spec: BarSpec): Bar[] {
  const count = spec.count ?? FIXTURE_BAR_COUNT;
  const t0 = spec.t0 ?? FIXTURE_T0;
  const step = spec.step ?? FIXTURE_STEP;
  const rnd = mulberry32(spec.seed);
  const bars: Bar[] = [];
  let prevClose = spec.base;
  for (let i = 0; i < count; i++) {
    const level =
      spec.base + spec.drift * i + spec.cycleAmp * Math.sin((2 * Math.PI * i) / spec.cyclePeriod);
    const close = Math.max(1e-6, level * (1 + spec.noise * (rnd() * 2 - 1)));
    const open = i === 0 ? level : prevClose;
    const high = Math.max(open, close) * (1 + spec.wick * rnd());
    const low = Math.max(1e-6, Math.min(open, close) * (1 - spec.wick * rnd()));
    bars.push({
      time: t0 + i * step,
      open,
      high,
      low,
      close,
      volume: Math.round(spec.vol * (0.5 + rnd())),
    });
    prevClose = close;
  }
  return bars;
}

/**
 * Per-symbol regimes. Names describe the shape so a test reads self-documenting
 * ("run RSI mean-reversion on CHOP and expect trades"). Purely synthetic — not
 * real market data.
 */
export const FIXTURE_SPECS: Record<string, BarSpec> = {
  UPTREND: {
    base: 100,
    drift: +0.08,
    cycleAmp: 6,
    cyclePeriod: 48,
    noise: 0.01,
    wick: 0.004,
    vol: 1000,
    seed: 1,
  },
  DOWNTREND: {
    base: 240,
    drift: -0.06,
    cycleAmp: 7,
    cyclePeriod: 60,
    noise: 0.012,
    wick: 0.005,
    vol: 1200,
    seed: 2,
  },
  CHOP: {
    base: 50,
    drift: 0,
    cycleAmp: 8,
    cyclePeriod: 40,
    noise: 0.015,
    wick: 0.006,
    vol: 800,
    seed: 3,
  },
  VOLATILE: {
    base: 300,
    drift: +0.02,
    cycleAmp: 45,
    cyclePeriod: 72,
    noise: 0.03,
    wick: 0.01,
    vol: 1500,
    seed: 4,
  },
  MEANREV: {
    base: 20,
    drift: 0,
    cycleAmp: 3,
    cyclePeriod: 24,
    noise: 0.02,
    wick: 0.006,
    vol: 600,
    seed: 5,
  },
};

/** Basket symbols, in a stable order (the CLI/basket order for portfolio tests). */
export const FIXTURE_SYMBOLS: string[] = Object.keys(FIXTURE_SPECS);

/** The frozen dataset: symbol → bars. Deterministic across runs. */
export const FIXTURE_BARS: Record<string, Bar[]> = Object.fromEntries(
  Object.entries(FIXTURE_SPECS).map(([sym, spec]) => [sym, genBars(spec)]),
);

/**
 * A `StaticProvider` over the fixture. Pass a subset of symbols to scope a run
 * (e.g. `fixtureProvider(['UPTREND', 'CHOP'])`); default is the whole basket.
 */
export function fixtureProvider(symbols: string[] = FIXTURE_SYMBOLS): StaticProvider {
  const seed: Record<string, Bar[]> = {};
  for (const sym of symbols) {
    const bars = FIXTURE_BARS[sym];
    if (!bars) throw new Error(`fixtureProvider: unknown symbol "${sym}"`);
    seed[sym] = bars;
  }
  return new StaticProvider(seed);
}

/** Per-symbol clock mutilations for the ragged provider (see below). */
const RAGGED: Record<string, (b: Bar[]) => Bar[]> = {
  UPTREND: (b) => b, // full clock
  DOWNTREND: (b) => b.slice(100), // lists 100 bars late
  CHOP: (b) => b.filter((_, i) => i % 7 !== 0), // periodic "holiday" gaps
  VOLATILE: (b) => b, // full clock
  MEANREV: (b) => b.slice(0, 500), // delists early
};

/**
 * Like `fixtureProvider`, but with DISJOINT per-symbol clocks — late listing,
 * periodic gaps, early delisting — while every remaining bar still lands on the
 * shared 1h grid. For portfolio union-clock coverage and the shared-mode
 * disjoint-clock risk case (spec S7 / `portfolio-audit-findings.md`). Each series
 * stays ascending and unique.
 */
export function raggedFixtureProvider(symbols: string[] = FIXTURE_SYMBOLS): StaticProvider {
  const seed: Record<string, Bar[]> = {};
  for (const sym of symbols) {
    const bars = FIXTURE_BARS[sym];
    if (!bars) throw new Error(`raggedFixtureProvider: unknown symbol "${sym}"`);
    seed[sym] = (RAGGED[sym] ?? ((b) => b))(bars);
  }
  return new StaticProvider(seed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple parametric generators — shared by the pre-fixture tests
//
// These predate the regime dataset above and are consolidated here so
// scan/backtest/sweep/portfolio/security keep ONE copy each instead of a
// per-file duplicate. Prefer `fixtureProvider()` for new tests; reach for these
// when a test needs a specific hand-tuned shape (a pure ramp, a phase-shifted
// wave) rather than the realistic basket.
// ─────────────────────────────────────────────────────────────────────────────

/** Common unix-seconds epoch for the parametric generators (= `FIXTURE_T0`). */
export const T0 = FIXTURE_T0;

/** UTC midnight 2024-01-01, unix seconds — the base time used by `hourly()`. */
export const DAY1 = Math.floor(Date.parse('2024-01-01T00:00:00Z') / 1000);

/**
 * Oscillating close around 100 so a fast/slow SMA cross fires repeatedly.
 * `phase` shifts the wave (decorrelates symbols in a basket). With `phase = 0`
 * this is byte-identical to the `makeSine(n, start, amplitude)` that lived in
 * backtest/scan/sweep; portfolio's phase-shifted variant is `makeSine(n, T0, a, p)`.
 */
export function makeSine(n: number, start: number, amplitude: number, phase = 0): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + amplitude * Math.sin((i + phase) / 5);
    const open = 100 + amplitude * Math.sin((i - 1 + phase) / 5);
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

/** `n` hourly bars from `DAY1`, close = `base + i` (a monotone ramp; OHLC ±1). */
export function hourly(n: number, base: number): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = base + i;
    return { time: DAY1 + i * 3600, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 };
  });
}
