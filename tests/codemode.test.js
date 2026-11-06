"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRuntime, installedRuntime } = require("./helpers/codemode-runtime");
const { CODEMODE_LIMITS, GUIDANCE, OUTPUT_CONTRACT, boundedScript, governedCodemode } = require("../src/codemode-policy");
const { TOOL_OUTPUT_SCHEMAS, structuredToolResult } = require("../src/tool-result-contracts");
const { tmpFixture } = require("./helpers/tmp-fixture");
process.env.PI_OUTPUT_COMPACTOR_MODE = "all";
const text = result => result.content.filter(item => item.type === "text").map(item => item.text).join("\n");

(async () => {
  assert.equal(JSON.parse(boundedScript('// @options: {"timeout_ms":999999,"max_output_tokens":999999}\nreturn 1').code.split("\n")[0].slice(13)).timeout_ms, CODEMODE_LIMITS.timeoutMs);
  for (const code of ["", '// @options: {"timeout_ms":0}\nreturn 1', '// @options: {"unexpected":1}\nreturn 1']) assert.throws(() => boundedScript(code));
  assert.throws(() => structuredToolResult(TOOL_OUTPUT_SCHEMAS.code_context, { details: { items: "invalid" } }), /violates its schema/);
  const negative = { generatedAt: new Date().toISOString(), outcome: "domain-negative", ok: false, runs: [{ id: "fixture", ok: false }] };
  assert.equal(structuredToolResult(TOOL_OUTPUT_SCHEMAS.test_runner, { details: negative }).structuredContent, negative);

  const installed = await installedRuntime();
  const unsupported = tmpFixture("pi-codemode-unsupported-");
  try {
    const missingApi = path.join(unsupported, "sdk.cjs");
    fs.writeFileSync(missingApi, "module.exports = {};\n", { mode: 0o600 });
    const { createJiti } = require(require.resolve("jiti", { paths: [installed.root] }));
    const file = path.resolve(__dirname, "../extensions/codemode/index.ts");
    const loader = createJiti(file, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": missingApi } });
    const extension = await loader.import(file, { default: true });
    assert.throws(() => extension({}), /requires Pi's public createCodemodeExtension API/, "unsupported Pi fails explicitly without another executor");
  } finally { fs.rmSync(unsupported, { recursive: true }); }

  let resumeManager;
  const measurements = require("../src/codemode-benchmark").createMeasurements();
  const runtime = await createRuntime({ extensionFactories: [measurements.install] });
  try {
    assert(runtime.session.getActiveToolNames().includes("codemode"), "CodeMode is default-on without settings writes");
    assert(runtime.session.getActiveToolNames().includes("bash"), "hybrid mode keeps direct tools");
    assert.equal(runtime.session.systemPrompt.split(OUTPUT_CONTRACT).length - 1, 1, "the native prompt carries the output contract exactly once");
    assert.match(GUIDANCE, /ALL_TOOLS, searchTools and describeTool cover only those CodeMode-callable tools, not the session's declared tool surface/, "CodeMode discovery globals are documented as a policy subset");
    assert.match(runtime.session.systemPrompt, /not the session's declared tool surface/, "the declared codemode tool carries that distinction");
    fs.mkdirSync(path.join(runtime.cwd, "docs"));
    fs.mkdirSync(path.join(runtime.cwd, "src"));
    fs.writeFileSync(path.join(runtime.cwd, "docs", "guide.md"), "# CodeMode\nNEEDLE documented behavior\n");
    fs.writeFileSync(path.join(runtime.cwd, "src", "value.js"), "module.exports = 'NEEDLE';\n");
    let result = await runtime.script('return {names: ALL_TOOLS.map(t => t.name), models: typeof models}');
    assert.equal(result.isError, false, text(result));
    assert(measurements.snapshot().contextEstimatedTokens > 0, "provider-neutral measurement includes the full native transcript");
    assert(measurements.snapshot().contextSamples >= 2, "tool and final-answer model turns are measured");
    assert.equal(measurements.snapshot().providerPayloadEstimatedTokens, null, "synthetic providers have no HTTP payload, not a zero-sized one");
    assert.match(text(result), /"models":"undefined"/);
    assert.doesNotMatch(text(result), /"bash"|"write"|"edit"|"policy_enforcer"/);
    result = await runtime.script('const d = await tools.docs_lookup({operation:"search",query:"NEEDLE"}); const c = await tools.code_context({operation:"search",query:"NEEDLE",paths:["src"]}); return {typed:typeof d, doc:d.results[0].path, source:c.items[0].path, freshness:c.freshness, provenance:c.items[0].provenance}');
    assert.equal(result.isError, false, text(result));
    assert.match(text(result), /"typed":"object"/);
    assert.match(text(result), /docs\/guide.md/);
    assert.match(text(result), /src\/value.js/);
    assert.equal(result.nestedCalls.calls.length, 2);
    assert(result.nestedCalls.calls.every(call => call.status === "ok"));
    assert(!runtime.session.messages.some(message => message.role === "toolResult" && message.toolName === "docs_lookup"), "nested results stay out of ordinary transcript entries");

    result = await runtime.script('const a = await tools.code_context({operation:"symbolGet",detail:"body",file:"src/value.js"}); const b = await tools.code_context({operation:"symbolGet",detail:"body",file:"src/value.js"}); return {first:a.refReused, second:b.refReused, snippet:b.items[0].snippet}');
    assert.equal(result.isError, false, text(result));
    assert.match(text(result), /"second":false/);
    assert.match(text(result), /NEEDLE/);

    result = await runtime.script('return await tools.test_runner({operation:"infer",files:["src/value.js"]})');
    assert.equal(result.details.outcome, "not-applicable", text(result));
    assert.equal(result.details.nestedOutcomes[0].outcome, "not-applicable");
    result = await runtime.script('try { await tools.test_runner({input:{operation:"run"}}); } catch {} return "pretend passed";');
    assert.equal(result.isError, true, "caught policy failures cannot become success");
    assert.equal(result.details.outcome, "blocked");
    assert(!fs.existsSync(path.join(runtime.cwd, ".pi/test-runner/latest.json")), "blocked execution has no verifier side effects");

    fs.mkdirSync(path.join(runtime.cwd, ".pi/policy-gate"), { recursive: true });
    fs.writeFileSync(path.join(runtime.cwd, ".pi/policy-gate/policy.json"), JSON.stringify({ denyPathPrefixes: [path.join(runtime.cwd, "private")] }));
    fs.mkdirSync(path.join(runtime.cwd, "private"));
    fs.writeFileSync(path.join(runtime.cwd, "private", "secret.txt"), "SYNTHETIC_PRIVATE_SENTINEL");
    result = await runtime.script('try { await tools.read({path:"private/secret.txt"}); } catch {} return "handled";');
    assert.equal(result.isError, true, text(result));
    assert.doesNotMatch(text(result), /SYNTHETIC_PRIVATE_SENTINEL/);
    assert.equal(runtime.events.filter(event => event.type === "tool_execution_end" && event.parentToolCallId && event.toolName === "read").at(-1).isError, true);

    result = await runtime.script('for (let i=0;i<33;i++) await tools.read({path:"docs/guide.md"}); return "hidden limit";');
    assert.equal(result.isError, true, text(result));
    assert.equal(result.details.outcome, "blocked");
    assert.equal(result.nestedCalls.calls.length, 32, "count is actual executed calls, not just outer script");
    result = await runtime.script('// @options: {"timeout_ms":50}\nwhile (true) {}');
    assert.equal(result.isError, true);
    assert.equal(result.details.outcome, "timed-out");
    result = await runtime.script('store("secret", "synthetic"); return "stored"');
    assert.equal(result.isError, true, "persistent script state is explicitly refused");
    assert(!runtime.session.sessionManager.getBranch().some(entry => entry.customType === "codemode-store"));
    resumeManager = runtime.session.sessionManager;
    resumeManager.appendCustomEntry("codemode-store", { set: { oldPrivateState: "synthetic-old-store-value" }, delete: [] });
    result = await runtime.script('return typeof load("oldPrivateState")');
    assert.match(text(result), /undefined/);
    assert.doesNotMatch(text(result), /synthetic-old-store-value/);
    result = await runtime.script('try { await tools.read({path:17}); } catch {} return "handled";');
    assert.equal(result.isError, true, "native argument validation cannot be hidden by a catch");
    assert.equal(result.nestedCalls.calls[0].status, "error");
    result = await runtime.script('return {process:typeof process,require:typeof require,fetch:typeof fetch,setTimeout:typeof setTimeout}');
    assert.equal(result.isError, false, text(result));
    assert.doesNotMatch(text(result), /"function"|"object"/);
    const telemetry = fs.readFileSync(path.join(runtime.cwd, ".pi/extension-telemetry/events.jsonl"), "utf8");
    assert.doesNotMatch(telemetry, /NEEDLE|guide\.md|SYNTHETIC_PRIVATE_SENTINEL|private\/secret/, "fleet telemetry contains no arguments or outputs");
    result = await runtime.script('return "x".repeat(20000)');
    assert.equal(result.isError, false, text(result));
    assert.match(text(result), /truncated output/);
    if (result.details.fullOutputPath) {
      const file = result.details.fullOutputPath;
      const stat = fs.lstatSync(file);
      assert(stat.isFile() && !stat.isSymbolicLink(), "spill is a regular file");
      assert.equal(stat.mode & 0o077, 0, "spill file is private even in the shared temp directory");
      fs.unlinkSync(file);
    }
  } finally { await runtime.close(); }

  const resumed = await createRuntime({ sessionManager: resumeManager, extensions: ["extensions/codemode/index.ts"] });
  try {
    const result = await resumed.script('return {old:typeof load("oldPrivateState"),tools:ALL_TOOLS.map(tool=>tool.name)}');
    assert.equal(result.isError, false, text(result));
    assert.match(text(result), /"old":"undefined"/);
    assert.doesNotMatch(text(result), /synthetic-old-store-value|"bash"|"write"|"edit"/);
  } finally { await resumed.close(); }

  for (const options of [{ excludeTools: ["codemode"] }, { tools: ["read"] }, { noTools: true }]) {
    const restricted = await createRuntime(options);
    try {
      assert(!restricted.session.getActiveToolNames().includes("codemode"), "explicit tool restrictions beat default-on");
      assert(!restricted.session.systemPrompt.includes(OUTPUT_CONTRACT), "an inactive CodeMode adds no output contract to the prompt");
    }
    finally { await restricted.close(); }
  }
  const previous = process.env.PI_CODEMODE;
  process.env.PI_CODEMODE = "0";
  try {
    const disabled = await createRuntime();
    try {
      assert(!disabled.session.getActiveToolNames().includes("codemode"), "environment opt-out wins");
      assert(!disabled.session.systemPrompt.includes(OUTPUT_CONTRACT), "the opt-out adds no output contract to the prompt");
    }
    finally { await disabled.close(); }
  } finally { if (previous === undefined) delete process.env.PI_CODEMODE; else process.env.PI_CODEMODE = previous; }

  const semantic = await createRuntime({ extensions: ["extensions/codemode/index.ts", ".pi/extensions/output-compactor/index.ts"], extensionFactories: [pi => pi.registerTool({ name: "docs_lookup", label: "Semantic fixture", description: "Synthetic negative with canonical evidence", parameters: { type: "object", properties: {} }, outputSchema: { type: "object" }, execute: async () => { const data = { outcome: "domain-negative", ok: false, evidenceId: "synthetic-proof", payload: "x".repeat(5000) }; return { content: [{ type: "text", text: JSON.stringify(data) }], details: data, structuredContent: data }; } })] });
  try {
    const result = await semantic.script('const result=await tools.docs_lookup({}); return {outcome:result.outcome,evidenceId:result.evidenceId,length:result.payload.length};');
    assert.equal(result.isError, true, "script completion cannot erase semantic negatives");
    assert.equal(result.details.outcome, "domain-negative");
    assert.match(text(result), /synthetic-proof/);
    assert.match(text(result), /5000/);
    assert(!fs.existsSync(path.join(semantic.cwd, ".pi/verification-center")), "script output does not manufacture verifier evidence");
  } finally { await semantic.close(); }

  const transport = await createRuntime({ extensions: ["extensions/codemode/index.ts"], extensionFactories: [pi => pi.registerTool({
    name: "docs_lookup", label: "Transport regression", description: "Synthetic failed transport retaining structured data",
    parameters: { type: "object", properties: { outcome: { type: "string" } }, required: ["outcome"] }, outputSchema: { type: "object" },
    execute: async (_id, args) => {
      const data = { outcome: args.outcome, ...(args.outcome === "succeeded" ? { ok: true } : {}) };
      return { content: [{ type: "text", text: "synthetic transport failure" }], details: data, structuredContent: data, isError: true };
    },
  })] });
  try {
    for (const outcome of ["succeeded", "not-applicable", "unknown", "domain-negative", "blocked", "cancelled", "timed-out"]) {
      const result = await transport.script(`try { await tools.docs_lookup({outcome:${JSON.stringify(outcome)}}); } catch {} return "pretend success";`);
      const expected = ["succeeded", "not-applicable", "unknown"].includes(outcome) ? "infrastructure-failed" : outcome;
      assert.equal(result.isError, true, `native error cannot become ${outcome}`);
      assert.equal(result.details.outcome, expected);
      assert.equal(result.details.nestedOutcomes[0].outcome, expected);
      assert.equal(result.nestedCalls.calls[0].status, "error", "canonical child error is retained");
    }
  } finally { await transport.close(); }

  let started = 0, cancelled = 0, ready;
  const childrenReady = new Promise(resolve => { ready = resolve; });
  const cancellation = await createRuntime({ extensions: ["extensions/codemode/index.ts"], extensionFactories: [pi => pi.registerTool({ name: "read", label: "Cancellation fixture", description: "Synthetic pending read", parameters: { type: "object", properties: {} }, async execute(_id, _args, signal) { if (++started === 4) ready(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { cancelled++; reject(new Error("cancelled fixture")); }, { once: true })); } })] });
  try {
    const running = cancellation.script('await Promise.all(Array.from({length:12},()=>tools.read({})));');
    await childrenReady;
    await cancellation.session.abort();
    await running;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, 4, "queued calls cannot start after cancellation");
    assert.equal(cancelled, 4, "cancellation reaches every in-flight native nested tool");
  } finally { await cancellation.close(); }

  const definition = { name: "codemode", promptGuidelines: ["native guideline"], prepareLoadout: () => ({ descriptions: { codemode: "native" } }), execute() {} };
  for (const enabled of [true, false]) {
    const governed = governedCodemode(definition, { enabled });
    assert.equal(governed.promptGuidelines.filter(line => line === OUTPUT_CONTRACT).length, 1, "the output contract is a single prompt guideline");
    assert.equal(governed.promptGuidelines[0], "native guideline");
  }
  assert(!governedCodemode(definition).prepareLoadout({ callable: [] }).descriptions.codemode.includes(OUTPUT_CONTRACT), "the contract is not duplicated into the tool description");
  assert.deepEqual(definition.promptGuidelines, ["native guideline"], "the native definition is not mutated");

  // Exercise the host semaphore independently of provider timing.
  let inFlight = 0, peak = 0;
  const native = { prepareLoadout: () => ({ descriptions: { codemode: "native" } }), execute: async (_id, _params, _signal, _update, ctx) => {
    await Promise.all(Array.from({ length: 12 }, () => ctx.executeTool("read", {})));
    return { content: [], details: {} };
  } };
  const context = { tools: [], sessionManager: { getBranch: () => [] }, executeTool: async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight--;
    return { isError: false, result: { details: {} } };
  } };
  const bounded = await governedCodemode(native).execute("fixture", { code: "return 1" }, undefined, undefined, context);
  assert.equal(peak, 4);
  assert.equal(bounded.details.nestedOutcomes.length, 12);
  console.log("codemode native integration tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
