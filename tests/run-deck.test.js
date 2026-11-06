"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  launchRun,
  attachRun,
  runStatus,
  watchRun,
  noteRun,
  finishRun,
  listRuns,
  listRunSummaries,
  formatRuns,
  formatRunStatus,
  runsSummary,
  parseVitals,
  resolveNewestLog,
} = require("../src/run-deck.js");
const { managedProcessMetrics } = require("../src/managed-process-metrics.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const tmp = tmpFixture("pi-run-deck-");

  // Vitals parsing over the log shapes the corpus greps by hand.
  const log = [
    "[step 100] loss=2.914 ||g||=0.62 24950 tok/s",
    "checkpoint saved to ckpt/step100.pt",
    "grad-skip at batch 4021",
    "[step 2500] loss=2.7210 val 2.7398 ||g||=0.58 25120 tok/s",
  ].join("\n");
  const vitals = parseVitals(log);
  assert.equal(vitals.step, "2500", "last step wins");
  assert.equal(vitals.loss, "2.7210");
  assert.equal(vitals.val, "2.7398");
  assert.equal(vitals.grad_norm, "0.58");
  assert.equal(vitals.tok_s, "25120");
  assert.equal(vitals.skips, 1);
  assert.equal(vitals.nan, undefined, "no NaN hits means no key");
  assert(vitals.lastLine.includes("[step 2500]"));
  assert(parseVitals("loss went to NaN, aborting").nan >= 1);

  // Wildcard log resolution (the `ls -td logs/x_*/run.log | head -1` ritual).
  fs.mkdirSync(path.join(tmp, "logs", "spectral_a"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "logs", "spectral_b"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "logs", "spectral_a", "run.log"), "[step 1]\n");
  fs.writeFileSync(path.join(tmp, "logs", "spectral_b", "run.log"), "[step 2]\n");
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(tmp, "logs", "spectral_a", "run.log"), past, past);
  const newest = resolveNewestLog(tmp, "logs/spectral_*/run.log");
  assert.equal(newest, path.join(tmp, "logs", "spectral_b", "run.log"), "newest matching log wins");
  assert.equal(resolveNewestLog(tmp, "logs/nomatch_*/run.log"), null);

  // Attach an externally-launched run and read status from its log.
  const attached = attachRun(tmp, { logPath: "logs/spectral_*/run.log", name: "spectral sweep" });
  assert(attached.runId.startsWith("run-spectral-sweep-"));
  const status = runStatus(tmp, attached.runId, { gpu: false, recordInteraction: true });
  assert.equal(status.vitals.step, "2");
  assert.equal(status.alive, null, "no pid/pattern means alive unknown");
  assert(formatRunStatus(status).includes("step=2"));

  // Launch a real detached run through bg-jobs and watch it to a milestone.
  const trainLog = path.join(tmp, "train.log");
  const launched = launchRun(tmp, `for i in 1 2 3; do echo "[step $i] loss=2.$i 100 tok/s" >> "${trainLog}"; done`, { name: "smoke train", logPath: "train.log" });
  const watched = await watchRun(tmp, launched.runId, { pattern: "\\[step 3\\]", timeoutMs: 15000, pollMs: 250, recordInteraction: true });
  const jobDiagnostics = () => {
    const jobsDir = path.join(tmp, ".pi", "jobs");
    const read = (name) => { try { return JSON.stringify(fs.readFileSync(path.join(jobsDir, name), "utf8").slice(0, 400)); } catch { return "(missing)"; } };
    return `job log: ${read(`${launched.jobId}.log`)}; exit file: ${read(`${launched.jobId}.exit`)}; job json: ${read(`${launched.jobId}.json`)}`;
  };
  assert.equal(watched.outcome, "matched", `expected milestone match, got ${JSON.stringify(watched)}; ${jobDiagnostics()}`);
  const launchedStatus = runStatus(tmp, launched.runId, { gpu: false, recordInteraction: true });
  assert.equal(launchedStatus.vitals.step, "3");
  runStatus(tmp, launched.runId, { gpu: false, recordInteraction: true });

  // Death detection: a run whose process is gone flips to exited.
  const dead = launchRun(tmp, "true", { name: "short job" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const deadWatch = await watchRun(tmp, dead.runId, { pattern: "never-appears", timeoutMs: 5000, pollMs: 250 });
  assert.equal(deadWatch.outcome, "died");
  const deadStatus = runStatus(tmp, dead.runId, { gpu: false, recordInteraction: true });
  assert.equal(deadStatus.run.status, "exited");

  // Notes, verdicts, listing, summary injection.
  noteRun(tmp, launched.runId, "smoke run for the test");
  const finished = finishRun(tmp, launched.runId, { status: "shipped", verdict: "val 2.71 banked", metrics: { val: 2.71 } });
  assert.equal(finished.status, "shipped");
  assert.equal(finished.banked.val, 2.71);
  const currentTerminal = runStatus(tmp, launched.runId, { gpu: false });
  assert.equal(currentTerminal.evidenceFreshness.status, "current");
  assert.match(formatRunStatus(currentTerminal), /terminal evidence: current/);
  fs.appendFileSync(trainLog, "post-finish tree change\n");
  const staleTerminal = runStatus(tmp, launched.runId, { gpu: false });
  assert.equal(staleTerminal.evidenceFreshness.status, "stale-tree", "Run Deck terminal evidence is reconciled against the current tree");
  const runs = listRuns(tmp);
  assert.equal(runs.length, 3);
  assert(formatRuns(runs).includes("val 2.71 banked"));
  assert.equal(listRuns(tmp, { status: "shipped" }).length, 1);
  const compactRuns = listRunSummaries(tmp);
  assert.equal(compactRuns.length, 3);
  assert.equal(Object.hasOwn(compactRuns[0], "name"), false);
  assert.equal(Object.hasOwn(compactRuns[0], "logFile"), false);
  assert.equal(Object.hasOwn(compactRuns[0], "notes"), false);
  assert(Object.values(compactRuns).every((row) => !Object.hasOwn(row.vitals || {}, "lastLine")));
  const summary = runsSummary(tmp);
  assert(summary.includes("Run deck"));
  assert(summary.includes("spectral sweep"));
  assert.match(summary, /activate_tools or use \/run-status/, "the injectable summary names the activation path when the tool is not declared");
  assert.equal(runsSummary(tmpFixture("pi-run-deck-empty-")), "", "no runs, no injection");
  const managed = managedProcessMetrics(tmp);
  assert.equal(managed.byKind.run_deck.starts, 3);
  assert.equal(managed.byKind.run_deck.pollingTriples, 1);
  assert.equal(managed.byKind.run_deck.finalEvidence, 2);
  assert.equal(managed.byKind.bg_run.starts, 0, "run_deck's internal bg job is excluded from the managed-target denominator");
  assert.equal(managed.privacy.containsTargetIds, false);

  // Custom metric specs from config.json merge over the defaults.
  fs.writeFileSync(path.join(tmp, ".pi", "run-deck", "config.json"), JSON.stringify({ metrics: [{ key: "acc", regex: "acc[\\s:=]+([\\d.]+)" }] }));
  fs.appendFileSync(path.join(tmp, "logs", "spectral_b", "run.log"), "[step 9] acc 0.633\n");
  const custom = runStatus(tmp, attached.runId, { gpu: false });
  assert.equal(custom.vitals.acc, "0.633");
  assert.equal(custom.vitals.step, "9", "default metrics survive a custom config");

  console.log("run-deck tests passed");
})().catch((err) => { console.error(err); process.exit(1); });
