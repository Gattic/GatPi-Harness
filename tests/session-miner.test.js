#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  commandFamilies,
  classifyProviderError,
  classifyToolError,
  buildCohortContract,
  compareCohortContracts,
  mineAgentSessions,
  readSessionMiningReport,
  sessionMiningOutcomes,
  formatSessionMiningReport,
} = require("../src/session-miner");
const { createExtensionTelemetry } = require("../src/extension-telemetry");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-session-miner-");
const roots = {
  claude: path.join(tmp, "private-claude-project"),
  codex: path.join(tmp, "private-codex-project"),
  pi: path.join(tmp, "private-pi-project"),
};
for (const root of Object.values(roots)) fs.mkdirSync(root, { recursive: true });
const now = "2026-07-11T12:00:00.000Z";
const secret = "sk-1234567890abcdefghijklmnop"; // Dummy placeholder used to verify redaction.
const privatePrompt = `Still persists again. Run private-customer-task with token ${secret}`;

function writeJsonl(file, rows) {
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const at = new Date(now);
  fs.utimesSync(file, at, at);
}

const claudeRows = [];
for (let i = 0; i < 5; i++) claudeRows.push({ type: "user", timestamp: now, message: { role: "user", content: privatePrompt } });
claudeRows.push(
  { type: "assistant", timestamp: now, message: { role: "assistant", content: [
    { type: "tool_use", id: "c-bash", name: "Bash", input: { command: `npm test --token ${secret} && git status` } },
    { type: "tool_use", id: "c-skill", name: "Skill", input: { skill: "durable-bug-hunt" } },
    { type: "tool_use", id: "c-read", name: "Read", input: { file_path: "/private/customer/file" } },
  ] } },
  { type: "user", timestamp: now, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c-bash", content: "private output", is_error: true }] } },
);
writeJsonl(path.join(roots.claude, "session.jsonl"), claudeRows);

writeJsonl(path.join(roots.codex, "rollout.jsonl"), [
  { timestamp: now, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Actually, use the requested workflow instead." }] } },
  { timestamp: now, type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "x1", arguments: JSON.stringify({ cmd: "cmake --build build && ctest --test-dir build" }) } },
  { timestamp: now, type: "response_item", payload: { type: "function_call_output", call_id: "x1", output: "private output" } },
  { timestamp: now, type: "event_msg", payload: { type: "exec_command_end", call_id: "x1", exit_code: 1, status: "failed", command: "private command", stderr: secret } },
]);

const piFile = path.join(roots.pi, "session.jsonl");
writeJsonl(piFile, [
  { type: "session", id: "s1", timestamp: now, cwd: "/private/customer/repo", interactive: true },
  { type: "message", id: "m1", timestamp: now, message: { role: "user", content: [{ type: "text", text: "No, that's not what I asked." }], timestamp: Date.parse(now) } },
  { type: "message", id: "m-provider-error", timestamp: now, message: { role: "assistant", content: [], stopReason: "error", errorMessage: `fetch failed for ${secret}`, timestamp: Date.parse(now) } },
  { type: "message", id: "m2", timestamp: now, message: { role: "assistant", content: [{ type: "toolCall", id: "p1", name: "edit", arguments: { path: "/private/customer/file", oldText: secret } }], stopReason: "toolUse", timestamp: Date.parse(now) } },
  { type: "message", id: "m3", timestamp: now, message: { role: "toolResult", toolCallId: "p1", toolName: "edit", isError: true, content: [{ type: "text", text: `Could not find the exact text in /private/customer/file containing ${secret}` }], timestamp: Date.parse(now) } },
  { type: "message", id: "m4-call", timestamp: now, message: { role: "assistant", content: [{ type: "toolCall", id: "p2", name: "test_runner", arguments: { profile: "changed" } }], stopReason: "toolUse", timestamp: Date.parse(now) } },
  { type: "message", id: "m4-result", timestamp: now, message: { role: "toolResult", toolCallId: "p2", toolName: "test_runner", isError: false, details: { status: "failed", error: `PRIVATE_SEMANTIC_FAILURE ${secret}` }, content: [{ type: "text", text: "transport succeeded" }], timestamp: Date.parse(now) } },
  { type: "message", id: "m5-call", timestamp: now, message: { role: "assistant", content: [{ type: "toolCall", id: "p3", name: "test_runner_empty", arguments: { profile: "changed" } }], stopReason: "toolUse", timestamp: Date.parse(now) } },
  { type: "message", id: "m5-result", timestamp: now, message: { role: "toolResult", toolCallId: "p3", toolName: "test_runner_empty", isError: false, details: { outcome: "not-applicable", status: "not-applicable", ok: null, reasonCode: "no-inferred-commands" }, content: [{ type: "text", text: "No repository-defined tests apply." }], timestamp: Date.parse(now) } },
]);

const stalePiFile = path.join(roots.pi, "stale-provider-failure.jsonl");
writeJsonl(stalePiFile, [
  { type: "session", id: "s2", timestamp: now, cwd: "/private/customer/repo", mode: "headless" },
  { type: "message", id: "s2-user", timestamp: now, message: { role: "user", content: "retry privately", timestamp: Date.parse(now) } },
  { type: "message", id: "s2-timeout", timestamp: now, message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Codex SSE response headers timed out after 300000ms", timestamp: Date.parse(now) } },
  { type: "message", id: "s2-websocket", timestamp: now, message: { role: "assistant", content: [], stopReason: "error", errorMessage: `WebSocket closed while handling ${secret}`, timestamp: Date.parse(now) } },
]);
const staleAt = new Date(Date.parse(now) - 2 * 60 * 60 * 1000);
fs.utimesSync(stalePiFile, staleAt, staleAt);

const unresolvedPiFile = path.join(roots.pi, "unresolved-provider-failure.jsonl");
writeJsonl(unresolvedPiFile, [
  { type: "session", id: "s3", timestamp: now, cwd: "/private/customer/repo", metadata: { fixture: true } },
  { type: "message", id: "s3-error", timestamp: now, message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Codex SSE response headers timed out after 300000ms", timestamp: Date.parse(now) } },
  { type: "message", id: "s3-user", timestamp: now, message: { role: "user", content: "retry pending", timestamp: Date.parse(now) } },
]);

assert.deepEqual(commandFamilies("cd /secret && cmake --build build | tail -20"), ["cd", "cmake --build", "tail"]);
assert.deepEqual(commandFamilies("/private/customer/test_binary --filter=x"), ["local-executable"]);
assert.equal(classifyProviderError("WebSocket closed 1006"), "transport");
assert.equal(classifyProviderError("input exceeds the context window"), "context-limit");
assert.equal(classifyProviderError("429 monthly usage limit reached"), "usage-limit");
assert.equal(classifyToolError("Could not find the exact text; oldText must match exactly"), "edit-match");
assert.equal(classifyToolError("No verification-center latest evidence found. Run /verify-run first."), "missing-prerequisite");

const stateDir = path.join(tmp, "state");
const extensionTelemetry = createExtensionTelemetry({ cwd: tmp, extension: "session-test", version: "v1", clock: () => now });
extensionTelemetry.emit("command", { commandId: "safe-id", outcome: "failed", arguments: privatePrompt, output: secret });
extensionTelemetry.contextInjection(240, "objective-changed", true);
const options = {
  cwd: tmp,
  stateDir,
  roots,
  now,
  sinceDays: 30,
  sourceVersion: "source-v1",
  runtimeSourceHash: "f".repeat(64),
  configVersion: "config-v1",
  thresholds: { minToolCalls: 1, minToolErrors: 1, minToolErrorRate: 0.01, minShellCount: 1, minWorkflowCount: 1 },
};
assert.throws(() => mineAgentSessions({ ...options, sinceDays: "not-a-number" }), /sinceDays must be a positive number/);
const expectedCohort = buildCohortContract(options);
assert.equal(expectedCohort.key, buildCohortContract(options).key, "fixed cohort inputs have a deterministic key");
assert.equal(compareCohortContracts(expectedCohort, expectedCohort).compatible, true);
const first = mineAgentSessions(options);
assert.deepEqual(first.cohort, expectedCohort);
assert.equal(first.trend.baseline, true);
assert.equal(first.trend.comparisonReason, "no-previous-report");
assert.equal(first.scan.scannedFiles, 5);
assert.equal(first.scan.reusedFiles, 0);
assert.equal(first.aggregate.total.sessions, 5);
assert.equal(first.aggregate.total.toolErrors, 3, "transport/tool errors remain separate and Codex duplicate output is upgraded once");
assert.equal(first.aggregate.total.toolSemanticFailures, 2, "only infrastructure/timeout outcomes feed generic reliability failures");
assert.equal(first.aggregate.semanticOutcomes.counts["infrastructure-failed"], 2);
assert.equal(first.aggregate.semanticOutcomes.counts["domain-negative"], 2, "failed checks and commands remain semantic negatives, not infrastructure faults");
assert.equal(first.aggregate.semanticOutcomes.counts["not-applicable"], 1);
assert.equal(first.aggregate.resultIntegrity.duplicateResults, 1);
assert.equal(first.aggregate.resultIntegrity.unmatchedCalls, 2);
assert.deepEqual(Object.fromEntries(first.aggregate.sessionKinds.map((row) => [row.name, row.count])), { unknown: 2, "deterministic-fixture": 1, "headless-smoke": 1, interactive: 1 });
assert.equal(first.extensionTelemetry.eventCount, 2);
assert.equal(first.extensionTelemetry.commands[0].commandId, "safe-id");
assert.equal(first.aggregate.repeatedPrompts.maxRepeat, 5);
assert.ok(first.aggregate.skills.some((row) => row.name === "durable-bug-hunt" && row.count === 1));
assert.ok(first.aggregate.shellFamilies.some((row) => row.name === "cmake --build"));
assert.ok(first.candidates.some((row) => row.classification === "tool-failure"));
assert.ok(!first.candidates.some((row) => row.classification === "tool-failure" && row.evidence?.tool === "test_runner_empty"), "not-applicable tool outcomes never create failure candidates");
assert.ok(!first.candidates.some((row) => row.classification === "tool-failure" && row.evidence?.tool === "test_runner"), "domain-negative test results never create generic tool-friction candidates");
assert.ok(first.candidates.some((row) => row.classification === "workflow-repetition"));
assert.ok(first.candidates.some((row) => row.classification === "provider-failure"));
assert.equal(first.aggregate.providerReliability.messages, 4);
assert.equal(first.aggregate.providerReliability.affectedSessions, 3);
assert.equal(first.aggregate.providerReliability.recoveredSessions, 1);
assert.equal(first.aggregate.providerReliability.terminalFailedSessions, 1);
assert.equal(first.aggregate.providerReliability.unresolvedSessions, 1);
assert.deepEqual(first.aggregate.providerReliability.categories.map(({ name, count }) => [name, count]), [["timeout", 2], ["transport", 2]]);
assert.ok(first.aggregate.providerReliability.staleTerminalStates.some((row) => row.name === "provider-failure" && row.count === 1));
assert.ok(first.aggregate.toolFailureCategories.some((row) => row.name === "edit-match" && row.count === 1));
assert.match(formatSessionMiningReport(first), /Pi provider errors=4/);
assert.match(formatSessionMiningReport(first), /unresolved=1/);
assert.match(formatSessionMiningReport(first), /aggregate-only/);

assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700, "session-mining state directory is private");
for (const file of [path.join(stateDir, "state.json"), path.join(stateDir, "latest.json"), path.join(stateDir, "history.jsonl")]) {
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${path.basename(file)} is private`);
  const persisted = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(persisted, new RegExp(secret));
  assert.doesNotMatch(persisted, /private-customer-task|private-customer-project|private\/customer/);
  assert.doesNotMatch(persisted, /npm test --token|cmake --build build/);
  assert.doesNotMatch(persisted, /fetch failed|WebSocket closed|Codex SSE response headers|PRIVATE_SEMANTIC_FAILURE/);
}
assert.equal(readSessionMiningReport(tmp, stateDir).reportId, first.reportId);

const second = mineAgentSessions(options);
assert.equal(second.scan.scannedFiles, 0);
assert.equal(second.scan.reusedFiles, 5);
assert.equal(second.reportId, first.reportId);
assert.equal(second.trend.baseline, false);
assert.equal(second.trend.comparisonReason, "comparable-cohort");
assert.deepEqual(second.trend.changedCohortFields, []);

fs.appendFileSync(piFile, `${JSON.stringify({ type: "message", id: "m4", timestamp: now, message: { role: "user", content: "one more safe prompt", timestamp: Date.parse(now) } })}\n`);
const later = new Date(Date.parse(now) + 1000);
fs.utimesSync(piFile, later, later);
const sameWindowChanged = mineAgentSessions(options);
assert.equal(sameWindowChanged.scan.scannedFiles, 1);
assert.equal(sameWindowChanged.scan.reusedFiles, 4);
assert.equal(sameWindowChanged.aggregate.total.userTurns, first.aggregate.total.userTurns + 1);
assert.equal(sameWindowChanged.trend.baseline, false);
const third = mineAgentSessions({ ...options, now: later.toISOString() });
assert.equal(third.scan.scannedFiles, 5, "a changed row window invalidates cached per-file aggregates");
assert.equal(third.scan.reusedFiles, 0);
assert.equal(third.aggregate.total.userTurns, first.aggregate.total.userTurns + 1);
assert.equal(third.trend.baseline, true, "moving time bounds form a new cohort baseline");
assert.equal(third.trend.comparisonReason, "incompatible-cohort-key");
assert.deepEqual(third.trend.candidateChanges, []);
assert.ok(third.trend.changedCohortFields.includes("untilAt"));
const oneDay = mineAgentSessions({ ...options, now: later.toISOString(), sinceDays: 1 });
assert.equal(oneDay.trend.baseline, true, "one-day and 30-day reports are never compared");
assert.equal(oneDay.trend.comparisonReason, "incompatible-cohort-key");
assert.ok(oneDay.trend.changedCohortFields.includes("windowDays"));
assert.deepEqual(oneDay.trend.candidateChanges, []);

// File mtime is only an opening optimization: every parsed row is still
// bounded by sinceAt/untilAt, and undated rows are reported but excluded.
const strictRoot = path.join(tmp, "strict-window");
const strictRoots = { claude: path.join(strictRoot, "claude"), codex: path.join(strictRoot, "codex"), pi: path.join(strictRoot, "pi") };
for (const root of Object.values(strictRoots)) fs.mkdirSync(root, { recursive: true });
const strictSince = "2026-07-09T00:00:00.000Z";
const strictUntil = "2026-07-10T00:00:00.000Z";
const strictFile = path.join(strictRoots.pi, "mixed-window.jsonl");
fs.writeFileSync(strictFile, [
  { type: "message", timestamp: "2026-07-08T23:59:59.999Z", message: { role: "user", content: "before" } },
  { type: "message", timestamp: strictSince, message: { role: "user", content: "lower-bound" } },
  { type: "message", timestamp: "2026-07-09T12:00:00.000Z", message: { role: "user", content: "inside" } },
  { type: "message", timestamp: strictUntil, message: { role: "user", content: "upper-bound" } },
  { type: "message", timestamp: "2026-07-10T00:00:00.001Z", message: { role: "user", content: "after" } },
  { type: "message", message: { role: "user", content: "undated" } },
].map(JSON.stringify).join("\n") + "\n");
fs.utimesSync(strictFile, new Date("2026-07-11T00:00:00.000Z"), new Date("2026-07-11T00:00:00.000Z"));
const strict = mineAgentSessions({ ...options, roots: strictRoots, stateDir: path.join(strictRoot, "state"), sinceAt: strictSince, untilAt: strictUntil, now: strictUntil });
assert.equal(strict.aggregate.total.sessions, 1);
assert.equal(strict.aggregate.total.userTurns, 3);
assert.deepEqual({ counted: strict.aggregate.window.counted, timestamped: strict.aggregate.window.timestamped, undated: strict.aggregate.window.undated, before: strict.aggregate.window.beforeWindow, after: strict.aggregate.window.afterWindow }, { counted: 3, timestamped: 3, undated: 1, before: 1, after: 1 });
assert.equal(strict.aggregate.window.earliestCountedAt, strictSince);
assert.equal(strict.aggregate.window.latestCountedAt, strictUntil);
assert.equal(strict.aggregate.window.countedTimestampsInsideWindow, true);
assert.equal(strict.scan.rowWindowApplied, true);
const strictWithUndated = mineAgentSessions({ ...options, roots: strictRoots, stateDir: path.join(strictRoot, "state-undated"), sinceAt: strictSince, untilAt: strictUntil, now: strictUntil, includeUndatedRows: true });
assert.equal(strictWithUndated.aggregate.total.userTurns, 4);
assert.equal(strictWithUndated.aggregate.window.countedUndated, 1);
assert.notEqual(strictWithUndated.cohort.key, strict.cohort.key, "undated inclusion policy is part of cohort identity");

const outcomes = sessionMiningOutcomes(first);
assert.equal(outcomes.length, first.candidates.length);
assert.ok(outcomes.every((row) => row.outcomeId.startsWith("outcome_session_") && row.source === "session-mining" && row.signals.evidenceLevel === "tool-output"));
assert.ok(outcomes.every((row) => row.classifications.length === 1 && row.classifications[0].startsWith("session-candidate:")), "candidate-specific classifications prevent unrelated same-scan findings from mining as repeats");
assert.equal(new Set(outcomes.map((row) => row.classifications[0])).size, outcomes.length);
assert.deepEqual(sessionMiningOutcomes(first).map((row) => row.outcomeId), sessionMiningOutcomes(second).map((row) => row.outcomeId), "same-day rescans deduplicate candidate outcomes");
assert.ok(outcomes.every((row) => row.artifacts.evidenceRefs.includes(`session-mining:${first.reportId}`)));
assert.doesNotMatch(JSON.stringify(outcomes), new RegExp(secret));

console.log("session miner tests passed");
