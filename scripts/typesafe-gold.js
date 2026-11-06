#!/usr/bin/env node
"use strict";

// Reviewed-gold workflow for the TypeSafe turn judgment (docs/jev-integration-plan-2026-10-02.md).
//
//   build        extract redacted candidate turns from Pi sessions (local only)
//   status       review progress and evaluation readiness
//   show         print rows for review
//   label        change labels on rows (status unchanged)
//   approve      approve rows, optionally changing labels first
//   reject       reject rows
//   preregister  record the turn-intent bars in the experiment ledger
//   evaluate     send approved rows to TypeSafe and judge the bars (requires a fully reviewed set);
//                --record records the gates, --reviewer <text> names who reviewed the set
//
// Label syntax: modality=<answer|investigation|planning|implementation|verification|none> note=<text>

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FileIntegrationStorage } = require("../src/file-integration-storage");
const { createTypeSafeClient, REQUEST_TIMEOUT_MS } = require("../src/typesafe-client");
const { buildTurnRequest, TURN_JUDGMENT_VERSION } = require("../src/typesafe-turn-judgment");
const { BARS, percentile } = require("../src/typesafe-evaluation");
const { classifyTaskModality } = require("../src/task-modality");
const { openExperiment, recordGate, listExperiments } = require("../src/experiment-ledger");
const gold = require("../src/typesafe-gold");

const cwd = path.resolve(__dirname, "..");
const storage = new FileIntegrationStorage(path.join(cwd, ".pi", "typesafe", "gold"));
const EXPERIMENT = Object.freeze({
  title: "TypeSafe Jev turn intent v5 (Phase 2)",
  hypothesis: "A per-turn TypeSafe System One Choice for the scaffold modality beats the regex classifier on reviewed gold, and the one request per turn (modality Choice + research-memory Noul) is reliable enough in the field to serve the scaffold and Obsidian consumers.",
});

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const assignments = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !next.includes("=")) { flags[arg.slice(2)] = next; i++; }
      else flags[arg.slice(2)] = true;
    } else if (/^(modality|note)=/.test(arg)) {
      const at = arg.indexOf("=");
      assignments[arg.slice(0, at)] = arg.slice(at + 1);
    } else positional.push(arg);
  }
  return { flags, positional, assignments };
}

function readRows() { return storage.readJsonl("candidates"); }
function writeRows(rows) { storage.writeJsonl("candidates", rows); }

function sessionFiles(root) {
  const files = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith("--tmp-")) continue;
    for (const file of fs.readdirSync(path.join(root, dir.name))) if (file.endsWith(".jsonl")) files.push(path.join(root, dir.name, file));
  }
  return files.sort();
}

async function build(flags) {
  const existing = readRows();
  if (existing.some((row) => row.review.status !== "pending") && !flags.force) throw new Error("a reviewed gold set already exists; pass --force to discard its review work");
  const root = path.resolve(String(flags.sessions || path.join(os.homedir(), ".pi", "agent", "sessions")));
  const excluded = {};
  const candidates = [];
  let sessions = 0;
  let turns = 0;
  for (const file of sessionFiles(root)) {
    const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const header = entries[0];
    if (header?.type !== "session" || String(header.cwd || "").startsWith("/tmp/") || String(header.cwd || "").includes("/.pi/")) { excluded["non-interactive-session"] = (excluded["non-interactive-session"] || 0) + 1; continue; }
    sessions++;
    for (const turn of gold.extractSessionTurns(entries, { sessionId: header.id })) {
      turns++;
      const result = gold.candidateFromTurn(turn);
      if (result.excluded) excluded[result.excluded] = (excluded[result.excluded] || 0) + 1;
      else candidates.push(result.candidate);
    }
  }
  const sample = gold.sampleCandidates(candidates, { count: Number(flags.count || 300) });
  writeRows(sample);
  console.log(JSON.stringify({ sessions, turns, candidates: candidates.length, excluded, sampled: sample.length, file: ".pi/typesafe/gold/candidates.jsonl" }, null, 2));
}

function show(flags) {
  const rows = readRows().filter((row) => !flags.status || row.review.status === flags.status);
  const offset = Number(flags.offset || 0);
  const limit = Number(flags.limit || 20);
  for (const row of rows.slice(offset, offset + limit)) {
    console.log(`── ${row.id}  [${row.review.status}] split=${row.split}`);
    console.log(`   modality: ${row.labels.modality || "unset"}`);
    if (row.previous) console.log(`   previous: ${row.previous.slice(0, 300)}`);
    console.log(`   request:  ${row.prompt}`);
    if (row.review.note) console.log(`   note: ${row.review.note}`);
  }
  console.log(`showing ${Math.min(limit, Math.max(0, rows.length - offset))} of ${rows.length}`);
}

function review(command, positional, assignments) {
  if (!positional.length) throw new Error(`${command} requires at least one row id`);
  const rows = readRows();
  const ids = new Set(positional);
  const status = command === "approve" ? "approved" : command === "reject" ? "rejected" : undefined;
  let changed = 0;
  const next = rows.map((row) => {
    if (!ids.has(row.id)) return row;
    changed++;
    return gold.applyReview(row, { ...assignments, status });
  });
  const missing = positional.filter((id) => !rows.some((row) => row.id === id));
  if (missing.length) throw new Error(`unknown row ids: ${missing.join(", ")}`);
  writeRows(next);
  console.log(JSON.stringify({ changed, ...gold.reviewSummary(next) }));
}

function openTurnIntentExperiment() {
  return listExperiments(cwd).find((experiment) => experiment.title === EXPERIMENT.title && experiment.status === "open");
}

function preregister() {
  const experiment = openExperiment(cwd, EXPERIMENT.title, {
    hypothesis: EXPERIMENT.hypothesis,
    bars: [
      `gold-offline: scaffold modality accuracy on reviewed labels (test split) >= regex + ${BARS.intent.modalityAccuracyGain} (needs >= ${gold.MIN_REVIEWED.modalityLabels} labels)`,
      `field-shadow and field-on: failures+timeouts (${REQUEST_TIMEOUT_MS} ms failure bound) <= ${BARS.field.failureRateMax} over >= ${BARS.field.minTurns} judged turns each; latency reported, not gated`,
      "privacy: zero over-cap or unredacted-secret payloads in the fixture audit (tests/typesafe-turn-judgment.test.js)",
      `model pinned to jev-1.13.0; judgment ${TURN_JUDGMENT_VERSION}; field gates count only ${TURN_JUDGMENT_VERSION} records`,
      "promotion decided per consumer: scaffold modality text; obsidian research-memory intent (no reviewed-gold bar, field bars only); role-router unchanged while auto roles are off",
    ],
    arms: ["regex: task-modality, obsidian RULES", "typesafe: modality Choice + research-memory Noul in one per-turn request"],
  });
  console.log(JSON.stringify({ id: experiment.experimentId, duplicate: Boolean(experiment.duplicate) }, null, 2));
}

async function judgeAll(rows) {
  const client = createTypeSafeClient();
  if (!client.keyPresent) throw new Error("TYPESAFE_API_KEY is not set");
  const cached = new Map(storage.readJsonl("responses").filter((row) => row.version === TURN_JUDGMENT_VERSION && row.model === client.model).map((row) => [row.id, row]));
  const answers = new Map();
  const usage = [];
  const failures = {};
  let index = 0;
  const worker = async () => {
    while (index < rows.length) {
      const row = rows[index++];
      const hit = cached.get(row.id);
      if (hit) { answers.set(row.id, hit.answers); usage.push(hit); continue; }
      const request = buildTurnRequest({ redactedPrompt: row.prompt });
      let result;
      for (let attempt = 0; attempt < 4; attempt++) {
        result = await client.systemOne(request);
        if (result.ok || !["rate-limited", "overloaded", "timeout", "network-error"].includes(result.reason)) break;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
      if (!result.ok) { failures[result.reason] = (failures[result.reason] || 0) + 1; continue; }
      answers.set(row.id, result.answers);
      usage.push(result);
      storage.appendJsonl("responses", { id: row.id, version: TURN_JUDGMENT_VERSION, model: result.model, inputTokens: result.inputTokens, latencyMs: result.latencyMs, answers: result.answers });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  // Latency is the request's own round trip when it was made (4 in flight).
  const requests = {
    judged: usage.length,
    models: [...new Set(usage.map((row) => row.model))],
    latencyMs: { p50: percentile(usage.map((row) => row.latencyMs), 0.5), p95: percentile(usage.map((row) => row.latencyMs), 0.95) },
    inputTokens: { mean: usage.length ? Math.round(usage.reduce((sum, row) => sum + row.inputTokens, 0) / usage.length) : null, total: usage.reduce((sum, row) => sum + row.inputTokens, 0) },
  };
  return { answers, failures, requests };
}

function localPredictions(rows) {
  return { regexModality: new Map(rows.map((row) => [row.id, classifyTaskModality(row.prompt).modality])) };
}

async function evaluate(flags) {
  const rows = readRows();
  const readiness = gold.evaluationReadiness(rows);
  if (!readiness.ready) {
    console.log(JSON.stringify({ refused: true, ...readiness }, null, 2));
    process.exitCode = 2;
    return;
  }
  const approved = rows.filter((row) => row.review.status === "approved");
  const { answers, failures, requests } = await judgeAll(approved);
  const report = { at: new Date().toISOString(), judgment: TURN_JUDGMENT_VERSION, failures, requests, ...gold.evaluateGold(rows, answers, localPredictions(approved)) };
  storage.writeJson(`evaluation-${report.at.replace(/[:.]/g, "-")}`, report);
  console.log(JSON.stringify(report, null, 2));
  if (!flags.record) return;
  const experiment = openTurnIntentExperiment();
  if (!experiment) throw new Error("no open pre-registered turn-intent experiment; run preregister first");
  const bars = report.intent.bars;
  const verdict = bars.some((bar) => bar.verdict === "fail") ? "fail" : bars.every((bar) => bar.verdict === "pass") ? "pass" : "null-result";
  const reviewer = flags.reviewer ? `; reviewed by ${String(flags.reviewer).slice(0, 120)}` : "";
  recordGate(cwd, experiment.experimentId, { gate: "gold-offline-modality", verdict, metrics: JSON.stringify(bars.map((bar) => [bar.name, bar.verdict, bar.detail])), note: `test modality labels ${report.rows.testModalityLabels}${reviewer}` });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional, assignments } = parseArgs(rest);
  if (command === "build") return build(flags);
  if (command === "status") return console.log(JSON.stringify(gold.evaluationReadiness(readRows()), null, 2));
  if (command === "show") return show(flags);
  if (["label", "approve", "reject"].includes(command)) return review(command, positional, assignments);
  if (command === "preregister") return preregister();
  if (command === "evaluate") return evaluate(flags);
  console.log("usage: node scripts/typesafe-gold.js build|status|show|label|approve|reject|preregister|evaluate (see header comment)");
  process.exitCode = command ? 1 : 0;
}

main().catch((error) => { console.error(error.message); process.exit(1); });
