#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { extractSessionTurns, candidateFromTurn, sampleCandidates, applyReview, reviewSummary, evaluationReadiness, evaluateGold, MIN_REVIEWED } = require("../src/typesafe-gold.js");

const SECRET = `ghp_${"A".repeat(36)}`;
const user = (id, text) => ({ type: "message", id, message: { role: "user", content: [{ type: "text", text }] } });
const call = (id, name, args) => ({ type: "message", id, message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] } });

const entries = [
  { type: "session", id: "s1" },
  user("u1", `Start the training run in the background, token ${SECRET}`),
  call("a1", "run_deck", { operation: "status" }),
  user("u2", "/skill:handoff now"),
  user("u3", "What does this function return?"),
  user("u4", "ok"),
];
const turns = extractSessionTurns(entries, { sessionId: "s1" });
assert.equal(turns.length, 4, "one turn per user message");
assert.equal(turns[2].previousText, "/skill:handoff now");

const results = turns.map((turn) => candidateFromTurn(turn));
assert.equal(results[1].excluded, "explicit-invocation");
assert.equal(results[3].excluded, "too-short");
const first = results[0].candidate;
assert.equal(first.prompt.includes(SECRET), false, "candidates are redacted before they are written");
assert.deepEqual(first.labels, { modality: null });
assert.equal(first.review.status, "pending");
assert.ok(["dev", "test"].includes(first.split));
assert.equal(results[2].candidate.previous.includes("/skill:handoff"), true);

function row(id, extra = {}) {
  return { id, dedupeKey: `k-${id}`, split: "test", prompt: `p ${id}`, previous: null, labels: { modality: null }, review: { status: "pending", note: null }, ...extra };
}
const pool = [row("1"), row("2"), row("3"), row("4", { dedupeKey: "k-2" })];
assert.equal(sampleCandidates(pool, { count: 2 }).length, 2);
assert.equal(sampleCandidates(pool).filter((candidate) => candidate.dedupeKey === "k-2").length, 1, "duplicate prompts are sampled once");
assert.deepEqual(sampleCandidates(pool), sampleCandidates([...pool].reverse()), "sampling is deterministic");

const labeled = applyReview(row("8"), { modality: "investigation", status: "approved", note: "asks why it fails" });
assert.deepEqual(labeled.labels, { modality: "investigation" });
assert.equal(labeled.review.status, "approved");
assert.throws(() => applyReview(row("9"), { modality: "publish" }), /modality must be/, "protected modalities are never labels");

// Evaluation is refused until every row is reviewed and enough rows carry
// modality labels.
const blocked = evaluationReadiness([row("10")]);
assert.equal(blocked.ready, false);
assert.ok(blocked.reasons.includes("1-rows-pending-review"));
const MODALITIES = ["answer", "investigation", "planning", "implementation", "verification"];
const reviewed = [];
for (let i = 0; i < MIN_REVIEWED.modalityLabels; i++) reviewed.push(applyReview(row(`m${i}`, { split: i % 3 ? "test" : "dev" }), { status: "approved", modality: MODALITIES[i % MODALITIES.length] }));
reviewed.push(applyReview(row("unlabeled"), { status: "approved" }));
reviewed.push(applyReview(row("rejected"), { status: "rejected" }));
assert.equal(evaluationReadiness(reviewed).ready, true);
assert.equal(evaluationReadiness(reviewed.slice(1)).ready, false, "too few modality labels");
assert.equal(evaluationReadiness([...reviewed, row("x")]).ready, false);
assert.equal(reviewSummary(reviewed).approvedModalityLabels, MIN_REVIEWED.modalityLabels);

// A perfect judgment beats a regex that always answers "answer"; only labeled
// test rows are scored.
const answersFor = (candidate) => ({
  "intent::modality": { type: "choice", choice: candidate.labels.modality || "answer", probabilities: {}, confidence: 1 },
  "intent::research_memory": { type: "noul", noul: 0.1 },
});
const answersById = new Map(reviewed.filter((candidate) => candidate.review.status === "approved").map((candidate) => [candidate.id, answersFor(candidate)]));
const report = evaluateGold(reviewed, answersById, { regexModality: new Map(reviewed.map((candidate) => [candidate.id, "answer"])) });
assert.equal(report.rows.testModalityLabels, reviewed.filter((candidate) => candidate.split === "test" && candidate.labels.modality && candidate.review.status === "approved").length);
assert.equal(report.intent.typesafeModality, 1);
assert.ok(report.intent.regexModality < 0.5);
assert.deepEqual(report.intent.bars.map((bar) => [bar.name, bar.verdict]), [["modality-accuracy", "pass"]]);
const few = evaluateGold(reviewed.slice(5), answersById, { regexModality: new Map() });
assert.equal(few.intent.bars[0].verdict, "insufficient-data", "the bar needs the pre-registered number of labels");

console.log("typesafe gold tests passed");
