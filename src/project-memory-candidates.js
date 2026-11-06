"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sha256, normalizeKey } = require("./project-memory-schema");
const { writePrivateJson } = require("./project-memory-decisions");
const { validateExecutionOutcomePacket } = require("./execution-outcome");
const { scanMemoryContent, redactMemoryText } = require("./memory-content-scanner");
const { classifyProjectMemoryCandidate } = require("./project-memory-policy");
const { appendBoundedJsonl, DIAGNOSTIC_POLICIES } = require("./file-integration-storage");
const { reviewRowKey, REVIEW_RESOLUTION_KIND, REVIEW_RESOLUTION_STATUS } = require("./project-memory-store");

const MAX_RESOLUTION_KEYS = 50;
const MAX_RESOLUTION_REASON_CHARS = 120;
// Candidate memory is appended, so the scan window must cover the newest
// entries; a head window silently stops seeing new durable memory once the
// cognitive surface grows past the bound.
const MAX_SCAN = 2000;

const DURABLE_TAGS = new Set(["architecture", "decision", "constraint", "policy", "invariant", "procedure", "workflow", "risk"]);
const FORBIDDEN_SOURCES = new Set(["verification-adapter", "anchoring-adapter", "pi-message", "pi-input"]);
function metadata(candidate, reason, at = new Date().toISOString()) { return { schemaVersion: 1, fingerprint: `sha256:${sha256(normalizeKey(`${candidate.kind}:${candidate.title}:${candidate.content}`))}`, kind: candidate.kind, titleHash: `sha256:${sha256(normalizeKey(candidate.title))}`, verification: candidate.verification, reason, at }; }
// One bounded metadata-only diagnostics writer for candidate settlement and
// capture attempts. Callers pass hashes and reason codes, never content.
function appendProjectMemoryDiagnostic({ cwd = process.cwd(), rollout = {}, event = {}, clock = () => new Date() } = {}) {
  if (!rollout?.controls?.diagnosticCapture) return null;
  const automaticSave = Boolean(rollout.controls.automaticCapture || rollout.controls.automaticVerifiedUpserts);
  const row = { schemaVersion: 1, sourceVersion: "project-memory-diagnostics-v1", at: new Date(clock()).toISOString(), stage: rollout.effectiveStage || "M0", automaticSave, ...event };
  appendBoundedJsonl(path.join(cwd, ".pi", "project-memory", "diagnostics.jsonl"), row, DIAGNOSTIC_POLICIES.memory);
  return row;
}
function deriveCorrectionCandidate(input = {}) {
  const raw = typeof input === "string" ? input : input.text || input.statement || "";
  const text = String(raw || "").trim();
  if (!/\b(?:actually|correction|correct(?:ion)?|incorrect|wrong|instead)\b/i.test(text)) return { ok: false, outcome: "not-applicable", reason: "no-explicit-correction-signal" };
  const sourceStatement = text.replace(/^.*?\b(?:actually|correction|correct(?:ion)?|incorrect|wrong)\b\s*[:,-]?\s*/i, "");
  if (sourceStatement.trim().length < 8) return { ok: false, outcome: "rejected", reason: "missing-content" };
  const scan = scanMemoryContent(sourceStatement, { maxChars: 2000 });
  if (!scan.safe) return { ok: false, outcome: "rejected", reason: scan.blockingReasons[0], safety: { reasons: scan.reasons, blockingReasons: scan.blockingReasons } };
  const statement = redactMemoryText(sourceStatement, { maxChars: 800 });
  const normalized = normalizeKey(statement);
  const kind = /\b(?:must|never|always|required?|constraint|policy|invariant)\b/.test(normalized) ? "constraint"
    : /\b(?:step|procedure|workflow|first|then|run|process)\b/.test(normalized) ? "procedure"
      : /\b(?:decid|choose|use|adopt|architecture)\b/.test(normalized) ? "decision"
        : /\b(?:risk|bug|failure|crash|unsafe|blocker)\b/.test(normalized) ? "risk" : "history";
  const sourceHash = sha256(normalizeKey(text));
  const sourceFingerprints = [...new Set([...(input.sourceFingerprints || []), `correction:${sourceHash.slice(0, 24)}`])].filter((value) => /^[A-Za-z0-9_.:+-]{1,160}$/.test(String(value))).slice(0, 64);
  const evidenceIds = [...new Set(input.evidenceIds || [])].filter((value) => /^[A-Za-z0-9_.:+-]{1,160}$/.test(String(value))).slice(0, 64);
  return { ok: true, outcome: "candidate", sourceHash: `sha256:${sourceHash}`, candidate: { kind, title: `Correction: ${statement.split(/[.!?\n]/)[0].slice(0, 120)}`, content: statement, verification: "unverified", sourceFingerprints, evidenceIds, expiresAt: input.expiresAt || null } };
}
function classifyCognitiveCandidate(entry) {
  const tags = new Set((entry.tags || []).map((tag) => normalizeKey(tag))); const source = entry.provenance?.source || "unknown";
  if (FORBIDDEN_SOURCES.has(source)) return { eligible: false, reason: "transient" };
  if (!["semantic", "procedural", "strategic"].includes(entry.type)) return { eligible: false, reason: "transient" };
  if (!["verified", "corroborated"].includes(entry.verification)) return { eligible: false, reason: "unverified" };
  if (![...tags].some((tag) => DURABLE_TAGS.has(tag))) return { eligible: false, reason: "policy" };
  const kind = tags.has("decision") || tags.has("architecture") ? "decision" : tags.has("constraint") || tags.has("policy") || tags.has("invariant") ? "constraint" : tags.has("risk") ? "risk" : "procedure";
  return { eligible: true, reason: "verified-durable", candidate: { kind, title: entry.title, content: entry.content, verification: entry.verification, sourceFingerprints: [`cognitive:${entry.id}`], evidenceIds: entry.evidenceIds || [], expiresAt: entry.expiresAt || null, supersedes: entry.supersedes || [], contradicts: entry.contradicts || [] } };
}
class ProjectMemoryCandidatePipeline {
  constructor({ cwd = process.cwd(), projectMemory, rollout = { controls: {} }, maxPerSettle = 20, maxScan = MAX_SCAN, clock = () => new Date() } = {}) { this.cwd = cwd; this.projectMemory = projectMemory; this.rollout = rollout; this.maxPerSettle = maxPerSettle; this.maxScan = maxScan; this.clock = clock; this.stateFile = path.join(cwd, ".pi", "project-memory", "candidate-state.json"); let prior = {}; try { prior = JSON.parse(fs.readFileSync(this.stateFile, "utf8")); } catch {} this.seen = new Set(prior.seenFingerprints || []); this.diagnosticSeen = new Set(prior.diagnosticSeenFingerprints || []); this.pendingExplicit = (prior.pendingExplicit || []).slice(-8); this.pendingCorrections = (prior.pendingCorrections || []).slice(-8); }
  diagnostic(event) { return appendProjectMemoryDiagnostic({ cwd: this.cwd, rollout: this.rollout, event, clock: this.clock }); }
  observePrompt(text) {
    if (!this.rollout?.controls?.candidateCapture && !this.rollout?.controls?.diagnosticCapture) return null;
    const value = String(text || "").trim();
    if (!/\b(?:remember|save)\b[^\n]{0,100}\b(?:this|memory|project|decision|constraint|procedure|preference)\b/i.test(value)) return null;
    const row = { schemaVersion: 1, kind: "explicit-request", promptHash: `sha256:${sha256(normalizeKey(value))}`, at: new Date(this.clock()).toISOString(), status: "requires-explicit-curator" };
    this.diagnostic(row);
    if (this.rollout.controls.candidateCapture) { this.pendingExplicit = [...this.pendingExplicit, row].slice(-8); this.persist(); }
    return row;
  }
  observeCorrection(text) {
    if (!this.rollout?.controls?.candidateCapture && !this.rollout?.controls?.diagnosticCapture) return null;
    const derived = deriveCorrectionCandidate({ text });
    if (!derived.ok) return null;
    const row = { schemaVersion: 1, kind: derived.candidate.kind, sourceHash: derived.sourceHash, at: new Date(this.clock()).toISOString(), status: "requires-explicit-curator-review" };
    this.diagnostic(row);
    if (this.rollout.controls.candidateCapture) { this.pendingCorrections = [...this.pendingCorrections, row].slice(-8); this.persist(); }
    return row;
  }
  captureExecutionReference(input = {}) {
    if (!this.rollout?.controls?.candidateCapture && !this.rollout?.controls?.diagnosticCapture) return null;
    const validation = validateExecutionOutcomePacket(input);
    if (!validation.ok) throw new Error(`execution candidate requires a valid packet: ${validation.issues.join("; ")}`);
    const packet = validation.packet;
    const candidate = {
      schemaVersion: 1,
      candidateId: `pmexec_${packet.packetId.slice("execout_".length)}`,
      source: "execution-outcome",
      packetId: packet.packetId,
      sourceKind: packet.source?.kind,
      runId: packet.source?.runId,
      taskHash: packet.task?.hash,
      outcome: packet.outcome,
      evidenceRefs: (packet.evidenceRefs || []).slice(0, 64),
      artifactRefs: (packet.artifactRefs || []).slice(0, 64).map((artifact) => ({ kind: artifact.kind, id: artifact.id, hash: artifact.hash })),
      settledAt: packet.settledAt,
      status: "requires-explicit-curator-review",
      automaticSave: false,
    };
    this.diagnostic({ kind: "execution-reference", packetId: candidate.packetId, outcome: candidate.outcome, taskHash: candidate.taskHash });
    if (this.rollout.controls.candidateCapture) writePrivateJson(path.join(this.cwd, ".pi", "project-memory", "execution-candidates", `${candidate.candidateId}.json`), candidate);
    return candidate;
  }
  settle(entries = []) {
    if (this.rollout?.controls?.diagnosticCapture) {
      // Promotion and diagnostics keep separate seen sets: a diagnostic-only
      // settle must report a durable candidate once without consuming the
      // fingerprint a later candidate-capture stage needs to promote it.
      const promotionAuthority = Boolean(this.rollout.controls.candidateCapture);
      const seenSet = promotionAuthority ? this.seen : this.diagnosticSeen;
      const reasonCounts = {}; const candidateHashes = []; const observed = entries.slice(Math.max(0, entries.length - this.maxScan)); let alreadySeen = 0;
      for (const entry of observed) {
        const classified = classifyCognitiveCandidate(entry);
        const policy = classified.eligible ? classifyProjectMemoryCandidate(classified.candidate, { automatic: true }) : null;
        const reason = policy?.reason || classified.reason;
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
        if (classified.eligible && policy?.action === "save") {
          const fingerprint = metadata(classified.candidate, reason).fingerprint;
          // Repeats are counted without consuming the new-candidate budget, so a
          // durable candidate later in the scan is never starved by older ones.
          if (this.seen.has(fingerprint) || this.diagnosticSeen.has(fingerprint)) { alreadySeen += 1; continue; }
          if (candidateHashes.length >= this.maxPerSettle) continue;
          seenSet.add(fingerprint);
          candidateHashes.push(fingerprint);
        }
      }
      if (candidateHashes.length > 0) this.persist({ lastDiagnosticSettle: { at: new Date(this.clock()).toISOString(), newCandidates: candidateHashes.length, alreadySeen } });
      this.diagnostic({ kind: "settle", scanned: observed.length, truncated: entries.length > observed.length, candidateHashes, alreadySeen, reasonCounts, vaultReady: this.projectMemory?.enabled === true, diagnosticOnly: !this.rollout.controls.candidateCapture });
    }
    if (!this.rollout?.controls?.candidateCapture || !this.projectMemory?.enabled) return { enabled: false, considered: 0, decisions: [], pendingExplicit: this.pendingExplicit.length };
    const decisions = []; let considered = 0;
    for (const entry of entries) {
      if (considered >= this.maxPerSettle) break; const classified = classifyCognitiveCandidate(entry); if (!classified.eligible) continue;
      const row = metadata(classified.candidate, classified.reason, new Date(this.clock()).toISOString()); if (this.seen.has(row.fingerprint)) continue; this.seen.add(row.fingerprint); considered++;
      const result = this.projectMemory.consider(classified.candidate, { automatic: Boolean(this.rollout.controls.automaticVerifiedUpserts), apply: Boolean(this.rollout.controls.automaticVerifiedUpserts), queueReview: Boolean(this.rollout.controls.reviewQueueWrites && !this.rollout.controls.automaticVerifiedUpserts) });
      decisions.push({ fingerprint: row.fingerprint, kind: row.kind, verification: row.verification, outcome: result.outcome, reason: result.reason || classified.reason, decisionId: result.decision?.decisionId || null });
    }
    this.persist({ lastSettle: { at: new Date(this.clock()).toISOString(), considered, decisions } }); return { enabled: true, considered, decisions, pendingExplicit: this.pendingExplicit.length };
  }
  persist(extra = {}) { const seenFingerprints = [...this.seen].slice(-500); this.seen = new Set(seenFingerprints); const diagnosticSeenFingerprints = [...this.diagnosticSeen].slice(-500); this.diagnosticSeen = new Set(diagnosticSeenFingerprints); const state = { schemaVersion: 1, updatedAt: new Date(this.clock()).toISOString(), seenFingerprints, diagnosticSeenFingerprints, pendingExplicit: this.pendingExplicit, pendingCorrections: this.pendingCorrections, ...extra }; writePrivateJson(this.stateFile, state); return state; }
}
// Review requests have no consumer at M1 because review-queue writes need M4.
// Settling one is a metadata-only diagnostic action: it appends a resolution
// row naming the request key and never writes the vault, promotes a stage or
// mutates a canonical note.
function readDiagnosticReviewRequests(stateDir) {
  const file = path.join(stateDir, "diagnostics.jsonl");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { requests: [], resolvedKeys: new Set() }; }
  const requests = new Map(); const resolvedKeys = new Set();
  for (const line of text.split("\n")) {
    const trimmed = line.trim(); if (!trimmed) continue;
    let row; try { row = JSON.parse(trimmed); } catch { continue; }
    if (row.status === REVIEW_RESOLUTION_STATUS && row.resolves && typeof row.resolves.key === "string") { resolvedKeys.add(row.resolves.key); continue; }
    if (!["requires-explicit-curator-review", "requires-explicit-curator"].includes(row.status)) continue;
    const key = reviewRowKey(row);
    if (!requests.has(key)) requests.set(key, { key, kind: row.kind || "unknown", at: row.at || null, sourceHash: row.sourceHash || null, promptHash: row.promptHash || null, packetId: row.packetId || null });
  }
  return { requests: [...requests.values()], resolvedKeys };
}
function resolveDiagnosticReview({ cwd = process.cwd(), stateDir = path.join(cwd, ".pi", "project-memory"), keys = [], reason = "explicit-curator-review", apply = false, clock = () => new Date() } = {}) {
  const { requests, resolvedKeys } = readDiagnosticReviewRequests(stateDir);
  // The reason is caller-supplied prose that ends up in a bounded diagnostic
  // stream, so cap it here instead of letting an oversized record fail the
  // append with a thrown size error.
  const boundedReason = String(reason || "explicit-curator-review").replace(/[\u0000-\u001f]/g, " ").slice(0, MAX_RESOLUTION_REASON_CHARS);
  const wanted = [...new Set((Array.isArray(keys) ? keys : []).map((key) => String(key || "").trim()).filter(Boolean))].slice(0, MAX_RESOLUTION_KEYS);
  const pending = requests.filter((row) => !resolvedKeys.has(row.key));
  if (!wanted.length) return { ok: false, outcome: "rejected", reason: "review-resolution-keys-required", pending: pending.length };
  const known = new Map(requests.map((row) => [row.key, row]));
  const unknownKeys = wanted.filter((key) => !known.has(key));
  const alreadyResolved = wanted.filter((key) => known.has(key) && resolvedKeys.has(key));
  const target = wanted.filter((key) => known.has(key) && !resolvedKeys.has(key));
  if (!apply) return { ok: true, outcome: "preview", pending: pending.length, resolvable: target.length, unknownKeys, alreadyResolved, target: target.map((key) => known.get(key)) };
  if (!target.length) return { ok: false, outcome: "not-applicable", reason: "no-unresolved-review-requests", unknownKeys, alreadyResolved };
  const at = clock().toISOString();
  const file = path.join(stateDir, "diagnostics.jsonl");
  const written = [];
  for (const key of target) {
    const row = { schemaVersion: 1, sourceVersion: "project-memory-diagnostics-v1", kind: REVIEW_RESOLUTION_KIND, status: REVIEW_RESOLUTION_STATUS, at, diagnosticOnly: true, resolves: { key, kind: known.get(key).kind, requestedAt: known.get(key).at }, reason: boundedReason };
    appendBoundedJsonl(file, row, DIAGNOSTIC_POLICIES.memory);
    written.push(key);
  }
  return { ok: true, outcome: "resolved", resolved: written.length, keys: written, unknownKeys, alreadyResolved, pending: requests.filter((row) => !resolvedKeys.has(row.key) && !written.includes(row.key)).length };
}
function captureAttemptSummary(stateDir) {
  const file = path.join(stateDir, "diagnostics.jsonl");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { rows: 0, byOutcome: {}, byReason: {}, lastAt: null }; }
  const byOutcome = {}; const byReason = {}; let rows = 0; let lastAt = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim(); if (!trimmed) continue;
    let row; try { row = JSON.parse(trimmed); } catch { continue; }
    if (row.kind !== "capture-attempt") continue;
    rows += 1;
    const outcome = String(row.outcome || "unknown"); byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;
    if (row.reason) byReason[row.reason] = (byReason[row.reason] || 0) + 1;
    if (!lastAt || String(row.at || "") > lastAt) lastAt = row.at || lastAt;
  }
  return { rows, byOutcome, byReason, lastAt };
}
module.exports = { DURABLE_TAGS, FORBIDDEN_SOURCES, deriveCorrectionCandidate, classifyCognitiveCandidate, ProjectMemoryCandidatePipeline, appendProjectMemoryDiagnostic, captureAttemptSummary, resolveDiagnosticReview, readDiagnosticReviewRequests };
