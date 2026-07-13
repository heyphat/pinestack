#!/usr/bin/env bun
/**
 * Build pinerun as a standalone, dependency-free executable (Bun runtime + all
 * deps + the worker entrypoint baked in — users just download and run).
 *
 *   bun run build:bin                 build for THIS machine   → dist/pinerun
 *   bun run build:bin linux-x64       build one target         → dist/pinerun-linux-x64
 *   bun run build:bin all             build every target       → dist/pinerun-<target>[.exe]
 *   bun run build:bin --list          show supported targets
 *
 *   --install[=<dir>]  after a host build, copy the binary onto your PATH so you
 *                      can run `pinerun` from anywhere. Defaults to $PINERUN_INSTALL_DIR,
 *                      then ~/.local/bin. Only valid for host builds.
 *
 * Targets accept an optional variant suffix (musl / baseline / modern), e.g.
 * `linux-x64-musl` for Alpine or `linux-x64-baseline` for pre-2013 CPUs.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'packages/pinerun/src/cli.ts');
// The worker pool spawns this module at runtime; it MUST be a second compile
// entrypoint or `pinerun sweep/scan` dies with ModuleNotFound (see pool.ts).
const WORKER = join(ROOT, 'packages/pinerun/src/worker-entry.ts');
const OUT_DIR = join(ROOT, 'dist');

// `--local` bundles against the sibling ../piner source checkout instead of the
// installed (registry) @heyphat/piner — for engine changes that aren't published
// yet (e.g. PortfolioEngine). See useLocalPiner().
const PINER_DIR = join(ROOT, '..', 'piner');
const PINERUN_TSCONFIG = join(ROOT, 'packages/pinerun/tsconfig.json');

// Baked into the binary so `pinerun --version` self-reports (see cli.ts's
// PINERUN_VERSION / PINERUN_REVISION declares). Version comes from the package
// manifest — the single source of truth — and the revision from git (best effort).
const PKG_VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'packages/pinerun/package.json'), 'utf8')) as {
    version: string;
  }
).version;

function gitRevision(): string | null {
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();
  } catch {
    // not a git checkout (e.g. a source tarball) — version alone still reports
  }
  return null;
}

const REVISION = gitRevision();

const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'];
const VARIANTS = ['musl', 'baseline', 'modern'];

const HOST_OS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
};
const HOST_ARCH: Partial<Record<NodeJS.Architecture, string>> = { x64: 'x64', arm64: 'arm64' };

function hostTarget(): string {
  const os = HOST_OS[process.platform];
  const arch = HOST_ARCH[process.arch];
  if (!os || !arch)
    fail(`unsupported host ${process.platform}/${process.arch} — pass a target explicitly`);
  return `${os}-${arch}`;
}

/** "linux-x64-musl" → { base: "linux-x64", full: "bun-linux-x64-musl" }, validated. */
function parseTarget(raw: string): { base: string; full: string } {
  const t = raw.replace(/^bun-/, '');
  const base = TARGETS.find((b) => t === b || VARIANTS.some((v) => t === `${b}-${v}`));
  if (!base)
    fail(`unknown target "${raw}" — supported: ${TARGETS.join(', ')} (+ -musl/-baseline/-modern)`);
  return { base: base!, full: `bun-${t}` };
}

async function build(target: { base: string; full: string }, forHost: boolean): Promise<string> {
  const ext = target.base.startsWith('windows') ? '.exe' : '';
  // Host builds get the bare name (drop-in for local use); cross builds are suffixed.
  const outfile = join(
    OUT_DIR,
    forHost ? `pinerun${ext}` : `pinerun-${target.full.slice(4)}${ext}`,
  );
  const args = ['build', '--compile', `--target=${target.full}`, CLI, WORKER, '--outfile', outfile];
  // --define values are JS expressions, hence JSON.stringify to quote them.
  args.push('--define', `PINERUN_VERSION=${JSON.stringify(PKG_VERSION)}`);
  if (REVISION) args.push('--define', `PINERUN_REVISION=${JSON.stringify(REVISION)}`);
  console.log(`\n→ ${target.full}`);
  const proc = Bun.spawn(['bun', ...args], { stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) fail(`build failed for ${target.full}`);
  const size = Bun.file(outfile).size;
  console.log(`  ${outfile} (${(size / 1024 / 1024).toFixed(0)} MB)`);
  return outfile;
}

/** Resolve where `--install` should drop the binary. */
function installDir(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.PINERUN_INSTALL_DIR) return process.env.PINERUN_INSTALL_DIR;
  return join(homedir(), '.local', 'bin');
}

/** Copy the freshly built host binary onto the user's PATH. */
function install(srcfile: string, dir: string): void {
  const ext = srcfile.endsWith('.exe') ? '.exe' : '';
  const dest = join(dir, `pinerun${ext}`);
  mkdirSync(dir, { recursive: true });
  copyFileSync(srcfile, dest);
  if (!ext) chmodSync(dest, 0o755); // Bun.build's exec bit isn't preserved by copyFileSync
  console.log(`\n✓ installed → ${dest}`);
  if (!pathContains(dir)) {
    console.log(`  ⚠ ${dir} is not on your PATH. Add it, e.g.:`);
    console.log(`      export PATH="${dir}:$PATH"`);
  } else {
    console.log('  Run it from anywhere: pinerun --help');
  }
}

/** Is `dir` already present in $PATH? */
function pathContains(dir: string): boolean {
  const sep = process.platform === 'win32' ? ';' : ':';
  return (process.env.PATH ?? '').split(sep).includes(dir);
}

function fail(msg: string): never {
  console.error(`build-bin: ${msg}`);
  process.exit(1);
}

/**
 * Point the build at the sibling ../piner checkout instead of the installed
 * registry package: rebuild piner from source, then add a tsconfig `paths`
 * override that bun's bundler honors (and which wins over node_modules). The
 * paths target piner's dist/index.js directly, so the bundler never walks piner's
 * node_modules — which is what ELOOPs a `file:` install of the sibling checkout.
 * The tsconfig is restored on exit, including the process.exit() a build failure
 * triggers (which skips a finally), so the tracked file never stays patched.
 */
async function useLocalPiner(): Promise<void> {
  if (!existsSync(PINER_DIR)) {
    fail(`--local: no piner checkout at ${PINER_DIR} (expected a sibling ../piner)`);
  }
  console.log(`\n→ --local: rebuilding piner at ${PINER_DIR}`);
  const proc = Bun.spawn(['bun', 'run', 'build'], {
    cwd: PINER_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await proc.exited) !== 0) fail('--local: piner build failed');

  // Absolute paths + baseUrl: a relative `paths` target through this tsconfig's
  // `extends` chain does NOT reliably override an installed dep in bun 1.2.5, but
  // an absolute one does.
  const original = readFileSync(PINERUN_TSCONFIG, 'utf8');
  const dist = join(PINER_DIR, 'dist');
  const cfg = JSON.parse(original);
  cfg.compilerOptions ??= {};
  cfg.compilerOptions.baseUrl ??= '.';
  cfg.compilerOptions.paths = {
    '@heyphat/piner': [join(dist, 'index.js')],
    '@heyphat/piner/*': [join(dist, '*')],
  };
  writeFileSync(PINERUN_TSCONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`  bundling @heyphat/piner from ${dist} (tsconfig paths override)`);

  const restore = (): void => {
    try {
      writeFileSync(PINERUN_TSCONFIG, original);
    } catch {
      // best effort — nothing useful to do if the restore write fails
    }
  };
  process.on('exit', restore);
  process.on('SIGINT', () => {
    restore();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    restore();
    process.exit(143);
  });
  // Not covered: SIGKILL / power loss (nothing can run) and two concurrent
  // --local builds racing the same tsconfig — `git checkout` it if that happens.
}

const argv = process.argv.slice(2);

// Extract the --install[=<dir>] flag from the positional target arg.
let installFlag = false;
let installTarget: string | undefined;
let localFlag = false;
const positional: string[] = [];
for (const a of argv) {
  if (a === '--install') installFlag = true;
  else if (a.startsWith('--install=')) {
    installFlag = true;
    installTarget = a.slice('--install='.length);
  } else if (a === '--local') localFlag = true;
  else positional.push(a);
}

const arg = positional[0];
if (arg === '--help' || arg === '-h') {
  console.log('usage: bun run build:bin [<target> | all | --list] [--local] [--install[=<dir>]]');
  console.log('       (no target = this machine; --install copies a host build onto your PATH)');
  console.log(
    '       --local: bundle the sibling ../piner checkout instead of the registry version',
  );
} else if (arg === '--list') {
  console.log(TARGETS.join('\n'));
} else {
  if (localFlag) await useLocalPiner();
  if (arg === 'all') {
    if (installFlag) fail('--install only applies to host builds, not `all`');
    for (const t of TARGETS) await build(parseTarget(t), false);
    console.log('\nAll targets built.');
  } else {
    const forHost = arg == null;
    if (installFlag && !forHost) fail('--install only applies to the host build (omit the target)');
    const outfile = await build(parseTarget(arg ?? hostTarget()), forHost);
    if (forHost) {
      if (installFlag) install(outfile, installDir(installTarget));
      else {
        console.log('\nRun it: ./dist/pinerun --help');
        console.log(`Or add dist to your PATH:  export PATH="${OUT_DIR}:$PATH"`);
        console.log('Or install it onto your PATH:  bun run build:bin --install');
      }
    }
  }
}
