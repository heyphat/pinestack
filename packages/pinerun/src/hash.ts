/**
 * Determinism key. Because a piner run is a pure function of
 * `(source, bars, inputs, backend)`, we can memoize by a stable hash of those
 * inputs. Uses two independently-seeded FNV-1a passes (64 bits total) over a
 * canonical string: a single 32-bit hash gives a ~0.3% birthday-collision chance
 * across a 5000-combo sweep — and a memo collision silently hands one combo
 * another combo's results — while 64 bits pushes that below 1e-11.
 * Cost is bounded by bar count.
 */
import type { Job } from './job.js';

export function jobHash(job: Job): string {
  const s = canonical(job);
  return `${job.symbol}:${job.timeframe}:${fnv1a(s, FNV_OFFSET)}${fnv1a(s, FNV_OFFSET_ALT)}`;
}

function canonical(job: Job): string {
  // Bars fold into a compact numeric digest so we don't stringify megabytes.
  // Two seeds again: the digest string participates in the memo key, so it gets
  // the same 64-bit treatment as the outer hash.
  let d1 = FNV_OFFSET;
  let d2 = FNV_OFFSET_ALT;
  for (const b of job.bars) {
    d1 = mix(d1, b.time);
    d1 = mix(d1, b.open);
    d1 = mix(d1, b.high);
    d1 = mix(d1, b.low);
    d1 = mix(d1, b.close);
    d1 = mix(d1, b.volume);
    d2 = mix(d2, b.time);
    d2 = mix(d2, b.open);
    d2 = mix(d2, b.high);
    d2 = mix(d2, b.low);
    d2 = mix(d2, b.close);
    d2 = mix(d2, b.volume);
  }
  const inputs = job.inputs ? stableStringify(job.inputs) : '';
  const sec = job.securityBars ? securityDigest(job.securityBars) : '';
  // Metrics options don't change the run, but they do change the projected result
  // (annualization / risk-free rate), so they are part of the determinism key.
  const metrics = job.metrics ? stableStringify({ ...job.metrics }) : '';
  return [
    job.source,
    job.timeframe,
    job.backend ?? 'js',
    job.mintick ?? '',
    job.minQty ?? '',
    job.bars.length,
    (d1 >>> 0).toString(16) + (d2 >>> 0).toString(16),
    inputs,
    sec,
    metrics,
  ].join('\u0001');
}

/** Compact digest of injected security bars: keys + lengths + last bar time per key. */
function securityDigest(securityBars: Record<string, { time: number }[]>): string {
  return Object.keys(securityBars)
    .sort()
    .map((k) => {
      const bars = securityBars[k]!;
      return `${k}:${bars.length}:${bars[bars.length - 1]?.time ?? ''}`;
    })
    .join('|');
}

function mix(h: number, value: number): number {
  // Fold a float's bit pattern into the running digest.
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, value);
  h ^= buf.getUint32(0);
  h = Math.imul(h, 16777619) >>> 0;
  h ^= buf.getUint32(4);
  h = Math.imul(h, 16777619) >>> 0;
  return h >>> 0;
}

/** Standard FNV-1a 32-bit offset basis, and an arbitrary alternate seed for the second pass. */
const FNV_OFFSET = 2166136261 >>> 0;
const FNV_OFFSET_ALT = 0x9e3779b9 >>> 0;

function fnv1a(str: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  return keys.map((k) => `${k}=${JSON.stringify(obj[k])}`).join('&');
}
