# Pinelive examples

Config cases plus two library-driven scripts, each isolating one behavior that is
easy to conflate: which posture actually places orders, what
`process_orders_on_close` does to your fill prices, how the strategy's book and
the broker's book can silently disagree, and what `calc_on_every_tick` does and
does not buy you.

The numbered cases come in two sets that teach the same things on different
timeframes — `01`–`06` on a 1h chart, and `5m-01`–`5m-05` on a 5m chart with 1m
children for the intrabar case. Pick whichever matches what you run.

Offline (checked-in CSV fixtures and the `PaperBroker`, no network): `01`–`05`,
all of `5m-*`, and `every-update-runner.ts`. Reaching Binance's public keyless API:
case `06` and `binance-5m-1m-runner.ts`. Run all commands from the repository root:

```bash
bun packages/pinelive/src/cli.ts validate --config examples/pinelive/01-compute-only.json
bun packages/pinelive/src/cli.ts run      --config examples/pinelive/01-compute-only.json
```

The offline configs replay 60 warmup bars then 100 live bars (`cutoverTime`
1705867200). The mirrored cases fsync every ledger event — `durability: "sync"` is
the only option — so expect a minute or two each. Case 06 runs until you stop it.

## The one thing to understand first

**Pinelive never sees `strategy.entry()`.** It reads `strategy.position_size`
after each tick, reads the broker's actual position, and submits one order for
the difference. Order type comes from your config, not from Pine. Your Pine
stops and limits never rest at the venue.

So a "signal" is not an order call — it is _a change in net position size that a
fill pass produced_. Which fill pass, and when, is what cases 02 and 03 are about.

## Cases

| Config                            | Posture        | Timing flag                    | What it isolates                            |
| --------------------------------- | -------------- | ------------------------------ | ------------------------------------------- |
| `01-compute-only.json`            | compute-only   | aligned                        | Targets computed, no broker at all          |
| `02-paper-default-timing.json`    | paper mirrored | default (`false`)              | One bar of fill latency                     |
| `03-paper-aligned-timing.json`    | paper mirrored | `process_orders_on_close=true` | The corrected version of 02                 |
| `04-paper-sub-minimum.json`       | paper mirrored | aligned                        | Silent book divergence                      |
| `05-every-update-lower-bars.json` | compute-only   | aligned                        | Offline intrabar cadence has no data source |
| `06-binance-realtime-5m-1m.json`  | compute-only   | aligned                        | **Realtime** 5m chart from live 1m bars     |

Cases 01–05 run on the 1h fixtures in `examples/data`, which are shared with the
rest of the repo's docs and tests. A parallel `5m-*` set runs the same lessons on a
**5m chart**, with the intrabar case using **1m children** — see
[the 5m set](#the-5m-set) below. Both sets are kept: the 1h configs are the ones the
surrounding documentation refers to.

### 01 — compute-only

No broker, no lease on a configured path, no orders. The run computes a target
per closed bar and writes durable compute-state events. Ledger and lock paths are
derived from strategy/symbol/timeframe rather than configured.

Use this posture to answer "what would my strategy be holding right now" without
any execution risk. Observed: `evaluations: 100`, `mode: "compute-only"`, and the
result carries no `finalPosition` or `finalAccount` because there is no broker.

### 02 vs 03 — the flag that changes your P&L

Identical strategy logic, identical data, identical 100 bars. The only difference
is `process_orders_on_close`.

```bash
bun packages/pinelive/src/cli.ts run --config examples/pinelive/02-paper-default-timing.json
bun packages/pinelive/src/cli.ts run --config examples/pinelive/03-paper-aligned-timing.json
```

Observed on the fixtures:

|                         | 02 default | 03 aligned |
| ----------------------- | ---------- | ---------- |
| `order.intent` rows     | 4          | 4          |
| `order.completion` rows | 4          | 4          |
| paper `realizedPnl`     | **71.17**  | **109.44** |
| paper `equity`          | 10071.17   | 10109.44   |

Same four trades. A 54% difference in realized P&L, entirely from fill timing.

Why: with the default `process_orders_on_close=false`, a market order created by
bar N's body is filled by piner's emulator at bar **N+1's open** (`onBar()` runs
before the script body). Pinelive only reads `position_size` after the tick, so
it observes the new position one bar late and corrects at bar N+1's **close**.
With `true`, an extra fill pass runs after the body on bar N's close, Pinelive
reads the new size immediately, and both books settle on the same price.

**For mirrored forward testing, set `process_orders_on_close=true`.** Nothing in
`validate` warns you if you forget — the only strategy annotation Pinelive
inspects is `calc_on_every_tick`.

### 04 — the two books disagreeing, silently

`sub-minimum-qty.pine` trades a fixed 0.01 BTC. The config declares
`minOrderQty: 0.05` while `qtyStep` stays 0.001, so every delta is a valid
quantity multiple that still lands under the minimum order size.

```bash
bun packages/pinelive/src/cli.ts run --config examples/pinelive/04-paper-sub-minimum.json
bun packages/pinelive/src/cli.ts status --ledger .pinelive/04-sub-minimum.jsonl --json | head -c 400
```

Observed: `order.intent` rows **0**, `order.completion` rows **0**, paper
`realizedPnl` **0**, `equity` unchanged at **10000** — and the run reports
`executionSafe: true`, `executionEligibility: "enabled"`. piner traded all the
way through; the broker never moved.

The ledger rows say it plainly:

```json
{
  "sequence": 7,
  "recordType": "evaluation.completed",
  "target": 0.01,
  "actualBefore": 0,
  "actualAfter": 0,
  "delta": 0.01
}
```

`target: 0.01`, `actualAfter: 0`, `delta: 0.01` — recorded as **completed**. The
mirror returns `action: "noop"` when the snapped quantity is below the minimum,
and the scheduler treats a noop as success (it even resets the breaker's
consecutive-error count). Contrast with exceeding the per-bar intent budget,
which latches the breaker with `intent-limit` — the same "position stopped
tracking the strategy" condition, handled fail-closed there and as success here.

The related case, **an exit while nothing is actually open**, is safe by
construction and visible in this run too: target 0 against an actual of 0 gives a
zero delta and no order. Position mirroring can never sell a position you do not
hold, because the actual is re-read from the broker before every plan. An
order-forwarding design would have sent the sell and put you short.

What it cannot do is tell you the books diverged. piner booked entries, exits and
P&L on trades that never existed in the account, and nothing in the ledger
compares the two.

### 05 — the offline intrabar config has no data source

```bash
bun packages/pinelive/src/cli.ts validate --config examples/pinelive/05-every-update-lower-bars.json  # passes
bun packages/pinelive/src/cli.ts run      --config examples/pinelive/05-every-update-lower-bars.json  # evaluations: 0
```

The config validates, the run exits 0, and it performs **zero evaluations**. Not
an error — just nothing.

This config selects the CSV provider, which becomes a `ReplayProvider`. That class
does implement `liveBars()`, so the capability gate passes — but its lower-bars path
needs a pre-recorded `BarUpdate` trace (`updates`/`liveUpdates`/`updateTraces`) plus
explicit bucket anchor evidence, and `createNodeMarketDataProvider` supplies neither:
it passes only `cutoverTime`, `paceMs`, and instrument metadata. With no trace, the
live iterator returns immediately and the stream ends. **Adding 5m or 1m CSV files
does not fix this**, because the provider wants an update trace, not bars.

This config uses `timeframe: "1h"` with a `5m` child only because the offline
fixtures carry 1h data. **For a working 5m chart with 1m children, use case 06** —
`BinanceLiveProvider` implements `liveBars()`, so the cadence is reachable from
configuration against a real feed. Case 05 is kept to show what an every-update
config does when its provider has no update source: it validates, exits 0, and does
nothing, which is a silent no-op rather than a fail-closed error.

Even if a provider did supply the stream, `every-update` would not execute:
mirrored every-update is forced to Paper and rewritten to `mirrorOn: "bar-close"`,
so forming decisions are journaled as skipped and only the authoritative close can
move a position. It also rejects every `request.security` dependency.

And `calc_on_every_tick=true`, which the config gate demands, is **inert metadata
in piner** — the realtime driver executes the script on every update it is handed
regardless of the flag. The cadence is decided by what Pinelive feeds the engine.
Treat the flag as a consent gate: you are asserting your script tolerates being
re-evaluated several times per bar with piner rolling broker state back between
revisions.

### every-update that actually runs — `every-update-runner.ts`

The library API can supply the trace the CLI cannot, so this script builds one
from the same 1h fixture (several forming revisions per bar, then the bar's
authoritative final) and runs the compute-only intrabar server over it:

```bash
bun examples/pinelive/every-update-runner.ts
bun examples/pinelive/every-update-runner.ts --strategy examples/pinelive/intrabar-stop-entry.pine --revisions 6 --bars 3
```

Three strategies, and the difference between them is the actual lesson:

| Strategy                           | Order style                 | Forming behavior             |
| ---------------------------------- | --------------------------- | ---------------------------- |
| `intrabar-sma-cross.pine`          | market, POOC on             | no intrabar variation at all |
| `intrabar-sma-cross-pooc-off.pine` | market, POOC off            | also none                    |
| `intrabar-stop-entry.pine`         | resting stop entry, POOC on | target moves mid-bar         |

**Market-order strategies show nothing intrabar, under either POOC setting.**
Observed: 100 bars × 4 revisions, and _zero_ bars whose target changed mid-bar. A
market order queued by a forming tick's body is never filled on that tick
(`onStrategyBarClose()` runs only when `isClose`) and is then discarded by the next
tick's rollback. So every revision of one chart bar reports the same
`position_size`, and any target change lands exactly on the final.

**A resting order is different**, and `process_orders_on_close=true` does not
suppress it: the close pass fills market orders created during the bar, while
limit/stop orders and exit brackets are only _checked_ against the close price. A
stop that is pending at commit is therefore tested against the **developing** range
on every tick. `intrabar-stop-entry.pine` has both flags on and shows both
mechanisms in one run:

```
barTime     rev  phase    target      executable  reason
1705878000    1  forming    0.121000  true        eligible
1705878000  ...  forming    0.121000  true        eligible
1705878000    6  final      0.000000  true        eligible   <- revised

1706050800    1  forming    0.000000  true        eligible
1706050800    2  forming    0.000000  true        eligible
1706050800    3  forming    0.125000  true        eligible   <- revised
1706050800    6  final      0.125000  true        eligible   <- revised
```

Bar `1705878000` is the market path: five identical forming evaluations, then a
`strategy.close()` exit that only lands in the close pass. Bar `1706050800` is the
resting path: flat for two revisions, then the stop fills at revision 3 — half a bar
before a bar-close run would have known.

**So with `calc_on_every_tick` and `process_orders_on_close` both true, execution
timing is identical to a plain bar-close run.** What you gain is earlier visibility
of resting-order fills. What you pay is ~4.5× the journal rows and a strategy that
must tolerate repeated speculative re-evaluation. With market-only entries and
exits, the combination buys nothing.

Two more things visible in the output:

- Forming updates are **coalesced and droppable** — 600 trace updates produced 551
  evaluations, and some bars are missing low revision numbers. Finals are
  non-droppable: 100 delivered out of 100 chart bars, always.
- Every forming evaluation reports `executable: true` and `reason: eligible`. That
  is about _admission_, not execution. Under mirrored execution all 451 of them
  would be journaled as skipped with reason `mirrorOn=bar-close`.

Only the forming path here is synthetic. Every `isClose` update is the exact
fixture bar, because ReplayProvider rejects any final that disagrees with
authoritative history.

### 5m chart, 1m children, real Binance data — `binance-5m-1m-runner.ts`

**Requires network.** Everything else in this folder is offline.

```bash
bun examples/pinelive/binance-5m-1m-runner.ts
bun examples/pinelive/binance-5m-1m-runner.ts --strategy examples/pinelive/intrabar-sma-cross.pine
bun examples/pinelive/binance-5m-1m-runner.ts --market futures --bars 3
```

Nothing here is synthetic. It fetches 1,000 real 1m BTCUSDT bars, groups them into
complete UTC-aligned 5m buckets, and replays each bucket's five actual 1m bars as
the lower-bars child stream. The 5m series is derived from those 1m bars using the
same aggregation the runtime asserts on (`open=first, high=max, low=min,
close=last, volume=sum`), so an authoritative final can never disagree with its
children. The script also fetches Binance's own 5m klines and compares:

```
child 1m bars=999 complete 5m buckets=199
vendor 5m bars compared=199 identical to 1m aggregation=199 (exact)
```

Binance's published 5m series equals its 1m series aggregated, bar for bar. Useful
to know independently of pinelive.

**The result, on real data.** One ~11.5-hour window (2026-08-02 18:45 → 2026-08-03
06:15 UTC), 139 live 5m bars, 695 real 1m child updates:

| Strategy                   | evaluations       | bars whose target changed mid-bar                |
| -------------------------- | ----------------- | ------------------------------------------------ |
| `intrabar-stop-entry.pine` | 626 (487 forming) | **0 of 139** — all 4 changes landed on the close |
| `intrabar-sma-cross.pine`  | 626 (487 forming) | **0 of 139**                                     |

**487 forming evaluations produced zero information that the 139 closes did not
already carry.** Not one target moved before its bar closed.

Why the stop entry fired at the close rather than mid-bar: on the closing tick the
body places the stop, and the POOC pass checks it against the close price only. If
the close already crosses the level it fills right there. It survives into the next
bar — and can then fill against the developing range — only when the previous close
did _not_ cross. On trending real data the close usually crosses first. The
synthetic zig-zag in `every-update-runner.ts` manufactured that overshoot; real
BTCUSDT in this window did not produce it.

This is one window, one symbol, two strategies — not proof that intrabar evaluation
is never useful. But it is a real measurement against the case you would actually
run, and the burden of proof sits with the cadence: before paying 4.5× the journal
rows and a strategy that must tolerate speculative re-evaluation, measure whether
your strategy's target actually moves mid-bar on your data. This script is how.

**What it is not:** a live stream. It replays real history at full speed rather than
following the market. For that, see case 06.

### 06 — realtime 5m chart from live 1m bars

**Requires network.** This is the real thing: a continuously running 5m chart whose
forming state is rebuilt from Binance's live 1m kline stream.

```bash
bun packages/pinelive/src/cli.ts validate --config examples/pinelive/06-binance-realtime-5m-1m.json
PINELIVE_RUNS_DIR=/tmp/pinelive-live bun packages/pinelive/src/cli.ts run --config examples/pinelive/06-binance-realtime-5m-1m.json
# Ctrl-C to stop. In another shell:
PINELIVE_RUNS_DIR=/tmp/pinelive-live bun packages/pinelive/src/cli.ts status --all
```

`BinanceLiveProvider` implements the `liveBars()` contract over Binance's public
keyless kline WebSocket, so `every-update` is now reachable from configuration
instead of only from a hand-built replay trace. Selecting it is a **data** decision
only — execution authority stays entirely with `execution.broker`.

**The cadence is exactly one re-evaluation per closed 1m bar.** Measured live,
subscribing deliberately mid-bucket at 08:12:20:

```
subscribed at 08:12:20
wall=08:13:00  chart=08:10  rev=1  forming  close=62540      <- seeded from REST
wall=08:13:00  chart=08:10  rev=2  forming  close=62518.9    <- seeded from REST
wall=08:13:00  chart=08:10  rev=3  forming  close=62560      <- live 08:12 child
wall=08:14:00  chart=08:10  rev=4  forming  close=62568
wall=08:15:00  chart=08:10  rev=6  FINAL    close=62566.01
wall=08:16:00  chart=08:15  rev=1  forming  close=62563.03
wall=08:17:00  chart=08:15  rev=2  forming  close=62522.01

per wall-clock minute: 08:13=3  08:14=1  08:15=1  08:16=1  08:17=1
```

One update per minute, on the boundary, after the initial catch-up. Each completed
bucket yields four forming snapshots plus one authoritative final whose bar is the
exact aggregation of the five 1m children — published only once every child slot has
closed. (The final's revision skips a number because the closing child's forming
snapshot is computed and then suppressed: it would carry the identical bar.)

Two behaviors make that cadence hold, and both were bugs found by measuring:

- **Forming child klines are ignored.** Binance streams forming 1m klines about every
  two seconds. Forwarding them produced ~30 chart updates per minute, mostly
  re-reporting an unchanged price, which made `timeframe: '1m'` meaningless. A
  lower-bars subscription is defined by its child _bars_, so only closed children
  advance the chart. Sub-child granularity is what `source: { kind: 'native' }` is for.
- **A mid-bucket start is seeded from REST.** The aggregator can publish nothing until
  slot 0 of a bucket is present, and its bounded forming state forbids carrying a
  partial bucket into the next one — so joining late used to discard the current bucket
  and sit silent for up to a full chart period. The provider now backfills the elapsed
  closed children of the current bucket once, so the first snapshot is immediate and
  the first final lands at that bucket's own close. A backfill that comes back
  incomplete or non-contiguous is discarded rather than used, falling back to waiting
  for the next boundary.

The decision id records the whole provenance, e.g.
`intrabar:sha256-…:binance%3ABTCUSDT:5:lower-bars:1m:1785738900:149:final` —
`lower-bars:1m` source, bar open, revision, `final`.

**Write volume.** Every evaluation is a durable ledger row and the ledger is
append-only, never pruned. At five rows per 5m bar and ~1 KB each that is roughly
**1,400 rows and 1.5 MB per day** — modest. `throttleMs` is now near-irrelevant for
this cadence: updates arrive a minute apart, so any throttle below 60,000 drops
nothing.

A healthy run of either posture reports `lifecycle=running` with no reasons:

```
posture=compute-only  lifecycle=running    reasons=(none)
posture=live          lifecycle=running    reasons=(none)
```

That took a fix. Compute-only holds a physical state lock but journals no durable
lease row — its posture cannot submit broker effects, so ownership is never recorded
as execution authority. Discovery read that designed absence as an ownership
mismatch, so every healthy compute-only run reported
`lifecycle=unknown  reasons=physical execution lease does not match durable ownership`
and the state machine could never reach `running`. `compareExecutionLease` now treats
a missing durable lease row as expected when the **durable ledger itself** proves a
compute-only posture, the registration agrees, no durable lease row exists at all,
and the physical lock's pid and boot identity match the registration exactly. A
mirrored posture never gets that relaxation: a live run with a physical lock but no
journaled ownership is still reported as a mismatch.

## The three flags, ranked by how much they actually matter

| Flag                      | Effect on a Pinelive run                                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `process_orders_on_close` | **Large.** Decides whether piner's assumed fill price matches the price you really get. See 02 vs 03.                                                                                                                                                      |
| `use_bar_magnifier`       | Historical only — in Pinelive that means **warmup fidelity**, which sets the state you carry into the live phase. Always falls back on realtime bars. Hard failure together with `calc_on_order_fills`. Needs explicit finite budgets.                     |
| `calc_on_every_tick`      | **None, behaviorally.** Inert in piner; a consent gate for a cadence that can now be driven live (case 06) but still cannot execute — forming decisions are always journaled as skipped. Only surfaces new information for strategies with resting orders. |

## What these examples cannot show

- **Real broker execution.** `armed: false` connects read-only and mutates
  nothing; `armed: true` hits the production gate, and the built-in official
  Tiger adapter is deliberately ineligible because it cannot prove complete
  open-order inventory, exact order absence, or a gap-free account stream. Paper
  is the only broker these examples actually trade against.
- **Intrabar execution.** Even with a live intrabar feed (case 06), mirrored
  every-update is forced to Paper and rewritten to `mirrorOn: "bar-close"`. Forming
  decisions are journaled as skipped; only an authoritative close can move a
  position.
- **Venue-resident protective orders.** Your Pine stops live inside piner only.

Live _data_, however, is no longer a gap: `binance` can be selected for a live run
with either cadence. Every other pinery adapter (`okx`, `kraken`, `alpaca`,
`massive`) is still history-only, and Tiger polls `closedBars()` with no `liveBars()`.

## The 5m set

Same lessons, on the timeframe you probably actually run. These use their own fixture
so nothing in `examples/data` is disturbed:

- `examples/pinelive/data/BTCUSDT_5m.csv` — 599 contiguous real Binance 5m bars
  (2026-08-01 05:20Z → 2026-08-03 07:10Z), 0 grid gaps. Verified before committing:
  every one of the 199 buckets that could be cross-checked is byte-identical to its
  own 1m aggregation, so the series is internally consistent.
- `examples/pinelive/data/instruments.csv` — real BTCUSDT metadata
  (`minQty 0.00001`, `mintick 0.01`).

Each replays 60 warmup bars then 249 live bars (`cutoverTime` 1785666600 =
2026-08-02 10:30Z). That window was picked deliberately: it contains four SMA(10/30)
crosses — two complete round trips — because a window with no trades makes the timing
comparison below vacuous.

```bash
bun packages/pinelive/src/cli.ts run --config examples/pinelive/5m-01-compute-only.json
bun packages/pinelive/src/cli.ts run --config examples/pinelive/5m-02-paper-default-timing.json
bun packages/pinelive/src/cli.ts run --config examples/pinelive/5m-03-paper-aligned-timing.json
bun packages/pinelive/src/cli.ts run --config examples/pinelive/5m-04-paper-sub-minimum.json
bun packages/pinelive/src/cli.ts run --config examples/pinelive/5m-05-intrabar-1m-children.json
```

Observed:

| Config                            | evaluations | intents | completions | paper realizedPnl |
| --------------------------------- | ----------- | ------- | ----------- | ----------------- |
| `5m-01-compute-only.json`         | 249         | —       | —           | — (no broker)     |
| `5m-02-paper-default-timing.json` | 249         | 4       | 4           | **20.53**         |
| `5m-03-paper-aligned-timing.json` | 249         | 4       | 4           | **25.15**         |
| `5m-04-paper-sub-minimum.json`    | 249         | **0**   | **0**       | **0** (unchanged) |
| `5m-05-intrabar-1m-children.json` | **0**       | —       | —           | — (no broker)     |

The timing lesson reproduces on 5m: same four trades, **22% more realized P&L** purely
from `process_orders_on_close`. `5m-04` again writes zero orders while piner trades all
the way through. And `5m-05` is the honest version of case 05 — a real 5m chart with
real 1m children, which gets past warmup and then performs **zero evaluations**,
because the CSV/Replay path needs a `BarUpdate` trace and `createNodeMarketDataProvider`
supplies none. For a 5m/1m chart that actually evaluates, use case 06.

### A footgun worth knowing

Compute-only ledger and lock paths are derived from **strategy + symbol + timeframe**
and ignore the data source. Case 06 and an earlier draft of `5m-05` shared all three,
so running one after the other failed with:

```
pinelive: prepared authority mismatch: recovered sha256-bf32…, current sha256-9cae…
```

That is the prepared-authority gate working correctly — it refuses to continue a
ledger built from different history — but it means two compute-only configs differing
_only_ in their data provider will collide. `5m-05` now uses a distinct strategy to
avoid it. If you hit this in your own configs, either vary one of the three path
components or `rm -rf .pinelive` when switching a compute-only run's data source.

## Checking a run afterwards

```bash
bun packages/pinelive/src/cli.ts status --ledger .pinelive/03-aligned-timing.jsonl --json --recent 20
bun packages/pinelive/src/cli.ts status --all --json          # every registered run
```

`status` is read-only: it opens no provider, broker, lease, or claim. For
quantity agreement against a backtest, build `{barTime, target}` records and use
`pinelive parity <live.jsonl> <expected.jsonl>`. Note that parity compares
targets and positions only — never fill prices or P&L, so it can come back clean
while 02 and 03 differ by 54%.

## Cleanup

```bash
rm -rf .pinelive
```

Paper account state is process-local and does not survive a restart, so re-runs
start flat while the append-only ledger keeps growing.

Every run also registers itself in the private run registry at `~/.pinelive/runs`,
which is what `status --all` and pinetop's LIVE page read. Experimenting with
these examples will accumulate terminal history records there. Keep them out of
your real registry with:

```bash
PINELIVE_RUNS_DIR=/tmp/pinelive-examples bun packages/pinelive/src/cli.ts run --config examples/pinelive/03-paper-aligned-timing.json
PINELIVE_RUNS_DIR=/tmp/pinelive-examples bun packages/pinelive/src/cli.ts status --all
```

Re-running the same config twice produces two records that share one derived
execution identity, so `status --all` will flag them with a
`duplicate-execution-id` warning. That is expected here; on a real deployment it
means two runs claim the same execution.
