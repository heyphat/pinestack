import { expect, test } from 'bun:test';
import { ExactChildBarAggregator } from '../src/live/index.js';
import type { Bar, BarUpdate } from '../src/provider.js';

const lower1m = Object.freeze({ kind: 'lower-bars' as const, timeframe: '1m' });

function update(
  time: number,
  revision: number,
  isClose: boolean,
  eventTime: number,
  bar: Partial<Bar>,
): BarUpdate {
  return Object.freeze({
    bar: Object.freeze({
      time,
      open: bar.open ?? 10,
      high: bar.high ?? 12,
      low: bar.low ?? 9,
      close: bar.close ?? 11,
      volume: bar.volume ?? 1,
    }),
    revision,
    isClose,
    eventTime,
    source: lower1m,
  });
}

const childVolumes = [0.1, 0.2, 0.1, 0.2, 0.1];

function aggregatorWithFractionalChildren(): ExactChildBarAggregator {
  const aggregator = new ExactChildBarAggregator({
    sourceTimeframe: '1m',
    targetTimeframe: '5m',
  });
  // Fractional-volume children: sequential float summation yields 0.7000000000000001, not 0.7,
  // so a provider that totalled the same trades differently disagrees in the last bit.
  for (const [index, time] of [0, 60, 120, 180, 240].entries()) {
    aggregator.accept(
      update(time, 1, true, 1_000 + index, {
        open: 10 + index,
        high: 12 + index,
        low: 9 + index,
        close: 11 + index,
        volume: childVolumes[index]!,
      }),
    );
  }
  return aggregator;
}

test('finalize tolerates float-summation noise in fractional volume', () => {
  expect(childVolumes.reduce((sum, value) => sum + value, 0)).not.toBe(0.7); // scenario is real
  const final = aggregatorWithFractionalChildren().finalize(
    update(0, 9, true, 1_010, { open: 10, high: 16, low: 9, close: 15, volume: 0.7 }),
  );
  expect(final).toMatchObject({ isClose: true, bar: { volume: 0.7 } });
});

test('finalize still rejects a real volume conflict', () => {
  expect(() =>
    aggregatorWithFractionalChildren().finalize(
      update(0, 9, true, 1_010, { open: 10, high: 16, low: 9, close: 15, volume: 0.8 }),
    ),
  ).toThrow('conflicts with exact child aggregation');
});

test('finalize still rejects any OHLC difference exactly', () => {
  expect(() =>
    aggregatorWithFractionalChildren().finalize(
      update(0, 9, true, 1_010, {
        open: 10,
        high: 16,
        low: 9,
        close: 15 + 1e-12,
        volume: 0.7,
      }),
    ),
  ).toThrow('conflicts with exact child aggregation');
});
