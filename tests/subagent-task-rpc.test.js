"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SubagentRunner } = require("../src/subagents");
const { DEFAULT_ROLE_CONTRACTS } = require("../src/role-contracts");
const { acquireManagedWorker, processIdentity } = require("../src/resource-guard");
const { containmentProbe, runContained, executable } = require("../src/specialist-tools");
const { execFileSync } = require("node:child_process");
const { tmpFixture } = require("./helpers/tmp-fixture");
(async () => {
  if (!containmentProbe().available) { console.log("SKIP task RPC: containment unavailable"); return; }
  const cwd = tmpFixture("pi-task-rpc-");
  try {
    // Failed exec must preserve its errno rather than attempting to own an
    // absent PID, and must release its worker lease after the close event.
    const brokenTools = path.join(cwd, "broken-tools");
    fs.mkdirSync(brokenTools);
    fs.writeFileSync(path.join(brokenTools, "bwrap"), "#!/missing/pi-test-interpreter\n", { mode: 0o700 });
    await assert.rejects(runContained({ cwd, command: "/usr/bin/true", env: { PATH: brokenTools } }), error => error.code === "ENOENT" && error.path === path.join(brokenTools, "bwrap"));
    fs.copyFileSync("/usr/bin/true", path.join(cwd, "target"));
    if (executable("cc") && executable("gdb")) {
      fs.writeFileSync(path.join(cwd, "native.c"), "#include <stdlib.h>\nint main(void) { abort(); }\n");
      execFileSync("cc", ["-g", "-O0", "-o", "native", "native.c"], { cwd });
    }
    const fixture = path.join(cwd, "rpc.js");
    fs.writeFileSync(fixture, `
const {acquireManagedWorker}=require(${JSON.stringify(path.resolve(__dirname, "../src/resource-guard"))});
(async()=>{const inherited=await acquireManagedWorker(); await inherited.release();
const emit=x=>process.stdout.write(JSON.stringify(x)+"\\n"); let buffer="", settled=false; const configured=[];
const fixtureId=process.env.PI_SUBAGENT_PARENT_ID;
if(fixtureId==="native-handoff") {
  const contract=JSON.parse(Buffer.from(process.env.PI_ROLE_CONTRACT_B64,"base64url"));
  emit({type:"tool_execution_start",toolName:"role_domain",toolCallId:"original-native",args:{operation:"time-profile",file:"target"}});
  const native=await require(${JSON.stringify(path.resolve(__dirname, "../src/specialist-tools"))}).runDomain({cwd:process.cwd(),contract,operation:"time-profile",file:"target"});
  emit({type:"tool_execution_end",toolName:"role_domain",toolCallId:"original-native",result:{details:native},isError:!native.ok});
  emit({type:"message_update",assistantMessageEvent:{type:"thinking_delta",delta:"PRIVATE_RPC_CANARY"}});
}
if(fixtureId==="native-fixture") {
  const assert=require("node:assert/strict"),fs=require("node:fs"),crypto=require("node:crypto");
  fs.closeSync(fs.openSync("/dev/null","r"));
  assert(fs.statSync("/dev/zero").isCharacterDevice(), "other device paths remain visible");
  assert.throws(()=>fs.openSync("/dev/zero","r"),e=>e.code==="EACCES", "outer device access is not widened");
  const {runDomain}=require(${JSON.stringify(path.resolve(__dirname, "../src/specialist-tools"))});
  const {DEFAULT_ROLE_CONTRACTS}=require(${JSON.stringify(path.resolve(__dirname, "../src/role-contracts"))});
  for(const [roleId,operation,file] of [["code-profiler","time-profile","target"],["reliability-investigator","gdb-backtrace","native"]]) {
    if(!fs.existsSync(file))continue;
    const contract=structuredClone(DEFAULT_ROLE_CONTRACTS.find(r=>r.roleId===roleId));
    contract.settings.taskPolicy={readZones:[file,"native.c"],writeZones:[]};
    contract.settings.domainInput={execution:{authorization:"Execute only the owned regression fixture once.",target:file,sha256:crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),args:[],operations:[operation],timeoutMs:15000}};
    const native=await runDomain({cwd:process.cwd(),contract,operation,file});
    if(operation==="time-profile") {assert.equal(native.ok,true,JSON.stringify(native));assert.match(native.stderr,/Maximum resident set size/);}
    else {assert.equal(native.ok,false);assert.match(native.stdout+native.stderr,/SIGABRT/);assert.match(native.stdout+native.stderr,/native.c/);}
    assert.equal(native.diagnosticEvidence.operation,operation);
  }
}
const {createRoleResultEnvelope}=require(${JSON.stringify(path.resolve(__dirname, "../src/role-result-schemas"))});
const submission={summary:"Provider-free contained RPC fixture with explicit evidence.",findings:[],evidence:[{kind:"fixture",summary:"Exercised contained RPC and inherited worker ownership."}],verification:{status:"passed",evidence:["Provider-free process fixture only."]}};
if(fixtureId==="native-handoff")submission.dossier={assumptions:[],claims:[{id:"c",statement:"The fixture collected GNU time output.",status:"observed",assumptionIds:[],evidenceIds:["e"],limitationIds:["l"],proofObligationIds:[]}],evidenceRefs:[{id:"e",source:"role_domain:time-profile",locator:"stderr",observation:"GNU time returned resource observations."}],limitations:[{id:"l",statement:"Synthetic RPC regression, not performance acceptance."}],proofObligations:[]};
const result=createRoleResultEnvelope({contract:JSON.parse(Buffer.from(process.env.PI_ROLE_CONTRACT_B64,"base64url")),subagentId:process.env.PI_SUBAGENT_PARENT_ID,submission});
const messages=[{role:"assistant",content:[{type:"toolCall",id:"submit1",name:"submit_role_result",arguments:submission}]},{role:"toolResult",toolCallId:"submit1",toolName:"submit_role_result",isError:false,content:[{type:"text",text:"Role result submitted."}],details:{result}},{role:"assistant",content:[{type:"text",text:submission.summary}],usage:{input:1,output:1,totalTokens:2,cost:{total:0}}}];
if(fixtureId==="unbudgeted")messages.unshift(...Array.from({length:20},()=>({role:"assistant",content:[{type:"text",text:"Observed intermediate work"}],usage:{input:1,output:1,totalTokens:2,cost:{total:0}}})));
process.stdin.on("data",chunk=>{buffer+=chunk; let end; while((end=buffer.indexOf("\\n"))>=0){const msg=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
if(msg.type==="set_auto_retry"||msg.type==="set_auto_compaction"){if(msg.enabled!==false)process.exit(9);configured.push(msg.type);emit({type:"response",id:msg.id,command:msg.type,success:fixtureId!=="reject-settings"});}
if(msg.type==="get_state"&&msg.id.startsWith("subagent_vision_")){const [provider,...id]=process.env.PI_ROLE_EXPECTED_MODEL.split("/");emit({type:"response",id:msg.id,command:"get_state",success:true,data:{model:{provider,id:id.join("/"),input:fixtureId==="vision-unsupported"?["text"]:["text","image"]}}});continue;}
if(msg.type==="prompt"){if(JSON.stringify(configured)!==JSON.stringify(["set_auto_retry"]))process.exit(10);require("node:fs").writeFileSync("prompt-"+fixtureId,JSON.stringify(msg.images||[]));emit({type:"response",id:msg.id,command:"prompt",success:true});emit({type:"agent_end",messages});setTimeout(()=>{settled=true;emit({type:"agent_settled",aborted:false});},30);}
if(msg.type==="get_state"){if(!settled)process.exit(11);const [provider,...id]=process.env.PI_ROLE_EXPECTED_MODEL.split("/");emit({type:"response",id:msg.id,command:"get_state",success:true,data:{model:{provider,id:id.join("/")},thinkingLevel:process.env.PI_ROLE_EXPECTED_THINKING_LEVEL,isStreaming:false,autoCompactionEnabled:fixtureId==="compaction-still-enabled"}});}
if(msg.type==="get_messages")emit({type:"response",id:msg.id,command:"get_messages",success:true,data:{messages}});
}});})().catch(error=>{console.error(error);process.exit(1);});
`);
    const role = structuredClone(DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === "verifier"));
    role.settings.taskPolicy = { taskId: "native-fixture", readZones: ["rpc.js"], writeZones: [] };
    let spawned, closed;
    // Occupy the other slot: the sidecar's nested tool must borrow its own slot,
    // not deadlock while requesting a third global worker.
    const other = await acquireManagedWorker();
    try {
      const result = await new SubagentRunner().runInRpcSubprocess({ id: "native-fixture", roleContract: role, toolPolicy: role.toolPolicy, budget: { wallClockMs: 5000 } }, "fixture only", { cwd, thinkingLevel: "high", rpc: { command: process.execPath, argsPrefix: [fixture], noSession: true }, onProcessSpawn: value => { spawned = value; }, onProcessClose: value => { closed = value; } });
      assert.match(result.final_response, /Provider-free contained RPC fixture/);
      assert.deepEqual(closed, spawned, "persisted process ownership is closed exactly");
      assert.equal(processIdentity(spawned.processGroupId), null, "the task process namespace has exited");
    } finally { await other.release(); }
    const diagnosticRole = structuredClone(DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === "code-profiler"));
    diagnosticRole.settings.taskPolicy = { readZones: ["target"], writeZones: [] };
    diagnosticRole.settings.domainInput = { execution: { authorization: "Run the owned RPC evidence fixture once.", target: "target", sha256: require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(cwd, "target"))).digest("hex"), args: [], operations: ["time-profile"], timeoutMs: 15000 } };
    const handoff = await new SubagentRunner().runInRpcSubprocess({ id: "native-handoff", roleContract: diagnosticRole, toolPolicy: diagnosticRole.toolPolicy, budget: null }, "fixture only", { cwd, model: { provider: "fixture", id: "parent" }, thinkingLevel: "high", rpc: { command: process.execPath, argsPrefix: [fixture], noSession: true } });
    assert.equal(handoff.diagnosticEvidence.length, 1);
    assert.match(handoff.diagnosticEvidence[0].stderr, /Maximum resident set size/);
    assert.equal(handoff.diagnosticEvidence[0].exitCode, 0);
    assert.equal(handoff.diagnosticEvidence[0].toolCallId, "original-native");
    assert(!JSON.stringify(handoff).includes("PRIVATE_RPC_CANARY"));
    assert.equal(handoff.submitted_result.diagnosticEvidence, undefined, "originals are not producer-authored fields");
    assert.equal(handoff.rpc_session_dir, null, "no raw transcript is needed, even when final messages omit earlier tool results");
    for (const [id, error] of [["reject-settings", /failure-stop configuration was rejected/]]) {
      await assert.rejects(() => new SubagentRunner().runInRpcSubprocess({ id, roleContract: role, toolPolicy: role.toolPolicy, budget: { wallClockMs: 5000 } }, "fixture only", { cwd, thinkingLevel: "high", rpc: { command: process.execPath, argsPrefix: [fixture], noSession: true } }), error);
    }
    assert.equal(fs.existsSync(path.join(cwd, "prompt-reject-settings")), false, "no prompt is sent when failure-stop configuration is not acknowledged");
    const unbudgetedRole = { ...role, budget: null, modelPolicy: { mode: "inherit", preference: null, fallback: "inherit", thinkingLevel: "inherit" } };
    // Ambient PI_ROLE_MODEL_*/PI_ROLE_THINKING_* values are operator configuration and
    // win for unbudgeted roles too, so clear them to make the inherited case deterministic.
    const verifierEnv = { PI_ROLE_MODEL_VERIFIER: process.env.PI_ROLE_MODEL_VERIFIER, PI_ROLE_THINKING_VERIFIER: process.env.PI_ROLE_THINKING_VERIFIER };
    delete process.env.PI_ROLE_MODEL_VERIFIER; delete process.env.PI_ROLE_THINKING_VERIFIER;
    try {
      const unbudgeted = await new SubagentRunner().runInRpcSubprocess({ id: "unbudgeted", roleContract: unbudgetedRole, toolPolicy: role.toolPolicy, budget: null }, "fixture only", { cwd, model: { provider: "fixture", id: "parent" }, thinkingLevel: "low", rpc: { command: process.execPath, argsPrefix: [fixture], noSession: true, timeoutMs: 1, model: "wrong/override", thinkingLevel: "high" } });
      assert.equal(unbudgeted.selected_model, "fixture/parent");
      assert.equal(unbudgeted.selected_thinking_level, "low");
      assert.equal(unbudgeted.wallClockBudgetMs, null);
      assert(unbudgeted.modelCalls > 8, "old role call limits do not cap specialist execution");
      const images = [{ type: "image", mimeType: "image/png", data: fs.readFileSync(path.join(__dirname, "fixtures/specialist-contact-sheet.png")).toString("base64") }];
      const visionContext = { cwd, images, model: { provider: "fixture", id: "parent" }, thinkingLevel: "low", rpc: { command: process.execPath, argsPrefix: [fixture], noSession: true } };
      await new SubagentRunner().runInRpcSubprocess({ id: "vision-images", roleContract: unbudgetedRole, toolPolicy: role.toolPolicy, budget: null }, "Inspect the supplied contact sheet", visionContext);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, "prompt-vision-images"), "utf8")), images, "image content reaches the RPC prompt without text encoding or truncation");
      await assert.rejects(() => new SubagentRunner().runInRpcSubprocess({ id: "vision-unsupported", roleContract: unbudgetedRole, toolPolicy: role.toolPolicy, budget: null }, "Inspect the image", visionContext), error => error.code === "SUBAGENT_VISION_UNAVAILABLE");
      assert.equal(fs.existsSync(path.join(cwd, "prompt-vision-unsupported")), false, "text-only model never receives an inference prompt");
    } finally {
      for (const [name, value] of Object.entries(verifierEnv)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
    await assert.rejects(() => new SubagentRunner().runInRpcSubprocess({}, "fixture", { images: [{ type: "image", mimeType: "image/png", data: "invalid" }] }), error => error.code === "SUBAGENT_IMAGES_INVALID");
    const first = await acquireManagedWorker(), second = await acquireManagedWorker();
    await first.release(); await second.release();
    console.log("✓ contained task RPC, inherited shared admission and process cleanup");
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
