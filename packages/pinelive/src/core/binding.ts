import type { MarketDataProvider, ResolvedDataInstrument } from '@heyphat/pinery';
import type { Broker } from './broker.js';
import type { NormalizedMirroredExecutionConfig } from './config.js';
import type { Instrument } from './types.js';
import {
  canonicalSha256,
  deepFreeze,
  type PreparedIntrabarAuthorityEnvelope,
} from './intrabar-authority.js';

export type V2ExecutionPolicyBinding = Readonly<
  Pick<NormalizedMirroredExecutionConfig, 'mirrorOn' | 'order' | 'broker'>
>;

export interface RunInstrumentBinding {
  /** Omitted on the byte-compatible v1/FNV binding. */
  readonly bindingVersion?: 2;
  readonly id: string;
  /** Legacy FNV display fingerprint; never restart authority for bindingVersion 2. */
  readonly fingerprint: string;
  readonly strategySymbol: string;
  readonly providerId: string;
  readonly providerHandle: string;
  readonly executionSymbol: string;
  readonly qtyStep: number;
  readonly minOrderQty: number;
  readonly mintick: number;
  readonly pointValue?: number;
  readonly exchange?: string;
  readonly expiry?: string;
  readonly brokerId: string;
  /** Complete prepared authority is persisted only on v2 bindings. */
  readonly authority?: PreparedIntrabarAuthorityEnvelope;
  /** Normalized broker/order economics bound before any v2 position read, mark, or submit. */
  readonly execution?: V2ExecutionPolicyBinding;
}

export class InstrumentBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstrumentBindingError';
  }
}

export function createRunInstrumentBinding(
  provider: MarketDataProvider,
  resolved: ResolvedDataInstrument,
  broker: Broker,
  brokerInstrument: Instrument,
): RunInstrumentBinding {
  const executionSymbol = brokerInstrument.brokerSymbol ?? brokerInstrument.symbol;
  if (executionSymbol !== resolved.venueSymbol)
    throw new InstrumentBindingError(
      `execution symbol ${executionSymbol} does not match resolved venue contract ${resolved.venueSymbol}`,
    );
  if (brokerInstrument.dataSymbol && brokerInstrument.dataSymbol !== resolved.venueSymbol)
    throw new InstrumentBindingError('broker data symbol does not match resolved venue contract');
  const qtyStep = brokerInstrument.qtyStep ?? brokerInstrument.minQty;
  const minOrderQty = brokerInstrument.minOrderQty ?? qtyStep;
  compare('mintick', brokerInstrument.mintick, resolved.mintick);
  compare('qtyStep', qtyStep, resolved.qtyStep);
  compare('minOrderQty', minOrderQty, resolved.minOrderQty);
  if (resolved.pointValue != null) {
    if (brokerInstrument.pointValue == null)
      throw new InstrumentBindingError('broker metadata is missing pointValue');
    compare('pointValue', brokerInstrument.pointValue, resolved.pointValue);
  }
  // The broker instrument's pointValue scales PnL even when the data provider reports none,
  // so the binding must attest whichever value execution will actually use.
  const attestedPointValue = resolved.pointValue ?? brokerInstrument.pointValue;
  if (
    resolved.exchange &&
    brokerInstrument.exchange &&
    resolved.exchange !== brokerInstrument.exchange
  )
    throw new InstrumentBindingError('broker exchange does not match resolved exchange');
  if (resolved.expiry && brokerInstrument.expiry && resolved.expiry !== brokerInstrument.expiry)
    throw new InstrumentBindingError('broker expiry does not match resolved expiry');

  const identity = {
    strategySymbol: resolved.strategySymbol,
    providerId: provider.id,
    providerHandle: resolved.providerHandle,
    executionSymbol,
    qtyStep: resolved.qtyStep,
    minOrderQty: resolved.minOrderQty,
    mintick: resolved.mintick,
    pointValue: attestedPointValue,
    exchange: resolved.exchange,
    expiry: resolved.expiry,
    brokerId: broker.id,
  };
  const fingerprint = `binding-${fnv1a(JSON.stringify(identity))}`;
  return Object.freeze({ id: fingerprint, fingerprint, ...identity });
}

/** V2 execution binding: SHA-256 is authoritative; the FNV field is display-only. */
export async function createV2RunInstrumentBinding(
  provider: MarketDataProvider,
  resolved: ResolvedDataInstrument,
  broker: Broker,
  brokerInstrument: Instrument,
  authority: PreparedIntrabarAuthorityEnvelope,
  execution?: V2ExecutionPolicyBinding,
): Promise<RunInstrumentBinding> {
  const legacy = createRunInstrumentBinding(provider, resolved, broker, brokerInstrument);
  const frozenExecution = execution ? deepFreeze(structuredClone(execution)) : undefined;
  const base = {
    fingerprint: legacy.fingerprint,
    strategySymbol: legacy.strategySymbol,
    providerId: legacy.providerId,
    providerHandle: legacy.providerHandle,
    executionSymbol: legacy.executionSymbol,
    qtyStep: legacy.qtyStep,
    minOrderQty: legacy.minOrderQty,
    mintick: legacy.mintick,
    ...(legacy.pointValue !== undefined ? { pointValue: legacy.pointValue } : {}),
    ...(legacy.exchange !== undefined ? { exchange: legacy.exchange } : {}),
    ...(legacy.expiry !== undefined ? { expiry: legacy.expiry } : {}),
    brokerId: legacy.brokerId,
  };
  const digest = await canonicalSha256({
    bindingVersion: 2,
    strategySymbol: base.strategySymbol,
    providerId: base.providerId,
    providerHandle: base.providerHandle,
    executionSymbol: base.executionSymbol,
    qtyStep: base.qtyStep,
    minOrderQty: base.minOrderQty,
    mintick: base.mintick,
    pointValue: base.pointValue ?? null,
    exchange: base.exchange ?? null,
    expiry: base.expiry ?? null,
    brokerId: base.brokerId,
    authorityIdentity: authority.identity,
    ...(frozenExecution ? { execution: frozenExecution } : {}),
  });
  return deepFreeze({
    ...base,
    bindingVersion: 2 as const,
    id: `binding-v2-${digest.slice('sha256-'.length)}`,
    authority,
    ...(frozenExecution ? { execution: frozenExecution } : {}),
  });
}

/** Broker-free v2 route used only for durable compute decisions. */
export async function createV2ComputeInstrumentBinding(
  provider: MarketDataProvider,
  resolved: ResolvedDataInstrument,
  authority: PreparedIntrabarAuthorityEnvelope,
): Promise<RunInstrumentBinding> {
  const identity = {
    strategySymbol: resolved.strategySymbol,
    providerId: provider.id,
    providerHandle: resolved.providerHandle,
    executionSymbol: resolved.venueSymbol,
    qtyStep: resolved.qtyStep,
    minOrderQty: resolved.minOrderQty,
    mintick: resolved.mintick,
    ...(resolved.pointValue !== undefined ? { pointValue: resolved.pointValue } : {}),
    ...(resolved.exchange !== undefined ? { exchange: resolved.exchange } : {}),
    ...(resolved.expiry !== undefined ? { expiry: resolved.expiry } : {}),
    brokerId: 'compute-only',
  };
  const fingerprint = `binding-${fnv1a(JSON.stringify(identity))}`;
  const digest = await canonicalSha256({
    bindingVersion: 2,
    ...identity,
    pointValue: identity.pointValue ?? null,
    exchange: identity.exchange ?? null,
    expiry: identity.expiry ?? null,
    authorityIdentity: authority.identity,
  });
  return deepFreeze({
    bindingVersion: 2 as const,
    id: `binding-v2-${digest.slice('sha256-'.length)}`,
    fingerprint,
    ...identity,
    authority,
  });
}

function compare(name: string, brokerValue: number, dataValue: number): void {
  if (!Number.isFinite(brokerValue) || brokerValue <= 0)
    throw new InstrumentBindingError(`broker metadata has invalid ${name}`);
  const tolerance = Math.max(1e-12, Math.abs(dataValue) * 1e-9);
  if (Math.abs(brokerValue - dataValue) > tolerance)
    throw new InstrumentBindingError(
      `broker ${name} ${brokerValue} does not match resolved ${name} ${dataValue}`,
    );
}

function fnv1a(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
