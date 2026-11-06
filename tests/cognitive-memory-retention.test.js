"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CognitiveMemory, DEFAULT_MAX_BY_TYPE } = require("../src/cognitive-memory.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("cognitive-retention-");
const at = Date.parse("2026-10-25T00:00:00Z");
const clock = () => at;
try {
  // Legacy files can contain exact duplicates written before insert-time
  // dedupe existed. Persistence collapses them and keeps the stronger entry.
  const file = path.join(tmp, "cognitive-memory.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    savedAt: at,
    lastConsolidatedAt: 0,
    audit: [],
    entries: [
      { id: "mem_a", type: "episodic", title: "First", content: "Same durable statement.", verification: "inferred", confidence: 0.4, createdAt: at - 3000, updatedAt: at - 3000, tags: ["debugging"], provenance: { source: "session" } },
      { id: "mem_b", type: "episodic", title: "Second", content: "same durable statement", verification: "verified", confidence: 0.9, createdAt: at - 2000, updatedAt: at - 2000, tags: ["debugging", "architecture"], provenance: { source: "user" } },
      { id: "mem_c", type: "procedural", title: "Run tests", content: "Run the focused suite before publishing.", verification: "corroborated", confidence: 0.8, createdAt: at - 1000, updatedAt: at - 1000, tags: ["procedure"], provenance: { source: "explicit-review" } },
    ],
  }));
  const memory = CognitiveMemory.load(file, { clock });
  assert.equal(memory.entries.size, 3);
  memory.save(file);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.entries.length, 2, "exact duplicates are collapsed on persistence");
  const kept = saved.entries.find((entry) => entry.type === "episodic");
  assert.equal(kept.id, "mem_b", "the stronger entry wins");
  assert.equal(kept.verification, "verified");
  assert(kept.tags.includes("debugging") && kept.tags.includes("architecture"), "tags are merged");
  assert(kept.supersedes.includes("mem_a"));
  assert(saved.audit.some((row) => row.action === "retention" && row.decisions.some((decision) => decision.action === "deduplicate-exact")));
  // Persistence is atomic and private: a crash can leave the previous file
  // intact, and no temporary sibling is left behind.
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((entry) => entry.endsWith(".tmp")), []);

  // Caps bound future growth and never delete verified entries to satisfy a cap.
  const capped = new CognitiveMemory({ clock, maxByType: { episodic: 2 } });
  capped.remember({ type: "episodic", title: "verified", content: "Verified fact survives.", verification: "verified", confidence: 0.9, provenance: { source: "user" } });
  for (let index = 0; index < 4; index++) capped.remember({ type: "episodic", title: `inferred-${index}`, content: `Inferred fact number ${index}.`, verification: "inferred", confidence: 0.1 + index * 0.01, provenance: { source: "session" } });
  const malformedCap = capped.boundByCount({ episodic: "not-a-number" });
  assert.equal(malformedCap.length, 0, "a malformed cap falls back to the documented default instead of pruning everything");
  assert.equal(capped.entries.size, 5);
  const pruned = capped.boundByCount({ episodic: 2 });
  assert.equal(pruned.length, 3, "only the excess non-verified entries are removed");
  assert.equal(capped.entries.size, 2, "the cap is met from the removable entries");
  assert([...capped.entries.values()].some((entry) => entry.verification === "verified"));
  assert(pruned.every((decision) => decision.action === "count-pruned" && decision.cap === 2));

  // Default caps sit above current steady-state volume so nothing is deleted now.
  assert.deepEqual(DEFAULT_MAX_BY_TYPE, { episodic: 5000, procedural: 3000, semantic: 1000, strategic: 300 });
  const steady = new CognitiveMemory({ clock });
  for (let index = 0; index < 10; index++) steady.remember({ type: "strategic", title: `goal-${index}`, content: `Strategic goal ${index}.`, verification: "inferred", confidence: 0.5, provenance: { source: "session" } });
  assert.equal(steady.boundByCount().length, 0);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("cognitive memory retention tests passed");
