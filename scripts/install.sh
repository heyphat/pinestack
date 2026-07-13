#!/bin/sh
# pinerun installer — downloads the prebuilt, self-contained binary for your
# platform from GitHub Releases and drops it on your PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/heyphat/pinestack/main/scripts/install.sh | sh
#
# Environment overrides:
#   PINERUN_VERSION       tag to install (e.g. v0.1.0). Default: latest release.
#   PINERUN_INSTALL_DIR   directory to install into. Default: ~/.local/bin.
#
# The binary bakes in the Bun runtime plus the piner engine and pinery data
# layer, so there is nothing else to install — no Node, no Bun, no npm.

set -eu

REPO="heyphat/pinestack"
BIN="pinerun"

info() { printf '%s\n' "$*"; }
err() { printf 'install: %s\n' "$*" >&2; exit 1; }

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

asset="${BIN}-${os}-${arch}"

# --- resolve download URL --------------------------------------------------
if [ -n "${PINERUN_VERSION:-}" ]; then
  base="https://github.com/${REPO}/releases/download/${PINERUN_VERSION}"
  ver="$PINERUN_VERSION"
else
  base="https://github.com/${REPO}/releases/latest/download"
  ver="latest"
fi

url="${base}/${asset}"

command -v curl >/dev/null 2>&1 || err "curl is required."

# --- download into a temp dir ----------------------------------------------
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t pinerun)
trap 'rm -rf "$tmp"' EXIT INT TERM

info "Downloading ${BIN} (${os}-${arch}, ${ver})…"
if ! curl -fSL --progress-bar "$url" -o "$tmp/$BIN"; then
  err "download failed: $url
     The release may not publish a '${asset}' asset for this platform yet."
fi

# --- verify checksum if the release ships one ------------------------------
if curl -fsSL "${base}/checksums.txt" -o "$tmp/checksums.txt" 2>/dev/null; then
  expected=$(grep " ${asset}\$" "$tmp/checksums.txt" 2>/dev/null | awk '{print $1}' || true)
  if [ -n "$expected" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$tmp/$BIN" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      actual=$(shasum -a 256 "$tmp/$BIN" | awk '{print $1}')
    else
      actual=""
    fi
    if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
      err "checksum mismatch for ${asset}
     expected $expected
     got      $actual"
    fi
    [ -n "$actual" ] && info "Checksum verified."
  fi
fi

# --- install onto PATH -----------------------------------------------------
dir="${PINERUN_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$dir"
chmod +x "$tmp/$BIN"
mv "$tmp/$BIN" "$dir/$BIN"

info ""
info "✓ Installed ${BIN} → ${dir}/${BIN}"

case ":${PATH}:" in
  *":${dir}:"*)
    info "  Run it: ${BIN} --help"
    ;;
  *)
    info "  ⚠ ${dir} is not on your PATH. Add it, e.g.:"
    info "      export PATH=\"${dir}:\$PATH\""
    ;;
esac
