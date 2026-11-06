#!/usr/bin/env bash
set -euo pipefail

# Offline patch-port readiness check: fetches the latest (or requested) Pi
# package tarballs into a temp dir and reports which local dist patches still
# apply. Never touches the live global install.
#
# Usage: scripts/check-pi-port-readiness.sh [version]

cd "$(dirname "$0")/.."

VERSION="${1:-latest}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pi-port-readiness-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching @earendil-works packages ($VERSION) into $WORK"
(cd "$WORK" && npm pack "@earendil-works/pi-coding-agent@$VERSION" "@earendil-works/pi-tui@$VERSION" >/dev/null)

mkdir -p "$WORK/agent" "$WORK/tui"
tar xzf "$WORK"/earendil-works-pi-coding-agent-*.tgz -C "$WORK/agent" --strip-components=1
tar xzf "$WORK"/earendil-works-pi-tui-*.tgz -C "$WORK/tui" --strip-components=1

resolved_agent_version="$(node -p 'require(process.argv[1]).version' "$WORK/agent/package.json")"
echo "Resolved pi-coding-agent version: $resolved_agent_version"
echo

failures=0
repo_root="$(pwd)"
for patch in patches/pi-coding-agent-*.patch; do
  if (cd "$WORK/agent" && git apply --check "$repo_root/$patch" 2>/dev/null); then
    echo "ok    - $patch ($(grep -c '^@@' "$patch") hunks) applies cleanly"
  else
    echo "STALE - $patch ($(grep -c '^@@' "$patch") hunks) does not apply"
    failures=$((failures + 1))
  fi
done
for patch in patches/pi-tui-*.patch; do
  if (cd "$WORK/tui" && git apply --check "$repo_root/$patch" 2>/dev/null); then
    echo "ok    - $patch ($(grep -c '^@@' "$patch") hunks) applies cleanly"
  else
    echo "STALE - $patch ($(grep -c '^@@' "$patch") hunks) does not apply"
    failures=$((failures + 1))
  fi
done

echo
if [[ "$failures" -eq 0 ]]; then
  echo "All patches apply to $resolved_agent_version. Legacy fallback path:"
  echo "  1. npm install -g @earendil-works/pi-coding-agent@$resolved_agent_version"
  echo "  2. Update DEFAULT_EXPECTED_VERSION in scripts/apply-pi-global-patches.sh"
  echo "  3. scripts/apply-pi-global-patches.sh && pi --version"
  echo "  Note: scripts/check-pi-drift.sh now requires the linked Pi fork source build."
else
  echo "$failures patch file(s) need porting before upgrading to $resolved_agent_version."
  echo "Re-derive stale hunks against the extracted dists (kept until this shell exits):"
  echo "  agent: $WORK/agent   tui: $WORK/tui"
  echo "Do NOT update EXPECTED_VERSION or the global install until all patches apply."
fi
exit "$failures"
