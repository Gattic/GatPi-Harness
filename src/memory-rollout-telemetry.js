"use strict";

// Passive-telemetry rollout evaluation: every predicate reads records that
// ordinary sessions already produce, so a stage is reachable without a signed
// artifact. Anything missing is `insufficient`, never a pass.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { STAGES, decideStage, emitRolloutEvaluation, rolloutEvent, stageIndex } = require("./project-memory-rollout");
const { scan } = require("./privacy-guard-scan");
const { currentMemorySourceEvidence } = require("./memory-effectiveness-source");

const DAY = 86400000;
const WINDOW_DAYS = 14;
const EVALUATION_CACHE_MS = 5 * 60 * 1000;
const SCAN_DEADLINE_MS = 10000;
const SESSION_HASH = /^[a-f0-9]{16,64}$/;
const CURATION_OUTCOMES = new Set(["success", "timeout", "error"]);
const evaluationCache = new Map();
// Local hash keeps this module out of the trace-observability import cycle
// (trace-observability -> integration-boundary -> project-memory-runtime).
function hashHex(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }

function inWindow(at, nowMs, windowDays) { const t = Date.parse(at); return Number.isFinite(t) && t <= nowMs && t >= nowMs - windowDays * DAY; }
function dayOf(at) { const t = Date.parse(at); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; }
function sortedJson(values) { return JSON.stringify([...(values || [])].map(String).sort()); }
function percentile(values, p) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.ceil(p * ordered.length) - 1);
  return ordered[Math.min(ordered.length - 1, rank)];
}
function verdict(status, reasons, metrics) { return { status, pass: status === "pass", reasons: reasons || [], metrics: metrics || {} }; }
const pass = (metrics) => verdict("pass", [], metrics);
const fail = (reason, metrics) => verdict("fail", [reason], metrics);
const insufficient = (reason, metrics) => verdict("insufficient", [reason], metrics);
/** Session attribution: prefer the writer's hash, otherwise hash the raw id. */
function sessionKey(event) {
  const hashed = String(event?.payload?.sessionIdHash || "");
  if (SESSION_HASH.test(hashed)) return hashed;
  return event?.session_id ? hashHex(event.session_id).slice(0, 16) : null;
}

function deterministic({ sources, nowMs, implementationRevision }) {
  const record = sources.fullSuite;
  if (!record) return insufficient("full-suite-record-missing");
  if (record.ok !== true || record.status !== "succeeded") return fail("full-suite-not-passing");
  if (Number(record.failed) !== 0) return fail("full-suite-failures", { failed: Number(record.failed) });
  const ran = Number(record.testFiles); const discovered = Number(record.discoveredTestFiles);
  if (!Number.isFinite(ran) || !Number.isFinite(discovered) || ran < discovered) return fail("full-suite-partial", { ran, discovered });
  const generatedAt = Date.parse(record.generatedAt);
  if (!Number.isFinite(generatedAt) || nowMs - generatedAt > 7 * DAY) return insufficient("test-evidence-stale", { generatedAt: record.generatedAt });
  if (!implementationRevision || record.sourceRevision !== implementationRevision) return insufficient("revision-mismatch", { record: record.sourceRevision || null, current: implementationRevision || null });
  return pass({ testFiles: ran, generatedAt: record.generatedAt });
}

function permissions({ sources }) {
  const posture = sources.privacy?.permissionPosture;
  if (!posture) return insufficient("permission-posture-unavailable");
  if (posture.compliant !== true) return fail("permissions-not-compliant");
  return pass({ compliant: true });
}

function privacyBaseline({ sources, nowMs, windowDays }) {
  const scan = sources.privacy; const baseline = sources.baseline;
  if (!scan || !Array.isArray(scan.findings)) return insufficient("privacy-scan-unavailable");
  if (scan.complete !== true) return insufficient("privacy-scan-incomplete");
  if (!baseline || !Array.isArray(baseline.recordFileHashes)) return insufficient("privacy-baseline-missing");
  const baselineAt = Date.parse(baseline.baselineAt);
  if (!Number.isFinite(baselineAt)) return insufficient("privacy-baseline-invalid");
  const grandfathered = new Set(baseline.recordFileHashes);
  // The scan already restricts findings to runtime-state roots, so every
  // finding is a record-format finding and `file` is its content handle.
  const newRecordHighs = scan.findings.filter((finding) => finding.severity === "high" && !grandfathered.has(String(finding.file || ""))).length;
  const latestAudit = (sources.diagnostics || [])
    .filter((row) => row.kind === "write" && inWindow(row.at, nowMs, windowDays) && Date.parse(row.at) >= baselineAt)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  // A missing audit row is insufficient: the gate needs evidence taken inside
  // the window, not an absence of findings.
  if (!latestAudit) return insufficient("write-audit-missing");
  if (latestAudit.sanitized !== true) return fail("sanitizer-bypass", { bypassedRecords: Number(latestAudit.bypassedRecords) || 0 });
  if (newRecordHighs > 0) return fail("new-record-highs", { newRecordHighs });
  return pass({ newRecordHighs: 0, inspected: Number(latestAudit.inspected) || 0 });
}

function explicitSaves({ sources, nowMs, windowDays }) {
  // Rows written before the `automatic` provenance field existed carry no flag.
  // Automatic capture always records `automatic: true`, so a missing flag counts
  // as a non-automatic (explicit) save while `automatic === true` stays excluded.
  const saves = (sources.decisions || []).filter((row) => row.action === "saved" && row.automatic !== true && inWindow(row.at, nowMs, windowDays));
  const days = new Set(saves.map((row) => dayOf(row.at)));
  const verified = saves.filter((row) => row.verification === "verified").length;
  if (saves.length < 20) return insufficient("explicit-saves-below-minimum", { saves: saves.length });
  if (days.size < 7) return insufficient("explicit-save-days-below-minimum", { days: days.size });
  const precision = verified / saves.length;
  if (precision < 0.95) return fail("explicit-save-precision-below-bar", { precision });
  return pass({ saves: saves.length, days: days.size, precision });
}

function recallQuality({ sources, nowMs, windowDays }) {
  const completions = (sources.traces || []).filter((event) => event.category === "memory_retrieval" && event.name === "recall.completed" && inWindow(event.timestamp, nowMs, windowDays));
  if (!completions.length) return insufficient("recall-samples-missing");
  const incomplete = completions.filter((event) => !Number.isFinite(event.payload?.durationMs) || !Array.isArray(event.payload?.returnedHashes) || !Number.isInteger(event.payload?.outOfScopeCount) || typeof event.payload?.injected !== "boolean");
  if (incomplete.length) return insufficient("recall-payload-incomplete", { incomplete: incomplete.length });
  const keys = completions.map(sessionKey);
  if (keys.some((key) => !key)) return insufficient("recall-session-unattributed");
  const sessions = new Set(keys); const days = new Set(completions.map((event) => dayOf(event.timestamp)));
  if (completions.length < 30 || sessions.size < 10 || days.size < 14) return insufficient("recall-samples-below-minimum", { completions: completions.length, sessions: sessions.size, days: days.size });
  const latencyP95 = percentile(completions.map((event) => event.payload.durationMs), 0.95);
  if (!(latencyP95 <= 50)) return fail("recall-latency-above-bar", { latencyP95 });
  const outOfScope = completions.filter((event) => event.payload.outOfScopeCount !== 0).length;
  if (outOfScope > 0) return fail("recall-out-of-scope", { outOfScope });
  const perSession = new Map();
  completions.forEach((event, index) => {
    const key = keys[index]; const at = Date.parse(event.timestamp);
    const entry = perSession.get(key) || { hashes: new Set(), firstAt: at };
    for (const hash of event.payload.returnedHashes) entry.hashes.add(hash);
    entry.firstAt = Math.min(entry.firstAt, at);
    perSession.set(key, entry);
  });
  let citedSessions = 0;
  for (const [key, entry] of perSession) {
    const cited = (sources.decisions || []).some((row) => row.sessionIdHash === key && Date.parse(row.at) >= entry.firstAt && (row.evidenceIds || []).some((id) => entry.hashes.has(id)));
    if (cited) citedSessions += 1;
  }
  const citationRate = citedSessions / perSession.size;
  if (citationRate < 0.40) return fail("recall-citation-below-bar", { citationRate });
  let returned = 0; let stale = 0;
  for (const event of completions) {
    const at = Date.parse(event.timestamp);
    for (const hash of event.payload.returnedHashes) {
      returned += 1;
      const superseded = (sources.decisions || []).some((row) => row.action === "superseded" && Date.parse(row.at) > at && Date.parse(row.at) <= at + 7 * DAY && ((row.evidenceIds || []).includes(hash) || row.candidateHash === hash));
      if (superseded) stale += 1;
    }
  }
  const staleRate = returned ? stale / returned : 0;
  if (staleRate > 0.05) return fail("recall-stale-above-bar", { staleRate });
  return pass({ completions: completions.length, sessions: sessions.size, days: days.size, latencyP95, citationRate, staleRate });
}

function shadowAgreement({ sources, nowMs, windowDays }) {
  const outcomes = (sources.traces || []).filter((event) => event.category === "memory_decision" && event.name === "shadow.outcome" && inWindow(event.timestamp, nowMs, windowDays));
  if (!outcomes.length) return insufficient("shadow-outcomes-missing");
  const invalid = outcomes.filter((event) => typeof event.payload?.agreed !== "boolean" || event.payload?.applied !== false || !/^[A-Za-z0-9_.:-]{1,120}$/.test(String(event.payload?.proposalHash || "")));
  if (invalid.length) return insufficient("shadow-payload-incomplete", { invalid: invalid.length });
  const keys = outcomes.map(sessionKey);
  if (keys.some((key) => !key)) return insufficient("shadow-session-unattributed");
  const sessions = new Set(keys); const days = new Set(outcomes.map((event) => dayOf(event.timestamp)));
  if (outcomes.length < 20 || sessions.size < 5 || days.size < 7) return insufficient("shadow-samples-below-minimum", { outcomes: outcomes.length, sessions: sessions.size, days: days.size });
  const agreement = outcomes.filter((event) => event.payload.agreed === true).length / outcomes.length;
  if (agreement < 0.90) return fail("shadow-agreement-below-bar", { agreement });
  return pass({ outcomes: outcomes.length, sessions: sessions.size, days: days.size, agreement });
}

function curation({ sources, nowMs, windowDays }) {
  const previews = (sources.diagnostics || []).filter((row) => row.kind === "settle" && inWindow(row.at, nowMs, windowDays));
  if (previews.length < 14) return insufficient("curation-previews-below-minimum", { previews: previews.length });
  const days = new Set(previews.map((row) => dayOf(row.at)));
  if (days.size < 14) return insufficient("curation-days-below-minimum", { days: days.size });
  const malformed = previews.filter((row) => !Array.isArray(row.candidateHashes) || !row.reasonCounts || typeof row.reasonCounts !== "object" || !Number.isFinite(row.scanned));
  if (malformed.length) return insufficient("curation-preview-incomplete", { malformed: malformed.length });
  const ordered = [...previews].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const unstable = ordered.slice(1).filter((row, index) => sortedJson(row.candidateHashes) !== sortedJson(ordered[index].candidateHashes)).length;
  if (unstable > 0) return fail("curation-candidates-unstable", { unstable });
  const accounted = previews.filter((row) => Object.values(row.reasonCounts).reduce((sum, value) => sum + Number(value || 0), 0) === Number(row.scanned)).length;
  const accounting = accounted / previews.length;
  if (accounting < 0.95) return fail("curation-accounting-below-bar", { accounting });
  const unsafe = previews.filter((row) => row.diagnosticOnly !== true || row.vaultReady !== true).length;
  if (unsafe > 0) return fail("curation-not-diagnostic-only", { unsafe });
  return pass({ previews: previews.length, days: days.size, accounting });
}

function automaticSaves({ sources, nowMs, windowDays }) {
  const autos = (sources.decisions || []).filter((row) => row.action === "saved" && row.automatic === true && row.applied !== false && inWindow(row.at, nowMs, windowDays));
  const days = new Set(autos.map((row) => dayOf(row.at)));
  const sessions = new Set(autos.map((row) => row.sessionIdHash).filter((key) => SESSION_HASH.test(String(key || ""))));
  if (autos.length < 30 || sessions.size < 10 || days.size < 14) return insufficient("automatic-saves-below-minimum", { autos: autos.length, sessions: sessions.size, days: days.size });
  const outcomes = (sources.traces || []).filter((event) => event.category === "memory_curation" && event.name === "curation.completed" && inWindow(event.timestamp, nowMs, windowDays));
  if (!outcomes.length) return insufficient("curation-outcomes-missing");
  const invalid = outcomes.filter((event) => !CURATION_OUTCOMES.has(event.payload?.outcome));
  if (invalid.length) return insufficient("curation-outcome-invalid", { invalid: invalid.length });
  const verified = autos.filter((row) => row.verification === "verified").length;
  const precision = verified / autos.length;
  if (precision < 0.98) return fail("automatic-save-precision-below-bar", { precision });
  const successRate = outcomes.filter((event) => event.payload.outcome === "success").length / outcomes.length;
  const timeoutRate = outcomes.filter((event) => event.payload.outcome === "timeout").length / outcomes.length;
  if (successRate < 0.90) return fail("curation-success-below-bar", { successRate });
  if (timeoutRate > 0.10) return fail("curation-timeout-above-bar", { timeoutRate });
  return pass({ autos: autos.length, sessions: sessions.size, days: days.size, precision, successRate, timeoutRate });
}

const PREDICATES = Object.freeze({ D: deterministic, P: permissions, B: privacyBaseline, S1: explicitSaves, R: recallQuality, SD: shadowAgreement, C: curation, A: automaticSaves });

function stageChain(predicates) {
  const chain = [];
  let lower = true;
  for (const stage of STAGES) {
    const required = stage === "M0" ? ["D", "P", "B"] : stage === "M1" ? [] : stage === "M2" ? ["S1", "R"] : stage === "M3" ? ["SD"] : stage === "M4" ? ["C"] : ["A"];
    lower = lower && required.every((name) => predicates[name]?.pass === true);
    chain.push({ stage, pass: lower });
  }
  return chain;
}

/**
 * Evaluate every predicate and report the highest stage whose chain passes.
 * The accepted stage is decided by `decideStage` in project-memory-rollout, so
 * hysteresis and HOLD have exactly one implementation.
 */
function evaluateRollout({ sources = {}, evaluatedAt = new Date(), windowDays = WINDOW_DAYS, implementationRevision = null } = {}) {
  const nowMs = Date.parse(evaluatedAt instanceof Date ? evaluatedAt.toISOString() : evaluatedAt);
  if (!Number.isFinite(nowMs)) throw new Error("evaluatedAt must be a valid date");
  const ctx = { sources, nowMs, windowDays, implementationRevision };
  const predicates = {};
  for (const [name, fn] of Object.entries(PREDICATES)) {
    try { predicates[name] = fn(ctx); }
    catch (error) { predicates[name] = insufficient("predicate-error", { code: String(error?.code ?? error?.name ?? "error") }); }
  }
  const chain = stageChain(predicates);
  const candidateIndex = chain.reduce((highest, entry) => (entry.pass ? stageIndex(entry.stage) : highest), 0);
  return {
    schemaVersion: 1,
    kind: "rollout.predicates",
    evaluatedAt: new Date(nowMs).toISOString(),
    windowDays,
    implementationRevision,
    predicates,
    chain,
    candidateStage: STAGES[candidateIndex],
    insufficient: Object.entries(predicates).filter(([, value]) => value.status === "insufficient").map(([name]) => name),
  };
}

function readJsonl(file, maxRows = 20000) {
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const rows = text.split(/\n+/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  return rows.length > maxRows ? rows.slice(-maxRows) : rows;
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function readTraceEvents({ traceDir, sinceMs, maxFiles = 200 }) {
  let names; try { names = fs.readdirSync(traceDir); } catch { return []; }
  const events = [];
  for (const name of names.filter((entry) => entry.endsWith(".jsonl") && !entry.startsWith(".")).sort().slice(-maxFiles)) {
    const file = path.join(traceDir, name);
    let stat; try { stat = fs.lstatSync(file); } catch { continue; }
    if (!stat.isFile() || stat.mtimeMs < sinceMs) continue;
    events.push(...readJsonl(file));
  }
  return events;
}

/** Read the records an evaluation needs. `privacy` and `baseline` are injected
 * because the scan and the grandfather list live outside these files. */
function collectRolloutSources({ cwd = process.cwd(), traceDir = path.join(cwd, ".pi", "traces"), stateDir = path.join(cwd, ".pi", "project-memory"), testDir = path.join(cwd, ".pi", "test-runner"), privacy = null, baseline = null, windowDays = WINDOW_DAYS, nowMs = Date.now() } = {}) {
  return {
    traces: readTraceEvents({ traceDir, sinceMs: nowMs - windowDays * DAY }),
    decisions: readJsonl(path.join(stateDir, "decisions.jsonl")),
    diagnostics: readJsonl(path.join(stateDir, "diagnostics.jsonl")),
    fullSuite: readJson(path.join(testDir, "full-latest.json")),
    privacy,
    baseline,
  };
}

function scanPrivacy(cwd, env = process.env) {
  try {
    // Passing no roots keeps the scan on its default scope, which is what marks
    // absent roots as expected rather than as an incomplete explicit scope.
    const configured = Number(env.PI_PROJECT_MEMORY_SCAN_DEADLINE_MS);
    const deadlineMs = Number.isFinite(configured) && configured > 0 ? configured : SCAN_DEADLINE_MS;
    const result = scan(cwd, undefined, { rawSessionPermissions: true, deadlineMs });
    return { findings: result.findings || [], permissionPosture: result.permissionPosture || null, complete: result.coverage?.complete === true };
  } catch { return null; }
}
function loadPrivacyBaseline(cwd) { return readJson(path.join(cwd, ".pi", "privacy-guard", "privacy-baseline.json")); }
/** The last accepted stage is read back from telemetry so hysteresis survives
 * process restarts without a second source of truth. */
function previousFromTraces(traces) {
  const last = (traces || [])
    .filter((event) => event.name === "rollout.evaluated" && STAGES.includes(event.payload?.stage ?? event.payload?.effectiveStage))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .at(-1);
  return last ? { effectiveStage: last.payload.stage ?? last.payload.effectiveStage, consecutiveFailures: Number(last.payload.consecutiveFailures) || 0 } : null;
}

/**
 * Evaluate the rollout from project records. A failing scan, an absent baseline
 * or missing records make the corresponding predicate `insufficient`, which
 * keeps the eligible stage at the floor.
 */
function evaluateProjectMemoryRollout({ cwd = process.cwd(), env = process.env, now = Date.now(), privacy, baseline, refresh = false, cacheMs = EVALUATION_CACHE_MS, implementationRevision, emit } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const revision = implementationRevision || currentMemorySourceEvidence({ implementationRoot: path.resolve(__dirname, "..") }).revision;
  const key = `${path.resolve(cwd)}|${revision}|${env.PI_PROJECT_MEMORY_HOLD || ""}`;
  const cached = evaluationCache.get(key);
  if (cacheMs > 0 && !refresh && cached && nowMs - cached.at <= cacheMs) return { ...cached.evaluation, emission: { emitted: false, reason: "cached" } };
  const sources = collectRolloutSources({ cwd, nowMs, privacy: privacy === undefined ? scanPrivacy(cwd, env) : privacy, baseline: baseline === undefined ? loadPrivacyBaseline(cwd) : baseline });
  const predicates = evaluateRollout({ sources, evaluatedAt: new Date(nowMs), implementationRevision: revision });
  const previous = previousFromTraces(sources.traces);
  const decision = decideStage(predicates, { previous, hold: env.PI_PROJECT_MEMORY_HOLD });
  const record = { ...predicates, kind: "rollout.evaluated", ...decision, previous };
  // One event per accepted evaluation: a cached or repeated read of the same
  // evaluation must not append a duplicate line to the trace log.
  const emission = emitRolloutEvaluation({ cwd, event: rolloutEvent({ evaluation: record, decision, now: nowMs }), emit });
  const evaluation = { ...record, emission };
  if (cacheMs > 0) evaluationCache.set(key, { at: nowMs, evaluation });
  return evaluation;
}

module.exports = { DAY, WINDOW_DAYS, PREDICATES, collectRolloutSources, evaluateProjectMemoryRollout, evaluateRollout, loadPrivacyBaseline, previousFromTraces, scanPrivacy, sessionKey, stageChain };
