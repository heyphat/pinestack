# Releasing pinestack

The A-to-Z runbook for cutting a new pinestack release — prebuilt `pinerun`
binaries attached to a GitHub Release. There is **no npm publish**: the packages
run from TypeScript source in this workspace, and the binary is the product.

## Release model

Releases are **tag-driven**. Pushing a `v*` tag to GitHub is the single trigger:
it runs `.github/workflows/release.yml`, which typechecks, tests, cross-compiles
the `pinerun` binary for every target, and **creates the GitHub Release itself**
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
verify: gh release view · curl installer · pinerun --version
```

The `curl | sh` installer (`scripts/install.sh`) serves users from
`releases/latest/download/…`, so the moment the workflow finishes, new installs
get the new version.

## Prerequisites (one-time)

- **Bun ≥ 1.2** locally (install, test, and `build:bin` all run on Bun).
- **Push rights to `heyphat/pinestack`** — the tag push is the release. The
  workflow needs no secrets: it authenticates with the built-in `GITHUB_TOKEN`
  (`permissions: contents: write` is already declared in `release.yml`).
- **`gh` CLI** authenticated (`gh auth status`) — only for watching the run and
  polishing release notes; not required for the release itself.

## Versioning policy

Semantic Versioning, pre-1.0:

- **Breaking changes → bump MINOR** (`0.1.0 → 0.2.0`). Pre-1.0, minor absorbs
  breaking.
- **New features / additive CLI or API → bump MINOR** (or PATCH if tiny).
- **Bug fixes only → bump PATCH** (`0.1.0 → 0.1.1`).

Judge "breaking" from the **user's** view of the product: the `pinerun` CLI
surface first (commands, flags, output contracts like `--json` shapes and CSV
columns), then the programmatic API of `@heyphat/pinerun` / `@heyphat/pinery`.

The two workspace packages are versioned **in lockstep** with the release tag:
`packages/pinerun/package.json` and `packages/pinery/package.json` both carry
`X.Y.Z`, even when only one changed. `packages/pinerun/package.json` is the
single source of truth that gets **baked into the binary** — `build-bin.ts`
injects it (plus the git commit) so `pinerun --version` self-reports. Forget the
bump and the shipped binaries report the previous version.

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

Edit `version` in **both** package manifests to the release version:

```jsonc
// packages/pinerun/package.json  ← stamps `pinerun --version`
"version": "0.2.0",
// packages/pinery/package.json  ← kept in lockstep
"version": "0.2.0",
```

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
bun run typecheck            # tsc -b across both packages
bun test                     # full suite
bun run build:bin            # host binary → dist/pinerun
./dist/pinerun --version     # must print "pinerun X.Y.Z (<sha>)" — the NEW version
```

The `--version` check is the guard against a forgotten bump: the binary reports
whatever `packages/pinerun/package.json` said at compile time. Run a quick smoke
too (`./dist/pinerun scan examples/rsi.pine --symbols BTCUSDT --tf 1h --limit 50
--rank "last(rsi)"`).

CI does not gate on formatting, but keep the files you touched clean:
`bunx prettier --check <files>`.

### 5. Commit the release prep and merge to `main`

`main` is protected by a ruleset: changes land via **pull request with green CI**
(no direct pushes, no force pushes).

```bash
git checkout -b chore/release-X.Y.Z
git add packages/pinerun/package.json packages/pinery/package.json CHANGELOG.md
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
`bun run typecheck` → `bun test` → `bun run build:bin all` → `sha256sum` →
create the GitHub Release with every binary attached. Then confirm:

```bash
gh release view vX.Y.Z             # 5 binaries + checksums.txt attached
```

Expected assets: `pinerun-linux-x64`, `pinerun-linux-arm64`,
`pinerun-darwin-x64`, `pinerun-darwin-arm64`, `pinerun-windows-x64.exe`,
`checksums.txt`.

### 8. Verify the installer path end-to-end

The installer follows `releases/latest`, which now points at the new release:

```bash
export PINERUN_INSTALL_DIR=$(mktemp -d)
curl -fsSL https://raw.githubusercontent.com/heyphat/pinestack/main/scripts/install.sh | sh
"$PINERUN_INSTALL_DIR/pinerun" --version       # → pinerun X.Y.Z (<sha>)
```

(Or simply re-run the one-liner from the README on any machine.)

### 9. Polish the release notes (optional)

The workflow auto-generates notes from the commit/PR history. For a nicer entry,
replace them with the CHANGELOG section:

```bash
gh release edit vX.Y.Z --notes "<paste the CHANGELOG section>"
```

## What `release.yml` does (reference)

`.github/workflows/release.yml`, triggered on `push` of tags matching `v*`,
single Ubuntu runner (Bun cross-compiles every target — no build matrix):

| Step      | Command / action                                                   |
| --------- | ------------------------------------------------------------------ |
| Checkout  | `actions/checkout@v4`                                              |
| Bun       | `oven-sh/setup-bun@v2` (latest)                                    |
| Install   | `bun install --frozen-lockfile`                                    |
| Typecheck | `bun run typecheck`                                                |
| Test      | `bun test`                                                         |
| Build     | `bun run build:bin all` (5 targets, version + sha baked in)        |
| Checksums | `sha256sum pinerun-* > checksums.txt`                              |
| Release   | `softprops/action-gh-release@v2` — uploads assets, generates notes |

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
[ ] version bumped in BOTH packages/pinerun + packages/pinery package.json
[ ] CHANGELOG.md section + compare link added
[ ] bun run typecheck / bun test pass
[ ] bun run build:bin && ./dist/pinerun --version reports the NEW version
[ ] chore(release): X.Y.Z committed on main
[ ] git tag vX.Y.Z on main, pushed
[ ] release.yml green; gh release view shows 5 binaries + checksums.txt
[ ] curl installer → pinerun --version reports X.Y.Z
[ ] (optional) release notes replaced with the CHANGELOG section
```
