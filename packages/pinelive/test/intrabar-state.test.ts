import { expect, test } from 'bun:test';
import type { Bar, BarUpdate, LiveSourcePolicy } from '@heyphat/pinery';
import { IntrabarState } from '../src/core/intrabar-state.js';

const native = Object.freeze({ kind: 'native' as const });

function bar(time: number, close = 11): Bar {
  return { time, open: 10, high: 12, low: 9, close, volume: 1 };
}

function update(
  time: number,
  revision: number,
  isClose: boolean,
  eventTime: number,
  options: {
    close?: number;
    source?: LiveSourcePolicy;
    recovered?: boolean;
  } = {},
): BarUpdate {
  return {
    bar: bar(time, options.close),
    revision,
    isClose,
    eventTime,
    source: options.source ?? native,
    ...(options.recovered === undefined ? {} : { recovered: options.recovered }),
  };
}

test('IntrabarState accepts increasing forming revisions and exactly one final commit', () => {
  const state = new IntrabarState({
    timeframe: '1m',
    source: native,
    cutoverCursor: 60,
  });

  const first = state.acceptUpdate(update(120, 1, false, 1_000));
  const revised = state.acceptUpdate(update(120, 2, false, 1_001, { close: 11.5 }));
  const final = state.acceptUpdate(update(120, 3, true, 1_002, { close: 11.5 }));

  expect([first?.finalCommit, revised?.finalCommit, final?.finalCommit]).toEqual([
    false,
    false,
    true,
  ]);
  expect([first?.identity.revision, revised?.identity.revision, final?.identity.revision]).toEqual([
    1, 2, 3,
  ]);
  expect(final).toMatchObject({ executable: true, reason: 'eligible' });
  expect(state.finalizedCursor).toBe(120);
  expect(Object.isFrozen(final)).toBe(true);
  expect(Object.isFrozen(final?.identity)).toBe(true);

  expect(state.acceptUpdate(update(120, 3, true, 1_003, { close: 11.5 }))).toBeUndefined();
  expect(() => state.acceptUpdate(update(120, 4, true, 1_004, { close: 11.75 }))).toThrow(
    'conflicting authoritative finals',
  );
});

test('IntrabarState independently rejects cutover overlap and revision/finality violations', () => {
  const state = new IntrabarState({
    timeframe: '1m',
    source: native,
    cutoverCursor: 60,
  });
  expect(() => state.acceptUpdate(update(60, 1, true, 1_000))).toThrow('exclusive warmup cutover');

  state.acceptUpdate(update(120, 2, false, 1_001));
  expect(() => state.acceptUpdate(update(120, 2, true, 1_002))).toThrow('strictly increase');
  expect(() => state.acceptUpdate(update(180, 1, true, 1_003))).toThrow('before the active bar');
});

test('recovered finals and a startup discontinuity compute as non-executable', () => {
  const startup = new IntrabarState({
    timeframe: '1m',
    source: native,
    cutoverCursor: 60,
    startupDiscontinuity: true,
  });
  expect(startup.acceptUpdate(update(120, 1, false, 1_000))).toMatchObject({
    executable: false,
    reason: 'startup-discontinuity',
  });
  expect(startup.acceptUpdate(update(120, 2, true, 1_001))).toMatchObject({
    executable: false,
    reason: 'startup-discontinuity',
    finalCommit: true,
  });
  expect(startup.acceptUpdate(update(180, 1, true, 1_002))).toMatchObject({
    executable: true,
    reason: 'eligible',
  });

  const recovery = new IntrabarState({
    timeframe: '1m',
    source: native,
    cutoverCursor: 60,
  });
  expect(recovery.acceptUpdate(update(120, 1, true, 1_000, { recovered: true }))).toMatchObject({
    executable: false,
    reason: 'recovered-final',
    finalCommit: true,
  });
});

test('closedBars admission is strict, final-only, and advances the exclusive cursor', () => {
  const state = new IntrabarState({ timeframe: '1m', cutoverCursor: 60 });
  const accepted = state.acceptClosedBar(bar(120));
  expect(accepted).toMatchObject({
    identity: { kind: 'closed-bar', barTime: 120, revision: 1 },
    finalCommit: true,
    executable: true,
  });
  expect(state.finalizedCursor).toBe(120);
  expect(() => state.acceptClosedBar(bar(120))).toThrow('did not advance finalized cursor');
});

test('historical final-close and non-zero chart anchor gate both live admission paths', () => {
  const anchoredLive = new IntrabarState({
    timeframe: '1h',
    source: native,
    cutoverCursor: 1_800,
    firstAdmissibleLiveOpen: 5_400,
    anchorTime: 1_800,
  });
  expect(anchoredLive.acceptUpdate(update(5_400, 1, true, 5_400_000))).toMatchObject({
    finalCommit: true,
    executable: true,
  });

  const closeOnly = new IntrabarState({
    timeframe: '1h',
    cutoverCursor: 0,
    firstAdmissibleLiveOpen: 3_600,
    anchorTime: 0,
  });
  expect(() => closeOnly.acceptClosedBar(bar(60))).toThrow('warmup final close');
  expect(() => closeOnly.acceptClosedBar(bar(3_660))).toThrow('not aligned');
  expect(closeOnly.acceptClosedBar(bar(3_600))).toMatchObject({ finalCommit: true });
});
