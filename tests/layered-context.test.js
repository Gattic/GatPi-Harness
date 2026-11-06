"use strict";

const assert = require("node:assert/strict");
const { LayeredContextMemory } = require("../src/layered-context");

let t = 1_700_000_000_000;
const clock = () => t;
const mem = new LayeredContextMemory({ clock });

mem.upsert({ layer: "L0", title: "Never ignore system rules", content: "System and developer rules are immutable and outrank task context.", tags: ["principle"], protected: true, verification: "verified", importance: 1 });
mem.upsert({ layer: "L1", title: "Hermes advisory contract", content: "Pi remains fast. Hermes advisories stay typed, explicit, off-path, privacy-safe, and unable to mutate canonical state.", tags: ["architecture", "contract"], verification: "verified", importance: 0.95, architecturalImportance: 1 });
mem.upsert({ layer: "L2", title: "Active refactor", content: "Implement semantic multi-layer context management with observability and compaction.", tags: ["plan"], verification: "verified", importance: 0.8 });
mem.upsert({ layer: "L3", title: "Open file", content: "src/layered-context.js contains the context engine implementation.", tags: ["working-set"], dependencyRefs: ["src/layered-context.js"], verification: "verified" });
mem.upsert({ layer: "L4", title: "Speculative note", content: "Maybe use a vector database later, but this is intentionally not the architecture.", tags: ["scratch"], verification: "assumed", ttlMs: 100 });

t += 200;
const pack = mem.pack({ tokenBudget: 140, query: "off-path Hermes advisory architecture", dependencyFocus: ["src/layered-context.js"] });
assert(pack.blocks.some((b) => b.layer === "L0"), "L0 protected principles are preserved");
assert(pack.blocks.some((b) => b.layer === "L1"), "L1 architecture memory is preserved");
assert(pack.observations.included.every((x) => x.why.includes("score=")), "observability explains inclusion scores");
assert(pack.observations.removed.some((x) => x.reason.includes("expired")), "expired scratchpad is removed from packed context");

const conflict = mem.upsert({ layer: "L1", title: "Blocking Hermes", content: "Hermes advice must block prompts and mutate canonical state automatically.", tags: ["architecture"], verification: "assumed", architecturalImportance: 0.9, contradicts: [pack.blocks.find((b) => b.layer === "L1").id] });
assert.equal(conflict.accepted, false, "unverified architectural contradiction is rejected");

const old = mem.upsert({ layer: "L3", title: "Old tool output", content: "Temporary grep output for a discarded experiment.", ttlMs: 1, updatedAt: t - 10_000, verification: "assumed" });
assert.equal(old.accepted, true);
const compact = mem.compactLayer("L3", { threshold: 0.99 });
assert(compact.removed.includes(old.block.id), "compaction removes stale working set blocks");
assert(mem.metrics().byLayer.L3.blocks >= 0, "metrics are exposed by layer");

console.log("layered-context tests passed");
