import { describe, expect, test } from 'bun:test';
import type { SecurityDependency } from '@heyphat/piner';
import { StaticProvider } from '@heyphat/pinery';
import type {
  Bar,
  Job,
  ResolvedMagnifierDataset,
  ResolvedSecurityDatasetProof,
} from '../src/job.js';
import {
  createPinerCapabilityAdapter,
  resolveBarMagnifier,
  resolveSecurity,
} from '../src/index.js';
import { marketDataDigest } from '../src/hash.js';
import {
  deriveResolverIssuedMagnifierPrefix,
  initializeWorkerMagnifierDatasetAuthentication,
  isResolverIssuedMagnifierDataset,
} from '../src/magnifier.js';
import {
  initializeWorkerSecurityProofAuthentication,
  isResolverIssuedSecurityProof,
} from '../src/security.js';
import {
  datasetId,
  hydrateWireJob,
  senderCacheAfterHydration,
  toWireJob,
  type WireJob,
} from '../src/wire.js';

function bars(seed: number): Bar[] {
  return [
    {
      time: 1_700_000_000,
      open: seed,
      high: seed + 1,
      low: seed - 1,
      close: seed + 0.5,
      volume: 10,
    },
  ];
}

function magnifier(barsMs: readonly Bar[]): ResolvedMagnifierDataset {
  return {
    contractVersion: 1,
    mappingVersion: 1,
    requestedSymbol: 'TEST',
    targetPineTf: '10',
    targetCanonicalTf: '10m',
    sourceCanonicalTf: '10m',
    barsMs,
    chartOpenTimesMs: [1_700_000_000_000] as ResolvedMagnifierDataset['chartOpenTimesMs'],
    chartCloseTimesMs: [1_700_003_600_000] as ResolvedMagnifierDataset['chartCloseTimesMs'],
    chartIntervalSource: 'utc-fixed',
    coverage: {
      requested: {
        from: 1_700_000_000_000,
        to: 1_700_003_600_000,
      } as ResolvedMagnifierDataset['coverage']['requested'],
      covered: [
        { from: 1_700_000_000_000, to: 1_700_003_600_000 },
      ] as ResolvedMagnifierDataset['coverage']['covered'],
      gaps: [],
      complete: true,
    },
    provenance: {
      cacheIdentity: 'wire',
      normalizedSymbol: 'TEST',
      sourceTimeframe: '10m',
      targetTimeframe: '10m',
      alignment: 'utc-24x7',
      coverageSemantics: 'complete-record',
      recordSpan: { from: 1_700_000_000, to: 1_700_003_600 },
      aggregationVersion: 0,
    },
    alignmentEvidence: { kind: 'utc-24x7' },
    barsDigest: marketDataDigest(barsMs),
    acquisitionKey: 'wire-key',
  };
}

function capableAdapter() {
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
              targetTimeframe: '10',
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
  return createPinerCapabilityAdapter({
    BAR_MAGNIFIER_CONTRACT_VERSION: 1,
    BAR_MAGNIFIER_MAPPING_VERSION: 1,
    barMagnifierTimeframe: () => '10',
    ExecutionContext: Context,
    StrategyBroker: Broker,
    compile(source: string) {
      return {
        metadata: {
          isStrategy: source.includes('strategy('),
          strategy: { useBarMagnifier: source.includes('use_bar_magnifier=true') },
          securityDependencies: [],
        },
      };
    },
  });
}

async function resolvedMagnifierJob(): Promise<Job> {
  const start = 1_700_002_800;
  const primary = Array.from({ length: 2 }, (_, index) => ({
    time: start + index * 3_600,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 10 + index,
  }));
  const lower = Array.from({ length: 12 }, (_, index) => ({
    time: start + index * 600,
    open: 10 + index,
    high: 11 + index,
    low: 9 + index,
    close: 10.5 + index,
    volume: 10 + index,
  }));
  const job: Job = {
    source: '//@version=6\nstrategy("wire magnifier", use_bar_magnifier=true)\nplot(close)',
    symbol: 'TEST',
    timeframe: '60',
    bars: primary,
  };
  await resolveBarMagnifier(
    job,
    '1h',
    new StaticProvider(
      { 'TEST|10m': lower },
      { alignment: 'utc-24x7', timeframes: ['10m'], cacheIdentity: 'wire-auth' },
    ),
    { adapter: capableAdapter() },
  );
  return job;
}

function securityProof(bars: readonly Bar[]): ResolvedSecurityDatasetProof {
  return {
    requestKind: 'cross-plain',
    requestedSymbol: 'TEST',
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
    requestedCanonicalTfs: ['1d'],
    lookaheadOnCanonicalTfs: [],
    targetCanonicalTf: '1h',
    requested: { from: 1_700_000_000, to: 1_700_003_600 },
    covered: [{ from: 1_700_000_000, to: 1_700_003_600 }],
    gaps: [],
    complete: true,
    provenance: {
      cacheIdentity: 'wire-security',
      normalizedSymbol: 'TEST',
      sourceTimeframe: '1h',
      targetTimeframe: '1h',
      alignment: 'utc-24x7',
      coverageSemantics: 'complete-record',
      recordSpan: { from: 1_700_000_000, to: 1_700_003_600 },
      aggregationVersion: 0,
    },
    alignmentEvidence: { kind: 'utc-24x7' },
    barsDigest: `fixture-${bars.length}`,
    acquisitionKey: 'security-dataset-acquisition-v3:wire-bound-proof',
  } as ResolvedSecurityDatasetProof;
}

function job(primary: Bar[], securityBars?: Record<string, Bar[]>): Job {
  return {
    source: '//@version=6\nindicator("wire")\nplot(close)',
    symbol: 'TEST',
    timeframe: '60',
    bars: primary,
    securityBars,
  };
}

describe('worker wire dataset protocol', () => {
  test('hydrates same-message aliases before consulting the previous cache', () => {
    const shared = bars(100);
    const encoded = toWireJob(
      job(shared, {
        TEST: shared,
        'TEST@10': shared,
      }),
      new Set(),
    );

    expect(encoded.sent).toEqual(new Set([encoded.wire.bars.id]));
    expect(encoded.wire.bars.bars).toBe(shared);
    expect(encoded.wire.securityBars?.TEST?.bars).toBeUndefined();
    expect(encoded.wire.securityBars?.['TEST@10']?.bars).toBeUndefined();

    const hydrated = hydrateWireJob(encoded.wire, new Map());
    expect(hydrated.job.bars).toBe(shared);
    expect(hydrated.job.securityBars?.TEST).toBe(shared);
    expect(hydrated.job.securityBars?.['TEST@10']).toBe(shared);
    expect(hydrated.next).toEqual(new Map([[encoded.wire.bars.id, shared]]));
  });

  test('uses the acknowledged previous-message cache and replaces its dataset view', () => {
    const firstBars = bars(100);
    const first = toWireJob(job(firstBars), new Set());
    const firstHydrated = hydrateWireJob(first.wire, new Map());
    const acknowledged = senderCacheAfterHydration(first.sent, true);

    const cached = toWireJob(job(firstBars), acknowledged);
    expect(cached.wire.bars.bars).toBeUndefined();
    const cachedHydrated = hydrateWireJob(cached.wire, firstHydrated.next);
    expect(cachedHydrated.job.bars).toBe(firstBars);

    const otherBars = bars(200);
    const other = toWireJob(job(otherBars), cached.sent);
    expect(other.wire.bars.bars).toBe(otherBars);
    const otherHydrated = hydrateWireJob(other.wire, cachedHydrated.next);
    expect([...otherHydrated.next.keys()]).toEqual([datasetId(otherBars)]);
    expect(otherHydrated.next.has(datasetId(firstBars))).toBe(false);
  });

  test('content mutation assigns a fresh ref and resends a reused array identity', () => {
    const shared = bars(100);
    const firstId = datasetId(shared);
    const acknowledged = new Set([firstId]);
    shared[0]!.close = 999;

    const encoded = toWireJob(job(shared), acknowledged);
    expect(encoded.wire.bars.id).not.toBe(firstId);
    expect(encoded.wire.bars.bars).toBe(shared);
    expect(encoded.sent).toEqual(new Set([encoded.wire.bars.id]));
  });

  test('failed hydration leaves receiver state untouched and clears sender belief', () => {
    const shared = bars(100);
    const id = datasetId(shared);
    const receiverCache = new Map([[id, shared]]);
    const malformed: WireJob = {
      ...job(shared),
      bars: { id: id + 1_000_000 },
    };

    expect(() => hydrateWireJob(malformed, receiverCache)).toThrow(/dataset .* missing/);
    expect(receiverCache).toEqual(new Map([[id, shared]]));

    const cleared = senderCacheAfterHydration(new Set([id]), false);
    expect(cleared.size).toBe(0);
    const retry = toWireJob(job(shared), cleared);
    expect(retry.wire.bars.bars).toBe(shared);
  });
});

test('wire aliases one chart/security/magnifier array and preserves proofs within the same message', () => {
  const shared = bars(100);
  const proof = securityProof(shared);
  const value = {
    ...job(shared, { TEST: shared, 'TEST@10': shared }),
    securityProofs: { TEST: proof },
    magnifier: magnifier(shared),
  };
  const encoded = toWireJob(
    {
      ...value,
      magnifierDatasetAuthenticator: 'caller-forged-magnifier',
      securityProofAuthenticators: { TEST: 'caller-forged-security' },
    } as Job & {
      magnifierDatasetAuthenticator: string;
      securityProofAuthenticators: Record<string, string>;
    },
    new Set(),
    'b'.repeat(64),
  );
  expect(encoded.wire.magnifierDatasetAuthenticator).toBeUndefined();
  expect(encoded.wire.securityProofAuthenticators).toBeUndefined();
  expect(encoded.sent).toEqual(new Set([encoded.wire.bars.id]));
  expect(encoded.wire.bars.bars).toBe(shared);
  expect(encoded.wire.securityBars?.TEST?.bars).toBeUndefined();
  expect(encoded.wire.magnifier?.barsMs.bars).toBeUndefined();
  expect(encoded.wire.securityProofs?.TEST).toMatchObject({
    requestedCanonicalTfs: ['1d'],
    provenance: {
      coverageSemantics: 'complete-record',
      recordSpan: { from: 1_700_000_000, to: 1_700_003_600 },
    },
    alignmentEvidence: { kind: 'utc-24x7' },
    acquisitionKey: 'security-dataset-acquisition-v3:wire-bound-proof',
  });

  const hydrated = hydrateWireJob(encoded.wire, new Map());
  expect(hydrated.job.bars).toBe(shared);
  expect(hydrated.job.securityBars?.TEST).toBe(shared);
  expect(hydrated.job.securityProofs?.TEST).toBe(proof);
  expect(hydrated.job.securityProofs?.TEST?.acquisitionKey).toBe(
    'security-dataset-acquisition-v3:wire-bound-proof',
  );
  expect(Object.isFrozen(hydrated.job.securityProofs?.TEST)).toBe(true);
  expect(Object.isFrozen(hydrated.job.securityProofs?.TEST?.requestedCanonicalTfs)).toBe(true);
  expect(Object.isFrozen(hydrated.job.securityBars?.TEST)).toBe(true);
  expect(Object.isFrozen(hydrated.job.securityBars?.TEST?.[0])).toBe(true);
  expect(hydrated.job.magnifier?.barsMs).toBe(shared);
  expect(Object.isFrozen(hydrated.job.magnifier)).toBe(true);
  expect(Object.isFrozen(hydrated.job.magnifier?.coverage)).toBe(true);
  expect(Object.isFrozen(hydrated.job.magnifier?.provenance)).toBe(true);
  expect(hydrated.job.magnifier?.provenance).toMatchObject({
    coverageSemantics: 'complete-record',
    recordSpan: { from: 1_700_000_000, to: 1_700_003_600 },
  });
  expect(Object.isFrozen(hydrated.job.magnifier?.provenance.recordSpan)).toBe(true);
  expect(Object.isFrozen(hydrated.job.magnifier?.alignmentEvidence)).toBe(true);
});

test('a missing magnifier ref keeps hydration atomic and retries with its payload after nack', () => {
  const primary = bars(100);
  const lower = bars(10);
  const encoded = toWireJob({ ...job(primary), magnifier: magnifier(lower) }, new Set());
  const prior = new Map([[datasetId(primary), primary] as const]);
  const malformed: WireJob = {
    ...encoded.wire,
    magnifier: { ...encoded.wire.magnifier!, barsMs: { id: datasetId(lower) + 1_000_000 } },
  };
  expect(() => hydrateWireJob(malformed, prior)).toThrow(/dataset .* missing/);
  expect(prior).toEqual(new Map([[datasetId(primary), primary]]));
  expect(Object.isFrozen(primary)).toBe(false);
  expect(Object.isFrozen(primary[0])).toBe(false);

  const retry = toWireJob(
    { ...job(primary), magnifier: magnifier(lower) },
    senderCacheAfterHydration(encoded.sent, false),
  );
  expect(retry.wire.bars.bars).toBe(primary);
  expect(retry.wire.magnifier?.barsMs.bars).toBe(lower);
});

test('worker hydration restores magnifier authority only with a valid untampered authenticator', async () => {
  const secret = 'c'.repeat(64);
  initializeWorkerMagnifierDatasetAuthentication(secret);
  const resolved = await resolvedMagnifierJob();
  expect(isResolverIssuedMagnifierDataset(resolved.magnifier)).toBe(true);
  const fullBarsMs = resolved.magnifier!.barsMs;
  resolved.magnifier = deriveResolverIssuedMagnifierPrefix(resolved.magnifier!, 1);
  resolved.bars = resolved.bars.slice(0, 1);
  expect(resolved.magnifier.barsMs).toBe(fullBarsMs);
  expect(isResolverIssuedMagnifierDataset(resolved.magnifier)).toBe(true);

  const encoded = toWireJob(
    {
      ...resolved,
      magnifierDatasetAuthenticator: 'caller-forged',
    } as Job & { magnifierDatasetAuthenticator: string },
    new Set(),
    secret,
  );
  expect(encoded.wire.magnifierDatasetAuthenticator).toMatch(
    /^magnifier-dataset-wire-auth-v1:[0-9a-f]{64}$/,
  );
  expect(encoded.wire.magnifierDatasetAuthenticator).not.toBe('caller-forged');

  const valid = hydrateWireJob(encoded.wire, new Map());
  expect(isResolverIssuedMagnifierDataset(valid.job.magnifier)).toBe(true);
  expect(Object.isFrozen(valid.job.magnifier)).toBe(true);
  expect(Object.isFrozen(valid.job.magnifier?.barsMs)).toBe(true);
  expect(Object.isFrozen(valid.job.magnifier?.barsMs[0])).toBe(true);
  expect(Object.isFrozen(valid.job.magnifier?.coverage.covered)).toBe(true);

  const missing = hydrateWireJob(
    { ...encoded.wire, magnifierDatasetAuthenticator: undefined },
    new Map(),
  );
  expect(isResolverIssuedMagnifierDataset(missing.job.magnifier)).toBe(false);
  expect(Object.isFrozen(missing.job.magnifier)).toBe(true);

  const invalid = hydrateWireJob(
    { ...encoded.wire, magnifierDatasetAuthenticator: 'invalid' },
    new Map(),
  );
  expect(isResolverIssuedMagnifierDataset(invalid.job.magnifier)).toBe(false);

  const tamperedWire: WireJob = {
    ...encoded.wire,
    magnifier: {
      ...encoded.wire.magnifier!,
      alignmentEvidence: { kind: 'utc-24x7', weekAnchorSec: 345_600 },
    },
  };
  const tampered = hydrateWireJob(tamperedWire, new Map());
  expect(isResolverIssuedMagnifierDataset(tampered.job.magnifier)).toBe(false);
  expect(tampered.job.magnifier?.alignmentEvidence).toEqual({
    kind: 'utc-24x7',
    weekAnchorSec: 345_600,
  });
  expect(Object.isFrozen(tampered.job.magnifier?.alignmentEvidence)).toBe(true);
});

test('worker security-proof authentication rejects forged warmup and lookahead identities', async () => {
  const secret = 'd'.repeat(64);
  initializeWorkerSecurityProofAuthentication(secret);
  const start = 1_700_002_800;
  const chart = Array.from({ length: 2 }, (_, index) => ({
    time: start + index * 3_600,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100.5 + index,
    volume: 10 + index,
  }));
  const dependencyBars = Array.from({ length: 2 }, (_, index) => ({
    time: start + index * 3_600,
    open: 200 + index,
    high: 201 + index,
    low: 199 + index,
    close: 200.5 + index,
    volume: 20 + index,
  }));
  const source = `//@version=6
strategy("wire proof identity")
plot(request.security("DEP", "60", close))`;
  const dependencies = [
    {
      lowerTf: false,
      self: false,
      symbol: 'DEP',
      tfSelf: false,
      timeframe: '60',
      dynamic: false,
      lookahead: false,
      expressionPriorBars: 0,
    },
  ] as unknown as SecurityDependency[];
  const value: Job = {
    source,
    symbol: 'TEST',
    timeframe: '60',
    bars: chart,
    magnifier: {
      chartCloseTimesMs: [(start + 2 * 3_600) * 1_000],
    } as ResolvedMagnifierDataset,
  };
  await resolveSecurity(
    source,
    [value],
    '1h',
    '60',
    new StaticProvider(
      { 'DEP|1h': dependencyBars },
      { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'wire-proof-identity' },
    ),
    {
      concurrency: 1,
      range: { from: start, to: start + 2 * 3_600 - 1 },
      barMagnifierRequested: true,
      staticDependencies: dependencies,
    },
  );
  expect(isResolverIssuedSecurityProof(value.securityProofs?.DEP)).toBe(true);
  value.magnifier = undefined;

  const encoded = toWireJob(value, new Set(), secret);
  expect(encoded.wire.securityProofAuthenticators?.DEP).toMatch(
    /^security-proof-wire-auth-v1:[0-9a-f]{64}$/,
  );
  const valid = hydrateWireJob(encoded.wire, new Map());
  expect(isResolverIssuedSecurityProof(valid.job.securityProofs?.DEP)).toBe(true);

  const proof = encoded.wire.securityProofs!.DEP!;
  const forgedDependencies = [
    proof.dependencies.map((dependency) => ({
      ...dependency,
      expressionPriorBars: dependency.expressionPriorBars + 1,
      totalRequiredPriorTargetBars: dependency.totalRequiredPriorTargetBars + 1,
    })),
    proof.dependencies.map((dependency) => ({ ...dependency, lookahead: true })),
  ];
  for (const dependenciesPatch of forgedDependencies) {
    const tampered = hydrateWireJob(
      {
        ...encoded.wire,
        securityProofs: {
          DEP: { ...proof, dependencies: dependenciesPatch },
        },
      },
      new Map(),
    );
    expect(isResolverIssuedSecurityProof(tampered.job.securityProofs?.DEP)).toBe(false);
  }
});

test('worker hydration authenticates exchange daily and weekly multi-period proofs', async () => {
  const secret = 'd'.repeat(64);
  initializeWorkerSecurityProofAuthentication(secret);
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
    const periods = testCase.periodOpens.map((from) => ({ from, to: from + 3_600 }));
    const source = `//@version=6
strategy("wire exchange ${testCase.label}")
first = request.security("B", "${testCase.pineTf}", open, lookahead=barmerge.lookahead_on)
last = request.security("B", "${testCase.pineTf}", close, lookahead=barmerge.lookahead_on)
plot(first + last)`;
    // Test-only compiler metadata fixture. The repeated entries model piner's
    // emitted dependency array and retain distinct dependency indices.
    const dependencies = [0, 1].map(() => ({
      lowerTf: false,
      self: false,
      symbol: 'B',
      tfSelf: false,
      timeframe: testCase.pineTf,
      dynamic: false,
      lookahead: true,
      expressionPriorBars: 0,
    })) as unknown as SecurityDependency[];
    const sourceBars = testCase.periodOpens.map((time, index) => {
      const value = 200 + index;
      return {
        time,
        open: value,
        high: value + 1,
        low: value - 1,
        close: value + 0.5,
        volume: 20 + index,
      };
    });
    const value: Job = {
      source,
      symbol: 'A',
      timeframe: testCase.pineTf,
      bars: [
        {
          time: testCase.chartOpen,
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          volume: 10,
        },
      ],
      magnifier: {
        chartCloseTimesMs: [finalChartClose * 1_000],
      } as ResolvedMagnifierDataset,
    };

    await resolveSecurity(
      source,
      [value],
      testCase.canonicalTf,
      testCase.pineTf,
      new StaticProvider(
        { [`B|${testCase.canonicalTf}`]: sourceBars },
        {
          alignment: 'exchange-calendar',
          calendar: {
            calendarId: `wire-multi-provider-${testCase.label}`,
            version: '1',
            coverage: { from: testCase.runtimeFrom, to: testCase.runtimeTo },
            sessions: periods,
            periods: { [testCase.canonicalTf]: periods },
          } as import('@heyphat/pinery').HistorySessionCalendar,
          timeframes: [testCase.canonicalTf],
          cacheIdentity: `wire-multi-provider-${testCase.label}`,
        },
      ),
      {
        concurrency: 1,
        range: { from: testCase.chartOpen, to: finalChartClose - 1 },
        barMagnifierRequested: true,
        staticDependencies: dependencies,
      },
    );

    expect(
      value.securityBars?.B?.map((bar) => bar.time),
      testCase.label,
    ).toEqual(testCase.periodOpens);
    expect(value.securityProofs?.B, testCase.label).toMatchObject({
      dependencies: [
        { dependencyIndex: 0, lookahead: true },
        { dependencyIndex: 1, lookahead: true },
      ],
      requested: { from: testCase.runtimeFrom, to: testCase.runtimeTo },
    });
    value.magnifier = undefined;

    const encoded = toWireJob(value, new Set(), secret);
    expect(encoded.wire.securityProofAuthenticators?.B, testCase.label).toMatch(
      /^security-proof-wire-auth-v1:[0-9a-f]{64}$/,
    );
    const hydrated = hydrateWireJob(encoded.wire, new Map());
    expect(isResolverIssuedSecurityProof(hydrated.job.securityProofs?.B), testCase.label).toBe(
      true,
    );
    expect(
      hydrated.job.securityBars?.B?.map((bar) => bar.time),
      testCase.label,
    ).toEqual(testCase.periodOpens);
    expect(hydrated.job.securityProofs?.B?.alignmentEvidence, testCase.label).toMatchObject({
      kind: 'exchange-calendar',
      calendar: {
        calendarId: `wire-multi-provider-${testCase.label}`,
        periods: { [testCase.canonicalTf]: periods },
      },
    });
  }
});
