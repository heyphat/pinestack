import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { barsFromCsv, InstrumentRouter, createProvider } from '../src/index.js';
import { CsvProvider } from '../src/node.js';

let dir: string;

/** Hourly bars starting 2024-01-01T00:00Z. */
function hourlyCsv(count: number, startSec = 1704067200): string {
  const rows = ['time,open,high,low,close,volume'];
  for (let i = 0; i < count; i++) {
    const t = startSec + i * 3600;
    rows.push(`${t},${10 + i},${12 + i},${9 + i},${11 + i},${100 + i}`);
  }
  return rows.join('\n');
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinery-csv-'));
  writeFileSync(join(dir, 'BTCUSDT_1h.csv'), hourlyCsv(5));
  // Lowercase file for a case-insensitivity check.
  writeFileSync(join(dir, 'ethusdt_1h.csv'), hourlyCsv(3));
  // Sanitized symbol: BTC/USD → BTC_USD.
  writeFileSync(join(dir, 'BTC_USD_1d.csv'), 'time,open,high,low,close\n2024-01-01,1,2,0.5,1.5\n');
  // Timeframe-less fallback file with hourly spacing.
  writeFileSync(join(dir, 'SOLUSDT.csv'), hourlyCsv(10));
  // Fallback edge cases: two rows (one measurable interval), one row (none).
  writeFileSync(join(dir, 'TWOBAR.csv'), hourlyCsv(2));
  writeFileSync(join(dir, 'ONEBAR.csv'), hourlyCsv(1));
  writeFileSync(
    join(dir, 'instruments.csv'),
    'symbol,minQty,mintick\nBTCUSDT,0.001,0.1\nBTC/USD,,0.5\n',
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── barsFromCsv hardening ───────────────────────────────────

test('barsFromCsv dedupes timestamps keeping the last row', () => {
  const bars = barsFromCsv(
    'time,open,high,low,close,volume\n100,1,2,0.5,1.5,10\n100,2,3,1,2.5,20\n200,3,4,2,3.5,30\n',
  );
  expect(bars).toHaveLength(2);
  expect(bars[0]).toEqual({ time: 100, open: 2, high: 3, low: 1, close: 2.5, volume: 20 });
});

test('barsFromCsv throws with the line number on a bad cell', () => {
  expect(() =>
    barsFromCsv('time,open,high,low,close\n100,1,2,0.5,1.5\n200,oops,2,1,1.5\n'),
  ).toThrow('line 3');
  expect(() => barsFromCsv('time,open,high,low,close\n100,1,2,0.5,\n')).toThrow('bad close');
  expect(() => barsFromCsv('time,open,high,low,close\nnot-a-date,1,2,0.5,1\n')).toThrow('bad time');
});

test('barsFromCsv accepts RFC 4180-quoted fields (vendor exports quote everything)', () => {
  const quoted = barsFromCsv(
    '"time","open","high","low","close","volume"\n"100","1","2","0.5","1.5","10"\n',
  );
  const bare = barsFromCsv('time,open,high,low,close,volume\n100,1,2,0.5,1.5,10\n');
  expect(quoted).toEqual(bare);
});

test('barsFromCsv handles commas and escaped quotes inside quoted fields', () => {
  // An extra quoted column with a comma + "" escape must not shift the OHLC columns.
  const bars = barsFromCsv('note,time,open,high,low,close\n"hello, ""world""",100,1,2,0.5,1.5\n');
  expect(bars).toEqual([{ time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }]);
});

test('barsFromCsv strips a UTF-8 BOM before the header', () => {
  const bars = barsFromCsv('\uFEFF' + 'time,open,high,low,close\n100,1,2,0.5,1.5\n');
  expect(bars).toHaveLength(1);
});

// ── CsvProvider ─────────────────────────────────────────────

test('CsvProvider serves <SYMBOL>_<TF>.csv and applies the range', async () => {
  const p = new CsvProvider({ dir });
  const all = await p.history('BTCUSDT', '1h');
  expect(all).toHaveLength(5);
  expect(all[0]!.time).toBe(1704067200);
  const limited = await p.history('BTCUSDT', '1h', { limit: 2 });
  expect(limited.map((b) => b.time)).toEqual([1704067200 + 3 * 3600, 1704067200 + 4 * 3600]);
  const from = await p.history('BTCUSDT', '1h', { from: 1704067200 + 3600, to: 1704067200 + 7200 });
  expect(from).toHaveLength(2);
});

test('CsvProvider matches filenames case-insensitively', async () => {
  const p = new CsvProvider({ dir });
  expect(await p.history('ETHUSDT', '1h')).toHaveLength(3);
});

test('CsvProvider sanitizes symbols like the disk cache (BTC/USD → BTC_USD)', async () => {
  const p = new CsvProvider({ dir });
  const bars = await p.history('BTC/USD', '1d');
  expect(bars).toHaveLength(1);
  expect(bars[0]!.volume).toBe(0); // volume column optional
});

test('CsvProvider falls back to <SYMBOL>.csv when spacing matches', async () => {
  const p = new CsvProvider({ dir });
  expect(await p.history('SOLUSDT', '1h')).toHaveLength(10);
});

test('CsvProvider rejects the fallback file when spacing mismatches the timeframe', async () => {
  const p = new CsvProvider({ dir });
  await expect(p.history('SOLUSDT', '1d')).rejects.toThrow('asked for 1d');
});

test('CsvProvider validates a two-row fallback file (one interval is enough)', async () => {
  const p = new CsvProvider({ dir });
  expect(await p.history('TWOBAR', '1h')).toHaveLength(2);
  await expect(p.history('TWOBAR', '1d')).rejects.toThrow('asked for 1d');
});

test('CsvProvider refuses a one-row fallback file as unverifiable', async () => {
  const p = new CsvProvider({ dir });
  await expect(p.history('ONEBAR', '1h')).rejects.toThrow('ONEBAR_1h.csv');
});

test('CsvProvider names the candidates and directory contents when a file is missing', async () => {
  const p = new CsvProvider({ dir });
  await expect(p.history('DOGEUSDT', '1h')).rejects.toThrow('dogeusdt_1h.csv');
  await expect(p.history('DOGEUSDT', '1h')).rejects.toThrow('BTCUSDT_1h.csv');
});

test('CsvProvider errors cleanly on a missing directory', async () => {
  const p = new CsvProvider({ dir: join(dir, 'nope') });
  await expect(p.history('BTCUSDT', '1h')).rejects.toThrow('cannot read data directory');
});

test('CsvProvider reads instrument metadata from instruments.csv', async () => {
  const p = new CsvProvider({ dir });
  expect(await p.instrument('BTCUSDT')).toEqual({ minQty: 0.001, mintick: 0.1 });
  expect(await p.instrument('btc/usd')).toEqual({ mintick: 0.5 }); // blank minQty omitted
  expect(await p.instrument('DOGEUSDT')).toBeUndefined();
});

test('CsvProvider accepts a quoted instruments.csv sidecar', async () => {
  const quoted = mkdtempSync(join(tmpdir(), 'pinery-csv-quoted-'));
  try {
    writeFileSync(
      join(quoted, 'instruments.csv'),
      '"symbol","minQty","mintick"\n"BTCUSDT","0.001","0.1"\n',
    );
    const p = new CsvProvider({ dir: quoted });
    expect(await p.instrument('BTCUSDT')).toEqual({ minQty: 0.001, mintick: 0.1 });
  } finally {
    rmSync(quoted, { recursive: true, force: true });
  }
});

test('CsvProvider fails loudly on malformed instruments.csv values', async () => {
  const bad = mkdtempSync(join(tmpdir(), 'pinery-csv-bad-'));
  try {
    writeFileSync(join(bad, 'BTCUSDT_1h.csv'), hourlyCsv(3));

    // Non-numeric cell names the line and column.
    writeFileSync(join(bad, 'instruments.csv'), 'symbol,minQty,mintick\nBTCUSDT,oops,-1\n');
    await expect(new CsvProvider({ dir: bad }).instrument('BTCUSDT')).rejects.toThrow(
      'line 2: bad minQty "oops"',
    );
    // history() validates the sidecar too: pinerun swallows instrument() errors
    // (metadata is advisory), so the loud failure must not depend on that path.
    await expect(new CsvProvider({ dir: bad }).history('BTCUSDT', '1h')).rejects.toThrow(
      'bad minQty',
    );

    // Zero / negative are invalid, not "blank-like".
    writeFileSync(join(bad, 'instruments.csv'), 'symbol,minQty,mintick\nBTCUSDT,0.001,0\n');
    await expect(new CsvProvider({ dir: bad }).instrument('BTCUSDT')).rejects.toThrow(
      'bad mintick "0"',
    );

    // A row with values but no symbol is malformed, not skippable.
    writeFileSync(join(bad, 'instruments.csv'), 'symbol,minQty,mintick\n,1,1\n');
    await expect(new CsvProvider({ dir: bad }).instrument('BTCUSDT')).rejects.toThrow(
      'line 2: missing symbol',
    );
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
});

// ── registry / router integration ───────────────────────────

test('createProvider("csv") points at the Node entry instead of constructing', () => {
  expect(() => createProvider('csv')).toThrow('@heyphat/pinery/node');
});

test('router routes CSV: addresses to an injected provider, unwrapped', async () => {
  let wrapped = 0;
  const router = new InstrumentRouter({
    providers: { csv: new CsvProvider({ dir }) },
    wrap: (p) => {
      wrapped++;
      return p;
    },
  });
  const bars = await router.history('CSV:BTCUSDT', '1h');
  expect(bars).toHaveLength(5);
  expect(wrapped).toBe(0); // injected instances skip wrap
  expect(await router.instrument('CSV:BTCUSDT')).toEqual({ minQty: 0.001, mintick: 0.1 });
});

test('router with csv fallback serves bare tickers from files', async () => {
  const router = new InstrumentRouter({
    fallbackProvider: 'csv',
    providers: { csv: new CsvProvider({ dir }) },
  });
  expect(await router.history('ETHUSDT', '1h')).toHaveLength(3);
});
