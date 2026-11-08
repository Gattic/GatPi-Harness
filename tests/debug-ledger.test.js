"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  openThread,
  recordAttempt,
  resolveThread,
  listThreads,
  listThreadSummaries,
  showThread,
  formatThread,
  openThreadsSummary,
} = require("../src/debug-ledger.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("pi-debug-ledger-");

// Open a thread; slug is derived from the title.
const thread = openThread(cwd, "Models bouncing after ragdoll landing");
assert.equal(thread.status, "open");
assert.match(thread.threadId, /^models-bouncing/);

// Duplicate open returns the existing thread instead of forking a new one.
const again = openThread(cwd, "Models bouncing after ragdoll landing");
assert.equal(again.threadId, thread.threadId);
assert.equal(again.duplicate, true);

// Attempts accumulate hypothesis -> change -> observation -> verdict.
recordAttempt(cwd, thread.threadId, { hypothesis: "foot IK overshoot", change: "P2T_RAGDOLL_KNOB_FOOT_IK=0", observation: "issue still persists", verdict: "no-change" });
recordAttempt(cwd, thread.threadId, { hypothesis: "restitution too high", change: "restitution 0.4 -> 0.1", observation: "bounce smaller but present", verdict: "partial", evidence: ["logs/run-2.log"] });
const shown = showThread(cwd, thread.threadId);
assert.equal(shown.attempts.length, 2);
assert.equal(shown.attempts[0].verdict, "no-change");

// The formatted thread warns against retrying failed changes.
const text = formatThread(shown);
assert.match(text, /P2T_RAGDOLL_KNOB_FOOT_IK=0/);
assert.match(text, /no-change/);

// Open-thread summary is compact injectable context listing tried changes.
const summary = openThreadsSummary(cwd);
assert.match(summary, /models-bouncing/);
assert.match(summary, /2 attempts/);
assert.match(summary, /already tried/i);
assert.match(summary, /activate_tools or use \/debug-attempt/, "the injectable summary names the activation path when the tool is not declared");
const compact = listThreadSummaries(cwd, { status: "open" });
assert.equal(compact[0].attemptCount, 2);
assert.equal(Object.hasOwn(compact[0], "title"), false);
assert.equal(Object.hasOwn(compact[0].lastAttempt, "observation"), false);

// Durable free text is sanitized without weakening the ledger structure.
const assignmentValue = "S".repeat(24);
recordAttempt(cwd, thread.threadId, { hypothesis: "privacy fixture", change: "inspect producer", observation: `api_key=${assignmentValue}`, verdict: "unverified" });
const sanitized = showThread(cwd, thread.threadId);
assert.equal(sanitized.attempts.length, 3);
assert(!sanitized.attempts[2].observation.includes(assignmentValue));
assert(!fs.readFileSync(path.join(cwd, ".pi", "debug-ledger", `${thread.threadId}.json`), "utf8").includes(assignmentValue));

// Second thread; list filters by status.
openThread(cwd, "Water reflection broken on resize");
assert.equal(listThreads(cwd).length, 2);
resolveThread(cwd, thread.threadId, "restitution fix confirmed in scene test");
assert.equal(listThreads(cwd, { status: "open" }).length, 1);
assert.equal(showThread(cwd, thread.threadId).status, "resolved");

// Resolved threads drop out of the injectable summary.
assert.ok(!openThreadsSummary(cwd).includes("models-bouncing"));

// Unknown thread errors clearly.
assert.throws(() => recordAttempt(cwd, "nope", { observation: "x" }), /not found/i);

// Bounded rendering: recent attempts only, clipped fields, explicit omission count.
const bulk = tmpFixture("pi-debug-ledger-bulk-");
const bulkThread = openThread(bulk, "Many attempts bug");
for (let index = 0; index < 20; index++) {
  recordAttempt(bulk, bulkThread.threadId, {
    hypothesis: `hypothesis ${index} ${"h".repeat(300)}`,
    change: `change ${index} ${"c".repeat(300)}`,
    observation: `observed ${index}`,
    verdict: "no-change",
  });
}
const bounded = formatThread(showThread(bulk, bulkThread.threadId));
assert.match(bounded, /12 earlier attempt\(s\) omitted; call show with attemptLimit=20/);
assert.equal(bounded.split("\n").filter((line) => /^#\d+ \[/.test(line)).length, 8, "only the most recent attempts are rendered");
assert(!bounded.includes("c".repeat(250)), "attempt fields are clipped to the configured width");
assert(bounded.length < 8000, "the bounded thread stays small regardless of attempt count");
const full = formatThread(showThread(bulk, bulkThread.threadId), { attemptLimit: 20 });
assert.equal(full.split("\n").filter((line) => /^#\d+ \[/.test(line)).length, 20);
assert.match(full, /^#1 \[/m, "full rendering keeps the original attempt numbering");

// The injectable summary clips each tried change instead of replaying whole attempts.
const summaryBulk = openThreadsSummary(bulk);
assert(!summaryBulk.includes("c".repeat(220)), "the summary clips each tried change");
assert(summaryBulk.length < 4000, "the injectable summary stays bounded");

console.log("debug-ledger tests passed");
