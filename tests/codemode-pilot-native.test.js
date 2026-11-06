"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { MANIFEST, prepareTask, observedFiles, checkAnswer, digest } = require("../src/codemode-benchmark");
const { governedCodemode } = require("../src/codemode-policy");
const { GUIDELINE, withPilotGuideline } = require("../src/codemode-pilot");
const { installedRuntime, createRuntime } = require("./helpers/codemode-runtime");

(async () => {
  const before = { fetch: global.fetch, WebSocket: global.WebSocket, connect: net.Socket.prototype.connect };
  const deny = () => { throw new Error("Network forbidden in offline native qualification"); };
  global.fetch = deny; global.WebSocket = class { constructor() { deny(); } }; net.Socket.prototype.connect = deny;
  const defaults = path.resolve(__dirname, "../config/harness-defaults.env"), defaultHash = digest(fs.readFileSync(defaults));
  try {
    const { sdk } = await installedRuntime();
    const scenarios = ["control", "treatment"].flatMap(arm => [MANIFEST[0], MANIFEST[10], MANIFEST[20]].flatMap(task => {
      const terminals = arm === "treatment" && task.kind === "chain" ? ["valid", "wrong", "malformed", "error", "aborted"] : ["valid"];
      return terminals.map(terminal => ({ arm, task, terminal }));
    }));
    for (const { arm, task, terminal } of scenarios) {
      let registered;
      const native = sdk.createCodemodeExtension({ models: false });
      const runtime = await createRuntime({ extensions: [], tools: ["read", "codemode"], extensionFactories: [pi => native(new Proxy(pi, {
        get(target, key) {
          if (key === "registerTool") return definition => {
            registered = withPilotGuideline(governedCodemode(definition), arm);
            pi.registerTool(registered);
          };
          const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
        },
      }))] });
      try {
        assert.equal(runtime.session.model.api, runtime.faux.api, "only the exact registered synthetic API may enter this test");
        assert.equal(runtime.session.model.provider, runtime.faux.getModel().provider);
        assert.equal(registered.promptGuidelines.filter(s => s === GUIDELINE).length, arm === "treatment" ? 1 : 0);
        const prepared = prepareTask(task, runtime.cwd);
        let code;
        if (task.kind === "chain") code = 'const route=JSON.parse(await tools.read({path:"docs/route.json"})); const rows=JSON.parse(await tools.read({path:route.source})); return {value:rows.find(r=>r.id===route.id).amount,evidence:["docs/route.json",route.source]};';
        else code = `const paths=${JSON.stringify(prepared.evidence)}; const rows=await Promise.all(paths.map(async path=>JSON.parse(await tools.read({path})))); return {value:rows.reduce((n,list)=>n+list.find(r=>r.id==="record-${task.seed % 40}").amount,0),evidence:paths};`;
        const expected = JSON.stringify({ value: prepared.expected, evidence: prepared.evidence });
        runtime.faux.setResponses([
          context => {
            const text = JSON.stringify(context);
            assert.equal(text.includes(GUIDELINE), arm === "treatment", "native prompt contains the experimental guideline only in treatment");
            return runtime.ai.fauxAssistantMessage([runtime.ai.fauxToolCall("codemode", { code })], { stopReason: "toolUse" });
          }, runtime.ai.fauxAssistantMessage(terminal === "wrong" ? '{"value":-1,"evidence":[]}' : terminal === "malformed" ? "not-json" : expected,
            { stopReason: ["error", "aborted"].includes(terminal) ? terminal : "stop" }),
        ]);
        let promptFailed = false;
        try { await runtime.session.prompt(prepared.prompt); } catch { promptFailed = true; }
        if (["valid", "wrong", "malformed"].includes(terminal)) assert.equal(promptFailed, false);
        const tool = runtime.session.messages.find(m => m.role === "toolResult" && m.toolName === "codemode");
        assert.equal(tool.isError, false); assert.equal(tool.details.outcome, "succeeded");
        const output = tool.content.filter(x => x.type === "text").map(x => x.text).join("\n");
        assert(output.includes(expected)); assert.doesNotMatch(output, /Synthetic reference|irrelevant context|full output.*saved/i);
        const final = runtime.session.messages.at(-1);
        const finalText = (final?.content || []).filter(x => x.type === "text").map(x => x.text).join("");
        const terminalOk = final?.role === "assistant" && final.stopReason === "stop"
          && checkAnswer(finalText, prepared, observedFiles(runtime.events, runtime.cwd)).ok;
        assert.equal(terminalOk, terminal === "valid", `actual terminal ${terminal} answer and stop reason must pass the oracle`);
        assert.equal(runtime.events.filter(e => e.type === "tool_execution_start" && e.parentToolCallId && e.toolName === "read").length, prepared.evidence.length);
        assert(Object.entries(prepared.files).every(([file, bytes]) => fs.readFileSync(path.join(runtime.cwd, file), "utf8") === bytes));
        assert.equal(runtime.faux.state.callCount, 2);
      } finally { await runtime.close(); }
    }
    assert.equal(digest(fs.readFileSync(defaults)), defaultHash);
  } finally { global.fetch = before.fetch; global.WebSocket = before.WebSocket; net.Socket.prototype.connect = before.connect; }
  console.log("offline native faux/QuickJS: session-local guideline, dependent reads, projected output, exact oracle/evidence and unchanged defaults passed; no live qualification claimed");
})().catch(error => { console.error(error); process.exitCode = 1; });
