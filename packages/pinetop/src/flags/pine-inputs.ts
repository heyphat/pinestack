/**
 * Pine `input()` titles, read from the script on disk.
 *
 * The editor and parameter panes use these titles to show the script's declared
 * controls. This reads titles only; script source stays local and `pinerun`
 * remains the authority when an input value is eventually executed.
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
    // An unreadable script simply has no discoverable input rows here; pinerun
    // remains the authority when the invocation eventually runs.
    return [];
  }
}
