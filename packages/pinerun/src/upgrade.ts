/**
 * `pinerun upgrade` — self-update the compiled binary in place from GitHub
 * Releases. The latest release is resolved via the `releases/latest` redirect
 * (no API rate limit), the platform asset is downloaded next to the current
 * executable, sha256-verified against the release's checksums.txt, and then
 * atomically renamed over the running binary — the running process keeps its
 * inode on POSIX; on Windows a running .exe can't be overwritten, so the old
 * file is moved aside first and cleaned up best-effort.
 *
 * Only the compiled binary self-updates: from a source checkout `process.execPath`
 * is the bun executable itself, which must never be overwritten.
 */
import { chmodSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

const REPO = 'heyphat/pinestack';
const RELEASES = `https://github.com/${REPO}/releases`;

/** Running inside a `bun build --compile` binary? (mirrors pool.ts) */
const COMPILED = import.meta.url.includes('/$bunfs/') || import.meta.url.includes('~BUN');

/** The release asset name for this platform, or null when no prebuilt exists. */
export function upgradeAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | null {
  const os =
    platform === 'darwin'
      ? 'darwin'
      : platform === 'linux'
        ? 'linux'
        : platform === 'win32'
          ? 'windows'
          : null;
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!os || !cpu) return null;
  if (os === 'windows' && cpu !== 'x64') return null; // only windows-x64 is published
  return `pinerun-${os}-${cpu}${os === 'windows' ? '.exe' : ''}`;
}

/** Numeric semver compare, `v` prefix tolerated: sign of a − b. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** ".../releases/tag/v0.2.0" → "v0.2.0" (the latest-release redirect target). */
export function tagFromLatestLocation(location: string): string | null {
  const m = /\/releases\/tag\/([^/?#]+)/.exec(location);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** Find `asset`'s sha256 in a checksums.txt body (`sha256sum` output format). */
export function checksumFor(checksums: string, asset: string): string | null {
  for (const line of checksums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m && m[2] === asset) return m[1]!;
  }
  return null;
}

/** Latest release tag, via the redirect GitHub serves for `releases/latest`. */
async function latestTag(): Promise<string> {
  const res = await fetch(`${RELEASES}/latest`, { redirect: 'manual' });
  const location = res.headers.get('location');
  const tag = location ? tagFromLatestLocation(location) : null;
  if (!tag) {
    if (res.status === 404) throw new Error(`no published releases found (${RELEASES})`);
    throw new Error(
      `could not resolve the latest release (HTTP ${res.status} from ${RELEASES}/latest)`,
    );
  }
  return tag;
}

export interface UpgradeOptions {
  /** Report whether a newer release exists; change nothing. */
  check: boolean;
  /** The running CLI's version (from the build define / package.json). */
  currentVersion?: string;
}

export async function runUpgrade(opts: UpgradeOptions): Promise<void> {
  const fail = (msg: string): void => {
    console.error(`upgrade: ${msg}`);
    process.exitCode = 1;
  };

  const asset = upgradeAssetName();
  if (!asset) {
    return fail(
      `no prebuilt binary for ${process.platform}/${process.arch} — build from source: bun run build:bin --install`,
    );
  }

  let tag: string;
  try {
    tag = await latestTag();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const latest = tag.replace(/^v/, '');
  const current = opts.currentVersion;

  console.log(`  current  ${current ?? 'unknown'}`);
  console.log(`  latest   ${latest}`);

  if (current != null) {
    const cmp = compareVersions(latest, current);
    if (cmp === 0) {
      console.log('\n  already up to date.');
      return;
    }
    if (cmp < 0) {
      console.log('\n  this build is ahead of the latest release (a dev build) — nothing to do.');
      return;
    }
  }
  if (opts.check) {
    console.log(`\n  update available — run: pinerun upgrade`);
    return;
  }

  if (!COMPILED) {
    return fail(
      'running from source — pull the repo and rebuild instead: git pull && bun run build:bin --install',
    );
  }
  const target = process.execPath;

  console.log(`\n  downloading ${asset} (${tag})…`);
  const res = await fetch(`${RELEASES}/download/${tag}/${asset}`);
  if (!res.ok)
    return fail(`download failed: HTTP ${res.status} — ${RELEASES}/download/${tag}/${asset}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  // Checksum verification is mandatory — every release ships checksums.txt.
  const sums = await fetch(`${RELEASES}/download/${tag}/checksums.txt`);
  if (!sums.ok) return fail(`could not fetch checksums.txt for ${tag} (HTTP ${sums.status})`);
  const expected = checksumFor(await sums.text(), asset);
  if (!expected) return fail(`checksums.txt for ${tag} has no entry for ${asset}`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    return fail(`checksum mismatch for ${asset}\n  expected ${expected}\n  got      ${actual}`);
  }
  console.log(`  ${(bytes.length / 1024 / 1024).toFixed(0)} MB downloaded, checksum verified`);

  // Stage in the target's own directory so the final rename is atomic
  // (same filesystem), then swap.
  const tmp = join(dirname(target), `.${basename(target)}.upgrade-${process.pid}`);
  try {
    writeFileSync(tmp, bytes);
    chmodSync(tmp, 0o755);
    if (process.platform === 'win32') {
      const old = `${target}.old`;
      try {
        unlinkSync(old); // clear a stale copy from a previous upgrade
      } catch {
        // none there — fine
      }
      renameSync(target, old);
      renameSync(tmp, target);
      try {
        unlinkSync(old);
      } catch {
        // still mapped while this process runs — a harmless leftover
      }
    } else {
      renameSync(tmp, target);
    }
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup only
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('EACCES') || msg.includes('EPERM')) {
      return fail(
        `no write permission for ${target} — re-run with sudo, or reinstall:\n` +
          `  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | sh`,
      );
    }
    return fail(`could not replace ${target}: ${msg}`);
  }

  console.log(`\n✓ upgraded ${current ?? '?'} → ${latest}  (${target})`);
  console.log('  verify: pinerun --version');
}
