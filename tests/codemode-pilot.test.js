"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { GUIDELINE, LIMITS, RESERVATION, PRICE_CEILINGS, pilotSchedule, pilotProtocol, withPilotGuideline, checkStorage, PilotBudget, runAttempt, runSession, summarizePilot, exerciseOfflinePilot } = require("../src/codemode-pilot");
const { tmpFixture } = require("./helpers/tmp-fixture");

const zeroPrices = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const request = { inputUpperBound: 16384, maxOutputTokens: 4096 };
function usage(input = 100, output = 10, extra = {}) {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { total: input * 2 / 1e6 + output * 10 / 1e6 }, ...extra };
}
function harness(prices = PRICE_CEILINGS) {
  let at = 0;
  const budget = new PilotBudget({ clock: () => at, prices });
  return { budget, advance(ms) { at += ms; } };
}
function fail(fn, code) { assert.throws(fn, error => error.code === code); }
function complete(h, entry = pilotSchedule()[0], metrics = {}) {
  const { budget } = h;
  if (!budget.snapshot().activeKey) budget.begin(entry.key);
  const ticket = budget.admit(request); h.advance(1); budget.settle(ticket, usage());
  return budget.end({ fixtureDigest: "a".repeat(64), oracleOk: true, integrity: true, providerError: false,
    toolFailures: 0, authorityViolations: 0, modelTurns: 1, reads: 1, toolCalls: 1, spills: 0, ...metrics });
}

(async () => {
  const plan = pilotSchedule();
  assert.equal(plan.length, 32); assert.deepEqual(plan, pilotSchedule());
  assert.equal(new Set(plan.map(x => x.key)).size, 32);
  for (const [kind, pairs] of [["simple", 4], ["batch", 6], ["chain", 6]]) {
    const first = plan.filter((p, i) => p.kind === kind && i % 2 === 0);
    assert.equal(first.length, pairs); assert.equal(first.filter(p => p.arm === "control").length, pairs / 2);
  }
  assert.equal(pilotProtocol().liveAuthorized, false); assert.equal(pilotProtocol().hold, true);
  assert.equal(RESERVATION.costPico / 1e12, .073728000001);
  const definition = { name: "codemode", promptGuidelines: ["baseline"], execute() {} };
  assert.strictEqual(withPilotGuideline(definition, "control"), definition);
  const candidate = withPilotGuideline(definition, "treatment");
  assert.deepEqual(candidate.promptGuidelines, ["baseline", GUIDELINE]); assert.equal(definition.promptGuidelines.length, 1);
  assert.strictEqual(candidate.execute, definition.execute);
  fail(() => withPilotGuideline(candidate, "treatment"), "SESSION_STATE");
  fail(() => withPilotGuideline(definition, "direct"), "SESSION_STATE");

  // Reject missing, higher, negative and non-numeric catalog rates, including cache writes.
  for (const prices of [undefined, {}, { ...PRICE_CEILINGS, input: 2.01 }, { ...PRICE_CEILINGS, output: 10.01 }, { ...PRICE_CEILINGS, cacheWrite: 3 }, { ...PRICE_CEILINGS, output: NaN }, { ...PRICE_CEILINGS, cacheRead: -1 }]) {
    fail(() => new PilotBudget({ prices }), "COST_BUDGET");
  }
  for (const bad of [null, undefined, NaN, Infinity, -1, .5, 16385]) {
    const h = harness(); h.budget.begin(plan[0].key);
    fail(() => h.budget.admit({ ...request, inputUpperBound: bad }), "INPUT_BOUND");
    assert.equal(h.budget.snapshot().attempts, 0);
  }
  for (const bad of [undefined, 4095, 4097, Infinity]) {
    const h = harness(); h.budget.begin(plan[0].key);
    fail(() => h.budget.admit({ ...request, maxOutputTokens: bad }), "OUTPUT_LIMIT");
  }
  const h = harness(); h.budget.begin(plan[0].key);
  const ticket = h.budget.admit(request), pending = h.budget.snapshot();
  assert.equal(pending.heldTokens, 20480); assert.equal(pending.heldOutputTokens, 4096); assert.equal(pending.heldCostUsd, RESERVATION.costPico / 1e12);
  fail(() => h.budget.admit(request), "ATTEMPT_STATE");
  assert.equal(h.budget.snapshot().pending, true);
  // No refund for missing usage, inconsistent totals, unknown cost, or duplicate completion.
  for (const bad of [null, {}, usage(100, 10, { totalTokens: 999 }), usage(100, 10, { input: -1 }), usage(100, 10, { output: 1.5 }), usage(100, 10, { reasoning: 11 }), usage(100, 10, { cost: { total: null } }), usage(100, 10, { cost: { total: Infinity } })]) {
    const q = harness(); q.budget.begin(plan[0].key); const t = q.budget.admit(request);
    assert.throws(() => q.budget.settle(t, bad)); assert.equal(q.budget.snapshot().pending, true);
    assert.equal(q.budget.snapshot().heldCostUsd, RESERVATION.costPico / 1e12); assert(q.budget.snapshot().stopped);
  }
  const q = harness(); q.budget.begin(plan[0].key); const t = q.budget.admit(request);
  q.advance(1); q.budget.settle(t, usage()); assert.equal(q.budget.snapshot().heldTokens, 0);
  assert.equal(q.budget.snapshot().settledTokens, 110);
  fail(() => q.budget.settle(t, usage()), "ATTEMPT_STATE");
  const cached = harness(); cached.budget.begin(plan[0].key); const ct = cached.budget.admit({ ...request, inputUpperBound: 100 });
  cached.advance(1); cached.budget.settle(ct, usage(40, 10, { cacheRead: 60, totalTokens: 110, reasoning: 4, cost: { total: .0003 } }));
  assert.equal(cached.budget.snapshot().settledTokens, 110, "cached input counted once; reasoning not added twice");
  for (const [u, bound, code] of [[usage(101), 100, "INPUT_BOUND_BREACH"], [usage(100, 4097), 100, "OUTPUT_BOUND_BREACH"], [usage(100, 10, { cost: { total: .01 } }), 100, "COST_MISMATCH"]]) {
    const v = harness(); v.budget.begin(plan[0].key); const vt = v.budget.admit({ ...request, inputUpperBound: bound });
    fail(() => v.budget.settle(vt, u), code);
    assert.equal(v.budget.snapshot().pending, false); assert.equal(v.budget.snapshot().reportedCost, u.cost.total, "violating usage still debited");
  }

  // Full conservative reservations stop before each boundary, not after a request.
  const money = harness(); money.budget.begin(plan[0].key);
  for (let i = 0; i < 6; i++) money.budget.settle(money.budget.admit(request), usage(16384, 4096));
  fail(() => money.budget.admit(request), "COST_BUDGET");
  assert(money.budget.snapshot().chargedUpperUsd <= .50); assert.equal(money.budget.snapshot().attempts, 6);
  // R3: leave exactly the old reservation available; tolerated rounding must not overdraw it.
  const exact = harness(); let exactIndex = 0, exactTurns = 0;
  exact.budget.begin(plan[exactIndex].key);
  function debit(input) {
    exact.budget.settle(exact.budget.admit(request), usage(input, 0)); exact.advance(1); exactTurns++;
    if (exactTurns === 8) {
      exact.budget.end({ fixtureDigest: "a".repeat(64), oracleOk: true, integrity: true, providerError: false, toolFailures: 0, authorityViolations: 0, modelTurns: exactTurns, reads: 1, toolCalls: 1, spills: 0 });
      exact.budget.begin(plan[++exactIndex].key); exactTurns = 0;
    }
  }
  for (let i = 0; i < 13; i++) debit(16384);
  debit(144); assert.equal(exact.budget.snapshot().chargedUpperUsd, .426272);
  fail(() => exact.budget.admit(request), "COST_BUDGET");
  assert.equal(exact.budget.snapshot().chargedUpperUsd, .426272);
  const drift = harness(); drift.budget.begin(plan[0].key);
  const driftTicket = drift.budget.admit(request), driftHeld = drift.budget.snapshot().heldCostUsd;
  drift.budget.settle(driftTicket, usage(16384, 4096, { cost: { total: 16384 * 2 / 1e6 + 4096 * 10 / 1e6 + 1e-15 } }));
  assert(drift.budget.snapshot().chargedUpperUsd <= driftHeld, "accepted drift must fit the reservation");
  for (const [input, output, code] of [[16384, 0, "TOKEN_BUDGET"], [0, 4096, "OUTPUT_BUDGET"]]) {
    const capped = harness(zeroPrices);
    let index = 0, done = false;
    while (!done) {
      capped.budget.begin(plan[index++].key);
      for (let i = 0; i < 7; i++) {
        try { capped.budget.settle(capped.budget.admit(request), usage(input, output, { cost: { total: 0 } })); }
        catch (error) { assert.equal(error.code, code); done = true; break; }
      }
      if (!done) { capped.advance(1); capped.budget.end({ fixtureDigest: "a".repeat(64), oracleOk: true, integrity: true, providerError: false, toolFailures: 0, authorityViolations: 0, modelTurns: 7, reads: 1, toolCalls: 1, spills: 0 }); }
    }
    assert(capped.budget.snapshot().settledTokens <= LIMITS.totalTokens); assert(capped.budget.snapshot().settledOutputTokens <= LIMITS.outputTokens);
  }
  const calls = harness(); calls.budget.begin(plan[0].key);
  for (let i = 0; i < 8; i++) calls.budget.settle(calls.budget.admit(request), usage());
  fail(() => calls.budget.admit(request), "ATTEMPT_LIMIT");
  const maximum = harness(zeroPrices);
  for (const entry of plan) {
    maximum.budget.begin(entry.key);
    for (let i = 0; i < 8; i++) maximum.budget.settle(maximum.budget.admit(request), usage(0, 0, { cost: { total: 0 } }));
    maximum.advance(1);
    maximum.budget.end({ fixtureDigest: "a".repeat(64), oracleOk: true, integrity: true, providerError: false, toolFailures: 0, authorityViolations: 0, modelTurns: 8, reads: 1, toolCalls: 1, spills: 0 });
  }
  assert.equal(maximum.budget.snapshot().attempts, 256);
  fail(() => maximum.budget.begin(plan[0].key), "SESSION_STATE");
  const exhausted = harness();
  for (const entry of plan) complete(exhausted, entry);
  fail(() => exhausted.budget.begin(undefined), "SESSION_STATE");
  assert.equal(exhausted.budget.snapshot().sessionsAssigned, 32, "no implicit session after fixed manifest exhaustion");
  const order = harness(); fail(() => order.budget.begin(plan[1].key), "SESSION_STATE");
  const expired = harness(); expired.budget.begin(plan[0].key); expired.advance(120000);
  fail(() => expired.budget.admit(request), "SESSION_TIMEOUT"); assert.equal(expired.budget.snapshot().attempts, 0);
  const campaign = harness(); complete(campaign); campaign.advance(600000);
  fail(() => campaign.budget.begin(plan[1].key), "CAMPAIGN_TIMEOUT");
  const backwards = harness(); backwards.budget.begin(plan[0].key); backwards.advance(-1);
  fail(() => backwards.budget.check(), "CLOCK_INVALID");

  // Owned deadline aborts a hung invocation. Late usage is still charged, never resumed.
  const timed = harness(); timed.budget.begin(plan[0].key);
  let fire, signal, resolveLate, cleared = false;
  const operation = runAttempt(timed.budget, request, args => { signal = args.signal; return new Promise(resolve => { resolveLate = resolve; }); }, {
    set(fn, delay) { fire = fn; assert.equal(delay, 120000); return 1; }, clear() { cleared = true; },
  });
  await Promise.resolve(); timed.advance(120000); fire();
  await assert.rejects(operation, error => error.code === "SESSION_TIMEOUT");
  assert.equal(signal.aborted, true); assert.equal(cleared, true); assert.equal(timed.budget.snapshot().heldTokens, 20480);
  resolveLate(usage()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(timed.budget.snapshot().heldTokens, 0); assert.equal(timed.budget.snapshot().settledTokens, 110);
  assert.equal(timed.budget.snapshot().stopped, "SESSION_TIMEOUT");
  const beforeDispatch = harness(); beforeDispatch.budget.begin(plan[0].key);
  let dispatchTimer, dispatched = 0;
  const dispatch = runAttempt(beforeDispatch.budget, request, async () => { dispatched++; return usage(); }, {
    set(fn) { dispatchTimer = fn; return 1; }, clear() {},
  });
  beforeDispatch.advance(120000); dispatchTimer();
  await assert.rejects(dispatch, error => error.code === "SESSION_TIMEOUT");
  assert.equal(dispatched, 0, "an expired reservation must never dispatch work in the next microtask");
  let clockReads = 0, earlyDispatch = 0;
  const setupExpiry = new PilotBudget({ clock: () => ++clockReads >= 3 ? 120000 : 0, prices: PRICE_CEILINGS });
  setupExpiry.begin(plan[0].key);
  await assert.rejects(runAttempt(setupExpiry, request, async () => { earlyDispatch++; return usage(); }), error => error.code === "SESSION_TIMEOUT");
  await new Promise(resolve => setImmediate(resolve)); assert.equal(earlyDispatch, 0);
  const brokenTimer = harness(); brokenTimer.budget.begin(plan[0].key);
  await assert.rejects(runAttempt(brokenTimer.budget, request, async () => { earlyDispatch++; return usage(); }, { set() { throw new Error("PRIVATE_SENTINEL"); }, clear() {} }), error => error.code === "PROVIDER_FAILED");
  assert.equal(earlyDispatch, 0); assert.equal(brokenTimer.budget.snapshot().pending, true);
  const toolGap = harness(); let gapTimer, gapSignal, resumeGap;
  const gap = runSession(toolGap.budget, plan[0].key, async ({ signal }) => {
    gapSignal = signal;
    await runAttempt(toolGap.budget, request, async () => usage());
    await new Promise(resolve => { resumeGap = resolve; });
    return {};
  }, { set(fn, delay) { gapTimer = fn; assert.equal(delay, 120000); return 1; }, clear() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(toolGap.budget.snapshot().pending, false);
  toolGap.advance(120000); gapTimer();
  await assert.rejects(gap, error => error.code === "SESSION_TIMEOUT"); assert.equal(gapSignal.aborted, true);
  resumeGap(); await new Promise(resolve => setImmediate(resolve)); assert.equal(toolGap.budget.snapshot().rows.length, 0);
  const whole = harness(); complete(whole); whole.advance(590000); let campaignTimer;
  const wholeRun = runSession(whole.budget, plan[1].key, async () => new Promise(() => {}), {
    set(fn, delay) { campaignTimer = fn; assert.equal(delay, 9999); return 1; }, clear() {},
  });
  await Promise.resolve(); whole.advance(9999); campaignTimer();
  await assert.rejects(wholeRun, error => error.code === "CAMPAIGN_TIMEOUT");
  const failed = harness(); failed.budget.begin(plan[0].key);
  await assert.rejects(runAttempt(failed.budget, request, async () => { throw new Error("PRIVATE_SENTINEL"); }), error => error.code === "PROVIDER_FAILED");
  assert.equal(failed.budget.snapshot().pending, true); assert.doesNotMatch(JSON.stringify(failed.budget.snapshot()), /PRIVATE_SENTINEL/);
  const badOracle = harness(); fail(() => complete(badOracle, plan[0], { oracleOk: false }), "QUALITY_FAILED");
  assert.equal(badOracle.budget.snapshot().rows[0].oracleOk, false, "failed row preserved");
  const missing = harness(); fail(() => complete(missing, plan[0], { reads: null }), "MEASUREMENT_INCOMPLETE");

  checkStorage({ newMetadataBytes: LIMITS.newMetadataBytes, sharedEvidenceBytes: LIMITS.sharedEvidenceBytes, fixtureBytes: LIMITS.fixtureBytes });
  for (const key of ["newMetadataBytes", "sharedEvidenceBytes", "fixtureBytes"]) for (const bad of [null, undefined, -1, Infinity, LIMITS[key] + 1]) {
    fail(() => checkStorage({ newMetadataBytes: 0, sharedEvidenceBytes: 0, fixtureBytes: 0, [key]: bad }), "STORAGE_BOUND");
  }

  const simulated = await exerciseOfflinePilot(), rows = simulated.ledger.rows;
  assert.equal(simulated.liveRequests, 0); assert.equal(simulated.actualProviderCost, 0);
  assert.equal(simulated.simulatedScreen.screenPass, true); assert.equal(simulated.simulatedScreen.supportsLiftingHold, false);
  assert.equal(simulated.protocol.liveAuthorized, false); assert.equal(simulated.simulation, true);
  function artifact(selected, extra = {}) {
    const sum = key => selected.reduce((n, row) => n + row[key], 0);
    const reportedCost = sum("reportedCost");
    return { ...simulated.ledger, rows: selected, attempts: sum("attempts"), sessionsAssigned: selected.length,
      settledTokens: sum("tokens"), settledOutputTokens: sum("outputTokens"), reportedCost,
      chargedUpperUsd: Math.ceil(reportedCost * 1e12) / 1e12, ...extra };
  }
  function mutate(change) { return summarizePilot(artifact(rows.map(r => ({ ...r, ...change(r) })))); }
  function metered(row, components, prices = PRICE_CEILINGS) {
    const usage = { ...components, totalTokens: components.input + components.cacheRead + components.cacheWrite + components.output,
      cost: { total: ["input", "cacheRead", "cacheWrite", "output"].reduce((n, k) => n + components[k] * prices[k] / 1e6, 0) } };
    return { ...row, usage, tokens: usage.totalTokens, outputTokens: usage.output, reportedCost: usage.cost.total };
  }
  // R1/R2: individually bounded fields do not make cross-field contradictions valid.
  assert.equal(mutate(r => ({ promptMs: r.arm === "treatment" && r.kind !== "simple" ? 90000 : 100000, campaignElapsedMs: 500000 })).screenPass, false, "serial3,080,000ms cannot fit a500,000ms campaign");
  assert.equal(mutate(() => ({ tokens: 0, outputTokens: 0 })).screenPass, false, "positive cost with zero metered tokens is not reconciled");
  assert.equal(summarizePilot(artifact(rows.slice(1))).screenPass, false);
  assert.equal(summarizePilot(artifact([rows[1], ...rows.slice(1)])).complete, false);
  assert.equal(summarizePilot(artifact(rows, { stopped: "COST_BUDGET" })).screenPass, false);
  assert.equal(summarizePilot(rows).screenPass, false, "unpriced legacy row arrays cannot qualify");
  for (const extra of [{ prices: undefined }, { prices: { ...PRICE_CEILINGS, output: 11 } }, { attempts: 1 }, { settledTokens: 0 }, { settledOutputTokens: 0 }, { reportedCost: 0 }, { pending: true }, { heldCostUsd: .01 }, { activeKey: rows[0].key }, { stopped: undefined }, { chargedUpperUsd: .51 }]) {
    assert.equal(summarizePilot(artifact(rows, extra)).screenPass, false, "missing/inconsistent ledger context must fail closed");
  }
  assert.equal(mutate(r => ({ reportedCost: r.reportedCost * 1000 })).screenPass, false, "a complete but over-budget artifact must not pass the screen");
  for (const field of ["promptMs", "reportedCost", "modelTurns", "reads", "toolCalls", "spills"]) for (const bad of [null, undefined, NaN, Infinity, -1]) {
    assert.equal(mutate(r => r.key === rows[0].key ? { [field]: bad } : {}).screenPass, false, field);
  }
  for (const patch of [{ oracleOk: false }, { integrity: false }, { providerError: true }, { toolFailures: 1 }, { authorityViolations: 1 }, { measurementComplete: false }, { fixtureDigest: "b".repeat(64) }]) {
    assert.equal(mutate(r => r.key === rows[0].key ? patch : {}).screenPass, false);
  }
  const free = rows.map(r => metered(r, r.usage, zeroPrices));
  assert.equal(summarizePilot(artifact(free, { prices: zeroPrices })).targets.cost, null, "valid zero-priced usage gives an unknown ratio, never a pass");
  for (const extra of [{ reportedCost: -1e-15 }, { chargedUpperUsd: -1e-15 }]) {
    assert.equal(summarizePilot(artifact(free, { prices: zeroPrices, ...extra })).measurement, false);
  }
  const spuriousFreeCharge = free.map(r => ({ ...r, reportedCost: 1e-15, usage: { ...r.usage, cost: { total: 1e-15 } } }));
  assert.equal(summarizePilot(artifact(spuriousFreeCharge, { prices: zeroPrices })).measurement, false, "zero-priced arithmetic permits no nonzero charge, even below the usual roundoff bound");
  assert.equal(mutate(r => ({ usage: { ...r.usage, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0, reasoning: 0 }, tokens: 0, outputTokens: 0 })).measurement, false, "positive cost with canonical zero usage is invalid");
  assert.equal(mutate(r => ({ usage: { ...r.usage, totalTokens: r.tokens + 1 } })).measurement, false);
  const emptyCharged = rows.map(r => ({ ...r, tokens: 0, outputTokens: 0, reportedCost: 1e-15,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, totalTokens: 0, cost: { total: 1e-15 } } }));
  assert.equal(summarizePilot(artifact(emptyCharged)).measurement, false, "zero tokens cannot carry even a tiny positive charge");
  assert.equal(mutate(r => ({ usage: undefined })).measurement, false);
  const cachePrices = { input: 2, cacheRead: .1, cacheWrite: 1, output: 10 };
  const cacheRows = rows.map(r => metered(r, { ...r.usage, input: r.usage.input / 2, cacheRead: r.usage.input / 4, cacheWrite: r.usage.input / 4 }, cachePrices));
  assert.equal(summarizePilot(artifact(cacheRows, { prices: cachePrices })).measurement, true, "uncached/read-cache/write-cache priced separately and counted once");
  assert.equal(summarizePilot(artifact(cacheRows)).measurement, false, "effective prices are required for reconciliation");
  const detached = cached.budget.snapshot(); detached.prices.input = 0;
  assert.equal(cached.budget.snapshot().prices.input, 2, "snapshot rates cannot mutate the ledger");
  assert.equal(mutate(r => ({ modelTurns: 2 })).targets.modelTurns, false);
  assert.equal(mutate(r => r.arm === "treatment" && r.kind !== "simple" ? { reads: 100, toolCalls: 100 } : {}).targets.reads, false);
  assert.equal(mutate(r => r.arm === "treatment" && r.kind !== "simple" ? { spills: 1 } : {}).targets.spills, false);
  assert.equal(mutate(r => ({ promptMs: r.kind === "simple" || r.arm === "control" ? 100 : 90 })).targets.promptTime, true);
  assert.equal(mutate(r => ({ promptMs: r.kind === "simple" || r.arm === "control" ? 100 : 90.0001 })).targets.promptTime, false);
  const equalCosts = rows.map(r => metered(r, { input: 500, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }));
  assert.equal(summarizePilot(artifact(equalCosts)).targets.cost, true);
  const higherCosts = rows.map(r => metered(r, { input: r.arm === "treatment" ? 501 : 500, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }));
  assert.equal(summarizePilot(artifact(higherCosts)).targets.cost, false, "unrounded metered cost increase cannot be hidden by display rounding");
  assert.equal(mutate(r => ({ reportedCost: r.arm === "treatment" ? .0010000001 : .001 })).measurement, false, "cost-only edits are not reconciled usage");
  assert.equal(mutate(r => r.arm === "treatment" && r.kind === "simple" ? { modelTurns: 3, attempts: 3 } : {}).targets.simpleControls, false);
  assert.equal(mutate(r => r.arm === "treatment" && r.kind === "simple" ? { toolCalls: 2 } : {}).targets.simpleControls, false);
  let elapsed = 0, addedTail = false;
  const tails = rows.map(r => {
    const promptMs = !addedTail && r.arm === "treatment" && r.kind === "chain" ? (addedTail = true, 99999) : r.promptMs;
    elapsed += promptMs; return { ...r, promptMs, campaignElapsedMs: elapsed };
  });
  assert.equal(summarizePilot(artifact(tails)).targets.promptTime, false, "retain bad tails");
  let fractionElapsed = 0;
  const fractional = rows.map(r => { const promptMs = r.promptMs / 1000; fractionElapsed += promptMs; return { ...r, promptMs, campaignElapsedMs: fractionElapsed }; });
  assert.equal(summarizePilot(artifact(fractional)).measurement, true, "legitimate fractional serial times tolerate only arithmetic roundoff");
  const overlaps = rows.map((r, i) => ({ ...r, campaignElapsedMs: r.campaignElapsedMs - (i ? 1 : 0) }));
  assert.equal(summarizePilot(artifact(overlaps)).measurement, false, "even a1ms overlap is not serial execution");
  for (const patch of [{ tokens: 1000000 }, { outputTokens: 1000000 }, { attempts: 9 }, { campaignElapsedMs: 600000 }, { reads: 2, toolCalls: 1 }]) {
    assert.equal(mutate(r => r.key === rows[0].key ? patch : {}).screenPass, false, "inconsistent/over-budget artifact is incomplete measurement");
  }

  // CLI rejects paid/configuration/limit overrides before work. Network denied even on success.
  const cli = path.resolve(__dirname, "../scripts/qualify-codemode-pilot.js");
  for (const args of [[], ["--live"], ["--offline", "--live"], ["--offline", "--provider", "openai-codex"], ["--offline", "--cost", "6"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /Only --offline/); assert.equal(result.stdout, "");
  }
  const dir = tmpFixture("pilot-no-network-");
  try {
    const preload = path.join(dir, "deny.cjs");
    fs.writeFileSync(preload, 'const deny=()=>{throw new Error("NETWORK_FORBIDDEN")};global.fetch=deny;global.WebSocket=class{constructor(){deny()}};require("node:net").Socket.prototype.connect=deny;require("node:http").request=deny;require("node:https").request=deny;');
    const result = spawnSync(process.execPath, ["--require", preload, cli, "--offline"], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
    assert.equal(report.offlineOnly, true); assert.equal(report.liveRequests, 0); assert.equal(report.simulatedScreen.screenPass, true);
    assert(Buffer.byteLength(result.stdout) <= LIMITS.newMetadataBytes);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log("offline pilot schedule, reservations, debit/reconciliation, deadlines, negative gates, CLI and no-network qualification passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
