"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

// Use real children, but split pipe input before Readable's decoder. OS write
// boundaries are not read boundaries; sleeps would make this regression flaky.
const spawn = childProcess.spawn;
let fragmentedBytes = 0;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  // Only fragment owned children, not the worker-admission readiness handshake.
  if (!args[2]?.detached) return child;
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    const push = stream.push;
    stream.push = function (chunk, encoding) {
      if (!Buffer.isBuffer(chunk)) return push.call(this, chunk, encoding);
      let accepted = true;
      for (const byte of chunk) {
        fragmentedBytes++;
        accepted = push.call(this, Buffer.from([byte]));
      }
      return accepted;
    };
  }
  // The stderr-only fixture exits after the parent has consumed EOF, avoiding
  // an unrelated race between process exit and pipe drainage.
  if (args[1].includes("stderr-fixture")) child.stderr.once("end", () => child.stdin.write('{"type":"stderr-drained"}\n'));
  return child;
};
let SubagentRunner, runContained, containmentProbe;
try {
  ({ SubagentRunner } = require("../src/subagents"));
  ({ runContained, containmentProbe } = require("../src/specialist-tools"));
} finally { childProcess.spawn = spawn; }
const { DEFAULT_ROLE_CONTRACTS } = require("../src/role-contracts");
const { digest } = require("../src/subagent-task-contracts");
const { validateDiagnosticEvidence } = require("../src/diagnostic-evidence");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const cwd = tmpFixture("pi-subprocess-utf8-");
  try {
    const stdout = "frame λ in naïve € 🧪\n";
    const stderr = "erreur é / 错误 / 😀\n";
    const summary = `Original diagnostic text survives fragmented UTF-8: ${stdout.trim()}`;
    const execution = { target: "fixture", sha256: "a".repeat(64), args: [], operations: ["time-profile"], timeoutMs: 5000 };
    const contract = structuredClone(DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === "code-profiler"));
    contract.settings.domainInput = { execution };
    const native = { ok: true, exitCode: 0, signal: null, termination: null, stdout, stderr, diagnosticEvidence: { operation: "time-profile", target: execution.target, targetSha256: execution.sha256, argumentsSha256: digest(JSON.stringify(execution.args)).slice(7), tools: { time: { available: true, path: "/usr/bin/time", sha256: "b".repeat(64) } }, gpuDevices: [], timeoutMs: execution.timeoutMs } };
    const fixture = path.join(cwd, "rpc.js");
    fs.writeFileSync(fixture, `
const {createRoleResultEnvelope}=require(${JSON.stringify(path.resolve(__dirname, "../src/role-result-schemas"))});
const submission={summary:${JSON.stringify(summary)},findings:[],evidence:[{kind:"fixture",summary:"Deterministic UTF-8 transport regression only."}],verification:{status:"passed",evidence:["Synthetic protocol fixture, not a live model."]},dossier:{assumptions:[],claims:[{id:"c",statement:"Unicode output is preserved.",status:"observed",assumptionIds:[],evidenceIds:["e"],limitationIds:["l"],proofObligationIds:[]}],evidenceRefs:[{id:"e",source:"role_domain:time-profile",locator:"stdout",observation:"Fragmented UTF-8 output."}],limitations:[{id:"l",statement:"Transport fixture only."}],proofObligations:[]}};
const result=createRoleResultEnvelope({contract:JSON.parse(Buffer.from(process.env.PI_ROLE_CONTRACT_B64,"base64url")),subagentId:process.env.PI_SUBAGENT_PARENT_ID,submission});
const messages=[{role:"assistant",content:[{type:"toolCall",id:"submit1",name:"submit_role_result",arguments:submission}]},{role:"toolResult",toolCallId:"submit1",toolName:"submit_role_result",isError:false,content:[{type:"text",text:"Role result submitted."}],details:{result}},{role:"assistant",stopReason:"stop",content:[{type:"text",text:submission.summary}]}];
const emit=value=>process.stdout.write(JSON.stringify(value)+"\\n");
process.stdin.setEncoding("utf8");
let pending="";
process.stdin.on("data",chunk=>{pending+=chunk;let end;while((end=pending.indexOf("\\n"))>=0){const request=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);
if(request.type==="stderr-drained"){process.stdin.destroy();process.exitCode=17;}
else if(request.type==="prompt"){
  if(process.argv[2]==="stderr-fixture"){process.stderr.end(Buffer.concat([Buffer.from(${JSON.stringify(stderr)}),Buffer.from([0xe2,0x82])]));continue;}
  emit({type:"response",id:request.id,command:"prompt",success:true});
  emit({type:"tool_execution_start",toolName:"role_domain",toolCallId:"native",args:{operation:"time-profile",file:"fixture"}});
  emit({type:"tool_execution_end",toolName:"role_domain",toolCallId:"native",isError:false,result:{details:${JSON.stringify(native)}}});
  emit({type:"agent_end",messages});
}else if(request.type==="get_state"){const [provider,...id]=process.env.PI_ROLE_EXPECTED_MODEL.split("/");emit({type:"response",id:request.id,command:"get_state",success:true,data:{model:{provider,id:id.join("/")},thinkingLevel:process.env.PI_ROLE_EXPECTED_THINKING_LEVEL,isStreaming:false}});}
else if(request.type==="get_messages")emit({type:"response",id:request.id,command:"get_messages",success:true,data:{messages}});
}});
`);
    const runner = new SubagentRunner();
    const rpc = scenario => runner.runInRpcSubprocess({ id: "utf8-fixture", roleContract: contract, toolPolicy: contract.toolPolicy, budget: { wallClockMs: 5000 } }, "fixture only", { cwd, model: { provider: "fixture", id: "utf8" }, thinkingLevel: "high", rpc: { command: process.execPath, argsPrefix: [fixture, scenario], noSession: true } });
    const result = await rpc("success");
    assert.equal(result.final_response, summary);
    assert.equal(result.submitted_result.summary, summary);
    assert.equal(result.diagnosticEvidence.length, 1);
    const receipt = result.diagnosticEvidence[0];
    assert.equal(receipt.stdout, stdout);
    assert.equal(receipt.stderr, stderr);
    validateDiagnosticEvidence([receipt], { subagentId: "utf8-fixture", execution });
    assert.equal(result.rpc_session_dir, null);
    await assert.rejects(rpc("stderr-fixture"), error => {
      assert.equal(error.code, "SUBAGENT_RPC_EXIT");
      assert(error.message.endsWith(`${stderr}�`), "stderr keeps split characters and flushes an incomplete sequence at EOF once");
      return true;
    });
    console.log("✓ fragmented RPC text, diagnostic receipt integrity and stderr EOF");

    if (!containmentProbe().available) { console.log("SKIP contained UTF-8 fixtures: containment unavailable"); return; }
    const run = (script, maxOutputBytes = 1024) => runContained({ cwd, command: process.execPath, runtimeRoot: path.dirname(fs.realpathSync(process.execPath)), args: ["-e", script], timeoutMs: 5000, maxOutputBytes });
    const write = (out, err = "") => `process.stdout.write(${JSON.stringify(out)});process.stderr.write(${JSON.stringify(err)});`;
    const normal = await run(write(stdout, stderr), Buffer.byteLength(stdout + stderr));
    assert.equal(normal.ok, true);
    assert.equal(normal.stdout, stdout);
    assert.equal(normal.stderr, stderr);
    assert.equal(normal.outputBytes, Buffer.byteLength(stdout + stderr));
    // Check cuts inside a two-, three- and four-byte character, and exact limits.
    for (const character of ["λ", "€", "🧪"]) {
      const text = `A${character}`;
      for (const maxBytes of [Buffer.byteLength(text) - 1, Buffer.byteLength(text)]) {
        for (const stream of ["stdout", "stderr"]) {
          const bounded = await run(write(stream === "stdout" ? text : "", stream === "stderr" ? text : ""), maxBytes);
          const truncated = maxBytes < Buffer.byteLength(text);
          assert.equal(bounded.ok, !truncated);
          assert.equal(bounded.termination, truncated ? "output-limit" : null);
          assert.equal(bounded[stream], truncated ? "A" : text, "a byte quota must not manufacture a replacement character");
          assert.equal(bounded[stream === "stdout" ? "stderr" : "stdout"], "");
          assert.equal(bounded.outputBytes, Buffer.byteLength(text));
          assert(Buffer.byteLength(bounded.stdout + bounded.stderr) <= maxBytes);
        }
      }
    }
    const combined = await run(write("λ", "€"), 4);
    assert.equal(combined.ok, false);
    assert.equal(combined.termination, "output-limit");
    assert.equal(combined.outputBytes, 5);
    assert(["λ", ""].includes(combined.stdout));
    assert(["€", ""].includes(combined.stderr));
    assert(Buffer.byteLength(combined.stdout + combined.stderr) <= 4, "stdout and stderr share one raw-byte quota");
    const incomplete = await run("process.stdout.write(Buffer.from([0xe2,0x82]));process.stderr.write(Buffer.from([0xf0,0x9f]));");
    assert.equal(incomplete.ok, true);
    assert.equal(incomplete.stdout, "�");
    assert.equal(incomplete.stderr, "�");
    assert.equal(incomplete.outputBytes, 4, "counters measure raw bytes, not UTF-8 replacement text");
    const invalid = await run("process.stdout.write(Buffer.from([0xff,0xff]));", 2);
    assert.equal(invalid.outputBytes, 2);
    assert(Buffer.byteLength(invalid.stdout + invalid.stderr) <= 2, "replacement expansion cannot exceed the retained-text quota");
    assert(fragmentedBytes > 0, "real pipe buffers passed through forced single-byte fragmentation");
    console.log("✓ fragmented native stdout/stderr, raw byte accounting, UTF-8 quota boundaries and EOF");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
