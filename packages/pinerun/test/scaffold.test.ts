import { test, expect } from 'bun:test';
import {
  starterStrategy,
  isStarterTemplate,
  STARTER_TEMPLATES,
  STARTER_DESCRIPTIONS,
} from '../src/index.js';
import { executeJob } from '../src/index.js';
import type { Bar } from '../src/index.js';

// A short, deterministic synthetic series — enough bars to warm up the slow
// lookbacks in every starter and produce at least a compile-clean run.
function makeBars(n = 120): Bar[] {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    // A gentle oscillation so crossovers / RSI extremes / band touches all fire.
    price += Math.sin(i / 5) * 2 + (i % 7 === 0 ? 3 : -0.5);
    const close = Math.max(1, price);
    const high = close + 1.5;
    const low = close - 1.5;
    const open = i === 0 ? close : Math.max(1, bars[i - 1]!.close);
    bars.push({ time: (1_700_000_000 + i * 3600) * 1000, open, high, low, close, volume: 1000 });
  }
  return bars;
}

test('every template name round-trips through the type guard', () => {
  expect(STARTER_TEMPLATES).toEqual(['sma-cross', 'rsi', 'bollinger', 'macd']);
  for (const t of STARTER_TEMPLATES) expect(isStarterTemplate(t)).toBe(true);
  expect(isStarterTemplate('nope')).toBe(false);
  // Every template has a human description.
  for (const t of STARTER_TEMPLATES) expect(STARTER_DESCRIPTIONS[t]).toBeTruthy();
});

test('starterStrategy defaults to a commented, runnable sma-cross', () => {
  const src = starterStrategy();
  expect(src.startsWith('//@version=6')).toBe(true);
  expect(src).toContain('strategy(');
  expect(src).toContain('ta.crossover');
  // The teaching header + run recipes are present.
  expect(src).toContain('pinerun backtest');
  expect(src).toContain('pinerun sweep');
  expect(src).toContain('pinerun walkforward');
  // Exposed knobs that match the recipe's --input names.
  expect(src).toContain('input.int(10, "fast"');
  expect(src).toContain('input.int(30, "slow"');
});

test('unknown template throws with the valid choices', () => {
  // @ts-expect-error deliberately passing an invalid template
  expect(() => starterStrategy({ template: 'macdd' })).toThrow(/sma-cross, rsi, bollinger, macd/);
});

test('--name is used as the strategy title and quotes are stripped (valid Pine)', () => {
  const src = starterStrategy({ name: 'My "Quoted" Bot' });
  // No stray quote leaks into the strategy("...") literal.
  expect(src).toContain('strategy("My Quoted Bot"');
  expect(src).not.toContain('strategy("My "Quoted" Bot"');
  // Empty / all-stripped names fall back rather than emit strategy("").
  expect(starterStrategy({ name: '   ' })).toContain('strategy("My SMA cross"');
});

test('scaffolding is deterministic', () => {
  expect(starterStrategy({ template: 'rsi' })).toBe(starterStrategy({ template: 'rsi' }));
});

// Each scaffolded starter must compile and run clean under piner — the whole
// point of `init` is that the output works with zero edits.
for (const template of STARTER_TEMPLATES) {
  test(`starter "${template}" compiles and runs as a strategy`, async () => {
    const source = starterStrategy({ template });
    const result = await executeJob({
      source,
      symbol: 'TEST',
      timeframe: '60',
      bars: makeBars(),
    });
    if (!result.ok) {
      throw new Error(`${template} failed: ${result.error}\n${result.diagnostics?.join('\n')}`);
    }
    expect(result.ok).toBe(true);
    // It's a strategy() script, so a broker summary must be attached.
    expect(result.strategy).toBeDefined();
    expect(result.diagnostics ?? []).not.toContainEqual(expect.stringContaining('error:'));
  });
}
