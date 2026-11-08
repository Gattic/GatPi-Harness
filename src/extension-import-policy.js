"use strict";

// Single source of truth for what extension code may import from src/.
//
// Previously the allowlist lived inline in tests/extension-import-boundary.test.js
// (45 entries), while docs/integration-boundary.md listed a different 30-entry
// set, and the test only scanned four roots. The policy and its enforcement
// roots now live here so docs, tests, and future checks cannot drift.

const fs = require("node:fs");
const path = require("node:path");

const EXTENSION_IMPORT_ALLOWLIST = Object.freeze([
  "src/pi-extension-kit.js",
  "src/pi-queue-adapter.js",
  "src/harness-metrics.js",
  "src/build-runner.js",
  "src/debug-ledger.js",
  "src/repo-context.js",
  "src/plan-fanout.js",
  "src/role-router.js",
  "src/role-topologies.js",
  "src/role-runtime-rollout.js",
  "src/role-run-provenance.js",
  "src/bg-jobs.js",
  "src/commit-plan.js",
  "src/fix-recall.js",
  "src/safe-try.js",
  "src/evidence-inbox.js",
  "src/integration-boundary.js",
  "src/rollout-center-view.js",
  "src/trace-observability.js",
  "src/file-integration-storage.js",
  "src/integration-config.js",
  "src/runtime-cleanup.js",
  "src/session-hygiene.js",
  "src/runtime-policy.js",
  "src/result-rendering.js",
  "src/context-overflow-recovery.js",
  "src/policy-enforcement.js",
  "src/project-scope.js",
  "src/project-intelligence.js",
  "src/evidence-binder.js",
  "src/extension-registry.js",
  "src/extension-canaries.js",
  "src/topology-recipes.js",
  "src/tool-surface-router.js",
  "src/tool-churn-guard.js",
  "src/learning-loop.js",
  "src/automation-loop.js",
  "src/codegraph-adapter.js",
  "src/semgrep-adapter.js",
  "src/obsidian-adapter.js",
  "src/lsp-adapter.js",
  "src/code-context-service.js",
  "src/test-runner.js",
  "src/ast-tools.js",
  "src/docs-lookup.js",
  "src/roadmap-telemetry.js",
  "src/security-checkpoint.js",
  "src/hermes-integration-scorecard.js",
  "src/extension-telemetry.js",
  "src/prompt-suggestion-policy.js",
  "src/prompt-suggestion-model.js",
]);

const FORBIDDEN_INTERNAL_MODULES = Object.freeze([
  "cognitive-memory.js",
  "layered-context.js",
  "semantic-editor.js",
  "verification-pipeline.js",
  "entropy-monitor.js",
  "cognitive-architecture.js",
  "session-branches.js",
]);

const EXTENSION_ROOTS = Object.freeze([
  ".pi/extensions",
  "extensions",
  "src/pi-core-adapters",
]);

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function walkExtensionFiles(root) {
  const files = [];
  const walk = (directory) => {
    let names;
    try { names = fs.readdirSync(directory).sort(); } catch { return; }
    for (const name of names) {
      if (IGNORED_DIRECTORIES.has(name)) continue;
      const full = path.join(directory, name);
      let stat;
      try { stat = fs.lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && /\.(?:ts|js)$/.test(name)) files.push(full);
    }
  };
  walk(root);
  return files;
}

function normalizeSrcSpecifier(specifier) {
  const value = String(specifier || "").replace(/\\/g, "/");
  const index = value.indexOf("src/");
  return index === -1 ? null : value.slice(index);
}

function scanExtensionImports({ cwd = process.cwd(), roots = EXTENSION_ROOTS, allowed = EXTENSION_IMPORT_ALLOWLIST, forbidden = FORBIDDEN_INTERNAL_MODULES } = {}) {
  const allow = new Set(allowed);
  const files = [];
  const offenders = [];
  for (const root of roots) {
    for (const file of walkExtensionFiles(path.resolve(cwd, root))) files.push(path.relative(cwd, file).replace(/\\/g, "/"));
  }
  for (const relative of files) {
    const text = fs.readFileSync(path.resolve(cwd, relative), "utf8");
    const pattern = /["'`]([^"'`]*src\/[^"'`]+\.js)["'`]/g;
    let match;
    while ((match = pattern.exec(text))) {
      const normalized = normalizeSrcSpecifier(match[1]);
      if (normalized && !allow.has(normalized)) offenders.push({ file: relative, specifier: match[1], reason: "not in extension import allowlist" });
    }
    for (const internal of forbidden) {
      if (text.includes(internal)) offenders.push({ file: relative, specifier: internal, reason: "forbidden subsystem internal" });
    }
  }
  return { roots: [...roots], files, offenders };
}

module.exports = {
  EXTENSION_IMPORT_ALLOWLIST,
  FORBIDDEN_INTERNAL_MODULES,
  EXTENSION_ROOTS,
  walkExtensionFiles,
  normalizeSrcSpecifier,
  scanExtensionImports,
};
