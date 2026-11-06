"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SessionSearchAdapter } = require("../src/session-search");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-session-search-");
const root = path.join(tmp, "project");
const other = path.join(tmp, "other-project");
const sessions = path.join(tmp, "sessions");
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(other, { recursive: true });
fs.mkdirSync(sessions, { recursive: true });

function writeSession(file, cwd, id, rows) {
  fs.writeFileSync(file, [
    { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
    ...rows,
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
}
const token = ["sk", "-", "B".repeat(24)].join("");
const projectFile = path.join(sessions, "project.jsonl");
writeSession(projectFile, root, "project-session", [
  { type: "message", id: "m1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "The architectural decision is to keep Obsidian canonical." } },
  { type: "message", id: "m2", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_REASONING_SENTINEL" }, { type: "text", text: `Public result with credential ${token}` }, { type: "toolCall", name: "bash", arguments: { command: "PRIVATE_COMMAND_SENTINEL" } }] } },
  { type: "message", id: "m3", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", content: "PRIVATE_TOOL_RESULT_SENTINEL" } },
  { type: "message", id: "m4", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: "Private key archive -----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_MATERIAL\n-----END PRIVATE KEY-----" } },
]);
writeSession(path.join(sessions, "other.jsonl"), other, "other-session", [
  { type: "message", id: "o1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "The architectural decision belongs to another project." } },
]);
writeSession(path.join(sessions, "parent.jsonl"), tmp, "parent-session", [
  { type: "message", id: "p1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "The architectural decision belongs to a parent directory, not this project." } },
]);

const before = fs.readdirSync(sessions).sort();
const adapter = new SessionSearchAdapter({ cwd: root, roots: [sessions] });
const result = adapter.search("architectural decision", { maxElapsedMs: 2000 });
assert.equal(result.outcome, "succeeded");
assert.equal(result.results.length, 1);
assert.match(result.results[0].excerpt, /Obsidian canonical/);
assert.match(result.results[0].sessionId, /^session_[a-f0-9]{20}$/);
assert.match(result.results[0].anchorId, /^anchor_[a-f0-9]{24}$/);
assert(!JSON.stringify(result).includes(projectFile));
assert(!JSON.stringify(result).includes(other));
assert.equal(result.projectSessions, 1, "parent and sibling working directories cannot cross the project boundary");

const resolved = adapter.get(result.results[0].anchorId, { maxElapsedMs: 2000 });
assert.equal(resolved.results[0].anchorId, result.results[0].anchorId);
assert.match(resolved.results[0].excerpt, /Obsidian canonical/);

const privateReasoning = adapter.search("PRIVATE_REASONING_SENTINEL", { maxElapsedMs: 2000 });
assert.equal(privateReasoning.results.length, 0);
const privateTool = adapter.search("PRIVATE_TOOL_RESULT_SENTINEL", { maxElapsedMs: 2000 });
assert.equal(privateTool.results.length, 0);
const privateCommand = adapter.search("PRIVATE_COMMAND_SENTINEL", { maxElapsedMs: 2000 });
assert.equal(privateCommand.results.length, 0);
const credential = adapter.search("Public result credential", { maxElapsedMs: 2000 });
assert.equal(credential.results.length, 1);
assert(!credential.results[0].excerpt.includes(token));
assert.match(credential.results[0].excerpt, /REDACTED_TOKEN/);
const privateKey = adapter.search("Private key archive", { maxElapsedMs: 2000 });
assert.equal(privateKey.results.length, 1);
assert(!privateKey.results[0].excerpt.includes("SYNTHETIC_PRIVATE_MATERIAL"));
assert.match(privateKey.results[0].excerpt, /REDACTED_PRIVATE_KEY/);

const partial = adapter.search("architectural", { maxBytes: 1024, maxElapsedMs: 2000 });
assert.equal(partial.outcome, "partial");
assert(partial.truncationReasons.includes("byte-limit"));
assert.deepEqual(fs.readdirSync(sessions).sort(), before, "search creates no content index or state file");

// The global session root may contain many newer sessions for other projects.
// Neither their lexical position nor their mtime may consume the project budget.
const partitioned = path.join(tmp, "partitioned");
const encode = (cwd) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const projectPartition = path.join(partitioned, encode(root));
const unrelatedPartition = path.join(partitioned, "--aaa-unrelated--");
fs.mkdirSync(projectPartition, { recursive: true });
fs.mkdirSync(unrelatedPartition, { recursive: true });
for (let index = 0; index < 4; index++) {
  const file = path.join(unrelatedPartition, `${index}.jsonl`);
  writeSession(file, other, `unrelated-${index}`, []);
  fs.utimesSync(file, new Date("2030-01-01"), new Date("2030-01-01"));
  writeSession(path.join(projectPartition, `2026-01-0${index + 1}.jsonl`), root, `project-${index}`, [
    { type: "message", id: `p${index}`, message: { role: "user", content: `Project continuity marker ${index}` } },
  ]);
}
const boundedProject = new SessionSearchAdapter({ cwd: root, roots: [partitioned] }).search("continuity", { maxFiles: 1, maxSessions: 1, maxElapsedMs: 2000 });
assert.equal(boundedProject.projectSessions, 1, "project partitions take precedence before file and session limits");
assert.match(boundedProject.results[0].excerpt, /marker 3/, "newest timestamp-named project sessions are discovered first");
assert.equal(boundedProject.scannedSessions, 1);
assert.equal(boundedProject.truncated, true, "bounded discovery still reports incomplete coverage");
const sessionBounded = new SessionSearchAdapter({ cwd: root, roots: [partitioned] }).search("continuity", { maxFiles: 20, maxSessions: 1, maxElapsedMs: 2000 });
assert.equal(sessionBounded.projectSessions, 1, "newer unrelated sessions cannot displace project candidates at the session limit");

// A partition name is a discovery hint, not permission to cross project identity.
writeSession(path.join(projectPartition, "2099-spoof.jsonl"), other, "spoof", [
  { type: "message", id: "spoof", message: { role: "user", content: "Forbidden continuity marker" } },
]);
const spoofed = new SessionSearchAdapter({ cwd: root, roots: [partitioned] }).search("Forbidden", { maxElapsedMs: 2000 });
assert.equal(spoofed.results.length, 0, "header identity remains authoritative");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("session search tests passed");
