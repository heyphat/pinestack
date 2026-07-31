import { describe, expect, test } from 'bun:test';
import { groundReport, parseAskResponse } from '../src/ask/protocol.js';
import { checkTitle, inputTitles } from '../src/flags/pine-inputs.js';

const TITLES = ['stopAtr', 'maxHoldH', 'lookback', 'entryZ'];

describe('the ask contract (§4.5.b)', () => {
  test('an answer alone is valid — a proposal is optional', () => {
    const { response, error } = parseAskResponse({ answer: 'Cost drag is 0.4% a year.' }, TITLES);
    expect(error).toBeUndefined();
    expect(response?.answer).toContain('Cost drag');
    expect(response?.proposal).toBeUndefined();
  });

  test('a proposal comes back as a separate object with its edits', () => {
    const { response } = parseAskResponse(
      {
        answer: 'The stop is too wide for this regime.',
        proposal: {
          effect: 'est. Sharpe 1.42 → 1.51 · max DD −17.2% → −12.8%',
          note: 'Tighter stop plus a hard time exit; entry logic untouched.',
          edits: [
            { input: 'stopAtr', from: '2.4', to: '1.8', display: '2.4 ATR → 1.8 ATR' },
            { input: 'maxHoldH', from: '36', to: '18', display: '36 h → 18 h' },
          ],
        },
      },
      TITLES,
    );
    expect(response?.proposal?.edits).toHaveLength(2);
    expect(response?.proposal?.edits[0]!.to).toBe('1.8');
    expect(response?.proposal?.edits[0]!.display).toBe('2.4 ATR → 1.8 ATR');
  });

  test('a JSON string is parsed as readily as an object', () => {
    const { response } = parseAskResponse('{"answer":"ok"}', TITLES);
    expect(response?.answer).toBe('ok');
  });
});

describe('declining to propose is first class (§4.5.d)', () => {
  test('an action is returned instead of edits', () => {
    const { response } = parseAskResponse(
      {
        answer: 'PBO is 0.62 and the deflated Sharpe is 0.3 — this looks overfit.',
        action: { label: 'open parameter sweep', key: 's' },
      },
      TITLES,
    );
    expect(response?.proposal).toBeUndefined();
    expect(response?.action).toEqual({ label: 'open parameter sweep', key: 's' });
  });
});

describe('edits are validated before they can reach argv (§4.5.e)', () => {
  test('a display string as the value is refused, with the reason', () => {
    const { response, warnings } = parseAskResponse(
      {
        answer: 'Tighten the hold.',
        proposal: { effect: '', note: '', edits: [{ input: 'maxHoldH', to: '18 h' }] },
      },
      TITLES,
    );
    expect(response?.proposal).toBeUndefined();
    expect(warnings.join(' ')).toContain('display string, not a bare value');
  });

  test('an input that is not a declared title is refused and the near-miss named', () => {
    const { response, warnings } = parseAskResponse(
      {
        answer: 'Tighten the hold.',
        proposal: { effect: '', note: '', edits: [{ input: 'maxhold', to: '18' }] },
      },
      TITLES,
    );
    expect(response?.proposal).toBeUndefined();
    expect(warnings.join(' ')).toContain('maxHoldH');
  });

  test('a good edit survives alongside a refused one', () => {
    const { response, warnings } = parseAskResponse(
      {
        answer: 'Two changes.',
        proposal: {
          effect: '',
          note: '',
          edits: [
            { input: 'stopAtr', to: '1.8' },
            { input: 'nonsense', to: '3' },
          ],
        },
      },
      TITLES,
    );
    expect(response?.proposal?.edits).toHaveLength(1);
    expect(response?.proposal?.edits[0]!.input).toBe('stopAtr');
    expect(warnings).toHaveLength(1);
  });

  test('with no titles known, validation defers to pinerun rather than blocking', () => {
    const { response } = parseAskResponse(
      { answer: 'x', proposal: { effect: '', note: '', edits: [{ input: 'whatever', to: '1' }] } },
      [],
    );
    expect(response?.proposal?.edits).toHaveLength(1);
  });

  test('a response with no answer is refused outright', () => {
    expect(parseAskResponse({ proposal: {} }, TITLES).error).toContain('no answer');
    expect(parseAskResponse('not json', TITLES).error).toContain('not JSON');
  });
});

describe('the grounding payload sends derived metrics only (§9)', () => {
  const report = {
    symbol: 'BTC-PERP',
    bars: 51_840,
    closes: [1, 2, 3, 4, 5],
    equityCurve: [100, 101, 102],
    barTimes: [1, 2, 3],
    plots: [{ id: 0, title: 'rsi', data: [1, 2, 3] }],
    strategy: {
      netProfit: 1234,
      metrics: { sharpe: 1.42, sortino: Infinity },
    },
    trades: Array.from({ length: 90 }, (_, i) => ({ profit: i })),
  };

  test('OHLCV and per-bar series never leave', () => {
    const grounded = groundReport(report);
    expect(grounded['closes']).toBeUndefined();
    expect(grounded['equityCurve']).toBeUndefined();
    expect(grounded['barTimes']).toBeUndefined();
    expect(grounded['plots']).toBeUndefined();
  });

  test('series are replaced by their length, so counts survive', () => {
    const grounded = groundReport(report);
    expect(grounded['closesCount']).toBe(5);
    expect(grounded['tradesCount']).toBe(90);
  });

  test('metrics are forwarded intact', () => {
    const grounded = groundReport(report) as { strategy?: { metrics?: Record<string, unknown> } };
    expect(grounded.strategy?.metrics?.['sharpe']).toBe(1.42);
  });

  test('non-finite numbers survive JSON as labels rather than null', () => {
    const grounded = groundReport(report) as { strategy?: { metrics?: Record<string, unknown> } };
    expect(grounded.strategy?.metrics?.['sortino']).toBe('Infinity');
  });

  test('small object arrays are kept — windows and sleeves are the answer', () => {
    const grounded = groundReport({
      windows: [
        { index: 0, efficiency: 0.9 },
        { index: 1, efficiency: 0.4 },
      ],
    }) as { windows?: unknown[] };
    expect(grounded.windows).toHaveLength(2);
  });
});

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

  test('checkTitle offers the near-miss for a wrong case', () => {
    expect(checkTitle('stopatr', TITLES)).toEqual({ ok: false, suggestion: 'stopAtr' });
  });

  test('checkTitle accepts an exact title', () => {
    expect(checkTitle('stopAtr', TITLES).ok).toBe(true);
  });
});
