import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { notify } = require("../../../src/pi-extension-kit.js");
const { assertProjectScope } = require("../../../src/project-scope.js");
const { MemoryStateAdapter, ProjectMemoryAdapter, ProjectMemoryCaptureAdapter, SessionSearchAdapter, MemoryContentSafetyAdapter, RetentionAdapter, StatePermissionsAdapter, MemoryMaintenanceAdapter, ProvenanceGraphAdapter, ExecutionOutcomeAdapter, LearningLoopAdapter, SkillSynthesisAdapter, GoalEvidenceAdapter, CognitiveMemoryAdapter, MemoryJsonStorage, FileIntegrationStorage, resolveDiagnosticReview, readDiagnosticReviewRequests, projectMemoryRuntimeConfig, appendProjectMemoryDiagnostic, captureAttemptSummary } = require("../../../src/integration-boundary.js");

const EXPLORER_ENABLED = process.env.PI_MEMORY_EXPLORER !== "0";
const CURATOR_ENABLED = process.env.PI_MEMORY_CURATOR !== "0";
const CONSOLIDATE_DECISION_SAMPLE = 20;
const REVIEW_RESOLUTION_PENDING_SAMPLE = 20;
const STATE_DIR = ".pi/memory-explorer";
const CURATOR_STATE_DIR = ".pi/memory-curator";
const MAINTENANCE_INTERVAL_HOURS = Number(process.env.PI_MEMORY_MAINTENANCE_PREVIEW_INTERVAL_HOURS || 0);
const MAINTENANCE_ENABLED = process.env.PI_MEMORY_MAINTENANCE_ENABLED !== "0";
const PROVENANCE_ENABLED = process.env.PI_PROVENANCE_GRAPH_ENABLED !== "0";

function cleanQuery(args: string) { return String(args || "").replace(/--exact|--apply|--yes/g, "").trim(); }
function sessionId(ctx: any) { return String(ctx?.sessionManager?.getSessionId?.() || ctx?.sessionManager?.getSessionFile?.() || "ephemeral"); }
// A tool call may name another directory in the session project scope. Every
// memory service is keyed by project directory, so rebinding ctx.cwd makes the
// second directory's identity, .pi state, and canonical vault notes resolve
// exactly as they do for the working directory.
function scopedContext(ctx: any, params: any) {
  if (!params?.path) return ctx;
  const resolved = assertProjectScope(ctx.cwd, resolve(ctx.cwd, String(params.path)), { label: "memory" });
  return { ...ctx, cwd: resolved.root.path };
}
type CuratorMutationScope = "canonical" | "review" | "lifecycle" | "maintenance" | "retention" | "permission";
function explicitCuratorScopes(text: string) {
  const value = String(text || ""); const scopes = new Set<CuratorMutationScope>();
  if (!/\b(memory|memories|remember)\b/i.test(value)) return scopes;
  if (/\b(save|remember|promot(?:e|ion)|pin|unpin|standing)\b/i.test(value)) scopes.add("canonical");
  if (/\b(review|curat(?:e|ion)|queue|reject|correction)\b/i.test(value)) scopes.add("review");
  if (/\b(dedup(?:e|licate)|forget|expire|stale|lifecycle|clean(?:up)?|consolidat(?:e|ion))\b/i.test(value)) scopes.add("lifecycle");
  if (/\bmaintenance\b/i.test(value)) scopes.add("maintenance");
  if (/\b(retain|retention|rollback)\b/i.test(value)) scopes.add("retention");
  if (/\b(permission|harden|chmod)\b/i.test(value)) scopes.add("permission");
  return scopes;
}
function requestedMutationScope(operation: string, input: any = {}): CuratorMutationScope | null {
  if ((operation === "save" && input.apply === true) || (operation === "promoteArchitecture" && input.apply === true) || (["pin", "unpin"].includes(operation) && input.apply === true)) return "canonical";
  if ((operation === "reviewQueue" || operation === "correction" || operation === "reviewResolution") && input.apply === true) return "review";
  if (operation === "consolidate" && input.apply === true) return "lifecycle";
  if ((operation === "applyForget" || operation === "expireStale") && input.apply === true) return "lifecycle";
  if (operation === "maintenancePreview" && input.write === true) return "maintenance";
  if (operation === "retentionApply" || (operation === "retentionRollback" && input.apply === true)) return "retention";
  if (operation === "permissionApply" && input.apply === true) return "permission";
  return null;
}
function privateJson(file: string, value: any) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); chmodSync(dirname(file), 0o700); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); chmodSync(file, 0o600); return file; }
function memoryOptions(value: any) { return { limit: Number(value?.limit || 200) }; }
function publicSelection(value: any) { if (!value || typeof value !== "object") return value; const { path: _runtimeOnlyPath, ...safe } = value; return safe; }
function services(cwd: string, input: any = {}) {
  const runtime = projectMemoryRuntimeConfig(cwd, process.env, { vault: input?.vault }); const vault = runtime.adapter.vault;
  const svc: any = { memoryState: new MemoryStateAdapter({ cwd }), memorySafety: new MemoryContentSafetyAdapter(), sessionSearch: new SessionSearchAdapter({ cwd }), retention: new RetentionAdapter({ cwd }), statePermissions: new StatePermissionsAdapter({ cwd, vault }), projectMemory: new ProjectMemoryAdapter(runtime.adapter), rollout: runtime.rollout, selection: runtime.selection, readiness: runtime.readiness, canonicalProjectFolder: runtime.canonicalProjectFolder, vaultReady: runtime.adapter.enabled };
  // Hydrating the cognitive store reads every entry, so build it only when a
  // consolidation operation actually needs it instead of on every read tool.
  Object.defineProperty(svc, "cognitive", { enumerable: true, get() { return new CognitiveMemoryAdapter({ enabled: true, storage: new FileIntegrationStorage(join(cwd, ".pi", "cognitive-automation")), storageKey: "cognitive-memory" }); } });
  return svc;
}
function publicSave(result: any) { if (!result || typeof result !== "object") return result; const entry = result.entry ? { id: result.entry.id, kind: result.entry.kind, title: result.entry.title, candidateHash: result.entry.candidateHash, verification: result.entry.verification, updatedAt: result.entry.updatedAt } : undefined; return { ok: result.ok, outcome: result.outcome, reason: result.reason, applied: result.applied, revision: result.revision, conflictWith: result.conflictWith, entry, decision: result.decision }; }
function memoryMap(cwd: string, input: any = {}) { const svc = services(cwd, input); const projectMemory = svc.projectMemory.status(); const diagnosticReview = projectMemory.diagnosticReview || { rows: 0, resolved: 0, unresolved: 0, byKind: {}, oldestAt: null, newestAt: null, oldestUnresolvedAt: null, newestUnresolvedAt: null }; const actionable = Boolean(svc.rollout.controls.reviewQueueWrites || svc.rollout.controls.candidateCapture); return { state: svc.memoryState.map(memoryOptions(input)), projectMemory: { ...projectMemory, captureAttempts: captureAttemptSummary(join(cwd, ".pi", "project-memory")), diagnosticReview: { ...diagnosticReview, actionable, resolution: { available: Boolean(svc.rollout.enabled), reason: actionable ? "review-queue-authorized" : "diagnostic-resolution-only" } } }, selection: publicSelection(svc.selection), readiness: svc.readiness, rollout: svc.rollout }; }
function search(cwd: string, query: string, input: any = {}) {
  const svc = services(cwd, input); const typed = svc.memoryState.search(query, memoryOptions(input)); if (input?.exact) typed.matches = (typed.matches || []).filter((row: any) => row.phrase);
  // Manual recall is natural language, so strip task stop-words unless the
  // caller explicitly asks for raw term-coverage matching.
  const canonical = svc.projectMemory.recall(query, { limit: Number(input?.limit || 10), kinds: input?.kinds, taskConditioned: input?.taskConditioned !== false });
  return { schemaVersion: 2, query: String(query || "").trim(), mode: input?.exact ? "exact-string" : "ranked", typed, canonical, selection: publicSelection(svc.selection), readiness: svc.readiness };
}
function provenanceService(cwd: string, input: any = {}) {
  const svc = services(cwd, input);
  return new ProvenanceGraphAdapter({ enabled: PROVENANCE_ENABLED, cwd, projectMemory: svc.projectMemory, executionOutcomes: new ExecutionOutcomeAdapter({ cwd }), learning: new LearningLoopAdapter({ cwd }), skills: new SkillSynthesisAdapter({ cwd, options: { cwd, loadNative: false, loadCurated: false } }), evidence: new GoalEvidenceAdapter({ cwd }) });
}
function provenance(cwd: string, input: any = {}) { return provenanceService(cwd, input).build({ seedIds: input?.seedIds || (input?.seed ? [input.seed] : []), depth: input?.depth, maxNodes: input?.maxNodes, maxEdges: input?.maxEdges, maxElapsedMs: input?.maxElapsedMs }); }
function lineage(cwd: string, id: string, input: any = {}) { return { typed: services(cwd, input).memoryState.lineage(id), provenance: provenance(cwd, { ...input, seed: id }) }; }
function maintenancePreview(cwd: string, input: any = {}) { return new MemoryMaintenanceAdapter({ enabled: MAINTENANCE_ENABLED, cwd }).preview({ write: input?.write === true, maxCandidates: input?.maxCandidates, maxElapsedMs: input?.maxElapsedMs }); }
// Consolidation is the only path that distils episodic evidence into semantic
// invariants. It stays explicit: preview runs the same decisions against a
// throwaway copy of the hydrated store, and nothing is written unless apply is
// requested with explicit lifecycle intent.
// A consolidation pass over a large store returns thousands of decisions. The
// tool surface must stay bounded, so report per-action counts and a sample
// instead of the full decision list.
function summarizeDecisions(decisions: any[]) {
  const byAction: Record<string, number> = {};
  for (const decision of decisions) byAction[decision.action] = (byAction[decision.action] || 0) + 1;
  return { total: decisions.length, byAction, sample: decisions.slice(0, CONSOLIDATE_DECISION_SAMPLE) };
}
function consolidateMemory(cwd: string, input: any = {}) {
  const svc = services(cwd, input);
  // Consolidation rewrites the cognitive store, so apply needs both the rollout
  // kill switch and the declared cognitiveConsolidation control. Preview remains
  // available for inspection without mutation.
  if (input.apply === true && (!svc.rollout.enabled || !svc.rollout.controls.cognitiveConsolidation)) return { ok: false, outcome: "blocked", reason: "cognitive-consolidation-not-authorized-at-rollout-stage", rollout: svc.rollout };
  // `services()` exposes the cognitive adapter through a lazy getter, so hold one
  // instance: a second construction would persist an unconsolidated store.
  const cognitive = svc.cognitive;
  const memory = cognitive.memory;
  if (input.apply !== true) {
    const snapshot = { version: 1, lastConsolidatedAt: memory.lastConsolidatedAt, entries: Array.from(memory.entries.values()).map((entry: any) => entry.toJSON()), audit: memory.audit.slice(-500) };
    const cloneStorage = new MemoryJsonStorage();
    cloneStorage.writeJson("cognitive-memory", snapshot);
    const clone = new CognitiveMemoryAdapter({ enabled: true, storage: cloneStorage, storageKey: "cognitive-memory" });
    const result = clone.consolidate({ force: true });
    return { ok: true, outcome: "preview", applied: false, entries: memory.entries.size, decisions: summarizeDecisions(result.decisions), note: "Preview only; rerun with apply=true under explicit lifecycle intent to persist." };
  }
  const result = cognitive.consolidate({ force: true });
  const persisted = cognitive.persist();
  return { ok: true, outcome: "consolidated", applied: true, decisions: summarizeDecisions(result.decisions), entries: persisted.entries };
}
function reviewResolution(cwd: string, input: any = {}) {
  const svc = services(cwd, input);
  // Settling an already-recorded request is not capture, so it does not depend on
  // the diagnostics control; only the master kill switch can refuse it.
  if (!svc.rollout.enabled) return { ok: false, outcome: "blocked", reason: "project-memory-disabled", rollout: svc.rollout };
  const keys = Array.isArray(input.keys) ? input.keys : input.key ? [input.key] : [];
  const pending = readDiagnosticReviewRequests(join(cwd, ".pi", "project-memory"));
  if (!keys.length) {
    const unresolved = pending.requests.filter((row: any) => !pending.resolvedKeys.has(row.key));
    const resolvedCount = pending.requests.length - unresolved.length;
    return { ok: true, outcome: "preview", applied: false, pending: unresolved.length, resolved: resolvedCount, sample: unresolved.slice(0, REVIEW_RESOLUTION_PENDING_SAMPLE), note: "Pass keys=[...] with apply=true to record a metadata-only resolution row." };
  }
  return resolveDiagnosticReview({ cwd, keys, reason: input.reason || "explicit-curator-review", apply: input.apply === true });
}
function conflicts(cwd: string, input: any = {}) { const svc = services(cwd, input); return { typed: svc.memoryState.conflicts(), canonical: svc.vaultReady ? svc.projectMemory.decisions({ action: "review-queued", limit: 100 }) : [], source: "typed-conflict-state" }; }
function prunePreview(cwd: string, input: any = {}) { const svc = services(cwd, input); return { typed: svc.memoryState.prunePreview(memoryOptions(input)), retention: svc.retention.preview({ policies: input?.policies, protectedRefs: input?.protectedRefs }), permissions: input?.includePermissions ? svc.statePermissions.preview() : undefined, note: "All cleanup and permission changes remain preview-first and independently authorized." }; }
function plan(cwd: string, input: any = {}) { return services(cwd, input).memoryState.curationPlan(memoryOptions(input)); }
function formatPlan(value: any) { return [`Memory curation plan (typed records only)`, `Counts: ${JSON.stringify(value.counts || {})}`, `Coverage: ${value.totalRecords || 0} records; truncated=${Boolean(value.truncated)}`, ...(value.candidates || []).slice(0, 20).map((row: any) => `${row.action} ${row.recordId} (${(row.reasons || []).join("; ")})`)].join("\n"); }
function curationCheckpoint(cwd: string, operation: string, candidates: any[], apply: boolean) { const at = new Date().toISOString(); const packet = { schemaVersion: 2, operation, apply, at, candidates: candidates.map((row: any) => ({ recordId: row.recordId, type: row.type, action: row.action, contentHash: row.contentHash, reasons: row.reasons })) }; const file = join(cwd, CURATOR_STATE_DIR, `checkpoint-${Date.now()}.json`); if (apply) privateJson(file, packet); return { preview: !apply, checkpoint: apply ? file : null, packet }; }
function applyForget(cwd: string, query = "", apply = false, input: any = {}) { const candidates = (plan(cwd, input).candidates || []).filter((row: any) => ["forget-review", "dedupe-review"].includes(row.action) && (!query || row.recordId === query || row.reasons.join(" ").includes(query))); const checkpoint = curationCheckpoint(cwd, "forget-review", candidates, apply); return { apply, selected: candidates.length, records: checkpoint.packet.candidates, checkpoint: checkpoint.checkpoint, note: apply ? "A private metadata-only review checkpoint was recorded; no source record was deleted." : "Preview only; no state was written or deleted." }; }
function expire(cwd: string, _days = 30, apply = false, input: any = {}) { const candidates = (plan(cwd, input).candidates || []).filter((row: any) => row.action === "forget-review" && row.reasons.includes("expired")); const checkpoint = curationCheckpoint(cwd, "expiry-review", candidates, apply); return { apply, selected: candidates.length, records: checkpoint.packet.candidates, checkpoint: checkpoint.checkpoint, note: apply ? "A metadata-only expiry review checkpoint was recorded; cleanup remains external and preview-first." : "Preview only" }; }
function promote(cwd: string, id: string, apply = false, input: any = {}) {
  const svc = services(cwd, input); const candidate = (svc.memoryState.curationPlan({ limit: 10000 }).candidates || []).find((row: any) => row.recordId === id && row.action === "promote-review"); const entry = svc.memoryState.records().find((row: any) => String(row.id) === id);
  if (!candidate || !entry) return { ok: false, outcome: "rejected", reason: "typed-promotable-record-not-found", id };
  const preview = { id: entry.id, kind: (entry.tags || []).includes("architecture") ? "decision" : "procedure", verification: entry.verification, sourceFingerprint: `cognitive:${entry.id}` };
  if (!apply) return { ok: true, outcome: "preview", applied: false, candidate: preview, requestedApply: false, rollout: svc.rollout };
  if (!svc.vaultReady) return { ok: false, outcome: "blocked", reason: "vault-unavailable", id };
  if (!svc.rollout.controls.explicitWrites) return { ok: false, outcome: "blocked", reason: "explicit-writes-not-authorized-at-rollout-stage", rollout: svc.rollout };
  const result = svc.projectMemory.save({ kind: preview.kind, title: entry.title, content: entry.content, verification: entry.verification, sourceFingerprints: [preview.sourceFingerprint], evidenceIds: entry.evidenceIds || [], expiresAt: entry.expiresAt }, { apply: true, explicit: true });
  return { ...publicSave(result), requestedApply: true, rollout: svc.rollout };
}
function candidatePreview(input: any = {}) { const candidate = input.candidate || input; return { ok: true, outcome: "preview", applied: false, candidate: { kind: candidate.kind || null, verification: candidate.verification || null }, requestedApply: false }; }
function save(cwd: string, input: any = {}) { if (input.apply !== true) return candidatePreview(input); const svc = services(cwd, input); if (!svc.vaultReady) return { ok: false, outcome: "blocked", reason: "vault-unavailable", rollout: svc.rollout }; if (!svc.rollout.controls.explicitWrites) return { ok: false, outcome: "blocked", reason: "explicit-writes-not-authorized-at-rollout-stage", rollout: svc.rollout }; return { ...publicSave(svc.projectMemory.save(input.candidate || input, { apply: true, explicit: true, forceSupersede: Boolean(input.forceSupersede) })), rollout: svc.rollout }; }
function queueReview(cwd: string, input: any = {}) { if (input.apply !== true) return candidatePreview(input); const svc = services(cwd, input); if (!svc.vaultReady) return { ok: false, outcome: "blocked", reason: "vault-unavailable", rollout: svc.rollout }; if (!svc.rollout.controls.reviewQueueWrites) return { ok: false, outcome: "blocked", reason: "review-queue-not-authorized-at-rollout-stage", rollout: svc.rollout }; return { ...publicSave(svc.projectMemory.consider(input.candidate || input, { queueReview: true, apply: true, automatic: false })), rollout: svc.rollout }; }
function sessionSearch(cwd: string, query: string, input: any = {}, signal?: AbortSignal) { return services(cwd, input).sessionSearch.search(query, { ...input, signal }); }
function sessionAnchor(cwd: string, anchor: string, input: any = {}, signal?: AbortSignal) { return services(cwd, input).sessionSearch.get(anchor, { ...input, signal }); }
function standing(cwd: string, input: any = {}) { return services(cwd, input).projectMemory.standing({ limit: Number(input.limit || 12), maxChars: Number(input.maxChars || 1600) }); }
function setStanding(cwd: string, entryId: string, standingValue: boolean, input: any = {}) { const svc = services(cwd, input); if (input.apply !== true) return svc.projectMemory.setStanding({ entryId, standing: standingValue }, { apply: false, explicit: true }); if (!svc.vaultReady) return { ok: false, outcome: "blocked", reason: "vault-unavailable", rollout: svc.rollout }; if (!svc.rollout.controls.explicitWrites) return { ok: false, outcome: "blocked", reason: "explicit-writes-not-authorized-at-rollout-stage", rollout: svc.rollout }; return { ...svc.projectMemory.setStanding({ entryId, standing: standingValue }, { apply: true, explicit: true }), rollout: svc.rollout }; }
function correction(cwd: string, input: any = {}) { const svc = services(cwd, input); const preview = svc.projectMemory.correction({ text: input.text || input.statement || "", evidenceIds: input.evidenceIds, sourceFingerprints: input.sourceFingerprints }, { preview: true }); if (input.apply !== true || !preview.ok) return preview; if (!svc.rollout.controls.reviewQueueWrites) return { ok: false, outcome: "blocked", reason: "review-queue-not-authorized-at-rollout-stage", rollout: svc.rollout }; return svc.projectMemory.correction({ text: input.text || input.statement || "", evidenceIds: input.evidenceIds, sourceFingerprints: input.sourceFingerprints }, { preview: false, apply: true }); }

export default function memoryExplorer(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  const curatorAuthorizations = new Map<string, Set<CuratorMutationScope>>();
  let automaticSession: { key: string; capture: any } | undefined;
  function captureSession(ctx: any) {
    const key = `${ctx.cwd}:${sessionId(ctx)}`;
    if (automaticSession?.key !== key) {
      const svc = services(ctx.cwd); // Model-supplied vault/project overrides never route automatic writes.
      const diagnostic = (event: any) => appendProjectMemoryDiagnostic({ cwd: ctx.cwd, rollout: svc.rollout, event });
      automaticSession = { key, capture: new ProjectMemoryCaptureAdapter({ projectMemory: svc.projectMemory, rollout: svc.rollout, diagnostic, canonicalVault: { confirmed: svc.readiness.vaultConfirmation?.confirmed === true, projectFolderExists: svc.canonicalProjectFolder?.exists === true } }) };
    }
    return automaticSession.capture;
  }
  for (const event of ["session_start", "session_switch", "session_shutdown"]) pi.on(event as any, () => { automaticSession = undefined; });
  if (CURATOR_ENABLED) {
    pi.on("before_agent_start", (event: any, ctx: any) => {
      const guidance = captureSession(ctx).guidance();
      if (guidance && !event.systemPromptOptions.promptGuidelines.includes(guidance)) event.systemPromptOptions.promptGuidelines.push(guidance);
    });
    pi.on("message_end", (event: any, ctx: any) => {
      const message = event.message;
      if (message?.role === "assistant" && !["error", "aborted"].includes(message.stopReason)) {
        const text = Array.isArray(message.content) ? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") : "";
        captureSession(ctx).observeAssistant(text);
      }
    });
  }
  if (MAINTENANCE_ENABLED && Number.isFinite(MAINTENANCE_INTERVAL_HOURS) && MAINTENANCE_INTERVAL_HOURS > 0) pi.on("session_start" as any, async (_event: any, ctx: any) => { try { const adapter = new MemoryMaintenanceAdapter({ enabled: MAINTENANCE_ENABLED, cwd: ctx.cwd }); const schedule = adapter.due(MAINTENANCE_INTERVAL_HOURS); if (schedule.due) { const report = adapter.preview({ write: false }); notify(ctx, `Memory maintenance preview ${report.reportId}: ${report.candidateCount} candidates; no report or cleanup written.`, "info"); } } catch (error: any) { notify(ctx, `Memory maintenance preview unavailable: ${error?.code || error?.name || "error"}`, "warning"); } });
  if (CURATOR_ENABLED) pi.on("input" as any, (event: any, ctx: any) => { if (event.source !== "extension") { curatorAuthorizations.set(sessionId(ctx), explicitCuratorScopes(event.text)); captureSession(ctx).beginTurn(event.text); } return { action: "continue" }; });
  if (EXPLORER_ENABLED) {
    pi.registerCommand("memory-map", { description: "Show exact project-memory metadata map", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(memoryMap(ctx.cwd), null, 2), "info") });
    pi.registerCommand("memory-search", { description: "Rank typed and canonical memory; pass --exact for exact phrase matching", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(search(ctx.cwd, cleanQuery(args), { exact: /--exact/.test(args) }), null, 2), "info") });
    pi.registerCommand("memory-lineage", { description: "Traverse typed memory relationships and bounded cross-system provenance by record id", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(lineage(ctx.cwd, cleanQuery(args)), null, 2), "info") });
    pi.registerCommand("memory-session-search", { description: "Explicitly search bounded project-scoped historical sessions without writing content", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(sessionSearch(ctx.cwd, String(args || "").trim()), null, 2), "info") });
    pi.registerCommand("memory-session-get", { description: "Resolve one opaque session-search anchor within the same privacy limits", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(sessionAnchor(ctx.cwd, String(args || "").trim()), null, 2), "info") });
    pi.registerCommand("memory-standing", { description: "Show the bounded verified canonical standing-instruction projection", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(standing(ctx.cwd), null, 2), "info") });
    pi.registerCommand("memory-provenance", { description: "Build a bounded metadata-only provenance graph; optionally pass one seed id", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(provenance(ctx.cwd, { seed: cleanQuery(args) || undefined }), null, 2), "info") });
    pi.registerCommand("memory-provenance-export", { description: "Explicitly export a private bounded metadata-only provenance graph; optionally pass one seed id", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(provenanceService(ctx.cwd).export({ seedIds: cleanQuery(args) ? [cleanQuery(args)] : [] }, { explicit: true, fileName: `provenance-${Date.now()}.json` }), null, 2), "info") });
    pi.registerCommand("memory-maintenance-preview", { description: "Preview memory maintenance without writing a report or applying cleanup", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(new MemoryMaintenanceAdapter({ enabled: MAINTENANCE_ENABLED, cwd: ctx.cwd }).preview({ write: false }), null, 2), "info") });
    pi.registerCommand("memory-conflicts", { description: "Show typed contradiction/supersession and canonical review decisions", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(conflicts(ctx.cwd), null, 2), "info") });
    pi.registerCommand("memory-prune-preview", { description: "Preview subsystem-owned retention candidates; never deletes", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(prunePreview(ctx.cwd), null, 2), "info") });
    pi.registerCommand("memory-forget", { description: "Preview a typed forget review; no deletion", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(applyForget(ctx.cwd, cleanQuery(args), false), null, 2), "warning") });
    pi.registerCommand("memory-export-safe", { description: "Export a metadata-only project-memory map", handler: async (_args: string, ctx: any) => { const result = memoryMap(ctx.cwd); const file = join(ctx.cwd, STATE_DIR, `safe-export-${Date.now()}.json`); privateJson(file, result); notify(ctx, `Exported private metadata-only memory map`, "info"); } });
    pi.registerCommand("memory-promote", { description: "Preview typed record promotion by id", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(promote(ctx.cwd, cleanQuery(args), false), null, 2), "info") });
    pi.registerCommand("memory-demote", { description: "Preview typed record demotion by id", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(applyForget(ctx.cwd, cleanQuery(args), false), null, 2), "info") });
    pi.registerCommand("memory-durable-status", { description: "Show canonical project-memory and rollout status", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify(memoryMap(ctx.cwd).projectMemory, null, 2), "info") });
    pi.registerCommand("memory-recall", { description: "Run bounded local canonical project-memory recall", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(search(ctx.cwd, cleanQuery(args)).canonical, null, 2), "info") });
    pi.registerTool({ name: "memory_explorer", label: "Memory explorer", description: "Map and search typed/canonical memory, explicitly search bounded historical sessions, inspect standing instructions, traverse provenance, scan candidate content, and preview maintenance without mutation.", parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("map"), Type.Literal("search"), Type.Literal("sessionSearch"), Type.Literal("sessionGet"), Type.Literal("standing"), Type.Literal("scanContent"), Type.Literal("lineage"), Type.Literal("provenance"), Type.Literal("maintenancePreview"), Type.Literal("conflicts"), Type.Literal("prunePreview"), Type.Literal("exportSafe")])), query: Type.Optional(Type.String()), path: Type.Optional(Type.String({ description: "Project directory in the session scope whose memories to inspect. Defaults to the working directory." })), input: Type.Optional(Type.Any()) }), async execute(_id: string, params: any, signal: any, _update: any, ctx: any) { ctx = scopedContext(ctx, params); const op = params.operation || "map"; const input = params.input || {}; let details: any; if (op === "search") details = search(ctx.cwd, params.query || "", input); else if (op === "sessionSearch") details = sessionSearch(ctx.cwd, params.query || "", input, signal); else if (op === "sessionGet") details = sessionAnchor(ctx.cwd, params.query || input.anchor || "", input, signal); else if (op === "standing") details = standing(ctx.cwd, input); else if (op === "scanContent") details = services(ctx.cwd, input).memorySafety.scan(params.query || input.content || "", input); else if (op === "lineage") details = lineage(ctx.cwd, params.query || "", input); else if (op === "provenance") details = provenance(ctx.cwd, { ...input, seed: params.query || input.seed }); else if (op === "maintenancePreview") details = maintenancePreview(ctx.cwd, { ...input, write: false }); else if (op === "conflicts") details = conflicts(ctx.cwd, input); else if (op === "prunePreview") details = prunePreview(ctx.cwd, input); else details = memoryMap(ctx.cwd, input); return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }; } });
  }
  if (CURATOR_ENABLED) {
    pi.registerCommand("memory-review", { description: "Review typed memory lifecycle candidates", handler: async (_args: string, ctx: any) => notify(ctx, formatPlan(plan(ctx.cwd)), "info") });
    pi.registerCommand("memory-curate-plan", { description: "Write a private metadata-only typed curation plan", handler: async (_args: string, ctx: any) => { const value = plan(ctx.cwd); privateJson(join(ctx.cwd, CURATOR_STATE_DIR, "latest-plan.json"), value); notify(ctx, JSON.stringify(value, null, 2), "info"); } });
    pi.registerCommand("memory-apply-forget", { description: "Record a metadata-only forget review checkpoint: [id] [--apply]", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(applyForget(ctx.cwd, cleanQuery(args), /--apply|--yes/.test(args || "")), null, 2), "warning") });
    pi.registerCommand("memory-dedupe", { description: "Preview exact normalized typed-record duplicates", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify((plan(ctx.cwd).candidates || []).filter((row: any) => row.action === "dedupe-review"), null, 2), "info") });
    pi.registerCommand("memory-promote-architecture", { description: "Promote one typed verified record by id; add --apply for authorized explicit write", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(promote(ctx.cwd, cleanQuery(args), /--apply|--yes/.test(args || "")), null, 2), "info") });
    pi.registerCommand("memory-expire-stale", { description: "Preview or record typed expiry review; never deletes", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(expire(ctx.cwd, Number(String(args || "").match(/\d+/)?.[0] || 30), /--apply|--yes/.test(args || "")), null, 2), "info") });
    pi.registerCommand("memory-save", { description: "Use memory_curator save with a structured candidate for explicit canonical writes", handler: async (_args: string, ctx: any) => notify(ctx, "Use the governed memory_curator save operation with kind, title, content, verification, and apply=true.", "info") });
    pi.registerCommand("memory-pin", { description: "Preview or explicitly pin one eligible canonical entry: <entry-id> [--apply]", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(setStanding(ctx.cwd, cleanQuery(args), true, { apply: /--apply|--yes/.test(args || "") }), null, 2), "info") });
    pi.registerCommand("memory-unpin", { description: "Preview or explicitly unpin one canonical standing entry: <entry-id> [--apply]", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(setStanding(ctx.cwd, cleanQuery(args), false, { apply: /--apply|--yes/.test(args || "") }), null, 2), "info") });
    pi.registerCommand("memory-correction", { description: "Preview a derived reviewed-memory candidate from an explicit correction; never auto-saves", handler: async (args: string, ctx: any) => notify(ctx, JSON.stringify(correction(ctx.cwd, { text: cleanQuery(args), apply: /--apply|--yes/.test(args || "") }), null, 2), "info") });
    pi.registerTool({ name: "memory_curator", label: "Memory curator", description: "Read/preview memory. capture saves a concise durable fact only in operator-authorized automatic mode: input={candidate:{kind,title,content},source:'user'|'assistant',sourceQuote:'exact current-turn public quote'}. Capture is source-bound and unverified; no per-save consent needed in that mode. Other mutations still require matching current-user intent, rollout authority and apply/write.", parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("review"), Type.Literal("plan"), Type.Literal("maintenancePreview"), Type.Literal("applyForget"), Type.Literal("dedupe"), Type.Literal("promoteArchitecture"), Type.Literal("expireStale"), Type.Literal("save"), Type.Literal("capture"), Type.Literal("reject"), Type.Literal("reviewQueue"), Type.Literal("reviewResolution"), Type.Literal("consolidate"), Type.Literal("standing"), Type.Literal("pin"), Type.Literal("unpin"), Type.Literal("correction"), Type.Literal("status"), Type.Literal("recall"), Type.Literal("retentionPreview"), Type.Literal("retentionApply"), Type.Literal("retentionRollback"), Type.Literal("permissionPreview"), Type.Literal("permissionApply")])),  query: Type.Optional(Type.String()), path: Type.Optional(Type.String({ description: "Project directory in the session scope whose memories to curate. Defaults to the working directory." })), input: Type.Optional(Type.Any()) }), async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) { ctx = scopedContext(ctx, params);
      const op = params.operation || "plan"; const input = params.input || {}; const requiredScope = requestedMutationScope(op, input); const authorizedScopes = curatorAuthorizations.get(sessionId(ctx)) || new Set<CuratorMutationScope>();
      if (requiredScope && !authorizedScopes.has(requiredScope)) { const details = { ok: false, outcome: "blocked", reasonCode: "explicit-memory-management-intent-required", requiredScope, message: `memory_curator ${op} requires explicit current-user ${requiredScope} memory-management intent in the current turn.` }; return { content: [{ type: "text", text: details.message }], details }; }
      if (op === "capture") {
        const details = publicSave(captureSession(ctx).capture(input));
        return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
      }
      const svc = services(ctx.cwd, input); let details: any;
      if (op === "maintenancePreview") details = maintenancePreview(ctx.cwd, { ...input, write: input.write === true });
      else if (op === "applyForget") details = applyForget(ctx.cwd, params.query || "", Boolean(input.apply), input);
      else if (op === "dedupe") details = (plan(ctx.cwd, input).candidates || []).filter((row: any) => row.action === "dedupe-review");
      else if (op === "promoteArchitecture") details = promote(ctx.cwd, params.query || "", Boolean(input.apply), input);
      else if (op === "expireStale") details = expire(ctx.cwd, Number(input.days || 30), Boolean(input.apply), input);
      else if (op === "save") details = save(ctx.cwd, input);
      else if (op === "reject") details = { ok: true, outcome: "rejected", reason: input.reason || "explicit-user-reject", candidateHash: input.candidateHash || null };
      else if (op === "reviewQueue") details = queueReview(ctx.cwd, input);
      else if (op === "reviewResolution") details = reviewResolution(ctx.cwd, input);
      else if (op === "consolidate") details = consolidateMemory(ctx.cwd, input);
      else if (op === "standing") details = standing(ctx.cwd, input);
      else if (op === "pin") details = setStanding(ctx.cwd, params.query || input.entryId || "", true, input);
      else if (op === "unpin") details = setStanding(ctx.cwd, params.query || input.entryId || "", false, input);
      else if (op === "correction") details = correction(ctx.cwd, { ...input, text: input.text || params.query || "" });
      else if (op === "status") details = memoryMap(ctx.cwd, input);
      else if (op === "recall") details = search(ctx.cwd, params.query || "", input).canonical;
      else if (op === "retentionPreview") details = svc.retention.preview(input);
      else if (op === "retentionApply") details = !svc.rollout.controls.retentionApply ? { ok: false, outcome: "blocked", reason: "retention-apply-control-disabled" } : svc.retention.apply({ ...input, apply: true });
      else if (op === "retentionRollback") details = svc.retention.rollback({ ...input, apply: Boolean(input.apply) });
      else if (op === "permissionPreview") details = svc.statePermissions.preview(input);
      else if (op === "permissionApply") details = svc.statePermissions.apply({ ...input, apply: Boolean(input.apply) });
      else details = plan(ctx.cwd, input);
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    } });
  }
}
