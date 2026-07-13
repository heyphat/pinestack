// test/portfolio-fixture.ts  — run from packages/pinerun/:  bun run test/portfolio-fixture.ts
import { portfolio } from '../src/index.js';
import { FIXTURE_SYMBOLS, fixtureProvider } from './fixtures.js';

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

const report = await portfolio({
  source: SMA,
  symbols: FIXTURE_SYMBOLS, // UPTREND, DOWNTREND, CHOP, VOLATILE, MEANREV
  timeframe: '1h', // fixture bars are 1h
  provider: fixtureProvider(), // StaticProvider seeded from the fixture
  mode: 'isolated',
  capital: 50000,
});

console.log(
  JSON.stringify(
    {
      mode: report.mode,
      initialCapital: report.initialCapital,
      netProfit: report.summary.netProfit,
      sleeves: report.sleeves.map((s) => ({
        symbol: s.symbol,
        funding: s.funding,
        netProfit: s.netProfit,
        closedTrades: s.closedTrades,
        marginCalls: s.marginCalls,
        contributionPercent: s.contributionPercent,
        returnCorrelation: s.returnCorrelation,
        // arrays summarized so the dump stays readable
        equityCurve: {
          length: s.equityCurve.length,
          first: s.equityCurve[0],
          last: s.equityCurve.at(-1),
        },
        barTimes: { length: s.barTimes.length, first: s.barTimes[0], last: s.barTimes.at(-1) },
        trades: { length: s.trades.length, first: s.trades[0] },
      })),
      fetchErrors: report.fetchErrors,
    },
    null,
    2,
  ),
);
