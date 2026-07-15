import { test, expect } from 'bun:test';
import { StaticProvider } from '@heyphat/pinery';
import { backtest } from '../src/index.js';
import { resolveInstrument } from '../src/instrument.js';
import { T0, makeSine } from './fixtures.js';

const PCT_STRATEGY = `//@version=6
strategy("pct", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
if bar_index == 10
    strategy.entry("L", strategy.long)
if bar_index == 50
    strategy.close("L")
plot(close)
`;

test('resolveInstrument: explicit overrides win, provider fills gaps, failures degrade', async () => {
  const provider = new StaticProvider({ A: makeSine(50, T0, 25) }).setInstrument('A', {
    minQty: 0.01,
    mintick: 0.1,
  });
  // provider metadata
  expect(await resolveInstrument(provider, 'A')).toEqual({ minQty: 0.01, mintick: 0.1 });
  // explicit override beats metadata (per-field)
  expect(await resolveInstrument(provider, 'A', { minQty: 1 })).toEqual({
    minQty: 1,
    mintick: 0.1,
  });
  // unknown symbol → nothing (engine defaults apply downstream)
  expect(await resolveInstrument(provider, 'B')).toEqual({
    minQty: undefined,
    mintick: undefined,
  });
  // a throwing instrument() degrades to overrides-only, never an error
  const flaky = new StaticProvider({ A: makeSine(50, T0, 25) });
  flaky.instrument = async () => {
    throw new Error('metadata down');
  };
  expect(await resolveInstrument(flaky, 'A', { mintick: 0.5 })).toEqual({
    minQty: undefined,
    mintick: 0.5,
  });
});

test('backtest auto-applies the provider lot step to broker quantities', async () => {
  const bars = makeSine(80, T0, 25);
  // Same data, two providers: whole-unit lot step vs piner's 0.001 default.
  const coarse = new StaticProvider({ A: bars }).setInstrument('A', { minQty: 1 });
  const fine = new StaticProvider({ A: bars });

  const a = await backtest({
    source: PCT_STRATEGY,
    symbol: 'A',
    timeframe: '1h',
    provider: coarse,
  });
  const b = await backtest({ source: PCT_STRATEGY, symbol: 'A', timeframe: '1h', provider: fine });

  const qa = a.result!.trades![0]!.qty;
  const qb = b.result!.trades![0]!.qty;
  expect(Number.isInteger(qa)).toBe(true); // truncated to whole units
  expect(qa).toBeLessThanOrEqual(qb); // coarser step can only shrink the size
  expect(Math.abs(qb * 1000 - Math.round(qb * 1000))).toBeLessThan(1e-6); // 0.001 default step

  // Explicit --min-qty style override beats the provider's metadata.
  const c = await backtest({
    source: PCT_STRATEGY,
    symbol: 'A',
    timeframe: '1h',
    provider: fine,
    minQty: 1,
  });
  expect(c.result!.trades![0]!.qty).toBe(qa);
});
