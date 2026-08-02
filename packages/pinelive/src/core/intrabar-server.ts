import { CompileError, compile, type CompiledScript } from '@heyphat/piner';
import {
  assertLiveSymbolMatchesConfig,
  barCloseTime,
  canonicalTimeframeToPineExact,
  parseCanonicalTimeframeExact,
  type MarketDataProvider,
  type ResolvedDataInstrument,
} from '@heyphat/pinery';
import { preflightCompiledBarMagnifier, type MagnifierPreflight } from '@heyphat/pinerun';
import { AlertDispatcher, type AlertChannel } from './alerts.js';
import {
  isProductionSafetyBroker,
  type AccountSynchronizationSession,
  type Broker,
  type CanonicalAccountIdentity,
  type ExecutionSafetyGuard,
  type ProductionSafetyBroker,
} from './broker.js';
import {
  createComputeInstrumentBinding,
  createRunInstrumentBinding,
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
  type NormalizedComputeOnlyRunConfig,
  type NormalizedMirroredExecutionConfig,
  type NormalizedMirroredRunConfig,
  type NormalizedRunConfig,
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
  type BreakerReasonV3,
  type ChartUpdateIdentityV3,
  type EffectiveRunPosture,
  type EvaluationSkipReasonV3,
  type ExecutionEligibilityState,
  type LedgerEventV3,
  type LedgerSink,
  type LeaseEventV3,
} from './ledger.js';
import { PositionMirror } from './mirror.js';
import { recoverLedger, type LedgerRecoveryState, type RecoveredBarCounters } from './recovery.js';
import {
  DEFAULT_DECISION_RETENTION_BARS,
  TargetScheduler,
  type ScheduledTargetResult,
  type TargetEvaluation,
} from './scheduler.js';
import type { Account, Position } from './types.js';
import { isMarkableBroker } from '../brokers/paper.js';

export interface PreparedIntrabarRun<C extends NormalizedRunConfig = NormalizedRunConfig> {
  readonly config: C;
  readonly source: string;
  readonly compiled: CompiledScript;
  readonly preflight: MagnifierPreflight;
}

export type PreparedComputeOnlyIntrabarRun = PreparedIntrabarRun<NormalizedComputeOnlyRunConfig>;
export type PreparedMirroredIntrabarRun = PreparedIntrabarRun<NormalizedMirroredRunConfig>;

const preparedRuns = new WeakSet<object>();

/**
 * Complete pure config gate. It reads no file, provider, profile, environment variable, SDK,
 * broker, account, ledger, or lease. Runtime factories are intentionally absent from this contract.
 */
export function prepareIntrabarRun(
  configValue: {
    readonly configVersion: 3;
    readonly execution: { readonly kind: 'compute-only' };
  },
  source: string,
): PreparedComputeOnlyIntrabarRun;
export function prepareIntrabarRun(
  configValue: {
    readonly configVersion: 3;
    readonly execution: { readonly kind: 'mirrored' };
  },
  source: string,
): PreparedMirroredIntrabarRun;
export function prepareIntrabarRun(configValue: unknown, source: string): PreparedIntrabarRun;
export function prepareIntrabarRun(configValue: unknown, source: string): PreparedIntrabarRun {
  const config = normalizeRunConfig(configValue);
  if (config.configVersion !== 3) throw new Error('prepareIntrabarRun requires configVersion 3');
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
      'startup reconciliation is unavailable; execution requires a new authoritative final',
    );
  }

  const parsed = parseCanonicalTimeframeExact(config.timeframe);
  if (parsed.kind !== 'ok' || parsed.value.domain !== 'fixed') {
    throw new Error(
      parsed.kind === 'ok' ? 'live chart timeframe must have a fixed duration' : parsed.message,
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
  }) as NormalizedRunConfig;
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

export interface AccountInstrumentClaimFactoryContext {
  readonly identity: CanonicalAccountIdentity;
  readonly executionSymbol: string;
  readonly authority: PreparedIntrabarAuthorityEnvelope;
  /** Must bind the specific account claim to the already-acquired execution-lease owner. */
  readonly ownerId: string;
  readonly signal?: AbortSignal;
}

/** Same-host cooperative claim factory. Implementations must never steal an existing claim. */
export type AccountInstrumentClaimFactory = (
  context: AccountInstrumentClaimFactoryContext,
) => ExecutionLease | Promise<ExecutionLease>;

interface IntrabarServerCallbacks {
  readonly signal?: AbortSignal;
  readonly teardownTimeoutMs?: number;
  /** Invoked only after this evaluation has a durable schema-v3 row. */
  readonly onEvaluation?: (evaluation: IntrabarEvaluation) => void | Promise<void>;
  readonly onLog?: (message: string) => void;
  /**
   * Constructed notification channels for `config.alerts`. The config carries
   * channel SPECS; hosts construct transports (the CLI builds the webhook
   * kind). Fail-closed: a config that declares channels but reaches the
   * runtime without them refuses to start.
   */
  readonly alertChannels?: readonly AlertChannel[];
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
  readonly lease?: never;
};

export type MirroredIntrabarServerOptions =
  | (DirectRuntimeOptions & {
      readonly prepared: PreparedMirroredIntrabarRun;
      readonly brokerFactory: IntrabarBrokerFactory;
      /** Required for armed Tiger; ignored for Paper and unarmed monitor posture. */
      readonly accountClaimFactory?: AccountInstrumentClaimFactory;
      readonly lease: ExecutionLease;
      /**
       * Refresh durable recovery while the direct lease is held. File-backed callers should
       * provide this to close the read-to-acquire handoff race before sequence allocation.
       */
      readonly refreshRecoveryAfterLease?: () =>
        IntrabarPersistenceRead | Promise<IntrabarPersistenceRead>;
      /**
       * Releases the startup/recovery mutex only after physical execution ownership has a durable
       * matching lease event. File-backed hosts should pair this with refreshRecoveryAfterLease.
       */
      readonly releaseAdministrativeLeaseAfterOwnershipRecorded?: () => void | Promise<void>;
    })
  | (ManagedRuntimeOptions & {
      readonly prepared: PreparedMirroredIntrabarRun;
      readonly brokerFactory: IntrabarBrokerFactory;
      readonly accountClaimFactory?: AccountInstrumentClaimFactory;
      readonly lease?: never;
      readonly refreshRecoveryAfterLease?: never;
      readonly releaseAdministrativeLeaseAfterOwnershipRecorded?: never;
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

export type MirroredIntrabarServerResult = IntrabarServerResultBase & {
  readonly mode: 'mirrored';
  readonly posture: Exclude<EffectiveRunPosture, 'compute-only'>;
  readonly executionEligibility: ExecutionEligibilityState;
  readonly eligibilityReasons: readonly string[];
} & (
    | {
        readonly executionSafe: true;
        readonly finalPosition: Readonly<Position>;
        readonly finalAccount: Readonly<Account>;
        readonly unsafeReason?: never;
      }
    | {
        readonly executionSafe: false;
        readonly unsafeReason: string;
        readonly finalPosition?: never;
        readonly finalAccount?: never;
      }
  );

export type IntrabarServerResult = ComputeOnlyIntrabarServerResult | MirroredIntrabarServerResult;

/**
 * Finite-history + live runtime. No branch calls flatten. Exact preparation and authority
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
  const alertChannels = options.alertChannels ?? [];
  if ((config.alerts?.channels.length ?? 0) > 0 && alertChannels.length === 0)
    throw new Error(
      'config.alerts declares channels but no alert channels were supplied to the runtime',
    );
  const alertDispatcher =
    alertChannels.length > 0
      ? new AlertDispatcher({
          channels: alertChannels,
          frequency: config.alerts?.frequency,
          sendTimeoutMs: config.alerts?.sendTimeoutMs,
          maxPerBar: config.alerts?.maxPerBar,
          onError: (channel, alert, reason) =>
            options.onLog?.(
              `alert delivery failed on ${channel} for bar ${alert.barTime}: ${reason}`,
            ),
        })
      : undefined;
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
  const releaseAdministrativeLeaseAfterOwnershipRecorded =
    !managed && mirrored
      ? (
          options as DirectRuntimeOptions & {
            readonly releaseAdministrativeLeaseAfterOwnershipRecorded?: () => void | Promise<void>;
          }
        ).releaseAdministrativeLeaseAfterOwnershipRecorded
      : undefined;

  let data: MarketDataProvider | undefined;
  let runner: IntrabarRunner | undefined;
  let lease: ExecutionLease | undefined;
  let leaseRecorded = false;
  let leaseAcquisitionRecordUncertain = false;
  let rawSink: LedgerSink | undefined;
  let writer: SequencedLedger | undefined;
  let broker: Broker | undefined;
  let productionBroker: ProductionSafetyBroker | undefined;
  let synchronizationSession: AccountSynchronizationSession | undefined;
  let accountClaim: ExecutionLease | undefined;
  let accountClaimRecorded = false;
  let accountClaimAcquisitionRecordUncertain = false;
  let executionSafetyGuard: ExecutionSafetyGuard | undefined;
  let scheduler: TargetScheduler | undefined;
  let computeJournal: ComputeDecisionJournal | undefined;
  let executionEnabled = false;
  const posture: Exclude<EffectiveRunPosture, 'compute-only'> =
    mirrored && config.execution.broker.id === 'tiger' && !config.execution.armed
      ? 'monitor'
      : 'live';
  let executionEligibility: ExecutionEligibilityState = mirrored ? 'blocked' : 'enabled';
  let eligibilityReasons: string[] = [];
  let eligibilityRecorded = false;
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
        } else if (!executionEnabled) {
          const detail = eligibilityReasons.join('; ') || 'broker execution is not enabled';
          if (scheduler) {
            scheduled = await scheduler.journalSkipped(target, 'execution-ineligible', detail);
          } else {
            await computeJournal!.journal(target, 'execution-ineligible', detail);
          }
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
        if (scheduled?.status === 'skipped' && scheduled.reason === 'target-limit') {
          options.onLog?.(
            `decision ${evaluation.decisionId} was refused by the per-bar target limit` +
              (evaluation.finalCommit ? '; the execution breaker is now latched' : ''),
          );
        }
        // Alert delivery: fresh authoritative finals only (the mirror gate's
        // sibling), after the decision row is durable. Fail-open by contract —
        // only the durable alert row's append may propagate.
        if (
          alertDispatcher &&
          evaluation.finalCommit &&
          evaluation.reason === 'eligible' &&
          evaluation.alerts.length > 0
        ) {
          const reports = await alertDispatcher.process({
            runId: writer!.runId,
            strategyId: config.strategy,
            strategySymbol: currentBinding.strategySymbol,
            timeframe: config.timeframe,
            barTime: evaluation.update.barTime,
            barCloseMs: barCloseTime(evaluation.update.barTime, config.timeframe) * 1000,
            price: evaluation.bar.close,
            closed: true,
            messages: evaluation.alerts,
          });
          for (const report of reports) {
            await writer!.append({
              recordType: 'alert',
              decisionId: evaluation.decisionId,
              strategyId: config.strategy,
              strategySymbol: currentBinding.strategySymbol,
              executionSymbol: currentBinding.executionSymbol,
              bindingId: currentBinding.id,
              timeframe: config.timeframe,
              barTime: report.alert.barTime,
              ordinal: report.alert.ordinal,
              message: report.alert.message,
              source: report.alert.source,
              price: report.alert.price,
              firedAt: report.alert.firedAt,
              deliveries: [...report.deliveries],
            });
          }
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
      recovery = recoverRuntime(firstRead.records);
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
      recovery = recoverRuntime(ownedRead.records);
      recoveredMaterial = recoveryMaterialCount(ownedRead);
      await assertRecoveredAuthority(recovery, historicalBinding.authority, recoveredMaterial > 0);
      assertRecoveryCanBind(recovery);
      if (!leaseSnapshot)
        throw new Error('managed intrabar persistence requires an acquired lease');
      assertRecoveredLease(recovery, leaseSnapshot);
      rawSink = await options.persistence.createLedger(lease!, ownedRead);
    } else if (mirrored && refreshRecoveryAfterLease) {
      ownedRead = await refreshRecoveryAfterLease();
      recovery = recoverRuntime(ownedRead.records);
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
        leaseAcquisitionRecordUncertain = true;
        await writer.append({
          recordType: 'lease',
          action: 'acquired',
          resource: leaseSnapshot.resource,
          leaseId: leaseSnapshot.leaseId,
          ownerId: leaseSnapshot.ownerId,
        });
        leaseAcquisitionRecordUncertain = false;
      }
      leaseRecorded = true;
      if (releaseAdministrativeLeaseAfterOwnershipRecorded) {
        // Stable storage must prove the exact physical owner before the administrative mutex can
        // be handed off. A crash earlier leaves both same-owner artifacts for explicit recovery.
        await writer.flush();
        await releaseAdministrativeLeaseAfterOwnershipRecorded();
      }
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
      binding = await createComputeInstrumentBinding(data, resolved, historicalBinding.authority);
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
      const brokerFactory = (options as MirroredIntrabarServerOptions).brokerFactory;
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
      binding = await createRunInstrumentBinding(
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

      const ensureScheduler = async (): Promise<TargetScheduler> => {
        if (scheduler) return scheduler;
        const runtimeMirror = new PositionMirror(broker!, instrument, {
          transientRetries: 0,
          orderType: config.execution.kind === 'mirrored' ? config.execution.order.type : 'market',
          ...(config.execution.kind === 'mirrored' && config.execution.order.type === 'limit'
            ? { limitOffsetTicks: config.execution.order.limitOffsetTicks }
            : {}),
        });
        scheduler = new TargetScheduler({
          mirror: runtimeMirror,
          ledger: writer!,
          runId: namespace.runId,
          executionId: namespace.executionId,
          binding: binding!,
          recovery,
          lease,
          executionSafetyGuard,
          leaseAlreadyRecorded: true,
          limits: schedulerLimits(),
        });
        await scheduler.initialize();
        return scheduler;
      };

      if (broker.id === 'tiger') {
        if (posture === 'monitor') {
          executionEligibility = 'disabled-by-posture';
          eligibilityReasons = [
            'Tiger execution is not armed; running broker-connected monitor posture',
          ];
        } else if (!isProductionSafetyBroker(broker)) {
          executionEligibility = 'blocked';
          eligibilityReasons = [
            'Tiger broker does not implement the production synchronization contract',
          ];
        } else {
          productionBroker = broker;
          const accountClaimFactory = (options as MirroredIntrabarServerOptions)
            .accountClaimFactory;
          if (!accountClaimFactory) {
            eligibilityReasons.push('armed Tiger requires an account/instrument claim factory');
          } else {
            const identity = await productionBroker.getCanonicalAccountIdentity(options.signal);
            const claim = await accountClaimFactory({
              identity,
              executionSymbol: binding.executionSymbol,
              authority: historicalBinding.authority,
              ownerId: leaseSnapshot!.ownerId,
              signal: options.signal,
            });
            accountClaim = claim;
            try {
              const claimSnapshot = await claim.acquire();
              assertAccountClaimSnapshot(claimSnapshot, leaseSnapshot!.ownerId);
              accountClaimAcquisitionRecordUncertain = true;
              await writer.append({
                recordType: 'account-claim',
                action: 'acquired',
                resourceDigest: claimSnapshot.resource,
                claimId: claimSnapshot.leaseId,
                ownerId: claimSnapshot.ownerId,
              });
              accountClaimAcquisitionRecordUncertain = false;
              accountClaimRecorded = true;
            } catch (error) {
              eligibilityReasons.push(
                `account/instrument claim unavailable: ${errorMessage(error)}`,
              );
            }
          }

          if (accountClaimRecorded) {
            const synchronization = await productionBroker.synchronizeAccount(
              binding.executionSymbol,
              options.signal,
            );
            if (synchronization.status === 'blocked') {
              eligibilityReasons.push(...synchronization.reasons);
            } else {
              synchronizationSession = synchronization.session;
              executionSafetyGuard = createExecutionSafetyGuard(
                lease,
                accountClaim!,
                synchronization.session,
              );
              const openOrderCount = synchronization.session.snapshot.openOrders.length;
              if (openOrderCount > 0) {
                eligibilityReasons.push(
                  `synchronized account has ${openOrderCount} working or uncertain order(s)`,
                );
              }

              const recoveredUnresolvedIds = [...recovery.unresolvedIntents.keys()].sort();
              const resumedReconciliationPosition =
                recoveredUnresolvedIds.length === 0
                  ? venueReconciliationResumePosition(recovery)
                  : undefined;
              let resumedReconciliationPositionMatches = false;
              if (resumedReconciliationPosition !== undefined) {
                if (
                  synchronization.session.snapshot.position.qty === resumedReconciliationPosition
                ) {
                  resumedReconciliationPositionMatches = true;
                  await ensureScheduler();
                } else {
                  eligibilityReasons.push(
                    'synchronized position does not match the durable terminal reconciliation',
                  );
                }
              }

              if (openOrderCount === 0 && recoveredUnresolvedIds.length > 0) {
                const recoveryScheduler = await ensureScheduler();
                for (const logicalOrderId of recoveredUnresolvedIds) {
                  try {
                    await executionSafetyGuard.assertExecutionSafe(options.signal);
                    const resolution = await recoveryScheduler.resolveUnknownSubmission(
                      logicalOrderId,
                      options.signal,
                    );
                    await executionSafetyGuard.assertExecutionSafe(options.signal);
                    if (!resolution.resolved) {
                      eligibilityReasons.push(
                        `durable order ${logicalOrderId} remains unresolved (exact lookup: ${resolution.status})`,
                      );
                    }
                  } catch (error) {
                    eligibilityReasons.push(
                      `durable order ${logicalOrderId} reconciliation failed: ${errorMessage(error)}`,
                    );
                  }
                }
              }

              const reconciledState = scheduler?.state;
              if (
                openOrderCount === 0 &&
                reconciledState?.unresolvedLogicalOrderIds.length === 0 &&
                reconciledState.breaker.latched &&
                isVenueReconciliableBreaker(reconciledState.breaker.reason) &&
                (recoveredUnresolvedIds.length > 0 || resumedReconciliationPositionMatches)
              ) {
                await executionSafetyGuard.assertExecutionSafe(options.signal);
                await scheduler!.resetBreaker(
                  resumedReconciliationPositionMatches
                    ? 'resumed authoritative synchronized startup reconciliation'
                    : 'authoritative synchronized startup reconciliation',
                  'venue-reconciled',
                );
                await executionSafetyGuard.assertExecutionSafe(options.signal);
              }

              const safetyState = scheduler?.state;
              const unresolvedAfter =
                safetyState?.unresolvedLogicalOrderIds ?? recoveredUnresolvedIds;
              if (unresolvedAfter.length > 0 && eligibilityReasons.length === 0) {
                eligibilityReasons.push(
                  `durable ledger has ${unresolvedAfter.length} unresolved broker effect(s)`,
                );
              }
              if (
                synchronization.session.snapshot.position.qty !== 0 &&
                recoveredUnresolvedIds.length === 0 &&
                !resumedReconciliationPositionMatches
              ) {
                eligibilityReasons.push('synchronized account has a non-zero unexplained position');
              }
              const breaker = safetyState?.breaker ?? recovery.breaker;
              if (breaker.latched) {
                eligibilityReasons.push(
                  `durable execution breaker is latched${breaker.reason ? `: ${breaker.reason}` : ''}`,
                );
              }
              if (eligibilityReasons.length === 0) {
                productionBroker.setExecutionSafetyGuard(executionSafetyGuard);
                executionEnabled = true;
                executionEligibility = 'enabled';
              }
            }
          }
          if (!executionEnabled) executionEligibility = 'blocked';
        }
      } else {
        executionEnabled = true;
        executionEligibility = 'enabled';
      }

      if (executionEnabled) {
        await ensureScheduler();
      } else if (!scheduler) {
        computeJournal = new ComputeDecisionJournal({
          writer,
          lease,
          leaseRecorded,
          recovery,
          binding,
          strategyId: config.strategy,
        });
        await computeJournal.initialize();
      }

      await writer.append({
        recordType: 'execution-eligibility',
        posture,
        state: executionEligibility,
        reasons: [...eligibilityReasons],
        accountClaim:
          broker.id === 'tiger' && posture === 'live'
            ? accountClaimRecorded
              ? 'held'
              : 'not-held'
            : 'not-applicable',
        synchronization:
          broker.id === 'tiger' && posture === 'live'
            ? synchronizationSession
              ? 'synchronized'
              : 'blocked'
            : 'not-applicable',
      });
      eligibilityRecorded = true;
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
    } else if (!executionEnabled) {
      const unsafeReason = eligibilityReasons.join('; ') || 'broker execution is not enabled';
      result = deepFreeze({
        mode: 'mirrored' as const,
        ...commonResult,
        posture,
        executionEligibility,
        eligibilityReasons: [...eligibilityReasons],
        executionSafe: false as const,
        unsafeReason,
      });
    } else {
      const finalState = await finalBrokerState(
        scheduler!,
        lease!,
        broker!,
        binding,
        executionSafetyGuard,
        options.signal,
      );
      result = deepFreeze({
        mode: 'mirrored' as const,
        ...commonResult,
        posture,
        executionEligibility,
        eligibilityReasons: [...eligibilityReasons],
        ...finalState,
      });
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
  if (alertDispatcher) await cleanup(() => alertDispatcher.close());
  if (writer) await cleanup(() => writer!.flush());

  // Revoke mutation capability before stream or ownership teardown.
  if (productionBroker) productionBroker.clearExecutionSafetyGuard();
  if (synchronizationSession)
    await cleanup(() =>
      boundedCleanup(
        () => synchronizationSession!.close(),
        teardownTimeoutMs,
        'account synchronization',
      ),
    );
  if (writer && eligibilityRecorded && executionEnabled) {
    await cleanup(async () => {
      await writer!.append({
        recordType: 'execution-eligibility',
        posture,
        state: 'blocked',
        reasons: ['runtime stopped and execution capability was revoked'],
        accountClaim: broker?.id === 'tiger' && accountClaim?.snapshot ? 'held' : 'not-applicable',
        synchronization: broker?.id === 'tiger' ? 'blocked' : 'not-applicable',
      });
      await writer!.flush();
    });
  }
  let accountClaimReleaseFailed = false;
  if (accountClaim?.snapshot && !accountClaimAcquisitionRecordUncertain) {
    try {
      await releaseRecordedAccountClaim(writer, accountClaim, accountClaimRecorded);
      accountClaimRecorded = false;
    } catch (error) {
      accountClaimReleaseFailed = true;
      cleanupErrors.push(error);
    }
  }

  const accountClaimStillHeld =
    accountClaimAcquisitionRecordUncertain ||
    accountClaimReleaseFailed ||
    accountClaim?.snapshot != null;
  if (!accountClaimStillHeld && !leaseAcquisitionRecordUncertain && scheduler && lease?.snapshot) {
    await cleanup(() => scheduler!.releaseLease());
    leaseRecorded = false;
  } else if (
    !accountClaimStillHeld &&
    !leaseAcquisitionRecordUncertain &&
    computeJournal &&
    lease?.snapshot
  ) {
    await cleanup(() => computeJournal!.releaseLease());
    leaseRecorded = false;
  } else if (!accountClaimStillHeld && !leaseAcquisitionRecordUncertain && lease?.snapshot) {
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

export interface ComputeDecisionJournalOptions {
  readonly writer: SequencedLedger;
  readonly lease?: ExecutionLease;
  readonly leaseRecorded: boolean;
  readonly recovery: LedgerRecoveryState;
  readonly binding: RunInstrumentBinding;
  readonly strategyId: string;
  readonly retainBars?: number;
}

/** Internal compute-only durable dedupe journal; exported from this module for focused tests. */
export class ComputeDecisionJournal {
  readonly perBar = new Map<string, RecoveredBarCounters>();
  readonly decisionIds = new Set<string>();
  initialized = false;
  private readonly writer: SequencedLedger;
  private readonly lease?: ExecutionLease;
  private readonly binding: RunInstrumentBinding;
  private readonly strategyId: string;
  private readonly retainBars: number;
  private readonly recoveryLastSequence: number;
  private readonly recoveryLastFinalCursor?: LedgerRecoveryState['lastFinalCursor'];
  private readonly recoveryUnresolvedLogicalOrderIds: string[];
  private readonly recoveryBindingRecorded: boolean;
  private leaseRecorded: boolean;
  /** Bounded retention (in-memory only; the durable ledger is never pruned). */
  private readonly barDecisions = new Map<string, Set<string>>();
  private readonly barTimes: number[] = [];
  private prunedThroughBarTime?: number;

  constructor(options: ComputeDecisionJournalOptions) {
    this.writer = options.writer;
    this.lease = options.lease;
    this.binding = options.binding;
    this.strategyId = options.strategyId;
    this.retainBars = options.retainBars ?? DEFAULT_DECISION_RETENTION_BARS;
    if (!Number.isSafeInteger(this.retainBars) || this.retainBars <= 0)
      throw new RangeError('compute journal retainBars must be a positive safe integer');
    this.leaseRecorded = options.leaseRecorded;
    this.recoveryLastSequence = options.recovery.lastSequence;
    this.recoveryLastFinalCursor = options.recovery.lastFinalCursor;
    this.recoveryUnresolvedLogicalOrderIds = [...options.recovery.unresolvedIntents.keys()].sort();
    this.recoveryBindingRecorded = options.recovery.binding != null;

    for (const [key, value] of options.recovery.perBar) this.perBar.set(key, { ...value });
    for (const [decisionId, decision] of options.recovery.decisions) {
      const identity = decision.accepted ?? decision.skipped[0];
      if (!identity) continue;
      if (identity.bindingId !== this.binding.id)
        throw new Error('recovered compute decision does not match the active binding');
      this.decisionIds.add(decisionId);
      this.indexDecision(identity.barTime, decisionId);
    }
    this.prune();
    for (const key of this.perBar.keys()) {
      if (!this.barDecisions.has(key)) this.perBar.delete(key);
    }
  }

  get state(): { retainedDecisions: number; retainedBars: number; prunedThroughBarTime?: number } {
    return {
      retainedDecisions: this.decisionIds.size,
      retainedBars: this.barDecisions.size,
      ...(this.prunedThroughBarTime == null
        ? {}
        : { prunedThroughBarTime: this.prunedThroughBarTime }),
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const { writer, lease } = this;
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
      sourceLastSequence: this.recoveryLastSequence,
      ...(this.recoveryLastFinalCursor == null
        ? {}
        : { lastFinalCursor: this.recoveryLastFinalCursor }),
      unresolvedLogicalOrderIds: this.recoveryUnresolvedLogicalOrderIds,
    });
    if (!this.recoveryBindingRecorded)
      await writer.append({ recordType: 'binding', binding: this.binding });
    this.initialized = true;
  }

  async journal(
    evaluation: TargetEvaluation,
    reason: EvaluationSkipReasonV3,
    detail?: string,
  ): Promise<void> {
    if (!this.initialized) throw new Error('compute journal is not initialized');
    const decisionId = evaluation.decisionId!;
    if (this.decisionIds.has(decisionId)) return;
    const barTime = evaluation.context.barTime;
    if (this.prunedThroughBarTime != null && barTime <= this.prunedThroughBarTime)
      throw new RangeError('compute decision predates the retained dedupe horizon');
    const key = `${this.binding.id}:${barTime}`;
    const counter = this.perBar.get(key) ?? { targets: 0, intents: 0 };
    this.perBar.set(key, counter);
    await this.writer.append({
      recordType: 'evaluation.skipped',
      ...decisionFields(evaluation, this.strategyId),
      reason,
      targetOrdinal: counter.targets + 1,
      ...(detail ? { detail } : {}),
    });
    counter.targets++;
    this.decisionIds.add(decisionId);
    this.indexDecision(barTime, decisionId);
    if (evaluation.update?.authoritativeFinal) this.prune();
  }

  private indexDecision(barTime: number, decisionId: string): void {
    const key = `${this.binding.id}:${barTime}`;
    let owned = this.barDecisions.get(key);
    if (!owned) {
      owned = new Set();
      this.barDecisions.set(key, owned);
      if (this.barTimes.length === 0 || barTime > this.barTimes[this.barTimes.length - 1]!)
        this.barTimes.push(barTime);
      else if (!this.barTimes.includes(barTime)) {
        this.barTimes.push(barTime);
        this.barTimes.sort((left, right) => left - right);
      }
    }
    owned.add(decisionId);
  }

  private prune(): void {
    while (this.barTimes.length > this.retainBars) {
      const oldest = this.barTimes.shift()!;
      const key = `${this.binding.id}:${oldest}`;
      for (const decisionId of this.barDecisions.get(key) ?? [])
        this.decisionIds.delete(decisionId);
      this.barDecisions.delete(key);
      this.perBar.delete(key);
      this.prunedThroughBarTime = Math.max(this.prunedThroughBarTime ?? oldest, oldest);
    }
  }

  async stop(): Promise<void> {
    await this.writer.flush();
  }

  async releaseLease(): Promise<void> {
    const lease = this.lease;
    if (!lease?.snapshot) return;
    try {
      await releaseRecordedLease(this.writer, lease, this.leaseRecorded);
    } finally {
      this.leaseRecorded = false;
    }
  }
}

function toTargetEvaluation(
  evaluation: IntrabarEvaluation,
  binding: RunInstrumentBinding,
  config: NormalizedRunConfig,
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

function recoverRuntime(records: readonly unknown[]): LedgerRecoveryState {
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
  return { state: recoverRuntime(records), materialCount: records.length };
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
    throw new Error('recovered authority event does not match the binding authority extension');
  }
  const recovered = dedicated ?? extended;
  if (!recovered) {
    if (required) throw new Error('recovered run is missing prepared authority');
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
    throw new Error('recovered schema-v3 binding is not a strong execution binding');
  }
  if (canonicalSerialize(recovered) !== canonicalSerialize(current)) {
    throw new Error('current execution binding does not match recovered schema-v3 binding');
  }
}

function configureRunnerRecovery(runner: IntrabarRunner, recovery: LedgerRecoveryState): void {
  const cursor = recovery.lastFinalCursor;
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || typeof cursor !== 'number')) {
    throw new Error('intrabar recovery requires a numeric authoritative-final cursor');
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
  config: NormalizedRunConfig,
  authority: PreparedIntrabarAuthorityEnvelope,
  recovery: LedgerRecoveryState,
  supplied: LedgerSink | SequencedLedger | undefined,
): { readonly runId: string; readonly executionId: string } {
  const suppliedWriter = supplied instanceof SequencedLedger ? supplied : undefined;
  const brokerClass =
    config.execution.kind === 'mirrored' ? config.execution.broker.id : 'compute-only';
  return {
    runId: recovery.runId ?? suppliedWriter?.runId ?? `pinelive:${authority.identity}`,
    executionId:
      recovery.executionId ??
      suppliedWriter?.executionId ??
      (config.execution.kind === 'mirrored' ? config.execution.executionId : undefined) ??
      `pinelive:${config.strategy}:${config.symbol}:${brokerClass}`,
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
  executionSafetyGuard?: ExecutionSafetyGuard,
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
    await executionSafetyGuard?.assertExecutionSafe(signal);
    const position = await broker.getPosition(binding.executionSymbol, signal);
    const account = await broker.getAccount(signal);
    assertFinalPosition(position, binding.executionSymbol);
    assertFinalAccount(account);
    await executionSafetyGuard?.assertExecutionSafe(signal);
    await lease.assertHeld();
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

function assertAccountClaimSnapshot(
  snapshot: ExecutionLeaseSnapshot,
  executionLeaseOwnerId: string,
): void {
  if (
    !/^sha256-[a-f0-9]{64}$/.test(snapshot.resource) ||
    !snapshot.leaseId ||
    !snapshot.ownerId ||
    snapshot.ownerId !== executionLeaseOwnerId
  ) {
    throw new Error(
      'account/instrument claim returned an invalid or mismatched opaque owner identity',
    );
  }
}

function venueReconciliationResumePosition(recovery: LedgerRecoveryState): number | undefined {
  const breaker = recovery.breaker.event;
  if (
    !breaker ||
    !recovery.breaker.latched ||
    !isVenueReconciliableBreaker(breaker.reason) ||
    recovery.unresolvedIntents.size > 0
  ) {
    return undefined;
  }

  for (let index = recovery.events.length - 1; index >= 0; index--) {
    const completion = recovery.events[index]!;
    if (
      completion.recordType !== 'order.completion' ||
      completion.sequence <= breaker.sequence ||
      (completion.outcome !== 'filled' && completion.outcome !== 'rejected') ||
      completion.actualAfter == null ||
      !Number.isFinite(completion.actualAfter)
    ) {
      continue;
    }
    const terminalResolution = recovery.events.some(
      (event) =>
        event.recordType === 'order.resolution' &&
        event.sequence > breaker.sequence &&
        event.sequence < completion.sequence &&
        event.logicalOrderId === completion.logicalOrderId &&
        event.outcome === completion.outcome,
    );
    if (terminalResolution) return completion.actualAfter;
  }
  return undefined;
}

function isVenueReconciliableBreaker(reason: BreakerReasonV3 | undefined): boolean {
  return (
    reason === 'submission-unknown' ||
    reason === 'recovery-unresolved' ||
    reason === 'ledger-failure'
  );
}

function createExecutionSafetyGuard(
  lease: ExecutionLease,
  accountClaim: ExecutionLease,
  synchronization: AccountSynchronizationSession,
): ExecutionSafetyGuard {
  return {
    async assertExecutionSafe(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) throw new Error('execution safety assertion was aborted');
      await lease.assertHeld();
      await accountClaim.assertHeld();
      await synchronization.assertSynchronized(signal);
      await synchronization.assertSafeToExecute(signal);
      if (signal?.aborted) throw new Error('execution safety assertion was aborted');
    },
  };
}

async function releaseRecordedAccountClaim(
  writer: SequencedLedger | undefined,
  claim: ExecutionLease,
  recorded: boolean,
): Promise<void> {
  const snapshot = claim.snapshot;
  if (!snapshot) return;
  if (recorded && writer) {
    await writer.append({
      recordType: 'account-claim',
      action: 'release-started',
      resourceDigest: snapshot.resource,
      claimId: snapshot.leaseId,
      ownerId: snapshot.ownerId,
      detail: 'physical account/instrument claim release is starting',
    });
    await writer.flush();
  }

  await claim.release();

  if (recorded && writer) {
    await writer.append({
      recordType: 'account-claim',
      action: 'released',
      resourceDigest: snapshot.resource,
      claimId: snapshot.leaseId,
      ownerId: snapshot.ownerId,
      detail: 'physical account/instrument claim release completed',
    });
    await writer.flush();
  }
}

async function releaseRecordedLease(
  writer: SequencedLedger | undefined,
  lease: ExecutionLease,
  recorded: boolean,
): Promise<void> {
  const snapshot = lease.snapshot;
  if (!snapshot) return;
  if (recorded && writer) {
    await writer.append({
      recordType: 'lease',
      action: 'released',
      resource: snapshot.resource,
      leaseId: snapshot.leaseId,
      ownerId: snapshot.ownerId,
    });
    await writer.flush();
  }
  await lease.release();
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
      'lease',
      'accountClaimFactory',
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
    if (typeof managedOptions.brokerFactory !== 'function')
      throw new Error('managed mirrored intrabar runtime requires brokerFactory');
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
