"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function stripAnsi(value) { return String(value || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, ""); }
function hash(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function compactOutput(value, options = {}) {
  const maxLines = Number(options.maxLines || 120);
  const seenWarnings = new Set(), seenFrames = new Set();
  const lines = [];
  let successLines = 0;
  for (const raw of stripAnsi(value).replace(/\r(?!\n)/g, "\n").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (/^(?:\s*[.=>#-]*\s*)?\d{1,3}%|^\s*(?:progress|collecting)\b/i.test(line)) continue;
    if (/^(?:ok\s+\d+\s+-|PASS\s+[^:]+$|✓|✔)/.test(line)) { successLines++; if (successLines > 3) continue; }
    if (/warning/i.test(line)) { const key = line.replace(/\d+/g, "#"); if (seenWarnings.has(key)) continue; seenWarnings.add(key); }
    if (/^\s*at\s+/.test(line)) { const key = line.trim(); if (seenFrames.has(key)) continue; seenFrames.add(key); }
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  if (successLines > 3) lines.push(`… ${successLines - 3} additional passing test line(s) omitted`);
  return lines.join("\n");
}
function failureKind(run, output) {
  if (run.timedOut || /timed?\s*out|ETIMEDOUT/i.test(output)) return "timeout";
  if (run.crashed || run.signal || /SIG(?:ABRT|SEGV)|core dumped/i.test(output)) return "crash";
  if (/AssertionError|ERR_ASSERTION|expected.*actual|not ok/i.test(output)) return "assertion";
  if (/SyntaxError|compile error|type error|TS\d+:/i.test(output)) return "compile";
  if (run.ok) return null;
  return "command";
}
function expectedActual(output) {
  const expected = output.match(/expected\s*[:=]\s*([^\n]+)/i)?.[1]?.trim();
  const actual = output.match(/actual\s*[:=]\s*([^\n]+)/i)?.[1]?.trim();
  return { expected, actual };
}
function topFrames(output, max = 8) { return Array.from(new Set(stripAnsi(output).split(/\r?\n/).filter((line) => /^\s*at\s+/.test(line)).map((line) => line.trim()))).slice(0, max); }
function persistRawOutput(root, output, options = {}) {
  if (!root || !output) return null;
  const digest = hash(output);
  const dir = path.join(root, options.stateDir || ".pi/test-runner/raw");
  const file = path.join(dir, `${digest}.log`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, output, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return { path: path.relative(root, file).replace(/\\/g, "/"), sha256: digest, bytes: Buffer.byteLength(output) };
}
function normalizeTestResult(run = {}, options = {}) {
  const raw = stripAnsi(run.output || `${run.stdout || ""}${run.stderr ? `\n${run.stderr}` : ""}`);
  const expected = expectedActual(raw);
  const status = run.skipped ? "skipped" : run.ok ? "passed" : "failed";
  return {
    id: run.id || `test_${hash(`${run.commandLine || run.command}:${status}:${run.exitCode}`).slice(0, 20)}`,
    label: run.label || run.name || run.commandLine || run.command,
    status,
    ok: status === "passed",
    failureKind: failureKind(run, raw),
    expected: expected.expected,
    actual: expected.actual,
    topFrames: topFrames(raw),
    command: run.commandLine || [run.command, ...(run.args || [])].filter(Boolean).join(" "),
    durationMs: Math.max(0, Number(run.durationMs || 0)),
    exitCode: run.exitCode ?? run.status ?? null,
    signal: run.signal || null,
    output: compactOutput(raw, options),
    outputRef: persistRawOutput(options.root, raw, options),
    flaky: Boolean(run.flaky),
  };
}
function normalizeTestResults(runs, options = {}) {
  const results = (runs || []).map((run) => normalizeTestResult(run, options));
  return { results, summary: { total: results.length, passed: results.filter((result) => result.status === "passed").length, failed: results.filter((result) => result.status === "failed").length, skipped: results.filter((result) => result.status === "skipped").length, durationMs: results.reduce((sum, result) => sum + result.durationMs, 0) } };
}

module.exports = { stripAnsi, compactOutput, failureKind, expectedActual, topFrames, persistRawOutput, normalizeTestResult, normalizeTestResults };
