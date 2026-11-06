"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writePrivateJson } = require("./project-memory-decisions");

const PROVENANCE_GRAPH_SCHEMA_VERSION = 1;
const DEFAULT_LIMITS = Object.freeze({ depth: 4, maxNodes: 500, maxEdges: 1000, perStoreLimit: 200, maxElapsedMs: 2000 });
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const SENSITIVE_COMPONENT = /(?:^|[-_.:@+])(?:sk|token|secret|password|passwd|authorization|bearer|api[_-]?key)(?:[-_.:@+]|$)|^AKIA|^ghp_|^github_pat_/i;
const FORBIDDEN_KEY = /prompt|transcript|reasoning|commandarguments|commandargs|rawtooloutput|tooloutput|stdout|stderr|password|secret|authorization/i;
const ABSOLUTE_PATH = /(?:^|\s)\/(?:home|Users|tmp|etc|var)\/|[A-Za-z]:\\/;

function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); return value; }
function stableStringify(value) { return JSON.stringify(stable(value)); }
function hash(value, length = 24) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex").slice(0, length); }
function safeHash(value) { const text = String(value || "").trim(); if (/^(?:sha256:)?[a-f0-9]{32,128}$/i.test(text)) return text.startsWith("sha256:") ? text.toLowerCase() : `sha256:${text.toLowerCase()}`; if (/^(?:fingerprint|signature):[A-Za-z0-9._:@+-]{1,200}$/.test(text)) return text; return text ? `sha256:${hash(text, 64)}` : null; }
function component(value, fallback = "unknown") { const text = String(value || fallback).trim(); return SAFE_COMPONENT.test(text) && !SENSITIVE_COMPONENT.test(text) ? text : `${fallback}_${hash(text || fallback, 20)}`; }
function nodeId(kind, value) { return `${kind}:${component(value, kind)}`; }
function edgeId(from, to, type, source) { return `edge_${hash({ from, to, type, source }, 24)}`; }
function asArray(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function isSafeLocalPath(cwd, target) { const root = path.resolve(cwd); const resolved = path.resolve(target); const relative = path.relative(root, resolved); if (relative.startsWith("..") || path.isAbsolute(relative)) return false; let current = root; for (const segment of relative.split(path.sep).filter(Boolean)) { current = path.join(current, segment); try { if (fs.lstatSync(current).isSymbolicLink()) return false; } catch (error) { if (error?.code === "ENOENT") return true; return false; } } return true; }
function timeExceeded(started, maxElapsedMs) { return Date.now() - started > maxElapsedMs; }
function assertMetadataOnly(value, at = "graph") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertMetadataOnly(item, `${at}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).forEach(([key, child]) => { if ((FORBIDDEN_KEY.test(key) && child !== false) || /^(?:path|file|directory|cwd|content|summary|task|message|text)$/i.test(key)) throw new Error(`${at}.${key} is forbidden in provenance graph output`); assertMetadataOnly(child, `${at}.${key}`); });
  if (typeof value === "string" && ABSOLUTE_PATH.test(value)) throw new Error(`${at} contains an absolute path`);
}
function referenceKind(value) {
  const text = String(value || "");
  if (/^evidence[_:.-]/.test(text)) return "evidence";
  if (/^execout[-_]/.test(text)) return "execution";
  if (/^(?:toprun_|loop_|goal_|run[_:.-])/.test(text)) return "run";
  if (/^outcome_/.test(text)) return "learning-outcome";
  if (/^pattern_/.test(text)) return "learning-pattern";
  if (/^proposal_/.test(text)) return "learning-proposal";
  if (/^cap_/.test(text)) return "skill-capture";
  if (/^skill_/.test(text)) return "skill";
  if (/^mem_/.test(text)) return "memory";
  return "source";
}
function referenceNode(value) { return nodeId(referenceKind(value), value); }
function safeTimestamp(value) { const parsed = Date.parse(value || 0); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; }

class ProvenanceGraphAdapter {
  constructor({ enabled = true, cwd = process.cwd(), root, projectMemory, executionOutcomes, learning, skills, evidence, limits = {}, clock = () => new Date() } = {}) {
    this.enabled = enabled !== false;
    this.cwd = path.resolve(cwd);
    this.root = path.resolve(root || path.join(this.cwd, ".pi", "provenance-graph"));
    if (!this.root.startsWith(`${this.cwd}${path.sep}`) || !isSafeLocalPath(this.cwd, this.root)) throw new Error("provenance graph root must stay inside a non-symlinked project state path");
    this.projectMemory = projectMemory || null;
    this.executionOutcomes = executionOutcomes || null;
    this.learning = learning || null;
    this.skills = skills || null;
    this.evidence = evidence || null;
    this.limits = { ...DEFAULT_LIMITS, ...(limits || {}) };
    this.clock = clock;
  }
  status() { return { enabled: this.enabled, schemaVersion: PROVENANCE_GRAPH_SCHEMA_VERSION, readOnly: true, metadataOnly: true, limits: this.limits, exportRequiresExplicitUserRequest: true }; }
  build(input = {}) {
    if (!this.enabled) return { enabled: false, skipped: true, nodes: [], edges: [], diagnostics: [], coverage: { complete: false, unavailableProviders: ["provenance-disabled"] } };
    const started = Date.now();
    const limits = {
      depth: Math.max(0, Math.min(16, Number(input.depth ?? this.limits.depth))),
      maxNodes: Math.max(1, Math.min(5000, Number(input.maxNodes || this.limits.maxNodes))),
      maxEdges: Math.max(1, Math.min(10000, Number(input.maxEdges || this.limits.maxEdges))),
      perStoreLimit: Math.max(1, Math.min(2000, Number(input.perStoreLimit || this.limits.perStoreLimit))),
      maxElapsedMs: Math.max(50, Math.min(30000, Number(input.maxElapsedMs || this.limits.maxElapsedMs))),
    };
    const nodes = new Map();
    const edges = new Map();
    const internalNodeLimit = Math.min(20000, Math.max(limits.maxNodes, limits.perStoreLimit * 20));
    const internalEdgeLimit = Math.min(40000, Math.max(limits.maxEdges, limits.perStoreLimit * 40));
    const providers = {};
    const unavailableProviders = [];
    let nodeTruncated = false;
    let edgeTruncated = false;
    const addNode = (kind, rawId, fields = {}) => {
      const id = nodeId(kind, rawId);
      if (nodes.has(id)) { const current = nodes.get(id); nodes.set(id, { ...current, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null)), missing: current.missing === true && fields.missing !== false }); return id; }
      if (nodes.size >= internalNodeLimit) { nodeTruncated = true; return id; }
      nodes.set(id, { id, kind, source: component(fields.source || kind, "provider"), status: component(fields.status || "observed", "status"), ...(fields.version != null ? { version: Number(fields.version) } : {}), ...(fields.hash ? { hash: safeHash(fields.hash) } : {}), ...(safeTimestamp(fields.createdAt) ? { createdAt: safeTimestamp(fields.createdAt) } : {}), ...(fields.missing === true ? { missing: true } : {}) });
      return id;
    };
    const addRefNode = (raw) => { const kind = referenceKind(raw); return addNode(kind, raw, { source: "reference", status: "missing", missing: true }); };
    const addEdge = (from, to, type, source = "unknown", status = "observed") => {
      const normalized = { from, to, type: component(type, "relation"), source: component(source, "provider"), status: component(status, "status") };
      const id = edgeId(normalized.from, normalized.to, normalized.type, normalized.source);
      if (edges.has(id)) return id;
      if (edges.size >= internalEdgeLimit) { edgeTruncated = true; return id; }
      edges.set(id, { id, ...normalized });
      return id;
    };
    const provider = (name, fn) => {
      if (timeExceeded(started, limits.maxElapsedMs)) { providers[name] = { available: false, reason: "time-budget" }; unavailableProviders.push(name); return null; }
      try { const value = fn(); providers[name] = { available: true, records: Object.values(value || {}).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0) }; return value || {}; }
      catch (error) { providers[name] = { available: false, errorCode: component(error?.code || error?.name || "provider-failed", "error") }; unavailableProviders.push(name); return null; }
    };

    const evidenceData = provider("evidence-binder", () => this.evidence?.provenanceRecords ? this.evidence.provenanceRecords({ limit: limits.perStoreLimit }) : { evidence: [] });
    for (const item of evidenceData?.evidence || []) addNode("evidence", item.id, { source: "evidence-binder", status: item.ok === true ? "accepted" : "rejected", hash: item.fingerprint ? `fingerprint:${component(item.fingerprint, "fingerprint")}` : null, createdAt: item.createdAt, missing: false });

    const executionData = provider("execution-outcomes", () => this.executionOutcomes?.provenanceRecords ? this.executionOutcomes.provenanceRecords({ limit: limits.perStoreLimit }) : { packets: this.executionOutcomes?.packets?.({ limit: limits.perStoreLimit }) || [] });
    for (const packet of executionData?.packets || []) {
      const execution = addNode("execution", packet.packetId, { source: "execution-outcome", status: packet.outcome, hash: packet.source?.sourceRecordHash, createdAt: packet.settledAt, missing: false });
      const run = addNode("run", packet.source?.runId || "run-missing", { source: packet.source?.kind || "execution-outcome", status: packet.source?.terminalState || packet.outcome, createdAt: packet.settledAt, missing: false });
      addEdge(run, execution, "produced", "execution-outcome");
      for (const id of packet.evidenceRefs || []) { const evidenceNode = nodes.has(nodeId("evidence", id)) ? nodeId("evidence", id) : addRefNode(id); addEdge(evidenceNode, execution, "supports", "execution-outcome", packet.outcome); }
      for (const item of packet.artifactRefs || []) { const artifact = addNode("artifact", item.id, { source: item.kind || "artifact", status: "observed", hash: item.hash, missing: false }); addEdge(artifact, execution, "supports", "execution-outcome"); }
    }

    const learningData = provider("learning-loop", () => this.learning?.provenanceRecords ? this.learning.provenanceRecords({ limit: limits.perStoreLimit }) : { outcomes: [], patterns: [], proposals: [], decisions: [] });
    for (const item of learningData?.outcomes || []) {
      const outcome = addNode("learning-outcome", item.outcomeId, { source: "learning-loop", status: item.signals?.status || "observed", hash: item.fingerprint ? `fingerprint:${component(item.fingerprint, "fingerprint")}` : null, createdAt: item.createdAt, missing: false });
      for (const id of item.artifacts?.evidenceRefs || []) { const ref = nodes.has(nodeId("evidence", id)) ? nodeId("evidence", id) : addRefNode(id); addEdge(ref, outcome, "supports", "learning-loop"); }
      for (const id of item.artifacts?.traceRefs || []) { const ref = nodes.has(referenceNode(id)) ? referenceNode(id) : addRefNode(id); addEdge(ref, outcome, "derived-from", "learning-loop"); }
    }
    for (const item of learningData?.patterns || []) {
      const pattern = addNode("learning-pattern", item.patternId, { source: "learning-loop", status: item.status || "observed", hash: item.fingerprint ? `fingerprint:${component(item.fingerprint, "fingerprint")}` : null, createdAt: item.observedAt || item.createdAt, missing: false });
      for (const id of [...asArray(item.outcomeIds), ...asArray(item.sourceOutcomeIds), ...asArray(item.linkedOutcomeIds)]) { const ref = nodes.has(nodeId("learning-outcome", id)) ? nodeId("learning-outcome", id) : addRefNode(id); addEdge(ref, pattern, "derived-from", "learning-loop"); }
    }
    for (const item of learningData?.proposals || []) {
      const proposal = addNode("learning-proposal", item.proposalId, { source: "learning-loop", status: item.status || "draft", createdAt: item.createdAt, missing: false });
      for (const id of item.evidenceRefs || []) { const ref = nodes.has(nodeId("evidence", id)) ? nodeId("evidence", id) : addRefNode(id); addEdge(ref, proposal, "supports", "learning-loop", item.status || "draft"); }
      for (const id of [...asArray(item.patternIds), ...asArray(item.sourcePatternIds)]) { const ref = nodes.has(nodeId("learning-pattern", id)) ? nodeId("learning-pattern", id) : addRefNode(id); addEdge(ref, proposal, "informed", "learning-loop"); }
      for (const id of [...asArray(item.outcomeIds), ...asArray(item.sourceOutcomeIds)]) { const ref = nodes.has(nodeId("learning-outcome", id)) ? nodeId("learning-outcome", id) : addRefNode(id); addEdge(ref, proposal, "informed", "learning-loop"); }
      for (const id of item.verificationResult?.evidenceRefs || []) { const ref = nodes.has(nodeId("evidence", id)) ? nodeId("evidence", id) : addRefNode(id); addEdge(ref, proposal, item.status === "dismissed" ? "rejected" : "verified", "learning-loop", item.status || "observed"); }
    }
    for (const item of learningData?.decisions || []) {
      const rawStatus = item.status || "";
      const status = /dismiss|reject|fail/.test(String(rawStatus)) || item.ok === false || /dismiss|reject/.test(String(item.type || "")) ? "rejected" : /approv|accept|applied|verified/.test(String(rawStatus)) || item.ok === true ? "accepted" : rawStatus || "observed";
      const decision = addNode("learning-decision", `${item.type || "decision"}:${item.proposalId || item.outcomeId || item.patternId || "record"}:${item.at || "unknown"}`, { source: "learning-loop", status, createdAt: item.at, missing: false });
      for (const id of item.evidenceRefs || []) { const ref = nodes.has(nodeId("evidence", id)) ? nodeId("evidence", id) : addRefNode(id); addEdge(ref, decision, "supports", "learning-loop", status); }
      if (item.proposalId) { const ref = nodes.has(nodeId("learning-proposal", item.proposalId)) ? nodeId("learning-proposal", item.proposalId) : addRefNode(item.proposalId); addEdge(decision, ref, status === "rejected" ? "rejected" : status === "accepted" || status === "approved" ? "accepted" : "reviewed", "learning-loop", status); }
      if (item.outcomeId) { const ref = nodes.has(nodeId("learning-outcome", item.outcomeId)) ? nodeId("learning-outcome", item.outcomeId) : addRefNode(item.outcomeId); addEdge(ref, decision, "recorded-by", "learning-loop", status); }
      if (item.patternId) { const ref = nodes.has(nodeId("learning-pattern", item.patternId)) ? nodeId("learning-pattern", item.patternId) : addRefNode(item.patternId); addEdge(ref, decision, "recorded-by", "learning-loop", status); }
    }

    const skillData = provider("skill-synthesis", () => this.skills?.provenanceRecords ? this.skills.provenanceRecords({ limit: limits.perStoreLimit }) : { captures: [], skills: [], failurePatterns: [], evaluations: [] });
    for (const item of skillData?.captures || []) {
      const capture = addNode("skill-capture", item.captureId, { source: "skill-synthesis", status: item.outcome || "observed", hash: item.workflowSignature ? `signature:${component(item.workflowSignature, "signature")}` : null, createdAt: item.createdAt, missing: false });
      const references = [...Object.values(item.replayRefs || {}).flat(), ...asArray(item.provenance?.executionPacketId), ...asArray(item.provenance?.packetId), ...asArray(item.provenance?.topologyRunId)].filter(Boolean);
      for (const id of references) { const ref = nodes.has(referenceNode(id)) ? referenceNode(id) : addRefNode(id); addEdge(ref, capture, "captured-as", "skill-synthesis"); }
      for (const id of [...asArray(item.verification?.evidenceIds), ...asArray(item.provenance?.evidenceIds)]) { const ref = nodes.has(nodeId("evidence", id)) ? nodeId("evidence", id) : addRefNode(id); addEdge(ref, capture, "supports", "skill-synthesis"); }
    }
    for (const item of skillData?.skills || []) {
      const exactId = `${item.skillId}@${Number(item.version || 1)}`;
      const skill = addNode("skill-version", exactId, { source: "skill-synthesis", status: item.status || "draft", version: item.version || 1, hash: item.provenance?.sourceHash || null, createdAt: item.updatedAt || item.createdAt, missing: false });
      addNode("skill", item.skillId, { source: "skill-synthesis", status: item.status || "draft", version: item.version || 1, createdAt: item.updatedAt || item.createdAt, missing: false });
      addEdge(skill, nodeId("skill", item.skillId), "version-of", "skill-synthesis");
      for (const id of item.provenance?.captureIds || []) { const ref = nodes.has(nodeId("skill-capture", id)) ? nodeId("skill-capture", id) : addRefNode(id); addEdge(ref, skill, "derived-from", "skill-synthesis"); }
      if (item.provenance?.sourceHash) { const source = addNode("source-version", item.provenance.sourceHash, { source: "skill-synthesis", status: item.evidenceState?.sourceTrust?.status || "untrusted", hash: item.provenance.sourceHash, missing: false }); addEdge(source, skill, "exact-source", "skill-synthesis"); }
      const versions = [...new Set((item.versionHistory || []).map((row) => Number(row.version)).filter((version) => Number.isFinite(version) && version > 0))].sort((a, b) => a - b);
      for (const version of versions) addNode("skill-version", `${item.skillId}@${version}`, { source: "skill-synthesis", status: version === Number(item.version) ? item.status || "observed" : "historical", version, missing: false });
      for (let index = 1; index < versions.length; index++) addEdge(nodeId("skill-version", `${item.skillId}@${versions[index]}`), nodeId("skill-version", `${item.skillId}@${versions[index - 1]}`), "supersedes", "skill-synthesis");
    }
    for (const item of skillData?.failurePatterns || []) {
      const pattern = addNode("skill-failure-pattern", item.patternId, { source: "skill-synthesis", status: "observed", hash: item.signature ? `signature:${component(item.signature, "signature")}` : null, createdAt: item.createdAt, missing: false });
      for (const id of item.linkedCaptureIds || []) { const ref = nodes.has(nodeId("skill-capture", id)) ? nodeId("skill-capture", id) : addRefNode(id); addEdge(ref, pattern, "derived-from", "skill-synthesis"); }
    }

    const memoryData = provider("project-memory", () => this.projectMemory?.provenanceRecords ? this.projectMemory.provenanceRecords({ limit: limits.perStoreLimit }) : { entries: [], decisions: [] });
    for (const item of memoryData?.entries || []) {
      const memory = addNode("memory", item.id, { source: "project-memory", status: item.verification || "unverified", hash: item.candidateHash || null, createdAt: item.updatedAt, missing: false });
      for (const id of item.evidenceIds || []) { const ref = nodes.has(nodeId("evidence", id)) ? nodeId("evidence", id) : addRefNode(id); addEdge(ref, memory, "supports", "project-memory"); }
      for (const id of item.sourceFingerprints || []) { const ref = nodes.has(referenceNode(id)) ? referenceNode(id) : addRefNode(id); addEdge(ref, memory, "derived-from", "project-memory"); }
      for (const id of item.supersedes || []) { const ref = nodes.has(nodeId("memory", id)) ? nodeId("memory", id) : addRefNode(id); addEdge(memory, ref, "supersedes", "project-memory"); }
      for (const id of item.contradicts || []) { const ref = nodes.has(nodeId("memory", id)) ? nodeId("memory", id) : addRefNode(id); addEdge(memory, ref, "conflicts", "project-memory"); }
    }
    for (const item of memoryData?.decisions || []) {
      const decision = addNode("memory-decision", item.decisionId, { source: "project-memory", status: item.action || "observed", createdAt: item.at, missing: false });
      const candidateHash = item.candidateHash || `missing-${item.decisionId}`;
      const candidateNode = addNode("memory-candidate", candidateHash, { source: "project-memory", status: item.action || "observed", hash: item.candidateHash || null, missing: !item.candidateHash });
      addEdge(decision, candidateNode, item.action === "rejected" ? "rejected" : item.action === "superseded" ? "supersedes" : ["saved", "updated", "deduped"].includes(item.action) ? "accepted" : "reviewed", "project-memory", item.action || "observed");
      for (const id of item.evidenceIds || []) { const ref = nodes.has(nodeId("evidence", id)) ? nodeId("evidence", id) : addRefNode(id); addEdge(ref, decision, "supports", "project-memory", item.action || "observed"); }
    }

    const allNodes = [...nodes.values()];
    const allEdges = [...edges.values()];
    const seedValues = [...new Set(asArray(input.seedIds || input.seeds).map(String).filter(Boolean))].slice(0, 64);
    const resolvedSeeds = seedValues.map((seed) => {
      if (nodes.has(seed)) return seed;
      const matches = allNodes.filter((item) => item.id.endsWith(`:${component(seed)}`) || item.id === referenceNode(seed));
      return matches.length === 1 ? matches[0].id : null;
    }).filter(Boolean);
    let selectedIds;
    if (resolvedSeeds.length) {
      selectedIds = new Set(resolvedSeeds);
      let frontier = new Set(resolvedSeeds);
      for (let depth = 0; depth < limits.depth && frontier.size; depth++) {
        const next = new Set();
        for (const edge of allEdges) if (frontier.has(edge.from) || frontier.has(edge.to)) {
          const other = frontier.has(edge.from) ? edge.to : edge.from;
          if (!selectedIds.has(other)) next.add(other);
          selectedIds.add(edge.from); selectedIds.add(edge.to);
          if (selectedIds.size >= limits.maxNodes) break;
        }
        frontier = next;
        if (selectedIds.size >= limits.maxNodes) { nodeTruncated = true; break; }
      }
    } else selectedIds = new Set(allNodes.slice(0, limits.maxNodes).map((item) => item.id));
    if (allNodes.length > selectedIds.size && !resolvedSeeds.length) nodeTruncated = true;
    const selectedNodes = allNodes.filter((item) => selectedIds.has(item.id)).slice(0, limits.maxNodes).sort((a, b) => a.id.localeCompare(b.id));
    const selectedNodeIds = new Set(selectedNodes.map((item) => item.id));
    const selectedEdges = allEdges.filter((item) => selectedNodeIds.has(item.from) && selectedNodeIds.has(item.to)).slice(0, limits.maxEdges).sort((a, b) => a.id.localeCompare(b.id));
    if (allEdges.filter((item) => selectedNodeIds.has(item.from) && selectedNodeIds.has(item.to)).length > selectedEdges.length) edgeTruncated = true;

    const diagnostics = [];
    for (const item of selectedNodes.filter((node) => node.missing)) diagnostics.push({ code: "dangling-node", severity: "warning", nodeId: item.id });
    for (const edge of selectedEdges) { const from = selectedNodes.find((node) => node.id === edge.from); const to = selectedNodes.find((node) => node.id === edge.to); if (!from || !to || from.missing === true || to.missing === true) diagnostics.push({ code: "dangling-edge", severity: "warning", edgeId: edge.id }); }
    for (const item of selectedNodes) {
      const supportStatuses = selectedEdges.filter((edge) => edge.to === item.id && edge.type === "supports").map((edge) => selectedNodes.find((node) => node.id === edge.from)?.status).filter(Boolean);
      if (supportStatuses.some((status) => status === "accepted") && supportStatuses.some((status) => status === "rejected")) diagnostics.push({ code: "conflicting-support", severity: "warning", nodeId: item.id });
      if (item.kind === "skill-version" && (!item.hash || !item.version)) diagnostics.push({ code: "exact-version-lineage-incomplete", severity: "warning", nodeId: item.id });
      if (["rejected", "superseded", "dismissed"].includes(item.status)) diagnostics.push({ code: item.status, severity: "info", nodeId: item.id });
    }
    if (seedValues.length && resolvedSeeds.length !== seedValues.length) diagnostics.push({ code: "seed-unresolved", severity: "warning", unresolvedCount: seedValues.length - resolvedSeeds.length });
    const timeTruncated = timeExceeded(started, limits.maxElapsedMs);
    const graph = {
      schemaVersion: PROVENANCE_GRAPH_SCHEMA_VERSION,
      graphId: `provenance_${hash({ seeds: resolvedSeeds, nodes: selectedNodes.map((item) => item.id), edges: selectedEdges.map((item) => item.id) }, 24)}`,
      generatedAt: new Date(this.clock()).toISOString(),
      seeds: resolvedSeeds,
      nodes: selectedNodes,
      edges: selectedEdges,
      diagnostics: diagnostics.slice(0, 500),
      coverage: { complete: unavailableProviders.length === 0 && !nodeTruncated && !edgeTruncated && !timeTruncated, providers, unavailableProviders: [...new Set(unavailableProviders)].sort(), nodeTruncated, edgeTruncated, timeTruncated, elapsedMs: Date.now() - started, limits },
      boundaries: { readOnly: true, metadataOnly: true, recordsCopied: false, rawSessionsRead: false, promptStored: false, transcriptStored: false, privateReasoningStored: false, commandArgumentsStored: false, rawToolOutputStored: false, absolutePathsStored: false },
    };
    assertMetadataOnly(graph);
    return graph;
  }
  lineage(seedId, options = {}) { return this.build({ ...options, seedIds: [seedId] }); }
  export(input = {}, options = {}) {
    if (!this.enabled) throw Object.assign(new Error("provenance graph is disabled"), { code: "PROVENANCE_GRAPH_DISABLED" });
    if (options.explicit !== true) throw Object.assign(new Error("provenance export requires an explicit current-user request"), { code: "PROVENANCE_EXPORT_EXPLICIT_REQUIRED" });
    const name = String(options.fileName || `provenance-${Date.now()}.json`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}\.json$/.test(name)) throw new Error("provenance export fileName must be a safe .json basename");
    const graph = this.build(input);
    const file = path.join(this.root, "exports", name);
    writePrivateJson(file, graph);
    return { graphId: graph.graphId, nodes: graph.nodes.length, edges: graph.edges.length, relativePath: path.relative(this.cwd, file).replace(/\\/g, "/"), private: true };
  }
}

module.exports = { PROVENANCE_GRAPH_SCHEMA_VERSION, DEFAULT_LIMITS, ProvenanceGraphAdapter, assertMetadataOnly, referenceKind, nodeId };
