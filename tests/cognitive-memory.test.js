"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { CognitiveMemory } = require("../src/cognitive-memory");
const { tmpFixture } = require("./helpers/tmp-fixture");

let t = 1_700_000_000_000;
const clock = () => t;
const mem = new CognitiveMemory({ clock, consolidationIntervalMs: 1 });

const strategic = mem.remember({
  type: "strategic",
  title: "Project philosophy",
  content: "Maintainability and non-blocking Hermes advisory architecture outrank clever opaque abstractions.",
  tags: ["maintainability", "performance", "architecture"],
  confidence: 0.95,
  verification: "verified",
  provenance: { source: "user" },
});
const semantic = mem.remember({
  type: "semantic",
  title: "Hermes advisory invariant",
  content: "The non-blocking Hermes advisory architecture must be typed, off-path, privacy-safe, and unable to mutate canonical state.",
  tags: ["architecture", "invariant", "contract"],
  symbols: ["HermesAdvisoryAdapter"],
  paths: ["extensions/hermes-advisory/index.ts"],
  confidence: 0.96,
  verification: "verified",
  provenance: { source: "durable-recall" },
});
const procedural = mem.remember({
  type: "procedural",
  title: "Hermes advisory smoke test",
  content: "Run the Hermes advisory smoke script and confirm typed output with metadata-only receipts.",
  tags: ["testing", "workflow"],
  symbols: ["HermesAdvisoryAdapter"],
  confidence: 0.88,
  verification: "verified",
  provenance: { source: "test" },
});
const ep1 = mem.remember({
  type: "episodic",
  title: "Debug attempt 1",
  content: "Attempted synchronous advisory routing for HermesAdvisoryAdapter and it failed because prompt latency increased.",
  tags: ["debugging", "failure"],
  symbols: ["HermesAdvisoryAdapter"],
  confidence: 0.78,
  verification: "verified",
  provenance: { source: "session" },
});
const ep2 = mem.remember({
  type: "episodic",
  title: "Debug attempt 2",
  content: "Retried HermesAdvisoryAdapter through an explicit off-path command; the advisory smoke validation passed.",
  tags: ["debugging", "experiment"],
  symbols: ["HermesAdvisoryAdapter"],
  confidence: 0.80,
  verification: "verified",
  provenance: { source: "session" },
});
assert(strategic.accepted && semantic.accepted && procedural.accepted && ep1.accepted && ep2.accepted);

const focused = mem.retrieve("non-blocking Hermes architecture invariant", { filters: { symbols: ["HermesAdvisoryAdapter"] }, architectureFocus: 1, limit: 4 });
assert.equal(focused.entries[0].type, "semantic", "architecture query ranks semantic invariant first");
assert(focused.observations.included[0].why.includes("retrieval via semantic policy"), "retrieval explains type-specific policy");
assert(focused.observations.included[0].score.factors.architecture > 0.8, "architecture weighting is exposed");

const debug = mem.retrieve("failed retry debugging latency", { types: ["episodic"], limit: 2 });
assert(debug.entries.every((e) => e.type === "episodic"), "episodic retrieval is independent");
assert(debug.observations.included[0].score.factors.recency > 0.9, "episodic recency is significant");

const decisions = mem.consolidate({ force: true }).decisions;
assert(decisions.some((d) => d.action === "cross-link" && d.relation === "episodic->semantic"), "episodic to semantic links are created");
assert(decisions.some((d) => d.action === "cross-link" && d.relation === "semantic->procedural"), "semantic to procedural links are created");
assert(decisions.some((d) => d.action === "cross-link" && d.relation === "strategic->semantic"), "strategic to semantic links are created");
assert(decisions.some((d) => d.action === "invariant-extracted"), "consolidation extracts invariants from repeated episodes");

const contradiction = mem.remember({
  type: "semantic",
  title: "Bad blocking invariant",
  content: "Hermes advice must block prompts and mutate canonical state automatically.",
  tags: ["architecture", "invariant"],
  symbols: ["HermesAdvisoryAdapter"],
  confidence: 0.4,
  verification: "inferred",
  contradicts: [semantic.entry.id],
});
assert.equal(contradiction.accepted, false, "unverified contradiction of verified semantic memory is rejected");

const entriesBeforeDuplicate = mem.metrics().totalEntries;
const dup = mem.remember({ type: "procedural", title: "Hermes smoke test duplicate", content: procedural.entry.content, tags: ["testing", "workflow"], symbols: ["HermesAdvisoryAdapter"], confidence: 0.7, verification: "inferred" });
assert(dup.accepted);
assert.equal(dup.deduped, true, "exact normalized content is deduplicated before insertion");
assert.equal(mem.metrics().totalEntries, entriesBeforeDuplicate);
assert(mem.audit.some((event) => event.action === "deduplicate-on-insert"));
const collisionCount = mem.metrics().totalEntries;
const collisionA = mem.remember({ type: "procedural", title: "Distinct collision A", content: "candidate xyvs1v 18cebt", tags: ["workflow"], verification: "verified" });
const collisionB = mem.remember({ type: "procedural", title: "Distinct collision B", content: "candidate s81hqj 1vkyi7r", tags: ["workflow"], verification: "verified" });
assert.equal(collisionA.deduped, false); assert.equal(collisionB.deduped, false, "distinct normalized contents are compared after hashing and cannot merge on a legacy 32-bit collision");
assert.equal(mem.metrics().totalEntries, collisionCount + 2);
mem.remember({ type: "procedural", title: "Routine verifier result", content: "Unique automatic verifier evidence noise", tags: ["verification"], confidence: 0.8, verification: "verified", provenance: { source: "verification-adapter" } });
mem.remember({ type: "semantic", title: "Routine anchor result", content: "Unique automatic anchor evidence noise", tags: ["anchor"], confidence: 0.8, verification: "inferred", provenance: { source: "anchoring-adapter" } });
mem.remember({ type: "strategic", title: "Assistant turn mirror", content: "Unique automatic assistant turn evidence noise", tags: ["assistant-turn"], confidence: 0.5, verification: "inferred", provenance: { source: "pi-message" } });
const forbiddenHotProvenance = ["verification-adapter", "anchoring-adapter", "pi-message"];
const hot = mem.retrieve("unique automatic evidence noise", { types: ["semantic", "procedural", "strategic"], excludeProvenanceSources: forbiddenHotProvenance });
assert.equal(hot.entries.some((entry) => forbiddenHotProvenance.includes(entry.provenance.source)), false, "verifier, anchor, and assistant-turn records cannot re-enter automatic hot recall");
mem.consolidate({ force: true });

t += 10 * 24 * 60 * 60 * 1000;
mem.remember({ type: "episodic", title: "Stale speculative debugging", content: "Maybe changing random timeout fixes a failure.", tags: ["debugging", "failure"], confidence: 0.2, verification: "speculative", speculative: true, updatedAt: t - 9 * 24 * 60 * 60 * 1000 });
const forgotten = mem.forget();
assert(forgotten.removed.some((r) => r.reason.includes("stale debugging") || r.reason.includes("speculative")), "forgetting removes stale/speculative debugging data");

const metrics = mem.metrics();
assert(metrics.byType.semantic.entries >= 1 && metrics.auditEvents > 0, "metrics expose per-memory counts and audit size");

const file = path.join(tmpFixture("cognitive-memory-"), "state.json");
mem.save(file);
const loaded = CognitiveMemory.load(file, { clock });
assert.equal(loaded.metrics().totalEntries, mem.metrics().totalEntries, "persistence round-trips entries");

console.log("cognitive-memory tests passed");
