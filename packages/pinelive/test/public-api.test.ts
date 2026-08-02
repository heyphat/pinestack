import { expect, test } from 'bun:test';
import * as intrabarApi from '@heyphat/pinelive/intrabar';
import {
  CircuitBreaker,
  IntrabarRunner,
  IntrabarState,
  TargetScheduler,
  normalizeRunConfig,
  prepareIntrabarRun,
  recoverLedger,
  runIntrabarServer,
  validateCompiledIntrabarConfig,
  type ComputeOnlyIntrabarServerOptions,
  type ComputeOnlyIntrabarServerResult,
  type ExecutionLease,
  type IntrabarBrokerFactory,
  type IntrabarBrokerFactoryContext,
  type LedgerRecoveryState,
  type MirroredIntrabarServerOptions,
  type MirroredIntrabarServerResult,
  type NormalizedBarCloseMirroredExecutionConfig,
  type NormalizedBarMagnifierHistoricalConfig,
  type NormalizedEveryUpdateCadenceMirroredExecutionConfig,
  type NormalizedExecutionSchedulerConfig,
  type NormalizedLiveSourceConfig,
  type NormalizedPaperBrokerConfig,
  type NormalizedTigerBrokerConfig,
  type PreparedComputeOnlyIntrabarRun,
  type PreparedIntrabarAuthorityEnvelope,
  type PreparedMirroredIntrabarRun,
  type RunInstrumentBinding,
  type SchedulerLimits,
} from '@heyphat/pinelive';
import {
  FileExecutionLease,
  JsonlLedger,
  NodeAccountInstrumentClaim,
  NodeIntrabarPersistence,
  parseJsonlPrefix,
  readJsonl,
  readJsonlPrefix,
  readPineliveStatus,
  recoverStalePineliveClaims,
} from '@heyphat/pinelive/node';

type RequiredPublicContracts = readonly [
  NormalizedBarMagnifierHistoricalConfig,
  NormalizedLiveSourceConfig,
  NormalizedPaperBrokerConfig,
  NormalizedTigerBrokerConfig,
  NormalizedExecutionSchedulerConfig,
  NormalizedBarCloseMirroredExecutionConfig,
  NormalizedEveryUpdateCadenceMirroredExecutionConfig,
  PreparedComputeOnlyIntrabarRun,
  PreparedMirroredIntrabarRun,
  PreparedIntrabarAuthorityEnvelope,
  RunInstrumentBinding,
  IntrabarBrokerFactoryContext,
  IntrabarBrokerFactory,
  ComputeOnlyIntrabarServerOptions,
  MirroredIntrabarServerOptions,
  ComputeOnlyIntrabarServerResult,
  MirroredIntrabarServerResult,
  SchedulerLimits,
  LedgerRecoveryState,
  ExecutionLease,
];

const contractsCompile: RequiredPublicContracts | undefined = undefined;

test('browser-safe and Node entry points expose the production API', () => {
  expect(contractsCompile).toBeUndefined();
  expect(typeof normalizeRunConfig).toBe('function');
  expect(typeof validateCompiledIntrabarConfig).toBe('function');
  expect(typeof prepareIntrabarRun).toBe('function');
  expect(typeof runIntrabarServer).toBe('function');
  expect(typeof IntrabarRunner).toBe('function');
  expect(typeof IntrabarState).toBe('function');
  expect(typeof TargetScheduler).toBe('function');
  expect(typeof CircuitBreaker).toBe('function');
  expect(typeof recoverLedger).toBe('function');
  expect(intrabarApi).not.toHaveProperty('ComputeDecisionJournal');

  expect(typeof JsonlLedger).toBe('function');
  expect(typeof NodeIntrabarPersistence).toBe('function');
  expect(typeof FileExecutionLease).toBe('function');
  expect(typeof NodeAccountInstrumentClaim).toBe('function');
  expect(typeof readPineliveStatus).toBe('function');
  expect(typeof recoverStalePineliveClaims).toBe('function');
  expect(typeof readJsonl).toBe('function');
  expect(typeof readJsonlPrefix).toBe('function');
  expect(parseJsonlPrefix).toBe(readJsonlPrefix);
});

const publicEveryUpdateSource = `//@version=6
strategy("public", calc_on_every_tick=true, process_orders_on_close=true)
plot(strategy.position_size)`;
const publicData = {
  provider: 'csv',
  dataDir: '/path/must/not/be-read',
  cutoverTime: 1,
} as const;
const publicEveryUpdate = {
  cadence: 'every-update',
  source: { kind: 'native' },
} as const;

function publicConfig(execution: Readonly<Record<string, unknown>>) {
  return {
    configVersion: 3,
    strategy: 'public.pine',
    symbol: 'X',
    timeframe: '1m',
    data: publicData,
    live: publicEveryUpdate,
    execution,
  } as const;
}

test('public preparation unadvertises Paper every-update effects but keeps supported modes', () => {
  const lifecycleMessage =
    'Paper mirrorOn "every-update" is unavailable because the public piner runtime does not expose a provable pending-order/fill lifecycle';
  const unsupported = publicConfig({
    kind: 'mirrored',
    mirrorOn: 'every-update',
    broker: { id: 'paper' },
    intrabarExecutionArmed: true,
    ledger: { path: '/unused/public.jsonl', durability: 'sync' },
    lease: { path: '/unused/public.lock' },
  });

  expect(() => normalizeRunConfig(unsupported)).toThrow(lifecycleMessage);
  expect(() => prepareIntrabarRun(unsupported, publicEveryUpdateSource)).toThrow(lifecycleMessage);

  const compute = prepareIntrabarRun(
    publicConfig({ kind: 'compute-only' }),
    publicEveryUpdateSource,
  );
  expect(compute.config).toMatchObject({
    live: { cadence: 'every-update' },
    execution: { kind: 'compute-only' },
  });

  const finalOnly = prepareIntrabarRun(
    publicConfig({
      kind: 'mirrored',
      mirrorOn: 'bar-close',
      broker: { id: 'paper' },
      intrabarExecutionArmed: true,
      ledger: { path: '/unused/public.jsonl', durability: 'sync' },
      lease: { path: '/unused/public.lock' },
    }),
    publicEveryUpdateSource,
  );
  expect(finalOnly.config.execution).toMatchObject({
    kind: 'mirrored',
    mirrorOn: 'bar-close',
    intrabarExecutionArmed: true,
  });
});
