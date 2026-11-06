"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  readSession,
  sessionLeaves,
  transcriptFromEntries,
  connectedSessionFamily,
  listSessionMetadata,
  sameFocusTargets,
  readSubagentRecords,
  buildFocusTargets,
  transcriptForTarget,
  stepStripNavigation,
  stepFocusNavigation,
  packTabRows,
} = require("../src/chat-focus");
const { tmpFixture } = require("./helpers/tmp-fixture");

function writeSession(file, header, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [header, ...entries].map((row) => JSON.stringify(row)).join("\n") + "\n");
}

const tmp = tmpFixture("pi-chat-focus-");
const rootFile = path.join(tmp, "sessions", "main.jsonl");
const forkFile = path.join(tmp, "sessions", "fork.jsonl");
const subFile = path.join(tmp, ".pi", "subagents", "rpc-sessions", "sub_worker", "worker.jsonl");
const rootEntries = [
  { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "Start main" } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "Main answer" }] } },
  { type: "message", id: "u2", parentId: "a1", timestamp: "2026-01-01T00:00:03Z", message: { role: "user", content: "Explore first path" } },
  { type: "message", id: "a2", parentId: "u2", timestamp: "2026-01-01T00:00:04Z", message: { role: "assistant", content: [{ type: "text", text: "First path result" }] } },
  { type: "message", id: "u3", parentId: "a1", timestamp: "2026-01-01T00:00:05Z", message: { role: "user", content: "Explore canonical path" } },
  { type: "message", id: "a3", parentId: "u3", timestamp: "2026-01-01T00:00:06Z", message: { role: "assistant", content: [{ type: "text", text: "Canonical result" }] } },
];
writeSession(rootFile, { type: "session", version: 3, id: "sess_main", timestamp: "2026-01-01T00:00:00Z", cwd: tmp }, rootEntries);
writeSession(forkFile, { type: "session", version: 3, id: "sess_fork", timestamp: "2026-01-02T00:00:00Z", cwd: tmp, parentSession: rootFile }, [
  { type: "message", id: "fu1", parentId: null, timestamp: "2026-01-02T00:00:01Z", message: { role: "user", content: "Fork task" } },
  { type: "message", id: "fa1", parentId: "fu1", timestamp: "2026-01-02T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "Fork answer" }] } },
]);
writeSession(subFile, { type: "session", version: 3, id: "sess_sub", timestamp: "2026-01-03T00:00:00Z", cwd: tmp }, [
  { type: "message", id: "su1", parentId: null, timestamp: "2026-01-03T00:00:01Z", message: { role: "user", content: "Worker task" } },
  { type: "message", id: "sa1", parentId: "su1", timestamp: "2026-01-03T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "Worker progress" }] } },
]);
fs.mkdirSync(path.join(tmp, ".pi", "subagents", "records"), { recursive: true });
const recoveryWorkspace = path.join(tmp, ".pi", "subagents", "workspaces", "sub_worker");
fs.mkdirSync(recoveryWorkspace, { recursive: true });
fs.writeFileSync(path.join(tmp, ".pi", "subagents", "records", "sub_worker.json"), JSON.stringify({
  id: "sub_worker", parentSessionId: "sess_main", role: "planner", task: "Plan the implementation", status: "running", createdAt: "2026-01-03T00:00:00Z", workspace: { retained: true, path: recoveryWorkspace },
}));
fs.mkdirSync(path.join(tmp, ".pi", "subagents", "results"), { recursive: true });
fs.writeFileSync(path.join(tmp, ".pi", "subagents", "results", "sub_worker.json"), JSON.stringify({ summary: "Worker result pending" }));

const sessions = [
  { path: rootFile, id: "sess_main", cwd: tmp, created: new Date("2026-01-01"), modified: new Date("2026-01-01"), firstMessage: "Start main" },
  { path: forkFile, id: "sess_fork", cwd: tmp, parentSessionPath: rootFile, created: new Date("2026-01-02"), modified: new Date("2026-01-02"), firstMessage: "Fork task" },
];

const metadata = listSessionMetadata({ cwd: tmp, currentSessionFile: rootFile });
assert.deepEqual(metadata.map((info) => info.id), ["sess_fork", "sess_main"], "metadata scans should discover project sessions without materializing every transcript");
assert(metadata.every((info) => !("allMessagesText" in info)), "Chat Focus metadata should not retain aggregate transcript text");

const noNewlineFile = path.join(tmp, "sessions", "no-newline.jsonl");
fs.writeFileSync(noNewlineFile, [
  { type: "session", version: 3, id: "sess_no_newline", timestamp: "2026-01-01T00:00:00Z", cwd: tmp },
  { type: "message", id: "nn1", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "Complete final row" } },
].map((row) => JSON.stringify(row)).join("\n"));
assert.equal(readSession(noNewlineFile).entries.at(-1)?.id, "nn1", "a complete final JSONL row should not require a trailing newline");

const parsed = readSession(rootFile);
assert.deepEqual(sessionLeaves(parsed.entries).map((entry) => entry.id), ["a2", "a3"]);
assert.deepEqual(transcriptFromEntries(parsed.entries, "a2"), ["You\nStart main", "Assistant\nMain answer", "You\nExplore first path", "Assistant\nFirst path result"]);
assert.deepEqual(connectedSessionFamily(sessions, forkFile).map((info) => info.id), ["sess_main", "sess_fork"]);

const targets = buildFocusTargets({ cwd: tmp, sessions, currentSessionFile: rootFile, currentSessionId: "sess_main", currentLeafId: "a2" });
assert.equal(targets[0].kind, "main");
assert.equal(targets[0].label, "Main");
assert.equal(targets.find((target) => target.kind === "branch" && target.leafId === "a2").current, true, "the active in-file branch should be focusable separately from canonical Main");
const subagent = targets.find((target) => target.key === "subagent:sub_worker");
assert(subagent, "running subagent should be listed");
assert.equal(subagent.status, "running");
assert.equal(subagent.sessionPath, null, "Fleet does not expose or inspect child transcript paths");
assert.equal(subagent.workspacePath, null, "Fleet does not expose retained workspace paths");
assert.match(subagent.detail, /task=sha256:/);
assert.equal(subagent.sessionVersion, undefined, "child transcript revisions are intentionally excluded from Fleet");
assert.match(String(subagent.resultVersion), /^\d+:/, "bounded subagent result updates carry a repaint revision");
assert.match(transcriptForTarget(subagent).join("\n"), /Worker result pending/);
assert.doesNotMatch(transcriptForTarget(subagent).join("\n"), /Worker progress/, "Fleet shows bounded results, not child transcript content");
assert(targets.some((target) => target.kind === "fork" && target.sessionPath === forkFile), "forked session should be listed");
assert.equal(sameFocusTargets(targets, [...targets]), true, "equivalent focus rows should not trigger an idle repaint");
assert.equal(sameFocusTargets(targets, targets.map((target, index) => index ? target : { ...target, status: "running" })), false, "visible focus-state changes should trigger a repaint");
assert.equal(sameFocusTargets(targets, targets.map((target) => target.key === "subagent:sub_worker" ? { ...target, sessionVersion: "synthetic-change" } : target)), false, "an explicit visible revision change still repaints the strip");
assert.equal(sameFocusTargets(targets, targets.map((target) => target.key === "subagent:sub_worker" ? { ...target, resultVersion: `${target.resultVersion}:changed` } : target)), false, "late subagent results should repaint an open focus panel");

fs.appendFileSync(subFile, `${JSON.stringify({ type: "session_info", id: "sub-info", parentId: "sa1", name: "Worker live update" })}\n`);
const transcriptUpdatedTargets = buildFocusTargets({ cwd: tmp, sessions, currentSessionFile: rootFile, currentSessionId: "sess_main", currentLeafId: "a2" });
assert.equal(sameFocusTargets(targets, transcriptUpdatedTargets), true, "subagent transcript growth does not affect the metadata-only Fleet view");
fs.writeFileSync(path.join(tmp, ".pi", "subagents", "results", "sub_worker.json"), JSON.stringify({ summary: "Worker result arrived" }));
const resultUpdatedTargets = buildFocusTargets({ cwd: tmp, sessions, currentSessionFile: rootFile, currentSessionId: "sess_main", currentLeafId: "a2" });
assert.equal(sameFocusTargets(transcriptUpdatedTargets, resultUpdatedTargets), false, "an actual result-file update should advance the focus revision");

const inMemoryPath = path.join(tmp, "sessions", "not-yet-persisted.jsonl");
assert(listSessionMetadata({ cwd: tmp, currentSessionFile: inMemoryPath }).some((info) => info.path === inMemoryPath), "a not-yet-persisted current session should remain focusable");
const inMemoryTargets = buildFocusTargets({
  cwd: tmp,
  sessions: [{ path: inMemoryPath, id: "sess_memory", cwd: tmp, created: new Date("2026-01-01"), modified: new Date("2026-01-01"), firstMessage: "Start main" }],
  currentSessionFile: inMemoryPath,
  currentSessionId: "sess_memory",
  currentLeafId: "a2",
  currentSessionEntries: rootEntries,
});
assert(inMemoryTargets.some((target) => target.current && target.leafId === "a2"), "the active SessionManager entries should avoid rereading the current transcript from disk");

const interiorTargets = buildFocusTargets({ cwd: tmp, sessions, currentSessionFile: rootFile, currentSessionId: "sess_main", currentLeafId: "a1" });
const interiorTarget = interiorTargets.find((target) => target.current);
assert.equal(interiorTarget?.leafId, "a1", "an active interior tree point should remain the selected focus target");
assert.equal(interiorTarget?.kind, "branch");
assert.match(transcriptForTarget(interiorTarget).join("\n"), /Main answer/);

assert.deepEqual(stepStripNavigation({ focused: false, direction: "down", index: 2, targetCount: 3 }), { focused: true, index: 0 }, "Down from the editor should focus the first chat");
assert.deepEqual(stepStripNavigation({ focused: true, direction: "down", index: 0, targetCount: 3 }), { focused: true, index: 1 }, "Down should advance through the focused strip");
assert.deepEqual(stepStripNavigation({ focused: true, direction: "up", index: 1, targetCount: 3 }), { focused: true, index: 0 }, "Up should move toward the first chat");
assert.deepEqual(stepStripNavigation({ focused: true, direction: "up", index: 0, targetCount: 3 }), { focused: false, index: 0 }, "Up on the first chat should return focus to the editor");

assert.deepEqual(
  stepFocusNavigation({ direction: "down", index: 0, scroll: 2, maxScroll: 4, targetCount: 3 }),
  { index: 0, scroll: 3, followTail: false, switched: false },
  "Down should scroll within the current transcript before changing chats",
);
assert.deepEqual(
  stepFocusNavigation({ direction: "down", index: 0, scroll: 4, maxScroll: 4, targetCount: 3 }),
  { index: 1, scroll: 0, followTail: false, switched: true },
  "Down at the transcript end should advance to the next chat at its start",
);
assert.deepEqual(
  stepFocusNavigation({ direction: "up", index: 1, scroll: 0, maxScroll: 5, targetCount: 3 }),
  { index: 0, scroll: 0, followTail: true, switched: true },
  "Up at the transcript start should return to the previous chat at its end",
);
assert.deepEqual(
  stepFocusNavigation({ direction: "down", index: 2, scroll: 0, maxScroll: 0, targetCount: 3 }),
  { index: 0, scroll: 0, followTail: false, switched: true },
  "chat traversal should wrap",
);

const busyRows = packTabRows(targets, 72, { busy: true, maxRows: 3 });
assert(busyRows.some((row) => row.includes("working")), "active chat strip should distinguish working state");
assert(busyRows.some((row) => row.includes("switch when idle")), "working chat strip should explain switching behavior");
assert(busyRows.every((row) => row.length <= 72));
const idleRows = packTabRows(targets, 72, { busy: false, maxRows: 3 });
assert(idleRows.some((row) => row.includes("↓ focus")));
const focusedRows = packTabRows(targets, 72, { busy: false, focused: true, selectedIndex: 1, maxRows: 3 });
assert(focusedRows[0].includes("▶"), "focused strip should visibly mark the selected chat");
assert(focusedRows.some((row) => row.includes("Enter inspect")), "focused strip should explain how to open Chat Focus");

const subTargets = buildFocusTargets({ cwd: tmp, sessions, currentSessionFile: subFile, currentSessionId: "sess_sub", currentLeafId: "sa1" });
assert.equal(subTargets.find((target) => target.kind === "main").sessionPath, rootFile, "a focused subagent must retain a route back to root Main");
assert.equal(subTargets.find((target) => target.key === "subagent:sub_worker").current, true);

const recordsDir = path.join(tmp, ".pi", "subagents", "records");
for (let i = 0; i < 7; i++) {
  fs.writeFileSync(path.join(recordsDir, `sub_final_${i}.json`), JSON.stringify({
    id: `sub_final_${i}`,
    parentSessionId: "sess_main",
    role: "reviewer",
    task: `Completed review ${i}`,
    status: i % 2 ? "failed" : "succeeded",
    createdAt: `2026-01-${String(i + 4).padStart(2, "0")}T00:00:00Z`,
    updatedAt: `2026-01-${String(i + 4).padStart(2, "0")}T00:10:00Z`,
  }));
}
const cappedTargets = buildFocusTargets({ cwd: tmp, sessions, currentSessionFile: rootFile, currentSessionId: "sess_main", currentLeafId: "a2", maxFinalSubagents: 3 });
assert.deepEqual(
  cappedTargets.filter((target) => target.kind === "subagent").map((target) => target.key),
  ["subagent:sub_worker", "subagent:sub_final_4", "subagent:sub_final_5", "subagent:sub_final_6"],
  "Chat Focus should retain every active subagent but only the configured number of recent final subagents",
);
assert(fs.existsSync(path.join(recordsDir, "sub_final_0.json")), "bounding the chat strip must not delete durable subagent records");

const oldFinalSession = path.join(tmp, ".pi", "subagents", "rpc-sessions", "sub_final_0", "old-final.jsonl");
writeSession(oldFinalSession, { type: "session", version: 3, id: "sess_old_final", timestamp: "2026-01-04T00:00:00Z", cwd: tmp }, [
  { type: "message", id: "ofu1", parentId: null, timestamp: "2026-01-04T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "Old final result" }] } },
]);
const oldFinalTargets = buildFocusTargets({ cwd: tmp, sessions, currentSessionFile: oldFinalSession, currentSessionId: "sess_old_final", currentLeafId: "ofu1", maxFinalSubagents: 2 });
const visibleFinals = oldFinalTargets.filter((target) => target.kind === "subagent" && target.final);
assert.equal(visibleFinals.length, 2, "the focused final subagent should consume, not exceed, the recent-final limit");
assert(visibleFinals.some((target) => target.key === "subagent:sub_final_0" && target.current), "an older final subagent must remain visible while it is the focused session");
assert(visibleFinals.some((target) => target.key === "subagent:sub_final_6"), "the newest final subagent should remain alongside an older focused result");

function replaceJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file);
}
const subagentsDir = path.join(tmp, ".pi", "subagents");
const baselineRecords = readSubagentRecords(tmp);
const originalReadFileSync = fs.readFileSync;
const subagentStateReads = [];
fs.readFileSync = function countedReadFileSync(file, ...args) {
  if (String(file).startsWith(subagentsDir)) subagentStateReads.push(String(file));
  return originalReadFileSync.call(this, file, ...args);
};
let idleRecords;
try {
  idleRecords = readSubagentRecords(tmp);
} finally {
  fs.readFileSync = originalReadFileSync;
}
assert.deepEqual(subagentStateReads, [], "an idle refresh must not reread unchanged subagent records or results");
assert.deepEqual(idleRecords.map((record) => [record.id, record.status]), baselineRecords.map((record) => [record.id, record.status]));

fs.writeFileSync(path.join(recordsDir, "sub_late.json"), JSON.stringify({ id: "sub_late", parentSessionId: "sess_main", role: "worker", task: "Late session", status: "running", createdAt: "2026-01-20T00:00:00Z" }));
readSubagentRecords(tmp); // Cache the record before its session file exists.
const lateSession = path.join(subagentsDir, "rpc-sessions", "sub_late", "late.jsonl");
writeSession(lateSession, { type: "session", version: 3, id: "sess_late", timestamp: "2026-01-20T00:00:00Z", cwd: tmp }, [
  { type: "message", id: "lu1", parentId: null, timestamp: "2026-01-20T00:00:01Z", message: { role: "user", content: "Late task" } },
]);
const lateTargets = buildFocusTargets({ cwd: tmp, sessions, currentSessionFile: lateSession, currentSessionId: "sess_late", currentLeafId: "lu1" });
assert.equal(lateTargets.find((target) => target.key === "subagent:sub_late")?.current, true, "a running subagent's later-created session file should still be discovered");

const workerRecord = JSON.parse(fs.readFileSync(path.join(recordsDir, "sub_worker.json"), "utf8"));
replaceJson(path.join(recordsDir, "sub_worker.json"), { ...workerRecord, status: "succeeded", updatedAt: "2026-01-21T00:00:00Z" });
const finishedWorker = readSubagentRecords(tmp).find((record) => record.id === "sub_worker");
assert.equal(finishedWorker?.status, "succeeded", "an atomically replaced record should invalidate its cached projection");
assert.equal(finishedWorker?.final, true);
replaceJson(path.join(subagentsDir, "results", "sub_final_1.json"), { summary: "Late review summary" });
const lateResult = readSubagentRecords(tmp).find((record) => record.id === "sub_final_1");
assert.equal(lateResult?.result?.summary, "Late review summary", "a result file written after the record should be picked up");
assert.match(String(lateResult?.resultVersion), /^\d+:/);
fs.unlinkSync(path.join(recordsDir, "sub_final_2.json"));
assert(!readSubagentRecords(tmp).some((record) => record.id === "sub_final_2"), "a deleted record should disappear from the cached view");

fs.appendFileSync(rootFile, `${JSON.stringify({ type: "session_info", id: "info1", parentId: "a3", name: "Renamed main" })}\n`);
assert.equal(readSession(rootFile).name, "Renamed main", "session cache should consume newly appended transcript rows");

const largeFile = path.join(tmp, "sessions", "large.jsonl");
writeSession(largeFile, { type: "session", version: 3, id: "sess_large", timestamp: "2026-01-04T00:00:00Z", cwd: tmp }, [
  { type: "custom", id: "large1", parentId: null, timestamp: "2026-01-04T00:00:01Z", data: { payload: "x".repeat(2 * 1024 * 1024) } },
]);
readSession(largeFile);
fs.appendFileSync(largeFile, `${JSON.stringify({ type: "session_info", id: "large-info", parentId: "large1", name: "Large renamed" })}\n`);
const originalReadSync = fs.readSync;
let incrementalBytesRead = 0;
fs.readSync = function countedReadSync(...args) {
  const bytesRead = originalReadSync.apply(this, args);
  incrementalBytesRead += bytesRead;
  return bytesRead;
};
try {
  assert.equal(readSession(largeFile).name, "Large renamed");
} finally {
  fs.readSync = originalReadSync;
}
assert(incrementalBytesRead < 4096, `a one-line append should not reread the 2 MiB transcript (read ${incrementalBytesRead} bytes)`);

const partialRow = JSON.stringify({ type: "session_info", id: "partial-info", parentId: "large-info", name: "Partial completed" });
const splitAt = Math.floor(partialRow.length / 2);
fs.appendFileSync(largeFile, partialRow.slice(0, splitAt));
assert.equal(readSession(largeFile).name, "Large renamed", "a concurrently appended partial JSONL row should remain hidden");
fs.appendFileSync(largeFile, `${partialRow.slice(splitAt)}\n`);
assert.equal(readSession(largeFile).name, "Partial completed", "the cache should complete a JSONL row from the last parsed newline");

const extensionSource = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "chat-focus", "index.ts"), "utf8");
for (const command of ["chat-focus", "chat-back", "chat-list"]) assert(extensionSource.includes(`pi.registerCommand("${command}"`));
assert(extensionSource.includes('{ placement: "belowEditor" }'), "chat strip should render below the editor");
assert(extensionSource.includes('pi.registerShortcut("f6"'), "F6 should open focused chat inspection");
assert(extensionSource.includes("ctx.ui.setEditorComponent(factory)"), "chat focus should wrap the active editor for bottom-boundary navigation");
assert(extensionSource.includes("installWidget(ctx, targetsChanged);\n    // A later-loaded extension may replace the editor factory"), "the refresh loop should recover from later custom-editor replacement");
assert(!extensionSource.includes("SessionManager.list(ctx.cwd)"), "polling must not rescan and parse every complete session transcript");
assert(extensionSource.includes("statusText !== snapshot.statusText"), "unchanged status text should not force a full TUI repaint");
assert(extensionSource.includes("installWidget(ctx, targetsChanged)"), "unchanged focus targets should not force a full TUI repaint");
assert(extensionSource.includes("if (requestRender || !snapshot.widgetInstalled)"), "unchanged polling must not rebuild the legacy widget container");
assert(extensionSource.includes("currentSessionEntries: ctx.sessionManager?.getEntries?.()"), "refreshes should reuse the active in-memory session instead of duplicating its disk parse");
assert(extensionSource.includes("activeFactory.__chatFocusBaseFactory"), "session replacement should unwrap stale chat-focus editor bridges");
assert(extensionSource.includes("tui.setFocus(snapshot.widget)"), "Down at the editor bottom should focus the chat strip");
assert(extensionSource.includes("boundary cycles chats"), "the focus panel should explain arrow-key boundary traversal");
assert(extensionSource.includes("panelCleanups"), "open focus panels should be disposed during session shutdown");
assert(extensionSource.includes("Parent chat is working; this is a live read-only focus view."), "active parent work should use a non-destructive read-only focus view");
assert(extensionSource.includes("Subagent is still working"), "running subagents should not be opened as concurrently writable sessions");
assert(extensionSource.includes("Cancelled subagent sessions stay read-only"), "cancelled subagents should remain read-only when runner ownership is uncertain");
assert(extensionSource.includes("ctx.navigateTree"), "in-file branches should be switchable");
assert(extensionSource.includes("ctx.switchSession"), "forked and completed subagent sessions should be switchable");
assert(extensionSource.includes("PI_CHAT_FOCUS_RECENT_FINAL_SUBAGENTS"), "the recent completed-subagent cap should be configurable");
assert(extensionSource.includes("maxFinalSubagents: MAX_RECENT_FINAL_SUBAGENTS"), "the extension should apply the completed-subagent cap when refreshing Chat Focus");

console.log("chat-focus tests passed");
