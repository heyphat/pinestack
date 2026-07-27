import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '@heyphat/piner';
import {
  StaticProvider,
  halfOpenIntervalSec,
  unixSecond,
  type Bar,
  type HistoryProvider,
  type HistoryRange,
  type HistoryRequest,
  type ResolvedHistorySource,
} from '@heyphat/pinery';
import { cached } from '@heyphat/pinery/node';
import {
  BarMagnifierError,
  assertResolvedMagnifierDatasetForJob,
  createMagnifierResolutionScope,
  createPinerCapabilityAdapter,
  magnifierAcquisitionKey,
  magnifierDatasetAcquisitionKey,
  magnifierMetadataKey,
  pinerCapabilities,
  preflightBarMagnifier,
  executeJob,
  projectAuthoritativeBarMagnifierReport,
  resolveBarMagnifier,
  toPinerBarMagnifierData,
} from '../src/index.js';
import type { Job, ResolvedMagnifierDataset } from '../src/job.js';
import {
  deriveResolverIssuedMagnifierPrefix,
  isResolverIssuedMagnifierDataset,
} from '../src/magnifier.js';
import { jobHash, marketDataDigest } from '../src/hash.js';

const STRATEGY_ON = '//@version=6\nstrategy("magnified", use_bar_magnifier=true)\nplot(close)';
const STRATEGY_OFF = '//@version=6\nstrategy("plain", use_bar_magnifier=false)\nplot(close)';

function capableRuntime(targetPineTf = '10') {
  let compileCalls = 0;
  class Context {
    magnifierData: unknown = null;
  }
  class Broker {
    host: unknown;
    settings: Record<string, unknown> = { useBarMagnifier: false };
    configure(value: Record<string, unknown>) {
      Object.assign(this.settings, value);
    }
    report() {
      return this.settings.useBarMagnifier === true
        ? {
            barMagnifier: {
              requested: true,
              active: false,
              targetTimeframe: targetPineTf,
              magnifiedBars: 0,
              fallbackBars: 0,
              capFallbackBars: 0,
              dataFallbackBars: 0,
              intrabarsUsed: 0,
              coverage: 'no-data',
            },
          }
        : {};
    }
  }
  const runtime = {
    BAR_MAGNIFIER_CONTRACT_VERSION: 1,
    BAR_MAGNIFIER_MAPPING_VERSION: 1,
    barMagnifierTimeframe: (_chartTf: string) => targetPineTf,
    ExecutionContext: Context,
    StrategyBroker: Broker,
    compile(source: string) {
      compileCalls++;
      const isStrategy = !source.includes('indicator(');
      return {
        metadata: {
          isStrategy,
          strategy: isStrategy
            ? { useBarMagnifier: /use_bar_magnifier\s*=\s*true/.test(source) }
            : undefined,
          securityDependencies: [],
        },
      };
    },
  };
  return { runtime, compileCalls: () => compileCalls };
}

function capableRuntimeWithPinerMetadata(additiveMetadata = true) {
  const fake = capableRuntime();
  return {
    ...fake.runtime,
    compile(source: string) {
      const compiled = compile(source);
      return {
        ...compiled,
        metadata: {
          ...compiled.metadata,
          strategy: compiled.metadata.isStrategy
            ? {
                ...compiled.metadata.strategy,
                useBarMagnifier: /use_bar_magnifier\s*=\s*true/.test(source),
              }
            : undefined,
          // Test-only structural fixture for piner's additive exact-security
          // fields; dependency identity/order still comes from the compiler.
          securityDependencies: additiveMetadata
            ? compiled.metadata.securityDependencies.map((dependency) => ({
                ...dependency,
                lookahead: dependency.lowerTf ? null : false,
                expressionPriorBars: /close\[3\]/.test(source) ? 3 : 0,
              }))
            : compiled.metadata.securityDependencies,
        },
      };
    },
  };
}

function bar(time: number, value: number): Bar {
  return {
    time,
    open: value,
    high: value + 1,
    low: value - 1,
    close: value + 0.25,
    volume: value * 10,
  };
}

function chartBars(count = 2): Bar[] {
  return Array.from({ length: count }, (_, index) => bar(index * 3600, 100 + index));
}

function targetBars(count = 12): Bar[] {
  return Array.from({ length: count }, (_, index) => bar(index * 600, 10 + index));
}

function deepFreezeFixture<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeFixture(child, seen);
  }
  return Object.freeze(value);
}

function reboundMagnifierDataset(
  base: ResolvedMagnifierDataset,
  barsMs: readonly Readonly<Bar>[],
  patch: Partial<Omit<ResolvedMagnifierDataset, 'barsMs' | 'barsDigest' | 'acquisitionKey'>> = {},
  freeze = true,
): ResolvedMagnifierDataset {
  const { acquisitionKey: _oldKey, barsDigest: _oldDigest, ...baseBound } = base;
  const bound = {
    ...baseBound,
    barsMs,
    barsDigest: marketDataDigest(barsMs),
    ...patch,
  };
  const dataset = {
    ...bound,
    acquisitionKey: magnifierDatasetAcquisitionKey(bound),
  } as ResolvedMagnifierDataset;
  return freeze ? deepFreezeFixture(dataset) : dataset;
}

class CountingExactProvider implements HistoryProvider {
  readonly id = 'counting-exact';
  resolveCalls = 0;
  exactCalls = 0;
  legacyCalls = 0;

  constructor(
    private readonly inner: StaticProvider,
    public failuresRemaining = 0,
  ) {}

  history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    this.legacyCalls++;
    return this.inner.history(symbol, timeframe, range);
  }

  async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
    this.resolveCalls++;
    const source = await this.inner.resolveHistorySource(symbol);
    return {
      ...source,
      history: async (request: HistoryRequest) => {
        this.exactCalls++;
        if (this.failuresRemaining > 0) {
          this.failuresRemaining--;
          throw new Error('transient exact fixture failure');
        }
        return source.history(request);
      },
    };
  }
}

describe('piner Bar Magnifier capability adapter and preflight', () => {
  test('detects every capable contract seam and caches one metadata compile per key', () => {
    const fake = capableRuntime();
    const adapter = createPinerCapabilityAdapter(fake.runtime);
    expect(adapter).toMatchObject({
      contractVersion: 1,
      mappingVersion: 1,
      hasMapper: true,
      hasMetadataSetting: true,
      hasReportBlock: true,
      hasDataInjection: true,
      capable: true,
    });
    const afterProbe = fake.compileCalls();
    const first = preflightBarMagnifier(STRATEGY_ON, '60', undefined, adapter);
    const second = preflightBarMagnifier(STRATEGY_ON, '60', undefined, adapter);
    expect(second).toBe(first);
    expect(fake.compileCalls()).toBe(afterProbe + 1);
    expect(first).toMatchObject({
      sourceRequested: true,
      requested: true,
      targetPineTf: '10',
      contractVersion: 1,
      mappingVersion: 1,
    });
  });

  test('requested preflight rejects missing exact-security compiler metadata before provider I/O', async () => {
    const adapter = createPinerCapabilityAdapter(capableRuntimeWithPinerMetadata(false));
    const source = `//@version=6
strategy("old compiler metadata", use_bar_magnifier=true)
plot(request.security("B", "60", close))`;
    const provider = new CountingExactProvider(
      new StaticProvider(
        {},
        { alignment: 'utc-24x7', timeframes: ['10m', '1h'], cacheIdentity: 'must-not-read' },
      ),
    );
    const job: Job = {
      source,
      symbol: 'A',
      timeframe: '60',
      bars: chartBars(),
    };

    await expect(resolveBarMagnifier(job, '1h', provider, { adapter })).rejects.toMatchObject({
      type: 'bar-magnifier-error',
      kind: 'unsupported',
      code: 'static-security-compiler-metadata-unavailable',
      permanent: true,
    });
    expect(provider.resolveCalls).toBe(0);
    expect(provider.exactCalls).toBe(0);
    expect(provider.legacyCalls).toBe(0);
  });

  test('requested preflight rejects an absent compiler dependency array before provider I/O', async () => {
    const fake = capableRuntime();
    const runtime = {
      ...fake.runtime,
      compile(source: string) {
        const compiled = fake.runtime.compile(source);
        const { securityDependencies: _missing, ...metadata } = compiled.metadata;
        return { ...compiled, metadata };
      },
    };
    const adapter = createPinerCapabilityAdapter(runtime);
    expect(adapter.capable).toBe(true);

    const provider = new CountingExactProvider(
      new StaticProvider(
        {},
        { alignment: 'utc-24x7', timeframes: ['10m'], cacheIdentity: 'missing-deps-array' },
      ),
    );
    const job: Job = {
      source: STRATEGY_ON,
      symbol: 'X',
      timeframe: '60',
      bars: chartBars(),
    };

    await expect(resolveBarMagnifier(job, '1h', provider, { adapter })).rejects.toMatchObject({
      type: 'bar-magnifier-error',
      kind: 'unsupported',
      code: 'static-security-compiler-metadata-unavailable',
      permanent: true,
      details: { missing: ['securityDependencies'] },
    });
    expect(provider.resolveCalls).toBe(0);
    expect(provider.exactCalls).toBe(0);
    expect(provider.legacyCalls).toBe(0);
    expect(preflightBarMagnifier(STRATEGY_ON, '60', false, adapter).requested).toBe(false);
  });

  test('old runtimes remain compatible when off and reject explicit/source requests typed', () => {
    const old = createPinerCapabilityAdapter({
      compile(source: string) {
        return {
          metadata: {
            isStrategy: source.includes('strategy('),
            strategy: {},
            securityDependencies: [],
          },
        };
      },
    });
    expect(old.capable).toBe(false);
    expect(preflightBarMagnifier(STRATEGY_OFF, '60', undefined, old).requested).toBe(false);
    expect(preflightBarMagnifier(STRATEGY_ON, '60', false, old).requested).toBe(false);
    expect(
      preflightBarMagnifier(
        '//@version=6\nstrategy("plain")\nuse_bar_magnifier = input.bool(false)\nplot(close)',
        '60',
        undefined,
        old,
      ).requested,
    ).toBe(false);
    for (const source of [
      '//@version=6\nstrategy("plain", use_bar_magnifier=not true)\nplot(close)',
      '//@version=6\nstrategy("plain", use_bar_magnifier=false and true)\nplot(close)',
      '//@version=6\nconst bool MAG=false\nstrategy("plain", use_bar_magnifier=MAG)\nplot(close)',
    ]) {
      expect(preflightBarMagnifier(source, '60', undefined, old).requested).toBe(false);
    }

    for (const [source, override] of [
      [STRATEGY_ON, undefined],
      ['//@version=6\nstrategy("plain", use_bar_magnifier=not false)\nplot(close)', undefined],
      [
        '//@version=6\nconst bool MAG=true\nstrategy("plain", use_bar_magnifier=MAG)\nplot(close)',
        undefined,
      ],
      [STRATEGY_OFF, true],
    ] as const) {
      try {
        preflightBarMagnifier(source, '60', override, old);
        throw new Error('expected capability rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(BarMagnifierError);
        expect(JSON.parse(JSON.stringify(error))).toMatchObject({
          type: 'bar-magnifier-error',
          code: 'piner-bar-magnifier-capability-unavailable',
          permanent: true,
        });
      }
    }
  });

  test('wraps mapper rejection as a typed permanent exact-mode failure', () => {
    const fake = capableRuntime();
    fake.runtime.barMagnifierTimeframe = () => {
      throw new Error('M8-gated terminal week/month range');
    };
    const adapter = createPinerCapabilityAdapter(fake.runtime);

    try {
      preflightBarMagnifier(STRATEGY_ON, '2W', undefined, adapter);
      throw new Error('expected mapper rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(BarMagnifierError);
      expect(JSON.parse(JSON.stringify(error))).toMatchObject({
        type: 'bar-magnifier-error',
        kind: 'unsupported',
        code: 'bar-magnifier-chart-timeframe-unsupported',
        permanent: true,
        details: { chartPineTf: '2W' },
      });
    }
  });

  test('host override wins over the header and an indicator cannot be forced on', () => {
    const { runtime } = capableRuntime();
    const adapter = createPinerCapabilityAdapter(runtime);
    expect(preflightBarMagnifier(STRATEGY_ON, '60', false, adapter)).toMatchObject({
      sourceRequested: true,
      requested: false,
    });
    expect(preflightBarMagnifier(STRATEGY_OFF, '60', true, adapter)).toMatchObject({
      sourceRequested: false,
      requested: true,
    });
    expect(() =>
      preflightBarMagnifier('//@version=6\nindicator("x")\nplot(close)', '60', true, adapter),
    ).toThrow(BarMagnifierError);
  });
});

describe('exact magnifier resolver and reuse identity', () => {
  test('does no source resolution or fetch when the effective setting is off', async () => {
    const { runtime } = capableRuntime();
    const adapter = createPinerCapabilityAdapter(runtime);
    let calls = 0;
    const provider: HistoryProvider = {
      id: 'must-not-fetch',
      async history() {
        calls++;
        throw new Error('unexpected history');
      },
      async resolveHistorySource() {
        calls++;
        throw new Error('unexpected exact source resolution');
      },
    };
    const job: Job = {
      source: STRATEGY_OFF,
      symbol: 'X',
      timeframe: '60',
      bars: chartBars(),
    };
    const result = await resolveBarMagnifier(job, '1h', provider, { adapter });
    expect(result.dataset).toBeUndefined();
    expect(calls).toBe(0);
    expect(job.magnifier).toBeUndefined();
  });

  test('converts seconds once, deep-freezes, and shares only an equal full acquisition key', async () => {
    const { runtime } = capableRuntime();
    const adapter = createPinerCapabilityAdapter(runtime);
    const provider = new CountingExactProvider(
      new StaticProvider(
        { 'X|10m': targetBars() },
        { alignment: 'utc-24x7', timeframes: ['10m'], cacheIdentity: 'feed-a' },
      ),
    );
    const sharedChart = chartBars();
    const first: Job = {
      source: STRATEGY_ON,
      symbol: 'X',
      timeframe: '60',
      bars: sharedChart,
    };
    const second: Job = { ...first, id: 'combo-2' };
    const scope = createMagnifierResolutionScope();

    const a = await resolveBarMagnifier(first, '1h', provider, { adapter, scope });
    const b = await resolveBarMagnifier(second, '1h', provider, { adapter, scope });
    expect(a.dataset).toBeDefined();
    expect(b.dataset).toBe(a.dataset);
    expect(first.magnifier).toBe(second.magnifier);
    expect(provider.exactCalls).toBe(1);
    expect(provider.legacyCalls).toBe(0);

    const dataset = a.dataset!;
    expect(dataset.requestedSymbol).toBe('X');
    expect(dataset.targetPineTf).toBe('10');
    expect(dataset.targetCanonicalTf).toBe('10m');
    expect(dataset.sourceCanonicalTf).toBe('10m');
    expect(dataset.barsMs[0]!.time).toBe(0);
    expect(dataset.barsMs[1]!.time).toBe(600_000);
    expect(dataset.chartOpenTimesMs).toEqual([0, 3_600_000]);
    expect(dataset.chartCloseTimesMs).toEqual([3_600_000, 7_200_000]);
    expect(dataset.coverage.requested).toEqual({ from: 0, to: 7_200_000 });
    expect(dataset.barsDigest).toBe(marketDataDigest(dataset.barsMs));
    expect(dataset.alignmentEvidence).toEqual({ kind: 'utc-24x7' });
    expect(dataset.acquisitionKey).toStartWith('magnifier-dataset-acquisition-v3:');
    expect(dataset.acquisitionKey).toBe(magnifierDatasetAcquisitionKey(dataset));
    expect(Object.isFrozen(dataset)).toBe(true);
    expect(Object.isFrozen(dataset.coverage)).toBe(true);
    expect(Object.isFrozen(dataset.alignmentEvidence)).toBe(true);
    expect(Object.isFrozen(dataset.barsMs)).toBe(true);
    expect(Object.isFrozen(dataset.barsMs[0])).toBe(true);

    const channel = toPinerBarMagnifierData(dataset);
    expect(channel.bars).toBe(dataset.barsMs);
    expect(channel.chartIntervals.closeTimes).toBe(dataset.chartCloseTimesMs);
    expect(assertResolvedMagnifierDatasetForJob(first, a.preflight)).toBe(dataset);
    try {
      assertResolvedMagnifierDatasetForJob({ ...first, symbol: 'Y' }, a.preflight);
      throw new Error('expected cross-symbol dataset rejection');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid-injected-bar-magnifier-data',
        permanent: true,
        details: { mismatches: ['requested-symbol'] },
      });
    }

    for (const [candidate, expectedMismatch] of [
      [{ ...first, bars: chartBars(1) }, 'chart-open-count'],
      [
        {
          ...first,
          bars: first.bars.map((row) => ({ ...row, time: row.time + 7_200 })),
        },
        'chart-open-boundary',
      ],
      [
        {
          ...first,
          magnifier: {
            ...dataset,
            chartCloseTimesMs: [
              dataset.chartCloseTimesMs[0]! - 1_000,
              dataset.chartCloseTimesMs[1]!,
            ] as ResolvedMagnifierDataset['chartCloseTimesMs'],
          },
        },
        'chart-close-boundary',
      ],
      [
        {
          ...first,
          magnifier: {
            ...dataset,
            coverage: {
              ...dataset.coverage,
              requested: {
                from: dataset.coverage.requested.from + 1_000,
                to: dataset.coverage.requested.to,
              } as ResolvedMagnifierDataset['coverage']['requested'],
            },
          },
        },
        'coverage-requested-envelope',
      ],
      [
        {
          ...first,
          magnifier: { ...dataset, acquisitionKey: `${dataset.acquisitionKey}:tampered` },
        },
        'acquisition-identity',
      ],
      [
        {
          ...first,
          magnifier: { ...dataset, targetCanonicalTf: '5m' },
        },
        'target-canonical-timeframe',
      ],
    ] as const) {
      try {
        assertResolvedMagnifierDatasetForJob(candidate, a.preflight);
        throw new Error('expected chart-envelope rejection');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'invalid-injected-bar-magnifier-data',
          permanent: true,
          details: { mismatches: expect.arrayContaining([expectedMismatch]) },
        });
      }
    }

    const shorter: Job = { ...first, id: 'short', bars: chartBars(1), magnifier: undefined };
    const c = await resolveBarMagnifier(shorter, '1h', provider, { adapter, scope });
    expect(c.dataset).not.toBe(dataset);
    expect(provider.exactCalls).toBe(2);

    const refreshA: Job = { ...first, id: 'refresh-a', magnifier: undefined };
    const refreshB: Job = { ...first, id: 'refresh-b', magnifier: undefined };
    const uncachedA = await resolveBarMagnifier(refreshA, '1h', provider, { adapter });
    const uncachedB = await resolveBarMagnifier(refreshB, '1h', provider, { adapter });
    expect(uncachedB.dataset).not.toBe(uncachedA.dataset);
    expect(provider.exactCalls).toBe(4);
  });

  test('rejects sparse, mutable, recomputed, and forged-authority magnifier envelopes', async () => {
    const adapter = createPinerCapabilityAdapter(capableRuntime().runtime);
    const provider = new StaticProvider(
      { 'X|10m': targetBars() },
      { alignment: 'utc-24x7', timeframes: ['10m'], cacheIdentity: 'attestation-attacks' },
    );
    const job: Job = {
      source: STRATEGY_ON,
      symbol: 'X',
      timeframe: '60',
      bars: chartBars(),
    };
    const resolution = await resolveBarMagnifier(job, '1h', provider, { adapter });
    const dataset = resolution.dataset!;

    expect(() => {
      (dataset.barsMs[0] as Bar).close += 1;
    }).toThrow();
    expect(() => {
      (dataset.coverage.covered as Array<unknown>).pop();
    }).toThrow();

    const assertInvalid = (candidate: ResolvedMagnifierDataset, expected: string[]): void => {
      try {
        assertResolvedMagnifierDatasetForJob(
          { ...job, magnifier: candidate },
          resolution.preflight,
        );
        throw new Error('expected magnifier attestation rejection');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'invalid-injected-bar-magnifier-data',
          permanent: true,
          details: { mismatches: expect.arrayContaining(expected) },
        });
      }
    };

    const sparse = reboundMagnifierDataset(
      dataset,
      dataset.barsMs.filter((_, index) => index !== 4),
    );
    assertInvalid(sparse, ['resolver-authentication', 'coverage-evidence']);

    const mutableBars = dataset.barsMs.map((row) => ({ ...row }));
    const mutable = reboundMagnifierDataset(dataset, mutableBars, {}, false);
    assertInvalid(mutable, ['dataset-not-deeply-immutable', 'resolver-authentication']);
    mutableBars[0]!.close += 0.1;
    assertInvalid(mutable, ['bars-digest']);

    const changedRows = dataset.barsMs.map((row, index) =>
      index === 0 ? { ...row, close: row.close + 0.1 } : { ...row },
    );
    const recomputed = reboundMagnifierDataset(dataset, changedRows);
    expect(recomputed.barsDigest).toBe(marketDataDigest(recomputed.barsMs));
    expect(recomputed.acquisitionKey).toBe(magnifierDatasetAcquisitionKey(recomputed));
    assertInvalid(recomputed, ['resolver-authentication']);

    const exactPublicClone = reboundMagnifierDataset(dataset, dataset.barsMs);
    expect(exactPublicClone).toEqual(dataset);
    expect(jobHash({ ...job, magnifier: exactPublicClone })).not.toBe(jobHash(job));
    assertInvalid(exactPublicClone, ['resolver-authentication']);
  });

  test('UTC week chart opens must match authenticated provider grid even with host closes', async () => {
    const week = 7 * 86_400;
    const mondayAnchor = unixSecond(4 * 86_400);
    const adapter = createPinerCapabilityAdapter(capableRuntime('60').runtime);
    const provider = new StaticProvider(
      {
        'X|1h': Array.from({ length: 7 * 24 }, (_, index) =>
          bar(mondayAnchor + index * 3_600, 10 + index),
        ),
      },
      {
        alignment: 'utc-24x7',
        weekAnchorSec: mondayAnchor,
        timeframes: ['1h'],
        cacheIdentity: 'weekly-chart-grid',
      },
    );
    const aligned: Job = {
      source: STRATEGY_ON,
      symbol: 'X',
      timeframe: 'W',
      bars: [bar(mondayAnchor, 100)],
    };
    const resolution = await resolveBarMagnifier(aligned, '1w', provider, { adapter });
    expect(resolution.dataset?.alignmentEvidence).toEqual({
      kind: 'utc-24x7',
      weekAnchorSec: mondayAnchor,
    });
    expect(() => assertResolvedMagnifierDatasetForJob(aligned, resolution.preflight)).not.toThrow();

    const tamperedEvidence = reboundMagnifierDataset(
      resolution.dataset!,
      resolution.dataset!.barsMs,
      { alignmentEvidence: deepFreezeFixture({ kind: 'utc-24x7', weekAnchorSec: unixSecond(0) }) },
    );
    try {
      assertResolvedMagnifierDatasetForJob(
        { ...aligned, magnifier: tamperedEvidence },
        resolution.preflight,
      );
      throw new Error('expected authenticated chart-grid rejection');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid-injected-bar-magnifier-data',
        details: {
          mismatches: expect.arrayContaining(['resolver-authentication', 'provenance-week-anchor']),
        },
      });
    }

    for (const options of [undefined, { chartCloseTimesSec: [week] }] as const) {
      const offGrid: Job = {
        source: STRATEGY_ON,
        symbol: 'X',
        timeframe: 'W',
        bars: [bar(0, 100)],
      };
      await expect(
        resolveBarMagnifier(offGrid, '1w', provider, {
          adapter,
          ...(options ?? {}),
        }),
      ).rejects.toMatchObject({
        type: 'bar-magnifier-error',
        kind: 'malformed',
        code: 'chart-week-grid-mismatch',
        permanent: true,
      });
      expect(offGrid.magnifier).toBeUndefined();
    }
  });

  test('failed scoped acquisition is evicted and a retry refetches', async () => {
    const adapter = createPinerCapabilityAdapter(capableRuntime().runtime);
    const provider = new CountingExactProvider(
      new StaticProvider(
        { 'X|10m': targetBars() },
        { alignment: 'utc-24x7', timeframes: ['10m'], cacheIdentity: 'retry-feed' },
      ),
      1,
    );
    const scope = createMagnifierResolutionScope();
    const job: Job = {
      source: STRATEGY_ON,
      symbol: 'X',
      timeframe: '60',
      bars: chartBars(),
    };

    await expect(resolveBarMagnifier(job, '1h', provider, { adapter, scope })).rejects.toThrow(
      'transient exact fixture failure',
    );
    await Promise.resolve();
    expect(scope.acquisitions.size).toBe(0);

    const retried = await resolveBarMagnifier(job, '1h', provider, { adapter, scope });
    expect(retried.dataset).toBeDefined();
    expect(provider.exactCalls).toBe(2);
    expect(scope.acquisitions.size).toBe(1);
  });

  test('refresh-backed equal-envelope operations refetch instead of using process-global data', async () => {
    const adapter = createPinerCapabilityAdapter(capableRuntime().runtime);
    const leaf = new CountingExactProvider(
      new StaticProvider(
        { 'X|10m': targetBars() },
        { alignment: 'utc-24x7', timeframes: ['10m'], cacheIdentity: 'refresh-feed' },
      ),
    );
    const dir = mkdtempSync(join(tmpdir(), 'pinerun-magnifier-refresh-'));
    try {
      const provider = cached(leaf, { dir, refresh: true });
      for (const id of ['refresh-1', 'refresh-2']) {
        await resolveBarMagnifier(
          {
            id,
            source: STRATEGY_ON,
            symbol: 'X',
            timeframe: '60',
            bars: chartBars(),
          },
          '1h',
          provider,
          { adapter },
        );
      }
      expect(leaf.exactCalls).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('advancing windows retain data only in their explicit operation scope', async () => {
    const adapter = createPinerCapabilityAdapter(capableRuntime().runtime);
    const provider = new CountingExactProvider(
      new StaticProvider(
        { 'X|10m': targetBars(60) },
        { alignment: 'utc-24x7', timeframes: ['10m'], cacheIdentity: 'window-feed' },
      ),
    );

    for (let window = 0; window < 5; window++) {
      const scope = createMagnifierResolutionScope();
      await resolveBarMagnifier(
        {
          id: `window-${window}`,
          source: STRATEGY_ON,
          symbol: 'X',
          timeframe: '60',
          bars: [bar(window * 3_600, 100), bar((window + 1) * 3_600, 101)],
        },
        '1h',
        provider,
        { adapter, scope },
      );
      expect(scope.acquisitions.size).toBe(1);
      scope.acquisitions.clear();
      expect(scope.acquisitions.size).toBe(0);
    }
    expect(provider.exactCalls).toBe(5);
  });

  test('provider calendar derives complete multi-session 2D and weekly closes', async () => {
    const adapter = createPinerCapabilityAdapter(capableRuntime('60').runtime);
    const day = 86_400;
    const firstOpen = 10 * day + 9 * 3_600;
    for (const testCase of [
      { pineTf: '2D', canonicalTf: '2d', nominalDays: 2, sessionDays: [0, 1] },
      { pineTf: 'W', canonicalTf: '1w', nominalDays: 7, sessionDays: [0, 1, 2, 3, 4] },
    ]) {
      const sessions = testCase.sessionDays.map((offset) =>
        halfOpenIntervalSec(firstOpen + offset * day, firstOpen + offset * day + 6 * 3_600),
      );
      const calendar = {
        calendarId: `weekday-${testCase.pineTf}`,
        version: '1',
        coverage: halfOpenIntervalSec(firstOpen, firstOpen + testCase.nominalDays * day),
        sessions,
      };
      const provider = new CountingExactProvider(
        new StaticProvider(
          {
            'X|1h': sessions.flatMap((session, sessionIndex) =>
              Array.from({ length: 6 }, (_, hour) =>
                bar(session.from + hour * 3_600, 10 + sessionIndex * 6 + hour),
              ),
            ),
          },
          {
            alignment: 'exchange-calendar',
            calendar,
            timeframes: ['1h'],
            cacheIdentity: `calendar-${testCase.pineTf}`,
          },
        ),
      );
      const job: Job = {
        source: STRATEGY_ON,
        symbol: 'X',
        timeframe: testCase.pineTf,
        bars: [bar(firstOpen, 100)],
      };

      const resolution = await resolveBarMagnifier(job, testCase.canonicalTf, provider, {
        adapter,
      });
      const expectedCloseMs = sessions.at(-1)!.to * 1_000;
      expect(resolution.dataset?.chartCloseTimesMs).toEqual([expectedCloseMs]);
      expect(resolution.dataset?.coverage.requested.to).toBe(expectedCloseMs);
      expect(resolution.dataset?.barsMs).toHaveLength(sessions.length * 6);
    }
  });

  test('authoritative exchange periods determine chart closes without leaking the next period', async () => {
    const adapter = createPinerCapabilityAdapter(capableRuntime('60').runtime);
    const firstBoundary = halfOpenIntervalSec(0, 82_800);
    const secondBoundary = halfOpenIntervalSec(82_800, 169_200);
    const calendar = {
      calendarId: 'declared-short-days',
      version: '1',
      coverage: halfOpenIntervalSec(0, 169_200),
      sessions: [halfOpenIntervalSec(0, 3_600), halfOpenIntervalSec(82_800, 86_400)],
      periods: { '1d': [firstBoundary, secondBoundary] },
    };
    const provider = new StaticProvider(
      { 'X|1h': [bar(0, 10), bar(82_800, 20)] },
      {
        alignment: 'exchange-calendar',
        calendar,
        timeframes: ['1h'],
        cacheIdentity: 'declared-period-closes',
      },
    );
    const job: Job = {
      source: STRATEGY_ON,
      symbol: 'X',
      timeframe: 'D',
      bars: [bar(0, 100), bar(82_800, 101)],
    };

    const resolution = await resolveBarMagnifier(job, '1d', provider, { adapter });
    expect(resolution.dataset?.chartCloseTimesMs).toEqual([3_600_000, 86_400_000]);
    expect(resolution.dataset?.coverage.requested).toEqual({ from: 0, to: 86_400_000 });
    expect(() => assertResolvedMagnifierDatasetForJob(job, resolution.preflight)).not.toThrow();
  });

  test('incomplete inferred target periods beyond the requested envelope do not invalidate it', async () => {
    const adapter = createPinerCapabilityAdapter(capableRuntime('D').runtime);
    const day = 86_400;
    const sessions = [0, 1, 2, 3, 4, 7].map((offset) =>
      halfOpenIntervalSec(offset * day, offset * day + 6 * 3_600),
    );
    const calendar = {
      calendarId: 'trailing-incomplete-day',
      version: '1',
      coverage: halfOpenIntervalSec(0, sessions.at(-1)!.to),
      sessions,
    };
    const provider = new StaticProvider(
      { 'X|1d': sessions.slice(0, 5).map((session, index) => bar(session.from, 10 + index)) },
      {
        alignment: 'exchange-calendar',
        calendar,
        timeframes: ['1d'],
        cacheIdentity: 'trailing-incomplete-day',
      },
    );
    const job: Job = {
      source: STRATEGY_ON,
      symbol: 'X',
      timeframe: 'W',
      bars: [bar(0, 100)],
    };

    const resolution = await resolveBarMagnifier(job, '1w', provider, { adapter });
    expect(resolution.dataset?.barsMs).toHaveLength(5);
    expect(resolution.dataset?.coverage.requested).toEqual({
      from: 0,
      to: sessions[4]!.to * 1_000,
    });
    expect(() => assertResolvedMagnifierDatasetForJob(job, resolution.preflight)).not.toThrow();
  });

  test('metadata and acquisition keys cannot alias symbols, windows, feeds, or sessions', () => {
    expect(magnifierMetadataKey(STRATEGY_ON, '60', undefined)).toBe(
      magnifierMetadataKey(STRATEGY_ON, '60', undefined),
    );
    // Metadata deliberately has no symbol/provider/window identity.
    expect(magnifierMetadataKey(STRATEGY_ON, '60', undefined)).not.toBe(
      magnifierMetadataKey(STRATEGY_ON, '60', false),
    );

    const source = (cacheIdentity: string, normalizedSymbol: string) => ({
      cacheIdentity,
      normalizedSymbol,
      capabilities: { timeframes: ['10m'], alignment: 'utc-24x7' as const },
    });
    const base = {
      source: source('feed-a', 'X'),
      symbol: 'X',
      requested: { from: 0, to: 7200 },
      targetPineTf: '10',
      targetCanonicalTf: '10m',
      sourceCanonicalTf: '10m',
      chartOpensSec: [0, 3600],
      chartCloseTimesSec: [3600, 7200],
      chartIntervalSource: 'utc-fixed' as const,
      aggregationVersion: 0,
      contractVersion: 1,
      mappingVersion: 1,
    };
    const key = magnifierAcquisitionKey(base);
    expect(magnifierAcquisitionKey({ ...base })).toBe(key);
    expect(magnifierAcquisitionKey({ ...base, symbol: 'Y' })).not.toBe(key);
    expect(
      magnifierAcquisitionKey({ ...base, source: source('feed-a', 'Y'), symbol: 'Y' }),
    ).not.toBe(key);
    expect(magnifierAcquisitionKey({ ...base, requested: { from: 0, to: 3600 } })).not.toBe(key);
    expect(magnifierAcquisitionKey({ ...base, source: source('feed-b', 'X') })).not.toBe(key);
    expect(
      magnifierAcquisitionKey({
        ...base,
        source: {
          ...base.source,
          capabilities: {
            ...base.source.capabilities,
            weekAnchorSec: unixSecond(4 * 86_400),
          },
        },
      }),
    ).not.toBe(key);
    expect(magnifierAcquisitionKey({ ...base, chartCloseTimesSec: [3500, 7200] })).not.toBe(key);

    const calendarSessions = [
      halfOpenIntervalSec(0, 10),
      halfOpenIntervalSec(100, 110),
      halfOpenIntervalSec(200, 210),
      halfOpenIntervalSec(300, 310),
    ];
    const firstPartition = [halfOpenIntervalSec(0, 200), halfOpenIntervalSec(200, 400)];
    const calendarSource = (periods: typeof firstPartition) => ({
      cacheIdentity: 'calendar-feed',
      normalizedSymbol: 'X',
      capabilities: {
        timeframes: ['10m'],
        alignment: 'exchange-calendar' as const,
        calendar: {
          calendarId: 'partitioned',
          version: '1',
          coverage: halfOpenIntervalSec(0, 400),
          sessions: calendarSessions,
          periods: { '1d': periods },
        },
      },
    });
    const calendarBase = {
      ...base,
      source: calendarSource(firstPartition),
      chartIntervalSource: 'provider-calendar' as const,
    };
    const calendarKey = magnifierAcquisitionKey(calendarBase);
    expect(
      magnifierAcquisitionKey({
        ...calendarBase,
        source: calendarSource([halfOpenIntervalSec(0, 300), halfOpenIntervalSec(300, 400)]),
      }),
    ).not.toBe(calendarKey);
  });
});

test('authoritative inactive report remains inactive even when data was requested', () => {
  const block = projectAuthoritativeBarMagnifierReport(
    {
      barMagnifier: {
        requested: true,
        active: false,
        targetTimeframe: '10',
        magnifiedBars: 0,
        fallbackBars: 2,
        capFallbackBars: 0,
        dataFallbackBars: 0,
        intrabarsUsed: 0,
        coverage: 'no-data',
      },
    },
    true,
  );
  expect(block).toEqual({
    requested: true,
    active: false,
    targetTimeframe: '10',
    magnifiedBars: 0,
    fallbackBars: 2,
    capFallbackBars: 0,
    dataFallbackBars: 0,
    intrabarsUsed: 0,
    coverage: 'no-data',
  });
});

test('executeJob follows the loaded runtime: typed old-runtime rejection or authoritative inactive report', async () => {
  const job: Job = {
    source: STRATEGY_ON,
    symbol: 'X',
    timeframe: '60',
    bars: chartBars(),
  };
  if (pinerCapabilities().capable) {
    const provider = new StaticProvider(
      { 'X|10m': targetBars() },
      { alignment: 'utc-24x7', timeframes: ['10m'], cacheIdentity: 'runtime-report' },
    );
    await resolveBarMagnifier(job, '1h', provider);
    const result = await executeJob(job);
    expect(result.ok).toBe(true);
    expect(result.strategy?.barMagnifier).toMatchObject({ requested: true, active: false });
  } else {
    const result = await executeJob(job);
    expect(result.ok).toBe(false);
    expect(result.failure).toMatchObject({
      code: 'piner-bar-magnifier-capability-unavailable',
      permanent: true,
    });
  }
});

test('resolveBarMagnifier resolves the complete static security plan before attaching data', async () => {
  const adapter = createPinerCapabilityAdapter(capableRuntimeWithPinerMetadata());
  const source = `//@version=6
strategy("static", use_bar_magnifier=true)
plot(request.security("AAPL", "60", close))`;
  const provider = new CountingExactProvider(
    new StaticProvider(
      {
        'X|10m': targetBars(),
        'AAPL|1h': chartBars(),
      },
      { alignment: 'utc-24x7', timeframes: ['10m', '1h'], cacheIdentity: 'security-plan' },
    ),
  );
  const job: Job = {
    source,
    symbol: 'X',
    timeframe: '60',
    bars: chartBars(),
  };

  // Obsolete caller-trust fields must not bypass the resolver's own keyed
  // preflight or exact static plan, even when supplied by untyped consumers.
  const obsoleteBypasses = {
    preflight: preflightBarMagnifier(STRATEGY_OFF, '60', undefined, adapter),
    securityResolved: true,
  };
  const resolution = await resolveBarMagnifier(job, '1h', provider, {
    adapter,
    ...obsoleteBypasses,
  });
  expect(resolution.dataset).toBeDefined();
  expect(job.securityBars?.AAPL).toBeDefined();
  expect(job.securityProofs?.AAPL).toMatchObject({
    targetCanonicalTf: '60m',
    complete: true,
    gaps: [],
  });
  expect(provider.legacyCalls).toBe(0);
  expect(provider.exactCalls).toBe(2);
});

test('default exact-security range includes containing and prior higher-timeframe rows', async () => {
  const adapter = createPinerCapabilityAdapter(capableRuntimeWithPinerMetadata());
  const day = 86_400;
  const dayStart = 10 * day;
  const chartStart = dayStart + 12 * 3_600;
  const source = `//@version=6
strategy("static daily", use_bar_magnifier=true)
plot(request.security(syminfo.tickerid, "D", close))`;
  const chart = [bar(chartStart, 100), bar(chartStart + 3_600, 101)];
  const provider = new CountingExactProvider(
    new StaticProvider(
      {
        'X|10m': Array.from({ length: 12 }, (_, index) =>
          bar(chartStart + index * 600, 10 + index),
        ),
        'X|1d': [bar(dayStart - 2 * day, 70), bar(dayStart - day, 80), bar(dayStart, 90)],
      },
      {
        alignment: 'utc-24x7',
        timeframes: ['10m', '1d'],
        cacheIdentity: 'security-leading-padding',
      },
    ),
  );
  const job: Job = {
    source,
    symbol: 'X',
    timeframe: '60',
    bars: chart,
  };

  await resolveBarMagnifier(job, '1h', provider, { adapter });
  expect(job.securityBars?.['X@D']?.map((row) => row.time)).toEqual([
    dayStart - 2 * day,
    dayStart - day,
    dayStart,
  ]);
  expect(job.securityProofs?.['X@D']).toMatchObject({ complete: true, gaps: [] });
  expect(provider.legacyCalls).toBe(0);
  expect(provider.exactCalls).toBe(2);
});

test('resolver-owned magnifier prefixes preserve the bars alias and reject public clones', async () => {
  const adapter = createPinerCapabilityAdapter(capableRuntime().runtime);
  const provider = new StaticProvider(
    { 'X|10m': targetBars() },
    { alignment: 'utc-24x7', timeframes: ['10m'], cacheIdentity: 'prefix-authority' },
  );
  const job: Job = {
    source: STRATEGY_ON,
    symbol: 'X',
    timeframe: '60',
    bars: chartBars(),
  };
  const resolution = await resolveBarMagnifier(job, '1h', provider, { adapter });
  const full = resolution.dataset!;
  const prefix = deriveResolverIssuedMagnifierPrefix(full, 1);

  expect(prefix).not.toBe(full);
  expect(prefix.barsMs).toBe(full.barsMs);
  expect(prefix.chartOpenTimesMs).toEqual([0]);
  expect(prefix.chartCloseTimesMs).toEqual([3_600_000]);
  expect(prefix.coverage).toEqual({
    requested: { from: 0, to: 3_600_000 },
    covered: [{ from: 0, to: 3_600_000 }],
    gaps: [],
    complete: true,
  });
  expect(prefix.barsDigest).toBe(marketDataDigest(prefix.barsMs));
  expect(prefix.acquisitionKey).toBe(magnifierDatasetAcquisitionKey(prefix));
  expect(isResolverIssuedMagnifierDataset(prefix)).toBe(true);
  expect(Object.isFrozen(prefix)).toBe(true);
  expect(Object.isFrozen(prefix.chartOpenTimesMs)).toBe(true);
  expect(Object.isFrozen(prefix.chartCloseTimesMs)).toBe(true);
  expect(Object.isFrozen(prefix.coverage)).toBe(true);
  expect(Object.isFrozen(prefix.coverage.covered)).toBe(true);
  expect(
    assertResolvedMagnifierDatasetForJob(
      { ...job, bars: job.bars.slice(0, 1), magnifier: prefix },
      resolution.preflight,
    ),
  ).toBe(prefix);

  const exactPublicClone = deepFreezeFixture({ ...full }) as ResolvedMagnifierDataset;
  expect(exactPublicClone).toEqual(full);
  expect(isResolverIssuedMagnifierDataset(exactPublicClone)).toBe(false);
  expect(() => deriveResolverIssuedMagnifierPrefix(exactPublicClone, 1)).toThrow(
    expect.objectContaining({
      code: 'walkforward-bar-magnifier-prefix-authority',
      permanent: true,
    }),
  );
});

test('host-explicit exchange daily and weekly opens are authenticated at resolution and execution', async () => {
  const adapter = createPinerCapabilityAdapter(capableRuntime('60').runtime);
  const day = 86_400;
  const firstOpen = 10 * day + 9 * 3_600;

  for (const testCase of [
    { pineTf: 'D', canonicalTf: '1d', duration: day },
    { pineTf: 'W', canonicalTf: '1w', duration: 7 * day },
  ]) {
    const finalClose = firstOpen + testCase.duration;
    const offCalendarOpen = firstOpen + 3_600;
    const sessionClose = firstOpen + 2 * 3_600;
    const period = halfOpenIntervalSec(firstOpen, finalClose);
    const calendar = {
      calendarId: `host-explicit-${testCase.canonicalTf}`,
      version: '1',
      coverage: period,
      sessions: [halfOpenIntervalSec(firstOpen, sessionClose)],
      periods: { [testCase.canonicalTf]: [period] },
    };
    const provider = new StaticProvider(
      {
        'X|1h': [bar(firstOpen, 10), bar(offCalendarOpen, 11)],
      },
      {
        alignment: 'exchange-calendar',
        calendar,
        timeframes: ['1h'],
        cacheIdentity: `host-explicit-${testCase.canonicalTf}`,
      },
    );
    const validJob: Job = {
      source: STRATEGY_ON,
      symbol: 'X',
      timeframe: testCase.pineTf,
      bars: [bar(firstOpen, 100)],
    };
    const resolution = await resolveBarMagnifier(validJob, testCase.canonicalTf, provider, {
      adapter,
      chartCloseTimesSec: [finalClose],
    });
    expect(resolution.dataset?.chartIntervalSource, testCase.pineTf).toBe('host-explicit');
    expect(
      () => assertResolvedMagnifierDatasetForJob(validJob, resolution.preflight),
      testCase.pineTf,
    ).not.toThrow();

    const invalidResolutionJob: Job = {
      ...validJob,
      bars: [bar(offCalendarOpen, 101)],
      magnifier: undefined,
    };
    await expect(
      resolveBarMagnifier(invalidResolutionJob, testCase.canonicalTf, provider, {
        adapter,
        chartCloseTimesSec: [finalClose],
      }),
      testCase.pineTf,
    ).rejects.toMatchObject({
      type: 'bar-magnifier-error',
      code: 'chart-open-outside-calendar',
      permanent: true,
    });
    expect(invalidResolutionJob.magnifier).toBeUndefined();

    const requested = deepFreezeFixture({
      from: offCalendarOpen * 1_000,
      to: finalClose * 1_000,
    }) as ResolvedMagnifierDataset['coverage']['requested'];
    const forgedOffCalendar = reboundMagnifierDataset(
      resolution.dataset!,
      resolution.dataset!.barsMs,
      {
        chartOpenTimesMs: Object.freeze([
          offCalendarOpen * 1_000,
        ]) as ResolvedMagnifierDataset['chartOpenTimesMs'],
        coverage: deepFreezeFixture({
          requested,
          covered: [{ ...requested }],
          gaps: [],
          complete: true,
        }) as ResolvedMagnifierDataset['coverage'],
      },
    );
    try {
      assertResolvedMagnifierDatasetForJob(
        {
          ...validJob,
          bars: [bar(offCalendarOpen, 101)],
          magnifier: forgedOffCalendar,
        },
        resolution.preflight,
      );
      throw new Error(`expected ${testCase.pineTf} serialized calendar-open rejection`);
    } catch (error) {
      expect(error, testCase.pineTf).toMatchObject({
        code: 'invalid-injected-bar-magnifier-data',
        permanent: true,
        details: {
          mismatches: expect.arrayContaining(['resolver-authentication', 'chart-open-calendar']),
        },
      });
    }
  }
});

test('UTC and exchange intraday chart opens authenticate their complete fixed grids', async () => {
  const adapter = createPinerCapabilityAdapter(capableRuntime().runtime);
  const hour = 3_600;
  const shiftedOpen = 300;

  const utcProvider = new StaticProvider(
    { 'X|10m': targetBars(6) },
    { alignment: 'utc-24x7', timeframes: ['10m'], cacheIdentity: 'utc-chart-open-grid' },
  );
  const utcJob: Job = {
    source: STRATEGY_ON,
    symbol: 'X',
    timeframe: '60',
    bars: [bar(0, 100)],
  };
  const utcResolution = await resolveBarMagnifier(utcJob, '1h', utcProvider, { adapter });
  await expect(
    resolveBarMagnifier(
      { ...utcJob, bars: [bar(shiftedOpen, 101)], magnifier: undefined },
      '1h',
      utcProvider,
      { adapter, chartCloseTimesSec: [shiftedOpen + hour] },
    ),
  ).rejects.toMatchObject({
    type: 'bar-magnifier-error',
    code: 'chart-fixed-grid-mismatch',
    permanent: true,
  });

  const calendar = {
    calendarId: 'intraday-session-grid',
    version: '1',
    coverage: halfOpenIntervalSec(0, 2 * hour),
    sessions: [halfOpenIntervalSec(0, 2 * hour)],
  };
  const exchangeProvider = new StaticProvider(
    { 'X|10m': targetBars(6) },
    {
      alignment: 'exchange-calendar',
      calendar,
      timeframes: ['10m'],
      cacheIdentity: 'exchange-chart-open-grid',
    },
  );
  const exchangeJob: Job = {
    source: STRATEGY_ON,
    symbol: 'X',
    timeframe: '60',
    bars: [bar(0, 100)],
  };
  const exchangeResolution = await resolveBarMagnifier(exchangeJob, '1h', exchangeProvider, {
    adapter,
    chartCloseTimesSec: [hour],
  });
  await expect(
    resolveBarMagnifier(
      { ...exchangeJob, bars: [bar(shiftedOpen, 101)], magnifier: undefined },
      '1h',
      exchangeProvider,
      { adapter, chartCloseTimesSec: [shiftedOpen + hour] },
    ),
  ).rejects.toMatchObject({
    type: 'bar-magnifier-error',
    code: 'chart-fixed-grid-mismatch',
    permanent: true,
  });

  for (const [label, job, resolution, mismatch] of [
    ['UTC', utcJob, utcResolution, 'chart-open-grid'],
    ['exchange', exchangeJob, exchangeResolution, 'chart-open-calendar'],
  ] as const) {
    const requested = deepFreezeFixture({
      from: shiftedOpen * 1_000,
      to: (shiftedOpen + hour) * 1_000,
    }) as ResolvedMagnifierDataset['coverage']['requested'];
    const forged = reboundMagnifierDataset(resolution.dataset!, resolution.dataset!.barsMs, {
      chartOpenTimesMs: Object.freeze([
        shiftedOpen * 1_000,
      ]) as ResolvedMagnifierDataset['chartOpenTimesMs'],
      chartCloseTimesMs: Object.freeze([
        (shiftedOpen + hour) * 1_000,
      ]) as ResolvedMagnifierDataset['chartCloseTimesMs'],
      coverage: deepFreezeFixture({
        requested,
        covered: [{ ...requested }],
        gaps: [],
        complete: true,
      }) as ResolvedMagnifierDataset['coverage'],
    });
    try {
      assertResolvedMagnifierDatasetForJob(
        { ...job, bars: [bar(shiftedOpen, 101)], magnifier: forged },
        resolution.preflight,
      );
      throw new Error(`expected ${label} serialized chart-grid rejection`);
    } catch (error) {
      expect(error, label).toMatchObject({
        code: 'invalid-injected-bar-magnifier-data',
        permanent: true,
        details: {
          mismatches: expect.arrayContaining(['resolver-authentication', mismatch]),
        },
      });
    }
  }
});

test('chart 2W uses Pine runtime phase while elapsed 14D remains epoch-anchored', async () => {
  const adapter = createPinerCapabilityAdapter(capableRuntime('60').runtime);
  const day = 86_400;
  const duration = 14 * day;
  const pineWeekPhase = -3 * day;
  const providerWeekPhase = 4 * day;

  for (const testCase of [
    {
      label: '2W',
      pineTf: '2W',
      canonicalTf: '2w',
      validOpen: pineWeekPhase,
      invalidOpen: providerWeekPhase,
      errorCode: 'chart-week-grid-mismatch',
    },
    {
      label: '14D',
      pineTf: '14D',
      canonicalTf: '14d',
      validOpen: 0,
      invalidOpen: pineWeekPhase,
      errorCode: 'chart-fixed-grid-mismatch',
    },
  ] as const) {
    const provider = new StaticProvider(
      {
        'X|1h': Array.from({ length: duration / 3_600 }, (_, index) =>
          bar(testCase.validOpen + index * 3_600, 10 + index),
        ),
      },
      {
        alignment: 'utc-24x7',
        weekAnchorSec: unixSecond(providerWeekPhase),
        timeframes: ['1h'],
        cacheIdentity: `chart-runtime-grid-${testCase.label}`,
      },
    );
    const validJob: Job = {
      source: STRATEGY_ON,
      symbol: 'X',
      timeframe: testCase.pineTf,
      bars: [bar(testCase.validOpen, 100)],
    };
    const resolution = await resolveBarMagnifier(validJob, testCase.canonicalTf, provider, {
      adapter,
    });
    expect(
      () => assertResolvedMagnifierDatasetForJob(validJob, resolution.preflight),
      testCase.label,
    ).not.toThrow();

    await expect(
      resolveBarMagnifier(
        { ...validJob, bars: [bar(testCase.invalidOpen, 101)], magnifier: undefined },
        testCase.canonicalTf,
        provider,
        { adapter, chartCloseTimesSec: [testCase.invalidOpen + duration] },
      ),
      testCase.label,
    ).rejects.toMatchObject({
      type: 'bar-magnifier-error',
      code: testCase.errorCode,
      permanent: true,
    });

    const requested = deepFreezeFixture({
      from: testCase.invalidOpen * 1_000,
      to: (testCase.invalidOpen + duration) * 1_000,
    }) as ResolvedMagnifierDataset['coverage']['requested'];
    const forged = reboundMagnifierDataset(resolution.dataset!, resolution.dataset!.barsMs, {
      chartOpenTimesMs: Object.freeze([
        testCase.invalidOpen * 1_000,
      ]) as ResolvedMagnifierDataset['chartOpenTimesMs'],
      chartCloseTimesMs: Object.freeze([
        (testCase.invalidOpen + duration) * 1_000,
      ]) as ResolvedMagnifierDataset['chartCloseTimesMs'],
      coverage: deepFreezeFixture({
        requested,
        covered: [{ ...requested }],
        gaps: [],
        complete: true,
      }) as ResolvedMagnifierDataset['coverage'],
    });
    try {
      assertResolvedMagnifierDatasetForJob(
        { ...validJob, bars: [bar(testCase.invalidOpen, 101)], magnifier: forged },
        resolution.preflight,
      );
      throw new Error(`expected ${testCase.label} serialized runtime-grid rejection`);
    } catch (error) {
      expect(error, testCase.label).toMatchObject({
        code: 'invalid-injected-bar-magnifier-data',
        permanent: true,
        details: {
          mismatches: expect.arrayContaining(['resolver-authentication', 'chart-open-grid']),
        },
      });
    }
  }
});
