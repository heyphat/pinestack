import { test, expect } from 'bun:test';
import { StaticProvider, type Bar } from '@heyphat/pinery';
import {
  LocalRunner,
  pinerCapabilities,
  parseAxes,
  resolveBarMagnifier,
  scan,
  securityDatasetAcquisitionKey,
  walkforward,
} from '../src/index.js';
import type { Job, ResolvedMagnifierDataset, ResolvedSecurityDatasetProof } from '../src/job.js';
import { marketDataDigest } from '../src/hash.js';
import { WorkerPoolRunner } from '../src/node.js';

const SRC = `//@version=6
indicator("sma")
plot(ta.sma(close, 10), title="sma")
`;

const runtimeCapableTest = pinerCapabilities().capable ? test : test.skip;

function ramp(n: number, start: number, step: number, intervalSec = 3600): Bar[] {
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const open = close;
    close += step;
    bars.push({
      time: start + i * intervalSec,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 100,
    });
  }
  return bars;
}

function deepFreezeFixture<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeFixture(child, seen);
  }
  return Object.freeze(value);
}

function magnifier(barsMs: readonly Bar[]): ResolvedMagnifierDataset {
  return {
    contractVersion: 1,
    mappingVersion: 1,
    requestedSymbol: 'A',
    targetPineTf: '10',
    targetCanonicalTf: '10m',
    sourceCanonicalTf: '10m',
    barsMs,
    chartOpenTimesMs: barsMs.map((bar) => bar.time) as ResolvedMagnifierDataset['chartOpenTimesMs'],
    chartCloseTimesMs: barsMs.map(
      (bar) => bar.time + 3600,
    ) as ResolvedMagnifierDataset['chartCloseTimesMs'],
    chartIntervalSource: 'host-explicit',
    coverage: {
      requested: { from: 1, to: 2 } as ResolvedMagnifierDataset['coverage']['requested'],
      covered: [{ from: 1, to: 2 }] as ResolvedMagnifierDataset['coverage']['covered'],
      gaps: [],
      complete: true,
    },
    provenance: {
      cacheIdentity: 'pool',
      normalizedSymbol: 'A',
      sourceTimeframe: '10m',
      targetTimeframe: '10m',
      alignment: 'utc-24x7',
      aggregationVersion: 0,
    },
    alignmentEvidence: { kind: 'utc-24x7' },
    barsDigest: marketDataDigest(barsMs),
    acquisitionKey: 'pool-key',
  };
}

function aliasedMagnifierJob(bars: Bar[]): Job {
  return {
    source: SRC,
    symbol: 'A',
    timeframe: '60',
    bars,
    useBarMagnifier: false,
    securityBars: { A: bars, 'A@10': bars },
    magnifier: magnifier(bars),
  };
}

test('WorkerPoolRunner sends a shared bar set once per worker (sweep-style jobs)', async () => {
  const PARAM_SRC = `//@version=6
indicator("sma param")
len = input.int(10, "len")
plot(ta.sma(close, len), title="sma")
`;
  const bars = ramp(80, 1_700_000_000, 2); // ONE dataset shared by every job
  const other = ramp(80, 1_700_000_000, 1); // a second dataset to break the cache
  const runner = new WorkerPoolRunner({ size: 2 });
  try {
    const jobs = [5, 10, 20, 40].map((len) => ({
      id: `len=${len}`,
      source: PARAM_SRC,
      symbol: 'A',
      timeframe: '60',
      bars,
      inputs: { len },
    }));
    // Interleave a different dataset, then return to the shared one — exercises
    // both the omitted-bars cache hit and the cache-replacement path.
    jobs.splice(2, 0, {
      id: 'other',
      source: PARAM_SRC,
      symbol: 'B',
      timeframe: '60',
      bars: other,
      inputs: { len: 10 },
    });

    const results = await runner.runAll(jobs, { concurrency: 2 });
    expect(results.every((r) => r.ok)).toBe(true);
    // Different lookbacks over the same series → different final SMAs.
    const values = results
      .filter((r) => r.symbol === 'A')
      .map((r) => r.plots[0]!.data[r.plots[0]!.data.length - 1]);
    expect(new Set(values.map((v) => v!.toFixed(6))).size).toBe(4);
  } finally {
    await runner.close();
  }
}, 20_000);

test('WorkerPoolRunner runs a scan across worker threads', async () => {
  const provider = new StaticProvider({
    A: ramp(80, 1_700_000_000, +2),
    B: ramp(80, 1_700_000_000, +1),
    C: ramp(80, 1_700_000_000, -1),
  });
  const runner = new WorkerPoolRunner({ size: 2 });
  try {
    const report = await scan({
      source: SRC,
      symbols: ['A', 'B', 'C'],
      timeframe: '1h',
      provider,
      rank: 'last(sma)',
      runner,
    });
    expect(report.errors).toHaveLength(0);
    expect(report.ranked).toHaveLength(3);
    // Steeper ramp → higher final SMA.
    expect(report.ranked.map((r) => r.result.symbol)).toEqual(['A', 'B', 'C']);
  } finally {
    await runner.close();
  }
}, 20_000);

test('WorkerPoolRunner hydrates chart/security aliases within one message', async () => {
  const bars = ramp(20, 1_700_000_000, 1);
  const runner = new WorkerPoolRunner({ size: 1 });
  try {
    const result = await runner.run({
      source: SRC,
      symbol: 'A',
      timeframe: '60',
      bars,
      // The chart series is deliberately reused under two security keys. Only
      // the first ref carries a payload; both bare aliases must resolve from
      // this same message rather than the worker's previous-message cache.
      securityBars: {
        A: bars,
        'A@10': bars,
      },
    });
    expect(result.ok).toBe(true);
  } finally {
    await runner.close();
  }
}, 20_000);

test('WorkerPoolRunner resends a mutable array identity after its content changes', async () => {
  const bars = ramp(2, 1_700_000_000, 1);
  const source = '//@version=6\nindicator("mutable wire")\nplot(close, "close")';
  const runner = new WorkerPoolRunner({ size: 1 });
  try {
    const first = await runner.run({ source, symbol: 'A', timeframe: '60', bars });
    expect(first.ok).toBe(true);
    expect(first.plots[0]!.data.at(-1)).toBe(bars.at(-1)!.close);

    bars.at(-1)!.close = 999;
    bars.at(-1)!.high = 1_000;
    const second = await runner.run({ source, symbol: 'A', timeframe: '60', bars });
    expect(second.ok).toBe(true);
    expect(second.plots[0]!.data.at(-1)).toBe(999);
  } finally {
    await runner.close();
  }
}, 20_000);

test('local and real-worker results match with chart/security/magnifier same-array aliases', async () => {
  const bars = ramp(30, 1_700_000_000, 1);
  const job = aliasedMagnifierJob(bars);
  const local = await new LocalRunner().run(job);
  const runner = new WorkerPoolRunner({ size: 1 });
  try {
    const worker = await runner.run(job);
    expect(worker.ok).toBe(true);
    expect({ ...worker, elapsedMs: undefined }).toEqual({ ...local, elapsedMs: undefined });
  } finally {
    await runner.close();
  }
}, 20_000);

runtimeCapableTest(
  'requested capable runtime injects resolved data identically in local and real workers',
  async () => {
    // This requires the real worker process to load a contract-capable piner;
    // unlike resolver unit tests, its runtime cannot be replaced by an adjacent adapter.
    const start = 1_700_002_800; // UTC-aligned to both 1h chart and 10m target bars
    const chart = ramp(2, start, 1);
    const provider = new StaticProvider(
      { 'A|10m': ramp(12, start, 0.1, 600) },
      { alignment: 'utc-24x7', timeframes: ['10m'], cacheIdentity: 'pool-capable' },
    );
    const job: Job = {
      source: '//@version=6\nstrategy("magnified", use_bar_magnifier=true)\nplot(close)',
      symbol: 'A',
      timeframe: '60',
      bars: chart,
    };
    await resolveBarMagnifier(job, '1h', provider);

    const local = await new LocalRunner().run(job);
    const runner = new WorkerPoolRunner({ size: 1 });
    try {
      const worker = await runner.run(job);
      expect(local.ok).toBe(true);
      // Resolved data + capable engine traverses. The worker-equality assertion
      // below is the real subject of this test and now compares ACTIVE reports.
      expect(local.strategy?.barMagnifier).toMatchObject({ requested: true, active: true });
      expect({ ...worker, elapsedMs: undefined }).toEqual({ ...local, elapsedMs: undefined });
    } finally {
      await runner.close();
    }
  },
  20_000,
);

runtimeCapableTest(
  'forged complete static-security coverage fails identically before local and worker piner execution',
  async () => {
    const start = 1_700_002_800;
    const chart = ramp(2, start, 1);
    const source = `//@version=6
strategy("forged static coverage", use_bar_magnifier=true)
plot(request.security("B", timeframe.period, close))`;
    const provider = new StaticProvider(
      {
        'A|10m': ramp(12, start, 0.1, 600),
        'B|1h': ramp(2, start, 0.2),
      },
      {
        alignment: 'utc-24x7',
        timeframes: ['10m', '1h'],
        cacheIdentity: 'pool-forged-security',
      },
    );
    const job: Job = {
      source,
      symbol: 'A',
      timeframe: '60',
      bars: chart,
    };
    await resolveBarMagnifier(job, '1h', provider);

    const original = job.securityProofs!.B!;
    const empty = deepFreezeFixture([]) as unknown as Bar[];
    const { acquisitionKey: _oldKey, ...originalBound } = original;
    const bound = deepFreezeFixture({
      ...originalBound,
      barsDigest: marketDataDigest(empty),
    }) satisfies Omit<ResolvedSecurityDatasetProof, 'acquisitionKey'>;
    const forged = deepFreezeFixture({
      ...bound,
      acquisitionKey: securityDatasetAcquisitionKey(bound),
    }) satisfies ResolvedSecurityDatasetProof;
    job.securityBars = { B: empty };
    job.securityProofs = { B: forged };

    const local = await new LocalRunner().run(job);
    expect(local.ok).toBe(false);
    expect(local.failure).toMatchObject({
      code: 'unresolved-static-security-with-bar-magnifier',
      permanent: true,
    });

    const runner = new WorkerPoolRunner({ size: 1 });
    try {
      const worker = await runner.run(job);
      expect(worker.ok).toBe(false);
      expect(worker.failure).toMatchObject({
        code: 'unresolved-static-security-with-bar-magnifier',
        permanent: true,
      });
      expect(worker.error).toBe(local.error);
    } finally {
      await runner.close();
    }
  },
  20_000,
);

test('a dead worker is replaced and the next magnifier-bearing job hydrates from scratch', async () => {
  const runner = new WorkerPoolRunner({ size: 1 });
  try {
    const internals = runner as unknown as {
      workers: Array<{ dead: boolean; terminate(): Promise<number> }>;
    };
    await internals.workers[0]!.terminate();
    for (let attempt = 0; attempt < 100 && !internals.workers[0]!.dead; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(internals.workers[0]!.dead).toBe(true);

    const job = aliasedMagnifierJob(ramp(30, 1_700_000_000, 1));
    const recovered = await runner.run(job);
    expect(recovered.ok).toBe(true);
  } finally {
    await runner.close();
  }
}, 20_000);

runtimeCapableTest(
  'cross-symbol lookahead_on final-bucket proofs rehydrate identically in local and real workers',
  async () => {
    const day = 86_400;
    const dayStart = 1_700_006_400;
    const chart = ramp(2, dayStart, 1);
    const dependency = ramp(72, dayStart - 2 * day, 1);
    const source = `//@version=6
strategy("worker lookahead", use_bar_magnifier=true)
d = request.security("B", "D", close, lookahead=barmerge.lookahead_on)
plot(d, "d")`;
    const provider = new StaticProvider(
      {
        'A|10m': ramp(12, dayStart, 0.1, 600),
        'B|1h': dependency,
      },
      {
        alignment: 'utc-24x7',
        timeframes: ['10m', '1h'],
        cacheIdentity: 'pool-lookahead-final-bucket',
      },
    );
    const job: Job = {
      source,
      symbol: 'A',
      timeframe: '60',
      bars: chart,
    };
    await resolveBarMagnifier(job, '1h', provider);
    expect(job.securityProofs?.B).toMatchObject({
      requestKind: 'cross-plain',
      lookaheadOnCanonicalTfs: ['1d'],
      requested: { to: dayStart + day },
    });

    const local = await new LocalRunner().run(job);
    const runner = new WorkerPoolRunner({ size: 1 });
    try {
      const worker = await runner.run(job);
      expect(local.ok).toBe(true);
      expect(worker.ok).toBe(true);
      const expected = dependency.at(-1)!.close;
      expect(local.plots.find((plot) => plot.title === 'd')?.data).toEqual([expected, expected]);
      expect({ ...worker, elapsedMs: undefined }).toEqual({ ...local, elapsedMs: undefined });
    } finally {
      await runner.close();
    }
  },
  20_000,
);

runtimeCapableTest(
  'walkforward real workers receive self/cross lower-TF IS prefixes without OOS rows',
  async () => {
    const start = 1_700_002_800;
    const chart = ramp(3, start, 1);
    const lower = (base: number) => ramp(18, start, 0.1 + base / 1_000, 600);
    const runner = new WorkerPoolRunner({ size: 1 });
    try {
      for (const testCase of [
        { label: 'self', symbol: 'syminfo.tickerid' },
        { label: 'cross', symbol: '"B"' },
      ]) {
        const source = `//@version=6
strategy("worker ${testCase.label} lower prefix", use_bar_magnifier=true)
choice = input.int(1, "choice")
values = request.security_lower_tf(${testCase.symbol}, "10", close)
score = array.size(values) == 6 ? choice : -choice
plot(score, "score")`;
        const report = await walkforward({
          source,
          symbol: 'A',
          timeframe: '1h',
          provider: new StaticProvider(
            {
              A: chart,
              'A|10m': lower(10),
              'B|10m': lower(20),
            },
            {
              alignment: 'utc-24x7',
              timeframes: ['10m'],
              cacheIdentity: `pool-walkforward-${testCase.label}-lower-prefix`,
            },
          ),
          axes: parseAxes(['choice=1,2']),
          rank: 'last(score)',
          windows: 1,
          oosFraction: 1 / 3,
          runner,
        });
        const window = report.windows[0]!;
        expect(window.error, testCase.label).toBeUndefined();
        expect(window.winner, testCase.label).toEqual({ choice: 2 });
        expect(window.winnerValue, testCase.label).toBe(2);
        expect(
          window.result?.plots.find((plot) => plot.title === 'score')?.data,
          testCase.label,
        ).toEqual([2, 2, 2]);
      }
    } finally {
      await runner.close();
    }
  },
  30_000,
);
