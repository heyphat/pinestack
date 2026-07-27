import { test, expect } from 'bun:test';
import { compile as compilePinerFixture, type SecurityDependency } from '@heyphat/piner';
import {
  StaticProvider,
  historyAcquisitionFromBars,
  unixSecond,
  type Bar,
  type HistoryProvider,
  type HistoryRange,
  type HistoryRequest,
  type HistorySessionCalendar,
  type ResolvedHistorySource,
} from '@heyphat/pinery';
import {
  scan,
  LocalRunner,
  jobHash,
  resolveLowerFetchTf,
  classifyRequests,
  securityDatasetAcquisitionKey,
  PROBE_SYMBOL,
  type Job,
  type ResolvedMagnifierDataset,
  type ResolvedSecurityDatasetProof,
} from '../src/index.js';
import { DAY1, hourly } from './fixtures.js';
import { marketDataDigest } from '../src/hash.js';
import { toWireJob } from '../src/wire.js';
import {
  deriveResolverIssuedSecurityPrefix,
  isResolverIssuedSecurityProof,
  securityRangeForBarMagnifier,
} from '../src/security.js';

/** Counts history() calls so we can assert fetch dedup. */
class CountingProvider implements HistoryProvider {
  readonly id = 'counting';
  readonly calls: string[] = [];
  constructor(private readonly inner: HistoryProvider) {}
  history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    this.calls.push(`${symbol}@${timeframe}`);
    return this.inner.history(symbol, timeframe, range);
  }
}

function deepFreezeFixture<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeFixture(child, seen);
  }
  return Object.freeze(value);
}

function immutableBarsFixture(values: readonly Bar[]): Bar[] {
  return deepFreezeFixture(values.map((bar) => ({ ...bar }))) as unknown as Bar[];
}

type CompilerMetadataOverride = {
  readonly lookahead?: boolean | null;
  readonly expressionPriorBars?: number | null;
};

/**
 * Test-only structural fixture for piner's additive dependency metadata. The
 * installed package predates these fields; identity fields still come from the
 * real compiler in its exact emitted array order.
 */
function compilerDependencies(
  source: string,
  overrides: readonly CompilerMetadataOverride[] = [],
): SecurityDependency[] {
  const { securityDependencies: dependencies } = compilePinerFixture(source).metadata;
  const defaultPlainLookahead =
    source.includes('lookahead_on') && !source.includes('lookahead_off');
  return dependencies.map((dependency, index) => {
    const override = overrides[index];
    return {
      ...dependency,
      lookahead:
        override && Object.prototype.hasOwnProperty.call(override, 'lookahead')
          ? override.lookahead!
          : dependency.lowerTf
            ? null
            : defaultPlainLookahead,
      expressionPriorBars:
        override && Object.prototype.hasOwnProperty.call(override, 'expressionPriorBars')
          ? override.expressionPriorBars!
          : 0,
    } as SecurityDependency;
  });
}

function reboundSecurityProof(
  base: ResolvedSecurityDatasetProof,
  bars: readonly Bar[],
  patch: Partial<Omit<ResolvedSecurityDatasetProof, 'acquisitionKey'>> = {},
  rebind = true,
): ResolvedSecurityDatasetProof {
  const { acquisitionKey: _oldKey, ...baseBound } = base;
  const bound = {
    ...baseBound,
    barsDigest: marketDataDigest(bars),
    ...patch,
  };
  return deepFreezeFixture({
    ...bound,
    acquisitionKey: rebind ? securityDatasetAcquisitionKey(bound) : base.acquisitionKey,
  });
}

// ── cross-symbol HTF ─────────────────────────────────────────
test('cross-symbol request.security resolves the other symbol (not na)', async () => {
  const provider = new CountingProvider(
    new StaticProvider({ BTC: hourly(48, 100), AAPL: hourly(48, 200) }),
  );
  const src = `//@version=6
indicator("x")
d = request.security("AAPL", "D", close)
plot(d, "d")`;

  const report = await scan({
    source: src,
    symbols: ['BTC'],
    timeframe: '1h',
    provider,
    rank: 'last(d)',
    runner: new LocalRunner(),
  });

  expect(report.errors).toHaveLength(0);
  const d = report.results[0]!.plots.find((p) => p.title === 'd')!.data;
  expect(Number.isNaN(d[0]!)).toBe(true); // day 0: no prior confirmed AAPL daily
  expect(d[47]).toBe(223); // day 1 sees AAPL's day-0 confirmed daily close (bar 23 = 200+23)
});

test('without security resolution the cross request degrades to na', async () => {
  const provider = new StaticProvider({ BTC: hourly(48, 100), AAPL: hourly(48, 200) });
  const src = `//@version=6
indicator("x")
d = request.security("AAPL", "D", close)
plot(d, "d")`;
  const report = await scan({
    source: src,
    symbols: ['BTC'],
    timeframe: '1h',
    provider,
    rank: 'count(d)',
    resolveSecurity: false,
    runner: new LocalRunner(),
  });
  const d = report.results[0]!.plots.find((p) => p.title === 'd')!.data;
  expect(d.every((v) => Number.isNaN(v))).toBe(true);
});

test('a cross symbol is fetched once and shared across all scanned symbols', async () => {
  const provider = new CountingProvider(
    new StaticProvider({ BTC: hourly(48, 100), ETH: hourly(48, 150), SPX: hourly(48, 400) }),
  );
  const src = `//@version=6
indicator("x")
b = request.security("SPX", "D", close)
plot(close - b, "spread")`;
  await scan({
    source: src,
    symbols: ['BTC', 'ETH'],
    timeframe: '1h',
    provider,
    rank: 'last(spread)',
    runner: new LocalRunner(),
  });
  // BTC + ETH primary fetches + exactly ONE SPX fetch (shared), plus the discovery run does none.
  const spxFetches = provider.calls.filter((c) => c.startsWith('SPX@'));
  expect(spxFetches).toHaveLength(1);
});

// ── self lower_tf (intrabar) ─────────────────────────────────
test('request.security_lower_tf(syminfo.tickerid) buckets injected intrabars per chart bar', async () => {
  const chart: Bar[] = [0, 1].map((b) => {
    const c = 100 + b;
    return { time: DAY1 + b * 3600, open: c, high: c + 1, low: c - 1, close: c, volume: 0 };
  });
  const ltf: Bar[] = [];
  for (let b = 0; b < 2; b++) {
    for (let k = 0; k < 4; k++) {
      ltf.push({
        time: DAY1 + b * 3600 + k * 900,
        open: 1,
        high: 1,
        low: 1,
        close: k,
        volume: (b * 4 + k + 1) * 10,
      });
    }
  }
  const provider = new CountingProvider(new StaticProvider({ 'X|1h': chart, 'X|1m': ltf }));
  const src = `//@version=6
indicator("ltf")
v = request.security_lower_tf(syminfo.tickerid, "1", volume)
plot(array.size(v), "n")
plot(array.size(v) > 0 ? array.sum(v) : na, "vsum")`;

  const report = await scan({
    source: src,
    symbols: ['X'],
    timeframe: '1h',
    provider,
    rank: 'last(n)',
    runner: new LocalRunner(),
  });
  expect(report.errors).toHaveLength(0);
  const n = report.results[0]!.plots.find((p) => p.title === 'n')!.data;
  const vsum = report.results[0]!.plots.find((p) => p.title === 'vsum')!.data;
  expect(n).toEqual([4, 4]);
  expect(vsum).toEqual([100, 260]);
  expect(provider.calls).toContain('X@1m'); // fetched a finer TF for the intrabars
});

// ── self plain request.security to a HIGHER tf (real fetch, not resample) ──
test('self request.security to a higher tf uses the FETCHED series, not a resample of chart bars', async () => {
  // Chart: BTC 1h, 48 bars (2 UTC days) at ~100. A DISTINCT daily series (5000 / 6000) is served
  // under `BTC|1d`; resampling the 1h bars could never yield those, so seeing 5000/6000 proves the
  // real daily series was fetched and injected. request.security("D") is HIGHER than the 1h chart.
  const daily: Bar[] = [
    { time: DAY1, open: 5000, high: 5000, low: 5000, close: 5000, volume: 1 },
    { time: DAY1 + 86400, open: 6000, high: 6000, low: 6000, close: 6000, volume: 1 },
  ];
  const provider = new StaticProvider({ BTC: hourly(48, 100) }).set('BTC|1d', daily);
  const src = `//@version=6
indicator("x")
d = request.security(syminfo.tickerid, "D", close)
plot(d, "d")`;

  const report = await scan({
    source: src,
    symbols: ['BTC'],
    timeframe: '1h',
    provider,
    rank: 'last(d)',
    runner: new LocalRunner(),
  });
  expect(report.errors).toHaveLength(0);
  const d = report.results[0]!.plots.find((p) => p.title === 'd')!.data;
  // close-time alignment: day-0's daily bar closes at the end of day 0 (bar 23's close), so its
  // value appears on bar 23 — not one bar later — and day-1's on the final bar. No 1h-of-daily leak.
  expect(Number.isNaN(d[22]!)).toBe(true); // before day 0's daily bar has closed
  expect(d[23]).toBe(5000); // day 0's daily close, on the last 1h bar of day 0
  expect(d[47]).toBe(6000); // day 1's daily close, on the last 1h bar of day 1
});

test('without security resolution the self higher-tf request degrades (resamples the chart, not 5000)', async () => {
  const daily: Bar[] = [
    { time: DAY1, open: 5000, high: 5000, low: 5000, close: 5000, volume: 1 },
    { time: DAY1 + 86400, open: 6000, high: 6000, low: 6000, close: 6000, volume: 1 },
  ];
  const provider = new StaticProvider({ BTC: hourly(48, 100) }).set('BTC|1d', daily);
  const src = `//@version=6\nindicator("x")\nd = request.security(syminfo.tickerid, "D", close)\nplot(d, "d")`;
  const report = await scan({
    source: src,
    symbols: ['BTC'],
    timeframe: '1h',
    provider,
    rank: 'count(d)',
    resolveSecurity: false,
    runner: new LocalRunner(),
  });
  const d = report.results[0]!.plots.find((p) => p.title === 'd')!.data;
  expect(d.some((v) => v === 5000 || v === 6000)).toBe(false); // never sees the real daily series
});

// ── unit helpers ─────────────────────────────────────────────
test('resolveLowerFetchTf picks a finer TF or null at the floor', () => {
  expect(resolveLowerFetchTf('1', '1h')).toBe('1m');
  expect(resolveLowerFetchTf('5', '1h')).toBe('5m');
  expect(resolveLowerFetchTf('60', '1d')).toBe('1h');
  expect(resolveLowerFetchTf('1', '1m')).toBeNull(); // chart already finest
});

test('classifyRequests splits self / cross / lower_tf; self plain non-chart TF is fetched', () => {
  const cls = classifyRequests(
    [
      { symbol: PROBE_SYMBOL, timeframe: 'D', lowerTf: false }, // self plain, HIGHER than 1h → fetch
      { symbol: PROBE_SYMBOL, timeframe: '60', lowerTf: false }, // self plain, == chart → no fetch
      { symbol: 'AAPL', timeframe: 'D', lowerTf: false }, // cross HTF
      { symbol: 'AAPL', timeframe: 'D', lowerTf: false }, // dup
      { symbol: PROBE_SYMBOL, timeframe: '1', lowerTf: true }, // self lower_tf
      { symbol: 'MSFT', timeframe: '5', lowerTf: true }, // cross lower_tf
    ],
    '1h',
  );
  expect(cls.crossHtf).toEqual(['AAPL']);
  expect(cls.crossPlain).toEqual([{ symbol: 'AAPL', rawTf: 'D' }]);
  expect(cls.crossLtf).toEqual([{ symbol: 'MSFT', rawTf: '5' }]);
  expect(cls.selfLtfRawTfs).toEqual(['1']);
  expect(cls.selfPlainRawTfs).toEqual(['D']); // 'D' fetched; the identity '60' request is skipped
});

test('jobHash is sensitive to injected securityBars', () => {
  const bars = hourly(10, 100);
  const base = { source: 'x', symbol: 'BTC', timeframe: '60', bars };
  const a = jobHash(base);
  const b = jobHash({ ...base, securityBars: { AAPL: hourly(10, 200) } });
  expect(a).not.toBe(b);
});

// ── Stage 2: static compile-time discovery ───────────────────
import {
  assertResolvedSecurityForBarMagnifier,
  assertStaticSecurityForBarMagnifier,
  resolveSecurity,
  planFromStatic,
} from '../src/index.js';

test('planFromStatic classifies without a run; null when dynamic', () => {
  const empty = {
    crossHtf: [],
    crossPlain: [],
    crossLtf: [],
    selfLtfRawTfs: [],
    selfPlainRawTfs: [],
  };
  expect(planFromStatic([], '1h')).toEqual(empty);
  expect(
    planFromStatic(
      [{ lowerTf: false, self: false, symbol: 'AAPL', timeframe: 'D', dynamic: false }],
      '1h',
    ),
  ).toEqual({
    ...empty,
    crossHtf: ['AAPL'],
    crossPlain: [{ symbol: 'AAPL', rawTf: 'D' }],
  });
  expect(
    planFromStatic(
      [{ lowerTf: true, self: true, symbol: null, timeframe: '1', dynamic: false }],
      '1h',
    ),
  ).toEqual({ ...empty, selfLtfRawTfs: ['1'] });
  expect(
    planFromStatic(
      [{ lowerTf: true, self: false, symbol: 'MSFT', timeframe: '5', dynamic: false }],
      '1h',
    ),
  ).toEqual({ ...empty, crossLtf: [{ symbol: 'MSFT', rawTf: '5' }] });
  // self plain to a HIGHER-than-chart TF → fetched (real series beats resampling)
  expect(
    planFromStatic(
      [{ lowerTf: false, self: true, symbol: null, timeframe: 'D', dynamic: false }],
      '1h',
    ),
  ).toEqual({ ...empty, selfPlainRawTfs: ['D'] });
  // self plain at the chart's own TF → no fetch (piner passes it through)
  expect(
    planFromStatic(
      [{ lowerTf: false, self: true, symbol: null, timeframe: '60', dynamic: false }],
      '1h',
    ),
  ).toEqual(empty);
  // any dynamic → needs discovery
  expect(
    planFromStatic(
      [{ lowerTf: false, self: false, symbol: 'AAPL', timeframe: null, dynamic: true }],
      '1h',
    ),
  ).toBeNull();
});

test('no request.security → no discovery run, no fetch', async () => {
  const provider = new CountingProvider(new StaticProvider({ BTC: hourly(48, 100) }));
  const jobs = [
    {
      source: '//@version=6\nindicator("x")\nplot(close)',
      symbol: 'BTC',
      timeframe: '60',
      bars: hourly(48, 100),
    },
  ];
  const r = await resolveSecurity(jobs[0]!.source, jobs, '1h', '60', provider, { concurrency: 4 });
  expect(r.discovered).toBe(false);
  expect(provider.calls).toHaveLength(0);
  expect(jobs[0]!.securityBars).toBeUndefined();
});

test('static cross-symbol resolves WITHOUT a discovery run', async () => {
  const src = '//@version=6\nindicator("x")\nplot(request.security("AAPL", "D", close))';
  const provider = new CountingProvider(
    new StaticProvider({ BTC: hourly(48, 100), AAPL: hourly(48, 200) }),
  );
  const jobs = [{ source: src, symbol: 'BTC', timeframe: '60', bars: hourly(48, 100) }];
  const r = await resolveSecurity(src, jobs, '1h', '60', provider, { concurrency: 4 });
  expect(r.discovered).toBe(false); // static plan — no discovery run
  expect(jobs[0]!.securityBars?.AAPL).toBeDefined();
  expect(provider.calls.some((c) => c.startsWith('AAPL@'))).toBe(true);
});

// piner 0.4.0+ resolves `timeframe.period` statically — it IS the chart timeframe,
// reported via the dependency's `tfSelf` flag rather than as `dynamic`. So no
// discovery run is needed; the cross-symbol bars are still fetched at the chart TF
// and injected. (Before 0.4.0 this was flagged dynamic and forced a discovery run.)
test('timeframe.period resolves statically (no discovery run) and still resolves', async () => {
  const src =
    '//@version=6\nindicator("x")\nplot(request.security("AAPL", timeframe.period, close))';
  const provider = new CountingProvider(
    new StaticProvider({ BTC: hourly(48, 100), AAPL: hourly(48, 200) }),
  );
  const jobs = [{ source: src, symbol: 'BTC', timeframe: '60', bars: hourly(48, 100) }];
  const r = await resolveSecurity(src, jobs, '1h', '60', provider, { concurrency: 4 });
  expect(r.discovered).toBe(false); // static plan — timeframe.period is the chart TF
  expect(jobs[0]!.securityBars?.AAPL).toBeDefined();
  expect(provider.calls.some((c) => c.startsWith('AAPL@'))).toBe(true);
});

// A genuinely dynamic argument (here the timeframe from input.string, only known at
// runtime) can't be planned statically, so scan falls back to a one-off discovery
// run under the sentinel symbol; the request still resolves.
test('a dynamic timeframe falls back to a discovery run and still resolves', async () => {
  const src =
    '//@version=6\nindicator("x")\ntf = input.string("D", "tf")\nplot(request.security("AAPL", tf, close))';
  const provider = new CountingProvider(
    new StaticProvider({ BTC: hourly(48, 100), AAPL: hourly(48, 200) }),
  );
  const jobs = [{ source: src, symbol: 'BTC', timeframe: '60', bars: hourly(48, 100) }];
  const r = await resolveSecurity(src, jobs, '1h', '60', provider, { concurrency: 4 });
  expect(r.discovered).toBe(true); // dynamic tf → discovery run
  expect(jobs[0]!.securityBars?.AAPL).toBeDefined();
});

// ── Bar Magnifier exact-v1 static identity gate ─────────────────────────────
test('exact compiler metadata fails closed before provider I/O while lower_tf null lookahead is valid', async () => {
  const source = `//@version=6
strategy("metadata gate")
plot(request.security("AAPL", "D", close))`;
  const base = compilerDependencies(source)[0]! as SecurityDependency & {
    lookahead: boolean | null;
    expressionPriorBars: number | null;
  };
  const { lookahead: _lookahead, expressionPriorBars: _history, ...withoutMetadata } = base;
  const cases: Array<{ code: string; dependency: SecurityDependency }> = [
    {
      code: 'static-security-compiler-metadata-unavailable',
      dependency: withoutMetadata as SecurityDependency,
    },
    {
      code: 'dynamic-security-unsupported-with-bar-magnifier',
      dependency: { ...base, lookahead: null } as SecurityDependency,
    },
    {
      code: 'static-security-expression-history-unbounded',
      dependency: { ...base, expressionPriorBars: null } as SecurityDependency,
    },
    {
      code: 'static-security-expression-history-invalid',
      dependency: { ...base, expressionPriorBars: -1 } as SecurityDependency,
    },
    {
      code: 'static-security-expression-history-invalid',
      dependency: { ...base, expressionPriorBars: 1.5 } as SecurityDependency,
    },
  ];

  let providerIo = 0;
  const provider: HistoryProvider = {
    id: 'metadata-gate-must-not-resolve',
    async history() {
      providerIo++;
      return [];
    },
    async resolveHistorySource() {
      providerIo++;
      throw new Error('provider I/O must not begin');
    },
  };
  for (const testCase of cases) {
    const job: Job = {
      source,
      symbol: 'BTC',
      timeframe: '60',
      bars: hourly(2, 100),
    };
    await expect(
      resolveSecurity(source, [job], '1h', '60', provider, {
        concurrency: 1,
        range: { from: DAY1, to: DAY1 + 2 * 3_600 - 1 },
        barMagnifierRequested: true,
        staticDependencies: [testCase.dependency],
      }),
      testCase.code,
    ).rejects.toMatchObject({
      type: 'bar-magnifier-error',
      kind: 'unsupported',
      code: testCase.code,
      permanent: true,
    });
  }
  expect(providerIo).toBe(0);

  const lowerSource = `//@version=6
strategy("lower metadata")
values = request.security_lower_tf("AAPL", "10", close)
plot(array.size(values))`;
  expect(() =>
    assertStaticSecurityForBarMagnifier(lowerSource, compilerDependencies(lowerSource)),
  ).not.toThrow();
});

test('static security dependencies, including static lookahead, remain supported in exact mode', async () => {
  const src = `//@version=6
strategy("static")
la = barmerge.lookahead_on
plot(request.security("AAPL", "D", close, lookahead=la))`;
  const deps = compilerDependencies(src);
  expect(() => assertStaticSecurityForBarMagnifier(src, deps)).not.toThrow();

  const provider = new StaticProvider(
    {
      'BTC|1h': hourly(48, 100),
      'AAPL|1h': spacedBars(96, 3_600, 200, DAY1 - 2 * 86_400),
    },
    { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'static-security' },
  );
  const jobs = [{ source: src, symbol: 'BTC', timeframe: '60', bars: hourly(48, 100) }];
  const result = await resolveSecurity(src, jobs, '1h', '60', provider, {
    concurrency: 2,
    range: { from: DAY1, to: DAY1 + 48 * 3600 - 1 },
    barMagnifierRequested: true,
    staticDependencies: deps,
  });
  expect(result.discovered).toBe(false);
  expect(jobs[0]!.securityBars?.AAPL).toBeDefined();
  expect(jobs[0]!.securityProofs?.AAPL).toMatchObject({
    targetCanonicalTf: '60m',
    complete: true,
    gaps: [],
  });
});

test('execution gate rejects missing or unbound static-security proofs before piner runs', async () => {
  const source = `//@version=6
strategy("static")
plot(request.security("AAPL", "D", close))`;
  const dependencies = compilerDependencies(source);
  const chart = hourly(2, 100);
  const firstOpenMs = chart[0]!.time * 1000;
  const finalCloseMs = (chart.at(-1)!.time + 3600) * 1000;
  const magnifier = {
    contractVersion: 1,
    mappingVersion: 1,
    requestedSymbol: 'BTC',
    targetPineTf: '10',
    targetCanonicalTf: '10m',
    sourceCanonicalTf: '10m',
    barsMs: [],
    chartOpenTimesMs: chart.map((bar) => bar.time * 1000),
    chartCloseTimesMs: chart.map((bar) => (bar.time + 3600) * 1000),
    chartIntervalSource: 'utc-fixed',
    coverage: {
      requested: { from: firstOpenMs, to: finalCloseMs },
      covered: [{ from: firstOpenMs, to: finalCloseMs }],
      gaps: [],
      complete: true,
    },
    provenance: {
      cacheIdentity: 'fixture',
      normalizedSymbol: 'BTC',
      sourceTimeframe: '10m',
      targetTimeframe: '10m',
      alignment: 'utc-24x7',
      aggregationVersion: 0,
    },
    acquisitionKey: 'fixture',
  } as ResolvedMagnifierDataset;
  const job: Job = {
    source,
    symbol: 'BTC',
    timeframe: '60',
    bars: chart,
    magnifier,
  };

  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, job)).toThrow(
    'cannot execute until every static request.security dataset is resolved',
  );
  try {
    assertResolvedSecurityForBarMagnifier(source, dependencies, job);
    throw new Error('expected unresolved static dataset rejection');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'unresolved-static-security-with-bar-magnifier',
      permanent: true,
    });
  }

  expect(() =>
    assertResolvedSecurityForBarMagnifier(source, dependencies, {
      ...job,
      securityBars: { AAPL: hourly(2, 200) },
    }),
  ).toThrow('matching immutable proof');

  const requiredFrom = DAY1 - 2 * 86_400;
  const dependencyBars = Array.from({ length: 50 }, (_, index) => {
    const value = 200 + index;
    return {
      time: requiredFrom + index * 3600,
      open: value,
      high: value + 1,
      low: value - 1,
      close: value,
      volume: 1000,
    };
  });
  const provider = new StaticProvider(
    { 'AAPL|1h': dependencyBars },
    { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'proof-fixture' },
  );
  await resolveSecurity(source, [job], '1h', '60', provider, {
    concurrency: 1,
    range: { from: requiredFrom, to: DAY1 + 2 * 3600 - 1 },
    barMagnifierRequested: true,
    staticDependencies: dependencies,
  });
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, job)).not.toThrow();

  const resolvedBars = job.securityBars!.AAPL!;
  const resolvedProof = job.securityProofs!.AAPL!;
  const empty = immutableBarsFixture([]);
  const sparse = immutableBarsFixture(
    resolvedBars.filter((_, index) => index !== Math.floor(resolvedBars.length / 2)),
  );
  const misaligned = immutableBarsFixture(
    resolvedBars.map((bar, index) => (index === 0 ? { ...bar, time: bar.time + 60 } : bar)),
  );
  const wrongRange = deepFreezeFixture({
    from: resolvedProof.requested.from + 3_600,
    to: resolvedProof.requested.to,
  }) as ResolvedSecurityDatasetProof['requested'];
  const attacks: Array<{
    label: string;
    bars: Bar[];
    proof: ResolvedSecurityDatasetProof;
  }> = [
    {
      label: 'empty forged coverage',
      bars: empty,
      proof: reboundSecurityProof(resolvedProof, empty),
    },
    {
      label: 'sparse internal hole',
      bars: sparse,
      proof: reboundSecurityProof(resolvedProof, sparse),
    },
    {
      label: 'misaligned bar',
      bars: misaligned,
      proof: reboundSecurityProof(resolvedProof, misaligned),
    },
    {
      label: 'wrong requested range',
      bars: resolvedBars,
      proof: reboundSecurityProof(resolvedProof, resolvedBars, { requested: wrongRange }),
    },
    {
      label: 'tampered bound proof',
      bars: resolvedBars,
      proof: reboundSecurityProof(
        resolvedProof,
        resolvedBars,
        { requestedSymbol: 'FORGED' },
        false,
      ),
    },
  ];
  for (const attack of attacks) {
    expect(
      () =>
        assertResolvedSecurityForBarMagnifier(source, dependencies, {
          ...job,
          securityBars: { AAPL: attack.bars },
          securityProofs: { AAPL: attack.proof },
        }),
      attack.label,
    ).toThrow('complete bar-derived coverage');
  }

  job.securityBars = {
    AAPL: job.securityBars!.AAPL!.map((bar, index) =>
      index === 0 ? { ...bar, close: 999 } : { ...bar },
    ),
  };
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, job)).toThrow(
    'matching immutable proof',
  );
});

test('bar-derived proof preserves legitimate exchange-calendar closures', async () => {
  const friday = DAY1;
  const monday = DAY1 + 3 * 86_400;
  const calendar = deepFreezeFixture({
    calendarId: 'XNYS-test',
    version: '2026a',
    coverage: { from: friday, to: monday + 3_600 },
    sessions: [
      { from: friday, to: friday + 3_600 },
      { from: monday, to: monday + 3_600 },
    ],
  }) as HistorySessionCalendar;
  const chart = [spacedBars(1, 3_600, 100, friday)[0]!, spacedBars(1, 3_600, 101, monday)[0]!];
  const source = `//@version=6
strategy("closed sessions")
plot(request.security("AAPL", timeframe.period, close))`;
  const dependencies = compilerDependencies(source);
  const provider = new StaticProvider(
    { 'AAPL|1h': [spacedBars(1, 3_600, 200, friday)[0]!, spacedBars(1, 3_600, 201, monday)[0]!] },
    {
      alignment: 'exchange-calendar',
      calendar,
      timeframes: ['1h'],
      cacheIdentity: 'closed-session-proof',
    },
  );
  const job: Job = {
    source,
    symbol: 'BTC',
    timeframe: '60',
    bars: chart,
    magnifier: {
      contractVersion: 1,
      mappingVersion: 1,
      requestedSymbol: 'BTC',
      targetPineTf: '10',
      targetCanonicalTf: '10m',
      sourceCanonicalTf: '10m',
      barsMs: [],
      chartOpenTimesMs: chart.map((bar) => bar.time * 1_000),
      chartCloseTimesMs: chart.map((bar) => (bar.time + 3_600) * 1_000),
      chartIntervalSource: 'provider-calendar',
      coverage: {
        requested: { from: friday * 1_000, to: (monday + 3_600) * 1_000 },
        covered: [{ from: friday * 1_000, to: (monday + 3_600) * 1_000 }],
        gaps: [],
        complete: true,
      },
      provenance: {
        cacheIdentity: 'fixture',
        normalizedSymbol: 'BTC',
        sourceTimeframe: '10m',
        targetTimeframe: '10m',
        alignment: 'exchange-calendar:XNYS-test@2026a',
        aggregationVersion: 0,
      },
      acquisitionKey: 'fixture',
    } as ResolvedMagnifierDataset,
  };

  await resolveSecurity(source, [job], '1h', '60', provider, {
    concurrency: 1,
    range: { from: friday, to: monday + 3_600 - 1 },
    barMagnifierRequested: true,
    staticDependencies: dependencies,
  });

  expect(job.securityProofs?.AAPL).toMatchObject({
    complete: true,
    covered: [{ from: friday, to: monday + 3_600 }],
    alignmentEvidence: {
      kind: 'exchange-calendar',
      calendar: { calendarId: 'XNYS-test', version: '2026a' },
    },
  });
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, job)).not.toThrow();

  // A caller can recompute every public digest, but cannot turn a fabricated
  // all-closed calendar into resolver-issued evidence. This is the attack that
  // freezing plus an unkeyed acquisition digest alone cannot distinguish.
  const resolvedProof = job.securityProofs!.AAPL!;
  const empty = immutableBarsFixture([]);
  const forgedCalendar = deepFreezeFixture({
    calendarId: 'FORGED-all-closed',
    version: 'caller-v1',
    coverage: { ...resolvedProof.requested },
    sessions: [],
  }) as HistorySessionCalendar;
  const forgedProof = reboundSecurityProof(resolvedProof, empty, {
    covered: deepFreezeFixture([{ ...resolvedProof.requested }]),
    gaps: deepFreezeFixture([]),
    complete: true,
    provenance: deepFreezeFixture({
      ...resolvedProof.provenance,
      alignment: 'exchange-calendar:FORGED-all-closed@caller-v1',
    }),
    alignmentEvidence: deepFreezeFixture({
      kind: 'exchange-calendar',
      calendar: forgedCalendar,
    }),
  });
  try {
    assertResolvedSecurityForBarMagnifier(source, dependencies, {
      ...job,
      securityBars: { AAPL: empty },
      securityProofs: { AAPL: forgedProof },
    });
    throw new Error('expected forged calendar authority rejection');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'unresolved-static-security-with-bar-magnifier',
      permanent: true,
      details: {
        invalid: [
          expect.objectContaining({ reasons: expect.arrayContaining(['resolver-authentication']) }),
        ],
      },
    });
  }
});

test('every runtime-dynamic symbol/timeframe/lookahead identity is rejected with one typed code', () => {
  const dynamicSources = [
    `//@version=6
strategy("dynamic symbol")
sym = input.string("AAPL", "sym")
plot(request.security(sym, "D", close))`,
    `//@version=6
strategy("dynamic timeframe")
tf = input.string("D", "tf")
plot(request.security("AAPL", tf, close))`,
    `//@version=6
strategy("dynamic lower symbol")
sym = input.string("AAPL", "sym")
a = request.security_lower_tf(sym, "1", close)
plot(array.size(a))`,
    `//@version=6
strategy("dynamic lower timeframe")
tf = input.string("1", "tf")
a = request.security_lower_tf(syminfo.tickerid, tf, close)
plot(array.size(a))`,
    `//@version=6
strategy("dynamic lookahead")
future = input.bool(false, "future")
la = future ? barmerge.lookahead_on : barmerge.lookahead_off
plot(request.security("AAPL", "D", close, lookahead=la))`,
    `//@version=6
strategy("udf parameter shadows global")
la = barmerge.lookahead_off
pick(la) => request.security("AAPL", "D", close, lookahead=la)
plot(pick(input.bool(false, "future")))`,
    `//@version=6
strategy("block local shadows global")
la = barmerge.lookahead_off
if bar_index > 0
    la = input.bool(false, "future") ? barmerge.lookahead_on : barmerge.lookahead_off
    plot(request.security("AAPL", "D", close, lookahead=la))`,
    `//@version=6
strategy("later reassignment")
la = barmerge.lookahead_off
plot(request.security("AAPL", "D", close, lookahead=la))
la := input.bool(false, "future") ? barmerge.lookahead_on : barmerge.lookahead_off`,
    `//@version=6
strategy("series ternary")
la = close > open ? barmerge.lookahead_on : barmerge.lookahead_off
plot(request.security("AAPL", "D", close, lookahead=la))`,
  ];

  for (const [sourceIndex, source] of dynamicSources.entries()) {
    const deps = compilerDependencies(source, sourceIndex >= 4 ? [{ lookahead: null }] : []);
    try {
      assertStaticSecurityForBarMagnifier(source, deps);
      throw new Error('expected dynamic identity rejection');
    } catch (error) {
      expect(error).toMatchObject({
        type: 'bar-magnifier-error',
        kind: 'unsupported',
        code: 'dynamic-security-unsupported-with-bar-magnifier',
        permanent: true,
      });
    }
  }
});

test('scope-aware lookahead accepts a proven unreassigned global-constant chain', () => {
  const source = `//@version=6
strategy("safe global lookahead")
base = barmerge.lookahead_off
alias = base
la = true ? alias : barmerge.lookahead_on
plot(request.security("AAPL", "D", close, lookahead=la))`;
  const deps = compilerDependencies(source);
  expect(() => assertStaticSecurityForBarMagnifier(source, deps)).not.toThrow();
});

test('exact security resolution rejects dynamics before provider I/O while legacy discovery is unchanged', async () => {
  const src = `//@version=6
strategy("dynamic")
tf = input.string("D", "tf")
plot(request.security("AAPL", tf, close))`;
  const provider = new CountingProvider(
    new StaticProvider({ BTC: hourly(48, 100), AAPL: hourly(48, 200) }),
  );
  const jobs = [{ source: src, symbol: 'BTC', timeframe: '60', bars: hourly(48, 100) }];
  const dependencies = compilerDependencies(src);
  await expect(
    resolveSecurity(src, jobs, '1h', '60', provider, {
      concurrency: 2,
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    }),
  ).rejects.toMatchObject({ code: 'dynamic-security-unsupported-with-bar-magnifier' });
  expect(provider.calls).toHaveLength(0);
});

test('cross-symbol plain lower timeframe is preserved in planning and rejected only in exact mode', async () => {
  const source = `//@version=6
strategy("cross lower")
plot(request.security("AAPL", "5", close))`;
  const dependencies = compilerDependencies(source);
  expect(planFromStatic(dependencies, '1h')?.crossPlain).toEqual([{ symbol: 'AAPL', rawTf: '5' }]);

  let exactIo = 0;
  const exactProvider: HistoryProvider = {
    id: 'must-not-acquire-cross-lower',
    async history() {
      exactIo++;
      return [];
    },
    async resolveHistorySource() {
      exactIo++;
      throw new Error('exact provider I/O must not start');
    },
  };
  const exactJob: Job = {
    source,
    symbol: 'BTC',
    timeframe: '60',
    bars: hourly(2, 100),
  };
  await expect(
    resolveSecurity(source, [exactJob], '1h', '60', exactProvider, {
      concurrency: 1,
      range: { from: DAY1, to: DAY1 + 2 * 3_600 - 1 },
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    }),
  ).rejects.toMatchObject({
    type: 'bar-magnifier-error',
    kind: 'unsupported',
    code: 'cross-symbol-plain-lower-timeframe-unsupported',
    permanent: true,
    details: expect.objectContaining({ requestedCanonicalTf: '5m', chartCanonicalTf: '60m' }),
  });
  expect(exactIo).toBe(0);

  const legacyProvider = new CountingProvider(
    new StaticProvider({ AAPL: hourly(2, 200), BTC: hourly(2, 100) }),
  );
  const legacyJob: Job = { ...exactJob, bars: hourly(2, 100) };
  await resolveSecurity(source, [legacyJob], '1h', '60', legacyProvider, { concurrency: 1 });
  expect(legacyProvider.calls).toContain('AAPL@1h');
  expect(legacyJob.securityBars?.AAPL).toBeDefined();
});

test('exact static security rejects a nonempty partial dependency before execution', async () => {
  const source = `//@version=6
strategy("partial")
plot(request.security("AAPL", "D", close))`;
  const dependencies = compilerDependencies(source);
  const provider = new StaticProvider(
    { 'AAPL|1h': hourly(1, 200) },
    { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'partial-proof' },
  );
  const job: Job = {
    source,
    symbol: 'BTC',
    timeframe: '60',
    bars: hourly(48, 100),
  };

  await expect(
    resolveSecurity(source, [job], '1h', '60', provider, {
      concurrency: 1,
      range: { from: DAY1, to: DAY1 + 48 * 3600 - 1 },
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    }),
  ).rejects.toMatchObject({
    type: 'exact-history-error',
    kind: 'provider-limited',
    code: 'incomplete-required-coverage',
    permanent: true,
  });
  expect(job.securityBars).toBeUndefined();
  expect(job.securityProofs).toBeUndefined();
});

function spacedBars(count: number, step: number, base: number, start = DAY1): Bar[] {
  return Array.from({ length: count }, (_, index) => {
    const value = base + index;
    return {
      time: start + index * step,
      open: value,
      high: value + 1,
      low: value - 1,
      close: value + 0.25,
      volume: 1_000 + index,
    };
  });
}

test('exact static security resolves complete cross-symbol and lower-tf identities with proofs', async () => {
  const source = `//@version=6
strategy("complete identities")
d = request.security("AAPL", "D", close)
cross = request.security_lower_tf("MSFT", "10", close)
self = request.security_lower_tf(syminfo.tickerid, "5", close)
plot(d)
plot(array.size(cross))
plot(array.size(self))`;
  const dependencies = compilerDependencies(source);
  const provider = new StaticProvider(
    {
      'AAPL|1h': spacedBars(96, 3_600, 200, DAY1 - 2 * 86_400),
      'MSFT|10m': spacedBars(48 * 6, 600, 300),
      'BTC|5m': spacedBars(48 * 12, 300, 400),
    },
    {
      alignment: 'utc-24x7',
      timeframes: ['5m', '10m', '1h'],
      cacheIdentity: 'complete-static-identities',
    },
  );
  const job: Job = {
    source,
    symbol: 'BTC',
    timeframe: '60',
    bars: hourly(48, 100),
  };

  await resolveSecurity(source, [job], '1h', '60', provider, {
    concurrency: 3,
    range: { from: DAY1, to: DAY1 + 48 * 3_600 - 1 },
    barMagnifierRequested: true,
    staticDependencies: dependencies,
  });

  expect(Object.keys(job.securityBars ?? {}).sort()).toEqual(['AAPL', 'BTC@5', 'MSFT@10']);
  expect(job.securityProofs?.AAPL).toMatchObject({
    requestedSymbol: 'AAPL',
    requestedCanonicalTfs: ['1d'],
    targetCanonicalTf: '60m',
    complete: true,
    gaps: [],
    alignmentEvidence: { kind: 'utc-24x7' },
    acquisitionKey: expect.stringContaining('security-dataset-acquisition-v2:'),
  });
  expect(job.securityProofs?.['MSFT@10']).toMatchObject({
    requestedSymbol: 'MSFT',
    requestedCanonicalTfs: ['10m'],
    targetCanonicalTf: '10m',
    complete: true,
    gaps: [],
  });
  expect(job.securityProofs?.['BTC@5']).toMatchObject({
    requestedSymbol: 'BTC',
    requestedCanonicalTfs: ['5m'],
    targetCanonicalTf: '5m',
    complete: true,
    gaps: [],
  });

  const wire = toWireJob(job, new Set(), 'a'.repeat(64)).wire;
  expect(Object.keys(wire.securityProofAuthenticators ?? {}).sort()).toEqual([
    'AAPL',
    'BTC@5',
    'MSFT@10',
  ]);
  expect(wire.securityProofAuthenticators?.AAPL).toMatch(
    /^security-proof-wire-auth-v1:[0-9a-f]{64}$/,
  );

  // Resolver authority changes executability and therefore participates in the
  // memo key even when a caller clones every enumerable proof field verbatim.
  const clonedProofs = JSON.parse(JSON.stringify(job.securityProofs)) as Job['securityProofs'];
  expect(jobHash({ ...job, securityProofs: clonedProofs })).not.toBe(jobHash(job));
});

test('post-inline dependency order, repeats, and lower_tf interleaving stay bound to exact proof identities', async () => {
  const day = 86_400;
  const source = `//@version=6
strategy("emitted dependency identity")
f(value, la) => request.security("B", "D", value, lookahead=la)
c = request.security("C", "D", close)
l = request.security_lower_tf("L", "10", close[1])
bOn = f(close[3], barmerge.lookahead_on)
bOff = f(close[2], barmerge.lookahead_off)
plot(c + bOn + bOff + array.size(l))`;
  const dependencies = compilerDependencies(source, [
    { lookahead: false, expressionPriorBars: 0 },
    { lookahead: null, expressionPriorBars: 1 },
    { lookahead: true, expressionPriorBars: 3 },
    { lookahead: false, expressionPriorBars: 2 },
  ]);
  expect(dependencies.map((dependency) => dependency.symbol)).toEqual(['C', 'L', 'B', 'B']);

  const chart = hourly(2, 100);
  const finalChartClose = DAY1 + 2 * 3_600;
  const provider = new StaticProvider(
    {
      'B|1h': spacedBars(6 * 24, 3_600, 200, DAY1 - 5 * day),
      'C|1h': spacedBars(50, 3_600, 300, DAY1 - 2 * day),
      'L|10m': spacedBars(13, 600, 400, DAY1 - 600),
    },
    {
      alignment: 'utc-24x7',
      timeframes: ['10m', '1h'],
      cacheIdentity: 'emitted-dependency-identity',
    },
  );
  const job: Job = {
    source,
    symbol: 'A',
    timeframe: '60',
    bars: chart,
    magnifier: {
      chartCloseTimesMs: [finalChartClose * 1_000],
    } as ResolvedMagnifierDataset,
  };

  await resolveSecurity(source, [job], '1h', '60', provider, {
    concurrency: 3,
    range: { from: DAY1 - 5 * day, to: finalChartClose - 1 },
    barMagnifierRequested: true,
    staticDependencies: dependencies,
  });

  expect(job.securityProofs?.C).toMatchObject({
    dependencies: [
      {
        dependencyIndex: 0,
        requestedCanonicalTf: '1d',
        lookahead: false,
        expressionPriorBars: 0,
        baseMappingPriorBars: 2,
        totalRequiredPriorTargetBars: 2,
      },
    ],
    requested: { from: DAY1 - 2 * day, to: finalChartClose },
  });
  expect(job.securityProofs?.['L@10']).toMatchObject({
    dependencies: [
      {
        dependencyIndex: 1,
        requestedCanonicalTf: '10m',
        lookahead: null,
        expressionPriorBars: 1,
        baseMappingPriorBars: 0,
        totalRequiredPriorTargetBars: 1,
      },
    ],
    requested: { from: DAY1 - 600, to: finalChartClose },
  });
  expect(job.securityProofs?.B).toMatchObject({
    dependencies: [
      {
        dependencyIndex: 2,
        requestedCanonicalTf: '1d',
        lookahead: true,
        expressionPriorBars: 3,
        baseMappingPriorBars: 2,
        totalRequiredPriorTargetBars: 5,
      },
      {
        dependencyIndex: 3,
        requestedCanonicalTf: '1d',
        lookahead: false,
        expressionPriorBars: 2,
        baseMappingPriorBars: 2,
        totalRequiredPriorTargetBars: 4,
      },
    ],
    requested: { from: DAY1 - 5 * day, to: DAY1 + day },
  });
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, job)).not.toThrow();

  const bars = job.securityBars!.B!;
  const proof = job.securityProofs!.B!;
  const forgedWarmupDependencies = deepFreezeFixture(
    proof.dependencies.map((dependency, index) =>
      index === 0
        ? {
            ...dependency,
            expressionPriorBars: dependency.expressionPriorBars + 1,
            totalRequiredPriorTargetBars: dependency.totalRequiredPriorTargetBars + 1,
          }
        : { ...dependency },
    ),
  );
  const forgedLookaheadDependencies = deepFreezeFixture(
    proof.dependencies.map((dependency, index) =>
      index === 0 ? { ...dependency, lookahead: false } : { ...dependency },
    ),
  );
  for (const [label, forgedDependencies] of [
    ['warmup', forgedWarmupDependencies],
    ['lookahead', forgedLookaheadDependencies],
  ] as const) {
    const forged = reboundSecurityProof(proof, bars, { dependencies: forgedDependencies });
    expect(forged.acquisitionKey, label).not.toBe(proof.acquisitionKey);
    expect(
      jobHash({
        ...job,
        magnifier: undefined,
        securityProofs: { ...job.securityProofs, B: forged },
      }),
      label,
    ).not.toBe(jobHash({ ...job, magnifier: undefined }));
    try {
      assertResolvedSecurityForBarMagnifier(source, dependencies, {
        ...job,
        securityProofs: { ...job.securityProofs, B: forged },
      });
      throw new Error(`expected forged ${label} identity rejection`);
    } catch (error) {
      expect(error, label).toMatchObject({
        code: 'unresolved-static-security-with-bar-magnifier',
        permanent: true,
        details: {
          invalid: [
            expect.objectContaining({
              key: 'B',
              reasons: expect.arrayContaining(['dependency-identity']),
            }),
          ],
        },
      });
    }
  }
});

test('exact cross-symbol planning retains every higher requested timeframe on one injected source', async () => {
  const source = `//@version=6
strategy("multiple cross timeframes")
d = request.security("AAPL", "D", close)
twoDays = request.security("AAPL", "2D", close)
plot(d + twoDays)`;
  const dependencies = compilerDependencies(source);
  const range = securityRangeForBarMagnifier(DAY1, DAY1 + 48 * 3_600, '1h', dependencies);
  const sourceBars = (range.to! + 1 - range.from) / 3_600;
  const provider = new StaticProvider(
    { 'AAPL|1h': spacedBars(sourceBars, 3_600, 200, range.from) },
    { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'multi-cross-tf' },
  );
  const job: Job = {
    source,
    symbol: 'BTC',
    timeframe: '60',
    bars: hourly(48, 100),
  };

  await resolveSecurity(source, [job], '1h', '60', provider, {
    concurrency: 1,
    range,
    barMagnifierRequested: true,
    staticDependencies: dependencies,
  });

  expect(Object.keys(job.securityBars ?? {})).toEqual(['AAPL']);
  expect(job.securityBars?.AAPL).toHaveLength(sourceBars);
  expect(job.securityProofs?.AAPL).toMatchObject({
    targetCanonicalTf: '60m',
    requestedCanonicalTfs: ['1d', '2d'],
  });
});

test('exact cross-symbol higher-timeframe resampling rejects exchange-session alignment', async () => {
  const source = `//@version=6
strategy("exchange resampling")
plot(request.security("AAPL", "120", close))`;
  const dependencies = compilerDependencies(source);
  const start = DAY1 + 30 * 60;
  const calendar = deepFreezeFixture({
    calendarId: 'XNYS-session-anchor',
    version: '2026a',
    coverage: { from: start, to: start + 4 * 3_600 },
    sessions: [{ from: start, to: start + 4 * 3_600 }],
  }) as HistorySessionCalendar;
  const provider = new StaticProvider(
    { 'AAPL|1h': spacedBars(4, 3_600, 200, start) },
    {
      alignment: 'exchange-calendar',
      calendar,
      timeframes: ['1h'],
      cacheIdentity: 'exchange-resampling-rejected',
    },
  );
  const job: Job = {
    source,
    symbol: 'BTC',
    timeframe: '60',
    bars: spacedBars(4, 3_600, 100, start),
  };

  await expect(
    resolveSecurity(source, [job], '1h', '60', provider, {
      concurrency: 1,
      range: { from: start, to: start + 4 * 3_600 - 1 },
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    }),
  ).rejects.toMatchObject({
    type: 'bar-magnifier-error',
    kind: 'unsupported',
    code: 'cross-symbol-plain-exchange-calendar-resampling-unsupported',
    permanent: true,
    details: expect.objectContaining({
      symbol: 'AAPL',
      sourceCanonicalTf: '60m',
      requestedCanonicalTfs: ['120m'],
      calendarId: 'XNYS-session-anchor',
    }),
  });
  expect(job.securityBars).toBeUndefined();
  expect(job.securityProofs).toBeUndefined();
});

test('exact static security missing and legacy-unsupported sources fail permanently without history fallback', async () => {
  const source = `//@version=6
strategy("missing")
plot(request.security("AAPL", "D", close))`;
  const dependencies = compilerDependencies(source);
  const job = (): Job => ({
    source,
    symbol: 'BTC',
    timeframe: '60',
    bars: hourly(2, 100),
  });
  const range = { from: DAY1, to: DAY1 + 2 * 3_600 - 1 };

  const missing = new StaticProvider(
    { 'AAPL|1h': [] },
    { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'missing-static' },
  );
  await expect(
    resolveSecurity(source, [job()], '1h', '60', missing, {
      concurrency: 1,
      range,
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    }),
  ).rejects.toMatchObject({
    type: 'exact-history-error',
    kind: 'provider-limited',
    code: 'incomplete-required-coverage',
    permanent: true,
  });

  let legacyCalls = 0;
  const legacy: HistoryProvider = {
    id: 'legacy-only',
    async history() {
      legacyCalls++;
      return hourly(2, 200);
    },
  };
  await expect(
    resolveSecurity(source, [job()], '1h', '60', legacy, {
      concurrency: 1,
      range,
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    }),
  ).rejects.toMatchObject({
    type: 'exact-history-error',
    kind: 'unsupported',
    code: 'unknown-alignment',
    permanent: true,
  });
  expect(legacyCalls).toBe(0);
});

test('exact static security attaches atomically when a later dependency is partial', async () => {
  const source = `//@version=6
strategy("atomic")
a = request.security("AAPL", "D", close)
m = request.security("MSFT", "D", close)
plot(a + m)`;
  const dependencies = compilerDependencies(source);
  const provider = new StaticProvider(
    {
      'AAPL|1h': spacedBars(2, 3_600, 200),
      'MSFT|1h': spacedBars(1, 3_600, 300),
    },
    { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'atomic-static' },
  );
  const job: Job = {
    source,
    symbol: 'BTC',
    timeframe: '60',
    bars: hourly(2, 100),
  };

  await expect(
    resolveSecurity(source, [job], '1h', '60', provider, {
      concurrency: 1,
      range: { from: DAY1, to: DAY1 + 2 * 3_600 - 1 },
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    }),
  ).rejects.toMatchObject({ code: 'incomplete-required-coverage', permanent: true });
  expect(job.securityBars).toBeUndefined();
  expect(job.securityProofs).toBeUndefined();
});

test('exact static security rejects explicit provider truncation even with covered rows', async () => {
  const source = `//@version=6
strategy("truncated")
plot(request.security("AAPL", "D", close))`;
  const dependencies = compilerDependencies(source);
  const dependencyBars = spacedBars(50, 3_600, 200, DAY1 - 2 * 86_400);
  let provider!: HistoryProvider;
  provider = {
    id: 'truncated-exact',
    async history() {
      throw new Error('legacy history must not run');
    },
    async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
      const capabilities = { timeframes: ['1h'], alignment: 'utc-24x7' as const };
      return {
        provider,
        normalizedSymbol: symbol,
        cacheIdentity: `truncated:${symbol}`,
        capabilities,
        async history(request: HistoryRequest) {
          return {
            ...historyAcquisitionFromBars({
              bars: dependencyBars,
              request,
              cacheIdentity: `truncated:${symbol}`,
              normalizedSymbol: symbol,
              alignment: capabilities.alignment,
            }),
            truncated: { side: 'before' as const, reason: 'fixture-cap', limit: 2 },
          };
        },
      };
    },
  };
  const job: Job = {
    source,
    symbol: 'BTC',
    timeframe: '60',
    bars: hourly(2, 100),
  };

  await expect(
    resolveSecurity(source, [job], '1h', '60', provider, {
      concurrency: 1,
      range: { from: DAY1, to: DAY1 + 2 * 3_600 - 1 },
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    }),
  ).rejects.toMatchObject({
    type: 'exact-history-error',
    kind: 'provider-limited',
    code: 'static-security-provider-truncated',
    permanent: true,
    truncated: { side: 'before', reason: 'fixture-cap', limit: 2 },
  });
  expect(job.securityBars).toBeUndefined();
  expect(job.securityProofs).toBeUndefined();
});

const SECURITY_WEEK_SECONDS = 7 * 86_400;
const PINE_RUNTIME_WEEK_PHASE = unixSecond(-3 * 86_400);

test('exact static security fetches Pine W on its Monday grid for self and cross 7D-chart requests', async () => {
  const source = `//@version=6
strategy("weekly grids")
self = request.security(syminfo.tickerid, "W", close)
cross = request.security("AAPL", "W", close)
plot(self + cross)`;
  const dependencies = compilerDependencies(source);

  // Legacy static/discovery classification remains duration-based; only the
  // exact planner retains this equal-duration, different-grid self request.
  expect(planFromStatic(dependencies, '7d')?.selfPlainRawTfs).toEqual([]);
  expect(
    classifyRequests([{ symbol: PROBE_SYMBOL, timeframe: 'W', lowerTf: false }], '7d')
      .selfPlainRawTfs,
  ).toEqual([]);

  const range = securityRangeForBarMagnifier(0, SECURITY_WEEK_SECONDS, '7d', dependencies);
  expect(range).toEqual({
    from: PINE_RUNTIME_WEEK_PHASE - 2 * SECURITY_WEEK_SECONDS,
    to: SECURITY_WEEK_SECONDS - 1,
  });
  const firstMonday = PINE_RUNTIME_WEEK_PHASE - 2 * SECURITY_WEEK_SECONDS;
  const provider = new StaticProvider(
    {
      'BTC|1w': spacedBars(4, SECURITY_WEEK_SECONDS, 100, firstMonday),
      'AAPL|1w': spacedBars(4, SECURITY_WEEK_SECONDS, 200, firstMonday),
    },
    {
      alignment: 'utc-24x7',
      weekAnchorSec: PINE_RUNTIME_WEEK_PHASE,
      timeframes: ['1w'],
      cacheIdentity: 'pine-monday-static-security',
    },
  );
  const job: Job = {
    source,
    symbol: 'BTC',
    timeframe: '7D',
    bars: spacedBars(1, SECURITY_WEEK_SECONDS, 50, 0),
    magnifier: {
      chartCloseTimesMs: [SECURITY_WEEK_SECONDS * 1_000],
    } as ResolvedMagnifierDataset,
  };

  await resolveSecurity(source, [job], '7d', '7D', provider, {
    concurrency: 2,
    range,
    barMagnifierRequested: true,
    staticDependencies: dependencies,
  });

  expect(Object.keys(job.securityBars ?? {}).sort()).toEqual(['AAPL', 'BTC@W']);
  for (const key of ['AAPL', 'BTC@W']) {
    expect(job.securityProofs?.[key]).toMatchObject({
      requestedCanonicalTfs: ['1w'],
      targetCanonicalTf: '1w',
      provenance: {
        sourceTimeframe: '1w',
        targetTimeframe: '1w',
        weekAnchorSec: PINE_RUNTIME_WEEK_PHASE,
      },
      alignmentEvidence: {
        kind: 'utc-24x7',
        weekAnchorSec: PINE_RUNTIME_WEEK_PHASE,
      },
    });
    expect(job.securityBars?.[key]?.map((bar) => bar.time)).toEqual(
      Array.from({ length: 4 }, (_, index) => firstMonday + index * SECURITY_WEEK_SECONDS),
    );
  }
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, job)).not.toThrow();
});

test('exact self and cross Pine W reject a Thursday-anchored weekly provider without relabeling it', async () => {
  const cases = [
    {
      label: 'self',
      symbol: 'BTC',
      source: `//@version=6
strategy("self W")
plot(request.security(syminfo.tickerid, "W", close))`,
    },
    {
      label: 'cross',
      symbol: 'AAPL',
      source: `//@version=6
strategy("cross W")
plot(request.security("AAPL", "W", close))`,
    },
  ];

  for (const value of cases) {
    const dependencies = compilerDependencies(value.source);
    const provider = new StaticProvider(
      { [`${value.symbol}|1w`]: spacedBars(1, SECURITY_WEEK_SECONDS, 100, 0) },
      {
        alignment: 'utc-24x7',
        weekAnchorSec: unixSecond(0),
        timeframes: ['1w'],
        cacheIdentity: `thursday-${value.label}-weekly`,
      },
    );
    const job: Job = {
      source: value.source,
      symbol: 'BTC',
      timeframe: '7D',
      bars: spacedBars(1, SECURITY_WEEK_SECONDS, 50, 0),
    };

    await expect(
      resolveSecurity(value.source, [job], '7d', '7D', provider, {
        concurrency: 1,
        range: { from: 0, to: SECURITY_WEEK_SECONDS - 1 },
        barMagnifierRequested: true,
        staticDependencies: dependencies,
      }),
      value.label,
    ).rejects.toMatchObject({
      type: 'exact-history-error',
      kind: 'unsupported',
      code: 'no-exact-divisor',
      permanent: true,
    });
    expect(job.securityBars).toBeUndefined();
    expect(job.securityProofs).toBeUndefined();
  }
});

test('exact static security forms Pine W from daily bars independently of the provider native-week anchor', async () => {
  const source = `//@version=6
strategy("daily to Monday W")
self = request.security(syminfo.tickerid, "W", close)
cross = request.security("AAPL", "W", close)
plot(self + cross)`;
  const dependencies = compilerDependencies(source);
  const range = securityRangeForBarMagnifier(0, SECURITY_WEEK_SECONDS, '7d', dependencies);
  const firstMonday = PINE_RUNTIME_WEEK_PHASE - 2 * SECURITY_WEEK_SECONDS;
  const provider = new StaticProvider(
    {
      'BTC|1d': spacedBars(28, 86_400, 100, firstMonday),
      'AAPL|1d': spacedBars(28, 86_400, 200, firstMonday),
    },
    {
      alignment: 'utc-24x7',
      weekAnchorSec: unixSecond(0),
      timeframes: ['1d'],
      cacheIdentity: 'daily-forms-pine-monday-week',
    },
  );
  const job: Job = {
    source,
    symbol: 'BTC',
    timeframe: '7D',
    bars: spacedBars(1, SECURITY_WEEK_SECONDS, 50, 0),
    magnifier: {
      chartCloseTimesMs: [SECURITY_WEEK_SECONDS * 1_000],
    } as ResolvedMagnifierDataset,
  };

  await resolveSecurity(source, [job], '7d', '7D', provider, {
    concurrency: 2,
    range,
    barMagnifierRequested: true,
    staticDependencies: dependencies,
  });

  for (const key of ['AAPL', 'BTC@W']) {
    expect(job.securityProofs?.[key]).toMatchObject({
      requestedCanonicalTfs: ['1w'],
      targetCanonicalTf: '1w',
      provenance: {
        sourceTimeframe: '1d',
        targetTimeframe: '1w',
        weekAnchorSec: PINE_RUNTIME_WEEK_PHASE,
        aggregationVersion: 3,
      },
      alignmentEvidence: {
        kind: 'utc-24x7',
        weekAnchorSec: PINE_RUNTIME_WEEK_PHASE,
      },
    });
    expect(job.securityBars?.[key]?.map((bar) => bar.time)).toEqual(
      Array.from({ length: 4 }, (_, index) => firstMonday + index * SECURITY_WEEK_SECONDS),
    );
  }
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, job)).not.toThrow();
});

test('exact cross W and 7D requests share one daily source that tiles both grids', async () => {
  const source = `//@version=6
strategy("mixed weekly grids")
w = request.security("AAPL", "W", close)
seven = request.security("AAPL", "7D", close)
plot(w + seven)`;
  const dependencies = compilerDependencies(source);
  const chartOpen = PINE_RUNTIME_WEEK_PHASE;
  const range = securityRangeForBarMagnifier(
    chartOpen,
    chartOpen + SECURITY_WEEK_SECONDS,
    '1w',
    dependencies,
  );
  const sourceDays = (range.to! + 1 - range.from) / 86_400;
  const provider = new StaticProvider(
    {
      'AAPL|1d': spacedBars(sourceDays, 86_400, 200, range.from),
    },
    {
      alignment: 'utc-24x7',
      weekAnchorSec: unixSecond(0),
      timeframes: ['1d'],
      cacheIdentity: 'mixed-weekly-grid-daily-source',
    },
  );
  const job: Job = {
    source,
    symbol: 'BTC',
    timeframe: 'W',
    bars: spacedBars(1, SECURITY_WEEK_SECONDS, 50, chartOpen),
    magnifier: {
      chartCloseTimesMs: [(chartOpen + SECURITY_WEEK_SECONDS) * 1_000],
    } as ResolvedMagnifierDataset,
  };

  await resolveSecurity(source, [job], '1w', 'W', provider, {
    concurrency: 1,
    range,
    barMagnifierRequested: true,
    staticDependencies: dependencies,
  });

  expect(Object.keys(job.securityBars ?? {})).toEqual(['AAPL']);
  expect(job.securityBars?.AAPL).toHaveLength(sourceDays);
  expect(job.securityProofs?.AAPL).toMatchObject({
    requestedCanonicalTfs: ['1w', '7d'],
    targetCanonicalTf: '1d',
    requested: { from: range.from, to: range.to! + 1 },
    provenance: {
      sourceTimeframe: '1d',
      targetTimeframe: '1d',
      weekAnchorSec: 0,
      aggregationVersion: 0,
    },
  });
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, job)).not.toThrow();
});

test('exact static security preserves genuine anchor-0 1w to requested 7D equivalence', async () => {
  const source = `//@version=6
strategy("epoch seven day")
self = request.security(syminfo.tickerid, "7D", close)
cross = request.security("AAPL", "7D", close)
plot(self + cross)`;
  const dependencies = compilerDependencies(source);
  const chartOpen = PINE_RUNTIME_WEEK_PHASE + SECURITY_WEEK_SECONDS;
  const range = securityRangeForBarMagnifier(
    chartOpen,
    chartOpen + SECURITY_WEEK_SECONDS,
    '1w',
    dependencies,
  );
  const firstProviderWeek = -2 * SECURITY_WEEK_SECONDS;
  const provider = new StaticProvider(
    {
      'BTC|1w': spacedBars(4, SECURITY_WEEK_SECONDS, 100, firstProviderWeek),
      'AAPL|1w': spacedBars(4, SECURITY_WEEK_SECONDS, 200, firstProviderWeek),
    },
    {
      alignment: 'utc-24x7',
      weekAnchorSec: unixSecond(0),
      timeframes: ['1w'],
      cacheIdentity: 'epoch-week-seven-day-security',
    },
  );
  const job: Job = {
    source,
    symbol: 'BTC',
    timeframe: 'W',
    bars: spacedBars(1, SECURITY_WEEK_SECONDS, 50, chartOpen),
    magnifier: {
      chartCloseTimesMs: [(chartOpen + SECURITY_WEEK_SECONDS) * 1_000],
    } as ResolvedMagnifierDataset,
  };

  await resolveSecurity(source, [job], '1w', 'W', provider, {
    concurrency: 2,
    range,
    barMagnifierRequested: true,
    staticDependencies: dependencies,
  });

  expect(Object.keys(job.securityBars ?? {}).sort()).toEqual(['AAPL', 'BTC@7D']);
  for (const key of ['AAPL', 'BTC@7D']) {
    expect(job.securityProofs?.[key]).toMatchObject({
      requestedCanonicalTfs: ['7d'],
      targetCanonicalTf: '7d',
      provenance: {
        sourceTimeframe: '1w',
        targetTimeframe: '7d',
        weekAnchorSec: 0,
        aggregationVersion: 0,
      },
      alignmentEvidence: { kind: 'utc-24x7', weekAnchorSec: 0 },
    });
  }
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, job)).not.toThrow();
});

test('exact self and cross Pine 2W use the runtime phase while 14D remains epoch-anchored', async () => {
  const day = 86_400;
  const twoWeeks = 14 * day;
  const chartOpen = 0;
  const chartClose = twoWeeks;
  const expectedRange = {
    from: PINE_RUNTIME_WEEK_PHASE - 2 * twoWeeks,
    to: chartClose - 1,
  };
  const expectedOpens = Array.from(
    { length: 4 },
    (_, index) => PINE_RUNTIME_WEEK_PHASE + (index - 2) * twoWeeks,
  );
  const wrongPhase = unixSecond(4 * day);
  const wrongPhaseOpens = Array.from(
    { length: 4 },
    (_, index) => wrongPhase + (index - 3) * twoWeeks,
  );

  for (const testCase of [
    {
      label: 'self',
      requestedSymbol: 'BTC',
      key: 'BTC@2W',
      source: `//@version=6
strategy("self 2W")
plot(request.security(syminfo.tickerid, "2W", close))`,
    },
    {
      label: 'cross',
      requestedSymbol: 'AAPL',
      key: 'AAPL',
      source: `//@version=6
strategy("cross 2W")
plot(request.security("AAPL", "2W", close))`,
    },
  ]) {
    const dependencies = compilerDependencies(testCase.source);
    const range = securityRangeForBarMagnifier(chartOpen, chartClose, '14d', dependencies);
    expect(range, testCase.label).toEqual(expectedRange);

    const dailyStart = PINE_RUNTIME_WEEK_PHASE - 2 * twoWeeks;
    const provider = new StaticProvider(
      {
        [`${testCase.requestedSymbol}|1d`]: spacedBars(56, day, 100, dailyStart),
      },
      {
        alignment: 'utc-24x7',
        weekAnchorSec: unixSecond(0),
        timeframes: ['1d'],
        cacheIdentity: `runtime-2w-phase-${testCase.label}`,
      },
    );
    const job: Job = {
      source: testCase.source,
      symbol: 'BTC',
      timeframe: '14D',
      bars: spacedBars(1, twoWeeks, 50, chartOpen),
      magnifier: {
        chartCloseTimesMs: [chartClose * 1_000],
      } as ResolvedMagnifierDataset,
    };

    await resolveSecurity(testCase.source, [job], '14d', '14D', provider, {
      concurrency: 1,
      range,
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    });

    const resolvedBars = job.securityBars?.[testCase.key];
    const resolvedProof = job.securityProofs?.[testCase.key];
    expect(
      resolvedBars?.map((value) => value.time),
      testCase.label,
    ).toEqual(expectedOpens);
    expect(resolvedProof, testCase.label).toMatchObject({
      requestedSymbol: testCase.requestedSymbol,
      requestedCanonicalTfs: ['2w'],
      targetCanonicalTf: '2w',
      provenance: {
        sourceTimeframe: '1d',
        targetTimeframe: '2w',
        weekAnchorSec: PINE_RUNTIME_WEEK_PHASE,
      },
      alignmentEvidence: {
        kind: 'utc-24x7',
        weekAnchorSec: PINE_RUNTIME_WEEK_PHASE,
      },
    });
    expect(
      () => assertResolvedSecurityForBarMagnifier(testCase.source, dependencies, job),
      testCase.label,
    ).not.toThrow();

    const wrongBars = immutableBarsFixture(
      wrongPhaseOpens.map((time, index) => ({ ...spacedBars(1, twoWeeks, 300 + index, time)[0]! })),
    );
    const wrongProof = reboundSecurityProof(resolvedProof!, wrongBars, {
      provenance: deepFreezeFixture({
        ...resolvedProof!.provenance,
        weekAnchorSec: wrongPhase,
      }),
      alignmentEvidence: deepFreezeFixture({
        kind: 'utc-24x7' as const,
        weekAnchorSec: wrongPhase,
      }),
    });
    try {
      assertResolvedSecurityForBarMagnifier(testCase.source, dependencies, {
        ...job,
        securityBars: { [testCase.key]: wrongBars },
        securityProofs: { [testCase.key]: wrongProof },
      });
      throw new Error(`expected ${testCase.label} wrong-phase proof rejection`);
    } catch (error) {
      expect(error, testCase.label).toMatchObject({
        code: 'unresolved-static-security-with-bar-magnifier',
        permanent: true,
        details: {
          invalid: [
            expect.objectContaining({
              key: testCase.key,
              reasons: expect.arrayContaining([
                'resolver-authentication',
                'requested-timeframe-grid',
              ]),
            }),
          ],
        },
      });
    }
  }
});

test('UTC close[3] acquires compiler-proven history and missing leading source fails', async () => {
  const day = 86_400;
  const source = `//@version=6
strategy("deep security history")
d = request.security("B", "D", close[3], lookahead=barmerge.lookahead_on)
plot(d, "d")`;
  const dependencies = compilerDependencies(source, [{ lookahead: true, expressionPriorBars: 3 }]);
  const chart = spacedBars(2, 3_600, 100, DAY1);
  const sourceStart = DAY1 - 5 * day;
  const complete = spacedBars(6 * 24, 3_600, 200, sourceStart);
  const range = securityRangeForBarMagnifier(
    chart[0]!.time,
    chart.at(-1)!.time + 3_600,
    '1h',
    dependencies,
  );
  expect(range).toEqual({ from: sourceStart, to: DAY1 + day - 1 });
  const makeJob = (): Job => ({
    source,
    symbol: 'A',
    timeframe: '60',
    bars: chart,
    magnifier: {
      chartCloseTimesMs: [(DAY1 + 2 * 3_600) * 1_000],
    } as ResolvedMagnifierDataset,
  });

  await expect(
    resolveSecurity(
      source,
      [makeJob()],
      '1h',
      '60',
      new StaticProvider(
        { 'B|1h': complete.slice(1) },
        { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'close-3-missing' },
      ),
      {
        concurrency: 1,
        range,
        barMagnifierRequested: true,
        staticDependencies: dependencies,
      },
    ),
  ).rejects.toMatchObject({
    type: 'exact-history-error',
    kind: 'provider-limited',
    code: 'incomplete-required-coverage',
    permanent: true,
  });

  const resolved = makeJob();
  await resolveSecurity(
    source,
    [resolved],
    '1h',
    '60',
    new StaticProvider(
      { 'B|1h': complete },
      { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'close-3-complete' },
    ),
    {
      concurrency: 1,
      range,
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    },
  );
  expect(resolved.securityProofs?.B).toMatchObject({
    dependencies: [
      {
        dependencyIndex: 0,
        lookahead: true,
        expressionPriorBars: 3,
        baseMappingPriorBars: 2,
        totalRequiredPriorTargetBars: 5,
      },
    ],
    requested: { from: sourceStart, to: DAY1 + day },
  });
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, resolved)).not.toThrow();

  const local = await new LocalRunner().run({ ...resolved, magnifier: undefined });
  expect(local.ok).toBe(true);
  const expectedFirst = complete[3 * 24 - 1]!.close;
  expect(local.plots.find((plot) => plot.title === 'd')?.data).toEqual([
    expectedFirst,
    expectedFirst,
  ]);
});

test('sparse exchange close[3] counts populated runtime buckets and requires the earliest source period', async () => {
  const day = 86_400;
  const chartOpen = DAY1 + 5 * day;
  const finalChartClose = chartOpen + 3_600;
  const periodOpens = [DAY1, DAY1 + day, DAY1 + 2 * day, chartOpen];
  const periods = periodOpens.map((from) => deepFreezeFixture({ from, to: from + 3_600 }));
  const calendar = deepFreezeFixture({
    calendarId: 'sparse-daily-history',
    version: '1',
    coverage: { from: DAY1, to: DAY1 + 6 * day },
    sessions: periods,
    periods: { '1d': periods },
  }) as HistorySessionCalendar;
  const sourceBars = periodOpens.map(
    (time, index) => spacedBars(1, 3_600, 10 + index * 10, time)[0]!,
  );
  const source = `//@version=6
strategy("sparse exchange history")
d = request.security("B", "D", close[3], lookahead=barmerge.lookahead_on)
plot(d, "d")`;
  const dependencies = compilerDependencies(source, [{ lookahead: true, expressionPriorBars: 3 }]);
  const makeJob = (): Job => ({
    source,
    symbol: 'A',
    timeframe: 'D',
    bars: [spacedBars(1, 3_600, 100, chartOpen)[0]!],
    magnifier: {
      chartCloseTimesMs: [finalChartClose * 1_000],
    } as ResolvedMagnifierDataset,
  });
  const resolveCase = (
    job: Job,
    bars: readonly Bar[],
    evidence: HistorySessionCalendar,
    cacheIdentity: string,
  ) =>
    resolveSecurity(
      source,
      [job],
      '1d',
      'D',
      new StaticProvider(
        { 'B|1d': [...bars] },
        {
          alignment: 'exchange-calendar',
          calendar: evidence,
          timeframes: ['1d'],
          cacheIdentity,
        },
      ),
      {
        concurrency: 1,
        range: { from: chartOpen, to: finalChartClose - 1 },
        barMagnifierRequested: true,
        staticDependencies: dependencies,
      },
    );

  const insufficientPeriods = periods.slice(1);
  const insufficientCalendar = deepFreezeFixture({
    calendarId: 'sparse-daily-history-insufficient',
    version: '1',
    coverage: calendar.coverage,
    sessions: insufficientPeriods,
    periods: { '1d': insufficientPeriods },
  }) as HistorySessionCalendar;
  await expect(
    resolveCase(
      makeJob(),
      sourceBars.slice(1),
      insufficientCalendar,
      'sparse-daily-history-insufficient',
    ),
  ).rejects.toMatchObject({
    type: 'bar-magnifier-error',
    kind: 'provider-limited',
    code: 'static-security-history-calendar-coverage-insufficient',
    permanent: true,
    details: {
      dependencyIndex: 0,
      requiredPriorTargetBars: 3,
      availablePriorRuntimeBuckets: 2,
    },
  });

  await expect(
    resolveCase(makeJob(), sourceBars.slice(1), calendar, 'sparse-daily-history-missing-source'),
  ).rejects.toMatchObject({
    type: 'exact-history-error',
    kind: 'provider-limited',
    code: 'incomplete-required-coverage',
    permanent: true,
  });

  const resolved = makeJob();
  await resolveCase(resolved, sourceBars, calendar, 'sparse-daily-history-complete');
  expect(resolved.securityBars?.B?.map((bar) => bar.time)).toEqual(periodOpens);
  expect(resolved.securityProofs?.B).toMatchObject({
    dependencies: [
      {
        dependencyIndex: 0,
        lookahead: true,
        expressionPriorBars: 3,
        baseMappingPriorBars: 0,
        totalRequiredPriorTargetBars: 3,
      },
    ],
    requested: { from: DAY1, to: DAY1 + 6 * day },
    complete: true,
    gaps: [],
  });
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, resolved)).not.toThrow();

  const local = await new LocalRunner().run({ ...resolved, magnifier: undefined });
  expect(local.ok).toBe(true);
  expect(local.plots.find((plot) => plot.title === 'd')?.data).toEqual([sourceBars[0]!.close]);
});

test('exact cross-symbol lookahead_on acquires the final containing bucket before local execution', async () => {
  const day = 86_400;
  const chart = spacedBars(2, 3_600, 100, DAY1);
  const source = `//@version=6
strategy("cross lookahead")
d = request.security("AAPL", "D", close, lookahead=barmerge.lookahead_on)
plot(d, "d")`;
  const dependencies = compilerDependencies(source);
  const range = securityRangeForBarMagnifier(
    chart[0]!.time,
    chart.at(-1)!.time + 3_600,
    '1h',
    dependencies,
  );
  const sourceStart = DAY1 - 2 * day;
  const partial = spacedBars(50, 3_600, 200, sourceStart);
  const complete = spacedBars(72, 3_600, 200, sourceStart);
  const job = (): Job => ({
    source,
    symbol: 'BTC',
    timeframe: '60',
    bars: chart,
    magnifier: {
      chartCloseTimesMs: [(DAY1 + 2 * 3_600) * 1_000],
    } as ResolvedMagnifierDataset,
  });

  await expect(
    resolveSecurity(
      source,
      [job()],
      '1h',
      '60',
      new StaticProvider(
        { 'AAPL|1h': partial },
        { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'lookahead-partial' },
      ),
      {
        concurrency: 1,
        range,
        barMagnifierRequested: true,
        staticDependencies: dependencies,
      },
    ),
  ).rejects.toMatchObject({
    type: 'exact-history-error',
    code: 'incomplete-required-coverage',
    permanent: true,
  });

  const resolved = job();
  await resolveSecurity(
    source,
    [resolved],
    '1h',
    '60',
    new StaticProvider(
      { 'AAPL|1h': complete },
      { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'lookahead-complete' },
    ),
    {
      concurrency: 1,
      range,
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    },
  );

  expect(resolved.securityProofs?.AAPL).toMatchObject({
    requestKind: 'cross-plain',
    requestedCanonicalTfs: ['1d'],
    lookaheadOnCanonicalTfs: ['1d'],
    requested: { from: range.from, to: DAY1 + day },
    complete: true,
    gaps: [],
  });
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, resolved)).not.toThrow();

  const noCopy = deriveResolverIssuedSecurityPrefix(
    resolved.securityBars,
    resolved.securityProofs,
    DAY1 + 2 * 3_600,
  );
  expect(noCopy.securityBars).toBe(resolved.securityBars);
  expect(noCopy.securityProofs).toBe(resolved.securityProofs);
  expect(noCopy.securityBars?.AAPL).toBe(resolved.securityBars?.AAPL);
  expect(noCopy.securityProofs?.AAPL).toBe(resolved.securityProofs?.AAPL);

  const local = await new LocalRunner().run({ ...resolved, magnifier: undefined });
  expect(local.ok).toBe(true);
  const expectedFinalClose = complete.at(-1)!.close;
  expect(local.plots.find((plot) => plot.title === 'd')?.data).toEqual([
    expectedFinalClose,
    expectedFinalClose,
  ]);
});

test('broader resolver HTF proofs cover shorter lookahead prefixes without weakening identity checks', async () => {
  const day = 86_400;
  const source = `//@version=6
strategy("broader lookahead prefix")
d = request.security("B", "D", close, lookahead=barmerge.lookahead_on)
plot(d, "d")`;
  const dependencies = compilerDependencies(source, [{ lookahead: true, expressionPriorBars: 0 }]);
  const chart = spacedBars(2, day, 100, DAY1);
  const finalChartClose = DAY1 + day + 3_600;
  const range = securityRangeForBarMagnifier(DAY1, finalChartClose, '1h', dependencies);
  expect(range).toEqual({ from: DAY1 - 2 * day, to: DAY1 + 2 * day - 1 });

  const job: Job = {
    source,
    symbol: 'A',
    timeframe: '60',
    bars: chart,
    magnifier: {
      chartCloseTimesMs: [finalChartClose * 1_000],
    } as ResolvedMagnifierDataset,
  };
  await resolveSecurity(
    source,
    [job],
    '1h',
    '60',
    new StaticProvider(
      { 'B|1h': spacedBars(4 * 24, 3_600, 200, range.from) },
      { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'broader-prefix-proof' },
    ),
    {
      concurrency: 1,
      range,
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    },
  );

  const prefixClose = DAY1 + 3_600;
  const prefix = deriveResolverIssuedSecurityPrefix(
    job.securityBars,
    job.securityProofs,
    prefixClose,
  );
  expect(prefix.securityBars).toBe(job.securityBars);
  expect(prefix.securityProofs).toBe(job.securityProofs);
  const prefixJob: Job = {
    ...job,
    bars: chart.slice(0, 1),
    magnifier: {
      chartCloseTimesMs: [prefixClose * 1_000],
    } as ResolvedMagnifierDataset,
    securityBars: prefix.securityBars,
    securityProofs: prefix.securityProofs,
  };
  expect(() =>
    assertResolvedSecurityForBarMagnifier(source, dependencies, prefixJob),
  ).not.toThrow();

  const proof = prefixJob.securityProofs!.B!;
  const forgedDependencies = deepFreezeFixture(
    proof.dependencies.map((dependency) => ({ ...dependency, lookahead: false })),
  );
  const forged = reboundSecurityProof(proof, prefixJob.securityBars!.B!, {
    dependencies: forgedDependencies,
  });
  try {
    assertResolvedSecurityForBarMagnifier(source, dependencies, {
      ...prefixJob,
      securityProofs: { B: forged },
    });
    throw new Error('expected forged prefix dependency identity rejection');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'unresolved-static-security-with-bar-magnifier',
      permanent: true,
      details: {
        invalid: [
          expect.objectContaining({
            key: 'B',
            reasons: expect.arrayContaining(['dependency-identity']),
          }),
        ],
      },
    });
  }
});

test('resolver-issued lower-TF security prefixes clip self/cross rows and reject public authority clones', async () => {
  const chart = spacedBars(3, 3_600, 100, DAY1);
  const source = `//@version=6
strategy("lower prefixes")
self = request.security_lower_tf(syminfo.tickerid, "10", close)
cross = request.security_lower_tf("MSFT", "10", close)
plot(array.size(self), "self")
plot(array.size(cross), "cross")`;
  const dependencies = compilerDependencies(source);
  const provider = new StaticProvider(
    {
      'BTC|10m': spacedBars(18, 600, 200, DAY1),
      'MSFT|10m': spacedBars(18, 600, 300, DAY1),
    },
    {
      alignment: 'utc-24x7',
      timeframes: ['10m'],
      cacheIdentity: 'lower-prefix-authority',
    },
  );
  const full: Job = {
    source,
    symbol: 'BTC',
    timeframe: '60',
    bars: chart,
    magnifier: {
      chartCloseTimesMs: [(DAY1 + 3 * 3_600) * 1_000],
    } as ResolvedMagnifierDataset,
  };
  await resolveSecurity(source, [full], '1h', '60', provider, {
    concurrency: 2,
    range: { from: DAY1, to: DAY1 + 3 * 3_600 - 1 },
    barMagnifierRequested: true,
    staticDependencies: dependencies,
  });

  const finalIsClose = DAY1 + 2 * 3_600;
  const prefix = deriveResolverIssuedSecurityPrefix(
    full.securityBars,
    full.securityProofs,
    finalIsClose,
  );
  expect(Object.isFrozen(prefix)).toBe(true);
  expect(Object.isFrozen(prefix.securityBars)).toBe(true);
  expect(Object.isFrozen(prefix.securityProofs)).toBe(true);
  for (const key of ['BTC@10', 'MSFT@10']) {
    const bars = prefix.securityBars?.[key];
    const proof = prefix.securityProofs?.[key];
    expect(bars, key).toHaveLength(12);
    expect(
      bars?.every((bar) => bar.time < finalIsClose),
      key,
    ).toBe(true);
    expect(proof, key).toMatchObject({
      requestKind: 'lower',
      requested: { from: DAY1, to: finalIsClose },
      complete: true,
      gaps: [],
      barsDigest: marketDataDigest(bars!),
    });
    expect(proof?.acquisitionKey, key).toBe(
      securityDatasetAcquisitionKey((({ acquisitionKey: _ignored, ...bound }) => bound)(proof!)),
    );
    expect(isResolverIssuedSecurityProof(proof), key).toBe(true);
  }

  const isJob: Job = {
    ...full,
    bars: chart.slice(0, 2),
    magnifier: {
      chartCloseTimesMs: [finalIsClose * 1_000],
    } as ResolvedMagnifierDataset,
    securityBars: prefix.securityBars,
    securityProofs: prefix.securityProofs,
  };
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, isJob)).not.toThrow();

  const local = await new LocalRunner().run({ ...isJob, magnifier: undefined });
  expect(local.ok).toBe(true);
  expect(local.plots.find((plot) => plot.title === 'self')?.data).toEqual([6, 6]);
  expect(local.plots.find((plot) => plot.title === 'cross')?.data).toEqual([6, 6]);

  const leaked = await new LocalRunner().run({
    ...isJob,
    magnifier: undefined,
    securityBars: full.securityBars,
    securityProofs: full.securityProofs,
  });
  expect(leaked.plots.find((plot) => plot.title === 'self')?.data).toEqual([6, 12]);
  expect(leaked.plots.find((plot) => plot.title === 'cross')?.data).toEqual([6, 12]);

  const clonedProofs = deepFreezeFixture({
    ...full.securityProofs,
    'BTC@10': { ...full.securityProofs!['BTC@10']! },
  }) as Job['securityProofs'];
  expect(() =>
    deriveResolverIssuedSecurityPrefix(full.securityBars, clonedProofs, finalIsClose),
  ).toThrow(
    expect.objectContaining({
      code: 'walkforward-static-security-prefix-authority',
      permanent: true,
    }),
  );
});

test('exchange daily and weekly runtime buckets include every leading and trailing provider period', async () => {
  const day = 86_400;
  for (const testCase of [
    {
      label: 'daily',
      pineTf: 'D',
      canonicalTf: '1d',
      runtimeFrom: 0,
      runtimeTo: day,
      chartOpen: 12 * 3_600,
      periodOpens: [0, 12 * 3_600, 80_000],
    },
    {
      label: 'weekly',
      pineTf: 'W',
      canonicalTf: '1w',
      runtimeFrom: -3 * day,
      runtimeTo: 4 * day,
      chartOpen: 0,
      periodOpens: [-2 * day, 0, 3 * day],
    },
  ] as const) {
    const finalChartClose = testCase.chartOpen + 3_600;
    const periods = testCase.periodOpens.map((open) =>
      deepFreezeFixture({ from: open, to: open + 3_600 }),
    );
    const calendar = deepFreezeFixture({
      calendarId: `multi-provider-${testCase.label}`,
      version: '1',
      coverage: { from: testCase.runtimeFrom, to: testCase.runtimeTo },
      sessions: periods,
      periods: { [testCase.canonicalTf]: periods },
    }) as HistorySessionCalendar;
    const source = `//@version=6
strategy("multi ${testCase.label} periods")
first = request.security("B", "${testCase.pineTf}", open, lookahead=barmerge.lookahead_on)
last = request.security("B", "${testCase.pineTf}", close, lookahead=barmerge.lookahead_on)
plot(first, "first")
plot(last, "last")`;
    const dependencies = compilerDependencies(source, [
      { lookahead: true, expressionPriorBars: 0 },
      { lookahead: true, expressionPriorBars: 0 },
    ]);
    const sourceBars = testCase.periodOpens.map(
      (open, index) => spacedBars(1, 3_600, 10 + index * 10, open)[0]!,
    );
    const makeJob = (): Job => ({
      source,
      symbol: 'A',
      timeframe: testCase.pineTf,
      bars: [spacedBars(1, 3_600, 100, testCase.chartOpen)[0]!],
      magnifier: {
        chartCloseTimesMs: [finalChartClose * 1_000],
      } as ResolvedMagnifierDataset,
    });
    const resolveCase = (
      job: Job,
      bars: readonly Bar[],
      evidence: HistorySessionCalendar,
      cacheIdentity: string,
    ) =>
      resolveSecurity(
        source,
        [job],
        testCase.canonicalTf,
        testCase.pineTf,
        new StaticProvider(
          { [`B|${testCase.canonicalTf}`]: [...bars] },
          {
            alignment: 'exchange-calendar',
            calendar: evidence,
            timeframes: [testCase.canonicalTf],
            cacheIdentity,
          },
        ),
        {
          concurrency: 1,
          range: { from: testCase.chartOpen, to: finalChartClose - 1 },
          barMagnifierRequested: true,
          staticDependencies: dependencies,
        },
      );

    const leadingPeriods = periods.filter((period) => period.from >= testCase.chartOpen);
    const missingLeadingCalendar = deepFreezeFixture({
      calendarId: `missing-leading-${testCase.label}`,
      version: '1',
      coverage: { from: testCase.chartOpen, to: testCase.runtimeTo },
      sessions: leadingPeriods,
      periods: { [testCase.canonicalTf]: leadingPeriods },
    }) as HistorySessionCalendar;
    await expect(
      resolveCase(
        makeJob(),
        sourceBars,
        missingLeadingCalendar,
        `missing-leading-${testCase.label}`,
      ),
      testCase.label,
    ).rejects.toMatchObject({
      type: 'bar-magnifier-error',
      kind: 'provider-limited',
      code: 'static-security-lookahead-calendar-coverage-insufficient',
      permanent: true,
    });

    await expect(
      resolveCase(
        makeJob(),
        sourceBars.slice(1),
        calendar,
        `missing-earlier-provider-period-${testCase.label}`,
      ),
      testCase.label,
    ).rejects.toMatchObject({
      type: 'exact-history-error',
      kind: 'provider-limited',
      code: 'incomplete-required-coverage',
      permanent: true,
    });

    const job = makeJob();
    await resolveCase(job, sourceBars, calendar, `multi-provider-${testCase.label}`);

    expect(
      job.securityBars?.B?.map((row) => row.time),
      testCase.label,
    ).toEqual(testCase.periodOpens);
    expect(job.securityProofs?.B, testCase.label).toMatchObject({
      dependencies: [
        { dependencyIndex: 0, lookahead: true },
        { dependencyIndex: 1, lookahead: true },
      ],
      requested: { from: testCase.runtimeFrom, to: testCase.runtimeTo },
      complete: true,
      gaps: [],
    });
    expect(
      () => assertResolvedSecurityForBarMagnifier(source, dependencies, job),
      testCase.label,
    ).not.toThrow();

    const local = await new LocalRunner().run({ ...job, magnifier: undefined });
    expect(local.ok, testCase.label).toBe(true);
    expect(local.plots.find((plot) => plot.title === 'first')?.data, testCase.label).toEqual([
      sourceBars[0]!.open,
    ]);
    expect(local.plots.find((plot) => plot.title === 'last')?.data, testCase.label).toEqual([
      sourceBars.at(-1)!.close,
    ]);

    const shortened = reboundSecurityProof(job.securityProofs!.B!, job.securityBars!.B!, {
      requested: deepFreezeFixture({
        from: testCase.chartOpen,
        to: finalChartClose,
      }),
    });
    try {
      assertResolvedSecurityForBarMagnifier(source, dependencies, {
        ...job,
        securityProofs: { B: shortened },
      });
      throw new Error(`expected shortened ${testCase.label} range rejection`);
    } catch (error) {
      expect(error, testCase.label).toMatchObject({
        code: 'unresolved-static-security-with-bar-magnifier',
        permanent: true,
        details: {
          invalid: [
            expect.objectContaining({
              key: 'B',
              reasons: expect.arrayContaining(['requested-envelope']),
            }),
          ],
        },
      });
    }
  }
});

test('exchange lookahead requires calendar evidence through the final runtime bucket', async () => {
  const source = `//@version=6
strategy("exchange lookahead")
x = request.security("B", "60", close, lookahead=barmerge.lookahead_on)
plot(x, "x")`;
  const dependencies = compilerDependencies(source);
  const chart = spacedBars(1, 3_600, 100, 0);
  const range = { from: 0, to: 1_799 };
  const makeJob = (): Job => ({
    source,
    symbol: 'A',
    timeframe: '60',
    bars: chart,
    magnifier: { chartCloseTimesMs: [1_800_000] } as ResolvedMagnifierDataset,
  });
  const partialCalendar = deepFreezeFixture({
    calendarId: 'partial-final-runtime-bucket',
    version: '1',
    coverage: { from: 0, to: 1_800 },
    sessions: [],
  }) as HistorySessionCalendar;

  await expect(
    resolveSecurity(
      source,
      [makeJob()],
      '1h',
      '60',
      new StaticProvider(
        { 'B|60m': [] },
        {
          alignment: 'exchange-calendar',
          calendar: partialCalendar,
          timeframes: ['60m'],
          cacheIdentity: 'partial-exchange-lookahead',
        },
      ),
      {
        concurrency: 1,
        range,
        barMagnifierRequested: true,
        staticDependencies: dependencies,
      },
    ),
  ).rejects.toMatchObject({
    type: 'bar-magnifier-error',
    kind: 'provider-limited',
    code: 'static-security-lookahead-calendar-coverage-insufficient',
    permanent: true,
  });

  const completeCalendar = deepFreezeFixture({
    calendarId: 'complete-final-runtime-bucket',
    version: '1',
    coverage: { from: 0, to: 6_300 },
    sessions: [{ from: 2_700, to: 6_300 }],
  }) as HistorySessionCalendar;
  const sourceBar = spacedBars(1, 3_600, 9, 2_700)[0]!;
  const resolved = makeJob();
  await resolveSecurity(
    source,
    [resolved],
    '1h',
    '60',
    new StaticProvider(
      { 'B|60m': [sourceBar] },
      {
        alignment: 'exchange-calendar',
        calendar: completeCalendar,
        timeframes: ['60m'],
        cacheIdentity: 'complete-exchange-lookahead',
      },
    ),
    {
      concurrency: 1,
      range,
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    },
  );
  expect(resolved.securityProofs?.B).toMatchObject({
    lookaheadOnCanonicalTfs: ['60m'],
    requested: { from: 0, to: 6_300 },
    complete: true,
    gaps: [],
  });
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, resolved)).not.toThrow();
  const local = await new LocalRunner().run({ ...resolved, magnifier: undefined });
  expect(local.plots.find((plot) => plot.title === 'x')?.data).toEqual([sourceBar.close]);

  const empty = immutableBarsFixture([]);
  const forgedPartial = reboundSecurityProof(resolved.securityProofs!.B!, empty, {
    requested: deepFreezeFixture({ from: 0, to: 1_800 }),
    covered: deepFreezeFixture([{ from: 0, to: 1_800 }]),
    gaps: deepFreezeFixture([]),
    complete: true,
    provenance: deepFreezeFixture({
      ...resolved.securityProofs!.B!.provenance,
      alignment: 'exchange-calendar:partial-final-runtime-bucket@1',
    }),
    alignmentEvidence: deepFreezeFixture({
      kind: 'exchange-calendar' as const,
      calendar: partialCalendar,
    }),
  });
  try {
    assertResolvedSecurityForBarMagnifier(source, dependencies, {
      ...resolved,
      securityBars: { B: empty },
      securityProofs: { B: forgedPartial },
    });
    throw new Error('expected partial exchange lookahead proof rejection');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'unresolved-static-security-with-bar-magnifier',
      permanent: true,
      details: {
        invalid: [
          expect.objectContaining({
            key: 'B',
            reasons: expect.arrayContaining([
              'resolver-authentication',
              'lookahead-range-evidence',
            ]),
          }),
        ],
      },
    });
  }
});

test('exchange lookahead keys the final runtime bucket from the chart open across UTC boundaries', async () => {
  const source = `//@version=6
strategy("shifted exchange lookahead")
x = request.security("B", "60", close, lookahead=barmerge.lookahead_on)
plot(x, "x")`;
  const dependencies = compilerDependencies(source);
  const sourceBar = spacedBars(1, 3_600, 9, 2_700)[0]!;
  const calendar = deepFreezeFixture({
    calendarId: 'shifted-cross-boundary-session',
    version: '1',
    coverage: { from: 0, to: 6_300 },
    sessions: [{ from: 2_700, to: 6_300 }],
  }) as HistorySessionCalendar;
  const job: Job = {
    source,
    symbol: 'A',
    timeframe: '60',
    bars: spacedBars(1, 3_600, 100, 2_700),
    magnifier: { chartCloseTimesMs: [6_300_000] } as ResolvedMagnifierDataset,
  };

  await resolveSecurity(
    source,
    [job],
    '1h',
    '60',
    new StaticProvider(
      { 'B|60m': [sourceBar] },
      {
        alignment: 'exchange-calendar',
        calendar,
        timeframes: ['60m'],
        cacheIdentity: 'shifted-exchange-lookahead',
      },
    ),
    {
      concurrency: 1,
      range: { from: 2_700, to: 6_299 },
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    },
  );

  expect(job.securityProofs?.B).toMatchObject({
    lookaheadOnCanonicalTfs: ['60m'],
    requested: { from: 0, to: 6_300 },
    complete: true,
    gaps: [],
  });
  // This is the serialized execution-proof calculation as well as the resolver path:
  // piner keys the bar to [0, 3600) from open 2700, not [3600, 7200) from close 6300.
  expect(() => assertResolvedSecurityForBarMagnifier(source, dependencies, job)).not.toThrow();
  const local = await new LocalRunner().run({ ...job, magnifier: undefined });
  expect(local.plots.find((plot) => plot.title === 'x')?.data).toEqual([sourceBar.close]);
});
