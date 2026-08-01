# pinetop — Design Document

**Name:** `pinetop` — confirmed
**Author:** Design · **Status:** Built — see §7 and [README](./README.md)
**Created:** 2026-07-31 · **Last Updated:** 2026-07-31 (v1.3)
**Prototype:** `Tessera Backtester TUI.dc.html` (file name pending rename) (interactive, keyboard-driven)
**Upstream:** `pinestack/packages/pinerun`, `pinestack/docs/*.md`

---

## 1. Overview

`pinetop` is a terminal UI over the `pinerun` CLI. It keeps a strategy's report
resident on screen and makes the command's own flags the thing you edit, so the
**edit → rerun → reread** loop happens in place instead of through repeated shell
invocations and scrollback archaeology.

It adds no analytics of its own. Every number it shows comes from `pinerun --json`;
piner remains the sole authority for fills, timestamps, and metrics.

This document records the design decisions behind the prototype and the constraints an
implementation must honour. It is written for an engineer or coding agent building the
real binary.

---

## 2. Context & Problem Statement

`pinerun` is a well-formed one-shot CLI: each command reads flags, runs, prints a report,
exits. `backtest` prints a tearsheet, `sweep` a ranked table plus heatmap, `walkforward`
a per-window verdict, `scan` a ranked universe, `portfolio` sleeves against one pot,
`compare` two runs side by side.

Three frictions come from the one-shot shape, and only from it:

1. **The flags are invisible while you read the output.** You reason about a drawdown,
   decide the stop is wrong, and must reconstruct the whole invocation to change one value.
2. **Comparison is manual.** The previous run is in scrollback, or gone. Judging
   "did that help?" means holding two tearsheets in your head.
3. **The commands are a workflow, but the CLI can't say so.** `sweep` produces a winner
   that `walkforward` exists to distrust; `backtest` is the deep-dive on a combo `sweep`
   found. Nothing in the terminal carries you along that path.

**Confirmed premise:** users run these commands repeatedly against the same script during
a research session. Sessions are iterative, not single-shot CI invocation — which is what
makes the loop, and therefore this tool, worth building.

---

## 3. Goals and Non-Goals

### Goals

- **G1** — Present each `pinerun` command as a live page: its real flags, its real output.
- **G2** — Make the command visible and editable at all times; the composed invocation is
  always shown verbatim and is always copy-pasteable.
- **G3** — Preserve the workflow between commands (sweep → walkforward → backtest) as
  navigation, not documentation.
- **G4** — Answer questions about a run in plain language, and return any recommended
  change as a **reviewable parameter diff**, never a silent edit.
- **G5** — Behave like a terminal program: fixed character grid, keyboard-first,
  no mouse requirement, no scrollbars.

### Non-Goals

- **NG1** — Not a new engine. No metric, fill, or equity value is computed in `pinetop`.
- **NG2** — Not a broker or live-trading surface. `pinelive` stays a separate program:
  streaming state has no run boundary and no final number, so it does not fit the
  report-page shape this app is built around. No LIVE page, now or later.
- **NG3** — Not a web app. No browser, no server, no remote state.
- **NG4** — ~~Not a Pine editor. Scripts are edited in the user's editor; `pinetop` reloads
  them.~~ **Revised (as built): page 1 is a vim-modal editor for the `.pine`.** The
  reasoning is §2's own: a session is iterative, and the flags were only half of what
  iterating changes. A stop that is wrong in the *script* sent the user to another
  window, and coming back left a stale report beside a changed file with nothing on
  screen saying so. The `.pine` is part of the invocation; it now has a page like every
  other part. What NG4 still rules out stands — no compile, no lint, no completion from a
  language server: `piner` remains the only authority on whether the script is valid
  (§3 NG1). See §4.8.
- **NG5** — No scrolling viewport. Content that exceeds the terminal truncates (§4.4).
  The EDITOR buffer is the one exception, and §4.8 records why.

---

## 4. Proposed Solution

### 4.1 Architecture

```
┌──────────────────────────────────────────────────────────┐
│ pinetop (TUI process)                                    │
│                                                          │
│  Router ── one page per pinerun command                  │
│    │                                                     │
│    ├─ FlagModel      the command's flags as typed state  │
│    ├─ ViewModel      report JSON → renderable rows       │
│    ├─ Renderer       panes, tables, braille plots        │
│    └─ AskLayer       question → answer + proposal        │
│                                                          │
└───────────────┬──────────────────────────────────────────┘
                │ spawn, argv from FlagModel
                ▼
        pinerun <command> … --json
                │ structured report on stdout
                ▼
        piner (engine, authoritative)
```

**Decision 4.1.a — Shell out to `pinerun`, do not link the engine.**
`pinetop` builds argv from its FlagModel, spawns `pinerun … --json`, and renders the
parsed report. The alternative — importing piner directly — was rejected: it would make
`pinetop` a second execution path that can silently disagree with the CLI. Shelling out
guarantees the screen and the printed command produce identical numbers, which is the
premise the whole UI rests on. Cost is process spawn latency, which is immaterial next to
run time.

**Decision 4.1.b — The composed argv is the source of truth for the UI.**
Every page renders its flags from one FlagModel and composes the displayed `$ pinerun …`
line from that same model. There is no second copy of the invocation. If the line on
screen would not run, that is a bug.

### 4.2 Navigation model

One tab per command, numbered, in workflow order:

| # | Page | Command | Purpose (docs' own verb) |
|---|---|---|---|
| 1 | EDITOR | (the `.pine` source) | Write — the script itself, vim keys |
| 2 | BACKTEST | `pinerun backtest` | Analyze — one strategy, one symbol, full tearsheet |
| 3 | SWEEP | `pinerun sweep` | Optimize — one script's input grid |
| 4 | WALKFORWARD | `pinerun walkforward` | Validate — does the swept edge survive OOS |
| 5 | SCAN | `pinerun scan` | Screen — one script across N symbols |
| 6 | PORTFOLIO | `pinerun portfolio` | Combine — N symbols, one pot |
| 7 | COMPARE | `pinerun compare` | Compare — two strategies, same bars |
| 8 | TRADES | (ledger of the current run) | The fills and the engine log |

**Decision 4.2.a — Tabs are commands, not topics.** An earlier prototype had topical tabs
(BACKTEST / TRADES / OPTIMIZE / LOGS). It broke down as soon as more commands arrived:
users think in commands because that is what they type. Number keys `1`–`8` map to the
same ordinal the tab shows.

**Decision 4.2.b — TRADES is the exception and is justified.** It is not a command; it is
the ledger plus engine log for whichever run is loaded. It exists because `--trades`
output is consumed differently from a tearsheet — you scan rows, then interrogate one.

**Decision 4.2.d — EDITOR is the other exception, and it goes first.** It is not a command
either; it is the input to all of them. It is page 1 rather than appended at page 9 because
the tabs are in workflow order and the source is where the workflow starts — every other
page is downstream of the file this one edits. The ordinals of the six command pages
therefore shift by one, which is a real cost paid once (§4.2's "the seven ordinals are
final" no longer holds; eight are).

**Decision 4.2.f — `space` is a global page prefix, alongside `1`–`8`.** A second way to
say the same thing needs justifying, and this is the justification: EDITOR's buffer cannot
give the digits away, because there a digit is a vim count. Rather than let that page define
its own page-switch key — a local dialect for a global verb — the *app* gained a prefix that
works identically on all eight pages. `1`–`8` remain the one-keystroke form everywhere the
digits are free. See §4.8.i.

**Decision 4.2.e — Below ~105 columns the tab bar names only the active page.** Eight titles
plus the run status and the grid size no longer fit an 80-column terminal, and a tab bar
overprinted by the grid size is worse than a compact one. The active page keeps its title
immediately to the right of its own ordinal, so which tab it belongs to is unambiguous; the
`:` palette and `?` list the rest.

**Decision 4.2.c — Within a page, `tab` cycles a focus ring of panes.** The focused pane
is marked two ways: accent border and a `◆` before its title. `j`/`k` moves selection
within the focused pane.

#### Keybindings (normative)

| Key | Action |
|---|---|
| `1`–`8` | Switch page |
| `space` `1`–`8` | Switch page; the only form that works inside the EDITOR buffer (§4.2.f) |
| `tab` / `shift-tab` | Next / previous pane in the focus ring |
| `j` / `k`, `↓` / `↑` | Move selection |
| `g` / `G` | First / last row |
| `↵` | Load selection / confirm dialog / apply pending AI proposal |
| `r` | Run dialog for the current page's command |
| `e` | Edit the current page's script in `$EDITOR`, then reload it (§4.8.g) |
| `s` | Sweep dialog |
| `w` | Walkforward page |
| `/` | Filter fills |
| `a` | Ask (AI prompt drawer) |
| `:` or `⌘K` / `ctrl-p` | Command palette |
| `?` | Keybinding overlay |
| `esc` | Dismiss overlay · clear filter · unscope log |
| `ctrl-x` | Reject pending AI proposal |

On EDITOR, while the buffer has focus, these bindings do **not** apply — the buffer owns the
keyboard (§4.8). `tab` and `ctrl-c` are the two it refuses to take, so the table above is
always one keystroke away.

### 4.3 Rendering contract

This section is the one an implementer must not improvise. The prototype hit each of
these as a real defect.

**Decision 4.3.a — Fixed character grid, no reflow, no scroll.**
A terminal truncates lines; it does not wrap tables or grow scrollbars. Every table row is
`white-space: nowrap` + clipped at the pane edge, so rows keep a uniform single-line
rhythm. Content wider than the frame is cut, not scrolled. In a real TTY this is free; in
the HTML prototype it must be enforced explicitly.

*Exception, as built: the EDITOR buffer scrolls vertically.* Every other pane obeys the rule
by **paging** its selection — the window jumps, it does not scroll. That is wrong for a text
buffer and only for a text buffer: the cursor *is* the position, so a window that jumped a
page whenever the cursor crossed a boundary would move the text out from under an edit in
progress. The buffer therefore keeps a vim-style `scrolloff` of 3, and nothing else in the
app scrolls. Horizontally it still truncates, with one shared offset for all rows so the
indentation stays on a common grid.

**Decision 4.3.b — Charts are braille (U+2800–U+28FF), not block fills.**
Braille gives 2×4 sub-cell resolution, so an 84-column pane carries 168 samples. Three
stacked panels — PRICE (with trade markers), EQUITY (with a dashed initial-capital
baseline), DRAWDOWN (filled region) — matching `pinerun`'s own chart trio.

**Decision 4.3.c — One font for the whole character stream.**
Empty cells must emit **U+2800 (blank braille)**, never U+0020. A space and a braille glyph
resolve from different fonts at different advance widths (measured: 7.80px vs 8.887px at
13px JetBrains Mono), which shears every row by a different amount and destroys the plot.
For the same reason, marker glyphs (`▲▼●○`) must **not** be substituted into the stream —
they come from a third font. Render them on an overlay positioned at `col × cellWidth`,
where the cell width is **measured at runtime**, not assumed. (A native TTY implementation
is exempt: the terminal owns the cell grid. This constraint binds any GUI/web renderer.)

**Decision 4.3.d — Color is stroke, never fill.**
Equity and price render as a one-cell-per-column stroked line (`─ ╱ ╲ │`), not a filled
area. A filled area from a zero baseline is also actively misleading: equity spanning
1.00→1.24 fills 90–100% of every column and conveys nothing. Scale to the data's min–max.

**Decision 4.3.e — Drawdown hangs downward.** 0% at the top, magnitude increasing as the
line descends. An axis whose labels grow negative while its bars grow upward is a
correctness bug, not a style choice.

### 4.4 Layout system

- A page is a grid of **bordered panes**. Each pane has an inset title straddling its top
  border (left) and an optional status legend (right).
- Pane titles are `white-space: nowrap` and must **never** be clipped: a pane that needs
  internal clipping puts `overflow: hidden` on an **inner wrapper**, not on the pane
  itself, or it slices its own title in half.
- Every page declares a `min-width` wide enough for its widest table's fixed tracks. Sizing
  a column so the payoff column falls off the right edge is the failure mode to watch:
  EFF and OOS EQUITY on WALKFORWARD, the EQUITY sparkline on SWEEP.
- The config pane is always the left column; the primary result is the wide middle; a
  summary/verdict pane is the right rail; full-width tables sit beneath.
- **STRATEGIES sits above the config pane on all six command pages**, at the same size and
  first in the focus ring. It started on BACKTEST alone, which made choosing a script a
  BACKTEST-only verb: sweeping a different strategy meant going to page 2, loading it, and
  coming back. Every command takes a `.pine` as its first positional argument, so every
  command page owes you a way to pick one. One renderer (`strategies-pane.ts`), for the same
  reason the config pane is one renderer — a page must not invent its own dialect for a thing
  all of them do. TRADES has none, because it has no command and a script picker there would
  imply it could run something (§4.2.b); EDITOR's FILES pane is the sibling, where `↵` opens
  a buffer instead of loading an argument.
- **SWEEP and WALKFORWARD both carry an INPUTS pane listing every `input()` the selected
  script declares**, marking the ones being swept and showing their grid. Both, because they
  share one `--input` grammar: the flag is in the `axes` group on both, walkforward's own
  help says "same grammar as sweep", and `validate` applies the same "at least one axis" rule
  and the same `--max-combos` cap to each. Walkforward has the stronger claim, in fact — an
  axis is *mandatory* there, so it was the one page where a required flag could only be set
  by retyping. On SWEEP it replaces the AXES pane, which listed only the axes you had already
  set — you cannot choose a grid for inputs you cannot see, and these
  are exactly the names `--input` is validated against (§4.5.e). Same renderer as EDITOR's
  INPUTS, differing only in what sits beside a row. An axis whose name the script does not
  declare is still listed, in warn style: `pinerun` will reject it, and a row that quietly
  vanished would hide why.
- **Each axis is edited on its own row (`EditState.origin: 'axis'`).** `--input` is
  repeatable, so the config pane can only render it as one space-joined field — which meant
  adding a second axis required retyping the first, and made a multi-axis sweep feel
  unsupported when it never was. `↵` on an INPUTS row opens that one axis, prefilled;
  clearing it drops that axis and leaves the others alone. This is the third edit surface
  and shares the same text-input mode as the other two (§10.2).
- **HISTORY sits below the config pane on all six command pages**, last in the focus ring —
  a fixed slab, so the config pane above it keeps the slack. On SWEEP the SURFACE pane moved
  out of the full-width strip beneath the page and into the right column under RANKED, which
  is what frees the sidebar to run the full height. SURFACE pays the sidebar's width for it;
  RANKED's columns are the ones §4.4 protects, and they are unaffected.
- **`compare` marks its two slots `A` and `B`, and `↵` fills the first free one, then keeps
  replacing A.** That is the order the work happens in: pick one, pick the other, then keep
  swapping the left-hand side. The markers make the state visible, and the config pane can
  still set either slot directly (§10.2).

### 4.5 The AI layer

**Decision 4.5.a — A prompt line, not a chat sidebar.**
Ask is a drawer over the bottom of the frame, opened with `a`, driven by the same
keyboard. A persistent chat panel would cost permanent width on a surface where width is
the scarce resource, and would imply conversation is the primary mode. It is not; reading
the report is.

**Decision 4.5.b — Answers and changes are separate objects.**
The model answers in prose grounded in the loaded run (it cites folds, exit reasons, cost
drag — real fields from the report JSON). If a change is warranted it is returned
*additionally*, as a structured proposal:

```jsonc
{
  "answer": "…prose grounded in the run…",
  "proposal": {                        // optional
    "effect": "est. Sharpe 1.42 → 1.51 · max DD −17.2% → −12.8%",
    "note":   "Tighter stop plus a hard time exit; entry logic untouched.",
    "edits": [                         // one per changed input
      { "input": "stopAtr",  "from": "2.4", "to": "1.8", "display": "2.4 ATR → 1.8 ATR" },
      { "input": "maxHoldH", "from": "36",  "to": "18",  "display": "36 h → 18 h" }
    ]
  },
  "action": { "label": "open parameter sweep", "key": "s" }  // optional, when no edit is warranted
}
```

**Decision 4.5.c — Nothing is applied without a keypress.** `↵` applies, `ctrl-x` rejects.
Applied edits land in the config pane marked with a gold dot and the old value struck
through, plus a "not yet re-run" banner and a revert. The app must never silently diverge
from the script on disk — for a backtester, an unexplained parameter change invalidates
every number on screen.

**Decision 4.5.d — The model may decline to propose.** Asked "is this overfit?", the
correct response cites PBO and deflated Sharpe and recommends a re-sweep with combinatorial
purged CV — proposing a parameter edit on that evidence would be malpractice. Encode
"return an action instead of an edit" as a first-class outcome.

**Decision 4.5.e — `edits[].input` must be a real Pine `input()` title, and `to` a bare
value.** `--input` is validated against the script's input titles before anything runs;
`--input maxhold=36h` fails. The UI carries a machine pair (`maxHoldH`, `36`) alongside
every display string (`max hold`, `36 h`), and the display string never reaches argv.

### 4.6 State model

```
AppState
├─ page: 1..7
├─ focus: pane id within page
├─ flags:     { [command]: FlagModel }        // per-command, persisted per project
├─ overrides: { [scriptId]: { [inputTitle]: {from, to} } }   // AI/user edits, not yet run
├─ run:       { id, status: idle|running|failed, progress, report }
└─ ask:       { transcript[], pending: Proposal|null }
```

- **Overrides are keyed by script**, so switching strategies does not leak edits between them.
- **`run.report` is the parsed `--json` payload.** View models derive from it; nothing else
  is a source of numbers.
- Config edits do not auto-run. Running is always explicit (`r` / `↵` in the dialog),
  because a sweep can cost minutes and a keystroke should not spend them.

### 4.7 Visual language

The prototype is rendered in the **Classical** palette (warm near-white ground `#f3f2f2`,
ink `#201f1d`, a single gold accent `#a06f24`/`#7d5411`) with JetBrains Mono. Two
deliberate deviations from that design system are recorded here so they are not "fixed"
later:

1. **Monospace body type** instead of the system's serif — a terminal requires a fixed
   advance width.
2. **One brick tone (`#8a4038`) for negative values** — the system is a mono palette with
   no negative role, and losses must not read as accent.

`pinerun` itself grades TTY output red → yellow → plain → green → bright-green by value
quintile. A native implementation should use the terminal's own ANSI palette (that is what
the CLI does, and it respects the user's theme); the gold/brick mapping applies to the
GUI rendering only. Green/red is not available in Classical, and positives already read as
accent throughout the app.

Pine syntax colours are a separate scale (`SYNTAX` in `render/theme.ts`), kept apart from the
value scale on purpose: these roles are lexical, and a number in source is not a "positive
value". Conflating them would make a report's colour semantics move when a syntax colour is
retuned.

### 4.8 The editor (page 1)

**Decision 4.8.a — Modal, with vim's bindings.** A plain text field cannot share a keyboard
with a TUI: `j` cannot mean both "next flag" and "insert a j", so something has to say which,
and a mode is that something. Given a mode, the rest of the grammar — counts, operators,
motions — is what makes editing here worth doing rather than shelling out. The audience
already has these bindings in their fingers.

**Decision 4.8.b — The buffer owns the keyboard, with two escapes.** While the buffer has
focus, the global keymap is suspended: digits are counts, `j` is a character. Two keys are
refused deliberately. `tab` always leaves the pane, so the buffer is never a keyboard trap.
`ctrl-c` always quits pinetop, so the app remains killable from a half-typed insert. `q` *is*
taken, and answers with how to leave — quitting the app on a stray `q` would discard an
unwritten buffer, and that is the one outcome this page must not have. Outside the buffer,
`q` warns once before discarding, which is the same two-step `:q` / `:q!` gives inside it.

**Decision 4.8.c — The page opens on FILES, not on the buffer.** Entering a surface that
takes the whole keyboard has to be deliberate — `tab` or `↵`, never where you merely landed
by pressing `1`.

**Decision 4.8.d — The buffer is the only writer, and only on `:w`.** Every filesystem write
goes through one injected interface (`EditorIo`), so "what can this program overwrite?" is
answerable by reading one file, and the key layer is testable by pressing keys at a value.
Nothing is written as a side effect of editing.

**Decision 4.8.e — The buffer state is not persisted.** `.pinetop/flags.json` carries flags;
an unwritten buffer restored from a previous session would be an unexplained divergence from
the file on disk — the same reasoning that keeps pending parameter edits out of it (§4.5.c).

**Decision 4.8.f — The INPUTS outline is read from the buffer, not from disk.** It is the same
extraction `--input` is validated against (§4.5.e), run over the text in front of you, so a
renamed `input()` title shows up in the outline before it is written.

**What is deliberately not implemented:** `.` (repeat), macros, marks, named registers,
visual block, and regex search (`/` is a substring). The `?` overlay lists exactly what is
bound, so an unimplemented key does nothing rather than something almost-right.

**Decision 4.8.g — `e` hands the file to the real `$EDITOR`, from any page.**
Because the buffer above is a subset, and the honest answer to "I need my `.vimrc`, my
plugins, `.` repeat, `:%s///`" is to get out of the way: leave the alternate screen,
`spawnSync` the editor with inherited stdio, take the terminal back when it exits, reload
the file. It is a global binding rather than an EDITOR-page one because that is where the
value is — from BACKTEST it is `e`, edit, back, `r`, the whole loop without leaving the
keyboard. Inside the buffer it never fires, since the buffer claims the keyboard and `e`
there is the word-end motion, so no special case is needed.

Four things this decision pins down:

- **The frame is restored in a `finally`.** A throw from the spawn must not strand the user
  outside the alternate screen with raw mode off, and the terminal's own title is reclaimed
  afterwards because the editor will have set its own.
- **It refuses on an unwritten buffer for the same file** — the editor would open the older
  copy on disk and one of the two would lose. Same answer, and same reason, as `:e` and
  `:q` (§4.5.c). A modified buffer for a *different* file is not in the way and is left
  untouched, including on the reload afterwards.
- **`$EDITOR` is split on whitespace and run directly, never through a shell**, so nothing
  in that variable can be interpreted as `;` or `$(…)`. `$VISUAL` wins over `$EDITOR`, which
  is that convention's own split for full-screen editors.
- **`+<line>` only goes to editors that understand it.** `code +42 file` would open a file
  named `+42`, which is worse than losing the cursor position.

**Decision 4.8.i — The buffer never invents a binding of its own; the app gained a prefix
instead.** The tabs have to be reachable without leaving normal mode, but a bare digit there
is a count, and `5j`, `42G` and `3dd` are not optional in an editor that claims to be vim.

The first attempt was `gt` / `gT` / `<n>gt` — vim's own tab-page keys — and it was wrong for
a reason worth recording: it worked *only* on the editor page, so pinetop had two different
ways to switch page depending on where the cursor was. A local dialect for a global verb is
worse than an awkward binding.

So `space` became a **global** page prefix (§4.2.f): `space 3` is page 3 on every page,
buffer or not, and `1`–`8` keep working directly everywhere outside the buffer. The buffer
then passes `space` through rather than binding anything, which is the rule this decision
really states: **a page that claims the keyboard may hand keys back, but may not define
replacements for the app's own verbs.** `tab` and `ctrl-p` pass through on the same grounds.

The costs, both accepted: `space` stops being "one character right" in normal mode (`l` is
that key), and switching page is two keystrokes rather than one. What is bought is a keyboard
with one page-switch rule in it.

One ordering rule falls out of this. A key waiting to be an *argument* is data, not a
binding: after `f`, `t` or `r` the next keystroke is the character to find or write. So the
pending-argument check runs before anything is handed back to the frame, and `f<space>`
finds a space instead of arming the page prefix.

**Decision 4.8.h — Running the editor *inside* a pane was rejected on packaging grounds,
not design ones.** It would need a pty plus a terminal emulator to parse the editor's
escape output into the cell grid — what a tmux pane does. Bun exposes no pty, so it means a
native module, which ends the self-contained single-binary build the installer depends on.
That constraint is what makes the in-frame buffer and `e` complementary rather than
redundant: the buffer for edits worth keeping the report on screen for, `e` for the rest.

---

## 5. Alternatives Considered

| Alternative | Pros | Cons | Why not chosen |
|---|---|---|---|
| Web dashboard over a local server | Rich charts, familiar stack | Second install, second auth story, leaves the terminal | Users are already in a terminal running a CLI; a browser tab breaks the loop it means to close |
| Link piner directly instead of spawning `pinerun` | No spawn cost, richer streaming | A second execution path that can disagree with the CLI | Divergence between UI and CLI numbers is fatal to trust (§4.1.a) |
| Topical tabs (Backtest / Trades / Optimize / Logs) | Fewer tabs early | Breaks as commands are added; not how users think | Commands are the mental model (§4.2.a) |
| Persistent AI chat sidebar | Conversation always visible | Permanently costs width; implies chat is the primary mode | Prompt drawer on demand (§4.5.a) |
| AI applies changes directly | Fewer keystrokes | Silent divergence from the script on disk | Review-then-apply (§4.5.c) |
| Filled-area block charts (`▁▂▃█`) | Simple to render | Reads as a slab at realistic equity ranges; fights the palette | Stroked braille line (§4.3.b/d) |
| Scrollable panes | Nothing is ever hidden | Not terminal behaviour; breaks the fixed grid | Truncate like a TTY (§4.3.a) — except the EDITOR buffer, where the cursor defines the window (§4.8) |
| Shell out to `$EDITOR` *instead of* an editor page | No editor to build or maintain | Tears down the frame, loses the report, and the flags/outline are no longer beside the source | Rejected as a replacement, kept as a companion: the in-frame buffer holds the loop in one screen (§4.8.a) and `e` hands off when you want the real thing (§4.8.g) |
| Run the real editor inside the pane, over a pty | Actual vim, actual config, frame intact | Needs a terminal emulator over the pty, and the pty needs a native module | Ends the self-contained single-binary build (§4.8.h) |
| `--input` overrides listed in the config pane | Shows strategy params next to flags | `universe`, `bar`, and unmapped rows are not `--input` params; duplicates `--symbol`/`--tf` | Removed; the pane lists only real flags |

---

## 6. Trade-offs and Risks

| Trade-off / Risk | Impact | Mitigation |
|---|---|---|
| No scrolling means content can be unreachable at small terminal sizes | User cannot see a column | Declare per-page `min-width`; below it, degrade by dropping the right rail before truncating tables. Warn once at startup if `COLS` is below the page minimum |
| Shelling out serializes the whole report per run | Memory and latency on huge sweeps | Use `--points-csv` / streaming progress for large grids; render the ranked top from `--top` rather than all points |
| AI answers are only as grounded as the JSON handed to them | Confident wrong answers | Send report fields, never raw bars; require every claim to cite a field; show the model exactly what the user sees |
| Estimated effect on a proposal ("Sharpe 1.42 → 1.51") is a prediction | User may read it as measured | Label as `est.`; the dirty banner forces a re-run before any number updates |
| Flag surface is large and grows with pinerun | Config panes drift from the CLI | Generate FlagModels from `pinerun <cmd> --help` / a shared schema rather than hand-listing (§10.2) |
| Braille requires a font with U+2800 coverage | Broken plots on some terminals | Detect at startup; fall back to ASCII line charts |

---

## 7. Implementation Plan

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0 — Shell** | Frame, tab router, pane/border primitives, focus ring, keymap, help overlay | `1`–`7` navigate; `?` documents the real keymap |
| **P1 — Backtest** | FlagModel + argv composition, spawn `pinerun backtest --json`, tearsheet panes, monthly tables, braille trio | Numbers on screen match `pinerun backtest` in a plain shell, byte for byte |
| **P2 — Sweep + Walkforward** | Axis editor with `--input` grammar validation, ranked table, heatmap with quintile shading, window table, WFE verdict | `--max-combos` guard enforced before spawn, as the CLI does |
| **P3 — Scan, Portfolio, Compare** | Universe input, fetch-error collection, sleeve table + correlation matrix, A/B table + overlay | Per-symbol fetch failures render without aborting the page |
| **P4 — Trades + log** | Ledger, filter, per-fill log scoping | Selecting a fill scopes the log; `esc` restores |
| **P5 — Ask** | Prompt drawer, grounding payload, proposal protocol, apply/reject/revert | No path exists that mutates config without a keypress |
| **P6 — Persistence** | Per-project flag state, run history, `walkforward` hand-off from a swept winner | Reopening resumes the last session's flags |
| **P7 — Editor** | Page 1: vim buffer (motions, operators, counts, visual, ex commands), Pine highlighting, FILES + INPUTS sidebar, and `e` to hand off to the real `$EDITOR` | The buffer owns the keyboard but never traps it; only `:w` writes; the frame is always restored after a hand-off |

**Status: P0–P7 are built** (`packages/pinetop/`), verified against real `pinerun`
runs for all six commands. Three things the build added that this plan did not
anticipate, each because the alternative was a screen that lied:

- **`.` reveals the advanced flags, and a flag another flag makes mandatory
  reveals itself.** `--provider` was visible while `--data-dir` — which
  `--provider csv` requires — was not, so choosing csv left the config unrunnable
  with no visible cause.
- **The monthly grids swap with `j`/`k` below 202 columns.** Both are 99 characters
  wide, so side-by-side clipped `DEC` and `YEAR` off *both* — and §4.4 names the
  payoff column as the thing that must not fall off.
- **The walkforward OOS column is a signed `oosProfitPercent` bar, not an equity
  sparkline.** The `--json` payload strips each window's `RunResult` for size, so
  there is no curve on the wire; the bar answers the same question from a field
  that is actually present.

---

## 8. Observability & Monitoring

- Mirror `pinerun`'s own engine log in the TRADES page: resolve, fetch/cache, warmup,
  fills, artifact writes, with levels (`INFO` / `WARN` / `ERR`).
- **A non-zero exit gets a drawer of its own**, not a line in the status strip. As built,
  half the failure was being kept: the last error line went to the status bar, where the
  hints truncated it, and the rest sat in the engine log on a page you had to know to open —
  and the exit code was not retained at all. A run that fails is the thing the user most
  needs to read, so it announces itself: every `error`-level line the engine emitted, the
  exit code (or "did not start", when the process never ran), and the elapsed time. It
  displaces the page rather than covering it, like the Ask drawer and for the same reason
  (§4.5.a) — width is scarce, and a panel that costs columns when nothing has failed is a
  panel that costs columns always. `esc` dismisses it; the dismissal is recorded on the
  `RunState`, so it cannot be inherited by the next failure, and the palette reopens it.
- **A run that exits zero but lost symbols gets the same drawer, in warn style.** `scan` and
  `portfolio` report and continue when a symbol's history cannot be fetched, and `sweep` does
  the same for a combo that errored — the pages list those, but a list beside a tearsheet
  does not say the thing that matters, which is that **the report was computed over what was
  left**. `SCAN — INCOMPLETE` says it. The distinction from a failure is kept in the colour
  and the title: exit 0 is not an error, and calling it one would be its own kind of lie.
- Surface `fetchErrors` per symbol rather than swallowing them — `scan` and `portfolio`
  both report and continue, and the UI must show that distinction.
- Record every spawned invocation with its exit code and duration in a session log, so a
  user can reproduce any on-screen result outside the app.
- Show run cost where it exists: elapsed ms, runs ranked, worker count — the CLI's own
  footer values.

---

## 9. Security & Privacy Considerations

- **Credentials never enter the UI.** Provider keys stay in environment variables /
  the existing credential path; they are never displayed, never persisted by `pinetop`,
  and must be redacted from the echoed command line and the session log.
- **The AI layer is opt-in and sends derived metrics only** — never OHLCV bars, never
  script source, never credentials. The payload is the report summary plus the flags.
  If the model runs remotely, this must be stated in the UI before first use.
- **`--csv` / `--plot` write to user-specified paths.** Show the resolved absolute path
  before writing; never write outside the given directory.

---

## 10. Open Questions

1. **FlagModel generation.** ~~Hand-written flag lists will drift. Can `pinerun` expose a
   machine-readable flag schema, or must we parse `--help`?~~
   **Resolved (as built):** hand-written, with drift made loud instead of prevented.
   The schema mirrors the *structure* of `HELP_SECTIONS` rather than flattening it —
   shared groups are the CLI's own "(as scan)" clause, so a flag added there is added
   once — and `pinetop --check-flags` diffs every command's schema against
   `pinerun <cmd> --help`, exiting non-zero on drift. It is in the release checklist
   and the PR template. Parsing `--help` at runtime was rejected: it would make
   startup depend on the CLI's prose formatting. A machine-readable schema exported
   from `pinerun` would still be strictly better and remains worth doing.
2. **Editing flags in place vs. a dialog.** ~~Today `r`/`s` open a dialog. Inline editing in
   the config pane is faster but needs a text-input mode and an escape story.~~
   **Resolved (as built): both, over one text-input mode.** `↵` on a config row edits
   it in place; `r` still opens the dialog for building a run from nothing, where
   seeing every field and the composed line together earns the modal. They share one
   `EditState` and one row-index space, so a value typed in either behaves
   identically and a shared edit cannot land on the wrong flag. The escape story is
   uniform: while a field is open `↵` commits, `esc` abandons, `ctrl-u` clears, and
   nothing else is reachable — so a half-typed value can never be read as a keymap
   action or start a run. The dialog's last row is `RUN ▸`, so an already-valid
   config is `r` `↵`.
3. **Run history depth.** ~~Still open. `AppState.history` accumulates the session's runs
   and the session log records every invocation, but nothing yet lets COMPARE take two
   *runs* rather than two scripts, and nothing evicts.~~
   **Resolved (as built), except for COMPARE.** Every command page carries a HISTORY pane
   below its config listing that command's runs, newest first; `↵` puts one back on screen.
   Two things that decides:
   - **A run carries the flags it ran with, and `↵` restores them too.** Swapping only the
     report would leave the config pane and the `$ pinerun …` line describing a different
     invocation from the numbers beside them — §4.1.b calls that a bug outright. Restoring
     both keeps page, line and report describing one thing, and makes `r` repeat exactly
     what was loaded. The cost is that loading discards unsaved config edits; the status
     line says so.
   - **It evicts.** 20 runs per command. A `RunState` holds a whole report — equity curves,
     trades, the engine log — so keeping every run of a long session is a leak, and a pane
     that invites keeping them makes it a worse one.
   COMPARE taking two *runs* rather than two scripts is still not built; the pane gives it
   the picker it would need.
4. **`--watch` and the TUI.** Still open, and now leaning: `--watch` is refused before
   spawn (it redraws a terminal and is incompatible with `--json`), so pinetop owns any
   refresh loop by default. Whether it should have one at all is undecided.

---

## 11. References

- `pinestack/docs/backtest.md`, `sweep.md`, `walkforward.md`, `scan.md`, `portfolio.md`, `compare.md`
- `pinestack/docs/common-options.md` — shared flags, ranking spec, swept-input grammar
- `pinestack/packages/pinerun/src/cli.ts` — table headers and footers the UI mirrors
- `pinestack/packages/pinerun/src/export.ts` — `sweepHeatmap`, quintile shading
- Prototype: `Tessera Backtester TUI.dc.html`

---

## 12. Document Summary

| Aspect | Details | Notes |
|---|---|---|
| **Problem** | `pinerun`'s one-shot reports hide the flags you need to change and lose the previous run | Friction is in the loop, not the engine |
| **Proposed Solution** | A keyboard-driven TUI: one page per command, flags live, output resident, AI proposals as reviewable diffs | Shells out to `pinerun --json` |
| **Key Trade-off** | Spawn the CLI rather than link the engine | Accepts latency to guarantee UI and CLI never disagree |
| **Second Trade-off** | No scrolling — content truncates at the frame | Terminal-honest; forces per-page `min-width` discipline |
| **Impact** | New binary in the pinestack family; no change to `pinerun` or piner | Additive |
| **Hard Constraints** | Uniform font stream (U+2800 blanks, overlay markers, measured cell width); pane titles never clipped; stroked charts scaled to min–max | Each was a real defect in the prototype |
| **AI Contract** | `{answer, proposal?: {effect, note, edits[]}, action?}`; `edits[].input` is a Pine `input()` title, `to` is a bare value | Never applied without a keypress |
| **Estimated Effort** | 8 phases, P0–P7 | P1 is the vertical slice that proves the architecture |
| **Status** | Built — P0–P7 in `packages/pinetop/` | Not yet a release artifact; built from a checkout |
| **Owner (DRI)** | [TODO] | Single accountable person, not a team |
| **Open Questions** | 2 of 4 remain (§10.3 run-history depth, §10.4 `--watch`) | Flag-schema drift is now caught by `--check-flags` rather than prevented |
| **Change Log** | v1 — initial capture of prototype decisions · v1.1 — name, no-LIVE and session premise confirmed · v1.2 — built; §10.1 and §10.2 resolved as built · v1.3 — NG4 revised: EDITOR is page 1 (§4.8), the eight ordinals replace seven | 2026-07-31 |

---

### TODOs for the requester

- `[TODO]` Name a DRI (single accountable owner) and a target date for §12.

Resolved 2026-07-31: name is `pinetop`; no LIVE page (§3 NG2); the §2 iterative-session
premise is confirmed. §10.1 and §10.2 are resolved as built; §10.3 and §10.4 remain open.
The tab ordinals are **eight**, not the seven this document previously called final: NG4 is
revised and EDITOR is page 1 (§4.2.d, §4.8).
