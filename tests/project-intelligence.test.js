"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createProjectIndex, profile, recommendVerifiers, testImpact } = require("../src/project-intelligence");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-project-intel-");
fs.mkdirSync(path.join(tmp, "src"));
fs.mkdirSync(path.join(tmp, "tests"));
fs.mkdirSync(path.join(tmp, "scripts"));
fs.writeFileSync(path.join(tmp, "src", "alpha.js"), "export function alpha() { return 1; }\n");
fs.writeFileSync(path.join(tmp, "src", "tool.py"), "def tool():\n    return 1\n");
fs.writeFileSync(path.join(tmp, "src", "reasoning-runtime.js"), "module.exports = {};\n");
fs.writeFileSync(path.join(tmp, "src", "skill-synthesis.js"), "module.exports = {};\n");
fs.writeFileSync(path.join(tmp, "scripts", "bootstrap-new-machine.sh"), "#!/usr/bin/env bash\nexit 0\n");
fs.writeFileSync(path.join(tmp, "scripts", "install-agent-skills.sh"), "#!/usr/bin/env bash\nexit 0\n");
fs.writeFileSync(path.join(tmp, "scripts", "pi-harness-refresh.sh"), "#!/usr/bin/env bash\nexit 0\n");
fs.writeFileSync(path.join(tmp, "tests", "alpha.test.js"), "const assert = require('assert');\n");
fs.writeFileSync(path.join(tmp, "tests", "test_tool.py"), "def test_tool():\n    assert True\n");
fs.writeFileSync(path.join(tmp, "tests", "reasoning-runtime.test.js"), "// fixture\n");
fs.writeFileSync(path.join(tmp, "tests", "skill-synthesis.test.js"), "// fixture\n");
fs.writeFileSync(path.join(tmp, "tests", "install-agent-skills.test.js"), "// fixture\n");
fs.writeFileSync(path.join(tmp, "tests", "pi-harness-refresh-script.test.js"), "// fixture\n");
fs.writeFileSync(path.join(tmp, "scripts-check.sh"), "echo ok\n");
const index = createProjectIndex(tmp);
assert.ok(index.languages.some((l) => l.language === "javascript"));
assert.ok(index.symbols.some((s) => s.name === "alpha"));
assert.ok(index.tests.some((t) => t.path === "tests/alpha.test.js"));
assert.equal(index.buildGraph.enabled, true);
assert.equal(index.buildGraph.fingerprint.length, 24);
assert.ok(index.buildGraph.providers.some((provider) => provider.provider === "project-config"));
const pythonVerifier = index.verifierProfiles.find((v) => v.kind === "compile" && v.command === "python3");
assert.ok(pythonVerifier, "python projects get a generic compile verifier");
assert.deepEqual(pythonVerifier.args.slice(0, 2), ["-m", "py_compile"]);
assert.ok(pythonVerifier.artifacts.includes("src/tool.py"));
assert.equal(pythonVerifier.automatic, true);
const focusedTestBySource = {
  "scripts/install-agent-skills.sh": "tests/install-agent-skills.test.js",
  "scripts/pi-harness-refresh.sh": "tests/pi-harness-refresh-script.test.js",
  "src/reasoning-runtime.js": "tests/reasoning-runtime.test.js",
  "src/skill-synthesis.js": "tests/skill-synthesis.test.js",
};
const focusedSources = Object.keys(focusedTestBySource);
const focusedVerifiers = recommendVerifiers(tmp, { ...index, changedFiles: focusedSources });
for (const [source, test] of Object.entries(focusedTestBySource)) {
  const verifier = focusedVerifiers.find((candidate) => candidate.files?.includes(source));
  assert.ok(verifier, `${source} gets a focused verifier`);
  assert.equal(verifier.automatic, true, `${source} verifier participates in automatic verification`);
  assert.equal(verifier.command, "node");
  assert.deepEqual(verifier.args, [test], `${source} runs its exact focused test`);
  assert.deepEqual(verifier.artifacts, [test], `${source} records its focused test path`);
}
assert.equal(new Set(focusedVerifiers.filter((verifier) => verifier.files?.some((file) => focusedSources.includes(file))).map((verifier) => verifier.commandLine)).size, focusedSources.length, "focused node verifier commands are not deduplicated by executable alone");

const cmake = tmpFixture("pi-project-intel-cmake-");
fs.writeFileSync(path.join(cmake, "CMakeLists.txt"), "project(demo)\n");
fs.mkdirSync(path.join(cmake, "build"));
fs.writeFileSync(path.join(cmake, "build", "demo-unit-tests"), "#!/bin/sh\nexit 0\n");
fs.chmodSync(path.join(cmake, "build", "demo-unit-tests"), 0o755);
const cmakeIndex = createProjectIndex(cmake, { codegraph: false, semgrep: false });
assert.deepEqual(cmakeIndex.providerPolicy.requiredProviders, []);
assert.ok(cmakeIndex.providerPolicy.states.every((state) => state.status === "not-applicable" && state.blocking === false));
const nativeVerifier = cmakeIndex.verifierProfiles.find((v) => v.command === "build/demo-unit-tests");
assert.ok(nativeVerifier, "detected native test binaries become verification-center profiles");
assert.equal(nativeVerifier.profile, "quick");
assert.equal(nativeVerifier.automatic, true);
fs.mkdirSync(path.join(cmake, ".pi"), { recursive: true });
fs.writeFileSync(path.join(cmake, ".pi", "project.json"), JSON.stringify({ test: { binaries: ["build/demo-unit-tests", "build/missing-unit-tests"] } }));
const pinnedNativeVerifiers = recommendVerifiers(cmake, { ...cmakeIndex, changedFiles: [] });
assert(pinnedNativeVerifiers.some((v) => v.command === "build/demo-unit-tests"), "existing pinned native binaries remain automatic verifiers");
assert(!pinnedNativeVerifiers.some((v) => v.command === "build/missing-unit-tests"), "missing pinned binaries are omitted instead of producing deterministic ENOENT failures");

const prof = profile(tmp);
assert.ok(prof.detected.languages.includes("javascript"));
assert.equal(prof.buildGraph.fingerprint, index.buildGraph.fingerprint);
const impact = testImpact(tmp, ["src/alpha.js"]);
assert.equal(impact.gaps[0].existingTests[0], "tests/alpha.test.js");
assert.ok(impact.providerPolicy.states.every((state) => ["ready", "degraded", "required-unavailable"].includes(state.status)));
const localOnlyImpact = testImpact(tmp, ["src/alpha.js"], { codegraph: false, semgrep: false, requiredProviders: ["codegraph", "semgrep"] });
assert.ok(localOnlyImpact.providerPolicy.states.every((state) => state.status === "not-applicable" && state.blocking === false), "disabled/non-applicable providers do not fail unrelated local analysis");
console.log("project-intelligence tests passed");
