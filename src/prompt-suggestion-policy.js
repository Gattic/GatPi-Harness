"use strict";

const DEFAULT_POLICY = Object.freeze({
  windowDays: 30,
  minAttempts: 20,
  minAcceptanceRate: 0.20,
  maxFailureRate: 0.25,
});

const REFINEMENT_SOURCES = Object.freeze(["model", "hermes"]);

function normalizeMode(value) {
  const text = String(value == null ? "auto" : value).trim().toLowerCase();
  if (["0", "false", "off", "disabled"].includes(text)) return "off";
  if (["1", "true", "on", "enabled", "force"].includes(text)) return "on";
  return "auto";
}
function clampRate(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}
function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}
function suggestionRows(events = [], sources = REFINEMENT_SOURCES) {
  const accepted = new Set(sources);
  return events.filter((event) => event?.kind === "prompt-suggestion" && event?.extension === "prompt-suggestions" && accepted.has(event?.source));
}
function eventTimeMs(event) {
  const value = Date.parse(String(event?.timestamp || ""));
  return Number.isFinite(value) ? value : null;
}
function legacyShownSuccess(event) {
  return event?.schemaVersion === 1 && event?.action === "shown" && event?.outcome === "succeeded";
}
function evaluateRefinementEvidence(events = [], options = {}) {
  const config = {
    minAttempts: positiveInt(options.minAttempts, DEFAULT_POLICY.minAttempts),
    minAcceptanceRate: clampRate(options.minAcceptanceRate, DEFAULT_POLICY.minAcceptanceRate),
    maxFailureRate: clampRate(options.maxFailureRate, DEFAULT_POLICY.maxFailureRate),
  };
  const rows = suggestionRows(events, options.sources);
  const refinedSuccessRows = rows.filter((event) => event.action === "refined" && event.outcome === "succeeded");
  const successRows = refinedSuccessRows.length
    ? refinedSuccessRows.concat(rows.filter(legacyShownSuccess))
    : rows.filter((event) => event.action === "shown" && event.outcome === "succeeded");
  const failureRows = rows.filter((event) => ["timed-out", "failed"].includes(event.action) || ["timed-out", "infrastructure-failed"].includes(event.outcome));
  const timeouts = failureRows.filter((event) => event.action === "timed-out" || event.outcome === "timed-out" || event.reasonCode === "timeout").length;
  const attempts = successRows.length + failureRows.length;
  // Keep timeout history observable, but never let old harness deadlines or
  // upstream provider timeouts poison the quality sample or failure gate.
  const scoredAttempts = attempts - timeouts;
  const scoredFailures = failureRows.length - timeouts;
  const shown = rows.filter((event) => event.action === "shown" && event.outcome === "succeeded").length;
  const accepted = rows.filter((event) => event.action === "accepted" && event.outcome === "succeeded").length;
  const acceptanceRate = shown > 0 ? Math.min(1, accepted / shown) : 0;
  const failureRate = scoredAttempts > 0 ? scoredFailures / scoredAttempts : 0;
  const timeoutRate = attempts > 0 ? timeouts / attempts : 0;
  const sampleReady = scoredAttempts >= config.minAttempts;
  const valueReady = acceptanceRate >= config.minAcceptanceRate;
  const reliabilityReady = failureRate <= config.maxFailureRate;
  const observationTimes = successRows
    .concat(failureRows, rows.filter((event) => event.outcome === "cancelled"))
    .map(eventTimeMs)
    .filter((value) => value != null);
  const lastAttemptMs = observationTimes.length ? Math.max(...observationTimes) : null;
  const bootstrapDue = !sampleReady;
  return {
    attempts,
    scoredAttempts,
    successes: successRows.length,
    failures: failureRows.length,
    timeouts,
    shown,
    accepted,
    acceptanceRate: Number(acceptanceRate.toFixed(4)),
    failureRate: Number(failureRate.toFixed(4)),
    timeoutRate: Number(timeoutRate.toFixed(4)),
    sampleReady,
    sampleRemaining: Math.max(0, config.minAttempts - scoredAttempts),
    bootstrapDue,
    lastAttemptAt: lastAttemptMs == null ? null : new Date(lastAttemptMs).toISOString(),
    valueReady,
    reliabilityReady,
    eligible: sampleReady && valueReady && reliabilityReady,
    config,
  };
}
function refinementPolicy(events = [], options = {}) {
  const mode = normalizeMode(options.mode);
  const evidence = evaluateRefinementEvidence(events, options);
  if (mode === "off") return { mode, automatic: false, bootstrap: false, manual: false, reasonCode: "disabled", evidence };
  if (mode === "on") return { mode, automatic: true, bootstrap: false, manual: true, reasonCode: "explicitly-enabled", evidence };
  return {
    mode,
    automatic: evidence.eligible,
    bootstrap: evidence.bootstrapDue,
    manual: true,
    reasonCode: evidence.eligible ? "evidence-bar-met" : !evidence.sampleReady ? "bootstrap-sample-due" : !evidence.reliabilityReady ? "failure-rate-too-high" : "acceptance-value-too-low",
    evidence,
  };
}

module.exports = { DEFAULT_POLICY, REFINEMENT_SOURCES, normalizeMode, suggestionRows, evaluateRefinementEvidence, refinementPolicy };
