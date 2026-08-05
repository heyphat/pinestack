# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The `pinerun` CLI and the `pinetop` TUI are distributed as prebuilt,
self-contained binaries (see the README). The workspace packages run from
TypeScript source and version in lockstep with the release tag; publishing the
libraries to npm remains a possible follow-up.

## [Unreleased]

pinelive only — nothing in `pinerun`, `pinetop`, or `pinery` changes here. The
breaking pinelive changes below make whichever release carries them a **minor**
bump; they are deliberately not part of 0.9.1. The `pinelive` binary is an
explicit `PINESTACK_BINS` opt-in and its built-in Tiger transport stays blocked
for armed production, so the work below is on `main` and in the opt-in binary
without being announced as a release.

### Added

- **Pinelive armed-Tiger production-safety gates and operations.** The
  armed-production contract is now explicitly `configVersion: 3` and uses one
  durable `schemaVersion: 3` event ledger for account claims, execution
  eligibility, effects, and terminal reconciliation. Cooperative same-host
  account/exact-instrument exclusion uses boot-bound, non-stealable ownership;
  ordinary startup never takes over an existing artifact. Broker adapters must
  provide complete venue bootstrap and snapshot/stream synchronization, with
  broker-connected monitor/blocked postures and a composite lease/claim/stream
  interlock rechecked immediately before broker mutation. Possibly sent effects
  remain durable and are never retransmitted without `definitely-not-sent`
  proof. Read-only `pinelive status` and explicit `pinelive recover --confirm`
  commands share an administrative mutex with ordinary startup; recovery uses
  conservative process-instance proof, refuses unresolved effects, and
  quarantines stale artifacts for audit. Uncertain stable-storage
  acknowledgement of lease/account-claim acquisition now retains every physical
  ownership layer, with exact same-process recovery for an otherwise unrecorded
  claim. Failed pre-journal validation restores stale administrative evidence
  through a no-clobber operation, so a concurrent owner is never overwritten.
  The tracked
  [production-safety runbook](./docs/pinelive-production-safety.md) documents
  file layout, incident recovery, crash-resumable terminal reconciliation, and
  an opt-in credentialed mutation-free ambiguity restart test. Explicit
  recovery replaces stale enabled eligibility with a blocked transition. The
  built-in official Tiger transport remains deliberately **blocked** for armed
  production execution because the SDK cannot prove complete open-order
  inventory, authoritative exact absence, or snapshot/account-stream gap
  closure.

### Changed (breaking)

- **`configVersion: 3` is the only accepted pinelive config.** The flat v1
  config format (top-level `order`, `resolveSecurity`, `securityWarmupBars`,
  `maxSecurityBars`, `maxSecurityFeeds`, `securityConcurrency`,
  `securityRequestTimeoutMs`, `maxSecurityStaleRefreshes`, …) is removed, and
  any other `configVersion` is rejected with an error. The sectioned shape
  (`live` / `historical` / `security` / `execution` / `alerts`) carries over
  from `configVersion: 2` unchanged — migrating a v2 file is renumbering the
  field; migrating a v1 file means adopting the sectioned format.
- **One durable `schemaVersion: 3` event ledger.** The v1 forward-record
  ledger and the v2 cycle ledger are gone: `LedgerRecord` is now the v3 event
  alone, the v1/v2 record types (`ForwardRecord`, `BindingRecord`,
  `StartupRecord`, `AlertDispatchRecord`, `SecurityFeedHealthRecord`) leave
  the API, and Pine alerts journal only as v3 `alert` events. A v1/v2 ledger is
  no longer replayable — close out (flatten and stop) any run still on an old
  format with the binary that wrote it before upgrading.
- **The legacy v1 forward runner and server are removed.** `ForwardRunner`,
  `runForwardServer`, and the standalone `request.security` planning surface
  (`SecurityFeedManager`, `planSecurityFromStatic`, `planSecurityFromRequests`,
  `discoverSecurityRequests`, and their option/health types) leave the public
  API; the intrabar runner/server is the only runtime and hosts the security
  machinery internally. Surviving names drop their version suffix:
  `createV2ComputeInstrumentBinding` → `createComputeInstrumentBinding`,
  `V2ExecutionPolicyBinding` → `ExecutionPolicyBinding`, `recoverLedgerV3` →
  `recoverLedger`, `assertLedgerEventV3` → `assertLedgerEvent`, and the
  `Normalized…V2RunConfig` types lose the `V2`.
- **`createNodeTigerBroker` requires the execution-safety guard by default.**
  The Node Tiger factory now defaults `requireExecutionSafety: true`: armed
  mutation is refused until the runtime installs an account-claim and
  synchronization guard. Opting out takes an explicit
  `requireExecutionSafety: false`.

## [0.9.4] - 2026-08-05

### Added

- **`pinetop` BACKTEST tearsheet: drawdown, distribution, and trade-quality
  analysis.** The right-hand TEARSHEET pane now uses its free width and
  height for analysis beyond the scalar metric rail:
  - **TRADE P/L DISTRIBUTION** — the closed-trade profit histogram, colored
    green/red per bucket, sized to the available rail width.
  - **RETURN BY HOLD** — closed trades grouped into holding-duration
    quantile buckets (longest at top, shortest at bottom), each row showing
    median return, a magnitude bar, win rate, and sample count. Buckets never
    split an equal duration, and the longest bucket is open-ended so a single
    outlier trade cannot distort the scale.
  - **MFE / MAE DENSITY** — a density heatmap of each trade's maximum
    favorable/adverse excursion (percent of entry notional), clipped at the
    95th percentile per axis and colored by each cell's majority realized
    outcome.
  - **ROLLING SHARPE** — an annualized risk-adjusted equity-return chart that
    shares the third CHARTS slot with DRAWDOWN; focus CHARTS and use `j`/`k` to
    switch views. Its bar-count window adapts to roughly one fifth of the
    available contiguous return history, clamped to 14–30 bars, so it works on
    short backtests without assuming a calendar span.
  - **TOP DRAWDOWNS** — the CLI's peak → trough → recovery episode table,
    now rendered in the TUI across the full tearsheet width whenever height
    allows, below the metrics and the panes above.
    All five are read from the existing `pinerun backtest --json` payload; no
    output-contract change. They degrade by omission (never by clipping a date,
    duration, or axis) on narrower or shorter terminals.
- **`pinerun` gains reusable trade-diagnostic and rolling-risk renderers.** New pure,
  width/height-bounded `durationReturnAscii`, `maeMfeAscii`, and
  `rollingSharpeAscii` builders are exported alongside the existing
  `topDrawdownsAscii` and `profitHistogramAscii`, together with
  `TradeDiagnosticOptions`, `RollingSharpeChartOptions`, and the adaptive
  window helper. They back the new `pinetop` panels above and are usable
  directly from `@heyphat/pinerun` by anything building on the library.

## [0.9.3] - 2026-08-04

`pinetop` only — no `pinerun`, `pinery`, or `pinelive` behaviour changes, and no
`--json` contract moves.

### Added

- **The shell column's width is adjustable.** In `ctrl-t` mode, `>` and `<` grow
  and shrink the pane four columns at a time and `=` returns it to the
  responsive default. The choice lasts for the pinetop session, and growth is
  clamped so the source buffer never drops below the 45 columns it would have
  had when the pane first fit.

- **EDITOR's FILES pane now includes a project tree, Markdown, and Git state.**
  Lowercase `.pine` and `.md` files are grouped into expandable folder rows;
  `j`/`k` moves through visible rows, `↵` toggles folders or opens files, and
  `←`/`→` navigates parents and children. Markdown is rendered as plain text and
  remains excluded from runnable strategy and `input()` discovery. In a Git
  worktree, FILES shows a changed count plus per-path `M` / `A` / `D` / `R` / `?`
  / `U` badges; a collapsed folder retains a dot and hidden-change count, while
  the existing final `+` continues to mean an unwritten in-memory buffer. Git
  detection is asynchronous, bounded, and disappears cleanly outside
  repositories; full hunks remain available in the adjacent shell via
  `git diff`.

- **FILES and every command-page STRATEGIES picker are searchable in place.** An
  always-visible row accepts `/`, live case-insensitive file-name or relative-path
  filtering, `ctrl-u` to clear, `↵` to keep the filter, and `esc` to remove it.
  Matching FILES ancestors open temporarily without changing collapsed-folder
  state, while the Pine-only STRATEGIES query follows the user across all six
  command pages. STRATEGIES is one row taller so the new field does not reduce
  the useful script list.

### Removed

- **The unused Ask drawer and global `a` binding are gone.** The packaged CLI
  never configured an Ask provider, so the drawer could only open a dead prompt.
  Interactive assistants now run in the editor's shell pane instead; shared
  pending config edits and `ctrl-x` rollback remain available.

### Fixed

- **The shell pane can no longer trap focus inside a full-screen CLI.** Claude,
  Codex, Kiro, vim and similar programs keep their own `esc` and plain `tab`,
  while `ctrl-t` then `tab` now moves to the next Pinetop pane and `ctrl-t` then
  `shift-tab` moves to the previous one. The border, hint strip and help now show
  the complete sequence instead of implying that `ctrl-t` or plain `tab` leaves.

- **Scrolling a full-screen program in the shell pane now scrolls the program.**
  The alternate screen keeps no terminal history, so SCROLL mode's keys used to
  do nothing under `claude`, `vim` or `htop`. When the child negotiated SGR
  mouse tracking, `k`/`j`/`u`/`d` in `ctrl-t` mode are now delivered as the
  wheel gestures it asked for, and the program moves through the history it
  owns — the border reads `APP SCROLL` and the hint strip swaps to `app line` /
  `app page`. A full-screen child without mouse tracking shows `CONTROL`
  instead: the width keys and the exits still work, and everything else resumes
  the child.

- **A program in the shell pane no longer shares pinetop's controlling
  terminal.** The child is now spawned into its own session, so a nested
  `ctrl-c` can no longer trip job control on the outer terminal and stop both
  the shell and the program it was running.

## [0.9.2] - 2026-08-04

`pinetop` only — no `pinerun`, `pinery`, or `pinelive` behaviour changes, and no
`--json` contract moves.

### Added

- **A shell in the editor page.** `t` (or `ctrl-t`, which also reaches it from
  inside the vim buffer) opens your `$SHELL` as a third column beside the source:
  sidebar, buffer, terminal. It is a real terminal — `git diff`, a `pinerun`
  invocation typed by hand, `vim`, `htop` and `claude` all run in it with the
  script still on screen. Every keystroke goes to the child, `ctrl-c` included;
  `esc` leaves at a shell prompt, and `ctrl-t` then `tab` always leaves whatever
  the child is doing. `ctrl-d` or `exit` closes the column. It needs 108 columns
  of width and is dropped below that rather than crushing the buffer.

  No native module is involved, so the single-binary install is unchanged: the pty
  comes from the libc the OS already ships (reached through `bun:ffi`) and the VT
  parsing is `@xterm/headless`, which is pure JavaScript and bundles into the
  compiled binary.

- **Scrollback in the shell pane.** `ctrl-t` enters a sticky SCROLL mode —
  `k`/`j` by line, `u`/`d` by page, `g`/`G` for top and back to live — over 1000
  lines of history. The border reads `SCROLL ↑ 47` for as long as the mode lasts
  and the hint strip swaps to its keys. `esc` or `ctrl-t` resumes the child; any
  other key resumes it too and still reaches it, so picking up typing costs
  nothing. The alternate screen keeps no history, so the keys do nothing there,
  as in any terminal.

- **`t` on the hint strip**, next to `e`, `r` and `a`, on every page.

### Changed

- **The editor buffer now follows the file on disk.** Change the open `.pine`
  from the shell — `sed -i`, `git checkout`, a formatter — and the pane reloads
  it, keeping the cursor where it was. An _unwritten_ buffer is never
  overwritten: it reports `changed on disk — :e! to reload, :w to overwrite` and
  leaves your edits alone. A file deleted underneath you keeps its buffer, marked
  new, so `:w` puts it back.

- **The EDITOR buffer hands `ctrl-t` back to the frame**, alongside `tab`,
  `shift-tab`, `space` and `ctrl-p`, so the shell column is reachable from inside
  the buffer where a bare `t` is vim's till motion.

- **TERMINAL's pane accelerator is `[T]`**, shifted because `t` is now a global
  binding — the same rule that makes RANKED `[R]`.

- Removed `packages/pinetop/design.md`. The document had fallen behind the
  implementation, and one of its decisions (that an in-pane terminal was
  impossible without a native module) was no longer true.

### Fixed

- **Quitting no longer waits on the shell pane.** `q` now exits the way a signal
  already did, instead of returning and waiting for the event loop to drain. The
  emulator schedules timers of its own and a program run in the pane can leave a
  child behind; waiting for those made quitting hang for as long as they lived,
  after the frame had already gone.

- **Closing a shell pane no longer takes the program inside it down by luck.**
  Teardown now enumerates the child's descendants and signals each, escalating to
  `SIGKILL`. Signalling a process _group_ was not enough: that needs the child to
  be a group leader, and without `setsid` it is not, so `kill(-pid)` named no group
  and `claude` or `vim` kept running behind a closed pane.

## [0.9.1] - 2026-08-03

pinetop only — no change to `pinerun`, `pinery`, or any research output contract.
Two keybindings are **removed**: `s` and `w` no longer switch page, and the
letters they held now belong to the panes. `pinelive`'s armed-production work is
not in this release; it stays under Unreleased above, even though the other three
packages bump in lockstep with the tag.

### Added

- **Every pane has a key of its own, printed on its border.** `tab` still walks
  the focus ring, but reaching the sixth pane no longer costs five presses:
  STRATEGIES is `[s]`, HISTORY `[h]`, CHARTS `[ch]`. The keys are derived per page
  from the pane's name — the first letter, one letter more when two panes on the
  page want the same one (`[co]` CONFIG vs `[ch]` CHARTS, `[le]` LEDGER vs `[lo]`
  ENGINE LOG, `[st]` `[sl]` `[su]` on PORTFOLIO), and shifted when the app already
  claims that letter, so `r` still opens the run dialog (RANKED is `[R]`) and `e`
  still hands off to `$EDITOR` (the buffer pane is `[E]`). A half-typed key lights
  up the panes it could still reach and `esc` abandons it; the focused pane hides
  its badge so the columns go to its legend; `?` lists the set for the page you are
  on. Inside the EDITOR buffer the badges disappear, because there the buffer owns
  the keyboard. Nothing is hand-assigned, so a new pane gets a working key and
  cannot collide with an existing one (§4.2.h).

### Changed

- **No letter switches page any more — a page is its ordinal (§4.2.i).** `s` (open
  SWEEP with its run dialog) and `w` (open WALKFORWARD) are **removed**. They were
  the only letters that changed page, which left the keymap answering the same
  question two ways and BACKTEST — the page you come back to most — with no letter
  at all. `3` then `r` is what `s` was, in the two keystrokes every other command
  page already costs, and the freed letters go to the pane keys above. `w` also
  carried the sweep grid into walkforward, which is an edit rather than a
  navigation, so it moved to the command palette as **carry the sweep grid into
  walkforward** (`:` or `ctrl-p`); SWEEP's config pane now points at the palette
  instead of advertising `WF w`. `?` is generated from the keymap table, so the
  overlay dropped both rows with them.

### Fixed

- **BACKTEST's MONTHLY TRADES no longer reads as a pane you cannot reach.** On a
  terminal wide enough for both 99-column grids the strip draws two boxes for one
  pane, and only the left one carried the focus marker — so the trades grid looked
  like a pane no key could land on. Both halves now show the same pane key and both
  mark focus. (Narrower than that, the strip still shows one grid with `j`/`k`
  swapping which, as its legend says.)

## [0.9.0] - 2026-08-01

### Added

- **Pine `alert()` delivery in pinelive.** A strategy's `alert()` calls now reach
  registered notification channels, with the same host semantics as the fractal
  web app's TradingView-style alerting: warmup/replay alerts stay data, only
  fresh authoritative bar closes dispatch (forming revisions and recovered
  replays never do), a pure sample-time frequency gate (`all` /
  `once_per_bar` / `once_per_bar_close`, default close) keys per message, and
  every gated alert lands in the ledger with per-channel outcomes (new v1
  `alert` record and schema-v3 `alert` event, recovery-validated). Delivery is
  fail-open and bounded — per-alert send deadline, transient-only retries with
  linear backoff, and a per-bar cap journaled as `suppressed` — and can never
  delay a reconcile: trading always completes first. Ships with a `webhook`
  channel (fractal's delivery contract: coarse non-PII failure reasons, URL and
  headers never journaled or thrown) and a `telegram` channel (Bot API
  `sendMessage`; plain-text messages truncated to the 4096-char limit; honors
  `retry_after` on 429 rate limits; the bot token and chat id are construction
  secrets), configured via a new strict `alerts` config section shared by v1
  and v2, an `AlertChannel` protocol for custom channels, and
  `runAlertChannelConformance` in `@heyphat/pinelive/testing`.
  See [docs/pinelive-alerts.md](./docs/pinelive-alerts.md).

- **A standalone `pinelive` binary.** Releases now carry `pinelive` for the same
  five targets as `pinerun`/`pinetop`, stamped by `build-bin.ts` so
  `pinelive --version` self-reports, and self-updating via `pinelive upgrade`
  (the shared checksum-verified pinerun implementation). The `curl | sh`
  installer does **not** fetch it by default — opt in with
  `PINESTACK_BINS="pinerun pinetop pinelive"` — because the forward runner is
  the binary that can place orders: Paper remains its default broker and the
  Tiger adapters are offline-tested only, not sandbox- or production-approved.

- **Limit-order execution in pinelive.** `OrderRequest` now requires `limitPrice` for limit orders, and `PositionMirror` accepts an explicit market/limit policy with a side-aware tick offset from each closed-bar price. Market remains the default. Deterministic client ids now frame every identity component by length to prevent sanitizer and delimiter-boundary collisions; limit type/price are included in identity and schema-v2 cycle ledgers. Deploy the new ID format only with no unresolved old-format orders.
  - `PaperBroker` fills only immediately marketable limits and never violates the requested price or invents a resting order.
  - `TigerTradingTransport` gains a backward-compatible optional `submitLimit`; the official Tiger SDK adapter submits native futures `LMT` orders. Tiger limit mode requires cancellation support plus `cancelStuckOrders`, polls cancellation to terminal state, and blocks a second correction while any transmitted order remains unresolved. Flattening remains market-only.
  - CLI config adds `order.type`, `order.limitOffsetTicks`, and Tiger `orderPollIntervalMs`, `maxOrderPolls`, and `cancelStuckOrders` controls.

- **`request.security` in live forward runs.** The pinelive forward runner now
  resolves static dependencies and runtime inputs fixed for the life of the run,
  including cross-symbol, same-symbol other-timeframe, plain lower-timeframe, and
  `request.security_lower_tf` series. Call sites are deduplicated, fetched through
  the same pinery provider before warmup, and refreshed with explicit overlap and
  catch-up ranges before every closed chart tick. Self-references reuse the chart's
  exact resolved instrument.
  - Safety is fail-closed: resolution, timeout, insufficient warmup, truncated
    catch-up, history-cap, and refresh failures stop before reconciliation by
    default. Refresh failures and per-cycle health are ledgered; an explicit
    `maxSecurityStaleRefreshes` allows bounded tolerance.
  - Runtime dependencies that change after startup are detected after evaluation
    and stop before broker reconciliation instead of silently trading on `na`.
  - Provider work is bounded by feed count, concurrency, request timeout, and a
    non-truncating history ceiling. Timed-out operations retain their real slots
    until settlement; shutdown interrupts the provider and then either drains all
    such operations or reports a bounded cleanup failure. Existing timestamps are
    revision-aware and missed bars are repaired from an inclusive cursor.
  - New config/options: `resolveSecurity`, `securityWarmupBars`,
    `maxSecurityBars`, `maxSecurityFeeds`, `securityConcurrency`,
    `securityRequestTimeoutMs`, and `maxSecurityStaleRefreshes`.
  - Shared timeframe helpers live in `@heyphat/pinery`; pinerun and pinelive use
    the same finest-base planning rule for plain cross-symbol lower timeframes.

- **`@heyphat/pinelive` offline core** — a broker-SDK-free forward runner, Broker
  protocol, position mirror, deterministic CSV replay, idempotent PaperBroker with
  PnL accounting, append-only JSONL ledger, dry-run CLI, adapter conformance tools,
  and live-vs-backtest target parity utility. Official Tiger quote/trade adapters
  have injected offline SDK-facade coverage only; credentialed venue, demo-order,
  cancellation, and fill validation remain intentionally pending.

### Changed

- **pinetop page 8 renamed TRADES → LOGS.** The tab shows the engine log plus
  the fill ledger for the loaded run, and the old name misread as a trading
  surface. Keyboard ordinal (`8`), behavior, and panes are unchanged;
  `--page trades` remains an accepted alias for `--page logs`.

### Fixed

- **Pinelive safety-audit remediation.** An earlier pass fixed 17 findings across exact Tiger account/order identity, unresolved-order serialization, runtime order validation, Paper quantity handling, tiny quantity grids, futures roots/expiry, replay catch-up, primary and secondary warmup coverage, shutdown drainage, cache partitioning, strict timeframe identity, finer security-history ranges, truthful capabilities, and injective client ids.

- **Pinelive execution-safety fixes.** A later full-branch logic audit found and fixed one critical and two major defects plus hardening items:
  - Journal-only skipped evaluations (forming revisions, compute-only decisions) no longer consume the per-bar admission budget, so an every-update bar's authoritative close can no longer be starved by its own forming revisions and silently dropped. Refusing an authoritative final by `target-limit` now latches the execution breaker (new durable breaker reason `target-limit`) instead of passing silently. Ledger `targetOrdinal` semantics are unchanged; recovery additionally tracks the admitted count.
  - `TargetScheduler` and the compute-only journal prune finalized per-bar decision state to a bounded retention window (default 512 bars per binding; `retainBars` option), so multi-day forward runs no longer grow memory without bound. Durable rows are never pruned; bars with unresolved orders or unreset position uncertainty are always retained, and stale duplicates of pruned decisions are rejected fail-closed by the chart-update gate.
  - Live aggregation and duplicate-final dedupe compare volume with a relative 1e-9 tolerance (OHLC stays exact), so float-summation noise on fractional-volume venues can no longer spuriously abort a run as a data conflict.
  - Fallback decision/event identity hashing widened from 32-bit to 64-bit FNV-1a; canonical identity serialization now sorts by codepoint instead of locale; target-attainment checks use the same tolerant comparison as recovery, removing a redundant broker round trip per fractional fill; an unconfigured `TargetScheduler` now defaults to the shared fail-closed execution limits instead of unlimited; the instrument binding attests broker-supplied `pointValue` when the data provider reports none; and Paper's non-marketable-limit rejection names the limit and mark prices (calling out off-grid reference data).
  - A follow-up hardening pass extended the retention bound through degraded and restart paths: a protected bar (unresolved order or unreset position uncertainty) is now a bounded exception instead of blocking all pruning behind it, scheduler and compute-only recovery compact to the retention window immediately on restart and release the recovered ledger from memory, the compute journal fail-closes on decisions older than its retained dedupe horizon rather than ever reusing a durable identity, and a broker-only `pointValue` must be positive and finite before it is attested into the instrument binding.

## [0.8.0] - 2026-08-01

No change to `pinery` or to any output contract.

### Changed (breaking)

- **`pinetop`'s pages are renumbered.** EDITOR is page `1`, so every command page
  shifts by one: BACKTEST is now `2`, SWEEP `3`, WALKFORWARD `4`, SCAN `5`,
  PORTFOLIO `6`, COMPARE `7`, TRADES `8`. EDITOR goes first because the tabs are
  in workflow order and the source is where the workflow starts. `--page editor`
  is accepted alongside the existing names.

### Added

- **A Pine editor on page 1.** A vim-modal buffer for the `.pine` itself, so a
  stop that is wrong in the _script_ no longer sends you to another window and
  back to a stale report. The sidebar lists the project's scripts and the open
  one's `input()` titles; the buffer has a line-number gutter, Pine syntax
  colouring from your terminal's palette, and a vim status line.
  - Modes, motions and operators: `i I a A o O`, `h j k l w b e W B E`, `0 ^ $`,
    `gg G`, `{ }`, `f F t T`, `d c y > <` over any motion plus `dd cc yy`,
    `D C Y x X s p P J r`, visual and visual-line, `u` / `ctrl-r`, counts
    (`3dd`, `42G`, `d3w`), `/` `?` `n` `N`, and `:w :wq :q :q! :e :42 :set nu`.
  - The buffer owns the keyboard while it has focus, with two ways out that
    never move: `tab` leaves the pane and `ctrl-c` quits pinetop. `q` inside the
    buffer explains itself instead of quitting, and elsewhere warns once before
    discarding an unwritten buffer.
  - The INPUTS outline reads the buffer rather than the file, so a renamed
    `input()` title shows up before you save — and that is the same list
    `--input NAME` is validated against.
- **`e` hands the script to your real `$EDITOR`.** From any page: the frame
  suspends, `$VISUAL`/`$EDITOR`/`vim` opens the page's script at your cursor
  line, and the file is reloaded when it exits. Refuses when the in-frame buffer
  has unwritten changes to that same file.
- **`space` then a page number switches page**, everywhere including inside the
  editor buffer, where a bare digit is a vim count. `1`–`8` still work directly
  anywhere else.
- **A STRATEGIES pane on every command page**, not just BACKTEST — all six take a
  `.pine` as their first argument, and `↵` loads the selection into that page's
  command. COMPARE takes two, so it marks them `A` and `B` and fills the first
  free slot.
- **An INPUTS pane on SWEEP and WALKFORWARD** listing every `input()` the loaded
  script declares, with the swept ones marked and carrying their grid. `↵` opens
  one axis for typing, prefilled; clearing it drops that axis and leaves the rest
  alone. `--input` is repeatable, so the config pane could only show it as a
  single space-joined field — adding a second axis meant retyping the first.
- **A HISTORY pane on every command page** listing that page's runs from the
  session, newest first. `↵` puts one back on screen with the flags that produced
  it, so the config pane and the `$ pinerun …` line agree with the numbers and
  `r` repeats it. Twenty runs per command are kept.
- **A failed run gets a drawer** with every error line the engine printed, the
  exit code and the elapsed time, instead of one truncated line in the status
  bar. A run that exits zero but lost symbols — `scan`, `portfolio`, `sweep`
  reporting and continuing past a fetch failure — gets the same drawer in warn
  colour, because the report beside it was computed over what was left.

### Fixed

- **`pinerun scan` / `sweep` / `walkforward` could hang forever at startup**
  ([#12](https://github.com/heyphat/pinestack/issues/12)): a worker thread was
  occasionally created whose entry module never executed — no error, no exit,
  no output, ever. The pool now holds each job until its worker proves it is
  listening; a worker that misses that deadline (default 5 s, tunable via
  `PINERUN_WORKER_BOOT_TIMEOUT_MS`) is replaced and the job re-dispatched to a
  fresh thread, so a startup miss costs seconds instead of hanging. Repeated
  misses fail loudly with the reason instead of silently.
- **`pinetop`'s `?` overlay silently dropped bindings** once the table outgrew
  its fixed-height box. It now sizes itself from the keymap and splits into two
  columns on a short terminal.
- **Keys typed before the UI was ready were replayed as commands** when the
  alternate screen opened.
- **The narrow-terminal warning claimed the right rail had been dropped** on
  pages that have no right rail; it now names what the page actually loses.
- **`pinetop`'s tab bar no longer overprints the run status** on terminals too
  narrow for eight titles — below about 105 columns it names only the active page.

## [0.7.0] - 2026-07-31

### Added

- **`pinetop` — a terminal UI over the `pinerun` CLI.** A new workspace package
  (`@heyphat/pinetop`) that keeps a strategy's report resident on screen and makes
  the command's own flags the thing you edit, so the edit → rerun → reread loop
  happens in place instead of through repeated shell invocations and scrollback.
  It adds no analytics: every number comes from `pinerun --json`, and the braille
  charts and monthly grids are the CLI's own renderers, imported — so the screen
  and the printed command cannot disagree.
  - Seven pages in workflow order, `1`–`7`: BACKTEST, SWEEP, WALKFORWARD, SCAN,
    PORTFOLIO, COMPARE, and TRADES (the ledger + engine log for the loaded run).
  - Flags are editable in place: `tab` to the config pane, `↵` to edit a row,
    `.` to reveal the advanced ones. `r` then `↵` runs. Nothing runs, and nothing
    changes the config, without a keypress.
  - Flags a choice makes mandatory surface with it — `--provider csv` reveals
    `--data-dir` and the `--csv-*` assertions, and a csv run without a directory
    is refused before the spawn rather than failing on its first fetch.
  - The BACKTEST rail mirrors the CLI tearsheet's three sections (RETURNS, RISK,
    TRADES) row for row, with the CLI's labels and formatters; the monthly grids
    carry its green/red grading.
  - Workflow hand-offs: `w` carries a sweep grid into WALKFORWARD, `↵` on a
    ranked combo, a scanned symbol, or a portfolio sleeve deep-dives it in
    BACKTEST.
  - An opt-in Ask drawer (`a`) answers questions grounded in the loaded report and
    returns any recommended change as a reviewable parameter diff — `↵` applies,
    `ctrl-x` rejects, and an applied edit raises a "not yet re-run" banner until
    you re-run. It sends derived metrics only: never OHLCV bars, never script
    source, never credentials.
  - Per-project state in `.pinetop/`: saved flags, so reopening resumes where you
    were, plus a session log of every invocation with its exit code and duration.
  - `pinetop --check-flags` diffs its flag schema against `pinerun <cmd> --help`
    and exits non-zero on drift.
  - `pinetop --version` (also `-v` / `version`, matching the CLI) reports both its
    own version + commit **and** the `pinerun` it spawns — every number on screen
    came out of that binary, so a stale one on PATH explains a stale number. The
    same pair heads the `?` overlay.
  - `pinetop upgrade` (`--check` to just look) self-updates the installed binary
    in place, resolving the latest release, verifying the download's sha256
    against the release's `checksums.txt`, and swapping the executable
    atomically — the same implementation `pinerun upgrade` uses, asked to operate
    on the `pinetop` asset.

  See [`packages/pinetop/README.md`](./packages/pinetop#readme).

### Changed

- **Releases now ship both binaries.** A release carries 10 assets (`pinerun-*`
  and `pinetop-*`, 5 targets each) under one `checksums.txt`, and the workflow
  executes the built linux-x64 assets to assert each self-reports the tag before
  publishing. `scripts/build-bin.ts` grew `--product pinerun|pinetop` (defaulting
  to whichever package you run it from); existing `bun run build:bin` invocations
  are unaffected.
- **The installer installs `pinerun` and `pinetop`.** `PINESTACK_BINS` selects
  (default `"pinerun pinetop"`), alongside `PINESTACK_VERSION` and
  `PINESTACK_INSTALL_DIR`. The older `PINERUN_VERSION` / `PINERUN_INSTALL_DIR`
  names keep working.

## [0.6.1] - 2026-07-29

### Changed

- MONTHLY TRADES break-even tallies are now bare counts like wins and losses
  (`5/2/1` instead of `5/2/1E`): color alone tells the segments apart — wins
  green, losses red, evens uncolored — and the header legend reads
  `(win/loss/even)`.

## [0.6.0] - 2026-07-29

### Added

- **MONTHLY TRADES tearsheet table.** `backtest` and `portfolio` print a year ×
  month grid in the MONTHLY RETURNS layout tallying closed trades by exit month
  in win/loss/even order (`5/3`, `5/2/1E`; zero tallies are omitted), with a
  YEAR total column. Wins paint green and losses red on a TTY; evens keep an
  `E` suffix because they carry no color. Like the other stats tables it always
  prints, independent of `--no-chart`.
- **Exact CSV CLI evidence for Bar Magnifier and static security.** Every CSV
  leaf created by `--data-dir` now discovers canonical `<SYMBOL>_<TF>.csv`
  datasets for native or exactly aggregatable acquisition. `--csv-alignment
utc-24x7`, strict `--csv-week-anchor <YYYY-MM-DD|seconds>`, and
  `--csv-calendar <file.json>` provide explicit alignment evidence; strict
  calendar loading rejects unknown keys, unsafe intervals, and invalid
  `periods`. Claims work for `CSV:` symbols in mixed routing without making CSV
  the fallback provider, and duplicate/conflicting scalar options fail early.
- **Authenticated CSV complete-record semantics.** `--csv-complete-record`
  asserts that absent bars inside an explicit exact file's full record span mean
  no trades. The bars-only default is unchanged. Semantics and record spans are
  content- and identity-bound through native/aggregated acquisition, magnifier
  and static-security proofs, local/worker execution, and walk-forward prefix
  derivation. Bare fallback and empty files fail closed; requests and buckets
  crossing the record edge remain incomplete.

### Changed

- Repeating any scalar CLI option (for example `--symbol a --symbol b`) is now
  rejected with a `duplicate scalar option` error on every command instead of
  silently using the last value. The repeatable options (`--input`,
  `--input-a`/`--input-b`, `--weights`) are unchanged.
- Exact CSV documentation now distinguishes compatibility `history()` row
  normalization from strict exact acquisition, documents whole-second/grid and
  OHLCV validation, strict exchange calendars, mixed routing, and the risk of
  complete-record assertions. CLI help exposes the same evidence flags on every
  analysis command. Bar Magnifier docs now describe the shipped
  contract-capable piner 0.11.1 runtime (active-traversal reporting) instead of
  the pre-0.5.0 capability-rejection state.

## [0.5.0] - 2026-07-28

### Added

- **`--bar-magnifier` / `--no-bar-magnifier`** on `backtest`, `compare`,
  `scan`, `sweep`, and `walkforward` — TradingView's Bar Magnifier Properties
  toggle. Tri-state: absent → the `strategy()` header decides; `true`/`false`
  force it either way. When effective, historical no-COOF fills use **real
  lower-timeframe OHLC** acquired exactly by `pinery` (native target bars or
  provably aligned aggregation, coverage- and provenance-checked, newest-first
  toward TradingView's 200,000-target-bar limit) and injected into
  `@heyphat/piner`, whose report block is presented as authoritative —
  `fill model: bar magnifier` with per-run coverage, or an explicit
  requested-but-inactive line. Requires `@heyphat/piner` ≥ 0.11.1; an explicit
  override on an older engine fails with an actionable error.
  - **Exact mode fails closed.** Unknown provider alignment, incomplete
    required coverage, non-divisor timeframes, and off-grid chart opens are
    typed permanent failures — never a silent fallback, a clamped timeframe,
    or a dropped portfolio sleeve. Runtime-dynamic `request.security`
    identities (symbol/timeframe/lookahead not statically resolvable) are
    rejected with `dynamic-security-unsupported-with-bar-magnifier` across
    every command, including shared-account portfolios.
  - **Deterministic and transport-safe:** the resolved LTF dataset joins the
    strong content digest (memoized results can never alias across symbols,
    windows, feeds, or sessions), hydrates once per worker with
    authentication, and local and worker runs produce identical reports.
    Walk-forward rejects folds whose full IS+OOS envelope exceeds the 200k
    cap rather than silently ranking on differing suffixes.
  - Programmatic equivalents: `useBarMagnifier` on `Job`, `BacktestOptions`,
    `CompareOptions`, `ScanOptions`, `SweepOptions`, `WalkforwardOptions`;
    per-sleeve resolution for `portfolio` (no portfolio-wide CLI override).
  - Validated end-to-end against piner's 352-run PineForge differential
    corpus: the full CsvProvider → pinery aggregation → resolver → worker →
    piner pipeline reproduces the reference trades exactly, including
    sub-bar fill timestamps. **Proxy-validated partial support, not
    TradingView parity** — COOF, realtime, and risk/margin cadence keep the
    established chart-OHLC behavior.

  - **CSV exact acquisition:** the CLI now accepts explicit UTC or strict
    exchange-calendar evidence for `--data-dir` leaves, including mixed
    `CSV:` routing. Bars-only remains the default; callers may opt into the
    stronger authenticated complete-record assertion when their file producer
    guarantees it. Targets needing aggregation still fail with
    `incomplete-required-coverage` whenever the selected evidence cannot cover
    the complete requested envelope.

### Changed

- `@heyphat/piner` pinned to **0.11.1** (Bar Magnifier engine support and a
  stop-limit entry fill correction — far-side stop-limits no longer fill at
  untraded prices, so affected backtests report different, correct fills).
- CLI `--help` and error text now reference the embedded engine as 0.11.1.

## [0.4.0] - 2026-07-26

### Added

- **`--calc-on-order-fills` / `--no-calc-on-order-fills`** on `backtest`,
  `scan`, `sweep`, and `walkforward` — override the script's
  `calc_on_order_fills` declaration (TradingView's "After order is filled"
  Properties checkbox) without editing the source. Tri-state: absent → the
  `strategy()` header decides; `true`/`false` force it either way (also
  `--calc-on-order-fills=true|false`). Walk-forward applies the override to
  both the in-sample sweeps and each window's winner run. `portfolio` has no
  host override — the script header still applies there. Programmatic
  equivalents: `calcOnOrderFills` on `Job`, `BacktestOptions`, `ScanOptions`,
  `SweepOptions`, and `WalkforwardOptions`; the override joins the
  determinism key, so sweep/scan variants never share memoized results.
  Requires `@heyphat/piner` ≥ 0.10.0 (the engine that models the flag) — on
  an older engine an explicit override **fails with an actionable error**
  rather than running inertly; a source-declared header flag still runs
  (ignored) but is never reported as active. See
  [`docs/common-options.md`](./docs/common-options.md#fill-model--calc_on_order_fills).
- **Effective fill-model reporting** — `strategy.calcOnOrderFills` in JSON
  results and a `fill model: calc_on_order_fills` tearsheet line, read from
  the engine's actual state (never the requested configuration); walk-forward
  `--json` carries the marker per window as `calcOnOrderFills`. `portfolio`
  results intentionally carry no fill-model marker.

### Changed

- **`@heyphat/piner` pinned to 0.10.0** (was 0.9.0), and `@heyphat/pinerun`'s
  peer dependency floor is now `>=0.10.0`. piner 0.10.0 brings the
  TV-parity `calc_on_order_fills` engine (path-point fill model verified
  fill-for-fill and excursion-for-excursion against a TradingView export)
  plus chronological account marks, exposure-interval margin, and per-pass
  risk timing — see piner's 0.10.0 changelog. Flag-off backtest results are
  unchanged.

## [0.3.0] - 2026-07-19

### Added

- **CSV file provider** — run any command on local CSV files (exported exchange
  data, vendor downloads, synthetic series) instead of a live provider:
  - pinerun: `--provider csv --data-dir <dir>` serves every bare ticker from
    the directory; `CSV:TICKER` instrument addresses pull individual symbols
    from files inside a mixed universe (`CSV:AAPL,BI:BTCUSDT`). CSV history
    bypasses the on-disk cache — the files are the storage. See the new
    [`docs/csv-data.md`](./docs/csv-data.md) and the runnable sample data in
    `examples/data/`.
  - File layout: one `<SYMBOL>_<TF>.csv` per instrument (header
    `time,open,high,low,close,volume`, order-independent; unix seconds/millis
    or ISO times; RFC 4180-quoted fields accepted). A timeframe-less
    `<SYMBOL>.csv` fallback serves any timeframe only after its median bar
    spacing matches the request — wrong-resolution data errors instead of
    silently backtesting. An optional `instruments.csv` sidecar
    (`symbol,minQty,mintick`) supplies per-symbol lot step + tick size;
    malformed values fail the run with their line number rather than silently
    becoming defaults.
  - pinery: `CsvProvider` behind `@heyphat/pinery/node` (browser-safe core
    untouched); `csv` joins the provider registry with the `CSV:` address
    prefix; `InstrumentRouter` accepts pre-built provider instances via the
    new `providers` option.
- **`request.security` degradation warnings.** A dependency that fails to
  fetch still degrades to `na`/`[]` (one flaky dependency must not kill a
  100-symbol scan), but the CLI now prints a stderr warning naming the
  dependency and the underlying error instead of degrading silently — a
  strategy condition reading an unexpectedly-`na` series is otherwise
  invisible. Programmatic callers get an `onSecurityError` callback on
  `scan` / `backtest` / `portfolio` / `sweep` / `walkforward`.

### Changed

- `barsFromCsv` is stricter and more capable: RFC 4180-quoted fields, UTF-8
  BOM stripping, duplicate timestamps keep the last row (a re-export
  overwrites instead of doubling bars), and a malformed cell throws with its
  line number instead of producing NaN bars.

## [0.2.0] - 2026-07-15

### Changed (breaking)

- **piner engine `0.8.1` → `0.9.0`** — backtest **results change** for
  margin-enabled and derived-quantity (`cash` / `percent_of_equity`)
  strategies: the margin-call simulation now matches TradingView's broker
  emulator exactly (worst-extreme evaluation and fill, lot-step-truncated ×4
  liquidations, one-unit fallback, directional liquidation-price rounding),
  and derived order quantities truncate to the symbol's lot step. Verified
  against a 42-event TradingView margin-call ledger. See piner's 0.9.0
  changelog for the full details; pass `--min-qty 0` to disable quantity
  truncation.

### Added

- **Per-symbol instrument metadata** (`minQty` lot step + `mintick` tick size),
  fetched from the provider's exchange rules and applied to every run
  automatically:
  - pinery: optional `HistoryProvider.instrument(symbol)` — implemented for
    Binance (spot + USDⓈ-M futures `exchangeInfo`: `LOT_SIZE.stepSize`,
    `PRICE_FILTER.tickSize`), OKX (`/public/instruments`; swap lot steps
    convert via `ctVal` to base units), Kraken (`AssetPairs`), and the
    equities providers (whole-share lots), plus `StaticProvider.setInstrument`
    for tests. `cached()` caches instrument lookups on disk (daily-keyed).
  - pinerun: every command (backtest/scan/sweep/walkforward/portfolio)
    resolves the symbol's lot step and tick size before running — explicit
    `--min-qty` / `--mintick` flags override, provider metadata fills the
    gaps, piner defaults (0.001 / 0.01) remain the last resort. `--mintick`
    previously parsed but was only honored by `portfolio`; it now applies
    everywhere.

  The lot step drives piner ≥0.9's TV-parity quantity truncation (derived
  order sizes and margin-call liquidations truncate to the symbol's minimum
  contract size), so per-symbol resolution keeps multi-symbol scans honest —
  SOLUSDT perps trade in 0.01 steps, DOGE perps in whole contracts, spot BTC
  in 1e-5.

## [0.1.2] - 2026-07-15

### Fixed

- **Engine correctness (via `@heyphat/piner` 0.8.1).** Bumped the piner engine
  to pick up four Pine v6 conformance fixes that affect computed `scan` /
  `sweep` / `backtest` / `walkforward` / `portfolio` results:
  - String compound assignment (`s += "x"`) now concatenates instead of
    lowering to numeric addition (which produced `na` and could serialize
    `text` as `null`).
  - `==` / `!=` round float operands to nine fractional digits, so
    `0.1 + 0.2 == 0.3` is `true` (and `switch` subject matching inherits it).
  - `[]` floors a float offset (`close[2.9]` → `close[2]`); a non-finite
    offset reads `na`.
  - `±Infinity` is falsy in conditions.

## [0.1.1] - 2026-07-13

### Added

- **`pinerun upgrade`** — self-update the installed binary in place: resolves
  the latest GitHub release, downloads this platform's asset, verifies its
  sha256 against the release's `checksums.txt`, and atomically swaps the
  executable. `--check` only reports whether a newer release exists. (Binaries
  from v0.1.0 predate this command — re-run the install one-liner once to get
  it.)
- **`pinerun --version`** (also `-v` / `version`) — prints the CLI version and,
  in compiled binaries, the build commit (both injected at build time from the
  package manifest and git).

## [0.1.0] - 2026-07-13

First public open-source release.

### Added

- **`@heyphat/pinery` — the data layer.** OHLCV history providers implementing
  piner's `DataFeed` contract: Binance (spot + USDⓈ-M futures), OKX (spot +
  swap), Kraken spot, Alpaca US equities, Massive US equities, and an in-memory
  static/CSV provider. Canonical timeframe parsing + piner mapping, crypto pair
  normalization, a shared retrying JSON fetch, and a Node on-disk history cache
  behind `@heyphat/pinery/node`. Browser-safe core; Node built-ins stay behind
  the `/node` entry.
- **`@heyphat/pinerun` — the orchestration layer.** The `Job` model, the
  `jobHash` determinism key, the pure `executeJob` primitive, the `Runner`
  contract with an in-process `LocalRunner` and a `WorkerPoolRunner`
  (`node:worker_threads`), and the extractor/ranker grammar.
- **Milestone A — `scan`.** Fan one indicator or strategy across N symbols in
  parallel and rank the results (e.g. `--rank "last(rsi)" --top 3`).
- **Milestone B — `sweep`.** Run one strategy across a cartesian grid of input
  values on one symbol, in parallel, ranked — the same job core as `scan`.
- **Milestone C — `backtest`.** Single strategy × single symbol with
  risk-adjusted metrics (Sharpe/Sortino/Calmar, CAGR, exposure, buy & hold),
  trade/equity CSV export, and a self-contained equity + drawdown plot.
- **Milestone D — `walkforward`.** Per-window in-sample sweep → out-of-sample
  verdict with a walk-forward-efficiency aggregate — the anti-overfitting
  counterpart to `sweep`.
- **`portfolio`.** Run one strategy across N symbols against one shared pot of
  capital (piner's `PortfolioEngine`), with isolated and shared capital modes.
- **Terminal analytics suite** — tearsheet tables, `compare`, `watch`, and a
  PRICE terminal chart with trade markers.
- **`pinerun init`** — starter-strategy scaffolding.
- **Prebuilt CLI binaries** — `bun run build:bin all` cross-compiles the
  `pinerun` CLI for Linux/macOS (x64 + arm64) and Windows (x64) into single
  self-contained executables, a `curl | sh` installer (`scripts/install.sh`),
  and a tag-triggered release workflow that attaches them to a GitHub Release.
- Repository set up for open-source release: AGPL-3.0 `LICENSE`, contributing /
  security / conduct guides, issue & PR templates, and CI.

[unreleased]: https://github.com/heyphat/pinestack/compare/v0.9.4...HEAD
[0.9.4]: https://github.com/heyphat/pinestack/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/heyphat/pinestack/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/heyphat/pinestack/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/heyphat/pinestack/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/heyphat/pinestack/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/heyphat/pinestack/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/heyphat/pinestack/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/heyphat/pinestack/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/heyphat/pinestack/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/heyphat/pinestack/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/heyphat/pinestack/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/heyphat/pinestack/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/heyphat/pinestack/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/heyphat/pinestack/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/heyphat/pinestack/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/heyphat/pinestack/releases/tag/v0.1.0
