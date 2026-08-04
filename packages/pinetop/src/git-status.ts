import { spawn } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';

export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | '?' | 'U';

export interface GitStatusSnapshot {
  enabled: boolean;
  statuses: Record<string, GitFileStatus>;
}

export type GitStatusReader = (
  cwd: string,
  paths: readonly string[],
  signal?: AbortSignal,
) => Promise<GitStatusSnapshot>;

const GIT_TIMEOUT_MS = 1_500;
const GIT_OUTPUT_LIMIT = 1024 * 1024;
const EMPTY: GitStatusSnapshot = { enabled: false, statuses: {} };

/** Run one bounded, read-only Git query. Git is optional at runtime. */
function captureGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted === true) return Promise.resolve(null);

  return new Promise((resolveCapture) => {
    let settled = false;
    let output = '';
    let outputBytes = 0;
    let child: ReturnType<typeof spawn>;

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveCapture(value);
    };

    const onAbort = (): void => {
      child.kill('SIGTERM');
      finish(null);
    };

    try {
      child = spawn('git', ['-C', cwd, ...args], {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolveCapture(null);
      return;
    }

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, GIT_TIMEOUT_MS);
    timer.unref?.();

    const stdout = child.stdout;
    if (stdout == null) {
      child.kill('SIGTERM');
      finish(null);
      return;
    }
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > GIT_OUTPUT_LIMIT) {
        child.kill('SIGTERM');
        finish(null);
        return;
      }
      output += chunk;
    });

    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? output : null));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function displayStatus(xy: string): GitFileStatus | undefined {
  const x = xy[0] ?? ' ';
  const y = xy[1] ?? ' ';
  if (xy === '??') return '?';
  if (xy === '!!') return undefined;
  if (
    x === 'U' ||
    y === 'U' ||
    xy === 'AA' ||
    xy === 'DD' ||
    xy === 'AU' ||
    xy === 'UA' ||
    xy === 'DU' ||
    xy === 'UD'
  ) {
    return 'U';
  }
  if (x === 'R' || y === 'R' || x === 'C' || y === 'C') return 'R';
  if (x === 'A' || y === 'A') return 'A';
  if (x === 'D' || y === 'D') return 'D';
  if (x !== ' ' || y !== ' ') return 'M';
  return undefined;
}

/**
 * Read porcelain status only for files visible in the editor.
 *
 * Keys in the returned map are the caller's original paths. Porcelain uses NUL
 * records so spaces, tabs, newlines, quoting, and renames remain unambiguous.
 */
export const readGitStatus: GitStatusReader = async (cwd, paths, signal) => {
  const rootOutput = await captureGit(cwd, ['rev-parse', '--show-toplevel'], signal);
  if (rootOutput == null) return EMPTY;
  const root = rootOutput.replace(/\r?\n$/, '');
  if (root === '') return EMPTY;

  const keyByAbsolute = new Map<string, string>();
  const pathspecs: string[] = [];
  for (const path of paths) {
    const absolute = resolve(cwd, path);
    const fromRoot = relative(root, absolute);
    if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) continue;
    keyByAbsolute.set(absolute, path);
    pathspecs.push(fromRoot);
  }

  if (pathspecs.length === 0) return { enabled: true, statuses: {} };

  const output = await captureGit(
    root,
    [
      '--literal-pathspecs',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignored=no',
      '--',
      ...pathspecs,
    ],
    signal,
  );
  if (output == null) return EMPTY;

  const statuses: Record<string, GitFileStatus> = {};
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record == null || record.length < 4) continue;
    const xy = record.slice(0, 2);
    const marker = displayStatus(xy);
    const porcelainPath = record.slice(3);
    const absolute = resolve(root, porcelainPath.split('/').join(sep));
    const key = keyByAbsolute.get(absolute);
    if (key != null && marker != null) statuses[key] = marker;

    // In porcelain v1 -z, rename/copy records carry the original path as one
    // additional NUL field; the first path above is the current destination.
    if (xy.includes('R') || xy.includes('C')) i += 1;
  }

  return { enabled: true, statuses };
};
