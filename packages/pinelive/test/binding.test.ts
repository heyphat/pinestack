import { expect, test } from 'bun:test';
import type { MarketDataProvider, ResolvedDataInstrument } from '@heyphat/pinery';
import type { Broker } from '../src/core/broker.js';
import { createRunInstrumentBinding, InstrumentBindingError } from '../src/core/binding.js';
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

const authority = {
  algorithm: 'sha256',
  identity: `sha256-${'a'.repeat(64)}`,
  prepared: {},
} as never;

test('binding attests a valid broker-only pointValue', async () => {
  const binding = await createRunInstrumentBinding(
    provider,
    resolved,
    broker,
    { ...instrument, pointValue: 10 },
    authority,
  );
  expect(binding.pointValue).toBe(10);
});

test('binding uses the strong persisted identity', async () => {
  const binding = await createRunInstrumentBinding(
    provider,
    resolved,
    broker,
    instrument,
    authority,
  );

  expect(binding.bindingVersion).toBe(2);
  expect(binding.id).toMatch(/^binding-v2-[a-f0-9]{64}$/);
  expect(binding.fingerprint).toBe(binding.id);
});

test('binding rejects non-positive and non-finite broker-only pointValue metadata', async () => {
  for (const pointValue of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(
      createRunInstrumentBinding(
        provider,
        resolved,
        broker,
        { ...instrument, pointValue },
        authority,
      ),
    ).rejects.toBeInstanceOf(InstrumentBindingError);
  }
});
