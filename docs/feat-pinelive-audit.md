# `feat/pinelive` audit and remediation record

Logic and safety audit of every change on `feat/pinelive` relative to `main`
(merge base `2bf4f60`, commits `17f5f30`, `b1f864b`, `0a78b70`, `d99de0d`).

| | |
| --- | --- |
| Diff | 108 files, +32,563 / −619 |
| Audit date | 2026-07-31 |
| Test baseline | 735 pass, 4 skip, 0 fail across 57 files (Bun 1.2.5) |
| Verdict | **One critical execution defect. Do not run the every-update mirrored path until F-1 is fixed.** |
| Remediation | **All findings dispositioned on 2026-07-31, same branch.** F-1…F-9 fixed in code, F-10 documented as a contract, F-11 fixed with fail-closed defaults, F-12 resolved by this file plus a changelog correction. Post-fix suite: 744 pass, 4 skip, 0 fail across 60 files. Each finding below carries a **Disposition** describing the exact change. |

## Scope and method

Read in full: `pinelive/src/core/{scheduler,intrabar-server,intrabar-authority,ledger,mirror,binding,broker,lease,types,time,units}.ts`,
`pinelive/src/brokers/paper.ts`, `pinelive/src/node.ts` (persistence and lease),
`pinery/src/live/{aggregation,validation}.ts`, and the `pinerun` diff. Read
selectively, driven by the claims in `docs/pinelive.md`:
`intrabar-runner.ts`, `recovery.ts`, `config.ts`, `security.ts`, `cli.ts`,
`pinery/src/live/stream.ts`.

Findings were not accepted from reading alone. Each one below is either proven by
an executed reproduction, or marked with an explicit confidence level and the
mechanism that would have to hold for it to bite.

> **Dependency note.** This branch adds `@tigeropenapi/tigeropen@0.5.4` to both
> `pinery` and `pinelive`. A stale `node_modules` produces 31 failures and 10
> errors concentrated in the `pinerun` CLI tests, which read as source
> regressions but are not. Run `bun install --frozen-lockfile` first.

## Findings

| ID | Severity | Area | Summary | Disposition |
| --- | --- | --- | --- | --- |
| [F-1](#f-1) | **Critical** | scheduler | Forming-revision skips consume the per-bar target budget, so the every-update mirrored path never trades and still reports success | Fixed |
| [F-2](#f-2) | Major | scheduler | Per-decision state is never pruned, so a multi-day forward test grows without bound | Fixed |
| [F-3](#f-3) | Major | pinery live | Exact float equality on summed volume can spuriously abort a live run | Fixed |
| [F-4](#f-4) | Minor | scheduler | 32-bit fallback hash for `decisionId` / `eventId` | Fixed |
| [F-5](#f-5) | Minor | scheduler | Exact float compare for target attainment costs a redundant round trip | Fixed |
| [F-6](#f-6) | Minor | scheduler | `localeCompare` key ordering inside a durable identity hash | Fixed |
| [F-7](#f-7) | Minor | binding | `pointValue` can drive PnL without being attested by the binding | Fixed |
| [F-8](#f-8) | Minor | mirror | Zero-offset limits are non-marketable on tick-misaligned data | Fixed (diagnosability) |
| [F-9](#f-9) | Minor | paper | `available` is equity, not buying power | Documented |
| [F-10](#f-10) | Note | scheduler | Benign provider bar revisions reject the caller instead of journaling a skip | Documented contract |
| [F-11](#f-11) | Note | scheduler | Standalone `TargetScheduler` defaults leave every safety limit off | Fixed |
| [F-12](#f-12) | Note | docs | Four links pointed at this file before it existed | Fixed |

---

### F-1 — Forming-revision skips consume the per-bar target budget {#f-1}

**Severity: critical. Confirmed by reproduction at both the unit and public-API level.**

In the every-update mirrored configuration, no order is ever placed after the
first couple of seconds of a bar, and the run still returns
`executionSafe: true`.

The per-bar admission counter is shared between two paths that should not share
it:

- `appendSkipped` increments `counter.targets` for any decision id it has not
  seen before (`packages/pinelive/src/core/scheduler.ts:1575-1583`), and
  `journalSkipped` routes through it.
- `accept` refuses admission once `counter.targets >= limits.maxTargetsPerBar`
  (`packages/pinelive/src/core/scheduler.ts:877-885`).

The intrabar server journals **every** non-final revision of a bar through that
same counter — `journalSkipped(target, 'forming', 'mirrorOn=bar-close')` at
`packages/pinelive/src/core/intrabar-server.ts:372` — and pins
`maxTargetsPerBar` to `DEFAULT_MAX_TARGET_CHANGES_PER_BAR`, which is `8`
(`intrabar-server.ts:816-824`, `config.ts:280`). That limit is not
configurable: `config.execution.scheduler` is rejected while
`mirrorOn: "every-update"` is fail-closed (`config.test.ts:367`).

Because each forming revision has its own `decisionId` (it embeds the revision
number and a `forming`/`final` discriminator —
`intrabar-runner.ts:1173-1190`), each one burns one of the eight slots. The
authoritative close is the ninth or later arrival for the bar, so it is refused
with reason `target-limit`.

The default forming throttle is 250 ms (`config.ts:269`) and it is measured
against provider `eventTime`, not wall clock
(`packages/pinery/src/live/stream.ts:57`). A bar therefore admits up to four
forming revisions per second of market time: roughly 240 on a 1-minute bar and
14,400 on a 1-hour bar. The eight-slot budget is exhausted within the first
seconds of every bar, so this is not an edge case — it is the steady state.

Three things make it silent rather than loud:

- No circuit breaker latches; `target-limit` is an ordinary skip.
- The intrabar server only logs when `status === 'unknown'`
  (`intrabar-server.ts:397-399`), and this is `skipped`.
- The mirrored result still reports `executionSafe: true` with a `finalPosition`.

It also survives restart: recovery rebuilds `targets` from the persisted
`evaluation.skipped` rows (`recovery.ts:531-533`).

**Blast radius.** Every-update cadence with a mirrored Paper broker — the
combination `docs/pinelive.md` documents as supported ("An every-update cadence
may compute forming revisions, but they are durably skipped and only the
authoritative final can reach Paper") and `config.test.ts:251` explicitly
allows. Close-only cadence is unaffected, because it produces exactly one target
per bar. Compute-only is unaffected: `ComputeDecisionJournal` keeps its own
counter but enforces no limit (`intrabar-server.ts:710-730`).

**Reproduction.** End-to-end through the public `runIntrabarServer`, using an
every-update Paper config with `mirrorOn: "bar-close"` and 24 forming revisions
spaced past the 250 ms throttle before the authoritative close:

```
skip reasons: [[1,"forming"],[2,"forming"],[4,"forming"],[5,"forming"],[7,"forming"],
               [9,"forming"],[10,"forming"],[12,"forming"],[14,"forming"],[15,"forming"],
               [17,"forming"],[18,"forming"],[20,"forming"],[22,"forming"],[23,"forming"],
               [25,"target-limit"]]
accepted:         0
order.intent:     0
breaker rows:     0
mode: mirrored    executionSafe: true
final position:   {"symbol":"X","qty":0,"realizedPnl":0,"unrealizedPnl":0}
```

The strategy is long 1 at the authoritative close (close 11 > open 10). The run
holds 0 and calls itself safe. The reduced unit-level reproduction is eight
`journalSkipped(..., 'forming')` calls for one bar followed by one `schedule` of
that bar's close, against a `TargetScheduler` with
`limits: { maxTargetsPerBar: 8 }`; the close resolves to
`{ status: 'skipped', reason: 'target-limit' }` with zero submits. Both repro
files are attached to the audit session rather than committed, since a
committed form should be an assertion of the fixed behaviour.

**Fix direction.** Journaling must not consume admission budget. Either count
only decisions that were actually accepted, or give journal-only skips a
separate counter. Note that the ledger's `targetOrdinal` is validated against
the same counter during recovery (`recovery.ts:484`, `recovery.ts:532`), so the
counter semantics and the persisted ordinal have to change together, and old
ledgers need a read path that still validates. Independently, a
`target-limit` refusal of an `authoritativeFinal` update should latch the
breaker or at minimum log — dropping the only executable update of a bar should
never be indistinguishable from an ordinary coalesce.

**Disposition: fixed.** The shared ordinal counter is untouched — `targetOrdinal`
keeps its exact durable meaning and old ledgers replay byte-for-byte — while
admission now gates on a new `admitted` count that only `evaluation.accepted`
events increment (`scheduler.ts` accept path, `recovery.ts` accepted branch).
Journal-only skips advance the ordinal but never consume budget. Refusing an
`authoritativeFinal` update by `target-limit` now latches the breaker with a new
durable breaker reason `target-limit` (added to `BreakerReasonV3` and recovery's
reason validation), and the intrabar server logs the refusal. Regression tests:
`test/forming-budget.test.ts` (24 forming skips never starve the close; a
refused final latches; a refused non-final stays quiet) and
`test/intrabar-forming-budget-e2e.test.ts` (the original end-to-end
reproduction, now asserting the mirrored run reaches its target with exactly one
accepted evaluation and one order intent).

### F-2 — Per-decision state is never pruned {#f-2}

**Severity: major. Confirmed by inspection.**

`TargetScheduler` holds seven maps that only ever grow
(`packages/pinelive/src/core/scheduler.ts:230-237`): `perBar`, `decisions`,
`unresolved`, `clientMappings`, `latestChartUpdates`, `activeChartUpdates`,
`eventIdToDecisionId`. `unresolved`, `latestChartUpdates` and
`activeChartUpdates` are self-limiting. `decisions`, `eventIdToDecisionId`,
`clientMappings` and `perBar` are not.

Every forming revision permanently adds a `decisions` entry holding a full
event object plus an `eventIdToDecisionId` entry, via `appendSkipped` →
`rememberAdmittedChartUpdate`. At the 250 ms default throttle that is up to four
new permanent entries per second — on the order of 345,000 per day. The same
pattern exists in the compute-only journal, whose `decisionIds` set and `perBar`
map are also unbounded (`intrabar-server.ts:673-674`).

This matters because the whole point of the package is multi-day forward
testing. The entries are load-bearing for duplicate detection, so pruning needs
a deliberate policy — a bounded window keyed on the recovery horizon rather than
a blind eviction.

**Disposition: fixed.** Both the scheduler and the compute-only journal now keep
a per-bar reverse index and prune finalized bars beyond a retention window
(default `DEFAULT_DECISION_RETENTION_BARS = 512` per binding, `retainBars`
option on `TargetSchedulerOptions`). Pruning is in-memory only — durable rows
are never touched. A bar is retained while any of its logical orders is
unresolved or its position uncertainty has not been reset, and a stale duplicate
of a pruned decision is rejected fail-closed by the chart-update admission gate
instead of resolving as a silent duplicate. `state.retainedDecisions` /
`state.retainedBars` expose the bound. Covered by two tests in
`test/forming-budget.test.ts` (window bounded with all durable rows intact;
unresolved bars survive pruning pressure).

### F-3 — Exact float equality on summed volume {#f-3}

**Severity: major. Confidence: medium-high — the mechanism is certain, whether it
fires is data-dependent.**

`ExactChildBarAggregator.finalize` recomputes the parent bar from its child bars
and compares it to the provider's authoritative final with exact `===` on every
OHLCV field (`packages/pinery/src/live/aggregation.ts:194-199`, `299-308`).
`open`, `high`, `low`, `close` are selected values and compare exactly, but
`volume` is accumulated with `+=` over the children
(`aggregation.ts:265-270`).

Floating-point summation is order- and precision-sensitive, so a provider that
computed the same total differently can disagree in the last bit. The comparison
then fails and raises a non-retryable `malformed-data` error —
`'authoritative chart final conflicts with exact child aggregation'` — which
aborts the run. Integer volumes (futures, equities) are exact and safe;
fractional volumes (crypto) are exposed.

The same exact `sameBar` is used for duplicate-final dedupe in
`validation.ts:182-189`, where a false negative escalates into
`'live bar N has conflicting authoritative finals'`. A volume comparison
tolerance of a few ULPs, or an explicitly documented integer-volume
precondition, would close this.

**Disposition: fixed.** Both `sameBar` implementations now compare volume with a
relative 1e-9 tolerance while OHLC remains exact — selected values compare
exactly; only the summed field tolerates rounding noise. A real conflict moves
volume by far more than 1e-9 of its magnitude. Covered by
`packages/pinery/test/live-volume-tolerance.test.ts`, which demonstrates the
real float-summation scenario (0.1+0.2+0.1+0.2+0.1 ≠ 0.7) passing, a genuine
volume conflict still rejecting, and any OHLC difference still rejecting
exactly.

### F-4 — 32-bit fallback hash for `decisionId` / `eventId` {#f-4}

**Severity: minor. Confirmed by inspection; production paths are not exposed.**

`stableDecisionId` returns a 32-bit FNV-1a digest as eight hex characters
(`scheduler.ts:2170-2193`), and `legacyCloseOnlyUpdate` builds `eventId` the same
way (`scheduler.ts:2146-2168`). By the birthday bound there is roughly a 50%
chance of one collision by ~77,000 decisions.

A collision is fail-closed, not silently wrong: the colliding decision hits
`assertScheduledDecisionMatches` (`scheduler.ts:1822-1836`), which throws
`RangeError('duplicate decisionId has different evaluation identity')` and
rejects the `schedule` promise. So the exposure is availability, not a bad
trade.

The production intrabar path always supplies its own full-length deterministic
`decisionId`, so this only reaches callers that use
`schedule(target, context)` without a `decisionId` or a `decisionIdFactory`.
Worth widening to the SHA-256 helper already available in
`intrabar-authority.ts` before the v1 scheduler API is used in anger.

**Disposition: fixed.** `stableHash` widened to 64-bit FNV-1a (16 hex chars),
which moves the 50%-collision bound from ~77k to ~5×10⁹ decisions while staying
synchronous (the SHA-256 helper is async and `createItem` is not). Collisions
remain fail-closed either way. Durable fallback identities change with this —
acceptable because pinelive is source-only and unreleased.

### F-5 — Exact float compare for target attainment {#f-5}

**Severity: minor. Confirmed by inspection.**

`scheduler.ts:1414` decides the correction loop is done with
`outcome.actualAfter === outcome.target`, and `scheduler.ts:1178` does the same,
while the recovered-outcome paths use the tolerant `nearlyEqual`
(`scheduler.ts:819`, `1977`, `1998`).

With fractional quantities, float noise makes the exact compare fail even when
the position is correct. The loop takes another iteration, pays
`waitForInterval` (default 1000 ms, `config.ts:277`) and a redundant
`getPosition`, and then resolves via the epsilon no-op in
`mirror.ts:276-286`. The final ledger outcome is correct, so this is latency and
noise rather than incorrectness — but the two comparisons should agree.

**Disposition: fixed.** Both live-path attainment checks now use the same
`nearlyEqual` the recovered-outcome paths already used.

### F-6 — `localeCompare` inside a durable identity hash {#f-6}

**Severity: minor. Latent.**

The scheduler's canonical serializer sorts object keys with `localeCompare`
(`scheduler.ts:2199-2202`), whereas the authority serializer uses codepoint
comparison (`intrabar-authority.ts:213-215`). The scheduler's version feeds
`stableDecisionId`, which is durable across restarts.

Every key currently serialized is lowercase-initial ASCII, so the two orderings
agree today. A future key with a leading uppercase or non-ASCII character, or a
runtime with different ICU data, would silently change durable decision ids and
defeat recovery's duplicate detection. Use codepoint ordering for anything that
crosses a restart boundary.

**Disposition: fixed.** The scheduler's canonical serializer now sorts by
codepoint, matching the authority serializer. No durable identity changes for
any key currently serialized (all agree under both orderings today).

### F-7 — `pointValue` can drive PnL unattested {#f-7}

**Severity: minor. Confirmed by inspection.**

`createRunInstrumentBinding` compares `pointValue` only when the resolved
instrument carries one (`binding.ts:63-67`), and the binding identity records
`resolved.pointValue`. If the provider reports no `pointValue` but the broker
instrument does, nothing is compared and nothing is recorded — yet
`PaperBroker` multiplies realized and unrealized PnL by
`instrument.pointValue ?? 1` (`paper.ts:241`, `351`, `360`).

The result is a run whose economics are scaled by a contract multiplier its own
durable binding does not attest. Either require symmetry or record the
broker-side value in the binding.

**Disposition: fixed.** `createRunInstrumentBinding` now attests
`resolved.pointValue ?? brokerInstrument.pointValue` — whichever value execution
will actually use — in both the binding identity and the recorded fields. The
existing mismatch comparison when both sides report a value is unchanged.

### F-8 — Zero-offset limits on tick-misaligned data {#f-8}

**Severity: minor. Confirmed by inspection.**

`passiveLimitPrice` snaps a buy down and a sell up so rounding never becomes
more aggressive (`mirror.ts:168-186`) — correct in both directions. But with
`limitOffsetTicks: 0` and a reference close that is not on the tick grid, the
buy limit lands one tick below the mark, and `PaperBroker` then rejects it as
non-marketable (`paper.ts:207-216`).

The behaviour is conservative by design, but on tick-misaligned CSV data it
turns every buy correction into a durable reject. Worth an explicit
precondition that the reference price is tick-aligned, checked at config time
rather than discovered as a rejection per bar.

**Disposition: fixed (diagnosability, not economics).** The reference price is
runtime data, so a config-time check is not possible, and rounding a buy upward
would violate the never-more-aggressive rule — the conservative economics stand.
Paper's rejection message now names the limit and mark prices and explicitly
calls out an off-grid mark as the cause, and `docs/pinelive.md` documents the
tick-aligned-reference assumption. On the Tiger path a snapped passive limit can
legitimately rest and fill, so no venue behaviour changed.

### F-9 — `available` is equity, not buying power {#f-9}

**Severity: minor.**

`PaperBroker.getAccount` sets `available = balance + unrealizedPnl`, identical to
`equity` (`paper.ts:152-153`). There is no margin or buying-power model, so a
strategy cannot be validated against margin in paper mode. Undocumented; worth
stating in the Paper section of `docs/pinelive.md`.

**Disposition: fixed (documented).** The Paper section of `docs/pinelive.md` now
states that `available` equals equity and that margin-sensitive behaviour cannot
be validated in paper mode.

### F-10 — Provider bar revisions reject the caller {#f-10}

**Severity: note.**

`assertCanAdmitChartUpdate` rejects an update whose `barTime` is not strictly
greater than the last authoritative final for that stream
(`scheduler.ts:1671-1675`). A provider that re-delivers a corrected closed bar
under a new cursor therefore produces a `RangeError` out of `schedule` rather
than a journaled skip. Fail-closed and defensible, but a benign upstream
correction aborting the caller deserves either a documented contract or a
`duplicate`-style skip.

**Disposition: fixed (documented as a contract).** The rejection is deliberate —
the scheduler must never silently re-trade or re-journal a finalized bar — so it
is now stated as the admission contract in `assertCanAdmitChartUpdate`'s doc
comment: callers own benign upstream corrections.

### F-11 — Standalone scheduler defaults leave limits off {#f-11}

**Severity: note.**

`normalizeLimits` defaults `maxTargetsPerBar`, `maxIntentsPerBar`,
`maxAttemptsPerMinute` and `maxConsecutiveErrors` all to
`Number.MAX_SAFE_INTEGER` (`scheduler.ts:2093-2100`). A `TargetScheduler`
constructed without `limits` therefore has no consecutive-error breaker, no
per-bar caps and no rate limit. Only `intrabar-server.ts:816` supplies real
values. Given the class is exported from the public API, safe defaults would be
better than permissive ones.

**Disposition: fixed.** `normalizeLimits` now defaults every limit to the shared
config constants (8 targets/bar counted as admitted, 4 intents/bar, 20
attempts/minute, 3 consecutive errors) — the same rails the intrabar server
passes explicitly. `minIntervalMs` stays 0 so library callers control pacing.
Only one existing test needed its expectation updated, and only for the new
`admitted` counter field.

### F-12 — Dangling documentation links {#f-12}

**Severity: note. Fixed by this file.**

`docs/README.md:40`, `docs/pinelive.md:166`,
`docs/pinelive-adapter-contract.md:75` and `CHANGELOG.md:54` all referenced
`docs/feat-pinelive-audit.md`, which the branch did not contain. The changelog
describes it as a permanent record of 17 previously remediated findings; that
record was never committed. This document now occupies the path, but the earlier
finding-by-finding disposition it promises is not recoverable from the branch and
should be reconstructed or the claim softened.

**Disposition: fixed.** This file resolves the dangling links, and the changelog
entry was corrected to state plainly that the finding-by-finding disposition of
the earlier 17 findings was not retained and that this document is the current
audit record. A second changelog entry describes this audit's remediation.

---

## Verified sound

These were specifically checked and hold. They are recorded so a later reader
knows what has already been examined.

**Effect ordering.** Durability precedes every broker effect:
`evaluation.accepted` before the first position read, `order.intent` and
`order.attempt` before submit, `order.result` before the position refresh. The
hook contract in `mirror.ts:89-99` places `onOrderAttempt` outside the submit
`try`, so a hook failure genuinely proves submit was not called, and
`scheduler.test.ts:93-136` asserts the resulting trace.

**Retransmission safety.** A possibly-sent submit is never retried.
`mirror.ts:366-368` rethrows unless the adapter proved `definitely-not-sent`,
and `onOrderAttempt` independently refuses to retransmit when the intent is
marked unknown, when the prior attempt has no result, or when the prior result
lacks `definitely-not-sent` proof (`scheduler.ts:1052-1067`). Resolution of an
unknown order is read-only by construction — `resolveUnknownSubmission` only
calls `lookupOrder` and `getPosition`.

**Shutdown never flattens.** There is no `.flatten(` call site anywhere in
`pinelive/src` outside the broker implementations themselves.

**Arming.** Real execution is gated twice, in the registry
(`registry.ts:39-44`) and again inside `TigerBroker` (`tiger.ts:588`).

**Lease exclusion.** `NodeExclusiveFileLease.acquire` uses
`open(path, 'wx+', 0o600)` — `O_CREAT|O_EXCL`, atomic on a local filesystem —
maps `EEXIST` to a `contended` error, never steals a stale file, and
`assertHeld` re-reads the file and compares both `leaseId` and `ownerId` before
every effect (`node.ts:355-417`). The process-local `InMemoryExecutionLease` is
wired only into tests and offline orchestration; the CLI uses the file lease
(`cli.ts:327`, `cli.ts:698`).

**Ledger integrity.** `SequencedLedger` assigns one strict sequence, serializes
appends through a tail promise, rejects a non-monotonic clock, and permanently
poisons itself on the first append failure so a possibly-written sequence is
never reused (`ledger.ts:351-411`). `appendAt` passes an explicit timestamp, so
the rolling-attempt window and `recordedAt` agree exactly rather than drifting
between two clocks.

**Client id injectivity.** `stableClientId` length-frames every component
(`mirror.ts:146-166`), so arbitrary symbols and embedded delimiters cannot
collide, and limit type plus snapped price are identity components — matching the
documented claim.

**Quantity and price conservatism.** `units.snap` truncates toward zero and
re-verifies the reconstructed magnitude, so quantity rounding can only undershoot
(`units.ts:21-50`). Limit snapping is passive on both sides, and Paper caps the
fill at the limit price so slippage can never violate it
(`paper.ts:232-239`).

**Paper position maths.** Weighted-average basis on adds, and realized PnL of
`(price − avg) · sign(oldQty) · closingQty · pointValue` on reduces, are correct
for long and short, including partial closes and reversals
(`paper.ts:337-356`). Client-id idempotency replays the cached terminal instead
of re-applying a fill, and refuses a client id reused with different economics.

**Live data validation is strictly fail-closed.** Monotonic `eventTime`, exactly
one active forming bar, strictly increasing revisions per bar, OHLC sanity, and
no repair or reordering of input (`validation.ts:231-296`). `liveTimeframeSeconds`
refuses non-fixed timeframes outright rather than guessing calendar arithmetic
(`validation.ts:300-311`), which is what keeps day/week/month bars out of the
aggregation path.

**Authority integrity.** `assertPreparedAuthorityEnvelope` recomputes the digest
instead of trusting the persisted field, and the canonical serializer rejects
non-finite numbers, cycles and unsupported types
(`intrabar-authority.ts:177-230`).

**pinerun changes are a clean extraction.** `resolveLowerFetchTf` and
`resolveSameSymbolFetchTf` moved into pinery and are re-exported from
`pinerun/src/security.ts`, so pinerun's scans and pinelive's forward runner plan
byte-identical fetches from one implementation. `rawBarCount` was added to
`ResolvedMagnifierDataset` and the job hash version bumped 7 → 8
(`pinerun/src/hash.ts`), which correctly invalidates stale cache entries.

## Test coverage gaps

The gaps line up exactly with F-1 and F-2, which is why a 735-test suite passes
over a critical defect. Each gap below is now closed by the remediation tests
named in the finding dispositions, except where noted.

- **No test crosses the eight-target boundary on the mirrored path.**
  `intrabar-public-e2e.test.ts:254` exercises precisely one forming revision, and
  every mirrored end-to-end case uses close-only cadence with a single target per
  bar. `scheduler.test.ts` covers `target-limit` only via direct `schedule`
  calls with `maxTargetsPerBar: 1`, never mixed with `journalSkipped`. The
  interaction between the two admission paths is untested. *(Closed by
  `forming-budget.test.ts`.)*
- **No test asserts that an `authoritativeFinal` update is admitted.** That
  single assertion would have caught F-1. *(Closed by
  `intrabar-forming-budget-e2e.test.ts`.)*
- **No soak or long-horizon test**, so unbounded map growth is invisible.
  *(Partially closed: the retention tests bound the maps; a true soak test
  remains future work.)*
- **No fractional-volume aggregation test**, so F-3 cannot surface. *(Closed by
  `live-volume-tolerance.test.ts`.)*
- **Forming throttle behaviour is untested against event-time spacing.** The
  first version of the F-1 reproduction passed spuriously because all synthetic
  updates fell inside one 250 ms `eventTime` window and coalesced to a single
  revision; realistic spacing is what exposes the defect.
- **One intermittent failure was observed and not identified.** Across seven
  full-suite runs on an unmodified tree, six reported 735 pass / 0 fail and one
  reported 734 pass / 1 fail / 1 error. The failure did not reproduce in four
  subsequent consecutive runs and the run that caught it did not retain the test
  name, so it is recorded here as an open flake rather than a diagnosed defect.
  Given how much of this suite drives real timers, subprocess CLIs and
  promise-ordering assertions, it is worth pinning down before the branch is
  relied on for CI gating.

## Recommended actions

All completed on 2026-07-31; kept for the record with their outcomes.

1. ~~Fix F-1 before any every-update mirrored run.~~ Done: admission counts only
   accepted evaluations; a refused authoritative final latches the breaker with
   the new durable `target-limit` reason and is logged by the intrabar server.
2. ~~Add the two missing assertions as permanent tests.~~ Done:
   `test/forming-budget.test.ts` and `test/intrabar-forming-budget-e2e.test.ts`.
3. ~~Decide a retention policy for F-2.~~ Done: bounded per-binding window
   (default 512 bars, `retainBars`), never pruning unresolved or
   position-uncertain bars, durable rows untouched.
4. ~~Give F-3 a volume tolerance.~~ Done: relative 1e-9 on volume only, with
   `packages/pinery/test/live-volume-tolerance.test.ts` proving both directions.
5. ~~Fold F-4 through F-9 into ordinary hardening.~~ Done; see each finding's
   disposition.
6. ~~Reconcile F-12.~~ Done: changelog corrected; this file is the current audit
   record.

Post-remediation suite: 744 pass, 4 skip, 0 fail across 60 files (nine new
tests). The intermittent flake below remains open.

## Standing limitations (unchanged by this audit)

This audit is offline and repository-only. It adds no credentialed evidence and
does not alter the readiness limits already stated in `docs/pinelive.md`: no
credentialed Tiger quote, history, entitlement, demo order, cancellation or fill
was exercised; `userMark` is searchable metadata rather than a server-enforced
idempotency key; and armed restart remains unsafe until durable transmission
state and stale-contract/exposure preflight exist. Nothing here should be read
as sandbox or production approval.
