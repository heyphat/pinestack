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
- **Untrusted Pine source** — `pinerun` compiles and runs arbitrary Pine
  scripts via piner. Ways a crafted script can escape piner's sandbox, exhaust
  resources, or reach the host through the orchestration layer (workers,
  filesystem cache, CSV/plot export) are in scope.
- **Untrusted provider responses** — ways a malicious or malformed HTTP response
  from a data provider can cause code execution, path traversal (e.g. via the
  cache key), or resource exhaustion.
- Prototype pollution or arbitrary code execution through the CLI argument or
  job pipeline.

Engine-level sandbox escapes belong to [piner](https://github.com/heyphat/piner);
report those against that repository.

Thanks for helping keep pinestack and its users safe.
