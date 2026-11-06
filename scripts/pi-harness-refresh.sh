#!/usr/bin/env bash
set -euo pipefail

# Unified, state-aware refresh entry point for the version-controlled Pi harness
# extensions, Agent Skills copies, and the linked Pi fork source runtime.

SCRIPT_PATH="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/$(basename -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname -- "$SCRIPT_PATH")"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
ORIGINAL_ARGS=("$@")

EXTENSIONS_HELPER="${PI_HARNESS_REFRESH_EXTENSIONS_HELPER:-$SCRIPT_DIR/install-project-extensions.sh}"
SKILLS_HELPER="${PI_HARNESS_REFRESH_SKILLS_HELPER:-$SCRIPT_DIR/install-agent-skills.sh}"
PI_HELPER="${PI_HARNESS_REFRESH_PI_HELPER:-$SCRIPT_DIR/setup-pi-fork.sh}"
CHECK_HELPER="${PI_HARNESS_REFRESH_CHECK_HELPER:-$SCRIPT_DIR/check-all.sh}"
DRIFT_HELPER="${PI_HARNESS_REFRESH_DRIFT_HELPER:-$SCRIPT_DIR/check-pi-drift.sh}"

DO_EXTENSIONS=0
DO_SKILLS=0
DO_PI=0
DO_CHECK=1
DRY_RUN=0
SKIP_PI_DEPS=0
SELECTION_EXPLICIT=0
CHECK_ONLY=0
NO_CHECK_REQUESTED=0

usage() {
  cat <<'EOF'
Usage: scripts/pi-harness-refresh.sh [workflow flags] [options]

Refresh and verify this repository's Pi extensions, Agent Skills copies, and
optionally the linked Pi fork source runtime. With no workflow flags, the
safe routine default is --extensions --skills --check. Updating Pi is opt-in.

Workflow flags (may be combined):
  --extensions     Reconcile global Pi settings with harness extensions and packages.
  --skills         Refresh ~/.claude/skills and ~/.agents/skills from skills/skills/.
  --pi             Fast-forward, build, link, and verify the configured Pi fork.
  --all            Select --extensions, --skills, and --pi.
  --check-only     Run the full repository gate without refreshing resources.

Options:
  --check          Run scripts/check-all.sh after refresh (default).
  --no-check       Skip scripts/check-all.sh.
  --skip-pi-deps   Pass --skip-deps to setup-pi-fork.sh; requires --pi.
  --dry-run        Validate current state and print mutating/full-check commands.
  -h, --help       Show this help.

Examples:
  scripts/pi-harness-refresh.sh
  scripts/pi-harness-refresh.sh --extensions
  scripts/pi-harness-refresh.sh --skills --no-check
  scripts/pi-harness-refresh.sh --pi
  scripts/pi-harness-refresh.sh --all --skip-pi-deps
  scripts/pi-harness-refresh.sh --check-only

The --pi workflow requires clean pi-harness and Pi-fork worktrees because the
lower-level setup script only performs safe fast-forward updates. After a
successful refresh, restart Pi or run /reload to activate resource changes.
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage_error() {
  printf 'ERROR: %s\n\n' "$*" >&2
  usage >&2
  exit 2
}

note() {
  printf '== %s\n' "$*"
}

state() {
  printf 'state - %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found on PATH: $1"
}

require_node_pi_support() {
  local probe_dir probe node_version
  probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-node-ts-probe.XXXXXX")" || \
    fail "could not create a temporary Node TypeScript capability probe"
  probe="$probe_dir/probe.ts"
  printf '%s\n' 'const supported: boolean = true;' 'if (!supported) process.exit(1);' > "$probe"

  if ! node "$probe" >/dev/null 2>&1; then
    node_version="$(node --version 2>/dev/null || printf 'unknown')"
    rm -f -- "$probe" || true
    rmdir -- "$probe_dir" 2>/dev/null || true
    fail "Node $node_version cannot execute .ts scripts directly; switch to Node 22 LTS with 'nvm install 22.22.2 && nvm use 22.22.2', then rerun this refresh without --skip-pi-deps"
  fi

  rm -f -- "$probe"
  rmdir -- "$probe_dir" 2>/dev/null || true
  if ! node -e 'const zlib = require("node:zlib"); process.exit(typeof zlib.createZstdDecompress === "function" ? 0 : 1)' >/dev/null 2>&1; then
    node_version="$(node --version 2>/dev/null || printf 'unknown')"
    fail "Node $node_version lacks zlib.createZstdDecompress required by Pi; switch to Node 22 LTS with 'nvm install 22.22.2 && nvm use 22.22.2', then rerun this refresh without --skip-pi-deps"
  fi
}

require_helper() {
  local label="$1"
  local helper="$2"
  [[ -f "$helper" ]] || fail "$label helper is missing: $helper"
  [[ -x "$helper" ]] || fail "$label helper is not executable: $helper"
}

run_step() {
  local label="$1"
  shift
  if ((DRY_RUN)); then
    printf 'dry-run - %s:' "$label"
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  note "$label"
  "$@"
}

while (($#)); do
  case "$1" in
    --extensions)
      DO_EXTENSIONS=1
      SELECTION_EXPLICIT=1
      ;;
    --skills)
      DO_SKILLS=1
      SELECTION_EXPLICIT=1
      ;;
    --pi)
      DO_PI=1
      SELECTION_EXPLICIT=1
      ;;
    --all)
      DO_EXTENSIONS=1
      DO_SKILLS=1
      DO_PI=1
      SELECTION_EXPLICIT=1
      ;;
    --check)
      DO_CHECK=1
      ;;
    --no-check)
      DO_CHECK=0
      NO_CHECK_REQUESTED=1
      ;;
    --check-only)
      CHECK_ONLY=1
      SELECTION_EXPLICIT=1
      DO_CHECK=1
      ;;
    --skip-pi-deps)
      SKIP_PI_DEPS=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage_error "unknown option: $1"
      ;;
  esac
  shift
done

if ((SELECTION_EXPLICIT == 0)); then
  DO_EXTENSIONS=1
  DO_SKILLS=1
fi
if ((CHECK_ONLY)) && ((DO_EXTENSIONS || DO_SKILLS || DO_PI)); then
  usage_error "--check-only cannot be combined with refresh workflow flags"
fi
if ((CHECK_ONLY && NO_CHECK_REQUESTED)); then
  usage_error "--check-only cannot be combined with --no-check"
fi
if ((SKIP_PI_DEPS)) && ((DO_PI == 0)); then
  usage_error "--skip-pi-deps requires --pi or --all"
fi
if ((DO_EXTENSIONS == 0 && DO_SKILLS == 0 && DO_PI == 0 && DO_CHECK == 0)); then
  usage_error "no refresh workflow or check was selected"
fi

cd "$REPO_ROOT"
state "repository root: $REPO_ROOT"

RESUME_HEAD="${PI_HARNESS_REFRESH_RESUME_HEAD:-}"
unset PI_HARNESS_REFRESH_RESUME_HEAD || true
RESUMED_AFTER_PI_UPDATE=0
if [[ -n "$RESUME_HEAD" ]]; then
  require_command git
  current_head="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  [[ -n "$current_head" && "$current_head" == "$RESUME_HEAD" ]] || \
    fail "invalid Pi-refresh resume state: expected harness HEAD $RESUME_HEAD, found ${current_head:-unknown}"
  RESUMED_AFTER_PI_UPDATE=1
  state "resumed from updated harness HEAD $current_head"
fi

if ((DO_EXTENSIONS)); then
  require_helper "extension refresh" "$EXTENSIONS_HELPER"
  require_command node
  [[ -d "$REPO_ROOT/.pi/extensions" ]] || fail "missing harness extension directory: $REPO_ROOT/.pi/extensions"
  [[ -d "$REPO_ROOT/extensions" ]] || fail "missing repository extension directory: $REPO_ROOT/extensions"
  [[ -f "$REPO_ROOT/extensions/hermes-advisory/index.ts" ]] || \
    fail "missing required Hermes advisory extension: $REPO_ROOT/extensions/hermes-advisory/index.ts"

  agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  settings_file="$agent_dir/settings.json"
  if [[ -e "$settings_file" ]]; then
    [[ -f "$settings_file" ]] || fail "Pi settings path is not a regular file: $settings_file"
    node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$settings_file" 2>/dev/null || \
      fail "Pi settings file is not valid JSON; refusing to let the installer replace it: $settings_file"
  fi
  extension_state="$(node - "$settings_file" "$REPO_ROOT/.pi/extensions" "$REPO_ROOT/extensions" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [settingsFile, ...wanted] = process.argv.slice(2);
let configuredExtensions = [];
if (fs.existsSync(settingsFile)) {
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  configuredExtensions = Array.isArray(settings.extensions)
    ? settings.extensions.map((entry) => path.resolve(String(entry)))
    : [];
}
const missingExtensions = wanted
  .map((entry) => path.resolve(entry))
  .filter((entry) => !configuredExtensions.includes(entry));
const missingCount = missingExtensions.length;
process.stdout.write(missingCount === 0 ? "configured" : `needs reconciliation (${missingCount} resource(s) missing)`);
NODE
)"
  state "extensions: $extension_state"
fi

if ((DO_SKILLS)); then
  require_helper "skill refresh" "$SKILLS_HELPER"
  skill_source="${PI_SKILLS_SOURCE_DIR:-$REPO_ROOT/skills/skills}"
  claude_skills_dir="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
  agent_skills_dir="${AGENT_SKILLS_DIR:-$HOME/.agents/skills}"
  [[ -d "$skill_source" ]] || fail "skill source directory does not exist: $skill_source"
  for destination in "$claude_skills_dir" "$agent_skills_dir"; do
    [[ -n "$destination" && "$destination" != "/" ]] || fail "refusing unsafe skill destination: ${destination:-<empty>}"
  done
  mapfile -t skill_dirs < <(
    find "$skill_source" -mindepth 1 -maxdepth 1 -type d -exec sh -c '
      for dir do
        [ -f "$dir/SKILL.md" ] && printf "%s\n" "$dir"
      done
    ' sh {} + | sort
  )
  ((${#skill_dirs[@]} > 0)) || fail "no immediate skill directories containing SKILL.md were found in $skill_source"
  claude_installed=0
  agent_installed=0
  if [[ -d "$claude_skills_dir" ]]; then
    claude_installed="$(find "$claude_skills_dir" -mindepth 2 -maxdepth 2 -type f -name SKILL.md | wc -l)"
  fi
  if [[ -d "$agent_skills_dir" ]]; then
    agent_installed="$(find "$agent_skills_dir" -mindepth 2 -maxdepth 2 -type f -name SKILL.md | wc -l)"
  fi
  state "skills: ${#skill_dirs[@]} source; $claude_installed Claude and $agent_installed agent copies currently present"
fi

if ((DO_PI)); then
  require_helper "Pi refresh" "$PI_HELPER"
  for command in git node npm df readlink mktemp; do
    require_command "$command"
  done
  require_node_pi_support
  pi_config="${PI_SETUP_CONFIG_FILE:-$REPO_ROOT/config/pi-fork.env}"
  [[ -f "$pi_config" ]] || fail "missing Pi fork config: $pi_config"
  # shellcheck disable=SC1090
  source "$pi_config"
  : "${PI_HARNESS_URL:?PI_HARNESS_URL must be set in the Pi fork config}"
  : "${PI_HARNESS_BRANCH:?PI_HARNESS_BRANCH must be set in the Pi fork config}"
  : "${PI_FORK_URL:?PI_FORK_URL must be set in the Pi fork config}"
  : "${PI_FORK_BRANCH:?PI_FORK_BRANCH must be set in the Pi fork config}"
  : "${PI_SOURCE_ROOT_DEFAULT:?PI_SOURCE_ROOT_DEFAULT must be set in the Pi fork config}"

  harness_git_root="$(git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "$harness_git_root" ]] || fail "pi-harness is not a Git checkout: $REPO_ROOT"
  harness_git_root="$(cd "$harness_git_root" && pwd -P)"
  [[ "$harness_git_root" == "$REPO_ROOT" ]] || fail "script root $REPO_ROOT is not the pi-harness Git root ($harness_git_root)"
  harness_branch="$(git -C "$REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  [[ "$harness_branch" == "$PI_HARNESS_BRANCH" ]] || \
    fail "pi-harness branch is ${harness_branch:-detached}; expected $PI_HARNESS_BRANCH"
  harness_origin="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
  [[ "$harness_origin" == "$PI_HARNESS_URL" ]] || \
    fail "pi-harness origin is ${harness_origin:-missing}; expected $PI_HARNESS_URL"
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]] || \
    fail "--pi requires a clean pi-harness worktree; commit or remove local changes first"

  resolved_pi_source="${PI_SOURCE_ROOT:-$REPO_ROOT/$PI_SOURCE_ROOT_DEFAULT}"
  if [[ -e "$resolved_pi_source" ]]; then
    [[ -d "$resolved_pi_source/.git" ]] || fail "configured Pi source path exists but is not a Git checkout: $resolved_pi_source"
    resolved_pi_source="$(cd "$resolved_pi_source" && pwd -P)"
    pi_branch="$(git -C "$resolved_pi_source" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
    [[ "$pi_branch" == "$PI_FORK_BRANCH" ]] || \
      fail "Pi fork branch is ${pi_branch:-detached}; expected $PI_FORK_BRANCH"
    pi_origin="$(git -C "$resolved_pi_source" remote get-url origin 2>/dev/null || true)"
    [[ "$pi_origin" == "$PI_FORK_URL" ]] || \
      fail "Pi fork origin is ${pi_origin:-missing}; expected $PI_FORK_URL"
    [[ -z "$(git -C "$resolved_pi_source" status --porcelain --untracked-files=normal)" ]] || \
      fail "--pi requires a clean Pi-fork worktree: $resolved_pi_source"
    state "Pi fork: clean $pi_branch checkout at $resolved_pi_source"
  else
    state "Pi fork: checkout missing at $resolved_pi_source; setup helper will clone it"
  fi
  state "pi-harness: clean $harness_branch checkout with expected origin"
fi

if ((DO_CHECK)); then
  require_helper "full check" "$CHECK_HELPER"
  require_helper "Pi drift check" "$DRIFT_HELPER"
  if ((DO_PI == 0 || RESUMED_AFTER_PI_UPDATE)); then
    if drift_output="$($DRIFT_HELPER 2>&1)"; then
      state "active Pi runtime: linked source fork has no detected drift"
    else
      printf '%s\n' "$drift_output" >&2
      if ((DO_PI == 0)); then
        fail "active Pi runtime is not ready for check-all; rerun with --pi to reconcile it, or use --no-check intentionally"
      fi
      fail "Pi setup completed but the resumed harness still detects runtime drift"
    fi
  else
    state "active Pi runtime: will be reconciled before check-all"
  fi
fi

if ((DO_PI)); then
  if ((RESUMED_AFTER_PI_UPDATE)); then
    state "Pi refresh helper already completed before harness self-restart"
  else
    pi_args=()
    if ((SKIP_PI_DEPS)); then
      pi_args+=(--skip-deps)
    fi
    old_head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
    run_step "Refresh linked Pi source fork" "$PI_HELPER" "${pi_args[@]}"
    if ((DRY_RUN == 0)); then
      new_head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
      if [[ "$new_head" != "$old_head" ]]; then
        note "Harness advanced from $old_head to $new_head; restarting the updated refresh script"
        export PI_HARNESS_REFRESH_RESUME_HEAD="$new_head"
        exec "$SCRIPT_PATH" "${ORIGINAL_ARGS[@]}"
      fi
    fi
  fi
fi

if ((DO_EXTENSIONS)); then
  run_step "Refresh harness extension settings" "$EXTENSIONS_HELPER"
fi

if ((DO_CHECK)); then
  run_step "Run full pi-harness verification" "$CHECK_HELPER"
fi

# Copy skills only after the selected verification gate passes. --no-check is an
# explicit request to bypass that deployment ordering.
if ((DO_SKILLS)); then
  run_step "Refresh installed Agent Skills copies" "$SKILLS_HELPER"
fi

if ((DRY_RUN)); then
  printf '\nDry run complete; no mutating refresh or full-check command was executed.\n'
else
  printf '\nPi harness refresh complete.\n'
  if ((DO_PI)); then
    printf 'Restart Pi to use the newly linked runtime.\n'
  elif ((DO_EXTENSIONS || DO_SKILLS)); then
    printf 'Run /reload in Pi, or restart Pi, to activate resource changes.\n'
  fi
fi
