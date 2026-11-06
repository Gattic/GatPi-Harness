"use strict";

const { createDecisionMeasurements, random } = require("./codemode-decision-benchmark");
const { describe } = require("./codemode-phase-benchmark");
const CELLS = Object.freeze({
  direct: { arm: "direct", transport: "websocket-cached" },
  cached: { arm: "codemode", transport: "websocket-cached" },
  full: { arm: "codemode", transport: "websocket" },
});
const SEED = 20261025, LIMIT = 4096, STALL_MS = 10000;
const round = x => Math.round(x * 1000) / 1000;
const TYPES = new Set([
  "response.create", "response.created", "response.in_progress", "response.output_item.added", "response.output_item.done",
  "response.output_text.delta", "response.output_text.done", "response.content_part.added", "response.content_part.done",
  "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done", "response.reasoning_summary_part.added", "response.reasoning_summary_part.done", "response.reasoning_text.delta",
  "response.completed", "response.done", "response.incomplete", "response.failed", "rate_limits.updated", "error",
]);
const TERMINAL = new Set(["response.completed", "response.done", "response.incomplete", "response.failed", "error"]);
function eventMetadata(data) {
  return {
    tag: TYPES.has(data?.type) ? data.type : "other",
    kind: ["message", "function_call", "custom_tool_call", "reasoning"].includes(data?.item?.type) ? data.item.type : null,
    sequence: Number.isSafeInteger(data?.sequence_number) && data.sequence_number >= 0 ? data.sequence_number : null,
  };
}
function continuationSchedule() {
  const permutations = [["direct","cached","full"],["direct","full","cached"],["cached","direct","full"],["cached","full","direct"],["full","direct","cached"],["full","cached","direct"]];
  // Two complete cycles plus four orders balance cached/full precedence8:8;
  // each cell occupies each position5 or6 times.
  const orders = [...permutations, ...permutations, ...[1,2,3,5].map(i => permutations[i])];
  const rng = random(SEED);
  for (let i = orders.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [orders[i],orders[j]] = [orders[j],orders[i]]; }
  return orders.flatMap((order, block) => order.map((cell, position) => ({ block, position, cell, ...CELLS[cell], id: "codemode-21", kind: "chain", key: `b${String(block).padStart(2,"0")}-${cell}` }))).map((row, ordinal) => ({ ...row, ordinal }));
}

// Owned benchmark process only. Preserve constructor arguments, socket options,
// binaryType, framing and send behavior; never persist message bodies or URLs.
function installRawWebSocketTap({ clock = () => performance.now() } = {}) {
  const Original = globalThis.WebSocket;
  if (typeof Original !== "function") throw new Error("Native WebSocket unavailable");
  let observer = null, sockets = 0, stats = { events: 0, totalMs: 0, maxMs: 0 };
  const socketNumbers = new WeakMap();
  const deliver = frame => { if (observer) observer(frame); };
  function metadata(data) {
    let text;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
    else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    if (text === undefined) return { tag: "unclassified", kind: null, sequence: null, bytes: Number.isFinite(data?.size) ? data.size : null, previousResponse: null };
    try {
      const value = JSON.parse(text);
      return { ...eventMetadata(value), bytes: Buffer.byteLength(text), previousResponse: typeof value.previous_response_id === "string" };
    } catch { return { tag: "invalid-json", kind: null, sequence: null, bytes: Buffer.byteLength(text), previousResponse: null }; }
  }
  function observe(direction, socket, data) {
    if (!observer) return;
    const at = clock();
    const fields = metadata(data);
    deliver({ direction, socket, at, ...fields });
    const elapsed = clock() - at;
    stats.events++; stats.totalMs += elapsed; stats.maxMs = Math.max(stats.maxMs, elapsed);
  }
  class TimedWebSocket extends Original {
    constructor(...args) {
      super(...args);
      const socket = ++sockets;
      socketNumbers.set(this, socket);
      this.addEventListener("message", event => observe("receive", socket, event.data));
    }
    send(data) {
      observe("send", socketNumbers.get(this), data);
      return super.send(data);
    }
  }
  globalThis.WebSocket = TimedWebSocket;
  return {
    watch(callback) {
      if (observer) throw new Error("A raw timing observer is already active");
      observer = callback; stats = { events: 0, totalMs: 0, maxMs: 0 };
      return () => { if (observer !== callback) throw new Error("Raw observer identity drift"); observer = null; };
    },
    stats() { return { events: stats.events, totalMs: round(stats.totalMs), maxMs: round(stats.maxMs) }; },
    restore() {
      if (observer || globalThis.WebSocket !== TimedWebSocket) throw new Error("Cannot restore an active or replaced raw observer");
      globalThis.WebSocket = Original;
    },
  };
}

function createRawMeasurements({ stats, clock = () => performance.now(), limit = LIMIT } = {}) {
  let origin, current, open = false, count = 0, overflow = false, outsideFrames = 0;
  const base = createDecisionMeasurements({ clock: () => { const now = clock(); origin ??= now; return now; }, stats });
  const turns = [];
  const at = value => round(value - origin);
  function append(array, value) { if (count++ < limit) array.push(value); else overflow = true; }
  function install(pi) {
    base.install(pi);
    pi.on("context_with_system", () => { current = { attempts: [], parsed: [], preSendFrames: 0 }; turns.push(current); open = true; });
    pi.on("provider_stream_event", event => {
      if (open) append(current.parsed, { atMs: at(clock()), attempt: current.attempts.length - 1, ...eventMetadata(event.data) });
    });
    pi.on("message_end", event => { if (event.message.role === "assistant") open = false; });
  }
  function raw(frame) {
    if (!open) { outsideFrames++; return; }
    const entry = { atMs: at(frame.at), socket: frame.socket, tag: frame.tag, kind: frame.kind, sequence: frame.sequence, bytes: frame.bytes };
    if (frame.direction === "send") {
      append(current.attempts, { send: { ...entry, previousResponse: frame.previousResponse }, frames: [], trailingFrames: [], terminal: false });
    } else {
      const attempt = current.attempts.at(-1);
      if (!attempt) { current.preSendFrames++; return; }
      append(attempt.terminal ? attempt.trailingFrames : attempt.frames, entry);
      if (TERMINAL.has(entry.tag)) attempt.terminal = true;
    }
  }
  function snapshot() {
    const phases = base.snapshot();
    return { ...phases, rawCapture: { overflow, outsideFrames, entries: count }, turns: phases.turns.map((turn, i) => {
      const trace = turns[i], aligned = trace.attempts.length > 0 && trace.attempts.every((attempt, index) => {
        const parsed = trace.parsed.filter(p => p.attempt === index);
        return attempt.frames.length > 0 && attempt.frames.length === parsed.length && attempt.frames.every((frame,j) => frame.tag === parsed[j].tag && frame.kind === parsed[j].kind && frame.sequence === parsed[j].sequence && frame.tag !== "unclassified" && frame.atMs <= parsed[j].atMs);
      });
      const paired = aligned ? trace.attempts.flatMap((attempt,index) => {
        const parsed = trace.parsed.filter(p => p.attempt === index);
        return attempt.frames.map((frame,j) => ({ ...frame, parsedAtMs: parsed[j].atMs, rawToParsedMs: round(parsed[j].atMs - frame.atMs) }));
      }) : [];
      const first = tag => paired.find(p => p.tag === tag);
      const ack = first("response.in_progress"), item = first("response.output_item.added");
      const parsedAck = trace.parsed.find(p => p.tag === "response.in_progress"), parsedItem = trace.parsed.find(p => p.tag === "response.output_item.added");
      return { ...turn, trace, rawParsedAligned: aligned, rawToParsedMaxMs: paired.length ? Math.max(...paired.map(p=>p.rawToParsedMs)) : null,
        rawAckToItemMs: ack && item ? round(item.atMs - ack.atMs) : null,
        parsedAckToItemMs: parsedAck && parsedItem ? round(parsedItem.atMs - parsedAck.atMs) : null,
        firstItemRawToParsedMs: item?.rawToParsedMs ?? null,
        firstSendToRawAckMs: ack && trace.attempts[0] ? round(ack.atMs - trace.attempts[0].send.atMs) : null,
      };
    }) };
  }
  return { install, raw, observe: base.observe, start: base.start, finish: base.finish, snapshot };
}
function modeObserved(row) {
  const cached = row.transport === "websocket-cached";
  return row.phases.turns.length > 1 && row.phases.turns.every((t,i) => {
    const d = t.wsDelta, sends = t.trace.attempts.map(a => a.send);
    return d && d.requests === sends.length && d.requests >= 1 && d.sseFallbacks === 0 && d.cachedContextRequests === (cached ? d.requests : 0)
      && sends.every(s => s.tag === "response.create")
      && (cached ? (i !== 0 || sends.every(s=>s.previousResponse === false)) : sends.every(s=>s.previousResponse === false));
  }) && (!cached || row.phases.turns.slice(1).some(t=>t.trace.attempts.some(a=>a.send.previousResponse)));

}
function caseStall(row) {
  const turns = row.phases.turns.slice(1);
  return turns.length && turns.every(t => Number.isFinite(t.parsedAckToItemMs)) ? turns.some(t=>t.parsedAckToItemMs > STALL_MS) : null;
}
function pairedExact(positive, negative) {
  const n = positive + negative;
  if (!n) return 1;
  let coefficient = 1, sum = 0;
  for (let k = 0; k <= n; k++) { if (k >= positive) sum += coefficient / 2 ** n; coefficient = coefficient * (n-k) / (k+1); }
  return sum;
}
function summarizeContinuation(rows, plan = continuationSchedule()) {
  const expected = new Set(plan.map(p=>p.key)), keys = new Set(rows.map(r=>r.key));
  const complete = rows.length === plan.length && keys.size === expected.size && [...expected].every(k=>keys.has(k));
  const groups = {};
  for (const cell of Object.keys(CELLS)) {
    const selected = rows.filter(r=>r.cell === cell), turns = selected.flatMap(r=>r.phases.turns);
    groups[cell] = { cases: selected.length, correct: selected.filter(r=>r.oracle.ok).length, stalls: selected.filter(r=>caseStall(r)===true).length, unknown: selected.filter(r=>caseStall(r)===null).length,
      prompt: describe(selected.map(r=>r.phases.promptMs)), model: describe(selected.map(r=>r.phases.modelPipelineMs)), codeOuter: describe(selected.map(r=>r.phases.codemodeWallMs)),
      ackToItem: describe(turns.map(t=>t.parsedAckToItemMs)), rawAckToItem: describe(turns.map(t=>t.rawAckToItemMs)), rawToParsedMax: describe(turns.map(t=>t.rawToParsedMaxMs)),
      cost: selected.length && selected.every(r=>Number.isFinite(r.reportedCost)) ? selected.reduce((n,r)=>n+r.reportedCost,0) : null,
      modelTurns: selected.reduce((n,r)=>n+r.modelTurns,0), reads: selected.reduce((n,r)=>n+r.underlyingToolAttempts,0),
    };
  }
  let positive=0, negative=0;
  for (let block=0; block<16; block++) {
    const cached=rows.find(r=>r.block===block&&r.cell==="cached"),full=rows.find(r=>r.block===block&&r.cell==="full");
    if (!cached||!full) continue;
    const a=caseStall(cached),b=caseStall(full);
    if(a===true&&b===false)positive++;
    if(a===false&&b===true)negative++;
  }
  const quality=complete&&rows.every(r=>r.oracle.ok&&r.integrity&&!r.providerError&&!r.toolFailures);
  const measurement=complete&&rows.every(r=>r.tokens.totalMatchesSdk&&r.phases.timingComplete&&r.phases.providerTimingComplete&&!r.phases.rawCapture.overflow&&r.phases.turns.every(t=>t.rawParsedAligned&&Number.isFinite(t.rawAckToItemMs)&&t.usage.totalMatchesSdk));
  const manipulation=complete&&rows.every(modeObserved);
  const p=complete&&quality&&measurement&&manipulation&&rows.every(r=>caseStall(r)!==null)?pairedExact(positive,negative):null;
  return { complete, quality, measurement, manipulation, groups, primary:{positive,negative,p,alpha:.05,evidenceForContinuationReduction:p!==null&&p<=.05&&positive>negative},supportsLiftingHold:false,limitations:["One synthetic chain task; no full-profile p95 acceptance claim", "First raw frame receipt is a JS listener, not physical packet arrival or server timing", "First output item can be reasoning; retain item kind and all secondary intervals", "Unknown model/server/network work remains unknown; no raw payload content retained"] };
}
module.exports={CELLS,SEED,LIMIT,STALL_MS,eventMetadata,continuationSchedule,installRawWebSocketTap,createRawMeasurements,modeObserved,caseStall,pairedExact,summarizeContinuation};
