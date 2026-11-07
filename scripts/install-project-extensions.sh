#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
settings_file="$agent_dir/settings.json"
repo_root="$(pwd)"

mkdir -p "$agent_dir/extensions"

if [[ ! -f extensions/hermes-advisory/index.ts ]]; then
  printf 'missing extensions/hermes-advisory/index.ts\n' >&2
  exit 1
fi
if [[ ! -d .pi/extensions ]]; then
  printf 'missing .pi/extensions directory\n' >&2
  exit 1
fi

# Install the pinned Redis client for the Pi request queue; this never provisions
# credentials, contacts Redis or starts a service.
"$(pwd)/scripts/setup-pi-queue.sh"

# The harness extensions are source-linked through Pi's global settings rather
# than copied into ~/.pi/agent/extensions.

node - "$settings_file" "$repo_root" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [settingsFile, repoRoot] = process.argv.slice(2);
const { reconcileExtensionSettings } = require(path.join(repoRoot, "src/extension-settings.js"));
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
} catch {
  settings = {};
}
// extensions/codemode replaces the built-in CodeMode tool through its policy facade;
// the shared reconciler disables the built-in and prunes extension paths from
// other harness checkouts so every tool is registered once.
const { extensions, pruned } = reconcileExtensionSettings(settings.extensions, repoRoot);
settings.extensions = extensions;
for (const { entry, harnessRoot } of pruned) {
  console.log(`pruned stale harness extension entry (${harnessRoot}): ${entry}`);
}
// Canonical compaction/retry values are defaults, not overrides: a value already present
// in the user's settings stays authoritative across reinstalls.
function withDefaults(existing, defaults) {
  const merged = { ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}) };
  for (const [key, value] of Object.entries(defaults)) {
    if (merged[key] === undefined) merged[key] = value;
  }
  return merged;
}
settings.compaction = withDefaults(settings.compaction, {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
});
settings.retry = withDefaults(settings.retry, {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
});
settings.retry.provider = withDefaults(settings.retry.provider, {
  maxRetries: 0,
  maxRetryDelayMs: 60000,
});
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
NODE

printf 'configured Pi guarded settings and harness extensions in load order:\n'
printf '  - %s\n' "$repo_root/extensions/00-harness-defaults/index.ts" "$repo_root/.pi/extensions" "$repo_root/extensions" "-builtin:codemode (disabled: extensions/codemode replaces it)"
printf 'settings file: %s\n' "$settings_file"
printf 'bundled project-local extension directories:\n'
find .pi/extensions -mindepth 1 -maxdepth 1 -type d -printf '  - %f\n' | sort
printf 'bundled repo extension directories:\n'
find extensions -mindepth 1 -maxdepth 1 -type d -printf '  - %f\n' | sort
printf 'Run /reload in Pi, or restart Pi, to activate settings changes in existing sessions.\n'
