"use strict";

const path = require("node:path");

const FOCUSED_TEST_MAPPINGS = Object.freeze([
  Object.freeze({ source: "scripts/install-agent-skills.sh", test: "tests/install-agent-skills.test.js" }),
  Object.freeze({ source: "scripts/pi-harness-refresh.sh", test: "tests/pi-harness-refresh-script.test.js" }),
  Object.freeze({ source: "src/reasoning-runtime.js", test: "tests/reasoning-runtime.test.js" }),
  Object.freeze({ source: "src/skill-synthesis.js", test: "tests/skill-synthesis.test.js" }),
]);

function normalizePath(file) { return String(file || "").replace(/\\/g, "/"); }
function focusedTestMappingsForPaths(files, options = {}) {
  const changed = new Set((files || []).map(normalizePath));
  const restrictAvailable = Array.isArray(options.availableTests);
  const available = new Set((options.availableTests || []).map(normalizePath));
  return FOCUSED_TEST_MAPPINGS.filter((mapping) => changed.has(mapping.source) && (!restrictAvailable || available.has(mapping.test)));
}
function isTestPath(file, custom = []) {
  const value = String(file || "").replace(/\\/g, "/");
  if (custom.some((pattern) => pattern instanceof RegExp ? pattern.test(value) : value.includes(String(pattern)))) return true;
  if (/(^|\/)(docs?|documentation)(\/|$)/.test(value)) return false;
  return /(^|\/)(__tests__|tests?|specs?)\//.test(value)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(value)
    || /(^|\/)test_[^/]+\.py$/.test(value)
    || /_test\.go$/.test(value)
    || /(^|\/)tests?\/[^/]+\.rs$/.test(value)
    || /(^|\/)(?:test|tests|unit-tests|integration-tests)(?:\/|$)/.test(value)
    || /(?:^|\/)[^/]*(?:test|tests)$/.test(value);
}
function shellSafe(value) { return String(value).replace(/\\/g, "/"); }
function testCommandForPath(file, options = {}) {
  const value = shellSafe(file);
  const custom = (options.customTests || []).find((entry) => entry.path === value || entry.pattern instanceof RegExp && entry.pattern.test(value) || typeof entry.pattern === "string" && value.includes(entry.pattern));
  if (custom) return { id: `custom:${value}`, label: custom.label || value, command: custom.command, args: custom.args || [], commandLine: [custom.command, ...(custom.args || [])].join(" "), kind: custom.kind || "custom", files: [value], estimatedRuntimeMs: custom.estimatedRuntimeMs };
  if (/\.[cm]?js$/.test(value)) return { id: `node:${value}`, label: `node ${value}`, command: "node", args: [value], commandLine: `node ${value}`, kind: "unit", files: [value] };
  if (/\.py$/.test(value)) return { id: `pytest:${value}`, label: `pytest ${value}`, command: "pytest", args: ["-q", value], commandLine: `pytest -q ${value}`, kind: "unit", files: [value] };
  if (/_test\.go$/.test(value)) { const dir = path.posix.dirname(value); return { id: `go:${dir}`, label: `go test ./${dir}`, command: "go", args: ["test", `./${dir}`], commandLine: `go test ./${dir}`, kind: "unit", files: [value] }; }
  if (/\.rs$/.test(value)) return { id: `cargo:${value}`, label: "cargo test", command: "cargo", args: ["test"], commandLine: "cargo test", kind: "unit", files: [value] };
  if (options.binaryPaths?.includes(value) || !path.extname(value) && /test/i.test(path.basename(value))) return { id: `binary:${value}`, label: value, command: value, args: [], commandLine: value, kind: "native", files: [value] };
  return null;
}
function testCommandsForPaths(files, options = {}) {
  const seen = new Set();
  const commands = [];
  for (const file of files || []) {
    if (!isTestPath(file, options.customPatterns || []) && !options.binaryPaths?.includes(file)) continue;
    const command = testCommandForPath(file, options);
    if (!command || seen.has(command.commandLine)) continue;
    seen.add(command.commandLine); commands.push(command);
  }
  return commands.sort((a, b) => a.commandLine.localeCompare(b.commandLine));
}
module.exports = { FOCUSED_TEST_MAPPINGS, focusedTestMappingsForPaths, isTestPath, testCommandForPath, testCommandsForPaths };
