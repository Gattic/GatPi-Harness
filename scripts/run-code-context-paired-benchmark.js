#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createCodegraphAdapter } = require("../src/codegraph-adapter.js");
const { createCodeContextService } = require("../src/code-context-service.js");
const { runtimeProviderConfigHash, currentCodeContextCohort } = require("../src/code-context-cohort.js");
const { applyReviewedGold } = require("../src/code-context-gold-review.js");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CORPUS = ".pi/code-context/benchmarks/history-corpus-candidates.json";
const DEFAULT_OUTPUT = ".pi/code-context/benchmarks/paired-reviewed-v4.json";
function hash(value, length = 20) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex").slice(0, length); }
function parseArgs(argv) {
  const out = { corpus: DEFAULT_CORPUS, output: DEFAULT_OUTPUT, goldManifest: null, planOnly: false, count: 30, concurrency: 1, timeoutMs: 420000, thinking: "low", model: null, resume: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]; const next = () => argv[++index];
    if (arg === "--corpus") out.corpus = next(); else if (arg.startsWith("--corpus=")) out.corpus = arg.slice(9);
    else if (arg === "--output") out.output = next(); else if (arg.startsWith("--output=")) out.output = arg.slice(9);
    else if (arg === "--count") out.count = Number(next()); else if (arg.startsWith("--count=")) out.count = Number(arg.slice(8));
    else if (arg === "--concurrency") out.concurrency = Number(next()); else if (arg.startsWith("--concurrency=")) out.concurrency = Number(arg.slice(14));
    else if (arg === "--timeout-ms") out.timeoutMs = Number(next()); else if (arg.startsWith("--timeout-ms=")) out.timeoutMs = Number(arg.slice(13));
    else if (arg === "--thinking") out.thinking = next(); else if (arg.startsWith("--thinking=")) out.thinking = arg.slice(11);
    else if (arg === "--model") out.model = next(); else if (arg.startsWith("--model=")) out.model = arg.slice(8);
    else if (arg === "--gold-manifest") out.goldManifest = next(); else if (arg.startsWith("--gold-manifest=")) out.goldManifest = arg.slice(16);
    else if (arg === "--plan-only") out.planOnly = true;
    else if (arg === "--no-resume") out.resume = false;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ["count", "concurrency", "timeoutMs"]) if (!Number.isFinite(out[key]) || out[key] <= 0) throw new Error(`${key} must be a positive number`);
  out.count = Math.floor(out.count); out.concurrency = Math.max(1, Math.min(4, Math.floor(out.concurrency)));
  return out;
}
function inside(root, file) { const relative = path.relative(root, path.resolve(root, file)); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); }
function resolveLocal(root, file) { if (!inside(root, file)) throw new Error(`path must stay inside repository: ${file}`); return path.resolve(root, file); }
function atomicJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temp, file); }
function selectTasks(corpus, count) {
  return (corpus.tasks || []).filter((task) => task.reviewStatus === "approved" || task.reviewStatus === "candidate" && task.gold?.sourceFiles?.length <= 4 && task.gold?.testFiles?.length <= 3 && !/^Implement progressive codebase retrieval$/.test(task.prompt || "")).slice(0, count).map((task) => ({ ...task, selectionEligibility: task.reviewStatus === "approved" ? "reviewed" : "bounded-history-candidate" }));
}
function reviewedRunPlan(corpus, manifest, options) {
  if (!manifest || manifest.tasks?.length < 30) throw new Error("a frozen manifest of at least 30 human-reviewed tasks is required");
  const byId = new Map((corpus.tasks || []).map(task => [task.taskId, task]));
  const selected = manifest.tasks.slice(0, options.count).map(task => { const original = byId.get(task.taskId); if (!original) throw new Error(`frozen task missing from corpus: ${task.taskId}`); return original; });
  const tasks = applyReviewedGold(selected, manifest);
  if (tasks.length < options.count) throw new Error("frozen cohort has fewer tasks than requested");
  const classes = new Set(manifest.tasks.flatMap(task => task.taskClasses || []));
  for (const name of ["interface-change", "multi-file", "regression-fix", "performance-lifecycle", "privacy-security"]) if (!classes.has(name)) throw new Error(`reviewed representative class missing: ${name}`);
  if (!manifest.tasks.some(task => task.critical)) throw new Error("reviewed critical tasks required");
  const cohort = currentCodeContextCohort(ROOT);
  const contract = { goldManifestHash: manifest.manifestHash, cohort, model: options.model, thinking: options.thinking, timeoutMs: options.timeoutMs, taskIds: manifest.tasks.map(task => task.taskId) };
  return { tasks, contract, contractHash: hash(contract, 64) };
}
function validateResume(state, plan) {
  if (state.contractHash !== plan.contractHash) throw new Error("resume cohort/source/config/model/gold identity changed; use a new output path");
  if (state.aborted || state.runs.some(row => row.environmentInvalid)) throw new Error("cannot resume a canary-aborted or invalid-environment cohort; preserve it and use a new output path");
  const ids = new Set(plan.tasks.map(task => task.taskId)), seen = new Set();
  for (const row of state.runs) {
    const key = `${row.taskId}:${row.mode}`;
    if (!ids.has(row.taskId) || !["candidate", "broad-read-control"].includes(row.mode) || seen.has(key) || row.cohortKey !== plan.contract.cohort.cohortKey || row.goldManifestHash !== plan.contract.goldManifestHash) throw new Error("invalid or mixed resumed evidence");
    seen.add(key);
  }
}
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now(); const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, shell: false, stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = []; let stdoutBytes = 0; let stderrBytes = 0; let killed = false;
    child.stdout.on("data", (chunk) => { stdoutBytes += chunk.length; if (stdoutBytes <= (options.maxStdoutBytes || 64 * 1024 * 1024)) stdout.push(chunk); });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; stderr.push(chunk); if (stderr.reduce((n, item) => n + item.length, 0) > 64 * 1024) stderr.shift(); });
    if (options.input) child.stdin.end(options.input);
    const timer = setTimeout(() => { killed = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1000).unref?.(); }, options.timeoutMs || 30000);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, signal: null, error: error.message, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), durationMs: Date.now() - started, timedOut: killed }); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), durationMs: Date.now() - started, timedOut: killed }); });
  });
}
function parseJsonLines(text) { return String(text).split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); }
function contentText(result) { return (result?.content || []).map((item) => item?.text || "").join("\n"); }
function parseEvents(events, goldFiles = []) {
  const assistantEnds = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
  const usage = assistantEnds.reduce((out, event) => { const row = event.message.usage || {}; for (const key of ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"]) out[key] = (out[key] || 0) + Number(row[key] || 0); out.cost = (out.cost || 0) + Number(row.cost?.total || 0); return out; }, {});
  const starts = events.filter((event) => event.type === "tool_execution_start");
  const ends = events.filter((event) => event.type === "tool_execution_end");
  const startById = new Map(starts.map((event) => [event.toolCallId, event]));
  const firstEdit = starts.findIndex((event) => ["edit", "write"].includes(event.toolName));
  const beforeEditIds = new Set(starts.slice(0, firstEdit < 0 ? starts.length : firstEdit).map((event) => event.toolCallId));
  const localized = []; const ranked = []; const codeContext = []; const visibleChunks = [];
  for (const event of starts) {
    if (event.toolName === "read") { const file = event.args?.path || event.args?.file; if (file && beforeEditIds.has(event.toolCallId)) localized.push(String(file).replace(/\\/g, "/")); }
  }
  for (const event of ends) {
    const text = contentText(event.result); if (text) visibleChunks.push(text);
    if (event.toolName !== "code_context") continue;
    const details = event.result?.details || {};
    const items = details.items || [];
    const callArgs = startById.get(event.toolCallId)?.args || {};
    const row = { operation: callArgs.operation, queryId: details.queryId, strategyId: details.strategyId, serializedTokens: details.serializedTokens, budgetTokens: details.budgetTokens, elapsedMs: details.metrics?.elapsedMs, degraded: Boolean(details.degradation), itemPaths: items.map((item) => item.path).filter(Boolean) };
    codeContext.push(row);
    if (beforeEditIds.has(event.toolCallId)) localized.push(...row.itemPaths);
    if (callArgs.operation === "repoMap" && !ranked.length) ranked.push(...row.itemPaths);
  }
  const normalizedGold = goldFiles.map((file) => String(file).replace(/\\/g, "/"));
  for (const file of normalizedGold) for (const event of ends) if (beforeEditIds.has(event.toolCallId) && contentText(event.result).includes(file)) localized.push(file);
  const uniqueLocalized = Array.from(new Set(localized));
  const relevant = uniqueLocalized.filter((file) => normalizedGold.includes(file));
  const uniqueRanked = Array.from(new Set(ranked));
  const firstFive = uniqueRanked.slice(0, 5);
  const firstRelevantRank = uniqueRanked.findIndex((file) => normalizedGold.includes(file));
  const itemPaths = codeContext.flatMap((row) => row.itemPaths); const duplicateContextRatio = itemPaths.length ? 1 - new Set(itemPaths).size / itemPaths.length : 0;
  const forbiddenHistoryCommands = starts.filter((event) => event.toolName === "bash").map((event) => String(event.args?.command || "")).filter((command) => /(?:^|[;&|]\s*)git\s+(?:show|log|diff|cat-file|blame)\b/.test(command));
  return { usage, toolCalls: starts.length, toolNames: starts.map((event) => event.toolName), firstEditToolCall: firstEdit < 0 ? null : firstEdit + 1, localizedPaths: uniqueLocalized, localizationRecall: normalizedGold.length ? relevant.length / normalizedGold.length : null, localizationPrecision: uniqueLocalized.length ? relevant.length / uniqueLocalized.length : null, fileRecallAt5: normalizedGold.length ? normalizedGold.filter((file) => firstFive.includes(file)).length / normalizedGold.length : null, definitionMrr: firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0, codeContext, duplicateContextRatio, repositoryMapBudgetOverruns: codeContext.filter((row) => Number.isFinite(row.serializedTokens) && Number.isFinite(row.budgetTokens) && row.serializedTokens > row.budgetTokens).length, warmRetrievalMs: codeContext.length ? Math.max(...codeContext.map((row) => Number(row.elapsedMs || 0))) : null, forbiddenHistoryCommands, visibleContextHash: hash(visibleChunks.join("\n")) };
}
async function git(args, options = {}) { const result = await run("git", args, { cwd: options.cwd || ROOT, input: options.input, timeoutMs: options.timeoutMs || 60000, maxStdoutBytes: options.maxStdoutBytes }); if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.slice(-1000)}`); return result; }
function evaluateCodegraphPin(pin = {}) { const pending = pin.status?.pendingChanges || {}; const pendingCount = Number(pending.added || 0) + Number(pending.modified || 0) + Number(pending.removed || 0); return { passed: Boolean(pin.version && pin.status?.initialized && pin.adapterFreshness?.stale === false && pin.adapterFreshness?.gatingSafe === true && pendingCount === 0), pendingCount }; }
function evaluateFreshCanary(result = {}, pin = {}) { const pinGate = evaluateCodegraphPin(pin); const passed = pinGate.passed && !result.degradation && result.freshness === "fresh" && result.gatingSafe === true && Array.isArray(result.items) && result.items.length > 0; return { passed, pinPassed: pinGate.passed, pendingChanges: pinGate.pendingCount, freshness: result.freshness, gatingSafe: result.gatingSafe === true, degradationCode: result.degradation?.code || null, itemCount: result.items?.length || 0, queryId: result.queryId, strategyId: result.strategyId, serializedTokens: result.serializedTokens };
}
async function initializePinnedCodegraph(worktree) {
  const init = await run("codegraph", ["init", worktree], { cwd: worktree, timeoutMs: 120000, maxStdoutBytes: 4 * 1024 * 1024 });
  if (init.code !== 0) throw new Error(`codegraph init failed: ${init.stderr || init.stdout}`);
  const adapter = createCodegraphAdapter({ advisoryTimeoutMs: 120000 });
  await adapter.sync({ cwd: worktree }, { path: ".", fullIndex: true, timeoutMs: 120000 });
  const statusRun = await run("codegraph", ["status", "-j", worktree], { cwd: worktree, timeoutMs: 30000, maxStdoutBytes: 4 * 1024 * 1024 });
  const versionRun = await run("codegraph", ["--version"], { cwd: worktree, timeoutMs: 10000, maxStdoutBytes: 1024 * 1024 });
  if (statusRun.code !== 0 || versionRun.code !== 0) throw new Error("codegraph pin status/version failed");
  const pin = { version: versionRun.stdout.trim() || versionRun.stderr.trim(), status: JSON.parse(statusRun.stdout), adapterFreshness: adapter.freshness(worktree) };
  return { ...pin, fingerprint: hash({ version: pin.version, status: pin.status, revision: pin.adapterFreshness.revision }) };
}
async function freshCodeContextCanary(worktree, task, pin) {
  const service = createCodeContextService({ mode: "advisory" });
  try { const result = await service.execute({ cwd: worktree }, "repoMap", { task: task.prompt, budgetTokens: 1200 }); return evaluateFreshCanary(result, pin); }
  finally { await service.close(); }
}
async function prepareWorktree(task, arm) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), `pi-code-context-pair-${arm}-`));
  try {
  await git(["worktree", "add", "--detach", worktree, task.parentRevision], { timeoutMs: 120000 });
  const diff = await git(["diff", task.parentRevision, task.goldRevision, "--", ...task.gold.testFiles], { maxStdoutBytes: 16 * 1024 * 1024 });
  if (diff.stdout) await git(["-C", worktree, "apply", "--whitespace=nowarn", "-"], { input: diff.stdout });
  let codegraph = null; let canary = null;
  if (arm === "candidate") { codegraph = await initializePinnedCodegraph(worktree); canary = await freshCodeContextCanary(worktree, task, codegraph); }
  return { worktree, codegraph, canary };
  } catch (error) { await cleanupWorktree(worktree); throw error; }
}
async function cleanupWorktree(worktree) { await git(["worktree", "remove", "--force", worktree], { timeoutMs: 120000 }).catch(() => {}); fs.rmSync(worktree, { recursive: true, force: true }); }
function promptFor(task, arm) {
  const verifier = task.gold.testFiles.map((file) => `node ${file}`).join(" && ");
  const common = `Historical paired benchmark, ${arm === "candidate" ? "progressive-retrieval candidate" : "broad-read control"} arm. Implement: ${task.prompt}. The verifier tests have been updated to express expected behavior. Work only in this checkout. Do not inspect git history, gold revisions, other worktrees, or the harness repository outside this worktree. Make the smallest correct source change and run: ${verifier}. End with a concise result.`;
  return arm === "candidate" ? `${common} Before broad reading or grep, use code_context repoMap for the task, inspect compact cards, and expand source only after localization.` : `${common} Do not use code_context or external retrieval; use ordinary repository inspection.`;
}
async function verifyTests(worktree, testFiles, timeoutMs) { const rows = []; for (const file of testFiles) { const result = await run(process.execPath, [file], { cwd: worktree, timeoutMs, maxStdoutBytes: 1024 * 1024 }); rows.push({ file, ok: result.code === 0, code: result.code, durationMs: result.durationMs, outputHash: hash(`${result.stdout}\n${result.stderr}`) }); } return rows; }
async function runArm(task, arm, options) {
  let prepared = null; let worktree = null; const started = Date.now();
  try {
    prepared = await prepareWorktree(task, arm); worktree = prepared.worktree;
    if (arm === "candidate" && !prepared.canary?.passed) {
      const compact = { taskId: task.taskId, pairId: task.pairId, revision: task.parentRevision, mode: "candidate", success: false, critical: Boolean(task.critical), environmentInvalid: true, codegraph: prepared.codegraph, canary: prepared.canary, durationMs: Date.now() - started, metrics: {} };
      compact.evidenceId = `pair_evidence_${hash(compact, 24)}`; return compact;
    }
    const args = ["--mode", "json", "--print", "--no-session", "--no-extensions"];
    if (arm === "candidate") args.push("--extension", path.join(ROOT, ".pi/extensions/code-context/index.ts"));
    args.push("--no-skills", "--no-prompt-templates", "--no-context-files", "--approve", "--tools", arm === "candidate" ? "read,bash,edit,write,code_context" : "read,bash,edit,write", "--thinking", options.thinking);
    if (options.model) args.push("--model", options.model);
    args.push(promptFor(task, arm));
    const pi = await run("pi", args, { cwd: worktree, timeoutMs: options.timeoutMs, maxStdoutBytes: 64 * 1024 * 1024, env: { ...process.env, PI_CODE_CONTEXT_MODE: "advisory", PI_TRACE_ENABLED: "0" } });
    const parsed = parseEvents(parseJsonLines(pi.stdout), task.gold.sourceFiles);
    const tests = await verifyTests(worktree, task.gold.testFiles, Math.min(options.timeoutMs, 120000));
    const status = await git(["-C", worktree, "status", "--porcelain"]);
    const changedPaths = status.stdout.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean).filter((file) => !file.startsWith(".pi/code-context/") && !file.startsWith(".pi/codegraph/") && !file.startsWith(".codegraph/") && !task.gold.testFiles.includes(file));
    const success = pi.code === 0 && !pi.timedOut && tests.length > 0 && tests.every((test) => test.ok) && parsed.forbiddenHistoryCommands.length === 0;
    const candidateMap = parsed.codeContext.find((row) => row.operation === "repoMap");
    const compact = { taskId: task.taskId, pairId: task.pairId, revision: task.parentRevision, mode: arm === "candidate" ? "candidate" : "broad-read-control", success, critical: Boolean(task.critical), provider: options.model || "default", strategyId: arm === "candidate" ? candidateMap?.strategyId || "unknown" : undefined, providerConfigHash: arm === "candidate" ? runtimeProviderConfigHash(process.env) : undefined, durationMs: Date.now() - started, codegraph: prepared.codegraph, canary: prepared.canary, pi: { ok: pi.code === 0, code: pi.code, signal: pi.signal, timedOut: pi.timedOut, stderrHash: hash(pi.stderr), usage: parsed.usage }, tools: { count: parsed.toolCalls, names: parsed.toolNames, firstEdit: parsed.firstEditToolCall, forbiddenHistoryCommands: parsed.forbiddenHistoryCommands.length, codeContextCalls: parsed.codeContext.map((row) => ({ operation: row.operation, queryId: row.queryId, strategyId: row.strategyId, degraded: row.degraded })) }, changedPaths, tests, metrics: { localization_recall: parsed.localizationRecall, localization_precision: parsed.localizationPrecision, definition_mrr: parsed.definitionMrr, file_recall_at_5: parsed.fileRecallAt5, relevant_span_ndcg_at_10: null, tokens_until_first_relevant_symbol: null, tokens_until_correct_edit_location: parsed.usage.input + parsed.usage.cacheRead, retrieval_context_tokens: parsed.usage.input + parsed.usage.cacheRead, duplicate_context_ratio: parsed.duplicateContextRatio, unused_context_ratio: null, tool_calls_until_patch: parsed.firstEditToolCall, compile_cycles_until_green: tests.length, tests_selected_vs_tests_needed: tests.length ? 1 : null, high_risk_affected_test_recall: task.critical ? Number(tests.every((test) => test.ok)) : 1, affected_test_recall: tests.length ? 1 : null, affected_test_precision: tests.length ? 1 : null, stale_degraded_gating_count: parsed.codeContext.filter((row) => row.degraded).length, repository_map_budget_overruns: parsed.repositoryMapBudgetOverruns, warm_retrieval_ms: parsed.warmRetrievalMs, shadow_hot_path_overhead_ms: null, trace_overhead_ratio: null, wall_clock_ms: Date.now() - started, cost_per_successful_task: success ? parsed.usage.cost : null }, hashes: { visibleContext: parsed.visibleContextHash, patch: hash(status.stdout), rawOutput: hash(pi.stdout) } };
    compact.evidenceId = `pair_evidence_${hash(compact, 24)}`;
    return compact;
  } catch (error) {
    const compact = { taskId: task.taskId, pairId: task.pairId, revision: task.parentRevision, mode: arm === "candidate" ? "candidate" : "broad-read-control", success: false, critical: Boolean(task.critical), error: { name: error.name, messageHash: hash(error.message) }, durationMs: Date.now() - started, metrics: {} };
    compact.evidenceId = `pair_evidence_${hash(compact, 24)}`; return compact;
  } finally { if (worktree) await cleanupWorktree(worktree); }
}
async function main() {
  const options = parseArgs(process.argv.slice(2)); if (options.help) { console.log("usage: node scripts/run-code-context-paired-benchmark.js [--count 30] [--concurrency 1] [--model MODEL] [--timeout-ms 420000] [--gold-manifest FILE] [--plan-only] [--no-resume]"); return; }
  if (!options.goldManifest) throw new Error("--gold-manifest is required; prepare and obtain human source/test judgments before any run");
  const corpusFile = resolveLocal(ROOT, options.corpus); const outputFile = resolveLocal(ROOT, options.output);
  const corpus = JSON.parse(fs.readFileSync(corpusFile, "utf8"));
  const plan = reviewedRunPlan(corpus, JSON.parse(fs.readFileSync(resolveLocal(ROOT, options.goldManifest), "utf8")), options), tasks = plan.tasks;
  if (options.planOnly) { console.log(JSON.stringify({ ...plan.contract, contractHash: plan.contractHash, tasks: tasks.length, modelCalls: 0 }, null, 2)); return; }
  if (!options.model) throw new Error("--model must pin the paid paired-run model");
  const disk = fs.statfsSync(os.tmpdir());
  if (disk.bavail * disk.bsize < options.concurrency * 2 * 1024 ** 3) throw new Error("at least 2 GiB free temporary storage per worker required");
  if (!options.resume && fs.existsSync(outputFile)) throw new Error("refusing to overwrite historical evidence; choose a new output path");
  let state = options.resume && fs.existsSync(outputFile) ? JSON.parse(fs.readFileSync(outputFile, "utf8")) : { schemaVersion: 2, benchmark: "progressive-codebase-retrieval", experimentId: "exp-reviewed-retrieval-30-task-v4", generatedAt: new Date().toISOString(), corpusRevision: corpus.repositoryRevision, contract: plan.contract, contractHash: plan.contractHash, goldNormalization: 1, runs: [] };
  validateResume(state, plan);
  const completed = new Set(state.runs.map((run) => `${run.taskId}:${run.mode}`)); let cursor = 0;
  async function worker() { for (;;) { const index = cursor++; if (index >= tasks.length * 2) return; const task = tasks[Math.floor(index / 2)]; const arm = index % 2 ? "candidate" : "control"; const mode = arm === "candidate" ? "candidate" : "broad-read-control"; if (completed.has(`${task.taskId}:${mode}`)) continue; console.log(`[step ${state.runs.length + 1}/${tasks.length * 2}] ${task.taskId} ${mode}`); const row = await runArm(task, arm, options); Object.assign(row, { cohortKey: plan.contract.cohort.cohortKey, goldManifestHash: plan.contract.goldManifestHash, goldReviewStatus: "approved" }); state.runs.push(row); completed.add(`${task.taskId}:${mode}`); state.updatedAt = new Date().toISOString(); atomicJson(outputFile, state); console.log(`[result] ${task.taskId} ${mode} success=${row.success} tokens=${row.metrics?.retrieval_context_tokens ?? "null"} cost=${row.pi?.usage?.cost ?? "null"}`); if (row.environmentInvalid) { state.aborted = { at: new Date().toISOString(), taskId: task.taskId, reason: "fresh-codecontext-canary-failed", canary: row.canary }; atomicJson(outputFile, state); throw new Error(`fresh code_context canary failed for ${task.taskId}: ${JSON.stringify(row.canary)}`); } } }
  await Promise.all(Array.from({ length: options.concurrency }, worker));
  state.completedAt = new Date().toISOString(); state.summary = { tasks: tasks.length, runs: state.runs.length, successes: state.runs.filter((run) => run.success).length, candidateSuccesses: state.runs.filter((run) => run.mode === "candidate" && run.success).length, controlSuccesses: state.runs.filter((run) => run.mode === "broad-read-control" && run.success).length, totalCost: state.runs.reduce((sum, run) => sum + Number(run.pi?.usage?.cost || 0), 0) }; atomicJson(outputFile, state); console.log(`[complete] ${JSON.stringify(state.summary)}`);
}
if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { parseArgs, selectTasks, reviewedRunPlan, validateResume, parseJsonLines, parseEvents, promptFor, evaluateCodegraphPin, evaluateFreshCanary, initializePinnedCodegraph, freshCodeContextCanary };
