"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { captureTreeFingerprint, compareTreeFingerprint, treeFingerprintSummary } = require("./tree-fingerprint.js");

const USAGE_SCHEMA_VERSION = 2;
const METRICS_VERSION = "managed-process-metrics-v2";
const TARGET_KINDS = new Set(["bg_run", "run_deck"]);
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const COUNTERS = Object.freeze({
  start: "starts",
  status: "statusCalls",
  logs: "logCalls",
  "monitor-attached": "monitorAttachments",
  "settlement-notified": "settlementNotifications",
  "final-evidence": "finalEvidence",
});

function targetFile(cwd, kind, targetId) {
  if (!TARGET_KINDS.has(kind)) throw new Error(`unsupported managed target kind: ${kind}`);
  const expected = kind === "bg_run" ? /^job-[a-z0-9-]+$/ : /^run-[a-z0-9-]+$/;
  if (!expected.test(String(targetId || ""))) throw new Error(`invalid managed target id for ${kind}`);
  const dir = kind === "bg_run" ? path.join(cwd, ".pi", "jobs") : path.join(cwd, ".pi", "run-deck");
  return path.join(dir, `${targetId}.json`);
}

function emptyUsage(options = {}) {
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    eligible: options.eligible !== false,
    starts: 0,
    statusCalls: 0,
    logCalls: 0,
    monitorAttachments: 0,
    settlementNotifications: 0,
    finalEvidence: 0,
    pollingTriples: 0,
    pollingRemainder: 0,
    settlementNotificationRecorded: false,
    finalEvidenceRecorded: false,
    finalCategory: null,
    finalEvidenceAt: null,
    finalTree: null,
    eventKeys: {},
  };
}

function normalizeUsage(value, options = {}) {
  return { ...emptyUsage(options), ...(value && typeof value === "object" ? value : {}), schemaVersion: USAGE_SCHEMA_VERSION };
}

function writePrivateJson(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function withRecordLock(file, fn) {
  const lock = `${file}.usage.lock`;
  for (let attempt = 0; attempt < 40; attempt++) {
    let descriptor;
    try {
      descriptor = fs.openSync(lock, "wx", 0o600);
      try { return fn(); }
      finally { fs.closeSync(descriptor); try { fs.unlinkSync(lock); } catch {} }
    } catch (error) {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
      if (error?.code !== "EEXIST") throw error;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.unlinkSync(lock); continue; } } catch {}
      Atomics.wait(LOCK_WAIT, 0, 0, 5);
    }
  }
  throw new Error("managed process metrics lock timed out");
}

function recordManagedProcessEvent(cwd, kind, targetId, event, options = {}) {
  const counter = COUNTERS[event];
  if (!counter) throw new Error(`unsupported managed process event: ${event}`);
  const file = targetFile(cwd, kind, targetId);
  return withRecordLock(file, () => {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const usage = normalizeUsage(record.managedUsage, options);
    const eventKey = String(options.eventKey || "").slice(0, 200);
    const recordedKeys = new Set(Array.isArray(usage.eventKeys?.[event]) ? usage.eventKeys[event] : []);
    if (eventKey && recordedKeys.has(eventKey)) return record;
    if (event === "settlement-notified" && usage.settlementNotificationRecorded) return record;
    if (event === "final-evidence" && usage.finalEvidenceRecorded) return record;
    usage[counter] += 1;
    if (event === "status" || event === "logs") {
      usage.pollingRemainder += 1;
      if (usage.pollingRemainder >= 3) {
        usage.pollingTriples += Math.floor(usage.pollingRemainder / 3);
        usage.pollingRemainder %= 3;
      }
    }
    if (eventKey) {
      recordedKeys.add(eventKey);
      usage.eventKeys = { ...(usage.eventKeys || {}), [event]: Array.from(recordedKeys).slice(-50) };
    }
    if (event === "settlement-notified") usage.settlementNotificationRecorded = true;
    if (event === "final-evidence") {
      usage.finalEvidenceRecorded = true;
      usage.finalCategory = ["succeeded", "domain-negative", "cancelled", "infrastructure-failed", "unknown"].includes(options.category) ? options.category : "unknown";
      usage.finalEvidenceAt = new Date().toISOString();
      usage.finalTree = captureTreeFingerprint(cwd);
    }
    record.managedUsage = usage;
    writePrivateJson(file, record);
    return record;
  });
}

function readRecords(cwd, kind) {
  const dir = kind === "bg_run" ? path.join(cwd, ".pi", "jobs") : path.join(cwd, ".pi", "run-deck");
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => kind === "bg_run" ? /^job-[a-z0-9-]+\.json$/.test(name) : /^run-[a-z0-9-]+\.json$/.test(name)); }
  catch { return []; }
  return names.flatMap((name) => {
    try { return [JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))]; }
    catch { return []; }
  });
}

function managedEvidenceFreshness(cwd, record) {
  const usage = normalizeUsage(record?.managedUsage);
  return compareTreeFingerprint(cwd, usage.finalTree);
}

function summarize(cwd, records) {
  const counters = { targets: 0, starts: 0, statusCalls: 0, logCalls: 0, monitorAttachments: 0, settlementNotifications: 0, finalEvidence: 0, currentFinalEvidence: 0, staleFinalEvidence: 0, pollingTriples: 0 };
  const finalCategories = {};
  for (const record of records) {
    const usage = normalizeUsage(record.managedUsage);
    if (!usage.eligible) continue;
    counters.targets++;
    for (const key of ["starts", "statusCalls", "logCalls", "monitorAttachments", "settlementNotifications", "finalEvidence", "pollingTriples"]) counters[key] += Number(usage[key] || 0);
    if (usage.finalCategory) finalCategories[usage.finalCategory] = (finalCategories[usage.finalCategory] || 0) + 1;
    if (usage.finalEvidenceRecorded) {
      const freshness = managedEvidenceFreshness(cwd, record);
      if (freshness.gatingSafe) counters.currentFinalEvidence++;
      else counters.staleFinalEvidence++;
    }
  }
  const pollCalls = counters.statusCalls + counters.logCalls;
  const dated = records.filter((record) => normalizeUsage(record.managedUsage).eligible).map((record) => record.startedAt).filter(Boolean).sort();
  const observedDays = new Set(dated.map((value) => String(value).slice(0, 10))).size;
  return {
    ...counters,
    firstTargetAt: dated[0] || null,
    lastTargetAt: dated.at(-1) || null,
    observedDays,
    eligibleForFourteenDayDecision: observedDays >= 14,
    pollCalls,
    statusLogCallsPerStart: counters.starts ? Number((pollCalls / counters.starts).toFixed(4)) : 0,
    monitorAttachmentRate: counters.starts ? Number((counters.monitorAttachments / counters.starts).toFixed(4)) : 0,
    settlementNotificationRate: counters.monitorAttachments ? Number((counters.settlementNotifications / counters.monitorAttachments).toFixed(4)) : 0,
    terminalEvidenceRate: counters.starts ? Number((counters.finalEvidence / counters.starts).toFixed(4)) : 0,
    currentTerminalEvidenceRate: counters.starts ? Number((counters.currentFinalEvidence / counters.starts).toFixed(4)) : 0,
    gaps: { unmonitoredStarts: Math.max(0, counters.starts - counters.monitorAttachments), unnotifiedMonitors: Math.max(0, counters.monitorAttachments - counters.settlementNotifications), missingTerminalEvidence: Math.max(0, counters.starts - counters.finalEvidence) },
    finalCategories,
  };
}

function compareManagedProcessMetrics(previous, current) {
  if (!previous || !current) return { status: "insufficient-data", reason: "missing-cohort", pollingTripleReduction: null };
  if (previous.metricsVersion !== current.metricsVersion) return { status: "incompatible", reason: "metrics-version-mismatch", pollingTripleReduction: null };
  if (!previous.total?.eligibleForFourteenDayDecision || !current.total?.eligibleForFourteenDayDecision) return { status: "insufficient-data", reason: "requires-14-observed-days-per-cohort", pollingTripleReduction: null };
  const before = Number(previous.total.statusLogCallsPerStart || 0);
  const after = Number(current.total.statusLogCallsPerStart || 0);
  return { status: "measured", reason: "comparable-metrics-version", pollingTripleReduction: before > 0 ? Number((1 - after / before).toFixed(4)) : null, before, after };
}

function managedProcessMetrics(cwd = process.cwd(), options = {}) {
  const sinceMs = options.sinceAt == null ? -Infinity : Date.parse(options.sinceAt);
  const untilMs = options.untilAt == null ? Infinity : Date.parse(options.untilAt);
  const inside = (record) => {
    const at = Date.parse(record.startedAt || "");
    return Number.isFinite(at) && at >= sinceMs && at <= untilMs;
  };
  const jobs = readRecords(cwd, "bg_run").filter(inside);
  const runs = readRecords(cwd, "run_deck").filter(inside);
  const byKind = { bg_run: summarize(cwd, jobs), run_deck: summarize(cwd, runs) };
  const total = summarize(cwd, [...jobs, ...runs]);
  return {
    schemaVersion: USAGE_SCHEMA_VERSION,
    metricsVersion: METRICS_VERSION,
    scope: "aggregate-managed-process-usage",
    window: { sinceAt: options.sinceAt || null, untilAt: options.untilAt || null, timestampField: "target-startedAt" },
    byKind,
    total,
    privacy: { aggregateOnly: true, containsCommands: false, containsPaths: false, containsOutput: false, containsTargetIds: false },
  };
}

module.exports = { USAGE_SCHEMA_VERSION, METRICS_VERSION, emptyUsage, normalizeUsage, writePrivateJson, recordManagedProcessEvent, managedEvidenceFreshness, managedProcessMetrics, compareManagedProcessMetrics, treeFingerprintSummary };
