/**
 * `pinerun init` scaffold: build a heavily commented Pine v6 starter strategy so
 * a new user has a real, runnable script without writing any Pine from scratch.
 *
 * Pure and browser-safe — returns the source string; only the CLI touches the
 * filesystem (mirroring the export.ts builders). The starters double as living
 * documentation: each one is a valid `strategy(...)` whose lookbacks are exposed
 * as `input()`s (titles matching the `--input` axis names) so it drops straight
 * into `backtest`, `sweep`, and `walkforward`.
 */

/** The starter templates `init` can scaffold. */
export type StarterTemplate = 'sma-cross' | 'rsi' | 'bollinger' | 'macd';

/** Every template name, in menu order (the first is the default). */
export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  'sma-cross',
  'rsi',
  'bollinger',
  'macd',
] as const;

export function isStarterTemplate(v: string): v is StarterTemplate {
  return (STARTER_TEMPLATES as readonly string[]).includes(v);
}

export interface ScaffoldOptions {
  /** Which starter to write (default `sma-cross`). */
  template?: StarterTemplate;
  /** The `strategy()` title. Defaults to a per-template label. */
  name?: string;
}

/** One-line human summary per template (for the CLI menu / help). */
export const STARTER_DESCRIPTIONS: Record<StarterTemplate, string> = {
  'sma-cross': 'SMA crossover — trend following (the classic starter)',
  rsi: 'RSI mean-reversion — fade oversold/overbought extremes',
  bollinger: 'Bollinger-band breakout — trade volatility expansion',
  macd: 'MACD crossover — momentum via the signal-line cross',
};

const DEFAULT_TITLES: Record<StarterTemplate, string> = {
  'sma-cross': 'My SMA cross',
  rsi: 'My RSI mean-reversion',
  bollinger: 'My Bollinger breakout',
  macd: 'My MACD cross',
};

/**
 * Build the commented Pine v6 source for a starter strategy. Deterministic and
 * pure — the same options always yield the same string.
 */
export function starterStrategy(options: ScaffoldOptions = {}): string {
  const template = options.template ?? 'sma-cross';
  if (!isStarterTemplate(template)) {
    throw new Error(
      `unknown starter template "${template}" (choose one of: ${STARTER_TEMPLATES.join(', ')})`,
    );
  }
  const title = options.name?.trim() || DEFAULT_TITLES[template];
  const header = buildHeader(template, title);
  return `${header}\n${BODIES[template](escapeTitle(title))}`;
}

/** The shared teaching preamble + the run recipe for this template. */
function buildHeader(template: StarterTemplate, title: string): string {
  return `//@version=6
// ${title}
// ---------------------------------------------------------------------------
// A starter Pine v6 strategy scaffolded by \`pinerun init\`. It is a complete,
// runnable ${STARTER_DESCRIPTIONS[template]}.
//
// HOW A PINE STRATEGY WORKS
//   • \`strategy(...)\` declares the script and its account settings (starting
//     capital, position sizing, commission). pinerun reads P/L, trades, and the
//     equity curve straight off piner's broker — every number matches Pine.
//   • \`input.*(default, "title")\` exposes a knob. pinerun overrides it BY TITLE,
//     so the titles below are what you pass to --input.
//   • The script runs once per bar, oldest → newest. \`close\`, \`high\`, \`low\`,
//     \`open\`, \`volume\` are the current bar; \`ta.*\` are the built-in indicators.
//   • \`strategy.entry\` / \`strategy.close\` place orders (filled next bar's open).
//
// RUN IT
//   # Tearsheet on one symbol:
//   pinerun backtest ${SUGGESTED_FILE} --symbol BTCUSDT --tf 1h --limit 500
//
//   # Screen it across many symbols, ranked by net profit:
//   pinerun scan ${SUGGESTED_FILE} --symbols BTCUSDT,ETHUSDT,SOLUSDT --tf 1h --limit 500
//
${RUN_RECIPES[template]}//
//   # Then validate the winner out of sample:
//   pinerun walkforward ${SUGGESTED_FILE} --symbol BTCUSDT --tf 1h --limit 2000 ${WF_INPUTS[template]} --windows 5
//
// Tweak the logic, add inputs, and re-run. Overfitting warning: the "best" sweep
// combo usually fits past noise — always confirm it with walkforward.
// ---------------------------------------------------------------------------`;
}

/** The default filename `init` writes, referenced in the scaffold's comments. */
export const SUGGESTED_FILE = 'strategy.pine';

const RUN_RECIPES: Record<StarterTemplate, string> = {
  'sma-cross':
    '//   # Optimize the two lookbacks over a grid (each --input name matches a title):\n' +
    `//   pinerun sweep ${SUGGESTED_FILE} --symbol BTCUSDT --tf 1h --limit 500 --input fast=5,10,15,20 --input slow=30:100:10 --top 10\n`,
  rsi:
    '//   # Optimize the length + thresholds over a grid (each --input name matches a title):\n' +
    `//   pinerun sweep ${SUGGESTED_FILE} --symbol BTCUSDT --tf 1h --limit 500 --input length=7,14,21 --input oversold=20:35:5 --top 10\n`,
  bollinger:
    '//   # Optimize the length + band width over a grid (each --input name matches a title):\n' +
    `//   pinerun sweep ${SUGGESTED_FILE} --symbol BTCUSDT --tf 1h --limit 500 --input length=10,20,30 --input mult=1.5,2,2.5 --top 10\n`,
  macd:
    '//   # Optimize the three lengths over a grid (each --input name matches a title):\n' +
    `//   pinerun sweep ${SUGGESTED_FILE} --symbol BTCUSDT --tf 1h --limit 500 --input fast=8,12,16 --input slow=26:34:4 --input signal=7,9,11 --top 10\n`,
};

const WF_INPUTS: Record<StarterTemplate, string> = {
  'sma-cross': '--input fast=5,10,15,20 --input slow=30:100:10',
  rsi: '--input length=7,14,21 --input oversold=20:35:5',
  bollinger: '--input length=10,20,30 --input mult=1.5,2,2.5',
  macd: '--input fast=8,12,16 --input slow=26:34:4 --input signal=7,9,11',
};

const BODIES: Record<StarterTemplate, (title: string) => string> = {
  'sma-cross': (
    title,
  ) => `strategy("${title}", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)

// Two moving averages: a fast one that reacts quickly and a slow one that lags.
// When fast crosses ABOVE slow, momentum has turned up → go long. When it crosses
// back below, the trend is fading → flatten. Try other lengths with --input.
fastLen = input.int(10, "fast", minval=1)
slowLen = input.int(30, "slow", minval=1)

fast = ta.sma(close, fastLen)
slow = ta.sma(close, slowLen)

if ta.crossover(fast, slow)
    strategy.entry("long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("long")

// plot() series are also what \`scan --rank "last(fast)"\` can rank on.
plot(fast, title="fast")
plot(slow, title="slow")
`,

  rsi: (
    title,
  ) => `strategy("${title}", overlay=false, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)

// RSI measures momentum on a 0–100 scale. This is a MEAN-REVERSION play: buy as
// RSI climbs back out of "oversold" (a bounce), and exit as it pushes into
// "overbought". Tune the length and thresholds with --input.
length     = input.int(14, "length", minval=2)
oversold   = input.int(30, "oversold", minval=1, maxval=99)
overbought = input.int(70, "overbought", minval=1, maxval=99)

r = ta.rsi(close, length)

if ta.crossover(r, oversold)
    strategy.entry("long", strategy.long)
if ta.crossover(r, overbought)
    strategy.close("long")

plot(r, title="rsi")
hline(oversold, title="oversold")
hline(overbought, title="overbought")
`,

  bollinger: (
    title,
  ) => `strategy("${title}", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)

// Bollinger Bands are a moving-average "basis" with an upper/lower band \`mult\`
// standard deviations away. This is a BREAKOUT play: go long when price closes
// above the upper band (volatility expansion), exit when it falls back through
// the basis. Tune the window and band width with --input.
length = input.int(20, "length", minval=2)
mult   = input.float(2.0, "mult", minval=0.1, step=0.1)

[basis, upper, lower] = ta.bb(close, length, mult)

if ta.crossover(close, upper)
    strategy.entry("long", strategy.long)
if ta.crossunder(close, basis)
    strategy.close("long")

plot(basis, title="basis")
plot(upper, title="upper")
plot(lower, title="lower")
`,

  macd: (
    title,
  ) => `strategy("${title}", overlay=false, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)

// MACD = fast EMA − slow EMA, with a "signal" EMA of that line. This is a
// MOMENTUM play: go long when the MACD line crosses ABOVE its signal line and
// flatten on the opposite cross. Tune the three lengths with --input.
fastLen   = input.int(12, "fast", minval=1)
slowLen   = input.int(26, "slow", minval=1)
signalLen = input.int(9, "signal", minval=1)

[macdLine, signalLine, histLine] = ta.macd(close, fastLen, slowLen, signalLen)

if ta.crossover(macdLine, signalLine)
    strategy.entry("long", strategy.long)
if ta.crossunder(macdLine, signalLine)
    strategy.close("long")

plot(macdLine, title="macd")
plot(signalLine, title="signal")
plot(histLine, title="hist", style=plot.style_histogram)
`,
};

/**
 * Pine string literals are double-quoted; a title with a \`"\` would break the
 * generated \`strategy("...")\`. Strip quotes (and control chars) rather than
 * emit invalid Pine.
 */
function escapeTitle(title: string): string {
  return title.replace(/["\r\n]/g, '').trim() || 'My strategy';
}
