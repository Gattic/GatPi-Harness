#!/usr/bin/env node
"use strict";

// Runs the deterministic suite in the same order and with the same per-file
// command as scripts/check-all.sh, then writes a revision-bound record so the
// rollout gate can prove which implementation produced which results.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { currentMemorySourceEvidence } = require("../src/memory-effectiveness-source");
const { auditRecordWrites, recordWriteAudit } = require("../src/project-memory-write-audit");

const root = path.resolve(__dirname, "..");
const testsDir = path.join(root, "tests");
const timeoutMs = Math.max(1000, Number(process.env.PI_TEST_FILE_TIMEOUT || 600) * 1000);
const files = fs.readdirSync(testsDir).filter((name) => name.endsWith(".test.js")).sort();
const startedAt = Date.now();

function run(command, args) {
  const started = Date.now();
  try { execFileSync(command, args, { cwd: root, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }); return { ok: true, exitCode: 0, output: "", durationMs: Date.now() - started }; }
  catch (error) {
    const exitCode = typeof error.status === "number" ? error.status : 1;
    const output = error.code === "ETIMEDOUT" ? "timed out" : `${error.stdout || ""}${error.stderr || ""}`.slice(-4000);
    return { ok: false, exitCode, output, durationMs: Date.now() - started };
  }
}

const results = [];
let failed = 0;
for (const name of files) {
  const result = run(process.execPath, [path.join(testsDir, name)]);
  results.push({ file: `tests/${name}`, ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs });
  if (!result.ok) { failed += 1; process.stderr.write(`FAIL tests/${name}\n${result.output}\n`); }
}

const staticChecks = [];
for (const script of ["scripts/check-hermes-static.sh"]) {
  const result = run("bash", [path.join(root, script)]);
  staticChecks.push({ command: script, ok: result.ok, exitCode: result.exitCode, durationMs: result.durationMs });
  if (!result.ok) { failed += 1; process.stderr.write(`FAIL ${script}\n${result.output}\n`); }
}

function git(args) { try { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); } catch { return null; } }
const auditCwd = path.resolve(process.env.PI_AUDIT_CWD || root);
const auditStateDir = path.join(auditCwd, ".pi", "project-memory");
const audit = process.env.PI_AUDIT_WRITE === "1" ? recordWriteAudit({ cwd: auditCwd }).row : { kind: "write", written: false, ...auditRecordWrites({ stateDir: auditStateDir }) };

const record = {
  schemaVersion: 1,
  kind: "full-suite-record",
  sourceVersion: "full-suite-record-v1",
  generatedAt: new Date().toISOString(),
  ok: failed === 0,
  status: failed === 0 ? "succeeded" : "failed",
  failed,
  testFiles: results.length,
  discoveredTestFiles: files.length,
  sourceRevision: currentMemorySourceEvidence({ implementationRoot: root }).revision,
  commit: git(["rev-parse", "HEAD"]),
  branch: git(["branch", "--show-current"]),
  dirty: (git(["status", "--porcelain=v1"]) || "").length > 0,
  durationMs: Date.now() - startedAt,
  results,
  staticChecks,
  audit,
};

fs.mkdirSync(path.join(root, ".pi", "test-runner"), { recursive: true });
fs.writeFileSync(path.join(root, ".pi", "test-runner", "full-latest.json"), `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: record.ok, failed: record.failed, testFiles: record.testFiles, durationMs: record.durationMs, sourceRevision: record.sourceRevision, commit: record.commit, branch: record.branch, dirty: record.dirty, audit: record.audit }, null, 2)}\n`);
process.exit(record.ok ? 0 : 1);
