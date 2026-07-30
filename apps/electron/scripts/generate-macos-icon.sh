#!/bin/bash
# Generate the native Mkrate .icns from the approved canonical PNG.
# This intentionally requires Apple tooling and must be run on macOS only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$ELECTRON_DIR")")"
SOURCE="$ROOT_DIR/docs/brand/assets/mkrate-icon-1024.png"
TARGET="$ELECTRON_DIR/resources/icon.icns"
EXPECTED_SHA256="941584a70cef656815c36e6ab48885579f8c428f6847e81edfbf5e7b970b41b6"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: native Mkrate .icns generation requires macOS sips and iconutil." >&2
  exit 1
fi
for command in sips iconutil shasum; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "ERROR: required macOS tool '$command' is unavailable." >&2
    exit 1
  }
done
if [ ! -f "$SOURCE" ]; then
  echo "ERROR: canonical Mkrate icon is missing: $SOURCE" >&2
  exit 1
fi
actual_sha256="$(shasum -a 256 "$SOURCE" | awk '{print $1}')"
if [ "$actual_sha256" != "$EXPECTED_SHA256" ]; then
  echo "ERROR: canonical Mkrate icon hash mismatch." >&2
  echo "  expected: $EXPECTED_SHA256" >&2
  echo "  actual:   $actual_sha256" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
iconset="$work_dir/Mkrate.iconset"
mkdir -p "$iconset"

# iconutil's standard macOS iconset inputs. Each derivative comes directly from
# the approved raster; no SVG tracing, recoloring, or legacy Craft artwork is used.
while IFS=: read -r filename pixels; do
  output="$iconset/$filename"
  sips -z "$pixels" "$pixels" "$SOURCE" --out "$output" >/dev/null
  width="$(sips -g pixelWidth "$output" | awk '/pixelWidth:/ {print $2}')"
  height="$(sips -g pixelHeight "$output" | awk '/pixelHeight:/ {print $2}')"
  if [ "$width" != "$pixels" ] || [ "$height" != "$pixels" ]; then
    echo "ERROR: failed to create $filename at ${pixels}x${pixels}." >&2
    exit 1
  fi
done <<'ICONSET'
icon_16x16.png:16
icon_16x16@2x.png:32
icon_32x32.png:32
icon_32x32@2x.png:64
icon_128x128.png:128
icon_128x128@2x.png:256
icon_256x256.png:256
icon_256x256@2x.png:512
icon_512x512.png:512
icon_512x512@2x.png:1024
ICONSET

mkdir -p "$(dirname "$TARGET")"
rm -f "$TARGET"
iconutil -c icns "$iconset" -o "$TARGET"
if [ ! -s "$TARGET" ]; then
  echo "ERROR: iconutil did not produce $TARGET." >&2
  exit 1
fi

# Re-expand the generated container as a structural validation, then verify all
# required representations are present and have their expected native dimensions.
verification_iconset="$work_dir/verified.iconset"
iconutil -c iconset "$TARGET" -o "$verification_iconset"
while IFS=: read -r filename pixels; do
  output="$verification_iconset/$filename"
  if [ ! -s "$output" ]; then
    echo "ERROR: generated .icns is missing $filename." >&2
    exit 1
  fi
  width="$(sips -g pixelWidth "$output" | awk '/pixelWidth:/ {print $2}')"
  height="$(sips -g pixelHeight "$output" | awk '/pixelHeight:/ {print $2}')"
  if [ "$width" != "$pixels" ] || [ "$height" != "$pixels" ]; then
    echo "ERROR: generated .icns has invalid dimensions for $filename." >&2
    exit 1
  fi
done <<'ICONSET'
icon_16x16.png:16
icon_16x16@2x.png:32
icon_32x32.png:32
icon_32x32@2x.png:64
icon_128x128.png:128
icon_128x128@2x.png:256
icon_256x256.png:256
icon_256x256@2x.png:512
icon_512x512.png:512
icon_512x512@2x.png:1024
ICONSET

echo "Generated and verified native Mkrate .icns: $TARGET"
