import { expect, test } from 'bun:test';
import { CsvReplayFeed } from '../src/index.js';

const csv = `time,open,high,low,close,volume\n300,3,4,2,3,1\n100,1,2,0,1,1\n200,2,3,1,2,1\n200,2,3,1,2.5,1\n400,4,5,3,4,1`;

test('CSV replay sorts, deduplicates, partitions warmup and emits closed bars only', async () => {
  const feed = new CsvReplayFeed(csv, { warmupBars: 2, nowSec: 450 });
  const history = await feed.history('X', '1m', 10);
  expect(history.map((bar) => [bar.time, bar.close])).toEqual([
    [100, 1],
    [200, 2.5],
  ]);
  const streamed = [];
  for await (const bar of feed.closedBars('X', '1m')) streamed.push(bar.time);
  expect(streamed).toEqual([300]); // 400 closes at 460 and is suppressed
});

test('stop ends replay', async () => {
  const feed = new CsvReplayFeed(csv, { warmupBars: 0, nowSec: 1_000 });
  await feed.history('X', '1m', 0);
  await feed.stop();
  const streamed = [];
  for await (const bar of feed.closedBars('X', '1m')) streamed.push(bar);
  expect(streamed).toHaveLength(0);
});

test('CSV replay preserves later closed bars across timestamp gaps', async () => {
  const feed = new CsvReplayFeed(
    [
      { time: 100, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: 300, open: 3, high: 3, low: 3, close: 3, volume: 1 },
    ],
    { warmupBars: 0, nowSec: 1_000 },
  );
  await feed.history('X', '1m', 0);
  const times: number[] = [];
  for await (const bar of feed.closedBars('X', '1m')) times.push(bar.time);
  expect(times).toEqual([100, 300]);
});
