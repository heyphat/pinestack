import { expect, test } from 'bun:test';
import {
  barCloseTime,
  isBarClosed,
  millisecondsToSeconds,
  secondsToMilliseconds,
} from '../src/index.js';

test('time boundary and close semantics', () => {
  expect(secondsToMilliseconds(1_700_000_000)).toBe(1_700_000_000_000);
  expect(millisecondsToSeconds(1_700_000_000_999)).toBe(1_700_000_000);
  expect(barCloseTime(1_700_000_000, '1h')).toBe(1_700_003_600);
  expect(isBarClosed({ time: 1_700_000_000 }, '1h', 1_700_003_599)).toBe(false);
  expect(isBarClosed({ time: 1_700_000_000 }, '1h', 1_700_003_600)).toBe(true);
});
