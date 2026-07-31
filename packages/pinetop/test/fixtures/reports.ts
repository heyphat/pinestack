/**
 * Report fixtures shaped exactly like `pinerun --json` emits.
 *
 * These mirror the emission sites in `pinerun/src/cli.ts` field for field. They
 * are deliberately hand-written rather than recorded: a recorded payload would
 * drift silently, whereas a hand-written one that stops matching the CLI is a
 * test that fails with a name pointing at the field.
 */

import type { StrategyMetrics, StrategySummary, StrategyTrade } from '@heyphat/pinerun';
import type {
  BacktestJson,
  CompareJson,
  PortfolioJson,
  ScanJson,
  SweepJson,
  WalkforwardJson,
} from '../../src/views/report.js';

const HOUR = 3_600;
const START = Date.UTC(2019, 0, 1) / 1000;

export function metrics(overrides: Partial<StrategyMetrics> = {}): StrategyMetrics {
  return {
    sharpe: 1.42,
    sortino: 2.11,
    volatilityPercent: 27.1,
    cagrPercent: 38.4,
    calmar: 2.23,
    exposurePercent: 61,
    expectancy: 142.5,
    maxConsecutiveWins: 9,
    maxConsecutiveLosses: 5,
    largestWin: 8_420,
    largestLoss: -3_180,
    avgBarsInTrade: 22.4,
    avgBarsInWinners: 26.1,
    avgBarsInLosers: 17.2,
    avgWinLossRatio: 1.61,
    largestWinPercentOfGrossProfit: 4.2,
    largestLossPercentOfGrossLoss: 3.1,
    netProfitPercentOfLargestLoss: 610,
    returnOnInitialCapitalPercent: 98.4,
    buyHoldReturnPercent: 41.2,
    buyHoldPnL: 412_000,
    outperformance: 186_000,
    maxRunupPercentOfInitialCapital: 44.1,
    maxDrawdownPercentOfInitialCapital: 17.2,
    maxRunupCloseToClose: 210_400,
    maxDrawdownCloseToClose: 172_000,
    avgRunupCloseToClose: 24_100,
    avgDrawdownCloseToClose: 18_900,
    avgRunupDurationDays: 12.4,
    avgDrawdownDurationDays: 9.8,
    periodsPerYear: 8_760,
    ...overrides,
  };
}

export function summary(overrides: Partial<StrategySummary> = {}): StrategySummary {
  return {
    initialCapital: 1_000_000,
    netProfit: 984_000,
    netProfitPercent: 98.4,
    grossProfit: 2_610_000,
    grossProfitPercent: 261,
    grossLoss: -1_626_000,
    grossLossPercent: -162.6,
    profitFactor: 1.61,
    wins: 704,
    losses: 580,
    evens: 0,
    closedTrades: 1_284,
    winRate: 0.548,
    avgTrade: 766,
    avgTradePercent: 0.08,
    avgWinningTrade: 3_707,
    avgLosingTrade: -2_803,
    maxDrawdown: 172_000,
    maxDrawdownPercent: 17.2,
    maxRunup: 210_400,
    maxRunupPercent: 21.04,
    maxContractsHeld: 12.4,
    totalCommission: 41_200,
    barsProcessed: 51_840,
    barsInMarket: 31_622,
    metrics: metrics(),
    ...overrides,
  };
}

/** A short but real-shaped equity curve with a drawdown in the middle. */
function curve(n = 400): { equity: number[]; times: number[]; closes: number[] } {
  const equity: number[] = [];
  const times: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const drift = 1 + 0.98 * t;
    const dip = t > 0.45 && t < 0.62 ? -0.17 * Math.sin(((t - 0.45) / 0.17) * Math.PI) : 0;
    equity.push(1_000_000 * (drift + dip));
    times.push(START + i * HOUR * 144);
    closes.push(20_000 * (1 + 1.1 * t) + 4_000 * Math.sin(t * 9));
  }
  return { equity, times, closes };
}

export function trades(count = 24): StrategyTrade[] {
  const out: StrategyTrade[] = [];
  let cum = 0;
  for (let i = 0; i < count; i++) {
    const profit = i % 3 === 0 ? -1_820 - i * 11 : 2_640 + i * 17;
    cum += profit;
    out.push({
      entryId: `t-${i + 1}`,
      dir: i % 4 === 0 ? -1 : 1,
      qty: 0.5 + (i % 5) * 0.25,
      entryPrice: 38_400 + i * 90,
      exitPrice: 38_400 + i * 90 + profit / 10,
      entryBar: i * 12,
      exitBar: i * 12 + 8,
      entryTime: START + i * HOUR * 140,
      exitTime: START + i * HOUR * 140 + HOUR * 8,
      profit,
      cumProfit: cum,
      commission: 32 + i,
      maxRunup: Math.abs(profit) * 1.4,
      maxDrawdown: Math.abs(profit) * 0.6,
    });
  }
  return out;
}

/** `pinerun backtest --json` → the RunResult plus elapsedMs. */
export function backtestReport(): BacktestJson {
  const { equity, times, closes } = curve();
  return {
    id: 'run-1',
    symbol: 'BTC-PERP',
    timeframe: '1h',
    ok: true,
    bars: 51_840,
    strategy: summary(),
    trades: trades(),
    equityCurve: equity,
    barTimes: times,
    closes,
    elapsedMs: 8_140,
  };
}

/** `pinerun sweep --json`. */
export function sweepReport(): SweepJson {
  const { equity } = curve(120);
  const combos = [
    { fast: 10, slow: 50, value: 984_000 },
    { fast: 5, slow: 50, value: 812_400 },
    { fast: 10, slow: 80, value: 706_100 },
    { fast: 20, slow: 30, value: -122_000 },
  ];
  return {
    symbol: 'BTC-PERP',
    symbols: ['BTC-PERP'],
    rank: 'strategy.netProfit',
    direction: 'desc',
    total: 12,
    combos: 12,
    gridTotal: 12,
    axes: [
      { name: 'fast', values: [5, 10, 20] },
      { name: 'slow', values: [30, 50, 80, 100] },
    ],
    ranked: combos.map((c) => ({
      symbol: 'BTC-PERP',
      inputs: { fast: c.fast, slow: c.slow },
      value: c.value,
      bars: 51_840,
      strategy: summary({ netProfit: c.value, netProfitPercent: c.value / 10_000 }),
      equityCurve: equity,
    })),
    errors: [],
    fetchErrors: [],
    elapsedMs: 42_100,
  };
}

/** `pinerun walkforward --json` — windows are stripped of their RunResults. */
export function walkforwardReport(): WalkforwardJson {
  const windows = [0, 1, 2, 3, 4].map((i) => ({
    index: i,
    isFrom: i * 800,
    isTo: i * 800 + 600,
    oosFrom: i * 800 + 600,
    oosTo: (i + 1) * 800,
    isFromTime: Date.UTC(2021 + i, 0, 1) / 1000,
    oosFromTime: Date.UTC(2023, 0, 1) / 1000,
    oosToTime: Date.UTC(2023, 5, 30) / 1000,
    winner: { fast: 10 },
    winnerId: `w-${i}`,
    winnerValue: 120_000 - i * 8_000,
    isProfitPercent: 22.4 - i * 1.8,
    oosProfitPercent: i === 3 ? -4.1 : 18.2 - i * 2.2,
    oosTrades: 120 - i * 9,
    efficiency: i === 3 ? 0.18 : 0.91 - i * 0.04,
  }));

  return {
    symbol: 'BTC-PERP',
    rank: 'strategy.netProfit',
    anchored: false,
    totalBars: 4_000,
    isBars: 600,
    oosBars: 200,
    windows,
    aggregate: {
      windows: 5,
      failed: 0,
      oosPositive: 4,
      meanIsProfitPercent: 18.8,
      meanOosProfitPercent: 11.4,
      walkForwardEfficiency: 0.86,
    },
    warnings: [],
    elapsedMs: 96_300,
  };
}

/** `pinerun scan --json`, including the reported-and-continued failures. */
export function scanReport(): ScanJson {
  const { equity } = curve(120);
  return {
    rank: 'strategy.netProfit',
    direction: 'desc',
    ranked: [
      {
        symbol: 'BTCUSDT',
        value: 984_000,
        bars: 51_840,
        strategy: summary(),
        equityCurve: equity,
      },
      {
        symbol: 'ETHUSDT',
        value: 412_000,
        bars: 51_840,
        strategy: summary({ netProfit: 412_000, netProfitPercent: 41.2 }),
        equityCurve: equity,
      },
      {
        symbol: 'SOLUSDT',
        value: -88_000,
        bars: 51_840,
        strategy: summary({ netProfit: -88_000, netProfitPercent: -8.8 }),
        equityCurve: equity,
      },
    ],
    errors: [{ symbol: 'XRPUSDT', error: 'compile error: undeclared identifier' }],
    fetchErrors: [{ symbol: 'DOGEUSDT', error: 'provider returned 451' }],
    elapsedMs: 31_400,
  };
}

/** `pinerun portfolio --json` → the PortfolioReport verbatim. */
export function portfolioReport(): PortfolioJson {
  const { equity, times } = curve(240);
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  return {
    mode: 'isolated',
    symbols,
    times,
    equityCurve: equity,
    initialCapital: 3_000_000,
    summary: summary({ initialCapital: 3_000_000 }),
    metrics: metrics(),
    trades: trades(12).map((t, i) => ({ ...t, symbol: symbols[i % symbols.length]! })),
    sleeves: symbols.map((symbol, i) => ({
      symbol,
      barsProcessed: 51_840,
      funding: 1_000_000,
      netProfit: 480_000 - i * 190_000,
      closedTrades: 428 - i * 40,
      marginCalls: i === 2 ? 1 : 0,
      contributionPercent: 0.49 - i * 0.19,
      returnCorrelation: 0.62 - i * 0.14,
      equityCurve: equity.map((v, j) => v / 3 + i * 1_000 + j),
      barTimes: times,
      trades: [],
    })),
    fetchErrors: [],
    elapsedMs: 58_200,
  };
}

/** `pinerun compare --json` → { symbol, timeframe, a, b }. */
export function compareReport(): CompareJson {
  const base = backtestReport();
  return {
    symbol: 'BTC-PERP',
    timeframe: '1h',
    a: { label: 'fast-5', result: base },
    b: {
      label: 'fast-20',
      result: {
        ...base,
        strategy: summary({
          netProfit: 412_000,
          netProfitPercent: 41.2,
          maxDrawdownPercent: 24.8,
          metrics: metrics({ sharpe: 0.94, sortino: 1.32, calmar: 1.1, cagrPercent: 19.8 }),
        }),
        equityCurve: base.equityCurve!.map((v, i) => v * 0.72 + i * 40),
      },
    },
  };
}
