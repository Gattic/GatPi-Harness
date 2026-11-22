#!/usr/bin/env node
"use strict";
/**
 * Read-only evidence status for the passive memory rollout gates (S1/R/SD/C/A).
 * Prints current vs required counts, the authoritative predicate statuses from
 * the real evaluator, and how many distinct days each gate still needs. It
 * writes nothing, so it is safe to run while Pi is running, and it never seeds
 * or backdates rows.
 */
const fs = require("node:fs");
const path = require("node:path");
const { evaluateProjectMemoryRollout, collectRolloutSources, DAY, WINDOW_DAYS } = require("../src/memory-rollout-telemetry");
const { projectMemoryRuntimeConfig } = require("../src/project-memory-runtime");
const { STAGES } = require("../src/project-memory-rollout");

const cwd = path.resolve(process.argv[2] || process.cwd());
if (!fs.existsSync(path.join(cwd, ".pi"))) {
  console.error(`No .pi evidence directory under ${cwd}; run this from the project that hosts the memory rollout.`);
  process.exit(1);
}
const now = Date.now();
const inWindow = (at) => { const t = Date.parse(at); return Number.isFinite(t) && t <= now && t >= now - WINDOW_DAYS * DAY; };
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);
const distinctDays = (rows) => new Set(rows.map((row) => dayOf(row.at ?? row.timestamp))).size;
const percentile = (values, p) => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(p * ordered.length) - 1))];
};
const stageIndex = (stage) => STAGES.indexOf(stage);

const sources = collectRolloutSources({ cwd, nowMs: now, privacy: null, baseline: null });
const decisions = sources.decisions || [];
const traces = sources.traces || [];
const diagnostics = sources.diagnostics || [];

const saved = decisions.filter((row) => row.action === "saved" && inWindow(row.at));
const explicit = saved.filter((row) => row.automatic !== true);
const automatic = saved.filter((row) => row.automatic === true && row.applied !== false);
const recall = traces.filter((event) => event.category === "memory_retrieval" && event.name === "recall.completed" && inWindow(event.timestamp));
const incomplete = recall.filter((event) => !Number.isFinite(event.payload?.durationMs) || !Array.isArray(event.payload?.returnedHashes) || !Number.isInteger(event.payload?.outOfScopeCount) || typeof event.payload?.injected !== "boolean");
const shadow = traces.filter((event) => event.category === "memory_decision" && event.name === "shadow.outcome" && inWindow(event.timestamp));
const previews = diagnostics.filter((row) => row.kind === "settle" && inWindow(row.at)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
const curationOutcomes = traces.filter((event) => event.category === "memory_curation" && event.name === "curation.completed" && inWindow(event.timestamp));
const previewKey = (row) => JSON.stringify([...(row.candidateHashes || [])].map(String).sort());
const unstable = previews.slice(1).filter((row, index) => previewKey(row) !== previewKey(previews[index])).length;
const accounted = previews.filter((row) => Object.values(row.reasonCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0) === Number(row.scanned)).length;
const safePreviews = previews.filter((row) => row.diagnosticOnly === true && row.vaultReady === true).length;

const gates = [
  {
    name: "S1", count: explicit.length, need: 20, days: distinctDays(explicit), daysNeed: 7,
    extra: `verified ${explicit.filter((row) => row.verification === "verified").length}, precision ${explicit.length ? (explicit.filter((row) => row.verification === "verified").length / explicit.length).toFixed(3) : "n/a"}`,
  },
  {
    name: "R", count: recall.length, need: 30, days: distinctDays(recall), daysNeed: 14,
    extra: `sessions ${new Set(recall.map((event) => event.payload?.sessionIdHash || event.session_id)).size}, incomplete ${incomplete.length}, hashes ${recall.reduce((sum, event) => sum + (event.payload?.returnedHashes?.length || 0), 0)}, p95 ${percentile(recall.map((event) => event.payload?.durationMs).filter(Number.isFinite), 0.95) ?? "n/a"}ms`,
  },
  {
    name: "SD", count: shadow.length, need: 20, days: distinctDays(shadow), daysNeed: 7,
    extra: `sessions ${new Set(shadow.map((event) => event.payload?.sessionIdHash || event.session_id)).size}, agreement ${shadow.length ? (shadow.filter((event) => event.payload?.agreed === true).length / shadow.length).toFixed(3) : "n/a"}`,
  },
  {
    name: "C", count: previews.length, need: 14, days: distinctDays(previews), daysNeed: 14,
    extra: `unstable ${unstable}, accounted ${accounted}/${previews.length}, safe ${safePreviews}/${previews.length}`,
  },
  {
    name: "A", count: automatic.length, need: 30, days: distinctDays(automatic), daysNeed: 14,
    extra: `sessions ${new Set(automatic.map((row) => row.sessionIdHash).filter(Boolean)).size}, curation.completed ${curationOutcomes.length}`,
  },
];

const evaluation = evaluateProjectMemoryRollout({ cwd, env: process.env, refresh: true, emit: false });
const rollout = projectMemoryRuntimeConfig(cwd, process.env, { emit: false }).rollout;

console.log("Memory rollout evidence status (read-only)");
console.log(`window ${WINDOW_DAYS}d · evaluated ${evaluation.evaluatedAt} · candidate ${evaluation.candidateStage} · effective ${rollout.effectiveStage} · promoted ${evaluation.promoted}`);
console.log("");
for (const gate of gates) {
  const status = evaluation.predicates[gate.name]?.status ?? "n/a";
  const short = Math.max(0, gate.daysNeed - gate.days);
  console.log(`${gate.name.padEnd(2)} ${status.padEnd(12)} ${String(gate.count).padStart(3)}/${gate.need}  days ${String(gate.days).padStart(2)}/${gate.daysNeed} (${short}d short)  ${gate.extra}`);
}
console.log("");
console.log(`insufficient: ${evaluation.insufficient.join(", ") || "none"}`);
console.log(`D ${evaluation.predicates.D.status} · P ${evaluation.predicates.P.status} · B ${evaluation.predicates.B.status}`);
console.log("");
console.log(`posture: requested ${rollout.requestedStage} · eligible ${rollout.eligibleStage} · effective ${rollout.effectiveStage} · authority ${rollout.stageAuthority}`);
if (stageIndex(rollout.requestedStage) < stageIndex("M2")) {
  console.log("ceiling: requested stage caps effective stage; set PI_PROJECT_MEMORY_STAGE=M2 (or higher) before the 14-day run.");
}
const ready = stageIndex(evaluation.candidateStage) >= stageIndex("M2") && stageIndex(rollout.requestedStage) >= stageIndex(evaluation.candidateStage);
console.log(ready ? "promotion ready: candidate and ceiling allow the next stage" : "promotion not ready");
