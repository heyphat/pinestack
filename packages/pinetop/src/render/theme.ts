/**
 * Colour. §4.7 is explicit that the prototype's gold/brick mapping is a GUI
 * concern: a native implementation uses the terminal's own ANSI palette,
 * because that is what `pinerun` does and it respects the user's theme.
 *
 * So: `accent` for the focused/selected surface, and `pinerun`'s own
 * red → yellow → plain → green → bright-green quintile grade for values.
 */

/** An SGR style: the escape body, e.g. `1;36`. Empty means "default". */
export type Style = string;

export const STYLE = {
  none: '',
  dim: '2',
  bold: '1',
  /** Focused pane border + selected row. */
  accent: '36',
  accentBold: '1;36',
  /** Pane titles and column headers. */
  title: '1',
  /** Dot leaders, legends, inactive tabs — present but not the subject. */
  muted: '2',
  /** Losses. Never the accent colour (§4.7 deviation 2). */
  negative: '31',
  positive: '32',
  warn: '33',
  error: '1;31',
  /** Selected row: reverse video reads correctly in every theme. */
  selected: '7',
  /** The gold dot on an AI-applied, not-yet-re-run edit (§4.5.c). */
  pending: '1;33',
  strike: '9',
  /**
   * The EDITOR's text cursor. Bold reverse rather than plain reverse, so it stays
   * visible inside a visual-mode selection — which is itself reverse video.
   */
  cursor: '1;7',
} as const satisfies Record<string, Style>;

/**
 * Pine syntax in the EDITOR buffer.
 *
 * Same rule as the rest of the app (§4.7): the terminal's own ANSI palette, so
 * the buffer respects the user's theme instead of asserting a colour scheme over
 * it. Kept separate from `STYLE` because these roles are lexical — a number in
 * source is not a "positive value" — and conflating the two would make a
 * report's colour semantics change when a syntax colour is retuned.
 */
export const SYNTAX = {
  plain: '',
  comment: '2',
  /** `//@version=6`, `//@strategy_alert_message`, … */
  annotation: '2;36',
  keyword: '1;35',
  /** `ta.`, `math.`, `strategy.`, and the bar series (`close`, `volume`, …). */
  builtin: '36',
  string: '32',
  number: '33',
} as const satisfies Record<string, Style>;

/** `pinerun`'s value grade, worst → best. Mirrors the CLI's TTY quintiles. */
export const QUINTILE: readonly Style[] = ['31', '33', '', '32', '1;32'];

/**
 * Grade `value` against `all` by quintile, the way the CLI grades a ranked
 * column. Returns a plain style when there is nothing to compare against.
 */
export function gradeStyle(value: number, all: readonly number[]): Style {
  const finite = all.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length < 2 || !Number.isFinite(value)) return STYLE.none;
  const lo = finite[0]!;
  const hi = finite[finite.length - 1]!;
  if (hi === lo) return STYLE.none;
  const q = Math.min(4, Math.max(0, Math.floor(((value - lo) / (hi - lo)) * 5)));
  return QUINTILE[q]!;
}

/** Sign colouring for a signed value: losses brick, gains green, zero plain. */
export function signStyle(value: number): Style {
  if (!Number.isFinite(value) || value === 0) return STYLE.none;
  return value > 0 ? STYLE.positive : STYLE.negative;
}

export function sgr(style: Style): string {
  return style === '' ? '\x1b[0m' : `\x1b[0m\x1b[${style}m`;
}
