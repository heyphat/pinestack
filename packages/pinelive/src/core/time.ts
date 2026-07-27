import { parseTimeframe, timeframeSeconds as pineryTimeframeSeconds } from '@heyphat/pinery';
import type { Bar } from './types.js';

export const timeframeSeconds = pineryTimeframeSeconds;

export function secondsToMilliseconds(seconds: number): number {
  if (!Number.isFinite(seconds)) throw new RangeError('time must be finite');
  return seconds >= 1e12 ? seconds : seconds * 1000;
}

export function millisecondsToSeconds(milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) throw new RangeError('time must be finite');
  return milliseconds >= 1e12 ? Math.floor(milliseconds / 1000) : Math.floor(milliseconds);
}

export function toPinerBar(bar: Bar): Bar {
  return { ...bar, time: secondsToMilliseconds(bar.time) };
}

export function barCloseTime(openTimeSec: number, timeframe: string): number {
  const { n, unit } = parseTimeframe(timeframe);
  if (unit !== 'M') return openTimeSec + timeframeSeconds(timeframe);
  const date = new Date(openTimeSec * 1000);
  return (
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + n,
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
    ) / 1000
  );
}

export function isBarClosed(
  bar: Pick<Bar, 'time'>,
  timeframe: string,
  nowSec = Date.now() / 1000,
): boolean {
  return barCloseTime(bar.time, timeframe) <= nowSec;
}
