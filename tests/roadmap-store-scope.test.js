"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  ROADMAP_ERROR_CODES,
  addItems,
  adoptRoadmap,
  createPlanRoadmap,
  createRoadmap,
  getProgress,
  linkItems,
  loadRoadmap,
  roadmapDir,
  roadmapMutationEnvelope,
  roadmapRoot,
  roadmapStoreCandidates,
  saveRoadmap,
  setRoadmapSessionScope,
  setStatusMany,
  stateFile,
} = require("../.pi/extensions/roadmap/roadmap-state.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

function git(args, cwd) {
  return execFileSync("git", ["-c", "user.name=Roadmap Test", "-c", "user.email=roadmap@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// --- Store location: worktree/project root, not the raw working directory ---
const repoRoot = tmpFixture("pi-roadmap-scope-repo-");
git(["init", "-q"], repoRoot);
fs.writeFileSync(path.join(repoRoot, "README.md"), "root\n");
git(["add", "."], repoRoot);
git(["commit", "-qm", "init"], repoRoot);
const nested = path.join(repoRoot, "src", "nested");
fs.mkdirSync(nested, { recursive: true });
assert.equal(roadmapRoot(nested), path.join(repoRoot, ".pi", "roadmap"), "a nested working directory shares its project's roadmap store");

const worktreeRoot = path.join(repoRoot, ".worktrees", "task");
git(["worktree", "add", "-q", worktreeRoot, "-b", "task-branch"], repoRoot);
assert.equal(roadmapRoot(worktreeRoot), path.join(worktreeRoot, ".pi", "roadmap"), "each Git worktree owns an independent roadmap store");
assert.notEqual(roadmapRoot(worktreeRoot), roadmapRoot(repoRoot), "worktree roadmaps never collapse into the primary checkout store");

const plainRoot = tmpFixture("pi-roadmap-scope-plain-");
assert.equal(roadmapRoot(plainRoot), path.join(plainRoot, ".pi", "roadmap"), "non-Git directories fall back to their own project root");

// --- Session binding: one roadmap per session inside one directory ---
const sharedRoot = tmpFixture("pi-roadmap-scope-sessions-");
setRoadmapSessionScope(null);
assert.equal(roadmapDir(sharedRoot), path.join(sharedRoot, ".pi", "roadmap"), "unscoped callers keep the directory-level store");

setRoadmapSessionScope("session-a");
assert.equal(roadmapDir(sharedRoot), path.join(sharedRoot, ".pi", "roadmap", "sessions", "session-a"));
let sessionA = saveRoadmap(sharedRoot, createRoadmap("Session A plan", ["A step"]));
assert.equal(fs.existsSync(stateFile(sharedRoot)), true, "the session roadmap is persisted in its own store");
assert.equal(fs.existsSync(path.join(sharedRoot, ".pi", "roadmap", "active.json")), false, "a session write never populates the shared directory store");

setRoadmapSessionScope("session-b");
assert.equal(loadRoadmap(sharedRoot), null, "a second session does not inherit the first session's roadmap");
const sessionB = saveRoadmap(sharedRoot, createRoadmap("Session B plan", ["B step"]));
setRoadmapSessionScope("session-a");
assert.equal(loadRoadmap(sharedRoot).title, "Session A plan", "each session reloads its own roadmap");
setRoadmapSessionScope("session-b");
assert.equal(loadRoadmap(sharedRoot).title, "Session B plan");

assert.equal(loadRoadmap(sharedRoot, { sessionId: "session-a" }).title, "Session A plan", "an explicit session scope overrides the module default");
assert.equal(stateFile(sharedRoot, { sessionId: "session-b" }), path.join(sharedRoot, ".pi", "roadmap", "sessions", "session-b", "active.json"));
assert.equal(loadRoadmap(sharedRoot, { sessionId: null }), null, "the directory-level store stays empty while sessions write their own");

// --- Multiple roadmaps per directory: discovery and explicit adoption ---
setRoadmapSessionScope("session-c");
const candidates = roadmapStoreCandidates(sharedRoot);
assert.deepEqual(candidates.map((entry) => entry.roadmapId).sort(), [sessionA.id, sessionB.id].sort(), "candidates span every session store in the directory");
assert.equal(candidates.find((entry) => entry.roadmapId === sessionA.id).sessionId, "session-a");

const sourcePacket = fs.readFileSync(stateFile(sharedRoot, { sessionId: "session-a" }), "utf8");
const adopted = adoptRoadmap(sharedRoot, sessionA.id);
assert.equal(adopted.id, sessionA.id, "adoption binds the existing roadmap to this session");
assert.deepEqual(adopted.adoptedFrom, { sessionId: "session-a", roadmapId: sessionA.id, adoptedAt: adopted.adoptedFrom.adoptedAt });
assert.equal(loadRoadmap(sharedRoot).title, "Session A plan");
assert.equal(fs.readFileSync(stateFile(sharedRoot, { sessionId: "session-a" }), "utf8"), sourcePacket, "adoption never rewrites the owning session's packet");
assert.equal(loadRoadmap(sharedRoot, { sessionId: "session-a" }).adoptedFrom, undefined, "the source roadmap keeps its own provenance");
assert.throws(() => adoptRoadmap(sharedRoot, "roadmap_missing"), (error) => error.code === ROADMAP_ERROR_CODES.STALE_ITEM);
setRoadmapSessionScope("session-a");
assert.throws(() => adoptRoadmap(sharedRoot, sessionA.id), (error) => error.code === ROADMAP_ERROR_CODES.INVALID_OPERATION, "a session cannot adopt the roadmap it already owns");

// Adoption never replaces a roadmap the session is already working on.
setRoadmapSessionScope("session-d");
const sessionD = saveRoadmap(sharedRoot, createRoadmap("Session D plan", ["D step"]));
assert.throws(() => adoptRoadmap(sharedRoot, sessionB.id), (error) => error.code === ROADMAP_ERROR_CODES.INVALID_OPERATION && /already has roadmap/.test(error.message), "adopting over an active session roadmap is rejected instead of silently replacing it");
assert.equal(loadRoadmap(sharedRoot).id, sessionD.id, "a rejected adoption leaves the session's roadmap intact");

// Ids that cannot be directory names still get a private store.
const longScope = setRoadmapSessionScope("a".repeat(120));
assert.match(longScope, /^session-[a-f0-9]{16}$/, "an over-long session id maps to a safe private store");
assert.equal(roadmapDir(sharedRoot), path.join(sharedRoot, ".pi", "roadmap", "sessions", longScope), "an unusable session id never falls back to the shared directory store");
const escapeScope = setRoadmapSessionScope("../escape");
assert.match(escapeScope, /^session-[a-f0-9]{16}$/, "path-like session ids map to a safe store instead of escaping the roadmap directory");
assert.notEqual(escapeScope, longScope);
setRoadmapSessionScope("a".repeat(120));
assert.equal(roadmapDir(sharedRoot), path.join(sharedRoot, ".pi", "roadmap", "sessions", longScope), "the hashed store is stable across turns");

// --- Worktree isolation holds even for the same session id ---
setRoadmapSessionScope(null);
saveRoadmap(repoRoot, createRoadmap("Primary checkout plan", ["Root step"]), { sessionId: "shared-session" });
saveRoadmap(worktreeRoot, createRoadmap("Worktree plan", ["Worktree step"]), { sessionId: "shared-session" });
assert.equal(loadRoadmap(repoRoot, { sessionId: "shared-session" }).title, "Primary checkout plan");
assert.equal(loadRoadmap(worktreeRoot, { sessionId: "shared-session" }).title, "Worktree plan", "the same session id keeps separate roadmaps per worktree");

// --- Batch status updates ---
const batchPlan = createPlanRoadmap("Batch plan", [
  { title: "Phase 1", goals: ["Goal A", "Goal B"] },
  { title: "Phase 2", goals: ["Goal C"] },
]);
const settled = setStatusMany(batchPlan, ["1", "2"], "done", { cascade: true });
const settledProgress = getProgress(settled);
assert.equal(settledProgress.complete, settledProgress.total, "one batched call settles both milestones and their goals");
assert.equal(settledProgress.actionable, 0);
assert.deepEqual(settled.items[0].subtasks[0].items.map((item) => item.status), ["done", "done"]);
assert.equal(settled.items[1].subtasks[0].items[0].status, "done");
assert.equal(getProgress(batchPlan).complete, 0, "batching returns a new state instead of mutating the previous one");

const batchSnapshot = JSON.stringify(batchPlan);
assert.throws(() => setStatusMany(batchPlan, ["1", "missing"], "done"), (error) => error.code === ROADMAP_ERROR_CODES.STALE_ITEM);
assert.equal(JSON.stringify(batchPlan), batchSnapshot, "a rejected batch reference leaves the caller's state untouched");

let blockedPlan = createPlanRoadmap("Blocked plan", [{ title: "Phase", goals: ["Ready goal", "Blocked goal"] }]);
blockedPlan = setStatusMany(blockedPlan, ["1.1.2"], "blocked");
assert.throws(() => setStatusMany(blockedPlan, ["1"], "done", { cascade: true }), (error) => error.code === ROADMAP_ERROR_CODES.INVALID_OPERATION, "cascade cannot settle a phase with a deliberately blocked goal");
assert.equal(getProgress(blockedPlan).blocked, 1, "cascade never overrides nonactionable descendants");

const mutationBefore = createPlanRoadmap("Delta plan", [{ title: "Phase 1", goals: ["Goal A", "Goal B"] }]);
const mutationAfter = setStatusMany(mutationBefore, ["1"], "done", { cascade: true });
const mutation = roadmapMutationEnvelope(mutationBefore, mutationAfter, "set_status");
assert.equal(mutation.envelope.delta.changedCount, 3, "the envelope reports every settled descendant");
assert.deepEqual([...mutation.envelope.delta.appliedIds].sort(), ["item-1", "item-1-1-1", "item-1-1-2"].sort(), "batched mutations report applied ids in one bounded delta");

// --- Batch add and link ---
let addedItems = createRoadmap("Batch add", ["First"]);
addedItems = addItems(addedItems, ["Second", "Third"]);
assert.deepEqual(addedItems.items.map((item) => item.title), ["First", "Second", "Third"], "one call adds several roadmap items");

const validateEvidenceId = (evidenceId) => ({ ok: true, evidence: { fingerprint: `packet-${evidenceId}` } });
let linkedItems = createRoadmap("Batch link", ["One", "Two"]);
linkedItems = linkItems(linkedItems, ["1", "2"], { evidenceId: "proof_batch", validateEvidenceId });
assert.deepEqual(linkedItems.items.map((item) => item.evidenceIds), [["proof_batch"], ["proof_batch"]]);
assert.equal(getProgress(linkedItems).evidenceBindings, 2, "one call links several items to the same evidence packet");

setRoadmapSessionScope(null);

// Discovery stays bounded per turn, while adoption still reaches every store.
const boundedRoot = tmpFixture("pi-roadmap-scope-bounded-");
for (let index = 0; index < 30; index += 1) saveRoadmap(boundedRoot, createRoadmap(`Bounded plan ${index}`, [`Step ${index}`]), { sessionId: `session-${index}` });
const window = roadmapStoreCandidates(boundedRoot, { limit: 5 });
assert.equal(window.length, 5, "per-turn discovery is bounded to the most recently touched stores");
const everything = roadmapStoreCandidates(boundedRoot, { limit: 0 });
assert.equal(everything.length, 30);
const outsideWindow = everything.find((entry) => !window.some((recent) => recent.roadmapId === entry.roadmapId));
assert(outsideWindow, "the full listing spans every session store");
setRoadmapSessionScope("session-new");
const lateAdoption = adoptRoadmap(boundedRoot, outsideWindow.roadmapId);
assert.equal(lateAdoption.id, outsideWindow.roadmapId, "adoption reaches session stores outside the discovery window");
assert.equal(roadmapStoreCandidates(boundedRoot, { limit: 0 }).filter((entry) => entry.roadmapId === outsideWindow.roadmapId).length, 1, "adopted copies collapse into one candidate per roadmap id");

console.log("roadmap store scope tests passed");
