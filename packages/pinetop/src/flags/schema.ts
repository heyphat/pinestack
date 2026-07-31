/**
 * The flag surface, per command.
 *
 * §10.1 is an open question — a hand-written list will drift from `pinerun`.
 * Until the CLI can emit a machine-readable schema, this file mirrors the
 * structure of `HELP_SECTIONS` in `pinerun/src/cli.ts` rather than flattening
 * it: the shared groups below are the CLI's own "(as scan)" clause, so a flag
 * added to that clause is added here in one place and every command that
 * inherits it picks it up. `pinetop --check-flags` diffs these names against
 * `pinerun <cmd> --help` so drift is loud instead of silent.
 *
 * §9: `--api-key` / `--api-secret` are deliberately absent. Credentials never
 * enter the UI, are never persisted by pinetop, and must not appear in the
 * echoed command line — they travel in the environment, as the CLI's own help
 * recommends.
 */

export type FlagKind =
  | 'string'
  | 'number'
  | 'bool'
  /** `--flag` / `--no-flag` / absent — a Pine header override. */
  | 'tristate'
  /** Comma-separated list, e.g. --symbols a,b,c */
  | 'list'
  /** Repeatable name=value, e.g. --input fast=5 (REPEATABLE) */
  | 'pairs';

export interface FlagSpec {
  /** The long flag name without dashes. `positional` marks the script argument. */
  name: string;
  kind: FlagKind;
  /** Label shown in the config pane. Defaults to `--name`. */
  label?: string;
  /** Value shown when the flag is unset, e.g. the CLI's own default. */
  placeholder?: string;
  /** One-line help, shown in the run dialog. */
  help?: string;
  group: string;
  /** Hidden from the config pane but still composable (rarely-touched flags). */
  advanced?: boolean;
  /**
   * Reveal this advanced flag as soon as another flag's value makes it relevant.
   *
   * Without this, `--provider` is visible while `--data-dir` — which
   * `--provider csv` *requires* — is not, so choosing csv leaves the mandatory
   * companion flag invisible. A flag that another flag's value turns into a
   * requirement has to surface with it.
   */
  revealWhen?: { flag: string; equals: readonly string[] };
}

const RANGE: FlagSpec[] = [
  {
    name: 'tf',
    kind: 'string',
    group: 'range',
    placeholder: '1h',
    help: 'Timeframe: 1m 5m 15m 1h 4h 1d 1w',
  },
  { name: 'from', kind: 'string', group: 'range', help: 'Start (ISO date or unix seconds)' },
  { name: 'to', kind: 'string', group: 'range', help: 'End (ISO date or unix seconds)' },
  { name: 'limit', kind: 'number', group: 'range', help: 'Max bars per symbol' },
];

const DATA: FlagSpec[] = [
  {
    name: 'provider',
    kind: 'string',
    group: 'data',
    placeholder: 'binance',
    help: 'binance | okx | kraken | alpaca | massive | csv',
  },
  {
    name: 'asset-class',
    kind: 'string',
    group: 'data',
    help: 'crypto | futures (provider-dependent)',
  },
  {
    name: 'data-dir',
    kind: 'string',
    group: 'data',
    advanced: true,
    // `--provider csv` cannot run without this, so picking csv reveals it.
    revealWhen: { flag: 'provider', equals: ['csv'] },
    help: 'Directory of <SYMBOL>_<TF>.csv files (required by --provider csv)',
  },
  {
    name: 'feed',
    kind: 'string',
    group: 'data',
    advanced: true,
    revealWhen: { flag: 'provider', equals: ['alpaca'] },
    help: 'Alpaca data feed: iex | sip',
  },
  {
    name: 'csv-alignment',
    kind: 'string',
    group: 'data',
    advanced: true,
    revealWhen: { flag: 'provider', equals: ['csv'] },
    help: 'Assert CSV opens use the UTC fixed bar grid',
  },
  {
    name: 'csv-week-anchor',
    kind: 'string',
    group: 'data',
    advanced: true,
    revealWhen: { flag: 'provider', equals: ['csv'] },
    help: 'Opening timestamp on the asserted UTC weekly grid',
  },
  {
    name: 'csv-calendar',
    kind: 'string',
    group: 'data',
    advanced: true,
    revealWhen: { flag: 'provider', equals: ['csv'] },
    help: 'Exchange-session calendar JSON; conflicts with --csv-alignment',
  },
  {
    name: 'csv-complete-record',
    kind: 'bool',
    group: 'data',
    advanced: true,
    revealWhen: { flag: 'provider', equals: ['csv'] },
    help: 'Assert absent bars inside an authenticated record span mean no trades',
  },
  {
    name: 'no-security',
    kind: 'bool',
    group: 'data',
    advanced: true,
    help: 'Skip request.security resolution',
  },
];

const CACHE: FlagSpec[] = [
  { name: 'no-cache', kind: 'bool', group: 'cache', help: 'Disable the on-disk history cache' },
  {
    name: 'cache-dir',
    kind: 'string',
    group: 'cache',
    advanced: true,
    placeholder: '.pinery-cache',
  },
  { name: 'refresh', kind: 'bool', group: 'cache', help: 'Refresh cached history' },
];

const METRICS: FlagSpec[] = [
  {
    name: 'periods-per-year',
    kind: 'number',
    group: 'metrics',
    advanced: true,
    help: 'Annualization override (e.g. 252 for daily US equities)',
  },
  { name: 'risk-free-rate', kind: 'number', group: 'metrics', advanced: true, placeholder: '0' },
];

const INSTRUMENT: FlagSpec[] = [
  {
    name: 'mintick',
    kind: 'number',
    group: 'instrument',
    advanced: true,
    help: 'Tick size override',
  },
  {
    name: 'min-qty',
    kind: 'number',
    group: 'instrument',
    advanced: true,
    help: 'Lot step override',
  },
  {
    name: 'calc-on-order-fills',
    kind: 'tristate',
    group: 'instrument',
    advanced: true,
    help: "Override the script's calc_on_order_fills",
  },
  {
    name: 'bar-magnifier',
    kind: 'tristate',
    group: 'instrument',
    advanced: true,
    help: "Override strategy()'s use_bar_magnifier",
  },
];

const EXEC: FlagSpec[] = [
  {
    name: 'backend',
    kind: 'string',
    group: 'exec',
    placeholder: 'js',
    help: 'piner backend: js | interp',
  },
  {
    name: 'workers',
    kind: 'string',
    group: 'exec',
    advanced: true,
    help: 'Worker threads (n | local)',
  },
  {
    name: 'concurrency',
    kind: 'number',
    group: 'exec',
    advanced: true,
    help: 'Max jobs in flight',
  },
];

const EXPORT: FlagSpec[] = [
  { name: 'csv', kind: 'string', group: 'export', help: 'Write per-result CSV to this directory' },
  {
    name: 'plot',
    kind: 'string',
    group: 'export',
    help: 'Write a self-contained HTML chart per result',
  },
];

const RANKING: FlagSpec[] = [
  {
    name: 'rank',
    kind: 'string',
    group: 'rank',
    placeholder: 'strategy.netProfit',
    help: 'Ranking spec',
  },
  { name: 'top', kind: 'number', group: 'rank', help: 'Keep only the top N' },
  { name: 'asc', kind: 'bool', group: 'rank', help: 'Sort ascending' },
];

const CHART: FlagSpec[] = [{ name: 'no-chart', kind: 'bool', group: 'display' }];

/** The seven pages, in workflow order (§4.2). TRADES is a view, not a command. */
export const PAGES = [
  'backtest',
  'sweep',
  'walkforward',
  'scan',
  'portfolio',
  'compare',
  'trades',
] as const;

export type PageId = (typeof PAGES)[number];
/** The six pages that spawn something. */
export type CommandId = Exclude<PageId, 'trades'>;

export const COMMANDS: readonly CommandId[] = PAGES.filter((p): p is CommandId => p !== 'trades');

export const PAGE_TITLES: Record<PageId, string> = {
  backtest: 'BACKTEST',
  sweep: 'SWEEP',
  walkforward: 'WALKFORWARD',
  scan: 'SCAN',
  portfolio: 'PORTFOLIO',
  compare: 'COMPARE',
  trades: 'TRADES',
};

/** The docs' own verb for each page (§4.2). */
export const PAGE_PURPOSE: Record<PageId, string> = {
  backtest: 'analyze — one strategy, one symbol, full tearsheet',
  sweep: "optimize — one script's input grid",
  walkforward: 'validate — does the swept edge survive OOS',
  scan: 'screen — one script across N symbols',
  portfolio: 'combine — N symbols, one pot',
  compare: 'compare — two strategies, same bars',
  trades: 'the fills and the engine log for the loaded run',
};

export interface CommandSchema {
  id: CommandId;
  /** How many .pine paths the command takes. */
  scripts: 1 | 2;
  flags: FlagSpec[];
  /** Terminal columns this page needs before it starts dropping panes (§4.4). */
  minCols: number;
}

export const SCHEMAS: Record<CommandId, CommandSchema> = {
  backtest: {
    id: 'backtest',
    scripts: 1,
    minCols: 120,
    flags: [
      {
        name: 'symbol',
        kind: 'string',
        group: 'target',
        help: 'Single symbol to backtest (required)',
      },
      ...RANGE,
      {
        name: 'input',
        kind: 'pairs',
        group: 'inputs',
        label: '--input',
        help: 'Fixed input override (repeatable, one value each)',
      },
      { name: 'trades', kind: 'bool', group: 'display', help: 'Print the closed-trade ledger' },
      {
        name: 'watch',
        kind: 'number',
        group: 'display',
        advanced: true,
        help: 'Live mode; incompatible with --json',
      },
      ...CHART,
      ...DATA,
      ...CACHE,
      ...METRICS,
      ...INSTRUMENT,
      { name: 'backend', kind: 'string', group: 'exec', placeholder: 'js' },
      ...EXPORT,
    ],
  },
  sweep: {
    id: 'sweep',
    scripts: 1,
    minCols: 130,
    flags: [
      { name: 'symbol', kind: 'string', group: 'target' },
      {
        name: 'symbols',
        kind: 'list',
        group: 'target',
        help: 'Multi-symbol grid (symbol becomes an implicit axis)',
      },
      { name: 'universe', kind: 'string', group: 'target', help: 'File of symbols, one per line' },
      ...RANGE,
      {
        name: 'input',
        kind: 'pairs',
        group: 'axes',
        label: '--input',
        help: 'Swept axis: fast=5,10,20 or slow=30:100:10',
      },
      {
        name: 'sample',
        kind: 'number',
        group: 'axes',
        help: 'Run n randomly sampled combos instead of the grid',
      },
      {
        name: 'seed',
        kind: 'number',
        group: 'axes',
        placeholder: '42',
        help: 'PRNG seed for --sample',
      },
      {
        name: 'max-combos',
        kind: 'number',
        group: 'axes',
        placeholder: '5000',
        help: 'Cap on combos × symbols',
      },
      ...RANKING,
      {
        name: 'heatmap',
        kind: 'bool',
        group: 'display',
        help: 'Print the 2-axis optimization surface',
      },
      { name: 'trades', kind: 'bool', group: 'display' },
      ...CHART,
      {
        name: 'points-csv',
        kind: 'string',
        group: 'export',
        help: 'Write every run as one CSV row',
      },
      ...EXPORT,
      ...DATA,
      ...CACHE,
      ...METRICS,
      ...INSTRUMENT,
      ...EXEC,
    ],
  },
  walkforward: {
    id: 'walkforward',
    scripts: 1,
    minCols: 130,
    flags: [
      {
        name: 'symbol',
        kind: 'string',
        group: 'target',
        help: 'Single symbol to validate (required)',
      },
      ...RANGE,
      {
        name: 'input',
        kind: 'pairs',
        group: 'axes',
        label: '--input',
        help: 'Swept axis (same grammar as sweep)',
      },
      {
        name: 'windows',
        kind: 'number',
        group: 'plan',
        placeholder: '5',
        help: 'Walk-forward windows; 1 = plain IS/OOS split',
      },
      {
        name: 'oos',
        kind: 'number',
        group: 'plan',
        placeholder: '0.25',
        help: 'OOS share of each window, 0<f<1',
      },
      {
        name: 'anchored',
        kind: 'bool',
        group: 'plan',
        help: 'Expanding in-sample from bar 0 (default: rolling)',
      },
      {
        name: 'rank',
        kind: 'string',
        group: 'rank',
        placeholder: 'strategy.netProfit',
        help: "Metric that picks each window's winner",
      },
      { name: 'max-combos', kind: 'number', group: 'axes', advanced: true, placeholder: '5000' },
      ...CHART,
      ...DATA,
      ...CACHE,
      ...METRICS,
      ...INSTRUMENT,
      ...EXEC,
    ],
  },
  scan: {
    id: 'scan',
    scripts: 1,
    minCols: 110,
    flags: [
      { name: 'symbols', kind: 'list', group: 'target', help: 'Inline symbol list' },
      { name: 'universe', kind: 'string', group: 'target', help: 'File of symbols, one per line' },
      ...RANGE,
      ...RANKING,
      { name: 'trades', kind: 'bool', group: 'display' },
      ...CHART,
      ...EXPORT,
      ...DATA,
      ...CACHE,
      ...METRICS,
      ...INSTRUMENT,
      ...EXEC,
    ],
  },
  portfolio: {
    id: 'portfolio',
    scripts: 1,
    minCols: 120,
    flags: [
      { name: 'symbols', kind: 'list', group: 'target', help: 'Basket, in PRIORITY order' },
      { name: 'universe', kind: 'string', group: 'target' },
      {
        name: 'mode',
        kind: 'string',
        group: 'capital',
        placeholder: 'isolated',
        help: 'isolated | shared',
      },
      {
        name: 'capital',
        kind: 'number',
        group: 'capital',
        help: "Total pot (default N × the script's initial_capital)",
      },
      {
        name: 'weights',
        kind: 'string',
        group: 'capital',
        help: 'Per-symbol funding fractions, isolated mode only',
      },
      ...RANGE,
      {
        name: 'input',
        kind: 'pairs',
        group: 'inputs',
        label: '--input',
        help: 'Fixed override applied to every sleeve',
      },
      { name: 'trades', kind: 'bool', group: 'display' },
      ...CHART,
      ...EXPORT,
      ...DATA,
      ...CACHE,
      ...METRICS,
      { name: 'backend', kind: 'string', group: 'exec', placeholder: 'js' },
      { name: 'concurrency', kind: 'number', group: 'exec', advanced: true },
    ],
  },
  compare: {
    id: 'compare',
    scripts: 2,
    minCols: 100,
    flags: [
      {
        name: 'symbol',
        kind: 'string',
        group: 'target',
        help: 'The symbol both strategies run on (required)',
      },
      ...RANGE,
      {
        name: 'input-a',
        kind: 'pairs',
        group: 'inputs',
        label: '--input-a',
        help: 'Fixed input override for script A',
      },
      {
        name: 'input-b',
        kind: 'pairs',
        group: 'inputs',
        label: '--input-b',
        help: 'Fixed input override for script B',
      },
      { name: 'label-a', kind: 'string', group: 'inputs', help: 'Column/legend label for A' },
      { name: 'label-b', kind: 'string', group: 'inputs', help: 'Column/legend label for B' },
      ...CHART,
      ...DATA,
      ...CACHE,
      ...METRICS,
      { name: 'backend', kind: 'string', group: 'exec', placeholder: 'js' },
      { name: 'bar-magnifier', kind: 'tristate', group: 'instrument', advanced: true },
    ],
  },
};

/**
 * Flags this schema deliberately omits, so `--check-flags` can tell an
 * intentional exclusion from drift.
 *
 * `--api-key` / `--api-secret` are §9: credentials never enter the UI, are never
 * persisted, and must be redacted from the echoed command line — so they are not
 * modelled at all and travel in the environment instead. `--json` is added by
 * the spawn path, and `--help` / `--version` are not run configuration.
 */
export const INTENTIONALLY_ABSENT: ReadonlySet<string> = new Set([
  'api-key',
  'api-secret',
  'json',
  'help',
  'version',
]);

export function schemaFor(command: CommandId): CommandSchema {
  return SCHEMAS[command];
}

export function flagSpec(command: CommandId, name: string): FlagSpec | undefined {
  return SCHEMAS[command].flags.find((f) => f.name === name);
}
