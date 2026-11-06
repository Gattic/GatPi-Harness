#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { messageDiagnostics, terminalAssistantMessage, normalizeBudget } = require("../src/subagent-result-validator");
const { summarizeRoleFieldEvidence } = require("../src/role-field-evidence.js");
const { runtimeSourceFingerprint } = require("../src/runtime-source-fingerprint.js");

function shortHash(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16); }
function modeOf(target) { try { return (fs.lstatSync(target).mode & 0o777).toString(8).padStart(3, "0"); } catch { return "unavailable"; } }
function increment(object, key) { object[key] = (object[key] || 0) + 1; }
function privateModeSummary(paths, expectedMode) {
  const byMode = {};
  let privateCount = 0;
  for (const target of paths) {
    const mode = modeOf(target);
    increment(byMode, mode);
    if (mode === expectedMode) privateCount += 1;
  }
  return { total: paths.length, private: privateCount, permissive: paths.length - privateCount, expectedMode, byMode };
}
function parseJsonl(file, maxBytes) {
  const stat = fs.statSync(file);
  if (stat.size > maxBytes) return { entries: [], bytes: 0, truncated: true, parseErrors: 0 };
  const text = fs.readFileSync(file, "utf8");
  const entries = [];
  let parseErrors = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { parseErrors += 1; }
  }
  return { entries, bytes: Buffer.byteLength(text), truncated: false, parseErrors };
}
function listSessionFiles(root, maxFiles) {
  const files = [];
  const directories = new Set();
  const visit = (dir) => {
    if (files.length >= maxFiles) return;
    directories.add(path.resolve(dir));
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of names) {
      if (files.length >= maxFiles) return;
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.resolve(target));
    }
  };
  visit(path.resolve(root));
  return { files, directories: [...directories] };
}
function roleRunData(entry) { return entry?.type === "custom" && entry.customType === "role-run" && entry.data && typeof entry.data === "object" ? entry.data : null; }
function childMessages(entries) { return entries.filter((entry) => entry?.type === "message" && entry.message).map((entry) => entry.message); }
function resolveChildSession(parentFile, run, parentCwd) {
  const direct = run?.childSessionFile;
  if (direct && typeof direct === "string") return path.isAbsolute(direct) ? path.resolve(direct) : path.resolve(path.dirname(parentFile), direct);
  const candidateDirs = [run?.childSessionDir, parentCwd && run?.subagentId ? path.join(parentCwd, ".pi", "subagents", "rpc-sessions", run.subagentId) : null].filter(Boolean);
  for (const candidate of candidateDirs) {
    const dir = path.isAbsolute(candidate) ? candidate : path.resolve(path.dirname(parentFile), candidate);
    try {
      const files = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (files[0]) return path.resolve(files[0]);
    } catch {}
  }
  return null;
}
function readSubagentRecord(parentCwd, subagentId, maxBytes) {
  if (!parentCwd || !subagentId || !/^[A-Za-z0-9_.-]+$/.test(String(subagentId))) return null;
  const file = path.join(parentCwd, ".pi", "subagents", "records", `${subagentId}.json`);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return { value: JSON.parse(fs.readFileSync(file, "utf8")), bytes: stat.size };
  } catch { return null; }
}
function isCurrentV2Run(run) { return run?.roleRuntimeVersion === 2 && run?.contractVersion === "role-v2" && Number(run?.resultSchemaVersion) === 2; }

function auditRoleRuntime(options = {}) {
  const sessionsDir = path.resolve(options.sessionsDir || path.join(process.env.HOME || "", ".pi", "agent", "sessions"));
  const currentSession = options.currentSession || process.env.PI_SESSION_FILE;
  const currentResolved = currentSession ? path.resolve(currentSession) : null;
  const maxFiles = Math.max(1, Number(options.maxFiles || 2000));
  const maxBytes = Math.max(1024, Number(options.maxBytes || 1024 * 1024 * 1024));
  const listed = listSessionFiles(sessionsDir, maxFiles + 1);
  const filesSeen = listed.files.length;
  const boundedFiles = listed.files.slice(0, maxFiles);
  let bytesRead = 0;
  let filesScanned = 0;
  let currentSessionExcluded = 0;
  let parseErrors = 0;
  let byteLimitReached = false;
  const roleRuns = [];
  for (const file of boundedFiles) {
    if (currentResolved && file === currentResolved) { currentSessionExcluded += 1; continue; }
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (bytesRead + stat.size > maxBytes) { byteLimitReached = true; break; }
    const parsed = parseJsonl(file, maxBytes - bytesRead);
    bytesRead += parsed.bytes;
    parseErrors += parsed.parseErrors;
    filesScanned += 1;
    const parentCwd = parsed.entries.find((entry) => entry?.type === "session")?.cwd || null;
    for (const entry of parsed.entries) {
      const data = roleRunData(entry);
      if (data) roleRuns.push({ parentFile: file, parentCwd, data });
    }
  }

  const byStatus = {};
  let currentV2 = 0;
  let legacy = 0;
  let childSessionsReferenced = 0;
  let childSessionsRead = 0;
  let childSessionsMissing = 0;
  let childSessionParseErrors = 0;
  let actualToolCalls = 0;
  let toolResults = 0;
  let toolFailures = 0;
  let unmatchedToolCalls = 0;
  let unmatchedToolResults = 0;
  let falseSuccessTerminalErrors = 0;
  let modelBudgetOverruns = 0;
  let toolAccountingMismatches = 0;
  let timedOutMutatingRuns = 0;
  const mutatingTools = new Set(["edit", "write"]);
  for (const item of roleRuns) {
    const run = item.data;
    increment(byStatus, String(run.status || "unknown"));
    if (isCurrentV2Run(run)) currentV2 += 1; else legacy += 1;
    const recordPacket = readSubagentRecord(item.parentCwd, run.subagentId, Math.max(1024, maxBytes - bytesRead));
    const record = recordPacket?.value || null;
    if (recordPacket && bytesRead + recordPacket.bytes <= maxBytes) bytesRead += recordPacket.bytes;
    const childFile = resolveChildSession(item.parentFile, run, item.parentCwd);
    if (!childFile) continue;
    childSessionsReferenced += 1;
    if (!fs.existsSync(childFile)) { childSessionsMissing += 1; continue; }
    let parsed;
    try { parsed = parseJsonl(childFile, Math.max(1024, maxBytes - bytesRead)); } catch { childSessionsMissing += 1; continue; }
    if (parsed.truncated || bytesRead + parsed.bytes > maxBytes) { byteLimitReached = true; continue; }
    bytesRead += parsed.bytes;
    childSessionsRead += 1;
    childSessionParseErrors += parsed.parseErrors;
    const messages = childMessages(parsed.entries);
    const diagnostics = messageDiagnostics(messages);
    actualToolCalls += diagnostics.toolCalls;
    toolResults += diagnostics.toolResults;
    toolFailures += diagnostics.toolFailures;
    unmatchedToolCalls += diagnostics.unmatchedToolCallIds.length;
    unmatchedToolResults += diagnostics.unmatchedToolResultIds.length;
    const terminal = terminalAssistantMessage(messages);
    const terminalText = terminal && Array.isArray(terminal.content) ? terminal.content.filter((part) => part?.type === "text").map((part) => String(part.text || "")).join("").trim() : typeof terminal?.content === "string" ? terminal.content.trim() : "";
    if (run.status === "succeeded" && (!terminal || ["error", "aborted", "length"].includes(terminal.stopReason) || (!terminalText && terminal.stopReason !== "toolUse"))) falseSuccessTerminalErrors += 1;
    const budget = normalizeBudget(run.budget || record?.budget || {});
    if (Number.isFinite(budget.maxModelCalls) && diagnostics.modelCalls > budget.maxModelCalls) modelBudgetOverruns += 1;
    const reportedDiagnostics = run.diagnostics || record?.diagnostics || {};
    const reportedToolCalls = Number(reportedDiagnostics.toolCalls ?? reportedDiagnostics.tool_calls ?? run.toolCalls ?? run.tool_calls);
    if (Number.isFinite(reportedToolCalls) && reportedToolCalls !== diagnostics.toolCalls) toolAccountingMismatches += 1;
    const childToolCalls = new Map();
    const successfulToolResults = new Set();
    for (const message of messages) {
      if (message?.role === "assistant" && Array.isArray(message.content)) for (const part of message.content) if (part?.type === "toolCall") childToolCalls.set(String(part.id || part.toolCallId || ""), String(part.name || part.toolName || ""));
      if (message?.role === "toolResult" && message.isError !== true) successfulToolResults.add(String(message.toolCallId || ""));
    }
    if (run.status === "timed_out" && [...childToolCalls].some(([id, name]) => mutatingTools.has(name) && successfulToolResults.has(id))) timedOutMutatingRuns += 1;
  }

  const generatedAt = new Date().toISOString();
  const runtimeSourceHash = options.runtimeSourceHash || runtimeSourceFingerprint(path.resolve(__dirname, "..")).hash;
  const fieldEvidence = {
    ...summarizeRoleFieldEvidence(roleRuns.map((item) => item.data), { runtimeSourceHash, generatedAt }),
    source: {
      activeSession: { requested: currentResolved ? 1 : 0, matched: currentSessionExcluded, excluded: currentSessionExcluded },
      scanComplete: !(filesSeen > maxFiles || byteLimitReached),
      parseErrors: parseErrors + childSessionParseErrors,
    },
  };
  return {
    schemaVersion: 1,
    generatedAt,
    source: { sessionsRootHash: shortHash(sessionsDir), currentSessionExcluded: Boolean(currentResolved) },
    limits: { maxFiles, maxBytes },
    scan: { filesSeen, filesScanned, currentSessionExcluded, bytesRead, parseErrors, childSessionParseErrors, truncated: filesSeen > maxFiles || byteLimitReached, fileLimitReached: filesSeen > maxFiles, byteLimitReached },
    permissions: { files: privateModeSummary(boundedFiles, "600"), directories: privateModeSummary(listed.directories, "700") },
    roleRuns: { total: roleRuns.length, byStatus, cohorts: { currentV2, legacy } },
    provenance: { childSessionsReferenced, childSessionsRead, childSessionsMissing },
    accounting: { actualToolCalls, toolResults, toolFailures, unmatchedToolCalls, unmatchedToolResults },
    findings: { falseSuccessTerminalErrors, modelBudgetOverruns, toolAccountingMismatches, timedOutMutatingRuns },
    fieldEvidence,
  };
}

function renderMarkdown(report) {
  return `# Role Runtime Audit\n\nGenerated: ${report.generatedAt}\n\n## Scope\n\n| Metric | Value |\n|---|---:|\n| Session files seen | ${report.scan.filesSeen} |\n| Session files scanned | ${report.scan.filesScanned} |\n| Current sessions excluded | ${report.scan.currentSessionExcluded} |\n| Bytes read | ${report.scan.bytesRead} |\n| Truncated | ${report.scan.truncated} |\n\n## Role runs\n\n| Metric | Value |\n|---|---:|\n| Total | ${report.roleRuns.total} |\n| Current v2 | ${report.roleRuns.cohorts.currentV2} |\n| Legacy | ${report.roleRuns.cohorts.legacy} |\n| Child sessions read | ${report.provenance.childSessionsRead} |\n| Actual tool calls | ${report.accounting.actualToolCalls} |\n| Tool results | ${report.accounting.toolResults} |\n\n## Findings\n\n| Finding | Count |\n|---|---:|\n| False success terminal errors | ${report.findings.falseSuccessTerminalErrors} |\n| Model budget overruns | ${report.findings.modelBudgetOverruns} |\n| Tool accounting mismatches | ${report.findings.toolAccountingMismatches} |\n| Timed-out mutating runs | ${report.findings.timedOutMutatingRuns} |\n\n## Field evidence\n\n| Metric | Value |\n|---|---:|\n| Status | ${report.fieldEvidence.status} |\n| Eligible live read-only | ${report.fieldEvidence.sample.eligibleLiveReadOnly} |\n| Minimum required | ${report.fieldEvidence.sample.minimumRequired} |\n| Completion rate | ${report.fieldEvidence.metrics.completionRate ?? "n/a"} |\n| Timeout rate | ${report.fieldEvidence.metrics.timeoutRate ?? "n/a"} |\n| p95 total duration | ${report.fieldEvidence.metrics.p95Ms ?? "n/a"} |\n| Field gate passed | ${report.fieldEvidence.gatePassed} |\n\nNo prompt, message, tool-result, or transcript bodies are included in this report.\n`;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--sessions") options.sessionsDir = argv[++index];
    else if (arg === "--current-session") options.currentSession = argv[++index];
    else if (arg === "--max-files") options.maxFiles = Number(argv[++index]);
    else if (arg === "--max-bytes") options.maxBytes = Number(argv[++index]);
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--markdown") options.markdown = argv[++index];
    else if (["--help", "-h"].includes(arg)) options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}
function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  fs.writeFileSync(file, content, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: audit-role-runtime.js [--sessions DIR] [--current-session FILE] [--max-files N] [--max-bytes N] [--output FILE] [--markdown FILE]\n");
      process.exit(0);
    }
    const report = auditRoleRuntime(options);
    const defaultDir = path.join(process.cwd(), ".pi", "role-runtime", "audits");
    const output = path.resolve(options.output || path.join(defaultDir, `role-runtime-audit-${Date.now()}.json`));
    writePrivate(output, `${JSON.stringify(report, null, 2)}\n`);
    if (options.markdown) writePrivate(path.resolve(options.markdown), renderMarkdown(report));
    process.stdout.write(`${JSON.stringify({ output, roleRuns: report.roleRuns.total, fieldEvidence: { status: report.fieldEvidence.status, eligible: report.fieldEvidence.sample.eligibleLiveReadOnly, gatePassed: report.fieldEvidence.gatePassed }, findings: report.findings, truncated: report.scan.truncated })}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { auditRoleRuntime, renderMarkdown, parseArgs };
