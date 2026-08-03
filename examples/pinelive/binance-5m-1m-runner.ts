/**
 * A 5m chart driven by REAL 1m bars from Binance — the shape you actually want.
 *
 * REQUIRES NETWORK. Everything else in this folder is offline.
 *
 *   bun examples/pinelive/binance-5m-1m-runner.ts
 *   bun examples/pinelive/binance-5m-1m-runner.ts --strategy examples/pinelive/intrabar-sma-cross.pine
 *   bun examples/pinelive/binance-5m-1m-runner.ts --market futures --bars 3
 *
 * Why this is not just `pinelive run --config`:
 *
 *   Binance is a HISTORY-ONLY provider. `createMarketDataProvider` refuses it for a
 *   live run ("provider \"binance\" is historical-only"), and it implements no
 *   `liveBars()`. So there is no configuration that streams Binance into the
 *   intrabar cadence. What this script does instead is fetch real 1m history and
 *   replay it as the lower-bars child stream, which exercises the exact aggregation,
 *   conformance, and evaluation path a real feed would drive.
 *
 * Nothing here is synthetic. The forming path of each 5m bar is its five actual 1m
 * bars, in order. The 5m series is derived from those 1m bars by the same
 * aggregation the runtime asserts on (`aggregateBar`: open=first, high=max, low=min,
 * close=last, volume=sum), so the authoritative finals cannot disagree with their
 * children. The script also fetches Binance's own 5m klines and reports whether they
 * match that aggregation bar-for-bar.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BinanceProvider, ReplayProvider, type Bar, type BarUpdate } from '@heyphat/pinery';
import { CsvProvider } from '@heyphat/pinery/node';
import { MemoryLedger, prepareIntrabarRun, runIntrabarServer } from '@heyphat/pinelive';

const SYMBOL = 'BTCUSDT';
const CHART_TF = '5m';
const CHILD_TF = '1m';
const CHILD_PER_CHART = 5;
const CHART_SECONDS = 300;
/** 1,000 1m bars is one Binance request and yields 200 complete 5m buckets. */
const CHILD_BARS = 1_000;
const WARMUP_CHART_BARS = 60;
const LOWER_BARS = { kind: 'lower-bars', timeframe: CHILD_TF } as const;

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new RangeError(`--${name} requires a value`);
  return value;
}

const STRATEGY = arg('strategy', 'examples/pinelive/intrabar-stop-entry.pine');
const MARKET = arg('market', 'spot') as 'spot' | 'futures';
const PRINT_BARS = Number(arg('bars', '4'));
const WORK_DIR = arg('dir', '.pinelive/binance-data');

/** Group 1m bars into complete, UTC-aligned 5m buckets. Partial buckets are dropped. */
function bucketChildren(children: readonly Bar[]): Map<number, readonly Bar[]> {
  const buckets = new Map<number, Bar[]>();
  for (const bar of children) {
    const open = Math.floor(bar.time / CHART_SECONDS) * CHART_SECONDS;
    const slot = buckets.get(open) ?? [];
    slot.push(bar);
    buckets.set(open, slot);
  }
  const complete = new Map<number, readonly Bar[]>();
  for (const [open, slot] of [...buckets].sort(([a], [b]) => a - b)) {
    const ordered = [...slot].sort((left, right) => left.time - right.time);
    const contiguous =
      ordered.length === CHILD_PER_CHART &&
      ordered.every((bar, index) => bar.time === open + index * 60);
    if (contiguous) complete.set(open, ordered);
  }
  return complete;
}

/** The exact aggregation `ExactChildBarAggregator.finalize` asserts against. */
function aggregate(open: number, members: readonly Bar[]): Bar {
  return {
    time: open,
    open: members[0]!.open,
    high: Math.max(...members.map((bar) => bar.high)),
    low: Math.min(...members.map((bar) => bar.low)),
    close: members[members.length - 1]!.close,
    volume: members.reduce((total, bar) => total + bar.volume, 0),
  };
}

function sameBar(left: Bar, right: Bar): boolean {
  return (
    left.time === right.time &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close
  );
}

function writeCsvFixture(dir: string, bars: readonly Bar[]): void {
  mkdirSync(dir, { recursive: true });
  const rows = bars.map(
    (bar) => `${bar.time},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume}`,
  );
  writeFileSync(
    `${dir}/${SYMBOL}_${CHART_TF}.csv`,
    `time,open,high,low,close,volume\n${rows.join('\n')}\n`,
  );
  writeFileSync(`${dir}/instruments.csv`, `symbol,minQty,mintick\n${SYMBOL},0.00001,0.01\n`);
}

interface Observed {
  readonly barTime: number;
  readonly revision: number;
  readonly finalCommit: boolean;
  readonly target: number;
  readonly reason: string;
}

async function main(): Promise<void> {
  const binance = new BinanceProvider({ market: MARKET });
  console.log(`fetching real ${SYMBOL} data from ${binance.id} ...`);
  const [children, vendorChart] = await Promise.all([
    binance.history(SYMBOL, CHILD_TF, { limit: CHILD_BARS }),
    binance.history(SYMBOL, CHART_TF, { limit: Math.ceil(CHILD_BARS / CHILD_PER_CHART) }),
  ]);

  const buckets = bucketChildren(children);
  const chart = [...buckets].map(([open, members]) => aggregate(open, members));
  if (chart.length <= WARMUP_CHART_BARS + 5) {
    throw new Error(`only ${chart.length} complete ${CHART_TF} buckets; need more child history`);
  }

  // Independent check: does the vendor's own 5m series equal the 1m aggregation?
  const vendorByTime = new Map(vendorChart.map((bar) => [bar.time, bar] as const));
  const comparable = chart.filter((bar) => vendorByTime.has(bar.time));
  const matching = comparable.filter((bar) => sameBar(bar, vendorByTime.get(bar.time)!));
  console.log(
    `child ${CHILD_TF} bars=${children.length} complete ${CHART_TF} buckets=${chart.length}\n` +
      `vendor ${CHART_TF} bars compared=${comparable.length} ` +
      `identical to 1m aggregation=${matching.length}` +
      (matching.length === comparable.length ? ' (exact)' : ' (MISMATCH — see note below)'),
  );

  const cutoverTime = chart[WARMUP_CHART_BARS]!.time;
  const liveChart = chart.filter((bar) => bar.time >= cutoverTime);
  writeCsvFixture(WORK_DIR, chart);

  // Each real 1m bar becomes one authoritative child update.
  const trace: BarUpdate[] = [];
  for (const [, members] of buckets) {
    for (const bar of members) {
      trace.push(
        Object.freeze({
          bar: Object.freeze({ ...bar }),
          isClose: true,
          revision: 1,
          eventTime: (bar.time + 60) * 1_000,
          source: LOWER_BARS,
        }),
      );
    }
  }

  const provider = new ReplayProvider(new CsvProvider({ dir: WORK_DIR }), {
    cutoverTime,
    updates: { [`${SYMBOL}|${CHILD_TF}`]: trace },
    // Binance klines are UTC-aligned, so a fixed zero anchor is exact evidence.
    lowerBars: { anchorTime: 0 },
    instrument: { minOrderQty: 0.00001 },
  });

  const prepared = prepareIntrabarRun(
    {
      configVersion: 3,
      strategy: STRATEGY,
      symbol: SYMBOL,
      timeframe: CHART_TF,
      warmupBars: WARMUP_CHART_BARS,
      data: { provider: 'csv', dataDir: WORK_DIR, cutoverTime },
      historical: { mode: 'standard' },
      live: { cadence: 'every-update', source: LOWER_BARS, throttleMs: 0 },
      security: { enabled: false },
      execution: { kind: 'compute-only' },
    } as const,
    readFileSync(STRATEGY, 'utf8'),
  );

  const observed: Observed[] = [];
  const result = await runIntrabarServer({
    prepared,
    dataFactory: () => provider,
    ledger: new MemoryLedger(),
    onEvaluation: (evaluation) => {
      observed.push({
        barTime: evaluation.update.barTime,
        revision: evaluation.update.revision,
        finalCommit: evaluation.finalCommit,
        target: evaluation.target,
        reason: evaluation.reason,
      });
    },
  });

  const finals = observed.filter((item) => item.finalCommit);
  const forming = observed.filter((item) => !item.finalCommit);
  const barTimes = [...new Set(observed.map((item) => item.barTime))];
  const changed = barTimes.filter((bar) => {
    const targets = observed.filter((item) => item.barTime === bar).map((item) => item.target);
    return new Set(targets).size > 1;
  });

  const span = (time: number): string => new Date(time * 1_000).toISOString().slice(0, 16);
  console.log(
    `\nstrategy=${STRATEGY}\n` +
      `window=${span(cutoverTime)} .. ${span(liveChart.at(-1)!.time)} UTC\n` +
      `live ${CHART_TF} bars=${liveChart.length} child updates in window=${liveChart.length * CHILD_PER_CHART}\n` +
      `evaluations=${result.evaluations} (forming=${forming.length} final=${finals.length})\n` +
      `bars whose target changed mid-bar=${changed.length} of ${barTimes.length}`,
  );

  const show = (changed.length > 0 ? changed : barTimes).slice(0, PRINT_BARS);
  console.log(
    changed.length > 0 ? '\nbars where the target moved before the close:' : '\nfirst bars:',
  );
  console.log('barTime     UTC               rev  phase    target      reason');
  for (const bar of show) {
    for (const item of observed.filter((entry) => entry.barTime === bar)) {
      console.log(
        `${item.barTime}  ${span(item.barTime)}  ${String(item.revision).padStart(3)}  ` +
          `${(item.finalCommit ? 'final' : 'forming').padEnd(7)}  ` +
          `${item.target.toFixed(6).padStart(10)}  ${item.reason}`,
      );
    }
    console.log('');
  }

  console.log(
    `CSV fixture and instruments written to ${WORK_DIR}/ — delete it when done.\n` +
      'Compute-only: nothing was submitted. Under mirrored execution every one of those\n' +
      `${forming.length} forming evaluations would be journaled as skipped (mirrorOn=bar-close).`,
  );
}

await main();
