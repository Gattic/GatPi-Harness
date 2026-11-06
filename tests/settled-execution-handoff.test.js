#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FileIntegrationStorage } = require("../src/file-integration-storage");
const { ExecutionOutcomeAdapter, LearningLoopAdapter, SkillSynthesisAdapter } = require("../src/integration-boundary");
const { ProjectMemoryCandidatePipeline } = require("../src/project-memory-candidates");
const { tmpFixture } = require("./helpers/tmp-fixture");

function temp() { return tmpFixture("pi-settled-handoff-"); }
function allText(root) {
  const rows = [];
  function walk(current) {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && fs.statSync(file).size < 1024 * 1024) rows.push(fs.readFileSync(file, "utf8"));
    }
  }
  walk(root);
  return rows.join("\n");
}

(async () => {
  const cwd = temp();
  const privateFixture = "Implement secret task under /home/private/repository with sk-1234567890abcdefghijklmnop";
  const outcomes = new ExecutionOutcomeAdapter({ cwd });
  const learning = new LearningLoopAdapter({ cwd });
  const skills = new SkillSynthesisAdapter({
    storage: new FileIntegrationStorage(path.join(cwd, ".pi", "cognitive-automation")),
    options: { cwd, loadCurated: false, loadNative: false },
  });

  const loopPacket = outcomes.buildLoopSettlement({
    schemaVersion: 3,
    id: "loop_handoff_fixture",
    prompt: privateFixture,
    status: "completed",
    iteration: 2,
    checkpoints: [{ verdict: "pass", summary: privateFixture, evidence: ["evidence_handoff_fixture"] }],
    history: [
      { iteration: 1, assistantStopReason: "stop", toolCalls: 2, toolErrors: 1, tools: { read: 1, test_runner: 1 } },
      { iteration: 2, assistantStopReason: "stop", toolCalls: 1, toolErrors: 0, tools: { test_runner: 1 } },
    ],
    createdAt: "2026-07-31T12:00:00.000Z",
    completedAt: "2026-07-31T12:00:03.000Z",
  }, { assistantEntryId: "assistant_handoff_fixture", projectKey: cwd, producerVersion: "handoff-test-v1" });
  assert(loopPacket);
  assert.equal(outcomes.save(loopPacket).persisted, true);
  assert.equal(outcomes.save(loopPacket).persisted, false, "duplicate loop settlement is one packet");

  const goalPacket = outcomes.buildGoalSettlement({
    schemaVersion: 1,
    id: "goal_handoff_fixture",
    goal: privateFixture,
    status: "blocked",
    iteration: 1,
    history: [{ status: "running", executed: true, nextPrompt: privateFixture, rawHermesOutput: privateFixture, commandArgs: ["--token", privateFixture], toolOutput: privateFixture }],
    observations: [privateFixture, "proof_goal_handoff"],
    createdAt: "2026-07-31T12:01:00.000Z",
    updatedAt: "2026-07-31T12:01:02.000Z",
  }, { projectKey: cwd, producerVersion: "handoff-test-v1" });
  assert(goalPacket, "an instructive blocked goal with an executed action is captured");
  outcomes.save(goalPacket);
  assert.equal(outcomes.buildGoalSettlement({ id: "goal_empty_cancel", goal: privateFixture, status: "cancelled", iteration: 0 }), null, "empty cancellation is ignored");
  assert.equal(outcomes.buildGoalSettlement({ id: "goal_untouched", goal: privateFixture, status: "blocked", iteration: 1, history: [{ status: "blocked", executed: false }] }), null, "untouched blocked goal is ignored");
  assert.equal(outcomes.list().length, 2);

  const learningFirst = await outcomes.drain("learning-handoff-test", (packet) => learning.captureExecutionOutcome(packet));
  const learningReplay = await outcomes.drain("learning-handoff-test", (packet) => learning.captureExecutionOutcome(packet));
  assert.equal(learningFirst.processed, 2);
  assert.equal(learningReplay.processed, 0);
  assert.equal(learning.status().outcomes, 2, "each packet creates one learning outcome");

  const skillsFirst = await outcomes.drain("skills-handoff-test", (packet) => skills.captureExecutionOutcome(packet));
  const skillsReplay = await outcomes.drain("skills-handoff-test", (packet) => skills.captureExecutionOutcome(packet));
  assert.equal(skillsFirst.processed, 2);
  assert.equal(skillsReplay.processed, 0);
  assert.equal(skills.listCaptures({ limit: Infinity }).length, 2, "each packet creates one skill capture");
  assert.equal(skills.listSkills({ limit: Infinity }).length, 0, "capture does not synthesize, approve, route, or publish a skill");

  const disabledCandidates = new ProjectMemoryCandidatePipeline({ cwd, rollout: { controls: { candidateCapture: false } }, projectMemory: { enabled: true } });
  assert.equal(disabledCandidates.captureExecutionReference(loopPacket), null, "M0-style disabled candidate capture writes nothing");
  assert.equal(fs.existsSync(path.join(cwd, ".pi", "project-memory", "execution-candidates")), false);
  const enabledCandidates = new ProjectMemoryCandidatePipeline({ cwd, rollout: { controls: { candidateCapture: true } }, projectMemory: { enabled: true, save() { throw new Error("must not save"); } } });
  const candidate = enabledCandidates.captureExecutionReference(loopPacket);
  assert.equal(candidate.status, "requires-explicit-curator-review");
  assert.equal(candidate.automaticSave, false);
  assert.equal(fs.readdirSync(path.join(cwd, ".pi", "project-memory", "execution-candidates")).length, 1);
  assert.equal(fs.existsSync(path.join(cwd, ".pi", "project-memory", "entries")), false, "candidate reference is not canonical memory");

  const persisted = allText(path.join(cwd, ".pi"));
  assert.doesNotMatch(persisted, /Implement secret task|home\/private|sk-1234567890|rawHermesOutput|nextPrompt/, "packet and downstream records contain no prompt, raw output, secret, or absolute path");
  assert.match(persisted, /evidence_handoff_fixture/, "safe evidence references survive the handoff");

  const loopExtension = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "automation-loop", "index.ts"), "utf8");
  const goalExtension = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "goal", "index.ts"), "utf8");
  const learningExtension = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "learning-loop-coordinator", "index.ts"), "utf8");
  const reasoningExtension = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "reasoning-runtime", "index.ts"), "utf8");
  assert.match(`${loopExtension}\n${goalExtension}`, /PI_EXECUTION_OUTCOME_CAPTURE/);
  assert.match(learningExtension, /PI_EXECUTION_OUTCOME_LEARNING/);
  assert.match(reasoningExtension, /PI_EXECUTION_OUTCOME_SKILLS/);
  assert.doesNotMatch(goalExtension, /PI_GOAL_SYNC_FINAL|HermesClient|hermes\.ask/, "goal settlement is not synced to Hermes");

  const disabledRoot = temp();
  const disabled = new ExecutionOutcomeAdapter({ cwd: disabledRoot, enabled: false });
  assert.equal(disabled.buildLoopSettlement({}, {}), null);
  assert.equal(fs.existsSync(path.join(disabledRoot, ".pi", "execution-outcomes")), false, "capture flag can disable the producer without migration");

  console.log("settled-execution-handoff tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
