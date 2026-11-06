#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createExtensionTelemetry, sourceFingerprintForFile, readExtensionTelemetry } = require("../src/extension-telemetry");
const { reviewOpportunity, opportunityReviewReport, observeFixedOpportunity } = require("../src/extension-opportunity-review");
const { EvidenceStore } = require("../src/evidence-binder");
const { tmpFixture } = require("./helpers/tmp-fixture");
const root = tmpFixture("opportunity-review-test-");
try {
  const evidence = new EvidenceStore({ cwd: root });
  const source = path.join(__dirname, "../extensions/run-monitor/index.ts");
  let now = Date.now() - 31 * 86400000;
  const recorder = createExtensionTelemetry({ cwd: root, extension: "run-monitor", version: "fixture", sourceFingerprint: sourceFingerprintForFile(source), clock: () => new Date(now).toISOString() });
  const excluded = recorder.sessionToken("CURRENT_PRIVATE_SESSION");
  for (let i = 0; i < 30; i++) {
    const session = recorder.sessionToken(`PRIVATE_SESSION_${i}`);
    const row = recorder.opportunity("managed-long-run-monitor-intent", "eligible", true, "unknown", "unknown", "interactive", session).event;
    assert(row?.eventId);
    const proof = evidence.saveEvidence({ id: `evidence_opportunity_${i}`, createdAt: new Date(now + 1).toISOString(), ok: true, summary: "Fixture review support" });
    const input = { reviewer: { kind: "human", id: "PRIVATE_REVIEWER" }, value: "helpful", coreDisplacement: "displaced", evidenceIds: [proof.id] };
    if (!i) {
      assert.throws(() => reviewOpportunity(root, row.eventId, { ...input, reviewer: { kind: "model", id: "self" } }), /human/);
      assert.throws(() => reviewOpportunity(root, row.eventId, { ...input, evidenceIds: ["missing"] }), /registered review evidence/);
    }
    reviewOpportunity(root, row.eventId, input);
    assert.throws(() => reviewOpportunity(root, row.eventId, input), /already reviewed/);
    now += 86400000;
  }
  recorder.opportunity("managed-long-run-monitor-intent", "eligible", false, "unknown", "unknown", "interactive", excluded);
  const all = readExtensionTelemetry({ cwd: root });
  assert.equal(all.opportunities.eligible, 31); assert.equal(all.opportunities.valued, 30, "reviews do not double-count opportunities");
  assert(all.opportunities.rows.every(r => r.sourceFingerprint), "aggregation retains source identities");
  const report = opportunityReviewReport(root, { excludeSessionToken: excluded });
  const row = report.rows.find(r => r.extension === "run-monitor");
  assert.equal(row.eligible, 30); assert.equal(row.reviewed, 30); assert.equal(row.observedDays, 30);
  assert.equal(row.gatingSafe, true); assert.equal(row.verdict, "ready-for-human-decision");
  assert.equal(report.automaticLifecycleChange, false);
  assert.equal(opportunityReviewReport(root).rows[0].gatingSafe, false, "current-session exclusion is required");
  const other = createExtensionTelemetry({ cwd: root, extension: "run-monitor", version: "old", sourceFingerprint: "source_aaaaaaaaaaaaaaaa", clock: () => new Date(now).toISOString() });
  other.opportunity("managed-long-run-monitor-intent", "eligible", true, "unknown", "unknown", "interactive", other.sessionToken("old"));
  assert.equal(opportunityReviewReport(root, { excludeSessionToken: excluded }).rows[0].eligible, 30, "old-source opportunities cannot qualify current source");
  const handlers = new Map(); const pi = { on(name, fn) { handlers.set(name, fn); } };
  observeFixedOpportunity(pi, { extension: "ast-tools", version: "fixture", triggerId: "semantic-edit-intent", sourceFile: path.join(__dirname, "../.pi/extensions/ast-tools/index.ts"), tools: ["ast_refactor"], matches: text => /refactor/.test(text) });
  const ctx = { cwd: root, hasUI: true, sessionManager: { getSessionId: () => "structural" }, isIdle: () => true, hasPendingMessages: () => false };
  handlers.get("input")({ source: "extension", text: "refactor PRIVATE_PROMPT" }, ctx);
  handlers.get("agent_settled")({}, ctx);
  assert.equal(readExtensionTelemetry({ cwd: root }).opportunities.eligible, 32);
  handlers.get("input")({ source: "interactive", text: "refactor PRIVATE_PROMPT" }, ctx);
  handlers.get("tool_execution_end")({ toolName: "ast_refactor" });
  handlers.get("agent_settled")({}, ctx); handlers.get("agent_settled")({}, ctx);
  assert.equal(readExtensionTelemetry({ cwd: root }).opportunities.eligible, 33, "one genuine task produces one opportunity despite repeated settlement");
  handlers.get("input")({ source: "interactive", text: "refactor interrupted task" }, ctx);
  handlers.get("input")({ source: "interactive", text: "unrelated next task" }, ctx);
  assert.equal(readExtensionTelemetry({ cwd: root }).opportunities.eligible, 34, "an interrupted eligible task is retained rather than silently dropped");
  const scanner = createExtensionTelemetry({ cwd: root, extension: "semgrep", version: "fixture", sourceFingerprint: sourceFingerprintForFile(path.join(__dirname, "../.pi/extensions/semgrep/index.ts")), clock: () => new Date(now).toISOString() });
  const scanOpportunity = scanner.opportunity("security-scan-intent", "eligible", true, "unknown", "unknown", "interactive", scanner.sessionToken("scanner")).event;
  const scanProof = evidence.saveEvidence({ id: "evidence_scan_review", createdAt: new Date(now + 1).toISOString(), ok: true, summary: "Fixture finding review" });
  const scanReview = { reviewer: { kind: "human", id: "PRIVATE_REVIEWER" }, value: "helpful", coreDisplacement: "not-applicable", evidenceIds: [scanProof.id], analysisOutcome: { kind: "finding-actionable", passed: true } };
  assert.throws(() => reviewOpportunity(root, scanOpportunity.eventId, { ...scanReview, analysisOutcome: { kind: "transport-success", passed: true } }), /supported boolean outcome/);
  reviewOpportunity(root, scanOpportunity.eventId, scanReview);
  const reviewed = opportunityReviewReport(root, { excludeSessionToken: excluded });
  assert.equal(reviewed.rows.length, 3, "the preregistered pilot scope is unchanged");
  const scanOutcomes = reviewed.codeToolOutcomes.find(row => row.extension === "semgrep");
  assert.deepEqual(scanOutcomes.outcomes["finding-actionable"], { reviewed: 1, positive: 1 });
  assert.equal(scanOutcomes.gatingSafe, false, "observational code-tool judgments never promote a provider");
  const saved = fs.readFileSync(path.join(root, ".pi/extension-telemetry/opportunity-reviews.json"), "utf8") + fs.readFileSync(path.join(root, ".pi/extension-telemetry/events.jsonl"), "utf8");
  for (const marker of ["PRIVATE_SESSION", "PRIVATE_REVIEWER", "PRIVATE_PROMPT", root]) assert(!saved.includes(marker));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("extension opportunity review tests passed");
