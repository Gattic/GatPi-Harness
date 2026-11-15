"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("pi-rpc-degraded-");
const fakeBin = path.join(cwd, "bin");
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, "bwrap"), "#!/bin/sh\nprintf '%s\\n' 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' >&2\nexit 1\n", { mode: 0o700 });
const originalPath = process.env.PATH;
process.env.PATH = fakeBin;

(async () => {
  try {
    const { containmentProbe } = require("../src/specialist-tools");
    const probe = containmentProbe();
    assert.equal(probe.available, false, "a failing bwrap probe must not claim containment");
    assert.match(probe.reason, /bwrap-unusable/, "the unavailable result retains the typed probe reason");
    assert.match(probe.reason, /Operation not permitted/, "the probe stderr is reported, not replaced by a generic reason");

    const fixture = path.join(cwd, "rpc.js");
    fs.writeFileSync(fixture, `
const {createRoleResultEnvelope}=require(${JSON.stringify(path.resolve(__dirname, "../src/role-result-schemas"))});
let buffer="", messages=[];
const emit=value=>process.stdout.write(JSON.stringify(value)+"\\n");
const contract=JSON.parse(Buffer.from(process.env.PI_ROLE_CONTRACT_B64,"base64url"));
process.stdin.on("data",chunk=>{
  buffer+=chunk; let end;
  while((end=buffer.indexOf("\\n"))>=0){
    const msg=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
    if(msg.type==="set_auto_retry"){emit({type:"response",id:msg.id,command:msg.type,success:true});continue;}
    if(msg.type==="prompt"){
      const submission={summary:"Degraded non-namespaced transport fixture completed.",findings:[],evidence:[{kind:"fixture",summary:"Direct RPC transport ran without a PID namespace."}],verification:{status:"passed",evidence:["Provider-free direct RPC fixture."]}};
      const result=createRoleResultEnvelope({contract,subagentId:process.env.PI_SUBAGENT_PARENT_ID,submission});
      messages=[{role:"assistant",content:[{type:"toolCall",id:"submit1",name:"submit_role_result",arguments:submission}]},{role:"toolResult",toolCallId:"submit1",toolName:"submit_role_result",isError:false,content:[{type:"text",text:"Role result submitted."}],details:{result}},{role:"assistant",content:[{type:"text",text:submission.summary}],usage:{input:1,output:1,totalTokens:2,cost:{total:0}}}];
      emit({type:"response",id:msg.id,command:"prompt",success:true});
      emit({type:"agent_end",messages});
      setTimeout(()=>emit({type:"agent_settled",aborted:false}),30);
      continue;
    }
    if(msg.type==="get_state"){
      const [provider,...id]=process.env.PI_ROLE_EXPECTED_MODEL.split("/");
      emit({type:"response",id:msg.id,command:"get_state",success:true,data:{model:{provider,id:id.join("/")},thinkingLevel:process.env.PI_ROLE_EXPECTED_THINKING_LEVEL,isStreaming:false,autoCompactionEnabled:false}});
      continue;
    }
    if(msg.type==="get_messages")emit({type:"response",id:msg.id,command:"get_messages",success:true,data:{messages}});
  }
});
`);

    const { SubagentRunner } = require("../src/subagents");
    const { DEFAULT_ROLE_CONTRACTS } = require("../src/role-contracts");
    const role = structuredClone(DEFAULT_ROLE_CONTRACTS.find(contract => contract.roleId === "verifier"));
    role.settings.taskPolicy = { readZones: [], writeZones: [] };
    const result = await new SubagentRunner().runInRpcSubprocess(
      { id: "degraded-rpc", roleContract: role, toolPolicy: role.toolPolicy, budget: { wallClockMs: 5000 } },
      "fixture only",
      { cwd, model: { provider: "fixture", id: "parent" }, thinkingLevel: "high", rpc: { command: process.execPath, argsPrefix: [fixture], noSession: true } }
    );
    assert.equal(result.transport, "direct", "task RPC falls back to the existing direct transport");
    assert.equal(result.containment, "unavailable");
    assert.match(result.containment_reason, /Operation not permitted/);
    assert.match(result.final_response, /Degraded non-namespaced transport fixture completed/);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  console.log("✓ containment probe reason and non-namespaced task RPC fallback");
})().catch(error => { console.error(error); process.exitCode = 1; });
