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

export type {
  FlagKind,
  FlagSpec,
  CommandSchema,
  CommandId,
  PageId,
  ViewId,
} from './flags/schema.js';
export {
  COMMANDS,
  PAGES,
  PAGE_PURPOSE,
  PAGE_TITLES,
  SCHEMAS,
  commandForPage,
  flagSpec,
  isCommandPage,
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
export { BINDINGS, EDITOR_KEYS, HINTS, resolve } from './keymap.js';

// The EDITOR page (§4.2, page 1): the buffer, its motions, the modal key handler,
// and the Pine highlighter. Exported for the same reason the flag model is — this
// is the part worth testing without a terminal.
export type { Cursor, EditorBuffer, Snapshot } from './editor/buffer.js';
export {
  bufferText,
  clampTo,
  currentLine,
  deleteChars,
  deleteLines,
  deleteSpan,
  firstNonBlank,
  lineAt,
  newBuffer,
  orderCursors,
  spanText,
  splitLines,
} from './editor/buffer.js';
export type { MotionResult } from './editor/motion.js';
export type { EditorIo } from './editor/io.js';
export { nodeIo, editorIo, setEditorIo } from './editor/io.js';
export type { LaunchResult, Launcher, Suspendable } from './editor/handoff.js';
export {
  handOff,
  launcher,
  pathToEdit,
  resolveEditor,
  setLauncher,
  spawnLauncher,
} from './editor/handoff.js';
export type { EditorState, Register, VimMode } from './editor/state.js';
export { initialEditor, modeLabel } from './editor/state.js';
export type { Span } from './editor/syntax.js';
export { highlight } from './editor/syntax.js';
export type { VimOutcome } from './editor/vim.js';
export { INDENT_WIDTH, handleKey, openFile, writeFile } from './editor/vim.js';
export { bufferInputs, editorPage, ensureEditorFile, selection } from './pages/editor.js';

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
export {
  cachedInputTitles,
  cachedScripts,
  discoverScripts,
  refreshScripts,
  scriptLabel,
} from './scripts.js';

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
export type { InputRow, InputsPaneOptions } from './pages/inputs-pane.js';
export { declaredInputs, drawInputsPane } from './pages/inputs-pane.js';
export type { StrategiesPaneOptions } from './pages/strategies-pane.js';
export {
  STRATEGIES_PANE,
  drawStrategiesPane,
  loadStrategy,
  strategiesHeight,
  strategyRowCount,
} from './pages/strategies-pane.js';
export {
  configRowCount,
  drawConfigPane,
  firstUnmetRow,
  hiddenFlagCount,
  isRunRow,
  runRowCount,
  visibleFlags,
} from './pages/config-pane.js';
