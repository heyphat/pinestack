import { ArrayFeed, compile, CompileError, Engine } from '@heyphat/piner';
import type { CompiledScript } from '@heyphat/piner';
import {
  barCloseTime,
  toPinerTimeframe,
  type MarketDataProvider,
  type ResolvedDataInstrument,
} from '@heyphat/pinery';
import { isMarkableBroker } from '../brokers/paper.js';
import type { Broker } from './broker.js';
import { createRunInstrumentBinding, type RunInstrumentBinding } from './binding.js';
import type {
  BindingRecord,
  ForwardRecord,
  SecurityFeedHealthRecord,
  StartupRecord,
} from './ledger.js';
import { PositionMirror } from './mirror.js';
import type { PositionMirrorOptions, ReconcileOutcome } from './mirror.js';
import {
  DEFAULT_SECURITY_REQUEST_TIMEOUT_MS,
  discoverSecurityRequests,
  findUncoveredSecurityFeeds,
  planSecurityFromRequests,
  planSecurityFromStatic,
  SecurityFeedError,
  SecurityFeedManager,
  type SecurityFeedHealth,
  type SecurityFeedSpec,
} from './security.js';
import { toPinerBar } from './time.js';
import type { Bar, Instrument } from './types.js';

type StrategyOptionsWithMinQty = NonNullable<
  NonNullable<ConstructorParameters<typeof Engine>[2]>['strategy']
> & { minQty?: number };

export interface ForwardRunnerOptions {
  source: string;
  symbol: string;
  timeframe: string;
  warmupBars?: number;
  inputs?: Readonly<Record<string, unknown>>;
  backend?: 'js' | 'interp';
  runId?: string;
  strategyId?: string;
  executionId?: string;
  /** Explicit startup drift correction. Disabled by default and ledgered separately. */
  reconcileOnStart?: boolean;
  /**
   * Resolve `request.security` dependencies by opening secondary provider feeds. Default
   * true. Set false to run without them — every request then degrades to `na`/`[]`, which
   * changes what the strategy trades, so the runner refuses unless you also accept that by
   * leaving the strategy free of security dependencies.
   */
  resolveSecurity?: boolean;
  /**
   * Bars fetched per secondary feed at startup. Defaults to the number of chart-history bars
   * actually received; each feed gets at least this many bars of its OWN timeframe so
   * higher-timeframe indicators warm up.
   */
  securityWarmupBars?: number;
  /** Hard total-series ceiling per feed. Exceeding it stops rather than truncating history. */
  maxSecurityBars?: number;
  /** Maximum dependency feeds opened by one strategy. Default 32. */
  maxSecurityFeeds?: number;
  /** Maximum concurrent secondary-provider requests. Default 4. */
  securityConcurrency?: number;
  /** Timeout per secondary-provider request in milliseconds. Default 30000. */
  securityRequestTimeoutMs?: number;
  /** Failed refreshes tolerated before stopping reconciliation. Default 0. */
  maxSecurityStaleRefreshes?: number;
  /** A secondary feed was fetched at startup. */
  onSecurityFetch?: (key: string, bars: number) => void | Promise<void>;
  /** A secondary refresh failed. The default policy stops on the first failure. */
  onSecurityError?: (key: string, error: string) => void | Promise<void>;
  /** Durable health event emitted before stale-feed policy is applied. */
  onSecurityHealth?: (record: SecurityFeedHealthRecord) => void | Promise<void>;
  mirror?: PositionMirrorOptions;
  onBinding?: (record: BindingRecord) => void | Promise<void>;
  onStartupRecord?: (record: StartupRecord) => void | Promise<void>;
  onRecord?: (record: ForwardRecord) => void | Promise<void>;
}

export class ForwardRunnerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ForwardRunnerError';
  }
}

function sourceId(source: string): string {
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `pine-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export class ForwardRunner {
  private compiled?: CompiledScript;
  private engine?: Engine;
  private mirror?: PositionMirror;
  private instrument?: Instrument;
  private resolved?: ResolvedDataInstrument;
  private runBinding?: RunInstrumentBinding;
  private securityFeeds?: SecurityFeedManager;
  private abort = new AbortController();
  private initialized = false;
  private running = false;
  private sequence = 0;
  private lastBarTime = -Infinity;
  private readonly runId: string;
  private readonly strategyId: string;

  constructor(
    private readonly data: MarketDataProvider,
    private readonly broker: Broker,
    private readonly options: ForwardRunnerOptions,
  ) {
    this.strategyId = options.strategyId ?? sourceId(options.source);
    this.runId = options.runId ?? `${this.strategyId}-${Date.now()}`;
  }

  get binding(): RunInstrumentBinding | undefined {
    return this.runBinding;
  }

  /** Resolved `request.security` feeds, once `init()` has run. Empty when there are none. */
  get securityFeedSpecs(): readonly SecurityFeedSpec[] {
    return this.securityFeeds?.specs ?? [];
  }

  /**
   * Plan the secondary feeds. Static-first from compile metadata; a dependency whose symbol
   * or timeframe is computed at runtime forces one throwaway discovery run under a sentinel
   * symbol, which is how the self-vs-literal distinction is recovered.
   */
  private async planSecurityFeeds(
    deps: CompiledScript['metadata']['securityDependencies'],
    pinerHistory: readonly Bar[],
    pinerTimeframe: string,
  ): Promise<SecurityFeedSpec[]> {
    const chartSymbol = this.runBinding!.strategySymbol;
    const staticFeeds = planSecurityFromStatic(deps, this.options.timeframe, chartSymbol);
    if (staticFeeds) return staticFeeds;
    let requests;
    try {
      requests = await discoverSecurityRequests(this.compiled!, pinerHistory, {
        timeframe: pinerTimeframe,
        inputs: this.options.inputs,
        backend: this.options.backend,
        mintick: this.runBinding!.mintick,
      });
    } catch (error) {
      throw new ForwardRunnerError(
        `request.security has runtime-computed arguments and the discovery run failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return planSecurityFromRequests(requests, this.options.timeframe, chartSymbol);
  }

  /**
   * Dynamic call sites are discovered once for startup, then monitored forever. A new symbol,
   * timeframe-qualified key, or finer bare-symbol requirement stops the run before broker
   * reconciliation instead of letting piner silently evaluate it as na/[].
   */
  private assertSecurityDependenciesCovered(): void {
    if (!this.engine || !this.runBinding) return;
    const uncovered = findUncoveredSecurityFeeds(
      this.engine.outputs.securityRequests,
      this.securityFeedSpecs,
      this.options.timeframe,
      this.runBinding.strategySymbol,
    );
    if (uncovered.length > 0)
      throw new ForwardRunnerError(
        `request.security declared a dependency after initialization (${uncovered
          .map((feed) => `${feed.key}@${feed.fetchTf}`)
          .join(', ')}); the run stopped before reconciliation because that series was not warmed`,
      );
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.ensureActive();
    try {
      this.compiled = compile(this.options.source);
    } catch (error) {
      throw new ForwardRunnerError(
        error instanceof CompileError ? error.message : 'Pine compilation failed',
        { cause: error },
      );
    }
    const errors = this.compiled.diagnostics.filter(
      (diagnostic) => diagnostic.severity === 'error',
    );
    if (errors.length > 0)
      throw new ForwardRunnerError(
        `Pine compilation failed: ${errors.map((error) => error.message).join('; ')}`,
      );
    if (!this.compiled.metadata.isStrategy)
      throw new ForwardRunnerError('Pine source must declare a strategy(), not an indicator()');
    const securityDeps = this.compiled.metadata.securityDependencies;
    if (securityDeps.length > 0 && this.options.resolveSecurity === false)
      throw new ForwardRunnerError(
        'this strategy uses request.security but resolveSecurity is disabled; those requests ' +
          'would degrade to na and the strategy would trade differently than it backtested',
      );

    this.resolved = await this.data.resolve(this.options.symbol, {
      strict: true,
      signal: this.abort.signal,
    });
    this.ensureActive();
    await this.broker.connect?.(this.abort.signal);
    this.ensureActive();
    this.instrument = await this.broker.instrument(this.resolved.venueSymbol, this.abort.signal);
    this.ensureActive();
    this.runBinding = createRunInstrumentBinding(
      this.data,
      this.resolved,
      this.broker,
      this.instrument,
    );
    await this.options.onBinding?.({
      schemaVersion: 2,
      recordType: 'binding',
      configVersion: 1,
      runId: this.runId,
      binding: this.runBinding,
      recordedAt: new Date().toISOString(),
    });
    this.ensureActive();

    const requestedWarmupBars = this.options.warmupBars ?? 200;
    const history = await this.data.historyResolved(
      this.resolved,
      this.options.timeframe,
      { limit: requestedWarmupBars },
      this.abort.signal,
    );
    this.ensureActive();
    if (history.length < requestedWarmupBars)
      throw new ForwardRunnerError(
        `primary warmup returned ${history.length} bars but ${requestedWarmupBars} were requested`,
      );
    const pinerHistory = history.map(toPinerBar);
    const pinerTimeframe = toPinerTimeframe(this.options.timeframe);

    // request.security: plan the secondary feeds, then fetch them BEFORE the historical run
    // so the warmup pass sees the same series the backtest did.
    if (securityDeps.length > 0) {
      const feeds = await this.planSecurityFeeds(securityDeps, pinerHistory, pinerTimeframe);
      this.ensureActive();
      if (feeds.length > 0) {
        const newestChartBar = history.at(-1);
        if (!newestChartBar)
          throw new ForwardRunnerError(
            'request.security cannot warm secondary feeds without chart history',
          );
        const manager = new SecurityFeedManager(this.data, feeds, {
          chartTf: this.options.timeframe,
          chartInstrument: this.resolved,
          chartWarmupEnd: barCloseTime(newestChartBar.time, this.options.timeframe),
          // Default to the history actually received, not the requested chart limit.
          warmupBars: this.options.securityWarmupBars ?? history.length,
          maxBars: this.options.maxSecurityBars,
          maxFeeds: this.options.maxSecurityFeeds,
          concurrency: this.options.securityConcurrency,
          requestTimeoutMs: this.options.securityRequestTimeoutMs,
          maxStaleRefreshes: this.options.maxSecurityStaleRefreshes,
          signal: this.abort.signal,
          onFetch: this.options.onSecurityFetch,
          onError: async (key, error, health) => {
            await this.options.onSecurityError?.(key, error);
            await this.options.onSecurityHealth?.(this.securityHealthRecord(key, error, health));
          },
        });
        this.securityFeeds = manager;
        try {
          await manager.warmup();
        } catch (error) {
          // Fail closed: a live run must never start on a silently-na security series.
          throw error instanceof SecurityFeedError
            ? new ForwardRunnerError(error.message, { cause: error })
            : error;
        }
        this.ensureActive();
      }
    }

    const strategyOptions = { minQty: this.runBinding.qtyStep } as StrategyOptionsWithMinQty;
    this.engine = new Engine(this.compiled, new ArrayFeed(pinerHistory), {
      backend: this.options.backend ?? 'js',
      inputs: this.options.inputs,
      strategy: strategyOptions,
    });
    // Inject before run(): piner reads ctx.securityBars while replaying history, and the
    // arrays are mutated in place from here on, so no re-injection is needed per bar.
    this.securityFeeds?.inject(this.engine);
    await this.engine.run({
      symbol: this.runBinding.strategySymbol,
      timeframe: pinerTimeframe,
      mintick: this.runBinding.mintick,
    });
    this.assertSecurityDependenciesCovered();
    this.ensureActive();
    this.mirror = new PositionMirror(this.broker, this.instrument, this.options.mirror);
    this.initialized = true;

    const last = history.at(-1);
    if (last) {
      this.lastBarTime = last.time;
      if (this.options.reconcileOnStart) {
        const { record } = await this.reconcile(last, 'startup');
        await this.options.onStartupRecord?.({
          ...record,
          schemaVersion: 2,
          recordType: 'startup',
        });
        this.ensureActive();
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) throw new ForwardRunnerError('forward runner is already running');
    this.running = true;
    try {
      await this.init();
      for await (const bar of this.data.closedBars(this.resolved!, this.options.timeframe, {
        after: Number.isFinite(this.lastBarTime) ? this.lastBarTime : undefined,
        signal: this.abort.signal,
      })) {
        if (this.abort.signal.aborted) break;
        if (!Number.isFinite(bar.time))
          throw new ForwardRunnerError('provider emitted a bar with invalid time');
        if (bar.time <= this.lastBarTime) continue;
        if (this.securityFeeds) {
          await this.securityFeeds.refresh(bar.time);
          this.ensureActive();
        }
        this.engine!.tick(toPinerBar(bar), true);
        // Dynamic request arguments/call sites are checked after evaluation but before any
        // target can reach the broker.
        this.assertSecurityDependenciesCovered();
        this.lastBarTime = bar.time;
        const { record } = await this.reconcile(bar, 'cycle');
        await this.options.onRecord?.(record);
        this.ensureActive();
      }
    } finally {
      this.running = false;
    }
  }

  cancel(): void {
    this.abort.abort();
  }

  async stop(): Promise<void> {
    this.cancel();
    const timeoutMs = this.options.securityRequestTimeoutMs ?? DEFAULT_SECURITY_REQUEST_TIMEOUT_MS;
    const errors: unknown[] = [];
    const active = new Set<string>();
    const run = (
      name: string,
      operation: () => void | Promise<void> | undefined,
    ): Promise<void> => {
      active.add(name);
      return Promise.resolve()
        .then(operation)
        .catch((error: unknown) => {
          errors.push(error);
        })
        .finally(() => {
          active.delete(name);
        });
    };

    // Invoke disconnect before drain in microtask order so providers can interrupt their
    // transports, but start both under one deadline so a hanging disconnect cannot bypass the
    // manager's bounded failure path.
    const operations = [
      run('provider disconnect', () => this.data.disconnect?.()),
      run('security feed drain', () => this.securityFeeds?.drain()),
    ];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      Promise.all(operations).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!completed) {
      errors.push(
        new ForwardRunnerError(
          `forward runner shutdown timed out after ${timeoutMs}ms; unsettled: ${[...active].join(
            ', ',
          )}`,
        ),
      );
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, 'forward runner provider shutdown failed');
  }

  async disconnect(): Promise<void> {
    await this.broker.disconnect?.();
  }

  private async reconcile(
    bar: Bar,
    event: 'cycle' | 'startup',
  ): Promise<{ record: ForwardRecord; outcome: ReconcileOutcome }> {
    this.ensureActive();
    const binding = this.runBinding!;
    if (isMarkableBroker(this.broker))
      await this.broker.mark(binding.executionSymbol, bar.close, bar.time);
    this.ensureActive();
    const target = this.engine!.ctx.strategy.position_size;
    const sequence = this.sequence++;
    const outcome = await this.mirror!.reconcile(target, {
      strategySymbol: binding.strategySymbol,
      executionSymbol: binding.executionSymbol,
      bindingId: binding.id,
      barTime: bar.time,
      referencePrice: bar.close,
      strategyId: this.strategyId,
      executionId: this.options.executionId,
      timeframe: this.options.timeframe,
      sequence,
      signal: this.abort.signal,
    });
    return { outcome, record: this.record(sequence, bar, outcome, event) };
  }

  private record(
    sequence: number,
    bar: Bar,
    outcome: ReconcileOutcome,
    event: 'cycle' | 'startup',
  ): ForwardRecord {
    const binding = this.runBinding!;
    return {
      schemaVersion: 2,
      recordType: 'cycle',
      runId: this.runId,
      strategyId: this.strategyId,
      cycleId: `${event}:${binding.id}:${this.options.timeframe}:${bar.time}`,
      sequence,
      symbol: binding.strategySymbol,
      strategySymbol: binding.strategySymbol,
      executionSymbol: binding.executionSymbol,
      bindingId: binding.id,
      timeframe: this.options.timeframe,
      bar: { ...bar },
      target: outcome.target,
      actualBefore: outcome.actualBefore,
      actualAfter: outcome.actualAfter,
      delta: outcome.delta,
      action: outcome.action,
      clientId:
        outcome.action === 'order'
          ? outcome.order.clientId
          : outcome.action === 'reject'
            ? outcome.order?.clientId
            : undefined,
      order:
        outcome.action === 'order'
          ? { ...outcome.order }
          : outcome.action === 'reject' && outcome.order
            ? { ...outcome.order }
            : undefined,
      fill: outcome.action === 'order' ? outcome.fill : undefined,
      error:
        outcome.action === 'reject'
          ? outcome.error
          : outcome.action === 'order'
            ? outcome.positionError
            : undefined,
      ...(this.securityFeeds ? { securityFeeds: this.securityFeeds.describe() } : {}),
      recordedAt: new Date().toISOString(),
    };
  }

  private securityHealthRecord(
    key: string,
    error: string,
    feeds: readonly SecurityFeedHealth[],
  ): SecurityFeedHealthRecord {
    return {
      schemaVersion: 2,
      recordType: 'security',
      runId: this.runId,
      strategyId: this.strategyId,
      key,
      error,
      feeds: feeds.map((feed) => ({ ...feed })),
      recordedAt: new Date().toISOString(),
    };
  }

  private ensureActive(): void {
    if (this.abort.signal.aborted) throw new ForwardRunnerError('forward runner aborted');
  }
}
