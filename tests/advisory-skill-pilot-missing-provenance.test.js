#!/usr/bin/env node
"use strict";
// Regression: archiving or uninstalling the pinned skill file must pause the
// pilot. prepare() runs in before_agent_start and report() feeds compounding
// records, so a thrown ENOENT there broke unrelated turns and reports.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { AdvisorySkillPilot, SkillSynthesisAdapter, MemoryJsonStorage } = require("../src/integration-boundary");
const { openExperiment } = require("../src/experiment-ledger");
const { hash } = require("../src/reviewed-evidence");
const { tmpFixture } = require("./helpers/tmp-fixture");

const ORIGINAL = "Verify changes without repairs.\n";
const temporary = [];

function setup() {
  const root = tmpFixture("pi-pilot-missing-provenance-");
  // Installed skills live outside the repository, so removing one does not
  // change the verified tree.
  const skillsHome = tmpFixture("pi-pilot-skills-home-");
  temporary.push(root, skillsHome);
  execFileSync("git", ["init", "-q"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), ".pi/\n");
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(path.join(root, "tests/oracle.test.js"), "console.log('fixture');\n");
  openExperiment(root, "machine verification advisory v2");
  const file = path.join(skillsHome, "change-verify", "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ORIGINAL);
  const skills = new SkillSynthesisAdapter({ cwd: root, storage: new MemoryJsonStorage(), options: { loadNative: false, loadCurated: false } });
  skills.registerProvider({ providerId: "fixture", skills: [{
    skillId: "skill_fixture_verify", name: "Fixture change-verify", description: "Verify changes", status: "approved",
    workflowSteps: [{ description: "Verify the change" }],
    provenance: { nativeSkillName: "change-verify", file, sourceHash: hash(ORIGINAL) },
    approvals: { advisoryRetrieval: "allowed", routing: "not-approved", publishing: "not-approved" },
  }] });
  return { root, file, pilot: new AdvisorySkillPilot({ cwd: root, skills, env: {} }) };
}

const request = (sessionId) => ({ prompt: "Verify these changes", interactive: true, sessionId, requestId: `${sessionId}-request`, model: { provider: "fixture", id: "model" }, thinkingLevel: "low" });

try {
  const { file, pilot } = setup();
  const enrolled = pilot.initialize();
  assert.ok(pilot.prepare(request("before-archive")).caseId, "fixture enrolls while the pinned file exists");

  fs.unlinkSync(file);
  assert.deepEqual(pilot.settle().assessment, { status: "inconclusive", reason: "identity-changed" },
    "a case running when the file disappears settles as identity drift");

  const casesBefore = pilot.state().cases.length;
  assert.deepEqual(pilot.prepare(request("after-archive")), { blocked: "provenance-file-missing" });
  assert.equal(pilot.active, null, "a blocked prepare activates no case and exposes no advisory");
  assert.equal(pilot.state().cases.length, casesBefore, "a blocked prepare enrolls nothing");

  const missing = pilot.report();
  assert.equal(missing.blocked, "provenance-file-missing");
  assert.equal(missing.identityMatches, false);
  assert.equal(missing.automaticReminderEnabled, false);
  assert.deepEqual(missing.identity, enrolled.identity, "the report keeps the enrolled pin");
  assert.deepEqual(pilot.state().identity, enrolled.identity, "a missing file never rewrites the pinned identity");

  // Provenance is still checked by content, not by mere presence.
  fs.writeFileSync(file, "Different instructions.\n");
  assert.deepEqual(pilot.prepare(request("changed-bytes")), { blocked: "source-or-configuration-changed" });
  assert.equal(pilot.report().blocked, "source-or-configuration-changed");
  assert.equal(pilot.report().identityMatches, false);

  fs.writeFileSync(file, ORIGINAL);
  assert.equal(pilot.report().blocked, null);
  assert.equal(pilot.report().identityMatches, true);
  assert.ok(pilot.prepare(request("restored")).caseId, "restoring the exact pinned bytes resumes collection");
  pilot.settle();

  // Enrollment keeps refusing a skill whose pinned file is absent.
  const fresh = setup();
  fs.unlinkSync(fresh.file);
  assert.throws(() => fresh.pilot.initialize(), /provenance file is missing; enrollment blocked/);
  assert.equal(fresh.pilot.state(), null, "refused enrollment writes no pilot state");
} finally {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
}
console.log("advisory skill pilot missing provenance tests passed");
