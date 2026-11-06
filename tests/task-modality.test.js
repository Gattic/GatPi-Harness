#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  TASK_MODALITIES,
  classifyTaskModality,
  buildTaskScaffold,
  buildTaskDecomposition,
  containsUnauthorizedMutationStep,
} = require("../src/task-modality.js");

assert(TASK_MODALITIES.includes("credential"));
const corpus = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "task-modality-corpus.json"), "utf8"));
assert.equal(corpus.length, 7, "fixed corpus covers every required task modality");
for (const row of corpus) {
  const classification = classifyTaskModality(row.prompt);
  assert.equal(classification.modality, row.modality, row.id);
  assert.equal(classification.readOnly, row.readOnly, `${row.id} read-only boundary`);
  assert.equal(classification.requiresConfirmation, row.requiresConfirmation, `${row.id} confirmation boundary`);
  assert.equal(classification.automaticDelegationAllowed, !row.requiresConfirmation, `${row.id} automatic delegation boundary`);
  const scaffold = buildTaskScaffold(row.prompt);
  const decomposition = buildTaskDecomposition(row.prompt);
  assert.equal(scaffold.objective, row.prompt, `${row.id} preserves the objective exactly`);
  assert.equal(decomposition.task, row.prompt, `${row.id} preserves the task exactly`);
  assert(scaffold.constraints.every((constraint) => row.prompt.includes(constraint)), `${row.id} constraints remain public prompt substrings`);
  assert.deepEqual(scaffold.constraints, decomposition.constraints, `${row.id} preserves constraints across public artifacts`);
  assert.equal(containsUnauthorizedMutationStep(scaffold), false, `${row.id} scaffold contains no unauthorized mutation step`);
  assert.equal(containsUnauthorizedMutationStep(decomposition), false, `${row.id} decomposition contains no unauthorized mutation step`);
  assert.equal(JSON.stringify({ scaffold, decomposition }).match(/scratchpad|chain.of.thought|hidden reasoning/gi), null, `${row.id} exposes no scratchpad`);
}

const verification = buildTaskDecomposition("Run focused tests and report failures; do not fix anything.");
assert.equal(verification.modality, "verification");
assert(!JSON.stringify(verification.subtasks).match(/\b(?:fix|repair|apply|edit)\b/i), "verification-only decomposition never implies repair");
const repair = buildTaskDecomposition("Verify the bug, fix it, and rerun tests.");
assert.equal(repair.modality, "implementation", "explicit repair outranks verification-only intent");
const completionPrompts = [
  "Finish native resource-manager/executor integration, asset formats, dynamic instance/skin/indirect buffers, asynchronous streaming and capture.",
  "Using your feedback and recommendations, finish our Vulkan implementation plan in full.",
  "Complete M3 and M4 in full.",
  "Do not narrow the scope. Implement the full M3 and M4 in full.",
  "Execute the existing implementation plan.",
  "Continue implementing the remaining milestones.",
  "Implement only the authorized parser changes.",
  "Implement the parser. Do not edit the sibling SDK.",
  "Review the parser and fix its off-by-one bug.",
];
for (const prompt of completionPrompts) {
  for (const judged of [undefined, { modality: "planning", confidence: 1 }, { modality: null }]) {
    const scaffold = buildTaskScaffold(prompt, { judged });
    assert.equal(scaffold.modality, "implementation", prompt);
    assert.equal(scaffold.policy.requiresConfirmation, false);
    assert.match(scaffold.successCriteria.join(" "), /all required outcomes/);
    assert.doesNotMatch(JSON.stringify(scaffold.steps), /without implementing|no mutation/);
  }
}
for (const [prompt, modality] of [
  ["Plan how to finish the implementation.", "planning"],
  ["Review the implementation without edits.", "investigation"],
  ["Report what remains.", "answer"],
  ["Complete the plan without implementing it.", "planning"],
  ["Continue, but do not edit files.", "answer"],
]) {
  assert.equal(classifyTaskModality(prompt, { judged: { modality: "implementation", confidence: 1 } }).modality, modality, prompt);
}
for (const prompt of [
  "Did we implement all of the recommendations in plan-update.md in full?",
  "Did we implement all of the\nrecommendations in plan-update.md in full?",
  "Have we completed the plan?",
  "Is the implementation complete?",
  "Are all required updates finished?",
  "Was the migration finished?",
  "Did we deploy the changes?",
  "Have we deleted the old files?",
]) {
  for (const judged of [undefined, { modality: "implementation", confidence: 1 }, { modality: null }]) {
    const scaffold = buildTaskScaffold(prompt, { judged });
    assert.equal(scaffold.modality, "answer", prompt);
    assert.equal(scaffold.policy.readOnly, true);
    assert.equal(scaffold.policy.mutationAllowed, false);
    assert.equal(scaffold.policy.requiresConfirmation, false, "asking about a protected action is not requesting it");
    assert.equal(scaffold.objective, prompt);
    assert.equal(containsUnauthorizedMutationStep(scaffold), false);
    const decomposition = buildTaskDecomposition(prompt, { judged });
    assert.equal(decomposition.modality, "answer");
    assert.equal(containsUnauthorizedMutationStep(decomposition), false);
  }
}
for (const [prompt, modality] of [
  ["Did we finish? Implement what remains.", "implementation"],
  ["Did we implement the\nplan?\nImplement what remains.", "implementation"],
  ["Is the parser complete? Review it and fix any defects.", "implementation"],
  ["Have we completed the plan? Do not edit files.", "answer"],
  ["Did we implement the changes? Deploy them now.", "publish"],
  ["Is the migration complete? Delete the old data.", "destructive"],
  ["Can you implement the rest?", "implementation"],
  ["Could you complete the plan?", "implementation"],
]) {
  assert.equal(classifyTaskModality(prompt).modality, modality, prompt);
}
for (const [prompt, modality] of [
  ["Implement the parser. Do not commit or push.", "implementation"],
  ["Review the parser without deleting files.", "investigation"],
  ["Fix the parser. Never rotate the API key.", "implementation"],
  ["Do not commit or push.", "unclassified"],
  ["Review the parser. Fix any defects.", "implementation"],
  ["Review the parser; complete the implementation.", "implementation"],
  ["Review the parser\nThen repair the bug.", "implementation"],
  ["Review the parser and explain how to fix it.", "investigation"],
  ["Review the parser and report what changes remain.", "investigation"],
]) {
  for (const judged of [undefined, { modality: "planning", confidence: 1 }, { modality: null }]) {
    const scaffold = buildTaskScaffold(prompt, { judged });
    assert.equal(scaffold.modality, modality, prompt);
    assert.equal(scaffold.policy.requiresConfirmation, false, prompt);
    assert.equal(buildTaskDecomposition(prompt, { judged }).modality, modality, prompt);
  }
}
const restrictedImplementation = buildTaskScaffold("Implement the parser. Do not commit or push.");
assert(restrictedImplementation.constraints.includes("Do not commit or push."));
const scopedRestriction = buildTaskScaffold("Implement the parser. Do not edit the sibling SDK.");
assert(scopedRestriction.constraints.includes("Do not edit the sibling SDK."), "scoped restrictions are preserved without prohibiting independent authorized work");
assert.equal(classifyTaskModality("Do not edit the sibling SDK.").mutationAllowed, false, "a negative clause alone is never an implementation request");
const judgedParent = buildTaskScaffold("make the button blue", { judged: { modality: "implementation", confidence: 0.9 } });
assert.equal(buildTaskScaffold("Continue", { parentTask: judgedParent, judged: { modality: "answer" } }).modality, "implementation", "a fresh continuation judgment cannot replace the established parent task");
const parentTask = buildTaskScaffold("Implement the full parser plan. Preserve the public API.");
for (const prompt of ["Continue", "Continue the implementation", "Resume the plan", "Carry on."]) {
  const next = buildTaskScaffold(prompt, { parentTask, judged: { modality: "planning", confidence: 1 } });
  assert.equal(next.objective, parentTask.objective);
  assert.equal(next.modality, "implementation");
  assert.deepEqual(next.constraints, parentTask.constraints);
  assert.equal(buildTaskDecomposition(prompt, { parentTask }).task, parentTask.objective);
}
assert.equal(classifyTaskModality("Continue", { judged: { modality: "implementation" } }).modality, "unclassified");
assert.equal(classifyTaskModality("Continue", { parentTask: { objective: "Continue" } }).modality, "unclassified");
assert.equal(classifyTaskModality("Continue", { parentTask: buildTaskScaffold("Review the plan without edits") }).readOnly, true);
for (const prompt of ["Complete the plan and deploy it", "Finish by deleting the old data", "Complete rotation: rotate the API key"]) {
  assert.equal(classifyTaskModality(prompt, { judged: { modality: "implementation" } }).requiresConfirmation, true, prompt);
}
const { taskObjectiveFromSession, USER_TASK_ENTRY_TYPE } = require("../src/task-modality");
assert.equal(taskObjectiveFromSession([
  { type: "custom", customType: USER_TASK_ENTRY_TYPE, data: { objective: parentTask.objective } },
  { type: "message", message: { role: "user", content: parentTask.objective } },
  { type: "message", message: { role: "assistant", content: "Finished a prerequisite" } },
  { type: "custom_message", content: "planning only" },
  { type: "custom", customType: USER_TASK_ENTRY_TYPE, data: { objective: "Continue" } },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "Continue" }] } },
  { type: "message", message: { role: "user", content: "Extension-authored control prompt" } },
]), parentTask.objective);
assert.equal(taskObjectiveFromSession([{ type: "message", message: { role: "user", content: "Implement this" } }]), "", "role=user alone does not establish input provenance");
assert.equal(taskObjectiveFromSession([]), "");
console.log("task modality tests passed");
