"use strict";

const { monitorEventLoopDelay } = require("node:perf_hooks");
const { MANIFEST, percentile, digest } = require("./codemode-benchmark");
const { createPhaseMeasurements, tokenUsage, describe } = require("./codemode-phase-benchmark");

const SEED = 20261024;
const ANCHORS = [11, 21, 15, 19, 8, 5];
const COUNTERS = ["requests", "connectionsCreated", "connectionsReused", "cachedContextRequests", "fullContextRequests", "deltaRequests", "websocketFailures", "sseFallbacks"];
const CATEGORIES = new Map([
  ["response.created", "created"], ["response.in_progress", "inProgress"],
  ["response.output_item.added", "itemAdded"], ["response.output_item.done", "itemDone"],
  ["response.function_call_arguments.delta", "argumentDelta"], ["response.function_call_arguments.done", "argumentDone"],
  ["response.custom_tool_call_input.delta", "customInputDelta"], ["response.custom_tool_call_input.done", "customInputDone"],
  ["response.output_text.delta", "textDelta"], ["response.refusal.delta", "textDelta"],
  ["response.reasoning_summary_text.delta", "reasoningDelta"], ["response.reasoning_text.delta", "reasoningDelta"],
  ["response.completed", "completed"], ["response.incomplete", "incomplete"], ["response.failed", "failed"], ["error", "error"],
]);
const round = n => Math.round(n * 1000) / 1000;
function random(seed = SEED) { let state = seed >>> 0; return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296); }
function shuffled(values, rng) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
function schedule(stage) {
  if (!["diagnostic", "acceptance"].includes(stage)) throw new Error("Unknown stage");
  const rng = random(SEED + (stage === "acceptance" ? 1 : 0)), rows = [];
  const blocks = stage === "diagnostic" ? 4 : 6;
  // Randomize the first-arm assignment once per task, then reverse each repetition.
  const firstArm = new Map(MANIFEST.map(task => [task.id, rng() < .5 ? "direct" : "codemode"]));
  for (let block = 0; block < blocks; block++) {
    const tasks = stage === "diagnostic" ? ANCHORS.map(n => MANIFEST[n - 1]) : MANIFEST;
    if (stage === "diagnostic") rows.push({ stage, block, trial: null, probe: true, id: `probe-${block}-before`, arm: "probe" });
    for (const task of shuffled(tasks, rng)) {
      const first = block % 2 ? (firstArm.get(task.id) === "direct" ? "codemode" : "direct") : firstArm.get(task.id);
      for (const arm of [first, first === "direct" ? "codemode" : "direct"]) rows.push({ stage, block, trial: stage === "acceptance" ? Math.floor(block / 3) : null, probe: false, id: task.id, arm });
    }
    if (stage === "diagnostic") rows.push({ stage, block, trial: null, probe: true, id: `probe-${block}-after`, arm: "probe" });
  }
  return rows.map((row, ordinal) => ({ ...row, ordinal, key: `${stage}-b${row.block}-${row.id}-${row.arm}` }));
}

function createDecisionMeasurements({ clock = () => performance.now(), utc = () => new Date().toISOString(), stats = () => undefined } = {}) {
  let sampled, started, current, cpuStart;
  const base = createPhaseMeasurements(() => (sampled = clock()));
  const turns = [], lag = monitorEventLoopDelay({ resolution: 10 });
  const now = () => round(clock() - started);
  const safeStats = () => {
    const value = stats();
    if (!value) return null;
    return Object.fromEntries(COUNTERS.map(key => [key, Number.isFinite(value[key]) && value[key] >= 0 ? value[key] : null]));
  };
  function install(pi) {
    base.install(pi);
    pi.on("context_with_system", () => {
      current = { index: turns.length, contextUtc: utc(), requestUtc: null, endUtc: null, categories: {}, normalizedStarts: {}, httpStatuses: [], usage: null, reportedCost: null, providerReasoningReported: null, rawReasoningTokens: null, rawCachedInput: null, wsBefore: safeStats(), wsAfter: null };
      turns.push(current); cpuStart = process.cpuUsage(); lag.reset();
    });
    pi.on("before_provider_request", event => {
      if (!current) return;
      current.requestUtc ??= utc();
      current.inputItems = Array.isArray(event.payload?.input) ? event.payload.input.length : null;
      current.toolDeclarations = Array.isArray(event.payload?.tools) ? event.payload.tools.length : null;
      current.toolDeclarationDigest = Array.isArray(event.payload?.tools) ? digest(event.payload.tools) : null;
    });
    pi.on("after_provider_response", event => {
      if (current && Number.isInteger(event.status) && event.status >= 100 && event.status <= 599) current.httpStatuses.push(event.status);
    });
    pi.on("provider_stream_event", event => {
      if (!current) return;
      const data = event.data, category = CATEGORIES.get(data?.type) || "other", at = now();
      const previous = current.categories[category];
      current.categories[category] = { count: (previous?.count || 0) + 1, firstAtMs: previous?.firstAtMs ?? at, lastAtMs: at };
      if (["completed", "incomplete", "failed"].includes(category)) {
        const details = data?.response?.usage;
        current.providerReasoningReported = Number.isFinite(details?.output_tokens_details?.reasoning_tokens);
        current.rawReasoningTokens = current.providerReasoningReported ? details.output_tokens_details.reasoning_tokens : null;
        current.rawCachedInput = Number.isFinite(details?.input_tokens_details?.cached_tokens) ? details.input_tokens_details.cached_tokens : null;
      }
    });
    pi.on("message_update", event => {
      if (current && event.message.role === "assistant" && ["text_start", "thinking_start", "toolcall_start"].includes(event.assistantMessageEvent.type)) current.normalizedStarts[event.assistantMessageEvent.type] ??= now();
    });
    pi.on("message_end", event => {
      if (!current || event.message.role !== "assistant") return;
      current.endUtc = utc(); current.usage = tokenUsage([event.message]);
      current.reportedCost = Number.isFinite(event.message.usage?.cost?.total) ? event.message.usage.cost.total : null;
      current.wsAfter = safeStats();
      current.wsDelta = current.wsAfter ? Object.fromEntries(COUNTERS.map(key => [key, current.wsAfter[key] === null || (current.wsBefore && current.wsBefore[key] === null) ? null : current.wsAfter[key] - (current.wsBefore?.[key] ?? 0)])) : null;
      const cpu = process.cpuUsage(cpuStart);
      current.clientCpuMs = round((cpu.user + cpu.system) / 1000);
      current.eventLoopLag = { samples: lag.count, maxMs: lag.count ? round(lag.max / 1e6) : null, p99Ms: lag.count ? round(lag.percentile(99) / 1e6) : null };
    });
  }
  return {
    install, observe: base.observe,
    start() { base.start(); started = sampled; lag.enable(); },
    finish() { base.finish(); lag.disable(); },
    snapshot() {
      const result = base.snapshot();
      return { ...result, turns: result.turns.map((turn, i) => ({ ...turn, ...turns[i], parsedToFirstDeltaMs: turn.firstParsedAtMs !== null && turn.firstDeltaAtMs !== null ? round(turn.firstDeltaAtMs - turn.firstParsedAtMs) : null })) };
    },
  };
}
function pairRows(rows) {
  const pairs = new Map();
  for (const row of rows.filter(row => !row.probe)) {
    const key = `${row.trial}:${row.block}:${row.id}`;
    const pair = pairs.get(key) || { trial: row.trial, block: row.block, kind: row.kind, id: row.id };
    pair[row.arm] = row.phases.promptMs; pairs.set(key, pair);
  }
  return [...pairs.values()].filter(row => Number.isFinite(row.direct) && Number.isFinite(row.codemode));
}
function p95Ratio(pairs) {
  if (!pairs.length || !pairs.every(p => Number.isFinite(p.direct) && p.direct > 0 && Number.isFinite(p.codemode) && p.codemode > 0)) return null;
  return percentile(pairs.map(p => p.codemode), .95) / percentile(pairs.map(p => p.direct), .95);
}
function upperBound(pairs, { resamples = 2000, seed = SEED + 2 } = {}) {
  if (p95Ratio(pairs) === null) return null;
  const rng = random(seed), groups = new Map();
  for (const pair of pairs) { const key = `${pair.trial}:${pair.kind}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(pair); }
  const ratios = [];
  for (let i = 0; i < resamples; i++) {
    // Resample matched task clusters, retaining all their time-block repetitions.
    const sample = [];
    for (const group of groups.values()) {
      const ids = [...new Set(group.map(p => p.id))];
      for (let j = 0; j < ids.length; j++) {
        const id = ids[Math.floor(rng() * ids.length)];
        sample.push(...group.filter(p => p.id === id));
      }
    }
    ratios.push(p95Ratio(sample));
  }
  return percentile(ratios, .95);
}
function assessPower(historical, { simulations = 120, resamples = 300 } = {}) {
  const originals = pairRows(historical), rng = random(SEED + 3), groups = new Map();
  for (const pair of originals) { const key = `${pair.trial}:${pair.kind}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(pair); }
  if (originals.length !== 60 || groups.size !== 6) throw new Error("Power assessment requires all frozen60 matched pairs");
  let successes = 0;
  for (let simulation = 0; simulation < simulations; simulation++) {
    const sample = [];
    for (const group of groups.values()) for (let block = 0; block < 3; block++) for (let j = 0; j < 10; j++) {
      const pair = group[Math.floor(rng() * group.length)], swap = rng() < .5;
      sample.push({ ...pair, id: `task-${j}`, block, direct: swap ? pair.codemode : pair.direct, codemode: swap ? pair.direct : pair.codemode });
    }
    const trials = [0, 1].map(trial => p95Ratio(sample.filter(p => p.trial === trial)));
    if (trials.every(r => r <= 1.1) && p95Ratio(sample) <= 1.1 && upperBound(sample, { resamples, seed: SEED + 100 + simulation }) <= 1.1) successes++;
  }
  const estimate = successes / simulations, z = 1.96, denominator = 1 + z * z / simulations;
  const center = (estimate + z * z / (2 * simulations)) / denominator;
  const radius = z * Math.sqrt(estimate * (1 - estimate) / simulations + z * z / (4 * simulations * simulations)) / denominator;
  return { simulations, resamples, seed: SEED + 3, pairs: 180, successes, power: estimate, monteCarlo95: [center - radius, center + radius], target: .8, adequate: estimate >= .8, assumptions: "Planning sensitivity only: frozen paired latency shapes, arms exchangeable under the latency-neutral null;6 future trial/class cells,3 blocks each. Does not estimate actual treatment effect or guarantee field power. Task-cluster percentile bootstrap; fixed cells/time horizon, not a population or arbitrary-time guarantee." };
}
function compare(rows) {
  const result = {};
  for (const arm of ["direct", "codemode", "probe"]) {
    const group = rows.filter(r => r.arm === arm), turns = group.flatMap(r => r.phases.turns);
    result[arm] = { cases: group.length, correct: group.filter(r => r.oracle.ok).length, prompt: describe(group.map(r => r.phases.promptMs)), model: describe(group.map(r => r.phases.modelPipelineMs)), tools: describe(group.map(r => r.phases.topToolWallMs)), codeNonNested: describe(group.map(r => r.phases.codemodeNonNestedMs)), wait: describe(turns.map(t => t.requestToFirstDeltaMs)), parsedGap: describe(turns.map(t => t.parsedToFirstDeltaMs)), afterDelta: describe(turns.map(t => t.firstDeltaToEndMs)), turns: turns.length, cost: group.length && group.every(r => Number.isFinite(r.reportedCost)) ? group.reduce((s, r) => s + r.reportedCost, 0) : null, tokens: Object.fromEntries(["inputIncludingCache", "output", "cacheRead", "uncachedInput", "total"].map(key => [key, group.length && group.every(r => Number.isFinite(r.tokens[key])) ? group.reduce((s,r) => s + r.tokens[key], 0) : null])), longWaits: turns.filter(t => t.requestToFirstDeltaMs >= 10000).length, wsRecoveries: turns.reduce((s,t) => s + (t.wsDelta?.websocketFailures || 0) + (t.wsDelta?.sseFallbacks || 0),0) };
  }
  result.p95Ratio = result.direct.prompt?.p95 > 0 && result.codemode.prompt ? result.codemode.prompt.p95 / result.direct.prompt.p95 : null;
  return result;
}
function acceptanceGates(rows, plan) {
  const expected = new Set(plan.map(p => p.key)), seen = new Set(rows.map(r => r.key));
  const complete = rows.length === plan.length && expected.size === seen.size && [...expected].every(k => seen.has(k));
  const pairs = pairRows(rows), pooled = compare(rows), trials = [0, 1].map(trial => compare(rows.filter(r => r.trial === trial)));
  const quality = complete && rows.every(r => r.oracle.ok && r.integrity && !r.providerError && r.toolFailures === 0);
  const hasContext = row => Number.isFinite(row.phases.contextEstimatedTokens) && row.phases.contextEstimatedTokens > 0;
  const measurement = complete && rows.every(r => r.phases.timingComplete && r.phases.providerTimingComplete && hasContext(r) && r.tokens.totalMatchesSdk && r.phases.turns.every(t => t.usage?.totalMatchesSdk && t.requestUtc && t.endUtc && t.categories.completed));
  const context = arm => {
    const group = rows.filter(r => r.kind !== "simple" && r.arm === arm);
    return group.length && group.every(hasContext) ? group.reduce((sum,r) => sum + r.phases.contextEstimatedTokens,0) : null;
  };
  const directContext = context("direct"), codemodeContext = context("codemode");
  const upper95 = complete ? upperBound(pairs, { resamples: 5000 }) : null;
  const ratios = [pooled, ...trials].map(r => r.p95Ratio);
  const targets = {
    latency: complete && ratios.every(Number.isFinite) ? ratios.every(r => r <= 1.1) : null,
    confidence: complete && Number.isFinite(upper95) ? upper95 <= 1.1 : null,
    composedContext: complete && Number.isFinite(directContext) && directContext > 0 && Number.isFinite(codemodeContext) ? codemodeContext / directContext <= .75 : null,
    cost: complete && pooled.direct.cost > 0 && Number.isFinite(pooled.codemode.cost) ? pooled.codemode.cost / pooled.direct.cost <= 1.1 : null,
  };
  return { complete, quality, measurement, pooled, trials, targets, upper95, supportsLiftingHold: quality && measurement && Object.values(targets).every(v => v === true) };
}
module.exports = { SEED, ANCHORS, COUNTERS, random, schedule, createDecisionMeasurements, pairRows, p95Ratio, upperBound, assessPower, compare, acceptanceGates };
