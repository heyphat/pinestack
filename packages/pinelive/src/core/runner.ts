import { ArrayFeed, compile, CompileError, Engine } from '@heyphat/piner';
import type { CompiledScript } from '@heyphat/piner';
import { toPinerTimeframe } from '@heyphat/pinery';
import { isMarkableBroker } from '../brokers/paper.js';
import type { Broker } from './broker.js';
import type { LiveFeed } from './feed.js';
import type { ForwardRecord } from './ledger.js';
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
  /** Stable deployment namespace used in restart-safe client ids. */
  executionId?: string;
  reconcileWarmup?: boolean;
  mirror?: PositionMirrorOptions;
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
  private abort = new AbortController();
  private initialized = false;
  private sequence = 0;
  private lastBarTime = -Infinity;
  private readonly runId: string;
  private readonly strategyId: string;

  constructor(
    private readonly broker: Broker,
    private readonly feed: LiveFeed,
    private readonly options: ForwardRunnerOptions,
  ) {
    this.strategyId = options.strategyId ?? sourceId(options.source);
    this.runId = options.runId ?? `${this.strategyId}-${Date.now()}`;
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
    if (errors.length > 0) {
      throw new ForwardRunnerError(
        `Pine compilation failed: ${errors.map((error) => error.message).join('; ')}`,
      );
    }
    if (!this.compiled.metadata.isStrategy)
      throw new ForwardRunnerError('Pine source must declare a strategy(), not an indicator()');
    if (this.compiled.metadata.securityDependencies.length > 0) {
      throw new ForwardRunnerError(
        'request.security strategies are not supported by the single-feed forward runner',
      );
    }

    this.ensureActive();
    await this.broker.connect?.();
    this.ensureActive();
    this.instrument = await this.broker.instrument(this.options.symbol);
    this.ensureActive();
    const history = await this.feed.history(
      this.options.symbol,
      this.options.timeframe,
      this.options.warmupBars ?? 200,
    );
    this.ensureActive();
    const strategyOptions = {
      minQty: this.instrument.minQty,
    } as StrategyOptionsWithMinQty;
    this.engine = new Engine(this.compiled, new ArrayFeed(history.map(toPinerBar)), {
      backend: this.options.backend ?? 'js',
      inputs: this.options.inputs,
      // piner 0.9 implements minQty at runtime while its published declaration omits it.
      strategy: strategyOptions,
    });
    await this.engine.run({
      symbol: this.options.symbol,
      timeframe: toPinerTimeframe(this.options.timeframe),
      mintick: this.instrument.mintick,
    });
    this.ensureActive();
    this.mirror = new PositionMirror(this.broker, this.instrument, this.options.mirror);
    this.initialized = true;

    const last = history.at(-1);
    if (last) {
      this.lastBarTime = last.time;
      if (this.options.reconcileWarmup !== false) {
        this.ensureActive();
        await this.reconcile(last);
      }
    }
  }

  async start(): Promise<void> {
    await this.init();
    for await (const bar of this.feed.closedBars(
      this.options.symbol,
      this.options.timeframe,
      this.abort.signal,
    )) {
      if (this.abort.signal.aborted) break;
      if (bar.time <= this.lastBarTime) continue;
      if (!Number.isFinite(bar.time))
        throw new ForwardRunnerError('feed emitted a bar with invalid time');
      this.engine!.tick(toPinerBar(bar), true);
      this.lastBarTime = bar.time;
      await this.reconcile(bar);
    }
  }

  /** Synchronously prevent any later reconciliation; effectful feed shutdown is handled by stop(). */
  cancel(): void {
    this.abort.abort();
  }

  async stop(): Promise<void> {
    this.cancel();
    await this.feed.stop();
  }

  async disconnect(): Promise<void> {
    await this.broker.disconnect?.();
  }

  private async reconcile(bar: Bar): Promise<void> {
    this.ensureActive();
    // Paper fills use this exact closed bar. Marking before getPosition/submit also keeps account equity current.
    if (isMarkableBroker(this.broker))
      await this.broker.mark(this.options.symbol, bar.close, bar.time);
    this.ensureActive();
    const target = this.engine!.ctx.strategy.position_size;
    const sequence = this.sequence++;
    const outcome = await this.mirror!.reconcile(target, {
      symbol: this.options.symbol,
      barTime: bar.time,
      strategyId: this.strategyId,
      executionId: this.options.executionId,
      timeframe: this.options.timeframe,
      sequence,
      signal: this.abort.signal,
    });
    await this.options.onRecord?.(this.record(sequence, bar, outcome));
  }

  private record(sequence: number, bar: Bar, outcome: ReconcileOutcome): ForwardRecord {
    return {
      schemaVersion: 1,
      runId: this.runId,
      strategyId: this.strategyId,
      cycleId: `${this.options.executionId ?? 'default'}:${this.strategyId}:${this.options.symbol}:${this.options.timeframe}:${bar.time}`,
      sequence,
      symbol: this.options.symbol,
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
