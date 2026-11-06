"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  canonicalFrame,
  loadVisualConfig,
  planVisualVerification,
  runVisualVerification,
  assertVisualMetadataOnly,
  providerReadinessForCase,
  sourceFingerprint,
  configHash,
  cleanupEphemeralVisualArtifacts,
  sha,
  _baselineInternals,
} = require("../src/visual-verification");
const { previewBaseline, applyBaseline } = require("../src/visual-baselines");
const { scanEvidence } = require("../src/evidence-inbox");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const cwd = tmpFixture("pi-visual-verification-");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "fixtures"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "baselines"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "view.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(cwd, "fixtures", "capture.js"), "exports.capture = ({width}) => ({width, lines: ['hello', 'world']});\n");
  fs.writeFileSync(path.join(cwd, ".pi", "project.json"), JSON.stringify({
    visualVerification: {
      schemaVersion: 1,
      baselineManifest: "baselines/manifest.json",
      cases: [{ caseId: "frame", kind: "tui-frame", profiles: ["full"], sources: ["view.js"], capture: { module: "fixtures/capture.js", export: "capture", input: { width: 12 } }, baselineId: "frame-v1", thresholds: { maxChangedLines: 0 } }],
    },
  }));

  assert.equal(loadVisualConfig(cwd).cases.length, 1);
  assert.deepEqual(loadVisualConfig(cwd).cases[0].sources, ["view.js", "fixtures/capture.js"], "capture modules are always source-identified");
  const plan = planVisualVerification({ cwd, profile: "full" });
  assert.equal(plan.ready, false);
  assert.equal(plan.cases[0].readiness.providerId, "tui-frame");
  assert.equal(plan.cases[0].readiness.reasonCode, "baseline-missing");
  fs.writeFileSync(path.join(cwd, "baselines", "manifest.json"), "{malformed");
  assert.equal(planVisualVerification({ cwd, profile: "full" }).cases[0].readiness.reasonCode, "invalid-baseline-manifest");
  await assert.rejects(() => applyBaseline({ cwd, caseId: "frame", apply: true, yes: true, approvalRef: "review" }), /invalid visual baseline manifest/);
  fs.rmSync(path.join(cwd, "baselines", "manifest.json"));

  const preview = await previewBaseline({ cwd, caseId: "frame" });
  assert.equal(preview.wrote, false);
  assert.equal(fs.existsSync(path.join(cwd, "baselines", "manifest.json")), false, "preview is non-mutating");
  await assert.rejects(() => applyBaseline({ cwd, caseId: "frame", apply: true, yes: false, approvalRef: "review" }), /requires apply=true and yes=true/);
  const applied = await applyBaseline({ cwd, caseId: "frame", apply: true, yes: true, approvalRef: "review-1" });
  assert.equal(applied.wrote, true);
  const manifestText = fs.readFileSync(path.join(cwd, "baselines", "manifest.json"), "utf8");
  assert(!manifestText.includes("hello"), "TUI baseline persists hashes, not frame bodies");
  assert(!manifestText.includes("world"));

  assert.equal(planVisualVerification({ cwd, profile: "full" }).ready, true);
  const passed = await runVisualVerification({ cwd, profile: "full" });
  assert.equal(passed.ok, true);
  assert.equal(passed.results[0].metrics.changedLines, 0);
  assert.equal(passed.results[0].actual.digest.startsWith("sha256:"), true);
  assert.equal(JSON.stringify(passed).includes("hello"), false, "visual evidence excludes frame bodies");
  const mismatchedManifest = JSON.parse(fs.readFileSync(path.join(cwd, "baselines", "manifest.json"), "utf8"));
  mismatchedManifest.entries[0].lineDigests[0] = `sha256:${"0".repeat(64)}`;
  fs.writeFileSync(path.join(cwd, "baselines", "manifest.json"), JSON.stringify(mismatchedManifest));
  const mismatch = await runVisualVerification({ cwd, profile: "full" });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.results[0].status, "mismatch");
  assert.equal(mismatch.results[0].metrics.changedLines, 1);
  await applyBaseline({ cwd, caseId: "frame", apply: true, yes: true, approvalRef: "review-2" });

  fs.writeFileSync(path.join(cwd, "view.js"), "module.exports = 2;\n");
  const stale = await runVisualVerification({ cwd, profile: "full" });
  assert.equal(stale.ok, false);
  assert.equal(stale.results[0].status, "stale-baseline");
  assert.equal(stale.results[0].reasonCode, "baseline-source-stale");

  const frame = canonicalFrame(["\u001b[31mred\u001b[0m"], 12);
  assert.equal(frame.width, 12);
  assert.equal(frame.lineDigests.length, 1);
  assert.throws(() => canonicalFrame(["\u001b]8;;https://example.test\u0007link"], 40), /unsafe-terminal-control/);
  assert.throws(() => canonicalFrame(["too wide"], 3), /frame-width-exceeded/);
  assert.throws(() => assertVisualMetadataOnly({ output: "raw" }), /forbidden-visual-metadata-key/);
  assert.throws(() => assertVisualMetadataOnly({ artifactRef: "/tmp/private.png" }), /unsafe-visual-metadata/);

  const orphanRoot = tmpFixture("pi-visual-retention-root-");
  const orphan = path.join(orphanRoot, "pi-visual-orphan");
  fs.mkdirSync(orphan);
  const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  fs.utimesSync(orphan, oldTime, oldTime);
  assert.equal(cleanupEphemeralVisualArtifacts({ root: orphanRoot, apply: false }).candidates, 1);
  assert.equal(fs.existsSync(orphan), true);
  assert.equal(cleanupEphemeralVisualArtifacts({ root: orphanRoot, apply: true }).removed, 1);
  assert.equal(fs.existsSync(orphan), false);

  const imageReadiness = providerReadinessForCase(cwd, { kind: "image", capture: {} }, { PATH: "" });
  assert.equal(imageReadiness.ready, false);
  assert.equal(imageReadiness.reasonCode, "binary-unavailable");
  const localImageReadiness = providerReadinessForCase(cwd, { kind: "image", capture: {} }, process.env);
  if (localImageReadiness.ready) {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    fs.writeFileSync(path.join(cwd, "actual.png"), png);
    fs.writeFileSync(path.join(cwd, "baselines", "pixel.png"), png);
    const imageCase = { caseId: "pixel", kind: "image", profiles: ["full"], sources: ["view.js"], capture: {}, baselineId: "pixel-v1", thresholds: { maxChangedPixelRatio: 0 } };
    fs.writeFileSync(path.join(cwd, ".pi", "project.json"), JSON.stringify({ visualVerification: { schemaVersion: 1, baselineManifest: "baselines/manifest.json", cases: [imageCase] } }));
    fs.writeFileSync(path.join(cwd, "baselines", "manifest.json"), JSON.stringify({ schemaVersion: 1, entries: [{ schemaVersion: 1, baselineId: "pixel-v1", caseId: "pixel", kind: "image", sourceFingerprint: sourceFingerprint(cwd, imageCase.sources), captureConfigHash: configHash(imageCase), providerId: localImageReadiness.providerId, providerVersion: localImageReadiness.version, artifact: { relativeRef: "baselines/pixel.png", digest: sha(png), mediaType: "image/png" } }] }));
    const actualRef = scanEvidence(cwd, { roots: [cwd], kinds: ["image"], sinceMinutes: 60 }).entries[0].artifactRef;
    const imageResult = await runVisualVerification({ cwd, profile: "full", actualRefs: [{ caseId: "pixel", artifactRef: actualRef }], evidenceOptions: { roots: [cwd] } });
    assert.equal(imageResult.ok, true, `optional ImageMagick integration failed: ${JSON.stringify(imageResult)}`);
    assert.equal(imageResult.results[0].metrics.changedPixels, 0);
  } else {
    assert.equal(localImageReadiness.reasonCode, "binary-unavailable");
  }
  const browserReadiness = providerReadinessForCase(cwd, { kind: "browser", capture: {} }, { PATH: "" });
  assert.equal(browserReadiness.ready, false, "browser remains readiness-only until installed and authorized");
  assert.throws(() => _baselineInternals.graphvizSafe('digraph { a [image="/tmp/private.png"] }'), /unsafe-graphviz-source/);
  assert.match(_baselineInternals.graphvizSafe("digraph { a -> b }"), /a -> b/);
  fs.symlinkSync(path.join(cwd, "view.js"), path.join(cwd, "view-link.js"));
  assert.throws(() => sourceFingerprint(cwd, ["view-link.js"]), /invalid-artifact-file/, "source identities reject symlinks");
  const oversized = path.join(cwd, "oversized.png");
  fs.writeFileSync(oversized, "x"); fs.truncateSync(oversized, 64 * 1024 * 1024 + 1);
  assert.throws(() => _baselineInternals.metadataArtifact(oversized, "image/png"), /invalid-artifact-file/);

  const graphCase = { caseId: "graph", kind: "graphviz", profiles: ["full"], sources: ["fixtures/graph.js"], capture: { module: "fixtures/graph.js", export: "capture" }, baselineId: "graph-v1", baselineArtifact: "baselines/graph.png", thresholds: { maxChangedPixelRatio: 0 } };
  if (providerReadinessForCase(cwd, graphCase).ready) {
    fs.writeFileSync(path.join(cwd, "fixtures", "graph.js"), 'exports.capture = () => ({ dot: "digraph { A -> B }" });\n');
    fs.writeFileSync(path.join(cwd, ".pi", "project.json"), JSON.stringify({ visualVerification: { schemaVersion: 1, baselineManifest: "baselines/manifest.json", cases: [graphCase] } }));
    fs.writeFileSync(path.join(cwd, "baselines", "manifest.json"), JSON.stringify({ schemaVersion: 1, entries: [] }));
    await applyBaseline({ cwd, caseId: "graph", apply: true, yes: true, approvalRef: "graph-review" });
    const graphRun = await runVisualVerification({ cwd, profile: "full" });
    assert.equal(graphRun.ok, true);
    assert.equal(JSON.stringify(graphRun).includes("A -> B"), false, "graph source bodies do not enter evidence");
  }

  const fakeMagick = path.join(cwd, "fixtures", process.platform === "win32" ? "magick.cmd" : "magick");
  fs.writeFileSync(fakeMagick, process.platform === "win32" ? "@echo off\r\necho Version: ImageMagick fixture\r\n" : "#!/bin/sh\necho Version: ImageMagick fixture\n");
  if (process.platform !== "win32") fs.chmodSync(fakeMagick, 0o755);
  const externalEnv = { ...process.env, PI_VISUAL_IMAGEMAGICK_BIN: fakeMagick };
  const externalScript = path.join(cwd, "fixtures", "external.js");
  fs.writeFileSync(externalScript, 'require("node:fs").writeFileSync(process.env.PI_VISUAL_OUTPUT_MANIFEST, JSON.stringify({schemaVersion:1}));\n');
  const externalCase = { caseId: "external", kind: "external-manifest", profiles: ["full"], sources: ["fixtures/external.js"], capture: { command: process.execPath, args: [externalScript], providerVersion: "fixture-v1" }, baselineId: "external-v1", thresholds: { maxChangedPixelRatio: 0 } };
  fs.writeFileSync(path.join(cwd, ".pi", "project.json"), JSON.stringify({ visualVerification: { schemaVersion: 1, baselineManifest: "baselines/manifest.json", cases: [externalCase] } }));
  fs.writeFileSync(path.join(cwd, "baselines", "manifest.json"), JSON.stringify({ schemaVersion: 1, entries: [{ schemaVersion: 1, baselineId: "external-v1", caseId: "external", kind: "external-manifest", sourceFingerprint: sourceFingerprint(cwd, externalCase.sources), captureConfigHash: configHash(externalCase), providerId: "external-manifest", providerVersion: providerReadinessForCase(cwd, externalCase, externalEnv).version }] }));
  const malformed = await runVisualVerification({ cwd, profile: "full", env: externalEnv });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.results[0].status, "infrastructure-failed");
  assert.equal(malformed.results[0].reasonCode, "invalid-external-manifest");
  assert.equal(JSON.stringify(malformed).includes(externalScript), false, "external command paths never enter visual evidence");
  fs.writeFileSync(externalScript, 'const fs=require("node:fs"); fs.appendFileSync(__filename, "\\n// mutated"); fs.writeFileSync(process.env.PI_VISUAL_OUTPUT_MANIFEST, JSON.stringify({schemaVersion:1}));\n');
  fs.writeFileSync(path.join(cwd, "baselines", "manifest.json"), JSON.stringify({ schemaVersion: 1, entries: [{ schemaVersion: 1, baselineId: "external-v1", caseId: "external", kind: "external-manifest", sourceFingerprint: sourceFingerprint(cwd, externalCase.sources), captureConfigHash: configHash(externalCase), providerId: "external-manifest", providerVersion: providerReadinessForCase(cwd, externalCase, externalEnv).version }] }));
  const mutated = await runVisualVerification({ cwd, profile: "full", env: externalEnv });
  assert.equal(mutated.status, "governed-input-mutated-during-verification");
  assert.deepEqual(mutated.results, []);
  fs.writeFileSync(path.join(cwd, ".pi", "project.json"), JSON.stringify({ visualVerification: { schemaVersion: 1, baselineManifest: "../outside.json", cases: [externalCase] } }));
  const invalidConfig = planVisualVerification({ cwd, profile: "full" });
  assert.equal(invalidConfig.ready, false);
  assert(invalidConfig.issues.includes("invalid-baseline-manifest-reference"));
  fs.writeFileSync(path.join(cwd, ".pi", "project.json"), "{malformed");
  const malformedConfig = planVisualVerification({ cwd, profile: "full" });
  assert.equal(malformedConfig.configured, true);
  assert.equal(malformedConfig.status, "degraded");
  assert(malformedConfig.issues.includes("invalid-project-config"));
  assert.equal((await runVisualVerification({ cwd, profile: "full" })).status, "configuration-invalid");

  console.log("visual verification tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
