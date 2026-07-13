# `pinerun upgrade`

> Update pinerun to the latest release, in place.

Checks GitHub Releases for a newer version and, when one exists, downloads this
platform's prebuilt binary, verifies its sha256 against the release's
`checksums.txt`, and atomically replaces the currently running executable. One
command, no reinstall, nothing else touched.

## Synopsis

```bash
pinerun upgrade [--check]
```

## Parameters

| Flag      | Default | Description                                                 |
| --------- | ------- | ----------------------------------------------------------- |
| `--check` | off     | Only report whether a newer release exists; change nothing. |

## How it works

1. Resolves the latest release tag from `github.com/heyphat/pinestack/releases/latest`.
2. Compares it to the running version (what `pinerun --version` prints). Already
   up to date — or ahead of the latest release, as a dev build is — means
   nothing to do.
3. Downloads the matching asset (`pinerun-<os>-<arch>[.exe]`) and the release's
   `checksums.txt`, and verifies the binary's sha256. A mismatch aborts with
   nothing replaced.
4. Stages the new binary next to the current one, then swaps it in with an
   atomic rename — the running process keeps executing its own copy. On Windows,
   the old `.exe` is moved aside first (a running executable can't be
   overwritten) and cleaned up best-effort.

Only the **compiled binary** self-updates. From a source checkout, `upgrade`
refuses — `git pull && bun run build:bin --install` instead. If the install
directory isn't writable (e.g. a system location), it tells you to re-run with
`sudo` or re-run the installer.

## Examples

Is a newer release out?

```bash
pinerun upgrade --check
```

```text
  current  0.1.1
  latest   0.2.0

  update available — run: pinerun upgrade
```

Upgrade in place:

```bash
pinerun upgrade
```

```text
  current  0.1.1
  latest   0.2.0

  downloading pinerun-darwin-arm64 (v0.2.0)…
  61 MB downloaded, checksum verified

✓ upgraded 0.1.1 → 0.2.0  (/Users/you/.local/bin/pinerun)
  verify: pinerun --version
```

> **Note:** binaries from v0.1.0 predate this command. If `pinerun upgrade`
> prints `unknown command`, re-run the install one-liner from the
> [project README](../README.md#install) once — every later version can then
> self-update.

## See also

- [Command index](./README.md)
