"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { auditRecordWrites, isSanitized, recordWriteAudit } = require("../src/project-memory-write-audit");
const { tmpFixture } = require("./helpers/tmp-fixture");

// Clean state: every record is already sanitized, so a second pass is a no-op.
const cleanDir = tmpFixture("write-audit-clean-");
fs.writeFileSync(path.join(cleanDir, "state.json"), JSON.stringify({ schemaVersion: 1, projectKey: "pi:fixture:abcd", lastAttempt: null }));
fs.writeFileSync(path.join(cleanDir, "decisions.jsonl"), `${JSON.stringify({ schemaVersion: 1, action: "saved", reason: "explicit-save" })}\n`);
const clean = auditRecordWrites({ stateDir: cleanDir });
assert.equal(clean.inspected, 2, "both record files are audited");
assert.equal(clean.records, 2);
assert.equal(clean.bypassedRecords, 0);
assert.equal(clean.bypassedFiles, 0);

// A record that still needs redaction proves the write skipped the sanitizer.
assert.equal(isSanitized({ note: "safe" }), true);
const secret = `sk-${"Q".repeat(32)}`;
assert.equal(isSanitized({ note: secret }), false);
// Cached content is payload-shaped, so the diagnostic summariser would flag it.
// Only the state sanitizer defines a bypass.
assert.equal(isSanitized({ schemaVersion: 1, items: Array.from({ length: 14 }, (_, index) => ({ title: `item-${index}`, content: "cached memory content" })) }), true);

const dirtyDir = tmpFixture("write-audit-dirty-");
fs.writeFileSync(path.join(dirtyDir, "diagnostics.jsonl"), `${JSON.stringify({ kind: "settle", note: secret })}\n${JSON.stringify({ kind: "settle", note: "clean" })}\n`);
fs.writeFileSync(path.join(dirtyDir, "state.json"), JSON.stringify({ schemaVersion: 1 }));
const dirty = auditRecordWrites({ stateDir: dirtyDir });
assert.equal(dirty.inspected, 2);
assert.equal(dirty.records, 3);
assert.equal(dirty.bypassedRecords, 1);
assert.equal(dirty.bypassedFiles, 1);
assert.equal(dirty.files.length, 1);
assert(/^sha256:[a-f0-9]{16}$/.test(dirty.files[0].fileHash), "a bypassing file is reported by name hash");
assert(!JSON.stringify(dirty).includes(secret), "the audit never carries matched literals");
assert(!JSON.stringify(dirty).includes(dirtyDir), "the audit never carries state paths");

// The window excludes records written before it, so a repaired file stops gating.
const old = new Date("2020-01-01T00:00:00Z");
fs.utimesSync(path.join(dirtyDir, "diagnostics.jsonl"), old, old);
const windowed = auditRecordWrites({ stateDir: dirtyDir, since: "2026-01-01T00:00:00Z" });
assert.equal(windowed.inspected, 1, "only the recent file is audited");
assert.equal(windowed.bypassedRecords, 0);

// The diagnostic row is the gate input: kind "write" with a sanitized flag.
const repoDir = tmpFixture("write-audit-repo-");
const stateDir = path.join(repoDir, ".pi", "project-memory");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "diagnostics.jsonl"), `${JSON.stringify({ kind: "settle", note: secret })}\n`);
const { row } = recordWriteAudit({ cwd: repoDir, clock: () => new Date("2026-11-20T00:00:00Z") });
assert.equal(row.kind, "write");
assert.equal(row.scope, "project-memory-state");
assert.equal(row.sanitized, false, "a bypassing write is reported as unsanitized");
assert.equal(row.inspected, 1);
assert.equal(row.bypassedRecords, 1);
assert.equal(row.at, "2026-11-20T00:00:00.000Z");
const ledger = fs.readFileSync(path.join(stateDir, "diagnostics.jsonl"), "utf8").split("\n").filter(Boolean);
assert.equal(ledger.length, 2, "the diagnostic is appended, not merged");
assert(!ledger.at(-1).includes(secret), "the diagnostic never persists matched content");

// A clean tree reports sanitized true, which is what the M0 gate expects.
fs.writeFileSync(path.join(stateDir, "diagnostics.jsonl"), `${JSON.stringify({ kind: "settle", note: "clean" })}\n`);
fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ schemaVersion: 1 }));
const cleanRow = recordWriteAudit({ cwd: repoDir }).row;
assert.equal(cleanRow.sanitized, true);
assert.equal(cleanRow.inspected, 2);
assert.equal(cleanRow.records, 2);
assert.equal(cleanRow.bypassedRecords, 0);

console.log("project-memory write audit tests passed");
