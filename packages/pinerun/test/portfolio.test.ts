import { test, expect } from 'bun:test';
import { StaticProvider } from '@heyphat/pinery';
import { portfolio, backtest, combineEquity, type Sleeve } from '../src/index.js';
import { T0, makeSine, hourly } from './fixtures.js';

/** Gate V5 (portfolio plan §9): pinerun end-to-end over StaticProvider. Proves
 *  the ORCHESTRATION — fetch fan-out, security resolution, weights, fetch-error
 *  dropping — and ties the stack together: isolated portfolio() equals the
 *  per-symbol backtest() runs combined by align.ts (the pinerun-level oracle;
 *  piner's own V3 proves the engine matches this arithmetic bit-for-bit). */

const SMA = `//@version=6
strategy("SMA cross", initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
fast = ta.sma(close, 5)
slow = ta.sma(close, 20)
if ta.crossover(fast, slow)
    strategy.entry("long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("long")
plot(fast)
`;

function provider3() {
  return new StaticProvider({
    A: makeSine(200, T0, 25, 0),
    B: makeSine(200, T0, 15, 7),
    C: makeSine(200, T0, 10, 13),
  });
}

test('isolated equal-weight: initialCapital = N·C, netProfit = Σ sleeves', async () => {
  const report = await portfolio({
    source: SMA,
    symbols: ['A', 'B', 'C'],
    timeframe: '1h',
    provider: provider3(),
  });
  expect(report.mode).toBe('isolated');
  expect(report.initialCapital).toBe(30000); // 3 × 10000
  expect(report.sleeves).toHaveLength(3);
  const sumNet = report.sleeves.reduce((a, s) => a + s.netProfit, 0);
  expect(report.summary.netProfit).toBeCloseTo(sumNet, 6);
  expect(report.sleeves.every((s) => s.funding === 10000)).toBe(true);
  expect(report.summary.closedTrades).toBe(report.sleeves.reduce((a, s) => a + s.closedTrades, 0));
});

test('isolated portfolio() === per-symbol backtest() combined by align.ts (the oracle)', async () => {
  const symbols = ['A', 'B', 'C'];
  const port = await portfolio({ source: SMA, symbols, timeframe: '1h', provider: provider3() });

  // Independent per-symbol runs, each funded at the script's C=10000 — exactly
  // what equal-weight isolated funds each sleeve (N·C / N = C).
  const p = provider3();
  const sleeves: Sleeve[] = [];
  const soloNet: number[] = [];
  for (const sym of symbols) {
    const bt = await backtest({ source: SMA, symbol: sym, timeframe: '1h', provider: p });
    const r = bt.result!;
    sleeves.push({
      symbol: sym,
      barTimes: r.barTimes!,
      equityCurve: r.equityCurve!,
      initialCapital: r.strategy!.initialCapital,
    });
    soloNet.push(r.strategy!.netProfit);
  }
  const oracle = combineEquity(sleeves);

  expect(port.equityCurve.length).toBe(oracle.equity.length);
  expect(port.equityCurve[0]).toBeCloseTo(30000, 6); // Σ Cᵢ, pre-activation cash
  for (let k = 0; k < oracle.equity.length; k++)
    expect(port.equityCurve[k]).toBeCloseTo(oracle.equity[k]!, 6);
  // per-sleeve net profit (realized) matches the independent backtests
  for (let i = 0; i < symbols.length; i++)
    expect(port.sleeves[i]!.netProfit).toBeCloseTo(soloNet[i]!, 6);
});

test('merged ledger: symbol-tagged, exit-time sorted, cumProfit re-accumulated', async () => {
  const report = await portfolio({
    source: SMA,
    symbols: ['A', 'B', 'C'],
    timeframe: '1h',
    provider: provider3(),
  });
  const t = report.trades;
  expect(t.length).toBeGreaterThan(0);
  let cum = 0;
  for (let i = 0; i < t.length; i++) {
    if (i > 0) expect(t[i]!.exitTime).toBeGreaterThanOrEqual(t[i - 1]!.exitTime);
    expect(['A', 'B', 'C']).toContain(t[i]!.symbol);
    cum += t[i]!.profit;
    expect(t[i]!.cumProfit).toBeCloseTo(cum, 6);
  }
});

test('weighted funding maps by symbol and funds wᵢ·P', async () => {
  const report = await portfolio({
    source: SMA,
    symbols: ['A', 'B', 'C'],
    timeframe: '1h',
    provider: provider3(),
    capital: 60000,
    weights: { A: 0.5, B: 0.3, C: 0.2 },
  });
  const byS = Object.fromEntries(report.sleeves.map((s) => [s.symbol, s.funding]));
  expect(byS.A).toBeCloseTo(30000, 6);
  expect(byS.B).toBeCloseTo(18000, 6);
  expect(byS.C).toBeCloseTo(12000, 6);
  expect(report.initialCapital).toBe(60000);
});

test('weights that do not sum to 1 are normalized', async () => {
  const report = await portfolio({
    source: SMA,
    symbols: ['A', 'B'],
    timeframe: '1h',
    provider: provider3(),
    capital: 20000,
    weights: { A: 3, B: 1 }, // → 0.75 / 0.25
  });
  const byS = Object.fromEntries(report.sleeves.map((s) => [s.symbol, s.funding]));
  expect(byS.A).toBeCloseTo(15000, 6);
  expect(byS.B).toBeCloseTo(5000, 6);
});

test('shared mode differs from isolated and carries the pot; sleeves funding=0', async () => {
  const iso = await portfolio({
    source: SMA,
    symbols: ['A', 'B', 'C'],
    timeframe: '1h',
    provider: provider3(),
    mode: 'isolated',
  });
  const shared = await portfolio({
    source: SMA,
    symbols: ['A', 'B', 'C'],
    timeframe: '1h',
    provider: provider3(),
    mode: 'shared',
  });
  expect(shared.mode).toBe('shared');
  expect(shared.initialCapital).toBe(30000);
  expect(shared.sleeves.every((s) => s.funding === 0)).toBe(true);
  expect(shared.sleeves.every((s) => Number.isNaN(s.returnCorrelation))).toBe(true);
  // percent-of-equity sizing on the shared pot → a genuinely different backtest
  expect(shared.summary.netProfit).not.toBeCloseTo(iso.summary.netProfit, 2);
});

test('ragged date ranges align without throwing; curve seeds at Σ capital', async () => {
  const provider = new StaticProvider({
    A: makeSine(200, T0, 25, 0),
    B: makeSine(120, T0, 15, 7), // shorter history
    C: makeSine(160, T0, 10, 13),
  });
  const report = await portfolio({
    source: SMA,
    symbols: ['A', 'B', 'C'],
    timeframe: '1h',
    provider,
  });
  // master axis = the longest sleeve's length (aligned times are identical here)
  expect(report.times.length).toBe(200);
  expect(report.equityCurve.length).toBe(200);
  expect(report.equityCurve.every((v) => Number.isFinite(v))).toBe(true);
  expect(report.equityCurve[0]).toBeCloseTo(30000, 6);
});

test('portfolio Sharpe/Calmar come back finite', async () => {
  const report = await portfolio({
    source: SMA,
    symbols: ['A', 'B', 'C'],
    timeframe: '1h',
    provider: provider3(),
    metrics: { periodsPerYear: 8760 },
  });
  expect(Number.isFinite(report.metrics.sharpe)).toBe(true);
  expect(Number.isFinite(report.metrics.calmar)).toBe(true);
  // portfolio drawdown is close-to-close (plan §7); maxDrawdownCloseToClose is in
  // MONEY, summary.maxDrawdownPercent is peak-relative — both finite, both > 0.
  expect(report.metrics.maxDrawdownCloseToClose).toBeGreaterThan(0);
  expect(report.metrics.maxDrawdownCloseToClose).toBeLessThan(report.initialCapital);
  expect(report.summary.maxDrawdownPercent).toBeGreaterThan(0);
  expect(report.summary.maxDrawdownPercent).toBeLessThan(100);
});

test('a failed fetch drops that sleeve; the rest still combine', async () => {
  const dropped: string[] = [];
  const report = await portfolio({
    source: SMA,
    symbols: ['A', 'MISSING', 'C'],
    timeframe: '1h',
    provider: provider3(), // no "MISSING" symbol → history() throws
    onFetchError: (sym) => dropped.push(sym),
  });
  expect(dropped).toEqual(['MISSING']);
  expect(report.fetchErrors.map((e) => e.symbol)).toEqual(['MISSING']);
  expect(report.sleeves.map((s) => s.symbol)).toEqual(['A', 'C']);
  expect(report.initialCapital).toBe(20000); // funded per surviving sleeve
});

test('empty basket / no-history basket throws', async () => {
  await expect(
    portfolio({ source: SMA, symbols: [], timeframe: '1h', provider: provider3() }),
  ).rejects.toThrow(/no symbols/);
  await expect(
    portfolio({ source: SMA, symbols: ['MISSING'], timeframe: '1h', provider: provider3() }),
  ).rejects.toThrow(/no symbols with history/);
});

test('an indicator script is rejected', async () => {
  await expect(
    portfolio({
      source: '//@version=6\nindicator("i")\nplot(close)\n',
      symbols: ['A'],
      timeframe: '1h',
      provider: provider3(),
    }),
  ).rejects.toThrow(/indicator/);
});

test('weights missing a symbol is an error', async () => {
  await expect(
    portfolio({
      source: SMA,
      symbols: ['A', 'B'],
      timeframe: '1h',
      provider: provider3(),
      weights: { A: 1 }, // B missing
    }),
  ).rejects.toThrow(/missing symbols: B/);
});

// ── request.security under the portfolio engine ──────────────
// DIFFERENTIAL by design (2026-07-09 audit #2): the gate must actually FIRE
// when the dependency resolves, so a broken securityBars injection cannot pass.
const CROSS_DEP = `//@version=6
strategy("cross-dep", initial_capital=10000)
spx = request.security("SPX", "D", close)
if not na(spx) and close > spx
    strategy.entry("L", strategy.long)
if bar_index == 60
    strategy.close("L")
plot(spx, "spx")
`;
// SPX base 90 → day-0's confirmed daily close (bar 23) = 113, visible from bar
// 24. A's close 100..171 and B's 130..201 both exceed 113 there → entries fire
// (fill next bar), closed at bar 60. With resolution OFF, spx is na on every
// bar → the gate never opens → zero trades. Same data, two worlds.
function crossDepProvider() {
  return new StaticProvider({
    A: hourly(72, 100),
    B: hourly(72, 130),
    SPX: hourly(72, 90),
  });
}

test('each sleeve resolves its own cross-symbol request.security — and trades off it', async () => {
  const report = await portfolio({
    source: CROSS_DEP,
    symbols: ['A', 'B'],
    timeframe: '1h',
    provider: crossDepProvider(),
  });
  expect(report.sleeves.map((s) => s.symbol)).toEqual(['A', 'B']);
  // the SPX gate actually fired in EVERY sleeve — this is what proves injection
  for (const s of report.sleeves) expect(s.closedTrades).toBeGreaterThan(0);
  expect(report.summary.netProfit).not.toBe(0);
});

test('resolution off: the dependency degrades to na, the gate never opens (differential)', async () => {
  const report = await portfolio({
    source: CROSS_DEP,
    symbols: ['A', 'B'],
    timeframe: '1h',
    provider: crossDepProvider(),
    resolveSecurity: false,
  });
  expect(report.sleeves).toHaveLength(2); // run stays alive
  for (const s of report.sleeves) expect(s.closedTrades).toBe(0); // …but nothing trades
  // equity never leaves the funding level — no positions were ever opened
  expect(report.equityCurve.every((v) => v === 20000)).toBe(true);
});
