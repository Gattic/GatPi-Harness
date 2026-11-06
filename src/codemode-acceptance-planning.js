"use strict";

const { pairRows, random, SEED } = require("./codemode-decision-benchmark");

function interval(successes, simulations) {
  const p=successes/simulations,z=1.96,d=1+z*z/simulations;
  const center=(p+z*z/(2*simulations))/d;
  const radius=z*Math.sqrt(p*(1-p)/simulations+z*z/(4*simulations*simulations))/d;
  return [center-radius,center+radius];
}
function referenceFor(rows) {
  const pairs=pairRows(rows),groups=new Map();
  for(const pair of pairs){const key=`${pair.trial}:${pair.kind}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(pair);}
  if(pairs.length!==60||groups.size!==6||[...groups.values()].some(g=>g.length!==10))throw new Error("Require all60 frozen full-profile matched pairs in six trial/class cells");
  if(pairs.some(p=>!Number.isFinite(p.direct)||p.direct<=0||!Number.isFinite(p.codemode)||p.codemode<=0))throw new Error("Invalid historical latency");
  return {groups:[...groups.values()],pairs};
}
function interleavedReference(reference) {
  return { groups: [0,1].flatMap(trial=>["simple","batch","chain"].map(kind=>reference.groups.filter(g=>g[0].kind===kind).flat().map(pair=>({...pair,trial})))) };
}
function validate(design) {
  if(!Number.isSafeInteger(design.clusters)||design.clusters<1||!Number.isSafeInteger(design.blocks)||design.blocks<1)throw new Error("Positive integer clusters/blocks required");
}
function drawStudy(reference,design,rng,{coupling=0,scale=1,persistent=false}={}) {
  validate(design);
  if(!Number.isFinite(coupling)||coupling<0||coupling>1||!Number.isFinite(scale)||scale<=0)throw new Error("Invalid sensitivity parameters");
  return reference.groups.map(group=>{
    const clusters=Array.from({length:design.clusters},()=>[]),shapes=[];
    for(let block=0;block<design.blocks;block++)for(let j=0;j<design.clusters;j++){
      const sampled=group[Math.floor(rng()*group.length)],swap=rng()<.5;
      if(block===0)shapes[j]=sampled;
      const pair=persistent?shapes[j]:sampled;
      const direct=swap?pair.codemode:pair.direct;
      let codemode=swap?pair.direct:pair.codemode;
      // A hypothetical copula change preserves both exchangeable marginal distributions.
      // It is NOT evidence that parallel execution actually creates shared tail delays.
      if(coupling>0&&rng()<coupling)codemode=direct;
      clusters[j].push({direct,codemode:codemode*scale});
    }
    return {trial:group[0].trial,kind:group[0].kind,clusters};
  });
}
function compile(study) {
  const values=[...new Set(study.flatMap(g=>g.clusters.flatMap(c=>c.flatMap(p=>[p.direct,p.codemode]))))].sort((a,b)=>a-b);
  const index=new Map(values.map((value,i)=>[value,i]));
  const groups=study.map(g=>({...g,clusters:g.clusters.map(cluster=>{
    const a=new Map(),b=new Map();for(const p of cluster){const i=index.get(p.direct),j=index.get(p.codemode);a.set(i,(a.get(i)||0)+1);b.set(j,(b.get(j)||0)+1);}
    return {direct:[...a],codemode:[...b],count:cluster.length};
  })}));
  return {values,groups};
}
function histograms(compiled,weights,selected=compiled.groups) {
  const direct=new Int32Array(compiled.values.length),codemode=new Int32Array(compiled.values.length);let count=0;
  for(const g of selected)for(let j=0;j<g.clusters.length;j++){
    const c=g.clusters[j],weight=weights?weights.get(g)[j]:1;if(!weight)continue;count+=c.count*weight;
    for(const [i,n]of c.direct)direct[i]+=n*weight;for(const [i,n]of c.codemode)codemode[i]+=n*weight;
  }
  return {direct,codemode,count};
}
function ratio(compiled,hist) {
  const rank=Math.ceil(.95*hist.count);
  const quantile=counts=>{let cumulative=0;for(let i=0;i<counts.length;i++){cumulative+=counts[i];if(cumulative>=rank)return compiled.values[i];}throw new Error("Incomplete histogram");};
  return quantile(hist.codemode)/quantile(hist.direct);
}
function studyPass(study,{resamples=300,seed=SEED+100}={}) {
  if(!Number.isSafeInteger(resamples)||resamples<1)throw new Error("Positive bootstrap count required");
  const c=compile(study),points=[0,1].map(trial=>ratio(c,histograms(c,null,c.groups.filter(g=>g.trial===trial))));
  points.push(ratio(c,histograms(c)));
  if(points.some(p=>p>1.1))return {pass:false,pointPass:false,bootstrapDraws:0,points};
  const rng=random(seed),allowedAbove=resamples-Math.ceil(.95*resamples);let above=0;
  for(let r=0;r<resamples;r++){
    const weights=new Map(c.groups.map(g=>[g,new Int32Array(g.clusters.length)]));
    for(const g of c.groups)for(let j=0;j<g.clusters.length;j++)weights.get(g)[Math.floor(rng()*g.clusters.length)]++;
    if(ratio(c,histograms(c,weights))>1.1)above++;
    // Exact early rejection: once more than5% are above the limit, no remaining
    // bootstrap draw can make the fixed95th order statistic pass. No sample is extended.
    if(above>allowedAbove)return {pass:false,pointPass:true,bootstrapDraws:r+1,points};
  }
  return {pass:true,pointPass:true,bootstrapDraws:resamples,points};
}
function simulateDesign(reference,design,{simulations=120,resamples=300,seed=SEED+3,bootstrapSeed=SEED+100,coupling=0,scale=1,persistent=false}={}) {
  validate(design);if(!Number.isSafeInteger(simulations)||simulations<1)throw new Error("Positive study count required");
  const rng=random(seed);let successes=0,pointSuccesses=0,bootstrapDraws=0;
  for(let i=0;i<simulations;i++){
    const study=drawStudy(reference,design,rng,{coupling,scale,persistent});
    const result=studyPass(study,{resamples,seed:bootstrapSeed+i});
    successes+=Number(result.pass);pointSuccesses+=Number(result.pointPass);bootstrapDraws+=result.bootstrapDraws;
  }
  const power=successes/simulations,monteCarlo95=interval(successes,simulations);
  return {clustersPerCell:design.clusters,blocksPerCluster:design.blocks,pairs:6*design.clusters*design.blocks,sessions:12*design.clusters*design.blocks,simulations,resamples,seed,bootstrapSeed,successes,pointSuccesses,power,monteCarlo95,adequate:power>=.8,lower95AtLeast80:monteCarlo95[0]>=.8,bootstrapDraws,coupling,scale,persistent};
}
function project(rows,design) {
  validate(design);const sessions=12*design.clusters*design.blocks;
  const perSessionMs=rows.reduce((n,r)=>n+r.phases.promptMs+r.setupMs+r.postprocessMs+r.cleanupMs,0)/rows.length;
  const perSessionCost=rows.reduce((n,r)=>n+r.reportedCost,0)/rows.length;
  const elapsedMs=sessions*perSessionMs,reportedCost=sessions*perSessionCost;
  return {sessions,elapsedMs,minutes:elapsedMs/60000,reportedCost,withinBudget:elapsedMs<=90*60000&&reportedCost<=6,withinBudgetWith10PercentReserve:elapsedMs*1.1<=90*60000&&reportedCost*1.1<=6};
}
module.exports={interval,referenceFor,interleavedReference,drawStudy,studyPass,simulateDesign,project};
