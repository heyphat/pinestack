/**
 * Bounded project-file discovery.
 *
 * Runnable strategies and editor files deliberately have separate public views:
 * every strategy is a `.pine`, while the editor may also open project Markdown.
 * Keeping that distinction here makes it impossible for README.md to leak into a
 * `pinerun` argv just because both kinds appear in the EDITOR page's FILES pane.
 */

import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { readInputTitles } from './flags/pine-inputs.js';

export interface ScriptEntry {
  /** Path as it will appear in argv — relative to cwd when it is below it. */
  path: string;
  /** Basename without the .pine extension, for strategy panes. */
  label: string;
  mtimeMs: number;
}

export type EditorFileKind = 'pine' | 'markdown';

export interface EditorFileEntry {
  /** Relative project path, suitable for opening from the process cwd. */
  path: string;
  /** Relative path including its extension, so README.md and README.pine differ. */
  label: string;
  kind: EditorFileKind;
  mtimeMs: number;
}

interface DiscoveredFile {
  path: string;
  name: string;
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
 * Walk matching project files breadth-first. The bound keeps opening Pinetop in
 * a large directory predictable, and hidden/build directories stay out of both
 * the strategy picker and the text-file picker.
 */
function discoverFiles(
  cwd: string,
  accepts: (name: string) => boolean,
  depth: number,
  limit: number,
): DiscoveredFile[] {
  const found: DiscoveredFile[] = [];
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
        if (!entry.isFile() || !accepts(entry.name)) continue;
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(full).mtimeMs;
        } catch {
          // An unreadable stat does not make a discovered path disappear.
        }
        const rel = relative(cwd, full);
        found.push({
          path: rel === '' || rel.startsWith('..') ? full : rel,
          name: entry.name,
          mtimeMs,
        });
        if (found.length >= limit) break;
      }
      if (found.length >= limit) break;
    }
    frontier = next;
  }

  return found;
}

/** Find runnable `.pine` strategies for command pages and bootstrap. */
export function discoverScripts(cwd = process.cwd(), depth = 3, limit = 200): ScriptEntry[] {
  return discoverFiles(cwd, (name) => name.endsWith('.pine'), depth, limit)
    .map((entry) => ({
      path: entry.path,
      label: entry.name.replace(/\.pine$/, ''),
      mtimeMs: entry.mtimeMs,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Find text files the embedded editor explicitly supports. */
export function discoverEditorFiles(
  cwd = process.cwd(),
  depth = 3,
  limit = 200,
): EditorFileEntry[] {
  return discoverFiles(cwd, (name) => name.endsWith('.pine') || name.endsWith('.md'), depth, limit)
    .map((entry) => ({
      path: entry.path,
      label: entry.path.replaceAll('\\', '/'),
      kind: entry.name.endsWith('.pine') ? ('pine' as const) : ('markdown' as const),
      mtimeMs: entry.mtimeMs,
    }))
    .sort((a, b) => {
      // Preserve the old Pine-first starting point while making Markdown
      // available in the same picker.
      if (a.kind !== b.kind) return a.kind === 'pine' ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
}

export function scriptLabel(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.pine$/, '');
}

/** Basename including extension, for a language-neutral editor title. */
export function editorFileLabel(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Strategy discovery is cached because every command page asks every frame. */
let scriptCache: ScriptEntry[] | undefined;

export function cachedScripts(cwd?: string): ScriptEntry[] {
  scriptCache ??= discoverScripts(cwd);
  return scriptCache;
}

/** Editor discovery has its own cache so Markdown never enters strategy panes. */
let editorFileCache: EditorFileEntry[] | undefined;
let editorFileCacheCwd: string | undefined;
let editorFileVersion = 0;

export function cachedEditorFiles(cwd?: string): EditorFileEntry[] {
  if (cwd == null && editorFileCache != null) return editorFileCache;
  const absoluteCwd = resolve(cwd ?? process.cwd());
  if (editorFileCache == null || editorFileCacheCwd !== absoluteCwd) {
    editorFileCache = discoverEditorFiles(absoluteCwd);
    editorFileCacheCwd = absoluteCwd;
  }
  return editorFileCache;
}

/** Monotonic invalidation token used to refresh optional Git status promptly. */
export function editorFilesVersion(): number {
  return editorFileVersion;
}

export function refreshEditorFiles(): void {
  editorFileCache = undefined;
  editorFileCacheCwd = undefined;
  editorFileVersion += 1;
}

/**
 * A script's `input()` titles, read once.
 *
 * The INPUTS pane asks for these on every frame, and a synchronous file read per
 * frame is not something a redraw should cost. Cleared whenever scripts refresh.
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

/** Drop both file views after a script was added, renamed, or written. */
export function refreshScripts(): void {
  scriptCache = undefined;
  titles.clear();
  refreshEditorFiles();
}
