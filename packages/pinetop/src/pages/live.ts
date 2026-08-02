import { duration } from '../render/format.js';
import { drawPane, truncate, type Rect } from '../render/screen.js';
import {
  drawHeader,
  drawLeader,
  drawRow,
  fitColumns,
  type Column,
  type Row,
} from '../render/table.js';
import { STYLE, type Style } from '../render/theme.js';
import type { AppState } from '../state.js';
import type {
  LiveDiscoveredRunV1,
  LiveEvidence,
  LivePineliveStatusV1,
  PineliveStatusListItemV1,
  PineliveStatusListV1,
} from '../run/live-status.js';
import { clampCursor, columns, windowFor, type Page, type PageContext } from './page.js';

const PANES = ['runs', 'detail'] as const;

const LIVE_HINTS: readonly { key: string; label: string }[] = [
  { key: 'tab', label: 'list/detail' },
  { key: 'j/k', label: 'move' },
  { key: '↵', label: 'detail' },
  { key: 'esc', label: 'back' },
  { key: ':', label: 'command' },
  { key: '?', label: 'help' },
  { key: 'q', label: 'quit' },
];

interface DetailLine {
  readonly kind: 'title' | 'value';
  readonly label: string;
  readonly value?: string;
  readonly style?: Style;
}

/** Stable identity for readable instances; error-only entries include all bounded evidence. */
export function liveItemKey(item: PineliveStatusListItemV1): string {
  if (item.ok) return `instance:${item.value.instanceId}`;
  return JSON.stringify([
    'error',
    item.path ?? '',
    item.instanceIdHint ?? '',
    item.error.code,
    item.error.message,
  ]);
}

export function selectedLiveItem(state: AppState): PineliveStatusListItemV1 | undefined {
  const items = state.live.snapshot?.items ?? [];
  const selectedKey = state.live.selectedItemKey;
  if (selectedKey) {
    const match = items.find((item) => liveItemKey(item) === selectedKey);
    if (match) return match;
  }
  if (state.live.selectedInstanceId) {
    const match = items.find(
      (item) => item.ok && item.value.instanceId === state.live.selectedInstanceId,
    );
    if (match) return match;
  }
  const cursor = clampCursor(state.panes.live.cursor['runs'] ?? 0, items.length);
  return items[cursor];
}

/** Keep readable selection instance-keyed across reorder and choose the nearest survivor. */
export function reconcileLiveSelection(
  state: AppState,
  previousSnapshot?: PineliveStatusListV1,
): void {
  const items = state.live.snapshot?.items ?? [];
  if (items.length === 0) {
    state.live.selectedItemKey = undefined;
    state.live.selectedInstanceId = undefined;
    state.panes.live.cursor['runs'] = 0;
    return;
  }

  const selectedKey =
    state.live.selectedItemKey ??
    (state.live.selectedInstanceId ? `instance:${state.live.selectedInstanceId}` : undefined);
  let index = selectedKey ? items.findIndex((item) => liveItemKey(item) === selectedKey) : -1;
  if (index < 0) {
    const previousItems = previousSnapshot?.items ?? [];
    const previousIndex = selectedKey
      ? previousItems.findIndex((item) => liveItemKey(item) === selectedKey)
      : (state.panes.live.cursor['runs'] ?? 0);
    index = clampCursor(previousIndex < 0 ? 0 : previousIndex, items.length);
  }
  selectLiveCursor(state, index);
}

export function selectLiveCursor(state: AppState, cursor: number): void {
  const items = state.live.snapshot?.items ?? [];
  const index = clampCursor(cursor, items.length);
  state.panes.live.cursor['runs'] = index;
  const selected = items[index];
  if (!selected) {
    state.live.selectedItemKey = undefined;
    state.live.selectedInstanceId = undefined;
    return;
  }
  state.live.selectedItemKey = liveItemKey(selected);
  state.live.selectedInstanceId = selected.ok ? selected.value.instanceId : undefined;
}

function drawRuns(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const items = state.live.snapshot?.items ?? [];
  const errors = items.filter((item) => !item.ok).length;
  const readable = items.length - errors;
  const age = state.live.lastSuccessAt ? ` · ${ageText(state.live.lastSuccessAt)} old` : '';
  const legend = state.live.inFlightGeneration
    ? `polling · ${readable} runs · ${errors} errors${age}`
    : `${readable} runs · ${errors} errors${age}`;
  const inner = drawPane(screen, rect, {
    title: 'PINELIVE RUNS',
    focused: ctx.focus === 'runs',
    legend,
  });
  if (inner.h <= 0) return;

  let tableY = inner.y;
  if (state.live.error) {
    screen.text(
      inner.x,
      tableY,
      truncate(`poll ${state.live.error.code}: ${state.live.error.message}`, inner.w),
      STYLE.warn,
      inner,
    );
    tableY += 1;
  } else if (!state.live.snapshot) {
    screen.text(
      inner.x,
      tableY,
      state.live.inFlightGeneration ? 'reading pinelive status…' : 'no status snapshot yet',
      STYLE.muted,
      inner,
    );
    return;
  }

  const table: Rect = {
    x: inner.x,
    y: tableY,
    w: inner.w,
    h: Math.max(0, inner.y + inner.h - tableY),
  };
  if (table.h <= 1) return;
  const candidates: Column[] = [
    { key: 'identity', header: 'RUN / INSTANCE', width: 24, priority: 100 },
    { key: 'kind', header: 'KIND', width: 8, priority: 30 },
    { key: 'state', header: 'LIFECYCLE', width: 20, priority: 95 },
    { key: 'posture', header: 'POSTURE', width: 12, priority: 50 },
    { key: 'eligibility', header: 'ELIGIBILITY', width: 20, priority: 90 },
    { key: 'age', header: 'AGE', width: 10, priority: 40, align: 'right' },
  ];
  const fitted = fitColumns(candidates, table.w);
  drawHeader(screen, table, fitted.columns);

  if (items.length === 0) {
    screen.text(table.x, table.y + 1, 'no registered Pinelive runs', STYLE.muted, table);
    return;
  }

  const cursor = selectedIndex(state, items);
  const listRows = Math.max(0, table.h - 1);
  const { from, to } = windowFor(cursor, items.length, listRows);
  for (let index = from; index < to; index++) {
    const item = items[index]!;
    drawRow(screen, table, table.y + 1 + index - from, fitted.columns, listRow(item), {
      selected: index === cursor && ctx.focus === 'runs',
    });
  }
}

function listRow(item: PineliveStatusListItemV1): Row {
  if (!item.ok) {
    return {
      identity: item.instanceIdHint ? shortId(item.instanceIdHint) : (item.path ?? 'unidentified'),
      kind: { text: 'error', style: STYLE.error },
      state: { text: item.error.code, style: STYLE.error },
      posture: '—',
      eligibility: '—',
      age: '—',
    };
  }
  const run = item.value;
  const durable = durableStatus(run);
  const posture = durable
    ? evidenceText(durable.posture, (value) => value)
    : { text: 'not-recorded', uncertain: true };
  const eligibility = durable
    ? evidenceText(durable.executionEligibility, (value) => value.state)
    : { text: 'not-recorded', uncertain: true };
  const identity = runIdentity(run);
  const state = run.kind === 'active' ? run.lifecycle.state : run.history.outcome;
  return {
    identity,
    kind: run.kind,
    state: { text: state, style: lifecycleStyle(state) },
    posture: { text: posture.text, style: posture.uncertain ? STYLE.muted : STYLE.none },
    eligibility: {
      text: eligibility.text,
      style:
        eligibility.uncertain || eligibility.text === 'disabled-by-posture'
          ? STYLE.muted
          : eligibility.text === 'enabled'
            ? STYLE.positive
            : STYLE.warn,
    },
    age:
      run.kind === 'active' ? duration(run.lifecycle.heartbeatAgeMs) : ageText(run.history.endedAt),
  };
}

function drawDetail(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const item = selectedLiveItem(state);
  const lines = detailLines(state, item);
  const title = item?.ok ? `RUN ${shortId(item.value.instanceId)}` : 'RUN DETAIL';
  const inner = drawPane(screen, rect, {
    title,
    focused: ctx.focus === 'detail',
    legend: 'read-only evidence',
  });
  if (inner.h <= 0) return;
  if (!item) {
    screen.text(inner.x, inner.y, 'select a discovered run', STYLE.muted, inner);
    return;
  }

  const cursor = clampCursor(ctx.cursor('detail'), lines.length);
  const { from, to } = windowFor(cursor, lines.length, inner.h);
  for (let index = from; index < to; index++) {
    const line = lines[index]!;
    const y = inner.y + index - from;
    const selected = index === cursor && ctx.focus === 'detail';
    if (line.kind === 'title') {
      if (selected) screen.text(inner.x, y, ' '.repeat(inner.w), STYLE.selected, inner);
      screen.text(inner.x, y, line.label, selected ? STYLE.selected : STYLE.title, inner);
      continue;
    }
    if (selected) screen.text(inner.x, y, ' '.repeat(inner.w), STYLE.selected, inner);
    drawLeader(screen, inner, y, line.label, line.value ?? '', {
      labelStyle: selected ? STYLE.selected : STYLE.muted,
      valueStyle: selected ? STYLE.selected : (line.style ?? STYLE.none),
    });
  }
}

function detailLines(
  state: AppState,
  item: PineliveStatusListItemV1 | undefined,
): readonly DetailLine[] {
  const lines: DetailLine[] = [];
  if (state.live.error) {
    lines.push(
      { kind: 'title', label: 'POLL' },
      {
        kind: 'value',
        label: state.live.error.code,
        value: state.live.error.message,
        style: STYLE.warn,
      },
      {
        kind: 'value',
        label: 'last success',
        value: state.live.lastSuccessAt
          ? `${state.live.lastSuccessAt} (${ageText(state.live.lastSuccessAt)} old)`
          : 'none',
        style: STYLE.muted,
      },
    );
  }
  if (!item) return lines;
  if (!item.ok) {
    lines.push(
      { kind: 'title', label: 'DISCOVERY ERROR' },
      { kind: 'value', label: 'code', value: item.error.code, style: STYLE.error },
      { kind: 'value', label: 'message', value: item.error.message, style: STYLE.error },
    );
    if (item.instanceIdHint)
      lines.push({ kind: 'value', label: 'instance hint', value: item.instanceIdHint });
    if (item.path) lines.push({ kind: 'value', label: 'path', value: item.path });
    return lines;
  }

  const run = item.value;
  const identity = run.kind === 'active' ? run.registration : run.history;
  lines.push(
    { kind: 'title', label: 'IDENTITY' },
    { kind: 'value', label: 'instance', value: run.instanceId },
    { kind: 'value', label: 'run', value: identity.runId ?? 'not recorded', style: STYLE.muted },
    {
      kind: 'value',
      label: 'execution',
      value: identity.executionId ?? 'not recorded',
      style: identity.executionId ? STYLE.none : STYLE.muted,
    },
    { kind: 'value', label: 'broker', value: identity.brokerId },
    { kind: 'value', label: 'registered posture', value: identity.posture },
  );

  if (run.kind === 'active') {
    lines.push(
      { kind: 'title', label: 'LIFECYCLE — DISCOVERY EVIDENCE' },
      {
        kind: 'value',
        label: 'state',
        value: run.lifecycle.state,
        style: lifecycleStyle(run.lifecycle.state),
      },
      { kind: 'value', label: 'registration', value: run.registration.lifecycle },
      {
        kind: 'value',
        label: 'process',
        value: [run.lifecycle.process.state, run.lifecycle.process.reason]
          .filter(Boolean)
          .join(' · '),
      },
      {
        kind: 'value',
        label: 'heartbeat',
        value: `${duration(run.lifecycle.heartbeatAgeMs)} old${run.lifecycle.heartbeatStale ? ' · stale' : ''}`,
        style: run.lifecycle.heartbeatStale ? STYLE.warn : STYLE.none,
      },
      {
        kind: 'value',
        label: 'physical ledger lease',
        value: evidenceText(run.lifecycle.physicalExecutionLease, (value) => value).text,
      },
      {
        kind: 'value',
        label: 'physical account claim',
        value: evidenceText(run.lifecycle.physicalAccountClaim, (value) => value).text,
      },
    );
    pushReasons(lines, 'lifecycle reason', run.lifecycle.reasons);
  } else {
    lines.push(
      { kind: 'title', label: 'TERMINAL HISTORY' },
      { kind: 'value', label: 'outcome', value: run.history.outcome },
      { kind: 'value', label: 'started', value: run.history.startedAt },
      { kind: 'value', label: 'ended', value: run.history.endedAt },
      {
        kind: 'value',
        label: 'final reason',
        value: run.history.finalReasonCode ?? 'not recorded',
        style: run.history.finalReasonCode ? STYLE.none : STYLE.muted,
      },
      {
        kind: 'value',
        label: 'leftover active record',
        value: run.leftoverRegistration ? 'present — cleanup incomplete' : 'absent',
        style: run.leftoverRegistration ? STYLE.warn : STYLE.none,
      },
    );
    pushReasons(lines, 'lifecycle reason', run.lifecycle.reasons);
  }

  const durable = durableStatus(run);
  lines.push({ kind: 'title', label: 'DURABLE EXECUTION EVIDENCE' });
  if (!durable) {
    const evidence = run.kind === 'terminal' ? run.durable : undefined;
    lines.push({
      kind: 'value',
      label: 'durable status',
      value:
        evidence && evidence.availability !== 'known'
          ? `${evidence.availability} · ${evidence.reason}`
          : 'not recorded',
      style: STYLE.muted,
    });
  } else {
    lines.push({
      kind: 'value',
      label: 'status generated',
      value: `${durable.generatedAt} (${ageText(durable.generatedAt)} old)`,
      style: STYLE.muted,
    });
    pushEvidence(lines, 'posture', durable.posture, (value) => value);
    pushEvidence(
      lines,
      'execution eligibility',
      durable.executionEligibility,
      (value) => value.state,
    );
    if (durable.executionEligibility.availability === 'known')
      pushReasons(lines, 'eligibility reason', durable.executionEligibility.value.reasons);
    pushEvidence(
      lines,
      'durable ledger lease',
      durable.ownership.durableLedgerLease,
      (value) => `${value.resource} · lease ${value.leaseId} · owner ${value.ownerId}`,
    );
    pushEvidence(
      lines,
      'durable account claim',
      durable.ownership.durableAccountClaim,
      (value) => `${value.resourceDigest} · claim ${value.claimId} · owner ${value.ownerId}`,
    );

    lines.push(
      { kind: 'title', label: 'LEDGER' },
      { kind: 'value', label: 'path', value: durable.ledger.path },
      {
        kind: 'value',
        label: 'watermark',
        value: `sequence ${durable.ledger.lastSequence ?? 0} · ${durable.ledger.validBytes}/${durable.ledger.bytes} bytes`,
      },
      {
        kind: 'value',
        label: 'partial tail',
        value: durable.ledger.partialTail ? 'present — incomplete fragment excluded' : 'none',
        style: durable.ledger.partialTail ? STYLE.warn : STYLE.none,
      },
      {
        kind: 'value',
        label: 'last record',
        value: durable.ledger.lastRecordAt ?? 'not recorded',
        style: durable.ledger.lastRecordAt ? STYLE.none : STYLE.muted,
      },
    );

    lines.push({ kind: 'title', label: 'BREAKER AND EFFECTS' });
    pushEvidence(
      lines,
      'breaker',
      durable.breaker,
      (value) =>
        `${value.latched ? 'latched' : 'clear'} · ${value.consecutiveErrors} consecutive errors${value.reason ? ` · ${value.reason}` : ''}`,
    );
    pushEvidence(lines, 'unresolved effects', durable.unresolvedEffects, (value) =>
      String(value.length),
    );
    if (durable.unresolvedEffects.availability === 'known') {
      for (const effect of durable.unresolvedEffects.value) {
        lines.push({
          kind: 'value',
          label: `effect ${effect.logicalOrderId}`,
          value: `${effect.certainty} · target ${effect.target} · delta ${effect.delta}`,
          style: STYLE.warn,
        });
      }
    }

    lines.push({ kind: 'title', label: 'LATEST DURABLE OBSERVATION' });
    pushEvidence(
      lines,
      'observation',
      durable.latestObservation,
      (value) =>
        `${value.decisionId} · target ${value.target} · bar ${value.barTime} · ${value.observedAt} · ${value.recordType}`,
    );
    pushWarnings(lines, durable.warnings, 'durable warning');
  }
  pushWarnings(lines, run.warnings, 'discovery warning');
  return lines;
}

function pushEvidence<T>(
  lines: DetailLine[],
  label: string,
  evidence: LiveEvidence<T>,
  known: (value: T) => string,
): void {
  const value = evidenceText(evidence, known);
  lines.push({
    kind: 'value',
    label,
    value: value.text,
    style: value.uncertain ? STYLE.muted : STYLE.none,
  });
}

function pushReasons(lines: DetailLine[], label: string, reasons: readonly string[]): void {
  for (const reason of reasons)
    lines.push({ kind: 'value', label, value: reason, style: STYLE.warn });
}

function pushWarnings(
  lines: DetailLine[],
  warnings: readonly { readonly code: string; readonly message: string }[],
  label: string,
): void {
  for (const warning of warnings)
    lines.push({
      kind: 'value',
      label: `${label} ${warning.code}`,
      value: warning.message,
      style: STYLE.warn,
    });
}

function evidenceText<T>(
  evidence: LiveEvidence<T>,
  known: (value: T) => string,
): { text: string; uncertain: boolean } {
  return evidence.availability === 'known'
    ? { text: known(evidence.value), uncertain: false }
    : { text: `${evidence.availability} · ${evidence.reason}`, uncertain: true };
}

function durableStatus(run: LiveDiscoveredRunV1): LivePineliveStatusV1 | undefined {
  if (run.kind === 'active') return run.durable;
  return run.durable.availability === 'known' ? run.durable.value : undefined;
}

function runIdentity(run: LiveDiscoveredRunV1): string {
  const identity = run.kind === 'active' ? run.registration : run.history;
  return identity.executionId ?? identity.runId ?? shortId(run.instanceId);
}

function selectedIndex(state: AppState, items: readonly PineliveStatusListItemV1[]): number {
  const selected = selectedLiveItem(state);
  const index = selected ? items.indexOf(selected) : -1;
  return index >= 0 ? index : clampCursor(state.panes.live.cursor['runs'] ?? 0, items.length);
}

function lifecycleStyle(state: string): Style {
  if (state === 'running' || state === 'stopped') return STYLE.positive;
  if (state === 'conflict' || state === 'blocked-stale-claim' || state === 'execution-latched')
    return STYLE.error;
  if (state === 'unknown' || state === 'crashed' || state.startsWith('failed')) return STYLE.warn;
  return STYLE.none;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 12)}…`;
}

function ageText(value: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return 'unknown';
  return duration(Math.max(0, Date.now() - at));
}

export const livePage: Page = {
  id: 'live',
  minCols: 110,
  degradeNote: 'one LIVE pane shown; tab toggles list/detail',
  hints: () => LIVE_HINTS,
  panes: () => [...PANES],
  rowCount: (state, paneId) => {
    if (paneId === 'runs') return state.live.snapshot?.items.length ?? 0;
    if (paneId === 'detail') return detailLines(state, selectedLiveItem(state)).length;
    return 0;
  },
  breadcrumb: (state) => {
    const items = state.live.snapshot?.items ?? [];
    const readable = items.filter((item) => item.ok).length;
    const errors = items.length - readable;
    return [
      'pinetop',
      'LIVE',
      state.live.snapshot ? `${readable} runs · ${errors} errors` : 'waiting for status',
    ];
  },
  confirm: (state) => {
    if (state.panes.live.focus !== 'runs' || (state.live.snapshot?.items.length ?? 0) === 0)
      return undefined;
    state.panes.live.focus = 'detail';
    return 'LIVE detail — esc returns to the run list';
  },
  render: (ctx) => {
    const narrow = ctx.screen.cols < livePage.minCols;
    if (narrow) {
      if (ctx.focus === 'detail') drawDetail(ctx, ctx.body);
      else drawRuns(ctx, ctx.body);
      return;
    }
    const listWidth = Math.min(76, Math.max(48, Math.floor(ctx.body.w * 0.46)));
    const [list, detail] = columns(ctx.body, [listWidth]) as [Rect, Rect];
    drawRuns(ctx, list);
    drawDetail(ctx, detail);
  },
};
