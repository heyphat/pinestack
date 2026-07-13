import { test, expect } from 'bun:test';
import { StaticProvider, type Bar, type HistoryProvider, type HistoryRange } from '@heyphat/pinery';
import {
  scan,
  LocalRunner,
  jobHash,
  resolveLowerFetchTf,
  classifyRequests,
  PROBE_SYMBOL,
} from '../src/index.js';
import { DAY1, hourly } from './fixtures.js';

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
import { resolveSecurity, planFromStatic } from '../src/index.js';

test('planFromStatic classifies without a run; null when dynamic', () => {
  const empty = { crossHtf: [], crossLtf: [], selfLtfRawTfs: [], selfPlainRawTfs: [] };
  expect(planFromStatic([], '1h')).toEqual(empty);
  expect(
    planFromStatic([{ lowerTf: false, self: false, symbol: 'AAPL', timeframe: 'D', dynamic: false }], '1h'),
  ).toEqual({ ...empty, crossHtf: ['AAPL'] });
  expect(
    planFromStatic([{ lowerTf: true, self: true, symbol: null, timeframe: '1', dynamic: false }], '1h'),
  ).toEqual({ ...empty, selfLtfRawTfs: ['1'] });
  expect(
    planFromStatic([{ lowerTf: true, self: false, symbol: 'MSFT', timeframe: '5', dynamic: false }], '1h'),
  ).toEqual({ ...empty, crossLtf: [{ symbol: 'MSFT', rawTf: '5' }] });
  // self plain to a HIGHER-than-chart TF → fetched (real series beats resampling)
  expect(
    planFromStatic([{ lowerTf: false, self: true, symbol: null, timeframe: 'D', dynamic: false }], '1h'),
  ).toEqual({ ...empty, selfPlainRawTfs: ['D'] });
  // self plain at the chart's own TF → no fetch (piner passes it through)
  expect(
    planFromStatic([{ lowerTf: false, self: true, symbol: null, timeframe: '60', dynamic: false }], '1h'),
  ).toEqual(empty);
  // any dynamic → needs discovery
  expect(
    planFromStatic([{ lowerTf: false, self: false, symbol: 'AAPL', timeframe: null, dynamic: true }], '1h'),
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
