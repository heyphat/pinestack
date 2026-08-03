/**
 * A WORKING every-update (`calc_on_every_tick`) run.
 *
 * `05-every-update-lower-bars.json` shows that this cadence cannot be driven from
 * `pinelive run --config`: the CLI builds its ReplayProvider with only
 * `cutoverTime`/`paceMs`/instrument metadata, so the provider has no update trace
 * and the live stream ends immediately with zero evaluations.
 *
 * The library API can supply that trace. This script builds one from the same
 * checked-in 1h CSV fixture — several forming revisions per bar, then the bar's
 * authoritative final — and runs the compute-only intrabar server over it, so you
 * can watch the strategy being re-evaluated intrabar.
 *
 *   bun examples/pinelive/every-update-runner.ts
 *   bun examples/pinelive/every-update-runner.ts --revisions 6 --bars 5
 *
 * Two things this demonstrates that the config cases cannot:
 *
 *   1. Multiple evaluations per chart bar, each with its own revision number and
 *      its own target. piner rolls broker state back to the last committed bar
 *      before each revision, so a forming target can appear and then vanish.
 *   2. `calc_on_every_tick` is inert in piner. The engine re-executes on every
 *      update it is handed regardless of the flag; the cadence comes entirely from
 *      what Pinelive feeds it. The flag is a consent gate in Pinelive's config.
 *
 * Only the forming path is synthetic here. Every `isClose` update is the exact CSV
 * bar — ReplayProvider rejects any final that disagrees with authoritative history.
 */
import { readFileSync } from 'node:fs';
import { ReplayProvider, type Bar, type BarUpdate } from '@heyphat/pinery';
import { CsvProvider } from '@heyphat/pinery/node';
import { MemoryLedger, prepareIntrabarRun, runIntrabarServer } from '@heyphat/pinelive';

const DATA_DIR = 'examples/data';
const SYMBOL = 'BTCUSDT';
const TIMEFRAME = '1h';
const WARMUP_BARS = 60;
/** 60 warmup + 100 live bars out of the 600-bar fixture. */
const CUTOVER_TIME = 1_705_867_200;
const NATIVE = { kind: 'native' } as const;

function intArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`--${name} must be a positive integer`);
  }
  return value;
}

/** Revisions per chart bar, including the authoritative final. */
const REVISIONS = intArg('revisions', 4);
/** How many chart bars to print before summarizing the rest. */
const PRINT_BARS = intArg('bars', 4);

function stringArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new RangeError(`--${name} requires a value`);
  return value;
}

/**
 * Any strategy with `calc_on_every_tick=true`. Try both:
 *   intrabar-sma-cross.pine        process_orders_on_close=true
 *   intrabar-sma-cross-pooc-off.pine   process_orders_on_close default (false)
 * The two produce very different forming behavior — see the README.
 */
const STRATEGY = stringArg('strategy', 'examples/pinelive/intrabar-sma-cross.pine');

function readFixtureBars(): readonly Bar[] {
  const text = readFileSync(`${DATA_DIR}/${SYMBOL}_${TIMEFRAME}.csv`, 'utf8');
  const [header, ...lines] = text.trim().split('\n');
  if (header !== 'time,open,high,low,close,volume') {
    throw new Error(`unexpected fixture header: ${header}`);
  }
  return lines.map((line: string) => {
    const [time, open, high, low, close, volume] = line.split(',').map(Number);
    return { time: time!, open: open!, high: high!, low: low!, close: close!, volume: volume! };
  });
}

/**
 * Build one chart bar's forming path.
 *
 * The price zig-zags between the bar's eventual extremes instead of walking
 * straight to the close, because a monotone path cannot show what this cadence is
 * for: a forming target that appears and then disappears before the bar closes.
 * Every forming close stays inside the final bar's own [low, high], and the
 * running high/low widen monotonically, so the authoritative final always contains
 * the path that produced it.
 *
 * The last revision is the untouched fixture bar — ReplayProvider rejects any
 * final that disagrees with authoritative history.
 */
function formingPath(bar: Bar): readonly BarUpdate[] {
  const updates: BarUpdate[] = [];
  let high = bar.open;
  let low = bar.open;
  for (let revision = 1; revision <= REVISIONS; revision++) {
    const isClose = revision === REVISIONS;
    const fraction = revision / REVISIONS;
    // Odd revisions probe the eventual high, even revisions probe the eventual low.
    const close =
      revision % 2 === 1
        ? bar.open + (bar.high - bar.open) * fraction
        : bar.open - (bar.open - bar.low) * fraction;
    high = Math.max(high, close);
    low = Math.min(low, close);
    updates.push(
      Object.freeze({
        bar: Object.freeze(
          isClose
            ? { ...bar }
            : {
                time: bar.time,
                open: bar.open,
                high,
                low,
                close,
                volume: bar.volume * fraction,
              },
        ),
        isClose,
        revision,
        // Distinct, increasing observation times within the bar.
        eventTime: bar.time * 1_000 + revision * 1_000,
        source: NATIVE,
      }),
    );
  }
  return updates;
}

interface Observed {
  readonly barTime: number;
  readonly revision: number;
  readonly finalCommit: boolean;
  readonly target: number;
  readonly executable: boolean;
  readonly reason: string;
}

async function main(): Promise<void> {
  const fixture = readFixtureBars();
  const liveBars = fixture.filter((bar) => bar.time >= CUTOVER_TIME);
  const trace = liveBars.flatMap(formingPath);

  const source = new CsvProvider({ dir: DATA_DIR });
  const provider = new ReplayProvider(source, {
    cutoverTime: CUTOVER_TIME,
    // The piece `createNodeMarketDataProvider` never supplies.
    updates: { [`${SYMBOL}|${TIMEFRAME}`]: trace },
  });

  const prepared = prepareIntrabarRun(
    {
      configVersion: 3,
      strategy: STRATEGY,
      symbol: SYMBOL,
      timeframe: TIMEFRAME,
      warmupBars: WARMUP_BARS,
      data: { provider: 'csv', dataDir: DATA_DIR, cutoverTime: CUTOVER_TIME },
      historical: { mode: 'standard' },
      // throttleMs 0 keeps every forming revision; finals always bypass the throttle.
      live: { cadence: 'every-update', source: NATIVE, throttleMs: 0 },
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
        executable: evaluation.executable,
        reason: evaluation.reason,
      });
    },
  });

  const finals = observed.filter((item) => item.finalCommit);
  const forming = observed.filter((item) => !item.finalCommit);
  const barTimes = [...new Set(observed.map((item) => item.barTime))];
  const changed = new Set<number>();
  for (const bar of barTimes) {
    const targets = new Set(observed.filter((i) => i.barTime === bar).map((i) => i.target));
    if (targets.size > 1) changed.add(bar);
  }

  console.log(
    `chart bars=${liveBars.length} revisions/bar=${REVISIONS} ` +
      `trace updates=${trace.length} evaluations=${result.evaluations}`,
  );
  // Forming updates are coalesced under load; only finals are non-droppable. So the
  // evaluation count is normally BELOW the trace length, and some bars are missing
  // low revision numbers. Every chart bar still gets exactly one final.
  console.log(
    `dropped/coalesced forming updates=${trace.length - observed.length} ` +
      `(finals delivered=${finals.length}/${liveBars.length})\n`,
  );

  // Show bars where the forming target actually moved before the close — the whole
  // point of the cadence. Fall back to the first bars if the run had none.
  const interesting = [...changed].sort((a, b) => a - b).slice(0, PRINT_BARS);
  const printed = new Set(interesting.length > 0 ? interesting : barTimes.slice(0, PRINT_BARS));
  console.log(
    interesting.length > 0
      ? `bars whose target changed mid-bar (${changed.size} of ${barTimes.length}):`
      : 'no target changed mid-bar; showing the first bars instead:',
  );
  console.log('barTime     rev  phase    target      executable  reason');
  let previous: number | undefined;
  for (const item of observed) {
    if (!printed.has(item.barTime)) continue;
    if (previous !== undefined && item.barTime !== previous) console.log('');
    previous = item.barTime;
    const moved = item.target !== observed.find((i) => i.barTime === item.barTime)!.target;
    console.log(
      `${item.barTime}  ${String(item.revision).padStart(3)}  ` +
        `${(item.finalCommit ? 'final' : 'forming').padEnd(7)}  ` +
        `${item.target.toFixed(6).padStart(10)}  ` +
        `${String(item.executable).padEnd(10)}  ${item.reason}${moved ? '   <- revised' : ''}`,
    );
  }

  console.log(
    `\nforming evaluations=${forming.length} final evaluations=${finals.length}` +
      `\nforming evaluations marked executable=${forming.filter((i) => i.executable).length}`,
  );
  console.log(
    '\nUnder compute-only nothing is submitted. Under mirrored execution every one of' +
      `\nthose ${forming.length} forming evaluations would be journaled as skipped with reason` +
      '\n"mirrorOn=bar-close" — only the finals can move a position.',
  );
}

await main();
