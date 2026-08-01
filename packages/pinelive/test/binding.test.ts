import { expect, test } from 'bun:test';
import type { MarketDataProvider, ResolvedDataInstrument } from '@heyphat/pinery';
import type { Broker } from '../src/core/broker.js';
import {
  createRunInstrumentBinding,
  createV2RunInstrumentBinding,
  InstrumentBindingError,
} from '../src/core/binding.js';
import type { Instrument } from '../src/core/types.js';

const provider = { id: 'binding-provider' } as MarketDataProvider;
const broker = { id: 'custom-broker' } as Broker;
const resolved: ResolvedDataInstrument = {
  strategySymbol: 'ROOT',
  providerHandle: 'binding-provider:X',
  venueSymbol: 'X',
  mintick: 0.01,
  qtyStep: 1,
  minOrderQty: 1,
};
const instrument: Instrument = {
  symbol: 'X',
  mintick: 0.01,
  minQty: 1,
  qtyStep: 1,
  minOrderQty: 1,
};

test('binding attests a valid broker-only pointValue', () => {
  const binding = createRunInstrumentBinding(provider, resolved, broker, {
    ...instrument,
    pointValue: 10,
  });
  expect(binding.pointValue).toBe(10);
});

test('binding rejects non-positive and non-finite broker-only pointValue metadata', async () => {
  for (const pointValue of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() =>
      createRunInstrumentBinding(provider, resolved, broker, { ...instrument, pointValue }),
    ).toThrow(InstrumentBindingError);

    // V2 delegates through the same generic binding gate before reading its authority argument.
    await expect(
      createV2RunInstrumentBinding(
        provider,
        resolved,
        broker,
        { ...instrument, pointValue },
        undefined as never,
      ),
    ).rejects.toThrow('invalid pointValue');
  }
});
