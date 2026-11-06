"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RolloutCenterAdapter, buildRolloutSnapshot, assertRolloutSnapshotMetadataOnly } = require("../src/rollout-center");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("pi-rollout-center-");
fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
fs.writeFileSync(path.join(cwd, "docs", "phase7-release-scorecard.json"), JSON.stringify({ schemaVersion: 1, generatedAt: "2026-01-01T00:00:00.000Z", scorecardId: "phase7-fixture", summary: { decision: "no-go-deferred" }, release: { decision: "no-go-deferred" }, cohort: { eventCount: 0, observedDays: 0, sufficient: false, rateDenominatorEligible: false }, metrics: [{ status: "insufficient-data" }], freeze: { runtimeSourceHash: "hash-fixture" } }));
const before = fs.readdirSync(cwd, { recursive: true }).sort();
const env = { ...process.env, PI_ROLE_ROLLOUT_STAGE: "R0", PI_ROLE_FIELD_PILOT: "1", PI_ROLE_WORKER_SHADOW_CANARY: "1", PI_ROLE_MUTATION: "off", PI_ROLE_SIDECAR: "1", PI_TOPOLOGY_AUTO_ROUTE: "suggest", PI_PROJECT_MEMORY_STAGE: "M0", PI_COMPOUNDING_EFFECTIVENESS_ENABLED: "1" };
const snapshot = buildRolloutSnapshot({ cwd, env, now: () => new Date("2026-01-02T00:00:00.000Z") });
const after = fs.readdirSync(cwd, { recursive: true }).sort();
assert.deepEqual(after, before, "snapshot collection is read-only and creates no cache");
assert.equal(snapshot.posture, "observation-only");
assert.equal(snapshot.privacy.metadataOnly, true);
assert.equal(snapshot.privacy.containsAbsolutePaths, false);
assert.equal(snapshot.capabilities.length, 7);
const portfolio = snapshot.capabilities.find((item) => item.capabilityId === "extension-portfolio");
assert.equal(portfolio.currentStage, "observation");
assert.equal(portfolio.fieldProof.status, "insufficient-data");
assert.deepEqual(snapshot.coverage.unavailableSources, []);
const roleCapability = snapshot.capabilities.find((item) => item.capabilityId === "role-runtime");
assert.equal(roleCapability.currentStage, "R0");
assert.equal(roleCapability.policyAuthorization.automationAllowed, true, "rollout status exposes the narrow automatic worker canary");
assert(roleCapability.rollbackControl.controlIds.includes("PI_ROLE_WORKER_SHADOW_CANARY"));
// The harness declares its own posture in config/memory-posture.json (M1), which
// outranks the inherited stage export this fixture passes. The stale scorecard
// still blocks promotion to the evidence-gated stages.
const projectMemory = snapshot.capabilities.find((item) => item.capabilityId === "project-memory");
assert.equal(projectMemory.currentStage, "M1");
assert.equal(projectMemory.fieldProof.status, "stale");
assert.equal(projectMemory.policyAuthorization.status, "authorized");
assert.equal(projectMemory.policyAuthorization.mutationAllowed, true);
assert.equal(snapshot.capabilities.find((item) => item.capabilityId === "phase7-release").fieldProof.status, "insufficient-data");
assert(snapshot.capabilities.every((item) => item.policyAuthorization.mutationAllowed === false || item.capabilityId === "role-runtime" || item.capabilityId === "project-memory"));
assertRolloutSnapshotMetadataOnly(snapshot);
const serialized = JSON.stringify(snapshot);
assert(!serialized.includes(cwd), "snapshot contains no absolute project path");
assert(!serialized.includes("phase7-release-scorecard.json"), "snapshot uses provenance references rather than source paths");

const adapter = new RolloutCenterAdapter({ cwd, env, clock: () => new Date("2026-01-02T00:00:00.000Z") });
const status = adapter.status();
assert.equal(status.enabled, true);
assert.equal(status.posture, "observation-only");
const role = adapter.capability("role-runtime");
assert.equal(role.capabilityId, "role-runtime");
assert.equal(adapter.provenance(role.provenance[0].ref).capabilityId, "role-runtime");
assert.equal(new RolloutCenterAdapter({ cwd, enabled: false }).snapshot().skipped, true);
assert.throws(() => assertRolloutSnapshotMetadataOnly({ prompt: "private" }), /forbidden rollout metadata key/);
assert.throws(() => assertRolloutSnapshotMetadataOnly({ artifactRef: "/tmp/private" }), /unsafe rollout metadata/);

console.log("rollout center tests passed");
