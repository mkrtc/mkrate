#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$ELECTRON_DIR")")"

# Helper function to check required file/directory exists
require_path() {
    local path="$1"
    local description="$2"
    local hint="$3"

    if [ ! -e "$path" ]; then
        echo "ERROR: $description not found at $path"
        [ -n "$hint" ] && echo "$hint"
        exit 1
    fi
}

# Sync secrets from 1Password if CLI is available
if command -v op &> /dev/null; then
    echo "1Password CLI detected, syncing secrets..."
    cd "$ROOT_DIR"
    if bun run sync-secrets 2>/dev/null; then
        echo "Secrets synced from 1Password"
    else
        echo "Warning: Failed to sync secrets from 1Password (continuing with existing .env if present)"
    fi
fi

# Load environment variables from .env
if [ -f "$ROOT_DIR/.env" ]; then
    set -a
    source "$ROOT_DIR/.env"
    set +a
fi

# Parse arguments
ARCH="arm64"
UPLOAD=false
UPLOAD_LATEST=false
UPLOAD_SCRIPT=false

show_help() {
    cat << EOF
Usage: build-dmg.sh [arm64|x64] [--upload] [--latest] [--script]

Arguments:
  arm64|x64    Target architecture (default: arm64)
  --upload     Upload DMG to S3 after building
  --latest     Also update electron/latest (requires --upload)
  --script     Also upload install-app.sh (requires --upload)

Environment variables (from .env or environment):
  APPLE_SIGNING_IDENTITY    - Code signing identity
  APPLE_ID                  - Apple ID for notarization
  APPLE_TEAM_ID             - Apple Team ID
  APPLE_APP_SPECIFIC_PASSWORD - App-specific password
  S3_VERSIONS_BUCKET_*      - S3 credentials (for --upload)
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case $1 in
        arm64|x64)     ARCH="$1"; shift ;;
        --upload)      UPLOAD=true; shift ;;
        --latest)      UPLOAD_LATEST=true; shift ;;
        --script)      UPLOAD_SCRIPT=true; shift ;;
        -h|--help)     show_help ;;
        *)
            echo "Unknown option: $1"
            echo "Run with --help for usage"
            exit 1
            ;;
    esac
done

# Configuration
BUN_VERSION="bun-v1.3.10"  # Pinned version for reproducible builds

echo "=== Building Mkrate DMG (${ARCH}) using electron-builder ==="
if [ "$UPLOAD" = true ]; then
    echo "Will upload to S3 after build"
fi

# 1. Clean previous build artifacts
echo "Cleaning previous builds..."
rm -rf "$ELECTRON_DIR/vendor"
rm -rf "$ELECTRON_DIR/node_modules/@anthropic-ai"
rm -rf "$ELECTRON_DIR/packages"
rm -rf "$ELECTRON_DIR/release"

# 2. Install dependencies
echo "Installing dependencies from the committed lockfile..."
cd "$ROOT_DIR"
bun install --frozen-lockfile

# 3. Download Bun binary with checksum verification
echo "Downloading Bun ${BUN_VERSION} for darwin-${ARCH}..."
mkdir -p "$ELECTRON_DIR/vendor/bun"
BUN_DOWNLOAD="bun-darwin-$([ "$ARCH" = "arm64" ] && echo "aarch64" || echo "x64")"

# Create temp directory to avoid race conditions
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Download binary and checksums
curl -fSL "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/${BUN_DOWNLOAD}.zip" -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip"
curl -fSL "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"

# Verify checksum
echo "Verifying checksum..."
cd "$TEMP_DIR"
grep "${BUN_DOWNLOAD}.zip" SHASUMS256.txt | shasum -a 256 -c -
cd - > /dev/null

# Extract and install
unzip -o "$TEMP_DIR/${BUN_DOWNLOAD}.zip" -d "$TEMP_DIR"
cp "$TEMP_DIR/${BUN_DOWNLOAD}/bun" "$ELECTRON_DIR/vendor/bun/"
chmod +x "$ELECTRON_DIR/vendor/bun/bun"

# 4. Copy SDK from root node_modules (monorepo hoisting)
# Note: The SDK is hoisted to root node_modules by the package manager.
# We copy it here because electron-builder only sees apps/electron/.
#
# Since SDK 0.2.113 the SDK split into a thin core + per-platform binary
# package. We bundle:
#   1. The core (`claude-agent-sdk`) — universal sdk.mjs + types.
#   2. The matching arch's binary package, copied to a stable alias path
#      `claude-agent-sdk-binary/` so the electron-builder.yml entry stays
#      arch-agnostic and the runtime resolver finds it regardless of host
#      arch at build time.
SDK_SOURCE="$ROOT_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
require_path "$SDK_SOURCE" "SDK core" "Run 'bun install' from the repository root first."
echo "Copying SDK core..."
mkdir -p "$ELECTRON_DIR/node_modules/@anthropic-ai"
rm -rf "$ELECTRON_DIR/node_modules/@anthropic-ai/claude-agent-sdk"
cp -r "$SDK_SOURCE" "$ELECTRON_DIR/node_modules/@anthropic-ai/"

# 4a. Resolve the target arch's binary package. If the host arch matches the
#     target, bun install already placed it in node_modules/@anthropic-ai/.
#     Otherwise, fetch and unpack the matching tarball directly via npm.
SDK_BIN_PKG="claude-agent-sdk-darwin-${ARCH}"
SDK_BIN_SOURCE="$ROOT_DIR/node_modules/@anthropic-ai/${SDK_BIN_PKG}"
if [ ! -d "$SDK_BIN_SOURCE" ]; then
    echo "Cross-arch build: ${SDK_BIN_PKG} not in node_modules — fetching from npm..."
    SDK_VERSION=$(node -p "require('$ROOT_DIR/package.json').dependencies['@anthropic-ai/claude-agent-sdk']" | tr -d '"')
    PKG_TMP=$(mktemp -d)
    trap "rm -rf $PKG_TMP" RETURN
    (
        cd "$PKG_TMP"
        SDK_PACKAGE="@anthropic-ai/${SDK_BIN_PKG}"
        PACK_RESULT="$(npm pack --json "${SDK_PACKAGE}@${SDK_VERSION}")"
        TARBALL="$(node -e 'const p = JSON.parse(process.argv[1])[0]; if (!p?.filename || !p?.version) process.exit(1); process.stdout.write(p.filename)' "$PACK_RESULT")"
        PACKED_VERSION="$(node -e 'const p = JSON.parse(process.argv[1])[0]; if (!p?.version) process.exit(1); process.stdout.write(p.version)' "$PACK_RESULT")"
        [ -f "$TARBALL" ] || { echo "ERROR: npm pack did not produce its declared tarball." >&2; exit 1; }
        INTEGRITY="$(npm view "${SDK_PACKAGE}@${PACKED_VERSION}" dist.integrity)"
        node - "$TARBALL" "$INTEGRITY" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const [tarball, integrity] = process.argv.slice(2);
const match = /^([a-z0-9-]+)-([A-Za-z0-9+/=]+)$/i.exec(integrity.trim());
if (!match) throw new Error('npm registry did not return a valid dist.integrity value');
const actual = crypto.createHash(match[1]).update(fs.readFileSync(tarball)).digest('base64');
if (actual !== match[2]) throw new Error(`npm tarball integrity mismatch for ${tarball}`);
NODE
        tar -xzf "$TARBALL"
    )
    mkdir -p "$SDK_BIN_SOURCE"
    cp -r "$PKG_TMP/package/." "$SDK_BIN_SOURCE/"
fi

require_path "$SDK_BIN_SOURCE" "SDK native binary package (${SDK_BIN_PKG})" \
  "Run 'bun install' from the repository root, or check your network for the npm cross-fetch."

echo "Staging SDK native binary as claude-agent-sdk-binary alias..."
ALIAS_DEST="$ELECTRON_DIR/node_modules/@anthropic-ai/claude-agent-sdk-binary"
rm -rf "$ALIAS_DEST"
mkdir -p "$ALIAS_DEST"
cp -r "$SDK_BIN_SOURCE/." "$ALIAS_DEST/"
chmod +x "$ALIAS_DEST/claude"

# Sanity check: native binary should be ~210 MB. Anything dramatically smaller
# indicates a botched copy / wrong tarball.
BIN_SIZE=$(stat -f%z "$ALIAS_DEST/claude" 2>/dev/null || stat -c%s "$ALIAS_DEST/claude")
if [ "$BIN_SIZE" -lt 50000000 ]; then
    echo "ERROR: claude binary at $ALIAS_DEST/claude is only ${BIN_SIZE} bytes (expected ~210 MB)"
    exit 1
fi
echo "  Native binary: $((BIN_SIZE / 1024 / 1024)) MB"

# 5. Copy ripgrep (was previously bundled inside the SDK at vendor/ripgrep/;
#    moved out in 0.2.113. Search service still needs the binary directly.)
RG_SOURCE="$ROOT_DIR/node_modules/@vscode/ripgrep"
require_path "$RG_SOURCE" "@vscode/ripgrep" "Run 'bun install' and 'bun pm trust @vscode/ripgrep' first."
require_path "$RG_SOURCE/bin/rg" "ripgrep binary" "@vscode/ripgrep postinstall did not run."
echo "Copying @vscode/ripgrep..."
mkdir -p "$ELECTRON_DIR/node_modules/@vscode"
rm -rf "$ELECTRON_DIR/node_modules/@vscode/ripgrep"
cp -r "$RG_SOURCE" "$ELECTRON_DIR/node_modules/@vscode/"

# 6. Copy network interceptor sources.
#    NOTE (Phase 1 of SDK uplift): the Claude native binary doesn't accept
#    Bun's --preload, so the Claude code path no longer uses these. They're
#    still needed for the **Pi** subprocess (runs on Bun, accepts --preload).
#    Phase 2 will reintroduce equivalent functionality for Claude via SDK
#    hooks or a local proxy.
INTERCEPTOR_SOURCE="$ROOT_DIR/packages/shared/src/unified-network-interceptor.ts"
require_path "$INTERCEPTOR_SOURCE" "Interceptor" "Ensure packages/shared/src/unified-network-interceptor.ts exists."
echo "Copying interceptor (for Pi subprocess)..."
mkdir -p "$ELECTRON_DIR/packages/shared/src"
cp "$INTERCEPTOR_SOURCE" "$ELECTRON_DIR/packages/shared/src/"
for dep in interceptor-common.ts feature-flags.ts interceptor-request-utils.ts; do
  if [ -f "$ROOT_DIR/packages/shared/src/$dep" ]; then
    cp "$ROOT_DIR/packages/shared/src/$dep" "$ELECTRON_DIR/packages/shared/src/"
  fi
done

# 5b. Generate the native icon with Apple tooling. The generator validates the
# exact approved source hash and fails closed before any app bundle is produced.
echo "Generating native Mkrate macOS icon..."
bash "$SCRIPT_DIR/generate-macos-icon.sh"

# 6. Build Electron app
echo "Building Electron app..."
cd "$ROOT_DIR"
bun run electron:build

# 7. Package with electron-builder
echo "Packaging app with electron-builder..."
cd "$ELECTRON_DIR"

# v0.0.1 deliberately ships unsigned and unnotarized. Do not discover or use
# ambient signing credentials: the post-build checks below fail if that policy drifts.
export CSC_IDENTITY_AUTO_DISCOVERY=false
unset CSC_NAME CSC_LINK APPLE_SIGNING_IDENTITY APPLE_ID APPLE_TEAM_ID APPLE_APP_SPECIFIC_PASSWORD NOTARIZE

# Build electron-builder arguments
BUILDER_ARGS="--mac --${ARCH}"

# Run electron-builder
npx electron-builder $BUILDER_ARGS --publish never

# electron-builder can still emit a multi-arch latest-mac.yml when target
# arches are also listed in electron-builder.yml. This script stages only one
# arch-specific SDK binary, so keep the updater manifest scoped to the arch we
# actually packaged for this run.
LATEST_MAC_YML="$ELECTRON_DIR/release/latest-mac.yml"
if [ -f "$LATEST_MAC_YML" ]; then
    TARGET_ARCH="$ARCH" node <<'NODE'
const fs = require('fs');
const yaml = require('js-yaml');

const file = 'release/latest-mac.yml';
const arch = process.env.TARGET_ARCH;
const doc = yaml.load(fs.readFileSync(file, 'utf8'));
const marker = `-${arch}.`;

doc.files = (doc.files || []).filter((entry) => typeof entry.url === 'string' && entry.url.includes(marker));
const primary = doc.files.find((entry) => entry.url.endsWith('.zip')) || doc.files[0];
if (!primary) {
  throw new Error(`latest-mac.yml has no files for ${arch}`);
}
doc.path = primary.url;
doc.sha512 = primary.sha512;
fs.writeFileSync(file, yaml.dump(doc, { lineWidth: -1 }));
NODE
    echo "Updated latest-mac.yml artifact list to ${ARCH} only"
fi

# 8. Verify the DMG was built
# electron-builder.yml uses artifactName to output: Mkrate-${arch}.dmg
DMG_NAME="Mkrate-${ARCH}.dmg"
DMG_PATH="$ELECTRON_DIR/release/$DMG_NAME"

if [ ! -f "$DMG_PATH" ]; then
    echo "ERROR: Expected DMG not found at $DMG_PATH"
    echo "Contents of release directory:"
    ls -la "$ELECTRON_DIR/release/"
    exit 1
fi

# Validate the staged bundle before accepting the matching DMG/ZIP names.
APP_BUNDLE="$ELECTRON_DIR/release/mac-${ARCH}/Mkrate.app"
require_path "$APP_BUNDLE" "Mkrate ${ARCH} app bundle" "electron-builder did not stage the expected Mkrate.app bundle."
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_BUNDLE/Contents/Info.plist")"
BUNDLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$APP_BUNDLE/Contents/Info.plist")"
[ "$BUNDLE_ID" = "ru.mkrate.desktop" ] || { echo "ERROR: unexpected bundle id: $BUNDLE_ID" >&2; exit 1; }
[ "$BUNDLE_NAME" = "Mkrate" ] || { echo "ERROR: unexpected bundle name: $BUNDLE_NAME" >&2; exit 1; }
require_path "$APP_BUNDLE/Contents/Resources/icon.icns" "native Mkrate bundle icon" "Native icon was not copied into the Mkrate bundle."
BUNDLE_ARCHES="$(lipo -archs "$APP_BUNDLE/Contents/MacOS/Mkrate")"
EXPECTED_BUNDLE_ARCH="$ARCH"
[ "$ARCH" = "x64" ] && EXPECTED_BUNDLE_ARCH="x86_64"
echo "$BUNDLE_ARCHES" | grep -qw "$EXPECTED_BUNDLE_ARCH" || { echo "ERROR: bundle executable arches '$BUNDLE_ARCHES' do not include $EXPECTED_BUNDLE_ARCH." >&2; exit 1; }

SIGNING_INFO="$(codesign -dv "$APP_BUNDLE" 2>&1 || true)"
if codesign --verify --deep --strict "$APP_BUNDLE" >/dev/null 2>&1; then
    echo "$SIGNING_INFO" | grep -qi 'Signature=adhoc' || { echo "ERROR: expected unsigned/ad-hoc bundle, found a signed bundle." >&2; exit 1; }
    echo "Signing status: ad-hoc (expected; not notarized)"
elif echo "$SIGNING_INFO" | grep -qiE 'not signed|code object is not signed'; then
    echo "Signing status: unsigned (expected; not notarized)"
else
    echo "ERROR: could not prove the bundle is unsigned or ad-hoc." >&2
    echo "$SIGNING_INFO" >&2
    exit 1
fi
if xcrun stapler validate "$APP_BUNDLE" >/dev/null 2>&1; then
    echo "ERROR: expected an unnotarized v0.0.1 bundle, but a notarization ticket is present." >&2
    exit 1
fi
echo "Notarization status: not notarized (expected)"

# Artifact identity is intentionally predictable for exact-tag verification.
require_path "$ELECTRON_DIR/release/Mkrate-${ARCH}.zip" "Mkrate ${ARCH} ZIP" "Expected matching ZIP artifact."

echo ""
echo "=== Build Complete ==="
echo "DMG: $ELECTRON_DIR/release/${DMG_NAME}"
echo "Size: $(du -h "$ELECTRON_DIR/release/${DMG_NAME}" | cut -f1)"

# 9. Create manifest.json for upload script
# Read version from package.json
ELECTRON_VERSION=$(cat "$ELECTRON_DIR/package.json" | grep '"version"' | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
echo "Creating manifest.json (version: $ELECTRON_VERSION)..."
mkdir -p "$ROOT_DIR/.build/upload"
echo "{\"version\": \"$ELECTRON_VERSION\"}" > "$ROOT_DIR/.build/upload/manifest.json"

# 10. Upload to S3 (if --upload flag is set)
if [ "$UPLOAD" = true ]; then
    echo ""
    echo "=== Uploading to S3 ==="

    # Check for S3 credentials
    if [ -z "$S3_VERSIONS_BUCKET_ENDPOINT" ] || [ -z "$S3_VERSIONS_BUCKET_ACCESS_KEY_ID" ] || [ -z "$S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY" ]; then
        cat << EOF
ERROR: Missing S3 credentials. Set these environment variables:
  S3_VERSIONS_BUCKET_ENDPOINT
  S3_VERSIONS_BUCKET_ACCESS_KEY_ID
  S3_VERSIONS_BUCKET_SECRET_ACCESS_KEY

You can add them to .env or export them directly.
EOF
        exit 1
    fi

    # Build upload flags
    UPLOAD_FLAGS="--electron"
    [ "$UPLOAD_LATEST" = true ] && UPLOAD_FLAGS="$UPLOAD_FLAGS --latest"
    [ "$UPLOAD_SCRIPT" = true ] && UPLOAD_FLAGS="$UPLOAD_FLAGS --script"

    cd "$ROOT_DIR"
    bun run scripts/upload.ts $UPLOAD_FLAGS

    echo ""
    echo "=== Upload Complete ==="
fi
