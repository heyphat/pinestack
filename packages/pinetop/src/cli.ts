#!/usr/bin/env bun
/**
 * `pinetop` — the entry point.
 *
 * Boot order matters: the binary is probed before the alternate screen is
 * entered, because "pinerun is not on your PATH" is a message the user must be
 * able to read in their scrollback, not one that flashes past on a screen that
 * is about to be torn down.
 */

import { readFileSync } from 'node:fs';
import { emptyModel, type Pair } from './flags/model.js';
import { COMMANDS, PAGES, type CommandId, type PageId } from './flags/schema.js';
import { App, PAGE_MAP, bootstrap } from './app.js';
import { loadFlags } from './persist.js';
import { probePinerun, resolveBin } from './run/spawn.js';
import { initialState } from './state.js';
import { Terminal } from './terminal.js';

// Injected by scripts/build-bin.ts (`bun build --define`) so the compiled binary
// self-reports its release version + commit. Absent when running from source,
// where resolveVersion() falls back to this package's package.json — the
// compiled binary has no package.json on disk to read.
declare const PINETOP_VERSION: string | undefined;
declare const PINETOP_REVISION: string | undefined;

/** The CLI's version — the build define, else package.json (source runs). */
function resolveVersion(): string | undefined {
  if (typeof PINETOP_VERSION === 'string') return PINETOP_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/** "pinetop <version>[ (<commit>)]" for --version. Mirrors pinerun's own line. */
function cliVersion(): string {
  const revision = typeof PINETOP_REVISION === 'string' ? ` (${PINETOP_REVISION})` : '';
  return `pinetop ${resolveVersion() ?? 'unknown'}${revision}`;
}

/**
 * `--version` reports two lines, not one.
 *
 * pinetop computes nothing: every number on screen comes from whichever
 * `pinerun` it spawned. So "what version am I running" is only half answered by
 * pinetop's own version — the CLI it drives is the other half, and on a machine
 * with a stale binary on PATH and a fresh one in `dist/` that is exactly the
 * question you are asking. pinetop's line comes first and is unchanged in shape,
 * so a release check that greps for `pinetop X.Y.Z` still works.
 */
async function printVersion(bin: string): Promise<void> {
  console.log(cliVersion());
  const pinerun = await probePinerun({ bin });
  console.log(
    pinerun != null
      ? `${pinerun}  — spawned for every run (${bin})`
      : `pinerun not found at "${bin}" — set PINERUN_BIN or pass --pinerun <path>`,
  );
}

const USAGE = `pinetop — a terminal UI over the pinerun CLI

USAGE
  pinetop [script.pine] [options]        Open the TUI
  pinetop upgrade [--check]              Update pinetop to the latest release
  pinetop --version                      Print the version, and the pinerun it drives

OPTIONS
  --page <name>         Open on a page: ${PAGES.join(' | ')}
  --symbol <sym>        Preload --symbol on every command page
  --tf <1h>             Preload --tf
  --from <date>         Preload --from
  --to <date>           Preload --to
  --limit <n>           Preload --limit
  --input name=value    Preload a fixed input (repeatable)
  --pinerun <path>      The pinerun executable (default: $PINERUN_BIN, else PATH)
  --pinelive <path>     The pinelive executable for LIVE (default: $PINELIVE_BIN, else PATH)
  --check-flags         Diff pinetop's flag schema against pinerun --help, then exit
  -v, --version         Print the pinetop version, and the pinerun it drives
  -h, --help            This text

KEYS
  1–${PAGES.length} pages · tab panes · j/k move · r run · a ask · : palette · ? help · q quit
  Page 1 is a vim editor for the .pine itself: i inserts, :w writes, tab leaves.

NOTES
  Credentials are never entered here. Provider keys stay in the environment
  (ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY, MASSIVE_API_KEY) and are redacted
  from the echoed command line and the session log.

  Per-project state lives in .pinetop/ (flag state + a session log of every
  invocation, so any on-screen result can be reproduced outside the app).`;

interface ParsedArgs {
  scripts: string[];
  page?: PageId;
  preload: Record<string, string>;
  inputs: Pair[];
  bin?: string;
  pineliveBin?: string;
  help: boolean;
  version: boolean;
  checkFlags: boolean;
  /** `pinetop upgrade` — self-update the installed binary. */
  upgrade: boolean;
  /** `--check`: report whether a newer release exists, change nothing. */
  upgradeCheck: boolean;
}

/**
 * Bare-word subcommands, honoured only in first position — the same rule
 * `pinerun` dispatches on (it switches on `argv[0]`). Positional-only keeps
 * `pinetop version.pine` working as a script path.
 */
const BARE_WORDS: Record<string, 'help' | 'version' | 'upgrade'> = {
  help: 'help',
  version: 'version',
  upgrade: 'upgrade',
};

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    scripts: [],
    preload: {},
    inputs: [],
    help: false,
    version: false,
    checkFlags: false,
    upgrade: false,
    upgradeCheck: false,
  };

  const bare = argv[0] != null ? BARE_WORDS[argv[0]] : undefined;
  if (bare === 'help') out.help = true;
  if (bare === 'version') out.version = true;
  if (bare === 'upgrade') out.upgrade = true;

  for (let i = bare != null ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string | undefined => argv[++i];

    switch (arg) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '-v':
      case '--version':
        out.version = true;
        break;
      case '--check-flags':
        out.checkFlags = true;
        break;
      case '--check':
        out.upgradeCheck = true;
        break;
      case '--page': {
        const value = next();
        // 'trades' was page 8's name through 0.8.0; keep it as an alias.
        const name = value === 'trades' ? 'logs' : value;
        if (name != null && (PAGES as readonly string[]).includes(name)) out.page = name as PageId;
        break;
      }
      case '--pinerun':
        out.bin = next();
        break;
      case '--pinelive':
        out.pineliveBin = next();
        break;
      case '--input': {
        const value = next();
        if (value == null) break;
        const eq = value.indexOf('=');
        if (eq > 0) out.inputs.push({ name: value.slice(0, eq), value: value.slice(eq + 1) });
        break;
      }
      case '--symbol':
      case '--tf':
      case '--from':
      case '--to':
      case '--limit': {
        const value = next();
        if (value != null) out.preload[arg.slice(2)] = value;
        break;
      }
      default:
        if (!arg.startsWith('-')) out.scripts.push(arg);
        break;
    }
  }
  return out;
}

/**
 * §10.1's mitigation, made executable: diff the hand-written schema against the
 * CLI's own help text. Drift is then a command away from being noticed, rather
 * than something a user discovers when a flag silently does nothing.
 */
async function checkFlags(bin: string): Promise<number> {
  const { spawnSync } = await import('node:child_process');
  const { INTENTIONALLY_ABSENT, schemaFor } = await import('./flags/schema.js');
  let problems = 0;

  for (const command of COMMANDS) {
    const result = spawnSync(bin, [command, '--help'], { encoding: 'utf8' });
    const help = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0 && help.trim() === '') {
      console.error(`pinetop: could not read \`${bin} ${command} --help\``);
      return 1;
    }

    // Every long flag the help text names, both plain and `no-` forms — the CLI
    // spells a tristate as a pair (`--bar-magnifier` / `--no-bar-magnifier`) and
    // spells some booleans only negatively (`--no-chart`), so both belong here.
    const declared = new Set([...help.matchAll(/--([a-z][a-z0-9-]*)/g)].map((m) => m[1]!));
    const ours = new Set(schemaFor(command).flags.map((f) => f.name));

    /** A name is covered if the CLI names it, or names its `no-` counterpart. */
    const covered = (name: string): boolean =>
      declared.has(name) ||
      declared.has(`no-${name}`) ||
      (name.startsWith('no-') && declared.has(name.slice(3)));

    const missing = [...declared].filter(
      (name) =>
        !INTENTIONALLY_ABSENT.has(name) &&
        !ours.has(name) &&
        !(name.startsWith('no-') && ours.has(name.slice(3))),
    );
    const extra = [...ours].filter((name) => !covered(name));

    if (missing.length > 0 || extra.length > 0) {
      problems += 1;
      console.log(`${command}:`);
      if (missing.length > 0) console.log(`  in pinerun, not in pinetop: ${missing.join(' ')}`);
      if (extra.length > 0) console.log(`  in pinetop, not in pinerun: ${extra.join(' ')}`);
    }
  }

  if (problems === 0) {
    console.log(
      `flag schemas agree (${COMMANDS.length} commands; ` +
        `${[...INTENTIONALLY_ABSENT].join(', ')} excluded by design)`,
    );
  }
  return problems === 0 ? 0 : 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  // Self-update runs before anything touches the terminal or the project: it
  // replaces this executable and must not do that from behind an alt screen.
  // The implementation is pinerun's — same download, same mandatory sha256
  // check against the release's checksums.txt, same atomic swap — asked to
  // operate on the `pinetop` asset.
  if (args.upgrade) {
    const { runUpgrade } = await import('@heyphat/pinerun');
    await runUpgrade({
      check: args.upgradeCheck,
      currentVersion: resolveVersion(),
      binary: 'pinetop',
    });
    return process.exitCode === 1 ? 1 : 0;
  }

  const bin = resolveBin({ bin: args.bin });
  if (args.version) {
    await printVersion(bin);
    return 0;
  }
  if (args.checkFlags) return checkFlags(bin);

  // Probe before entering the alternate screen, so a failure is readable.
  const pinerunVersion = await probePinerun({ bin });
  if (pinerunVersion == null) {
    console.error(
      `pinetop: could not run \`${bin} --version\`.\n` +
        `  pinetop shells out to pinerun for every number it shows (design §4.1.a).\n` +
        `  Install it, or point at it with --pinerun <path> or PINERUN_BIN.`,
    );
    return 1;
  }

  const terminal = new Terminal();
  if (!terminal.isTTY) {
    console.error('pinetop: needs a terminal (stdin/stdout are not a TTY).');
    return 1;
  }

  const state = initialState(loadFlags());
  if (args.page != null) state.page = args.page;
  // Both versions reach the UI, so `?` can answer "what am I running" without
  // quitting — which matters most when a stale binary is the suspect.
  state.versions = { pinetop: cliVersion(), pinerun: pinerunVersion };

  // Preloads apply to every command that declares the flag, so opening on any
  // page finds the same window already set.
  for (const command of COMMANDS) {
    const model = state.flags[command] ?? emptyModel(command);
    const schema = (await import('./flags/schema.js')).schemaFor(command);
    for (const [name, value] of Object.entries(args.preload)) {
      if (!schema.flags.some((f) => f.name === name)) continue;
      model.values[name] = name === 'limit' ? Number(value) : value;
    }
    if (args.inputs.length > 0 && schema.flags.some((f) => f.name === 'input')) {
      model.values['input'] = args.inputs;
    }
    if (args.scripts.length > 0) {
      model.scripts = args.scripts.slice(0, schema.scripts);
    }
    state.flags[command] = model;
  }

  // With no argv and no saved state, make the empty screen a starting point
  // rather than a puzzle: load an unambiguous script and say what to do next.
  state.status = bootstrap(state) ?? state.status;

  const app = new App({
    terminal,
    state,
    spawn: { bin },
    live: args.pineliveBin ? { bin: args.pineliveBin } : undefined,
  });

  const shutdown = (): void => {
    state.quit = true;
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    app.start();

    // The app is key-driven; hold the process open until `q` or a signal requests shutdown.
    await new Promise<void>((resolve) => {
      const tick = setInterval(() => {
        if (state.quit) {
          clearInterval(tick);
          resolve();
        }
      }, 80);
    });
    return 0;
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await app.stop();
  }
}

/**
 * Guard so importing this module — for tests, or from the package barrel —
 * does not launch the UI.
 *
 * `import.meta.main` is the precise question ("was this module the entry
 * point?") and holds both under `bun run` and inside the compiled binary. The
 * previous check matched `process.argv[1]` against a filename suffix, which was
 * a coincidence away from being wrong: any entry path ending in `cli.ts` — a
 * test file, another package's CLI — would have launched the TUI.
 */
if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  }
}

export { PAGE_MAP };
export type { CommandId };
