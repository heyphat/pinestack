/**
 * Number and date presentation. Every value here arrives from `pinerun --json`;
 * these helpers only choose how many digits to show (§3 NG1 — nothing is
 * computed, and no value is rounded before it reaches the screen for any reason
 * other than fitting a column).
 */

export function pct(value: number | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

export function num(value: number | undefined, digits = 2): string {
  if (value == null) return '—';
  if (value === Infinity) return '∞';
  if (value === -Infinity) return '-∞';
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

export function int(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

/** Money with a thousands separator and no currency symbol (the CLI's style). */
export function money(value: number | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Compact money for narrow columns: 1.19M, 1,198k, 934. */
export function compactMoney(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${Math.round(value / 1e3).toLocaleString('en-US')}k`;
  return Math.round(value).toLocaleString('en-US');
}

/** Bar times are unix seconds in pinery's convention, ms elsewhere. */
export function toMillis(time: number): number {
  return time > 1e11 ? time : time * 1000;
}

export function isoDay(time: number | undefined): string {
  if (time == null || !Number.isFinite(time)) return '—';
  return new Date(toMillis(time)).toISOString().slice(0, 10);
}

export function isoMonth(time: number | undefined): string {
  if (time == null || !Number.isFinite(time)) return '—';
  return new Date(toMillis(time)).toISOString().slice(0, 7);
}

export function isoMinute(time: number | undefined): string {
  if (time == null || !Number.isFinite(time)) return '—';
  return new Date(toMillis(time)).toISOString().slice(0, 16).replace('T', ' ');
}

export function duration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Render an unknown Pine input value the way `--input name=value` takes it. */
export function inputValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return String(value);
}
