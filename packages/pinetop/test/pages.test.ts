import { describe, expect, test, beforeEach } from 'bun:test';
import { App, PAGE_MAP } from '../src/app.js';
import { COMMANDS, PAGES, type CommandId, type PageId } from '../src/flags/schema.js';
import { cachedScripts, refreshScripts } from '../src/scripts.js';
import { BINDINGS, RESERVED_KEYS, matchSequence, paneAccelerators } from '../src/keymap.js';
import { hiddenFlagCount, isRunRow, runRowCount, visibleFlags } from '../src/pages/config-pane.js';
import { cloneModel, composeArgv, type Pair } from '../src/flags/model.js';
import { HISTORY_LIMIT, evictHistory } from '../src/pages/history-pane.js';
import { paletteItems } from '../src/overlays.js';
import { stripAnsi } from '../src/render/screen.js';
import { initialState, resetRunIds, type AppState, type RunState } from '../src/state.js';
import type { Key, Terminal, TerminalSize } from '../src/terminal.js';
import {
  backtestReport,
  portfolioReport,
  scanReport,
  sweepReport,
  walkforwardReport,
  compareReport,
} from './fixtures/reports.js';

/** A Terminal that renders nowhere: the App only needs size and the hooks. */
function stubTerminal(cols = 168, rows = 46): Terminal {
  const keyHandlers = new Set<(key: Key) => void>();
  return {
    size: { cols, rows } as TerminalSize,
    isTTY: true,
    open() {},
    close() {},
    paint() {},
    onKey(handler: (key: Key) => void) {
      keyHandlers.add(handler);
      return () => keyHandlers.delete(handler);
    },
    onResizeEvent() {
      return () => {};
    },
  } as unknown as Terminal;
}

function makeApp(state: AppState, cols = 168, rows = 46): App {
  return new App({ terminal: stubTerminal(cols, rows), state, cwd: '/tmp/pinetop-test' });
}

function screenText(app: App, cols = 168, rows = 46): string {
  return app
    .render(cols, rows)
    .map((l) => stripAnsi(l))
    .join('\n');
}

/** `:`, type enough of an item's label to select it, `↵`. */
function openPalette(app: App, query: string): void {
  app.onKey({ name: ':', text: ':' });
  for (const ch of query) app.onKey({ name: ch, text: ch });
  app.onKey({ name: 'enter' });
}

let state: AppState;

beforeEach(() => {
  resetRunIds();
  state = initialState();
  state.flags.backtest.scripts = ['strats/mean-rev-btc.pine'];
  state.flags.backtest.values['symbol'] = 'BTC-PERP';
  state.flags.backtest.values['tf'] = '1h';
});

describe('P0 — the shell', () => {
  test('every page renders at 168×46 without throwing', () => {
    const app = makeApp(state);
    for (const page of PAGES) {
      state.page = page;
      expect(() => app.render(168, 46)).not.toThrow();
    }
  });

  test('every page renders at a cramped 80×24 without throwing', () => {
    const app = makeApp(state, 80, 24);
    for (const page of PAGES) {
      state.page = page;
      expect(() => app.render(80, 24)).not.toThrow();
    }
  });

  test('every rendered line is at most the terminal width', () => {
    const app = makeApp(state);
    for (const page of PAGES) {
      state.page = page;
      for (const line of app.render(168, 46)) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(168);
      }
    }
  });

  test('the frame is exactly as many rows as the terminal', () => {
    expect(makeApp(state).render(168, 46)).toHaveLength(46);
    expect(makeApp(state).render(100, 30)).toHaveLength(30);
  });

  test('the tab bar numbers the eight pages in workflow order', () => {
    const text = screenText(makeApp(state));
    expect(text).toContain('1 EDITOR');
    expect(text).toContain('2 BACKTEST');
    expect(text).toContain('3 SWEEP');
    expect(text).toContain('4 WALKFORWARD');
    expect(text).toContain('5 SCAN');
    expect(text).toContain('6 PORTFOLIO');
    expect(text).toContain('7 COMPARE');
    expect(text).toContain('8 LOGS');
  });

  test('a terminal too narrow for eight titles names only the page you are on', () => {
    state.page = 'scan';
    const text = screenText(makeApp(state, 80, 24), 80, 24);
    const tabs = text.split('\n')[0]!;
    expect(tabs).toContain('5 SCAN');
    expect(tabs).not.toContain('WALKFORWARD');
    // The grid size still has room, which is the whole point of going compact.
    expect(tabs).toContain('80×24');
  });

  test('1–8 switch pages', () => {
    const app = makeApp(state);
    const expected: PageId[] = [...PAGES];
    for (let i = 0; i < expected.length; i++) {
      app.onKey({ name: String(i + 1), text: String(i + 1) });
      expect(state.page).toBe(expected[i]!);
    }
  });

  test('tab cycles the focus ring and wraps', () => {
    const app = makeApp(state);
    const panes = app.page.panes(state);
    const first = state.panes.backtest.focus;
    for (let i = 0; i < panes.length; i++) app.onKey({ name: 'tab' });
    expect(state.panes.backtest.focus).toBe(first);
  });

  test('shift-tab walks the ring backwards', () => {
    const app = makeApp(state);
    const panes = app.page.panes(state);
    app.onKey({ name: 'shift-tab' });
    expect(state.panes.backtest.focus).toBe(panes[panes.length - 1]);
  });

  test('? answers "what am I running" — both binaries', () => {
    state.versions = { pinetop: 'pinetop 0.6.1 (abc1234)', pinerun: 'pinerun 0.6.1 (abc1234)' };
    const app = makeApp(state);
    app.onKey({ name: '?', text: '?' });
    const text = screenText(app);
    expect(text).toContain('pinetop 0.6.1 (abc1234)');
    // The spawned CLI is the other half: every number came out of it.
    expect(text).toContain('driving pinerun 0.6.1 (abc1234)');
  });

  test('? says so when pinerun could not be found', () => {
    state.versions = { pinetop: 'pinetop 0.6.1' };
    const app = makeApp(state);
    app.onKey({ name: '?', text: '?' });
    expect(screenText(app)).toContain('pinerun not found');
  });

  test('? documents the real keymap, generated from the bindings table', () => {
    const app = makeApp(state);
    app.onKey({ name: '?', text: '?' });
    const text = screenText(app);
    expect(text).toContain('KEYS');
    expect(text).toContain('shift-tab');
    expect(text).toContain('Reject pending AI proposal');
    expect(text).toContain('Command palette');
  });

  test('? shows every binding, at a tall terminal and a short one', () => {
    // The guard that matters: the overlay is generated, so adding a binding must
    // never push another one off the box. A fixed height did exactly that once.
    for (const [cols, rows] of [
      [168, 46],
      [120, 30],
      [100, 24],
    ] as const) {
      const app = makeApp(state, cols, rows);
      app.onKey({ name: '?', text: '?' });
      const text = screenText(app, cols, rows);
      for (const binding of BINDINGS) {
        // Long descriptions are truncated with an ellipsis at narrow widths; the
        // opening words are enough to prove the row was drawn at all.
        const head = binding.description.slice(0, 20);
        expect(text, `${binding.display} missing at ${cols}×${rows}`).toContain(head);
      }
      app.onKey({ name: 'escape' });
    }
  });

  test('esc dismisses the overlay', () => {
    const app = makeApp(state);
    app.onKey({ name: '?', text: '?' });
    expect(state.overlay.kind).toBe('help');
    app.onKey({ name: 'escape' });
    expect(state.overlay.kind).toBe('none');
  });

  test('the composed command line is always on screen and copy-pasteable', () => {
    const text = screenText(makeApp(state));
    expect(text).toContain('$ pinerun backtest strats/mean-rev-btc.pine --symbol BTC-PERP --tf 1h');
  });

  test('the hint strip lists the real keys', () => {
    const text = screenText(makeApp(state));
    for (const hint of ['tab', 'pane', 'j/k', 'run', 'ask', 'help']) expect(text).toContain(hint);
  });

  test('a terminal below the page minimum is warned about, once', () => {
    const app = makeApp(state, 90, 30);
    const text = screenText(app, 90, 30);
    expect(text).toContain('wants 120');
    expect(state.widthWarning).toBeDefined();
  });
});

describe('P1 — BACKTEST', () => {
  beforeEach(() => {
    state.run = {
      id: '#418',
      command: 'backtest',
      status: 'ok',
      progress: '',
      report: backtestReport(),
      log: [],
      argv: [],
      startedAt: 0,
      elapsedMs: 8000,
    };
  });

  test('the rail shows the CLI’s three tearsheet sections', () => {
    const text = screenText(makeApp(state));
    expect(text).toContain('TEARSHEET');
    expect(text).toContain('RETURNS');
    expect(text).toContain('RISK');
    expect(text).toContain('TRADES');
  });

  test('every tearsheet row the CLI prints reaches the screen', () => {
    const text = screenText(makeApp(state));
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
      expect(text).toContain(label);
    }
  });

  test('a row with both columns keeps both — the wide W/L/E parenthetical bug', () => {
    const text = screenText(makeApp(state));
    // `closed trades  1284  (704W 580L 0E)`: the parenthetical must not overwrite
    // the count, which is what a capped percent track used to do.
    const line = text.split('\n').find((l) => l.includes('closed trades'))!;
    expect(line).toContain('1284');
    expect(line).toContain('(704W 580L 0E)');
  });

  test('the widest tearsheet row is not truncated at the default width', () => {
    const text = screenText(makeApp(state));
    const line = text.split('\n').find((l) => l.includes('largest win / loss'))!;
    expect(line).toContain('8420.00 / -3180.00');
    expect(line).not.toContain('…');
  });

  test('the rail carries the CLI’s closing line', () => {
    const text = screenText(makeApp(state));
    expect(text).toContain('initial capital');
    expect(text).toContain('8760/yr');
  });

  test('metric values come from the report, not from anywhere else', () => {
    const text = screenText(makeApp(state));
    expect(text).toContain('1.42'); // strategy.metrics.sharpe
    expect(text).toContain('2.11'); // strategy.metrics.sortino
  });

  test('the chart panes are titled and the braille trio is drawn', () => {
    const text = screenText(makeApp(state));
    expect(text).toContain('PRICE');
    expect(text).toContain('EQUITY');
    expect(text).toContain('DRAWDOWN');
    expect(/[⠀-⣿]/.test(text)).toBe(true);
  });

  test('the monthly grids are drawn from pinerun renderers', () => {
    const text = screenText(makeApp(state));
    expect(text).toContain('MONTHLY RETURNS %');
    expect(text).toContain('MONTHLY TRADES');
    expect(text).toContain('JAN');
  });

  test('MONTHLY TRADES is the second view of one pane, not a pane of its own', () => {
    // At 168 only one grid fits, and the legend has to name the key that reveals
    // the other — it is the whole of how the second half is discoverable.
    const app = makeApp(state);
    expect(screenText(app)).toContain('j/k → MONTHLY TRADES');
    app.onKey({ name: 'm', text: 'm' });
    app.onKey({ name: 'o', text: 'o' });
    app.onKey({ name: 'j', text: 'j' });
    expect(screenText(app)).toContain('◆ MONTHLY TRADES');
  });

  test('side by side, both grids say they are the same pane', () => {
    // 220 columns fits both 99-column grids, so `j`/`k` has nothing to swap and
    // the strip must not read as one reachable pane beside one unreachable one.
    const app = makeApp(state, 220, 46);
    const text = screenText(app, 220, 46);
    expect(text).toContain('MONTHLY RETURNS % [mo]');
    expect(text).toContain('MONTHLY TRADES [mo]');

    state.panes.backtest.focus = 'monthly';
    const focused = screenText(app, 220, 46);
    expect(focused).toContain('◆ MONTHLY RETURNS %');
    expect(focused).toContain('◆ MONTHLY TRADES');
  });

  test('the monthly grids carry the CLI’s own green/red grading', () => {
    const app = makeApp(state);
    // The strip shows MONTHLY RETURNS first; both grids are 99 cols so at 168
    // only one is on screen at a time.
    const raw = app.render(168, 46).join('\n');
    expect(raw).toContain('\x1b[32m'); // a positive month
    expect(raw).toContain('\x1b[31m'); // a negative month

    state.panes.backtest.focus = 'monthly';
    app.onKey({ name: 'j', text: 'j' }); // swap to MONTHLY TRADES
    const trades = app.render(168, 46).join('\n');
    expect(trades).toContain('MONTHLY TRADES');
    expect(trades).toContain('\x1b[32m'); // win tallies
    expect(trades).toContain('\x1b[31m'); // loss tallies
  });

  test('colour never shifts a column — the grids pad before painting', () => {
    const app = makeApp(state);
    const lines = app.render(168, 46);
    // Every row still measures exactly the grid width once escapes are dropped.
    for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(168);

    const plain = lines.map(stripAnsi);
    const header = plain.find((l) => l.includes('JAN') && l.includes('YEAR'))!;
    const yearRow = plain.find((l) => /\s20\d\d\s/.test(l) && l.includes('.'))!;
    // The YEAR total is the payoff column (§4.4): it must sit where the header
    // says it does, colour or no colour.
    expect(header.indexOf('YEAR')).toBeGreaterThan(0);
    expect(yearRow.length).toBe(header.length);
  });

  test('with no run loaded the page says what to press', () => {
    state.run = null;
    expect(screenText(makeApp(state))).toContain('press r to run');
  });

  test('a failed run shows its error rather than an empty pane', () => {
    state.run = {
      id: '#1',
      command: 'backtest',
      status: 'failed',
      progress: '',
      log: [],
      argv: [],
      startedAt: 0,
      error: 'fetch failed for BTC-PERP',
    };
    expect(screenText(makeApp(state))).toContain('fetch failed for BTC-PERP');
  });
});

describe('P2 — SWEEP and WALKFORWARD', () => {
  test('the ranked table shows axes, value and the equity sparkline', () => {
    state.page = 'sweep';
    state.flags.sweep.scripts = ['strats/mean-rev-btc.pine'];
    state.run = {
      id: '#2',
      command: 'sweep',
      status: 'ok',
      progress: '',
      report: sweepReport(),
      log: [],
      argv: [],
      startedAt: 0,
    };
    const text = screenText(makeApp(state));
    expect(text).toContain('RANKED');
    expect(text).toContain('FAST');
    expect(text).toContain('SLOW');
    expect(text).toContain('VALUE');
    expect(text).toContain('SURFACE');
  });

  test('the surface says why a cell is a dot rather than letting it read as failure', () => {
    state.page = 'sweep';
    state.flags.sweep.values['top'] = 3;
    state.run = {
      id: '#2',
      command: 'sweep',
      status: 'ok',
      progress: '',
      report: sweepReport(),
      log: [],
      argv: [],
      startedAt: 0,
    };
    expect(screenText(makeApp(state))).toContain('outside --top 3');
  });

  test('the walkforward verdict names the call and keeps EFF', () => {
    state.page = 'walkforward';
    state.run = {
      id: '#3',
      command: 'walkforward',
      status: 'ok',
      progress: '',
      report: walkforwardReport(),
      log: [],
      argv: [],
      startedAt: 0,
    };
    const text = screenText(makeApp(state));
    expect(text).toContain('WINDOWS');
    expect(text).toContain('VERDICT');
    expect(text).toContain('EFF');
    expect(text).toContain('WFE');
    expect(text).toContain('edge survives OOS');
  });

  test('a collapsing WFE reads as overfit', () => {
    state.page = 'walkforward';
    const report = walkforwardReport();
    report.aggregate!.walkForwardEfficiency = 0.12;
    state.run = {
      id: '#3',
      command: 'walkforward',
      status: 'ok',
      progress: '',
      report,
      log: [],
      argv: [],
      startedAt: 0,
    };
    expect(screenText(makeApp(state))).toContain('overfit');
  });

  test('the palette carries the sweep grid into walkforward instead of retyping it', () => {
    state.page = 'sweep';
    state.flags.sweep.scripts = ['a.pine'];
    state.flags.sweep.values['symbol'] = 'BTCUSDT';
    state.flags.sweep.values['input'] = [{ name: 'fast', value: '5,10' }];
    const app = makeApp(state);
    // This was `w` until §4.2.i left pages to their ordinals. It is an edit, not a
    // page switch, so it is asked for by name.
    openPalette(app, 'carry the sweep grid');
    expect(state.page).toBe('walkforward');
    expect(state.flags.walkforward.scripts).toEqual(['a.pine']);
    expect(state.flags.walkforward.values['input']).toEqual([{ name: 'fast', value: '5,10' }]);
  });

  test('there is nothing to carry from anywhere but SWEEP, and it says so', () => {
    state.page = 'backtest';
    const app = makeApp(state);
    openPalette(app, 'carry the sweep grid');
    expect(state.page).toBe('walkforward');
    expect(state.status).toContain('no sweep grid to carry');
    expect(state.flags.walkforward.scripts).toEqual([]);
  });
});

describe('P3 — SCAN, PORTFOLIO, COMPARE', () => {
  test('per-symbol fetch failures render without aborting the page', () => {
    state.page = 'scan';
    state.run = {
      id: '#4',
      command: 'scan',
      status: 'ok',
      progress: '',
      report: scanReport(),
      log: [],
      argv: [],
      startedAt: 0,
    };
    const text = screenText(makeApp(state));
    expect(text).toContain('UNIVERSE');
    expect(text).toContain('BTCUSDT');
    expect(text).toContain('NOT RANKED');
    expect(text).toContain('DOGEUSDT');
    expect(text).toContain('fetch');
  });

  test('portfolio shows sleeves, mode and the correlation matrix in isolated mode', () => {
    state.page = 'portfolio';
    state.run = {
      id: '#5',
      command: 'portfolio',
      status: 'ok',
      progress: '',
      report: portfolioReport(),
      log: [],
      argv: [],
      startedAt: 0,
    };
    const text = screenText(makeApp(state));
    expect(text).toContain('SLEEVES');
    expect(text).toContain('CONTRIB%');
    expect(text).toContain('SLEEVE RETURN CORRELATION');
  });

  test('shared mode says so rather than printing a column of na', () => {
    state.page = 'portfolio';
    const report = portfolioReport();
    report.mode = 'shared';
    state.run = {
      id: '#5',
      command: 'portfolio',
      status: 'ok',
      progress: '',
      report,
      log: [],
      argv: [],
      startedAt: 0,
    };
    const text = screenText(makeApp(state));
    expect(text).toContain('shared');
    expect(text).not.toContain('SLEEVE RETURN CORRELATION');
  });

  test('compare puts A and B on one grid', () => {
    state.page = 'compare';
    state.run = {
      id: '#6',
      command: 'compare',
      status: 'ok',
      progress: '',
      report: compareReport(),
      log: [],
      argv: [],
      startedAt: 0,
    };
    const text = screenText(makeApp(state));
    expect(text).toContain('A: fast-5');
    expect(text).toContain('B: fast-20');
    expect(text).toContain('Sharpe');
    expect(text).toContain('EQUITY OVERLAY');
  });
});

describe('P4 — LOGS', () => {
  beforeEach(() => {
    state.page = 'logs';
    state.run = {
      id: '#418',
      command: 'backtest',
      status: 'ok',
      progress: '',
      report: backtestReport(),
      log: [
        { level: 'info', text: 'resolve: strats/mean-rev-btc.pine', at: 1 },
        { level: 'info', text: 'fetch: BTC-PERP 1h — cache hit', at: 4 },
        { level: 'warn', text: 'warning: security request degraded', at: 9 },
        { level: 'info', text: 'fill t-1 long 0.5 @ 41000', at: 12 },
      ],
      argv: ['backtest', 'strats/mean-rev-btc.pine'],
      startedAt: 0,
    };
  });

  test('the ledger and the engine log are both on the page', () => {
    const text = screenText(makeApp(state));
    expect(text).toContain('LEDGER');
    expect(text).toContain('ENGINE LOG');
    expect(text).toContain('cache hit');
  });

  test('log levels are counted in the legend', () => {
    expect(screenText(makeApp(state))).toContain('1 warn');
  });

  test('/ filters fills and the legend says how many survive', () => {
    const app = makeApp(state);
    app.onKey({ name: '/', text: '/' });
    for (const ch of 'short') app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'enter' });
    expect(state.tradeFilter).toBe('short');
    expect(screenText(app)).toContain('/short');
  });

  test('esc clears the filter', () => {
    state.tradeFilter = 'short';
    const app = makeApp(state);
    app.onKey({ name: 'escape' });
    expect(state.tradeFilter).toBe('');
  });

  test('selecting a fill scopes the log, and esc restores it', () => {
    const app = makeApp(state);
    state.panes.logs.focus = 'ledger';
    app.onKey({ name: 'enter' });
    expect(state.logScope).toBe(0);
    expect(screenText(app)).toContain('scoped to fill');
    app.onKey({ name: 'escape' });
    expect(state.logScope).toBeNull();
  });

  test('a run with no ledger says to add --trades rather than showing nothing', () => {
    (state.run!.report as { trades?: unknown }).trades = [];
    expect(screenText(makeApp(state))).toContain('--trades');
  });
});

describe('P5 — the Ask drawer', () => {
  beforeEach(() => {
    state.run = {
      id: '#418',
      command: 'backtest',
      status: 'ok',
      progress: '',
      report: backtestReport(),
      log: [],
      argv: [],
      startedAt: 0,
    };
  });

  test('a opens the drawer over the frame, not beside it', () => {
    const app = makeApp(state);
    app.onKey({ name: 'a', text: 'a' });
    expect(state.ask.open).toBe(true);
    const lines = app.render(168, 46);
    expect(lines).toHaveLength(46);
    expect(stripAnsi(lines.join('\n'))).toContain('ASK PINETOP');
  });

  test('typing goes into the prompt, not the page keymap', () => {
    const app = makeApp(state);
    app.onKey({ name: 'a', text: 'a' });
    for (const ch of 'is this overfit') app.onKey({ name: ch, text: ch });
    expect(state.ask.input).toBe('is this overfit');
    expect(state.page).toBe('backtest');
  });

  test('a pending proposal is shown as a reviewable diff and applies only on ↵', () => {
    state.ask.open = true;
    state.ask.pending = {
      effect: 'est. Sharpe 1.42 → 1.51',
      note: 'Tighter stop.',
      edits: [{ input: 'stopAtr', from: '2.4', to: '1.8', display: '2.4 ATR → 1.8 ATR' }],
    };
    const app = makeApp(state);
    const text = screenText(app);
    expect(text).toContain('est. Sharpe 1.42 → 1.51');
    expect(text).toContain('2.4 ATR → 1.8 ATR');
    expect(text).toContain('↵ apply · ctrl-x reject');
    expect(state.overrides['strats/mean-rev-btc.pine']).toBeUndefined();

    app.onKey({ name: 'enter' });
    expect(state.ask.pending).toBeNull();
    expect(state.overrides['strats/mean-rev-btc.pine']!['stopAtr']).toEqual({
      input: 'stopAtr',
      from: '2.4',
      to: '1.8',
    });
  });

  test('ctrl-x rejects without touching config', () => {
    state.ask.open = true;
    state.ask.pending = {
      effect: '',
      note: '',
      edits: [{ input: 'stopAtr', from: '2.4', to: '1.8', display: '' }],
    };
    const app = makeApp(state);
    app.onKey({ name: 'ctrl-x' });
    expect(state.ask.pending).toBeNull();
    expect(state.overrides['strats/mean-rev-btc.pine']).toBeUndefined();
  });

  test('an applied edit raises the not-yet-re-run banner and reaches the command line', () => {
    state.overrides['strats/mean-rev-btc.pine'] = {
      stopAtr: { input: 'stopAtr', from: '2.4', to: '1.8' },
    };
    const text = screenText(makeApp(state));
    expect(text).toContain('not yet re-run');
    expect(text).toContain('stopAtr 2.4→1.8');
    expect(text).toContain('--input stopAtr=1.8');
  });

  test('an action is offered when the model declines to propose', () => {
    state.ask.open = true;
    state.ask.action = { label: 'open parameter sweep', key: 's' };
    expect(screenText(makeApp(state))).toContain('open parameter sweep');
  });

  test('with no provider the drawer says so rather than failing silently', async () => {
    const app = makeApp(state);
    await app.ask('anything');
    expect(state.ask.error).toContain('no ask provider');
  });
});

describe('the run dialog', () => {
  test('r opens it and it shows the composed line', () => {
    const app = makeApp(state);
    app.onKey({ name: 'r', text: 'r' });
    expect(state.overlay.kind).toBe('run');
    expect(screenText(app)).toContain('$ pinerun backtest');
  });

  test('a boolean toggles in place — there is nothing to type', () => {
    const app = makeApp(state);
    app.onKey({ name: 'r', text: 'r' });
    // Row 0 is the script; flags follow in schema order.
    const index = 1 + visibleFlags(state, 'backtest').findIndex((f) => f.name === 'trades');
    state.overlay.cursor = index;

    app.onKey({ name: 'enter' });
    expect(state.flags.backtest.values['trades']).toBe(true);
    expect(state.edit).toBeNull(); // never entered a text mode

    app.onKey({ name: 'enter' });
    expect(state.flags.backtest.values['trades']).toBeUndefined();
  });

  test('editing a field writes a typed value back into the model', () => {
    const app = makeApp(state);
    app.onKey({ name: 'r', text: 'r' });
    state.overlay.cursor = 1; // --symbol
    app.onKey({ name: 'enter' });
    expect(state.edit?.origin).toBe('dialog');
    expect(state.edit?.index).toBe(1);
    for (let i = 0; i < 20; i++) app.onKey({ name: 'backspace' });
    for (const ch of 'ETHUSDT') app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'enter' });
    expect(state.flags.backtest.values['symbol']).toBe('ETHUSDT');
    expect(state.edit).toBeNull();
  });

  test('editing never starts a run — only the RUN row or r does (§4.6)', () => {
    const app = makeApp(state);
    app.onKey({ name: 'r', text: 'r' });
    state.overlay.cursor = 1;
    app.onKey({ name: 'enter' });
    for (const ch of 'ETH') app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'enter' });
    expect(state.run).toBeNull();
  });

  test('it opens on the RUN row when the config already validates, so r ↵ runs', () => {
    const app = makeApp(state);
    app.onKey({ name: 'r', text: 'r' });
    expect(state.overlay.cursor).toBe(runRowCount(state, 'backtest') - 1);
    expect(isRunRow(state, 'backtest', state.overlay.cursor)).toBe(true);
    expect(screenText(app)).toContain('RUN ▸');
    expect(screenText(app)).toContain('ready to run');
  });

  test('it opens on the blocking field when something is missing', () => {
    state.flags.backtest.values['symbol'] = undefined;
    const app = makeApp(state);
    app.onKey({ name: 'r', text: 'r' });
    const symbolRow = 1 + visibleFlags(state, 'backtest').findIndex((f) => f.name === 'symbol');
    expect(state.overlay.cursor).toBe(symbolRow);
    expect(screenText(app)).toContain('--symbol is required');
    expect(screenText(app)).toContain('blocked');
  });

  test('the RUN row refuses while blocked and points back at the field', () => {
    state.flags.backtest.values['symbol'] = undefined;
    const app = makeApp(state);
    app.onKey({ name: 'r', text: 'r' });
    state.overlay.cursor = runRowCount(state, 'backtest') - 1;
    app.onKey({ name: 'enter' });
    expect(state.run).toBeNull();
    expect(state.overlay.kind).toBe('run');
    expect(state.status).toContain('--symbol is required');
  });

  test('esc while editing abandons the field, not the dialog', () => {
    const app = makeApp(state);
    app.onKey({ name: 'r', text: 'r' });
    state.overlay.cursor = 1;
    app.onKey({ name: 'enter' });
    for (const ch of 'XYZ') app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'escape' });
    expect(state.edit).toBeNull();
    expect(state.overlay.kind).toBe('run');
    expect(state.flags.backtest.values['symbol']).toBe('BTC-PERP');
  });
});

describe('flags are editable in the page itself (§10.2)', () => {
  test('↵ on a config row opens that field in place, no dialog', () => {
    const app = makeApp(state);
    state.panes.backtest.focus = 'config';
    state.panes.backtest.cursor['config'] = 1; // --symbol
    app.onKey({ name: 'enter' });
    expect(state.overlay.kind).toBe('none');
    expect(state.edit?.origin).toBe('config');
    expect(state.edit?.command).toBe('backtest');
  });

  test('the buffer is drawn in the row it belongs to', () => {
    const app = makeApp(state);
    state.panes.backtest.focus = 'config';
    state.panes.backtest.cursor['config'] = 1;
    app.onKey({ name: 'enter' });
    for (let i = 0; i < 12; i++) app.onKey({ name: 'backspace' });
    for (const ch of 'SOLUSD') app.onKey({ name: ch, text: ch });
    expect(screenText(app)).toContain('SOLUSD█');
  });

  test('↵ commits the typed value into the FlagModel and the command line', () => {
    const app = makeApp(state);
    state.panes.backtest.focus = 'config';
    state.panes.backtest.cursor['config'] = 1;
    app.onKey({ name: 'enter' });
    for (let i = 0; i < 12; i++) app.onKey({ name: 'backspace' });
    for (const ch of 'SOLUSDT') app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'enter' });
    expect(state.flags.backtest.values['symbol']).toBe('SOLUSDT');
    expect(screenText(app)).toContain('--symbol SOLUSDT');
  });

  test('keys that are keymap actions are text while a field is open', () => {
    const app = makeApp(state);
    state.panes.backtest.focus = 'config';
    state.panes.backtest.cursor['config'] = 1;
    app.onKey({ name: 'enter' });
    for (let i = 0; i < 12; i++) app.onKey({ name: 'backspace' });
    // j, k, r, a, 2 would all be actions outside a field.
    for (const ch of 'jkra2') app.onKey({ name: ch, text: ch });
    expect(state.edit?.buffer).toBe('jkra2');
    expect(state.page).toBe('backtest');
    expect(state.run).toBeNull();
    expect(state.ask.open).toBe(false);
  });

  test('esc abandons the edit and leaves the old value', () => {
    const app = makeApp(state);
    state.panes.backtest.focus = 'config';
    state.panes.backtest.cursor['config'] = 1;
    app.onKey({ name: 'enter' });
    for (const ch of 'ZZZ') app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'escape' });
    expect(state.edit).toBeNull();
    expect(state.flags.backtest.values['symbol']).toBe('BTC-PERP');
  });

  test('ctrl-u clears the field', () => {
    const app = makeApp(state);
    state.panes.backtest.focus = 'config';
    state.panes.backtest.cursor['config'] = 1;
    app.onKey({ name: 'enter' });
    app.onKey({ name: 'ctrl-u' });
    expect(state.edit?.buffer).toBe('');
  });

  test('an emptied field unsets the flag rather than composing an empty value', () => {
    const app = makeApp(state);
    state.panes.backtest.focus = 'config';
    state.panes.backtest.cursor['config'] = 1;
    app.onKey({ name: 'enter' });
    app.onKey({ name: 'ctrl-u' });
    app.onKey({ name: 'enter' });
    expect(state.flags.backtest.values['symbol']).toBeUndefined();
    // The pane still *labels* the row `--symbol`; what must not happen is the
    // flag reaching argv with an empty value.
    expect(composeArgv(state.flags.backtest)).not.toContain('--symbol');
  });

  test('a repeatable pairs flag round-trips through the text field', () => {
    const app = makeApp(state);
    state.panes.backtest.focus = 'config';
    const inputRow = 1 + visibleFlags(state, 'backtest').findIndex((f) => f.name === 'input');
    state.panes.backtest.cursor['config'] = inputRow;
    app.onKey({ name: 'enter' });
    for (const ch of 'fast=5 slow=30') app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'enter' });
    expect(state.flags.backtest.values['input']).toEqual([
      { name: 'fast', value: '5' },
      { name: 'slow', value: '30' },
    ]);
    expect(screenText(app)).toContain('--input fast=5 --input slow=30');
  });

  test('a number field refuses non-numeric text and says so', () => {
    const app = makeApp(state);
    state.panes.backtest.focus = 'config';
    const limitRow = 1 + visibleFlags(state, 'backtest').findIndex((f) => f.name === 'limit');
    state.panes.backtest.cursor['config'] = limitRow;
    app.onKey({ name: 'enter' });
    for (const ch of 'abc') app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'enter' });
    expect(state.flags.backtest.values['limit']).toBeUndefined();
    expect(state.status).toContain('needs a number');
  });

  test('editing in the pane never starts a run (§4.6)', () => {
    const app = makeApp(state);
    state.panes.backtest.focus = 'config';
    state.panes.backtest.cursor['config'] = 1;
    app.onKey({ name: 'enter' });
    for (const ch of 'ETHUSDT') app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'enter' });
    expect(state.run).toBeNull();
  });

  test('the focused config pane advertises the in-place edit', () => {
    const app = makeApp(state);
    state.panes.backtest.focus = 'config';
    expect(screenText(app)).toContain('↵ edit');
  });
});

describe('every flag is reachable from the UI, not just the common ones', () => {
  test('advanced flags are hidden by default but the pane says how many', () => {
    const app = makeApp(state);
    const hidden = hiddenFlagCount(state, 'backtest');
    expect(hidden).toBeGreaterThan(0);
    // On a narrow config pane the legend is dropped title-first (§4.4), so the
    // count has to be on the action row to be visible at all.
    expect(screenText(app)).toContain(`. +${hidden}`);
  });

  test('once revealed, the pane offers the way back', () => {
    const app = makeApp(state);
    app.onKey({ name: '.', text: '.' });
    expect(screenText(app)).toContain('. fewer');
  });

  test('. reveals them, and they become editable rows', () => {
    const app = makeApp(state);
    const before = visibleFlags(state, 'backtest').length;
    app.onKey({ name: '.', text: '.' });
    expect(state.showAdvanced).toBe(true);
    expect(visibleFlags(state, 'backtest').length).toBeGreaterThan(before);
    expect(hiddenFlagCount(state, 'backtest')).toBe(0);
    expect(visibleFlags(state, 'backtest').map((f) => f.name)).toContain('data-dir');
  });

  test('. toggles back', () => {
    const app = makeApp(state);
    app.onKey({ name: '.', text: '.' });
    app.onKey({ name: '.', text: '.' });
    expect(state.showAdvanced).toBe(false);
  });

  test('an advanced flag can be set in place once revealed — no shell needed', () => {
    const app = makeApp(state);
    app.onKey({ name: '.', text: '.' });
    state.panes.backtest.focus = 'config';
    const row = 1 + visibleFlags(state, 'backtest').findIndex((f) => f.name === 'data-dir');
    state.panes.backtest.cursor['config'] = row;
    app.onKey({ name: 'enter' });
    for (const ch of 'examples/data') app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'enter' });
    expect(state.flags.backtest.values['data-dir']).toBe('examples/data');
    expect(composeArgv(state.flags.backtest)).toContain('--data-dir');
  });

  test('an advanced flag that is already set shows without the toggle', () => {
    state.flags.backtest.values['mintick'] = 0.01;
    expect(visibleFlags(state, 'backtest').map((f) => f.name)).toContain('mintick');
  });

  test('the palette offers it too, for anyone who does not know the key', () => {
    const app = makeApp(state);
    app.onKey({ name: ':', text: ':' });
    for (const ch of 'all flags') app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'enter' });
    expect(state.showAdvanced).toBe(true);
  });

  test('the generated help documents the key', () => {
    const app = makeApp(state);
    app.onKey({ name: '?', text: '?' });
    expect(screenText(app)).toContain('advanced flags');
  });

  test('choosing --provider csv reveals --data-dir without the toggle', () => {
    const app = makeApp(state);
    expect(visibleFlags(state, 'backtest').map((f) => f.name)).not.toContain('data-dir');
    expect(screenText(app)).not.toContain('--data-dir');

    state.flags.backtest.values['provider'] = 'csv';
    expect(visibleFlags(state, 'backtest').map((f) => f.name)).toContain('data-dir');
    expect(screenText(app)).toContain('--data-dir');
  });

  test('the other csv assertion flags come with it', () => {
    state.flags.backtest.values['provider'] = 'csv';
    const names = visibleFlags(state, 'backtest').map((f) => f.name);
    for (const flag of [
      'csv-alignment',
      'csv-week-anchor',
      'csv-calendar',
      'csv-complete-record',
    ]) {
      expect(names).toContain(flag);
    }
  });

  test('a different provider reveals its own flag, not the csv ones', () => {
    state.flags.backtest.values['provider'] = 'alpaca';
    const names = visibleFlags(state, 'backtest').map((f) => f.name);
    expect(names).toContain('feed');
    expect(names).not.toContain('data-dir');
  });

  test('csv without a directory is refused before the spawn, naming the flag', () => {
    state.flags.backtest.values['provider'] = 'csv';
    const app = makeApp(state);
    app.onKey({ name: 'r', text: 'r' });
    expect(screenText(app)).toContain('--provider csv needs --data-dir');
    // …and the cursor lands on the row that fixes it.
    const row = 1 + visibleFlags(state, 'backtest').findIndex((f) => f.name === 'data-dir');
    expect(state.overlay.cursor).toBe(row);
  });

  test('csv with a directory validates and composes both flags', () => {
    state.flags.backtest.values['provider'] = 'csv';
    state.flags.backtest.values['data-dir'] = 'examples/data';
    const app = makeApp(state);
    app.onKey({ name: 'r', text: 'r' });
    expect(screenText(app)).toContain('ready to run');
    const argv = composeArgv(state.flags.backtest);
    expect(argv).toContain('--provider');
    expect(argv).toContain('csv');
    expect(argv).toContain('--data-dir');
    expect(argv).toContain('examples/data');
  });

  test('the pane and the dialog agree on row numbering when toggled', () => {
    const app = makeApp(state);
    app.onKey({ name: '.', text: '.' });
    // The dialog indexes through the same visibleFlags, so the RUN row lands
    // after every revealed flag rather than in the middle of them.
    app.onKey({ name: 'r', text: 'r' });
    expect(state.overlay.cursor).toBe(runRowCount(state, 'backtest') - 1);
    expect(isRunRow(state, 'backtest', state.overlay.cursor)).toBe(true);
  });
});

describe('the command palette', () => {
  test(': opens it and ↵ runs the selected item', () => {
    const app = makeApp(state);
    app.onKey({ name: ':', text: ':' });
    expect(state.overlay.kind).toBe('palette');
    for (const ch of 'go sweep') app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'enter' });
    expect(state.page).toBe('sweep');
  });

  test('ctrl-p opens it too, since a terminal cannot see ⌘K', () => {
    const app = makeApp(state);
    app.onKey({ name: 'ctrl-p' });
    expect(state.overlay.kind).toBe('palette');
  });

  test('revert drops pending edits', () => {
    state.overrides['strats/mean-rev-btc.pine'] = {
      stopAtr: { input: 'stopAtr', from: '2.4', to: '1.8' },
    };
    const app = makeApp(state);
    app.onKey({ name: ':', text: ':' });
    for (const ch of 'revert') app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'enter' });
    expect(state.overrides['strats/mean-rev-btc.pine']).toBeUndefined();
  });
});

describe('workflow hand-offs (§3 G3)', () => {
  test('↵ on a swept combo loads it into BACKTEST as fixed inputs', () => {
    state.page = 'sweep';
    state.flags.sweep.scripts = ['strats/mean-rev-btc.pine'];
    state.panes.sweep.focus = 'ranked';
    state.run = {
      id: '#2',
      command: 'sweep',
      status: 'ok',
      progress: '',
      report: sweepReport(),
      log: [],
      argv: [],
      startedAt: 0,
    };
    const app = makeApp(state);
    app.onKey({ name: 'enter' });
    expect(state.page).toBe('backtest');
    expect(state.flags.backtest.values['input']).toEqual([
      { name: 'fast', value: '10' },
      { name: 'slow', value: '50' },
    ]);
  });

  test('↵ on a walkforward window loads its winner and the OOS span', () => {
    state.page = 'walkforward';
    state.flags.walkforward.scripts = ['a.pine'];
    state.panes.walkforward.focus = 'windows';
    state.run = {
      id: '#3',
      command: 'walkforward',
      status: 'ok',
      progress: '',
      report: walkforwardReport(),
      log: [],
      argv: [],
      startedAt: 0,
    };
    const app = makeApp(state);
    app.onKey({ name: 'enter' });
    expect(state.page).toBe('backtest');
    expect(state.flags.backtest.values['input']).toEqual([{ name: 'fast', value: '10' }]);
    expect(state.flags.backtest.values['from']).toBe('2023-01-01');
  });

  test('↵ on a scanned symbol deep-dives it', () => {
    state.page = 'scan';
    state.flags.scan.scripts = ['a.pine'];
    state.panes.scan.focus = 'universe';
    state.run = {
      id: '#4',
      command: 'scan',
      status: 'ok',
      progress: '',
      report: scanReport(),
      log: [],
      argv: [],
      startedAt: 0,
    };
    const app = makeApp(state);
    app.onKey({ name: 'enter' });
    expect(state.page).toBe('backtest');
    expect(state.flags.backtest.values['symbol']).toBe('BTCUSDT');
  });
});

describe('the STRATEGIES pane, on every command page', () => {
  const list = cachedScripts();

  test('discovery found the project’s examples, so the rest of this block means something', () => {
    expect(list.length).toBeGreaterThan(2);
  });

  test('every command page draws it, and TRADES — which has no command — does not', () => {
    for (const command of COMMANDS) {
      state.page = command;
      expect(screenText(makeApp(state)), command).toContain('STRATEGIES');
    }
    state.page = 'logs';
    expect(screenText(makeApp(state))).not.toContain('STRATEGIES');
  });

  test('it is first in the focus ring, and each page opens on it', () => {
    for (const command of COMMANDS) {
      state.page = command;
      expect(makeApp(state).page.panes(state)[0], command).toBe('strategies');
      expect(state.panes[command].focus, command).toBe('strategies');
    }
  });

  test('↵ loads the selection as that command’s own script argument', () => {
    for (const command of COMMANDS) {
      state.page = command;
      state.flags[command].scripts = [];
      state.panes[command].focus = 'strategies';
      state.panes[command].cursor['strategies'] = 1;
      makeApp(state).onKey({ name: 'enter' });
      // Not BACKTEST's — the point of the change is that each page loads its own.
      expect(state.flags[command].scripts[0], command).toBe(list[1]!.path);
    }
  });

  test('compare fills A, then B, then keeps replacing A', () => {
    state.page = 'compare';
    state.flags.compare.scripts = [];
    state.panes.compare.focus = 'strategies';
    const app = makeApp(state);

    state.panes.compare.cursor['strategies'] = 0;
    app.onKey({ name: 'enter' });
    expect(state.flags.compare.scripts).toEqual([list[0]!.path]);

    state.panes.compare.cursor['strategies'] = 1;
    app.onKey({ name: 'enter' });
    expect(state.flags.compare.scripts).toEqual([list[0]!.path, list[1]!.path]);

    state.panes.compare.cursor['strategies'] = 2;
    app.onKey({ name: 'enter' });
    expect(state.flags.compare.scripts).toEqual([list[2]!.path, list[1]!.path]);
  });

  test('compare marks the two slots A and B rather than with one bar', () => {
    state.page = 'compare';
    state.flags.compare.scripts = [list[0]!.path, list[1]!.path];
    const text = screenText(makeApp(state));
    expect(text).toContain(`A${list[0]!.label}`);
    expect(text).toContain(`B${list[1]!.label}`);
  });

  test('the loaded script keeps its marker when the cursor is elsewhere', () => {
    state.page = 'sweep';
    state.flags.sweep.scripts = [list[0]!.path];
    state.panes.sweep.cursor['strategies'] = 2;
    expect(screenText(makeApp(state))).toContain(`▌${list[0]!.label}`);
  });
});

describe('choosing axes from the script’s own inputs', () => {
  const script = 'examples/rsi-mean-reversion.pine';
  // Both pages take `--input` in the `axes` group, and `validate` applies the same
  // "at least one axis" rule and the same --max-combos cap to both. One pane, so
  // one test — a page that grew its own copy would show up here as a failure.
  const AXIS_PAGES = ['sweep', 'walkforward'] as const;

  const axes = (command: (typeof AXIS_PAGES)[number]): Pair[] =>
    (state.flags[command].values['input'] as Pair[] | undefined) ?? [];

  function focusInputs(command: (typeof AXIS_PAGES)[number]): void {
    refreshScripts();
    state.page = command;
    state.flags[command].scripts = [script];
    state.flags[command].values['input'] = undefined;
    state.panes[command].focus = 'inputs';
    state.panes[command].cursor['inputs'] = 0;
  }

  /** Open the row under the cursor, type a grid, accept. */
  function setGrid(app: App, grid: string): void {
    app.onKey({ name: 'enter' });
    for (const ch of grid) app.onKey({ name: ch, text: ch });
    app.onKey({ name: 'enter' });
  }

  test('both pages list every input the script declares, before any are swept', () => {
    for (const command of AXIS_PAGES) {
      focusInputs(command);
      const text = screenText(makeApp(state));
      expect(text, command).toContain('INPUTS');
      for (const title of ['length', 'oversold', 'overbought']) {
        expect(text, `${command}/${title}`).toContain(title);
      }
    }
  });

  test('a second axis does not disturb the first — the point of per-row editing', () => {
    for (const command of AXIS_PAGES) {
      focusInputs(command);
      const app = makeApp(state);
      setGrid(app, '7,14,21');
      expect(axes(command), command).toEqual([{ name: 'length', value: '7,14,21' }]);

      state.panes[command].cursor['inputs'] = 1;
      setGrid(app, '20:35:5');
      expect(axes(command), command).toEqual([
        { name: 'length', value: '7,14,21' },
        { name: 'oversold', value: '20:35:5' },
      ]);

      // And the composed line carries both, repeated as the CLI expects.
      const argv = composeArgv(state.flags[command]);
      expect(
        argv.filter((a) => a === '--input'),
        command,
      ).toHaveLength(2);
      expect(argv.join(' '), command).toContain('--input length=7,14,21 --input oversold=20:35:5');
    }
  });

  test('editing a swept input prefills its grid, and clearing it drops that axis', () => {
    for (const command of AXIS_PAGES) {
      focusInputs(command);
      const app = makeApp(state);
      setGrid(app, '7,14');
      state.panes[command].cursor['inputs'] = 1;
      setGrid(app, '20,30');
      expect(axes(command), command).toHaveLength(2);

      // Re-open the first row: the buffer starts from what is already set.
      state.panes[command].cursor['inputs'] = 0;
      app.onKey({ name: 'enter' });
      expect(state.edit?.buffer, command).toBe('7,14');
      app.onKey({ name: 'ctrl-u' });
      app.onKey({ name: 'enter' });

      expect(axes(command), command).toEqual([{ name: 'oversold', value: '20,30' }]);
    }
  });

  test('swept inputs are marked and carry their grid; the rest stay plain', () => {
    focusInputs('sweep');
    setGrid(makeApp(state), '7,14,21');
    const text = screenText(makeApp(state));
    expect(text).toContain('▌length');
    expect(text).toMatch(/▌length[^\n]*7,14,21/);
    expect(text).not.toContain('▌overbought');
  });

  test('the legend counts the axes and the grid they make', () => {
    focusInputs('walkforward');
    const app = makeApp(state);
    setGrid(app, '7,14,21');
    state.panes.walkforward.cursor['inputs'] = 1;
    setGrid(app, '20,25,30,35');
    expect(screenText(makeApp(state))).toContain('2 axes · 12 combos');
  });

  test('an axis the script does not declare is still shown, so the reason is visible', () => {
    focusInputs('sweep');
    state.flags.sweep.values['input'] = [{ name: 'notAnInput', value: '1,2' }];
    expect(screenText(makeApp(state))).toContain('notAnInput');
  });

  test('with no script loaded the pane says what to do rather than sitting empty', () => {
    for (const command of AXIS_PAGES) {
      focusInputs(command);
      state.flags[command].scripts = [];
      expect(screenText(makeApp(state)), command).toContain('load a strategy above');
    }
  });
});

describe('a run that exits non-zero', () => {
  function fail(overrides: Partial<RunState> = {}): void {
    state.run = {
      id: '#401',
      command: 'backtest',
      status: 'failed',
      progress: '',
      log: [
        { level: 'info', text: 'resolving NOPE-PERP @ 1h', at: 4 },
        { level: 'error', text: 'binance: no such symbol NOPE-PERP', at: 120 },
        { level: 'error', text: '  set --provider, or check the ticker', at: 121 },
      ],
      argv: ['backtest', 'x.pine'],
      startedAt: 0,
      elapsedMs: 812,
      exitCode: 2,
      error: 'binance: no such symbol NOPE-PERP',
      ...overrides,
    };
  }

  test('the drawer appears on its own, with the exit code and every error line', () => {
    fail();
    const text = screenText(makeApp(state));
    expect(text).toContain('BACKTEST FAILED');
    expect(text).toContain('exit 2');
    // Not just the last line, which is all the status strip ever carried.
    expect(text).toContain('binance: no such symbol NOPE-PERP');
    expect(text).toContain('set --provider, or check the ticker');
    // Engine narration is not an error and belongs on TRADES, not here.
    expect(text).not.toContain('resolving NOPE-PERP');
  });

  test('it displaces the page instead of covering it', () => {
    fail();
    const clean = screenText(makeApp(state), 168, 46);
    state.run!.errorDismissed = true;
    const dismissed = screenText(makeApp(state), 168, 46);
    // The monthly strip is the bottom-most pane; it survives, just higher up.
    expect(clean).toContain('MONTHLY RETURNS');
    expect(dismissed).toContain('MONTHLY RETURNS');
    expect(clean).not.toBe(dismissed);
  });

  test('esc dismisses it, and the palette brings it back', () => {
    fail();
    const app = makeApp(state);
    app.onKey({ name: 'escape' });
    expect(state.run!.errorDismissed).toBe(true);
    expect(screenText(makeApp(state))).not.toContain('BACKTEST FAILED');

    const item = paletteItems().find((i) => i.label === 'show the last error')!;
    item.run(state);
    expect(screenText(makeApp(state))).toContain('BACKTEST FAILED');
  });

  test('a dismissal does not carry to the next failure', () => {
    fail({ errorDismissed: true });
    expect(screenText(makeApp(state))).not.toContain('BACKTEST FAILED');
    // A fresh run is a fresh RunState, so the flag cannot be inherited.
    fail();
    expect(screenText(makeApp(state))).toContain('BACKTEST FAILED');
  });

  test('a process that never started says so rather than claiming an exit code', () => {
    fail({ exitCode: null, log: [], error: 'could not spawn pinerun: ENOENT' });
    const text = screenText(makeApp(state));
    expect(text).toContain('did not start');
    expect(text).toContain('could not spawn pinerun');
  });

  test('a successful run draws no drawer at all', () => {
    state.run = {
      id: '#402',
      command: 'backtest',
      status: 'ok',
      progress: '',
      log: [],
      argv: [],
      startedAt: 0,
      exitCode: 0,
      report: backtestReport(),
    };
    expect(screenText(makeApp(state))).not.toContain('FAILED');
  });
});

describe('a run that succeeded but not for every symbol', () => {
  function partial(report: unknown): void {
    state.page = 'scan';
    state.run = {
      id: '#403',
      command: 'scan',
      status: 'ok',
      progress: '',
      log: [],
      argv: ['scan', 'x.pine'],
      startedAt: 0,
      elapsedMs: 4210,
      exitCode: 0,
      report,
    };
  }

  const withFailures = (): unknown => ({
    ranked: [{ symbol: 'BTCUSDT', value: 1200 }],
    fetchErrors: [
      { symbol: 'LUNAUSDT', error: 'binance: symbol delisted' },
      { symbol: 'FTTUSDT', error: 'binance: no klines in range' },
    ],
    errors: [{ symbol: 'DOGEUSDT', error: 'runtime: division by zero' }],
  });

  test('fetch failures and per-symbol errors both reach the drawer', () => {
    partial(withFailures());
    const text = screenText(makeApp(state));
    expect(text).toContain('SCAN — INCOMPLETE');
    expect(text).toContain('LUNAUSDT: binance: symbol delisted');
    expect(text).toContain('FTTUSDT: binance: no klines in range');
    expect(text).toContain('DOGEUSDT: runtime: division by zero');
    expect(text).toContain('3 produced no result');
  });

  test('it says the numbers exclude them, which the per-page list does not', () => {
    partial(withFailures());
    expect(screenText(makeApp(state))).toContain('the numbers on this page exclude these');
  });

  test('it is a warning, not a failure — exit 0 is not an error', () => {
    partial(withFailures());
    expect(screenText(makeApp(state))).not.toContain('FAILED');
    const raw = makeApp(state).render(168, 46).join('\n');
    expect(raw).toContain('\x1b[33m'); // warn, not the error red
  });

  test('a clean run draws nothing, and neither do reports without the fields', () => {
    partial({ ranked: [{ symbol: 'BTCUSDT', value: 1200 }] });
    expect(screenText(makeApp(state))).not.toContain('INCOMPLETE');

    partial({ ranked: [], fetchErrors: [], errors: [] });
    expect(screenText(makeApp(state))).not.toContain('INCOMPLETE');

    // backtest reports carry neither field; reading them must not throw.
    state.page = 'backtest';
    state.run!.command = 'backtest';
    state.run!.report = backtestReport();
    expect(() => screenText(makeApp(state))).not.toThrow();
    expect(screenText(makeApp(state))).not.toContain('INCOMPLETE');
  });

  test('esc dismisses it, and the palette says so when there is nothing to reopen', () => {
    partial(withFailures());
    makeApp(state).onKey({ name: 'escape' });
    expect(screenText(makeApp(state))).not.toContain('INCOMPLETE');

    const item = paletteItems().find((i) => i.label === 'show the last error')!;
    expect(item.run(state)).toBeUndefined();
    expect(screenText(makeApp(state))).toContain('INCOMPLETE');

    partial({ ranked: [] });
    expect(item.run(state)).toContain('no errors');
  });
});

describe('run history, per page', () => {
  let counter: number;

  function run(command: CommandId, symbol: string, over: Partial<RunState> = {}): RunState {
    const flags = cloneModel(state.flags[command]);
    flags.values['symbol'] = symbol;
    flags.values['tf'] = '1h';
    return {
      id: `#${++counter}`,
      command,
      status: 'ok',
      progress: '',
      log: [],
      argv: [],
      startedAt: 0,
      elapsedMs: 2100,
      exitCode: 0,
      flags,
      report: { ranked: [], sleeves: [], windows: [] },
      ...over,
    };
  }

  beforeEach(() => {
    counter = 400;
    state.flags.backtest.scripts = ['examples/rsi.pine'];
  });

  test('every command page has the pane; the two view pages do not', () => {
    state.history = [run('backtest', 'BTCUSDT')];
    for (const command of COMMANDS) {
      state.page = command;
      expect(screenText(makeApp(state)), command).toContain('HISTORY');
    }
    for (const page of ['logs', 'editor'] as const) {
      state.page = page;
      expect(screenText(makeApp(state)), page).not.toContain('HISTORY');
    }
  });

  test('it lists this page’s runs, newest first, and nobody else’s', () => {
    state.history = [
      run('backtest', 'BTCUSDT'),
      run('sweep', 'ETHUSDT'),
      run('backtest', 'SOLUSDT'),
    ];
    state.page = 'backtest';
    const text = screenText(makeApp(state));
    expect(text).toContain('#403 SOLUSDT');
    expect(text).toContain('#401 BTCUSDT');
    // The sweep run belongs to the sweep page.
    expect(text).not.toContain('ETHUSDT');
    expect(text.indexOf('#403 SOLUSDT')).toBeLessThan(text.indexOf('#401 BTCUSDT'));
  });

  test('↵ restores the run and the config that produced it, so the line agrees', () => {
    state.page = 'backtest';
    state.flags.backtest.values['symbol'] = 'BTCUSDT';
    state.history = [run('backtest', 'BTCUSDT'), run('backtest', 'ETHUSDT')];
    state.run = state.history[1]!;
    state.flags.backtest.values['symbol'] = 'ETHUSDT';

    state.panes.backtest.focus = 'history';
    state.panes.backtest.cursor['history'] = 1; // newest first, so [1] is the older
    makeApp(state).onKey({ name: 'enter' });

    expect(state.run!.id).toBe('#401');
    expect(state.flags.backtest.values['symbol']).toBe('BTCUSDT');
    // §4.1.b — the line on screen is the one that produced what is on screen.
    expect(screenText(makeApp(state))).toContain('--symbol BTCUSDT');
  });

  test('loading drops pending overrides, which the snapshot already carries', () => {
    state.page = 'backtest';
    state.history = [run('backtest', 'BTCUSDT')];
    state.overrides['examples/rsi.pine'] = {
      stopAtr: { input: 'stopAtr', from: '2.4', to: '1.8' },
    };
    state.panes.backtest.focus = 'history';
    makeApp(state).onKey({ name: 'enter' });
    expect(state.overrides['examples/rsi.pine']).toBeUndefined();
  });

  test('the loaded run keeps its marker wherever the cursor is', () => {
    state.page = 'backtest';
    state.history = [run('backtest', 'BTCUSDT'), run('backtest', 'ETHUSDT')];
    state.run = state.history[0]!;
    state.panes.backtest.cursor['history'] = 0; // sitting on the newer one
    expect(screenText(makeApp(state))).toContain('▌#401 BTCUSDT');
  });

  test('history is capped per command, oldest evicted', () => {
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) state.history.push(run('backtest', `S${i}`));
    state.history.push(run('sweep', 'ETHUSDT'));
    evictHistory(state, 'backtest');

    const backtests = state.history.filter((r) => r.command === 'backtest');
    expect(backtests).toHaveLength(HISTORY_LIMIT);
    // The oldest went, the newest stayed, and another command's run is untouched.
    expect(backtests[0]!.flags!.values['symbol']).toBe('S5');
    expect(state.history.some((r) => r.command === 'sweep')).toBe(true);
  });

  test('an empty history says how to make one', () => {
    state.page = 'backtest';
    expect(screenText(makeApp(state))).toContain('no runs yet');
  });
});

describe('pane accelerators (§4.2.h)', () => {
  test('the first letter of each pane, when nothing else wants it', () => {
    const keys = paneAccelerators(['files', 'inputs', 'verdict'], new Set());
    expect([...keys]).toEqual([
      ['files', 'f'],
      ['inputs', 'i'],
      ['verdict', 'v'],
    ]);
  });

  test('two panes with the same initial take two letters — and three if they must', () => {
    expect([...paneAccelerators(['config', 'charts'], new Set())]).toEqual([
      ['config', 'co'],
      ['charts', 'ch'],
    ]);
    // Each pane grows only as far as it has to: `ideas` is told apart at two
    // letters and stops there, while the other two need a third.
    expect([...paneAccelerators(['inputs', 'index', 'ideas'], new Set())]).toEqual([
      ['inputs', 'inp'],
      ['index', 'ind'],
      ['ideas', 'id'],
    ]);
  });

  test('a letter the app has claimed is taken shifted, never taken away', () => {
    const keys = paneAccelerators(['ranked', 'editor', 'history']);
    // `r` runs and `e` hands off to $EDITOR; `h` is nobody's binding.
    expect(keys.get('ranked')).toBe('R');
    expect(keys.get('editor')).toBe('E');
    expect(keys.get('history')).toBe('h');
  });

  test('a shifted sequence shifts whole, so it is typed with shift held once', () => {
    const keys = paneAccelerators(['ranked', 'runs', 'config']);
    expect([...keys.values()]).toEqual(['RA', 'RU', 'c']);
  });

  test('no letter switches page, so the pane keys are the plain ones (§4.2.i)', () => {
    const keys = paneAccelerators(['strategies', 'windows', 'sleeves', 'summary']);
    // `s` and `w` were the sweep and walkforward pages until §4.2.i dropped them.
    expect(keys.get('windows')).toBe('w');
    expect([...keys.values()]).toEqual(['st', 'w', 'sl', 'su']);
  });

  test('a pane goes without a key rather than taking one the app needs', () => {
    // `g` is "first row" and `G` is "last row": both cases are spoken for.
    const keys = paneAccelerators(['grid', 'inputs']);
    expect(keys.has('grid')).toBe(false);
    expect(keys.get('inputs')).toBe('i');
  });

  test('two panes are never given the same key, nor one that shadows another', () => {
    // `log` is a prefix of `logbook`, so typing it can only ever mean the shorter.
    const keys = paneAccelerators(['log', 'logbook'], new Set());
    expect(keys.get('log')).toBe('log');
    expect(keys.has('logbook')).toBe(false);
  });

  test('every real page: keys are unique, prefix-free, and clear of the keymap', () => {
    for (const page of PAGES) {
      state.page = page;
      const keys = [...paneAccelerators(PAGE_MAP[page].panes(state)).values()];
      expect(new Set(keys).size, page).toBe(keys.length);
      for (const key of keys) {
        expect(RESERVED_KEYS.has(key[0]!), `${page}: ${key} shadows a binding`).toBe(false);
        expect(
          keys.filter((other) => other !== key && key.startsWith(other)),
          page,
        ).toEqual([]);
      }
    }
  });

  test('every pane in every page’s ring is reachable by a key', () => {
    // Nothing today needs `g`, so nothing today should be losing its accelerator.
    for (const page of PAGES) {
      state.page = page;
      const panes = PAGE_MAP[page].panes(state);
      expect([...paneAccelerators(panes).keys()], page).toEqual([...panes]);
    }
  });

  test('one keystroke focuses a pane, and the ring is not walked to get there', () => {
    const app = makeApp(state);
    app.onKey({ name: 'h', text: 'h' });
    expect(state.panes.backtest.focus).toBe('history');
    // `s`, now that no letter switches page (§4.2.i).
    app.onKey({ name: 's', text: 's' });
    expect(state.panes.backtest.focus).toBe('strategies');
    expect(state.page).toBe('backtest');
  });

  test('a two-letter key waits for its second letter, and says what it is waiting for', () => {
    const app = makeApp(state);
    app.onKey({ name: 'c', text: 'c' });
    expect(state.panes.backtest.focus).toBe('strategies'); // nothing moved yet
    expect(state.status).toContain('co config');
    expect(state.status).toContain('ch charts');
    app.onKey({ name: 'h', text: 'h' });
    expect(state.panes.backtest.focus).toBe('charts');
  });

  test('the second letter does not need shift held down for it', () => {
    // SWEEP's ranked pane is `R`, because `r` is the run dialog; a two-letter
    // shifted key would be typed with shift down throughout, and need not be.
    const keys = paneAccelerators(['ranked', 'runs']);
    expect([...keys.values()]).toEqual(['RA', 'RU']);
    expect(matchSequence('RA', 'Ra')).toBe('exact');
    expect(matchSequence('RA', 'RA')).toBe('exact');
    // The first keystroke is the one that must match case: that is what keeps `r`
    // the run dialog rather than a half-typed pane jump.
    expect(matchSequence('RA', 'ra')).toBe('none');
  });

  test('esc abandons a half-typed key', () => {
    const app = makeApp(state);
    app.onKey({ name: 'c', text: 'c' });
    app.onKey({ name: 'escape' });
    expect(state.status).toBe('pane jump cancelled');
    // `h` is HISTORY again, not the `ch` it would have completed.
    app.onKey({ name: 'h', text: 'h' });
    expect(state.panes.backtest.focus).toBe('history');
  });

  test('a letter that cannot continue one sequence starts a new one', () => {
    const app = makeApp(state);
    app.onKey({ name: 'c', text: 'c' });
    app.onKey({ name: 'm', text: 'm' });
    expect(state.status).toContain('pane m…');
    app.onKey({ name: 'o', text: 'o' });
    expect(state.panes.backtest.focus).toBe('monthly');
  });

  test('the keys the app kept still do what they always did', () => {
    state.page = 'sweep';
    const app = makeApp(state);
    // `r` is the run dialog, not SWEEP's RANKED pane, on a page that has both.
    app.onKey({ name: 'r', text: 'r' });
    expect(state.overlay.kind).toBe('run');
    app.onKey({ name: 'escape' });
    // RANKED took the shifted form instead, and reaches the pane.
    app.onKey({ name: 'R', text: 'R' });
    expect(state.overlay.kind).toBe('none');
    expect(state.panes.sweep.focus).toBe('ranked');
  });

  test('the key is on the pane, and not on the pane you are already in', () => {
    state.page = 'backtest';
    const text = screenText(makeApp(state));
    expect(text).toContain('HISTORY [h]');
    expect(text).toContain('CHARTS [ch]');
    expect(text).toContain('TEARSHEET [me]');
    // STRATEGIES has focus, so its four columns go to its own legend instead.
    expect(text).toContain('◆ STRATEGIES ');
    expect(text).not.toContain('◆ STRATEGIES [s]');
  });

  test('a half-typed key lights up the panes it could still reach', () => {
    state.page = 'portfolio';
    const app = makeApp(state);
    app.onKey({ name: 's', text: 's' });
    const text = screenText(app);
    // Including the focused one, which is a candidate like any other.
    expect(text).toContain('◆ STRATEGIES [st]');
    expect(text).toContain('SLEEVES [sl]');
  });

  test('? lists this page’s keys, generated from the ones the app resolved', () => {
    state.page = 'logs';
    const app = makeApp(state);
    app.onKey({ name: '?', text: '?' });
    const text = screenText(app);
    expect(text).toContain('PANES');
    expect(text).toContain('le ledger');
    expect(text).toContain('lo log');
  });

  test('the EDITOR buffer keeps every letter, and stops advertising pane keys', () => {
    state.page = 'editor';
    state.panes.editor.focus = 'editor';
    const app = makeApp(state);
    const text = screenText(app);
    expect(text).not.toContain('[f]');
    expect(text).not.toContain('[i]');

    app.onKey({ name: 'f', text: 'f' });
    expect(state.panes.editor.focus).toBe('editor');
  });

  test('outside the buffer, the EDITOR page has keys like any other page', () => {
    state.page = 'editor';
    state.panes.editor.focus = 'files';
    const app = makeApp(state);
    expect(screenText(app)).toContain('[i]');
    app.onKey({ name: 'E', text: 'E' });
    expect(state.panes.editor.focus).toBe('editor');
  });
});
