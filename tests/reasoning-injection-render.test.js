"use strict";
const assert = require("node:assert/strict");
const { renderInjectedReasoningContext, selectInjectionMemory, dedupeInjectedContext } = require("../src/reasoning-injection");

const rich = {
  kind: "reasoning.scaffold",
  plan: { objective: "current", steps: [{ id: "s", description: "d" }], risks: ["r"], successCriteria: ["c"] },
  decomposition: { task: "current", subtasks: [{ id: "t", title: "T" }] },
  checkpoint: { publicSummary: "ok" },
};
const version = { version: "test", source: { sha256: "abcdef1234567890", path: "x" }, templateHash: "template" };
const rendered = renderInjectedReasoningContext({ version, scaffold: rich, objective: "current", memoryEntries: [{ type: "strategic", title: "User objective", content: "current" }, { type: "episodic", title: "Role architecture output", content: "bad" }], layeredText: "[L2:objective] Active user objective\ncurrent\n\n[L1:memory] Keep explicit safety boundaries" });
assert(rendered.includes("### Runtime version"));
assert(rendered.includes("abcdef123456"));
assert(rendered.includes("steps:"));
assert(rendered.includes("risks:"));
assert(rendered.includes("success:"));
assert(!rendered.includes('"checkpoint"'), "compact context leaves historical artifact detail behind inspection tools");
assert(!/Role architecture output|runtime\.arch\.coordinate/.test(rendered));
assert(rendered.includes("### Active objective") && rendered.includes("current"));
assert(rendered.includes("### Constraints and safety") && rendered.includes("Keep explicit safety boundaries"));
assert.equal((rendered.match(/Active user objective/g) || []).length, 0, "layered objective is not repeated after the explicit active-objective section");

const compact = renderInjectedReasoningContext({ version, scaffold: rich, scaffoldMode: "delta", objective: "next", memoryEntries: [], layeredText: "[L1:memory] constraint", advisoryText: "warning" });
assert(compact.includes("### Reasoning scaffold"), "later turns render the scaffold so a changed modality reaches the model");
assert(!compact.includes("Concise public task context"), "later turns omit the full-context preamble");
assert(compact.includes("### Active objective") && compact.includes("### Decisions and evidence") && compact.includes("### Warnings and routing"));
const sameScaffold = renderInjectedReasoningContext({ version, scaffold: rich, scaffoldMode: "delta", objective: "after next", memoryEntries: [], layeredText: "[L1:memory] constraint", advisoryText: "warning" });
assert(!dedupeInjectedContext(compact, sameScaffold).inject.includes("### Reasoning scaffold"), "an unchanged scaffold is not re-injected");
const replanned = renderInjectedReasoningContext({ version, scaffold: { ...rich, plan: { ...rich.plan, modality: "implementation" } }, scaffoldMode: "delta", objective: "next", memoryEntries: [], layeredText: "[L1:memory] constraint", advisoryText: "warning" });
assert.match(dedupeInjectedContext(compact, replanned).inject, /### Reasoning scaffold\nmodality: implementation/, "a changed modality re-injects the scaffold");

const selected = selectInjectionMemory([
  { type: "strategic", title: "User objective", content: "old objective" },
  { type: "procedural", title: "Automatic verification completed", content: "all checks passed", tags: ["verification"], verification: "verified" },
  { type: "semantic", title: "Architecture", content: "preserve safety boundary" },
  { type: "semantic", title: "Architecture", content: "preserve safety boundary" },
]);
assert.deepEqual(selected.map((entry) => entry.title), ["Architecture"], "old objectives, successful proof history, and exact duplicates are excluded");

const empty = renderInjectedReasoningContext({ version, scaffold: { kind: "reasoning.scaffold", plan: { steps: [] }, decomposition: { subtasks: [] } }, memoryEntries: [], layeredText: "" });
assert(empty.includes("reasoning scaffold unavailable: stale extension/template mismatch"));
console.log("reasoning-injection-render tests passed");
