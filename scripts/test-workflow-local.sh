#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Use an existing key or load one from an explicitly configured file.
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
  API_KEY="$ANTHROPIC_API_KEY"
elif [[ -n "${ANTHROPIC_API_KEY_FILE:-}" ]]; then
  API_KEY=$(<"$ANTHROPIC_API_KEY_FILE")
else
  echo "Error: Set ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_FILE"
  exit 1
fi

if [[ -z "$API_KEY" ]]; then
  echo "Error: Empty API key"
  exit 1
fi

cd "$REPO_ROOT"

echo "==> Installing dependencies..."
bun install

echo "==> Running validate-daily-note locally..."
ANTHROPIC_API_KEY="$API_KEY" bun run apps/cli/src/index.ts run \
  --workspace-dir .github/agents \
  --source craft-public \
  --output-format stream-json \
  "Read today's daily note from the Craft source and print its contents. Do not modify anything."
