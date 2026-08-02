import type { MarketDataProvider, ResolvedDataInstrument } from '@heyphat/pinery';
import type { Broker } from './broker.js';
import type { NormalizedMirroredExecutionConfig } from './config.js';
import type { Instrument } from './types.js';
import {
  canonicalSha256,
  deepFreeze,
  type PreparedIntrabarAuthorityEnvelope,
} from './intrabar-authority.js';

export type ExecutionPolicyBinding = Readonly<
  Pick<NormalizedMirroredExecutionConfig, 'mirrorOn' | 'order' | 'broker'>
>;

export interface RunInstrumentBinding {
  /** The binding contract is versioned independently of run configuration and ledger schemas. */
  readonly bindingVersion: 2;
  readonly id: string;
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
  readonly authority: PreparedIntrabarAuthorityEnvelope;
  /** Normalized broker/order economics bound before any position read, mark, or submit. */
  readonly execution?: ExecutionPolicyBinding;
}

export class InstrumentBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstrumentBindingError';
  }
}

export async function createRunInstrumentBinding(
  provider: MarketDataProvider,
  resolved: ResolvedDataInstrument,
  broker: Broker,
  brokerInstrument: Instrument,
  authority: PreparedIntrabarAuthorityEnvelope,
  execution?: ExecutionPolicyBinding,
): Promise<RunInstrumentBinding> {
  const identity = validatedBindingIdentity(provider, resolved, broker, brokerInstrument);
  return createStrongRunInstrumentBinding(identity, authority, execution);
}

async function createStrongRunInstrumentBinding(
  identity: ReturnType<typeof validatedBindingIdentity>,
  authority: PreparedIntrabarAuthorityEnvelope,
  execution?: ExecutionPolicyBinding,
): Promise<RunInstrumentBinding> {
  const frozenExecution = execution ? deepFreeze(structuredClone(execution)) : undefined;
  const digest = await canonicalSha256({
    bindingVersion: 2,
    strategySymbol: identity.strategySymbol,
    providerId: identity.providerId,
    providerHandle: identity.providerHandle,
    executionSymbol: identity.executionSymbol,
    qtyStep: identity.qtyStep,
    minOrderQty: identity.minOrderQty,
    mintick: identity.mintick,
    pointValue: identity.pointValue ?? null,
    exchange: identity.exchange ?? null,
    expiry: identity.expiry ?? null,
    brokerId: identity.brokerId,
    authorityIdentity: authority.identity,
    ...(frozenExecution ? { execution: frozenExecution } : {}),
  });
  const id = `binding-v2-${digest.slice('sha256-'.length)}`;
  return deepFreeze({
    ...identity,
    bindingVersion: 2 as const,
    id,
    fingerprint: id,
    authority,
    ...(frozenExecution ? { execution: frozenExecution } : {}),
  });
}

/** Broker-free route used only for durable compute decisions. */
export async function createComputeInstrumentBinding(
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
  const digest = await canonicalSha256({
    bindingVersion: 2,
    ...identity,
    pointValue: identity.pointValue ?? null,
    exchange: identity.exchange ?? null,
    expiry: identity.expiry ?? null,
    authorityIdentity: authority.identity,
  });
  const id = `binding-v2-${digest.slice('sha256-'.length)}`;
  return deepFreeze({
    bindingVersion: 2 as const,
    id,
    fingerprint: id,
    ...identity,
    authority,
  });
}

function validatedBindingIdentity(
  provider: MarketDataProvider,
  resolved: ResolvedDataInstrument,
  broker: Broker,
  brokerInstrument: Instrument,
) {
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
  } else if (brokerInstrument.pointValue != null) {
    compare('pointValue', brokerInstrument.pointValue, brokerInstrument.pointValue);
  }
  const attestedPointValue = resolved.pointValue ?? brokerInstrument.pointValue;
  if (
    resolved.exchange &&
    brokerInstrument.exchange &&
    resolved.exchange !== brokerInstrument.exchange
  )
    throw new InstrumentBindingError('broker exchange does not match resolved exchange');
  if (resolved.expiry && brokerInstrument.expiry && resolved.expiry !== brokerInstrument.expiry)
    throw new InstrumentBindingError('broker expiry does not match resolved expiry');

  return {
    strategySymbol: resolved.strategySymbol,
    providerId: provider.id,
    providerHandle: resolved.providerHandle,
    executionSymbol,
    qtyStep: resolved.qtyStep,
    minOrderQty: resolved.minOrderQty,
    mintick: resolved.mintick,
    ...(attestedPointValue !== undefined ? { pointValue: attestedPointValue } : {}),
    ...(resolved.exchange !== undefined ? { exchange: resolved.exchange } : {}),
    ...(resolved.expiry !== undefined ? { expiry: resolved.expiry } : {}),
    brokerId: broker.id,
  };
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
