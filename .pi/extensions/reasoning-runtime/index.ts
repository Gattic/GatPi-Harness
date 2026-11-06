import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";

const require = createRequire(import.meta.url);
let renderInjectedReasoningContext: any;
let richScaffold: any;
let dedupeInjectedContext: any;
let selectInjectionMemory: any;

const ENABLED = process.env.PI_COGNITIVE_AUTOMATION !== "0";
const AUTO_INJECT = process.env.PI_COGNITIVE_AUTO_INJECT !== "0";
const AUTO_VERIFY = process.env.PI_COGNITIVE_AUTO_VERIFY !== "0";
const AUTO_BRANCH = process.env.PI_COGNITIVE_AUTO_BRANCH === "1";
const BRANCHING_ENABLED = process.env.PI_COGNITIVE_BRANCHING_ENABLED !== "0";
const CONTEXT_BUDGET_TOKENS = Number(process.env.PI_COGNITIVE_CONTEXT_BUDGET_TOKENS || 1800);
const COGNITIVE_INJECT_MAX_CHARS = Math.max(500, Number(process.env.PI_COGNITIVE_INJECT_MAX_CHARS || 2500) || 2500);
const AUTO_ROUTE_PARENT_RESULT_MAX_CHARS = 12000;
const VERIFY_DEBOUNCE_MS = Number(process.env.PI_COGNITIVE_VERIFY_DEBOUNCE_MS || 1500);
const EXTENSION_VERSION = "reasoning-runtime-2026-07-26.2";
const ROLE_RUNTIME_VERSION = 2;
const ROLE_CONTRACT_VERSION = "role-v2";
const ROLE_RESULT_SCHEMA_VERSION = 2;
const AUTO_CONSOLIDATE = process.env.PI_COGNITIVE_AUTO_CONSOLIDATE === "1";
const CONSOLIDATE_DEBOUNCE_MS = Number(process.env.PI_COGNITIVE_CONSOLIDATE_DEBOUNCE_MS || 60_000);
const CONSOLIDATE_INTERVAL_MS = Number(process.env.PI_COGNITIVE_CONSOLIDATE_INTERVAL_MS || 30 * 60_000);
const EXTENSION_SOURCE_PATH = fileURLToPath(import.meta.url);
const MAX_OBJECTIVE_MEMORY = Number(process.env.PI_REASONING_MAX_OBJECTIVE_MEMORY || 8);
const SUBAGENT_MAX_CONCURRENT = Number(process.env.PI_SUBAGENT_MAX_CONCURRENT || 8);
const SUBAGENT_DEFAULT_WALL_CLOCK_MS = Number(process.env.PI_SUBAGENT_DEFAULT_WALL_CLOCK_MS || 5 * 60_000);
const SUBAGENT_DEFAULT_STEP_BUDGET = Number(process.env.PI_SUBAGENT_DEFAULT_STEP_BUDGET || 8);
const SUBAGENT_DEFAULT_TOOL_CALL_BUDGET = Number(process.env.PI_SUBAGENT_DEFAULT_TOOL_CALL_BUDGET || 64);
const SUBAGENT_DEFAULT_QUEUE_WAIT_MS = Number(process.env.PI_SUBAGENT_DEFAULT_QUEUE_WAIT_MS || 5 * 60_000);
const SUBAGENT_MAX_LENGTH_CONTINUATIONS = Number(process.env.PI_SUBAGENT_MAX_LENGTH_CONTINUATIONS || 0);
const SUBAGENT_OPERATIONS = ["preflight", "fanout", "create", "launch", "run", "list", "status", "get", "wait", "steer", "interrupt", "cancel", "continue", "resume", "merge"];
const SUBAGENT_OPERATION_ALIASES = { queue: "launch", inspect: "get", trace: "get" };
const SUBAGENT_MERGE_POLICIES = ["none", "summary_only", "full_result", "proposed_patch"];
const SUBAGENT_MERGE_POLICY_ALIASES = { manual: "none" };
const TOPOLOGY_CONFIG_DIRS = (process.env.PI_TOPOLOGY_CONFIG_DIRS || ".pi/topologies,topologies").split(",").map((s) => s.trim()).filter(Boolean);
const COGNITIVE_STORAGE_ROOT = process.env.PI_COGNITIVE_STORAGE_ROOT ? resolve(process.env.PI_COGNITIVE_STORAGE_ROOT) : null;
const SUBAGENT_STATE_ROOT = process.env.PI_SUBAGENT_STATE_ROOT ? resolve(process.env.PI_SUBAGENT_STATE_ROOT) : null;
const LIB_ROOT = resolve(EXTENSION_SOURCE_PATH, "..", "..", "..", "..");
const { AUTOMATED_RETENTION, retentionBound, rotateSnapshotKeys } = require(join(LIB_ROOT, "src", "reasoning-runtime.js"));
const { inspectAutoRouteSafety } = require(join(LIB_ROOT, "src", "role-runtime-containment.js"));
const { resolveRoleRuntimeConfig } = require(join(LIB_ROOT, "src", "role-runtime-rollout.js"));
const { ROLE_RUN_SCHEMA_VERSION, sanitizeRoleRunRecord, compactRoleToolOutcome, roleToolResultOverride } = require(join(LIB_ROOT, "src", "role-run-provenance.js"));
const { classifyRoleTerminal, determineRoleRunEligibility } = require(join(LIB_ROOT, "src", "role-field-evidence.js"));
const { runtimeSourceFingerprint } = require(join(LIB_ROOT, "src", "runtime-source-fingerprint.js"));
const { diagnosticTextMetadata } = require(join(LIB_ROOT, "src", "managed-state-sanitizer.js"));
const ROLE_RUNTIME_SOURCE_HASH = runtimeSourceFingerprint(process.cwd()).hash;
const { createExtensionTelemetry, instrumentExtensionCommands, contextSessionKind, normalizeOperation } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));
const ROLE_RUNTIME_CONFIG = resolveRoleRuntimeConfig(process.env, { cwd: process.cwd() });
const ROLE_RUNTIME_V2_AVAILABLE = ROLE_RUNTIME_CONFIG.selectedVersion === 2;
const ROLE_MUTATION_MODE = ROLE_RUNTIME_CONFIG.mutationMode;
const { normalizeRouterMode, decideRoleRoute, compactRouterDecision, authorizeWorkerShadowCanary, workerShadowCanaryScopeSafe, buildWorkerShadowCanaryTopology, ROUTER_CLASSIFIER_VERSION, WORKER_SHADOW_CANARY_MODEL, WORKER_SHADOW_CANARY_THINKING_LEVEL } = require(join(LIB_ROOT, "src", "role-router.js"));
const { buildTaskScaffold, buildTaskDecomposition, classifyTaskModality, resolveTaskObjective, taskObjectiveFromSession, USER_TASK_ENTRY_TYPE } = require(join(LIB_ROOT, "src", "task-modality.js"));
const { classifyObsidianIntent } = require(join(LIB_ROOT, "src", "obsidian-intent.js"));
const { listBuiltInRoleTopologies, getBuiltInRoleTopology } = require(join(LIB_ROOT, "src", "role-topologies.js"));
const { buildFanout } = require(join(LIB_ROOT, "src", "plan-fanout.js"));
const { recipeSummary, listInstalled, recommendRecipes, installRecipe, lintRecipes, upgradePreview } = require(join(LIB_ROOT, "src", "topology-recipes.js"));
const GOVERNED_SKILL_INTAKE_TOPOLOGY_ID = "governed-skill-intake";
const SKILL_INTAKE_ENABLED = process.env.PI_SKILL_INTAKE_ENABLED !== "0";
const BUILTIN_ROLE_TOPOLOGY_IDS = listBuiltInRoleTopologies().filter((topology: any) => topology.metadata?.explicitOnly !== true && topology.metadata?.autoRoutePolicy !== "never").map((topology: any) => topology.topologyId);
const TOPOLOGY_AUTO_PRUNE = process.env.PI_TOPOLOGY_AUTO_PRUNE === "1";
const TOPOLOGY_AUTO_ROUTE_DEFAULT_MODE = process.env.PI_SUBAGENT_PARENT_ID ? "off" : parseAutoRouteMode(ROLE_RUNTIME_CONFIG.autoRouteMode);
const TOPOLOGY_AUTO_ROUTE_SUBAGENTS = process.env.PI_TOPOLOGY_AUTO_ROUTE_SUBAGENTS !== "0";
const TOPOLOGY_AUTO_ROUTE_MIN_CHARS = Number(process.env.PI_TOPOLOGY_AUTO_ROUTE_MIN_CHARS || 24);
const TOPOLOGY_AUTO_ROUTE_COOLDOWN_MS = Number(process.env.PI_TOPOLOGY_AUTO_ROUTE_COOLDOWN_MS || 5000);
const TOPOLOGY_AUTO_ROUTE_DEFAULT_TOPOLOGY = process.env.PI_TOPOLOGY_AUTO_ROUTE_TOPOLOGY || "project-planner-coder-verifier";
const WORKER_SHADOW_CANARY_ENABLED = ROLE_RUNTIME_CONFIG.workerShadowCanaryEnabled === true;
const SKILL_AUTO_CAPTURE = process.env.PI_SKILL_AUTO_CAPTURE !== "0";
const EXECUTION_OUTCOME_SKILLS = process.env.PI_EXECUTION_OUTCOME_SKILLS !== "0";
const SKILL_INJECT_MAX = Math.max(0, Number(process.env.PI_SKILL_INJECT_MAX || 1));
const SKILL_INJECT_MIN_SCORE = Number(process.env.PI_SKILL_INJECT_MIN_SCORE || 0.5);
const SKILL_META_INJECT_MAX = Math.max(0, Number(process.env.PI_SKILL_META_INJECT_MAX || 0));
const SKILL_SNAPSHOT_ON_START = process.env.PI_SKILL_SNAPSHOT_ON_START === "1";
const HERMES_SKILL_AUTO_DRAFT = process.env.PI_HERMES_SKILL_AUTO_DRAFT === "1";
let COGNITIVE_TIMING = process.env.PI_COGNITIVE_TIMING === "1";
const COGNITIVE_TIMING_LIMIT = Number(process.env.PI_COGNITIVE_TIMING_LIMIT || 200);
const REASONING_PERSIST_DEBOUNCE_MS = Number(process.env.PI_REASONING_PERSIST_DEBOUNCE_MS || 2000);
const REASONING_AUTO_PRUNE_AUTOMATED = process.env.PI_REASONING_AUTO_PRUNE_AUTOMATED !== "0";
// Each automated prune writes a full pre-prune backup. Without a ceiling those
// backups outlive the artifacts they protect and dominate runtime storage.
const REASONING_SNAPSHOT_KEEP = Math.max(1, retentionBound(process.env.PI_REASONING_SNAPSHOT_KEEP || 3, 3));
// Only snapshots this process wrote are rotated. Backups left by earlier
// sessions are historical evidence: reclaiming them is an explicit operator
// decision, not a side effect of bounding growth.
const reasoningSnapshots: string[] = [];
const REASONING_AUTO_PRUNE_AUTOMATED_KEEP = retentionBound(process.env.PI_REASONING_AUTO_PRUNE_AUTOMATED_KEEP || AUTOMATED_RETENTION.evidence, AUTOMATED_RETENTION.evidence);
const REASONING_AUTO_PRUNE_AUTOMATED_MAX = retentionBound(process.env.PI_REASONING_AUTO_PRUNE_AUTOMATED_MAX || 240, 240);
const REASONING_AUTO_PRUNE_ACTIONS_KEEP = retentionBound(process.env.PI_REASONING_AUTO_PRUNE_ACTIONS_KEEP || AUTOMATED_RETENTION.executorActions, AUTOMATED_RETENTION.executorActions);
const REASONING_AUTO_PRUNE_ACTIONS_MAX = retentionBound(process.env.PI_REASONING_AUTO_PRUNE_ACTIONS_MAX || 2500, 2500);
const HOT_PATH_MEMORY_TYPES = (process.env.PI_COGNITIVE_HOT_MEMORY_TYPES || "semantic,procedural,strategic").split(",").map((s) => s.trim()).filter(Boolean);
const HOT_PATH_EXCLUDED_PROVENANCE = ["verification-adapter", "anchoring-adapter", "pi-message"];
const TOPOLOGY_PRUNE_KEEP = Number(process.env.PI_TOPOLOGY_PRUNE_KEEP || 100);
const TOPOLOGY_PRUNE_OLDER_THAN_DAYS = Number(process.env.PI_TOPOLOGY_PRUNE_OLDER_THAN_DAYS || 30);

type AskRun = { id: string; question: string; status: "running" | "succeeded" | "failed"; answer?: string; error?: string; createdAt: string; updatedAt: string };
type Runtime = {
  boundary: any;
  cwd: string;
  prompt: string;
  touched: Set<string>;
  pending: Map<string, { toolName: string; input: any; beforeText?: string; path?: string }>;
  verifyTimer?: ReturnType<typeof setTimeout>;
  consolidateTimer?: ReturnType<typeof setTimeout>;
  reasoningPersistTimer?: ReturnType<typeof setTimeout>;
  reasoningAutoPruneTimer?: ReturnType<typeof setTimeout>;
  reasoningDirty?: boolean;
  lastConsolidatedAt?: number;
  objectiveSyncedPrompt?: string;
  topologyPrunedAt?: number;
  autoRouteMode: AutoRouteMode;
  autoRouteRuns?: Map<string, AbortController>;
  autoRouteLast?: any;
  autoRouteLastStartedAt?: number;
  autoRouteTurnResult?: any;
  autoRouteGuidanceKey?: string;
  autoRouteInjectedGuidanceKey?: string;
  lastInjectedContext?: string;
  fullScaffoldInjected?: boolean;
  askRuns?: AskRun[];
  askPanelOpen?: boolean;
  askInputCleanup?: () => void;
  subagentRuns?: Map<string, AbortController>;
  invokedSkillIds?: string[];
  skillAssistant?: any;
  lastSuggestedSkillIds?: string[];
  lastToolError?: boolean;
  timings?: any[];
  telemetry?: any;
  projectMemoryRollout?: any;
  projectMemoryCandidates?: any;
  skillMutationAuthorized?: boolean;
  typesafeTurn?: TypesafeTurn;
  extensionPrompt?: boolean;
  userScaffold?: any;
  pilotRequestId?: string;
};
type TypesafeTurn = {
  promise: Promise<any>;
  local: { modality: string; researchMemory: boolean };
  sessionKind: string;
};

let runtime: Runtime | undefined;
let askSeq = 0;
const boundaryCache = new Map<string, any>();
const staleCleanupDone = new Set<string>();
const STALE_CLEANUP_MARKER_KEY = "maintenance/stale-reasoning-cleanup";

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => {
    const type = String(b?.type || "").toLowerCase();
    if (type.includes("thinking") || type.includes("reasoning")) return "";
    return b?.text || b?.content || "";
  }).filter(Boolean).join("\n");
  if (content && typeof content === "object") {
    const type = String(content.type || "").toLowerCase();
    if (type.includes("thinking") || type.includes("reasoning")) return "";
    return content.text || content.content || "";
  }
  return String(content ?? "");
}
function extractPaths(value: any): string[] {
  const out = new Set<string>();
  const visit = (x: any) => {
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x)) {
      if ((k === "path" || k.endsWith("Path") || k === "file") && typeof v === "string") out.add(v.replace(/^@/, ""));
      else if (Array.isArray(v)) v.forEach(visit);
      else if (typeof v === "object") visit(v);
    }
  };
  visit(value);
  return [...out];
}
function safeRead(cwd: string, p?: string) {
  if (!p) return undefined;
  try { return readFileSync(join(cwd, p), "utf8"); } catch { return undefined; }
}
function sha256(text: string) { return createHash("sha256").update(text).digest("hex"); }
function sourceText() { try { return readFileSync(EXTENSION_SOURCE_PATH, "utf8"); } catch { return ""; } }
function sourceFingerprint() { const text = sourceText(); return { path: EXTENSION_SOURCE_PATH, sha256: text ? sha256(text) : "unavailable", bytes: text.length }; }
function short(text: string, n = 1600) { return text.length > n ? `${text.slice(0, n)}…` : text; }
function elapsedMs(start: number) { return Date.now() - start; }
function recordTiming(rt: Runtime | undefined, name: string, start: number, extra: any = {}) {
  if (!COGNITIVE_TIMING || !rt) return;
  const event = { at: new Date().toISOString(), name, durationMs: elapsedMs(start), ...extra };
  rt.timings = [...(rt.timings || []), event].slice(-COGNITIVE_TIMING_LIMIT);
  rt.boundary?.trace?.emit?.({ category: "performance", name: `cognitive.timing.${name}`, durationMs: event.durationMs, payload: extra });
}
function formatTimings(rt: Runtime | undefined) { return rt?.timings?.length ? rt.timings.slice(-40).map((t: any) => `${t.at}\t${t.name}\t${t.durationMs}ms\t${JSON.stringify(Object.fromEntries(Object.entries(t).filter(([k]) => !["at", "name", "durationMs"].includes(k))))}`).join("\n") : `No cognitive timings recorded. Use /cognitive-timing on or set PI_COGNITIVE_TIMING=1 to enable.`; }
function assistantTurnHasFailureSignal(text: string) {
  const raw = String(text || "");
  const withoutBenign = raw
    .replace(/\b(?:no|zero|0)\s+(?:warnings?\s*(?:\/|and)\s*)?(?:fatal\s+)?errors?\b/gi, " ")
    .replace(/\berrors?\s*:\s*(?:0|none|no)\b/gi, " ")
    .replace(/\bfailures?\s*:\s*0\b/gi, " ")
    .replace(/\bno findings\b/gi, " ")
    .replace(/\bno recent (?:log )?errors?\b/gi, " ")
    .replace(/\bnot blocked\b/gi, " ");
  return /\b(traceback|uncaught exception|fatal|blocked)\b/i.test(withoutBenign)
    || /\b(?:i|we)\s+(?:could(?: not|n't)|can(?:not|'t)|failed|was unable|were unable)\b/i.test(withoutBenign)
    || /\b(?:build|tests?|verification|command|push|commit|download|pretokeni[sz]ation)\s+(?:failed|errored|blocked)\b/i.test(withoutBenign);
}
function verifierId(label: string) { return String(label || "verifier").replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "verifier"; }
function verifierFromProfile(cwd: string, item: any) {
  const raw = String(item?.command || "").trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  const command = parts[0];
  const args = Array.isArray(item.args) ? item.args.map(String) : parts.slice(1);
  const label = item.commandLine || [command, ...args].join(" ");
  return {
    id: item.id || verifierId(label),
    kind: item.kind || "unit",
    command,
    args,
    cwd,
    files: Array.isArray(item.files) && item.files.length ? item.files : ["**/*"],
    cacheable: false,
    timeoutMs: item.timeoutMs || 120_000,
    parser: () => ({ artifacts: Array.isArray(item.artifacts) ? item.artifacts : [] }),
  };
}
function projectVerificationVerifiers(cwd: string) {
  try {
    const { createProjectIndex } = require(join(LIB_ROOT, "src", "project-intelligence.js"));
    const max = Math.max(0, Number(process.env.PI_COGNITIVE_AUTO_VERIFY_MAX || 4));
    const includeProjectProfiles = process.env.PI_COGNITIVE_AUTO_VERIFY_PROJECT_PROFILES === "1";
    return (createProjectIndex(cwd).verifierProfiles || [])
      .filter((item: any) => item.automatic === true || (includeProjectProfiles && ["changed", "quick"].includes(item.profile)))
      .map((item: any) => verifierFromProfile(cwd, item))
      .filter(Boolean)
      .slice(0, max);
  } catch {
    return [];
  }
}
function pruneAssistantTurnMemory(boundary: any, { keep = 200, apply = false } = {}) {
  const entries = (boundary.memory.findWhere ? boundary.memory.findWhere((e: any) => e.type === "episodic" && e.title === "Assistant turn", Infinity) : boundary.memory.retrieve("Assistant turn", { limit: Infinity, types: ["episodic"] }).entries.filter((e: any) => e.title === "Assistant turn")) || [];
  const sorted = entries.slice().sort((a: any, b: any) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
  const removeIds = new Set(sorted.slice(Math.max(0, Number(keep) || 0)).map((e: any) => e.id));
  if (!apply) return { apply: false, assistantTurns: entries.length, keep, wouldRemove: removeIds.size };
  const snapshotKey = `memory/snapshots/pre-assistant-turn-prune-${Date.now()}`;
  try { boundary.storage?.writeJson?.(snapshotKey, boundary.storage?.readJson?.("cognitive-memory", {})); } catch {}
  const removed = boundary.memory.removeWhere((e: any) => removeIds.has(e.id), `assistant-turn retention keep=${keep}`).removed || [];
  boundary.memory.persist();
  return { apply: true, assistantTurnsBefore: entries.length, keep, removed: removed.length, remaining: entries.length - removed.length, snapshotKey };
}
function formatArtifact(a: any): string {
  if (!a) return "";
  const title = a.objective || a.task || a.decision || a.statement || a.claim || a.action || a.kind || a.type;
  const body = a.summary || a.publicSummary || a.rationale || a.message || a.content || "";
  return [`[${a.type}] ${a.id}: ${title}`, body ? short(String(body).replace(/\s+/g, " "), 500) : ""].filter(Boolean).join("\n");
}
function formatArtifacts(items: any[]): string { return items?.length ? items.map(formatArtifact).join("\n\n---\n\n") : "No reasoning artifacts"; }
const STALE_REASONING_RE = /runtime\\*\.arch\.coordinate|Role architecture output|Current cognitive route|role[- ]architecture|role-specialized orchestration/i;
function isStaleReasoningText(text: string) { return STALE_REASONING_RE.test(text || ""); }
function reasoningAdapter(rt: Runtime) {
  const adapter = rt.boundary.reasoning || rt.boundary.orchestration;
  if (adapter?.createPlan && adapter?.decomposeTask && adapter?.createCheckpoint) return adapter;
  return null;
}
function summarizeVerificationResult(boundary: any, result: any) {
  try { return boundary?.verification?.summarize?.(result) || { id: result?.id, ok: result?.ok, status: result?.status, evidenceFile: result?.evidenceFile }; }
  catch { return { id: result?.id, ok: result?.ok, status: result?.status, evidenceFile: result?.evidenceFile }; }
}
function snapshotReasoningState(boundary: any, key: string) {
  if (typeof boundary?.storage?.copyJson === "function") return boundary.storage.copyJson("reasoning-runtime", key);
  const adapter = boundary?.reasoning || boundary?.orchestration;
  return boundary?.storage?.writeJson?.(key, adapter?.export?.() || {});
}
function requireReasoning(ctx: any) {
  if (!runtime) { ctx.ui.notify("Reasoning runtime is not initialized", "warning"); return null; }
  const adapter = reasoningAdapter(runtime);
  if (!adapter) { ctx.ui.notify("Reasoning runtime adapter is unavailable; reload Pi or rerun scripts/check-all.sh", "warning"); return null; }
  return adapter;
}
function sanitizeContextText(text: string) {
  return String(text || "").split(/\n\n+/).filter((block) => !isStaleReasoningText(block)).join("\n\n") || "none";
}
function normalizeText(text: string) { return String(text || "").trim().toLowerCase().replace(/\s+/g, " "); }
const META_RECOMMENDATION_PATTERNS = [
  /(?:^|[.!?;]\s+)(?:what\s+(?:are\s+)?(?:the\s+)?(?:next\s+)?(?:recommended|suggested)\s+steps?|what\s+next|recommend\s+(?:the\s+)?next\s+steps?|suggest\s+(?:the\s+)?next\s+steps?)(?:\?|$)/i,
  /(?:^|[.!?;]\s+)what\s+should\s+(?:we|i)\s+do\s+next(?:\?|$)/i,
  /(?:^|[.!?;]\s+)(?:after|following)\s+(?:a\s+)?(?:reload|restart|validation|check(?:s)?),?\s+what\s+should\s+(?:we|i)\s+do\s+next(?:\?|$)/i,
  /(?:^|[.!?;]\s+)(?:(?:i|we)\s+(?:reloaded|restarted|validated|checked)[^.!?;]*[.!?;]\s*)?(?:please\s+)?(?:proceed|continue)\s+with\s+(?:the\s+)?next(?:\s+practical)?\s+step(?:\.?|$)/i,
  /^(?:please\s+)?(?:proceed|continue)(?:\.?|$)/i,
];
function isMetaRecommendationPrompt(prompt: string) { const text = String(prompt || "").trim(); return META_RECOMMENDATION_PATTERNS.some((re) => re.test(text)); }
function dedupeObjectiveMemory(boundary: any, entriesOverride?: any[]) {
  const entries = entriesOverride || objectiveEntries(boundary);
  const seen = new Set<string>();
  const keep = new Set<string>();
  for (const entry of entries.slice().reverse()) {
    const key = normalizeText(entry.content);
    if (!seen.has(key) && keep.size < MAX_OBJECTIVE_MEMORY) { seen.add(key); keep.add(entry.id); }
  }
  return boundary.memory.removeWhere((entry: any) => entry.type === "strategic" && entry.title === "User objective" && !keep.has(entry.id), "objective memory dedupe/retention");
}
function objectiveEntries(boundary: any) {
  if (boundary.memory.findWhere) return boundary.memory.findWhere((e: any) => e.type === "strategic" && e.title === "User objective");
  return boundary.memory.retrieve("User objective", { limit: 200 }).entries.filter((e: any) => e.type === "strategic" && e.title === "User objective");
}
function rememberObjective(boundary: any, prompt: string) {
  const text = short(prompt, 1000);
  const normalized = normalizeText(text);
  const entries = objectiveEntries(boundary);
  const existing = entries.find((e: any) => normalizeText(e.content) === normalized);
  let changed = false;
  if (!existing) { boundary.memory.remember({ type: "strategic", title: "User objective", content: text, tags: ["objective"], verification: "inferred", confidence: 0.58, provenance: { source: "pi-input" } }); changed = true; }
  // Re-scan after insertion: passing the pre-insert `entries` snapshot here
  // omits the new objective from the keep set and immediately prunes it.
  const removed = dedupeObjectiveMemory(boundary);
  if ((removed.removed?.length || 0) > 0) changed = true;
  if (changed) boundary.memory.persist();
}
function scaffoldTemplate(prompt: string, options: any = {}) { return buildTaskScaffold(prompt, options); }
function decompositionTemplate(prompt: string, options: any = {}) { return buildTaskDecomposition(prompt, options); }
function restoreUserScaffold(rt: Runtime, ctx: any) {
  const objective = taskObjectiveFromSession(ctx.sessionManager.getBranch());
  rt.userScaffold = objective ? { plan: scaffoldTemplate(objective), decomposition: decompositionTemplate(objective) } : undefined;
  rt.prompt = "";
  rt.extensionPrompt = false;
  // The active branch may not contain the injection cached on the branch left.
  rt.lastInjectedContext = undefined;
  rt.fullScaffoldInjected = false;
}
function updateActiveObjective(boundary: any, prompt: string) {
  const blocks = boundary.context.pack({ tokenBudget: 50_000, query: "Active user objective", includeScratch: true }).blocks || [];
  for (const item of blocks) {
    const block = item.block || item;
    if (block.title === "Active user objective" || block.kind === "objective") boundary.context.remove(block.id, "superseded by current objective");
  }
  boundary.context.upsert({ layer: "L2", title: "Active user objective", content: short(prompt || "current task", 1000), kind: "objective", tags: ["active-task"], verification: "assumed" });
  boundary.context.persist();
}
function templateFingerprint() { return sha256(JSON.stringify({ scaffold: scaffoldTemplate("version-check"), decomposition: decompositionTemplate("version-check") })); }
function scaffoldIsRich(scaffold: any) { return (richScaffold || ((s: any) => (s?.plan?.steps?.length || 0) > 0 && (s?.plan?.risks?.length || 0) > 0 && (s?.plan?.successCriteria?.length || 0) > 0 && (s?.decomposition?.subtasks?.length || 0) > 0))(scaffold); }
function syncObjective(rt: Runtime, prompt: string) {
  const normalized = normalizeText(prompt || "current task");
  if (rt.objectiveSyncedPrompt === normalized) return;
  updateActiveObjective(rt.boundary, prompt);
  rememberObjective(rt.boundary, prompt);
  rt.objectiveSyncedPrompt = normalized;
}
function liveVersion() {
  const adapter = runtime ? reasoningAdapter(runtime) : null;
  const scaffold = { plan: scaffoldTemplate("version-check"), decomposition: decompositionTemplate("version-check") };
  return {
    version: EXTENSION_VERSION,
    source: sourceFingerprint(),
    templateHash: templateFingerprint(),
    scaffoldTemplateActive: scaffold.plan.steps.length > 0 && scaffold.plan.risks.length > 0 && scaffold.plan.successCriteria.length > 0,
    decompositionTemplateActive: scaffold.decomposition.subtasks.length > 0,
    reasoningAdapterAvailable: Boolean(adapter),
    config: { AUTO_INJECT, AUTO_VERIFY, AUTO_CONSOLIDATE, COGNITIVE_TIMING, CONTEXT_BUDGET_TOKENS, VERIFY_DEBOUNCE_MS, CONSOLIDATE_DEBOUNCE_MS, CONSOLIDATE_INTERVAL_MS, REASONING_PERSIST_DEBOUNCE_MS, REASONING_AUTO_PRUNE_AUTOMATED, REASONING_SNAPSHOT_KEEP, REASONING_AUTO_PRUNE_AUTOMATED_KEEP, REASONING_AUTO_PRUNE_AUTOMATED_MAX, REASONING_AUTO_PRUNE_ACTIONS_KEEP, REASONING_AUTO_PRUNE_ACTIONS_MAX, HOT_PATH_MEMORY_TYPES, MAX_OBJECTIVE_MEMORY },
  };
}
function architectureMemoryStats() {
  if (!runtime) return { available: false, count: 0, duplicateCount: 0, ids: [] };
  const entries = runtime.boundary.memory.retrieve("Reasoning runtime architecture", { limit: 200 }).entries
    .filter((e: any) => e.type === "semantic" && e.title === "Reasoning runtime architecture");
  return { available: true, count: entries.length, duplicateCount: Math.max(0, entries.length - 1), ids: entries.map((e: any) => e.id).filter(Boolean).slice(0, 10) };
}
function selfTest() {
  const version = liveVersion();
  const scaffold = { kind: "reasoning.scaffold", plan: scaffoldTemplate("self-test prompt"), decomposition: decompositionTemplate("self-test prompt"), checkpoint: { type: "reasoning_checkpoint", kind: "plan", publicSummary: "self-test", artifactIds: [], scratchpadRef: null, result: {}, nextActions: [] } };
  const rendered = renderInjectedReasoningContext ? renderInjectedReasoningContext({ version, scaffold, memoryEntries: [], layeredText: "[L2:objective] Active user objective\nself-test prompt", stalePattern: STALE_REASONING_RE }) : "";
  const architectureMemory = architectureMemoryStats();
  const checks = {
    version: version.version === EXTENSION_VERSION,
    sourceFingerprint: Boolean(version.source?.sha256 && version.source.sha256 !== "unavailable"),
    scaffoldSteps: scaffold.plan.steps.length > 0,
    scaffoldRisks: scaffold.plan.risks.length > 0,
    scaffoldSuccessCriteria: scaffold.plan.successCriteria.length > 0,
    decompositionSubtasks: scaffold.decomposition.subtasks.length > 0,
    renderHasVersionBanner: /### Runtime version/.test(rendered),
    renderHasNoStaleText: !isStaleReasoningText(rendered),
    renderDoesNotExposeScratchpad: !/(private working notes|hidden reasoning|chain[_ -]?of[_ -]?thought|\"scratchpadRef\"\s*:\s*\"scratch_)/i.test(rendered),
    architectureSemanticMemoryDeduped: architectureMemory.available && architectureMemory.count <= 1,
  };
  return { ok: Object.values(checks).every(Boolean), checks, architectureMemory, version, renderedPreview: short(rendered, 1200) };
}
function debugContext(prompt = "") {
  if (!runtime) return "Reasoning runtime boundary is not initialized.";
  const adapter = reasoningAdapter(runtime);
  const memoryRaw = runtime.boundary.memory.retrieve(prompt || runtime.prompt || "project", { limit: 12 }).entries || [];
  const memory = memoryRaw.filter((e: any) => !isStaleReasoningText(`${e.title || ""}\n${e.content || ""}`));
  const packed = runtime.boundary.context.pack({ tokenBudget: CONTEXT_BUDGET_TOKENS, query: prompt || runtime.prompt || "", includeScratch: false });
  const scaffold = adapter ? { available: true, metrics: adapter.metrics?.() } : { available: false };
  return JSON.stringify({
    scaffold,
    memory: { raw: memoryRaw.length, filtered: memory.length, source: "boundary.memory.retrieve" },
    layeredContext: { source: "boundary.context.pack", staleFiltered: packed.text !== sanitizeContextText(packed.text || ""), text: sanitizeContextText(packed.text || "") },
    hermes: { source: "HermesAdvisoryAdapter", note: "Hermes is an explicit typed advisory provider with no durable conversation or recall authority." },
    traceEntropy: { entropy: runtime.boundary.entropy.health?.(), recentTrace: runtime.boundary.trace.recent?.(5) || [] },
  }, null, 2);
}
function explicitSkillGovernanceIntent(value: string) { return /\b(skill|skills)\b/i.test(String(value || "")) && /\b(approve|promote|route|routing|publish|publishing|provider|import|topology[- ]write|write.*topology)\b/i.test(String(value || "")); }
function skillMutationBlocked(operation: string) { const details = { ok: false, outcome: "blocked", reasonCode: "explicit-skill-governance-intent-required", operation, message: "This skill governance mutation requires an explicit current-user request in the current turn." }; return { content: [{ type: "text" as const, text: details.message }], details }; }
function formatSkill(skill: any) {
  if (!skill) return "Skill not found";
  return [
    `${skill.skillId} v${skill.version} ${skill.status} confidence=${Number(skill.confidenceScore || 0).toFixed(2)}`,
    `${skill.name} [${skill.category}]`,
    skill.description,
    `tools: ${(skill.requiredTools || []).join(", ") || "none"}`,
    `triggers: ${(skill.triggerConditions || []).slice(0, 5).join("; ") || "none"}`,
    "workflow:",
    ...((skill.workflowSteps || []).map((s: any) => `${s.order || "-"}. ${s.description}`)),
    `validation: ${short(JSON.stringify(skill.validationStrategy || {}), 800)}`,
    `evidence: ${short(JSON.stringify(skill.evidenceState || {}), 1200)}`,
    `approvals: ${short(JSON.stringify(skill.approvals || {}), 500)}`,
  ].filter(Boolean).join("\n");
}
function formatSkillSuggestions(result: any) {
  const rows = result?.suggestions || result?.ranked?.map((r: any) => ({ ...r.skill, score: r.score, why: r.why })) || [];
  return rows.length ? rows.map((s: any) => `${s.skillId}\t${Number(s.score || s.confidence || 0).toFixed(2)}\t${s.status || ""}\t${s.name}\nwhy=${short(JSON.stringify(s.why || {}), 500)}`).join("\n\n") : "No matching skills";
}
function formatSkillList(skills: any[]) { return skills?.length ? skills.map((s: any) => `${s.skillId}\t${s.status}\t${Number(s.confidenceScore || 0).toFixed(2)}\t${s.category}\t${s.name}`).join("\n") : "No skills"; }
function parseSkillId(raw: string, skills: any[] = []) { const id = String(raw || "").trim(); return id && id !== "latest" ? id : skills[0]?.skillId; }
function formatSkillAdvisory(skills: any[], max = SKILL_INJECT_MAX) {
  if (!skills?.length || max <= 0) return "";
  return ["[L2:skills] Relevant procedural skills", ...skills.slice(0, max).map((s: any) => `- ${s.name} (${s.skillId}, confidence ${Number(s.confidenceScore || 0).toFixed(2)}): ${(s.workflowSteps || []).slice(0, 4).map((x: any) => x.description).join(" -> ")}`)].join("\n");
}
function formatFailureAdvisory(patterns: any[], prompt = "") {
  const q = normalizeText(prompt);
  const rows = (patterns || []).filter((p: any) => !q || normalizeText(`${p.symptoms?.join(" ") || ""} ${p.mitigationStrategy || ""}`).split(" ").some((t: string) => t && q.includes(t))).slice(0, 3);
  return rows.length ? ["[L2:skill-failures] Relevant failure patterns to avoid", ...rows.map((p: any) => `- ${p.signature}: ${short(p.mitigationStrategy || p.symptoms?.join("; ") || "failure pattern", 240)}`)].join("\n") : "";
}
function maybeCaptureTopologySkill(rt: Runtime, result: any) {
  if (!SKILL_AUTO_CAPTURE || !result || result.status !== "succeeded") return null;
  try {
    const capture = rt.boundary.skills.captureTopologyRun(result, { repository: { path: rt.cwd }, verification: { ok: result.errors?.length === 0 } });
    rt.boundary.trace.emit({ category: "session", name: "skill.auto_capture", payload: { captureId: capture.captureId, topologyRunId: result.runId } });
    return capture;
  } catch (error: any) {
    rt.boundary.trace.emit({ category: "failure_state", name: "skill.auto_capture_failed", severity: "warn", payload: { error: error?.message || String(error), topologyRunId: result?.runId } });
    return null;
  }
}
function status() {
  if (!runtime) return "Reasoning runtime boundary is not initialized.";
  const b = runtime.boundary;
  const version = liveVersion();
  const stale = !version.scaffoldTemplateActive || !version.decompositionTemplateActive;
  const health = b.entropy.health();
  return [
    stale ? "Reasoning runtime: stale-extension" : "Reasoning runtime: boundary-backed",
    `memory: ${b.memory.metrics().totalEntries ?? "disabled"}`,
    `context: ${b.context.metrics().totalBlocks ?? b.context.metrics().total ?? "enabled"}`,
    `reasoning: ${JSON.stringify((b.reasoning || b.orchestration)?.metrics?.() || { unavailable: true })}`,
    `entropy: ${health?.metrics?.entropyScore?.toFixed?.(3) ?? "n/a"}`,
    `verification: ${JSON.stringify(b.verification.metrics())}`,
    `skills: ${JSON.stringify(b.skills?.metrics?.() || { unavailable: true })}`,
    `typesafe: ${JSON.stringify(b.typesafe?.readiness?.() || { unavailable: true })}`,
    `compounding: ${JSON.stringify(b.compounding?.status?.() || { unavailable: true })}`,
    `branches: ${b.branching.list().length}`,
    `version: ${EXTENSION_VERSION}`,
    `source: ${version.source.sha256.slice(0, 12)} ${version.source.path}`,
  ].join("\n");
}
function parseBranchArgs(args: string = "") {
  const tokens = String(args || "").trim().split(/\s+/).filter(Boolean);
  const flags = new Set(tokens.filter((t) => t.startsWith("--")));
  const values = tokens.filter((t) => !t.startsWith("--"));
  return { tokens, values, flags, apply: flags.has("--apply") || flags.has("--yes"), force: flags.has("--force") };
}
function formatBranch(branch: any, snapshot?: any) {
  if (!branch) return "Branch not found";
  const score = branch.score?.score ?? branch.score?.total ?? branch.score;
  return [
    `${branch.id} ${branch.name ? `(${branch.name})` : ""}`.trim(),
    `type=${branch.type} status=${branch.status} parent=${branch.parentBranchId || "none"}`,
    `head=${branch.headSnapshotId} checkpoints=${branch.checkpoints?.length || 0} score=${typeof score === "number" ? score.toFixed(3) : "n/a"}`,
    snapshot ? `snapshot=${snapshot.id} files=${Object.keys(snapshot.filesystemState?.files || {}).length} at=${snapshot.at}` : "",
  ].filter(Boolean).join("\n");
}
function formatBranches(branches: any[]) {
  if (!branches.length) return "No branches. Create branches via the session branch API or enable PI_COGNITIVE_AUTO_BRANCH=1 for automatic isolation.";
  return branches.map((b) => `${b.id}\t${b.type}\t${b.status}\t${b.name || ""}\thead=${b.headSnapshotId}`).join("\n");
}
function formatComparison(c: any) {
  if (!c || c.disabled) return "Branching is disabled.";
  const lines = [
    `semantic distance: ${typeof c.semanticDistance === "number" ? c.semanticDistance.toFixed(3) : "n/a"}`,
    `left added=${c.leftDelta?.added?.length || 0} changed=${c.leftDelta?.changed?.length || 0} removed=${c.leftDelta?.removed?.length || 0}`,
    `right added=${c.rightDelta?.added?.length || 0} changed=${c.rightDelta?.changed?.length || 0} removed=${c.rightDelta?.removed?.length || 0}`,
  ];
  const left = [...(c.leftDelta?.added || []), ...(c.leftDelta?.changed || []), ...(c.leftDelta?.removed || [])].slice(0, 12);
  const right = [...(c.rightDelta?.added || []), ...(c.rightDelta?.changed || []), ...(c.rightDelta?.removed || [])].slice(0, 12);
  if (left.length) lines.push(`left files: ${left.join(", ")}`);
  if (right.length) lines.push(`right files: ${right.join(", ")}`);
  return lines.join("\n");
}
function formatSubagent(record: any) {
  if (!record) return "Subagent not found";
  const result = record.result || {};
  return [
    `${record.id} status=${record.status} role=${record.role || "worker"} attempt=${record.attempt || 1}`,
    `parent=${record.parentSessionId} branch=${record.branchId} trajectory=${record.trajectoryId}`,
    `taskHash=${record.taskHash || "unavailable"} launchDigest=${record.launchDigest || "unavailable"}`,
    record.previousAttemptId ? `previous=${record.previousAttemptId} root=${record.rootAttemptId}` : "",
    record.workspace?.retained ? `recovery=retained patch=${record.workspace.patchHash || "none"} paths=${record.workspace.changedPathCount || 0}` : "",
    result.summary ? `summary=${short(result.summary, 800)}` : "",
    record.receiptId ? `receipt=${record.receiptId}` : "",
    `accounting=model:${record.diagnostics?.modelCalls || 0} tool:${record.diagnostics?.toolCalls || 0}/${record.diagnostics?.toolResults || 0} duration:${record.diagnostics?.totalDurationMs || 0}ms`,
  ].filter(Boolean).join("\n");
}
function parseSubagentCreateArgs(args: string = "") {
  const text = String(args || "").trim();
  const role = text.match(/--role\s+([^\s]+)/)?.[1] || undefined;
  const mergePolicy = text.match(/--merge\s+([^\s]+)/)?.[1] || "none";
  const noRun = /(^|\s)--no-run(\s|$)/.test(text);
  const task = text.replace(/--role\s+[^\s]+/g, "").replace(/--merge\s+[^\s]+/g, "").replace(/(^|\s)--no-run(\s|$)/g, " ").trim();
  return { role, mergePolicy, task, noRun };
}
function resolveSubagentId(raw: string, parentSessionId: string) {
  const id = String(raw || "").trim();
  if (id && id !== "latest") return id;
  const rows = runtime?.boundary.subagents.listSubagents({ parentSessionId }) || [];
  return rows.at(-1)?.id || id;
}
function getParentSessionId(ctx: any) {
  const explicit = ctx?.session?.id || ctx?.sessionId;
  if (explicit) return String(explicit);
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (sessionId) return String(sessionId);
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (sessionFile) return `session_${sha256(String(sessionFile)).slice(0, 12)}`;
  return "pi-session";
}
function isSubagentBranch(branch: any) {
  return branch?.metadata?.kind === "subagent" || !!branch?.metadata?.subagentId || String(branch?.name || "").startsWith("subagent ");
}
function latestParentBranch(rt: Runtime) {
  return [...rt.boundary.branching.list()].reverse().find((branch: any) => !isSubagentBranch(branch) && branch?.status !== "quarantined") || null;
}
function normalizeSubagentRoleId(value: any) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function resolveSubagentRoleArgs(args: any = {}) {
  if (!runtime) throw new Error("Reasoning runtime is not initialized");
  const requested = String(args.role || "worker").trim() || "worker";
  const normalized = normalizeSubagentRoleId(requested);
  const roles = runtime.boundary.topologies.listRoles();
  const exactRole = roles.find((candidate: any) => candidate.roleId === requested);
  const normalizedMatches = exactRole ? [] : roles.filter((candidate: any) => normalizeSubagentRoleId(candidate.roleId) === normalized || normalizeSubagentRoleId(candidate.displayName) === normalized);
  if (normalizedMatches.length > 1) throw new Error(`Ambiguous subagent role ${JSON.stringify(requested)} matches: ${normalizedMatches.map((candidate: any) => candidate.roleId).join(", ")}`);
  const role = exactRole || normalizedMatches[0];
  const customPrompt = String(args.systemPrompt || "").trim();
  if (role?.workspacePolicy === "handler-only") throw new Error(`Subagent role ${role.roleId} is handler-only and must run inside a topology.`);
  if (!role) {
    if (!customPrompt) throw new Error(`Unknown subagent role ${JSON.stringify(requested)}. Use a registered role (${roles.map((candidate: any) => candidate.roleId).join(", ")}) or provide an explicit systemPrompt for a read-only custom role.`);
    if (!normalized) throw new Error("Custom subagent role must contain letters or numbers");
    const contract = runtime.boundary.topologies.createCustomReadOnlyRole({ roleId: normalized, systemPrompt: customPrompt, budget: args.budget || {} });
    return {
      ...args,
      role: contract.roleId,
      roleContract: contract,
      systemPrompt: contract.systemPrompt,
      toolPolicy: contract.toolPolicy,
      modelPolicy: contract.modelPolicy,
      modelPreference: contract.modelPreference || null,
      workspacePolicy: contract.workspacePolicy,
      mutationPolicy: contract.mutationPolicy,
      memoryPolicy: contract.memoryPolicy,
      budget: contract.budget,
      metadata: { ...(args.metadata || {}), requestedRole: requested, roleResolution: "custom-read-only", contractVersion: contract.contractVersion },
    };
  }
  const contract = customPrompt ? { ...role, systemPrompt: `${role.systemPrompt}\n\nCaller-specific scope (cannot broaden the registered contract):\n${customPrompt}` } : role;
  return {
    ...args,
    role: contract.roleId,
    roleContract: contract,
    systemPrompt: contract.systemPrompt,
    toolPolicy: contract.toolPolicy,
    modelPolicy: contract.modelPolicy,
    modelPreference: contract.modelPreference || null,
    workspacePolicy: contract.workspacePolicy,
    mutationPolicy: contract.mutationPolicy,
    memoryPolicy: contract.memoryPolicy || "none",
    budget: contract.budget,
    metadata: { ...(args.metadata || {}), requestedRole: requested, roleResolution: "registered", contractVersion: contract.contractVersion },
  };
}
function subagentInferenceContext(ctx: any) { const model = ctx?.model?.id ? (ctx.model.provider ? `${ctx.model.provider}/${ctx.model.id}` : String(ctx.model.id)) : null; return { inheritedModel: model, inheritedThinkingLevel: ctx?.thinkingLevel || null }; }
function subagentRequestForContext(ctx: any, args: any) {
  if (!runtime) throw new Error("Reasoning runtime is not initialized");
  const parent = getParentSessionId(ctx); const parentBranch = latestParentBranch(runtime); const leafId = ctx.sessionManager?.getLeafId?.(); const resolved = resolveSubagentRoleArgs(args); const sessionFile = ctx.sessionManager?.getSessionFile?.();
  return { parentSessionId: parent, parentBranchId: parentBranch?.id, parentTrajectoryId: parentBranch?.id, branchFrom: { branchId: parentBranch?.id, snapshotId: parentBranch?.headSnapshotId, entryId: leafId, messageId: leafId }, ...subagentInferenceContext(ctx), ...resolved, metadata: { ...(resolved.metadata || {}), parentSessionFileHash: sessionFile ? sha256(String(sessionFile)) : null } };
}
function preflightSubagentForContext(ctx: any, args: any) { if (!runtime) throw new Error("Reasoning runtime is not initialized"); return runtime.boundary.subagents.preflight(subagentRequestForContext(ctx, args)); }
function createSubagentForContext(ctx: any, args: any) { if (!runtime) throw new Error("Reasoning runtime is not initialized"); return runtime.boundary.subagents.createSubagent(subagentRequestForContext(ctx, args)); }
function appendRoleRunEntry(pi: any, record: any, result: any, source: string, extra: any = {}) {
  if (!record && !result) return;
  const diagnostics = result?.diagnostics || {};
  const finalText = String(result?.final_response || result?.summary || "");
  const status = result?.status || record?.status || extra.status || "unknown";
  const termination = result?.termination || record?.termination || null;
  const modelCalls = Number(diagnostics.modelCalls ?? diagnostics.model_calls ?? 0);
  const toolCalls = Number(diagnostics.toolCalls ?? diagnostics.tool_calls ?? 0);
  const toolResults = Number(diagnostics.toolResults ?? diagnostics.tool_results ?? 0);
  const toolFailures = Number(diagnostics.toolFailures ?? diagnostics.tool_failures ?? 0);
  const typedResultValid = Number(result?.schemaVersion) === ROLE_RESULT_SCHEMA_VERSION && String(result?.contractVersion || "") === ROLE_CONTRACT_VERSION && ["succeeded", "failed", "cancelled", "timed_out"].includes(status) && Boolean(termination?.code);
  const accountingValid = [modelCalls, toolCalls, toolResults, toolFailures].every((value) => Number.isFinite(value) && value >= 0) && toolCalls === toolResults;
  const mutationPolicy = record?.mutationPolicy || record?.roleContract?.mutationPolicy || diagnostics.workspace?.policy;
  const mutationMode = mutationPolicy === "forbidden" || diagnostics.workspace?.policy === "shared-readonly" ? "shared-readonly" : "isolated";
  const fixture = ROLE_RUNTIME_CONFIG.fixtureExecution || /fixture|benchmark|deterministic/i.test(source);
  const base = {
    schemaVersion: ROLE_RUN_SCHEMA_VERSION,
    roleRunSchemaVersion: ROLE_RUN_SCHEMA_VERSION,
    roleRuntimeVersion: ROLE_RUNTIME_VERSION,
    contractVersion: ROLE_CONTRACT_VERSION,
    resultSchemaVersion: ROLE_RESULT_SCHEMA_VERSION,
    runtimeSourceHash: ROLE_RUNTIME_SOURCE_HASH,
    at: new Date().toISOString(),
    source,
    roleId: result?.role || record?.role || extra.roleId || null,
    roleResolution: record?.metadata?.roleResolution || extra.roleResolution || null,
    status,
    terminalCategory: classifyRoleTerminal({ status, termination, typedResultValid }),
    typedResultValid,
    accountingValid,
    mutationMode,
    fixture,
    parentSessionId: result?.parent_session_id || record?.parentSessionId || null,
    subagentId: result?.subagent_id || record?.id || extra.subagentId || null,
    branchId: result?.branch_id || record?.branchId || extra.branchId || null,
    topologyRunId: record?.metadata?.topologyRunId || extra.topologyRunId || null,
    topologyId: record?.metadata?.topologyId || extra.topologyId || null,
    nodeId: record?.metadata?.nodeId || extra.nodeId || null,
    modelPreference: record?.modelPreference || null,
    selectedModel: diagnostics.selectedModel || diagnostics.selected_model || null,
    effectiveModel: diagnostics.effectiveModel || diagnostics.effective_model || null,
    fallbackModel: diagnostics.fallbackModel || diagnostics.fallback_model || null,
    modelPolicySource: diagnostics.modelPolicySource || diagnostics.model_policy_source || null,
    selectedThinkingLevel: diagnostics.selectedThinkingLevel || diagnostics.selected_thinking_level || null,
    effectiveThinkingLevel: diagnostics.effectiveThinkingLevel || diagnostics.effective_thinking_level || null,
    thinkingPolicySource: diagnostics.thinkingPolicySource || diagnostics.thinking_policy_source || null,
    toolPolicy: record?.toolPolicy ? { allowedTools: record.toolPolicy.allowedTools || [], deniedTools: record.toolPolicy.deniedTools || [] } : null,
    workspace: diagnostics.workspace ? { policy: diagnostics.workspace.policy || null, retained: diagnostics.workspace.retained === true, pathHash: diagnostics.workspace.path ? sha256(String(diagnostics.workspace.path)) : null, patchHash: diagnostics.workspace.patchHash || null, patchBytes: Number(diagnostics.workspace.patchBytes || 0), changedPaths: Array.isArray(diagnostics.workspace.changedPaths) ? diagnostics.workspace.changedPaths.map((path: string) => ({ pathHash: sha256(String(path)) })) : [] } : null,
    childSessionFile: diagnostics.piSessionFile || diagnostics.pi_session_file || null,
    childSessionDir: diagnostics.rpcSessionDir || diagnostics.rpc_session_dir || null,
    termination,
    budget: record?.budget || null,
    modelCalls,
    toolCalls,
    toolResults,
    toolFailures,
    queueWaitMs: Number(diagnostics.queueWaitMs ?? diagnostics.queue_wait_ms ?? 0),
    executionDurationMs: Number(diagnostics.executionDurationMs ?? diagnostics.execution_duration_ms ?? 0),
    totalDurationMs: Number(diagnostics.totalDurationMs ?? diagnostics.total_duration_ms ?? diagnostics.duration_ms ?? 0),
    wallClockBudgetMs: Number(diagnostics.wallClockBudgetMs ?? diagnostics.wall_clock_budget_ms ?? record?.budget?.wallClockMs ?? 0),
    taskHash: record?.task ? sha256(String(record.task)) : null,
    resultHash: finalText ? sha256(finalText) : null,
  };
  const eligibility = determineRoleRunEligibility(base);
  pi.appendEntry?.("role-run", sanitizeRoleRunRecord({ ...base, eligibleLive: eligibility.eligible, eligibilityReason: eligibility.reason }));
}
function appendTopologyRoleRuns(pi: any, packet: any, source: string) {
  if (!runtime || !packet) return;
  for (const nodeResult of packet.results || []) {
    const subagentId = nodeResult?.provenance?.subagentId || nodeResult?.payload?.subagent_id;
    const record = subagentId ? runtime.boundary.subagents.getSubagent({ subagentId }) : null;
    const result = nodeResult?.payload?.subagent_id ? nodeResult.payload : { role: nodeResult.role, status: nodeResult.status, summary: nodeResult.summary, diagnostics: nodeResult.diagnostics };
    appendRoleRunEntry(pi, record, result, source, { topologyRunId: packet.runId, topologyId: packet.topologyId, nodeId: nodeResult.nodeId, roleId: nodeResult.role });
  }
}
function appendSubagentParentEntry(pi: any, payload: any) {
  if (!payload?.parentUpdate) return;
  pi.appendEntry?.("subagent.result", { ...payload.parentUpdate, mergePolicy: payload.mergePolicy, resultStatus: payload.result?.status, resultSummary: payload.result?.summary });
}
function updateSubagentWidget(ctx: any, label = "") {
  if (!runtime || !ctx?.ui?.setWidget) return;
  const parentSessionId = getParentSessionId(ctx);
  const status = runtime.boundary.subagents.status({ parentSessionId });
  const last = status.last;
  const lines = [
    `Subagents: active=${status.active} final=${status.final} total=${status.total}${label ? ` · ${label}` : ""}`,
    last ? `Last: ${last.id} ${last.status} ${last.role || "worker"} ${last.diagnostics?.totalDurationMs || 0}ms` : "Last: none",
  ];
  // Keep the legacy widget for reasoning-runtime-only installations. When Chat
  // Focus is loaded, its refresh loop clears this key before drawing the shared
  // below-editor chat strip.
  ctx.ui.setWidget("subagents", lines, { placement: "above" });
  ctx.ui.setStatus?.("subagents", status.active ? `subagents:${status.active} active` : undefined);
}
function startSubagentCommandRun(pi: any, ctx: any, subagentId: string, mergePolicy?: string) {
  if (!runtime) throw new Error("Reasoning runtime is not initialized");
  const rt = runtime;
  const controller = new AbortController();
  rt.subagentRuns = rt.subagentRuns || new Map();
  rt.subagentRuns.set(subagentId, controller);
  const runner = "rpc";
  const context = { cwd: rt.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel, signal: controller.signal, executionMode: "tool-rpc" };
  const promise = Promise.resolve().then(async () => {
    const result = await rt.boundary.subagents.runSubagent({ subagentId, mergePolicy, context });
    const record = rt.boundary.subagents.getSubagent({ subagentId });
    appendRoleRunEntry(pi, record, result, "subagent-command");
    try {
      updateSubagentWidget(ctx, `${result.status} ${subagentId}`);
      if (result.status !== "succeeded") ctx.ui?.notify?.(`Subagent ${subagentId} ${result.status}${result.summary ? `: ${short(result.summary, 500)}` : ""}`, "warning");
    } catch {}
    return result;
  }).catch((error: any) => {
    try { ctx.ui?.notify?.(`Subagent ${subagentId} failed: ${error?.message || String(error)}`, "warning"); } catch {}
    return null;
  }).finally(() => {
    if (rt.subagentRuns?.get(subagentId) === controller) rt.subagentRuns.delete(subagentId);
  });
  return { runner, promise };
}
const ASK_SYSTEM_PROMPT = "You answer side questions about the current Pi session from a read-only transcript snapshot. Do not claim to have changed files or session state. Be concise, cite uncertainty when evidence is insufficient, and do not expose private reasoning.";
function askPrompt(question: string, snapshot: string) {
  return [
    "Current Pi session snapshot follows. It is read-only context and may be truncated.",
    snapshot || "No session messages were available.",
    "Answer this side question about the current Pi session.",
    `Question: ${question}`,
  ].join("\n\n---\n\n");
}
function snapshotSessionForAsk(ctx: any, maxChars = Number(process.env.PI_ASK_SNAPSHOT_MAX_CHARS || 24000)) {
  const branch = ctx.sessionManager?.getBranch?.() || [];
  const lines: string[] = [];
  for (const entry of branch.slice(-80)) {
    if (entry?.type !== "message" || !entry.message) continue;
    const role = entry.message.role || "message";
    if (role === "toolResult") continue;
    const text = textOf(entry.message.content).replace(/\s+/g, " ").trim();
    if (text) lines.push(`${role}: ${short(text, 1600)}`);
  }
  const out = lines.join("\n");
  return out.length > maxChars ? `...[truncated]\n${out.slice(-maxChars)}` : out;
}
function clearPersistedAskRuns(rt: Runtime | undefined) {
  if (!rt?.cwd) return;
  try {
    const dir = join(rt.cwd, ".pi", "ask");
    for (const file of readdirSync(dir)) if (file.endsWith(".json")) rmSync(join(dir, file), { force: true });
  } catch {}
}
function clearAskRuns(ctx?: any) {
  if (!runtime) return;
  runtime.askRuns = [];
  runtime.askPanelOpen = false;
  clearPersistedAskRuns(runtime);
  ctx?.ui?.setWidget?.("ask", undefined);
  ctx?.ui?.setStatus?.("ask", undefined);
}
function installAskEscapeHandler(ctx: any, rt: Runtime) {
  if (ctx?.mode !== "tui" || typeof ctx?.ui?.onTerminalInput !== "function") return;
  rt.askInputCleanup?.();
  rt.askInputCleanup = ctx.ui.onTerminalInput((data: string) => {
    if (runtime !== rt || rt.askPanelOpen || !(rt.askRuns || []).length || !matchesKey(data, Key.escape)) return;
    clearAskRuns(ctx);
    return { consume: true };
  });
}
function askActiveCount(rt: Runtime | undefined) { return (rt?.askRuns || []).filter((r) => r.status === "running").length; }
function askLastState(rt: Runtime | undefined) {
  const last = rt?.askRuns?.at(-1);
  return last ? `${last.status} ${last.id}` : "idle";
}
function askPanelHeight(tui: any) {
  const rawRows = Number(tui?.terminal?.rows || process.stdout?.rows || process.env.LINES || 24);
  const rows = Number.isFinite(rawRows) && rawRows > 0 ? rawRows : 24;
  const rawReservedRows = Number(process.env.PI_ASK_WIDGET_RESERVED_ROWS || 8);
  const reservedRows = Number.isFinite(rawReservedRows) ? Math.max(0, rawReservedRows) : 8;
  const rawFraction = Number(process.env.PI_ASK_WIDGET_HEIGHT_FRACTION || 0.5);
  const fraction = Number.isFinite(rawFraction) ? Math.max(0.1, Math.min(0.9, rawFraction)) : 0.5;
  const chatRows = Math.max(6, rows - reservedRows);
  return Math.max(4, Math.floor(chatRows * fraction));
}
function padToWidth(text: string, width: number) {
  const clipped = truncateToWidth(String(text || ""), Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
function askBorder(theme: any, width: number, title = "", bottom = false) {
  const safeWidth = Math.max(4, width);
  const inner = safeWidth - 2;
  const label = title ? truncateToWidth(` ${title} `, inner, "") : "";
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(label)));
  return theme.fg("accent", `${bottom ? "╰" : "╭"}${label}${fill}${bottom ? "╯" : "╮"}`);
}
function askRow(theme: any, width: number, text = "") {
  const inner = Math.max(0, Math.max(4, width) - 2);
  return `${theme.fg("accent", "│")}${padToWidth(text, inner)}${theme.fg("accent", "│")}`;
}
function askPanelContentLines(rt: Runtime | undefined) {
  const runs = rt?.askRuns || [];
  const lines: string[] = [];
  if (!runs.length) lines.push("No ask runs yet. Press n or use /ask <question>.");
  for (const r of runs.slice().reverse()) {
    lines.push(`${r.id} ${r.status} ${r.createdAt}`);
    lines.push(`Q: ${r.question}`);
    lines.push(r.answer ? `A: ${r.answer}` : r.error ? `Error: ${r.error}` : "A: running...");
    lines.push("---");
  }
  return lines.flatMap((l) => String(l).split("\n"));
}
function wrappedAskPanelContent(rt: Runtime | undefined, width: number) {
  const contentWidth = Math.max(1, width);
  return askPanelContentLines(rt).flatMap((line) => wrapTextWithAnsi(String(line), contentWidth));
}
function renderAskWindow(rt: Runtime | undefined, tui: any, theme: any, width: number, options: { label?: string; scroll?: number; followTail?: boolean; focused?: boolean } = {}) {
  const safeWidth = Math.max(4, width);
  const height = askPanelHeight(tui);
  const bodyHeight = Math.max(1, height - 2);
  const content = wrappedAskPanelContent(rt, Math.max(1, safeWidth - 4));
  const maxScroll = Math.max(0, content.length - bodyHeight);
  const scroll = options.followTail ? maxScroll : Math.max(0, Math.min(options.scroll || 0, maxScroll));
  const visible = content.slice(scroll, scroll + bodyHeight);
  while (visible.length < bodyHeight) visible.push("");
  const label = options.label ? ` · ${options.label}` : "";
  const title = `Ask sidecar${label} · active=${askActiveCount(rt)} total=${rt?.askRuns?.length || 0} · last=${askLastState(rt)}`;
  const footer = options.focused ? `scroll=${scroll}/${maxScroll} · ↑/↓ PgUp/PgDn · f fork · n new · c clear/close · q/Esc close` : "F8 or /ask-panel to focus · /ask <question> to submit · /ask-status for text view";
  return [askBorder(theme, safeWidth, title), ...visible.map((line) => askRow(theme, safeWidth, ` ${line}`)), askBorder(theme, safeWidth, footer, true)];
}
function updateAskWidget(ctx: any, label = "") {
  if (!runtime || !ctx?.ui?.setWidget) return;
  const rt = runtime;
  const active = askActiveCount(rt);
  if (rt.askPanelOpen) { ctx.ui.setWidget("ask", undefined); ctx.ui.setStatus?.("ask", active ? `ask:${active}` : undefined); return; }
  if (!(rt.askRuns || []).length && !label) { ctx.ui.setWidget("ask", undefined); ctx.ui.setStatus?.("ask", undefined); return; }
  ctx.ui.setWidget("ask", (tui: any, theme: any) => ({
    invalidate() {},
    render(width: number) { return renderAskWindow(rt, tui, theme, width, { label, followTail: true }); },
  }), { placement: "aboveEditor" });
  ctx.ui.setStatus?.("ask", active ? `ask:${active}` : undefined);
}
function formatAskRuns(rt: Runtime | undefined) {
  const runs = rt?.askRuns || [];
  if (!runs.length) return "No ask runs yet.";
  return runs.slice(-10).reverse().map((r) => [`${r.id} ${r.status} ${r.createdAt}`, `Q: ${r.question}`, r.answer ? `A: ${r.answer}` : r.error ? `Error: ${r.error}` : "A: running..."] .join("\n")).join("\n\n---\n\n");
}
async function forkAskRun(ctx: any, runId?: string) {
  const run = (runtime?.askRuns || []).find((r) => r.id === runId) || runtime?.askRuns?.at(-1);
  if (!run) return ctx.ui.notify("No ask run to fork", "warning");
  if (typeof ctx.newSession !== "function") return ctx.ui.notify("Ask fork requires command context; run /ask-fork latest from the Pi TUI command line.", "warning");
  await ctx.newSession({ parentSession: ctx.sessionManager?.getSessionFile?.(), setup: async (sm: any) => { sm.appendMessage?.({ role: "user", content: [{ type: "text", text: `Forked from ask sidecar\n\nQuestion: ${run.question}` }], timestamp: Date.now() }); if (run.answer || run.error) sm.appendMessage?.({ role: "assistant", content: [{ type: "text", text: run.answer || `Ask failed: ${run.error}` }], timestamp: Date.now() }); }, withSession: async (childCtx: any) => childCtx.ui?.notify?.(`Forked ask ${run.id} into a new session`, "info") });
}
async function openAskPanel(ctx: ExtensionContext, pi?: ExtensionAPI): Promise<void> {
  if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning");
  runtime.askPanelOpen = true;
  // Hide the passive in-layout widget while the focusable panel overlay is open;
  // otherwise both render at slightly different rows and the top appears duplicated.
  ctx.ui.setWidget?.("ask", undefined);
  return ctx.ui.custom<{ action: "close" | "fork" | "new" | "clear"; runId?: string }>((tui, theme, _kb, done) => {
    let scroll = 0;
    const page = () => Math.max(4, askPanelHeight(tui) - 2);
    const component = {
      invalidate() {},
      render(width: number) {
        const bodyHeight = Math.max(1, askPanelHeight(tui) - 2);
        const all = wrappedAskPanelContent(runtime, Math.max(1, Math.max(4, width) - 4));
        scroll = Math.max(0, Math.min(scroll, Math.max(0, all.length - bodyHeight)));
        return renderAskWindow(runtime, tui, theme, width, { scroll, focused: true });
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || data === "q") return done({ action: "close" });
        if (data === "j" || matchesKey(data, Key.down)) scroll += 1;
        else if (data === "k" || matchesKey(data, Key.up)) scroll -= 1;
        else if (matchesKey(data, Key.pageDown)) scroll += page();
        else if (matchesKey(data, Key.pageUp)) scroll -= page();
        else if (data === "f") return done({ action: "fork", runId: runtime?.askRuns?.at(-1)?.id });
        else if (data === "n") return done({ action: "new" });
        else if (data === "c") return done({ action: "clear" });
        scroll = Math.max(0, scroll);
        tui.requestRender();
      },
    };
    return component;
  }, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "100%", maxHeight: "50%", margin: { top: 0, right: 0, bottom: 4, left: 0 } } }).then(async (result) => {
    const restoreAskWidget = () => { if (runtime) runtime.askPanelOpen = false; updateAskWidget(ctx); };
    if (!result || result.action === "close") { restoreAskWidget(); return; }
    if (result.action === "clear") { clearAskRuns(ctx); return; }
    if (result.action === "new") { const q = await ctx.ui.input("Ask side question", "Question about this session..."); if (String(q || "").trim()) startAskRun(ctx, String(q).trim()); return openAskPanel(ctx, pi); }
    if (result.action === "fork") {
      restoreAskWidget();
      if ("newSession" in ctx && typeof ctx.newSession === "function") return forkAskRun(ctx, result.runId);
      const command = `/ask-fork ${result.runId || "latest"}`;
      return ctx.ui.notify(`Ask fork requires command context; run ${command} from the Pi TUI command line.`, "warning");
    }
  }).catch((error: any) => { if (runtime) runtime.askPanelOpen = false; updateAskWidget(ctx); throw error; });
}
function startAskRun(ctx: ExtensionContext, question: string) {
  if (!runtime) throw new Error("Reasoning runtime is not initialized");
  const rt = runtime;
  const now = new Date().toISOString();
  const run: AskRun = { id: `ask_${Date.now().toString(36)}_${++askSeq}`, question, status: "running", createdAt: now, updatedAt: now };
  rt.askRuns = [...(rt.askRuns || []), run].slice(-50);
  const snapshot = snapshotSessionForAsk(ctx);
  updateAskWidget(ctx, `running ${run.id}`);
  Promise.resolve().then(async () => {
    try {
      if (!ctx.model) throw new Error("No model selected");
      const response = await ctx.modelRegistry.complete(ctx.model, { systemPrompt: ASK_SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: askPrompt(question, snapshot) }], timestamp: Date.now() }] });
      if (response.stopReason === "error") throw new Error(response.errorMessage || "Ask model request failed");
      const answer = (response.content || []).map((c: any) => c?.text || c?.content || "").filter(Boolean).join("\n").trim() || "No answer was captured.";
      run.status = response.stopReason === "aborted" ? "failed" : "succeeded";
      run.answer = answer;
    } catch (error: any) {
      run.status = "failed";
      run.error = error?.message || String(error);
    } finally {
      run.updatedAt = new Date().toISOString();
      if ((rt.askRuns || []).some((r) => r.id === run.id)) {
        try { updateAskWidget(ctx, `${run.status} ${run.id}`); } catch {}
      }
    }
  });
  return run;
}
function formatTopology(topology: any) {
  if (!topology) return "Topology not found";
  const join = (node: any) => typeof node.joinPolicy === "string" ? node.joinPolicy : node.joinPolicy?.mode || "all";
  return [
    `${topology.topologyId} ${topology.name ? `(${topology.name})` : ""}`.trim(),
    topology.description || "",
    `schema=${topology.schemaVersion || "unknown"} mode=${topology.executionMode} concurrency=${topology.concurrencyLimit || 1} nodes=${topology.nodes?.length || 0} edges=${topology.edges?.length || 0} failure=${topology.failurePolicy} partial=${topology.partialPolicy || "forbid"} aggregation=${topology.aggregationPolicy}`,
    topology.terminalNodes?.length ? `terminal=${topology.terminalNodes.join(",")}` : "",
    ...(topology.nodes || []).map((n: any) => `- ${n.id}: role=${n.roleId || n.role || "worker"} context=${n.contextPolicy || topology.contextPolicy || "dependency-neighborhood"} workspace=${n.workspacePolicy || "role-default"} memory=${n.memoryPolicy || topology.memoryPolicy || "role-default"} join=${join(n)}${n.joinPolicy?.minimumSuccessfulInputs != null ? ` min=${n.joinPolicy.minimumSuccessfulInputs}` : ""}`),
    ...(topology.edges || []).map((edge: any) => `  ${edge.source} -> ${edge.target} [${edge.condition || "always"}]`),
  ].filter(Boolean).join("\n");
}
function resolveTopologyId(raw: string) {
  const id = String(raw || "").trim();
  if (!id || id === "latest") return runtime?.boundary.topologies.listTopologies().at(-1)?.topologyId || "";
  return id;
}
function planFanoutForContext(cwd: string, params: any = {}) {
  const rawFile = String(params.planFile || "").replace(/^@/, "").trim();
  let planText = String(params.planText || "");
  let planFile: string | null = null;
  if (rawFile) {
    const root = realpathSync(cwd);
    let absolute: string;
    try { absolute = realpathSync(resolve(root, rawFile)); }
    catch { throw new Error(`create_subagent fanout planFile must name an existing repository file: ${rawFile}`); }
    const rel = relative(root, absolute);
    if (rel.startsWith("..") || resolve(root, rel) !== absolute) throw new Error(`create_subagent fanout planFile must stay inside cwd: ${rawFile}`);
    planText = readFileSync(absolute, "utf8");
    planFile = rel.replace(/\\/g, "/");
  }
  if (!planText.trim()) throw new Error("create_subagent fanout requires planFile or planText with Markdown checklist/numbered items");
  return buildFanout(cwd, planText, { planFile, maxWorkers: params.maxWorkers, concurrency: params.concurrency });
}
function topologyUnsafeReason(text: string, cwd = process.cwd()) {
  if (process.env.PI_TOPOLOGY_ALLOW_UNSAFE === "1") return undefined;
  const checks: [RegExp, string][] = [
    [/\brm\s+-[^\n]*r[f]?\b|\brm\s+-[^\n]*f[^\n]*r\b|\brm\s+-rf\b/i, "recursive/force removal"],
    [/\bsudo\b/i, "sudo command"],
    [/\b(?:curl|wget)\b[^\n]*(?:\||>)/i, "network download piped or redirected"],
    [/\b(?:npm|pnpm|yarn)\s+(?:install|add)\b/i, "package installation"],
    [/\b(?:chmod|chown)\s+-R\b/i, "recursive permission/ownership change"],
  ];
  for (const [pattern, reason] of checks) if (pattern.test(text)) return `Blocked unsafe topology tool command: ${reason}`;
  const abs = text.match(/(?:write|edit|modify|create|delete)[^\n]*(\/[^	\n\s'"`]+)/i)?.[1];
  if (abs && cwd && !resolve(abs).startsWith(resolve(cwd))) return `Blocked write-like action outside repo: ${abs}`;
  return undefined;
}
function topologyShell(cwd: string, command: string, args: string[] = []) {
  const reason = topologyUnsafeReason([command, ...args].join(" "), cwd);
  if (reason) return Promise.resolve({ ok: false, command, args, blocked: true, stderr: reason, code: "TOPOLOGY_UNSAFE_COMMAND" });
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: Number(process.env.PI_TOPOLOGY_TOOL_TIMEOUT_MS || 30000), maxBuffer: 512 * 1024 }, (error, stdout, stderr) => resolve({ ok: !error, command, args, stdout: short(String(stdout || ""), 4000), stderr: short(String(stderr || error?.message || ""), 4000), code: (error as any)?.code || 0 }));
  });
}
function makeTopologyTools(cwd: string, boundary: any) {
  return {
    read: async (p = "README.md") => safeRead(cwd, String(p)) || "",
    grep: async (pattern = "", file = ".") => topologyShell(cwd, "grep", ["-R", "-n", String(pattern), String(file)]),
    rg: async (pattern = "", file = ".") => topologyShell(cwd, "rg", [String(pattern), String(file)]),
    find: async (dir = ".") => topologyShell(cwd, "find", [String(dir), "-maxdepth", "3", "-type", "f"]),
    diff: async () => topologyShell(cwd, "git", ["diff", "--stat"]),
    bash: async (cmd = "true") => topologyShell(cwd, "bash", ["-lc", String(cmd)]),
    test: async (cmd = "scripts/check-all.sh") => topologyShell(cwd, "bash", ["-lc", String(cmd)]),
    lint: async (cmd = "true") => topologyShell(cwd, "bash", ["-lc", String(cmd)]),
    typecheck: async (cmd = "true") => topologyShell(cwd, "bash", ["-lc", String(cmd)]),
    "memory.read": async (query = "project") => boundary.memory.retrieve(String(query), { limit: 8 }),
    "memory.write": async (entry: any = {}) => boundary.memory.remember({ type: "semantic", title: entry.title || "Topology memory", content: entry.content || JSON.stringify(entry), verification: entry.verification || "inferred", provenance: { source: "topology-tool", ...(entry.provenance || {}) } }),
  };
}
function parseTopologyRunArgs(args: string = "") {
  const text = String(args || "").trim();
  const jsonMatch = text.match(/--json\s+(.+)$/s);
  const noRun = /(^|\s)--no-run(\s|$)/.test(text);
  const clean = text.replace(/--json\s+.+$/s, "").replace(/(^|\s)--no-run(\s|$)/g, " ").trim();
  const [topologyId, ...taskParts] = clean.split(/\s+/).filter(Boolean);
  let input: any = { task: taskParts.join(" ").trim() || runtime?.prompt || "" };
  if (jsonMatch?.[1]) input = JSON.parse(jsonMatch[1]);
  return { topologyId, input, noRun };
}
function loadTopologyConfigs(rt: Runtime) {
  const { loadTopologyConfigDir } = require(join(LIB_ROOT, "src", "multi-agent-topologies.js"));
  const loaded = [];
  for (const dir of TOPOLOGY_CONFIG_DIRS) loaded.push(...loadTopologyConfigDir(join(rt.cwd, dir), { roleRegistry: rt.boundary.topologies.roles, topologyRegistry: rt.boundary.topologies.topologies }));
  return loaded;
}
function formatTopologyRun(result: any) {
  if (!result) return "No topology result";
  const symbols: Record<string, string> = { succeeded: "✓", partial: "◐", running: "◐", failed: "✗", cancelled: "✗", "timed-out": "✗", timed_out: "✗", skipped: "↷", blocked: "○", pending: "○" };
  const resultsByNode = new Map((result.results || []).map((node: any) => [node.nodeId, node]));
  const states = result.nodeStates?.length ? result.nodeStates : (result.results || []).map((node: any) => ({ nodeId: node.nodeId, roleId: node.role || node.roleId, status: node.status }));
  const terminationForNode = (nodeId: string) => (resultsByNode.get(nodeId) as any)?.termination || (result.errors || []).find((error: any) => error.nodeId === nodeId)?.termination || null;
  return [
    `run=${result.runId} topology=${result.topologyId} status=${result.status}`,
    `durationMs=${result.durationMs} nodes=${states.length} errors=${result.errors?.length || 0}`,
    result.execution ? `mode=${result.execution.mode} concurrency=${result.execution.concurrencyLimit} failure=${result.execution.failurePolicy} partial=${result.execution.partialPolicy} aggregation=${result.execution.aggregationPolicy}` : "",
    ...states.slice(0, 20).map((node: any) => { const termination = terminationForNode(node.nodeId); return `${symbols[node.status] || "•"} ${node.nodeId || "node"} role=${node.roleId || "worker"} status=${node.status || "unknown"} durationMs=${Number(node.durationMs || 0)} evidence=${Number(node.evidenceCount || 0)}${node.requiredInputs != null ? ` inputs=${Number(node.successfulInputs || 0)}/${Number(node.requiredInputs || 0)}` : ""}${termination?.code ? ` termination=${short(String(termination.code), 80)}` : ""}${node.reason ? ` reason=${short(String(node.reason), 160)}` : ""}`; }),
    ...(result.joinDecisions || []).filter((join: any) => join.degraded || join.satisfied === false).slice(0, 8).map((join: any) => `join ${join.nodeId}: ${join.mode} success=${join.successfulInputs}/${join.minimumSuccessfulInputs} satisfied=${join.satisfied} degraded=${join.degraded}`),
    result.fallbackOf ? `fallbackOf=${result.fallbackOf}` : "",
    result.aggregation ? `aggregation=present keys=${Object.keys(result.aggregation || {}).slice(0, 12).join(",")}` : "",
    ...(result.errors || []).slice(0, 5).map((e: any) => `error ${e.nodeId || ""}: code=${e.code || "unknown"}${e.termination?.code ? ` termination=${short(String(e.termination.code), 80)}` : ""} detail=${short(String(e.termination?.message || e.message || e.reason || "failed"), 240)}`),
  ].filter(Boolean).join("\n");
}
function parseTopologyPruneArgs(args: string = "") {
  const keep = Number(String(args).match(/--keep=(\d+)/)?.[1] || 50);
  const olderDays = Number(String(args).match(/--older-than=(\d+)d/)?.[1] || 0);
  const topologyId = String(args).match(/--topology=([^\s]+)/)?.[1] || undefined;
  return { keepRecent: Number.isFinite(keep) ? keep : 50, olderThanMs: olderDays ? olderDays * 24 * 60 * 60 * 1000 : 0, topologyId };
}
function parseTopologyExportArgs(args: string = "") {
  const parts = String(args || "").trim().split(/\s+/).filter(Boolean);
  return { runId: parts[0] || "latest", file: parts[1] };
}
function latestTopologyRunId(rt: Runtime, topologyId?: string) { return rt.boundary.topologies.listRuns({ topologyId, limit: 1 }).at(-1)?.runId; }
function maybeAutoPruneTopologies(rt: Runtime) {
  if (!TOPOLOGY_AUTO_PRUNE) return;
  const now = Date.now();
  if (rt.topologyPrunedAt && now - rt.topologyPrunedAt < 60 * 60 * 1000) return;
  rt.topologyPrunedAt = now;
  setTimeout(() => {
    try { rt.boundary.topologies.pruneRuns({ keepRecent: TOPOLOGY_PRUNE_KEEP, olderThanMs: TOPOLOGY_PRUNE_OLDER_THAN_DAYS * 24 * 60 * 60 * 1000 }); }
    catch (error: any) { try { rt.boundary.trace.emit({ category: "failure_state", name: "topology.auto_prune_failed", severity: "warn", payload: { error: error?.message || String(error) } }); } catch {} }
  }, 0).unref?.();
}
function topologyDoctor(rt: Runtime) {
  const runs = rt.boundary.topologies.listRuns({ limit: 20 });
  return [
    "Topology diagnostics",
    `configDirs=${TOPOLOGY_CONFIG_DIRS.join(",")}`,
    `roles=${rt.boundary.topologies.listRoles().length}`,
    `topologies=${rt.boundary.topologies.listTopologies().length}`,
    `recentRuns=${runs.length}`,
    `traceEvents=${rt.boundary.topologies.trace({}).length}`,
    `storageRoot=${rt.boundary.storage.root || "memory"}`,
    `autoPrune=${TOPOLOGY_AUTO_PRUNE ? "enabled" : "disabled"} keep=${TOPOLOGY_PRUNE_KEEP} olderThanDays=${TOPOLOGY_PRUNE_OLDER_THAN_DAYS}`,
    `autoRoute=${rt.autoRouteMode || TOPOLOGY_AUTO_ROUTE_DEFAULT_MODE} subagentBacked=${TOPOLOGY_AUTO_ROUTE_SUBAGENTS} defaultTopology=${TOPOLOGY_AUTO_ROUTE_DEFAULT_TOPOLOGY}`,
    `roleRuntimeVersion=${ROLE_RUNTIME_CONFIG.selectedVersion} compatibility=${ROLE_RUNTIME_CONFIG.compatibilityMode} contractVersion=${ROLE_CONTRACT_VERSION} resultSchemaVersion=${ROLE_RESULT_SCHEMA_VERSION}`,
    `containment=${ROLE_RUNTIME_V2_AVAILABLE ? `v2-available; mutation=${ROLE_MUTATION_MODE}; rollout=${ROLE_RUNTIME_CONFIG.effectiveStage}; automatic mutation blocked; explicit isolated delegation only` : "runtime-v1 compatibility; mutating-auto-routes-blocked; read-only shadow only"}`,
    `executionTruth=terminal-validated roleRuns=parent-session rpcConcurrency=${process.env.PI_SUBAGENT_RPC_CONCURRENCY || 2}`,
    `toolSafety=${process.env.PI_TOPOLOGY_ALLOW_UNSAFE === "1" ? "unsafe allowed" : "blocking rm/sudo/download-pipes/package-installs/recursive chmod"}`,
    `metrics=${JSON.stringify(rt.boundary.topologies.metrics({}))}`,
  ].join("\n");
}
function topologyTemplate(kind: string, id: string) {
  const templateId = kind || "planner-coder-verifier";
  const base = getBuiltInRoleTopology(templateId);
  if (!base) throw new Error(`Unknown built-in role topology template: ${templateId}`);
  base.topologyId = id || `custom-${templateId}`;
  base.name = base.topologyId;
  base.metadata = { ...(base.metadata || {}), provenance: { source: "generated-template", templateId, version: 3 } };
  return base;
}

type AutoRouteMode = "off" | "suggest" | "shadow" | "delegate";
function parseAutoRouteMode(raw: any): AutoRouteMode { return normalizeRouterMode(raw).mode as AutoRouteMode; }
function autoRouteModeFromSession(ctx: any): AutoRouteMode | undefined {
  try {
    const entries = ctx?.sessionManager?.getEntries?.() || [];
    for (const entry of entries.slice().reverse()) {
      if (entry?.type === "custom" && entry.customType === "auto-router.state") {
        const mode = parseAutoRouteMode(entry.data?.mode);
        if (mode) return mode;
      }
    }
  } catch {}
  return undefined;
}
function persistAutoRouteMode(pi: any, mode: AutoRouteMode, reason = "command") {
  try { pi.appendEntry?.("auto-router.state", { mode, reason, at: new Date().toISOString() }); } catch {}
}
function autoRouteCandidate(decision: any) { return decision?.recommendedRoleId || decision?.topologyId || decision?.baseTopologyId || "unknown"; }
function autoRouteCommand(decision: any) {
  if (decision.recommendedRoleId) return `/subagent-create --role ${decision.recommendedRoleId} ${decision.task || "<task>"}`;
  return `/topology-run ${decision.topologyId} ${decision.task || "<task>"}`;
}
function classifyAutoRoute(prompt: string, rt: Runtime, options: any = {}) {
  const task = String(prompt || "").trim();
  const mode = (options.mode || rt.autoRouteMode || TOPOLOGY_AUTO_ROUTE_DEFAULT_MODE) as AutoRouteMode;
  const minChars = Math.max(0, Number(options.minChars ?? TOPOLOGY_AUTO_ROUTE_MIN_CHARS));
  if (!options.force && task.length > 0 && task.length < minChars) {
    const skipped = decideRoleRoute(task, { mode, availableTopologies: rt.boundary.topologies.listTopologies().map((topology: any) => topology.topologyId) });
    return { ...skipped, matched: false, task, skippedReason: `prompt-shorter-than-${minChars}` };
  }
  if (!options.force && isMetaRecommendationPrompt(task)) {
    const skipped = decideRoleRoute(task, { mode, availableTopologies: BUILTIN_ROLE_TOPOLOGY_IDS });
    return { ...skipped, matched: false, task, reasonCode: "meta-recommendation", skippedReason: "meta-recommendation" };
  }
  const decision = decideRoleRoute(task, {
    mode,
    force: options.force,
    explicitInvocation: options.explicitInvocation === true,
    safeWorkerRecommendations: ROLE_RUNTIME_CONFIG.effectiveStage === "R0",
    topologyId: options.topologyId,
    defaultTopologyId: mode === "shadow" ? undefined : TOPOLOGY_AUTO_ROUTE_DEFAULT_TOPOLOGY,
    availableTopologies: rt.boundary.topologies.listTopologies().map((topology: any) => topology.topologyId),
  });
  const roleRecommendation = decision.recommendedRoleId ? rt.boundary.topologies.recommendRole(decision.recommendedRoleId) : null;
  const enriched = roleRecommendation ? { ...decision, roleRecommendation, recommendedModel: roleRecommendation.model, recommendedThinkingLevel: roleRecommendation.thinkingLevel, workspacePolicy: roleRecommendation.workspacePolicy, mutationPolicy: roleRecommendation.mutationPolicy } : decision;
  const matched = enriched.classified === true && enriched.intent !== "no-route" && enriched.intent !== "answer" && Boolean(enriched.topologyId || enriched.roleRecommendation);
  const next = { ...enriched, matched, task, subagentBacked: TOPOLOGY_AUTO_ROUTE_SUBAGENTS, baseTopologyId: enriched.topologyId, reason: enriched.reasonCode, skippedReason: matched ? undefined : enriched.reasonCode };
  return matched ? { ...next, command: autoRouteCommand(next), followUpCommand: next.recommendedRoleId ? "/subagent-run latest" : undefined } : next;
}
function workerShadowCanaryAuthorization(decision: any, ctx: any) {
  return authorizeWorkerShadowCanary(decision, {
    enabled: WORKER_SHADOW_CANARY_ENABLED,
    childSession: Boolean(process.env.PI_SUBAGENT_PARENT_ID),
    hasUI: ctx?.hasUI !== false,
    effectiveStage: ROLE_RUNTIME_CONFIG.effectiveStage,
    fieldPilotEnabled: ROLE_RUNTIME_CONFIG.fieldPilotEnabled,
    runtimeV2Available: ROLE_RUNTIME_V2_AVAILABLE,
    mutationMode: ROLE_MUTATION_MODE,
    sidecarEnabled: ROLE_RUNTIME_CONFIG.sidecarEnabled,
  });
}
function appendWorkerShadowCanaryTelemetry(pi: any, decision: any, stage: string, details: any = {}) {
  if (decision?.workerShadowCanary !== true) return;
  try { pi.appendEntry?.("auto-router.worker-shadow", { schemaVersion: 1, at: new Date().toISOString(), stage, roleId: decision.recommendedRoleId, model: decision.recommendedModel, thinkingLevel: decision.recommendedThinkingLevel, workspacePolicy: decision.workspacePolicy, mutationPolicy: decision.mutationPolicy, promptHash: decision.promptHash, runId: details.runId || null, topologyRunId: details.topologyRunId || null, outcome: details.outcome || "unknown", separateFromParent: true }); } catch {}
}
function autoRouteTopologyForDecision(rt: Runtime, decision: any) {
  const base = decision?.workerShadowCanary === true ? decision.workerShadowTopology : rt.boundary.topologies.listTopologies().find((t: any) => t.topologyId === decision.topologyId);
  if (!base) throw new Error(`auto-router topology not found: ${decision.topologyId}`);
  const topology = JSON.parse(JSON.stringify(base));
  topology.topologyId = `auto-${base.topologyId}`;
  topology.name = `Auto Route: ${base.name || base.topologyId}`;
  topology.description = `${base.description || ""} Routed by /auto-roles from ${base.topologyId}.`.trim();
  topology.metadata = { ...(topology.metadata || {}), autoRouter: { baseTopologyId: base.topologyId, subagentBacked: TOPOLOGY_AUTO_ROUTE_SUBAGENTS } };
  if (TOPOLOGY_AUTO_ROUTE_SUBAGENTS) {
    const handlerOnlyRoles = new Set(["coordinator", "memory-curator", "tool-specialist"]);
    topology.nodes = (topology.nodes || []).map((node: any) => {
      const roleId = node.roleId || node.role || "worker";
      return handlerOnlyRoles.has(roleId) ? node : { ...node, executionMode: "subagent" };
    });
  }
  return topology;
}
function autoRouteSafety(rt: Runtime, decision: any) {
  const topology = decision?.workerShadowCanary === true ? decision.workerShadowTopology : rt.boundary.topologies.listTopologies().find((candidate: any) => candidate.topologyId === decision?.topologyId);
  const workerShadowCanaryAllowed = WORKER_SHADOW_CANARY_ENABLED && ROLE_RUNTIME_V2_AVAILABLE && ROLE_RUNTIME_CONFIG.fieldPilotEnabled === true && ROLE_MUTATION_MODE === "off" && ROLE_RUNTIME_CONFIG.sidecarEnabled === true && decision?.workerShadowCanary === true && decision?.workerShadowCanaryReasonCode === "worker-shadow-canary-authorized" && decision?.mode === "suggest" && decision?.execute === true && decision?.automaticExecutionAllowed === true && decision?.mutationAuthority === false && workerShadowCanaryScopeSafe(decision?.task) && decision?.recommendedRoleId === "worker" && decision?.recommendedModel === WORKER_SHADOW_CANARY_MODEL && decision?.recommendedThinkingLevel === WORKER_SHADOW_CANARY_THINKING_LEVEL && decision?.workspacePolicy === "shared-readonly" && decision?.mutationPolicy === "forbidden" && topology?.metadata?.workerShadowCanary === true && topology?.nodes?.length === 1 && (topology.nodes[0]?.roleId || topology.nodes[0]?.role) === "worker" && topology.nodes[0]?.executionMode === "subagent";
  if (ROLE_RUNTIME_CONFIG.effectiveStage === "R0" && !ROLE_RUNTIME_CONFIG.fixtureExecution && !workerShadowCanaryAllowed) return { ok: false, code: "ROLE_ROLLOUT_STAGE_BLOCKED", reason: "role runtime R0 permits fixtures and the guarded read-only worker shadow canary only", mutatingNodes: [] };
  if (decision?.mode === "delegate" && ROLE_RUNTIME_CONFIG.effectiveStage !== "R5") return { ok: false, code: "ROLE_ROLLOUT_STAGE_BLOCKED", reason: `optional router delegation requires R5; effective stage is ${ROLE_RUNTIME_CONFIG.effectiveStage}`, mutatingNodes: [] };
  const safety = inspectAutoRouteSafety({ topology, roles: rt.boundary.topologies.listRoles(), runtimeV2Available: ROLE_RUNTIME_V2_AVAILABLE, allowIsolatedDelegation: ROLE_MUTATION_MODE === "isolated" && ROLE_RUNTIME_CONFIG.sidecarEnabled && decision?.mode === "delegate" && decision?.automaticExecutionAllowed === true });
  return topology ? safety : { ...safety, reason: `topology not found: ${decision?.topologyId || "unknown"}` };
}
function autoRouteActiveCount(rt: Runtime | undefined) { return rt?.autoRouteRuns?.size || 0; }
function updateAutoRouteWidget(ctx: any, label = "") {
  if (!runtime || !ctx?.ui?.setStatus) return;
  const mode = runtime.autoRouteMode || TOPOLOGY_AUTO_ROUTE_DEFAULT_MODE;
  const active = autoRouteActiveCount(runtime);
  if (mode === "off" && !active && !label) return;
  ctx.ui.setStatus?.("auto-roles", `auto-roles:${mode}${active ? `/${active}` : ""}`);
  if (ctx.ui.setWidget && (active || label)) {
    const last = runtime.autoRouteLast;
    const lines = [
      `Auto roles: mode=${mode} active=${active}${label ? ` · ${label}` : ""}`,
      last?.matched ? `Last recommendation: ${autoRouteCandidate(last)} · ${short(last.reason || "", 120)}` : last?.skippedReason ? `Last skipped: ${last.skippedReason}` : "Last recommendation: none",
    ];
    ctx.ui.setWidget("auto-roles", lines, { placement: "above" });
  }
}
function formatAutoRouteStatus(rt: Runtime | undefined) {
  if (!rt) return "Reasoning runtime is not initialized";
  const last = rt.autoRouteLast;
  return [
    "Auto role router",
    `mode=${rt.autoRouteMode || TOPOLOGY_AUTO_ROUTE_DEFAULT_MODE} envDefault=${TOPOLOGY_AUTO_ROUTE_DEFAULT_MODE}`,
    `subagentBacked=${TOPOLOGY_AUTO_ROUTE_SUBAGENTS} minChars=${TOPOLOGY_AUTO_ROUTE_MIN_CHARS} cooldownMs=${TOPOLOGY_AUTO_ROUTE_COOLDOWN_MS}`,
    `workerShadowCanary=${WORKER_SHADOW_CANARY_ENABLED ? "enabled" : "disabled"} profile=${WORKER_SHADOW_CANARY_MODEL}/${WORKER_SHADOW_CANARY_THINKING_LEVEL} separateResult=true`,
    `defaultTopology=${TOPOLOGY_AUTO_ROUTE_DEFAULT_TOPOLOGY}`,
    `roleRuntimeVersion=${ROLE_RUNTIME_CONFIG.selectedVersion} compatibility=${ROLE_RUNTIME_CONFIG.compatibilityMode} contractVersion=${ROLE_CONTRACT_VERSION} resultSchemaVersion=${ROLE_RESULT_SCHEMA_VERSION}`,
    `classifierVersion=${ROUTER_CLASSIFIER_VERSION}`,
    `fieldEvidence=${ROLE_RUNTIME_CONFIG.fieldEvidenceStatus} eligibleLiveReadOnly=${ROLE_RUNTIME_CONFIG.fieldEligibleRuns} pilot=${ROLE_RUNTIME_CONFIG.fieldPilotEnabled}`,
    `containment=${ROLE_RUNTIME_V2_AVAILABLE ? `v2-available; mutation=${ROLE_MUTATION_MODE}; rollout=${ROLE_RUNTIME_CONFIG.effectiveStage}; shadow is read-only; delegate follows through automatically in isolated worktrees` : "runtime-v1 compatibility; mutating delegation blocked; shadow remains read-only"}`,
    `activeRuns=${autoRouteActiveCount(rt)}`,
    last ? `last=${last.matched ? `${autoRouteCandidate(last)} (${last.reason})` : `skipped (${last.skippedReason})`}` : "last=none",
    "commands: /auto-roles off|suggest|shadow|delegate|status|route <task>|once <task>|cancel",
    "Containment: legacy run maps to read-only shadow. Delegate mode may run isolated mutation contracts automatically; parent patch application, publish, and destructive intents stay explicit or blocked.",
  ].join("\n");
}
function autoRouteStableKey(decision: any) {
  return [decision?.mode || "off", decision?.matched ? "matched" : "unmatched", decision?.intent || "none", autoRouteCandidate(decision), decision?.recommendedModel || "none", decision?.recommendedThinkingLevel || "none", decision?.reasonCode || decision?.reason || "none", Number(decision?.confidence || 0).toFixed(2), decision?.status || decision?.outcome || "pending"].join(":");
}
function formatAutoRouteAdvisory(rt: Runtime | undefined, prompt: string) {
  if (!rt) return "";
  const mode = rt.autoRouteMode || TOPOLOGY_AUTO_ROUTE_DEFAULT_MODE;
  if (mode !== "suggest" && mode !== "delegate") return "";
  const decision = classifyAutoRoute(prompt, rt);
  rt.autoRouteLast = decision;
  if (!decision.matched) return "";
  const key = autoRouteStableKey(decision);
  if (rt.autoRouteInjectedGuidanceKey === key) return "";
  rt.autoRouteInjectedGuidanceKey = key;
  if (mode === "delegate") {
    const delegated = rt.autoRouteTurnResult;
    return [
      "[L2:auto-router] Role topology delegation",
      `Delegation target: ${decision.topologyId}`,
      `Reason: ${decision.reason}; confidence=${Number(decision.confidence || 0).toFixed(2)}`,
      delegated ? `Automatic follow-through completed with status=${delegated.status}; the typed result is injected below.` : "Automatic follow-through did not produce a typed result; do not claim delegated roles ran successfully.",
      "Use the typed delegated result as evidence without re-running the same topology. Mutating roles work only in isolated worktrees; parent patch application remains an explicit reviewed action.",
    ].join("\n");
  }
  if (decision.roleRecommendation) {
    const canary = workerShadowCanaryAuthorization(decision, { hasUI: true });
    return [
      "[L2:auto-router] Safe worker recommendation",
      `Recommended role: ${decision.recommendedRoleId}`,
      `Inference profile: ${decision.recommendedModel} / ${decision.recommendedThinkingLevel}`,
      `Safety: workspace=${decision.workspacePolicy}; mutation=${decision.mutationPolicy}`,
      `Reason: ${decision.reason}; confidence=${Number(decision.confidence || 0).toFixed(2)}`,
      canary.authorized ? "Automatic canary: enabled; an eligible interactive prompt starts one read-only worker shadow." : `Manual commands: ${decision.command} then ${decision.followUpCommand}`,
      canary.authorized ? "Separation: the parent answer continues independently; the worker result is shown separately and is never applied to project files." : `R0 recommendation-only: no subagent/topology started; execute=${decision.execute}; no role or file mutation occurred.`,
    ].join("\n");
  }
  return [
    "[L2:auto-router] Role topology suggestion",
    `Suggested topology: ${decision.topologyId}`,
    `Reason: ${decision.reason}; confidence=${Number(decision.confidence || 0).toFixed(2)}`,
    `Manual command: ${decision.command}`,
    "This is advisory only. Do not claim planner/coder/verifier roles ran unless a topology/subagent run actually executed.",
  ].join("\n");
}
function recordAutoRouteTelemetry(rt: Runtime | undefined, stage: "suggested" | "shown" | "accepted" | "dismissed" | "overridden" | "corrected" | "executed" | "rejected" | "completed", decision: any, outcome: string = "unknown", outcomeLinkId: string = "none") {
  try { rt?.telemetry?.autoRouter(stage, autoRouteCandidate(decision), outcome, outcomeLinkId); } catch {}
}
function autoRouteTerminalOutcome(result: any) {
  const value = String(result?.status || "").trim().toLowerCase().replace(/_/g, "-");
  if (value === "succeeded") return "succeeded";
  if (["cancelled", "timed-out", "blocked", "not-applicable", "infrastructure-failed"].includes(value)) return value;
  if (!["failed", "partial"].includes(value)) return "unknown";
  const terminationCodes = [...(result?.errors || []), ...(result?.results || [])].map((entry: any) => String(entry?.termination?.code || "").trim().toLowerCase().replace(/_/g, "-"));
  if (terminationCodes.some((code: string) => code === "cancelled" || code === "aborted")) return "cancelled";
  if (terminationCodes.some((code: string) => code === "wall-clock" || code.includes("timeout") || code.startsWith("budget-"))) return "timed-out";
  if (terminationCodes.some((code: string) => code === "provider-error" || code === "rpc-protocol" || code === "infrastructure-failed")) return "infrastructure-failed";
  return "domain-negative";
}
function confidenceBand(value: any) { const score = Number(value); return score >= 0.8 ? "high" : score >= 0.65 ? "medium" : score > 0 ? "low" : "unknown"; }
function runtimeSessionToken(rt: Runtime | undefined, ctx: any) { try { return rt?.telemetry?.sessionToken(getParentSessionId(ctx)) || "none"; } catch { return "none"; } }
function recordRecommendation(rt: Runtime | undefined, source: "router" | "skill", action: "shown" | "accepted" | "dismissed" | "overridden" | "corrected", candidate: string, confidence: any, ctx?: any) {
  try { rt?.telemetry?.recommendation(source, action, candidate || "unknown", confidenceBand(confidence), action === "accepted" ? "succeeded" : "unknown", contextSessionKind(ctx), runtimeSessionToken(rt, ctx)); } catch {}
}
function boundedAutoRouteValue(value: any, maxChars = 800) {
  if (value == null) return value;
  try {
    const rendered = JSON.stringify(value);
    return rendered.length <= maxChars ? value : { truncated: true, preview: short(rendered, maxChars) };
  } catch {
    return { truncated: true, preview: "unserializable delegated value" };
  }
}
function boundedAutoRouteItems(value: any, maxItems = 4, maxItemChars = 800) {
  return Array.isArray(value) ? value.slice(0, maxItems).map((item) => boundedAutoRouteValue(item, maxItemChars)) : [];
}
function compactAutoRouteTurnResult(decision: any, result: any) {
  const sourceResults = Array.isArray(result?.results) ? result.results : [];
  const publicResult = (entry: any) => {
    const payload = entry?.payload && typeof entry.payload === "object" ? entry.payload : {};
    const submitted = payload.submitted_result && typeof payload.submitted_result === "object" ? payload.submitted_result : payload;
    return {
      nodeId: entry?.nodeId,
      role: entry?.role,
      status: entry?.status,
      summary: short(String(entry?.summary || submitted.summary || ""), 800) || null,
      findings: boundedAutoRouteItems(submitted.findings),
      evidence: boundedAutoRouteItems(submitted.evidence),
      artifacts: boundedAutoRouteItems(submitted.artifacts),
      proposedPatch: boundedAutoRouteValue(submitted.proposedPatch ?? null, 1600),
      verification: boundedAutoRouteValue(submitted.verification || { status: "unchecked", evidence: [] }, 1000),
      ...(submitted.roadmapPlan ? { roadmapPlan: boundedAutoRouteValue(submitted.roadmapPlan, 2000) } : {}),
      ...(submitted.coverage ? { coverage: boundedAutoRouteValue(submitted.coverage, 800) } : {}),
      ...(Array.isArray(submitted.unresolvedGaps) ? { unresolvedGaps: boundedAutoRouteItems(submitted.unresolvedGaps) } : {}),
      provenance: boundedAutoRouteValue(entry?.provenance || null, 800),
    };
  };
  const roleResults = sourceResults.slice(0, 12).map(publicResult);
  const isolatedSubagents = sourceResults.filter((entry: any) => entry?.provenance?.workspacePolicy === "isolated-worktree").slice(0, 12).map((entry: any) => ({ nodeId: short(String(entry.nodeId || ""), 120), role: short(String(entry.role || ""), 80), subagentId: short(String(entry.provenance?.subagentId || ""), 160), branchId: short(String(entry.provenance?.branchId || ""), 160) }));
  const roadmapHandoffs = boundedAutoRouteItems(runtime?.boundary?.topologies?.roadmapHandoffs?.(result), 4, 1000);
  const packet: any = {
    schemaVersion: 1,
    kind: "delegated_role_result",
    routeId: short(String(decision?.routeId || ""), 160) || null,
    runId: short(String(result?.runId || ""), 160) || null,
    topologyId: short(String(result?.topologyId || decision?.topologyId || ""), 160) || null,
    status: result?.status || "failed",
    roleResults,
    omittedRoleResults: Math.max(0, sourceResults.length - roleResults.length),
    errors: boundedAutoRouteItems(result?.errors, 8, 600),
    incompleteMutation: Boolean(result?.incompleteMutation),
    roadmapHandoffs,
    mutationBoundary: { isolatedSubagents, parentPatchApplied: false, patchApplication: "explicit" },
  };
  if (JSON.stringify(packet).length <= AUTO_ROUTE_PARENT_RESULT_MAX_CHARS) return packet;
  packet.truncated = true;
  packet.roleResults = roleResults.map((entry: any) => ({
    nodeId: entry.nodeId,
    role: entry.role,
    status: entry.status,
    summary: short(String(entry.summary || ""), 320) || null,
    findings: boundedAutoRouteItems(entry.findings, 2, 400),
    evidence: boundedAutoRouteItems(entry.evidence, 2, 400),
    proposedPatch: boundedAutoRouteValue(entry.proposedPatch, 800),
    verification: boundedAutoRouteValue(entry.verification, 500),
    provenance: boundedAutoRouteValue(entry.provenance, 500),
  }));
  if (JSON.stringify(packet).length <= AUTO_ROUTE_PARENT_RESULT_MAX_CHARS) return packet;
  const leanResults = packet.roleResults.slice(0, 6);
  packet.omittedRoleResults += packet.roleResults.length - leanResults.length;
  packet.roleResults = leanResults.map((entry: any) => ({
    nodeId: short(String(entry.nodeId || ""), 120),
    role: short(String(entry.role || ""), 80),
    status: entry.status,
    summary: short(String(entry.summary || ""), 240) || null,
    verification: { status: typeof entry.verification?.status === "string" ? short(entry.verification.status, 40) : "unknown" },
    provenance: entry.provenance && entry.provenance.truncated !== true ? { subagentId: short(String(entry.provenance.subagentId || ""), 160), branchId: short(String(entry.provenance.branchId || ""), 160), workspacePolicy: short(String(entry.provenance.workspacePolicy || ""), 80) } : null,
  }));
  packet.mutationBoundary.isolatedSubagents = packet.mutationBoundary.isolatedSubagents.slice(0, 6);
  packet.errors = boundedAutoRouteItems(packet.errors, 4, 300);
  if (JSON.stringify(packet).length <= AUTO_ROUTE_PARENT_RESULT_MAX_CHARS) return packet;
  packet.omittedRoleResults += Math.max(0, packet.roleResults.length - 3);
  packet.roleResults = packet.roleResults.slice(0, 3);
  packet.mutationBoundary.isolatedSubagents = packet.mutationBoundary.isolatedSubagents.slice(0, 3);
  packet.errors = boundedAutoRouteItems(packet.errors, 2, 200);
  return packet;
}

function renderDelegatedRoleResult(result: any) {
  if (!result) return "";
  const pendingRoadmaps = Array.isArray(result.roadmapHandoffs) ? result.roadmapHandoffs.filter((entry: any) => entry?.requiresParentFollowThrough === true && entry?.roadmapId) : [];
  const roadmapGuidance = pendingRoadmaps.length ? [
    `The delegated roadmap binding(s) ${pendingRoadmaps.map((entry: any) => short(String(entry.roadmapId), 160)).join(", ")} require parent follow-through.`,
    "Do not start a duplicate roadmap for this request.",
    "If you continue the task in the parent workspace, use roadmap_update action=show with focusId set to the bound roadmap, resume it if shelved, and update its existing items as work and evidence settle.",
    "Reconcile those item statuses before the final response; do not mark work done solely because a child proposed it.",
  ].join(" ") : "";
  return `<delegated_role_result>\n${JSON.stringify(result)}\n</delegated_role_result>\nTreat this as the completed delegated result for the current request. Do not repeat the same role topology. Isolated patches are not present in the parent workspace until explicitly applied.${roadmapGuidance ? `\n${roadmapGuidance}` : ""}`;
}

function appendAutoRouteDecision(pi: any, decision: any, outcomeLink: string | null = null) {
  try { pi.appendEntry?.("auto-router.decision", { at: new Date().toISOString(), ...compactRouterDecision(decision, { outcomeLink }) }); } catch {}
}
function appendAutoRouteResult(pi: any, decision: any, result: any) {
  try {
    const rendered = formatTopologyRun(result);
    const workerShadowCanary = decision?.workerShadowCanary === true;
    pi.appendEntry?.("auto-router.result", { at: new Date().toISOString(), roleRuntimeVersion: ROLE_RUNTIME_VERSION, contractVersion: ROLE_CONTRACT_VERSION, resultSchemaVersion: ROLE_RESULT_SCHEMA_VERSION, classifierVersion: ROUTER_CLASSIFIER_VERSION, mode: decision.mode, intent: decision.intent, topologyId: result?.topologyId, baseTopologyId: decision.baseTopologyId, runId: result?.runId, status: result?.status, incompleteMutation: Boolean(decision.incompleteMutation || result?.incompleteMutation), summary: workerShadowCanary ? null : short(rendered, 1600), resultHash: workerShadowCanary ? sha256(rendered) : null, separateFromParent: workerShadowCanary });
  } catch {}
}
function startAutoRouteRun(pi: any, ctx: any, decision: any, options: any = {}) {
  if (!runtime) throw new Error("Reasoning runtime is not initialized");
  const rt = runtime;
  if (!decision?.matched || decision?.execute !== true) return null;
  const safety = autoRouteSafety(rt, decision);
  if (!safety.ok) {
    recordAutoRouteTelemetry(rt, "rejected", decision, "blocked");
    appendWorkerShadowCanaryTelemetry(pi, decision, "blocked", { outcome: safety.code || "blocked" });
    rt.autoRouteLast = { ...decision, matched: false, blocked: true, skippedReason: safety.reason, code: safety.code, mutatingNodes: safety.mutatingNodes };
    try {
      appendAutoRouteDecision(pi, rt.autoRouteLast);
      pi.appendEntry?.("auto-router.result", { at: new Date().toISOString(), roleRuntimeVersion: ROLE_RUNTIME_VERSION, contractVersion: ROLE_CONTRACT_VERSION, resultSchemaVersion: ROLE_RESULT_SCHEMA_VERSION, classifierVersion: ROUTER_CLASSIFIER_VERSION, mode: decision.mode, intent: decision.intent, topologyId: decision.topologyId, status: "blocked", code: safety.code, reason: safety.reason, mutatingNodes: safety.mutatingNodes });
      ctx.ui?.notify?.(decision.workerShadowCanary ? `Worker shadow canary blocked (${safety.code}): ${safety.reason}.` : `Auto roles blocked (${safety.code}): ${safety.reason}. Use explicit /topology-run ${decision.topologyId} after reviewing the topology.`, "warning");
      updateAutoRouteWidget(ctx, decision.workerShadowCanary ? "worker canary blocked" : "mutating route blocked");
    } catch {}
    return null;
  }
  const now = Date.now();
  if (!options.force && rt.autoRouteLastStartedAt && now - rt.autoRouteLastStartedAt < TOPOLOGY_AUTO_ROUTE_COOLDOWN_MS) {
    recordAutoRouteTelemetry(rt, "rejected", decision, "not-applicable");
    appendWorkerShadowCanaryTelemetry(pi, decision, "skipped", { outcome: "cooldown-active" });
    try { ctx.ui?.notify?.(decision.workerShadowCanary ? "Worker shadow canary skipped: cooldown active." : `Auto roles skipped: cooldown active. ${decision.command}`, "warning"); } catch {}
    return null;
  }
  if (decision.topologyId === GOVERNED_SKILL_INTAKE_TOPOLOGY_ID || decision.baseTopologyId === GOVERNED_SKILL_INTAKE_TOPOLOGY_ID) {
    recordAutoRouteTelemetry(rt, "rejected", decision, "blocked");
    try { ctx.ui?.notify?.("Governed skill intake is explicit current-user command-only and cannot be auto-routed.", "warning"); } catch {}
    return null;
  }
  const routeId = `autoroute_${now.toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const controller = new AbortController();
  rt.autoRouteRuns = rt.autoRouteRuns || new Map();
  rt.autoRouteRuns.set(routeId, controller);
  rt.autoRouteLastStartedAt = now;
  rt.autoRouteLast = decision;
  if (options.force) { recordAutoRouteTelemetry(rt, "accepted", decision, "succeeded", routeId); recordRecommendation(rt, "router", "accepted", autoRouteCandidate(decision), decision.confidence, ctx); }
  recordAutoRouteTelemetry(rt, "executed", decision, "unknown", routeId);
  appendWorkerShadowCanaryTelemetry(pi, decision, "started", { runId: routeId });
  appendAutoRouteDecision(pi, decision, routeId);
  updateAutoRouteWidget(ctx, `running ${routeId}`);
  const promise = Promise.resolve().then(async () => {
    const topology = autoRouteTopologyForDecision(rt, decision);
    const input = { task: decision.task, autoRouter: { routeId, mode: decision.mode, reason: decision.reason, baseTopologyId: decision.baseTopologyId } };
    const result = await rt.boundary.topologies.execute(topology, input, { parentSessionId: getParentSessionId(ctx), signal: controller.signal, piContext: { cwd: rt.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel, signal: controller.signal, executionMode: "tool-rpc" } });
    maybeCaptureTopologySkill(rt, result);
    appendTopologyRoleRuns(pi, result, "auto-router");
    appendAutoRouteResult(pi, decision, result);
    recordAutoRouteTelemetry(rt, "completed", decision, autoRouteTerminalOutcome(result), result?.runId || routeId);
    appendWorkerShadowCanaryTelemetry(pi, decision, "completed", { runId: routeId, topologyRunId: result?.runId, outcome: result?.status || "unknown" });
    try {
      updateAutoRouteWidget(ctx, `${result.status} ${routeId}`);
      ctx.ui?.notify?.(decision.workerShadowCanary ? `Worker shadow result (separate from parent answer) — ${result.status}: ${formatTopologyRun(result)}` : `Auto roles ${result.status}: ${formatTopologyRun(result)}`, result.status === "succeeded" ? "info" : "warning");
    } catch {}
    return result;
  }).catch((error: any) => {
    recordAutoRouteTelemetry(rt, "completed", decision, "infrastructure-failed", routeId);
    appendWorkerShadowCanaryTelemetry(pi, decision, "failed", { runId: routeId, outcome: "infrastructure-failed" });
    try {
      rt.boundary.trace.emit({ category: "failure_state", name: "auto_router.failed", severity: "error", payload: { routeId, topologyId: decision.topologyId, error: error?.message || String(error) } });
      ctx.ui?.notify?.(`Auto roles failed: ${error?.message || String(error)}`, "warning");
      pi.appendEntry?.("auto-router.result", { at: new Date().toISOString(), routeId, topologyId: decision.topologyId, status: "failed", error: error?.message || String(error) });
    } catch {}
    return null;
  }).finally(() => {
    if (rt.autoRouteRuns?.get(routeId) === controller) rt.autoRouteRuns.delete(routeId);
    try { updateAutoRouteWidget(ctx); } catch {}
  });
  return { routeId, promise };
}
async function maybeHandleAutoRouteInput(pi: any, event: any, ctx: any) {
  if (!runtime || event?.source === "extension" || event?.source === "automation-loop") return null;
  runtime.autoRouteTurnResult = undefined;
  const mode = runtime.autoRouteMode || TOPOLOGY_AUTO_ROUTE_DEFAULT_MODE;
  if (mode === "off") return null;
  const previousDecision = runtime.autoRouteLast;
  const decision = classifyAutoRoute(event.text || "", runtime);
  runtime.autoRouteLast = decision;
  if (!decision.matched) {
    if (decision.reasonCode === "explicit-opt-out" && previousDecision?.matched) recordRecommendation(runtime, "router", "dismissed", autoRouteCandidate(previousDecision), previousDecision.confidence, ctx);
    recordAutoRouteTelemetry(runtime, "rejected", decision, "not-applicable"); appendAutoRouteDecision(pi, decision); updateAutoRouteWidget(ctx); return null;
  }
  if (mode === "suggest") {
    const canary = workerShadowCanaryAuthorization(decision, ctx);
    const key = autoRouteStableKey(decision);
    const changed = runtime.autoRouteGuidanceKey !== key;
    runtime.autoRouteGuidanceKey = key;
    if (changed) {
      recordAutoRouteTelemetry(runtime, "suggested", decision, "unknown");
      recordRecommendation(runtime, "router", "shown", autoRouteCandidate(decision), decision.confidence, ctx);
      try { ctx.ui?.notify?.(canary.authorized ? "Auto roles: starting one read-only worker shadow; the parent turn continues." : `Auto roles suggestion: ${decision.command}`, "info"); } catch {}
    }
    appendAutoRouteDecision(pi, decision);
    if (canary.authorized) {
      const canaryDecision = { ...canary.decision, workerShadowTopology: buildWorkerShadowCanaryTopology() };
      const started = startAutoRouteRun(pi, ctx, canaryDecision);
      if (started) try { ctx.ui?.notify?.(`Worker shadow canary started (${started.routeId}); its result will be shown separately.`, "info"); } catch {}
      return null;
    }
    updateAutoRouteWidget(ctx, changed ? `suggest ${autoRouteCandidate(decision)}` : "stable suggestion");
    return null;
  }
  if (mode === "delegate") {
    const started = startAutoRouteRun(pi, ctx, decision);
    if (!started) { appendAutoRouteDecision(pi, runtime.autoRouteLast || decision); return null; }
    updateAutoRouteWidget(ctx, `delegating ${autoRouteCandidate(decision)}`);
    try { ctx.ui?.notify?.(`Auto roles: delegating ${decision.topologyId} in isolated role workspaces before the parent turn.`, "info"); } catch {}
    const result = await started.promise;
    runtime.autoRouteTurnResult = compactAutoRouteTurnResult({ ...decision, routeId: started.routeId }, result);
    return null;
  }
  if (ctx?.hasUI === false) {
    const skipped = { ...decision, matched: false, execute: false, reasonCode: "shadow-headless-disabled", skippedReason: "shadow mode disabled in print/json mode" };
    runtime.autoRouteLast = skipped;
    recordAutoRouteTelemetry(runtime, "rejected", skipped, "not-applicable");
    appendAutoRouteDecision(pi, skipped);
    return null;
  }
  const started = startAutoRouteRun(pi, ctx, decision);
  if (!started) { appendAutoRouteDecision(pi, runtime.autoRouteLast || decision); return null; }
  // UX safety: shadow routing is read-only background evaluation. It must never
  // consume the user's prompt or make the editor appear unable to send.
  try { ctx.ui?.notify?.(`Auto roles started read-only shadow ${decision.topologyId}; normal assistant turn continues. Inspect with /topology-show-run latest or /auto-roles status.`, "info"); } catch {}
  return null;
}
function cancelAutoRouteRuns(rt: Runtime | undefined) {
  let count = 0;
  for (const controller of rt?.autoRouteRuns?.values?.() || []) { try { controller.abort(); count++; } catch {} }
  rt?.autoRouteRuns?.clear?.();
  return count;
}

function parseSubagentPruneArgs(args: string = "") {
  const keep = Number(String(args).match(/--keep=(\d+)/)?.[1] || 20);
  const olderDays = Number(String(args).match(/--older-than=(\d+)d/)?.[1] || 0);
  const statuses = String(args).match(/--status=([^\s]+)/)?.[1]?.split(",").filter(Boolean);
  return { keepRecent: Number.isFinite(keep) ? keep : 20, olderThanMs: olderDays ? olderDays * 24 * 60 * 60 * 1000 : 0, statuses };
}
function formatMergeResult(result: any, applied: boolean) {
  if (!result || result.disabled) return "Branching is disabled.";
  const lines = [`merge ${result.ok ? "ok" : "conflict"}${applied ? " (applied)" : " (dry-run)"}`, `snapshot=${result.snapshot?.id || "n/a"}`, `conflicts=${result.conflicts?.length || 0}`];
  if (result.branch) lines.push(`branch=${result.branch.id}`);
  for (const c of (result.conflicts || []).slice(0, 12)) lines.push(`conflict: ${c.file || c.path || "unknown"} ${c.reason || c.type || ""}`.trim());
  if (!applied && result.ok) lines.push("Re-run with --apply to create the merged branch and restore merged files.");
  return lines.join("\n");
}
function clearPrivateAssistantMemory(boundary: any) {
  return boundary.memory.removeWhere((entry: any) => entry.title === "Assistant turn" && /(thinkingSignature|encrypted_content|\"type\"\s*:\s*\"thinking\"|\"type\"\s*:\s*\"reasoning\")/i.test(String(entry.content || "")), "remove stored private/encrypted assistant reasoning payload").removed || [];
}
function ensureReasoningArchitectureMemory(boundary: any) {
  const content = "Model-side reasoning via src/reasoning-runtime.js is canonical. Obsolete internal role-orchestration error records should not be used as context.";
  const existing = boundary.memory.retrieve("Reasoning runtime architecture", { limit: 200 }).entries.filter((e: any) => e.type === "semantic" && e.title === "Reasoning runtime architecture");
  const normalized = normalizeText(content);
  const keep = existing.find((e: any) => normalizeText(e.content) === normalized) || existing[0];
  boundary.memory.removeWhere((entry: any) => entry.type === "semantic" && entry.title === "Reasoning runtime architecture" && (!keep || entry.id !== keep.id), "dedupe reasoning architecture memory");
  if (!keep) boundary.memory.remember({ type: "semantic", title: "Reasoning runtime architecture", content, tags: ["architecture", "reasoning-runtime"], verification: "verified", confidence: 0.95, provenance: { source: "reasoning-cleanup" } });
}
function staleCleanupSignature() { return { version: EXTENSION_VERSION, sourceHash: sourceFingerprint().sha256, stalePattern: STALE_REASONING_RE.source } as any; }
function shouldRunStaleCleanup(boundary: any, cwd: string) {
  if (process.env.PI_COGNITIVE_FORCE_STALE_CLEANUP === "1") return true;
  if (staleCleanupDone.has(cwd)) return false;
  const marker = boundary.storage?.readJson?.(STALE_CLEANUP_MARKER_KEY, null);
  const sig = staleCleanupSignature();
  return !(marker?.version === sig.version && marker?.sourceHash === sig.sourceHash && marker?.stalePattern === sig.stalePattern);
}
function markStaleCleanupDone(boundary: any, result: any) {
  try { boundary.storage?.writeJson?.(STALE_CLEANUP_MARKER_KEY, { ...staleCleanupSignature(), cleanedAt: new Date().toISOString(), result }); } catch {}
}
function clearStaleReasoningState(boundary: any) {
  const stale = STALE_REASONING_RE;
  const blocks = boundary.context.pack({ tokenBudget: 50_000, query: "runtime.arch Role architecture Current cognitive route", includeScratch: true }).blocks || [];
  const contextRemoved: string[] = [];
  for (const item of blocks) {
    const block = item.block || item;
    const text = `${block.title || ""}\n${block.content || ""}`;
    if (stale.test(text)) {
      const removed = boundary.context.remove(block.id, "superseded by verified replacement");
      if (removed?.removed !== false) contextRemoved.push(block.id);
    }
  }
  const memoryRemoved = boundary.memory.removeWhere((entry: any) => stale.test(`${entry.title || ""}\n${entry.content || ""}`), "superseded by reasoning runtime architecture").removed || [];
  boundary.context.upsert({ layer: "L1", title: "Reasoning runtime architecture", content: "Model-side reasoning is canonical: models produce plan/decomposition/hypothesis/decision/evidence artifacts; the harness stores scaffold artifacts, verifier feedback, checkpoints, branch comparisons, failure analyses, and memory updates without exposing private reasoning.", tags: ["architecture", "reasoning-runtime"], protected: true, verification: "verified" });
  boundary.context.upsert({ layer: "L1", title: "Project architecture", content: "pi-harness has governed Obsidian project memory, typed off-path Hermes advice, trace observability, and a reasoning runtime scaffold. Libraries under src/ provide memory, layered context, semantic editing, verification, entropy monitoring, session branching, trace observability, and model-side reasoning artifact support.", tags: ["architecture", "constitution"], protected: true, verification: "verified" });
  ensureReasoningArchitectureMemory(boundary);
  clearPrivateAssistantMemory(boundary);
  boundary.context.persist();
  boundary.memory.persist();
  return { contextRemoved, memoryRemoved };
}
// TypeSafe turn judgment: one request per idle user submission, started at
// input so it is in flight before before_agent_start, where the scaffold and
// the obsidian extension read it. Steering
// and follow-up messages are not judged. Records are written once the turn
// settles and contain only labels and numbers.
function startTypesafeTurn(rt: Runtime, event: any, ctx: any) {
  const typesafe = rt.boundary.typesafe;
  if (!typesafe?.active() || event.streamingBehavior) return;
  finishTypesafeTurn(rt);
  const text = String(event.text || "");
  const promise = typesafe.startTurn({ text, source: event.source });
  if (!promise) return;
  rt.typesafeTurn = {
    promise,
    local: { modality: classifyTaskModality(text).modality, researchMemory: classifyObsidianIntent(text).eligible },
    sessionKind: contextSessionKind(ctx),
  };
}
function finishTypesafeTurn(rt: Runtime) {
  const turn = rt.typesafeTurn;
  rt.typesafeTurn = undefined;
  if (!turn) return;
  turn.promise.then((judgment: any) => {
    try { rt.boundary.typesafe.recordTurn({ sessionKind: turn.sessionKind, judgment, local: turn.local }); }
    catch (error: any) { rt.boundary.trace.emit({ category: "failure_state", name: "typesafe.record_failed", severity: "warn", error: error?.message || String(error) }); }
  });
}
function purgeLocalRequireCache() {
  require(join(LIB_ROOT, "src", "integration-boundary.js")).clearSpecialistRuntimeCache();
  for (const mod of ["role-router.js", "role-topologies.js", "role-contracts.js", "role-result-schemas.js", "skill-intake.js", "skill-synthesis.js", "skill-packs.js", "multi-agent-topologies.js", "subagents.js", "integration-boundary.js", "execution-outcome.js", "learning-loop.js", "memory-maintenance.js", "provenance-graph.js", "compounding-effectiveness.js", "file-integration-storage.js", "integration-config.js", "reasoning-injection.js", "project-intelligence.js", "project-memory-runtime.js", "project-memory-candidates.js", "memory-effectiveness-source.js", "typesafe-client.js", "typesafe-turn-judgment.js", "typesafe-evaluation.js"]) {
    try { delete require.cache[require.resolve(join(LIB_ROOT, "src", mod))]; } catch {}
  }
}
function makeBoundary(cwd: string) {
  const start = Date.now();
  const sourceHash = sourceFingerprint().sha256;
  const cached = boundaryCache.get(cwd);
  if (cached && cached.__sourceHash === sourceHash) { cached.__lastMakeBoundaryTiming = { name: "makeBoundary.cache-hit", durationMs: elapsedMs(start) }; return cached; }
  purgeLocalRequireCache();
  const { createPiIntegrationBoundary, RecordingSink, configureProjectMemoryServices } = require(join(LIB_ROOT, "src", "integration-boundary.js"));
  const { FileIntegrationStorage } = require(join(LIB_ROOT, "src", "file-integration-storage.js"));
  const { SubagentStore } = require(join(LIB_ROOT, "src", "subagents.js"));
  const { adapterConfig } = require(join(LIB_ROOT, "src", "integration-config.js"));
  ({ renderInjectedReasoningContext, richScaffold, dedupeInjectedContext, selectInjectionMemory } = require(join(LIB_ROOT, "src", "reasoning-injection.js")));
  const storage = new FileIntegrationStorage(COGNITIVE_STORAGE_ROOT || join(cwd, ".pi", "cognitive-automation"));
  const sink = new RecordingSink();
  const config = adapterConfig({
    verification: { enabled: AUTO_VERIFY, verifiers: AUTO_VERIFY ? projectVerificationVerifiers(cwd) : [], options: { requiredKinds: [] } },
    reasoning: { enabled: process.env.PI_REASONING_RUNTIME_ENABLED !== "0" },
    orchestration: { enabled: process.env.PI_COGNITIVE_ORCHESTRATION_ENABLED === "1" },
    branching: { enabled: BRANCHING_ENABLED },
    subagents: { enabled: true, config: { enforceRoleRollout: true, maxConcurrentPerParent: SUBAGENT_MAX_CONCURRENT, defaultWallClockMs: SUBAGENT_DEFAULT_WALL_CLOCK_MS, defaultStepBudget: SUBAGENT_DEFAULT_STEP_BUDGET, defaultToolCallBudget: SUBAGENT_DEFAULT_TOOL_CALL_BUDGET, defaultQueueWaitMs: SUBAGENT_DEFAULT_QUEUE_WAIT_MS, defaultLengthContinuations: SUBAGENT_MAX_LENGTH_CONTINUATIONS } },
    topologies: { enabled: process.env.PI_MULTI_AGENT_TOPOLOGIES_ENABLED === "1", configDirs: TOPOLOGY_CONFIG_DIRS.map((d) => join(cwd, d)) },
    skills: { enabled: process.env.PI_SKILL_SYNTHESIS_ENABLED !== "0", options: { cwd } },
    skillIntake: { enabled: SKILL_INTAKE_ENABLED, cwd },
  });
  const boundary = createPiIntegrationBoundary({
    ...config,
    storage,
    sink,
    verification: { ...config.verification, options: { requiredKinds: [] } },
    branching: { ...config.branching, cwd },
    subagents: { ...config.subagents, cwd, store: SUBAGENT_STATE_ROOT ? new SubagentStore({ cwd, dir: SUBAGENT_STATE_ROOT }) : undefined },
    topologies: { ...config.topologies, tools: {}, options: { ...(config.topologies?.options || {}), cwd, roleRuntimeConfig: resolveRoleRuntimeConfig(process.env, { cwd }), enforceRoleRollout: true } },
    skillIntake: { ...config.skillIntake, cwd },
    learning: { enabled: process.env.PI_LEARNING_LOOP !== "0", cwd },
    executionOutcomes: { enabled: true, cwd, storage: new FileIntegrationStorage(join(cwd, ".pi", "execution-outcomes")), prefix: "" },
    memoryState: { enabled: true, cwd },
    typesafe: { persist: true },
    pilots: { enabled: true, cwd },
    tasks: { enabled: process.env.PI_SPECIALIST_TASKS_ENABLED === "1", cwd, policyFile: ".pi/specialist-task-policy.json" },
  });
  configureProjectMemoryServices(boundary, { cwd, env: process.env });
  boundary.topologies.engine.tools = makeTopologyTools(cwd, boundary);
  boundary.__sourceHash = sourceHash;
  boundary.__lastMakeBoundaryTiming = { name: "makeBoundary.rebuild", durationMs: elapsedMs(start), skills: boundary.skills?.metrics?.().skills, topologies: boundary.topologies?.listTopologies?.().length };
  if (SKILL_SNAPSHOT_ON_START) { try { boundary.skills.snapshot({ note: "session-start" }); } catch {} }
  boundaryCache.set(cwd, boundary);
  return boundary;
}
async function drainExecutionOutcomes(rt: Runtime) {
  const results: any[] = [];
  if (EXECUTION_OUTCOME_SKILLS && rt.boundary.skills?.captureExecutionOutcome) {
    results.push(await rt.boundary.executionOutcomes.drain("skill-synthesis", (packet: any) => rt.boundary.skills.captureExecutionOutcome(packet)));
  }
  if ((rt.projectMemoryRollout?.controls?.candidateCapture || rt.projectMemoryRollout?.controls?.diagnosticCapture) && rt.projectMemoryCandidates?.captureExecutionReference) {
    const consumer = rt.projectMemoryRollout.controls.candidateCapture ? "project-memory-candidates" : "project-memory-diagnostics";
    results.push(await rt.boundary.executionOutcomes.drain(consumer, (packet: any) => rt.projectMemoryCandidates.captureExecutionReference(packet)));
  }
  if (HERMES_SKILL_AUTO_DRAFT && rt.boundary.compounding?.status?.().fieldRolloutAuthorized === true) {
    const synthesis = rt.boundary.skills.synthesize({ approve: false });
    for (const skill of synthesis.skills || []) {
      try { results.push(await rt.boundary.skills.draftAgentSkill(skill.skillId, { automaticAuthorized: true, probeAuth: false })); }
      catch (error: any) { rt.boundary.trace.emit({ category: "skill", name: "skill.hermes_auto_draft_failed", severity: "warn", payload: { skillId: skill.skillId, errorCode: error?.code || "unknown" } }); }
    }
  }
  return results;
}
function scheduleReasoningPersist(rt: Runtime, reason = "deferred") {
  rt.reasoningDirty = true;
  if (rt.reasoningPersistTimer) return;
  rt.reasoningPersistTimer = setTimeout(() => {
    rt.reasoningPersistTimer = undefined;
    if (!rt.reasoningDirty) return;
    const start = Date.now();
    try { reasoningAdapter(rt)?.persist?.(); rt.reasoningDirty = false; recordTiming(rt, "reasoning.persist", start, { reason }); }
    catch (error: any) { rt.boundary.trace.emit({ category: "reasoning", name: "reasoning.persist_error", severity: "warn", error: error?.message || String(error) }); }
  }, REASONING_PERSIST_DEBOUNCE_MS);
  rt.reasoningPersistTimer?.unref?.();
}
function flushReasoningPersist(rt: Runtime | undefined, reason = "flush") {
  if (!rt) return;
  if (rt.reasoningPersistTimer) { clearTimeout(rt.reasoningPersistTimer); rt.reasoningPersistTimer = undefined; }
  if (!rt.reasoningDirty) return;
  const start = Date.now();
  try { reasoningAdapter(rt)?.persist?.(); rt.reasoningDirty = false; recordTiming(rt, "reasoning.persist", start, { reason }); }
  catch (error: any) { rt.boundary.trace.emit({ category: "reasoning", name: "reasoning.persist_error", severity: "warn", error: error?.message || String(error) }); }
}
function enforceReasoningAutomatedRetention(rt: Runtime, { persist = false, trigger = "runtime" } = {}) {
  if (!REASONING_AUTO_PRUNE_AUTOMATED) return null;
  const adapter = reasoningAdapter(rt);
  const metrics = adapter?.metrics?.() || {};
  const automated = Number(metrics.automatedVerifierEvidence || 0);
  const actions = Number(metrics.automatedExecutorActions || 0);
  const evidenceOver = Boolean(adapter?.pruneAutomatedVerification) && automated > REASONING_AUTO_PRUNE_AUTOMATED_MAX;
  const actionsOver = Boolean(adapter?.pruneAutomatedVerification) && actions > REASONING_AUTO_PRUNE_ACTIONS_MAX;
  if (!evidenceOver && !actionsOver) return null;
  const start = Date.now();
  try {
    const snapshotKey = `reasoning/snapshots/pre-auto-automated-prune-${Date.now()}`;
    snapshotReasoningState(rt.boundary, snapshotKey);
    rotateSnapshotKeys(reasoningSnapshots, snapshotKey, REASONING_SNAPSHOT_KEEP, (stale) => rt.boundary.storage?.deleteJson?.(stale));
    const result = adapter.pruneAutomatedVerification({ keep: REASONING_AUTO_PRUNE_AUTOMATED_KEEP, keepExecutorActions: REASONING_AUTO_PRUNE_ACTIONS_KEEP, dryRun: false });
    rt.reasoningDirty = true;
    if (persist) flushReasoningPersist(rt, "auto-prune-automated-verification");
    rt.boundary.trace.emit({ category: "maintenance", name: "reasoning.auto_prune_automated", payload: { automated, actions, keep: REASONING_AUTO_PRUNE_AUTOMATED_KEEP, keepExecutorActions: REASONING_AUTO_PRUNE_ACTIONS_KEEP, removed: result.removed?.length || 0, trigger }, durationMs: elapsedMs(start) });
    return result;
  } catch (error: any) {
    rt.boundary.trace.emit({ category: "maintenance", name: "reasoning.auto_prune_automated_error", severity: "warn", error: error?.message || String(error), payload: { trigger } });
    return null;
  }
}
function scheduleReasoningAutomatedPrune(rt: Runtime) {
  if (!REASONING_AUTO_PRUNE_AUTOMATED || rt.reasoningAutoPruneTimer) return;
  rt.reasoningAutoPruneTimer = setTimeout(() => {
    rt.reasoningAutoPruneTimer = undefined;
    enforceReasoningAutomatedRetention(rt, { persist: true, trigger: "session-start" });
  }, 1000);
  rt.reasoningAutoPruneTimer?.unref?.();
}
function scheduleMemoryConsolidation(rt: Runtime) {
  if (!AUTO_CONSOLIDATE) return;
  const now = Date.now();
  if (rt.consolidateTimer) return;
  if (rt.lastConsolidatedAt && now - rt.lastConsolidatedAt < CONSOLIDATE_INTERVAL_MS) return;
  rt.consolidateTimer = setTimeout(() => {
    rt.consolidateTimer = undefined;
    try {
      rt.boundary.memory.consolidate({ force: false });
      rt.boundary.memory.persist();
      rt.lastConsolidatedAt = Date.now();
    } catch (error: any) {
      rt.boundary.trace.emit({ category: "memory", name: "reasoning.consolidate_error", severity: "warn", error: error?.message || String(error) });
    }
  }, CONSOLIDATE_DEBOUNCE_MS);
  rt.consolidateTimer?.unref?.();
}
function ensureProjectVerificationBoundary(rt: Runtime) {
  const desired = projectVerificationVerifiers(rt.cwd);
  if (!desired.length) return;
  const current = rt.boundary?.verification?.pipeline?.graph?.verifiers || [];
  const currentIds = new Set(current.map((v: any) => v.id));
  if (desired.every((v: any) => currentIds.has(v.id))) return;
  boundaryCache.delete(rt.cwd);
  rt.boundary = makeBoundary(rt.cwd);
}

async function scheduleVerify(rt: Runtime) {
  if (!AUTO_VERIFY || rt.verifyTimer) return;
  rt.verifyTimer = setTimeout(async () => {
    rt.verifyTimer = undefined;
    const changedFiles = [...rt.touched];
    rt.touched.clear();
    if (!changedFiles.length) return;
    try {
      ensureProjectVerificationBoundary(rt);
      const result = await rt.boundary.verification.verify({ cwd: rt.cwd, patchSet: { id: `auto-${Date.now()}`, files: changedFiles }, changeSet: { changedFiles, before: {}, after: {} } });
      const coverageGap = result.status === "no-verifiers";
      const verificationFailed = result.ok === false && !coverageGap;
      const verificationPassed = result.ok === true;
      const resultSummary = summarizeVerificationResult(rt.boundary, result);
      const resultSummaryText = JSON.stringify(resultSummary);
      rt.boundary.entropy.observe({ type: coverageGap ? "verification-coverage-gap" : "verification", ok: verificationPassed, text: resultSummaryText.slice(0, 1200), changedFiles });
      const adapter = reasoningAdapter(rt);
      const evidence = adapter?.recordVerifierEvidence?.({ claim: coverageGap ? `Automatic verification coverage gap for ${changedFiles.join(", ")}` : `Automatic verification for ${changedFiles.join(", ")}`, ok: verificationPassed, status: coverageGap ? "no-verifiers" : verificationPassed ? "passed" : "failed", classification: coverageGap ? "verification-coverage-gap" : verificationPassed ? "verified-success" : "verification-failure", kind: "automated", method: "verification-adapter", observations: [short(resultSummaryText, 1200)], artifacts: [result.evidenceFile, ...changedFiles].filter(Boolean), confidence: coverageGap ? 0 : verificationFailed ? 0.35 : 0.8, verifier: "cognitive-automation" });
      if (verificationFailed && evidence && adapter?.addVerifierFeedback && adapter?.analyzeFailure) {
        const feedback = adapter.addVerifierFeedback({ evidenceId: evidence.id, status: "needs_revision", message: "Automatic verifier failed; revise using verifier evidence.", requiredActions: ["inspect verifier evidence", "fix failing condition", "rerun verification"] });
        adapter.analyzeFailure({ failure: resultSummary, evidenceIds: [evidence.id], actionIds: [], hypothesisIds: [], summary: "Automatic verification failed." });
        rt.boundary.trace.emit({ category: "verification", name: "reasoning.feedback", evidenceId: evidence.id, feedbackId: feedback.id, severity: "warn" });
      }
      enforceReasoningAutomatedRetention(rt, { persist: false, trigger: "automatic-verification" });
      adapter?.persist?.();
    } catch (error: any) {
      rt.boundary.trace.emit({ category: "verification", name: "reasoning.verify_error", severity: "error", error: error?.message || String(error) });
    }
  }, VERIFY_DEBOUNCE_MS);
}

export default function cognitiveAutomation(pi: ExtensionAPI) {
  if (!ENABLED) return;
  pi = instrumentExtensionCommands(pi, { extension: "reasoning-runtime", version: EXTENSION_VERSION }) as ExtensionAPI;

  pi.on("session_start", async (_event, ctx: any) => {
    const start = Date.now();
    const boundary = makeBoundary(ctx.cwd);
    runtime = { boundary, cwd: ctx.cwd, prompt: "", touched: new Set(), pending: new Map(), autoRouteMode: autoRouteModeFromSession(ctx) || TOPOLOGY_AUTO_ROUTE_DEFAULT_MODE, autoRouteRuns: new Map(), askRuns: [], subagentRuns: new Map(), timings: [], telemetry: createExtensionTelemetry({ cwd: ctx.cwd, extension: "reasoning-runtime", version: EXTENSION_VERSION }), projectMemoryRollout: boundary.projectMemoryRollout, projectMemoryCandidates: boundary.projectMemoryCandidates };
    restoreUserScaffold(runtime, ctx);
    const sessionType = process.env.PI_DETERMINISTIC_FIXTURE === "1" || process.env.PI_ROLE_RUNTIME_FIXTURE_MODE === "1" ? "deterministic-fixture" : ctx?.hasUI === false ? "headless-smoke" : "interactive";
    try { pi.appendEntry?.("session-miner.classification", { classifierVersion: "session-miner-v4", sessionType }); } catch {}
    clearPersistedAskRuns(runtime);
    installAskEscapeHandler(ctx, runtime);
    if (boundary.__lastMakeBoundaryTiming) runtime.timings?.push({ at: new Date().toISOString(), ...boundary.__lastMakeBoundaryTiming });
    try {
      const recovered = runtime.boundary.subagents.recoverInterruptedRuns();
      if (recovered.length) runtime.boundary.trace.emit({ category: "session", name: "subagent.orphans_recovered", counts: { recovered: recovered.length } });
    } catch (error: any) {
      runtime.boundary.trace.emit({ category: "failure_state", name: "subagent.recovery_failed", severity: "warn", error: error?.message || String(error) });
    }
    const cleanupStart = Date.now();
    const runStaleCleanup = shouldRunStaleCleanup(runtime.boundary, ctx.cwd);
    if (runStaleCleanup) { const cleanupResult = clearStaleReasoningState(runtime.boundary); markStaleCleanupDone(runtime.boundary, cleanupResult); staleCleanupDone.add(ctx.cwd); }
    recordTiming(runtime, "session_start.stale_cleanup", cleanupStart, { ran: runStaleCleanup });
    runtime.boundary.context.upsert({ layer: "L0", title: "Integration boundary contract", content: "Pi core and extensions consume cognitive libraries through src/integration-boundary.js adapters, not scattered internal imports.", tags: ["principle", "architecture"], protected: true, verification: "verified" });
    runtime.boundary.trace.emit({ category: "session", name: "cognitive.session_start" });
    try { await drainExecutionOutcomes(runtime); } catch (error: any) { runtime.boundary.trace.emit({ category: "failure_state", name: "execution_outcome.drain_failed", severity: "warn", error: error?.message || String(error) }); }
    scheduleReasoningAutomatedPrune(runtime);
    recordTiming(runtime, "session_start.total", start);
    try { boundary.typesafe.pruneTurnRecords(); } catch (error: any) { boundary.trace.emit({ category: "failure_state", name: "typesafe.prune_failed", severity: "warn", error: error?.message || String(error) }); }
    pi.events.emit("typesafe:service", boundary.typesafe.service());
    ctx.ui.setStatus("reasoning", COGNITIVE_TIMING ? "reasoning-runtime timing" : "reasoning-runtime");
    updateAutoRouteWidget(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (runtime) restoreUserScaffold(runtime, ctx);
  });

  pi.on("input", async (event: any, ctx: any) => {
    if (!runtime) return { action: "continue" };
    startTypesafeTurn(runtime, event, ctx);
    if (!event.streamingBehavior) runtime.extensionPrompt = event.source === "extension";
    if (event.source === "extension") return { action: "continue" };
    const inputText = String(event.text || "");
    runtime.skillMutationAuthorized = event.streamingBehavior ? Boolean(runtime.skillMutationAuthorized || explicitSkillGovernanceIntent(inputText)) : explicitSkillGovernanceIntent(inputText);
    const explicitSkillIds = runtime.boundary.skills?.resolveExplicitInvocation?.(inputText) || [];
    const priorInvocations = new Set(runtime.invokedSkillIds || []);
    const newlyInvoked = event.streamingBehavior ? explicitSkillIds.filter((id: string) => !priorInvocations.has(id)) : explicitSkillIds;
    if (event.streamingBehavior) {
      const hadInvocation = Boolean(runtime.invokedSkillIds?.length);
      runtime.invokedSkillIds = [...new Set([...(runtime.invokedSkillIds || []), ...explicitSkillIds])];
      if (explicitSkillIds.length) {
        runtime.skillAssistant = undefined;
        if (!hadInvocation) runtime.lastToolError = false;
      }
    } else {
      runtime.invokedSkillIds = explicitSkillIds;
      runtime.skillAssistant = undefined;
      runtime.lastToolError = false;
    }
    const suggestedSkill = runtime.lastSuggestedSkillIds?.[0];
    for (const id of newlyInvoked) recordRecommendation(runtime, "skill", suggestedSkill && id !== suggestedSkill ? "overridden" : "accepted", suggestedSkill && id !== suggestedSkill ? suggestedSkill : id, 1, ctx);
    const explicitTopology = inputText.trim().match(/^\/topology-run\s+(\S+)/)?.[1];
    if (explicitTopology && runtime.autoRouteLast?.topologyId) recordRecommendation(runtime, "router", explicitTopology === runtime.autoRouteLast.topologyId ? "accepted" : "overridden", runtime.autoRouteLast.topologyId, runtime.autoRouteLast.confidence, ctx);
    if (/\b(?:wrong|incorrect|not relevant)\b[^.\n]{0,80}\b(?:route|router|topology|skill suggestion)\b/i.test(inputText)) {
      if (/\bskill\b/i.test(inputText) && suggestedSkill) recordRecommendation(runtime, "skill", "corrected", suggestedSkill, 1, ctx);
      else if (runtime.autoRouteLast?.matched) recordRecommendation(runtime, "router", "corrected", autoRouteCandidate(runtime.autoRouteLast), runtime.autoRouteLast.confidence, ctx);
    }
    runtime.prompt = inputText;
    if (!event.streamingBehavior && event.source === "interactive" && !inputText.trim().startsWith("/")) {
      runtime.boundary.skillPilot?.settle("interrupted");
      runtime.pilotRequestId = randomUUID();
      runtime.boundary.entropy.review?.begin({ interactive: ctx.mode === "tui", sessionId: getParentSessionId(ctx), requestId: runtime.pilotRequestId });
    }
    if (inputText.trim().startsWith("/")) return { action: "continue" };
    if (inputText.trim()) pi.appendEntry(USER_TASK_ENTRY_TYPE, { objective: inputText });
    runtime.projectMemoryCandidates?.observePrompt?.(inputText);
    runtime.projectMemoryCandidates?.observeCorrection?.(inputText);
    syncObjective(runtime, resolveTaskObjective(runtime.prompt, { parentTask: runtime.userScaffold?.plan }));
    runtime.boundary.entropy.observe({ type: "objective", text: runtime.prompt, contextBudgetTokens: CONTEXT_BUDGET_TOKENS });
    const autoRouteResult = await maybeHandleAutoRouteInput(pi, event, ctx);
    if (autoRouteResult) return autoRouteResult;
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (!runtime || !AUTO_INJECT) return;
    // Headless one-shots: the scaffold was 60-72% of the bytes of trivial
    // pi -p sessions (19 of 180 mined runs got ~6.8KB for an 11-byte
    // prompt). Opt back in per run with PI_COGNITIVE_HEADLESS_INJECT=1.
    if (ctx?.hasUI === false && process.env.PI_COGNITIVE_HEADLESS_INJECT !== "1") {
      const delegated = renderDelegatedRoleResult(runtime.autoRouteTurnResult);
      runtime.autoRouteTurnResult = undefined;
      runtime.telemetry?.contextInjection(delegated.length, "headless-disabled", Boolean(delegated), delegated.length, "headless-smoke", runtimeSessionToken(runtime, ctx));
      return delegated ? { message: { customType: "delegated-role-result", content: delegated, display: false } } : undefined;
    }
    const beforeStart = Date.now();
    const prompt = event.prompt || runtime.prompt || "";
    const metaPrompt = isMetaRecommendationPrompt(prompt);
    const typesafe = runtime.boundary.typesafe;
    const typesafeModes = typesafe?.modes || { intent: "off" };
    let judgment: any = null;
    if (typesafeModes.intent === "on") {
      const waitStart = Date.now();
      const pending = typesafe.turnFor(prompt);
      judgment = pending ? await pending : null;
      recordTiming(runtime, "before_agent_start.typesafeWait", waitStart, { outcome: judgment ? (judgment.ok ? "ok" : judgment.reason) : "not-judged" });
    }
    const scaffoldOptions = { parentTask: runtime.userScaffold?.plan, ...(typesafeModes.intent === "on" ? { judged: judgment?.ok ? { modality: judgment.decision.intent.modality.value, confidence: judgment.decision.intent.modality.confidence } : { modality: null } } : {}) };
    const objective = runtime.extensionPrompt && runtime.userScaffold?.plan?.objective ? runtime.userScaffold.plan.objective : resolveTaskObjective(prompt, scaffoldOptions);
    const syncStart = Date.now();
    syncObjective(runtime, objective);
    recordTiming(runtime, "before_agent_start.syncObjective", syncStart, { metaPrompt });
    const scaffoldStart = Date.now();
    const scaffold = await Promise.resolve().then(() => {
      const adapter = reasoningAdapter(runtime as Runtime);
      const template = scaffoldTemplate(prompt, scaffoldOptions);
      const decompositionTemplateValue = { ...decompositionTemplate(prompt, scaffoldOptions), source: "model-scaffold" };
      if (!adapter) return { enabled: false, reason: "reasoning runtime adapter unavailable", plan: template, decomposition: decompositionTemplateValue };
      if (metaPrompt) {
        return { kind: "reasoning.scaffold", transient: true, plan: { type: "plan", ...template, id: "transient_meta_plan" }, decomposition: { type: "task_decomposition", ...decompositionTemplateValue, id: "transient_meta_decomposition" }, checkpoint: { type: "reasoning_checkpoint", kind: "plan", publicSummary: `Transient reasoning scaffold for meta prompt: ${short(prompt, 160)}`, artifactIds: [], scratchpadRef: null, result: {}, nextActions: [] } };
      }
      let plan = adapter.createPlan(template);
      let decomposition = adapter.decomposeTask(decompositionTemplateValue);
      if (!plan.steps?.length || !plan.risks?.length || !plan.successCriteria?.length) plan = { ...template, ...plan, steps: template.steps, risks: template.risks, successCriteria: template.successCriteria };
      if (!decomposition.subtasks?.length) decomposition = { ...decompositionTemplateValue, ...decomposition, subtasks: decompositionTemplateValue.subtasks, ordering: decompositionTemplateValue.ordering };
      const checkpoint = adapter.createCheckpoint({ kind: "plan", publicSummary: `Reasoning scaffold initialized for: ${short(prompt, 160)}`, artifactIds: [plan.id, decomposition.id], metadata: { source: "model-scaffold" } });
      const scaffold = { kind: "reasoning.scaffold", plan, decomposition, checkpoint };
      if (!scaffoldIsRich(scaffold)) throw new Error("stale reasoning scaffold template generated empty fields");
      adapter.prune?.({ maxAutoScaffold: 60 });
      scheduleReasoningPersist(runtime as Runtime, "auto-scaffold");
      return scaffold;
    }).catch((error: any) => ({ error: error.message }));
    recordTiming(runtime, "before_agent_start.scaffold", scaffoldStart, { metaPrompt });
    const [recalled, packed, skillMatches, projectMemoryRecall, standingMemory] = await Promise.all([
      Promise.resolve().then(() => { const s = Date.now(); const r = runtime!.boundary.memory.retrieve(prompt, { limit: 12, types: HOT_PATH_MEMORY_TYPES, excludeProvenanceSources: HOT_PATH_EXCLUDED_PROVENANCE }); recordTiming(runtime, "before_agent_start.memoryRetrieve", s, { metaPrompt, types: HOT_PATH_MEMORY_TYPES, excludedProvenance: HOT_PATH_EXCLUDED_PROVENANCE }); return r; }),
      Promise.resolve().then(() => { const s = Date.now(); const r = runtime!.boundary.context.pack({ tokenBudget: CONTEXT_BUDGET_TOKENS, query: prompt, includeScratch: false }); recordTiming(runtime, "before_agent_start.contextPack", s, { metaPrompt }); return r; }),
      Promise.resolve().then(() => { const s = Date.now(); const skipped = metaPrompt && SKILL_META_INJECT_MAX <= 0; const r = skipped ? { skills: [] } : runtime!.boundary.skills?.retrieve?.(prompt, { limit: metaPrompt ? SKILL_META_INJECT_MAX : SKILL_INJECT_MAX, minScore: SKILL_INJECT_MIN_SCORE }) || { skills: [] }; recordTiming(runtime, "before_agent_start.skillRetrieve", s, { metaPrompt, skipped }); return r; }),
      Promise.resolve().then(() => { const s = Date.now(); const enabled = !metaPrompt && runtime!.projectMemoryRollout?.controls?.taskRecall; let r: any = { items: [], candidates: 0, durationMs: 0, reason: enabled ? "unavailable" : "rollout-disabled" }; if (enabled) { try { r = runtime!.boundary.projectMemory.recall(prompt, { limit: 5, taskConditioned: true }); } catch (error: any) { r = { items: [], candidates: 0, durationMs: 0, reason: error?.message || "recall-error" }; } } recordTiming(runtime, "before_agent_start.projectMemoryRecall", s, { metaPrompt, enabled, items: r.items?.length || 0, sourceKind: r.sourceKind }); return r; }),
      Promise.resolve().then(() => { const s = Date.now(); let r: any = { items: [], candidates: 0, characters: 0, reason: metaPrompt ? "meta-prompt" : "unavailable" }; if (!metaPrompt) { try { r = runtime!.boundary.projectMemory.standing({ limit: 12, maxChars: 1600 }); } catch (error: any) { r = { items: [], candidates: 0, characters: 0, reason: error?.message || "standing-error" }; } } recordTiming(runtime, "before_agent_start.standingProjectMemory", s, { metaPrompt, items: r.items?.length || 0, characters: r.characters || 0 }); return r; }),
    ]);
    const pilot = !runtime.extensionPrompt ? runtime.boundary.skillPilot?.prepare({ prompt, sessionId: getParentSessionId(ctx), requestId: runtime.pilotRequestId, interactive: ctx.mode === "tui", model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null, thinkingLevel: ctx.thinkingLevel }) : null;
    if (pilot?.caseId) skillMatches.skills = (skillMatches.skills || []).filter((skill: any) => skill.skillId !== pilot.skillId);
    if (pilot?.blocked) ctx.ui.notify(`Advisory skill pilot paused: ${pilot.blocked}`, "warning");
    const memoryEntries = selectInjectionMemory(recalled.entries.filter((e: any) => !isStaleReasoningText(`${e.title || ""}\n${e.content || ""}`)), { maxEntries: 6 });
    const skillAdvisory = formatSkillAdvisory(skillMatches.skills || [], metaPrompt ? SKILL_META_INJECT_MAX : SKILL_INJECT_MAX);
    const autoRouteAdvisory = formatAutoRouteAdvisory(runtime, prompt);
    const delegatedRoleResult = renderDelegatedRoleResult(runtime.autoRouteTurnResult);
    runtime.autoRouteTurnResult = undefined;
    const failureAdvisory = formatFailureAdvisory(runtime.boundary.skills?.listFailurePatterns?.({ limit: 30 }) || [], prompt);
    const projectMemoryAdvisory = runtime.boundary.projectMemory?.format?.(projectMemoryRecall, { maxChars: 1200 }) || "";
    const standingMemoryAdvisory = runtime.boundary.projectMemory?.formatStanding?.(standingMemory, { maxChars: 1600 }) || "";
    const renderStart = Date.now();
    // The scaffold describes the user's task. Extension-authored prompts (for
    // example a post-compaction "carry on") continue that task, so they keep the
    // last user scaffold instead of being classified as a task of their own.
    const turnScaffold = runtime.extensionPrompt && runtime.userScaffold ? runtime.userScaffold : scaffold;
    if (!runtime.extensionPrompt) runtime.userScaffold = scaffold;
    const scaffoldMode = runtime.fullScaffoldInjected ? "delta" : "full";
    const context = renderInjectedReasoningContext({ version: liveVersion(), scaffold: turnScaffold, objective, memoryEntries, layeredText: packed.text || "none", advisoryText: [standingMemoryAdvisory, projectMemoryAdvisory, autoRouteAdvisory, skillAdvisory, failureAdvisory].filter(Boolean).join("\n\n"), scaffoldMode, stalePattern: STALE_REASONING_RE, maxChars: COGNITIVE_INJECT_MAX_CHARS });
    // The full context is injected once per session. Later turns cross the
    // boundary only with sections whose content changed, including the scaffold
    // when the modality changes. Historical objectives and successful proof
    // logs are deliberately excluded from hot-path memory.
    const { inject, reason } = dedupeInjectedContext(runtime.lastInjectedContext, context, { maxChars: COGNITIVE_INJECT_MAX_CHARS });
    runtime.lastInjectedContext = context;
    if (inject && scaffoldMode === "full") runtime.fullScaffoldInjected = true;
    runtime.telemetry?.contextInjection(inject ? inject.length : 0, reason, Boolean(inject), context.length, contextSessionKind(ctx), runtimeSessionToken(runtime, ctx));
    if (inject?.includes("[L2:skills]")) {
      const shownSkills = (skillMatches.skills || []).slice(0, metaPrompt ? SKILL_META_INJECT_MAX : SKILL_INJECT_MAX);
      runtime.lastSuggestedSkillIds = shownSkills.map((skill: any) => skill.skillId).filter(Boolean);
      for (const skill of shownSkills) {
        const retrieval = (skillMatches.ranked || []).find((row: any) => row.skill?.skillId === skill.skillId);
        recordRecommendation(runtime, "skill", "shown", skill.skillId, retrieval?.score || skill.confidenceScore, ctx);
      }
    }
    const finalInject = [inject, delegatedRoleResult, pilot?.evidenceInstructions, pilot?.advisory].filter(Boolean).join("\n\n");
    if (pilot?.caseId) runtime.boundary.skillPilot.delivered();
    recordTiming(runtime, "before_agent_start.render", renderStart, { chars: context.length, injectedChars: finalInject.length, dedupe: reason, scaffoldMode, metaPrompt });
    recordTiming(runtime, "before_agent_start.total", beforeStart, { metaPrompt });
    if (!finalInject) return;
    return { message: { customType: delegatedRoleResult ? "delegated-role-result" : "cognitive-automation", content: finalInject, display: false } };
  });

  pi.on("before_provider_request", () => { runtime?.boundary.skillPilot?.observeModel(); });
  pi.on("context", (event: any) => { runtime?.boundary.skillPilot?.observeMessages(event.messages); });

  pi.on("message_end", async (event: any) => {
    if (!runtime) return;
    const text = short(textOf(event.message?.content), 1800);
    if (!text) return;
    runtime.boundary.entropy.observe({ type: event.message?.role === "assistant" ? "progress" : "event", text });
    if (event.message?.role === "assistant") {
      if (runtime.invokedSkillIds?.length) runtime.skillAssistant = event.message;
      runtime.boundary.memory.remember({ type: "episodic", title: "Assistant turn", content: diagnosticTextMetadata(text, "Assistant response"), tags: ["assistant-turn"], verification: "inferred", confidence: 0.45, provenance: { source: "pi-message" } });
    }
    runtime.boundary.memory.persist();
    scheduleMemoryConsolidation(runtime);
    scheduleReasoningPersist(runtime, "message_end");
  });

  pi.on("agent_settled", async (_event: any, ctx: any) => {
    if (!runtime) return;
    try { await drainExecutionOutcomes(runtime); } catch (error: any) { runtime.boundary.trace.emit({ category: "failure_state", name: "execution_outcome.drain_failed", severity: "warn", error: error?.message || String(error) }); }
    if (ctx.isIdle() && !ctx.hasPendingMessages()) {
      finishTypesafeTurn(runtime);
      runtime.boundary.skillPilot?.settle();
      runtime.boundary.entropy.review?.settle();
      const scanLimit = runtime.projectMemoryCandidates?.maxScan ?? 2000;
      const durableEntries = runtime.boundary.memory.findRecent?.((entry: any) => ["semantic", "procedural", "strategic"].includes(entry.type), scanLimit) || [];
      runtime.projectMemoryCandidates?.settle?.(durableEntries);
    }
    if (!runtime.invokedSkillIds?.length) return;
    // Another extension may start or queue a continuation from an earlier
    // agent_settled handler. Evaluate only once the whole user task is idle.
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    const assistant = runtime.skillAssistant;
    if (!assistant) return;
    const responseText = short(textOf(assistant.content), 1800);
    const failureText = [responseText, assistant.errorMessage].filter(Boolean).join("\n");
    const outcome = runtime.boundary.skills.settlementOutcome({
      stopReason: assistant.stopReason,
      toolError: runtime.lastToolError,
      failureSignal: assistantTurnHasFailureSignal(failureText),
    });
    if (!outcome?.eligible) return;
    const skillIds = [...new Set(runtime.invokedSkillIds)];
    runtime.invokedSkillIds = [];
    runtime.skillAssistant = undefined;
    runtime.lastToolError = false;
    for (const skillId of skillIds) {
      try {
        runtime.boundary.skills.evaluate(skillId, {
          ...outcome,
          invoked: true,
          source: "agent_settled",
          prompt: runtime.prompt,
        });
      } catch {}
    }
  });

  pi.on("tool_call", async (event: any) => {
    if (!runtime) return;
    const p = extractPaths(event.input)[0];
    runtime.pending.set(event.toolCallId, { toolName: event.toolName, input: event.input, path: p, beforeText: safeRead(runtime.cwd, p) });
    runtime.boundary.skillPilot?.observeTool();
    runtime.boundary.trace.emit({ category: "tool_exposure", name: "tool_call", toolName: event.toolName });
    runtime.boundary.entropy.observe({ type: "tool_call", tool: event.toolName, text: short(JSON.stringify(event.input), 1000) });
    if (AUTO_BRANCH && ["edit", "write"].includes(event.toolName)) runtime.boundary.branching.autoBranch({ text: JSON.stringify(event.input), kind: "verify", entropyScore: runtime.boundary.entropy.health()?.metrics?.entropyScore || 0 }, {});
  });

  pi.on("tool_result", async (event: any) => {
    if (!runtime) return;
    const roleOutcomeOverride = roleToolResultOverride(event);
    if (roleOutcomeOverride?.isError) event.isError = true;
    if (event.isError || event.error) runtime.lastToolError = true;
    if (event.toolName === "verification_center" && String(event.input?.operation || "").toLowerCase() === "run") runtime.boundary.skillPilot?.observeVerification(event.details);
    const pre = runtime.pending.get(event.toolCallId);
    runtime.pending.delete(event.toolCallId);
    const paths = new Set([...(pre?.path ? [pre.path] : []), ...extractPaths(event.input)]);
    for (const p of paths) {
      const after = safeRead(runtime.cwd, p);
      if (after !== undefined && after !== pre?.beforeText) {
        runtime.touched.add(p);
        const diff = runtime.boundary.anchoring.diff(pre?.beforeText || "", after, p);
        runtime.boundary.entropy.observe({ type: "patch", ok: !event.isError, patch: diff, changedFiles: [p], text: short(JSON.stringify(diff), 1200) });
        reasoningAdapter(runtime)?.recordExecutorAction?.({ action: pre?.toolName || event.toolName || "tool", target: p, outputs: { diff }, result: event.isError ? "error" : "completed" });
      }
    }
    if (["edit", "write", "bash"].includes(event.toolName)) await scheduleVerify(runtime);
    return roleOutcomeOverride;
  });

  pi.on("session_shutdown", async (event: any) => {
    if (!runtime) return;
    runtime.boundary.skillPilot?.settle("interrupted");
    runtime.boundary.entropy.review?.settle();
    if (runtime.verifyTimer) clearTimeout(runtime.verifyTimer);
    if (runtime.consolidateTimer) clearTimeout(runtime.consolidateTimer);
    runtime.askInputCleanup?.();
    runtime.askInputCleanup = undefined;
    if (runtime.reasoningAutoPruneTimer) { clearTimeout(runtime.reasoningAutoPruneTimer); runtime.reasoningAutoPruneTimer = undefined; }
    if (runtime.reasoningPersistTimer && ["new", "resume", "fork", "reload"].includes(event?.reason)) { clearTimeout(runtime.reasoningPersistTimer); runtime.reasoningPersistTimer = undefined; }
    cancelAutoRouteRuns(runtime);
    for (const controller of runtime.subagentRuns?.values?.() || []) { try { controller.abort(); } catch {} }
    runtime.subagentRuns?.clear?.();
    finishTypesafeTurn(runtime);
    runtime.boundary.trace.emit({ category: "session", name: "cognitive.session_shutdown", reason: event?.reason });
    // /new, /resume, /fork, and /reload are latency-sensitive navigation paths.
    // Hot-path mutations persist when they occur, so avoid redundant large JSON
    // writes during session replacement. Quit/unknown shutdown still flushes.
    if (!["new", "resume", "fork", "reload"].includes(event?.reason)) {
      runtime.boundary.memory.persist();
      runtime.boundary.context.persist();
      if (runtime.reasoningDirty) flushReasoningPersist(runtime, `session_shutdown:${event?.reason || "unknown"}`);
    }
    runtime = undefined;
  });

  const focusAskPanel = async (ctx: any) => openAskPanel(ctx, pi);
  pi.registerShortcut("ctrl+shift+a", { description: "Focus the ask sidecar panel", handler: focusAskPanel });
  pi.registerShortcut("alt+a", { description: "Focus the ask sidecar panel (screen-friendly fallback)", handler: focusAskPanel });
  pi.registerShortcut("f8", { description: "Focus the ask sidecar panel (terminal fallback)", handler: focusAskPanel });

  pi.registerCommand("cognitive-status", { description: "Show boundary-backed reasoning runtime status", handler: async (_args, ctx: any) => ctx.ui.notify(status(), "info") });
  pi.registerCommand("compounding-status", { description: "Show latest metadata-only compounding scorecard status", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.compounding.status(), null, 2), "info"); } });
  pi.registerCommand("compounding-scorecard", { description: "Generate a private metadata-only scorecard: [--cohort=id] [--no-write]", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const raw = String(args || ""); const cohortId = raw.match(/--cohort=([^\s]+)/)?.[1] || null; const result = runtime.boundary.compounding.generate({ cohortId, write: !/--no-write/.test(raw) }); ctx.ui.notify(JSON.stringify(result, null, 2), Object.values(result.gates || {}).some((gate: any) => gate.status === "fail") ? "warning" : "info"); } });
  pi.registerCommand("cognitive-timing", { description: "Show/toggle cognitive automation timing records: /cognitive-timing [on|off]", handler: async (args, ctx: any) => { const mode = String(args || "").trim().toLowerCase(); if (mode === "on") { COGNITIVE_TIMING = true; if (runtime) runtime.timings = runtime.timings || []; return ctx.ui.notify("Cognitive timing enabled for this process.", "info"); } if (mode === "off") { COGNITIVE_TIMING = false; return ctx.ui.notify("Cognitive timing disabled for this process.", "info"); } ctx.ui.notify(formatTimings(runtime), "info"); } });
  pi.registerCommand("cognitive-prune-memory", { description: "Prune low-value assistant-turn memory: /cognitive-prune-memory [--apply] [--assistant-turns=N]", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const raw = String(args || ""); const keep = Number(raw.match(/--assistant-turns=(\d+)/)?.[1] || 200); const apply = /--apply|--yes/.test(raw); const result = pruneAssistantTurnMemory(runtime.boundary, { keep: Number.isFinite(keep) ? keep : 200, apply }); ctx.ui.notify(JSON.stringify(result, null, 2), apply ? "warning" : "info"); } });
  pi.registerCommand("cognitive-prune-trace", { description: "Prune trace event log: /cognitive-prune-trace [--apply] [--keep=N]", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const raw = String(args || ""); const keep = Number(raw.match(/--keep=(\d+)/)?.[1] || 2000); const apply = /--apply|--yes/.test(raw); if (apply) runtime.boundary.storage?.writeJson?.(`trace/snapshots/pre-trace-prune-${Date.now()}`, runtime.boundary.storage?.readJsonl?.("trace/events") || []); const result = runtime.boundary.trace.prune?.({ keep: Number.isFinite(keep) ? keep : 2000, dryRun: !apply }) || { supported: false }; ctx.ui.notify(JSON.stringify(result, null, 2), apply ? "warning" : "info"); } });
  pi.registerCommand("cognitive-memory", { description: "Recall local cognitive memory", handler: async (args, ctx: any) => ctx.ui.notify(runtime?.boundary.memory.retrieve(args || runtime.prompt || "project", { limit: 12 }).entries.map((e: any) => `[${e.type}] ${e.title}\n${e.content}`).join("\n\n---\n\n") || "No memory", "info") });
  pi.registerCommand("cognitive-context", { description: "Show layered context pack", handler: async (args, ctx: any) => ctx.ui.notify(runtime?.boundary.context.pack({ tokenBudget: CONTEXT_BUDGET_TOKENS, query: args || runtime.prompt || "", includeScratch: true }).text || "No context", "info") });
  pi.registerCommand("skill-pilot-status", { description: "Show machine-assessed verification outcomes and automatic advisory decision", handler: async (_args, ctx: any) => ctx.ui.notify(JSON.stringify(runtime?.boundary.skillPilot?.report(), null, 2), "info") });
  pi.registerCommand("skill-pilot-stop", { description: "Stop enrollment without deleting pilot evidence", handler: async (_args, ctx: any) => ctx.ui.notify(JSON.stringify(runtime?.boundary.skillPilot?.stop()), "info") });
  pi.registerCommand("entropy-review-stop", { description: "Stop entropy incident enrollment, preserving reviews", handler: async (_args, ctx: any) => ctx.ui.notify(JSON.stringify(runtime?.boundary.entropy.review?.stop()), "info") });
  pi.registerCommand("entropy-review-status", { description: "Show warned/unwarned incident reviews and measured diagnostic overhead", handler: async (_args, ctx: any) => ctx.ui.notify(JSON.stringify(runtime?.boundary.entropy.review?.report(), null, 2), "info") });

  pi.registerCommand("cognitive-entropy", { description: "Show entropy health", handler: async (_args, ctx: any) => ctx.ui.notify(JSON.stringify(runtime?.boundary.entropy.health() || {}, null, 2), "info") });
  pi.registerCommand("cognitive-branches", { description: "Show reasoning branch tree", handler: async (_args, ctx: any) => ctx.ui.notify(runtime?.boundary.branching.visualizeTree() || "No branches", "info") });
  pi.registerCommand("branch-list", { description: "List cognitive session branches", handler: async (_args, ctx: any) => ctx.ui.notify(runtime ? formatBranches(runtime.boundary.branching.list()) : "Reasoning runtime is not initialized", "info") });
  pi.registerCommand("branch-show", { description: "Show a cognitive session branch", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const id = parseBranchArgs(args).values[0]; if (!id) return ctx.ui.notify("Usage: /branch-show <branch-id>", "warning"); const branch = runtime.boundary.branching.getBranch(id); const snap = branch?.headSnapshotId ? runtime.boundary.branching.getSnapshot(branch.headSnapshotId) : null; const checkpoints = branch?.checkpoints?.length ? `\ncheckpoints:\n${branch.checkpoints.join("\n")}` : ""; ctx.ui.notify(`${formatBranch(branch, snap)}${checkpoints}`, branch ? "info" : "warning"); } });
  pi.registerCommand("branch-export", { description: "Export redacted metadata-only branch lineage (never recovery payload)", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const id = parseBranchArgs(args).values[0]; if (!id) return ctx.ui.notify("Usage: /branch-export <branch-id>", "warning"); try { ctx.ui.notify(JSON.stringify(runtime.boundary.branching.exportBranch(id), null, 2), "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("branch-cleanup-preview", { description: "Preview private-mode sanitization and lineage-aware branch snapshot retention", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.branching.cleanup({ apply: false }), null, 2), "info"); } });
  pi.registerCommand("branch-cleanup-apply", { description: "Apply reviewed branch snapshot sanitization/retention; requires --yes", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); if (!parseBranchArgs(args).apply) return ctx.ui.notify("Preview with /branch-cleanup-preview, then use /branch-cleanup-apply --yes.", "warning"); const result = runtime.boundary.branching.cleanup({ apply: true }); ctx.ui.notify(JSON.stringify(result, null, 2), result.result?.applied ? "info" : "warning"); } });
  pi.registerCommand("branch-diff", { description: "Compare two cognitive session branches", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const [left, right] = parseBranchArgs(args).values; if (!left || !right) return ctx.ui.notify("Usage: /branch-diff <left-branch-id> <right-branch-id>", "warning"); try { ctx.ui.notify(formatComparison(runtime.boundary.branching.compare(left, right)), "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("branch-merge", { description: "Dry-run or apply a cognitive session branch merge", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const parsed = parseBranchArgs(args); const [left, right] = parsed.values; if (!left || !right) return ctx.ui.notify("Usage: /branch-merge <left-branch-id> <right-branch-id> [--apply] [--force]", "warning"); try { const branches = [runtime.boundary.branching.getBranch(left), runtime.boundary.branching.getBranch(right)]; const bad = branches.find((b: any) => b?.status === "quarantined" || runtime?.boundary.branching.getSnapshot(b?.headSnapshotId)?.verifierState?.ok === false); if (bad && !parsed.force) return ctx.ui.notify(`Refusing to merge risky branch ${bad.id}; inspect it or pass --force.`, "warning"); const result = parsed.apply ? runtime.boundary.branching.merge(left, right, { apply: true, targetName: `merge ${left} ${right}` }) : runtime.boundary.branching.previewMerge(left, right); ctx.ui.notify(formatMergeResult(result, parsed.apply), result?.ok === false ? "warning" : "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("branch-rollback", { description: "Dry-run or apply cognitive session branch rollback", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const parsed = parseBranchArgs(args); const [branchId, snapshotId] = parsed.values; if (!branchId) return ctx.ui.notify("Usage: /branch-rollback <branch-id> [snapshot-id] [--apply|--yes]", "warning"); try { const branch = runtime.boundary.branching.getBranch(branchId); if (!branch) return ctx.ui.notify(`Branch not found: ${branchId}`, "warning"); const targetId = snapshotId || branch.parentSnapshotId || branch.checkpoints?.[0]; const target = targetId ? runtime.boundary.branching.getSnapshot(targetId) : null; if (!target) return ctx.ui.notify("Rollback snapshot not found. Use /branch-show to inspect checkpoints.", "warning"); if (!parsed.apply) return ctx.ui.notify(["rollback dry-run", formatBranch(branch, target), "Re-run with --apply or --yes to restore this snapshot. A pre-rollback checkpoint will be created first."].join("\n"), "info"); const pre = runtime.boundary.branching.checkpoint(branchId, { metadata: { reason: "pre-rollback checkpoint", targetSnapshotId: target.id } }); const restored = runtime.boundary.branching.rollback(branchId, target.id); ctx.ui.notify(`Rollback applied for ${branchId}\npreRollbackCheckpoint=${pre.id}\nrestored=${restored.id}`, "warning"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("cognitive-verify", { description: "Schedule adapter-backed verification and record verifier evidence", handler: async (_args, ctx: any) => { if (runtime) { runtime.touched.add("."); await scheduleVerify(runtime); } ctx.ui.notify("Verification scheduled", "info"); } });
  pi.registerCommand("reasoning-plan", { description: "Create/show explicit reasoning plan artifact", handler: async (args, ctx: any) => { const adapter = requireReasoning(ctx); if (!runtime || !adapter) return; const plan = adapter.createPlan({ objective: args || runtime.prompt || "current task", steps: [], source: "command" }); adapter.persist?.(); ctx.ui.notify(formatArtifact(plan), "info"); } });
  pi.registerCommand("reasoning-artifacts", { description: "Show public reasoning artifacts", handler: async (args, ctx: any) => { const adapter = requireReasoning(ctx); if (!adapter) return; const type = args?.trim() || null; ctx.ui.notify(formatArtifacts(adapter.artifacts?.({ type, limit: 30 }) || []), "info"); } });
  pi.registerCommand("reasoning-checkpoint", { description: "Record a public reasoning checkpoint", handler: async (args, ctx: any) => { const adapter = requireReasoning(ctx); if (!adapter) return; const checkpoint = adapter.createCheckpoint({ kind: "reflection", publicSummary: args || "Manual checkpoint", artifactIds: (adapter.artifacts?.({ limit: 5 }) || []).map((a: any) => a.id) }); adapter.persist?.(); ctx.ui.notify(formatArtifact(checkpoint), "info"); } });
  pi.registerCommand("reasoning-failures", { description: "Show reasoning failure analyses", handler: async (_args, ctx: any) => { const adapter = requireReasoning(ctx); if (!adapter) return; ctx.ui.notify(formatArtifacts(adapter.artifacts?.({ type: "failure_analysis", limit: 20 }) || []), "info"); } });
  pi.registerCommand("reasoning-clear-stale", { description: "Clear stale role-architecture/runtime.arch context and memory", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const result = clearStaleReasoningState(runtime.boundary); ctx.ui.notify(`Cleared stale reasoning state: context=${result.contextRemoved.length}, memory=${result.memoryRemoved.length}`, "info"); } });
  pi.registerCommand("reasoning-clear-private-memory", { description: "Clear accidentally stored encrypted/private assistant reasoning payloads", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const removed = clearPrivateAssistantMemory(runtime.boundary); runtime.boundary.memory.persist(); ctx.ui.notify(`Cleared private assistant memory payloads: ${removed.length}`, "info"); } });
  pi.registerCommand("reasoning-prune", { description: "Prune old automatic reasoning scaffold artifacts", handler: async (args, ctx: any) => { const adapter = requireReasoning(ctx); if (!adapter) return; const max = Number(args?.trim() || 60); const result = adapter.prune?.({ maxAutoScaffold: Number.isFinite(max) ? max : 60 }) || { removed: [] }; adapter.persist?.(); ctx.ui.notify(`Pruned ${result.removed?.length || 0} automatic scaffold artifacts; remaining=${result.remaining ?? "unknown"}`, "info"); } });
  pi.registerCommand("reasoning-prune-automated", { description: "Prune old automated verifier reasoning artifacts and executor actions: /reasoning-prune-automated [--apply] [--keep=N] [--keep-actions=N]", handler: async (args, ctx: any) => { const adapter = requireReasoning(ctx); if (!runtime || !adapter) return; const raw = String(args || ""); const keep = Number(raw.match(/--keep=(\d+)/)?.[1] || REASONING_AUTO_PRUNE_AUTOMATED_KEEP); const keepActions = Number(raw.match(/--keep-actions=(\d+)/)?.[1] || REASONING_AUTO_PRUNE_ACTIONS_KEEP); const apply = /--apply|--yes/.test(raw); if (apply) snapshotReasoningState(runtime.boundary, `reasoning/snapshots/pre-automated-prune-${Date.now()}`); const result = adapter.pruneAutomatedVerification?.({ keep: Number.isFinite(keep) ? keep : REASONING_AUTO_PRUNE_AUTOMATED_KEEP, keepExecutorActions: Number.isFinite(keepActions) ? keepActions : REASONING_AUTO_PRUNE_ACTIONS_KEEP, dryRun: !apply }) || { removed: [] }; if (apply) adapter.persist?.(); ctx.ui.notify(JSON.stringify({ ...result, removed: result.removed?.length }, null, 2), apply ? "warning" : "info"); } });
  pi.registerCommand("ask", { description: "Ask a side question in a non-blocking sidecar panel without mutating parent chat", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const question = String(args || "").trim(); if (!question) return ctx.ui.notify("Usage: /ask <question about the current session>", "warning"); try { const run = startAskRun(ctx, question); ctx.ui.notify(`Ask sidecar started: ${run.id}. See the ask panel or /ask-status.`, "info"); } catch (error: any) { try { ctx.ui.notify(error?.message || String(error), "warning"); } catch {} } } });
  pi.registerCommand("ask-status", { description: "Show recent ask sidecar questions and answers", handler: async (_args, ctx: any) => { updateAskWidget(ctx); ctx.ui.notify(formatAskRuns(runtime), "info"); } });
  pi.registerCommand("ask-panel", { description: "Focus the scrollable ask sidecar panel", handler: async (_args, ctx: any) => openAskPanel(ctx, pi) });
  pi.registerCommand("ask-fork", { description: "Fork an ask sidecar Q/A into a new Pi session: /ask-fork [latest|ask_id]", handler: async (args, ctx: any) => forkAskRun(ctx, String(args || "latest").trim() || "latest") });
  pi.registerCommand("ask-clear", { description: "Clear the ask sidecar panel for this session", handler: async (_args, ctx: any) => { clearAskRuns(ctx); ctx.ui.notify("Ask sidecar cleared", "info"); } });
  pi.registerCommand("subagent-preflight", { description: "Resolve a side-effect-free subagent launch plan", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const parsed = parseSubagentCreateArgs(args); if (!parsed.task) return ctx.ui.notify("Usage: /subagent-preflight [--role name] [--merge policy] <task>", "warning"); try { const result = preflightSubagentForContext(ctx, { role: parsed.role, task: parsed.task, mergePolicy: parsed.mergePolicy }); ctx.ui.notify(JSON.stringify(result, null, 2), result.allowed ? "info" : "warning"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("subagent-fanout", { description: "Parse a reviewed Markdown plan into bounded typed subagent specs: /subagent-fanout <plan-file> [--max=N]", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const maxWorkers = Number(String(args || "").match(/--max=(\d+)/)?.[1] || 8); const planFile = String(args || "").replace(/--max=\d+/g, "").trim(); if (!planFile) return ctx.ui.notify("Usage: /subagent-fanout <plan-file> [--max=N]", "warning"); try { ctx.ui.notify(JSON.stringify(planFanoutForContext(runtime.cwd, { planFile, maxWorkers }), null, 2), "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("subagent-create", { description: "Create a branch-backed subagent", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const parsed = parseSubagentCreateArgs(args); if (!parsed.task) return ctx.ui.notify("Usage: /subagent-create [--role name] [--merge none|summary_only|full_result|proposed_patch] <task>", "warning"); try { const sub = createSubagentForContext(ctx, { role: parsed.role, task: parsed.task, mergePolicy: parsed.mergePolicy }); updateSubagentWidget(ctx, "created"); ctx.ui.notify(`Created ${sub.id} (${sub.role || "worker"}). Run with /subagent-run ${sub.id}.`, "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("subagent", { description: "Create and run a branch-backed subagent; args: [--role name] [--merge policy] [--no-run] <task>", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const parsed = parseSubagentCreateArgs(args); if (!parsed.task) return ctx.ui.notify("Usage: /subagent [--role name] [--merge none|summary_only|full_result|proposed_patch] [--no-run] <task>", "warning"); try { const sub = createSubagentForContext(ctx, { role: parsed.role, task: parsed.task, mergePolicy: parsed.mergePolicy }); updateSubagentWidget(ctx, parsed.noRun ? "created" : `running ${sub.id}`); if (parsed.noRun) return ctx.ui.notify(`Created ${sub.id}.`, "info"); const run = startSubagentCommandRun(pi, ctx, sub.id, parsed.mergePolicy); ctx.ui.notify(`Started ${sub.id} (${sub.role || "worker"}) via ${run.runner} runner. Pi remains usable; inspect with /subagent-show ${sub.id}.`, "info"); return; } catch (error: any) { try { ctx.ui.notify(error?.message || String(error), "warning"); } catch {} } } });
  pi.registerCommand("subagent-run", { description: "Run a branch-backed subagent", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const parentSessionId = getParentSessionId(ctx); const id = resolveSubagentId(String(args || "").trim(), parentSessionId); if (!id) return ctx.ui.notify("Usage: /subagent-run <subagent-id|latest>", "warning"); try { updateSubagentWidget(ctx, `running ${id}`); const run = startSubagentCommandRun(pi, ctx, id); ctx.ui.notify(`Started ${id} via ${run.runner} runner. Pi remains usable; inspect with /subagent-show ${id}.`, "info"); return; } catch (error: any) { try { ctx.ui.notify(error?.message || String(error), "warning"); } catch {} } } });
  pi.registerCommand("subagent-list", { description: "List subagents for the current parent session", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); updateSubagentWidget(ctx); const parentSessionId = getParentSessionId(ctx); const rows = runtime.boundary.subagents.listSubagents({ parentSessionId }); ctx.ui.notify(rows.length ? rows.map((s: any) => `${s.id}\t${s.status}\t${s.role || "worker"}\tbranch=${s.branchId}\tattempt=${s.attempt || 1}\ttask=${s.taskHash || "unavailable"}`).join("\n") : "No subagents", "info"); } });
  pi.registerCommand("subagent-show", { description: "Show subagent status and result", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const parentSessionId = getParentSessionId(ctx); const id = resolveSubagentId(String(args || "").trim(), parentSessionId); if (!id) return ctx.ui.notify("Usage: /subagent-show <subagent-id|latest>", "warning"); ctx.ui.notify(formatSubagent(runtime.boundary.subagents.getSubagent({ subagentId: id })), "info"); } });
  pi.registerCommand("subagent-cancel", { description: "Cancel a subagent and wait for exact process close", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const parentSessionId = getParentSessionId(ctx); const id = resolveSubagentId(String(args || "").trim(), parentSessionId); if (!id) return ctx.ui.notify("Usage: /subagent-cancel <subagent-id|latest>", "warning"); try { runtime.subagentRuns?.get(id)?.abort(); } catch {} ctx.ui.notify(formatSubagent(await runtime.boundary.subagents.cancelSubagent({ subagentId: id, reason: "user-cancel" })), "info"); } });
  pi.registerCommand("subagent-steer", { description: "Send an acknowledged bounded follow-up to an active subagent", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const [rawId, ...rest] = String(args || "").trim().split(/\s+/); const id = resolveSubagentId(rawId, getParentSessionId(ctx)); if (!id || !rest.length) return ctx.ui.notify("Usage: /subagent-steer <subagent-id|latest> <follow-up>", "warning"); const result = runtime.boundary.subagents.steerSubagent({ subagentId: id, message: rest.join(" ") }); ctx.ui.notify(JSON.stringify(result, null, 2), result.acknowledged ? "info" : "warning"); } });
  pi.registerCommand("subagent-interrupt", { description: "Interrupt an active subagent while preserving resumable lineage", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const id = resolveSubagentId(String(args || "").trim(), getParentSessionId(ctx)); if (!id) return ctx.ui.notify("Usage: /subagent-interrupt <subagent-id|latest>", "warning"); const result = runtime.boundary.subagents.interruptSubagent({ subagentId: id, reasonCode: "user-interrupt" }); ctx.ui.notify(JSON.stringify(result, null, 2), result.acknowledged ? "info" : "warning"); } });
  pi.registerCommand("subagent-wait", { description: "Wait once for a bounded subagent settlement window", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const [rawId, rawMs] = String(args || "").trim().split(/\s+/); const id = resolveSubagentId(rawId, getParentSessionId(ctx)); if (!id) return ctx.ui.notify("Usage: /subagent-wait <subagent-id|latest> [timeout-ms]", "warning"); const result = await runtime.boundary.subagents.waitSubagent({ subagentId: id, timeoutMs: rawMs ? Number(rawMs) : 30000 }); ctx.ui.notify(JSON.stringify(result, null, 2), result.timedOut ? "warning" : "info"); } });
  pi.registerCommand("subagent-continue", { description: "Create a new linked attempt from a settled subagent", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const [rawId, ...rest] = String(args || "").trim().split(/\s+/); const id = resolveSubagentId(rawId, getParentSessionId(ctx)); if (!id || !rest.length) return ctx.ui.notify("Usage: /subagent-continue <subagent-id|latest> <new-task>", "warning"); const created = runtime.boundary.subagents.continueSubagent({ subagentId: id, task: rest.join(" ") }); ctx.ui.notify(formatSubagent(created), "info"); } });
  pi.registerCommand("subagent-resume", { description: "Create a new linked attempt from an interrupted subagent", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const [rawId, ...rest] = String(args || "").trim().split(/\s+/); const id = resolveSubagentId(rawId, getParentSessionId(ctx)); if (!id || !rest.length) return ctx.ui.notify("Usage: /subagent-resume <subagent-id|latest> <new-task>", "warning"); const created = runtime.boundary.subagents.resumeSubagent({ subagentId: id, task: rest.join(" ") }); ctx.ui.notify(formatSubagent(created), "info"); } });
  pi.registerCommand("subagent-merge", { description: "Explicitly append a subagent trajectory result; this never applies filesystem changes", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const [rawId, policy = "summary_only"] = String(args || "").trim().split(/\s+/); const targetSessionId = getParentSessionId(ctx); const id = resolveSubagentId(rawId, targetSessionId); if (!id) return ctx.ui.notify("Usage: /subagent-merge <subagent-id|latest> [none|summary_only|full_result|proposed_patch]", "warning"); try { const result = runtime.boundary.subagents.mergeSubagentResult({ subagentId: id, targetSessionId, mergePolicy: policy }); appendSubagentParentEntry(pi, result); ctx.ui.notify(JSON.stringify(result.parentUpdate || { mergePolicy: result.mergePolicy, parentUpdated: false }, null, 2), "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("subagent-patch-preview", { description: "Preview a retained isolated-worktree patch with parent hash/conflict checks", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const id = resolveSubagentId(String(args || "").trim(), getParentSessionId(ctx)); if (!id) return ctx.ui.notify("Usage: /subagent-patch-preview <subagent-id|latest>", "warning"); try { const preview = runtime.boundary.subagents.previewSubagentPatch({ subagentId: id }); ctx.ui.notify(JSON.stringify(preview, null, 2), "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("subagent-patch-apply", { description: "Explicitly apply a previewed isolated-worktree patch after hash/conflict checks and git diff verification; requires --yes", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); if (!/(^|\s)--yes(\s|$)/.test(String(args || ""))) return ctx.ui.notify("Refusing patch application without --yes. Preview first with /subagent-patch-preview.", "warning"); const rawId = String(args || "").replace(/(^|\s)--yes(\s|$)/g, " ").trim(); const id = resolveSubagentId(rawId, getParentSessionId(ctx)); if (!id) return ctx.ui.notify("Usage: /subagent-patch-apply <subagent-id|latest> --yes", "warning"); try { const preview = runtime.boundary.subagents.previewSubagentPatch({ subagentId: id }); const applied = await runtime.boundary.subagents.applySubagentPatch({ subagentId: id, preview, explicit: true, verify: async ({ cwd }: any) => { const checked = await pi.exec("git", ["diff", "--check"], { cwd, timeout: 30000 }); return { status: checked.code === 0 ? "passed" : "failed", evidence: [{ command: "git diff --check", exitCode: checked.code, output: short(checked.stderr || checked.stdout || "", 2000) }] }; } }); ctx.ui.notify(JSON.stringify(applied, null, 2), "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("subagent-status", { description: "Show subagent dashboard", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); updateSubagentWidget(ctx); ctx.ui.notify(JSON.stringify(runtime.boundary.subagents.status({ parentSessionId: getParentSessionId(ctx) }), null, 2), "info"); } });
  pi.registerCommand("subagent-events", { description: "Show recent metadata-only subagent events", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const limit = Number(String(args || "").trim() || 50); const rows = runtime.boundary.subagents.events({ parentSessionId: getParentSessionId(ctx), limit: Number.isFinite(limit) ? limit : 50 }); ctx.ui.notify(rows.length ? rows.map((e: any) => `${e.sequence || 0} ${e.at} ${e.type} ${e.subagentId || ""} ${e.status || e.reasonCode || ""}`).join("\n") : "No subagent events", "info"); } });
  pi.registerCommand("subagent-export", { description: "Export subagent records/results/events", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const file = args?.trim() || join(runtime.cwd, ".pi", "subagents", `subagent-export-${Date.now()}.json`); const packet = runtime.boundary.subagents.exportSubagents({ parentSessionId: getParentSessionId(ctx), file }); ctx.ui.notify(`Exported ${packet.records?.length || 0} subagents to ${file}`, "info"); } });
  pi.registerCommand("subagent-prune", { description: "Prune final subagent records; args: [--keep=N] [--older-than=Nd] [--status=a,b]", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const parsed = parseSubagentPruneArgs(args); const result = runtime.boundary.subagents.pruneSubagents({ parentSessionId: getParentSessionId(ctx), ...parsed }); ctx.ui.notify(`Pruned ${result.pruned}; remaining=${result.remaining}`, "info"); } });
  pi.registerTool({
    name: "specialist_tasks",
    label: "Specialist tasks",
    description: "Specialist task graphs with executable acceptance: capabilities, context, preflight, run, resume, status, cancel, artifact-linked non-blocking feedback and transactional application. Tasks inherit the parent model/effort without task budgets. Apply is a separate parent action; no interactive confirmation is required. Automatic routing is unchanged.",
    executionMode: "parallel",
    parameters: Type.Object({ operation: Type.Union([Type.Literal("capabilities"), Type.Literal("context"), Type.Literal("preflight"), Type.Literal("run"), Type.Literal("resume"), Type.Literal("status"), Type.Literal("evidence"), Type.Literal("cancel"), Type.Literal("feedback"), Type.Literal("apply"), Type.Literal("metrics")]), graph: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Schema-v2 task graph object, not a JSON-encoded string. Use context for the current baseline and role revisions; graph contents are validated by preflight." })), runId: Type.Optional(Type.String({ maxLength: 80 })), taskId: Type.Optional(Type.String({ maxLength: 80 })), artifactDigest: Type.Optional(Type.String({ maxLength: 80 })), text: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })) }),
    async execute(_id: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const taskRuntime = runtime;
      if (!taskRuntime) throw new Error("Reasoning runtime is not initialized");
      const tasks = taskRuntime.boundary.tasks;
      const reply = (details: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details });
      if (params.operation === "capabilities") return reply(tasks.capabilities());
      if (params.operation === "context") return reply(tasks.planningContext());
      if (params.operation === "metrics") return reply(tasks.metrics());
      if (params.operation === "evidence") {
        const receipts = tasks.evidence({ runId: params.runId, taskId: params.taskId });
        const details = { receipts: receipts.map(({ preview, ...receipt }: any) => ({ ...receipt, ...(preview ? { preview: { digest: preview.digest, mimeType: preview.mimeType } } : {}) })) };
        return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }, ...receipts.filter((receipt: any) => receipt.preview).map((receipt: any) => ({ type: "image" as const, mimeType: receipt.preview.mimeType, data: receipt.preview.data }))], details };
      }
      const inferenceContext = () => ({ cwd: taskRuntime.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(), executionMode: "tool-rpc" });
      if (params.operation === "preflight") return reply(tasks.preflight(params.graph, tasks.enabled ? { piContext: inferenceContext() } : {}));
      if (params.operation === "status") return reply(params.runId ? tasks.status(params.runId) : tasks.metrics());
      if (params.operation === "cancel") return reply(tasks.cancel(params.runId));
      if (!tasks.enabled) return reply(tasks.capabilities());
      const executionContext = ["run", "resume"].includes(params.operation) ? inferenceContext() : undefined;
      if (executionContext) { const preflight = tasks.preflight(params.graph, { piContext: executionContext, resumeRunId: params.operation === "resume" ? params.runId : null }); if (!preflight.allowed) return reply(preflight); }
      if (params.operation === "feedback") return reply(await tasks.feedback({ runId: params.runId, taskId: params.taskId, artifactDigest: params.artifactDigest, text: params.text }));
      if (params.operation === "apply") return reply(await tasks.apply({ runId: params.runId, taskId: params.taskId, graph: params.graph, artifactDigest: params.artifactDigest, explicit: true, signal }));
      if (params.operation === "resume" && !params.runId) throw new Error("resume requires runId");
      const runId = params.runId || `taskrun_${randomUUID()}`;
      onUpdate?.(reply({ runId, status: "starting", graphId: params.graph?.graphId }));
      return reply(await tasks.run(params.graph, { runId, resume: params.operation === "resume", parentSessionId: getParentSessionId(ctx), signal, piContext: executionContext }));
    },
  });
  pi.registerTool({
    name: "create_subagent",
    label: "Subagent",
    description: "Preflight, fan out a reviewed plan, create, launch, inspect, wait, steer, interrupt, cancel, continue, resume, or merge branch-backed Pi subagents through a versioned privacy-safe lifecycle API. Role children receive the harness skill roster but run with skill discovery disabled: pass any required skill guidance in task or systemPrompt.",
    executionMode: "parallel",
    parameters: Type.Object({
      operation: Type.Optional(Type.String({ description: "Operation: preflight, fanout, create, launch, run, list, status, get, wait, steer, interrupt, cancel, continue, resume, or merge. Case, snake_case, and kebab-case variants are accepted; queue is an alias for launch, and inspect/trace are aliases for get." })),
      subagentId: Type.Optional(Type.String()),
      task: Type.Optional(Type.String()),
      planFile: Type.Optional(Type.String({ description: "Repository-confined reviewed Markdown plan file for operation=fanout." })),
      planText: Type.Optional(Type.String({ description: "Inline reviewed Markdown plan for operation=fanout." })),
      maxWorkers: Type.Optional(Type.Number({ description: "Maximum generated worker specs for fanout; hard-capped at 16." })),
      concurrency: Type.Optional(Type.Number({ description: "Fanout schedule concurrency; capped by the role runtime." })),
      message: Type.Optional(Type.String()),
      role: Type.Optional(Type.String({ description: "Registered role id. Use run_topology operation=roles to inspect available roles before delegation. Role children cannot load skill bodies; include required skill guidance in task or systemPrompt." })),
      timeoutMs: Type.Optional(Type.Number()),
      mergePolicy: Type.Optional(Type.String({ description: "How the parent receives the result: none, summary_only, full_result, or proposed_patch. manual is treated as none." })),
      systemPrompt: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
      if (!runtime) throw new Error("Reasoning runtime is not initialized");
      const operation = normalizeOperation(params.operation, { toolName: "create_subagent", defaultOperation: "create", operations: SUBAGENT_OPERATIONS, aliases: SUBAGENT_OPERATION_ALIASES });
      const mergePolicy = params.mergePolicy ? normalizeOperation(params.mergePolicy, { toolName: "create_subagent mergePolicy", defaultOperation: "none", operations: SUBAGENT_MERGE_POLICIES, aliases: SUBAGENT_MERGE_POLICY_ALIASES }) : undefined;
      const parent = getParentSessionId(ctx);
      const reply = (details: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details });
      if (operation === "preflight") { if (!params.task) throw new Error("create_subagent preflight requires task"); return reply(preflightSubagentForContext(ctx, { role: params.role, task: params.task, systemPrompt: params.systemPrompt, mergePolicy: mergePolicy || "none" })); }
      if (operation === "fanout") return reply(planFanoutForContext(runtime.cwd, params));
      if (operation === "list") return reply({ subagents: runtime.boundary.subagents.listSubagents({ parentSessionId: parent }) });
      if (operation === "status") return reply(runtime.boundary.subagents.status({ parentSessionId: parent }));
      if (operation === "create") { if (!params.task) throw new Error("create_subagent requires task for operation=create"); return reply(createSubagentForContext(ctx, { role: params.role, task: params.task, systemPrompt: params.systemPrompt, mergePolicy: mergePolicy || "none" })); }
      const created = ["launch", "run"].includes(operation) && !params.subagentId && params.task ? createSubagentForContext(ctx, { role: params.role, task: params.task, systemPrompt: params.systemPrompt, mergePolicy: mergePolicy || "none" }) : null;
      const id = created?.id || resolveSubagentId(params.subagentId || "latest", parent);
      if (!id) throw new Error(`${operation} requires subagentId or a new task`);
      if (operation === "get") return reply(runtime.boundary.subagents.getSubagent({ subagentId: id }));
      if (operation === "wait") return reply(await runtime.boundary.subagents.waitSubagent({ subagentId: id, timeoutMs: params.timeoutMs || 30000 }));
      if (operation === "steer") return reply(runtime.boundary.subagents.steerSubagent({ subagentId: id, message: params.message || params.task }));
      if (operation === "interrupt") return reply(runtime.boundary.subagents.interruptSubagent({ subagentId: id, reasonCode: "tool-interrupt" }));
      if (operation === "cancel") return reply(await runtime.boundary.subagents.cancelSubagent({ subagentId: id, reason: "tool-cancel" }));
      if (operation === "continue") { if (!params.task) throw new Error("continue requires a new task"); return reply(runtime.boundary.subagents.continueSubagent({ subagentId: id, task: params.task })); }
      if (operation === "resume") { if (!params.task) throw new Error("resume requires a new task"); return reply(runtime.boundary.subagents.resumeSubagent({ subagentId: id, task: params.task })); }
      if (operation === "merge") { const merged = runtime.boundary.subagents.mergeSubagentResult({ subagentId: id, targetSessionId: parent, mergePolicy: mergePolicy || "summary_only" }); appendSubagentParentEntry(pi, merged); return reply(merged.parentUpdate || { mergePolicy: merged.mergePolicy, parentUpdated: false }); }
      if (operation === "launch") { const launch = runtime.boundary.subagents.launchSubagent({ subagentId: id, mergePolicy, context: { cwd: runtime.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel, executionMode: "tool-rpc" } }); updateSubagentWidget(ctx, `launched ${id}`); return reply(launch); }
      if (operation === "run") {
        onUpdate?.({ content: [{ type: "text", text: `Running subagent ${id} through detached launch + bounded wait...` }], details: { subagentId: id, runner: "rpc" } });
        const result = await runtime.boundary.subagents.runSubagent({ subagentId: id, mergePolicy, context: { ctx, cwd: runtime.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel, signal, executionMode: "tool-rpc" } });
        const record = runtime.boundary.subagents.getSubagent({ subagentId: id }); appendRoleRunEntry(pi, record, result, "subagent-tool"); updateSubagentWidget(ctx, `finished ${id}`); return reply(compactRoleToolOutcome(result));
      }
      throw new Error(`Unknown subagent operation: ${operation}`);
    },
  });
  pi.registerCommand("auto-roles", { description: "Inspect or control role routing: /auto-roles off|suggest|shadow|delegate|status|route <task>|once <task>|cancel", handler: async (args, ctx: any) => {
    if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning");
    const parts = String(args || "").trim().split(/\s+/).filter(Boolean); const op = (parts.shift() || "status").toLowerCase(); const task = parts.join(" ").trim();
    try {
      if (["status", "show", ""].includes(op)) return ctx.ui.notify(formatAutoRouteStatus(runtime), "info");
      if (["off", "disable", "disabled", "0", "false", "suggest", "preview", "dry-run", "dryrun", "shadow", "delegate"].includes(op)) {
        const selected = normalizeRouterMode(op); runtime.autoRouteMode = selected.mode; persistAutoRouteMode(pi, selected.mode, "command"); updateAutoRouteWidget(ctx, selected.mode); return ctx.ui.notify([selected.warning, formatAutoRouteStatus(runtime)].filter(Boolean).join("\n"), selected.warning ? "warning" : "info");
      }
      if (["run", "execute", "full", "on", "1", "true"].includes(op)) {
        const selected = normalizeRouterMode(op); runtime.autoRouteMode = selected.mode; persistAutoRouteMode(pi, selected.mode, "legacy-command"); updateAutoRouteWidget(ctx, selected.mode); return ctx.ui.notify(`Legacy run mode maps to read-only shadow mode.\n${formatAutoRouteStatus(runtime)}`, "warning");
      }
      if (["route", "classify", "plan"].includes(op)) {
        const decision = classifyAutoRoute(task || runtime.prompt || "", runtime, { force: Boolean(task) }); runtime.autoRouteLast = decision; appendAutoRouteDecision(pi, decision); updateAutoRouteWidget(ctx, decision.matched ? `route ${autoRouteCandidate(decision)}` : "skipped"); return ctx.ui.notify(JSON.stringify(decision, null, 2), decision.matched ? "info" : "warning");
      }
      if (["once", "now"].includes(op)) {
        const decision = classifyAutoRoute(task || runtime.prompt || "", runtime, { force: true, mode: "delegate", explicitInvocation: true }); runtime.autoRouteLast = decision;
        if (!decision.matched || !decision.execute) { appendAutoRouteDecision(pi, decision); return ctx.ui.notify(JSON.stringify(decision, null, 2), "warning"); }
        const started = startAutoRouteRun(pi, ctx, decision, { force: true }); return ctx.ui.notify(started ? `Delegated ${started.routeId} using ${decision.topologyId}` : `Delegation did not start: ${runtime.autoRouteLast?.code || "blocked"} ${runtime.autoRouteLast?.skippedReason || ""}`.trim(), started ? "info" : "warning");
      }
      if (op === "cancel") { const count = cancelAutoRouteRuns(runtime); updateAutoRouteWidget(ctx, "cancelled"); return ctx.ui.notify(`Cancelled ${count} auto-role run(s)`, count ? "warning" : "info"); }
      return ctx.ui.notify("Usage: /auto-roles off|suggest|shadow|delegate|status|route <task>|once <task>|cancel", "warning");
    } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); }
  } });
  pi.registerCommand("skill-intake-validate", { description: "Validate one local pinned staged source without model execution", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); try { const checked = runtime.boundary.skillIntake.deterministicChecks(String(args || "").trim()); ctx.ui.notify(JSON.stringify({ ok: checked.passed, validationId: checked.validationId, source: checked.source, findingCount: checked.findings.length, findings: checked.findings }, null, 2), checked.passed ? "info" : "warning"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("skill-intake", { description: "Explicitly review one local pinned staged source: /skill-intake <source-id>", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const sourceId = String(args || "").trim(); if (!sourceId || /\s/.test(sourceId)) return ctx.ui.notify("Usage: /skill-intake <source-id> (stage under .pi/skill-intake/sources/<source-id>)", "warning"); try { const result = await runtime.boundary.topologies.execute(GOVERNED_SKILL_INTAKE_TOPOLOGY_ID, { task: `Review pinned staged skill source ${sourceId}`, sourceId }, { parentSessionId: getParentSessionId(ctx), piContext: { cwd: runtime.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel, executionMode: "tool-rpc" } }); appendTopologyRoleRuns(pi, result, "skill-intake-command"); ctx.ui.notify(formatTopologyRun(result), result.status === "succeeded" ? "info" : "warning"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("skill-intake-status", { description: "Show local governed skill intake status and limits", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.skillIntake.status(), null, 2), "info"); } });
  pi.registerCommand("skill-intake-list", { description: "List private governed skill candidates", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.skillIntake.listCandidates(), null, 2), "info"); } });
  pi.registerCommand("skill-intake-show", { description: "Inspect one private governed skill candidate", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const candidate = runtime.boundary.skillIntake.inspectCandidate(String(args || "").trim()); ctx.ui.notify(candidate ? JSON.stringify(candidate, null, 2) : "Candidate not found", candidate ? "info" : "warning"); } });
  pi.registerCommand("skill-intake-import", { description: "Explicitly import a reviewed private candidate into skill synthesis without approving routing/publishing", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); try { ctx.ui.notify(JSON.stringify(runtime.boundary.skillIntake.importCandidate(String(args || "").trim()), null, 2), "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("topology-recipes", { description: "List validated built-in topology recipes and installed recipe files", handler: async (_args, ctx: any) => ctx.ui.notify(JSON.stringify(recipeSummary(ctx.cwd), null, 2), "info") });
  pi.registerCommand("topology-recommend", { description: "Recommend validated topology recipes for a task", handler: async (args, ctx: any) => ctx.ui.notify(JSON.stringify(recommendRecipes(args).slice(0, 5), null, 2), "info") });
  pi.registerCommand("topology-install", { description: "Install one validated built-in topology recipe: /topology-install <recipe-id>", handler: async (args, ctx: any) => { const topologyId = String(args || "").trim(); if (!topologyId) return ctx.ui.notify("Usage: /topology-install <recipe-id>", "warning"); try { const installed = installRecipe(ctx.cwd, topologyId); if (runtime) loadTopologyConfigs(runtime); ctx.ui.notify(JSON.stringify(installed, null, 2), "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("topology-lint", { description: "Lint installed and built-in topology recipe contracts", handler: async (_args, ctx: any) => { const result = lintRecipes(ctx.cwd); ctx.ui.notify(JSON.stringify(result, null, 2), result.ok ? "info" : "warning"); } });
  pi.registerCommand("topology-upgrade", { description: "Preview built-in topology recipe upgrades", handler: async (_args, ctx: any) => ctx.ui.notify(JSON.stringify(upgradePreview(ctx.cwd), null, 2), "info") });
  pi.registerCommand("topology-list", { description: "List registered multi-agent topologies", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const rows = runtime.boundary.topologies.listTopologies(); ctx.ui.notify(rows.length ? rows.map((t: any) => `${t.topologyId}\t${t.executionMode}\tnodes=${t.nodes?.length || 0}\t${t.name || ""}`).join("\n") : "No topologies", "info"); } });
  pi.registerCommand("topology-show", { description: "Show a registered multi-agent topology", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const id = resolveTopologyId(args); ctx.ui.notify(formatTopology(runtime.boundary.topologies.listTopologies().find((t: any) => t.topologyId === id)), "info"); } });
  pi.registerCommand("topology-roles", { description: "List privacy-safe registered role descriptors", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); ctx.ui.notify(runtime.boundary.topologies.discoverRoles().map((r: any) => `${r.roleId}\t${r.displayName}\tavailable=${r.availability}\tworkspace=${r.workspacePolicy}\tmutation=${r.mutationPolicy}\ttools=${(r.toolPolicy?.allowedTools || []).join(",") || "none"}\trevision=${r.revision}`).join("\n"), "info"); } });
  pi.registerCommand("topology-role-refine", { description: "Apply an explicit reviewed narrow-only role refinement: /topology-role-refine <role> --apply <json>", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const text = String(args || "").trim(); const roleId = text.split(/\s+/)[0]; const apply = /(^|\s)--apply(\s|$)/.test(text); const json = text.replace(/^\S+\s*/, "").replace(/(^|\s)--apply(\s|$)/, " ").trim(); if (!roleId || !apply || !json) return ctx.ui.notify("Usage: /topology-role-refine <role> --apply {\"reason\":\"reviewed scope\",\"override\":{...}}", "warning"); try { const input = JSON.parse(json); const result = runtime.boundary.topologies.refineRole(roleId, input.override || {}, { reviewed: true, reason: input.reason }); ctx.ui.notify(JSON.stringify(result, null, 2), result.changed ? "warning" : "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("topology-role-history", { description: "Show metadata-only role refinement history", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); try { ctx.ui.notify(JSON.stringify(runtime.boundary.topologies.roleRefinementHistory(String(args || "").trim()), null, 2), "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("topology-role-rollback", { description: "Explicitly roll back an in-process role refinement: /topology-role-rollback <role> <revision> --apply", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const parts = String(args || "").trim().split(/\s+/); const apply = parts.includes("--apply"); const [roleId, revision] = parts.filter((part) => part !== "--apply"); if (!apply || !roleId || !revision) return ctx.ui.notify("Usage: /topology-role-rollback <role> <revision> --apply", "warning"); try { ctx.ui.notify(JSON.stringify(runtime.boundary.topologies.rollbackRoleRefinement(roleId, revision, { reviewed: true }), null, 2), "warning"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("topology-reload", { description: "Reload topology config files from PI_TOPOLOGY_CONFIG_DIRS", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const loaded = loadTopologyConfigs(runtime); ctx.ui.notify(`Loaded ${loaded.length} topology config files`, "info"); } });
  pi.registerCommand("topology-run", { description: "Run a registered multi-agent topology: /topology-run <id> [task] or --json <input>", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); try { maybeAutoPruneTopologies(runtime); const parsed = parseTopologyRunArgs(args); const id = resolveTopologyId(parsed.topologyId); if (!id) return ctx.ui.notify("Usage: /topology-run <topology-id> [task]", "warning"); if (id === GOVERNED_SKILL_INTAKE_TOPOLOGY_ID) return ctx.ui.notify("Use /skill-intake <source-id>; generic topology-run input is disabled for privacy-safe intake.", "warning"); const result = await runtime.boundary.topologies.execute(id, parsed.input, { parentSessionId: getParentSessionId(ctx), piContext: { cwd: runtime.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel, executionMode: "tool-rpc" } }); if (id !== GOVERNED_SKILL_INTAKE_TOPOLOGY_ID) { maybeCaptureTopologySkill(runtime, result);  } appendTopologyRoleRuns(pi, result, "topology-command"); ctx.ui.notify(formatTopologyRun(result), result.status === "succeeded" ? "info" : "warning"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("topology-runs", { description: "List persisted topology runs", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const rows = runtime.boundary.topologies.listRuns({ topologyId: String(args || "").trim() || undefined, limit: 50 }); ctx.ui.notify(rows.length ? rows.map((r: any) => `${r.runId}\t${r.status}\t${r.topologyId}\t${r.durationMs}ms`).join("\n") : "No topology runs", "info"); } });
  pi.registerCommand("topology-show-run", { description: "Show a persisted topology run", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const raw = String(args || "latest").trim() || "latest"; const id = raw === "latest" ? latestTopologyRunId(runtime) : raw; if (!id) return ctx.ui.notify("No topology run found", "warning"); ctx.ui.notify(formatTopologyRun(runtime.boundary.topologies.getRun(id)), "info"); } });
  pi.registerCommand("topology-export", { description: "Export a topology run: /topology-export <run-id|latest> [file]", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); try { const parsed = parseTopologyExportArgs(args); const latest = runtime.boundary.topologies.listRuns({ limit: 1 }).at(-1); const runId = parsed.runId === "latest" ? latest?.runId : parsed.runId; if (!runId) return ctx.ui.notify("No topology run to export", "warning"); const file = parsed.file || join(runtime.cwd, ".pi", "cognitive-automation", "topologies", `topology-run-${runId}.json`); runtime.boundary.topologies.exportRun({ runId, file }); ctx.ui.notify(`Exported topology run ${runId} to ${file}`, "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("topology-prune", { description: "Prune topology runs: /topology-prune [--keep=N] [--older-than=Nd] [--topology=id]", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const result = runtime.boundary.topologies.pruneRuns(parseTopologyPruneArgs(args)); ctx.ui.notify(`Pruned ${result.pruned}; remaining=${result.remaining}`, "info"); } });
  pi.registerCommand("topology-metrics", { description: "Show topology run metrics", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.topologies.metrics({ topologyId: String(args || "").trim() || undefined }), null, 2), "info"); } });
  pi.registerCommand("topology-doctor", { description: "Show multi-agent topology diagnostics", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); ctx.ui.notify(topologyDoctor(runtime), "info"); } });
  pi.registerCommand("topology-template", { description: "Write a starter topology config: /topology-template [planner-coder-verifier|reviewer-verifier-gate|parallel-evidence-synthesis] <id>", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const fs = require("node:fs"); const [kind = "planner-coder-verifier", rawId] = String(args || "").trim().split(/\s+/).filter(Boolean); const id = rawId || `custom-${kind}-${Date.now()}`; const file = join(runtime.cwd, ".pi", "topologies", `${id}.json`); fs.mkdirSync(join(runtime.cwd, ".pi", "topologies"), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify({ topologies: [topologyTemplate(kind, id)] }, null, 2)}\n`); loadTopologyConfigs(runtime); ctx.ui.notify(`Wrote topology template ${id} to ${file}`, "info"); } });
  pi.registerCommand("topology-trace", { description: "Show topology trace events", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const id = String(args || "").trim() || undefined; const rows = runtime.boundary.topologies.trace(id?.startsWith("toprun_") ? { runId: id } : { topologyId: id }); ctx.ui.notify(rows.length ? rows.slice(-80).map((e: any) => `${e.at || e.timestamp} ${e.type || e.name} ${e.nodeId || e.agent_id || ""} ${e.error || e.status || ""}`).join("\n") : "No topology trace events", "info"); } });
  pi.registerCommand("topology-replay", { description: "Replay topology trace timeline", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const id = String(args || "").trim() || undefined; const rows = runtime.boundary.topologies.replay(id?.startsWith("toprun_") ? { runId: id } : { topologyId: id }); ctx.ui.notify(rows.length ? rows.map((e: any) => `${e.index}. ${e.at || ""} ${e.type} ${e.nodeId || ""} ${e.summary || ""}`).join("\n") : "No topology replay steps", "info"); } });
  pi.registerTool({ name: "auto_role_router", label: "Auto role router", description: "Inspect, configure, classify, delegate, or cancel safe role topology routing.", parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("status"), Type.Literal("classify"), Type.Literal("setMode"), Type.Literal("run"), Type.Literal("cancel")])), mode: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("suggest"), Type.Literal("shadow"), Type.Literal("delegate"), Type.Literal("run")])), task: Type.Optional(Type.String()), input: Type.Optional(Type.Any()) }), async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) { if (!runtime) throw new Error("Reasoning runtime is not initialized"); const op = params.operation || "status"; if (op === "status") return { content: [{ type: "text", text: formatAutoRouteStatus(runtime) }], details: { mode: runtime.autoRouteMode, activeRuns: autoRouteActiveCount(runtime), last: runtime.autoRouteLast, roleRuntimeVersion: ROLE_RUNTIME_CONFIG.selectedVersion, compatibilityMode: ROLE_RUNTIME_CONFIG.compatibilityMode, mutationMode: ROLE_MUTATION_MODE, rolloutStage: ROLE_RUNTIME_CONFIG.effectiveStage, contractVersion: ROLE_CONTRACT_VERSION, resultSchemaVersion: ROLE_RESULT_SCHEMA_VERSION, containment: !ROLE_RUNTIME_V2_AVAILABLE, automaticIsolatedDelegation: ROLE_RUNTIME_V2_AVAILABLE } }; if (op === "setMode") { const selected = normalizeRouterMode(params.mode || params.input?.mode); runtime.autoRouteMode = selected.mode; persistAutoRouteMode(pi, runtime.autoRouteMode, selected.legacy ? "legacy-tool" : "tool"); updateAutoRouteWidget(ctx, runtime.autoRouteMode); return { content: [{ type: "text", text: [selected.warning, formatAutoRouteStatus(runtime)].filter(Boolean).join("\n") }], details: { mode: runtime.autoRouteMode, warning: selected.warning } }; } if (op === "classify") { const decision = classifyAutoRoute(params.task || params.input?.task || runtime.prompt || "", runtime, { force: Boolean(params.input?.force), topologyId: params.input?.topologyId }); runtime.autoRouteLast = decision; appendAutoRouteDecision(pi, decision); return { content: [{ type: "text", text: JSON.stringify(decision, null, 2) }], details: decision }; } if (op === "cancel") { const cancelled = cancelAutoRouteRuns(runtime); updateAutoRouteWidget(ctx, "cancelled"); return { content: [{ type: "text", text: `Cancelled ${cancelled} auto-role run(s)` }], details: { cancelled } }; } if (op === "run") { const decision = classifyAutoRoute(params.task || params.input?.task || runtime.prompt || "", runtime, { force: true, mode: "delegate", explicitInvocation: true, topologyId: params.input?.topologyId }); runtime.autoRouteLast = decision; if (!decision.matched || !decision.execute) return { content: [{ type: "text", text: JSON.stringify(decision, null, 2) }], details: decision }; const started = startAutoRouteRun(pi, ctx, decision, { force: true }); const result = started ? await started.promise : null; const finalDecision = runtime.autoRouteLast || decision; return { content: [{ type: "text", text: result ? formatTopologyRun(result) : JSON.stringify(finalDecision, null, 2) }], details: { decision: finalDecision, result } }; } throw new Error(`Unknown auto_role_router operation: ${op}`); } });
  pi.registerTool({ name: "run_topology", label: "Run topology", description: "Run, inspect, administer recipes, trace, or reload registered multi-agent topologies.", parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("list"), Type.Literal("show"), Type.Literal("roles"), Type.Literal("recipes"), Type.Literal("installed"), Type.Literal("recommend"), Type.Literal("install"), Type.Literal("lint"), Type.Literal("upgrade"), Type.Literal("trace"), Type.Literal("replay"), Type.Literal("runs"), Type.Literal("getRun"), Type.Literal("export"), Type.Literal("prune"), Type.Literal("metrics"), Type.Literal("doctor"), Type.Literal("template"), Type.Literal("reload")])), topologyId: Type.Optional(Type.String()), input: Type.Optional(Type.Any()), task: Type.Optional(Type.String()) }), async execute(_toolCallId: string, params: any, signal: any, _onUpdate: any, ctx: any) { if (!runtime) throw new Error("Reasoning runtime is not initialized"); const operation = params.operation || "run"; if (operation === "recipes") { const details = recipeSummary(ctx.cwd); return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }; } if (operation === "installed") { const rows = listInstalled(ctx.cwd); return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: { installed: rows } }; } if (operation === "recommend") { const rows = recommendRecipes(params.task || params.input?.task || "").slice(0, 5); return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: { recommendations: rows } }; } if (operation === "install") { if (!params.topologyId) throw new Error("run_topology operation=install requires topologyId from operation=recipes or recommend"); const details = installRecipe(ctx.cwd, params.topologyId); loadTopologyConfigs(runtime); return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }; } if (operation === "lint") { const details = lintRecipes(ctx.cwd); return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }; } if (operation === "upgrade") { const details = upgradePreview(ctx.cwd); return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }; } if (operation === "list") { const rows = runtime.boundary.topologies.listTopologies(); return { content: [{ type: "text", text: rows.map(formatTopology).join("\n\n") }], details: { topologies: rows } }; } if (operation === "roles") { const rows = runtime.boundary.topologies.discoverRoles(); return { content: [{ type: "text", text: rows.map((role: any) => `${role.roleId}\tworkspace=${role.workspacePolicy}\tmutation=${role.mutationPolicy}\tauto=${role.autoRoutePolicy}\ttools=${(role.toolPolicy?.allowedTools || []).join(",") || "none"}\trevision=${role.revision}`).join("\n") }], details: { roles: rows } }; } if (operation === "reload") { const loaded = loadTopologyConfigs(runtime); return { content: [{ type: "text", text: JSON.stringify(loaded, null, 2) }], details: { loaded } }; } if (operation === "doctor") { const doctor = topologyDoctor(runtime); return { content: [{ type: "text", text: doctor }], details: { doctor } }; } if (operation === "template") { const id = params.topologyId || `custom-template-${Date.now()}`; const t = topologyTemplate(params.task || "planner-coder-verifier", id); return { content: [{ type: "text", text: JSON.stringify(t, null, 2) }], details: t }; } if (operation === "runs") { const rows = runtime.boundary.topologies.listRuns({ topologyId: params.topologyId, limit: 50 }); return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: { runs: rows } }; } if (operation === "getRun") { const run = runtime.boundary.topologies.getRun(params.topologyId); return { content: [{ type: "text", text: JSON.stringify(run, null, 2) }], details: run }; } if (operation === "metrics") { const metrics = runtime.boundary.topologies.metrics({ topologyId: params.topologyId }); return { content: [{ type: "text", text: JSON.stringify(metrics, null, 2) }], details: metrics }; } if (operation === "prune") { const result = runtime.boundary.topologies.pruneRuns(params.input || {}); return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result }; } if (operation === "export") { const run = runtime.boundary.topologies.exportRun({ runId: params.topologyId, file: params.input?.file }); return { content: [{ type: "text", text: JSON.stringify(run, null, 2) }], details: run }; } const id = resolveTopologyId(params.topologyId || "latest"); if (!id) throw new Error("topologyId is required"); if (operation === "run" && id === GOVERNED_SKILL_INTAKE_TOPOLOGY_ID) throw new Error("governed-skill-intake is current-user command-only; use /skill-intake <source-id>"); if (operation === "show") { const topology = runtime.boundary.topologies.listTopologies().find((t: any) => t.topologyId === id); return { content: [{ type: "text", text: formatTopology(topology) }], details: topology }; } if (operation === "trace") { const rows = runtime.boundary.topologies.trace(id?.startsWith("toprun_") ? { runId: id } : { topologyId: id }); return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: { trace: rows } }; } if (operation === "replay") { const rows = runtime.boundary.topologies.replay(id?.startsWith("toprun_") ? { runId: id } : { topologyId: id }); return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: { replay: rows } }; } maybeAutoPruneTopologies(runtime); const result = await runtime.boundary.topologies.execute(id, params.input || { task: params.task || runtime.prompt || "" }, { parentSessionId: getParentSessionId(ctx), piContext: { cwd: runtime.cwd, model: ctx.model, thinkingLevel: ctx.thinkingLevel, signal, executionMode: "tool-rpc" } }); if (id !== GOVERNED_SKILL_INTAKE_TOPOLOGY_ID) { maybeCaptureTopologySkill(runtime, result);  } appendTopologyRoleRuns(pi, result, "topology-tool"); return { content: [{ type: "text", text: formatTopologyRun(result) }], details: result }; } });
  pi.registerCommand("skill-status", { description: "Show skill synthesis dashboard", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.skills.status(), null, 2), "info"); } });
  pi.registerCommand("skill-doctor", { description: "Validate skill storage integrity", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const result = runtime.boundary.skills.doctor(); ctx.ui.notify(JSON.stringify(result, null, 2), result.ok ? "info" : "warning"); } });
  pi.registerCommand("skill-review", { description: "Show skill candidates needing review", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const rows = runtime.boundary.skills.status().needsReview || []; ctx.ui.notify(rows.length ? rows.map((s: any) => `${s.skillId}\t${s.status}\tunsafe=${!!s.unsafe}\t${s.name}`).join("\n") : "No skills need review", "info"); } });
  pi.registerCommand("skill-list", { description: "List synthesized procedural skills", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); ctx.ui.notify(formatSkillList(runtime.boundary.skills.listSkills({ limit: 50 })), "info"); } });
  pi.registerCommand("skill-show", { description: "Show a synthesized skill", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const id = parseSkillId(args, runtime.boundary.skills.listSkills({ limit: 1 })); if (!id) return ctx.ui.notify("Usage: /skill-show <skill-id|latest>", "warning"); ctx.ui.notify(formatSkill(runtime.boundary.skills.getSkill(id)), "info"); } });
  pi.registerCommand("skill-suggest", { description: "Suggest relevant skills for a task", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); ctx.ui.notify(formatSkillSuggestions(runtime.boundary.skills.suggest(args || runtime.prompt || "current task", { limit: 8, includeDrafts: true })), "info"); } });
  pi.registerCommand("skill-synthesize", { description: "Synthesize skills after 3 repeats, 80% success, 2 independent runs, and verification evidence", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const result = runtime.boundary.skills.synthesize({ approve: false }); ctx.ui.notify(`Synthesized ${result.skills.length} eligible skill(s)\n${formatSkillList(result.skills)}`, "info"); } });
  pi.registerCommand("skill-draft-hermes", { description: "Explicitly ask Hermes to draft an eligible Agent Skill into private quarantine: /skill-draft-hermes <skill-id>", handler: async (args: string, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const skillId = String(args || "").trim(); if (!skillId) return ctx.ui.notify("Usage: /skill-draft-hermes <skill-id>", "warning"); const result = await runtime.boundary.skills.draftAgentSkill(skillId, { userAuthorized: true, probeAuth: true, sessionHash: ctx.sessionManager?.getSessionId?.() }); ctx.ui.notify(`Hermes Agent Skill candidate quarantined: ${result.candidateId}\nNo skill was installed or published.`, "info"); } });
  pi.registerCommand("skill-candidate-promote", { description: "Preview or explicitly promote a quarantined Agent Skill: /skill-candidate-promote <candidate-id> [--apply --yes]", handler: async (args: string, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const parts = String(args || "").trim().split(/\s+/).filter(Boolean); const candidateId = parts.find((part) => !part.startsWith("--")); if (!candidateId) return ctx.ui.notify("Usage: /skill-candidate-promote <candidate-id> [--apply --yes]", "warning"); const apply = parts.includes("--apply"); const result = runtime.boundary.skills.promoteAgentSkill(candidateId, { apply, userApproved: apply && parts.includes("--yes") }); ctx.ui.notify(JSON.stringify(result, null, 2), result.applied ? "info" : "warning"); } });
  pi.registerCommand("skill-capture-topology", { description: "Capture a topology run as skill synthesis input: /skill-capture-topology <run-id|latest>", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const latest = runtime.boundary.topologies.listRuns({ limit: 1 }).at(-1); const id = String(args || "latest").trim() === "latest" ? latest?.runId : String(args || "").trim(); if (!id) return ctx.ui.notify("No topology run found", "warning"); const run = runtime.boundary.topologies.getRun(id); const capture = runtime.boundary.skills.captureTopologyRun(run, { repository: { path: runtime.cwd } }); ctx.ui.notify(`Captured ${capture.captureId} outcome=${capture.outcome} score=${Number(capture.score || 0).toFixed(2)}`, "info"); } });
  pi.registerCommand("skill-approve", { description: "Approve one skill scope after review: /skill-approve <skill-id|latest> [advisory|routing|publishing] [approve|revoke]", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const [raw = "latest", rawScope = "advisory", decision = "approve"] = String(args || "").trim().split(/\s+/); const id = parseSkillId(raw, runtime.boundary.skills.listSkills({ limit: 1 })); if (!id) return ctx.ui.notify("Usage: /skill-approve <skill-id|latest> [advisory|routing|publishing] [approve|revoke]", "warning"); const scope = rawScope === "advisory" ? "advisoryRetrieval" : rawScope; try { ctx.ui.notify(formatSkill(runtime.boundary.skills.approve(id, { scope, decision, minConfidence: 0.65 })), "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("skill-promote", { description: "Request explicit routing approval for a locally verified skill", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const id = parseSkillId(args, runtime.boundary.skills.listSkills({ limit: 1 })); if (!id) return ctx.ui.notify("Usage: /skill-promote <skill-id|latest>", "warning"); try { ctx.ui.notify(formatSkill(runtime.boundary.skills.approve(id, { scope: "routing", minConfidence: 0.65 })), "info"); } catch (error: any) { ctx.ui.notify(error?.message || String(error), "warning"); } } });
  pi.registerCommand("skill-deprecate", { description: "Deprecate a skill: /skill-deprecate <skill-id|latest>", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const id = parseSkillId(args, runtime.boundary.skills.listSkills({ limit: 1 })); if (!id) return ctx.ui.notify("Usage: /skill-deprecate <skill-id|latest>", "warning"); ctx.ui.notify(formatSkill(runtime.boundary.skills.deprecate(id)), "warning"); } });
  pi.registerCommand("skill-evaluate", { description: "Record skill evaluation: /skill-evaluate <skill-id|latest> [ok|fail]", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const [raw = "latest", status = "ok"] = String(args || "").trim().split(/\s+/); const id = parseSkillId(raw, runtime.boundary.skills.listSkills({ limit: 1 })); if (!id) return ctx.ui.notify("Usage: /skill-evaluate <skill-id|latest> [ok|fail]", "warning"); ctx.ui.notify(formatSkill(runtime.boundary.skills.evaluate(id, { ok: status !== "fail", invoked: true, source: "manual-command" })), "info"); } });
  pi.registerCommand("skill-rollback", { description: "Rollback a skill record: /skill-rollback <skill-id|latest> <version>", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const [raw = "latest", ver = "1"] = String(args || "").trim().split(/\s+/); const id = parseSkillId(raw, runtime.boundary.skills.listSkills({ limit: 1 })); if (!id) return ctx.ui.notify("Usage: /skill-rollback <skill-id|latest> <version>", "warning"); ctx.ui.notify(formatSkill(runtime.boundary.skills.rollback(id, Number(ver || 1))), "warning"); } });
  pi.registerCommand("skill-topology-template", { description: "Render a topology template from a skill", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const id = parseSkillId(args, runtime.boundary.skills.listSkills({ limit: 1 })); if (!id) return ctx.ui.notify("Usage: /skill-topology-template <skill-id|latest>", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.skills.synthesizeTopologyTemplate(id), null, 2), "info"); } });
  pi.registerCommand("skill-topology-write", { description: "Write an approved skill-derived topology config: /skill-topology-write <skill-id|latest> [name]", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const fs = require("node:fs"); const parts = String(args || "").trim().split(/\s+/).filter(Boolean); const id = parseSkillId(parts[0] || "latest", runtime.boundary.skills.listSkills({ limit: 1 })); if (!id) return ctx.ui.notify("Usage: /skill-topology-write <skill-id|latest> [name]", "warning"); const skill = runtime.boundary.skills.getSkill(id); if (skill?.approvals?.routing !== "approved") return ctx.ui.notify("Refusing to write executable topology without exact skill-version routing approval; run /skill-promote after review.", "warning"); const topology = runtime.boundary.skills.synthesizeTopologyTemplate(id); if (parts[1]) topology.topologyId = parts[1]; const file = join(runtime.cwd, ".pi", "topologies", `${topology.topologyId}.json`); fs.mkdirSync(join(runtime.cwd, ".pi", "topologies"), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify({ topologies: [topology] }, null, 2)}\n`); loadTopologyConfigs(runtime); ctx.ui.notify(`Wrote skill topology ${topology.topologyId} to ${file}`, "info"); } });
  pi.registerCommand("skill-replay", { description: "Replay a captured execution: /skill-replay <capture-id>", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const id = String(args || "").trim() || runtime.boundary.skills.listCaptures({ limit: 1 })[0]?.captureId; if (!id) return ctx.ui.notify("Usage: /skill-replay <capture-id>", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.skills.replay(id), null, 2), "info"); } });
  pi.registerCommand("skill-compare", { description: "Compare two skills: /skill-compare <left> <right>", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const [left, right] = String(args || "").trim().split(/\s+/); if (!left || !right) return ctx.ui.notify("Usage: /skill-compare <left-skill-id> <right-skill-id>", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.skills.compare(left, right), null, 2), "info"); } });
  pi.registerCommand("skill-ab-test", { description: "Sandbox score a skill against a task", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const [raw = "latest", ...taskParts] = String(args || "").trim().split(/\s+/); const id = parseSkillId(raw, runtime.boundary.skills.listSkills({ limit: 1 })); if (!id) return ctx.ui.notify("Usage: /skill-ab-test <skill-id|latest> <task>", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.skills.abTest(id, taskParts.join(" ") || runtime.prompt || "current task", { score: 0.5 }), null, 2), "info"); } });
  pi.registerCommand("skill-topology-suggest", { description: "Suggest a skill-derived topology for a task", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const match = runtime.boundary.skills.suggest(args || runtime.prompt || "current task", { limit: 1 }).suggestions?.[0]; if (!match) return ctx.ui.notify("No skill-derived topology suggestion", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.skills.synthesizeTopologyTemplate(match.skillId), null, 2), "info"); } });
  pi.registerCommand("skill-export", { description: "Export skills/captures: /skill-export [file]", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const fs = require("node:fs"); const file = String(args || "").trim() || join(runtime.cwd, ".pi", "cognitive-automation", `skill-export-${Date.now()}.json`); fs.mkdirSync(require("node:path").dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(runtime.boundary.skills.exportPacket(), null, 2)}\n`); ctx.ui.notify(`Exported skills to ${file}`, "info"); } });
  pi.registerCommand("skill-import", { description: "Import skills/captures: /skill-import <file>", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const fs = require("node:fs"); const file = String(args || "").trim(); if (!file) return ctx.ui.notify("Usage: /skill-import <file>", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.skills.importPacket(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2), "info"); } });
  pi.registerCommand("skill-prune", { description: "Prune stale skill/capture records", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const keepSkills = Number(String(args || "").match(/--keep-skills=(\d+)/)?.[1] || 100); const keepCaptures = Number(String(args || "").match(/--keep-captures=(\d+)/)?.[1] || 300); try { runtime.boundary.skills.snapshot({ note: "pre-prune" }); } catch {} ctx.ui.notify(JSON.stringify(runtime.boundary.skills.prune({ keepSkills, keepCaptures }), null, 2), "info"); } });
  pi.registerCommand("skill-snapshot", { description: "Create/list skill snapshots: /skill-snapshot [note]", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const note = String(args || "").trim(); if (note === "--list") return ctx.ui.notify(JSON.stringify(runtime.boundary.skills.listSnapshots({ limit: 20 }), null, 2), "info"); ctx.ui.notify(JSON.stringify(runtime.boundary.skills.snapshot({ note: note || "manual" }), null, 2), "info"); } });
  pi.registerCommand("skill-compact", { description: "Compact duplicate skill event-log index entries", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); try { runtime.boundary.skills.snapshot({ note: "pre-compact" }); } catch {} ctx.ui.notify(JSON.stringify(runtime.boundary.skills.compactEvents(), null, 2), "info"); } });
  pi.registerCommand("skill-restore", { description: "Restore a skill snapshot: /skill-restore <snapshot-id>", handler: async (args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); const id = String(args || "").trim(); if (!id) return ctx.ui.notify("Usage: /skill-restore <snapshot-id>", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.skills.restoreSnapshot(id), null, 2), "warning"); } });
  pi.registerCommand("skill-metrics", { description: "Show skill synthesis metrics", handler: async (_args, ctx: any) => { if (!runtime) return ctx.ui.notify("Reasoning runtime is not initialized", "warning"); ctx.ui.notify(JSON.stringify(runtime.boundary.skills.metrics(), null, 2), "info"); } });
  pi.registerTool({ name: "skill_synthesis", label: "Skill synthesis", description: "Capture executions, synthesize, retrieve, evaluate, approve, rollback, or render topology templates for procedural skills.", parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("status"), Type.Literal("doctor"), Type.Literal("review"), Type.Literal("show"), Type.Literal("suggest"), Type.Literal("synthesize"), Type.Literal("captureTopology"), Type.Literal("evaluate"), Type.Literal("approve"), Type.Literal("deprecate"), Type.Literal("rollback"), Type.Literal("prune"), Type.Literal("topologyTemplate"), Type.Literal("replay"), Type.Literal("compare"), Type.Literal("abTest"), Type.Literal("registerProvider"), Type.Literal("export"), Type.Literal("import"), Type.Literal("topologySuggest"), Type.Literal("topologyWrite"), Type.Literal("snapshot"), Type.Literal("restore"), Type.Literal("compact"), Type.Literal("metrics")])), skillId: Type.Optional(Type.String()), task: Type.Optional(Type.String()), input: Type.Optional(Type.Any()) }), async execute(_toolCallId: string, params: any) { if (!runtime) throw new Error("Reasoning runtime is not initialized"); const op = params.operation || "suggest"; const governedMutations = new Set(["approve", "registerProvider", "import", "topologyWrite"]); if (governedMutations.has(op) && !runtime.skillMutationAuthorized) return skillMutationBlocked(op); if (op === "approve" && params.input?.scope === "publishing") return { content: [{ type: "text", text: "Publishing approval is command/human-only; use /skill-approve after exact-version field review." }], details: { ok: false, outcome: "blocked", reasonCode: "publishing-approval-command-only" } }; if (op === "list") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.listSkills({ limit: 50 }), null, 2) }], details: undefined }; if (op === "status") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.status(), null, 2) }], details: undefined }; if (op === "doctor") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.doctor(), null, 2) }], details: undefined }; if (op === "review") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.status().needsReview || [], null, 2) }], details: undefined }; if (op === "metrics") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.metrics(), null, 2) }], details: undefined }; if (op === "snapshot") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.snapshot(params.input || { note: "tool" }), null, 2) }], details: undefined }; if (op === "compact") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.compactEvents(), null, 2) }], details: undefined }; if (op === "restore") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.restoreSnapshot(params.input?.snapshotId || params.skillId), null, 2) }], details: undefined }; if (op === "registerProvider") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.registerProvider(params.input || {}), null, 2) }], details: undefined }; if (op === "export") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.exportPacket(), null, 2) }], details: undefined }; if (op === "import") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.importPacket(params.input || {}), null, 2) }], details: undefined }; if (op === "suggest") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.suggest(params.task || runtime.prompt || "current task", params.input || {}), null, 2) }], details: undefined }; if (op === "synthesize") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.synthesize({ ...(params.input || {}), minRepeats: Math.max(3, Number(params.input?.minRepeats || 3)), minSuccessRate: Math.max(0.8, Number(params.input?.minSuccessRate || 0.8)), minIndependentRuns: Math.max(2, Number(params.input?.minIndependentRuns || 2)) }), null, 2) }], details: undefined }; const id = params.skillId || runtime.boundary.skills.listSkills({ limit: 1 })[0]?.skillId; if (op === "show") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.getSkill(id), null, 2) }], details: undefined }; if (op === "captureTopology") { const runId = params.input?.runId || runtime.boundary.topologies.listRuns({ limit: 1 }).at(-1)?.runId; return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.captureTopologyRun(runtime.boundary.topologies.getRun(runId), { repository: { path: runtime.cwd } }), null, 2) }], details: undefined }; } if (op === "evaluate") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.evaluate(id, { ...(params.input || { ok: true }), invoked: true, source: params.input?.source || "skill_synthesis-tool" }), null, 2) }], details: undefined }; if (op === "approve") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.approve(id, { scope: "advisoryRetrieval", minConfidence: 0.65, ...(params.input || {}) }), null, 2) }], details: undefined }; if (op === "deprecate") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.deprecate(id), null, 2) }], details: undefined }; if (op === "prune") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.prune(params.input || {}), null, 2) }], details: undefined }; if (op === "rollback") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.rollback(id, Number(params.input?.version || 1)), null, 2) }], details: undefined }; if (op === "topologyTemplate") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.synthesizeTopologyTemplate(id), null, 2) }], details: undefined }; if (op === "topologyWrite") { const fs = require("node:fs"); const skill = runtime.boundary.skills.getSkill(id); if (skill?.approvals?.routing !== "approved") throw new Error("Refusing to write executable topology without exact-version routing approval"); const topology = runtime.boundary.skills.synthesizeTopologyTemplate(id); const file = join(runtime.cwd, ".pi", "topologies", `${topology.topologyId}.json`); fs.mkdirSync(join(runtime.cwd, ".pi", "topologies"), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify({ topologies: [topology] }, null, 2)}\n`); loadTopologyConfigs(runtime); return { content: [{ type: "text", text: JSON.stringify({ file, topologyId: topology.topologyId }, null, 2) }], details: undefined }; } if (op === "topologySuggest") { const match = runtime.boundary.skills.suggest(params.task || runtime.prompt || "current task", { limit: 1 }).suggestions?.[0]; return { content: [{ type: "text", text: JSON.stringify(match ? runtime.boundary.skills.synthesizeTopologyTemplate(match.skillId) : null, null, 2) }], details: undefined }; } if (op === "replay") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.replay(params.input?.captureId || id), null, 2) }], details: undefined }; if (op === "compare") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.compare(id, params.input?.rightSkillId), null, 2) }], details: undefined }; if (op === "abTest") return { content: [{ type: "text", text: JSON.stringify(runtime.boundary.skills.abTest(id, params.task || runtime.prompt || "current task", params.input || { score: 0.5 }), null, 2) }], details: undefined }; throw new Error(`Unknown skill_synthesis operation: ${op}`); } });
  pi.registerCommand("reasoning-debug-context", { description: "Show sources for reasoning runtime injected context", handler: async (args, ctx: any) => ctx.ui.notify(debugContext(args || runtime?.prompt || ""), "info") });
  pi.registerCommand("reasoning-version", { description: "Show reasoning runtime extension version and active config", handler: async (_args, ctx: any) => ctx.ui.notify(JSON.stringify(liveVersion(), null, 2), "info") });
  pi.registerCommand("reasoning-self-test", { description: "Run reasoning runtime scaffold injection self-test", handler: async (_args, ctx: any) => { const result = selfTest(); ctx.ui.notify(JSON.stringify(result, null, 2), result.ok ? "info" : "warning"); } });
  pi.registerCommand("reasoning-export", { description: "Export public reasoning artifacts without scratchpads", handler: async (_args, ctx: any) => { const adapter = requireReasoning(ctx); if (!runtime || !adapter) return; const fs = require("node:fs"); const file = join(runtime.cwd, ".pi", "cognitive-automation", `reasoning-export-${Date.now()}.json`); const packet = adapter.export?.() || { artifacts: adapter.artifacts?.() || [] }; fs.writeFileSync(file, `${JSON.stringify(packet, null, 2)}\n`); ctx.ui.notify(`Exported ${packet.artifacts?.length || 0} reasoning artifacts to ${file}`, "info"); } });
  pi.registerCommand("reasoning-replay", { description: "Replay public reasoning artifact timeline", handler: async (args, ctx: any) => { const adapter = requireReasoning(ctx); if (!adapter) return; const type = args?.trim() || null; const replay = adapter.replay?.({ type, limit: 50 }) || []; ctx.ui.notify(replay.length ? replay.map((s: any) => `${s.index}. [${s.type}] ${s.id} ${s.summary}`).join("\n") : "No reasoning replay steps", "info"); } });
}
