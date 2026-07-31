import { describe, expect, test } from 'bun:test';
import {
  axisValues,
  comboCount,
  commandLine,
  composeArgv,
  displayValue,
  emptyModel,
  redactArgv,
  shellQuote,
  validate,
  withOverrides,
  type FlagModel,
} from '../src/flags/model.js';
import { flagSpec, schemaFor } from '../src/flags/schema.js';

function backtestModel(): FlagModel {
  const model = emptyModel('backtest');
  model.scripts = ['strats/mean-rev-btc.pine'];
  model.values['symbol'] = 'BTC-PERP';
  model.values['tf'] = '1h';
  model.values['from'] = '2019-01-01';
  model.values['to'] = '2025-06-30';
  model.values['trades'] = true;
  model.values['input'] = [
    { name: 'lookback', value: '96' },
    { name: 'stopAtr', value: '2.4' },
  ];
  return model;
}

describe('argv composition (§4.1.b)', () => {
  test('composes the flags in schema order, positional script first', () => {
    expect(composeArgv(backtestModel())).toEqual([
      'backtest',
      'strats/mean-rev-btc.pine',
      '--symbol',
      'BTC-PERP',
      '--tf',
      '1h',
      '--from',
      '2019-01-01',
      '--to',
      '2025-06-30',
      '--input',
      'lookback=96',
      '--input',
      'stopAtr=2.4',
      '--trades',
    ]);
  });

  test('--json is added only when asked for', () => {
    expect(composeArgv(backtestModel(), { json: true }).at(-1)).toBe('--json');
    expect(composeArgv(backtestModel()).includes('--json')).toBe(false);
  });

  test('the displayed line is the composed argv, not a second copy', () => {
    const model = backtestModel();
    const line = commandLine(model);
    for (const arg of composeArgv(model)) expect(line).toContain(arg);
    expect(line.startsWith('pinerun backtest ')).toBe(true);
  });

  test('unset flags contribute nothing', () => {
    const model = emptyModel('backtest');
    model.scripts = ['a.pine'];
    model.values['csv'] = '';
    model.values['trades'] = false;
    expect(composeArgv(model)).toEqual(['backtest', 'a.pine']);
  });

  test('a tristate composes --flag or --no-flag', () => {
    const model = emptyModel('backtest');
    model.scripts = ['a.pine'];
    model.values['bar-magnifier'] = 'on';
    expect(composeArgv(model)).toContain('--bar-magnifier');
    model.values['bar-magnifier'] = 'off';
    expect(composeArgv(model)).toContain('--no-bar-magnifier');
  });

  test('a list joins with commas, as the CLI parses it', () => {
    const model = emptyModel('scan');
    model.scripts = ['a.pine'];
    model.values['symbols'] = ['BTCUSDT', 'ETHUSDT'];
    expect(composeArgv(model)).toEqual(['scan', 'a.pine', '--symbols', 'BTCUSDT,ETHUSDT']);
  });

  test('values that need quoting are quoted in the displayed line only', () => {
    const model = emptyModel('backtest');
    model.scripts = ['my strats/a b.pine'];
    expect(composeArgv(model)[1]).toBe('my strats/a b.pine');
    expect(commandLine(model)).toContain("'my strats/a b.pine'");
  });
});

describe('credential redaction (§9)', () => {
  test('the flag schema does not carry credentials at all', () => {
    for (const command of [
      'backtest',
      'sweep',
      'scan',
      'portfolio',
      'compare',
      'walkforward',
    ] as const) {
      const names = schemaFor(command).flags.map((f) => f.name);
      expect(names).not.toContain('api-key');
      expect(names).not.toContain('api-secret');
    }
  });

  test('a key that reaches argv anyway is masked', () => {
    expect(redactArgv(['backtest', 'a.pine', '--api-key', 'PKTEST123'])).toEqual([
      'backtest',
      'a.pine',
      '--api-key',
      '«redacted»',
    ]);
  });

  test('a long opaque token is masked even without a flag naming it', () => {
    const token = 'a'.repeat(40);
    expect(redactArgv(['backtest', token])).toEqual(['backtest', '«redacted»']);
  });
});

describe('swept-input grammar', () => {
  test('a comma list', () => {
    expect(axisValues('5,10,20')).toEqual(['5', '10', '20']);
  });

  test('a start:stop:step range', () => {
    expect(axisValues('30:100:10')).toEqual(['30', '40', '50', '60', '70', '80', '90', '100']);
  });

  test('a list whose members are ranges', () => {
    expect(axisValues('5,10:20:5')).toEqual(['5', '10', '15', '20']);
  });

  test('a quoted member is a literal string, not a range', () => {
    expect(axisValues(`"'09:30'"`)).toEqual([`'09:30'`]);
    expect(axisValues('09:30')).not.toEqual(['09:30']);
  });

  test('booleans pass through', () => {
    expect(axisValues('true,false')).toEqual(['true', 'false']);
  });

  test('combo count multiplies the axes', () => {
    expect(
      comboCount([
        { name: 'fast', value: '5,10,15,20' },
        { name: 'slow', value: '30:100:10' },
      ]),
    ).toBe(32);
  });
});

describe('validation before spawn (§7 P2)', () => {
  test('backtest needs a symbol', () => {
    const model = emptyModel('backtest');
    model.scripts = ['a.pine'];
    expect(validate(model)).toContain('--symbol is required for backtest');
  });

  test('compare needs two scripts', () => {
    const model = emptyModel('compare');
    model.scripts = ['a.pine'];
    model.values['symbol'] = 'BTCUSDT';
    expect(validate(model)).toContain('compare needs two scripts');
  });

  test('scan needs a universe', () => {
    const model = emptyModel('scan');
    model.scripts = ['a.pine'];
    expect(validate(model)).toContain('scan needs --symbols or --universe');
  });

  test('the --max-combos guard is enforced before the spawn, as the CLI does', () => {
    const model = emptyModel('sweep');
    model.scripts = ['a.pine'];
    model.values['symbol'] = 'BTCUSDT';
    model.values['input'] = [
      { name: 'fast', value: '1:100' },
      { name: 'slow', value: '1:100' },
    ];
    const problems = validate(model);
    expect(problems.some((p) => p.includes('over --max-combos'))).toBe(true);
  });

  test('--sample makes a huge grid tractable, and the guard applies to n', () => {
    const model = emptyModel('sweep');
    model.scripts = ['a.pine'];
    model.values['symbol'] = 'BTCUSDT';
    model.values['input'] = [
      { name: 'fast', value: '1:100' },
      { name: 'slow', value: '1:100' },
    ];
    model.values['sample'] = 200;
    expect(validate(model).some((p) => p.includes('over --max-combos'))).toBe(false);
  });

  test('--heatmap needs exactly two axes', () => {
    const model = emptyModel('sweep');
    model.scripts = ['a.pine'];
    model.values['symbol'] = 'BTCUSDT';
    model.values['input'] = [{ name: 'fast', value: '5,10' }];
    model.values['heatmap'] = true;
    expect(validate(model).some((p) => p.includes('--heatmap needs exactly two'))).toBe(true);
  });

  test('--provider csv without --data-dir is refused, naming the flag to set', () => {
    const model = emptyModel('backtest');
    model.scripts = ['a.pine'];
    model.values['symbol'] = 'BTCUSDT';
    model.values['provider'] = 'csv';
    expect(validate(model).some((p) => p.includes('--data-dir'))).toBe(true);

    model.values['data-dir'] = 'examples/data';
    expect(validate(model)).toEqual([]);
  });

  test('--csv-calendar conflicts with the alignment assertions, as the CLI says', () => {
    const model = emptyModel('backtest');
    model.scripts = ['a.pine'];
    model.values['symbol'] = 'BTCUSDT';
    model.values['provider'] = 'csv';
    model.values['data-dir'] = 'd';
    model.values['csv-calendar'] = 'cal.json';
    model.values['csv-alignment'] = 'utc-24x7';
    expect(validate(model).some((p) => p.includes('conflicts'))).toBe(true);
  });

  test('a non-csv provider needs no data directory', () => {
    const model = emptyModel('backtest');
    model.scripts = ['a.pine'];
    model.values['symbol'] = 'BTCUSDT';
    model.values['provider'] = 'binance';
    expect(validate(model)).toEqual([]);
  });

  test('--watch is refused: it redraws a terminal and cannot be read as JSON', () => {
    const model = emptyModel('backtest');
    model.scripts = ['a.pine'];
    model.values['symbol'] = 'BTCUSDT';
    model.values['watch'] = 60;
    expect(validate(model).some((p) => p.includes('--watch'))).toBe(true);
  });
});

describe('overrides (§4.5.c)', () => {
  test('an override merges into --input and wins over a same-named fixed input', () => {
    const merged = withOverrides(backtestModel(), [
      { input: 'stopAtr', from: '2.4', to: '1.8' },
      { input: 'maxHoldH', from: '36', to: '18' },
    ]);
    const argv = composeArgv(merged);
    expect(argv).toContain('stopAtr=1.8');
    expect(argv).not.toContain('stopAtr=2.4');
    expect(argv).toContain('maxHoldH=18');
    expect(argv).toContain('lookback=96');
  });

  test('merging does not mutate the source model', () => {
    const model = backtestModel();
    withOverrides(model, [{ input: 'stopAtr', from: '2.4', to: '1.8' }]);
    expect(composeArgv(model)).toContain('stopAtr=2.4');
  });

  test('compare merges into --input-a, the side it can name', () => {
    const model = emptyModel('compare');
    model.scripts = ['a.pine', 'b.pine'];
    const merged = withOverrides(model, [{ input: 'fast', from: '5', to: '9' }]);
    expect(composeArgv(merged)).toContain('--input-a');
  });
});

describe('display values never reach argv (§4.5.e)', () => {
  test('a pairs flag displays as name=value but composes one flag per pair', () => {
    const spec = flagSpec('backtest', 'input')!;
    expect(displayValue(spec, [{ name: 'a', value: '1' }])).toBe('a=1');
    const model = backtestModel();
    const argv = composeArgv(model);
    expect(argv.filter((a) => a === '--input')).toHaveLength(2);
  });

  test('an unset flag displays its CLI default, which is never composed', () => {
    const spec = flagSpec('backtest', 'tf')!;
    expect(displayValue(spec, undefined)).toBe('1h');
    const model = emptyModel('backtest');
    model.scripts = ['a.pine'];
    expect(composeArgv(model)).not.toContain('--tf');
  });
});

describe('shellQuote', () => {
  test('leaves safe tokens alone', () => {
    expect(shellQuote('--symbol')).toBe('--symbol');
    expect(shellQuote('BTC-PERP')).toBe('BTC-PERP');
    expect(shellQuote('a/b.pine')).toBe('a/b.pine');
  });

  test('quotes whitespace and escapes embedded quotes', () => {
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
