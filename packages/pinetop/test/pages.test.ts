import { describe, expect, test, beforeEach } from 'bun:test';
import { App } from '../src/app.js';
import { PAGES, type PageId } from '../src/flags/schema.js';
import { hiddenFlagCount, isRunRow, runRowCount, visibleFlags } from '../src/pages/config-pane.js';
import { composeArgv } from '../src/flags/model.js';
import { stripAnsi } from '../src/render/screen.js';
import { initialState, resetRunIds, type AppState } from '../src/state.js';
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
    expect(text).toContain('8 TRADES');
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

  test('w carries the sweep grid into walkforward instead of retyping it', () => {
    state.page = 'sweep';
    state.flags.sweep.scripts = ['a.pine'];
    state.flags.sweep.values['symbol'] = 'BTCUSDT';
    state.flags.sweep.values['input'] = [{ name: 'fast', value: '5,10' }];
    const app = makeApp(state);
    app.onKey({ name: 'w', text: 'w' });
    expect(state.page).toBe('walkforward');
    expect(state.flags.walkforward.scripts).toEqual(['a.pine']);
    expect(state.flags.walkforward.values['input']).toEqual([{ name: 'fast', value: '5,10' }]);
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

describe('P4 — TRADES', () => {
  beforeEach(() => {
    state.page = 'trades';
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
    state.panes.trades.focus = 'ledger';
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
