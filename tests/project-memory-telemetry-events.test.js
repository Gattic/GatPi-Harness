"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ProjectMemoryAdapter } = require("../src/integration-boundary");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("project-memory-telemetry-");
const cwd = path.join(tmp, "repo"); const vault = path.join(tmp, "vault");
fs.mkdirSync(cwd); fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
const events = [];
const adapter = new ProjectMemoryAdapter({
  enabled: true,
  cwd,
  vault,
  writeEnabled: true,
  clock: () => new Date("2026-11-20T00:00:00Z"),
  sessionIdHash: () => "a".repeat(16),
  telemetry: { emit: (event) => events.push(event) },
});
const byName = (name) => events.filter((event) => event.name === name);

// A shadow proposal is recorded without being applied, and reports its hash.
const candidate = { kind: "decision", title: "Shadowed candidate", content: "Proposed but not applied at this stage.", verification: "verified" };
const shadowed = adapter.save(candidate, { apply: false });
assert.equal(shadowed.outcome, "shadowed");
const proposed = byName("shadow.proposed");
assert.equal(proposed.length, 1);
assert.equal(proposed[0].category, "memory_decision");
assert.equal(proposed[0].applied, false);
assert.equal(proposed[0].proposalHash, shadowed.decision.candidateHash);
assert.equal(proposed[0].sessionIdHash, "a".repeat(16));

// Repeated shadow writes for the same candidate must not inflate the sample.
adapter.save(candidate, { apply: false });
assert.equal(byName("shadow.proposed").length, 1, "one proposal per candidate");

// The first real decision resolves the proposal and reports agreement.
const saved = adapter.save(candidate, { apply: true, explicit: true });
assert.equal(saved.outcome, "saved");
const outcomes = byName("shadow.outcome");
assert.equal(outcomes.length, 1);
assert.equal(outcomes[0].proposalHash, shadowed.decision.candidateHash);
assert.equal(outcomes[0].applied, false, "the proposal itself was never applied");
assert.equal(outcomes[0].agreed, true);
assert.equal(outcomes[0].sessionIdHash, "a".repeat(16));

// Curation runs whenever a write is applied, and reports its outcome.
const curation = byName("curation.completed");
assert.equal(curation.length, 1);
assert.equal(curation[0].category, "memory_curation");
assert.equal(curation[0].outcome, "success");
assert.equal(curation[0].applied, true);
assert.equal(typeof curation[0].durationMs, "number");

// A duplicate save resolves nothing further: each proposal yields one outcome.
adapter.save(candidate, { apply: true, explicit: true });
assert.equal(byName("shadow.outcome").length, 1);

// Disagreement: a proposal that ends up in review is not an acceptance.
const reviewCandidate = { kind: "procedure", title: "Review candidate", content: "Proposed procedure that needs review before use.", verification: "verified" };
const reviewShadow = adapter.save(reviewCandidate, { apply: false });
assert.equal(reviewShadow.outcome, "shadowed");
adapter.consider(reviewCandidate, { queueReview: true, apply: true });
const disagreed = byName("shadow.outcome").filter((event) => event.proposalHash === reviewShadow.decision.candidateHash);
assert.equal(disagreed.length, 1);
assert.equal(disagreed[0].agreed, false, "a proposal that lands in review is a disagreement");

// A blocked curation run is an error, never a success.
fs.appendFileSync(adapter.store.notePath("decision"), `\nsk-${"Q".repeat(32)}\n`);
const blocked = adapter.compile({ apply: true });
assert.equal(blocked.outcome, "blocked");
const errors = byName("curation.completed").filter((event) => event.outcome === "error");
assert.equal(errors.length, 1);
assert.equal(errors[0].applied, false);
assert.equal(errors[0].reason, "canonical-integrity-failed");
assert(!JSON.stringify(events).includes("Q".repeat(32)), "telemetry never carries canonical content");

console.log("project-memory telemetry event tests passed");
