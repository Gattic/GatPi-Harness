#!/usr/bin/env node
"use strict";

// Purely offline. No SDK import, credentials, inference sessions or live-launch mode.
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {referenceFor,interleavedReference,simulateDesign,project}=require("../src/codemode-acceptance-planning");
const {assessPower,pairRows,upperBound}=require("../src/codemode-decision-benchmark");
const {historicalProfile}=require("./audit-codemode-acceptance");
const {filesUnder,fileDigest}=require("./benchmark-codemode-phases");
const {sourceDigest,protectedDigest,save,treeBytes}=require("./benchmark-codemode");
const {digest}=require("../src/codemode-benchmark");
const {execFileSync}=require("node:child_process");
const ledger=require("../src/experiment-ledger");
const root=path.resolve(__dirname,".."),parent=path.join(root,".pi/codemode-acceptance-design");
const phase=".pi/codemode-phase-benchmark/live-1792848822532";
const cohorts={
  [phase]:"1775c8ebe8d4ecd43d9d1d00173b58829b9481e9cd3ba4d9739dd71b69277823",
  ".pi/codemode-decision-benchmark/live-1792855279662":"c80215bc630b20c9ac9e8aac61160ae8a8b0df1a29843b69e7b8bc7e5d3df24e",
  ".pi/codemode-continuation-benchmark/live-1792860305312":"f3f61f10af6adabb02b4be08418292367013fd62efae8199e3caf48801860545",
};
function retainedBytes(){return fs.readdirSync(path.join(root,".pi")).filter(n=>n.startsWith("codemode")).reduce((n,f)=>{const x=path.join(root,".pi",f),s=fs.lstatSync(x);if(s.isSymbolicLink())throw new Error("Evidence symlink");return n+(s.isDirectory()?treeBytes(x):s.size);},0);}
function grid(){
  const result=[];
  for(const source of ["trial-stratified","interleaved-class-mixture"]){
    for(const blocks of [1,2,3,4,6,8,12,16,24,32,48,64,96])result.push({source,family:"repeat",clusters:10,blocks});
    for(const clusters of [20,30,40,60,80,120,160,240,320,480,640,960])result.push({source,family:"variants",clusters,blocks:1});
    result.push({source,family:"mixed",clusters:20,blocks:2});
  }
  return result.map(d=>({...d,id:`${d.source}-${d.clusters}c-${d.blocks}b`}));
}
async function main(){
  if(process.argv.length!==2)throw new Error("Offline planning takes no live/override arguments");
  globalThis.fetch=()=>{throw new Error("Networking forbidden by offline planning contract");};
  globalThis.WebSocket=class {constructor(){throw new Error("WebSocket forbidden by offline planning contract");}};
  if(fs.existsSync(parent)&&fs.readdirSync(parent).some(n=>n.startsWith("plan-")))throw new Error("Existing plan retained; never repeat settled design search");
  const historicalFiles=Object.keys(cohorts).flatMap(d=>filesUnder(path.join(root,d)));
  for(const [directory,hash]of Object.entries(cohorts))if(fileDigest(filesUnder(path.join(root,directory)))!==hash)throw new Error("Frozen cohort changed");
  if(ledger.listExperiments(root,{status:"open"}).some(e=>/codemode.*(decision|design|planning)/i.test(e.title)))throw new Error("Inspect open CodeMode experiment");
  const rows=fs.readdirSync(path.join(root,phase)).filter(n=>/^r[01]-codemode-\d+-(direct|codemode)\.json$/.test(n)).sort().map(n=>JSON.parse(fs.readFileSync(path.join(root,phase,n))));
  historicalProfile(rows);
  const references={"trial-stratified":referenceFor(rows)};references["interleaved-class-mixture"]=interleavedReference(references["trial-stratified"]);
  const historyRoot=execFileSync("git",["rev-parse","--path-format=absolute","--git-common-dir"],{cwd:root,encoding:"utf8"}).trim().replace(/[\/]\.git$/,"");
  const agentDir=process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),".pi/agent");
  const before={source:sourceDigest(),historical:fileDigest(historicalFiles),protected:protectedDigest(agentDir,historyRoot)};
  if(retainedBytes()+2*1024*1024>64*1024*1024)throw new Error("Insufficient shared evidence headroom");
  const candidates=grid(),run=path.join(parent,`plan-${Date.now()}`);fs.mkdirSync(run,{recursive:true,mode:0o700});
  const protocol={version:1,kind:"offline-acceptance-size-design-planning",createdAt:new Date().toISOString(),before,cohorts,candidates,
    releaseBars:{trials:2,equalClasses:["simple","batch","chain"],pointP95Ratios:1.1,pooledOneSided95Upper:1.1,composedContext:.75,costRatio:1.1,power:.8,liveBudget:{elapsedMs:5400000,reportedCost:6}},
    screen:{simulations:120,resamples:300,seed:20261027,bootstrapSeed:20261124},
    confirmation:{simulations:240,resamples:1000,seed:20261127,bootstrapSeed:20261224,selection:"All N240 budget-boundary allocations in both source models plus first two screened>=80% candidates per source/family(repeat,variants),deduplicated. Independent seed; retain every result. Original adequacy is point>=80%; lower95>=80% is separately reported Monte Carlo assurance, not a redefinition."},
    sensitivities:{simulations:120,resamples:300,seed:20261227,bootstrapSeed:20261324,coupling:[.5,.75,.9,.95,1],scale:[.9,.8,.7],designs:[{source:"trial-stratified",clusters:10,blocks:4},{source:"interleaved-class-mixture",clusters:40,blocks:1}],persistentShape:"Repeat grid's first two screened adequate candidates and N240 repeat boundary under both source models"},
    models:{"trial-stratified":"Preserve six historical trial/class cells; matched pair latencies arm-swapped under a neutral exchangeable planning alternative. Repeated-task shape sampled independently per block as in original planner.","interleaved-class-mixture":"Both future trials deliberately interleaved within time blocks, draw each class from its two historical trials pooled. Requires future temporal-mixture stationarity and independent variant episodes; not established by60 pairs.",sensitivities:"Shared-latency copula mixture preserves neutral marginals but is purely hypothetical; scale is a hypothetical real latency improvement. Neither is an eligible powered-design result. Persistent-shape variant tests repeated-task nuisance. No tails excluded/trimmed or old observations reclassified."},
    algorithm:"Fixed nearest-rank95%, same matched-cluster bootstrap as repaired reference. Weighted empirical counts exactly preserve pairs and all blocks. Early bootstrap rejection only when remaining draws mathematically cannot make fixed95th order statistic pass. No numerical/clinical gate or paid sample changes.",
    bounds:{elapsedMs:900000,newEvidenceBytes:2*1024*1024,sharedEvidenceBytes:64*1024*1024,liveRequests:0,fixtures:0},
    policy:"Historical-data planning, not acceptance or proof of actual future power. No live launch, credential activity/default/provider edits or old evidence cleanup. Current HOLD persists regardless of simulations. Lowest qualifying tested grid point is not a proved globally minimalN. Preserve checkpoints/failures."};
  save(path.join(run,"protocol.json"),protocol);
  const experiment=ledger.openExperiment(root,"CodeMode design planning offline 2026-10-24",{hypothesis:"Current budget may be too small for80% clearance under heavy-tail/quantile uncertainty; compare repetitions and broader independent variants with unchanged release margins",arms:["trial-stratified planning","interleaved common temporal mixture planning","explicitly unvalidated variance/effect sensitivities"],bars:[`ProtocolSHA ${digest(protocol)}`,"All candidate and selected confirmation rows retained; no paid requests, no adaptive new grid, no claimed acceptance",JSON.stringify(protocol.bounds)]});
  const started=performance.now(),screens=[],confirmations=[],sensitivities=[];
  const guard=()=>{if(performance.now()-started>protocol.bounds.elapsedMs||treeBytes(run)>protocol.bounds.newEvidenceBytes||retainedBytes()>protocol.bounds.sharedEvidenceBytes)throw new Error("Offline bound exceeded");};
  const evaluate=(design,options)=>({...design,...simulateDesign(references[design.source],design,options),projection:project(rows,design)});
  console.log(JSON.stringify({run:path.relative(root,run),experimentId:experiment.experimentId,designs:candidates.length}));
  const referencePower=assessPower(rows);
  const correctedHistoricalUpper95=upperBound(pairRows(rows),{resamples:5000});
  save(path.join(run,"corrected-reference.json"),{referencePower,correctedHistoricalUpper95,supersedes:"Archived9.17%/1.891 values used a per-row-RNG bootstrap, not prescribed task-cluster resampling; originals retained but not current gates."});
  for(const design of candidates){guard();const result=evaluate(design,protocol.screen);screens.push(result);save(path.join(run,`screen-${design.id}.json`),result);console.log(`screen ${design.id} N${result.pairs} ${result.successes}/${result.simulations} budget=${result.projection.withinBudget}`);}
  const baseline=screens.find(r=>r.source==="trial-stratified"&&r.clusters===10&&r.blocks===3);
  if(baseline.successes!==referencePower.successes)throw new Error("Optimized planner does not match corrected reference");
  const selected=new Map(screens.filter(r=>r.pairs===240).map(r=>[r.id,r]));
  for(const source of Object.keys(references))for(const family of ["repeat","variants"]){for(const r of screens.filter(r=>r.source===source&&r.family===family&&r.adequate).sort((a,b)=>a.pairs-b.pairs).slice(0,2))selected.set(r.id,r);}
  for(const design of selected.values()){guard();const result=evaluate(design,protocol.confirmation);confirmations.push(result);save(path.join(run,`confirm-${design.id}.json`),result);console.log(`confirm ${design.id} ${result.successes}/${result.simulations} lower95=${result.monteCarlo95[0]}`);}
  const sensitivityOptions=scalarSensitivityOptions(protocol.sensitivities);
  for(const design of protocol.sensitivities.designs){for(const coupling of protocol.sensitivities.coupling){guard();const r=evaluate(design,{...sensitivityOptions,coupling});sensitivities.push({...r,eligible:false,type:"unvalidated-copula"});}for(const scale of protocol.sensitivities.scale){guard();const r=evaluate(design,{...sensitivityOptions,scale});sensitivities.push({...r,eligible:false,type:"hypothetical-latency-improvement"});}}
  const persistent=new Map(screens.filter(r=>r.pairs===240&&r.family==="repeat").map(r=>[r.id,r]));
  for(const source of Object.keys(references))for(const r of screens.filter(r=>r.source===source&&r.family==="repeat"&&r.adequate).sort((a,b)=>a.pairs-b.pairs).slice(0,2))persistent.set(r.id,r);
  for(const design of persistent.values()){guard();sensitivities.push({...evaluate(design,{...sensitivityOptions,persistent:true}),eligible:false,type:"persistent-task-shape"});}
  save(path.join(run,"sensitivities.json"),sensitivities);
  const checks={historicalUnchanged:fileDigest(historicalFiles)===before.historical,sourceUnchanged:sourceDigest()===before.source,protectedUnchanged:protectedDigest(agentDir,historyRoot)===before.protected,defaultOn:/^PI_CODEMODE=1$/m.test(fs.readFileSync(path.join(root,"config/harness-defaults.env"),"utf8")),referenceAgreement:baseline.successes===referencePower.successes};
  if(!Object.values(checks).every(Boolean))throw new Error("Planning integrity failed");guard();
  const budgetQualified=confirmations.filter(r=>r.adequate&&r.projection.withinBudget);
  const recommended=confirmations.filter(r=>r.lower95AtLeast80).sort((a,b)=>a.pairs-b.pairs);
  const result={version:1,generatedAt:new Date().toISOString(),experimentId:experiment.experimentId,elapsedMs:performance.now()-started,checks,referencePower,correctedHistoricalUpper95,screens,confirmations,sensitivities,budgetQualified,recommended,
    liveRequests:0,supportsLiftingHold:false,decision:"HOLD",defaultsChanged:false,
    interpretation:"Model-conditional power; no distribution-free proof or observed neutrality. Interleaving assumes common temporal mixture; broader seed variants do not expand three template families. Budget estimates linear from120cases, not guarantees. Unvalidated coupling/scaling scenarios cannot qualify a within-budget plan. Actual historicalTrial2 point target remains failed."};
  save(path.join(run,"result.json"),result);
  ledger.recordGate(root,experiment.experimentId,{gate:"budget-feasible80percent",verdict:budgetQualified.length?"pass":"null-result",gpuHours:0,metrics:JSON.stringify({qualified:budgetQualified.length,recommended:recommended.map(r=>({id:r.id,pairs:r.pairs,power:r.power,cost:r.projection.reportedCost,minutes:r.projection.minutes}))}),note:"Offline planning only; not observed acceptance"});
  ledger.closeExperiment(root,experiment.experimentId,{decision:"no-go",note:"HOLD/defaults unchanged; zero paid requests. Planning candidates require fixed prospective protocol and budget/model validation before inference."});
  console.log(JSON.stringify({run:path.relative(root,run),checks,correctedPower:referencePower.power,correctedHistoricalUpper95,budgetQualified:budgetQualified.map(r=>r.id),recommended:recommended.map(r=>({id:r.id,pairs:r.pairs,power:r.power,mc:r.monteCarlo95,cost:r.projection.reportedCost,minutes:r.projection.minutes})),elapsedMs:result.elapsedMs},null,2));
}
function scalarSensitivityOptions(protocol){
  const {simulations,resamples,seed,bootstrapSeed}=protocol;
  return {simulations,resamples,seed,bootstrapSeed};
}
module.exports={grid,scalarSensitivityOptions};
if(require.main===module)main().catch(error=>{console.error(`Offline design planning failed: ${error.message}`);process.exitCode=1;});
