/**
 * Pine `input()` titles, read from the script on disk.
 *
 * §4.5.e — `--input` is validated against the script's input titles before
 * anything runs, and `pinerun` will reject `--input maxhold=36h`. pinetop
 * validates locally first so a bad proposal is refused in the page, with the
 * near-miss named, instead of being spent on a process that will fail.
 *
 * This reads titles only. The script source never leaves the machine (§9) and
 * is never sent to the AI layer.
 */

import { readFileSync } from 'node:fs';

/**
 * Extract the declared input titles.
 *
 * Pine spells the title two ways, and both are common in the wild:
 *   `input.int(14, "RSI length")`        — second positional argument
 *   `input.float(2.4, title = "Stop")`   — named argument
 */
export function inputTitles(source: string): string[] {
  const titles = new Set<string>();

  // `title=` wins wherever it appears, in any input.* variant.
  for (const match of source.matchAll(
    /\binput(?:\.\w+)?\s*\([^)]*?\btitle\s*=\s*(["'])(.*?)\1/gs,
  )) {
    const title = match[2]?.trim();
    if (title) titles.add(title);
  }

  // Otherwise the second positional argument, when it is a literal string.
  for (const match of source.matchAll(/\binput(?:\.\w+)?\s*\(\s*([^,()]+)\s*,\s*(["'])(.*?)\2/gs)) {
    const title = match[3]?.trim();
    if (title) titles.add(title);
  }

  return [...titles];
}

export function readInputTitles(scriptPath: string): string[] {
  try {
    return inputTitles(readFileSync(scriptPath, 'utf8'));
  } catch {
    // An unreadable script is not an error here: validation degrades to
    // "cannot verify", and pinerun remains the authority that rejects.
    return [];
  }
}

export interface TitleCheck {
  ok: boolean;
  /** Set when the name is not a declared title but something close exists. */
  suggestion?: string;
}

/** Is `name` a declared input title? Offers the nearest title when it is not. */
export function checkTitle(name: string, titles: readonly string[]): TitleCheck {
  if (titles.length === 0) return { ok: true }; // cannot verify; pinerun decides
  if (titles.includes(name)) return { ok: true };

  const lower = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  let best: string | undefined;
  let bestScore = 0;
  for (const title of titles) {
    const candidate = title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (candidate === lower) return { ok: false, suggestion: title };
    const score = overlap(lower, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = title;
    }
  }
  return { ok: false, suggestion: bestScore >= 0.6 ? best : undefined };
}

/** Cheap similarity: longest common prefix + suffix over the longer length. */
function overlap(a: string, b: string): number {
  if (a === '' || b === '') return 0;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  return (prefix + suffix) / Math.max(a.length, b.length);
}
