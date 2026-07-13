/**
 * align — time-axis union + forward-fill + combined-curve helpers (pure, no
 * piner/pinery imports; portfolio plan §6).
 *
 * Two jobs: (1) the post-hoc ORACLE — combine per-sleeve runs into the
 * equal/weighted-sleeve portfolio curve, which the PortfolioEngine's isolated
 * mode must reproduce bit-for-bit (gate V3, proven in piner's test suite and
 * re-checked in pinerun's); (2) plain aligned-series arithmetic for the
 * contribution table (per-sleeve return correlation).
 */

export interface Sleeve {
  symbol: string;
  /** Bar times, ascending. Any one unit (s or ms) — just be consistent across sleeves. */
  barTimes: number[];
  /** Per-bar equity, indexed like barTimes (may be sparse/NaN before activation). */
  equityCurve: number[];
  /** Pre-activation fill value: the sleeve's funding (cash before its first bar). */
  initialCapital: number;
}

/** Sorted, deduped union of all sleeves' bar times. */
export function unionTimes(sleeves: Pick<Sleeve, 'barTimes'>[]): number[] {
  const set = new Set<number>();
  for (const s of sleeves) for (const t of s.barTimes) set.add(t);
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * One sleeve's equity forward-filled onto `axis`:
 *  - before its first bar → initialCapital (cash sitting uninvested, NOT 0)
 *  - at time t → its latest at-or-before mark (NaN holes carry the last value)
 *  - after its last bar → its final equity (ragged tail, not truncation)
 * Two-pointer merge — O(axis + bars).
 */
export function alignEquity(sleeve: Sleeve, axis: number[]): number[] {
  const { barTimes, equityCurve } = sleeve;
  const out = new Array<number>(axis.length);
  let j = 0;
  let last = sleeve.initialCapital;
  for (let k = 0; k < axis.length; k++) {
    const t = axis[k]!;
    while (j < barTimes.length && barTimes[j]! <= t) {
      const v = equityCurve[j];
      if (v != null && !Number.isNaN(v)) last = v;
      j++;
    }
    out[k] = last;
  }
  return out;
}

/** The portfolio curve: Σ of each aligned sleeve, summed in sleeve order. */
export function combineEquity(sleeves: Sleeve[]): {
  times: number[];
  equity: number[];
  perSleeve: number[][];
} {
  const times = unionTimes(sleeves);
  const perSleeve = sleeves.map((s) => alignEquity(s, times));
  const equity = times.map((_, k) => {
    let sum = 0;
    for (const filled of perSleeve) sum += filled[k]!;
    return sum;
  });
  return { times, equity, perSleeve };
}

/** Pearson correlation of two aligned series' per-step deltas (returns).
 *  NaN-pairs are skipped; degenerate series (no variance) → NaN. */
export function returnCorrelation(a: number[], b: number[]): number {
  const da: number[] = [];
  const db: number[] = [];
  for (let i = 1; i < Math.min(a.length, b.length); i++) {
    const x = a[i]! - a[i - 1]!;
    const y = b[i]! - b[i - 1]!;
    if (!Number.isNaN(x) && !Number.isNaN(y)) {
      da.push(x);
      db.push(y);
    }
  }
  const n = da.length;
  if (n < 2) return NaN;
  const ma = da.reduce((s, v) => s + v, 0) / n;
  const mb = db.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (da[i]! - ma) * (db[i]! - mb);
    va += (da[i]! - ma) ** 2;
    vb += (db[i]! - mb) ** 2;
  }
  if (va === 0 || vb === 0) return NaN;
  return cov / Math.sqrt(va * vb);
}
