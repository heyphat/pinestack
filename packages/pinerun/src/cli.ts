#!/usr/bin/env bun
/**
 * pinerun CLI. Milestone A: `scan` — run one Pine script across N symbols in
 * parallel and print a ranked table.
 *
 *   pinerun scan rsi.pine --symbols BTCUSDT,ETHUSDT,SOLUSDT --tf 1h \
 *     --from 2024-01-01 --rank "last(rsi)" --top 20
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  InstrumentRouter,
  isDataProvider,
  isAssetClass,
  supportsPair,
  assetClassesForProvider,
  type AssetClass,
  type DataProvider,
  type HistoryProvider,
  type HistoryRange,
} from '@heyphat/pinery';
import { cached } from '@heyphat/pinery/node';
import { scan, type ScanReport } from './index.js';
import { LocalRunner, parseRankSpec, rankResults, selectPlot, type Runner } from './index.js';
import { sweep, parseAxes, assertComboBudget, validateAxes, type SweepReport } from './index.js';
import { backtest } from './index.js';
import { portfolio, type PortfolioReport } from './index.js';
import { walkforward, type WalkforwardReport } from './index.js';
import type { RunResult, JobMetricsOptions, StrategyTrade } from './index.js';
import {
  tradesToCsv,
  equityToCsv,
  equityPlotHtml,
  sweepPointsToCsv,
  sweepHeatmap,
  equityChartAscii,
  priceChartAscii,
  overlayChartAscii,
  drawdownChartAscii,
  sparkline,
  monthlyReturnsAscii,
  topDrawdownsAscii,
  profitHistogramAscii,
  correlationMatrixAscii,
  alignEquity,
} from './index.js';
import {
  starterStrategy,
  isStarterTemplate,
  STARTER_TEMPLATES,
  STARTER_DESCRIPTIONS,
  SUGGESTED_FILE,
  type StarterTemplate,
} from './index.js';
import { WorkerPoolRunner } from './node.js';
import { runUpgrade } from './upgrade.js';

// Injected by scripts/build-bin.ts (`bun build --define`) so the compiled
// binary self-reports its release version + commit. Absent when running from
// source, where resolveVersion() falls back to this package's package.json.
declare const PINERUN_VERSION: string | undefined;
declare const PINERUN_REVISION: string | undefined;

/** The CLI's version — the build define, else package.json (source runs). */
function resolveVersion(): string | undefined {
  if (typeof PINERUN_VERSION === 'string') return PINERUN_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    // an exotic packaging without the define — cliVersion prints 'unknown'
    return undefined;
  }
}

/** "pinerun <version>[ (<commit>)]" for --version. */
function cliVersion(): string {
  const revision = typeof PINERUN_REVISION === 'string' ? ` (${PINERUN_REVISION})` : '';
  return `pinerun ${resolveVersion() ?? 'unknown'}${revision}`;
}

function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  // `pinerun <command> --help` / `-h` prints that command's section, rather
  // than falling through to the command and erroring on the missing script.
  if (command && command in HELP_SECTIONS && (rest.includes('--help') || rest.includes('-h'))) {
    printHelp(command);
    return Promise.resolve();
  }
  switch (command) {
    case 'init':
      runInit(rest);
      return Promise.resolve();
    case 'scan':
      return runScan(rest);
    case 'backtest':
      return runBacktest(rest);
    case 'compare':
      return runCompare(rest);
    case 'portfolio':
      return runPortfolio(rest);
    case 'sweep':
      return runSweep(rest);
    case 'walkforward':
      return runWalkforward(rest);
    case 'upgrade':
      return runUpgrade({ check: parseArgs(rest).has('check'), currentVersion: resolveVersion() });
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      printHelp();
      return Promise.resolve();
    case '-v':
    case '--version':
    case 'version':
      console.log(cliVersion());
      return Promise.resolve();
    default:
      console.error(`pinerun: unknown command "${command}"\n`);
      printHelp();
      process.exitCode = 1;
      return Promise.resolve();
  }
}

/**
 * Write a commented starter strategy to disk so a new user has a runnable script
 * without writing Pine from scratch. Refuses to clobber unless --force.
 */
function runInit(args: string[]): void {
  const opts = parseArgs(args);

  const template = (opts.get('template') ?? 'sma-cross') as StarterTemplate;
  if (!isStarterTemplate(template)) {
    fail(`init: unknown --template "${template}" (choose one of: ${STARTER_TEMPLATES.join(', ')})`);
  }
  const name = opts.get('name');
  const path = opts.positional[0] ?? SUGGESTED_FILE;

  const source = starterStrategy({ template, name });

  // --stdout: print the source without touching the filesystem (pipe / preview).
  if (opts.has('stdout')) {
    process.stdout.write(source);
    return;
  }

  if (existsSync(path) && !opts.has('force')) {
    fail(`init: ${path} already exists (use --force to overwrite, or pass a different path)`);
  }

  const dir = dirname(path);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
  writeFileSync(path, source);

  console.log(`  wrote ${path} — ${STARTER_DESCRIPTIONS[template]}`);
  console.log('');
  console.log('  next steps:');
  console.log(`    pinerun backtest ${path} --symbol BTCUSDT --tf 1h --limit 500`);
  console.log(`    pinerun scan ${path} --symbols BTCUSDT,ETHUSDT,SOLUSDT --tf 1h --limit 500`);
  console.log('');
  console.log('  the file opens with commented run recipes (sweep + walkforward included).');
}

async function runScan(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  const scriptPath = opts.positional[0];
  if (!scriptPath) fail('scan: missing <script.pine>');
  const source = readFileSync(scriptPath!, 'utf8');

  const symbols = resolveSymbols(opts);
  if (symbols.length === 0) fail('scan: no symbols (use --symbols a,b,c or --universe <file>)');

  const timeframe = opts.get('tf') ?? '1h';
  const range = buildRange(opts);
  const rankProvided = opts.get('rank') != null;
  let rank = opts.get('rank') ?? 'last';
  const direction = opts.has('asc') ? 'asc' : 'desc';
  const top = opts.getNum('top');
  const concurrency = opts.getNum('concurrency');
  const backend = (opts.get('backend') as 'js' | 'interp' | undefined) ?? 'js';
  const csvDir = opts.get('csv');
  const plotDir = opts.get('plot');
  // Exports need the ledger + equity curve, so --csv / --plot imply --trades.
  const includeTrades = opts.has('trades') || csvDir != null || plotDir != null;
  const metrics = buildMetricsOpts(opts);
  const resolveSecurity = !opts.has('no-security');
  const asJson = opts.has('json');

  const provider = buildProvider(opts);
  const runner = buildRunner(opts);

  const started = Date.now();
  const progress = makeProgress('scan');
  let report: ScanReport;
  try {
    report = await scan({
      source,
      symbols,
      timeframe,
      provider,
      range,
      rank,
      direction,
      top,
      concurrency,
      backend,
      mintick: opts.getNum('mintick'),
      minQty: opts.getNum('min-qty'),
      includeTrades,
      metrics,
      resolveSecurity,
      runner,
      onResult: progress.onResult,
      onFetchError: (symbol, error) => console.error(`  fetch failed: ${symbol} — ${error}`),
    });
  } finally {
    progress.finish();
    await runner.close();
  }
  const elapsed = Date.now() - started;

  // A strategy scan with no explicit --rank defaults to ranking by net profit.
  const isStrategy = report.results.some((r) => r.strategy);
  if (isStrategy && !rankProvided) {
    rank = 'strategy.netProfit';
    report.ranked = rankResults(report.results, parseRankSpec(rank), { direction, top });
  }

  writeExports(
    report.ranked.map((r) => ({ label: r.result.symbol, result: r.result })),
    csvDir,
    plotDir,
  );

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          rank,
          direction,
          ranked: report.ranked.map((r) => ({
            symbol: r.result.symbol,
            value: r.value,
            bars: r.result.bars,
            strategy: r.result.strategy,
            ...(r.result.trades
              ? {
                  trades: r.result.trades,
                  equityCurve: r.result.equityCurve,
                  barTimes: r.result.barTimes,
                }
              : {}),
          })),
          errors: report.errors.map((e) => ({ symbol: e.symbol, error: e.error })),
          fetchErrors: report.fetchErrors,
          elapsedMs: elapsed,
        },
        null,
        2,
      ),
    );
    return;
  }

  const spark = !opts.has('no-chart');
  if (isStrategy) printStrategyTable(report, rank, elapsed, spark);
  else printTable(report, rank, elapsed, spark);

  // With --trades on a single ranked result, print its price chart + ledger.
  if (includeTrades && report.ranked.length === 1) {
    if (spark) printPriceChart(report.ranked[0]!.result);
    printLedger(report.ranked[0]!.result);
  }
}

async function runBacktest(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  const scriptPath = opts.positional[0];
  if (!scriptPath) fail('backtest: missing <script.pine>');
  const source = readFileSync(scriptPath!, 'utf8');

  const symbol = opts.get('symbol') ?? singleSymbol(opts, 'backtest');
  if (!symbol) fail('backtest: no symbol (use --symbol BTCUSDT)');

  // Fixed input overrides: --input name=value (one value each; grids are sweep's job).
  let inputs: Record<string, unknown> | undefined;
  const axisArgs = opts.getAll('input');
  if (axisArgs.length > 0) {
    try {
      const axes = validateAxes(source, parseAxes(axisArgs), 'backtest');
      const grid = axes.find((a) => a.values.length !== 1);
      if (grid) {
        fail(
          `backtest: --input ${grid.name} has ${grid.values.length} values — ` +
            `backtest takes ONE value per input (use sweep for grids)`,
        );
      }
      inputs = Object.fromEntries(axes.map((a) => [a.name, a.values[0]]));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  const timeframe = opts.get('tf') ?? '1h';
  const range = buildRange(opts);
  const backend = (opts.get('backend') as 'js' | 'interp' | undefined) ?? 'js';
  const csvDir = opts.get('csv');
  const plotDir = opts.get('plot');
  const metrics = buildMetricsOpts(opts);
  const resolveSecurity = !opts.has('no-security');
  const asJson = opts.has('json');

  // --watch [sec]: live tearsheet — refresh history, rerun, redraw, repeat.
  const watchSec = opts.getNum('watch') ?? (opts.has('watch') ? 60 : undefined);
  if (watchSec != null) {
    if (asJson) fail('backtest: --watch and --json are incompatible (watch redraws a terminal)');
    if (process.stdout.isTTY !== true) {
      fail('backtest: --watch needs a live terminal (stdout is piped)');
    }
    const interval = Math.max(5, watchSec);
    for (;;) {
      const started = Date.now();
      const report = await backtest({
        source,
        symbol: symbol!,
        timeframe,
        provider: buildProvider(opts, true), // bypass the cache: latest bars
        range,
        inputs,
        backend,
        mintick: opts.getNum('mintick'),
        minQty: opts.getNum('min-qty'),
        metrics,
        resolveSecurity,
      });
      const elapsed = Date.now() - started;
      process.stdout.write('\x1b[2J\x1b[H'); // clear screen, cursor home
      console.log(
        `  watch: ${symbol} @ ${timeframe} — every ${interval}s, Ctrl-C to exit · ` +
          `updated ${new Date().toISOString().slice(11, 19)} UTC`,
      );
      // Transient failures (network blips) report and retry next cycle.
      if (report.fetchError) console.error(`\n  fetch failed: ${report.fetchError}`);
      else if (!report.result!.ok) console.error(`\n  run failed: ${report.result!.error}`);
      else if (!report.result!.strategy) {
        fail(
          `backtest: ${scriptPath} is an indicator (no strategy() call) — watch needs a strategy`,
        );
      } else {
        printTearsheet(report.result!, timeframe, elapsed, !opts.has('no-chart'));
        if (opts.has('trades')) printLedger(report.result!);
      }
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    }
  }

  const provider = buildProvider(opts);

  const started = Date.now();
  const report = await backtest({
    source,
    symbol: symbol!,
    timeframe,
    provider,
    range,
    inputs,
    backend,
    mintick: opts.getNum('mintick'),
    minQty: opts.getNum('min-qty'),
    metrics,
    resolveSecurity,
  });
  const elapsed = Date.now() - started;

  if (report.fetchError) fail(`backtest: fetch failed for ${symbol} — ${report.fetchError}`);
  const result = report.result!;
  if (!result.ok) {
    if (result.diagnostics) for (const d of result.diagnostics) console.error(`  ${d}`);
    fail(`backtest: ${result.error}`);
  }
  if (!result.strategy) {
    fail(
      `backtest: ${scriptPath} is an indicator (no strategy() call) — ` +
        `backtest needs a strategy; use scan for indicators`,
    );
  }

  writeExports([{ label: symbol!, result }], csvDir, plotDir);

  if (asJson) {
    console.log(JSON.stringify({ ...result, elapsedMs: elapsed }, null, 2));
    return;
  }

  printTearsheet(result, timeframe, elapsed, !opts.has('no-chart'));
  if (opts.has('trades')) printLedger(result);
}

/**
 * compare — two strategies (or one strategy under two input sets) on the same
 * bars: a side-by-side metric table and an overlaid normalized equity chart.
 */
async function runCompare(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const [pathA, pathB] = opts.positional;
  if (!pathA || !pathB) {
    fail('compare: needs two scripts — pinerun compare <a.pine> <b.pine> --symbol BTCUSDT');
  }
  const symbol = opts.get('symbol') ?? singleSymbol(opts, 'compare');
  if (!symbol) fail('compare: no symbol (use --symbol BTCUSDT)');

  const sourceA = readFileSync(pathA!, 'utf8');
  const sourceB = readFileSync(pathB!, 'utf8');

  // Fixed input overrides per side (validated like backtest's --input).
  const sideInputs = (source: string, path: string, key: 'input-a' | 'input-b') => {
    const axisArgs = opts.getAll(key);
    if (axisArgs.length === 0) return undefined;
    try {
      const axes = validateAxes(source, parseAxes(axisArgs), 'compare');
      const grid = axes.find((a) => a.values.length !== 1);
      if (grid) {
        fail(
          `compare: --${key} ${grid.name} has ${grid.values.length} values — ` +
            `compare takes ONE value per input (use sweep for grids)`,
        );
      }
      return Object.fromEntries(axes.map((a) => [a.name, a.values[0]]));
    } catch (err) {
      fail(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const inputsA = sideInputs(sourceA, pathA!, 'input-a');
  const inputsB = sideInputs(sourceB, pathB!, 'input-b');

  let labelA = opts.get('label-a') ?? basename(pathA!, '.pine');
  let labelB = opts.get('label-b') ?? basename(pathB!, '.pine');
  if (labelA === labelB) {
    labelA = `${labelA} (A)`;
    labelB = `${labelB} (B)`;
  }

  const timeframe = opts.get('tf') ?? '1h';
  const range = buildRange(opts);
  const backend = (opts.get('backend') as 'js' | 'interp' | undefined) ?? 'js';
  const metrics = buildMetricsOpts(opts);
  const resolveSecurity = !opts.has('no-security');
  const provider = buildProvider(opts);

  const started = Date.now();
  // Sequential on one provider: the second run's fetch hits the disk cache.
  const run = async (source: string, inputs?: Record<string, unknown>) =>
    backtest({
      source,
      symbol: symbol!,
      timeframe,
      provider,
      range,
      inputs,
      backend,
      metrics,
      resolveSecurity,
    });
  const repA = await run(sourceA, inputsA);
  const repB = await run(sourceB, inputsB);
  const elapsed = Date.now() - started;

  const check = (path: string, rep: Awaited<ReturnType<typeof backtest>>): RunResult => {
    if (rep.fetchError) fail(`compare: fetch failed for ${symbol} — ${rep.fetchError}`);
    const r = rep.result!;
    if (!r.ok) {
      if (r.diagnostics) for (const d of r.diagnostics) console.error(`  ${d}`);
      fail(`compare: ${path}: ${r.error}`);
    }
    if (!r.strategy) {
      fail(`compare: ${path} is an indicator (no strategy() call) — compare needs strategies`);
    }
    return r;
  };
  const a = check(pathA!, repA);
  const b = check(pathB!, repB);

  if (opts.has('json')) {
    console.log(
      JSON.stringify(
        { symbol, timeframe, a: { label: labelA, result: a }, b: { label: labelB, result: b } },
        null,
        2,
      ),
    );
    return;
  }

  printCompare(a, b, labelA, labelB, timeframe, elapsed, !opts.has('no-chart'));
}

/** The compare view: metric columns for A and B, then the equity overlay. */
function printCompare(
  a: RunResult,
  b: RunResult,
  labelA: string,
  labelB: string,
  timeframe: string,
  elapsedMs: number,
  chart: boolean,
): void {
  const sa = a.strategy!;
  const sb = b.strategy!;
  const headA = `A: ${labelA}`;
  const headB = `B: ${labelB}`;
  // colW must fit the header cells (which carry the "A: " / "B: " prefix), not
  // just the bare labels, or a long label overflows and collides with the next.
  const colW = Math.max(16, headA.length + 2, headB.length + 2);
  const row = (label: string, va: string, vb: string): void =>
    console.log(`    ${label.padEnd(22)}${va.padStart(colW)}${vb.padStart(colW)}`);

  const times = a.barTimes ?? [];
  const t0 = times[0];
  const t1 = times[times.length - 1];
  const span = t0 != null && t1 != null ? `, ${isoDay(t0)} → ${isoDay(t1)}` : '';
  console.log('');
  console.log(`  compare: ${a.symbol} @ ${timeframe} — ${a.bars} bars${span}`);
  console.log('');
  row('', headA, headB);
  console.log(`    ${'-'.repeat(22 + colW * 2)}`);
  row('net profit', fmtNum(sa.netProfit), fmtNum(sb.netProfit));
  row('net profit %', fmtPct(sa.netProfitPercent), fmtPct(sb.netProfitPercent));
  row('profit factor', fmtPf(sa.profitFactor), fmtPf(sb.profitFactor));
  row('win rate', fmtPct(sa.winRate * 100), fmtPct(sb.winRate * 100));
  row('closed trades', String(sa.closedTrades), String(sb.closedTrades));
  row('max drawdown %', fmtPct(sa.maxDrawdownPercent), fmtPct(sb.maxDrawdownPercent));
  row('sharpe', fmtPf(sa.metrics.sharpe), fmtPf(sb.metrics.sharpe));
  row('sortino', fmtPf(sa.metrics.sortino), fmtPf(sb.metrics.sortino));
  row('calmar', fmtPf(sa.metrics.calmar), fmtPf(sb.metrics.calmar));
  row('CAGR %', fmtPct(sa.metrics.cagrPercent), fmtPct(sb.metrics.cagrPercent));
  row('volatility %', fmtPct(sa.metrics.volatilityPercent), fmtPct(sb.metrics.volatilityPercent));
  row('exposure %', fmtPct(sa.metrics.exposurePercent), fmtPct(sb.metrics.exposurePercent));
  row('expectancy', fmtNum(sa.metrics.expectancy), fmtNum(sb.metrics.expectancy));
  row(
    'buy & hold %',
    fmtPct(sa.metrics.buyHoldReturnPercent),
    fmtPct(sb.metrics.buyHoldReturnPercent),
  );

  if (chart) {
    // Both curves normalized to % return so different capital bases compare.
    const pct = (equity: number[] | undefined): number[] => {
      if (!equity) return [];
      const first = equity.find((v) => Number.isFinite(v));
      if (first == null || first === 0) return [];
      return equity.map((v) => (Number.isFinite(v) ? (v / first - 1) * 100 : NaN));
    };
    const pa = pct(a.equityCurve);
    const pb = pct(b.equityCurve);
    const fmtLabel = (v: number): string => `${v.toFixed(1)}%`;
    if (useColor()) {
      const overlay = overlayChartAscii(pa, pb, {
        width: 64,
        height: 12,
        times: a.barTimes,
        guide: 0,
        color: true,
        fmtLabel,
      });
      if (overlay) {
        console.log(
          `\n  EQUITY %  \x1b[36m⣿ A: ${labelA}\x1b[39m  \x1b[33m⣿ B: ${labelB}\x1b[39m  (dashed = 0%)`,
        );
        console.log(indent(overlay));
      }
    } else {
      // No color → an overlay would be two indistinguishable lines; print each.
      for (const [tag, series, curveTimes] of [
        [`A: ${labelA}`, pa, a.barTimes],
        [`B: ${labelB}`, pb, b.barTimes],
      ] as const) {
        const single = overlayChartAscii(series, [], {
          width: 64,
          height: 7,
          times: curveTimes,
          guide: 0,
          fmtLabel,
        });
        if (single) {
          console.log(`\n  EQUITY %  ${tag}  (dashed = 0%)`);
          console.log(indent(single));
        }
      }
    }
  }
  console.log('');
  console.log(`  in ${elapsedMs}ms`);
}

/** ANSI color only on a live terminal — piped output stays plain; NO_COLOR wins. */
function useColor(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
}

/**
 * A `\r`-rewriting progress line on stderr for long fan-outs. Strictly
 * TTY-only: when stderr is piped (CI, logs) every method is a no-op, so
 * captured output never carries carriage returns. `finish()` erases the line
 * before the results table prints.
 */
function makeProgress(verb: string): {
  onResult: (r: RunResult, done: number, total: number) => void;
  finish: () => void;
} {
  if (process.stderr.isTTY !== true) return { onResult: () => {}, finish: () => {} };
  const started = Date.now();
  let errors = 0;
  let width = 0;
  return {
    onResult: (r, done, total) => {
      if (!r.ok) errors++;
      const elapsed = (Date.now() - started) / 1000;
      const eta =
        done > 0 && done < total
          ? ` · ~${Math.max(1, Math.round((elapsed / done) * (total - done)))}s left`
          : '';
      const err = errors > 0 ? ` · ${errors} error${errors === 1 ? '' : 's'}` : '';
      const line = `  ${verb}: ${done}/${total} ran${err} · ${elapsed.toFixed(1)}s${eta}`;
      width = Math.max(width, line.length);
      process.stderr.write(`\r${line.padEnd(width)}`);
    },
    finish: () => {
      if (width > 0) process.stderr.write(`\r${' '.repeat(width)}\r`);
    },
  };
}

/**
 * The analysis tables shared by the backtest and portfolio tearsheets:
 * MONTHLY RETURNS and TOP DRAWDOWNS always print (they're stats, like the
 * blocks above them); the TRADE P/L histogram is a drawing, so it respects
 * `--no-chart` like the other charts.
 */
function printAnalysisTables(
  equity: number[] | undefined,
  times: number[] | undefined,
  trades: { profit: number }[] | undefined,
  chart: boolean,
): void {
  if (equity && times && equity.length === times.length && equity.length > 1) {
    const monthly = monthlyReturnsAscii(equity, times, { color: useColor() });
    if (monthly) {
      console.log('\n  MONTHLY RETURNS %');
      console.log(indent(monthly));
    }
    const dd = topDrawdownsAscii(equity, times, { top: 5 });
    if (dd) {
      console.log('\n  TOP DRAWDOWNS');
      console.log(indent(dd));
    }
  }
  if (chart && trades && trades.length > 0) {
    const hist = profitHistogramAscii(
      trades.map((t) => t.profit),
      { width: 40, color: useColor() },
    );
    if (hist) {
      console.log('\n  TRADE P/L DISTRIBUTION');
      console.log(indent(hist));
    }
  }
}

/**
 * PRICE panel: the close series with each trade marked at its fill price.
 * Needs a result that ran with includeTrades (closes attached); no-op
 * otherwise. Markers only get ANSI color on a live terminal; piped output
 * stays plain and the ▲▼/●○ glyphs still carry direction and win/loss.
 */
function printPriceChart(result: RunResult, label = ''): void {
  const closes = result.closes;
  if (!closes || closes.length < 2) return;
  const color = useColor();
  console.log(`\n  PRICE${label}  (close · ▲ long / ▼ short entry · ● win / ○ loss exit)`);
  console.log(
    indent(
      priceChartAscii(closes, {
        width: 64,
        height: 10,
        times: result.barTimes,
        trades: result.trades,
        color,
      }),
    ),
  );
}

/** The full-stats block for one strategy run: returns, risk, and trade quality. */
function printTearsheet(
  result: RunResult,
  timeframe: string,
  elapsedMs: number,
  chart = true,
): void {
  const s = result.strategy!;
  const m = s.metrics;
  const times = result.barTimes ?? [];
  const t0 = times[0];
  const t1 = times[times.length - 1];
  const span = t0 != null && t1 != null ? `, ${isoDay(t0)} → ${isoDay(t1)}` : '';

  // label + money column + percent column (either may be blank).
  const line = (label: string, money: string, pct = ''): void =>
    console.log(`    ${label.padEnd(22)}${money.padStart(12)}${pct ? pct.padStart(12) : ''}`);

  console.log('');
  console.log(`  backtest: ${result.symbol} @ ${timeframe} — ${result.bars} bars${span}`);
  console.log('');
  console.log('  RETURNS');
  line('net profit', fmtNum(s.netProfit), fmtPct(s.netProfitPercent));
  line('gross profit', fmtNum(s.grossProfit), fmtPct(s.grossProfitPercent));
  line('gross loss', fmtNum(s.grossLoss), fmtPct(s.grossLossPercent));
  line('buy & hold', '', fmtPct(m.buyHoldReturnPercent));
  line('outperformance', fmtNum(m.outperformance));
  line('CAGR', '', fmtPct(m.cagrPercent));
  console.log('');
  console.log('  RISK');
  line('max drawdown', fmtNum(s.maxDrawdown), fmtPct(s.maxDrawdownPercent));
  line('max runup', fmtNum(s.maxRunup), fmtPct(s.maxRunupPercent));
  line('volatility (annual)', '', fmtPct(m.volatilityPercent));
  line('sharpe', fmtPf(m.sharpe));
  line('sortino', fmtPf(m.sortino));
  line('calmar', fmtPf(m.calmar));
  line('exposure', '', fmtPct(m.exposurePercent));
  console.log('');
  console.log('  TRADES');
  line('closed trades', String(s.closedTrades), `(${s.wins}W ${s.losses}L ${s.evens}E)`);
  line('win rate', '', fmtPct(s.winRate * 100));
  line('profit factor', fmtPf(s.profitFactor));
  line('expectancy', fmtNum(m.expectancy));
  line('avg win / loss', `${fmtNum(s.avgWinningTrade)} / ${fmtNum(s.avgLosingTrade)}`);
  line('largest win / loss', `${fmtNum(m.largestWin)} / ${fmtNum(m.largestLoss)}`);
  line('max consecutive', `${m.maxConsecutiveWins} win / ${m.maxConsecutiveLosses} loss`);
  line('avg bars in trade', fmtPf(m.avgBarsInTrade));
  line('commission paid', fmtNum(s.totalCommission));
  line('max contracts held', fmtNum(s.maxContractsHeld));
  printAnalysisTables(result.equityCurve, result.barTimes, result.trades, chart);
  if (chart) printPriceChart(result);
  if (chart && result.equityCurve && result.equityCurve.length > 1) {
    console.log('\n  EQUITY  (dashed = initial capital)');
    console.log(
      indent(
        equityChartAscii(result.equityCurve, {
          width: 64,
          height: 10,
          times: result.barTimes,
          capital: s.initialCapital,
        }),
      ),
    );
    console.log('\n  DRAWDOWN (close-to-close)');
    console.log(indent(drawdownChartAscii(result.equityCurve, { width: 64, height: 4 })));
  }
  console.log('');
  console.log(
    `  initial capital ${fmtNum(s.initialCapital)} · annualized at ${fmtPf(m.periodsPerYear)} periods/yr · in ${elapsedMs}ms`,
  );
}

/** unix seconds or ms → YYYY-MM-DD (UTC). */
function isoDay(t: number): string {
  return new Date(t >= 1e12 ? t : t * 1000).toISOString().slice(0, 10);
}

async function runPortfolio(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  const scriptPath = opts.positional[0];
  if (!scriptPath) fail('portfolio: missing <script.pine>');
  const source = readFileSync(scriptPath!, 'utf8');

  const symbols = resolveSymbols(opts);
  if (symbols.length === 0)
    fail('portfolio: no symbols (use --symbols BTCUSDT,ETHUSDT,... or --universe file)');

  const mode = (opts.get('mode') ?? 'isolated') as 'isolated' | 'shared';
  if (mode !== 'isolated' && mode !== 'shared')
    fail(`portfolio: --mode must be isolated or shared (got "${opts.get('mode')}")`);
  const capital = opts.getNum('capital');

  // --weights BTCUSDT=0.5,ETHUSDT=0.3,... (repeatable). Isolated-mode only —
  // one shared pot has no per-sleeve split.
  let weights: Record<string, number> | undefined;
  const weightArgs = opts.getAll('weights');
  if (weightArgs.length > 0) {
    if (mode === 'shared') {
      console.error('  note: --weights is ignored under --mode shared (one pot, no split)');
    } else {
      weights = {};
      for (const arg of weightArgs) {
        for (const pair of arg.split(',')) {
          const [sym, frac] = pair.split('=');
          const w = Number(frac);
          if (!sym || !Number.isFinite(w) || w <= 0)
            fail(`portfolio: bad --weights entry "${pair}" (want SYMBOL=fraction)`);
          weights[sym.trim()] = w;
        }
      }
    }
  }

  // Fixed input overrides: --input name=value (one value each, as backtest).
  let inputs: Record<string, unknown> | undefined;
  const axisArgs = opts.getAll('input');
  if (axisArgs.length > 0) {
    try {
      const axes = validateAxes(source, parseAxes(axisArgs), 'portfolio');
      const grid = axes.find((a) => a.values.length !== 1);
      if (grid) {
        fail(
          `portfolio: --input ${grid.name} has ${grid.values.length} values — ` +
            `portfolio takes ONE value per input (use sweep for grids)`,
        );
      }
      inputs = Object.fromEntries(axes.map((a) => [a.name, a.values[0]]));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  const timeframe = opts.get('tf') ?? '1h';
  const range = buildRange(opts);
  const backend = (opts.get('backend') as 'js' | 'interp' | undefined) ?? 'js';
  const csvDir = opts.get('csv');
  const plotDir = opts.get('plot');
  const metrics = buildMetricsOpts(opts);
  const asJson = opts.has('json');
  const provider = buildProvider(opts);

  let report: PortfolioReport;
  try {
    report = await portfolio({
      source,
      symbols,
      timeframe,
      provider,
      range,
      mode,
      capital,
      weights,
      inputs,
      backend,
      mintick: opts.getNum('mintick'),
      minQty: opts.getNum('min-qty'),
      concurrency: opts.getNum('concurrency'),
      metrics,
      resolveSecurity: !opts.has('no-security'),
    });
  } catch (err) {
    fail(`portfolio: ${err instanceof Error ? err.message : String(err)}`);
  }

  // csv/plot: the portfolio curve + merged ledger, plus each sleeve. The
  // portfolio row carries the summary so the plot draws the capital reference
  // line and the net%/DD/Sharpe subtitle, exactly like a single-symbol backtest.
  writeExports(
    [
      {
        label: 'portfolio',
        result: syntheticResult(
          'PORTFOLIO',
          timeframe,
          report.times,
          report.equityCurve,
          report.trades,
          report.summary,
        ),
      },
      ...report.sleeves.map((s) => ({
        label: s.symbol,
        result: syntheticResult(s.symbol, timeframe, s.barTimes, s.equityCurve, s.trades),
        // Under shared mode a sleeve's curve samples POT equity at its own bars
        // (spec S2) — title it as such so the per-sleeve chart isn't misread.
        title: mode === 'shared' ? `${s.symbol} — pot equity at its bars (shared mode)` : undefined,
      })),
    ],
    csvDir,
    plotDir,
  );

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printPortfolioTearsheet(report, timeframe, !opts.has('no-chart'));
  if (opts.has('trades'))
    printLedger(
      syntheticResult('PORTFOLIO', timeframe, report.times, report.equityCurve, report.trades),
    );
}

/** A minimal RunResult wrapper so the portfolio reuses the CSV/plot/ledger paths. */
function syntheticResult(
  symbol: string,
  timeframe: string,
  barTimes: number[],
  equityCurve: number[],
  trades: PortfolioReport['trades'],
  strategy?: PortfolioReport['summary'],
): RunResult {
  return {
    id: `portfolio:${symbol}`,
    symbol,
    timeframe,
    ok: true,
    bars: barTimes.length,
    plots: [],
    alerts: [],
    trades,
    equityCurve,
    barTimes,
    strategy,
  };
}

/** Portfolio tearsheet: the backtest layout on the combined curve + contribution table. */
function printPortfolioTearsheet(report: PortfolioReport, timeframe: string, chart = true): void {
  const s = report.summary;
  const m = report.metrics;
  const t0 = report.times[0];
  const t1 = report.times[report.times.length - 1];
  const span = t0 != null && t1 != null ? `, ${isoDay(t0)} → ${isoDay(t1)}` : '';
  const line = (label: string, money: string, pct = ''): void =>
    console.log(`    ${label.padEnd(22)}${money.padStart(12)}${pct ? pct.padStart(12) : ''}`);

  console.log('');
  console.log(
    `  portfolio: ${report.symbols.length} symbols @ ${timeframe} — mode=${report.mode}, ` +
      `${fmtNum(report.initialCapital)} initial${span}`,
  );
  console.log('');
  console.log('  RETURNS');
  line('net profit', fmtNum(s.netProfit), fmtPct(s.netProfitPercent));
  line('gross profit', fmtNum(s.grossProfit), fmtPct(s.grossProfitPercent));
  line('gross loss', fmtNum(s.grossLoss), fmtPct(s.grossLossPercent));
  line('CAGR', '', fmtPct(m.cagrPercent));
  console.log('');
  console.log('  RISK');
  line('max drawdown', fmtNum(s.maxDrawdown), fmtPct(s.maxDrawdownPercent));
  line('max runup', fmtNum(s.maxRunup), fmtPct(s.maxRunupPercent));
  line('volatility (annual)', '', fmtPct(m.volatilityPercent));
  line('sharpe', fmtPf(m.sharpe));
  line('sortino', fmtPf(m.sortino));
  line('calmar', fmtPf(m.calmar));
  line('exposure', '', fmtPct(m.exposurePercent));
  console.log('    (portfolio drawdown/run-up are close-to-close on the combined curve)');
  console.log('');
  console.log('  TRADES');
  line('closed trades', String(s.closedTrades), `(${s.wins}W ${s.losses}L ${s.evens}E)`);
  line('win rate', '', fmtPct(s.winRate * 100));
  line('profit factor', fmtPf(s.profitFactor));
  line('expectancy', fmtNum(m.expectancy));
  line('avg win / loss', `${fmtNum(s.avgWinningTrade)} / ${fmtNum(s.avgLosingTrade)}`);
  line('commission paid', fmtNum(s.totalCommission));
  if (report.trades.some((t) => t.symbol) || s.closedTrades > 0)
    line('margin calls', String(report.sleeves.reduce((a, x) => a + x.marginCalls, 0)));
  console.log('');
  console.log(
    `  SYMBOL${' '.repeat(10)}${'FUNDING'.padStart(12)}${'NET P/L'.padStart(12)}${'TRADES'.padStart(8)}${'CONTRIB%'.padStart(10)}${'RET-CORR'.padStart(10)}`,
  );
  console.log('  ' + '-'.repeat(68));
  for (const sl of report.sleeves) {
    console.log(
      `  ${sl.symbol.padEnd(14)}${(report.mode === 'shared' ? '(pot)' : fmtNum(sl.funding)).padStart(12)}` +
        `${fmtNum(sl.netProfit).padStart(12)}${String(sl.closedTrades).padStart(8)}` +
        `${(Number.isFinite(sl.contributionPercent) ? sl.contributionPercent.toFixed(1) : 'na').padStart(10)}` +
        `${(Number.isFinite(sl.returnCorrelation) ? sl.returnCorrelation.toFixed(2) : 'na').padStart(10)}`,
    );
  }

  // Pairwise sleeve correlation — the diversification read. Isolated mode
  // only: shared-mode sleeve curves sample POT equity (spec S2), so every
  // pair would correlate at 1 and say nothing.
  if (report.mode === 'isolated' && report.sleeves.length >= 2) {
    const matrix = correlationMatrixAscii(
      report.sleeves.map((sl) => ({
        label: sl.symbol,
        series: alignEquity(
          {
            symbol: sl.symbol,
            barTimes: sl.barTimes,
            equityCurve: sl.equityCurve,
            initialCapital: sl.funding,
          },
          report.times,
        ),
      })),
    );
    if (matrix) {
      console.log('\n  SLEEVE RETURN CORRELATION');
      console.log(indent(matrix));
    }
  }

  printAnalysisTables(report.equityCurve, report.times, report.trades, chart);
  if (chart) printPortfolioChart(report);
  if (report.fetchErrors.length > 0) {
    console.log(`\n  ${report.fetchErrors.length} symbol(s) DROPPED before the run:`);
    for (const e of report.fetchErrors) console.log(`    ${e.symbol}: ${e.error}`);
    if (report.mode === 'shared')
      console.log('    note: a smaller basket is a DIFFERENT shared-account backtest.');
  }
  console.log(
    `\n  ${report.sleeves.length}/${report.symbols.length + report.fetchErrors.length} sleeves combined` +
      `  annualized at ${fmtPf(m.periodsPerYear)} periods/yr  in ${report.elapsedMs}ms`,
  );
}

/** The in-terminal picture: combined equity (with the capital guide), the
 *  underwater drawdown, and one cumulative-P/L sparkline per sleeve. All plain
 *  unicode — no colors, safe to pipe. `--no-chart` skips it. */
function printPortfolioChart(report: PortfolioReport): void {
  const chart = equityChartAscii(report.equityCurve, {
    width: 64,
    height: 10,
    times: report.times,
    capital: report.initialCapital,
  });
  if (!chart) return;
  const first = report.equityCurve.find((v) => Number.isFinite(v)) ?? report.initialCapital;
  const last = [...report.equityCurve].reverse().find((v) => Number.isFinite(v)) ?? first;
  console.log(`\n  EQUITY  ${fmtNum(first)} → ${fmtNum(last)}  (dashed = initial capital)`);
  console.log(indent(chart));
  console.log('\n  DRAWDOWN (close-to-close)');
  console.log(indent(drawdownChartAscii(report.equityCurve, { width: 64, height: 4 })));

  // Per-sleeve cumulative closed-trade P/L on the master clock — comparable
  // across modes (a shared-mode sleeve's equity curve samples the pot, which
  // would sparkline identically for every sleeve and say nothing).
  console.log('\n  SLEEVE cum P/L (closed trades)');
  const nameW = Math.max(...report.sleeves.map((s) => s.symbol.length), 6);
  for (const s of report.sleeves) {
    const cum = cumRealized(s.trades, report.times);
    console.log(
      `  ${s.symbol.padEnd(nameW)}  ${sparkline(cum, 40)}  ${fmtNum(s.netProfit).padStart(11)}`,
    );
  }
}

/** Running Σ of a sleeve's closed-trade profits sampled on the master clock. */
function cumRealized(trades: StrategyTrade[], times: number[]): number[] {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  const out = new Array<number>(times.length);
  let i = 0;
  let cum = 0;
  for (let k = 0; k < times.length; k++) {
    while (i < sorted.length && sorted[i]!.exitTime <= times[k]!) cum += sorted[i++]!.profit;
    out[k] = cum;
  }
  return out;
}

async function runSweep(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  const scriptPath = opts.positional[0];
  if (!scriptPath) fail('sweep: missing <script.pine>');
  const source = readFileSync(scriptPath!, 'utf8');

  // One symbol via --symbol, or a multi-symbol grid via --symbols/--universe.
  const symbolFlag = opts.get('symbol');
  const symbols = symbolFlag ? [symbolFlag] : resolveSymbols(opts);
  if (symbols.length === 0)
    fail('sweep: no symbol (use --symbol BTCUSDT, or --symbols a,b,c for a multi-symbol grid)');

  const axisArgs = opts.getAll('input');
  if (axisArgs.length === 0)
    fail('sweep: no axes (use --input name=values, e.g. --input fast=5,10,20)');
  let axes;
  try {
    axes = parseAxes(axisArgs);
  } catch (err) {
    fail(`sweep: ${err instanceof Error ? err.message : String(err)}`);
  }

  const timeframe = opts.get('tf') ?? '1h';
  const range = buildRange(opts);
  const rank = opts.get('rank'); // may be undefined — sweep() picks the default
  const direction = opts.has('asc') ? 'asc' : 'desc';
  const top = opts.getNum('top');
  const concurrency = opts.getNum('concurrency');
  const backend = (opts.get('backend') as 'js' | 'interp' | undefined) ?? 'js';
  const csvDir = opts.get('csv');
  const plotDir = opts.get('plot');
  // Exports need the ledger + equity curve, so --csv / --plot imply --trades.
  const includeTrades = opts.has('trades') || csvDir != null || plotDir != null;
  const metrics = buildMetricsOpts(opts);
  const resolveSecurity = !opts.has('no-security');
  const maxCombos = opts.getNum('max-combos');
  const sample = opts.getNum('sample');
  const seed = opts.getNum('seed');
  const pointsCsvPath = opts.get('points-csv');
  const wantHeatmap = opts.has('heatmap');
  const asJson = opts.has('json');

  if (wantHeatmap && axes!.length !== 2) {
    fail(`sweep: --heatmap needs exactly two --input axes (got ${axes!.length})`);
  }

  // Pre-check the run budget (same guard sweep() runs) so an oversized sweep
  // fails with a clean message before we build a provider or open a worker pool.
  try {
    assertComboBudget(axes!, maxCombos, { symbols: symbols.length, sample });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const provider = buildProvider(opts);
  const runner = buildRunner(opts);

  const started = Date.now();
  const progress = makeProgress('sweep');
  let report: SweepReport;
  try {
    report = await sweep({
      source,
      symbols,
      timeframe,
      provider,
      range,
      axes: axes!,
      rank,
      direction,
      top,
      concurrency,
      backend,
      mintick: opts.getNum('mintick'),
      minQty: opts.getNum('min-qty'),
      includeTrades,
      metrics,
      resolveSecurity,
      maxCombos,
      sample,
      seed,
      runner,
      onResult: progress.onResult,
    });
  } catch (err) {
    // Pre-run validation (unknown input names, bad values) → clean message.
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    progress.finish();
    await runner.close();
  }
  const elapsed = Date.now() - started;

  for (const fe of report.fetchErrors) {
    console.error(`  fetch failed: ${fe.symbol} — ${fe.error}`);
  }
  if (report.fetchError) fail(`sweep: every symbol's fetch failed`);
  for (const w of report.warnings) console.error(`  warning: ${w}`);

  const isStrategy = report.points.some((p) => p.result.strategy);
  const multiSymbol = report.symbols.length > 1;

  writeExports(
    report.ranked.map((p) => ({ label: `${p.symbol}-${p.result.id}`, result: p.result })),
    csvDir,
    plotDir,
  );

  if (pointsCsvPath != null) {
    const dir = dirname(pointsCsvPath);
    if (dir) mkdirSync(dir, { recursive: true });
    writeFileSync(pointsCsvPath, sweepPointsToCsv(report));
    console.error(`  points: wrote ${report.points.length} row(s) to ${pointsCsvPath}`);
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          symbol: report.symbol,
          symbols: report.symbols,
          rank: report.rank,
          direction,
          total: report.total,
          combos: report.combos,
          gridTotal: report.gridTotal,
          ...(sample != null ? { sample, seed } : {}),
          axes: report.axes,
          ...(report.warnings.length ? { warnings: report.warnings } : {}),
          ranked: report.ranked.map((p) => ({
            symbol: p.symbol,
            inputs: p.inputs,
            value: p.value,
            bars: p.result.bars,
            strategy: p.result.strategy,
            ...(p.result.trades
              ? {
                  trades: p.result.trades,
                  equityCurve: p.result.equityCurve,
                  barTimes: p.result.barTimes,
                }
              : {}),
          })),
          errors: report.errors.map((e) => ({ symbol: e.symbol, id: e.id, error: e.error })),
          fetchErrors: report.fetchErrors,
          elapsedMs: elapsed,
        },
        null,
        2,
      ),
    );
    return;
  }

  printSweepTable(report, report.rank, isStrategy, multiSymbol, elapsed, !opts.has('no-chart'));

  if (wantHeatmap) {
    console.log('');
    console.log(indent(sweepHeatmap(report, { color: useColor() })));
  }

  // With --trades, print the winning combo's price chart + closed-trade ledger.
  if (includeTrades && report.ranked.length >= 1) {
    const winner = report.ranked[0]!;
    if (!opts.has('no-chart')) {
      const combo = Object.entries(winner.inputs)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ');
      printPriceChart(winner.result, ` — ${winner.symbol}${combo ? ` ${combo}` : ''}`);
    }
    printLedger(winner.result);
  }
}

/** Two-space indent every line of a block (heatmap output under the table). */
function indent(block: string): string {
  return block
    .trimEnd()
    .split('\n')
    .map((l) => (l.length ? `  ${l}` : l))
    .join('\n');
}

async function runWalkforward(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  const scriptPath = opts.positional[0];
  if (!scriptPath) fail('walkforward: missing <script.pine>');
  const source = readFileSync(scriptPath!, 'utf8');

  const symbol = opts.get('symbol') ?? singleSymbol(opts, 'walkforward');
  if (!symbol) fail('walkforward: no symbol (use --symbol BTCUSDT)');

  const axisArgs = opts.getAll('input');
  if (axisArgs.length === 0)
    fail('walkforward: no axes (use --input name=values, e.g. --input fast=5,10,20)');
  let axes;
  try {
    axes = parseAxes(axisArgs);
  } catch (err) {
    fail(`walkforward: ${err instanceof Error ? err.message : String(err)}`);
  }

  const timeframe = opts.get('tf') ?? '1h';
  const range = buildRange(opts);
  const rank = opts.get('rank');
  const windows = opts.getNum('windows');
  const oosFraction = opts.getNum('oos');
  const anchored = opts.has('anchored');
  const concurrency = opts.getNum('concurrency');
  const backend = (opts.get('backend') as 'js' | 'interp' | undefined) ?? 'js';
  const metrics = buildMetricsOpts(opts);
  const resolveSecurity = !opts.has('no-security');
  const maxCombos = opts.getNum('max-combos');
  const asJson = opts.has('json');

  const provider = buildProvider(opts);
  const runner = buildRunner(opts);

  const started = Date.now();
  let report: WalkforwardReport;
  try {
    report = await walkforward({
      source,
      symbol: symbol!,
      timeframe,
      provider,
      range,
      axes: axes!,
      rank,
      windows,
      oosFraction,
      anchored,
      concurrency,
      backend,
      mintick: opts.getNum('mintick'),
      minQty: opts.getNum('min-qty'),
      metrics,
      resolveSecurity,
      maxCombos,
      runner,
    });
  } catch (err) {
    // Pre-run validation (bad window plan, indicator script, bad axes).
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    await runner.close();
  }
  const elapsed = Date.now() - started;

  if (report.fetchError) fail(`walkforward: fetch failed for ${symbol} — ${report.fetchError}`);
  for (const w of report.warnings) console.error(`  warning: ${w}`);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          symbol: report.symbol,
          rank: report.rank,
          anchored: report.anchored,
          totalBars: report.totalBars,
          isBars: report.isBars,
          oosBars: report.oosBars,
          // Full-window RunResults are heavy — keep JSON to the verdict per
          // window (the CLI table's data); rerun via backtest for one window's detail.
          windows: report.windows.map(({ result: _result, ...w }) => w),
          aggregate: report.aggregate,
          ...(report.warnings.length ? { warnings: report.warnings } : {}),
          elapsedMs: elapsed,
        },
        null,
        2,
      ),
    );
    return;
  }

  printWalkforwardTable(report, elapsed, !opts.has('no-chart'));
}

/** Per-window IS → OOS verdict table + the aggregate line. */
function printWalkforwardTable(report: WalkforwardReport, elapsedMs: number, spark = true): void {
  const mode = report.anchored ? 'anchored' : 'rolling';
  console.log('');
  console.log(
    `  walk-forward: ${report.symbol} — ${report.windows.length} window${report.windows.length === 1 ? '' : 's'} ` +
      `(IS ${report.isBars} → OOS ${report.oosBars} bars, ${mode}), rank ${report.rank}`,
  );
  console.log('');

  // Each window's OOS equity segment, sparklined: the "did the edge survive out
  // of sample" question, per row at a glance. The winner run covers IS+OOS with
  // window-local bar indices, so the OOS slice starts at oosFrom − isFrom.
  const oosEquity = (w: WalkforwardReport['windows'][number]): number[] =>
    w.result?.equityCurve?.slice(w.oosFrom - w.isFrom) ?? [];
  const showOos = spark && report.windows.some((w) => oosEquity(w).length > 1);

  const spanW = 24;
  const winnerW = Math.max(6, ...report.windows.map((w) => (w.winnerId ?? '').length));
  const header =
    `  #  ${'IS SPAN'.padEnd(spanW)}  ${'OOS SPAN'.padEnd(spanW)}  ${'WINNER'.padEnd(winnerW)}  ` +
    `${'IS NET%'.padStart(8)}  ${'OOS NET%'.padStart(8)}  ${'TRADES'.padStart(6)}  ${'EFF'.padStart(6)}` +
    (showOos ? `  ${'OOS EQUITY'.padEnd(14)}` : '');
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));
  for (const w of report.windows) {
    const no = String(w.index + 1).padStart(2);
    const isSpan = `${isoDay(w.isFromTime ?? NaN)} → ${isoDay(w.oosFromTime ?? NaN)}`.padEnd(spanW);
    const oosSpan = `${isoDay(w.oosFromTime ?? NaN)} → ${isoDay(w.oosToTime ?? NaN)}`.padEnd(spanW);
    if (w.error) {
      console.log(`  ${no} ${isSpan}  ${oosSpan}  (${w.error})`);
      continue;
    }
    console.log(
      `  ${no} ${isSpan}  ${oosSpan}  ${w.winnerId!.padEnd(winnerW)}  ` +
        `${fmtPct(w.isProfitPercent!).padStart(8)}  ${fmtPct(w.oosProfitPercent!).padStart(8)}  ` +
        `${String(w.oosTrades!).padStart(6)}  ${fmtPf(w.efficiency!).padStart(6)}` +
        (showOos ? `  ${sparkline(oosEquity(w), 14)}` : ''),
    );
  }

  const a = report.aggregate;
  console.log('');
  console.log(
    `  aggregate: OOS positive ${a.oosPositive}/${a.windows - a.failed}` +
      (a.failed ? ` (${a.failed} failed)` : '') +
      ` · mean IS ${fmtPct(a.meanIsProfitPercent)} · mean OOS ${fmtPct(a.meanOosProfitPercent)}` +
      ` · WFE ${fmtPf(a.walkForwardEfficiency)} · in ${elapsedMs}ms`,
  );
  console.log(
    '  WFE ≈ 1: the edge holds out of sample · WFE ≪ 1: the sweep fit noise · ' +
      'WFE is per-bar OOS profit ÷ per-bar IS profit',
  );
}

/** Ranked table for a sweep: one column per swept axis, then the metric block. */
function printSweepTable(
  report: SweepReport,
  rank: string,
  isStrategy: boolean,
  multiSymbol: boolean,
  elapsedMs: number,
  spark = true,
): void {
  const rows = report.ranked;
  const sampled =
    report.combos < report.gridTotal
      ? ` (sampled ${report.combos} of ${report.gridTotal} combos${multiSymbol ? ' per symbol' : ''})`
      : '';
  console.log('');
  console.log(
    `  sweep: ${report.symbol} — ${report.total} runs${sampled}, ranked by ${rank} (${report.axes.map((a) => a.name).join(' × ') || 'none'})`,
  );
  console.log('');
  if (rows.length === 0) {
    console.log('  No ranked results.');
    printSweepFooter(report, multiSymbol, elapsedMs);
    return;
  }

  // Leading SYMBOL column on a multi-symbol grid, then one column per axis.
  const symW = multiSymbol ? Math.max(6, ...rows.map((r) => r.symbol.length)) : 0;
  const symHeader = multiSymbol ? `${'SYMBOL'.padEnd(symW)}  ` : '';
  const symCell = (r: (typeof rows)[number]): string =>
    multiSymbol ? `${r.symbol.padEnd(symW)}  ` : '';

  // Per-axis columns: header is the axis name, cells are the combo's value.
  const axisNames = report.axes.map((a) => a.name);
  const axisW = axisNames.map((name, i) =>
    Math.max(name.length, ...rows.map((r) => fmtCell(r.inputs[axisNames[i]!]).length)),
  );

  // Sparkline columns only when the sweep retained the data (--trades/--csv/
  // --plot force the curve; plot series are always carried); --no-chart skips.
  const showEq = spark && rows.some((r) => (r.result.equityCurve?.length ?? 0) > 1);
  const showSeries =
    spark && !isStrategy && rows.some((r) => (rankedPlotData(r.result, rank)?.length ?? 0) > 1);

  if (isStrategy) {
    const metricCols =
      `${'NET P/L'.padStart(12)}  ${'NET %'.padStart(9)}  ${'TRADES'.padStart(6)}  ${'WIN%'.padStart(6)}  ${'MAXDD%'.padStart(8)}  ${'PF'.padStart(7)}  ${'SHARPE'.padStart(7)}` +
      (showEq ? `  ${'EQUITY'.padEnd(16)}` : '');
    const axisHeader = axisNames.map((n, i) => n.padStart(axisW[i]!)).join('  ');
    const header = `  #  ${symHeader}${axisHeader}  ${metricCols}`;
    console.log(header);
    console.log('  ' + '-'.repeat(header.length - 2));
    rows.forEach((r, i) => {
      const rankNo = String(i + 1).padStart(2);
      const axisCells = axisNames
        .map((n, j) => fmtCell(r.inputs[n]).padStart(axisW[j]!))
        .join('  ');
      const s = r.result.strategy;
      const metrics = s
        ? `${fmtNum(s.netProfit).padStart(12)}  ${fmtPct(s.netProfitPercent).padStart(9)}  ` +
          `${String(s.closedTrades).padStart(6)}  ${fmtPct(s.winRate * 100).padStart(6)}  ` +
          `${fmtPct(s.maxDrawdownPercent).padStart(8)}  ${fmtPf(s.profitFactor).padStart(7)}  ` +
          `${fmtPf(s.metrics.sharpe).padStart(7)}` +
          (showEq ? `  ${sparkline(r.result.equityCurve ?? [], 16)}` : '')
        : `${'(no strategy)'.padStart(12)}`;
      console.log(`  ${rankNo} ${symCell(r)}${axisCells}  ${metrics}`);
    });
  } else {
    const axisHeader = axisNames.map((n, i) => n.padStart(axisW[i]!)).join('  ');
    const header =
      `  #  ${symHeader}${axisHeader}  ${'VALUE'.padStart(14)}  BARS` +
      (showSeries ? `  ${'SERIES'.padEnd(20)}` : '');
    console.log(header);
    console.log('  ' + '-'.repeat(header.length - 2));
    rows.forEach((r, i) => {
      const rankNo = String(i + 1).padStart(2);
      const axisCells = axisNames
        .map((n, j) => fmtCell(r.inputs[n]).padStart(axisW[j]!))
        .join('  ');
      const sp = showSeries ? `  ${sparkline(rankedPlotData(r.result, rank) ?? [], 20)}` : '';
      console.log(
        `  ${rankNo} ${symCell(r)}${axisCells}  ${fmtNum(r.value).padStart(14)}  ${String(r.result.bars).padEnd(4)}${sp}`,
      );
    });
  }
  printSweepFooter(report, multiSymbol, elapsedMs);
}

function printSweepFooter(report: SweepReport, multiSymbol: boolean, elapsedMs: number): void {
  if (report.errors.length > 0) {
    console.log(`\n  ${report.errors.length} run error(s):`);
    for (const e of report.errors.slice(0, 10)) {
      const label = multiSymbol ? `${e.symbol} ${e.id}` : e.id;
      console.log(`    ${label}: ${e.error}`);
    }
    if (report.errors.length > 10) console.log(`    … and ${report.errors.length - 10} more`);
  }
  const ok = report.total - report.errors.length;
  console.log(`\n  ${ok}/${report.total} ran  ${report.ranked.length} ranked  in ${elapsedMs}ms`);
}

function fmtCell(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : fmtNum(v);
  return String(v);
}

/**
 * The one symbol from --symbols/--universe, for `sweep` / `backtest` convenience
 * when --symbol is omitted. More than one symbol is an error, not a silent
 * truncation — both commands run a single symbol.
 */
function singleSymbol(opts: Args, label = 'sweep'): string | undefined {
  const symbols = resolveSymbols(opts);
  if (symbols.length > 1) {
    fail(
      `${label}: got ${symbols.length} symbols from --symbols/--universe but ${label} runs ONE symbol — use --symbol <sym>`,
    );
  }
  return symbols[0];
}

function printTable(report: ScanReport, rank: string, elapsedMs: number, spark = true): void {
  const rows = report.ranked;
  console.log('');
  if (rows.length === 0) {
    console.log('No ranked results.');
  } else {
    // Sparkline the ranked plot series per row (skip with --no-chart, or when
    // the rank doesn't read a plot).
    const series = spark
      ? (r: (typeof rows)[number]) => rankedPlotData(r.result, rank)
      : () => null;
    const showSpark = rows.some((r) => (series(r)?.length ?? 0) > 1);
    const symW = Math.max(6, ...rows.map((r) => r.result.symbol.length));
    const sparkHeader = showSpark ? `  ${'SERIES'.padEnd(20)}` : '';
    const header = `  #  ${'SYMBOL'.padEnd(symW)}  ${'VALUE'.padStart(14)}  BARS${sparkHeader}`;
    console.log(header);
    console.log('  ' + '-'.repeat(header.length - 2));
    rows.forEach((r, i) => {
      const rankNo = String(i + 1).padStart(2);
      const sym = r.result.symbol.padEnd(symW);
      const val = fmtNum(r.value).padStart(14);
      const bars = String(r.result.bars).padEnd(4);
      const sp = showSpark ? `  ${sparkline(series(r) ?? [], 20)}` : '';
      console.log(`  ${rankNo} ${sym}  ${val}  ${bars}${sp}`);
    });
  }
  printFooters(report, rank, elapsedMs);
}

/** The per-bar data the plot rank reads — the series a scan row sparklines. */
function rankedPlotData(result: RunResult, rank: string): number[] | null {
  try {
    const spec = parseRankSpec(rank);
    if (spec.kind !== 'plot') return null;
    return selectPlot(result, spec.selector)?.data ?? null;
  } catch {
    return null;
  }
}

/** Backtest table for a strategy scan: several performance columns per symbol. */
function printStrategyTable(
  report: ScanReport,
  rank: string,
  elapsedMs: number,
  spark = true,
): void {
  const rows = report.ranked;
  console.log('');
  if (rows.length === 0) {
    console.log('No ranked results.');
  } else {
    // Equity sparkline per symbol when the scan carried the curve (--trades /
    // --csv / --plot force it); skip with --no-chart.
    const showEq = spark && rows.some((r) => (r.result.equityCurve?.length ?? 0) > 1);
    const symW = Math.max(6, ...rows.map((r) => r.result.symbol.length));
    const cols =
      `${'NET P/L'.padStart(12)}  ${'NET %'.padStart(9)}  ${'TRADES'.padStart(6)}  ${'WIN%'.padStart(6)}  ` +
      `${'MAXDD%'.padStart(8)}  ${'PF'.padStart(7)}  ${'SHARPE'.padStart(7)}  ${'B&H %'.padStart(9)}` +
      (showEq ? `  ${'EQUITY'.padEnd(16)}` : '');
    const header = `  #  ${'SYMBOL'.padEnd(symW)}  ${cols}`;
    console.log(header);
    console.log('  ' + '-'.repeat(header.length - 2));
    rows.forEach((r, i) => {
      const s = r.result.strategy;
      const rankNo = String(i + 1).padStart(2);
      const sym = r.result.symbol.padEnd(symW);
      if (!s) {
        console.log(`  ${rankNo} ${sym}  ${'(no strategy)'.padStart(12)}`);
        return;
      }
      const line =
        `${fmtNum(s.netProfit).padStart(12)}  ${fmtPct(s.netProfitPercent).padStart(9)}  ` +
        `${String(s.closedTrades).padStart(6)}  ${fmtPct(s.winRate * 100).padStart(6)}  ` +
        `${fmtPct(s.maxDrawdownPercent).padStart(8)}  ${fmtPf(s.profitFactor).padStart(7)}  ` +
        `${fmtPf(s.metrics.sharpe).padStart(7)}  ${fmtPct(s.metrics.buyHoldReturnPercent).padStart(9)}` +
        (showEq ? `  ${sparkline(r.result.equityCurve ?? [], 16)}` : '');
      console.log(`  ${rankNo} ${sym}  ${line}`);
    });
  }
  printFooters(report, rank, elapsedMs);
}

/** Ledgers longer than this elide to the first/last LEDGER_EDGE_ROWS rows. */
const MAX_LEDGER_ROWS = 20;
const LEDGER_EDGE_ROWS = 5;

/** Closed-trade ledger for a single result (with --trades). Long ledgers
 *  (> MAX_LEDGER_ROWS) print the first and last LEDGER_EDGE_ROWS trades with
 *  an elision row between — the full ledger stays in --csv / --json. */
function printLedger(result: RunResult): void {
  const trades = result.trades ?? [];
  console.log(`\n  trades for ${result.symbol} (${trades.length}):`);
  if (trades.length === 0) {
    console.log('    (none)');
    return;
  }
  const numW = Math.max(2, String(trades.length).length);
  const header = `  ${'#'.padStart(numW)}  ${'DIR'.padEnd(5)}  ${'QTY'.padStart(10)}  ${'ENTRY'.padStart(12)}  ${'EXIT'.padStart(12)}  ${'PROFIT'.padStart(12)}  ${'CUM'.padStart(12)}  ${'FEES'.padStart(10)}`;
  console.log(header);
  console.log('  ' + '-'.repeat(header.length - 2));
  const row = (t: StrategyTrade, i: number): void => {
    const dir = t.dir > 0 ? 'long' : 'short';
    console.log(
      `  ${String(i + 1).padStart(numW)}  ${dir.padEnd(5)}  ${fmtNum(t.qty).padStart(10)}  ` +
        `${fmtNum(t.entryPrice).padStart(12)}  ${fmtNum(t.exitPrice).padStart(12)}  ` +
        `${fmtNum(t.profit).padStart(12)}  ${fmtNum(t.cumProfit).padStart(12)}  ` +
        `${fmtNum(t.commission).padStart(10)}`,
    );
  };
  if (trades.length > MAX_LEDGER_ROWS) {
    for (let i = 0; i < LEDGER_EDGE_ROWS; i++) row(trades[i]!, i);
    console.log(
      `  ${'…'.padStart(numW)}  (${trades.length - 2 * LEDGER_EDGE_ROWS} trades omitted — ` +
        `full ledger via --csv or --json)`,
    );
    for (let i = trades.length - LEDGER_EDGE_ROWS; i < trades.length; i++) row(trades[i]!, i);
  } else {
    trades.forEach(row);
  }
}

function printFooters(report: ScanReport, rank: string, elapsedMs: number): void {
  if (report.errors.length > 0) {
    console.log(`\n  ${report.errors.length} run error(s):`);
    for (const e of report.errors) console.log(`    ${e.symbol}: ${e.error}`);
  }
  if (report.fetchErrors.length > 0) {
    console.log(`\n  ${report.fetchErrors.length} fetch error(s):`);
    for (const e of report.fetchErrors) console.log(`    ${e.symbol}: ${e.error}`);
  }
  const ok = report.results.filter((r) => r.ok).length;
  console.log(
    `\n  rank="${rank}"  ${ok}/${report.results.length} ran  ${report.ranked.length} ranked  in ${elapsedMs}ms`,
  );
}

// ── provider / runner wiring ────────────────────────────────

/** Legacy compound provider names, kept so existing invocations don't break. */
const LEGACY_PROVIDER_NAMES: Record<string, { provider: DataProvider; assetClass: AssetClass }> = {
  'binance-futures': { provider: 'binance', assetClass: 'futures' },
  'okx-swap': { provider: 'okx', assetClass: 'futures' },
};

function buildProvider(opts: Args, forceRefresh = false): HistoryProvider {
  const name = opts.get('provider') ?? 'binance';
  const legacy = LEGACY_PROVIDER_NAMES[name];
  const provider = legacy?.provider ?? name;
  if (!isDataProvider(provider)) {
    fail(
      `unknown provider "${name}" (binance, okx, kraken, alpaca, massive; ` +
        `legacy: binance-futures, okx-swap)`,
    );
  }
  const requestedClass = legacy?.assetClass ?? opts.get('asset-class');
  if (
    requestedClass != null &&
    (!isAssetClass(requestedClass) || !supportsPair(provider, requestedClass))
  ) {
    fail(
      `provider "${provider}" does not serve asset class "${requestedClass}" ` +
        `(serves: ${assetClassesForProvider(provider).join(', ')})`,
    );
  }
  // Route per symbol: a symbol may be a full instrument address (BI:FU:BTCUSDT,
  // KR:BTC/USD) that overrides the flags; bare tickers use --provider/--asset-class.
  // The cache wraps each routed provider so keys stay on real provider ids.
  const { apiKey, apiSecret } = resolveCredentials(opts);
  return new InstrumentRouter({
    fallbackProvider: provider,
    fallbackAssetClass: requestedClass as AssetClass | undefined,
    apiKey,
    apiSecret,
    feed: opts.get('feed') === 'sip' ? 'sip' : 'iex',
    wrap: opts.has('no-cache')
      ? undefined
      : (p) =>
          cached(p, { dir: opts.get('cache-dir'), refresh: forceRefresh || opts.has('refresh') }),
  });
}

/**
 * Resolve provider credentials for the equities adapters (Alpaca / Massive).
 *
 * Env vars are the preferred channel — a key passed as `--api-key`/`--api-secret`
 * is recorded in shell history and is visible in `ps`/process listings, so it
 * leaks. When no flag is given we return `undefined` and each adapter reads its
 * env var (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY / MASSIVE_API_KEY). We still
 * honor the flags (scripted/CI use, or overriding an env var) but warn loudly so
 * the safer path is obvious.
 */
function resolveCredentials(opts: Args): { apiKey?: string; apiSecret?: string } {
  const apiKey = opts.get('api-key');
  const apiSecret = opts.get('api-secret');
  if (apiKey != null || apiSecret != null) {
    const flags = [apiKey != null ? '--api-key' : null, apiSecret != null ? '--api-secret' : null]
      .filter(Boolean)
      .join(' / ');
    console.error(
      `  warning: ${flags} on the command line lands your credential in shell history\n` +
        `           and process listings. Prefer env vars: ALPACA_API_KEY_ID +\n` +
        `           ALPACA_API_SECRET_KEY (Alpaca) or MASSIVE_API_KEY (Massive), then\n` +
        `           drop the flag.`,
    );
  }
  return { apiKey, apiSecret };
}

/**
 * Write per-result CSV (trades + equity) and/or a self-contained equity/drawdown
 * HTML plot into the given directories. Results without a ledger (indicator
 * scripts, failed runs) are skipped; prints one summary line per directory.
 */
function writeExports(
  entries: { label: string; result: RunResult; title?: string }[],
  csvDir: string | undefined,
  plotDir: string | undefined,
): void {
  if (csvDir == null && plotDir == null) return;
  const exportable = entries.filter((e) => e.result.trades);
  if (exportable.length === 0) {
    console.error('  export: no results carry a trade ledger (strategy scripts only) — skipped');
    return;
  }
  if (csvDir != null) {
    mkdirSync(csvDir, { recursive: true });
    for (const { label, result } of exportable) {
      writeFileSync(join(csvDir, `${safeFileName(label)}-trades.csv`), tradesToCsv(result));
      writeFileSync(join(csvDir, `${safeFileName(label)}-equity.csv`), equityToCsv(result));
    }
    console.error(`  csv: wrote ${exportable.length * 2} file(s) to ${csvDir}`);
  }
  if (plotDir != null) {
    mkdirSync(plotDir, { recursive: true });
    for (const { label, result, title } of exportable) {
      writeFileSync(
        join(plotDir, `${safeFileName(label)}.html`),
        equityPlotHtml(result, { title: title ?? label }),
      );
    }
    console.error(`  plot: wrote ${exportable.length} file(s) to ${plotDir}`);
  }
}

/** Combo ids carry `|` separators and arbitrary input values — keep filenames tame. */
function safeFileName(s: string): string {
  return s.replace(/[^A-Za-z0-9._=,-]+/g, '_');
}

/** Host conventions for piner's derived risk-adjusted metrics, from CLI flags. */
function buildMetricsOpts(opts: Args): JobMetricsOptions | undefined {
  const periodsPerYear = opts.getNum('periods-per-year');
  const riskFreeRate = opts.getNum('risk-free-rate');
  if (periodsPerYear == null && riskFreeRate == null) return undefined;
  return { periodsPerYear, riskFreeRate };
}

function buildRunner(opts: Args): Runner {
  const workers = opts.get('workers');
  if (workers === 'local' || workers === '0') return new LocalRunner();
  const size = workers != null ? Number(workers) : undefined;
  return new WorkerPoolRunner({ size: size && Number.isFinite(size) ? size : undefined });
}

// ── args ────────────────────────────────────────────────────

interface Args {
  positional: string[];
  get(key: string): string | undefined;
  getNum(key: string): number | undefined;
  getAll(key: string): string[];
  has(flag: string): boolean;
  values: Map<string, string>;
  multi: Map<string, string[]>;
  flags: Set<string>;
}

const VALUE_KEYS = new Set([
  'symbols',
  'symbol',
  'universe',
  'tf',
  'from',
  'to',
  'limit',
  'rank',
  'top',
  'concurrency',
  'backend',
  'provider',
  'asset-class',
  'workers',
  'cache-dir',
  'feed',
  'api-key',
  'api-secret',
  'input',
  'max-combos',
  'sample',
  'seed',
  'points-csv',
  'periods-per-year',
  'risk-free-rate',
  'csv',
  'plot',
  'windows',
  'oos',
  'template',
  'name',
  'mode',
  'capital',
  'weights',
  'mintick',
  'min-qty',
  'input-a',
  'input-b',
  'label-a',
  'label-b',
]);

/** Value keys that may be repeated; each occurrence accumulates into an array. */
const MULTI_KEYS = new Set(['input', 'weights', 'input-a', 'input-b']);

/** Keys whose value is optional: `--watch 30` takes the 30, bare `--watch`
 *  (followed by another flag or nothing) is a plain flag. */
const OPTIONAL_VALUE_KEYS = new Set(['watch']);

function parseArgs(args: string[]): Args {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const flags = new Set<string>();
  const record = (key: string, value: string): void => {
    if (MULTI_KEYS.has(key)) {
      const list = multi.get(key) ?? [];
      list.push(value);
      multi.set(key, list);
    } else {
      values.set(key, value);
    }
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        record(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const key = a.slice(2);
        if (VALUE_KEYS.has(key)) record(key, args[++i] ?? '');
        else if (OPTIONAL_VALUE_KEYS.has(key)) {
          const next = args[i + 1];
          if (next != null && next !== '' && !next.startsWith('--')) record(key, args[++i]!);
          else flags.add(key);
        } else flags.add(key);
      }
    } else {
      positional.push(a);
    }
  }
  return {
    positional,
    values,
    multi,
    flags,
    get: (k) => values.get(k),
    // Fail fast on garbage: a silent NaN would disable guards downstream
    // (`combos > NaN` is false) or spawn zero workers.
    getNum: (k) => {
      if (!values.has(k)) return undefined;
      const raw = values.get(k)!;
      const n = Number(raw);
      if (!Number.isFinite(n)) fail(`invalid --${k}: "${raw}" is not a number`);
      return n;
    },
    getAll: (k) => multi.get(k) ?? [],
    has: (f) => flags.has(f),
  };
}

function resolveSymbols(opts: Args): string[] {
  const out: string[] = [];
  const inline = opts.get('symbols');
  if (inline) out.push(...splitSymbols(inline));
  const universe = opts.get('universe');
  if (universe) out.push(...splitSymbols(readFileSync(universe, 'utf8')));
  // de-dupe, preserve order
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

function splitSymbols(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('#'));
}

function buildRange(opts: Args): HistoryRange | undefined {
  const from = parseDate(opts.get('from'));
  const to = parseDate(opts.get('to'));
  const limit = opts.getNum('limit');
  if (from == null && to == null && limit == null) return undefined;
  return { from, to, limit };
}

function parseDate(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const s = raw.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? Math.floor(n / 1000) : n; // ms vs sec
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) fail(`scan: bad date "${raw}"`);
  return Math.floor(ms / 1000);
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return 'na';
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e9)) return v.toExponential(4);
  return v.toFixed(abs >= 100 ? 2 : 4);
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return 'na';
  return `${v.toFixed(2)}%`;
}

function fmtPf(v: number): string {
  if (v === Infinity) return 'inf';
  if (!Number.isFinite(v)) return 'na';
  return v.toFixed(2);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const HELP_USAGE = `pinerun — parallel piner execution

USAGE
  pinerun init        [file.pine] [options]     Scaffold: write a commented starter strategy
  pinerun scan        <script.pine> [options]   Screen: one script across N symbols, ranked
  pinerun backtest    <script.pine> [options]   Analyze: one strategy on one symbol, tearsheet
  pinerun compare     <a.pine> <b.pine> [opts]  Compare: two strategies on the same bars, side by side
  pinerun portfolio   <script.pine> [options]   Combine: one strategy across N symbols, ONE capital pot
  pinerun sweep       <script.pine> [options]   Optimize: one script's input grid, one or more symbols
  pinerun walkforward <script.pine> [options]   Validate: does the swept edge survive out of sample?

  pinerun upgrade                               Update pinerun to the latest release
  pinerun <command> --help                      Show a command's options
  pinerun --version                             Print the pinerun version`;

const HELP_SECTIONS: Record<string, string> = {
  init: `INIT OPTIONS
  [file.pine]           Output path (default strategy.pine); parent dirs created
  --template <name>     Starter to scaffold (default sma-cross):
                          sma-cross | rsi | bollinger | macd
  --name "Title"        strategy() title (default: a per-template label)
  --force               Overwrite the file if it already exists
  --stdout              Print the source to stdout instead of writing a file

INIT EXAMPLE
  pinerun init                                   # writes strategy.pine (SMA cross)
  pinerun init rsi-bot.pine --template rsi       # a commented RSI mean-reversion starter
  pinerun backtest strategy.pine --symbol BTCUSDT --tf 1h --limit 500`,

  scan: `SCAN OPTIONS
  --symbols a,b,c       Inline symbol list (comma/space separated). A symbol may
                          be a full instrument address PREFIX[:CODE]:TICKER that
                          overrides --provider/--asset-class per symbol, so one
                          scan can mix providers:
                          BI:FU:BTCUSDT (binance futures), KR:BTC/USD, AL:AAPL
                          (prefixes BI OK KR AL MA; codes EQ CR FU FX)
  --universe <file>     File of symbols (one per line; # comments allowed)
  --tf <1h>             Timeframe: 1m 5m 15m 1h 4h 1d 1w (default 1h)
  --from <date>         Start (ISO date or unix seconds)
  --to <date>           End (ISO date or unix seconds)
  --limit <n>           Max bars per symbol
  --rank <spec>         Ranking spec (default "last"; strategies default to
                          strategy.netProfit):
                          last(title) first(#0) min/max/mean/sum/count(title)
                          strategy.netProfit | strategy.winRate | strategy.profitFactor
                          | strategy.sharpe | strategy.sortino | strategy.calmar
                          | strategy.cagrPercent | strategy.outperformance | ...
  --top <n>             Keep only the top N
  --asc                 Sort ascending (default descending)
  --trades              Include the closed-trade ledger + equity curve
                          (printed for a single-symbol scan — with its PRICE
                          chart, trades marked at their fill prices; always in
                          --json; adds an EQUITY sparkline column to the table)
  --no-chart            Skip the table sparklines (plot SERIES / EQUITY) and
                          the single-result PRICE chart
  --csv <dir>           Write <label>-trades.csv + <label>-equity.csv per ranked
                          strategy result (pandas/Excel-ready; implies --trades)
  --plot <dir>          Write a self-contained <label>.html equity + drawdown
                          chart per ranked strategy result (implies --trades)
  --periods-per-year <n> Metrics annualization override (e.g. 252 daily US-equity
                          bars; default: empirical bar times / 24/7 timeframe)
  --risk-free-rate <r>  Annual risk-free rate for Sharpe/Sortino, as a fraction
                          (e.g. 0.02; default 0)
  --concurrency <n>     Max jobs in flight (default = workers)
  --workers <n|local>   Worker threads (default = CPUs; "local" = in-process)
  --backend js|interp   piner backend (default js)
  --provider <name>     Data provider (default binance):
                          binance | okx | kraken | alpaca | massive
                          (legacy aliases: binance-futures, okx-swap)
  --asset-class <cls>   Asset class, for providers that serve more than one
                          (binance/okx: crypto | futures; default: the
                          provider's default class)
  CREDENTIALS (equities providers — Alpaca / Massive)
    Prefer environment variables — a key on the command line lands in shell
    history and process listings:
      export ALPACA_API_KEY_ID=…  ALPACA_API_SECRET_KEY=…    # Alpaca
      export MASSIVE_API_KEY=…                                # Massive
  --api-key <key>       Alpaca key id / Massive key. DISCOURAGED (leaks via shell
                          history); overrides the env var. Prefer the env vars above.
  --api-secret <secret> Alpaca secret key. DISCOURAGED (leaks); prefer
                          ALPACA_API_SECRET_KEY.
  --feed iex|sip        Alpaca data feed (default iex)
  --mintick <n>         Instrument tick size override. Default: the provider's
                          exchange metadata (tickSize), else 0.01
  --min-qty <n>         Instrument lot step override — the broker truncates
                          derived order sizes and margin-call liquidation
                          quantities to this step (TV parity). Default: the
                          provider's exchange metadata (e.g. Binance LOT_SIZE
                          stepSize), else 0.001
  --no-security         Skip request.security dependency resolution (cross-symbol
                          / lower-TF fetch + inject); those requests degrade to na
  --no-cache            Disable the on-disk history cache
  --cache-dir <dir>     Cache directory (default .pinery-cache)
  --refresh             Refresh cached history
  --json                Emit JSON instead of a table

EXAMPLE
  pinerun scan rsi.pine --symbols BTCUSDT,ETHUSDT,SOLUSDT --tf 1h \\
    --limit 500 --rank "last(rsi)" --top 10`,

  backtest: `BACKTEST OPTIONS
  --symbol <sym>        Single symbol to backtest (required; strategy scripts only)
  --input name=value    Fixed input override (REPEATABLE; ONE value each —
                          grids are sweep's job). Validated against the script.
  --trades              Also print the closed-trade ledger under the tearsheet
                          (>20 trades elide to the first/last 5 rows)
  --watch [sec]         Live mode: refresh history, rerun, redraw the tearsheet
                          every <sec> seconds (default 60, min 5). Needs a
                          terminal; Ctrl-C exits. Incompatible with --json.
  --no-chart            Skip the in-terminal price/equity/drawdown charts and
                          the trade P/L histogram (the MONTHLY RETURNS and TOP
                          DRAWDOWNS tables always print)
  --tf, --from, --to, --limit, --backend, --provider, --asset-class,
  --api-key, --api-secret, --feed, --periods-per-year, --risk-free-rate,
  --mintick, --min-qty, --csv, --plot, --no-security, --no-cache,
  --cache-dir, --refresh, --json   (as scan)

  Prints a full tearsheet: returns (net/gross, buy & hold, CAGR), risk (drawdown,
  volatility, Sharpe/Sortino/Calmar, exposure), and trade quality (win rate,
  profit factor, expectancy, streaks), then MONTHLY RETURNS (year × month %
  grid), TOP DRAWDOWNS (the 5 deepest episodes with recovery dates), and a
  TRADE P/L DISTRIBUTION histogram. The ledger + equity curve are always
  computed, so --csv / --plot / --json need no extra flags. Charts: a PRICE
  panel (close line, each trade marked at its fill price — ▲ long / ▼ short
  entry, ● win / ○ loss exit, colored green/red on a TTY), then EQUITY and
  DRAWDOWN.

BACKTEST EXAMPLE
  pinerun backtest examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h \\
    --limit 500 --plot out/`,

  compare: `COMPARE OPTIONS
  Two strategies (or ONE strategy under two input sets) on the same bars:
  a side-by-side metric table and an overlaid normalized equity chart
  (A cyan / B yellow on a TTY; two stacked charts when piped).

  --symbol <sym>        The symbol both strategies run on (required)
  --input-a name=value  Fixed input override for script A (REPEATABLE)
  --input-b name=value  Fixed input override for script B (REPEATABLE)
  --label-a / --label-b Column/legend labels (default: the script filenames)
  --no-chart            Skip the equity overlay
  --tf, --from, --to, --limit, --backend, --provider, --asset-class,
  --api-key, --api-secret, --feed, --periods-per-year, --risk-free-rate,
  --no-security, --no-cache, --cache-dir, --refresh, --json   (as scan)

COMPARE EXAMPLES
  pinerun compare examples/sma-cross-param.pine examples/rsi-mean-reversion.pine \\
    --symbol BTCUSDT --tf 1h --limit 500

  # same script, two parameterizations
  pinerun compare strat.pine strat.pine --symbol BTCUSDT --tf 1h \\
    --input-a fast=5 --input-b fast=20 --label-a fast-5 --label-b fast-20`,

  portfolio: `PORTFOLIO OPTIONS
  --symbols a,b,c       Basket, in PRIORITY order — at equal timestamps earlier
                          symbols fill first (spec S4). Or --universe <file>.
  --mode <m>            Capital model (default isolated):
                          isolated — N sub-accounts funded wᵢ·P; equals the
                            classic per-symbol runs summed (equal/weighted sleeves)
                          shared   — ONE pot: percent-of-equity sizing, funds
                            checks, margin, and risk rules read portfolio equity;
                            trades can differ from any per-symbol run
  --capital <P>         Total pot (default: N × the script's initial_capital)
  --weights s=f,...     Per-symbol funding fractions, isolated mode only
                          (e.g. --weights BTCUSDT=0.5,ETHUSDT=0.3,SOLUSDT=0.2;
                          normalized; default equal)
  --input name=value    Fixed input override applied to every sleeve (REPEATABLE)
  --trades              Also print the merged, symbol-tagged ledger
                          (>20 trades elide to the first/last 5 rows)
  --no-chart            Skip the in-terminal equity/drawdown/sleeve charts and
                          the trade P/L histogram (MONTHLY RETURNS, TOP
                          DRAWDOWNS, and the isolated-mode SLEEVE RETURN
                          CORRELATION matrix always print)
  --csv <dir>           portfolio-trades/equity.csv + per-sleeve CSVs
  --plot <dir>          portfolio.html + per-sleeve equity/drawdown charts
  --tf, --from, --to, --limit, --backend, --provider, --asset-class,
  --api-key, --api-secret, --feed, --periods-per-year, --risk-free-rate,
  --concurrency, --no-security, --no-cache, --cache-dir, --refresh,
  --json   (as scan)

  Portfolio drawdown/run-up are CLOSE-TO-CLOSE on the combined curve (cross-
  symbol intrabar paths are not modeled); per-sleeve reports keep intrabar
  extremes. Semantics spec: piner docs/portfolio-semantics.md.

PORTFOLIO EXAMPLE
  pinerun portfolio examples/sma-cross-param.pine --symbols BTCUSDT,ETHUSDT,SOLUSDT \\
    --tf 1h --limit 1000 --mode shared --capital 30000 --plot out/`,

  sweep: `SWEEP OPTIONS
  --symbol <sym>        Single symbol to backtest across the grid
  --symbols a,b,c       Multi-symbol grid: every combo runs on every symbol
                          (the symbol becomes an implicit axis; bars fetched
                          once per symbol; the table gains a SYMBOL column)
  --universe <file>     File of symbols for the multi-symbol grid (as scan)
  --input name=spec     Swept input axis (REPEATABLE). spec is a list or a range:
                          --input fast=5,10,20      (list)
                          --input slow=30:100:10    (range start:stop:step)
                          --input len=5,10:20:5     (list members may be ranges)
                          --input useStop=true,false
                          --input sess="'09:30'"    (quoted → literal string; an
                                                     unquoted 09:30 is a range)
                          the name must match a Pine input() title (validated
                          against the script before anything runs)
  --sample <n>          Smart search: run n randomly sampled combos instead of
                          the exhaustive grid (huge grids become tractable; the
                          --max-combos guard then applies to n, not the grid)
  --seed <n>            PRNG seed for --sample (default 42; same seed → same combos)
  --heatmap             Print the 2-axis optimization surface as a value grid
                          (requires exactly two --input axes; missing/sampled-out
                          cells print ·; one grid per symbol on a multi-symbol
                          sweep; cells grade red → green by value on a TTY)
  --points-csv <file>   Write EVERY run as one CSV row (symbol, axes, value,
                          strategy stats, error) — the whole optimization surface,
                          pandas-ready; cheap (no ledgers, unlike --csv)
  --tf, --from, --to, --limit, --rank, --top, --asc, --trades, --no-chart,
  --concurrency, --workers, --backend, --provider, --asset-class, --api-key,
  --api-secret, --feed, --periods-per-year, --risk-free-rate, --csv, --plot,
  --no-security, --no-cache, --cache-dir, --refresh, --json   (as scan;
                          exports are per ranked combo, labeled <symbol>-<combo>;
                          with --trades the table gains an EQUITY sparkline and
                          the winning combo prints its PRICE chart + ledger)
  --max-combos <n>      Cap on total runs: combos × symbols (default 5000)

  Rank defaults to strategy.netProfit for strategies, else "last".

SWEEP EXAMPLES
  pinerun sweep examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h \\
    --limit 500 --input fast=5,10,15,20 --input slow=30:100:10 --top 10

  # multi-symbol grid + heatmap + full-surface CSV
  pinerun sweep examples/sma-cross-param.pine --symbols BTCUSDT,ETHUSDT --tf 1h \\
    --limit 500 --input fast=5:20:5 --input slow=30:100:10 --heatmap \\
    --points-csv out/points.csv

  # smart search: 200 random combos out of a 10,000-combo grid
  pinerun sweep examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h \\
    --limit 500 --input fast=1:100 --input slow=1:100 --sample 200 --top 10

  # reproducible sample: same --seed always picks the same combos
  pinerun sweep examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h \\
    --limit 500 --input fast=2:60 --input slow=10:200 --sample 10 --seed 7`,

  walkforward: `WALKFORWARD OPTIONS
  --symbol <sym>        Single symbol to validate (required; strategy scripts only)
  --input name=spec     Swept input axis (REPEATABLE; same grammar as sweep)
  --windows <n>         Walk-forward windows (default 5; 1 = plain IS/OOS split)
  --oos <f>             OOS share of each window, 0<f<1 (default 0.25)
  --anchored            Expanding in-sample from bar 0 (default: rolling)
  --no-chart            Skip the per-window OOS EQUITY sparkline column
  --rank <spec>         Metric that picks each window's winner
                          (default strategy.netProfit)
  --tf, --from, --to, --limit, --concurrency, --workers, --backend, --provider,
  --asset-class, --api-key, --api-secret, --feed, --periods-per-year,
  --risk-free-rate, --max-combos, --no-security, --no-cache, --cache-dir,
  --refresh, --json (as sweep)

  Each window sweeps the grid on the in-sample segment, picks the winner by
  --rank, then measures that winner on the following out-of-sample segment
  (IS doubles as indicator warmup). OOS segments tile the tail of history, so
  every OOS bar is traded by parameters chosen strictly on earlier data.
  Verdict: WFE (per-bar OOS/IS profit ratio) ~1 = real edge, << 1 = overfit.

WALKFORWARD EXAMPLE
  pinerun walkforward examples/sma-cross-param.pine --symbol BTCUSDT --tf 1h \\
    --limit 2000 --input fast=5,10,15,20 --input slow=30:100:10 --windows 5`,

  upgrade: `UPGRADE OPTIONS
  --check               Report whether a newer release exists; change nothing

  Downloads the latest GitHub release's binary for this platform, verifies its
  sha256 against the release's checksums.txt, and atomically replaces the
  current executable. Only the compiled binary self-updates — from a source
  checkout, git pull and rebuild (bun run build:bin --install) instead.

UPGRADE EXAMPLE
  pinerun upgrade --check      # is a newer release out?
  pinerun upgrade              # download, verify, and swap in place`,
};

const HELP_ORDER = [
  'init',
  'scan',
  'backtest',
  'compare',
  'portfolio',
  'sweep',
  'walkforward',
  'upgrade',
];

/** Full help, or — when `command` names a known command — just that command's section. */
function printHelp(command?: string): void {
  const body =
    command && HELP_SECTIONS[command]
      ? HELP_SECTIONS[command]
      : HELP_ORDER.map((c) => HELP_SECTIONS[c]).join('\n\n');
  console.log(`${HELP_USAGE}\n\n${body}`);
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
}
