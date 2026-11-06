"use strict";

// Owned test process only: real SDK/provider, synthetic WebSocket, forbidden HTTP.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { installedRuntime, createRuntime } = require("./codemode-runtime");
const { installRawWebSocketTap, createRawMeasurements, modeObserved } = require("../../src/codemode-continuation-benchmark");
let sequence=0;
globalThis.fetch=async()=>{throw new Error("Network forbidden in native transport qualification");};
globalThis.WebSocket=class extends EventTarget {
  readyState=0;
  constructor(){super();setImmediate(()=>{this.readyState=1;this.dispatchEvent(new Event("open"));});}
  send(){
    const id=`synthetic-response-${++sequence}`,text='{"ok":true}';
    const item={id:`synthetic-message-${sequence}`,type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text,annotations:[]}]};
    const events=[
      {type:"response.created",response:{id,status:"in_progress"}},
      {type:"response.in_progress",response:{id,status:"in_progress"}},
      {type:"response.output_item.added",output_index:0,item:{...item,content:[]}},
      {type:"response.output_text.delta",output_index:0,content_index:0,delta:text},
      {type:"response.output_item.done",output_index:0,item},
      {type:"response.completed",response:{id,status:"completed",output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}},
    ];
    setImmediate(()=>{for(const event of events)this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(event)}));});
  }
  close(){this.readyState=3;this.dispatchEvent(Object.assign(new Event("close"),{code:1000,reason:"synthetic-test",wasClean:true}));}
};
(async()=>{
  const tap=installRawWebSocketTap();
  const {sdk,root}=await installedRuntime();
  const {getOpenAICodexWebSocketDebugStats:getStats}=await import(pathToFileURL(path.resolve(root,"../ai/dist/api/openai-codex-responses.js")).href);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"pi-decision-ws-"));
  try{
    const modelRuntime=await sdk.ModelRuntime.create({authPath:path.join(directory,"auth.json"),modelsPath:null,refreshOnCreate:false});
    const jwt=`synthetic.${Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"synthetic-account"}})).toString("base64url")}.synthetic`;
    modelRuntime.registerProvider("openai-codex",{api:"openai-codex-responses",baseUrl:"https://example.invalid/backend-api",apiKey:jwt,models:[{id:"synthetic-native",name:"Synthetic native transport",reasoning:false,input:["text"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:100}]});
    const model=modelRuntime.getModel("openai-codex","synthetic-native");
    for(const transport of ["websocket-cached","websocket"]){
      let runtime,unwatch;
      try{
        const phases=createRawMeasurements({stats:()=>runtime?getStats(runtime.session.sessionId):undefined});
        runtime=await createRuntime({inference:{modelRuntime,model,thinkingLevel:"off"},settings:{transport},noTools:true,extensionFactories:[phases.install]});
        assert.deepEqual(runtime.session.getActiveToolNames(),[]);
        runtime.session.subscribe(phases.observe);unwatch=tap.watch(phases.raw);
        phases.start();await runtime.session.prompt('Return exactly JSON {"ok":true}.');await runtime.session.prompt("Return the same fixed JSON again.");phases.finish();unwatch();unwatch=null;
        const measured=phases.snapshot();
        assert.equal(measured.turns.length,2);
        assert(measured.turns.every(t=>t.categories.completed&&t.categories.created&&t.categories.textDelta&&t.usage.totalMatchesSdk));
        assert(measured.turns.every(t=>t.wsAfter&&t.wsDelta.requests===1),"observer must share actual SDK provider state");
        assert.equal(measured.turns[0].wsDelta.connectionsCreated,1);
        assert.equal(measured.turns[1].wsDelta.connectionsReused,1,"full-context mode must retain socket reuse");
        assert.equal(measured.turns[1].trace.attempts[0].send.previousResponse,transport==="websocket-cached");
        assert(measured.turns.every(t=>t.rawParsedAligned&&t.rawToParsedMaxMs>=0&&Number.isFinite(t.rawAckToItemMs)));
        assert.equal(modeObserved({transport,phases:measured}),true);
        assert.doesNotMatch(JSON.stringify(measured),/synthetic-account|synthetic-response|synthetic-message|"ok"/);
      }finally{if(unwatch)unwatch();if(runtime)await runtime.close();}
    }
    console.log("native SDK cached/full-context same-socket modes, raw/parsed timing correlation and privacy qualification passed");
  }finally{tap.restore();fs.rmSync(directory,{recursive:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
