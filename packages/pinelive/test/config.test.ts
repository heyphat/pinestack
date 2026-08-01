import { describe, expect, test } from 'bun:test';
import { parseRunConfig } from '../src/cli.js';
import {
  DEFAULT_LIVE_RECONNECT_ATTEMPTS,
  DEFAULT_LIVE_RECONNECT_DELAY_MS,
  DEFAULT_LIVE_RECONNECT_MAX_DELAY_MS,
  DEFAULT_LIVE_THROTTLE_MS,
  DEFAULT_MAX_PENDING_FINALS,
  normalizeRunConfig,
  validateCompiledIntrabarConfig,
  type NormalizedV2RunConfig,
} from '../src/core/config.js';

const csvData = { provider: 'csv', dataDir: '/path/need/not/exist', cutoverTime: 1 } as const;

function v1(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    strategy: 'strategy.pine',
    symbol: 'X',
    timeframe: '1m',
    data: csvData,
    broker: { id: 'paper' },
    ...overrides,
  };
}

function v2(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    configVersion: 2,
    strategy: 'strategy.pine',
    symbol: 'X',
    timeframe: '5m',
    data: csvData,
    execution: { kind: 'compute-only' },
    ...overrides,
  };
}

function everyUpdate(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    cadence: 'every-update',
    source: { kind: 'native' },
    ...overrides,
  };
}

function paperMirrored(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    kind: 'mirrored',
    mirrorOn: 'bar-close',
    broker: { id: 'paper' },
    ledger: { path: '/path/need/not/exist/ledger.jsonl', durability: 'sync' },
    lease: { path: '/path/need/not/exist/run.lease' },
    ...overrides,
  };
}

function enabledSecurity(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    enabled: true,
    maxExactSecurityFeeds: 8,
    maxExactSecurityBarsPerFeed: 1_000,
    maxExactSecurityTotalBars: 4_000,
    ...overrides,
  };
}

function normalizedV2(value: Record<string, unknown>): NormalizedV2RunConfig {
  const normalized = normalizeRunConfig(value);
  if (normalized.configVersion !== 2) throw new Error('test expected v2 config');
  return normalized;
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected function to throw');
}

describe('v1 compatibility', () => {
  test('normalizes accepted v1 values exactly like parseRunConfig', () => {
    const accepted = [
      v1(),
      v1({ configVersion: 1, broker: undefined }),
      v1({
        configVersion: null,
        warmupBars: 0,
        inputs: { length: 7, enabled: false },
        executionId: '',
        reconcileOnStart: false,
        resolveSecurity: false,
        armed: false,
        ledger: '',
      }),
      v1({
        order: { type: 'limit', limitOffsetTicks: 0 },
        securityWarmupBars: 10,
        maxSecurityBars: 10,
        maxSecurityFeeds: 2,
        securityConcurrency: 1,
        securityRequestTimeoutMs: 1,
        maxSecurityStaleRefreshes: 0,
      }),
      v1({
        broker: {
          id: 'paper',
          initialBalance: -1,
          slippageBps: -2,
          commissionPerUnit: -3,
        },
      }),
      v1({
        symbol: 'TG:FU:MGC',
        data: { provider: 'tiger', assetClass: 'futures' },
        broker: { id: 'tiger', account: '', orderPollIntervalMs: 0, maxOrderPolls: 0 },
        tigerProfile: '/profile.properties',
      }),
      v1({
        order: null,
        inputs: null,
        warmupBars: null,
        reconcileOnStart: null,
        resolveSecurity: null,
        executionId: null,
        ledger: null,
        armed: null,
      }),
    ];

    for (const input of accepted) {
      expect(normalizeRunConfig(input)).toEqual(parseRunConfig(input));
    }
  });

  test('rejects invalid v1 values with the same error and ordering', () => {
    const rejected = [
      v1({ unexpected: true }),
      v1({ configVersion: 3 }),
      v1({ strategy: '' }),
      v1({ warmupBars: -1 }),
      v1({ order: { type: 'market', limitOffsetTicks: 1 } }),
      v1({ securityWarmupBars: 2, maxSecurityBars: 1 }),
      v1({ data: { provider: 'unknown' } }),
      v1({ broker: { id: 'paper', profile: 'forbidden' } }),
      v1({
        order: { type: 'limit' },
        broker: { id: 'tiger', cancelStuckOrders: false },
      }),
      v1({ reconcileOnStart: 'false' }),
      v1({ inputs: [] }),
    ];

    for (const input of rejected) {
      expect(thrownMessage(() => normalizeRunConfig(input))).toBe(
        thrownMessage(() => parseRunConfig(input)),
      );
    }
  });
});

describe('v2 normalized discriminants', () => {
  test('defaults only to standard history, bar-close cadence, disabled security, and market order', () => {
    expect(normalizeRunConfig(v2())).toEqual({
      configVersion: 2,
      strategy: 'strategy.pine',
      symbol: 'X',
      timeframe: '5m',
      data: csvData,
      historical: { mode: 'standard' },
      live: { cadence: 'bar-close' },
      security: { enabled: false },
      execution: { kind: 'compute-only' },
    });

    expect(
      normalizeRunConfig(
        v2({
          inputs: { period: 5 },
          historical: {
            mode: 'bar-magnifier',
            maxMagnifierTargetBars: 100_000,
            maxMagnifierRawBars: 500_000,
          },
          security: enabledSecurity(),
          execution: paperMirrored(),
        }),
      ),
    ).toMatchObject({
      inputs: { period: 5 },
      historical: {
        mode: 'bar-magnifier',
        maxMagnifierTargetBars: 100_000,
        maxMagnifierRawBars: 500_000,
      },
      security: {
        enabled: true,
        concurrency: 4,
        requestTimeoutMs: 30_000,
        maxStaleRefreshes: 0,
      },
      execution: {
        kind: 'mirrored',
        mirrorOn: 'bar-close',
        order: { type: 'market' },
        reconcileOnStart: false,
      },
    });
  });

  test('normalizes every-update live settings and keeps every-update Paper effects fail-closed', () => {
    expect(
      normalizeRunConfig(
        v2({
          live: everyUpdate({ source: { kind: 'lower-bars', timeframe: '1m' } }),
          execution: { kind: 'compute-only' },
        }),
      ),
    ).toMatchObject({
      live: {
        cadence: 'every-update',
        source: { kind: 'lower-bars', timeframe: '1m' },
        throttleMs: DEFAULT_LIVE_THROTTLE_MS,
        maxPendingFinals: DEFAULT_MAX_PENDING_FINALS,
        reconnectAttempts: DEFAULT_LIVE_RECONNECT_ATTEMPTS,
        reconnectDelayMs: DEFAULT_LIVE_RECONNECT_DELAY_MS,
        reconnectMaxDelayMs: DEFAULT_LIVE_RECONNECT_MAX_DELAY_MS,
      },
      execution: { kind: 'compute-only' },
    });

    expect(() =>
      normalizeRunConfig(
        v2({
          live: everyUpdate({ source: { kind: 'lower-bars', timeframe: '1m' } }),
          execution: paperMirrored({
            mirrorOn: 'every-update',
            intrabarExecutionArmed: true,
          }),
        }),
      ),
    ).toThrow(
      'Paper mirrorOn "every-update" is unavailable because the public piner runtime does not expose a provable pending-order/fill lifecycle',
    );
  });

  test('allows every-update compute-only and explicitly armed Paper bar-close mirroring', () => {
    expect(
      normalizeRunConfig(v2({ live: everyUpdate(), execution: { kind: 'compute-only' } })),
    ).toMatchObject({ execution: { kind: 'compute-only' } });

    expect(
      normalizeRunConfig(
        v2({
          live: everyUpdate(),
          execution: paperMirrored({ intrabarExecutionArmed: true }),
        }),
      ),
    ).toMatchObject({
      execution: {
        kind: 'mirrored',
        mirrorOn: 'bar-close',
        intrabarExecutionArmed: true,
      },
    });
  });

  test('allows existing close-only Tiger mirroring but blocks every Tiger intrabar path', () => {
    expect(
      normalizeRunConfig(
        v2({
          execution: {
            kind: 'mirrored',
            mirrorOn: 'bar-close',
            broker: { id: 'tiger', account: 'paper' },
            armed: true,
            ledger: { path: 'ledger.jsonl', durability: 'sync' },
            lease: { path: 'run.lease' },
          },
        }),
      ),
    ).toMatchObject({
      execution: { broker: { id: 'tiger', account: 'paper' }, armed: true },
    });

    expect(() =>
      normalizeRunConfig(
        v2({
          live: everyUpdate(),
          execution: {
            kind: 'mirrored',
            mirrorOn: 'bar-close',
            broker: { id: 'tiger' },
          },
        }),
      ),
    ).toThrow(
      'Tiger intrabar execution is unavailable until the credentialed release gate passes; offline facade evidence is insufficient',
    );
  });
});

describe('v2 strict structural rejection', () => {
  test('compute-only structurally rejects every broker/execution ownership key', () => {
    for (const [key, value] of Object.entries({
      broker: { id: 'paper' },
      account: 'paper',
      order: { type: 'market' },
      armed: true,
      intrabarExecutionArmed: true,
      executionId: 'run',
      reconcileOnStart: false,
      scheduler: {},
      ledger: { path: 'ledger.jsonl', durability: 'sync' },
      lease: { path: 'run.lease' },
      brokerFactory: () => {
        throw new Error('must not run');
      },
    })) {
      expect(() =>
        normalizeRunConfig(v2({ execution: { kind: 'compute-only', [key]: value } })),
      ).toThrow(`config.execution.${key} is not allowed`);
    }
  });

  test('rejects unknown and wrong-discriminant fields instead of ignoring them', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [v2({ broker: { id: 'paper' } }), 'config.broker is not allowed'],
      [
        v2({ historical: { mode: 'standard', maxMagnifierRawBars: 10 } }),
        'config.historical.maxMagnifierRawBars is not allowed',
      ],
      [
        v2({ historical: { mode: 'bar-magnifier', sourceTimeframe: '1m' } }),
        'config.historical.sourceTimeframe is not allowed',
      ],
      [
        v2({ live: { cadence: 'bar-close', source: { kind: 'native' } } }),
        'config.live.source is not allowed',
      ],
      [
        v2({ live: everyUpdate({ source: { kind: 'native', timeframe: '1m' } }) }),
        'config.live.source.timeframe is not allowed',
      ],
      [
        v2({ security: { enabled: false, maxExactSecurityFeeds: 1 } }),
        'config.security.maxExactSecurityFeeds is not allowed',
      ],
      [
        v2({ execution: paperMirrored({ armed: true }) }),
        'config.execution.armed is only valid for the Tiger broker',
      ],
      [
        v2({ execution: paperMirrored({ broker: { id: 'paper', account: 'x' } }) }),
        'config.execution.broker.account is not allowed',
      ],
      [
        v2({ execution: paperMirrored({ order: { type: 'market', limitOffsetTicks: 0 } }) }),
        'config.execution.order.limitOffsetTicks is only valid for limit orders',
      ],
      [
        v2({ execution: paperMirrored({ scheduler: {} }) }),
        'config.execution.scheduler is unavailable while mirrorOn "every-update" is fail-closed',
      ],
      [
        v2({ execution: paperMirrored({ intrabarExecutionArmed: true }) }),
        'config.execution.intrabarExecutionArmed is only valid for every-update cadence',
      ],
      [
        v2({ execution: paperMirrored({ mirrorOn: 'every-update' }) }),
        'config.execution.mirrorOn "every-update" requires every-update cadence',
      ],
    ];

    for (const [input, message] of cases) {
      expect(() => normalizeRunConfig(input)).toThrow(message);
    }
  });

  test('every-update requires live source settings and forbids security/reconciliation', () => {
    expect(() => normalizeRunConfig(v2({ live: { cadence: 'every-update' } }))).toThrow(
      'config.live.source must be an object',
    );
    expect(() =>
      normalizeRunConfig(v2({ live: everyUpdate(), security: enabledSecurity() })),
    ).toThrow('config.security.enabled must be false for every-update');
    expect(() =>
      normalizeRunConfig(
        v2({
          live: everyUpdate(),
          execution: paperMirrored({
            reconcileOnStart: false,
            intrabarExecutionArmed: true,
          }),
        }),
      ),
    ).toThrow('config.execution.reconcileOnStart is not allowed for every-update');
    expect(() =>
      normalizeRunConfig(v2({ live: everyUpdate(), execution: paperMirrored() })),
    ).toThrow(
      'every-update mirrored execution requires config.execution.intrabarExecutionArmed=true',
    );
  });

  test('mirrored mode requires an explicit sync ledger and exclusive lease path', () => {
    expect(() =>
      normalizeRunConfig(v2({ execution: paperMirrored({ ledger: undefined }) })),
    ).toThrow('config.execution.ledger must be an object');
    expect(() =>
      normalizeRunConfig(
        v2({
          execution: paperMirrored({ ledger: { path: 'ledger.jsonl', durability: 'buffered' } }),
        }),
      ),
    ).toThrow('config.execution.ledger.durability must be "sync"');
    expect(() =>
      normalizeRunConfig(v2({ execution: paperMirrored({ lease: undefined }) })),
    ).toThrow('config.execution.lease must be an object');
    expect(() =>
      normalizeRunConfig(v2({ execution: paperMirrored({ lease: { path: '' } }) })),
    ).toThrow('config.execution.lease.path must be a non-empty string');
    expect(() =>
      normalizeRunConfig(
        v2({
          execution: paperMirrored({
            ledger: { path: 'same', durability: 'sync' },
            lease: { path: 'same' },
          }),
        }),
      ),
    ).toThrow('config.execution.ledger.path and lease.path must be different');
  });

  test('v2 rejects explicit null instead of inheriting v1 omission semantics', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [v2({ warmupBars: null }), 'config.warmupBars must be a non-negative safe integer'],
      [v2({ inputs: null }), 'config.inputs must be an object'],
      [v2({ inputs: { nested: [1, null] } }), 'config.inputs.nested.1 must not be null'],
      [
        v2({ data: { provider: 'csv', dataDir: '/tmp', cutoverTime: 1, paceMs: null } }),
        'config.data.paceMs must not be null',
      ],
      [
        v2({
          data: {
            provider: 'tiger',
            assetClass: 'futures',
            transport: {
              resolveFuture() {},
              bars() {},
              connect: null,
            },
          },
        }),
        'config.data.transport.connect must not be null',
      ],
      [v2({ historical: null }), 'config.historical must be an object'],
      [v2({ live: everyUpdate({ throttleMs: null }) }), 'config.live.throttleMs'],
      [v2({ security: enabledSecurity({ concurrency: null }) }), 'config.security.concurrency'],
      [
        v2({ execution: paperMirrored({ broker: { id: 'paper', initialBalance: null } }) }),
        'config.execution.broker.initialBalance',
      ],
      [
        v2({
          execution: {
            kind: 'mirrored',
            mirrorOn: 'bar-close',
            broker: { id: 'tiger', account: null },
            ledger: { path: 'ledger.jsonl', durability: 'sync' },
            lease: { path: 'run.lease' },
          },
        }),
        'config.execution.broker.account',
      ],
      [
        v2({ execution: paperMirrored({ reconcileOnStart: null }) }),
        'config.execution.reconcileOnStart must be boolean',
      ],
    ];

    for (const [input, message] of cases) {
      expect(() => normalizeRunConfig(input)).toThrow(message);
    }
  });
});

describe('v2 bounds and relationships', () => {
  test('validates independent magnifier and exact-security budgets', () => {
    for (const [key, value] of [
      ['maxMagnifierTargetBars', 0],
      ['maxMagnifierRawBars', 0],
      ['maxMagnifierRawBars', Number.MAX_SAFE_INTEGER + 1],
    ] as const) {
      expect(() =>
        normalizeRunConfig(
          v2({
            historical: {
              mode: 'bar-magnifier',
              maxMagnifierTargetBars: 10,
              maxMagnifierRawBars: 20,
              [key]: value,
            },
          }),
        ),
      ).toThrow(`config.historical.${key} must be a positive safe integer`);
    }
    expect(() =>
      normalizeRunConfig(
        v2({
          historical: {
            mode: 'bar-magnifier',
            maxMagnifierTargetBars: 21,
            maxMagnifierRawBars: 20,
          },
        }),
      ),
    ).toThrow('maxMagnifierTargetBars must not exceed maxMagnifierRawBars');

    for (const key of [
      'maxExactSecurityFeeds',
      'maxExactSecurityBarsPerFeed',
      'maxExactSecurityTotalBars',
    ] as const) {
      expect(() => normalizeRunConfig(v2({ security: enabledSecurity({ [key]: 0 }) }))).toThrow(
        `config.security.${key} must be a positive safe integer`,
      );
    }
    expect(() =>
      normalizeRunConfig(
        v2({
          security: enabledSecurity({
            maxExactSecurityBarsPerFeed: 101,
            maxExactSecurityTotalBars: 100,
          }),
        }),
      ),
    ).toThrow('maxExactSecurityBarsPerFeed must not exceed maxExactSecurityTotalBars');
    expect(() =>
      normalizeRunConfig(
        v2({ security: enabledSecurity({ maxExactSecurityFeeds: 2, concurrency: 3 }) }),
      ),
    ).toThrow('config.security.concurrency must not exceed maxExactSecurityFeeds');
    expect(() =>
      normalizeRunConfig(v2({ security: enabledSecurity({ maxStaleRefreshes: -1 }) })),
    ).toThrow('config.security.maxStaleRefreshes must be a non-negative safe integer');
  });

  test('validates every live bound, backoff relationship, and exact child timeframe', () => {
    const invalid: Array<[string, number, string]> = [
      ['throttleMs', -1, 'a safe integer from 0 to 60000'],
      ['throttleMs', 60_001, 'a safe integer from 0 to 60000'],
      ['maxPendingFinals', 0, 'a safe integer from 1 to 10000'],
      ['reconnectAttempts', 101, 'a safe integer from 0 to 100'],
      ['reconnectDelayMs', -1, 'a safe integer from 0 to 60000'],
      ['reconnectMaxDelayMs', 300_001, 'a safe integer from 1 to 300000'],
    ];
    for (const [key, value, constraint] of invalid) {
      expect(() => normalizeRunConfig(v2({ live: everyUpdate({ [key]: value }) }))).toThrow(
        `config.live.${key} must be ${constraint}`,
      );
    }
    expect(() =>
      normalizeRunConfig(
        v2({ live: everyUpdate({ reconnectDelayMs: 100, reconnectMaxDelayMs: 99 }) }),
      ),
    ).toThrow('config.live.reconnectMaxDelayMs must not be below reconnectDelayMs');
    for (const timeframe of ['5m', '2m', 'M', '']) {
      expect(() =>
        normalizeRunConfig(
          v2({ live: everyUpdate({ source: { kind: 'lower-bars', timeframe } }) }),
        ),
      ).toThrow();
    }
  });

  test('validates broker and order bounds while the every-update scheduler remains unavailable', () => {
    expect(() =>
      normalizeRunConfig(
        v2({
          live: everyUpdate(),
          execution: paperMirrored({
            mirrorOn: 'every-update',
            intrabarExecutionArmed: true,
            scheduler: { maxOrdersPerBar: 1 },
          }),
        }),
      ),
    ).toThrow('Paper mirrorOn "every-update" is unavailable');
    for (const [field, value] of [
      ['initialBalance', 0],
      ['slippageBps', -1],
      ['commissionPerUnit', -1],
    ] as const) {
      expect(() =>
        normalizeRunConfig(
          v2({ execution: paperMirrored({ broker: { id: 'paper', [field]: value } }) }),
        ),
      ).toThrow(`config.execution.broker.${field}`);
    }
    expect(() =>
      normalizeRunConfig(
        v2({
          execution: paperMirrored({ order: { type: 'limit', limitOffsetTicks: -1 } }),
        }),
      ),
    ).toThrow('config.execution.order.limitOffsetTicks must be a non-negative safe integer');
    expect(() =>
      normalizeRunConfig(
        v2({
          execution: {
            kind: 'mirrored',
            mirrorOn: 'bar-close',
            broker: { id: 'tiger', maxOrderPolls: 0 },
            ledger: { path: 'ledger.jsonl', durability: 'sync' },
            lease: { path: 'run.lease' },
          },
        }),
      ),
    ).toThrow('config.execution.broker.maxOrderPolls must be a positive safe integer');
  });
});

describe('compiled intrabar source gates', () => {
  const everyUpdateConfig = () =>
    normalizedV2(v2({ live: everyUpdate(), execution: { kind: 'compute-only' } }));
  const magnifierConfig = (security: Record<string, unknown> = { enabled: false }) =>
    normalizedV2(
      v2({
        historical: {
          mode: 'bar-magnifier',
          maxMagnifierTargetBars: 100,
          maxMagnifierRawBars: 500,
        },
        security,
      }),
    );

  test('requires a strategy and exact calc_on_every_tick=true metadata', () => {
    expect(() =>
      validateCompiledIntrabarConfig(
        { isStrategy: false, strategy: {}, securityDependencies: [] },
        everyUpdateConfig(),
      ),
    ).toThrow('compiled source must be a strategy');
    for (const strategy of [{}, { calcOnEveryTick: false }, { calcOnEveryTick: 'true' }]) {
      expect(() =>
        validateCompiledIntrabarConfig(
          { isStrategy: true, strategy, securityDependencies: [] },
          everyUpdateConfig(),
        ),
      ).toThrow('requires strategy(calc_on_every_tick=true)');
    }
    expect(() =>
      validateCompiledIntrabarConfig(
        { isStrategy: true, strategy: { calcOnEveryTick: true }, securityDependencies: [] },
        everyUpdateConfig(),
      ),
    ).not.toThrow();
  });

  test('fails closed on absent, enabled, or nonempty every-update security metadata', () => {
    expect(() =>
      validateCompiledIntrabarConfig(
        { isStrategy: true, strategy: { calcOnEveryTick: true } },
        everyUpdateConfig(),
      ),
    ).toThrow('compiled security dependency metadata must be a complete array');
    expect(() =>
      validateCompiledIntrabarConfig(
        {
          isStrategy: true,
          strategy: { calcOnEveryTick: true },
          securityDependencies: [{ dynamic: false }],
        },
        everyUpdateConfig(),
      ),
    ).toThrow('every-update rejects every request.security');

    const forged = {
      ...everyUpdateConfig(),
      security: {
        enabled: true,
        maxExactSecurityFeeds: 1,
        maxExactSecurityBarsPerFeed: 1,
        maxExactSecurityTotalBars: 1,
        concurrency: 1,
        requestTimeoutMs: 1,
        maxStaleRefreshes: 0,
      },
    } as NormalizedV2RunConfig;
    expect(() =>
      validateCompiledIntrabarConfig(
        { isStrategy: true, strategy: { calcOnEveryTick: true }, securityDependencies: [] },
        forged,
      ),
    ).toThrow('every-update does not allow security resolution to be enabled');
  });

  test('rejects disabled, dynamic, and incompletely classified security dependencies', () => {
    expect(() =>
      validateCompiledIntrabarConfig(
        { isStrategy: true, strategy: {}, securityDependencies: [{ dynamic: false }] },
        normalizedV2(v2()),
      ),
    ).toThrow('config.security.enabled is false');
    for (const dependency of [
      {
        dynamic: true,
        lowerTf: false,
        self: true,
        symbol: null,
        tfSelf: true,
        timeframe: null,
        lookahead: false,
        expressionPriorBars: 0,
      },
      { dynamic: false, lowerTf: false, self: true, symbol: null, timeframe: null },
      {
        dynamic: false,
        lowerTf: false,
        self: true,
        symbol: 'inconsistent',
        tfSelf: true,
        timeframe: null,
        lookahead: false,
        expressionPriorBars: 0,
      },
      {
        dynamic: false,
        lowerTf: true,
        self: true,
        symbol: null,
        tfSelf: false,
        timeframe: '1',
        lookahead: false,
        expressionPriorBars: 0,
      },
      {
        dynamic: false,
        lowerTf: false,
        self: true,
        symbol: null,
        tfSelf: false,
        timeframe: 'D',
        lookahead: false,
        expressionPriorBars: null,
      },
    ]) {
      expect(() =>
        validateCompiledIntrabarConfig(
          { isStrategy: true, strategy: {}, securityDependencies: [dependency] },
          magnifierConfig(enabledSecurity()),
        ),
      ).toThrow('statically and completely classified');
    }
    expect(() =>
      validateCompiledIntrabarConfig(
        {
          isStrategy: true,
          strategy: {},
          securityDependencies: [
            {
              dynamic: false,
              lowerTf: false,
              self: true,
              symbol: null,
              tfSelf: false,
              timeframe: 'D',
              lookahead: false,
              expressionPriorBars: 3,
            },
          ],
        },
        magnifierConfig(enabledSecurity()),
      ),
    ).not.toThrow();
  });

  test('rejects missing strategy metadata and the pinned-runtime magnifier plus COOF combination', () => {
    for (const strategy of [undefined, 'invalid', []]) {
      expect(() =>
        validateCompiledIntrabarConfig(
          { isStrategy: true, strategy, securityDependencies: [] },
          magnifierConfig(),
        ),
      ).toThrow('compiled strategy metadata must be an object');
    }
    expect(() =>
      validateCompiledIntrabarConfig(
        {
          isStrategy: true,
          strategy: { calcOnOrderFills: true },
          securityDependencies: [],
        },
        magnifierConfig(),
      ),
    ).toThrow(
      'bar-magnifier with calc_on_order_fills=true is unsupported by the pinned piner runtime',
    );
    expect(() =>
      validateCompiledIntrabarConfig(
        {
          isStrategy: true,
          strategy: { calcOnOrderFills: false },
          securityDependencies: [],
        },
        magnifierConfig(),
      ),
    ).not.toThrow();
  });
});

describe('normalization and rejection are pure', () => {
  test('never invokes provider transports, broker-like factories, credentials, or file paths', () => {
    let calls = 0;
    const poison = () => {
      calls++;
      throw new Error('I/O-like callback was invoked');
    };
    const tigerData = {
      provider: 'tiger',
      assetClass: 'futures',
      profile: '/credentials/need/not/exist.properties',
      transport: { resolveFuture: poison, bars: poison, connect: poison, disconnect: poison },
    } as const;

    expect(
      normalizeRunConfig(
        v1({
          symbol: 'TG:FU:MGC',
          data: tigerData,
          broker: { id: 'paper' },
        }),
      ),
    ).toMatchObject({ data: tigerData });
    expect(
      normalizeRunConfig(
        v2({
          data: tigerData,
          execution: paperMirrored(),
        }),
      ),
    ).toMatchObject({
      data: tigerData,
      execution: {
        ledger: { path: '/path/need/not/exist/ledger.jsonl', durability: 'sync' },
        lease: { path: '/path/need/not/exist/run.lease' },
      },
    });
    expect(calls).toBe(0);

    const rejectedConfigs = [
      v2({
        data: tigerData,
        execution: { kind: 'compute-only', brokerFactory: poison },
      }),
      v2({
        data: tigerData,
        historical: {
          mode: 'bar-magnifier',
          maxMagnifierTargetBars: 2,
          maxMagnifierRawBars: 1,
        },
      }),
      v2({
        data: tigerData,
        live: everyUpdate({ reconnectDelayMs: 2, reconnectMaxDelayMs: 1 }),
      }),
      v2({
        data: tigerData,
        security: enabledSecurity({ maxExactSecurityFeeds: 1, concurrency: 2 }),
      }),
      v2({
        data: tigerData,
        execution: paperMirrored({ broker: { id: 'paper', initialBalance: -1 } }),
      }),
      v2({
        data: tigerData,
        execution: paperMirrored({
          ledger: { path: '/path/need/not/exist/ledger.jsonl', durability: 'buffered' },
        }),
      }),
      v2({
        data: tigerData,
        execution: paperMirrored({ lease: { path: '' } }),
      }),
      v2({
        data: tigerData,
        live: everyUpdate(),
        execution: {
          kind: 'mirrored',
          mirrorOn: 'bar-close',
          broker: { id: 'tiger' },
        },
      }),
      v2({ data: tigerData, inputs: null }),
      v2({ data: tigerData, inputs: { nested: { value: null } } }),
      v2({
        data: {
          provider: 'tiger',
          assetClass: 'futures',
          transport: { resolveFuture: poison, bars: poison, connect: null },
        },
      }),
    ];
    for (const input of rejectedConfigs) {
      expect(() => normalizeRunConfig(input)).toThrow();
      expect(calls).toBe(0);
    }

    const config = normalizedV2(v2({ live: everyUpdate(), data: tigerData }));
    for (const metadata of [
      {
        isStrategy: true,
        strategy: { calcOnEveryTick: false, providerFactory: poison },
        securityDependencies: [],
      },
      {
        isStrategy: true,
        strategy: { calcOnEveryTick: true, providerFactory: poison },
        securityDependencies: [{ dynamic: false }],
      },
    ]) {
      expect(() => validateCompiledIntrabarConfig(metadata, config)).toThrow();
      expect(calls).toBe(0);
    }

    const magnifier = normalizedV2(
      v2({
        data: tigerData,
        historical: {
          mode: 'bar-magnifier',
          maxMagnifierTargetBars: 1,
          maxMagnifierRawBars: 1,
        },
      }),
    );
    expect(() =>
      validateCompiledIntrabarConfig(
        {
          isStrategy: true,
          strategy: { calcOnOrderFills: true, providerFactory: poison },
          securityDependencies: [],
        },
        magnifier,
      ),
    ).toThrow('calc_on_order_fills=true');
    expect(calls).toBe(0);
  });
});
