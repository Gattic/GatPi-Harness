#!/usr/bin/env node
"use strict";
const { tmpFixture } = require("./helpers/tmp-fixture");

// Completion enforcement regressions.
//
// Field evidence: an implementation request ended with "Stopping at this
// execution-budget checkpoint" even though pi imposes no execution budget, and
// the same session ended 45 turns after partial increments with required
// outcomes still open. These tests pin the decision rules that continue an
// authorized implementation turn, and pin that read-only requests stay
// read-only: an investigation request must never be pushed into mutation or
// continued as if it were unfinished implementation work. They also pin the
// boundaries enforcement must never cross: an aborted turn, an explicit user
// pause/scope limit, a clarification question, and another continuation owner.

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  COMPLETION_ENFORCEMENT_VERSION,
  DEFAULT_MAX_CONTINUATIONS,
  buildContinuationPrompt,
  classifyStopClaim,
  decideContinuation,
  detectUserBoundary,
  normalizeMaxContinuations,
} = require("../src/completion-enforcement.js");
const {
  USER_TASK_ENTRY_TYPE,
  buildTaskScaffold,
  classifyTaskModality,
  containsUnauthorizedMutationStep,
} = require("../src/task-modality.js");

assert.equal(COMPLETION_ENFORCEMENT_VERSION, "completion-enforcement-2026-10-25.3");
assert.equal(DEFAULT_MAX_CONTINUATIONS, 8);
assert.equal(normalizeMaxContinuations("3"), 3);
assert.equal(normalizeMaxContinuations("2.7"), 2);
assert.equal(normalizeMaxContinuations(0), 0, "0 means no continuations instead of silently becoming the default");
assert.equal(normalizeMaxContinuations("0"), 0);
assert.equal(normalizeMaxContinuations(-1), DEFAULT_MAX_CONTINUATIONS);
assert.equal(normalizeMaxContinuations(""), DEFAULT_MAX_CONTINUATIONS, "a blank control does not silently disable enforcement");
assert.equal(normalizeMaxContinuations("  "), DEFAULT_MAX_CONTINUATIONS);
assert.equal(normalizeMaxContinuations(null), DEFAULT_MAX_CONTINUATIONS);
assert.equal(normalizeMaxContinuations(" 0 "), 0);
assert.equal(normalizeMaxContinuations("not-a-number"), DEFAULT_MAX_CONTINUATIONS);

// --- Stop-claim vocabulary -------------------------------------------------

const fabricatedBudget = "Stopping at this execution-budget checkpoint. Root outcomes: 1/6 complete, 0 blocked.";
const fabricatedBudgetSignals = classifyStopClaim(fabricatedBudget);
assert.equal(fabricatedBudgetSignals.unsupportedLimit, true, "a named execution budget is recognized as an unevidenced limit");
assert.equal(fabricatedBudgetSignals.partialWork, true);
assert.equal(fabricatedBudgetSignals.evidencedBlocker, false);
for (const claim of [
  "I am pausing here due to the context budget; next steps: M4.",
  "I hit the turn limit for this turn.",
  "I have reached the execution budget for this session.",
  "Paused at the token budget checkpoint.",
]) {
  assert.equal(classifyStopClaim(claim).unsupportedLimit, true, claim);
}
assert.equal(classifyStopClaim("All required outcomes are complete and verified.").unsupportedLimit, false, "a completion claim is not a budget claim");

// Completion claims that negate remaining work, including a zero counter, must
// not be read as unfinished work.
for (const claim of [
  "Remaining work: 0.",
  "Remaining work: 0 items.",
  "Next: nothing.",
  "Everything is done. Next: nothing.",
  "Everything is done.",
  "All work is complete.",
  "All required outcomes are complete and verified.",
]) {
  assert.equal(classifyStopClaim(claim).completionClaim, true, claim);
}
assert.equal(classifyStopClaim("Remaining work: the executor.").completionClaim, false);

// A turn that reports only one increment, milestone, or step as finished has
// not claimed the required outcomes; that is partial work, not completion.
for (const claim of [
  "I am done with the first increment.",
  "The first increment is done.",
  "M1 complete.",
  "Phase 2 completed.",
  "Step 3 is finished.",
]) {
  assert.equal(classifyStopClaim(claim).partialWork, true, claim);
  assert.equal(classifyStopClaim(claim).completionClaim, false, claim);
}
assert.equal(classifyStopClaim("M4 complete. All required outcomes are complete and verified.").completionClaim, true, "an all-outcomes claim overrides the milestone-complete signal");

// --- Progress counters versus slash-separated identifiers ----------------
//
// Field evidence (pi-manager-tui session, 2026-10-25): a final message that
// listed remote hosts as "node-2/3/4/5/1" and stated "Every required
// outcome is complete" was continued five times. The host list's "3/4" was
// read as a partial counter because the word "outcome" appeared somewhere in
// the message, and the completion sentence was not recognized, so
// decideContinuation returned continue/partial-completion every time.
const hostList = "All 8 hosts online: node-2/3/4/5/1, home-server, queue-host, worker-host.";
assert.equal(classifyStopClaim(hostList).partialWork, false, "host suffixes are not a progress counter");
assert.equal(classifyStopClaim(`${hostList} Every required outcome is complete.`).partialWork, false, "an unrelated counter word does not turn host suffixes into a counter");
assert.equal(classifyStopClaim("host-03 runs relay v4 / bridge v5 and answers requests.").partialWork, false, "a version pair is not a progress counter");
assert.equal(classifyStopClaim("Relay v5/v5: outcomes are still open.").partialWork, false, "a slash-separated version is not a counter");

// A ratio counts only when a counter label names it in the same clause, so a
// real partial counter still reports partial work.
for (const claim of [
  "Root outcomes: 1/6 complete, 0 blocked.",
  "Root outcomes: 3/4 complete, 0 blocked.",
  "Workflow 150/167 complete; next: M4.",
  "3/4 milestones complete.",
  "Items: 2/5 done.",
]) {
  assert.equal(classifyStopClaim(claim).partialWork, true, claim);
  assert.equal(classifyStopClaim(claim).completionClaim, false, claim);
  assert.equal(decideContinuation({ modality: "implementation", text: claim }).action, "continue", claim);
}
assert.equal(decideContinuation({ modality: "implementation", text: `${hostList} Root outcomes: 1/6 complete.` }).action, "continue", "a real open counter is not masked by a host list");

// A completed counter is a completion claim and settles instead of
// continuing; it settles only when no counter still reports open work.
for (const claim of [
  "Root outcomes: 6/6 complete, 0 blocked.",
  "Outcomes: 3/3 complete.",
  "Workflow 167/167 complete.",
]) {
  assert.equal(classifyStopClaim(claim).partialWork, false, claim);
  assert.equal(classifyStopClaim(claim).completionClaim, true, claim);
  assert.equal(decideContinuation({ modality: "implementation", text: claim }).reason, "completion-claim", claim);
}
assert.equal(classifyStopClaim("M1: 2/2 complete. Root outcomes: 1/6 complete.").completionClaim, false, "a finished increment counter does not hide an open root counter");
assert.equal(decideContinuation({ modality: "implementation", text: "M1: 2/2 complete. Root outcomes: 1/6 complete." }).action, "continue");

// Completion phrasings that name the finished scope must settle too.
for (const claim of [
  "Every required outcome is complete.",
  "Every required outcome is complete and nothing in the authorized scope remains.",
  "Nothing else remains to do.",
  "No further authorized outcome exists.",
  "The authorized work is complete.",
]) {
  assert.equal(classifyStopClaim(claim).completionClaim, true, claim);
  assert.equal(decideContinuation({ modality: "implementation", text: claim }).action, "settle", claim);
}

// Transcript reproduction: these final messages from the pi-manager-tui
// session were each continued as "partial-completion" before the fix, even
// though they reported the required outcomes complete.
const transcriptFinals = [
  [
    "Re-checked once more (21:56) and added a live-streaming verification. Every required outcome is complete and nothing in the authorized scope remains.",
    "- `pi-dash-host list`: all 8 hosts online — node-2/3/4/5/1, home-server, queue-host, worker-host.",
    "- Remote request path proven: host-home `projects`=9, `sessions`=3; host-02 `projects`=3, `sessions`=1.",
    "## Required outcomes: 3/3 complete",
    "The loop's premise — that outstanding work remains — is exhausted: no failure, dependency, or ambiguity blocks completion.",
  ].join("\n"),
  [
    "Re-checked current state at 21:45–21:46 local time. Everything required is complete and still healthy.",
    "- `pi-dash-host list`: all 8 hosts online — node-2/3/4/5/1, home-server, queue-host, worker-host.",
    "## Required outcomes: 3/3 complete",
  ].join("\n"),
];
for (const text of transcriptFinals) {
  const signals = classifyStopClaim(text);
  assert.equal(signals.partialWork, false, "a transcript host list is not a partial counter");
  assert.equal(signals.completionClaim, true, "the transcript states the required outcomes are complete");
  assert.equal(decideContinuation({ modality: "implementation", text }).action, "settle", text.slice(0, 60));
}

// A question anywhere in the final message is a decision boundary; asking to
// proceed is handled separately.
assert.equal(classifyStopClaim("Which database should I use?").asksQuestion, true);
assert.equal(classifyStopClaim("No question here.").asksQuestion, false);

// --- User-stated boundaries ------------------------------------------------

for (const boundary of [
  "Implement M1 only; do not continue past M1.",
  "Implement the parser, then stop.",
  "Implement the parser and stop.",
  "Stop.",
  "Stop after M1 and implement the parser.",
  "Pause here.",
  "Continue the parser work up to M2.",
  "Do not go further than the lexer.",
  "Only do M1.",
  "Just do M1.",
  "Implement M1 and nothing else.",
  "Implement M1, not M2.",
  "Leave the rest for later.",
  "Implement the parser for now.",
]) {
  assert.equal(detectUserBoundary(boundary), true, boundary);
}
for (const notBoundary of [
  "Do not stop until all tests pass.",
  "Do not pause the build.",
  "Implement the parser and stop when the tests pass.",
  "Implement the parser and stop once the build is green.",
  "Do not continue until the tests pass.",
  "Fix the parser. Do not commit or merge.",
  "Implement the parser and stop the server.",
  "Implement the parser and stop when done.",
  "Implement the parser and stop once finished.",
  "Implement and never end.",
  "Implement only the authorized parser changes.",
  "Continue",
  "Implement the parser and make all tests pass.",
]) {
  assert.equal(detectUserBoundary(notBoundary), false, notBoundary);
}

// --- Decision table --------------------------------------------------------

const decisions = [
  // action, reason, modality, text, options
  ["continue", "unsupported-limit-claim", "implementation", fabricatedBudget],
  ["continue", "partial-completion", "implementation", "Root outcomes: 1/6 complete, 0 blocked. Next: generic implementation schemes."],
  ["continue", "partial-completion", "implementation", "Finished the parser module. Remaining work: the executor."],
  ["continue", "partial-completion", "implementation", "The implementation is still incomplete."],
  ["continue", "partial-completion", "implementation", "Not fully implemented; the executor remains."],
  ["continue", "partial-completion", "implementation", "I am done with the first increment."],
  ["continue", "partial-completion", "implementation", "M1 complete."],
  ["settle", "no-stop-signal", "implementation", "I have incomplete information about the parser."],
  ["continue", "proceed-request", "implementation", "Should I continue with the remaining 5 outcomes?"],
  ["settle", "user-question", "implementation", "Which database should I use for the executor? Remaining work: the executor."],
  ["settle", "authorization-boundary", "implementation", "Is it acceptable to delete the old fixtures? Remaining work: M2."],
  ["settle", "user-question", "implementation", "Stopping at this execution-budget checkpoint. Any objections?"],
  ["settle", "evidenced-blocker", "implementation", "Blocked: the required toolchain is missing (evidence: build.log exit code 127)."],
  ["settle", "evidenced-blocker", "implementation", "Tests fail: exit code 1 (stderr in tests.log)."],
  ["settle", "authorization-boundary", "implementation", "May I pause older GatticLang Pi process 708118?"],
  ["settle", "authorization-boundary", "implementation", "Approve 64 MiB additional allowance, preserving all history and the 1 GiB build cap?"],
  ["settle", "waiting-on-managed-work", "implementation", "I will wait for the monitor to notify me when job-mvmwznvk-34bf settles."],
  ["settle", "completion-claim", "implementation", "All 6 root outcomes are complete; nothing remains pending."],
  ["settle", "completion-claim", "implementation", "Remaining work: 0."],
  ["settle", "completion-claim", "implementation", "Everything is done. Next: nothing."],
  ["continue", "partial-completion", "implementation", "Workflow 150/167 complete; next: M4."],
  ["settle", "completion-claim", "implementation", "Root outcomes: 6/6 complete, 0 blocked."],
  ["settle", "completion-claim", "implementation", "Remaining work: none. Next steps: none."],
  ["settle", "empty-final-message", "implementation", "   "],
  ["settle", "no-stop-signal", "implementation", "Here is the summary of what I did."],
  ["settle", "read-only-or-non-implementation", "investigation", fabricatedBudget],
  ["settle", "read-only-or-non-implementation", "planning", "Remaining work: 3 milestones."],
  ["settle", "read-only-or-non-implementation", "verification", "Tests fail; next steps: repair."],
  ["settle", "read-only-or-non-implementation", "answer", "Root outcomes: 1/6 complete."],
];
for (const [action, reason, modality, text] of decisions) {
  const decision = decideContinuation({ modality, text });
  assert.equal(decision.action, action, `${modality}: ${text}`);
  assert.equal(decision.reason, reason, `${modality}: ${text}`);
}

// An explicit user pause or scope limit wins over enforcement, even when the
// turn itself looks like a partial increment.
assert.equal(decideContinuation({ modality: "implementation", text: fabricatedBudget, userBoundary: true }).reason, "user-boundary");
assert.equal(decideContinuation({ modality: "implementation", text: "Should I continue with M2?", userBoundary: true }).reason, "user-boundary");
assert.equal(decideContinuation({ modality: "implementation", text: fabricatedBudget, userBoundary: false }).action, "continue");

// Enforcement is bounded so an unsatisfiable implementation cannot loop forever.
for (const count of [0, 1, 2]) {
  assert.equal(decideContinuation({ modality: "implementation", text: fabricatedBudget, continuationCount: count, maxContinuations: 3 }).action, "continue", `continuation ${count}`);
}
assert.equal(decideContinuation({ modality: "implementation", text: fabricatedBudget, continuationCount: 3, maxContinuations: 3 }).reason, "continuation-cap");
assert.equal(decideContinuation({ modality: "implementation", text: fabricatedBudget, continuationCount: 99 }).reason, "continuation-cap");
assert.equal(decideContinuation({ modality: "implementation", text: fabricatedBudget, maxContinuations: 0 }).reason, "continuation-cap", "a zero bound disables continuations");

// --- Continuation prompt ---------------------------------------------------

const prompt = buildContinuationPrompt("Implement the parser plan in full.");
assert.match(prompt, /every required outcome/, "the continuation restates the completion requirement");
assert.match(prompt, /no harness execution budget/i, "the continuation names the absent budget so the model cannot re-invent it");
assert.match(prompt, /evidenced blocker or an explicit user decision/, "the continuation names the only legitimate stop conditions");
assert.match(prompt, /Implement the parser plan in full\./, "the continuation preserves the authorized scope");
assert(buildContinuationPrompt("x".repeat(1_000)).length < 800, "the continuation prompt stays bounded");

// --- Read-only requests stay read-only -------------------------------------

const readOnlyPrompts = [
  "Investigate why the parser fails. Do not edit anything.",
  "Review the implementation without edits.",
  "Report what remains.",
  "Plan how to finish the implementation.",
  "Did we implement all of the recommendations in plan-update.md in full?",
];
for (const readOnlyPrompt of readOnlyPrompts) {
  const classification = classifyTaskModality(readOnlyPrompt);
  assert.notEqual(classification.modality, "implementation", readOnlyPrompt);
  assert.equal(classification.readOnly, true, readOnlyPrompt);
  assert.equal(classification.mutationAllowed, false, readOnlyPrompt);
  assert.equal(containsUnauthorizedMutationStep(buildTaskScaffold(readOnlyPrompt)), false, readOnlyPrompt);
  const decision = decideContinuation({ modality: classification.modality, text: "Root outcomes: 1/6 complete. Next: continue the work." });
  assert.equal(decision.action, "settle", `${readOnlyPrompt} must not be continued as implementation work`);
  assert.equal(decision.reason, "read-only-or-non-implementation");
}

// A report-style prompt that still asks for tests to pass is an implementation
// request: the 2026-10-21 field session classified "review + make tests pass"
// as investigation, so the injected scaffold declared mutation unauthorized and
// the turn ended with a report instead of the repair.
for (const implementationPrompt of [
  "Review the parser and make all tests pass.",
  "Make all tests pass.",
  "Review the parser and get all tests passing.",
  "Review the parser and ensure the tests pass.",
  "Review the parser and keep the build green.",
  "Review the parser and fix its off-by-one bug.",
]) {
  const classification = classifyTaskModality(implementationPrompt);
  assert.equal(classification.modality, "implementation", implementationPrompt);
  assert.equal(classification.readOnly, false, implementationPrompt);
  assert.equal(classification.mutationAllowed, true, implementationPrompt);
  assert.equal(decideContinuation({ modality: classification.modality, text: fabricatedBudget }).action, "continue", implementationPrompt);
}

// Writing a note is a mutation, so "make a note that tests pass" stays an
// implementation request; the phrase is not a report-only request.
assert.equal(classifyTaskModality("Make a note that tests pass.").modality, "implementation");

// Report requests that only ask for an explanation stay investigation even
// though they mention fixing something.
for (const investigationPrompt of [
  "Review the parser and explain how to fix it.",
  "Review the parser and report what changes remain.",
]) {
  const classification = classifyTaskModality(investigationPrompt);
  assert.equal(classification.modality, "investigation", investigationPrompt);
  assert.equal(classification.mutationAllowed, false, investigationPrompt);
}

// --- Extension wiring ------------------------------------------------------

const extensionSource = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "completion-enforcement", "index.ts"), "utf8");
assert.match(extensionSource, /on\("agent_settled"/, "enforcement runs when a turn settles");
assert.match(extensionSource, /event\?\.aborted/, "an aborted turn is never continued");
assert.match(extensionSource, /on\("input"/, "the extension tracks the user's objective and modality");
assert.match(extensionSource, /detectUserBoundary/, "explicit user pauses and scope limits are tracked");
assert.match(extensionSource, /PI_COMPLETION_ENFORCEMENT/, "enforcement has an explicit environment gate");
assert.match(extensionSource, /PI_COMPLETION_MAX_CONTINUATIONS/, "the continuation bound is configurable");
assert.match(extensionSource, /completion-enforcement-status/, "the decision trail is inspectable");
assert.match(extensionSource, /source === "extension"/, "extension-authored prompts keep the user's objective instead of replacing it");
assert.match(extensionSource, /session_shutdown/, "a queued continuation is cleared on shutdown");
assert.match(extensionSource, /scheduleContinuation/, "the continuation is re-checked after other settled handlers run");
assert.match(extensionSource, /commandTurn/, "slash-command turns are not enforced under the previous objective");
assert.match(extensionSource, /type === "compaction"/, "assistant messages older than a compaction boundary are stale");

// --- Behavioral run of the real extension (skipped without a pi install) ---

let piPackageRoot = null;
try {
  const candidate = path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
  if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
} catch {}
if (!piPackageRoot) {
  console.log("completion enforcement tests passed (extension behavior skipped: global pi install not found)");
  process.exit(0);
}

function runtimePackage(packageName, workspaceName) {
  const installed = path.join(piPackageRoot, "node_modules", "@earendil-works", packageName);
  if (fs.existsSync(path.join(installed, "package.json"))) return fs.realpathSync(installed);
  return fs.realpathSync(path.resolve(piPackageRoot, "..", workspaceName));
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

(async () => {
  const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
  const createJiti = jitiModule.createJiti || jitiModule;
  const extensionFile = path.resolve(".pi/extensions/completion-enforcement/index.ts");
  const aiRoot = runtimePackage("pi-ai", "ai");
  const jiti = createJiti(extensionFile, {
    interopDefault: true,
    alias: {
      typebox: require.resolve("typebox", { paths: [piPackageRoot] }),
      "@earendil-works/pi-coding-agent": piPackageRoot,
      "@earendil-works/pi-ai/compat": path.join(aiRoot, "dist", "compat.js"),
      "@earendil-works/pi-ai": aiRoot,
      "@earendil-works/pi-tui": runtimePackage("pi-tui", "tui"),
      "@earendil-works/pi-agent-core": runtimePackage("pi-agent-core", "agent"),
    },
  });
  const mod = await jiti.import(extensionFile);
  const fn = mod.default || mod;
  assert.equal(typeof fn, "function");

  const cwd = tmpFixture("pi-completion-enforcement-");
  const noop = () => {};

  // Each mount simulates one process load: the environment gate and bound are
  // read when the factory runs, as they are on startup or /reload.
  function mount({ enabled = "1", max = "3" } = {}) {
    const previousEnabled = process.env.PI_COMPLETION_ENFORCEMENT;
    const previousMax = process.env.PI_COMPLETION_MAX_CONTINUATIONS;
    process.env.PI_COMPLETION_ENFORCEMENT = enabled;
    process.env.PI_COMPLETION_MAX_CONTINUATIONS = max;
    const hooks = [];
    const commands = [];
    const sent = [];
    const notifications = [];
    const api = {
      on: (event, handler) => hooks.push({ event, handler }),
      registerCommand: (name) => commands.push(name),
      registerTool: noop,
      registerShortcut: noop,
      registerMessageRenderer: noop,
      getCommands: () => [],
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools: noop,
      sendUserMessage: (text) => sent.push(text),
      sendMessage: noop,
      events: { on: noop, off: noop, emit: noop },
      system: { addSystemPrompt: noop },
      appendSystemPrompt: noop,
    };
    fn(api);
    process.env.PI_COMPLETION_ENFORCEMENT = previousEnabled;
    process.env.PI_COMPLETION_MAX_CONTINUATIONS = previousMax;

    const session = { branch: [] };
    const ctx = {
      cwd,
      hasUI: true,
      ui: { notify: (text, level) => notifications.push({ text, level }) },
      idle: true,
      pending: false,
      isIdle: () => ctx.idle,
      hasPendingMessages: () => ctx.pending,
      sessionManager: { getBranch: () => session.branch, getSessionId: () => "session-test" },
    };
    const hook = (event) => {
      const row = hooks.find((entry) => entry.event === event);
      assert(row, `extension registers ${event}`);
      return row.handler;
    };
    const input = (text, source = "user") => hook("input")({ type: "input", text, source }, ctx);
    const settle = async (id, text, { stopReason = "stop", aborted = false } = {}) => {
      session.branch = [{ type: "message", id, message: { role: "assistant", content: [{ type: "text", text }], stopReason } }];
      hook("agent_settled")({ aborted }, ctx);
      await tick();
    };
    const settleBranch = async (entries, event = {}) => {
      session.branch = entries;
      hook("agent_settled")(event, ctx);
      await tick();
    };
    return { hooks, commands, sent, notifications, ctx, session, hook, input, settle, settleBranch };
  }

  const assistantEntry = (id, text, stopReason = "stop") => ({ type: "message", id, message: { role: "assistant", content: [{ type: "text", text }], stopReason } });
  const userEntry = (text) => ({ type: "message", id: `user-${text.length}-${Math.random()}`, message: { role: "user", content: [{ type: "text", text }] } });

  try {
    // --- Baseline enforcement ---------------------------------------------
    const base = mount();
    assert(base.commands.includes("completion-enforcement-status"));
    base.hook("session_start")({}, base.ctx);

    base.input("Implement the parser and make all tests pass.");
    await base.settle("a1", fabricatedBudget);
    assert.equal(base.sent.length, 1, "the implementation turn is continued instead of accepted as settled");
    assert.match(base.sent[0], /every required outcome/);
    assert.match(base.sent[0], /Implement the parser and make all tests pass\./, "the continuation keeps the user's objective");
    await base.settle("a1", fabricatedBudget);
    assert.equal(base.sent.length, 1, "the same settled message is never continued twice");

    await base.settle("a2", "All required outcomes are complete and verified.");
    assert.equal(base.sent.length, 1);

    // --- Transcript false positive: a completed turn is not continued -----
    // Field evidence (pi-manager-tui session, 2026-10-25): this message was
    // continued five times because the host list "node-2/3/4/5/1" was read
    // as "3/4 complete" while the completion sentence was not recognized.
    const transcript = mount();
    transcript.hook("session_start")({}, transcript.ctx);
    transcript.input("I just restarted our pi dash but don't see any of my other machines responding even though everything was working fine before I restarted pi dash. Investigate and fix.");
    await transcript.settle("transcript-1", transcriptFinals[0]);
    assert.equal(transcript.sent.length, 0, "a completed turn that lists hosts is not continued");
    await transcript.settle("transcript-2", "Re-checked current state at 21:45–21:46 local time. Everything required is complete and still healthy.\n## Required outcomes: 3/3 complete");
    assert.equal(transcript.sent.length, 0, "a completed outcome counter is not continued");

    // --- Aborted and non-stop turns are user/system decisions --------------
    base.input("Implement the parser and make all tests pass.");
    await base.settle("abort-1", fabricatedBudget, { aborted: true });
    assert.equal(base.sent.length, 1, "an aborted turn is never continued");
    assert.equal(base.sent.length, 1, "an aborted turn records a settle decision");

    await base.settle("abort-2", fabricatedBudget, { stopReason: "aborted" });
    assert.equal(base.sent.length, 1, "an aborted stop reason is never continued");
    await base.settle("abort-3", fabricatedBudget, { stopReason: "error" });
    assert.equal(base.sent.length, 1, "an errored turn is never continued");
    await base.settle("abort-4", fabricatedBudget, { stopReason: "length" });
    assert.equal(base.sent.length, 1, "an output-limited turn is never continued");

    // --- A stale assistant message is not judged across a user message -----
    await base.settleBranch([assistantEntry("stale-1", fabricatedBudget), userEntry("Implement the parser.")]);
    assert.equal(base.sent.length, 1, "an assistant message older than a user message is stale");
    await base.settleBranch([assistantEntry("compaction-1", fabricatedBudget), { type: "compaction", id: "comp-1", summary: "Prior work summarized." }]);
    assert.equal(base.sent.length, 1, "an assistant message older than a compaction boundary is stale");

    // --- Another continuation owner wins ----------------------------------
    base.input("Implement the parser and make all tests pass.");
    base.session.branch = [assistantEntry("owner-1", fabricatedBudget)];
    base.hook("agent_settled")({}, base.ctx);
    base.ctx.pending = true;
    await tick();
    assert.equal(base.sent.length, 1, "a queued continuation yields to messages pending after settle");
    base.ctx.pending = false;

    // A pending message present at settle time is skipped before scheduling.
    base.session.branch = [assistantEntry("owner-2", fabricatedBudget)];
    base.ctx.pending = true;
    base.hook("agent_settled")({}, base.ctx);
    await tick();
    assert.equal(base.sent.length, 1, "pending messages at settle time are respected");
    base.ctx.pending = false;

    // --- User-stated boundary is authoritative ----------------------------
    base.input("Implement M1 only; do not continue past M1.");
    await base.settle("boundary-1", "Pausing here as you requested; remaining work: M2.");
    assert.equal(base.sent.length, 1, "an explicit user pause or scope limit is never overridden");
    await base.settle("boundary-2", "Should I continue with M2?");
    assert.equal(base.sent.length, 1, "the user's boundary also wins over a proceed request");
    base.input("Now implement M2 and make all tests pass.");
    await base.settle("boundary-3", fabricatedBudget);
    assert.equal(base.sent.length, 2, "a new instruction replaces the earlier boundary");
    assert.match(base.sent[1], /Now implement M2 and make all tests pass\./);

    // --- A clarification question is not answered by the harness ----------
    base.input("Implement the parser and make all tests pass.");
    await base.settle("question-1", "Which database should I use for the executor? Remaining work: the executor.");
    assert.equal(base.sent.length, 2, "a clarification question is a decision boundary");
    await base.settle("question-2", "Is it acceptable to delete the old fixtures? Remaining work: M2.");
    assert.equal(base.sent.length, 2, "an approval question is a decision boundary");

    // --- Slash commands do not replace the objective or get enforced ------
    base.input("Implement the parser and make all tests pass.");
    base.input("/skill:review", "user");
    await base.settle("slash-1", fabricatedBudget);
    assert.equal(base.sent.length, 2, "a slash-command/skill turn is not continued under the previous implementation objective");
    base.input("Now implement M2 and make all tests pass.");
    await base.settle("slash-2", fabricatedBudget);
    assert.equal(base.sent.length, 3, "a real instruction resumes enforcement");
    assert.match(base.sent[2], /Now implement M2 and make all tests pass\./, "unexpanded slash commands are not task objectives");

    // --- Cap notification fires once --------------------------------------
    base.input("Implement the parser and make all tests pass.");
    for (let index = 0; index < 3; index += 1) await base.settle(`cap-${index}`, "Root outcomes: 1/6 complete, 0 blocked.");
    assert.equal(base.sent.length, 6, "the configured continuation bound is honored");
    await base.settle("cap-3", "Root outcomes: 1/6 complete, 0 blocked.");
    assert.equal(base.sent.length, 6, "no continuation is sent past the cap");
    const capWarnings = base.notifications.filter((entry) => /continuation cap reached/.test(entry.text));
    assert.equal(capWarnings.length, 1, "reaching the cap is reported instead of silently stopping");
    assert.equal(capWarnings[0].level, "warning");
    await base.settle("cap-4", "Root outcomes: 1/6 complete, 0 blocked.");
    assert.equal(base.notifications.filter((entry) => /continuation cap reached/.test(entry.text)).length, 1, "the cap notice is not repeated every settle");
    base.input("Implement the parser and make all tests pass.");
    await base.settle("cap-reset", fabricatedBudget);
    assert.equal(base.sent.length, 7, "a new user instruction resets the continuation budget");

    // --- Extension prompts keep the established objective ------------------
    base.input(buildContinuationPrompt("Implement the parser plan in full."), "extension");
    await base.settle("a6", "Root outcomes: 1/6 complete, 0 blocked.");
    assert.equal(base.sent.length, 8);
    assert.match(base.sent[7], /Implement the parser and make all tests pass\./, "extension prompts do not replace the user's objective");

    // --- A zero bound disables continuations and says so -------------------
    const zero = mount({ max: "0" });
    zero.hook("session_start")({}, zero.ctx);
    zero.input("Implement the parser and make all tests pass.");
    await zero.settle("zero-1", fabricatedBudget);
    assert.equal(zero.sent.length, 0, "PI_COMPLETION_MAX_CONTINUATIONS=0 disables continuations");
    assert.equal(zero.notifications.filter((entry) => /continuation cap reached \(0\)/.test(entry.text)).length, 1, "the disabled bound is reported");

    // --- The environment gate disables enforcement ------------------------
    const off = mount({ enabled: "0" });
    off.hook("session_start")({}, off.ctx);
    off.input("Implement the parser and make all tests pass.");
    await off.settle("off-1", fabricatedBudget);
    assert.equal(off.sent.length, 0, "PI_COMPLETION_ENFORCEMENT=0 disables enforcement");

    // --- A resumed session seeds the objective and its boundary -----------
    const resumed = mount();
    resumed.session.branch = [{ type: "custom", customType: USER_TASK_ENTRY_TYPE, data: { objective: "Implement the parser plan in full." } }];
    resumed.hook("session_start")({}, resumed.ctx);
    await resumed.settle("resume-1", fabricatedBudget);
    assert.equal(resumed.sent.length, 1, "a resumed implementation session is enforced");
    assert.match(resumed.sent[0], /Implement the parser plan in full\./, "the recorded objective seeds the continuation");

    const resumedBoundary = mount();
    resumedBoundary.session.branch = [{ type: "custom", customType: USER_TASK_ENTRY_TYPE, data: { objective: "Implement M1 only; do not continue past M1." } }];
    resumedBoundary.hook("session_start")({}, resumedBoundary.ctx);
    await resumedBoundary.settle("resume-2", "Pausing here; remaining work: M2.");
    assert.equal(resumedBoundary.sent.length, 0, "a recorded user boundary survives a session resume");

    // --- Shutdown clears a queued continuation ----------------------------
    const shutdown = mount();
    shutdown.hook("session_start")({}, shutdown.ctx);
    shutdown.input("Implement the parser and make all tests pass.");
    shutdown.session.branch = [assistantEntry("shutdown-1", fabricatedBudget)];
    shutdown.hook("agent_settled")({}, shutdown.ctx);
    shutdown.hook("session_shutdown")();
    await tick();
    assert.equal(shutdown.sent.length, 0, "a continuation queued at settle is cleared on shutdown");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  console.log("completion enforcement tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
