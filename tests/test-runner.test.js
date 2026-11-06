#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createTestRunner, gitChangedFiles, inferCommands, isTestPath, selectCommands } = require("../src/test-runner.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-test-runner-");
function git(args) {
  const result = spawnSync("git", args, { cwd: tmp, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } });
  assert.equal(result.status, 0, result.stderr);
}
git(["init", "-q"]);
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
fs.writeFileSync(path.join(tmp, "src", "alpha.js"), "module.exports = 1;\n");
fs.writeFileSync(path.join(tmp, "tests", "alpha.test.js"), "require('../src/alpha');\n");
git(["add", "."]);
git(["commit", "-qm", "fixture"]);
git(["mv", "src/alpha.js", "src/beta.js"]);
fs.writeFileSync(path.join(tmp, "tests", "new.test.js"), "// untracked\n");

const changed = gitChangedFiles(tmp);
assert.ok(changed.includes("src/alpha.js"), "rename source should affect test inference");
assert.ok(changed.includes("src/beta.js"), "rename destination should affect test inference");
assert.ok(changed.includes("tests/new.test.js"), "untracked tests should be inferred");
const inferred = inferCommands(tmp);
assert.ok(inferred.changedFiles.includes("tests/new.test.js"));
assert.ok(inferred.profiles.changed.some((command) => command.files.includes("tests/new.test.js")));
assert.equal(isTestPath("tests/new.test.js"), true);

(async () => {
  const runner = createTestRunner({ timeoutMs: 5000 });
  const empty = tmpFixture("pi-test-runner-empty-");
  const emptyCtx = { cwd: empty };
  const selection = selectCommands(empty, { profile: "changed" });
  assert.equal(selection.notApplicable, true);
  assert.deepEqual(selection.commands, []);
  const inferredEmpty = await runner.infer(emptyCtx, { profile: "changed" });
  assert.equal(inferredEmpty.details.outcome, "not-applicable");
  const profileFixture = tmpFixture("pi-test-runner-profile-");
  fs.writeFileSync(path.join(profileFixture, "package.json"), JSON.stringify({ scripts: { test: "node -e \\\"process.exit(0)\\\"", "check:static": "node -e \\\"process.exit(0)\\\"" } }));
  const quickCommands = selectCommands(profileFixture, { profile: "quick" });
  assert.equal(quickCommands.notApplicable, false, "the fixture has a quick test command");
  assert(quickCommands.commands.some((command) => command.id === "npm:check-static"), "the quick profile wires the static gate");
  const staleSelection = selectCommands(profileFixture, { profile: "quick", commandId: "node:removed.test.js" });
  assert.equal(staleSelection.notApplicable, true);
  assert.equal(staleSelection.reasonCode, "stale-command-id");
  assert(staleSelection.availableCommandIds.includes("npm:test"));
  const staleRun = await runner.run({ cwd: profileFixture }, { profile: "quick", commandId: "node:removed.test.js" });
  assert.equal(staleRun.details.outcome, "not-applicable", "stale dynamic ids produce actionable refresh guidance rather than a tool error");
  assert.equal(staleRun.details.nextOperation, "infer");
  assert.equal(staleRun.details.requestedCommandId, "node:removed.test.js");
  for (const profile of ["integration", "lint", "typecheck"]) {
    const selected = selectCommands(profileFixture, { profile });
    assert.equal(selected.notApplicable, true, `${profile} must be not-applicable when no ${profile} command exists`);
    assert.deepEqual(selected.commands, [], `${profile} must not silently substitute quick tests`);
  }
  const noLint = await runner.run({ cwd: profileFixture }, { profile: "lint" });
  assert.equal(noLint.details.outcome, "not-applicable", "an explicit empty profile is truthful end-to-end");
  assert.equal(noLint.details.summary.commands, 0);
  assert.equal(inferredEmpty.details.ok, null);
  const noPrevious = await runner.rerunFailures(emptyCtx, {});
  assert.equal(noPrevious.details.outcome, "not-applicable");
  assert.equal(noPrevious.details.reasonCode, "no-prior-result");
  const noCommands = await runner.run(emptyCtx, { profile: "changed" });
  assert.equal(noCommands.details.outcome, "not-applicable");
  assert.equal(noCommands.details.summary.commands, 0);
  assert.match(noCommands.content[0].text, /not-applicable/);
  const noFailures = await runner.rerunFailures(emptyCtx, {});
  assert.equal(noFailures.details.outcome, "not-applicable");
  assert.equal(noFailures.details.reasonCode, "no-prior-failures");

  const failing = tmpFixture("pi-test-runner-failing-");
  fs.mkdirSync(path.join(failing, "tests"), { recursive: true });
  fs.writeFileSync(path.join(failing, "tests", "failure.test.js"), "throw new Error('expected fixture failure');\n");
  const failed = await runner.run({ cwd: failing }, { files: ["tests/failure.test.js"], profile: "changed" });
  assert.equal(failed.details.outcome, "domain-negative", "failed repository checks are domain-negative, not infrastructure failures");
  assert.equal(failed.details.ok, false);
  assert.equal(failed.details.summary.failed, 1);
  assert.notEqual(failed.details.runs[0].exitCode, 0);
  assert.match(failed.details.runs[0].failureHints, /expected fixture failure/);
  const selectionFixture = tmpFixture("pi-test-runner-selection-");
  fs.mkdirSync(path.join(selectionFixture, "src"), { recursive: true });
  fs.mkdirSync(path.join(selectionFixture, "tests"), { recursive: true });
  fs.writeFileSync(path.join(selectionFixture, "src", "trace-observability.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(selectionFixture, "tests", "trace-adapter.test.js"), "require('../src/trace-observability.js');\n");
  fs.writeFileSync(path.join(selectionFixture, "tests", "unrelated.test.js"), "// unrelated\n");
  const graphSelection = selectCommands(selectionFixture, { files: ["src/trace-observability.js"], profile: "changed" });
  assert.equal(graphSelection.notApplicable, false);
  assert.deepEqual(graphSelection.commands.map((command) => command.files[0]), ["tests/trace-adapter.test.js"], "a differently named test is selected through the import graph");
  assert(graphSelection.selection.strategies.includes("import-graph"));
  assert.equal(graphSelection.selection.discoveredTestFiles, 2);

  fs.writeFileSync(path.join(selectionFixture, "src", "no-consumer.js"), "module.exports = 2;\n");
  const noRelatedSelection = selectCommands(selectionFixture, { files: ["src/no-consumer.js"], profile: "changed" });
  assert.equal(noRelatedSelection.notApplicable, true);
  assert.equal(noRelatedSelection.reasonCode, "no-related-test-found");
  assert.deepEqual(noRelatedSelection.suggestedProfiles, ["full"]);
  const noRelatedRun = await runner.run({ cwd: selectionFixture }, { files: ["src/no-consumer.js"], profile: "changed" });
  assert.equal(noRelatedRun.details.outcome, "not-applicable");
  assert.equal(noRelatedRun.details.reasonCode, "no-related-test-found");

  const cappedFixture = tmpFixture("pi-test-runner-capped-");
  fs.mkdirSync(path.join(cappedFixture, "tests"), { recursive: true });
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(cappedFixture, "tests", `t${i}.test.js`), "// ok\n");
  const capped = inferCommands(cappedFixture);
  assert.equal(capped.profiles.unit.length, 50);
  assert.equal(capped.selection.unitCap, 50);
  assert.equal(capped.selection.truncatedProfiles.unit, true);
  const cappedRun = selectCommands(cappedFixture, { profile: "unit" });
  assert.equal(cappedRun.availableCommands, 50);
  assert.equal(cappedRun.truncated, true);
  assert.equal(cappedRun.selectedCommands, 20);

  const liveFixture = tmpFixture("pi-test-runner-live-");
  fs.mkdirSync(path.join(liveFixture, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(liveFixture, "scripts", "check-all.sh"), "#!/usr/bin/env bash\nexit 0\n");
  fs.writeFileSync(path.join(liveFixture, "scripts", "check-live.sh"), "#!/usr/bin/env bash\nexit 0\n");
  const live = inferCommands(liveFixture);
  assert.equal(live.profiles.full[0].id, "script:check-all");
  assert.equal(live.profiles.live[0].id, "script:check-live");
  const liveSelection = selectCommands(liveFixture, { profile: "live" });
  assert.equal(liveSelection.notApplicable, false);
  const config = require("../src/test-runner.js").configFromEnv({});
  assert(config.fullTimeoutMs > config.timeoutMs, "the full profile timeout must exceed the per-command default");
  assert(config.liveTimeoutMs > config.fullTimeoutMs, "live probes are the slowest opt-in profile");
  assert.equal(require("../src/test-runner.js").profileTimeoutMs("full", config), config.fullTimeoutMs);

  const rerunFixture = tmpFixture("pi-test-runner-rerun-");
  fs.mkdirSync(path.join(rerunFixture, ".pi", "test-runner"), { recursive: true });
  fs.writeFileSync(path.join(rerunFixture, ".pi", "test-runner", "latest.json"), JSON.stringify({
    profile: "full",
    generatedAt: new Date().toISOString(),
    runs: [{ id: "node:rerun-fixture", label: "rerun fixture", command: "node", args: ["-e", "process.exit(1)"], commandLine: "node -e process.exit(1)", ok: false, kind: "unit", files: [] }],
  }));
  const rerun = await runner.rerunFailures({ cwd: rerunFixture }, {});
  assert.equal(rerun.details.timeoutMs, config.fullTimeoutMs, "rerunFailures must retain the previous profile timeout");

  console.log("test-runner tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
