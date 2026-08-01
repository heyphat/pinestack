#!/bin/sh
# pinestack installer — downloads the prebuilt, self-contained binaries for your
# platform from GitHub Releases and drops them on your PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/heyphat/pinestack/main/scripts/install.sh | sh
#
# Installs two binaries by default:
#   pinerun   the CLI — scan, backtest, sweep, walkforward, portfolio, compare
#   pinetop   a terminal UI over that CLI (it spawns pinerun, so it needs it)
#   pinelive  the forward runner (NOT installed by default — opt in via
#             PINESTACK_BINS. Paper broker by default; its Tiger adapters are
#             offline-tested only and not sandbox- or production-approved.)
#
# Environment overrides:
#   PINESTACK_BINS         which to install. Default "pinerun pinetop".
#                          e.g. PINESTACK_BINS=pinerun for the CLI alone, or
#                          PINESTACK_BINS="pinerun pinetop pinelive" for all.
#   PINESTACK_VERSION      tag to install (e.g. v0.1.0). Default: latest release.
#                          (PINERUN_VERSION is still honoured.)
#   PINESTACK_INSTALL_DIR  directory to install into. Default: ~/.local/bin.
#                          (PINERUN_INSTALL_DIR is still honoured.)
#
# Each binary bakes in the Bun runtime plus the piner engine and pinery data
# layer, so there is nothing else to install — no Node, no Bun, no npm. That also
# makes them large (~60-100 MB each); set PINESTACK_BINS to skip one.

set -eu

REPO="heyphat/pinestack"
BINS="${PINESTACK_BINS:-pinerun pinetop}"

info() { printf '%s\n' "$*"; }
err() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

# Validate the whole list before downloading anything, so a typo in
# PINESTACK_BINS fails clean instead of half-installing.
for bin in $BINS; do
  case "$bin" in
  pinerun | pinetop | pinelive) ;;
  *) err "unknown binary '$bin' in PINESTACK_BINS. Known: pinerun pinetop pinelive." ;;
  esac
done
[ -n "$BINS" ] || err "PINESTACK_BINS is empty — nothing to install."

# --- detect platform -------------------------------------------------------
os=$(uname -s)
arch=$(uname -m)

case "$os" in
Linux) os="linux" ;;
Darwin) os="darwin" ;;
*) err "unsupported OS '$os'. Prebuilt binaries: linux, darwin (Windows: download the .exe from the Releases page)." ;;
esac

case "$arch" in
x86_64 | amd64) arch="x64" ;;
arm64 | aarch64) arch="arm64" ;;
*) err "unsupported architecture '$arch'. Supported: x64, arm64." ;;
esac

# --- resolve download URL --------------------------------------------------
# PINERUN_* stay supported: they predate pinetop and appear in older docs.
version="${PINESTACK_VERSION:-${PINERUN_VERSION:-}}"
if [ -n "$version" ]; then
  base="https://github.com/${REPO}/releases/download/${version}"
  ver="$version"
else
  base="https://github.com/${REPO}/releases/latest/download"
  ver="latest"
fi

command -v curl >/dev/null 2>&1 || err "curl is required."

dir="${PINESTACK_INSTALL_DIR:-${PINERUN_INSTALL_DIR:-$HOME/.local/bin}}"

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t pinestack)
trap 'rm -rf "$tmp"' EXIT INT TERM

# --- checksums, fetched once for every asset -------------------------------
# One manifest covers every binary in the release, so fetch it a single time.
sums=""
if curl -fsSL "${base}/checksums.txt" -o "$tmp/checksums.txt" 2>/dev/null; then
  sums="$tmp/checksums.txt"
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    printf ''
  fi
}

installed=""
for bin in $BINS; do
  asset="${bin}-${os}-${arch}"
  url="${base}/${asset}"

  info "Downloading ${bin} (${os}-${arch}, ${ver})…"
  if ! curl -fSL --progress-bar "$url" -o "$tmp/$bin"; then
    err "download failed: $url
     The release may not publish a '${asset}' asset for this platform yet."
  fi

  # --- verify checksum if the release ships one ----------------------------
  if [ -n "$sums" ]; then
    expected=$(grep " ${asset}\$" "$sums" 2>/dev/null | awk '{print $1}' || true)
    if [ -n "$expected" ]; then
      actual=$(sha256_of "$tmp/$bin")
      if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
        err "checksum mismatch for ${asset}
     expected $expected
     got      $actual"
      fi
      [ -n "$actual" ] && info "Checksum verified."
    fi
  fi

  # --- install onto PATH ---------------------------------------------------
  mkdir -p "$dir"
  chmod +x "$tmp/$bin"
  mv "$tmp/$bin" "$dir/$bin"
  info "✓ Installed ${bin} → ${dir}/${bin}"
  info ""
  installed="${installed}${bin} "
done

case ":${PATH}:" in
*":${dir}:"*)
  for bin in $installed; do
    info "  Run it: ${bin} --help"
  done
  ;;
*)
  info "  ⚠ ${dir} is not on your PATH. Add it, e.g.:"
  info "      export PATH=\"${dir}:\$PATH\""
  ;;
esac
