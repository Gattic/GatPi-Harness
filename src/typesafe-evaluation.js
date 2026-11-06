"use strict";

// Metric definitions and pre-registered bars shared by the reviewed-gold
// evaluation (scripts/typesafe-gold.js) and the field report
// (scripts/report-typesafe-field.js), plus the metadata-only per-turn field
// record. Records hold only fixed labels and numbers.

const path = require("node:path");
const { defaultAgentDir } = require("./session-hygiene");
const { listExperiments, recordGate } = require("./experiment-ledger");
const { TASK_MODALITIES } = require("./task-modality");
const { TURN_JUDGMENT_VERSION } = require("./typesafe-turn-judgment");

const TURN_RECORD_SCHEMA_VERSION = 2;
const MODALITIES = new Set(TASK_MODALITIES);
const MODES = new Set(["off", "shadow", "on"]);

const BARS = Object.freeze({
  intent: {
    modalityAccuracyGain: 0.10,
  },
  // No latency bar: Jev is given the time it needs (see REQUEST_TIMEOUT_MS).
  // Latency is reported, not gated.
  field: {
    failureRateMax: 0.02,
    minTurns: 100,
  },
});

function rate(numerator, denominator) { return denominator ? numerator / denominator : null; }
function round(value, digits = 4) { return value == null ? null : Number(value.toFixed(digits)); }
function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function accuracy(rows) {
  return round(rate(rows.filter((row) => row.label === row.predicted).length, rows.length));
}

function bar(name, pass, detail) { return { name, verdict: pass == null ? "insufficient-data" : pass ? "pass" : "fail", detail }; }

function evaluateIntentBars({ localModality, typesafeModality }) {
  const b = BARS.intent;
  const missing = localModality == null || typesafeModality == null;
  return [
    bar("modality-accuracy", missing ? null : typesafeModality >= localModality + b.modalityAccuracyGain, `typesafe ${typesafeModality} vs regex ${localModality}; need +${b.modalityAccuracyGain}`),
  ];
}

function evaluateFieldBars(records) {
  const b = BARS.field;
  const judged = records.filter((record) => record.outcome !== "skipped");
  const failures = judged.filter((record) => record.outcome !== "ok").length;
  const enough = judged.length >= b.minTurns;
  return [
    bar("failure-rate", enough ? rate(failures, judged.length) <= b.failureRateMax : null, `${failures}/${judged.length} failed or timed out; need <= ${b.failureRateMax}`),
  ];
}

function cleanModality(value) { return MODALITIES.has(value) ? value : null; }
function cleanNumber(value) { return Number.isFinite(Number(value)) ? round(Number(value)) : null; }
function cleanReason(value) { return /^[a-z][a-z0-9-]{0,40}$/.test(String(value || "")) ? String(value) : "unknown"; }

// Field records from every project go to one file in Pi's agent directory, so
// the field report sees all sessions regardless of where Pi was launched.
function turnRecordDir(env = process.env) {
  return path.join(defaultAgentDir(env), "typesafe");
}

// judgment: SystemOneAdapter turn result or null when no request was made.
function buildTurnRecord({ at = new Date().toISOString(), modes, sessionKind, judgment, local }) {
  const decision = judgment?.ok ? judgment.decision : null;
  return {
    schemaVersion: TURN_RECORD_SCHEMA_VERSION,
    at,
    version: TURN_JUDGMENT_VERSION,
    sessionKind: cleanReason(sessionKind),
    modes: { intent: MODES.has(modes?.intent) ? modes.intent : "off" },
    outcome: judgment ? (judgment.ok ? "ok" : cleanReason(judgment.reason)) : "skipped",
    latencyMs: judgment ? cleanNumber(judgment.latencyMs) : null,
    model: judgment?.ok && /^[a-z0-9.-]{1,40}$/.test(judgment.model) ? judgment.model : null,
    inputTokens: judgment?.ok ? cleanNumber(judgment.inputTokens) : null,
    typesafe: decision ? {
      modality: cleanModality(decision.intent.modality.value),
      modalityConfidence: cleanNumber(decision.intent.modality.confidence),
      researchMemory: cleanNumber(decision.intent.researchMemory.probability),
    } : null,
    local: {
      modality: cleanModality(local?.modality),
      researchMemory: local?.researchMemory === true,
    },
  };
}

// Only interactive sessions under the current judgment version count; RPC,
// print, smoke, and fixture sessions and records made under another decision
// rule do not.
function fieldReport(records) {
  const byMode = {};
  const interactive = records.filter((record) => record.sessionKind === "interactive");
  const current = interactive.filter((record) => record.version === TURN_JUDGMENT_VERSION);
  for (const record of current) {
    const key = `intent=${record.modes.intent}`;
    (byMode[key] ||= []).push(record);
  }
  const summarize = (rows) => {
    const judged = rows.filter((row) => row.outcome !== "skipped");
    const ok = judged.filter((row) => row.outcome === "ok");
    const outcomes = {};
    for (const row of judged) outcomes[row.outcome] = (outcomes[row.outcome] || 0) + 1;
    return {
      turns: rows.length,
      judged: judged.length,
      outcomes,
      latencyMs: { p50: percentile(judged.map((row) => row.latencyMs), 0.5), p95: percentile(judged.map((row) => row.latencyMs), 0.95) },
      models: [...new Set(ok.map((row) => row.model))],
      inputTokensMean: round(rate(ok.reduce((sum, row) => sum + (row.inputTokens || 0), 0), ok.length), 1),
      bars: evaluateFieldBars(rows),
    };
  };
  return { schemaVersion: TURN_RECORD_SCHEMA_VERSION, version: TURN_JUDGMENT_VERSION, records: records.length, excludedNonInteractive: records.length - interactive.length, excludedOtherVersions: interactive.length - current.length, byMode: Object.fromEntries(Object.entries(byMode).map(([key, rows]) => [key, summarize(rows)])) };
}

// Records the field verdict on the open pre-registered TypeSafe experiments in
// the ledger at `ledgerRoot` (the harness repository). Throws when there is
// nothing to judge or nowhere to record it, rather than reporting success.
function recordFieldGate(ledgerRoot, report, gate) {
  const wanted = { "field-shadow": "shadow", "field-on": "on" }[gate];
  if (!wanted) throw new Error("gate must be field-shadow or field-on");
  const rows = Object.entries(report.byMode).filter(([key]) => key.includes(`=${wanted}`)).map(([, summary]) => summary);
  if (!rows.length) throw new Error(`no ${wanted}-mode records to judge`);
  const experiments = listExperiments(ledgerRoot).filter((row) => row.status === "open" && row.title.startsWith("TypeSafe Jev "));
  if (!experiments.length) throw new Error(`no open TypeSafe Jev experiments in the ledger at ${ledgerRoot}`);
  const bars = rows.flatMap((summary) => summary.bars);
  const verdict = bars.some((bar) => bar.verdict === "fail") ? "fail" : bars.every((bar) => bar.verdict === "pass") ? "pass" : "null-result";
  const metrics = JSON.stringify(bars.map((bar) => [bar.name, bar.verdict, bar.detail])).slice(0, 500);
  for (const experiment of experiments) recordGate(ledgerRoot, experiment.experimentId, { gate, verdict, metrics });
  return { verdict, experiments: experiments.map((row) => row.experimentId) };
}

module.exports = {
  TURN_RECORD_SCHEMA_VERSION,
  turnRecordDir,
  recordFieldGate,
  BARS,
  percentile,
  accuracy,
  evaluateIntentBars,
  evaluateFieldBars,
  buildTurnRecord,
  fieldReport,
};
