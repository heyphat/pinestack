# pinelive alerts

Pinelive turns Pine `alert()` calls in a running strategy into deliveries on
registered notification channels — the headless counterpart of TradingView's
alert firing, with the same host-side semantics the fractal web app already
implements for chart alerts. The strategy is the condition language: anything
Pine can express (`ta.crossover`, custom state machines, `request.security`
series) becomes an alert by calling `alert()` when it holds.

```pine
if ta.crossover(fast, slow)
    alert("fast crossed above slow", alert.freq_once_per_bar_close)
```

```jsonc
// Current pinelive config excerpt
{
  "configVersion": 3,
  "alerts": {
    "channels": [{ "id": "webhook", "name": "ops", "url": "https://example.com/hook" }],
  },
}
```

## Ownership boundaries

Alerting follows the same three-owner discipline as everything else in
pinestack, plus one deliberate exclusion:

1. **piner owns emission.** Pine's `alert()` builtin appends
   `{ bar, message }` to the engine's `OutputCollector.alerts` during
   evaluation, and the engine's own snapshot/restore machinery rolls back
   alerts emitted by forming (not yet committed) evaluations. Pinelive never
   parses Pine and never decides _whether_ a condition held — only whether an
   emitted alert may be _delivered_.
2. **pinelive owns delivery.** Frequency gating, per-bar caps, journaling,
   channel dispatch, redaction, and restart safety live here — the exact
   sibling of how pinelive owns broker effects around piner's target position.
3. **pinerun stays pure.** A pinerun job is a deterministic, cacheable function
   of its inputs; a network send inside it would break replay semantics in both
   directions. Backtest alerts are **data** (a future reporting field), never
   deliveries. This mirrors the fractal policy: "backtest alerts stay DATA — a
   passive list on the result, never routed."
4. **fractal owns interactive chart alerts.** Price-threshold, channel, and
   comparison conditions attached to a chart belong to the web app. Pinelive
   does not duplicate that condition builder; a strategy expresses conditions
   in Pine.

## Event flow

```text
piner engine.tick(bar, final)
      │  alert("...") appends to engine.outputs.alerts
      ▼
pinelive collects NEW alerts for this evaluation      (committed-cursor slice)
      │  warmup/replay alerts are data — never dispatched
      ▼
frequency gate (host policy, per message identity)    (fractal frequencyGate)
      │  per-bar cap (maxPerBar) → overflow = suppressed
      ▼
durable decision/reconcile completes FIRST            (trading is never delayed)
      ▼
channel dispatch (fail-open, bounded, redacted)
      ▼
one sequenced durable alert event with per-channel outcomes
```

### When alerts fire — the gating matrix

| Evaluation                 | Dispatched? | Why                                                                                   |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| Warmup / historical replay | No          | History is data, not events; the collection cursor starts after warmup.               |
| Fresh authoritative final  | Yes         | It is the fresh committed bar-close evaluation eligible for outward effects.          |
| Forming revision           | No          | It is provisional; piner rolls its alerts back on the next revision.                  |
| Recovered final            | No          | It represents an already-processed bar; dispatch would duplicate delivery on restart. |
| Startup discontinuity      | No          | Continuity was not proven, so the bar is inhibited for execution and alerts alike.    |

Only a fresh authoritative final produces an outward alert effect. This is the
same eligibility boundary used for close-only execution mirroring.

## Frequency semantics

TradingView's `alert(message, freq)` carries a per-call frequency. **piner
0.11.1 accepts and discards the `freq` argument** (`(message, _freq) =>`), so
per-call fidelity is impossible downstream until piner forwards it. When it
does, the per-call value takes precedence over the host default; the gate below
already accepts it per alert. Until then pinelive applies one configured
frequency to every alert, with the same pure, sample-time-driven gate fractal
uses (`frequencyGate` — never wall clock):

| `alerts.frequency`   | Behavior                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `once_per_bar_close` | Default. At most one delivery per distinct message per authoritative closed bar.            |
| `once_per_bar`       | Alias of the above while dispatch is close-only; distinct if forming dispatch is added.     |
| `all`                | Every eligible `alert()` call delivers, including identical messages within one closed bar. |

The gate is keyed by **message identity**: two different messages on one bar
both fire under any frequency; the same message twice on one bar collapses
under `once_per_bar*`. Gate state is per-run and sample-time based, so replays
and restarts cannot leak wall-clock behavior into it.

## Delivery pipeline

### Ordering: trading first

Alert dispatch runs **after** the bar's decision is durably journaled and its
reconcile completes or is durably scheduled. A slow or failing webhook can
never delay an order correction; worst-case alert latency is one bar behind the
venue by design.

### Fail-open, bounded

Channels are advisory. A channel failure is journaled (`outcome: "failed"`,
coarse reason) and logged, and the run continues — the execution breaker is
never touched by alerting. Boundedness comes from three caps:

- `sendTimeoutMs` (default 8000) — one overall deadline per alert per channel,
  covering retries, enforced with `AbortSignal`.
- Retries mirror fractal's webhook policy: up to `attempts` (default 2) with
  linear backoff (`retryDelayMs × attempt`, default 400 ms); retryable =
  network errors, 5xx, 408, 429; any other 4xx is permanent.
- `maxPerBar` (default 20) — alerts beyond the cap on one bar are journaled as
  `suppressed` and not sent, so a runaway script cannot hammer an endpoint.

### Durability and restart safety

Every gated alert (sent, failed, or suppressed) follows one durable event path:
`recordType: "alert"`, `schemaVersion: 3`, sequence-stamped by the same ledger
as decisions and reconcile evidence. The event carries the alert identity and
per-channel outcomes; recovery validates it and excludes it from decision
state.

The event is written after dispatch so it can carry real outcomes. At-most-once
delivery across restarts is structural: a recovered final is not eligible, so
the same bar's alerts cannot be dispatched twice. The one crash window (after
send, before the event is durable) can lose the _record_ of a delivered alert,
never duplicate a delivery — the safe side for an advisory channel, and the
reverse of the order path's journal-before-effect discipline, deliberately: an
order is a liability, an alert is information.

`firedAt` on the wire is the **bar close time** (sample time, matching fractal),
not wall clock; `recordedAt` in the ledger is wall clock.

## Channels

### The channel contract

```ts
interface AlertChannel {
  /** Ledger-safe identity. Never a URL, token, or account id. */
  readonly name: string;
  /** Deliver one alert. Must reject (not hang) on failure and honor the signal. */
  send(alert: StrategyAlert, signal?: AbortSignal): Promise<void>;
  close?(): Promise<void>;
}
```

`runAlertChannelConformance()` from `@heyphat/pinelive/testing` enforces the
behavioral half: sends resolve for a well-formed alert, aborts are honored
promptly, failures reject with `Error`s, and — given the channel's secrets —
no thrown message leaks them. Two channel kinds are built in: `webhook` and
`telegram`.

### The webhook channel

`WebhookAlertChannel` POSTs one JSON object per alert, mirroring fractal's
payload with strategy identity in place of chart identity:

```jsonc
{
  "type": "pinelive.alert",
  "alertId": "pine:<strategyId>",
  "alertName": "<strategyId>",
  "message": "fast crossed above slow",
  "instrument": { "symbol": "MGC", "timeframe": "5m" },
  "condition": "Pine alert()",
  "price": 2412.3, // the evaluated bar's close
  "firedAt": 1704154500000, // bar close, unix ms — sample time, not wall clock
  "barTime": 1704153600, // bar open, unix seconds
  "ordinal": 1, // 1-based within the bar
  "runId": "…",
  "source": "bar-close",
}
```

Delivery follows fractal's contract: coarse non-PII error reasons
(`http-503`, `AbortError`, `network-error` — never the URL, headers, or payload)
and bounded retries on transient failures only. The URL and headers are
construction secrets: they never appear in the ledger, logs, or error messages;
the ledger sees only the channel `name`.

### The telegram channel

`TelegramAlertChannel` delivers through the Bot API's `sendMessage` —
`https://api.telegram.org/bot<token>/sendMessage` — one plain-text message per
alert (no `parse_mode`: alert messages are user-authored strings, and
Markdown/HTML escaping is itself a delivery failure mode). The text is
deterministic and truncated to Telegram's 4096-character limit:

```text
MGC 5m — rsi crossed above 50
price 2412.3 · bar close 2024-01-02T00:05:00.000Z · pine-58abb08d
```

Setup: create a bot with [@BotFather](https://core.telegram.org/bots#botfather)
to get the token, then obtain the target `chatId` — for a direct message, your
own user id (the bot cannot message a user who has never started it; send it
`/start` first); for a group or channel, add the bot and use the negative group
id or the `@channelusername`.

Delivery policy is the shared contract plus one Telegram-specific behavior: a
`429 Too Many Requests` body carries `parameters.retry_after` (seconds) —
Telegram allows roughly one message per second per chat — and the retry honors
that server-requested delay, capped at 10 s, inside the same per-alert deadline.
Client errors (`telegram-400`, `telegram-403` — e.g. the bot was blocked) are
permanent. Failure reasons are coarse (`telegram-<code>`, `http-<status>`,
`AbortError`); the bot token (which is embedded in the request URL) and the chat
id are construction secrets that appear in no ledger row, log, or thrown
message.

### Writing a custom channel

Implement `AlertChannel`, keep transport behind injectable dependencies
(`fetchImpl` in the webhook is the pattern), pass
`runAlertChannelConformance`, and register it in config by constructing it in
your host and handing it to the runtime (`alertChannels` option). The CLI
constructs the built-in `webhook` and `telegram` kinds from config.

## Configuration

The current strict top-level configuration uses `"configVersion": 3` and one
`alerts` section:

```jsonc
{
  "configVersion": 3,
  // strategy, symbol, timeframe, data, historical, live, security, and execution omitted here
  "alerts": {
    "channels": [
      {
        "id": "webhook", // channel kind: "webhook" | "telegram"
        "name": "ops", // unique ledger-safe name; defaults to <id>-<n>
        "url": "https://example.com/hook",
        "headers": { "x-token": "…" }, // optional; never journaled or logged
      },
      {
        "id": "telegram",
        "name": "tg",
        "botToken": "123456789:AAE…", // BotFather token; never journaled or logged
        "chatId": "-1001234567890", // user/group/channel id or @channelusername
        "disableNotification": false, // optional: deliver silently
      },
    ],
    "frequency": "once_per_bar_close",
    "sendTimeoutMs": 8000,
    "attempts": 2,
    "retryDelayMs": 400,
    "maxPerBar": 20,
  },
}
```

| Key             | Default              | Constraints                                                                                                                                 |
| --------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels`      | `[]`                 | ≤ 8; `{id:"webhook", name?, url, headers?}` or `{id:"telegram", name?, botToken, chatId, disableNotification?}`; names unique across kinds. |
| `frequency`     | `once_per_bar_close` | `all` \| `once_per_bar` \| `once_per_bar_close`.                                                                                            |
| `sendTimeoutMs` | `8000`               | Safe integer in [1, 120000].                                                                                                                |
| `attempts`      | `2`                  | Safe integer in [1, 5].                                                                                                                     |
| `retryDelayMs`  | `400`                | Safe integer in [0, 10000].                                                                                                                 |
| `maxPerBar`     | `20`                 | Safe integer in [1, 1000].                                                                                                                  |

Validation is strict: unknown keys are rejected, and a config that declares
channels but reaches a runtime with none supplied fails at startup rather than
silently not alerting. `validate` performs the same pure checks without
constructing any channel or touching the network. An empty or absent `alerts`
section disables the pipeline entirely at zero cost.

Alert messages are truncated at 1000 characters (fractal's message cap) before
gating, journaling, or dispatch.

## Failure modes

| Failure                                    | Behavior                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| Channel timeout / network / 5xx            | Retried within the per-alert deadline; then `failed` outcome, journaled, run continues. |
| Channel 4xx (non-408/429)                  | Permanent for that alert; `failed` outcome immediately.                                 |
| More than `maxPerBar` alerts on one bar    | Overflow journaled as `suppressed`, not sent, one log line.                             |
| Ledger append for the alert event fails    | Propagates like any ledger failure — durability problems are never advisory.            |
| Crash between dispatch and durable event   | Delivery may be unrecorded; never duplicated (structural at-most-once).                 |
| Config declares channels, runtime has none | Startup error (fail-closed): the config promised alerting.                              |

## Relationship to the fractal alerting module

Pinelive mirrors fractal's `modules/alerting` semantics wherever the concepts
map, so behavior stays consistent across the web and headless surfaces:

| fractal                                      | pinelive                                               |
| -------------------------------------------- | ------------------------------------------------------ |
| `pine-alerts.ts` live-only ingestion + dedup | committed-cursor collection + eligibility gate         |
| "backtest alerts stay data"                  | warmup alerts never dispatch; pinerun reports only     |
| `frequencyGate` (pure, sample-time)          | `alertFrequencyGate` (same shape, `closed` flag ready) |
| `webhook.ts` delivery contract               | `WebhookAlertChannel` (same retries/timeouts/reasons)  |
| `triggeredHistory` (persisted firings)       | durable sequenced `alert` events                       |
| Channel settings (toast/sound/webhook)       | `AlertChannel` protocol (webhook built in)             |
| Price/channel/comparison condition builder   | out of scope — conditions live in Pine                 |

## Limitations and future work

- **Per-call `freq` fidelity requires piner.** The engine currently discards
  the second argument to `alert()`; forwarding it (and `alertcondition()`
  metadata) belongs in piner, at which point the host gate honors it per call
  with `alerts.frequency` as the fallback.
- **Every-update dispatch is not offered.** Alert delivery is close-only: only
  fresh authoritative finals can dispatch. The gate and event shapes retain a
  `closed` flag for a future explicitly designed forming-tick policy.
- **`alert()` only.** `alertcondition()` is a TradingView server-side
  declaration; piner records nothing actionable for it today.
- **More channels.** Slack/email/push adapters are `AlertChannel`
  implementations plus conformance — deliberately left to demand (Telegram
  ships as the second built-in).
- **pinerun reporting.** Exposing collected alert events in backtest `--json`
  as data is planned separately because it changes the result shape of cached
  jobs.
