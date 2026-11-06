#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { MANIFEST, digest, prepareTask, observedFiles, checkAnswer, benchmarkOptions } = require("../src/codemode-benchmark");
const { TRIALS, TOTAL_CASES, createPhaseMeasurements, tokenUsage, armOrder, trialTasks, summarizePhases } = require("../src/codemode-phase-benchmark");
const { sourceDigest, protectedDigest, save, treeBytes, liveInference } = require("./benchmark-codemode");
const { installedRuntime, createRuntime } = require("../tests/helpers/codemode-runtime");
const ledger = require("../src/experiment-ledger");
const root = path.resolve(__dirname, "..");
const BUDGETS = Object.freeze({ evidenceBytes: 64 * 1024 * 1024, fixtureBytes: 128 * 1024 * 1024, reportedCost: 5, elapsedMs: 45 * 60 * 1000, caseMs: 120000 });
const HISTORICAL = [".pi/codemode-benchmark", ".pi/codemode-release-review", ".pi/experiment-ledger", ".pi/debug-ledger"];
const ENV_KEYS = ["PI_CODEMODE", "PI_TOOL_SURFACE_ROUTER", "PI_OUTPUT_COMPACTOR", "PI_OUTPUT_COMPACTOR_MODE", "PI_OUTPUT_COMPACTOR_MAX_CHARS", "PI_POLICY_ENFORCER", "PI_POLICY_ENFORCER_MODE", "PI_EXTENSION_TELEMETRY", "PI_DOCS_ALLOW_OUTSIDE"];
function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).sort().flatMap(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw Object.assign(new Error("Unexpected artifact symlink"), { code: "UNSAFE_ARTIFACT" });
    return stat.isDirectory() ? filesUnder(file) : [file];
  });
}
function fileDigest(files) { return digest(files.map(file => [path.relative(root, file), digest(fs.readFileSync(file))])); }
function environment() { return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key] ?? null])); }
function optionsFor(argv, env = process.env) {
  const options = benchmarkOptions(argv, env);
  if (options.mode !== "live" || options["resume-unstarted"]) throw new Error("Phase trials require --live; no synthetic performance or historical continuation");
  if (env.PI_CODEMODE === "0") throw new Error("Phase trials must retain default-on CodeMode");
  return options;
}

async function main() {
  const options = optionsFor(process.argv.slice(2));
  const { sdk, root: sdkRoot } = await installedRuntime();
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent");
  const historyRoot = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim().replace(/[\/]\.git$/, "");
  const existing = [...ledger.listExperiments(root, { status: "open" }), ...ledger.listExperiments(historyRoot, { status: "open" })];
  if (existing.some(row => /codemode.*phase.*timing/i.test(row.title))) throw new Error("Inspect existing phase experiment instead of retrying");
  const parent = path.join(root, ".pi/codemode-phase-benchmark");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(parent).some(name => name.startsWith("live-"))) throw new Error("Phase cohort already exists; do not replay it");
  const ownedRoots = [parent, path.join(root, ".pi/codemode-benchmark"), path.join(root, ".pi/codemode-release-review")];
  const retainedBytes = () => ownedRoots.reduce((sum, dir) => sum + (fs.existsSync(dir) ? treeBytes(dir) : 0), 0);
  if (fs.statfsSync(parent).bavail * fs.statfsSync(parent).bsize < 256 * 1024 * 1024 || retainedBytes() > BUDGETS.evidenceBytes) throw new Error("Insufficient artifact headroom");
  const historicalFiles = HISTORICAL.flatMap(name => filesUnder(path.join(root, name)));
  const historicalBefore = fileDigest(historicalFiles), protectedBefore = protectedDigest(agentDir, historyRoot), sourceBefore = sourceDigest(), envBefore = environment();
  const piEntry = require.resolve(sdkRoot), piBefore = digest(fs.readFileSync(piEntry));
  const run = path.join(parent, `live-${Date.now()}`);
  fs.mkdirSync(run, { mode: 0o700 });
  const protocol = {
    version: 1, kind: "phase-timed-follow-up", userAuthorization: "New comparable trials requested; default-on unchanged; frozen historical cases are not resumed or replaced",
    provider: options.provider, model: options.model, thinkingLevel: options.thinking, piVersion: sdk.VERSION, piEntryDigest: piBefore,
    sourceDigest: sourceBefore, historicalDigest: historicalBefore, historicalFiles: historicalFiles.map(file => path.relative(root, file)), protectedDigest: protectedBefore, environment: envBefore,
    manifest: MANIFEST, manifestDigest: digest(MANIFEST), trials: TRIALS, exactCases: TOTAL_CASES, order: "Trial0 original order; trial1 rotates first stratum to the end; arm order reversed for every matched task in trial1", retries: 0,
    settings: { compaction: { enabled: false }, retry: { enabled: false }, codemode: { mode: "on" } }, tools: ["read", "docs_lookup", "code_context", "codemode"],
    budgets: BUDGETS, phases: {
      primary: "prompt() start to resolution; setup, integrity/accounting and cleanup measured separately",
      model: "context_with_system to finalized assistant message, per turn; pre-request, request-to-first normalized content delta, delta-to-end; HTTP response headers nullable",
      tools: "Monotonic session lifecycle intervals; parallel calls unioned, nested time never added twice to the outer tool",
      codemode: "Outer CodeMode union minus nested-tool union: startup/JS/discovery/serialization/hooks, NOT pure QuickJS time",
      residual: "Prompt wall minus union of model/top-level-tool intervals; overlap reported separately",
      tokens: "Provider-reported normalized uncached input/cache reads/cache writes/output; reasoning is a subset of output; input-including-cache and total computed without double counting; SDK total cross-checked",
    },
    targets: { latency: "Both trials and pooled prompt p95 ratio <=1.10; legacy-inclusive wall reported separately", context: "Pooled composed-task character/4 transcript context ratio <=0.75", cost: "Pooled provider-reported cost ratio <=1.10", integrity: "All120 exact oracle/evidence passes; no tool/provider errors; complete timing and token coverage; frozen/protected/source digests unchanged" },
    interpretation: "Phase means/tail cases are observational attribution, not causal VM/model ablations. No population noninferiority or general-field claim from repeated synthetic templates. Missing fields remain unknown. No automatic enablement decision.",
  };
  save(path.join(run, "protocol.json"), protocol);
  const experiment = ledger.openExperiment(root, "CodeMode phase timing 2026-10-24", { hypothesis: "Provider/model generation and extra tool choices, rather than host VM time, dominate the observed CodeMode p95 regression; measure real token differences separately from character estimates", arms: ["direct current loadout", "same loadout plus governed hybrid CodeMode"], bars: [`Protocol SHA256 ${digest(protocol)}`, JSON.stringify(protocol), "Two preregistered trials,60 matched pairs/120 fresh sessions; no retries, fallback, source edits or historical rewrites", "Quality/timing/token integrity gates and performance targets are separate; report both trial-specific and pooled results", "Retain metadata only; <=64MiB across all owned evidence roots, <=128MiB fixtures, <=USD5 reported cost stop before next case, <=45 minutes; preserve failures"] });
  const intact = () => sourceDigest() === sourceBefore && protectedDigest(agentDir, historyRoot) === protectedBefore && fileDigest(historicalFiles) === historicalBefore && digest(environment()) === digest(envBefore) && digest(fs.readFileSync(piEntry)) === piBefore;
  const rows = [], attempts = [];
  let blocked = null;
  const began = performance.now();
  try {
    const inference = await liveInference(sdk, { provider: options.provider, modelId: options.model, thinkingLevel: options.thinking, agentDir, run });
    for (let trial = 0; trial < TRIALS; trial++) for (const task of trialTasks(trial)) {
      const cwd = path.join(run, "fixtures", `trial-${trial}`, task.id), prepared = prepareTask(task, cwd);
      let pairPassed = true;
      for (const arm of armOrder(MANIFEST.indexOf(task), trial)) {
        if (performance.now() - began > BUDGETS.elapsedMs || rows.reduce((sum, row) => sum + (row.reportedCost || 0), 0) >= BUDGETS.reportedCost) throw Object.assign(new Error("Run budget reached"), { code: "RUN_BUDGET" });
        if (retainedBytes() > BUDGETS.evidenceBytes || (fs.existsSync(path.join(run, "fixtures")) && treeBytes(path.join(run, "fixtures")) > BUDGETS.fixtureBytes)) throw Object.assign(new Error("Storage bound"), { code: "STORAGE_BOUND" });
        if (!intact()) throw Object.assign(new Error("Integrity drift"), { code: "INTEGRITY_DRIFT" });
        const phases = createPhaseMeasurements();
        const setupStarted = performance.now();
        const runtime = await createRuntime({ cwd, inference, settings: protocol.settings, tools: protocol.tools, excludeTools: arm === "direct" ? ["codemode"] : [], extensionFactories: [pi => {
          phases.install(pi);
          pi.on("tool_call", event => {
            if (event.toolName === "read") {
              const file = path.relative(cwd, path.resolve(cwd, String(event.input.path || "").replace(/^@/, "")));
              if (!Object.hasOwn(prepared.files, file)) return { block: true, reason: "Phase trial reads are confined to frozen fixture files" };
            }
          });
        }] });
        const setupMs = performance.now() - setupStarted;
        const unsubscribe = runtime.session.subscribe(phases.observe);
        let row;
        try {
          if (runtime.session.model.provider !== options.provider || runtime.session.model.id !== options.model || runtime.session.thinkingLevel !== options.thinking || runtime.session.getActiveToolNames().includes("codemode") !== (arm === "codemode")) throw Object.assign(new Error("Inference/loadout drift"), { code: "INFERENCE_DRIFT" });
          const assignment = { trial, id: task.id, arm, ordinal: attempts.length };
          save(path.join(run, `r${trial}-${task.id}-${arm}.assigned.json`), assignment);
          attempts.push(assignment);
          let timedOut = false, promptFailed = false;
          const deadline = setTimeout(() => { timedOut = true; void runtime.session.abort(); }, BUDGETS.caseMs);
          phases.start();
          try { await runtime.session.prompt(prepared.prompt); } catch { promptFailed = true; }
          finally { phases.finish(); clearTimeout(deadline); }
          const postStarted = performance.now();
          const messages = runtime.session.messages.filter(message => message.role === "assistant");
          const answer = (messages.at(-1)?.content || []).filter(item => item.type === "text").map(item => item.text).join("");
          const ended = runtime.events.filter(event => event.type === "tool_execution_end"), starts = runtime.events.filter(event => event.type === "tool_execution_start");
          const integrity = Object.entries(prepared.files).every(([file, bytes]) => fs.readFileSync(path.join(cwd, file), "utf8") === bytes) && intact();
          const costs = messages.map(message => message.usage?.cost?.total);
          row = { trial, id: task.id, kind: task.kind, arm, fixtureDigest: prepared.fixtureDigest, oracle: checkAnswer(answer, prepared, observedFiles(runtime.events, cwd)), integrity, timedOut, providerError: promptFailed || timedOut || messages.some(message => ["error", "aborted"].includes(message.stopReason)), toolFailures: ended.filter(event => event.isError).length, modelTurns: messages.length, underlyingToolAttempts: starts.filter(event => event.toolName !== "codemode").length, generatedCodeChars: messages.reduce((sum, message) => sum + (message.content || []).filter(item => item.type === "toolCall" && item.name === "codemode").reduce((n, item) => n + String(item.arguments?.code || "").length, 0), 0), tokens: tokenUsage(messages), phases: phases.snapshot(), setupMs, reportedCost: costs.length && costs.every(Number.isFinite) ? costs.reduce((a, b) => a + b, 0) : null };
          row.postprocessMs = performance.now() - postStarted;
          row.spills = [];
          for (const spill of new Set(ended.filter(event => event.toolName === "codemode").map(event => event.result?.details?.fullOutputPath).filter(Boolean))) {
            if (path.dirname(spill) !== os.tmpdir() || !/^pi-codemode-[a-f0-9]{16}\.txt$/.test(path.basename(spill)) || !fs.lstatSync(spill).isFile() || fs.lstatSync(spill).isSymbolicLink() || (fs.statSync(spill).mode & 0o077)) throw Object.assign(new Error("Unexpected native spill"), { code: "SPILL_IDENTITY" });
            const bytes = fs.statSync(spill).size, keep = !row.oracle.ok || !row.integrity || row.providerError || row.toolFailures > 0;
            row.spills.push({ bytes, digest: digest(fs.readFileSync(spill)), retained: keep });
            if (keep) {
              if (retainedBytes() + bytes > BUDGETS.evidenceBytes) throw Object.assign(new Error("Spill preserved at native path"), { code: "STORAGE_BOUND" });
              const target = path.join(run, `r${trial}-${task.id}-${arm}-spill-${row.spills.length}.txt`);
              fs.copyFileSync(spill, target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
            }
            fs.unlinkSync(spill);
          }
        } finally {
          unsubscribe(); const cleanupStarted = performance.now(); await runtime.close(); if (row) row.cleanupMs = performance.now() - cleanupStarted;
        }
        rows.push(row); save(path.join(run, `r${trial}-${task.id}-${arm}.json`), row);
        pairPassed &&= row.oracle.ok && row.integrity && !row.providerError && row.toolFailures === 0;
        console.log(`phase r${trial} ${task.id} ${arm}: ${row.providerError ? "provider-error" : row.oracle.ok ? "oracle-pass" : "oracle-fail"}; prompt=${row.phases.promptMs} model=${row.phases.modelPipelineMs} tools=${row.phases.topToolWallMs} tokens=${row.tokens.total}`);
        if (!row.integrity || row.providerError) throw Object.assign(new Error("Required observation boundary"), { code: !row.integrity ? "INTEGRITY_DRIFT" : row.timedOut ? "CASE_TIMEOUT" : "PROVIDER_ERROR" });
      }
      if (pairPassed) fs.rmSync(cwd, { recursive: true });
    }
  } catch (error) { blocked = /^[A-Z_]+$/.test(String(error.code || "")) ? error.code : "RUNTIME_FAILURE"; }
  const stamps = { sourceUnchanged: sourceDigest() === sourceBefore, historicalUnchanged: fileDigest(historicalFiles) === historicalBefore, protectedUnchanged: protectedDigest(agentDir, historyRoot) === protectedBefore, environmentUnchanged: digest(environment()) === digest(envBefore), piUnchanged: digest(fs.readFileSync(piEntry)) === piBefore };
  const measuredKeys = new Set(rows.map(row => `${row.trial}:${row.id}:${row.arm}`));
  const summary = { ...summarizePhases(rows), experimentId: experiment.experimentId, blocked, ...stamps, integrityComplete: Object.values(stamps).every(Boolean), attemptedCases: attempts.length, unrunCases: TOTAL_CASES - attempts.length, unmeasuredAttempts: attempts.filter(row => !measuredKeys.has(`${row.trial}:${row.id}:${row.arm}`)) };
  summary.supportsBoundedMerge &&= summary.integrityComplete && !blocked;
  save(path.join(run, "summary.json"), summary);
  ledger.recordGate(root, experiment.experimentId, { gate: "quality-and-measurement", verdict: blocked ? "partial" : summary.quality && summary.timingComplete && summary.tokensComplete && summary.integrityComplete ? "pass" : "fail", gpuHours: 0, metrics: JSON.stringify({ executed: rows.length, unrun: summary.unrunCases, quality: summary.quality, timing: summary.timingComplete, tokens: summary.tokensComplete }), note: blocked || "Phase intervals and normalized provider token counts observed; no field noninferiority claim" });
  ledger.recordGate(root, experiment.experimentId, { gate: "performance-targets", verdict: !summary.complete ? "null-result" : Object.values(summary.targets).every(value => value === true) ? "pass" : Object.values(summary.targets).some(value => value === false) ? "fail" : "null-result", gpuHours: 0, metrics: JSON.stringify(summary.targets), note: "Both-trial and pooled p95, pooled composed context and reported cost bars; default-on unchanged regardless of outcome" });
  console.log(JSON.stringify({ run: path.relative(root, run), executed: rows.length, blocked, quality: summary.quality, timingComplete: summary.timingComplete, tokensComplete: summary.tokensComplete, targets: summary.targets, supportsBoundedMerge: summary.supportsBoundedMerge }, null, 2));
  if (blocked || !summary.quality || !summary.timingComplete || !summary.tokensComplete || !summary.integrityComplete) process.exitCode = 1;
}
module.exports = { BUDGETS, filesUnder, fileDigest, optionsFor };
if (require.main === module) main().catch(error => { console.error(`Phase benchmark could not start: ${error.code || error.name}`); process.exitCode = 1; });
