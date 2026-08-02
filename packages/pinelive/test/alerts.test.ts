import { expect, test } from 'bun:test';
import { ReplayProvider, StaticProvider, type MarketDataProvider } from '@heyphat/pinery';
import {
  AlertDispatcher,
  ForwardRunner,
  MAX_ALERT_MESSAGE_LENGTH,
  MemoryLedger,
  PaperBroker,
  WebhookAlertChannel,
  alertFrequencyGate,
  coarseReason,
  normalizeAlertMessage,
  normalizeRunConfig,
  webhookAlertPayload,
  type AlertChannel,
  type AlertDispatchRecord,
  type LedgerRecord,
  type LedgerSink,
  type StrategyAlert,
} from '../src/index.js';
import { runAlertChannelConformance } from '../src/testing/index.js';

// ---------------------------------------------------------------------------
// Frequency gate — the fractal frequencyGate shape: pure, sample-time only.
// ---------------------------------------------------------------------------

test('alertFrequencyGate mirrors the fractal gate semantics', () => {
  const closed = { barTime: 60, closed: true };
  const forming = { barTime: 60, closed: false };
  expect(alertFrequencyGate('all', {}, closed).emit).toBe(true);
  expect(alertFrequencyGate('all', { lastFiredBarTime: 60 }, closed).emit).toBe(true);
  expect(alertFrequencyGate('once_per_bar', {}, forming).emit).toBe(true);
  expect(alertFrequencyGate('once_per_bar', { lastFiredBarTime: 60 }, closed).emit).toBe(false);
  expect(alertFrequencyGate('once_per_bar', { lastFiredBarTime: 0 }, closed).emit).toBe(true);
  expect(alertFrequencyGate('once_per_bar_close', {}, forming).emit).toBe(false);
  expect(alertFrequencyGate('once_per_bar_close', {}, closed).emit).toBe(true);
  expect(alertFrequencyGate('once_per_bar_close', { lastFiredBarTime: 60 }, closed).emit).toBe(
    false,
  );
});

test('normalizeAlertMessage coerces and caps at the fractal message limit', () => {
  expect(normalizeAlertMessage('hello')).toBe('hello');
  expect(normalizeAlertMessage(42)).toBe('42');
  const long = 'x'.repeat(MAX_ALERT_MESSAGE_LENGTH + 50);
  expect(normalizeAlertMessage(long)).toHaveLength(MAX_ALERT_MESSAGE_LENGTH);
});

test('coarseReason never surfaces anything but http markers and error names', () => {
  expect(coarseReason(new Error('http-503'))).toBe('http-503');
  const abort = new Error('aborted at https://secret.example/hook');
  abort.name = 'AbortError';
  expect(coarseReason(abort)).toBe('AbortError');
  expect(coarseReason(new Error('fetch failed: https://secret.example/hook'))).toBe(
    'network-error',
  );
  expect(coarseReason('boom')).toBe('network-error');
});

// ---------------------------------------------------------------------------
// Dispatcher — gating, caps, fail-open, timeout.
// ---------------------------------------------------------------------------

function capture(name: string, behavior?: (alert: StrategyAlert) => Promise<void>) {
  const sent: StrategyAlert[] = [];
  const channel: AlertChannel = {
    name,
    async send(alert, signal) {
      if (behavior) await behavior(alert);
      if (signal?.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      sent.push(alert);
    },
  };
  return { channel, sent };
}

const barContext = (barTime: number, messages: readonly unknown[], closed = true) => ({
  runId: 'run',
  strategyId: 'strategy',
  strategySymbol: 'X',
  timeframe: '1m',
  barTime,
  barCloseMs: (barTime + 60) * 1000,
  price: 100,
  closed,
  messages,
});

test('dispatcher applies once_per_bar_close per message identity and resets per bar', async () => {
  const { channel, sent } = capture('ops');
  const dispatcher = new AlertDispatcher({ channels: [channel] });
  const first = await dispatcher.process(barContext(60, ['bull', 'bull', 'second']));
  expect(first.map((report) => report.alert.message)).toEqual(['bull', 'second']);
  expect(first.map((report) => report.alert.ordinal)).toEqual([1, 2]);
  expect(first.every((report) => report.deliveries[0]!.outcome === 'sent')).toBe(true);
  // Same message on the NEXT bar fires again: the gate is per bar.
  const second = await dispatcher.process(barContext(120, ['bull']));
  expect(second).toHaveLength(1);
  expect(sent.map((alert) => `${alert.barTime}:${alert.message}`)).toEqual([
    '60:bull',
    '60:second',
    '120:bull',
  ]);
  expect(sent[0]!.firedAt).toBe(120_000);
});

test('dispatcher frequency "all" delivers duplicate messages within one bar', async () => {
  const { channel, sent } = capture('ops');
  const dispatcher = new AlertDispatcher({ channels: [channel], frequency: 'all' });
  const reports = await dispatcher.process(barContext(60, ['bull', 'bull']));
  expect(reports.map((report) => report.alert.ordinal)).toEqual([1, 2]);
  expect(sent).toHaveLength(2);
});

test('dispatcher suppresses overflow beyond maxPerBar without sending', async () => {
  const { channel, sent } = capture('ops');
  const dispatcher = new AlertDispatcher({ channels: [channel], maxPerBar: 2, frequency: 'all' });
  const reports = await dispatcher.process(barContext(60, ['a', 'b', 'c', 'd']));
  expect(reports.map((report) => report.deliveries[0]!.outcome)).toEqual([
    'sent',
    'sent',
    'suppressed',
    'suppressed',
  ]);
  expect(sent).toHaveLength(2);
});

test('dispatcher is fail-open: one failing channel neither throws nor blocks the next', async () => {
  const failing: AlertChannel = {
    name: 'down',
    async send() {
      throw new Error('http-503');
    },
  };
  const { channel: healthy, sent } = capture('ops');
  const errors: string[] = [];
  const dispatcher = new AlertDispatcher({
    channels: [failing, healthy],
    onError: (channelName, _alert, reason) => errors.push(`${channelName}:${reason}`),
  });
  const [report] = await dispatcher.process(barContext(60, ['bull']));
  expect(report!.deliveries).toEqual([
    { channel: 'down', outcome: 'failed', error: 'http-503' },
    { channel: 'ops', outcome: 'sent' },
  ]);
  expect(sent).toHaveLength(1);
  expect(errors).toEqual(['down:http-503']);
});

test('dispatcher bounds a hanging channel with its send deadline', async () => {
  const hanging: AlertChannel = {
    name: 'slow',
    send(_alert, signal) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
  };
  const dispatcher = new AlertDispatcher({ channels: [hanging], sendTimeoutMs: 20 });
  const [report] = await dispatcher.process(barContext(60, ['bull']));
  expect(report!.deliveries[0]).toEqual({
    channel: 'slow',
    outcome: 'failed',
    error: 'AbortError',
  });
});

test('dispatcher refuses zero channels and duplicate names', () => {
  expect(() => new AlertDispatcher({ channels: [] })).toThrow('at least one channel');
  const { channel: a } = capture('same');
  const { channel: b } = capture('same');
  expect(() => new AlertDispatcher({ channels: [a, b] })).toThrow('unique');
});

// ---------------------------------------------------------------------------
// Webhook channel — fractal's delivery contract with an injected fetch.
// ---------------------------------------------------------------------------

const alert: StrategyAlert = {
  runId: 'run',
  strategyId: 'strategy',
  strategySymbol: 'X',
  timeframe: '1m',
  barTime: 60,
  firedAt: 120_000,
  price: 100.5,
  ordinal: 1,
  message: 'bull',
  source: 'bar-close',
};

test('webhook posts the fractal-shaped payload with configured headers', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const channel = new WebhookAlertChannel({
    name: 'ops',
    url: 'https://example.com/hook',
    headers: { 'x-token': 'secret-token' },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response('ok', { status: 200 });
    }) as typeof fetch,
  });
  await channel.send(alert);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('https://example.com/hook');
  expect(calls[0]!.init.method).toBe('POST');
  expect((calls[0]!.init.headers as Record<string, string>)['x-token']).toBe('secret-token');
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual(webhookAlertPayload(alert));
  expect(webhookAlertPayload(alert)).toMatchObject({
    type: 'pinelive.alert',
    alertId: 'pine:strategy',
    condition: 'Pine alert()',
    instrument: { symbol: 'X', timeframe: '1m' },
    firedAt: 120_000,
  });
});

test('webhook retries transient statuses with linear backoff and stops on success', async () => {
  const statuses = [503, 200];
  const sleeps: number[] = [];
  const channel = new WebhookAlertChannel({
    name: 'ops',
    url: 'https://example.com/hook',
    retryDelayMs: 100,
    fetchImpl: (async () => new Response('x', { status: statuses.shift()! })) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await channel.send(alert);
  expect(statuses).toHaveLength(0);
  expect(sleeps).toEqual([100]);
});

test('webhook treats plain 4xx as permanent after one attempt', async () => {
  let attempts = 0;
  const channel = new WebhookAlertChannel({
    name: 'ops',
    url: 'https://example.com/hook',
    fetchImpl: (async () => {
      attempts++;
      return new Response('no', { status: 400 });
    }) as typeof fetch,
  });
  await expect(channel.send(alert)).rejects.toThrow('http-400');
  expect(attempts).toBe(1);
});

test('webhook redacts transport failures to the error name — never the URL', async () => {
  const channel = new WebhookAlertChannel({
    name: 'ops',
    url: 'https://secret.example/hook?token=abc',
    attempts: 1,
    fetchImpl: (async () => {
      throw new TypeError('fetch failed: https://secret.example/hook?token=abc');
    }) as typeof fetch,
  });
  let thrown: Error | undefined;
  await channel.send(alert).catch((error: Error) => {
    thrown = error;
  });
  expect(thrown!.message).toBe('TypeError');
  expect(thrown!.message.includes('secret.example')).toBe(false);
});

test('webhook honors an aborted signal without retrying', async () => {
  let attempts = 0;
  const channel = new WebhookAlertChannel({
    name: 'ops',
    url: 'https://example.com/hook',
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      attempts++;
      const error = new Error('aborted');
      error.name = 'AbortError';
      if (init?.signal?.aborted) throw error;
      return new Response('ok', { status: 200 });
    }) as typeof fetch,
  });
  const controller = new AbortController();
  controller.abort();
  await expect(channel.send(alert, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(attempts).toBe(0);
});

test('webhook constructor rejects invalid destinations', () => {
  expect(() => new WebhookAlertChannel({ name: 'x', url: 'not a url' })).toThrow('invalid url');
  expect(() => new WebhookAlertChannel({ name: 'x', url: 'ftp://example.com' })).toThrow('http(s)');
});

test('the webhook channel passes alert channel conformance', async () => {
  const failures = await runAlertChannelConformance({
    create: () =>
      new WebhookAlertChannel({
        name: 'ops',
        url: 'https://secret.example/hook',
        headers: { 'x-token': 'secret-token' },
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.signal?.aborted) {
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
          }
          return new Response('ok', { status: 200 });
        }) as typeof fetch,
      }),
    secrets: ['https://secret.example/hook', 'secret-token'],
  });
  expect(failures).toEqual([]);
});

// ---------------------------------------------------------------------------
// Config — strict validation of the shared alerts section.
// ---------------------------------------------------------------------------

const v1Base = {
  configVersion: 1,
  strategy: 's.pine',
  symbol: 'X',
  timeframe: '1m',
  data: { provider: 'csv', dataDir: 'data', cutoverTime: 100 },
  broker: { id: 'paper' },
} as const;

test('config.alerts normalizes defaults and rejects malformed sections', () => {
  const normalized = normalizeRunConfig({
    ...v1Base,
    alerts: { channels: [{ id: 'webhook', url: 'https://example.com/h' }] },
  });
  if (normalized.configVersion !== 1) throw new Error('expected v1');
  expect(normalized.alerts).toEqual({
    channels: [{ id: 'webhook', name: 'webhook-1', url: 'https://example.com/h' }],
    frequency: 'once_per_bar_close',
    sendTimeoutMs: 8_000,
    attempts: 2,
    retryDelayMs: 400,
    maxPerBar: 20,
  });

  const bad = (alerts: unknown, message: string) =>
    expect(() => normalizeRunConfig({ ...v1Base, alerts })).toThrow(message);
  bad({ channels: [{ id: 'slack', url: 'https://x.y' }] }, 'must be "webhook" or "telegram"');
  bad({ channels: [{ id: 'webhook', url: 'nope' }] }, 'valid URL');
  bad({ channels: [{ id: 'webhook', url: 'ftp://x.y' }] }, 'http(s)');
  bad(
    {
      channels: [
        { id: 'webhook', name: 'a', url: 'https://x.y/1' },
        { id: 'webhook', name: 'a', url: 'https://x.y/2' },
      ],
    },
    'not unique',
  );
  bad({ channels: [], unknown: true }, 'not allowed');
  bad({ frequency: 'sometimes' }, 'frequency');
  bad({ sendTimeoutMs: 0 }, 'sendTimeoutMs');
  bad(
    {
      channels: Array.from({ length: 9 }, (_, index) => ({
        id: 'webhook',
        name: `w${index}`,
        url: `https://x.y/${index}`,
      })),
    },
    'at most 8',
  );
});

// ---------------------------------------------------------------------------
// v1 runner integration — warmup stays data; trading first; fail-open.
// ---------------------------------------------------------------------------

const alertStrategy = `//@version=6
strategy("alerts", default_qty_type=strategy.fixed, default_qty_value=1)
if close > open
    alert("bull close")
    alert("bull close")
    alert("second message")
    strategy.entry("L", strategy.long)
if close <= open
    alert("bear close")
    strategy.close("L")`;

const bars = [
  { time: 100, open: 2, high: 2, low: 1, close: 1, volume: 1 }, // warmup: bear close (data only)
  { time: 200, open: 1, high: 2, low: 1, close: 2, volume: 1 }, // live: bull ×2 + second
  { time: 300, open: 2, high: 2, low: 1, close: 1, volume: 1 }, // live: bear
  { time: 400, open: 2, high: 2, low: 1, close: 1, volume: 1 }, // live: bear (new bar → fires again)
];

function data(): MarketDataProvider {
  const source = new StaticProvider({ X: bars }).setInstrument('X', { minQty: 1, mintick: 0.01 });
  return new ReplayProvider(source, { cutoverTime: 200, instrument: { minOrderQty: 1 } });
}

const instrument = { symbol: 'X', minQty: 1, qtyStep: 1, minOrderQty: 1, mintick: 0.01 };

test('v1 runner dispatches live alerts only, after the cycle, with durable outcomes', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  const { channel, sent } = capture('ops');
  const trace: string[] = [];
  const memory = new MemoryLedger();
  const sink: LedgerSink = {
    append: async (record: LedgerRecord) => {
      trace.push('recordType' in record ? String(record.recordType) : 'cycle');
      await memory.append(record);
    },
  };
  const records: AlertDispatchRecord[] = [];
  const runner = new ForwardRunner(data(), broker, {
    source: alertStrategy,
    symbol: 'X',
    timeframe: '1m',
    warmupBars: 1,
    alertDispatcher: new AlertDispatcher({ channels: [channel] }),
    onRecord: (record) => void sink.append(record),
    onAlertRecord: async (record) => {
      records.push(record);
      await sink.append(record);
    },
  });
  await runner.start();

  // Warmup bar 100 fired "bear close" in replay — it must NOT be delivered.
  expect(sent.map((entry) => `${entry.barTime}:${entry.message}`)).toEqual([
    '200:bull close',
    '200:second message',
    '300:bear close',
    '400:bear close',
  ]);
  // Duplicate "bull close" within bar 200 collapsed by once_per_bar_close.
  expect(records.map((record) => [record.barTime, record.ordinal, record.message])).toEqual([
    [200, 1, 'bull close'],
    [200, 2, 'second message'],
    [300, 1, 'bear close'],
    [400, 1, 'bear close'],
  ]);
  expect(records.every((record) => record.deliveries[0]!.outcome === 'sent')).toBe(true);
  expect(memory.alerts).toHaveLength(4);
  // Trading first: the bar's cycle record precedes its alert records.
  expect(trace.indexOf('cycle')).toBeLessThan(trace.indexOf('alert'));
});

test('v1 runner survives a dead channel: outcomes failed, run completes', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  const failing: AlertChannel = {
    name: 'down',
    async send() {
      throw new Error('http-503');
    },
  };
  const memory = new MemoryLedger();
  const runner = new ForwardRunner(data(), broker, {
    source: alertStrategy,
    symbol: 'X',
    timeframe: '1m',
    warmupBars: 1,
    alertDispatcher: new AlertDispatcher({ channels: [failing] }),
    onAlertRecord: (record) => void memory.append(record),
  });
  await runner.start();
  expect(memory.alerts).toHaveLength(4);
  expect(
    memory.alerts.every(
      (record) =>
        record.deliveries[0]!.outcome === 'failed' && record.deliveries[0]!.error === 'http-503',
    ),
  ).toBe(true);
  // Trading was unaffected.
  expect((await broker.getPosition('X')).qty).toBe(0);
});
