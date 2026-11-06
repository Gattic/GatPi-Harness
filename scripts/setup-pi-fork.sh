#!/usr/bin/env bash
set -euo pipefail

# Safely update, build, globally link, and verify the configured Pi source fork.
# The script refuses dirty/diverged repositories and never stashes, resets,
# force-pushes, or uses sudo.

SCRIPT_PATH="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$(basename -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname -- "$SCRIPT_PATH")"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
CONFIG_FILE="${PI_SETUP_CONFIG_FILE:-$REPO_ROOT/config/pi-fork.env}"
CHECK_ONLY=0
SKIP_DEPS=0
AFTER_SELF_UPDATE=0
ORIGINAL_ARGS=("$@")

usage() {
  cat <<'EOF'
Usage: scripts/setup-pi-fork.sh [--check] [--skip-deps]

Without options, safely fast-forward the harness and Pi fork, install the
fork's dependencies, build committed sources, link the coding-agent package
into the active npm prefix, and run the drift verifier.

Options:
  --check       Read-only local validation; do not fetch, build, or link.
  --skip-deps   Reuse the existing Pi node_modules instead of running npm ci.
  -h, --help    Show this help.

Environment:
  PI_SOURCE_ROOT       Override the configured sibling Pi checkout.
  PI_SETUP_CONFIG_FILE Override config/pi-fork.env (primarily for tests).
EOF
}

while (($#)); do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --skip-deps) SKIP_DEPS=1 ;;
    --after-self-update) AFTER_SELF_UPDATE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

note() {
  printf '== %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found on PATH: $1"
}

repo_dirty() {
  [[ -n "$(git -C "$1" status --porcelain --untracked-files=normal 2>/dev/null || true)" ]]
}

require_clean_repo() {
  local repo="$1"
  local label="$2"
  [[ -d "$repo/.git" ]] || fail "$label is not a Git checkout: $repo"
  repo_dirty "$repo" && fail "$label has uncommitted files; commit or remove them before continuing: $repo"
  return 0
}

require_remote() {
  local repo="$1"
  local name="$2"
  local expected="$3"
  local label="$4"
  local actual
  actual="$(git -C "$repo" remote get-url "$name" 2>/dev/null || true)"
  [[ -n "$actual" ]] || fail "$label is missing remote '$name'"
  [[ "$actual" == "$expected" ]] || fail "$label remote '$name' is $actual; expected $expected"
}

require_branch() {
  local repo="$1"
  local expected="$2"
  local label="$3"
  local actual
  actual="$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [[ "$actual" == "$expected" ]] || fail "$label branch is ${actual:-detached}; expected $expected"
}

require_synced_ref() {
  local repo="$1"
  local remote="$2"
  local branch="$3"
  local label="$4"
  local head remote_head
  head="$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)"
  remote_head="$(git -C "$repo" rev-parse "refs/remotes/$remote/$branch" 2>/dev/null || true)"
  [[ -n "$remote_head" ]] || fail "$label has no cached $remote/$branch; run without --check to fetch it"
  [[ "$head" == "$remote_head" ]] || fail "$label HEAD does not match cached $remote/$branch; run without --check to update it"
}

update_repo() {
  local repo="$1"
  local remote="$2"
  local branch="$3"
  local label="$4"
  note "Fetching $label"
  git -C "$repo" fetch --prune "$remote" "$branch"
  local counts local_only remote_only
  counts="$(git -C "$repo" rev-list --left-right --count "HEAD...refs/remotes/$remote/$branch")"
  read -r local_only remote_only <<<"$counts"
  if ((local_only > 0)); then
    fail "$label has $local_only local commit(s) not on $remote/$branch; refusing to merge or overwrite them"
  fi
  if ((remote_only > 0)); then
    note "Fast-forwarding $label by $remote_only commit(s)"
    git -C "$repo" merge --ff-only "refs/remotes/$remote/$branch"
    return 10
  fi
  return 0
}

[[ -f "$CONFIG_FILE" ]] || fail "missing Pi fork config: $CONFIG_FILE"
# shellcheck disable=SC1090
source "$CONFIG_FILE"

: "${PI_HARNESS_URL:?PI_HARNESS_URL must be set in config/pi-fork.env}"
: "${PI_HARNESS_BRANCH:?PI_HARNESS_BRANCH must be set in config/pi-fork.env}"
: "${PI_FORK_URL:?PI_FORK_URL must be set in config/pi-fork.env}"
: "${PI_FORK_BRANCH:?PI_FORK_BRANCH must be set in config/pi-fork.env}"
: "${PI_FORK_PATCH_COMMIT:?PI_FORK_PATCH_COMMIT must be set in config/pi-fork.env}"
: "${PI_UPSTREAM_URL:?PI_UPSTREAM_URL must be set in config/pi-fork.env}"
: "${PI_SOURCE_ROOT_DEFAULT:?PI_SOURCE_ROOT_DEFAULT must be set in config/pi-fork.env}"
: "${PI_MIN_NODE_VERSION:?PI_MIN_NODE_VERSION must be set in config/pi-fork.env}"

for command in git node npm df readlink; do
  require_command "$command"
done

node -e '
const current = process.versions.node.split(".").map(Number);
const minimum = process.argv[1].split(".").map(Number);
for (let i = 0; i < 3; i++) {
  if ((current[i] || 0) > (minimum[i] || 0)) process.exit(0);
  if ((current[i] || 0) < (minimum[i] || 0)) process.exit(1);
}
' "$PI_MIN_NODE_VERSION" || fail "Node $(node --version) is too old; Pi requires >=$PI_MIN_NODE_VERSION"
node -e 'const zlib = require("node:zlib"); process.exit(typeof zlib.createZstdDecompress === "function" ? 0 : 1)' || \
  fail "Node $(node --version) lacks zlib.createZstdDecompress required by Pi; switch to Node 22 LTS with 'nvm install 22.22.2 && nvm use 22.22.2'"

PI_SOURCE_ROOT="${PI_SOURCE_ROOT:-$REPO_ROOT/$PI_SOURCE_ROOT_DEFAULT}"
PI_SOURCE_PARENT="$(dirname -- "$PI_SOURCE_ROOT")"
if [[ ! -d "$PI_SOURCE_PARENT" ]]; then
  ((CHECK_ONLY)) && fail "Pi checkout parent does not exist: $PI_SOURCE_PARENT"
  mkdir -p "$PI_SOURCE_PARENT"
fi
PI_SOURCE_PARENT="$(cd -- "$PI_SOURCE_PARENT" && pwd -P)"
PI_SOURCE_ROOT="$PI_SOURCE_PARENT/$(basename -- "$PI_SOURCE_ROOT")"

npm_prefix="$(npm prefix -g)"
note "Machine preflight"
printf 'node:              %s (%s)\n' "$(command -v node)" "$(node --version)"
printf 'npm:               %s (%s)\n' "$(command -v npm)" "$(npm --version)"
printf 'npm prefix:        %s\n' "$npm_prefix"
printf 'harness checkout:  %s\n' "$REPO_ROOT"
printf 'Pi checkout:       %s\n' "$PI_SOURCE_ROOT"
available_kb="$(df -Pk "$PI_SOURCE_PARENT" | awk 'NR==2 {print $4}')"
printf 'free disk:         %s KiB\n' "${available_kb:-unknown}"
if [[ -n "$available_kb" ]] && ((available_kb < 2097152)); then
  fail "less than 2 GiB is free under $PI_SOURCE_PARENT"
fi
[[ -d "$npm_prefix" && -w "$npm_prefix" ]] || \
  fail "active npm prefix is not user-writable: $npm_prefix (use a user-managed Node installation; do not run this script with sudo)"

require_clean_repo "$REPO_ROOT" "pi-harness"
require_remote "$REPO_ROOT" origin "$PI_HARNESS_URL" "pi-harness"
require_branch "$REPO_ROOT" "$PI_HARNESS_BRANCH" "pi-harness"

if ((CHECK_ONLY)); then
  require_synced_ref "$REPO_ROOT" origin "$PI_HARNESS_BRANCH" "pi-harness"
else
  harness_updated=0
  if update_repo "$REPO_ROOT" origin "$PI_HARNESS_BRANCH" "pi-harness"; then
    :
  else
    status=$?
    [[ "$status" == 10 ]] || exit "$status"
    harness_updated=1
  fi
  if ((harness_updated)) && ((AFTER_SELF_UPDATE == 0)); then
    note "Restarting the updated setup script"
    exec "$SCRIPT_PATH" --after-self-update "${ORIGINAL_ARGS[@]}"
  fi
fi

if [[ ! -e "$PI_SOURCE_ROOT" ]]; then
  ((CHECK_ONLY)) && fail "Pi fork checkout is missing: $PI_SOURCE_ROOT"
  note "Cloning Pi fork"
  git clone --branch "$PI_FORK_BRANCH" --single-branch "$PI_FORK_URL" "$PI_SOURCE_ROOT"
elif [[ ! -d "$PI_SOURCE_ROOT/.git" ]]; then
  fail "Pi checkout path exists but is not a Git repository: $PI_SOURCE_ROOT"
fi

require_clean_repo "$PI_SOURCE_ROOT" "Pi fork"
require_remote "$PI_SOURCE_ROOT" origin "$PI_FORK_URL" "Pi fork"
require_branch "$PI_SOURCE_ROOT" "$PI_FORK_BRANCH" "Pi fork"

upstream_url="$(git -C "$PI_SOURCE_ROOT" remote get-url upstream 2>/dev/null || true)"
if [[ -z "$upstream_url" ]]; then
  ((CHECK_ONLY)) && fail "Pi fork is missing the upstream remote; run without --check to add it"
  note "Adding canonical Pi upstream remote"
  git -C "$PI_SOURCE_ROOT" remote add upstream "$PI_UPSTREAM_URL"
elif [[ "$upstream_url" != "$PI_UPSTREAM_URL" ]]; then
  fail "Pi fork remote 'upstream' is $upstream_url; expected $PI_UPSTREAM_URL"
fi

if ((CHECK_ONLY)); then
  require_synced_ref "$PI_SOURCE_ROOT" origin "$PI_FORK_BRANCH" "Pi fork"
else
  if update_repo "$PI_SOURCE_ROOT" origin "$PI_FORK_BRANCH" "Pi fork"; then
    :
  else
    status=$?
    [[ "$status" == 10 ]] || exit "$status"
  fi
fi

git -C "$PI_SOURCE_ROOT" merge-base --is-ancestor "$PI_FORK_PATCH_COMMIT" HEAD 2>/dev/null || \
  fail "Pi fork HEAD does not contain required patch commit $PI_FORK_PATCH_COMMIT"

if ((CHECK_ONLY)); then
  PI_SOURCE_ROOT="$PI_SOURCE_ROOT" "$SCRIPT_DIR/check-pi-drift.sh"
  echo "Pi fork setup check passed."
  exit 0
fi

if ((SKIP_DEPS == 0)); then
  note "Installing pinned Pi workspace dependencies"
  (cd "$PI_SOURCE_ROOT" && npm ci --ignore-scripts)
else
  for tool in tsc shx; do
    [[ -x "$PI_SOURCE_ROOT/node_modules/.bin/$tool" ]] || \
      fail "--skip-deps requested but Pi dependencies are missing: node_modules/.bin/$tool is not installed; run without --skip-deps"
  done
fi

note "Hydrating generated Pi model data"
npm --prefix "$PI_SOURCE_ROOT" run hydrate:model-data

note "Building Pi from committed sources"
npm --prefix "$PI_SOURCE_ROOT" run build:offline

require_clean_repo "$PI_SOURCE_ROOT" "Pi fork after build"
pi_bin_entry="$(node -p 'const b = require(process.argv[1]).bin; (typeof b === "string" ? b : b?.pi) ?? ""' "$PI_SOURCE_ROOT/packages/coding-agent/package.json")"
[[ -n "$pi_bin_entry" ]] || fail "coding-agent package.json does not declare a pi bin entry"
[[ -x "$PI_SOURCE_ROOT/packages/coding-agent/$pi_bin_entry" ]] || fail "Pi build did not produce an executable coding-agent $pi_bin_entry"

note "Linking Pi into the active npm prefix"
(cd "$PI_SOURCE_ROOT/packages/coding-agent" && npm link)
hash -r

note "Verifying linked fork"
PI_SOURCE_ROOT="$PI_SOURCE_ROOT" "$SCRIPT_DIR/check-pi-drift.sh"

echo "Pi fork setup complete."
