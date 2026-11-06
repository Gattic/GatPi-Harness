"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { MANIFEST, prepareTask } = require("../src/codemode-benchmark");
const { TRIALS, TOTAL_CASES, intervalMs, tokenUsage, createPhaseMeasurements, armOrder, trialTasks, summarizePhases } = require("../src/codemode-phase-benchmark");
const { liveInference } = require("../scripts/benchmark-codemode");
const { optionsFor } = require("../scripts/benchmark-codemode-phases");
const { createRuntime } = require("./helpers/codemode-runtime");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  assert.equal(TOTAL_CASES, 120);
  assert.equal(intervalMs([[0, 10], [5, 15], [20, 30]]), 25, "parallel intervals are unioned, not added twice");
  for (const [index, task] of MANIFEST.entries()) {
    assert.notDeepEqual(armOrder(index, 0), armOrder(index, 1));
    for (let trial = 0; trial < TRIALS; trial++) assert(trialTasks(trial).includes(task));
  }
  assert.equal(trialTasks(1)[0].kind, "batch");
  assert.throws(() => optionsFor(["--live"], {}), error => error.code === "MODEL_IDENTITY_MISSING");
  assert.throws(() => optionsFor(["--synthetic"], {}), /require --live/);
  assert.throws(() => optionsFor(["--live", "--provider", "p", "--model", "m"], { PI_CODEMODE: "0" }), /default-on/);
  assert.throws(() => optionsFor(["--live", "--provider", "p", "--model", "m", "--resume-unstarted", "old"], {}), /no synthetic performance or historical continuation/);

  const usage = tokenUsage([{ usage: { input: 100, output: 40, cacheRead: 50, cacheWrite: 10, reasoning: 30, totalTokens: 200 } }]);
  assert.deepEqual(usage, { uncachedInput: 100, output: 40, cacheRead: 50, cacheWrite: 10, reasoning: 30, nonReasoningOutput: 10, inputIncludingCache: 160, total: 200, sdkTotal: 200, totalMatchesSdk: true });
  assert.equal(tokenUsage([{ usage: { input: 100, output: 40 } }]).total, null, "missing cache counters are not zero");
  assert.equal(tokenUsage([]).total, null);
  assert.equal(tokenUsage([{ usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 9 } }]).totalMatchesSdk, false);

  let time = 0;
  const events = new Map(), phase = createPhaseMeasurements(() => time);
  phase.install({ on: (name, handler) => events.set(name, handler) });
  const emit = (at, name, event = {}) => { time = at; events.get(name)(event); };
  phase.start();
  emit(2, "context_with_system", { messages: [{ secret: "PRIVATE_TIMING_SENTINEL" }] });
  emit(5, "before_provider_request", { payload: { secret: "PRIVATE_TIMING_SENTINEL" } });
  emit(15, "after_provider_response", { headers: { authorization: "PRIVATE_TIMING_SENTINEL" } });
  emit(16, "provider_stream_event", { data: "PRIVATE_TIMING_SENTINEL" });
  emit(20, "message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE_TIMING_SENTINEL" } });
  emit(40, "message_end", { message: { role: "assistant" } });
  const tool = (at, type, toolCallId, toolName, parentToolCallId) => { time = at; phase.observe({ type, toolCallId, toolName, parentToolCallId, isError: false, args: { secret: "PRIVATE_TIMING_SENTINEL" }, result: { secret: "PRIVATE_TIMING_SENTINEL" } }); };
  tool(45, "tool_execution_start", "outer", "codemode");
  tool(50, "tool_execution_start", "a", "read", "outer");
  tool(60, "tool_execution_start", "b", "read", "outer");
  tool(70, "tool_execution_end", "a", "read", "outer");
  tool(80, "tool_execution_end", "b", "read", "outer");
  tool(90, "tool_execution_end", "outer", "codemode");
  time = 100; phase.finish();
  const measured = phase.snapshot();
  assert.equal(measured.modelPipelineMs, 38);
  assert.equal(measured.topToolWallMs, 45);
  assert.equal(measured.nestedToolWallMs, 30);
  assert.equal(measured.codemodeNonNestedMs, 15);
  assert.equal(measured.otherHarnessMs, 17);
  assert.equal(measured.contextToRequestMs, 3);
  assert.equal(measured.requestToResponseMs, 10);
  assert.equal(measured.requestToFirstDeltaMs, 15);
  assert.equal(measured.firstDeltaToEndMs, 20);
  assert.equal(measured.phaseOverlapMs, 0);
  assert.equal(measured.timingComplete, true);
  assert.equal(measured.providerTimingComplete, true);
  assert(measured.contextEstimatedTokens > 0 && measured.providerPayloadEstimatedTokens > 0);
  assert.doesNotMatch(JSON.stringify(measured), /PRIVATE_TIMING_SENTINEL|authorization|"args"|"payload"/);
  assert.throws(() => phase.start(), /already started/);

  const missing = createPhaseMeasurements(() => 0);
  const missingHandlers = new Map(); missing.install({ on: (name, handler) => missingHandlers.set(name, handler) });
  missing.start(); missingHandlers.get("context_with_system")({ messages: [] }); missing.finish();
  assert.equal(missing.snapshot().timingComplete, false);
  assert.equal(missing.snapshot().providerTimingComplete, false);
  assert.equal(missing.snapshot().requestToFirstDeltaMs, null);
  assert.equal(missing.snapshot().providerPayloadEstimatedTokens, null);

  const rows = Array.from({ length: TRIALS }, (_, trial) => MANIFEST.flatMap(task => ["direct", "codemode"].map(arm => ({ trial, ...task, arm, oracle: { ok: true }, integrity: true, providerError: false, toolFailures: 0, modelTurns: 2, underlyingToolAttempts: 1, generatedCodeChars: 0, setupMs: 5, postprocessMs: 1, reportedCost: arm === "direct" ? .01 : .005, tokens: usage, phases: { ...measured, promptMs: arm === "direct" ? 100 : 90, contextEstimatedTokens: arm === "direct" ? 100 : 50 } })))).flat();
  assert.equal(summarizePhases(rows).supportsBoundedMerge, true);
  assert.equal(summarizePhases(rows).pooled.tokenDifferences.total.difference, 0);
  assert.equal(summarizePhases([rows[1], ...rows.slice(1)]).complete, false, "duplicate case cannot replace an unrun assignment");
  assert.equal(summarizePhases(rows.slice(1)).targets.latency, null);
  assert.equal(summarizePhases(rows.map(row => row.trial === 1 && row.arm === "codemode" ? { ...row, phases: { ...row.phases, promptMs: 120 } } : row)).targets.latency, false, "both trials must pass, not just a favorable subset");
  assert.equal(summarizePhases([{ ...rows[0], tokens: { ...usage, total: null } }, ...rows.slice(1)]).tokensComplete, false);
  assert.equal(summarizePhases(rows.map(row => ({ ...row, reportedCost: null }))).targets.cost, null);
  const fractionalCosts = summarizePhases(rows.map(row => ({ ...row, reportedCost: row.arm === "direct" ? .003 / 60 : .0034 / 60 })));
  assert(fractionalCosts.pooled.costRatio > 1.1, "cost ratios use unrounded totals, not display precision");
  assert.equal(fractionalCosts.targets.cost, false, "a real 13.33% increase cannot round into a passing gate");
  assert.equal(summarizePhases(rows.map(row => ({ ...row, reportedCost: -1 }))).targets.cost, null);

  const authDir = tmpFixture("pi-codemode-credential-contract-");
  try {
    let credentials;
    const sdk = { readStoredCredential: () => ({ type: "api_key", key: "synthetic-only" }), ModelRuntime: { create: async options => { credentials = options.credentials; assert.equal(options.refreshOnCreate, false); assert.equal(options.allowModelNetwork, false); return { getModel: (provider, id) => ({ provider, id }) }; } } };
    await liveInference(sdk, { provider: "p", modelId: "m", thinkingLevel: "off", agentDir: authDir, run: authDir });
    assert.equal(await credentials.read("another-provider"), undefined);
    assert.equal((await credentials.list()).length, 1);
    await assert.rejects(credentials.modify(), /refresh and writes/);
    await assert.rejects(credentials.delete(), /deletion/);
    sdk.readStoredCredential = () => ({ type: "api_key", key: "!do-not-execute" });
    await assert.rejects(credentials.read("p"), /commands/);
  } finally { fs.rmSync(authDir, { recursive: true }); }

  // Real SDK/hooks/QuickJS with synthetic provider messages: measurement conformance,
  // never a live quality, latency or token-benefit experiment.
  for (const task of [MANIFEST[0], MANIFEST[10], MANIFEST[20]]) for (const arm of ["direct", "codemode"]) {
    const nativePhase = createPhaseMeasurements();
    const runtime = await createRuntime({ tools: ["read", "docs_lookup", "code_context", "codemode"], excludeTools: arm === "direct" ? ["codemode"] : [], extensionFactories: [nativePhase.install] });
    try {
      const prepared = prepareTask(task, runtime.cwd);
      runtime.session.subscribe(nativePhase.observe);
      const expected = JSON.stringify({ value: prepared.expected, evidence: prepared.evidence });
      if (arm === "direct") runtime.faux.setResponses([runtime.ai.fauxAssistantMessage(prepared.evidence.map(file => runtime.ai.fauxToolCall("read", { path: file })), { stopReason: "toolUse" }), runtime.ai.fauxAssistantMessage(expected)]);
      else {
        const code = task.kind === "chain" ? 'const route=JSON.parse(await tools.read({path:"docs/route.json"})); const data=JSON.parse(await tools.read({path:route.source})); return data.find(row=>row.id===route.id).amount;' : `const data=await Promise.all(${JSON.stringify(prepared.evidence)}.map(path=>tools.read({path}))); return data.length;`;
        runtime.faux.setResponses([runtime.ai.fauxAssistantMessage([runtime.ai.fauxToolCall("codemode", { code })], { stopReason: "toolUse" }), runtime.ai.fauxAssistantMessage(expected)]);
      }
      nativePhase.start(); await runtime.session.prompt(prepared.prompt); nativePhase.finish();
      const result = nativePhase.snapshot();
      assert.equal(result.timingComplete, true, JSON.stringify(result));
      assert.equal(result.providerTimingComplete, false, "synthetic provider has no HTTP request timing");
      assert.equal(result.turns.length, 2);
      assert.equal(result.tools.filter(row => row.name === "read").length, prepared.evidence.length);
      assert.equal(result.tools.some(row => row.name === "codemode"), arm === "codemode");
      assert(result.modelPipelineMs > 0 && result.topToolWallMs > 0);
      assert(Math.abs(result.promptMs - result.modelPipelineMs - result.topToolWallMs - result.otherHarnessMs + result.phaseOverlapMs) < .01);
      assert(result.tools.filter(row => row.nested).every(row => row.parentIndex !== null));
      assert.doesNotMatch(JSON.stringify(result), /Synthetic reference|"args"|"payload"/);
    } finally { await runtime.close(); }
  }
  console.log("codemode phase timing, token accounting and native measurement tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
