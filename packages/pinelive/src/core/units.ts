import type { Instrument } from './types.js';

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${name} must be a positive finite number`);
}

function decimals(value: number): number {
  const text = value.toString().toLowerCase();
  if (text.includes('e-')) return Math.min(12, Number(text.split('e-')[1]));
  return Math.min(12, text.includes('.') ? text.length - text.indexOf('.') - 1 : 0);
}

/** Snap toward zero. This is deliberately conservative: it can undershoot, never overshoot. */
export function snap(qty: number, step: number): number {
  if (!Number.isFinite(qty)) throw new RangeError('qty must be finite');
  assertPositive(step, 'step');
  const scale = 10 ** Math.max(decimals(qty), decimals(step));
  const units = Math.floor(
    (Math.abs(qty) * scale + Number.EPSILON * scale) / Math.round(step * scale),
  );
  const snapped = (units * Math.round(step * scale)) / scale;
  return Math.sign(qty) * snapped;
}

export function nativeQtyStep(instrument: Instrument): number {
  const step = instrument.qtyStep ?? instrument.minQty;
  assertPositive(step, 'instrument quantity step');
  return step;
}

/** Convert native quantity to venue units, snapped toward zero to the venue increment. */
export function toBrokerQty(nativeQty: number, instrument: Instrument): number {
  const factor = instrument.brokerQtyPerNative ?? 1;
  assertPositive(factor, 'brokerQtyPerNative');
  const brokerStep = instrument.brokerQtyStep ?? nativeQtyStep(instrument) * factor;
  return snap(nativeQty * factor, brokerStep);
}

/** Convert venue quantity to native units, snapped toward zero to the native increment. */
export function toNativeQty(brokerQty: number, instrument: Instrument): number {
  const factor = instrument.brokerQtyPerNative ?? 1;
  assertPositive(factor, 'brokerQtyPerNative');
  return snap(brokerQty / factor, nativeQtyStep(instrument));
}

export function quantitiesEqual(a: number, b: number, step: number): boolean {
  return Math.abs(a - b) < step / 2;
}
