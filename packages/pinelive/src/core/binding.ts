import type { MarketDataProvider, ResolvedDataInstrument } from '@heyphat/pinery';
import type { Broker } from './broker.js';
import type { Instrument } from './types.js';

export interface RunInstrumentBinding {
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
    pointValue: resolved.pointValue,
    exchange: resolved.exchange,
    expiry: resolved.expiry,
    brokerId: broker.id,
  };
  const fingerprint = `binding-${fnv1a(JSON.stringify(identity))}`;
  return Object.freeze({ id: fingerprint, fingerprint, ...identity });
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
