import type { Bar } from './job.js';

/** Persisted digest cache is restricted to arrays created and deeply frozen by pinerun. */
const ownedImmutableDatasets = new WeakSet<object>();
const immutableDigestCache = new WeakMap<object, string>();

export function registerOwnedImmutableBars<T extends readonly Bar[]>(bars: T): T {
  if (!Object.isFrozen(bars) || !bars.every((bar) => Object.isFrozen(bar))) {
    throw new TypeError('pinerun: an owned market dataset must be deeply immutable');
  }
  ownedImmutableDatasets.add(bars);
  return bars;
}

/** SHA-256 over array length and every timestamp/OHLCV/volume IEEE-754 bit pattern. */
export function marketDataDigest(bars: readonly Bar[]): string {
  if (ownedImmutableDatasets.has(bars)) {
    const cached = immutableDigestCache.get(bars);
    if (cached) return cached;
    const digest = computeMarketDataDigest(bars);
    immutableDigestCache.set(bars, digest);
    return digest;
  }
  return computeMarketDataDigest(bars);
}

export function numberArrayDigest(values: readonly number[]): string {
  const hash = new Sha256();
  const row = new ArrayBuffer(8);
  const view = new DataView(row);
  writeNumber(hash, view, values.length);
  for (const value of values) writeNumber(hash, view, value);
  return hash.hex();
}

export function textDigest(value: string): string {
  return bytesDigest(new TextEncoder().encode(value));
}

/** Stable recursive value digest used for options, coverage, provenance, and cache keys. */
export function canonicalDigest(value: unknown): string {
  return textDigest(canonicalValue(value));
}

function computeMarketDataDigest(bars: readonly Bar[]): string {
  const hash = new Sha256();
  const row = new ArrayBuffer(48);
  const view = new DataView(row);
  const count = new ArrayBuffer(8);
  const countView = new DataView(count);
  countView.setFloat64(0, bars.length, false);
  hash.update(new Uint8Array(count));
  for (const bar of bars) {
    view.setFloat64(0, bar.time, false);
    view.setFloat64(8, bar.open, false);
    view.setFloat64(16, bar.high, false);
    view.setFloat64(24, bar.low, false);
    view.setFloat64(32, bar.close, false);
    view.setFloat64(40, bar.volume, false);
    hash.update(new Uint8Array(row));
  }
  return hash.hex();
}

function writeNumber(hash: Sha256, view: DataView, value: number): void {
  view.setFloat64(0, value, false);
  hash.update(new Uint8Array(view.buffer));
}

function canonicalValue(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'n';
  switch (typeof value) {
    case 'undefined':
      return 'u';
    case 'boolean':
      return value ? 'b1' : 'b0';
    case 'number':
      return `d${numberBits(value)}`;
    case 'bigint':
      return `i${value.toString(10)};`;
    case 'string':
      return `s${value.length}:${value}`;
    case 'symbol':
    case 'function':
      throw new TypeError(`pinerun: cannot deterministically hash ${typeof value}`);
    case 'object': {
      const object = value as object;
      if (seen.has(object)) throw new TypeError('pinerun: cannot hash a cyclic value');
      seen.add(object);
      try {
        if (Array.isArray(value)) {
          return `a${value.length}[${value.map((item) => canonicalValue(item, seen)).join('')}]`;
        }
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        return `o${keys.length}{${keys
          .map((key) => `${canonicalValue(key, seen)}${canonicalValue(record[key], seen)}`)
          .join('')}}`;
      } finally {
        seen.delete(object);
      }
    }
  }
  throw new TypeError('pinerun: unsupported deterministic hash value');
}

function numberBits(value: number): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  return `${view.getUint32(0, false).toString(16).padStart(8, '0')}${view
    .getUint32(4, false)
    .toString(16)
    .padStart(8, '0')}`;
}

function bytesDigest(bytes: Uint8Array): string {
  const hash = new Sha256();
  hash.update(bytes);
  return hash.hex();
}

// Small browser-safe streaming SHA-256 implementation. Keeping it here avoids a
// Node crypto dependency in pinerun's browser entry while providing a real
// collision-resistant determinism key rather than a short non-cryptographic fold.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  private bytes = 0;
  private finished = false;

  update(input: Uint8Array): void {
    if (this.finished) throw new Error('pinerun: SHA-256 digest already finalized');
    this.bytes += input.length;
    let offset = 0;
    while (offset < input.length) {
      const take = Math.min(64 - this.blockLength, input.length - offset);
      this.block.set(input.subarray(offset, offset + take), this.blockLength);
      this.blockLength += take;
      offset += take;
      if (this.blockLength === 64) {
        this.compress(this.block);
        this.blockLength = 0;
      }
    }
  }

  hex(): string {
    if (!this.finished) this.finish();
    return [...this.state].map((word) => word.toString(16).padStart(8, '0')).join('');
  }

  private finish(): void {
    const bitLength = this.bytes * 8;
    this.block[this.blockLength++] = 0x80;
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength);
      this.compress(this.block);
      this.blockLength = 0;
    }
    this.block.fill(0, this.blockLength, 56);
    const view = new DataView(this.block.buffer);
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    view.setUint32(56, high >>> 0, false);
    view.setUint32(60, low, false);
    this.compress(this.block);
    this.finished = true;
  }

  private compress(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15]!;
      const b = words[index - 2]!;
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }

    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;
    for (let index = 0; index < 64; index++) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + sum1 + choice + K[index]! + words[index]!) >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }
}

function rotate(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}
