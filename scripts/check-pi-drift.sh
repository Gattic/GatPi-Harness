#!/usr/bin/env bash
set -euo pipefail

# Verify that the active global `pi` command is linked to the configured source
# fork, that the checkout contains the migrated runtime patches, and that the
# linked build and checkout are not drifting from origin/main.
# Exit codes: 0 = linked fork is current and clean, 1 = activation/source drift.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
git_common_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
CANONICAL_REPO_ROOT="$REPO_ROOT"
if [[ -n "$git_common_dir" ]]; then CANONICAL_REPO_ROOT="$(dirname "$git_common_dir")"; fi
CONFIG_FILE="$REPO_ROOT/config/pi-fork.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "DRIFT: missing Pi fork config: $CONFIG_FILE" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$CONFIG_FILE"

: "${PI_FORK_URL:?PI_FORK_URL must be set in config/pi-fork.env}"
: "${PI_FORK_BRANCH:?PI_FORK_BRANCH must be set in config/pi-fork.env}"
: "${PI_FORK_PATCH_COMMIT:?PI_FORK_PATCH_COMMIT must be set in config/pi-fork.env}"
: "${PI_SOURCE_ROOT_DEFAULT:?PI_SOURCE_ROOT_DEFAULT must be set in config/pi-fork.env}"

PI_SOURCE_ROOT="${PI_SOURCE_ROOT:-$CANONICAL_REPO_ROOT/$PI_SOURCE_ROOT_DEFAULT}"
PACKAGE_ROOT="$PI_SOURCE_ROOT/packages/coding-agent"

if [[ ! -d "$PI_SOURCE_ROOT/.git" || ! -f "$PACKAGE_ROOT/package.json" ]]; then
  echo "DRIFT: configured Pi source checkout was not found at $PI_SOURCE_ROOT" >&2
  echo "Clone $PI_FORK_URL there, or set PI_SOURCE_ROOT to the checkout path." >&2
  exit 1
fi

PI_SOURCE_ROOT="$(cd -- "$PI_SOURCE_ROOT" && pwd -P)"
PACKAGE_ROOT="$PI_SOURCE_ROOT/packages/coding-agent"
# The package manifest's `pi` bin entry is what `npm link` activates.
bin_entry="$(node -p 'const b = require(process.argv[1]).bin; (typeof b === "string" ? b : b?.pi) ?? ""' "$PACKAGE_ROOT/package.json" 2>/dev/null || true)"
if [[ -z "$bin_entry" ]]; then
  echo "DRIFT: $PACKAGE_ROOT/package.json does not declare a pi bin entry" >&2
  exit 1
fi
EXPECTED_BIN="$PACKAGE_ROOT/$bin_entry"

fail=0
drift() {
  echo "DRIFT: $*" >&2
  fail=1
}

origin_url="$(git -C "$PI_SOURCE_ROOT" remote get-url origin 2>/dev/null || true)"
branch="$(git -C "$PI_SOURCE_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
head_sha="$(git -C "$PI_SOURCE_ROOT" rev-parse HEAD 2>/dev/null || true)"
origin_sha="$(git -C "$PI_SOURCE_ROOT" rev-parse "refs/remotes/origin/$PI_FORK_BRANCH" 2>/dev/null || true)"
source_version="$(node -p 'require(process.argv[1]).version' "$PACKAGE_ROOT/package.json" 2>/dev/null || true)"
source_dirty="$(git -C "$PI_SOURCE_ROOT" status --porcelain --untracked-files=normal 2>/dev/null || true)"

printf 'source fork:       %s\n' "$PI_FORK_URL"
printf 'source checkout:   %s\n' "$PI_SOURCE_ROOT"
printf 'source branch:     %s\n' "${branch:-detached}"
printf 'source HEAD:       %s\n' "${head_sha:-unknown}"
printf 'cached origin/%s: %s\n' "$PI_FORK_BRANCH" "${origin_sha:-unknown}"
printf 'source version:    %s\n' "${source_version:-unknown}"

[[ "$origin_url" == "$PI_FORK_URL" ]] || drift "origin URL is ${origin_url:-missing}; expected $PI_FORK_URL"
[[ "$branch" == "$PI_FORK_BRANCH" ]] || drift "source branch is ${branch:-detached}; expected $PI_FORK_BRANCH"
[[ -n "$origin_sha" && "$head_sha" == "$origin_sha" ]] || drift "source HEAD does not match cached origin/$PI_FORK_BRANCH; fetch/update the fork"
if ! git -C "$PI_SOURCE_ROOT" merge-base --is-ancestor "$PI_FORK_PATCH_COMMIT" HEAD 2>/dev/null; then
  drift "source HEAD does not contain migrated patch commit $PI_FORK_PATCH_COMMIT"
fi
[[ -z "$source_dirty" ]] || drift "source checkout has uncommitted files"
[[ -x "$EXPECTED_BIN" ]] || drift "fork build is missing or not executable: $EXPECTED_BIN"

if ! command -v pi >/dev/null 2>&1; then
  drift "pi is not on PATH"
else
  pi_bin="$(command -v pi)"
  pi_bin_real="$(readlink -f "$pi_bin" 2>/dev/null || true)"
  expected_bin_real="$(readlink -f "$EXPECTED_BIN" 2>/dev/null || true)"
  active_version="$(pi --version 2>/dev/null | tail -n 1 || true)"
  printf 'active pi:         %s\n' "$pi_bin"
  printf 'active target:     %s\n' "${pi_bin_real:-unknown}"
  printf 'active version:    %s\n' "${active_version:-unknown}"
  [[ -n "$pi_bin_real" && "$pi_bin_real" == "$expected_bin_real" ]] || drift "active pi does not resolve to $EXPECTED_BIN"
  [[ -n "$source_version" && "$active_version" == "$source_version" ]] || drift "active Pi version (${active_version:-unknown}) does not match source package ($source_version)"
fi

if (( fail != 0 )); then
  echo "Rebuild $PI_SOURCE_ROOT and run 'npm link' from packages/coding-agent after reconciling the source checkout." >&2
  exit 1
fi

echo "no drift: active Pi is the clean, current configured fork source build."
