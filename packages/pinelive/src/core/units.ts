import type { Instrument } from './types.js';

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`${name} must be a positive finite number`);
}

/** Maximum accepted floating error as a fraction of one quantity step. */
const GRID_ALIGNMENT_TOLERANCE = 1e-12;

/** True only when a finite value is demonstrably on a positive finite increment. */
export function isStepAligned(value: number, step: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return false;
  const nearestUnits = Math.round(value / step);
  if (!Number.isSafeInteger(nearestUnits)) return false;
  const candidate = nearestUnits * step;
  if (!Number.isFinite(candidate)) return false;
  return Math.abs(value - candidate) <= step * GRID_ALIGNMENT_TOLERANCE;
}

/** Snap toward zero. This is deliberately conservative: it can undershoot, never overshoot. */
export function snap(qty: number, step: number): number {
  if (!Number.isFinite(qty)) throw new RangeError('qty must be finite');
  assertPositive(step, 'step');
  const magnitude = Math.abs(qty);
  if (isStepAligned(magnitude, step)) return qty;

  const ratio = magnitude / step;
  if (!Number.isFinite(ratio)) throw new RangeError('qty/step ratio must be finite');
  let units = Math.floor(ratio);
  if (!Number.isSafeInteger(units))
    throw new RangeError('qty exceeds the safely representable quantity grid');

  let snapped = units * step;
  if (!Number.isFinite(snapped)) throw new RangeError('snapped qty must be finite');
  // Division can round a quotient upward at the edge of floating precision. Never trust it
  // without comparing the reconstructed quantity to the actual requested magnitude.
  if (snapped > magnitude && units > 0) {
    units--;
    snapped = units * step;
  }
  if (!Number.isFinite(snapped) || snapped > magnitude)
    throw new RangeError('qty cannot be snapped conservatively on this quantity grid');

  // Clean ordinary multiplication noise only when the cleaned value remains both on-grid and
  // conservative. Otherwise retain the direct grid product rather than rounding economics up.
  const normalized = Number(snapped.toPrecision(15));
  const result = normalized <= magnitude && isStepAligned(normalized, step) ? normalized : snapped;
  return Math.sign(qty) * result;
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
