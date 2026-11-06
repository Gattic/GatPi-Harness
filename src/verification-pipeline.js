"use strict";

/**
 * Verification-gated execution pipeline.
 *
 * This module promotes verification from a final checklist into the execution
 * primitive that owns patch application, impact analysis, dependency-aware
 * validator scheduling, policy gates, rollback/retry and durable evidence.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ImpactAccumulator, UNSAFE_PATTERN, contentState, fingerprintChangeSet } = require("./verification-change-set.js");

const DEFAULT_REQUIRED_KINDS = Object.freeze([
  "compile",
  "lint",
  "unit",
  "integration",
  "static-analysis",
  "security",
  "benchmark",
  "format",
]);
const VALIDATOR_KINDS = Object.freeze([...DEFAULT_REQUIRED_KINDS, "visual"]);
const DEFAULT_MAX_VERIFIER_OUTPUT_BYTES = 256 * 1024;

function verifierOutputLimit(value = process.env.PI_VERIFICATION_MAX_OUTPUT_BYTES) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1024 ? Math.floor(parsed) : DEFAULT_MAX_VERIFIER_OUTPUT_BYTES;
}

function truncateOutput(value, limit) {
  const text = value == null ? "" : String(value);
  if (text.length <= limit) return { text, chars: text.length, truncated: false };
  const marker = `\n... [truncated ${text.length - limit} characters; total ${text.length}] ...\n`;
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return { text: `${text.slice(0, head)}${marker}${tail ? text.slice(-tail) : ""}`, chars: text.length, truncated: true };
}

function utf8Head(text, maxBytes) {
  let low = 0; let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low);
}

function utf8Tail(text, maxBytes) {
  let low = 0; let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (Buffer.byteLength(text.slice(mid)) <= maxBytes) high = mid;
    else low = mid + 1;
  }
  return text.slice(low);
}

function truncateOutputBytes(value, limit) {
  const text = value == null ? "" : String(value);
  const bytes = Buffer.byteLength(text);
  if (bytes <= limit) return { text, chars: text.length, bytes, truncated: false };
  const marker = `\n... [truncated output; total ${bytes} bytes] ...\n`;
  const available = Math.max(0, limit - Buffer.byteLength(marker));
  const headBudget = Math.ceil(available / 2);
  const tailBudget = Math.floor(available / 2);
  const head = utf8Head(text, headBudget);
  const tail = utf8Tail(text, tailBudget);
  return { text: `${head}${marker}${tail}`, chars: text.length, bytes, truncated: true };
}

class BoundedCommandOutput {
  constructor(limit = DEFAULT_MAX_VERIFIER_OUTPUT_BYTES) {
    this.limit = verifierOutputLimit(limit);
    this.headLimit = Math.floor(this.limit / 2);
    this.tailLimit = this.limit - this.headLimit;
    this.head = Buffer.alloc(0);
    this.tail = Buffer.alloc(0);
    this.bytes = 0;
  }
  append(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.bytes += chunk.length;
    let rest = chunk;
    if (this.head.length < this.headLimit) {
      const take = Math.min(this.headLimit - this.head.length, rest.length);
      this.head = Buffer.concat([this.head, rest.subarray(0, take)]);
      rest = rest.subarray(take);
    }
    if (rest.length && this.tailLimit) {
      const combined = Buffer.concat([this.tail, rest]);
      this.tail = combined.length > this.tailLimit ? combined.subarray(combined.length - this.tailLimit) : combined;
    }
  }
  result() {
    const capturedBytes = this.head.length + this.tail.length;
    const truncated = this.bytes > capturedBytes;
    const marker = truncated ? `\n... [truncated ${this.bytes - capturedBytes} bytes; total ${this.bytes}] ...\n` : "";
    return { text: `${this.head.toString("utf8")}${marker}${this.tail.toString("utf8")}`, bytes: this.bytes, capturedBytes, truncated };
  }
}

function nowIso() { return new Date().toISOString(); }
function clamp01(n) { return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)); }
function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex"); }
function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); }
function fileExists(file) { try { fs.accessSync(file); return true; } catch { return false; } }
function unique(values) { return Array.from(new Set(values.filter(Boolean))); }
function matchesPattern(file, pattern) {
  if (pattern instanceof RegExp) return pattern.test(file);
  const glob = String(pattern);
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
    else if (c === "*" && glob[i + 1] === "*") { re += ".*"; i += 1; }
    else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(file);
}

class Verifier {
  constructor({ id, kind, run, command, args = [], cwd = process.cwd(), env = {}, dependsOn = [], files = ["**/*"], impacts = [], cacheable = true, timeoutMs = 120000, maxOutputBytes = verifierOutputLimit(), weight = 1, benchmark = false, parser = null }) {
    if (!id) throw new Error("verifier requires id");
    if (!kind || !VALIDATOR_KINDS.includes(kind)) throw new Error(`invalid verifier kind: ${kind}`);
    if (!run && !command) throw new Error("verifier requires run function or command");
    this.id = id;
    this.kind = kind;
    this.dependsOn = dependsOn;
    this.files = files;
    this.impacts = impacts;
    this.cacheable = cacheable;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = verifierOutputLimit(maxOutputBytes);
    this.weight = weight;
    this.benchmark = benchmark || kind === "benchmark";
    this._run = run || (() => runCommand({ command, args, cwd, env, timeoutMs, maxOutputBytes: this.maxOutputBytes, parser }));
    this.fingerprint = hash({ id, kind, command, args, cwd, env, dependsOn, files, impacts, timeoutMs, maxOutputBytes: this.maxOutputBytes, benchmark: this.benchmark });
  }

  impactsChange(impact) {
    if (!impact.changedFiles.length) return true;
    if (this.files.some((p) => impact.changedFiles.some((f) => matchesPattern(f, p)))) return true;
    if (this.impacts.some((x) => impact.categories.includes(x))) return true;
    return false;
  }

  async run(context) {
    const start = Date.now();
    try {
      const raw = await this._run(context);
      const result = normalizeVerifierResult(raw, this.maxOutputBytes);
      return { ...result, id: this.id, kind: this.kind, startedAt: new Date(start).toISOString(), durationMs: Date.now() - start, cached: false };
    } catch (err) {
      const result = normalizeVerifierResult({ ok: false, error: err && err.stack ? err.stack : String(err), artifacts: [] }, this.maxOutputBytes);
      return { ...result, id: this.id, kind: this.kind, startedAt: new Date(start).toISOString(), durationMs: Date.now() - start, cached: false };
    }
  }
}

class VerificationCache {
  constructor(file = path.join(os.tmpdir(), "pi-verification-cache.json")) {
    this.file = file;
    this.entries = readJson(file, {});
  }
  get(key) { return this.entries[key] || null; }
  set(key, value) { this.entries[key] = { ...value, cachedAt: nowIso() }; writeJson(this.file, this.entries); }
  key(verifier, impact, context) { return hash({ verifier: verifier.fingerprint, fingerprint: context.fingerprint, changedFiles: impact.changedFiles, categories: impact.categories, publicApiChanges: impact.publicApiChanges }); }
}

class EvidenceStore {
  constructor(dir = path.join(process.cwd(), ".pi", "verification-evidence")) { this.dir = dir; }
  read(id) { if (!/^[A-Za-z0-9_.-]{1,128}$/.test(String(id || ""))) throw new Error("invalid evidence id"); return readJson(path.join(this.dir, `${id}.json`), null); }
  write(evidence) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${evidence.id}.json`);
    writeJson(file, evidence);
    return file;
  }
}

class VerificationMetrics {
  constructor(file = path.join(process.cwd(), ".pi", "verification-metrics.json")) {
    this.file = file;
    this.state = readJson(file, { runs: 0, passes: 0, failures: 0, retries: 0, regressions: 0, flaky: {}, validators: {} });
  }
  record(evidence) {
    this.state.runs++;
    if (evidence.ok === true) this.state.passes++;
    else if (evidence.ok === false) this.state.failures++;
    else this.state.skipped = (this.state.skipped || 0) + 1;
    this.state.retries += evidence.retryCount || 0;
    if (evidence.policy?.violations?.some((v) => /benchmark/i.test(v.reason || v.policy || ""))) this.state.regressions++;
    for (const r of evidence.verifiers) {
      const v = this.state.validators[r.id] || { runs: 0, passes: 0, failures: 0, cached: 0, durations: [] };
      v.runs++; if (r.cached) v.cached++; if (r.ok) v.passes++; else v.failures++; v.durations.push(r.durationMs || 0); v.durations = v.durations.slice(-100);
      const prev = v.lastOk;
      if (prev != null && prev !== r.ok) this.state.flaky[r.id] = (this.state.flaky[r.id] || 0) + 1;
      v.lastOk = r.ok;
      this.state.validators[r.id] = v;
    }
    writeJson(this.file, this.state);
  }
  snapshot() {
    const passRate = this.state.runs ? this.state.passes / this.state.runs : 1;
    const retryRate = this.state.runs ? this.state.retries / this.state.runs : 0;
    return { ...this.state, passRate, retryRate, regressionFrequency: this.state.runs ? this.state.regressions / this.state.runs : 0 };
  }
}

class PolicyEngine {
  constructor(policies = defaultPolicies()) { this.policies = policies; }
  evaluate(context) {
    const violations = [];
    for (const policy of this.policies) {
      const result = policy(context);
      if (result === false) violations.push({ policy: policy.name || "anonymous", reason: "rejected" });
      else if (result && result.ok === false) violations.push({ policy: policy.name || "anonymous", ...result });
    }
    return { ok: violations.length === 0, violations };
  }
}

class VerificationGraph {
  constructor(verifiers) {
    this.verifiers = verifiers.map((v) => v instanceof Verifier ? v : new Verifier(v));
    this.byId = new Map(this.verifiers.map((v) => [v.id, v]));
    for (const v of this.verifiers) for (const dep of v.dependsOn) if (!this.byId.has(dep)) throw new Error(`verifier ${v.id} depends on missing ${dep}`);
  }
  impacted(impact) {
    const wanted = new Set(this.verifiers.filter((v) => v.impactsChange(impact)).map((v) => v.id));
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of Array.from(wanted)) {
        for (const dep of this.byId.get(id).dependsOn) if (!wanted.has(dep)) { wanted.add(dep); changed = true; }
      }
    }
    return this.topologicalLevels(Array.from(wanted));
  }
  topologicalLevels(ids) {
    const remaining = new Set(ids);
    const done = new Set();
    const levels = [];
    while (remaining.size) {
      const level = Array.from(remaining).filter((id) => this.byId.get(id).dependsOn.every((d) => done.has(d) || !remaining.has(d)));
      if (!level.length) throw new Error("verification graph has a dependency cycle");
      levels.push(level.map((id) => this.byId.get(id)));
      for (const id of level) { remaining.delete(id); done.add(id); }
    }
    return levels;
  }
}

class VerifiedExecutionPipeline {
  constructor({ verifiers = [], policies = defaultPolicies(), cache, evidenceStore, metrics, concurrency = 4, feedbackSinks = [], maxRetries = 1, requiredKinds = DEFAULT_REQUIRED_KINDS } = {}) {
    this.graph = new VerificationGraph(verifiers);
    this.policy = policies instanceof PolicyEngine ? policies : new PolicyEngine(policies);
    this.cache = cache || new VerificationCache();
    this.evidenceStore = evidenceStore || new EvidenceStore();
    this.metrics = metrics || new VerificationMetrics();
    this.concurrency = concurrency;
    this.feedbackSinks = feedbackSinks;
    this.maxRetries = maxRetries;
    this.requiredKinds = requiredKinds;
  }

  async execute({ patchSet = {}, apply, rollback, alternatives = [], cwd = process.cwd(), baseline = {}, retryCount = 0 }) {
    if (typeof apply !== "function") throw new Error("verified execution requires an apply function");
    const before = snapshotFiles(patchSet.files || patchSet.changedFiles || [], cwd);
    const applied = await apply(patchSet);
    const changeSet = normalizeChangeSet(applied, patchSet, before, cwd);
    const verified = await this.verify({ changeSet, patchSet, cwd, baseline, retryCount });
    if (verified.ok) return verified;

    if (typeof rollback === "function") await rollback({ patchSet, applied, evidence: verified });
    else restoreSnapshot(before, cwd);

    if (retryCount < this.maxRetries) {
      for (const alternative of alternatives) {
        const next = typeof alternative === "function" ? await alternative({ patchSet, evidence: verified, attempt: retryCount + 1 }) : alternative;
        if (!next) continue;
        const result = await this.execute({ patchSet: next.patchSet || next, apply: next.apply || apply, rollback: next.rollback || rollback, alternatives: next.alternatives || [], cwd, baseline, retryCount: retryCount + 1 });
        if (result.ok) return { ...result, branchedFrom: verified.id };
      }
    }
    return verified;
  }

  async verify({ changeSet, patchSet = {}, cwd = process.cwd(), baseline = {}, retryCount = 0, acknowledgedPublicApiRemovals = [] }) {
    if (!changeSet.fingerprint) changeSet = { ...changeSet, fingerprint: fingerprintChangeSet(changeSet) };
    const impact = analyzeImpact(changeSet);
    // Session mining (2026-07): 23/33 recorded proofs were ok:false with zero
    // verifiers and an empty change set - "nothing happened" was scored as
    // FAIL and flooded the learning loop with junk verification-failure
    // outcomes. An empty change set is not-applicable, not a failure.
    if (!(changeSet.changedFiles || []).length) {
      const evidence = {
        id: `proof_${hash({ at: Date.now(), changeSet: changeSet.fingerprint, ok: null }).slice(0, 16)}`,
        ok: null,
        status: "not-applicable",
        reason: "empty change set - nothing to verify",
        createdAt: nowIso(),
        retryCount,
        changeSet: { changedFiles: [], fingerprint: changeSet.fingerprint },
        impact,
        verifiers: [],
        proofArtifacts: [],
        benchmarkDeltas: {},
        coverageDeltas: {},
        confidence: 0,
        policy: { ok: true, violations: [] },
        metrics: this.metrics.snapshot(),
      };
      evidence.evidenceFile = this.evidenceStore.write(evidence);
      this.metrics.record(evidence);
      await this.feedback(evidence);
      return evidence;
    }
    const missingKinds = this.requiredKinds.filter((kind) => !this.graph.verifiers.some((v) => v.kind === kind));
    const context = { cwd, patchSet, changeSet, impact, baseline, acknowledgedPublicApiRemovals, fingerprint: hash({ changeSetFingerprint: changeSet.fingerprint, patchSet: patchSet.id || patchSet }), startedAt: nowIso() };
    const prePolicy = this.policy.evaluate({ ...context, phase: "pre-verification", verifiers: [], requiredKinds: this.requiredKinds, missingKinds });
    const results = [];
    let blocked = !prePolicy.ok;
    if (missingKinds.length) {
      prePolicy.violations.push({ policy: "mandatory-verifier-coverage", reason: `missing verifier kinds: ${missingKinds.join(", ")}`, missingKinds });
      blocked = true;
    }

    if (!blocked) {
      const levels = this.graph.impacted(impact);
      for (const level of levels) {
        const levelResults = await mapLimit(level, this.concurrency, async (verifier) => this.runVerifier(verifier, context, impact));
        results.push(...levelResults);
        if (levelResults.some((r) => !r.ok)) break;
      }
      if (!results.length && isDocOnlyChange(changeSet))
        results.push(docOnlyFallbackVerifierResult(context));
    }

    const benchmarkDeltas = collectBenchmarkDeltas(results, baseline.benchmarks || {});
    const coverageDeltas = collectCoverageDeltas(results, baseline.coverage || {});
    const policy = this.policy.evaluate({ ...context, phase: "post-verification", verifiers: results, benchmarkDeltas, coverageDeltas, requiredKinds: this.requiredKinds, missingKinds });
    const ok = !blocked && results.length > 0 && results.every((r) => r.ok) && policy.ok;
    // Zero matched verifiers on a real change stays fail-closed (ok:false) so
    // gates hold, but the status lets consumers report a coverage gap instead
    // of a failed change.
    const noVerifierMatched = !blocked && results.length === 0;
    const evidence = {
      id: `proof_${hash({ at: Date.now(), changeSet: changeSet.fingerprint, ok }).slice(0, 16)}`,
      ok,
      status: blocked ? "blocked" : ok ? "pass" : noVerifierMatched ? "no-verifiers" : "fail",
      reason: noVerifierMatched ? "no verifier matched the change set (coverage gap, fail-closed)" : undefined,
      createdAt: nowIso(),
      retryCount,
      changeSet: { changedFiles: changeSet.changedFiles, fingerprint: changeSet.fingerprint },
      impact,
      verifiers: results,
      proofArtifacts: unique(results.flatMap((r) => r.artifacts || [])),
      benchmarkDeltas,
      coverageDeltas,
      confidence: computeConfidence({ results, impact, policy, missingKinds, retryCount }),
      policy: { ok: prePolicy.ok && policy.ok && missingKinds.length === 0, violations: [...prePolicy.violations, ...policy.violations] },
      // Approved removals are part of the proof, so a passing result shows which removals it accepted and why.
      acknowledgedPublicApiRemovals: reviewPublicApiRemovals(impact, acknowledgedPublicApiRemovals).acknowledged,
      metrics: this.metrics.snapshot(),
    };
    evidence.evidenceFile = this.evidenceStore.write(evidence);
    this.metrics.record(evidence);
    await this.feedback(evidence);
    return evidence;
  }

  async runVerifier(verifier, context, impact) {
    const key = this.cache.key(verifier, impact, context);
    if (verifier.cacheable) {
      const cached = this.cache.get(key);
      if (cached) return { ...cached, ...normalizeVerifierResult(cached, verifier.maxOutputBytes), cached: true };
    }
    const result = await verifier.run(context);
    if (verifier.cacheable && result.ok) this.cache.set(key, result);
    return result;
  }

  async feedback(evidence) {
    for (const sink of this.feedbackSinks) {
      try { await sink(evidence); } catch { /* feedback must not mask verification result */ }
    }
  }
}

function normalizeVerifierResult(raw, maxOutputBytes = verifierOutputLimit()) {
  if (raw == null) return { ok: true, output: "", artifacts: [] };
  if (typeof raw === "boolean") return { ok: raw, output: "", artifacts: [] };
  const outputLimit = verifierOutputLimit(maxOutputBytes);
  const output = truncateOutputBytes(raw.output || raw.stdout || "", outputLimit);
  const error = truncateOutputBytes(raw.error || raw.stderr || "", outputLimit);
  const compactMetrics = compactSummaryValue(raw.metrics || {}, { maxTextChars: Math.min(outputLimit, 4000), maxItems: 100, maxDepth: 6 });
  const metrics = compactMetrics && typeof compactMetrics === "object" && !Array.isArray(compactMetrics) ? compactMetrics : {};
  let visual;
  if (raw.visual != null) {
    const { assertVisualMetadataOnly } = require("./visual-verification");
    assertVisualMetadataOnly(raw.visual);
    visual = compactSummaryValue(raw.visual, { maxTextChars: 512, maxItems: 200, maxDepth: 8 });
  }
  return {
    ok: raw.ok !== false,
    output: output.text,
    error: error.text,
    artifacts: raw.artifacts || [],
    ...(visual == null ? {} : { visual }),
    metrics: {
      ...metrics,
      outputChars: metrics.outputChars ?? output.chars,
      errorChars: metrics.errorChars ?? error.chars,
      outputBytes: metrics.outputBytes ?? output.bytes,
      errorBytes: metrics.errorBytes ?? error.bytes,
      outputTruncated: Boolean(metrics.outputTruncated || output.truncated),
      errorTruncated: Boolean(metrics.errorTruncated || error.truncated),
    },
    coverage: raw.coverage,
    benchmarks: raw.benchmarks,
  };
}

function compactSummaryValue(value, { maxTextChars = 2000, maxItems = 40, maxDepth = 5 } = {}, depth = 0, seen = new Set()) {
  if (typeof value === "string") return truncateOutput(value, maxTextChars).text;
  if (value == null || typeof value !== "object") return value;
  if (depth >= maxDepth) return Array.isArray(value) ? `[Array(${value.length}) omitted]` : "[Object omitted]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.slice(0, maxItems).map((item) => compactSummaryValue(item, { maxTextChars, maxItems, maxDepth }, depth + 1, seen));
    if (value.length > maxItems) out.push({ omittedItems: value.length - maxItems });
    seen.delete(value);
    return out;
  }
  const entries = Object.entries(value);
  const out = {};
  for (const [key, item] of entries.slice(0, maxItems)) out[key] = compactSummaryValue(item, { maxTextChars, maxItems, maxDepth }, depth + 1, seen);
  if (entries.length > maxItems) out.omittedKeys = entries.length - maxItems;
  seen.delete(value);
  return out;
}

function summarizeVerificationResult(result, { maxVerifiers = 20, maxTextChars = 2000 } = {}) {
  const summary = {
    id: result?.id,
    ok: result?.ok,
    status: result?.status,
    reason: result?.reason,
    createdAt: result?.createdAt,
    evidenceFile: result?.evidenceFile,
    changeSet: result?.changeSet ? { changedFiles: compactSummaryValue(result.changeSet.changedFiles, { maxTextChars, maxItems: 100, maxDepth: 3 }), fingerprint: truncateOutput(result.changeSet.fingerprint, maxTextChars).text } : undefined,
    verifiers: (result?.verifiers || []).slice(0, maxVerifiers).map((verifier) => ({
      id: verifier.id,
      kind: verifier.kind,
      ok: verifier.ok,
      cached: verifier.cached,
      durationMs: verifier.durationMs,
      metrics: compactSummaryValue(verifier.metrics, { maxTextChars, maxItems: 40, maxDepth: 5 }),
      output: truncateOutput(verifier.output, maxTextChars).text,
      error: truncateOutput(verifier.error, maxTextChars).text,
    })),
    policy: compactSummaryValue(result?.policy, { maxTextChars, maxItems: 40, maxDepth: 5 }),
    confidence: result?.confidence,
  };
  if ((result?.verifiers || []).length > maxVerifiers) summary.omittedVerifiers = result.verifiers.length - maxVerifiers;
  return summary;
}

function runCommand({ command, args, cwd, env, timeoutMs, maxOutputBytes = verifierOutputLimit(), parser }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, shell: process.platform === "win32" });
    const stdoutCapture = new BoundedCommandOutput(maxOutputBytes);
    const stderrCapture = new BoundedCommandOutput(maxOutputBytes);
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => { stdoutCapture.append(d); });
    child.stderr.on("data", (d) => { stderrCapture.append(d); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdout = stdoutCapture.result();
      const stderr = stderrCapture.result();
      const parsed = parser ? parser({ stdout: stdout.text, stderr: stderr.text, code, signal }) : {};
      resolve({
        ok: code === 0,
        stdout: stdout.text,
        stderr: stderr.text,
        ...parsed,
        metrics: {
          exitCode: code,
          signal,
          stdoutBytes: stdout.bytes,
          stderrBytes: stderr.bytes,
          capturedStdoutBytes: stdout.capturedBytes,
          capturedStderrBytes: stderr.capturedBytes,
          outputBytes: stdout.bytes,
          errorBytes: stderr.bytes,
          outputTruncated: stdout.truncated,
          errorTruncated: stderr.truncated,
          ...(parsed.metrics || {}),
        },
      });
    });
    child.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, stderr: err.message, metrics: { exitCode: -1 } }); });
  });
}

function snapshotFiles(files, cwd) {
  const out = {};
  for (const file of unique(files || [])) {
    const full = path.resolve(cwd, file);
    out[file] = fileExists(full) ? fs.readFileSync(full, "utf8") : null;
  }
  return out;
}
function restoreSnapshot(snapshot, cwd) {
  for (const [file, content] of Object.entries(snapshot || {})) {
    const full = path.resolve(cwd, file);
    if (content == null) { if (fileExists(full)) fs.unlinkSync(full); }
    else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); }
  }
}
function normalizeChangeSet(applied, patchSet, before, cwd) {
  const changedFiles = unique(applied.changedFiles || patchSet.changedFiles || patchSet.files || Object.keys(before));
  const after = {};
  for (const file of changedFiles) {
    if (applied.after && Object.prototype.hasOwnProperty.call(applied.after, file)) after[file] = applied.after[file];
    else {
      const full = path.resolve(cwd, file);
      after[file] = fileExists(full) ? fs.readFileSync(full, "utf8") : null;
    }
  }
  const b = { ...before, ...(applied.before || {}) };
  const changeSet = { changedFiles, before: b, after };
  return { ...changeSet, fingerprint: fingerprintChangeSet(changeSet) };
}

function analyzeImpact(changeSet) {
  if (changeSet?.impact) return changeSet.impact;
  const impact = new ImpactAccumulator();
  for (const file of changeSet?.changedFiles || []) {
    const before = Object.prototype.hasOwnProperty.call(changeSet?.before || {}, file) ? changeSet.before[file] : null;
    const after = Object.prototype.hasOwnProperty.call(changeSet?.after || {}, file) ? changeSet.after[file] : null;
    impact.add({ path: file, before: contentState(before), after: contentState(after) });
  }
  return impact.result();
}

function isDocOnlyChange(changeSet) {
  const files = changeSet?.changedFiles || [];
  return files.length > 0 && files.every(isDocOnlyFile);
}
function isDocOnlyFile(file) {
  const f = String(file || "").replace(/\\/g, "/");
  const base = f.split("/").pop() || "";
  if (/^CMakeLists\.txt$/i.test(base)) return false;
  if (/^(README|CHANGELOG|CHANGES|CONTRIBUTING|LICENSE|NOTICE|AGENTS|CLAUDE)(\.[^/]*)?$/i.test(base)) return true;
  if (/\.(md|markdown|mdx|rst|adoc|asciidoc|org)$/i.test(base)) return true;
  return /^(docs|doc|subsystem-plans|design|notes|adr|adrs)\//i.test(f) && /\.(txt|md|markdown|mdx|rst|adoc|asciidoc|org)$/i.test(base);
}
function docOnlyFallbackVerifierResult(context) {
  const at = nowIso();
  return {
    ok: true,
    id: "doc-only-fallback",
    kind: "format",
    startedAt: at,
    durationMs: 0,
    cached: false,
    fallback: true,
    output: "Documentation-only change; no configured verifier matched, so doc-only fallback accepted the verification gate.",
    artifacts: [`doc-only-fallback://${hash(context.changeSet?.changedFiles || []).slice(0, 12)}`],
    metrics: {
      changedFiles: context.changeSet?.changedFiles || [],
      reason: "doc-only-no-matching-verifier",
    },
  };
}

function collectBenchmarkDeltas(results, baseline) {
  const deltas = {};
  for (const r of results) for (const [name, value] of Object.entries(r.benchmarks || {})) {
    const base = baseline[name];
    deltas[name] = { before: base, after: value, delta: typeof base === "number" && typeof value === "number" ? value - base : null, ratio: typeof base === "number" && base !== 0 && typeof value === "number" ? value / base : null };
  }
  return deltas;
}
function collectCoverageDeltas(results, baseline) {
  const deltas = {};
  for (const r of results) if (r.coverage) for (const [name, value] of Object.entries(r.coverage)) {
    const base = baseline[name];
    deltas[name] = { before: base, after: value, delta: typeof base === "number" && typeof value === "number" ? value - base : null };
  }
  return deltas;
}
function computeConfidence({ results, impact, policy, missingKinds, retryCount }) {
  if (missingKinds.length || !policy.ok) return 0;
  if (!results.length) return 0;
  const weight = results.reduce((s, r) => s + (r.ok ? 1 : 0), 0) / results.length;
  const cachePenalty = results.every((r) => r.cached) ? 0.04 : 0;
  const fallbackPenalty = results.some((r) => r.fallback) ? 0.08 : 0;
  const riskPenalty = impact.behavioralRisk * 0.25;
  const retryPenalty = retryCount * 0.05;
  return clamp01(weight - cachePenalty - fallbackPenalty - riskPenalty - retryPenalty);
}
/**
 * Matches the public API removals in an impact analysis against removals the
 * change owner approved, each by exact file and symbol with a reason. Only a
 * removal the analysis lists can be approved: removals beyond its bounded
 * details stay unapproved. An approval that matches no listed removal is stale
 * and invalidates the set, so approvals cannot outlive the change they name or
 * pre-approve another removal. Every other policy is unaffected.
 */
function reviewPublicApiRemovals(impact = {}, acknowledgments = []) {
  const listed = (impact?.publicApiChanges || []).filter((change) => change.type === "removed");
  const total = Math.max(Number(impact?.publicApiRemovalCount || 0), listed.length);
  const entries = [];
  const invalid = [];
  if (!Array.isArray(acknowledgments)) invalid.push({ reason: "acknowledgments must be an array" });
  else acknowledgments.forEach((item, index) => {
    const [file, symbol, reason] = ["file", "symbol", "reason"].map((key) => (typeof item?.[key] === "string" ? item[key].trim() : ""));
    if (!file || !symbol || !reason) invalid.push({ index, reason: "file, symbol and reason are required" });
    else if (entries.some((entry) => entry.file === file && entry.symbol === symbol)) invalid.push({ index, file, symbol, reason: "duplicate acknowledgment" });
    else entries.push({ file, symbol, reason });
  });
  const matches = (removal, entry) => removal.file === entry.file && removal.symbol === entry.symbol;
  const acknowledged = entries.filter((entry) => listed.some((removal) => matches(removal, entry)));
  const stale = entries.filter((entry) => !listed.some((removal) => matches(removal, entry)));
  const unacknowledged = listed.filter((removal) => !entries.some((entry) => matches(removal, entry)));
  const hidden = total - listed.length;
  return { ok: !invalid.length && !stale.length && !unacknowledged.length && !hidden, removals: total, acknowledged, unacknowledged, stale, invalid, hidden };
}

function defaultPolicies() {
  return [
    function rejectFailedVerifiers(ctx) { return !ctx.verifiers?.some((r) => !r.ok) || { ok: false, reason: "unverified edit: verifier failure" }; },
    function rejectBenchmarkRegression(ctx) {
      for (const [name, d] of Object.entries(ctx.benchmarkDeltas || {})) if (typeof d.ratio === "number" && d.ratio > 1.05) return { ok: false, reason: `benchmark regression: ${name}`, delta: d };
      return true;
    },
    function rejectArchitectureViolations(ctx) {
      const review = reviewPublicApiRemovals(ctx.impact, ctx.acknowledgedPublicApiRemovals);
      if (review.ok) return true;
      const unapproved = review.unacknowledged.length + review.hidden;
      return {
        ok: false,
        reason: unapproved ? "architecture violation: public API removal" : "invalid public API removal acknowledgment",
        count: unapproved,
        unacknowledged: review.unacknowledged,
        hidden: review.hidden,
        staleAcknowledgments: review.stale,
        invalidAcknowledgments: review.invalid,
        changes: ctx.impact?.publicApiChanges || [],
      };
    },
    function rejectIncompleteImpactAnalysis(ctx) {
      const count = Number(ctx.impact?.analysisIncompleteCount || 0);
      return !count || { ok: false, reason: "change analysis incomplete for oversized or binary source files", count, files: ctx.impact?.analysisIncomplete || [] };
    },
    function rejectUnsafePatterns(ctx) {
      const streamedFindings = Number(ctx.impact?.unsafePatternCount || 0);
      const rawFinding = Object.values(ctx.changeSet?.after || {}).some((value) => UNSAFE_PATTERN.test(String(value || "")));
      return !(streamedFindings || rawFinding) || { ok: false, reason: "unsafe pattern detected", findings: ctx.impact?.unsafePatterns || [] };
    },
  ];
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let index = 0;
  async function worker() { while (index < items.length) { const i = index++; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

module.exports = { VALIDATOR_KINDS, DEFAULT_REQUIRED_KINDS, DEFAULT_MAX_VERIFIER_OUTPUT_BYTES, Verifier, VerificationCache, EvidenceStore, VerificationMetrics, PolicyEngine, VerificationGraph, VerifiedExecutionPipeline, analyzeImpact, defaultPolicies, reviewPublicApiRemovals, normalizeVerifierResult, summarizeVerificationResult };
