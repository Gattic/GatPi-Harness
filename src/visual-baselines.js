"use strict";

// Explicit, command-only baseline administration. Verification adapters do
// not import this module and therefore cannot mutate baselines.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  VISUAL_SCHEMA_VERSION,
  loadVisualConfig,
  loadBaselineManifest,
  sourceFingerprint,
  configHash,
  providerReadinessForCase,
  sha,
  _baselineInternals,
} = require("./visual-verification");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function atomicWrite(file, content, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temporary, content, { mode, flag: "wx" });
  try { fs.renameSync(temporary, file); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
}

async function createBaselineCandidate(request = {}) {
  const cwd = path.resolve(request.cwd || process.cwd());
  const config = loadVisualConfig(cwd);
  const caseSpec = config.cases.find((item) => item.caseId === request.caseId);
  if (!caseSpec) throw new Error("unknown visual case id");
  const readiness = providerReadinessForCase(cwd, caseSpec, request.env || process.env);
  if (!readiness.ready) throw new Error(`visual provider unavailable: ${readiness.reasonCode}`);
  const identity = { sourceFingerprint: sourceFingerprint(cwd, caseSpec.sources), captureConfigHash: configHash(caseSpec) };
  const base = {
    schemaVersion: VISUAL_SCHEMA_VERSION,
    baselineId: caseSpec.baselineId,
    caseId: caseSpec.caseId,
    kind: caseSpec.kind,
    ...identity,
    providerId: readiness.providerId,
    providerVersion: readiness.version || null,
    approvedAt: null,
    approvalRef: null,
  };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-visual-baseline-"));
  try {
    fs.chmodSync(tmpRoot, 0o700);
    if (caseSpec.kind === "tui-frame") {
      const captured = await _baselineInternals.captureModule(cwd, caseSpec, tmpRoot);
      const frame = require("./visual-verification").canonicalFrame(captured.lines, Number(caseSpec.capture?.input?.width || captured.width));
      return { public: { ...base, width: frame.width, height: frame.height, frameDigest: frame.digest, lineDigests: frame.lineDigests }, body: null, target: null };
    }
    if (caseSpec.kind === "browser") throw new Error("browser baseline capture is unavailable");
    const actual = await _baselineInternals.actualForCase(cwd, caseSpec, { ...request, cwd, env: request.env || process.env, actualRefs: request.actualRef ? [{ caseId: caseSpec.caseId, artifactRef: request.actualRef }] : request.actualRefs }, tmpRoot, readiness);
    if (!actual.file) throw new Error("visual case did not produce an artifact");
    if (!caseSpec.baselineArtifact) throw new Error("non-frame visual cases require configured baselineArtifact");
    const target = _baselineInternals.confinedProjectFile(cwd, String(caseSpec.baselineArtifact), { mustExist: false });
    const mediaType = String(actual.mediaType || (path.extname(target).toLowerCase() === ".png" ? "image/png" : "application/octet-stream"));
    const artifactMetadata = _baselineInternals.metadataArtifact(actual.file, mediaType);
    const body = fs.readFileSync(actual.file);
    return {
      public: { ...base, artifact: { relativeRef: path.relative(cwd, target).replace(/\\/g, "/"), digest: artifactMetadata.digest, mediaType, bytes: artifactMetadata.bytes, width: actual.width || null, height: actual.height || null } },
      body,
      target,
    };
  } finally { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
}

async function previewBaseline(request = {}) {
  const candidate = await createBaselineCandidate(request);
  const { lineDigests, ...bounded } = candidate.public;
  return { schemaVersion: 1, operation: "preview", wrote: false, candidate: { ...bounded, lineDigestCount: lineDigests?.length || 0 } };
}

async function applyBaseline(request = {}) {
  if (request.apply !== true || request.yes !== true) throw new Error("baseline apply requires apply=true and yes=true");
  if (!SAFE_ID.test(String(request.approvalRef || ""))) throw new Error("baseline apply requires a safe approvalRef");
  const cwd = path.resolve(request.cwd || process.cwd());
  const config = loadVisualConfig(cwd);
  if (!config.baselineManifest) throw new Error("visual baseline manifest is not configured");
  const candidate = await createBaselineCandidate(request);
  const entry = { ...candidate.public, approvedAt: new Date().toISOString(), approvalRef: request.approvalRef };
  const manifest = loadBaselineManifest(config);
  if (manifest.schemaVersion !== VISUAL_SCHEMA_VERSION) throw new Error("invalid visual baseline manifest");
  const entries = manifest.entries.filter((item) => !(item?.caseId === entry.caseId && item?.baselineId === entry.baselineId));
  entries.push(entry);
  entries.sort((a, b) => `${a.caseId}:${a.baselineId}`.localeCompare(`${b.caseId}:${b.baselineId}`));
  const previousArtifact = candidate.target && fs.existsSync(candidate.target) ? fs.readFileSync(candidate.target) : null;
  try {
    if (candidate.body && candidate.target) atomicWrite(candidate.target, candidate.body, 0o644);
    atomicWrite(config.baselineManifest, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, 0o644);
  } catch (error) {
    if (candidate.target) {
      try { if (previousArtifact) atomicWrite(candidate.target, previousArtifact, 0o644); else fs.rmSync(candidate.target, { force: true }); } catch {}
    }
    throw error;
  }
  return { schemaVersion: 1, operation: "apply", wrote: true, caseId: entry.caseId, baselineId: entry.baselineId, manifestDigest: sha(fs.readFileSync(config.baselineManifest)) };
}

module.exports = { createBaselineCandidate, previewBaseline, applyBaseline };
