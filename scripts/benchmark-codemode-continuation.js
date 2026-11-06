#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { MANIFEST, digest, observedFiles, checkAnswer } = require("../src/codemode-benchmark");
const { tokenUsage } = require("../src/codemode-phase-benchmark");
const { continuationSchedule, installRawWebSocketTap, createRawMeasurements, summarizeContinuation, SEED, LIMIT, STALL_MS } = require("../src/codemode-continuation-benchmark");
const { optionsFor, prepareTaskOnce, keepSpills } = require("./benchmark-codemode-decision");
const { filesUnder, fileDigest } = require("./benchmark-codemode-phases");
const { sourceDigest, protectedDigest, save, treeBytes, liveInference } = require("./benchmark-codemode");
const { installedRuntime, createRuntime } = require("../tests/helpers/codemode-runtime");
const ledger = require("../src/experiment-ledger");
const root = path.resolve(__dirname, "..");
const BUDGETS = { elapsedMs: 25 * 60000, reportedCost: 2, caseMs: 120000, evidenceBytes: 64 * 1024 * 1024, fixtureBytes: 128 * 1024 * 1024, eventEntriesPerCase: LIMIT };
const FROZEN = ".pi/codemode-decision-benchmark/live-1792855279662";
const FROZEN_HASH = "c80215bc630b20c9ac9e8aac61160ae8a8b0df1a29843b69e7b8bc7e5d3df24e";
const ENV_KEYS = ["PI_CODEMODE", "PI_TOOL_SURFACE_ROUTER", "PI_OUTPUT_COMPACTOR", "PI_OUTPUT_COMPACTOR_MODE", "PI_OUTPUT_COMPACTOR_MAX_CHARS", "PI_POLICY_ENFORCER", "PI_POLICY_ENFORCER_MODE", "PI_EXTENSION_TELEMETRY", "PI_DOCS_ALLOW_OUTSIDE"];
const environmentDigest = () => digest(Object.fromEntries(ENV_KEYS.map(k => [k,process.env[k] ?? null])));
function ownedPaths() { return fs.readdirSync(path.join(root,".pi")).filter(n=>n.startsWith("codemode")).map(n=>path.join(root,".pi",n)); }
function retainedBytes() {
  return ownedPaths().reduce((n,f)=>{ const stat=fs.lstatSync(f); if(stat.isSymbolicLink())throw new Error("Unexpected evidence symlink"); return n+(stat.isDirectory()?treeBytes(f):stat.size); },0);
}
async function measureCase({ assignment, cwd, prepared, inference, getStats, tap, run, intact, remainingMs }) {
  let runtime;
  const phases = createRawMeasurements({ stats: () => runtime ? getStats(runtime.session.sessionId) : undefined });
  const setupAt = performance.now();
  runtime = await createRuntime({ cwd, inference,
    settings: { transport: assignment.transport, compaction:{enabled:false},retry:{enabled:false},codemode:{mode:"on"} },
    tools:["read","docs_lookup","code_context","codemode"],excludeTools:assignment.arm==="direct"?["codemode"]:[],
    extensionFactories:[pi=>{
      phases.install(pi);
      pi.on("tool_call",event=>{
        if(event.toolName === "read") {
          const file=path.relative(cwd,path.resolve(cwd,String(event.input.path||"").replace(/^@/,"")));
          if(!Object.hasOwn(prepared.files,file))return {block:true,reason:"Reads confined to frozen synthetic fixture"};
        }
      });
    }],
  });
  const setupMs=performance.now()-setupAt,unsubscribe=runtime.session.subscribe(phases.observe);
  let row,unwatch;
  try {
    if(runtime.session.model.provider!==inference.model.provider||runtime.session.model.id!==inference.model.id||runtime.session.thinkingLevel!==inference.thinkingLevel||runtime.session.getActiveToolNames().includes("codemode")!==(assignment.arm==="codemode"))throw Object.assign(new Error("Inference drift"),{code:"INFERENCE_DRIFT"});
    unwatch=tap.watch(phases.raw);
    let timedOut=false,promptFailed=false;
    const timer=setTimeout(()=>{timedOut=true;void runtime.session.abort();},Math.min(BUDGETS.caseMs,remainingMs()));
    phases.start();
    try { await runtime.session.prompt(prepared.prompt); } catch { promptFailed=true; }
    finally { phases.finish();clearTimeout(timer);unwatch();unwatch=null; }
    const postAt=performance.now(),messages=runtime.session.messages.filter(m=>m.role==="assistant");
    const answer=(messages.at(-1)?.content||[]).filter(c=>c.type==="text").map(c=>c.text).join("");
    const ended=runtime.events.filter(e=>e.type==="tool_execution_end"),starts=runtime.events.filter(e=>e.type==="tool_execution_start");
    const costs=messages.map(m=>m.usage?.cost?.total);
    row={...assignment,fixtureDigest:prepared.fixtureDigest,oracle:checkAnswer(answer,prepared,observedFiles(runtime.events,cwd)),
      integrity:Object.entries(prepared.files).every(([f,bytes])=>fs.readFileSync(path.join(cwd,f),"utf8")===bytes)&&intact(),
      providerError:promptFailed||timedOut||messages.some(m=>["error","aborted"].includes(m.stopReason)),timedOut,
      toolFailures:ended.filter(e=>e.isError).length,modelTurns:messages.length,underlyingToolAttempts:starts.filter(e=>e.toolName!=="codemode").length,
      generatedCodeChars:messages.reduce((sum,m)=>sum+(m.content||[]).filter(c=>c.type==="toolCall"&&c.name==="codemode").reduce((n,c)=>n+String(c.arguments?.code||"").length,0),0),
      tokens:tokenUsage(messages),phases:phases.snapshot(),rawObserver:tap.stats(),setupMs,
      reportedCost:costs.length&&costs.every(Number.isFinite)?costs.reduce((a,b)=>a+b,0):null};
    row.postprocessMs=performance.now()-postAt;
    keepSpills(runtime.events,row,run,retainedBytes);
  } finally {
    if(unwatch)unwatch();
    unsubscribe();const start=performance.now();await runtime.close();if(row)row.cleanupMs=performance.now()-start;
  }
  return row;
}
async function main() {
  const options=optionsFor(process.argv.slice(2));
  const {sdk,root:sdkRoot}=await installedRuntime();
  const modules=[path.resolve(sdkRoot,"../ai/dist/api/openai-codex-responses.js"),path.resolve(sdkRoot,"../ai/dist/api/openai-responses-shared.js")];
  const {getOpenAICodexWebSocketDebugStats:getStats}=await import(pathToFileURL(modules[0]).href);
  const previous=JSON.parse(fs.readFileSync(path.join(root,FROZEN,"protocol.json")));
  if(fileDigest(filesUnder(path.join(root,FROZEN)))!==FROZEN_HASH||fileDigest(modules)!==previous.before.provider||digest(fs.readFileSync(require.resolve(sdkRoot)))!==previous.before.pi)throw new Error("Frozen cohort/provider/Pi lineage changed");
  if(!/^PI_CODEMODE=1$/m.test(fs.readFileSync(path.join(root,"config/harness-defaults.env"),"utf8")))throw new Error("Default-on must remain unchanged");
  const agentDir=process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),".pi/agent");
  const historyRoot=execFileSync("git",["rev-parse","--path-format=absolute","--git-common-dir"],{cwd:root,encoding:"utf8"}).trim().replace(/[\/]\.git$/,"");
  if([...ledger.listExperiments(root,{status:"open"}),...ledger.listExperiments(historyRoot,{status:"open"})].some(e=>/codemode.*(continuation|decision|phase.*timing)/i.test(e.title)))throw new Error("Inspect open CodeMode experiment");
  const parent=path.join(root,".pi/codemode-continuation-benchmark");
  if(fs.existsSync(parent)&&fs.readdirSync(parent).some(n=>n.startsWith("live-")))throw new Error("Continuation cohort exists; never repeat assigned cases");
  if(fs.statfsSync(root).bavail*fs.statfsSync(root).bsize<256*1024*1024||retainedBytes()>=BUDGETS.evidenceBytes)throw new Error("Insufficient artifact headroom");
  const historicalFiles=[...ownedPaths().flatMap(f=>fs.statSync(f).isDirectory()?filesUnder(f):[f]),...["experiment-ledger","debug-ledger"].flatMap(n=>filesUnder(path.join(root,".pi",n)))].sort();
  const before={source:sourceDigest(),history:fileDigest(historicalFiles),protected:protectedDigest(agentDir,historyRoot),provider:fileDigest(modules),pi:digest(fs.readFileSync(require.resolve(sdkRoot))),environment:environmentDigest()};
  const plan=continuationSchedule(),run=path.join(parent,`live-${Date.now()}`);
  fs.mkdirSync(run,{recursive:true,mode:0o700});
  const protocol={version:1,kind:"matched-chain-continuation-ablation",createdAt:new Date().toISOString(),authorization:"User requested targeted matched-control runs with raw provider timing; no production/default/global/installed-SDK changes or historical retries",provider:options.provider,model:options.model,thinking:options.thinking,piVersion:sdk.VERSION,before,frozenCohortHash:FROZEN_HASH,historicalFiles:historicalFiles.map(f=>path.relative(root,f)),task:MANIFEST[20],seed:SEED,plan,budgets:BUDGETS,
    design:"16 serial randomized triplets; direct cachedWS,hybrid cachedWS,hybrid full-context WS. Same natural task21/profile/fixtures.8:8 cached/full precedence, each cell position5 or6 times. Prefix-cache retention policy unchanged; no forced scripts or connection resets.",
    primary:{endpoint:`Any post-first model turn with parsed response.in_progress→first output_item.added gap>${STALL_MS}ms`,contrast:"hybrid cached vs hybrid full, one-sided exact paired McNemar/sign test",alpha:.05,positive:"cached stalls and full does not",power:"Illustrative82.57% for stall risk.50→.05 and independent conditional responses; only2/4 prior cached cases stalled, so rate assumption is uncertain. Not p95 noninferiority power."},
    rawTiming:"Owned-process transparent WebSocket subclass marks send entry and raw message listener entry before SDK decode/queue/hooks, plus parsed-event hook timestamps. The tap inspects transient JSON only to retain fixed tag/item-kind/sequence/byte-count metadata. It does not alter binaryType, constructor arguments or payloads. Listener arrival is NOT kernel packet receipt; socket.send entry is NOT wire egress. Observer overhead recorded; ordered tag/kind/sequence correlation checked, including native retries and terminal trailing frames.",
    privacy:"No raw payloads, scripts, prompts, private reasoning, headers, URLs, response IDs or error text retained. Unknown tags/kinds map to fixed labels. Successful newly owned fixtures/spills disposable; failures and all historical evidence preserved. Metadata overflow/correlation failure stops at current case; no retry/sample extension.",
    interpretation:"Mode assignment is randomized; token-cache hits, extra turns/reads/outputs and native recovery remain mediators, never filtered away. Raw interarrival delays combine remote model/server/network and JS-delivery scheduling; raw→parsed includes tap/decode/queue/hooks. No server queue/compute timestamps available. A positive mechanism contrast cannot lift original full-profile HOLD; its acceptance gate remains unrun/blocked.",
    loadControl:"Serial benchmark traffic only; other account/backend traffic unknown. No unrelated jobs stopped."};
  save(path.join(run,"protocol.json"),protocol);
  const experiment=ledger.openExperiment(root,"CodeMode continuation raw timing 2026-10-24",{hypothesis:"Cached WebSocket continuation contributes to the chain21 post-ack/pre-output stalls under hybrid CodeMode; raw arrival vs parsed delivery can distinguish measured local delays from upstream interarrival",arms:["direct cachedWS","hybrid cachedWS","hybrid full-context WS"],bars:[`Protocol SHA256 ${digest(protocol)}`,JSON.stringify(protocol.primary),JSON.stringify(BUDGETS),"Exactly48 fresh sessions; preserve all assignments/outcomes; no benchmark retry or post-hoc extension. Original acceptance gates unchanged."]});
  const intact=()=>sourceDigest()===before.source&&fileDigest(historicalFiles)===before.history&&protectedDigest(agentDir,historyRoot)===before.protected&&fileDigest(modules)===before.provider&&digest(fs.readFileSync(require.resolve(sdkRoot)))===before.pi&&environmentDigest()===before.environment;
  const rows=[],attempts=[];let blocked=null;
  const tap=installRawWebSocketTap(),started=performance.now();
  console.log(JSON.stringify({run:path.relative(root,run),experimentId:experiment.experimentId,cases:plan.length,budgets:BUDGETS}));
  try {
    const inference=await liveInference(sdk,{provider:options.provider,modelId:options.model,thinkingLevel:options.thinking,agentDir,run});
    if(inference.model.api!=="openai-codex-responses")throw Object.assign(new Error("Inference drift"),{code:"INFERENCE_DRIFT"});
    for(const entry of plan) {
      if(performance.now()-started>=BUDGETS.elapsedMs||rows.reduce((n,r)=>n+(r.reportedCost||0),0)>=BUDGETS.reportedCost)throw Object.assign(new Error("Budget reached"),{code:"RUN_BUDGET"});
      if(retainedBytes()>=BUDGETS.evidenceBytes||(fs.existsSync(path.join(run,"fixtures"))&&treeBytes(path.join(run,"fixtures"))>=BUDGETS.fixtureBytes))throw Object.assign(new Error("Storage reached"),{code:"STORAGE_BOUND"});
      if(!intact())throw Object.assign(new Error("Integrity drift"),{code:"INTEGRITY_DRIFT"});
      const cwd=path.join(run,"fixtures",`b${entry.block}`),prepared=prepareTaskOnce(MANIFEST[20],cwd);
      const assignment={...entry,assignedUtc:new Date().toISOString()};
      save(path.join(run,`${entry.key}.assigned.json`),assignment);attempts.push(assignment);
      const row=await measureCase({assignment,cwd,prepared,inference,getStats,tap,run,intact,remainingMs:()=>BUDGETS.elapsedMs-(performance.now()-started)});
      rows.push(row);save(path.join(run,`${entry.key}.json`),row);
      console.log(`continuation ${entry.key} ${row.oracle.ok?"oracle-pass":"oracle-fail"} prompt=${row.phases.promptMs} code=${row.phases.codemodeWallMs} rawAligned=${row.phases.turns.every(t=>t.rawParsedAligned)} observerMax=${row.rawObserver.maxMs}`);
      if(!row.integrity||row.providerError)throw Object.assign(new Error("Observation boundary"),{code:!row.integrity?"INTEGRITY_DRIFT":row.timedOut?"CASE_TIMEOUT":"PROVIDER_ERROR"});
      if(!Number.isFinite(row.reportedCost)||row.reportedCost<0)throw Object.assign(new Error("Reported cost unavailable"),{code:"COST_UNAVAILABLE"});
      if(row.phases.rawCapture.overflow||!row.phases.timingComplete||!row.phases.providerTimingComplete||!row.tokens.totalMatchesSdk||!row.phases.turns.every(t=>t.rawParsedAligned&&Number.isFinite(t.rawAckToItemMs)&&t.usage.totalMatchesSdk))throw Object.assign(new Error("Required raw metadata incomplete"),{code:"MEASUREMENT_INCOMPLETE"});
      const triplet=rows.filter(r=>r.block===entry.block);
      if(triplet.length===3&&triplet.every(r=>r.oracle.ok&&r.integrity&&!r.providerError&&!r.toolFailures))fs.rmSync(cwd,{recursive:true});
    }
  }catch(error){blocked=/^[A-Z_]+$/.test(String(error.code||""))?error.code:"RUNTIME_FAILURE";}
  finally{tap.restore();}
  const summary={...summarizeContinuation(rows,plan),experimentId:experiment.experimentId,blocked,integrityComplete:intact(),elapsedMs:performance.now()-started,attempted:attempts.length,measured:rows.length,unmeasured:attempts.filter(a=>!rows.some(r=>r.key===a.key)),unrun:plan.filter(a=>!attempts.some(x=>x.key===a.key)).map(a=>a.key)};
  summary.primary.evidenceForContinuationReduction&&=summary.integrityComplete&&!blocked;
  save(path.join(run,"summary.json"),summary);
  ledger.recordGate(root,experiment.experimentId,{gate:"quality-and-raw-measurement",verdict:summary.quality&&summary.measurement&&summary.integrityComplete?"pass":blocked?"partial":"fail",gpuHours:0,metrics:JSON.stringify({measured:rows.length,unrun:summary.unrun.length,blocked}),note:"Raw frame/parsed timing metadata; no private contents"});
  ledger.recordGate(root,experiment.experimentId,{gate:"continuation-contrast",verdict:summary.primary.p===null?"null-result":summary.primary.evidenceForContinuationReduction?"pass":"null-result",gpuHours:0,metrics:JSON.stringify(summary.primary),note:"Not a release-profile latency gate; absence of significance is not equivalence"});
  ledger.closeExperiment(root,experiment.experimentId,{decision:"no-go",note:"HOLD remains pending full-profile acceptance; targeted mechanism contrast only. "+(blocked||"All observed cases retained")});
  console.log(JSON.stringify({run:path.relative(root,run),...summary},null,2));
  if(blocked||!summary.quality||!summary.measurement||!summary.manipulation||!summary.integrityComplete)process.exitCode=1;
}
module.exports={BUDGETS,measureCase};
if(require.main===module)main().catch(error=>{console.error(`Continuation benchmark could not start: ${error.code||error.name}`);process.exitCode=1;});
