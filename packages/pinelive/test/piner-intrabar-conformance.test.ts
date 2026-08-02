import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { ArrayFeed, compile, Engine } from '@heyphat/piner';
import {
  StaticProvider,
  type Bar,
  type HistoryProvider,
  type HistoryRange,
  type HistoryRequest,
  type ResolvedHistorySource,
} from '@heyphat/pinery';
import {
  assertResolvedMagnifierDatasetForJob,
  preparePinerEngineForRun,
  resolveBarMagnifier,
  type Job,
} from '@heyphat/pinerun';

const FIXTURE_ROOT = new URL('./fixtures/piner-intrabar/', import.meta.url);
const BACKENDS = ['js', 'interp'] as const;
const oracle = JSON.parse(
  await readFile(new URL('piner-0.11.1-oracle.json', FIXTURE_ROOT), 'utf8'),
) as Oracle;

type Backend = (typeof BACKENDS)[number];
type TickFixture = { label: string; isClose: boolean; bar: Bar };
type MetadataProjection = {
  calcOnEveryTick: boolean | null;
  processOrdersOnClose: boolean | null;
  calcOnOrderFills: boolean | null;
  pyramiding: number | null;
  useBarMagnifier: boolean | null;
};
type Checkpoint = ReturnType<typeof projectCheckpoint>;
type OracleCase = {
  id: string;
  source: string;
  ticks: string;
  metadata: MetadataProjection;
  expected: Checkpoint[];
};
type MagnifierOracleCase = {
  id: string;
  source: string;
  metadata: MetadataProjection;
  resolver: Record<string, unknown>;
  historicalMagnifierActive: boolean;
  expected: Checkpoint[];
  magnifierReports: Array<Checkpoint['barMagnifier']>;
};
type Oracle = {
  schemaVersion: number;
  evidence: {
    runtime: string;
    version: string;
    kind: string;
    venueEvidence: boolean;
  };
  publicObservability: {
    pendingOrders: false;
    fillEvents: false;
    position: true;
    closedTrades: true;
  };
  metadataProbes: Record<string, boolean | null>;
  barSets: Record<string, Bar[] | TickFixture[]>;
  cases: OracleCase[];
  magnifierCases: MagnifierOracleCase[];
};

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Object.is(value, -0)
      ? 0
      : value
    : null;
}

function metadataProjection(compiled: ReturnType<typeof compile>): MetadataProjection {
  const strategy = (compiled.metadata.strategy ?? {}) as Record<string, unknown>;
  const get = <T extends boolean | number>(key: string): T | null =>
    Object.prototype.hasOwnProperty.call(strategy, key) ? (strategy[key] as T) : null;
  return {
    calcOnEveryTick: get<boolean>('calcOnEveryTick'),
    processOrdersOnClose: get<boolean>('processOrdersOnClose'),
    calcOnOrderFills: get<boolean>('calcOnOrderFills'),
    pyramiding: get<number>('pyramiding'),
    useBarMagnifier: get<boolean>('useBarMagnifier'),
  };
}

function projectCheckpoint(engine: Engine) {
  const strategy = engine.ctx.strategy as unknown as Record<string, unknown>;
  const state = engine.ctx.barstate as unknown as Record<string, boolean>;
  const report = engine.strategy as unknown as Record<string, unknown>;
  const closedTrades = (report.closedTrades ?? []) as Array<Record<string, unknown>>;
  const magnifier = report.barMagnifier as Record<string, unknown> | undefined;
  const plots = Object.fromEntries(
    [...engine.outputs.plots.values()]
      .sort((left, right) => left.id - right.id)
      .map((plot) => [plot.title, [plot.data.length, finite(plot.data.at(-1))]]),
  );
  return {
    barstate: [state.isnew, state.isrealtime, state.isconfirmed, state.ishistory],
    plots,
    alerts: engine.outputs.alerts.map((alert) => [alert.bar, alert.message]),
    position: [
      finite(strategy.position_size),
      finite(strategy.position_avg_price),
      strategy.position_entry_name,
      finite(strategy.opentrades),
      finite(strategy.closedtrades),
    ],
    closedTrades: closedTrades.map((trade) => [
      trade.entryId,
      finite(trade.dir),
      finite(trade.qty),
      finite(trade.entryPrice),
      finite(trade.exitPrice),
      finite(trade.entryBar),
      finite(trade.exitBar),
      finite(trade.entryTime),
      finite(trade.exitTime),
      finite(trade.profit),
      finite(trade.cumProfit),
    ]),
    report: [finite(report.barsProcessed), finite(report.barsInMarket), finite(report.netProfit)],
    barMagnifier: magnifier
      ? [
          magnifier.requested,
          magnifier.active,
          magnifier.targetTimeframe,
          finite(magnifier.magnifiedBars),
          finite(magnifier.fallbackBars),
          finite(magnifier.capFallbackBars),
          finite(magnifier.dataFallbackBars),
          finite(magnifier.intrabarsUsed),
          magnifier.coverage,
          finite(magnifier.firstMagnifiedBar),
        ]
      : null,
  };
}

function bars(name: string): Bar[] {
  return oracle.barSets[name] as Bar[];
}

function ticks(name: string): TickFixture[] {
  return oracle.barSets[name] as TickFixture[];
}

async function fixtureSource(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURE_ROOT), 'utf8');
}

function assertCheckpoint(
  fixtureId: string,
  backend: Backend,
  label: string,
  actual: Checkpoint,
  expected: Checkpoint | undefined,
): void {
  expect(expected, `${fixtureId}/${backend}/${label}: oracle checkpoint exists`).toBeDefined();
  expect(actual, `${fixtureId}/${backend}/${label}`).toEqual(expected!);
}

async function exercise(
  fixtureId: string,
  source: string,
  warmup: Bar[],
  updates: TickFixture[],
  expected: Checkpoint[],
  prepare?: (engine: Engine) => void,
  afterCheckpoint?: () => void,
): Promise<Record<Backend, Checkpoint[]>> {
  const byBackend = {} as Record<Backend, Checkpoint[]>;
  for (const backend of BACKENDS) {
    const compiled = compile(source);
    expect(compiled.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
    const engine = new Engine(compiled, new ArrayFeed(warmup), { backend });
    prepare?.(engine);
    await engine.run({ symbol: 'X', timeframe: '60', mintick: 0.01 });
    const checkpoints: Checkpoint[] = [];
    const warmupCheckpoint = projectCheckpoint(engine);
    checkpoints.push(warmupCheckpoint);
    assertCheckpoint(fixtureId, backend, 'warmup', warmupCheckpoint, expected[0]);
    afterCheckpoint?.();
    for (const [index, update] of updates.entries()) {
      engine.tick(update.bar, update.isClose);
      const checkpoint = projectCheckpoint(engine);
      checkpoints.push(checkpoint);
      assertCheckpoint(fixtureId, backend, update.label, checkpoint, expected[index + 1]);
      afterCheckpoint?.();
    }
    byBackend[backend] = checkpoints;
  }
  expect(byBackend.interp, `${fixtureId}: backend agreement`).toEqual(byBackend.js);
  return byBackend;
}

class SealableExactProvider implements HistoryProvider {
  readonly id = 'piner-intrabar-offline-exact';
  exactCalls = 0;
  historyCalls = 0;
  private sealed = false;

  constructor(private readonly inner: StaticProvider) {}

  seal(): void {
    this.sealed = true;
  }

  history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    this.historyCalls++;
    if (this.sealed) throw new Error('exact provider read after finite preparation');
    return this.inner.history(symbol, timeframe, range);
  }

  async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
    if (this.sealed) throw new Error('exact provider resolution after finite preparation');
    const source = await this.inner.resolveHistorySource(symbol);
    return {
      ...source,
      history: async (request: HistoryRequest) => {
        if (this.sealed) throw new Error('exact provider read after finite preparation');
        this.exactCalls++;
        return source.history(request);
      },
    };
  }
}

function resolverProjection(dataset: NonNullable<Job['magnifier']>) {
  return {
    targetPineTf: dataset.targetPineTf,
    targetCanonicalTf: dataset.targetCanonicalTf,
    sourceCanonicalTf: dataset.sourceCanonicalTf,
    barCount: dataset.barsMs.length,
    chartOpenTimesMs: dataset.chartOpenTimesMs,
    chartCloseTimesMs: dataset.chartCloseTimesMs,
    coverage: dataset.coverage,
  };
}

function withoutMagnifier(checkpoint: Checkpoint) {
  return { ...checkpoint, barMagnifier: null };
}

describe('piner 0.11.1 repeated-forming-bar offline regression oracle', () => {
  test('fixture provenance and calc_on_every_tick metadata are pinned', () => {
    expect(oracle).toMatchObject({
      schemaVersion: 2,
      evidence: {
        runtime: '@heyphat/piner',
        version: '0.11.1',
        kind: 'repository-owned-offline-piner-regression-evidence',
        venueEvidence: false,
      },
      publicObservability: {
        pendingOrders: false,
        fillEvents: false,
        position: true,
        closedTrades: true,
      },
    });
    for (const [name, declaration] of [
      ['declaredTrue', ', calc_on_every_tick=true'],
      ['declaredFalse', ', calc_on_every_tick=false'],
      ['omitted', ''],
    ] as const) {
      const compiled = compile(`//@version=6\nstrategy("metadata"${declaration})\nplot(close)`);
      const strategy = (compiled.metadata.strategy ?? {}) as Record<string, unknown>;
      const actual = Object.prototype.hasOwnProperty.call(strategy, 'calcOnEveryTick')
        ? strategy.calcOnEveryTick
        : null;
      expect(actual, name).toBe(oracle.metadataProbes[name]);
    }
  });

  for (const fixture of oracle.cases) {
    test(`${fixture.id}: both backends match every warmup/revision checkpoint`, async () => {
      const source = await fixtureSource(fixture.source);
      const compiled = compile(source);
      expect(metadataProjection(compiled)).toEqual(fixture.metadata);
      await exercise(
        fixture.id,
        source,
        bars('ordinaryWarmupMs'),
        ticks(fixture.ticks),
        fixture.expected,
      );
    });
  }

  for (const fixture of oracle.magnifierCases) {
    test(`${fixture.id}: resolver-issued finite warmup continues without stale exact reads`, async () => {
      const magnifiedSource = await fixtureSource(fixture.source);
      const standardSource = magnifiedSource.replace(
        'use_bar_magnifier=true',
        'use_bar_magnifier=false',
      );
      expect(standardSource).not.toBe(magnifiedSource);
      expect(metadataProjection(compile(magnifiedSource))).toEqual(fixture.metadata);
      expect(metadataProjection(compile(standardSource))).toEqual({
        ...fixture.metadata,
        useBarMagnifier: false,
      });

      const chartBars = bars('magnifierChartSec');
      const childBars = bars('magnifierChildrenSec');
      const provider = new SealableExactProvider(
        new StaticProvider(
          { 'X|10m': childBars },
          {
            alignment: 'utc-24x7',
            timeframes: ['10m'],
            cacheIdentity: `piner-intrabar-${fixture.id}`,
          },
        ),
      );
      const job: Job = {
        source: magnifiedSource,
        symbol: 'X',
        timeframe: '60',
        bars: chartBars,
      };
      const resolution = await resolveBarMagnifier(job, '1h', provider);
      const dataset = resolution.dataset;
      expect(dataset, `${fixture.id}: resolver-issued dataset`).toBeDefined();
      if (!dataset) throw new Error(`${fixture.id}: resolver did not issue magnifier data`);
      expect(assertResolvedMagnifierDatasetForJob(job, resolution.preflight)).toBe(dataset);
      expect(Object.isFrozen(dataset)).toBe(true);
      expect(resolverProjection(dataset)).toEqual(fixture.resolver);
      expect(provider.historyCalls).toBe(0);
      expect(provider.exactCalls).toBe(1);
      provider.seal();
      const readsAtCutover = provider.exactCalls;
      const updates = ticks('magnifierTicksMs');
      const warmupMs = chartBars.map((bar) => ({ ...bar, time: bar.time * 1000 }));
      const observed = {} as Record<'standard' | 'magnified', Record<Backend, Checkpoint[]>>;

      for (const mode of ['standard', 'magnified'] as const) {
        const source = mode === 'magnified' ? magnifiedSource : standardSource;
        const expected =
          mode === 'standard'
            ? fixture.expected
            : fixture.expected.map((checkpoint, index) => ({
                ...checkpoint,
                barMagnifier: fixture.magnifierReports[index],
              }));
        const result = await exercise(
          fixture.id,
          source,
          warmupMs,
          updates,
          expected,
          mode === 'magnified'
            ? (engine) => {
                const preparation = preparePinerEngineForRun(engine, job);
                expect(preparation.magnifier?.acquisitionKey).toBe(dataset.acquisitionKey);
                expect(preparation.magnifier?.barsDigest).toBe(dataset.barsDigest);
              }
            : undefined,
          () => {
            expect(provider.exactCalls, `${fixture.id}/${mode}: no post-prepare exact read`).toBe(
              readsAtCutover,
            );
          },
        );
        observed[mode] = result;
      }

      for (const backend of BACKENDS) {
        expect(
          observed.magnified[backend].map(withoutMagnifier),
          `${fixture.id}/${backend}: finite continuation matches standard semantics`,
        ).toEqual(observed.standard[backend]);
        const warmupReport = observed.magnified[backend][0]!.barMagnifier!;
        const firstLiveReport = observed.magnified[backend][1]!.barMagnifier!;
        expect(warmupReport[1], `${backend}: reported historical magnifier activity`).toBe(
          fixture.historicalMagnifierActive,
        );
        expect(firstLiveReport[3], `${backend}: historical magnified count remains fixed`).toBe(
          warmupReport[3],
        );
        if (fixture.historicalMagnifierActive) {
          expect(
            warmupReport[3] as number,
            `${backend}: active warmup magnifies chart bars`,
          ).toBeGreaterThan(0);
          expect(
            warmupReport[7] as number,
            `${backend}: active warmup consumes resolver children`,
          ).toBeGreaterThan(0);
        } else {
          expect(warmupReport.slice(3)).toEqual([0, 2, 0, 0, 0, 'no-data', null]);
        }
        expect(
          firstLiveReport[4] as number,
          `${backend}: first live bar uses fallback rather than historical children`,
        ).toBeGreaterThan(0);
        expect(firstLiveReport[5], `${backend}: finite fixture never reports a cap fallback`).toBe(
          0,
        );
      }
      expect(provider.exactCalls).toBe(readsAtCutover);
    });
  }
});
