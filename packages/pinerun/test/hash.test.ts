import { expect, test } from 'bun:test';
import { unixSecond } from '@heyphat/pinery';
import type {
  Bar,
  Job,
  ResolvedMagnifierDataset,
  ResolvedSecurityDatasetProof,
} from '../src/job.js';
import { jobHash, marketDataDigest } from '../src/hash.js';

function bars(): Bar[] {
  return [
    { time: 100, open: 1, high: 3, low: 0, close: 2, volume: 10 },
    { time: 200, open: 2, high: 4, low: 1, close: 3, volume: 20 },
  ];
}

function job(primary = bars()): Job {
  return {
    source: '//@version=6\nstrategy("hash")\nplot(close)',
    symbol: 'X',
    timeframe: '60',
    bars: primary,
  };
}

function magnifier(datasetBars = bars()): ResolvedMagnifierDataset {
  return {
    contractVersion: 1,
    mappingVersion: 1,
    requestedSymbol: 'X',
    targetPineTf: '10',
    targetCanonicalTf: '10m',
    sourceCanonicalTf: '5m',
    barsMs: datasetBars,
    chartOpenTimesMs: [0, 1_000] as ResolvedMagnifierDataset['chartOpenTimesMs'],
    chartCloseTimesMs: [1_000, 2_000] as ResolvedMagnifierDataset['chartCloseTimesMs'],
    chartIntervalSource: 'utc-fixed',
    coverage: {
      requested: { from: 0, to: 2_000 } as ResolvedMagnifierDataset['coverage']['requested'],
      covered: [{ from: 0, to: 2_000 }] as ResolvedMagnifierDataset['coverage']['covered'],
      gaps: [],
      complete: true,
    },
    provenance: {
      cacheIdentity: 'feed-a',
      normalizedSymbol: 'X',
      sourceTimeframe: '5m',
      targetTimeframe: '10m',
      alignment: 'utc-24x7',
      aggregationVersion: 1,
    },
    alignmentEvidence: { kind: 'utc-24x7' },
    barsDigest: marketDataDigest(datasetBars),
    acquisitionKey: 'full-key-a',
  };
}

function securityProof(datasetBars: readonly Bar[]): ResolvedSecurityDatasetProof {
  return {
    requestKind: 'cross-plain',
    requestedSymbol: 'A',
    dependencies: [
      {
        dependencyIndex: 0,
        requestedCanonicalTf: '1d',
        lookahead: false,
        expressionPriorBars: 3,
        baseMappingPriorBars: 2,
        totalRequiredPriorTargetBars: 5,
      },
    ],
    requestedCanonicalTfs: ['1d'],
    lookaheadOnCanonicalTfs: [],
    targetCanonicalTf: '1h',
    requested: { from: 100, to: 300 } as ResolvedSecurityDatasetProof['requested'],
    covered: [{ from: 100, to: 300 }] as ResolvedSecurityDatasetProof['covered'],
    gaps: [],
    complete: true,
    provenance: {
      cacheIdentity: 'security-feed',
      normalizedSymbol: 'A',
      sourceTimeframe: '1h',
      targetTimeframe: '1h',
      alignment: 'utc-24x7',
      aggregationVersion: 0,
    },
    alignmentEvidence: { kind: 'utc-24x7' },
    barsDigest: marketDataDigest(datasetBars),
    acquisitionKey: 'security-key-a',
  };
}

test('market digest and job hash cover every timestamp/OHLCV field, not length/end time', () => {
  const original = bars();
  const digest = marketDataDigest(original);
  const base = jobHash(job(original));
  for (const field of ['time', 'open', 'high', 'low', 'close', 'volume'] as const) {
    const changed = bars();
    changed[0] = { ...changed[0]!, [field]: changed[0]![field] + 0.125 };
    expect(marketDataDigest(changed)).not.toBe(digest);
    expect(jobHash(job(changed))).not.toBe(base);
    expect(changed).toHaveLength(original.length);
    expect(changed.at(-1)!.time).toBe(original.at(-1)!.time);
  }
});

test('full security content and includeTrades projection affect the determinism key', () => {
  const primary = bars();
  const securityA = bars();
  const securityB = bars();
  securityB[0] = { ...securityB[0]!, volume: securityB[0]!.volume + 1 };
  const base = job(primary);
  const proofA = securityProof(securityA);
  expect(
    jobHash({ ...base, securityBars: { A: securityA }, securityProofs: { A: proofA } }),
  ).not.toBe(
    jobHash({
      ...base,
      securityBars: { A: securityB },
      securityProofs: { A: securityProof(securityB) },
    }),
  );
  expect(
    jobHash({ ...base, securityBars: { A: securityA }, securityProofs: { A: proofA } }),
  ).not.toBe(
    jobHash({
      ...base,
      securityBars: { A: securityA },
      securityProofs: {
        A: { ...proofA, requestedSymbol: 'B' },
      },
    }),
  );
  expect(
    jobHash({ ...base, securityBars: { A: securityA }, securityProofs: { A: proofA } }),
  ).not.toBe(
    jobHash({
      ...base,
      securityBars: { A: securityA },
      securityProofs: {
        A: { ...proofA, targetCanonicalTf: '30m' },
      },
    }),
  );
  for (const proof of [
    { ...proofA, requestedCanonicalTfs: ['1d', '1w'] },
    {
      ...proofA,
      dependencies: proofA.dependencies.map((dependency) => ({
        ...dependency,
        expressionPriorBars: 4,
        totalRequiredPriorTargetBars: 6,
      })),
    },
    {
      ...proofA,
      dependencies: proofA.dependencies.map((dependency) => ({
        ...dependency,
        lookahead: true,
      })),
    },
    {
      ...proofA,
      alignmentEvidence: {
        kind: 'utc-24x7' as const,
        weekAnchorSec: unixSecond(4 * 86_400),
      },
    },
    {
      ...proofA,
      alignmentEvidence: {
        kind: 'exchange-calendar' as const,
        calendar: {
          calendarId: 'XNYS',
          version: '2026a',
          coverage: { from: 100, to: 300 },
          sessions: [{ from: 100, to: 300 }],
        },
      },
    },
    { ...proofA, acquisitionKey: 'security-key-b' },
  ]) {
    expect(
      jobHash({ ...base, securityBars: { A: securityA }, securityProofs: { A: proofA } }),
    ).not.toBe(jobHash({ ...base, securityBars: { A: securityA }, securityProofs: { A: proof } }));
  }
  expect(jobHash(base)).not.toBe(jobHash({ ...base, includeTrades: true }));
});

test('magnifier bars, versions, timeframes, closes, coverage, provenance, and override are keyed', () => {
  const baseJob = { ...job(), useBarMagnifier: true, magnifier: magnifier() };
  const base = jobHash(baseJob);
  const variants: Job[] = [
    { ...baseJob, useBarMagnifier: false },
    { ...baseJob, magnifier: { ...baseJob.magnifier, requestedSymbol: 'Y' } },
    { ...baseJob, magnifier: { ...baseJob.magnifier, contractVersion: 2 } },
    { ...baseJob, magnifier: { ...baseJob.magnifier, mappingVersion: 2 } },
    { ...baseJob, magnifier: { ...baseJob.magnifier, targetPineTf: '5' } },
    { ...baseJob, magnifier: { ...baseJob.magnifier, targetCanonicalTf: '5m' } },
    { ...baseJob, magnifier: { ...baseJob.magnifier, sourceCanonicalTf: '1m' } },
    {
      ...baseJob,
      magnifier: {
        ...baseJob.magnifier,
        barsMs: [{ ...baseJob.magnifier.barsMs[0]!, close: 2.5 }, baseJob.magnifier.barsMs[1]!],
      },
    },
    {
      ...baseJob,
      magnifier: {
        ...baseJob.magnifier,
        chartOpenTimesMs: [1, 1_000] as ResolvedMagnifierDataset['chartOpenTimesMs'],
      },
    },
    {
      ...baseJob,
      magnifier: {
        ...baseJob.magnifier,
        chartCloseTimesMs: [1_001, 2_000] as ResolvedMagnifierDataset['chartCloseTimesMs'],
      },
    },
    {
      ...baseJob,
      magnifier: {
        ...baseJob.magnifier,
        coverage: { ...baseJob.magnifier.coverage, complete: false },
      },
    },
    {
      ...baseJob,
      magnifier: {
        ...baseJob.magnifier,
        provenance: { ...baseJob.magnifier.provenance, cacheIdentity: 'feed-b' },
      },
    },
    {
      ...baseJob,
      magnifier: {
        ...baseJob.magnifier,
        provenance: {
          ...baseJob.magnifier.provenance,
          weekAnchorSec: unixSecond(4 * 86_400),
        },
      },
    },
    {
      ...baseJob,
      magnifier: {
        ...baseJob.magnifier,
        alignmentEvidence: {
          kind: 'utc-24x7',
          weekAnchorSec: unixSecond(4 * 86_400),
        },
      },
    },
    { ...baseJob, magnifier: { ...baseJob.magnifier, barsDigest: 'tampered-digest' } },
    { ...baseJob, magnifier: { ...baseJob.magnifier, acquisitionKey: 'tampered-key' } },
  ];
  for (const variant of variants) expect(jobHash(variant)).not.toBe(base);
});

test('caller-owned arrays are safely re-digested after mutation', () => {
  const primary = bars();
  const before = jobHash(job(primary));
  primary[0]!.volume += 1;
  expect(jobHash(job(primary))).not.toBe(before);
});
