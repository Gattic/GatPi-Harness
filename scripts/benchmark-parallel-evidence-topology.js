#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  AgentRoleRegistry,
  TopologyExecutionEngine,
  listBuiltInRoleTopologies,
} = require("../src/multi-agent-topologies");

const MANIFEST = path.join(__dirname, "..", "tests", "fixtures", "topology", "parallel-evidence-benchmark.json");
const WORKER_IDS = ["research", "compare", "check", "gaps"];

function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function loadManifest(file = MANIFEST) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.benchmark !== "parallel-evidence-synthesis-v1" || !Array.isArray(manifest.cases) || !manifest.cases.length) throw new Error("invalid parallel evidence benchmark manifest");
  return manifest;
}
function handlerTopology(topology) { return { ...clone(topology), nodes: topology.nodes.map((node) => ({ ...node, executionMode: "handler" })) }; }
function basePayload(nodeId) {
  return {
    schemaVersion: 2,
    contractVersion: "role-v2",
    summary: `Deterministic ${nodeId} benchmark role produced its bounded fixture payload.`,
    findings: [],
    evidence: [{ kind: "fixture", source: "parallel-evidence-benchmark", summary: `Generated the bounded ${nodeId} role payload for deterministic orchestration checks.` }],
    verification: { status: "passed", evidence: [`Deterministic ${nodeId} fixture payload matched its role contract.`] },
  };
}
function evidenceRef(caseId, workerId) { return { id: `${caseId}-e-${workerId}`, kind: workerId, source: `fixture/${caseId}/${workerId}.md`, locator: "L1-L4", observation: `${workerId} evidence for ${caseId}` }; }
function supportedClaim(caseId, workerId, fixture) {
  const statement = workerId === "check" ? fixture.seededContradiction : workerId === "gaps" ? fixture.seededGap : `${workerId} finding for ${caseId}`;
  return { id: `${caseId}-c-${workerId}`, statement, status: "proposed", evidenceRefs: [`${caseId}-e-${workerId}`] };
}
function deterministicView(run) {
  const payload = run?.aggregation?.payload || run?.aggregation || {};
  return {
    status: run.status,
    claims: (payload.claims || []).map((claim) => ({ id: claim.id, status: claim.status, evidenceRefs: claim.evidenceRefs })).sort((a, b) => a.id.localeCompare(b.id)),
    auditDecisions: (payload.auditDecisions || []).map((decision) => ({ claimId: decision.claimId, decision: decision.decision, evidenceRefs: decision.evidenceRefs })).sort((a, b) => a.claimId.localeCompare(b.claimId)),
    disagreements: payload.disagreements || [],
    unresolvedGaps: payload.unresolvedGaps || [],
    coverage: payload.coverage || null,
  };
}
function metrics(run, fixture) {
  const payload = run?.aggregation?.payload || run?.aggregation || {};
  const evidenceRefs = payload.evidenceRefs || [];
  const categories = [...new Set(evidenceRefs.map((item) => item.kind).filter(Boolean))].sort();
  const expected = fixture.expectedCategories || [];
  const acceptedIds = new Set((payload.auditDecisions || []).filter((decision) => decision.decision === "accepted").map((decision) => decision.claimId));
  const unsupportedAccepted = (payload.claims || []).filter((claim) => acceptedIds.has(claim.id) && !(claim.evidenceRefs || []).length).length;
  return {
    status: run.status,
    uniqueEvidence: evidenceRefs.length,
    categories,
    coverageRatio: expected.length ? expected.filter((category) => categories.includes(category)).length / expected.length : 1,
    contradictionsDetected: (payload.disagreements || []).some((item) => item.summary === fixture.seededContradiction) ? 1 : 0,
    gapsDetected: (payload.unresolvedGaps || []).some((item) => item.summary === fixture.seededGap) ? 1 : 0,
    unsupportedAccepted,
    rejectedClaims: (payload.rejectedClaims || []).length,
    nodeCount: run.nodeStates?.length || run.results?.length || 0,
  };
}
async function runControl(topology, fixture) {
  const engine = new TopologyExecutionEngine({ roleRegistry: new AgentRoleRegistry(), agentExecutor: async ({ node }) => ({ payload: { ...basePayload(node.id), claims: [supportedClaim(fixture.id, "research", fixture)], evidenceRefs: [evidenceRef(fixture.id, "research")] } }) });
  return engine.execute(handlerTopology(topology), { task: fixture.task });
}
async function runCandidate(topology, fixture) {
  const engine = new TopologyExecutionEngine({
    roleRegistry: new AgentRoleRegistry(),
    agentExecutor: async ({ node, context }) => {
      const base = basePayload(node.id);
      if (node.id === "scope") return { payload: { ...base, analysisPlan: { title: fixture.id, assignments: WORKER_IDS.map((id) => ({ id, angle: id, objective: `Collect ${id} evidence`, exclusions: WORKER_IDS.filter((other) => other !== id), acceptanceCriteria: ["Cite evidenceRefs", "State uncertainty"] })) } } };
      if (WORKER_IDS.includes(node.id)) {
        const claims = [supportedClaim(fixture.id, node.id, fixture)];
        if (node.id === "compare") claims.push({ id: `${fixture.id}-c-unsupported`, statement: "Unsupported comparison claim", status: "proposed", evidenceRefs: [] });
        return { payload: { ...base, claims, evidenceRefs: [evidenceRef(fixture.id, node.id)] } };
      }
      if (node.id === "audit") {
        const claims = context.dependencyResults.flatMap((result) => result.claims || []);
        const evidenceRefs = context.dependencyResults.flatMap((result) => result.evidenceRefs || []);
        const decisions = claims.map((claim) => ({ claimId: claim.id, decision: claim.evidenceRefs?.length ? "accepted" : "rejected", rationale: claim.evidenceRefs?.length ? "Fixture evidence directly supports the claim" : "No evidence reference was supplied", evidenceRefs: claim.evidenceRefs || [] }));
        const acceptedIds = new Set(decisions.filter((decision) => decision.decision === "accepted").map((decision) => decision.claimId));
        return { payload: {
          ...base,
          claims: claims.filter((claim) => acceptedIds.has(claim.id)).map((claim) => ({ ...claim, status: "accepted" })),
          evidenceRefs,
          auditDecisions: decisions,
          disagreements: [{ id: `${fixture.id}-contradiction`, summary: fixture.seededContradiction, claimIds: [`${fixture.id}-c-check`], evidenceRefs: [`${fixture.id}-e-check`], severity: "medium" }],
          rejectedClaims: decisions.filter((decision) => decision.decision === "rejected"),
          unresolvedGaps: [{ id: `${fixture.id}-gap`, summary: fixture.seededGap, claimIds: [`${fixture.id}-c-gaps`], evidenceRefs: [`${fixture.id}-e-gaps`], severity: "medium" }],
          recommendedActions: [{ id: `${fixture.id}-action`, action: "Resolve the audited gap before changing routing defaults", evidenceRefs: [`${fixture.id}-e-gaps`], priority: "high" }],
          coverage: { expectedCategories: fixture.expectedCategories, observedCategories: WORKER_IDS, missingCategories: [], ratio: 1 },
        } };
      }
      throw new Error(`unexpected candidate fixture node: ${node.id}`);
    },
  });
  return engine.execute(handlerTopology(topology), { task: fixture.task });
}
async function runBenchmark({ manifestFile = MANIFEST } = {}) {
  const manifest = loadManifest(manifestFile);
  const topologies = listBuiltInRoleTopologies();
  const controlTopology = topologies.find((topology) => topology.topologyId === "research-advisory");
  const candidateTopology = topologies.find((topology) => topology.topologyId === "parallel-evidence-synthesis");
  if (!controlTopology || !candidateTopology) throw new Error("benchmark topologies are unavailable");
  const roleById = new Map(new AgentRoleRegistry().list().map((role) => [role.roleId, role]));
  const safety = {
    candidateFullyReadOnly: candidateTopology.nodes.every((node) => node.mutationPolicy === "forbidden" && !["edit", "write", "bash", "role_verify"].some((tool) => (node.toolPolicy?.allowedTools || roleById.get(node.roleId)?.toolPolicy?.allowedTools || []).includes(tool))),
    routerPolicy: candidateTopology.metadata?.autoRoutePolicy,
    partialPolicy: candidateTopology.partialPolicy,
  };
  const cases = [];
  for (const fixture of manifest.cases) {
    const control = await runControl(controlTopology, fixture);
    const candidate = await runCandidate(candidateTopology, fixture);
    const replay = await runCandidate(candidateTopology, fixture);
    cases.push({ id: fixture.id, taskHash: `sha256:${sha256(fixture.task)}`, control: metrics(control, fixture), candidate: metrics(candidate, fixture), deterministicParity: JSON.stringify(deterministicView(candidate)) === JSON.stringify(deterministicView(replay)) });
  }
  const checks = {
    candidateFullyReadOnly: safety.candidateFullyReadOnly,
    manualSuggestOnly: safety.routerPolicy === "suggest-only",
    candidateCoverage: cases.every((item) => item.candidate.coverageRatio === 1),
    contradictionRecall: cases.every((item) => item.candidate.contradictionsDetected === 1),
    gapRecall: cases.every((item) => item.candidate.gapsDetected === 1),
    unsupportedAccepted: cases.every((item) => item.candidate.unsupportedAccepted === 0),
    deterministicParity: cases.every((item) => item.deterministicParity),
    candidateSucceeded: cases.every((item) => item.candidate.status === "succeeded"),
    boundedModelCallProxy: cases.every((item) => item.candidate.nodeCount - 1 <= 6),
  };
  return { schemaVersion: 1, benchmark: manifest.benchmark, manifestHash: `sha256:${sha256(manifest)}`, generatedAt: new Date().toISOString(), arms: { control: "research-advisory", candidate: "parallel-evidence-synthesis" }, safety, cases, checks, ok: Object.values(checks).every(Boolean), evidenceBoundary: "Deterministic orchestration fixture only; it does not establish live model quality or authorize routing changes." };
}

if (require.main === module) {
  const outputIndex = process.argv.indexOf("--output");
  runBenchmark().then((report) => {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (outputIndex >= 0 && process.argv[outputIndex + 1]) { const file = path.resolve(process.argv[outputIndex + 1]); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, text, { mode: 0o600 }); }
    process.stdout.write(text);
    process.exitCode = report.ok ? 0 : 1;
  }).catch((error) => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
}

module.exports = { MANIFEST, loadManifest, runBenchmark, deterministicView, metrics };
