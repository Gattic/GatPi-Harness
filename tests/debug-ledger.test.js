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

console.log("debug-ledger tests passed");
