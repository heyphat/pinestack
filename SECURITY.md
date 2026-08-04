# Security Policy

## Supported versions

pinestack is pre-1.0. Security fixes are applied to the latest release only.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the **Security** tab of the [repository](https://github.com/heyphat/pinestack/security).
2. Click **Report a vulnerability**.

We aim to acknowledge reports within a few days and will keep you updated on the
fix and disclosure timeline.

## Scope

pinestack fetches market data over the network and executes Pine Script through
the piner engine. Of particular interest:

- **Credential handling** — the data adapters read API keys and secrets from
  environment variables (`ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`,
  `MASSIVE_API_KEY`, …). Any path that logs, caches, or otherwise leaks these —
  including into the on-disk `.pinery-cache` or error output — is in scope.
  `pinetop` never accepts credentials as input: they are absent from its flag
  schema by construction, and it redacts them from the command line it echoes and
  from `.pinetop/session.jsonl`. A way to get a key onto that screen or into that
  file is in scope.
- **Untrusted Pine source** — `pinerun` compiles and runs arbitrary Pine
  scripts via piner. Ways a crafted script can escape piner's sandbox, exhaust
  resources, or reach the host through the orchestration layer (workers,
  filesystem cache, CSV/plot export) are in scope.
- **Untrusted provider responses** — ways a malicious or malformed HTTP response
  from a data provider can cause code execution, path traversal (e.g. via the
  cache key), or resource exhaustion.
- **Self-update** — `pinerun upgrade` and `pinetop upgrade` download a release
  asset and replace the running executable. Verification against the release's
  `checksums.txt` is mandatory, not best-effort: a path that installs an
  unverified or mismatched binary, is downgraded to skip the checksum, or writes
  outside the running executable's own path is in scope. Both commands share one
  implementation for exactly this reason.
- **Pinelive execution ownership and recovery** — Tiger account/instrument
  claims and ledger leases are local cooperative safety boundaries. Paths and
  ledger events must not reveal clear-text account identities; lock/claim files
  must remain permission-isolated; ordinary startup must never steal an
  existing artifact; and broker mutations must remain impossible after lease,
  claim, or synchronized-stream loss. `pinelive status` must stay read-only.
  `pinelive recover` must require explicit confirmation, conservative
  boot-bound/dead-process proof, exact durable/physical owner matching, no
  unresolved broker effects, and audit-preserving quarantine. Failed ownership
  durability acknowledgement must retain physical lease/claim evidence rather
  than unlink a possibly recorded owner; an unrecorded claim may be recovered
  only with exact same-owner/PID/boot-identity binding to the durable execution
  lease. Administrative-evidence restoration must never overwrite a concurrent
  owner. A path that
  bypasses these checks, weakens ambiguous-send no-retransmit behavior, or
  enables the official Tiger transport despite incomplete inventory/exact
  lookup/stream guarantees is in scope. See the
  [production-safety runbook](./docs/pinelive-production-safety.md).
- Prototype pollution or arbitrary code execution through the CLI argument or
  job pipeline.

Engine-level sandbox escapes belong to [piner](https://github.com/heyphat/piner);
report those against that repository.

Thanks for helping keep pinestack and its users safe.
