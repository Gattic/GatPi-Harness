"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  Verifier,
  VerificationCache,
  EvidenceStore,
  VerificationMetrics,
  VerifiedExecutionPipeline,
  analyzeImpact,
  defaultPolicies,
  reviewPublicApiRemovals,
} = require("../src/verification-pipeline");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const tmp = tmpFixture("pi-verification-");
  const evidenceDir = path.join(tmp, "evidence");
  const srcFile = "src/sample.js";
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, srcFile), "module.exports = { alpha };\nfunction alpha() { return 1; }\n");

  const unsafePolicy = defaultPolicies().find((policy) => policy.name === "rejectUnsafePatterns");
  assert.equal(unsafePolicy({ changeSet: { after: { "sample.cpp": "std::vector<float> alpha_eval(T);" } } }), true, "identifier suffixes ending in eval do not trigger the unsafe-code policy");
  assert.equal(unsafePolicy({ changeSet: { after: { "sample.js": "eval(input);" } } }).ok, false, "direct eval calls remain blocked");
  assert.equal(unsafePolicy({ impact: { unsafePatternCount: 1, unsafePatterns: [{ file: "sample.js" }] } }).ok, false, "streamed impact metadata blocks unsafe calls without aggregate source text");
  const architecturePolicy = defaultPolicies().find((policy) => policy.name === "rejectArchitectureViolations");
  assert.equal(architecturePolicy({ impact: { publicApiRemovalCount: 1, publicApiChanges: [] } }).ok, false, "bounded samples cannot hide a public API removal");

  // Owner-approved removals: exact file and symbol, with a reason, and nothing else.
  const removal = (file, symbol) => ({ file, type: "removed", symbol });
  const approve = (file, symbol) => ({ file, symbol, reason: "owner-approved obsolete export" });
  const twoRemovals = { publicApiRemovalCount: 2, publicApiChanges: [removal("src/a.ts", "oldA"), { file: "src/a.ts", type: "added", symbol: "newA" }, removal("src/b.ts", "oldB")] };
  const unapproved = architecturePolicy({ impact: twoRemovals });
  assert.equal(unapproved.ok, false, "removals without approval still fail");
  assert.equal(unapproved.count, 2);
  assert.equal(architecturePolicy({ impact: twoRemovals, acknowledgedPublicApiRemovals: [approve("src/a.ts", "oldA"), approve("src/b.ts", "oldB")] }), true, "every listed removal approved exactly passes");
  const partial = architecturePolicy({ impact: twoRemovals, acknowledgedPublicApiRemovals: [approve("src/a.ts", "oldA")] });
  assert.equal(partial.ok, false, "one approval does not cover another removal");
  assert.equal(partial.reason, "architecture violation: public API removal");
  assert.deepEqual(partial.unacknowledged, [removal("src/b.ts", "oldB")]);
  assert.equal(partial.count, 1);
  const wrongFile = architecturePolicy({ impact: twoRemovals, acknowledgedPublicApiRemovals: [approve("src/a.ts", "oldA"), approve("src/c.ts", "oldB")] });
  assert.equal(wrongFile.ok, false, "a symbol approved in another file does not match");
  assert.deepEqual(wrongFile.unacknowledged, [removal("src/b.ts", "oldB")]);
  assert.deepEqual(wrongFile.staleAcknowledgments, [approve("src/c.ts", "oldB")]);
  const staleOnly = architecturePolicy({ impact: { publicApiRemovalCount: 0, publicApiChanges: [] }, acknowledgedPublicApiRemovals: [approve("src/a.ts", "oldA")] });
  assert.equal(staleOnly.ok, false, "an approval that matches no removal is stale and fails");
  assert.equal(staleOnly.reason, "invalid public API removal acknowledgment");
  assert.equal(staleOnly.count, 0);
  const noReason = architecturePolicy({ impact: twoRemovals, acknowledgedPublicApiRemovals: [{ file: "src/a.ts", symbol: "oldA", reason: " " }, approve("src/b.ts", "oldB")] });
  assert.equal(noReason.ok, false, "an approval needs a reason");
  assert.deepEqual(noReason.unacknowledged, [removal("src/a.ts", "oldA")]);
  assert.equal(noReason.invalidAcknowledgments.length, 1);
  const duplicate = architecturePolicy({ impact: twoRemovals, acknowledgedPublicApiRemovals: [approve("src/a.ts", "oldA"), approve("src/a.ts", "oldA"), approve("src/b.ts", "oldB")] });
  assert.equal(duplicate.ok, false, "duplicate approvals are rejected");
  assert.equal(duplicate.invalidAcknowledgments[0].reason, "duplicate acknowledgment");
  const hiddenRemoval = architecturePolicy({ impact: { ...twoRemovals, publicApiRemovalCount: 3 }, acknowledgedPublicApiRemovals: [approve("src/a.ts", "oldA"), approve("src/b.ts", "oldB")] });
  assert.equal(hiddenRemoval.ok, false, "a removal beyond the bounded impact details cannot be approved");
  assert.equal(hiddenRemoval.hidden, 1);
  assert.equal(architecturePolicy({ impact: twoRemovals, acknowledgedPublicApiRemovals: "src/a.ts#oldA" }).ok, false, "approvals must be a list of objects");
  assert.deepEqual(reviewPublicApiRemovals(twoRemovals, [approve(" src/a.ts ", "oldA"), approve("src/b.ts", "oldB")]).acknowledged.map((row) => row.file), ["src/a.ts", "src/b.ts"], "approval fields are trimmed, not loosened");
  const incompletePolicy = defaultPolicies().find((policy) => policy.name === "rejectIncompleteImpactAnalysis");
  assert.equal(incompletePolicy({ impact: { analysisIncompleteCount: 1, analysisIncomplete: [{ file: "large.js", reason: "content-too-large-or-binary" }] } }).ok, false, "oversized source analysis fails closed with a typed policy result");

  let streamedVerifierRan = false;
  const streamedPipeline = new VerifiedExecutionPipeline({
    verifiers: [new Verifier({ id: "streamed", kind: "unit", files: ["**/*"], run: async () => { streamedVerifierRan = true; return { ok: true }; } })],
    cache: new VerificationCache(path.join(tmp, "cache-streamed.json")),
    evidenceStore: new EvidenceStore(path.join(tmp, "evidence-streamed")),
    metrics: new VerificationMetrics(path.join(tmp, "metrics-streamed.json")),
    requiredKinds: [],
  });
  const streamed = await streamedPipeline.verify({
    cwd: tmp,
    patchSet: { id: "streamed" },
    changeSet: {
      schemaVersion: 2,
      changedFiles: [srcFile],
      fingerprint: `change-set-v2:sha256:${"a".repeat(64)}`,
      impact: { changedFiles: [srcFile], categories: ["semantic"], semantic: [], semanticCount: 1, publicApiChanges: [], publicApiChangeCount: 0, dependencyGraphImpact: [], analysisIncomplete: [], analysisIncompleteCount: 0, unsafePatterns: [], unsafePatternCount: 0, behavioralRisk: 0.1 },
    },
  });
  assert.equal(streamed.ok, true, "digest-only streamed change sets can reach verifier execution");
  assert.equal(streamedVerifierRan, true);

  // End to end: approvals reach the policy through verify(), are recorded, and leave every other policy in force.
  const removalImpact = (extra = {}) => ({ changedFiles: [srcFile], categories: ["public-api", "semantic"], semantic: [], semanticCount: 1, publicApiChanges: [removal(srcFile, "alpha")], publicApiChangeCount: 1, publicApiRemovalCount: 1, dependencyGraphImpact: [], analysisIncomplete: [], analysisIncompleteCount: 0, unsafePatterns: [], unsafePatternCount: 0, behavioralRisk: 0.1, ...extra });
  const removalRuns = [];
  const removalPipeline = (name) => new VerifiedExecutionPipeline({
    verifiers: [new Verifier({ id: `removal-${name}`, kind: "unit", files: ["**/*"], cacheable: false, run: async () => { removalRuns.push(name); return { ok: true }; } })],
    cache: new VerificationCache(path.join(tmp, `cache-removal-${name}.json`)),
    evidenceStore: new EvidenceStore(path.join(tmp, `evidence-removal-${name}`)),
    metrics: new VerificationMetrics(path.join(tmp, `metrics-removal-${name}.json`)),
    requiredKinds: [],
  });
  const removalChangeSet = (impact) => ({ schemaVersion: 2, changedFiles: [srcFile], fingerprint: `change-set-v2:sha256:${"b".repeat(64)}`, impact });
  const blockedRemoval = await removalPipeline("blocked").verify({ cwd: tmp, patchSet: { id: "removal" }, changeSet: removalChangeSet(removalImpact()) });
  assert.equal(blockedRemoval.status, "blocked", "an unapproved removal still blocks before verifiers run");
  assert.deepEqual(blockedRemoval.acknowledgedPublicApiRemovals, []);
  const approvedRemoval = await removalPipeline("approved").verify({ cwd: tmp, patchSet: { id: "removal" }, changeSet: removalChangeSet(removalImpact()), acknowledgedPublicApiRemovals: [approve(srcFile, "alpha")] });
  assert.equal(approvedRemoval.ok, true, "an exactly approved removal lets the verifiers decide");
  assert.deepEqual(approvedRemoval.acknowledgedPublicApiRemovals, [approve(srcFile, "alpha")], "the evidence records the approved removal and its reason");
  const unsafeRemoval = await removalPipeline("unsafe").verify({ cwd: tmp, patchSet: { id: "removal" }, changeSet: removalChangeSet(removalImpact({ unsafePatternCount: 1, unsafePatterns: [{ file: srcFile }] })), acknowledgedPublicApiRemovals: [approve(srcFile, "alpha")] });
  assert.equal(unsafeRemoval.ok, false, "an approval does not relax other policies");
  assert.deepEqual([...new Set(unsafeRemoval.policy.violations.map((violation) => violation.policy))], ["rejectUnsafePatterns"], "the unsafe-pattern policy, and only it, still fails");
  assert.deepEqual(removalRuns, ["approved"], "only the approved, otherwise clean change ran its verifiers");

  const calls = [];
  const make = (id, kind, extra = {}) => new Verifier({
    id,
    kind,
    files: ["src/**/*.js"],
    run: async (ctx) => {
      calls.push(id);
      return { ok: true, output: `${id} ok`, artifacts: [`${id}.txt`], coverage: kind === "unit" ? { lines: 0.91 } : undefined, benchmarks: kind === "benchmark" ? { latencyMs: 9 } : undefined };
    },
    ...extra,
  });

  const pipeline = new VerifiedExecutionPipeline({
    verifiers: [
      make("compile", "compile"),
      make("lint", "lint", { dependsOn: ["compile"] }),
      make("unit", "unit", { dependsOn: ["compile"] }),
      make("integration", "integration", { dependsOn: ["unit"] }),
      make("static", "static-analysis", { dependsOn: ["lint"] }),
      make("security", "security", { impacts: ["security", "dependency"] }),
      make("benchmark", "benchmark", { impacts: ["performance", "semantic"], dependsOn: ["unit"] }),
      make("format", "format"),
    ],
    cache: new VerificationCache(path.join(tmp, "cache.json")),
    evidenceStore: new EvidenceStore(evidenceDir),
    metrics: new VerificationMetrics(path.join(tmp, "metrics.json")),
    concurrency: 3,
    feedbackSinks: [(e) => fs.writeFileSync(path.join(tmp, "feedback.json"), JSON.stringify({ ok: e.ok, confidence: e.confidence }))],
  });

  const result = await pipeline.execute({
    cwd: tmp,
    baseline: { benchmarks: { latencyMs: 10 }, coverage: { lines: 0.9 } },
    patchSet: { id: "p1", files: [srcFile] },
    apply: async () => {
      fs.writeFileSync(path.join(tmp, srcFile), "module.exports = { alpha };\nfunction alpha() { return 2; }\n");
      return { changedFiles: [srcFile] };
    },
  });

  assert.equal(result.ok, true, "verified execution succeeds only after all mandatory gates pass");
  assert(result.verifiers.some((v) => v.kind === "benchmark"), "benchmark validator runs as a graph node");
  assert.equal(result.benchmarkDeltas.latencyMs.delta, -1, "benchmark deltas are captured");
  assert.equal(result.coverageDeltas.lines.delta, 0.010000000000000009, "coverage deltas are captured");
  assert(fs.existsSync(result.evidenceFile), "proof evidence is persisted");
  assert(fs.existsSync(path.join(tmp, "feedback.json")), "agent feedback sink receives evidence");
  assert(result.confidence > 0.7, "confidence metric is produced");

  const firstCallCount = calls.length;
  const cached = await pipeline.verify({
    cwd: tmp,
    baseline: { benchmarks: { latencyMs: 10 }, coverage: { lines: 0.9 } },
    patchSet: { id: "p1", files: [srcFile] },
    changeSet: { changedFiles: [srcFile], before: { [srcFile]: "module.exports = { alpha };\nfunction alpha() { return 1; }\n" }, after: { [srcFile]: "module.exports = { alpha };\nfunction alpha() { return 2; }\n" } },
  });
  assert.equal(cached.ok, true);
  assert.equal(calls.length, firstCallCount, "cached proof avoids rerunning unchanged validators");
  assert(cached.verifiers.every((v) => v.cached), "cache status is explicit");

  let rolledBack = false;
  const failing = new VerifiedExecutionPipeline({
    verifiers: [
      make("compile2", "compile"), make("lint2", "lint"), make("unit2", "unit"), make("integration2", "integration"),
      make("static2", "static-analysis"), make("security2", "security"), make("benchmark2", "benchmark", { run: async () => ({ ok: true, benchmarks: { latencyMs: 99 } }) }), make("format2", "format"),
    ],
    cache: new VerificationCache(path.join(tmp, "cache2.json")),
    evidenceStore: new EvidenceStore(path.join(tmp, "evidence2")),
    metrics: new VerificationMetrics(path.join(tmp, "metrics2.json")),
  });
  const failed = await failing.execute({
    cwd: tmp,
    baseline: { benchmarks: { latencyMs: 10 } },
    patchSet: { id: "p2", files: [srcFile] },
    apply: async () => ({ changedFiles: [srcFile], before: { [srcFile]: "a" }, after: { [srcFile]: "b" } }),
    rollback: async () => { rolledBack = true; },
  });
  assert.equal(failed.ok, false, "benchmark regressions are policy rejections");
  assert(rolledBack, "failed verification triggers rollback");
  assert(failed.policy.violations.some((v) => /benchmark regression/.test(v.reason)));

  const docOnlyPipeline = new VerifiedExecutionPipeline({
    verifiers: [],
    evidenceStore: new EvidenceStore(path.join(tmp, "evidence-doc-only")),
    metrics: new VerificationMetrics(path.join(tmp, "metrics-doc-only.json")),
    requiredKinds: [],
  });
  const docOnly = await docOnlyPipeline.verify({
    cwd: tmp,
    patchSet: { id: "docs", files: ["docs/notes.md"] },
    changeSet: {
      changedFiles: ["docs/notes.md"],
      before: { "docs/notes.md": "old\n" },
      after: { "docs/notes.md": "new\n" },
    },
  });
  assert.equal(docOnly.ok, true, "doc-only changes receive a verifier fallback when no verifier matches");
  assert.equal(docOnly.verifiers.length, 1);
  assert.equal(docOnly.verifiers[0].id, "doc-only-fallback");
  assert.equal(docOnly.verifiers[0].fallback, true);
  assert(docOnly.proofArtifacts.some((a) => a.startsWith("doc-only-fallback://")), "doc-only fallback contributes a proof artifact");
  assert(docOnly.confidence > 0, "doc-only fallback produces proof confidence");

  const sourceNoVerifier = await docOnlyPipeline.verify({
    cwd: tmp,
    patchSet: { id: "source", files: [srcFile] },
    changeSet: {
      changedFiles: [srcFile],
      before: { [srcFile]: "module.exports = { alpha };\nfunction alpha(){}" },
      after: { [srcFile]: "module.exports = { beta };\nfunction beta(){}" },
    },
  });
  assert.equal(sourceNoVerifier.ok, false, "source changes without matching verifiers still fail closed");
  assert.equal(sourceNoVerifier.verifiers.length, 0);
  assert.equal(sourceNoVerifier.status, "blocked", "the API-removal fixture fails via pre-policy block, not coverage");

  const coverageGap = await docOnlyPipeline.verify({
    cwd: tmp,
    patchSet: { id: "body-only", files: [srcFile] },
    changeSet: {
      changedFiles: [srcFile],
      before: { [srcFile]: "module.exports = { alpha };\nfunction alpha() { return 1; }\n" },
      after: { [srcFile]: "module.exports = { alpha };\nfunction alpha() { return 2; }\n" },
    },
  });
  assert.equal(coverageGap.ok, false, "coverage gaps stay fail-closed");
  assert.equal(coverageGap.status, "no-verifiers", "missing verifier coverage is labeled as a gap, not a failed change");
  assert(/coverage gap/.test(coverageGap.reason));

  const emptyChange = await docOnlyPipeline.verify({
    cwd: tmp,
    patchSet: { id: "noop", files: [] },
    changeSet: { changedFiles: [], before: {}, after: {} },
  });
  assert.equal(emptyChange.ok, null, "an empty change set is not-applicable, not a failure");
  assert.equal(emptyChange.status, "not-applicable");
  assert.equal(emptyChange.policy.ok, true);
  const docOnlyMetrics = JSON.parse(fs.readFileSync(path.join(tmp, "metrics-doc-only.json"), "utf8"));
  assert.equal(docOnlyMetrics.skipped, 1, "not-applicable runs count as skipped, not failures");
  assert.equal(docOnlyMetrics.failures, 2, "fail-closed no-verifier runs still count as failures");

  const cmakeNoVerifier = await docOnlyPipeline.verify({
    cwd: tmp,
    patchSet: { id: "cmake", files: ["unit-tests/RuntimeRagdoll/CMakeLists.txt"] },
    changeSet: {
      changedFiles: ["unit-tests/RuntimeRagdoll/CMakeLists.txt"],
      before: { "unit-tests/RuntimeRagdoll/CMakeLists.txt": "add_test(old)\n" },
      after: { "unit-tests/RuntimeRagdoll/CMakeLists.txt": "add_test(new)\n" },
    },
  });
  assert.equal(cmakeNoVerifier.ok, false, "build configuration .txt files are not treated as doc-only");

  const impact = analyzeImpact({ changedFiles: [srcFile], before: { [srcFile]: "module.exports = { alpha };\nfunction alpha(){}" }, after: { [srcFile]: "module.exports = { beta };\nfunction beta(){}" } });
  assert(impact.publicApiChanges.length >= 2, "differential verification reports public API changes");

  const circularMetrics = { diagnostic: "m".repeat(20_000) };
  circularMetrics.self = circularMetrics;
  const boundedCustom = new Verifier({
    id: "bounded-custom",
    kind: "unit",
    maxOutputBytes: 2048,
    run: async () => ({ ok: false, output: "o".repeat(20_000), error: "e".repeat(10_000), metrics: circularMetrics }),
  });
  const boundedCustomResult = await boundedCustom.run({});
  assert(boundedCustomResult.output.length <= 2048, "custom verifier stdout is bounded during normalization");
  assert(boundedCustomResult.error.length <= 2048, "custom verifier stderr is bounded during normalization");
  assert.equal(boundedCustomResult.metrics.outputTruncated, true);
  assert.equal(boundedCustomResult.metrics.outputChars, 20_000);
  assert(boundedCustomResult.metrics.diagnostic.length <= 2048, "large metric strings are bounded before persistence");
  assert.equal(boundedCustomResult.metrics.self, "[Circular]", "circular custom metrics cannot break durable evidence serialization");

  const unicodeOutput = "💥".repeat(5_000);
  const boundedUnicode = new Verifier({ id: "bounded-unicode", kind: "unit", maxOutputBytes: 2048, run: async () => ({ output: unicodeOutput }) });
  const boundedUnicodeResult = await boundedUnicode.run({});
  assert(Buffer.byteLength(boundedUnicodeResult.output) <= 2048, "the configured byte ceiling also holds for multibyte verifier output");
  assert.equal(boundedUnicodeResult.metrics.outputBytes, Buffer.byteLength(unicodeOutput));

  const boundedCommand = new Verifier({
    id: "bounded-command",
    kind: "unit",
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(20000)); process.stderr.write('y'.repeat(10000));"],
    cwd: tmp,
    maxOutputBytes: 2048,
  });
  const boundedCommandResult = await boundedCommand.run({});
  assert.equal(boundedCommandResult.ok, true);
  assert(boundedCommandResult.output.length < 2300, "command stdout is bounded while the child is still running");
  assert.equal(boundedCommandResult.metrics.stdoutBytes, 20_000);
  assert.equal(boundedCommandResult.metrics.stderrBytes, 10_000);
  assert.equal(boundedCommandResult.metrics.outputTruncated, true);
  assert.equal(boundedCommandResult.metrics.errorTruncated, true);

  console.log("verification-pipeline tests passed");
})().catch((err) => { console.error(err); process.exit(1); });
