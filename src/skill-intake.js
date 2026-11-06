"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { scanMemoryContent } = require("./memory-content-scanner");

const SKILL_INTAKE_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 64 * 1024;
const HARD_MAX_FILES = 256;
const HARD_MAX_BYTES = 2 * 1024 * 1024;
const HARD_MAX_DIRECTORY_ENTRIES = 2048;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IMMUTABLE_REVISION = /^(?:[a-f0-9]{40,64}|sha256:[a-f0-9]{64})$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SUPPORTED_LICENSES = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC-BY-4.0"]);
const SUPPORTED_FILE_TYPES = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".js", ".cjs", ".mjs", ".ts", ".py", ".sh"]);
const HANDLER_IDS = Object.freeze({
  manifestValidate: "skill-intake.manifest-validate",
  deterministicFilter: "skill-intake.deterministic-filter",
  objectiveScore: "skill-intake.objective-score",
  securityCheck: "skill-intake.security-check",
  privacyCheck: "skill-intake.privacy-check",
  licenseCheck: "skill-intake.license-check",
  candidateFinalize: "skill-intake.candidate-finalize",
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function stableStringify(value) { return JSON.stringify(stable(value)); }
function sha256(value) { return `sha256:${crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : typeof value === "string" ? value : stableStringify(value)).digest("hex")}`; }
function nowIso() { return new Date().toISOString(); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function isWithin(target, base) { const relative = path.relative(base, target); return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative)); }
function intakeError(code, message, details = {}) { const error = new Error(message); error.code = code; error.details = details; return error; }
function exactKeys(value, allowed, required, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw intakeError("SKILL_INTAKE_MANIFEST_INVALID", `${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw intakeError("SKILL_INTAKE_MANIFEST_INVALID", `${label}.${key} is not allowed`);
  for (const key of required) if (!(key in value)) throw intakeError("SKILL_INTAKE_MANIFEST_INVALID", `${label}.${key} is required`);
}
function safeRelative(value, label = "path") {
  const text = String(value || "").trim().replace(/\\/g, "/");
  if (!text || text.length > 500 || text.startsWith("/") || /^[A-Za-z]:\//.test(text) || text.split("/").some((part) => !part || part === "." || part === "..")) throw intakeError("SKILL_INTAKE_PATH_DENIED", `${label} must be a bounded relative path`);
  return text;
}
function lstat(file) { try { return fs.lstatSync(file); } catch (error) { throw intakeError("SKILL_INTAKE_SOURCE_MISSING", `staged source path is missing: ${path.basename(file)}`, { cause: error?.code }); } }
function assertNoSymlinkPath(base, target) {
  const relative = path.relative(base, target);
  if (!isWithin(target, base)) throw intakeError("SKILL_INTAKE_PATH_DENIED", "source path escapes the staged intake root");
  let current = base;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstat(current);
    if (stat.isSymbolicLink()) throw intakeError("SKILL_INTAKE_SYMLINK_DENIED", `symlink is forbidden in staged source: ${path.relative(base, current)}`);
  }
}
function assertNoSymlinkAncestors(base, target) {
  if (!isWithin(target, base)) throw intakeError("SKILL_INTAKE_PATH_DENIED", "private candidate path escapes the project root");
  let current = base;
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) throw intakeError("SKILL_INTAKE_SYMLINK_DENIED", `symlink is forbidden in private candidate path: ${path.relative(base, current)}`);
  }
}
function makeFinding(category, severity, code, summary, locator, evidenceRefs = []) {
  return { id: `finding_${sha256({ category, severity, code, locator, summary }).slice(7, 23)}`, category, severity, code, summary: String(summary).slice(0, 1000), ...(locator ? { locator: String(locator).slice(0, 500) } : {}), evidenceRefs: [...new Set(evidenceRefs)].slice(0, 16) };
}
function evidenceForFile(file) { return { id: `source_${file.sha256.slice(7, 23)}`, kind: "staged-source-file", source: file.relativePath, locator: file.relativePath, observation: `Pinned file; ${file.size} bytes; ${file.sha256}` }; }
function typedPayload(summary, evidence, field, value, findings = []) { return { schemaVersion: 2, contractVersion: "role-v2", summary: String(summary).slice(0, 1000), evidence: clone(evidence || []).slice(0, 64), findings: clone(findings || []).slice(0, 32), [field]: clone(value) }; }
function stageResult(summary, payload) { return { status: "succeeded", summary, content: summary, payload }; }
function resultField(result, field) {
  for (const candidate of [result?.[field], result?.payload?.[field], result?.payload?.payload?.[field], result?.payload?.result?.[field], result?.payload?.submitted_result?.[field], result?.payload?.submittedResult?.[field]]) if (candidate !== undefined) return candidate;
  return undefined;
}
function dependencyField(context, field) { return (context?.dependencyResults || []).map((result) => resultField(result, field)).find((value) => value !== undefined); }
function allDependencyFields(context, field) { return (context?.dependencyResults || []).flatMap((result) => { const value = resultField(result, field); return value === undefined ? [] : [value]; }); }

function collectFiles(root, requestedPaths, options = {}) {
  const maxFiles = Math.min(HARD_MAX_FILES, Math.max(1, Number(options.maxFiles || HARD_MAX_FILES)));
  const maxBytes = Math.min(HARD_MAX_BYTES, Math.max(1, Number(options.maxBytes || HARD_MAX_BYTES)));
  const declaredTypes = new Set((options.fileTypes || []).map((value) => String(value).toLowerCase()));
  const files = new Map();
  let visited = 0;
  function visit(absolute, relative) {
    visited += 1;
    if (visited > HARD_MAX_DIRECTORY_ENTRIES) throw intakeError("SKILL_INTAKE_DIRECTORY_LIMIT", `staged source exceeds ${HARD_MAX_DIRECTORY_ENTRIES} entries`);
    const stat = lstat(absolute);
    if (stat.isSymbolicLink()) throw intakeError("SKILL_INTAKE_SYMLINK_DENIED", `symlink is forbidden in staged source: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) visit(path.join(absolute, entry.name), `${relative}/${entry.name}`.replace(/^\.\//, ""));
      return;
    }
    if (!stat.isFile()) throw intakeError("SKILL_INTAKE_FILE_TYPE_DENIED", `unsupported filesystem entry: ${relative}`);
    const extension = path.extname(relative).toLowerCase();
    const licenseLike = /^(?:license|licence|copying|notice)(?:[-_.].*)?$/i.test(path.basename(relative));
    if ((!SUPPORTED_FILE_TYPES.has(extension) && !licenseLike) || (declaredTypes.size && !declaredTypes.has(extension) && !licenseLike)) throw intakeError("SKILL_INTAKE_FILE_TYPE_DENIED", `unsupported staged file type ${extension || "none"}: ${relative}`);
    if (stat.size > maxBytes) throw intakeError("SKILL_INTAKE_BYTE_LIMIT", `single staged file exceeds declared byte limit: ${relative}`);
    files.set(relative, { absolute, relativePath: relative, size: stat.size, extension });
    if (files.size > maxFiles) throw intakeError("SKILL_INTAKE_FILE_LIMIT", `staged source exceeds declared maxFiles ${maxFiles}`);
    const total = [...files.values()].reduce((sum, file) => sum + file.size, 0);
    if (total > maxBytes) throw intakeError("SKILL_INTAKE_BYTE_LIMIT", `staged source exceeds declared maxBytes ${maxBytes}`);
  }
  for (const requested of requestedPaths) {
    const relative = safeRelative(requested, "requestedPaths item");
    const absolute = path.resolve(root, relative);
    if (!isWithin(absolute, root)) throw intakeError("SKILL_INTAKE_PATH_DENIED", `requested path escapes source root: ${relative}`);
    assertNoSymlinkPath(root, absolute);
    visit(absolute, relative);
  }
  return [...files.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function computeSourceHashes(root, requestedPaths, options = {}) {
  const files = collectFiles(root, requestedPaths, options);
  const contentHasher = crypto.createHash("sha256");
  const records = files.map((file) => {
    const bytes = fs.readFileSync(file.absolute);
    if (bytes.includes(0)) throw intakeError("SKILL_INTAKE_BINARY_DENIED", `binary/NUL content is forbidden: ${file.relativePath}`);
    const digest = sha256(bytes);
    contentHasher.update(file.relativePath); contentHasher.update("\0"); contentHasher.update(bytes); contentHasher.update("\0");
    return { relativePath: file.relativePath, size: file.size, extension: file.extension, sha256: digest };
  });
  return { files: records, treeHash: sha256(records.map(({ relativePath, size, sha256: digest }) => ({ relativePath, size, sha256: digest }))), contentHash: `sha256:${contentHasher.digest("hex")}`, totalBytes: records.reduce((sum, file) => sum + file.size, 0) };
}

function inspectSourceContent(root, snapshot) {
  const findings = [];
  const suspicious = [
    [/ignore\s+(?:all\s+)?previous\s+instructions?/i, "prompt-injection", "Instruction attempts to override prior policy."],
    [/\b(?:system\s+prompt|developer\s+message|hidden\s+reasoning|chain[- ]of[- ]thought)\b/i, "private-context-request", "Instruction requests private controller or reasoning context."],
    [/\b(?:exfiltrate|steal|upload)\b[^\n]{0,100}\b(?:secret|token|credential|key|history)\b/i, "exfiltration", "Instruction requests sensitive-data exfiltration."],
    [/\b(?:sudo|rm\s+-rf|curl|wget|git\s+push|npm\s+publish|twine\s+upload|pip\s+install|npm\s+install|pnpm\s+add|yarn\s+add)\b/i, "unsafe-command", "Source contains an unsafe install/network/publish/destructive instruction."],
    [/\b(?:auto[- ]?approve|bypass\s+(?:review|safety|policy)|disable\s+(?:security|sandbox))\b/i, "authority-bypass", "Instruction attempts to bypass review or approval authority."],
  ];
  const dependencyFiles = new Set(["package.json", "requirements.txt", "pyproject.toml", "pom.xml", "build.gradle", "go.mod", "cargo.toml"]);
  const lockNames = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "cargo.lock", "go.sum"]);
  const names = new Set(snapshot.files.map((file) => path.basename(file.relativePath).toLowerCase()));
  for (const file of snapshot.files) {
    const absolute = path.join(root, file.relativePath);
    const bytes = fs.readFileSync(absolute);
    if (sha256(bytes) !== file.sha256) throw intakeError("SKILL_INTAKE_HASH_DRIFT", `source changed after validation: ${file.relativePath}`);
    const text = bytes.toString("utf8");
    const evidenceId = `source_${file.sha256.slice(7, 23)}`;
    for (const [pattern, code, summary] of suspicious) if (pattern.test(text)) findings.push(makeFinding("instruction", "high", code, summary, file.relativePath, [evidenceId]));
    const lowerName = path.basename(file.relativePath).toLowerCase();
    if (lowerName === "package.json") {
      let pkg;
      try { pkg = JSON.parse(text); } catch { findings.push(makeFinding("dependency", "high", "invalid-package-manifest", "package.json is not valid JSON.", file.relativePath, [evidenceId])); continue; }
      const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}), ...(pkg.peerDependencies || {}) };
      const risky = Object.entries(dependencies).filter(([, version]) => /^(?:\*|latest|https?:|git\+|github:|file:|link:)/i.test(String(version)) || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(String(version)));
      if (risky.length) findings.push(makeFinding("supply-chain", "high", "unresolved-package-dependency", `${risky.length} dependency declaration(s) are remote, local, wildcard, tagged, or not exact-version pinned.`, file.relativePath, [evidenceId]));
      const lifecycle = Object.keys(pkg.scripts || {}).filter((name) => /^(?:pre|post)?install$|^prepare$|^prepublish/i.test(name));
      if (lifecycle.length) findings.push(makeFinding("supply-chain", "high", "package-lifecycle-script", "Package manifest contains install/publish lifecycle scripts.", file.relativePath, [evidenceId]));
      if (Object.keys(dependencies).length && ![...lockNames].some((name) => names.has(name))) findings.push(makeFinding("dependency", "high", "dependency-lock-missing", "Dependency manifest has no staged lockfile.", file.relativePath, [evidenceId]));
    } else if (lowerName === "requirements.txt") {
      const requirements = text.split(/\n+/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
      if (requirements.some((line) => /https?:|git\+|\s@\s|^-e\s|^[^=<>!~]+(?:$|[~><!]=?)/i.test(line) && !/^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+(?:\s+#.*)?$/.test(line))) findings.push(makeFinding("supply-chain", "high", "unresolved-python-dependency", "Python dependency declaration is remote, editable, or not exact-version pinned.", file.relativePath, [evidenceId]));
    } else if (dependencyFiles.has(lowerName)) {
      findings.push(makeFinding("dependency", "medium", "dependency-manifest-review", "Dependency-bearing source requires independent supply-chain review.", file.relativePath, [evidenceId]));
    }
  }
  return findings;
}

function scanSourceBodyCopy(root, snapshot, candidate) {
  const candidateStrings = [];
  const collect = (value) => { if (typeof value === "string") candidateStrings.push(value.replace(/\r\n/g, "\n")); else if (Array.isArray(value)) value.forEach(collect); else if (value && typeof value === "object") Object.values(value).forEach(collect); };
  collect(candidate);
  const serialized = candidateStrings.join("\n");
  const findings = [];
  for (const file of snapshot.files || []) {
    const text = fs.readFileSync(path.join(root, file.relativePath), "utf8").replace(/\r\n/g, "\n").trim();
    if (text.length < 240) continue;
    const windows = text.length <= 1200 ? [text] : [text.slice(0, 600), text.slice(Math.max(0, Math.floor(text.length / 2) - 300), Math.floor(text.length / 2) + 300), text.slice(-600)];
    if (windows.some((window) => window.length >= 240 && serialized.includes(window))) findings.push(makeFinding("privacy", "high", "raw-source-body-copy", "Candidate contains a large verbatim staged-source segment.", file.relativePath, [`source_${file.sha256.slice(7, 23)}`]));
  }
  return findings;
}

function scanPrivateOrUnsafeCandidate(value, at = "candidate", findings = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => scanPrivateOrUnsafeCandidate(item, `${at}[${index}]`, findings)); return findings; }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (/prompt|transcript|reasoning|commandarguments|rawoutput|tooloutput|stdout|stderr|apikey|password|secret|token|^(?:command|cmd|args|argv|arguments)$/i.test(key)) findings.push(makeFinding("privacy", "high", "forbidden-candidate-field", `Candidate contains forbidden private, raw-output, secret, or command-bearing field ${key}.`, at));
      scanPrivateOrUnsafeCandidate(child, `${at}.${key}`, findings);
    }
    return findings;
  }
  if (typeof value === "string") {
    const safety = scanMemoryContent(value, { maxChars: 20_000 });
    for (const reason of safety.blockingReasons) findings.push(makeFinding(reason === "absolute-local-path" || reason === "transcript-payload" ? "privacy" : "security", "high", reason, `Candidate failed shared durable-memory safety rule ${reason}.`, at));
    if (/\b(?:git\s+push|npm\s+publish|twine\s+upload|curl|wget|sudo|rm\s+-rf|pip\s+install|npm\s+install)\b/i.test(value)) findings.push(makeFinding("security", "high", "unsafe-candidate-action", "Candidate proposes a publish, network, install, privileged, or destructive action.", at));
  }
  return findings;
}

class SkillIntakeAdapter {
  constructor({ enabled = true, cwd = process.cwd(), root, skills, maxFiles = HARD_MAX_FILES, maxBytes = HARD_MAX_BYTES } = {}) {
    this.enabled = enabled !== false;
    this.cwd = path.resolve(cwd);
    this.root = path.resolve(root || path.join(this.cwd, ".pi", "skill-intake"));
    if (!isWithin(this.root, this.cwd)) throw intakeError("SKILL_INTAKE_ROOT_DENIED", "skill intake root must stay inside the current project");
    this.sourcesRoot = path.join(this.root, "sources");
    this.candidatesRoot = path.join(this.root, "candidates");
    this.indexFile = path.join(this.root, "candidates.jsonl");
    this.skills = skills || null;
    this.maxFiles = Math.min(HARD_MAX_FILES, Math.max(1, Number(maxFiles || HARD_MAX_FILES)));
    this.maxBytes = Math.min(HARD_MAX_BYTES, Math.max(1, Number(maxBytes || HARD_MAX_BYTES)));
  }
  assertEnabled() { if (!this.enabled) throw intakeError("SKILL_INTAKE_DISABLED", "governed skill intake is disabled"); }
  sourceRoot(sourceId) {
    this.assertEnabled();
    const id = String(sourceId || "").trim();
    if (!SAFE_ID.test(id)) throw intakeError("SKILL_INTAKE_SOURCE_ID_INVALID", "sourceId must be a safe bounded identifier");
    if (!fs.existsSync(this.sourcesRoot)) throw intakeError("SKILL_INTAKE_SOURCE_MISSING", "staged source root does not exist");
    assertNoSymlinkPath(this.cwd, this.sourcesRoot);
    const source = path.join(this.sourcesRoot, id);
    assertNoSymlinkPath(this.sourcesRoot, source);
    if (!lstat(source).isDirectory()) throw intakeError("SKILL_INTAKE_SOURCE_MISSING", "staged source must be a directory");
    const realBase = fs.realpathSync(this.sourcesRoot);
    const realSource = fs.realpathSync(source);
    if (!isWithin(realSource, realBase)) throw intakeError("SKILL_INTAKE_PATH_DENIED", "staged source resolves outside sources root");
    return { sourceId: id, root: realSource };
  }
  readManifest(sourceId) {
    const source = this.sourceRoot(sourceId);
    const manifestFile = path.join(source.root, "manifest.json");
    assertNoSymlinkPath(source.root, manifestFile);
    const stat = lstat(manifestFile);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw intakeError("SKILL_INTAKE_MANIFEST_INVALID", "manifest.json is missing or oversized");
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch { throw intakeError("SKILL_INTAKE_MANIFEST_INVALID", "manifest.json is not valid JSON"); }
    exactKeys(manifest, ["schemaVersion", "sourceId", "revision", "treeHash", "contentHash", "license", "requestedPaths", "limits", "fileTypes"], ["schemaVersion", "sourceId", "revision", "treeHash", "contentHash", "license", "requestedPaths", "limits", "fileTypes"], "manifest");
    if (Number(manifest.schemaVersion) !== SKILL_INTAKE_SCHEMA_VERSION) throw intakeError("SKILL_INTAKE_MANIFEST_INVALID", `manifest schemaVersion must be ${SKILL_INTAKE_SCHEMA_VERSION}`);
    if (manifest.sourceId !== source.sourceId) throw intakeError("SKILL_INTAKE_MANIFEST_INVALID", "manifest sourceId does not match staged directory");
    if (!IMMUTABLE_REVISION.test(String(manifest.revision || ""))) throw intakeError("SKILL_INTAKE_REVISION_UNPINNED", "manifest revision must be an immutable 40-64 hex or sha256 pin");
    if (!SHA256.test(String(manifest.treeHash || "")) || !SHA256.test(String(manifest.contentHash || ""))) throw intakeError("SKILL_INTAKE_HASH_INVALID", "manifest treeHash and contentHash must be sha256 values");
    exactKeys(manifest.license, ["spdxId", "path", "hash"], ["spdxId", "path", "hash"], "manifest.license");
    if (!SUPPORTED_LICENSES.has(manifest.license.spdxId)) throw intakeError("SKILL_INTAKE_LICENSE_UNSUPPORTED", `unsupported or unknown license: ${manifest.license.spdxId || "missing"}`);
    if (!SHA256.test(String(manifest.license.hash || ""))) throw intakeError("SKILL_INTAKE_LICENSE_INVALID", "license hash must be sha256");
    exactKeys(manifest.limits, ["maxFiles", "maxBytes"], ["maxFiles", "maxBytes"], "manifest.limits");
    const maxFiles = Number(manifest.limits.maxFiles); const maxBytes = Number(manifest.limits.maxBytes);
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > this.maxFiles) throw intakeError("SKILL_INTAKE_FILE_LIMIT", `manifest maxFiles must be 1-${this.maxFiles}`);
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > this.maxBytes) throw intakeError("SKILL_INTAKE_BYTE_LIMIT", `manifest maxBytes must be 1-${this.maxBytes}`);
    if (!Array.isArray(manifest.requestedPaths) || !manifest.requestedPaths.length || manifest.requestedPaths.length > 64) throw intakeError("SKILL_INTAKE_MANIFEST_INVALID", "requestedPaths must contain 1-64 paths");
    if (!Array.isArray(manifest.fileTypes) || !manifest.fileTypes.length || manifest.fileTypes.length > SUPPORTED_FILE_TYPES.size) throw intakeError("SKILL_INTAKE_MANIFEST_INVALID", "fileTypes must be a bounded nonempty list");
    const fileTypes = [...new Set(manifest.fileTypes.map((type) => String(type).toLowerCase()))];
    for (const type of fileTypes) if (!SUPPORTED_FILE_TYPES.has(type)) throw intakeError("SKILL_INTAKE_FILE_TYPE_DENIED", `unsupported declared file type: ${type}`);
    const licensePath = safeRelative(manifest.license.path, "license.path");
    const requestedPaths = [...new Set([...manifest.requestedPaths.map((item) => safeRelative(item, "requestedPaths item")), licensePath])];
    if (requestedPaths.includes("manifest.json")) throw intakeError("SKILL_INTAKE_MANIFEST_INVALID", "manifest.json cannot be part of its own content hash");
    return { source, manifest: { ...manifest, requestedPaths, fileTypes, license: { ...manifest.license, path: licensePath } } };
  }
  validateSource(sourceId) {
    const { source, manifest } = this.readManifest(sourceId);
    const computed = computeSourceHashes(source.root, manifest.requestedPaths, { maxFiles: manifest.limits.maxFiles, maxBytes: manifest.limits.maxBytes, fileTypes: manifest.fileTypes });
    if (computed.treeHash !== manifest.treeHash || computed.contentHash !== manifest.contentHash) throw intakeError("SKILL_INTAKE_HASH_DRIFT", "staged source does not match manifest tree/content hash", { expectedTreeHash: manifest.treeHash, actualTreeHash: computed.treeHash, expectedContentHash: manifest.contentHash, actualContentHash: computed.contentHash });
    const license = computed.files.find((file) => file.relativePath === manifest.license.path);
    if (!license || license.sha256 !== manifest.license.hash) throw intakeError("SKILL_INTAKE_LICENSE_HASH_DRIFT", "staged license does not match manifest license hash");
    const sourceRecord = { sourceId: source.sourceId, revision: manifest.revision, treeHash: computed.treeHash, contentHash: computed.contentHash, licenseId: manifest.license.spdxId, licenseHash: manifest.license.hash, fileCount: computed.files.length, totalBytes: computed.totalBytes };
    const validationId = `intakeval_${sha256({ source: sourceRecord, files: computed.files }).slice(7, 31)}`;
    return { ok: true, validationId, source: sourceRecord, files: computed.files, evidence: computed.files.map(evidenceForFile), manifest: { requestedPaths: manifest.requestedPaths, fileTypes: manifest.fileTypes, limits: manifest.limits, licensePath: manifest.license.path }, root: source.root };
  }
  deterministicChecks(sourceId) {
    const snapshot = this.validateSource(sourceId);
    const findings = inspectSourceContent(snapshot.root, snapshot);
    const highSeverity = findings.filter((finding) => finding.severity === "high");
    return { ...snapshot, findings, passed: highSeverity.length === 0, highSeverityCount: highSeverity.length };
  }
  manifestHandler(context) {
    const snapshot = this.validateSource(context?.input?.sourceId);
    const value = { passed: true, validationId: snapshot.validationId, source: snapshot.source, files: snapshot.files };
    return stageResult(`Validated pinned staged source ${snapshot.source.sourceId}.`, typedPayload(`Validated pinned staged source ${snapshot.source.sourceId}.`, snapshot.evidence, "manifestValidation", value));
  }
  filterHandler(context) {
    const sourceId = context?.input?.sourceId;
    const manifestValidation = dependencyField(context, "manifestValidation");
    const checked = this.deterministicChecks(sourceId);
    if (!manifestValidation || stableStringify(manifestValidation.source) !== stableStringify(checked.source)) throw intakeError("SKILL_INTAKE_PROVENANCE_MISMATCH", "manifest dependency does not match current staged source");
    if (!checked.passed) throw intakeError("SKILL_INTAKE_FILTER_BLOCKED", `deterministic intake filter found ${checked.highSeverityCount} high-severity issue(s)`, { findings: checked.findings });
    const value = { passed: true, findingCount: checked.findings.length, highSeverityCount: 0, source: checked.source, files: checked.files };
    return stageResult("Deterministic instruction/dependency/supply-chain filters passed.", typedPayload("Deterministic instruction/dependency/supply-chain filters passed.", checked.evidence, "filterResult", value, checked.findings));
  }
  scoreHandler(context) {
    const workflow = dependencyField(context, "workflow");
    if (!workflow || !Array.isArray(workflow.steps)) throw intakeError("SKILL_INTAKE_WORKFLOW_INVALID", "objective scoring requires typed extracted workflow");
    const checked = this.validateSource(context?.input?.sourceId);
    if (stableStringify(workflow.source) !== stableStringify(checked.source)) throw intakeError("SKILL_INTAKE_PROVENANCE_MISMATCH", "workflow source does not match current staged source");
    const dimensions = {
      hasBoundedSteps: workflow.steps.length >= 1 && workflow.steps.length <= 16 ? 1 : 0,
      hasDescription: String(workflow.description || "").length >= 20 ? 1 : 0,
      hasEvidence: Array.isArray(workflow.evidenceRefs) && workflow.evidenceRefs.length > 0 ? 1 : 0,
      boundedTools: Array.isArray(workflow.requiredTools) && workflow.requiredTools.length <= 32 ? 1 : 0,
    };
    const score = Object.values(dimensions).reduce((sum, value) => sum + value, 0) / Object.keys(dimensions).length;
    const value = { passed: score >= 0.75, score, dimensions, rationale: "Deterministic completeness, evidence, and boundedness score.", evidenceRefs: [...new Set(workflow.evidenceRefs || [])].slice(0, 32), source: checked.source };
    if (!value.passed) throw intakeError("SKILL_INTAKE_SCORE_BLOCKED", `objective candidate score ${score.toFixed(2)} is below 0.75`);
    return stageResult(`Objective workflow score passed at ${score.toFixed(2)}.`, typedPayload(`Objective workflow score passed at ${score.toFixed(2)}.`, [], "objectiveScore", value));
  }
  securityHandler(context) {
    const checked = this.deterministicChecks(context?.input?.sourceId);
    const candidate = dependencyField(context, "candidatePackage");
    const findings = [...checked.findings, ...scanPrivateOrUnsafeCandidate(candidate).filter((finding) => finding.category === "security")];
    const high = findings.filter((finding) => finding.severity === "high");
    const decision = { decision: high.length ? "rejected" : "accepted", rationale: high.length ? "High-severity security or supply-chain finding remains." : "Deterministic security and supply-chain checks passed.", evidenceRefs: checked.evidence.map((item) => item.id) };
    return stageResult(decision.rationale, typedPayload(decision.rationale, checked.evidence, "reviewDecision", decision, findings));
  }
  privacyHandler(context) {
    const candidate = dependencyField(context, "candidatePackage");
    const checked = this.validateSource(context?.input?.sourceId);
    const findings = [...scanPrivateOrUnsafeCandidate(candidate).filter((finding) => finding.category === "privacy"), ...scanSourceBodyCopy(checked.root, checked, candidate)];
    const candidateEvidence = { id: `candidate_${sha256(candidate || {}).slice(7, 23)}`, kind: "candidate-package", source: "candidate-package", locator: "privacy-scan", observation: "Deterministic privacy scan over the bounded candidate package." };
    const decision = { decision: findings.some((finding) => finding.severity === "high") ? "rejected" : "accepted", rationale: findings.length ? "Candidate contains forbidden privacy-bearing data." : "Candidate contains no forbidden prompt/transcript/reasoning/secret/path fields.", evidenceRefs: [candidateEvidence.id] };
    return stageResult(decision.rationale, typedPayload(decision.rationale, [candidateEvidence], "reviewDecision", decision, findings));
  }
  licenseHandler(context) {
    const checked = this.validateSource(context?.input?.sourceId);
    const accepted = SUPPORTED_LICENSES.has(checked.source.licenseId);
    const decision = { decision: accepted ? "accepted" : "rejected", rationale: accepted ? `Pinned ${checked.source.licenseId} license hash verified.` : "License is unsupported or unknown.", evidenceRefs: checked.evidence.filter((item) => item.source === checked.manifest.licensePath).map((item) => item.id) };
    return stageResult(decision.rationale, typedPayload(decision.rationale, checked.evidence, "reviewDecision", decision, accepted ? [] : [makeFinding("license", "high", "unsupported-license", decision.rationale, checked.manifest.licensePath)]));
  }
  candidateFile(candidateId) { if (!SAFE_ID.test(String(candidateId || ""))) throw intakeError("SKILL_INTAKE_CANDIDATE_ID_INVALID", "candidateId must be a safe identifier"); return path.join(this.candidatesRoot, `${candidateId}.json`); }
  writeCandidate(packet) {
    assertNoSymlinkAncestors(this.cwd, this.candidatesRoot);
    fs.mkdirSync(this.candidatesRoot, { recursive: true, mode: 0o700 });
    assertNoSymlinkPath(this.cwd, this.candidatesRoot);
    try { fs.chmodSync(this.root, 0o700); fs.chmodSync(this.candidatesRoot, 0o700); } catch {}
    const file = this.candidateFile(packet.candidateId);
    const body = `${JSON.stringify(packet, null, 2)}\n`;
    if (fs.existsSync(this.indexFile) && fs.lstatSync(this.indexFile).isSymbolicLink()) throw intakeError("SKILL_INTAKE_SYMLINK_DENIED", "candidate index cannot be a symlink");
    if (fs.existsSync(file)) {
      if (fs.lstatSync(file).isSymbolicLink()) throw intakeError("SKILL_INTAKE_SYMLINK_DENIED", "candidate file cannot be a symlink");
      const existing = JSON.parse(fs.readFileSync(file, "utf8"));
      if (existing.packetHash !== packet.packetHash) throw intakeError("SKILL_INTAKE_CANDIDATE_COLLISION", "candidate ID collision with different packet hash");
      return { candidateId: packet.candidateId, duplicate: true, relativePath: path.relative(this.cwd, file) };
    }
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    fs.appendFileSync(this.indexFile, `${JSON.stringify({ at: nowIso(), candidateId: packet.candidateId, sourceId: packet.source.sourceId, revision: packet.source.revision, packetHash: packet.packetHash, status: packet.status })}\n`, { mode: 0o600 });
    try { fs.chmodSync(this.indexFile, 0o600); } catch {}
    return { candidateId: packet.candidateId, duplicate: false, relativePath: path.relative(this.cwd, file) };
  }
  finalizeHandler(context, meta = {}) {
    const checked = this.deterministicChecks(context?.input?.sourceId);
    if (!checked.passed) throw intakeError("SKILL_INTAKE_FILTER_BLOCKED", "source failed deterministic revalidation before finalization", { findings: checked.findings });
    const candidatePackage = dependencyField(context, "candidatePackage");
    const audits = allDependencyFields(context, "auditDecision");
    const reviews = allDependencyFields(context, "reviewDecision");
    if (!candidatePackage) throw intakeError("SKILL_INTAKE_CANDIDATE_MISSING", "finalization requires a typed candidate package");
    if (stableStringify(candidatePackage.source) !== stableStringify(checked.source)) throw intakeError("SKILL_INTAKE_PROVENANCE_MISMATCH", "candidate source provenance does not match current staged source");
    if (!audits.length || audits.some((decision) => decision.decision !== "accepted" || decision.coverageComplete !== true || !Array.isArray(decision.evidenceRefs) || !decision.evidenceRefs.length)) throw intakeError("SKILL_INTAKE_AUDIT_BLOCKED", "final audit did not accept complete evidence-backed review coverage");
    if (reviews.length < 4 || reviews.some((decision) => decision.decision !== "accepted" || !Array.isArray(decision.evidenceRefs) || !decision.evidenceRefs.length)) throw intakeError("SKILL_INTAKE_REVIEW_BLOCKED", "independent/security/privacy/license review did not unanimously accept with evidence references");
    const unsafe = [...scanPrivateOrUnsafeCandidate(candidatePackage), ...scanSourceBodyCopy(checked.root, checked, candidatePackage)];
    if (unsafe.some((finding) => finding.severity === "high")) throw intakeError("SKILL_INTAKE_CANDIDATE_UNSAFE", "candidate package failed final privacy/security scan", { findings: unsafe });
    const basePacket = {
      schemaVersion: SKILL_INTAKE_SCHEMA_VERSION,
      status: "candidate",
      source: checked.source,
      candidatePackage: clone(candidatePackage),
      reviews: reviews.map((decision) => clone(decision)),
      audit: clone(audits[0]),
      provenance: { topologyId: context?.topology?.topologyId || "governed-skill-intake", topologyRunId: context?.topology?.runId || meta?.run?.runId || null, validationId: checked.validationId },
      governance: { sourceTrust: "untrusted-until-reviewed", publishCapable: false, routingApproved: false, fieldProven: false },
      privacy: { promptStored: false, transcriptStored: false, privateReasoningStored: false, commandArgumentsStored: false, rawToolOutputStored: false, absolutePathsStored: false },
    };
    const candidateId = `skillcand_${sha256({ source: checked.source, candidatePackage, audit: audits[0], topologyRunId: basePacket.provenance.topologyRunId }).slice(7, 31)}`;
    const packetHash = sha256({ ...basePacket, candidateId });
    const packet = { ...basePacket, candidateId, packetHash };
    const written = this.writeCandidate(packet);
    const value = { candidateId, status: "candidate", source: checked.source, packetHash, relativePath: written.relativePath };
    return stageResult(`Finalized private governed skill candidate ${candidateId}.`, typedPayload(`Finalized private governed skill candidate ${candidateId}.`, checked.evidence, "candidate", value));
  }
  handlerRegistry() {
    return {
      [HANDLER_IDS.manifestValidate]: this.manifestHandler.bind(this),
      [HANDLER_IDS.deterministicFilter]: this.filterHandler.bind(this),
      [HANDLER_IDS.objectiveScore]: this.scoreHandler.bind(this),
      [HANDLER_IDS.securityCheck]: this.securityHandler.bind(this),
      [HANDLER_IDS.privacyCheck]: this.privacyHandler.bind(this),
      [HANDLER_IDS.licenseCheck]: this.licenseHandler.bind(this),
      [HANDLER_IDS.candidateFinalize]: this.finalizeHandler.bind(this),
    };
  }
  inspectCandidate(candidateId) {
    this.assertEnabled();
    const file = this.candidateFile(candidateId);
    assertNoSymlinkAncestors(this.cwd, file);
    if (!fs.existsSync(file)) return null;
    if (fs.lstatSync(file).isSymbolicLink()) throw intakeError("SKILL_INTAKE_SYMLINK_DENIED", "candidate file cannot be a symlink");
    const packet = JSON.parse(fs.readFileSync(file, "utf8"));
    const { packetHash, ...withoutHash } = packet;
    if (packet.candidateId !== candidateId || packetHash !== sha256(withoutHash)) throw intakeError("SKILL_INTAKE_CANDIDATE_TAMPERED", "candidate packet fingerprint mismatch");
    return packet;
  }
  listCandidates({ limit = 50 } = {}) {
    this.assertEnabled();
    let rows = [];
    try { if (fs.lstatSync(this.indexFile).isSymbolicLink()) throw intakeError("SKILL_INTAKE_SYMLINK_DENIED", "candidate index cannot be a symlink"); rows = fs.readFileSync(this.indexFile, "utf8").split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if (error?.code === "SKILL_INTAKE_SYMLINK_DENIED") throw error; }
    return rows.slice(-Math.max(0, Math.min(200, Number(limit || 50))));
  }
  importCandidate(candidateId) {
    const packet = this.inspectCandidate(candidateId);
    if (!packet) throw intakeError("SKILL_INTAKE_CANDIDATE_MISSING", `candidate not found: ${candidateId}`);
    if (!this.skills || typeof this.skills.importPacket !== "function") throw intakeError("SKILL_INTAKE_SKILL_ADAPTER_UNAVAILABLE", "skill synthesis adapter is unavailable");
    const input = packet.candidatePackage;
    const skillId = `skill_intake_${sha256({ source: packet.source, candidatePackage: packet.candidatePackage }).slice(7, 31)}`;
    const existing = this.skills.getSkill?.(skillId);
    if (existing) return { imported: false, duplicate: true, candidateId, skillId, status: existing.status };
    const skill = {
      skillId,
      version: 1,
      status: "candidate",
      name: input.name,
      description: input.description,
      category: input.category,
      triggerConditions: input.triggerConditions,
      workflowSteps: input.workflowSteps,
      requiredTools: input.requiredTools,
      expectedOutputs: input.expectedOutputs,
      validationStrategy: input.validationStrategy,
      confidenceScore: 0.35,
      successMetrics: { attempts: 0, successes: 0, failures: 0, successRate: 0, meanLatencyMs: 0, meanToolCalls: 0 },
      provenance: { sources: ["governed-skill-intake"], sourceHash: packet.source.contentHash, intakeCandidateId: candidateId, sourceId: packet.source.sourceId, revision: packet.source.revision, treeHash: packet.source.treeHash, licenseId: packet.source.licenseId, licenseHash: packet.source.licenseHash },
      governance: { approval: "candidate", minConfidence: 0.65, sandboxRequired: true, unsafe: false },
      evidenceState: { sourceTrust: { status: "untrusted", sourceHash: packet.source.contentHash }, schema: { status: "valid", schemaVersion: 2 }, sandbox: { status: "not-run", evidenceIds: [] }, localVerification: { status: "insufficient-data", captureCount: 0, evidenceIds: [] }, field: { status: "insufficient-data", exactVersionUses: 0, observedDays: 0, evidenceIds: [] } },
      approvals: { advisoryRetrieval: "blocked", routing: "not-approved", publishing: "not-approved" },
    };
    const result = this.skills.importPacket({ version: 2, skills: [skill], captures: [], failurePatterns: [] });
    return { imported: result.skills === 1, duplicate: false, candidateId, skillId, status: "candidate", approvals: skill.approvals };
  }
  status() { return { enabled: this.enabled, schemaVersion: SKILL_INTAKE_SCHEMA_VERSION, sourceMode: "local-staged-pinned-only", sourceRoot: path.relative(this.cwd, this.sourcesRoot), candidateRoot: path.relative(this.cwd, this.candidatesRoot), maxFiles: this.maxFiles, maxBytes: this.maxBytes, supportedLicenses: [...SUPPORTED_LICENSES], supportedFileTypes: [...SUPPORTED_FILE_TYPES], candidateCount: this.enabled ? this.listCandidates({ limit: 200 }).length : 0, publishOperation: false, networkDiscovery: false }; }
}

module.exports = {
  SKILL_INTAKE_SCHEMA_VERSION,
  MAX_MANIFEST_BYTES,
  HARD_MAX_FILES,
  HARD_MAX_BYTES,
  SUPPORTED_LICENSES,
  SUPPORTED_FILE_TYPES,
  HANDLER_IDS,
  stableStringify,
  sha256,
  computeSourceHashes,
  inspectSourceContent,
  scanSourceBodyCopy,
  scanPrivateOrUnsafeCandidate,
  SkillIntakeAdapter,
};
