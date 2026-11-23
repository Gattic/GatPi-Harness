#!/usr/bin/env node
"use strict";
/**
 * Daily readiness check for the passive memory rollout (M1 -> M2).
 * Re-runs the promotion predicates (D/P/B/S1/R/SD/C/A), prints each gate's
 * count/need, days/need, days remaining and earliest floor, and states whether
 * M2 (D && P && B && S1 && R) is eligible and whether the requested stage
 * allows promotion. Read-only, safe to run daily while Pi is running; `--json`
 * emits the same result for logging and `--strict` exits 1 while M2 is not
 * ready. It never seeds or backdates evidence.
 */
const path = require("node:path");
const { buildStatus } = require("./memory-evidence-status.js");
const { computeEvidenceWindow } = require("./memory-evidence-window.js");
const { STAGES } = require("../src/project-memory-rollout");

const stageIndex = (stage) => STAGES.indexOf(stage);

function composeReadiness(status, window) {
  const gate = (name) => {
    const row = window.criteria.find((criterion) => criterion.key === name);
    const source = status.gates.find((candidate) => candidate.name === name);
    return {
      name,
      status: status.evaluation.predicates[name]?.status ?? "n/a",
      count: source?.count ?? 0,
      need: source?.need ?? 0,
      days: row?.observedDays ?? source?.days ?? 0,
      daysNeed: row?.daysNeed ?? source?.daysNeed ?? 0,
      daysRemaining: row?.daysRemaining ?? Math.max(0, (source?.daysNeed ?? 0) - (source?.days ?? 0)),
      earliest: row?.earliest ?? null,
      extra: source?.extra ?? "",
    };
  };
  const gates = ["D", "P", "B"].map((name) => ({
    name,
    status: status.evaluation.predicates[name]?.status ?? "n/a",
    count: 0,
    need: 0,
    days: 0,
    daysNeed: 0,
    daysRemaining: null,
    earliest: null,
    extra: "",
  }));
  for (const name of ["S1", "R", "SD", "C", "A"]) gates.push(gate(name));
  const predicate = Object.fromEntries(["D", "P", "B", "S1", "R", "SD", "C", "A"].map((name) => [name, status.evaluation.predicates[name]?.status ?? "n/a"]));
  const m2Eligible = stageIndex(status.evaluation.candidateStage) >= stageIndex("M2");
  const requestedAllows = stageIndex(status.rollout.requestedStage) >= stageIndex(status.evaluation.candidateStage);
  return {
    generatedAt: new Date(status.now).toISOString(),
    window: { days: window.windowDays, start: window.start, end: window.end },
    stage: { requested: status.rollout.requestedStage, eligible: status.rollout.eligibleStage, effective: status.rollout.effectiveStage, candidate: status.evaluation.candidateStage },
    predicate,
    m2Eligible,
    promotionReady: m2Eligible && requestedAllows,
    blockers: ["D", "P", "B", "S1", "R"].filter((name) => predicate[name] !== "pass"),
    gates,
  };
}

function buildReadiness({ cwd = process.cwd(), now = Date.now(), env = process.env } = {}) {
  const status = buildStatus({ cwd, now, env });
  const window = computeEvidenceWindow({ decisions: status.sources.decisions, traces: status.sources.traces, diagnostics: status.sources.diagnostics, now });
  return composeReadiness(status, window);
}

function renderReadiness(result) {
  console.log("Memory rollout readiness (read-only)");
  console.log(`generated ${result.generatedAt} · window ${result.window.days}d (${result.window.start} → ${result.window.end})`);
  console.log(`stage: requested ${result.stage.requested} · eligible ${result.stage.eligible} · effective ${result.stage.effective} · candidate ${result.stage.candidate}`);
  console.log("");
  console.log(`M2 predicate (D && P && B && S1 && R): ${result.m2Eligible ? "ELIGIBLE" : "NOT ELIGIBLE"}${result.blockers.length ? ` — blocked by ${result.blockers.join(", ")}` : ""}`);
  if (result.promotionReady) console.log("promotion: M2 ready — the requested stage and evidence allow promotion.");
  else if (result.m2Eligible) console.log(`promotion: M2 is eligible but requested ${result.stage.requested} caps effective ${result.stage.effective}; raise the requested stage to M2.`);
  else console.log("promotion: not ready — stay at the current stage and keep accruing evidence.");
  console.log("");
  console.log("gate  status        count/need   days/need   days-left  earliest");
  for (const gate of result.gates) {
    const count = gate.need ? `${gate.count}/${gate.need}` : "—";
    const days = gate.daysNeed ? `${gate.days}/${gate.daysNeed}` : "—";
    const left = gate.daysRemaining == null ? "—" : String(gate.daysRemaining);
    console.log(`${gate.name.padEnd(4)} ${gate.status.padEnd(12)} ${count.padEnd(11)} ${days.padEnd(10)} ${left.padStart(9)}  ${gate.earliest ?? "—"}`);
  }
  console.log("");
  console.log("details:");
  for (const gate of result.gates) if (gate.extra) console.log(`  ${gate.name}: ${gate.extra}`);
}

function main(argv) {
  const json = argv.includes("--json");
  const strict = argv.includes("--strict");
  const cwdArg = argv.find((arg) => !arg.startsWith("--"));
  const cwd = path.resolve(cwdArg || process.cwd());
  let result;
  try { result = buildReadiness({ cwd }); }
  catch (error) { console.error(error.message); return 1; }
  if (json) console.log(JSON.stringify(result, null, 2));
  else renderReadiness(result);
  if (strict && !result.promotionReady) {
    console.error(`strict: M2 not ready${result.blockers.length ? ` (blocked by ${result.blockers.join(", ")})` : ""}`);
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { buildReadiness, composeReadiness, renderReadiness };
