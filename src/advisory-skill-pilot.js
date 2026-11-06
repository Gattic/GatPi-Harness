"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { FileIntegrationStorage, withStorageLock } = require("./file-integration-storage");
const { EvidenceStore } = require("./evidence-binder");
const { captureTreeFingerprint } = require("./tree-fingerprint");
const { showExperiment } = require("./experiment-ledger");
const { hash, percentile } = require("./reviewed-evidence");
const { freezeVerificationOracle, assessVerification } = require("./verification-oracle");

const COHORT_ID = "exp-machine-verification-advisory-v2";
const STATE_KEY = "machine-pilot";
const PROTOCOL = Object.freeze({ version: 2, workflow: "existing-change-verification", endpoint: "frozen-verification-delivery", skillName: "change-verify", minPerArm: 30, minSessionsPerArm: 30, minDays: 14, maxCases: 120, maxPerSession: 1, maxDays: 45, maxContextMessages: 10000, qualityDelta: 0.05, costRatio: 1.10, humanReviewRequired: false, permittedAction: "enable-exact-advisory-reminder" });
const SOURCE_FILES = ["src/advisory-skill-pilot.js", "src/verification-oracle.js", "src/test-runner.js", "src/verification-pipeline.js", "src/evidence-binder.js", "src/tree-fingerprint.js", "src/reviewed-evidence.js", "src/integration-boundary.js", "src/skill-synthesis.js", "src/skill-governance.js", ".pi/extensions/reasoning-runtime/index.ts", ".pi/extensions/verification-center/index.ts"];
const CONFIG_KEYS = ["PI_COGNITIVE_AUTO_INJECT", "PI_COGNITIVE_INJECT_MAX_CHARS", "PI_SKILL_INJECT_MAX", "PI_SKILL_INJECT_MIN_SCORE", "PI_CODE_CONTEXT_MODE", "PI_PROJECT_MEMORY_STAGE", "PI_JEV_TURN_INTENT"];
const MISSING_PROVENANCE_FILE = "missing-provenance-file";
// The pinned skill file lives outside the repository and can be archived or
// uninstalled at any time. Recording its absence as identity drift pauses the
// pilot instead of failing the turn; other read errors stay unexpected.
function provenanceFileHash(file) {
  if (!file) return null;
  try { return hash(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return MISSING_PROVENANCE_FILE; throw error; }
}
const daySpan = rows => rows.length < 2 ? 0 : (Math.max(...rows.map(r => Date.parse(r.startedAt))) - Math.min(...rows.map(r => Date.parse(r.startedAt)))) / 86400000;
function eligibleVerificationPrompt(prompt) {
  const text = String(prompt || "").trim();
  return /^(?:please\s+)?(?:verify|check|review)\b/i.test(text) && /\b(?:changes?|patch|diff)\b/i.test(text) && !/\b(?:implement|fix|repair|commit|push|publish|pilot)\b/i.test(text);
}
function interval(successes, count) {
  if (!count) return { lower: null, upper: null };
  const p = successes / count, z = 1.96, denominator = 1 + z * z / count;
  const center = (p + z * z / (2 * count)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / denominator;
  return { lower: center - radius, upper: center + radius };
}
function studyDecision(state, now, identityMatches) {
  const arms = {};
  for (const arm of ["control", "candidate"]) {
    const rows = state.cases.filter(c => c.arm === arm), resolved = rows.filter(c => c.assessment?.status === "resolved").length;
    arms[arm] = { assigned: rows.length, resolved, inconclusive: rows.filter(c => c.assessment?.status === "inconclusive").length, pending: rows.filter(c => c.status === "running").length, sessions: new Set(rows.map(c => c.sessionIdHash)).size, observedDays: new Set(rows.map(c => c.startedAt.slice(0, 10))).size, spanDays: daySpan(rows), delivered: rows.filter(c => c.delivered).length, resolutionRate: rows.length ? resolved / rows.length : null, interval95: interval(resolved, rows.length), costs: Object.fromEntries(["latencyMs", "modelCalls", "toolCalls", "contextAdded"].map(key => [key, rows.length && rows.every(c => Number.isFinite(c.metrics[key]) && c.metrics[key] >= 0) ? percentile(rows.map(c => c.metrics[key])) : null])) };
  }
  const horizonReached = state.cases.length >= PROTOCOL.maxCases || now - Date.parse(state.createdAt) >= PROTOCOL.maxDays * 86400000;
  const policyViolations = state.cases.filter(c => c.assessment?.status === "policy-violation").length;
  const sufficient = identityMatches && horizonReached && !state.cases.some(c => c.measurementIssue) && Object.values(arms).every(a => a.assigned >= PROTOCOL.minPerArm && a.pending === 0 && a.sessions >= PROTOCOL.minSessionsPerArm && a.observedDays >= PROTOCOL.minDays && a.spanDays >= PROTOCOL.minDays) && arms.candidate.delivered === arms.candidate.assigned;
  // A single terminal comparison, independent session samples, and separated
  // Wilson intervals avoid repeated-peeking and treating correlated turns as n.
  const improvementLowerBound = sufficient ? arms.candidate.interval95.lower - arms.control.interval95.upper : null;
  const costs = sufficient && Object.keys(arms.control.costs).every(k => arms.control.costs[k] !== null && arms.candidate.costs[k] !== null && arms.candidate.costs[k] <= arms.control.costs[k] * PROTOCOL.costRatio);
  const passed = sufficient && improvementLowerBound >= PROTOCOL.qualityDelta && costs && policyViolations === 0;
  return { arms, horizonReached, policyViolations, improvementLowerBound, costs, verdict: policyViolations ? "fail" : !sufficient ? "insufficient-data" : passed ? "pass" : "fail", action: passed ? PROTOCOL.permittedAction : "none" };
}

class AdvisorySkillPilot {
  constructor({ cwd = process.cwd(), skills, env = process.env, clock = Date.now, evidence = new EvidenceStore({ cwd }) } = {}) {
    this.cwd = cwd; this.skills = skills; this.env = env; this.clock = clock; this.evidence = evidence;
    this.storage = new FileIntegrationStorage(path.join(cwd, ".pi", "advisory-skill-pilot"), { maxJsonBytes: 2 * 1024 * 1024 });
    this.active = null;
  }
  state() {
    const value = this.storage.readJson(STATE_KEY);
    if (!value && fs.existsSync(this.storage.jsonPath(STATE_KEY))) throw new Error("machine pilot state is unreadable; preserve and inspect it");
    if (value && (value.schemaVersion !== 2 || value.protocolHash !== hash(PROTOCOL))) throw new Error("machine pilot protocol changed; a new cohort is required");
    return value;
  }
  transaction(fn) {
    return withStorageLock(this.storage.jsonPath(STATE_KEY), () => {
      const state = this.state(); const result = fn(state);
      if (state) this.storage.writeJson(STATE_KEY, state);
      return result;
    });
  }
  identity(skill) {
    const root = path.resolve(__dirname, "..");
    return { skillId: skill?.skillId, version: skill?.version, sourceHash: skill?.evidenceState?.sourceTrust?.sourceHash, actualSkillHash: provenanceFileHash(skill?.provenance?.file), runtimeSourceHash: hash(SOURCE_FILES.map(file => [file, hash(fs.readFileSync(path.join(root, file)))])), configurationHash: hash(CONFIG_KEYS.map(key => [key, this.env[key] ?? null])) };
  }
  identityMatches(state) { return hash(this.identity(this.skills.getSkill(state.identity.skillId))) === hash(state.identity); }
  // prepare() and report() share this so both name the same pause.
  blockedReason(state, skill = this.skills.getSkill(state.identity.skillId)) {
    const identity = this.identity(skill);
    if (identity.actualSkillHash === MISSING_PROVENANCE_FILE) return "provenance-file-missing";
    if (hash(identity) !== hash(state.identity) || skill?.approvals?.advisoryRetrieval !== "allowed") return "source-or-configuration-changed";
    return null;
  }
  decision(state) {
    const decision = studyDecision(state, this.clock(), this.identityMatches(state));
    if (decision.action === "none") return { ...decision, evidenceIntact: null };
    let bytes = 0;
    const used = new Set();
    for (const row of state.cases.filter(c => c.assessment?.status === "resolved")) {
      const a = row.assessment;
      const checked = this.evidence.validateEvidenceId(a.evidenceId, { requireOk: false, requireCurrentTree: false, minCreatedAt: row.startedAt, expectedFingerprint: a.evidenceFingerprint });
      const packet = checked.evidence;
      const file = /^proof_[a-f0-9]{16}$/.test(a.proofId || "") ? path.join(this.cwd, ".pi/verification-center/evidence", `${a.proofId}.json`) : null;
      const valid = checked.ok && packet.source === "machine-verification" && packet.metadata.caseId === row.caseId && packet.metadata.oracleHash === row.oracle?.hash && packet.metadata.proofHash === a.proofHash && packet.metadata.verificationResult === a.verificationResult && Date.parse(packet.createdAt) <= Date.parse(row.settledAt) && !used.has(a.proofId) && file && fs.existsSync(file);
      if (!valid || (bytes += fs.statSync(file).size) > 16 * 1024 * 1024 || hash(JSON.parse(fs.readFileSync(file, "utf8"))) !== a.proofHash) return { ...decision, verdict: "insufficient-data", action: "none", evidenceIntact: false };
      used.add(a.proofId);
    }
    return { ...decision, evidenceIntact: true };
  }
  initialize() {
    return withStorageLock(this.storage.jsonPath(STATE_KEY), () => {
      const prior = this.state(); if (prior) return prior;
      if (showExperiment(this.cwd, COHORT_ID)?.status !== "open") throw new Error("the machine verification experiment must be preregistered");
      const matches = this.skills.listSkills({ limit: Infinity }).filter(s => s.provenance?.nativeSkillName === PROTOCOL.skillName);
      if (matches.length !== 1 || matches[0].approvals?.advisoryRetrieval !== "allowed") throw new Error("one advisory-approved change-verify skill is required");
      const identity = this.identity(matches[0]);
      if (identity.actualSkillHash === MISSING_PROVENANCE_FILE) throw new Error("installed skill provenance file is missing; enrollment blocked");
      if (identity.actualSkillHash !== identity.sourceHash) throw new Error("stored skill and installed source differ; enrollment blocked");
      const state = { schemaVersion: 2, cohortId: COHORT_ID, protocol: PROTOCOL, protocolHash: hash(PROTOCOL), identity, createdAt: new Date(this.clock()).toISOString(), status: "collecting", salt: crypto.randomBytes(24).toString("hex"), modelHash: null, cases: [], decision: null };
      // v1 pilot.json is historical evidence. Never rewrite or import its labels.
      this.storage.writeJson(STATE_KEY, state); return state;
    });
  }
  prepare({ prompt, sessionId, requestId, interactive, model, thinkingLevel }) {
    if (!interactive || !sessionId || !requestId || !eligibleVerificationPrompt(prompt)) return null;
    const state = this.state(); if (!state || state.status === "stopped") return null;
    const skill = this.skills.getSkill(state.identity.skillId);
    const blocked = this.blockedReason(state, skill);
    if (blocked) return { blocked };
    if (["PI_HERMES_SKILL_AUTO_DRAFT", "PI_COGNITIVE_AUTO_BRANCH", "PI_COGNITIVE_AUTO_VERIFY", "PI_COGNITIVE_AUTO_CONSOLIDATE"].some(key => this.env[key] === "1")) return { blocked: "confounding-automatic-behavior-enabled" };
    const sessionIdHash = hash(sessionId), taskHash = hash(prompt), modelHash = hash({ model, thinkingLevel });
    if (state.modelHash && state.modelHash !== modelHash) return { blocked: "model-cohort-changed" };
    const advisory = `[Advisory skill pilot: ${skill.name}]\n${skill.workflowSteps.map(s => s.description).join("\n")}\nAdvisory only; keep required verification and permissions unchanged.`;
    const terminal = this.decision(state);
    if (state.decision?.action === PROTOCOL.permittedAction && terminal.action === PROTOCOL.permittedAction) return { automatic: true, advisory };
    if (terminal.horizonReached) { this.transaction(current => { if (!current.decision) { current.decision = terminal; current.status = "collection-complete"; } }); return null; }
    if (state.cases.some(c => c.sessionIdHash === sessionIdHash)) return null;
    const oracle = freezeVerificationOracle(this.cwd);
    const caseId = `skillcase_${hash([sessionIdHash, requestId]).slice(7, 31)}`;
    const result = this.transaction(current => {
      if (current.status !== "collecting" || current.cases.length >= PROTOCOL.maxCases || current.cases.some(c => c.sessionIdHash === sessionIdHash)) return null;
      // Another session may have pinned the model since the preflight read.
      if (current.modelHash && current.modelHash !== modelHash) return { blocked: "model-cohort-changed" };
      if (!current.modelHash) current.modelHash = modelHash;
      const arm = parseInt(hash([current.salt, sessionIdHash]).slice(-8), 16) % 2 ? "candidate" : "control";
      const row = { caseId, sessionIdHash, taskHash, arm, modelHash, oracle: oracle.contract, startedAt: new Date(this.clock()).toISOString(), status: "running", delivered: false, metrics: { modelCalls: 0, toolCalls: 0, contextAdded: 0 }, assessment: null };
      current.cases.push(row); return structuredClone(row);
    });
    if (!result || result.blocked) return result;
    this.active = { ...result, frozenOracle: oracle, seenMessages: new Set(), contextStarted: false };
    this.active.metrics.contextAdded = String(prompt).length;
    const evidenceInstructions = oracle.available ? `Machine evidence protocol, identical in both arms: run the frozen repository checks through Verification Center. Results are captured and assessed automatically; no human review or model self-rating is required. Report pass/fail/inconclusive exactly, without repairing this verification-only task. Frozen checks: ${JSON.stringify(oracle.commands.map(({ id, command, args, kind }) => ({ id, command, args, kind })))}` : "Machine evidence protocol: no executable repository oracle was found; this case will remain inconclusive. Do not invent approvals or outcome labels.";
    return { ...result, skillId: skill.skillId, advisory: result.arm === "candidate" ? advisory : "", evidenceInstructions };
  }
  observeModel() { if (this.active) this.active.metrics.modelCalls++; }
  observeTool() { if (this.active) this.active.metrics.toolCalls++; }
  observeMessages(messages = []) {
    if (!this.active || this.active.measurementIssue) return;
    for (const message of messages) {
      if (this.active.seenMessages.size >= PROTOCOL.maxContextMessages) { this.active.measurementIssue = "context-measurement-limit"; return; }
      const content = typeof message.content === "string" ? message.content : (message.content || []).filter(b => !/thinking|reasoning/i.test(b.type || "")).map(b => b.text || (b.type === "toolCall" ? JSON.stringify(b.arguments || {}) : "")).join("\n");
      const key = hash([message.role, message.toolCallId, message.timestamp, content]);
      if ((this.active.contextStarted || Number(message.timestamp) >= Date.parse(this.active.startedAt)) && !this.active.seenMessages.has(key)) this.active.metrics.contextAdded += content.length;
      this.active.seenMessages.add(key);
    }
    this.active.contextStarted = true;
  }
  observeVerification(result) {
    if (!this.active || this.active.assessment?.status === "resolved" || this.active.assessment?.status === "policy-violation") return null;
    const assessment = assessVerification(this.cwd, result, this.active.frozenOracle, this.active.startedAt, this.clock());
    if (assessment.status === "resolved") {
      const proof = this.evidence.saveEvidence({ id: `machine_evidence_${hash([this.active.caseId, assessment.proofHash]).slice(7, 31)}`, source: "machine-verification", createdAt: new Date(this.clock()).toISOString(), ok: assessment.verificationResult === "pass", summary: "Execution of frozen repository checks; not a human judgment or a general quality claim", commands: [], files: [], artifacts: [`verification:${assessment.proofId}`], tree: result.evidence.tree, metadata: { caseId: this.active.caseId, oracleHash: this.active.oracle.hash, ...assessment } });
      assessment.evidenceId = proof.id;
      assessment.evidenceFingerprint = proof.fingerprint;
    }
    this.active.assessment = assessment;
    return assessment;
  }
  delivered() { if (this.active) this.active.delivered = this.active.arm === "candidate"; }
  settle(status = "settled") {
    if (!this.active) return null;
    const { seenMessages, contextStarted, frozenOracle, ...active } = this.active; this.active = null;
    return this.transaction(state => {
      const row = state?.cases.find(c => c.caseId === active.caseId); if (!row || row.status !== "running") return null;
      Object.assign(row, active, { status, settledAt: new Date(this.clock()).toISOString(), metrics: { ...active.metrics, latencyMs: Math.max(0, this.clock() - Date.parse(active.startedAt)) } });
      if (status !== "settled") row.assessment = { status: "inconclusive", reason: "interrupted" };
      if (!row.assessment) row.assessment = { status: "inconclusive", reason: "no-verification-evidence" };
      if (!this.identityMatches(state)) row.assessment = { status: "inconclusive", reason: "identity-changed" };
      const tree = captureTreeFingerprint(this.cwd);
      if (!tree.gatingSafe || !row.oracle.treeFingerprint) row.assessment = { status: "inconclusive", reason: "unproven-tree" };
      else if (tree.fingerprint !== row.oracle.treeFingerprint) row.assessment = { status: "policy-violation", reason: "verification-task-mutated-tree" };
      if (row.assessment.status === "policy-violation") state.status = "stopped";
      const decision = this.decision(state);
      if (decision.horizonReached && !state.decision) { state.decision = decision; if (state.status !== "stopped") state.status = "collection-complete"; }
      return structuredClone(row);
    });
  }
  stop() { return this.transaction(state => { if (state) state.status = "stopped"; return { status: state?.status || "not-initialized" }; }); }
  report() {
    const state = this.state();
    if (!state) return { status: "not-initialized", humanReviewRequired: false, automaticReminderEnabled: false };
    const identityMatches = this.identityMatches(state), decision = this.decision(state);
    return { status: state.status, cohortId: state.cohortId, identity: state.identity, identityMatches, blocked: this.blockedReason(state), protocol: PROTOCOL, ...decision, automaticAssessment: true, humanReviewRequired: false, automaticReminderEnabled: Boolean(identityMatches && state.status !== "stopped" && state.decision?.action === PROTOCOL.permittedAction && decision.action === PROTOCOL.permittedAction), automaticSynthesis: false, automaticPromotion: false, contextUnit: "model-visible-added-characters", claimBoundary: "Frozen-check execution completeness only; no subjective usefulness, arbitrary-claim truth, or general code-correctness inference", cases: state.cases.map(({ caseId, arm, status, startedAt, settledAt, assessment }) => ({ caseId, arm, status, startedAt, settledAt, assessment })) };
  }
}
module.exports = { AdvisorySkillPilot, PROTOCOL, COHORT_ID, STATE_KEY, eligibleVerificationPrompt, studyDecision };
