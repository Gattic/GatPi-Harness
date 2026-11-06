#!/usr/bin/env bash
set -euo pipefail

# Applies the local Pi runtime patches captured in patches/*.patch to the
# currently installed global @earendil-works/pi-coding-agent package.
#
# This makes our otherwise-fragile edits to the global npm installation
# repeatable after `pi update`, npm reinstalls, or on another dev box.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PATCH_DIR="$REPO_ROOT/patches"
DEFAULT_EXPECTED_VERSION="0.80.5"
# Override for upgrades, e.g. PI_PATCH_VERSION=0.80.5 after npm install -g of
# that release; patch filenames are derived from this version.
EXPECTED_VERSION="${PI_PATCH_VERSION:-$DEFAULT_EXPECTED_VERSION}"

npm_root="$(npm root -g)"
PI_ROOT="${PI_ROOT:-$npm_root/@earendil-works/pi-coding-agent}"
TUI_ROOT="$PI_ROOT/node_modules/@earendil-works/pi-tui"

if [[ ! -f "$PI_ROOT/package.json" ]]; then
  echo "Could not find global Pi package at: $PI_ROOT" >&2
  echo "Set PI_ROOT=/path/to/@earendil-works/pi-coding-agent to override." >&2
  exit 1
fi

version="$(node -e "console.log(require(process.argv[1]).version)" "$PI_ROOT/package.json")"
if [[ "$version" != "$EXPECTED_VERSION" ]]; then
  echo "Refusing to apply patches: expected pi-coding-agent $EXPECTED_VERSION, found $version at $PI_ROOT" >&2
  echo "Regenerate/review patches before applying to a different Pi version." >&2
  exit 1
fi

split_patch_by_file() {
  local patch="$1"
  local out_dir="$2"

  awk -v out_dir="$out_dir" '
    /^diff --git / {
      if (file) close(file)
      count += 1
      file = sprintf("%s/%04d.patch", out_dir, count)
    }
    file { print > file }
    END { if (count == 0) exit 1 }
  ' "$patch"
}

patch_target_label() {
  local patch="$1"
  awk '
    /^\+\+\+ / {
      target = $0
      sub(/^\+\+\+ b\//, "", target)
      sub(/^\+\+\+ /, "", target)
      print target
      exit
    }
  ' "$patch"
}

split_patch_by_hunk() {
  local patch="$1"
  local out_dir="$2"

  awk -v out_dir="$out_dir" '
    BEGIN {
      header = ""
      count = 0
      hunk_file = ""
    }
    /^@@ / {
      if (hunk_file) close(hunk_file)
      count += 1
      hunk_file = sprintf("%s/%04d.patch", out_dir, count)
      printf "%s", header > hunk_file
      print > hunk_file
      next
    }
    {
      if (hunk_file) {
        print > hunk_file
      } else {
        header = header $0 "\n"
      }
    }
    END {
      if (hunk_file) close(hunk_file)
      if (count == 0) exit 1
    }
  ' "$patch"
}

patch_hunk_label() {
  local patch="$1"
  awk '/^@@ / { print; exit }' "$patch"
}

check_patch_by_hunk() {
  local patch="$1"
  local git_ceiling="$2"
  local label="$3"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  if ! split_patch_by_hunk "$patch" "$tmp_dir"; then
    rm -rf "$tmp_dir"
    echo "Patch has no hunks to reconcile: ${label:-$patch}" >&2
    return 1
  fi

  local -a hunk_patches
  mapfile -t hunk_patches < <(find "$tmp_dir" -type f -name '*.patch' | sort)

  local hunk_patch
  local hunk_label
  for hunk_patch in "${hunk_patches[@]}"; do
    hunk_label="$(patch_hunk_label "$hunk_patch")"
    if GIT_CEILING_DIRECTORIES="$git_ceiling" git apply --reverse --check "$hunk_patch" 2>/dev/null; then
      continue
    elif GIT_CEILING_DIRECTORIES="$git_ceiling" git apply --check "$hunk_patch" 2>/dev/null; then
      continue
    else
      echo "Patch hunk does not apply cleanly: ${label:-$patch} ${hunk_label:-$hunk_patch}" >&2
      GIT_CEILING_DIRECTORIES="$git_ceiling" git apply --check "$hunk_patch" || true
      rm -rf "$tmp_dir"
      return 1
    fi
  done

  rm -rf "$tmp_dir"
}

apply_patch_by_hunk() {
  local patch="$1"
  local git_ceiling="$2"
  local label="$3"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  if ! split_patch_by_hunk "$patch" "$tmp_dir"; then
    rm -rf "$tmp_dir"
    echo "Patch has no hunks to reconcile: ${label:-$patch}" >&2
    return 1
  fi

  local -a hunk_patches
  mapfile -t hunk_patches < <(find "$tmp_dir" -type f -name '*.patch' | sort)

  local applied=0
  local already=0
  local hunk_patch
  local hunk_label
  for hunk_patch in "${hunk_patches[@]}"; do
    hunk_label="$(patch_hunk_label "$hunk_patch")"
    if GIT_CEILING_DIRECTORIES="$git_ceiling" git apply --reverse --check "$hunk_patch" 2>/dev/null; then
      echo "already applied hunk: ${label:-$patch} ${hunk_label:-$hunk_patch}"
      already=$((already + 1))
    elif GIT_CEILING_DIRECTORIES="$git_ceiling" git apply --check "$hunk_patch" 2>/dev/null; then
      GIT_CEILING_DIRECTORIES="$git_ceiling" git apply "$hunk_patch"
      echo "applied hunk: ${label:-$patch} ${hunk_label:-$hunk_patch}"
      applied=$((applied + 1))
    else
      echo "Patch hunk does not apply cleanly: ${label:-$patch} ${hunk_label:-$hunk_patch}" >&2
      GIT_CEILING_DIRECTORIES="$git_ceiling" git apply --check "$hunk_patch" || true
      rm -rf "$tmp_dir"
      return 1
    fi
  done

  rm -rf "$tmp_dir"
  echo "reconciled partial file patch by hunk: ${label:-$patch} ($applied applied, $already already applied)"
}

apply_patch_by_file() {
  local patch="$1"
  local git_ceiling="$2"
  local tmp_dir
  tmp_dir="$(mktemp -d)"

  if ! split_patch_by_file "$patch" "$tmp_dir"; then
    rm -rf "$tmp_dir"
    echo "Patch has no git file diffs: $patch" >&2
    return 1
  fi

  local -a file_patches
  mapfile -t file_patches < <(find "$tmp_dir" -type f -name '*.patch' | sort)

  local -a statuses
  local -a labels
  local file_patch
  local status
  local label
  for file_patch in "${file_patches[@]}"; do
    label="$(patch_target_label "$file_patch")"
    labels+=("${label:-$file_patch}")
    if GIT_CEILING_DIRECTORIES="$git_ceiling" git apply --reverse --check "$file_patch" 2>/dev/null; then
      statuses+=("already")
    elif GIT_CEILING_DIRECTORIES="$git_ceiling" git apply --check "$file_patch" 2>/dev/null; then
      statuses+=("apply")
    elif check_patch_by_hunk "$file_patch" "$git_ceiling" "${label:-$file_patch}"; then
      statuses+=("hunks")
    else
      echo "Patch file does not apply cleanly: ${label:-$file_patch}" >&2
      echo "This target may be partially patched within one file or changed upstream." >&2
      GIT_CEILING_DIRECTORIES="$git_ceiling" git apply --check "$file_patch" || true
      rm -rf "$tmp_dir"
      return 1
    fi
  done

  local applied=0
  local already=0
  local i
  for i in "${!file_patches[@]}"; do
    status="${statuses[$i]}"
    if [[ "$status" == "already" ]]; then
      echo "already applied file: ${labels[$i]}"
      already=$((already + 1))
    elif [[ "$status" == "hunks" ]]; then
      echo "reconciling mixed file by hunk: ${labels[$i]}"
      apply_patch_by_hunk "${file_patches[$i]}" "$git_ceiling" "${labels[$i]}"
      applied=$((applied + 1))
    else
      GIT_CEILING_DIRECTORIES="$git_ceiling" git apply "${file_patches[$i]}"
      echo "applied file: ${labels[$i]}"
      applied=$((applied + 1))
    fi
  done

  rm -rf "$tmp_dir"
  echo "reconciled partial patch: $patch ($applied applied, $already already applied)"
}

try_apply_patch() {
  local root="$1"
  local patch="$2"
  local label="$3"

  if [[ ! -d "$root" ]]; then
    echo "Missing patch target for $label: $root" >&2
    return 1
  fi

  echo "==> $label"
  pushd "$root" >/dev/null
  # Some Node version manager directories (for example ~/.nvm) may themselves be
  # Git worktrees that ignore installed package paths. Prevent parent Git
  # discovery so git-apply checks the package files directly instead of
  # reporting ignored-path patches as skipped/already-applied.
  local git_ceiling
  git_ceiling="$(dirname "$root")"
  # Check reverse first so the script is idempotent when a patch was already
  # applied to the package files.
  if GIT_CEILING_DIRECTORIES="$git_ceiling" git apply --reverse --check "$patch" 2>/dev/null; then
    echo "already applied: $patch"
  elif GIT_CEILING_DIRECTORIES="$git_ceiling" git apply --check "$patch" 2>/dev/null; then
    GIT_CEILING_DIRECTORIES="$git_ceiling" git apply "$patch"
    echo "applied: $patch"
  else
    echo "Patch is partially applied or mixed; reconciling per file: $patch"
    if ! apply_patch_by_file "$patch" "$git_ceiling"; then
      echo "Patch does not apply cleanly: $patch" >&2
      popd >/dev/null
      return 1
    fi
  fi
  popd >/dev/null
}

apply_patch() {
  if ! try_apply_patch "$@"; then
    echo "Inspect current install and regenerate the patch if Pi was updated." >&2
    exit 1
  fi
}

patch_quiet_check() {
  local root="$1"
  local patch="$2"
  local direction="$3"

  if [[ ! -d "$root" ]]; then
    return 1
  fi

  pushd "$root" >/dev/null
  local git_ceiling
  git_ceiling="$(dirname "$root")"
  local status
  if [[ "$direction" == "reverse" ]]; then
    GIT_CEILING_DIRECTORIES="$git_ceiling" git apply --reverse --check "$patch" 2>/dev/null
    status=$?
  else
    GIT_CEILING_DIRECTORIES="$git_ceiling" git apply --check "$patch" 2>/dev/null
    status=$?
  fi
  popd >/dev/null
  return "$status"
}

CODING_AGENT_LOCAL_PATCH="$PATCH_DIR/pi-coding-agent-$EXPECTED_VERSION-local.patch"
CODING_AGENT_HISTORY_UPGRADE_PATCH="$PATCH_DIR/pi-coding-agent-$EXPECTED_VERSION-history-upgrade.patch"

if [[ -f "$CODING_AGENT_HISTORY_UPGRADE_PATCH" ]]; then
  # Avoid a noisy speculative history-upgrade failure on clean installs. The
  # upgrade patch only applies after the base local patch, while already-upgraded
  # installs should still short-circuit without testing the older all-in-one
  # patch against upgraded hunks.
  if patch_quiet_check "$PI_ROOT" "$CODING_AGENT_HISTORY_UPGRADE_PATCH" reverse; then
    apply_patch "$PI_ROOT" "$CODING_AGENT_HISTORY_UPGRADE_PATCH" "@earendil-works/pi-coding-agent history upgrade"
  elif patch_quiet_check "$PI_ROOT" "$CODING_AGENT_LOCAL_PATCH" forward; then
    apply_patch "$PI_ROOT" "$CODING_AGENT_LOCAL_PATCH" "@earendil-works/pi-coding-agent"
    apply_patch "$PI_ROOT" "$CODING_AGENT_HISTORY_UPGRADE_PATCH" "@earendil-works/pi-coding-agent history upgrade"
  elif ! try_apply_patch "$PI_ROOT" "$CODING_AGENT_HISTORY_UPGRADE_PATCH" "@earendil-works/pi-coding-agent history upgrade"; then
    apply_patch "$PI_ROOT" "$CODING_AGENT_LOCAL_PATCH" "@earendil-works/pi-coding-agent"
    apply_patch "$PI_ROOT" "$CODING_AGENT_HISTORY_UPGRADE_PATCH" "@earendil-works/pi-coding-agent history upgrade"
  fi
else
  apply_patch "$PI_ROOT" "$CODING_AGENT_LOCAL_PATCH" "@earendil-works/pi-coding-agent"
fi

TUI_LOCAL_PATCH="$PATCH_DIR/pi-tui-$EXPECTED_VERSION-local.patch"
TUI_IDLE_PATCH="$PATCH_DIR/pi-tui-$EXPECTED_VERSION-idle-answer-resize.patch"
if ! try_apply_patch "$TUI_ROOT" "$TUI_LOCAL_PATCH" "@earendil-works/pi-tui"; then
  if [[ -f "$TUI_IDLE_PATCH" ]]; then
    echo "Primary pi-tui patch needs the idle-answer resize upgrade fallback."
    # Older installs may already have the previous resize hunk applied, so the
    # full original-to-current patch cannot be reconciled hunk-by-hunk. Apply the
    # old-local-to-current upgrade hunk, then verify the full patch is present.
    apply_patch "$TUI_ROOT" "$TUI_IDLE_PATCH" "@earendil-works/pi-tui idle-answer-resize upgrade"
    apply_patch "$TUI_ROOT" "$TUI_LOCAL_PATCH" "@earendil-works/pi-tui"
  else
    # Newer patch sets (0.80.5+) ship a single combined pi-tui patch.
    apply_patch "$TUI_ROOT" "$TUI_LOCAL_PATCH" "@earendil-works/pi-tui"
  fi
fi

echo "Done. Restart or /reload pi to pick up patched runtime files."
