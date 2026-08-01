/**
 * The editor's filesystem boundary.
 *
 * `:w` is the one thing in pinetop that writes a file the user cares about, so
 * it goes through a single injectable interface rather than calling `node:fs`
 * from the key handler. That gives the vim layer the same testability the rest of
 * the app has — a test presses `:w↵` against an in-memory disk and asserts on
 * what was written — and it keeps "what can this program overwrite?" answerable
 * by reading one file.
 *
 * The seam is a module-level accessor rather than a constructor argument, the way
 * `pages/backtest.ts` caches script discovery: the key handler is reached from
 * the `Page` contract, which carries no services.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface EditorIo {
  read(path: string): string;
  /** Creates parent directories; a `:w` to a new path must not need a shell. */
  write(path: string, text: string): void;
  exists(path: string): boolean;
}

export const nodeIo: EditorIo = {
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  },
  exists: (path) => existsSync(path),
};

let current: EditorIo = nodeIo;

export function editorIo(): EditorIo {
  return current;
}

/** Test seam: swap the disk. Pass no argument to restore the real one. */
export function setEditorIo(io: EditorIo = nodeIo): void {
  current = io;
}
