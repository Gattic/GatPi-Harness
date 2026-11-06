import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readdirSync, readFileSync, statSync, lstatSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { inspectRuntimeState, planCleanup, applyCleanup, formatCleanupPlan, defaultCleanupPolicy } = require("../../../src/runtime-cleanup.js");
const { resolveRoleRuntimeConfig, summarizeRoleStateSplit } = require("../../../src/role-runtime-rollout.js");
const { codegraphDoctor } = require("../../../src/codegraph-adapter.js");
const { semgrepDoctor } = require("../../../src/semgrep-adapter.js");
const { readJson, writeJson, includeGlobal, notify } = require("../../../src/pi-extension-kit.js");
const { collectHarnessMetrics, formatHarnessMetrics } = require("../../../src/harness-metrics.js");
const { DAY_MS, defaultSessionRoot, planSessionHygiene, applySessionPermissions, archiveSessionCandidates, hardenActiveSessionFile, publicSessionHygieneResult, formatSessionHygienePlan } = require("../../../src/session-hygiene.js");
const { SessionStorageAttributionAdapter } = require("../../../src/integration-boundary.js");
const sessionStorageAttribution = new SessionStorageAttributionAdapter();

// session-stabilizer and performance-optimizer were merged into this
// extension; all three read the same trace/runtime state and emitted
// overlapping recommendations. The env gates stay independent so existing
// configurations keep working, and each surface keeps its own state dir.
const ENABLED = process.env.PI_RUNTIME_DOCTOR !== "0";
const STABILIZER_ENABLED = process.env.PI_SESSION_STABILIZER !== "0";
const PERF_ENABLED = process.env.PI_PERFORMANCE_OPTIMIZER !== "0";
const STATE_DIR = ".pi/runtime-doctor";
const STABILIZER_STATE_DIR = ".pi/session-stabilizer";
const PERF_STATE_DIR = ".pi/performance-optimizer";
const requestedContextJsonBytes = Number(process.env.PI_INTEGRATION_STORAGE_MAX_JSON_BYTES || 64 * 1024 * 1024);
const MAX_CONTEXT_JSON_BYTES = Number.isFinite(requestedContextJsonBytes) && requestedContextJsonBytes >= 1024 ? requestedContextJsonBytes : 64 * 1024 * 1024;

function sha256(value: any) { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function fileSize(file: string) { try { return statSync(file).size; } catch { return 0; } }
function dirSize(dir: string, max = 4000): number { try { let total = 0; for (const name of readdirSync(dir).slice(0, max)) { const p = join(dir, name); const s = lstatSync(p); total += s.isSymbolicLink() ? s.size : s.isDirectory() ? dirSize(p, max) : s.size; } return total; } catch { return 0; } }
function list(dir: string) { try { return readdirSync(dir); } catch { return []; } }
function traceRoots(cwd: string, options: { includeGlobal?: boolean } = {}) { return [process.env.PI_TRACE_DIR || join(cwd, ".pi", "traces"), ...(options.includeGlobal ? [join(process.env.HOME || ".", ".pi", "agent", "traces")] : [])]; }
function latestTraceFiles(cwd: string, options: { includeGlobal?: boolean } = {}) {
  const roots = traceRoots(cwd, options);
  const files = roots.flatMap((root) => list(root).filter((f) => f.endsWith(".jsonl")).map((f) => join(root, f))).sort((a, b) => fileSize(b) - fileSize(a));
  return { root: roots[0], roots, files: files.slice(0, 5) };
}
function readTraceEvents(cwd: string, limit = 1000, options: { includeGlobal?: boolean } = {}) {
  const { files } = latestTraceFiles(cwd, options); const events: any[] = [];
  for (const file of files) {
    try { const lines = readFileSync(file, "utf8").trim().split(/\n+/).filter(Boolean).slice(-limit); for (const line of lines) events.push(JSON.parse(line)); } catch {}
  }
  return events.slice(-limit);
}
function quantile(xs: number[], q: number) { if (!xs.length) return 0; const ys = xs.slice().sort((a, b) => a - b); return ys[Math.min(ys.length - 1, Math.floor(q * (ys.length - 1)))]; }
function latencyReport(cwd: string, options: { includeGlobal?: boolean } = {}) {
  const events = readTraceEvents(cwd, 1500, options);
  const timed = events.filter((e) => Number(e.duration_ms) > 0);
  const bySubsystem: Record<string, any> = {};
  for (const e of timed) {
    const key = e.subsystem || e.category || "unknown"; const b = bySubsystem[key] || { count: 0, totalMs: 0, maxMs: 0, errors: 0, samples: [] as number[] };
    const d = Number(e.duration_ms || 0); b.count++; b.totalMs += d; b.maxMs = Math.max(b.maxMs, d); b.samples.push(d); if (e.severity === "error" || e.severity === "fatal") b.errors++; bySubsystem[key] = b;
  }
  for (const b of Object.values(bySubsystem) as any[]) { b.avgMs = b.count ? b.totalMs / b.count : 0; b.p95Ms = quantile(b.samples, 0.95); delete b.samples; }
  return { traceEvents: events.length, timedEvents: timed.length, bySubsystem, slowest: timed.sort((a, b) => Number(b.duration_ms || 0) - Number(a.duration_ms || 0)).slice(0, 20).map((e) => ({ timestamp: e.timestamp, duration_ms: e.duration_ms, category: e.category, name: e.name, subsystem: e.subsystem, severity: e.severity })) };
}
function gitRoot(cwd: string) { const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }); return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : cwd; }
function gitStatus(cwd: string) { const r = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }); return r.status === 0 ? r.stdout.trim().split(/\n/).filter(Boolean) : []; }
function extensionInventory(cwd: string) {
  const project = list(join(cwd, ".pi", "extensions")).filter((name) => existsSync(join(cwd, ".pi", "extensions", name, "index.ts")) || name.endsWith(".ts"));
  const global = list(join(process.env.HOME || ".", ".pi", "agent", "extensions")).filter((name) => name !== ".DS_Store");
  return { project, global };
}
function memoryReport(cwd: string) {
  const projectRoot = gitRoot(cwd);
  const cognitive = join(cwd, ".pi", "cognitive-automation");
  return {
    cognitiveStateBytes: dirSize(cognitive),
    cognitiveExists: existsSync(cognitive),
    projectMemoryStateBytes: dirSize(join(cwd, ".pi", "project-memory")),
    verificationCenterBytes: dirSize(join(cwd, ".pi", "verification-center")),
    subagentWorkspaceBytes: dirSize(join(projectRoot, ".pi", "subagents", "workspaces")),
    retainedSubagentWorkspaces: list(join(projectRoot, ".pi", "subagents", "workspaces")).filter((name) => existsSync(join(projectRoot, ".pi", "subagents", "workspaces", name, "capture.json"))).length,
  };
}
function contextReport(cwd: string) {
  const storage = join(cwd, ".pi", "cognitive-automation", "storage.json");
  const reasoningFile = join(cwd, ".pi", "cognitive-automation", "reasoning-runtime.json");
  const storageSize = fileSize(storage);
  const reasoningStateBytes = fileSize(reasoningFile);
  const reasoningOversized = reasoningStateBytes > MAX_CONTEXT_JSON_BYTES;
  const reasoning = reasoningOversized ? null : readJson(reasoningFile, null);
  const storageOversized = storageSize > MAX_CONTEXT_JSON_BYTES;
  return {
    storageSize,
    storageOversized,
    reasoningStateBytes,
    reasoningOversized,
    maxJsonBytes: MAX_CONTEXT_JSON_BYTES,
    reasoningArtifacts: reasoning?.artifacts?.length || reasoning?.packet?.artifacts?.length || undefined,
    stateHash: storageSize && !storageOversized ? sha256(readFileSync(storage, "utf8")).slice(0, 16) : undefined,
  };
}
function roleRuntimeReport(cwd: string) {
  const config = resolveRoleRuntimeConfig(process.env, { cwd });
  const state = inspectRuntimeState({ cwd });
  const readCompact = (file: string) => { try { const stat = lstatSync(file); if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) return null; const value = JSON.parse(readFileSync(file, "utf8")); return { roleRuntimeVersion: value.roleRuntimeVersion, contractVersion: value.contractVersion || value.roleContract?.contractVersion, resultSchemaVersion: value.resultSchemaVersion || value.schemaVersion }; } catch { return null; } };
  const roleRecords = (state.roleState?.inventories?.roleRecords?.files || []).slice(-500).map((entry: any) => readCompact(entry.path)).filter(Boolean);
  const topologyRuns = (state.roleState?.inventories?.topologyRuns?.files || []).slice(-500).map((entry: any) => readCompact(entry.path)).filter(Boolean);
  return { ...config, stateSplit: summarizeRoleStateSplit({ roleRecords, topologyRuns }), roleState: { summary: state.roleState?.summary || {}, inventories: Object.fromEntries(Object.entries(state.roleState?.inventories || {}).map(([name, inventory]: [string, any]) => [name, { files: inventory.files.length, directories: inventory.directories.length, bytes: inventory.bytes, permissionChanges: inventory.permissionChanges.length, truncated: inventory.truncated }])) } };
}
function promptRefinementEnabled(value = process.env.PI_PROMPT_SUGGESTIONS_REFINE) {
  const mode = String(value ?? "auto").trim().toLowerCase();
  return !["0", "false", "off", "disabled"].includes(mode);
}
function envReport() {
  const keys = ["PI_ROLE_RUNTIME_VERSION", "PI_ROLE_MUTATION", "PI_ROLE_SIDECAR", "PI_ROLE_ROLLOUT_STAGE", "PI_ROLE_RUNTIME_BENCHMARK_REPORT", "PI_ROLE_RUNTIME_FIELD_REPORT", "PI_ROLE_RUNTIME_FIELD_MAX_AGE_MS", "PI_ROLE_FIELD_PILOT", "PI_ROLE_WORKER_SHADOW_CANARY", "PI_TOPOLOGY_AUTO_ROUTE", "PI_SUBAGENT_WORKSPACE_MAX_MB", "PI_SUBAGENT_WORKSPACE_MAX_AGE_DAYS", "PI_COGNITIVE_TIMING", "PI_COGNITIVE_AUTO_VERIFY", "PI_COGNITIVE_AUTO_CONSOLIDATE", "PI_VERIFICATION_MAX_OUTPUT_BYTES", "PI_INTEGRATION_STORAGE_MAX_JSON_BYTES", "PI_REASONING_AUTO_PRUNE_AUTOMATED", "PI_REASONING_AUTO_PRUNE_AUTOMATED_KEEP", "PI_REASONING_AUTO_PRUNE_AUTOMATED_MAX", "PI_HERMES_ADVISORY", "PI_HERMES_PROMPT_TIMEOUT_MS", "PI_PROMPT_SUGGESTIONS_REFINE", "PI_TRACE_ENABLED", "PI_TRACE_CAPTURE_PAYLOADS", "PI_SKILL_AUTO_CAPTURE", "PI_VERIFY_TIMEOUT_MS", "PI_CODEGRAPH", "PI_CODEGRAPH_BIN", "PI_CODEGRAPH_AUTO_SYNC", "PI_CODEGRAPH_ADVISORY", "PI_SEMGREP", "PI_SEMGREP_BIN", "PI_SEMGREP_CONFIG", "PI_SEMGREP_ADVISORY", "PI_SEMGREP_VERIFY_TIMEOUT_MS", "PI_SEMGREP_PATCH_TIMEOUT_MS", "PI_SEMGREP_METRICS"];
  return Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]));
}
function doctor(cwd: string, options: { includeGlobal?: boolean } = {}) {
  const trace = latestTraceFiles(cwd, options); const latency = latencyReport(cwd, options); const memory = memoryReport(cwd); const extensions = extensionInventory(cwd); const git = gitStatus(cwd); const codegraph = codegraphDoctor(cwd, { timeoutMs: 1500 }); const semgrep = semgrepDoctor(cwd, { timeoutMs: 1500 }); const roleRuntime = roleRuntimeReport(cwd);
  const risks: string[] = [];
  if (promptRefinementEnabled()) risks.push("Automatic model prompt refinement is enabled and may add advisory latency.");
  if (process.env.PI_COGNITIVE_AUTO_CONSOLIDATE === "1") risks.push("Automatic cognitive consolidation is enabled and may add background load.");
  if (process.env.PI_COGNITIVE_AUTO_VERIFY === "1") risks.push("Automatic verification is enabled; good for correctness but can add edit-turn latency.");
  if (memory.cognitiveStateBytes > 5_000_000) risks.push("Cognitive runtime state is large; consider pruning reasoning/memory/trace artifacts.");
  if (memory.retainedSubagentWorkspaces > 0) risks.push(`${memory.retainedSubagentWorkspaces} retained isolated subagent workspace(s) are available for patch recovery; preview cleanup before pruning.`);
  if (!roleRuntime.promotionAuthorized) risks.push(`Role rollout ${roleRuntime.requestedStage} is not authorized; effective stage is ${roleRuntime.effectiveStage}.`);
  if (roleRuntime.evidenceOverride) risks.push(`Role rollout uses configured operator authority at ${roleRuntime.effectiveStage}; evidence currently authorizes ${roleRuntime.evidenceAuthorizedStage}.`);
  if (roleRuntime.workerShadowCanaryEnabled) risks.push("Automatic bounded worker shadow canary is enabled; eligible interactive prompts add one separate DeepSeek-V4.1-Flash/low provider run.");
  if (roleRuntime.stateSplit.split) risks.push(`Role state contains legacy/current cohorts (legacy=${roleRuntime.stateSplit.legacy}, currentV2=${roleRuntime.stateSplit.currentV2}); rollback preserves both.`);
  if (latency.slowest[0]?.duration_ms > 3000) risks.push(`Slow trace event observed: ${latency.slowest[0].subsystem}:${latency.slowest[0].name} ${Math.round(latency.slowest[0].duration_ms)}ms.`);
  if (git.length > 50) risks.push("Large working tree change set; verification and context packing may be noisier.");
  const exclusion = piStateExclusion(cwd);
  if (exclusion.git && !exclusion.ignored && existsSync(join(cwd, ".pi"))) risks.push(".pi runtime state is untracked in git status; run /doctor-exclude-state to hide it via repo-local .git/info/exclude.");
  for (const risk of codegraph.risks || []) risks.push(`CodeGraph: ${risk}`);
  for (const risk of semgrep.risks || []) risks.push(`Semgrep: ${risk}`);
  return { generatedAt: new Date().toISOString(), cwd, includeGlobal: Boolean(options.includeGlobal), gitChanges: git, extensions, trace: { root: trace.root, roots: trace.roots, files: trace.files, bytes: trace.files.reduce((n, f) => n + fileSize(f), 0) }, latency, memory, context: contextReport(cwd), roleRuntime, codegraph, semgrep, env: envReport(), risks };
}
function formatDoctor(d: any) {
  const lines = [`Runtime doctor ${d.generatedAt}`, `cwd: ${d.cwd}`, `git changes: ${d.gitChanges.length}`, `project extensions: ${d.extensions.project.join(", ") || "none"}`, `trace bytes: ${d.trace.bytes}`, `timed trace events: ${d.latency.timedEvents}`, `cognitive state bytes: ${d.memory.cognitiveStateBytes}`, `subagent workspace bytes: ${d.memory.subagentWorkspaceBytes} retained=${d.memory.retainedSubagentWorkspaces}`, `role runtime: v${d.roleRuntime.selectedVersion} ${d.roleRuntime.compatibilityMode} mutation=${d.roleRuntime.mutationMode} rollout=${d.roleRuntime.effectiveStage} authority=${d.roleRuntime.stageAuthority} evidenceStage=${d.roleRuntime.evidenceAuthorizedStage} evidenceOverride=${d.roleRuntime.evidenceOverride} field=${d.roleRuntime.fieldEvidenceStatus} eligible=${d.roleRuntime.fieldEligibleRuns} pilot=${d.roleRuntime.fieldPilotEnabled} workerCanary=${d.roleRuntime.workerShadowCanaryEnabled} legacy/current=${d.roleRuntime.stateSplit.legacy}/${d.roleRuntime.stateSplit.currentV2}`, `codegraph: ${d.codegraph?.binary?.found ? (d.codegraph.initialized ? "ready" : "not initialized") : "missing"}`, `semgrep: ${d.semgrep?.binary?.found ? (d.semgrep.ready ? "ready" : "not ready") : "missing"}`];
  if (d.risks.length) lines.push("", "Risks:", ...d.risks.map((r: string) => `- ${r}`));
  if (d.latency.slowest.length) lines.push("", "Slowest events:", ...d.latency.slowest.slice(0, 8).map((e: any) => `- ${Math.round(e.duration_ms)}ms ${e.subsystem}:${e.name} ${e.severity}`));
  return lines.join("\n");
}
function exportReport(cwd: string, options: { includeGlobal?: boolean } = {}) { const d = doctor(cwd, options); const file = join(cwd, STATE_DIR, `doctor-${Date.now()}.json`); writeJson(file, d); return { file, report: d }; }
function cleanupPlan(cwd: string, input: any = {}) { return planCleanup({ cwd, traceRoot: input.includeGlobal ? join(process.env.HOME || ".", ".pi", "agent", "traces") : (process.env.PI_TRACE_DIR || join(cwd, ".pi", "traces")), policy: input.policy || {} }); }
function cleanupHistory(cwd: string) { const dir = join(cwd, ".pi", "runtime-cleanup", "manifests"); return list(dir).filter((f) => f.endsWith(".json")).sort().slice(-30).map((f) => join(dir, f)); }
function piStateExclusion(cwd: string, apply = false) {
  // Harness runtime state lands in <repo>/.pi and shows as untracked noise in
  // target repos. .git/info/exclude is repo-local and never committed, so it
  // is the polite place to hide it without touching the user's .gitignore.
  if (!existsSync(join(cwd, ".git"))) return { git: false, ignored: false, applied: false };
  const check = spawnSync("git", ["check-ignore", "-q", ".pi"], { cwd, encoding: "utf8" });
  const ignored = check.status === 0;
  if (ignored || !apply) return { git: true, ignored, applied: false, excludeFile: join(cwd, ".git", "info", "exclude") };
  const file = join(cwd, ".git", "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!/^\.pi\/$/m.test(current)) writeFileSync(file, `${current.replace(/\n?$/, "\n")}# Pi harness runtime state (added by /doctor-exclude-state)\n.pi/\n`);
  return { git: true, ignored: true, applied: true, excludeFile: file };
}

function stabilizeStatus(cwd: string) { const cognitiveBytes = dirSize(join(cwd, ".pi", "cognitive-automation")); const traceBytes = dirSize(process.env.PI_TRACE_DIR || join(process.env.HOME || ".", ".pi", "agent", "traces")); const astRefactorBytes = dirSize(join(cwd, ".pi", "ast-refactor")); const verificationBytes = dirSize(join(cwd, ".pi", "verification-center")); const risks: string[] = []; if (cognitiveBytes > 50_000_000) risks.push("large cognitive runtime state"); if (traceBytes > 100_000_000) risks.push("large trace store"); if (process.env.PI_COGNITIVE_AUTO_CONSOLIDATE === "1") risks.push("automatic consolidation enabled"); if (promptRefinementEnabled()) risks.push("automatic model prompt refinement enabled"); return { generatedAt: new Date().toISOString(), cwd, cognitiveBytes, traceBytes, astRefactorBytes, verificationBytes, risks, stable: risks.length === 0 }; }
function stabilizePlan(cwd: string) { const s = stabilizeStatus(cwd); const actions = ["Run /doctor-hot-path to confirm measured latency risks.", "Run /verify-run quick before further edits."]; if (s.cognitiveBytes > 50_000_000) actions.push("Preview /cognitive-prune-memory and /reasoning-prune-automated before applying cleanup."); if (s.traceBytes > 100_000_000) actions.push("Use /cognitive-prune-trace --apply after exporting important traces."); if (s.risks.includes("automatic model prompt refinement enabled")) actions.push("Set PI_PROMPT_SUGGESTIONS_REFINE=off to keep model advice off the prompt path."); actions.push("Create a checkpoint or handoff before large autonomous/topology work."); return { status: s, actions }; }
function stabilizeCheckpoint(cwd: string, note = "manual stabilization checkpoint") { const p = stabilizePlan(cwd); const file = join(cwd, STABILIZER_STATE_DIR, `checkpoint-${Date.now()}.json`); writeJson(file, { note, ...p }); return { file, ...p }; }
function stabilizeCleanupPlan(cwd: string, input: any = {}) { return planCleanup({ cwd, traceRoot: process.env.PI_TRACE_DIR || join(process.env.HOME || ".", ".pi", "agent", "traces"), policy: input.policy || {} }); }
function sessionHygieneOptions(args: any, cwd: string, activeSessionFile?: string) {
  const text = typeof args === "string" ? args : "";
  const input = typeof args === "object" && args ? args : {};
  const days = Number(text.match(/--older-than=(\d+)d/)?.[1] || input.olderThanDays || 7);
  return { root: input.root, archiveRoot: input.archiveRoot, migrationMarker: input.migrationMarker, olderThanMs: Math.max(0, days) * DAY_MS, includeTemporary: input.includeTemporary !== false, includeOneShot: input.includeOneShot === true || /--include-one-shot/.test(text), projectCwd: input.projectCwd || (/--project=current/.test(text) ? cwd : undefined), maxFiles: Number(input.maxFiles || text.match(/--max-files=(\d+)/)?.[1] || 10000), maxEntries: Number(input.maxEntries || text.match(/--max-entries=(\d+)/)?.[1] || 40000), maxScanBytesPerFile: Number(input.maxScanBytesPerFile || text.match(/--max-scan-bytes=(\d+)/)?.[1] || 2 * 1024 * 1024), activeSessionFile };
}
function runSessionHygiene(args: any, cwd: string, activeSessionFile: string | undefined, apply = false, archive = false, writePermissionPreview = false) {
  const plan = planSessionHygiene(sessionHygieneOptions(args, cwd, activeSessionFile));
  const permissions = applySessionPermissions(plan, { dryRun: !apply, writePreview: !apply && writePermissionPreview });
  const archived = archive ? archiveSessionCandidates(plan, { dryRun: !apply }) : null;
  return publicSessionHygieneResult(plan, permissions, archived);
}
function formatStabilize(p: any) { return [`Session stabilizer: ${p.status.stable ? "stable" : "attention needed"}`, `cognitive bytes: ${p.status.cognitiveBytes}`, `trace bytes: ${p.status.traceBytes}`, p.status.risks.length ? `risks: ${p.status.risks.join(", ")}` : "risks: none", "actions:", ...p.actions.map((a: string) => `- ${a}`)].join("\n"); }

function readLines(file: string) { try { return readFileSync(file, "utf8").split(/\n/).filter(Boolean); } catch { return []; } }
function perfTraceDirs(cwd: string, options: { includeGlobal?: boolean } = {}) { return [process.env.PI_TRACE_DIR, join(cwd, ".pi", "traces"), ...(options.includeGlobal ? [join(process.env.HOME || ".", ".pi", "agent", "traces")] : [])].filter(Boolean) as string[]; }
function perfTraceFiles(cwd: string, options: { includeGlobal?: boolean } = {}) { const files: string[] = []; for (const dir of perfTraceDirs(cwd, options)) { try { for (const f of readdirSync(dir)) if (/\.jsonl$|trace/.test(f)) files.push(join(dir, f)); } catch {} } return files.sort((a, b) => { try { return require("node:fs").statSync(b).mtimeMs - require("node:fs").statSync(a).mtimeMs; } catch { return 0; } }).slice(0, 12); }
function perfEvents(cwd: string, limit = 5000, options: { includeGlobal?: boolean } = {}) { const rows: any[] = []; for (const file of perfTraceFiles(cwd, options)) for (const line of readLines(file)) { try { rows.push({ file, ...JSON.parse(line) }); } catch {} if (rows.length >= limit) break; } return rows.slice(-limit); }
function duration(e: any) { return Number(e.duration_ms ?? e.durationMs ?? e.duration ?? 0) || 0; }
function perfProfile(cwd: string, options: { includeGlobal?: boolean } = {}) { const es = perfEvents(cwd, 5000, options); const timed = es.filter((e) => duration(e) > 0); const byName: Record<string, any> = {}; for (const e of timed) { const k = `${e.subsystem || e.category || "unknown"}:${e.name || e.type || "event"}`; const r = byName[k] || { key: k, count: 0, totalMs: 0, maxMs: 0, examples: [] }; r.count++; r.totalMs += duration(e); r.maxMs = Math.max(r.maxMs, duration(e)); if (r.examples.length < 3) r.examples.push({ at: e.timestamp || e.at, durationMs: duration(e), severity: e.severity, file: e.file }); byName[k] = r; }
  const hot = Object.values(byName).map((r: any) => ({ ...r, meanMs: r.totalMs / Math.max(1, r.count) })).sort((a: any, b: any) => b.totalMs - a.totalMs).slice(0, 20);
  return { generatedAt: new Date().toISOString(), includeGlobal: Boolean(options.includeGlobal), traceFiles: perfTraceFiles(cwd, options), eventCount: es.length, timedCount: timed.length, slowest: timed.sort((a, b) => duration(b) - duration(a)).slice(0, 20).map((e) => ({ at: e.timestamp || e.at, name: e.name || e.type, category: e.category, subsystem: e.subsystem, durationMs: duration(e), severity: e.severity })), hot, thresholds: { slowEventMs: 1000, promptHotPathMs: 250 }, env: { PI_PROMPT_SUGGESTIONS_REFINE: process.env.PI_PROMPT_SUGGESTIONS_REFINE, PI_COGNITIVE_AUTO_VERIFY: process.env.PI_COGNITIVE_AUTO_VERIFY, PI_TRACE_CAPTURE_PAYLOADS: process.env.PI_TRACE_CAPTURE_PAYLOADS } };
}
function perfRecommendations(p: any) { const recs: any[] = []; if (!p.eventCount) recs.push({ priority: "medium", action: "Enable/inspect trace observability", reason: "No trace events found" }); for (const h of p.hot) if (h.meanMs > 500 || h.maxMs > 1000) recs.push({ priority: h.maxMs > 3000 ? "high" : "medium", action: `Investigate ${h.key}`, reason: `mean=${Math.round(h.meanMs)}ms max=${Math.round(h.maxMs)}ms count=${h.count}` }); if (promptRefinementEnabled()) recs.push({ priority: "medium", action: "Set PI_PROMPT_SUGGESTIONS_REFINE=off", reason: "Automatic model prompt refinement can add advisory latency" }); if (process.env.PI_COGNITIVE_AUTO_VERIFY === "1") recs.push({ priority: "medium", action: "Keep verification debounced/manual on hot path", reason: "Automatic verification can add perceived latency" }); if (process.env.PI_TRACE_CAPTURE_PAYLOADS === "1") recs.push({ priority: "low", action: "Disable trace payload capture for speed/privacy unless debugging", reason: "Large payload serialization can be expensive" }); return recs; }
function perfRegression(cwd: string, options: { includeGlobal?: boolean } = {}) { const p = perfProfile(cwd, options); const latest = p.slowest[0]; return { ok: !latest || latest.durationMs < 3000, latestSlowest: latest, recommendations: perfRecommendations(p) }; }
function perfCompare(cwd: string, options: { includeGlobal?: boolean } = {}) { const file = join(cwd, PERF_STATE_DIR, "baseline.json"); const current = perfProfile(cwd, options); if (!existsSync(file)) { writeJson(file, current); return { baselineCreated: file, currentSummary: { eventCount: current.eventCount, timedCount: current.timedCount } }; } const base = JSON.parse(readFileSync(file, "utf8")); return { baseline: { eventCount: base.eventCount, timedCount: base.timedCount, slowest: base.slowest?.[0] }, current: { eventCount: current.eventCount, timedCount: current.timedCount, slowest: current.slowest?.[0] }, delta: { events: current.eventCount - base.eventCount, slowestMs: (current.slowest?.[0]?.durationMs || 0) - (base.slowest?.[0]?.durationMs || 0) } }; }
function perfFixPlan(cwd: string, options: { includeGlobal?: boolean } = {}) { const p = perfProfile(cwd, options); return { profile: { eventCount: p.eventCount, timedCount: p.timedCount, slowest: p.slowest.slice(0, 5) }, recommendations: perfRecommendations(p), safeConfig: { PI_PROMPT_SUGGESTIONS_REFINE: "off", PI_COGNITIVE_AUTO_CONSOLIDATE: "0", PI_TRACE_CAPTURE_PAYLOADS: "0", PI_COGNITIVE_AUTO_VERIFY: "0 for latency-sensitive sessions, otherwise debounced" } }; }
function formatPerf(p: any) { return [`Performance profile: events=${p.eventCount} timed=${p.timedCount}`, `Slowest: ${p.slowest.slice(0, 5).map((e: any) => `${e.durationMs}ms ${e.category || ""}:${e.name}`).join("; ") || "none"}`, ...perfRecommendations(p).map((r) => `${r.priority}: ${r.action} (${r.reason})`)].join("\n"); }

export default function runtimeDoctor(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  registerStabilizer(pi);
  registerPerformanceOptimizer(pi);
  if (!ENABLED) return;
  pi.on("session_start", async (_event: any, ctx: any) => { hardenActiveSessionFile(ctx.sessionManager?.getSessionFile?.()); });
  pi.registerCommand("doctor", { description: "Unified runtime health, latency, extension, memory, and trace report; pass --global to include global traces", handler: async (args: string, ctx: any) => notify(ctx, formatDoctor(doctor(ctx.cwd, { includeGlobal: includeGlobal(args) })), "info") });
  pi.registerCommand("doctor-latency", { description: "Show latency profile from recent repo-local trace events; pass --global to include global traces", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(latencyReport(ctx.cwd, { includeGlobal: includeGlobal(args) }), null, 2), "info") });
  pi.registerCommand("doctor-memory", { description: "Show project-local memory/state size report", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(memoryReport(ctx.cwd), null, 2), "info") });
  pi.registerCommand("doctor-context", { description: "Show context/reasoning state report", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(contextReport(ctx.cwd), null, 2), "info") });
  pi.registerCommand("doctor-role-runtime", { description: "Show selected role runtime version, compatibility mode, rollout authorization, and legacy/current state split", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(roleRuntimeReport(ctx.cwd), null, 2), "info") });
  pi.registerCommand("doctor-extensions",  { description: "Show loaded/discoverable extension inventory", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(extensionInventory(ctx.cwd), null, 2), "info") });
  pi.registerCommand("doctor-hot-path", { description: "Show likely prompt-submission hot path risks", handler: async (_args: string, ctx: any) => {
    const d = doctor(ctx.cwd, { includeGlobal: includeGlobal(_args) }); notify(ctx, JSON.stringify({ env: d.env, risks: d.risks, slowest: d.latency.slowest.slice(0, 10), codegraph: { initialized: d.codegraph.initialized, freshness: d.codegraph.freshness }, semgrep: { ready: d.semgrep.ready, version: d.semgrep.version }, recommendations: ["Keep automatic model prompt refinement off unless explicitly evaluating it", "Keep automatic consolidation off unless diagnosing", "Use /verify-run changed manually for expensive checks", "Use /codegraph-sync manually after edits unless PI_CODEGRAPH_AUTO_SYNC=1", "Use /semgrep-codegraph manually for static-analysis plus affected-test hints", "Use /cognitive-timing on only while profiling"] }, null, 2), "info");
  }});
  pi.registerCommand("doctor-export", { description: "Export runtime doctor JSON report; pass --global to include global traces", handler: async (args: string, ctx: any) => { const out = exportReport(ctx.cwd, { includeGlobal: includeGlobal(args) }); notify(ctx, `Exported runtime doctor report to ${out.file}`, "info"); } });
  pi.registerCommand("doctor-cleanup-preview", { description: "Preview entropy/trace/cache and manifest-first final role-state cleanup; pass --global to target global trace store", handler: async (args: string, ctx: any) => { const plan = cleanupPlan(ctx.cwd, { includeGlobal: includeGlobal(args) }); notify(ctx, formatCleanupPlan(plan), plan.summary.actionable ? "warning" : "info"); } });
  pi.registerCommand("doctor-cleanup-apply", { description: "Apply safe entropy/trace cleanup actions; pass --global to target global trace store", handler: async (args: string, ctx: any) => { const plan = cleanupPlan(ctx.cwd, { includeGlobal: includeGlobal(args) }); const result = applyCleanup(plan, { dryRun: false, cwd: ctx.cwd }); notify(ctx, JSON.stringify({ manifestPath: result.manifestPath, summary: result.summary }, null, 2), result.summary.errors ? "warning" : "info"); } });
  pi.registerCommand("doctor-cleanup-policy", { description: "Show runtime cleanup policy", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(defaultCleanupPolicy(), null, 2), "info") });
  pi.registerCommand("doctor-cleanup-history", { description: "List runtime cleanup manifests", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(cleanupHistory(ctx.cwd), null, 2), "info") });
  pi.registerCommand("doctor-sessions-preview", { description: "Preview session permissions/archive candidates without writing; add --write-manifest --yes to persist an apply manifest", handler: async (args: string, ctx: any) => { const wantsWrite = /(^|\s)--write-manifest(\s|$)/.test(args || ""); const confirmed = /(^|\s)--yes(\s|$)/.test(args || ""); if (wantsWrite && !confirmed) return notify(ctx, "Refusing permission-preview manifest write without --write-manifest --yes.", "warning"); const result = runSessionHygiene(args, ctx.cwd, ctx.sessionManager?.getSessionFile?.(), false, /--archive/.test(args || ""), wantsWrite); notify(ctx, `${formatSessionHygienePlan(result.plan)}\npermissions=preview changed=${result.permissions.changedCount || 0} manifestPersisted=${Boolean(result.permissions.preview?.persisted)}${result.archive ? `\narchive=preview candidates=${result.archive.moved.length}` : ""}`, result.plan.summary.permissionChanges || result.plan.summary.archiveCandidates ? "warning" : "info"); } });
  pi.registerCommand("doctor-session-storage", { description: "Inspect metadata-only logical/physical session storage and point-in-time capacity pressure without changing sessions", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(sessionStorageAttribution.inspect({ root: defaultSessionRoot() }), null, 2), "info") });
  pi.registerCommand("doctor-sessions-apply", { description: "Apply private session permissions; archive only with --archive --yes (add --include-one-shot --project=current explicitly)", handler: async (args: string, ctx: any) => { if (!/(^|\s)--yes(\s|$)/.test(args || "")) return notify(ctx, "Refusing session hygiene apply without --yes. Preview with /doctor-sessions-preview first.", "warning"); const archive = /(^|\s)--archive(\s|$)/.test(args || ""); const result = runSessionHygiene(args, ctx.cwd, ctx.sessionManager?.getSessionFile?.(), true, archive); notify(ctx, JSON.stringify({ summary: result.plan.summary, permissions: { changed: result.permissions.changedCount || 0, errors: result.permissions.errors }, archive: result.archive ? { moved: result.archive.moved.length, errors: result.archive.errors, manifestPath: result.archive.manifestPath } : null }, null, 2), result.permissions.errors.length || result.archive?.errors?.length ? "warning" : "info"); } });
  pi.registerCommand("harness-metrics", { description: "Show harness effectiveness metrics (goals, verification, patches, recall, learning); pass --json for raw data", handler: async (args: string, ctx: any) => { const m = collectHarnessMetrics(ctx.cwd); notify(ctx, /--json/.test(args || "") ? JSON.stringify(m, null, 2) : formatHarnessMetrics(m), "info"); } });
  pi.registerCommand("doctor-exclude-state", { description: "Hide .pi runtime state from git status via repo-local .git/info/exclude", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(piStateExclusion(ctx.cwd, true), null, 2), "info") });

  pi.registerTool({ name: "runtime_doctor", label: "Runtime doctor", description: "Inspect Pi runtime health, latency, memory/state size, metadata-only session storage pressure, extension inventory, context state, and hot-path risks.", parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("latency"), Type.Literal("memory"), Type.Literal("context"), Type.Literal("roleRuntime"), Type.Literal("extensions"), Type.Literal("hotPath"), Type.Literal("export"), Type.Literal("cleanupPreview"), Type.Literal("cleanupApply"), Type.Literal("cleanupPolicy"), Type.Literal("cleanupHistory"), Type.Literal("sessionHygiene"), Type.Literal("sessionStorage"), Type.Literal("sessionPermissionsApply"), Type.Literal("harnessMetrics")])), input: Type.Optional(Type.Any()) }), async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
    const op = params.operation || "summary"; let details: any;
    const options = { includeGlobal: includeGlobal(params.input) };
    if (op === "harnessMetrics") { details = collectHarnessMetrics(ctx.cwd); return { content: [{ type: "text", text: formatHarnessMetrics(details) }], details }; }
    if (op === "latency") details = latencyReport(ctx.cwd, options);
    else if (op === "memory") details = memoryReport(ctx.cwd);
    else if (op === "context") details = contextReport(ctx.cwd);
    else if (op === "roleRuntime") details = roleRuntimeReport(ctx.cwd);
    else if (op === "extensions") details = extensionInventory(ctx.cwd);
    else if (op === "hotPath") { const d = doctor(ctx.cwd, options); details = { env: d.env, risks: d.risks, slowest: d.latency.slowest.slice(0, 10) }; }
    else if (op === "export") details = exportReport(ctx.cwd, options);
    else if (op === "cleanupPreview") details = cleanupPlan(ctx.cwd, params.input || {});
    else if (op === "cleanupApply") details = applyCleanup(cleanupPlan(ctx.cwd, params.input || {}), { dryRun: false, cwd: ctx.cwd });
    else if (op === "cleanupPolicy") details = defaultCleanupPolicy(params.input?.policy || {});
    else if (op === "cleanupHistory") details = cleanupHistory(ctx.cwd);
    else if (op === "sessionHygiene") details = runSessionHygiene(params.input || {}, ctx.cwd, ctx.sessionManager?.getSessionFile?.(), false, false);
    else if (op === "sessionStorage") details = sessionStorageAttribution.inspect({ root: params.input?.root || defaultSessionRoot(), previousSnapshot: params.input?.previousSnapshot || null });
    else if (op === "sessionPermissionsApply") details = runSessionHygiene(params.input || {}, ctx.cwd, ctx.sessionManager?.getSessionFile?.(), true, false);
    else details = doctor(ctx.cwd, options);
    return { content: [{ type: "text", text: op === "summary" ? formatDoctor(details) : JSON.stringify(details, null, 2) }], details };
  }});
}

function registerStabilizer(pi: ExtensionAPI) {
  if (!STABILIZER_ENABLED) return;
  pi.registerCommand("stabilize", { description: "Show stabilization status and recommended actions", handler: async (_args: string, ctx: any) => notify(ctx, formatStabilize(stabilizePlan(ctx.cwd)), "info") });
  pi.registerCommand("stabilize-plan", { description: "Show stabilization plan JSON", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(stabilizePlan(ctx.cwd), null, 2), "info") });
  pi.registerCommand("stabilize-context", { description: "Recommend context/runtime-state cleanup", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify({ context: stabilizeStatus(ctx.cwd), recommendations: ["Prefer preview prune commands first", "Keep protected architecture memory", "Avoid full transcript persistence"] }, null, 2), "info") });
  pi.registerCommand("stabilize-memory", { description: "Recommend memory cleanup commands", handler: async (_args: string, ctx: any) => notify(ctx, "Preview first: /cognitive-prune-memory and /reasoning-prune-automated. Apply only after checking counts and keeping architecture/procedural memories.", "info") });
  pi.registerCommand("stabilize-branches", { description: "Recommend branch/subagent cleanup", handler: async (_args: string, ctx: any) => notify(ctx, "Inspect with /branch-list, /subagent-status, /topology-runs. Merge only explicit successful results; prune old final runs with /topology-prune and /subagent-prune.", "info") });
  pi.registerCommand("stabilize-reset-noise", { description: "Write a stabilization checkpoint; does not delete state", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(stabilizeCheckpoint(ctx.cwd, args || "reset-noise checkpoint"), null, 2), "info") });
  pi.registerCommand("stabilize-cleanup-preview", { description: "Preview entropy/trace cleanup automation", handler: async (_args: string, ctx: any) => { const result = stabilizeCleanupPlan(ctx.cwd); notify(ctx, formatCleanupPlan(result), result.summary.actionable ? "warning" : "info"); } });
  pi.registerCommand("stabilize-cleanup-apply", { description: "Apply safe entropy/trace cleanup automation", handler: async (_args: string, ctx: any) => { const result = applyCleanup(stabilizeCleanupPlan(ctx.cwd), { dryRun: false, cwd: ctx.cwd }); notify(ctx, JSON.stringify({ manifestPath: result.manifestPath, summary: result.summary }, null, 2), result.summary.errors ? "warning" : "info"); } });
  pi.registerTool({ name: "session_stabilizer", label: "Session stabilizer", description: "Inspect stability risks and produce recovery/stabilization plans without deleting state.", parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("status"), Type.Literal("plan"), Type.Literal("checkpoint"), Type.Literal("cleanupPreview"), Type.Literal("cleanupApply")])), note: Type.Optional(Type.String()), input: Type.Optional(Type.Any()) }), async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) { const op = params.operation || "plan"; const details = op === "checkpoint" ? stabilizeCheckpoint(ctx.cwd, params.note) : op === "status" ? stabilizeStatus(ctx.cwd) : op === "cleanupPreview" ? stabilizeCleanupPlan(ctx.cwd, params.input || {}) : op === "cleanupApply" ? applyCleanup(stabilizeCleanupPlan(ctx.cwd, params.input || {}), { dryRun: false, cwd: ctx.cwd }) : stabilizePlan(ctx.cwd); return { content: [{ type: "text", text: op === "plan" ? formatStabilize(details) : op === "cleanupPreview" ? formatCleanupPlan(details) : JSON.stringify(details, null, 2) }], details }; } });
}

function registerPerformanceOptimizer(pi: ExtensionAPI) {
  if (!PERF_ENABLED) return;
  pi.registerCommand("perf-profile", { description: "Profile Pi extension/runtime performance from repo-local traces; pass --global to include global traces", handler: async (args: string, ctx: any) => { const p = perfProfile(ctx.cwd, { includeGlobal: includeGlobal(args) }); writeJson(join(ctx.cwd, PERF_STATE_DIR, "latest-profile.json"), p); notify(ctx, formatPerf(p), "info"); } });
  pi.registerCommand("perf-hot-path", { description: "Show hot path latency suspects; pass --global to include global traces", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(perfProfile(ctx.cwd, { includeGlobal: includeGlobal(args) }).hot, null, 2), "info") });
  pi.registerCommand("perf-regression", { description: "Check for obvious performance regressions; pass --global to include global traces", handler: async (args: string, ctx: any) => { const r = perfRegression(ctx.cwd, { includeGlobal: includeGlobal(args) }); notify(ctx, JSON.stringify(r, null, 2), r.ok ? "info" : "warning"); } });
  pi.registerCommand("perf-compare", { description: "Create/compare local performance baseline; pass --global to include global traces", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(perfCompare(ctx.cwd, { includeGlobal: includeGlobal(args) }), null, 2), "info") });
  pi.registerCommand("perf-baseline", { description: "Capture current trace profile as performance baseline; pass --global to include global traces", handler: async (args: string, ctx: any) => { const p = perfProfile(ctx.cwd, { includeGlobal: includeGlobal(args) }); const file = join(ctx.cwd, PERF_STATE_DIR, "baseline.json"); writeJson(file, p); notify(ctx, `Captured baseline ${file}`, "info"); } });
  pi.registerCommand("perf-after", { description: "Compare current trace profile against baseline; pass --global to include global traces", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(perfCompare(ctx.cwd, { includeGlobal: includeGlobal(args) }), null, 2), "info") });
  pi.registerCommand("perf-report", { description: "Show profile plus fix recommendations; pass --global to include global traces", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(perfFixPlan(ctx.cwd, { includeGlobal: includeGlobal(args) }), null, 2), "info") });
  pi.registerCommand("perf-fix-plan", { description: "Recommend safe performance fixes; pass --global to include global traces", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(perfFixPlan(ctx.cwd, { includeGlobal: includeGlobal(args) }), null, 2), "info") });
  pi.registerCommand("perf-apply-safe", { description: "Write safe local performance env recommendations", handler: async (_args: string, ctx: any) => { const file = join(ctx.cwd, PERF_STATE_DIR, "safe-env.txt"); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "PI_PROMPT_SUGGESTIONS_REFINE=off\nPI_COGNITIVE_AUTO_CONSOLIDATE=0\nPI_TRACE_CAPTURE_PAYLOADS=0\n"); notify(ctx, `Wrote ${file}; source it manually if desired.`, "info"); } });
  pi.registerTool({ name: "performance_optimizer", label: "Performance optimizer", description: "Profile traces, detect latency regressions, compare baselines, and recommend safe runtime performance fixes.", parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("profile"), Type.Literal("hotPath"), Type.Literal("regression"), Type.Literal("compare"), Type.Literal("baseline"), Type.Literal("after"), Type.Literal("report"), Type.Literal("fixPlan"), Type.Literal("applySafe")])), input: Type.Optional(Type.Any()) }), async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) { const op = params.operation || "profile"; const options = { includeGlobal: includeGlobal(params.input) }; let details: any; if (op === "hotPath") details = perfProfile(ctx.cwd, options).hot; else if (op === "regression") details = perfRegression(ctx.cwd, options); else if (op === "compare" || op === "after") details = perfCompare(ctx.cwd, options); else if (op === "baseline") { const p = perfProfile(ctx.cwd, options); const file = join(ctx.cwd, PERF_STATE_DIR, "baseline.json"); writeJson(file, p); details = { file, profile: p }; } else if (op === "fixPlan" || op === "report") details = perfFixPlan(ctx.cwd, options); else if (op === "applySafe") { const file = join(ctx.cwd, PERF_STATE_DIR, "safe-env.txt"); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "PI_PROMPT_SUGGESTIONS_REFINE=off\nPI_COGNITIVE_AUTO_CONSOLIDATE=0\nPI_TRACE_CAPTURE_PAYLOADS=0\n"); details = { file }; } else details = perfProfile(ctx.cwd, options); return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }; } });
}
