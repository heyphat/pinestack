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
  | { kind: 'focus-next' }
  | { kind: 'focus-prev' }
  | { kind: 'move'; delta: number }
  | { kind: 'first' }
  | { kind: 'last' }
  | { kind: 'confirm' }
  | { kind: 'run-dialog' }
  | { kind: 'sweep-dialog' }
  | { kind: 'walkforward' }
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
    keys: ['1', '2', '3', '4', '5', '6', '7'],
    display: '1–7',
    description: 'Switch command page',
    action: { kind: 'page', page: 'backtest' },
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

/** The status bar's one-line hint strip, drawn from the same table. */
export const HINTS: readonly { key: string; label: string }[] = [
  { key: 'tab', label: 'pane' },
  { key: 'j/k', label: 'move' },
  { key: '/', label: 'filter' },
  { key: 'r', label: 'run' },
  { key: 'a', label: 'ask' },
  { key: ':', label: 'command' },
  { key: '?', label: 'help' },
];
