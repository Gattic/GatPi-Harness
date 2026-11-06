"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CANONICAL_OUTCOMES, normalizeOutcome, inferOutcome } = require("../src/outcome-schema");
const {
  createExtensionTelemetry,
  createTelemetryEvent,
  readTelemetryEvents,
  readPromptSuggestionTelemetryEvents,
  readExtensionTelemetry,
  instrumentExtensionCommands,
  inferExtensionId,
  contextSessionKind,
  compareExtensionCohorts,
  inferExtensionSourceFile,
  inferExtensionSourceFingerprint,
  sourceFingerprintForFile,
  FIXED_OPPORTUNITY_TRIGGERS,
} = require("../src/extension-telemetry");
assert.equal(contextSessionKind({ mode: "tui", hasUI: true }), "interactive");
assert.equal(contextSessionKind({ mode: "rpc", hasUI: true }), "headless-smoke", "RPC/tool smokes must not pollute the interactive cohort");
assert.equal(contextSessionKind({ mode: "rpc", hasUI: true, sessionKind: "interactive" }), "headless-smoke", "headless execution mode overrides UI-like session hints");
assert.equal(inferExtensionId("at extension (/repo/.pi/extensions/runtime-doctor/index.ts:10:2)"), "runtime-doctor");
assert.equal(inferExtensionId("at extension (/repo/extensions/prompt-suggestions/index.ts:10:2)"), "prompt-suggestions");
assert.equal(inferExtensionSourceFile("at extension (/repo/extensions/prompt-suggestions/index.ts:10:2)"), "/repo/extensions/prompt-suggestions/index.ts");
const configuredRegistry = require("../src/extension-registry").scanExtensionRegistry({ cwd: process.cwd(), settings: false, extensionPaths: [path.join(process.cwd(), ".pi", "extensions"), path.join(process.cwd(), "extensions")] });
const { tmpFixture } = require("./helpers/tmp-fixture");
const commandExtensions = configuredRegistry.extensions.filter((extension) => extension.commands.length > 0);
assert.equal(commandExtensions.length, 48, "the configured fleet has 48 command-bearing extensions, including /queue-status");
assert.deepEqual(commandExtensions.filter((extension) => !fs.readFileSync(extension.file, "utf8").includes("instrumentExtensionCommands")).map((extension) => extension.name), [], "every command-bearing configured extension opts into metadata-only command telemetry");
const modelToolExtensions = configuredRegistry.extensions.filter((extension) => extension.tools.length > 0 && extension.name !== "role-sidecar");
assert.deepEqual(modelToolExtensions.filter((extension) => !fs.readFileSync(extension.file, "utf8").includes("instrumentExtensionCommands")).map((extension) => extension.name), [], "every parent-runtime model tool opts into metadata-only lifecycle telemetry");

assert.deepEqual(CANONICAL_OUTCOMES, ["succeeded", "domain-negative", "blocked", "not-applicable", "cancelled", "timed-out", "infrastructure-failed", "unknown"]);
assert.equal(normalizeOutcome("timed_out"), "timed-out");
assert.equal(normalizeOutcome("skipped"), "not-applicable");
assert.equal(normalizeOutcome("failed"), "unknown", "ambiguous legacy failures are not reinterpreted as post-v2 infrastructure truth");
assert.equal(inferOutcome({ status: "failed" }, { isError: false }), "domain-negative", "resolved semantic failures are not transport failures");
assert.equal(inferOutcome({ policyBlocks: 1 }), "blocked");
const observation = { feature: "tool-result-rendering", tool: "ast_search", action: "observed", inputChars: 1000, modelChars: 200, outputChars: 200, savedChars: 800, budgetTokens: 600 };
const sameClock = { clock: () => "2026-10-28T12:00:00.000Z" };
const firstCall = createTelemetryEvent("feature-signal", { ...observation, toolCallId: "first-private-id" }, sameClock);
const secondCall = createTelemetryEvent("feature-signal", { ...observation, toolCallId: "second-private-id" }, sameClock);
assert.notEqual(firstCall.eventId, secondCall.eventId, "identical results from distinct calls are not deduplicated");
assert.doesNotMatch(JSON.stringify([firstCall, secondCall]), /private-id/);
assert.equal(firstCall.modelChars, 200);
assert.equal(firstCall.budgetTokens, 600);
const canonicalFixtures = [
  ["Build Runner failed build", { status: "failed", ok: false }, { toolName: "build_project", operation: "build" }, "domain-negative"],
  ["Test Runner failed tests", { status: "failed", ok: false }, { toolName: "test_runner", operation: "run" }, "domain-negative"],
  ["Privacy Guard findings", { ok: false, findings: 2 }, { toolName: "privacy_guard", operation: "scan" }, "domain-negative"],
  ["Evidence Binder missing proof", { ok: false }, { toolName: "evidence_binder", operation: "check" }, "domain-negative"],
  ["Automation Loop safety block", { outcome: "blocked", blocked: true }, { toolName: "automation_loop", operation: "start", isError: true }, "blocked"],
  ["Run Deck bounded watch", { outcome: "timeout" }, { toolName: "run_deck", operation: "watch" }, "timed-out"],
  ["Git Evidence dirty readiness", { outcome: "domain-negative", ok: true }, { toolName: "gitevidence", operation: "readiness" }, "domain-negative"],
  ["Injected adapter crash", {}, { toolName: "fixture_adapter", operation: "run", isError: true }, "infrastructure-failed"],
];
for (const [label, details, context, expected] of canonicalFixtures) assert.equal(inferOutcome(details, context), expected, label);
assert.equal(inferOutcome({ ok: true, summary: { findings: 2 } }, { toolName: "semgrep_scan", operation: "scan" }), "domain-negative", "static findings are semantic negatives even when the scanner ran successfully");
assert.equal(inferOutcome({ ok: false, reason: "command-failed" }, { toolName: "semgrep_scan", operation: "scan" }), "infrastructure-failed", "scanner process failure remains infrastructure failure");

const tmp = tmpFixture("pi-extension-telemetry-");
const stateDir = path.join(tmp, "state");
const clockValues = [
  "2026-07-25T20:00:00.000Z", "2026-07-25T20:00:01.000Z", "2026-07-25T20:00:02.000Z",
  "2026-07-25T20:00:03.000Z", "2026-07-25T20:00:04.000Z", "2026-07-25T20:00:05.000Z",
];
const telemetry = createExtensionTelemetry({ cwd: tmp, stateDir, extension: "obsidian", version: "v1", sourceFingerprint: "source_aaaaaaaaaaaaaaaa", clock: () => clockValues.shift() || "2026-07-25T20:00:06.000Z" });
const sessionToken = telemetry.sessionToken("private-session-id");
assert.match(sessionToken, /^session_[a-f0-9]{24}$/);
telemetry.emit("command", { commandId: "fixture-command", outcome: "succeeded", sessionKind: "interactive", sessionToken, arguments: "PRIVATE_ARGUMENT_FIXTURE", path: "/private/project", output: "PRIVATE_OUTPUT_FIXTURE" });
telemetry.promptSuggestion("local", "generated", "succeeded", 3);
telemetry.promptSuggestion("hermes", "refined", "succeeded", 450);
telemetry.promptSuggestion("hermes", "timed-out", "timed-out", 10000, "timeout");
telemetry.contextInjection(321, "first", true, 900, "interactive", sessionToken);
telemetry.autoRouter("suggested", "planning-advisory", "unknown", "route_1");
telemetry.recommendation("router", "shown", "planning-advisory", "high", "unknown", "interactive", sessionToken);
telemetry.recommendation("router", "accepted", "planning-advisory", "high", "succeeded", "interactive", sessionToken);
telemetry.recommendation("skill", "dismissed", "skill-safe-review", "medium", "unknown", "interactive", sessionToken);
telemetry.recommendation("skill", "overridden", "skill-noisy", "low", "unknown", "interactive", sessionToken);
telemetry.recommendation("skill", "corrected", "skill-wrong", "low", "unknown", "interactive", sessionToken);
telemetry.opportunity("research-vault-intent", "eligible", true, "helpful", "not-applicable", "interactive", sessionToken);
telemetry.featureSignal("output-compactor", "compacted", { tool: "codegraph_query", reason: "codegraph_query", outcome: "succeeded", sessionKind: "interactive", sessionToken, inputChars: 10000, outputChars: 2000, durationMs: 3 });
telemetry.featureSignal("output-compactor", "bypassed", { tool: "semgrep_scan", reason: "outside-canary", outcome: "not-applicable", sessionKind: "interactive", sessionToken, inputChars: 4000, outputChars: 4000, durationMs: 2 });
const events = readTelemetryEvents({ cwd: tmp, stateDir });
assert.equal(events.length, 14);
assert.equal(readTelemetryEvents({ cwd: tmp, stateDir, sinceAt: "2026-07-25T20:00:02.000Z", untilAt: "2026-07-25T20:00:04.000Z" }).length, 3, "cohort reads are bounded by telemetry timestamps");
assert.equal(fs.statSync(telemetry.file).mode & 0o777, 0o600);
assert.equal(fs.statSync(path.dirname(telemetry.file)).mode & 0o777, 0o700);
const persisted = fs.readFileSync(telemetry.file, "utf8");
for (const forbidden of ["PRIVATE_ARGUMENT_FIXTURE", "PRIVATE_OUTPUT_FIXTURE", "/private/project", "private-session-id", '"arguments"', '"path"', '"output"']) assert(!persisted.includes(forbidden), `telemetry must omit ${forbidden}`);
assert.equal(fs.statSync(path.join(stateDir, "session-token.key")).mode & 0o777, 0o600);
const summary = readExtensionTelemetry({ cwd: tmp, stateDir });
assert.equal(summary.eventCount, 14);
assert.equal(summary.versionCohorts.length, 1);
assert.equal(summary.versionCohorts[0].sourceFingerprint, "source_aaaaaaaaaaaaaaaa");
assert.deepEqual({ raw: summary.rawEventCount, unique: summary.uniqueEventCount, duplicates: summary.duplicateEventCount, groups: summary.duplicateEventIdGroups }, { raw: 14, unique: 14, duplicates: 0, groups: 0 });
assert.equal(summary.commands[0].commandId, "fixture-command");
assert.deepEqual(
  { outcome: summary.promptSuggestions.find((row) => row.action === "timed-out").outcome, reasonCode: summary.promptSuggestions.find((row) => row.action === "timed-out").reasonCode },
  { outcome: "timed-out", reasonCode: "timeout" },
  "prompt telemetry preserves only the fixed categorical failure reason",
);
assert.equal(summary.contextInjections.chars, 321);
assert.equal(summary.contextInjections.renderedChars, 900);
assert.equal(summary.contextInjections.savedChars, 579);
assert.equal(summary.contextInjections.reductionPct, 64.33);
assert.equal(summary.contextInjections.averageChars, 321);
assert.equal(summary.contextInjections.interactive.averageChars, 321);
assert.deepEqual({ sessions: summary.interactiveCohort.sessions, observedDays: summary.interactiveCohort.observedDays, tokenCoverage: summary.interactiveCohort.tokenCoverage }, { sessions: 1, observedDays: 1, tokenCoverage: 1 });
assert.equal(summary.featureSignals.savedChars, 8000);
assert.equal(summary.featureSignals.reductionPct, 57.14);
assert.equal(summary.featureSignals.durationMs, 5);
assert.equal(summary.featureSignals.averageDurationMs, 2.5);
assert.equal(summary.featureSignals.rows.find((row) => row.action === "compacted").averageDurationMs, 3);
assert.equal(summary.featureSignals.rows.find((row) => row.action === "bypassed").savedChars, 0, "a bypass must not report false savings");
assert.equal(summary.featureSignals.rows.find((row) => row.action === "compacted").tool, "codegraph_query", "a saving is attributable to the tool that produced the result");
assert.equal(summary.featureSignals.rows.find((row) => row.action === "bypassed").tool, "semgrep_scan");
assert.deepEqual(summary.contextInjections.breakdown[0], { extension: "obsidian", reason: "first", sessionKind: "interactive", count: 1, chars: 321, renderedChars: 900, savedChars: 579 });
assert.equal(summary.autoRouter[0].route, "planning-advisory");
assert.deepEqual({ shown: summary.recommendations.shown, reviewed: summary.recommendations.reviewed, accepted: summary.recommendations.accepted, dismissed: summary.recommendations.dismissed, overridden: summary.recommendations.overridden, corrected: summary.recommendations.corrected, precision: summary.recommendations.precision, correctionRate: summary.recommendations.correctionRate }, { shown: 1, reviewed: 3, accepted: 1, dismissed: 1, overridden: 1, corrected: 1, precision: 0.3333, correctionRate: 0.6667 });
assert.deepEqual({ eligible: summary.opportunities.eligible, acted: summary.opportunities.acted, actionRate: summary.opportunities.actionRate, valued: summary.opportunities.valued, helpful: summary.opportunities.helpful, valueRate: summary.opportunities.valueRate }, { eligible: 1, acted: 1, actionRate: 1, valued: 0, helpful: 0, valueRate: null }, "an inline self-rating is not an explicit human opportunity review");
assert.equal(summary.privacy.containsArguments, false);
assert.deepEqual([...FIXED_OPPORTUNITY_TRIGGERS].sort(), ["ci-pr-intent", "codegraph-query-intent", "evidence-artifact-intent", "extension-ops-intent", "managed-long-run-monitor-intent", "memory-governance-intent", "performance-intent", "plan-fanout-intent", "research-vault-intent", "security-scan-intent", "semantic-edit-intent", "topology-admin-intent", "workflow-plan-intent"]);
const unknownOpportunity = createTelemetryEvent("opportunity", { extension: "fixture-extension", version: "v1", triggerId: "prompt-derived-private-trigger", eligibility: "eligible", sessionKind: "interactive" }, { clock: () => "2026-07-25T20:02:00.000Z" });
assert.equal(unknownOpportunity.triggerId, "unknown", "opportunity denominators accept only reviewed fixed triggers");
assert.equal(unknownOpportunity.eligibility, "unknown");
assert.equal(unknownOpportunity.acted, false);
assert.equal(unknownOpportunity.value, "unknown");
// Injection and opportunity events previously carried no outcome at all, so a
// reader could not tell a delivered injection from one with nothing to deliver.
const injectionEvent = events.find((event) => event.kind === "context-injection");
assert.equal(injectionEvent.outcome, "succeeded");
assert.equal(events.find((event) => event.kind === "opportunity").outcome, "succeeded");
const emptyInjection = createTelemetryEvent("context-injection", { extension: "reasoning-runtime", version: "v1", chars: 0, renderedChars: 0, reason: "unchanged", changed: false }, { clock: () => "2026-07-25T20:02:00.000Z" });
assert.equal(emptyInjection.outcome, "not-applicable", "an injection with no delivered characters is not a success");
assert.equal(emptyInjection.changed, false);
const ineligibleOpportunity = createTelemetryEvent("opportunity", { extension: "obsidian", version: "v1", triggerId: "research-vault-intent", eligibility: "ineligible", acted: false, value: "unknown", coreDisplacement: "not-applicable" }, { clock: () => "2026-07-25T20:02:00.000Z" });
assert.equal(ineligibleOpportunity.outcome, "not-applicable");
for (const event of [injectionEvent, emptyInjection, ineligibleOpportunity]) assert.ok(CANONICAL_OUTCOMES.includes(event.outcome), `outcome must be canonical: ${event.outcome}`);
assert.equal(unknownOpportunity.coreDisplacement, "unknown");
const sanitizedPromptReason = createTelemetryEvent("prompt-suggestion", { extension: "prompt-suggestions", version: "v1", source: "hermes", action: "failed", outcome: "infrastructure-failed", reasonCode: "private-customer-identifier" }, { clock: () => "2026-07-25T20:02:01.000Z" });
assert.equal(sanitizedPromptReason.reasonCode, "other", "prompt telemetry accepts only reviewed categorical reason codes");

const sourceFixture = path.join(tmp, "source-fixture.ts");
fs.writeFileSync(sourceFixture, "export const exact = true;\n");
assert.match(sourceFingerprintForFile(sourceFixture), /^source_[a-f0-9]{16}$/);
const extensionFixture = path.join(tmp, "extensions", "fixture", "index.ts");
fs.mkdirSync(path.dirname(extensionFixture), { recursive: true });
fs.writeFileSync(extensionFixture, "export default function fixture() {}\n");
assert.equal(inferExtensionSourceFingerprint(`at fixture (${extensionFixture}:10:2)`), sourceFingerprintForFile(extensionFixture));
const cohortStateDir = path.join(tmp, "cohort-state");
createExtensionTelemetry({ cwd: tmp, stateDir: cohortStateDir, extension: "sample", version: "before", sourceFingerprint: "source_1111111111111111", clock: () => "2026-07-25T21:00:00.000Z" }).modelTool("sample_tool", "status", "infrastructure-failed", "interactive", 10);
createExtensionTelemetry({ cwd: tmp, stateDir: cohortStateDir, extension: "sample", version: "before-metadata-only", sourceFingerprint: "source_1111111111111111", clock: () => "2026-07-25T21:30:00.000Z" }).modelTool("sample_tool", "status", "succeeded", "interactive", 9);
createExtensionTelemetry({ cwd: tmp, stateDir: cohortStateDir, extension: "sample", version: "after", sourceFingerprint: "source_2222222222222222", clock: () => "2026-07-25T22:00:00.000Z" }).modelTool("sample_tool", "status", "succeeded", "interactive", 8);
const cohortSummary = readExtensionTelemetry({ cwd: tmp, stateDir: cohortStateDir });
assert.equal(cohortSummary.versionCohorts.length, 3);
assert.equal(cohortSummary.sourceTransitions.length, 1);
const comparison = compareExtensionCohorts(cohortSummary, { extension: "sample" });
assert.equal(comparison.outcome, "succeeded");
assert.equal(comparison.before.sourceFingerprint, "source_1111111111111111");
assert.equal(comparison.after.sourceFingerprint, "source_2222222222222222");
assert.equal(comparison.before.versions.length, 2, "coarse version-label drift stays inside one exact-source cohort");
assert.equal(comparison.operations[0].beforeNegativeRate, 0.5);
assert.equal(comparison.operations[0].afterNegativeRate, 0);

const duplicateStateDir = path.join(tmp, "duplicate-state");
const duplicateTelemetry = createExtensionTelemetry({ cwd: tmp, stateDir: duplicateStateDir, extension: "fixture-extension", version: "v1", clock: () => "2026-07-25T20:03:00.000Z" });
const firstDuplicate = duplicateTelemetry.command("same-command", "succeeded", "interactive", duplicateTelemetry.sessionToken("duplicate-session"));
const suppressedDuplicate = duplicateTelemetry.command("same-command", "succeeded", "interactive", firstDuplicate.event.sessionToken);
assert.equal(suppressedDuplicate.skipped, true, "repeated identical event IDs are suppressed on write");
assert.equal(fs.readFileSync(duplicateTelemetry.file, "utf8").trim().split(/\n/).length, 1);
fs.appendFileSync(duplicateTelemetry.file, `${JSON.stringify(firstDuplicate.event)}\n`);
const duplicateSummary = readExtensionTelemetry({ cwd: tmp, stateDir: duplicateStateDir });
assert.deepEqual({ raw: duplicateSummary.rawEventCount, unique: duplicateSummary.uniqueEventCount, duplicates: duplicateSummary.duplicateEventCount, groups: duplicateSummary.duplicateEventIdGroups }, { raw: 2, unique: 1, duplicates: 1, groups: 1 }, "historical duplicate rows are observable but aggregate once");

const legacyPromptRows = [
  { schemaVersion: 1, timestamp: "2026-07-25T20:00:02.500Z", kind: "prompt-suggestion", extension: "prompt-suggestions", version: "legacy", source: "hermes", action: "shown", outcome: "succeeded", latencyMs: 0, eventId: "legacy-valid", prompt: "PRIVATE_LEGACY_PROMPT" },
  { schemaVersion: 1, timestamp: "2026-07-25T20:00:02.600Z", kind: "prompt-suggestion", extension: "prompt-suggestions", version: "legacy", source: "hermes", action: "failed", outcome: "failed", latencyMs: 1, eventId: "legacy-ambiguous" },
  { schemaVersion: 2, timestamp: "2026-07-25T20:00:02.700Z", kind: "prompt-suggestion", extension: "prompt-suggestions", version: "legacy", source: "hermes", action: "shown", outcome: "succeeded", latencyMs: 0, eventId: "legacy-unsupported" },
];
fs.appendFileSync(telemetry.file, [...legacyPromptRows, legacyPromptRows[0]].map((row) => JSON.stringify(row)).join("\n") + "\n");
assert.equal(readTelemetryEvents({ cwd: tmp, stateDir }).length, 14, "general telemetry does not reinterpret legacy schemas");
const currentSessionExcludedSummary = readExtensionTelemetry({ cwd: tmp, stateDir, excludeSessionToken: sessionToken });
assert.equal(currentSessionExcludedSummary.interactiveCohort.sessions, 0, "current privacy-tokenized session can be excluded exactly");
assert.equal(currentSessionExcludedSummary.opportunities.eligible, 0, "current-session opportunity rows are removed from utility denominators");
assert(currentSessionExcludedSummary.interactiveCohort.excludedEvents > 0);
const compatiblePromptRows = readPromptSuggestionTelemetryEvents({ cwd: tmp, stateDir, sinceAt: "2026-07-25T20:00:02.000Z", untilAt: "2026-07-25T20:00:03.000Z" });
assert.deepEqual(compatiblePromptRows.map((row) => row.eventId), ["legacy-valid"], "prompt policy continuity accepts only strictly compatible schema-v1 metadata");
assert.equal(compatiblePromptRows[0].prompt, undefined, "prompt policy compatibility returns only fixed metadata fields");

const coverageStateDir = path.join(tmp, "coverage-state");
const coverageTelemetry = createExtensionTelemetry({ cwd: tmp, stateDir: coverageStateDir, extension: "coverage-fixture", version: "v1" });
const coverageToken = coverageTelemetry.sessionToken("current-session");
coverageTelemetry.command("linked", "succeeded", "interactive", coverageToken);
coverageTelemetry.emit("command", { commandId: "unlinked", outcome: "succeeded", sessionKind: "interactive" });
const excludedCoverage = readExtensionTelemetry({ cwd: tmp, stateDir: coverageStateDir, excludeSessionToken: coverageToken });
assert.equal(excludedCoverage.eventCount, 1, "unlinked interactive rows remain visible to the coverage denominator");
assert.equal(excludedCoverage.interactiveCohort.sessions, 0);
assert.equal(excludedCoverage.interactiveCohort.tokenCoverage, 0);
assert.equal(excludedCoverage.interactiveCohort.gatingSafe, false);

const sanitized = createTelemetryEvent("command", { extension: "/private/extension/path", version: "v1", commandId: "command with private args", outcome: "success", prompt: "PRIVATE_PROMPT_FIXTURE" }, { clock: () => "2026-07-25T20:01:00.000Z" });
assert.equal(sanitized.extension, "unknown");
assert.equal(sanitized.commandId, "unknown");
assert.equal(sanitized.outcome, "succeeded");
assert.equal(sanitized.prompt, undefined);
const disabled = createExtensionTelemetry({ cwd: tmp, stateDir: path.join(tmp, "disabled-state"), extension: "disabled", version: "v1", enabled: false });
assert.equal(disabled.command("no-write", "succeeded").skipped, true);
assert.equal(fs.existsSync(disabled.file), false, "PI_EXTENSION_TELEMETRY=0 provides a no-write rollback control");
const unusableStateDir = path.join(tmp, "not-a-directory");
fs.writeFileSync(unusableStateDir, "fixture");
assert.equal(createExtensionTelemetry({ cwd: tmp, stateDir: unusableStateDir, extension: "fixture", version: "v1" }).sessionToken("private-session"), "none", "tokenization failures degrade without breaking the extension");

const registered = [];
const toolDefs = [];
const fakePi = { registerCommand(name, options) { registered.push({ name, options }); }, registerTool(definition) { toolDefs.push(definition); }, on() {} };
const instrumented = instrumentExtensionCommands(fakePi, { extension: "command-fixture", version: "v2", outcomePolicies: { fixture_check: { run: "domain-negative" } } });
instrumented.registerCommand("safe-command", { handler: async () => ({ details: { status: "not-applicable" } }) });
instrumented.registerCommand("failed-command", { handler: async () => { throw new Error("PRIVATE_THROWN_MESSAGE"); } });
instrumented.registerTool({ name: "fixture_check", execute: async () => ({ content: [], details: { status: "failed", ok: false, privatePath: "/PRIVATE/TOOL/PATH" } }) });
instrumented.registerTool({ name: "fixture_adapter", execute: async () => { throw new Error("PRIVATE_ADAPTER_CRASH"); } });
(async () => {
  const ctx = { cwd: tmp, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "instrumented-session" } };
  await registered[0].options.handler("PRIVATE_COMMAND_ARGUMENTS", ctx);
  await assert.rejects(() => registered[1].options.handler("PRIVATE_COMMAND_ARGUMENTS", ctx), /PRIVATE_THROWN_MESSAGE/);
  await toolDefs[0].execute("private-call-id", { operation: "run", path: "/PRIVATE/TOOL/PATH" }, undefined, undefined, ctx);
  await assert.rejects(() => toolDefs[1].execute("private-call-id-2", { operation: "probe", secret: "PRIVATE_TOOL_ARGUMENT" }, undefined, undefined, ctx), /PRIVATE_ADAPTER_CRASH/);
  const instrumentedEvents = readTelemetryEvents({ cwd: tmp }).filter((event) => event.extension === "command-fixture");
  const commandEvents = instrumentedEvents.filter((event) => event.kind === "command");
  assert.deepEqual(Object.fromEntries(commandEvents.map((event) => [event.commandId, event.outcome])), { "safe-command": "not-applicable", "failed-command": "infrastructure-failed" });
  const modelEvents = instrumentedEvents.filter((event) => event.kind === "model-tool");
  assert.deepEqual(Object.fromEntries(modelEvents.map((event) => [event.tool, [event.operation, event.outcome, event.sessionKind]])), {
    fixture_check: ["run", "domain-negative", "interactive"],
    fixture_adapter: ["other", "infrastructure-failed", "interactive"],
  });
  const commandFile = path.join(tmp, ".pi", "extension-telemetry", "events.jsonl");
  const instrumentedText = fs.readFileSync(commandFile, "utf8");
  for (const forbidden of ["PRIVATE_COMMAND_ARGUMENTS", "PRIVATE_THROWN_MESSAGE", "/PRIVATE/TOOL/PATH", "PRIVATE_TOOL_ARGUMENT", "private-call-id", "PRIVATE_ADAPTER_CRASH", "\"probe\""]) assert(!instrumentedText.includes(forbidden));
  const instrumentedSummary = readExtensionTelemetry({ cwd: tmp });
  assert.equal(instrumentedSummary.modelTools.eligible, 2);
  assert.equal(instrumentedSummary.modelTools.unknown, 0);
  assert.equal(instrumentedSummary.modelTools.unknownRate, 0);
  console.log("extension telemetry tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
