import { describe, expect, test } from 'bun:test';
import {
  ExactHistoryError,
  StaticProvider,
  canonicalTimeframeSecondsExact,
  pineTimeframeToCanonicalExact,
  type Bar,
  type HistoryProvider,
  type HistoryRange,
  type ResolvedHistorySource,
} from '@heyphat/pinery';
import {
  LocalRunner,
  assertWalkforwardMagnifierCap,
  backtest,
  formatFillModel,
  inspectWalkforwardMagnifierCap,
  parseAxes,
  pinerCapabilities,
  portfolio,
  scan,
  sweep,
  walkforward,
  type Job,
  type ResolvedMagnifierDataset,
  type Runner,
  type RunResult,
} from '../src/index.js';
import { WorkerPoolRunner } from '../src/node.js';

// Hour-aligned. The exact resolver authenticates chart opens against the UTC
// fixed-duration grid, so a T0 that is 800s past the hour (1_700_000_000) is
// correctly rejected with chart-fixed-grid-mismatch.
const T0 = 1_699_999_200;
const MAGNIFIER_CAPABLE = pinerCapabilities().capable;
const exactTest = MAGNIFIER_CAPABLE ? test : test.skip;

const STRATEGY_ON = `//@version=6
strategy("magnified", use_bar_magnifier=true, initial_capital=10000)
bias = input.int(0, "bias")
if bar_index == 1
    strategy.entry("L", strategy.long)
if bar_index == 8
    strategy.close("L")
plot(close + bias, "value")
`;

const STRATEGY_OFF = STRATEGY_ON.replace('use_bar_magnifier=true', 'use_bar_magnifier=false');

const INDICATOR = `//@version=6
indicator("indicator")
len = input.int(2, "len")
plot(ta.sma(close, len))
`;

const DYNAMIC_SECURITY = `//@version=6
strategy("dynamic", use_bar_magnifier=true)
tf = input.string("D", "tf")
dep = request.security("AAPL", tf, close)
plot(dep)
`;

function bars(count: number, start = T0, step = 3_600, base = 100): Bar[] {
  return Array.from({ length: count }, (_, index) => {
    const value = base + index * 0.1;
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

function targetInfo(): { pine: string; canonical: string; seconds: number } {
  const pine = pinerCapabilities().mapTargetTimeframe('60');
  const canonical = pineTimeframeToCanonicalExact(pine);
  if (canonical.kind !== 'ok') throw new Error(canonical.message);
  const seconds = canonicalTimeframeSecondsExact(canonical.value);
  if (seconds.kind !== 'ok') throw new Error(seconds.message);
  return { pine, canonical: canonical.value, seconds: seconds.value };
}

function exactStaticProvider(
  symbols: readonly string[],
  chartCount = 24,
  starts: Readonly<Record<string, number>> = {},
  identity = `exact-${symbols.join('-')}-${chartCount}`,
): StaticProvider {
  const target = targetInfo();
  const seed: Record<string, Bar[]> = {};
  for (const [symbolIndex, symbol] of symbols.entries()) {
    const start = starts[symbol] ?? T0;
    seed[`${symbol}|1h`] = bars(chartCount, start, 3_600, 100 + symbolIndex * 20);
    const targetCount = (chartCount * 3_600) / target.seconds;
    if (!Number.isInteger(targetCount)) throw new Error('test target timeframe must divide 1h');
    seed[`${symbol}|${target.canonical}`] = bars(
      targetCount,
      start,
      target.seconds,
      10 + symbolIndex * 20,
    );
  }
  return new StaticProvider(seed, {
    alignment: 'utc-24x7',
    timeframes: ['1h', target.canonical],
    cacheIdentity: identity,
  });
}

class TrackingProvider implements HistoryProvider {
  readonly id = 'tracking';
  readonly historyCalls: { symbol: string; timeframe: string; range?: HistoryRange }[] = [];
  readonly sourceCalls: string[] = [];

  constructor(
    readonly inner: StaticProvider,
    readonly failExactSymbol?: string,
  ) {}

  history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    this.historyCalls.push({ symbol, timeframe, range });
    return this.inner.history(symbol, timeframe, range);
  }

  async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
    this.sourceCalls.push(symbol);
    if (symbol === this.failExactSymbol) {
      throw new ExactHistoryError({
        kind: 'provider-limited',
        code: 'fixture-exact-unavailable',
        message: `fixture exact data unavailable for ${symbol}`,
        details: { symbol },
      });
    }
    // Exact acquisition fetches through the RESOLVED source, not the legacy
    // history() API — without wrapping it here `historyCalls` never sees the
    // exact-security fetch at all and range assertions silently inspect nothing.
    const source = await this.inner.resolveHistorySource(symbol);
    const calls = this.historyCalls;
    return {
      ...source,
      history: (request) => {
        // HistoryRequest carries half-open {from,to} bounds in `requested`; the
        // legacy history() API carries a HistoryRange. Record the exact path's
        // bounds so a `limit` forwarded into exact acquisition would be visible.
        calls.push({
          symbol,
          timeframe: request.timeframe,
          range: request.requested as unknown as HistoryRange,
        });
        return source.history(request);
      },
    };
  }

  instrument(symbol: string) {
    return this.inner.instrument(symbol);
  }
}

function stableResult(result: RunResult): Omit<RunResult, 'elapsedMs'> {
  const { elapsedMs: _elapsedMs, ...stable } = result;
  return stable;
}

describe('Bar Magnifier command APIs', () => {
  test('reject nonboolean overrides before provider I/O on every override-capable API', async () => {
    let fetched = 0;
    const provider: HistoryProvider = {
      id: 'must-not-fetch',
      async history() {
        fetched++;
        return [];
      },
    };
    const invalid = '10m' as unknown as boolean;

    await expect(
      backtest({
        source: STRATEGY_OFF,
        symbol: 'A',
        timeframe: '1h',
        provider,
        useBarMagnifier: invalid,
      }),
    ).rejects.toThrow('useBarMagnifier must be true, false, or undefined');
    await expect(
      scan({
        source: STRATEGY_OFF,
        symbols: ['A'],
        timeframe: '1h',
        provider,
        useBarMagnifier: invalid,
      }),
    ).rejects.toThrow('useBarMagnifier must be true, false, or undefined');
    await expect(
      sweep({
        source: STRATEGY_OFF,
        symbol: 'A',
        timeframe: '1h',
        provider,
        axes: parseAxes(['bias=0']),
        useBarMagnifier: invalid,
      }),
    ).rejects.toThrow('useBarMagnifier must be true, false, or undefined');
    await expect(
      walkforward({
        source: STRATEGY_OFF,
        symbol: 'A',
        timeframe: '1h',
        provider,
        axes: parseAxes(['bias=0']),
        useBarMagnifier: invalid,
      }),
    ).rejects.toThrow('useBarMagnifier must be true, false, or undefined');
    expect(fetched).toBe(0);
  });

  test('false override wins and never resolves/fetches exact data on any command path', async () => {
    const inner = new StaticProvider({ A: bars(80) });
    const provider = new TrackingProvider(inner);
    const common = { source: STRATEGY_ON, timeframe: '1h', provider, useBarMagnifier: false };

    expect((await backtest({ ...common, symbol: 'A' })).result?.ok).toBe(true);
    expect((await scan({ ...common, symbols: ['A'] })).results[0]?.ok).toBe(true);
    expect(
      (await sweep({ ...common, symbol: 'A', axes: parseAxes(['bias=0,1']) })).errors,
    ).toHaveLength(0);
    expect(
      (
        await walkforward({
          ...common,
          symbol: 'A',
          axes: parseAxes(['bias=0,1']),
          windows: 1,
        })
      ).aggregate.failed,
    ).toBe(0);
    expect(
      (
        await portfolio({
          source: STRATEGY_OFF,
          symbols: ['A'],
          timeframe: '1h',
          provider,
        })
      ).barMagnifier,
    ).toBeUndefined();

    expect(provider.sourceCalls).toEqual([]);
  });

  test('indicator force-on is a typed permanent preflight failure for every command', async () => {
    let fetched = 0;
    const provider: HistoryProvider = {
      id: 'must-not-fetch',
      async history() {
        fetched++;
        return bars(20);
      },
    };

    const backtestReport = await backtest({
      source: INDICATOR,
      symbol: 'A',
      timeframe: '1h',
      provider,
      useBarMagnifier: true,
    });
    expect(backtestReport.result?.failure).toMatchObject({
      type: 'bar-magnifier-error',
      code: 'bar-magnifier-strategy-only',
      permanent: true,
    });

    const scanReport = await scan({
      source: INDICATOR,
      symbols: ['A', 'B'],
      timeframe: '1h',
      provider,
      useBarMagnifier: true,
    });
    expect(scanReport.errors).toHaveLength(2);
    expect(
      scanReport.errors.every((result) => result.failure?.code === 'bar-magnifier-strategy-only'),
    ).toBe(true);

    const sweepReport = await sweep({
      source: INDICATOR,
      symbol: 'A',
      timeframe: '1h',
      provider,
      axes: parseAxes(['len=2,3']),
      useBarMagnifier: true,
    });
    expect(sweepReport.errors).toHaveLength(2);
    expect(sweepReport.points).toHaveLength(2);

    const walkforwardReport = await walkforward({
      source: INDICATOR,
      symbol: 'A',
      timeframe: '1h',
      provider,
      axes: parseAxes(['len=2,3']),
      useBarMagnifier: true,
    });
    expect(walkforwardReport.failure).toMatchObject({ code: 'bar-magnifier-strategy-only' });
    expect(fetched).toBe(0);
  });

  exactTest(
    'dynamic security rejection is typed consistently and retained by fan-out commands',
    async () => {
      const provider = new StaticProvider({ A: bars(80), B: bars(80, T0, 3_600, 120) });
      const expected = { code: 'dynamic-security-unsupported-with-bar-magnifier', permanent: true };

      const single = await backtest({
        source: DYNAMIC_SECURITY,
        symbol: 'A',
        timeframe: '1h',
        provider,
      });
      expect(single.result?.failure).toMatchObject(expected);

      const scanned = await scan({
        source: DYNAMIC_SECURITY,
        symbols: ['A', 'B'],
        timeframe: '1h',
        provider,
      });
      expect(scanned.results).toHaveLength(2);
      expect(scanned.ranked).toHaveLength(0);
      expect(scanned.errors.every((result) => result.failure?.code === expected.code)).toBe(true);

      const swept = await sweep({
        source: DYNAMIC_SECURITY,
        symbols: ['A', 'B'],
        timeframe: '1h',
        provider,
        axes: [],
      });
      expect(swept.points).toHaveLength(2);
      expect(swept.errors).toHaveLength(2);
      expect(swept.errors.every((result) => result.failure?.code === expected.code)).toBe(true);

      const walked = await walkforward({
        source: DYNAMIC_SECURITY,
        symbol: 'A',
        timeframe: '1h',
        provider,
        axes: [],
        windows: 2,
      });
      // A dynamic-security rejection is a PREFLIGHT verdict on the source and
      // config, not a per-window outcome: every window would carry the identical
      // failure. walkforward therefore reports it once at the report level and
      // plans no windows — explicit diagnostics, not a silently smaller universe
      // (plan §7.8). scan/sweep differ because their units genuinely are per
      // symbol / per combo.
      expect(walked.windows).toHaveLength(0);
      expect(walked.failure).toMatchObject(expected);

      await expect(
        portfolio({
          source: DYNAMIC_SECURITY,
          symbols: ['A', 'B'],
          timeframe: '1h',
          provider,
        }),
      ).rejects.toMatchObject(expected);
    },
  );

  exactTest(
    'command preflight uses lexical lookahead identity and preserves safe globals',
    async () => {
      const provider = exactStaticProvider(['A', 'AAPL'], 24, {}, 'lookahead-command');
      const safe = `//@version=6
strategy("safe global", use_bar_magnifier=true)
base = barmerge.lookahead_off
alias = base
la = true ? alias : barmerge.lookahead_on
plot(request.security("AAPL", timeframe.period, close, lookahead=la))`;
      const safeReport = await backtest({
        source: safe,
        symbol: 'A',
        timeframe: '1h',
        provider,
      });
      expect(safeReport.result?.ok).toBe(true);

      const dynamicLookaheads = [
        `//@version=6
strategy("udf shadow", use_bar_magnifier=true)
la = barmerge.lookahead_off
pick(la) => request.security("AAPL", "D", close, lookahead=la)
plot(pick(input.bool(false, "future")))`,
        `//@version=6
strategy("block shadow", use_bar_magnifier=true)
la = barmerge.lookahead_off
if bar_index > 0
    la = input.bool(false, "future") ? barmerge.lookahead_on : barmerge.lookahead_off
    plot(request.security("AAPL", "D", close, lookahead=la))`,
        `//@version=6
strategy("later reassignment", use_bar_magnifier=true)
la = barmerge.lookahead_off
plot(request.security("AAPL", "D", close, lookahead=la))
la := input.bool(false, "future") ? barmerge.lookahead_on : barmerge.lookahead_off`,
        `//@version=6
strategy("series ternary", use_bar_magnifier=true)
la = close > open ? barmerge.lookahead_on : barmerge.lookahead_off
plot(request.security("AAPL", "D", close, lookahead=la))`,
      ];
      for (const source of dynamicLookaheads) {
        const report = await backtest({ source, symbol: 'A', timeframe: '1h', provider });
        expect(report.result?.failure).toMatchObject({
          type: 'bar-magnifier-error',
          kind: 'unsupported',
          code: 'dynamic-security-unsupported-with-bar-magnifier',
          permanent: true,
        });
      }
    },
  );

  exactTest(
    'command rejects cross-symbol plain lower timeframe instead of false exactness',
    async () => {
      const provider = exactStaticProvider(['A', 'AAPL'], 24, {}, 'cross-lower-command');
      const source = `//@version=6
strategy("cross lower", use_bar_magnifier=true)
plot(request.security("AAPL", "5", close))`;
      const report = await backtest({ source, symbol: 'A', timeframe: '1h', provider });
      expect(report.result?.failure).toMatchObject({
        type: 'bar-magnifier-error',
        kind: 'unsupported',
        code: 'cross-symbol-plain-lower-timeframe-unsupported',
        permanent: true,
        details: expect.objectContaining({
          symbol: 'AAPL',
          requestedCanonicalTf: '5m',
          chartCanonicalTf: '60m',
        }),
      });
    },
  );

  exactTest(
    'scan and sweep retain a provider-limited symbol beside successful exact runs',
    async () => {
      const provider = new TrackingProvider(
        exactStaticProvider(['A', 'B'], 24, {}, 'partial-universe'),
        'B',
      );

      const scanned = await scan({
        source: STRATEGY_ON,
        symbols: ['A', 'B'],
        timeframe: '1h',
        provider,
        runner: new LocalRunner(),
      });
      expect(scanned.results.map((result) => result.symbol)).toEqual(['A', 'B']);
      expect(scanned.results[0]?.ok).toBe(true);
      expect(scanned.results[1]?.failure).toMatchObject({
        type: 'exact-history-error',
        kind: 'provider-limited',
        code: 'fixture-exact-unavailable',
      });
      expect(scanned.ranked.map((entry) => entry.result.symbol)).toEqual(['A']);

      const swept = await sweep({
        source: STRATEGY_ON,
        symbols: ['A', 'B'],
        timeframe: '1h',
        provider,
        axes: parseAxes(['bias=0,1']),
        runner: new LocalRunner(),
      });
      expect(swept.points).toHaveLength(4);
      expect(swept.points.slice(0, 2).every((point) => point.result.ok)).toBe(true);
      expect(
        swept.points
          .slice(2)
          .every((point) => point.result.failure?.code === 'fixture-exact-unavailable'),
      ).toBe(true);
      expect(swept.errors).toHaveLength(2);
    },
  );

  exactTest(
    'exact command resolution derives a full static-security range instead of forwarding limit',
    async () => {
      const target = targetInfo();
      const day = 86_400;
      const dayStart = Math.floor(T0 / day) * day;
      const chartStart = dayStart + 12 * 3_600;
      const chart = bars(2, chartStart);
      const provider = new TrackingProvider(
        new StaticProvider(
          {
            'A|1h': chart,
            [`A|${target.canonical}`]: bars(
              (2 * 3_600) / target.seconds,
              chartStart,
              target.seconds,
              20,
            ),
            // The exact resolver derives a range covering the containing row AND
            // its predecessors, so seed one more day than the chart window needs.
            'A|1d': [
              ...bars(1, dayStart - 2 * day, day, 70),
              ...bars(1, dayStart - day, day, 80),
              ...bars(1, dayStart, day, 90),
            ],
          },
          {
            alignment: 'utc-24x7',
            timeframes: ['1h', '1d', target.canonical],
            cacheIdentity: 'command-security-range',
          },
        ),
      );
      const source = `//@version=6
strategy("daily", use_bar_magnifier=true)
d = request.security(syminfo.tickerid, "D", close)
plot(d)
`;

      const report = await backtest({
        source,
        symbol: 'A',
        timeframe: '1h',
        provider,
        range: { limit: 1 },
      });
      expect(report.result?.ok).toBe(true);
      const securityFetch = provider.historyCalls.find((call) => call.timeframe === '1d');
      expect(securityFetch?.range).toMatchObject({
        from: expect.any(Number),
        to: expect.any(Number),
      });
      expect(securityFetch?.range?.limit).toBeUndefined();
    },
  );

  exactTest(
    'resolved exact data reports an ACTIVE magnifier and local/worker results agree',
    async () => {
      const provider = exactStaticProvider(['A'], 24, {}, 'worker-equality');
      const report = await backtest({
        source: STRATEGY_ON,
        symbol: 'A',
        timeframe: '1h',
        provider,
      });
      expect(report.result?.ok).toBe(true);
      // A capable engine with fully resolved exact data TRAVERSES. This asserted
      // active:false back when piner could not magnify; the gate is open now, so
      // the authoritative report is an active one and the fill-model line changes
      // with it.
      expect(report.result?.strategy?.barMagnifier).toMatchObject({
        requested: true,
        active: true,
        targetTimeframe: targetInfo().pine,
        magnifiedBars: 24,
        fallbackBars: 0,
        intrabarsUsed: 144,
        coverage: 'complete',
      });
      expect(formatFillModel(report.result!.strategy!).line).toContain(
        'fill model: bar magnifier',
      );
      // The "requested … inactive" wording belongs to the inactive presentation.
      // An active magnifier reports its coverage on the detail line instead.
      expect(formatFillModel(report.result!.strategy!).detail).toContain('coverage=complete');
      expect(formatFillModel(report.result!.strategy!).detail).toContain('144 intrabars');

      const local = await scan({
        source: STRATEGY_ON,
        symbols: ['A'],
        timeframe: '1h',
        provider,
        includeTrades: true,
        runner: new LocalRunner(),
      });
      const worker = new WorkerPoolRunner({ size: 1 });
      try {
        const threaded = await scan({
          source: STRATEGY_ON,
          symbols: ['A'],
          timeframe: '1h',
          provider,
          includeTrades: true,
          runner: worker,
        });
        expect(stableResult(threaded.results[0]!)).toEqual(stableResult(local.results[0]!));
      } finally {
        await worker.close();
      }
    },
  );

  exactTest(
    'portfolio resolves sleeves atomically without adding target times to its master clock',
    async () => {
      // Stagger by a WHOLE chart bar. T0 + 1_800 is half past the hour, which the
      // resolver correctly rejects on a 1h chart (chart-fixed-grid-mismatch); the
      // point of the fixture is offset sleeves, not off-grid ones.
      const starts = { A: T0, B: T0 + 3_600 };
      const provider = exactStaticProvider(['A', 'B'], 12, starts, 'portfolio-exact');
      const report = await portfolio({
        source: STRATEGY_ON,
        symbols: ['A', 'B'],
        timeframe: '1h',
        provider,
      });

      expect(report.symbols).toEqual(['A', 'B']);
      expect(report.sleeves.map((sleeve) => sleeve.symbol)).toEqual(['A', 'B']);
      const expectedTimes = [
        ...new Set([
          ...bars(12, starts.A).map((bar) => bar.time * 1_000),
          ...bars(12, starts.B).map((bar) => bar.time * 1_000),
        ]),
      ].sort((a, b) => a - b);
      expect(report.times).toEqual(expectedTimes);
      expect(report.times).not.toContain((T0 + targetInfo().seconds) * 1_000);

      // Both sleeves resolve exact data against a capable engine, so the aggregate
      // block is active; it was asserted inactive when piner could not magnify.
      expect(report.barMagnifier).toMatchObject({ active: true, coverage: 'complete' });
      expect(report.barMagnifier?.processedBars).toBe(
        report.sleeves.reduce((sum, sleeve) => sum + sleeve.barsProcessed, 0),
      );
      expect(report.barMagnifier?.coveragePercent).toBeGreaterThanOrEqual(0);
      expect(report.barMagnifier?.coveragePercent).toBeLessThanOrEqual(100);
      expect(report.sleeves.every((sleeve) => sleeve.barMagnifier?.active === true)).toBe(true);

      const atomic = new TrackingProvider(
        exactStaticProvider(['A', 'B'], 12, {}, 'portfolio-atomic'),
        'B',
      );
      await expect(
        portfolio({
          source: STRATEGY_ON,
          symbols: ['A', 'B'],
          timeframe: '1h',
          provider: atomic,
        }),
      ).rejects.toMatchObject({ code: 'fixture-exact-unavailable', permanent: true });
    },
  );
});

describe('Bar Magnifier summaries and walk-forward cap', () => {
  test('formats standard, requested-inactive, and authoritative active states distinctly', () => {
    expect(formatFillModel({}).line).toBe('fill model: standard chart OHLC');
    expect(
      formatFillModel({
        barMagnifier: {
          requested: true,
          active: false,
          targetTimeframe: '10',
          magnifiedBars: 0,
          fallbackBars: 10,
          capFallbackBars: 0,
          dataFallbackBars: 0,
          intrabarsUsed: 0,
          coverage: 'no-data',
        },
      }),
    ).toEqual({
      line: 'fill model: standard chart OHLC (bar magnifier requested for 10m; inactive, no covered bars)',
    });
    expect(
      formatFillModel({
        calcOnOrderFills: true,
        barMagnifier: {
          requested: true,
          active: true,
          targetTimeframe: '10',
          magnifiedBars: 8_120,
          fallbackBars: 1_880,
          capFallbackBars: 1_880,
          dataFallbackBars: 0,
          intrabarsUsed: 48_720,
          coverage: 'tv-cap-fallback',
        },
      }),
    ).toEqual({
      line: 'fill model: bar magnifier + calc on order fills',
      detail:
        'magnifier: 10m; 8,120/10,000 chart bars (81.20%); 48,720 intrabars; coverage=tv-cap-fallback',
    });
  });

  test('walk-forward cap is inclusive at 200,000 and typed above it, including boundary-inside-IS', () => {
    const dataset = (count: number, closes: number[]): ResolvedMagnifierDataset =>
      ({
        contractVersion: 1,
        mappingVersion: 1,
        requestedSymbol: 'A',
        targetPineTf: '1',
        targetCanonicalTf: '1m',
        sourceCanonicalTf: '1m',
        barsMs: bars(count, 0, 60).map((bar) => ({ ...bar, time: bar.time * 1_000 })),
        chartOpenTimesMs: closes.map((_, index) =>
          index === 0 ? 0 : closes[index - 1]!,
        ) as ResolvedMagnifierDataset['chartOpenTimesMs'],
        chartCloseTimesMs: closes,
        chartIntervalSource: 'host-explicit',
        coverage: {
          requested: { from: 0, to: closes.at(-1)! },
          covered: [],
          gaps: [],
          complete: true,
        },
        provenance: {} as ResolvedMagnifierDataset['provenance'],
        acquisitionKey: `cap-${count}`,
      }) as ResolvedMagnifierDataset;

    for (const count of [199_999, 200_000]) {
      const observed = inspectWalkforwardMagnifierCap(
        dataset(count, [count * 60_000]),
        bars(1, 0),
        0,
      );
      expect(observed.eligibleTargetBars).toBe(count);
      expect(observed.exceeded).toBe(false);
      expect(() =>
        assertWalkforwardMagnifierCap(dataset(count, [count * 60_000]), bars(1, 0), 0, 0),
      ).not.toThrow();
    }

    const chart = [bars(1, 0)[0]!, bars(1, 6_000_000)[0]!, bars(1, 9_000_000)[0]!];
    const over = dataset(200_001, [3_600_000, 7_200_000, 200_001 * 60_000]);
    const observed = inspectWalkforwardMagnifierCap(over, chart, 2);
    expect(observed).toMatchObject({
      eligibleTargetBars: 200_001,
      exceeded: true,
      boundaryInsideIs: true,
    });
    try {
      assertWalkforwardMagnifierCap(over, chart, 2, 3);
      throw new Error('expected cap rejection');
    } catch (error) {
      expect(error).toMatchObject({
        type: 'bar-magnifier-error',
        kind: 'unsupported',
        code: 'walkforward-bar-magnifier-target-cap-exceeded',
        permanent: true,
        details: expect.objectContaining({
          fold: 3,
          eligibleTargetBars: 200_001,
          boundaryInsideIs: true,
        }),
      });
    }
  });

  exactTest('walk-forward rejects an over-cap full fold before candidate ranking', async () => {
    const target = targetInfo();
    const perChart = 3_600 / target.seconds;
    if (!Number.isInteger(perChart)) throw new Error('test target timeframe must divide 1h');
    const chartCount = Math.ceil(200_001 / perChart);
    const eligibleTargetBars = chartCount * perChart;
    const provider = new StaticProvider(
      {
        'A|1h': bars(chartCount),
        [`A|${target.canonical}`]: bars(eligibleTargetBars, T0, target.seconds, 10),
      },
      {
        alignment: 'utc-24x7',
        timeframes: ['1h', target.canonical],
        cacheIdentity: 'walkforward-over-cap',
      },
    );
    let candidateRuns = 0;
    const runner: Runner = {
      async run(_job: Job): Promise<RunResult> {
        candidateRuns++;
        throw new Error('candidate ranking must not start');
      },
      async runAll(_jobs: Job[]): Promise<RunResult[]> {
        candidateRuns++;
        throw new Error('candidate ranking must not start');
      },
    };

    const report = await walkforward({
      source: STRATEGY_ON,
      symbol: 'A',
      timeframe: '1h',
      provider,
      axes: parseAxes(['bias=0,1']),
      windows: 1,
      runner,
    });
    expect(candidateRuns).toBe(0);
    expect(report.windows[0]?.failure).toMatchObject({
      code: 'walkforward-bar-magnifier-target-cap-exceeded',
      permanent: true,
      details: expect.objectContaining({
        eligibleTargetBars,
        boundaryInsideIs: true,
      }),
    });
  });
});

exactTest(
  'under-cap magnified walk-forward executes with resolver-issued prefixes locally and in workers',
  async () => {
    const start = 1_700_002_800;
    const provider = exactStaticProvider(['A'], 24, { A: start }, 'walkforward-prefix-authority');
    const options = {
      source: STRATEGY_ON,
      symbol: 'A',
      timeframe: '1h',
      provider,
      axes: parseAxes(['bias=0,1']),
      windows: 1,
      oosFraction: 0.25,
    } as const;

    const local = await walkforward({ ...options, runner: new LocalRunner() });
    expect(local.aggregate.failed).toBe(0);
    expect(local.windows[0]?.failure).toBeUndefined();
    expect(local.windows[0]?.result?.ok).toBe(true);

    const worker = new WorkerPoolRunner({ size: 1 });
    try {
      const threaded = await walkforward({ ...options, runner: worker });
      expect(threaded.aggregate.failed).toBe(0);
      expect(threaded.windows[0]?.failure).toBeUndefined();
      expect(threaded.windows[0]?.result?.ok).toBe(true);
      expect(threaded.windows[0]?.winnerId).toBe(local.windows[0]?.winnerId);
      expect(stableResult(threaded.windows[0]!.result!)).toEqual(
        stableResult(local.windows[0]!.result!),
      );
    } finally {
      await worker.close();
    }
  },
  20_000,
);
