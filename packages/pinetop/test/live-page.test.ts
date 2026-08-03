import { beforeEach, describe, expect, test } from 'bun:test';
import { App } from '../src/app.js';
import { COMMANDS, PAGES } from '../src/flags/schema.js';
import { reconcileLiveSelection, selectLiveCursor, selectedLiveItem } from '../src/pages/live.js';
import { stripAnsi } from '../src/render/screen.js';
import {
  LiveStatusPoller,
  type LiveStatusPollEvent,
  type LiveStatusPollerLike,
  type PineliveStatusListV1,
} from '../src/run/live-status.js';
import { initialState, type AppState } from '../src/state.js';
import type { Key, Terminal, TerminalSize } from '../src/terminal.js';
import {
  ACTIVE_INSTANCE,
  OTHER_INSTANCE,
  TERMINAL_INSTANCE,
  activeRun,
  errorItem,
  liveSnapshot,
  terminalRun,
} from './fixtures/live-status.js';

function stubTerminal(cols = 168, rows = 46, onClose?: () => void): Terminal {
  return {
    size: { cols, rows } as TerminalSize,
    isTTY: true,
    open() {},
    close() {
      onClose?.();
    },
    paint() {},
    onKey(_handler: (key: Key) => void) {
      return () => undefined;
    },
    onResizeEvent() {
      return () => undefined;
    },
  } as unknown as Terminal;
}

class FakePoller implements LiveStatusPollerLike {
  listener?: (event: LiveStatusPollEvent) => void;
  starts = 0;
  disposals = 0;

  constructor(private readonly disposalWait: Promise<void> = Promise.resolve()) {}

  subscribe(listener: (event: LiveStatusPollEvent) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  start(): void {
    this.starts += 1;
  }

  async poll(): Promise<boolean> {
    return true;
  }

  async dispose(): Promise<void> {
    this.disposals += 1;
    await this.disposalWait;
  }

  emit(event: LiveStatusPollEvent): void {
    this.listener?.(event);
  }
}

function makeApp(
  state: AppState,
  cols = 168,
  rows = 46,
  livePoller: LiveStatusPollerLike = new FakePoller(),
  onClose?: () => void,
): App {
  return new App({
    terminal: stubTerminal(cols, rows, onClose),
    state,
    cwd: '/tmp/pinetop-live-test',
    livePoller,
  });
}

function text(app: App, cols = 168, rows = 46): string {
  return app.render(cols, rows).map(stripAnsi).join('\n');
}

let state: AppState;

beforeEach(() => {
  state = initialState();
  state.page = 'live';
  state.live.snapshot = liveSnapshot();
  state.live.lastSuccessAt = '2026-08-01T12:00:01.000Z';
  reconcileLiveSelection(state);
});

describe('ordinal-9 LIVE routing', () => {
  test('appends LIVE without renumbering pages 1–8 or adding a research command', () => {
    expect(PAGES).toEqual([
      'editor',
      'backtest',
      'sweep',
      'walkforward',
      'scan',
      'portfolio',
      'compare',
      'logs',
      'live',
    ]);
    expect(COMMANDS).not.toContain('live' as never);
    const app = makeApp(state);
    app.onKey({ name: '9', text: '9' });
    expect(state.page).toBe('live');
  });

  test('renders the dedicated Pinelive command line, not the LOGS fallback', () => {
    const screen = text(makeApp(state));
    expect(screen).toContain('$ pinelive status --all --json');
    expect(screen).not.toContain('$ pinerun backtest');
  });
});

describe('read-only LIVE rendering and navigation', () => {
  test('wide terminals show the run list and selected detail together', () => {
    const screen = text(makeApp(state));
    expect(screen).toContain('PINELIVE RUNS');
    expect(screen).toContain('RUN aaaaaaaaaaaa…');
    expect(screen).toContain('execution-active');
    expect(screen).toContain('DURABLE EXECUTION EVIDENCE');
    expect(screen).toContain('blocked');
    expect(screen).toContain('official transport is monitor-only');
    expect(screen).toContain('order-ambiguous-1');
    expect(screen).toContain('partial tail');
    expect(screen).toContain('duplicate-execution-id');
    expect(screen).toContain('corrupt-record');
  });

  test('terminal outcomes and per-entry errors have explicit detail', () => {
    selectLiveCursor(state, 1);
    let screen = text(makeApp(state));
    expect(screen).toContain('TERMINAL HISTORY');
    expect(screen).toContain('execution-latched');
    expect(screen).toContain('execution.breaker-latched');

    selectLiveCursor(state, 2);
    screen = text(makeApp(state));
    expect(screen).toContain('DISCOVERY ERROR');
    expect(screen).toContain('registry record could not be validated');
  });

  test('configured binary controls are visibly escaped through poll failure rendering', async () => {
    const cases = [
      { bin: '/tmp/pinelive\n\u001b]52;c;Y2FuYXJ5\u0007' },
      { env: { PINELIVE_BIN: '/tmp/pinelive-\u009b31m' } },
    ];

    for (const options of cases) {
      const liveState = initialState();
      liveState.page = 'live';
      const poller = new LiveStatusPoller({
        ...options,
        spawn: () => {
          throw new Error('missing executable');
        },
      });
      const app = makeApp(liveState, 168, 46, poller);
      app.start();

      expect(liveState.live.error).toMatchObject({ code: 'spawn-failed' });
      expect(liveState.live.error?.message).toContain('\\u');
      expect(
        app
          .render(168, 46)
          .map(stripAnsi)
          .every((row) => !/[\u0000-\u001f\u007f-\u009f]/u.test(row)),
      ).toBe(true);

      await app.stop();
    }
  });

  test('current poll errors retain and visibly age the last successful snapshot', () => {
    state.live.error = { code: 'timeout', message: 'pinelive status exceeded 4000 ms' };
    const screen = text(makeApp(state));
    expect(screen).toContain('poll timeout');
    expect(screen).toContain('last success');
    expect(screen).toContain('execution-active');
  });

  test('narrow terminals show one pane, enter opens detail, and escape returns to the list', () => {
    const app = makeApp(state, 80, 24);
    let screen = text(app, 80, 24);
    expect(screen).toContain('PINELIVE RUNS');
    expect(screen).not.toContain('DURABLE EXECUTION EVIDENCE');

    app.onKey({ name: 'enter' });
    expect(state.panes.live.focus).toBe('detail');
    screen = text(app, 80, 24);
    expect(screen).toContain('IDENTITY');
    expect(screen).not.toContain('PINELIVE RUNS');

    app.onKey({ name: 'escape' });
    expect(state.panes.live.focus).toBe('runs');
    expect(text(app, 80, 24)).toContain('PINELIVE RUNS');
  });

  test('selection follows instance identity across reorder and moves to the nearest survivor', () => {
    const initial = state.live.snapshot!;
    selectLiveCursor(state, 1);
    expect(state.live.selectedInstanceId).toBe(TERMINAL_INSTANCE);

    const reordered = liveSnapshot([
      { ok: true, value: terminalRun() },
      { ok: true, value: activeRun() },
      errorItem(),
    ]);
    state.live.snapshot = reordered;
    reconcileLiveSelection(state, initial);
    expect(state.live.selectedInstanceId).toBe(TERMINAL_INSTANCE);
    expect(state.panes.live.cursor['runs']).toBe(0);

    state.live.snapshot = liveSnapshot([
      { ok: true, value: activeRun() },
      { ok: true, value: activeRun(OTHER_INSTANCE) },
    ]);
    reconcileLiveSelection(state, reordered);
    expect(state.live.selectedInstanceId).toBe(ACTIVE_INSTANCE);
    expect(selectedLiveItem(state)?.ok).toBe(true);
  });

  test('LIVE control-like keys never open a run, filter, editor handoff, or Ask drawer', () => {
    const app = makeApp(state);
    for (const key of ['r', '/', 'e', 'a']) app.onKey({ name: key, text: key });
    expect(state.overlay.kind).toBe('none');
    expect(state.ask.open).toBe(false);
    expect(state.run).toBeNull();
    expect(state.status).toContain('LIVE');
  });

  test('LIVE selection does not mutate page-8 LOGS state', () => {
    state.tradeFilter = 'short';
    state.logScope = 4;
    const app = makeApp(state);
    app.onKey({ name: 'j', text: 'j' });
    app.onKey({ name: 'enter' });
    expect(state.tradeFilter).toBe('short');
    expect(state.logScope).toBe(4);
  });
});

describe('App poller lifecycle', () => {
  test('starts only with App.start, accepts the newest generation, and awaits one disposal before closing', async () => {
    state.live.snapshot = undefined;
    state.live.selectedInstanceId = undefined;
    state.live.selectedItemKey = undefined;
    let releaseDisposal = (): void => undefined;
    const disposalWait = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    const poller = new FakePoller(disposalWait);
    let closes = 0;
    const app = makeApp(state, 168, 46, poller, () => {
      closes += 1;
    });
    expect(poller.starts).toBe(0);

    app.start();
    expect(poller.starts).toBe(1);
    poller.emit({ type: 'started', generation: 2 });
    const newest = liveSnapshot([{ ok: true, value: activeRun(OTHER_INSTANCE) }]);
    poller.emit({
      type: 'snapshot',
      generation: 2,
      snapshot: newest,
      receivedAt: '2026-08-01T12:01:00.000Z',
    });
    poller.emit({
      type: 'snapshot',
      generation: 1,
      snapshot: liveSnapshot(),
      receivedAt: '2026-08-01T12:00:00.000Z',
    });
    expect(state.live.snapshot).toBe(newest);
    expect(state.live.selectedInstanceId).toBe(OTHER_INSTANCE);

    const stopping = app.stop();
    expect(poller.disposals).toBe(1);
    expect(closes).toBe(0);
    expect(app.stop()).toBe(stopping);
    releaseDisposal();
    await stopping;
    expect(poller.disposals).toBe(1);
    expect(closes).toBe(1);
  });

  test('poll failure preserves the last successful snapshot', async () => {
    const prior: PineliveStatusListV1 = state.live.snapshot!;
    const poller = new FakePoller();
    const app = makeApp(state, 168, 46, poller);
    app.start();
    poller.emit({ type: 'started', generation: 3 });
    poller.emit({
      type: 'error',
      generation: 3,
      error: { code: 'timeout', message: 'pinelive status exceeded 4000 ms' },
    });
    expect(state.live.snapshot).toBe(prior);
    expect(state.live.error?.code).toBe('timeout');
    await app.stop();
  });
});

test('same-instance same-code discovery errors retain independent path-keyed selection', () => {
  const hint = 'd'.repeat(32);
  const first = {
    ok: false as const,
    instanceIdHint: hint,
    path: '/tmp/runs/active/error.json',
    error: { code: 'corrupt-record', message: 'record could not be validated' },
  };
  const second = {
    ...first,
    path: '/tmp/runs/history/error.json',
  };
  const previous = liveSnapshot([first, second]);
  state.live.snapshot = previous;
  selectLiveCursor(state, 1);
  expect(selectedLiveItem(state)).toMatchObject({ path: second.path });

  state.live.snapshot = liveSnapshot([second, first]);
  reconcileLiveSelection(state, previous);
  expect(state.panes.live.cursor['runs']).toBe(0);
  expect(selectedLiveItem(state)).toMatchObject({ path: second.path });
});
