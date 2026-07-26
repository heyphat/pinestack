/**
 * executeJob — the single, backend-agnostic run primitive. Compiles the Pine
 * source, runs it over the job's bars via piner's Engine, and projects the
 * outputs into a serializable `RunResult`. Pure (piner-only, no I/O), so it runs
 * identically in-process (LocalRunner) or inside a worker.
 */
import { compile, CompileError, Engine, ArrayFeed, StrategyBroker } from '@heyphat/piner';
import type { CompiledScript, EngineOptions } from '@heyphat/piner';

/**
 * Does the loaded piner engine model calc_on_order_fills? Probed from a fresh
 * broker's DEFAULT settings: a feature-capable engine initializes the field
 * (`calcOnOrderFills: false`), piner ≤ 0.9.0 has no such key. Probing the
 * default is load-bearing — configure() Object.assigns overrides into the
 * settings, so a configured broker would show the key even on an engine that
 * ignores it (Phase 3 audit, findings 1-2).
 */
const ENGINE_SUPPORTS_COOF = 'calcOnOrderFills' in new StrategyBroker().settings;
import type { Job } from './job.js';
import type { Bar } from './job.js';
import { jobId } from './job.js';
import type { RunResult, PlotResult, StrategySummary, StrategyTrade } from './result.js';

// Per-process compile cache: scanning one script across N symbols recompiles once.
const compileCache = new Map<string, CompiledScript>();

function compileCached(source: string): CompiledScript {
  let compiled = compileCache.get(source);
  if (!compiled) {
    compiled = compile(source);
    compileCache.set(source, compiled);
  }
  return compiled;
}

export async function executeJob(job: Job): Promise<RunResult> {
  const id = jobId(job);
  const started = Date.now();
  const base: RunResult = {
    id,
    symbol: job.symbol,
    timeframe: job.timeframe,
    ok: false,
    bars: job.bars.length,
    plots: [],
    alerts: [],
  };

  let compiled: CompiledScript;
  try {
    compiled = compileCached(job.source);
  } catch (err) {
    return {
      ...base,
      error: err instanceof CompileError ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  }

  const errors = compiled.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    return {
      ...base,
      diagnostics: compiled.diagnostics.map(fmtDiag),
      error: `compile: ${errors.map((d) => d.message).join('; ')}`,
      elapsedMs: Date.now() - started,
    };
  }

  // An explicit calc_on_order_fills override on an engine that ignores the
  // field must fail loudly, not run once-per-bar under a distinct memo key
  // while reporting the mode as active (Phase 3 audit, findings 1-2).
  if (job.calcOnOrderFills != null && !ENGINE_SUPPORTS_COOF) {
    return {
      ...base,
      error:
        'calc_on_order_fills override: the loaded @heyphat/piner engine does not ' +
        'model calc_on_order_fills (needs a release newer than 0.9.0) — remove ' +
        'the override or upgrade the engine',
      elapsedMs: Date.now() - started,
    };
  }

  try {
    // Host overrides applied AFTER the strategy() header (piner: override wins).
    // The extra-key cast drops once the @heyphat/piner peer dep ships
    // calcOnOrderFills in StrategySettings (> 0.9.0); older engines carry the
    // setting inertly.
    const strategyOverride: Record<string, unknown> = {};
    if (job.minQty != null) strategyOverride.minQty = job.minQty; // lot step → TV-parity qty truncation
    if (job.calcOnOrderFills != null) strategyOverride.calcOnOrderFills = job.calcOnOrderFills;
    const engine = new Engine(compiled, new ArrayFeed(toPinerBars(job.bars)), {
      backend: job.backend ?? 'js',
      inputs: job.inputs,
      strategy: Object.keys(strategyOverride).length
        ? (strategyOverride as EngineOptions['strategy'])
        : undefined,
    });
    // Inject host-fetched request.security bars (cross-symbol / lower-TF) before the run.
    if (job.securityBars) {
      for (const [key, bars] of Object.entries(job.securityBars))
        engine.ctx.securityBars.set(key, toPinerBars(bars));
    }
    await engine.run({ symbol: job.symbol, timeframe: job.timeframe, mintick: job.mintick });

    const plots: PlotResult[] = [];
    for (const p of engine.outputs.plots.values()) {
      plots.push({ id: p.id, title: p.title, data: fillDense(p.data, job.bars.length) });
    }
    plots.sort((a, b) => a.id - b.id);

    const alerts = engine.outputs.alerts.map((a) => ({ bar: a.bar, message: a.message }));

    let strategy: StrategySummary | undefined;
    let trades: StrategyTrade[] | undefined;
    let equityCurve: number[] | undefined;
    let barTimes: number[] | undefined;
    let closes: number[] | undefined;
    if (compiled.metadata.isStrategy) {
      // Read piner's authoritative stats off the strategy namespace + broker (the
      // same values a Pine script sees); pinerun performs no calculations of its own.
      const st = engine.ctx.strategy;
      const broker = engine.ctx.strategyBroker;
      const report = engine.strategy;
      // Effective fill model, read from the ENGINE's post-configure settings —
      // never from the requested configuration: an engine that ignores the
      // field must not be reported as running it (Phase 3 audit, finding 2).
      // On a capable engine this reflects header + override precedence; on
      // piner ≤ 0.9.0 the key is absent (overrides were rejected above).
      const effectiveCoof = (broker.settings as { calcOnOrderFills?: boolean }).calcOnOrderFills;
      strategy = {
        calcOnOrderFills: effectiveCoof === true || undefined,
        initialCapital: st.initial_capital,
        netProfit: st.netprofit,
        netProfitPercent: st.netprofit_percent,
        grossProfit: st.grossprofit,
        grossProfitPercent: st.grossprofit_percent,
        grossLoss: st.grossloss,
        grossLossPercent: st.grossloss_percent,
        profitFactor: broker.profitFactor,
        wins: st.wintrades,
        losses: st.losstrades,
        evens: report.evens,
        closedTrades: st.closedtrades,
        winRate: broker.winRate,
        avgTrade: st.avg_trade,
        avgTradePercent: st.avg_trade_percent,
        avgWinningTrade: st.avg_winning_trade,
        avgLosingTrade: st.avg_losing_trade,
        maxDrawdown: st.max_drawdown,
        maxDrawdownPercent: st.max_drawdown_percent,
        maxRunup: st.max_runup,
        maxRunupPercent: st.max_runup_percent,
        maxContractsHeld: st.max_contracts_held_all,
        totalCommission: report.totalCommission,
        barsProcessed: report.barsProcessed,
        barsInMarket: report.barsInMarket,
        // Derived analytics stay piner's: annualized off the run's bar times unless
        // the job supplies a host convention (periodsPerYear / riskFreeRate).
        metrics: engine.strategyMetrics(job.metrics),
      };
      if (job.includeTrades) {
        trades = broker.closedTrades.map((t) => ({ ...t }));
        equityCurve = broker.equityCurve.slice();
        barTimes = job.bars.map((b) => b.time);
        closes = job.bars.map((b) => b.close);
      }
    }

    return {
      ...base,
      ok: true,
      plots,
      alerts,
      strategy,
      trades,
      equityCurve,
      barTimes,
      closes,
      securityRequests: engine.outputs.securityRequests.map((r) => ({ ...r })),
      diagnostics: compiled.diagnostics.length ? compiled.diagnostics.map(fmtDiag) : undefined,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ...base,
      error: String(err instanceof Error ? err.message : err),
      elapsedMs: Date.now() - started,
    };
  }
}

function fmtDiag(d: { severity: string; message: string }): string {
  return `${d.severity}: ${d.message}`;
}

/** Normalize a possibly-sparse plot array to a dense length-`n` array (holes → NaN). */
function fillDense(data: number[], n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = data[i];
    out[i] = v === undefined ? NaN : v;
  }
  return out;
}

/**
 * pinery/pinerun carry bar times in unix SECONDS (ergonomic; CLI dates, cache keys);
 * piner's engine expects MILLISECONDS (TradingView convention — its daily/weekly/session
 * bucketing uses ms). Convert at this single boundary. Values already in ms (>= ~1e12)
 * pass through, so an ms-native feed still works.
 */
function toPinerBars(bars: Bar[]): Bar[] {
  return bars.map((b) => (b.time >= 1e12 ? b : { ...b, time: b.time * 1000 }));
}
