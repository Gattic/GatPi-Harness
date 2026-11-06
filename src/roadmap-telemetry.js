"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { FileIntegrationStorage } = require("./file-integration-storage");
const { resolveProjectRoot, roadmapRoot } = require("../.pi/extensions/roadmap/roadmap-state.js");

const ROADMAP_TELEMETRY_SCHEMA_VERSION = 1;
const ROADMAP_COHORT_VERSION = "roadmap-v3-2026-07-27";
const ROADMAP_SOURCE_FILES = [
  ".pi/extensions/privacy-guard/index.ts",
  ".pi/extensions/reasoning-runtime/index.ts",
  ".pi/extensions/roadmap/index.ts",
  ".pi/extensions/roadmap/roadmap-state.js",
  "extensions/role-sidecar/index.ts",
  "scripts/generate-roadmap-release-scorecard.js",
  "src/evidence-binder.js",
  "src/file-integration-storage.js",
  "src/integration-boundary.js",
  "src/multi-agent-topologies.js",
  "src/roadmap-plan-application.js",
  "src/roadmap-telemetry.js",
  "src/role-contracts.js",
  "src/role-result-schemas.js",
  "src/role-runtime-rollout.js",
  "src/role-topologies.js",
  "src/skill-synthesis.js",
  "src/subagent-result-validator.js",
  "src/subagents.js",
];
const ROADMAP_CONFIG_FILES = [".pi/topologies/planner-coder-verifier.json", ".pi/topologies/autonomous-coding-workflow.json", ".pi/topologies/docs-update.json"];
const ROADMAP_COHORT_ENV_KEYS = ["PI_ROADMAP", "PI_ROADMAP_TELEMETRY", "PI_ROLE_RUNTIME_VERSION", "PI_ROLE_MUTATION", "PI_ROLE_SIDECAR", "PI_ROLE_ROLLOUT_STAGE", "PI_ROLE_FIELD_PILOT", "PI_TOPOLOGY_AUTO_ROUTE", "PI_TOPOLOGY_CONFIG_DIRS"];
const ROADMAP_OPERATIONS = new Set(["show", "export", "report", "start", "replace", "add_subtask", "add", "set_status", "active", "link", "import_reasoning", "adopt", "close", "shelve", "resume", "archive", "clear", "input_opportunity"]);
const ROADMAP_OUTCOMES = new Set(["succeeded", "domain-negative", "infrastructure-failed", "not-applicable"]);
const SESSION_KINDS = new Set(["interactive", "headless-smoke", "deterministic-fixture", "unknown"]);
const REQUEST_VALIDITY = new Set(["valid", "invalid", "not-applicable"]);
const TELEMETRY_ALLOWED_FIELDS = new Set(["schemaVersion", "cohortVersion", "at", "sessionToken", "sessionKind", "operation", "outcome", "requestValidity", "resultChars", "deltaChars", "itemCount", "maxDepth", "actionableCount", "nonActionableCount", "blockedCount", "unsupportedVerificationCount", "evidenceBindingCount", "eligible", "adopted", "settled", "correction", "errorCode"]);
const HISTORICAL_BASELINE = Object.freeze({
  evidenceClass: "historical-lifetime",
  corpusId: "pi-roadmap-lifetime-2026-07-27",
  runtimeVersion: "roadmap-v2-pre-remediation",
  configVersion: "roadmap-lifetime-audit-2026-07-27",
  repeatedTaskCohortId: "roadmap-repeated-task-aggregate-2026-07-27",
  sessionFiles: 1502,
  corpusBytes: 779486656,
  eligibleInteractiveSessions: 91,
  adoptingSessions: 61,
  adoptionRate: 0.67,
  toolCalls: 1923,
  toolResults: 1922,
  errors: 28,
  errorRate: 0.0146,
  completeSnapshots: 252,
  uniqueRootSnapshots: 275,
  settledSnapshots: 259,
  invariantViolations: 0,
  applicationViolations: 0,
  verifiedTransitionsWithEvidenceRate: 0.0247,
  finalVerifiedItemsWithEvidenceRate: 0.035,
  resultCharacters: 2770000,
  adjacentResultP90LineOverlap: 0.82,
  largeRoadmapMedianMutationCharacters: 21618,
});

function finite(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0; }
function safeEnum(value, allowed, fallback) { const text = String(value || ""); return allowed.has(text) ? text : fallback; }
function safeToken(value, fallback = "unknown", max = 100) {
  const text = String(value || "").trim();
  return text && text.length <= max && /^[A-Za-z0-9_.:+-]+$/.test(text) ? text : fallback;
}
function createRoadmapSessionToken() { return `roadmap_session_${crypto.randomBytes(10).toString("hex")}`; }
function roadmapOpportunityEligible(text) {
  const normalized = String(text || "").toLowerCase().replace(/[_-]+/g, " ");
  return ["roadmap", "multi step", "milestone", "phase", "implement", "execute the plan", "track this plan", "work until complete"].some((phrase) => normalized.includes(phrase));
}
function roadmapCohortVersion(cwd = process.cwd(), options = {}) {
  const projectRoot = resolveProjectRoot(cwd);
  const sourceRoot = path.resolve(options.sourceRoot || path.join(__dirname, ".."));
  const hash = crypto.createHash("sha256");
  const addFile = (kind, root, relative) => {
    const label = `${kind}:${relative}`;
    hash.update(label);
    try { hash.update(fs.readFileSync(path.join(root, relative))); } catch { hash.update("<missing>"); }
  };
  const topologyConfigs = (root) => {
    try {
      const discovered = fs.readdirSync(path.join(root, ".pi", "topologies")).filter((name) => name.endsWith(".json")).sort().map((name) => `.pi/topologies/${name}`);
      return [...new Set([...ROADMAP_CONFIG_FILES, ...discovered])].sort();
    } catch { return [...ROADMAP_CONFIG_FILES].sort(); }
  };
  for (const relative of ROADMAP_SOURCE_FILES) addFile("source", sourceRoot, relative);
  for (const relative of topologyConfigs(sourceRoot)) addFile("source-config", sourceRoot, relative);
  if (projectRoot !== sourceRoot) for (const relative of topologyConfigs(projectRoot)) addFile("project-config", projectRoot, relative);
  const environment = Object.fromEntries(ROADMAP_COHORT_ENV_KEYS.map((key) => [key, process.env[key] ?? null]));
  hash.update(JSON.stringify({ telemetrySchema: ROADMAP_TELEMETRY_SCHEMA_VERSION, roadmapSchema: 3, mutationEnvelopeSchema: 1, environment }));
  return `${ROADMAP_COHORT_VERSION}-${hash.digest("hex").slice(0, 16)}`;
}
function telemetryStorage(cwd) { return new FileIntegrationStorage(roadmapRoot(cwd)); }
function roadmapTelemetryFile(cwd) { return telemetryStorage(cwd).jsonlPath("telemetry/events"); }

function createRoadmapTelemetryEvent(input = {}, options = {}) {
  const at = new Date(typeof options.clock === "function" ? options.clock() : Date.now()).toISOString();
  return {
    schemaVersion: ROADMAP_TELEMETRY_SCHEMA_VERSION,
    cohortVersion: safeToken(input.cohortVersion, ROADMAP_COHORT_VERSION, 120),
    at,
    sessionToken: safeToken(input.sessionToken, "unknown", 120),
    sessionKind: safeEnum(input.sessionKind, SESSION_KINDS, "unknown"),
    operation: safeEnum(input.operation, ROADMAP_OPERATIONS, "report"),
    outcome: safeEnum(input.outcome, ROADMAP_OUTCOMES, "not-applicable"),
    requestValidity: safeEnum(input.requestValidity, REQUEST_VALIDITY, input.operation === "add_subtask" ? (input.outcome === "domain-negative" ? "invalid" : input.outcome === "not-applicable" ? "not-applicable" : "valid") : "not-applicable"),
    resultChars: finite(input.resultChars),
    deltaChars: finite(input.deltaChars),
    itemCount: finite(input.itemCount),
    maxDepth: finite(input.maxDepth),
    actionableCount: finite(input.actionableCount),
    nonActionableCount: finite(input.nonActionableCount),
    blockedCount: finite(input.blockedCount),
    unsupportedVerificationCount: finite(input.unsupportedVerificationCount),
    evidenceBindingCount: finite(input.evidenceBindingCount),
    eligible: input.eligible === true,
    adopted: input.adopted === true,
    settled: input.settled === true,
    correction: input.correction === true,
    errorCode: input.errorCode ? safeToken(input.errorCode, "other", 80) : null,
  };
}

function recordRoadmapTelemetry(cwd, input = {}, options = {}) {
  if (options.enabled === false || process.env.PI_ROADMAP_TELEMETRY === "0") return { ok: true, skipped: true, reason: "telemetry-disabled" };
  try {
    const event = createRoadmapTelemetryEvent(input, options);
    const file = telemetryStorage(cwd).appendJsonl("telemetry/events", event);
    return { ok: true, event, file };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function readRoadmapTelemetry(cwd) {
  return telemetryStorage(cwd).readJsonl("telemetry/events").filter((event) => event?.schemaVersion === ROADMAP_TELEMETRY_SCHEMA_VERSION && event?.cohortVersion);
}
function auditRoadmapTelemetryPrivacy(events = []) {
  let forbiddenFieldCount = 0;
  let malformedEventCount = 0;
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) { malformedEventCount++; continue; }
    forbiddenFieldCount += Object.keys(event).filter((key) => !TELEMETRY_ALLOWED_FIELDS.has(key)).length;
  }
  return { forbiddenContentStored: forbiddenFieldCount > 0, forbiddenFieldCount, malformedEventCount };
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}
function ratio(numerator, denominator) { return denominator ? numerator / denominator : null; }

function summarizeRoadmapTelemetry(events = [], options = {}) {
  const cohortVersion = safeToken(options.cohortVersion, ROADMAP_COHORT_VERSION, 120);
  const excludedSessionToken = options.excludeSessionToken ? safeToken(options.excludeSessionToken, "none", 120) : null;
  const cohort = events.filter((event) => event?.schemaVersion === ROADMAP_TELEMETRY_SCHEMA_VERSION && event.cohortVersion === cohortVersion);
  const rows = excludedSessionToken ? cohort.filter((event) => event.sessionToken !== excludedSessionToken) : cohort;
  const interactive = rows.filter((event) => event.sessionKind === "interactive" && event.operation !== "input_opportunity");
  const sessions = new Set(interactive.map((event) => event.sessionToken).filter((token) => token && token !== "unknown"));
  const terminal = interactive.filter((event) => ["succeeded", "domain-negative", "infrastructure-failed"].includes(event.outcome));
  const errors = terminal.filter((event) => event.outcome !== "succeeded");
  const addSubtaskAll = terminal.filter((event) => event.operation === "add_subtask");
  const addSubtask = addSubtaskAll.filter((event) => event.requestValidity === "valid");
  const opportunities = rows.filter((event) => event.sessionKind === "interactive" && event.operation === "input_opportunity" && event.eligible);
  const mutationRows = terminal.filter((event) => !["show", "export", "report"].includes(event.operation));
  const latest = rows.at(-1) || null;
  return {
    evidenceClass: "exact-version-field",
    schemaVersion: ROADMAP_TELEMETRY_SCHEMA_VERSION,
    cohortVersion,
    excludedActiveSession: excludedSessionToken ? { requested: true, matchedEvents: cohort.length - rows.length } : { requested: false, matchedEvents: 0 },
    sample: { events: rows.length, interactiveOperations: terminal.length, independentInteractiveSessions: sessions.size, firstAt: rows[0]?.at || null, lastAt: latest?.at || null },
    reliability: { errors: errors.length, errorRate: ratio(errors.length, terminal.length), addSubtaskAttempts: addSubtask.length, invalidAddSubtaskRequests: addSubtaskAll.length - addSubtask.length, addSubtaskSuccesses: addSubtask.filter((event) => event.outcome === "succeeded").length, addSubtaskSuccessRate: ratio(addSubtask.filter((event) => event.outcome === "succeeded").length, addSubtask.length), corrections: rows.filter((event) => event.correction).length },
    efficiency: { mutationResults: mutationRows.length, totalMutationResultChars: mutationRows.reduce((sum, event) => sum + finite(event.resultChars), 0), mutationResultP99Chars: percentile(mutationRows.map((event) => event.resultChars), 99), mutationDeltaP99Chars: percentile(mutationRows.map((event) => event.deltaChars), 99) },
    actionability: { latestActionableCount: latest?.actionableCount ?? null, latestNonActionableCount: latest?.nonActionableCount ?? null, latestBlockedCount: latest?.blockedCount ?? null },
    evidence: { latestBindings: latest?.evidenceBindingCount ?? null, latestUnsupportedVerificationCount: latest?.unsupportedVerificationCount ?? null },
    usage: { eligibleOpportunities: opportunities.length, adoptedOpportunities: opportunities.filter((event) => event.adopted).length, adoptionRate: ratio(opportunities.filter((event) => event.adopted).length, opportunities.length), settledObservations: rows.filter((event) => event.settled).length },
  };
}

function createRoadmapFieldReport({ events = [], excludeSessionToken, cohortVersion = ROADMAP_COHORT_VERSION, fixtureHash = null, deterministic = {}, generatedAt = new Date().toISOString() } = {}) {
  const exactVersion = summarizeRoadmapTelemetry(events, { excludeSessionToken, cohortVersion });
  const privacyEvents = events.filter((event) => event?.schemaVersion === ROADMAP_TELEMETRY_SCHEMA_VERSION && event.cohortVersion === cohortVersion && (!excludeSessionToken || event.sessionToken !== excludeSessionToken));
  const privacyAudit = auditRoadmapTelemetryPrivacy(privacyEvents);
  const fieldReady = exactVersion.sample.independentInteractiveSessions >= 30;
  const deterministicSourceMatches = deterministic.sourceVersion === cohortVersion;
  const deterministicFixtureMatches = !fixtureHash || deterministic.fixtureHash === fixtureHash;
  const deterministicPassed = deterministic.status === "passed" && deterministicSourceMatches && deterministicFixtureMatches;
  const addSubtaskMeasured = exactVersion.reliability.addSubtaskAttempts > 0 && exactVersion.reliability.addSubtaskSuccessRate != null;
  const reliabilityPassed = fieldReady && addSubtaskMeasured && exactVersion.reliability.errorRate != null && exactVersion.reliability.errorRate < 0.01 && exactVersion.reliability.addSubtaskSuccessRate >= 0.99;
  const privacyPassed = !privacyAudit.forbiddenContentStored && privacyAudit.malformedEventCount === 0;
  const activeSessionExclusionPassed = exactVersion.excludedActiveSession.requested === true;
  return {
    schemaVersion: 1,
    generatedAt,
    sourceVersion: cohortVersion,
    configVersion: { roadmapSchemaVersion: 3, mutationEnvelopeSchemaVersion: 1, telemetrySchemaVersion: ROADMAP_TELEMETRY_SCHEMA_VERSION, telemetryEnabled: process.env.PI_ROADMAP_TELEMETRY !== "0" },
    fixtureHash,
    privacy: { aggregateOnly: true, ...privacyAudit, activeSessionExclusion: excludeSessionToken ? "exact-token" : "not-requested", rawSessionContentRead: false },
    historicalBaseline: HISTORICAL_BASELINE,
    exactVersion,
    deterministic,
    gates: {
      deterministic: deterministicPassed ? "pass" : "not-proven",
      independentFieldSample: fieldReady ? "pass" : "blocked-insufficient-sample",
      fieldReliability: reliabilityPassed ? "pass" : fieldReady ? "fail" : "blocked-insufficient-sample",
      activeSessionExclusion: activeSessionExclusionPassed ? "pass" : fieldReady ? "fail" : "blocked-insufficient-sample",
      privacy: privacyPassed ? "pass" : "fail",
    },
    decision: deterministicPassed && reliabilityPassed && activeSessionExclusionPassed && privacyPassed ? "ship" : deterministicPassed && !fieldReady && privacyPassed ? "no-go-deferred" : "no-go",
    blockers: [
      ...(!deterministicPassed ? [!deterministicSourceMatches ? "deterministic verification does not match the exact source cohort" : !deterministicFixtureMatches ? "deterministic verification does not match the frozen fixture" : "deterministic verification is not proven"] : []),
      ...(!fieldReady ? [`exact-version cohort has ${exactVersion.sample.independentInteractiveSessions}/30 independent interactive sessions`] : []),
      ...(fieldReady && !addSubtaskMeasured ? ["exact-version cohort has no valid add_subtask reliability observations"] : []),
      ...(fieldReady && addSubtaskMeasured && !reliabilityPassed ? ["exact-version reliability bars are not met"] : []),
      ...(fieldReady && !activeSessionExclusionPassed ? ["exact active-session exclusion was not requested"] : []),
      ...(!privacyPassed ? ["roadmap telemetry privacy projection is not proven clean"] : []),
    ],
  };
}

module.exports = {
  ROADMAP_TELEMETRY_SCHEMA_VERSION,
  ROADMAP_COHORT_VERSION,
  HISTORICAL_BASELINE,
  createRoadmapSessionToken,
  roadmapOpportunityEligible,
  roadmapCohortVersion,
  roadmapTelemetryFile,
  createRoadmapTelemetryEvent,
  recordRoadmapTelemetry,
  readRoadmapTelemetry,
  auditRoadmapTelemetryPrivacy,
  summarizeRoadmapTelemetry,
  createRoadmapFieldReport,
};
