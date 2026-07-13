import { test, expect } from 'bun:test';
import { StaticProvider, type Bar } from '@heyphat/pinery';
import { scan } from '../src/index.js';
import { WorkerPoolRunner } from '../src/node.js';

const SRC = `//@version=6
indicator("sma")
plot(ta.sma(close, 10), title="sma")
`;

function ramp(n: number, start: number, step: number): Bar[] {
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const open = close;
    close += step;
    bars.push({
      time: start + i * 3600,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 100,
    });
  }
  return bars;
}

test('WorkerPoolRunner sends a shared bar set once per worker (sweep-style jobs)', async () => {
  const PARAM_SRC = `//@version=6
indicator("sma param")
len = input.int(10, "len")
plot(ta.sma(close, len), title="sma")
`;
  const bars = ramp(80, 1_700_000_000, 2); // ONE dataset shared by every job
  const other = ramp(80, 1_700_000_000, 1); // a second dataset to break the cache
  const runner = new WorkerPoolRunner({ size: 2 });
  try {
    const jobs = [5, 10, 20, 40].map((len) => ({
      id: `len=${len}`,
      source: PARAM_SRC,
      symbol: 'A',
      timeframe: '60',
      bars,
      inputs: { len },
    }));
    // Interleave a different dataset, then return to the shared one — exercises
    // both the omitted-bars cache hit and the cache-replacement path.
    jobs.splice(2, 0, {
      id: 'other',
      source: PARAM_SRC,
      symbol: 'B',
      timeframe: '60',
      bars: other,
      inputs: { len: 10 },
    });

    const results = await runner.runAll(jobs, { concurrency: 2 });
    expect(results.every((r) => r.ok)).toBe(true);
    // Different lookbacks over the same series → different final SMAs.
    const values = results
      .filter((r) => r.symbol === 'A')
      .map((r) => r.plots[0]!.data[r.plots[0]!.data.length - 1]);
    expect(new Set(values.map((v) => v!.toFixed(6))).size).toBe(4);
  } finally {
    await runner.close();
  }
}, 20_000);

test('WorkerPoolRunner runs a scan across worker threads', async () => {
  const provider = new StaticProvider({
    A: ramp(80, 1_700_000_000, +2),
    B: ramp(80, 1_700_000_000, +1),
    C: ramp(80, 1_700_000_000, -1),
  });
  const runner = new WorkerPoolRunner({ size: 2 });
  try {
    const report = await scan({
      source: SRC,
      symbols: ['A', 'B', 'C'],
      timeframe: '1h',
      provider,
      rank: 'last(sma)',
      runner,
    });
    expect(report.errors).toHaveLength(0);
    expect(report.ranked).toHaveLength(3);
    // Steeper ramp → higher final SMA.
    expect(report.ranked.map((r) => r.result.symbol)).toEqual(['A', 'B', 'C']);
  } finally {
    await runner.close();
  }
}, 20_000);
