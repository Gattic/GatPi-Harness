#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
function text(file) { return fs.readFileSync(path.join(root, file), "utf8"); }
function assertContains(file, needle) { assert.ok(text(file).includes(needle), `${file} should include ${needle}`); }

const ext = ".pi/extensions/obsidian/index.ts";
const lib = "src/obsidian-adapter.js";
for (const command of ["obsidian-status", "obsidian-doctor", "obsidian-search", "obsidian-note", "obsidian-import", "obsidian-hermes", "obsidian-hermes-review", "obsidian-project-memory-status", "obsidian-project-memory-recall", "obsidian-project-memory-compile", "obsidian-open"]) {
  assertContains(ext, `pi.registerCommand("${command}"`);
}
for (const tool of ["obsidian_status", "obsidian_search", "obsidian_note", "obsidian_import", "obsidian_hermes", "obsidian_doctor"]) {
  assertContains(ext, `name: "${tool}"`);
}
assertContains(ext, "src\", \"obsidian-adapter.js");
for (const required of ["PI_OBSIDIAN_AUTO_AWARE", "PI_OBSIDIAN_AUTO_STATUS", "before_agent_start", "OBSIDIAN_AWARENESS_PROMPT", "classifyObsidianIntent", "obsidianAutomaticContextPolicy", "eventText(event)", "createExtensionTelemetry", 'opportunity("research-vault-intent"', "if (!policy.eligible) return", "Automatic Obsidian research-memory status probe", "obsidian_search before broad filesystem reads", "explicitHermesCurationIntent", "currentHermesIntent"]) {
  assertContains(ext, required);
}
const beforeAgentStart = text(ext).slice(text(ext).indexOf('pi.on("before_agent_start"'), text(ext).indexOf('pi.registerCommand("obsidian-status"'));
assert.match(beforeAgentStart, /if \(!AUTO_AWARE && !AUTO_STATUS\) return;/, "auto-status runs independently of generic awareness injection");
assert.doesNotMatch(beforeAgentStart, /if \(!AUTO_AWARE\) return;/, "disabling awareness alone must not disable auto-status");
for (const required of ["PI_OBSIDIAN_BIN", "PI_OBSIDIAN_VAULT", "PI_HERMES_BIN", "PI_HERMES_AUTH_PROBE_TIMEOUT_MS", "PI_HERMES_CURATION_PROBE_TIMEOUT_MS", 'require("./hermes-readiness.js")', "truncateHead", "normalizeVaultRelative", "friendlyMissingBinaryMessage", "friendlyMissingHermesMessage", "obsidianDoctor", "obsidianProjectSnapshot", "buildObsidianReadiness", "probeHermesAuthentication", "probeHermesCuration", "current-curation-smoke-required", "hermesAuthentication", "providerModel", "localMarkdown", "curation", "discoverVaultCandidates", "Hermes project-memory candidates generated", "dryRun", "research-import"]) {
  assertContains(lib, required);
}
assertContains("docs/productization-extensions.md", "Obsidian Adapter");
assertContains("docs/runtime-configuration.md", "PI_OBSIDIAN_BIN=obsidian");
assertContains("docs/runtime-configuration.md", "/obsidian-doctor [--probe-auth] [--probe-curation]");
for (const required of ["probeAuth", "probeCuration", "never reads vault bodies", "layered vault filesystem"]) assertContains(ext, required);
assertContains("docs/integration-boundary.md", "src/obsidian-adapter.js");
assertContains(".gitignore", ".pi/obsidian/");
assertContains("README.md", "obsidian_hermes");
assertContains("scripts/extension-smoke-runner.js", "discoverExtensionEntries");
assertContains(ext, "HermesAdvisoryAdapter");
assert.doesNotMatch(text(ext), /hermes-client|runHermes|spawn\([^)]*hermes/i, "active Obsidian consumer must use the integration-boundary advisory adapter");
console.log("obsidian extension checks passed");
