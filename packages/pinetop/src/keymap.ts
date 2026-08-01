/**
 * The keymap (§4.2, normative).
 *
 * The help overlay is generated from this table rather than written beside it,
 * because P0's exit criterion is that `?` documents the *real* keymap — a
 * hand-maintained help text drifts the first time a binding moves.
 */

import type { PageId } from './flags/schema.js';
import { PAGES, PAGE_TITLES } from './flags/schema.js';

export type Action =
  | { kind: 'page'; page: PageId }
  | { kind: 'page-prefix' }
  | { kind: 'focus-next' }
  | { kind: 'focus-prev' }
  | { kind: 'move'; delta: number }
  | { kind: 'first' }
  | { kind: 'last' }
  | { kind: 'confirm' }
  | { kind: 'run-dialog' }
  | { kind: 'sweep-dialog' }
  | { kind: 'walkforward' }
  | { kind: 'edit-external' }
  | { kind: 'filter' }
  | { kind: 'toggle-advanced' }
  | { kind: 'ask' }
  | { kind: 'palette' }
  | { kind: 'help' }
  | { kind: 'escape' }
  | { kind: 'reject-proposal' }
  | { kind: 'quit' };

export interface Binding {
  /** Keys that trigger this action, in the order the help overlay lists them. */
  keys: string[];
  /** How the help overlay renders the keys (⌘K has no terminal encoding). */
  display: string;
  description: string;
  action: Action;
  /** Grouping in the help overlay. */
  group: 'navigate' | 'select' | 'act' | 'overlay';
}

const pageBindings: Binding[] = PAGES.map((page, index) => ({
  keys: [String(index + 1)],
  display: String(index + 1),
  description: PAGE_TITLES[page],
  action: { kind: 'page', page },
  group: 'navigate' as const,
}));

export const BINDINGS: Binding[] = [
  {
    keys: PAGES.map((_, index) => String(index + 1)),
    display: `1–${PAGES.length}`,
    description: 'Switch page',
    action: { kind: 'page', page: 'backtest' },
    group: 'navigate',
  },
  {
    keys: [' '],
    display: `space 1–${PAGES.length}`,
    // The second way to switch page, and the only one that also works inside the
    // EDITOR buffer, where a bare digit is a vim count. Bound globally rather than
    // on that page alone, so it is one rule everywhere instead of a local dialect.
    description: 'Switch page — also works inside the editor buffer',
    action: { kind: 'page-prefix' },
    group: 'navigate',
  },
  {
    keys: ['tab'],
    display: 'tab',
    description: 'Next pane in the focus ring',
    action: { kind: 'focus-next' },
    group: 'navigate',
  },
  {
    keys: ['shift-tab'],
    display: 'shift-tab',
    description: 'Previous pane',
    action: { kind: 'focus-prev' },
    group: 'navigate',
  },
  {
    keys: ['j', 'down'],
    display: 'j / ↓',
    description: 'Move selection down',
    action: { kind: 'move', delta: 1 },
    group: 'select',
  },
  {
    keys: ['k', 'up'],
    display: 'k / ↑',
    description: 'Move selection up',
    action: { kind: 'move', delta: -1 },
    group: 'select',
  },
  {
    keys: ['g'],
    display: 'g',
    description: 'First row',
    action: { kind: 'first' },
    group: 'select',
  },
  {
    keys: ['G'],
    display: 'G',
    description: 'Last row',
    action: { kind: 'last' },
    group: 'select',
  },
  {
    keys: ['enter'],
    display: '↵',
    description: 'Load selection · confirm dialog · apply pending proposal',
    action: { kind: 'confirm' },
    group: 'act',
  },
  {
    keys: ['r'],
    display: 'r',
    description: "Run dialog for this page's command",
    action: { kind: 'run-dialog' },
    group: 'act',
  },
  {
    keys: ['s'],
    display: 's',
    description: 'Sweep dialog',
    action: { kind: 'sweep-dialog' },
    group: 'act',
  },
  {
    keys: ['w'],
    display: 'w',
    description: 'Walkforward page',
    action: { kind: 'walkforward' },
    group: 'act',
  },
  {
    keys: ['e'],
    display: 'e',
    // Global rather than EDITOR-only: from a report page this is the whole loop —
    // `e`, edit, back, `r`. Inside the buffer it never fires, because the buffer
    // claims the keyboard and `e` there is the word-end motion.
    description: 'Edit this page’s script in $EDITOR, then reload it',
    action: { kind: 'edit-external' },
    group: 'act',
  },
  {
    keys: ['/'],
    display: '/',
    description: 'Filter fills',
    action: { kind: 'filter' },
    group: 'act',
  },
  {
    keys: ['.'],
    display: '.',
    description: 'Show / hide the advanced flags in the config pane',
    action: { kind: 'toggle-advanced' },
    group: 'act',
  },
  {
    keys: ['a'],
    display: 'a',
    description: 'Ask (AI prompt drawer)',
    action: { kind: 'ask' },
    group: 'overlay',
  },
  {
    keys: [':', 'ctrl-p'],
    display: ': / ctrl-p',
    description: 'Command palette',
    action: { kind: 'palette' },
    group: 'overlay',
  },
  {
    keys: ['?'],
    display: '?',
    description: 'This overlay',
    action: { kind: 'help' },
    group: 'overlay',
  },
  {
    keys: ['escape'],
    display: 'esc',
    description: 'Dismiss overlay · clear filter · unscope log',
    action: { kind: 'escape' },
    group: 'overlay',
  },
  {
    keys: ['ctrl-x'],
    display: 'ctrl-x',
    description: 'Reject pending AI proposal',
    action: { kind: 'reject-proposal' },
    group: 'overlay',
  },
  {
    keys: ['ctrl-c', 'q'],
    display: 'q / ctrl-c',
    description: 'Quit',
    action: { kind: 'quit' },
    group: 'overlay',
  },
];

/** Resolve a key to its action. Page digits are resolved to their own page. */
export function resolve(key: string): Action | undefined {
  const digit = pageBindings.find((b) => b.keys[0] === key);
  if (digit) return digit.action;
  for (const binding of BINDINGS) {
    if (binding.action.kind === 'page') continue;
    if (binding.keys.includes(key)) return binding.action;
  }
  return undefined;
}

/**
 * The EDITOR page's own keys (§4.2, page 1).
 *
 * These are not `Binding`s: they resolve inside the buffer rather than to an
 * `Action`, because a modal editor's `j` cannot be a global binding. They live
 * here anyway so `?` documents the *whole* keyboard from one file — the same
 * reason the help overlay is generated rather than written.
 *
 * This list is normative in the other direction too: a key not on it is not
 * implemented (`.`, macros, marks, named registers), and does nothing rather
 * than something almost-right.
 */
export const EDITOR_KEYS: readonly { display: string; description: string }[] = [
  { display: 'i I a A', description: 'Insert · at indent · after · at line end' },
  { display: 'o O', description: 'Open a line below / above' },
  { display: 'esc', description: 'Back to normal mode' },
  { display: 'h j k l', description: 'Move by character / line' },
  { display: 'w b e', description: 'By word (W B E by WORD)' },
  { display: '0 ^ $', description: 'Line start · indent · line end' },
  { display: 'gg G', description: 'First line · last line (42G → line 42)' },
  { display: 'space 1–8', description: 'Switch page — the app binding, unchanged here' },
  { display: 'ctrl-p', description: 'Command palette — reaches any page by name' },
  { display: '{ }', description: 'Previous / next blank line' },
  { display: 'f F t T', description: 'To a character on this line' },
  { display: 'ctrl-d/u', description: 'Half a window (ctrl-f/b a whole one)' },
  { display: 'zz zt zb', description: 'Cursor line to middle / top / bottom' },
  { display: 'x X s', description: 'Delete a character · before · and insert' },
  { display: 'd c y', description: 'Operator + motion: dw, d$, c2w, y}, dfx, dgg' },
  { display: 'dd cc yy', description: 'Whole lines (3dd for three)' },
  { display: 'D C Y', description: 'To line end · and insert · yank the line' },
  { display: 'p P', description: 'Put after / before' },
  { display: '>> <<', description: 'Indent / outdent (>j, >}, or in visual)' },
  { display: 'J', description: 'Join with the next line' },
  { display: 'r<char>', description: 'Replace one character' },
  { display: 'v V', description: 'Visual · visual line (o swaps ends)' },
  { display: 'u ctrl-r', description: 'Undo · redo' },
  { display: '/ ? n N', description: 'Search, next / previous match' },
  { display: ':w :wq', description: 'Write · write and close (`:w path`)' },
  { display: ':q :q!', description: 'Close · discard unwritten changes' },
  { display: ':e path', description: 'Open a file; a new path starts one' },
  { display: ':42', description: 'Go to a line (`:set nonu` hides the gutter)' },
  { display: '1 2 3 …', description: 'A count (5j, 42G, 3dd) — space 1–8 switches page' },
  { display: 'tab', description: 'Leave the buffer — pinetop is one key away' },
];

/**
 * The status bar's one-line hint strip, drawn from the same table.
 *
 * Seven items is what fits an 80-column strip with room left for the status text
 * on the right, so this is a chosen seven and not everything. `/ filter` is not
 * here because it only does anything on LOGS, which supplies its own strip
 * through `Page.hints` — the same hook EDITOR uses.
 */
export const HINTS: readonly { key: string; label: string }[] = [
  { key: 'tab', label: 'pane' },
  { key: 'j/k', label: 'move' },
  { key: 'e', label: 'edit' },
  { key: 'r', label: 'run' },
  { key: 'a', label: 'ask' },
  { key: ':', label: 'command' },
  { key: '?', label: 'help' },
];
