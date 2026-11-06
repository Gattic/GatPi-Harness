#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { MANIFEST, digest, prepareTask, observedFiles, checkAnswer, benchmarkOptions, createMeasurements, summarize } = require("../src/codemode-benchmark");
const ledger = require("../src/experiment-ledger");
const { installedRuntime, createRuntime } = require("../tests/helpers/codemode-runtime");
const root = path.resolve(__dirname, "..");

function sourceDigest() {
  const names = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 8 * 1024 * 1024 }).toString().split("\0").filter(Boolean).sort();
  return digest(names.map(name => [name, digest(fs.readFileSync(path.join(root, name)))]));
}
function protectedDigest(agentDir, historyRoot) {
  const names = ["settings.json", "auth.json", "models.json"].map(name => path.join(agentDir, name));
  for (const directory of ["experiment-ledger", "debug-ledger"]) {
    const base = path.join(historyRoot, ".pi", directory);
    if (fs.existsSync(base)) for (const name of fs.readdirSync(base).filter(name => name.endsWith(".json")).sort()) names.push(path.join(base, name));
  }
  return digest(names.map(file => [file, fs.existsSync(file) ? digest(fs.readFileSync(file)) : null]));
}
function save(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" }); }
function treeBytes(directory) { return fs.readdirSync(directory, { withFileTypes: true }).reduce((bytes, item) => bytes + (item.isDirectory() ? treeBytes(path.join(directory, item.name)) : fs.lstatSync(path.join(directory, item.name)).size), 0); }

async function liveInference(sdk, { provider, modelId, thinkingLevel, agentDir, run }) {
  const credentials = {
    async read(id) { if (id !== provider) return undefined; const value = sdk.readStoredCredential(id, path.join(agentDir, "auth.json")); if (value?.type === "api_key" && value.key?.startsWith("!")) throw new Error("Credential commands are not allowed"); return value; },
    async list() { const value = await this.read(provider); return value ? [{ providerId: provider, type: value.type }] : []; },
    async modify() { throw Object.assign(new Error("Credential refresh and writes are disabled"), { code: "READ_ONLY_CREDENTIALS" }); },
    async delete() { throw new Error("Credential deletion is disabled"); },
  };
  const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: fs.existsSync(path.join(agentDir, "models.json")) ? path.join(agentDir, "models.json") : null, modelsStorePath: path.join(run, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw Object.assign(new Error("Pinned model unavailable"), { code: "MODEL_UNAVAILABLE" });
  return { modelRuntime, model, thinkingLevel };
}

async function main() {
  const options = benchmarkOptions(process.argv.slice(2));
  const live = options.mode === "live";
  const { sdk, ai, root: sdkRoot } = await installedRuntime();
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent");
  const historyRoot = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8" }).trim().replace(/[\/]\.git$/, "");
  const existing = ledger.listExperiments(historyRoot, { status: "open" });
  if (existing.some(row => /native codemode/i.test(row.title) && /paired/i.test(row.title))) throw new Error("Inspect existing native CodeMode experiment; do not rerun a registered comparison");
  const parent = path.join(root, ".pi/codemode-benchmark");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const previous = fs.readdirSync(parent);
  const suffix = options["resume-unstarted"] ? "-02" : "";
  let run;
  if (suffix) {
    run = path.resolve(root, options["resume-unstarted"]);
    if (!live || fs.realpathSync(path.dirname(run)) !== fs.realpathSync(parent) || fs.lstatSync(run).isSymbolicLink()) throw new Error("Continuation must target an owned live preflight directory");
    const prior = JSON.parse(fs.readFileSync(path.join(run, "summary.json"), "utf8"));
    if (prior.executedCases !== 0 || prior.blocked !== "MODEL_IDENTITY_MISSING" || fs.existsSync(path.join(run, "protocol-02.json"))) throw new Error("Only one zero-case identity-preflight continuation is allowed; no attempted case may retry");
  } else {
    if (previous.some(name => name.startsWith(live ? "live-" : "synthetic-"))) throw new Error("A comparison of this kind already exists; inspect it instead of retrying");
    run = path.join(parent, `${live ? "live" : "synthetic"}-${Date.now()}`);
    fs.mkdirSync(run, { mode: 0o700 });
  }
  if (fs.statfsSync(parent).bavail * fs.statfsSync(parent).bsize < 256 * 1024 * 1024 || treeBytes(parent) > 64 * 1024 * 1024) throw new Error("Insufficient benchmark storage headroom");
  const baseline = sourceDigest(), protectedBefore = protectedDigest(agentDir, historyRoot);
  const provider = live ? options.provider : "synthetic";
  const modelId = live ? options.model : "faux";
  const thinkingLevel = live ? options.thinking : "off";
  const protocol = { version: 1, contextMeasurement: "context_with_system full transcript chars/4; provider payload estimate recorded separately when available", live, manifest: MANIFEST, manifestDigest: digest(MANIFEST), sourceDigest: baseline, protectedDigest: protectedBefore, piVersion: sdk.VERSION, piEntryDigest: digest(fs.readFileSync(require.resolve(sdkRoot))), provider, model: modelId, thinkingLevel, order: "direct-first on even indices, codemode-first on odd indices", exactCases: 60, timeoutMsPerCase: 120000, retries: 0, budgets: { evidenceBytes: 64 * 1024 * 1024, fixtureBytes: 128 * 1024 * 1024 }, existingOpenExperimentCount: existing.length };
  if (suffix) protocol.preflightContinuation = { originalProtocolDigest: digest(fs.readFileSync(path.join(run, "protocol.json"))), reason: "Managed launcher omitted interactive inference selectors; zero cases or model requests occurred. Explicit identity now pinned before inference; historical records unchanged." };
  save(path.join(run, `protocol${suffix}.json`), protocol);
  const experiment = ledger.openExperiment(root, suffix ? "Native CodeMode v2 live paired 2026-10-24" : `Native CodeMode paired ${live ? "live" : "synthetic"} 2026-10-24`,  { hypothesis: "Native governed composition reduces composed-task context without correctness, evidence or authority regressions; default-on is independently authorized.", arms: ["direct current router+compactor", "same tools plus native governed codemode"], bars: [JSON.stringify(protocol), "Exactly 30 fixed tasks / 60 fresh sessions, counterbalanced; no retry, fallback or post-hoc task changes", "Exact answer and actually observed evidence; integrity drift/provider error stops execution and leaves remaining cases unrun", "Target composed estimated context ratio <=0.75, p95 latency and reported cost ratios <=1.10; missing metrics remain unknown", "Metadata-only model measurements, private owned artifacts <=64MiB, fixtures <=128MiB; never capture private reasoning or credentials"] });
  const cases = [];
  let inference, blocked = null;
  try {
    if (live) {
      if (!provider || !modelId) throw Object.assign(new Error("Explicit PI_PROVIDER and PI_MODEL required"), { code: "MODEL_IDENTITY_MISSING" });
      inference = await liveInference(sdk, { provider, modelId, thinkingLevel, agentDir, run });
    }
    for (const [index, task] of MANIFEST.entries()) {
      const cwd = path.join(run, "fixtures", task.id);
      const prepared = prepareTask(task, cwd);
      let pairPassed = true;
      for (const arm of index % 2 ? ["codemode", "direct"] : ["direct", "codemode"]) {
        if (treeBytes(run) > protocol.budgets.evidenceBytes) throw Object.assign(new Error("Evidence retention bound reached"), { code: "STORAGE_BOUND" });
        if (sourceDigest() !== baseline || protectedDigest(agentDir, historyRoot) !== protectedBefore) throw Object.assign(new Error("Protected integrity drift"), { code: "INTEGRITY_DRIFT" });
        const measurements = createMeasurements();
        const runtime = await createRuntime({ cwd, inference, tools: ["read", "docs_lookup", "code_context", "codemode"], excludeTools: arm === "direct" ? ["codemode"] : [], extensionFactories: [pi => {
          measurements.install(pi);
          pi.on("tool_call", event => {
            if (event.toolName === "read") {
              const file = path.relative(cwd, path.resolve(cwd, String(event.input.path || "").replace(/^@/, "")));
              if (!Object.hasOwn(prepared.files, file)) return { block: true, reason: "Benchmark reads are confined to its frozen fixture" };
            }
          });
        }] });
        if (live && (runtime.session.model.provider !== provider || runtime.session.model.id !== modelId || runtime.session.thinkingLevel !== thinkingLevel)) {
          await runtime.close();
          throw Object.assign(new Error("Inference identity drift"), { code: "INFERENCE_DRIFT" });
        }
        if (!live) {
          const calls = prepared.evidence.map(file => ai.fauxAssistantMessage([ai.fauxToolCall("read", { path: file })], { stopReason: "toolUse" }));
          const code = task.kind === "chain" ? 'const route=JSON.parse(await tools.read({path:"docs/route.json"})); const rows=JSON.parse(await tools.read({path:route.source})); return rows.find(row=>row.id===route.id).amount;' : `return (await Promise.all(${JSON.stringify(prepared.evidence)}.map(path=>tools.read({path})))).length;`;
          runtime.faux.setResponses([...(arm === "direct" ? calls : [ai.fauxAssistantMessage([ai.fauxToolCall("codemode", { code })], { stopReason: "toolUse" })]), ai.fauxAssistantMessage(JSON.stringify({ value: prepared.expected, evidence: prepared.evidence }))]);
        }
        const started = performance.now();
        let timedOut = false, promptFailed = false;
        const deadline = setTimeout(() => { timedOut = true; void runtime.session.abort(); }, protocol.timeoutMsPerCase);
        try { await runtime.session.prompt(prepared.prompt); }
        catch { promptFailed = true; }
        finally { clearTimeout(deadline); }
        try {
          const messages = runtime.session.messages.filter(message => message.role === "assistant");
          const final = messages.at(-1);
          const answer = (final?.content || []).filter(item => item.type === "text").map(item => item.text).join("");
          const ended = runtime.events.filter(event => event.type === "tool_execution_end");
          const starts = runtime.events.filter(event => event.type === "tool_execution_start");
          const observed = observedFiles(runtime.events, cwd);
          const fixtureUnchanged = Object.entries(prepared.files).every(([file, bytes]) => fs.readFileSync(path.join(cwd, file), "utf8") === bytes);
          const integrity = fixtureUnchanged && sourceDigest() === baseline && protectedDigest(agentDir, historyRoot) === protectedBefore;
          const costs = messages.map(message => message.usage?.cost?.total);
          const providerError = promptFailed || timedOut || messages.some(message => ["error", "aborted"].includes(message.stopReason));
          const failureText = messages.filter(message => message.stopReason === "error").map(message => message.errorMessage || "").join(" ");
          const failureCategory = !providerError ? null : timedOut ? "case-timeout" : /429|rate.limit|quota/i.test(failureText) ? "provider-rate-limit" : /refresh|credential|401|403|auth|expired/i.test(failureText) ? "provider-auth-unavailable" : "provider-or-runtime-error";
          const generatedCodeChars = messages.reduce((sum, message) => sum + (message.content || []).filter(item => item.type === "toolCall" && item.name === "codemode").reduce((chars, item) => chars + String(item.arguments?.code || "").length, 0), 0);
          const toolFailures = ended.filter(event => event.isError).length;
          const row = { id: task.id, kind: task.kind, arm, fixtureDigest: prepared.fixtureDigest, oracle: live ? checkAnswer(answer, prepared, observed) : { ok: checkAnswer(answer, prepared, observed).ok, reason: "synthetic-final-answer-not-live-model-quality" }, integrity, providerError, failureCategory, timedOut, generatedCodeChars, toolFailures, modelTurns: messages.length, underlyingToolAttempts: starts.filter(event => event.toolName !== "codemode").length, successfulUnderlyingTools: ended.filter(event => event.toolName !== "codemode" && !event.isError).length, ...measurements.snapshot(), reportedUsage: messages.map(message => message.usage ? { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite } : null), reportedCost: live && costs.every(Number.isFinite) ? costs.reduce((sum, cost) => sum + cost, 0) : null, wallMs: Math.round(performance.now() - started) };
          const spill = ended.find(event => event.toolName === "codemode" && event.result?.details?.fullOutputPath)?.result.details.fullOutputPath;
          if (spill) {
            if (path.dirname(spill) !== os.tmpdir() || !/^pi-codemode-[a-f0-9]{16}\.txt$/.test(path.basename(spill)) || !fs.lstatSync(spill).isFile()) throw Object.assign(new Error("Unexpected native spill identity"), { code: "SPILL_IDENTITY" });
            const bytes = fs.statSync(spill).size;
            row.spill = { bytes, digest: digest(fs.readFileSync(spill)), retained: !row.oracle.ok || !integrity || providerError || toolFailures > 0 };
            if (row.spill.retained) {
              if (treeBytes(run) + bytes > protocol.budgets.evidenceBytes) throw Object.assign(new Error("Evidence retention bound reached; original spill preserved"), { code: "STORAGE_BOUND" });
              fs.renameSync(spill, path.join(run, `${task.id}-${arm}-spill.txt`));
            } else fs.unlinkSync(spill);
          }
          cases.push(row);
          save(path.join(run, `${task.id}-${arm}.json`), row);
          pairPassed &&= row.oracle.ok && integrity && !providerError && !toolFailures;
          console.log(`${task.id} ${arm}: ${providerError ? "provider-error" : row.oracle.ok ? "oracle-pass" : "oracle-fail"}`);
          if (!integrity || providerError) throw Object.assign(new Error("Stopped at required observation boundary"), { code: !integrity ? "INTEGRITY_DRIFT" : timedOut ? "CASE_TIMEOUT" : "PROVIDER_ERROR" });
        } finally { await runtime.close(); }
      }
      if (pairPassed) fs.rmSync(cwd, { recursive: true });
    }
  } catch (error) { blocked = /^[A-Z_]+$/.test(String(error.code || "")) ? error.code : "RUNTIME_FAILURE"; }
  const summary = { ...summarize(cases), live, blocked, executedCases: cases.length, unrunCases: 60 - cases.length, sourceUnchanged: sourceDigest() === baseline, protectedUnchanged: protectedDigest(agentDir, historyRoot) === protectedBefore };
  save(path.join(run, `summary${suffix}.json`), summary);
  ledger.recordGate(root, experiment.experimentId, { gate: "paired-comparison", verdict: blocked ? "partial" : summary.parity ? "pass" : "fail", gpuHours: 0, metrics: JSON.stringify({ live, executed: cases.length, unrun: 60 - cases.length, parity: summary.parity, contextRatio: summary.composedContextRatio, latencyRatio: summary.p95LatencyRatio }), note: blocked || (live ? "Quality parity and performance targets are separate; see summary for each target." : "Provider-free runner validation only; not live quality, latency or cost evidence.") });
  const targets = Object.values(summary.benefitTargets);
  ledger.recordGate(root, experiment.experimentId, { gate: "benefit-targets", verdict: !live || !summary.complete ? "null-result" : targets.some(value => value === false) ? "fail" : targets.every(value => value === true) ? "pass" : "null-result", gpuHours: 0, metrics: JSON.stringify(summary.benefitTargets), note: "Default-on is user-authorized independently; unknown metrics are not passes, and synthetic timing is not live performance evidence." });
  console.log(JSON.stringify({ run: path.relative(root, run), summaryFile: `summary${suffix}.json`, ...summary }, null, 2));
  if (blocked || !summary.parity) process.exitCode = 1;
}
module.exports = { sourceDigest, protectedDigest, save, treeBytes, liveInference };
if (require.main === module) main().catch(error => { console.error(`CodeMode benchmark could not start: ${error.code || error.name}`); process.exitCode = 1; });
