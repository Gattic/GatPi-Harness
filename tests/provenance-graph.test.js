"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ProvenanceGraphAdapter, assertMetadataOnly } = require("../src/provenance-graph");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("provenance-graph-");
const sourceHash = `sha256:${"a".repeat(64)}`;
const providers = {
  evidence: { provenanceRecords: () => ({ evidence: [
    { id: "evidence-ok", ok: true, fingerprint: `sha256:${"b".repeat(64)}`, createdAt: "2026-07-31T00:00:00.000Z" },
    { id: "evidence-rejected", ok: false, fingerprint: `sha256:${"c".repeat(64)}`, createdAt: "2026-07-31T00:00:01.000Z" },
    { id: "sk-super-secret-token", ok: true, fingerprint: `sha256:${"9".repeat(64)}`, createdAt: "2026-07-31T00:00:02.000Z" },
  ] }) },
  executionOutcomes: { provenanceRecords: () => ({ packets: [{ packetId: "execout-one", outcome: "success", settledAt: "2026-07-31T00:01:00.000Z", source: { kind: "topology", runId: "toprun-one", terminalState: "completed", sourceRecordHash: `sha256:${"d".repeat(64)}` }, evidenceRefs: ["evidence-ok"], artifactRefs: [{ id: "artifact-one", kind: "verification", hash: `sha256:${"e".repeat(64)}` }] }] }) },
  learning: { provenanceRecords: () => ({
    outcomes: [{ outcomeId: "outcome-one", createdAt: "2026-07-31T00:02:00.000Z", fingerprint: "outcome-fingerprint", signals: { status: "success" }, artifacts: { evidenceRefs: ["evidence-ok"], traceRefs: ["execout-one"] } }],
    patterns: [{ patternId: "pattern-one", status: "confirmed", fingerprint: "pattern-fingerprint", outcomeIds: ["outcome-one"] }],
    proposals: [{ proposalId: "proposal-one", status: "dismissed", evidenceRefs: ["evidence-ok", "evidence-rejected"], patternIds: ["pattern-one"], outcomeIds: ["outcome-one"], verificationResult: { evidenceRefs: ["evidence-ok"] } }],
    decisions: [{ type: "proposal.dismissed", proposalId: "proposal-one", status: "dismissed", ok: false, evidenceRefs: ["evidence-rejected"], at: "2026-07-31T00:03:00.000Z" }],
  }) },
  skills: { provenanceRecords: () => ({
    captures: [{ captureId: "cap-one", outcome: "success", workflowSignature: "workflow-one", replayRefs: { packetId: "execout-one" }, provenance: { executionPacketId: "execout-one", topologyRunId: "toprun-one", evidenceIds: ["evidence-ok"] }, verification: { evidenceIds: ["evidence-ok"] } }],
    skills: [{ skillId: "skill-one", version: 2, status: "private-candidate", provenance: { captureIds: ["cap-one"], sourceHash }, evidenceState: { sourceTrust: { status: "trusted" } }, versionHistory: [{ version: 1 }, { version: 2 }] }],
    failurePatterns: [{ patternId: "failure-one", signature: "failure-signature", linkedCaptureIds: ["cap-one"] }],
    evaluations: [],
  }) },
  projectMemory: { provenanceRecords: () => ({
    entries: [{ id: "memory-one", candidateHash: `sha256:${"f".repeat(64)}`, verification: "verified", sourceFingerprints: ["execout-one"], evidenceIds: ["evidence-ok", "evidence-missing"], supersedes: ["memory-old"], contradicts: [] }],
    decisions: [{ decisionId: "decision-one", action: "rejected", candidateHash: `sha256:${"1".repeat(64)}`, evidenceIds: ["evidence-rejected"], at: "2026-07-31T00:04:00.000Z" }],
  }) },
};
const adapter = new ProvenanceGraphAdapter({ cwd, ...providers, clock: () => new Date("2026-07-31T01:00:00.000Z") });
const graph = adapter.build({ maxNodes: 200, maxEdges: 400, depth: 8 });
assert.equal(graph.schemaVersion, 1);
assert.equal(graph.boundaries.readOnly, true);
assert.equal(graph.boundaries.metadataOnly, true);
assert.equal(graph.coverage.complete, true);
assert(graph.nodes.some((node) => node.id === "execution:execout-one"));
assert(graph.nodes.some((node) => node.id === "learning-outcome:outcome-one"));
assert(graph.nodes.some((node) => node.id === "skill-version:skill-one@2" && node.hash === sourceHash));
assert(graph.edges.some((edge) => edge.from === "run:toprun-one" && edge.to === "execution:execout-one" && edge.type === "produced"));
assert(graph.edges.some((edge) => edge.from === "execution:execout-one" && edge.to === "learning-outcome:outcome-one" && edge.type === "derived-from"));
assert(graph.edges.some((edge) => edge.from === "execution:execout-one" && edge.to === "memory:memory-one" && edge.type === "derived-from"));
assert(graph.edges.some((edge) => edge.from === "evidence:evidence-ok" && edge.to === "memory:memory-one" && edge.type === "supports"));
assert(graph.edges.some((edge) => edge.from === "learning-outcome:outcome-one" && edge.to === "learning-pattern:pattern-one"));
assert(graph.edges.some((edge) => edge.from === "learning-pattern:pattern-one" && edge.to === "learning-proposal:proposal-one"));
assert(graph.edges.some((edge) => edge.to === "learning-proposal:proposal-one" && edge.type === "rejected" && edge.from.startsWith("learning-decision:")));
assert(graph.edges.some((edge) => edge.from === "skill-capture:cap-one" && edge.to === "skill-version:skill-one@2"));
assert(graph.edges.some((edge) => edge.from === "skill-version:skill-one@2" && edge.to === "skill-version:skill-one@1" && edge.type === "supersedes"));
assert(graph.diagnostics.some((item) => item.code === "dangling-node" && item.nodeId === "evidence:evidence-missing"));
assert(graph.diagnostics.some((item) => item.code === "dangling-edge"));
assert(graph.diagnostics.some((item) => item.code === "conflicting-support" && item.nodeId === "learning-proposal:proposal-one"));
assert(graph.diagnostics.some((item) => item.code === "rejected" || item.code === "dismissed"));
assertMetadataOnly(graph);
assert.equal(JSON.stringify(graph).includes(cwd), false);
assert.equal(JSON.stringify(graph).includes("sk-super-secret-token"), false, "secret-like identifiers are replaced by stable hashes");

const lineage = adapter.lineage("skill-one@2", { depth: 2, maxNodes: 20, maxEdges: 40 });
assert(lineage.seeds.includes("skill-version:skill-one@2"));
assert(lineage.nodes.length <= 20);
assert(lineage.nodes.some((node) => node.id === "skill-capture:cap-one"));
assert(!lineage.nodes.some((node) => node.id === "learning-proposal:proposal-one"), "depth bound excludes unrelated lineage branches");

const bounded = adapter.build({ maxNodes: 3, maxEdges: 2 });
assert(bounded.nodes.length <= 3);
assert(bounded.edges.length <= 2);
assert.equal(bounded.coverage.complete, false);
assert.equal(bounded.coverage.nodeTruncated, true);

assert.throws(() => adapter.export({}, { fileName: "graph.json" }), /explicit current-user request/);
const exported = adapter.export({ seedIds: ["execout-one"], depth: 1 }, { explicit: true, fileName: "graph.json" });
assert.equal(exported.private, true);
assert.equal(fs.statSync(path.join(cwd, exported.relativePath)).mode & 0o777, 0o600);
assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(cwd, exported.relativePath), "utf8"))).includes(cwd), false);

const degraded = new ProvenanceGraphAdapter({ cwd, evidence: { provenanceRecords: () => { throw Object.assign(new Error("offline"), { code: "EVIDENCE_OFFLINE" }); } } }).build({ maxNodes: 10, maxEdges: 10 });
assert.equal(degraded.coverage.complete, false);
assert(degraded.coverage.unavailableProviders.includes("evidence-binder"));
assert.equal(degraded.coverage.providers["evidence-binder"].available, false);

const unsafeCwd = tmpFixture("provenance-symlink-root-");
const externalState = tmpFixture("provenance-external-");
fs.symlinkSync(externalState, path.join(unsafeCwd, ".pi"));
assert.throws(() => new ProvenanceGraphAdapter({ cwd: unsafeCwd }), /non-symlinked project state path/);

console.log("provenance graph tests passed");
