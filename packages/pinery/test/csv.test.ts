import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireExactHistory,
  barsFromCsv,
  ExactHistoryError,
  halfOpenIntervalSec,
  InstrumentRouter,
  createProvider,
  unixSecond,
} from '../src/index.js';
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

test('CsvProvider arbitrary discovery is case-insensitive but requires canonical timeframe tokens', async () => {
  const scoped = mkdtempSync(join(tmpdir(), 'pinery-csv-filename-timeframe-'));
  try {
    const row = 'time,open,high,low,close,volume\n0,1,2,0.5,1.5,10\n';
    writeFileSync(join(scoped, 'UPPER_1H.CSV'), row);
    writeFileSync(join(scoped, 'ALIAS_01h.csv'), row);
    const provider = new CsvProvider({
      dir: scoped,
      alignment: 'utc-24x7',
      timeframes: 'arbitrary',
    });

    const upper = await provider.resolveHistorySource('UPPER');
    expect(upper.capabilities.timeframes).toEqual(['1h']);
    expect(
      await upper.history({ timeframe: '1h', requested: halfOpenIntervalSec(0, 3_600) }),
    ).toMatchObject({ complete: true, bars: [{ time: 0 }] });

    const alias = await provider.resolveHistorySource('ALIAS');
    expect(alias.capabilities.timeframes).toEqual([]);
    await expect(
      alias.history({ timeframe: '1h', requested: halfOpenIntervalSec(0, 3_600) }),
    ).rejects.toMatchObject({
      kind: 'unsupported',
      code: 'csv-timeframe-unavailable',
    });
  } finally {
    rmSync(scoped, { recursive: true, force: true });
  }
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

test('CsvProvider exact source rejects subsecond opens while legacy history keeps rounding', async () => {
  const subsecond = mkdtempSync(join(tmpdir(), 'pinery-csv-subsecond-'));
  try {
    writeFileSync(
      join(subsecond, 'BTC_1s.csv'),
      'time,open,high,low,close,volume\n1970-01-01T00:00:01.500Z,1,2,0.5,1.5,10\n',
    );
    const provider = new CsvProvider({
      dir: subsecond,
      alignment: 'utc-24x7',
      timeframes: ['1s'],
    });
    expect((await provider.history('BTC', '1s'))[0]!.time).toBe(1);

    const source = await provider.resolveHistorySource('BTC');
    await expect(
      source.history({
        timeframe: '1s',
        requested: halfOpenIntervalSec(1, 2),
      }),
    ).rejects.toBeInstanceOf(ExactHistoryError);
    await expect(
      source.history({
        timeframe: '1s',
        requested: halfOpenIntervalSec(1, 2),
      }),
    ).rejects.toMatchObject({ kind: 'unsupported', code: 'subsecond-bar-boundary' });
  } finally {
    rmSync(subsecond, { recursive: true, force: true });
  }
});

test('CsvProvider source identity changes when relevant file content changes', async () => {
  const mutable = mkdtempSync(join(tmpdir(), 'pinery-csv-identity-'));
  try {
    const file = join(mutable, 'BTC_1m.csv');
    writeFileSync(file, 'time,open,high,low,close,volume\n0,1,2,0.5,1.5,10\n');
    const provider = new CsvProvider({
      dir: mutable,
      alignment: 'utc-24x7',
      timeframes: ['1m'],
    });
    const before = await provider.resolveHistorySource('BTC');
    expect((await provider.history('BTC', '1m'))[0]!.close).toBe(1.5);

    writeFileSync(file, 'time,open,high,low,close,volume\n0,1,3,0.5,2.5,20\n');
    await expect(
      before.history({ timeframe: '1m', requested: halfOpenIntervalSec(0, 60) }),
    ).rejects.toMatchObject({
      type: 'exact-history-error',
      kind: 'provider-limited',
      code: 'csv-source-changed',
    });
    const after = await provider.resolveHistorySource('BTC');
    expect(after.cacheIdentity).not.toBe(before.cacheIdentity);
    expect((await provider.history('BTC', '1m'))[0]!.close).toBe(2.5);
  } finally {
    rmSync(mutable, { recursive: true, force: true });
  }
});

test('CsvProvider resolves per-symbol timeframes and types post-resolution file loss', async () => {
  const scoped = mkdtempSync(join(tmpdir(), 'pinery-csv-scoped-'));
  try {
    const btcFile = join(scoped, 'BTC_1m.csv');
    writeFileSync(btcFile, 'time,open,high,low,close,volume\n0,1,2,0.5,1.5,10\n');
    writeFileSync(join(scoped, 'ETH_5m.csv'), 'time,open,high,low,close,volume\n0,2,3,1,2.5,20\n');
    const provider = new CsvProvider({
      dir: scoped,
      alignment: 'utc-24x7',
      timeframes: ['1m', '5m'],
    });
    const btc = await provider.resolveHistorySource('BTC');
    const eth = await provider.resolveHistorySource('ETH');
    const missing = await provider.resolveHistorySource('DOGE');

    expect(btc.capabilities.timeframes).toEqual(['1m']);
    expect(eth.capabilities.timeframes).toEqual(['5m']);
    expect(missing.capabilities.timeframes).toEqual([]);

    rmSync(btcFile);
    await expect(
      btc.history({ timeframe: '1m', requested: halfOpenIntervalSec(0, 60) }),
    ).rejects.toMatchObject({
      type: 'exact-history-error',
      kind: 'provider-limited',
      code: 'csv-source-changed',
    });
  } finally {
    rmSync(scoped, { recursive: true, force: true });
  }
});

test('CsvProvider snapshots caller-owned calendar metadata for identity and coverage', async () => {
  const scoped = mkdtempSync(join(tmpdir(), 'pinery-csv-calendar-'));
  try {
    writeFileSync(
      join(scoped, 'XYZ_1m.csv'),
      'time,open,high,low,close,volume\n0,1,2,0.5,1.5,10\n',
    );
    const calendar = {
      calendarId: 'TEST',
      version: 'v1',
      coverage: halfOpenIntervalSec(0, 120),
      sessions: [halfOpenIntervalSec(0, 60)],
      periods: { '1d': [halfOpenIntervalSec(0, 120)] },
    };
    const timeframes = ['1m'];
    const provider = new CsvProvider({
      dir: scoped,
      alignment: 'exchange-calendar',
      calendar,
      timeframes,
    });

    // Both declarations are snapshotted by the constructor, before resolution.
    timeframes.splice(0, 1, '5m');
    calendar.calendarId = 'MUTATED';
    calendar.version = 'v2';
    calendar.coverage = halfOpenIntervalSec(0, 180);
    calendar.sessions.splice(0, 1, halfOpenIntervalSec(0, 120));
    (calendar.periods['1d'][0] as unknown as { to: number }).to = 60;
    calendar.periods['1d'].push(halfOpenIntervalSec(60, 120));

    const source = await provider.resolveHistorySource('XYZ');
    const identity = source.cacheIdentity;
    expect(() => (source.capabilities.timeframes as unknown as string[]).push('5m')).toThrow();
    expect(() => {
      (source.capabilities.calendar as unknown as { version: string }).version = 'v3';
    }).toThrow();

    const acquisition = await source.history({
      timeframe: '1m',
      requested: halfOpenIntervalSec(0, 120),
    });
    expect(acquisition.complete).toBe(true);
    expect(acquisition.provenance.alignment).toBe('exchange-calendar:TEST@v1');
    expect(source.cacheIdentity).toBe(identity);
    expect(source.cacheIdentity).toContain('"capabilities":');
    expect(source.capabilities.timeframes).toEqual(['1m']);
    expect(source.capabilities.calendar).toMatchObject({
      calendarId: 'TEST',
      version: 'v1',
      coverage: halfOpenIntervalSec(0, 120),
      sessions: [halfOpenIntervalSec(0, 60)],
      periods: { '1d': [halfOpenIntervalSec(0, 120)] },
    });
    expect(source.cacheIdentity).toContain('"calendarId":"TEST"');
    expect(source.cacheIdentity).toContain('"periods":');
    expect(source.cacheIdentity).not.toContain('MUTATED');
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.capabilities)).toBe(true);
    expect(Object.isFrozen(source.capabilities.timeframes)).toBe(true);
    expect(Object.isFrozen(source.capabilities.calendar)).toBe(true);
    expect(Object.isFrozen(source.capabilities.calendar?.coverage)).toBe(true);
    expect(Object.isFrozen(source.capabilities.calendar?.sessions)).toBe(true);
    expect(Object.isFrozen(source.capabilities.calendar?.sessions[0])).toBe(true);
    expect(Object.isFrozen(source.capabilities.calendar?.periods)).toBe(true);
    expect(Object.isFrozen(source.capabilities.calendar?.periods?.['1d'])).toBe(true);
    expect(Object.isFrozen(source.capabilities.calendar?.periods?.['1d']?.[0])).toBe(true);
  } finally {
    rmSync(scoped, { recursive: true, force: true });
  }
});

test('CsvProvider exact acquisitions own deeply frozen parse-cache-safe bar snapshots', async () => {
  const immutable = mkdtempSync(join(tmpdir(), 'pinery-csv-immutable-'));
  try {
    writeFileSync(
      join(immutable, 'BTC_1m.csv'),
      ['time,open,high,low,close,volume', '0,1,2,0.5,1.5,10', '60,2,3,1.5,2.5,20'].join('\n'),
    );
    const provider = new CsvProvider({
      dir: immutable,
      alignment: 'utc-24x7',
      timeframes: ['1m'],
    });
    const source = await provider.resolveHistorySource('BTC');
    const identity = source.cacheIdentity;
    const request = { timeframe: '1m', requested: halfOpenIntervalSec(0, 120) };

    const first = await source.history(request);
    expect(Object.isFrozen(first.bars)).toBe(true);
    expect(first.bars.every(Object.isFrozen)).toBe(true);
    expect(() =>
      (first.bars as unknown as Array<{ close: number }>).push({ close: 999 }),
    ).toThrow();
    expect(() => {
      (first.bars[0] as { close: number }).close = 999;
    }).toThrow();

    const second = await source.history(request);
    expect(second.bars).not.toBe(first.bars);
    expect(second.bars[0]).not.toBe(first.bars[0]);
    expect(second.bars).toEqual([
      { time: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { time: 60, open: 2, high: 3, low: 1.5, close: 2.5, volume: 20 },
    ]);
    expect(second.provenance.cacheIdentity).toBe(identity);
    expect(source.cacheIdentity).toBe(identity);
  } finally {
    rmSync(immutable, { recursive: true, force: true });
  }
});

test('CsvProvider exact parsing rejects malformed raw rows before range repair', async () => {
  const malformed = mkdtempSync(join(tmpdir(), 'pinery-csv-malformed-exact-'));
  try {
    const header = 'time,open,high,low,close,volume\n';
    writeFileSync(
      join(malformed, 'UNSORTED_1m.csv'),
      header + '0,1,2,0.5,1.5,10\n120,2,3,1.5,2.5,20\n60,3,4,2.5,3.5,30\n',
    );
    writeFileSync(
      join(malformed, 'DUPLICATE_1m.csv'),
      header + '0,1,2,0.5,1.5,10\n0,2,3,1.5,2.5,20\n60,3,4,2.5,3.5,30\n',
    );
    writeFileSync(
      join(malformed, 'NONFINITE_1m.csv'),
      header + '0,1,2,0.5,1.5,10\n60,2,Infinity,1.5,2.5,20\n',
    );
    writeFileSync(
      join(malformed, 'BAD_OHLC_1m.csv'),
      header + '0,1,2,0.5,1.5,10\n60,1,1.2,0.5,1.5,20\n',
    );
    writeFileSync(
      join(malformed, 'LEGACY_1m.csv'),
      header + '60,2,3,1.5,2.5,20\n0,1,2,0.5,1.5,10\n60,3,4,2.5,3.5,30\n',
    );

    const provider = new CsvProvider({
      dir: malformed,
      alignment: 'utc-24x7',
      timeframes: ['1m'],
    });
    const cases = [
      ['UNSORTED', 'bar-order', halfOpenIntervalSec(0, 60)],
      ['DUPLICATE', 'bar-order', halfOpenIntervalSec(60, 120)],
      ['NONFINITE', 'bar-value', halfOpenIntervalSec(0, 60)],
      ['BAD_OHLC', 'bar-ohlc', halfOpenIntervalSec(0, 60)],
    ] as const;

    for (const [symbol, code, requested] of cases) {
      const source = await provider.resolveHistorySource(symbol);
      let failure: unknown;
      try {
        await source.history({ timeframe: '1m', requested });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ExactHistoryError);
      expect(failure).toMatchObject({ kind: 'malformed', code });
    }

    const legacy = await provider.history('LEGACY', '1m');
    expect(legacy.map((bar) => bar.time)).toEqual([0, 60]);
    expect(legacy[1]).toEqual({
      time: 60,
      open: 3,
      high: 4,
      low: 2.5,
      close: 3.5,
      volume: 30,
    });
  } finally {
    rmSync(malformed, { recursive: true, force: true });
  }
});

test('CsvProvider requires and preserves caller-supplied UTC weekly anchor evidence', async () => {
  const weekly = mkdtempSync(join(tmpdir(), 'pinery-csv-weekly-anchor-'));
  try {
    const mondayAnchor = unixSecond(4 * 86_400);
    writeFileSync(
      join(weekly, 'BTC_1w.csv'),
      `time,open,high,low,close,volume\n${mondayAnchor},1,2,0.5,1.5,10\n`,
    );
    const anchored = new CsvProvider({
      dir: weekly,
      alignment: 'utc-24x7',
      weekAnchorSec: mondayAnchor,
      timeframes: ['1w'],
    });
    const anchoredSource = await anchored.resolveHistorySource('BTC');
    const acquisition = await acquireExactHistory(anchoredSource, {
      targetTimeframe: '1w',
      requested: halfOpenIntervalSec(mondayAnchor, mondayAnchor + 7 * 86_400),
    });
    expect(anchoredSource.capabilities.weekAnchorSec).toBe(mondayAnchor);
    expect(acquisition.complete).toBe(true);
    expect(acquisition.provenance.weekAnchorSec).toBe(mondayAnchor);

    const anchorless = new CsvProvider({
      dir: weekly,
      alignment: 'utc-24x7',
      timeframes: ['1w'],
    });
    await expect(
      acquireExactHistory(await anchorless.resolveHistorySource('BTC'), {
        targetTimeframe: '1w',
        requested: halfOpenIntervalSec(mondayAnchor, mondayAnchor + 7 * 86_400),
      }),
    ).rejects.toMatchObject({ kind: 'unsupported', code: 'weekly-anchor-missing' });
  } finally {
    rmSync(weekly, { recursive: true, force: true });
  }
});

test('CsvProvider authenticates complete-record spans without changing bars-only defaults', async () => {
  const records = mkdtempSync(join(tmpdir(), 'pinery-csv-complete-record-'));
  try {
    const header = 'time,open,high,low,close,volume\n';
    writeFileSync(
      join(records, 'BTC_1m.csv'),
      header + '0,1,2,0.5,1.5,10\n120,2,3,1.5,2.5,20\n180,3,4,2.5,3.5,30\n',
    );
    writeFileSync(join(records, 'ONE_1m.csv'), header + '60,1,2,0.5,1.5,10\n');
    writeFileSync(join(records, 'EMPTY_1m.csv'), header);
    writeFileSync(join(records, 'FALLBACK.csv'), header + '0,1,2,0.5,1.5,10\n60,2,3,1.5,2.5,20\n');

    const barsOnly = await new CsvProvider({
      dir: records,
      alignment: 'utc-24x7',
      timeframes: ['1m'],
    }).resolveHistorySource('BTC');
    const completeRecord = await new CsvProvider({
      dir: records,
      alignment: 'utc-24x7',
      coverageSemantics: 'complete-record',
      timeframes: ['1m'],
    }).resolveHistorySource('BTC');

    const request = { timeframe: '1m', requested: halfOpenIntervalSec(0, 240) };
    const legacy = await barsOnly.history(request);
    const complete = await completeRecord.history(request);
    expect(legacy.provenance.coverageSemantics).toBe('bars-only');
    expect(legacy.gaps).toEqual([{ from: 60, to: 120, reason: 'provider-missing' }]);
    expect(completeRecord.capabilities).toMatchObject({
      coverageSemantics: 'complete-record',
      recordSpan: halfOpenIntervalSec(0, 240),
    });
    expect(Object.isFrozen(completeRecord.capabilities.recordSpan)).toBe(true);
    expect(complete.provenance).toMatchObject({
      coverageSemantics: 'complete-record',
      recordSpan: halfOpenIntervalSec(0, 240),
    });
    expect(complete.covered).toEqual([halfOpenIntervalSec(0, 240)]);
    expect(complete.gaps).toEqual([]);
    expect(completeRecord.cacheIdentity).not.toBe(barsOnly.cacheIdentity);
    expect(completeRecord.cacheIdentity).toContain('complete-record');
    expect(completeRecord.cacheIdentity).toContain('recordSpans');

    const one = await new CsvProvider({
      dir: records,
      alignment: 'utc-24x7',
      coverageSemantics: 'complete-record',
      timeframes: ['1m'],
    }).resolveHistorySource('ONE');
    expect(
      await one.history({ timeframe: '1m', requested: halfOpenIntervalSec(60, 120) }),
    ).toMatchObject({
      complete: true,
      covered: [halfOpenIntervalSec(60, 120)],
      provenance: { recordSpan: halfOpenIntervalSec(60, 120) },
    });

    const fallback = await new CsvProvider({
      dir: records,
      alignment: 'utc-24x7',
      coverageSemantics: 'complete-record',
      timeframes: 'arbitrary',
    }).resolveHistorySource('FALLBACK');
    expect(fallback.capabilities.timeframes).toEqual([]);
    await expect(fallback.history(request)).rejects.toMatchObject({
      kind: 'unsupported',
      code: 'csv-timeframe-unavailable',
    });
    await expect(
      new CsvProvider({
        dir: records,
        alignment: 'utc-24x7',
        coverageSemantics: 'complete-record',
        timeframes: ['1m'],
      }).resolveHistorySource('EMPTY'),
    ).rejects.toThrow('no data rows');
  } finally {
    rmSync(records, { recursive: true, force: true });
  }
});

test('CsvProvider complete-record fails closed without explicit alignment', () => {
  expect(
    () =>
      new CsvProvider({
        dir,
        coverageSemantics: 'complete-record',
        timeframes: ['1h'],
      }),
  ).toThrow(ExactHistoryError);
});

test('CsvProvider complete-record uses authoritative calendar-period effective close', async () => {
  const records = mkdtempSync(join(tmpdir(), 'pinery-csv-calendar-record-'));
  try {
    writeFileSync(
      join(records, 'XYZ_1d.csv'),
      'time,open,high,low,close,volume\n0,1,2,0.5,1.5,10\n',
    );
    const calendar = {
      calendarId: 'SPLIT-DAY-RECORD',
      version: 'v1',
      coverage: halfOpenIntervalSec(0, 86_400),
      sessions: [halfOpenIntervalSec(0, 3_600), halfOpenIntervalSec(7_200, 10_800)],
      periods: { '1d': [halfOpenIntervalSec(0, 86_400)] },
    };
    const source = await new CsvProvider({
      dir: records,
      alignment: 'exchange-calendar',
      calendar,
      coverageSemantics: 'complete-record',
      timeframes: ['1d'],
    }).resolveHistorySource('XYZ');

    expect(source.capabilities.recordSpan).toEqual(halfOpenIntervalSec(0, 10_800));
    const acquisition = await source.history({
      timeframe: '1d',
      requested: halfOpenIntervalSec(0, 10_800),
    });
    expect(acquisition.complete).toBe(true);
    expect(acquisition.covered).toEqual([halfOpenIntervalSec(0, 10_800)]);
    expect(acquisition.provenance.recordSpan).toEqual(halfOpenIntervalSec(0, 10_800));
  } finally {
    rmSync(records, { recursive: true, force: true });
  }
});
