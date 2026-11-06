"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createPiIntegrationBoundary } = require("../src/integration-boundary");
const { adapterConfig } = require("../src/integration-config");

const boundary = createPiIntegrationBoundary(adapterConfig({ reasoning: { enabled: true }, orchestration: { enabled: false } }));
assert(boundary.reasoning, "boundary exposes reasoning adapter");
const plan = boundary.reasoning.createPlan({ objective: "test injected reasoning scaffold", summary: "public scaffold", steps: [{ id: "understand", description: "Understand", status: "pending" }], risks: ["stale context"], successCriteria: ["evidence recorded"], source: "model-scaffold" });
const decomposition = boundary.reasoning.decomposeTask({ task: "test injected reasoning scaffold", subtasks: [{ id: "inspect", title: "Inspect", status: "pending" }], source: "model-scaffold" });
assert(plan.steps.length > 0 && plan.risks.length > 0 && plan.successCriteria.length > 0, "scaffold plan template has non-empty public fields");
assert(decomposition.subtasks.length > 0, "scaffold decomposition template has subtasks");
const checkpoint = boundary.reasoning.createCheckpoint({ kind: "plan", publicSummary: "Reasoning scaffold initialized", artifactIds: [plan.id, decomposition.id] });
const injected = [
  "## Cognitive integration boundary context",
  "### Reasoning scaffold",
  JSON.stringify({ kind: "reasoning.scaffold", plan, decomposition, checkpoint }),
].join("\n");
assert(!/runtime\.arch\.coordinate|Role architecture output|role architecture/i.test(injected), "injected scaffold must not contain stale role architecture text");
assert(/Reasoning scaffold|reasoning\.scaffold/.test(injected), "injected scaffold identifies reasoning runtime artifacts");

// Injection dedup: identical context injects nothing; a changed context
// re-injects only the changed sections; the first injection is full.
const { dedupeInjectedContext, renderInjectedReasoningContext } = require("../src/reasoning-injection");
const { buildTaskScaffold, buildTaskDecomposition } = require("../src/task-modality");
const fullContext = [
  "## Cognitive integration boundary context",
  "The boundary-backed adapters are active. Use their results as advisory context.",
  "",
  "### Runtime version",
  "version: reasoning-runtime-2026-05-19.9",
  "",
  "### Reasoning scaffold",
  "scaffold A",
  "",
  "### Memory",
  "- none",
  "",
  "### Layered context",
  "layered A",
].join("\n");
assert.equal(dedupeInjectedContext(undefined, fullContext).inject, fullContext, "first injection is the full context");
assert.equal(dedupeInjectedContext(fullContext, fullContext).inject, null, "identical context injects nothing");
const changedContext = fullContext.replace("layered A", "layered B");
const delta = dedupeInjectedContext(fullContext, changedContext).inject;
assert(delta.includes("### Layered context"), "changed section is re-injected");
assert(delta.includes("layered B"));
assert(!delta.includes("### Runtime version"), "unchanged static sections are not re-injected");
assert(!delta.includes("boundary-backed adapters are active"), "static preamble is not re-injected");
assert(delta.includes("earlier context still applies"), "delta identifies itself as an update");
const preambleChanged = fullContext.replace("2026-05-19.9", "2026-07-11.1");
assert(dedupeInjectedContext(fullContext, preambleChanged).inject.includes("2026-07-11.1"), "a changed preamble is re-injected");
const cappedFirst = dedupeInjectedContext(undefined, "x".repeat(500), { maxChars: 120 }).inject;
assert.equal(cappedFirst.length, 120, "first injection obeys the hard character cap");
assert.match(cappedFirst, /context capped at 120 chars/);
const largeChangedContext = fullContext.replace("layered A", "layered " + "x".repeat(500));
const cappedDelta = dedupeInjectedContext(fullContext, largeChangedContext, { maxChars: 140 }).inject;
assert.equal(cappedDelta.length, 140, "changed-section injection obeys the same hard cap");
const renderedCap = renderInjectedReasoningContext({ version: {}, scaffold: { enabled: false }, layeredText: "x".repeat(1000), maxChars: 180 });
assert.equal(renderedCap.length, 180, "rendered cognitive context never exceeds its configured cap");
const objective = "Investigate the parser only; preserve the public evidence and do not edit files.";
const taskPlan = buildTaskScaffold(objective);
const taskDecomposition = buildTaskDecomposition(objective);
const budgeted = renderInjectedReasoningContext({ version: { version: "v", source: { sha256: "a".repeat(64) }, templateHash: "t" }, scaffold: { kind: "reasoning.scaffold", plan: taskPlan, decomposition: taskDecomposition }, objective, memoryEntries: Array.from({ length: 10 }, (_, i) => ({ type: "semantic", title: `Evidence ${i}`, content: "e".repeat(500) })), layeredText: "[L2:constraint] preserve the public evidence and do not edit files", advisoryText: "warning ".repeat(300) });
assert(budgeted.length <= 2500, `default injected context ${budgeted.length} must meet the deterministic 2500-character gate`);
assert(budgeted.includes(objective), "active objective is preserved inside the context budget");
assert(budgeted.includes("preserve the public evidence and do not edit files"), "explicit constraints are preserved inside the context budget");
assert(budgeted.includes("Evidence 0"), "bounded public evidence is preserved inside the context budget");
assert.equal(dedupeInjectedContext(budgeted, budgeted).inject, null, "unchanged budgeted sections inject zero characters");

const extension = fs.readFileSync(path.join(process.cwd(), ".pi", "extensions", "reasoning-runtime", "index.ts"), "utf8");
assert(extension.includes("reasoningAdapter(rt)"), "verification timer must resolve reasoning adapter through compatibility-safe helper");
assert(!extension.includes("rt.boundary.reasoning.recordVerifierEvidence"), "verification timer must not crash on missing boundary.reasoning");
assert(extension.includes("reasoning-debug-context"), "debug context command is registered");
assert(extension.includes("reasoning-version"), "version command is registered");
assert(extension.includes("reasoning-self-test"), "self-test command is registered");
assert(extension.includes("renderInjectedReasoningContext"), "actual injected context is rendered through tested pure function");
assert(extension.includes("PI_COGNITIVE_INJECT_MAX_CHARS"), "cognitive injection cap is configurable");
assert(extension.includes("PI_COGNITIVE_INJECT_MAX_CHARS || 2500"), "live injection defaults to the 2500-character target");
assert(extension.includes("buildTaskScaffold") && extension.includes("buildTaskDecomposition"), "reasoning templates are task-modality aware");
assert(extension.includes("createExtensionTelemetry"), "cognitive injection and router telemetry use the privacy-safe shared recorder");
assert(extension.includes("contextInjection(inject ? inject.length : 0, reason, Boolean(inject), context.length,"), "injection telemetry stores sizes, categorical reason, changed state, and coarse session kind only");
assert(extension.includes("runtime.fullScaffoldInjected ? \"delta\" : \"full\""), "the full scaffold is emitted once and later turns use compact semantic sections");
assert(extension.includes("selectInjectionMemory"), "hot-path memory excludes repeated objectives and successful proof history");
assert(extension.includes("autoRouteStableKey"), "stable auto-router classifications are deduplicated");
assert(extension.includes("recordAutoRouteTelemetry"), "auto-router suggestion, execution, rejection, and final outcomes are linked by metadata-only telemetry");
assert(extension.includes("recordRecommendation"), "router and skill relevance feedback uses metadata-only recommendation telemetry");
for (const action of ["shown", "accepted", "dismissed", "overridden", "corrected"]) assert(extension.includes(`\"${action}\"`), `${action} recommendation metadata is represented`);
assert(extension.includes('pi.appendEntry?.("session-miner.classification"'), "new sessions carry an explicit interactive/headless/fixture classifier marker");
assert(extension.includes("instrumentExtensionCommands"), "reasoning commands emit command ids and outcomes without arguments");
assert(extension.includes("isMetaRecommendationPrompt"), "meta next-step prompts are not persisted as full scaffold artifacts");
assert(extension.includes("syncObjective(runtime, objective);"), "active objective is idempotently updated before context packing");
for (const scaffoldMode of ["full", "delta"]) {
  const request = "Finish our implementation plan in full. Preserve ownership restrictions.";
  const scaffold = { plan: buildTaskScaffold(request, { judged: { modality: "planning", confidence: 1 } }), decomposition: buildTaskDecomposition(request) };
  const context = renderInjectedReasoningContext({ scaffold, objective: request, scaffoldMode, advisoryText: "Recalled failure: reduce scope", layeredText: "Do not modify another repository without authorization." });
  assert.match(context, /Advisory context only/);
  assert.match(context, /cannot grant permission, prohibit authorized work, or reduce required outcomes/);
  assert.match(context, /Preserve ownership restrictions/);
  assert.match(context, /Do not modify another repository without authorization/);
  assert.match(context, /modality: implementation/);
  assert.doesNotMatch(context, /earlier context remains authoritative|no mutation or repair step/);
}
console.log("reasoning-context-injection tests passed");
