"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { dryRunWorkerRecommendation } = require("../scripts/dry-run-worker-recommendation");

const project = path.join(__dirname, "..");
const result = dryRunWorkerRecommendation({
  project,
  task: "Read only config/harness-defaults.env and report the exact PI_ROLE_MUTATION value; do not edit files.",
});

assert.deepEqual(result.controls, { rolloutStage: "R0", routerMode: "suggest", roleMutation: "off" });
assert.deepEqual(result.decision, { mode: "suggest", intent: "research", reasonCode: "bounded-readonly-worker-task", execute: false, topologyId: null });
assert.deepEqual(result.recommendation, {
  schemaVersion: 1,
  roleId: "worker",
  model: "local/DeepSeek-V4.1-Flash-1017",
  thinkingLevel: "low",
  workspacePolicy: "shared-readonly",
  mutationPolicy: "forbidden",
  autoRoutePolicy: "suggest",
  execute: false,
  advisoryOnly: true,
});
assert.deepEqual(result.effects, { providerCalls: 0, subagentsStarted: 0, topologiesStarted: 0, roleMutations: 0, filesMutated: 0, worktreeStatusUnchanged: true });
assert.match(result.taskHash, /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(result).includes("Read only config"), false, "dry-run output stores only a task hash");

assert.throws(() => dryRunWorkerRecommendation({ project, task: "Investigate the entire architecture and diagnose all risks; read only and make no changes." }), /not eligible for a safe worker recommendation/);
assert.throws(() => dryRunWorkerRecommendation({
  project,
  task: "Read only config/harness-defaults.env and report the exact PI_ROLE_MUTATION value; do not edit files.",
  env: { PI_ROLE_ROLLOUT_STAGE: "R5" },
}), /requires explicit R0\/suggest\/mutation-off controls/);

console.log("worker recommendation dry-run tests passed");
