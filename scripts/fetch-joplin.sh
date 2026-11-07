#!/usr/bin/env bash
# Download a Joplin desktop AppImage for the end-to-end tests, verify its
# checksum, and extract it (so FUSE is not needed).
#
# Result: .cache/joplin/<version>/joplin is the Joplin executable, and
# .cache/joplin/current points at the most recently fetched version. The e2e
# harness uses .cache/joplin/current/joplin unless JOPLIN_BIN is set.
#
# Usage: scripts/fetch-joplin.sh [version]   (default: $JOPLIN_VERSION or 3.7.22)
set -euo pipefail

VERSION="${1:-${JOPLIN_VERSION:-3.7.22}}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$REPO_ROOT/.cache/joplin"
DEST="$CACHE_DIR/$VERSION"
APPIMAGE="Joplin-$VERSION.AppImage"
BASE_URL="https://github.com/laurent22/joplin/releases/download/v$VERSION"

mkdir -p "$CACHE_DIR"

if [[ -x "$DEST/joplin" ]]; then
  echo "Joplin $VERSION already extracted at $DEST" >&2
else
  rm -rf "$DEST"
  mkdir -p "$DEST"
  cd "$DEST"

  echo "Downloading $APPIMAGE..." >&2
  curl -fsSL --retry 3 -o "$APPIMAGE" "$BASE_URL/$APPIMAGE"
  curl -fsSL --retry 3 -o "$APPIMAGE.sha512" "$BASE_URL/$APPIMAGE.sha512"

  # The release's .sha512 file holds the bare hex digest.
  expected="$(tr -d '[:space:]' < "$APPIMAGE.sha512")"
  actual="$(sha512sum "$APPIMAGE" | cut -d' ' -f1)"
  if [[ "$expected" != "$actual" ]]; then
    echo "Checksum mismatch for $APPIMAGE" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi

  chmod +x "$APPIMAGE"
  "./$APPIMAGE" --appimage-extract > /dev/null
  rm "$APPIMAGE" "$APPIMAGE.sha512"

  # electron-builder names the executable after the package; find it rather
  # than hard-coding the name.
  bin="$(find squashfs-root -maxdepth 1 -type f -executable -iname '*joplin*' | head -n1)"
  if [[ -z "$bin" ]]; then
    echo "Could not find the Joplin executable in the extracted AppImage" >&2
    ls squashfs-root >&2
    exit 1
  fi
  ln -s "$bin" joplin
  echo "Extracted Joplin $VERSION to $DEST" >&2
fi

ln -sfn "$VERSION" "$CACHE_DIR/current"
echo "$DEST/joplin"
