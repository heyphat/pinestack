import { timeframeSeconds as pineryTimeframeSeconds } from '@heyphat/pinery';
import type { Bar } from '@heyphat/pinery';

export const timeframeSeconds = pineryTimeframeSeconds;

export function secondsToMilliseconds(seconds: number): number {
  if (!Number.isFinite(seconds)) throw new RangeError('time must be finite');
  return seconds >= 1e12 ? seconds : seconds * 1000;
}

export function millisecondsToSeconds(milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) throw new RangeError('time must be finite');
  return milliseconds >= 1e12 ? Math.floor(milliseconds / 1000) : Math.floor(milliseconds);
}

/** The sole unix-seconds to piner-milliseconds boundary. */
export function toPinerBar(bar: Bar): Bar {
  return { ...bar, time: secondsToMilliseconds(bar.time) };
}
