"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { schedule, createDecisionMeasurements, pairRows, upperBound, assessPower, acceptanceGates } = require("../src/codemode-decision-benchmark");
const { MANIFEST, prepareTask, checkAnswer, observedFiles } = require("../src/codemode-benchmark");
const { optionsFor, prepareTaskOnce } = require("../scripts/benchmark-codemode-decision");
const { createRuntime } = require("./helpers/codemode-runtime");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const diagnostic = schedule("diagnostic"), acceptance = schedule("acceptance");
  assert.equal(diagnostic.length, 56); assert.equal(acceptance.length, 360);
  assert.deepEqual(schedule("diagnostic"), diagnostic);
  for (const plan of [diagnostic, acceptance]) {
    assert.equal(new Set(plan.map(p => p.key)).size, plan.length);
    for (const task of new Set(plan.filter(p => !p.probe).map(p => p.id))) {
      const firsts = plan.filter((p, i) => !p.probe && p.id === task && (i === 0 || plan[i - 1].id !== task));
      assert.equal(firsts.filter(p => p.arm === "direct").length, firsts.length / 2);
    }
  }
  assert.equal(acceptance.filter(p => p.trial === 0).length, 180);
  for (let block = 0; block < 6; block++) for (const kind of ["simple", "batch", "chain"]) assert.equal(acceptance.filter(p => p.block === block && MANIFEST.find(t => t.id === p.id).kind === kind).length, 20);
  assert.throws(() => schedule("old"), /Unknown/);
  assert.throws(() => optionsFor(["--synthetic"], {}), /live cohort/);
  assert.throws(() => optionsFor(["--live", "--provider", "other", "--model", "other"], {}), /frozen/);
  const args = ["--live", "--provider", "openai-codex", "--model", "gpt-6.1-sol", "--thinking", "xhigh"];
  assert.throws(() => optionsFor(args, { PI_CODEMODE: "0" }), /default-off/);
  assert.equal(optionsFor(args, {}).model, "gpt-6.1-sol");

  let time = 0, stats;
  const handlers = new Map(), phase = createDecisionMeasurements({ clock: () => time, utc: () => `utc-${time}`, stats: () => stats });
  phase.install({ on(name, callback) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(callback); } });
  const emit = (at, name, event = {}) => { time = at; for (const fn of handlers.get(name)) fn(event); };
  phase.start();
  emit(1, "context_with_system", { messages: [{ text: "PRIVATE_SENTINEL" }] });
  emit(2, "before_provider_request", { payload: { input: ["PRIVATE_SENTINEL"], tools: [{ description: "PRIVATE_SENTINEL" }] } });
  emit(3, "after_provider_response", { status: 200, headers: { authorization: "PRIVATE_SENTINEL" } });
  emit(4, "provider_stream_event", { data: { type: "response.created", response: { id: "PRIVATE_SENTINEL" } } });
  emit(5, "message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "toolcall_start", partial: "PRIVATE_SENTINEL" } });
  emit(6, "provider_stream_event", { data: { type: "PRIVATE_SENTINEL", delta: "PRIVATE_SENTINEL" } });
  emit(20, "provider_stream_event", { data: { type: "response.output_text.delta", delta: "PRIVATE_SENTINEL" } });
  emit(20, "message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "PRIVATE_SENTINEL" } });
  stats = { requests: 2, connectionsCreated: 1, connectionsReused: 1, cachedContextRequests: 0, fullContextRequests: 1, deltaRequests: 1, websocketFailures: 0, sseFallbacks: 0, lastWebSocketError: "PRIVATE_SENTINEL", lastPreviousResponseId: "PRIVATE_SENTINEL" };
  emit(25, "provider_stream_event", { data: { type: "response.completed", response: { usage: { output_tokens_details: { reasoning_tokens: 2 }, input_tokens_details: { cached_tokens: 3 } } } } });
  const usage = { input: 5, cacheRead: 3, cacheWrite: 0, output: 4, reasoning: 2, totalTokens: 12, cost: { total: .01 } };
  emit(26, "message_end", { message: { role: "assistant", usage, content: "PRIVATE_SENTINEL" } });
  time = 30; phase.finish(); const result = phase.snapshot(), turn = result.turns[0];
  assert.equal(turn.parsedToFirstDeltaMs, 16);
  assert.equal(turn.normalizedStarts.toolcall_start, 5);
  assert.equal(turn.categories.other.count, 1);
  assert.equal(turn.usage.total, 12); assert.equal(turn.rawReasoningTokens, 2);
  assert.equal(turn.wsDelta.requests, 2); assert.equal(turn.wsDelta.connectionsReused, 1);
  assert.deepEqual(turn.httpStatuses, [200]); assert.equal(turn.requestUtc, "utc-2");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|authorization|lastWebSocketError|lastPreviousResponseId/);

  const rows = acceptance.map(p => ({ ...p, kind: MANIFEST.find(t => t.id === p.id).kind, phases: { promptMs: 100, contextEstimatedTokens: p.arm === "direct" ? 100 : 50, timingComplete: true, providerTimingComplete: true, turns: [{ usage: { totalMatchesSdk: true }, requestUtc: "now", endUtc: "then", categories: { completed: {} } }] }, oracle: { ok: true }, integrity: true, providerError: false, toolFailures: 0, tokens: { totalMatchesSdk: true }, reportedCost: p.arm === "direct" ? .01 : .005 }));
  assert.equal(pairRows(rows).length, 180);
  assert.equal(upperBound(pairRows(rows), { resamples: 20 }), 1);
  const scaledPairs = pairRows(rows.map(r => ({ ...r, phases: { ...r.phases, promptMs: (100 + Number(r.id.slice(-2)) * 31 + r.block * 17) * (r.arm === "codemode" ? 1.05 : 1) } })));
  assert(Math.abs(upperBound(scaledPairs, { resamples: 500 }) - 1.05) < 1e-12, "resampling must preserve paired heterogeneous latencies and repeated blocks");
  assert.equal(acceptanceGates(rows, acceptance).supportsLiftingHold, true);
  assert.equal(acceptanceGates(rows.slice(1), acceptance).supportsLiftingHold, false);
  assert.equal(acceptanceGates([rows[1], ...rows.slice(1)], acceptance).complete, false);
  assert.equal(acceptanceGates(rows.map(r => r.arm === "codemode" ? { ...r, phases: { ...r.phases, promptMs: 120 } } : r), acceptance).targets.latency, false);
  assert.equal(acceptanceGates(rows.map(r => r.arm === "codemode" && r.trial === 1 ? { ...r, phases: { ...r.phases, promptMs: 125 } } : r), acceptance).supportsLiftingHold, false);
  assert.equal(acceptanceGates(rows.map(r => ({ ...r, reportedCost: null })), acceptance).targets.cost, null);
  const missingTimings = acceptanceGates(rows.map(r => ({ ...r, phases: { ...r.phases, promptMs: null } })), acceptance);
  assert.equal(missingTimings.targets.latency, null, "unknown ratios must never coerce into a pass");
  assert.equal(missingTimings.targets.confidence, null);
  assert.equal(missingTimings.supportsLiftingHold, false);
  assert.equal(acceptanceGates(rows.map(r => ({ ...r, tokens: { totalMatchesSdk: false } })), acceptance).measurement, false);
  for (const value of [null, undefined, NaN, Infinity, 0, -1]) {
    const missingContext = acceptanceGates(rows.map(r => r.arm === "codemode" ? { ...r, phases: { ...r.phases, contextEstimatedTokens: value } } : r), acceptance);
    assert.equal(missingContext.measurement, false, "missing/invalid context is not complete measurement");
    assert.equal(missingContext.targets.composedContext, null, "unknown context must never become a zero-cost pass");
    assert.equal(missingContext.supportsLiftingHold, false);
  }
  for (const arm of ["direct", "codemode"]) {
    const missingKey = rows.find(r => r.arm === arm && r.kind === "batch").key;
    const oneMissing = acceptanceGates(rows.map(r => r.key === missingKey ? { ...r, phases: { ...r.phases, contextEstimatedTokens: null } } : r), acceptance);
    assert.equal(oneMissing.targets.composedContext, null, "even one missing composed sample makes its aggregate unknown");
    assert.equal(oneMissing.supportsLiftingHold, false);
  }
  const missingSimpleContext = acceptanceGates(rows.map(r => r.kind === "simple" ? { ...r, phases: { ...r.phases, contextEstimatedTokens: null } } : r), acceptance);
  assert.equal(missingSimpleContext.targets.composedContext, true, "the composed target excludes simple controls");
  assert.equal(missingSimpleContext.measurement, false, "all profile cases still require context measurement");
  assert.equal(missingSimpleContext.supportsLiftingHold, false);
  const historical = [0, 1].flatMap(trial => MANIFEST.flatMap(task => ["direct", "codemode"].map(arm => ({ trial, ...task, arm, phases: { promptMs: 100 } }))));
  assert.equal(assessPower(historical, { simulations: 3, resamples: 10 }).power, 1);
  assert.throws(() => assessPower(historical.slice(1), { simulations: 1 }), /frozen60/);

  const directory = tmpFixture("pi-decision-test-");
  try { const cwd = path.join(directory, "fixture"), first = prepareTaskOnce(MANIFEST[10], cwd), second = prepareTaskOnce(MANIFEST[10], cwd); assert.equal(first.fixtureDigest, second.fixtureDigest); }
  finally { fs.rmSync(directory, { recursive: true }); }
  // Native SDK and actual QuickJS, with synthetic provider messages: no paid smoke.
  for (const task of [MANIFEST[0], MANIFEST[10], MANIFEST[20]]) for (const arm of ["direct", "codemode"]) {
    const measurement = createDecisionMeasurements();
    const runtime = await createRuntime({ tools: ["read", "docs_lookup", "code_context", "codemode"], excludeTools: arm === "direct" ? ["codemode"] : [], extensionFactories: [measurement.install] });
    try {
      const prepared = prepareTask(task, runtime.cwd), expected = JSON.stringify({ value: prepared.expected, evidence: prepared.evidence });
      runtime.session.subscribe(measurement.observe);
      const code = task.kind === "chain" ? 'const route=JSON.parse(await tools.read({path:"docs/route.json"})); const rows=JSON.parse(await tools.read({path:route.source})); return rows.find(r=>r.id===route.id).amount;' : `return (await Promise.all(${JSON.stringify(prepared.evidence)}.map(path=>tools.read({path})))).length;`;
      runtime.faux.setResponses([runtime.ai.fauxAssistantMessage(arm === "direct" ? prepared.evidence.map(file => runtime.ai.fauxToolCall("read", { path: file })) : [runtime.ai.fauxToolCall("codemode", { code })], { stopReason: "toolUse" }), runtime.ai.fauxAssistantMessage(expected)]);
      measurement.start(); await runtime.session.prompt(prepared.prompt); measurement.finish();
      const measured = measurement.snapshot();
      assert.equal(measured.timingComplete, true); assert.equal(measured.turns.length, 2);
      assert(measured.turns.every(t => t.requestUtc === null && t.wsAfter === null), "faux has no transport metadata; absence stays unknown");
      assert(measured.turns.every(t => t.usage?.totalMatchesSdk));
      assert.equal(checkAnswer(expected, prepared, observedFiles(runtime.events, runtime.cwd)).ok, true);
      assert.doesNotMatch(JSON.stringify(measured), /Synthetic reference|"args"|"payload"/);
    } finally { await runtime.close(); }
  }
  require("node:child_process").execFileSync(process.execPath, [path.join(__dirname, "helpers/codemode-decision-websocket.js")], { stdio: "inherit", timeout: 30000 });
  console.log("codemode decision scheduling, privacy, phase metadata, statistical gates and native conformance tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
