import { ArrayFeed, compile, CompileError, Engine } from '@heyphat/piner';
import type { CompiledScript } from '@heyphat/piner';
import {
  toPinerTimeframe,
  type MarketDataProvider,
  type ResolvedDataInstrument,
} from '@heyphat/pinery';
import { isMarkableBroker } from '../brokers/paper.js';
import type { Broker } from './broker.js';
import { createRunInstrumentBinding, type RunInstrumentBinding } from './binding.js';
import type { BindingRecord, ForwardRecord, StartupRecord } from './ledger.js';
import { PositionMirror } from './mirror.js';
import type { PositionMirrorOptions, ReconcileOutcome } from './mirror.js';
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
  private abort = new AbortController();
  private initialized = false;
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
    if (this.compiled.metadata.securityDependencies.length > 0)
      throw new ForwardRunnerError(
        'request.security strategies are not supported by the single-provider forward runner',
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

    const history = await this.data.historyResolved(
      this.resolved,
      this.options.timeframe,
      { limit: this.options.warmupBars ?? 200 },
      this.abort.signal,
    );
    this.ensureActive();
    const strategyOptions = { minQty: this.runBinding.qtyStep } as StrategyOptionsWithMinQty;
    this.engine = new Engine(this.compiled, new ArrayFeed(history.map(toPinerBar)), {
      backend: this.options.backend ?? 'js',
      inputs: this.options.inputs,
      strategy: strategyOptions,
    });
    await this.engine.run({
      symbol: this.runBinding.strategySymbol,
      timeframe: toPinerTimeframe(this.options.timeframe),
      mintick: this.runBinding.mintick,
    });
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
    await this.init();
    for await (const bar of this.data.closedBars(this.resolved!, this.options.timeframe, {
      after: Number.isFinite(this.lastBarTime) ? this.lastBarTime : undefined,
      signal: this.abort.signal,
    })) {
      if (this.abort.signal.aborted) break;
      if (!Number.isFinite(bar.time))
        throw new ForwardRunnerError('provider emitted a bar with invalid time');
      if (bar.time <= this.lastBarTime) continue;
      this.engine!.tick(toPinerBar(bar), true);
      this.lastBarTime = bar.time;
      const { record } = await this.reconcile(bar, 'cycle');
      await this.options.onRecord?.(record);
      this.ensureActive();
    }
  }

  cancel(): void {
    this.abort.abort();
  }

  async stop(): Promise<void> {
    this.cancel();
    await this.data.disconnect?.();
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
      fill: outcome.action === 'order' ? outcome.fill : undefined,
      error:
        outcome.action === 'reject'
          ? outcome.error
          : outcome.action === 'order'
            ? outcome.positionError
            : undefined,
      recordedAt: new Date().toISOString(),
    };
  }

  private ensureActive(): void {
    if (this.abort.signal.aborted) throw new ForwardRunnerError('forward runner aborted');
  }
}
