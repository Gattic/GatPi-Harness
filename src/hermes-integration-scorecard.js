"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { validateAgentSkillDraft } = require("./skill-synthesis.js");
const { HERMES_ADVISORY_VERSION } = require("./hermes-advisory.js");
const { COMPOUNDING_SCORECARD_DIRECTORY } = require("./compounding-effectiveness.js");

const HERMES_INTEGRATION_SCORECARD_VERSION = 1;
const DEFAULT_BARS = Object.freeze({ assistant: { attempts: 30, sessions: 10, observedDays: 14, acceptanceRate: 0.70, schemaValidity: 0.95, p95DurationMs: 10_000, privacyViolations: 0 }, memory: { curations: 10, successRate: 0.80, timeoutRate: 0.10, promotionPrecision: 0.90, privacyViolations: 0 }, skills: { eligibleClusters: 1, validDraftRate: 1, unauthorizedPromotions: 0, c5Required: true }, authority: { automaticMutationAllowed: false } });
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function readJsonl(file) { try { return fs.readFileSync(file, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } }
function percentile(values, p) { const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b); return rows.length ? rows[Math.min(rows.length - 1, Math.max(0, Math.ceil(rows.length * p) - 1))] : null; }
function rate(numerator, denominator) { return denominator ? numerator / denominator : null; }
function daysObserved(events) { const values = events.map((event) => Date.parse(event.at)).filter(Number.isFinite).sort((a, b) => a - b); return values.length > 1 ? (values.at(-1) - values[0]) / 86_400_000 : values.length ? 1 : 0; }
function gate(observed, checks) { const reasons = checks.filter((check) => !check.ok).map((check) => check.reason); return { status: reasons.length ? (checks.some((check) => check.insufficient) ? "insufficient-data" : "fail") : "pass", reasons, observed }; }
function mergeEvents(cwd) { const files = [path.join(cwd, ".pi", "hermes-advisory", "events.jsonl"), path.join(cwd, ".pi", "cognitive-automation", "hermes-advisory", "events.jsonl")]; const seen = new Set(); return files.flatMap(readJsonl).filter((row) => { const key = `${row.receiptId}:${row.outcome}:${row.at}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function skillCandidates(cwd, sourceVersion) {
  const root = path.join(cwd, ".pi", "hermes-skill-candidates"); let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return []; }
  return entries.map((entry) => { const dir = path.join(root, entry.name); const provenance = readJson(path.join(dir, "provenance.json"), {}); let valid = false; let errorCode = null; try { const markdown = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"); const frontmatter = markdown.match(/^---\n([\s\S]*?)\n---/); const name = frontmatter?.[1]?.match(/(?:^|\n)name:\s*([^\n]+)/)?.[1]?.trim(); const description = frontmatter?.[1]?.match(/(?:^|\n)description:\s*([^\n]+)/)?.[1]?.trim(); validateAgentSkillDraft({ schemaVersion: 1, name, description, skillMarkdown: markdown }); valid = true; } catch (error) { errorCode = error?.code || "invalid-draft"; } return { candidateId: entry.name, valid, status: provenance.status || "quarantined", promoted: provenance.status === "promoted", promotionAuthorized: provenance.promotion?.authority === "explicit-current-user", errorCode, createdAt: provenance.createdAt || null, receiptId: provenance.hermesReceiptId || null, sourceVersion: provenance.hermesSourceVersion || null, exactVersion: provenance.hermesSourceVersion === sourceVersion }; });
}
function buildHermesIntegrationScorecard({ cwd = process.cwd(), bars = DEFAULT_BARS, generatedAt = new Date().toISOString(), advisorySourceVersion = HERMES_ADVISORY_VERSION } = {}) {
  cwd = path.resolve(cwd);
  const events = mergeEvents(cwd);
  const exact = events.filter((event) => event.sourceVersion === advisorySourceVersion && event.identityKey);
  const assistantOps = new Set(["plan", "review", "decide", "summarizeEvidence", "promptSuggestion"]);
  const assistantEligible = exact.filter((event) => assistantOps.has(event.operation) && event.outcome === "eligible");
  const assistant = exact.filter((event) => assistantOps.has(event.operation) && ["succeeded", "failed", "timed-out", "cancelled"].includes(event.outcome));
  const assistantSucceeded = assistant.filter((event) => event.outcome === "succeeded");
  const assistantReceiptIds = new Set(assistantSucceeded.map((event) => event.receiptId));
  const dispositionByReceipt = new Map();
  for (const event of events) if (["accepted", "rejected"].includes(event.outcome) && assistantReceiptIds.has(event.receiptId)) dispositionByReceipt.set(event.receiptId, event);
  const dispositions = [...dispositionByReceipt.values()];
  const assistantObserved = { eligible: assistantEligible.length, attempts: assistant.length, succeeded: assistantSucceeded.length, sessions: new Set(assistant.map((event) => event.sessionHash).filter(Boolean)).size, observedDays: daysObserved(assistant), acceptanceRate: rate(dispositions.filter((event) => event.accepted === true).length, dispositions.length), dispositionCount: dispositions.length, schemaValidity: rate(assistant.filter((event) => event.schemaValid).length, assistant.length), p95DurationMs: percentile(assistant.map((event) => event.durationMs), 0.95), privacyViolations: exact.filter((event) => assistantOps.has(event.operation)).reduce((sum, event) => sum + Number(event.privacyViolations || 0), 0) };
  const assistantGate = gate(assistantObserved, [
    { ok: assistantObserved.attempts >= bars.assistant.attempts, reason: `attempts-below-${bars.assistant.attempts}`, insufficient: true },
    { ok: assistantObserved.sessions >= bars.assistant.sessions, reason: `sessions-below-${bars.assistant.sessions}`, insufficient: true },
    { ok: assistantObserved.observedDays >= bars.assistant.observedDays, reason: `observed-days-below-${bars.assistant.observedDays}`, insufficient: true },
    { ok: assistantObserved.acceptanceRate != null && assistantObserved.acceptanceRate >= bars.assistant.acceptanceRate, reason: assistantObserved.acceptanceRate == null ? "acceptance-unmeasured" : `acceptance-below-${bars.assistant.acceptanceRate}`, insufficient: assistantObserved.acceptanceRate == null },
    { ok: assistantObserved.schemaValidity != null && assistantObserved.schemaValidity >= bars.assistant.schemaValidity, reason: "schema-validity-below-bar", insufficient: assistantObserved.schemaValidity == null },
    { ok: assistantObserved.p95DurationMs != null && assistantObserved.p95DurationMs <= bars.assistant.p95DurationMs, reason: "latency-p95-above-bar", insufficient: assistantObserved.p95DurationMs == null },
    { ok: assistantObserved.privacyViolations === bars.assistant.privacyViolations, reason: "assistant-privacy-violation" },
  ]);

  const curationEligible = exact.filter((event) => event.operation === "curateCandidate" && event.outcome === "eligible");
  const curations = exact.filter((event) => event.operation === "curateCandidate" && ["succeeded", "failed", "timed-out", "cancelled"].includes(event.outcome));
  const obsidianState = readJson(path.join(cwd, ".pi", "obsidian", "state.json"), {});
  const obsidianEvents = [...readJsonl(path.join(cwd, ".pi", "obsidian", "events.jsonl")), ...(Array.isArray(obsidianState.events) ? obsidianState.events : [])].sort((left, right) => Date.parse(left.at || 0) - Date.parse(right.at || 0));
  const curationReceiptIds = new Set(curations.filter((event) => event.outcome === "succeeded").map((event) => event.receiptId));
  const reviewByReceipt = new Map();
  for (const event of obsidianEvents) if (event.operation === "hermes-review-outcome" && event.receiptBound === true && curationReceiptIds.has(event.curationReceiptId)) reviewByReceipt.set(event.curationReceiptId, event);
  const reviewOutcomes = [...reviewByReceipt.values()];
  const reviewedAccepted = reviewOutcomes.filter((event) => event.decision === "accept").length;
  const memoryObserved = { eligible: curationEligible.length, curations: curations.length, successRate: rate(curations.filter((event) => event.outcome === "succeeded").length, curations.length), timeoutRate: rate(curations.filter((event) => event.outcome === "timed-out" || event.category === "timeout").length, curations.length), reviewedCandidates: reviewOutcomes.length, promotionPrecision: rate(reviewedAccepted, reviewOutcomes.length), privacyViolations: exact.filter((event) => event.operation === "curateCandidate").reduce((sum, event) => sum + Number(event.privacyViolations || 0), 0), canonicalAuthority: "obsidian-project-memory", hermesOwnsCanonicalMemory: false };
  const memoryGate = gate(memoryObserved, [
    { ok: memoryObserved.curations >= bars.memory.curations, reason: `curations-below-${bars.memory.curations}`, insufficient: true },
    { ok: memoryObserved.successRate != null && memoryObserved.successRate >= bars.memory.successRate, reason: "curation-success-below-bar", insufficient: memoryObserved.successRate == null },
    { ok: memoryObserved.timeoutRate != null && memoryObserved.timeoutRate <= bars.memory.timeoutRate, reason: "curation-timeout-above-bar", insufficient: memoryObserved.timeoutRate == null },
    { ok: memoryObserved.reviewedCandidates >= Math.ceil(bars.memory.curations * bars.memory.successRate), reason: `reviewed-candidates-below-${Math.ceil(bars.memory.curations * bars.memory.successRate)}`, insufficient: true },
    { ok: memoryObserved.promotionPrecision != null && memoryObserved.promotionPrecision >= bars.memory.promotionPrecision, reason: memoryObserved.promotionPrecision == null ? "promotion-precision-unmeasured" : "promotion-precision-below-bar", insufficient: memoryObserved.promotionPrecision == null },
    { ok: memoryObserved.privacyViolations === bars.memory.privacyViolations, reason: "memory-privacy-violation" },
  ]);

  const candidates = skillCandidates(cwd, advisorySourceVersion).filter((candidate) => candidate.exactVersion);
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const skillEvents = readJsonl(path.join(cwd, ".pi", "cognitive-automation", "skills", "metrics.jsonl")).filter((event) => event.type === "skill.hermes_draft" && candidateById.get(event.candidateId)?.receiptId === event.receiptId);
  const compounding = readJson(path.join(cwd, COMPOUNDING_SCORECARD_DIRECTORY, "latest.json"), {});
  const c5Status = compounding?.gates?.C5?.status || "NULL-RESULT";
  const skillObserved = { eligibleClustersDrafted: skillEvents.length, candidates: candidates.length, validDraftRate: rate(candidates.filter((candidate) => candidate.valid).length, candidates.length), promoted: candidates.filter((candidate) => candidate.promoted).length, unauthorizedPromotions: candidates.filter((candidate) => candidate.promoted && !candidate.promotionAuthorized).length, c5Status };
  const skillGate = gate(skillObserved, [
    { ok: skillObserved.eligibleClustersDrafted >= bars.skills.eligibleClusters, reason: "no-eligible-cluster-drafts", insufficient: true },
    { ok: skillObserved.validDraftRate != null && skillObserved.validDraftRate >= bars.skills.validDraftRate, reason: skillObserved.validDraftRate == null ? "draft-validity-unmeasured" : "draft-validity-below-bar", insufficient: skillObserved.validDraftRate == null },
    { ok: skillObserved.unauthorizedPromotions === bars.skills.unauthorizedPromotions, reason: "unauthorized-skill-promotion" },
    { ok: !bars.skills.c5Required || c5Status === "pass", reason: c5Status === "NULL-RESULT" ? "C5-NULL-RESULT" : "C5-not-passed", insufficient: c5Status === "NULL-RESULT" },
  ]);

  const gates = { assistant: assistantGate, memory: memoryGate, skills: skillGate };
  const allPassed = Object.values(gates).every((value) => value.status === "pass");
  const scorecard = { schemaVersion: HERMES_INTEGRATION_SCORECARD_VERSION, generatedAt, sourceVersion: "hermes-integration-scorecard-2026-10-09.1", evidenceQualification: { advisorySourceVersion, exactVersionEvents: exact.length, onlyQualifiedDenominators: true, assistantFieldEvidence: assistantGate.status, memoryFieldEvidence: memoryGate.status, skillFieldEvidence: skillGate.status }, bars, gates, authority: { providerReadinessIsNotRolloutAuthorization: true, advisoryOperationsAllowedOnlyWithCurrentProof: true, canonicalMemoryOwner: "obsidian-project-memory", hermesCanApproveInstallPublish: false, automaticRoutingAllowed: false, automaticRoutingReason: "E3-NULL-RESULT", automaticCanonicalPromotionAllowed: false, automaticSkillDraftAllowed: allPassed && c5Status === "pass", automaticMutationAllowed: false }, experimentStatus: { E3ParallelEvidence: "NULL-RESULT", C5MemoryLearning: c5Status }, decision: allPassed ? "advisory-field-gates-passed-manual-only" : "NO-GO-DEFERRED", privacy: { transcriptExported: false, privateReasoningExported: false, rawToolOutputExported: false, commandArgumentsExported: false, absolutePathsExported: false, recordedViolations: assistantObserved.privacyViolations + memoryObserved.privacyViolations }, candidates: { skill: candidates.map(({ candidateId, valid, status, promoted, errorCode }) => ({ candidateId, valid, status, promoted, errorCode })) } };
  scorecard.scorecardHash = `sha256:${crypto.createHash("sha256").update(JSON.stringify(scorecard)).digest("hex")}`;
  return scorecard;
}
function writeHermesIntegrationScorecard({ cwd = process.cwd(), output = path.join(cwd, ".pi", "hermes-advisory", "scorecard.json"), ...options } = {}) { const card = buildHermesIntegrationScorecard({ cwd, ...options }); fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); fs.writeFileSync(output, `${JSON.stringify(card, null, 2)}\n`, { mode: 0o600 }); fs.chmodSync(output, 0o600); return { output, card }; }

module.exports = { HERMES_INTEGRATION_SCORECARD_VERSION, DEFAULT_BARS, buildHermesIntegrationScorecard, writeHermesIntegrationScorecard };
