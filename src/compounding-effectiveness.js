"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writePrivateJson, appendPrivate } = require("./project-memory-decisions");

const COMPOUNDING_SCORECARD_SCHEMA_VERSION = 1;
const COMPOUNDING_SCORECARD_DIRECTORY = path.join(".pi", "learning-loop", "scorecards");
const EVIDENCE_CLASSES = Object.freeze(["deterministic", "synthetic", "migration", "exact-version-field", "user-reviewed-gold"]);
const DEFAULT_LIMITS = Object.freeze({ perStore: 1000, maxFileBytes: 20 * 1024 * 1024, maxElapsedMs: 5000, maxGraphNodes: 1000, maxGraphEdges: 2000 });
const FORBIDDEN_KEY = /prompt|transcript|reasoning|commandarguments|commandargs|rawtooloutput|tooloutput|stdout|stderr|password|secret|authorization|taskbody|sourcebody/i;
const ABSOLUTE_PATH = /(?:^|\s)\/(?:home|Users|tmp|etc|var)\/|[A-Za-z]:\\/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); return value; }
function stableStringify(value) { return JSON.stringify(stable(value)); }
function digest(value, length = 24) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex").slice(0, length); }
function safeId(value, prefix = "ref") { const text = String(value || "").trim(); return SAFE_ID.test(text) && !/(?:secret|password|token|authorization|api[_-]?key)/i.test(text) ? text : `${prefix}_${digest(text || prefix, 20)}`; }
function finite(value) { if (value === null || value === undefined || value === "") return null; const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function unique(values) { return [...new Set((values || []).filter((value) => value != null))]; }
function evidenceClass(value) { return EVIDENCE_CLASSES.includes(value) ? value : "deterministic"; }
function wilsonLower(successes, total, z = 1.96) { if (!total) return null; const p = successes / total; const z2 = z * z; return (p + z2 / (2 * total) - z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / (1 + z2 / total); }
function observationSpanDays(values) { const timestamps = (values || []).map((value) => Date.parse(value || 0)).filter(Number.isFinite).sort((a, b) => a - b); return timestamps.length >= 2 ? Math.floor((timestamps.at(-1) - timestamps[0]) / 86400000) : 0; }
function percentile(values, percent) { const sorted = (values || []).map(finite).filter((value) => value != null).sort((a, b) => a - b); if (!sorted.length) return null; const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(percent * sorted.length) - 1)); return sorted[index]; }
function metric(value, sampleSize, evidence = "deterministic", options = {}) {
  const samples = Math.max(0, Number(sampleSize || 0));
  if (!samples || value == null || !Number.isFinite(Number(value))) return { status: "insufficient-data", value: null, sampleSize: samples, evidenceClass: evidenceClass(evidence), ...(options.note ? { note: options.note } : {}) };
  return { status: options.status || "observed", value: Number(value), sampleSize: samples, evidenceClass: evidenceClass(evidence), ...(options.bar != null ? { bar: options.bar } : {}) };
}
function countMetric(value, observed, evidence = "deterministic") { return observed ? { status: "observed", value: Number(value || 0), sampleSize: Number(observed), evidenceClass: evidenceClass(evidence) } : { status: "insufficient-data", value: null, sampleSize: 0, evidenceClass: evidenceClass(evidence) }; }
function rate(numerator, denominator, evidence = "deterministic") { return metric(denominator > 0 ? numerator / denominator : null, denominator, evidence); }
function stageSummary(rows = [], evidence = "deterministic") {
  const result = { samples: rows.length, evidenceClass: evidenceClass(evidence) };
  for (const field of ["durationMs", "modelCalls", "toolCalls"]) {
    const values = rows.map((row) => finite(row?.metrics?.[field])).filter((value) => value != null);
    result[field] = { p50: metric(percentile(values, 0.50), values.length, evidence), p95: metric(percentile(values, 0.95), values.length, evidence) };
  }
  const contextValues = rows.map((row) => finite(row?.metrics?.contextAdded)).filter((value) => value != null && value > 0);
  result.contextAdded = { p50: metric(percentile(contextValues, 0.50), contextValues.length, evidence), p95: metric(percentile(contextValues, 0.95), contextValues.length, evidence) };
  return result;
}
function isSafeLocalPath(cwd, target) {
  const root = path.resolve(cwd); const resolved = path.resolve(target); const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) { current = path.join(current, segment); try { if (fs.lstatSync(current).isSymbolicLink()) return false; } catch (error) { if (error?.code === "ENOENT") return true; return false; } }
  return true;
}
function readSafeJson(cwd, file, fallback, maxBytes) { try { if (!isSafeLocalPath(cwd, file)) return fallback; const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return fallback; return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function readSafeJsonl(cwd, file, maxBytes, limit = 1000) { try { if (!isSafeLocalPath(cwd, file)) return []; const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return []; return fs.readFileSync(file, "utf8").split(/\n+/).filter(Boolean).slice(-limit).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; } }
function assertMetadataOnly(value, at = "scorecard") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertMetadataOnly(item, `${at}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).forEach(([key, child]) => { if (FORBIDDEN_KEY.test(key) && child !== false) throw new Error(`${at}.${key} is forbidden in compounding scorecards`); if (/^(?:path|file|directory|cwd|content|summary|message|text)$/i.test(key)) throw new Error(`${at}.${key} is forbidden in compounding scorecards`); assertMetadataOnly(child, `${at}.${key}`); });
  if (typeof value === "string" && ABSOLUTE_PATH.test(value)) throw new Error(`${at} contains an absolute path`);
}
function providerResult(name, fn, unavailable) { try { return { available: true, value: fn() || {} }; } catch (error) { unavailable.push(name); return { available: false, value: {}, errorCode: safeId(error?.code || error?.name || "provider-failed", "error") }; } }
function groupBy(rows, keyFn) { const groups = new Map(); for (const row of rows || []) { const key = keyFn(row); const current = groups.get(key) || []; current.push(row); groups.set(key, current); } return groups; }
function safeHash(value) { return SHA256.test(String(value || "")) ? String(value) : `sha256:${digest(String(value || "unknown"), 64)}`; }
function exactIdentity(row = {}) { return row.skillId && Number(row.version) > 0 && SHA256.test(String(row.sourceHash || "")) ? `${safeId(row.skillId, "skill")}@${Number(row.version)}:${row.sourceHash}` : null; }

class CompoundingEffectivenessAdapter {
  constructor({ enabled = true, cwd = process.cwd(), root, skills, learning, executionOutcomes, maintenance, provenance, storage = null, providers = {}, limits = {}, clock = () => new Date(), experimentId = "exp-memory-learning-compounding-efficacy-field" } = {}) {
    this.enabled = enabled !== false;
    this.cwd = path.resolve(cwd);
    this.root = path.resolve(root || path.join(this.cwd, COMPOUNDING_SCORECARD_DIRECTORY));
    if (!this.root.startsWith(`${this.cwd}${path.sep}`) || !isSafeLocalPath(this.cwd, this.root)) throw new Error("compounding scorecard root must stay inside a non-symlinked project state path");
    this.latestFile = path.join(this.root, "latest.json");
    this.indexFile = path.join(this.root, "index.jsonl");
    this.skills = skills || null; this.learning = learning || null; this.executionOutcomes = executionOutcomes || null; this.maintenance = maintenance || null; this.provenance = provenance || null; this.storage = storage;
    this.providers = providers || {}; this.limits = { ...DEFAULT_LIMITS, ...(limits || {}) }; this.clock = clock; this.experimentId = experimentId;
  }
  sourceIdentity() {
    const names = ["src/compounding-effectiveness.js", "src/execution-outcome.js", "src/skill-governance.js", "src/skill-synthesis.js", "src/learning-loop.js", "src/memory-maintenance.js", "src/provenance-graph.js", "src/integration-boundary.js"];
    const sourceRoot = path.resolve(__dirname, "..");
    const records = names.map((name) => {
      const file = path.join(sourceRoot, name);
      const id = safeId(name.replaceAll("/", ":"), "source");
      try {
        if (!isSafeLocalPath(sourceRoot, file)) return { id, hash: null };
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.limits.maxFileBytes) return { id, hash: null };
        const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
        return { id, hash: `sha256:${hash}` };
      } catch { return { id, hash: null }; }
    });
    const configuration = {
      executionCapture: process.env.PI_EXECUTION_OUTCOME_CAPTURE !== "0",
      executionLearning: process.env.PI_EXECUTION_OUTCOME_LEARNING !== "0",
      executionSkills: process.env.PI_EXECUTION_OUTCOME_SKILLS !== "0",
      skillGovernanceV2: process.env.PI_SKILL_GOVERNANCE_V2 !== "0",
      maintenanceIntervalHours: Number(process.env.PI_MEMORY_MAINTENANCE_PREVIEW_INTERVAL_HOURS || 0),
      intakeEnabled: process.env.PI_SKILL_INTAKE_ENABLED !== "0",
      compoundingEnabled: process.env.PI_COMPOUNDING_EFFECTIVENESS_ENABLED !== "0",
    };
    return { implementationHash: `sha256:${digest(records, 64)}`, configurationHash: `sha256:${digest(configuration, 64)}`, complete: records.every((item) => item.hash), records };
  }
  status() { const latest = readSafeJson(this.cwd, this.latestFile, null, this.limits.maxFileBytes); return { enabled: this.enabled, schemaVersion: COMPOUNDING_SCORECARD_SCHEMA_VERSION, latest: latest ? { scorecardId: latest.scorecardId, generatedAt: latest.generatedAt, decision: latest.decision, gateStatuses: Object.fromEntries(Object.entries(latest.gates || {}).map(([key, value]) => [key, value.status])) } : null, fieldRolloutAuthorized: false, projectMemoryStageChanged: false }; }
  defaultGoalActions(limit) {
    const dir = path.join(this.cwd, ".pi", "goal-state");
    if (!isSafeLocalPath(this.cwd, dir) || !fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((name) => /^[A-Za-z0-9._-]+(?:\.archive)?\.json$/.test(name)).slice(0, 20);
    const rows = [];
    for (const name of files) {
      const data = readSafeJson(this.cwd, path.join(dir, name), {}, this.limits.maxFileBytes);
      for (const goal of (data.goals || []).slice(-limit)) for (const item of (goal.history || []).slice(-100)) if (Number.isFinite(Number(item.actionLatencyMs))) rows.push({ metrics: { durationMs: Number(item.actionLatencyMs), modelCalls: 1, toolCalls: item.executed === true ? 1 : 0, contextAdded: finite(item.contextAdded) }, actionKind: safeId(item.action?.kind || item.attemptedActionKind || "unknown", "action"), resultCode: safeId(item.actionResultCode || item.reasonCode || item.status || "unknown", "result"), at: item.at || goal.updatedAt });
    }
    return rows.slice(-limit);
  }
  defaultIntakeRuns(limit) {
    if (!this.storage?.readJsonl) return [];
    const rows = (this.storage.readJsonl("topologies/runs") || []).filter((row) => row.topologyId === "governed-skill-intake").slice(-limit);
    return rows.map((row) => { const run = this.storage.readJson?.(`topologies/runs/${row.runId}`, null) || {}; const results = run.results || []; return { runId: safeId(row.runId, "run"), status: safeId(row.status || "unknown", "status"), at: row.finishedAt || row.startedAt, metrics: { durationMs: finite(row.durationMs) ?? finite(run.durationMs), modelCalls: results.reduce((sum, item) => sum + Number(item.provenance?.modelCalls || item.modelCalls || 0), 0), toolCalls: results.reduce((sum, item) => sum + Number(item.provenance?.toolCalls || item.toolCalls || 0), 0), contextAdded: results.reduce((sum, item) => sum + Number(item.provenance?.contextAdded || item.contextAdded || 0), 0) } }; });
  }
  defaultMemoryScorecard() { return readSafeJson(this.cwd, path.join(this.cwd, ".pi", "memory-effectiveness", "scorecard.json"), null, this.limits.maxFileBytes) || readSafeJson(this.cwd, path.join(this.cwd, "docs", "memory-effectiveness-scorecard.json"), null, this.limits.maxFileBytes); }
  defaultClaimMetrics(limit) {
    const rows = readSafeJsonl(this.cwd, path.join(this.cwd, ".pi", "evidence-binder", "claims.jsonl"), this.limits.maxFileBytes, limit);
    let claims = 0; let unsupported = 0;
    for (const row of rows) { claims += Array.isArray(row.result?.claims) ? row.result.claims.length : 0; unsupported += Array.isArray(row.result?.unsupported) ? row.result.unsupported.length : 0; }
    return { records: rows.length, claims, unsupported };
  }
  collect(options = {}) {
    const unavailable = [];
    const limit = Math.max(1, Math.min(5000, Number(options.limit || this.limits.perStore)));
    const skills = providerResult("skills", () => this.providers.skills ? this.providers.skills({ limit }) : this.skills?.compoundingRecords?.({ limit }) || {}, unavailable);
    const learning = providerResult("learning", () => this.providers.learning ? this.providers.learning({ limit }) : this.learning?.compoundingRecords?.({ limit }) || {}, unavailable);
    const execution = providerResult("execution", () => this.providers.execution ? this.providers.execution({ limit }) : this.executionOutcomes?.compoundingRecords?.({ limit }) || {}, unavailable);
    const maintenance = providerResult("maintenance", () => this.providers.maintenance ? this.providers.maintenance({ limit }) : { reports: this.maintenance?.history?.({ limit }) || [] }, unavailable);
    const provenance = providerResult("provenance", () => this.providers.provenance ? this.providers.provenance({ limit }) : this.provenance?.build?.({ maxNodes: this.limits.maxGraphNodes, maxEdges: this.limits.maxGraphEdges, perStoreLimit: limit, maxElapsedMs: this.limits.maxElapsedMs }) || {}, unavailable);
    const goal = providerResult("goal-actions", () => this.providers.goalActions ? this.providers.goalActions({ limit }) : { actions: this.defaultGoalActions(limit) }, unavailable);
    const intake = providerResult("skill-intake", () => this.providers.intakeRuns ? this.providers.intakeRuns({ limit }) : { runs: this.defaultIntakeRuns(limit) }, unavailable);
    const memory = providerResult("memory-effectiveness", () => this.providers.memoryScorecard ? this.providers.memoryScorecard() : this.defaultMemoryScorecard() || {}, unavailable);
    const claims = providerResult("evidence-claims", () => this.providers.claimMetrics ? this.providers.claimMetrics({ limit }) : this.defaultClaimMetrics(limit), unavailable);
    const policy = providerResult("policy-review", () => this.providers.policyMetrics ? this.providers.policyMetrics({ limit }) : options.policyReview || { unresolvedHighSeverity: null, reviewedFindings: 0, evidenceClass: "user-reviewed-gold", evidenceIds: [] }, unavailable);
    return { skills: skills.value, learning: learning.value, execution: execution.value, maintenance: maintenance.value, provenance: provenance.value, goal: goal.value, intake: intake.value, memory: memory.value, claims: claims.value, policy: policy.value, coverage: { unavailableProviders: unique(unavailable).sort(), providers: { skills: { available: skills.available }, learning: { available: learning.available }, execution: { available: execution.available }, maintenance: { available: maintenance.available }, provenance: { available: provenance.available }, goalActions: { available: goal.available }, skillIntake: { available: intake.available }, memoryEffectiveness: { available: memory.available }, evidenceClaims: { available: claims.available }, policyReview: { available: policy.available } } } };
  }
  generate(options = {}) {
    if (!this.enabled) return { enabled: false, skipped: true, decision: "no-go-deferred" };
    const started = Date.now(); const data = this.collect(options); const skillData = data.skills || {}; const evaluations = skillData.evaluations || []; const captures = skillData.captures || []; const skillRows = skillData.skills || [];
    const captureById = new Map(captures.map((item) => [item.captureId, item]));
    const skillByExactIdentity = new Map(skillRows.map((item) => [exactIdentity({ skillId: item.skillId, version: item.version, sourceHash: item.sourceHash }), item]).filter(([identity]) => identity));
    const verifiedCaptureRows = [];
    for (const skill of skillRows) { const identity = exactIdentity({ skillId: skill.skillId, version: skill.version, sourceHash: skill.sourceHash }); if (!identity) continue; const verified = (skill.captureIds || []).map((id) => captureById.get(id)).filter((item) => item?.verificationOk === true && (item.evidenceIds || []).length > 0); verifiedCaptureRows.push({ skillId: safeId(skill.skillId, "skill"), version: Number(skill.version), sourceHash: safeHash(skill.sourceHash), verifiedCaptures: verified.length, evidenceClass: skill.field?.status === "field-proven" ? "exact-version-field" : "deterministic" }); }
    const uses = [...groupBy(evaluations.filter((row) => exactIdentity(row)), (row) => `${exactIdentity(row)}|${safeId(row.routingMode || "advisory", "routing")}`).entries()].map(([key, rows]) => ({ identityHash: `sha256:${digest(key, 64)}`, skillId: safeId(rows[0].skillId, "skill"), version: Number(rows[0].version), sourceHash: safeHash(rows[0].sourceHash), routingMode: safeId(rows[0].routingMode || "advisory", "routing"), sourceProvenance: safeId(skillByExactIdentity.get(exactIdentity(rows[0]))?.sourceTrust || "unknown", "source"), accepted: rows.filter((row) => row.result === "succeeded").length, rejected: rows.filter((row) => row.result === "failed").length, total: rows.length, evidenceClasses: Object.fromEntries(EVIDENCE_CLASSES.map((kind) => [kind, rows.filter((row) => evidenceClass(row.evidenceClass) === kind).length])) })).sort((a, b) => a.identityHash.localeCompare(b.identityHash));
    const failureEvents = skillData.failureEvents || []; const postMitigation = failureEvents.filter((row) => row.type === "failure_pattern.post_mitigation");
    const fieldPostMitigation = postMitigation.filter((row) => evidenceClass(row.evidenceClass) === "exact-version-field" && SHA256.test(String(row.sessionIdHash || "")) && (row.evidenceIds || []).length > 0);
    const failureLearning = {
      inventory: countMetric((skillData.failurePatterns || []).length, (skillData.failurePatterns || []).length),
      discovered: countMetric(failureEvents.filter((row) => row.type === "failure_pattern.discovered").length, failureEvents.length),
      laterMatches: countMetric(failureEvents.filter((row) => row.type === "failure_pattern.matched").length, failureEvents.length),
      mitigationReuse: countMetric(postMitigation.filter((row) => row.mitigationReused).length, postMitigation.length),
      postMitigationSuccess: rate(fieldPostMitigation.filter((row) => row.result === "succeeded").length, fieldPostMitigation.filter((row) => ["succeeded", "failed"].includes(row.result)).length, "exact-version-field"),
      postMitigationByEvidenceClass: Object.fromEntries(EVIDENCE_CLASSES.map((kind) => [kind, postMitigation.filter((row) => evidenceClass(row.evidenceClass) === kind).length])),
    };

    const outcomeRows = data.learning?.outcomes || []; const patternRows = data.learning?.patterns || []; const proposalRows = data.learning?.proposals || [];
    const outcomeIds = new Set(outcomeRows.map((item) => item.outcomeId)); const patternIds = new Set(patternRows.map((item) => item.patternId));
    const linkedPatterns = patternRows.filter((item) => (item.outcomeIds || []).some((id) => outcomeIds.has(id)));
    const linkedProposals = proposalRows.filter((item) => (item.evidenceIds || []).some((id) => outcomeIds.has(id) || patternIds.has(id)));
    const approvedProposals = proposalRows.filter((item) => ["approved", "applied"].includes(item.status)); const appliedProposals = proposalRows.filter((item) => item.status === "applied"); const fieldMeasuredProposals = proposalRows.filter((item) => typeof item.fieldProven === "boolean"); const fieldMeasuredApplied = appliedProposals.filter((item) => typeof item.fieldProven === "boolean"); const fieldProvenProposals = fieldMeasuredProposals.filter((item) => item.fieldProven === true);
    const funnel = { outcomes: countMetric(outcomeRows.length, outcomeRows.length), patterns: countMetric(linkedPatterns.length, patternRows.length), proposals: countMetric(linkedProposals.length, proposalRows.length), approved: countMetric(approvedProposals.length, proposalRows.length), applied: countMetric(appliedProposals.length, proposalRows.length), fieldProven: countMetric(fieldProvenProposals.length, fieldMeasuredProposals.length, "exact-version-field"), rates: { outcomeToPattern: rate(linkedPatterns.length, outcomeRows.length), patternToProposal: rate(linkedProposals.length, patternRows.length), proposalToApproved: rate(approvedProposals.length, proposalRows.length), approvedToApplied: rate(appliedProposals.length, approvedProposals.length), appliedToFieldProven: rate(fieldMeasuredApplied.filter((item) => item.fieldProven === true).length, fieldMeasuredApplied.length, "exact-version-field") } };

    const packetRows = data.execution?.packets || []; const graphData = data.provenance || {}; const evidenceNodes = new Set((graphData.nodes || []).filter((node) => node.kind === "evidence" && node.missing !== true).map((node) => node.id)); const packetEvidenceIds = packetRows.flatMap((item) => item.evidenceIds || []); const validPacketEvidenceIds = packetEvidenceIds.filter((id) => evidenceNodes.has(`evidence:${safeId(id, "evidence")}`)); const proposalEvidenceEligible = proposalRows.length; const outcomeEvidenceEligible = outcomeRows.length;
    const evidenceEligible = packetRows.length + proposalEvidenceEligible + outcomeEvidenceEligible;
    const evidenceLinked = packetRows.filter((item) => Number(item.evidenceCount || 0) > 0).length + proposalRows.filter((item) => (item.evidenceIds || []).length > 0).length + outcomeRows.filter((item) => (item.evidenceIds || []).length > 0).length;
    const claims = data.claims || {}; const evidenceMetrics = { coverage: rate(evidenceLinked, evidenceEligible), linkValidity: rate(validPacketEvidenceIds.length, packetEvidenceIds.length), unsupportedClaimRate: rate(Number(claims.unsupported || 0), Number(claims.claims || 0), "user-reviewed-gold"), claims: countMetric(claims.claims, claims.records, "user-reviewed-gold"), unsupported: countMetric(claims.unsupported, claims.records, "user-reviewed-gold") };

    const memory = data.memory || {}; const retrieval = memory.aggregates?.retrieval || {}; const field = memory.aggregates?.field || {};
    const memoryMetrics = {
      precisionAt5: metric(retrieval.precisionAt5, retrieval.returnedAt5, "user-reviewed-gold", { status: memory.scores?.retrievalPrecisionAt5?.status || "observed" }),
      staleRate: metric(field.currentFactStaleRate, memory.scores?.currentFactStaleRate?.sampleSize, "exact-version-field", { status: memory.scores?.currentFactStaleRate?.status || "insufficient-data" }),
      crossProjectContamination: metric(retrieval.contamination, retrieval.returnedAt5, "deterministic", { status: memory.scores?.crossProjectContamination?.status || "observed" }),
    };

    const reports = data.maintenance?.reports || []; const transitions = []; let priorTotal = 0; let accounted = 0; let stableShared = 0; let sharedTotal = 0;
    for (let index = 1; index < reports.length; index++) { const prior = new Set(reports[index - 1].candidateIds || []); const current = new Set(reports[index].candidateIds || []); const persistent = new Set(reports[index].accounting?.persistent || []); const resolved = new Set(reports[index].accounting?.resolved || []); for (const id of prior) { priorTotal++; if (persistent.has(id) || resolved.has(id)) accounted++; if (current.has(id)) { sharedTotal++; if (persistent.has(id)) stableShared++; } } transitions.push({ from: safeId(reports[index - 1].reportId, "report"), to: safeId(reports[index].reportId, "report") }); }
    const maintenanceCounts = reports.reduce((out, report) => { for (const key of ["new", "persistent", "resolved"]) out[key] += Number(report.accounting?.counts?.[key] || 0); return out; }, { new: 0, persistent: 0, resolved: 0 });
    const maintenanceObservedDays = observationSpanDays(reports.map((item) => item.generatedAt));
    const mutationViolations = reports.filter((item) => item.boundaries?.retentionApplied || item.boundaries?.permissionsApplied || item.boundaries?.memoryWritten || item.boundaries?.notesWritten || item.boundaries?.sourceDeleted).length;
    const maintenanceMetrics = { previews: countMetric(reports.length, reports.length), observedDays: metric(reports.length >= 2 ? maintenanceObservedDays : null, reports.length, "exact-version-field"), new: countMetric(maintenanceCounts.new, reports.length), persistent: countMetric(maintenanceCounts.persistent, reports.length), resolved: countMetric(maintenanceCounts.resolved, reports.length), applied: { status: "insufficient-data", value: null, sampleSize: 0, evidenceClass: "exact-version-field" }, ignored: { status: "insufficient-data", value: null, sampleSize: 0, evidenceClass: "exact-version-field" }, stableCandidateRate: rate(stableShared, sharedTotal, "exact-version-field"), resolutionAccountingRate: rate(accounted, priorTotal, "exact-version-field"), scheduledMutationViolations: countMetric(mutationViolations, reports.length, "exact-version-field"), transitions };

    const graph = graphData; const dangling = (graph.diagnostics || []).filter((item) => item.code === "dangling-edge").length; const graphEdges = (graph.edges || []).length;
    const provenanceMetrics = { edges: countMetric(graphEdges, graph.nodes?.length || graphEdges), danglingEdges: countMetric(dangling, graphEdges), danglingEdgeRate: rate(dangling, graphEdges), coverageComplete: graph.coverage ? { status: graph.coverage.complete ? "observed" : "degraded", value: graph.coverage.complete === true, sampleSize: 1, evidenceClass: "deterministic" } : { status: "insufficient-data", value: null, sampleSize: 0, evidenceClass: "deterministic" } };
    const privacyRejections = data.execution?.rejections || []; const memoryPrivacyHigh = finite(memory.aggregates?.privacy?.unresolvedHighSeverity);
    const privacyMetrics = { executionRejections: countMetric(privacyRejections.length, packetRows.length + privacyRejections.length), byReason: Object.fromEntries([...groupBy(privacyRejections, (row) => safeId(row.reasonCode || "unknown", "reason")).entries()].map(([key, rows]) => [key, rows.length]).sort()), unresolvedHighSeverity: memoryPrivacyHigh == null ? { status: "insufficient-data", value: null, sampleSize: 0, evidenceClass: "deterministic" } : { status: memoryPrivacyHigh === 0 ? "observed" : "fail", value: memoryPrivacyHigh, sampleSize: memory.aggregates?.privacy?.reviewedCandidates || memoryPrivacyHigh || 1, evidenceClass: "deterministic" } };
    const policy = data.policy || {}; const policyHigh = finite(policy.unresolvedHighSeverity); const policyEvidenceIds = unique(policy.evidenceIds || []).map((id) => safeId(id, "evidence")).filter((id) => evidenceNodes.has(`evidence:${id}`)); const policyMeasured = policyHigh != null && Number(policy.reviewedFindings || 0) > 0 && evidenceClass(policy.evidenceClass) === "user-reviewed-gold" && policyEvidenceIds.length > 0;
    const policyMetrics = { unresolvedHighSeverity: policyMeasured ? { status: policyHigh === 0 ? "observed" : "fail", value: policyHigh, sampleSize: Number(policy.reviewedFindings), evidenceClass: "user-reviewed-gold", evidenceIds: policyEvidenceIds } : { status: "insufficient-data", value: null, sampleSize: 0, evidenceClass: "user-reviewed-gold", evidenceIds: [] } };

    const packetStageRows = packetRows.map((item) => ({ metrics: item.metrics || {} })); const goalStageRows = data.goal?.actions || []; const intakeStageRows = data.intake?.runs || []; const maintenanceStageRows = reports.map((item) => ({ metrics: item.stageMetrics || {} }));
    const stagePerformance = { packet: stageSummary(packetStageRows), goalAction: stageSummary(goalStageRows), intake: stageSummary(intakeStageRows), maintenance: stageSummary(maintenanceStageRows) };

    const classCounts = Object.fromEntries(EVIDENCE_CLASSES.map((kind) => [kind, 0]));
    for (const row of [...evaluations, ...failureEvents, ...packetRows.map((item) => item.provenance || {}), ...outcomeRows]) classCounts[evidenceClass(row.evidenceClass)]++;
    classCounts["user-reviewed-gold"] += evaluations.filter((row) => (row.userReviewEvidenceIds || []).length > 0).length + (policyMeasured ? 1 : 0);
    const registeredFieldRows = evaluations.filter((row) => row.evidenceClass === "exact-version-field" && row.cohortId === this.experimentId && ["control", "candidate"].includes(row.arm) && SHA256.test(String(row.sessionIdHash || "")) && exactIdentity(row));
    const cohortId = options.cohortId || null; const cohortRegistered = cohortId === this.experimentId; const cohortRows = cohortRegistered ? evaluations.filter((row) => row.cohortId === cohortId) : [];
    const control = cohortRows.filter((row) => row.arm === "control"); const candidate = cohortRows.filter((row) => row.arm === "candidate");
    const exactRows = candidate.filter((row) => row.evidenceClass === "exact-version-field" && row.exactVersion === true && exactIdentity(row) && SHA256.test(String(row.sessionIdHash || "")));
    const exactIdentities = new Set(exactRows.map(exactIdentity)); const exactSessions = new Set(exactRows.map((row) => row.sessionIdHash)); const exactObservedDays = observationSpanDays(exactRows.map((row) => row.at)); const exactEvidenceCoverage = rate(exactRows.filter((row) => (row.evidenceIds || []).length > 0).length, exactRows.length, "exact-version-field");
    const exactCohorts = [...control, ...candidate].every((row) => Boolean(exactIdentity(row)) && row.exactVersion === true && SHA256.test(String(row.sessionIdHash || "")));
    const fieldCohorts = [...control, ...candidate].every((row) => row.evidenceClass === "exact-version-field");
    let deltas = { status: "insufficient-data", reasonCode: !cohortId ? "cohort-id-required" : !cohortRegistered ? "cohort-not-preregistered" : !control.length ? "control-cohort-empty" : !candidate.length ? "candidate-cohort-empty" : !exactCohorts ? "exact-version-identity-required" : !fieldCohorts ? "exact-version-field-required" : "unmeasured", cohortId: cohortId ? safeId(cohortId, "cohort") : null, controlCount: control.length, candidateCount: candidate.length };
    if (cohortRegistered && control.length && candidate.length && exactCohorts && fieldCohorts) {
      const successRate = (rows) => rows.filter((row) => row.result === "succeeded").length / rows.length;
      const unsupportedMeasured = [...control, ...candidate].every((row) => typeof row.unsupportedClaimDetected === "boolean" && (row.userReviewEvidenceIds || []).length > 0);
      const unsupportedRate = (rows) => unsupportedMeasured ? rows.filter((row) => row.unsupportedClaimDetected).length / rows.length : null;
      const armCosts = (rows) => ({ durationP95: percentile(rows.map((row) => row.latencyMs), 0.95), modelCallsP95: percentile(rows.map((row) => row.modelCalls), 0.95), toolCallsP95: percentile(rows.map((row) => row.toolCalls), 0.95), contextAddedP95: percentile(rows.map((row) => row.contextAdded), 0.95) });
      const controlCosts = armCosts(control); const candidateCosts = armCosts(candidate);
      const costFields = ["durationP95", "modelCallsP95", "toolCallsP95", "contextAddedP95"];
      const allCostsMeasured = costFields.every((field) => controlCosts[field] != null && candidateCosts[field] != null);
      const costWithin = allCostsMeasured && costFields.every((field) => controlCosts[field] === 0 ? candidateCosts[field] === 0 : candidateCosts[field] <= controlCosts[field] * 1.10);
      const qualityDelta = successRate(candidate) - successRate(control); const controlUnsupported = unsupportedRate(control); const candidateUnsupported = unsupportedRate(candidate); const unsupportedDelta = unsupportedMeasured ? candidateUnsupported - controlUnsupported : null;
      const controlSuccesses = control.filter((row) => row.result === "succeeded").length; const candidateSuccesses = candidate.filter((row) => row.result === "succeeded").length;
      const controlLowerBound = wilsonLower(controlSuccesses, control.length); const candidateLowerBound = wilsonLower(candidateSuccesses, candidate.length);
      deltas = { status: "computed", cohortId: safeId(cohortId, "cohort"), controlCount: control.length, candidateCount: candidate.length, verifiedSuccess: { control: successRate(control), candidate: successRate(candidate), delta: qualityDelta, lowerBound95: { control: controlLowerBound, candidate: candidateLowerBound, delta: candidateLowerBound - controlLowerBound } }, unsupportedClaimRate: { status: unsupportedMeasured ? "computed" : "insufficient-data", evidenceClass: "user-reviewed-gold", control: controlUnsupported, candidate: candidateUnsupported, delta: unsupportedDelta }, costs: { control: controlCosts, candidate: candidateCosts, measured: allCostsMeasured, withinBar: costWithin }, passBar: (qualityDelta >= 0.05 || (unsupportedMeasured && unsupportedDelta <= -0.05)) && costWithin };
    }

    const qualityNonRegression = deltas.status === "computed" && deltas.verifiedSuccess.lowerBound95.delta >= 0;
    const qualityNonRegressionMeasured = deltas.status === "computed";
    const explicitGateEvidence = options.gateEvidence || {};
    const gateFromExplicit = (gate) => {
      const input = explicitGateEvidence[gate]; const requiredClass = gate === "C0" ? "deterministic" : gate === "C1" ? "synthetic" : "exact-version-field"; const kind = evidenceClass(input?.evidenceClass); const evidenceIds = unique(input?.evidenceIds || []).map((id) => safeId(id, "evidence")).slice(0, 64);
      const evidenceKnown = evidenceIds.length > 0 && evidenceIds.every((id) => evidenceNodes.has(`evidence:${id}`));
      if (input?.ok === false && evidenceKnown && kind === requiredClass) return { status: "fail", evidenceClass: kind, evidenceIds };
      if (input?.ok === true && evidenceKnown && kind === requiredClass) return { status: "pass", evidenceClass: kind, evidenceIds };
      const reasonCode = !evidenceIds.length ? "evidence-required" : !evidenceKnown ? "evidence-not-found" : "evidence-class-mismatch";
      return { status: "insufficient-data", evidenceClass: requiredClass, evidenceIds: [], ...(input ? { reasonCode } : {}) };
    };
    const shadowPackets = packetRows.filter((row) => evidenceClass(row.provenance?.evidenceClass) === "exact-version-field"); const shadowEvidenceIds = shadowPackets.flatMap((row) => row.evidenceIds || []); const validShadowEvidenceIds = shadowEvidenceIds.filter((id) => evidenceNodes.has(`evidence:${safeId(id, "evidence")}`));
    const packetIds = new Set(shadowPackets.map((row) => row.packetId)); const pairedShadowOutcomes = outcomeRows.filter((row) => row.source === "execution" && packetIds.has(row.packetId));
    const c2EvidenceCoverage = shadowEvidenceIds.length ? validShadowEvidenceIds.length / shadowEvidenceIds.length : null; const corrections = pairedShadowOutcomes.filter((row) => row.userCorrectionDetected).length; const correctionRate = pairedShadowOutcomes.length ? corrections / pairedShadowOutcomes.length : null;
    const c2Measured = shadowPackets.length >= 20 && pairedShadowOutcomes.length >= 20 && c2EvidenceCoverage != null && privacyMetrics.unresolvedHighSeverity.value != null && pairedShadowOutcomes.every((row) => row.userCorrectionDetected === true || row.userCorrectionDetected === false);
    const gates = {
      C0: gateFromExplicit("C0"),
      C1: gateFromExplicit("C1"),
      C2: c2Measured ? { status: privacyMetrics.unresolvedHighSeverity.value === 0 && c2EvidenceCoverage >= 0.9 && correctionRate <= 0.05 ? "pass" : "fail", evidenceClass: "exact-version-field", sampleSize: shadowPackets.length, evidenceCoverage: c2EvidenceCoverage, classificationCorrectionRate: correctionRate } : { status: "insufficient-data", evidenceClass: "exact-version-field", sampleSize: shadowPackets.length, required: 20 },
      C3: exactRows.length >= 30 && exactIdentities.size === 1 && exactSessions.size >= 10 && exactObservedDays >= 14 && qualityNonRegressionMeasured && privacyMetrics.unresolvedHighSeverity.value != null && policyMetrics.unresolvedHighSeverity.value != null ? { status: exactEvidenceCoverage.value >= 0.9 && privacyMetrics.unresolvedHighSeverity.value === 0 && policyMetrics.unresolvedHighSeverity.value === 0 && qualityNonRegression ? "pass" : "fail", evidenceClass: "exact-version-field", uses: exactRows.length, exactIdentities: exactIdentities.size, independentSessions: exactSessions.size, observedDays: exactObservedDays, evidenceCoverage: exactEvidenceCoverage.value, qualityLowerBoundNonRegression: qualityNonRegression, privacyViolations: privacyMetrics.unresolvedHighSeverity.value, policyViolations: policyMetrics.unresolvedHighSeverity.value } : { status: "insufficient-data", evidenceClass: "exact-version-field", uses: exactRows.length, exactIdentities: exactIdentities.size, independentSessions: exactSessions.size, observedDays: exactObservedDays, qualityLowerBoundMeasured: qualityNonRegressionMeasured, privacyMeasured: privacyMetrics.unresolvedHighSeverity.value != null, policyMeasured: policyMetrics.unresolvedHighSeverity.value != null, required: { uses: 30, exactIdentities: 1, independentSessions: 10, observedDays: 14, qualityLowerBoundNonRegression: true } },
      C4: reports.length >= 4 && maintenanceObservedDays >= 14 && maintenanceMetrics.stableCandidateRate.value != null && maintenanceMetrics.resolutionAccountingRate.value != null ? { status: mutationViolations === 0 && maintenanceMetrics.stableCandidateRate.value === 1 && maintenanceMetrics.resolutionAccountingRate.value >= 0.95 ? "pass" : "fail", evidenceClass: "exact-version-field", previews: reports.length, observedDays: maintenanceObservedDays, mutationViolations, stableCandidateRate: maintenanceMetrics.stableCandidateRate.value, resolutionAccountingRate: maintenanceMetrics.resolutionAccountingRate.value } : { status: "insufficient-data", evidenceClass: "exact-version-field", previews: reports.length, observedDays: maintenanceObservedDays, required: { previews: 4, observedDays: 14 } },
      C5: deltas.status === "computed" && deltas.costs.measured && privacyMetrics.unresolvedHighSeverity.value != null ? { status: deltas.passBar && privacyMetrics.unresolvedHighSeverity.value === 0 ? "pass" : "fail", evidenceClass: "exact-version-field", cohortId: deltas.cohortId, privacyViolations: privacyMetrics.unresolvedHighSeverity.value } : { status: "insufficient-data", evidenceClass: "exact-version-field", reasonCode: deltas.status !== "computed" ? deltas.reasonCode : !deltas.costs.measured ? "cost-measurement-required" : "privacy-measurement-required" },
    };

    const pilot = skillData.reviewedPilot;
    if (pilot?.cohortId === cohortId && pilot.verdict !== "ready-for-human-decision") {
      for (const gate of ["C3", "C5"]) gates[gate] = { ...gates[gate], status: pilot.verdict === "fail" ? "fail" : "insufficient-data", reasonCode: "advisory-pilot-protocol-not-met" };
    }
    for (const value of Object.values(explicitGateEvidence)) if (value && Array.isArray(value.evidenceIds)) classCounts[evidenceClass(value.evidenceClass)] += value.evidenceIds.length;
    const generatedAt = new Date(options.now || this.clock()).toISOString();
    const sourceIdentity = this.sourceIdentity();
    const scorecard = {
      schemaVersion: COMPOUNDING_SCORECARD_SCHEMA_VERSION,
      generatedAt,
      scorecardId: "pending",
      experiment: { experimentId: safeId(this.experimentId, "experiment"), status: registeredFieldRows.length > 0 ? "collecting" : "pre-registered", fieldRunStarted: registeredFieldRows.length > 0 },
      sourceIdentity,
      evidenceClasses: EVIDENCE_CLASSES,
      evidenceClassCounts: classCounts,
      metrics: { skills: { verifiedCapturesByExactVersion: verifiedCaptureRows, usesByExactVersionSourceAndRouting: uses, failureLearning }, learningFunnel: funnel, evidence: evidenceMetrics, memory: memoryMetrics, stagePerformance, maintenance: maintenanceMetrics, privacy: privacyMetrics, policy: policyMetrics, provenance: provenanceMetrics },
      machineVerificationPilot: skillData.machineVerificationPilot || null,
      cohorts: { exactVersionField: { uses: exactRows.length, independentSessions: exactSessions.size, observedDays: exactObservedDays, evidenceCoverage: exactEvidenceCoverage }, comparison: deltas },
      gates,
      coverage: { complete: sourceIdentity.complete && data.coverage.unavailableProviders.length === 0 && Date.now() - started <= this.limits.maxElapsedMs, ...data.coverage, elapsedMs: Date.now() - started, truncated: Date.now() - started > this.limits.maxElapsedMs },
      decision: "no-go-deferred",
      highestAuthorizedProjectMemoryStage: "M0",
      automaticBehaviorAuthorized: false,
      routingChangeAuthorized: false,
      publishAuthorized: false,
      boundaries: { metadataOnly: true, taskBodiesStored: false, sourceBodiesStored: false, promptsStored: false, transcriptsStored: false, privateReasoningStored: false, commandArgumentsStored: false, rawToolOutputStored: false, secretsStored: false, absolutePathsStored: false, fieldRunStarted: registeredFieldRows.length > 0, automaticPublish: false, projectMemoryStageChanged: false, retentionApplied: false, permissionsApplied: false },
    };
    scorecard.scorecardId = `compound_${digest({ experiment: scorecard.experiment, sourceIdentity: scorecard.sourceIdentity, evidenceClassCounts: scorecard.evidenceClassCounts, metrics: scorecard.metrics, cohorts: scorecard.cohorts, gates: scorecard.gates, decision: scorecard.decision }, 24)}`;
    assertMetadataOnly(scorecard);
    if (options.write !== false) { const stamp = generatedAt.replace(/[:.]/g, "-"); const file = path.join(this.root, `scorecard-${stamp}-${scorecard.scorecardId}.json`); writePrivateJson(file, scorecard); writePrivateJson(this.latestFile, scorecard); appendPrivate(this.indexFile, { schemaVersion: 1, scorecardId: scorecard.scorecardId, generatedAt, decision: scorecard.decision, gateStatuses: Object.fromEntries(Object.entries(gates).map(([key, value]) => [key, value.status])), evidenceClassCounts: classCounts, fingerprint: `sha256:${digest(scorecard, 64)}` }); return { ...scorecard, storage: { relativeLocation: path.relative(this.cwd, file).replace(/\\/g, "/"), private: true } }; }
    return scorecard;
  }
}

module.exports = { COMPOUNDING_SCORECARD_DIRECTORY, COMPOUNDING_SCORECARD_SCHEMA_VERSION, EVIDENCE_CLASSES, DEFAULT_LIMITS, CompoundingEffectivenessAdapter, assertMetadataOnly, metric, rate, percentile, stageSummary };
