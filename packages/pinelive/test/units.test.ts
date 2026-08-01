import { describe, expect, test } from 'bun:test';
import { snap, toBrokerQty, toNativeQty } from '../src/index.js';

describe('quantity units', () => {
  test('snaps toward zero without floating-point overshoot', () => {
    expect(snap(1.29, 0.1)).toBe(1.2);
    expect(snap(-1.29, 0.1)).toBe(-1.2);
    expect(snap(0.3, 0.1)).toBe(0.3);
  });
  test('contracts use factor one', () => {
    const instrument = { symbol: 'MES', minQty: 1, mintick: 0.25 };
    expect(toBrokerQty(3.8, instrument)).toBe(3);
    expect(toNativeQty(3.8, instrument)).toBe(3);
  });
  test('forex conversion honors venue step conservatively', () => {
    const instrument = {
      symbol: 'EURUSD',
      minQty: 0.01,
      mintick: 0.00001,
      brokerQtyPerNative: 100_000,
      brokerQtyStep: 1_000,
    };
    expect(toBrokerQty(0.019, instrument)).toBe(1_000);
    expect(toNativeQty(1_999, instrument)).toBe(0.01);
  });
});
