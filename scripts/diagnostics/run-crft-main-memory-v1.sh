#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/diagnostics/run-crft-main-memory-v1.sh smoke <run-id> <absolute-output-dir> <expected-git-sha>
  scripts/diagnostics/run-crft-main-memory-v1.sh run   <run-id> <absolute-output-dir> <expected-git-sha>

Prerequisite:
  bun run electron:build:main

The launcher creates a fresh /tmp/crft-main-mem-v1-m0d-* root, sets isolated
HOME/XDG/CRAFT_CONFIG_DIR/Electron user-data/workspace/session roots, removes all
credential/provider environment variables with env -i, binds RPC to
127.0.0.1:0, and always deletes the isolated root on exit. JSONL artifacts are
retained in <absolute-output-dir> with the crft-main-mem-v1-m0d- prefix.
The immutable expected git SHA is validated against HEAD and recorded in every
artifact row; this keeps the launcher branch-agnostic without permitting an
accidental or moving commit to run.
EOF
}

if [[ $# -ne 4 ]]; then
  usage >&2
  exit 64
fi

MODE=$1
RUN_ID=$2
OUTPUT_DIR=$3
EXPECTED_GIT_SHA=$4
case "$MODE" in
  smoke|run) ;;
  *) usage >&2; exit 64 ;;
esac
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,63}$ ]]; then
  echo "Invalid run id" >&2
  exit 64
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
  echo "Output directory must be absolute" >&2
  exit 64
fi
if [[ ! "$EXPECTED_GIT_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected git SHA must be a full lowercase 40-character SHA" >&2
  exit 64
fi

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
ACTUAL_GIT_SHA=$(git -C "$REPO_ROOT" rev-parse --verify HEAD^{commit})
if [[ "$ACTUAL_GIT_SHA" != "$EXPECTED_GIT_SHA" ]]; then
  echo "Refusing diagnostic launch: HEAD $ACTUAL_GIT_SHA does not match expected $EXPECTED_GIT_SHA" >&2
  exit 65
fi
GIT_SHA=$EXPECTED_GIT_SHA

DEFAULT_ELECTRON_BIN="$REPO_ROOT/node_modules/.bin/electron"
ELECTRON_BIN="${CRAFT_DIAG_ELECTRON_BIN:-$DEFAULT_ELECTRON_BIN}"
if [[ "$ELECTRON_BIN" != /* ]]; then
  echo "Electron binary must be absolute" >&2
  exit 66
fi
ELECTRON_ENTRY="$REPO_ROOT/apps/electron"
MAIN_BUNDLE="$REPO_ROOT/apps/electron/dist/main.cjs"
if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "Missing executable $ELECTRON_BIN; run: bun install or set CRAFT_DIAG_ELECTRON_BIN=/absolute/path/to/electron" >&2
  exit 66
fi
if [[ ! -e "$MAIN_BUNDLE" ]]; then
  echo "Missing $MAIN_BUNDLE; run: bun run electron:build:main" >&2
  exit 66
fi

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR=$(realpath "$OUTPUT_DIR")
OUTPUT_FILE="$OUTPUT_DIR/crft-main-mem-v1-m0d-$RUN_ID.jsonl"
if [[ -e "$OUTPUT_FILE" ]]; then
  echo "Refusing to overwrite existing diagnostic artifact" >&2
  exit 73
fi

DIAG_ROOT=$(mktemp -d "/tmp/crft-main-mem-v1-m0d-${RUN_ID}-XXXXXX")
case "$DIAG_ROOT" in
  /tmp/crft-main-mem-v1-m0d-*) ;;
  *) echo "Unsafe diagnostic root" >&2; exit 70 ;;
esac
cleanup() {
  case "$DIAG_ROOT" in
    /tmp/crft-main-mem-v1-m0d-*) rm -rf -- "$DIAG_ROOT" ;;
    *) echo "Refusing unsafe cleanup root" >&2 ;;
  esac
}
trap cleanup EXIT INT TERM

HOME_DIR="$DIAG_ROOT/home"
XDG_CONFIG_DIR="$DIAG_ROOT/xdg-config"
XDG_CACHE_DIR="$DIAG_ROOT/xdg-cache"
XDG_DATA_DIR="$DIAG_ROOT/xdg-data"
XDG_RUNTIME_DIR="$DIAG_ROOT/xdg-runtime"
CRAFT_CONFIG_DIR="$DIAG_ROOT/craft-config"
USER_DATA_DIR="$DIAG_ROOT/electron-user-data"
WORKSPACE_ROOT="$DIAG_ROOT/workspace"
SESSION_ROOT="$WORKSPACE_ROOT/sessions"

mkdir -p \
  "$HOME_DIR" "$XDG_CONFIG_DIR" "$XDG_CACHE_DIR" "$XDG_DATA_DIR" \
  "$XDG_RUNTIME_DIR" "$CRAFT_CONFIG_DIR" "$USER_DATA_DIR" \
  "$WORKSPACE_ROOT" "$SESSION_ROOT"
chmod 700 "$DIAG_ROOT" "$XDG_RUNTIME_DIR"

# Verify every sensitive root is unique, canonical, and beneath the fresh root
# before invoking Electron. This is the authoritative pre-invocation isolation gate.
python3 - "$DIAG_ROOT" \
  "$HOME_DIR" "$XDG_CONFIG_DIR" "$XDG_CACHE_DIR" "$XDG_DATA_DIR" \
  "$CRAFT_CONFIG_DIR" "$USER_DATA_DIR" "$WORKSPACE_ROOT" "$SESSION_ROOT" <<'PY'
import os, sys
root = os.path.realpath(sys.argv[1])
paths = [os.path.realpath(p) for p in sys.argv[2:]]
if len(paths) != len(set(paths)):
    raise SystemExit('diagnostic roots are not unique')
for path in paths:
    if os.path.commonpath([root, path]) != root or path == root:
        raise SystemExit('diagnostic root escaped isolated parent')
    if os.path.islink(path):
        raise SystemExit('diagnostic root may not be a symlink')
PY

cat > "$CRAFT_CONFIG_DIR/config.json" <<EOF
{
  "workspaces": [
    {
      "id": "crft-main-memory-v1",
      "name": "CRFT Main Memory Synthetic",
      "rootPath": "$WORKSPACE_ROOT",
      "createdAt": 1700000000000
    }
  ],
  "activeWorkspaceId": "crft-main-memory-v1",
  "activeSessionId": null,
  "llmConnections": [],
  "defaultLlmConnection": null
}
EOF
cat > "$WORKSPACE_ROOT/config.json" <<'EOF'
{
  "name": "CRFT Main Memory Synthetic",
  "createdAt": 1700000000000,
  "defaults": {
    "permissionMode": "safe"
  }
}
EOF

if [[ "$MODE" == "run" ]]; then
  DIAG_ARG=--craft-diag-main-memory-driver
else
  DIAG_ARG=--craft-diag-main-memory-smoke
fi

# env -i prevents credentials, provider routing, source tokens, MCP settings,
# proxies, and the active user's profile from crossing into the diagnostic app.
# xvfb-run provides a private display when available; otherwise Chromium's
# headless Ozone backend keeps the diagnostic independent of the user's display.
RUNNER=()
DISPLAY_ARGS=()
if command -v xvfb-run >/dev/null 2>&1; then
  RUNNER=(xvfb-run -a --server-args="-screen 0 1280x720x24 -nolisten tcp")
else
  DISPLAY_ARGS=(--ozone-platform=headless --disable-gpu)
fi

set +e
env -i \
  PATH="$PATH" \
  LANG="${LANG:-C.UTF-8}" \
  LC_ALL="${LC_ALL:-C.UTF-8}" \
  HOME="$HOME_DIR" \
  XDG_CONFIG_HOME="$XDG_CONFIG_DIR" \
  XDG_CACHE_HOME="$XDG_CACHE_DIR" \
  XDG_DATA_HOME="$XDG_DATA_DIR" \
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  CRAFT_CONFIG_DIR="$CRAFT_CONFIG_DIR" \
  CRAFT_DIAG_MAIN_MEMORY=1 \
  CRAFT_DIAG_ROOT="$DIAG_ROOT" \
  CRAFT_DIAG_SESSION_ROOT="$SESSION_ROOT" \
  CRAFT_DIAG_WORKSPACE_ROOT="$WORKSPACE_ROOT" \
  CRAFT_DIAG_OUTPUT_DIR="$OUTPUT_DIR" \
  CRAFT_DIAG_RUN_ID="$RUN_ID" \
  CRAFT_DIAG_GIT_SHA="$GIT_SHA" \
  CRAFT_HEADLESS=1 \
  CRAFT_RPC_HOST=127.0.0.1 \
  CRAFT_RPC_PORT=0 \
  CRAFT_APP_NAME="Mkrate CRFT Diagnostic $RUN_ID" \
  CRAFT_DEEPLINK_SCHEME="craftagentsdiag${RUN_ID//-/}" \
  "${RUNNER[@]}" \
    "$ELECTRON_BIN" \
    "${DISPLAY_ARGS[@]}" \
    --js-flags=--expose-gc \
    --user-data-dir="$USER_DATA_DIR" \
    "$ELECTRON_ENTRY" \
    "$DIAG_ARG" \
    >"$DIAG_ROOT/electron.stdout.log" \
    2>"$DIAG_ROOT/electron.stderr.log"
STATUS=$?
set -e

if [[ $STATUS -ne 0 ]]; then
  echo "Isolated diagnostic process failed with exit code $STATUS" >&2
  tail -n 80 "$DIAG_ROOT/electron.stderr.log" >&2 || true
  exit "$STATUS"
fi
if [[ ! -s "$OUTPUT_FILE" ]]; then
  echo "Diagnostic process produced no JSONL artifact" >&2
  exit 74
fi

python3 - "$OUTPUT_FILE" "$MODE" <<'PY'
import json, sys
path, mode = sys.argv[1:]
with open(path, encoding='utf-8') as fh:
    rows = [json.loads(line) for line in fh if line.strip()]
if not rows or rows[-1].get('kind') != 'run-complete':
    raise SystemExit('diagnostic artifact did not complete')
if any(row.get('schema') != 'craft.main-memory-diagnostic' or row.get('version') != 1 for row in rows):
    raise SystemExit('diagnostic artifact schema mismatch')
if mode == 'smoke' and not any(row.get('stage') == 'smoke' for row in rows):
    raise SystemExit('smoke snapshot missing')
if mode == 'run':
    stages = [row.get('stage') for row in rows if row.get('kind') == 'snapshot']
    expected = ['baseline'] + [f'open-{i:02d}' for i in range(1, 26)] + ['post-load', 'post-workload', 'post-idle']
    if stages != expected:
        raise SystemExit('full diagnostic stage ordering mismatch')
print(json.dumps({'mode': mode, 'records': len(rows), 'complete': True}))
PY
