import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const EXTENSION_SOURCE_PATH = fileURLToPath(import.meta.url);
const LIB_ROOT = resolve(dirname(EXTENSION_SOURCE_PATH), "..", "..", "..");
const { createPiIntegrationBoundary, MemoryJsonStorage, NullSink } = require(join(LIB_ROOT, "src", "integration-boundary.js"));
const { createProjectIndex } = require(join(LIB_ROOT, "src", "project-intelligence.js"));
const { learningSelfBenchmarkPlan } = require(join(LIB_ROOT, "src", "learning-loop.js"));
const { codegraphAffectedTests, codegraphProjectSnapshot } = require(join(LIB_ROOT, "src", "codegraph-adapter.js"));
const { securityCheckpointPlan, runSecurityCheckpoint, securityCheckpointSummary } = require(join(LIB_ROOT, "src", "security-checkpoint.js"));
const { createCodeContextService } = require(join(LIB_ROOT, "src", "code-context-service.js"));
const { readJson, writeJson, short, notify, setTurnExitCode, parseObjectInput } = require(join(LIB_ROOT, "src", "pi-extension-kit.js"));
const { normalizeRequiredProviders, providerReadiness, providerGateViolations } = require(join(LIB_ROOT, "src", "provider-readiness.js"));

const ENABLED = process.env.PI_VERIFICATION_CENTER !== "0";
const DEFAULT_TIMEOUT_MS = Number(process.env.PI_VERIFY_TIMEOUT_MS || 10 * 60_000);
const STATE_DIR = ".pi/verification-center";
const CODE_CONTEXT_MODE = process.env.PI_CODE_CONTEXT_MODE || "advisory";
const impactService = createCodeContextService({ mode: CODE_CONTEXT_MODE });

type Profile = "quick" | "full" | "changed" | "learning";
type CommandSpec = { id: string; kind: string; command: string; args: string[]; timeoutMs?: number; artifacts?: string[]; files?: string[] };

function sha256(value: any) { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function createVisualAdapter(cwd: string) {
  const disabled = { enabled: false };
  return createPiIntegrationBoundary({
    storage: new MemoryJsonStorage(), sink: new NullSink(), trace: disabled, memory: disabled, stateInventory: disabled,
    memoryState: disabled, memorySafety: disabled, sessionSearch: disabled, memoryMaintenance: disabled, retention: disabled,
    statePermissions: disabled, projectMemory: disabled, executionOutcomes: disabled, hermes: disabled, goalController: disabled,
    goalEvidence: disabled, learning: disabled, context: disabled, anchoring: disabled, verification: disabled,
    visualVerification: { enabled: process.env.PI_VISUAL_VERIFICATION !== "0", cwd }, rolloutCenter: disabled, entropy: disabled, reasoning: disabled, orchestration: disabled,
    branching: disabled, subagents: disabled, skills: disabled, skillIntake: disabled, provenance: disabled, compounding: disabled,
    topologies: disabled,
  }).visualVerification;
}
function createVerificationAdapter(verifiers: any[] = []) {
  const disabled = { enabled: false };
  return createPiIntegrationBoundary({
    storage: new MemoryJsonStorage(), sink: new NullSink(), trace: disabled, memory: disabled, stateInventory: disabled,
    memoryState: disabled, memorySafety: disabled, sessionSearch: disabled, memoryMaintenance: disabled, retention: disabled,
    statePermissions: disabled, projectMemory: disabled, executionOutcomes: disabled, hermes: disabled, goalController: disabled,
    goalEvidence: disabled, learning: disabled, context: disabled, anchoring: disabled, visualVerification: disabled,
    rolloutCenter: disabled, entropy: disabled, reasoning: disabled, orchestration: disabled, branching: disabled,
    subagents: disabled, skills: disabled, skillIntake: disabled, provenance: disabled, compounding: disabled, topologies: disabled,
    verification: { verifiers, options: { requiredKinds: [], pipelineOptions: { maxRetries: 0 } } },
  }).verification;
}
function stateRoot(cwd: string) { const root = join(cwd, STATE_DIR); mkdirSync(root, { recursive: true }); return root; }
function packageScripts(cwd: string) { return readJson(join(cwd, "package.json"), {}).scripts || {}; }
function commandFromString(spec: any, timeoutMs = DEFAULT_TIMEOUT_MS): CommandSpec | null {
  const raw = String(spec.command || "").trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  const command = parts[0];
  const args = Array.isArray(spec.args) ? spec.args.map(String) : parts.slice(1);
  const label = spec.commandLine || [command, ...args].join(" ");
  const id = String(spec.id || label).replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "verifier";
  return { id, kind: spec.kind || "unit", command, args, timeoutMs, artifacts: Array.isArray(spec.artifacts) ? spec.artifacts : [], files: Array.isArray(spec.files) ? spec.files : [] };
}
function discoverCommands(cwd: string, profile: Profile): CommandSpec[] {
  const scripts = packageScripts(cwd);
  const specs: CommandSpec[] = [];
  if (profile === "learning") {
    for (const command of learningSelfBenchmarkPlan(cwd).commands || []) {
      const parsed = commandFromString({ command, kind: "learning-loop" }, DEFAULT_TIMEOUT_MS);
      if (parsed) specs.push(parsed);
    }
    const seen = new Set<string>();
    return specs.filter((s) => { const key = `${s.command} ${s.args.join(" ")}`; if (seen.has(key)) return false; seen.add(key); return true; });
  }
  const add = (id: string, kind: string, command: string, args: string[] = [], timeoutMs = DEFAULT_TIMEOUT_MS) => specs.push({ id, kind, command, args, timeoutMs });
  try {
    const index = createProjectIndex(cwd);
    for (const item of index.verifierProfiles || []) {
      if (item.profile === profile || (profile === "changed" && item.profile === "quick") || (profile === "quick" && item.profile === "changed")) {
        const parsed = commandFromString(item, item.profile === "full" ? DEFAULT_TIMEOUT_MS * 4 : DEFAULT_TIMEOUT_MS);
        if (parsed) specs.push(parsed);
      }
    }
  } catch {}
  if (profile === "full" && existsSync(join(cwd, "scripts", "check-all.sh"))) add("check-all", "integration", "bash", ["scripts/check-all.sh"], DEFAULT_TIMEOUT_MS * 4);
  if (profile !== "full" && existsSync(join(cwd, "scripts", "check-integration-boundary.sh"))) add("integration-boundary", "integration", "bash", ["scripts/check-integration-boundary.sh"]);
  if (scripts.test) add("npm-test", "unit", "npm", ["test"]);
  if (scripts.lint) add("npm-lint", "lint", "npm", ["run", "lint"]);
  if (scripts.typecheck) add("npm-typecheck", "compile", "npm", ["run", "typecheck"]);
  if (profile === "quick" || profile === "changed") {
    if (!specs.length && existsSync(join(cwd, "tests", "integration-boundary.test.js"))) add("integration-boundary-test", "unit", "node", ["tests/integration-boundary.test.js"]);
  }
  if (profile === "full") {
    if (!specs.some((s) => s.id === "check-all") && existsSync(join(cwd, "scripts", "check-extensions-smoke.sh"))) add("extensions-smoke", "integration", "bash", ["scripts/check-extensions-smoke.sh"]);
  }
  const seen = new Set<string>();
  return specs.filter((s) => { const key = `${s.command} ${s.args.join(" ")}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
function codegraphVerificationAdvisory(cwd: string, files: string[], required = false) {
  const snapshot = codegraphProjectSnapshot(cwd, { timeoutMs: 1500 });
  const affected = files?.length ? codegraphAffectedTests(cwd, files, { timeoutMs: 3000 }) : { ok: false, skipped: true, reason: "no-files", tests: [] };
  const readiness = providerReadiness("codegraph", { required, applicable: Boolean(files?.length), ready: Boolean(snapshot.initialized && affected.ok), reason: affected.reason || snapshot.errorCode || (snapshot.initialized && affected.ok ? "affected-tests-ready" : "not-ready"), errorCode: snapshot.errorCode || affected.run?.code || null });
  return { readiness, snapshot: { enabled: snapshot.enabled, initialized: snapshot.initialized, errorCode: snapshot.errorCode, freshness: snapshot.freshness }, affected: { ok: affected.ok, skipped: affected.skipped, reason: affected.reason, tests: affected.tests || [] } };
}
function semgrepVerificationAdvisory(cwd: string, files: string[], required = false) {
  const result = runSecurityCheckpoint(cwd, files || [], { required, timeoutMs: Number(process.env.PI_SEMGREP_VERIFY_TIMEOUT_MS || 30000) });
  result.readiness = providerReadiness("semgrep", { required, applicable: result.applicable || result.status === "unavailable", ready: result.semgrep?.ok === true, reason: result.semgrep?.errorCode || result.semgrep?.reason || result.reason || "scan-ready", errorCode: result.semgrep?.errorCode || result.semgrep?.run?.code || null });
  return result;
}
function disabledImpact(files: string[] = []) {
  return {
    schemaVersion: 1, strategyId: "code-context-disabled", rolloutMode: "off", rolloutGate: { authorized: false, status: "disabled" }, status: "disabled",
    changedPaths: Array.from(new Set(files.map(String))).sort(), changedSymbols: [], mustRun: [], highConfidence: [], graphOnly: [], historical: [],
    uncoveredRisk: [], allEdges: [], selectedTests: [], selectedRuntimeMs: 0, commands: [], baselinePolicy: { additiveOnly: true, neverSuppressBaseline: true }, providers: {},
  };
}
async function verificationImpact(cwd: string, input: any = {}) {
  const changedPaths = Array.isArray(input.changedPaths) ? input.changedPaths : Array.isArray(input.files) ? input.files : [];
  if (CODE_CONTEXT_MODE === "off") return disabledImpact(changedPaths);
  return impactService.changeImpact({ cwd }, input);
}
function verificationEvidenceView(cwd: string, evidence: any, options: any = {}) {
  if (!evidence) return null;
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
  const verification = createVerificationAdapter();
  const freshness = verification.compareTreeFingerprint(cwd, evidence.tree);
  const summary: any = {
    id: evidence.id || null,
    createdAt: evidence.createdAt || null,
    ok: evidence.ok === true ? true : evidence.ok === false ? false : null,
    status: evidence.status || null,
    reason: evidence.reason ? short(evidence.reason, 300) : null,
    confidence: Number(evidence.confidence || 0),
    changedFileCount: Number(evidence.changeSet?.changedFiles?.length || 0),
    verifierCount: Number(evidence.verifiers?.length || 0),
    failedVerifierCount: (evidence.verifiers || []).filter((row: any) => row.ok !== true).length,
    tree: verification.treeFingerprintSummary(evidence.tree),
    freshness: { status: freshness.status, currentTree: freshness.currentTree === true, gatingSafe: freshness.gatingSafe === true },
  };
  if (options.detail === true) {
    summary.changedFiles = (evidence.changeSet?.changedFiles || []).slice(0, limit);
    summary.verifiers = (evidence.verifiers || []).slice(0, limit).map((row: any) => ({ id: row.id, kind: row.kind, ok: row.ok === true, durationMs: Number(row.durationMs || 0), cached: row.cached === true, error: row.error ? short(row.error, 300) : null }));
    summary.providers = [evidence.codegraph?.readiness, evidence.semgrep?.readiness, evidence.visual?.readiness].filter(Boolean).map((row: any) => ({ provider: row.provider, status: row.status, required: row.required === true, reason: row.reason || null }));
    summary.visual = evidence.visual ? { status: evidence.visual.status, ok: evidence.visual.ok === true ? true : evidence.visual.ok === false ? false : null, resultCount: Number(evidence.visual.resultCount || 0), failureCount: Number(evidence.visual.failureCount || 0), unavailableCount: Number(evidence.visual.unavailableCount || 0), results: (evidence.visual.results || []).slice(0, limit).map((row: any) => ({ caseId: row.caseId, kind: row.kind, status: row.status, ok: row.ok === true ? true : row.ok === false ? false : null, reasonCode: row.reasonCode, provider: row.provider, identity: row.identity, thresholds: row.thresholds, metrics: row.metrics, actual: row.actual, baseline: row.baseline })) } : null;
    summary.omitted = { changedFiles: Math.max(0, (evidence.changeSet?.changedFiles || []).length - limit), verifiers: Math.max(0, (evidence.verifiers || []).length - limit) };
    summary.evidenceFile = evidence.evidenceFile || null;
  }
  return summary;
}
function verificationStatusView(cwd: string, options: any = {}) {
  const current = latest(cwd);
  const quick = discoverCommands(cwd, "quick");
  const full = discoverCommands(cwd, "full");
  const detail = options.detail === true;
  const limit = options.limit;
  return {
    enabled: true,
    discovered: { quick: quick.length, full: full.length },
    visual: createVisualAdapter(cwd).readiness({ profile: "full" }),
    latest: verificationEvidenceView(cwd, current?.evidence, { detail, limit }),
    limits: { defaultSummary: true, detailedArrayItems: Math.max(1, Math.min(50, Number(limit) || 20)) },
    ...(detail ? { commands: { quick: quick.slice(0, Number(limit) || 20), full: full.slice(0, Number(limit) || 20) } } : {}),
  };
}
function formatEvidence(e: any) {
  const verdict = e.ok === true ? "PASS" : e.ok === false ? (e.status === "no-verifiers" ? "NO-VERIFIERS" : "FAIL") : "NOT-APPLICABLE";
  const rows = [
    `verification ${e.id}: ${verdict}${e.reason ? ` (${e.reason})` : ""}`,
    `confidence: ${Math.round((e.confidence || 0) * 100)}%`,
    `changed files: ${e.changeSet?.changedFiles?.length || 0}`,
    `evidence: ${e.evidenceFile}`,
    `policy: ${e.policy?.ok ? "ok" : "violations"}`,
    ...(e.acknowledgedPublicApiRemovals?.length ? [`approved public API removals: ${e.acknowledgedPublicApiRemovals.map((row: any) => `${row.file}#${row.symbol}`).join(", ")}`] : []),
    `optional providers: ${[e.codegraph?.readiness, e.semgrep?.readiness, e.visual?.readiness].filter(Boolean).map((state: any) => `${state.provider}:${state.status}${state.required ? ":required" : ":advisory"}`).join(", ") || "none"}`,
    `visual: ${e.visual ? `${e.visual.status} cases=${e.visual.resultCount || 0} failures=${e.visual.failureCount || 0}` : "not-applicable"}`,
    ...(e.semgrep ? [securityCheckpointSummary(e.semgrep), ...(e.semgrep.semgrep?.findings || []).slice(0, 10).map((finding: any) => `- ${finding.path}:${finding.start?.line || 1} ${finding.checkId}: ${finding.message}`)] : []),
  ];
  for (const v of e.verifiers || []) rows.push(`- ${v.id} [${v.kind}] ${v.ok ? "PASS" : "FAIL"} ${Math.round(v.durationMs || 0)}ms${v.cached ? " cached" : ""}${v.error ? ` :: ${short(v.error, 180)}` : ""}`);
  return rows.join("\n");
}
async function verify(cwd: string, profile: Profile = "quick", input: any = {}) {
  const commands = input.commands?.length ? input.commands : discoverCommands(cwd, profile);
  const impact = await verificationImpact(cwd, { changedPaths: input.files, confidenceThreshold: input.confidenceThreshold, maximumRuntime: input.maximumRuntime, maximumResults: input.maximumResults, configuration: input.configuration, customTests: input.customTests, binaryPaths: input.binaryPaths });
  let verification = createVerificationAdapter();
  const changeSet = await verification.captureChangeSet({ cwd, files: input.files?.length ? input.files : impact.changedPaths });
  const treeBefore = verification.captureTreeFingerprint(cwd);
  const requiredProviders = normalizeRequiredProviders(input.requiredProviders);
  const codegraph = codegraphVerificationAdvisory(cwd, changeSet.changedFiles, requiredProviders.includes("codegraph"));
  const semgrep = semgrepVerificationAdvisory(cwd, changeSet.changedFiles, requiredProviders.includes("semgrep"));
  const visualAdapter = createVisualAdapter(cwd);
  const requestedVisual = input.visual && typeof input.visual === "object" ? input.visual : {};
  const visualRequest = {
    profile,
    changedFiles: changeSet.changedFiles,
    caseIds: Array.isArray(requestedVisual.caseIds) ? requestedVisual.caseIds.map(String).slice(0, 100) : undefined,
    actualRefs: Array.isArray(requestedVisual.actualRefs) ? requestedVisual.actualRefs.slice(0, 100).map((item: any) => ({ caseId: String(item?.caseId || ""), artifactRef: String(item?.artifactRef || "") })) : undefined,
  };
  const visualPlan = visualAdapter.plan(visualRequest);
  const visualRequired = requiredProviders.includes("visual");
  const visualReason = visualPlan.cases?.find((item: any) => item.readiness?.ready !== true)?.readiness?.reasonCode || visualPlan.issues?.[0] || visualPlan.status;
  const visualReadiness = providerReadiness("visual", { required: visualRequired, applicable: visualPlan.applicable || (visualPlan.issues?.length || 0) > 0 || visualRequired, ready: visualPlan.applicable && visualPlan.ready, reason: visualPlan.applicable ? visualReason : visualRequired ? "no-applicable-visual-cases" : "not-configured-or-not-applicable", errorCode: visualPlan.issues?.[0] || null });
  const providerPolicy = { requiredProviders, states: [codegraph.readiness, semgrep.readiness, visualReadiness] };
  const providerViolations = providerGateViolations(providerPolicy.states);
  const promoteSelected = ["select-tests", "on"].includes(impact.rolloutMode) && impact.rolloutGate?.authorized === true;
  if (!input.commands?.length && profile === "changed" && promoteSelected) {
    const existing = new Set(commands.map((command: any) => `${command.command} ${(command.args || []).join(" ")}`));
    for (const command of impact.commands || []) {
      if (existing.has(command.commandLine)) continue;
      existing.add(command.commandLine);
      commands.push({ id: command.id, kind: command.kind, command: command.command, args: command.args || [], files: command.files || [], timeoutMs: DEFAULT_TIMEOUT_MS });
    }
  }
  const verifiers: any[] = commands.map((c: CommandSpec) => ({ id: c.id, kind: c.kind, command: c.command, args: c.args || [], cwd, timeoutMs: c.timeoutMs || DEFAULT_TIMEOUT_MS, files: c.files?.length ? c.files : ["**/*"], impacts: [], parser: () => ({ artifacts: c.artifacts || [] }) }));
  let visualExecution: any = null;
  if (visualPlan.applicable && visualPlan.ready) {
    const caseIds = visualPlan.cases.map((item: any) => item.caseId);
    const sourceFiles = profile === "full" ? ["**/*"] : Array.from(new Set(visualPlan.cases.flatMap((item: any) => item.sourceFiles || []).concat(changeSet.changedFiles)));
    verifiers.push({
      id: `visual-suite-${sha256(visualPlan.cases.map((item: any) => item.configHash)).slice(0, 12)}`,
      kind: "visual",
      files: sourceFiles.length ? sourceFiles : ["**/*"], impacts: [], cacheable: false,
      run: async () => {
        visualExecution = await visualAdapter.run({ ...visualRequest, caseIds });
        const artifactRefs = (visualExecution.results || []).flatMap((row: any) => [row.actual?.artifactRef, ...(row.artifacts || [])]).filter(Boolean);
        return { ok: visualExecution.ok === true, error: visualExecution.ok === true ? "" : `visual-${visualExecution.status}`, artifacts: artifactRefs, visual: visualExecution, metrics: { visualCases: visualExecution.resultCount || 0, visualFailures: visualExecution.failureCount || 0, visualUnavailable: visualExecution.unavailableCount || 0 } };
      },
    });
  }
  verification = createVerificationAdapter(verifiers);
  let evidence: any;
  if (providerViolations.length) {
    evidence = { id: `proof_${sha256({ at: Date.now(), changeSetFingerprint: changeSet.fingerprint, providerViolations }).slice(0, 16)}`, ok: false, status: "required-provider-unavailable", reason: providerViolations.map((row: any) => row.reason).join("; "), createdAt: new Date().toISOString(), changeSet: { changedFiles: changeSet.changedFiles, fingerprint: changeSet.fingerprint }, impact: changeSet.impact, verifiers: [], confidence: 0, policy: { ok: false, violations: providerViolations } };
  } else if (!verifiers.length) {
    const nothingToVerify = !changeSet.changedFiles.length;
    const status = nothingToVerify ? "not-applicable" : "no-verifiers";
    const reason = nothingToVerify ? "no changed files - nothing to verify" : "no verifier commands discovered (coverage gap, fail-closed) - pin commands via /verify-baseline or add package scripts";
    evidence = { id: `proof_${sha256({ at: Date.now(), changeSetFingerprint: changeSet.fingerprint }).slice(0, 16)}`, ok: nothingToVerify ? null : false, status, reason, createdAt: new Date().toISOString(), changeSet: { changedFiles: changeSet.changedFiles, fingerprint: changeSet.fingerprint }, impact: changeSet.impact, verifiers: [], confidence: 0, policy: { ok: nothingToVerify, violations: nothingToVerify ? [] : [{ policy: "verifier-discovery", reason }] } };
  } else {
    // Approved removals are matched exactly by the architecture policy and recorded in the evidence.
    evidence = await verification.verify({ changeSet, cwd, patchSet: { id: `profile:${profile}`, changedFiles: changeSet.changedFiles }, acknowledgedPublicApiRemovals: input.acknowledgedPublicApiRemovals || [] });
  }
  if (!visualExecution) visualExecution = (evidence.verifiers || []).find((row: any) => row.kind === "visual")?.visual || null;
  evidence.visual = visualExecution ? { ...visualExecution, readiness: visualReadiness } : { schemaVersion: 1, ok: null, status: visualPlan.status, applicable: visualPlan.applicable, resultCount: 0, failureCount: 0, unavailableCount: visualPlan.cases.filter((item: any) => !item.readiness.ready).length, results: [], readiness: visualReadiness };
  const treeAfter = verification.captureTreeFingerprint(cwd);
  if (treeBefore.gatingSafe && treeAfter.gatingSafe && treeBefore.fingerprint !== treeAfter.fingerprint) {
    evidence.ok = false;
    evidence.status = "verifier-mutated-tree";
    evidence.reason = "a verifier changed the working tree during verification";
    evidence.policy = { ...(evidence.policy || {}), ok: false, violations: [...(evidence.policy?.violations || []), { policy: "verifier-read-only", reason: evidence.reason }] };
  }
  evidence.tree = treeAfter;
  evidence.executedCommands = commands.filter((command: CommandSpec) => (evidence.verifiers || []).some((verifier: any) => verifier.id === command.id && !verifier.cached && Number.isInteger(verifier.metrics?.exitCode) && verifier.metrics.exitCode >= 0)).map((command: CommandSpec) => ({ id: command.id, command: command.command, args: command.args || [] }));
  evidence.codegraph = codegraph;
  evidence.semgrep = semgrep;
  evidence.providerPolicy = providerPolicy;
  evidence.selectedTestImpact = { requestedRolloutMode: CODE_CONTEXT_MODE, rolloutMode: impact.rolloutMode, rolloutGate: impact.rolloutGate, promoted: promoteSelected, status: impact.status, baselinePolicy: impact.baselinePolicy, selectedTests: impact.selectedTests, selectedRuntimeMs: impact.selectedRuntimeMs, mustRun: impact.mustRun, highConfidence: impact.highConfidence, graphOnly: impact.graphOnly, historical: impact.historical, uncoveredRisk: impact.uncoveredRisk, commands: impact.commands };
  input.emitRetrieval?.("tests.executed", { strategyId: impact.strategyId, rolloutMode: impact.rolloutMode, runId: evidence.id, tests: verifiers.flatMap((verifier: any) => verifier.files || []), verifierCount: verifiers.length, passed: evidence.ok === true });
  input.emitRetrieval?.("verification.linked", { strategyId: impact.strategyId, rolloutMode: impact.rolloutMode, runId: evidence.id, evidenceId: evidence.id, changeFingerprint: changeSet.fingerprint, passed: evidence.ok === true });
  evidence.evidenceFile = join(stateRoot(cwd), "evidence", `${evidence.id}.json`);
  writeJson(evidence.evidenceFile, evidence);
  const latest = join(stateRoot(cwd), "latest.json");
  writeJson(latest, { profile, commands, evidence, writtenAt: new Date().toISOString() });
  return { profile, commands, codegraph, semgrep, visual: evidence.visual, providerPolicy, impact, evidence };
}
function latest(cwd: string) { return readJson(join(cwd, STATE_DIR, "latest.json"), null); }

export default function verificationCenter(pi: ExtensionAPI) {
  pi = require("../../../src/pi-extension-kit.js").instrumentExtensionCommands(pi) as ExtensionAPI;
  const emitRetrieval = (name: string, payload: any) => { try { pi.events?.emit?.("code-context:retrieval", { schemaVersion: 1, name, ...payload, payload }); } catch {} };
  if (!ENABLED) return;
  pi.registerCommand("verify-status", { description: "Show bounded verification center status", handler: async (_args: string, ctx: any) => {
    notify(ctx, JSON.stringify(verificationStatusView(ctx.cwd), null, 2), "info");
  }});
  pi.registerCommand("verify-plan", { description: "Show verifier plan for profile: quick|full|changed|learning", handler: async (args: string, ctx: any) => {
    const profile = ((args || "quick").trim() || "quick") as Profile;
    const impact = await verificationImpact(ctx.cwd, {});
    const files = Array.from(new Set([...impact.mustRun, ...impact.highConfidence, ...impact.graphOnly].map((edge: any) => edge.source).concat(impact.uncoveredRisk.map((risk: any) => risk.source))));
    const commands = discoverCommands(ctx.cwd, profile);
    const promoted = profile === "changed" && ["select-tests", "on"].includes(CODE_CONTEXT_MODE) ? [...commands, ...(impact.commands || [])] : commands;
    const visual = createVisualAdapter(ctx.cwd).plan({ profile, changedFiles: files });
    const security = securityCheckpointPlan(ctx.cwd, impact.changedPaths || files);
    notify(ctx, JSON.stringify({ profile, rolloutMode: CODE_CONTEXT_MODE, changedFiles: files, impact, commands: promoted, visual, security }, null, 2), "info");
  }});
  pi.registerCommand("verify-run", { description: "Run verification profile: quick|full|changed|learning", handler: async (args: string, ctx: any) => {
    const profile = ((args || "quick").trim() || "quick") as Profile; notify(ctx, `Running verification profile ${profile}…`, "info");
    const result = await verify(ctx.cwd, profile, { emitRetrieval });
    if (result.evidence.ok === false) setTurnExitCode(ctx);
    notify(ctx, formatEvidence(result.evidence), result.evidence.ok === false ? "warning" : "info");
  }});
  pi.registerCommand("verify-evidence", { description: "Show bounded details for the latest verification evidence", handler: async (_args: string, ctx: any) => {
    const l = latest(ctx.cwd); notify(ctx, l ? JSON.stringify(verificationEvidenceView(ctx.cwd, l.evidence, { detail: true }), null, 2) : "No verification evidence yet. Run /verify-run quick.", "info");
  }});
  pi.registerCommand("verify-baseline", { description: "Write a lightweight verification baseline from current plan", handler: async (_args: string, ctx: any) => {
    const baseline = { at: new Date().toISOString(), cwd: ctx.cwd, quick: discoverCommands(ctx.cwd, "quick"), full: discoverCommands(ctx.cwd, "full") };
    const file = join(stateRoot(ctx.cwd), "baseline.json"); writeJson(file, baseline); notify(ctx, `Wrote ${relative(ctx.cwd, file)}`, "info");
  }});
  pi.registerCommand("verify-doctor", { description: "Diagnose verifier discovery and evidence state", handler: async (_args: string, ctx: any) => {
    const l = latest(ctx.cwd); const pkg = existsSync(join(ctx.cwd, "package.json"));
    notify(ctx, JSON.stringify({ packageJson: pkg, scripts: packageScripts(ctx.cwd), checkAll: existsSync(join(ctx.cwd, "scripts", "check-all.sh")), quickCommands: discoverCommands(ctx.cwd, "quick"), fullCommands: discoverCommands(ctx.cwd, "full"), latestOk: l?.evidence?.ok, stateDir: join(ctx.cwd, STATE_DIR) }, null, 2), "info");
  }});
  pi.registerCommand("verify-policy", { description: "Show verification policy defaults", handler: async (_args: string, ctx: any) => notify(ctx, JSON.stringify({ requiredKinds: [], failOnAnyVerifierFailure: true, evidenceRequiredForClaims: true, optionalProviders: ["codegraph", "semgrep", "visual"], providerDefault: "degraded-advisory", explicitGateInput: { requiredProviders: ["codegraph", "semgrep", "visual"] }, baselineMutation: "separate-command-only-script", profiles: ["quick", "changed", "full", "learning"], timeoutMs: DEFAULT_TIMEOUT_MS }, null, 2), "info") });
  pi.registerCommand("verify-watch", { description: "Show watch-mode guidance (non-blocking by default)", handler: async (_args: string, ctx: any) => notify(ctx, "Verification watch is intentionally manual/non-blocking in this extension. Use /verify-run changed after edits, or enable existing PI_COGNITIVE_AUTO_VERIFY=1 for debounced automatic verification.", "info") });

  pi.registerTool({ name: "verification_center", label: "Verification center", description: "Plan, run, inspect, and diagnose proof-producing project verification. CodeGraph, Semgrep, and Visual Verification are degraded advisory providers unless input.requiredProviders explicitly selects them as gates. Owner-approved public API removals are passed as input.acknowledgedPublicApiRemovals [{file, symbol, reason}], matched exactly and recorded in the evidence. Baseline mutation is not exposed.", parameters: Type.Object({ operation: Type.Optional(Type.Union([Type.Literal("status"), Type.Literal("plan"), Type.Literal("run"), Type.Literal("evidence"), Type.Literal("doctor"), Type.Literal("policy")])), profile: Type.Optional(Type.Union([Type.Literal("quick"), Type.Literal("full"), Type.Literal("changed"), Type.Literal("learning")])), input: Type.Optional(Type.Any()) }), async execute(_id: string, params: any, _signal: any, _update: any, ctx: any) {
    const op = params.operation || "status";
    const input: Record<string, any> = parseObjectInput(params.input, "verification_center");
    if (op === "run") { const result = await verify(ctx.cwd, params.profile || "quick", { ...input, emitRetrieval }); return { content: [{ type: "text", text: formatEvidence(result.evidence) }], details: result }; }
    if (op === "plan") {
      const impact = await verificationImpact(ctx.cwd, input);
      const baseCommands = discoverCommands(ctx.cwd, params.profile || "quick");
      const commands = params.profile === "changed" && ["select-tests", "on"].includes(CODE_CONTEXT_MODE) ? [...baseCommands, ...(impact.commands || [])] : baseCommands;
      const visual = createVisualAdapter(ctx.cwd).plan({ ...(input.visual || {}), profile: params.profile || "quick", changedFiles: impact.changedPaths || [] });
      const security = securityCheckpointPlan(ctx.cwd, impact.changedPaths || [], { required: normalizeRequiredProviders(input.requiredProviders).includes("semgrep") });
      const details = { profile: params.profile || "quick", rolloutMode: CODE_CONTEXT_MODE, commands, visual, security, impact, baselinePolicy: impact.baselinePolicy };
      return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
    }
    if (op === "evidence") { const details = verificationEvidenceView(ctx.cwd, latest(ctx.cwd)?.evidence, { detail: input.detail === true, limit: input.limit }); return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }; }
    if (op === "doctor" || op === "status") { const details = verificationStatusView(ctx.cwd, { detail: input.detail === true, limit: input.limit }); return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }; }
    return { content: [{ type: "text", text: JSON.stringify({ requiredKinds: [], failOnAnyVerifierFailure: true }, null, 2) }], details: undefined };
  }});
}
