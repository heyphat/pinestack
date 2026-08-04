import { describe, expect, test } from 'bun:test';
import { inputTitles } from '../src/flags/pine-inputs.js';

describe('Pine input titles', () => {
  test('reads the named title argument', () => {
    expect(inputTitles('x = input.float(2.4, title = "stopAtr")')).toContain('stopAtr');
  });

  test('reads the second positional argument', () => {
    expect(inputTitles('len = input.int(14, "RSI length")')).toContain('RSI length');
  });

  test('reads a bare input() call', () => {
    expect(inputTitles('a = input(5, "fast")')).toContain('fast');
  });

  test('finds several inputs in one script', () => {
    const source = `
      //@version=5
      strategy("Mean reversion")
      lookback = input.int(96, "lookback")
      entryZ   = input.float(1.75, title="entryZ")
      useStop  = input.bool(true, "useStop")
    `;
    expect(inputTitles(source).sort()).toEqual(['entryZ', 'lookback', 'useStop']);
  });
});
