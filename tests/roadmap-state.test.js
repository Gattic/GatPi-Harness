"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  addItem,
  addSubtaskRoadmap,
  createPlanRoadmap,
  createRoadmap,
  findItem,
  formatRoadmapText,
  formatWidgetLines,
  getActivePath,
  getProgress,
  importFromReasoning,
  isRoadmapComplete,
  isRoadmapSettled,
  linkItem,
  loadRoadmap,
  parseStartArgs,
  revalidateEvidenceBindings,
  roadmapMutationMetadata,
  roadmapSnapshot,
  ROADMAP_ERROR_CODES,
  saveRoadmap,
  setActive,
  setStatus,
  setRoadmapLifecycle,
  finalReportSummary,
  startRoadmap,
  shouldClearCompletedRoadmapOnInput,
  stateFile,
} = require("../.pi/extensions/roadmap/roadmap-state.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-roadmap-state-");
const validateEvidenceId = () => ({ ok: true });

let roadmap = createRoadmap("Hybrid roadmap", ["Inspect state", "Implement widget", "Verify tests"]);
assert.equal(roadmap.title, "Hybrid roadmap");
assert.equal(roadmap.items.length, 3);
assert.equal(roadmap.items[0].status, "active", "first item should become active");
assert.equal(getProgress(roadmap).complete, 0);

roadmap = setStatus(roadmap, "1", "done", { evidenceId: "proof_1", validateEvidenceId });
assert.equal(roadmap.items[0].status, "done");
assert.deepEqual(roadmap.items[0].evidenceIds, ["proof_1"]);
assert.equal(roadmap.items[1].status, "active", "done should advance to next pending item");
assert.equal(getProgress(roadmap).complete, 1);

roadmap = setActive(roadmap, "3");
assert.equal(roadmap.items[2].status, "active");
assert.equal(roadmap.items[1].status, "pending");

roadmap = addItem(roadmap, "Document commands", { artifactId: "plan_abc", evidenceId: "proof_2", validateEvidenceId });
assert.equal(roadmap.items[3].id, "item-4");
assert.equal(roadmap.items[3].sourceArtifactId, "plan_abc");
assert.deepEqual(roadmap.items[3].artifactIds, ["plan_abc"]);
assert.deepEqual(roadmap.items[3].evidenceIds, ["proof_2"]);

roadmap = linkItem(roadmap, "4", { artifactId: "decision_1", evidenceId: "proof_3", validateEvidenceId, note: "linked manually" });
assert.ok(roadmap.items[3].artifactIds.includes("decision_1"));
assert.ok(roadmap.items[3].evidenceIds.includes("proof_3"));
assert.ok(roadmap.items[3].notes.includes("linked manually"));

const saved = saveRoadmap(tmp, roadmap);
assert.equal(fs.existsSync(stateFile(tmp)), true, "state should be durable JSON");
assert.equal(loadRoadmap(tmp).id, saved.id);
assert.equal(fs.statSync(path.dirname(stateFile(tmp))).mode & 0o777, 0o700);
assert.equal(fs.statSync(stateFile(tmp)).mode & 0o777, 0o600);
assert.match(formatRoadmapText(saved), /Hybrid roadmap/);
assert.ok(formatWidgetLines(saved).some((line) => line.includes("Document commands")));

const parsed = parseStartArgs("New roadmap :: a | b | c");
assert.equal(parsed.title, "New roadmap");
assert.deepEqual(parsed.items, ["a", "b", "c"]);
const compactParsed = parseStartArgs("Compact roadmap::one | two");
assert.equal(compactParsed.title, "Compact roadmap");
assert.deepEqual(compactParsed.items, ["one", "two"]);
assert.equal(parseStartArgs("").title, "Roadmap", "empty start should fall back to a usable title");

const executablePlan = createPlanRoadmap("Roadmap remediation", [
  { title: "Phase 0 — Baseline", goals: ["Freeze evidence", "Set bars"] },
  { title: "Phase 1 — Implement", goals: ["Build hierarchy", "Verify behavior"] },
], { source: "planner-plan" });
assert.equal(executablePlan.items.length, 2, "each milestone becomes one root task");
assert.equal(executablePlan.items[0].subtasks.length, 1, "each milestone owns one goals roadmap");
assert.equal(executablePlan.items[0].subtasks[0].title, "Phase 0 — Baseline goals");
assert.equal(findItem(executablePlan, "1.1.1").title, "Freeze evidence", "milestone goals become nested roadmap items");
assert.deepEqual(getActivePath(executablePlan).map(({ item }) => item.title), ["Phase 0 — Baseline", "Freeze evidence"]);
const displayPlan = setStatus(executablePlan, "1.1.1", "done");
const { viewer, ...displaySummary } = roadmapSnapshot(displayPlan);
assert.deepEqual(displaySummary, {
  title: "Roadmap remediation",
  lifecycle: "active",
  complete: 1,
  total: 6,
  blocked: 0,
  milestones: [{ title: "Phase 0 — Baseline", status: "active" }, { title: "Phase 1 — Implement", status: "pending" }],
  activePath: [{ title: "Phase 0 — Baseline", status: "active", path: "1" }, { title: "Set bars", status: "active", path: "1.1.2" }],
}, "snapshot publishes progress, milestones, and the active path for status consumers");
assert.equal(viewer.id, displayPlan.id);
assert.deepEqual(viewer.outcomes, { complete: 0, total: 2, blocked: 0 });
assert.equal(viewer.totalEntries, 8, "viewer includes subroadmap headings and every nested goal");
assert.deepEqual(viewer.entries.map(({ kind, path, title, status, notes }) => [kind, path, title, status, notes]), [
  ["item", "1", "Phase 0 — Baseline", "active", []],
  ["roadmap", "1.1", "Phase 0 — Baseline goals", "active", []],
  ["item", "1.1.1", "Freeze evidence", "done", []],
  ["item", "1.1.2", "Set bars", "active", []],
  ["item", "2", "Phase 1 — Implement", "pending", []],
  ["roadmap", "2.1", "Phase 1 — Implement goals", "active", []],
  ["item", "2.1.1", "Build hierarchy", "active", []], // Each subroadmap owns its local active pointer.
  ["item", "2.1.2", "Verify behavior", "pending", []],
]);
const notedPlan = linkItem(displayPlan, "1.1.2", { note: "Inspect the gate" });
assert.deepEqual(roadmapSnapshot(notedPlan).viewer.entries[3].notes, ["Inspect the gate"]);
assert.deepEqual(roadmapSnapshot(createRoadmap("Empty", [])).viewer.entries, []);
const largeDisplayPlan = createRoadmap("Large viewer", Array.from({ length: 600 }, (_, i) => ({ title: `${i} ${"界".repeat(500)}`, notes: ["x".repeat(1000)] })));
const largeViewer = roadmapSnapshot(largeDisplayPlan).viewer;
assert.equal(largeViewer.totalEntries, 600);
assert(largeViewer.entries.length > 0 && largeViewer.entries.length < 500);
assert(Buffer.byteLength(JSON.stringify(largeViewer.entries), "utf8") <= 64 * 1024);
assert.equal(largeViewer.entries[0].notes[0].length, 200);
assert.equal(roadmapSnapshot(null), null, "no roadmap publishes null");
assert.throws(() => createPlanRoadmap("Invalid plan", [{ title: "No goals", goals: [] }]), (error) => error.code === ROADMAP_ERROR_CODES.INVALID_OPERATION);
assert.throws(() => createPlanRoadmap("Blank milestone", [{ title: "   ", goals: ["Goal"] }]), (error) => error.code === ROADMAP_ERROR_CODES.INVALID_OPERATION);
assert.throws(() => createPlanRoadmap("Blank goal", [{ title: "Milestone", goals: ["   "] }]), (error) => error.code === ROADMAP_ERROR_CODES.INVALID_OPERATION);
let planParent = createRoadmap("Existing roadmap", ["Current objective"]);
const planParentId = planParent.id;
planParent = startRoadmap(planParent, "Nested executable plan", [], { milestones: [{ title: "Milestone", goals: ["Goal"] }], source: "planner-plan" });
assert.equal(planParent.id, planParentId, "an executable plan preserves an unfinished parent unless replacement is explicit");
assert.equal(findItem(planParent, "1.1.1.1.1").title, "Goal", "nested executable plans preserve the milestone/goal hierarchy");

const legacy = require("../.pi/extensions/roadmap/roadmap-state.js").normalizeRoadmap({
  version: 1,
  id: "legacy-roadmap",
  title: "Legacy flat roadmap",
  items: [{ id: "item-1", title: "Keep working", status: "active" }],
});
assert.equal(legacy.version, 3, "flat v1 state should normalize into the recursive schema");
assert.deepEqual(legacy.items[0].subtasks, [], "flat items migrate without inventing nested work");

let recursive = createRoadmap("Product roadmap", ["Implement feature", "Ship release"]);
const rootRoadmapId = recursive.id;
const beforeNested = recursive;
recursive = startRoadmap(recursive, "Commit current changes", ["Inspect diff", "Run checks", "Create commit"]);
const nestedMetadata = roadmapMutationMetadata(beforeNested, recursive);
assert.equal(nestedMetadata.nested, true);
assert.equal(nestedMetadata.parentRoadmapId, rootRoadmapId);
assert.equal(nestedMetadata.parentRoadmapTitle, "Product roadmap");
assert.equal(nestedMetadata.parentItemTitle, "Implement feature");
assert.equal(recursive.id, rootRoadmapId, "starting work during an active roadmap must preserve the root");
assert.equal(recursive.items[0].subtasks.length, 1, "new work should become a subtask roadmap on the active leaf");
assert.equal(recursive.items[0].subtasks[0].title, "Commit current changes");
assert.equal(findItem(recursive, "1.1.1").id, "item-1-1-1", "numeric paths should resolve nested items");
assert.equal(findItem(recursive, "item-1-1-2").title, "Run checks", "globally generated ids should resolve nested items");
assert.deepEqual(getActivePath(recursive).map(({ item }) => item.title), ["Implement feature", "Inspect diff"]);
assert.equal(getProgress(recursive).total, 5, "progress should include root and nested roadmap items");
assert.match(formatRoadmapText(recursive), /@1\.1 Commit current changes/);
assert.match(formatRoadmapText(recursive), /#1\.1\.1 Inspect diff/);
assert.ok(formatWidgetLines(recursive, { maxItems: 20 }).some((line) => line.includes("Run checks")));
assert.throws(() => setStatus(recursive, "1", "done"), /nested subtask roadmaps remain incomplete/, "parents cannot hide unfinished nested work");
assert.throws(() => addSubtaskRoadmap(recursive, "Misplaced work", ["No-op"], { parentId: "missing" }), (error) => error.code === ROADMAP_ERROR_CODES.MISSING_PARENT, "explicit invalid parents return a typed missing-parent error");

recursive = setStatus(recursive, "1.1.1", "done");
assert.equal(getProgress(recursive).active.title, "Run checks");
recursive = startRoadmap(recursive, "Fix verifier failure", ["Diagnose failure", "Repair failure"]);
assert.equal(recursive.items[0].subtasks[0].items[1].subtasks.length, 1, "subtask roadmaps should nest recursively under the active leaf");
assert.equal(findItem(recursive, "1.1.2.1.1").title, "Diagnose failure");
recursive = addItem(recursive, "Re-run verifier", { activeRoadmap: true });
assert.equal(findItem(recursive, "1.1.2.1.3").title, "Re-run verifier", "add can target the deepest active roadmap");
for (const ref of ["1.1.2.1.1", "1.1.2.1.2", "1.1.2.1.3"]) recursive = setStatus(recursive, ref, "done");
assert.equal(getProgress(recursive).active.title, "Run checks", "finishing an interruption should resume its parent item");
recursive = setStatus(recursive, "1.1.2", "done");
recursive = setStatus(recursive, "1.1.3", "done");
assert.equal(getProgress(recursive).active.title, "Implement feature", "finishing a subtask roadmap should resume the original root item");
recursive = addSubtaskRoadmap(recursive, "Post-commit handoff", ["Record commit"]);
assert.equal(recursive.items[0].subtasks.length, 2, "completed subtask roadmaps should remain as history when another is added");
assert.equal(findItem(recursive, "1.2.1").title, "Record commit");
recursive = setStatus(recursive, "1.2.1", "done");
recursive = setStatus(recursive, "1", "done");
recursive = setStatus(recursive, "2", "verified", { evidenceId: "proof_ship_release", validateEvidenceId });
assert.equal(isRoadmapSettled(recursive), true);
assert.equal(isRoadmapComplete(recursive), true);
const replacement = startRoadmap(recursive, "Next product roadmap", ["Plan next release"]);
assert.notEqual(replacement.id, rootRoadmapId, "starting after the recursive roadmap settles should create a new root");
assert.equal(replacement.title, "Next product roadmap");

const nestedSaved = saveRoadmap(tmp, recursive);
const nestedLoaded = loadRoadmap(tmp);
assert.deepEqual(nestedLoaded.items[0].subtasks, nestedSaved.items[0].subtasks, "recursive state should survive durable save/load");

let complete = createRoadmap("Finished roadmap", ["Ship", "Verify"]);
complete = setStatus(complete, "1", "done", { autoAdvance: true });
complete = setStatus(complete, "2", "verified", { evidenceId: "proof_verify", validateEvidenceId, autoAdvance: true });
assert.equal(isRoadmapComplete(complete), true, "all done/verified items should be complete");
assert.equal(shouldClearCompletedRoadmapOnInput(complete, { text: "next task", source: "interactive" }), true, "completed roadmaps clear on the next interactive user message");
assert.equal(shouldClearCompletedRoadmapOnInput(complete, { text: "next task", source: "rpc" }), true, "completed roadmaps clear on the next API user message");
assert.equal(shouldClearCompletedRoadmapOnInput(complete, { text: "/roadmap", source: "interactive" }), false, "commands should not auto-clear completed roadmaps");
assert.equal(shouldClearCompletedRoadmapOnInput(complete, { text: "follow-up", source: "extension" }), false, "extension-injected prompts should not auto-clear completed roadmaps");
assert.equal(shouldClearCompletedRoadmapOnInput(complete, { text: "ambiguous" }), false, "non-user/ambiguous input sources should not auto-clear completed roadmaps");
assert.equal(shouldClearCompletedRoadmapOnInput(roadmap, { text: "next task", source: "interactive" }), false, "incomplete roadmaps should stay visible");

fs.mkdirSync(path.join(tmp, ".pi", "cognitive-automation"), { recursive: true });
fs.writeFileSync(path.join(tmp, ".pi", "cognitive-automation", "reasoning-runtime.json"), JSON.stringify({
  version: 1,
  artifacts: [
    {
      id: "plan_scaffold",
      type: "plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      source: "model-scaffold",
      objective: "Generic scaffold",
      steps: [{ id: "understand", description: "Understand", status: "pending" }],
    },
    {
      id: "plan_real",
      type: "plan",
      createdAt: "2026-01-02T00:00:00.000Z",
      source: "command",
      objective: "Real plan",
      steps: [
        { id: "inspect", description: "Inspect code", status: "done" },
        { id: "build", description: "Build roadmap", status: "pending" },
      ],
    },
  ],
}, null, 2));

const imported = importFromReasoning(tmp);
assert.equal(imported.imported, true);
assert.equal(imported.artifactId, "plan_real", "should prefer non-scaffold reasoning artifacts");
assert.equal(imported.roadmap.title, "Real plan");
assert.equal(imported.roadmap.sourceArtifactId, "plan_real");
assert.equal(imported.roadmap.items[0].sourceArtifactId, "plan_real");
assert.equal(imported.roadmap.items[0].sourceStepId, "inspect");
assert.equal(imported.roadmap.items[0].status, "done");
assert.equal(imported.roadmap.items[1].status, "active", "import should ensure an active pending item");

fs.writeFileSync(path.join(tmp, ".pi", "cognitive-automation", "reasoning-runtime.json"), JSON.stringify({ artifacts: [], padding: "x".repeat(4096) }));
const oversizedImport = importFromReasoning(tmp, { maxBytes: 1024 });
assert.equal(oversizedImport.imported, false);
assert.equal(oversizedImport.oversized, true, "roadmap import refuses to parse oversized reasoning state");
assert.match(oversizedImport.reason, /oversized/);

assert.throws(() => setStatus(imported.roadmap, "missing", "done"), (error) => error.code === ROADMAP_ERROR_CODES.STALE_ITEM);
assert.throws(() => setStatus(imported.roadmap, "1", "nonsense"), (error) => error.code === ROADMAP_ERROR_CODES.INVALID_OPERATION);
const malformedRoot = tmpFixture("pi-roadmap-malformed-");
fs.mkdirSync(path.dirname(stateFile(malformedRoot)), { recursive: true });
fs.writeFileSync(stateFile(malformedRoot), "{not-json");
assert.throws(() => loadRoadmap(malformedRoot), (error) => error.code === ROADMAP_ERROR_CODES.PERSISTENCE_FAILED);

let outcomes = createPlanRoadmap("Canonical implementation", [{ title: "Feature A", goals: ["Deliver A"] }, { title: "Feature B", goals: ["Deliver B"] }]);
const rootId = outcomes.id;
assert.equal(startRoadmap(outcomes, outcomes.title).id, rootId);
assert.equal(getProgress(startRoadmap(outcomes, outcomes.title)).total, 4, "continuation does not nest a duplicate root");
assert.throws(() => startRoadmap(outcomes, outcomes.title, ["Smaller scope"]), /cannot redefine existing scope/);
assert.deepEqual(getProgress(outcomes).outcomes, { total: 2, complete: 0, verified: 0, substantiated: 0, blocked: 0 });
outcomes = addSubtaskRoadmap(outcomes, "Bounded verification", ["Run affected checks"], { parentId: "1.1.1" });
assert.equal(getProgress(outcomes).total, 5);
assert.equal(getProgress(outcomes).outcomes.total, 2, "helpers never inflate the required-outcome denominator");
outcomes = setStatus(outcomes, "1.1.1.1.1", "blocked", { note: "Missing observation for A" });
assert.equal(getProgress(outcomes).outcomes.blocked, 1, "blockers map to one root outcome, not their nesting count");
outcomes = setStatus(outcomes, "1.1.1.1.1", "done");
outcomes = setRoadmapLifecycle(outcomes, "closed", { roadmapId: "1.1.1.1" });
assert.equal(getActivePath(outcomes).at(-1).item.id, "item-1-1-1", "helper closure returns to the same unfinished delivery goal");
assert.equal(finalReportSummary(outcomes).completionClaimAllowed, false);
outcomes = setStatus(outcomes, "1.1.1", "done");
outcomes = setStatus(outcomes, "1", "done");
assert.deepEqual(getProgress(outcomes).outcomes, { total: 2, complete: 1, verified: 0, substantiated: 0, blocked: 0 });
assert.match(formatRoadmapText(outcomes), /outcomes 1\/2.*workflow/);
outcomes = setStatus(outcomes, "2.1.1", "skipped");
outcomes = setStatus(outcomes, "2", "skipped");
assert.equal(finalReportSummary(outcomes).completionClaimAllowed, false, "skipping required outcomes is not full-plan completion");
assert.equal(finalReportSummary(outcomes).verificationClaimAllowed, false, "done is implementation progress, not verifier evidence");
// Verification gate regression: a done root outcome backed by current evidence
// substantiates its outcome without a redundant verified label, while a done
// outcome without evidence or with revoked evidence still blocks the claim.
const mixedValidator = (id) => ({ ok: true, evidence: { fingerprint: `fp_${id}` } });
let mixed = createRoadmap("Mixed substantiation", ["Reproduce failure", "Fix root cause", "Verify fix"]);
mixed = setStatus(mixed, "1", "done", { evidenceId: "proof_repro", validateEvidenceId: mixedValidator });
mixed = setStatus(mixed, "3", "verified", { evidenceId: "proof_verify", validateEvidenceId: mixedValidator });
mixed = setStatus(mixed, "2", "done");
const partial = finalReportSummary(mixed);
assert.equal(partial.outcomes.complete, 3, "mixed done/verified case is complete");
assert.equal(partial.outcomes.substantiated, 2, "only evidence-backed root outcomes substantiate");
assert.equal(partial.verificationClaimAllowed, false, "a done outcome without evidence still blocks the verification claim");
mixed = setStatus(mixed, "2", "done", { evidenceId: "proof_fix", validateEvidenceId: mixedValidator });
const mixedReport = finalReportSummary(mixed);
assert.equal(mixedReport.outcomes.substantiated, 3);
assert.equal(mixedReport.counts.substantiatedOutcomes, 3);
assert.equal(mixedReport.completionClaimAllowed, true);
assert.equal(mixedReport.verificationClaimAllowed, true, "done-with-evidence plus verified-with-evidence substantiates every root outcome");
const revoked = finalReportSummary(revalidateEvidenceBindings(mixed, () => ({ ok: false, reason: "evidence-revoked" })));
assert.equal(revoked.outcomes.substantiated, 0, "revoked evidence stops substantiating outcomes");
assert.equal(revoked.verificationClaimAllowed, false, "revoked evidence cannot support a verification claim");
console.log("roadmap-state tests passed");
