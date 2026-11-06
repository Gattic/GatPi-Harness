import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const LIB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const {
  LearningStore,
  outcomeRater,
  minePatterns,
  mineFailurePatterns,
  proposeImprovements,
  reviewProposalWithLocalChecks,
  applyProposalDryRun,
  ingestLearningSources,
} = require(join(LIB_ROOT, "src", "learning-loop.js"));
const {
  mineAgentSessions,
  readSessionMiningReport,
  sessionMiningOutcomes,
  formatSessionMiningReport,
} = require(join(LIB_ROOT, "src", "session-miner.js"));
const { notify, instrumentExtensionCommands } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));
const { ExecutionOutcomeAdapter, LearningLoopAdapter, SkillSynthesisAdapter, MemoryMaintenanceAdapter, ProvenanceGraphAdapter, GoalEvidenceAdapter, ProjectMemoryAdapter, CompoundingEffectivenessAdapter, FileIntegrationStorage } = require(join(LIB_ROOT, "src", "integration-boundary.js"));

const ENABLED = process.env.PI_LEARNING_LOOP !== "0";
const AUTO_INGEST = process.env.PI_LEARNING_AUTO_INGEST !== "0";
const EXECUTION_OUTCOME_LEARNING = process.env.PI_EXECUTION_OUTCOME_LEARNING !== "0";
const COMPOUNDING_ENABLED = process.env.PI_COMPOUNDING_EFFECTIVENESS_ENABLED !== "0";
const AUTO_INGEST_SOURCES = (process.env.PI_LEARNING_AUTO_INGEST_SOURCES || "verification").split(",").map((s) => s.trim()).filter(Boolean);
const STATE_DIR = ".pi/learning-loop";
const EXTENSION_VERSION = "learning-loop-2026-07-25.2";
const SAFE_INGEST_SOURCES = ["verification", "topology", "skill", "trace", "evidence", "execution", "goal", "runtime", "memory", "policy", "privacy"];
const executionServices = new Map<string, { outcomes: any; learning: any }>();
const compoundingServices = new Map<string, any>();

type IngestSource = "verification" | "topology" | "skill" | "trace" | "evidence" | "execution" | "goal" | "runtime" | "memory" | "policy" | "privacy" | "all";

function writeJson(file: string, data: any) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); }
function short(text: any, n = 600) { const s = String(text || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n)}…` : s; }
function learningStore(ctx: any) { return new LearningStore({ cwd: ctx.cwd, root: join(ctx.cwd, STATE_DIR) }); }
function compoundingService(cwd: string) {
  if (!compoundingServices.has(cwd)) {
    const storage = new FileIntegrationStorage(join(cwd, ".pi", "cognitive-automation"));
    const skills = new SkillSynthesisAdapter({ cwd, storage, options: { cwd, loadNative: false, loadCurated: false } });
    const learning = new LearningLoopAdapter({ cwd, root: join(cwd, STATE_DIR) });
    const executionOutcomes = new ExecutionOutcomeAdapter({ cwd, storage: new FileIntegrationStorage(join(cwd, ".pi", "execution-outcomes")), prefix: "" });
    const maintenance = new MemoryMaintenanceAdapter({ cwd });
    const evidence = new GoalEvidenceAdapter({ cwd });
    const provenance = new ProvenanceGraphAdapter({ cwd, projectMemory: new ProjectMemoryAdapter({ enabled: false, cwd }), executionOutcomes, learning, skills, evidence });
    compoundingServices.set(cwd, new CompoundingEffectivenessAdapter({ enabled: COMPOUNDING_ENABLED, cwd, skills, learning, executionOutcomes, maintenance, provenance, storage }));
  }
  return compoundingServices.get(cwd);
}
function settledExecutionServices(cwd: string) {
  if (!executionServices.has(cwd)) executionServices.set(cwd, { outcomes: new ExecutionOutcomeAdapter({ cwd, storage: new FileIntegrationStorage(join(cwd, ".pi", "execution-outcomes")), prefix: "" }), learning: new LearningLoopAdapter({ cwd, root: join(cwd, STATE_DIR) }) });
  return executionServices.get(cwd)!;
}
async function drainSettledExecutions(cwd: string) {
  if (!EXECUTION_OUTCOME_LEARNING) return { disabled: true, processed: 0 };
  const services = settledExecutionServices(cwd);
  return services.outcomes.drain("learning-loop", (packet: any) => services.learning.captureExecutionOutcome(packet));
}
function parseFlags(args = "") {
  const raw = String(args || "");
  const flags: Record<string, string | boolean> = {};
  for (const match of raw.matchAll(/--([A-Za-z0-9_-]+)(?:=([^\s]+))?/g)) flags[match[1]] = match[2] === undefined ? true : match[2];
  const positional = raw.replace(/--[A-Za-z0-9_-]+(?:=[^\s]+)?/g, " ").trim().split(/\s+/).filter(Boolean);
  return { flags, positional, raw };
}
function ingest(ctx: any, source: IngestSource = "verification") {
  return ingestLearningSources(ctx.cwd, source, { root: join(ctx.cwd, STATE_DIR) });
}
function scanSessions(ctx: any, input: any = {}) {
  const report = mineAgentSessions({
    cwd: ctx.cwd,
    sinceDays: Number(input.sinceDays || 30),
    sinceAt: input.sinceAt,
    untilAt: input.untilAt,
    sourceVersion: input.sourceVersion,
    runtimeSourceHash: input.runtimeSourceHash,
    configVersion: input.configVersion,
    maxBytes: input.maxBytes === undefined ? undefined : Number(input.maxBytes),
    force: Boolean(input.force || input.full),
  });
  const store = learningStore(ctx);
  const recorded = input.recordOutcomes === false ? [] : sessionMiningOutcomes(report).map((outcome: any) => store.recordOutcome(outcome));
  return { report, recordedOutcomeIds: recorded.map((outcome: any) => outcome.outcomeId), duplicateOutcomes: recorded.filter((outcome: any) => outcome.duplicate).length };
}

function formatOutcome(outcome: any) { return `${outcome.outcomeId}${outcome.duplicate ? " duplicate" : ""}\t${outcome.source}\t${outcome.signals?.status}\t${(outcome.classifications || []).join(",") || "none"}\t${short(outcome.summary, 120)}`; }
function formatPattern(pattern: any) { return `${pattern.patternId}\t${pattern.kind}\t${pattern.classification}\tcount=${pattern.count}\t${short(pattern.summary, 120)}`; }
function formatProposal(proposal: any) { return `${proposal.proposalId}\t${proposal.status}\t${proposal.kind}\trisk=${proposal.risk?.level}\t${proposal.title}`; }
function reviewWithGates(ctx: any, proposal: any) {
  return reviewProposalWithLocalChecks(proposal, { cwd: ctx.cwd });
}
function applyDryRun(proposal: any) { return applyProposalDryRun(proposal); }
function createProposals(ctx: any, args = "") {
  const { flags } = parseFlags(args);
  const kind = typeof flags.kind === "string" ? flags.kind : undefined;
  const store = learningStore(ctx);
  const outcomes = store.listOutcomes({ limit: Number(flags.limit || 200) });
  const patterns = minePatterns(outcomes, { minOutcomesForPattern: Number(flags.min || 2) });
  const patternLedger = store.recordPatterns(patterns);
  const proposals = proposeImprovements(patterns, { testCommands: ["node tests/learning-loop.test.js"], changedFiles: [] }).filter((proposal: any) => !kind || proposal.kind === kind);
  const existing = new Set(store.listProposals().map((p: any) => p.proposalId));
  const created: any[] = [];
  const duplicates: any[] = [];
  for (const proposal of proposals) {
    if (existing.has(proposal.proposalId)) duplicates.push(proposal);
    else created.push(store.createProposal(proposal));
  }
  return { generatedAt: new Date().toISOString(), outcomes: outcomes.length, patterns, patternLedger, created, duplicates };
}
function exportPacket(ctx: any, file?: string) {
  const store = learningStore(ctx);
  const packet = { generatedAt: new Date().toISOString(), status: store.status(), outcomes: store.listOutcomes(), patterns: store.listPatterns(), proposals: store.listProposals(), decisions: store.decisions({ limit: 500 }) };
  const out = file || join(ctx.cwd, STATE_DIR, "exports", `learning-loop-${Date.now()}.json`);
  writeJson(out, packet);
  return { file: out, packet: { ...packet, outcomes: packet.outcomes.length, patterns: packet.patterns.length, proposals: packet.proposals.length, decisions: packet.decisions.length } };
}

export default function learningLoopCoordinator(pi: ExtensionAPI) {
  if (!ENABLED) return;
  pi = instrumentExtensionCommands(pi, { extension: "learning-loop-coordinator", version: EXTENSION_VERSION }) as ExtensionAPI;

  if (EXECUTION_OUTCOME_LEARNING) {
    pi.on("session_start", async (_event: any, ctx: any) => { try { await drainSettledExecutions(ctx.cwd); } catch { /* learning must never affect session start */ } });
    pi.on("agent_end", async (_event: any, ctx: any) => { let cwd: string; try { cwd = ctx.cwd; } catch { return; } try { await drainSettledExecutions(cwd); } catch { /* learning must never affect agent completion */ } });
  }

  if (AUTO_INGEST) {
    pi.on("agent_end", async (_event: any, ctx: any) => {
      // In headless (-p) runs the session is replaced at turn end and this
      // ctx is stale; ingestion must skip silently rather than error.
      let cwd: string;
      try { cwd = ctx.cwd; } catch { return; }
      const sources = AUTO_INGEST_SOURCES.filter((source) => SAFE_INGEST_SOURCES.includes(source));
      setTimeout(() => {
        try { for (const source of sources.length ? sources : ["verification"]) ingest({ cwd }, source as IngestSource); }
        catch { /* learning must never affect agent completion */ }
      }, 0)?.unref?.();
    });
  }

  pi.registerCommand("learning-status", { description: "Show reviewed learning-loop and compounding-scorecard status", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify({ learning: learningStore(ctx).status(), compounding: compoundingService(ctx.cwd).status() }, null, 2), "info") });
  pi.registerCommand("learning-scorecard", { description: "Generate a private metadata-only compounding scorecard: [--cohort=id] [--no-write]", handler: async (args: string, ctx: any) => { const { flags } = parseFlags(args); const result = compoundingService(ctx.cwd).generate({ write: !flags["no-write"], cohortId: typeof flags.cohort === "string" ? flags.cohort : null }); notify(ctx, JSON.stringify(result, null, 2), Object.values(result.gates || {}).some((gate: any) => gate.status === "fail") ? "warning" : "info"); } });
  pi.registerCommand("learning-scorecard-status", { description: "Show the latest compounding scorecard gate statuses without generating one", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(compoundingService(ctx.cwd).status(), null, 2), "info") });
  pi.registerCommand("learning-record-outcome", { description: "Record a redacted manual outcome; pass JSON or summary text", handler: async (args: string, ctx: any) => {
    let input: any; try { input = args?.trim()?.startsWith("{") ? JSON.parse(args) : null; } catch (error: any) { return notify(ctx, `Invalid outcome JSON: ${error.message}`, "warning"); }
    const outcome = learningStore(ctx).recordOutcome(input || { source: "manual", summary: args || "manual learning outcome", signals: { status: "unknown", evidenceLevel: "claim" }, task: { summary: args || "manual learning outcome", repo: ctx.cwd } });
    notify(ctx, formatOutcome(outcome), outcome.duplicate ? "warning" : "info");
  }});
  pi.registerCommand("learning-ingest", { description: "Ingest safe local outcome sources: verification|topology|skill|trace|evidence|execution|goal|runtime|memory|policy|privacy|all", handler: async (args: string, ctx: any) => {
    const source = (String(args || "verification").trim().split(/\s+/)[0] || "verification") as IngestSource;
    if (![...SAFE_INGEST_SOURCES, "all"].includes(source)) return notify(ctx, "Usage: /learning-ingest [verification|topology|skill|trace|evidence|execution|goal|runtime|memory|policy|privacy|all]", "warning");
    notify(ctx, JSON.stringify(ingest(ctx, source), null, 2), "info");
  }});
  pi.registerCommand("learning-scan-sessions", { description: "Incrementally mine comparable redacted session aggregates: [--since-days=N] [--since-at=ISO] [--until-at=ISO] [--full] [--no-record]", handler: async (args: string, ctx: any) => {
    const { flags } = parseFlags(args);
    try {
      const result = scanSessions(ctx, { sinceDays: flags["since-days"], sinceAt: flags["since-at"], untilAt: flags["until-at"], sourceVersion: flags["source-version"], runtimeSourceHash: flags["runtime-source-hash"], configVersion: flags["config-version"], maxBytes: flags["max-bytes"], force: flags.full || flags.force, recordOutcomes: !flags["no-record"] });
      notify(ctx, `${formatSessionMiningReport(result.report)}\n\nlearning outcomes: ${result.recordedOutcomeIds.length} (${result.duplicateOutcomes} duplicate)`, "info");
    } catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("learning-session-report", { description: "Show the latest privacy-safe cross-agent session-mining report", handler: async (_args: string, ctx: any) => notify(ctx, formatSessionMiningReport(readSessionMiningReport(ctx.cwd)), "info") });
  pi.registerCommand("learning-outcomes", { description: "List learning outcomes: [--limit=N] [--source=x] [--status=x] [--classification=x]", handler: async (args: string, ctx: any) => {
    const { flags } = parseFlags(args); const rows = learningStore(ctx).listOutcomes({ limit: Number(flags.limit || 30), source: flags.source, status: flags.status, classification: flags.classification });
    notify(ctx, rows.length ? rows.map(formatOutcome).join("\n") : "No learning outcomes", "info");
  }});
  pi.registerCommand("learning-rate-outcome", { description: "Preview outcome-rater normalization/rating; pass JSON or summary text", handler: async (args: string, ctx: any) => {
    let input: any; try { input = args?.trim()?.startsWith("{") ? JSON.parse(args) : { source: "manual", summary: args || "manual outcome preview", task: { summary: args || "manual outcome preview", repo: ctx.cwd } }; } catch (error: any) { return notify(ctx, `Invalid outcome JSON: ${error.message}`, "warning"); }
    notify(ctx, JSON.stringify(outcomeRater(input), null, 2), "info");
  }});
  pi.registerCommand("learning-patterns", { description: "List or mine persisted learning patterns: [--mine] [--failures] [--min=N]", handler: async (args: string, ctx: any) => {
    const { flags } = parseFlags(args); const store = learningStore(ctx);
    if (flags.mine || flags.failures) {
      const outcomes = store.listOutcomes({ limit: Number(flags.limit || 200) });
      const patterns = flags.failures ? mineFailurePatterns(outcomes, { minOutcomesForPattern: Number(flags.min || 2) }) : minePatterns(outcomes, { minOutcomesForPattern: Number(flags.min || 2) });
      const result = store.recordPatterns(patterns); return notify(ctx, JSON.stringify({ generatedAt: new Date().toISOString(), patterns, ...result }, null, 2), "info");
    }
    const rows = store.listPatterns({ limit: Number(flags.limit || 50), classification: flags.classification, kind: flags.kind, miner: flags.miner });
    notify(ctx, rows.length ? rows.map(formatPattern).join("\n") : "No learning patterns", "info");
  }});
  pi.registerCommand("learning-propose", { description: "Create reviewed learning proposals from stored outcomes: [--kind=skill|test|prompt|config] [--min=N]", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(createProposals(ctx, args), null, 2), "info") });
  pi.registerCommand("learning-inbox", { description: "List learning proposals: [--status=x] [--kind=x]", handler: async (args: string, ctx: any) => {
    const { flags } = parseFlags(args); const rows = learningStore(ctx).listProposals({ status: flags.status, kind: flags.kind, limit: Number(flags.limit || 50) });
    notify(ctx, rows.length ? rows.map(formatProposal).join("\n") : "No learning proposals", "info");
  }});
  pi.registerCommand("learning-show", { description: "Show a learning proposal: /learning-show <proposal-id|latest>", handler: async (args: string, ctx: any) => {
    const id = String(args || "latest").trim() || "latest"; const proposal = learningStore(ctx).getProposal(id);
    notify(ctx, proposal ? JSON.stringify(proposal, null, 2) : "No learning proposal found", proposal ? "info" : "warning");
  }});
  pi.registerCommand("learning-review", { description: "Run advisory review gates for a proposal", handler: async (args: string, ctx: any) => {
    const id = String(args || "latest").trim() || "latest"; const store = learningStore(ctx); const proposal = store.getProposal(id);
    if (!proposal) return notify(ctx, "No learning proposal found", "warning");
    const reviewed = reviewWithGates(ctx, proposal); writeJson(store.proposalFile(reviewed.proposalId), reviewed); store.recordDecision({ type: "proposal.reviewed", proposalId: reviewed.proposalId, status: reviewed.status, ready: reviewed.review?.ready }); notify(ctx, JSON.stringify(reviewed, null, 2), reviewed.review?.ready ? "info" : "warning");
  }});
  pi.registerCommand("learning-approve", { description: "Approve a ready learning proposal after review", handler: async (args: string, ctx: any) => {
    try { notify(ctx, JSON.stringify(learningStore(ctx).transitionProposal(String(args || "latest").trim() || "latest", { action: "approve", actor: "manual" }), null, 2), "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("learning-dismiss", { description: "Dismiss a learning proposal: /learning-dismiss <id|latest> [reason]", handler: async (args: string, ctx: any) => {
    const { positional } = parseFlags(args); const id = positional[0] || "latest"; const reason = positional.slice(1).join(" ") || "dismissed manually";
    try { notify(ctx, JSON.stringify(learningStore(ctx).transitionProposal(id, { action: "dismiss", reason, actor: "manual" }), null, 2), "warning"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("learning-apply", { description: "Dry-run or record a delegated apply completion: --dry-run or --record-applied [--evidence=id,id]", handler: async (args: string, ctx: any) => {
    const { positional, flags } = parseFlags(args); const store = learningStore(ctx); const id = positional[0] || "latest";
    if (flags["record-applied"] || flags.applied) {
      const evidenceRefs = typeof flags.evidence === "string" ? flags.evidence.split(",").map((x: string) => x.trim()).filter(Boolean) : undefined;
      try { return notify(ctx, JSON.stringify(store.applyProposal(id, { recordApplied: true, evidenceRefs, note: typeof flags.note === "string" ? flags.note : "delegated apply recorded" }), null, 2), "info"); }
      catch (error: any) { return notify(ctx, error.message || String(error), "warning"); }
    }
    if (!flags["dry-run"] && !flags.dryRun) return notify(ctx, "learning-apply does not mutate files. Use --dry-run for a plan or --record-applied --evidence=<id> after delegated apply+verify.", "warning");
    const proposal = store.getProposal(id); notify(ctx, proposal ? JSON.stringify(applyDryRun(proposal), null, 2) : "No learning proposal found", proposal ? "info" : "warning");
  }});
  pi.registerCommand("learning-verify", { description: "Run/capture proposal verification evidence: /learning-verify <id|latest> [--latest] [--no-run] [--timeout-ms=N]", handler: async (args: string, ctx: any) => {
    const { positional, flags } = parseFlags(args); const id = positional[0] || "latest";
    try {
      const result = learningStore(ctx).verifyProposal(id, { captureLatestVerification: Boolean(flags.latest || flags["capture-latest"]), runCommands: !flags["no-run"], timeoutMs: Number(flags["timeout-ms"] || 5 * 60_000) });
      notify(ctx, JSON.stringify(result, null, 2), result.verificationResult?.ok ? "info" : "warning");
    } catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("learning-benchmark", { description: "Plan or run the learning-loop self-benchmark: [--run]", handler: async (args: string, ctx: any) => {
    const { flags } = parseFlags(args); const result = learningStore(ctx).benchmark({ run: Boolean(flags.run), timeoutMs: Number(flags["timeout-ms"] || 5 * 60_000) });
    notify(ctx, JSON.stringify(result, null, 2), result.ran && result.ok === false ? "warning" : "info");
  }});
  pi.registerCommand("learning-context-attribution", { description: "Advisory attribution by explicit retrieval strategy/query/run IDs (legacy dimensions only when IDs are absent)", handler: async (args: string, ctx: any) => {
    const { flags } = parseFlags(args); notify(ctx, JSON.stringify(learningStore(ctx).contextAttribution({ limit: Number(flags.limit || 200) }), null, 2), "info");
  }});
  pi.registerCommand("learning-model-router", { description: "Advisory task-type model/thinking/tool routing recommendations", handler: async (args: string, ctx: any) => {
    const { flags } = parseFlags(args); notify(ctx, JSON.stringify(learningStore(ctx).modelRouter({ limit: Number(flags.limit || 200), minEvidence: Number(flags["min-evidence"] || 3), readyQuality: Number(flags["ready-quality"] || 0.7) }), null, 2), "info");
  }});
  pi.registerCommand("learning-experiment", { description: "Create an advisory branch/topology experiment plan for a proposal; add --run-benchmark to capture benchmark evidence", handler: async (args: string, ctx: any) => {
    const { positional, flags } = parseFlags(args); const id = positional[0] || "latest";
    try { notify(ctx, JSON.stringify(learningStore(ctx).createExperiment(id, { runBenchmark: Boolean(flags["run-benchmark"]), timeoutMs: Number(flags["timeout-ms"] || 5 * 60_000) }), null, 2), "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("learning-refactor-propose", { description: "Create a dry-run edit/ast_refactor proposal packet for an approved proposal", handler: async (args: string, ctx: any) => {
    const { positional, flags } = parseFlags(args); const id = positional[0] || "latest";
    try { notify(ctx, JSON.stringify(learningStore(ctx).createRefactorProposal(id, { requireApproved: !flags.preview }), null, 2), "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("learning-memory-summary", { description: "Preview a concise Hermes/Memory Curator summary candidate; persist only with --write --yes", handler: async (args: string, ctx: any) => {
    const text = String(args || ""); const write = /(^|\s)--write(\s|$)/.test(text); const confirmed = /(^|\s)--yes(\s|$)/.test(text); const id = text.replace(/(^|\s)--(?:write|yes)(?=\s|$)/g, " ").trim() || "latest";
    if (write && !confirmed) return notify(ctx, "Refusing memory-summary candidate write without --write --yes; showing no preview because write intent was incomplete.", "warning");
    try { notify(ctx, JSON.stringify(learningStore(ctx).memorySummary(id, { write }), null, 2), "info"); }
    catch (error: any) { notify(ctx, error.message || String(error), "warning"); }
  }});
  pi.registerCommand("learning-export", { description: "Export learning-loop state to JSON", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(exportPacket(ctx, String(args || "").trim() || undefined), null, 2), "info") });
  pi.registerCommand("learning-doctor", { description: "Diagnose learning-loop safety posture", handler: async (_args: string, ctx: any) => {
    const store = learningStore(ctx); const status = store.status();
    notify(ctx, JSON.stringify({ enabled: true, stateDir: join(ctx.cwd, STATE_DIR), manualOnly: !AUTO_INGEST, autoIngest: AUTO_INGEST, autoIngestSources: AUTO_INGEST_SOURCES, autoApply: false, safeSources: SAFE_INGEST_SOURCES, status }, null, 2), "info");
  }});

  pi.registerTool({ name: "learning_loop", label: "Learning loop", description: "Inspect redacted learning state and manage metadata-only outcomes/proposals. Operations that record, transition, export, or summarize state mutate private runtime files; memorySummary is preview-only unless input.write=true.", parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("status"), Type.Literal("recordOutcome"), Type.Literal("rateOutcome"), Type.Literal("ingest"), Type.Literal("sessionScan"), Type.Literal("sessionReport"), Type.Literal("outcomes"), Type.Literal("patterns"), Type.Literal("minePatterns"), Type.Literal("propose"), Type.Literal("inbox"), Type.Literal("show"), Type.Literal("review"), Type.Literal("approve"), Type.Literal("dismiss"), Type.Literal("verify"), Type.Literal("apply"), Type.Literal("applyDryRun"), Type.Literal("benchmark"), Type.Literal("contextAttribution"), Type.Literal("modelRouter"), Type.Literal("experiment"), Type.Literal("refactorPropose"), Type.Literal("memorySummary"), Type.Literal("scorecard"), Type.Literal("compoundingStatus"), Type.Literal("export"), Type.Literal("doctor")])), source: Type.Optional(Type.Union([Type.Literal("verification"), Type.Literal("topology"), Type.Literal("skill"), Type.Literal("trace"), Type.Literal("evidence"), Type.Literal("execution"), Type.Literal("goal"), Type.Literal("runtime"), Type.Literal("memory"), Type.Literal("policy"), Type.Literal("privacy"), Type.Literal("all")])), proposalId: Type.Optional(Type.String()), input: Type.Optional(Type.Any()) }), async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
    const op = params.operation || "status"; const store = learningStore(ctx);
    let details: any;
    if (op === "status" || op === "doctor") details = op === "doctor" ? { enabled: true, manualOnly: !AUTO_INGEST, autoIngest: AUTO_INGEST, autoIngestSources: AUTO_INGEST_SOURCES, autoApply: false, safeSources: SAFE_INGEST_SOURCES, status: store.status(), compounding: compoundingService(ctx.cwd).status() } : { learning: store.status(), compounding: compoundingService(ctx.cwd).status() };
    else if (op === "recordOutcome") details = store.recordOutcome(params.input || { source: "manual", summary: "manual tool outcome", signals: { status: "unknown", evidenceLevel: "claim" } });
    else if (op === "rateOutcome") details = outcomeRater(params.input || { source: "manual", summary: "manual tool outcome", signals: { status: "unknown", evidenceLevel: "claim" } });
    else if (op === "ingest") details = ingest(ctx, params.source || "verification");
    else if (op === "sessionScan") details = scanSessions(ctx, params.input || {});
    else if (op === "sessionReport") details = readSessionMiningReport(ctx.cwd);
    else if (op === "outcomes") details = store.listOutcomes(params.input || { limit: 50 });
    else if (op === "patterns") details = store.listPatterns(params.input || { limit: 50 });
    else if (op === "minePatterns") { const outcomes = store.listOutcomes(params.input || { limit: 200 }); const patterns = params.input?.failures ? mineFailurePatterns(outcomes, params.input || {}) : minePatterns(outcomes, params.input || {}); details = { patterns, ...store.recordPatterns(patterns) }; }
    else if (op === "propose") details = createProposals(ctx, params.input?.args || "");
    else if (op === "inbox") details = store.listProposals(params.input || { limit: 50 });
    else if (op === "show") details = store.getProposal(params.proposalId || "latest");
    else if (op === "review") { const p = store.getProposal(params.proposalId || "latest"); if (!p) throw new Error("proposal not found"); details = params.input?.checks ? store.reviewProposal(params.proposalId || "latest", params.input.checks) : reviewWithGates(ctx, p); if (!params.input?.checks) { writeJson(store.proposalFile(details.proposalId), details); store.recordDecision({ type: "proposal.reviewed", proposalId: details.proposalId, status: details.status, ready: details.review?.ready }); } }
    else if (op === "approve") details = store.transitionProposal(params.proposalId || "latest", { action: "approve", actor: "learning_loop tool" });
    else if (op === "dismiss") details = store.transitionProposal(params.proposalId || "latest", { action: "dismiss", reason: params.input?.reason || "dismissed by tool", actor: "learning_loop tool" });
    else if (op === "verify") details = store.verifyProposal(params.proposalId || "latest", params.input || {});
    else if (op === "apply") details = store.applyProposal(params.proposalId || "latest", params.input || {});
    else if (op === "applyDryRun") { const p = store.getProposal(params.proposalId || "latest"); if (!p) throw new Error("proposal not found"); details = applyDryRun(p); }
    else if (op === "benchmark") details = store.benchmark(params.input || {});
    else if (op === "contextAttribution") details = store.contextAttribution(params.input || { limit: 200 });
    else if (op === "modelRouter") details = store.modelRouter(params.input || { limit: 200 });
    else if (op === "experiment") details = store.createExperiment(params.proposalId || "latest", params.input || {});
    else if (op === "refactorPropose") details = store.createRefactorProposal(params.proposalId || "latest", params.input || {});
    else if (op === "memorySummary") details = store.memorySummary(params.proposalId || "latest", params.input || {});
    else if (op === "scorecard") details = compoundingService(ctx.cwd).generate({ ...(params.input || {}), write: false });
    else if (op === "compoundingStatus") details = compoundingService(ctx.cwd).status();
    else if (op === "export") details = exportPacket(ctx, params.input?.file);
    else throw new Error(`Unknown learning_loop operation: ${op}`);
    return { content: [{ type: "text", text: typeof details === "string" ? details : JSON.stringify(details, null, 2) }], details };
  }});
}
