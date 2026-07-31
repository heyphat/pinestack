import { CompileError, compile, type CompiledScript } from '@heyphat/piner';
import {
  assertLiveSymbolMatchesConfig,
  canonicalTimeframeToPineExact,
  parseCanonicalTimeframeExact,
  type MarketDataProvider,
  type ResolvedDataInstrument,
} from '@heyphat/pinery';
import { preflightCompiledBarMagnifier, type MagnifierPreflight } from '@heyphat/pinerun';
import type { Broker } from './broker.js';
import {
  createV2ComputeInstrumentBinding,
  createV2RunInstrumentBinding,
  type RunInstrumentBinding,
} from './binding.js';
import {
  DEFAULT_MAX_CONSECUTIVE_EXECUTION_ERRORS,
  DEFAULT_MAX_ORDERS_PER_BAR,
  DEFAULT_MAX_ORDERS_PER_MINUTE,
  DEFAULT_MAX_TARGET_CHANGES_PER_BAR,
  DEFAULT_MIN_RECONCILE_INTERVAL_MS,
  normalizeRunConfig,
  validateCompiledIntrabarConfig,
  type NormalizedComputeOnlyV2RunConfig,
  type NormalizedMirroredExecutionConfig,
  type NormalizedMirroredV2RunConfig,
  type NormalizedV2RunConfig,
} from './config.js';
import {
  assertPreparedAuthorityEnvelope,
  authorityEnvelopesEqual,
  canonicalSerialize,
  deepFreeze,
  type PreparedIntrabarAuthorityEnvelope,
} from './intrabar-authority.js';
import {
  IntrabarRunner,
  type IntrabarEvaluation,
  type IntrabarHistoricalBinding,
} from './intrabar-runner.js';
import type { ExecutionLease, ExecutionLeaseSnapshot } from './lease.js';
import {
  SequencedLedger,
  type ChartUpdateIdentityV3,
  type EvaluationSkipReasonV3,
  type LedgerEventV3,
  type LedgerSink,
  type LeaseEventV3,
} from './ledger.js';
import { PositionMirror } from './mirror.js';
import { recoverLedger, type LedgerRecoveryState, type RecoveredBarCounters } from './recovery.js';
import { TargetScheduler, type ScheduledTargetResult, type TargetEvaluation } from './scheduler.js';
import type { Account, Position } from './types.js';
import { isMarkableBroker } from '../brokers/paper.js';

export interface PreparedIntrabarRun<C extends NormalizedV2RunConfig = NormalizedV2RunConfig> {
  readonly config: C;
  readonly source: string;
  readonly compiled: CompiledScript;
  readonly preflight: MagnifierPreflight;
}

export type PreparedComputeOnlyIntrabarRun = PreparedIntrabarRun<NormalizedComputeOnlyV2RunConfig>;
export type PreparedMirroredIntrabarRun = PreparedIntrabarRun<NormalizedMirroredV2RunConfig>;

const preparedRuns = new WeakSet<object>();

/**
 * Complete pure v2 gate. It reads no file, provider, profile, environment variable, SDK, broker,
 * account, ledger, or lease. Runtime factories are intentionally absent from this contract.
 */
export function prepareIntrabarRun(
  configValue: {
    readonly configVersion: 2;
    readonly execution: { readonly kind: 'compute-only' };
  },
  source: string,
): PreparedComputeOnlyIntrabarRun;
export function prepareIntrabarRun(
  configValue: {
    readonly configVersion: 2;
    readonly execution: { readonly kind: 'mirrored' };
  },
  source: string,
): PreparedMirroredIntrabarRun;
export function prepareIntrabarRun(configValue: unknown, source: string): PreparedIntrabarRun;
export function prepareIntrabarRun(configValue: unknown, source: string): PreparedIntrabarRun {
  const config = normalizeRunConfig(configValue);
  if (config.configVersion !== 2) throw new Error('prepareIntrabarRun requires configVersion 2');
  if (config.execution.kind === 'mirrored' && config.execution.broker.id === 'tiger') {
    throw new Error(
      'Tiger v2 broker execution is unavailable until the credentialed release gate passes',
    );
  }
  if (typeof source !== 'string' || source.trim().length === 0)
    throw new Error('Pine source must be a nonblank string');

  const runSymbol = assertLiveSymbolMatchesConfig(config.symbol, config.data);
  let compiled: CompiledScript;
  try {
    compiled = compile(source);
  } catch (error) {
    throw new Error(error instanceof CompileError ? error.message : 'Pine compilation failed', {
      cause: error,
    });
  }
  const diagnostics = compiled.diagnostics.filter((item) => item.severity === 'error');
  if (diagnostics.length > 0) {
    throw new Error(
      `Pine compilation failed: ${diagnostics.map((item) => item.message).join('; ')}`,
    );
  }

  validateCompiledIntrabarConfig(compiled.metadata, config);
  if (
    config.execution.kind === 'mirrored' &&
    config.live.cadence === 'bar-close' &&
    config.execution.reconcileOnStart
  ) {
    throw new Error(
      'v2 startup reconciliation is unavailable; execution requires a new authoritative final',
    );
  }

  const parsed = parseCanonicalTimeframeExact(config.timeframe);
  if (parsed.kind !== 'ok' || parsed.value.domain !== 'fixed') {
    throw new Error(
      parsed.kind === 'ok' ? 'v2 live chart timeframe must have a fixed duration' : parsed.message,
    );
  }
  const pineTimeframe = canonicalTimeframeToPineExact(parsed.value.canonical);
  if (pineTimeframe.kind !== 'ok') throw new Error(pineTimeframe.message);
  const preflight = preflightCompiledBarMagnifier(
    source,
    pineTimeframe.value,
    config.historical.mode === 'bar-magnifier',
    compiled,
  );
  const normalized = Object.freeze({
    ...config,
    symbol: runSymbol,
  }) as NormalizedV2RunConfig;
  const prepared = Object.freeze({ config: normalized, source, compiled, preflight });
  preparedRuns.add(prepared);
  return prepared;
}

export interface IntrabarPersistenceRead {
  readonly records: readonly unknown[];
  readonly partialFinalLine?: string;
}

/** Managed persistence adapter retained for embedders; the production CLI uses direct options. */
export interface IntrabarPersistence {
  read(): Promise<IntrabarPersistenceRead>;
  createLease(recovery: LedgerRecoveryState): ExecutionLease | Promise<ExecutionLease>;
  createLedger(
    lease: ExecutionLease,
    read: IntrabarPersistenceRead,
  ): LedgerSink | Promise<LedgerSink>;
}

export interface IntrabarBrokerFactoryContext {
  readonly config: NormalizedMirroredExecutionConfig['broker'];
  readonly resolved: ResolvedDataInstrument;
  readonly authority: PreparedIntrabarAuthorityEnvelope;
  readonly signal?: AbortSignal;
}

export type IntrabarBrokerFactory = (
  context: IntrabarBrokerFactoryContext,
) => Broker | Promise<Broker>;

interface IntrabarServerCallbacks {
  readonly signal?: AbortSignal;
  readonly teardownTimeoutMs?: number;
  /** Invoked only after this evaluation has a durable schema-v3 row. */
  readonly onEvaluation?: (evaluation: IntrabarEvaluation) => void | Promise<void>;
  readonly onLog?: (message: string) => void;
}

interface DirectRuntimeOptions extends IntrabarServerCallbacks {
  readonly dataFactory: () => MarketDataProvider | Promise<MarketDataProvider>;
  /** Ownership is transferred for the run. A raw sink is flushed and closed on teardown. */
  readonly ledger: LedgerSink | SequencedLedger;
  readonly recoveredEvents?: readonly unknown[];
  readonly recoveredState?: LedgerRecoveryState;
  readonly createData?: never;
  readonly persistence?: never;
}

interface ManagedRuntimeOptions extends IntrabarServerCallbacks {
  readonly createData: () => MarketDataProvider | Promise<MarketDataProvider>;
  readonly persistence: IntrabarPersistence;
  readonly dataFactory?: never;
  readonly ledger?: never;
  readonly recoveredEvents?: never;
  readonly recoveredState?: never;
}

export type ComputeOnlyIntrabarServerOptions = (DirectRuntimeOptions | ManagedRuntimeOptions) & {
  readonly prepared: PreparedComputeOnlyIntrabarRun;
  /** Compute-only ownership cannot structurally contain any broker or broker factory. */
  readonly brokerFactory?: never;
  readonly createBroker?: never;
  readonly lease?: never;
};

export type MirroredIntrabarServerOptions =
  | (DirectRuntimeOptions & {
      readonly prepared: PreparedMirroredIntrabarRun;
      readonly brokerFactory: IntrabarBrokerFactory;
      readonly lease: ExecutionLease;
      /**
       * Refresh durable recovery while the direct lease is held. File-backed callers should
       * provide this to close the read-to-acquire handoff race before sequence allocation.
       */
      readonly refreshRecoveryAfterLease?: () =>
        IntrabarPersistenceRead | Promise<IntrabarPersistenceRead>;
      readonly createBroker?: never;
    })
  | (ManagedRuntimeOptions & {
      readonly prepared: PreparedMirroredIntrabarRun;
      /** @deprecated Legacy adapter alias retained only for the existing uncommitted CLI. */
      readonly createBroker: IntrabarBrokerFactory;
      readonly brokerFactory?: never;
      readonly lease?: never;
      readonly refreshRecoveryAfterLease?: never;
    });

export type IntrabarServerOptions =
  ComputeOnlyIntrabarServerOptions | MirroredIntrabarServerOptions;

export interface IntrabarRunDecisionSummary {
  readonly decisionId: string;
  readonly target: number;
  readonly barTime: number;
  readonly revision: number;
  readonly authoritativeFinal: boolean;
  readonly executable: boolean;
  readonly reason: IntrabarEvaluation['reason'];
}

interface IntrabarServerResultBase {
  readonly authority: PreparedIntrabarAuthorityEnvelope;
  readonly binding: RunInstrumentBinding;
  readonly evaluations: number;
  readonly lastFinalCursor?: number;
  readonly recoveredFromSequence: number;
  readonly latestDecision?: IntrabarRunDecisionSummary;
}

export interface ComputeOnlyIntrabarServerResult extends IntrabarServerResultBase {
  readonly mode: 'compute-only';
  readonly finalPosition?: never;
  readonly finalAccount?: never;
  readonly executionSafe?: never;
}

export type MirroredIntrabarServerResult = IntrabarServerResultBase &
  (
    | {
        readonly mode: 'mirrored';
        readonly executionSafe: true;
        readonly finalPosition: Readonly<Position>;
        readonly finalAccount: Readonly<Account>;
        readonly unsafeReason?: never;
      }
    | {
        readonly mode: 'mirrored';
        readonly executionSafe: false;
        readonly unsafeReason: string;
        readonly finalPosition?: never;
        readonly finalAccount?: never;
      }
  );

export type IntrabarServerResult = ComputeOnlyIntrabarServerResult | MirroredIntrabarServerResult;

/**
 * Real v2 finite-history + live runtime. No branch calls flatten. Exact preparation and authority
 * comparison precede mirrored ownership; an acquired lease row precedes the lazy broker factory.
 */
export function runIntrabarServer(
  options: ComputeOnlyIntrabarServerOptions,
): Promise<ComputeOnlyIntrabarServerResult>;
export function runIntrabarServer(
  options: MirroredIntrabarServerOptions,
): Promise<MirroredIntrabarServerResult>;
export async function runIntrabarServer(
  options: IntrabarServerOptions,
): Promise<IntrabarServerResult> {
  if (!preparedRuns.has(options.prepared))
    throw new Error('runIntrabarServer requires a value returned by prepareIntrabarRun');
  if (options.signal?.aborted) throw new Error('intrabar server start aborted');
  validateRuntimeOptions(options);

  const teardownTimeoutMs = options.teardownTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(teardownTimeoutMs) || teardownTimeoutMs <= 0)
    throw new RangeError('teardownTimeoutMs must be a positive safe integer');

  const config = options.prepared.config;
  const mirrored = config.execution.kind === 'mirrored';
  const brokerClass = mirrored ? config.execution.broker.id : 'compute-only';
  const managed = isManagedOptions(options);
  const refreshRecoveryAfterLease =
    !managed && mirrored
      ? (
          options as DirectRuntimeOptions & {
            readonly refreshRecoveryAfterLease?: () =>
              IntrabarPersistenceRead | Promise<IntrabarPersistenceRead>;
          }
        ).refreshRecoveryAfterLease
      : undefined;

  let data: MarketDataProvider | undefined;
  let runner: IntrabarRunner | undefined;
  let lease: ExecutionLease | undefined;
  let leaseRecorded = false;
  let rawSink: LedgerSink | undefined;
  let writer: SequencedLedger | undefined;
  let broker: Broker | undefined;
  let scheduler: TargetScheduler | undefined;
  let computeJournal: ComputeDecisionJournal | undefined;
  let binding: RunInstrumentBinding | undefined;
  let historicalBinding: IntrabarHistoricalBinding | undefined;
  let recovery: LedgerRecoveryState | undefined;
  let recoveredFromSequence = 0;
  let evaluationCount = 0;
  let latestDecision: IntrabarRunDecisionSummary | undefined;
  let primaryError: unknown;
  let result: IntrabarServerResult | undefined;
  let ownedRead: IntrabarPersistenceRead | undefined;

  const abortRunner = (): void => runner?.cancel();
  options.signal?.addEventListener('abort', abortRunner, { once: true });
  try {
    const dataFactory = managed ? options.createData : options.dataFactory;
    data = await dataFactory();
    assertNotAborted(options.signal, 'after data construction');

    runner = new IntrabarRunner(data, {
      source: options.prepared.source,
      symbol: config.symbol,
      timeframe: config.timeframe,
      configuredWarmupBars: config.warmupBars ?? 200,
      warmupBars: Math.max(1, config.warmupBars ?? 200),
      inputs: config.inputs,
      historical: config.historical,
      live: config.live,
      security: config.security,
      strategyIdentity: config.strategy,
      configuredBrokerClass: brokerClass,
      compiled: options.prepared.compiled,
      preflight: options.prepared.preflight,
      onEvaluation: async (evaluation) => {
        const currentBinding = binding;
        if (!currentBinding)
          throw new Error('intrabar evaluation arrived before the execution binding');
        const target = toTargetEvaluation(evaluation, currentBinding, config);
        let scheduled: ScheduledTargetResult | undefined;

        if (!mirrored) {
          await computeJournal!.journal(target, computeSkipReason(evaluation), evaluation.reason);
        } else if (!evaluation.executable) {
          scheduled = await scheduler!.journalSkipped(
            target,
            evaluation.reason === 'recovered-final' ? 'recovered-final' : 'startup-discontinuity',
            evaluation.reason,
          );
        } else if (!evaluation.finalCommit) {
          scheduled = await scheduler!.journalSkipped(target, 'forming', 'mirrorOn=bar-close');
        } else if (evaluation.update.recovered) {
          scheduled = await scheduler!.journalSkipped(target, 'recovered-final');
        } else if (config.execution.kind !== 'mirrored') {
          throw new Error('mirrored evaluation lost its execution configuration');
        } else if (config.execution.mirrorOn !== 'bar-close') {
          scheduled = await scheduler!.journalSkipped(target, 'mirror-cadence');
        } else {
          const markable =
            broker && broker.id === 'paper' && isMarkableBroker(broker) ? broker : undefined;
          scheduled = await scheduler!.schedule({
            ...target,
            ...(markable
              ? {
                  beforeBrokerRead: () =>
                    markable.mark(
                      currentBinding.executionSymbol,
                      evaluation.bar.close,
                      evaluation.bar.time,
                    ),
                }
              : {}),
          });
        }

        if (scheduled?.status === 'unknown') {
          options.onLog?.(`decision ${evaluation.decisionId} has an unknown broker outcome`);
        }
        evaluationCount++;
        latestDecision = decisionSummary(evaluation);
        await options.onEvaluation?.(evaluation);
      },
    });

    await runner.initialize();
    historicalBinding = runner.binding;
    const resolved = runner.resolvedInstrument;
    if (!historicalBinding || !resolved)
      throw new Error('intrabar preparation did not freeze its resolved authority');
    await assertPreparedAuthorityEnvelope(historicalBinding.authority);

    let recoveredMaterial = 0;
    if (managed) {
      const firstRead = await options.persistence.read();
      recovery = recoverForV2(firstRead.records);
      recoveredMaterial = recoveryMaterialCount(firstRead);
      await assertRecoveredAuthority(recovery, historicalBinding.authority, recoveredMaterial > 0);
      lease = await options.persistence.createLease(recovery);
    } else {
      const recovered = recoverDirect(options);
      recovery = recovered.state;
      recoveredMaterial = recovered.materialCount;
      await assertRecoveredAuthority(recovery, historicalBinding.authority, recoveredMaterial > 0);
      if (mirrored) lease = options.lease;
    }

    if (!recovery) throw new Error('intrabar recovery state was not established');
    assertRecoveryCanBind(recovery);
    assertNotAborted(options.signal, 'before lease acquisition');

    let leaseSnapshot: ExecutionLeaseSnapshot | undefined;
    if (lease) {
      leaseSnapshot = await lease.acquire();
      // A direct owned reread can supersede an active-lease row that was stale by handoff time.
      // Callers without that reread retain the conservative pre-acquisition comparison.
      if (!refreshRecoveryAfterLease) assertRecoveredLease(recovery, leaseSnapshot);
    }

    if (managed) {
      ownedRead = await options.persistence.read();
      recovery = recoverForV2(ownedRead.records);
      recoveredMaterial = recoveryMaterialCount(ownedRead);
      await assertRecoveredAuthority(recovery, historicalBinding.authority, recoveredMaterial > 0);
      assertRecoveryCanBind(recovery);
      if (!leaseSnapshot)
        throw new Error('managed intrabar persistence requires an acquired lease');
      assertRecoveredLease(recovery, leaseSnapshot);
      rawSink = await options.persistence.createLedger(lease!, ownedRead);
    } else if (mirrored && refreshRecoveryAfterLease) {
      ownedRead = await refreshRecoveryAfterLease();
      recovery = recoverForV2(ownedRead.records);
      recoveredMaterial = recoveryMaterialCount(ownedRead);
      await assertRecoveredAuthority(recovery, historicalBinding.authority, recoveredMaterial > 0);
      assertRecoveryCanBind(recovery);
      if (!lease || !leaseSnapshot)
        throw new Error('direct recovery refresh requires an acquired execution lease');
      await lease.assertHeld();
      assertRecoveredLease(recovery, leaseSnapshot);
    }

    recoveredFromSequence = recovery.lastSequence;
    configureRunnerRecovery(runner, recovery);

    const directLedger = managed ? undefined : options.ledger;
    const namespace = ledgerNamespace(config, historicalBinding.authority, recovery, directLedger);
    if (directLedger instanceof SequencedLedger) {
      writer = directLedger;
      assertSequencedLedgerMatches(writer, recovery, namespace);
    } else {
      rawSink = rawSink ?? directLedger;
      if (!rawSink) throw new Error('intrabar runtime has no durable ledger sink');
      writer = new SequencedLedger(rawSink, {
        ...namespace,
        nextSequence: recovery.nextSequence,
        lastTimestamp:
          recovery.events.length > 0 ? Date.parse(recovery.events.at(-1)!.recordedAt) : undefined,
      });
    }

    const recoveredAuthority = authorityFromRecovery(recovery);
    if (!recoveredAuthority) {
      await writer.append({
        recordType: 'authority',
        authority: historicalBinding.authority,
      });
    }

    if (lease && leaseSnapshot) {
      if (!recovery.activeLease) {
        await writer.append({
          recordType: 'lease',
          action: 'acquired',
          resource: leaseSnapshot.resource,
          leaseId: leaseSnapshot.leaseId,
          ownerId: leaseSnapshot.ownerId,
        });
      }
      leaseRecorded = true;
    }

    if (ownedRead?.partialFinalLine) {
      await writer.append({
        recordType: 'recovery',
        action: 'partial-tail-discarded',
        sourceLastSequence: recovery.lastSequence,
        ...(recovery.lastFinalCursor == null ? {} : { lastFinalCursor: recovery.lastFinalCursor }),
        unresolvedLogicalOrderIds: [...recovery.unresolvedIntents.keys()].sort(),
        detail: 'discarded a non-durable partial final JSONL row while holding the lease',
      });
    }

    if (!mirrored) {
      binding = await createV2ComputeInstrumentBinding(data, resolved, historicalBinding.authority);
      await assertRecoveredBinding(recovery, binding);
      computeJournal = new ComputeDecisionJournal({
        writer,
        lease,
        leaseRecorded,
        recovery,
        binding,
        strategyId: config.strategy,
      });
      await computeJournal.initialize();
    } else {
      if (!lease || !lease.snapshot || !leaseRecorded)
        throw new Error('mirrored broker construction requires a durable acquired lease');
      const brokerFactory: IntrabarBrokerFactory | undefined = managed
        ? options.createBroker
        : options.brokerFactory;
      if (!brokerFactory)
        throw new Error('mirrored intrabar runtime requires a lazy broker factory');
      // This is intentionally the first broker ownership point.
      broker = await brokerFactory({
        config: config.execution.broker,
        resolved,
        authority: historicalBinding.authority,
        signal: options.signal,
      });
      if (broker.id !== config.execution.broker.id) {
        throw new Error('broker factory returned a different configured broker class');
      }
      await broker.connect?.(options.signal);
      const instrument = await broker.instrument(resolved.venueSymbol, options.signal);
      binding = await createV2RunInstrumentBinding(
        data,
        resolved,
        broker,
        instrument,
        historicalBinding.authority,
        {
          mirrorOn: config.execution.mirrorOn,
          order: config.execution.order,
          broker: config.execution.broker,
        },
      );
      // Full route, policy, and economics comparison precedes mark, position read, or submit.
      await assertRecoveredBinding(recovery, binding);

      const mirror = new PositionMirror(broker, instrument, {
        transientRetries: 0,
        orderType: config.execution.order.type,
        ...(config.execution.order.type === 'limit'
          ? { limitOffsetTicks: config.execution.order.limitOffsetTicks }
          : {}),
      });
      scheduler = new TargetScheduler({
        mirror,
        ledger: writer,
        runId: namespace.runId,
        executionId: namespace.executionId,
        binding,
        recovery,
        lease,
        leaseAlreadyRecorded: true,
        limits: schedulerLimits(),
      });
      await scheduler.initialize();
    }

    options.onLog?.(
      `prepared authority=${historicalBinding.authority.identity} binding=${binding.id}`,
    );
    assertNotAborted(options.signal, 'before live subscription');
    await runner.start();
    await writer.flush();

    const commonResult = {
      authority: historicalBinding.authority,
      binding,
      evaluations: evaluationCount,
      ...(runner.finalizedCursor == null ? {} : { lastFinalCursor: runner.finalizedCursor }),
      recoveredFromSequence,
      ...(latestDecision ? { latestDecision } : {}),
    } satisfies IntrabarServerResultBase;

    if (!mirrored) {
      result = deepFreeze({ mode: 'compute-only' as const, ...commonResult });
    } else {
      const finalState = await finalBrokerState(
        scheduler!,
        lease!,
        broker!,
        binding,
        options.signal,
      );
      result = deepFreeze({ mode: 'mirrored' as const, ...commonResult, ...finalState });
    }
  } catch (error) {
    primaryError = error;
  } finally {
    options.signal?.removeEventListener('abort', abortRunner);
  }

  runner?.cancel();
  const cleanupErrors: unknown[] = [];
  const cleanup = async (operation: () => void | Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };

  if (scheduler) await cleanup(() => scheduler!.stop());
  if (computeJournal) await cleanup(() => computeJournal!.stop());
  if (writer) await cleanup(() => writer!.flush());

  if (scheduler && lease?.snapshot) {
    await cleanup(() => scheduler!.releaseLease());
    leaseRecorded = false;
  } else if (computeJournal && lease?.snapshot) {
    await cleanup(() => computeJournal!.releaseLease());
    leaseRecorded = false;
  } else if (lease?.snapshot) {
    await cleanup(() => releaseRecordedLease(writer, lease!, leaseRecorded));
    leaseRecorded = false;
  }

  if (broker?.disconnect) {
    await cleanup(() => boundedCleanup(() => broker!.disconnect!(), teardownTimeoutMs, 'broker'));
  }
  if (data?.disconnect) {
    await cleanup(() => boundedCleanup(() => data!.disconnect!(), teardownTimeoutMs, 'provider'));
  }
  if (rawSink?.close) await cleanup(() => rawSink!.close!());

  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'intrabar server and cleanup failed',
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError(cleanupErrors, 'intrabar server cleanup failed');
  if (!result) throw new Error('intrabar server stopped without a result');
  return result;
}

interface ComputeDecisionJournalOptions {
  readonly writer: SequencedLedger;
  readonly lease?: ExecutionLease;
  readonly leaseRecorded: boolean;
  readonly recovery: LedgerRecoveryState;
  readonly binding: RunInstrumentBinding;
  readonly strategyId: string;
}

class ComputeDecisionJournal {
  readonly perBar = new Map<string, RecoveredBarCounters>();
  readonly decisionIds = new Set<string>();
  initialized = false;
  private leaseRecorded: boolean;

  constructor(private readonly options: ComputeDecisionJournalOptions) {
    this.leaseRecorded = options.leaseRecorded;
    for (const [key, value] of options.recovery.perBar) this.perBar.set(key, { ...value });
    for (const key of options.recovery.decisions.keys()) this.decisionIds.add(key);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const { writer, recovery, binding, lease } = this.options;
    if (lease && !lease.snapshot) throw new Error('compute journal lease is not acquired');
    if (lease && !this.leaseRecorded) {
      const snapshot = lease.snapshot!;
      await writer.append({
        recordType: 'lease',
        action: 'acquired',
        resource: snapshot.resource,
        leaseId: snapshot.leaseId,
        ownerId: snapshot.ownerId,
      });
      this.leaseRecorded = true;
    }
    await writer.append({
      recordType: 'recovery',
      action: 'loaded',
      sourceLastSequence: recovery.lastSequence,
      ...(recovery.lastFinalCursor == null ? {} : { lastFinalCursor: recovery.lastFinalCursor }),
      unresolvedLogicalOrderIds: [...recovery.unresolvedIntents.keys()].sort(),
    });
    if (!recovery.binding) await writer.append({ recordType: 'binding', binding });
    this.initialized = true;
  }

  async journal(
    evaluation: TargetEvaluation,
    reason: EvaluationSkipReasonV3,
    detail?: string,
  ): Promise<void> {
    if (!this.initialized) throw new Error('compute journal is not initialized');
    if (this.decisionIds.has(evaluation.decisionId!)) return;
    const { writer, binding, strategyId } = this.options;
    const key = `${binding.id}:${evaluation.context.barTime}`;
    const counter = this.perBar.get(key) ?? { targets: 0, intents: 0 };
    this.perBar.set(key, counter);
    await writer.append({
      recordType: 'evaluation.skipped',
      ...decisionFields(evaluation, strategyId),
      reason,
      targetOrdinal: counter.targets + 1,
      ...(detail ? { detail } : {}),
    });
    counter.targets++;
    this.decisionIds.add(evaluation.decisionId!);
  }

  async stop(): Promise<void> {
    await this.options.writer.flush();
  }

  async releaseLease(): Promise<void> {
    const lease = this.options.lease;
    if (!lease?.snapshot) return;
    try {
      await releaseRecordedLease(this.options.writer, lease, this.leaseRecorded);
    } finally {
      this.leaseRecorded = false;
    }
  }
}

function toTargetEvaluation(
  evaluation: IntrabarEvaluation,
  binding: RunInstrumentBinding,
  config: NormalizedV2RunConfig,
): TargetEvaluation {
  const update: ChartUpdateIdentityV3 = {
    kind: evaluation.update.kind === 'live-update' ? 'intrabar' : 'close-only',
    eventId: evaluation.decisionId,
    revision: evaluation.update.revision,
    authoritativeFinal: evaluation.finalCommit,
    recovered: evaluation.update.recovered,
    discontinuity: evaluation.reason === 'startup-discontinuity',
  };
  return {
    target: evaluation.target,
    cursor: evaluation.update.barTime,
    update,
    decisionId: evaluation.decisionId,
    context: {
      strategySymbol: binding.strategySymbol,
      executionSymbol: binding.executionSymbol,
      bindingId: binding.id,
      barTime: evaluation.update.barTime,
      referencePrice: evaluation.bar.close,
      timeframe: config.timeframe,
      executionId: config.execution.kind === 'mirrored' ? config.execution.executionId : undefined,
      strategyId: config.strategy,
      sequence: evaluation.sequence,
    },
  };
}

function decisionFields(evaluation: TargetEvaluation, strategyId: string) {
  return {
    decisionId: evaluation.decisionId!,
    strategyId,
    strategySymbol: evaluation.context.strategySymbol,
    executionSymbol: evaluation.context.executionSymbol,
    bindingId: evaluation.context.bindingId,
    timeframe: evaluation.context.timeframe,
    barTime: evaluation.context.barTime,
    cursor: evaluation.cursor ?? evaluation.context.barTime,
    update: evaluation.update!,
    target: evaluation.target,
    ...(evaluation.context.referencePrice == null
      ? {}
      : { referencePrice: evaluation.context.referencePrice }),
  };
}

function decisionSummary(evaluation: IntrabarEvaluation): IntrabarRunDecisionSummary {
  return deepFreeze({
    decisionId: evaluation.decisionId,
    target: evaluation.target,
    barTime: evaluation.update.barTime,
    revision: evaluation.update.revision,
    authoritativeFinal: evaluation.finalCommit,
    executable: evaluation.executable,
    reason: evaluation.reason,
  });
}

function computeSkipReason(evaluation: IntrabarEvaluation): EvaluationSkipReasonV3 {
  if (evaluation.reason === 'recovered-final') return 'recovered-final';
  if (evaluation.reason === 'startup-discontinuity') return 'startup-discontinuity';
  if (!evaluation.finalCommit) return 'forming';
  return 'compute-only';
}

function schedulerLimits() {
  return {
    minIntervalMs: DEFAULT_MIN_RECONCILE_INTERVAL_MS,
    maxTargetsPerBar: DEFAULT_MAX_TARGET_CHANGES_PER_BAR,
    maxIntentsPerBar: DEFAULT_MAX_ORDERS_PER_BAR,
    maxAttemptsPerMinute: DEFAULT_MAX_ORDERS_PER_MINUTE,
    maxConsecutiveErrors: DEFAULT_MAX_CONSECUTIVE_EXECUTION_ERRORS,
  };
}

function recoverForV2(records: readonly unknown[]): LedgerRecoveryState {
  return recoverLedger(records);
}

function recoverDirect(options: DirectRuntimeOptions): {
  readonly state: LedgerRecoveryState;
  readonly materialCount: number;
} {
  if (options.recoveredEvents !== undefined && options.recoveredState !== undefined) {
    throw new Error('provide recoveredEvents or recoveredState, not both');
  }
  const records = options.recoveredEvents ?? options.recoveredState?.events ?? [];
  return { state: recoverForV2(records), materialCount: records.length };
}

function recoveryMaterialCount(read: IntrabarPersistenceRead): number {
  return read.records.length + (read.partialFinalLine ? 1 : 0);
}

function authorityFromRecovery(
  recovery: LedgerRecoveryState,
): PreparedIntrabarAuthorityEnvelope | undefined {
  return recovery.authority?.authority ?? recovery.binding?.binding.authority;
}

async function assertRecoveredAuthority(
  recovery: LedgerRecoveryState,
  current: PreparedIntrabarAuthorityEnvelope,
  required: boolean,
): Promise<void> {
  const dedicated = recovery.authority?.authority;
  const extended = recovery.binding?.binding.authority;
  if (dedicated) await assertPreparedAuthorityEnvelope(dedicated);
  if (extended) await assertPreparedAuthorityEnvelope(extended);
  if (dedicated && extended && !authorityEnvelopesEqual(dedicated, extended)) {
    throw new Error('recovered authority event does not match the v2 binding extension');
  }
  const recovered = dedicated ?? extended;
  if (!recovered) {
    if (required) throw new Error('recovered v2 run is missing prepared authority');
    return;
  }
  if (!authorityEnvelopesEqual(recovered, current)) {
    throw new Error(
      `prepared authority mismatch: recovered ${recovered.identity}, current ${current.identity}`,
    );
  }
}

function assertRecoveryCanBind(recovery: LedgerRecoveryState): void {
  if (recovery.decisions.size > 0 && !recovery.binding) {
    throw new Error('recovered schema-v3 evaluations are missing an execution binding');
  }
}

function assertRecoveredLease(
  recovery: LedgerRecoveryState,
  snapshot: ExecutionLeaseSnapshot,
): void {
  const active = recovery.activeLease;
  if (!active) return;
  if (
    active.resource !== snapshot.resource ||
    active.leaseId !== snapshot.leaseId ||
    active.ownerId !== snapshot.ownerId
  ) {
    throw new Error('acquired execution lease does not match durable active ownership');
  }
}

async function assertRecoveredBinding(
  recovery: LedgerRecoveryState,
  current: RunInstrumentBinding,
): Promise<void> {
  const recovered = recovery.binding?.binding;
  if (!recovered) return;
  if (recovered.bindingVersion !== 2 || !recovered.authority) {
    throw new Error('recovered schema-v3 binding is not a strong v2 execution binding');
  }
  if (canonicalSerialize(recovered) !== canonicalSerialize(current)) {
    throw new Error('current execution binding does not match recovered schema-v3 binding');
  }
}

function configureRunnerRecovery(runner: IntrabarRunner, recovery: LedgerRecoveryState): void {
  const cursor = recovery.lastFinalCursor;
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || typeof cursor !== 'number')) {
    throw new Error('v2 intrabar recovery requires a numeric authoritative-final cursor');
  }
  const startupDiscontinuity =
    recovery.activeBars.size > 0 ||
    recovery.interruptedUpdates.some((update) => !update.authoritativeFinal);
  runner.configureRecovery({
    ...(cursor === undefined ? {} : { lastFinalCursor: cursor }),
    startupDiscontinuity,
  });
}

function ledgerNamespace(
  config: NormalizedV2RunConfig,
  authority: PreparedIntrabarAuthorityEnvelope,
  recovery: LedgerRecoveryState,
  supplied: LedgerSink | SequencedLedger | undefined,
): { readonly runId: string; readonly executionId: string } {
  const suppliedWriter = supplied instanceof SequencedLedger ? supplied : undefined;
  const brokerClass =
    config.execution.kind === 'mirrored' ? config.execution.broker.id : 'compute-only';
  return {
    runId: recovery.runId ?? suppliedWriter?.runId ?? `pinelive-v2:${authority.identity}`,
    executionId:
      recovery.executionId ??
      suppliedWriter?.executionId ??
      (config.execution.kind === 'mirrored' ? config.execution.executionId : undefined) ??
      `pinelive-v2:${config.strategy}:${config.symbol}:${brokerClass}`,
  };
}

function assertSequencedLedgerMatches(
  writer: SequencedLedger,
  recovery: LedgerRecoveryState,
  namespace: { readonly runId: string; readonly executionId: string },
): void {
  if (writer.nextSequence !== recovery.nextSequence) {
    throw new Error('supplied SequencedLedger does not start at recovery.nextSequence');
  }
  if (writer.runId !== namespace.runId || writer.executionId !== namespace.executionId) {
    throw new Error('supplied SequencedLedger namespace does not match recovery');
  }
}

async function finalBrokerState(
  scheduler: TargetScheduler,
  lease: ExecutionLease,
  broker: Broker,
  binding: RunInstrumentBinding,
  signal?: AbortSignal,
): Promise<
  | {
      readonly executionSafe: true;
      readonly finalPosition: Readonly<Position>;
      readonly finalAccount: Readonly<Account>;
    }
  | {
      readonly executionSafe: false;
      readonly unsafeReason: string;
    }
> {
  await scheduler.idle();
  const state = scheduler.state;
  if (state.breaker.latched) {
    return {
      executionSafe: false,
      unsafeReason: `execution breaker is latched${state.breaker.reason ? `: ${state.breaker.reason}` : ''}`,
    };
  }
  if (state.unresolvedLogicalOrderIds.length > 0 || state.pending > 0) {
    return {
      executionSafe: false,
      unsafeReason: 'execution has unresolved or pending broker work',
    };
  }
  try {
    await lease.assertHeld();
    const position = await broker.getPosition(binding.executionSymbol, signal);
    const account = await broker.getAccount(signal);
    assertFinalPosition(position, binding.executionSymbol);
    assertFinalAccount(account);
    return {
      executionSafe: true,
      finalPosition: deepFreeze(structuredClone(position)),
      finalAccount: deepFreeze(structuredClone(account)),
    };
  } catch (error) {
    return {
      executionSafe: false,
      unsafeReason: `final broker state is unavailable: ${errorMessage(error)}`,
    };
  }
}

function assertFinalPosition(position: Position, symbol: string): void {
  if (position.symbol !== symbol || !Number.isFinite(position.qty)) {
    throw new Error('broker returned an invalid final position');
  }
}

function assertFinalAccount(account: Account): void {
  if (
    !account.id ||
    !account.currency ||
    !Number.isFinite(account.balance) ||
    !Number.isFinite(account.equity)
  ) {
    throw new Error('broker returned an invalid final account');
  }
}

async function releaseRecordedLease(
  writer: SequencedLedger | undefined,
  lease: ExecutionLease,
  recorded: boolean,
): Promise<void> {
  const snapshot = lease.snapshot;
  if (!snapshot) return;
  const errors: unknown[] = [];
  if (recorded && writer) {
    try {
      await writer.append({
        recordType: 'lease',
        action: 'released',
        resource: snapshot.resource,
        leaseId: snapshot.leaseId,
        ownerId: snapshot.ownerId,
      });
      await writer.flush();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await lease.release();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'execution lease journal/release failed');
}

function validateRuntimeOptions(options: IntrabarServerOptions): void {
  const managed = isManagedOptions(options);
  const direct = !managed;
  if (managed) {
    if (typeof options.createData !== 'function')
      throw new Error('managed intrabar runtime requires createData');
  } else {
    if (typeof options.dataFactory !== 'function')
      throw new Error('direct intrabar runtime requires dataFactory');
    if (!options.ledger) throw new Error('direct intrabar runtime requires a sync ledger');
    if (options.recoveredEvents !== undefined && options.recoveredState !== undefined) {
      throw new Error('provide recoveredEvents or recoveredState, not both');
    }
  }

  const mirrored = options.prepared.config.execution.kind === 'mirrored';
  if (!mirrored) {
    for (const key of [
      'brokerFactory',
      'createBroker',
      'lease',
      'refreshRecoveryAfterLease',
    ] as const) {
      if (Object.prototype.hasOwnProperty.call(options, key)) {
        throw new Error(`compute-only intrabar options cannot contain ${key}`);
      }
    }
    return;
  }
  if (direct) {
    const directOptions = options as MirroredIntrabarServerOptions & DirectRuntimeOptions;
    if (typeof directOptions.brokerFactory !== 'function')
      throw new Error('direct mirrored intrabar runtime requires a lazy brokerFactory');
    if (!directOptions.lease)
      throw new Error('direct mirrored intrabar runtime requires an ExecutionLease');
    if (
      Object.prototype.hasOwnProperty.call(directOptions, 'refreshRecoveryAfterLease') &&
      typeof directOptions.refreshRecoveryAfterLease !== 'function'
    ) {
      throw new Error('direct recovery refresh must be a function');
    }
  } else {
    const managedOptions = options as MirroredIntrabarServerOptions & ManagedRuntimeOptions;
    if (typeof managedOptions.createBroker !== 'function')
      throw new Error('managed mirrored intrabar runtime requires createBroker');
  }
}

function isManagedOptions(
  options: IntrabarServerOptions,
): options is IntrabarServerOptions & ManagedRuntimeOptions {
  return 'persistence' in options && options.persistence !== undefined;
}

function assertNotAborted(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) throw new Error(`intrabar server start aborted ${stage}`);
}

async function boundedCleanup(
  operation: () => void | Promise<void>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const task = Promise.resolve().then(operation);
  void task.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} shutdown exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Public helper for tests/tools that need a stable comparison without constructing a broker. */
export async function intrabarBindingDigest(binding: RunInstrumentBinding): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 is unavailable in this runtime');
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalSerialize(binding)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type { LedgerEventV3, LeaseEventV3 };
