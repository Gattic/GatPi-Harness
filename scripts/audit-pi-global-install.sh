#!/usr/bin/env bash
set -euo pipefail

# Compare the installed global Pi package (and bundled @earendil-works runtime
# packages) against the matching packages published to npm. Output is written
# under .pi/audit/global-pi/ so local global edits can be reviewed and captured
# as portable patches.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
OUT_DIR="$REPO_ROOT/.pi/audit/global-pi"
mkdir -p "$OUT_DIR"

npm_root="$(npm root -g)"
PI_ROOT="${PI_ROOT:-$npm_root/@earendil-works/pi-coding-agent}"

if [[ ! -f "$PI_ROOT/package.json" ]]; then
  echo "Could not find global Pi package at: $PI_ROOT" >&2
  echo "Set PI_ROOT=/path/to/@earendil-works/pi-coding-agent to override." >&2
  exit 1
fi

pack_and_diff() {
  local name="$1"
  local installed="$2"
  local exclude_node_modules="$3"
  local version
  version="$(node -e "console.log(require(process.argv[1]).version)" "$installed/package.json")"
  local tmp
  tmp="$(mktemp -d)"
  pushd "$tmp" >/dev/null
  npm pack "@earendil-works/$name@$version" --silent >/tmp/pi-audit-pack-name
  tar -xzf "$(cat /tmp/pi-audit-pack-name)"
  popd >/dev/null

  local diff_file="$OUT_DIR/$name-$version.diff"
  if [[ "$exclude_node_modules" == "yes" ]]; then
    diff -ruN --exclude=node_modules "$tmp/package" "$installed" > "$diff_file" || true
  else
    diff -ruN "$tmp/package" "$installed" > "$diff_file" || true
  fi
  rm -rf "$tmp"
  local lines
  lines="$(wc -l < "$diff_file")"
  echo "$name@$version: $lines diff lines -> $diff_file"
}

pack_and_diff pi-coding-agent "$PI_ROOT" yes
for dep in pi-tui pi-agent-core pi-ai; do
  dep_root="$PI_ROOT/node_modules/@earendil-works/$dep"
  if [[ -f "$dep_root/package.json" ]]; then
    pack_and_diff "$dep" "$dep_root" no
  fi
done
