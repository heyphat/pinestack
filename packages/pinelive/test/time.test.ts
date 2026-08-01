import { expect, test } from 'bun:test';
import { millisecondsToSeconds, secondsToMilliseconds, toPinerBar } from '../src/index.js';

test('pinelive converts pinery unix seconds only at the engine boundary', () => {
  expect(secondsToMilliseconds(1_700_000_000)).toBe(1_700_000_000_000);
  expect(millisecondsToSeconds(1_700_000_000_999)).toBe(1_700_000_000);
  expect(toPinerBar({ time: 100, open: 1, high: 1, low: 1, close: 1, volume: 1 }).time).toBe(
    100_000,
  );
});

test('pinelive public surface contains no feed, replay, or bar-close implementation', async () => {
  const api = await import('../src/index.js');
  expect('LiveFeed' in api).toBe(false);
  expect('CsvReplayFeed' in api).toBe(false);
  expect('normalizeClosedBars' in api).toBe(false);
  expect('barCloseTime' in api).toBe(false);
});
