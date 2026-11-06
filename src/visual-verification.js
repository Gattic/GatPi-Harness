"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { resolveEvidenceArtifact } = require("./evidence-inbox");

const VISUAL_SCHEMA_VERSION = 1;
const PROVIDER_ADAPTER_VERSION = "1.0.0";
const CASE_KINDS = new Set(["tui-frame", "image", "graphviz", "external-manifest", "browser"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_FRAME_LINES = 400;
const MAX_FRAME_WIDTH = 512;
const MAX_PROCESS_OUTPUT = 32 * 1024;
const FORBIDDEN_METADATA_KEY = /(?:prompt|transcript|reasoning|command|args|stdout|stderr|output|content|body|selector|url|path|cwd|secret|token|password|note|hypothesis|title)/i;
const OSC_ESCAPE = new RegExp("\\x1b\\](?:.|\\n)*?(?:\\x07|\\x1b\\\\\\\\)");
const NON_SGR_ESCAPE = new RegExp("\\x1b(?!\\[[0-9;]*m)");
const SGR_ESCAPE = new RegExp("\\x1b\\[[0-9;]*m", "g");
const ABSOLUTE_PATH_VALUE = new RegExp("(?:^|[\\s\"'])(?:/[^\\s\"']+|[A-Za-z]:\\\\\\\\)");
const GRAPH_EXTERNAL_REFERENCE = new RegExp("\\b(?:image|shapefile|href|URL|stylesheet)\\s*=|<\\s*IMG\\b|(?:file|https?)://", "i");
const GRAPH_ABSOLUTE_REFERENCE = new RegExp("(?:^|[=\\s\"])(?:/|~/|[A-Za-z]:\\\\\\\\)", "m");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function sha(value) { return `sha256:${crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest("hex")}`; }
function safeId(value, fallback = "visual") { const text = String(value || "").trim(); return SAFE_ID.test(text) ? text : `${fallback}_${sha(text).slice(7, 23)}`; }
function finite(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function readJson(file, fallback = null, maxBytes = MAX_CONFIG_BYTES) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return fallback; }
}
function boundedFileDigest(file, maxBytes = MAX_CONFIG_BYTES) { try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes ? sha(fs.readFileSync(file)) : "unavailable"; } catch { return null; } }
function isInside(root, target) { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); }
function confinedProjectFile(cwd, relative, options = {}) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\0")) throw fixedError("invalid-relative-reference");
  const target = path.resolve(cwd, relative);
  if (!isInside(path.resolve(cwd), target) || target === path.resolve(cwd)) throw fixedError("reference-outside-project");
  let cursor = path.dirname(target);
  while (isInside(path.resolve(cwd), cursor) && cursor !== path.resolve(cwd)) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw fixedError("symlink-component"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    cursor = path.dirname(cursor);
  }
  if (options.mustExist !== false) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw fixedError("invalid-artifact-file");
    if (stat.size > (options.maxBytes || MAX_ARTIFACT_BYTES)) throw fixedError("artifact-too-large");
  }
  return target;
}
function fixedError(code) { const error = new Error(code); error.code = code; return error; }
function cleanupEphemeralVisualArtifacts({ apply = false, root = os.tmpdir(), now = Date.now(), maxAgeMs = 24 * 60 * 60_000, limit = 100 } = {}) {
  const candidates = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { return { apply, candidates: 0, removed: 0 }; }
  for (const name of names) {
    if (!/^pi-visual(?:-baseline)?-[A-Za-z0-9_-]+$/.test(name) || candidates.length >= limit) continue;
    const target = path.join(root, name);
    try { const stat = fs.lstatSync(target); if (stat.isDirectory() && !stat.isSymbolicLink() && now - stat.mtimeMs > maxAgeMs) candidates.push(target); } catch {}
  }
  let removed = 0;
  if (apply) for (const target of candidates) { try { fs.rmSync(target, { recursive: true, force: true }); removed++; } catch {} }
  return { apply, candidates: candidates.length, removed };
}
function executableOnPath(command, env = process.env) {
  if (!command || /[\r\n\0]/.test(command)) return null;
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    try { const stat = fs.statSync(command); return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111)) ? path.resolve(command) : null; } catch { return null; }
  }
  for (const root of String(env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(root, command);
    try { const stat = fs.statSync(candidate); if (stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111))) return candidate; } catch {}
  }
  return null;
}
function binaryVersion(command, args = ["-version"], env = process.env) {
  const executable = executableOnPath(command, env);
  if (!executable) return null;
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 3000, maxBuffer: MAX_PROCESS_OUTPUT, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) return null;
  const first = `${result.stdout || ""}\n${result.stderr || ""}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  return { executable, version: first ? sha(first) : "unknown" };
}
function metadataArtifact(file, mediaType, artifactRef = null) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES) throw fixedError("invalid-artifact-file");
  return { artifactRef, digest: sha(fs.readFileSync(file)), mediaType: String(mediaType || "application/octet-stream").slice(0, 100), bytes: stat.size, width: null, height: null };
}
function sourceFingerprint(cwd, sources = []) {
  const rows = [];
  for (const relative of [...new Set(sources.map(String))].sort()) {
    const file = confinedProjectFile(cwd, relative);
    rows.push({ sourceId: safeId(relative.replaceAll("/", ":"), "source"), digest: sha(fs.readFileSync(file)) });
  }
  return sha(rows);
}
function configHash(caseSpec) { return sha({ ...caseSpec, capture: caseSpec.capture ? { ...caseSpec.capture, input: stable(caseSpec.capture.input || {}) } : null }); }

function loadVisualConfig(cwd = process.cwd()) {
  const projectFile = path.join(cwd, ".pi", "project.json");
  const project = readJson(projectFile, null);
  if (project == null) return fs.existsSync(projectFile)
    ? { schemaVersion: VISUAL_SCHEMA_VERSION, configured: true, baselineManifest: null, cases: [], issues: ["invalid-project-config"] }
    : { schemaVersion: VISUAL_SCHEMA_VERSION, configured: false, baselineManifest: null, cases: [], issues: [] };
  const raw = project.visualVerification;
  if (!raw) return { schemaVersion: VISUAL_SCHEMA_VERSION, configured: false, baselineManifest: null, cases: [], issues: [] };
  const issues = [];
  if (raw.schemaVersion !== VISUAL_SCHEMA_VERSION) issues.push("invalid-config-schema");
  const cases = [];
  const seen = new Set();
  for (const input of Array.isArray(raw.cases) ? raw.cases.slice(0, 100) : []) {
    const caseId = String(input?.caseId || "");
    if (!SAFE_ID.test(caseId) || seen.has(caseId) || !CASE_KINDS.has(input?.kind)) { issues.push("invalid-case"); continue; }
    seen.add(caseId);
    const capture = input.capture && typeof input.capture === "object" ? input.capture : {};
    const sources = Array.isArray(input.sources) ? input.sources.map(String).slice(0, 100) : [];
    if (typeof capture.module === "string" && !sources.includes(capture.module)) sources.push(capture.module);
    const profiles = Array.isArray(input.profiles) ? input.profiles.map(String).filter((profile) => ["quick", "changed", "full", "learning"].includes(profile)) : ["full"];
    cases.push({ ...input, caseId, kind: input.kind, sources, profiles, baselineId: safeId(input.baselineId || caseId, "baseline"), thresholds: input.thresholds && typeof input.thresholds === "object" ? input.thresholds : {}, capture });
  }
  let baselineManifest = null;
  try { baselineManifest = raw.baselineManifest ? confinedProjectFile(cwd, String(raw.baselineManifest), { mustExist: false }) : null; }
  catch { issues.push("invalid-baseline-manifest-reference"); }
  return { schemaVersion: VISUAL_SCHEMA_VERSION, configured: true, baselineManifest, cases, issues };
}

function loadBaselineManifest(config) {
  if (!config.baselineManifest || !fs.existsSync(config.baselineManifest)) return { schemaVersion: VISUAL_SCHEMA_VERSION, entries: [] };
  const value = readJson(config.baselineManifest, null);
  return value?.schemaVersion === VISUAL_SCHEMA_VERSION && Array.isArray(value.entries) ? value : { schemaVersion: 0, entries: [] };
}

function providerReadinessForCase(cwd, caseSpec, env = process.env) {
  if (caseSpec.kind === "tui-frame") return { providerId: "tui-frame", ready: true, version: PROVIDER_ADAPTER_VERSION, reasonCode: "ready" };
  if (caseSpec.kind === "image") {
    const binary = binaryVersion(env.PI_VISUAL_IMAGEMAGICK_BIN || "magick", ["-version"], env);
    return { providerId: "imagemagick", ready: Boolean(binary), version: binary?.version || null, reasonCode: binary ? "ready" : "binary-unavailable" };
  }
  if (caseSpec.kind === "graphviz") {
    const dot = binaryVersion(env.PI_VISUAL_GRAPHVIZ_BIN || "dot", ["-V"], env);
    const image = binaryVersion(env.PI_VISUAL_IMAGEMAGICK_BIN || "magick", ["-version"], env);
    return { providerId: "graphviz", ready: Boolean(dot && image), version: dot && image ? `${dot.version}; ${image.version}` : null, reasonCode: !dot ? "graphviz-unavailable" : !image ? "imagemagick-unavailable" : "ready" };
  }
  if (caseSpec.kind === "external-manifest") {
    const command = String(caseSpec.capture?.command || "");
    const executable = executableOnPath(command, env);
    const declaredVersion = SAFE_ID.test(String(caseSpec.capture?.providerVersion || "")) ? String(caseSpec.capture.providerVersion) : null;
    const image = binaryVersion(env.PI_VISUAL_IMAGEMAGICK_BIN || "magick", ["-version"], env);
    return { providerId: "external-manifest", ready: Boolean(executable && declaredVersion && image), version: declaredVersion && image ? `${PROVIDER_ADAPTER_VERSION}; ${declaredVersion}; ${image.version}` : null, reasonCode: !executable ? "configured-command-unavailable" : !declaredVersion ? "provider-version-required" : !image ? "imagemagick-unavailable" : "ready" };
  }
  if (caseSpec.kind === "browser") {
    let installed = false;
    try { require.resolve("playwright", { paths: [cwd] }); installed = true; } catch {}
    return { providerId: "playwright", ready: false, version: null, reasonCode: installed ? "browser-execution-not-authorized" : "package-unavailable" };
  }
  return { providerId: "visual", ready: false, version: null, reasonCode: "unsupported-case-kind" };
}

function selectedCases(config, request = {}) {
  const requested = Array.isArray(request.caseIds) && request.caseIds.length ? new Set(request.caseIds.map(String)) : null;
  const changed = new Set((request.changedFiles || []).map(String));
  return config.cases.filter((item) => {
    if (requested && !requested.has(item.caseId)) return false;
    if (!item.profiles.includes(request.profile || "changed")) return false;
    if ((request.profile || "changed") === "changed" && changed.size && item.sources.length && !item.sources.some((source) => changed.has(source))) return false;
    return true;
  });
}

function planVisualVerification(request = {}) {
  const cwd = path.resolve(request.cwd || process.cwd());
  const config = loadVisualConfig(cwd);
  const manifest = loadBaselineManifest(config);
  const cases = selectedCases(config, request).map((item) => {
    const provider = providerReadinessForCase(cwd, item, request.env || process.env);
    const captureConfigHash = configHash(item);
    let sourceIdentity = null; let baseline = { ok: false, reasonCode: "source-identity-unavailable" };
    try {
      sourceIdentity = sourceFingerprint(cwd, item.sources);
      baseline = manifest.schemaVersion === VISUAL_SCHEMA_VERSION ? baselineFreshness(baselineEntryFor(manifest, item), { sourceFingerprint: sourceIdentity, captureConfigHash, providerId: provider.providerId, providerVersion: provider.version || null }) : { ok: false, reasonCode: "invalid-baseline-manifest" };
    } catch {}
    const actualRefPresent = item.kind !== "image" || (request.actualRefs || []).some((row) => row?.caseId === item.caseId && row?.artifactRef);
    const ready = provider.ready && baseline.ok && actualRefPresent;
    const reasonCode = !provider.ready ? provider.reasonCode : !baseline.ok ? baseline.reasonCode : !actualRefPresent ? "actual-artifact-required" : "ready";
    return { caseId: item.caseId, kind: item.kind, baselineId: item.baselineId, sourceCount: item.sources.length, sourceFingerprint: sourceIdentity, configHash: captureConfigHash, baselineStatus: baseline.reasonCode, readiness: { ...provider, ready, reasonCode } };
  });
  const applicable = cases.length > 0;
  const ready = applicable && config.issues.length === 0 && cases.every((item) => item.readiness.ready);
  return { schemaVersion: VISUAL_SCHEMA_VERSION, configured: config.configured, applicable, ready, status: !applicable ? (config.issues.length ? "degraded" : "not-applicable") : ready ? "ready" : "degraded", issues: config.issues, cases };
}

function runBounded(command, args, options = {}) {
  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, shell: false, detached, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => { if (detached && child.pid) { try { process.kill(-child.pid, "SIGKILL"); return; } catch {} } try { child.kill("SIGKILL"); } catch {} };
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let overflow = false; let timedOut = false; let spawnCode = null;
    const add = (current, chunk) => { const combined = Buffer.concat([current, Buffer.from(chunk)]); if (combined.length > MAX_PROCESS_OUTPUT) { overflow = true; return combined.subarray(0, MAX_PROCESS_OUTPUT); } return combined; };
    child.stdout.on("data", (chunk) => { stdout = add(stdout, chunk); if (overflow) kill(); });
    child.stderr.on("data", (chunk) => { stderr = add(stderr, chunk); if (overflow) kill(); });
    child.on("error", (error) => { spawnCode = error.code || "spawn-failed"; });
    const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(100, Math.min(10 * 60_000, Number(options.timeoutMs) || 30_000)));
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), overflow, timedOut, spawnCode }); });
  });
}

function canonicalFrame(lines, width) {
  if (!Array.isArray(lines)) throw fixedError("invalid-frame");
  const frameWidth = Number(width);
  if (!Number.isInteger(frameWidth) || frameWidth < 1 || frameWidth > MAX_FRAME_WIDTH || lines.length > MAX_FRAME_LINES) throw fixedError("invalid-frame-bounds");
  const canonical = lines.map((input) => {
    let line = String(input).normalize("NFC");
    if (OSC_ESCAPE.test(line) || NON_SGR_ESCAPE.test(line)) throw fixedError("unsafe-terminal-control");
    line = line.replace(SGR_ESCAPE, "");
    if ([...line].some((character) => { const code = character.charCodeAt(0); return code <= 8 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || (code >= 14 && code <= 31) || code === 127; })) throw fixedError("unsafe-frame-control");
    if ([...line].length > frameWidth) throw fixedError("frame-width-exceeded");
    return line.padEnd(frameWidth, " ");
  });
  if (Buffer.byteLength(canonical.join("\n")) > MAX_FRAME_BYTES) throw fixedError("frame-too-large");
  return { width: frameWidth, height: canonical.length, digest: sha(canonical.join("\n")), lineDigests: canonical.map(sha) };
}

async function captureModule(cwd, caseSpec, tmpRoot) {
  const moduleFile = confinedProjectFile(cwd, String(caseSpec.capture?.module || ""));
  const runner = path.join(__dirname, "..", "scripts", "visual-capture-runner.js");
  const requestFile = path.join(tmpRoot, "request.json");
  const outputFile = path.join(tmpRoot, "capture.json");
  fs.writeFileSync(requestFile, JSON.stringify({ schemaVersion: 1, moduleFile, exportName: safeId(caseSpec.capture?.export || "capture", "capture"), input: caseSpec.capture?.input || {}, kind: caseSpec.kind, outputFile }), { mode: 0o600 });
  const result = await runBounded(process.execPath, [runner, requestFile], { cwd, timeoutMs: caseSpec.timeoutMs || 30_000 });
  if (result.code !== 0 || result.timedOut || result.overflow) throw fixedError(result.timedOut ? "capture-timeout" : result.overflow ? "capture-output-overflow" : "capture-failed");
  const captured = readJson(outputFile, null, MAX_FRAME_BYTES * 2);
  if (!captured || captured.schemaVersion !== 1) throw fixedError("invalid-capture-manifest");
  return captured;
}

function baselineEntryFor(manifest, caseSpec) { return manifest.entries.find((entry) => entry?.baselineId === caseSpec.baselineId && entry?.caseId === caseSpec.caseId) || null; }
function baselineFreshness(entry, identities) {
  if (!entry) return { ok: false, reasonCode: "baseline-missing" };
  if (entry.schemaVersion !== VISUAL_SCHEMA_VERSION) return { ok: false, reasonCode: "baseline-schema-mismatch" };
  if (entry.captureConfigHash !== identities.captureConfigHash) return { ok: false, reasonCode: "baseline-config-stale" };
  if (entry.sourceFingerprint !== identities.sourceFingerprint) return { ok: false, reasonCode: "baseline-source-stale" };
  if (entry.providerId !== identities.providerId || entry.providerVersion !== identities.providerVersion) return { ok: false, reasonCode: "baseline-provider-stale" };
  return { ok: true, reasonCode: "current" };
}
function boundedThresholds(caseSpec) {
  return {
    maxChangedLines: Math.max(0, Math.floor(finite(caseSpec.thresholds?.maxChangedLines) ?? 0)),
    maxChangedPixelRatio: Math.max(0, Math.min(1, finite(caseSpec.thresholds?.maxChangedPixelRatio) ?? 0)),
    fuzzPercent: Math.max(0, Math.min(100, finite(caseSpec.thresholds?.fuzzPercent) ?? 0)),
  };
}

async function identifyImage(binary, file, cwd) {
  const result = await runBounded(binary, ["identify", "-limit", "memory", "256MiB", "-limit", "map", "512MiB", "-limit", "disk", "1GiB", "-format", "%m %w %h", file], { cwd, timeoutMs: 10_000 });
  if (result.code !== 0 || result.timedOut || result.overflow) throw fixedError("image-identify-failed");
  const match = result.stdout.trim().match(/^([A-Za-z0-9_-]+)\s+(\d+)\s+(\d+)$/);
  if (!match) throw fixedError("invalid-image-metadata");
  const width = Number(match[2]); const height = Number(match[3]);
  if (width < 1 || height < 1 || width * height > 100_000_000) throw fixedError("image-pixel-limit");
  return { mediaType: `image/${match[1].toLowerCase()}`, width, height };
}
async function compareImages(binary, actualFile, baselineFile, cwd, thresholds) {
  const actualInfo = await identifyImage(binary, actualFile, cwd);
  const baselineInfo = await identifyImage(binary, baselineFile, cwd);
  if (actualInfo.width !== baselineInfo.width || actualInfo.height !== baselineInfo.height) return { ok: false, changedPixels: actualInfo.width * actualInfo.height, changedPixelRatio: 1, dimensionsMatch: false, actualInfo, baselineInfo };
  const result = await runBounded(binary, ["compare", "-limit", "memory", "256MiB", "-limit", "map", "512MiB", "-limit", "disk", "1GiB", "-metric", "AE", "-fuzz", `${thresholds.fuzzPercent}%`, actualFile, baselineFile, "null:"], { cwd, timeoutMs: 30_000 });
  if (result.timedOut || result.overflow || ![0, 1].includes(result.code)) throw fixedError("image-compare-failed");
  const metric = `${result.stderr}\n${result.stdout}`.match(/(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/);
  if (!metric) throw fixedError("invalid-image-comparison-metric");
  const changedPixels = Number(metric[1]);
  const changedPixelRatio = changedPixels / (actualInfo.width * actualInfo.height);
  return { ok: changedPixelRatio <= thresholds.maxChangedPixelRatio, changedPixels, changedPixelRatio, dimensionsMatch: true, actualInfo, baselineInfo };
}

function graphvizSafe(dot) {
  const text = String(dot || "");
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES || GRAPH_EXTERNAL_REFERENCE.test(text) || GRAPH_ABSOLUTE_REFERENCE.test(text)) throw fixedError("unsafe-graphviz-source");
  return text;
}

async function actualForCase(cwd, caseSpec, request, tmpRoot, readiness) {
  const supplied = (request.actualRefs || []).find((item) => item?.caseId === caseSpec.caseId)?.artifactRef;
  if (supplied) {
    if (caseSpec.kind !== "image") throw fixedError("unexpected-actual-artifact");
    const resolved = resolveEvidenceArtifact(cwd, supplied);
    if (!resolved) throw fixedError("artifact-ref-unresolved");
    const imageBinary = executableOnPath(request.env?.PI_VISUAL_IMAGEMAGICK_BIN || process.env.PI_VISUAL_IMAGEMAGICK_BIN || "magick", request.env || process.env);
    const imageInfo = await identifyImage(imageBinary, resolved.file, cwd);
    return { file: resolved.file, artifactRef: supplied, mediaType: imageInfo.mediaType, width: imageInfo.width, height: imageInfo.height };
  }
  if (caseSpec.kind === "tui-frame") {
    const captured = await captureModule(cwd, caseSpec, tmpRoot);
    return { frame: canonicalFrame(captured.lines, Number(caseSpec.capture?.input?.width || captured.width)), artifactRef: null };
  }
  if (caseSpec.kind === "image") throw fixedError("actual-artifact-required");
  if (caseSpec.kind === "graphviz") {
    const captured = await captureModule(cwd, caseSpec, tmpRoot);
    const dotFile = path.join(tmpRoot, "graph.dot"); const pngFile = path.join(tmpRoot, "actual.png");
    fs.writeFileSync(dotFile, graphvizSafe(captured.dot), { mode: 0o600 });
    const binary = executableOnPath(request.env?.PI_VISUAL_GRAPHVIZ_BIN || process.env.PI_VISUAL_GRAPHVIZ_BIN || "dot", request.env || process.env);
    const rendered = await runBounded(binary, ["-Tpng", "-o", pngFile, dotFile], { cwd: tmpRoot, timeoutMs: caseSpec.timeoutMs || 30_000 });
    if (rendered.code !== 0 || rendered.timedOut || rendered.overflow) throw fixedError("graphviz-render-failed");
    const imageBinary = executableOnPath(request.env?.PI_VISUAL_IMAGEMAGICK_BIN || process.env.PI_VISUAL_IMAGEMAGICK_BIN || "magick", request.env || process.env);
    const imageInfo = await identifyImage(imageBinary, pngFile, cwd);
    return { file: pngFile, artifactRef: null, mediaType: imageInfo.mediaType, width: imageInfo.width, height: imageInfo.height };
  }
  if (caseSpec.kind === "external-manifest") {
    const command = executableOnPath(String(caseSpec.capture?.command || ""), request.env || process.env);
    if (!command) throw fixedError("configured-command-unavailable");
    const outputManifest = path.join(tmpRoot, "external-manifest.json");
    const requestFile = path.join(tmpRoot, "external-request.json");
    fs.writeFileSync(requestFile, JSON.stringify({ schemaVersion: 1, caseId: caseSpec.caseId, input: caseSpec.capture?.input || {} }), { mode: 0o600 });
    const env = { ...(request.env || process.env), PI_VISUAL_REQUEST_FILE: requestFile, PI_VISUAL_OUTPUT_MANIFEST: outputManifest, PI_VISUAL_OUTPUT_DIR: tmpRoot };
    const result = await runBounded(command, Array.isArray(caseSpec.capture?.args) ? caseSpec.capture.args.map(String) : [], { cwd, env, timeoutMs: caseSpec.timeoutMs || 30_000 });
    if (result.code !== 0 || result.timedOut || result.overflow) throw fixedError("external-capture-failed");
    const manifest = readJson(outputManifest, null, MAX_CONFIG_BYTES);
    const manifestKeys = Object.keys(manifest || {});
    if (manifest?.schemaVersion !== 1 || manifestKeys.some((key) => !["schemaVersion", "status", "artifacts", "observations"].includes(key)) || (manifest.status && manifest.status !== "captured") || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 1) throw fixedError("invalid-external-manifest");
    const artifact = manifest.artifacts[0];
    if (!artifact || Object.keys(artifact).some((key) => !["role", "file", "mediaType", "artifactRef"].includes(key)) || artifact.role !== "actual" || typeof artifact.file !== "string") throw fixedError("invalid-external-manifest");
    const observations = {};
    for (const [key, value] of Object.entries(manifest.observations || {})) {
      if (Object.keys(observations).length >= 32 || !SAFE_ID.test(key) || !(typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) throw fixedError("invalid-external-observations");
      observations[key] = value;
    }
    const file = path.resolve(tmpRoot, artifact.file);
    if (!isInside(tmpRoot, file)) throw fixedError("external-artifact-outside-output");
    confinedProjectFile(tmpRoot, path.relative(tmpRoot, file));
    const imageBinary = executableOnPath(request.env?.PI_VISUAL_IMAGEMAGICK_BIN || process.env.PI_VISUAL_IMAGEMAGICK_BIN || "magick", request.env || process.env);
    const imageInfo = await identifyImage(imageBinary, file, cwd);
    return { file, artifactRef: SAFE_ID.test(String(artifact.artifactRef || "")) ? artifact.artifactRef : null, mediaType: imageInfo.mediaType, width: imageInfo.width, height: imageInfo.height, observations };
  }
  throw fixedError(readiness.reasonCode || "provider-unavailable");
}

function resolveBaselineFile(cwd, entry) {
  if (!entry?.artifact?.relativeRef) throw fixedError("baseline-artifact-missing");
  const file = confinedProjectFile(cwd, String(entry.artifact.relativeRef));
  const metadata = metadataArtifact(file, entry.artifact.mediaType || "application/octet-stream");
  if (entry.artifact.digest && metadata.digest !== entry.artifact.digest) throw fixedError("baseline-digest-mismatch");
  return { file, metadata };
}

function governedInputFingerprint(cwd, config, manifest, cases) {
  const rows = [];
  const projectFile = path.join(cwd, ".pi", "project.json");
  rows.push({ role: "config", digest: boundedFileDigest(projectFile) });
  rows.push({ role: "manifest", digest: config.baselineManifest ? boundedFileDigest(config.baselineManifest) : null });
  for (const caseSpec of cases) rows.push({ role: "source", caseId: caseSpec.caseId, digest: sourceFingerprint(cwd, caseSpec.sources) });
  for (const entry of manifest.entries || []) {
    if (!cases.some((caseSpec) => caseSpec.caseId === entry?.caseId) || !entry?.artifact?.relativeRef) continue;
    let digest = null;
    try { digest = metadataArtifact(confinedProjectFile(cwd, String(entry.artifact.relativeRef)), entry.artifact.mediaType).digest; } catch { digest = "unavailable"; }
    rows.push({ role: "baseline", caseId: safeId(entry.caseId), baselineId: safeId(entry.baselineId), digest });
  }
  return sha(rows);
}

function publicResult(result) { assertVisualMetadataOnly(result); return result; }
function assertVisualMetadataOnly(value, at = "visual") {
  if (value == null || typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value === "string") {
    if (value.length > 512 || ABSOLUTE_PATH_VALUE.test(value)) throw fixedError("unsafe-visual-metadata");
    return true;
  }
  if (Array.isArray(value)) { if (value.length > 200) throw fixedError("visual-metadata-too-large"); value.forEach((item, index) => assertVisualMetadataOnly(item, `${at}[${index}]`)); return true; }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_METADATA_KEY.test(key)) throw fixedError("forbidden-visual-metadata-key");
      assertVisualMetadataOnly(child, `${at}.${key}`);
    }
    return true;
  }
  throw fixedError("invalid-visual-metadata");
}

async function runVisualCase(cwd, config, manifest, caseSpec, request = {}) {
  const readiness = providerReadinessForCase(cwd, caseSpec, request.env || process.env);
  const source = sourceFingerprint(cwd, caseSpec.sources);
  const capture = configHash(caseSpec);
  const identity = { sourceFingerprint: source, captureConfigHash: capture, providerId: readiness.providerId, providerVersion: readiness.version || null };
  const baseline = baselineEntryFor(manifest, caseSpec);
  const freshness = manifest.schemaVersion === VISUAL_SCHEMA_VERSION ? baselineFreshness(baseline, identity) : { ok: false, reasonCode: "invalid-baseline-manifest" };
  const base = { schemaVersion: 1, caseId: caseSpec.caseId, kind: caseSpec.kind, baselineId: caseSpec.baselineId, provider: { providerId: readiness.providerId, adapterVersion: PROVIDER_ADAPTER_VERSION, runtimeVersion: readiness.version || null }, identity, thresholds: boundedThresholds(caseSpec), artifacts: [] };
  if (!readiness.ready) return publicResult({ ...base, ok: null, status: "provider-unavailable", reasonCode: readiness.reasonCode });
  if (!freshness.ok) return publicResult({ ...base, ok: false, status: "stale-baseline", reasonCode: freshness.reasonCode });
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-visual-"));
  try {
    fs.chmodSync(tmpRoot, 0o700);
    const actual = await actualForCase(cwd, caseSpec, request, tmpRoot, readiness);
    if (caseSpec.kind === "tui-frame") {
      const expected = Array.isArray(baseline.lineDigests) ? baseline.lineDigests : [];
      const height = Math.max(actual.frame.lineDigests.length, expected.length);
      let changedLines = 0;
      for (let index = 0; index < height; index++) if (actual.frame.lineDigests[index] !== expected[index]) changedLines++;
      const ok = actual.frame.width === baseline.width && actual.frame.height === baseline.height && changedLines <= base.thresholds.maxChangedLines;
      return publicResult({ ...base, ok, status: ok ? "pass" : "mismatch", reasonCode: ok ? "within-threshold" : "frame-mismatch", actual: { artifactRef: null, digest: actual.frame.digest, mediaType: "application/vnd.pi.tui-frame-hashes+json", bytes: 0, width: actual.frame.width, height: actual.frame.height }, baseline: { digest: baseline.frameDigest || null, width: baseline.width || null, height: baseline.height || null }, metrics: { changedLines, changedLineRatio: height ? changedLines / height : 0 } });
    }
    const baselineResolved = resolveBaselineFile(cwd, baseline);
    const actualMeta = metadataArtifact(actual.file, actual.mediaType || "application/octet-stream", actual.artifactRef);
    const imageBinary = executableOnPath(request.env?.PI_VISUAL_IMAGEMAGICK_BIN || process.env.PI_VISUAL_IMAGEMAGICK_BIN || "magick", request.env || process.env);
    const compared = await compareImages(imageBinary, actual.file, baselineResolved.file, cwd, base.thresholds);
    actualMeta.mediaType = compared.actualInfo.mediaType; actualMeta.width = compared.actualInfo.width; actualMeta.height = compared.actualInfo.height;
    baselineResolved.metadata.mediaType = compared.baselineInfo.mediaType; baselineResolved.metadata.width = compared.baselineInfo.width; baselineResolved.metadata.height = compared.baselineInfo.height;
    return publicResult({ ...base, ok: compared.ok, status: compared.ok ? "pass" : "mismatch", reasonCode: compared.ok ? "within-threshold" : "pixel-mismatch", actual: actualMeta, baseline: baselineResolved.metadata, metrics: { changedPixels: compared.changedPixels, changedPixelRatio: compared.changedPixelRatio, dimensionsMatch: compared.dimensionsMatch, ...(actual.observations ? { observations: actual.observations } : {}) } });
  } catch (error) {
    return publicResult({ ...base, ok: false, status: "infrastructure-failed", reasonCode: safeId(error?.code || "visual-provider-failed", "error") });
  } finally { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
}

async function runVisualVerification(request = {}) {
  cleanupEphemeralVisualArtifacts({ apply: true });
  const cwd = path.resolve(request.cwd || process.cwd());
  const config = loadVisualConfig(cwd);
  const manifest = loadBaselineManifest(config);
  const beforeManifestDigest = config.baselineManifest ? boundedFileDigest(config.baselineManifest) : null;
  const cases = selectedCases(config, request);
  if (config.issues.length) return publicResult({ schemaVersion: 1, ok: false, status: "configuration-invalid", applicable: config.configured, resultCount: 0, unavailableCount: 0, failureCount: 0, issues: config.issues, results: [] });
  const beforeGovernedInputs = governedInputFingerprint(cwd, config, manifest, cases);
  const results = [];
  for (const caseSpec of cases) results.push(await runVisualCase(cwd, config, manifest, caseSpec, request));
  const afterManifestDigest = config.baselineManifest ? boundedFileDigest(config.baselineManifest) : null;
  let afterGovernedInputs = null;
  try { afterGovernedInputs = governedInputFingerprint(cwd, config, manifest, cases); } catch {}
  if (beforeManifestDigest !== afterManifestDigest || beforeGovernedInputs !== afterGovernedInputs) return { schemaVersion: 1, ok: false, status: "governed-input-mutated-during-verification", applicable: cases.length > 0, results: [], baselineManifestDigest: afterManifestDigest };
  const unavailable = results.filter((result) => result.ok == null).length;
  const failures = results.filter((result) => result.ok === false).length;
  return publicResult({ schemaVersion: 1, ok: cases.length ? failures === 0 && unavailable === 0 : null, status: !cases.length ? "not-applicable" : failures ? "fail" : unavailable ? "degraded" : "pass", applicable: cases.length > 0, resultCount: results.length, unavailableCount: unavailable, failureCount: failures, baselineManifestDigest: afterManifestDigest, results });
}

class VisualVerificationAdapter {
  constructor({ enabled = true, cwd = process.cwd(), env = process.env } = {}) { this.enabled = enabled !== false; this.cwd = path.resolve(cwd); this.env = env; }
  readiness(request = {}) { return this.enabled ? planVisualVerification({ ...request, cwd: request.cwd || this.cwd, env: request.env || this.env }) : { schemaVersion: 1, enabled: false, applicable: false, ready: false, status: "disabled", cases: [] }; }
  plan(request = {}) { return this.readiness(request); }
  run(request = {}) { return this.enabled ? runVisualVerification({ ...request, cwd: request.cwd || this.cwd, env: request.env || this.env }) : Promise.resolve({ schemaVersion: 1, enabled: false, ok: null, status: "disabled", applicable: false, results: [] }); }
  resolveArtifact(artifactRef, options = {}) { return this.enabled ? resolveEvidenceArtifact(this.cwd, artifactRef, options) : null; }
}

module.exports = {
  VISUAL_SCHEMA_VERSION,
  PROVIDER_ADAPTER_VERSION,
  VisualVerificationAdapter,
  loadVisualConfig,
  loadBaselineManifest,
  planVisualVerification,
  runVisualVerification,
  canonicalFrame,
  sourceFingerprint,
  configHash,
  assertVisualMetadataOnly,
  providerReadinessForCase,
  selectedCases,
  cleanupEphemeralVisualArtifacts,
  sha,
  // Baseline administration is implemented in a separate command-only module.
  _baselineInternals: { captureModule, actualForCase, metadataArtifact, confinedProjectFile, boundedThresholds, graphvizSafe },
};
