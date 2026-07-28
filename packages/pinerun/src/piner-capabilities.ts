import * as PinerNamespace from '@heyphat/piner';
import type { CompiledScript } from '@heyphat/piner';

export const SUPPORTED_BAR_MAGNIFIER_CONTRACT_VERSION = 1;

interface CompiledLike {
  readonly metadata?: {
    readonly isStrategy?: boolean;
    readonly strategy?: Record<string, unknown>;
    readonly securityDependencies?: readonly unknown[];
  };
}

interface BrokerLike {
  host?: unknown;
  settings?: Record<string, unknown>;
  configure?: (settings: Record<string, unknown>) => void;
  report?: () => unknown;
}

interface EngineLike {
  readonly ctx?: Record<string, unknown>;
}

export interface PinerCapabilityAdapter {
  readonly runtime: Readonly<Record<string, unknown>>;
  readonly contractVersion?: number;
  readonly mappingVersion?: number;
  readonly hasMapper: boolean;
  readonly hasMetadataSetting: boolean;
  readonly hasReportBlock: boolean;
  readonly hasDataInjection: boolean;
  readonly capable: boolean;
  readonly missing: readonly string[];
  compile(source: string): CompiledLike;
  mapTargetTimeframe(chartPineTf: string): string;
  injectMagnifierData(engine: EngineLike, data: unknown): void;
}

const defaultCompileCache = new Map<string, CompiledScript>();
let defaultAdapter: PinerCapabilityAdapter | undefined;

/** Compile cache shared by metadata preflight and executeJob in this process. */
export function compilePinerSource(source: string): CompiledScript {
  let compiled = defaultCompileCache.get(source);
  if (!compiled) {
    compiled = PinerNamespace.compile(source);
    defaultCompileCache.set(source, compiled);
  }
  return compiled;
}

export function pinerCapabilities(): PinerCapabilityAdapter {
  return (defaultAdapter ??= createPinerCapabilityAdapter(PinerNamespace));
}

/**
 * Duck-typed adapter: no named import of a Bar Magnifier export is emitted, so
 * loading pinerun against an older piner remains safe for flag-off jobs.
 */
export function createPinerCapabilityAdapter(runtimeValue: unknown): PinerCapabilityAdapter {
  const runtime = isRecord(runtimeValue) ? runtimeValue : {};
  const contractVersion = integer(runtime.BAR_MAGNIFIER_CONTRACT_VERSION);
  const mappingVersion = integer(runtime.BAR_MAGNIFIER_MAPPING_VERSION);
  const hasMapper = typeof runtime.barMagnifierTimeframe === 'function';
  const contractCompatible = contractVersion === SUPPORTED_BAR_MAGNIFIER_CONTRACT_VERSION;
  const hasMappingContract = mappingVersion !== undefined && mappingVersion > 0;

  // New metadata/report/data contracts are interpreted only after the version gate.
  const hasMetadataSetting =
    contractCompatible && hasMappingContract && hasMapper && probeMetadataSetting(runtime);
  const hasDataInjection =
    contractCompatible && hasMappingContract && hasMapper && probeDataInjection(runtime);
  const hasReportBlock =
    contractCompatible && hasMappingContract && hasMapper && probeReportBlock(runtime);

  const missing: string[] = [];
  if (!contractCompatible) missing.push('contract-version');
  if (!hasMappingContract) missing.push('mapping-version');
  if (!hasMapper) missing.push('mapper');
  if (!hasMetadataSetting) missing.push('metadata-setting');
  if (!hasReportBlock) missing.push('report-block');
  if (!hasDataInjection) missing.push('data-injection');

  const compile = runtime.compile;
  const adapter: PinerCapabilityAdapter = {
    runtime,
    contractVersion,
    mappingVersion,
    hasMapper,
    hasMetadataSetting,
    hasReportBlock,
    hasDataInjection,
    capable: missing.length === 0,
    missing: Object.freeze(missing),
    compile(source: string): CompiledLike {
      if (typeof compile !== 'function') throw new Error('pinerun: loaded piner has no compile()');
      return Reflect.apply(compile, runtime, [source]) as CompiledLike;
    },
    mapTargetTimeframe(chartPineTf: string): string {
      if (!adapter.capable || typeof runtime.barMagnifierTimeframe !== 'function') {
        throw new Error('pinerun: loaded piner has no compatible Bar Magnifier mapping');
      }
      return String(Reflect.apply(runtime.barMagnifierTimeframe, runtime, [chartPineTf]));
    },
    injectMagnifierData(engine: EngineLike, data: unknown): void {
      if (!adapter.capable || !engine.ctx || !('magnifierData' in engine.ctx)) {
        throw new Error('pinerun: loaded piner has no compatible magnifier data channel');
      }
      engine.ctx.magnifierData = data;
    },
  };
  return Object.freeze(adapter);
}

function probeMetadataSetting(runtime: Record<string, unknown>): boolean {
  if (typeof runtime.compile !== 'function') return false;
  try {
    const compiled = Reflect.apply(runtime.compile, runtime, [
      '//@version=6\nstrategy("__pinerun_capability__", use_bar_magnifier=true)\nplot(close)',
    ]) as CompiledLike;
    const strategy = compiled.metadata?.strategy;
    return !!strategy && Object.prototype.hasOwnProperty.call(strategy, 'useBarMagnifier');
  } catch {
    return false;
  }
}

function probeDataInjection(runtime: Record<string, unknown>): boolean {
  const Context = runtime.ExecutionContext;
  if (typeof Context !== 'function') return false;
  try {
    const context = Reflect.construct(Context, []) as Record<string, unknown>;
    return 'magnifierData' in context;
  } catch {
    return false;
  }
}

function probeReportBlock(runtime: Record<string, unknown>): boolean {
  const Broker = runtime.StrategyBroker;
  if (typeof Broker !== 'function') return false;
  try {
    const broker = Reflect.construct(Broker, []) as BrokerLike;
    if (typeof broker.configure !== 'function' || typeof broker.report !== 'function') return false;
    broker.host = {
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      time: 0,
      idx: 0,
      mintick: 0.01,
      tradingDayKey: 0,
      tfStr: '60',
      // New runtimes bind the validated target once per run; the capability
      // probe supplies that run-bound identity directly instead of relying on
      // report() to remap an arbitrary host timeframe.
      barMagnifierTargetTimeframe: '10',
    };
    broker.configure({ useBarMagnifier: true });
    const report = broker.report();
    return (
      isRecord(report) &&
      isRecord(report.barMagnifier) &&
      report.barMagnifier.requested === true &&
      typeof report.barMagnifier.active === 'boolean'
    );
  } catch {
    return false;
  }
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? (value as number) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
