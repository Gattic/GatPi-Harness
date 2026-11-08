#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
function text(file) { return fs.readFileSync(path.join(root, file), "utf8"); }
function assertContains(file, needle) { assert.ok(text(file).includes(needle), `${file} should include ${needle}`); }

const ext = ".pi/extensions/semgrep/index.ts";
const lib = "src/semgrep-adapter.js";
for (const command of ["semgrep-status", "semgrep-scan", "semgrep-changed", "semgrep-codegraph", "semgrep-doctor"]) {
  assertContains(ext, `pi.registerCommand("${command}"`);
}
for (const tool of ["semgrep_status", "semgrep_scan", "semgrep_codegraph", "semgrep_doctor"]) {
  assertContains(ext, `name: "${tool}"`);
}
assertContains(ext, "\"src\", \"semgrep-adapter.js\"");
assert.ok(!text(ext).includes("JsonField"), "retrieval scans must always use structured provider data");
assertContains(ext, "verbose: VerboseField");
for (const required of ["PI_SEMGREP_BIN", "PI_SEMGREP_CONFIG", "PI_SEMGREP_ADVISORY", "PI_SEMGREP_METRICS", "PI_SEMGREP_CONFIG_PROBE_TIMEOUT_MS", "execFile", "truncateHead", "normalizeProjectFile", "stripAnsi", "friendlyMissingBinaryMessage", "SEMGREP_NOT_INSTALLED", "SEMGREP_COMMAND_FAILED", "SEMGREP_AUTO_METRICS_CONFLICT", "semgrepConfigReadiness", "classifySemgrepScan", "infrastructure-failed", "findingsPresent", "supplement-failed", "semgrepReliabilityReport", "minimumObservedDays", "semgrepCodegraphAdvisory", "codegraphAffectedTests", "parseSemgrepOutput", "semgrepDoctor", "binaryReady", "configReady", "scanReady"]) {
  assertContains(lib, required);
}
assertContains("src/project-intelligence.js", "semgrepProjectSnapshot");
assertContains("src/project-intelligence.js", "semgrepScan");
assertContains(".pi/extensions/verification-center/index.ts", "semgrepVerificationAdvisory");
assertContains(".pi/extensions/runtime-doctor/index.ts", "semgrepDoctor");
assertContains("docs/productization-extensions.md", "Semgrep Adapter");
assertContains("docs/runtime-configuration.md", "PI_SEMGREP_BIN=semgrep");
assertContains(ext, "Defaults to PI_SEMGREP_CONFIG or p/default");
assertContains("docs/integration-boundary.md", "src/semgrep-adapter.js");
assertContains(".gitignore", ".pi/semgrep/");
assertContains("wiki/extensions-and-commands.md", "semgrep_codegraph");
assertContains("scripts/extension-smoke-runner.js", "discoverExtensionEntries");
assertContains("scripts/extension-smoke-runner.js", "runRpcProbe");
console.log("semgrep extension checks passed");
