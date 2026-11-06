#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SOURCE="$REPO_ROOT/extensions/prompt-suggestions"
TARGET_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}/extensions"
TARGET="$TARGET_DIR/prompt-suggestions"

if [[ ! -f "$SOURCE/index.ts" ]]; then
  echo "Missing extension source: $SOURCE" >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"

if [[ -L "$TARGET" ]]; then
  current="$(readlink "$TARGET")"
  if [[ "$current" == "$SOURCE" ]]; then
    echo "Prompt suggestions extension already installed: $TARGET -> $SOURCE"
    exit 0
  fi
  echo "Replacing existing symlink: $TARGET -> $current"
  rm "$TARGET"
elif [[ -e "$TARGET" ]]; then
  echo "Refusing to overwrite existing non-symlink: $TARGET" >&2
  echo "Remove it manually or set PI_AGENT_DIR to another agent dir." >&2
  exit 1
fi

ln -s "$SOURCE" "$TARGET"
echo "Installed prompt suggestions extension: $TARGET -> $SOURCE"
echo "Restart Pi or run /reload to activate it."
