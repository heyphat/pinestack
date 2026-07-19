/**
 * End-to-end: a backtest fed from a directory of CSV files must behave exactly
 * like the same bars fed from memory — the CSV round-trip (serialize → parse)
 * is lossless, and the sidecar instrument metadata reaches the run.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StaticProvider, type Bar } from '@heyphat/pinery';
import { CsvProvider } from '@heyphat/pinery/node';
import { backtest, scan } from '../src/index.js';
import { resolveInstrument } from '../src/instrument.js';
import { T0, makeSine } from './fixtures.js';

const STRATEGY = `//@version=6
strategy("SMA cross", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
fast = ta.sma(close, 5)
slow = ta.sma(close, 20)
if ta.crossover(fast, slow)
    strategy.entry("long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("long")
`;

function toCsv(bars: Bar[]): string {
  const rows = ['time,open,high,low,close,volume'];
  for (const b of bars) rows.push(`${b.time},${b.open},${b.high},${b.low},${b.close},${b.volume}`);
  return rows.join('\n');
}

let dir: string;
const bars = makeSine(200, T0, 25);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinerun-csv-'));
  writeFileSync(join(dir, 'BTCUSDT_1h.csv'), toCsv(bars));
  writeFileSync(join(dir, 'instruments.csv'), 'symbol,minQty,mintick\nBTCUSDT,0.01,0.5\n');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('backtest from CSV files matches the same bars from memory', async () => {
  const fromCsv = await backtest({
    source: STRATEGY,
    symbol: 'BTCUSDT',
    timeframe: '1h',
    provider: new CsvProvider({ dir }),
  });
  // Same instrument metadata as the instruments.csv sidecar, so the only
  // variable between the two runs is where the bars came from.
  const fromMemory = await backtest({
    source: STRATEGY,
    symbol: 'BTCUSDT',
    timeframe: '1h',
    provider: new StaticProvider({ BTCUSDT: bars }).setInstrument('BTCUSDT', {
      minQty: 0.01,
      mintick: 0.5,
    }),
  });
  expect(fromCsv.fetchError).toBeUndefined();
  const a = fromCsv.result!.strategy!;
  const b = fromMemory.result!.strategy!;
  expect(a.closedTrades).toBe(b.closedTrades);
  expect(a.netProfit).toBe(b.netProfit);
  expect(fromCsv.result!.bars).toBe(fromMemory.result!.bars);
});

test('instruments.csv metadata reaches instrument resolution', async () => {
  const inst = await resolveInstrument(new CsvProvider({ dir }), 'BTCUSDT');
  expect(inst).toEqual({ minQty: 0.01, mintick: 0.5 });
});

test('a missing security dependency file degrades to na but surfaces via onSecurityError', async () => {
  const INDICATOR = `//@version=6
indicator("dep")
e = request.security("ETHUSDT", timeframe.period, close)
plot(e, title="e")
`;
  const failures: Array<{ label: string; error: string }> = [];
  const report = await scan({
    source: INDICATOR,
    symbols: ['BTCUSDT'],
    timeframe: '1h',
    provider: new CsvProvider({ dir }), // no ETHUSDT_1h.csv in the fixture dir
    onSecurityError: (label, error) => failures.push({ label, error }),
  });
  expect(report.results[0]!.ok).toBe(true); // the run itself survives (series is na)
  expect(failures).toHaveLength(1);
  expect(failures[0]!.label).toBe('ETHUSDT');
  expect(failures[0]!.error).toContain('ethusdt_1h.csv');
});
