# Releasing pinestack

The A-to-Z runbook for cutting a new pinestack release — prebuilt `pinerun` and
`pinetop` binaries attached to a GitHub Release. There is **no npm publish**: the packages
run from TypeScript source in this workspace, and the binaries are the product.
A release now also ships a standalone **`pinelive`** binary (forward runner).
The installer does **not** install it by default — it is an explicit
`PINESTACK_BINS` opt-in, because its Tiger adapters are offline-tested only and
not sandbox- or production-approved. Paper remains its default broker.

## Release model

Releases are **tag-driven**. Pushing a `v*` tag to GitHub is the single trigger:
it runs `.github/workflows/release.yml`, which typechecks, tests, cross-compiles
every binary for every target, and **creates the GitHub Release itself**
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

The `curl | sh` installer (`scripts/install.sh`) serves users from
`releases/latest/download/…`, so the moment the workflow finishes, new installs
get the new version.

## Prerequisites (one-time)

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
- **A clean worktree.** `git status --short` must print nothing. Never bump
  versions or tag from a dirty feature worktree: preserve that work on its branch
  and land it through review, or use a separate clean worktree.

### Workflow limitations you must cover manually

`release.yml` does not enforce all release policy. It does **not**:

- validate the tag strictly (the trigger is broad `v*`, not `vMAJOR.MINOR.PATCH`);
- prove the tagged commit is on `main`;
- compare the tag against the package-manifest versions;
- enforce lockstep versions across the four workspace packages.

Repository rulesets and branch/tag protections are hosted GitHub state and cannot
be established from the checked-in workflow alone. Complete the manual gates below
before pushing a tag; a green workflow alone is not proof that the release was cut
from the right commit or carries the right version.

## Versioning policy

Semantic Versioning, pre-1.0:

- **Breaking changes → bump MINOR** (`0.1.0 → 0.2.0`). Pre-1.0, minor absorbs
  breaking.
- **New features / additive CLI or API → bump MINOR** (or PATCH if tiny).
- **Bug fixes only → bump PATCH** (`0.1.0 → 0.1.1`).

Judge "breaking" from the **user's** view of the product: the `pinerun` CLI
surface first (commands, flags, output contracts like `--json` shapes and CSV
columns), then `pinetop`'s keymap and pages, then the programmatic API of
`@heyphat/pinerun` / `@heyphat/pinery` / `@heyphat/pinetop` / `@heyphat/pinelive`.
For pinelive also treat the durable v3 ledger schema and recovery contract as a
user-facing surface: a change that stops an existing ledger from replaying is
breaking even though no CLI flag moved.

Note that a `--json` shape is now a **contract between two shipped binaries**, not
just an output format: `pinetop` parses those payloads. Changing one is breaking
even if no user script reads it.

The four workspace packages are versioned **in lockstep** with the release tag:
`packages/pinerun/package.json`, `packages/pinery/package.json`,
`packages/pinetop/package.json` and `packages/pinelive/package.json` all carry
`X.Y.Z`, even when only one changed — `test/workspace.test.ts` enforces this,
along with every `bin` entry having a matching build product. The private workspace-root package stays at `0.0.0`; do not confuse
it with the pinned root dependency on `@heyphat/piner`.
Each shipped binary bakes in **its own** manifest version — `build-bin.ts` injects it
(plus the git commit) so `pinerun --version` and `pinetop --version` self-report.
Forget a bump and that binary reports the previous version.

The changelog is written **from the Conventional Commit history** (`feat:`,
`fix:`, `feat(...)!:` for breaking). Keep commits conventional so the log maps
cleanly to changelog sections.

## Step by step

### 0. Upstream first: does this release need a new piner?

`@heyphat/piner` is a peer installed from the npm registry (pinned in the root
`package.json` + `bun.lock`), and CI builds with `--frozen-lockfile`. If the
release depends on new engine behavior:

1. Cut the piner release first (see piner's own `RELEASING.md`).
2. Bump `@heyphat/piner` in the root `package.json`, run `bun install`, and land
   the `package.json` + `bun.lock` change on `main`.

A local binary built with `build:bin --local` (the sibling `../piner` checkout)
is a dev convenience only — **CI always builds against the registry version in
the lockfile**, so unpublished engine changes cannot ship.

### 1. Start from a green `main` and land the release's changes

```bash
git checkout main && git pull
```

CI (`ci.yml`) must be green. Feature/fix work merges to `main` as usual; the
release prep below can ride the last PR or a small dedicated one — either is
fine, as long as it lands on `main` before the tag.

### 2. Bump the versions

Edit `version` in **all four** package manifests to the release version:

```jsonc
// packages/pinerun/package.json  ← stamps `pinerun --version`
"version": "0.2.0",
// packages/pinetop/package.json  ← stamps `pinetop --version`
"version": "0.2.0",
// packages/pinery/package.json  ← kept in lockstep
"version": "0.2.0",
// packages/pinelive/package.json  ← stamps `pinelive --version`
"version": "0.2.0",
```

Do not bump the private root package version.

### 3. Update `CHANGELOG.md`

Keep a Changelog format. Add a new `## [X.Y.Z] - YYYY-MM-DD` section **above**
the previous one, with `### Added` / `### Changed` / `### Changed (breaking)` /
`### Fixed` subsections as needed. Write entries from the user's perspective;
omit pure dev tooling (formatting, CI, internal docs, test fixtures).

Then add a compare link at the bottom, above the previous version's link:

```
[0.2.0]: https://github.com/heyphat/pinestack/compare/v0.1.0...v0.2.0
```

(`0.1.0`, the first release, links to its tag instead — nothing to compare
against.)

### 4. Verify locally (must all pass)

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

cd packages/pinelive && bun run build:bin && cd -   # → dist/pinelive
./dist/pinelive --version                      # "pinelive X.Y.Z (<sha>)" — the NEW version
```

The `--version` checks are the guard against a forgotten bump: each binary
reports whatever its own manifest said at compile time, so check all three. Run a quick
smoke too (`./dist/pinerun scan examples/rsi.pine --symbols BTCUSDT --tf 1h
--limit 50 --rank "last(rsi)"`).

`pinetop --version` prints **two** lines — its own, then the `pinerun` it spawns.
Only the first is the release assertion (`./dist/pinetop --version | head -1`);
the second reports whatever is on your PATH, which during release prep is usually
the _previous_ version and is not a failure.

`--check-flags` belongs in this list because `pinetop` models pinerun's flags by
hand: if the release added or renamed a CLI flag, this is what catches the TUI
not knowing about it. It exits non-zero on drift.

If the bump touched dependencies, regenerate the lockfile and inspect it — every
workspace entry must describe the same versions as the manifests; do not assume
Bun refreshed stale metadata just because the install exited successfully. Then
prove it is self-consistent the way CI will:

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

### 6. Tag on `main` and push

The workflow checks out **the tagged commit**, so tag `main` after the release
prep is on it.

```bash
git checkout main && git pull      # ensure the release-prep commit is present
git tag vX.Y.Z                     # tag name must start with "v"
git push origin vX.Y.Z
```

This is the point of no return: the push triggers `release.yml`.

### 7. Watch the release

```bash
gh run watch                       # or: gh run list --workflow=release.yml
```

The job runs: checkout → setup Bun → `bun install --frozen-lockfile` →
`bun run typecheck` → `bun test` → build all targets for `pinerun`, then for
`pinetop` → **verify** each linux-x64 asset self-reports the tag and
`--check-flags` agrees → `sha256sum` over both → create the GitHub Release with
every binary attached. Then confirm:

```bash
gh release view vX.Y.Z             # 15 binaries + checksums.txt attached
```

Expected assets — 5 targets × 3 binaries, plus one shared manifest:

```
pinerun-linux-x64     pinetop-linux-x64     pinelive-linux-x64
pinerun-linux-arm64   pinetop-linux-arm64   pinelive-linux-arm64
pinerun-darwin-x64    pinetop-darwin-x64    pinelive-darwin-x64
pinerun-darwin-arm64  pinetop-darwin-arm64  pinelive-darwin-arm64
pinerun-windows-x64.exe   pinetop-windows-x64.exe   pinelive-windows-x64.exe
checksums.txt
```

`checksums.txt` must list **all fifteen**: `pinerun upgrade`, `pinetop upgrade`,
and `pinelive upgrade` each resolve their own asset from it, so an asset missing
there cannot self-update even though it downloaded fine.

### 8. Verify the installer path end-to-end

The installer follows `releases/latest`, which now points at the new release. It
installs `pinerun` and `pinetop` by default (`pinelive` only with an explicit
`PINESTACK_BINS` opt-in), so check both defaults:

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

(Or simply re-run the one-liner from the README on any machine.) Test the Windows
`.exe` by direct download on Windows.

The installer's checksum verification is best-effort in some download and lookup
failure cases rather than a universal hard failure, so a successful installer run
does not replace checking the asset against `checksums.txt` yourself. Read its
warnings instead of trusting exit status alone.

Finally, confirm the docs still do not imply that this installer provides
`pinelive` — it remains runnable from a source checkout only.

### 9. Polish the release notes (optional)

The workflow auto-generates notes from the commit/PR history. For a nicer entry,
replace them with the CHANGELOG section:

```bash
gh release edit vX.Y.Z --notes "<paste the CHANGELOG section>"
```

## What `release.yml` does (reference)

`.github/workflows/release.yml`, triggered on `push` of tags matching `v*`,
single Ubuntu runner (Bun cross-compiles every target — no build matrix):

| Step      | Command / action                                                       |
| --------- | ---------------------------------------------------------------------- |
| Checkout  | `actions/checkout@v4`                                                  |
| Bun       | `oven-sh/setup-bun@v2` (pinned `bun-version`)                          |
| Install   | `bun install --frozen-lockfile`                                        |
| Typecheck | `bun run typecheck`                                                    |
| Test      | `bun test`                                                             |
| Build     | `build-bin.ts all --product <p>` for pinerun, pinetop, pinelive        |
| Verify    | run each linux-x64 asset: `--version` matches the tag; `--check-flags` |
| Checksums | `sha256sum pinerun-* pinetop-* pinelive-* > checksums.txt`             |
| Release   | `softprops/action-gh-release@v2` — uploads assets, generates notes     |

> Three binaries ship, so a release carries **15 assets** (3 binaries × 5 targets)
> plus one `checksums.txt` covering all of them. That single manifest matters:
> every `<bin> upgrade` resolves its own asset from it, so an asset missing from
> `checksums.txt` cannot self-update.
>
> The workflow also **executes** the freshly built linux-x64 assets to assert each
> reports the tag being released, and runs `pinetop --check-flags` against the
> matching `pinerun`. A missed version bump is the one release mistake re-tagging
> cannot fix — the assets are already published — so it fails before the release
> step rather than after.

## Fixing a botched release

- **Workflow failed before the release step** (typecheck/test/build red): no
  release was created. Delete the tag, fix `main`, re-tag. `v*` tags are
  protected by the `protect-release-tags` ruleset (no delete/move), so disable
  it for the moment of deletion and re-enable right after:

  ```bash
  RS=$(gh api repos/heyphat/pinestack/rulesets --jq '.[] | select(.name=="protect-release-tags") | .id')
  gh api -X PUT repos/heyphat/pinestack/rulesets/$RS -F enforcement=disabled >/dev/null
  git push --delete origin vX.Y.Z
  git tag -d vX.Y.Z
  gh api -X PUT repos/heyphat/pinestack/rulesets/$RS -F enforcement=active >/dev/null
  # fix, land on main, then re-tag
  ```

- **Release published but the binaries are bad:** unlike npm, GitHub Release
  assets _can_ be replaced — but a version that users may already have installed
  should not silently change meaning. Prefer to **patch forward** (`X.Y.Z+1`).
  If the release is minutes old and clearly unused, deleting release + tag and
  re-cutting the same version is acceptable:

  ```bash
  gh release delete vX.Y.Z --yes
  git push --delete origin vX.Y.Z && git tag -d vX.Y.Z
  ```

- **`latest` points at the wrong release:** `releases/latest` (what the
  installer follows) is the newest non-draft, non-prerelease release. Marking a
  bad release as a **pre-release** (`gh release edit vX.Y.Z --prerelease`)
  immediately steers the installer back to the previous good version while you
  patch forward.

- **Tag pushed from the wrong commit:** delete the remote tag before the
  workflow finishes if you can; otherwise treat it as a bad release and patch
  forward.

## Quick checklist

```
[ ] piner dependency current (publish + bump @heyphat/piner first if needed)
[ ] main is green (CI passing)
[ ] release changes merged to main
[ ] version bumped in ALL FOUR pinerun + pinetop + pinery + pinelive package.json
[ ] bun.lock regenerated, inspected, and accepted by --frozen-lockfile
[ ] CHANGELOG.md section + compare link added
[ ] bun run typecheck / bun test pass
[ ] bun run build:bin && ./dist/pinerun --version reports the NEW version
[ ] (pinetop) cd packages/pinetop && bun run build:bin; ./dist/pinetop --version
[ ] (pinetop) ./dist/pinetop --check-flags agrees with this release's CLI flags
[ ] (pinelive) cd packages/pinelive && bun run build:bin; ./dist/pinelive --version
[ ] chore(release): X.Y.Z committed on main
[ ] git tag vX.Y.Z on main, pushed
[ ] release.yml green; gh release view shows 15 binaries + checksums.txt
[ ] curl installer → pinerun --version AND pinetop --version report X.Y.Z
[ ] pinetop upgrade --check on the previous release offers the new one
[ ] docs still state that pinelive is opt-in (not a default install), Tiger is
    not production-approved, and no npm publish occurs
[ ] (optional) release notes replaced with the CHANGELOG section
```
