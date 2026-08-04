/**
 * EDITOR (§4.2, page 1) — the Pine source itself.
 *
 * This page reverses NG4 ("not a Pine editor"), and the reason is the loop the
 * whole app exists for. §2's premise is that a session is iterative: read the
 * report, decide the stop is wrong, change it, run again. Flags cover the half of
 * that which is a flag — but a stop that is wrong in the *script* sent the user
 * to another window, and coming back meant a stale report beside a changed file
 * with nothing on screen saying so. The `.pine` is part of the invocation; it now
 * has a page like every other part.
 *
 * It is still not a second engine or a second linter (§3 NG1 stands): the editor
 * writes bytes and colours tokens. Whether the script compiles is `piner`'s
 * answer, and you get it by running it.
 *
 * Layout follows §4.4 — the sidebar is the left column (the project's file
 * tree and the `input()` titles of the open Pine file), the buffer is the wide
 * middle. The one deliberate departure is documented on `scrollIntoView` in
 * `editor/vim.ts`: the buffer scrolls, because a text cursor defines its own
 * viewport.
 */

import { inputTitles } from '../flags/pine-inputs.js';
import type { GitFileStatus } from '../git-status.js';
import { HINTS } from '../keymap.js';
import { int } from '../render/format.js';
import { displayWidth, drawPane, truncate, type Rect } from '../render/screen.js';
import { STYLE, type Style } from '../render/theme.js';
import {
  cachedEditorFiles,
  editorFileLabel,
  refreshScripts,
  type EditorFileEntry,
} from '../scripts.js';
import type { AppState } from '../state.js';
import { bufferText, orderCursors, type Cursor } from '../editor/buffer.js';
import { highlight } from '../editor/syntax.js';
import { modeLabel, type EditorState } from '../editor/state.js';
import { handleKey, openFile } from '../editor/vim.js';
import { drawInputsPane } from './inputs-pane.js';
import { drawTerminal, TERMINAL_PANE, ESCAPE_HATCH, type TerminalPaneWidth } from '../term/pane.js';
import {
  clampCursor,
  columns,
  drawListSearchRow,
  rows,
  windowFor,
  type Page,
  type PageContext,
} from './page.js';

/**
 * Focus ring order, which is not the layout order on purpose: `tab` from FILES
 * lands in the buffer, because that is the pane you came here for. INPUTS is an
 * outline you glance at, so it sits last in the ring.
 */
const PANES = ['files', 'editor', 'inputs'] as const;

/** Narrowest useful terminal pane and widest automatic terminal pane. */
const TERMINAL_MIN_WIDTH = 32;
const TERMINAL_AUTO_MAX_WIDTH = 80;

/**
 * The narrowest source pane the adjustable terminal may leave behind. This is the
 * 45-column source width produced by the existing automatic layout exactly where
 * the terminal first becomes visible, so manual growth never makes the editor less
 * usable than opening the unadjusted pane already could.
 */
const TERMINAL_MIN_EDITOR_WIDTH = 45;

/**
 * Width of the shell column when it is open.
 *
 * The responsive default is unchanged: 38%, bounded to 32–80 columns. An explicit
 * preference may grow beyond 80 when the outer terminal has room, but it is always
 * clamped before layout so the editor retains its established minimum width.
 */
function terminalWidths(
  bodyW: number,
  sidebarW: number,
  preferredWidth?: number,
): TerminalPaneWidth {
  const automatic = Math.min(
    TERMINAL_AUTO_MAX_WIDTH,
    Math.max(TERMINAL_MIN_WIDTH, Math.floor(bodyW * 0.38)),
  );
  const maximum = bodyW - sidebarW - TERMINAL_MIN_EDITOR_WIDTH;
  const rendered = Math.min(maximum, Math.max(TERMINAL_MIN_WIDTH, preferredWidth ?? automatic));
  return { automatic, minimum: TERMINAL_MIN_WIDTH, maximum, rendered };
}

/**
 * Total width below which the shell column is not drawn at all. The buffer plus
 * the sidebar is the page's reason to exist; the shell is the guest.
 *
 * The body is the full width of the screen (`frame.ts` returns `w: screen.cols`),
 * so this is comparable to the terminal's own column count without adjustment —
 * which is what lets the app refuse to *open* a column it could not draw.
 */
export const TERMINAL_MIN_BODY = 108;

/** Whether the shell column is both open and affordable at this width. */
export function terminalVisible(state: AppState, bodyW: number): boolean {
  return state.terminal.open && bodyW >= TERMINAL_MIN_BODY;
}

/**
 * Open something worth looking at the first time the page is shown.
 *
 * Reading a file is not a config mutation, so §4.6's "nothing without a keypress"
 * does not bind here — and an empty buffer beside a project full of scripts is a
 * puzzle, not a blank slate. The loaded strategy wins; failing that, the first
 * script in the project.
 */
export function ensureEditorFile(state: AppState, cwd = process.cwd()): void {
  if (state.editor.buffer != null) return;
  const files = cachedEditorFiles(cwd);
  const configured = state.flags.backtest.scripts.find((path) => path.endsWith('.pine'));
  const fallback = files.find((entry) => entry.kind === 'pine') ?? files[0];
  const path = configured ?? fallback?.path;
  if (path == null) return;
  openFile(state.editor, path);

  const discovered = files.find((entry) => entry.path === path);
  if (discovered != null) selectEditorTreeFile(state, discovered, files);
}

function isPinePath(path: string): boolean {
  return path.endsWith('.pine');
}

/** The `input()` titles of a Pine buffer as it stands — not of the file on disk. */
export function bufferInputs(editor: EditorState): string[] {
  if (editor.buffer == null || !isPinePath(editor.buffer.path)) return [];
  return inputTitles(bufferText(editor.buffer));
}

// ————————————————————————————————————————————————————————————— the sidebar

export interface EditorFolderTreeRow {
  kind: 'folder';
  id: string;
  path: string;
  label: string;
  depth: number;
  parentId?: string;
  expanded: boolean;
  /** Exact caller paths used by the Git snapshot for every supported leaf. */
  descendantPaths: readonly string[];
}

export interface EditorFileTreeRow {
  kind: 'file';
  id: string;
  path: string;
  label: string;
  depth: number;
  parentId?: string;
  entry: EditorFileEntry;
}

export type EditorTreeRow = EditorFolderTreeRow | EditorFileTreeRow;

interface EditorTreeFolderNode {
  name: string;
  path: string;
  parentId?: string;
  depth: number;
  folders: Map<string, EditorTreeFolderNode>;
  files: EditorTreeFileNode[];
  descendantPaths: string[];
}

interface EditorTreeFileNode {
  name: string;
  id: string;
  parentId?: string;
  depth: number;
  entry: EditorFileEntry;
}

function folderTreeId(path: string): string {
  return `folder:${path}`;
}

function fileTreeId(entry: EditorFileEntry): string {
  return `file:${entry.label}`;
}

function editorPathParts(entry: EditorFileEntry): string[] {
  const parts = entry.label.split('/').filter((part) => part !== '' && part !== '.');
  return parts.length > 0 ? parts : [editorFileLabel(entry.path)];
}

/** Project files projected into visible VS Code-style folder and leaf rows. */
export function editorTreeRows(
  files: readonly EditorFileEntry[],
  collapsed: Readonly<Record<string, true>>,
): EditorTreeRow[] {
  const root: EditorTreeFolderNode = {
    name: '',
    path: '',
    depth: -1,
    folders: new Map(),
    files: [],
    descendantPaths: [],
  };

  for (const entry of files) {
    const parts = editorPathParts(entry);
    let folder = root;

    for (let depth = 0; depth < parts.length - 1; depth++) {
      const name = parts[depth]!;
      let child = folder.folders.get(name);
      if (child == null) {
        const path = folder.path === '' ? name : `${folder.path}/${name}`;
        child = {
          name,
          path,
          parentId: folder.path === '' ? undefined : folderTreeId(folder.path),
          depth,
          folders: new Map(),
          files: [],
          descendantPaths: [],
        };
        folder.folders.set(name, child);
      }
      child.descendantPaths.push(entry.path);
      folder = child;
    }

    folder.files.push({
      name: parts[parts.length - 1]!,
      id: fileTreeId(entry),
      parentId: folder.path === '' ? undefined : folderTreeId(folder.path),
      depth: parts.length - 1,
      entry,
    });
  }

  const rows: EditorTreeRow[] = [];
  const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

  const append = (folder: EditorTreeFolderNode): void => {
    for (const child of [...folder.folders.values()].sort(byName)) {
      const id = folderTreeId(child.path);
      const expanded = collapsed[id] !== true;
      rows.push({
        kind: 'folder',
        id,
        path: child.path,
        label: child.name,
        depth: child.depth,
        parentId: child.parentId,
        expanded,
        descendantPaths: child.descendantPaths,
      });
      if (expanded) append(child);
    }
    for (const file of [...folder.files].sort(byName)) {
      rows.push({
        kind: 'file',
        id: file.id,
        path: file.entry.path,
        label: file.name,
        depth: file.depth,
        parentId: file.parentId,
        entry: file.entry,
      });
    }
  };

  append(root);
  return rows;
}

function selectEditorTreeRow(
  state: AppState,
  rows: readonly EditorTreeRow[],
  index: number,
): number {
  if (rows.length === 0) {
    state.panes.editor.cursor['files'] = 0;
    state.editorTree.selectedId = undefined;
    return 0;
  }
  const selected = clampCursor(index, rows.length);
  state.panes.editor.cursor['files'] = selected;
  state.editorTree.selectedId = rows[selected]!.id;
  return selected;
}

function parentTreePath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function reconcileEditorTreeSelection(state: AppState, rows: readonly EditorTreeRow[]): number {
  if (rows.length === 0) return selectEditorTreeRow(state, rows, 0);

  const selectedId = state.editorTree.selectedId;
  if (selectedId != null) {
    const exact = rows.findIndex((row) => row.id === selectedId);
    if (exact >= 0) {
      state.panes.editor.cursor['files'] = exact;
      return exact;
    }

    const separator = selectedId.indexOf(':');
    let ancestor = parentTreePath(separator < 0 ? '' : selectedId.slice(separator + 1));
    while (ancestor !== '') {
      const index = rows.findIndex((row) => row.id === folderTreeId(ancestor));
      if (index >= 0) return selectEditorTreeRow(state, rows, index);
      ancestor = parentTreePath(ancestor);
    }
  }

  return selectEditorTreeRow(state, rows, state.panes.editor.cursor['files'] ?? 0);
}

export function visibleEditorFiles(
  state: AppState,
  files: readonly EditorFileEntry[] = cachedEditorFiles(),
): EditorFileEntry[] {
  const query = state.listSearch.files.trim().toLowerCase();
  if (query === '') return [...files];
  return files.filter(
    (entry) =>
      entry.label.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query),
  );
}

function reconcileFilteredEditorTreeSelection(
  state: AppState,
  rows: readonly EditorTreeRow[],
): number {
  if (rows.length === 0) {
    // Keep the stable unfiltered id so clearing a no-result query restores it.
    state.panes.editor.cursor['files'] = 0;
    return 0;
  }

  const selectedId = state.editorTree.selectedId;
  const exact = selectedId == null ? -1 : rows.findIndex((row) => row.id === selectedId);
  if (exact >= 0) {
    state.panes.editor.cursor['files'] = exact;
    return exact;
  }

  const firstFile = rows.findIndex((row) => row.kind === 'file');
  return selectEditorTreeRow(state, rows, firstFile >= 0 ? firstFile : 0);
}

function visibleEditorTree(state: AppState): { rows: EditorTreeRow[]; cursor: number } {
  const filtering = state.listSearch.files.trim() !== '';
  const rows = editorTreeRows(
    visibleEditorFiles(state),
    filtering ? {} : state.editorTree.collapsed,
  );
  return {
    rows,
    cursor: filtering
      ? reconcileFilteredEditorTreeSelection(state, rows)
      : reconcileEditorTreeSelection(state, rows),
  };
}

function selectEditorTreeFile(
  state: AppState,
  entry: EditorFileEntry,
  files = cachedEditorFiles(),
): void {
  const parts = editorPathParts(entry);
  let path = '';
  for (const part of parts.slice(0, -1)) {
    path = path === '' ? part : `${path}/${part}`;
    delete state.editorTree.collapsed[folderTreeId(path)];
  }
  const rows = editorTreeRows(files, state.editorTree.collapsed);
  const index = rows.findIndex((row) => row.id === fileTreeId(entry));
  if (index >= 0) selectEditorTreeRow(state, rows, index);
}

function handleFilesKey(state: AppState, name: string): boolean {
  const filtering = state.listSearch.files.trim() !== '';
  const { rows, cursor } = visibleEditorTree(state);
  const row = rows[cursor];
  if (row == null) return false;

  switch (name) {
    case 'j':
    case 'down':
      selectEditorTreeRow(state, rows, cursor + 1);
      return true;
    case 'k':
    case 'up':
      selectEditorTreeRow(state, rows, cursor - 1);
      return true;
    case 'g':
      selectEditorTreeRow(state, rows, 0);
      return true;
    case 'G':
      selectEditorTreeRow(state, rows, rows.length - 1);
      return true;
    case 'right':
      if (row.kind !== 'folder') return true;
      if (!row.expanded) {
        delete state.editorTree.collapsed[row.id];
        state.editorTree.selectedId = row.id;
        return true;
      }
      if (rows[cursor + 1]?.parentId === row.id) {
        selectEditorTreeRow(state, rows, cursor + 1);
      }
      return true;
    case 'left':
      if (filtering) {
        if (row.parentId != null) {
          const parent = rows.findIndex((candidate) => candidate.id === row.parentId);
          if (parent >= 0) selectEditorTreeRow(state, rows, parent);
        } else {
          state.status = 'clear the FILES search to collapse folders';
        }
        return true;
      }
      if (row.kind === 'folder' && row.expanded) {
        state.editorTree.collapsed[row.id] = true;
        state.editorTree.selectedId = row.id;
        return true;
      }
      if (row.parentId != null) {
        const parent = rows.findIndex((candidate) => candidate.id === row.parentId);
        if (parent >= 0) selectEditorTreeRow(state, rows, parent);
      }
      return true;
    default:
      return false;
  }
}

function gitStatusStyle(status: GitFileStatus): Style {
  if (status === 'U') return STYLE.error;
  if (status === '?') return STYLE.accent;
  return STYLE.pending;
}

function folderGitSummary(
  row: EditorFolderTreeRow,
  statuses: Readonly<Record<string, GitFileStatus>>,
): { count: number; conflicted: boolean } {
  let count = 0;
  let conflicted = false;
  for (const path of row.descendantPaths) {
    const status = statuses[path];
    if (status == null) continue;
    count += 1;
    if (status === 'U') conflicted = true;
  }
  return { count, conflicted };
}

function drawFiles(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const allFiles = cachedEditorFiles();
  const files = visibleEditorFiles(state, allFiles);
  const query = state.listSearch.files;
  const filtering = query.trim() !== '';
  const open = state.editor.buffer?.path;
  const changed = allFiles.reduce(
    (count, entry) => count + (state.editorGit.statuses[entry.path] == null ? 0 : 1),
    0,
  );
  const count = filtering ? `${files.length}/${allFiles.length}` : String(allFiles.length);

  const paneInner = drawPane(screen, rect, {
    title: 'FILES',
    focused: ctx.focus === 'files',
    key: ctx.paneKey('files'),
    legend:
      allFiles.length === 0
        ? undefined
        : state.editorGit.enabled
          ? `${count} · git${changed}`
          : filtering
            ? count
            : `${count} files`,
  });
  if (paneInner.h <= 0) return;

  const inner = drawListSearchRow(screen, paneInner, {
    query,
    active: state.listSearch.active === 'files',
    placeholder: 'files',
  });
  if (inner.h <= 0) return;

  if (allFiles.length === 0) {
    screen.text(inner.x, inner.y, 'no .pine or .md here', STYLE.muted, inner);
    screen.text(inner.x, inner.y + 1, ':e path creates one', STYLE.muted, inner);
    return;
  }
  if (files.length === 0) {
    screen.text(inner.x, inner.y, `no files match /${query}`, STYLE.muted, inner);
    return;
  }

  const { rows: tree, cursor } = visibleEditorTree(state);
  if (tree.length === 0) {
    screen.text(inner.x, inner.y, `no files match /${query}`, STYLE.muted, inner);
    return;
  }
  const listRows = Math.max(0, inner.h - 1);
  const { from, to } = windowFor(cursor, tree.length, listRows);

  for (let i = from; i < to; i++) {
    const row = tree[i]!;
    const y = inner.y + (i - from);
    const selected = i === cursor && ctx.focus === 'files';
    const isOpen = row.kind === 'file' && row.path === open;
    const gitStatus = row.kind === 'file' ? state.editorGit.statuses[row.path] : undefined;
    const folderGit =
      row.kind === 'folder' ? folderGitSummary(row, state.editorGit.statuses) : undefined;
    const gitMarker =
      gitStatus ??
      (row.kind === 'folder' && !row.expanded && folderGit != null && folderGit.count > 0
        ? '•'
        : undefined);

    if (selected) screen.text(inner.x, y, ' '.repeat(inner.w), STYLE.selected);
    // The open file keeps its bar marker wherever the cursor is, so "which file
    // is in the buffer" never depends on where you last pressed j.
    screen.text(inner.x, y, isOpen ? '▌' : ' ', selected ? STYLE.selected : STYLE.accent);

    const prefix = `${'  '.repeat(row.depth)}${
      row.kind === 'folder' ? (row.expanded ? '▾ ' : '▸ ') : '  '
    }`;
    const prefixWidth = displayWidth(prefix);
    screen.text(
      inner.x + 1,
      y,
      prefix,
      selected ? STYLE.selected : row.kind === 'folder' ? STYLE.accent : STYLE.muted,
      inner,
    );
    screen.text(
      inner.x + 1 + prefixWidth,
      y,
      truncate(row.label, Math.max(0, inner.w - 4 - prefixWidth)),
      selected
        ? STYLE.selected
        : row.kind === 'folder'
          ? STYLE.none
          : isOpen
            ? STYLE.none
            : STYLE.muted,
      inner,
    );

    // Git owns the penultimate cell; the final cell remains the stronger warning
    // that the open in-memory buffer has not been written anywhere yet.
    if (gitMarker != null && inner.w >= 2) {
      const markerStyle =
        gitStatus != null
          ? gitStatusStyle(gitStatus)
          : folderGit?.conflicted === true
            ? STYLE.error
            : STYLE.pending;
      screen.text(inner.x + inner.w - 2, y, gitMarker, selected ? STYLE.selected : markerStyle);
    }
    if (isOpen && state.editor.buffer?.modified === true) {
      screen.text(inner.x + inner.w - 1, y, '+', selected ? STYLE.selected : STYLE.pending);
    }
  }

  const selectedRow = tree[cursor];
  if (selectedRow == null) return;

  let footer: string;
  if (selectedRow.kind === 'folder') {
    const summary = folderGitSummary(selectedRow, state.editorGit.statuses);
    footer = filtering
      ? `j/k ←/→ · clear search to collapse${summary.count > 0 ? ` · git${summary.count}` : ''}`
      : `j/k ←/→ · ↵ ${selectedRow.expanded ? 'collapse' : 'expand'}${
          summary.count > 0 ? ` · git${summary.count}` : ''
        }`;
  } else {
    const status = state.editorGit.statuses[selectedRow.path];
    footer = status == null ? 'j/k · ↵ open' : `j/k · ↵ open · git ${status}`;
  }
  screen.text(inner.x, inner.y + inner.h - 1, truncate(footer, inner.w), STYLE.muted, inner);
}

/**
 * The `input()` titles the buffer declares, read from the buffer rather than
 * from disk — so the outline answers "did my rename land?" while you are still
 * typing it, and `--input` names can be checked against the source you have in
 * front of you (§4.5.e is the same list, validated).
 */
function drawInputs(ctx: PageContext, rect: Rect): void {
  const titles = bufferInputs(ctx.state.editor);
  drawInputsPane(ctx, rect, {
    paneId: 'inputs',
    rows: titles.map((title) => ({ title })),
    legend: titles.length > 0 ? String(titles.length) : undefined,
    empty:
      ctx.state.editor.buffer == null
        ? 'no file open'
        : isPinePath(ctx.state.editor.buffer.path)
          ? 'no input() declared'
          : 'Pine files only',
  });
}

// —————————————————————————————————————————————————————————————— the buffer

interface Selection {
  start: Cursor;
  end: Cursor;
  linewise: boolean;
}

/** The visual-mode selection, ordered and inclusive of the cursor's character. */
export function selection(editor: EditorState): Selection | null {
  const buffer = editor.buffer;
  if (buffer == null || editor.anchor == null) return null;
  if (editor.mode !== 'visual' && editor.mode !== 'visual-line') return null;
  const [start, end] = orderCursors(editor.anchor, { line: buffer.line, col: buffer.col });
  return { start, end, linewise: editor.mode === 'visual-line' };
}

/** The selected column range on one line, or null when the line is untouched. */
function selectedColumns(
  sel: Selection,
  line: number,
  length: number,
): { from: number; to: number } | null {
  if (line < sel.start.line || line > sel.end.line) return null;
  if (sel.linewise) return { from: 0, to: Math.max(1, length) };
  const from = line === sel.start.line ? sel.start.col : 0;
  const to = line === sel.end.line ? sel.end.col + 1 : Math.max(1, length);
  return { from, to: Math.max(from, to) };
}

function drawBuffer(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const editor = state.editor;
  const buffer = editor.buffer;
  const focused = ctx.focus === 'editor';

  const legend =
    buffer == null
      ? undefined
      : `${buffer.line + 1}:${buffer.col + 1} · ${int(buffer.lines.length)}L${
          buffer.modified ? ' +' : ''
        }`;

  const inner = drawPane(screen, rect, {
    title: buffer == null ? 'EDITOR' : truncate(editorFileLabel(buffer.path).toUpperCase(), 28),
    focused,
    key: ctx.paneKey('editor'),
    legend,
  });
  if (inner.h <= 0) return;

  // The last interior row is the vim status line; the rest is the window. The
  // key layer reads this back for ctrl-d, ctrl-f and zz.
  const textH = Math.max(1, inner.h - 1);
  const statusY = inner.y + inner.h - 1;
  editor.viewHeight = textH;

  if (buffer == null) {
    screen.text(inner.x, inner.y, 'no file open', STYLE.muted, inner);
    screen.text(inner.x, inner.y + 1, 'tab to FILES and press ↵, or :e path', STYLE.muted, inner);
    drawStatus(ctx, inner, statusY);
    return;
  }

  const gutterW = editor.gutter ? Math.max(4, String(buffer.lines.length).length + 2) : 0;
  const textX = inner.x + gutterW;
  const textW = Math.max(1, inner.x + inner.w - textX);
  // One shared horizontal offset rather than per-line: the rows must stay on a
  // common grid, or the indentation stops meaning anything (§4.3.a).
  const hoff = Math.max(0, buffer.col - textW + 1);
  const top = Math.max(0, Math.min(buffer.top, Math.max(0, buffer.lines.length - 1)));
  const sel = selection(editor);

  for (let row = 0; row < textH; row++) {
    const index = top + row;
    const y = inner.y + row;

    if (index >= buffer.lines.length) {
      // vim's own marker for "past the end of the buffer" — an empty row and a
      // row that does not exist are different facts.
      screen.text(inner.x, y, '~', STYLE.muted, inner);
      continue;
    }

    const text = buffer.lines[index]!;

    if (gutterW > 0) {
      const label = String(index + 1);
      // Right-aligned, one space clear of the text column.
      screen.text(
        textX - 1 - label.length,
        y,
        label,
        index === buffer.line ? STYLE.none : STYLE.muted,
        inner,
      );
    }

    screen.text(textX, y, text.slice(hoff, hoff + textW), STYLE.none, inner);
    // Markdown is intentionally plain text: Pine token colours would make prose,
    // examples, and numbers look like source syntax they do not have.
    if (isPinePath(buffer.path)) {
      for (const span of highlight(text)) {
        const from = Math.max(span.start, hoff);
        const to = Math.min(span.start + span.length, hoff + textW);
        if (to <= from) continue;
        screen.text(textX + (from - hoff), y, text.slice(from, to), span.style, inner);
      }
    }

    if (sel != null) {
      const range = selectedColumns(sel, index, text.length);
      if (range != null) {
        const from = Math.max(range.from, hoff);
        const to = Math.min(range.to, hoff + textW);
        for (let col = from; col < to; col++) {
          screen.text(textX + (col - hoff), y, text[col] ?? ' ', STYLE.selected, inner);
        }
      }
    }

    if (index === buffer.line) {
      // The terminal cursor is hidden (the app owns the grid), so the cursor is
      // a styled cell. Bold reverse, so it stays visible inside a selection.
      const cx = textX + (buffer.col - hoff);
      if (cx >= textX && cx < textX + textW) {
        const ch = text[buffer.col] ?? ' ';
        screen.text(cx, y, ch === '' ? ' ' : ch, focused ? STYLE.cursor : STYLE.selected, inner);
      }
    }
  }

  drawStatus(ctx, inner, statusY);
}

/**
 * The vim status line: the command being typed, or the last message, or the
 * mode. The partial command (`3d`, `f`) sits on the right the way vim shows it,
 * so a half-entered operator is visible rather than silently pending.
 */
function drawStatus(ctx: PageContext, inner: Rect, y: number): void {
  const { screen, state } = ctx;
  const editor = state.editor;
  const buffer = editor.buffer;

  let left = '';
  let style: Style = STYLE.muted;
  if (editor.mode === 'command') {
    left = `${editor.cmdPrefix}${editor.cmdline}█`;
    style = STYLE.accent;
  } else if (editor.message !== '') {
    left = editor.message;
    style = editor.error ? STYLE.error : STYLE.muted;
  } else {
    left = modeLabel(editor.mode);
    style = STYLE.accentBold;
  }
  screen.text(inner.x, y, truncate(left, inner.w), style, inner);

  const partial = `${editor.count}${editor.operator ?? ''}${editor.pending ?? ''}`;
  const ruler =
    buffer == null
      ? ''
      : `${buffer.line + 1},${buffer.col + 1}${partial === '' ? '' : `  ${partial}`}`;
  if (ruler !== '' && displayWidth(left) + displayWidth(ruler) + 2 <= inner.w) {
    screen.text(inner.x + inner.w - displayWidth(ruler), y, ruler, STYLE.muted, inner);
  }
}

// ———————————————————————————————————————————————————————————————— the page

const EDITOR_HINTS: readonly { key: string; label: string }[] = [
  { key: 'i', label: 'insert' },
  { key: 'esc', label: 'normal' },
  { key: ':w', label: 'write' },
  { key: ':q', label: 'close' },
  { key: 'tab', label: 'pane' },
  { key: ESCAPE_HATCH, label: 'shell' },
  { key: '?', label: 'help' },
];

/** Shell-prompt hints, where Pinetop owns retained scrollback and Esc can leave. */
const TERMINAL_HINTS: readonly { key: string; label: string }[] = [
  { key: ESCAPE_HATCH, label: 'scroll / pane keys' },
  { key: 'then tab/shift-tab', label: 'next / previous pane' },
  { key: 'esc', label: 'leave' },
];

/** A mouse-aware full-screen child owns both the screen and its history. */
const TERMINAL_APP_HINTS: readonly { key: string; label: string }[] = [
  { key: ESCAPE_HATCH, label: 'app scroll / pane keys' },
  { key: 'then tab/shift-tab', label: 'next / previous pane' },
];

/** A full-screen child without a scroll protocol still needs the escape hatch. */
const TERMINAL_CONTROL_HINTS: readonly { key: string; label: string }[] = [
  { key: ESCAPE_HATCH, label: 'control / pane keys' },
  { key: 'then tab/shift-tab', label: 'next / previous pane' },
];

/** The escape-hatch mode when no application scroll protocol is available. */
const TERMINAL_CONTROL_MODE_HINTS: readonly { key: string; label: string }[] = [
  { key: '</>', label: 'width' },
  { key: '=', label: 'reset' },
  { key: ESCAPE_HATCH, label: 'resume' },
  { key: 'esc', label: 'resume' },
  { key: 'tab', label: 'next pane' },
  { key: 'shift-tab', label: 'previous pane' },
];

/** Normal-buffer SCROLL mode, backed by xterm's retained lines. */
const TERMINAL_SCROLL_HINTS: readonly { key: string; label: string }[] = [
  { key: 'k/j', label: 'line' },
  { key: 'u/d', label: 'page' },
  { key: 'g/G', label: 'top/live' },
  { key: '</>', label: 'width' },
  { key: '=', label: 'reset' },
  { key: 'esc', label: 'resume' },
  { key: 'tab', label: 'next pane' },
  { key: 'shift-tab', label: 'previous pane' },
];

/** Alternate-screen SCROLL mode, translated into child-owned wheel gestures. */
const TERMINAL_APP_SCROLL_HINTS: readonly { key: string; label: string }[] = [
  { key: 'k/j', label: 'app line' },
  { key: 'u/d', label: 'app page' },
  { key: '</>', label: 'width' },
  { key: '=', label: 'reset' },
  { key: 'esc', label: 'resume' },
  { key: 'tab', label: 'next pane' },
  { key: 'shift-tab', label: 'previous pane' },
];

export const editorPage: Page = {
  id: 'editor',
  // The sidebar's 22 columns plus enough buffer to read a Pine line without the
  // indentation dominating. Narrower than the report pages on purpose: there is
  // no table here whose payoff column could fall off the edge.
  minCols: 72,
  degradeNote: 'the buffer loses columns',

  // The shell joins the ring only while it is actually on screen, so `tab` never
  // stops on a pane you cannot see — which would be a keyboard trap, because that
  // pane takes every keystroke. `visible` is what the last frame decided; it is
  // open-and-wide-enough, and `open` alone is not sufficient. Last in the ring for
  // the same reason INPUTS is late: `tab` from FILES must still land in the buffer.
  panes: (state) =>
    state.terminal.open && state.terminal.visible ? [...PANES, TERMINAL_PANE] : [...PANES],

  rowCount: (state, paneId) => {
    switch (paneId) {
      case 'files':
        return visibleEditorTree(state).rows.length;
      case 'inputs':
        return bufferInputs(state.editor).length;
      case 'editor':
        return state.editor.buffer?.lines.length ?? 0;
      default:
        // The shell has no rows to select. `j`/`k` there are characters the child
        // receives, and they never reach the cursor layer at all.
        return 0;
    }
  },

  hints: (state) => {
    const focus = state.panes.editor.focus;
    if (focus === TERMINAL_PANE) {
      const session = state.terminal.session;
      if (state.terminal.scrolling === true) {
        if (session?.applicationScrollAvailable === true) return TERMINAL_APP_SCROLL_HINTS;
        if (session?.altScreen === true) return TERMINAL_CONTROL_MODE_HINTS;
        return TERMINAL_SCROLL_HINTS;
      }
      if (session?.applicationScrollAvailable === true) return TERMINAL_APP_HINTS;
      if (session?.altScreen === true) return TERMINAL_CONTROL_HINTS;
      return TERMINAL_HINTS;
    }
    return focus === 'editor' ? EDITOR_HINTS : HINTS;
  },

  breadcrumb: (state) => {
    const crumbs = ['pinetop'];
    const buffer = state.editor.buffer;
    if (buffer == null) return [...crumbs, '(no file open)'];
    crumbs.push(buffer.path);
    crumbs.push(`${int(buffer.lines.length)} lines`);
    if (buffer.isNew) crumbs.push('new file');
    else if (buffer.modified) crumbs.push('unwritten changes');
    return crumbs;
  },

  confirm: (state) => {
    const focus = state.panes.editor.focus;
    if (focus === 'inputs') return undefined;
    // ↵ in the shell is the child's, and it already got it through the raw input
    // path — this branch only guards against a `confirm` dispatched some other
    // way (the palette) from running FILES' open-a-file logic while the shell
    // has focus.
    if (focus === TERMINAL_PANE) return undefined;

    // ↵ on FILES toggles a folder or opens a file. It never loads a file as the
    // strategy to run — that remains BACKTEST's own ↵, so navigating project
    // notes cannot change what the next `r` spawns.
    if (focus === 'editor') return undefined;
    const { rows, cursor } = visibleEditorTree(state);
    if (rows.length === 0) {
      const query = state.listSearch.files;
      return query.trim() === ''
        ? 'no .pine or .md here — :e path starts one'
        : `no files match /${query}`;
    }
    const row = rows[cursor];
    if (row == null) return undefined;

    if (row.kind === 'folder') {
      if (state.listSearch.files.trim() !== '') {
        return 'clear the FILES search to collapse folders';
      }
      if (row.expanded) state.editorTree.collapsed[row.id] = true;
      else delete state.editorTree.collapsed[row.id];
      state.editorTree.selectedId = row.id;
      return `${row.expanded ? 'collapsed' : 'expanded'} ${row.path}`;
    }

    // Re-selecting the open file only enters its buffer. Calling openFile here
    // would reload the disk copy and could silently discard an unwritten edit.
    if (state.editor.buffer?.path === row.path) {
      state.panes.editor.focus = 'editor';
      return `editing ${row.entry.label}`;
    }
    if (state.editor.buffer?.modified === true) {
      return 'unwritten changes — :w to write, or :e! to discard';
    }
    openFile(state.editor, row.path);
    state.panes.editor.focus = 'editor';
    return `editing ${row.entry.label} — i inserts, :w writes`;
  },

  /**
   * The buffer owns the keyboard whenever it has focus. `tab` and `ctrl-c` are
   * the exceptions the vim layer refuses to take, so the rest of the app is
   * always one keystroke away.
   *
   * The shell claims it far harder — it takes `ctrl-c` and `tab` too, because a
   * shell without them is not a shell (see `term/pane.ts`). Both are reported
   * here so the frame stops drawing pane accelerators that are about to be eaten.
   */
  claimsKeyboard: (state) => {
    const focus = state.panes.editor.focus;
    return focus === 'editor' || focus === TERMINAL_PANE;
  },

  onKey: (state, key) => {
    if (state.panes.editor.focus === 'files' && handleFilesKey(state, key.name)) return true;
    if (state.panes.editor.focus !== 'editor') return false;
    const outcome = handleKey(state.editor, key);
    // A file written for the first time has to appear in FILES, and in the
    // STRATEGIES pane that shares the same discovery cache.
    if (outcome.wrote != null) refreshScripts();
    if (outcome.closed === true) state.panes.editor.focus = 'files';
    return outcome.consumed;
  },

  render: (ctx) => {
    const { body, screen, state } = ctx;
    const sidebarW = Math.min(34, Math.max(22, Math.floor(screen.cols * 0.2)));

    // Three columns when the shell is up, two when it is not. `columns` always
    // appends one rect that absorbs the remainder, so the buffer is the absorber
    // in both cases and never has to be measured.
    const showTerminal = terminalVisible(state, body.w);
    // Published for the focus ring and raw terminal controls, neither of which can
    // measure the screen itself. Written every frame so an outer resize is reflected
    // by the time the next key is handled.
    state.terminal.visible = showTerminal;
    const width = showTerminal
      ? terminalWidths(body.w, sidebarW, state.terminal.preferredWidth)
      : undefined;
    state.terminal.width = width;
    const termW = width?.rendered ?? 0;
    const [sidebar, main, terminalRect] = (
      showTerminal
        ? columns(body, [sidebarW, body.w - sidebarW - termW])
        : [...columns(body, [sidebarW]), { x: 0, y: 0, w: 0, h: 0 }]
    ) as [Rect, Rect, Rect];

    const inputsH = Math.min(12, Math.max(4, Math.floor(sidebar.h * 0.32)));
    const [filesRect, inputsRect] = rows(sidebar, [sidebar.h - inputsH]) as [Rect, Rect];

    drawFiles(ctx, filesRect);
    drawInputs(ctx, inputsRect);
    drawBuffer(ctx, main);

    if (showTerminal) {
      drawTerminal(screen, terminalRect, state.terminal, {
        focused: ctx.focus === TERMINAL_PANE,
        key: ctx.paneKey(TERMINAL_PANE),
      });
    }
  },
};
