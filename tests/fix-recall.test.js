"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { recallFixes, formatRecall, fixRecallEffectiveness, readRetrievals } = require("../src/fix-recall.js");
const { openThread, recordAttempt, resolveThread } = require("../src/debug-ledger.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("pi-fix-recall-");

// Seed a resolved debug thread with a known fix.
const t = openThread(cwd, "SIGSEGV in ragdoll joint solver under featherstone");
recordAttempt(cwd, t.threadId, { hypothesis: "joint index overflow", change: "clamp joint index in solver loop", observation: "no more crash in ragdoll suite", verdict: "fixed" });
resolveThread(cwd, t.threadId, "clamped joint index; regression test added");

// Seed an open thread (must rank but be labeled open) and learning outcomes.
openThread(cwd, "water reflection flicker on resize");
fs.mkdirSync(path.join(cwd, ".pi", "learning-loop"), { recursive: true });
fs.writeFileSync(path.join(cwd, ".pi", "learning-loop", "outcomes.jsonl"), [
  JSON.stringify({ outcomeId: "o1", source: "verification", task: { summary: "Fixed vitest timeout in subscription-env integration tests by mocking timers" }, signals: { status: "succeeded" } }),
].join("\n"));

// A matching crash recalls the resolved thread first, with what worked.
const privateError = "Aborted (SIGSEGV) in ragdoll featherstone joint step PRIVATE_ERROR_TEXT";
const hit = recallFixes(cwd, privateError);
assert.ok(hit.matches.length >= 1);
assert.equal(hit.matches[0].source, "debug-ledger");
assert.match(hit.matches[0].title, /ragdoll joint solver/);
assert.match(hit.matches[0].whatWorked, /clamp(ed)? joint index/i);
const text = formatRecall(hit);
assert.match(text, /you fixed something similar before/i);
assert.match(text, /clamp(ed)? joint index/i);
assert.match(text, new RegExp(hit.retrievalId));
assert.equal(readRetrievals(cwd).length, 1);
assert.doesNotMatch(fs.readFileSync(path.join(cwd, ".pi", "fix-recall", "retrievals.jsonl"), "utf8"), /PRIVATE_ERROR_TEXT|SIGSEGV|ragdoll/i, "retrieval telemetry stores no error/query text");
recordAttempt(cwd, t.threadId, { hypothesis: "recalled prior fix", change: "apply reviewed clamp", observation: "suite passes", verdict: "fixed", recallId: hit.retrievalId });
const effectiveness = fixRecallEffectiveness(cwd, { minimumAttributed: 1 });
assert.equal(effectiveness.status, "measured");
assert.equal(effectiveness.attributedAttempts, 1);
assert.equal(effectiveness.usefulAttempts, 1);

// Field-calibrated scoring keeps exact titles from being diluted by verbose histories.
const verbose = openThread(cwd, "Hermes advisory times out after fresh install");
for (let index = 0; index < 40; index++) recordAttempt(cwd, verbose.threadId, { hypothesis: `unrelated verbose hypothesis ${index}`, change: `unrelated verbose change ${index}`, observation: `unrelated verbose observation ${index}`, verdict: "no-change" });
recordAttempt(cwd, verbose.threadId, { hypothesis: "stale authentication readiness", change: "refresh readiness proof before recall", observation: "recall completed", verdict: "fixed" });
resolveThread(cwd, verbose.threadId, "refresh readiness proof and retry off path");
const exact = recallFixes(cwd, "Hermes advisory times out after fresh install", { expectedIds: [verbose.threadId] });
assert.equal(exact.matches[0].id, verbose.threadId);
assert.equal(exact.matches[0].matchedField, "exact-title");
assert.equal(fixRecallEffectiveness(cwd).knownMisses, 0);

// Learning outcomes are also recalled.
const vitestHit = recallFixes(cwd, "vitest timeout exceeded in subscription-env test");
assert.ok(vitestHit.matches.some((match) => match.source === "learning-loop"));

// Unrelated errors return no matches with honest guidance.
const miss = recallFixes(cwd, "npm ERR peer dependency conflict react@19", { expectedIds: ["known-missing-fixture"] });
assert.equal(miss.matches.length, 0);
assert.equal(fixRecallEffectiveness(cwd).knownMisses, 1, "known-thread misses and zero matches are measured");
assert.match(formatRecall(miss), /no similar/i);
assert.equal(fs.statSync(path.join(cwd, ".pi", "fix-recall")).mode & 0o777, 0o700);
assert.equal(fs.statSync(path.join(cwd, ".pi", "fix-recall", "retrievals.jsonl")).mode & 0o777, 0o600);

const pureCwd = tmpFixture("pi-fix-recall-pure-");
const pure = recallFixes(pureCwd, "unrecorded synthetic miss", { record: false });
assert.equal(pure.recorded, false);
assert.equal(pure.retrievalId, null);
assert.match(formatRecall(pure), /telemetry disabled/i);
assert.equal(fs.existsSync(path.join(pureCwd, ".pi", "fix-recall")), false, "record=false performs a pure read and creates no telemetry state");

console.log("fix-recall tests passed");
