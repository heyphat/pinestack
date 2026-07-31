# pinetop

A terminal UI over the [`pinerun`](../pinerun) CLI. It keeps a strategy's report
resident on screen and makes the command's own flags the thing you edit, so the
**edit → rerun → reread** loop happens in place instead of through repeated shell
invocations and scrollback archaeology.

It adds no analytics of its own. Every number it shows comes from
`pinerun --json`; piner remains the sole authority for fills, timestamps, and
metrics.

See [design.md](./design.md) for the decisions behind it.

## Install

pinetop ships as a prebuilt, self-contained binary alongside `pinerun` — Bun
runtime and all dependencies baked in, nothing else to install. The pinestack
installer gets both:

```sh
curl -fsSL https://raw.githubusercontent.com/heyphat/pinestack/main/scripts/install.sh | sh
```

Set `PINESTACK_BINS` to pick (`"pinerun pinetop"` by default), `PINESTACK_VERSION`
to pin a tag, `PINESTACK_INSTALL_DIR` to choose the directory (default
`~/.local/bin`).

Update in place later, the same way `pinerun` does — it resolves the latest
release, verifies the download's sha256 against the release's `checksums.txt`, and
swaps the executable atomically:

```sh
pinetop upgrade           # download and replace
pinetop upgrade --check   # just look
```

### From a checkout

```sh
cd packages/pinetop
bun run build:bin --install     # → ~/.local/bin/pinetop
```

`--install` copies the host build onto your PATH (override with
`--install=<dir>` or `$PINETOP_INSTALL_DIR`). Drop `--install` to leave it in
`dist/pinetop`. Cross-compile with a target — `bun run build:bin linux-x64`, or
`all` for every platform; `--list` shows them.

To run straight from the source tree without building:

```sh
bun packages/pinetop/src/cli.ts
```

(`upgrade` refuses from source — there is no compiled binary to replace. Use
`git pull && bun run build:bin --install`.)

**pinetop needs `pinerun` on your PATH.** It shells out for every number it shows
(§4.1.a), and refuses to start if it cannot run `pinerun --version` — that check
happens before the alternate screen opens, so the message is readable. Build it
the same way if you have not already:

```sh
cd packages/pinerun && bun run build:bin --install
```

Or point at one explicitly: `pinetop --pinerun ./dist/pinerun`, or set
`$PINERUN_BIN`.

## Run

Just type it. Everything is configured in the UI — you never need to pass the
invocation on the command line:

```sh
pinetop
```

On a fresh project it loads the only `.pine` it finds (or points you at the
STRATEGIES pane if there are several), then names the two or three things left to
set. From there:

|              |                                                                                 |
| ------------ | ------------------------------------------------------------------------------- |
| `tab`        | move to the CONFIG pane                                                         |
| `j` / `k`    | pick a flag                                                                     |
| `↵`          | edit it in place — type, `↵` to accept, `esc` to abandon                        |
| `.`          | reveal the advanced flags (`--data-dir`, `--mintick`, the magnifier overrides…) |
| `r` then `↵` | run                                                                             |

Flags are saved per project, so the second launch is already configured.

Arguments are a shortcut, never a requirement:

```sh
pinetop strats/mean-rev.pine --symbol BTC-PERP --tf 1h   # preload some flags
pinetop --page sweep                                     # open on a page
pinetop --check-flags                                    # diff the flag schema vs pinerun --help
pinetop --version                                        # also -v, or bare `version`
```

`--version` reports two lines, because pinetop computes nothing — every number it
shows came out of whichever `pinerun` it spawned, so that binary's version is half
the answer:

```console
$ pinetop --version
pinetop 0.6.1 (2bf4f60)
pinerun 0.6.1 (2bf4f60)  — spawned for every run (pinerun)
```

The same pair is in the `?` overlay's header, so you can check it without
quitting. If a number looks stale, a stale `pinerun` on your PATH is the first
thing to rule out.

## Pages

One tab per command, numbered in workflow order.

| #   | Page        | Command                     | Purpose                                            |
| --- | ----------- | --------------------------- | -------------------------------------------------- |
| 1   | BACKTEST    | `pinerun backtest`          | Analyze — one strategy, one symbol, full tearsheet |
| 2   | SWEEP       | `pinerun sweep`             | Optimize — one script's input grid                 |
| 3   | WALKFORWARD | `pinerun walkforward`       | Validate — does the swept edge survive OOS         |
| 4   | SCAN        | `pinerun scan`              | Screen — one script across N symbols               |
| 5   | PORTFOLIO   | `pinerun portfolio`         | Combine — N symbols, one pot                       |
| 6   | COMPARE     | `pinerun compare`           | Compare — two strategies, same bars                |
| 7   | TRADES      | (ledger of the current run) | The fills and the engine log                       |

The workflow between them is navigation, not documentation: `w` on SWEEP carries
the grid into WALKFORWARD, `↵` on a ranked combo loads it into BACKTEST as fixed
inputs, `↵` on a scanned symbol or a portfolio sleeve deep-dives it.

## Keys

| Key                  | Action                                                                 |
| -------------------- | ---------------------------------------------------------------------- |
| `1`–`7`              | Switch page                                                            |
| `tab` / `shift-tab`  | Next / previous pane in the focus ring                                 |
| `j` / `k`, `↓` / `↑` | Move selection                                                         |
| `g` / `G`            | First / last row                                                       |
| `↵`                  | Edit the focused config flag · load selection · apply pending proposal |
| `r`                  | Run dialog for this page's command (`↵` on its RUN row runs)           |
| `s`                  | Sweep dialog                                                           |
| `w`                  | Walkforward page                                                       |
| `/`                  | Filter fills                                                           |
| `.`                  | Show / hide the advanced flags                                         |
| `ctrl-u`             | Clear the field being edited                                           |
| `a`                  | Ask (prompt drawer)                                                    |
| `:` or `ctrl-p`      | Command palette                                                        |
| `?`                  | Keybinding overlay                                                     |
| `esc`                | Dismiss overlay · clear filter · unscope log                           |
| `ctrl-x`             | Reject pending proposal · revert pending edits                         |
| `q`                  | Quit                                                                   |

`?` is generated from the keymap table, so it always documents the real
bindings. (The design names `⌘K` for the palette; a terminal cannot see it, so
`ctrl-p` is the binding.)

## How it behaves

- **Every flag is settable from the UI.** The config pane edits in place; `.`
  reveals the rarely-touched ones. Nothing requires dropping back to a shell —
  that round trip is the friction the tool exists to remove.
- **Flags a choice makes mandatory appear with it.** Set `--provider csv` and
  `--data-dir` (plus the `--csv-*` assertions) show up right beneath it; pick
  `alpaca` and you get `--feed` instead. The run dialog also refuses `csv`
  without a directory and puts the cursor on the row that fixes it, rather than
  letting the run fail on its first fetch.
- **The composed command is always on screen and always runnable.** The config
  pane, the `$ pinerun …` line, and the spawned process all come from one
  `FlagModel`. If the line on screen would not run, that is a bug.
- **Nothing runs without a keypress.** Editing a flag never schedules a spawn; a
  sweep can cost minutes and a keystroke should not spend them.
- **No scrolling.** Content that exceeds the frame truncates, the way a terminal
  truncates. Each page declares a min-width and degrades by dropping the right
  rail before truncating a table — and says what it dropped.
- **Charts are `pinerun`'s own.** The braille price/equity/drawdown trio and the
  monthly grids are the CLI's renderers, imported, so the screen and the printed
  command cannot disagree — including their colour grading: green gains / brick
  losses in MONTHLY RETURNS, green wins / red losses per tally in MONTHLY TRADES,
  and cyan-entry / green-win / red-loss trade markers on the price chart.
  Everything else uses the terminal's ANSI palette, so it respects your theme
  (§4.7).

## The Ask drawer

`a` opens a prompt over the bottom of the frame. The model answers in prose
grounded in the loaded run; if a parameter change is warranted it comes back
_additionally_, as a reviewable diff:

```jsonc
{
  "answer": "…prose grounded in the run…",
  "proposal": {
    "effect": "est. Sharpe 1.42 → 1.51 · max DD −17.2% → −12.8%",
    "note": "Tighter stop plus a hard time exit; entry logic untouched.",
    "edits": [{ "input": "stopAtr", "from": "2.4", "to": "1.8", "display": "2.4 ATR → 1.8 ATR" }],
  },
  "action": { "label": "open parameter sweep", "key": "s" }, // when no edit is warranted
}
```

`↵` applies, `ctrl-x` rejects — nothing is ever applied silently. Applied edits
show as pending with a marker and raise a "not yet re-run" banner until you press
`r`, because for a backtester an unexplained parameter change invalidates every
number on screen.

`edits[].input` must be a real Pine `input()` title and `to` a bare value; a
proposal that fails either check is refused before it can reach argv, with the
reason shown.

The layer is opt-in: pass an `AskProvider` to the `App`. It sends the report
summary and the flags — never OHLCV bars, never script source, never
credentials — and the drawer states when the model runs remotely.

## Privacy

Provider keys stay in the environment (`ALPACA_API_KEY_ID`,
`ALPACA_API_SECRET_KEY`, `MASSIVE_API_KEY`). `--api-key` / `--api-secret` are
deliberately absent from pinetop's flag schema: credentials never enter the UI,
are never persisted, and are redacted from the echoed command line and the
session log.

## Per-project state

`.pinetop/` beside the project holds:

- `flags.json` — the last session's flags, so reopening resumes where you were.
  Pending parameter edits are deliberately **not** persisted; a pending edit that
  survived a restart would be an unexplained divergence from the script on disk.
- `session.jsonl` — every spawned invocation with its exit code and duration, so
  any on-screen result can be reproduced outside the app.

## Keeping the flag schema honest

pinetop models `pinerun`'s flags by hand, which can drift. `--check-flags` diffs
the schema against the CLI's own help:

```sh
pinetop --check-flags
# flag schemas agree (6 commands; api-key, api-secret, json, help, version excluded by design)
```

## Development

```sh
bun test packages/pinetop/    # 156 tests
bunx tsc -b                   # typecheck
```
