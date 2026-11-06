#!/usr/bin/env bash
# Update every fleet machine's pi-harness checkout, Pi runtime linkage, AGENTS.md
# and managed Agent Skills from this machine's current revisions.
#
# Run from the pi-harness checkout that should be deployed. The driver resolves
# the authoritative targets here, preflights every host, stages only what a host
# needs, updates it with private backups and provider-free gates, then verifies
# each host again from a fresh SSH session.
#
# Guarantees: fast-forward only, no reset/stash/rebase/commit/push, no credential
# copying, no provider or model calls, no service or session restarts. Hosts that
# cannot reach GitHub receive a per-host git bundle instead.
set -uo pipefail
# Digest and sort order must not depend on this machine's locale.
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
PAYLOAD="$SCRIPT_DIR/fleet-host-update.sh"
CONFIG_FILE="$REPO_ROOT/config/pi-fork.env"
# Fleet targets are deployment-specific. Supply them with --hosts or PI_FLEET_HOSTS.
DEFAULT_HOSTS="${PI_FLEET_HOSTS:-}"

HOSTS="$DEFAULT_HOSTS"
if [[ -z "$HOSTS" ]]; then
  echo "no fleet hosts configured: pass --hosts or set PI_FLEET_HOSTS" >&2
  exit 2
fi
JOBS=4
PREFLIGHT_ONLY=0
SKIP_VERIFY=0
OFFLINE=0
AGENTS_FILE=""
EVIDENCE_DIR=""
RUN_ID=""

usage() {
  cat <<'EOF'
Usage: scripts/update-fleet.sh [options]

Deploy this machine's current pi-harness revision, Pi runtime linkage, AGENTS.md
and managed Agent Skills to every fleet host, then verify each host independently.

Options:
  --hosts "a b c"     Hosts to update (default: $PI_FLEET_HOSTS; SSH aliases
                      come from ~/.ssh/config)
  --jobs N            Hosts updated concurrently (default: 4)
  --preflight-only    Read-only inventory of every host; change nothing
  --skip-verify       Skip the independent read-back phase (not recommended)
  --offline           Trust cached origin/main instead of live GitHub lookups;
                      hosts that cannot fetch get a per-host bundle
  --agents-file PATH  Instructions to deploy (default: $PI_CODING_AGENT_DIR/AGENTS.md)
  --evidence-dir PATH Evidence directory (default: .pi/fleet-update-<run-id>)
  --run-id ID         Run identifier used in evidence paths and host backups
  -h, --help          Show this help

Examples:
  scripts/update-fleet.sh                       # update and verify the whole fleet
  scripts/update-fleet.sh --preflight-only      # inspect hosts without changing them
  scripts/update-fleet.sh --hosts host-00        # canary one host
  scripts/update-fleet.sh --offline             # when GitHub is unreachable here

What each host gets:
  - pi-harness fast-forwarded to this machine's origin/main (bundle when GitHub
    is unreachable from the host)
  - the Pi fork remote 'upstream' configured to config/pi-fork.env, and the Pi
    runtime updated/built/linked only when the host is not already at the target
  - harness extensions and managed Agent Skills refreshed from the host's own
    checkout, with pre-existing unmanaged skills preserved
  - ~/.pi/agent/AGENTS.md replaced atomically, preserving its file mode
  - a private backup (0700/0600) under ~/.pi/agent/backups/fleet-update-<run-id>-*

Gates on every host: tracked-clean worktrees, exact HEADs and tracking refs,
runtime identity, AGENTS.md hash/mode, skill manifests and content digests,
settings wiring, unchanged settings mode/model defaults, unchanged credential
fingerprints across the window, declared memory posture, scripts/check-project-setup.sh
and the offline extension RPC smoke. Model-backed checks are deliberately absent.

A Pi runtime update requires a clean worktree in ~/GatPi-Harness, including untracked
files, because it runs scripts/setup-pi-fork.sh. The harness-defaults runtime
artifact .pi/harness-defaults/posture.json is currently unignored, so it must be
added to .gitignore (or removed) before Pi updates can proceed on a host.

Exit status: 0 when every host passes, 1 when any host is blocked or fails.
EOF
}

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
note() { printf '== %s\n' "$*"; }

while (($#)); do
  case "$1" in
    --hosts) HOSTS="${2:-}"; [[ -n "$HOSTS" ]] || fail "--hosts needs a value"; shift 2 ;;
    --jobs) JOBS="${2:-}"; [[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || fail "--jobs needs a positive integer"; shift 2 ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --skip-verify) SKIP_VERIFY=1; shift ;;
    --offline) OFFLINE=1; shift ;;
    --agents-file) AGENTS_FILE="${2:-}"; [[ -n "$AGENTS_FILE" ]] || fail "--agents-file needs a value"; shift 2 ;;
    --evidence-dir) EVIDENCE_DIR="${2:-}"; [[ -n "$EVIDENCE_DIR" ]] || fail "--evidence-dir needs a value"; shift 2 ;;
    --run-id) RUN_ID="${2:-}"; [[ "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]] || fail "--run-id needs letters, digits, dot, underscore or dash"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'ERROR: unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

read -r -a HOST_LIST <<<"$HOSTS"
(( ${#HOST_LIST[@]} )) || fail "no hosts selected"

for command in git ssh node sha256sum tar awk; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done
[[ -f "$PAYLOAD" ]] || fail "missing remote payload: $PAYLOAD"
[[ -f "$CONFIG_FILE" ]] || fail "missing Pi fork config: $CONFIG_FILE"
# shellcheck disable=SC1090
source "$CONFIG_FILE"
: "${PI_HARNESS_URL:?}" "${PI_HARNESS_BRANCH:?}" "${PI_FORK_URL:?}" "${PI_FORK_BRANCH:?}"
: "${PI_FORK_PATCH_COMMIT:?}" "${PI_UPSTREAM_URL:?}" "${PI_SOURCE_ROOT_DEFAULT:?}"

RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
EVIDENCE_DIR="${EVIDENCE_DIR:-$REPO_ROOT/.pi/fleet-update-$RUN_ID}"
AGENTS_FILE="${AGENTS_FILE:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/AGENTS.md}"
PI_SOURCE_ROOT="${PI_SOURCE_ROOT:-$REPO_ROOT/$PI_SOURCE_ROOT_DEFAULT}"

# ------------------------------------------------------- resolve targets here
harness_root="$(git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null)" || fail "pi-harness is not a Git checkout: $REPO_ROOT"
[[ "$(cd "$harness_root" && pwd -P)" == "$REPO_ROOT" ]] || fail "script root $REPO_ROOT is not the pi-harness Git root"
[[ "$(git -C "$REPO_ROOT" branch --show-current)" == "$PI_HARNESS_BRANCH" ]] || fail "pi-harness branch is not $PI_HARNESS_BRANCH"
[[ "$(git -C "$REPO_ROOT" remote get-url origin)" == "$PI_HARNESS_URL" ]] || fail "pi-harness origin is not $PI_HARNESS_URL"
[[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ]] || fail "pi-harness has tracked modifications; commit or revert them first"
[[ -d "$PI_SOURCE_ROOT/.git" ]] || fail "missing Pi fork checkout: $PI_SOURCE_ROOT"
[[ "$(git -C "$PI_SOURCE_ROOT" branch --show-current)" == "$PI_FORK_BRANCH" ]] || fail "Pi fork branch is not $PI_FORK_BRANCH"
[[ "$(git -C "$PI_SOURCE_ROOT" remote get-url origin)" == "$PI_FORK_URL" ]] || fail "Pi fork origin is not $PI_FORK_URL"
[[ -z "$(git -C "$PI_SOURCE_ROOT" status --porcelain --untracked-files=no)" ]] || fail "Pi fork has tracked modifications; commit or revert them first"

harness_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
cached_harness="$(git -C "$REPO_ROOT" rev-parse "refs/remotes/origin/$PI_HARNESS_BRANCH" 2>/dev/null || true)"
pi_sha="$(git -C "$PI_SOURCE_ROOT" rev-parse HEAD)"
cached_pi="$(git -C "$PI_SOURCE_ROOT" rev-parse "refs/remotes/origin/$PI_FORK_BRANCH" 2>/dev/null || true)"
if ((OFFLINE)); then
  [[ "$harness_sha" == "$cached_harness" ]] || fail "pi-harness HEAD $harness_sha != cached origin/$PI_HARNESS_BRANCH $cached_harness"
  [[ "$pi_sha" == "$cached_pi" ]] || fail "Pi fork HEAD $pi_sha != cached origin/$PI_FORK_BRANCH $cached_pi"
  printf 'TARGET_SOURCE=cached-origin-refs\n'
else
  live_harness="$(git -C "$REPO_ROOT" ls-remote origin "refs/heads/$PI_HARNESS_BRANCH" 2>/dev/null | awk 'NR==1 {print $1}')"
  live_pi="$(git -C "$PI_SOURCE_ROOT" ls-remote origin "refs/heads/$PI_FORK_BRANCH" 2>/dev/null | awk 'NR==1 {print $1}')"
  [[ -n "$live_harness" ]] || fail "cannot read live origin/$PI_HARNESS_BRANCH; rerun with --offline if GitHub is unreachable"
  [[ -n "$live_pi" ]] || fail "cannot read live origin/$PI_FORK_BRANCH; rerun with --offline if GitHub is unreachable"
  [[ "$harness_sha" == "$live_harness" ]] || fail "pi-harness HEAD $harness_sha != live origin/$PI_HARNESS_BRANCH $live_harness; update this checkout first"
  [[ "$pi_sha" == "$live_pi" ]] || fail "Pi fork HEAD $pi_sha != live origin/$PI_FORK_BRANCH $live_pi; run scripts/setup-pi-fork.sh first"
  printf 'TARGET_SOURCE=live-origin\n'
fi

pi_version="$(node -p 'require(process.argv[1]).version' "$PI_SOURCE_ROOT/packages/coding-agent/package.json")" || fail "cannot read the Pi package version"
[[ -f "$AGENTS_FILE" ]] || fail "missing instructions file: $AGENTS_FILE"
[[ ! -L "$AGENTS_FILE" ]] || fail "instructions file is a symlink: $AGENTS_FILE"
agents_sha="$(sha256sum "$AGENTS_FILE" | awk '{print $1}')"
skills_source="$REPO_ROOT/skills/skills"
manifest_file="$skills_source/managed-skills.txt"
[[ -f "$manifest_file" ]] || fail "missing managed-skills manifest: $manifest_file"
skills_manifest_sha="$(sha256sum "$manifest_file" | awk '{print $1}')"
mapfile -t MANAGED_NAMES < <(awk 'NF && $1 !~ /^#/ {print $1}' "$manifest_file")
(( ${#MANAGED_NAMES[@]} )) || fail "managed-skills manifest is empty"
skills_count="${#MANAGED_NAMES[@]}"
skills_digest="$( ( cd "$skills_source" && for name in "${MANAGED_NAMES[@]}"; do find "$name" -type f -print0 | sort -z | xargs -0 sha256sum; done ) | LC_ALL=C sha256sum | awk '{print $1}')"

mkdir -p "$EVIDENCE_DIR"
chmod 700 "$EVIDENCE_DIR"
cp "$AGENTS_FILE" "$EVIDENCE_DIR/AGENTS.md.new"
chmod 600 "$EVIDENCE_DIR/AGENTS.md.new"

cat > "$EVIDENCE_DIR/targets.json" <<EOF
{
  "runId": "$RUN_ID",
  "generatedAt": "$(date -u +%FT%TZ)",
  "targetSource": "$([[ $OFFLINE == 1 ]] && echo cached-origin-refs || echo live-origin)",
  "harness": "$harness_sha",
  "pi": "$pi_sha",
  "piVersion": "$pi_version",
  "piPatchCommit": "$PI_FORK_PATCH_COMMIT",
  "piUpstreamUrl": "$PI_UPSTREAM_URL",
  "agentsSha256": "$agents_sha",
  "skillsManifestSha256": "$skills_manifest_sha",
  "managedSkillCount": "$skills_count",
  "managedContentDigest": "$skills_digest",
  "hosts": "$HOSTS"
}
EOF
chmod 600 "$EVIDENCE_DIR/targets.json"

printf 'RUN_ID=%s\nHARNESS_TARGET=%s\nPI_TARGET=%s\nPI_VERSION=%s\nAGENTS_SHA=%s\nSKILLS_MANIFEST_SHA=%s\nSKILLS_COUNT=%s\nSKILLS_DIGEST=%s\nEVIDENCE_DIR=%s\n' \
  "$RUN_ID" "$harness_sha" "$pi_sha" "$pi_version" "$agents_sha" "$skills_manifest_sha" "$skills_count" "$skills_digest" "$EVIDENCE_DIR"

# ------------------------------------------------------------ remote helpers
# Emit shell-quoted exports followed by the payload, then run it over SSH.
run_remote() {
  local h="$1" mode="$2"
  shift 2
  local -a pairs=("MODE=$mode" "PI_PATCH_COMMIT=$PI_FORK_PATCH_COMMIT" "PI_UPSTREAM_URL=$PI_UPSTREAM_URL" "$@")
  local pair
  {
    for pair in "${pairs[@]}"; do
      printf 'export %s=%q\n' "${pair%%=*}" "${pair#*=}"
    done
    cat "$PAYLOAD"
  } | ssh -o BatchMode=yes -o ConnectTimeout=20 "$h" bash -s
}

get_val() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  awk -v k="$key" 'index($0, k "=") == 1 { value = substr($0, length(k) + 2) } END { print value }' "$file"
}

phase_preflight() {
  note "Preflight ${#HOST_LIST[@]} host(s) (read-only on hosts)"
  local running=0 h
  for h in "${HOST_LIST[@]}"; do
    (
      run_remote "$h" preflight > "$EVIDENCE_DIR/$h-preflight.log" 2>&1
      echo "$?" > "$EVIDENCE_DIR/$h-preflight.exit"
    ) &
    running=$((running + 1))
    if (( running >= JOBS )); then wait -n || true; running=$((running - 1)); fi
  done
  wait
  for h in "${HOST_LIST[@]}"; do
    if [[ "$(cat "$EVIDENCE_DIR/$h-preflight.exit" 2>/dev/null)" != 0 ]]; then
      printf '%-8s PREFLIGHT_FAIL (%s)\n' "$h" "$(tail -1 "$EVIDENCE_DIR/$h-preflight.log" 2>/dev/null)"
      continue
    fi
    printf '%-8s host=%-12s harness=%.8s pi=%.8s launcher=%-7s shallow=%-5s untracked=%s\n' "$h" \
      "$(get_val "$EVIDENCE_DIR/$h-preflight.log" HOST)" \
      "$(get_val "$EVIDENCE_DIR/$h-preflight.log" HARNESS_HEAD)" \
      "$(get_val "$EVIDENCE_DIR/$h-preflight.log" PI_HEAD)" \
      "$(get_val "$EVIDENCE_DIR/$h-preflight.log" PI_LAUNCHER_KIND)" \
      "$(get_val "$EVIDENCE_DIR/$h-preflight.log" PI_SHALLOW)" \
      "$(get_val "$EVIDENCE_DIR/$h-preflight.log" HARNESS_UNTRACKED)"
  done
}

# Decide whether a host can be updated and whether it needs a bundle.
PLAN_STATE=ok
PLAN_REASON=""
PLAN_BUNDLE=""
plan_host() {
  local h="$1" log="$EVIDENCE_DIR/$h-preflight.log" blocked="$EVIDENCE_DIR/$h-plan.blocked"
  PLAN_STATE=ok
  PLAN_REASON=""
  PLAN_BUNDLE=""
  if [[ -f "$blocked" ]]; then
    PLAN_STATE=blocked
    PLAN_REASON="$(cat "$blocked")"
    return
  fi
  if [[ "$(cat "$EVIDENCE_DIR/$h-preflight.exit" 2>/dev/null)" != 0 ]]; then
    PLAN_STATE=blocked; PLAN_REASON="unreachable or preflight failed"; return
  fi
  [[ "$(get_val "$log" HARNESS_EXISTS)" == yes ]] || { PLAN_STATE=blocked; PLAN_REASON="missing pi-harness checkout"; return; }
  [[ "$(get_val "$log" PI_EXISTS)" == yes ]] || { PLAN_STATE=blocked; PLAN_REASON="missing Pi checkout"; return; }
  [[ "$(get_val "$log" HARNESS_ORIGIN)" == "$PI_HARNESS_URL" ]] || { PLAN_STATE=blocked; PLAN_REASON="harness origin mismatch"; return; }
  [[ "$(get_val "$log" PI_ORIGIN)" == "$PI_FORK_URL" ]] || { PLAN_STATE=blocked; PLAN_REASON="Pi origin mismatch"; return; }
  [[ "$(get_val "$log" HARNESS_BRANCH)" == main ]] || { PLAN_STATE=blocked; PLAN_REASON="harness branch is not main"; return; }
  [[ "$(get_val "$log" PI_BRANCH)" == main ]] || { PLAN_STATE=blocked; PLAN_REASON="Pi branch is not main"; return; }
  [[ "$(get_val "$log" HARNESS_TRACKED_DIRTY)" == 0 ]] || { PLAN_STATE=blocked; PLAN_REASON="harness has tracked modifications"; return; }
  [[ "$(get_val "$log" PI_TRACKED_DIRTY)" == 0 ]] || { PLAN_STATE=blocked; PLAN_REASON="Pi checkout has tracked modifications"; return; }
  [[ "$(get_val "$log" AGENTS_OVERRIDE)" == absent ]] || { PLAN_STATE=blocked; PLAN_REASON="AGENTS.override.md present"; return; }
  [[ "$(get_val "$log" AGENTS_LINK)" == regular ]] || { PLAN_STATE=blocked; PLAN_REASON="AGENTS.md is a symlink"; return; }

  local host_head
  host_head="$(get_val "$log" HARNESS_HEAD)"
  if [[ "$host_head" != "$harness_sha" ]]; then
    if ! git -C "$REPO_ROOT" merge-base --is-ancestor "$host_head" "$harness_sha" 2>/dev/null; then
      PLAN_STATE=blocked
      PLAN_REASON="harness HEAD $host_head is not an ancestor of $harness_sha (diverged)"
      return
    fi
    if [[ "$(get_val "$log" HARNESS_LSREMOTE)" != "$harness_sha" ]]; then
      PLAN_BUNDLE="$EVIDENCE_DIR/harness-$h.bundle"
    fi
  fi

  local pi_head shallow
  pi_head="$(get_val "$log" PI_HEAD)"
  shallow="$(get_val "$log" PI_SHALLOW)"
  if [[ "$pi_head" != "$pi_sha" && "$shallow" != false ]]; then
    PLAN_STATE=blocked
    PLAN_REASON="Pi checkout is a shallow clone; run 'git -C ~/pi fetch --unshallow' on the host first"
  fi
}

phase_stage() {
  note "Stage AGENTS.md and bundles"
  local running=0 h bundle
  for h in "${HOST_LIST[@]}"; do
    plan_host "$h"
    [[ "$PLAN_STATE" == ok ]] || continue
    (
      ssh -o BatchMode=yes -o ConnectTimeout=20 "$h" \
        "d=\"\$HOME/.pi-fleet-update-$RUN_ID\"; mkdir -p \"\$d\" && chmod 700 \"\$d\" && cat > \"\$d/AGENTS.md.new\" && chmod 600 \"\$d/AGENTS.md.new\"" \
        < "$EVIDENCE_DIR/AGENTS.md.new" > "$EVIDENCE_DIR/$h-stage.log" 2>&1
      echo "$?" > "$EVIDENCE_DIR/$h-stage.exit"
    ) &
    running=$((running + 1))
    if (( running >= JOBS )); then wait -n || true; running=$((running - 1)); fi
  done
  wait

  for h in "${HOST_LIST[@]}"; do
    plan_host "$h"
    [[ "$PLAN_STATE" == ok ]] || continue
    [[ "$(cat "$EVIDENCE_DIR/$h-stage.exit" 2>/dev/null)" == 0 ]] || { echo "AGENTS.md staging failed" > "$EVIDENCE_DIR/$h-plan.blocked"; continue; }
    bundle="$PLAN_BUNDLE"
    [[ -n "$bundle" ]] || continue
    local host_head
    host_head="$(get_val "$EVIDENCE_DIR/$h-preflight.log" HARNESS_HEAD)"
    note "Creating bundle for $h ($host_head -> $harness_sha)"
    if ! git -C "$REPO_ROOT" bundle create "$bundle" "^$host_head" "refs/heads/$PI_HARNESS_BRANCH" >/dev/null 2>&1; then
      echo "cannot create bundle" > "$EVIDENCE_DIR/$h-plan.blocked"; continue
    fi
    if ! git -C "$REPO_ROOT" bundle verify "$bundle" >/dev/null 2>&1; then
      echo "bundle verification failed" > "$EVIDENCE_DIR/$h-plan.blocked"; continue
    fi
    chmod 600 "$bundle"
    if ! ssh -o BatchMode=yes -o ConnectTimeout=20 "$h" \
      "d=\"\$HOME/.pi-fleet-update-$RUN_ID\"; cat > \"\$d/$(basename "$bundle")\" && chmod 600 \"\$d/$(basename "$bundle")\"" \
      < "$bundle" >> "$EVIDENCE_DIR/$h-stage.log" 2>&1; then
      echo "bundle staging failed" > "$EVIDENCE_DIR/$h-plan.blocked"
    fi
  done
}

phase_update() {
  note "Update ${#HOST_LIST[@]} host(s)"
  local running=0 h
  for h in "${HOST_LIST[@]}"; do
    plan_host "$h"
    if [[ "$PLAN_STATE" != ok ]]; then
      printf '%-8s SKIPPED (%s)\n' "$h" "$PLAN_REASON"
      printf 'blocked: %s\n' "$PLAN_REASON" > "$EVIDENCE_DIR/$h-update.exit"
      continue
    fi
    local -a extra=()
    if [[ -n "$PLAN_BUNDLE" ]]; then
      extra+=("BUNDLE_NAME=$(basename "$PLAN_BUNDLE")")
    fi
    (
      run_remote "$h" update \
        TARGET_HARNESS="$harness_sha" \
        TARGET_PI="$pi_sha" \
        TARGET_PI_VERSION="$pi_version" \
        AGENTS_SHA="$agents_sha" \
        SKILLS_MANIFEST_SHA="$skills_manifest_sha" \
        EXPECTED_SKILL_COUNT="$skills_count" \
        EXPECTED_MANAGED_DIGEST="$skills_digest" \
        RUN_ID="$RUN_ID" \
        "${extra[@]}" \
        > "$EVIDENCE_DIR/$h-update.log" 2>&1
      echo "$?" > "$EVIDENCE_DIR/$h-update.exit"
    ) &
    running=$((running + 1))
    if (( running >= JOBS )); then wait -n || true; running=$((running - 1)); fi
  done
  wait
  for h in "${HOST_LIST[@]}"; do
    if [[ "$(cat "$EVIDENCE_DIR/$h-update.exit" 2>/dev/null)" == 0 ]]; then
      printf '%-8s %s\n' "$h" "$(get_val "$EVIDENCE_DIR/$h-update.log" UPDATE_PASS)"
    else
      printf '%-8s FAILED: %s\n' "$h" "$(grep -E '^FAIL:|^TRAP_LINE' "$EVIDENCE_DIR/$h-update.log" 2>/dev/null | tail -1)"
    fi
  done
}

phase_verify() {
  note "Independent verification ${#HOST_LIST[@]} host(s)"
  local running=0 h
  for h in "${HOST_LIST[@]}"; do
    if [[ "$(cat "$EVIDENCE_DIR/$h-update.exit" 2>/dev/null)" != 0 ]]; then
      printf '%-8s SKIPPED (update did not pass)\n' "$h"
      continue
    fi
    local pre="$EVIDENCE_DIR/$h-preflight.log" upd="$EVIDENCE_DIR/$h-update.log"
    (
      run_remote "$h" verify \
        TARGET_HARNESS="$harness_sha" \
        TARGET_PI="$pi_sha" \
        TARGET_PI_VERSION="$pi_version" \
        AGENTS_SHA="$agents_sha" \
        SKILLS_MANIFEST_SHA="$skills_manifest_sha" \
        EXPECTED_MANAGED_DIGEST="$skills_digest" \
        EXPECTED_SKILL_COUNT="$skills_count" \
        AGENTS_MODE="$(get_val "$pre" AGENTS_MODE)" \
        SETTINGS_MODE="$(get_val "$pre" SETTINGS_MODE)" \
        AUTH_SHA="$(get_val "$upd" AUTH_BEFORE)" \
        MODELS_SHA="$(get_val "$upd" MODELS_BEFORE)" \
        MODEL_DEFAULTS="$(get_val "$pre" MODEL_DEFAULTS)" \
        UPDATE_END="$(get_val "$upd" UPDATE_END)" \
        CLAUDE_UNMANAGED_PRE="$(get_val "$upd" CLAUDE_UNMANAGED_PRE)" \
        AGENTS_UNMANAGED_PRE="$(get_val "$upd" AGENTS_UNMANAGED_PRE)" \
        PI_USER_PRE="$(get_val "$upd" PI_USER_PRE)" \
        SHADOW_PRE="$(get_val "$upd" SHADOW_BACKUPS_PRE)" \
        PI_LAUNCHER_KIND="$(get_val "$pre" PI_LAUNCHER_KIND)" \
        PI_SHALLOW="$(get_val "$pre" PI_SHALLOW)" \
        > "$EVIDENCE_DIR/$h-verify.log" 2>&1
      echo "$?" > "$EVIDENCE_DIR/$h-verify.exit"
    ) &
    running=$((running + 1))
    if (( running >= JOBS )); then wait -n || true; running=$((running - 1)); fi
  done
  wait
  for h in "${HOST_LIST[@]}"; do
    [[ -f "$EVIDENCE_DIR/$h-verify.exit" ]] || continue
    if [[ "$(cat "$EVIDENCE_DIR/$h-verify.exit")" == 0 ]]; then
      printf '%-8s %s checks\n' "$h" "$(grep -c '^ok - ' "$EVIDENCE_DIR/$h-verify.log")"
    else
      printf '%-8s VERIFY_FAILED: %s\n' "$h" "$(grep 'not ok' "$EVIDENCE_DIR/$h-verify.log" | paste -sd ';' -)"
    fi
  done
}

write_report() {
  local h status notes harness_before harness_after source pi_action pi_check
  local agents_action agents_mode claude_pair agent_pair setup_pair rpc_entries verify_checks
  : > "$EVIDENCE_DIR/summary.tsv"
  for h in "${HOST_LIST[@]}"; do
    local pre="$EVIDENCE_DIR/$h-preflight.log" upd="$EVIDENCE_DIR/$h-update.log" ver="$EVIDENCE_DIR/$h-verify.log"
    harness_before="$(get_val "$pre" HARNESS_HEAD)"; harness_after=""
    source=""; pi_action=""; pi_check=""; agents_action=""; agents_mode="$(get_val "$pre" AGENTS_MODE)"
    claude_pair="$(get_val "$pre" CLAUDE_SKILL_COUNT)/$(get_val "$pre" CLAUDE_SKILL_COUNT)"
    agent_pair="$(get_val "$pre" AGENT_SKILL_COUNT)/$(get_val "$pre" AGENT_SKILL_COUNT)"
    setup_pair=""; rpc_entries=""; verify_checks=0; notes=""
    if [[ "$(cat "$EVIDENCE_DIR/$h-preflight.exit" 2>/dev/null)" != 0 ]]; then
      status=BLOCKED
      notes="$(tail -1 "$pre" 2>/dev/null)"
    elif [[ "$(cat "$EVIDENCE_DIR/$h-update.exit" 2>/dev/null)" == blocked:* ]]; then
      status=BLOCKED
      notes="$(cat "$EVIDENCE_DIR/$h-update.exit")"
    elif [[ "$(cat "$EVIDENCE_DIR/$h-update.exit" 2>/dev/null)" != 0 ]]; then
      status=FAILED
      notes="$(grep -E '^FAIL:|^TRAP_LINE|parameter null' "$upd" 2>/dev/null | tail -1)"
    else
      harness_after="$(get_val "$upd" HARNESS_AFTER)"
      source="$(get_val "$upd" HARNESS_SOURCE)"
      pi_action="$(get_val "$upd" PI_ACTION)"; pi_check="$(get_val "$upd" PI_CHECK)"
      agents_action="$(get_val "$upd" AGENTS_ACTION)"; agents_mode="$(get_val "$upd" AGENTS_MODE_AFTER)"
      claude_pair="$(get_val "$upd" CLAUDE_PRE)/$(get_val "$upd" CLAUDE_POST)"
      agent_pair="$(get_val "$upd" AGENTS_PRE)/$(get_val "$upd" AGENTS_POST)"
      setup_pair="$(get_val "$upd" SETUP_CHECK_EXIT)/$(get_val "$upd" SETUP_CHECK_FAILURES)"
      rpc_entries="$(get_val "$upd" RPC_SMOKE_ENTRIES)"
      if ((SKIP_VERIFY)); then
        status=UPDATED; notes="verification skipped"
      elif [[ "$(cat "$EVIDENCE_DIR/$h-verify.exit" 2>/dev/null)" == 0 ]]; then
        status=PASS
        verify_checks="$(grep -c '^ok - ' "$ver")"
      else
        status=VERIFY_FAILED
        verify_checks="$(grep -c '^ok - ' "$ver")"
        notes="$(grep 'not ok' "$ver" | paste -sd ';' -)"
      fi
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${h:--}" "$(get_val "$pre" HOST)" "$(get_val "$pre" USER)" \
      "${harness_before:--}" "${harness_after:--}" "${source:--}" "${pi_action:--}" "${pi_check:--}" \
      "${agents_action:--}" "${agents_mode:--}" "${claude_pair:--}" "${agent_pair:--}" \
      "${setup_pair:--}" "${rpc_entries:--}" "$status" "${verify_checks:--}" "${notes:--}" \
      >> "$EVIDENCE_DIR/summary.tsv"
  done

  node - "$EVIDENCE_DIR/summary.tsv" "$EVIDENCE_DIR/summary.json" "$RUN_ID" "$harness_sha" "$pi_sha" "$pi_version" "$agents_sha" "$skills_manifest_sha" "$skills_count" "$skills_digest" <<'NODE'
const fs = require("node:fs");
const [tsvFile, jsonFile, runId, harness, pi, piVersion, agentsSha, manifestSha, skillCount, digest] = process.argv.slice(2);
const fields = ["alias", "hostname", "user", "harnessBefore", "harnessAfter", "harnessSource", "piAction", "piCheck", "agentsAction", "agentsMode", "claudeSkills", "agentSkills", "setupCheck", "rpcSmokeEntries", "status", "verifyChecks", "notes"];
const hosts = fs.readFileSync(tsvFile, "utf8").split("\n").filter(Boolean).map((line) => {
  const cells = line.split("\t");
  const entry = {};
  fields.forEach((field, index) => { entry[field] = cells[index] ?? ""; });
  return entry;
});
const summary = { runId, generatedAt: new Date().toISOString(), targets: { harness, pi, piVersion, agentsSha256: agentsSha, skillsManifestSha256: manifestSha, managedSkillCount: Number(skillCount), managedContentDigest: digest }, hosts };
fs.writeFileSync(jsonFile, `${JSON.stringify(summary, null, 2)}\n`);
const passing = hosts.filter((h) => h.status === "PASS" || h.status === "UPDATED").length;
console.log(`SUMMARY hosts=${hosts.length} pass=${passing} failed=${hosts.length - passing}`);
NODE

  {
    printf '# Fleet update — run %s\n\n' "$RUN_ID"
    printf 'Targets: pi-harness `%s`, Pi fork `%s` (v%s), AGENTS.md `%s`, %s managed skills (manifest `%s`, digest `%s`).\n\n' \
      "$harness_sha" "$pi_sha" "$pi_version" "$agents_sha" "$skills_count" "$skills_manifest_sha" "$skills_digest"
    printf '| Host | Machine | User | pi-harness | Source | Pi runtime | AGENTS.md | Skills claude/agent | Setup exit/failures | RPC entries | Checks | Status |\n'
    printf '|---|---|---|---|---|---|---|---|---|---|---|---|\n'
    local alias hostname user hb ha src pa pc aa am cl ag sr rpc st checks n
    while IFS=$'\t' read -r alias hostname user hb ha src pa pc aa am cl ag sr rpc st checks n; do
      printf '| %s | %s | %s | %s → %s | %s | %s (%s) | %s, mode %s | %s / %s | %s | %s | %s | %s |\n' \
        "$alias" "${hostname:-?}" "${user:-?}" "${hb:0:8}" "${ha:0:8}" "${src:-—}" "${pa:-—}" "${pc:-—}" \
        "${aa:-—}" "${am:-—}" "$cl" "$ag" "${sr:-—}" "${rpc:-—}" "${checks:-0}" "$st"
    done < "$EVIDENCE_DIR/summary.tsv"
    printf '\nEvidence: `%s` (targets.json, summary.json, per-host preflight/update/verify logs, staged AGENTS.md, bundles).\n' "$EVIDENCE_DIR"
    local bad
    bad="$(awk -F'\t' '$15 != "PASS" && $15 != "UPDATED" {printf "  %-8s %-14s %s\n", $1, $15, $17}' "$EVIDENCE_DIR/summary.tsv")"
    if [[ -n "$bad" ]]; then printf '\nNot passing:\n%s\n' "$bad"; fi
  } > "$EVIDENCE_DIR/RESULT.md"

  local alias hostname user hb ha src pa pc aa am cl ag sr rpc st checks n
  printf '\nhost      status   checks  harness           source  pi                        agents\n'
  while IFS=$'\t' read -r alias hostname user hb ha src pa pc aa am cl ag sr rpc st checks n; do
    printf '%-9s %-8s %-7s %-17s %-7s %-25s %s\n' "$alias" "$st" "${checks:-0}" "${hb:0:8}→${ha:0:8}" "${src:-—}" "${pa:-—}/${pc:-—}" "${aa:-—}"
  done < "$EVIDENCE_DIR/summary.tsv"

  local passing
  passing="$(awk -F'\t' '$15 == "PASS" || $15 == "UPDATED" {p++} END {print p+0}' "$EVIDENCE_DIR/summary.tsv")"
  printf '\nResult: %s/%s hosts passing. Evidence: %s\n' "$passing" "${#HOST_LIST[@]}" "$EVIDENCE_DIR"
  [[ "$passing" == "${#HOST_LIST[@]}" ]]
}

phase_preflight
if ((PREFLIGHT_ONLY)); then
  printf '\nPreflight complete (read-only on hosts). Evidence: %s\n' "$EVIDENCE_DIR"
  exit 0
fi
phase_stage
phase_update
if ((SKIP_VERIFY == 0)); then
  phase_verify
fi
if write_report; then exit 0; fi
exit 1
