#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { MANIFEST, digest, prepareTask, observedFiles, checkAnswer, benchmarkOptions } = require("../src/codemode-benchmark");
const { tokenUsage } = require("../src/codemode-phase-benchmark");
const { schedule, createDecisionMeasurements, assessPower, compare, acceptanceGates } = require("../src/codemode-decision-benchmark");
const { filesUnder, fileDigest } = require("./benchmark-codemode-phases");
const { sourceDigest, protectedDigest, save, treeBytes, liveInference } = require("./benchmark-codemode");
const { installedRuntime, createRuntime } = require("../tests/helpers/codemode-runtime");
const ledger = require("../src/experiment-ledger");
const root = path.resolve(__dirname, "..");
const FROZEN = ".pi/codemode-phase-benchmark/live-1792848822532";
const RAW_HASH = "1775c8ebe8d4ecd43d9d1d00173b58829b9481e9cd3ba4d9739dd71b69277823";
const HISTORY_HASH = "47efddf913bdbfb915ef3f2df2571aa4fd6505f2c523dd4996abe52741e15c7b";
const BUDGETS = { evidenceBytes: 64 * 1024 * 1024, fixtureBytes: 128 * 1024 * 1024, caseMs: 120000, diagnostic: { elapsedMs: 25 * 60000, cost: 2 }, acceptance: { elapsedMs: 90 * 60000, cost: 6 } };
const ENV_KEYS = ["PI_CODEMODE", "PI_TOOL_SURFACE_ROUTER", "PI_OUTPUT_COMPACTOR", "PI_OUTPUT_COMPACTOR_MODE", "PI_OUTPUT_COMPACTOR_MAX_CHARS", "PI_POLICY_ENFORCER", "PI_POLICY_ENFORCER_MODE", "PI_EXTENSION_TELEMETRY", "PI_DOCS_ALLOW_OUTSIDE"];
function optionsFor(argv, env = process.env) {
  const opts = benchmarkOptions(argv, env);
  if (opts.mode !== "live" || opts["resume-unstarted"] || env.PI_CODEMODE === "0") throw new Error("New live cohort only; no replay/resume or default-off");
  if (opts.provider !== "openai-codex" || opts.model !== "gpt-6.1-sol" || opts.thinking !== "xhigh") throw new Error("Use the frozen provider/model/xhigh identity");
  return opts;
}
function keepSpills(events, row, run, retainedBytes) {
  row.spills = [];
  for (const spill of new Set(events.filter(e => e.type === "tool_execution_end" && e.toolName === "codemode").map(e => e.result?.details?.fullOutputPath).filter(Boolean))) {
    if (path.dirname(spill) !== os.tmpdir() || !/^pi-codemode-[a-f0-9]{16}\.txt$/.test(path.basename(spill)) || !fs.lstatSync(spill).isFile() || fs.lstatSync(spill).isSymbolicLink() || (fs.statSync(spill).mode & 0o077)) throw Object.assign(new Error("Unexpected spill"), { code: "SPILL_IDENTITY" });
    const bytes = fs.statSync(spill).size, keep = !row.oracle.ok || !row.integrity || row.providerError || row.toolFailures > 0;
    row.spills.push({ bytes, digest: digest(fs.readFileSync(spill)), retained: keep });
    if (keep) {
      if (retainedBytes() + bytes > BUDGETS.evidenceBytes) throw Object.assign(new Error("Original spill preserved"), { code: "STORAGE_BOUND" });
      const target = path.join(run, `${row.key}-spill-${row.spills.length}.txt`);
      fs.copyFileSync(spill, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
    }
    fs.unlinkSync(spill);
  }
}
async function main() {
  const options = optionsFor(process.argv.slice(2));
  const { sdk, root: sdkRoot } = await installedRuntime();
  const providerFile = path.resolve(sdkRoot, "../ai/dist/api/openai-codex-responses.js");
  const sharedFile = path.resolve(sdkRoot, "../ai/dist/api/openai-responses-shared.js");
  const { getOpenAICodexWebSocketDebugStats: getStats } = await import(pathToFileURL(providerFile).href);
  if (typeof getStats !== "function") throw new Error("Required SDK numeric transport observer unavailable");
  const historicalProtocol = JSON.parse(fs.readFileSync(path.join(root, FROZEN, "protocol.json")));
  if (fileDigest(filesUnder(path.join(root, FROZEN))) !== RAW_HASH || fileDigest(historicalProtocol.historicalFiles.map(f => path.join(root, f))) !== HISTORY_HASH) throw new Error("Frozen lineage mismatch");
  if (!/^PI_CODEMODE=1$/m.test(fs.readFileSync(path.join(root, "config/harness-defaults.env"), "utf8"))) throw new Error("Default-on must remain unchanged");
  const historical = fs.readdirSync(path.join(root, FROZEN)).filter(n => /^r[01]-codemode-\d+-(direct|codemode)\.json$/.test(n)).map(n => JSON.parse(fs.readFileSync(path.join(root, FROZEN, n))));
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent");
  const historyRoot = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim().replace(/[\/]\.git$/, "");
  if ([...ledger.listExperiments(root,{status:"open"}), ...ledger.listExperiments(historyRoot,{status:"open"})].some(e => /codemode.*(decision|phase.*timing)/i.test(e.title))) throw new Error("Inspect existing open CodeMode experiment");
  const parent = path.join(root, ".pi/codemode-decision-benchmark");
  if (fs.existsSync(parent) && fs.readdirSync(parent).some(n => n.startsWith("live-"))) throw new Error("Decision cohort exists; never replay assigned cases");
  const historicalRoots = ["codemode-benchmark", "codemode-phase-benchmark", "codemode-phase-verification", "codemode-release-review", "experiment-ledger", "debug-ledger"].map(n => path.join(root,".pi",n));
  const historicalFiles = historicalRoots.flatMap(filesUnder);
  const before = { source: sourceDigest(), history: fileDigest(historicalFiles), protected: protectedDigest(agentDir,historyRoot), pi: digest(fs.readFileSync(require.resolve(sdkRoot))), provider: fileDigest([providerFile,sharedFile]), environment: digest(Object.fromEntries(ENV_KEYS.map(k => [k,process.env[k] ?? null]))) };
  if (before.pi !== historicalProtocol.piEntryDigest) throw new Error("Installed Pi identity changed from frozen cohort");
  const retainedBytes = () => fs.readdirSync(path.join(root, ".pi")).filter(name => name.startsWith("codemode")).reduce((bytes, name) => {
    const file = path.join(root, ".pi", name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("Unexpected owned evidence symlink");
    return bytes + (stat.isDirectory() ? treeBytes(file) : stat.size);
  }, 0);
  if (fs.statfsSync(root).bavail * fs.statfsSync(root).bsize < 256*1024*1024 || retainedBytes() >= BUDGETS.evidenceBytes) throw new Error("Insufficient retained evidence headroom");
  // Offline preflight only. Freeze the result and method before new observations.
  const power = assessPower(historical);
  const plans = { diagnostic: schedule("diagnostic"), acceptance: schedule("acceptance") };
  const run = path.join(parent,`live-${Date.now()}`);
  fs.mkdirSync(run,{recursive:true,mode:0o700});
  const protocol = { version:1,kind:"decision-producing-rerun",createdAt:new Date().toISOString(),providerLoadControl:"Serial owned benchmark only; no other managed benchmark is active. Other account/backend traffic is unknown and no unrelated process is stopped.",inferenceApi:"openai-codex-responses",authorization:"User requested the findings' diagnostic and power-qualified acceptance rerun; no historical retries, default changes, global writes or model tuning",provider:options.provider,model:options.model,thinking:options.thinking,piVersion:sdk.VERSION,before,historicalFiles:historicalFiles.map(f=>path.relative(root,f)),originalRawHash:RAW_HASH,originalHistoryHash:HISTORY_HASH,manifestDigest:digest(MANIFEST),settings:{compaction:{enabled:false},retry:{enabled:false},codemode:{mode:"on"}},tools:["read","docs_lookup","code_context","codemode"],plans,budgets:BUDGETS,power,powerRule:"Acceptance N180 pairs requires planning power>=.80 under the preregistered exchangeable-arm null; never increase N or change gates from new results. An inadequate planning result leaves acceptance unrun, not passed.",decisionRules:{diagnostic:"Selected anchors and fixed short no-tool probes are descriptive, not profile p95 acceptance evidence. No reproduction is unknown, not exoneration.",acceptance:"All quality/evidence/authority/integrity and numeric usage/timing gates; both90-pair trials and pooled prompt p95 ratio<=1.10; pooled composed estimated context<=.75; reported cost<=1.10; fixed task-cluster stratified percentile bootstrap one-sided95% upper p95 ratio<=1.10,5000 resamples. No arbitrary-time or population noninferiority claim.",causality:"Request-to-first delta and parsed-event gaps include server, transport, unstreamed generation/planning and client processing. Never label them pure server queue time. SDK numeric counters are observations of WS attempts, reuse, continuation and fallback, not proof of causal blame.",stop:"No retries or sample extensions. Stop at provider/runtime timeout, any integrity drift, storage/time/cost bound; preserve assignments, outcomes and failures."},privacy:"Persist fixed categories/counts/timestamps/usage/CPU/lag/numeric transport stats and hashes only. No prompts, response text, arguments, scripts, reasoning, raw headers, response IDs or error strings. Shared64MiB evidence/128MiB fixture caps; successful newly owned fixtures/spills only may be removed."};
  save(path.join(run,"protocol.json"),protocol);
  const experiment = ledger.openExperiment(root,"CodeMode decision rerun 2026-10-24",{hypothesis:"Long pre-delta stalls can be distinguished from CodeMode runtime and extra model turns with metadata-only event, usage, lag and transport observations; comparison must retain all treatment-mediated time",arms:["direct read-oriented control","same loadout plus hybrid CodeMode","fixed no-tool boundary probes, diagnostic only"],bars:[`Protocol SHA256 ${digest(protocol)}`,JSON.stringify(protocol.decisionRules),JSON.stringify(BUDGETS),"Diagnostic48 sessions+8 probes; acceptance360 sessions only after frozen power gate. No retries, source/global/default edits during measurement; preserve all historical artifacts."]});
  const intact = () => sourceDigest() === before.source && fileDigest(historicalFiles) === before.history && protectedDigest(agentDir,historyRoot) === before.protected && digest(fs.readFileSync(require.resolve(sdkRoot))) === before.pi && fileDigest([providerFile,sharedFile]) === before.provider && digest(Object.fromEntries(ENV_KEYS.map(k=>[k,process.env[k]??null]))) === before.environment;
  const rows=[],assignments=[];let blocked=null;
  const stageSummaries={};
  console.log(JSON.stringify({run:path.relative(root,run),experimentId:experiment.experimentId,power:power.power,powerAdequate:power.adequate,diagnosticSessions:56,acceptanceSessions:power.adequate?360:0}));
  try {
    const inference = await liveInference(sdk,{provider:options.provider,modelId:options.model,thinkingLevel:options.thinking,agentDir,run});
    if (inference.model.api !== protocol.inferenceApi) throw Object.assign(new Error("Inference API drift"), { code: "INFERENCE_DRIFT" });
    for (const stage of ["diagnostic","acceptance"]) {
      if (stage === "acceptance" && !power.adequate) { stageSummaries.acceptance={status:"not-run",reason:"INADEQUATE_PLANNING_POWER",plannedCases:360,power};break; }
      const stageStarted=performance.now();
      for (const assignment of plans[stage]) {
        const prior=rows.filter(r=>r.stage===stage),elapsed=performance.now()-stageStarted;
        if (elapsed >= BUDGETS[stage].elapsedMs || prior.reduce((n,r)=>n+(r.reportedCost||0),0)>=BUDGETS[stage].cost) throw Object.assign(new Error("Stage budget reached"),{code:"RUN_BUDGET"});
        if (retainedBytes()>=BUDGETS.evidenceBytes || (fs.existsSync(path.join(run,"fixtures")) && treeBytes(path.join(run,"fixtures"))>=BUDGETS.fixtureBytes)) throw Object.assign(new Error("Storage limit"),{code:"STORAGE_BOUND"});
        if (!intact()) throw Object.assign(new Error("Integrity drift"),{code:"INTEGRITY_DRIFT"});
        const cwd=path.join(run,"fixtures",stage,`b${assignment.block}`,assignment.id);
        const task=MANIFEST.find(t=>t.id===assignment.id);
        const prepared=assignment.probe?null:prepareTaskOnce(task,cwd);
        if (!prepared) fs.mkdirSync(cwd,{recursive:true,mode:0o700});
        let runtime;
        const phases=createDecisionMeasurements({stats:()=>runtime?getStats(runtime.session.sessionId):undefined});
        const setupAt=performance.now();
        runtime=await createRuntime({cwd,inference,settings:protocol.settings,tools:protocol.tools,excludeTools:assignment.arm==="direct"?["codemode"]:[],noTools:assignment.probe,extensionFactories:[pi=>{phases.install(pi);pi.on("tool_call",event=>{
          if (assignment.probe) return {block:true,reason:"Fixed boundary probes must not call tools"};
          if (event.toolName==="read") {const file=path.relative(cwd,path.resolve(cwd,String(event.input.path||"").replace(/^@/,"")));if(!Object.hasOwn(prepared.files,file))return{block:true,reason:"Reads confined to frozen synthetic fixture"};}
        });}]});
        const setupMs=performance.now()-setupAt,unsubscribe=runtime.session.subscribe(phases.observe);let row;
        try {
          if(runtime.session.model.provider!==options.provider||runtime.session.model.id!==options.model||runtime.session.thinkingLevel!==options.thinking||(!assignment.probe&&runtime.session.getActiveToolNames().includes("codemode")!==(assignment.arm==="codemode")))throw Object.assign(new Error("Inference drift"),{code:"INFERENCE_DRIFT"});
          const assigned={...assignment,globalOrdinal:assignments.length,assignedUtc:new Date().toISOString()};
          save(path.join(run,`${assignment.key}.assigned.json`),assigned);assignments.push(assigned);
          let timedOut=false,promptFailed=false;
          const timer=setTimeout(()=>{timedOut=true;void runtime.session.abort();},Math.min(BUDGETS.caseMs,BUDGETS[stage].elapsedMs-(performance.now()-stageStarted)));
          phases.start();
          try{await runtime.session.prompt(assignment.probe?'Reply with exactly JSON {"ok":true}. Do not use tools or include commentary.':prepared.prompt);}catch{promptFailed=true;}finally{phases.finish();clearTimeout(timer);}
          const postAt=performance.now(),messages=runtime.session.messages.filter(m=>m.role==="assistant"),answer=(messages.at(-1)?.content||[]).filter(c=>c.type==="text").map(c=>c.text).join("");
          const ended=runtime.events.filter(e=>e.type==="tool_execution_end"),starts=runtime.events.filter(e=>e.type==="tool_execution_start"),costs=messages.map(m=>m.usage?.cost?.total);
          let probeOk=false;try{probeOk=JSON.stringify(JSON.parse(answer))==='{"ok":true}';}catch{}
          row={...assignment,assignedUtc:assigned.assignedUtc,kind:task?.kind||"probe",fixtureDigest:prepared?.fixtureDigest??null,oracle:assignment.probe?{ok:probeOk&&starts.length===0,reason:"fixed-short-no-tool-probe"}:checkAnswer(answer,prepared,observedFiles(runtime.events,cwd)),integrity:(!prepared||Object.entries(prepared.files).every(([f,bytes])=>fs.readFileSync(path.join(cwd,f),"utf8")===bytes))&&intact(),providerError:promptFailed||timedOut||messages.some(m=>["error","aborted"].includes(m.stopReason)),timedOut,toolFailures:ended.filter(e=>e.isError).length,modelTurns:messages.length,underlyingToolAttempts:starts.filter(e=>e.toolName!=="codemode").length,generatedCodeChars:messages.reduce((sum,m)=>sum+(m.content||[]).filter(c=>c.type==="toolCall"&&c.name==="codemode").reduce((n,c)=>n+String(c.arguments?.code||"").length,0),0),tokens:tokenUsage(messages),phases:phases.snapshot(),setupMs,reportedCost:costs.length&&costs.every(Number.isFinite)?costs.reduce((a,b)=>a+b,0):null};
          row.postprocessMs=performance.now()-postAt;keepSpills(runtime.events,row,run,retainedBytes);
        } finally {unsubscribe();const cleanupAt=performance.now();await runtime.close();if(row)row.cleanupMs=performance.now()-cleanupAt;}
        rows.push(row);save(path.join(run,`${assignment.key}.json`),row);
        console.log(`decision ${assignment.key} ${row.oracle.ok?"oracle-pass":"oracle-fail"} prompt=${row.phases.promptMs} model=${row.phases.modelPipelineMs} tools=${row.phases.topToolWallMs} tokens=${row.tokens.total}`);
        if (!row.integrity || row.providerError) throw Object.assign(new Error("Observation boundary"), { code: !row.integrity ? "INTEGRITY_DRIFT" : row.timedOut ? "CASE_TIMEOUT" : "PROVIDER_ERROR" });
        if (!row.phases.timingComplete || !row.phases.providerTimingComplete || !row.tokens.totalMatchesSdk || !row.phases.turns.every(t => t.usage?.totalMatchesSdk && t.categories.completed)) throw Object.assign(new Error("Required metadata missing"), { code: "MEASUREMENT_INCOMPLETE" });
        const pair=rows.filter(r=>r.stage===stage&&r.block===assignment.block&&r.id===assignment.id);
        if((assignment.probe||pair.length===2)&&pair.every(r=>r.oracle.ok&&r.integrity&&!r.providerError&&!r.toolFailures))fs.rmSync(cwd,{recursive:true});
      }
      const selected=rows.filter(r=>r.stage===stage);
      stageSummaries[stage]={status:"finished",elapsedMs:performance.now()-stageStarted,comparison:compare(selected),...(stage==="acceptance"?{gates:acceptanceGates(selected,plans.acceptance)}:{diagnosticOnly:true})};
    }
  }catch(error){blocked=/^[A-Z_]+$/.test(String(error.code||""))?error.code:"RUNTIME_FAILURE";}
  const integrityComplete=intact(),keys=new Set(rows.map(r=>r.key));
  const summary={experimentId:experiment.experimentId,blocked,integrityComplete,power,stages:stageSummaries,attempted:assignments.length,measured:rows.length,unmeasured:assignments.filter(a=>!keys.has(a.key)),diagnosticComplete:plans.diagnostic.every(a=>keys.has(a.key)),acceptanceComplete:plans.acceptance.every(a=>keys.has(a.key)),quality:rows.length>0&&rows.every(r=>r.oracle.ok&&r.integrity&&!r.providerError&&!r.toolFailures),measurement:rows.length>0&&rows.every(r=>r.tokens.totalMatchesSdk&&r.phases.timingComplete&&r.phases.providerTimingComplete&&r.phases.turns.every(t=>t.usage?.totalMatchesSdk&&t.categories.completed)),reportedCost:rows.every(r=>Number.isFinite(r.reportedCost))?rows.reduce((n,r)=>n+r.reportedCost,0):null,supportsLiftingHold:!blocked&&integrityComplete&&stageSummaries.acceptance?.gates?.supportsLiftingHold===true};
  summary.supportsLiftingHold &&= summary.diagnosticComplete && summary.quality && summary.measurement && summary.unmeasured.length === 0;
  save(path.join(run,"summary.json"),summary);
  ledger.recordGate(root,experiment.experimentId,{gate:"planning-power",verdict:power.adequate?"pass":"null-result",gpuHours:0,metrics:JSON.stringify(power),note:"Frozen-data planning simulation, not live acceptance evidence"});
  ledger.recordGate(root,experiment.experimentId,{gate:"diagnostic",verdict:summary.diagnosticComplete&&summary.quality&&summary.measurement&&integrityComplete?"pass":blocked?"partial":"fail",gpuHours:0,metrics:JSON.stringify({attempted:summary.attempted,measured:summary.measured,cost:summary.reportedCost}),note:"Metadata and direct controls only; selected anchors cannot establish profile noninferiority"});
  ledger.recordGate(root,experiment.experimentId,{gate:"acceptance",verdict:!summary.acceptanceComplete?"null-result":summary.supportsLiftingHold?"pass":"fail",gpuHours:0,note:stageSummaries.acceptance?.reason||"All original gates plus uncertainty bound; unknown is not a pass"});
  ledger.closeExperiment(root,experiment.experimentId,{decision:summary.supportsLiftingHold?"ship":"no-go",note:summary.supportsLiftingHold?"Bounded benchmark evidence supports lifting HOLD; no automatic default or merge action":"HOLD remains: "+(blocked||stageSummaries.acceptance?.reason||"acceptance gate not passed")});
  console.log(JSON.stringify({run:path.relative(root,run),...summary},null,2));
  if(blocked||!summary.quality||!summary.measurement||!integrityComplete)process.exitCode=1;
}
// Both arms share byte-identical fixtures; the second arm must never overwrite them.
function prepareTaskOnce(task,cwd) {
  if(!fs.existsSync(cwd))return prepareTask(task,cwd);
  // Reconstruct the known bytes in an isolated owned temporary directory, not the measured fixture.
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"pi-codemode-fixture-oracle-"));
  try{return prepareTask(task,scratch);}finally{fs.rmSync(scratch,{recursive:true});}
}
module.exports={optionsFor,BUDGETS,prepareTaskOnce,keepSpills};
if(require.main===module)main().catch(error=>{console.error(`Decision benchmark could not start: ${error.code||error.name}`);process.exitCode=1;});
