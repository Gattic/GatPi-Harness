"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { captureTreeFingerprint, compareTreeFingerprint, treeFingerprintSummary } = require("./tree-fingerprint.js");

function nowIso() { return new Date().toISOString(); }
function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex"); }
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function appendJsonl(file, value) { ensureDir(file); fs.appendFileSync(file, `${JSON.stringify(value)}\n`); }
function readJsonl(file) { try { return fs.readFileSync(file, "utf8").split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } }

function normalize(text) { return String(text || "").toLowerCase().replace(/[^a-z0-9_./:-]+/g, " ").trim(); }
function safeEvidenceId(value) {
  const id = String(value || "").trim();
  return id.length > 0 && id.length <= 160 && /^[A-Za-z0-9_.:-]+$/.test(id) ? id : null;
}
function tokens(text) { return normalize(text).split(/\s+/).filter((x) => x.length > 2); }
function overlap(a, b) {
  const A = new Set(tokens(a)); const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let hit = 0; for (const x of A) if (B.has(x)) hit++;
  return hit / Math.max(1, Math.min(A.size, B.size));
}

const CLAIM_RE = /\b(done|completed|implemented|fixed|resolved|verified|validated|tests? passed|checks? passed|build passed|lint passed|typecheck passed|safe|no regressions?)\b/i;
const PROOF_RE = /\b(test|tests|verified|validation|evidence|command|output|passed|pass|build|lint|typecheck|smoke|check-all|proof)\b/i;

function extractClaims(text) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  if (!source) return [];
  const sentences = source.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.map((sentence, index) => ({ id: `claim_${hash({ sentence, index }).slice(0, 12)}`, text: sentence.trim(), index, requiresEvidence: CLAIM_RE.test(sentence) || PROOF_RE.test(sentence) })).filter((c) => c.requiresEvidence);
}

function evidenceFingerprint(packet = {}) {
  return hash({ source: packet.source, ok: packet.ok, commands: packet.commands, files: packet.files, summary: packet.summary, artifacts: packet.artifacts, metadata: packet.metadata, tree: packet.tree }).slice(0, 16);
}

function visualComparisonMetadata(evidence = {}) {
  return (evidence.visual?.results || []).slice(0, 50).map((row) => ({
    caseId: row.caseId,
    kind: row.kind,
    status: row.status,
    ok: row.ok === true ? true : row.ok === false ? false : null,
    reasonCode: row.reasonCode || null,
    actualDigest: row.actual?.digest || null,
    baselineDigest: row.baseline?.digest || null,
    sourceFingerprint: row.identity?.sourceFingerprint || null,
    captureConfigHash: row.identity?.captureConfigHash || null,
    providerId: row.provider?.providerId || null,
    providerVersion: row.provider?.runtimeVersion || null,
  }));
}
function visualEvidenceReferences(evidence = {}) {
  return (evidence.visual?.results || []).flatMap((row) => [row.actual?.artifactRef, row.actual?.digest && row.caseId ? `visual:${row.caseId}:${String(row.actual.digest).replace(/^sha256:/, "")}` : null]).filter(Boolean).slice(0, 100);
}

function createEvidencePacket(input = {}) {
  const packet = {
    id: input.id || `evidence_${hash({ at: nowIso(), input }).slice(0, 16)}`,
    createdAt: input.createdAt || nowIso(),
    source: input.source || "manual",
    ok: Boolean(input.ok ?? input.evidence?.ok),
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : input.evidence?.confidence ?? 0,
    summary: input.summary || input.evidence?.summary || "",
    commands: input.commands || input.evidence?.commands || input.evidence?.verifiers?.map((v) => v.command ? [v.command, ...(v.args || [])].join(" ") : v.id).filter(Boolean) || [],
    files: input.files || input.evidence?.changeSet?.changedFiles || input.evidence?.changedFiles || [],
    artifacts: input.artifacts || visualEvidenceReferences(input.evidence),
    evidence: input.evidence || undefined,
    metadata: { ...(input.metadata || {}), ...(input.evidence?.visual ? { visualComparisons: visualComparisonMetadata(input.evidence) } : {}) },
    tree: input.tree || undefined,
  };
  packet.fingerprint = evidenceFingerprint(packet);
  return packet;
}

function supportScore(claim, evidence) {
  if (!evidence) return { score: 0, reasons: ["no evidence"] };
  const haystack = [evidence.summary, ...(evidence.commands || []), ...(evidence.files || []), stableStringify(evidence.metadata || {})].join("\n");
  let score = 0;
  const reasons = [];
  if (evidence.ok) { score += 0.38; reasons.push("evidence ok"); }
  if (Number(evidence.confidence) > 0) { const c = Math.min(0.22, Number(evidence.confidence) * 0.22); score += c; reasons.push(`confidence ${Math.round(Number(evidence.confidence) * 100)}%`); }
  const lexical = overlap(claim.text || claim, haystack);
  if (lexical > 0) { score += Math.min(0.25, lexical * 0.4); reasons.push("claim overlaps evidence"); }
  if (/tests? passed|checks? passed|verified|validated/i.test(claim.text || claim) && (evidence.commands || []).length) { score += 0.15; reasons.push("claim expects command evidence and commands exist"); }
  return { score: Math.max(0, Math.min(1, score)), reasons };
}

function evidenceSummary(packet, cwd, currentTree) {
  if (!packet) return null;
  const freshness = cwd ? compareTreeFingerprint(cwd, packet.tree, { current: currentTree }) : { status: packet.tree?.fingerprint ? "unchecked" : "missing-fingerprint", currentTree: false, gatingSafe: false };
  return {
    id: packet.id,
    createdAt: packet.createdAt,
    source: packet.source,
    ok: packet.ok === true,
    confidence: Number(packet.confidence || 0),
    summary: String(packet.summary || "").slice(0, 500),
    commandCount: Array.isArray(packet.commands) ? packet.commands.length : 0,
    fileCount: Array.isArray(packet.files) ? packet.files.length : 0,
    artifactCount: Array.isArray(packet.artifacts) ? packet.artifacts.length : 0,
    fingerprint: packet.fingerprint || null,
    tree: treeFingerprintSummary(packet.tree),
    freshness: { status: freshness.status, currentTree: freshness.currentTree === true, gatingSafe: freshness.gatingSafe === true },
  };
}
function boundedEvidenceDetail(packet, cwd, limit = 20, currentTree) {
  if (!packet) return null;
  const max = Math.max(1, Math.min(50, Number(limit) || 20));
  const verifierRows = Array.isArray(packet.evidence?.verifiers) ? packet.evidence.verifiers.slice(0, max).map((row) => ({ id: row.id, kind: row.kind, ok: row.ok === true, durationMs: Number(row.durationMs || 0), cached: row.cached === true, error: row.error ? String(row.error).slice(0, 300) : null })) : [];
  return {
    ...evidenceSummary(packet, cwd, currentTree),
    commands: (packet.commands || []).slice(0, max),
    files: (packet.files || []).slice(0, max),
    artifacts: (packet.artifacts || []).slice(0, max),
    omitted: {
      commands: Math.max(0, (packet.commands || []).length - max),
      files: Math.max(0, (packet.files || []).length - max),
      artifacts: Math.max(0, (packet.artifacts || []).length - max),
      verifiers: Math.max(0, (packet.evidence?.verifiers || []).length - max),
    },
    verifierEvidence: verifierRows,
  };
}

function bindClaims(text, evidencePackets = [], options = {}) {
  const threshold = options.threshold ?? 0.55;
  const claims = extractClaims(text).map((claim) => {
    const candidates = evidencePackets.map((evidence) => ({ evidenceId: evidence.id, ...supportScore(claim, evidence), evidence })).sort((a, b) => b.score - a.score);
    const best = candidates[0] || { score: 0, reasons: ["no evidence packets"] };
    return { ...claim, supported: best.score >= threshold, supportScore: best.score, evidenceId: best.evidenceId, reasons: best.reasons, candidates: candidates.slice(0, 3).map(({ evidence, ...rest }) => rest) };
  });
  return { ok: claims.every((c) => c.supported), threshold, claims, unsupported: claims.filter((c) => !c.supported) };
}

class EvidenceStore {
  constructor({ cwd = process.cwd(), root = path.join(cwd, ".pi", "evidence-binder") } = {}) {
    this.cwd = cwd;
    this.root = root;
  }
  packetFile(id) {
    const safeId = safeEvidenceId(id);
    if (!safeId) throw new Error("invalid evidence id");
    return path.join(this.root, "packets", `${safeId}.json`);
  }
  ledgerFile() { return path.join(this.root, "evidence.jsonl"); }
  claimLedgerFile() { return path.join(this.root, "claims.jsonl"); }
  saveEvidence(packet) {
    const p = createEvidencePacket({ ...packet, tree: packet?.tree || captureTreeFingerprint(this.cwd) });
    writeJson(this.packetFile(p.id), p);
    appendJsonl(this.ledgerFile(), { at: nowIso(), id: p.id, source: p.source, ok: p.ok, confidence: p.confidence, files: p.files, commands: p.commands, fingerprint: p.fingerprint });
    return p;
  }
  listEvidence({ limit = 50 } = {}) {
    const rows = readJsonl(this.ledgerFile()).slice(-limit);
    return rows.flatMap((row) => {
      try {
        const evidence = readJson(this.packetFile(row.id), null);
        return evidence ? [evidence] : [];
      } catch { return []; }
    });
  }
  latestEvidence() { return this.listEvidence({ limit: 1 })[0] || null; }
  validateEvidenceId(id, { requireOk = true, requireCurrentTree = true, minCreatedAt, expectedFingerprint, includeEvidence = true } = {}) {
    const safeId = safeEvidenceId(id);
    const result = (ok, reason, evidence = null) => ({ ok, reason, id: safeId || null, createdAt: evidence?.createdAt || null, fingerprint: evidence?.fingerprint || null, passing: evidence?.ok === true, ...(includeEvidence ? { evidence } : {}) });
    if (!safeId) return result(false, "invalid-evidence-id");
    const ledger = readJsonl(this.ledgerFile());
    const registered = [...ledger].reverse().find((row) => row?.id === safeId);
    if (!registered) return result(false, "evidence-not-registered");
    const evidence = readJson(this.packetFile(safeId), null);
    if (!evidence || evidence.id !== safeId) return result(false, "evidence-packet-missing");
    if (!evidence.fingerprint || evidence.fingerprint !== registered.fingerprint || evidence.fingerprint !== evidenceFingerprint(evidence)) return result(false, "evidence-fingerprint-mismatch", evidence);
    if (expectedFingerprint && evidence.fingerprint !== expectedFingerprint) return result(false, "evidence-expected-fingerprint-mismatch", evidence);
    if (requireCurrentTree) {
      const freshness = compareTreeFingerprint(this.cwd, evidence.tree);
      if (!freshness.gatingSafe) return result(false, freshness.status, evidence);
    }
    if (minCreatedAt) {
      const minimum = Date.parse(minCreatedAt);
      const created = Date.parse(evidence.createdAt || 0);
      if (!Number.isFinite(minimum) || !Number.isFinite(created) || created < minimum) return result(false, "evidence-predates-goal", evidence);
    }
    if (requireOk && evidence.ok !== true) return result(false, "evidence-not-passing", evidence);
    return result(true, "current-evidence-packet", evidence);
  }
  validateEvidenceIds(ids = [], options = {}) {
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, reason: "completion-evidence-required", results: [] };
    const expected = options.expectedFingerprints || {};
    const results = [...new Set(ids)].map((id) => this.validateEvidenceId(id, { ...options, expectedFingerprint: Object.prototype.hasOwnProperty.call(expected, id) ? expected[id] : undefined, includeEvidence: false }));
    const rejected = results.find((result) => !result.ok);
    return { ok: !rejected, reason: rejected?.reason || "current-passing-evidence", results };
  }
  checkText(text, options = {}) {
    const packets = this.listEvidence({ limit: options.limit || 20 });
    const tree = captureTreeFingerprint(this.cwd);
    const current = packets.filter((packet) => compareTreeFingerprint(this.cwd, packet.tree, { current: tree }).gatingSafe);
    return { ...bindClaims(text, current, options), evidenceCohort: { inspected: packets.length, current: current.length, staleOrUnproven: packets.length - current.length } };
  }
  recordClaimCheck(text, result) {
    const record = { at: nowIso(), text: String(text || "").slice(0, 1000), result };
    appendJsonl(this.claimLedgerFile(), record);
    return record;
  }
  status(options = {}) {
    const limit = Math.max(1, Math.min(20, Number(options.limit) || 5));
    const evidence = this.listEvidence({ limit });
    const claims = readJsonl(this.claimLedgerFile()).slice(-limit).map((row) => ({ at: row.at || null, ok: row.result?.ok === true, claimCount: Number(row.result?.claims?.length || 0), unsupportedCount: Number(row.result?.unsupported?.length || 0) }));
    const latest = evidence.at(-1) || null;
    const currentTree = captureTreeFingerprint(this.cwd);
    const status = {
      evidenceCount: readJsonl(this.ledgerFile()).length,
      currentTree: treeFingerprintSummary(currentTree),
      latest: evidenceSummary(latest, this.cwd, currentTree),
      recentEvidence: evidence.map((packet) => evidenceSummary(packet, this.cwd, currentTree)),
      recentClaims: claims,
      limits: { recentItems: limit, summaryChars: 500, detailedArrayItems: Math.max(1, Math.min(50, Number(options.detailLimit) || 20)) },
    };
    if (options.detail === true) status.latestDetail = boundedEvidenceDetail(latest, this.cwd, options.detailLimit, currentTree);
    return status;
  }
}

function captureVerificationEvidence(cwd, options = {}) {
  const latestFile = path.join(cwd, ".pi", "verification-center", "latest.json");
  const latest = readJson(latestFile, null);
  if (!latest?.evidence) {
    return {
      captured: false,
      ready: false,
      ok: null,
      outcome: "not-applicable",
      status: "not-applicable",
      notApplicable: true,
      reasonCode: "verification-prerequisite-missing",
      code: "verification_evidence_missing",
      message: "No Verification Center evidence is available yet. Run the suggested verification profile, then retry captureVerification.",
      next: { tool: "verification_center", parameters: { operation: "run", profile: "changed" } },
    };
  }
  const freshness = compareTreeFingerprint(cwd, latest.evidence.tree);
  if (!freshness.gatingSafe) {
    return {
      captured: false,
      ready: false,
      ok: null,
      outcome: "not-applicable",
      status: "not-applicable",
      notApplicable: true,
      reasonCode: freshness.status,
      code: "verification_evidence_stale",
      message: `Verification Center evidence is ${freshness.status}. Run verification for the current tree, then retry captureVerification.`,
      currentTree: treeFingerprintSummary(freshness.current),
      evidenceTree: treeFingerprintSummary(latest.evidence.tree),
      next: { tool: "verification_center", parameters: { operation: "run", profile: "changed" } },
    };
  }
  const evidenceStore = options.store || new EvidenceStore({ cwd });
  return evidenceStore.saveEvidence(createEvidencePacket({
    source: "verification-center",
    createdAt: latest.evidence.createdAt || latest.writtenAt,
    evidence: latest.evidence,
    commands: latest.commands,
    files: latest.evidence?.changeSet?.changedFiles,
    tree: latest.evidence.tree,
    artifacts: [`verification:${latest.evidence.id}`, ...visualEvidenceReferences(latest.evidence)],
    metadata: { visualComparisons: visualComparisonMetadata(latest.evidence) },
  }));
}

function formatClaimCheck(result) {
  const lines = [`claim check: ${result.ok ? "supported" : "unsupported"}`, `claims: ${result.claims.length}`, `unsupported: ${result.unsupported.length}`];
  for (const claim of result.claims.slice(0, 8)) lines.push(`- ${claim.supported ? "ok" : "GAP"} ${Math.round(claim.supportScore * 100)}% ${claim.text}${claim.evidenceId ? ` [${claim.evidenceId}]` : ""}`);
  return lines.join("\n");
}

module.exports = { EvidenceStore, createEvidencePacket, evidenceSummary, boundedEvidenceDetail, extractClaims, supportScore, bindClaims, captureVerificationEvidence, formatClaimCheck, visualComparisonMetadata, visualEvidenceReferences };
