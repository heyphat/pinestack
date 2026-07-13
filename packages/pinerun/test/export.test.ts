import { test, expect } from 'bun:test';
import {
  tradesToCsv,
  equityToCsv,
  equityPlotHtml,
  sweepPointsToCsv,
  sweepHeatmap,
} from '../src/index.js';
import type {
  RunResult,
  StrategyTrade,
  StrategySummary,
  SweepPoint,
  SweepReport,
  Axis,
} from '../src/index.js';

const T0 = 1_700_000_000; // unix seconds (pinery convention)

function makeTrade(over: Partial<StrategyTrade> = {}): StrategyTrade {
  return {
    entryId: 'long',
    dir: 1,
    qty: 10,
    entryPrice: 100,
    exitPrice: 110,
    entryBar: 4,
    exitBar: 6,
    entryTime: (T0 + 4 * 3600) * 1000, // ms (piner convention)
    exitTime: (T0 + 6 * 3600) * 1000,
    profit: 100,
    cumProfit: 100,
    commission: 0.5,
    maxRunup: 120,
    maxDrawdown: 15,
    ...over,
  };
}

function makeResult(over: Partial<RunResult> = {}): RunResult {
  // Sparse equity: holes before the strategy activated at bar 3.
  const equityCurve: number[] = [];
  equityCurve[3] = 10000;
  equityCurve[4] = 10050;
  equityCurve[5] = 9990;
  equityCurve[6] = 10120;
  return {
    id: 'A@60',
    symbol: 'A',
    timeframe: '60',
    ok: true,
    bars: 7,
    plots: [],
    alerts: [],
    trades: [makeTrade()],
    equityCurve,
    barTimes: Array.from({ length: 7 }, (_, i) => T0 + i * 3600),
    ...over,
  };
}

test('tradesToCsv: header, ISO times, RFC 4180 escaping', () => {
  const result = makeResult({
    trades: [makeTrade(), makeTrade({ entryId: 'has,comma "q"', profit: -5 })],
  });
  const csv = tradesToCsv(result);
  const lines = csv.trimEnd().split('\n');
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe(
    'symbol,entryId,dir,qty,entryPrice,exitPrice,entryBar,exitBar,entryTime,exitTime,' +
      'profit,cumProfit,commission,maxRunup,maxDrawdown',
  );
  // piner ms fill times → ISO 8601 UTC.
  expect(lines[1]).toContain(new Date((T0 + 4 * 3600) * 1000).toISOString());
  // A cell with commas/quotes is quoted and inner quotes doubled.
  expect(lines[2]).toContain('"has,comma ""q"""');
  // Header-only when the result carries no ledger.
  expect(
    tradesToCsv(makeResult({ trades: undefined }))
      .trimEnd()
      .split('\n'),
  ).toHaveLength(1);
});

test('equityToCsv: every bar emitted, holes → empty cells, seconds → ISO', () => {
  const csv = equityToCsv(makeResult());
  const lines = csv.trimEnd().split('\n');
  expect(lines[0]).toBe('bar,time,equity');
  expect(lines).toHaveLength(1 + 7);
  // Hole before activation: time present, equity empty.
  expect(lines[1]).toBe(`0,${new Date(T0 * 1000).toISOString()},`);
  // Active bar: full row.
  expect(lines[4]).toBe(`3,${new Date((T0 + 3 * 3600) * 1000).toISOString()},10000`);
});

test('equityPlotHtml: self-contained SVG with markers, escapes the title', () => {
  const strategy = {
    initialCapital: 10000,
    netProfitPercent: 1.2,
    maxDrawdownPercent: 3.4,
    closedTrades: 1,
    metrics: { sharpe: 1.5, buyHoldReturnPercent: 0.8 },
  } as StrategySummary;
  const html = equityPlotHtml(makeResult({ strategy }), { title: 'A <&> "sweep"' });
  expect(html).toContain('<!doctype html>');
  expect(html).toContain('class="equity"');
  expect(html).toContain('class="drawdown"');
  expect(html).toContain('class="capital"'); // initial-capital reference line
  expect(html).toContain('<circle'); // trade exit marker
  expect(html).toContain('A &lt;&amp;&gt; &quot;sweep&quot;');
  expect(html).not.toContain('http'); // no external assets
  // Degenerate curve → explicit empty state, not a broken chart.
  expect(equityPlotHtml(makeResult({ equityCurve: [10000] }))).toContain('No equity data');
});

test('equityPlotHtml: edge x-labels anchor inward; B&H omitted when zero (portfolio)', () => {
  const n = 40;
  const barTimes = Array.from({ length: n }, (_, i) => T0 + i * 3600);
  const equityCurve = Array.from({ length: n }, (_, i) => 20000 + i * 10);
  const strategy = {
    initialCapital: 20000,
    netProfitPercent: 2,
    maxDrawdownPercent: 1,
    closedTrades: 3,
    metrics: { sharpe: 1.1, buyHoldReturnPercent: 0 }, // portfolio: no benchmark
  } as StrategySummary;
  const html = equityPlotHtml(makeResult({ barTimes, equityCurve, trades: [], strategy }));
  // the first/last date labels would clip if centered at the plot edges
  expect(html).toContain('style="text-anchor:start"');
  expect(html).toContain('style="text-anchor:end"');
  // a zero B&H is absence-of-benchmark, not data — the subtitle drops it
  expect(html).not.toContain('B&amp;H');
  expect(html).toContain('Sharpe');
});

test('equityPlotHtml: exit markers locate by TIME, not sleeve-local exitBar (portfolio ledgers)', () => {
  // A portfolio's merged ledger carries SLEEVE-LOCAL exitBar values (audit #3):
  // this trade says exitBar=2, but its exitTime is master bar 8. The marker must
  // land at the time-mapped index — x of bar 8, reading equity[8] — not bar 2.
  const n = 10;
  const barTimes = Array.from({ length: n }, (_, i) => T0 + i * 3600); // unix SECONDS
  const equityCurve = Array.from({ length: n }, (_, i) => 20000 + i * 100);
  const trade = makeTrade({ exitBar: 2, exitTime: (T0 + 8 * 3600) * 1000 }); // ms, = master bar 8
  const html = equityPlotHtml(makeResult({ barTimes, equityCurve, trades: [trade] }));

  const circle = /<circle cx="([\d.]+)"/.exec(html);
  expect(circle).not.toBeNull();
  // Recompute the plot's x-scale for bar 8 (W=960, margins 64/16 → plotW=880).
  const expectedCx = 64 + (8 / (n - 1)) * 880;
  const wrongCx = 64 + (2 / (n - 1)) * 880; // where the old exitBar indexing drew it
  expect(Number(circle![1])).toBeCloseTo(expectedCx, 1);
  expect(Math.abs(Number(circle![1]) - wrongCx)).toBeGreaterThan(100);
});

// ── sweep exports: points CSV + heatmap ─────────────────────

function makeSummary(over: Partial<StrategySummary> = {}): StrategySummary {
  return {
    initialCapital: 10000,
    netProfit: 812.4,
    netProfitPercent: 8.124,
    grossProfit: 1500,
    grossProfitPercent: 15,
    grossLoss: -687.6,
    grossLossPercent: -6.876,
    profitFactor: 2.18,
    wins: 8,
    losses: 6,
    evens: 0,
    closedTrades: 14,
    winRate: 8 / 14,
    avgTrade: 58,
    avgTradePercent: 0.58,
    avgWinningTrade: 187.5,
    avgLosingTrade: -114.6,
    maxDrawdown: 630,
    maxDrawdownPercent: 6.3,
    maxRunup: 900,
    maxRunupPercent: 9,
    maxContractsHeld: 1,
    totalCommission: 12,
    barsProcessed: 200,
    barsInMarket: 90,
    metrics: {
      sharpe: 1.42,
      sortino: 2.1,
      volatilityPercent: 22,
      cagrPercent: 31,
      calmar: 4.9,
      exposurePercent: 45,
      expectancy: 58,
      maxConsecutiveWins: 3,
      maxConsecutiveLosses: 2,
      largestWin: 400,
      largestLoss: -220,
      avgBarsInTrade: 6.4,
      buyHoldReturnPercent: 5.5,
      outperformance: 262.4,
    },
    ...over,
  };
}

/** Minimal SweepReport for the pure sweep exporters. */
function makeSweepReport(points: SweepPoint[], axes: Axis[]): SweepReport {
  return {
    symbol: [...new Set(points.map((p) => p.symbol))].join(','),
    symbols: [...new Set(points.map((p) => p.symbol))],
    rank: 'strategy.netProfit',
    spec: { kind: 'strategy', aggregate: 'last', selector: 'netProfit' },
    axes,
    total: points.length,
    combos: points.length,
    gridTotal: points.length,
    ranked: [...points].sort((a, b) => b.value - a.value),
    points,
    errors: points.filter((p) => !p.result.ok).map((p) => p.result),
    warnings: [],
    fetchErrors: [],
  };
}

function makePoint(
  symbol: string,
  inputs: Record<string, unknown>,
  value: number,
  over: Partial<RunResult> = {},
): SweepPoint {
  return {
    symbol,
    inputs,
    value,
    result: makeResult({
      symbol,
      id: Object.entries(inputs)
        .map(([k, v]) => `${k}=${v}`)
        .join('|'),
      trades: undefined,
      equityCurve: undefined,
      barTimes: undefined,
      strategy: Number.isFinite(value) ? makeSummary({ netProfit: value }) : undefined,
      ...over,
    }),
  };
}

test('sweepPointsToCsv: one row per run — symbol, axes, value, strategy stats, error', () => {
  const axes: Axis[] = [
    { name: 'fast', values: [5, 10] },
    { name: 'slow', values: [30] },
  ];
  const failed = makePoint('B', { fast: 10, slow: 30 }, NaN, {
    ok: false,
    error: 'boom, with "quotes"',
    strategy: undefined,
  });
  const csv = sweepPointsToCsv(
    makeSweepReport(
      [
        makePoint('A', { fast: 5, slow: 30 }, 812.4),
        makePoint('A', { fast: 10, slow: 30 }, -55.5),
        failed,
      ],
      axes,
    ),
  );
  const lines = csv.trimEnd().split('\n');
  expect(lines).toHaveLength(4);
  expect(lines[0]).toBe(
    'symbol,fast,slow,value,netProfit,netProfitPercent,closedTrades,winRate,' +
      'maxDrawdownPercent,profitFactor,sharpe,error',
  );
  // A run row: full precision value + strategy block, empty error cell.
  expect(lines[1]).toBe(`A,5,30,812.4,812.4,8.124,14,${8 / 14},6.3,2.18,1.42,`);
  // A failed run: empty value + strategy cells, quoted error message.
  expect(lines[3]).toBe('B,10,30,,,,,,,,,"boom, with ""quotes"""');
});

test('sweepPointsToCsv: indicator sweeps carry no strategy block', () => {
  const axes: Axis[] = [{ name: 'len', values: [7, 14] }];
  const points = [
    makePoint('A', { len: 7 }, 61.2, { strategy: undefined }),
    makePoint('A', { len: 14 }, 55.1, { strategy: undefined }),
  ];
  const csv = sweepPointsToCsv(makeSweepReport(points, axes));
  const lines = csv.trimEnd().split('\n');
  expect(lines[0]).toBe('symbol,len,value,error');
  expect(lines[1]).toBe('A,7,61.2,');
});

test('sweepHeatmap: 2-axis surface, rows × cols, missing cells print ·', () => {
  const axes: Axis[] = [
    { name: 'fast', values: [5, 10] },
    { name: 'slow', values: [30, 50] },
  ];
  // (10, 50) intentionally absent — as a sampled-out combo would be.
  const points = [
    makePoint('A', { fast: 5, slow: 30 }, 130.05),
    makePoint('A', { fast: 5, slow: 50 }, 310.9),
    makePoint('A', { fast: 10, slow: 30 }, 812.4),
  ];
  const text = sweepHeatmap(makeSweepReport(points, axes));
  const lines = text.trimEnd().split('\n');
  expect(lines[0]).toBe('strategy.netProfit by fast (rows) × slow (cols)');
  // Header row carries the column-axis values; body rows lead with the row value.
  expect(lines[2]!.trim().split(/\s+/)).toEqual(['fast', '30', '50']);
  // Cells use the compact chart formatter (1 decimal at magnitude ≥ 10).
  expect(lines[3]!.trim().split(/\s+/)).toEqual(['5', '130.1', '310.9']);
  expect(lines[4]!.trim().split(/\s+/)).toEqual(['10', '812.4', '·']);
});

test('sweepHeatmap: color grades best green / worst red; strip → plain grid', () => {
  const axes: Axis[] = [
    { name: 'fast', values: [5, 10] },
    { name: 'slow', values: [30, 50] },
  ];
  const points = [
    makePoint('A', { fast: 5, slow: 30 }, -100),
    makePoint('A', { fast: 5, slow: 50 }, 0),
    makePoint('A', { fast: 10, slow: 30 }, 50),
    makePoint('A', { fast: 10, slow: 50 }, 900),
  ];
  const report = makeSweepReport(points, axes);
  const plain = sweepHeatmap(report);
  const colored = sweepHeatmap(report, { color: true });
  expect(colored).toContain('\x1b[31m'); // the -100 cell (worst quintile) is red
  expect(colored).toContain('\x1b[92m'); // the 900 cell (best quintile) bright green
  expect(colored.replace(/\x1b\[\d+m/g, '')).toBe(plain);
  // A flat grid has no gradient to show — color mode degrades to plain.
  const flat = makeSweepReport(
    [makePoint('A', { fast: 5, slow: 30 }, 7), makePoint('A', { fast: 5, slow: 50 }, 7)],
    [
      { name: 'fast', values: [5] },
      { name: 'slow', values: [30, 50] },
    ],
  );
  expect(sweepHeatmap(flat, { color: true })).toBe(sweepHeatmap(flat));
});

test('sweepHeatmap: one grid per symbol on a multi-symbol sweep; ≠2 axes throws', () => {
  const axes: Axis[] = [
    { name: 'fast', values: [5] },
    { name: 'slow', values: [30] },
  ];
  const text = sweepHeatmap(
    makeSweepReport(
      [makePoint('A', { fast: 5, slow: 30 }, 1), makePoint('B', { fast: 5, slow: 30 }, 2)],
      axes,
    ),
  );
  expect(text).toContain('— A');
  expect(text).toContain('— B');

  expect(() =>
    sweepHeatmap(
      makeSweepReport([makePoint('A', { fast: 5 }, 1)], [{ name: 'fast', values: [5] }]),
    ),
  ).toThrow(/exactly two/);
});
