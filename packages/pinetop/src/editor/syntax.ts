/**
 * Pine syntax highlighting, one line at a time.
 *
 * Line-local is not a simplification here, it is correct: Pine has no multi-line
 * string and no block comment, so no lexical state crosses a line break. That
 * means a line can be coloured without knowing what came before it, which is
 * what lets the buffer pane draw only the rows it can see.
 *
 * This is a highlighter, not a parser. It never decides whether the script is
 * valid — `piner` does, and a colour that implied otherwise would be a second
 * opinion about the language (§3 NG1's reasoning, applied to the source).
 */

import { SYNTAX } from '../render/theme.js';
import type { Style } from '../render/theme.js';

/** A run of characters that share one style. Spans never overlap. */
export interface Span {
  start: number;
  length: number;
  style: Style;
}

/** Language keywords, including the type names Pine spells as keywords. */
const KEYWORDS = new Set([
  'and',
  'array',
  'bool',
  'break',
  'const',
  'continue',
  'else',
  'enum',
  'export',
  'false',
  'float',
  'for',
  'if',
  'import',
  'in',
  'input',
  'int',
  'map',
  'matrix',
  'method',
  'na',
  'not',
  'or',
  'return',
  'series',
  'simple',
  'string',
  'switch',
  'to',
  'true',
  'type',
  'var',
  'varip',
  'while',
]);

/**
 * Built-in namespaces, the bar series, and the top-level output functions —
 * everything the engine provides rather than the script. Namespaced calls
 * (`ta.rsi`, `strategy.entry`) are matched by their head, so the whole family
 * is covered without listing every member.
 */
const BUILTINS = new Set([
  'alert',
  'array',
  'bar_index',
  'barcolor',
  'barstate',
  'bgcolor',
  'box',
  'chart',
  'close',
  'color',
  'currency',
  'dayofmonth',
  'dayofweek',
  'display',
  'dividends',
  'earnings',
  'fill',
  'high',
  'hl2',
  'hlc3',
  'hlcc4',
  'hline',
  'hour',
  'indicator',
  'input',
  'label',
  'last_bar_index',
  'last_bar_time',
  'library',
  'line',
  'linefill',
  'location',
  'low',
  'map',
  'math',
  'matrix',
  'minute',
  'month',
  'nz',
  'ohlc4',
  'open',
  'order',
  'plot',
  'plotarrow',
  'plotbar',
  'plotcandle',
  'plotchar',
  'plotshape',
  'polyline',
  'position',
  'request',
  'runtime',
  'scale',
  'second',
  'session',
  'shape',
  'size',
  'splits',
  'str',
  'strategy',
  'syminfo',
  'ta',
  'table',
  'text',
  'time',
  'time_close',
  'time_tradingday',
  'timeframe',
  'timenow',
  'volume',
  'weekofyear',
  'xloc',
  'year',
  'yloc',
]);

const IDENT = /[A-Za-z_]/;
const IDENT_REST = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

function push(spans: Span[], start: number, length: number, style: Style): void {
  if (length <= 0 || style === SYNTAX.plain) return;
  spans.push({ start, length, style });
}

/**
 * The styled runs of one line. Only non-plain runs are returned — the caller
 * draws the line once in its base style and repaints these over it, so a
 * highlighter gap can never leave a hole in the text.
 */
export function highlight(line: string): Span[] {
  const spans: Span[] = [];
  let i = 0;

  while (i < line.length) {
    const ch = line[i]!;

    // A comment runs to the end of the line. `//@version=6` and the other
    // compiler annotations are called out separately: they are the one comment
    // form that changes how the script is compiled.
    if (ch === '/' && line[i + 1] === '/') {
      const rest = line.slice(i);
      push(spans, i, rest.length, /^\/\/\s*@/.test(rest) ? SYNTAX.annotation : SYNTAX.comment);
      return spans;
    }

    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      const end = Math.min(j, line.length);
      push(spans, i, end - i, SYNTAX.string);
      i = end;
      continue;
    }

    // A number, including `1.5`, `1e6`, `0x1F` and the `_` digit separator. A
    // leading `.` only counts when a digit follows, so `ta.sma` is not a number.
    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(line[i + 1] ?? ''))) {
      let j = i;
      while (j < line.length && /[0-9a-fA-FxX._]/.test(line[j]!)) j += 1;
      // Trailing `.` belongs to member access, not to the literal.
      while (j > i && line[j - 1] === '.') j -= 1;
      push(spans, i, j - i, SYNTAX.number);
      i = j;
      continue;
    }

    if (IDENT.test(ch)) {
      let j = i + 1;
      while (j < line.length && IDENT_REST.test(line[j]!)) j += 1;
      const word = line.slice(i, j);
      // A namespace head keeps its own colour and the member after the dot is
      // left plain: `ta` is the engine's, `rsi` is just a name in it.
      const style = KEYWORDS.has(word)
        ? SYNTAX.keyword
        : BUILTINS.has(word) && line[i - 1] !== '.'
          ? SYNTAX.builtin
          : SYNTAX.plain;
      push(spans, i, j - i, style);
      i = j;
      continue;
    }

    i += 1;
  }

  return spans;
}
