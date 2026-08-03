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
  /**
   * The sweep → walkforward hand-off. No longer a key: a page is reached by its
   * ordinal and nothing else (§4.2.i), and this was never really "go to page 4" —
   * it carries the sweep's axes over. It lives in the palette, where an action
   * with an effect on the config belongs.
   */
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

// ————————————————————————————————————————————————————————— pane accelerators

/**
 * Every key the app itself claims (§4.2.h).
 *
 * Read off the table above rather than listed again beside it, for the same
 * reason `?` is generated: binding a new global key must *move* the pane
 * accelerators, not silently shadow one of them.
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(
  BINDINGS.flatMap((binding) => binding.keys),
);

/** Letters only, lowercased — the name an accelerator is cut from. */
function acceleratorName(paneId: string): string {
  return paneId.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * The pane accelerators for one page (§4.2.h).
 *
 * `tab` walking the ring is fine for two panes and tedious for six, so every pane
 * also answers to a key of its own. The keys are *derived* rather than assigned:
 * a page that gains a pane gets a working accelerator with no table to update,
 * and two panes can never be given the same one.
 *
 * Three rules, in order:
 *
 *  - **The first letter of the pane's name**, and one letter more for as long as
 *    two panes on the page would answer to the same key — `config` and `charts`
 *    become `co` and `ch`, and a third `c…` pane would push all three to three
 *    letters. Nothing outside this page is consulted: the ring is per page, so the
 *    keys are too (STRATEGIES is `s` on BACKTEST and `st` on PORTFOLIO, where
 *    SLEEVES and SUMMARY want the same letter).
 *
 *  - **Shifted when the app already claims that letter**, so the global keymap
 *    always keeps the bare key: RANKED is `R` because `r` opens the run dialog,
 *    EDITOR's buffer pane is `E` because `e` hands off to `$EDITOR`. The whole
 *    sequence shifts, not just its first letter, so it is typed with shift held
 *    down once.
 *
 *  - **No accelerator at all** when both cases are claimed, or when two names are
 *    indistinguishable however far they are cut. `tab` still reaches those panes:
 *    a key that reaches two panes, or that takes `r` away from running, is worse
 *    than a pane that has no key.
 */
export function paneAccelerators(
  panes: readonly string[],
  reserved: ReadonlySet<string> = RESERVED_KEYS,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const paneId of panes) {
    const name = acceleratorName(paneId);
    if (name !== '') names.set(paneId, name);
  }

  // Grow every colliding pane's prefix a letter at a time until the page's keys
  // are distinct, or the names run out of letters to distinguish them by.
  const lengths = new Map<string, number>();
  for (const paneId of names.keys()) lengths.set(paneId, 1);
  for (;;) {
    const claimed = new Map<string, string[]>();
    for (const [paneId, name] of names) {
      const prefix = name.slice(0, lengths.get(paneId)!);
      const holders = claimed.get(prefix);
      if (holders == null) claimed.set(prefix, [paneId]);
      else holders.push(paneId);
    }
    let grew = false;
    for (const holders of claimed.values()) {
      if (holders.length < 2) continue;
      for (const paneId of holders) {
        const length = lengths.get(paneId)!;
        if (length >= names.get(paneId)!.length) continue;
        lengths.set(paneId, length + 1);
        grew = true;
      }
    }
    if (!grew) break;
  }

  const keys = new Map<string, string>();
  for (const [paneId, name] of names) {
    const prefix = name.slice(0, lengths.get(paneId)!);
    const seq = reserved.has(prefix[0]!) ? prefix.toUpperCase() : prefix;
    // Only `g`/`G` are both taken today; a pane named for that letter goes
    // without rather than taking `G` off "last row".
    if (reserved.has(seq[0]!)) continue;
    keys.set(paneId, seq);
  }

  // Two panes that could not be told apart, and any key that is a prefix of a
  // longer one (the shorter fires first, so the longer would be unreachable).
  const sequences = [...keys.values()];
  for (const [paneId, seq] of [...keys]) {
    const ambiguous = sequences.filter((other) => other === seq).length > 1;
    const shadowed = sequences.some((other) => other !== seq && seq.startsWith(other));
    if (ambiguous || shadowed) keys.delete(paneId);
  }
  return keys;
}

export type SequenceMatch = 'exact' | 'partial' | 'none';

/**
 * Compare what has been typed against one accelerator.
 *
 * The first keystroke is case-sensitive, and that is the whole of how `S` reaches
 * STRATEGIES without taking `s` from the sweep dialog. The rest is not: with
 * shift already down for the `S` of `SL`, releasing it before the `L` is not a
 * different intention.
 */
export function matchSequence(seq: string, typed: string): SequenceMatch {
  if (typed === '') return 'partial';
  if (typed.length > seq.length) return 'none';
  if (typed[0] !== seq[0]) return 'none';
  if (seq.slice(1, typed.length).toLowerCase() !== typed.slice(1).toLowerCase()) return 'none';
  return typed.length === seq.length ? 'exact' : 'partial';
}

/** The pane a completed sequence focuses, if it is one. */
export function paneForSequence(
  keys: ReadonlyMap<string, string>,
  typed: string,
): string | undefined {
  for (const [paneId, seq] of keys) {
    if (matchSequence(seq, typed) === 'exact') return paneId;
  }
  return undefined;
}

/** The panes a half-typed sequence could still reach, in ring order. */
export function panesForPrefix(keys: ReadonlyMap<string, string>, typed: string): string[] {
  const out: string[] = [];
  for (const [paneId, seq] of keys) {
    if (matchSequence(seq, typed) === 'partial') out.push(paneId);
  }
  return out;
}

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
