#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { THRESHOLDS, redactTurnPrompt, buildTurnRequest, decideTurn } = require("../src/typesafe-turn-judgment.js");
const { SystemOneAdapter } = require("../src/integration-boundary.js");
const { classifyTaskModality, buildTaskScaffold } = require("../src/task-modality.js");
const { buildTurnRecord, accuracy, evaluateIntentBars, evaluateFieldBars, fieldReport, recordFieldGate, turnRecordDir } = require("../src/typesafe-evaluation.js");
const { openExperiment, listExperiments } = require("../src/experiment-ledger.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const SECRET = "sk-abcdefghijklmnopqrstuvwxyz012345";

// Request shape and privacy.
assert.equal(buildTurnRequest({ redactedPrompt: "  " }), null, "empty prompts are never sent");
const request = buildTurnRequest({ redactedPrompt: "Orient me in this repo" });
assert.deepEqual(request.state, { request: "Orient me in this repo" }, "only the request is sent by default");
assert.deepEqual(Object.keys(request.questions).sort(), ["intent::modality", "intent::research_memory"], "only the intent questions are asked");
assert.equal(request.questions["intent::modality"].type, "choice");
assert.deepEqual(Object.keys(request.questions["intent::modality"].criteria), ["answer", "investigation", "planning", "implementation", "verification"], "protected modalities are never offered");
assert.equal(request.questions["intent::research_memory"].type, "noul");
assert.equal(buildTurnRequest({ redactedPrompt: "x", redactedPrevious: "y" }).state.previous_request, "y");

const redacted = redactTurnPrompt(`Use key ${SECRET} on /home/user/project/file.ts\n\`\`\`js\nconst token = 1;\n\`\`\`\nThen ${"x".repeat(3000)}`);
assert.equal(redacted.includes(SECRET), false);
assert.equal(redacted.includes("/home/user"), false);
assert.equal(redacted.includes("const token"), false);
assert.ok(redacted.length <= 2000, "prompts are capped at 2,000 characters");

// Decisions use code-owned thresholds.
function answers({ modality = "investigation", research = 0.2 } = {}) {
  return {
    "intent::modality": { type: "choice", choice: modality, probabilities: { [modality]: 1 }, confidence: 0.9 },
    "intent::research_memory": { type: "noul", noul: research },
  };
}
const decided = decideTurn(answers());
assert.deepEqual(decided.intent.modality, { value: "investigation", confidence: 0.9 });
assert.equal(decided.intent.researchMemory.eligible, false);
assert.equal(decideTurn(answers({ research: THRESHOLDS.researchMemory })).intent.researchMemory.eligible, true, "the research-memory threshold is inclusive");

// Protected modalities stay local; a judged modality replaces only the rest.
assert.equal(classifyTaskModality("rotate the production API key", { judged: { modality: "answer", confidence: 1 } }).modality, "credential");
assert.equal(classifyTaskModality("delete the build cache", { judged: { modality: "answer", confidence: 1 } }).modality, "destructive");
assert.deepEqual(pick(classifyTaskModality("make the button blue", { judged: { modality: "implementation", confidence: 0.8 } })), { modality: "implementation", reasonCode: "typesafe-judgment", confidence: 0.8 });
const unavailable = classifyTaskModality("make the button blue", { judged: { modality: null } });
assert.deepEqual(pick(unavailable), { modality: "unclassified", reasonCode: "judgment-unavailable", confidence: 0 });
assert.equal(unavailable.readOnly, false, "an unavailable judgment never claims the turn is read-only");
assert.equal(unavailable.requiresConfirmation, false);
assert.match(buildTaskScaffold("make the button blue", { judged: { modality: null } }).successCriteria.join(" "), /explicitly requested/);
assert.throws(() => classifyTaskModality("x", { judged: { modality: "publish" } }), /not judgeable/);
assert.equal(buildTaskScaffold("explain monads", { judged: { modality: "planning", confidence: 0.5 } }).modality, "answer", "explicit user action outranks an advisory label");
assert.equal(buildTaskScaffold("Finish our implementation plan in full", { judged: { modality: "planning", confidence: 1 } }).modality, "implementation");
assert.equal(buildTaskScaffold("Review this without edits", { judged: { modality: "implementation", confidence: 1 } }).modality, "investigation");
assert.equal(buildTaskScaffold("fix the bug").modality, "implementation", "without a judgment the local classifier is unchanged");
function pick(value) { return { modality: value.modality, reasonCode: value.reasonCode, confidence: value.confidence }; }

// Adapter: modes, gating, one request per turn, and absence on failure.
function fakeClient(result) {
  const calls = [];
  return { calls, keyPresent: true, model: "jev-1.13.0", baseUrl: "http://fake", timeoutMs: 10_000, systemOne: async (request) => { calls.push(request); return typeof result === "function" ? result(request) : result; }, listModels: async () => ({ ok: true, models: ["jev-latest"] }) };
}
(async () => {
  const off = new SystemOneAdapter({ env: {}, client: fakeClient({ ok: true }) });
  assert.equal(off.active(), false);
  assert.equal(off.startTurn({ text: "hello" }), null);
  assert.equal(off.client.calls.length, 0, "default off sends nothing");
  assert.equal(off.recordTurn({}).skipped, true);

  const childClient = fakeClient({ ok: true });
  const child = new SystemOneAdapter({ env: { PI_JEV_TURN_INTENT: "on", PI_SUBAGENT_PARENT_ID: "sub_1" }, client: childClient });
  assert.deepEqual(child.modes, { intent: "off" }, "subagent sessions are never judged");
  assert.equal(child.readiness().childSession, true);
  assert.equal(child.startTurn({ text: "Implement the parent's plan for src/a.js", source: "rpc" }), null);
  assert.equal(childClient.calls.length, 0, "parent-authored child prompts are never sent");

  const invalid = new SystemOneAdapter({ env: { PI_JEV_TURN_INTENT: "maybe" }, client: fakeClient({ ok: true }) });
  assert.deepEqual(invalid.modes, { intent: "off" });
  assert.deepEqual(invalid.invalidSettings, ["PI_JEV_TURN_INTENT"]);

  const ok = { ok: true, model: "jev-1.13.0", inputTokens: 4000, latencyMs: 120, answers: answers() };
  const client = fakeClient(ok);
  const agentDir = tmpFixture("pi-typesafe-agent-");
  const env = { PI_JEV_TURN_INTENT: "shadow", PI_CODING_AGENT_DIR: agentDir };
  const adapter = new SystemOneAdapter({ env, client, persist: true });
  assert.equal(adapter.startTurn({ text: "/skill:handoff now" }), null, "explicit commands are not judged");
  assert.equal(adapter.startTurn({ text: "loop prompt", source: "extension" }), null, "extension-authored prompts are not sent");
  assert.equal(client.calls.length, 0);
  const prompt = `Orient me in this repo, my key is ${SECRET}`;
  const pending = adapter.startTurn({ text: `  ${prompt}\n`, source: "interactive" });
  assert.equal(client.calls.length, 1);
  assert.equal(JSON.stringify(client.calls[0]).includes(SECRET), false, "the payload carries only the redacted prompt");
  assert.equal(adapter.turnFor(prompt), pending, "input-time consumers share the same request");
  assert.equal(adapter.service().turnFor("something else"), null, "a different prompt never receives a stale judgment");
  assert.equal(adapter.service().currentTurn(), pending);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.decision.intent.modality.value, "investigation");

  const record = adapter.recordTurn({ sessionKind: "interactive", judgment: result, local: { modality: "not-a-modality", researchMemory: false } });
  assert.deepEqual(record.modes, { intent: "shadow" });
  assert.deepEqual(record.typesafe, { modality: "investigation", modalityConfidence: 0.9, researchMemory: 0.2 });
  assert.deepEqual(record.local, { modality: null, researchMemory: false }, "unknown modality labels are dropped");
  assert.equal(record.version, "typesafe-turn-judgment-v4");
  const turnsFile = path.join(agentDir, "typesafe", "turns.jsonl");
  assert.equal(turnRecordDir(env), path.join(agentDir, "typesafe"), "field records live in Pi's agent directory");
  const stored = fs.readFileSync(turnsFile, "utf8");
  assert.equal(stored.includes("Orient me"), false, "turn records never contain prompt text");
  assert.equal(fs.statSync(turnsFile).mode & 0o777, 0o600);
  // Sessions launched in different projects share one record file, so the
  // field report sees all of them (records were per-project before).
  const otherProjectDir = tmpFixture("pi-typesafe-project-");
  const launchDir = process.cwd();
  process.chdir(otherProjectDir);
  try {
    new SystemOneAdapter({ env, client: fakeClient(ok), persist: true }).recordTurn({ sessionKind: "interactive", judgment: result });
  } finally { process.chdir(launchDir); }
  assert.equal(fs.readFileSync(turnsFile, "utf8").trim().split("\n").length, 2, "a second project's session appends to the same file");
  assert.equal(adapter.turnRecords().length, 2);
  assert.deepEqual(fs.readdirSync(otherProjectDir), [], "nothing is written under the launch directory");
  assert.equal(new SystemOneAdapter({ env, client: fakeClient(ok) }).recordTurn({ judgment: result }).schemaVersion, 2);
  assert.equal(fs.readFileSync(turnsFile, "utf8").trim().split("\n").length, 2, "only persist:true adapters write field records");
  for (let i = 0; i < 3; i++) adapter.recordTurn({ judgment: null });
  assert.deepEqual(adapter.pruneTurnRecords({ keep: 2 }), { total: 5, removed: 3 });
  assert.equal(adapter.turnRecords().length, 2);

  const failing = new SystemOneAdapter({ env: { PI_JEV_TURN_INTENT: "on" }, client: fakeClient({ ok: false, reason: "rate-limited", status: 429, latencyMs: 30 }) });
  const failed = await failing.startTurn({ text: "orient me" });
  assert.deepEqual({ ok: failed.ok, reason: failed.reason }, { ok: false, reason: "rate-limited" });
  assert.deepEqual(failing.readiness().outcomes, { "rate-limited": 1 });
  assert.equal(buildTurnRecord({ judgment: failed, modes: failing.modes }).outcome, "rate-limited");
  assert.equal(buildTurnRecord({ judgment: null, modes: failing.modes }).outcome, "skipped");

  const partial = answers();
  delete partial["intent::research_memory"];
  const broken = new SystemOneAdapter({ env: { PI_JEV_TURN_INTENT: "on" }, client: fakeClient({ ok: true, model: "jev-1.13.0", answers: partial }) });
  assert.equal((await broken.startTurn({ text: "orient me" })).reason, "internal-error", "decision bugs resolve to absence and are logged");

  // Metric definitions and bars.
  assert.equal(accuracy([{ label: "answer", predicted: "answer" }, { label: "planning", predicted: "answer" }]), 0.5);
  assert.deepEqual(evaluateIntentBars({ localModality: 0.6, typesafeModality: 0.7 }).map((row) => row.verdict), ["pass"]);
  assert.deepEqual(evaluateIntentBars({ localModality: 0.6, typesafeModality: 0.65 }).map((row) => row.verdict), ["fail"]);
  assert.deepEqual(evaluateIntentBars({ localModality: null, typesafeModality: 0.65 }).map((row) => row.verdict), ["insufficient-data"]);
  assert.equal(evaluateFieldBars([{ outcome: "ok", latencyMs: 100 }])[0].verdict, "insufficient-data", "field bars need the pre-registered sample size");
  const report = fieldReport(adapter.turnRecords().concat([record]));
  assert.equal(report.byMode["intent=shadow"].turns, 1, "only interactive records count");
  assert.equal(report.excludedNonInteractive, 2);
  const mixed = fieldReport([record, { ...record, version: "typesafe-turn-judgment-v3" }]);
  assert.equal(mixed.byMode["intent=shadow"].turns, 1, "records made under another decision rule are not counted");
  assert.equal(mixed.excludedOtherVersions, 1);

  // Gate recording targets the harness ledger and never claims success when
  // there is nothing to record against.
  const ledgerRoot = tmpFixture("pi-typesafe-ledger-");
  assert.throws(() => recordFieldGate(ledgerRoot, report, "field-shadow"), /no open TypeSafe Jev experiments/);
  assert.throws(() => recordFieldGate(ledgerRoot, { byMode: {} }, "field-on"), /no on-mode records/);
  assert.throws(() => recordFieldGate(ledgerRoot, report, "gold-offline"), /field-shadow or field-on/);
  const experiment = openExperiment(ledgerRoot, "TypeSafe Jev turn intent test", { hypothesis: "h", bars: ["b"] });
  const recorded = recordFieldGate(ledgerRoot, report, "field-shadow");
  assert.deepEqual(recorded, { verdict: "null-result", experiments: [experiment.experimentId] }, "too few turns is a null result, not a pass");
  assert.equal(listExperiments(ledgerRoot)[0].gates.at(-1).gate, "field-shadow");

  for (const dir of [agentDir, otherProjectDir, ledgerRoot]) fs.rmSync(dir, { recursive: true, force: true });
  console.log("typesafe turn judgment tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
