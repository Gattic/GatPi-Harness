"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { withStorageLock } = require("./file-integration-storage");
const { storage, reviews, overlayReviews } = require("./extension-opportunity-reviews-store");
const { hash, reviewer, safeEvidenceIds, validateReviewEvidence } = require("./reviewed-evidence");
const FOCUS = Object.freeze({ "run-monitor": "extensions/run-monitor/index.ts", roadmap: ".pi/extensions/roadmap/index.ts", "ast-tools": ".pi/extensions/ast-tools/index.ts" });
// Observational code-tool reviews share storage, not the preregistered pilot's gates or quota.
const CODE_TOOLS = Object.freeze({ codegraph: ".pi/extensions/codegraph/index.ts", semgrep: ".pi/extensions/semgrep/index.ts" });
const ANALYSIS_OUTCOMES = Object.freeze({ "ast-tools": ["correct-localization", "refactor-verified"], codegraph: ["correct-localization", "tests-relevant"], semgrep: ["finding-actionable", "tests-relevant"] });
const MAX_REVIEWS = 180;
function reviewOpportunity(cwd, eventId, input) {
  const { readTelemetryEvents, OPPORTUNITY_TRIGGER_EXTENSIONS } = require("./extension-telemetry");
  const reviewerHash = reviewer(input), evidenceIds = safeEvidenceIds(input.evidenceIds);
  if (!["helpful", "not-helpful"].includes(input.value) || !["displaced", "shell-used", "not-applicable"].includes(input.coreDisplacement)) throw new Error("explicit usefulness and displacement judgments required");
  const row = readTelemetryEvents({ cwd }).find(r => r.eventId === eventId);
  if (!row || row.kind !== "opportunity" || !(FOCUS[row.extension] || CODE_TOOLS[row.extension]) || row.eligibility !== "eligible" || row.sessionKind !== "interactive" || !/^session_[a-f0-9]{24}$/.test(row.sessionToken) || !/^source_[a-f0-9]{16}$/.test(row.sourceFingerprint) || OPPORTUNITY_TRIGGER_EXTENSIONS[row.triggerId] !== row.extension) throw new Error("a real source/session-qualified eligible opportunity is required");
  if (input.value === "helpful" && !row.acted) throw new Error("an unused extension cannot be rated helpful for this opportunity");
  let analysisOutcome = null;
  if (input.analysisOutcome != null) {
    if (!ANALYSIS_OUTCOMES[row.extension]?.includes(input.analysisOutcome.kind) || typeof input.analysisOutcome.passed !== "boolean" || !row.acted) throw new Error("an acted code-tool opportunity and a supported boolean outcome judgment are required");
    analysisOutcome = { kind: input.analysisOutcome.kind, passed: input.analysisOutcome.passed };
  }
  validateReviewEvidence(cwd, evidenceIds, { minCreatedAt: row.timestamp });
  const store = storage(cwd);
  return withStorageLock(store.jsonPath("opportunity-reviews"), () => {
    const prior = reviews(cwd);
    if (prior.some(r => r.eventId === eventId)) throw new Error("opportunity already reviewed");
    const observational = Boolean(CODE_TOOLS[row.extension]);
    if (prior.filter(review => Boolean(review.observational) === observational).length >= MAX_REVIEWS) throw new Error("bounded review cohort complete; inspect results before another cohort");
    const review = { eventId, eventHash: hash(row), reviewerHash, reviewedAt: new Date().toISOString(), evidenceIds, value: input.value, coreDisplacement: input.coreDisplacement, ...(observational ? { observational: true } : {}), ...(analysisOutcome ? { analysisOutcome } : {}) };
    store.writeJson("opportunity-reviews", { schemaVersion: 1, reviews: [...prior, review] });
    return review;
  });
}
function opportunityReviewReport(cwd, { excludeSessionToken } = {}) {
  const { readTelemetryEvents, sourceFingerprintForFile } = require("./extension-telemetry");
  const all = overlayReviews(readTelemetryEvents({ cwd, excludeSessionToken }), cwd);
  const currentSessionExcluded = /^session_[a-f0-9]{24}$/.test(excludeSessionToken || "");
  const result = [];
  for (const [extension, file] of Object.entries(FOCUS)) {
    const sourceFingerprint = sourceFingerprintForFile(path.resolve(__dirname, "..", file));
    const exact = all.filter(r => r.extension === extension && r.sourceFingerprint === sourceFingerprint && r.sessionKind === "interactive");
    const tokenized = exact.filter(r => /^session_[a-f0-9]{24}$/.test(r.sessionToken));
    const eligible = tokenized.filter(r => r.kind === "opportunity" && r.eligibility === "eligible");
    const rated = eligible.filter(r => r.reviewed), helpful = rated.filter(r => r.value === "helpful").length;
    const observedDays = new Set(tokenized.map(r => r.timestamp.slice(0, 10))).size;
    const tokenCoverage = exact.length ? tokenized.length / exact.length : null;
    const sampleSufficient = eligible.length >= 20 && rated.length >= 20;
    const gatingSafe = currentSessionExcluded && observedDays >= 30 && tokenCoverage >= 0.95 && sampleSufficient;
    result.push({ extension, sourceFingerprint, eligible: eligible.length, acted: eligible.filter(r => r.acted).length, reviewed: rated.length, helpful, helpfulRate: rated.length ? helpful / rated.length : null, observedDays, tokenCoverage, currentSessionExcluded, sampleSufficient, gatingSafe, verdict: !gatingSafe ? "insufficient-data" : helpful / rated.length >= 0.8 ? "ready-for-human-decision" : "value-bar-not-met", pending: eligible.filter(r => !r.reviewed).slice(0, 20).map(({ eventId, timestamp, triggerId, acted }) => ({ eventId, timestamp, triggerId, acted })) });
  }
  const codeToolOutcomes = Object.entries({ "ast-tools": FOCUS["ast-tools"], ...CODE_TOOLS }).map(([extension, file]) => {
    const fingerprint = sourceFingerprintForFile(path.resolve(__dirname, "..", file));
    const opportunities = all.filter(row => row.kind === "opportunity" && row.extension === extension && row.sourceFingerprint === fingerprint && row.sessionKind === "interactive" && row.eligibility === "eligible");
    const judgments = opportunities.filter(row => row.reviewed && row.analysisOutcome);
    return { extension, sourceFingerprint: fingerprint, eligible: opportunities.length, reviewed: judgments.length, outcomes: Object.fromEntries(ANALYSIS_OUTCOMES[extension].map(kind => [kind, { reviewed: judgments.filter(row => row.analysisOutcome.kind === kind).length, positive: judgments.filter(row => row.analysisOutcome.kind === kind && row.analysisOutcome.passed).length }])), pending: opportunities.filter(row => !row.reviewed).slice(0, 20).map(({ eventId, triggerId, acted }) => ({ eventId, triggerId, acted })), gatingSafe: false, status: "observational-only" };
  });
  return { experimentId: "exp-extension-opportunity-usefulness-pilot", maxReviews: MAX_REVIEWS, automaticLifecycleChange: false, rows: result, codeToolOutcomes };
}
function observeFixedOpportunity(pi, { extension, version, triggerId, matches, tools, sourceFile }) {
  const { createExtensionTelemetry, contextSessionKind, sourceFingerprintForFile } = require("./extension-telemetry");
  let pending = null;
  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" || event.streamingBehavior || String(event.text || "").startsWith("/")) return;
    flush(ctx);
    pending = matches(String(event.text || "")) ? { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), sessionKind: contextSessionKind(ctx), acted: false } : null;
  });
  pi.on("tool_execution_end", event => { if (pending && tools.includes(event.toolName)) pending.acted = true; });
  const flush = (ctx) => {
    if (!pending) return;
    const row = pending; pending = null;
    const telemetry = createExtensionTelemetry({ cwd: row.cwd, extension, version, sourceFingerprint: sourceFingerprintForFile(sourceFile) });
    telemetry.opportunity(triggerId, "eligible", row.acted, "unknown", "unknown", row.sessionKind, telemetry.sessionToken(row.sessionId));
  };
  pi.on("agent_settled", (_event, ctx) => { if (ctx.isIdle() && !ctx.hasPendingMessages()) flush(ctx); });
  pi.on("session_shutdown", (_event, ctx) => flush(ctx));
}
module.exports = { FOCUS, MAX_REVIEWS, reviewOpportunity, overlayReviews, opportunityReviewReport, observeFixedOpportunity };
