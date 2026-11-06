"use strict";

const crypto = require("node:crypto");

const SCORECARD_SCHEMA_VERSION = 1;
const REQUIRED_COHORT_DAYS = 14;

function sha(value, length = 16) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, length); }
function isoMs(value) { const parsed = Date.parse(String(value || "")); return Number.isFinite(parsed) ? parsed : null; }
function ratio(numerator, denominator) { return denominator ? Number((Number(numerator || 0) / denominator).toFixed(4)) : null; }
function metric(id, label, status, measured, bar, evidence = []) { return { id, label, status, measured, bar, evidence }; }
function versionedTelemetryCohort(events = [], { sinceAt, requiredDays = REQUIRED_COHORT_DAYS, rateDenominatorEligible = false } = {}) {
  const sinceMs = isoMs(sinceAt);
  const eligible = events.filter((event) => {
    const at = isoMs(event.timestamp);
    return at !== null && (sinceMs === null || at >= sinceMs);
  }).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const groups = new Map();
  for (const event of eligible) {
    const extension = String(event.extension || "unknown");
    const version = String(event.version || "unknown");
    const key = `${extension}@${version}`;
    const row = groups.get(key) || { extension, version, eventCount: 0, firstAt: event.timestamp, lastAt: event.timestamp, kinds: {}, outcomes: {} };
    row.eventCount += 1;
    row.firstAt = String(event.timestamp) < row.firstAt ? event.timestamp : row.firstAt;
    row.lastAt = String(event.timestamp) > row.lastAt ? event.timestamp : row.lastAt;
    row.kinds[event.kind] = (row.kinds[event.kind] || 0) + 1;
    if (event.outcome) row.outcomes[event.outcome] = (row.outcomes[event.outcome] || 0) + 1;
    groups.set(key, row);
  }
  const firstMs = eligible.length ? isoMs(eligible[0].timestamp) : null;
  const lastMs = eligible.length ? isoMs(eligible.at(-1).timestamp) : null;
  const startMs = sinceMs ?? firstMs;
  const observedHours = startMs !== null && lastMs !== null && lastMs >= startMs ? Number(((lastMs - startMs) / 3_600_000).toFixed(2)) : 0;
  return {
    sinceAt: sinceAt || eligible[0]?.timestamp || null,
    requiredDays,
    observedHours,
    observedDays: Number((observedHours / 24).toFixed(2)),
    sufficient: observedHours >= requiredDays * 24,
    eventCount: eligible.length,
    rateDenominatorEligible: rateDenominatorEligible === true,
    classification: "metadata-events-not-joined-to-session-kind",
    firstAt: eligible[0]?.timestamp || null,
    lastAt: eligible.at(-1)?.timestamp || null,
    versions: Array.from(groups.values()).sort((a, b) => a.extension.localeCompare(b.extension) || a.version.localeCompare(b.version)),
    privacy: { metadataOnly: true, containsArguments: false, containsPrompts: false, containsPaths: false, containsOutputs: false },
  };
}
function publicRoleRollout(value = {}) {
  const keys = [
    "schemaVersion", "selectedVersion", "compatibilityMode", "mutationMode", "autoRouteMode", "sidecarEnabled",
    "requestedStage", "requestedStageSource", "stageAuthority", "eligibleStage", "evidenceAuthorizedStage", "evidenceOverride", "effectiveStage", "promotionAuthorized", "promotionReason",
    "benchmarkManifestHash", "benchmarkRuntimeSourceHash", "benchmarkEvidenceStatus", "fixtureOnlyAtR0", "fixtureExecution", "stateMigrationRequired", "preserveV2StateOnRollback",
  ];
  const safe = Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
  safe.benchmarkEvidencePresent = typeof value.benchmarkReport === "string" && value.benchmarkReport.length > 0;
  return safe;
}
function evaluatePhase7Scorecard(input = {}) {
  const cohort = versionedTelemetryCohort(input.telemetryEvents || [], { sinceAt: input.freeze?.cohortStartAt, requiredDays: input.requiredCohortDays || REQUIRED_COHORT_DAYS, rateDenominatorEligible: input.rateDenominatorEligible === true });
  const benchmark = input.roleBenchmark || {};
  const pilot = input.rolePilot || {};
  const inventory = input.inventory || {};
  const live = input.live || {};
  const audit = input.sessionAudit || {};
  const pilotMetrics = pilot.metrics || {};
  const pilotPass = pilot.status === "finished" && pilot.verdict === "pass" && Number(pilotMetrics.modelCalls || 0) >= 1 && Number(pilotMetrics.toolCalls || 0) === Number(pilotMetrics.toolResults || -1) && pilotMetrics.typedTermination === true;
  const deterministicRolePass = benchmark.promotion?.overallPassed === true && benchmark.promotion?.maxEligibleStage === "R4";
  const livePilotReliability = pilotPass ? { completionRate: 1, timeoutRate: 0, p95Ms: Number(pilotMetrics.totalDurationMs || 0), sample: 1 } : { completionRate: 0, timeoutRate: null, p95Ms: null, sample: Number(pilotMetrics.sample || 0) };
  const inventoryPass = Number(inventory.extensions) === 48 && Number(inventory.declaredTools) === 67 && Number(inventory.activeTools) === 59 && Number(inventory.degraded) === 0 && Number(inventory.conflicts) === 0 && Number(inventory.unexplained) === 0 && inventory.portfolioReconciled === true;
  const metrics = [
    metric("role-sidecar-launch", "Role sidecar launch", pilotPass ? "pass" : "fail", { status: pilot.status, ...pilotMetrics }, "0 load failures; >=1 model call; typed submit_role_result termination", pilot.evidence || []),
    metric("read-only-role-reliability", "Read-only role reliability", deterministicRolePass && pilotPass ? "pass" : "fail", { deterministicEligibleStage: benchmark.promotion?.maxEligibleStage || "R0", pilot: livePilotReliability }, "deterministic pass; pilot completion >=90%; timeout <=5%; p95 <=120s", input.roleEvidence || []),
    metric("semantic-outcome-truth", "Semantic outcome truth", live.semanticOutcomeParity === true ? "pass" : "fail", { parity: live.semanticOutcomeParity, postFixRoleRuns: input.roleAudit?.roleRuns?.total ?? null, postFixFindings: input.roleAudit?.findings || null }, "100% canonical status/termination agreement", live.semanticEvidence || []),
    metric("extension-inventory", "Extension inventory", inventoryPass ? "pass" : "fail", inventory, "48 records; runtime/source reconciliation; 0 unexplained discrepancies", inventory.evidence || []),
    metric("semgrep", "Semgrep reliability", live.semgrep?.smokePassed !== true ? "fail" : cohort.sufficient && Number(live.semgrep.infrastructureErrorRate) < 0.05 ? "pass" : "insufficient-data", { ...live.semgrep, cohortDays: cohort.observedDays }, "cold/default scan works; post-fix infrastructure error rate <5% over >=14 days", live.semgrep?.evidence || []),
    metric("obsidian-hermes", "Obsidian Hermes readiness", live.obsidian?.authReady === true && live.obsidian?.curationReady === true && live.obsidian?.dryRunPassed === true ? "pass" : "fail", live.obsidian || {}, "layered readiness truthful; bounded authenticated dry-run passes", live.obsidian?.evidence || []),
    metric("test-runner", "Test Runner semantics", live.testRunnerNotApplicable === true ? "pass" : "fail", { notApplicableSemantics: live.testRunnerNotApplicable }, "no-command/no-prior-failure are not-applicable", live.testRunnerEvidence || []),
    metric("cognitive-context", "Cognitive context efficiency", live.context?.deterministicReductionPct >= 60 && live.context?.correctnessPassed === true ? (cohort.sufficient ? "pass" : "insufficient-data") : "fail", { ...live.context, cohortDays: cohort.observedDays }, ">=60% live reduction with objective/constraint correctness over >=14 days", live.context?.evidence || []),
    metric("prompt-ui-telemetry", "Prompt/UI telemetry", live.promptTelemetry?.metadataOnly === true && Number(live.promptTelemetry?.events || 0) > 0 ? "pass" : "fail", live.promptTelemetry || {}, "shown/accepted/dismissed/failed metadata exists without text", live.promptTelemetry?.evidence || []),
    metric("privacy", "Privacy", live.privacy?.actionable === 0 && live.privacy?.telemetryRedactionPassed === true ? "pass" : "fail", live.privacy || {}, "0 actionable findings; telemetry redaction tests pass", live.privacy?.evidence || []),
    metric("portfolio", "Extension portfolio", inventory.portfolioReconciled === true && Number(inventory.portfolioRecords) === 48 && Number(inventory.toolDecisions) === 67 ? "pass" : "fail", { records: inventory.portfolioRecords, toolDecisions: inventory.toolDecisions, activeTools: inventory.activeTools }, "every custom tool has owner/trigger/overlap/metric/lifecycle decision", inventory.evidence || []),
  ];
  const counts = metrics.reduce((out, item) => { out[item.status] = (out[item.status] || 0) + 1; return out; }, {});
  const cohortAudit = {
    sourceVersion: audit.cohort?.sourceVersion || input.freeze?.sourceVersion || "unknown",
    configVersion: audit.cohort?.configVersion || input.freeze?.configVersion || "unknown",
    currentSessionExcluded: audit.cohort?.currentSessionExcluded === true,
    sessionKinds: audit.sessions?.classifications || {},
    analyzedFiles: Number(audit.sessions?.analyzedFiles || 0),
    invalidRows: Number(audit.sessions?.invalidRows || 0),
    observedInteractiveDays: Number(audit.cohort?.observedInteractiveDays || 0),
    eligibleForFourteenDayDecision: audit.cohort?.eligibleForFourteenDayDecision === true && Number(audit.cohort?.observedInteractiveDays || 0) >= REQUIRED_COHORT_DAYS && cohort.sufficient,
  };
  const hardFailure = metrics.some((item) => item.status === "fail");
  const insufficient = metrics.some((item) => item.status === "insufficient-data") || !cohort.sufficient || !cohort.rateDenominatorEligible || !cohortAudit.eligibleForFourteenDayDecision;
  const decision = hardFailure ? "no-go" : insufficient ? "no-go-deferred" : "ship";
  return {
    schemaVersion: SCORECARD_SCHEMA_VERSION,
    generatedAt: input.generatedAt || new Date().toISOString(),
    scorecardId: `phase7_${sha({ freeze: input.freeze, cohort, metrics: metrics.map(({ id, status, measured }) => ({ id, status, measured })) })}`,
    freeze: input.freeze,
    cohort,
    cohortAudit,
    roleRollout: publicRoleRollout(input.roleRollout || {}),
    metrics,
    summary: { pass: counts.pass || 0, fail: counts.fail || 0, insufficientData: counts["insufficient-data"] || 0, decision },
    release: {
      decision,
      reason: hardFailure ? "At least one ship bar failed." : insufficient ? "The mandatory versioned 14-day cohort is incomplete; irreversible release/promotion decisions remain blocked." : "All ship bars and cohort requirements passed.",
      irreversiblePortfolioChangesAllowed: decision === "ship",
      automaticMutatingDelegationAllowed: false,
    },
    privacy: { aggregateOnly: true, rawSessionContentPersisted: false, sourceBodiesPersisted: false, pathsPersisted: false },
  };
}
function renderPhase7Markdown(report) {
  const status = (value) => value === "pass" ? "PASS" : value === "fail" ? "FAIL" : "INSUFFICIENT DATA";
  const rows = report.metrics.map((item) => `| ${item.label} | **${status(item.status)}** | ${typeof item.measured === "string" ? item.measured : `\`${JSON.stringify(item.measured)}\``} | ${item.bar} |`);
  const versions = report.cohort.versions.map((item) => `| ${item.extension} | ${item.version} | ${item.eventCount} | ${item.firstAt || "n/a"} | ${item.lastAt || "n/a"} |`);
  return [
    "# Phase 7 post-fix release scorecard",
    "",
    `Generated: ${report.generatedAt}`,
    `Scorecard: \`${report.scorecardId}\``,
    "",
    "## Release decision",
    "",
    `**${report.summary.decision.toUpperCase()}** — ${report.release.reason}`,
    "",
    `- Source version: \`${report.freeze?.sourceVersion || "unknown"}\``,
    `- Runtime source hash: \`${report.freeze?.runtimeSourceHash || "unknown"}\``,
    `- Config version: \`${report.freeze?.configVersion || "unknown"}\``,
    `- Cohort: ${report.cohort.observedDays}/${report.cohort.requiredDays} days; raw metadata events=${report.cohort.eventCount}; rate-denominator eligible=${report.cohort.rateDenominatorEligible}; sufficient=${report.cohort.sufficient}`,
    `- Aggregate audit: current session excluded=${report.cohortAudit.currentSessionExcluded}; session kinds=${JSON.stringify(report.cohortAudit.sessionKinds)}; observed interactive days=${report.cohortAudit.observedInteractiveDays}; eligible=${report.cohortAudit.eligibleForFourteenDayDecision}`,
    `- Metrics: pass=${report.summary.pass}, fail=${report.summary.fail}, insufficient-data=${report.summary.insufficientData}`,
    `- Role rollout: requested=${report.roleRollout.requestedStage || "n/a"}; eligible=${report.roleRollout.eligibleStage || "n/a"}; evidence-authorized=${report.roleRollout.evidenceAuthorizedStage || "n/a"}; effective=${report.roleRollout.effectiveStage || "n/a"}; authority=${report.roleRollout.stageAuthority || report.roleRollout.requestedStageSource || "n/a"}; evidence override=${report.roleRollout.evidenceOverride === true}`,
    "",
    "## Ship bars",
    "",
    "| Area | Status | Measured | Bar |",
    "|---|---|---|---|",
    ...rows,
    "",
    "## Exact telemetry versions after the freeze (unjoined metadata; not a rate denominator)",
    "",
    "| Extension | Version | Events | First | Last |",
    "|---|---|---:|---|---|",
    ...(versions.length ? versions : ["| none | none | 0 | n/a | n/a |"]),
    "",
    "## Claim boundary",
    "",
    "Deterministic, focused, smoke, privacy, and full-suite evidence may pass while the release decision remains deferred. Calls before the frozen source/config boundary and lifetime audit rates are not used as post-fix success evidence. Test/smoke sessions remain separate from interactive sessions. No prompt, transcript, reasoning, raw command, raw tool output, credential, source body, or session path is included in this scorecard.",
    "",
    "R4 is the deterministic advisory ceiling. Missing benchmark evidence falls back to R0; `PI_ROLE_ROLLOUT_STAGE=R0` or `PI_ROLE_RUNTIME_VERSION=1` is the immediate rollback. R5 and hidden automatic mutation remain unauthorized without a separate bounded real-project pilot.",
    "",
  ].join("\n");
}

module.exports = { SCORECARD_SCHEMA_VERSION, REQUIRED_COHORT_DAYS, ratio, versionedTelemetryCohort, publicRoleRollout, evaluatePhase7Scorecard, renderPhase7Markdown };
