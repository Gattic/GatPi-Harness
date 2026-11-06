#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(".pi/extensions/automation-loop/index.ts", "utf8");
const goalSource = fs.readFileSync(".pi/extensions/goal/index.ts", "utf8");
for (const command of ["loop", "ralph-loop", "loop-status", "loop-list", "loop-log", "loop-pause", "loop-resume", "loop-stop", "cancel-ralph", "loop-help"]) {
  assert.ok(source.includes(`pi.registerCommand("${command}"`), `${command} command must be registered`);
}
assert.match(source, /name: "automation_loop"/);
assert.match(source, /StringEnum\(\["status", "start", "checkpoint", "pause", "complete"\]/);
assert.match(source, /pi\.on\("agent_settled"/, "loop iterations must settle only after automatic retries, compaction, and queued work finish");
assert.doesNotMatch(source, /pi\.on\("agent_end"/, "low-level agent_end failures must not consume loop iterations");
assert.match(source, /deliverAs: "followUp"/, "settled continuation must use follow-up delivery");
assert.match(source, /pi\.on\("input"/, "extension-sourced loop continuations must be validated at delivery time");
assert.doesNotMatch(source, /pi\.on\("input", async/, "input validation must stay synchronous so print-mode commands cannot dispose the session before agent startup");
assert.match(source, /pi\.on\("agent_start".*baselineRefreshPending/s, "async baseline refresh belongs after the agent is active");
assert.match(source, /parseLoopDelivery/);
assert.match(source, /validateLoopDelivery/);
assert.match(source, /pendingContinuation/);
assert.match(source, /Dropped stale automation-loop continuation/);
assert.match(source, /managedWorkDependencies\(state\.iterationStartManagedWork, managedWork\)/, "settlement must scope managed work to jobs started during the iteration");
assert.match(source, /await waitThenQueueIteration\(/, "next iteration must await Pi-managed background work");
assert.match(source, /waitForManagedWork/, "background wait must poll bg_run and run_deck liveness");
assert.match(source, /state\.backgroundWait.*already waiting/s, "manual resume must not bypass an active background wait");
assert.match(source, /session_start.*waitThenQueueIteration/s, "an interrupted persisted background wait must restart with the session");
assert.match(source, /backgroundWaiters/, "only one waiter may queue a loop continuation");
assert.doesNotMatch(source, /setTimeout\(.*sendUserMessage/s, "headless continuation must not use a detached stale-context send timer");
assert.match(source, /ctx\.sendUserMessage/);
assert.match(source, /\["print", "json"\].*ctx\.waitForIdle/s, "non-interactive commands must stay alive until queued loop turns settle");
assert.match(source, /waitForCommandTurn/);
assert.match(source, /waitForQueuedAgentStart/, "command and continuation senders must await nested agent startup");
assert.match(source, /explicitAutomationIntent\(event\.text\)/, "tool start must require explicit current-user loop intent");
assert.match(source, /toolStartAuthorized\.get\(sid\) === true/);
assert.match(source, /start-eligibility/);
assert.match(source, /explicit-intent-required/);
assert.match(source, /completion-promise-required/);
assert.match(source, /completion-evidence-required/);
assert.match(source, /blockedToolResult/, "safety rejections must return canonical blocked details instead of tool errors");
assert.match(source, /recordTelemetry/, "start eligibility and rejections must emit metadata-only lifecycle telemetry");
assert.match(source, /completionGuidance\(state\)/, "promise-mode complete calls must return blocked guidance rather than a tool error");
assert.match(source, /getSessionId/);
assert.match(source, /prompt file symlink resolves outside/);
assert.match(source, /setTurnExitCode\(ctx, 1\)/);
assert.match(source, /PI_AUTOMATION_LOOP_ALLOW_UNBOUNDED/);
assert.match(source, /terminate: true/);
assert.match(source, /workspaceFingerprint/);
assert.match(source, /\.pi\/automation-loop\//, "workspace progress must exclude the loop's own state writes");
assert.match(source, /failed to queue iteration/);
assert.match(source, /pauseForAssistantFailure/, "terminal provider failures must pause without consuming an iteration");
assert.match(fs.readFileSync("src/automation-loop.js", "utf8"), /telemetry\.jsonl/);
assert.match(fs.readFileSync("src/automation-loop.js", "utf8"), /kind: terminal \? "terminal"/);
assert.match(source, /autonomous goal .* is already running/, "loop start must reject overlap with the goal runner");
assert.match(goalSource, /AutomationLoopStore/);
assert.match(goalSource, /Use \/loop-stop before starting \/goal/, "goal start must reject overlap with an open loop in the same Pi session");
assert.ok(fs.readFileSync(".gitignore", "utf8").includes(".pi/automation-loop/"), "automation loop runtime state must be ignored");
assert.ok(fs.readFileSync("scripts/extension-smoke-runner.js", "utf8").includes("discoverExtensionEntries"), "extension smoke fleet should auto-discover automation-loop and other extension entrypoints");

console.log("automation loop extension checks passed");
