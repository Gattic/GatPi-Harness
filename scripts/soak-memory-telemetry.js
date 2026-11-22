#!/usr/bin/env node
"use strict";
/**
 * Deterministic soak fixture for the passive memory-telemetry gates.
 *
 * It drives real `pi -p` sessions with PI_COGNITIVE_HEADLESS_INJECT=1 and a
 * fixed PI_TRACE_DIR, then fills the same fixture with deterministic recall and
 * explicit-save samples written through the production writers
 * (createTraceRuntime, recallTelemetryPayload, ProjectMemoryStore). Every write
 * stays inside the fixture root; production `.pi` state is only read.
 *
 * The output is soak evidence, not rollout evidence: a promotion still requires
 * ordinary sessions to produce the same counts on their own.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const { recallTelemetryPayload } = require(path.join(REPO, "src", "project-memory-recall"));
const { createTraceRuntime } = require(path.join(REPO, "src", "trace-observability"));
const { ProjectMemoryStore } = require(path.join(REPO, "src", "project-memory-store"));
const { ProjectMemoryDecisionStore, appendPrivate } = require(path.join(REPO, "src", "project-memory-decisions"));
const { recordWriteAudit } = require(path.join(REPO, "src", "project-memory-write-audit"));
const { collectRolloutSources, evaluateRollout, scanPrivacy, loadPrivacyBaseline } = require(path.join(REPO, "src", "memory-rollout-telemetry"));
const { currentMemorySourceEvidence } = require(path.join(REPO, "src", "memory-effectiveness-source"));

const DAY = 86400000;
const SESSION_HASH = /^[a-f0-9]{16,64}$/;
const CURATION_OUTCOMES = new Set(["success", "timeout", "error"]);

function hashHex(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function distribute(total, buckets) { const base = Math.floor(total / buckets); const extra = total % buckets; return Array.from({ length: buckets }, (_, index) => base + (index < extra ? 1 : 0)); }
function dayStart(ms) { const date = new Date(ms); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()); }
function inWindow(at, nowMs, windowDays) { const t = Date.parse(at); return Number.isFinite(t) && t <= nowMs && t >= nowMs - windowDays * DAY; }
function dayOf(at) { const t = Date.parse(at); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; }
function sortedJson(values) { return JSON.stringify([...(values || [])].map(String).sort()); }
function percentile(values, p) { if (!values.length) return null; const ordered = [...values].sort((a, b) => a - b); const rank = Math.max(0, Math.ceil(p * ordered.length) - 1); return ordered[Math.min(ordered.length - 1, rank)]; }

function parseArgs(argv) {
  const args = { root: path.join(REPO, ".pi", "soak", "memory-telemetry"), days: 14, sessions: 14, completions: 30, saves: 20, saveDays: 7, legacySaves: 21, legacyDays: 30, shadowOutcomes: 21, shadowDays: 7, realRuns: 2, seed: 1337, piCwd: null, baselineCwd: path.resolve(REPO, "..", ".."), skipReal: false, quiet: false };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i]; const value = argv[i + 1];
    if (key === "--skip-real") { args.skipReal = true; continue; }
    if (key === "--quiet") { args.quiet = true; continue; }
    if (!value || value.startsWith("--")) continue;
    if (key === "--root") args.root = path.resolve(value);
    else if (key === "--days") args.days = Number(value);
    else if (key === "--sessions") args.sessions = Number(value);
    else if (key === "--completions") args.completions = Number(value);
    else if (key === "--saves") args.saves = Number(value);
    else if (key === "--save-days") args.saveDays = Number(value);
    else if (key === "--legacy-saves") args.legacySaves = Number(value);
    else if (key === "--legacy-days") args.legacyDays = Number(value);
    else if (key === "--shadow-outcomes") args.shadowOutcomes = Number(value);
    else if (key === "--shadow-days") args.shadowDays = Number(value);
    else if (key === "--real-runs") args.realRuns = Number(value);
    else if (key === "--seed") args.seed = Number(value);
    else if (key === "--pi-cwd") args.piCwd = path.resolve(value);
    else if (key === "--baseline-cwd") args.baselineCwd = path.resolve(value);
    else continue;
    i++;
  }
  return args;
}

function assertSafeRoot(root) {
  const soakRoot = path.join(REPO, ".pi", "soak");
  const tmpRoot = os.tmpdir();
  const inside = (base) => root === base || root.startsWith(`${base}${path.sep}`);
  if (!inside(soakRoot) && !inside(tmpRoot)) throw new Error(`refusing fixture root outside .pi/soak or ${tmpRoot}: ${root}`);
  if (root === REPO || root === path.join(REPO, ".pi") || root === path.join(REPO, ".pi", "traces") || root === path.join(REPO, ".pi", "project-memory")) throw new Error(`refusing production path as fixture root: ${root}`);
}

function copyIfPresent(from, to) { try { fs.copyFileSync(from, to); return true; } catch { return false; } }

function runPiProbes({ count, cwd, traceDir }) {
  const results = [];
  for (let index = 0; index < count; index++) {
    const started = Date.now();
    const run = spawnSync("pi", ["-p", "-a", "--no-tools", "--mode", "text", `Reply with exactly: soak recall ${index + 1}`], {
      cwd,
      env: { ...process.env, PI_COGNITIVE_HEADLESS_INJECT: "1", PI_TRACE_CAPTURE_PAYLOADS: "1", PI_TRACE_DIR: traceDir, PI_TRACE_MAX_TOTAL_BYTES: String(1 << 30) },
      encoding: "utf8",
      timeout: 240000,
    });
    results.push({ index, status: run.status, durationMs: Date.now() - started, stderrTail: String(run.stderr || "").split("\n").filter(Boolean).slice(-2).join(" | ") });
  }
  return results;
}

function countRecallEvents(traceDir, sinceMs) {
  let count = 0; const sessions = new Set();
  let names = [];
  try { names = fs.readdirSync(traceDir).filter((name) => name.endsWith(".jsonl")); } catch { return { count, sessions }; }
  for (const name of names) {
    const file = path.join(traceDir, name);
    let text; try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split(/\n+/)) {
      if (!line) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.category !== "memory_retrieval" || event.name !== "recall.completed") continue;
      if (Date.parse(event.timestamp) < sinceMs) continue;
      count += 1;
      if (event.session_id) sessions.add(event.session_id);
    }
  }
  return { count, sessions: sessions.size };
}

function buildFixture({ root, args, revision }) {
  fs.rmSync(root, { recursive: true, force: true });
  const traceDir = path.join(root, ".pi", "traces");
  const stateDir = path.join(root, ".pi", "project-memory");
  const testDir = path.join(root, ".pi", "test-runner");
  const guardDir = path.join(root, ".pi", "privacy-guard");
  const repoDir = path.join(root, "repo");
  const vaultDir = path.join(root, "vault");
  for (const dir of [traceDir, stateDir, testDir, guardDir, repoDir, path.join(vaultDir, ".obsidian")]) fs.mkdirSync(dir, { recursive: true });
  const copiedRecord = copyIfPresent(path.join(args.baselineCwd, ".pi", "test-runner", "full-latest.json"), path.join(testDir, "full-latest.json"));
  const copiedBaseline = copyIfPresent(path.join(args.baselineCwd, ".pi", "privacy-guard", "privacy-baseline.json"), path.join(guardDir, "privacy-baseline.json"));

  const nowMs = Date.now();
  const today = dayStart(nowMs);
  // Samples must not land in the future: the gates ignore rows after `now`.
  const clamp = (ms) => Math.min(ms, nowMs - 60000);
  const random = mulberry32(args.seed);
  const summary = { root, traceDir, stateDir, copiedRecord, copiedBaseline, realRuns: [], synthetic: { sessions: 0, completions: 0, days: 0, saves: 0, saveDays: 0, legacySaves: 0, legacyDays: 0, shadowOutcomes: 0, shadowDays: 0, shadowSessions: 0 }, citations: 0 };

  // Real entrypoint: pi -p with the headless injection opt-in and a fixed trace dir.
  if (!args.skipReal && args.realRuns > 0) {
    const probeStart = nowMs;
    summary.realRuns = runPiProbes({ count: args.realRuns, cwd: args.piCwd || repoDir, traceDir });
    summary.realRecall = countRecallEvents(traceDir, probeStart);
  }

  // Deterministic recall samples: one session per day, turns spread across the day.
  const perSession = distribute(args.completions, Math.min(args.sessions, args.days));
  const decisions = new ProjectMemoryDecisionStore({ cwd: root, clock: () => new Date(nowMs) });
  let recallIndex = 0;
  for (let session = 0; session < perSession.length; session++) {
    const dayMs = today - (perSession.length - 1 - session) * DAY;
    const sessionId = hashHex(`soak-session-${args.seed}-${session}`).slice(0, 20);
    const key = hashHex(sessionId).slice(0, 16);
    const runtime = createTraceRuntime({
      root: traceDir, cwd: root, sessionId, implementationRoot: REPO,
      capturePayloads: true, rotateBytes: 1 << 30, maxTotalBytes: 1 << 30, maxFiles: 500, maxAgeDays: 90, compressPayloadBytes: 1 << 20,
    });
    let firstHash = null; let firstAt = null;
    for (let turn = 0; turn < perSession[session]; turn++) {
      const at = new Date(clamp(dayMs + (9 + turn * 3) * 3600000 + Math.floor(random() * 60000))).toISOString();
      const returnedHash = `sha256:${hashHex(`soak-returned-${args.seed}-${session}-${turn}`)}`;
      if (!firstHash) { firstHash = returnedHash; firstAt = at; }
      const payload = recallTelemetryPayload({
        items: [{ evidence: { contentHash: returnedHash } }],
        candidates: 2 + turn,
        durationMs: 5 + ((session * 7 + turn * 3) % 20),
        outOfScopeCount: 0,
        sourceKind: "canonical-vault",
      }, { injected: turn % 2 === 0 });
      runtime.emit({ timestamp: at, category: "memory_retrieval", name: payload.name, session_id: sessionId, subsystem: "code-context", payload });
      recallIndex += 1;
    }
    runtime.close();
    // A citing decision keeps the citation-rate bar observable without inflating S1.
    decisions.record({ projectKey: "soak", kind: "decision", action: "pinned", reason: "explicit-standing", sessionIdHash: key, evidenceIds: [firstHash], at: new Date(clamp(Date.parse(firstAt) + 3600000)).toISOString() });
    summary.citations += 1;
    summary.synthetic.sessions += 1;
  }
  summary.synthetic.completions = recallIndex;
  summary.synthetic.days = perSession.length;

  // Deterministic shadow decisions: SD measures agreement while candidates stay
  // unapplied, so every row is emitted with applied=false and no vault write.
  const shadowPerDay = distribute(args.shadowOutcomes, args.shadowDays);
  let shadowIndex = 0;
  for (let day = 0; day < shadowPerDay.length; day++) {
    const dayMs = today - (shadowPerDay.length - 1 - day) * DAY;
    const sessionId = hashHex(`soak-shadow-session-${args.seed}-${day}`).slice(0, 20);
    const runtime = createTraceRuntime({
      root: traceDir, cwd: root, sessionId, implementationRoot: REPO,
      capturePayloads: true, rotateBytes: 1 << 30, maxTotalBytes: 1 << 30, maxFiles: 500, maxAgeDays: 90, compressPayloadBytes: 1 << 20,
    });
    for (let slot = 0; slot < shadowPerDay[day]; slot++) {
      const at = new Date(clamp(dayMs + (10 + slot) * 3600000)).toISOString();
      const proposalHash = `sha256:${hashHex(`soak-shadow-${args.seed}-${day}-${slot}`)}`;
      runtime.emit({ timestamp: at, category: "memory_decision", name: "shadow.outcome", session_id: sessionId, subsystem: "project-memory", payload: { agreed: true, applied: false, proposalHash } });
      shadowIndex += 1;
    }
    runtime.close();
    summary.synthetic.shadowSessions += 1;
  }
  summary.synthetic.shadowOutcomes = shadowIndex;
  summary.synthetic.shadowDays = shadowPerDay.length;

  // Deterministic explicit saves through the production store and decision ledger.
  let saveClock = nowMs;
  const store = new ProjectMemoryStore({ cwd: root, vault: vaultDir, writeEnabled: true, clock: () => new Date(saveClock) });
  const perDay = distribute(args.saves, args.saveDays);
  let saveIndex = 0;
  for (let day = 0; day < perDay.length; day++) {
    saveClock = clamp(today - (perDay.length - 1 - day) * DAY + 10 * 3600000);
    for (let slot = 0; slot < perDay[day]; slot++) {
      const result = store.upsert({
        kind: "decision",
        title: `Soak decision ${saveIndex}`,
        content: `Deterministic soak save ${saveIndex} exercising the explicit decision ledger path.`,
        verification: "verified",
      }, { apply: true, explicit: true });
      if (result?.decision?.action !== "saved" || result.decision.automatic !== false || result.decision.verification !== "verified") throw new Error(`explicit save ${saveIndex} did not record automatic=false/verification=verified`);
      saveIndex += 1;
    }
  }
  summary.synthetic.saves = saveIndex;
  summary.synthetic.saveDays = perDay.length;

  // Legacy rows emulate decisions written before the `automatic` provenance
  // field existed: they carry no flag, so the S1 gate counts them as explicit.
  const legacyPerDay = distribute(args.legacySaves, args.legacyDays);
  let legacyIndex = 0;
  for (let day = 0; day < legacyPerDay.length; day++) {
    const at = new Date(clamp(today - (legacyPerDay.length - 1 - day) * DAY + 12 * 3600000)).toISOString();
    for (let slot = 0; slot < legacyPerDay[day]; slot++) {
      const row = {
        schemaVersion: 1,
        projectKey: store.identity?.projectKey || "soak-project",
        kind: "decision",
        action: "saved",
        reason: "explicit-save",
        candidateHash: null,
        noteRevision: hashHex(`soak-legacy-note-${args.seed}-${legacyIndex}`),
        sourceFingerprints: [],
        evidenceIds: [],
        verification: "verified",
        at,
      };
      row.decisionId = `memdec_${hashHex(JSON.stringify(row)).slice(0, 16)}`;
      appendPrivate(path.join(stateDir, "decisions.jsonl"), row);
      legacyIndex += 1;
    }
  }
  summary.synthetic.legacySaves = legacyIndex;
  summary.synthetic.legacyDays = legacyPerDay.length;

  // Fresh sanitized audit after the copied baseline keeps B observable.
  recordWriteAudit({ cwd: root });

  summary.revision = revision;
  return summary;
}

function countMetrics(sources, nowMs, windowDays) {
  const decisions = sources.decisions || [];
  const traces = sources.traces || [];
  const diagnostics = sources.diagnostics || [];
  const w = (rows, predicate) => rows.filter((row) => predicate(row) && inWindow(row.at || row.timestamp, nowMs, windowDays));
  const sessionOf = (event) => { const hashed = String(event?.payload?.sessionIdHash || ""); if (SESSION_HASH.test(hashed)) return hashed; return event?.session_id ? hashHex(event.session_id).slice(0, 16) : null; };
  const rows = [];

  const s1 = w(decisions, (row) => row.action === "saved" && row.automatic !== true);
  const s1Days = new Set(s1.map((row) => dayOf(row.at)));
  const s1Verified = s1.filter((row) => row.verification === "verified").length;
  rows.push(["S1", "explicit saves (action=saved, automatic !== true)", s1.length], ["S1", "distinct save days", s1Days.size], ["S1", "verified precision", s1.length ? s1Verified / s1.length : null]);

  const rc = w(traces, (event) => event.category === "memory_retrieval" && event.name === "recall.completed");
  const incomplete = rc.filter((event) => !Number.isFinite(event.payload?.durationMs) || !Array.isArray(event.payload?.returnedHashes) || !Number.isInteger(event.payload?.outOfScopeCount) || typeof event.payload?.injected !== "boolean");
  const keys = rc.map(sessionOf);
  const sessions = new Set(keys.filter(Boolean));
  const rcDays = new Set(rc.map((event) => dayOf(event.timestamp)));
  const p95 = percentile(rc.filter((event) => Number.isFinite(event.payload?.durationMs)).map((event) => event.payload.durationMs), 0.95);
  const outOfScope = rc.filter((event) => event.payload?.outOfScopeCount !== 0).length;
  let returned = 0; let stale = 0;
  for (const event of rc) {
    const at = Date.parse(event.timestamp);
    for (const hash of (Array.isArray(event.payload?.returnedHashes) ? event.payload.returnedHashes : [])) {
      returned += 1;
      if (decisions.some((row) => row.action === "superseded" && Date.parse(row.at) > at && Date.parse(row.at) <= at + 7 * DAY && ((row.evidenceIds || []).includes(hash) || row.candidateHash === hash))) stale += 1;
    }
  }
  const perSession = new Map();
  rc.forEach((event, index) => {
    const key = keys[index]; if (!key) return;
    const at = Date.parse(event.timestamp);
    const entry = perSession.get(key) || { hashes: new Set(), firstAt: at };
    for (const hash of (Array.isArray(event.payload?.returnedHashes) ? event.payload.returnedHashes : [])) entry.hashes.add(hash);
    entry.firstAt = Math.min(entry.firstAt, at);
    perSession.set(key, entry);
  });
  let cited = 0;
  for (const [key, entry] of perSession) if (decisions.some((row) => row.sessionIdHash === key && Date.parse(row.at) >= entry.firstAt && (row.evidenceIds || []).some((id) => entry.hashes.has(id)))) cited += 1;
  rows.push(["R", "recall.completed samples", rc.length], ["R", "distinct sessions", sessions.size], ["R", "distinct days", rcDays.size], ["R", "incomplete payloads", incomplete.length], ["R", "latency p95 (ms)", p95], ["R", "out-of-scope recalls", outOfScope], ["R", "citation rate", perSession.size ? cited / perSession.size : null], ["R", "stale rate", returned ? stale / returned : null]);

  const sd = w(traces, (event) => event.category === "memory_decision" && event.name === "shadow.outcome");
  const sdInvalid = sd.filter((event) => typeof event.payload?.agreed !== "boolean" || event.payload?.applied !== false || !/^[A-Za-z0-9_.:-]{1,120}$/.test(String(event.payload?.proposalHash || "")));
  rows.push(["SD", "shadow.outcome samples", sd.length], ["SD", "distinct sessions", new Set(sd.map(sessionOf).filter(Boolean)).size], ["SD", "distinct days", new Set(sd.map((event) => dayOf(event.timestamp))).size], ["SD", "invalid payloads", sdInvalid.length], ["SD", "agreement rate", sd.length ? sd.filter((event) => event.payload?.agreed === true).length / sd.length : null]);

  const previews = w(diagnostics, (row) => row.kind === "settle");
  const ordered = [...previews].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const unstable = ordered.slice(1).filter((row, index) => sortedJson(row.candidateHashes) !== sortedJson(ordered[index].candidateHashes)).length;
  const accounted = previews.filter((row) => Object.values(row.reasonCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0) === Number(row.scanned)).length;
  rows.push(["C", "settle previews", previews.length], ["C", "distinct days", new Set(previews.map((row) => dayOf(row.at))).size], ["C", "malformed previews", previews.filter((row) => !Array.isArray(row.candidateHashes) || !row.reasonCounts || typeof row.reasonCounts !== "object" || !Number.isFinite(row.scanned)).length], ["C", "unstable candidate sets", unstable], ["C", "resolution accounting", previews.length ? accounted / previews.length : null], ["C", "non-diagnostic-only previews", previews.filter((row) => row.diagnosticOnly !== true || row.vaultReady !== true).length]);

  const autos = w(decisions, (row) => row.action === "saved" && row.automatic === true && row.applied !== false);
  const autoSessions = new Set(autos.map((row) => row.sessionIdHash).filter((key) => SESSION_HASH.test(String(key || ""))));
  const curation = w(traces, (event) => event.category === "memory_curation" && event.name === "curation.completed");
  rows.push(["A", "automatic saves (action=saved, automatic=true, applied)", autos.length], ["A", "distinct sessions", autoSessions.size], ["A", "distinct days", new Set(autos.map((row) => dayOf(row.at))).size], ["A", "verified precision", autos.length ? autos.filter((row) => row.verification === "verified").length / autos.length : null], ["A", "curation.completed events", curation.length], ["A", "invalid curation outcomes", curation.filter((event) => !CURATION_OUTCOMES.has(event.payload?.outcome)).length], ["A", "curation success rate", curation.length ? curation.filter((event) => event.payload?.outcome === "success").length / curation.length : null], ["A", "curation timeout rate", curation.length ? curation.filter((event) => event.payload?.outcome === "timeout").length / curation.length : null]);
  return rows;
}

function reportFor(cwd, windowDays, revision) {
  const sources = collectRolloutSources({ cwd, windowDays, privacy: scanPrivacy(cwd), baseline: loadPrivacyBaseline(cwd) });
  const report = evaluateRollout({ sources, windowDays, implementationRevision: revision });
  return { sources, report, metrics: countMetrics(sources, Date.now(), windowDays) };
}

function fmt(value) { if (value === null || value === undefined) return "n/a"; if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3); return String(value); }
function pad(value, width) { return String(value).padEnd(width); }

function printPredicates(label, report) {
  console.log(`\n[${label}] predicates (windowDays=${report.windowDays}, revision=${report.implementationRevision || "n/a"})`);
  for (const [id, predicate] of Object.entries(report.predicates)) console.log(`${pad(id, 3)} ${pad(predicate.status, 13)} ${JSON.stringify(predicate.reasons)}`);
}

function printMetricDiff(production, fixture) {
  const prod = new Map(production.metrics.map(([id, metric, value]) => [`${id}|${metric}`, value]));
  console.log("\n[metric diff] production(90d) -> fixture(90d)");
  console.log(`${pad("ID", 3)} ${pad("metric", 52)} ${pad("production", 12)} ${pad("fixture", 12)} ${pad("delta", 10)}`);
  for (const [id, metric, value] of fixture.metrics) {
    const before = prod.get(`${id}|${metric}`);
    const delta = typeof before === "number" && typeof value === "number" ? value - before : null;
    console.log(`${pad(id, 3)} ${pad(metric, 52)} ${pad(fmt(before), 12)} ${pad(fmt(value), 12)} ${pad(delta === null ? "n/a" : String(delta), 10)}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  assertSafeRoot(args.root);
  const revision = currentMemorySourceEvidence(REPO).revision;
  const summary = buildFixture({ root: args.root, args, revision });
  if (!args.quiet) console.log(JSON.stringify({ fixture: summary, revision }, null, 2));
  const fixture = reportFor(args.root, 90, revision);
  const production = reportFor(args.baselineCwd, 90, revision);
  printPredicates("fixture", fixture.report);
  printPredicates("production", production.report);
  printMetricDiff(production, fixture);
  const changed = Object.entries(fixture.report.predicates).filter(([id, predicate]) => production.report.predicates[id]?.status !== predicate.status);
  console.log(`\nstatus changes: ${changed.length ? changed.map(([id, predicate]) => `${id}:${production.report.predicates[id]?.status}->${predicate.status}`).join(", ") : "none"}`);
  console.log(`fixture report written under ${args.root}; production state was only read.`);
}

if (require.main === module) main();
module.exports = { buildFixture, countMetrics, reportFor };
