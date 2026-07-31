import {
  ArrayFeed,
  CompileError,
  Engine,
  compile,
  type CompiledScript,
  type EngineOptions,
} from '@heyphat/piner';
import {
  canonicalTimeframeToPineExact,
  liveTimeframeSeconds,
  parseCanonicalTimeframeExact,
  resolveHistorySource,
  snapshotLiveSourcePolicy,
  supportsLiveBars,
  validateBarsExact,
  type Bar,
  type LiveBarsProvider,
  type LiveSourcePolicy,
  type MarketDataProvider,
  type ResolvedDataInstrument,
  type ResolvedHistorySource,
} from '@heyphat/pinery';
import {
  assertResolvedSecurityForBarMagnifier,
  jobHash,
  preparePinerEngineForRun,
  preflightBarMagnifier,
  projectAuthoritativeBarMagnifierReport,
  resolveBarMagnifier,
  type Job,
  type MagnifierPreflight,
  type PinerEnginePreparation,
  type PreparedMagnifierBinding,
  type ResolvedSecurityDatasetProof,
} from '@heyphat/pinerun';
import {
  canonicalSha256,
  createPreparedAuthorityEnvelope,
  deepFreeze,
  type IntrabarBrokerClass,
  type PreparedIntrabarAuthority,
  type PreparedIntrabarAuthorityEnvelope,
  type PreparedSecurityAuthority,
} from './intrabar-authority.js';
import {
  IntrabarState,
  type AcceptedIntrabarUpdate,
  type IntrabarEvaluationReason,
  type IntrabarUpdateIdentity,
} from './intrabar-state.js';
import { toPinerBar } from './time.js';

export type IntrabarBackend = 'js' | 'interp';

export type IntrabarHistoricalConfig =
  | {
      readonly mode: 'standard';
    }
  | {
      readonly mode: 'bar-magnifier';
      readonly maxMagnifierTargetBars?: number;
      readonly maxMagnifierRawBars?: number;
    };

export type IntrabarLiveConfig =
  | {
      readonly cadence: 'bar-close';
    }
  | {
      readonly cadence: 'every-update';
      readonly source: LiveSourcePolicy;
      readonly throttleMs?: number;
      readonly maxPendingFinals?: number;
      readonly reconnectAttempts?: number;
      readonly reconnectDelayMs?: number;
      readonly reconnectMaxDelayMs?: number;
      /** Compute the first observed live chart time, but inhibit execution through its final. */
      readonly startupDiscontinuity?: boolean;
    };

export type IntrabarSecurityConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly maxExactSecurityFeeds: number;
      readonly maxExactSecurityBarsPerFeed: number;
      readonly maxExactSecurityTotalBars: number;
      readonly concurrency: number;
      readonly requestTimeoutMs: number;
      readonly maxStaleRefreshes: number;
    };

export interface IntrabarRunnerOptions {
  readonly source: string;
  readonly symbol: string;
  /** Strict canonical Pinery timeframe, for example `1m` or `1h`. */
  readonly timeframe: string;
  readonly warmupBars?: number;
  /** Original normalized value when an effective minimum warmup is applied. */
  readonly configuredWarmupBars?: number;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly backend?: IntrabarBackend;
  readonly historical?: IntrabarHistoricalConfig;
  readonly live?: IntrabarLiveConfig;
  readonly security?: IntrabarSecurityConfig;
  readonly strategyIdentity?: string;
  readonly configuredBrokerClass?: IntrabarBrokerClass;
  /** Purely compiled source/preflight supplied by the v2 entry gate. Both must be supplied together. */
  readonly compiled?: CompiledScript;
  readonly preflight?: MagnifierPreflight;
  readonly onBinding?: (binding: IntrabarHistoricalBinding) => void | Promise<void>;
  readonly onEvaluation?: (evaluation: IntrabarEvaluation) => void | Promise<void>;
}

export interface IntrabarChartBinding {
  readonly requestedSymbol: string;
  readonly strategySymbol: string;
  readonly providerId: string;
  readonly providerHandle: string;
  readonly venueSymbol: string;
  readonly exchange?: string;
  readonly expiry?: string;
  readonly mintick: number;
  readonly qtyStep: number;
  readonly minOrderQty: number;
  readonly pointValue?: number;
  readonly canonicalTimeframe: string;
  readonly pinerTimeframe: string;
  readonly backend: IntrabarBackend;
  readonly historicalBars: number;
  /** Provider/session fixed-grid phase established by the first historical open. */
  readonly anchorTime: number;
  readonly firstChartOpen: number;
  readonly finalChartOpen: number;
  readonly chartEnvelope: {
    /** Inclusive UNIX-second chart-history start. */
    readonly from: number;
    /** Exclusive UNIX-second final chart close. */
    readonly to: number;
  };
}

export interface IntrabarExactSourceBinding {
  readonly providerId: string;
  readonly requestedSymbol: string;
  readonly normalizedSymbol: string;
  readonly cacheIdentity: string;
}

export interface IntrabarExactAcquisitionBinding {
  readonly acquisitionKey: string;
  readonly barsDigest: string;
  readonly targetPineTimeframe: string;
  readonly targetCanonicalTimeframe: string;
  readonly sourceCanonicalTimeframe: string;
  readonly targetBarCount: number;
  readonly rawBarCount: number;
  readonly coverage: PreparedMagnifierBinding['coverage'];
  readonly maxMagnifierTargetBars?: number;
  readonly maxMagnifierRawBars?: number;
}

export type IntrabarPreparedHistoricalBinding =
  | {
      readonly mode: 'standard';
    }
  | {
      readonly mode: 'bar-magnifier';
      readonly exactSource: IntrabarExactSourceBinding;
      readonly acquisition: IntrabarExactAcquisitionBinding;
    };

export interface IntrabarCutoverBinding {
  /** Final historical chart open, used as an exclusive live `after` cursor. */
  readonly after: number;
  readonly finalHistoricalClose: number;
  readonly firstAdmissibleLiveOpen: number;
}

/** Frozen facts authorizing the finite history and its exclusive live cutover. */
export interface IntrabarHistoricalBinding {
  /** Strong pinerun identity over source, inputs, warmup, options, and exact datasets. */
  readonly runIdentity: string;
  readonly sourceIdentity: string;
  /** Canonical SHA-256 over every prepared fact used to authorize restart. */
  readonly authority: PreparedIntrabarAuthorityEnvelope;
  readonly chart: IntrabarChartBinding;
  readonly historical: IntrabarPreparedHistoricalBinding;
  readonly cutover: IntrabarCutoverBinding;
  readonly live:
    | { readonly cadence: 'bar-close' }
    | {
        readonly cadence: 'every-update';
        readonly source: LiveSourcePolicy;
        readonly throttleMs: number;
        readonly maxPendingFinals: number;
        readonly reconnectAttempts: number;
        readonly reconnectDelayMs: number;
        readonly reconnectMaxDelayMs: number;
      };
}

export interface IntrabarEvaluation {
  readonly decisionId: string;
  readonly sequence: number;
  readonly update: IntrabarUpdateIdentity;
  readonly bar: Readonly<Bar>;
  readonly target: number;
  readonly executable: boolean;
  readonly reason: IntrabarEvaluationReason;
  /** True exactly once for each accepted chart time. */
  readonly finalCommit: boolean;
}

interface NormalizedOptions {
  readonly source: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly pinerTimeframe: string;
  readonly timeframeSeconds: number;
  readonly configuredWarmupBars: number;
  readonly warmupBars: number;
  readonly inputs?: Record<string, unknown>;
  readonly backend: IntrabarBackend;
  readonly historical: IntrabarHistoricalConfig;
  readonly live: IntrabarLiveConfig;
  readonly security: IntrabarSecurityConfig;
  readonly strategyIdentity: string;
  readonly configuredBrokerClass: IntrabarBrokerClass;
  readonly compiled: CompiledScript;
  readonly preflight: MagnifierPreflight;
}

export class IntrabarRunnerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IntrabarRunnerError';
  }
}

/** Broker-free finite-history plus live chart evaluation runtime. */
export class IntrabarRunner {
  private normalized?: NormalizedOptions;
  private resolved?: ResolvedDataInstrument;
  private engine?: Engine;
  private state?: IntrabarState;
  private runBinding?: IntrabarHistoricalBinding;
  private liveProvider?: LiveBarsProvider;
  private readonly abort = new AbortController();
  private initialized = false;
  private running = false;
  private sequence = 0;
  private resumeAfter?: number;
  private startupDiscontinuity = false;

  constructor(
    private readonly data: MarketDataProvider,
    private readonly options: IntrabarRunnerOptions,
  ) {}

  get binding(): IntrabarHistoricalBinding | undefined {
    return this.runBinding;
  }

  /** Exact resolved contract reused by v2 execution binding; no second resolution is allowed. */
  get resolvedInstrument(): ResolvedDataInstrument | undefined {
    return this.resolved;
  }

  get finalizedCursor(): number | undefined {
    return this.state?.finalizedCursor;
  }

  /** Apply durable finality only after authority recovery succeeds and before subscription. */
  configureRecovery(options: {
    readonly lastFinalCursor?: number;
    readonly startupDiscontinuity?: boolean;
  }): void {
    if (!this.initialized || !this.normalized || !this.runBinding)
      throw new IntrabarRunnerError('intrabar runner must be initialized before recovery');
    if (this.running) throw new IntrabarRunnerError('cannot configure recovery while running');
    const cursor = options.lastFinalCursor;
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) {
      throw new IntrabarRunnerError('recovered final cursor must be a non-negative safe second');
    }
    this.resumeAfter = Math.max(this.runBinding.cutover.after, cursor ?? 0);
    this.startupDiscontinuity = options.startupDiscontinuity === true;
    this.state = this.createState(this.normalized, this.runBinding);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.ensureActive();

    // This complete gate is intentionally before resolve/history/exact acquisition.
    const normalized = this.validateNoIo();
    this.ensureActive();

    const resolved = await this.data.resolve(normalized.symbol, {
      strict: true,
      signal: this.abort.signal,
    });
    this.ensureActive();
    if (resolved.strategySymbol !== normalized.symbol) {
      throw new IntrabarRunnerError(
        'resolved chart strategy symbol does not match the requested symbol',
      );
    }

    const history = await this.data.historyResolved(
      resolved,
      normalized.timeframe,
      { limit: normalized.warmupBars },
      this.abort.signal,
    );
    this.ensureActive();
    this.validateHistory(history, normalized.warmupBars, normalized.timeframeSeconds);
    const chartBars = history.map((bar) => ({ ...bar }));

    let exactSource: ResolvedHistorySource | undefined;
    if (normalized.historical.mode === 'bar-magnifier') {
      exactSource = await resolveHistorySource(this.data, resolved.venueSymbol);
      this.ensureActive();
      this.assertExactSourceIdentity(resolved, exactSource);
    }

    const job: Job = {
      source: normalized.source,
      symbol: resolved.strategySymbol,
      timeframe: normalized.pinerTimeframe,
      bars: chartBars,
      ...(normalized.inputs ? { inputs: { ...normalized.inputs } } : {}),
      mintick: resolved.mintick,
      minQty: resolved.qtyStep,
      useBarMagnifier: normalized.historical.mode === 'bar-magnifier',
      backend: normalized.backend,
    };
    const budgets = magnifierBudgets(normalized.historical);
    await resolveBarMagnifier(
      job,
      normalized.timeframe,
      this.data,
      exactSource
        ? {
            ...budgets,
            resolvedSource: exactSource,
            resolvedSourceSymbol: resolved.strategySymbol,
            securityConcurrency: normalized.security.enabled ? normalized.security.concurrency : 1,
          }
        : budgets,
    );
    this.ensureActive();
    if (normalized.historical.mode === 'bar-magnifier') {
      // Authenticate resolver-issued bars/proofs before Engine construction or mutation.
      assertResolvedSecurityForBarMagnifier(
        normalized.source,
        normalized.preflight.securityDependencies,
        job,
      );
    }
    // Exact security host limits are enforced before Engine construction/mutation and broker creation.
    const securityAuthority = this.assertExactSecurityBudgets(job, normalized.security);
    const runIdentity = jobHash(job);
    const chartBarsDigest = await canonicalSha256(chartBars);

    const strategyOverride = {
      minQty: resolved.qtyStep,
      useBarMagnifier: normalized.historical.mode === 'bar-magnifier',
    } as EngineOptions['strategy'];
    const engine = new Engine(normalized.compiled, new ArrayFeed(chartBars.map(toPinerBar)), {
      backend: normalized.backend,
      inputs: normalized.inputs,
      strategy: strategyOverride,
    });
    const preparation = preparePinerEngineForRun(engine, job, budgets);
    await engine.run({
      symbol: resolved.strategySymbol,
      timeframe: normalized.pinerTimeframe,
      mintick: resolved.mintick,
    });
    this.ensureActive();
    this.assertMagnifierActive(engine, preparation);

    const binding = await this.createBinding(
      normalized,
      resolved,
      chartBars,
      preparation,
      exactSource,
      runIdentity,
      chartBarsDigest,
      securityAuthority,
    );
    this.resumeAfter = binding.cutover.after;
    this.startupDiscontinuity =
      normalized.live.cadence === 'every-update' && normalized.live.startupDiscontinuity === true;
    const state = this.createState(normalized, binding);

    await this.options.onBinding?.(binding);
    this.normalized = normalized;
    this.resolved = resolved;
    this.engine = engine;
    this.state = state;
    this.runBinding = binding;
    this.initialized = true;
  }

  /** @deprecated Prefer initialize(); retained for existing core callers. */
  async init(): Promise<void> {
    await this.initialize();
  }

  async start(): Promise<void> {
    if (this.running) throw new IntrabarRunnerError('intrabar runner is already running');
    this.running = true;
    try {
      await this.initialize();
      const normalized = this.normalized!;
      if (normalized.live.cadence === 'every-update') {
        const provider = this.liveProvider!;
        for await (const update of provider.liveBars(this.resolved!, normalized.timeframe, {
          after: this.resumeAfter ?? this.runBinding!.cutover.after,
          signal: this.abort.signal,
          source: normalized.live.source,
          throttleMs:
            this.options.live?.cadence === 'every-update'
              ? this.options.live.throttleMs
              : undefined,
          maxPendingFinals:
            this.options.live?.cadence === 'every-update'
              ? this.options.live.maxPendingFinals
              : undefined,
          reconnectAttempts:
            this.options.live?.cadence === 'every-update'
              ? this.options.live.reconnectAttempts
              : undefined,
          reconnectDelayMs:
            this.options.live?.cadence === 'every-update'
              ? this.options.live.reconnectDelayMs
              : undefined,
          reconnectMaxDelayMs:
            this.options.live?.cadence === 'every-update'
              ? this.options.live.reconnectMaxDelayMs
              : undefined,
        })) {
          if (this.abort.signal.aborted) break;
          const accepted = this.state!.acceptUpdate(update);
          if (accepted) await this.evaluate(accepted);
          this.ensureActive();
        }
        return;
      }

      for await (const bar of this.data.closedBars(this.resolved!, normalized.timeframe, {
        after: this.resumeAfter ?? this.runBinding!.cutover.after,
        signal: this.abort.signal,
      })) {
        if (this.abort.signal.aborted) break;
        const accepted = this.state!.acceptClosedBar(bar);
        await this.evaluate(accepted);
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
    await this.data.disconnect?.();
  }

  private validateNoIo(): NormalizedOptions {
    assertKnownKeys(
      this.options as unknown as Record<string, unknown>,
      [
        'source',
        'symbol',
        'timeframe',
        'warmupBars',
        'configuredWarmupBars',
        'inputs',
        'backend',
        'historical',
        'live',
        'security',
        'strategyIdentity',
        'configuredBrokerClass',
        'compiled',
        'preflight',
        'onBinding',
        'onEvaluation',
      ],
      'runner options',
    );
    const source = requiredText(this.options.source, 'source');
    const symbol = requiredText(this.options.symbol, 'symbol');
    const timeframe = requiredText(this.options.timeframe, 'timeframe');
    const parsedTimeframe = parseCanonicalTimeframeExact(timeframe);
    if (parsedTimeframe.kind !== 'ok' || parsedTimeframe.value.domain !== 'fixed') {
      throw new IntrabarRunnerError(
        parsedTimeframe.kind === 'ok'
          ? `live chart timeframe ${JSON.stringify(timeframe)} must have a fixed duration`
          : parsedTimeframe.message,
      );
    }
    const pinerTimeframe = canonicalTimeframeToPineExact(parsedTimeframe.value.canonical);
    if (pinerTimeframe.kind !== 'ok') throw new IntrabarRunnerError(pinerTimeframe.message);

    const configuredWarmupBars =
      this.options.configuredWarmupBars ?? this.options.warmupBars ?? 200;
    nonnegativeSafeInteger(configuredWarmupBars, 'configuredWarmupBars');
    const warmupBars = this.options.warmupBars ?? Math.max(1, configuredWarmupBars);
    positiveSafeInteger(warmupBars, 'warmupBars');
    const backend = this.options.backend ?? 'js';
    if (backend !== 'js' && backend !== 'interp') {
      throw new IntrabarRunnerError('backend must be "js" or "interp"');
    }
    const historical = normalizeHistorical(this.options.historical);
    const live = normalizeLive(this.options.live, parsedTimeframe.value.seconds);
    const security = normalizeSecurity(this.options.security);
    const strategyIdentity = this.options.strategyIdentity ?? 'inline-source';
    requiredText(strategyIdentity, 'strategyIdentity');
    const configuredBrokerClass = this.options.configuredBrokerClass ?? 'compute-only';
    if (
      configuredBrokerClass !== 'compute-only' &&
      configuredBrokerClass !== 'paper' &&
      configuredBrokerClass !== 'tiger'
    ) {
      throw new IntrabarRunnerError(
        'configuredBrokerClass must be "compute-only", "paper", or "tiger"',
      );
    }
    if (this.options.inputs !== undefined && !isPlainRecord(this.options.inputs)) {
      throw new IntrabarRunnerError('inputs must be a plain object when supplied');
    }
    if (this.options.onBinding !== undefined && typeof this.options.onBinding !== 'function') {
      throw new IntrabarRunnerError('onBinding must be a function when supplied');
    }
    if (
      this.options.onEvaluation !== undefined &&
      typeof this.options.onEvaluation !== 'function'
    ) {
      throw new IntrabarRunnerError('onEvaluation must be a function when supplied');
    }

    if ((this.options.compiled === undefined) !== (this.options.preflight === undefined)) {
      throw new IntrabarRunnerError('compiled and preflight must be supplied together');
    }
    let compiled: CompiledScript;
    try {
      compiled = this.options.compiled ?? compile(source);
    } catch (error) {
      throw new IntrabarRunnerError(
        error instanceof CompileError ? error.message : 'Pine compilation failed',
        { cause: error },
      );
    }
    const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    if (errors.length > 0) {
      throw new IntrabarRunnerError(
        `Pine compilation failed: ${errors.map((error) => error.message).join('; ')}`,
      );
    }
    if (!compiled.metadata.isStrategy) {
      throw new IntrabarRunnerError('Pine source must declare a strategy(), not an indicator()');
    }

    const securityDependencies = compiled.metadata.securityDependencies;
    if (!Array.isArray(securityDependencies)) {
      throw new IntrabarRunnerError(
        'broker-free live cadence requires complete compiler security dependency metadata',
      );
    }
    if (securityDependencies.length > 0) {
      if (live.cadence === 'every-update') {
        throw new IntrabarRunnerError(
          'every-update cadence does not support request.security or request.security_lower_tf dependencies',
        );
      }
      if (!security.enabled) {
        throw new IntrabarRunnerError(
          'bar-close security dependencies require exact security to be enabled',
        );
      }
      if (historical.mode !== 'bar-magnifier') {
        throw new IntrabarRunnerError(
          'exact bar-close security requires active Bar Magnifier preparation',
        );
      }
    }
    if (security.enabled && historical.mode !== 'bar-magnifier') {
      throw new IntrabarRunnerError(
        'exact bar-close security requires active Bar Magnifier preparation',
      );
    }
    if (live.cadence === 'every-update') {
      const strategy = compiled.metadata.strategy as Record<string, unknown> | undefined;
      if (strategy?.calcOnEveryTick !== true) {
        throw new IntrabarRunnerError(
          'every-update cadence requires strategy(calc_on_every_tick=true)',
        );
      }
    }

    const preflight =
      this.options.preflight ??
      preflightBarMagnifier(source, pinerTimeframe.value, historical.mode === 'bar-magnifier');
    const strategy = compiled.metadata.strategy as Record<string, unknown> | undefined;
    if (preflight.requested && strategy?.calcOnOrderFills === true) {
      throw new IntrabarRunnerError(
        'active Bar Magnifier with calc_on_order_fills is unsupported by the characterized piner runtime',
      );
    }

    if (live.cadence === 'every-update') {
      if (!supportsLiveBars(this.data)) {
        throw new IntrabarRunnerError(
          'every-update cadence requires a provider with authoritative liveBars support',
        );
      }
      this.liveProvider = this.data;
    }

    return Object.freeze({
      source,
      symbol,
      timeframe: parsedTimeframe.value.canonical,
      pinerTimeframe: pinerTimeframe.value,
      timeframeSeconds: parsedTimeframe.value.seconds,
      configuredWarmupBars,
      warmupBars,
      ...(this.options.inputs ? { inputs: { ...this.options.inputs } } : {}),
      backend,
      historical,
      live,
      security,
      strategyIdentity,
      configuredBrokerClass,
      compiled,
      preflight,
    });
  }

  private validateHistory(
    history: readonly Bar[],
    requested: number,
    durationSeconds: number,
  ): void {
    if (history.length < requested) {
      throw new IntrabarRunnerError(
        `primary warmup returned ${history.length} bars but ${requested} were requested`,
      );
    }
    try {
      validateBarsExact(history);
    } catch (error) {
      throw new IntrabarRunnerError(
        error instanceof Error ? error.message : 'primary warmup history is malformed',
        { cause: error },
      );
    }
    if (history.some((bar) => bar.time >= 1e12)) {
      throw new IntrabarRunnerError('primary warmup must use whole UNIX-second chart opens');
    }
    const anchorTime = history[0]!.time;
    if (history.some((bar) => (bar.time - anchorTime) % durationSeconds !== 0)) {
      throw new IntrabarRunnerError(
        'primary warmup bars do not share one authoritative chart-grid phase',
      );
    }
  }

  private assertExactSourceIdentity(
    resolved: ResolvedDataInstrument,
    exactSource: ResolvedHistorySource,
  ): void {
    if (exactSource.normalizedSymbol !== resolved.venueSymbol) {
      throw new IntrabarRunnerError(
        'resolved exact-history source symbol does not match the resolved venue instrument',
      );
    }
  }

  private assertMagnifierActive(engine: Engine, preparation: PinerEnginePreparation): void {
    if (!preparation.preflight.requested) return;
    const report = projectAuthoritativeBarMagnifierReport(engine.strategy, true);
    if (!report?.active) {
      throw new IntrabarRunnerError(
        'piner did not activate the requested exact Bar Magnifier historical dataset',
      );
    }
  }

  private async createBinding(
    normalized: NormalizedOptions,
    resolved: ResolvedDataInstrument,
    chartBars: readonly Bar[],
    preparation: PinerEnginePreparation,
    exactSource: ResolvedHistorySource | undefined,
    runIdentity: string,
    chartBarsDigest: string,
    securityAuthority: readonly PreparedSecurityAuthority[],
  ): Promise<IntrabarHistoricalBinding> {
    const first = chartBars[0]!;
    const final = chartBars.at(-1)!;
    const prepared = preparation.magnifier;
    let finalClose = final.time + normalized.timeframeSeconds;
    if (prepared) {
      const closeMs = prepared.chartCloseTimesMs.at(-1);
      if (!Number.isSafeInteger(closeMs) || closeMs! % 1_000 !== 0) {
        throw new IntrabarRunnerError('prepared Bar Magnifier final close is not a whole second');
      }
      finalClose = closeMs! / 1_000;
    }
    if (!Number.isSafeInteger(finalClose) || finalClose <= final.time) {
      throw new IntrabarRunnerError('historical final close is invalid');
    }

    let historical: IntrabarPreparedHistoricalBinding;
    if (normalized.historical.mode === 'bar-magnifier') {
      if (!prepared || !exactSource) {
        throw new IntrabarRunnerError('requested Bar Magnifier binding is unavailable');
      }
      historical = {
        mode: 'bar-magnifier',
        exactSource: {
          providerId: exactSource.provider.id,
          requestedSymbol: prepared.sourceIdentity.requestedSymbol,
          normalizedSymbol: prepared.sourceIdentity.normalizedSymbol,
          cacheIdentity: prepared.sourceIdentity.cacheIdentity,
        },
        acquisition: {
          acquisitionKey: prepared.acquisitionKey,
          barsDigest: prepared.barsDigest,
          targetPineTimeframe: prepared.targetPineTf,
          targetCanonicalTimeframe: prepared.targetCanonicalTf,
          sourceCanonicalTimeframe: prepared.sourceCanonicalTf,
          targetBarCount: prepared.targetBarCount,
          rawBarCount: prepared.rawBarCount,
          coverage: prepared.coverage,
          maxMagnifierTargetBars: normalized.historical.maxMagnifierTargetBars,
          maxMagnifierRawBars: normalized.historical.maxMagnifierRawBars,
        },
      };
    } else {
      historical = { mode: 'standard' };
    }

    const chart: IntrabarChartBinding = {
      requestedSymbol: normalized.symbol,
      strategySymbol: resolved.strategySymbol,
      providerId: this.data.id,
      providerHandle: resolved.providerHandle,
      venueSymbol: resolved.venueSymbol,
      ...(resolved.exchange ? { exchange: resolved.exchange } : {}),
      ...(resolved.expiry ? { expiry: resolved.expiry } : {}),
      mintick: resolved.mintick,
      qtyStep: resolved.qtyStep,
      minOrderQty: resolved.minOrderQty,
      ...(resolved.pointValue !== undefined ? { pointValue: resolved.pointValue } : {}),
      canonicalTimeframe: normalized.timeframe,
      pinerTimeframe: normalized.pinerTimeframe,
      backend: normalized.backend,
      historicalBars: chartBars.length,
      anchorTime: first.time,
      firstChartOpen: first.time,
      finalChartOpen: final.time,
      chartEnvelope: { from: first.time, to: finalClose },
    };
    const cutover: IntrabarCutoverBinding = {
      after: final.time,
      finalHistoricalClose: finalClose,
      firstAdmissibleLiveOpen: finalClose,
    };
    const live: IntrabarHistoricalBinding['live'] =
      normalized.live.cadence === 'every-update'
        ? {
            cadence: 'every-update',
            source: normalized.live.source,
            throttleMs: normalized.live.throttleMs!,
            maxPendingFinals: normalized.live.maxPendingFinals!,
            reconnectAttempts: normalized.live.reconnectAttempts!,
            reconnectDelayMs: normalized.live.reconnectDelayMs!,
            reconnectMaxDelayMs: normalized.live.reconnectMaxDelayMs!,
          }
        : { cadence: 'bar-close' };
    const securityBarsPerFeed = Object.fromEntries(
      securityAuthority.map((item) => [item.key, item.barCount]),
    );
    const securityTotalBars = securityAuthority.reduce((sum, item) => sum + item.barCount, 0);
    const historicalAuthority: PreparedIntrabarAuthority['historical'] =
      historical.mode === 'standard'
        ? { mode: 'standard' }
        : {
            mode: 'bar-magnifier',
            exactSource: historical.exactSource,
            acquisition: {
              acquisitionKey: historical.acquisition.acquisitionKey,
              barsDigest: historical.acquisition.barsDigest,
              targetPineTimeframe: historical.acquisition.targetPineTimeframe,
              targetCanonicalTimeframe: historical.acquisition.targetCanonicalTimeframe,
              sourceCanonicalTimeframe: historical.acquisition.sourceCanonicalTimeframe,
              targetBarCount: historical.acquisition.targetBarCount,
              rawBarCount: historical.acquisition.rawBarCount,
              coverage: historical.acquisition.coverage,
            },
          };
    const preparedAuthority: PreparedIntrabarAuthority = {
      authorityVersion: 1,
      source: {
        strategyIdentity: normalized.strategyIdentity,
        sourceIdentity: preparation.preflight.sourceIdentity,
        jobIdentity: runIdentity,
        chartBarsDigest,
      },
      provider: {
        id: this.data.id,
        handle: resolved.providerHandle,
        requestedSymbol: normalized.symbol,
        strategySymbol: resolved.strategySymbol,
        venueSymbol: resolved.venueSymbol,
        exchange: resolved.exchange ?? null,
        expiry: resolved.expiry ?? null,
        mintick: resolved.mintick,
        qtyStep: resolved.qtyStep,
        minOrderQty: resolved.minOrderQty,
        pointValue: resolved.pointValue ?? null,
      },
      chart: {
        canonicalTimeframe: normalized.timeframe,
        pinerTimeframe: normalized.pinerTimeframe,
        backend: normalized.backend,
        configuredWarmupBars: normalized.configuredWarmupBars,
        effectiveWarmupBars: normalized.warmupBars,
        observedHistoricalBars: chartBars.length,
        anchorTime: first.time,
        firstOpen: first.time,
        finalOpen: final.time,
        envelope: { from: first.time, to: finalClose },
      },
      historical: historicalAuthority,
      security: securityAuthority,
      cutover,
      live,
      budgets: {
        magnifier: {
          configured: {
            maxTargetBars:
              normalized.historical.mode === 'bar-magnifier'
                ? (normalized.historical.maxMagnifierTargetBars ?? null)
                : null,
            maxRawBars:
              normalized.historical.mode === 'bar-magnifier'
                ? (normalized.historical.maxMagnifierRawBars ?? null)
                : null,
          },
          effective: {
            maxTargetBars:
              normalized.historical.mode === 'bar-magnifier'
                ? (normalized.historical.maxMagnifierTargetBars ?? null)
                : null,
            maxRawBars:
              normalized.historical.mode === 'bar-magnifier'
                ? (normalized.historical.maxMagnifierRawBars ?? null)
                : null,
          },
          observed: {
            targetBars: prepared?.targetBarCount ?? 0,
            rawBars: prepared?.rawBarCount ?? 0,
          },
        },
        security: {
          configured: {
            maxFeeds: normalized.security.enabled
              ? normalized.security.maxExactSecurityFeeds
              : null,
            maxBarsPerFeed: normalized.security.enabled
              ? normalized.security.maxExactSecurityBarsPerFeed
              : null,
            maxTotalBars: normalized.security.enabled
              ? normalized.security.maxExactSecurityTotalBars
              : null,
            concurrency: normalized.security.enabled ? normalized.security.concurrency : null,
            requestTimeoutMs: normalized.security.enabled
              ? normalized.security.requestTimeoutMs
              : null,
            maxStaleRefreshes: normalized.security.enabled
              ? normalized.security.maxStaleRefreshes
              : null,
          },
          effective: {
            maxFeeds: normalized.security.enabled
              ? normalized.security.maxExactSecurityFeeds
              : null,
            maxBarsPerFeed: normalized.security.enabled
              ? normalized.security.maxExactSecurityBarsPerFeed
              : null,
            maxTotalBars: normalized.security.enabled
              ? normalized.security.maxExactSecurityTotalBars
              : null,
          },
          observed: {
            feeds: securityAuthority.length,
            totalBars: securityTotalBars,
            maxBarsPerFeed: Math.max(0, ...securityAuthority.map((item) => item.barCount)),
            barsPerFeed: securityBarsPerFeed,
          },
        },
      },
      cadence: normalized.live.cadence,
      configuredBrokerClass: normalized.configuredBrokerClass,
    };
    const authority = await createPreparedAuthorityEnvelope(preparedAuthority);

    return deepFreeze({
      runIdentity,
      sourceIdentity: preparation.preflight.sourceIdentity,
      authority,
      chart,
      historical,
      cutover,
      live,
    });
  }

  private createState(
    normalized: NormalizedOptions,
    binding: IntrabarHistoricalBinding,
  ): IntrabarState {
    return new IntrabarState({
      timeframe: normalized.timeframe,
      cutoverCursor: binding.cutover.after,
      finalizedCursor: this.resumeAfter,
      firstAdmissibleLiveOpen: binding.cutover.firstAdmissibleLiveOpen,
      anchorTime: binding.chart.anchorTime,
      ...(normalized.live.cadence === 'every-update'
        ? {
            source: normalized.live.source,
            startupDiscontinuity: this.startupDiscontinuity,
          }
        : {}),
    });
  }

  private assertExactSecurityBudgets(
    job: Job,
    security: IntrabarSecurityConfig,
  ): readonly PreparedSecurityAuthority[] {
    const bars = job.securityBars ?? {};
    const proofs = job.securityProofs ?? {};
    const keys = Object.keys(bars).sort();
    if (!security.enabled) {
      if (keys.length > 0 || Object.keys(proofs).length > 0) {
        throw new IntrabarRunnerError(
          'exact security data was resolved while security is disabled',
        );
      }
      return Object.freeze([]);
    }
    if (keys.length > security.maxExactSecurityFeeds) {
      throw new IntrabarRunnerError('exact security feed budget was exceeded');
    }
    let total = 0;
    const authority: PreparedSecurityAuthority[] = [];
    for (const key of keys) {
      const feed = bars[key]!;
      const proof = proofs[key] as ResolvedSecurityDatasetProof | undefined;
      if (!proof) throw new IntrabarRunnerError(`exact security proof is missing for ${key}`);
      if (feed.length > security.maxExactSecurityBarsPerFeed) {
        throw new IntrabarRunnerError(`exact security per-feed bar budget was exceeded for ${key}`);
      }
      total += feed.length;
      if (total > security.maxExactSecurityTotalBars) {
        throw new IntrabarRunnerError('exact security total bar budget was exceeded');
      }
      if (proof.complete !== true || proof.gaps.length !== 0) {
        throw new IntrabarRunnerError(`exact security coverage is incomplete for ${key}`);
      }
      authority.push(
        deepFreeze({
          key,
          barCount: feed.length,
          requestKind: proof.requestKind,
          requestedSymbol: proof.requestedSymbol,
          dependencies: proof.dependencies,
          requestedCanonicalTfs: proof.requestedCanonicalTfs,
          lookaheadOnCanonicalTfs: proof.lookaheadOnCanonicalTfs,
          targetCanonicalTf: proof.targetCanonicalTf,
          requested: proof.requested,
          covered: proof.covered,
          gaps: proof.gaps,
          complete: true as const,
          provenance: proof.provenance,
          alignmentEvidence: proof.alignmentEvidence,
          barsDigest: proof.barsDigest,
          acquisitionKey: proof.acquisitionKey,
        }),
      );
    }
    const orphan = Object.keys(proofs).find((key) => !(key in bars));
    if (orphan) throw new IntrabarRunnerError(`exact security proof has no bars for ${orphan}`);
    return Object.freeze(authority);
  }

  private async evaluate(accepted: AcceptedIntrabarUpdate): Promise<void> {
    this.engine!.tick(toPinerBar(accepted.bar as Bar), accepted.finalCommit);
    const target = this.engine!.ctx.strategy.position_size;
    if (!Number.isFinite(target)) {
      throw new IntrabarRunnerError('piner produced a non-finite strategy position target');
    }
    const sequence = this.sequence++;
    const evaluation = deepFreeze({
      decisionId: decisionId(this.runBinding!, accepted.identity),
      sequence,
      update: accepted.identity,
      bar: accepted.bar,
      target: Object.is(target, -0) ? 0 : target,
      executable: accepted.executable,
      reason: accepted.reason,
      finalCommit: accepted.finalCommit,
    });
    await this.options.onEvaluation?.(evaluation);
  }

  private ensureActive(): void {
    if (this.abort.signal.aborted) throw new IntrabarRunnerError('intrabar runner was cancelled');
  }
}

function normalizeHistorical(
  value: IntrabarHistoricalConfig | undefined,
): IntrabarHistoricalConfig {
  const historical = value ?? { mode: 'standard' as const };
  if (!historical || typeof historical !== 'object') {
    throw new IntrabarRunnerError('historical configuration is required');
  }
  if (historical.mode === 'standard') {
    assertKnownKeys(historical as unknown as Record<string, unknown>, ['mode'], 'historical');
    return Object.freeze({ mode: 'standard' });
  }
  if (historical.mode !== 'bar-magnifier') {
    throw new IntrabarRunnerError('historical.mode must be "standard" or "bar-magnifier"');
  }
  assertKnownKeys(
    historical as unknown as Record<string, unknown>,
    ['mode', 'maxMagnifierTargetBars', 'maxMagnifierRawBars'],
    'historical',
  );
  optionalPositiveSafeInteger(historical.maxMagnifierTargetBars, 'maxMagnifierTargetBars');
  optionalPositiveSafeInteger(historical.maxMagnifierRawBars, 'maxMagnifierRawBars');
  return Object.freeze({ ...historical });
}

function normalizeSecurity(value: IntrabarSecurityConfig | undefined): IntrabarSecurityConfig {
  const security = value ?? { enabled: false as const };
  if (!security || typeof security !== 'object') {
    throw new IntrabarRunnerError('security configuration is required');
  }
  if (!security.enabled) {
    assertKnownKeys(security as unknown as Record<string, unknown>, ['enabled'], 'security');
    return Object.freeze({ enabled: false });
  }
  assertKnownKeys(
    security as unknown as Record<string, unknown>,
    [
      'enabled',
      'maxExactSecurityFeeds',
      'maxExactSecurityBarsPerFeed',
      'maxExactSecurityTotalBars',
      'concurrency',
      'requestTimeoutMs',
      'maxStaleRefreshes',
    ],
    'security',
  );
  positiveSafeInteger(security.maxExactSecurityFeeds, 'maxExactSecurityFeeds');
  positiveSafeInteger(security.maxExactSecurityBarsPerFeed, 'maxExactSecurityBarsPerFeed');
  positiveSafeInteger(security.maxExactSecurityTotalBars, 'maxExactSecurityTotalBars');
  positiveSafeInteger(security.concurrency, 'security concurrency');
  positiveSafeInteger(security.requestTimeoutMs, 'security requestTimeoutMs');
  nonnegativeSafeInteger(security.maxStaleRefreshes, 'security maxStaleRefreshes');
  if (security.maxExactSecurityBarsPerFeed > security.maxExactSecurityTotalBars) {
    throw new IntrabarRunnerError('per-feed security budget exceeds total security budget');
  }
  if (security.concurrency > security.maxExactSecurityFeeds) {
    throw new IntrabarRunnerError('security concurrency exceeds the feed budget');
  }
  return Object.freeze({ ...security });
}

function normalizeLive(
  value: IntrabarLiveConfig | undefined,
  chartSeconds: number,
): IntrabarLiveConfig {
  const live = value ?? { cadence: 'bar-close' as const };
  if (!live || typeof live !== 'object') {
    throw new IntrabarRunnerError('live configuration is required');
  }
  if (live.cadence === 'bar-close') {
    assertKnownKeys(live as unknown as Record<string, unknown>, ['cadence'], 'live');
    return Object.freeze({ cadence: 'bar-close' });
  }
  if (live.cadence !== 'every-update') {
    throw new IntrabarRunnerError('live.cadence must be "bar-close" or "every-update"');
  }
  assertKnownKeys(
    live as unknown as Record<string, unknown>,
    [
      'cadence',
      'source',
      'throttleMs',
      'maxPendingFinals',
      'reconnectAttempts',
      'reconnectDelayMs',
      'reconnectMaxDelayMs',
      'startupDiscontinuity',
    ],
    'live',
  );
  const source = snapshotLiveSourcePolicy(live.source);
  if (source.kind === 'lower-bars') {
    const sourceSeconds = liveTimeframeSeconds(source.timeframe);
    if (sourceSeconds >= chartSeconds || chartSeconds % sourceSeconds !== 0) {
      throw new IntrabarRunnerError(
        `${source.timeframe} is not an exact child timeframe of the chart`,
      );
    }
  }
  optionalNonnegativeSafeInteger(live.throttleMs, 'throttleMs');
  optionalPositiveSafeInteger(live.maxPendingFinals, 'maxPendingFinals');
  optionalNonnegativeSafeInteger(live.reconnectAttempts, 'reconnectAttempts');
  optionalNonnegativeSafeInteger(live.reconnectDelayMs, 'reconnectDelayMs');
  optionalNonnegativeSafeInteger(live.reconnectMaxDelayMs, 'reconnectMaxDelayMs');
  if (
    live.reconnectDelayMs !== undefined &&
    live.reconnectMaxDelayMs !== undefined &&
    live.reconnectMaxDelayMs < live.reconnectDelayMs
  ) {
    throw new IntrabarRunnerError('reconnectMaxDelayMs must be >= reconnectDelayMs');
  }
  if (live.startupDiscontinuity !== undefined && typeof live.startupDiscontinuity !== 'boolean') {
    throw new IntrabarRunnerError('startupDiscontinuity must be a boolean when supplied');
  }
  return Object.freeze({
    ...live,
    source,
    throttleMs: live.throttleMs ?? 250,
    maxPendingFinals: live.maxPendingFinals ?? 256,
    reconnectAttempts: live.reconnectAttempts ?? 8,
    reconnectDelayMs: live.reconnectDelayMs ?? 250,
    reconnectMaxDelayMs: live.reconnectMaxDelayMs ?? 30_000,
  });
}

function magnifierBudgets(historical: IntrabarHistoricalConfig): {
  readonly maxMagnifierTargetBars?: number;
  readonly maxMagnifierRawBars?: number;
} {
  return historical.mode === 'bar-magnifier'
    ? {
        maxMagnifierTargetBars: historical.maxMagnifierTargetBars,
        maxMagnifierRawBars: historical.maxMagnifierRawBars,
      }
    : {};
}

function decisionId(binding: IntrabarHistoricalBinding, update: IntrabarUpdateIdentity): string {
  const source =
    update.kind === 'live-update'
      ? update.source.kind === 'native'
        ? 'native'
        : `lower-bars:${update.source.timeframe}`
      : 'closed-bars';
  return [
    'intrabar-v2',
    binding.authority.identity,
    encodeURIComponent(binding.chart.providerHandle),
    binding.chart.pinerTimeframe,
    source,
    update.barTime,
    update.revision,
    update.isClose ? 'final' : 'forming',
  ].join(':');
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IntrabarRunnerError(`${name} must be a nonblank string`);
  }
  return value.trim();
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new IntrabarRunnerError(`${name} must be a positive safe integer`);
  }
}

function nonnegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new IntrabarRunnerError(`${name} must be a non-negative safe integer`);
  }
}

function optionalPositiveSafeInteger(value: number | undefined, name: string): void {
  if (value !== undefined) positiveSafeInteger(value, name);
}

function optionalNonnegativeSafeInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new IntrabarRunnerError(`${name} must be a non-negative safe integer`);
  }
}

function assertKnownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new IntrabarRunnerError(`${label} contains unsupported fields: ${unknown.join(', ')}`);
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
