#!/usr/bin/env node
"use strict";

// Offline evidence audit only: this command cannot create model sessions or resume live cohorts.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { MANIFEST, digest } = require("../src/codemode-benchmark");
const { pairRows, p95Ratio, upperBound, assessPower, schedule } = require("../src/codemode-decision-benchmark");
const { filesUnder, fileDigest } = require("./benchmark-codemode-phases");
const { save, treeBytes, sourceDigest, protectedDigest } = require("./benchmark-codemode");
const { installedRuntime } = require("../tests/helpers/codemode-runtime");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname,"..");
const COHORTS = {
  phase: { directory:".pi/codemode-phase-benchmark/live-1792848822532", hash:"1775c8ebe8d4ecd43d9d1d00173b58829b9481e9cd3ba4d9739dd71b69277823" },
  diagnostic: { directory:".pi/codemode-decision-benchmark/live-1792855279662", hash:"c80215bc630b20c9ac9e8aac61160ae8a8b0df1a29843b69e7b8bc7e5d3df24e" },
  continuation: { directory:".pi/codemode-continuation-benchmark/live-1792860305312", hash:"f3f61f10af6adabb02b4be08418292367013fd62efae8199e3caf48801860545" },
};
function historicalProfile(rows) {
  const expected = new Set([0,1].flatMap(trial=>MANIFEST.flatMap(task=>["direct","codemode"].map(arm=>`${trial}:${task.id}:${arm}`))));
  const keys = rows.map(r=>`${r.trial}:${r.id}:${r.arm}`);
  const complete = rows.length===120&&new Set(keys).size===120&&keys.every(k=>expected.has(k))&&rows.every(r=>MANIFEST.find(t=>t.id===r.id)?.kind===r.kind);
  if(!complete)throw new Error("Expected exact original two-trial full profile, not selected/duplicated cases");
  const pairs = pairRows(rows);
  const hasContext = r=>Number.isFinite(r.phases.contextEstimatedTokens)&&r.phases.contextEstimatedTokens>0;
  const numericCaseMeasurement = rows.every(r=>Number.isFinite(r.phases.promptMs)&&r.phases.promptMs>0&&hasContext(r)&&r.phases.timingComplete&&r.phases.providerTimingComplete&&r.tokens.totalMatchesSdk);
  const quality = rows.every(r=>r.oracle.ok&&r.integrity&&!r.providerError&&!r.timedOut&&r.toolFailures===0);
  const context = arm=>rows.filter(r=>r.arm===arm&&r.kind!=="simple").reduce((n,r)=>n+r.phases.contextEstimatedTokens,0);
  const costsKnown = rows.every(r=>Number.isFinite(r.reportedCost)&&r.reportedCost>=0);
  const cost = arm=>costsKnown?rows.filter(r=>r.arm===arm).reduce((n,r)=>n+r.reportedCost,0):null;
  const p95Ratios = { trials:[0,1].map(trial=>p95Ratio(pairs.filter(p=>p.trial===trial))), pooled:p95Ratio(pairs) };
  const composedContextRatio = numericCaseMeasurement?context("codemode")/context("direct"):null;
  const costRatio = costsKnown&&cost("direct")>0?cost("codemode")/cost("direct"):null;
  return { cases:rows.length,pairs:pairs.length,complete,quality,numericCaseMeasurement,
    fixturesPaired:rows.every(r=>rows.find(p=>p.trial===r.trial&&p.id===r.id&&p.arm!==r.arm).fixtureDigest===r.fixtureDigest),
    p95Ratios,composedContextRatio,costRatio,reportedCost:costsKnown?cost("direct")+cost("codemode"):null,
    targets:{latency:[...p95Ratios.trials,p95Ratios.pooled].every(v=>Number.isFinite(v)&&v<=1.1),composedContext:Number.isFinite(composedContextRatio)?composedContextRatio<=.75:null,cost:Number.isFinite(costRatio)?costRatio<=1.1:null},
    detailedAcceptanceTelemetryAvailable:rows.every(r=>r.phases.turns.length>0&&r.phases.turns.every(t=>t.requestUtc&&t.endUtc&&t.usage?.totalMatchesSdk&&t.categories?.completed)),
    supportsLiftingHold:false,
    scope:"Historical120-case phase cohort, not the missing360-case acceptance. New confidence calculation is retrospective; absent detailed per-turn metadata is not fabricated." };
}
function retainedBytes() {
  return fs.readdirSync(path.join(root,".pi")).filter(n=>n.startsWith("codemode")).reduce((n,f)=>{const file=path.join(root,".pi",f),s=fs.lstatSync(file);if(s.isSymbolicLink())throw new Error("Evidence symlink");return n+(s.isDirectory()?treeBytes(file):s.size);},0);
}
async function main() {
  if(process.argv.length!==2)throw new Error("Offline audit takes no live or override arguments");
  const parent=path.join(root,".pi/codemode-acceptance-audit");
  if(fs.existsSync(parent)&&fs.readdirSync(parent).some(n=>n.startsWith("audit-")))throw new Error("An audit exists: inspect its retained result rather than repeating");
  const hashes=()=>Object.fromEntries(Object.entries(COHORTS).map(([key,c])=>[key,fileDigest(filesUnder(path.join(root,c.directory)))]));
  if(Object.entries(hashes()).some(([key,hash])=>hash!==COHORTS[key].hash))throw new Error("Frozen cohort lineage changed");
  const phaseProtocol=JSON.parse(fs.readFileSync(path.join(root,COHORTS.phase.directory,"protocol.json")));
  const phaseSummary=JSON.parse(fs.readFileSync(path.join(root,COHORTS.phase.directory,"summary.json")));
  const decisionProtocol=JSON.parse(fs.readFileSync(path.join(root,COHORTS.diagnostic.directory,"protocol.json")));
  const decisionSummary=JSON.parse(fs.readFileSync(path.join(root,COHORTS.diagnostic.directory,"summary.json")));
  if(fileDigest(phaseProtocol.historicalFiles.map(f=>path.join(root,f)))!==phaseProtocol.historicalDigest)throw new Error("Original pilot/history lineage changed");
  const rows=fs.readdirSync(path.join(root,COHORTS.phase.directory)).filter(n=>/^r[01]-codemode-\d+-(direct|codemode)\.json$/.test(n)).sort().map(n=>JSON.parse(fs.readFileSync(path.join(root,COHORTS.phase.directory,n))));
  const profile=historicalProfile(rows),plan=schedule("acceptance");
  const {root:sdkRoot}=await installedRuntime();
  const providerFiles=[path.resolve(sdkRoot,"../ai/dist/api/openai-codex-responses.js"),path.resolve(sdkRoot,"../ai/dist/api/openai-responses-shared.js")];
  const historyRoot=execFileSync("git",["rev-parse","--path-format=absolute","--git-common-dir"],{cwd:root,encoding:"utf8"}).trim().replace(/[\/]\.git$/,"");
  const agentDir=process.env.PI_CODING_AGENT_DIR||path.join(os.homedir(),".pi/agent");
  const before={source:sourceDigest(),protected:protectedDigest(agentDir,historyRoot),cohorts:hashes(),pi:digest(fs.readFileSync(require.resolve(sdkRoot))),provider:fileDigest(providerFiles)};
  if(before.pi!==decisionProtocol.before.pi||before.provider!==decisionProtocol.before.provider)throw new Error("Installed Pi/provider lineage changed");
  const stat=fs.statfsSync(root),freeBytes=stat.bavail*stat.bsize,retained=retainedBytes();
  if(freeBytes<256*1024*1024||retained+1024*1024>=decisionProtocol.budgets.evidenceBytes)throw new Error("Insufficient bounded audit headroom");
  const run=path.join(parent,`audit-${Date.now()}`);fs.mkdirSync(run,{recursive:true,mode:0o700});
  const protocol={version:1,kind:"offline-full-profile-acceptance-audit",createdAt:new Date().toISOString(),before,
    authorization:"Inspect unchanged acceptance criteria and existing evidence, execute feasible missing checks. Keep HOLD/defaults unless acceptance demonstrated.",
    computations:{originalPower:{simulations:120,resamples:300,seed:20261027,pairs:180},numericalSensitivity:{simulations:120,resamples:5000,sameStudies:true,replacesFrozenPrerequisite:false},retrospectiveConfidence:{resamples:5000,seed:20261026,scope:"Frozen60 pairs only; not new acceptance"}},
    acceptance:{planDigest:digest(plan),cases:plan.length,trials:2,pairsPerTrial:90,blocksPerTrial:3,powerRule:decisionProtocol.powerRule,rules:decisionProtocol.decisionRules.acceptance,budgets:decisionProtocol.budgets.acceptance},
    bounds:{wallMs:480000,newEvidenceBytes:1024*1024,sharedEvidenceBytes:decisionProtocol.budgets.evidenceBytes,fixtures:0,liveRequests:0},
    policy:"No new statistical threshold/N chosen, no pilot/phase/diagnostic/continuation artifact rewritten, no selected cases substituted, no detailed metadata retrofitted. This command never calls liveInference/createRuntime or provider generation. No historical evidence cleanup."};
  save(path.join(run,"protocol.json"),protocol);console.log(JSON.stringify({run:path.relative(root,run),contract:protocol.computations}));
  const started=performance.now();
  const power=assessPower(rows),powerReproduced=JSON.stringify(power)===JSON.stringify(decisionProtocol.power);
  if(!powerReproduced)throw new Error("Frozen planning computation did not reproduce");
  save(path.join(run,"planning-reproduction.json"),power);
  console.log(`original planning reproduced ${power.successes}/${power.simulations}`);
  const historicalUpper95=upperBound(pairRows(rows),{resamples:5000,seed:20261026});
  save(path.join(run,"historical-confidence.json"),{...profile,retrospectiveConfidence:{upper95:historicalUpper95,pass:historicalUpper95<=1.1,resamples:5000,seed:20261026}});
  const precisionPower=assessPower(rows,{simulations:120,resamples:5000});
  const elapsedMs=performance.now()-started;
  const archiveIntegrity=phaseSummary.integrityComplete&&phaseSummary.sourceUnchanged&&phaseSummary.historicalUnchanged&&phaseSummary.protectedUnchanged&&phaseSummary.environmentUnchanged&&phaseSummary.piUnchanged&&decisionSummary.integrityComplete;
  const checks={powerReproduced,archiveIntegrity,rawCohortsUnchanged:JSON.stringify(hashes())===JSON.stringify(before.cohorts),sourceUnchanged:sourceDigest()===before.source,protectedUnchanged:protectedDigest(agentDir,historyRoot)===before.protected,piUnchanged:digest(fs.readFileSync(require.resolve(sdkRoot)))===before.pi,providerUnchanged:fileDigest(providerFiles)===before.provider,defaultOn:/^PI_CODEMODE=1$/m.test(fs.readFileSync(path.join(root,"config/harness-defaults.env"),"utf8")),withinAuditBounds:elapsedMs<protocol.bounds.wallMs&&treeBytes(run)<protocol.bounds.newEvidenceBytes};
  if(!Object.values(checks).every(Boolean))throw new Error("Audit integrity or resource invariant failed");
  if(decisionSummary.acceptanceComplete||decisionSummary.stages.acceptance.status!=="not-run")throw new Error("Inspect existing acceptance before declaring missing work");
  const typicalMs=rows.reduce((n,r)=>n+r.phases.promptMs+r.setupMs+r.postprocessMs+r.cleanupMs,0)/rows.length;
  const result={version:1,generatedAt:new Date().toISOString(),protocolDigest:digest(protocol),checks,elapsedMs,liveRequests:0,
    historicalProfile:{...profile,retrospectiveConfidence:{upper95:historicalUpper95,pass:historicalUpper95<=1.1,resamples:5000,seed:20261026}},
    originalPlanning:power,higherPrecisionSensitivity:precisionPower,
    resourceFeasibility:{freeBytes,retainedBeforeBytes:retained,sharedCapBytes:protocol.bounds.sharedEvidenceBytes,projected360CaseTypicalMs:typicalMs*360,projected360CaseCatalogCost:profile.reportedCost*3,assumptions:"Linear projection from120 archived cases; not a time/cost or future-variance guarantee. Soft cost stop remains mandatory."},
    missingAcceptance:{status:"not-run",requiredCases:360,observedCases:0,quality:null,measurement:null,targets:{latency:null,confidence:null,composedContext:null,cost:null},reason:power.adequate?"Requires a separately guarded acceptance-only entrypoint; never replay completed diagnostics":"INADEQUATE_PLANNING_POWER",powerGate:power.adequate,originalCohortResumePermitted:false},
    supportsLiftingHold:false,decision:"HOLD",defaultsChanged:false,
    boundary:"Offline checks cannot satisfy missing live acceptance. A different powered design/budget must be fixed before any new observations; this audit neither selects such a design nor waives/increases the frozenN180 gate."};
  save(path.join(run,"result.json"),result);console.log(JSON.stringify(result,null,2));
}
module.exports={historicalProfile};
if(require.main===module)main().catch(error=>{console.error(`Acceptance audit failed: ${error.code||error.message}`);process.exitCode=1;});
