"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { auditRoleRuntime, renderMarkdown } = require("../scripts/audit-role-runtime");
const { tmpFixture } = require("./helpers/tmp-fixture");

const fixtureRoot = path.join(__dirname, "fixtures", "role-runtime");
const sessionsDir = path.join(fixtureRoot, "sessions");
const currentSession = path.join(sessionsDir, "current-session.jsonl");

const report = auditRoleRuntime({ sessionsDir, currentSession, maxFiles: 20, maxBytes: 1024 * 1024 });
assert.equal(report.schemaVersion, 1);
assert.equal(report.scan.filesSeen, 2);
assert.equal(report.scan.filesScanned, 1, "the active/current session must be excluded");
assert.equal(report.scan.currentSessionExcluded, 1);
assert.equal(report.scan.truncated, false);
assert.equal(report.roleRuns.total, 3);
assert.equal(report.roleRuns.byStatus.succeeded, 1);
assert.equal(report.roleRuns.byStatus.timed_out, 2);
assert.equal(report.provenance.childSessionsReferenced, 3);
assert.equal(report.provenance.childSessionsRead, 3);
assert.equal(report.provenance.childSessionsMissing, 0);
assert.equal(report.accounting.actualToolCalls, 3, "tool calls are counted by assistant toolCall IDs only");
assert.equal(report.accounting.toolResults, 3);
assert.equal(report.findings.falseSuccessTerminalErrors, 1);
assert.equal(report.findings.modelBudgetOverruns, 1);
assert.equal(report.findings.toolAccountingMismatches, 2);
assert.equal(report.findings.timedOutMutatingRuns, 1);
assert.equal(report.fieldEvidence.status, "insufficient-data");
assert.equal(report.fieldEvidence.sample.eligibleLiveReadOnly, 0, "legacy/deterministic fixtures do not masquerade as live field evidence");
assert.equal(report.fieldEvidence.gatePassed, false);
assert.deepEqual(report.fieldEvidence.source.activeSession, { requested: 1, matched: 1, excluded: 1 });
assert.equal(report.fieldEvidence.source.scanComplete, true);
assert(report.permissions.files.total >= 1);
assert(report.permissions.directories.total >= 1);

const serialized = JSON.stringify(report);
assert(!serialized.includes("CURRENT_SESSION_SYNTHETIC_TEXT_MUST_NOT_APPEAR"));
assert(!serialized.includes("synthetic provider failure"), "audit output must not include transcript/error bodies");
assert(!serialized.includes('"content"'), "audit output must not copy message content");
assert.match(renderMarkdown(report), /Role Runtime Audit/);
assert.match(renderMarkdown(report), /False success terminal errors \| 1/);
assert.match(renderMarkdown(report), /Eligible live read-only \| 0/);

const tmp = tmpFixture("pi-role-audit-");
const jsonOut = path.join(tmp, "report.json");
const mdOut = path.join(tmp, "report.md");
execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "audit-role-runtime.js"), "--sessions", sessionsDir, "--current-session", currentSession, "--max-files", "20", "--max-bytes", String(1024 * 1024), "--output", jsonOut, "--markdown", mdOut], { cwd: path.join(__dirname, ".."), stdio: "pipe" });
assert.equal(JSON.parse(fs.readFileSync(jsonOut, "utf8")).findings.falseSuccessTerminalErrors, 1);
assert.match(fs.readFileSync(mdOut, "utf8"), /Timed-out mutating runs \| 1/);

console.log("role runtime audit tests passed");
