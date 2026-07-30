# Releasing pinestack

The A-to-Z runbook for cutting a new pinestack release — prebuilt `pinerun` and
`pinetop` binaries attached to a GitHub Release. There is **no npm publish**: the packages
run from TypeScript source in this workspace, and the binaries are the product.
A release publishes **no `pinelive` binary and no npm packages**:
`@heyphat/pinelive` remains source-checkout/workspace-only.

## Release model

Releases are **tag-driven**. Pushing a `v*` tag to GitHub is the single trigger:
it runs `.github/workflows/release.yml`, which typechecks, tests, cross-compiles
both binaries for every target, and **creates the GitHub Release itself**
(binaries + `checksums.txt` + auto-generated notes). Unlike piner, there is no
manual `gh release create` step. Everything else — version bump, changelog — is
done by hand, in a set order, _before_ the tag is pushed.

Nothing releases on a normal push or PR merge. Only a `v*` tag releases.

```
(if needed) publish the piner release this one depends on, bump @heyphat/piner
        │
        ▼
land changes on main
        │
        ▼
bump package versions + changelog  ──▶  chore(release) commit on main
        │
        ▼
tag vX.Y.Z on main  ──push──▶  release.yml  ──▶  GitHub Release w/ binaries
        │
        ▼
verify: gh release view · curl installer · pinerun/pinetop --version
```

Normal pushes and PR merges do not release anything. A matching tag push is the
release trigger; there is no separate manual `gh release create` step.

### Workflow limitations operators must cover

The repository workflow currently does **not** enforce all release policy:

- **Bun** locally, at the exact version pinned in `.github/workflows/release.yml`
  (`bun-version:`) — the compiled binaries are the product, and bun's
  compiler output changes between versions. Check with `bun --version`; bump the
  pin (both workflows, piner's workflows, and this line) deliberately.
  **Reproducibility caveat (measured on v0.5.0):** even at the same pinned Bun,
  a local rebuild is _near_-identical but not bit-perfect against CI —
  cross-compiled (CI Linux) vs native builds differ in ~34 bytes of Bun's
  standalone-executable trailer (one metadata field + the 32-byte content hash
  derived from it), with the other 59.5 MB byte-identical and `--version`/output
  behavior identical. So verify a release against **`checksums.txt` from the
  release assets**, not a local rebuild hash.
- **Push rights to `heyphat/pinestack`** — the tag push is the release. The
  workflow needs no secrets: it authenticates with the built-in `GITHUB_TOKEN`
  (`permissions: contents: write` is already declared in `release.yml`).
- **`gh` CLI** authenticated (`gh auth status`) — only for watching the run and
  polishing release notes; not required for the release itself.

- The trigger is broad `v*`, not strict `vMAJOR.MINOR.PATCH` validation.
- It does not prove that the tagged commit is on `main`.
- It does not compare the tag with package-manifest versions.
- It does not enforce lockstep versions across the three workspace packages.
- It does not run a built binary and inspect `pinerun --version`.
- Repository rulesets and branch/tag protections are hosted GitHub state and
  cannot be established from the checked-in workflow alone.

Complete the manual gates in this runbook before pushing a tag. Do not rely on a
successful workflow alone as proof that the release was cut from the right
commit or carries the right version.

## Version and artifact policy

Judge "breaking" from the **user's** view of the product: the `pinerun` CLI
surface first (commands, flags, output contracts like `--json` shapes and CSV
columns), then `pinetop`'s keymap and pages, then the programmatic API of
`@heyphat/pinerun` / `@heyphat/pinery` / `@heyphat/pinetop`.

Note that a `--json` shape is now a **contract between two shipped binaries**, not
just an output format: `pinetop` parses those payloads. Changing one is breaking
even if no user script reads it.

The four workspace packages are versioned **in lockstep** with the release tag:
`packages/pinerun/package.json`, `packages/pinery/package.json`,
`packages/pinetop/package.json` and `packages/pinelive/package.json` all carry
`X.Y.Z`, even when only one changed.
Each binary bakes in **its own** manifest version — `build-bin.ts` injects it
(plus the git commit) so `pinerun --version` and `pinetop --version` self-report.
Forget a bump and that binary reports the previous version.

Judge compatibility across the `pinerun` CLI and output contracts first, then
the public APIs of all three workspace packages. Adding pinelive's forward
execution surface, including deliberate data-boundary changes, warrants the
recommended `0.7.0` minor release after normal mainline integration.

The following manifests are versioned in lockstep with `vX.Y.Z`:

- `packages/pinerun/package.json`
- `packages/pinery/package.json`
- `packages/pinelive/package.json`

The private workspace-root package remains `0.0.0`; do not confuse that private
version with the pinned root dependency on `@heyphat/piner`.
`packages/pinerun/package.json` is also compiled into each standalone binary, so
a missed bump makes `pinerun --version` report the old version.

Release assets are intentionally limited to:

- `pinerun-linux-x64`
- `pinerun-linux-arm64`
- `pinerun-darwin-x64`
- `pinerun-darwin-arm64`
- `pinerun-windows-x64.exe`
- `checksums.txt`

The shell installer supports Linux and macOS on x64/arm64. Windows users
download the `.exe` manually. Neither path installs `pinelive`.

## Prerequisites

- **Bun 1.2.5**, matching the exact mainline CI/release toolchain. Preserve that
  pin when integrating branches; do not release with a floating `latest` setup.
- Push rights for `heyphat/pinestack` and permission to create release tags.
- An authenticated `gh` CLI for checking CI, hosted rules, and the release.
- A clean local worktree with all intended source and documentation committed.
- A green, current `main` containing the full release contents.

The workflow uses the built-in `GITHUB_TOKEN` with `contents: write`; no npm
publishing token is involved.

## Step by step

### 0. Preserve work and integrate normally

Never switch branches, pull, bump versions, or tag from a dirty feature
worktree. Start by checking:

```bash
git status --short
```

Any output is a stop condition. Preserve the work on its feature branch and
land it through the normal review process (or use a separate clean worktree).
Do not discard, hide, or tag around uncommitted and untracked release content.

After the feature work is preserved, merge current `main` normally. Resolve
conflicts semantically: retain both the feature and mainline's current engine,
exact-history/cache identity, and Bar Magnifier behavior. Do not use a wholesale
`ours`/`theirs` replacement and do not rewrite shared history merely to prepare
a release.

Edit `version` in **all four** package manifests to the release version:

```jsonc
// packages/pinerun/package.json  ← stamps `pinerun --version`
"version": "0.2.0",
// packages/pinetop/package.json  ← stamps `pinetop --version`
"version": "0.2.0",
// packages/pinery/package.json  ← kept in lockstep
"version": "0.2.0",
// packages/pinelive/package.json  ← kept in lockstep (source-only, still stamped)
"version": "0.2.0",
```

CI for that integrated commit must be green before release preparation starts.

### 1. Confirm the piner dependency

`@heyphat/piner` is installed from the npm registry and pinned by the root
`package.json` plus `bun.lock`. If the release depends on unpublished engine
behavior:

1. Release piner first using its own runbook.
2. Update the exact `@heyphat/piner` dependency in the root `package.json`.
3. Run `bun install` and commit both `package.json` and `bun.lock` through a PR.
4. Confirm a frozen install uses the intended registry release.

A local `build:bin --local` against a sibling piner checkout is development-only;
the GitHub workflow builds from the dependency recorded in the lockfile.

### 2. Create the release-prep branch

```bash
git switch -c chore/release-0.7.0
```

If the baseline or scope changed, choose a new version before editing anything.

### 3. Bump all three workspace manifests and regenerate the lockfile

Set `"version": "0.7.0"` in all three lockstep manifests:

```text
packages/pinerun/package.json
packages/pinery/package.json
packages/pinelive/package.json
```

Then regenerate workspace metadata and inspect the result:

```bash
bun install
bun run typecheck            # tsc -b across every package
bun test                     # full suite

bun run build:bin                              # host binary → dist/pinerun
./dist/pinerun --version                       # "pinerun X.Y.Z (<sha>)" — the NEW version

cd packages/pinetop && bun run build:bin && cd -   # → dist/pinetop
./dist/pinetop --version                       # line 1: "pinetop X.Y.Z (<sha>)" — the NEW version
                                               # line 2: the pinerun it found on PATH
./dist/pinetop --check-flags                   # schema still agrees with pinerun --help
```

The `--version` checks are the guard against a forgotten bump: each binary
reports whatever its own manifest said at compile time, so check both. Run a quick
smoke too (`./dist/pinerun scan examples/rsi.pine --symbols BTCUSDT --tf 1h
--limit 50 --rank "last(rsi)"`).

`pinetop --version` prints **two** lines — its own, then the `pinerun` it spawns.
Only the first is the release assertion (`./dist/pinetop --version | head -1`);
the second reports whatever is on your PATH, which during release prep is usually
the _previous_ version and is not a failure.

`--check-flags` belongs in this list because `pinetop` models pinerun's flags by
hand: if the release added or renamed a CLI flag, this is what catches the TUI
not knowing about it. It exits non-zero on drift.

If the bump touched dependencies, regenerate and inspect the lockfile, then
prove it is self-consistent — `bun.lock` must describe the same versions as the
manifests:

```bash
bun install --frozen-lockfile
```

CI does not gate on formatting, but keep the files you touched clean:
`bunx prettier --check <files>`.

### 5. Commit the release prep and merge to `main`

`main` is protected by a ruleset: changes land via **pull request with green CI**
(no direct pushes, no force pushes).

```bash
git checkout -b chore/release-X.Y.Z
git add packages/pinerun/package.json packages/pinetop/package.json \
        packages/pinery/package.json packages/pinelive/package.json \
        CHANGELOG.md bun.lock
git commit -m "chore(release): X.Y.Z"
git push -u origin chore/release-X.Y.Z
gh pr create --fill      # merge once CI is green
```

Do not bump the private root package version.

### 4. Reconcile and update `CHANGELOG.md`

First merge mainline's complete released history. Do not invent missing
`0.4.x`–`0.6.x` sections from a stale feature branch.

Then add `## [0.7.0] - YYYY-MM-DD` above the previous release, using Keep a
Changelog headings such as `Added`, `Changed`, `Changed (breaking)`, and `Fixed`.
Write user-visible behavior, not internal test or formatting work. Add the
compare link using the actual preceding tag:

```markdown
[0.7.0]: https://github.com/heyphat/pinestack/compare/v0.6.1...v0.7.0
```

Verify the date, previous tag, and every material breaking migration before
continuing.

### 5. Run pre-tag consistency checks

Set the intended values once:

```bash
VERSION=0.7.0
TAG="v$VERSION"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
```

The job runs: checkout → setup Bun → `bun install --frozen-lockfile` →
`bun run typecheck` → `bun test` → build all targets for `pinerun`, then for
`pinetop` → **verify** each linux-x64 asset self-reports the tag and
`--check-flags` agrees → `sha256sum` over both → create the GitHub Release with
every binary attached. Then confirm:

```bash
gh release view vX.Y.Z             # 10 binaries + checksums.txt attached
```

Expected assets — 5 targets × 2 binaries, plus one shared manifest:

```
pinerun-linux-x64     pinetop-linux-x64
pinerun-linux-arm64   pinetop-linux-arm64
pinerun-darwin-x64    pinetop-darwin-x64
pinerun-darwin-arm64  pinetop-darwin-arm64
pinerun-windows-x64.exe   pinetop-windows-x64.exe
checksums.txt
```

`checksums.txt` must list **all ten**: `pinerun upgrade` and `pinetop upgrade`
each resolve their own asset from it, so an asset missing there cannot
self-update even though it downloaded fine.

### 8. Verify the installer path end-to-end

The installer follows `releases/latest`, which now points at the new release. It
installs both binaries, so check both:

```bash
export PINESTACK_INSTALL_DIR=$(mktemp -d)
curl -fsSL https://raw.githubusercontent.com/heyphat/pinestack/main/scripts/install.sh | sh
"$PINESTACK_INSTALL_DIR/pinerun" --version            # → pinerun X.Y.Z (<sha>)
"$PINESTACK_INSTALL_DIR/pinetop" --version | head -1  # → pinetop X.Y.Z (<sha>)
```

Then confirm self-update resolves the new release from an older binary — this is
the one path CI cannot exercise, because it needs a _published_ release to look
at:

```bash
"$PINESTACK_INSTALL_DIR/pinetop" upgrade --check   # → already up to date
```

Then repeat without `PINERUN_VERSION` and confirm `releases/latest` resolves to
the same release. Test the Windows `.exe` by direct download on Windows.

The installer's checksum path is currently best-effort in some download or
lookup failure cases, rather than a universal hard failure. A successful
installer run therefore does not replace the independent checksum check in step 10. Review installer warnings rather than treating exit status alone as proof of
verification.

Finally, confirm the docs do not imply that this installer provides `pinelive`.
Pinelive remains runnable from a source checkout only.

### 12. Review generated notes

The workflow generates notes from commit/PR history. Compare them with the
changelog. If needed, replace them deliberately:

```bash
gh release edit v0.7.0 --notes-file <release-notes-file>
```

Do not paste shell-expanded secrets or account data into release notes.

## What `release.yml` does

| Step      | Command / action                                                       |
| --------- | ---------------------------------------------------------------------- |
| Checkout  | `actions/checkout@v4`                                                  |
| Bun       | `oven-sh/setup-bun@v2` (pinned `bun-version`)                          |
| Install   | `bun install --frozen-lockfile`                                        |
| Typecheck | `bun run typecheck`                                                    |
| Test      | `bun test`                                                             |
| Build     | `build-bin.ts all --product pinerun`, then `--product pinetop`         |
| Verify    | run each linux-x64 asset: `--version` matches the tag; `--check-flags` |
| Checksums | `sha256sum pinerun-* pinetop-* > checksums.txt`                        |
| Release   | `softprops/action-gh-release@v2` — uploads assets, generates notes     |

> Both binaries ship, so a release carries **10 assets** (2 binaries × 5 targets)
> plus one `checksums.txt` covering all of them. That single manifest matters:
> both `pinerun upgrade` and `pinetop upgrade` resolve their own asset from it, so
> an asset missing from `checksums.txt` cannot self-update.
>
> The workflow also **executes** the freshly built linux-x64 assets to assert each
> reports the tag being released, and runs `pinetop --check-flags` against the
> matching `pinerun`. A missed version bump is the one release mistake re-tagging
> cannot fix — the assets are already published — so it fails before the release
> step rather than after.

| Step      | Command / action                                                        |
| --------- | ----------------------------------------------------------------------- |
| Trigger   | push of a tag matching `v*`                                             |
| Checkout  | `actions/checkout@v4`                                                   |
| Bun       | `oven-sh/setup-bun@v2`, explicitly pinned to `1.2.5`                    |
| Install   | `bun install --frozen-lockfile`                                         |
| Typecheck | `bun run typecheck`                                                     |
| Test      | `bun test`                                                              |
| Build     | `bun run build:bin all` (5 targets, version + sha baked in)             |
| Checksums | `sha256sum pinerun-* > checksums.txt`                                   |
| Release   | `softprops/action-gh-release@v2`, uploading assets and generating notes |

If an integration conflict changes the workflow back to a floating Bun version,
stop and restore the mainline pin before tagging.

## Recovery and break-glass policy

Treat published tags and versions as immutable. The default recovery is always
to fix forward with a new patch release.

- **Workflow failed before creating a release:** diagnose and fix on `main`, then
  prefer a new version. Reusing a tag requires deleting/moving hosted state and
  can race cached or fetched references.
- **Release exists or assets were downloadable:** do not replace binaries under
  the same version. Patch forward.
- **`latest` points at a bad release:** an owner may mark it prerelease while a
  patch is prepared, but first confirm how GitHub currently resolves `latest`.
- **Tag points at the wrong commit:** stop the workflow if possible and patch
  forward if the tag or assets may have been observed.

Deleting a release, deleting or moving a tag, or disabling a hosted ruleset is
an owner-only break-glass action. It can invalidate provenance and user caches,
and it may be blocked by repository rules. Before such an action, capture the
run/release state, obtain explicit owner approval, verify the current rules with
`gh api`, and record exactly what changed. Do not encode a ruleset name or assume
protections exist without checking hosted state.

## Quick checklist

```
[ ] piner dependency current (publish + bump @heyphat/piner first if needed)
[ ] main is green (CI passing)
[ ] release changes merged to main
[ ] version bumped in ALL FOUR packages/pinerun + pinetop + pinery + pinelive package.json
[ ] bun.lock regenerated, inspected, and accepted by --frozen-lockfile
[ ] CHANGELOG.md section + compare link added
[ ] bun run typecheck / bun test pass
[ ] bun run build:bin && ./dist/pinerun --version reports the NEW version
[ ] (pinetop) cd packages/pinetop && bun run build:bin; ./dist/pinetop --version
[ ] (pinetop) ./dist/pinetop --check-flags agrees with this release's CLI flags
[ ] chore(release): X.Y.Z committed on main
[ ] git tag vX.Y.Z on main, pushed
[ ] release.yml green; gh release view shows 10 binaries + checksums.txt
[ ] curl installer → pinerun --version AND pinetop --version report X.Y.Z
[ ] pinetop upgrade --check on the previous release offers the new one
[ ] docs accurately state that pinelive is source-only and no npm publish occurs
[ ] (optional) release notes replaced with the CHANGELOG section
```
