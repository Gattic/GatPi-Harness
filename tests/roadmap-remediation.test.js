"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  ROADMAP_ERROR_CODES,
  addSubtaskRoadmap,
  archiveIndexFile,
  archiveRoadmapPacket,
  createRoadmap,
  finalReportSummary,
  getProgress,
  hasCurrentEvidence,
  lastKnownGoodFile,
  linkItem,
  loadRoadmap,
  normalizeRoadmap,
  roadmapInputDisposition,
  roadmapMutationEnvelope,
  roadmapPage,
  saveRoadmap,
  setRoadmapLifecycle,
  setStatus,
  startRoadmap,
  stateFile,
} = require("../.pi/extensions/roadmap/roadmap-state.js");
const {
  ROADMAP_COHORT_VERSION,
  createRoadmapFieldReport,
  createRoadmapTelemetryEvent,
  readRoadmapTelemetry,
  recordRoadmapTelemetry,
  roadmapCohortVersion,
  roadmapOpportunityEligible,
  summarizeRoadmapTelemetry,
} = require("../src/roadmap-telemetry.js");
const { applyRoadmapPlan } = require("../src/roadmap-plan-application.js");
const { EvidenceStore } = require("../src/evidence-binder.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}
function fullPagedChars(state) {
  let offset = 0;
  let total = 0;
  for (;;) {
    const page = roadmapPage(state, { offset, limit: 200, maxChars: 20000 });
    total += page.text.length;
    if (!page.hasMore) return total;
    offset = page.nextOffset;
  }
}

const manifestFile = path.join(__dirname, "fixtures", "roadmap", "large-roadmap-manifest.json");
const manifestText = fs.readFileSync(manifestFile, "utf8");
const manifest = JSON.parse(manifestText);
const fixtureHash = crypto.createHash("sha256").update(manifestText).digest("hex");
assert.match(fixtureHash, /^[a-f0-9]{64}$/);
assert.match(roadmapCohortVersion(path.resolve(__dirname, "..")), /^roadmap-v3-2026-07-27-[a-f0-9]{16}$/, "the exact cohort resets from a source/config fingerprint");
const externalProject = tmpFixture("pi-roadmap-external-project-");
assert.match(roadmapCohortVersion(externalProject), /^roadmap-v3-2026-07-27-[a-f0-9]{16}$/, "ordinary projects retain the installed source fingerprint instead of collapsing to a static cohort");
const syntheticSource = tmpFixture("pi-roadmap-source-version-");
fs.mkdirSync(path.join(syntheticSource, "src"), { recursive: true });
fs.writeFileSync(path.join(syntheticSource, "src", "roadmap-telemetry.js"), "version-a");
const syntheticVersionA = roadmapCohortVersion(externalProject, { sourceRoot: syntheticSource });
fs.writeFileSync(path.join(syntheticSource, "src", "roadmap-telemetry.js"), "version-b");
assert.notEqual(roadmapCohortVersion(externalProject, { sourceRoot: syntheticSource }), syntheticVersionA, "behavior source changes reset the cohort even outside the harness repository");
fs.mkdirSync(path.join(externalProject, ".pi", "topologies"), { recursive: true });
fs.writeFileSync(path.join(externalProject, ".pi", "topologies", "custom-implementation.json"), '{"version":1}\n');
const customConfigVersionA = roadmapCohortVersion(externalProject);
fs.writeFileSync(path.join(externalProject, ".pi", "topologies", "custom-implementation.json"), '{"version":2}\n');
assert.notEqual(roadmapCohortVersion(externalProject), customConfigVersionA, "project-local topology configuration changes reset the exact cohort");
assert.equal(roadmapOpportunityEligible("Implement this multi-step phase plan"), true);
assert.equal(roadmapOpportunityEligible("Explain one function"), false, "opportunity denominators exclude unrelated prompts without persisting prompt text");
const topologyPlanRoot = tmpFixture("pi-roadmap-topology-plan-");
const topologyApplication = applyRoadmapPlan({ cwd: topologyPlanRoot, runId: "toprun-test", roadmapPlan: { title: "Parent-applied plan", milestones: [{ title: "Phase", goals: ["Goal"] }] } });
assert.equal(topologyApplication.applied, true);
assert.equal(loadRoadmap(topologyPlanRoot).items[0].subtasks[0].items[0].title, "Goal", "the parent adapter persists planner hierarchy before implementation");

let fullCharacters = 0;
let mutationCharacters = 0;
const mutationSizes = [];
for (const size of manifest.sizes) {
  const titles = Array.from({ length: size }, (_, index) => manifest.titlePattern.replace("{ordinal}", String(index + 1)));
  const before = createRoadmap(`Large roadmap ${size}`, titles);
  const after = setStatus(before, manifest.mutation.itemPath, manifest.mutation.to, { provenance: "work-backed" });
  const mutation = roadmapMutationEnvelope(before, after, "set_status");
  fullCharacters += fullPagedChars(after);
  mutationCharacters += mutation.resultChars;
  mutationSizes.push(mutation.resultChars);
  assert(mutation.resultChars <= manifest.bars.maximumMutationP99Characters, `${size}-item mutation should be bounded`);
  assert.equal(mutation.envelope.fullState, false);
  assert.equal(mutation.envelope.delta.changed[0].path, "1");
  assert(mutation.envelope.activePath.length > 0, "compact envelope retains active scope");
}
const reduction = 1 - (mutationCharacters / fullCharacters);
assert(reduction >= manifest.bars.minimumTotalCharacterReduction, `mutation corpus reduction ${reduction} should meet the frozen bar`);
assert(percentile(mutationSizes, 99) <= manifest.bars.maximumMutationP99Characters);
const boundedPage = roadmapPage(createRoadmap("Paged", Array.from({ length: 500 }, (_, i) => `Item ${i + 1}`)), { offset: 200, limit: 50, maxChars: 5000 });
assert.equal(boundedPage.returnedEntries, 50);
assert.equal(boundedPage.nextOffset, 250);
assert(boundedPage.text.length <= 5000);

// Ordinary mutations render as compact text lines, not pretty-printed JSON.
const textBefore = createRoadmap("Text plan", ["A", "B"]);
const textAfter = setStatus(textBefore, "1", "done");
const textMutation = roadmapMutationEnvelope(textBefore, textAfter, "set_status");
assert(!textMutation.text.trimStart().startsWith("{"), "mutations render as text, not JSON");
assert.match(textMutation.text, /^roadmap set_status: /);
assert.match(textMutation.text, /^delta: \d+ changed, 0 removed · ids item-1/m);
assert.match(textMutation.text, /^progress: /m);
assert.equal(textMutation.resultChars, textMutation.text.length);
assert(textMutation.text.length < JSON.stringify(textMutation.envelope, null, 2).length, "compact text is smaller than the pretty-printed envelope");

let blockedOnly = createRoadmap("Blocked-only", [{ title: "Umbrella", subtasks: [{ title: "Goals", items: ["External dependency"] }] }]);
blockedOnly = setStatus(blockedOnly, "1.1.1", "blocked", { note: "Waiting", autoAdvance: true });
const blockedProgress = getProgress(blockedOnly);
assert.equal(blockedProgress.actionable, 0, "blocked descendants make their umbrella nonactionable");
assert.equal(blockedProgress.active, null, "blocked-only scope has no false active pointer");
assert.throws(() => addSubtaskRoadmap(blockedOnly, "Unrelated commit", ["Commit"]), (error) => error.code === ROADMAP_ERROR_CODES.PARENT_REQUIRED);
assert.equal(roadmapInputDisposition(blockedOnly, { source: "interactive", text: "new objective" }), "retain-nonactionable");
blockedOnly = setRoadmapLifecycle(blockedOnly, "closed", { reason: "blocked-only decision" });
assert.equal(getProgress(blockedOnly).lifecycle, "closed");
const detached = startRoadmap(blockedOnly, "Unrelated objective", ["New work"]);
assert.notEqual(detached.id, blockedOnly.id, "closed scope detaches before unrelated work begins");
let shelved = createRoadmap("Shelve", ["Work"]);
shelved = setRoadmapLifecycle(shelved, "shelved", { reason: "pause" });
assert.equal(getProgress(shelved).active, null);
shelved = setRoadmapLifecycle(shelved, "active");
assert.equal(getProgress(shelved).active.title, "Work");
assert.equal(roadmapInputDisposition(shelved, { source: "interactive", text: "continue" }), "retain-actionable");
let paused = createRoadmap("Paused item", ["Paused work"]);
paused = setStatus(paused, "1", "paused", { note: "resource wait" });
assert.equal(getProgress(paused).active, null);
assert.equal(getProgress(paused).nonActionable, 1);

const migratedVerification = normalizeRoadmap({ version: 2, id: "legacy-proof", title: "Historical proof", items: [{ id: "item-1", title: "Old claim", status: "verified", evidenceIds: ["legacy-id"] }] });
assert.equal(migratedVerification.items[0].status, "verified-unsubstantiated", "legacy evidence ids are not silently promoted to current fingerprint bindings");
const validateEvidenceId = (id) => ({ ok: id !== "fabricated-proof", evidence: { fingerprint: `packet-${id}` } });
let evidence = createRoadmap("Evidence", ["Verify current behavior", "Batch migration"]);
assert.throws(() => setStatus(evidence, "1", "verified"), (error) => error.code === ROADMAP_ERROR_CODES.EVIDENCE_REQUIRED);
assert.throws(() => setStatus(evidence, "1", "verified", { evidenceId: "fabricated-proof", validateEvidenceId }), (error) => error.code === ROADMAP_ERROR_CODES.INVALID_EVIDENCE, "arbitrary evidence strings cannot authorize verified status");
evidence = setStatus(evidence, "1", "verified", { evidenceId: "verification-current", validateEvidenceId, provenance: "work-backed" });
assert.equal(hasCurrentEvidence(evidence.items[0]), true);
assert.equal(getProgress(evidence).verified, 1);
let stale = createRoadmap("Stale evidence", ["Original content"]);
stale = linkItem(stale, "1", { evidenceId: "proof-old", validateEvidenceId });
stale.items[0].title = "Changed content";
assert.throws(() => setStatus(stale, "1", "verified"), (error) => error.code === ROADMAP_ERROR_CODES.STALE_EVIDENCE);
let deepStale = createRoadmap("Deep stale evidence", [{ title: "Parent", subtasks: [{ title: "Nested", items: ["Child"] }] }]);
deepStale = setStatus(deepStale, "1.1.1", "done");
deepStale = setStatus(deepStale, "1", "verified", { evidenceId: "parent-proof", validateEvidenceId });
deepStale.items[0].subtasks[0].items[0].title = "Changed child";
assert.throws(() => setStatus(deepStale, "1", "verified"), (error) => error.code === ROADMAP_ERROR_CODES.STALE_EVIDENCE, "parent proof fingerprints the complete nested content shape");
let override = createRoadmap("Override", ["Unsupported claim"]);
override = setStatus(override, "1", "verified", { allowUnsubstantiated: true, note: "explicit override" });
assert.equal(override.items[0].status, "verified-unsubstantiated");
assert.equal(getProgress(override).unsupportedVerification, 1);
assert.equal(finalReportSummary(override).completionClaimAllowed, false);
evidence = setStatus(evidence, "2", "done", { provenance: "batch" });
assert.equal(getProgress(evidence).transitionProvenance.batch, 1, "batch/backfill provenance stays distinct from work-backed transitions");
const evidencePersistenceRoot = tmpFixture("pi-roadmap-proof-lifecycle-");
const evidenceStore = new EvidenceStore({ cwd: evidencePersistenceRoot });
const persistedPacket = evidenceStore.saveEvidence({ source: "roadmap-test", ok: true, summary: "passing packet" });
let persistedProof = createRoadmap("Persisted proof", ["Claim"]);
persistedProof = setStatus(persistedProof, "1", "verified", { evidenceId: persistedPacket.id, validateEvidenceId: (id) => evidenceStore.validateEvidenceId(id) });
saveRoadmap(evidencePersistenceRoot, persistedProof);
fs.unlinkSync(evidenceStore.packetFile(persistedPacket.id));
const invalidatedProof = loadRoadmap(evidencePersistenceRoot);
assert.equal(invalidatedProof.items[0].status, "verified-unsubstantiated", "missing persisted evidence cannot remain authoritative after reload");
assert.equal(finalReportSummary(invalidatedProof).verificationClaimAllowed, false);

const persistenceRoot = tmpFixture("pi-roadmap-remediation-");
let durable = createRoadmap("Durable", ["Persist"]);
durable = saveRoadmap(persistenceRoot, durable);
durable = setStatus(durable, "1", "done");
saveRoadmap(persistenceRoot, durable);
assert.equal(fs.statSync(path.dirname(stateFile(persistenceRoot))).mode & 0o777, 0o700);
assert.equal(fs.statSync(stateFile(persistenceRoot)).mode & 0o777, 0o600);
assert.equal(fs.statSync(lastKnownGoodFile(persistenceRoot)).mode & 0o777, 0o600);
fs.writeFileSync(stateFile(persistenceRoot), "{interrupted");
const recovered = loadRoadmap(persistenceRoot);
assert.equal(recovered.items[0].status, "done", "malformed active state recovers the last-known-good packet");
assert.equal(recovered.recoveredFromLastKnownGood, true);
saveRoadmap(persistenceRoot, recovered);
const replacement = createRoadmap("Replacement", ["Next"]);
saveRoadmap(persistenceRoot, replacement);
assert.equal(fs.existsSync(archiveIndexFile(persistenceRoot)), true, "root replacement retains a private archive index");
archiveRoadmapPacket(persistenceRoot, replacement, "FORBIDDEN_ARCHIVE_REASON");
const archiveIndexText = fs.readFileSync(archiveIndexFile(persistenceRoot), "utf8");
assert(!archiveIndexText.includes("FORBIDDEN_ARCHIVE_REASON"), "archive index stores only a fixed reason category");
assert.equal(JSON.parse(archiveIndexText.trim().split(/\n/).at(-1)).reasonCategory, "other");

const symlinkRoot = tmpFixture("pi-roadmap-symlink-");
fs.mkdirSync(path.dirname(stateFile(symlinkRoot)), { recursive: true, mode: 0o700 });
const victim = path.join(symlinkRoot, "victim.json");
fs.writeFileSync(victim, "victim");
fs.symlinkSync(victim, stateFile(symlinkRoot));
assert.throws(() => saveRoadmap(symlinkRoot, createRoadmap("No follow", ["Safe"])), (error) => error.code === ROADMAP_ERROR_CODES.PERSISTENCE_FAILED);
assert.equal(fs.readFileSync(victim, "utf8"), "victim", "no-follow persistence never writes through a symlink");

const telemetryRoot = tmpFixture("pi-roadmap-telemetry-");
const projected = createRoadmapTelemetryEvent({ operation: "set_status", outcome: "succeeded", title: "FORBIDDEN_TITLE", note: "FORBIDDEN_NOTE", evidenceId: "FORBIDDEN_EVIDENCE" });
const serialized = JSON.stringify(projected);
for (const forbidden of ["FORBIDDEN_TITLE", "FORBIDDEN_NOTE", "FORBIDDEN_EVIDENCE"]) assert(!serialized.includes(forbidden));
recordRoadmapTelemetry(telemetryRoot, { operation: "set_status", outcome: "succeeded", sessionToken: "privacy-probe", sessionKind: "deterministic-fixture", title: "FORBIDDEN_TITLE", note: "FORBIDDEN_NOTE", evidenceId: "FORBIDDEN_EVIDENCE" });
const persistedTelemetry = fs.readFileSync(path.join(telemetryRoot, ".pi", "roadmap", "telemetry", "events.jsonl"), "utf8");
for (const forbidden of ["FORBIDDEN_TITLE", "FORBIDDEN_NOTE", "FORBIDDEN_EVIDENCE"]) assert(!persistedTelemetry.includes(forbidden), `${forbidden} must not enter persisted telemetry`);
for (let index = 1; index <= 31; index++) {
  recordRoadmapTelemetry(telemetryRoot, { cohortVersion: ROADMAP_COHORT_VERSION, sessionToken: `session-${index}`, sessionKind: "interactive", operation: "add_subtask", outcome: "succeeded", resultChars: 900, deltaChars: 200, itemCount: 10, maxDepth: 2, actionableCount: 2, nonActionableCount: 0, evidenceBindingCount: 1, eligible: true, adopted: true });
}
const telemetryEvents = readRoadmapTelemetry(telemetryRoot);
const deterministicEvidence = { status: "passed", sourceVersion: ROADMAP_COHORT_VERSION, fixtureHash, invariantViolations: 0, applicationViolations: 0 };
const excluded = summarizeRoadmapTelemetry(telemetryEvents, { excludeSessionToken: "session-31" });
assert.equal(excluded.sample.independentInteractiveSessions, 30, "active-session exclusion is exact");
assert.equal(excluded.excludedActiveSession.matchedEvents, 1);
assert.equal(fs.statSync(path.join(telemetryRoot, ".pi", "roadmap", "telemetry", "events.jsonl")).mode & 0o777, 0o600);
const unexcludedField = createRoadmapFieldReport({ events: telemetryEvents, fixtureHash, deterministic: deterministicEvidence });
assert.equal(unexcludedField.decision, "no-go", "field rollout cannot ship without exact active-session exclusion");
assert.match(unexcludedField.blockers.join("\n"), /active-session exclusion/);
const passingField = createRoadmapFieldReport({ events: telemetryEvents, excludeSessionToken: "session-31", fixtureHash, deterministic: deterministicEvidence });
assert.equal(passingField.decision, "ship");
assert.equal(passingField.gates.activeSessionExclusion, "pass");
const showOnlyEvents = Array.from({ length: 30 }, (_, index) => createRoadmapTelemetryEvent({ cohortVersion: ROADMAP_COHORT_VERSION, sessionToken: `show-${index}`, sessionKind: "interactive", operation: "show", outcome: "succeeded" }));
const unmeasuredAddSubtask = createRoadmapFieldReport({ events: showOnlyEvents, fixtureHash, deterministic: deterministicEvidence });
assert.equal(unmeasuredAddSubtask.exactVersion.reliability.addSubtaskSuccessRate, null);
assert.equal(unmeasuredAddSubtask.decision, "no-go", "field rollout cannot ship without valid add_subtask observations");
assert.match(unmeasuredAddSubtask.blockers.join("\n"), /no valid add_subtask/);
const opportunityEvents = [
  createRoadmapTelemetryEvent({ cohortVersion: ROADMAP_COHORT_VERSION, sessionToken: "usage", sessionKind: "interactive", operation: "input_opportunity", outcome: "not-applicable", eligible: true, adopted: true }),
  createRoadmapTelemetryEvent({ cohortVersion: ROADMAP_COHORT_VERSION, sessionToken: "usage", sessionKind: "interactive", operation: "start", outcome: "succeeded", eligible: true, adopted: true }),
];
assert.equal(summarizeRoadmapTelemetry(opportunityEvents).usage.eligibleOpportunities, 1, "tool operations do not inflate the eligible-opportunity denominator");
const privacyFailure = createRoadmapFieldReport({ events: [{ ...showOnlyEvents[0], title: "forbidden" }], fixtureHash, deterministic: deterministicEvidence });
assert.equal(privacyFailure.gates.privacy, "fail", "field reports audit rather than hard-code the telemetry privacy claim");
const deferredField = createRoadmapFieldReport({ events: telemetryEvents.filter((event) => event.sessionKind === "interactive").slice(0, 5), fixtureHash, deterministic: deterministicEvidence });
assert.equal(createRoadmapFieldReport({ events: telemetryEvents, fixtureHash, deterministic: { ...deterministicEvidence, sourceVersion: "stale-source" } }).gates.deterministic, "not-proven", "stale generated evidence cannot authorize a new source cohort");
assert.equal(deferredField.decision, "no-go-deferred");
assert.match(deferredField.blockers[0], /5\/30/);
assert.notDeepEqual(passingField.historicalBaseline, passingField.exactVersion, "historical and exact-version evidence remain separate");
assert.equal(passingField.historicalBaseline.runtimeVersion, "roadmap-v2-pre-remediation");
assert.equal(passingField.configVersion.roadmapSchemaVersion, 3, "field reports freeze source/config/schema identifiers");
assert.equal(typeof passingField.historicalBaseline.repeatedTaskCohortId, "string", "the prompt-free repeated-task diagnostic cohort is identified without storing prompts");

console.log("roadmap remediation tests passed", JSON.stringify({ fixtureHash, reduction, p99: percentile(mutationSizes, 99) }));
