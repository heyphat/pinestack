import { describe, expect, test } from 'bun:test';
import { INTENTIONALLY_ABSENT, COMMANDS, schemaFor } from '../src/flags/schema.js';
import { buildHeatmap, heatmapLegend } from '../src/views/heatmap.js';
import {
  fillModelNote,
  profitFactor,
  tearsheetFooter,
  tearsheetSections,
} from '../src/views/report.js';
import { appendSession, readSession, sessionLogPath } from '../src/run/session-log.js';
import { classify } from '../src/run/spawn.js';
import { loadFlags, saveFlags } from '../src/persist.js';
import { emptyModel } from '../src/flags/model.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summary } from './fixtures/reports.js';

describe('values JSON cannot carry are recovered from siblings, not faked', () => {
  test('profitFactor arrives as null when the run had no losses — sibling fields say ∞', () => {
    // JSON.stringify(Infinity) is "null", so this is what actually lands.
    const s = summary({
      profitFactor: null as unknown as number,
      grossProfit: 2_610_000,
      grossLoss: 0,
    });
    expect(profitFactor(s)).toBe('∞');
  });

  test('a genuinely absent profit factor still shows —', () => {
    const s = summary({
      profitFactor: null as unknown as number,
      grossProfit: 0,
      grossLoss: 0,
    });
    expect(profitFactor(s)).toBe('—');
  });

  test('a finite profit factor is shown as-is', () => {
    expect(profitFactor(summary({ profitFactor: 1.61 }))).toBe('1.61');
  });

  test('the tearsheet carries the ∞ through', () => {
    const rows = allRows(
      summary({ profitFactor: null as unknown as number, grossProfit: 10, grossLoss: 0 }),
    );
    expect(rows.find((r) => r.label === 'profit factor')!.value).toBe('∞');
  });
});

/** Every row of every section, flattened, for label lookups. */
function allRows(s: Parameters<typeof tearsheetSections>[0]) {
  return tearsheetSections(s).flatMap((section) => section.rows);
}

describe('the tearsheet mirrors `pinerun backtest` (§3 NG1)', () => {
  test('three sections, in the CLI’s order', () => {
    expect(tearsheetSections(summary()).map((s) => s.title)).toEqual(['RETURNS', 'RISK', 'TRADES']);
  });

  test('every row the CLI prints is present, with the CLI’s label', () => {
    const labels = allRows(summary()).map((r) => r.label);
    // Transcribed from printTearsheet in pinerun/src/cli.ts.
    for (const label of [
      'net profit',
      'gross profit',
      'gross loss',
      'buy & hold',
      'outperformance',
      'CAGR',
      'max drawdown',
      'max runup',
      'volatility (annual)',
      'sharpe',
      'sortino',
      'calmar',
      'exposure',
      'closed trades',
      'win rate',
      'profit factor',
      'expectancy',
      'avg win / loss',
      'largest win / loss',
      'max consecutive',
      'avg bars in trade',
      'commission paid',
      'max contracts held',
    ]) {
      expect(labels).toContain(label);
    }
    expect(labels).toHaveLength(23);
  });

  test('no metric is invented — every row maps to a report field', () => {
    // The old rail carried a "Turnover" it derived itself; §3 NG1 forbids that.
    expect(allRows(summary()).map((r) => r.label)).not.toContain('Turnover');
  });

  test('values use the CLI’s own formatters', () => {
    const rows = allRows(summary({ netProfit: 984_000, netProfitPercent: 98.4 }));
    const net = rows.find((r) => r.label === 'net profit')!;
    expect(net.value).toBe('984000.00'); // fmtNum: 2dp at >= 100
    expect(net.percent).toBe('98.40%'); // fmtPct: always 2dp
    expect(rows.find((r) => r.label === 'sharpe')!.value).toBe('1.42'); // fmtPf
  });

  test('the money and percent columns stay separate', () => {
    const rows = allRows(summary());
    // A row with both.
    expect(rows.find((r) => r.label === 'max drawdown')).toMatchObject({
      value: expect.any(String),
      percent: expect.stringContaining('%'),
    });
    // A percent-only row — the CLI leaves the money column blank.
    expect(rows.find((r) => r.label === 'CAGR')!.value).toBe('');
    expect(rows.find((r) => r.label === 'buy & hold')!.value).toBe('');
    // A number-only row.
    expect(rows.find((r) => r.label === 'sortino')!.percent).toBe('');
  });

  test('closed trades carries the W/L/E breakdown the CLI shows', () => {
    const rows = allRows(summary({ closedTrades: 1284, wins: 704, losses: 580, evens: 0 }));
    const trades = rows.find((r) => r.label === 'closed trades')!;
    expect(trades.value).toBe('1284');
    expect(trades.percent).toBe('(704W 580L 0E)');
  });

  test('drawdown is a magnitude in the report; the sign marks it a loss', () => {
    const dd = allRows(summary({ maxDrawdownPercent: 17.2 })).find(
      (r) => r.label === 'max drawdown',
    )!;
    expect(dd.percent).toBe('17.20%');
    expect(dd.sign).toBe(-1);
  });

  test('an absent metrics block degrades to na, not zero', () => {
    const rows = allRows(summary({ metrics: undefined as never }));
    expect(rows.find((r) => r.label === 'sharpe')!.value).toBe('na');
    expect(rows.find((r) => r.label === 'CAGR')!.percent).toBe('na');
  });

  test('no sections at all when there is no strategy', () => {
    expect(tearsheetSections(undefined)).toEqual([]);
  });

  test('the footer repeats the CLI’s closing line, compacted for a 38-col rail', () => {
    const footer = tearsheetFooter(summary()).join(' · ');
    expect(footer).toContain('initial capital');
    // `annualized at 8760.00 periods/yr` → `8760/yr`: same fact, fits the rail.
    expect(footer).toContain('8760/yr');
    expect(footer.length).toBeLessThanOrEqual(38);
  });

  test('the fill model goes to the legend, not the footer', () => {
    expect(fillModelNote(summary())).toBeUndefined();
    expect(fillModelNote(summary({ calcOnOrderFills: true }))).toBe('calc-on-order-fills');
    expect(
      fillModelNote(
        summary({
          barMagnifier: {
            requested: true,
            active: true,
            targetTimeframe: '1',
            magnifiedBars: 10,
            fallbackBars: 0,
            capFallbackBars: 0,
            dataFallbackBars: 0,
            intrabarsUsed: 10,
            coverage: 'complete',
          },
        }),
      ),
    ).toContain('magnifier complete');
  });
});

describe('the sweep surface', () => {
  const axes = [
    { name: 'fast', values: [5, 10, 15] },
    { name: 'slow', values: [20, 30, 40] },
  ];
  const ranked = [
    { inputs: { fast: 5, slow: 20 }, value: 4920 },
    { inputs: { fast: 10, slow: 20 }, value: 4233 },
    { inputs: { fast: 5, slow: 30 }, value: 3670 },
  ];

  test('cells land at their axis intersection', () => {
    const map = buildHeatmap(axes, ranked)!;
    expect(map.yLabels).toEqual(['5', '10', '15']);
    expect(map.xLabels).toEqual(['20', '30', '40']);
    expect(map.rows[0]![0]!.text).toBe('4920');
    expect(map.rows[1]![0]!.text).toBe('4233');
  });

  test('cells with no ranked point behind them are dots, and are counted', () => {
    const map = buildHeatmap(axes, ranked)!;
    expect(map.rows[2]![2]!.present).toBe(false);
    expect(map.rows[2]![2]!.text).toBe('·');
    expect(map.missing).toBe(6);
    expect(map.total).toBe(9);
  });

  test('the legend blames --top when that is the cause (§6: no silent truncation)', () => {
    const map = buildHeatmap(axes, ranked)!;
    expect(heatmapLegend(map, 3)).toContain('outside --top 3');
    expect(heatmapLegend(map, undefined)).toContain('not run or failed');
  });

  test('a full surface needs no legend', () => {
    const full = buildHeatmap(
      [
        { name: 'a', values: [1, 2] },
        { name: 'b', values: [1, 2] },
      ],
      [
        { inputs: { a: 1, b: 1 }, value: 1 },
        { inputs: { a: 1, b: 2 }, value: 2 },
        { inputs: { a: 2, b: 1 }, value: 3 },
        { inputs: { a: 2, b: 2 }, value: 4 },
      ],
    )!;
    expect(full.missing).toBe(0);
    expect(heatmapLegend(full, undefined)).toBeUndefined();
  });

  test('the surface refuses anything but exactly two axes, as --heatmap does', () => {
    expect(buildHeatmap([{ name: 'a', values: [1] }], ranked)).toBeUndefined();
    expect(buildHeatmap(undefined, ranked)).toBeUndefined();
    expect(buildHeatmap([...axes, { name: 'c', values: [1] }], ranked)).toBeUndefined();
  });

  test('best and worst cells grade to opposite ends of the CLI quintiles', () => {
    const map = buildHeatmap(axes, ranked)!;
    expect(map.rows[0]![0]!.style).toBe('1;32');
    expect(map.rows[0]![1]!.style).toBe('31');
  });
});

describe('the flag schema is checkable against the CLI (§10.1)', () => {
  test('credentials are declared as intentionally absent, not merely missing', () => {
    expect(INTENTIONALLY_ABSENT.has('api-key')).toBe(true);
    expect(INTENTIONALLY_ABSENT.has('api-secret')).toBe(true);
  });

  test('every command declares a script count and a min-width', () => {
    for (const command of COMMANDS) {
      const schema = schemaFor(command);
      expect(schema.scripts).toBeGreaterThanOrEqual(1);
      expect(schema.minCols).toBeGreaterThan(60);
    }
  });

  test('compare is the only two-script command', () => {
    const twoScript = COMMANDS.filter((c) => schemaFor(c).scripts === 2);
    expect(twoScript).toEqual(['compare']);
  });

  test('no command declares a flag twice', () => {
    for (const command of COMMANDS) {
      const names = schemaFor(command).flags.map((f) => f.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe('the engine log grades its own lines (§8)', () => {
  test('failures grade as errors', () => {
    expect(classify('fetch failed: DOGEUSDT — provider returned 451')).toBe('error');
    expect(classify('error: undeclared identifier')).toBe('error');
  });

  test('caveats grade as warnings', () => {
    expect(classify('warning: security request degraded to na')).toBe('warn');
    expect(classify('  skipped 3 combos')).toBe('warn');
  });

  test('narration grades as info', () => {
    expect(classify('fetch: BTCUSDT 1h — cache hit (600 bars)')).toBe('info');
    expect(classify('resolve: strats/mean-rev-btc.pine')).toBe('info');
  });
});

describe('the session log makes any on-screen result reproducible (§8)', () => {
  test('entries round-trip, and argv is what was spawned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinetop-session-'));
    try {
      appendSession(
        {
          at: '2026-07-31T12:00:00.000Z',
          command: 'backtest',
          argv: ['backtest', 'a.pine', '--symbol', 'BTCUSDT', '--json'],
          exitCode: 0,
          elapsedMs: 148,
          ok: true,
          runId: '#401',
        },
        dir,
      );
      expect(existsSync(sessionLogPath(dir))).toBe(true);
      const entries = readSession(dir);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.runId).toBe('#401');
      expect(entries[0]!.argv).toContain('--symbol');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reading a project with no log is empty, not an error', () => {
    expect(readSession(join(tmpdir(), 'pinetop-nope-does-not-exist'))).toEqual([]);
  });
});

describe('persistence resumes flags but never pending edits (§7 P6, §4.5.c)', () => {
  test('flags round-trip through .pinetop/flags.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinetop-flags-'));
    try {
      const flags = Object.fromEntries(COMMANDS.map((c) => [c, emptyModel(c)])) as Record<
        (typeof COMMANDS)[number],
        ReturnType<typeof emptyModel>
      >;
      flags.backtest.scripts = ['a.pine'];
      flags.backtest.values['symbol'] = 'BTCUSDT';
      flags.backtest.values['limit'] = 500;

      saveFlags(flags, dir);
      const loaded = loadFlags(dir);
      expect(loaded.backtest?.scripts).toEqual(['a.pine']);
      expect(loaded.backtest?.values['symbol']).toBe('BTCUSDT');
      expect(loaded.backtest?.values['limit']).toBe(500);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a flag name the current schema does not know is dropped, not composed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pinetop-flags-'));
    try {
      const flags = Object.fromEntries(COMMANDS.map((c) => [c, emptyModel(c)])) as Record<
        (typeof COMMANDS)[number],
        ReturnType<typeof emptyModel>
      >;
      flags.backtest.values['gone-in-next-version'] = 'x';
      saveFlags(flags, dir);
      expect(loadFlags(dir).backtest?.values['gone-in-next-version']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loading a project with no state file is empty, not an error', () => {
    expect(loadFlags(join(tmpdir(), 'pinetop-nope-does-not-exist'))).toEqual({});
  });
});
