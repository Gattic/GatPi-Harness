"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { acquireManagedWorker, processGroupAlive, processIdentity } = require("./resource-guard");
const { validateTaskGraph, digest, clone, invariant, inZone, validId } = require("./subagent-task-contracts");
const { SubagentTaskState, zero } = require("./subagent-task-state");
const { capabilityStatus, runContained, containmentProbe, confinedFile, executableFingerprint, inSystemRuntime, blenderRuntimeBinding } = require("./specialist-tools");
const { normalizePublicSubmission } = require("./role-result-schemas");
const { SubagentTopologyExecutor, AgentResult, subagentTaskFromContext } = require("./multi-agent-topologies");
const { SubagentPatchService } = require("./subagent-patches");
// Two encoded contact sheets (executable and acceptance receipts) plus metadata.
const BLENDER_RECEIPT_BYTES = 2097152;
const { repositoryFingerprint, repositoryStorageEstimate } = require("./subagent-workspaces");
const { VerifiedExecutionPipeline } = require("./verification-pipeline");
const { MAX_DIAGNOSTIC_EVIDENCE_BYTES, validateDiagnosticEvidence } = require("./diagnostic-evidence");
const { MAX_ASSET_ATTEMPTS, validatePreview, validateCritique } = require("./specialist-vision");

function baseline(cwd) {
  const value = repositoryFingerprint(cwd);
  invariant(!value.truncated, "TASK_BASELINE_FINGERPRINT_TRUNCATED");
  return { baseRevision: value.head, baselineFingerprint: digest(value) };
}
function artifactManifest(spec, attemptId, result, dependencyArtifacts = []) {
  const workspace = result.payload?.diagnostics?.workspace;
  const dossier = result.payload?.dossier;
  const disposition = result.payload?.workspaceDisposition;
  if (disposition?.status === "baseline-satisfied") {
    const paths = disposition.changedPaths || [];
    invariant(paths.length > 0 && paths.every(file => spec.writeZones.some(zone => file === zone || (zone.endsWith("/") && file.startsWith(zone)))), "TASK_BASELINE_OWNERSHIP_INVALID");
    const manifest = { schemaVersion: 1, taskId: spec.taskId, attemptId, producerSubagentId: result.provenance?.subagentId, dependencyArtifacts, kind: spec.taskKind === "asset" ? "asset" : "patch", disposition: "baseline-satisfied", baseRevision: spec.baseRevision, baselineFingerprint: spec.baselineFingerprint, contractRevision: spec.contractRevision, paths, bytes: Buffer.byteLength(JSON.stringify(disposition)), complete: true };
    return { ...manifest, digest: digest(manifest) };
  }
  if (workspace?.patchHash && workspace.patchBytes > 0) {
    const paths = workspace.changedPaths.map(entry => typeof entry === "string" ? entry : entry.path);
    invariant(paths.length > 0, "TASK_ARTIFACT_EMPTY");
    const manifest = { schemaVersion: 1, taskId: spec.taskId, attemptId, producerSubagentId: result.provenance?.subagentId, dependencyArtifacts, kind: spec.taskKind === "asset" ? "asset" : "patch", baseRevision: spec.baseRevision, baselineFingerprint: spec.baselineFingerprint, contractRevision: spec.contractRevision, patchHash: workspace.patchHash, paths, bytes: workspace.patchBytes, complete: true };
    return { ...manifest, digest: digest(manifest) };
  }
  invariant(dossier && result.validation?.status !== "invalid", "TASK_ARTIFACT_REQUIRED");
  const evidenceIds = new Set(dossier.evidenceRefs.map(e => e.id));
  invariant(evidenceIds.size === dossier.evidenceRefs.length && dossier.claims.every(c => c.evidenceIds.every(id => evidenceIds.has(id)) && c.status !== "machine-checked"), "TASK_DOSSIER_UNSUPPORTED_CLAIM");
  const diagnostics = spec.domainInput?.execution ? validateDiagnosticEvidence(result.payload?.diagnosticEvidence, { subagentId: result.provenance?.subagentId, execution: spec.domainInput.execution }) : [];
  const manifest = { schemaVersion: 1, taskId: spec.taskId, attemptId, producerSubagentId: result.provenance?.subagentId, dependencyArtifacts, kind: "dossier", baseRevision: spec.baseRevision, baselineFingerprint: spec.baselineFingerprint, contractRevision: spec.contractRevision, contentDigest: digest(dossier), diagnosticEvidenceDigest: digest(diagnostics), paths: [], bytes: Buffer.byteLength(JSON.stringify(dossier)) + Buffer.byteLength(JSON.stringify(diagnostics)), complete: true };
  return { ...manifest, digest: digest(manifest) };
}
function loadTaskPolicy(cwd, file) {
  const resolved = path.resolve(cwd, file);
  invariant(resolved === path.join(path.resolve(cwd), ".pi", "specialist-task-policy.json"), "TASK_POLICY_PATH_INVALID");
  if (!fs.existsSync(resolved)) return { verifiers: { dossier: { run: require("./specialist-verifiers").verifyDossier } } };
  const stat = fs.lstatSync(resolved);
  invariant(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(resolved) === resolved && stat.size <= 65536, "TASK_POLICY_FILE_INVALID");
  const policy = JSON.parse(fs.readFileSync(resolved, "utf8"));
  invariant(policy.schemaVersion === 2 && Object.keys(policy).every(key => ["schemaVersion", "verifiers"].includes(key)) && Array.isArray(policy.verifiers) && policy.verifiers.length <= 32, "TASK_POLICY_INVALID");
  const { verifyDossier, bezoutVerifier, glbVerifier, staticElfVerifier, blenderVerifier } = require("./specialist-verifiers");
  const verifiers = {};
  for (const definition of policy.verifiers) {
    invariant(validId(definition.id) && !Object.hasOwn(verifiers, definition.id), "TASK_POLICY_VERIFIER_INVALID");
    if (definition.type === "bezout") verifiers[definition.id] = bezoutVerifier(definition.target);
    else if (definition.type === "dossier") verifiers[definition.id] = { run: verifyDossier };
    else if (definition.type === "static-elf") verifiers[definition.id] = staticElfVerifier(definition);
    else if (definition.type === "lean") verifiers[definition.id] = require("./specialist-lean").leanVerifier(definition);
    else if (definition.type === "rea") verifiers[definition.id] = require("./specialist-rea").reaVerifier(definition);
    else if (definition.type === "blender") verifiers[definition.id] = blenderVerifier(definition);
    else if (definition.type === "glb") verifiers[definition.id] = glbVerifier(definition.path, definition.budget);
    else {
      invariant(definition.type === "command" && typeof definition.command === "string" && definition.command.length <= 1000 && Array.isArray(definition.args) && definition.args.length <= 64 && definition.args.every(arg => typeof arg === "string" && arg.length <= 2000), "TASK_POLICY_COMMAND_INVALID");
      invariant(Array.isArray(definition.protectedFiles) && definition.protectedFiles.length > 0 && definition.protectedFiles.length <= 32, "TASK_ORACLE_SOURCES_REQUIRED");
      for (const source of definition.protectedFiles) invariant(typeof source.path === "string" && /^sha256:[a-f0-9]{64}$/.test(source.digest || ""), "TASK_ORACLE_SOURCE_INVALID");
      verifiers[definition.id] = { command: definition.command, args: definition.args, protectedFiles: definition.protectedFiles, timeoutMs: 60000, maxOutputBytes: 65536 };
    }
  }
  return { verifiers };
}
function assertOracleSources(definition, cwd, spec, commandBindings, recheckCommands = true) {
  for (const command of new Set(["bwrap", ...(definition.command ? [definition.command] : [])])) {
    invariant(commandBindings[command]?.available, "TASK_CHECKER_EXECUTABLE_UNAVAILABLE");
    if (recheckCommands) invariant(digest(executableFingerprint(command)) === digest(commandBindings[command]), "TASK_CHECKER_EXECUTABLE_STALE");
  }
  if (definition.capability === "blender-asset") {
    const binding = blenderRuntimeBinding(definition.configuration.runtime, { cwd });
    invariant(binding.command === definition.command && digest(binding.fingerprint) === digest(commandBindings[definition.command]), "TASK_CHECKER_EXECUTABLE_STALE");
    if (definition.configuration.blenderAi) require("./specialist-blenderai").blenderAiBinding(definition.configuration.blenderAi, cwd);
  } else if (definition.capability === "lean-proof") {
    invariant(require("./specialist-lean").leanBinding(definition.configuration, cwd).command === definition.command, "TASK_CHECKER_EXECUTABLE_STALE");
  } else if (definition.capability === "rea-static") {
    invariant(require("./specialist-rea").reaBinding(definition.configuration, cwd).command === definition.command, "TASK_CHECKER_EXECUTABLE_STALE");
  } else if (definition.command) invariant(inSystemRuntime(commandBindings[definition.command]?.path), "TASK_CHECKER_RUNTIME_UNREVIEWED");
  for (const source of definition.protectedFiles || []) {
    invariant(!spec.writeZones.some(zone => inZone(source.path, zone)), "TASK_ORACLE_OWNERSHIP_CONFLICT");
    const file = confinedFile(cwd, source.path);
    invariant(fs.statSync(file).size <= 1048576 && digest(fs.readFileSync(file)) === source.digest, "TASK_ORACLE_SOURCE_DRIFT");
  }
}
function verifierRevision(definition) { return definition ? digest({ ...definition, run: definition.run ? String(definition.run) : null }) : null; }
function observedUsage(...diagnostics) {
  const sum = values => values.every(value => Number.isFinite(value) && value >= 0) ? values.reduce((a, b) => a + b, 0) : null;
  // SDK price calculations are retained separately; they are not provider invoices.
  return { modelCalls: sum(diagnostics.map(value => value?.callAccounting?.modelCalls ? value.modelCalls : null)), toolCalls: sum(diagnostics.map(value => value?.callAccounting?.toolCalls ? value.toolCalls : null)), tokens: sum(diagnostics.map(value => value?.tokenUsage?.totalTokens)), cost: null };
}
function phaseMeasurements(diagnostics = {}) {
  const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
  return {
    model: typeof diagnostics.effectiveModel === "string" ? diagnostics.effectiveModel : null,
    thinking: typeof diagnostics.effectiveThinkingLevel === "string" ? diagnostics.effectiveThinkingLevel : null,
    queueMs: numeric(diagnostics.queueWaitMs), startupMs: numeric(diagnostics.startupDurationMs), executionMs: numeric(diagnostics.promptDurationMs), workerWallMs: numeric(diagnostics.totalDurationMs),
    tokens: Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "totalTokens"].map(key => [key, numeric(diagnostics.tokenUsage?.[key])])),
    sdkReportedCost: numeric(diagnostics.tokenUsage?.cost?.total), sourceReads: diagnostics.sourceReads ? Object.fromEntries(["requested", "uniqueRequests", "repeatedRequests"].map(key => [key, numeric(diagnostics.sourceReads[key])])) : null,
  };
}
function compileTaskTopology(graph) {
  const planner = "task-plan";
  invariant(!graph.tasks.some(t => t.taskId === planner), "TASK_ID_RESERVED");
  return {
    topologyId: `specialist-${graph.graphId}`,
    executionMode: "dag", concurrencyLimit: graph.concurrency, failurePolicy: "continue-on-error", partialPolicy: "forbid", memoryPolicy: "none",
    nodes: [
      { id: planner, roleId: "planner", executionMode: "handler", memoryPolicy: "none", handler: () => ({ summary: "Validated explicit specialist task graph with declared dependencies and acceptance gates.", findings: [], evidence: [{ graphDigest: graph.digest }], roadmapPlan: { title: `Accepted artifact proposals for specialist graph ${graph.graphId}`, milestones: graph.tasks.map(t => ({ title: t.taskId, goals: t.requirementIds })) } }) },
      ...graph.tasks.map(t => ({ id: t.taskId, roleId: t.roleId, executionMode: "subagent", contextPolicy: "dependency-neighborhood", memoryPolicy: "none", retryPolicy: { maxRetries: 0 }, joinPolicy: { mode: "all" }, metadata: { specialistTaskId: t.taskId }, task: t.objective })),
    ],
    edges: [...graph.tasks.map(t => ({ source: planner, target: t.taskId })), ...graph.tasks.flatMap(t => t.dependsOn.map(d => ({ source: d.taskId, target: t.taskId })))],
    terminalNodes: graph.tasks.map(t => t.taskId),
    metadata: { roadmapPlanGate: { plannerNodeId: planner, beforeNodeIds: graph.tasks.map(t => t.taskId) } },
  };
}
class SubagentTaskService {
  constructor({ cwd, storage, topologies, subagents, verifiers = {}, evidenceStore, retentionBytes = 536870912, retentionRuns = 20, now = () => Date.now() }) {
    this.cwd = cwd; this.storage = storage; this.topologies = topologies; this.subagents = subagents; this.verifiers = new Map(Object.entries(verifiers)); this.evidenceStore = evidenceStore; this.now = now;
    invariant(evidenceStore?.write && evidenceStore?.read, "TASK_EVIDENCE_STORE_REQUIRED");
    this.executor = new SubagentTopologyExecutor({ service: subagents, cwd });
    invariant(Number.isSafeInteger(retentionBytes) && retentionBytes > 0 && Number.isInteger(retentionRuns) && retentionRuns > 0 && retentionRuns <= 100, "TASK_RETENTION_INVALID");
    this.retentionBytes = retentionBytes; this.retentionRuns = retentionRuns;
    this.active = new Map();
  }
  reviewRole(spec) { return this.topologies.roles.get(spec.writeZones.length ? "patch-reviewer" : "reviewer"); }
  blenderChecker(spec) {
    const checkers = spec.acceptanceCriteria.filter(c => c.required && c.kind === "executable").map(c => this.verifiers.get(c.verifierId)).filter(v => v?.capability === "blender-asset");
    return checkers.length === 1 ? checkers[0] : null;
  }
  domainChecker(spec, capability) {
    const checkers = spec.acceptanceCriteria.filter(c => c.required && c.kind === "executable").map(c => this.verifiers.get(c.verifierId)).filter(v => v?.capability === capability);
    return checkers.length === 1 ? checkers[0] : null;
  }
  producerSettings(role, spec) {
    return { ...role.settings, ...(spec.roleId === "3d-modeler" ? { blenderRuntime: this.blenderChecker(spec)?.configuration.runtime || null, blenderAi: this.blenderChecker(spec)?.configuration.blenderAi || null, domainOperations: this.blenderChecker(spec)?.configuration.blenderAi ? ["blender-script", "blenderai-dispatch"] : ["blender-script"] } : {}), ...(spec.roleId === "reverse-engineer" ? { reaConfiguration: this.domainChecker(spec, "rea-static")?.configuration || null, domainOperations: spec.domainInput?.reaOperation ? ["rea-inspect"] : ["elf-inspect"] } : {}) };
  }
  bindGraph(input) {
    const graph = validateTaskGraph(input, this.topologies.listRoles());
    const ids = [...new Set(graph.tasks.flatMap(task => task.acceptanceCriteria.filter(criterion => criterion.required && criterion.kind === "executable").map(criterion => criterion.verifierId)))].sort();
    graph.verifierBindings = Object.fromEntries(ids.map(id => [id, verifierRevision(this.verifiers.get(id))]));
    const commands = new Set(["bwrap", ...ids.map(id => this.verifiers.get(id)?.command).filter(Boolean)]);
    graph.commandBindings = Object.fromEntries([...commands].sort().map(command => [command, executableFingerprint(command)]));
    graph.digest = digest({ graph: graph.digest, verifiers: graph.verifierBindings, commands: graph.commandBindings });
    return graph;
  }
  preflight(input, { resumeRunId = null, piContext = null } = {}) {
    const graph = this.bindGraph(input);
    const reasons = [];
    if (!this.topologies.enabled) reasons.push("task-topologies-disabled");
    const containment = containmentProbe();
    if (!containment.available) reasons.push(containment.reason);
    const current = baseline(this.cwd);
    const inventory = this.storage.readJson("specialist-task-index", []);
    if (!resumeRunId && inventory.length >= this.retentionRuns) reasons.push("retained-run-limit");
    for (const spec of graph.tasks) {
      if (spec.baseRevision !== current.baseRevision || spec.baselineFingerprint !== current.baselineFingerprint) reasons.push(`${spec.taskId}:baseline-stale`);
      const role = this.topologies.roles.get(spec.roleId);
      if (spec.domainInput?.proofMode === "lean") {
        const checker = this.domainChecker(spec, "lean-proof");
        if (!checker || checker.configuration.targetDigest !== digest(spec.domainInput.leanTarget) || !spec.readZones.some(zone => inZone(spec.domainInput.leanTarget.path, zone))) reasons.push(`${spec.taskId}:pinned-formal-checker-unavailable`);
      }
      if (spec.domainInput?.proofMode === "certificate" && !spec.acceptanceCriteria.some(criterion => {
        const verifier = this.verifiers.get(criterion.verifierId);
        return criterion.required && criterion.kind === "executable" && verifier?.capability === "mathematical-certificate" && verifier.configuration?.targetDigest === digest(spec.domainInput.certificateTarget);
      })) reasons.push(`${spec.taskId}:bound-certificate-checker-unavailable`);
      if (spec.roleId === "reverse-engineer") {
        if (spec.domainInput.reaOperation) {
          const checker = this.domainChecker(spec, "rea-static");
          if (!checker || !["target", "sha256", "authorization"].every(key => checker.configuration[key] === spec.domainInput[key]) || checker.configuration.operation !== spec.domainInput.reaOperation) reasons.push(`${spec.taskId}:bound-rea-checker-unavailable`);
        } else if (!spec.acceptanceCriteria.some(c => c.required && c.kind === "executable" && this.verifiers.get(c.verifierId)?.capability === "static-elf" && this.verifiers.get(c.verifierId).configuration.target === spec.domainInput.target && this.verifiers.get(c.verifierId).configuration.sha256 === spec.domainInput.sha256)) reasons.push(`${spec.taskId}:bound-static-checker-unavailable`);
        try { const file = confinedFile(this.cwd, spec.domainInput.target); if (!spec.readZones.some(zone => inZone(spec.domainInput.target, zone)) || fs.statSync(file).size > 16777216 || digest(fs.readFileSync(file)) !== `sha256:${spec.domainInput.sha256}`) reasons.push(`${spec.taskId}:target-unavailable-or-stale`); }
        catch { reasons.push(`${spec.taskId}:target-unavailable-or-stale`); }
      }
      if (spec.roleId === "3d-modeler") {
        const checker = this.blenderChecker(spec);
        if (!checker || !["units", "axes", "maxVertices", "maxTriangles", "maxMaterials", "maxTexturePixels", "maxBones", "maxBytes"].every(key => checker.configuration.budget[key] === spec.domainInput[key]) || ![checker?.configuration.glb, checker?.configuration.native].every(file => typeof file === "string" && spec.writeZones.some(zone => inZone(file, zone)))) reasons.push(`${spec.taskId}:bound-native-asset-checker-unavailable`);
        // Measured acceptance replaces the vision critique with pinned checkers that
        // read the artifact. It is only meaningful when at least one registered such
        // checker is actually bound: the native asset checker stays in place for the
        // runtime binding, the budgets and the unit/axis round-trip, and an
        // unregistered verifier id must not satisfy the requirement.
        const measuredCheckers = spec.acceptanceCriteria.filter(c => c.required && c.kind === "executable").map(c => this.verifiers.get(c.verifierId)).filter(definition => definition && definition.capability !== "blender-asset");
        if (spec.acceptanceMode === "measured" && measuredCheckers.length === 0) reasons.push(`${spec.taskId}:measured-acceptance-needs-measured-checker`);
      }
      if (["reliability-investigator", "code-profiler"].includes(spec.roleId)) reasons.push(...require("./specialist-diagnostics").diagnosticPreflight({ ...role, settings: { ...role.settings, domainInput: spec.domainInput, taskPolicy: { readZones: spec.readZones, writeZones: spec.writeZones } } }, this.cwd).map(reason => `${spec.taskId}:${reason}`));
      reasons.push(...capabilityStatus({ ...role, settings: this.producerSettings(role, spec) }).reasons.map(r => `${spec.taskId}:${r}`));
      for (const c of spec.acceptanceCriteria.filter(c => c.required)) {
        if (c.kind === "executable" && !this.verifiers.has(c.verifierId)) reasons.push(`${spec.taskId}:verifier-unavailable:${c.verifierId}`);
        else if (c.kind === "executable") { try { assertOracleSources(this.verifiers.get(c.verifierId), this.cwd, spec, graph.commandBindings, false); } catch (error) { reasons.push(`${spec.taskId}:${error.code || "oracle-source-invalid"}`); } }
      }
    }
    return { allowed: reasons.length === 0, graphDigest: graph.digest, reasons: [...new Set(reasons)], graph };
  }
  retainedStorage(inventory) {
    return inventory.reduce((sum, run) => sum + (run.retainedStorageBytes ?? run.reservedStorageBytes ?? 0), 0);
  }
  retainedEvidence(inventory) {
    return inventory.reduce((sum, run) => sum + (run.retainedEvidenceBytes ?? run.reservedEvidenceBytes ?? 0), 0);
  }
  pendingStorage(inventory) {
    return inventory.reduce((sum, run) => sum + (run.pendingStorageBytes ?? 0), 0);
  }
  pendingEvidence(inventory) {
    return inventory.reduce((sum, run) => sum + (run.pendingEvidenceBytes ?? 0), 0);
  }
  retainedBytes(state) {
    let workspaceBytes = 0;
    const measured = new Set();
    for (const task of Object.values(state.tasks || {})) {
      for (const attempt of task.attempts || []) {
        const producerId = attempt.artifact?.producerSubagentId || (state.processes || []).find(process => process.taskId === task.taskId && process.attemptId === attempt.id)?.subagentId;
        if (!producerId || measured.has(producerId)) continue;
        measured.add(producerId);
        const record = this.subagents.getSubagent({ subagentId: producerId });
        // A retained run whose producer record or result disappeared cannot be
        // measured safely; keep its previous accounting instead of assuming zero.
        if (!record?.result) throw Object.assign(new Error(`retained producer record missing: ${producerId}`), { code: "TASK_RETAINED_RECORD_MISSING" });
        const workspace = record.result.diagnostics?.workspace;
        if (!workspace?.retained || !workspace.cwd) continue;
        // The tree is measured by its tracked/untracked inventory; the retained
        // patch file lives beside it and is not part of that inventory.
        workspaceBytes += repositoryStorageEstimate(workspace.cwd).bytes + (Number.isFinite(workspace.patchBytes) ? workspace.patchBytes : 0);
      }
    }
    // The run state already contains its receipts; the evidence store keeps a
    // second copy. Count both, plus a small metadata allowance, and the durable
    // recovery journals that are retained beside the state rather than inside it.
    let evidenceBytes = Buffer.byteLength(JSON.stringify(state)) * 2 + 1024;
    const root = this.subagents.cwd || this.cwd;
    for (const task of Object.values(state.tasks || {})) {
      for (const application of task.applications || []) {
        const reference = application.recoveryReference || application.applied?.recoveryFile;
        if (!reference) continue;
        try { evidenceBytes += fs.statSync(path.join(root, reference)).size; } catch {}
      }
    }
    return { workspaceBytes, evidenceBytes };
  }
  settleStorage(runId) {
    // Settlement runs after the run state is already durable. Accounting is
    // best effort here: a measurement or write failure must not turn a
    // completed run into a failure; the previous reservation stays in place for
    // the next admission to replace.
    try {
      const state = this.storage.readJson(`specialist-tasks/${runId}`, null);
      const inventory = this.storage.readJson("specialist-task-index", []);
      const entry = inventory.find(run => run.runId === runId);
      if (!state || !entry) return;
      const retained = this.retainedBytes(state);
      this.storage.writeJson("specialist-task-index", inventory.map(run => run.runId === runId ? { ...run, retainedStorageBytes: retained.workspaceBytes, retainedEvidenceBytes: retained.evidenceBytes, pendingStorageBytes: 0, pendingEvidenceBytes: 0 } : run));
    } catch {}
  }
  reconciledInventory(inventory) {
    return inventory.map(entry => {
      if (entry.retainedStorageBytes != null) return entry;
      let state;
      try { state = this.storage.readJson(`specialist-tasks/${entry.runId}`, null); }
      catch { return entry; } // An unreadable legacy state cannot be measured; keep its reservation.
      if (!state) return entry;
      try {
        const retained = this.retainedBytes(state);
        // Additive only: the historical reserved bytes remain intact for audit.
        return { ...entry, retainedStorageBytes: retained.workspaceBytes, retainedEvidenceBytes: retained.evidenceBytes, pendingStorageBytes: 0, pendingEvidenceBytes: 0 };
      } catch { return entry; }
    });
  }
  reconcileStorage() {
    const inventory = this.storage.readJson("specialist-task-index", []);
    const reconciled = this.reconciledInventory(inventory);
    if (JSON.stringify(reconciled) !== JSON.stringify(inventory)) this.storage.writeJson("specialist-task-index", reconciled);
    return reconciled;
  }
  admitStorage(runId, workspaceBytes, evidenceBytes) {
    let inventory = this.storage.readJson("specialist-task-index", []);
    invariant(inventory.some(run => run.runId === runId), "TASK_RUN_NOT_FOUND");
    // Only retained artifacts and one transient reservation are persisted. The
    // transient headroom is replaced on the next admission and cleared at
    // settlement, so retries and later runs never accumulate old headroom.
    if (this.retainedStorage(inventory) + this.pendingStorage(inventory) + workspaceBytes > this.retentionBytes || this.retainedEvidence(inventory) + this.pendingEvidence(inventory) + evidenceBytes > 67108864) {
      // Historical entries carry only the old accumulated reservation. Reconcile
      // them from their retained artifacts before refusing admission.
      inventory = this.reconcileStorage();
    }
    invariant(this.retainedStorage(inventory) + this.pendingStorage(inventory) + workspaceBytes <= this.retentionBytes, "TASK_WORKSPACE_RETENTION_LIMIT");
    invariant(this.retainedEvidence(inventory) + this.pendingEvidence(inventory) + evidenceBytes <= 67108864, "TASK_EVIDENCE_RETENTION_LIMIT");
    const disk = fs.statfsSync(this.cwd);
    invariant(disk.bavail * disk.bsize > workspaceBytes + evidenceBytes + 67108864, "TASK_DISK_CAPACITY_LOW");
    this.storage.writeJson("specialist-task-index", inventory.map(run => run.runId === runId ? { ...run, pendingStorageBytes: workspaceBytes, pendingEvidenceBytes: evidenceBytes } : run));
  }
  taskRole(role, settings) {
    return { ...clone(role), budget: null, timeoutMs: null, modelPolicy: { mode: "inherit", preference: null, fallback: "inherit", thinkingLevel: "inherit" }, settings: { ...role.settings, ...settings } };
  }
  appendReceipt(receipts, receipt) {
    const combined = [...receipts, receipt];
    // A blender-asset acceptance receipt carries the base64 contact sheet the
    // critic reviews (up to MAX_PREVIEW_BYTES, plus the executable receipt's
    // copy), so its budget must cover two encoded previews and the metadata.
    const maxBytes = combined.some(entry => entry.capability === "blender-asset") ? BLENDER_RECEIPT_BYTES : 131072;
    invariant(Buffer.byteLength(JSON.stringify(combined)) <= maxBytes, "TASK_RECEIPT_BUDGET_EXHAUSTED");
    this.writeReceipt(receipt); receipts.push(receipt);
  }
  writeReceipt(receipt) { return this.evidenceStore.write({ id: receipt.proofId, ok: receipt.status === "passed", type: "task-criterion-receipt", createdAt: new Date().toISOString(), artifactDigest: receipt.artifactDigest, receipt }); }
  readReceipt(id) { return this.evidenceStore.read(id)?.receipt || null; }
  capabilities() {
    const { domainCapabilities } = require("./specialist-verifiers");
    const domains = domainCapabilities();
    for (const [capability, key, binding] of [["lean-proof", "formalProof", require("./specialist-lean").leanBinding], ["rea-static", "reaReverseEngineering", require("./specialist-rea").reaBinding]]) {
      const configured = [...this.verifiers].filter(([, v]) => v.capability === capability).map(([id, v]) => {
        try { binding(v.configuration, this.cwd); return { id, available: true }; }
        catch (error) { return { id, available: false, reason: error.message }; }
      });
      if (configured.length) domains[key] = { available: configured.some(v => v.available), verifiers: configured, scope: domains[key].scope, installingProbe: false };
    }
    const verifiers = [...this.verifiers].filter(([, definition]) => definition.capability === "blender-asset").map(([id, definition]) => ({ id, ...domainCapabilities({ blenderRuntime: definition.configuration.runtime }).modeling }));
    if (verifiers.length) domains.modeling = { ...domains.modeling, available: verifiers.some(v => v.available), reasons: [...new Set(verifiers.flatMap(v => v.reasons))], verifiers };
    domains.blenderAi = { available: [...this.verifiers.values()].some(v => {
      if (!v.configuration?.blenderAi) return false;
      try { require("./specialist-blenderai").blenderAiBinding(v.configuration.blenderAi, this.cwd); return true; } catch { return false; }
    }), scope: "Pinned add-on canonical dispatch in a disposable networkless Blender process; animation authoring and independent native/GLB motion checks" };
    const roles = this.topologies.discoverRoles().map(role => role.roleId !== "3d-modeler" ? role : { ...role, availability: domains.modeling.available ? "requires-task-contract" : "unavailable", unavailabilityReasons: domains.modeling.available ? [] : domains.modeling.reasons });
    return { schemaVersion: 1, roles, domains, automaticRoutingChanged: false, retention: { runs: this.retentionRuns, combinedBytes: this.retentionBytes, evidenceBytes: 67108864 } };
  }
  planningContext() {
    return {
      schemaVersion: 1,
      enabled: true,
      topologiesEnabled: this.topologies.enabled,
      baseline: baseline(this.cwd),
      roles: this.topologies.discoverRoles(),
      execution: { taskBudgets: false, model: "inherit", thinkingLevel: "inherit", humanFeedback: "non-blocking", assetRefinement: { critic: "3d-critic", maxAttempts: MAX_ASSET_ATTEMPTS, requiresImageInput: true }, assetAcceptance: { modes: ["critic", "measured"], default: "critic", measured: { field: "acceptanceMode", requiresMeasuredChecker: true, reviewer: "independent-review" } } },
      verifiers: [...this.verifiers].map(([id, definition]) => ({ id, revision: verifierRevision(definition), capability: definition.capability || "registered-executable-check", protectedFiles: clone(definition.protectedFiles || []) })),
      authorization: "preflight-required; application-is-a-separate-parent-action",
    };
  }
  metrics() {
    const index = this.storage.readJson("specialist-task-index", []);
    // Report effective accounting without rewriting historical entries.
    const effective = this.reconciledInventory(index);
    const runs = index.map(entry => this.status(entry.runId)).filter(Boolean);
    const tasks = runs.flatMap(run => run.tasks), attempts = tasks.flatMap(task => task.attempts);
    const phases = attempts.flatMap(attempt => [attempt.measurements?.producer, attempt.measurements?.reviewer]);
    const knownSum = values => values.length && values.every(value => Number.isFinite(value)) ? values.reduce((sum, value) => sum + value, 0) : null;
    const accounting = { sdkReportedCost: knownSum(phases.map(phase => phase?.sdkReportedCost)), tokens: Object.fromEntries(["input", "output", "cacheRead", "cacheWrite", "totalTokens"].map(key => [key, knownSum(phases.map(phase => phase?.tokens[key]))])), queueMs: knownSum(phases.map(phase => phase?.queueMs)), startupMs: knownSum(phases.map(phase => phase?.startupMs)), executionMs: knownSum(phases.map(phase => phase?.executionMs)), verificationWallMs: knownSum(attempts.map(attempt => attempt.measurements?.verificationWallMs)), integrationWorkerWallMs: knownSum(attempts.filter(attempt => attempt.measurements?.integration).map(attempt => attempt.measurements.producer.workerWallMs)), contextBytes: knownSum(attempts.map(attempt => attempt.measurements ? attempt.measurements.contextBytes + attempt.measurements.reviewContextBytes : null)), repeatedReadRequestsWithinWorkers: knownSum(phases.map(phase => phase?.sourceReads?.repeatedRequests)), crossWorkerRepeatedReads: null, feedbackCount: tasks.reduce((sum, task) => sum + task.feedbackCount, 0), applicationAttempts: tasks.reduce((sum, task) => sum + task.applications.length, 0) };
    return { ...accounting, schemaVersion: 1, runs: runs.length, tasks: tasks.length, acceptedProposals: tasks.filter(task => ["accepted-proposal", "accepted-applied"].includes(task.state)).length, applied: tasks.filter(task => task.state === "accepted-applied").length, blocked: tasks.filter(task => task.state === "blocked").length, corrections: attempts.filter(attempt => attempt.previousAttemptId).length, firstPassAccepted: tasks.filter(task => task.attempts[0]?.state === "accepted-proposal").length, unknownCostRuns: runs.filter(run => run.actual.cost == null).length, providerReportedCost: runs.length > 0 && runs.every(run => run.actual.cost != null) ? runs.reduce((sum, run) => sum + run.actual.cost, 0) : null, retainedStorageBytes: this.retainedStorage(effective), retainedEvidenceBytes: this.retainedEvidence(effective), pendingStorageBytes: this.pendingStorage(effective), pendingEvidenceBytes: this.pendingEvidence(effective), cohort: "unqualified-until-reviewed", liveBenefitEstablished: false };
  }
  status(runId) {
    invariant(validId(runId), "TASK_RUN_ID_INVALID");
    const state = this.storage.readJson(`specialist-tasks/${runId}`, null);
    if (!state) return null;
    return new SubagentTaskState({ storage: this.storage, runId, graph: { digest: state.graphDigest } }).publicSnapshot();
  }
  evidence(runId, taskId) {
    invariant(validId(runId) && validId(taskId), "TASK_ID_INVALID");
    const state = this.storage.readJson(`specialist-tasks/${runId}`, null), task = state?.tasks?.[taskId];
    invariant(task?.artifact && task.attempts?.length, "TASK_ARTIFACT_MISSING");
    const receipts = [...task.attempts.at(-1).receipts, ...task.feedback.filter(receipt => receipt.artifactDigest === task.artifact.digest), ...(task.applications || []).flatMap(application => application.receipts).filter(receipt => receipt.artifactDigest === task.artifact.digest)];
    return receipts.map(receipt => {
      const stored = this.readReceipt(receipt.proofId);
      invariant(stored && stored.artifactDigest === task.artifact.digest && digest(stored) === digest(receipt), "TASK_RECEIPT_NOT_AUTHORITATIVE");
      return stored;
    });
  }
  cancel(runId) { invariant(validId(runId), "TASK_RUN_ID_INVALID"); const controller = this.active.get(runId); if (!controller) return { cancelled: false, reason: "not-running" }; controller.abort(); return { cancelled: true }; }
  async run(input, options = {}) {
    const ownership = await acquireManagedWorker({ root: path.join(this.cwd, ".pi", "specialist-task-locks"), limit: 1 });
    try { return await this.runOwned(input, options); } finally { await ownership.release(); }
  }
  async runOwned(input, options = {}) {
    const preflight = this.preflight(input, { resumeRunId: options.resume ? options.runId : null, piContext: options.piContext });
    invariant(preflight.allowed, `TASK_PREFLIGHT_BLOCKED:${preflight.reasons.join(",")}`);
    const graph = preflight.graph;
    const runId = options.runId || `taskrun-${crypto.randomBytes(8).toString("hex")}`;
    const existing = this.storage.readJson(`specialist-tasks/${runId}`, null);
    invariant(!this.active.has(runId) && (options.resume === true ? Boolean(existing) : !existing), "TASK_RUN_EXISTS_OR_RESUME_MISSING");
    const state = new SubagentTaskState({ storage: this.storage, runId, graph, now: this.now });
    if (options.resume === true) {
      for (const process of state.snapshot().processes || []) {
        if (process.closed) continue;
        const identity = processIdentity(process.processGroupId);
        invariant(!(identity?.startTime === process.startTime) && !processGroupAlive(process.processGroupId), "TASK_PROCESSES_STILL_ACTIVE");
        state.process(process.taskId, process.attemptId, { subagentId: process.subagentId, processGroupId: process.processGroupId, startTime: process.startTime }, true);
      }
      state.recover(); state.resumeReconciled();
    } else {
      const index = this.storage.readJson("specialist-task-index", []);
      this.storage.writeJson("specialist-task-index", [...index, { runId, graphDigest: graph.digest, retainedStorageBytes: 0, retainedEvidenceBytes: 0, pendingStorageBytes: 0, pendingEvidenceBytes: 0, startedAt: this.now() }]);
    }
    const controller = new AbortController(); this.active.set(runId, controller);
    const abort = () => controller.abort(); options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const taskExecutor = { execute: args => this.executeTask({ ...args, graph, state, signal: controller.signal }) };
    try {
      const topology = await this.topologies.execute(compileTaskTopology(graph), { task: `Execute validated task graph ${graph.graphId}` }, { ...options, cwd: this.cwd, runId, signal: controller.signal, taskExecutor });
      state.blockUnstarted(topology.nodeStates || []);
      return { status: controller.signal.aborted ? "cancelled" : topology.status === "succeeded" ? "accepted-proposal" : topology.status, runId, graphDigest: graph.digest, tasks: state.publicSnapshot(), topologyRunId: topology.runId, application: "not-applied" };
    } finally { options.signal?.removeEventListener("abort", abort); this.active.delete(runId); this.settleStorage(runId); }
  }
  async feedback({ runId, taskId, artifactDigest, text } = {}) {
    invariant(validId(runId) && validId(taskId), "TASK_ID_INVALID");
    invariant(typeof text === "string" && text.trim().length > 0 && text.length <= 4000, "TASK_FEEDBACK_INVALID");
    const ownership = await acquireManagedWorker({ root: path.join(this.cwd, ".pi", "specialist-task-locks"), limit: 1 });
    try {
      const saved = this.storage.readJson(`specialist-tasks/${runId}`, null);
      invariant(saved, "TASK_RUN_NOT_FOUND");
      const state = new SubagentTaskState({ storage: this.storage, runId, graph: { digest: saved.graphDigest }, now: this.now });
      const task = saved.tasks[taskId];
      invariant(task?.artifact?.digest === artifactDigest && !task.invalidated, "TASK_FEEDBACK_ARTIFACT_STALE");
      const receipt = { schemaVersion: 2, proofId: `feedback-${crypto.randomBytes(8).toString("hex")}`, kind: "feedback", status: "feedback", taskId, artifactDigest, text: text.trim(), at: this.now() };
      this.admitStorage(runId, 0, Buffer.byteLength(JSON.stringify(receipt)) * 2 + 1024);
      this.writeReceipt(receipt);
      state.feedback(taskId, artifactDigest, receipt);
      return state.publicSnapshot();
    } finally { this.settleStorage(runId); await ownership.release(); }
  }
  async apply(input = {}) {
    invariant(input.explicit === true, "TASK_EXPLICIT_APPLY_REQUIRED");
    const ownership = await acquireManagedWorker({ root: path.join(this.cwd, ".pi", "specialist-task-locks"), limit: 1 });
    try { return await this.applyOwned(input); } finally { await ownership.release(); }
  }
  async applyOwned({ runId, graph: input, taskId, artifactDigest, explicit = false, signal } = {}) {
    invariant(validId(runId) && validId(taskId), "TASK_ID_INVALID");
    invariant(explicit === true, "TASK_EXPLICIT_APPLY_REQUIRED");
    const graph = this.bindGraph(input);
    invariant(this.storage.readJson(`specialist-tasks/${runId}`, null), "TASK_RUN_NOT_FOUND");
    const state = new SubagentTaskState({ storage: this.storage, runId, graph, now: this.now });
    const snapshot = state.snapshot(), task = snapshot.tasks[taskId], spec = graph.tasks.find(t => t.taskId === taskId);
    invariant(task?.artifact?.digest === artifactDigest && task.artifact.kind !== "dossier", "TASK_APPLY_ARTIFACT_MISMATCH");
    if (task.state === "accepted-applied") return { state: "accepted-applied", runId, taskId, artifactDigest, alreadyApplied: true, application: task.application };
    invariant(spec && Object.values(snapshot.tasks).every(t => t.state === "accepted-proposal"), "TASK_GRAPH_NOT_ACCEPTED");
    invariant(graph.tasks.length === 1 || spec.taskKind === "integration", "TASK_APPLY_REQUIRES_INTEGRATOR");
    const attempt = task.attempts.at(-1);
    for (const criterion of spec.acceptanceCriteria.filter(c => c.required)) {
      const receipt = attempt.receipts.find(r => r.criterionId === criterion.id);
      invariant(receipt && receipt.status === "passed" && receipt.artifactDigest === artifactDigest && digest(this.readReceipt(receipt.proofId)) === digest(receipt), "TASK_APPLY_RECEIPT_INVALID");
      const definition = this.verifiers.get(criterion.verifierId);
      invariant(definition && receipt.verifierRevision === verifierRevision(definition), "TASK_VERIFIER_REVISION_STALE");
    }
    invariant(baseline(this.cwd).baselineFingerprint === spec.baselineFingerprint, "TASK_PARENT_DRIFT");
    const criteria = spec.acceptanceCriteria.filter(criterion => criterion.required && criterion.kind === "executable");
    const maxRecoveryBytes = task.artifact.disposition === "baseline-satisfied" ? 0 : repositoryStorageEstimate(this.cwd).bytes * 2 + 131072;
    this.admitStorage(runId, 0, 131072 + maxRecoveryBytes);
    const applicationId = state.startApplication(taskId, artifactDigest).tasks[taskId].applications.at(-1).id;
    const controller = new AbortController(), startedAt = this.now(), receipts = [];
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.active.set(runId, controller);
    let calls = 0, receiptBytes = 0, checksFinishedAt = null;
    const actual = () => ({ ...zero(), toolCalls: calls, wallTimeMs: (checksFinishedAt ?? this.now()) - startedAt, storageBytes: null });
    const verify = async ({ cwd }) => {
      const evidence = [];
      for (const criterion of criteria) {
        if (signal.aborted) break;
        const definition = this.verifiers.get(criterion.verifierId);
        invariant(verifierRevision(definition) === graph.verifierBindings[criterion.verifierId], "TASK_VERIFIER_REVISION_STALE");
        assertOracleSources(definition, cwd, spec, graph.commandBindings);
        const checkStartedAt = this.now(); calls++;
        const checked = definition.run ? await definition.run({ cwd, artifact: task.artifact, signal }) : await runContained({ ...definition, cwd, readZones: [...spec.readZones, ...spec.writeZones], writable: false, signal });
        const receipt = { schemaVersion: 1, proofId: `task-application-${crypto.randomBytes(12).toString("hex")}`, runId, taskId, applicationId, phase: "application", kind: "executable", runtimeRevision: graph.runtimeRevision, commandFingerprint: digest(graph.commandBindings), criterionId: criterion.id, artifactDigest, verifierRevision: verifierRevision(definition), sourceFingerprint: baseline(cwd).baselineFingerprint, startedAt: checkStartedAt, finishedAt: this.now(), exitCode: checked.exitCode ?? null, termination: checked.termination || null, status: checked.ok === true && checked.exitCode === 0 && !checked.termination && !signal.aborted ? "passed" : "failed", diagnostic: String(checked.stderr || checked.stdout || "").slice(0, 1000), diagnosticTruncated: String(checked.stderr || checked.stdout || "").length > 1000 };
        receiptBytes += Buffer.byteLength(JSON.stringify(receipt));
        invariant(receiptBytes <= 131072, "TASK_RECEIPTS_BUDGET_EXHAUSTED");
        this.writeReceipt(receipt); receipts.push(receipt);
        evidence.push({ criterionId: criterion.id, proofId: receipt.proofId, passed: receipt.status === "passed" });
      }
      checksFinishedAt = this.now();
      return { status: evidence.length === criteria.length && evidence.every(item => item.passed) && !signal.aborted ? "passed" : "failed", evidence };
    };
    try {
      let applied;
      if (task.artifact.disposition === "baseline-satisfied") {
        const verification = await verify({ cwd: this.cwd });
        invariant(verification.status === "passed", "TASK_BASELINE_VERIFICATION_FAILED");
        invariant(baseline(this.cwd).baselineFingerprint === spec.baselineFingerprint, "TASK_PARENT_DRIFT");
        applied = { applied: true, disposition: "baseline-satisfied", appliedAt: new Date().toISOString(), previewId: null, patchHash: null, changedPaths: task.artifact.paths, verification };
      } else {
        const subagentId = task.artifact.producerSubagentId;
        const preview = this.subagents.previewSubagentPatch({ subagentId });
        invariant(preview.patchHash === task.artifact.patchHash, "TASK_APPLY_ARTIFACT_MISMATCH");
        applied = await this.subagents.applySubagentPatch({ subagentId, preview, explicit: true, verify, maxRecoveryBytes });
      }
      state.settleApplication(taskId, applicationId, { status: "passed", actual: actual(), receipts, applied });
      return { state: "accepted-applied", runId, taskId, artifactDigest, application: applied };
    } catch (error) {
      if (state.snapshot().tasks[taskId].applications.at(-1).state === "running") state.settleApplication(taskId, applicationId, { status: "failed", actual: actual(), receipts, reason: error.code === "SUBAGENT_PATCH_ROLLBACK_CONFLICT" ? "application-reconciliation-required" : signal.aborted ? "application-interrupted" : error.code || "application-failed", recoveryReference: error.details?.recoveryFile || null });
      throw error;
    } finally { this.active.delete(runId); this.settleStorage(runId); }
  }
  async executeTask({ node, role, context, run, graph, state, signal: runSignal }) {
    const spec = graph.tasks.find(t => t.taskId === node.id);
    invariant(spec, "TASK_NODE_UNDECLARED");
    const cached = state.snapshot().tasks[spec.taskId];
    if (cached.state === "accepted-proposal") {
      try {
        const saved = this.subagents.getSubagent({ subagentId: cached.artifact.producerSubagentId });
        invariant(saved?.result?.status === "succeeded", "TASK_RESUME_ARTIFACT_MISSING");
        const receipts = cached.attempts.at(-1).receipts;
        for (const criterion of spec.acceptanceCriteria.filter(criterion => criterion.required)) invariant(receipts.filter(receipt => receipt.criterionId === criterion.id && receipt.verifierId === criterion.verifierId).length === 1, "TASK_RESUME_COVERAGE_INCOMPLETE");
        for (const receipt of receipts) invariant(receipt.status === "passed" && receipt.artifactDigest === cached.artifact.digest && digest(receipt) === digest(this.readReceipt(receipt.proofId)), "TASK_RESUME_RECEIPT_INVALID");
        if (cached.artifact.kind !== "dossier" && cached.artifact.disposition !== "baseline-satisfied") {
          const capture = this.subagents.workspaceManager.readCapture(saved.result.diagnostics.workspace.path);
          invariant(capture.patchHash === cached.artifact.patchHash, "TASK_RESUME_ARTIFACT_DRIFT");
          new SubagentPatchService({ cwd: this.cwd }).validateCapture(capture);
        }
        const result = new AgentResult({ agentId: node.id, nodeId: node.id, role: role.roleId, status: saved.result.status, summary: saved.result.summary, payload: { ...saved.result, ...normalizePublicSubmission(saved.result.submitted_result) }, diagnostics: saved.result.diagnostics, provenance: { subagentId: saved.id } });
        invariant(artifactManifest(spec, cached.artifact.attemptId, result, cached.artifact.dependencyArtifacts).digest === cached.artifact.digest, "TASK_RESUME_ARTIFACT_DRIFT");
        return result;
      } catch (error) {
        const affected = new Set([spec.taskId]);
        for (let pass = 0; pass < graph.tasks.length; pass++) for (const task of graph.tasks) if (task.dependsOn.some(dependency => affected.has(dependency.taskId))) affected.add(task.taskId);
        state.invalidate([...affected], "dependency-artifact-stale");
        throw error;
      }
    }
    invariant(cached.reason !== "application-reconciliation-required", "TASK_APPLICATION_RECONCILIATION_REQUIRED");
    const dependencies = spec.dependsOn.map(d => {
      const task = state.snapshot().tasks[d.taskId];
      invariant(task?.state === "accepted-proposal" && task.artifact?.kind === d.requiredArtifactKind, "TASK_DEPENDENCY_NOT_ACCEPTED");
      return task.artifact.digest;
    });
    const dependencyBytes = spec.dependsOn.reduce((sum, dependency) => sum + state.snapshot().tasks[dependency.taskId].artifact.bytes, 0);
    let feedback = cached.feedback.length ? { userFeedback: cached.feedback.map(entry => ({ artifactDigest: entry.artifactDigest, text: entry.text })) } : null;
    // An interrupted producer has no capture. Recover the last candidate and
    // its own critique together, rather than attaching older feedback to a newer asset.
    const refinement = spec.roleId === "3d-modeler" && !cached.invalidated ? cached.attempts.findLast(attempt => attempt.artifact && !cached.invalidations?.some(entry => entry.artifactDigest === attempt.artifact.digest)) : null;
    const priorArtifact = refinement?.artifact || cached.artifact;
    const prior = priorArtifact && !cached.invalidated ? this.subagents.getSubagent({ subagentId: priorArtifact.producerSubagentId })?.result : null;
    if (refinement) invariant(prior?.status === "succeeded", "TASK_REFINEMENT_ARTIFACT_MISSING");
    let previousResult = prior ? { summary: prior.summary, payload: prior } : null;
    if (spec.roleId === "3d-modeler" && cached.attempts.length) {
      const last = refinement || cached.attempts.at(-1);
      const visualCritique = refinement?.receipts.find(receipt => receipt.visualReview?.status === "failed")?.visualReview.critique;
      feedback = { ...feedback, previousAttemptId: last.id, artifactDigest: refinement?.artifact.digest, failures: last.receipts.filter(receipt => receipt.status !== "passed").map(receipt => ({ criterionId: receipt.criterionId, diagnostic: receipt.diagnostic })), ...(visualCritique ? { visualCritique } : {}) };
    }
    for (;;) {
      invariant(!runSignal.aborted, "TASK_CANCELLED");
      invariant(spec.roleId !== "3d-modeler" || state.snapshot().tasks[spec.taskId].attempts.length < MAX_ASSET_ATTEMPTS, "TASK_REFINEMENT_LIMIT");
      // Storage admission protects the host across runs; it is not an inference budget.
      const writeBytes = spec.writeZones.length ? spec.domainInput?.maxBytes || 1048576 : 0;
      this.admitStorage(state.snapshot().runId, (repositoryStorageEstimate(this.cwd).bytes + dependencyBytes + writeBytes) * 8, (spec.roleId === "3d-modeler" ? 2097152 : 1048576) + (spec.domainInput?.execution ? 4 * MAX_DIAGNOSTIC_EVIDENCE_BYTES : 0));
      const started = state.start(spec.taskId, dependencies);
      const attempt = started.tasks[spec.taskId].attempts.at(-1);
      const signal = runSignal;
      const attemptRun = { ...run, piContext: { ...(run.piContext || {}), onProcessSpawn: identity => state.process(spec.taskId, attempt.id, identity), onProcessClose: identity => state.process(spec.taskId, attempt.id, identity, true) } };
      const effectiveRole = this.taskRole(role, {});
      effectiveRole.toolPolicy.allowedTools = effectiveRole.toolPolicy.allowedTools.filter(tool => tool !== "bash");
      effectiveRole.toolPolicy.deniedTools = [...new Set([...effectiveRole.toolPolicy.deniedTools, "bash"])];
      effectiveRole.settings = { ...this.producerSettings(effectiveRole, spec), containment: "bwrap", domainInput: spec.domainInput, taskPolicy: { readZones: spec.readZones, writeZones: spec.writeZones, storageBytes: writeBytes } };
      const taskContext = { ...context, dependencyResults: [...(context.dependencyResults || []), ...(previousResult ? [previousResult] : [])], input: { task: spec.objective, taskId: spec.taskId, requirementIds: spec.requirementIds, readZones: spec.readZones, writeZones: spec.writeZones, dependencyArtifacts: spec.dependsOn.map((dependency, index) => ({ ...dependency, artifactDigest: dependencies[index] })), contextPacket: graph.context, exclusions: spec.exclusions, acceptanceCriteria: spec.acceptanceCriteria, ...(feedback ? { correction: feedback } : {}), ...(spec.domainInput ? { domainInput: spec.domainInput } : {}) }, task: spec.objective };
      taskContext.dependencyResults = taskContext.dependencyResults.map(dependency => ({ nodeId: dependency.nodeId, status: dependency.status, summary: String(dependency.summary || "").slice(0, 1000) + (String(dependency.summary || "").length > 1000 ? " [summary truncated; structured evidence is retained separately]" : ""), workspace: dependency.payload?.diagnostics?.workspace || dependency.workspace || null, ...(dependency.payload?.dossier ? { dossier: dependency.payload.dossier } : {}) }));
      taskContext.input.dependencyDossiers = taskContext.dependencyResults.filter(dependency => dependency.dossier).map(dependency => ({ taskId: dependency.nodeId, dossier: dependency.dossier }));
      taskContext.task = JSON.stringify(taskContext.input);
      const start = this.now();
      try {
        const result = await this.executor.execute({ node, role: effectiveRole, context: taskContext, run: { ...attemptRun, signal, piContext: { ...attemptRun.piContext, rpc: { ...(run.piContext?.rpc || {}), noSession: true }, signal } } });
        invariant(result.status === "succeeded", `TASK_PRODUCER_${result.status}`);
        const artifact = artifactManifest(spec, attempt.id, result, dependencies);
        state.artifact(spec.taskId, attempt.id, artifact);
        state.verifying(spec.taskId, attempt.id, artifact.digest);
        const verificationStartedAt = this.now();
        const verified = await this.verify({ spec, artifact, result, role, node, run: attemptRun, signal, verifierBindings: graph.verifierBindings, contextPacket: graph.context, runtimeRevision: graph.runtimeRevision, commandBindings: graph.commandBindings });
        const actual = { ...zero(), ...observedUsage(result.diagnostics, verified.reviewDiagnostics), attempts: 1, wallTimeMs: this.now() - start, storageBytes: null };
        if (actual.toolCalls != null) actual.toolCalls += verified.receipts.length;
        const measurements = { contextBytes: Buffer.byteLength(subagentTaskFromContext(node, taskContext)), reviewContextBytes: verified.contextBytes, verificationWallMs: this.now() - verificationStartedAt, executableChecksMs: verified.executableChecksMs, integration: spec.taskKind === "integration", producer: phaseMeasurements(result.diagnostics), reviewer: phaseMeasurements(verified.reviewDiagnostics) };
        const exhausted = spec.roleId === "3d-modeler" && state.snapshot().tasks[spec.taskId].attempts.length >= MAX_ASSET_ATTEMPTS;
        state.settle(spec.taskId, attempt.id, { measurements, status: verified.ok ? "accepted-proposal" : verified.infrastructure ? "blocked" : "failed", receipts: verified.receipts, reason: verified.ok ? null : verified.infrastructure ? "verification-infrastructure" : exhausted ? "refinement-limit" : "verification-failed", actual });
        this.settleStorage(state.snapshot().runId);
        if (verified.infrastructure) throw Object.assign(new Error("TASK_VERIFICATION_INFRASTRUCTURE"), { code: "TASK_VERIFICATION_INFRASTRUCTURE" });
        if (verified.ok) {
          result.payload.taskAcceptance = { state: "accepted-proposal", artifactDigest: artifact.digest, receiptIds: verified.receipts.map(r => r.proofId), taskId: spec.taskId, attemptId: attempt.id };
          return result;
        }
        invariant(!exhausted, "TASK_REFINEMENT_LIMIT");
        feedback = { ...(verified.visualCritique ? { visualCritique: verified.visualCritique } : {}), previousAttemptId: attempt.id, artifactDigest: artifact.digest, failedCriterionIds: verified.receipts.filter(r => r.status !== "passed").map(r => r.criterionId), failures: verified.receipts.filter(r => r.status !== "passed").map(r => ({ criterionId: r.criterionId, diagnostic: r.diagnostic })), reviewFindings: verified.reviewFindings, evidenceIds: verified.receipts.map(r => r.proofId) };
        previousResult = result;
        state.correction(spec.taskId);
      } catch (error) {
        const latest = state.snapshot().tasks[spec.taskId].attempts.at(-1);
        if (["implementing", "artifact-ready", "verifying"].includes(latest.state)) { state.settle(spec.taskId, attempt.id, { status: runSignal.aborted ? "cancelled" : "blocked", reason: runSignal.aborted ? "cancelled" : String(error.code || "execution-failed").slice(0, 120), actual: { ...zero(), attempts: 1, wallTimeMs: this.now() - start, modelCalls: null, toolCalls: null, tokens: null, cost: null, storageBytes: null } }); this.settleStorage(state.snapshot().runId); }
        throw error;
      }
    }
  }
  async critiqueAsset({ spec, artifact, checks, node, run, signal, contextPacket }) {
    if (checks.some(check => check.status !== "passed")) return { review: { status: "skipped", payload: {} }, visualReview: { status: "not-run", diagnostic: "native-checks-failed" }, contextBytes: 0 };
    const native = checks.filter(check => check.capability === "blender-asset");
    let image;
    try {
      invariant(native.length === 1 && native[0].artifactDigest === artifact.digest, "TASK_VISUAL_PREVIEW_INVALID");
      image = validatePreview(native[0].preview);
    } catch { return { review: { status: "blocked", payload: {} }, visualReview: { status: "blocked", diagnostic: "missing-or-invalid-rendered-views" }, contextBytes: 0 }; }
    const role = this.topologies.roles.get("3d-critic");
    // Framing is a fact about the rendered views, not a producer claim: the native
    // checker measures subject coverage and reports it in its receipt diagnostic.
    const previewCoverage = (() => { try { const value = JSON.parse(native[0].diagnostic || "{}").previewCoverage; return typeof value === "number" ? value : null; } catch { return null; } })();
    const criticNode = { id: `${node.id}-vision`, roleId: role.roleId, contextPolicy: "dependency-neighborhood", memoryPolicy: "none" };
    const criticContext = { task: JSON.stringify({ instruction: "Inspect the attached image, not its metadata alone. It is an independently rendered contact sheet of this exact candidate. Panels left to right: front, rear, top. Return visualCritique; do not infer a visual pass from the executable check status. Producer claims and prior critiques are intentionally withheld.", objective: spec.objective, domainInput: spec.domainInput, requirementIds: spec.requirementIds, exclusions: spec.exclusions, contextPacket, artifactDigest: artifact.digest, previewDigest: native[0].preview.digest, previewCoverage, views: native[0].preview.views, executableChecks: checks.map(({ preview, ...check }) => check) }), images: [image], dependencyResults: [] };
    const review = await this.executor.execute({ node: criticNode, role: this.taskRole(role, { containment: "bwrap", taskPolicy: { readZones: [], writeZones: [] } }), context: criticContext, run: { ...run, signal, piContext: { ...(run.piContext || {}), rpc: { ...(run.piContext?.rpc || {}), noSession: true }, signal } } });
    const critique = review.payload?.visualCritique;
    const diagnostic = review.status !== "succeeded" ? "visual-critic-execution-failed" : !review.provenance?.subagentId || review.provenance.subagentId === artifact.producerSubagentId ? "visual-critic-not-independent" : validateCritique(critique, artifact.digest, native[0].preview.digest);
    const visualReview = { status: diagnostic ? "blocked" : critique.verdict === "accept" ? "passed" : "failed", criticSubagentId: review.provenance?.subagentId || null, diagnostic, critique: critique || null };
    return { review, visualReview, contextBytes: Buffer.byteLength(subagentTaskFromContext(criticNode, criticContext)) + Buffer.byteLength(image.data) };
  }
  async verify({ spec, artifact, result, node, run, signal, verifierBindings, contextPacket, runtimeRevision, commandBindings }) {
    const workspace = result.payload?.diagnostics?.workspace;
    const capture = workspace?.path ? this.subagents.workspaceManager.readCapture(workspace.path) : null;
    const inherited = artifact.disposition === "baseline-satisfied";
    if (artifact.kind !== "dossier" && !inherited) {
      invariant(capture?.patchHash === artifact.patchHash, "TASK_ARTIFACT_DRIFT");
      new SubagentPatchService({ cwd: this.cwd }).validateCapture(capture);
    } else if (!inherited) invariant(digest(result.payload.dossier) === artifact.contentDigest, "TASK_ARTIFACT_DRIFT");
    const diagnostics = spec.domainInput?.execution ? validateDiagnosticEvidence(result.payload?.diagnosticEvidence, { subagentId: artifact.producerSubagentId, execution: spec.domainInput.execution }) : [];
    if (artifact.kind === "dossier") invariant(digest(diagnostics) === artifact.diagnosticEvidenceDigest, "TASK_DIAGNOSTIC_EVIDENCE_DRIFT");
    const lease = capture || inherited ? this.subagents.workspaceManager.acquire({ subagentId: `verify-${crypto.randomBytes(8).toString("hex")}`, parentSessionId: run.runId, task: `Verify ${artifact.digest}`, seedPatches: capture ? [capture] : [], writeZones: [] }) : null;
    const checks = [], receipts = [];
    try {
      const verifiers = spec.acceptanceCriteria.filter(c => c.required && c.kind === "executable").map(criterion => {
        const definition = this.verifiers.get(criterion.verifierId);
        invariant(definition && criterion.kind === "executable", "TASK_CRITERION_UNAVAILABLE");
        return { id: criterion.id, kind: definition.kind || "unit", cacheable: false, run: async () => {
          invariant(!signal.aborted, "TASK_CANCELLED");
          const verificationCwd = lease?.cwd || this.cwd;
          const checkStartedAt = new Date(this.now()).toISOString();
          let checked;
          try { invariant(verifierRevision(definition) === verifierBindings[criterion.verifierId], "TASK_VERIFIER_REVISION_STALE"); assertOracleSources(definition, verificationCwd, spec, commandBindings); checked = definition.run ? await definition.run({ cwd: verificationCwd, dossier: result.payload?.dossier, artifact, signal }) : await runContained({ ...definition, cwd: verificationCwd, readZones: [...spec.readZones, ...spec.writeZones], writable: false, signal }); }
          catch (error) { checked = { ok: false, exitCode: null, termination: "verifier-infrastructure", stderr: String(error.code || error.message).slice(0, 1000) }; }
          const receipt = { schemaVersion: 1, proofId: `check-${crypto.randomBytes(8).toString("hex")}`, phase: "executable", taskId: spec.taskId, attemptId: artifact.attemptId, artifactDigest: artifact.digest, contractRevision: spec.contractRevision, runtimeRevision, commandFingerprint: digest(commandBindings), criterionId: criterion.id, verifierId: criterion.verifierId, verifierRevision: verifierRevision(definition), status: checked.termination || signal.aborted ? "blocked" : checked.ok === true && checked.exitCode === 0 ? "passed" : "failed", exitCode: checked.exitCode ?? null, capability: definition.capability || "registered-executable-check", configuration: definition.configuration || null, domainEvidence: checked.domainEvidence || null, preview: checked.preview || null, termination: checked.termination || null, startedAt: checkStartedAt, finishedAt: new Date(this.now()).toISOString(), outputDigest: digest({ stdout: checked.stdout || "", stderr: checked.stderr || "" }), diagnostic: String(checked.stderr || checked.stdout || (checked.ok ? "Executable criterion passed" : "Executable criterion failed")).slice(0, 1000), diagnosticTruncated: String(checked.stderr || checked.stdout || "").length > 1000, peakRssBytes: checked.peakRssBytes ?? null, outputBytes: checked.outputBytes ?? null };
          this.appendReceipt(checks, receipt);
          return { ok: receipt.status === "passed", exitCode: receipt.exitCode, stdout: String(checked.stdout || "").slice(0, 4000), stderr: String(checked.stderr || "").slice(0, 4000) };
        } };
      });
      const pipeline = new VerifiedExecutionPipeline({ verifiers, requiredKinds: [], policies: [ctx => ctx.phase === "pre-verification" || (ctx.verifiers.length === verifiers.length && ctx.verifiers.every(v => v.ok))], concurrency: 1, maxRetries: 0, evidenceStore: this.evidenceStore, cache: { key: (verifier, context) => digest({ verifierId: verifier.id, fingerprint: context.fingerprint }), get: () => null, set: () => {} }, metrics: { snapshot: () => ({}), record: () => {} } });
      const executableStartedAt = this.now();
      const proof = await pipeline.verify({ cwd: lease?.cwd || this.cwd, changeSet: { changedFiles: artifact.paths.length ? artifact.paths : ["dossier.json"], before: {}, after: {}, fingerprint: artifact.digest }, patchSet: { id: artifact.digest } });
      const executableChecksMs = this.now() - executableStartedAt;
      if (lease) {
        const after = this.subagents.workspaceManager.capture(lease, { status: "succeeded" });
        invariant(inherited ? after.patchBytes === 0 : after.patchHash === artifact.patchHash, "TASK_VERIFIER_MUTATED_ARTIFACT");
      }
      invariant(baseline(this.cwd).baselineFingerprint === spec.baselineFingerprint, "TASK_PARENT_DRIFT");
      // Review the original supervised output, not a producer's reconstruction.
      // Checkers run first so the reviewer can inspect their actual verdicts.
      // Measured acceptance keeps the independent reviewer but drops the vision
      // critique: the artifact's anatomy is decided by pinned checkers, not by a
      // model's reading of a contact sheet. Its receipts are marked acceptanceMode
      // instead of carrying a visualReview, so retained evidence cannot be read as
      // visual approval.
      let review, visualReview = null, reviewContextBytes;
      if (spec.roleId === "3d-modeler" && spec.acceptanceMode !== "measured") {
        ({ review, visualReview, contextBytes: reviewContextBytes } = await this.critiqueAsset({ spec, artifact, checks, node, run, signal, contextPacket }));
      } else {
        const reviewRole = this.reviewRole(spec);
        const reviewNode = { id: `${node.id}-review`, roleId: reviewRole.roleId, contextPolicy: "dependency-neighborhood", memoryPolicy: "none" };
        const reviewContext = { task: JSON.stringify({ instruction: "Independently review the exact candidate. Do not repair it. Report passed or failed and evidence-backed findings. executableChecks are completed, artifact-bound checker receipts, not future requirements or overall acceptance. runtimeDiagnostics are original bounded role_domain results captured by the supervising RPC runner, outside the producer submission; inspect their stdout/stderr, status, pins and receipt IDs against the candidate claims. They establish observed execution, not truth of arbitrary workload output or performance conclusions. Do not rerun one-shot diagnostics; reviewer role_domain access is intentionally absent. A deliberately crashing target remains abnormal even when a usable backtrace was collected. A structural dossier checker does not certify diagnostic claims.", objective: spec.objective, requirementIds: spec.requirementIds, exclusions: spec.exclusions, contextPacket, acceptanceCriteria: spec.acceptanceCriteria, artifact, executableChecks: checks, runtimeDiagnostics: diagnostics, ...(artifact.kind === "dossier" ? { dossier: result.payload.dossier } : {}) }), dependencyResults: [{ nodeId: node.id, status: "succeeded", summary: "Runtime-captured candidate; producer assessment withheld.", payload: { diagnostics: { workspace } } }] };
        review = await this.executor.execute({ node: reviewNode, role: this.taskRole(reviewRole, { containment: "bwrap", taskPolicy: { readZones: [...new Set([...spec.readZones, ...spec.writeZones])], writeZones: [] } }), context: reviewContext, run: { ...run, signal, piContext: { ...(run.piContext || {}), rpc: { ...(run.piContext?.rpc || {}), noSession: true }, signal } } });
        reviewContextBytes = Buffer.byteLength(subagentTaskFromContext(reviewNode, reviewContext));
      }
      const reviewOk = visualReview ? visualReview.status === "passed" : review.status === "succeeded" && review.payload?.verification?.status === "passed";
      const reviewBlocked = visualReview ? visualReview.status === "blocked" : review.status !== "succeeded";
      for (const check of checks) {
        const status = check.status === "blocked" || reviewBlocked || signal.aborted ? "blocked" : check.status === "passed" && reviewOk ? "passed" : "failed";
        this.appendReceipt(receipts, { ...check, proofId: `criterion-${crypto.randomBytes(8).toString("hex")}`, phase: "acceptance", status, finishedAt: new Date(this.now()).toISOString(), executableProofId: check.proofId, reviewSubagentId: review.provenance?.subagentId || null, diagnosticEvidenceIds: diagnostics.map(record => record.id), ...(visualReview ? { visualReview } : {}), ...(spec.acceptanceMode === "measured" ? { acceptanceMode: "measured" } : {}) });
      }
      invariant(baseline(this.cwd).baselineFingerprint === spec.baselineFingerprint, "TASK_PARENT_DRIFT");
      const executablePassed = proof.ok === true && receipts.length === verifiers.length && reviewOk && !signal.aborted;
      return { ok: executablePassed, infrastructure: receipts.length !== verifiers.length || receipts.some(receipt => receipt.status === "blocked"), reviewDiagnostics: review.diagnostics, executableChecksMs, contextBytes: reviewContextBytes, receipts, proofId: proof.id, visualCritique: visualReview?.status === "failed" ? visualReview.critique : null, reviewFindings: (review.payload?.findings || []).slice(0, 8).map(finding => String(finding.summary || finding.message || "Review finding; inspect the referenced evidence").slice(0, 500)) };
    } finally { if (lease) this.subagents.workspaceManager.release(lease, { remove: true }); }
  }
}
module.exports = { BLENDER_RECEIPT_BYTES, loadTaskPolicy, SubagentTaskService, compileTaskTopology, artifactManifest, baseline };
