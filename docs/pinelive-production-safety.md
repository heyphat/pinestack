# Pinelive production-safety operations

This document describes the current Pinelive execution safety boundary, its operator workflow, and its limits. Pinelive has one current runtime and configuration format, explicitly `configVersion: 3`. This is an operational contract, not a claim that any broker integration is approved for production.

> **Current Tiger verdict:** the built-in official Tiger OpenAPI transport is intentionally **blocked and ineligible for armed production execution**. The pinned SDK cannot prove a complete open-order inventory, authoritative exact order absence, or gap-free snapshot-to-account-stream continuity. It therefore cannot resolve an ambiguous send safely after a crash. Armed startup stays broker-connected but reports `executionEligibility: "blocked"` and performs no broker mutation. The Node Tiger factory also requires a production safety guard by default.

Paper, compute-only runs, and unarmed Tiger monitor posture remain suitable for constrained testing subject to their documented limitations. A custom Tiger transport can satisfy the production synchronization interface, but doing so is only a software gate; venue, credential, market-access, deployment, and operational approval remain separate responsibilities.

## Safety authority model

No single file is treated as universally authoritative:

- **Venue synchronization** owns current account, exact-instrument position, and complete working/uncertain order inventory.
- **Deterministic warmup and the prepared authority record** own bar-derived strategy state.
- **The durable `schemaVersion: 3` ledger** owns effect intent, transmission certainty, terminal result evidence, breakers, and lifecycle transitions.
- **The ledger lease and account/instrument claim** provide cooperative same-host exclusion. They are not broker- or venue-enforced fencing tokens.
- **Status output** reports evidence from one explicit ledger. It does not contact the venue, inspect every physical lock, or prove another host is inactive.

A disagreement fails closed. Pinelive does not choose the most convenient source or infer flat/no-orders from a failed read.

## Runtime postures

All postures below use the current `configVersion: 3` configuration.

| Configuration                                                         | Effective posture  | Broker connection  | Account claim                                                      | Broker mutation                                               |
| --------------------------------------------------------------------- | ------------------ | ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| Compute-only                                                          | `compute-only`     | none               | none                                                               | impossible by construction                                    |
| Paper mirrored                                                        | `live`             | local Paper broker | not applicable                                                     | enabled while the ledger lease and breaker permit it          |
| Tiger monitor, `execution.armed: false`                               | `monitor`          | yes                | none                                                               | disabled; evaluations are journaled as `execution-ineligible` |
| Tiger armed, built-in official transport or missing any safety proof  | `live` + `blocked` | yes                | acquired only when needed for bootstrap, then released on shutdown | disabled                                                      |
| Tiger armed, eligible custom adapter with all safety proofs satisfied | `live` + `enabled` | yes                | required                                                           | enabled only while the composite guard continues to hold      |

Blocked and monitor results are structured data, not necessarily process failures. Automation must inspect at least `executionSafe`, `executionEligibility`, and `eligibilityReasons`; a zero exit status alone is not proof that execution was enabled.

## Armed Tiger startup gate

The runtime performs these steps in order:

1. Acquire the configured ledger lease and record ownership durably in a `schemaVersion: 3` event. If stable-storage acknowledgement fails after the row may have been written, retain both the execution lease and administrative mutex for exact pre-journal recovery; never unlink ownership on an uncertain append.
2. Construct and connect the broker, resolve the exact contract, and compare the recovered binding before effects.
3. Resolve an opaque canonical account identity. Clear-text account ids are not written to claim paths or ledger claim events.
4. Acquire the same-host account/exact-instrument claim with `O_EXCL`, bound to the exact execution-lease owner; never steal an existing file automatically.
5. Record the exact claim id, owner id, and resource digest in the ledger. If that acknowledgement is uncertain, retain the claim and broader ledger lease. Explicit recovery accepts the otherwise-unrecorded claim only when its owner, PID, and boot identity exactly match the durable and physical execution-lease owner.
6. Establish one logical account synchronization boundary containing account state, exact-symbol position, complete open/uncertain-order inventory, authoritative exact lookup, a resumable gap-free account stream, and a current execution-safety assertion that latches on any unattributed account/order/position change.
7. Block on any working/uncertain order, any non-zero unexplained position, any unresolved durable broker effect, or any durable latched breaker.
8. Install a composite execution guard over the ledger lease, account claim, and synchronized stream.
9. Recheck that guard before broker effects and again after durable attempt recording, immediately before transmission.

Stream disconnect, rejected resume, sequence gap, overflow, staleness, or a current synchronized view containing a new working/uncertain order or exact-position change not attributable to a terminal mutation completed through this guarded runtime must make the execution assertion fail. That unsafe-account transition is latched until a new complete synchronization boundary is established; a healthy sequence alone is not sufficient. Lease or claim loss independently fails the composite guard. Guard loss latches `execution-interlock-lost` before a new transmission. Submit, cancel, flatten, and stuck-order cancellation also enforce the broker-side guard, so bypassing the scheduler does not bypass the gate.

On shutdown pinelive stops scheduling, revokes broker mutation capability, closes synchronization, records execution as blocked, durably releases the account claim, then releases the ledger lease. Shutdown never flattens automatically.

The release order is fail-closed. Account-claim teardown first durably writes `release-started` while the claim is still active, then removes the exact physical artifact, and only then writes `released`. Thus `released` always means physical removal completed. If physical release or the final durable confirmation fails, pinelive does **not** release the broader ledger lease or write a false ownership handoff; recovery continues to report the account claim active, with release-in-progress evidence when available. The CLI may close the ledger file handle, but the mirrored ledger lease is configured as externally managed and remains physically held/stale for explicit investigation and recovery. This intentionally sacrifices automatic restart: use the confirmed recovery workflow after proving the old process is gone and preserving the failed claim evidence.

## Ambiguous sends and restart behavior

Before transmission, pinelive durably records the logical order intent and attempt. A failure is retryable only when the adapter proves `definitely-not-sent`. Any other post-boundary error is treated as possibly sent:

- the logical order becomes unresolved;
- the breaker latches;
- the same logical order is not retransmitted;
- later execution remains blocked until exact venue evidence resolves it;
- `not-found`, `ambiguous`, or `unsupported` exact lookup is not resolution.

The built-in official Tiger adapter exposes only a bounded recent-order search. It therefore returns exact lookup `unsupported`, cannot clear ambiguous-send uncertainty, and remains production-ineligible. Do not manually edit a ledger to remove the unresolved effect and do not reset the breaker merely because an order is absent from a recent-orders screen.

On an armed restart with an eligible custom adapter, pinelive may reconcile recovered possibly-sent intents before enabling execution. While the ledger lease, account claim, and synchronized stream guard all hold, it performs authoritative exact lookup for each unresolved logical order and never resubmits it. Only exact terminal `filled` or `rejected` evidence can complete the intent; `not-found`, `ambiguous`, and `unsupported` remain blocking. A terminal result is also checked against the current exact-symbol position. A mismatch latches `position-unknown` and remains blocked. Only after every unresolved intent is durably completed may an ambiguity/recovery-related breaker be reset with a durable `venue-reconciled` event.

That reset is crash-resumable but deliberately narrow. If a process stops after writing the terminal exact resolution and completion but before `venue-reconciled`, explicit stale-owner recovery must first clear the abandoned ownership artifacts. The next armed startup may resume only when the currently latched ambiguity/recovery breaker precedes that matching terminal resolution/completion, no unresolved effect remains, and the new synchronized exact-symbol position equals the completion's durable `actualAfter`. A position mismatch or incomplete prefix remains blocked. This is runtime startup reconciliation, not the `pinelive recover` command, which deliberately never contacts the venue.

Paper state is process-local. The `schemaVersion: 3` durable ledger restores scheduler/effect history, not the simulated Paper account. A restarted Paper process can therefore expose a position mismatch and should not be treated as a durable brokerage account.

## Files and ownership

For a mirrored current config (`configVersion: 3`):

- ledger: `execution.ledger.path`, for example `.pinelive/ledger.jsonl`;
- ledger lease: `execution.lease.path`, for example `.pinelive/ledger.lock`;
- administrative mutex: `<execution.lease.path>.admin.lock`;
- account/instrument claim root: `~/.pinelive/claims/` by default;
- claim file: `~/.pinelive/claims/<account-digest>/<instrument-digest>.lock`.

Ledger, lease, administrative lock, and claim files are created mode `0600`. Account claim directories are forced to mode `0700`. Keep all paths on a local filesystem with reliable exclusive-create and rename semantics. These files coordinate mutually cooperative processes on one host only; they do not fence another machine, a manually operated broker session, another application, or a malicious local user with equivalent filesystem permissions.

Claim names use domain-separated SHA-256 digests. The ledger records only `resourceDigest`, `claimId`, and `ownerId`. To locate a claim for explicit recovery, list candidates without deleting them:

```bash
find "$HOME/.pinelive/claims" -type f -name '*.lock' -print
```

Inspect candidate JSON and match its `resourceDigest`, `claimId`, and `ownerId` to `pinelive status --json`/the ledger before passing the path to recovery.

## Read-only status

Status reads one explicit ledger path and constructs no provider, broker, alert channel, lease, or claim:

```bash
pinelive status --ledger .pinelive/ledger.jsonl
pinelive status --ledger .pinelive/ledger.jsonl --json --recent 20
```

The text form is a short ledger summary. Use `--json` for posture/eligibility evidence, active durable lease and claim, breaker state, unresolved effects, latest observation, counters, recent event headers, `schemaVersion`, byte counts, and partial-tail warnings.

Important interpretation rules:

- `availability: "not-recorded"` is not the same as a known empty/false value.
- A partial final JSONL fragment is excluded and reported; status does not repair it.
- Durable ownership describes ledger evidence, not a live OS-process probe.
- Status does not query the broker. A clean ledger cannot prove the venue is flat or has no orders.
- A completed run records a terminal blocked eligibility transition before releasing ownership. Active claim/lease evidence remains the decisive current-lifecycle signal.

## Ordinary startup and the administrative mutex

Ordinary startup and normally acquired explicit recovery share
`<lease>.admin.lock`:

- mirrored startup holds the administrative mutex across its first recovery read, execution-lease acquisition, owned reread, and the durable matching `lease: acquired` flush; only then can broker construction begin;
- compute-only startup holds it until its storage lease makes the recovery read stable;
- explicit recovery holds the same mutex for proof, quarantine, owned reread, and ledger repair.

When the administrative mutex is acquired normally and remains held, it
serializes ordinary startup and recovery within that ownership interval. It
does **not** currently make stale-administrative takeover concurrency-safe. The
stale path renames the old lock and then separately acquires its replacement;
an ordinary starter or second recovery can win that vacant-path interval. The
later no-clobber restoration rule protects live evidence after a different
failure, but it does not close this initial election race.

Until an OS-released advisory lock, supervisor-owned gate, or transactional
local coordinator replaces that rename/acquire gap:

- stop all startup/restart automation before stale recovery;
- obtain an external operator- or supervisor-grade mutex for the exact ledger
  resource and hold it through recovery plus post-recovery inspection;
- never run two stale recoveries concurrently; and
- do not automate stale recovery or detached restart.

Ordinary startup still never performs stale takeover itself. If a lease or
claim file already exists, it fails closed even when the file looks old.

Explicit confirmed recovery has one additional path for an abandoned
administrative mutex, because otherwise that mutex would make recovery
impossible. Recovery first attempts ordinary exclusive acquisition. On
contention it reads the recorded owner evidence, proves that exact process
instance is dead using boot-bound identity, rereads the metadata, and requires
it to be unchanged. It then renames the stale administrative lock to the same
audit-preserving quarantine suffix used for other ownership artifacts and
retries exclusive acquisition. This is the non-atomic interval described
above, so the external mutex is mandatory. Missing/malformed evidence, a live
or unverifiable process, or metadata change refuses recovery.

This stale-administrative evidence also closes the narrow crash before the first durable execution-lease event. Recovery may quarantine a physical pre-journal execution lease only when the ledger has no active durable lease and the stale administrative lock and execution lock have the same owner id, PID, boot-bound process identity, and exact expected resources. A new/empty ledger is allowed only in this case because broker construction cannot begin before the durable lease event. Without that exact same-process proof, recovery refuses the orphan lock.

A failed validation before any execution/account artifact moves restores the exact stale administrative evidence so the operator can correct the mismatched evidence and retry without reconstructing metadata. Restoration uses an atomic no-clobber link: if another startup or recovery acquires the mutex first, its live lock is never overwritten and the stale artifact remains at its quarantine path for audit and manual incident handling.

## Explicit stale-claim recovery

Use recovery only for abandoned local ownership artifacts, not broker-effect ambiguity. It is deliberately conservative and requires `--confirm`:

```bash
pinelive recover \
  --ledger .pinelive/ledger.jsonl \
  --lease .pinelive/ledger.lock \
  --account-claim "$HOME/.pinelive/claims/<account-digest>/<instrument-digest>.lock" \
  --confirm \
  --json
```

Omit `--account-claim` only when the durable ledger has no active account claim. Recovery refuses unless all of the following hold:

1. the administrative mutex is acquired normally, or its unchanged prior owner is conservatively proved dead and the stale mutex is quarantined;
2. physical metadata is readable and contains process-owner evidence;
3. the recorded PID is absent, or a boot-bound process identity proves PID reuse;
4. physical lease/claim ids, owners, resources, and resource digests match the durable active ownership; a missing physical claim is accepted only when the same active claim has a durable `release-started` event; an otherwise unrecorded physical account claim is accepted only as an acquisition-uncertainty case when its owner, PID, and boot identity exactly match both the durable and physical execution lease;
5. the ledger has no unresolved broker effect;
6. ownership is unchanged when reread under the replacement recovery lease.

Age and TTL are never proof. Permission-denied, missing process identity for a live PID, unsupported probing, malformed metadata, identity mismatch, current-process ownership, and unresolved effects all refuse recovery. Supplying `--account-claim` when that ledger has no active durable claim is refused unless the exact same-process acquisition-uncertainty proof above binds it to the active durable execution lease; a merely dead or unrelated orphan is never quarantined. If a durable `release-started` claim's expected path is already absent, the dead matching ledger owner and that intermediate event provide the only permitted missing-artifact exception.

For a namespaced, nonempty V3 ledger, successful recovery renames stale
artifacts to audit-preserving paths ending in
`.stale-<timestamp>-<uuid>`, acquires exclusive writer ownership, appends exact
prior-owner `lost` events, records recovery resumption, and releases recovery
ownership. If the abandoned runtime's latest eligibility was `enabled`,
recovery also appends a durable `blocked` transition that preserves the prior
posture while marking held claim/synchronization capability revoked; status
must not continue to report enabled after ownership is lost. An exact empty
pre-journal recovery can quarantine matching artifacts and return sequence zero
without creating namespaced journal rows. Recovery does not delete quarantine
files. Retain them until an incident review confirms they are no longer needed.

### Recovery checklist

1. Stop deployment automation and verify no ordinary starter can run.
2. Acquire an external operator- or supervisor-grade mutex for this exact
   ledger resource. Hold it through recovery, status verification, and the
   decision to restart; the current stale-administrative rename/acquire path is
   not concurrency-safe by itself.
3. Save `pinelive status --ledger <path> --json --recent 100` with the incident
   record.
4. Independently verify the old process instance is gone. Do not rely on file
   age.
5. Inspect the broker account out of band for open orders, uncertain orders,
   and exact-contract exposure. The recovery command does not contact the
   venue.
6. If status shows unresolved effects, stop. Resolve them with authoritative
   venue evidence; the recovery command will refuse them.
7. Match physical metadata to durable ids and run `recover ... --confirm`
   once. Never run a second recovery concurrently.
8. Preserve the returned quarantine paths and rerun read-only status.
9. Restart in unarmed monitor posture first. Do not arm until
   account/order/position evidence and the adapter synchronization guarantees
   are reviewed.

Never use `rm` as a recovery procedure. Deleting a lock can create two apparent owners and erases evidence needed to distinguish a dead process from a live or reused PID.

## Adapter requirements

A production-safety broker must add these guarantees to the baseline `Broker` contract:

- opaque canonical account identity stable for the authenticated environment;
- complete exact-symbol open/uncertain-order inventory;
- authoritative exact terminal lookup, including authoritative absence;
- account/position/order snapshot tied to a stream resume point;
- gap-free stream assertion that fails on disconnect, resume rejection, sequence loss, overflow, or staleness;
- current synchronized execution-safety assertion that remains failed after any working/uncertain order or exact-position change not attributable to a terminal mutation through the guarded broker, until a new complete boundary is established;
- an execution guard checked immediately before every mutation.

A collection of unrelated REST reads does not satisfy the snapshot/stream contract. A bounded order-history search does not satisfy exact lookup. Client metadata such as Tiger `userMark` is not a venue-enforced idempotency key.

## Tests and release evidence

The ordinary suite uses injected transports and real temporary directories; it requires no secrets. The credentialed Tiger test is opt-in and read-only:

```bash
PINELIVE_TIGER_CREDENTIAL_TESTS=1 \
PINELIVE_TIGER_TEST_SYMBOL=MGCZ26 \
TIGEROPEN_TIGER_ID='...' \
TIGEROPEN_PRIVATE_KEY='...' \
TIGEROPEN_ACCOUNT='...' \
TIGEROPEN_TOKEN='...' \
bun test packages/pinelive/test/tiger-credentialed.test.ts
```

A Tiger properties file through `TIGEROPEN_CONFIG_PATH` may be used instead of individual values. The test has two mutation-free phases: it first connects, resolves one instrument, reads account and position, and confirms that the official adapter reports synchronization blocked and exact lookup unsupported. It then creates a durable possibly-sent intent entirely against an injected offline transport and restarts that prefix through the credentialed official runtime. Broker and transport mutation methods are wrapped to fail the test; the restart must remain blocked, retain the unresolved effect, and append no new order attempt. This is restart/ambiguity coverage without a venue send. A real credentialed after-send test would remain unsafe until the official integration can prove exact lookup and snapshot/stream continuity.

Required release review should include the Pinelive test suite, type check, formatting, build, and a manual gate-by-gate audit. Passing tests do not override the official Tiger adapter's explicit blocked result.

## Remaining limitations

- The built-in official Tiger transport is not production-ready and cannot enable the armed gate.
- Same-host claims are cooperative exclusion, not venue fencing or distributed consensus.
- Status is explicit-ledger only; there is no global registry or `status --all` discovery surface.
- Recovery cannot reconcile the venue and refuses unresolved effects.
- No automatic futures rolling or exposure transfer exists.
- Credentialed read-only connectivity is opt-in; demo/live order mutation is not authorized by this runbook.
- Paper account state is not durable across process restart.
