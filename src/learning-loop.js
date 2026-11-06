"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { CANONICAL_OUTCOMES, normalizeOutcome, isFailureOutcome } = require("./outcome-schema");
const { ExecutionOutcomeStore, validateExecutionOutcomePacket } = require("./execution-outcome");
const { assertMemoryContentSafe } = require("./memory-content-scanner");

let EvidenceStore, createEvidencePacket, bindClaims, evaluatePolicy, testImpact;
try { ({ EvidenceStore, createEvidencePacket, bindClaims } = require("./evidence-binder")); } catch {}
try { ({ evaluatePolicy } = require("./runtime-policy")); } catch {}
try { ({ testImpact } = require("./project-intelligence")); } catch {}

const EVIDENCE_SCORES = {
  none: 0,
  claim: 0.2,
  "tool-output": 0.6,
  verification: 0.85,
  "full-check": 1,
};
const STATUSES = new Set(CANONICAL_OUTCOMES);
const EVIDENCE_LEVELS = new Set(Object.keys(EVIDENCE_SCORES));
const PROPOSAL_KINDS = new Set(["skill", "test", "prompt", "config"]);
const PROPOSAL_STATUSES = new Set(["draft", "ready_for_review", "approved", "applied", "dismissed", "superseded"]);
const FINAL_PROPOSAL_STATUSES = new Set(["applied", "dismissed", "superseded"]);
const COMPOUNDING_EVIDENCE_CLASSES = new Set(["deterministic", "synthetic", "migration", "exact-version-field", "user-reviewed-gold"]);

function nowIso() { return new Date().toISOString(); }
function stableStringify(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex"); }
function shortHash(value, n = 16) { return hash(value).slice(0, n); }
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function appendJsonl(file, value) { ensureDir(file); fs.appendFileSync(file, `${JSON.stringify(value)}\n`); }
function readJsonl(file) {
  try { return fs.readFileSync(file, "utf8").split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}
function clamp01(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function arr(value) { return Array.isArray(value) ? value.filter((v) => v !== undefined && v !== null) : value === undefined || value === null ? [] : [value]; }
function uniq(values) { return Array.from(new Set(arr(values).map((v) => String(v)).filter(Boolean))); }
function limitText(text, max = 1600) {
  const value = String(text || "");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…<${value.length - max} chars omitted>`;
}

function hasSecretLikeText(text) {
  const value = String(text || "").replace(/\b(api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer)\s*[:=]\s*(?:['\"]?\[REDACTED[^\]]*\]['\"]?)/gi, "").replace(/^\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Z0-9_]*\s*=\s*)\[REDACTED[^\]]*\]\s*$/gim, "");
  return /\b(?:(?:sk|pk|ghp|github_pat|glpat|xox[baprs]|ya29|hf)[-_][-_a-zA-Z0-9]{12,}|AIza[-_a-zA-Z0-9]{20,})\b/i.test(value) ||
    /\b(api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer)\s*[:=]\s*[^\s'"`]+/i.test(value) ||
    /^\s*[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Z0-9_]*\s*=\s*.+$/im.test(value);
}

function looksLikeFullTranscript(text) {
  const value = String(text || "");
  const roleLines = value.match(/(?:^|\\n|\n)\s*(user|assistant|system|tool|developer)\s*:/gim) || [];
  const roleLabels = value.match(/(?:^|\\n|\n|[^A-Za-z])(user|assistant|system|tool|developer)\s*:/gi) || [];
  const messageMarkers = value.match(/\b(user|assistant|system|tool) messages?\b/gi) || [];
  return roleLines.length >= 4 || roleLabels.length >= 4 || messageMarkers.length >= 2 || value.length > 12000;
}

function redactSensitiveText(text, max = 1600) {
  return limitText(String(text || "")
    .replace(/\b(?:(?:sk|pk|ghp|github_pat|glpat|xox[baprs]|ya29|hf)[-_][-_a-zA-Z0-9]{12,}|AIza[-_a-zA-Z0-9]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
    .replace(/\b(api[_-]?key|token|secret|password|passwd|pwd|authorization|bearer)(\s*[:=]\s*)([^\s'"`]+).*/gi, "$1$2[REDACTED]")
    .replace(/^\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Z0-9_]*)(\s*=\s*).*/gim, "$1$2[REDACTED]"), max);
}

function sanitizeArray(values, maxItems = 50, maxText = 300) {
  return uniq(values).slice(0, maxItems).map((v) => redactSensitiveText(v, maxText));
}
function sanitizeStructured(value, maxText = 1600, depth = 5) {
  if (value == null) return value;
  if (typeof value === "string") return redactSensitiveText(value, maxText);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth <= 0) return redactSensitiveText(stableStringify(value), maxText);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeStructured(item, maxText, depth - 1));
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort().slice(0, 100)) out[key] = sanitizeStructured(value[key], maxText, depth - 1);
    return out;
  }
  return redactSensitiveText(String(value), maxText);
}

function normalizeStatus(input = {}) {
  const raw = normalizeOutcome(input.status || input.signals?.status);
  if (STATUSES.has(raw) && raw !== "unknown") return raw;
  if (input.signals?.verificationOk === false || input.verificationOk === false) return "domain-negative";
  if ((input.signals?.policyBlocks || input.policyBlocks || 0) > 0) return "blocked";
  if (input.signals?.verificationOk === true || input.verificationOk === true) return "succeeded";
  return "unknown";
}

function normalizeEvidenceLevel(value) {
  if (EVIDENCE_LEVELS.has(value)) return value;
  if (value === "full" || value === "full_check") return "full-check";
  if (value === "tool" || value === "tool_output") return "tool-output";
  return "none";
}

function normalizeSignals(input = {}) {
  const source = input.signals || input;
  const status = normalizeStatus(input);
  return {
    status,
    evidenceLevel: normalizeEvidenceLevel(source.evidenceLevel),
    verificationOk: source.verificationOk === undefined ? null : Boolean(source.verificationOk),
    commands: sanitizeArray(source.commands || input.commands || [], 20, 250),
    toolErrors: Math.max(0, Number(source.toolErrors || 0)),
    policyBlocks: Math.max(0, Number(source.policyBlocks || 0)),
    privacyFindings: Math.max(0, Number(source.privacyFindings || 0)),
    latencyMs: Math.max(0, Number(source.latencyMs || 0)),
    stateGrowthBytes: Math.max(0, Number(source.stateGrowthBytes || 0)),
    userCorrectionDetected: typeof source.userCorrectionDetected === "boolean" ? source.userCorrectionDetected : null,
  };
}

function normalizeArtifacts(input = {}) {
  const artifacts = input.artifacts || {};
  return {
    traceRefs: sanitizeArray(artifacts.traceRefs || input.traceRefs || [], 50, 200),
    evidenceRefs: sanitizeArray(artifacts.evidenceRefs || input.evidenceRefs || [], 50, 200),
    reasoningArtifactIds: sanitizeArray(artifacts.reasoningArtifactIds || input.reasoningArtifactIds || [], 50, 200),
    topologyRunIds: sanitizeArray(artifacts.topologyRunIds || input.topologyRunIds || [], 50, 200),
    skillIds: sanitizeArray(artifacts.skillIds || input.skillIds || [], 50, 200),
    changedFiles: sanitizeArray(artifacts.changedFiles || input.changedFiles || [], 80, 300),
  };
}

function classifyOutcome(outcome) {
  const classes = new Set(outcome.classifications || []);
  const signals = outcome.signals || {};
  const artifacts = outcome.artifacts || {};
  const notApplicable = signals.status === "not-applicable";
  if (signals.status === "succeeded" && ["verification", "full-check"].includes(signals.evidenceLevel) && signals.verificationOk !== false) classes.add("verified-success");
  if (signals.status === "succeeded" && ["none", "claim"].includes(signals.evidenceLevel)) classes.add("unsupported-success");
  if (!notApplicable && (signals.verificationOk === false || signals.status === "domain-negative")) classes.add("verification-failure");
  if (!notApplicable && (signals.toolErrors > 0 || isFailureOutcome(signals.status))) classes.add("tool-failure");
  if (notApplicable) { classes.delete("verification-failure"); classes.delete("tool-failure"); }
  if (signals.status === "timed-out") classes.add("execution-timeout");
  if (signals.status === "cancelled") classes.add("execution-cancelled");
  if (signals.policyBlocks > 0 || signals.status === "blocked") classes.add("policy-block");
  if (signals.privacyFindings > 0) classes.add("privacy-risk");
  if (signals.latencyMs >= 3000) classes.add("latency-risk");
  if (signals.stateGrowthBytes >= 10 * 1024 * 1024) classes.add("state-growth-risk");
  if (signals.userCorrectionDetected) classes.add("user-correction");
  if (signals.status === "succeeded" && artifacts.changedFiles?.length && !signals.commands.some((c) => /test|check|verify|lint|typecheck|build/i.test(c)) && signals.evidenceLevel !== "full-check") classes.add("missing-test");
  return Array.from(classes).sort();
}

function rateOutcome(outcome) {
  const signals = outcome?.signals || {};
  let qualityScore = EVIDENCE_SCORES[signals.evidenceLevel] ?? 0;
  if (signals.status === "succeeded") qualityScore += 0.05;
  if (signals.status === "domain-negative") qualityScore -= 0.2;
  if (signals.status === "infrastructure-failed") qualityScore -= 0.3;
  if (["timed-out", "cancelled"].includes(signals.status)) qualityScore -= 0.15;
  if (signals.status === "blocked") qualityScore -= 0.1;
  if (signals.verificationOk === true) qualityScore += 0.08;
  if (signals.verificationOk === false) qualityScore -= 0.25;
  qualityScore -= Math.min(0.25, Number(signals.toolErrors || 0) * 0.05);
  qualityScore -= Math.min(0.25, Number(signals.policyBlocks || 0) * 0.08);
  qualityScore -= Math.min(0.25, Number(signals.privacyFindings || 0) * 0.12);
  if (signals.userCorrectionDetected) qualityScore -= 0.12;
  const classifications = new Set(outcome.classifications || classifyOutcome(outcome));
  let learningValue = 0.25;
  if (classifications.has("verified-success")) learningValue += 0.2;
  if (classifications.has("verification-failure")) learningValue += 0.3;
  if (classifications.has("missing-test")) learningValue += 0.25;
  if (classifications.has("unsupported-success")) learningValue += 0.25;
  if (classifications.has("latency-risk") || classifications.has("state-growth-risk")) learningValue += 0.2;
  if (classifications.has("user-correction")) learningValue += 0.25;
  return {
    qualityScore: clamp01(qualityScore),
    learningValue: clamp01(learningValue),
    evidenceScore: EVIDENCE_SCORES[signals.evidenceLevel] ?? 0,
    reasons: Array.from(classifications),
  };
}

function createOutcome(input = {}, options = {}) {
  const rawText = stableStringify(input);
  const signals = normalizeSignals(input);
  const artifacts = normalizeArtifacts(input);
  const task = {
    summary: redactSensitiveText(input.task?.summary || input.taskSummary || input.summary || "", 500),
    repo: redactSensitiveText(input.task?.repo || input.repo || input.cwd || "", 500),
    sessionId: input.task?.sessionId || input.sessionId || undefined,
    traceCorrelationId: input.task?.traceCorrelationId || input.traceCorrelationId || undefined,
  };
  const retrievalInput = input.retrieval || input.context?.retrieval || {};
  const retrieval = retrievalInput.strategyId ? {
    strategyId: redactSensitiveText(retrievalInput.strategyId, 160),
    queryId: redactSensitiveText(retrievalInput.queryId, 160),
    runId: redactSensitiveText(retrievalInput.runId, 160),
    pairId: redactSensitiveText(retrievalInput.pairId, 160),
    rolloutMode: redactSensitiveText(retrievalInput.rolloutMode || "advisory", 40),
    metrics: sanitizeStructured(retrievalInput.metrics || {}, 1200),
    humanCorrection: Boolean(retrievalInput.humanCorrection || signals.userCorrectionDetected),
    fallbackToBroadRead: Boolean(retrievalInput.fallbackToBroadRead),
  } : null;
  const base = {
    outcomeId: input.outcomeId || input.id || undefined,
    createdAt: input.createdAt || options.now || nowIso(),
    source: redactSensitiveText(input.source || "manual", 100),
    evidenceClass: COMPOUNDING_EVIDENCE_CLASSES.has(input.evidenceClass) ? input.evidenceClass : "deterministic",
    cohort: { id: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(input.cohortId || "")) ? String(input.cohortId) : null, arm: ["control", "candidate"].includes(input.arm) ? input.arm : null, sessionIdHash: /^sha256:[a-f0-9]{64}$/.test(String(input.sessionIdHash || "")) ? String(input.sessionIdHash) : null },
    task,
    signals,
    artifacts,
    retrieval,
    classifications: sanitizeArray(input.classifications || [], 30, 100),
    summary: redactSensitiveText(input.summary || input.result || input.text || "", 1600),
    privacy: {
      redacted: true,
      containsTranscript: looksLikeFullTranscript(rawText),
      containsSecret: hasSecretLikeText(rawText),
    },
  };
  base.classifications = classifyOutcome(base);
  base.rating = rateOutcome(base);
  base.outcomeId ||= `outcome_${shortHash({ source: base.source, task: base.task, signals: base.signals, artifacts: base.artifacts, retrieval: base.retrieval, summary: base.summary }, 16)}`;
  base.fingerprint = shortHash({ source: base.source, task: base.task, signals: base.signals, artifacts: base.artifacts, retrieval: base.retrieval, summary: base.summary, classifications: base.classifications }, 16);
  return base;
}

function outcomeRater(input = {}, options = {}) {
  const outcome = createOutcome(input, options);
  return { outcome, classifications: outcome.classifications, rating: outcome.rating, learningValue: outcome.rating.learningValue };
}

function executionOutcomeToLearningInput(input = {}) {
  const validation = validateExecutionOutcomePacket(input);
  if (!validation.ok) throw new Error(`invalid execution learning outcome: ${validation.issues.join("; ")}`);
  const packet = validation.packet;
  const verificationLinked = packet.evidenceRefs.length > 0 || packet.artifactRefs.some((artifact) => artifact.kind === "verification");
  return {
    outcomeId: `outcome_exec_${packet.packetId.slice("execout_".length)}`,
    createdAt: packet.settledAt,
    source: "execution",
    task: { summary: `${packet.source.kind}:${packet.task.hash}`, repo: packet.provenance.projectKeyHash, sessionId: packet.source.runId },
    summary: `Settled ${packet.source.kind} execution ${packet.packetId}: ${packet.outcome}; reasons=${packet.reasonCodes.join(",") || "none"}; steps=${packet.workflow.steps.length}`,
    signals: {
      status: packet.outcome,
      evidenceLevel: verificationLinked ? "verification" : "tool-output",
      verificationOk: verificationLinked && packet.outcome === "succeeded" ? true : verificationLinked && ["domain-negative", "blocked", "timed-out", "infrastructure-failed"].includes(packet.outcome) ? false : null,
      toolErrors: packet.metrics.toolErrors,
      latencyMs: packet.metrics.durationMs,
    },
    artifacts: { evidenceRefs: packet.evidenceRefs, traceRefs: [packet.packetId, packet.source.runId] },
    classifications: ["settled-execution", `execution-${packet.source.kind}`],
    evidenceClass: packet.provenance.evidenceClass,
    cohortId: packet.provenance.cohortId,
    arm: packet.provenance.arm === "unassigned" ? null : packet.provenance.arm,
    sessionIdHash: packet.provenance.sessionIdHash,
  };
}

function defaultReviewChecklist() {
  return [
    "Evidence supports the problem statement",
    "No secrets or full transcripts are included",
    "Change is reversible",
    "Verification plan is sufficient",
  ];
}

function riskForKind(kind, input = {}) {
  if (input.risk?.level) return input.risk.level;
  if (kind === "prompt") return "high";
  if (kind === "config") return "medium";
  if (kind === "skill") return "medium";
  if (kind === "test") return "low";
  return "medium";
}

function createProposal(input = {}, options = {}) {
  const kind = PROPOSAL_KINDS.has(input.kind) ? input.kind : "config";
  const status = PROPOSAL_STATUSES.has(input.status) ? input.status : "draft";
  const proposal = {
    proposalId: input.proposalId || input.id || undefined,
    createdAt: input.createdAt || options.now || nowIso(),
    updatedAt: input.updatedAt || input.createdAt || options.now || nowIso(),
    kind,
    status,
    title: redactSensitiveText(input.title || `${kind} improvement proposal`, 200),
    problemStatement: redactSensitiveText(input.problemStatement || input.problem || "", 1000),
    evidenceRefs: sanitizeArray(input.evidenceRefs || [], 100, 200),
    affectedFiles: sanitizeArray(input.affectedFiles || [], 100, 300),
    suggestedChange: {
      summary: redactSensitiveText(input.suggestedChange?.summary || input.summary || "", 1200),
      patchPlan: arr(input.suggestedChange?.patchPlan || input.patchPlan).map((x) => redactSensitiveText(typeof x === "string" ? x : stableStringify(x), 600)).slice(0, 20),
      skillDraft: sanitizeStructured(input.suggestedChange?.skillDraft || input.skillDraft || null),
      testDraft: sanitizeStructured(input.suggestedChange?.testDraft || input.testDraft || null),
      promptDraft: input.suggestedChange?.promptDraft ? redactSensitiveText(input.suggestedChange.promptDraft, 1600) : input.promptDraft ? redactSensitiveText(input.promptDraft, 1600) : null,
      configDraft: sanitizeStructured(input.suggestedChange?.configDraft || input.configDraft || null),
    },
    expectedBenefit: {
      quality: input.expectedBenefit?.quality || "medium",
      latency: input.expectedBenefit?.latency || "none",
      safety: input.expectedBenefit?.safety || "none",
    },
    risk: {
      level: riskForKind(kind, input),
      reasons: sanitizeArray(input.risk?.reasons || [], 20, 300),
      requiresUserApproval: input.risk?.requiresUserApproval !== false,
    },
    reviewChecklist: input.reviewChecklist || defaultReviewChecklist(),
    applicationPlan: {
      mode: input.applicationPlan?.mode || "manual",
      rollback: input.applicationPlan?.rollback || "no mutation; use delegated tool checkpoint when applied",
    },
    verificationPlan: {
      commands: sanitizeArray(input.verificationPlan?.commands || [], 30, 300),
      evidenceRequired: sanitizeArray(input.verificationPlan?.evidenceRequired || ["targeted check", "claim-check"], 20, 200),
    },
    review: input.review || { reviewedBy: null, approvedAt: null, notes: [], checks: null },
  };
  proposal.proposalId ||= `proposal_${shortHash({ kind: proposal.kind, title: proposal.title, problemStatement: proposal.problemStatement, evidenceRefs: proposal.evidenceRefs, suggestedChange: proposal.suggestedChange }, 16)}`;
  proposal.fingerprint = shortHash({ kind: proposal.kind, title: proposal.title, problemStatement: proposal.problemStatement, evidenceRefs: proposal.evidenceRefs, suggestedChange: proposal.suggestedChange, verificationPlan: proposal.verificationPlan }, 16);
  return proposal;
}

function localEvidenceCheck(proposal, { cwd = process.cwd(), evidenceLimit = 50 } = {}) {
  const refs = proposal.evidenceRefs || [];
  const base = { ok: Boolean(refs.length), reason: refs.length ? "evidence refs present" : "no evidence refs", refs };
  if (!EvidenceStore || !bindClaims) return { ...base, integration: "local-ref-check" };
  try {
    const store = new EvidenceStore({ cwd });
    const packets = store.listEvidence({ limit: evidenceLimit });
    if (!packets.length) return { ...base, integration: "evidence-binder", binderPackets: 0 };
    const claimText = [proposal.title, proposal.problemStatement, proposal.suggestedChange?.summary].filter(Boolean).join(". ");
    const claimCheck = bindClaims(claimText, packets, { threshold: 0.45 });
    return { ...base, ok: base.ok && (claimCheck.ok || refs.length > 0), integration: "evidence-binder", binderPackets: packets.length, claimCheck };
  } catch (error) {
    return { ...base, integration: "evidence-binder", warning: error?.message || String(error) };
  }
}
function localPrivacyCheck(proposal, { cwd = process.cwd() } = {}) {
  const raw = stableStringify(proposal || {});
  const contentOk = !hasSecretLikeText(raw) && !looksLikeFullTranscript(raw);
  const latestScan = readJson(path.join(cwd, ".pi", "privacy-guard", "latest-scan.json"), null);
  const scanOk = latestScan ? latestScan.ok !== false : true;
  const ok = contentOk && scanOk;
  return {
    ok,
    integration: latestScan ? "privacy-guard/latest-scan+local-detectors" : "privacy-guard-compatible-local-detectors",
    reason: ok ? "proposal contains no obvious secrets/full transcripts" : !contentOk ? "proposal may contain secret-like or transcript-like text" : "latest Privacy Guard scan has actionable findings",
    latestScan: latestScan ? { ok: latestScan.ok, summary: latestScan.summary } : undefined,
  };
}
function localPolicyCheck(proposal, { cwd = process.cwd(), policy = {} } = {}) {
  const checks = [];
  if (evaluatePolicy) {
    for (const command of proposal.verificationPlan?.commands || []) checks.push(evaluatePolicy({ command, kind: "learning-verification-command" }, { cwd, policy }));
    for (const file of proposal.affectedFiles || []) checks.push(evaluatePolicy({ path: file, kind: proposal.applicationPlan?.mode || "learning-proposal" }, { cwd, policy }));
    const mode = proposal.applicationPlan?.mode || "manual";
    const tools = mode === "skill_synthesis" ? ["skill_synthesis"] : mode === "ast_refactor" ? ["edit", "ast_refactor"] : mode === "config_write" ? ["policy_gate", "edit"] : ["learning_loop"];
    for (const tool of tools) checks.push(evaluatePolicy({ tool, kind: "learning-application-mode" }, { cwd, policy }));
  }
  const denied = checks.filter((check) => check.ok === false);
  const warnings = checks.filter((check) => check.severity === "warn");
  return { ok: denied.length === 0, integration: evaluatePolicy ? "policy-gate/runtime-policy" : "local-allow", reason: denied.length ? denied.flatMap((d) => d.reasons || []).join("; ") : warnings.length ? warnings.flatMap((w) => w.reasons || []).join("; ") : "no policy violations detected", checks };
}
function localImpactCheck(proposal, { cwd = process.cwd() } = {}) {
  const hasVerificationPlan = Boolean(proposal.verificationPlan?.commands?.length || proposal.verificationPlan?.evidenceRequired?.length);
  if (!testImpact || !(proposal.affectedFiles || []).length) return { ok: hasVerificationPlan, integration: "verification-plan", reason: hasVerificationPlan ? "verification plan present" : "missing verification plan" };
  try {
    const impact = testImpact(cwd, proposal.affectedFiles, { maxFiles: 1000 });
    const highRiskGaps = (impact.gaps || []).filter((gap) => gap.gap && gap.risk?.score >= 4);
    return { ok: hasVerificationPlan && highRiskGaps.length === 0, integration: "test-gap-planner/project-intelligence", reason: highRiskGaps.length ? `high-risk test gaps: ${highRiskGaps.map((g) => g.file).join(", ")}` : "impact mapped without high-risk gaps", impact };
  } catch (error) {
    return { ok: hasVerificationPlan, integration: "test-gap-planner/project-intelligence", warning: error?.message || String(error), reason: hasVerificationPlan ? "verification plan present; impact check warning" : "missing verification plan" };
  }
}
function reviewProposalWithLocalChecks(proposal, options = {}) {
  return reviewProposal(proposal, {
    evidence: localEvidenceCheck(proposal, options),
    privacy: localPrivacyCheck(proposal, options),
    policy: localPolicyCheck(proposal, options),
    impact: localImpactCheck(proposal, options),
    notes: options.notes || [],
  }, options);
}

function reviewProposal(proposal, checks = {}, options = {}) {
  const now = options.now || nowIso();
  const normalizedChecks = {
    evidence: sanitizeStructured(checks.evidence || { ok: Boolean(proposal.evidenceRefs?.length), reason: proposal.evidenceRefs?.length ? "evidence refs present" : "no evidence refs" }, 800),
    privacy: sanitizeStructured(checks.privacy || { ok: true, reason: "not checked by external guard" }, 800),
    policy: sanitizeStructured(checks.policy || { ok: true, reason: "not checked by external gate" }, 800),
    impact: sanitizeStructured(checks.impact || { ok: true, reason: "not checked by test-gap planner" }, 800),
  };
  const failed = Object.entries(normalizedChecks).filter(([, value]) => value && value.ok === false).map(([name, value]) => ({ name, reason: value.reason || "failed" }));
  return {
    ...proposal,
    status: failed.length ? "draft" : "ready_for_review",
    updatedAt: now,
    review: {
      ...(proposal.review || {}),
      checks: normalizedChecks,
      reviewedAt: now,
      ready: failed.length === 0,
      failed,
      notes: [...arr(proposal.review?.notes), ...arr(checks.notes).map((n) => redactSensitiveText(n, 500))],
    },
  };
}

function delegatedApplyPlan(proposal) {
  const mode = proposal.applicationPlan?.mode || "manual";
  const delegatedTool = mode === "skill_synthesis" ? "skill_synthesis" : mode === "ast_refactor" ? "edit/ast_refactor" : mode === "config_write" ? "policy_gate + edit" : "manual";
  const steps = mode === "skill_synthesis" ? [
    "Create/review a skill_synthesis candidate from suggestedChange.skillDraft.",
    "Run skill doctor or A/B scoring.",
    "Run /learning-verify and record applied only with evidence refs.",
  ] : mode === "ast_refactor" ? [
    "Use edit for localized changes or ast_refactor preview for broad mechanical changes.",
    "Apply only the reviewed preview; ast_refactor creates a rollback checkpoint.",
    "Run targeted verification plus /learning-verify before recording applied.",
  ] : mode === "config_write" ? [
    "Review config draft with policy/privacy gates.",
    "Write through the policy-approved edit/ast_refactor workflow and retain its preview/checkpoint evidence.",
    "Run runtime doctor/performance comparison plus /learning-verify before recording applied.",
  ] : [
    "Manual delegated action outside the learning loop.",
    "Capture verification evidence before recording applied.",
  ];
  return { proposalId: proposal.proposalId, mode, delegatedTool, mutationByLearningLoop: false, requiredStatus: "approved", steps, rollback: proposal.applicationPlan?.rollback, verificationPlan: proposal.verificationPlan };
}
function applyProposalDryRun(proposal) {
  const plan = delegatedApplyPlan(proposal);
  return {
    proposalId: proposal.proposalId,
    dryRun: true,
    mode: plan.mode,
    delegatedTool: plan.delegatedTool,
    plan,
    message: "Dry run only. Applying requires an approved proposal plus delegated tool execution and verification evidence refs.",
    suggestedChange: proposal.suggestedChange,
    verificationPlan: proposal.verificationPlan,
  };
}

function isSlashCommand(command) { return /^\s*\//.test(String(command || "")); }
function verificationCommandWords(command) {
  const text = String(command || "").trim();
  if (!text || /(?:^|\s)(?:&&|\|\||[|;<>`])(?:\s|$)|\$\(|\r|\n/.test(text)) throw new Error("verification commands must be one argument-array command without shell operators");
  const words = []; const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g; let match;
  while ((match = re.exec(text))) words.push((match[1] ?? match[2] ?? match[3]).replace(/\\(["'\\ ])/g, "$1"));
  return words;
}
function runVerificationCommand(command, { cwd = process.cwd(), timeoutMs = 5 * 60_000 } = {}) {
  const startedAt = Date.now();
  let words;
  try { words = verificationCommandWords(command); } catch (error) { return { command: redactSensitiveText(command, 300), ok: false, exitCode: null, signal: null, durationMs: Date.now() - startedAt, timedOut: false, error: error.message, stdoutSnippet: "", stderrSnippet: "" }; }
  const result = spawnSync(words[0], words.slice(1), { cwd, env: process.env, shell: false, encoding: "utf8", timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 });
  const durationMs = Date.now() - startedAt;
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  return {
    command: redactSensitiveText(command, 300),
    ok: result.status === 0 && !result.error,
    exitCode: result.status,
    signal: result.signal || null,
    durationMs,
    timedOut: result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM" || result.signal === "SIGKILL",
    error: result.error ? redactSensitiveText(result.error.message || String(result.error), 500) : undefined,
    stdoutHash: stdout ? shortHash(stdout, 16) : undefined,
    stderrHash: stderr ? shortHash(stderr, 16) : undefined,
    stdoutSnippet: stdout ? redactSensitiveText(stdout, 700) : "",
    stderrSnippet: stderr ? redactSensitiveText(stderr, 700) : "",
  };
}
function saveEvidencePacket(cwd, input) {
  const packet = createEvidencePacket ? createEvidencePacket(input) : { id: `evidence_${shortHash({ at: nowIso(), input }, 16)}`, createdAt: nowIso(), ...input };
  if (!EvidenceStore) return packet;
  return new EvidenceStore({ cwd }).saveEvidence(packet);
}
function verificationClaimText(proposal, result) {
  const commandText = (result.commandResults || []).map((r) => r.command).join(", ");
  return [`Verification completed for ${proposal.title}.`, proposal.problemStatement, proposal.suggestedChange?.summary, commandText ? `Commands checked: ${commandText}.` : ""].filter(Boolean).join(" ");
}
function verifyProposalWithEvidence(proposal, options = {}) {
  const cwd = options.cwd || process.cwd();
  const now = options.now || nowIso();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 5 * 60_000));
  const commands = sanitizeArray(proposal.verificationPlan?.commands || [], 30, 300);
  const delegatedCommands = commands.filter(isSlashCommand);
  const shellCommands = commands.filter((command) => !isSlashCommand(command));
  const policy = localPolicyCheck(proposal, { cwd, policy: options.policy || {} });
  const policyOk = policy.ok !== false;
  const runCommands = options.runCommands !== false;
  const commandResults = [];
  if (runCommands && policyOk) {
    for (const command of shellCommands) commandResults.push(runVerificationCommand(command, { cwd, timeoutMs }));
  }
  const skippedCommands = runCommands && policyOk ? [] : shellCommands;
  const commandRunOk = shellCommands.length > 0 && commandResults.length === shellCommands.length && commandResults.every((result) => result.ok);
  const packets = [];
  if (shellCommands.length || skippedCommands.length) {
    packets.push(saveEvidencePacket(cwd, {
      source: "learning-loop-verification-plan",
      ok: policyOk && commandRunOk && delegatedCommands.length === 0,
      confidence: policyOk && commandRunOk ? delegatedCommands.length ? 0.65 : 0.9 : 0.2,
      summary: `Learning proposal ${proposal.proposalId} verification ${policyOk && commandRunOk ? "commands passed" : "commands failed or skipped"}; commands=${shellCommands.length}; delegated=${delegatedCommands.length}`,
      commands: shellCommands,
      files: proposal.affectedFiles || [],
      metadata: { proposalId: proposal.proposalId, delegatedCommands, skippedCommands, commandResults },
    }));
  }
  const shouldCaptureLatest = Boolean(options.captureLatestVerification) || (!shellCommands.length && options.captureLatestVerification !== false);
  const latest = shouldCaptureLatest ? verificationPayload(cwd) : null;
  if (latest?.evidence) {
    packets.push(saveEvidencePacket(cwd, {
      source: "learning-loop-verification-center-capture",
      evidence: latest.evidence,
      commands: latest.commands || [],
      files: latest.evidence?.changeSet?.changedFiles || [],
      metadata: { proposalId: proposal.proposalId, profile: latest.profile, sourceKind: latest.sourceKind },
    }));
  }
  const evidenceRefs = packets.map((packet) => packet.id).filter(Boolean);
  const latestOk = Boolean(latest?.evidence?.ok);
  const ok = policyOk && ((commandRunOk && delegatedCommands.length === 0) || (!shellCommands.length && latestOk));
  const claimText = verificationClaimText(proposal, { commandResults });
  const claimCheck = bindClaims && packets.length ? bindClaims(claimText, packets, { threshold: options.claimThreshold ?? 0.45 }) : { ok: evidenceRefs.length > 0 && ok, threshold: options.claimThreshold ?? 0.45, claims: [], unsupported: [] };
  if (EvidenceStore && packets.length) {
    try { new EvidenceStore({ cwd }).recordClaimCheck(claimText, claimCheck); } catch {}
  }
  const verificationResult = {
    verifiedAt: now,
    ok,
    status: ok ? "verified" : "verification_failed",
    evidenceRefs,
    evidencePackets: packets.map((packet) => ({ id: packet.id, source: packet.source, ok: packet.ok, confidence: packet.confidence, fingerprint: packet.fingerprint })),
    commandResults: commandResults.map((result) => sanitizeStructured(result, 900)),
    delegatedCommands,
    skippedCommands,
    latestVerificationCaptured: Boolean(latest?.evidence),
    policy: sanitizeStructured(policy, 900),
    claimCheck: sanitizeStructured(claimCheck, 900),
    note: redactSensitiveText(options.note || (ok ? "verification evidence captured" : delegatedCommands.length ? "manual slash-command verification still required" : "verification failed or missing evidence"), 500),
  };
  return { ...proposal, updatedAt: now, verificationResult };
}

function learningSelfBenchmarkPlan(cwd = process.cwd(), options = {}) {
  const candidates = [
    "node tests/learning-loop.test.js",
    "node tests/session-miner.test.js",
    "node tests/learning-loop-coordinator.test.js",
    "node tests/productization-extensions.test.js",
    "scripts/check-extensions-smoke.sh",
  ];
  const commands = candidates.filter((command) => {
    const file = command.replace(/^node\s+/, "").replace(/^bash\s+/, "").split(/\s+/)[0];
    return fs.existsSync(path.join(cwd, file));
  });
  return { profile: "learning-loop-self-benchmark", cwd, commands, timeoutMs: Number(options.timeoutMs || 5 * 60_000), evidenceRequired: ["learning-loop tests", "coordinator behavior", "productization registration", "extension smoke"] };
}
function runLearningSelfBenchmark(cwd = process.cwd(), options = {}) {
  const plan = learningSelfBenchmarkPlan(cwd, options);
  const run = Boolean(options.run);
  const commandResults = run ? plan.commands.map((command) => runVerificationCommand(command, { cwd, timeoutMs: plan.timeoutMs })) : [];
  const ok = run ? commandResults.length === plan.commands.length && commandResults.every((result) => result.ok) : null;
  const evidencePacket = run ? saveEvidencePacket(cwd, { source: "learning-loop-self-benchmark", ok, confidence: ok ? 0.9 : 0.25, summary: `Learning-loop self benchmark ${ok ? "passed" : "failed"}; commands=${plan.commands.length}`, commands: plan.commands, files: ["src/learning-loop.js", "src/session-miner.js", ".pi/extensions/learning-loop-coordinator/index.ts"], metadata: { commandResults } }) : null;
  return { generatedAt: nowIso(), ran: run, ok, plan, commandResults: commandResults.map((result) => sanitizeStructured(result, 900)), evidenceRefs: evidencePacket ? [evidencePacket.id] : [], evidencePacket: evidencePacket ? { id: evidencePacket.id, ok: evidencePacket.ok, confidence: evidencePacket.confidence, fingerprint: evidencePacket.fingerprint } : null };
}

function transitionProposal(proposal, event = {}, options = {}) {
  const action = event.action || event.type;
  const now = options.now || nowIso();
  if (!action) throw new Error("proposal transition requires action");
  if (FINAL_PROPOSAL_STATUSES.has(proposal.status) && !["supersede"].includes(action)) throw new Error(`cannot transition final proposal ${proposal.proposalId} from ${proposal.status}`);
  if (action === "review") return reviewProposal(proposal, event.checks || event, { now });
  if (action === "approve") {
    if (proposal.status !== "ready_for_review") throw new Error("proposal must be ready_for_review before approval");
    return {
      ...proposal,
      status: "approved",
      updatedAt: now,
      review: {
        ...(proposal.review || {}),
        reviewedBy: event.reviewedBy || event.actor || "manual",
        approvedAt: now,
        notes: [...arr(proposal.review?.notes), ...arr(event.note).map((n) => redactSensitiveText(n, 500))],
      },
    };
  }
  if (action === "dismiss") {
    return {
      ...proposal,
      status: "dismissed",
      updatedAt: now,
      review: { ...(proposal.review || {}), dismissedAt: now, dismissedBy: event.actor || "manual", dismissReason: redactSensitiveText(event.reason || event.note || "dismissed", 500) },
    };
  }
  if (action === "apply") {
    if (proposal.status !== "approved") throw new Error("proposal must be approved before apply");
    if (!event.evidenceRefs?.length) throw new Error("apply transition requires verification evidence refs");
    return { ...proposal, status: "applied", updatedAt: now, appliedAt: now, applicationResult: { evidenceRefs: sanitizeArray(event.evidenceRefs || [], 50, 200), verified: event.verified !== false, note: redactSensitiveText(event.note || "", 500), delegatedApplyPlan: delegatedApplyPlan(proposal) } };
  }
  if (action === "supersede") return { ...proposal, status: "superseded", updatedAt: now, supersededBy: event.supersededBy, supersedeReason: redactSensitiveText(event.reason || "superseded", 500) };
  throw new Error(`unknown proposal transition action: ${action}`);
}

function minePatterns(outcomes = [], policy = {}) {
  const min = Math.max(1, Number(policy.minOutcomesForPattern || 2));
  const severe = new Set(policy.severeClassifications || ["privacy-risk", "policy-block", "state-growth-risk"]);
  const grouped = new Map();
  for (const outcome of outcomes) {
    for (const classification of outcome.classifications || classifyOutcome(outcome)) {
      if (!grouped.has(classification)) grouped.set(classification, []);
      grouped.get(classification).push(outcome);
    }
  }
  const patterns = [];
  for (const [classification, rows] of grouped.entries()) {
    const isSevere = severe.has(classification);
    if (rows.length < min && !isSevere) continue;
    const kind = classification === "verified-success" ? "repeated-success" : classification.includes("failure") || classification.includes("block") ? "failure" : "risk";
    const pattern = {
      patternId: `pattern_${shortHash({ classification, outcomes: rows.map((o) => o.outcomeId).sort() }, 14)}`,
      createdAt: nowIso(),
      kind,
      classification,
      outcomeIds: rows.map((o) => o.outcomeId),
      count: rows.length,
      severity: isSevere || rows.length >= min * 2 ? "high" : "medium",
      summary: `${classification} observed in ${rows.length} outcome(s)`,
      evidenceRefs: rows.flatMap((o) => [o.outcomeId, ...(o.artifacts?.evidenceRefs || [])]).filter(Boolean),
    };
    pattern.fingerprint = shortHash({ classification, kind, outcomeIds: pattern.outcomeIds.slice().sort(), count: pattern.count, severity: pattern.severity, evidenceRefs: pattern.evidenceRefs.slice().sort() }, 16);
    patterns.push(pattern);
  }
  return patterns.sort((a, b) => a.classification.localeCompare(b.classification));
}
function mineFailurePatterns(outcomes = [], policy = {}) {
  const failureClassifications = new Set(policy.failureClassifications || ["verification-failure", "tool-failure", "policy-block", "privacy-risk", "skill-underperformance", "user-correction"]);
  const severeClassifications = Array.from(new Set([...(policy.severeClassifications || []), "privacy-risk", "policy-block", "state-growth-risk"]));
  return minePatterns(outcomes, { ...policy, severeClassifications })
    .filter((pattern) => pattern.kind === "failure" || failureClassifications.has(pattern.classification))
    .map((pattern) => ({ ...pattern, miner: "failure-pattern-miner" }));
}

function proposalKindForPattern(pattern) {
  const classification = String(pattern.classification || "");
  if (classification === "verified-success" || classification.includes("workflow-repetition") || classification.includes("skill-adoption-gap")) return "skill";
  if (classification === "missing-test" || classification === "verification-failure") return "test";
  if (classification === "unsupported-success" || classification.includes("tool-failure") || classification.includes("user-correction")) return "prompt";
  if (["latency-risk", "state-growth-risk", "privacy-risk", "policy-block"].includes(classification)) return "config";
  return "skill";
}

function proposeImprovements(patterns = [], context = {}) {
  return patterns.map((pattern) => {
    const kind = proposalKindForPattern(pattern);
    const changedFiles = sanitizeArray(context.changedFiles || pattern.changedFiles || [], 80, 300);
    const testCommands = sanitizeArray(context.testCommands || [], 20, 300);
    const base = {
      kind,
      title: `${kind} proposal for ${pattern.classification}`,
      problemStatement: pattern.summary,
      evidenceRefs: pattern.evidenceRefs,
      affectedFiles: changedFiles,
      risk: { level: kind === "prompt" ? "high" : kind === "config" || kind === "skill" ? "medium" : "low", reasons: [`derived from ${pattern.count} outcome(s)`, `pattern=${pattern.classification}`], requiresUserApproval: true },
      applicationPlan: { mode: kind === "skill" ? "skill_synthesis" : kind === "test" || kind === "prompt" ? "ast_refactor" : "config_write", rollback: "proposal-only; delegated apply tool must create checkpoint/rollback evidence" },
    };
    if (kind === "skill") {
      return createProposal({
        ...base,
        suggestedChange: {
          summary: "Create a reviewed candidate procedural skill from the repeated verified workflow before approval.",
          skillDraft: {
            name: `Workflow for ${pattern.classification}`,
            category: pattern.classification === "verified-success" ? "general" : "debugging",
            triggerConditions: [pattern.classification, "similar task pattern"],
            workflowSteps: [
              { id: "inspect", description: "Inspect relevant evidence and current repo state." },
              { id: "execute", description: "Apply the smallest safe workflow step." },
              { id: "verify", description: "Collect verifier/evidence-binder proof before completion." },
            ],
            validationStrategy: { kind: "evidence", requiredEvidence: ["verification evidence", "claim-check"] },
          },
        },
        verificationPlan: { commands: ["/skill-doctor"], evidenceRequired: ["skill doctor", "optional skill A/B score"] },
      });
    }
    if (kind === "test") {
      return createProposal({
        ...base,
        suggestedChange: {
          summary: "Add or update focused tests for the affected files before relying on broad smoke/full checks.",
          testDraft: {
            affectedFiles: changedFiles,
            candidateCommands: testCommands,
            skeletonPolicy: "preview first; write via test_gap_planner, edit, or ast_refactor only after approval; retain ast_refactor checkpoint evidence for broad changes",
          },
        },
        verificationPlan: { commands: testCommands, evidenceRequired: ["targeted test", "changed/full verification as appropriate", "claim-check"] },
      });
    }
    if (kind === "prompt") {
      return createProposal({
        ...base,
        suggestedChange: {
          summary: "Tighten prompt/tool guidance to require evidence-backed completion and compact tool output handling.",
          promptDraft: "When reporting completion, cite verifier/evidence packet IDs or explicitly state that verification was not run. Rely on tool-specific compact result rendering for verbose payloads; do not resend them through a manual compactor.",
          patchPlan: ["Identify the narrow prompt/template/doc target", "Apply with edit/ast_refactor after review; use explicit patch commands only for packet validation", "Run prompt policy and learning-loop tests"],
        },
        verificationPlan: { commands: ["node tests/meta-prompt-skill-policy.test.js", "node tests/learning-loop.test.js"], evidenceRequired: ["prompt policy test", "claim-check"] },
      });
    }
    return createProposal({
      ...base,
      suggestedChange: {
        summary: "Review safe runtime configuration recommendations and write them only through reviewed config workflow.",
        configDraft: {
          PI_PROMPT_SUGGESTIONS_REFINE: "off",
          PI_COGNITIVE_AUTO_CONSOLIDATE: "0",
          PI_TRACE_CAPTURE_PAYLOADS: "0",
          PI_LEARNING_AUTO_INGEST: "0 unless explicitly dogfooding non-blocking ingestion",
        },
        patchPlan: ["Write reviewed .pi config/safe-env suggestion", "Run runtime doctor/perf comparison", "Keep generated runtime state uncommitted"],
      },
      verificationPlan: { commands: ["/doctor", "/perf-report", "node tests/learning-loop.test.js"], evidenceRequired: ["runtime doctor/perf comparison", "claim-check"] },
    });
  });
}

const SAFE_LEARNING_INGEST_SOURCES = ["verification", "topology", "skill", "trace", "evidence", "execution", "goal", "runtime", "memory", "policy", "privacy"];
function latestFile(dir, suffix = ".json") {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(suffix)).map((name) => path.join(dir, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  } catch { return null; }
}
function readJsonlTail(file, maxBytes = 256 * 1024) {
  try {
    const st = fs.statSync(file);
    const text = fs.readFileSync(file, "utf8");
    const tail = st.size > maxBytes ? text.slice(-maxBytes) : text;
    return tail.split(/\n+/).filter((line) => line.trim().startsWith("{")).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function commandText(item) { if (!item) return ""; if (typeof item === "string") return item; return [item.command, ...(item.args || [])].filter(Boolean).join(" ") || item.id || ""; }
function relState(cwd, file) { return String(file || "").startsWith(cwd) ? String(file).slice(cwd.length + 1) : file; }
function verificationPayload(cwd) {
  const latest = readJson(path.join(cwd, ".pi", "verification-center", "latest.json"), null);
  if (latest?.evidence) return { sourceKind: "verification-center", profile: latest.profile, commands: (latest.commands || []).map(commandText).filter(Boolean), evidence: latest.evidence };
  const fallback = latestFile(path.join(cwd, ".pi", "cognitive-automation", "verification", "evidence"));
  const evidence = fallback ? readJson(fallback, null) : null;
  if (evidence) return { sourceKind: "cognitive-automation", profile: "automated", commands: (evidence.verifiers || []).map(commandText).filter(Boolean), evidence, file: fallback };
  return null;
}
function listJsonFiles(dir, limit = 50) {
  try { return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, limit); }
  catch { return []; }
}
function latestJson(paths = []) {
  for (const file of paths.filter(Boolean)) {
    const value = readJson(file, null);
    if (value) return { file, value };
  }
  return null;
}
function countFiles(dir, limit = 5000) {
  let count = 0;
  let bytes = 0;
  function walk(current) {
    if (count >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (count >= limit) break;
      const file = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) walk(file);
        else { count++; bytes += fs.statSync(file).size; }
      } catch {}
    }
  }
  walk(dir);
  return { count, bytes, truncated: count >= limit };
}
function ingestionOutcome(store, source, input) {
  const outcome = store.recordOutcome({ source, ...input });
  return { source, outcome };
}
function topologyRunLearningCohort(run = {}) {
  const current = [2, 3].includes(Number(run.schemaVersion)) && Number(run.roleRuntimeVersion) === 2 && run.contractVersion === "role-v2" && Number(run.resultSchemaVersion) === 2;
  return { cohort: current ? "current-v2" : "legacy", reliabilityEligible: current };
}
function ingestLearningSource(cwd = process.cwd(), source = "verification", options = {}) {
  const store = options.store || new LearningStore({ cwd, root: options.root || path.join(cwd, options.stateDir || ".pi/learning-loop") });
  if (source === "verification") {
    const payload = verificationPayload(cwd);
    if (!payload) return { skipped: true, source: "verification", reason: "no verification evidence found" };
    const e = payload.evidence;
    // Not-applicable evidence (empty change set) is not a failure; recording
    // it as one is what flooded outcomes.jsonl with junk verification-failure
    // entries. Coverage gaps are recorded honestly as gaps, not failures.
    if (e.ok == null || e.status === "not-applicable") {
      return { skipped: true, source: "verification", reason: `verification not applicable (${e.reason || "empty change set"}); no outcome recorded` };
    }
    if (e.status === "no-verifiers") {
      const outcome = store.recordOutcome({
        source: "verification",
        task: { summary: `Verification ${payload.profile || "latest"} had no verifier coverage`, repo: cwd },
        summary: `Verification evidence ${e.id || "latest"}: NO-VERIFIERS (coverage gap, fail-closed); changedFiles=${e.changeSet?.changedFiles?.length || 0}`,
        signals: { status: "unknown", evidenceLevel: "tool-output", commands: payload.commands || [] },
        artifacts: { evidenceRefs: [e.id, e.evidenceFile, payload.file].filter(Boolean).map((x) => relState(cwd, x)), changedFiles: e.changeSet?.changedFiles || [] },
        classifications: ["verification-coverage-gap"],
      });
      return { source: "verification", outcome };
    }
    const outcome = store.recordOutcome({
      source: "verification",
      task: { summary: `Verification ${payload.profile || "latest"} ${e.ok ? "passed" : "failed"}`, repo: cwd },
      summary: `Verification evidence ${e.id || "latest"}: ${e.ok ? "PASS" : "FAIL"}; confidence=${Math.round(Number(e.confidence || 0) * 100)}%; changedFiles=${e.changeSet?.changedFiles?.length || 0}`,
      signals: { status: e.ok ? "succeeded" : "failed", evidenceLevel: payload.profile === "full" && e.ok ? "full-check" : "verification", verificationOk: Boolean(e.ok), commands: payload.commands || [], policyBlocks: e.policy?.ok === false ? (e.policy.violations || []).length || 1 : 0 },
      artifacts: { evidenceRefs: [e.id, e.evidenceFile, payload.file].filter(Boolean).map((x) => relState(cwd, x)), changedFiles: e.changeSet?.changedFiles || [] },
    });
    return { source: "verification", outcome };
  }
  if (source === "topology") {
    const file = latestFile(path.join(cwd, ".pi", "cognitive-automation", "topologies", "runs"));
    const run = file ? readJson(file, null) : null;
    if (!run) return { skipped: true, source: "topology", reason: "no topology run found" };
    const errors = (run.errors || []).length + (run.results || []).filter((r) => r?.error || r?.status === "failed").length;
    const cohort = topologyRunLearningCohort(run);
    const reliableStatus = cohort.reliabilityEligible ? (run.status === "succeeded" ? "succeeded" : run.status === "failed" ? "failed" : "unknown") : "unknown";
    const outcome = store.recordOutcome({
      source: "topology",
      task: { summary: `Topology ${run.topologyId || "latest"} ${run.status || "unknown"}`, repo: cwd, traceCorrelationId: run.traceCorrelationId },
      summary: `Topology run ${run.runId}: ${run.status}; cohort=${cohort.cohort}; nodes=${run.results?.length || 0}; durationMs=${run.durationMs || 0}`,
      signals: { status: reliableStatus, evidenceLevel: "tool-output", toolErrors: errors, latencyMs: Number(run.durationMs || 0), reliabilityEligible: cohort.reliabilityEligible },
      artifacts: { traceRefs: [run.runId].filter(Boolean), topologyRunIds: [run.runId].filter(Boolean) },
      classifications: [cohort.cohort, ...(run.incompleteMutation ? ["incomplete-mutation"] : [])],
    });
    return { source: "topology", outcome };
  }
  if (source === "skill") {
    const rows = readJsonlTail(path.join(cwd, ".pi", "cognitive-automation", "skills", "metrics.jsonl"), 128 * 1024).slice(-50);
    const skillRows = rows.filter((row) => row?.skillId);
    if (!skillRows.length) return { skipped: true, source: "skill", reason: "no skill metrics found" };
    const successes = skillRows.filter((row) => row.ok !== false).length;
    const failures = skillRows.length - successes;
    const latest = skillRows.at(-1);
    const outcome = store.recordOutcome({
      source: "skill",
      task: { summary: `Skill evaluation snapshot for ${latest?.evidence?.prompt || "recent tasks"}`, repo: cwd },
      summary: `Skill evaluations: ${successes} ok, ${failures} failed across ${skillRows.length} recent events`,
      signals: { status: failures > successes ? "failed" : "succeeded", evidenceLevel: "tool-output", verificationOk: failures === 0 ? true : null, toolErrors: failures },
      artifacts: { skillIds: Array.from(new Set(skillRows.map((row) => row.skillId).filter(Boolean))) },
      classifications: failures ? ["skill-underperformance"] : [],
    });
    return { source: "skill", outcome };
  }
  if (source === "trace") {
    const rows = readJsonlTail(path.join(cwd, ".pi", "cognitive-automation", "trace", "events.jsonl"), 256 * 1024).slice(-250);
    if (!rows.length) return { skipped: true, source: "trace", reason: "no project trace events found" };
    const errors = rows.filter((row) => row.severity === "error" || /error|failed|failure/i.test(String(row.name || row.type || ""))).length;
    const durations = rows.map((row) => Number(row.durationMs || row.duration_ms || row.payload?.durationMs || 0)).filter((n) => Number.isFinite(n));
    const maxDuration = durations.length ? Math.max(...durations) : 0;
    const outcome = store.recordOutcome({
      source: "trace",
      task: { summary: "Recent project trace health snapshot", repo: cwd },
      summary: `Trace snapshot: events=${rows.length}; errors=${errors}; maxDurationMs=${Math.round(maxDuration)}`,
      signals: { status: errors ? "failed" : "succeeded", evidenceLevel: "tool-output", toolErrors: errors, latencyMs: maxDuration },
      artifacts: { traceRefs: [".pi/cognitive-automation/trace/events.jsonl"] },
    });
    return { source: "trace", outcome };
  }
  if (source === "evidence") {
    const evidenceRows = readJsonlTail(path.join(cwd, ".pi", "evidence-binder", "evidence.jsonl"), 128 * 1024).slice(-50);
    const claimRows = readJsonlTail(path.join(cwd, ".pi", "evidence-binder", "claims.jsonl"), 128 * 1024).slice(-50);
    if (!evidenceRows.length && !claimRows.length) return { skipped: true, source: "evidence", reason: "no Evidence Binder state found" };
    const failedClaims = claimRows.filter((row) => row?.result?.ok === false || Number(row?.result?.unsupported?.length || 0) > 0).length;
    const okEvidence = evidenceRows.filter((row) => row.ok !== false).length;
    return ingestionOutcome(store, "evidence", {
      task: { summary: "Evidence Binder proof/claim snapshot", repo: cwd },
      summary: `Evidence Binder snapshot: evidence=${evidenceRows.length}; okEvidence=${okEvidence}; claimChecks=${claimRows.length}; unsupported=${failedClaims}`,
      signals: { status: failedClaims ? "failed" : evidenceRows.length ? "succeeded" : "unknown", evidenceLevel: "tool-output", verificationOk: failedClaims ? false : okEvidence > 0 ? true : null, toolErrors: failedClaims },
      artifacts: { evidenceRefs: evidenceRows.map((row) => row.id).filter(Boolean) },
      classifications: failedClaims ? ["unsupported-claim"] : [],
    });
  }
  if (source === "execution") {
    const packets = new ExecutionOutcomeStore({ cwd }).packets({ limit: Number(options.limit || 1000) });
    if (!packets.length) return { skipped: true, source: "execution", reason: "no settled execution packets found" };
    const outcomes = packets.map((packet) => store.recordOutcome(executionOutcomeToLearningInput(packet)));
    return { source: "execution", outcomes, recorded: outcomes.filter((outcome) => !outcome.duplicate).length, duplicates: outcomes.filter((outcome) => outcome.duplicate).length };
  }
  if (source === "goal") {
    const files = [...listJsonFiles(path.join(cwd, ".pi", "goal-state"), 20), ...listJsonFiles(path.join(cwd, ".pi", "goal-state", "archive"), 20)];
    const goals = files.flatMap((file) => arr(readJson(file, {})?.goals).map((goal) => ({ ...goal, file })));
    if (!goals.length) return { skipped: true, source: "goal", reason: "no goal state found" };
    const recentGoals = goals.slice(-50);
    const failures = recentGoals.filter((goal) => ["failed", "blocked", "cancelled"].includes(goal.status)).length;
    const completed = recentGoals.filter((goal) => goal.status === "completed").length;
    const latest = recentGoals.at(-1) || {};
    return ingestionOutcome(store, "goal", {
      task: { summary: `Compatibility aggregate goal-state snapshot ${latest.status || "unknown"}`, repo: cwd },
      summary: `Compatibility aggregate goal snapshot: total=${recentGoals.length}; completed=${completed}; failures=${failures}; latest=${redactSensitiveText(latest.goal || "", 240)}`,
      signals: { status: failures ? "failed" : completed ? "succeeded" : "unknown", evidenceLevel: "tool-output", toolErrors: failures },
      artifacts: { traceRefs: files.map((file) => relState(cwd, file)).slice(0, 20) },
      classifications: ["aggregate-compatibility", ...(failures ? ["goal-underperformance"] : [])],
    });
  }
  if (source === "runtime") {
    const candidates = [
      path.join(cwd, ".pi", "runtime-doctor", "latest.json"),
      path.join(cwd, ".pi", "runtime-doctor", "latest-report.json"),
      path.join(cwd, ".pi", "performance-optimizer", "latest.json"),
      path.join(cwd, ".pi", "performance-optimizer", "baseline.json"),
      latestFile(path.join(cwd, ".pi", "runtime-doctor", "reports")),
      latestFile(path.join(cwd, ".pi", "performance-optimizer", "reports")),
    ];
    const latest = latestJson(candidates);
    const state = countFiles(path.join(cwd, ".pi", "cognitive-automation"));
    if (!latest && !state.count) return { skipped: true, source: "runtime", reason: "no runtime doctor/performance state found" };
    const raw = stableStringify(latest?.value || {});
    const riskHints = (raw.match(/risk|warning|slow|latency|large|growth|blocking/gi) || []).length;
    return ingestionOutcome(store, "runtime", {
      task: { summary: "Runtime Doctor/Performance snapshot", repo: cwd },
      summary: `Runtime snapshot: report=${latest ? relState(cwd, latest.file) : "none"}; stateFiles=${state.count}; stateBytes=${state.bytes}; riskHints=${riskHints}`,
      signals: { status: riskHints ? "failed" : "succeeded", evidenceLevel: "tool-output", toolErrors: riskHints ? 1 : 0, latencyMs: Number(latest?.value?.latencyMs || latest?.value?.durationMs || 0), stateGrowthBytes: state.bytes },
      artifacts: { traceRefs: [latest?.file && relState(cwd, latest.file)].filter(Boolean) },
    });
  }
  if (source === "memory") {
    const candidates = [
      latestFile(path.join(cwd, ".pi", "memory-curator")),
      latestFile(path.join(cwd, ".pi", "memory-explorer")),
    ];
    const latest = latestJson(candidates);
    if (!latest) return { skipped: true, source: "memory", reason: "no memory curator/explorer state found" };
    const raw = stableStringify(latest.value);
    const candidatesCount = arr(latest.value.candidates || latest.value.promotions || latest.value.findings || latest.value.items).length;
    const conflicts = (raw.match(/conflict|stale|forget|duplicate|expire/gi) || []).length;
    return ingestionOutcome(store, "memory", {
      task: { summary: "Memory curator/explorer snapshot", repo: cwd },
      summary: `Memory snapshot: ${relState(cwd, latest.file)}; candidates=${candidatesCount}; lifecycleHints=${conflicts}`,
      signals: { status: conflicts ? "failed" : "unknown", evidenceLevel: "tool-output", toolErrors: conflicts ? 1 : 0 },
      artifacts: { traceRefs: [relState(cwd, latest.file)] },
      classifications: conflicts ? ["memory-lifecycle-risk"] : [],
    });
  }
  if (source === "policy") {
    const files = [latestFile(path.join(cwd, ".pi", "policy-enforcer")), latestFile(path.join(cwd, ".pi", "policy-gate"))].filter(Boolean);
    const rows = files.map((file) => ({ file, value: readJson(file, {}) }));
    if (!rows.length) return { skipped: true, source: "policy", reason: "no policy state found" };
    const raw = stableStringify(rows.map((r) => r.value));
    const denials = (raw.match(/deny|denied|block|blocked|violation/gi) || []).length;
    return ingestionOutcome(store, "policy", {
      task: { summary: "Policy Gate/Enforcer snapshot", repo: cwd },
      summary: `Policy snapshot: files=${rows.length}; denials=${denials}`,
      signals: { status: denials ? "blocked" : "succeeded", evidenceLevel: "tool-output", policyBlocks: denials },
      artifacts: { traceRefs: rows.map((r) => relState(cwd, r.file)) },
    });
  }
  if (source === "privacy") {
    const scan = readJson(path.join(cwd, ".pi", "privacy-guard", "latest-scan.json"), null);
    if (!scan) return { skipped: true, source: "privacy", reason: "no Privacy Guard latest scan found" };
    const actionable = Number(scan.summary?.actionable || scan.findings?.length || 0);
    return ingestionOutcome(store, "privacy", {
      task: { summary: "Privacy Guard scan snapshot", repo: cwd },
      summary: `Privacy snapshot: ok=${scan.ok !== false}; actionable=${actionable}; ignored=${scan.summary?.ignored || 0}`,
      signals: { status: actionable ? "failed" : "succeeded", evidenceLevel: "tool-output", privacyFindings: actionable },
      artifacts: { traceRefs: [".pi/privacy-guard/latest-scan.json"] },
      classifications: actionable ? ["privacy-risk"] : [],
    });
  }
  return { skipped: true, source, reason: `unsupported source: ${source}` };
}
function ingestLearningSources(cwd = process.cwd(), source = "verification", options = {}) {
  const sources = source === "all" ? SAFE_LEARNING_INGEST_SOURCES : [source];
  const store = options.store || new LearningStore({ cwd, root: options.root || path.join(cwd, options.stateDir || ".pi/learning-loop") });
  const results = sources.map((item) => ingestLearningSource(cwd, item, { ...options, store }));
  return { generatedAt: nowIso(), results, recorded: results.reduce((sum, result) => sum + (Number.isFinite(result.recorded) ? result.recorded : result.outcome && !result.outcome.duplicate ? 1 : 0), 0), duplicates: results.reduce((sum, result) => sum + (Number.isFinite(result.duplicates) ? result.duplicates : result.outcome?.duplicate ? 1 : 0), 0), skipped: results.filter((r) => r.skipped).length };
}

function contextAttributionReport(outcomes = [], options = {}) {
  const minimumPaired = Math.max(1, Number(options.minimumPaired || 30));
  const strategyGroups = new Map();
  for (const outcome of outcomes) {
    if (!outcome.retrieval?.strategyId) continue;
    const key = `${outcome.retrieval.strategyId}::${outcome.retrieval.rolloutMode || "advisory"}`;
    if (!strategyGroups.has(key)) strategyGroups.set(key, []);
    strategyGroups.get(key).push(outcome);
  }
  const strategyRows = Array.from(strategyGroups, ([key, matched]) => {
    const [strategyId, rolloutMode] = key.split("::");
    const successes = matched.filter((outcome) => outcome.signals?.status === "succeeded").length;
    const failures = matched.filter((outcome) => outcome.signals?.status === "blocked" || isFailureOutcome(outcome.signals?.status)).length;
    const avg = (field) => { const values = matched.map((outcome) => Number(outcome.retrieval?.metrics?.[field])).filter(Number.isFinite); return values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)) : null; };
    const paired = new Set(matched.map((outcome) => outcome.retrieval?.pairId).filter(Boolean)).size;
    const corrections = matched.filter((outcome) => outcome.retrieval?.humanCorrection).length;
    const broadReadFallbacks = matched.filter((outcome) => outcome.retrieval?.fallbackToBroadRead).length;
    const avgQuality = matched.length ? Number((matched.reduce((sum, outcome) => sum + Number(outcome.rating?.qualityScore || 0), 0) / matched.length).toFixed(3)) : 0;
    const ready = paired >= minimumPaired;
    return { name: `retrieval:${strategyId}`, attribution: "explicit-strategy-id", strategyId, rolloutMode, outcomes: matched.length, pairedOutcomes: paired, minimumPaired, successes, failures, avgQuality, avgCost: avg("cost"), avgLatencyMs: avg("latencyMs"), avgTokens: avg("tokens"), corrections, broadReadFallbacks, recommendation: !ready ? "advisory only; insufficient paired evidence" : failures || corrections || broadReadFallbacks ? "keep advisory; investigate negative evidence" : "candidate for reviewed promotion", advisoryOnly: !ready };
  }).sort((a, b) => a.strategyId.localeCompare(b.strategyId) || a.rolloutMode.localeCompare(b.rolloutMode));
  const dimensions = options.dimensions || {
    hermes: /hermes|advisory/i,
    cognitive: /cognitive|reasoning|context|scaffold/i,
    skill: /skill|skill_synthesis/i,
    topology: /topology|subagent|branch/i,
    verification: /verify|verification|evidence|proof/i,
  };
  const rows = Object.entries(dimensions).map(([name, re]) => {
    const matched = outcomes.filter((outcome) => re.test(stableStringify({ summary: outcome.summary, task: outcome.task, artifacts: outcome.artifacts, classifications: outcome.classifications })));
    const successes = matched.filter((o) => o.signals?.status === "succeeded").length;
    const failures = matched.filter((o) => o.signals?.status === "blocked" || isFailureOutcome(o.signals?.status)).length;
    const avgQuality = matched.length ? matched.reduce((sum, o) => sum + Number(o.rating?.qualityScore || 0), 0) / matched.length : 0;
    const recommendation = !matched.length ? "no evidence yet" : failures > successes ? "reduce or audit this context source before increasing injection budget" : avgQuality >= 0.7 ? "candidate for promotion/increased retrieval confidence" : "keep neutral; gather more evidence";
    return { name, outcomes: matched.length, successes, failures, avgQuality: Number(avgQuality.toFixed(3)), recommendation };
  });
  const selectedRows = strategyRows.length ? strategyRows : rows;
  return { generatedAt: nowIso(), kind: "context-attribution-optimizer", attribution: strategyRows.length ? "explicit-retrieval-strategy" : "legacy-dimension-fallback", minimumPaired, rows: selectedRows, recommendations: selectedRows.filter((row) => row.outcomes).map((row) => `${row.name}: ${row.recommendation}`) };
}
function adaptiveModelRouterReport(outcomes = [], options = {}) {
  const minEvidence = Math.max(1, Number(options.minEvidence || options.minOutcomes || 3));
  const readyQuality = Number(options.readyQuality || 0.7);
  const groups = new Map();
  for (const outcome of outcomes) {
    const text = stableStringify({ task: outcome.task, summary: outcome.summary, classifications: outcome.classifications }).toLowerCase();
    const taskType = /test|verify|ci|failure/.test(text) ? "debug-verify" : /doc|readme|prompt/.test(text) ? "docs-prompt" : /latency|performance|perf/.test(text) ? "performance" : /policy|privacy|secret/.test(text) ? "safety" : "general-coding";
    if (!groups.has(taskType)) groups.set(taskType, []);
    groups.get(taskType).push(outcome);
  }
  const routes = [];
  for (const [taskType, rows] of groups.entries()) {
    const avgQuality = rows.reduce((sum, o) => sum + Number(o.rating?.qualityScore || 0), 0) / Math.max(1, rows.length);
    const failures = rows.filter((o) => o.signals?.status === "blocked" || isFailureOutcome(o.signals?.status)).length;
    const thinking = failures || avgQuality < 0.6 ? "high" : taskType === "docs-prompt" ? "medium" : "low";
    const toolPreset = taskType === "debug-verify" ? ["read", "bash", "edit", "verification_center", "evidence_binder"] : taskType === "performance" ? ["runtime_doctor", "performance_optimizer", "bash"] : taskType === "safety" ? ["privacy_guard", "policy_gate", "evidence_binder"] : ["read", "bash", "edit"];
    const confidence = Math.min(1, (rows.length / minEvidence) * Math.max(0.2, avgQuality) * (failures ? 0.75 : 1));
    const readiness = rows.length < minEvidence ? "insufficient_evidence" : avgQuality >= readyQuality && !failures ? "ready_for_review" : "needs_review";
    routes.push({ taskType, evidenceOutcomes: rows.length, minEvidence, avgQuality: Number(avgQuality.toFixed(3)), failures, confidence: Number(confidence.toFixed(3)), readiness, recommendation: { modelClass: "default-provider", thinking, toolPreset }, advisoryOnly: true });
  }
  return { generatedAt: nowIso(), kind: "adaptive-model-router", minEvidence, readyQuality, routes: routes.sort((a, b) => a.taskType.localeCompare(b.taskType)), note: "Advisory only; never auto-route until recommendations are ready_for_review and explicitly approved." };
}
function experimentPlanFromProposal(proposal, options = {}) {
  const id = `experiment_${shortHash({ proposalId: proposal.proposalId, at: options.now || nowIso(), arms: options.arms || [] }, 14)}`;
  const arms = options.arms?.length ? options.arms : [
    { id: "control", description: "Current workflow/baseline", command: "/verify-run learning", executable: false },
    { id: "candidate", description: `Reviewed proposal: ${proposal.title}`, command: proposal.applicationPlan?.mode === "skill_synthesis" ? "/skill-synthesize --dry-run" : "/learning-apply latest --dry-run", executable: false },
  ];
  return { experimentId: id, createdAt: options.now || nowIso(), proposalId: proposal.proposalId, status: "planned", advisoryOnly: true, isolation: "use branch-backed subagents/topology; do not mutate main", branchBacked: true, arms, execution: { mode: "plan-only-by-default", runBenchmarkEvidence: Boolean(options.runBenchmarkEvidence), branchCommands: ["/subagent-create reviewer", "/subagent-create verifier"], topologyCommands: ["/topology-install reviewer-verifier-gate", "/topology-run reviewer-verifier-gate <experiment summary>"] }, suggestedCommands: ["/subagent-create verifier", "/topology-install reviewer-verifier-gate", "/topology-run reviewer-verifier-gate <experiment summary>", "/learning-verify latest --latest"], successMetrics: ["verification evidence ok", "claim-check supported", "latency non-regression", "no privacy/policy findings"] };
}
function runExperimentPlan(cwd, plan, options = {}) {
  const now = options.now || nowIso();
  const benchmark = options.runBenchmark ? runLearningSelfBenchmark(cwd, { run: true, timeoutMs: options.timeoutMs }) : runLearningSelfBenchmark(cwd, { run: false, timeoutMs: options.timeoutMs });
  const executedArms = (plan.arms || []).map((arm) => ({ ...arm, executed: false, reason: arm.executable ? "execution disabled by safety policy; use branch-backed subagents manually" : "slash-command/topology arm is plan-only" }));
  const ok = benchmark.ran ? benchmark.ok !== false : null;
  const evidencePacket = saveEvidencePacket(cwd, { source: "learning-loop-experiment", ok: ok !== false, confidence: ok ? 0.75 : 0.35, summary: `Experiment ${plan.experimentId} ${benchmark.ran ? "captured benchmark evidence" : "planned branch/topology run"}`, commands: [...(plan.suggestedCommands || []), ...(benchmark.plan?.commands || [])], files: [], metadata: { experimentId: plan.experimentId, proposalId: plan.proposalId, executedArms, benchmark } });
  return { ...plan, status: benchmark.ran ? (ok ? "evidence_captured" : "evidence_failed") : "planned_with_evidence_packet", updatedAt: now, executedArms, benchmark, evidenceRefs: [evidencePacket.id], evidencePacket: { id: evidencePacket.id, ok: evidencePacket.ok, confidence: evidencePacket.confidence, fingerprint: evidencePacket.fingerprint } };
}
function refactorProposalPacket(cwd, proposal, options = {}) {
  if (options.requireApproved !== false && proposal.status !== "approved") throw new Error("refactor proposal requires an approved proposal; use /learning-approve first or pass requireApproved=false for preview tests");
  const id = `refactor_proposal_${shortHash({ proposalId: proposal.proposalId, fingerprint: proposal.fingerprint, at: options.now || nowIso() }, 14)}`;
  const packet = {
    id,
    createdAt: options.now || nowIso(),
    source: "learning-loop-refactor-proposer",
    proposalId: proposal.proposalId,
    status: "draft",
    dryRun: true,
    advisoryOnly: true,
    targetTool: proposal.applicationPlan?.mode === "skill_synthesis" ? "skill_synthesis" : "edit/ast_refactor",
    affectedFiles: proposal.affectedFiles || [],
    suggestedChange: proposal.suggestedChange,
    refactorInputs: (proposal.affectedFiles || []).map((file) => ({ file, mode: "preview", guidance: `Localize the exact pattern for ${proposal.proposalId}, preview first, and apply only after review.` })),
    verificationPlan: proposal.verificationPlan,
    rollback: proposal.applicationPlan?.rollback,
  };
  const file = path.join(cwd, ".pi", "learning-loop", "refactor-proposals", `${id}.json`);
  writeJson(file, packet);
  writeJson(path.join(cwd, ".pi", "learning-loop", "latest-refactor-proposal.json"), { id, file, at: packet.createdAt, proposalId: proposal.proposalId });
  return { file, packet };
}
function durableMemorySummary(proposalOrOutcome) {
  const kind = proposalOrOutcome.proposalId ? "proposal" : "outcome";
  const id = proposalOrOutcome.proposalId || proposalOrOutcome.outcomeId;
  const title = proposalOrOutcome.title || proposalOrOutcome.task?.summary || proposalOrOutcome.summary || id;
  const evidenceRefs = proposalOrOutcome.applicationResult?.evidenceRefs || proposalOrOutcome.verificationResult?.evidenceRefs || proposalOrOutcome.artifacts?.evidenceRefs || [];
  return { kind, id, summary: redactSensitiveText(`${kind} ${id}: ${title}`, 500), evidenceRefs: sanitizeArray(evidenceRefs, 20, 200), promoteToHermes: evidenceRefs.length > 0, hermesCommand: evidenceRefs.length ? `/hermes-note ${redactSensitiveText(`${kind} ${id}: ${title}`, 300)}` : null, memoryCurator: { action: "review-promote", source: "learning-loop", id }, note: "Store this concise summary only after human review; never sync raw outcomes/transcripts." };
}
function writeMemorySummaryCandidate(cwd, summary, options = {}) {
  const id = `memory_learning_${shortHash({ summary, at: options.now || nowIso() }, 14)}`;
  const packet = { id, createdAt: options.now || nowIso(), ...summary, reviewed: Boolean(options.reviewed), status: options.reviewed ? "ready_for_memory_review" : "draft" };
  const write = options.write === true;
  if (!write) return { id, written: false, learningFile: null, curatorFile: null, packet };
  assertMemoryContentSafe(JSON.stringify(packet), { maxChars: 20_000 });
  const learningFile = path.join(cwd, ".pi", "learning-loop", "memory-summaries", `${id}.json`);
  const curatorFile = path.join(cwd, ".pi", "memory-curator", "learning-candidates", `${id}.json`);
  writeJson(learningFile, packet);
  writeJson(curatorFile, packet);
  return { id, written: true, learningFile, curatorFile, packet };
}

class LearningStore {
  constructor({ cwd = process.cwd(), root = path.join(cwd, ".pi", "learning-loop"), clock } = {}) {
    this.cwd = cwd;
    this.root = root;
    this.clock = clock;
  }
  now() { return this.clock ? new Date(this.clock()).toISOString() : nowIso(); }
  outcomeLedgerFile() { return path.join(this.root, "outcomes.jsonl"); }
  patternLedgerFile() { return path.join(this.root, "patterns.jsonl"); }
  experimentsDir() { return path.join(this.root, "experiments"); }
  decisionsFile() { return path.join(this.root, "decisions.jsonl"); }
  proposalFile(id) { return path.join(this.root, "proposals", `${id}.json`); }
  recordDecision(record) { appendJsonl(this.decisionsFile(), { at: this.now(), ...record }); }
  recordOutcome(input) {
    const outcome = createOutcome(input, { now: this.now() });
    const existing = this.listOutcomes().find((item) => item.outcomeId === outcome.outcomeId);
    if (existing) {
      this.recordDecision({ type: "outcome.duplicate", outcomeId: existing.outcomeId, source: existing.source, classifications: existing.classifications });
      return { ...existing, duplicate: true };
    }
    appendJsonl(this.outcomeLedgerFile(), outcome);
    this.recordDecision({ type: "outcome.recorded", outcomeId: outcome.outcomeId, source: outcome.source, classifications: outcome.classifications });
    return outcome;
  }
  listOutcomes(options = {}) {
    let rows = readJsonl(this.outcomeLedgerFile());
    if (options.source) rows = rows.filter((o) => o.source === options.source);
    if (options.status) rows = rows.filter((o) => o.signals?.status === options.status);
    if (options.classification) rows = rows.filter((o) => (o.classifications || []).includes(options.classification));
    if (options.limit) rows = rows.slice(-Number(options.limit));
    return rows;
  }
  recordPatterns(patterns = []) {
    const existing = new Set(this.listPatterns().map((p) => `${p.patternId}:${p.fingerprint || ""}`));
    const recorded = [];
    const duplicates = [];
    for (const input of arr(patterns)) {
      const pattern = sanitizeStructured({ observedAt: this.now(), ...input, fingerprint: input.fingerprint || shortHash(input, 16) }, 1200);
      const key = `${pattern.patternId}:${pattern.fingerprint || ""}`;
      if (existing.has(key)) { duplicates.push(pattern); continue; }
      appendJsonl(this.patternLedgerFile(), pattern);
      existing.add(key);
      recorded.push(pattern);
      this.recordDecision({ type: "pattern.recorded", patternId: pattern.patternId, classification: pattern.classification, count: pattern.count });
    }
    return { recorded, duplicates };
  }
  listPatterns(options = {}) {
    let rows = readJsonl(this.patternLedgerFile());
    if (options.classification) rows = rows.filter((p) => p.classification === options.classification);
    if (options.kind) rows = rows.filter((p) => p.kind === options.kind);
    if (options.miner) rows = rows.filter((p) => p.miner === options.miner);
    if (options.limit) rows = rows.slice(-Number(options.limit));
    return rows;
  }
  createProposal(input) {
    const proposal = createProposal(input, { now: this.now() });
    writeJson(this.proposalFile(proposal.proposalId), proposal);
    this.recordDecision({ type: "proposal.created", proposalId: proposal.proposalId, kind: proposal.kind, status: proposal.status });
    return proposal;
  }
  getProposal(idOrLatest) {
    if (!idOrLatest || idOrLatest === "latest") return this.listProposals({ limit: 1 }).at(-1) || null;
    return readJson(this.proposalFile(idOrLatest), null);
  }
  listProposals(options = {}) {
    const dir = path.join(this.root, "proposals");
    let rows = [];
    try { rows = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => readJson(path.join(dir, name), null)).filter(Boolean); }
    catch { rows = []; }
    rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.proposalId).localeCompare(String(b.proposalId)));
    if (options.status) rows = rows.filter((p) => p.status === options.status);
    if (options.kind) rows = rows.filter((p) => p.kind === options.kind);
    if (options.limit) rows = rows.slice(-Number(options.limit));
    return rows;
  }
  reviewProposal(idOrLatest, checks) {
    const current = this.getProposal(idOrLatest);
    if (!current) throw new Error("proposal not found");
    const next = reviewProposal(current, checks, { now: this.now() });
    writeJson(this.proposalFile(next.proposalId), next);
    this.recordDecision({ type: "proposal.reviewed", proposalId: next.proposalId, status: next.status, ready: next.review?.ready });
    return next;
  }
  recordProposalFeedback(proposal, event = {}) {
    if (proposal.status === "applied") {
      return this.recordOutcome({
        source: "proposal",
        task: { summary: `Applied learning proposal ${proposal.proposalId}`, repo: this.cwd },
        summary: `Learning proposal applied through delegated workflow: ${proposal.title}`,
        signals: { status: "succeeded", evidenceLevel: "verification", verificationOk: true, commands: proposal.verificationPlan?.commands || [] },
        artifacts: { evidenceRefs: proposal.applicationResult?.evidenceRefs || event.evidenceRefs || [], changedFiles: proposal.affectedFiles || [] },
        classifications: ["proposal-applied"],
      });
    }
    if (proposal.status === "dismissed") {
      return this.recordOutcome({
        source: "proposal",
        task: { summary: `Dismissed learning proposal ${proposal.proposalId}`, repo: this.cwd },
        summary: `Learning proposal dismissed: ${proposal.review?.dismissReason || event.reason || "dismissed"}`,
        signals: { status: "unknown", evidenceLevel: "claim" },
        artifacts: { evidenceRefs: proposal.evidenceRefs || [], changedFiles: proposal.affectedFiles || [] },
        classifications: ["proposal-dismissed"],
      });
    }
    return null;
  }
  transitionProposal(idOrLatest, event) {
    const current = this.getProposal(idOrLatest);
    if (!current) throw new Error("proposal not found");
    const next = transitionProposal(current, event, { now: this.now() });
    writeJson(this.proposalFile(next.proposalId), next);
    this.recordDecision({ type: `proposal.${event.action || event.type}`, proposalId: next.proposalId, status: next.status });
    if (["apply", "dismiss"].includes(event.action || event.type) && event.recordOutcome !== false) this.recordProposalFeedback(next, event);
    return next;
  }
  applyProposal(idOrLatest, event = {}) {
    const current = this.getProposal(idOrLatest);
    if (!current) throw new Error("proposal not found");
    if (!event.recordApplied && !event.evidenceRefs?.length && !current.verificationResult?.evidenceRefs?.length) return applyProposalDryRun(current);
    const evidenceRefs = sanitizeArray(event.evidenceRefs || current.verificationResult?.evidenceRefs || [], 50, 200);
    return this.transitionProposal(idOrLatest, { action: "apply", ...event, evidenceRefs, verified: event.verified !== false });
  }
  verifyProposal(idOrLatest, input = {}) {
    const current = this.getProposal(idOrLatest);
    if (!current) throw new Error("proposal not found");
    const next = verifyProposalWithEvidence(current, { cwd: this.cwd, now: this.now(), ...input });
    writeJson(this.proposalFile(next.proposalId), next);
    const result = next.verificationResult || {};
    this.recordDecision({ type: "proposal.verified", proposalId: next.proposalId, status: next.status, ok: result.ok, evidenceRefs: result.evidenceRefs || [] });
    if (input.recordOutcome !== false) {
      this.recordOutcome({
        source: "verification",
        task: { summary: `Learning proposal verification ${next.proposalId}`, repo: this.cwd },
        summary: `Learning proposal ${next.proposalId} verification ${result.ok ? "passed" : "failed"}; evidenceRefs=${(result.evidenceRefs || []).length}`,
        signals: { status: result.ok ? "succeeded" : "failed", evidenceLevel: "verification", verificationOk: Boolean(result.ok), commands: next.verificationPlan?.commands || [], toolErrors: (result.commandResults || []).filter((r) => r.ok === false).length },
        artifacts: { evidenceRefs: result.evidenceRefs || [], changedFiles: next.affectedFiles || [] },
      });
    }
    return next;
  }
  decisions(options = {}) {
    const rows = readJsonl(this.decisionsFile());
    return options.limit ? rows.slice(-Number(options.limit)) : rows;
  }
  benchmark(input = {}) {
    const result = runLearningSelfBenchmark(this.cwd, input);
    this.recordDecision({ type: result.ran ? "benchmark.ran" : "benchmark.planned", profile: result.plan.profile, ok: result.ok, evidenceRefs: result.evidenceRefs || [] });
    if (result.ran && input.recordOutcome !== false) {
      this.recordOutcome({
        source: "benchmark",
        task: { summary: "Learning loop self benchmark", repo: this.cwd },
        summary: `Learning loop self benchmark ${result.ok ? "passed" : "failed"}; commands=${result.plan.commands.length}`,
        signals: { status: result.ok ? "succeeded" : "failed", evidenceLevel: "verification", verificationOk: Boolean(result.ok), commands: result.plan.commands, toolErrors: (result.commandResults || []).filter((r) => r.ok === false).length },
        artifacts: { evidenceRefs: result.evidenceRefs || [], changedFiles: ["src/learning-loop.js", ".pi/extensions/learning-loop-coordinator/index.ts"] },
        classifications: ["self-benchmark"],
      });
    }
    return result;
  }
  contextAttribution(input = {}) {
    const result = contextAttributionReport(this.listOutcomes(input), input);
    this.recordDecision({ type: "context-attribution.generated", rows: result.rows.length });
    return result;
  }
  modelRouter(input = {}) {
    const result = adaptiveModelRouterReport(this.listOutcomes(input), input);
    this.recordDecision({ type: "model-router.generated", routes: result.routes.length });
    return result;
  }
  createExperiment(idOrLatest = "latest", input = {}) {
    const proposal = this.getProposal(idOrLatest);
    if (!proposal) throw new Error("proposal not found");
    const plan = experimentPlanFromProposal(proposal, { now: this.now(), ...input });
    const result = input.run || input.runBenchmark ? runExperimentPlan(this.cwd, plan, { now: this.now(), ...input }) : plan;
    writeJson(path.join(this.experimentsDir(), `${result.experimentId}.json`), result);
    this.recordDecision({ type: input.run || input.runBenchmark ? "experiment.evidence_captured" : "experiment.planned", experimentId: result.experimentId, proposalId: proposal.proposalId, evidenceRefs: result.evidenceRefs || [] });
    return result;
  }
  createRefactorProposal(idOrLatest = "latest", input = {}) {
    const proposal = this.getProposal(idOrLatest);
    if (!proposal) throw new Error("proposal not found");
    const result = refactorProposalPacket(this.cwd, proposal, { now: this.now(), ...input });
    this.recordDecision({ type: "refactor-proposal.created", refactorProposalId: result.packet.id, proposalId: proposal.proposalId, file: relState(this.cwd, result.file) });
    return result;
  }
  memorySummary(idOrLatest = "latest", input = {}) {
    const proposal = this.getProposal(idOrLatest) || this.listOutcomes({ limit: 1 }).at(-1);
    if (!proposal) throw new Error("no proposal or outcome found");
    const summary = durableMemorySummary(proposal);
    const candidate = writeMemorySummaryCandidate(this.cwd, summary, { now: this.now(), ...input });
    if (candidate.written) this.recordDecision({ type: "memory-summary.generated", id: summary.id, candidateId: candidate.id, promoteToHermes: summary.promoteToHermes, reviewed: Boolean(input.reviewed), curatorFile: relState(this.cwd, candidate.curatorFile) });
    return { preview: !candidate.written, summary, candidate };
  }
  compoundingRecords({ limit = 1000 } = {}) {
    const safeIds = (values) => [...new Set((values || []).map(String).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)))].slice(0, 64);
    const outcomes = this.listOutcomes({ limit }).map((item) => ({ outcomeId: item.outcomeId, packetId: safeIds(item.artifacts?.traceRefs).find((id) => id.startsWith("execout_")) || null, createdAt: item.createdAt, source: item.source, evidenceClass: COMPOUNDING_EVIDENCE_CLASSES.has(item.evidenceClass) ? item.evidenceClass : "deterministic", cohort: { id: item.cohort?.id || null, arm: item.cohort?.arm || null, sessionIdHash: item.cohort?.sessionIdHash || null }, status: item.signals?.status || "unknown", verificationOk: item.signals?.verificationOk === true ? true : item.signals?.verificationOk === false ? false : null, userCorrectionDetected: item.signals?.userCorrectionDetected === true ? true : item.signals?.userCorrectionDetected === false ? false : null, evidenceIds: safeIds(item.artifacts?.evidenceRefs), classifications: safeIds(item.classifications) }));
    const patterns = this.listPatterns({ limit }).map((item) => ({ patternId: item.patternId, kind: item.kind, outcomeIds: safeIds(item.outcomeIds), evidenceIds: safeIds(item.evidenceRefs), observedAt: item.observedAt || item.createdAt }));
    const proposals = this.listProposals({ limit }).map((item) => {
      const fieldEvidenceClass = COMPOUNDING_EVIDENCE_CLASSES.has(item.fieldEvaluation?.evidenceClass) ? item.fieldEvaluation.evidenceClass : null;
      const fieldEvidenceIds = safeIds(item.fieldEvaluation?.evidenceIds);
      const fieldMeasured = ["exact-version-field", "user-reviewed-gold"].includes(fieldEvidenceClass) && fieldEvidenceIds.length > 0;
      return { proposalId: item.proposalId, status: item.status, evidenceIds: safeIds(item.evidenceRefs), createdAt: item.createdAt, updatedAt: item.updatedAt, reviewReady: item.review?.ready === true, verificationOk: item.verificationResult?.ok === true ? true : item.verificationResult?.ok === false ? false : null, fieldProven: fieldMeasured ? item.fieldEvaluation.fieldProven === true : null, fieldEvidenceClass, fieldEvidenceIds };
    });
    const decisions = this.decisions({ limit }).map((item) => ({ type: item.type, outcomeId: item.outcomeId || null, patternId: item.patternId || null, proposalId: item.proposalId || null, status: item.status || null, ok: item.ok === true ? true : item.ok === false ? false : null, evidenceIds: safeIds(item.evidenceRefs), at: item.at }));
    return { outcomes, patterns, proposals, decisions };
  }
  status() {
    const outcomes = this.listOutcomes();
    const proposals = this.listProposals();
    const patterns = this.listPatterns();
    return {
      root: this.root,
      outcomes: outcomes.length,
      patterns: patterns.length,
      proposals: proposals.length,
      byProposalStatus: proposals.reduce((acc, p) => { acc[p.status] = (acc[p.status] || 0) + 1; return acc; }, {}),
      byClassification: outcomes.flatMap((o) => o.classifications || []).reduce((acc, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {}),
      decisions: this.decisions().length,
    };
  }
}

function historicalTestEdgesFromOutcomes(outcomes = []) {
  const edges = [];
  for (const outcome of outcomes) {
    const sources = outcome.changedFiles || outcome.files || outcome.evidence?.changedFiles || [];
    const tests = outcome.tests || outcome.selectedTests || outcome.evidence?.tests || [];
    for (const source of sources) for (const test of tests) edges.push({ source, entity: source, test, relation: "historical-co-change", confidence: Math.min(0.49, Number(outcome.confidence || 0.35)), freshness: "fresh", gatingSafe: false, revision: outcome.revision || outcome.commit || "historical", evidenceRef: outcome.id });
  }
  return edges.sort((a, b) => String(a.source).localeCompare(String(b.source)) || String(a.test).localeCompare(String(b.test)));
}

module.exports = {
  EVIDENCE_SCORES,
  LearningStore,
  stableStringify,
  hash,
  redactSensitiveText,
  hasSecretLikeText,
  looksLikeFullTranscript,
  createOutcome,
  outcomeRater,
  executionOutcomeToLearningInput,
  rateOutcome,
  classifyOutcome,
  createProposal,
  reviewProposal,
  reviewProposalWithLocalChecks,
  localEvidenceCheck,
  localPrivacyCheck,
  localPolicyCheck,
  localImpactCheck,
  delegatedApplyPlan,
  applyProposalDryRun,
  verificationCommandWords,
  runVerificationCommand,
  verifyProposalWithEvidence,
  learningSelfBenchmarkPlan,
  runLearningSelfBenchmark,
  contextAttributionReport,
  adaptiveModelRouterReport,
  experimentPlanFromProposal,
  runExperimentPlan,
  refactorProposalPacket,
  durableMemorySummary,
  writeMemorySummaryCandidate,
  transitionProposal,
  minePatterns,
  mineFailurePatterns,
  proposeImprovements,
  SAFE_LEARNING_INGEST_SOURCES,
  topologyRunLearningCohort,
  verificationPayload,
  ingestLearningSource,
  ingestLearningSources,
  historicalTestEdgesFromOutcomes,
};
