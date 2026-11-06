#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { classifyRoleIntent, evaluateRouterCorpus } = require("../src/role-router");
const { messageDiagnostics, validateRpcCompletion } = require("../src/subagent-result-validator");
const { sha256, runtimeSourceFingerprint } = require("../src/runtime-source-fingerprint");

const READ_ONLY_P95_BAR_MS = 120000;
const LEGACY_READ_ONLY_BASELINE_MS = 300000;

function ratio(numerator, denominator) { return denominator ? Number((numerator / denominator).toFixed(6)) : 0; }
function weightedTotal(cases) { return cases.reduce((sum, item) => sum + Math.max(1, Number(item.weight || 1)), 0); }
function weightedCount(cases, predicate) { return cases.reduce((sum, item) => sum + (predicate(item) ? Math.max(1, Number(item.weight || 1)) : 0), 0); }
function weightedValues(cases, field) { return cases.flatMap((item) => Array.from({ length: Math.max(1, Number(item.weight || 1)) }, () => Number(item[field] || 0))); }
function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))];
}
function latencySummary(cases) {
  const summarize = (field) => { const values = weightedValues(cases, field); return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }; };
  return { queue: summarize("queueMs"), execution: summarize("executionMs"), total: summarize("totalMs") };
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function readMessages(file) {
  const rows = fs.readFileSync(file, "utf8").split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
  return rows.filter((row) => row?.type === "message" && row.message).map((row) => row.message);
}
function routerMacroRecall(corpus) {
  const byIntent = new Map();
  for (const item of corpus) {
    const row = byIntent.get(item.intent) || { total: 0, correct: 0 };
    row.total += 1;
    if (classifyRoleIntent(item.prompt).intent === item.intent) row.correct += 1;
    byIntent.set(item.intent, row);
  }
  const recalls = [...byIntent.values()].map((row) => ratio(row.correct, row.total));
  return recalls.length ? Number((recalls.reduce((sum, value) => sum + value, 0) / recalls.length).toFixed(6)) : 1;
}
function roleRates(cases) {
  const groups = new Map();
  for (const item of cases) {
    const key = `${item.roleId || "unknown"}@${item.contractVersion || "unknown"}`;
    const row = groups.get(key) || { roleId: item.roleId || "unknown", contractVersion: item.contractVersion || "unknown", total: 0, succeeded: 0 };
    const weight = Math.max(1, Number(item.weight || 1));
    row.total += weight;
    if (item.status === "succeeded") row.succeeded += weight;
    groups.set(key, row);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, { ...value, validCompletionRate: ratio(value.succeeded, value.total) }]));
}

function evaluatePromotionBars(metrics) {
  const gate = (passed, measured, bar) => ({ passed: Boolean(passed), measured, bar });
  const gates = {
    executionTruth: gate(metrics.execution.falseSuccesses === 0, metrics.execution.falseSuccesses, "zero false successes and false failures in deterministic terminal fixtures"),
    budgetEnforcement: gate(metrics.budgets.unreportedOverruns === 0 && metrics.budgets.boundedParallelOvershoot === 0, metrics.budgets, "zero unreported overruns; bounded batch overshoot only"),
    toolDiagnostics: gate(metrics.tools.callResultParity === true, metrics.tools, "exact call/result parity with explicit unmatched IDs"),
    policy: gate(metrics.policy.forbiddenToolCalls === 0 && metrics.policy.unavailableToolLaunches === 0, metrics.policy, "zero forbidden calls and unavailable-tool launches"),
    isolation: gate(metrics.isolation.parentMutationsBeforeApply === 0, metrics.isolation.parentMutationsBeforeApply, "zero parent mutations before explicit apply"),
    typedOutputs: gate(metrics.typedOutputs.succeededValidityRate === 1, metrics.typedOutputs.succeededValidityRate, "100% schema-valid succeeded runs"),
    readOnlyReliability: gate(metrics.readOnly.validCompletionRate >= 0.9 && metrics.readOnly.timeoutRate <= 0.05, metrics.readOnly, "completion >= 90%; timeout <= 5%"),
    mutationReliability: gate(metrics.mutation.expectedPatchAndVerificationRate >= 0.9, metrics.mutation.expectedPatchAndVerificationRate, "expected patch and verification >= 90%"),
    topologyControls: gate(metrics.topology.correctDecisionRate === 1, metrics.topology.correctDecisionRate, "all known-defect and clean controls classified correctly"),
    router: gate(metrics.router.precision >= 0.9 && metrics.router.noAutoExecutionRate === 1, metrics.router, "precision >= 90%; forbidden/opt-out auto execution = 0"),
    latency: gate(metrics.latency.readOnly.total.p95 < READ_ONLY_P95_BAR_MS && metrics.latency.readOnly.total.p95 < LEGACY_READ_ONLY_BASELINE_MS && metrics.latency.mutation.total.p95 <= metrics.latency.mutatingP95BarMs, metrics.latency, `read-only p95 < ${READ_ONLY_P95_BAR_MS}ms and mutation p95 within preregistered bar`),
    privacy: gate(metrics.privacy.findings === 0 && metrics.privacy.transcriptFindings === 0 && metrics.privacy.secretFindings === 0, metrics.privacy, "zero privacy, transcript, or secret findings"),
    regression: { passed: null, measured: null, bar: "full harness, Pi fork, and TUI/RPC suites pass", externalVerificationRequired: true },
    realProjectPilot: { passed: false, measured: null, bar: "bounded opt-in real-project pilot after deterministic gates", optInRequired: true },
  };
  const deterministic = ["executionTruth", "budgetEnforcement", "toolDiagnostics", "policy", "isolation", "typedOutputs", "readOnlyReliability", "mutationReliability", "topologyControls", "router", "latency", "privacy"];
  const overallPassed = deterministic.every((name) => gates[name].passed === true);
  let maxEligibleStage = "R0";
  if (["executionTruth", "budgetEnforcement", "toolDiagnostics", "policy", "typedOutputs", "readOnlyReliability", "privacy"].every((name) => gates[name].passed)) maxEligibleStage = "R1";
  if (maxEligibleStage === "R1" && ["isolation", "mutationReliability"].every((name) => gates[name].passed)) maxEligibleStage = "R2";
  if (maxEligibleStage === "R2" && gates.topologyControls.passed) maxEligibleStage = "R3";
  if (maxEligibleStage === "R3" && gates.router.passed) maxEligibleStage = "R4";
  if (maxEligibleStage === "R4" && gates.realProjectPilot.passed) maxEligibleStage = "R5";
  return { overallPassed, maxEligibleStage, gates };
}

function runFixtureBenchmark({ manifest: manifestPath, now = new Date().toISOString(), cwd = path.resolve(__dirname, "..") } = {}) {
  if (!manifestPath) throw new Error("fixture manifest is required");
  const absoluteManifest = path.resolve(manifestPath);
  const manifest = readJson(absoluteManifest);
  if (manifest?.schemaVersion !== 1 || manifest?.benchmark !== "pi-role-runtime-v2") throw new Error("unsupported role runtime fixture manifest");
  const fixtureRoot = path.dirname(absoluteManifest);
  const rpcOutcomes = [];
  let actualToolCalls = 0;
  let actualToolResults = 0;
  let toolFailures = 0;
  const unmatchedToolCallIds = [];
  const unmatchedToolResultIds = [];
  for (const item of manifest.rpcCases || []) {
    const messages = readMessages(path.resolve(fixtureRoot, item.file));
    const diagnostics = messageDiagnostics(messages);
    const validation = validateRpcCompletion({ agentEnd: { type: "agent_end" }, messages, budget: item.budget || {} });
    actualToolCalls += diagnostics.toolCalls;
    actualToolResults += diagnostics.toolResults;
    toolFailures += diagnostics.toolFailures;
    unmatchedToolCallIds.push(...diagnostics.unmatchedToolCallIds.map((id) => `${item.id}:${id}`));
    unmatchedToolResultIds.push(...diagnostics.unmatchedToolResultIds.map((id) => `${item.id}:${id}`));
    rpcOutcomes.push({ id: item.id, roleId: item.roleId, expectedOk: item.expectedOk, actualOk: validation.ok, expectedTermination: item.expectedTermination, actualTermination: validation.termination?.code || null, modelCalls: diagnostics.modelCalls, toolCalls: diagnostics.toolCalls, toolResults: diagnostics.toolResults, matched: validation.ok === item.expectedOk && validation.termination?.code === item.expectedTermination });
  }
  const readOnly = manifest.readOnlyCases || [];
  const mutation = manifest.mutationCases || [];
  const topology = manifest.topologyCases || [];
  const taskCases = [...readOnly, ...mutation];
  const succeeded = taskCases.filter((item) => item.status === "succeeded");
  const succeededWeight = weightedTotal(succeeded);
  const acceptedCost = succeeded.reduce((sum, item) => sum + Number(item.cost || 0) * Math.max(1, Number(item.weight || 1)), 0);
  const acceptedTokens = succeeded.reduce((sum, item) => sum + Number(item.tokens || 0) * Math.max(1, Number(item.weight || 1)), 0);
  const routerCorpus = readJson(path.resolve(fixtureRoot, manifest.routerCorpus));
  const router = evaluateRouterCorpus(routerCorpus);
  const readTotal = weightedTotal(readOnly);
  const mutationTotal = weightedTotal(mutation);
  const topologyTotal = weightedTotal(topology);
  const metrics = {
    execution: {
      deterministicRpcCases: rpcOutcomes.length,
      falseSuccesses: rpcOutcomes.filter((item) => item.actualOk && !item.expectedOk).length,
      falseFailures: rpcOutcomes.filter((item) => !item.actualOk && item.expectedOk).length,
      terminalMatches: rpcOutcomes.filter((item) => item.matched).length,
      outcomes: rpcOutcomes,
      validCompletionRateByRole: roleRates(taskCases),
    },
    budgets: {
      actualModelCalls: taskCases.reduce((sum, item) => sum + Number(item.modelCalls || 0) * Math.max(1, Number(item.weight || 1)), 0),
      actualToolCalls: taskCases.reduce((sum, item) => sum + Number(item.toolCalls || 0) * Math.max(1, Number(item.weight || 1)), 0),
      unreportedOverruns: Number(manifest.policy?.unreportedBudgetOverruns || 0),
      boundedParallelOvershoot: Number(manifest.policy?.boundedParallelOvershoot || 0),
    },
    tools: { actualToolCalls, actualToolResults, toolFailures, unmatchedToolCallIds, unmatchedToolResultIds, callResultParity: actualToolCalls === actualToolResults + unmatchedToolCallIds.length && actualToolResults === actualToolCalls + unmatchedToolResultIds.length },
    policy: { forbiddenToolCalls: Number(manifest.policy?.forbiddenToolCalls || 0), unavailableToolLaunches: Number(manifest.policy?.unavailableToolLaunches || 0) },
    isolation: { parentMutationsBeforeApply: Number(manifest.policy?.parentMutationsBeforeApply || 0), checkedFinalStates: mutationTotal },
    typedOutputs: { succeededRuns: succeededWeight, schemaValidSucceededRuns: weightedCount(succeeded, (item) => item.typedOutputValid === true), succeededValidityRate: ratio(weightedCount(succeeded, (item) => item.typedOutputValid === true), succeededWeight), evidenceCompleteRate: ratio(weightedCount(succeeded, (item) => item.evidenceComplete === true), succeededWeight) },
    readOnly: { total: readTotal, succeeded: weightedCount(readOnly, (item) => item.status === "succeeded"), timedOut: weightedCount(readOnly, (item) => item.status === "timed_out"), cancelled: weightedCount(readOnly, (item) => item.status === "cancelled"), validCompletionRate: ratio(weightedCount(readOnly, (item) => item.status === "succeeded" && item.typedOutputValid && item.evidenceComplete), readTotal), timeoutRate: ratio(weightedCount(readOnly, (item) => item.status === "timed_out"), readTotal), cancellationRate: ratio(weightedCount(readOnly, (item) => item.status === "cancelled"), readTotal) },
    mutation: { total: mutationTotal, expectedPatchMatches: weightedCount(mutation, (item) => item.expectedPatchMatch === true), verificationPasses: weightedCount(mutation, (item) => item.verificationPassed === true), expectedPatchAndVerificationRate: ratio(weightedCount(mutation, (item) => item.expectedPatchMatch === true && item.verificationPassed === true), mutationTotal), patchOutcomes: Object.fromEntries([...new Set(mutation.map((item) => item.patchOutcome))].filter(Boolean).sort().map((outcome) => [outcome, weightedCount(mutation, (item) => item.patchOutcome === outcome)])) },
    topology: { total: topologyTotal, correctDecisions: weightedCount(topology, (item) => item.expected === item.observed && item.evidenceComplete), correctDecisionRate: ratio(weightedCount(topology, (item) => item.expected === item.observed && item.evidenceComplete), topologyTotal) },
    router: { precision: router.precision, recall: routerMacroRecall(routerCorpus), noAutoExecutionRate: router.optOutViolations === 0 && router.forbiddenAutomaticExecutions === 0 ? 1 : 0, optOutViolations: router.optOutViolations, forbiddenAutomaticExecutions: router.forbiddenAutomaticExecutions, corpusCases: router.total },
    latency: { readOnly: latencySummary(readOnly), mutation: latencySummary(mutation), readOnlyBaselineMs: LEGACY_READ_ONLY_BASELINE_MS, mutatingP95BarMs: Number(manifest.policy?.mutatingP95BarMs || 0) },
    human: { corrections: Number(manifest.policy?.humanCorrections || 0), rejections: Number(manifest.policy?.humanRejections || 0), correctionRate: ratio(Number(manifest.policy?.humanCorrections || 0), readTotal + mutationTotal), rejectionRate: ratio(Number(manifest.policy?.humanRejections || 0), readTotal + mutationTotal) },
    efficiency: { acceptedResults: succeededWeight, tokensPerAcceptedResult: ratio(acceptedTokens, succeededWeight), costPerAcceptedResult: ratio(acceptedCost, succeededWeight) },
    retention: { diskGrowthBytes: Number(manifest.policy?.diskGrowthBytes || 0), retainedRecoveryBytes: Number(manifest.policy?.retainedRecoveryBytes || 0) },
    privacy: { findings: Number(manifest.policy?.privacyFindings || 0), transcriptFindings: Number(manifest.policy?.transcriptFindings || 0), secretFindings: Number(manifest.policy?.secretFindings || 0) },
  };
  const promotion = evaluatePromotionBars(metrics);
  const runtimeSource = runtimeSourceFingerprint(cwd);
  return { schemaVersion: 1, benchmark: manifest.benchmark, fixtureVersion: manifest.fixtureVersion, fixtureOnly: true, generatedAt: now, manifestHash: sha256(manifest), runtimeSourceHash: runtimeSource.hash, runtimeFileCount: runtimeSource.fileCount, cohorts: { rpc: rpcOutcomes.length, readOnly: readTotal, mutation: mutationTotal, topology: topologyTotal, router: router.total }, metrics, promotion };
}

function parseArgs(argv) {
  const options = { fixtureOnly: false, manifest: path.join(__dirname, "..", "tests", "fixtures", "role-runtime", "manifest.json"), output: null, help: false };
  let manifestExplicit = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => { if (index + 1 >= argv.length) throw new Error(`missing value after ${arg}`); return argv[++index]; };
    if (arg === "--fixture-only") options.fixtureOnly = true;
    else if (arg === "--manifest") { options.manifest = next(); manifestExplicit = true; }
    else if (arg.startsWith("--manifest=")) { options.manifest = arg.slice(11); manifestExplicit = true; }
    else if (arg === "--output") options.output = next();
    else if (arg.startsWith("--output=")) options.output = arg.slice(9);
    else if (arg === "--real-project") throw new Error("real-project pilots are opt-in and unavailable from the fixture-only benchmark; preregister a separate bounded pilot");
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (manifestExplicit) options.manifest = options.manifest;
  return options;
}
function ensurePrivateDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const stat = fs.lstatSync(dir); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`benchmark output directory is unsafe: ${dir}`); fs.chmodSync(dir, 0o700); }
function writePrivateReport(file, report) { const absolute = path.resolve(file); ensurePrivateDir(path.dirname(absolute)); fs.writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); fs.chmodSync(absolute, 0o600); return absolute; }

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write("Usage: benchmark-role-runtime.js --fixture-only [--manifest FILE] [--output FILE]\n"); process.exit(0); }
    if (!options.fixtureOnly) throw new Error("--fixture-only is required; real-project pilots require separate explicit opt-in");
    const report = runFixtureBenchmark({ manifest: options.manifest });
    const output = options.output ? writePrivateReport(options.output, report) : null;
    process.stdout.write(`${JSON.stringify({ verdict: report.promotion.overallPassed ? "pass" : "fail", maxEligibleStage: report.promotion.maxEligibleStage, manifestHash: report.manifestHash, output })}\n`);
    if (!report.promotion.overallPassed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { READ_ONLY_P95_BAR_MS, LEGACY_READ_ONLY_BASELINE_MS, percentile, latencySummary, evaluatePromotionBars, runFixtureBenchmark, parseArgs, writePrivateReport };
