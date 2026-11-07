"use strict";

// Reconciles Pi's global extension list with this harness checkout.
//
// scripts/install-project-extensions.sh writes absolute extension paths into
// ~/.pi/agent/settings.json. When the harness moves or a second checkout
// exists, the previous absolute paths stay in settings and Pi loads the same
// tools twice, reporting a conflict for every tool on startup. Stale harness
// roots are therefore pruned instead of being preserved as unmanaged entries;
// unrelated user extensions are kept.

const fs = require("node:fs");
const path = require("node:path");

const DISABLED_BUILTINS = Object.freeze(["-builtin:codemode"]);

function canonicalPath(value) {
  const resolved = path.resolve(String(value));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function managedExtensionPaths(repoRoot) {
  const root = path.resolve(repoRoot);
  return [
    path.join(root, "extensions", "00-harness-defaults", "index.ts"),
    path.join(root, ".pi", "extensions"),
    path.join(root, "extensions"),
  ];
}

function looksLikeHarnessCheckout(root) {
  return (
    fs.existsSync(path.join(root, "package.json")) &&
    fs.existsSync(path.join(root, ".pi", "extensions")) &&
    fs.existsSync(path.join(root, "extensions", "00-harness-defaults", "index.ts"))
  );
}

function isInside(target, root) {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(prefix);
}

// Returns the harness checkout that owns an extension entry, if the entry
// points into that checkout's .pi/extensions or extensions directory.
function harnessRootForExtensionEntry(value) {
  const resolved = path.resolve(String(value));
  let current = resolved;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    if (looksLikeHarnessCheckout(parent)) {
      const inPiExtensions = isInside(resolved, path.join(parent, ".pi", "extensions"));
      const inExtensions = isInside(resolved, path.join(parent, "extensions"));
      return inPiExtensions || inExtensions ? parent : undefined;
    }
    current = parent;
  }
}

function staleHarnessRoot(value, repoRoot) {
  const root = harnessRootForExtensionEntry(value);
  if (!root) return undefined;
  if (canonicalPath(root) === canonicalPath(repoRoot)) return undefined;
  return root;
}

function reconcileExtensionSettings(existing, repoRoot) {
  const managed = managedExtensionPaths(repoRoot);
  const managedPaths = new Set(managed.map(canonicalPath));
  // Earlier installers wrote .pi/extensions/00-harness-defaults/index.ts;
  // extensions/00-harness-defaults/index.ts is the current managed path.
  managedPaths.add(canonicalPath(path.join(path.resolve(repoRoot), ".pi", "extensions", "00-harness-defaults", "index.ts")));

  const preserved = [];
  const pruned = [];
  for (const value of Array.isArray(existing) ? existing : []) {
    const entry = String(value);
    if (DISABLED_BUILTINS.includes(entry)) continue;
    if (managedPaths.has(canonicalPath(entry))) continue;
    const harnessRoot = staleHarnessRoot(entry, repoRoot);
    if (harnessRoot) {
      pruned.push({ entry, harnessRoot });
      continue;
    }
    preserved.push(entry);
  }

  return { extensions: [...managed, ...DISABLED_BUILTINS, ...preserved], pruned };
}

function extensionSettingsState(settings, repoRoot) {
  const configured = Array.isArray(settings?.extensions) ? settings.extensions.map((value) => String(value)) : [];
  const configuredPaths = new Set(configured.map(canonicalPath));
  const missing = managedExtensionPaths(repoRoot).filter((value) => !configuredPaths.has(canonicalPath(value)));
  const stale = configured.filter((entry) => !DISABLED_BUILTINS.includes(entry) && staleHarnessRoot(entry, repoRoot) !== undefined);
  return { missing, stale };
}

module.exports = { reconcileExtensionSettings, extensionSettingsState };
