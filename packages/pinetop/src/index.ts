/**
 * @heyphat/pinetop — a terminal UI over the `pinerun` CLI.
 *
 * The public surface is the pieces worth reusing or testing: the flag model and
 * argv composition, the report view models, the render primitives, the Ask
 * contract, and the app itself. The engine is not here and never will be —
 * pinetop shells out to `pinerun` and computes no metric of its own (§3 NG1).
 */

export { App, PAGE_MAP, bootstrap, type AppOptions } from './app.js';

export type { Key, TerminalSize, TerminalOptions } from './terminal.js';
export { Terminal, decodeKeys } from './terminal.js';

export type { FlagKind, FlagSpec, CommandSchema, CommandId, PageId } from './flags/schema.js';
export {
  COMMANDS,
  PAGES,
  PAGE_PURPOSE,
  PAGE_TITLES,
  SCHEMAS,
  flagSpec,
  schemaFor,
} from './flags/schema.js';

export type { FlagModel, FlagValue, Override, Pair } from './flags/model.js';
export {
  axisValues,
  cloneModel,
  commandLine,
  comboCount,
  composeArgv,
  displayValue,
  emptyModel,
  isSet,
  redactArgv,
  shellQuote,
  validate,
  withOverrides,
} from './flags/model.js';

export { checkTitle, inputTitles, readInputTitles } from './flags/pine-inputs.js';

export type { LogLevel, LogLine, RunOutcome, SpawnOptions } from './run/spawn.js';
export { classify, probePinerun, resolveBin, runPinerun } from './run/spawn.js';
export type { SessionEntry } from './run/session-log.js';
export { appendSession, readSession, sessionLogPath, stateDir } from './run/session-log.js';

export type {
  AppState,
  AskAction,
  AskState,
  AskTurn,
  EditState,
  Overlay,
  OverlayKind,
  PaneSelection,
  Proposal,
  ProposalEdit,
  RunState,
  RunStatus,
} from './state.js';
export {
  applyProposal,
  initialPanes,
  initialState,
  isDirty,
  nextRunId,
  overridesFor,
  resetRunIds,
  revertOverrides,
  scriptKey,
} from './state.js';

export type { Action, Binding } from './keymap.js';
export { BINDINGS, HINTS, resolve } from './keymap.js';

export type { Rect, PaneOptions } from './render/screen.js';
export {
  BORDER,
  Screen,
  displayWidth,
  drawPane,
  padEnd,
  padStart,
  stripAnsi,
  truncate,
} from './render/screen.js';
export type { Style } from './render/theme.js';
export { QUINTILE, STYLE, gradeStyle, sgr, signStyle } from './render/theme.js';
export type { Cell, Column, Row, RowOptions } from './render/table.js';
export { drawHeader, drawLeader, drawRow, fitColumns } from './render/table.js';
export * from './render/format.js';

export type {
  BacktestJson,
  CompareJson,
  MetricRow,
  MetricSection,
  PortfolioJson,
  ScanJson,
  SleeveJson,
  SweepAxisJson,
  SweepJson,
  SweepRankedJson,
  WalkforwardAggregateJson,
  WalkforwardJson,
  WalkforwardWindowJson,
} from './views/report.js';
export {
  fillModelNote,
  fmtNum,
  fmtPct,
  fmtPf,
  metricRow,
  profitFactor,
  runFooter,
  tearsheetFooter,
  tearsheetSections,
} from './views/report.js';
export type { Heatmap, HeatmapCell } from './views/heatmap.js';
export { buildHeatmap, heatmapLegend } from './views/heatmap.js';

export type { AskProvider, AskResponse, Grounding, ParseResult } from './ask/protocol.js';
export { ASK_CONTRACT, groundReport, parseAskResponse } from './ask/protocol.js';

export type { Page, PageContext } from './pages/page.js';
export { clampCursor, columns, rows, windowFor } from './pages/page.js';

export type { ScriptEntry } from './scripts.js';
export { discoverScripts, scriptLabel } from './scripts.js';

export { loadFlags, saveFlags } from './persist.js';
export { drawFrame, pageOrdinal, widthWarning, windowTitle } from './frame.js';
export type { PaletteItem } from './overlays.js';
export {
  askHeight,
  drawAsk,
  drawFilter,
  drawHelp,
  drawPalette,
  drawRunDialog,
  drawWelcome,
  filterPalette,
  paletteItems,
} from './overlays.js';
export {
  configRowCount,
  drawConfigPane,
  firstUnmetRow,
  hiddenFlagCount,
  isRunRow,
  runRowCount,
  visibleFlags,
} from './pages/config-pane.js';
