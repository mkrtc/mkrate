#!/bin/bash
# Generate platform-neutral, Linux, and Windows app icons on Linux from the
# approved Mkrate brand PNGs (rendered from docs/brand/assets/mkrate-icon-square.svg
# with librsvg + cairo). Uses ImageMagick only — no macOS-only tooling.
#
# Usage: ./generate-icons-linux.sh
#
# NOTE: macOS icon containers (.icns, Assets.car / Liquid Glass) are DEFERRED and
# intentionally NOT produced here — they require Apple's iconutil/actool on macOS.
# macOS production packaging is blocked until those are generated and validated on
# a Mac. See ../../../docs/branding/icon-inventory.md.

set -euo pipefail

BRAND="$(cd "$(dirname "$0")/../../../docs/brand/assets" && pwd)"
OUT="$(cd "$(dirname "$0")" && pwd)"
SRC_PNG="$BRAND/mkrate-icon-1024.png"

command -v magick >/dev/null 2>&1 || { echo "ImageMagick (magick) is required"; exit 1; }
[ -f "$SRC_PNG" ] || { echo "Missing brand source: $SRC_PNG"; exit 1; }

echo "Source: $SRC_PNG"

# Linux app icon: 512x512 PNG (electron-builder linux.icon).
cp "$BRAND/mkrate-icon-512.png" "$OUT/icon.png"

# Platform-neutral app-icon source SVG (electron-builder / tooling reference).
cp "$BRAND/mkrate-icon-square.svg" "$OUT/icon.svg"

# High-res source raster kept for downstream tooling.
cp "$BRAND/mkrate-icon-1024.png" "$OUT/source.png"

# Windows multi-resolution .ico from clean downscales (Lanczos, alpha preserved).
TMP="$(mktemp -d)"
for s in 16 24 32 48 64 128 256; do
  magick "$SRC_PNG" -filter Lanczos -resize ${s}x${s} -depth 8 "$TMP/icon_${s}.png"
done
magick "$TMP/icon_16.png" "$TMP/icon_24.png" "$TMP/icon_32.png" "$TMP/icon_48.png" \
       "$TMP/icon_64.png" "$TMP/icon_128.png" "$TMP/icon_256.png" "$OUT/icon.ico"
rm -rf "$TMP"

echo "Generated:"
magick identify "$OUT/icon.png" "$OUT/icon.ico" | sed 's/^/  /'
echo "Done. macOS .icns/Assets.car remain deferred (generate on macOS)."
