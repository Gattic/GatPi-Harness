"use strict";

const { MANIFEST, digest } = require("./codemode-benchmark");
const { random } = require("./codemode-decision-benchmark");
const { CODEMODE_LIMITS } = require("./codemode-policy");

const GUIDELINE = "For deterministic read-only dependencies, follow the chain inside one CodeMode call. Keep intermediate collections inside the script; return only requested fields and source paths.";
const LIMITS = Object.freeze({
  costUsd: .50, totalTokens: 320000, outputTokens: 32768,
  inputPerAttempt: 16384, outputPerAttempt: 4096, attemptsPerSession: 8, attempts: 256,
  campaignMs: 600000, sessionMs: 120000, newMetadataBytes: 1048576,
  sharedEvidenceBytes: 67108864, fixtureBytes: 134217728,
});
const SEED = 20261031;
// Integer picodollars avoid cumulative floating-point under-reservation.
const PICO = 1e12;
const PRICE_CEILINGS = Object.freeze({ input: 2, cacheRead: 2, cacheWrite: 2, output: 10 });
const COST_TOLERANCE = 16 * Number.EPSILON;
const USAGE_KEYS = ["input", "cacheRead", "cacheWrite", "output", "totalTokens"];
const RESERVATION = Object.freeze({
  totalTokens: LIMITS.inputPerAttempt + LIMITS.outputPerAttempt, outputTokens: LIMITS.outputPerAttempt,
  // Settlement accepts floating-point cost drift and rounds up to picodollars.
  costPico: (LIMITS.inputPerAttempt * Math.max(PRICE_CEILINGS.input, PRICE_CEILINGS.cacheRead, PRICE_CEILINGS.cacheWrite)
    + LIMITS.outputPerAttempt * PRICE_CEILINGS.output) * (PICO / 1e6) + Math.ceil(COST_TOLERANCE * PICO),
});
const count = n => Number.isSafeInteger(n) && n >= 0;
const positive = n => Number.isFinite(n) && n > 0;
const bool = x => typeof x === "boolean";
const sha = x => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const CODES = new Set(["STOPPED", "CLOCK_INVALID", "CAMPAIGN_TIMEOUT", "SESSION_TIMEOUT", "SESSION_STATE", "ATTEMPT_STATE", "INPUT_BOUND", "OUTPUT_LIMIT", "ATTEMPT_LIMIT", "TOKEN_BUDGET", "OUTPUT_BUDGET", "COST_BUDGET", "USAGE_UNAVAILABLE", "USAGE_INVALID", "INPUT_BOUND_BREACH", "OUTPUT_BOUND_BREACH", "COST_MISMATCH", "MEASUREMENT_INCOMPLETE", "QUALITY_FAILED", "PROVIDER_FAILED", "STORAGE_BOUND"]);
function failure(code) { return Object.assign(new Error(code), { code }); }

function pilotSchedule() {
  const selected = new Set([1,2,3,4,11,12,13,14,15,16,21,22,23,24,25,26]);
  const tasks = MANIFEST.filter(task => selected.has(task.seed)), rng = random(SEED);
  for (let i = tasks.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1)); [tasks[i], tasks[j]] = [tasks[j], tasks[i]];
  }
  return Object.freeze(tasks.flatMap(task => (task.seed % 2 ? ["control", "treatment"] : ["treatment", "control"])
    .map(arm => ({ ...task, arm, key: `${task.id}-${arm}` })))
    .map((row, ordinal) => Object.freeze({ ...row, ordinal })));
}
function pilotProtocol() {
  return {
    version: 2, offlineOnly: true, liveAuthorized: false, hold: true, seed: SEED,
    model: { provider: "openai-codex", id: "gpt-6.1-sol", thinking: "xhigh", transport: "websocket-cached", codemode: "on" },
    guideline: GUIDELINE, plan: pilotSchedule(), limits: LIMITS, prices: PRICE_CEILINGS,
    reservation: { ...RESERVATION, costUsd: RESERVATION.costPico / PICO },
    nativeLimits: { ...CODEMODE_LIMITS, heapMiB: 256 },
    liveBlockers: ["Paid execution is not authorized", "No qualified exact input bound or pre-wire admission for every native recovery/fallback", "No qualified hard output-token limit for the installed Codex adapter"],
  };
}
function withPilotGuideline(definition, arm) {
  if (!["control", "treatment"].includes(arm) || definition.name !== "codemode" || (definition.promptGuidelines || []).includes(GUIDELINE)) throw failure("SESSION_STATE");
  return arm === "control" ? definition : { ...definition, promptGuidelines: [...(definition.promptGuidelines || []), GUIDELINE] };
}
function checkStorage(sizes) {
  for (const key of ["newMetadataBytes", "sharedEvidenceBytes", "fixtureBytes"]) {
    if (!count(sizes?.[key]) || sizes[key] > LIMITS[key]) throw failure("STORAGE_BOUND");
  }
}
function validPrices(prices) {
  return Boolean(prices) && Object.entries(PRICE_CEILINGS).every(([key, cap]) => Number.isFinite(prices[key]) && prices[key] >= 0 && prices[key] <= cap);
}
function normalizedUsage(usage) {
  if (!usage || !USAGE_KEYS.every(key => count(usage[key]))) throw failure("USAGE_UNAVAILABLE");
  const input = usage.input + usage.cacheRead + usage.cacheWrite, total = input + usage.output;
  if (!count(input) || !count(total) || total !== usage.totalTokens || (usage.reasoning !== undefined && (!count(usage.reasoning) || usage.reasoning > usage.output))) throw failure("USAGE_INVALID");
  const cost = usage.cost?.total;
  if (!Number.isFinite(cost) || cost < 0 || !Number.isSafeInteger(Math.ceil(cost * PICO))) throw failure("USAGE_UNAVAILABLE");
  return { input, output: usage.output, total, cost };
}

function catalogCost(usage, prices) {
  return ["input", "cacheRead", "cacheWrite", "output"].reduce((sum, key) => sum + usage[key] * prices[key] / 1e6, 0);
}
function consistentCost(actual, expected, attempts = 1) {
  return expected === 0 ? actual === 0 : Math.abs(actual - expected) <= COST_TOLERANCE * attempts;
}
function copyUsage(usage) { return { ...usage, cost: { total: usage.cost.total } }; }
function emptyUsage() { return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, reasoning: 0, cost: { total: 0 } }; }
function reconciledRow(row, prices) {
  try {
    const u = normalizedUsage(row.usage);
    return u.total === row.tokens && u.output === row.outputTokens && u.cost === row.reportedCost
      && u.input <= row.attempts * LIMITS.inputPerAttempt
      && consistentCost(u.cost, catalogCost(row.usage, prices), row.attempts);
  } catch { return false; }
}
function serialTimeline(rows) {
  return rows.every((row, i) => {
    const previous = i ? rows[i - 1].campaignElapsedMs : 0;
    // Only arithmetic roundoff, not a latency allowance or discarded tail.
    const roundoff = 4 * Number.EPSILON * Math.max(1, row.campaignElapsedMs, previous, row.promptMs);
    return row.campaignElapsedMs - previous + roundoff >= row.promptMs;
  });
}

class PilotBudget {
  #clock; #last = -Infinity; #started = null; #session = null; #pending = null;
  #next = 0; #attempts = 0; #tokens = 0; #output = 0; #costPico = 0; #reported = 0;
  #stopped = null; #rows = []; #prices; #plan = pilotSchedule(); #abort = new AbortController();
  constructor({ clock = () => performance.now(), prices } = {}) {
    if (!validPrices(prices)) throw failure("COST_BUDGET");
    if (typeof clock !== "function") throw failure("CLOCK_INVALID");
    this.#clock = clock; this.#prices = { ...prices };
  }
  get signal() { return this.#abort.signal; }
  #now() {
    const at = this.#clock();
    if (!Number.isFinite(at) || at < this.#last) throw this.stop("CLOCK_INVALID");
    this.#last = at; return at;
  }
  stop(code) {
    this.#stopped ||= CODES.has(code) ? code : "STOPPED";
    this.#abort.abort(this.#stopped);
    return failure(this.#stopped);
  }
  check() {
    if (this.#stopped) throw failure(this.#stopped);
    const now = this.#now();
    if (this.#started !== null && now - this.#started >= LIMITS.campaignMs) throw this.stop("CAMPAIGN_TIMEOUT");
    if (this.#session && now - this.#session.started >= LIMITS.sessionMs) throw this.stop("SESSION_TIMEOUT");
    return now;
  }
  begin(key) {
    const now = this.check(), expected = this.#plan[this.#next];
    if (!expected || this.#session || this.#pending || key !== expected.key) throw this.stop("SESSION_STATE");
    this.#session = { ...expected, started: now, promptStarted: null, attempts: 0, usage: emptyUsage() };
  }
  admit({ inputUpperBound, maxOutputTokens } = {}) {
    const now = this.check();
    if (!this.#session || this.#pending) throw this.stop("ATTEMPT_STATE");
    if (!count(inputUpperBound) || inputUpperBound > LIMITS.inputPerAttempt) throw this.stop("INPUT_BOUND");
    if (maxOutputTokens !== LIMITS.outputPerAttempt) throw this.stop("OUTPUT_LIMIT");
    if (this.#session.attempts >= LIMITS.attemptsPerSession || this.#attempts >= LIMITS.attempts) throw this.stop("ATTEMPT_LIMIT");
    if (this.#tokens + RESERVATION.totalTokens > LIMITS.totalTokens) throw this.stop("TOKEN_BUDGET");
    if (this.#output + RESERVATION.outputTokens > LIMITS.outputTokens) throw this.stop("OUTPUT_BUDGET");
    if (this.#costPico + RESERVATION.costPico > LIMITS.costUsd * PICO) throw this.stop("COST_BUDGET");
    this.#started ??= now; this.#session.promptStarted ??= now;
    this.#session.attempts++; this.#attempts++;
    this.#pending = { ticket: this.#attempts, inputUpperBound };
    return this.#attempts;
  }
  remainingMs() {
    const now = this.check();
    if (!this.#session) throw this.stop("SESSION_STATE");
    return Math.min(LIMITS.sessionMs - (now - this.#session.started), this.#started === null ? Infinity : LIMITS.campaignMs - (now - this.#started));
  }
  settle(ticket, usage) {
    if (!this.#pending || ticket !== this.#pending.ticket) throw this.stop("ATTEMPT_STATE");
    let normalized;
    try { normalized = normalizedUsage(usage); } catch (error) { throw this.stop(error.code); }
    const expectedCost = catalogCost(usage, this.#prices);
    const bound = this.#pending.inputUpperBound;
    // Debit known usage even when it arrives after an abort or violates a bound.
    this.#tokens += normalized.total; this.#output += normalized.output;
    for (const key of USAGE_KEYS) this.#session.usage[key] += usage[key];
    this.#session.usage.reasoning = this.#session.usage.reasoning === undefined || usage.reasoning === undefined ? undefined : this.#session.usage.reasoning + usage.reasoning;
    this.#reported += normalized.cost; this.#session.usage.cost.total += normalized.cost;
    this.#costPico += Math.ceil(Math.max(normalized.cost, expectedCost) * PICO);
    this.#pending = null;
    if (normalized.input > bound) throw this.stop("INPUT_BOUND_BREACH");
    if (normalized.output > LIMITS.outputPerAttempt) throw this.stop("OUTPUT_BOUND_BREACH");
    if (!consistentCost(normalized.cost, expectedCost)) throw this.stop("COST_MISMATCH");
    if (this.#costPico > LIMITS.costUsd * PICO) throw this.stop("COST_BUDGET");
    if (this.#tokens > LIMITS.totalTokens) throw this.stop("TOKEN_BUDGET");
    if (this.#output > LIMITS.outputTokens) throw this.stop("OUTPUT_BUDGET");
    this.check();
  }
  end(metrics = {}) {
    const now = this.check(), s = this.#session;
    if (!s || this.#pending || !s.attempts) throw this.stop("SESSION_STATE");
    const row = {
      key: s.key, id: s.id, kind: s.kind, arm: s.arm, ordinal: s.ordinal,
      fixtureDigest: sha(metrics.fixtureDigest) ? metrics.fixtureDigest : null,
      oracleOk: metrics.oracleOk === true, integrity: metrics.integrity === true,
      providerError: metrics.providerError !== false,
      toolFailures: count(metrics.toolFailures) ? metrics.toolFailures : null,
      authorityViolations: count(metrics.authorityViolations) ? metrics.authorityViolations : null,
      modelTurns: count(metrics.modelTurns) && metrics.modelTurns > 0 && metrics.modelTurns <= s.attempts ? metrics.modelTurns : null,
      reads: count(metrics.reads) ? metrics.reads : null, toolCalls: count(metrics.toolCalls) ? metrics.toolCalls : null,
      spills: count(metrics.spills) ? metrics.spills : null,
      promptMs: now - s.promptStarted, campaignElapsedMs: now - this.#started,
      usage: Object.freeze({ ...s.usage, cost: Object.freeze({ total: s.usage.cost.total }) }),
      reportedCost: s.usage.cost.total, attempts: s.attempts, tokens: s.usage.totalTokens, outputTokens: s.usage.output,
      measurementComplete: ["oracleOk", "integrity", "providerError"].every(key => bool(metrics[key])),
    };
    row.measurementComplete &&= row.fixtureDigest !== null && [row.toolFailures, row.authorityViolations, row.modelTurns, row.reads, row.toolCalls, row.spills].every(count) && positive(row.promptMs) && row.reads <= row.toolCalls;
    this.#rows.push(Object.freeze(row)); this.#next++; this.#session = null;
    if (!row.measurementComplete) throw this.stop("MEASUREMENT_INCOMPLETE");
    if (!row.oracleOk || !row.integrity || row.providerError || row.toolFailures || row.authorityViolations) throw this.stop("QUALITY_FAILED");
    return row;
  }
  snapshot() {
    const held = this.#pending ? RESERVATION : { totalTokens: 0, outputTokens: 0, costPico: 0 };
    return {
      version: 2, prices: { ...this.#prices },
      stopped: this.#stopped, attempts: this.#attempts, sessionsAssigned: this.#next + (this.#session ? 1 : 0),
      settledTokens: this.#tokens, settledOutputTokens: this.#output,
      chargedUpperUsd: this.#costPico / PICO, reportedCost: this.#reported,
      heldTokens: held.totalTokens, heldOutputTokens: held.outputTokens, heldCostUsd: held.costPico / PICO,
      pending: Boolean(this.#pending), activeKey: this.#session?.key ?? null,
      rows: this.#rows.map(row => ({ ...row, usage: copyUsage(row.usage) })),
    };
  }
}

async function timedOperation(budget, invoke, timers) {
  let timer, aborted;
  const expired = new Promise((_, reject) => {
    aborted = () => reject(failure(budget.signal.reason));
    budget.signal.addEventListener("abort", aborted, { once: true });
    try {
      timer = timers.set(() => {
        let error;
        try { budget.check(); } catch (failure) { error = failure; }
        reject(error || budget.stop("SESSION_TIMEOUT"));
      }, budget.remainingMs());
    } catch { reject(budget.stop("PROVIDER_FAILED")); }
  });
  // Always attach both promises, even if deadline setup already stopped us.
  const work = Promise.resolve().then(() => { budget.check(); return invoke({ signal: budget.signal }); });
  try { return await Promise.race([work, expired]); }
  catch { throw budget.stop("PROVIDER_FAILED"); }
  finally { timers.clear(timer); budget.signal.removeEventListener("abort", aborted); }
}
async function runAttempt(budget, request, invoke, timers = { set: setTimeout, clear: clearTimeout }) {
  const ticket = budget.admit(request);
  // Keep this completion handler attached after timeout so late usage is debited.
  return timedOperation(budget, async context => budget.settle(ticket, await invoke({ ...context, maxOutputTokens: LIMITS.outputPerAttempt })), timers);
}
async function runSession(budget, key, invoke, timers = { set: setTimeout, clear: clearTimeout }) {
  budget.begin(key);
  // This deadline spans tool work and gaps between provider attempts as well.
  return timedOperation(budget, async context => budget.end(await invoke(context)), timers);
}

function summarizePilot(ledger) {
  const rows = Array.isArray(ledger?.rows) ? ledger.rows : [], stopped = ledger?.stopped;
  const plan = pilotSchedule(), sumAll = key => rows.reduce((n, row) => n + row[key], 0);
  const complete = ledger?.version === 2 && rows.length === plan.length && rows.every((row, i) => row && ["key", "id", "kind", "arm", "ordinal"].every(k => row[k] === plan[i][k]));
  const pairs = plan.filter(row => row.arm === "control").map(p => ({ control: rows.find(r => r?.id === p.id && r.arm === "control"), treatment: rows.find(r => r?.id === p.id && r.arm === "treatment") }));
  const measurement = complete && validPrices(ledger.prices) && rows.every(r => r.measurementComplete === true && sha(r.fixtureDigest) && positive(r.promptMs) && Number.isFinite(r.reportedCost) && r.reportedCost >= 0 && [r.modelTurns, r.reads, r.toolCalls, r.spills, r.toolFailures, r.authorityViolations, r.attempts, r.tokens, r.outputTokens].every(count)
      && r.modelTurns > 0 && r.modelTurns <= r.attempts && r.attempts <= LIMITS.attemptsPerSession && r.reads <= r.toolCalls
      && r.outputTokens <= r.tokens && r.tokens <= r.attempts * RESERVATION.totalTokens && r.outputTokens <= r.attempts * LIMITS.outputPerAttempt
      && r.promptMs < LIMITS.sessionMs && Number.isFinite(r.campaignElapsedMs) && r.campaignElapsedMs >= 0 && r.campaignElapsedMs < LIMITS.campaignMs
      && reconciledRow(r, ledger.prices))
    && serialTimeline(rows)
    && ["attempts", "tokens", "outputTokens", "reportedCost"].every(key => sumAll(key) <= ({ attempts: LIMITS.attempts, tokens: LIMITS.totalTokens, outputTokens: LIMITS.outputTokens, reportedCost: LIMITS.costUsd })[key])
    && ledger.attempts === sumAll("attempts") && ledger.sessionsAssigned === plan.length
    && ledger.settledTokens === sumAll("tokens") && ledger.settledOutputTokens === sumAll("outputTokens")
    && Number.isFinite(ledger.reportedCost) && ledger.reportedCost >= 0 && Math.abs(ledger.reportedCost - sumAll("reportedCost")) <= COST_TOLERANCE * ledger.attempts
    && Number.isFinite(ledger.chargedUpperUsd) && ledger.chargedUpperUsd >= 0 && ledger.chargedUpperUsd + COST_TOLERANCE * ledger.attempts >= ledger.reportedCost && ledger.chargedUpperUsd <= LIMITS.costUsd
    && ledger.pending === false && ledger.activeKey === null && ledger.heldTokens === 0 && ledger.heldOutputTokens === 0 && ledger.heldCostUsd === 0
    && (stopped === null || CODES.has(stopped))
    && pairs.every(p => p.control.fixtureDigest === p.treatment.fixtureDigest);
  const quality = complete && rows.every(r => r.oracleOk === true && r.integrity === true && r.providerError === false && r.toolFailures === 0 && r.authorityViolations === 0);
  const targets = { modelTurns: null, reads: null, spills: null, promptTime: null, cost: null, simpleControls: null };
  const ratios = { composedPromptTime: null, cost: null };
  if (measurement) {
    const sum = (arm, key, composed = false) => rows.filter(r => r.arm === arm && (!composed || r.kind !== "simple")).reduce((n, r) => n + r[key], 0);
    const comparison = key => sum("treatment", key, true) - sum("control", key, true);
    targets.modelTurns = comparison("modelTurns") <= -1;
    targets.reads = comparison("reads") <= 0; targets.spills = comparison("spills") <= 0;
    ratios.composedPromptTime = sum("treatment", "promptMs", true) / sum("control", "promptMs", true);
    const controlCost = sum("control", "reportedCost"), treatmentCost = sum("treatment", "reportedCost");
    ratios.cost = controlCost > 0 ? treatmentCost / controlCost : null;
    targets.promptTime = ratios.composedPromptTime <= .90;
    targets.cost = ratios.cost !== null ? ratios.cost <= 1 : null;
    targets.simpleControls = pairs.filter(p => p.control.kind === "simple").every(p => p.treatment.modelTurns <= p.control.modelTurns && p.treatment.toolCalls <= p.control.toolCalls);
  }
  const screenPass = stopped === null && complete && quality && measurement && Object.values(targets).every(x => x === true);
  return { complete, quality, measurement, targets, ratios, screenPass,
    decision: stopped ? "failed-incomplete" : !complete ? "incomplete" : screenPass ? "screen-pass" : "futile-or-uncertain",
    supportsLiftingHold: false, powerEstablished: false, p95AcceptanceEstablished: false, liveAuthorized: false };
}

// A scripted accounting exercise, not model inference or a performance result.
async function exerciseOfflinePilot() {
  let clock = 0;
  const budget = new PilotBudget({ clock: () => clock, prices: PRICE_CEILINGS });
  for (const row of pilotSchedule()) {
    await runSession(budget, row.key, async () => {
      const turns = row.kind !== "simple" && row.arm === "control" ? 3 : 2;
      for (let i = 0; i < turns; i++) {
        await runAttempt(budget, { inputUpperBound: 100, maxOutputTokens: 4096 }, async () => {
          clock += 100;
          return { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 2, totalTokens: 110, cost: { total: .0003 } };
        });
      }
      return { fixtureDigest: digest({ synthetic: true, id: row.id }), oracleOk: true, integrity: true, providerError: false,
        toolFailures: 0, authorityViolations: 0, modelTurns: turns, reads: row.kind === "batch" ? 4 : row.kind === "chain" ? 2 : 1,
        toolCalls: row.kind === "batch" ? 4 : row.kind === "chain" ? 2 : 1, spills: 0 };
    });
  }
  const ledger = budget.snapshot();
  return { offlineOnly: true, simulation: true, liveRequests: 0, actualProviderCost: 0,
    protocol: pilotProtocol(), ledger, simulatedScreen: summarizePilot(ledger),
    interpretation: "Scripted fake usage/timings/oracles only; not live qualification, latency evidence, power or acceptance" };
}

module.exports = { GUIDELINE, LIMITS, RESERVATION, PRICE_CEILINGS, SEED, pilotSchedule, pilotProtocol, withPilotGuideline, checkStorage, PilotBudget, runAttempt, runSession, summarizePilot, exerciseOfflinePilot };
