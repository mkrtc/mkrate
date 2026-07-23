#!/bin/bash

set -e

# Default to GitHub Releases for this fork. Override for staging/custom feeds with:
#   CRAFT_AGENTS_DOWNLOAD_BASE_URL=https://example.com/path/to/latest/download
DOWNLOAD_BASE_URL="${CRAFT_AGENTS_DOWNLOAD_BASE_URL:-https://github.com/mkrtc/mkrate/releases/latest/download}"
DOWNLOAD_BASE_URL="${DOWNLOAD_BASE_URL%/}"
DOWNLOAD_DIR="$HOME/.craft-agent/downloads"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info() { printf "%b\n" "${BLUE}>${NC} $1"; }
success() { printf "%b\n" "${GREEN}>${NC} $1"; }
warn() { printf "%b\n" "${YELLOW}!${NC} $1"; }
error() { printf "%b\n" "${RED}x${NC} $1"; exit 1; }

# Detect OS
OS="$(uname -s)"
case "$OS" in
    Darwin) OS_TYPE="darwin" ;;
    Linux)  OS_TYPE="linux" ;;
    *)      error "Unsupported operating system: $OS" ;;
esac

# Check for required dependencies
DOWNLOADER=""
if command -v curl >/dev/null 2>&1; then
    DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER="wget"
else
    error "Either curl or wget is required but neither is installed"
fi

# Check if yq is available (optional, for YAML parsing)
HAS_YQ=false
if command -v yq >/dev/null 2>&1; then
    HAS_YQ=true
fi

# Download function that works with both curl and wget
# Usage: download_file <url> [output_file] [show_progress]
download_file() {
    local url="$1"
    local output="$2"
    local show_progress="${3:-false}"

    if [ "$DOWNLOADER" = "curl" ]; then
        if [ -n "$output" ]; then
            if [ "$show_progress" = "true" ]; then
                curl -fL --progress-bar -o "$output" "$url"
            else
                curl -fsSL -o "$output" "$url"
            fi
        else
            curl -fsSL "$url"
        fi
    elif [ "$DOWNLOADER" = "wget" ]; then
        if [ -n "$output" ]; then
            if [ "$show_progress" = "true" ]; then
                wget --show-progress -q -O "$output" "$url"
            else
                wget -q -O "$output" "$url"
            fi
        else
            wget -q -O - "$url"
        fi
    else
        return 1
    fi
}

# Extract sha512 from YAML for a specific architecture.
# Supports both manifests with per-file `arch:` fields and standard
# electron-builder manifests that only contain a single files[] entry.
get_sha512_from_yaml() {
    local yaml="$1"
    local target_arch="$2"

    local sha512=""
    local first_sha512=""

    while IFS= read -r line; do
        # Check if we're entering a new file entry
        if [[ $line =~ ^[[:space:]]*-[[:space:]]*url: ]]; then
            sha512=""
        fi
        # Extract sha512
        if [[ $line =~ sha512:[[:space:]]*(.+) ]]; then
            sha512="${BASH_REMATCH[1]}"
            if [ -z "$first_sha512" ]; then
                first_sha512="$sha512"
            fi
        fi
        # Check arch
        if [[ $line =~ arch:[[:space:]]*(.+) ]]; then
            local arch="${BASH_REMATCH[1]}"
            if [ "$arch" = "$target_arch" ] && [ -n "$sha512" ]; then
                echo "$sha512"
                return 0
            fi
        fi
    done <<< "$yaml"

    if [ -n "$first_sha512" ]; then
        echo "$first_sha512"
        return 0
    fi

    return 1
}

# Extract filename from YAML for a specific architecture.
# Falls back to the first files[].url/path for single-arch manifests.
get_filename_from_yaml() {
    local yaml="$1"
    local target_arch="$2"

    local url=""
    local first_url=""

    while IFS= read -r line; do
        # Check if we're entering a new file entry
        if [[ $line =~ ^[[:space:]]*-[[:space:]]*url:[[:space:]]*(.+) ]]; then
            url="${BASH_REMATCH[1]}"
            if [ -z "$first_url" ]; then
                first_url="$url"
            fi
        fi
        # Check arch
        if [[ $line =~ arch:[[:space:]]*(.+) ]]; then
            local arch="${BASH_REMATCH[1]}"
            if [ "$arch" = "$target_arch" ] && [ -n "$url" ]; then
                echo "$url"
                return 0
            fi
        fi
    done <<< "$yaml"

    if [ -n "$first_url" ]; then
        echo "$first_url"
        return 0
    fi

    return 1
}

# Detect architecture
case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $(uname -m)" ;;
esac

# Set platform-specific variables
if [ "$OS_TYPE" = "darwin" ]; then
    platform="darwin-${arch}"
    APP_NAME="Mkrate.app"
    INSTALL_DIR="/Applications"
    ext="zip"
    yml_file="latest-mac.yml"
else
    # Linux only supports x64 currently
    if [ "$arch" != "x64" ]; then
        error "Linux currently only supports x64 architecture. Your architecture: $arch"
    fi
    platform="linux-${arch}"
    APP_NAME="Mkrate-x64.AppImage"
    INSTALL_DIR="$HOME/.local/bin"
    ext="AppImage"
    yml_file="latest-linux.yml"
fi

echo ""
info "Detected platform: $platform"

mkdir -p "$DOWNLOAD_DIR"
mkdir -p "$INSTALL_DIR"

# Fetch YAML manifest directly from the latest release assets.
info "Fetching release info..."
manifest_yaml=$(download_file "$DOWNLOAD_BASE_URL/$yml_file")

if [ -z "$manifest_yaml" ]; then
    error "Failed to fetch release info from $yml_file"
fi

# Extract version from YAML manifest
if [ "$HAS_YQ" = true ]; then
    version=$(echo "$manifest_yaml" | yq -r '.version // empty')
else
    version=$(echo "$manifest_yaml" | grep -m1 '^version:' | sed 's/^version:[[:space:]]*//')
fi

if [ -z "$version" ]; then
    error "Failed to extract version from manifest"
fi

info "Latest version: $version"

# Extract sha512 and filename for our architecture
if [ "$HAS_YQ" = true ]; then
    checksum=$(echo "$manifest_yaml" | yq -r ".files[] | select(.arch == \"$arch\") | .sha512" | head -1)
    filename=$(echo "$manifest_yaml" | yq -r ".files[] | select(.arch == \"$arch\") | .url" | head -1)
    if [ -z "$checksum" ] || [ "$checksum" = "null" ]; then
        checksum=$(echo "$manifest_yaml" | yq -r ".files[0].sha512 // .sha512 // empty")
    fi
    if [ -z "$filename" ] || [ "$filename" = "null" ]; then
        filename=$(echo "$manifest_yaml" | yq -r ".files[0].url // .path // empty")
    fi
else
    checksum=$(get_sha512_from_yaml "$manifest_yaml" "$arch")
    filename=$(get_filename_from_yaml "$manifest_yaml" "$arch")
fi

# Validate checksum format (SHA512 base64 = 88 characters)
if [ -z "$checksum" ] || [ ${#checksum} -lt 80 ]; then
    error "No valid checksum found in $yml_file for architecture $arch"
fi

# Use default filename if not found
if [ -z "$filename" ]; then
    filename="Mkrate-${arch}.${ext}"
fi

info "Expected sha512: ${checksum:0:20}..."

# Download installer
installer_url="$DOWNLOAD_BASE_URL/$filename"
installer_path="$DOWNLOAD_DIR/$filename"

info "Downloading $filename..."
echo ""
if ! download_file "$installer_url" "$installer_path" true; then
    rm -f "$installer_path"
    error "Download failed"
fi
echo ""

# Verify checksum (sha512, base64 encoded)
info "Verifying checksum..."
if [ "$OS_TYPE" = "darwin" ]; then
    # macOS: shasum outputs hex, convert to base64
    actual=$(shasum -a 512 "$installer_path" | cut -d' ' -f1 | xxd -r -p | base64)
else
    # Linux: sha512sum outputs hex, convert to base64
    actual=$(sha512sum "$installer_path" | cut -d' ' -f1 | xxd -r -p | base64 | tr -d '\n')
fi

if [ "$actual" != "$checksum" ]; then
    rm -f "$installer_path"
    error "Checksum verification failed\n  Expected: $checksum\n  Actual:   $actual"
fi

success "Checksum verified!"

# Platform-specific installation
if [ "$OS_TYPE" = "darwin" ]; then
    # macOS installation (from ZIP)
    zip_path="$installer_path"

    # Quit the app if it's running (use bundle ID for reliability)
    APP_BUNDLE_ID="ru.mkrate.desktop"
    if pgrep -x "Mkrate" >/dev/null 2>&1; then
        info "Quitting Mkrate..."
        osascript -e "tell application id \"$APP_BUNDLE_ID\" to quit" 2>/dev/null || true
        # Wait for app to quit (max 5 seconds) - POSIX compatible loop
        i=0
        while [ $i -lt 10 ]; do
            if ! pgrep -x "Mkrate" >/dev/null 2>&1; then
                break
            fi
            sleep 0.5
            i=$((i + 1))
        done
        # Force kill if still running
        if pgrep -x "Mkrate" >/dev/null 2>&1; then
            warn "App didn't quit gracefully. Force quitting (unsaved data may be lost)..."
            pkill -9 -x "Mkrate" 2>/dev/null || true
            # Wait longer for macOS to release file handles
            sleep 3
        fi
    fi

    # Remove existing installation if present
    if [ -d "$INSTALL_DIR/$APP_NAME" ]; then
        info "Removing previous installation..."
        rm -rf "$INSTALL_DIR/$APP_NAME"
    fi

    # Extract ZIP to temp directory
    info "Extracting..."
    temp_dir=$(mktemp -d)
    if ! unzip -q "$zip_path" -d "$temp_dir"; then
        rm -rf "$temp_dir"
        rm -f "$zip_path"
        error "Failed to extract ZIP"
    fi

    # Find the .app in the extracted contents
    app_source=$(find "$temp_dir" -maxdepth 1 -name "*.app" -type d | head -1)

    if [ -z "$app_source" ]; then
        rm -rf "$temp_dir"
        rm -f "$zip_path"
        error "No .app found in ZIP"
    fi

    # Copy app to /Applications
    info "Installing to $INSTALL_DIR..."
    cp -R "$app_source" "$INSTALL_DIR/$APP_NAME"

    # Clean up
    info "Cleaning up..."
    rm -rf "$temp_dir"
    rm -f "$zip_path"

    # Remove quarantine attribute if present
    xattr -rd com.apple.quarantine "$INSTALL_DIR/$APP_NAME" 2>/dev/null || true

    echo ""
    echo "─────────────────────────────────────────────────────────────────────────"
    echo ""
    success "Installation complete!"
    echo ""
    printf "%b\n" "  Mkrate has been installed to ${BOLD}$INSTALL_DIR/$APP_NAME${NC}"
    echo ""
    printf "%b\n" "  You can launch it from ${BOLD}Applications${NC} or by running:"
    printf "%b\n" "    ${BOLD}open -a 'Mkrate'${NC}"
    echo ""

else
    # Linux installation
    appimage_path="$installer_path"

    # New paths
    APP_DIR="$HOME/.craft-agent/app"
    WRAPPER_PATH="$INSTALL_DIR/mkrate"
    APPIMAGE_INSTALL_PATH="$APP_DIR/Mkrate-x64.AppImage"
    DESKTOP_DIR="$HOME/.local/share/applications"
    ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
    DESKTOP_FILE="$DESKTOP_DIR/mkrate.desktop"
    ICON_FILE="$ICON_DIR/mkrate.png"

    running_pids=""
    while IFS= read -r line; do
        pid="${line%% *}"
        cmd="${line#* }"

        if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then
            continue
        fi

        case "$cmd" in
            *install-app.sh*) continue ;;
        esac

        running_pids="$running_pids $pid"
    done < <(pgrep -af 'Mkrate-x64\.AppImage|/@craft-agentelectron' || true)

    # Kill the app if it's running
    if [ -n "$running_pids" ]; then
        info "Stopping Mkrate..."
        kill $running_pids 2>/dev/null || true
        sleep 2
    fi

    # Create directories
    mkdir -p "$APP_DIR"
    mkdir -p "$INSTALL_DIR"

    # Remove existing AppImage
    [ -f "$APPIMAGE_INSTALL_PATH" ] && rm -f "$APPIMAGE_INSTALL_PATH"

    # Install AppImage
    info "Installing AppImage to $APP_DIR..."
    mv "$appimage_path" "$APPIMAGE_INSTALL_PATH"
    chmod +x "$APPIMAGE_INSTALL_PATH"

    # Create wrapper script
    info "Creating launcher at $WRAPPER_PATH..."
    cat > "$WRAPPER_PATH" << 'WRAPPER_EOF'
#!/bin/bash
# Mkrate launcher - handles Linux-specific AppImage issues

APPIMAGE_PATH="$HOME/.craft-agent/app/Mkrate-x64.AppImage"
ELECTRON_CACHE="$HOME/.config/Mkrate"
ELECTRON_CACHE_ALT="$HOME/.cache/Mkrate"

# Verify AppImage exists
if [ ! -f "$APPIMAGE_PATH" ]; then
    echo "Error: Mkrate not found at $APPIMAGE_PATH"
    echo "Reinstall: curl -fsSL https://raw.githubusercontent.com/mkrtc/mkrate/main/scripts/install-app.sh | bash"
    exit 1
fi

# Ensure DISPLAY is set (required for X11)
if [ -z "$DISPLAY" ]; then
    export DISPLAY=:0.0
fi

# Clear stale cache referencing AppImage mount paths
# AppImage creates a new /tmp/.mount_Mkrate-XXXX each launch, so any cached path is stale
for cache_dir in "$ELECTRON_CACHE" "$ELECTRON_CACHE_ALT"; do
    if [ -d "$cache_dir" ] && grep -rq '/tmp/\.mount_Mkrate' "$cache_dir" 2>/dev/null; then
        rm -rf "$cache_dir"
    fi
done

# Set APPIMAGE for auto-update
export APPIMAGE="$APPIMAGE_PATH"

launch_args=(--no-sandbox --disable-gpu-sandbox)

if [ "${ELECTRON_OZONE_PLATFORM_HINT:-}" = "wayland" ] || { [ -z "${ELECTRON_OZONE_PLATFORM_HINT:-}" ] && { [ -n "${WAYLAND_DISPLAY:-}" ] || [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; }; }; then
    export ELECTRON_OZONE_PLATFORM_HINT=wayland
    launch_args+=(--ozone-platform=wayland --enable-features=UseOzonePlatform)
fi

# Launch with --no-sandbox (AppImage extracts to /tmp, losing SUID on chrome-sandbox)
exec "$APPIMAGE_PATH" "${launch_args[@]}" "$@"
WRAPPER_EOF

    chmod +x "$WRAPPER_PATH"

    # Migrate old installation
    OLD_APPIMAGE="$INSTALL_DIR/Mkrate-x64.AppImage"
    [ -f "$OLD_APPIMAGE" ] && rm -f "$OLD_APPIMAGE"

    # Desktop integration
    info "Creating desktop entry..."
    mkdir -p "$DESKTOP_DIR"
    mkdir -p "$ICON_DIR"

    ICON_EXTRACT_DIR="$(mktemp -d)"
    if (cd "$ICON_EXTRACT_DIR" && "$APPIMAGE_INSTALL_PATH" --appimage-extract usr/share/icons/hicolor/512x512/apps >/dev/null 2>&1); then
        EXTRACTED_ICON="$(find "$ICON_EXTRACT_DIR/squashfs-root/usr/share/icons/hicolor/512x512/apps" -maxdepth 1 -type f -name "*.png" | head -1)"
        if [ -n "$EXTRACTED_ICON" ]; then
            cp "$EXTRACTED_ICON" "$ICON_FILE"
        fi
    fi
    rm -rf "$ICON_EXTRACT_DIR"

    cat > "$DESKTOP_FILE" << DESKTOP_EOF
[Desktop Entry]
Name=Mkrate
Comment=Mkrate — independent fork of Craft Agents
Exec=$WRAPPER_PATH %U
TryExec=$WRAPPER_PATH
Terminal=false
Type=Application
Icon=mkrate
StartupWMClass=Mkrate
StartupNotify=true
Categories=Utility;
MimeType=x-scheme-handler/craftagents;
DESKTOP_EOF

    chmod 644 "$DESKTOP_FILE"

    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
    fi

    if command -v xdg-desktop-menu >/dev/null 2>&1; then
        xdg-desktop-menu forceupdate >/dev/null 2>&1 || true
    fi

    if command -v xdg-mime >/dev/null 2>&1; then
        xdg-mime default mkrate.desktop x-scheme-handler/craftagents >/dev/null 2>&1 || true
    fi

    echo ""
    echo "─────────────────────────────────────────────────────────────────────────"
    echo ""
    success "Installation complete!"
    echo ""
    printf "%b\n" "  AppImage: ${BOLD}$APPIMAGE_INSTALL_PATH${NC}"
    printf "%b\n" "  Launcher: ${BOLD}$WRAPPER_PATH${NC}"
    printf "%b\n" "  Desktop entry: ${BOLD}$DESKTOP_FILE${NC}"
    echo ""
    printf "%b\n" "  Run with: ${BOLD}mkrate${NC}"
    echo ""
    printf "%b\n" "  Add to PATH if needed:"
    printf "%b\n" "    ${BOLD}echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc${NC}"
    echo ""

    # FUSE check
    if ! command -v fusermount >/dev/null 2>&1; then
        warn "FUSE required but not detected."
        printf "%b\n" "  Install: ${BOLD}sudo apt install fuse libfuse2${NC} (Debian/Ubuntu)"
        printf "%b\n" "           ${BOLD}sudo dnf install fuse fuse-libs${NC} (Fedora)"
    fi
fi
