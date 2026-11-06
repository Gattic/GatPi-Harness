#!/usr/bin/env bash
# Install the version-controlled skills from this repository into local agent skill directories.
#
# Defaults:
#   source:        <repo>/skills/skills
#   manifest:      <repo>/skills/skills/managed-skills.txt
#   destinations: ~/.claude/skills and ~/.agents/skills
#
# Overrides:
#   PI_SKILLS_SOURCE_DIR=/path/to/skills
#   PI_SKILLS_MANIFEST_FILE=/path/to/managed-skills.txt
#   CLAUDE_SKILLS_DIR=/path/to/claude/skills
#   AGENT_SKILLS_DIR=/path/to/agent/skills
#   PI_USER_SKILLS_DIR=/path/to/pi/user/skills
#   PI_SKILLS_SHADOW_BACKUP_DIR=/path/to/skills-shadowed
#
# Pi loads its user skill root (default ~/.pi/agent/skills) ahead of the shared
# catalog and keys skills by their declared name, so a same-named skill there
# shadows the managed copy. Managed names are authoritative: such copies are
# moved into a timestamped backup instead of silently winning.

set -euo pipefail

# Catalog order and directory digests must not depend on the host locale.
export LC_ALL=C

usage() {
  cat <<'USAGE'
Usage: scripts/install-agent-skills.sh [--dry-run] [--list] [--agents-only]

Installs the exact managed catalog from skills/skills/managed-skills.txt to:
  - ~/.claude/skills
  - ~/.agents/skills

Each destination stores .pi-harness-managed-skills. On later installs, names in
that destination manifest but no longer in the source manifest are pruned.
Unmanaged destination entries are never removed.

A skill in Pi's user skill root (~/.pi/agent/skills) that declares a managed name
is moved to a timestamped backup so the managed copy is the one Pi loads.

Options:
  --dry-run      Print install/prune/shadow actions without writing files.
  --list         List the validated managed catalog and exit.
  --agents-only  Skip the Claude destination; used when only Pi is in scope.
  -h, --help     Show this help.
USAGE
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="${PI_SKILLS_SOURCE_DIR:-$REPO_ROOT/skills/skills}"
SOURCE_MANIFEST="${PI_SKILLS_MANIFEST_FILE:-$SRC_DIR/managed-skills.txt}"
CLAUDE_DEST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
AGENT_DEST="${AGENT_SKILLS_DIR:-$HOME/.agents/skills}"
PI_USER_SKILLS_DIR="${PI_USER_SKILLS_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/skills}"
SHADOW_BACKUP_ROOT="${PI_SKILLS_SHADOW_BACKUP_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/backups/skills-shadowed}"
DEST_MANIFEST_NAME=".pi-harness-managed-skills"

DRY_RUN=0
LIST_ONLY=0
AGENTS_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --list) LIST_ONLY=1 ;;
    --agents-only) AGENTS_ONLY=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

[[ -d "$SRC_DIR" ]] || { echo "Skill source directory does not exist: $SRC_DIR" >&2; exit 1; }
[[ -f "$SOURCE_MANIFEST" ]] || { echo "Managed skill manifest does not exist: $SOURCE_MANIFEST" >&2; exit 1; }

read_manifest() {
  local file="$1"
  awk 'NF && $1 !~ /^#/ { print $1 }' "$file"
}

validate_name() {
  [[ "$1" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]
}

declared_skill_name() {
  # Match Pi's resolution: YAML frontmatter name, otherwise the directory name.
  local dir="$1" declared
  declared="$(awk '/^name:[[:space:]]*/ { sub(/^name:[[:space:]]*/, ""); print; exit }' "$dir/SKILL.md" |
    sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  printf '%s\n' "${declared:-$(basename -- "$dir")}"
}

directory_digest() {
  local dir="$1"
  (
    cd -- "$dir"
    find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{ print $1 }'
  )
}

mapfile -t MANAGED_NAMES < <(read_manifest "$SOURCE_MANIFEST" | sort -u)
((${#MANAGED_NAMES[@]} > 0)) || { echo "Managed skill manifest is empty: $SOURCE_MANIFEST" >&2; exit 1; }

for name in "${MANAGED_NAMES[@]}"; do
  validate_name "$name" || { echo "Invalid managed skill name: $name" >&2; exit 1; }
  [[ -f "$SRC_DIR/$name/SKILL.md" ]] || { echo "Managed skill is missing SKILL.md: $name" >&2; exit 1; }
  declared_name="$(declared_skill_name "$SRC_DIR/$name")"
  [[ "$declared_name" == "$name" ]] || { echo "Skill frontmatter name does not match its directory: $name ($declared_name)" >&2; exit 1; }
done

mapfile -t DISCOVERED_NAMES < <(
  find "$SRC_DIR" -mindepth 1 -maxdepth 1 -type d -exec sh -c '
    for dir do
      [ -f "$dir/SKILL.md" ] && basename "$dir"
    done
  ' sh {} + | sort -u
)

if [[ "$(printf '%s\n' "${MANAGED_NAMES[@]}")" != "$(printf '%s\n' "${DISCOVERED_NAMES[@]}")" ]]; then
  echo "Managed skill manifest does not match discovered skills" >&2
  echo "Manifest:" >&2
  printf '  %s\n' "${MANAGED_NAMES[@]}" >&2
  echo "Discovered:" >&2
  printf '  %s\n' "${DISCOVERED_NAMES[@]}" >&2
  exit 1
fi

if ((LIST_ONLY)); then
  printf '%s\n' "${MANAGED_NAMES[@]}"
  exit 0
fi

install_to() {
  local dest="$1"
  local dest_manifest="$dest/$DEST_MANIFEST_NAME"
  local -a previous_names=()
  local name target tmp_manifest
  declare -A current=()

  [[ -n "$dest" && "$dest" != "/" ]] || { echo "Refusing unsafe destination: ${dest:-<empty>}" >&2; exit 1; }
  for name in "${MANAGED_NAMES[@]}"; do current["$name"]=1; done

  if [[ -f "$dest_manifest" ]]; then
    mapfile -t previous_names < <(read_manifest "$dest_manifest" | sort -u)
    for name in "${previous_names[@]}"; do
      validate_name "$name" || { echo "Invalid name in destination manifest $dest_manifest: $name" >&2; exit 1; }
    done
  fi

  if ((DRY_RUN)); then
    echo "Would reconcile ${#MANAGED_NAMES[@]} managed skills in $dest"
  else
    mkdir -p "$dest"
    echo "Reconciling ${#MANAGED_NAMES[@]} managed skills in $dest"
  fi

  for name in "${previous_names[@]}"; do
    [[ -z "${current[$name]:-}" ]] || continue
    target="$dest/$name"
    if [[ -e "$target" || -L "$target" ]]; then
      if ((DRY_RUN)); then
        echo "  would prune managed skill: $name"
      else
        rm -rf -- "$target"
        echo "  pruned managed skill: $name"
      fi
    fi
  done

  for name in "${MANAGED_NAMES[@]}"; do
    target="$dest/$name"
    if ((DRY_RUN)); then
      echo "  would install: $name -> $target"
      continue
    fi
    rm -rf -- "$target"
    mkdir -p "$target"
    cp -a "$SRC_DIR/$name/." "$target/"
    [[ "$(directory_digest "$SRC_DIR/$name")" == "$(directory_digest "$target")" ]] || {
      echo "Installed skill hash mismatch: $name in $dest" >&2
      exit 1
    }
    echo "  installed: $name"
  done

  if ((DRY_RUN)); then
    echo "  would write managed manifest: $dest_manifest"
  else
    tmp_manifest="$(mktemp "$dest/.pi-harness-managed-skills.tmp.XXXXXX")"
    printf '%s\n' "${MANAGED_NAMES[@]}" > "$tmp_manifest"
    chmod 0600 "$tmp_manifest"
    mv -f -- "$tmp_manifest" "$dest_manifest"
  fi
}

reconcile_shadowed_managed_skills() {
  local root="$PI_USER_SKILLS_DIR"
  local skill_file dir rel declared backup_dir target existing
  local skip=0
  local -a displaced=()
  local -A managed=()

  [[ -d "$root" ]] || return 0
  [[ -n "$AGENT_DEST" && "$AGENT_DEST" != "/" ]] || { echo "Refusing unsafe destination: ${AGENT_DEST:-<empty>}" >&2; exit 1; }
  if [[ "$(realpath -m -- "$root")" == "$(realpath -m -- "$AGENT_DEST")" ]]; then
    echo "Pi user skill directory and managed destination are the same path: $AGENT_DEST" >&2
    exit 1
  fi
  # A backup inside a skill root would still be discovered by Pi, so the
  # displaced skill would keep shadowing the managed copy.
  for existing in "$root" "$AGENT_DEST"; do
    case "$(realpath -m -- "$SHADOW_BACKUP_ROOT")" in
      "$(realpath -m -- "$existing")"/*)
        echo "Shadow backup directory must be outside skill roots: $SHADOW_BACKUP_ROOT" >&2
        exit 1
        ;;
    esac
  done
  # Pi treats a directory holding SKILL.md as one skill and does not descend
  # into it, so a skill root that is itself a skill cannot be reconciled.
  if [[ -f "$root/SKILL.md" ]]; then
    echo "Pi user skill root is itself a skill directory: $root" >&2
    exit 1
  fi

  for name in "${MANAGED_NAMES[@]}"; do managed["$name"]=1; done

  while IFS= read -r skill_file; do
    dir="$(dirname -- "$skill_file")"
    declared="$(declared_skill_name "$dir")"
    [[ -n "${managed[$declared]:-}" ]] || continue
    # An enclosing displaced directory takes its children with it.
    skip=0
    for existing in "${displaced[@]}"; do
      [[ "$dir" == "$existing"/* ]] && { skip=1; break; }
    done
    ((skip)) && continue
    displaced+=("$dir")
  done < <(find "$root" -mindepth 1 \( -name node_modules -o -name '.*' \) -prune -o -name SKILL.md -type f -print)

  ((${#displaced[@]} > 0)) || return 0

  backup_dir="$SHADOW_BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
  for dir in "${displaced[@]}"; do
    rel="${dir#"$root"/}"
    target="$backup_dir/$rel"
    if ((DRY_RUN)); then
      echo "  would shadow: $rel -> $target"
      continue
    fi
    if [[ -e "$target" ]]; then
      echo "Backup target already exists: $target" >&2
      exit 1
    fi
    mkdir -p -- "$(dirname -- "$target")"
    mv -- "$dir" "$target"
    echo "  shadowed: $rel -> $target"
  done
}

if ((AGENTS_ONLY)); then
  reconcile_shadowed_managed_skills
  install_to "$AGENT_DEST"
else
  install_to "$CLAUDE_DEST"
  reconcile_shadowed_managed_skills
  install_to "$AGENT_DEST"
fi

echo "Done."
