import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  halfOpenIntervalSec,
  historyAcquisitionFromBars,
  StaticProvider,
  unixSecond,
  type Bar,
  type HistoryProvider,
  type HistoryRequest,
  type ResolvedHistorySource,
} from '../src/index.js';
import { cached, CsvProvider } from '../src/node.js';

function bar(time: number): Bar {
  return { time, open: 10, high: 12, low: 9, close: 11, volume: 5 };
}

function makeProvider(cacheIdentity: string, weekAnchorSec?: ReturnType<typeof unixSecond>) {
  const counters = { legacy: 0, exact: 0, resolutions: 0 };
  let provider!: HistoryProvider;
  provider = {
    id: 'fake-feed',
    assetClass: 'crypto',
    async history() {
      counters.legacy++;
      return [bar(0), bar(60)];
    },
    async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
      counters.resolutions++;
      const normalizedSymbol = symbol.trim().toUpperCase();
      const capabilities = {
        timeframes: ['1m'],
        alignment: 'utc-24x7' as const,
        ...(weekAnchorSec !== undefined ? { weekAnchorSec } : {}),
        maxBarsPerRequest: 100,
        maxBarsPerAcquisition: 1000,
      };
      return {
        provider,
        normalizedSymbol,
        cacheIdentity,
        capabilities,
        async history(request: HistoryRequest) {
          counters.exact++;
          return historyAcquisitionFromBars({
            bars: [bar(0), bar(60)],
            request,
            cacheIdentity,
            normalizedSymbol,
            alignment: capabilities.alignment,
            weekAnchorSec: capabilities.weekAnchorSec,
          });
        },
      };
    },
  };
  return { provider, counters };
}

function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'pinery-cache-test-'));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('cached wrapper forwards asset class, leaf identity, capabilities, and provenance', async () =>
  withTempDir(async (dir) => {
    const leaf = makeProvider('fake-feed:{"feed":"iex","adjustment":"split","max":1000}');
    const wrapper = cached(leaf.provider, { dir });
    const source = await wrapper.resolveHistorySource!(' btc ');

    expect(wrapper.assetClass).toBe('crypto');
    expect(source.provider).toBe(leaf.provider);
    expect(source.normalizedSymbol).toBe('BTC');
    expect(source.cacheIdentity).toContain('"feed":"iex"');
    expect(source.capabilities).toEqual({
      timeframes: ['1m'],
      alignment: 'utc-24x7',
      maxBarsPerRequest: 100,
      maxBarsPerAcquisition: 1000,
      coverageSemantics: 'bars-only',
    });
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.capabilities)).toBe(true);
    expect(Object.isFrozen(source.capabilities.timeframes)).toBe(true);
    expect(() => (source.capabilities.timeframes as unknown as string[]).push('5m')).toThrow();

    const request = {
      timeframe: '1m',
      requested: halfOpenIntervalSec(0, 120),
      query: halfOpenIntervalSec(0, 120),
    };
    const first = await source.history(request);
    const second = await source.history(request);

    expect(leaf.counters.exact).toBe(1);
    expect(second).toEqual(first);
    expect(second.provenance.cacheIdentity).toBe(source.cacheIdentity);
    expect(second.provenance.normalizedSymbol).toBe('BTC');
    expect(second.covered).toEqual([{ from: 0, to: 120 }]);
    expect(second.gaps).toEqual([]);
    expect(second.complete).toBe(true);
  }));

test('cached wrapper deep-freezes calendar capabilities while preserving leaf identity', async () =>
  withTempDir(async (dir) => {
    const calendar = {
      calendarId: 'CACHE',
      version: 'v1',
      coverage: halfOpenIntervalSec(0, 120),
      sessions: [halfOpenIntervalSec(0, 60)],
      periods: { '1d': [halfOpenIntervalSec(0, 120)] },
    };
    const provider = new StaticProvider(
      { 'XYZ|1m': [bar(0)] },
      {
        alignment: 'exchange-calendar',
        calendar,
        timeframes: ['1m'],
        cacheIdentity: 'cache-calendar',
      },
    );
    (calendar.periods['1d'][0] as unknown as { to: number }).to = 60;
    calendar.periods['1d'].push(halfOpenIntervalSec(60, 120));
    const leaf = await provider.resolveHistorySource('XYZ');
    const source = await cached(provider, { dir }).resolveHistorySource!('XYZ');

    expect(source.provider).toBe(provider);
    expect(source.cacheIdentity).toBe(leaf.cacheIdentity);
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
    expect(source.capabilities.calendar?.periods?.['1d']).toEqual([halfOpenIntervalSec(0, 120)]);
    expect(source.cacheIdentity).toContain('"periods"');
    expect(() => (source.capabilities.timeframes as unknown as string[]).push('5m')).toThrow();
    expect(() =>
      (source.capabilities.calendar!.periods!['1d'] as unknown as Array<unknown>).push({}),
    ).toThrow();
    expect(() => {
      (source.capabilities.calendar as unknown as { version: string }).version = 'v2';
    }).toThrow();

    const acquisition = await source.history({
      timeframe: '1m',
      requested: halfOpenIntervalSec(0, 120),
    });
    expect(acquisition.complete).toBe(true);
    expect(acquisition.provenance.cacheIdentity).toBe(leaf.cacheIdentity);
    expect(acquisition.provenance.alignment).toBe('exchange-calendar:CACHE@v1');
  }));

test('exact cache payload round-trips bars, exact range, coverage, gaps, and provenance', async () =>
  withTempDir(async (dir) => {
    const leaf = makeProvider('feed-options-v1');
    const source = await cached(leaf.provider, { dir }).resolveHistorySource!('BTC');
    const request = {
      timeframe: '1m',
      requested: halfOpenIntervalSec(0, 120),
      query: halfOpenIntervalSec(0, 180),
    };
    const acquisition = await source.history(request);

    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);
    const payload = JSON.parse(readFileSync(join(dir, files[0]!), 'utf8'));
    expect(payload).toMatchObject({
      schema: 'pinery.history-acquisition',
      version: 3,
      key: {
        cacheIdentity: 'feed-options-v1',
        normalizedSymbol: 'BTC',
        sourceTimeframe: '1m',
        requested: { from: 0, to: 120 },
        query: { from: 0, to: 180 },
        weekAnchorSec: null,
        coverageSemantics: 'bars-only',
        recordSpan: null,
      },
      acquisition: {
        bars: acquisition.bars,
        requested: { from: 0, to: 120 },
        covered: [{ from: 0, to: 120 }],
        gaps: [],
        complete: true,
        provenance: acquisition.provenance,
      },
    });

    // A new wrapper/source instance reads and validates the complete payload.
    const replay = await cached(leaf.provider, { dir }).resolveHistorySource!('BTC').then(
      (resolved) => resolved.history(request),
    );
    expect(replay).toEqual(acquisition);
    expect(leaf.counters.exact).toBe(1);
  }));

test('cache keys separate provider options, symbols, source timeframe, and exact ranges', async () =>
  withTempDir(async (dir) => {
    const iex = makeProvider('alpaca:{"feed":"iex","adjustment":"split","maxBars":100}');
    const sip = makeProvider('alpaca:{"feed":"sip","adjustment":"split","maxBars":100}');
    const iexSource = await cached(iex.provider, { dir }).resolveHistorySource!('AAPL');
    const sipSource = await cached(sip.provider, { dir }).resolveHistorySource!('AAPL');

    await iexSource.history({
      timeframe: '1m',
      requested: halfOpenIntervalSec(0, 60),
    });
    await iexSource.history({
      timeframe: '1m',
      requested: halfOpenIntervalSec(0, 120),
    });
    await sipSource.history({
      timeframe: '1m',
      requested: halfOpenIntervalSec(0, 60),
    });

    expect(iex.counters.exact).toBe(2);
    expect(sip.counters.exact).toBe(1);
    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toHaveLength(3);
  }));

test('corrupt or internally inconsistent exact coverage is refetched, never trusted', async () =>
  withTempDir(async (dir) => {
    const leaf = makeProvider('corrupt-test');
    const source = await cached(leaf.provider, { dir }).resolveHistorySource!('BTC');
    const request = {
      timeframe: '1m',
      requested: halfOpenIntervalSec(0, 120),
    };
    await source.history(request);
    expect(leaf.counters.exact).toBe(1);

    const file = join(
      dir,
      readdirSync(dir).find((name) => name.endsWith('.json'))!,
    );
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    // Keep a self-consistent complete partition but remove the bars that are
    // supposed to prove it. Cache validation must bind coverage to evidence.
    payload.acquisition.bars = [];
    writeFileSync(file, JSON.stringify(payload));

    const repaired = await source.history(request);
    expect(leaf.counters.exact).toBe(2);
    expect(repaired.complete).toBe(true);
    expect(repaired.covered).toEqual([{ from: 0, to: 120 }]);
  }));

test('legacy history callers remain cache-compatible while using resolved option identity', async () =>
  withTempDir(async (dir) => {
    const leaf = makeProvider('legacy-options');
    const wrapper = cached(leaf.provider, { dir });
    const range = { from: 0, to: 119 };

    expect(await wrapper.history('btc', '1m', range)).toHaveLength(2);
    expect(await wrapper.history('BTC', '1m', range)).toHaveLength(2);
    expect(leaf.counters.legacy).toBe(1);

    const payload = JSON.parse(
      readFileSync(
        join(
          dir,
          readdirSync(dir).find((name) => name.endsWith('.json'))!,
        ),
        'utf8',
      ),
    );
    expect(payload).toMatchObject({
      schema: 'pinery.history',
      version: 2,
      key: {
        cacheIdentity: 'legacy-options',
        normalizedSymbol: 'BTC',
        timeframe: '1m',
        range,
      },
    });
  }));

test('cache target provenance cannot widen one source bar into complete coverage', async () =>
  withTempDir(async (dir) => {
    const leaf = makeProvider('forged-target-cache');
    const source = await cached(leaf.provider, { dir }).resolveHistorySource!('BTC');
    const request = {
      timeframe: '1m',
      requested: halfOpenIntervalSec(0, 120),
    };
    await source.history(request);
    expect(leaf.counters.exact).toBe(1);

    const file = join(
      dir,
      readdirSync(dir).find((name) => name.endsWith('.json'))!,
    );
    const payload = JSON.parse(readFileSync(file, 'utf8'));
    payload.acquisition.bars = [bar(0)];
    payload.acquisition.covered = [{ from: 0, to: 120 }];
    payload.acquisition.gaps = [];
    payload.acquisition.complete = true;
    payload.acquisition.provenance.targetTimeframe = '2m';
    writeFileSync(file, JSON.stringify(payload));

    const repaired = await source.history(request);
    expect(leaf.counters.exact).toBe(2);
    expect(repaired.bars).toHaveLength(2);
    expect(repaired.provenance.targetTimeframe).toBe('1m');
  }));

test('refresh bypasses exact cache reads for every equal-envelope operation', async () =>
  withTempDir(async (dir) => {
    const leaf = makeProvider('refresh-exact');
    const source = await cached(leaf.provider, { dir, refresh: true }).resolveHistorySource!('BTC');
    const request = {
      timeframe: '1m',
      requested: halfOpenIntervalSec(0, 120),
    };

    await source.history(request);
    await source.history(request);

    expect(leaf.counters.exact).toBe(2);
    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toHaveLength(1);
  }));

test('exact cache keys and payload validation bind explicit weekly anchor evidence', async () =>
  withTempDir(async (dir) => {
    const mondayAnchor = unixSecond(4 * 86_400);
    const monday = makeProvider('same-cache-identity', mondayAnchor);
    const thursday = makeProvider('same-cache-identity', unixSecond(0));
    const mondaySource = await cached(monday.provider, { dir }).resolveHistorySource!('BTC');
    const thursdaySource = await cached(thursday.provider, { dir }).resolveHistorySource!('BTC');
    const request = {
      timeframe: '1m',
      requested: halfOpenIntervalSec(0, 120),
    };

    await mondaySource.history(request);
    await thursdaySource.history(request);
    expect(monday.counters.exact).toBe(1);
    expect(thursday.counters.exact).toBe(1);
    expect(readdirSync(dir).filter((name) => name.endsWith('.json'))).toHaveLength(2);

    const mondayFile = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, payload: JSON.parse(readFileSync(join(dir, name), 'utf8')) }))
      .find(({ payload }) => payload.key?.weekAnchorSec === mondayAnchor)!;
    expect(mondayFile.payload).toMatchObject({
      schema: 'pinery.history-acquisition',
      version: 3,
      key: {
        weekAnchorSec: mondayAnchor,
        coverageSemantics: 'bars-only',
        recordSpan: null,
      },
      acquisition: { provenance: { weekAnchorSec: mondayAnchor } },
    });

    // Omitting anchor identity makes the payload ineligible before evidence validation.
    delete mondayFile.payload.key.weekAnchorSec;
    writeFileSync(join(dir, mondayFile.name), JSON.stringify(mondayFile.payload));
    await mondaySource.history(request);
    expect(monday.counters.exact).toBe(2);

    // A forged provenance anchor with an intact key is also rejected and refetched.
    const repaired = JSON.parse(readFileSync(join(dir, mondayFile.name), 'utf8'));
    repaired.acquisition.provenance.weekAnchorSec = 0;
    writeFileSync(join(dir, mondayFile.name), JSON.stringify(repaired));
    const acquisition = await mondaySource.history(request);
    expect(monday.counters.exact).toBe(3);
    expect(acquisition.provenance.weekAnchorSec).toBe(mondayAnchor);
  }));

test('fresh exact acquisition rejects a mismatched weekly anchor before caching', async () =>
  withTempDir(async (dir) => {
    const mondayAnchor = unixSecond(4 * 86_400);
    const thursdayAnchor = unixSecond(0);
    let exactCalls = 0;
    let provider!: HistoryProvider;
    provider = {
      id: 'fresh-anchor-mismatch',
      async history() {
        return [];
      },
      async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
        const normalizedSymbol = symbol.trim().toUpperCase();
        return {
          provider,
          normalizedSymbol,
          cacheIdentity: 'fresh-anchor-mismatch',
          capabilities: {
            timeframes: ['1m'],
            alignment: 'utc-24x7',
            weekAnchorSec: mondayAnchor,
          },
          async history(request: HistoryRequest) {
            exactCalls++;
            return historyAcquisitionFromBars({
              bars: [bar(0), bar(60)],
              request,
              cacheIdentity: 'fresh-anchor-mismatch',
              normalizedSymbol,
              alignment: 'utc-24x7',
              weekAnchorSec: thursdayAnchor,
            });
          },
        };
      },
    };

    const source = await cached(provider, { dir }).resolveHistorySource!('BTC');
    const request = {
      timeframe: '1m',
      requested: halfOpenIntervalSec(0, 120),
    };

    await expect(source.history(request)).rejects.toMatchObject({
      type: 'exact-history-error',
      code: 'acquisition-week-anchor',
      details: { expected: mondayAnchor, actual: thursdayAnchor },
    });
    expect(exactCalls).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  }));

test('complete-record cache replay authenticates per-timeframe spans', async () =>
  withTempDir(async (dir) => {
    const data = mkdtempSync(join(tmpdir(), 'pinery-cache-complete-record-'));
    try {
      const header = 'time,open,high,low,close,volume\n';
      writeFileSync(join(data, 'BTC_1m.csv'), header + '0,1,2,0.5,1.5,10\n60,2,3,1.5,2.5,20\n');
      writeFileSync(join(data, 'BTC_5m.csv'), header + '0,1,2,0.5,1.5,10\n');
      const provider = new CsvProvider({
        dir: data,
        alignment: 'utc-24x7',
        coverageSemantics: 'complete-record',
        timeframes: 'arbitrary',
      });
      const source = await cached(provider, { dir }).resolveHistorySource!('BTC');
      expect(source.capabilities.recordSpan).toBeUndefined();
      expect(source.capabilities.recordSpans).toEqual({
        '1m': halfOpenIntervalSec(0, 120),
        '5m': halfOpenIntervalSec(0, 300),
      });
      expect(Object.isFrozen(source.capabilities.recordSpans)).toBe(true);
      expect(Object.isFrozen(source.capabilities.recordSpans?.['1m'])).toBe(true);

      const request = {
        timeframe: '1m',
        requested: halfOpenIntervalSec(0, 180),
      };
      const first = await source.history(request);
      expect(first.complete).toBe(false);
      expect(first.provenance.recordSpan).toEqual(halfOpenIntervalSec(0, 120));

      const file = join(
        dir,
        readdirSync(dir).find((name) => name.endsWith('.json'))!,
      );
      const payload = JSON.parse(readFileSync(file, 'utf8'));
      payload.acquisition.provenance.recordSpan = { from: 0, to: 180 };
      payload.acquisition.covered = [{ from: 0, to: 180 }];
      payload.acquisition.gaps = [];
      payload.acquisition.complete = true;
      writeFileSync(file, JSON.stringify(payload));

      const replay = await source.history(request);
      expect(replay.complete).toBe(false);
      expect(replay.provenance.recordSpan).toEqual(halfOpenIntervalSec(0, 120));
      expect(replay.gaps).toEqual([{ from: 120, to: 180, reason: 'provider-missing' }]);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  }));
