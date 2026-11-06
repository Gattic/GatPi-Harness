"use strict";

const { MANIFEST, percentile } = require("./codemode-benchmark");

// New observations of the same tasks, not continuations/replacements of frozen cases.
const TRIALS = 2;
const TOTAL_CASES = MANIFEST.length * TRIALS * 2;
const round = value => Math.round(value * 1000) / 1000;
function intervalMs(intervals) {
  const sorted = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start).sort((a, b) => a[0] - b[0]);
  let total = 0, start, end;
  for (const [left, right] of sorted) {
    if (start === undefined) { start = left; end = right; }
    else if (left <= end) end = Math.max(end, right);
    else { total += end - start; start = left; end = right; }
  }
  return round(total + (start === undefined ? 0 : end - start));
}
function tokenUsage(messages) {
  const usages = messages.map(message => message.usage);
  const sum = key => usages.length && usages.every(usage => Number.isFinite(usage?.[key]) && usage[key] >= 0) ? usages.reduce((total, usage) => total + usage[key], 0) : null;
  const input = sum("input"), output = sum("output"), cacheRead = sum("cacheRead"), cacheWrite = sum("cacheWrite"), reasoning = sum("reasoning");
  const inputIncludingCache = [input, cacheRead, cacheWrite].every(Number.isFinite) ? input + cacheRead + cacheWrite : null;
  const total = inputIncludingCache !== null && output !== null ? inputIncludingCache + output : null;
  const sdkTotal = sum("totalTokens");
  return { uncachedInput: input, cacheRead, cacheWrite, inputIncludingCache, output, reasoning, nonReasoningOutput: reasoning !== null && output !== null && reasoning <= output ? output - reasoning : null, total, sdkTotal, totalMatchesSdk: total !== null && sdkTotal !== null ? total === sdkTotal : null };
}

function createPhaseMeasurements(clock = () => performance.now()) {
  const turns = [], tools = [], openTools = new Map(), toolsById = new Map();
  let current, started, finished, contextEstimatedTokens = 0, providerPayloadEstimatedTokens = 0, payloadSamples = 0;
  const now = () => round(clock() - started);
  function install(pi) {
    pi.on("context_with_system", event => {
      current = { index: turns.length, contextAtMs: now(), requestAtMs: null, responseAtMs: null, firstParsedAtMs: null, firstDeltaAtMs: null, endAtMs: null, requestCount: 0, responseCount: 0 };
      turns.push(current);
      contextEstimatedTokens += Math.ceil(JSON.stringify(event.messages).length / 4);
    });
    pi.on("before_provider_request", event => {
      if (current) { current.requestAtMs ??= now(); current.requestCount++; }
      providerPayloadEstimatedTokens += Math.ceil(JSON.stringify(event.payload).length / 4);
      payloadSamples++;
    });
    pi.on("after_provider_response", () => { if (current) { current.responseAtMs ??= now(); current.responseCount++; } });
    // Observe timestamps only: never retain headers, payloads or stream contents.
    pi.on("provider_stream_event", () => { if (current) current.firstParsedAtMs ??= now(); });
    pi.on("message_update", event => {
      if (current && event.message.role === "assistant" && /^(text_delta|thinking_delta|toolcall_delta)$/.test(event.assistantMessageEvent.type)) current.firstDeltaAtMs ??= now();
    });
    pi.on("message_end", event => { if (current && event.message.role === "assistant") current.endAtMs = now(); });
  }
  function observe(event) {
    if (event.type === "tool_execution_start") {
      const row = { index: tools.length, name: event.toolName, nested: Boolean(event.parentToolCallId), parentIndex: event.parentToolCallId ? toolsById.get(event.parentToolCallId)?.index ?? null : null, startMs: now(), endMs: null, executeMs: null, isError: null };
      tools.push(row); openTools.set(event.toolCallId, row); toolsById.set(event.toolCallId, row);
    } else if (event.type === "tool_execution_end") {
      const row = openTools.get(event.toolCallId);
      if (row) { row.endMs = now(); row.executeMs = Number.isFinite(event.durationMs) ? round(event.durationMs) : null; row.isError = event.isError; openTools.delete(event.toolCallId); }
    }
  }
  function snapshot() {
    if (finished === undefined) throw new Error("Finish phase measurement before snapshot");
    const duration = row => row.endMs === null ? null : round(row.endMs - row.startMs);
    const intervals = rows => rows.filter(row => row.endMs !== null).map(row => [row.startMs, row.endMs]);
    const models = turns.filter(turn => turn.endAtMs !== null).map(turn => [turn.contextAtMs, turn.endAtMs]);
    const top = tools.filter(tool => !tool.nested), nested = tools.filter(tool => tool.nested), code = top.filter(tool => tool.name === "codemode");
    const modelPipelineMs = intervalMs(models), topToolWallMs = intervalMs(intervals(top)), covered = intervalMs([...models, ...intervals(top)]);
    const difference = (row, left, right) => row[left] !== null && row[right] !== null ? round(row[right] - row[left]) : null;
    const sumComplete = values => values.length && values.every(Number.isFinite) ? round(values.reduce((a, b) => a + b, 0)) : null;
    const phaseTurns = turns.map(turn => ({ ...turn, contextToRequestMs: difference(turn, "contextAtMs", "requestAtMs"), requestToResponseMs: difference(turn, "requestAtMs", "responseAtMs"), requestToFirstDeltaMs: difference(turn, "requestAtMs", "firstDeltaAtMs"), firstDeltaToEndMs: difference(turn, "firstDeltaAtMs", "endAtMs"), modelPipelineMs: difference(turn, "contextAtMs", "endAtMs") }));
    const codePhases = code.map(parent => {
      const children = nested.filter(child => child.parentIndex === parent.index && child.endMs !== null);
      const childWallMs = intervalMs(intervals(children));
      return { startMs: parent.startMs, endMs: parent.endMs, wallMs: duration(parent), nestedWallMs: childWallMs, nonNestedMs: duration(parent) === null ? null : round(duration(parent) - childWallMs), beforeFirstNestedMs: children.length ? round(Math.min(...children.map(child => child.startMs)) - parent.startMs) : null, afterLastNestedMs: children.length ? round(parent.endMs - Math.max(...children.map(child => child.endMs))) : null };
    });
    return {
      promptMs: round(finished - started), modelPipelineMs, topToolWallMs,
      otherHarnessMs: round(finished - started - covered), phaseOverlapMs: round(modelPipelineMs + topToolWallMs - covered),
      contextToRequestMs: sumComplete(phaseTurns.map(turn => turn.contextToRequestMs)), requestToResponseMs: sumComplete(phaseTurns.map(turn => turn.requestToResponseMs)), requestToFirstDeltaMs: sumComplete(phaseTurns.map(turn => turn.requestToFirstDeltaMs)), firstDeltaToEndMs: sumComplete(phaseTurns.map(turn => turn.firstDeltaToEndMs)),
      codemodeWallMs: intervalMs(intervals(code)), nestedToolWallMs: intervalMs(intervals(nested)), codemodeNonNestedMs: round(intervalMs([...intervals(code), ...intervals(nested)]) - intervalMs(intervals(nested))),
      timingComplete: turns.length > 0 && turns.every(turn => turn.endAtMs !== null) && openTools.size === 0,
      providerTimingComplete: phaseTurns.length > 0 && phaseTurns.every(turn => turn.requestAtMs !== null && turn.firstDeltaAtMs !== null),
      contextEstimatedTokens, providerPayloadEstimatedTokens: payloadSamples ? providerPayloadEstimatedTokens : null, payloadSamples,
      turns: phaseTurns, tools: tools.map(tool => ({ ...tool, pipelineMs: duration(tool) })), codePhases,
    };
  }
  return { install, observe, start() { if (started !== undefined) throw new Error("Measurement already started"); started = clock(); }, finish() { finished = clock(); }, snapshot };
}

function armOrder(taskIndex, trial) { return (taskIndex + trial) % 2 ? ["codemode", "direct"] : ["direct", "codemode"]; }
function trialTasks(trial) {
  // Rotate strata in the second trial instead of putting every batch later in time.
  return [...MANIFEST.slice(trial ? 10 : 0), ...MANIFEST.slice(0, trial ? 10 : 0)];
}
function describe(values) {
  return values.length && values.every(Number.isFinite) ? { total: round(values.reduce((a, b) => a + b, 0)), mean: round(values.reduce((a, b) => a + b, 0) / values.length), median: percentile(values, .5), p95: percentile(values, .95) } : null;
}
function summarizePhases(rows) {
  const expected = new Set(Array.from({ length: TRIALS }, (_, trial) => MANIFEST.flatMap(task => ["direct", "codemode"].map(arm => `${trial}:${task.id}:${arm}`))).flat());
  const seen = new Set(rows.map(row => `${row.trial}:${row.id}:${row.arm}`));
  const complete = rows.length === TOTAL_CASES && seen.size === expected.size && [...seen].every(key => expected.has(key));
  const quality = complete && rows.every(row => row.oracle.ok && row.integrity && !row.providerError && row.toolFailures === 0);
  function compare(selected) {
    const arms = {};
    for (const arm of ["direct", "codemode"]) {
      const group = selected.filter(row => row.arm === arm);
      const values = getter => group.map(getter);
      const costs = values(row => row.reportedCost);
      const tokenKeys = ["uncachedInput", "cacheRead", "cacheWrite", "inputIncludingCache", "output", "reasoning", "nonReasoningOutput", "total", "sdkTotal"];
      arms[arm] = { cases: group.length, correct: group.filter(row => row.oracle.ok).length, modelTurns: group.reduce((n, row) => n + row.modelTurns, 0), underlyingToolAttempts: group.reduce((n, row) => n + row.underlyingToolAttempts, 0), generatedCodeChars: group.reduce((n, row) => n + row.generatedCodeChars, 0), timings: {}, tokens: Object.fromEntries(tokenKeys.map(key => [key, describe(values(row => row.tokens[key]))?.total ?? null])), contextEstimatedTokens: describe(values(row => row.phases.contextEstimatedTokens))?.total ?? null, reportedCost: costs.length && costs.every(value => Number.isFinite(value) && value >= 0) ? costs.reduce((sum, value) => sum + value, 0) : null };
      for (const key of ["promptMs", "modelPipelineMs", "topToolWallMs", "otherHarnessMs", "contextToRequestMs", "requestToResponseMs", "requestToFirstDeltaMs", "firstDeltaToEndMs", "codemodeWallMs", "nestedToolWallMs", "codemodeNonNestedMs"]) arms[arm].timings[key] = describe(values(row => row.phases[key]));
      arms[arm].timings.setupMs = describe(values(row => row.setupMs));
      arms[arm].timings.postprocessMs = describe(values(row => row.postprocessMs));
      arms[arm].timings.legacyComparableWallMs = describe(values(row => row.phases.promptMs + row.postprocessMs));
      arms[arm].slowest = [...group].sort((a, b) => b.phases.promptMs - a.phases.promptMs).slice(0, 3).map(row => ({ id: row.id, trial: row.trial, promptMs: row.phases.promptMs, modelPipelineMs: row.phases.modelPipelineMs, topToolWallMs: row.phases.topToolWallMs, codemodeNonNestedMs: row.phases.codemodeNonNestedMs, modelTurns: row.modelTurns }));
    }
    const ratio = (left, right) => Number.isFinite(left) && left > 0 && Number.isFinite(right) ? right / left : null;
    const deltas = Object.fromEntries(Object.keys(arms.direct.tokens).map(key => {
      const direct = arms.direct.tokens[key], code = arms.codemode.tokens[key];
      return [key, Number.isFinite(direct) && Number.isFinite(code) ? { direct, codemode: code, difference: code - direct, ratio: ratio(direct, code) } : null];
    }));
    return { ...arms, promptP95Ratio: ratio(arms.direct.timings.promptMs?.p95, arms.codemode.timings.promptMs?.p95), legacyP95Ratio: ratio(arms.direct.timings.legacyComparableWallMs?.p95, arms.codemode.timings.legacyComparableWallMs?.p95), costRatio: ratio(arms.direct.reportedCost, arms.codemode.reportedCost), contextRatio: ratio(arms.direct.contextEstimatedTokens, arms.codemode.contextEstimatedTokens), tokenDifferences: deltas };
  }
  const pooled = compare(rows), trials = Array.from({ length: TRIALS }, (_, trial) => compare(rows.filter(row => row.trial === trial)));
  const strata = Object.fromEntries(["simple", "batch", "chain"].map(kind => [kind, compare(rows.filter(row => row.kind === kind))]));
  const composed = compare(rows.filter(row => row.kind !== "simple"));
  const timingComplete = complete && rows.every(row => row.phases.timingComplete && row.phases.providerTimingComplete);
  const tokensComplete = complete && rows.every(row => row.tokens.total !== null && row.tokens.totalMatchesSdk === true);
  const allKnown = values => values.every(Number.isFinite);
  const latencyRatios = [pooled, ...trials].map(row => row.promptP95Ratio);
  const targets = { latency: complete && allKnown(latencyRatios) ? latencyRatios.every(ratio => ratio <= 1.1) : null, composedContext: complete && composed.contextRatio !== null ? composed.contextRatio <= .75 : null, cost: complete && pooled.costRatio !== null ? pooled.costRatio <= 1.1 : null };
  return { complete, quality, timingComplete, tokensComplete, executedCases: rows.length, unrunCases: TOTAL_CASES - rows.length, pooled, trials, strata, composed, targets, supportsBoundedMerge: quality && timingComplete && tokensComplete && Object.values(targets).every(value => value === true), limitations: ["Observational phase attribution, not a causal VM/model ablation", "CodeMode non-nested time includes startup, JS, discovery, serialization and hooks; it is not pure VM time", "Provider wait/stream timing includes transport and server work; no private reasoning is captured", "Reasoning tokens are already included in output, never added twice", "Two repetitions of three task templates do not establish field or population noninferiority"] };
}

module.exports = { TRIALS, TOTAL_CASES, intervalMs, tokenUsage, createPhaseMeasurements, armOrder, trialTasks, describe, summarizePhases };
