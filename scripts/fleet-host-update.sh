#!/usr/bin/env bash
# Remote payload for scripts/update-fleet.sh. Runs ON a fleet host over SSH with
# target variables exported by the driver. It is never run locally.
#
# Modes:
#   preflight  read-only inventory of both checkouts, the Pi runtime and the
#              agent state; prints KEY=VALUE lines for the driver.
#   update     fast-forward pi-harness, reconcile the Pi runtime, refresh
#              extensions and managed skills, deploy AGENTS.md, then gate the
#              result. Fast-forward only: no reset, stash, rebase, commit, push,
#              credential copy, provider request or session restart.
#   verify     independent read-back against the pre-migration values.
set -uo pipefail

MODE="${MODE:-}"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

export PATH="$HOME/.local/bin:$PATH"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  source "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  nvm use default >/dev/null 2>&1 || true
fi
export GIT_OPTIONAL_LOCKS=0
export GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=15'
export PI_OFFLINE=1
# Digest comparison must not depend on host locale sort order.
export LC_ALL=C

agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
harness="${HARNESS_DIR:-$HOME/GatPi-Harness}"
pi_source="${PI_DIR:-$HOME/pi}"
pi_user_skills="$agent_dir/skills"
host="$(hostname)"
user="$(id -un)"
# Runtime state the harness itself writes inside its checkout. It is expected and
# is listed here rather than hidden with a local ignore rule, so a genuinely
# dirty worktree is still detected.
ALLOWED_UNTRACKED="${ALLOWED_UNTRACKED:-.pi/harness-defaults/posture.json}"

git_out() { git -C "$1" "${@:2}" 2>/dev/null || true; }
fingerprint() {
  if [[ -f "$1" ]]; then sha256sum "$1" | awk '{print $1}'; else echo absent; fi
}
file_mode() {
  if [[ -e "$1" ]]; then stat -c '%a' "$1"; else echo absent; fi
}
# Untracked entries that are not part of the documented runtime allowlist.
unexpected_untracked() {
  local repo="$1" entry
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    case ",$ALLOWED_UNTRACKED," in
      *",$entry,"*) continue ;;
    esac
    printf '%s\n' "$entry"
  done < <(git -C "$repo" status --porcelain --untracked-files=all 2>/dev/null | awk '/^\?\? /{print $2}')
}
untracked_list() {
  git -C "$1" status --porcelain --untracked-files=all 2>/dev/null | awk '/^\?\? /{print $2}' | sort | paste -sd, -
}
managed_names() {
  awk 'NF && $1 !~ /^#/ {print $1}' "$harness/skills/skills/managed-skills.txt"
}
managed_digest() {
  local root="$1"
  shift
  (
    cd "$root" || exit 1
    for name in "$@"; do
      find "$name" -type f -print0 | sort -z | xargs -0 sha256sum
    done
  ) | sha256sum | awk '{print $1}'
}
unmanaged_digest() {
  # Digest of the depth-2 skill directories that are not managed names. The
  # managed catalog may grow between runs, so the total directory count is not
  # invariant; what must stay unchanged is the set of user-owned directories.
  local root="$1"
  shift
  local -A managed=()
  local name dir
  for name in "$@"; do managed["$name"]=1; done
  (
    [[ -d "$root" ]] || exit 0
    cd "$root" || exit 1
    for dir in */; do
      dir="${dir%/}"
      [[ -f "$dir/SKILL.md" ]] || continue
      [[ -n "${managed[$dir]:-}" ]] && continue
      printf '%s\n' "$dir"
    done
  ) | LC_ALL=C sort | sha256sum | awk '{print $1}'
}
declared_name() {
  awk '/^name:[[:space:]]*/ { sub(/^name:[[:space:]]*/,""); print; exit }' "$1" |
    sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
settings_defaults() {
  node - "$agent_dir/settings.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
if (!fs.existsSync(file)) { console.log("absent"); process.exit(0); }
const s = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(JSON.stringify({ defaultProvider: s.defaultProvider, defaultModel: s.defaultModel, defaultThinkingLevel: s.defaultThinkingLevel }));
NODE
}

do_preflight() {
  printf 'HOST=%s\nUSER=%s\nHOME=%s\n' "$host" "$user" "$HOME"
  printf 'NODE=%s\n' "$(node --version 2>/dev/null || echo unknown)"
  printf 'DISK_AVAIL_KB=%s\n' "$(df -Pk "$HOME" | awk 'NR==2 {print $4}')"

  for label in harness pi; do
    local repo
    if [[ "$label" == harness ]]; then repo="$harness"; else repo="$pi_source"; fi
    local prefix
    prefix="$(printf '%s' "$label" | tr '[:lower:]' '[:upper:]')"
    if [[ ! -d "$repo/.git" ]]; then
      printf '%s_EXISTS=no\n' "$prefix"
      continue
    fi
    printf '%s_EXISTS=yes\n' "$prefix"
    printf '%s_HEAD=%s\n' "$prefix" "$(git_out "$repo" rev-parse HEAD)"
    printf '%s_ORIGIN=%s\n' "$prefix" "$(git_out "$repo" remote get-url origin)"
    printf '%s_BRANCH=%s\n' "$prefix" "$(git_out "$repo" branch --show-current)"
    printf '%s_TRACKED_DIRTY=%s\n' "$prefix" "$(git -C "$repo" status --porcelain --untracked-files=no 2>/dev/null | wc -l)"
    printf '%s_UNTRACKED=%s\n' "$prefix" "$(untracked_list "$repo")"
    printf '%s_SHALLOW=%s\n' "$prefix" "$(git_out "$repo" rev-parse --is-shallow-repository)"
    printf '%s_LSREMOTE=%s\n' "$prefix" "$(git -C "$repo" ls-remote origin refs/heads/main 2>&1 | awk 'NR==1 {print $1}')"
  done
  printf 'PI_UPSTREAM=%s\n' "$(git_out "$pi_source" remote get-url upstream)"
  printf 'PI_PATCH_PRESENT=%s\n' "$(git -C "$pi_source" cat-file -e "${PI_PATCH_COMMIT:?PI_PATCH_COMMIT must be set}^{commit}" 2>/dev/null && echo yes || echo no)"
  if [[ -d "$pi_source/packages/coding-agent/dist" ]]; then
    printf 'PI_DIST_FIX=%s\n' "$(grep -qF 'signalCode' "$pi_source/packages/coding-agent/dist/core/exec.js" 2>/dev/null && echo present || echo absent)"
  else
    printf 'PI_DIST_FIX=missing\n'
  fi
  printf 'PI_BIN=%s\n' "$(command -v pi || echo MISSING)"
  if command -v pi >/dev/null 2>&1; then
    local launcher
    launcher="$(command -v pi)"
    printf 'PI_LAUNCHER_PATH=%s\n' "$launcher"
    if [[ -L "$launcher" ]]; then
      printf 'PI_LAUNCHER_KIND=symlink\n'
    elif head -c2 "$launcher" 2>/dev/null | grep -q '#!'; then
      printf 'PI_LAUNCHER_KIND=script\n'
    else
      printf 'PI_LAUNCHER_KIND=regular\n'
    fi
    printf 'PI_VERSION=%s\n' "$(pi --version 2>/dev/null | tail -1)"
    printf 'PI_TARGET=%s\n' "$(readlink -f "$launcher")"
  else
    printf 'PI_LAUNCHER_KIND=missing\nPI_VERSION=missing\nPI_TARGET=missing\n'
  fi

  printf 'AGENTS_MODE=%s\n' "$(file_mode "$agent_dir/AGENTS.md")"
  printf 'AGENTS_SHA=%s\n' "$(fingerprint "$agent_dir/AGENTS.md")"
  printf 'AGENTS_OWNER=%s\n' "$([[ -f "$agent_dir/AGENTS.md" ]] && stat -c '%U' "$agent_dir/AGENTS.md" || echo absent)"
  printf 'AGENTS_OVERRIDE=%s\n' "$([[ -e "$agent_dir/AGENTS.override.md" ]] && echo present || echo absent)"
  printf 'AGENTS_LINK=%s\n' "$([[ -L "$agent_dir/AGENTS.md" ]] && echo symlink || echo regular)"
  printf 'SETTINGS_MODE=%s\nSETTINGS_SHA=%s\n' "$(file_mode "$agent_dir/settings.json")" "$(fingerprint "$agent_dir/settings.json")"
  printf 'MODELS_MODE=%s\nMODELS_SHA=%s\n' "$(file_mode "$agent_dir/models.json")" "$(fingerprint "$agent_dir/models.json")"
  printf 'AUTH_MODE=%s\nAUTH_SHA=%s\n' "$(file_mode "$agent_dir/auth.json")" "$(fingerprint "$agent_dir/auth.json")"
  printf 'MODEL_DEFAULTS=%s\n' "$(settings_defaults)"

  printf 'CLAUDE_SKILL_COUNT=%s\n' "$(find "$HOME/.claude/skills" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l)"
  printf 'CLAUDE_MANIFEST_SHA=%s\n' "$(fingerprint "$HOME/.claude/skills/.pi-harness-managed-skills")"
  printf 'AGENT_SKILL_COUNT=%s\n' "$(find "$HOME/.agents/skills" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l)"
  printf 'AGENT_MANIFEST_SHA=%s\n' "$(fingerprint "$HOME/.agents/skills/.pi-harness-managed-skills")"
  printf 'PI_USER_SKILL_COUNT=%s\n' "$(find "$pi_user_skills" -name SKILL.md 2>/dev/null | wc -l)"
  printf 'SHADOW_BACKUP_COUNT=%s\n' "$(find "$agent_dir/backups/skills-shadowed" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
  local shadows="" skill_md name
  if [[ -d "$pi_user_skills" ]]; then
    while IFS= read -r -d '' skill_md; do
      name="$(declared_name "$skill_md")"
      [[ -n "$name" ]] || continue
      if grep -qxF "$name" "$harness/skills/skills/managed-skills.txt" 2>/dev/null; then
        shadows="${shadows:+$shadows,}$name"
      fi
    done < <(find "$pi_user_skills" -name SKILL.md -print0 2>/dev/null)
  fi
  printf 'PI_USER_SHADOWS=%s\n' "$shadows"
  printf 'PREFLIGHT_OK=yes\n'
}

do_update() {
  : "${TARGET_HARNESS:?}" "${TARGET_PI:?}" "${TARGET_PI_VERSION:?}" "${AGENTS_SHA:?}" "${SKILLS_MANIFEST_SHA:?}" "${RUN_ID:?}"
  : "${EXPECTED_SKILL_COUNT:?}" "${EXPECTED_MANAGED_DIGEST:?}" "${PI_PATCH_COMMIT:?}" "${PI_UPSTREAM_URL:?}"
  BUNDLE="${BUNDLE:-}"
  if [[ -z "$BUNDLE" && -n "${BUNDLE_NAME:-}" ]]; then
    BUNDLE="$HOME/.pi-fleet-update-$RUN_ID/$BUNDLE_NAME"
  fi
  AGENTS_SRC="${AGENTS_SRC:-$HOME/.pi-fleet-update-$RUN_ID/AGENTS.md.new}"
  MIN_FREE_KB="${MIN_FREE_KB:-8388608}"

  printf 'UPDATE_START host=%s user=%s home=%s time=%s\n' "$host" "$user" "$HOME" "$(date -u +%FT%TZ)"

  # ------------------------------------------------------------ preconditions
  [[ -d "$harness/.git" ]] || fail "missing harness checkout at $harness"
  [[ -d "$pi_source/.git" ]] || fail "missing Pi checkout at $pi_source"
  # Origins are read from the harness's own config so a fork deployment does not
  # have to edit this payload.
  expected_harness_url="$(sed -n 's/^PI_HARNESS_URL="\(.*\)"$/\1/p' "$harness/config/pi-fork.env")"
  expected_pi_url="$(sed -n 's/^PI_FORK_URL="\(.*\)"$/\1/p' "$harness/config/pi-fork.env")"
  [[ -n "$expected_harness_url" ]] || fail "config/pi-fork.env does not define PI_HARNESS_URL"
  [[ -n "$expected_pi_url" ]] || fail "config/pi-fork.env does not define PI_FORK_URL"
  [[ "$(git_out "$harness" remote get-url origin)" == "$expected_harness_url" ]] || fail "harness origin mismatch"
  [[ "$(git_out "$pi_source" remote get-url origin)" == "$expected_pi_url" ]] || fail "Pi origin mismatch"
  [[ "$(git_out "$harness" branch --show-current)" == main ]] || fail "harness branch is not main"
  [[ "$(git_out "$pi_source" branch --show-current)" == main ]] || fail "Pi branch is not main"
  [[ "$(git -C "$harness" status --porcelain --untracked-files=no | wc -l)" == 0 ]] || fail "harness has tracked modifications"
  [[ "$(git -C "$pi_source" status --porcelain --untracked-files=no | wc -l)" == 0 ]] || fail "Pi checkout has tracked modifications"
  [[ -z "$(unexpected_untracked "$harness")" ]] || fail "harness has unexpected untracked entries: $(unexpected_untracked "$harness" | paste -sd, -)"
  [[ -z "$(unexpected_untracked "$pi_source")" ]] || fail "Pi checkout has unexpected untracked entries: $(unexpected_untracked "$pi_source" | paste -sd, -)"
  avail_kb="$(df -Pk "$HOME" | awk 'NR==2 {print $4}')"
  (( avail_kb > MIN_FREE_KB )) || fail "insufficient free space: ${avail_kb} KiB"
  [[ -f "$AGENTS_SRC" ]] || fail "missing staged AGENTS.md at $AGENTS_SRC"
  [[ "$(sha256sum "$AGENTS_SRC" | awk '{print $1}')" == "$AGENTS_SHA" ]] || fail "staged AGENTS.md hash mismatch"
  [[ ! -e "$agent_dir/AGENTS.override.md" ]] || fail "AGENTS.override.md present; refusing to deploy"
  [[ ! -L "$agent_dir/AGENTS.md" ]] || fail "AGENTS.md is a symlink; refusing to deploy"
  if [[ -f "$agent_dir/AGENTS.md" ]]; then
    [[ "$(stat -c '%U' "$agent_dir/AGENTS.md")" == "$user" ]] || fail "AGENTS.md is not owned by $user"
  fi
  if [[ -n "$BUNDLE" ]]; then
    [[ -f "$BUNDLE" ]] || fail "missing bundle $BUNDLE"
    git -C "$harness" bundle verify "$BUNDLE" >/dev/null 2>&1 || fail "bundle verification failed"
  fi

  # ------------------------------------------------------------------ backup
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$agent_dir/backups/fleet-update-$RUN_ID-$stamp"
  [[ ! -e "$backup" ]] || fail "backup path already exists: $backup"
  mkdir -p "$backup"
  chmod 700 "$backup"
  for name in settings.json models.json AGENTS.md; do
    if [[ -f "$agent_dir/$name" ]]; then
      cp -p "$agent_dir/$name" "$backup/$name"
      chmod 600 "$backup/$name"
    fi
  done
  skill_paths=()
  for d in .claude/skills .agents/skills; do
    if [[ -d "$HOME/$d" ]]; then skill_paths+=("$d"); fi
  done
  if [[ -d "$pi_user_skills" ]]; then skill_paths+=(".pi/agent/skills"); fi
  if (( ${#skill_paths[@]} )); then
    tar -czf "$backup/skills-before.tar.gz" -C "$HOME" "${skill_paths[@]}"
    chmod 600 "$backup/skills-before.tar.gz"
  fi
  git -C "$harness" rev-parse HEAD > "$backup/harness-before.sha"
  git -C "$pi_source" rev-parse HEAD > "$backup/pi-before.sha"
  chmod 600 "$backup/harness-before.sha" "$backup/pi-before.sha"
  printf 'BACKUP=%s\n' "$backup"

  auth_before="$(fingerprint "$agent_dir/auth.json")"
  models_before="$(fingerprint "$agent_dir/models.json")"
  agents_before="$(fingerprint "$agent_dir/AGENTS.md")"
  agents_mode_before="$(file_mode "$agent_dir/AGENTS.md")"
  settings_mode_before="$(file_mode "$agent_dir/settings.json")"
  model_defaults_before="$(settings_defaults)"
  printf '%s\n' "$model_defaults_before" > "$backup/model-defaults-before.txt"
  chmod 600 "$backup/model-defaults-before.txt"

  claude_pre="$(find "$HOME/.claude/skills" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l)"
  agents_pre="$(find "$HOME/.agents/skills" -mindepth 2 -maxdepth 2 -name SKILL.md 2>/dev/null | wc -l)"
  pi_user_pre="$(find "$pi_user_skills" -name SKILL.md 2>/dev/null | wc -l)"
  shadow_pre="$(find "$agent_dir/backups/skills-shadowed" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
  # The pre-refresh catalog is the host's current manifest, so a directory that
  # already carries a name the new catalog manages counts as user-owned now.
  mapfile -t managed_pre < <(managed_names)
  claude_unmanaged_pre="$(unmanaged_digest "$HOME/.claude/skills" "${managed_pre[@]}")"
  agents_unmanaged_pre="$(unmanaged_digest "$HOME/.agents/skills" "${managed_pre[@]}")"
  printf 'CLAUDE_PRE=%s\nAGENTS_PRE=%s\nPI_USER_PRE=%s\nSHADOW_BACKUPS_PRE=%s\n' "$claude_pre" "$agents_pre" "$pi_user_pre" "$shadow_pre"
  printf 'CLAUDE_UNMANAGED_PRE=%s\nAGENTS_UNMANAGED_PRE=%s\n' "$claude_unmanaged_pre" "$agents_unmanaged_pre"
  printf 'AUTH_BEFORE=%s\nMODELS_BEFORE=%s\nAGENTS_BEFORE=%s\nAGENTS_MODE=%s\nSETTINGS_MODE=%s\nMODEL_DEFAULTS_BEFORE=%s\n' \
    "$auth_before" "$models_before" "$agents_before" "$agents_mode_before" "$settings_mode_before" "$model_defaults_before"

  # --------------------------------------------------------- harness update
  harness_before="$(git_out "$harness" rev-parse HEAD)"
  if [[ "$harness_before" != "$TARGET_HARNESS" ]]; then
    if [[ -n "$BUNDLE" ]]; then
      git -C "$harness" fetch --quiet "$BUNDLE" main
      incoming="$(git -C "$harness" rev-parse FETCH_HEAD)"
      [[ "$incoming" == "$TARGET_HARNESS" ]] || fail "bundle tip $incoming != target"
      git -C "$harness" merge-base --is-ancestor HEAD "$TARGET_HARNESS" || fail "harness HEAD is not an ancestor of target; refusing to merge"
      git -C "$harness" merge --ff-only "$TARGET_HARNESS"
      # This host cannot verify GitHub's host key, so the bundle is the only
      # source of truth. Reconcile the tracking ref to the target SHA verified
      # on the driver machine and by bundle verification above.
      git -C "$harness" update-ref refs/remotes/origin/main "$TARGET_HARNESS"
      printf 'HARNESS_SOURCE=bundle\nTRACKING_REF_RECONCILED=%s\n' "$TARGET_HARNESS"
    else
      git -C "$harness" fetch --quiet origin main
      live="$(git -C "$harness" ls-remote origin refs/heads/main | awk 'NR==1 {print $1}')"
      [[ "$live" == "$TARGET_HARNESS" ]] || fail "live origin/main $live != target"
      [[ "$(git_out "$harness" rev-parse refs/remotes/origin/main)" == "$TARGET_HARNESS" ]] || fail "cached origin/main does not match target after fetch"
      git -C "$harness" merge-base --is-ancestor HEAD "$TARGET_HARNESS" || fail "harness HEAD is not an ancestor of target; refusing to merge"
      git -C "$harness" merge --ff-only "$TARGET_HARNESS"
      printf 'HARNESS_SOURCE=origin\n'
    fi
  else
    printf 'HARNESS_SOURCE=already-current\n'
    if [[ -z "$BUNDLE" ]]; then
      # Refresh the tracking ref so a stale cache cannot fail the gate below.
      set +e
      git -C "$harness" fetch --quiet origin main >/dev/null 2>&1
      set -e
    fi
  fi
  [[ "$(git_out "$harness" rev-parse HEAD)" == "$TARGET_HARNESS" ]] || fail "harness not at target after update"
  printf 'HARNESS_BEFORE=%s\nHARNESS_AFTER=%s\n' "$harness_before" "$(git_out "$harness" rev-parse HEAD)"

  # ------------------------------------------------------ Pi upstream remote
  upstream_url="$(git_out "$pi_source" remote get-url upstream)"
  if [[ -z "$upstream_url" ]]; then
    git -C "$pi_source" remote add upstream "$PI_UPSTREAM_URL"
    git -C "$pi_source" config remote.upstream.fetch '+refs/heads/*:refs/remotes/upstream/*'
    git -C "$pi_source" remote set-url --push upstream "$PI_UPSTREAM_URL"
    printf 'PI_UPSTREAM=added\n'
  elif [[ "$upstream_url" != "$PI_UPSTREAM_URL" ]]; then
    fail "Pi remote upstream is $upstream_url; expected $PI_UPSTREAM_URL"
  else
    git -C "$pi_source" config remote.upstream.fetch '+refs/heads/*:refs/remotes/upstream/*'
    printf 'PI_UPSTREAM=present\n'
  fi
  set +e
  git -C "$pi_source" fetch --no-tags upstream main > "$backup/upstream-fetch.log" 2>&1
  upstream_fetch=$?
  set -e
  if (( upstream_fetch == 0 )); then
    printf 'PI_UPSTREAM_FETCH=ok\n'
  else
    printf 'PI_UPSTREAM_FETCH=failed (remote configured; fetch blocked: %s)\n' "$(head -1 "$backup/upstream-fetch.log")"
  fi

  # ------------------------------------------------------- Pi runtime update
  cd "$harness"
  shallow="$(git_out "$pi_source" rev-parse --is-shallow-repository)"
  launcher_kind=regular
  if [[ -L "$(command -v pi)" ]]; then launcher_kind=symlink; elif head -c2 "$(command -v pi)" 2>/dev/null | grep -q '#!'; then launcher_kind=script; fi
  upstream_present=no
  if git -C "$pi_source" remote get-url upstream >/dev/null 2>&1; then upstream_present=yes; fi
  pi_head_before="$(git_out "$pi_source" rev-parse HEAD)"
  wrapper_pi_path() { printf '%s/pi' "$(dirname "$(readlink -f "$(command -v node)")")"; }

  # Prove the observable runtime identity: version, source package version, the
  # launcher resolving to this checkout's built bundle, the fork's exec fix, the
  # cached tracking ref and the patch commit. Used when setup-pi-fork.sh --check
  # cannot run because the worktree is not pristine.
  pi_runtime_identity() {
    local pi_version source_version linked_pi
    pi_version="$(pi --version 2>/dev/null | tail -1)"
    [[ "$pi_version" == "$TARGET_PI_VERSION" ]] || fail "pi --version is $pi_version; expected $TARGET_PI_VERSION"
    source_version="$(node -p 'require(process.argv[1]).version' "$pi_source/packages/coding-agent/package.json")"
    [[ "$source_version" == "$TARGET_PI_VERSION" ]] || fail "source package version $source_version != $TARGET_PI_VERSION"
    if [[ "$launcher_kind" == symlink ]]; then
      linked_pi="$(readlink -f "$(command -v pi)")"
    else
      linked_pi="$(wrapper_pi_path)"
      [[ -e "$linked_pi" ]] || fail "wrapper launcher target missing: $linked_pi"
    fi
    [[ "$(readlink -f "$linked_pi")" == "$pi_source/packages/coding-agent/dist/bundle/cli.js" ]] || fail "linked pi does not resolve to the fork build"
    grep -qF 'signalCode' "$pi_source/packages/coding-agent/dist/core/exec.js" || fail "dist build lacks the fork's exec fix"
    [[ "$(git_out "$pi_source" rev-parse refs/remotes/origin/main)" == "$TARGET_PI" ]] || fail "cached Pi origin/main is not at the target"
    if git -C "$pi_source" cat-file -e "$PI_PATCH_COMMIT^{commit}" 2>/dev/null; then
      patch_state=present
    else
      # A shallow single-branch clone cannot contain the patch commit's ancestry;
      # the build markers above already prove the fork content is deployed.
      [[ "$shallow" == true ]] || fail "Pi fork patch commit $PI_PATCH_COMMIT is absent from a full clone"
      patch_state=absent-shallow-clone
    fi
    printf 'RUNTIME_IDENTITY=ok\nPI_SHALLOW=%s\nPI_WRAPPER_LAUNCHER=%s\nPI_PATCH_COMMIT_PRESENT=%s\n' "$shallow" "$launcher_kind" "$patch_state"
  }

  if [[ "$pi_head_before" != "$TARGET_PI" ]]; then
    [[ "$shallow" == false ]] || fail "Pi checkout is a shallow clone; run 'git -C $pi_source fetch --unshallow' first so the update can be verified"
    if [[ -n "$(untracked_list "$harness")" ]]; then
      fail "harness has untracked runtime state ($(untracked_list "$harness")); scripts/setup-pi-fork.sh requires a clean worktree — add the entry to .gitignore or remove the file first"
    fi
    scripts/setup-pi-fork.sh > "$backup/pi-setup.log" 2>&1 || { tail -n 40 "$backup/pi-setup.log" >&2; fail "Pi fork setup failed"; }
    [[ "$(git_out "$pi_source" rev-parse HEAD)" == "$TARGET_PI" ]] || fail "Pi HEAD $(git_out "$pi_source" rev-parse HEAD) != target after setup"
    printf 'PI_ACTION=updated\nPI_CHECK=setup-pi-fork\n'
  elif [[ "$shallow" == false && "$launcher_kind" == symlink && "$upstream_present" == yes ]]; then
    if scripts/setup-pi-fork.sh --check > "$backup/pi-check.log" 2>&1; then
      printf 'PI_ACTION=already-current\nPI_CHECK=setup-pi-fork-check\n'
    elif [[ -z "$(unexpected_untracked "$harness")" ]] && [[ "$(git -C "$harness" status --porcelain --untracked-files=no | wc -l)" == 0 ]]; then
      # The only obstacle is the allowlisted runtime artifact that the fork setup
      # script treats as dirt; verify the same runtime identity directly instead.
      pi_runtime_identity
      printf 'PI_ACTION=already-current\nPI_CHECK=runtime-identity (setup-pi-fork --check blocked only by %s)\n' "$ALLOWED_UNTRACKED"
    else
      cat "$backup/pi-check.log" >&2
      fail "Pi fork check failed"
    fi
  else
    # Shallow single-branch clone and/or wrapper launcher: the drift guard cannot
    # pass structurally, so prove the equivalent observable runtime identity.
    pi_runtime_identity
    printf 'PI_ACTION=already-current\nPI_CHECK=runtime-identity (deferred-structural-wrapper-or-shallow-clone)\n'
  fi
  printf 'PI_HEAD=%s\n' "$(git_out "$pi_source" rev-parse HEAD)"

  # ------------------------------------------- extensions + managed skills
  scripts/pi-harness-refresh.sh --extensions --skills --no-check > "$backup/refresh.log" 2>&1 || { tail -n 40 "$backup/refresh.log" >&2; fail "harness refresh failed"; }
  printf 'REFRESH=ok\n'
  grep -E 'shadow|would shadow|moved' "$backup/refresh.log" > "$backup/shadow-actions.log" 2>/dev/null || true
  printf 'SHADOW_ACTIONS=%s\n' "$(wc -l < "$backup/shadow-actions.log")"

  # --------------------------------------------------------- AGENTS.md deploy
  dest="$agent_dir/AGENTS.md"
  mkdir -p "$agent_dir"
  if [[ -f "$dest" ]] && [[ "$(fingerprint "$dest")" == "$AGENTS_SHA" ]]; then
    agents_action=already-current
  else
    if [[ -f "$dest" ]]; then
      [[ "$(fingerprint "$dest")" == "$agents_before" ]] || fail "AGENTS.md changed concurrently; refusing to overwrite"
      target_mode="$agents_mode_before"
    else
      target_mode=644
    fi
    tmp="$agent_dir/.AGENTS.md.fleet-$RUN_ID.tmp"
    cp "$AGENTS_SRC" "$tmp"
    chmod "$target_mode" "$tmp"
    [[ "$(fingerprint "$tmp")" == "$AGENTS_SHA" ]] || fail "staged copy hash mismatch before rename"
    mv -f "$tmp" "$dest"
    agents_action=updated
  fi
  [[ "$(fingerprint "$dest")" == "$AGENTS_SHA" ]] || fail "AGENTS.md hash mismatch after deploy"
  [[ "$(file_mode "$dest")" == "$agents_mode_before" ]] || fail "AGENTS.md mode changed"
  printf 'AGENTS_ACTION=%s\nAGENTS_SHA=%s\nAGENTS_MODE_AFTER=%s\n' "$agents_action" "$AGENTS_SHA" "$(file_mode "$dest")"

  # ------------------------------------------------------------- in-session gates
  for repo in "$harness" "$pi_source"; do
    git -C "$repo" diff --check
    git -C "$repo" diff --cached --check
    [[ "$(git -C "$repo" status --porcelain --untracked-files=no | wc -l)" == 0 ]] || fail "tracked modifications after update: $repo"
  done
  [[ -z "$(unexpected_untracked "$harness")" ]] || fail "unexpected untracked entries after update: $(unexpected_untracked "$harness" | paste -sd, -)"
  [[ -z "$(unexpected_untracked "$pi_source")" ]] || fail "unexpected untracked entries after update: $(unexpected_untracked "$pi_source" | paste -sd, -)"
  [[ "$(git_out "$harness" rev-parse HEAD)" == "$TARGET_HARNESS" ]] || fail "final harness HEAD mismatch"
  [[ "$(git_out "$pi_source" rev-parse HEAD)" == "$TARGET_PI" ]] || fail "final Pi HEAD mismatch"
  [[ "$(git_out "$harness" rev-parse refs/remotes/origin/main)" == "$TARGET_HARNESS" ]] || fail "harness tracking ref not reconciled"

  pi_version="$(pi --version 2>/dev/null | tail -1)"
  [[ "$pi_version" == "$TARGET_PI_VERSION" ]] || fail "pi --version is $pi_version; expected $TARGET_PI_VERSION"
  pi_real="$(readlink -f "$(command -v pi)")"
  if [[ "$launcher_kind" == symlink ]]; then
    [[ "$pi_real" == "$pi_source/packages/coding-agent/dist/bundle/cli.js" ]] || fail "pi does not resolve to the linked fork build: $pi_real"
  fi

  manifest_local="$(fingerprint "$harness/skills/skills/managed-skills.txt")"
  [[ "$manifest_local" == "$SKILLS_MANIFEST_SHA" ]] || fail "harness managed-skills manifest hash mismatch"
  mapfile -t managed < <(managed_names)
  [[ "${#managed[@]}" == "$EXPECTED_SKILL_COUNT" ]] || fail "managed skill count is ${#managed[@]}; expected $EXPECTED_SKILL_COUNT"
  source_digest="$(managed_digest "$harness/skills/skills" "${managed[@]}")"
  [[ "$source_digest" == "$EXPECTED_MANAGED_DIGEST" ]] || fail "source managed content digest $source_digest != expected"
  for d in .claude/skills .agents/skills; do
    root="$HOME/$d"
    [[ -d "$root" ]] || fail "skills destination missing: $root"
    [[ "$(fingerprint "$root/.pi-harness-managed-skills")" == "$SKILLS_MANIFEST_SHA" ]] || fail "destination manifest mismatch in $root"
    for name in "${managed[@]}"; do
      [[ -f "$root/$name/SKILL.md" ]] || fail "managed skill missing in $root: $name"
    done
    dest_digest="$(managed_digest "$root" "${managed[@]}")"
    [[ "$dest_digest" == "$EXPECTED_MANAGED_DIGEST" ]] || fail "managed skill content mismatch in $root"
    printf 'SKILLS_%s_DIGEST=%s\n' "$d" "$dest_digest"
  done
  printf 'SKILLS_SOURCE_DIGEST=%s\nSKILLS_MANIFEST_SHA=%s\n' "$source_digest" "$manifest_local"

  claude_post="$(find "$HOME/.claude/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l)"
  agents_post="$(find "$HOME/.agents/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l)"
  pi_user_post="$(find "$pi_user_skills" -name SKILL.md 2>/dev/null | wc -l)"
  shadow_post="$(find "$agent_dir/backups/skills-shadowed" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
  mapfile -t managed_post < <(managed_names)
  claude_unmanaged_post="$(unmanaged_digest "$HOME/.claude/skills" "${managed_post[@]}")"
  agents_unmanaged_post="$(unmanaged_digest "$HOME/.agents/skills" "${managed_post[@]}")"
  [[ "$claude_unmanaged_post" == "$claude_unmanaged_pre" ]] || fail "unmanaged Claude skill directories changed: $claude_unmanaged_pre -> $claude_unmanaged_post (a managed name may have displaced a user directory)"
  [[ "$agents_unmanaged_post" == "$agents_unmanaged_pre" ]] || fail "unmanaged agent skill directories changed: $agents_unmanaged_pre -> $agents_unmanaged_post (a managed name may have displaced a user directory)"
  [[ "$pi_user_post" == "$pi_user_pre" ]] || fail "Pi user skill root changed: $pi_user_pre -> $pi_user_post"
  printf 'CLAUDE_POST=%s\nAGENTS_POST=%s\nPI_USER_POST=%s\nSHADOW_BACKUPS_POST=%s\n' "$claude_post" "$agents_post" "$pi_user_post" "$shadow_post"
  printf 'CLAUDE_UNMANAGED_POST=%s\nAGENTS_UNMANAGED_POST=%s\n' "$claude_unmanaged_post" "$agents_unmanaged_post"

  shadow_leaks=0
  if [[ -d "$pi_user_skills" ]]; then
    declare -A managed_set=()
    for name in "${managed[@]}"; do managed_set["$name"]=1; done
    while IFS= read -r -d '' skill_md; do
      name="$(declared_name "$skill_md")"
      [[ -n "$name" ]] || continue
      if [[ -n "${managed_set[$name]:-}" ]]; then
        printf 'SHADOW_LEAK=%s|%s\n' "$skill_md" "$name" >&2
        shadow_leaks=$((shadow_leaks + 1))
      fi
    done < <(find "$pi_user_skills" -name SKILL.md -print0 2>/dev/null)
  fi
  [[ "$shadow_leaks" == 0 ]] || fail "$shadow_leaks managed skill name(s) still declared in the Pi user skill root"
  printf 'SHADOW_LEAKS=0\n'

  node - "$harness" > "$backup/posture-check.log" 2>&1 <<'NODE' || { cat "$backup/posture-check.log" >&2; fail "memory posture check failed"; }
const path = require("node:path");
const harness = process.argv[2];
const { readProjectMemoryPosture, applyProjectMemoryPosture } = require(path.join(harness, "src/project-memory-posture.js"));
const posture = readProjectMemoryPosture({ root: harness });
if (!posture || posture.present !== true || posture.invalid !== false) throw new Error(`posture not present/valid: ${JSON.stringify(posture)}`);
const applied = applyProjectMemoryPosture({ PI_PROJECT_MEMORY_STAGE: "M0", PI_PROJECT_MEMORY_AUTO_SAVE: "0" }, { root: harness });
if (applied.env.PI_PROJECT_MEMORY_STAGE !== "M1" || applied.env.PI_PROJECT_MEMORY_AUTO_SAVE !== "1") throw new Error(`posture did not outrank stale exports: ${JSON.stringify(applied.env)}`);
console.log("POSTURE=ok");
NODE
  cat "$backup/posture-check.log"

  node - "$agent_dir/settings.json" "$harness" > "$backup/settings-check.log" 2>&1 <<'NODE' || { cat "$backup/settings-check.log" >&2; fail "settings wiring check failed"; }
const fs = require("node:fs"), path = require("node:path");
const [settingsFile, harness] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const extensions = (s.extensions || []).map((v) => path.resolve(String(v)));
for (const wanted of [path.join(harness, "extensions/00-harness-defaults/index.ts"), path.join(harness, ".pi/extensions"), path.join(harness, "extensions")]) {
  if (!extensions.includes(wanted)) throw new Error(`missing extension path ${wanted}`);
}
console.log("SETTINGS_WIRING=ok");
NODE
  cat "$backup/settings-check.log"

  [[ "$(file_mode "$agent_dir/settings.json")" == "$settings_mode_before" ]] || fail "settings.json mode changed: $settings_mode_before -> $(file_mode "$agent_dir/settings.json")"

  model_defaults_after="$(settings_defaults)"
  [[ "$model_defaults_after" == "$model_defaults_before" ]] || fail "model defaults changed: $model_defaults_before -> $model_defaults_after"
  printf 'MODEL_DEFAULTS_UNCHANGED=yes\n'

  [[ "$(fingerprint "$agent_dir/auth.json")" == "$auth_before" ]] || fail "auth.json fingerprint changed"
  [[ "$(fingerprint "$agent_dir/models.json")" == "$models_before" ]] || fail "models.json fingerprint changed"
  printf 'AUTH_UNCHANGED=yes\nMODELS_UNCHANGED=yes\n'

  # ------------------------------------------------- provider-free health gate
  set +e
  scripts/check-project-setup.sh > "$backup/setup-check.log" 2>&1
  setup_status=$?
  set -e
  setup_failures="$(awk '/^not ok - / { sub(/^not ok - /, ""); print }' "$backup/setup-check.log" | paste -sd ';' -)"
  printf 'SETUP_CHECK_EXIT=%s\nSETUP_CHECK_FAILURES=%s\n' "$setup_status" "${setup_failures:-none}"
  if [[ -n "$setup_failures" ]]; then
    unexpected="$(printf '%s\n' "$setup_failures" | tr ';' '\n' | grep -v '^hermes CLI is available$' || true)"
    if [[ -n "$unexpected" ]]; then
      tail -n 40 "$backup/setup-check.log" >&2
      fail "setup checks failed beyond the known missing external adapters: $(printf '%s' "$unexpected" | paste -sd ';' -)"
    fi
    printf 'SETUP_CHECK_ADAPTER_GAPS=hermes CLI absent (pre-existing, outside this migration)\n'
  fi

  smoke_root="$(mktemp -d "${TMPDIR:-/tmp}/pi-fleet-update-smoke.XXXXXX")"
  mkdir -p "$smoke_root/agent" "$smoke_root/work" "$smoke_root/tmp"
  mapfile -t entries < <(node -e 'const path=require("node:path"); const root=process.argv[1]; const runner=require(path.join(root,"scripts/extension-smoke-runner.js")); for (const entry of runner.discoverExtensionEntries(root)) console.log(path.join(root, entry));' "$harness")
  (( ${#entries[@]} > 0 )) || fail "no extension entries discovered"
  set +e
  ( cd "$smoke_root/work" && PI_CODING_AGENT_DIR="$smoke_root/agent" TMPDIR="$smoke_root/tmp" node "$harness/scripts/extension-smoke-runner.js" rpc "${entries[@]}" ) > "$backup/rpc-smoke.log" 2>&1
  smoke_status=$?
  set -e
  if (( smoke_status != 0 )); then
    tail -n 40 "$backup/rpc-smoke.log" >&2
    printf 'SMOKE_FIXTURE_PRESERVED=%s\n' "$smoke_root" >&2
    fail "extension RPC smoke failed (exit $smoke_status)"
  fi
  rm -rf -- "$smoke_root"
  printf 'RPC_SMOKE_EXIT=0\nRPC_SMOKE_ENTRIES=%s\n' "${#entries[@]}"

  printf 'FINAL_HARNESS=%s\nFINAL_PI=%s\nFINAL_AGENTS_SHA=%s\nPI_VERSION=%s\nPI_TARGET=%s\nUPDATE_END=%s\n' \
    "$(git_out "$harness" rev-parse HEAD)" "$(git_out "$pi_source" rev-parse HEAD)" \
    "$(fingerprint "$dest")" "$pi_version" "$pi_real" "$(date -u +%FT%TZ)"
  printf 'UPDATE_PASS=%s time=%s\n' "$host" "$(date -u +%FT%TZ)"
}

do_verify() {
  : "${TARGET_HARNESS:?}" "${TARGET_PI:?}" "${TARGET_PI_VERSION:?}" "${AGENTS_SHA:?}" "${AGENTS_MODE:?}"
  : "${SETTINGS_MODE:?}" "${AUTH_SHA:?}" "${MODELS_SHA:?}" "${MODEL_DEFAULTS:?}" "${UPDATE_END:?}"
  : "${SKILLS_MANIFEST_SHA:?}" "${EXPECTED_MANAGED_DIGEST:?}" "${EXPECTED_SKILL_COUNT:?}"
  : "${CLAUDE_UNMANAGED_PRE:?}" "${AGENTS_UNMANAGED_PRE:?}" "${PI_USER_PRE:?}" "${SHADOW_PRE:?}"
  : "${PI_LAUNCHER_KIND:?}" "${PI_UPSTREAM_URL:?}" "${PI_PATCH_COMMIT:?}"

  failures=0
  check() {
    local name="$1" actual="$2" expected="$3"
    if [[ "$actual" == "$expected" ]]; then
      printf 'ok - %s = %s\n' "$name" "$actual"
    else
      printf 'not ok - %s: got %s expected %s\n' "$name" "${actual:-<empty>}" "${expected:-<empty>}" >&2
      failures=$((failures + 1))
    fi
  }

  printf 'VERIFY host=%s user=%s time=%s\n' "$host" "$user" "$(date -u +%FT%TZ)"

  check harness_head "$(git_out "$harness" rev-parse HEAD)" "$TARGET_HARNESS"
  check harness_tracking "$(git_out "$harness" rev-parse refs/remotes/origin/main)" "$TARGET_HARNESS"
  check harness_branch "$(git_out "$harness" branch --show-current)" main
  check harness_tracked_clean "$(git -C "$harness" status --porcelain --untracked-files=no | wc -l)" 0
  check harness_unexpected_untracked "$(unexpected_untracked "$harness" | paste -sd, -)" ""
  check pi_head "$(git_out "$pi_source" rev-parse HEAD)" "$TARGET_PI"
  check pi_tracking "$(git_out "$pi_source" rev-parse refs/remotes/origin/main)" "$TARGET_PI"
  check pi_branch "$(git_out "$pi_source" branch --show-current)" main
  check pi_tracked_clean "$(git -C "$pi_source" status --porcelain --untracked-files=no | wc -l)" 0
  check pi_upstream_url "$(git_out "$pi_source" remote get-url upstream)" "$PI_UPSTREAM_URL"
  if [[ "${PI_SHALLOW:-false}" == true ]]; then
    printf 'skip - pi_patch_commit: shallow clone cannot carry the patch ancestry; runtime identity is proven by the built bundle markers\n'
  else
    check pi_patch_commit "$(git -C "$pi_source" cat-file -e "$PI_PATCH_COMMIT^{commit}" 2>/dev/null && echo present || echo absent)" present
  fi

  check agents_sha "$(fingerprint "$agent_dir/AGENTS.md")" "$AGENTS_SHA"
  check agents_mode "$(file_mode "$agent_dir/AGENTS.md")" "$AGENTS_MODE"
  check agents_regular "$([[ -L "$agent_dir/AGENTS.md" ]] && echo symlink || echo regular)" regular
  check agents_override "$([[ -e "$agent_dir/AGENTS.override.md" ]] && echo present || echo absent)" absent
  check settings_mode "$(file_mode "$agent_dir/settings.json")" "$SETTINGS_MODE"

  # Credential files are never read or written by the migration; only their
  # fingerprint across the update window is checked. A later write is reported as
  # a client refresh when the file mtime postdates the recorded update end.
  auth_now="$(fingerprint "$agent_dir/auth.json")"
  if [[ "$auth_now" == "$AUTH_SHA" ]]; then
    printf 'ok - auth_fingerprint_window = %s\n' "$auth_now"
  else
    auth_mtime="$(stat -c '%Y' "$agent_dir/auth.json" 2>/dev/null || echo 0)"
    update_end_epoch="$(date -u -d "$UPDATE_END" +%s 2>/dev/null || echo 0)"
    if (( auth_mtime > update_end_epoch )); then
      printf 'ok - auth_fingerprint_window: unchanged across the update window; refreshed after it (mtime %s UTC)\n' "$(date -u -d "@$auth_mtime" +%FT%TZ)"
    else
      printf 'not ok - auth_fingerprint_window: got %s expected %s (mtime predates update end)\n' "$auth_now" "$AUTH_SHA" >&2
      failures=$((failures + 1))
    fi
  fi
  check models_fingerprint "$(fingerprint "$agent_dir/models.json")" "$MODELS_SHA"
  check model_defaults "$(settings_defaults)" "$MODEL_DEFAULTS"

  check settings_wiring "$(node - "$agent_dir/settings.json" "$harness" <<'NODE'
const fs = require("node:fs"), path = require("node:path");
const [settingsFile, harness] = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
const extensions = (s.extensions || []).map((v) => path.resolve(String(v)));
const wanted = [path.join(harness, "extensions/00-harness-defaults/index.ts"), path.join(harness, ".pi/extensions"), path.join(harness, "extensions")];
const missing = wanted.filter((w) => !extensions.includes(w));
console.log(missing.length === 0 ? "ok" : `missing=${missing.join(",")}`);
NODE
)" ok

  check pi_version "$(pi --version 2>/dev/null | tail -1)" "$TARGET_PI_VERSION"
  if [[ "$PI_LAUNCHER_KIND" == symlink ]]; then
    check pi_link_target "$(readlink -f "$(command -v pi)")" "$pi_source/packages/coding-agent/dist/bundle/cli.js"
  else
    linked_pi="$(dirname "$(readlink -f "$(command -v node)")")/pi"
    check pi_wrapper_exec_target "$(readlink -f "$linked_pi")" "$pi_source/packages/coding-agent/dist/bundle/cli.js"
  fi
  check pi_build_fix "$(grep -qF 'signalCode' "$pi_source/packages/coding-agent/dist/core/exec.js" && echo present || echo absent)" present

  check posture "$(node - "$harness" <<'NODE'
const path = require("node:path");
const { readProjectMemoryPosture, applyProjectMemoryPosture } = require(path.join(process.argv[2], "src/project-memory-posture.js"));
const posture = readProjectMemoryPosture({ root: process.argv[2] });
if (!posture.present || posture.invalid) { console.log(`invalid:${posture.reason || "absent"}`); process.exit(0); }
const applied = applyProjectMemoryPosture({ PI_PROJECT_MEMORY_STAGE: "M0", PI_PROJECT_MEMORY_AUTO_SAVE: "0" }, { root: process.argv[2] });
console.log(applied.env.PI_PROJECT_MEMORY_STAGE === "M1" && applied.env.PI_PROJECT_MEMORY_AUTO_SAVE === "1" ? "ok" : "not-applied");
NODE
)" ok

  local posture_file="$harness/.pi/harness-defaults/posture.json"
  if [[ -f "$posture_file" ]]; then
    check posture_mode "$(file_mode "$posture_file")" 600
    check posture_metadata_only "$(node - "$posture_file" <<'NODE'
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[2], "utf8");
let value;
try { value = JSON.parse(text); } catch { console.log("invalid-json"); process.exit(0); }
const keys = Object.keys(value).sort().join(",");
const expected = "applied,at,conflicts,declared,effectiveStage,operatorAutomatic,preserved,requestedStage,schemaVersion,source,stageAuthority";
const secretish = /(sk-[A-Za-z0-9]|rt\.[0-9]|Bearer |password|api[_-]?key|refresh_token|access_token)/i.test(text);
console.log(keys === expected && !secretish ? "ok" : `keys=${keys} secretish=${secretish}`);
NODE
)" ok
  else
    check posture_record "$([[ -e "$posture_file" ]] && echo present || echo absent)" present
  fi

  manifest_sha="$(fingerprint "$harness/skills/skills/managed-skills.txt")"
  check skills_manifest_source "$manifest_sha" "$SKILLS_MANIFEST_SHA"
  mapfile -t managed < <(managed_names)
  check managed_count "${#managed[@]}" "$EXPECTED_SKILL_COUNT"
  check managed_digest_source "$(managed_digest "$harness/skills/skills" "${managed[@]}")" "$EXPECTED_MANAGED_DIGEST"

  local spec label rest rel pre root missing
  for spec in "claude:.claude/skills:$CLAUDE_UNMANAGED_PRE" "agents:.agents/skills:$AGENTS_UNMANAGED_PRE"; do
    label="${spec%%:*}"; rest="${spec#*:}"
    rel="${rest%%:*}"; pre="${rest##*:}"
    root="$HOME/$rel"
    check "skills_${label}_dest_manifest" "$(fingerprint "$root/.pi-harness-managed-skills")" "$SKILLS_MANIFEST_SHA"
    check "skills_${label}_managed_digest" "$(managed_digest "$root" "${managed[@]}")" "$EXPECTED_MANAGED_DIGEST"
    missing=0
    for name in "${managed[@]}"; do
      [[ -f "$root/$name/SKILL.md" ]] || missing=$((missing + 1))
    done
    check "skills_${label}_missing_managed" "$missing" 0
    # The managed catalog may grow between runs, so only the set of user-owned
    # skill directories is invariant.
    check "skills_${label}_unmanaged_dirs" "$(unmanaged_digest "$root" "${managed[@]}")" "$pre"
  done

  check pi_user_skill_count "$(find "$pi_user_skills" -name SKILL.md 2>/dev/null | wc -l)" "$PI_USER_PRE"
  check shadow_backup_count "$(find "$agent_dir/backups/skills-shadowed" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)" "$SHADOW_PRE"
  check pi_user_skill_shadows "$(node - "$pi_user_skills" "${managed[@]}" <<'NODE'
const fs = require("node:fs"), path = require("node:path");
const [root, ...managed] = process.argv.slice(2);
const managedSet = new Set(managed);
const leaks = [];
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    const skillMd = path.join(full, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      const text = fs.readFileSync(skillMd, "utf8");
      const match = /^name:[ \t]*(.*)$/m.exec(text);
      const declared = match ? match[1].replace(/[ \t]#.*$/, "").trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1") : entry.name;
      if (managedSet.has(declared)) leaks.push(`${full}|${declared}`);
    }
    walk(full);
  }
}
if (fs.existsSync(root)) walk(root);
console.log(leaks.length ? leaks.join(",") : "none");
NODE
)" none

  if (( failures > 0 )); then
    printf 'VERIFY_FAIL host=%s failures=%s\n' "$host" "$failures"
    exit 1
  fi
  printf 'VERIFY_PASS host=%s\n' "$host"
}

case "$MODE" in
  preflight) do_preflight ;;
  update) ( set -euo pipefail; trap 'printf "TRAP_LINE=%s\n" "$LINENO" >&2' ERR; do_update ) ;;
  verify) do_verify ;;
  *) fail "unknown mode '$MODE' (expected preflight, update or verify)" ;;
esac
