"use strict";

const assert=require("node:assert/strict");
const path=require("node:path");
const {CELLS,eventMetadata,continuationSchedule,installRawWebSocketTap,createRawMeasurements,modeObserved,caseStall,pairedExact,summarizeContinuation}=require("../src/codemode-continuation-benchmark");
const {keepSpills}=require("../scripts/benchmark-codemode-decision");
const {BUDGETS}=require("../scripts/benchmark-codemode-continuation");
assert.equal(typeof keepSpills,"function");assert.equal(BUDGETS.reportedCost,2);
const plan=continuationSchedule();assert.equal(plan.length,48);assert.deepEqual(plan,continuationSchedule());assert.equal(new Set(plan.map(p=>p.key)).size,48);
for(const cell of Object.keys(CELLS)){
  assert.equal(plan.filter(p=>p.cell===cell).length,16);
  const positions=[0,1,2].map(position=>plan.filter(p=>p.cell===cell&&p.position===position).length);
  assert(Math.max(...positions)-Math.min(...positions)<=1);
}
assert.equal(Array.from({length:16},(_,block)=>plan.find(p=>p.block===block&&p.cell==="cached").position<plan.find(p=>p.block===block&&p.cell==="full").position).filter(Boolean).length,8);
assert.deepEqual(eventMetadata({type:"PRIVATE_SENTINEL",item:{type:"PRIVATE_SENTINEL"},sequence_number:"PRIVATE_SENTINEL"}),{tag:"other",kind:null,sequence:null});
assert.equal(pairedExact(5,0),.03125);assert.equal(pairedExact(0,5),1);assert.equal(pairedExact(0,0),1);

// Raw-frame metadata observer never retains payloads, constructor arguments or IDs.
const Original=globalThis.WebSocket;
globalThis.WebSocket=class extends EventTarget{constructor(...args){super();this.constructorArgs=args;}send(value){this.lastSent=value;}};
let time=0;const tap=installRawWebSocketTap({clock:()=>time}),frames=[];const unwatch=tap.watch(frame=>frames.push(frame));
const socket=new globalThis.WebSocket("PRIVATE_SENTINEL");socket.send(JSON.stringify({type:"response.create",previous_response_id:"PRIVATE_SENTINEL",input:"PRIVATE_SENTINEL"}));time=5;
socket.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"response.output_text.delta",delta:"PRIVATE_SENTINEL"})}));
assert.equal(frames.length,2);assert.equal(frames[0].previousResponse,true);assert.equal(frames[1].at,5);assert.doesNotMatch(JSON.stringify(frames),/PRIVATE_SENTINEL|previous_response_id|"input":|"delta":/);
assert.equal(socket.constructorArgs[0],"PRIVATE_SENTINEL");assert.match(socket.lastSent,/PRIVATE_SENTINEL/,"send is forwarded unmodified, never stored by observer");unwatch();tap.restore();globalThis.WebSocket=Original;

function syntheticTiming(limit){
  let time=0;const handlers=new Map();const phase=createRawMeasurements({clock:()=>time,limit});
  phase.install({on(name,fn){if(!handlers.has(name))handlers.set(name,[]);handlers.get(name).push(fn);}});
  const emit=(at,name,event={})=>{time=at;for(const fn of handlers.get(name))fn(event);};
  const raw=(at,type,extra={})=>{time=at;phase.raw({direction:type==="response.create"?"send":"receive",at,socket:1,bytes:10,previousResponse:false,...eventMetadata({type,...extra})});};
  phase.start();emit(1,"context_with_system",{messages:[]});emit(2,"before_provider_request",{payload:{}});raw(3,"response.create");
  raw(5,"response.in_progress");emit(15,"provider_stream_event",{data:{type:"response.in_progress"}});
  raw(20,"response.output_item.added",{item:{type:"message"}});emit(220,"provider_stream_event",{data:{type:"response.output_item.added",item:{type:"message"}}});
  raw(230,"response.output_text.delta");emit(231,"provider_stream_event",{data:{type:"response.output_text.delta",delta:"PRIVATE_SENTINEL"}});
  emit(232,"message_update",{message:{role:"assistant"},assistantMessageEvent:{type:"text_delta",delta:"PRIVATE_SENTINEL"}});
  raw(240,"response.completed");emit(241,"provider_stream_event",{data:{type:"response.completed"}});
  raw(242,"rate_limits.updated"); // Native adapter stops at completion; preserve unconsumed tail separately.
  emit(250,"message_end",{message:{role:"assistant",usage:{input:1,cacheRead:0,cacheWrite:0,output:1,totalTokens:2,cost:{total:0}}}});
  time=260;phase.finish();return phase.snapshot();
}
const measured=syntheticTiming(),turn=measured.turns[0];
assert.equal(turn.rawParsedAligned,true);assert.equal(turn.rawAckToItemMs,15);assert.equal(turn.parsedAckToItemMs,205);assert.equal(turn.firstItemRawToParsedMs,200);assert.equal(turn.rawToParsedMaxMs,200);
assert.equal(turn.trace.attempts[0].trailingFrames.length,1);assert.doesNotMatch(JSON.stringify(measured),/PRIVATE_SENTINEL/);
assert.equal(syntheticTiming(2).rawCapture.overflow,true,"bounded capture never silently passes truncation");
function fakeRow(entry){
  const cached=entry.transport==="websocket-cached";
  const turns=[0,1].map(i=>({index:i,parsedAckToItemMs:entry.cell==="cached"&&i===1?20000:1000,rawAckToItemMs:1000,rawParsedAligned:true,rawToParsedMaxMs:1,usage:{totalMatchesSdk:true},wsDelta:{requests:1,connectionsCreated:i?0:1,connectionsReused:i?1:0,cachedContextRequests:cached?1:0,websocketFailures:0,sseFallbacks:0},trace:{attempts:[{send:{tag:"response.create",previousResponse:cached&&i>0}}]}}));
  return {...entry,oracle:{ok:true},integrity:true,providerError:false,toolFailures:0,modelTurns:2,underlyingToolAttempts:2,reportedCost:.01,tokens:{totalMatchesSdk:true},phases:{promptMs:100,modelPipelineMs:90,codemodeWallMs:entry.arm==="codemode"?5:0,timingComplete:true,providerTimingComplete:true,rawCapture:{overflow:false},turns}};
}
const rows=plan.map(fakeRow);assert(rows.every(modeObserved));assert.equal(caseStall(rows.find(r=>r.cell==="cached")),true);
const summary=summarizeContinuation(rows,plan);assert.equal(summary.complete,true);assert.equal(summary.primary.positive,16);assert.equal(summary.primary.p,1/65536);assert.equal(summary.primary.evidenceForContinuationReduction,true);assert.equal(summary.supportsLiftingHold,false,"a mechanism contrast can never grant release acceptance");
assert.equal(summarizeContinuation(rows.slice(1),plan).primary.p,null);
assert.equal(summarizeContinuation([rows[1],...rows.slice(1)],plan).complete,false);
assert.equal(modeObserved({...rows.find(r=>r.cell==="full"),phases:{turns:rows.find(r=>r.cell==="cached").phases.turns}}),false);
const unknown=rows.map(r=>({...r,phases:{...r.phases,turns:r.phases.turns.map(t=>({...t,parsedAckToItemMs:null}))}}));assert.equal(summarizeContinuation(unknown,plan).primary.p,null);
require("node:child_process").execFileSync(process.execPath,[path.join(__dirname,"helpers/codemode-decision-websocket.js")],{stdio:"inherit",timeout:30000});
console.log("continuation schedule, privacy, raw-vs-parsed timing, missing data, exact contrast and native-mode tests passed");
