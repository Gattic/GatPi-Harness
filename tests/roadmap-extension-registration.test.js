"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "roadmap", "index.ts"), "utf8");
const stateSource = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "roadmap", "roadmap-state.js"), "utf8");

for (const command of [
  "roadmap",
  "roadmap-panel",
  "roadmap-start",
  "roadmap-subtask",
  "roadmap-replace",
  "roadmap-add",
  "roadmap-active",
  "roadmap-adopt",
  "roadmap-done",
  "roadmap-verify",
  "roadmap-block",
  "roadmap-skip",
  "roadmap-close",
  "roadmap-shelve",
  "roadmap-resume",
  "roadmap-archive",
  "roadmap-link",
  "roadmap-next",
  "roadmap-import-reasoning",
  "roadmap-from-reasoning",
  "roadmap-report",
  "roadmap-export",
  "roadmap-clear",
]) {
  assert(source.includes(`pi.registerCommand("${command}"`), `${command} command should be registered`);
}

assert(source.includes('pi.registerTool({\n    name: "roadmap_update"'), "roadmap_update tool should be registered");
assert(source.includes('ctx.ui.setWidget("roadmap"'), "roadmap should render a checklist widget");
assert(source.includes('ctx.ui.setStatus?.("roadmap"'), "roadmap should render footer status");
assert(source.includes('pi.on("input"'), "roadmap should inspect user sends for auto-clear");
assert(source.includes('pi.on("before_agent_start"'), "roadmap should own standalone per-turn guidance independently of topology");
assert(source.includes('Use roadmap_update proactively for substantive multi-step work'), "roadmap should not wait for explicit tracking requests");
assert(source.includes('pi.getActiveTools().includes("roadmap_update")'), "roadmap context must respect active tool restrictions");
assert(source.includes('shouldClearCompletedRoadmapOnInput(current, event)'), "roadmap should clear completed checklists on the next user send");
assert(source.includes('{ placement: "aboveEditor" }'), "roadmap widget should sit above the editor");
assert(source.includes('pi.events.emit("roadmap:changed", roadmapSnapshot(current))'), "roadmap should publish every presented state on the extension bus");
assert(!/^\s+renderRoadmapWidget\(ctx, state\);$/m.test(source), "state changes should go through present() so they are published");
assert(source.includes('overlay: true'), "roadmap-panel should use an overlay");
assert(source.includes('formatRoadmapText(current)'), "roadmap command should show text fallback");
assert(source.includes('importFromReasoning(ctx.cwd)'), "roadmap should import reasoning artifacts on demand");
assert(source.includes('stateFile(ctx.cwd)'), "roadmap should report durable JSON state path");
assert(source.includes('StringEnum(ACTION_VALUES)'), "roadmap_update action should be an enum");
assert(source.includes('StringEnum(STATUS_VALUES)'), "roadmap_update status should be an enum");
assert(source.includes('"add_subtask"') && source.includes('"replace"'), "roadmap_update should expose safe nesting and explicit replacement actions");
assert(source.includes('parentId: Type.Optional') && source.includes('roadmapId: Type.Optional'), "roadmap_update should accept recursive item and roadmap targets");
assert(source.includes('milestones: Type.Optional') && source.includes('MILESTONE_SCHEMA'), "roadmap_update should accept an atomic executable-plan hierarchy");
assert(source.includes('each phase/milestone must be a roadmap task'), "tool guidance should map plan milestones to tasks and goals to nested roadmaps");
assert(source.includes('never use action=replace unless the user explicitly wants'), "tool guidance should protect parent roadmaps from incidental replacement");

assert(stateSource.includes('function stateFile'), "roadmap-state should expose durable state path");
assert(stateSource.includes('".pi", "roadmap"') && stateSource.includes('"active.json"'), "state should live in .pi/roadmap/active.json");
assert(stateSource.includes('reasoning-runtime.json'), "state should know how to read reasoning runtime artifacts");
assert(stateSource.includes('sourceArtifactId'), "roadmap items should support reasoning artifact links");
assert(stateSource.includes('evidenceIds'), "roadmap items should support verifier evidence links");
assert(stateSource.includes('function importFromReasoning'), "roadmap should provide reasoning import helper");
assert(stateSource.includes('function shouldClearCompletedRoadmapOnInput'), "roadmap-state should expose auto-clear policy");
assert(stateSource.includes('model-scaffold'), "reasoning import should distinguish scaffold artifacts");
assert(stateSource.includes('const ROADMAP_VERSION = 3'), "actionable/evidence-backed roadmaps should use the version 3 state schema");
assert(stateSource.includes('function addSubtaskRoadmap'), "roadmap state should support nested subtask roadmaps");
assert(stateSource.includes('function createPlanRoadmap'), "roadmap state should compile plan milestones and goals atomically");
assert(stateSource.includes('function startRoadmap'), "roadmap starts should preserve active parent roadmaps by nesting");
assert(stateSource.includes('ROADMAP_STALE_ITEM') && stateSource.includes('ROADMAP_INVALID_OPERATION') && stateSource.includes('ROADMAP_PARENT_REQUIRED') && stateSource.includes('ROADMAP_EVIDENCE_REQUIRED') && stateSource.includes('ROADMAP_STALE_EVIDENCE') && stateSource.includes('ROADMAP_PERSISTENCE_FAILED'), "roadmap errors should be typed");
assert(stateSource.includes('function roadmapMutationMetadata'), "nested starts should expose parent roadmap metadata");
assert(stateSource.includes('subtasks:'), "roadmap items should persist recursive subtask roadmaps");
assert(stateSource.includes('function roadmapMutationEnvelope'), "ordinary mutations should emit a schema-versioned compact delta envelope");
assert(stateSource.includes('function roadmapPage'), "explicit show/export should support bounded paging and focus");
assert(stateSource.includes('function setRoadmapLifecycle'), "roadmaps should support explicit close/shelve/resume/archive lifecycle semantics");
assert(stateSource.includes('itemContentFingerprint') && stateSource.includes('evidenceBindings'), "verification evidence should bind to current item content");
assert(stateSource.includes('FileIntegrationStorage'), "roadmap persistence should use atomic private no-follow storage");
assert(source.includes('pi.registerCommand("roadmap-adopt"'), "roadmap should register an explicit adopt command");
assert(source.includes('itemIds: Type.Optional') && source.includes('cascade: Type.Optional'), "roadmap_update should accept batched item ids and cascade");
assert(source.includes('setRoadmapSessionScope') && source.includes('roadmapStoreCandidates'), "roadmap should bind state to the session scope and discover directory roadmaps");
assert(stateSource.includes('function resolveProjectRoot') && stateSource.includes('function roadmapRoot'), "roadmap store should resolve the worktree/project root instead of the raw cwd");
assert(stateSource.includes('SESSION_STORE_DIR') && stateSource.includes('function setRoadmapSessionScope'), "roadmap state should persist one store per session inside the directory");
assert(stateSource.includes('function roadmapStoreCandidates') && stateSource.includes('function adoptRoadmap'), "roadmap state should expose directory candidates and explicit adoption");
assert(stateSource.includes('function setStatusMany') && stateSource.includes('function descendantLocations'), "batched status updates should cascade to nested descendants");
assert(!source.includes('details = { ok: true, outcome: "succeeded", operation: action, roadmap: current'), "mutation details should not duplicate full roadmap state");

console.log("roadmap extension registration tests passed");
