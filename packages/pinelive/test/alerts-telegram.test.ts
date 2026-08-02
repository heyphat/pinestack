import { expect, test } from 'bun:test';
import {
  TELEGRAM_MAX_TEXT_LENGTH,
  TelegramAlertChannel,
  normalizeRunConfig,
  telegramAlertText,
  type StrategyAlert,
} from '../src/index.js';
import { runAlertChannelConformance } from '../src/testing/index.js';

const alert: StrategyAlert = {
  runId: 'run',
  strategyId: 'strategy',
  strategySymbol: 'MGC',
  timeframe: '5m',
  barTime: 1_704_153_600,
  firedAt: 1_704_153_900_000,
  price: 2412.3,
  ordinal: 1,
  message: 'rsi crossed above 50',
  source: 'bar-close',
};

const TOKEN = '123456789:AAE-abc_DEF123';
const CHAT = '-1001234567890';

function telegramResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('telegramAlertText renders deterministically and truncates at the API limit', () => {
  expect(telegramAlertText(alert)).toBe(
    'MGC 5m — rsi crossed above 50\nprice 2412.3 · bar close 2024-01-02T00:05:00.000Z · strategy',
  );
  const long = telegramAlertText({ ...alert, message: 'y'.repeat(5_000) });
  expect(long).toHaveLength(TELEGRAM_MAX_TEXT_LENGTH);
});

test('telegram posts sendMessage with the token in the path and the chat in the body', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const channel = new TelegramAlertChannel({
    name: 'tg',
    botToken: TOKEN,
    chatId: CHAT,
    disableNotification: true,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init!.body)) });
      return telegramResponse({ ok: true, result: { message_id: 1 } });
    }) as typeof fetch,
  });
  await channel.send(alert);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  expect(calls[0]!.body).toEqual({
    chat_id: CHAT,
    text: telegramAlertText(alert),
    disable_notification: true,
  });
});

test('telegram honors a 429 retry_after and then succeeds', async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const channel = new TelegramAlertChannel({
    name: 'tg',
    botToken: TOKEN,
    chatId: CHAT,
    retryDelayMs: 400,
    fetchImpl: (async () => {
      attempts++;
      if (attempts === 1)
        return telegramResponse(
          {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 2 },
          },
          429,
        );
      return telegramResponse({ ok: true, result: {} });
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await channel.send(alert);
  expect(attempts).toBe(2);
  expect(sleeps).toEqual([2_000]); // server-requested delay, not the linear default
});

test('telegram caps a pathological retry_after at its ceiling', async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const channel = new TelegramAlertChannel({
    name: 'tg',
    botToken: TOKEN,
    chatId: CHAT,
    fetchImpl: (async () => {
      attempts++;
      if (attempts === 1)
        return telegramResponse(
          { ok: false, error_code: 429, parameters: { retry_after: 3_600 } },
          429,
        );
      return telegramResponse({ ok: true, result: {} });
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await channel.send(alert);
  expect(sleeps).toEqual([10_000]);
});

test('telegram treats client errors as permanent with a coarse telegram-<code> reason', async () => {
  let attempts = 0;
  const channel = new TelegramAlertChannel({
    name: 'tg',
    botToken: TOKEN,
    chatId: CHAT,
    fetchImpl: (async () => {
      attempts++;
      return telegramResponse(
        { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
        403,
      );
    }) as typeof fetch,
  });
  await expect(channel.send(alert)).rejects.toThrow('telegram-403');
  expect(attempts).toBe(1);
});

test('telegram retries a 5xx and a non-JSON proxy error by HTTP status', async () => {
  const responses = [
    new Response('<html>bad gateway</html>', { status: 502 }),
    telegramResponse({ ok: true, result: {} }),
  ];
  const sleeps: number[] = [];
  const channel = new TelegramAlertChannel({
    name: 'tg',
    botToken: TOKEN,
    chatId: CHAT,
    retryDelayMs: 50,
    fetchImpl: (async () => responses.shift()!) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await channel.send(alert);
  expect(responses).toHaveLength(0);
  expect(sleeps).toEqual([50]);
});

test('telegram redacts transport failures that embed the token-bearing URL', async () => {
  const channel = new TelegramAlertChannel({
    name: 'tg',
    botToken: TOKEN,
    chatId: CHAT,
    attempts: 1,
    fetchImpl: (async () => {
      throw new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`);
    }) as typeof fetch,
  });
  let thrown: Error | undefined;
  await channel.send(alert).catch((error: Error) => {
    thrown = error;
  });
  expect(thrown!.message).toBe('TypeError');
  expect(thrown!.message.includes(TOKEN)).toBe(false);
});

test('telegram constructor rejects malformed tokens, chat ids, and base URLs', () => {
  expect(
    () => new TelegramAlertChannel({ name: 'tg', botToken: 'not-a-token', chatId: CHAT }),
  ).toThrow('botToken must look like');
  expect(() => new TelegramAlertChannel({ name: 'tg', botToken: TOKEN, chatId: '  ' })).toThrow(
    'requires a chatId',
  );
  expect(
    () =>
      new TelegramAlertChannel({
        name: 'tg',
        botToken: TOKEN,
        chatId: CHAT,
        apiBaseUrl: 'ftp://x.y',
      }),
  ).toThrow('http(s)');
});

test('the telegram channel passes alert channel conformance without leaking secrets', async () => {
  const failures = await runAlertChannelConformance({
    create: () =>
      new TelegramAlertChannel({
        name: 'tg',
        botToken: TOKEN,
        chatId: CHAT,
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.signal?.aborted) {
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
          }
          return telegramResponse({ ok: true, result: {} });
        }) as typeof fetch,
      }),
    secrets: [TOKEN, CHAT],
  });
  expect(failures).toEqual([]);
});

// ---------------------------------------------------------------------------
// Config normalization for the telegram kind.
// ---------------------------------------------------------------------------

const v1Base = {
  configVersion: 1,
  strategy: 's.pine',
  symbol: 'X',
  timeframe: '1m',
  data: { provider: 'csv', dataDir: 'data', cutoverTime: 100 },
  broker: { id: 'paper' },
} as const;

test('config accepts telegram channels, canonicalizes numeric chat ids, defaults names', () => {
  const normalized = normalizeRunConfig({
    ...v1Base,
    alerts: {
      channels: [
        { id: 'telegram', botToken: TOKEN, chatId: -1001234567890 },
        { id: 'webhook', url: 'https://example.com/h' },
      ],
    },
  });
  if (normalized.configVersion !== 1) throw new Error('expected v1');
  expect(normalized.alerts!.channels).toEqual([
    { id: 'telegram', name: 'telegram-1', botToken: TOKEN, chatId: '-1001234567890' },
    { id: 'webhook', name: 'webhook-2', url: 'https://example.com/h' },
  ]);

  const bad = (alerts: unknown, message: string) =>
    expect(() => normalizeRunConfig({ ...v1Base, alerts })).toThrow(message);
  bad({ channels: [{ id: 'telegram', botToken: 'nope', chatId: '1' }] }, 'botToken must look like');
  bad({ channels: [{ id: 'telegram', botToken: TOKEN }] }, 'chatId');
  bad(
    { channels: [{ id: 'telegram', botToken: TOKEN, chatId: '1', url: 'https://x.y' }] },
    'not allowed',
  );
  bad(
    { channels: [{ id: 'telegram', botToken: TOKEN, chatId: '1', disableNotification: 'yes' }] },
    'disableNotification must be boolean',
  );
  bad(
    {
      channels: [
        { id: 'telegram', name: 'same', botToken: TOKEN, chatId: '1' },
        { id: 'webhook', name: 'same', url: 'https://x.y' },
      ],
    },
    'not unique',
  );
});
