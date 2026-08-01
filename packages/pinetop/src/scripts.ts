/**
 * Script discovery for the STRATEGIES pane.
 *
 * §3 NG4 — pinetop is not a Pine editor. It finds scripts and reloads them; the
 * user edits them elsewhere. `mtime` is tracked so the pane can mark a script
 * that changed on disk since the loaded run, which is the only honest way to
 * say "this report is stale" without reading the source.
 */

import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import { readInputTitles } from './flags/pine-inputs.js';

export interface ScriptEntry {
  /** Path as it will appear in argv — relative to cwd when it is below it. */
  path: string;
  /** Basename without the .pine extension, for the pane. */
  label: string;
  mtimeMs: number;
}

const SKIP = new Set([
  'node_modules',
  '.git',
  '.pinetop',
  '.pinery-cache',
  'dist',
  'build',
  'coverage',
  '.next',
]);

/**
 * Find `.pine` files, breadth-first, to `depth` directory levels. Bounded on
 * purpose: the pane shows a project's strategies, and walking a home directory
 * to find them would make startup unpredictable.
 */
export function discoverScripts(cwd = process.cwd(), depth = 3, limit = 200): ScriptEntry[] {
  const found: ScriptEntry[] = [];
  let frontier: { dir: string; level: number }[] = [{ dir: cwd, level: 0 }];

  while (frontier.length > 0 && found.length < limit) {
    const next: { dir: string; level: number }[] = [];
    for (const { dir, level } of frontier) {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP.has(entry.name) || level >= depth) continue;
          next.push({ dir: full, level: level + 1 });
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.pine')) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(full).mtimeMs;
        } catch {
          // Unreadable stat is not fatal — the path is still runnable.
        }
        const rel = relative(cwd, full);
        found.push({
          path: rel === '' || rel.startsWith('..') ? full : rel,
          label: entry.name.replace(/\.pine$/, ''),
          mtimeMs,
        });
        if (found.length >= limit) break;
      }
      if (found.length >= limit) break;
    }
    frontier = next;
  }

  return found.sort((a, b) => a.label.localeCompare(b.label));
}

export function scriptLabel(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.pine$/, '');
}

/**
 * Discovery hits the filesystem, so it is cached for the process lifetime and
 * shared: the STRATEGIES pane and the editor's FILES pane must not disagree
 * about which scripts exist, and `:w` on a new file has to make it appear in
 * both.
 */
let cache: ScriptEntry[] | undefined;

export function cachedScripts(cwd?: string): ScriptEntry[] {
  cache ??= discoverScripts(cwd);
  return cache;
}

/**
 * A script's `input()` titles, read once.
 *
 * The INPUTS pane asks for these on every frame, and a synchronous file read per
 * frame is not something a redraw should cost. Cleared with the script list,
 * which covers the two ways the titles change from under us: a `:w` in the
 * editor, and a return from `$EDITOR`.
 */
const titles = new Map<string, string[]>();

export function cachedInputTitles(path: string): string[] {
  let found = titles.get(path);
  if (found == null) {
    found = readInputTitles(path);
    titles.set(path, found);
  }
  return found;
}

/** Drop the caches: a script was added, renamed, or written. */
export function refreshScripts(): void {
  cache = undefined;
  titles.clear();
}
