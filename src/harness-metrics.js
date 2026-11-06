"use strict";

// Aggregates the harness's own effectiveness signals from existing repo-local
// state: goal outcomes, verification runs, semantic patch results, recall
// activity from traces, and learning-loop accumulation. This is the Phase 3
// measurement instrument: numbers first, feature work second.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { managedProcessMetrics } = require("./managed-process-metrics.js");
const { readExtensionTelemetry } = require("./extension-telemetry.js");
const { fixRecallEffectiveness } = require("./fix-recall.js");

const MAX_TRACE_FILES = 5;
const MAX_TRACE_LINES_PER_FILE = 4000;
const SLOW_EVENT_MS = 3000;

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonl(file, limit = 10_000) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\n+/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listFiles(dir, suffix = ".json") {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(suffix))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function countBy(rows, pick) {
  const counts = {};
  for (const row of rows) {
    const key = pick(row) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function goalMetrics(cwd) {
  const goals = listFiles(path.join(cwd, ".pi", "goal-state"))
    .filter((file) => !file.endsWith(".archive.json"))
    .flatMap((file) => {
      const parsed = readJson(file, {});
      return Array.isArray(parsed?.goals) ? parsed.goals : [];
    });
  const byStatus = countBy(goals, (g) => g.status);
  const completed = byStatus.completed || 0;
  return { total: goals.length, byStatus, successRate: goals.length ? completed / goals.length : null };
}

function verificationMetrics(cwd) {
  const runs = listFiles(path.join(cwd, ".pi", "verification-center"))
    .map((file) => readJson(file, null))
    .filter((run) => run && typeof run === "object" && "ok" in run);
  const failed = runs.filter((run) => run.ok === false).length;
  const lastRunAt = runs.map((run) => run.generatedAt).filter(Boolean).sort().at(-1) || null;
  return { runs: runs.length, ok: runs.length - failed, failed, catchRate: runs.length ? failed / runs.length : null, lastRunAt };
}

function refactorMetrics(cwd) {
  const checkpoints = listFiles(path.join(cwd, ".pi", "ast-refactor", "checkpoints"))
    .map((file) => readJson(file, null))
    .filter(Boolean);
  return { total: checkpoints.length, files: checkpoints.reduce((sum, checkpoint) => sum + (checkpoint.files?.length || 0), 0) };
}

function recallMetrics(cwd) {
  const traceDir = process.env.PI_TRACE_DIR || path.join(cwd, ".pi", "traces");
  const files = listFiles(traceDir, ".jsonl")
    .map((file) => ({ file, mtime: (() => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_TRACE_FILES);
  let traceEvents = 0;
  let recallEvents = 0;
  let cacheFallbacks = 0;
  let failureEvents = 0;
  let slowEvents = 0;
  for (const { file } of files) {
    for (const event of readJsonl(file, MAX_TRACE_LINES_PER_FILE)) {
      traceEvents++;
      const name = String(event.name || "");
      if (event.category === "memory_retrieval" || /recall/i.test(name)) {
        recallEvents++;
        if (/fallback|cache/i.test(name)) cacheFallbacks++;
      }
      if (event.category === "failure_state" || event.severity === "error" || event.severity === "fatal") failureEvents++;
      if (Number(event.duration_ms) >= SLOW_EVENT_MS) slowEvents++;
    }
  }
  return { traceFiles: files.length, traceEvents, recallEvents, cacheFallbacks, failureEvents, slowEvents };
}

function learningMetrics(cwd) {
  const root = path.join(cwd, ".pi", "learning-loop");
  const outcomes = readJsonl(path.join(root, "outcomes.jsonl"));
  const patterns = readJsonl(path.join(root, "patterns.jsonl"));
  const decisions = readJsonl(path.join(root, "decisions.jsonl"));
  const byStatus = countBy(outcomes, (o) => o.signals?.status);
  return {
    outcomes: outcomes.length,
    bySource: countBy(outcomes, (o) => o.source),
    succeeded: byStatus.succeeded || 0,
    domainNegative: byStatus["domain-negative"] || 0,
    infrastructureFailed: byStatus["infrastructure-failed"] || 0,
    legacyAmbiguous: byStatus.failed || 0,
    failed: (byStatus["infrastructure-failed"] || 0) + (byStatus["timed-out"] || 0),
    patterns: patterns.length,
    decisions: decisions.length,
  };
}

function collectHarnessMetrics(cwd = process.cwd()) {
  const extensionTelemetry = readExtensionTelemetry({ cwd });
  return {
    generatedAt: new Date().toISOString(),
    projectHash: crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16),
    goals: goalMetrics(cwd),
    verification: verificationMetrics(cwd),
    refactors: refactorMetrics(cwd),
    recall: recallMetrics(cwd),
    learning: learningMetrics(cwd),
    managedProcesses: managedProcessMetrics(cwd),
    extensionTelemetry: {
      schemaVersion: extensionTelemetry.schemaVersion,
      rawEventCount: extensionTelemetry.rawEventCount,
      uniqueEventCount: extensionTelemetry.uniqueEventCount,
      duplicateEventCount: extensionTelemetry.duplicateEventCount,
      duplicateEventIdGroups: extensionTelemetry.duplicateEventIdGroups,
      interactiveCohort: extensionTelemetry.interactiveCohort,
      featureSignals: extensionTelemetry.featureSignals,
      privacy: extensionTelemetry.privacy,
    },
    retrievalSavings: retrievalSavings(extensionTelemetry.featureSignals?.rows),
    fixRecall: fixRecallEffectiveness(cwd),
  };
}

function pct(value) {
  return value == null ? "n/a" : `${Math.round(value * 100)}%`;
}

// The final-result observer counts native rendering and the backstop once.
// Backstop-only signals describe bypasses, not an additional source of savings.
function retrievalSavings(rows) {
  const byTool = new Map();
  for (const row of rows || []) {
    const observed = row.feature === "tool-result-rendering" && row.action === "observed";
    const bypassed = row.feature === "output-compactor" && row.action === "bypassed";
    if (!observed && !bypassed) continue;
    const tool = String(row.tool || "unattributed");
    const stats = byTool.get(tool) || { tool, results: 0, inputChars: 0, modelChars: 0, outputChars: 0, savedChars: 0, bypassed: 0, unsavedChars: 0 };
    if (observed) {
      stats.results += Number(row.count || 0);
      for (const field of ["inputChars", "modelChars", "outputChars", "savedChars"]) stats[field] += Number(row[field] || 0);
    } else {
      stats.bypassed += Number(row.count || 0);
      stats.unsavedChars += Number(row.inputChars || 0);
    }
    byTool.set(tool, stats);
  }
  const tools = [...byTool.values()].sort((a, b) => b.inputChars - a.inputChars || a.tool.localeCompare(b.tool));
  const totals = {};
  for (const field of ["results", "inputChars", "modelChars", "outputChars", "savedChars", "bypassed", "unsavedChars"]) totals[field] = tools.reduce((sum, row) => sum + row[field], 0);
  return { ...totals, tools };
}

function formatHarnessMetrics(m) {
  const lines = [`Harness effectiveness metrics ${m.generatedAt}`, `project: ${m.projectHash}`];
  lines.push(
    m.goals.total
      ? `goals: ${m.goals.total} (${Object.entries(m.goals.byStatus).map(([k, v]) => `${k}=${v}`).join(", ")}); success rate: ${pct(m.goals.successRate)}`
      : "goals: no goals recorded yet"
  );
  lines.push(
    m.verification.runs
      ? `verification runs: ${m.verification.runs} (ok=${m.verification.ok}, failed=${m.verification.failed}); catch rate: ${pct(m.verification.catchRate)}${m.verification.lastRunAt ? `; last: ${m.verification.lastRunAt}` : ""}`
      : "verification runs: none recorded yet"
  );
  lines.push(
    m.refactors.total
      ? `AST refactor checkpoints: ${m.refactors.total} (${m.refactors.files} file snapshots)`
      : "AST refactor checkpoints: none recorded yet"
  );
  lines.push(`recall events: ${m.recall.recallEvents} (cache fallbacks=${m.recall.cacheFallbacks}) across ${m.recall.traceEvents} trace events; failures=${m.recall.failureEvents}, slow(>=${SLOW_EVENT_MS}ms)=${m.recall.slowEvents}`);
  lines.push(`learning outcomes: ${m.learning.outcomes} (succeeded=${m.learning.succeeded}, failed=${m.learning.failed}); patterns=${m.learning.patterns}, reviewed decisions=${m.learning.decisions}`);
  const managed = m.managedProcesses?.total || {};
  lines.push(`managed processes: starts=${managed.starts || 0}, status=${managed.statusCalls || 0}, logs=${managed.logCalls || 0}, monitors=${managed.monitorAttachments || 0} (${managed.monitorAttachmentRate || 0}/start), settlement notifications=${managed.settlementNotifications || 0} (${managed.settlementNotificationRate || 0}/monitor), terminal evidence=${managed.finalEvidence || 0} (${managed.terminalEvidenceRate || 0}/start; current=${managed.currentFinalEvidence || 0}), polling triples=${managed.pollingTriples || 0}, gaps=${JSON.stringify(managed.gaps || {})}`);
  const cohort = m.extensionTelemetry?.interactiveCohort || {};
  const features = m.extensionTelemetry?.featureSignals || {};
  lines.push(`extension telemetry integrity: raw=${m.extensionTelemetry?.rawEventCount || 0}, unique=${m.extensionTelemetry?.uniqueEventCount || 0}, duplicates=${m.extensionTelemetry?.duplicateEventCount || 0}, duplicate groups=${m.extensionTelemetry?.duplicateEventIdGroups || 0}`);
  lines.push(`extension telemetry cohort: sessions=${cohort.sessions || 0}, observed days=${cohort.observedDays || 0}, token coverage=${cohort.tokenCoverage ?? 0}, current-session-excluded=${cohort.currentSessionExcluded === true}`);
  lines.push(`uncertain feature signals: events=${(features.rows || []).reduce((sum, row) => sum + Number(row.count || 0), 0)}, saved chars=${features.savedChars || 0}, reduction=${features.reductionPct || 0}%`);
  const savings = m.retrievalSavings;
  lines.push(
    savings?.results
      ? `retrieval savings: results=${savings.results}, raw=${savings.inputChars} chars, model-visible=${savings.outputChars} chars, saved=${savings.savedChars} chars; backstop bypasses=${savings.bypassed} (${savings.unsavedChars} chars); largest: ${savings.tools.slice(0, 3).map((row) => `${row.tool} saved=${row.savedChars} bypassed=${row.unsavedChars}`).join(", ")}`
      : "retrieval savings: no final-result observations recorded yet"
  );
  lines.push(`fix recall: ${m.fixRecall.status}; retrievals=${m.fixRecall.retrievals}, attributed attempts=${m.fixRecall.attributedAttempts}, no-change/worse=${m.fixRecall.noChangeOrWorse}, bad-rate delta=${m.fixRecall.badRateDelta ?? "n/a"}`);
  return lines.join("\n");
}

module.exports = { collectHarnessMetrics, formatHarnessMetrics };
