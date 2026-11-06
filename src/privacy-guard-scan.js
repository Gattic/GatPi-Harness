"use strict";

const { existsSync, statSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { basename, isAbsolute, join, relative, resolve } = require("node:path");
const { sessionPermissionPosture } = require("./session-hygiene");
const stateInventory = require("./state-inventory");
const reviewIndex = new Map();
const SECRET_PATTERNS = Object.freeze([
  { name: "private-key", severity: "high", description: "Private key material", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "openai-key", severity: "high", description: "OpenAI-style API key", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "github-token", severity: "high", description: "GitHub token", re: /gh[pousr]_[A-Za-z0-9_]{20,}/ },
  { name: "api-key-assignment", severity: "high", description: "Likely credential assignment", re: /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-]{16,}/i },
  { name: "full-transcript-hint", severity: "medium", runtimeOnly: true, description: "Runtime state may contain transcript/message payloads", re: /\b(role|assistant|user|tool)\b.{0,120}\b(content|transcript|messages)\b/i },
]);

function lineFor(text, index) { return text.slice(0, Math.max(0, index)).split(/\r?\n/).length; }
function isSourceLike(file) { return /\.(ts|tsx|js|jsx|mjs|cjs|md|test\.js)$/.test(file) || /(^|\/)docs\//.test(file) || /(^|\/)tests\//.test(file) || /(^|\/)\.pi\/extensions\//.test(file); }
function isRuntimeState(file) { return /(^|\/)\.pi\/(cognitive-automation|goal-state|ast-refactor|verification-center|runtime-doctor|memory-explorer|memory-curator|memory-maintenance|project-memory|learning-loop|debug-ledger|experiment-ledger|evidence-binder|fix-recall|run-deck|traces|provenance-graph|execution-outcomes|skill-synthesis|session-stabilizer|privacy-guard|session-branches|extension-telemetry|session-audit|session-mining|roadmap|hermes-advisory|hermes-skill-candidates|obsidian|typesafe)\//.test(file) && !/(^|\/)\.pi\/extensions\//.test(file); }
function isKnownPlaceholder(text, index) {
  const nearby = text.slice(Math.max(0, index - 80), index + 160);
  return /(?:example|placeholder|dummy|redacted|xxxx|your[_-]?token|test[_-]?token|LOCAL_OPENAI_API_KEY)/i.test(nearby);
}
function isDynamicSourceAssignment(file, text, spec, index) {
  if (spec.name !== "api-key-assignment" || !isSourceLike(file)) return false;
  const assignment = text.slice(index, index + 240);
  return /^\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\??\.)*[A-Za-z_$][\w$]*\s*\(/i.test(assignment);
}
function classify(file, text, spec, index) {
  const base = { file, pattern: spec.name, severity: spec.severity, bytes: text.length, line: lineFor(text, index) };
  if (spec.runtimeOnly && isSourceLike(file) && !isRuntimeState(file)) return { ...base, ignored: true, reason: "source/documentation vocabulary, not runtime state" };
  if (spec.runtimeOnly && !isRuntimeState(file)) return { ...base, severity: "low", ignored: true, reason: "outside known runtime memory/state paths" };
  if (isDynamicSourceAssignment(file, text, spec, index)) return { ...base, ignored: true, reason: "dynamic source expression, not a hard-coded credential literal" };
  if (isKnownPlaceholder(text, index)) return { ...base, ignored: true, reason: "known placeholder/example token" };
  return base;
}
function scanText(file, text, specs = SECRET_PATTERNS, includeIgnored = false) {
  const findings = [];
  const ignored = [];
  for (const spec of specs) {
    let offset = 0;
    while (offset < text.length) {
      spec.re.lastIndex = 0;
      const match = spec.re.exec(text.slice(offset));
      spec.re.lastIndex = 0;
      if (!match) break;
      const index = offset + (match.index || 0);
      const item = classify(file, text, spec, index);
      if (item.ignored) ignored.push(item); else findings.push(item);
      if (!includeIgnored && item.ignored) { offset = index + Math.max(1, match[0].length); continue; }
      break;
    }
  }
  return { findings, ignored };
}
function isBranchSnapshotFile(file) { return /(?:^|\/)branches\/snapshots\/|(?:^|\/)session-branches\/snapshots\//.test(file.replace(/\\/g, "/")); }
const PRIVATE_SNAPSHOT_PATH_RE = /"(?:\.env(?:\.[^"]*)?|\.pi(?:\/[^"]*)?)"\s*:/g;
function scanFile(file, includeIgnored = false, deadlineAt = Infinity) {
  const findings = [];
  const ignored = [];
  const decided = new Set();
  const ignoredRecorded = new Set();
  const offsets = new Set();
  const statBytes = (() => { try { return statSync(file).size; } catch { return 0; } })();
  const branchSnapshot = isBranchSnapshotFile(file); let privateSnapshotDetected = false;
  const result = stateInventory.scanTextFile(file, ({ text, startChar, lineAtStart }) => {
    if (branchSnapshot && !privateSnapshotDetected) {
      PRIVATE_SNAPSHOT_PATH_RE.lastIndex = 0; const match = PRIVATE_SNAPSHOT_PATH_RE.exec(text); PRIVATE_SNAPSHOT_PATH_RE.lastIndex = 0;
      if (match) { privateSnapshotDetected = true; findings.push({ file, pattern: "private-snapshot-path", severity: "high", bytes: statBytes, line: lineAtStart + lineFor(text, match.index || 0) }); }
    }
    for (const spec of SECRET_PATTERNS) {
      if (decided.has(spec.name)) continue;
      let offset = 0;
      while (offset < text.length) {
        spec.re.lastIndex = 0;
        const match = spec.re.exec(text.slice(offset));
        spec.re.lastIndex = 0;
        if (!match) break;
        const index = offset + (match.index || 0);
        const absolute = startChar + index;
        const offsetKey = `${spec.name}:${absolute}`;
        offset = index + Math.max(1, match[0].length);
        if (offsets.has(offsetKey)) continue;
        offsets.add(offsetKey);
        const item = classify(file, text, spec, index);
        item.bytes = statBytes;
        item.line = lineAtStart + lineFor(text, index);
        if (item.ignored) {
          if (!ignoredRecorded.has(spec.name)) { ignored.push(item); ignoredRecorded.add(spec.name); }
        } else { findings.push(item); decided.add(spec.name); break; }
      }
    }
  }, { overlapChars: 512, deadlineAt });
  return { findings, ignored, ...result };
}
function defaultRoots(cwd) {
  return [
    join(cwd, ".pi", "cognitive-automation"), join(cwd, ".pi", "goal-state"), join(cwd, ".pi", "ast-refactor"), join(cwd, ".pi", "verification-center"), join(cwd, ".pi", "traces"), join(cwd, ".pi", "learning-loop"), join(cwd, ".pi", "debug-ledger"), join(cwd, ".pi", "experiment-ledger"), join(cwd, ".pi", "typesafe"), join(cwd, ".pi", "project-memory"), join(cwd, ".pi", "memory-curator"), join(cwd, ".pi", "memory-maintenance"), join(cwd, ".pi", "evidence-binder"), join(cwd, ".pi", "fix-recall"), join(cwd, ".pi", "run-deck"), join(cwd, ".pi", "provenance-graph"), join(cwd, ".pi", "execution-outcomes"), join(cwd, ".pi", "skill-synthesis"), join(cwd, ".pi", "runtime-doctor"), join(cwd, ".pi", "memory-explorer"), join(cwd, ".pi", "session-stabilizer"), join(cwd, ".pi", "privacy-guard"), join(cwd, ".pi", "session-branches"), join(cwd, ".pi", "extension-telemetry"), join(cwd, ".pi", "session-audit"), join(cwd, ".pi", "session-mining"), join(cwd, ".pi", "roadmap"), join(cwd, ".pi", "hermes-advisory"), join(cwd, ".pi", "hermes-skill-candidates"), join(cwd, ".pi", "obsidian"),
  ];
}
function scopeLabel(cwd, root) {
  const absolute = resolve(root);
  const project = resolve(cwd);
  const rel = relative(project, absolute).replace(/\\/g, "/");
  if (rel && rel !== ".." && !rel.startsWith("../")) return `project-state:${basename(absolute)}`;
  return "explicit-state-root";
}
function publicFinding(item, cwd) {
  const absolute = resolve(item.file);
  const reviewHandle = `privacy_${createHash("sha256").update(`${absolute}:${item.pattern}:${item.line || 0}`).digest("hex").slice(0, 16)}`;
  reviewIndex.set(reviewHandle, { file: absolute, line: item.line, pattern: item.pattern });
  return { ...item, reviewHandle, file: `${relative(resolve(cwd), absolute).startsWith("..") ? "global" : "project"}-state:${createHash("sha256").update(absolute).digest("hex").slice(0, 12)}` };
}
function isWithin(parent, child) { const rel = relative(resolve(parent), resolve(child)); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); }
function scan(cwd, roots, options = {}) {
  reviewIndex.clear();
  const explicitRoots = Boolean(roots?.length);
  const scanRoots = [...(explicitRoots ? roots : defaultRoots(cwd))];
  if (options.includeSource) scanRoots.push(join(cwd, ".pi", "extensions"));
  const rootStatus = scanRoots.map((root) => ({ scope: scopeLabel(cwd, root), exists: existsSync(root) }));
  const availableRoots = scanRoots.filter((root) => existsSync(root));
  const inventory = stateInventory.inventoryState(availableRoots);
  const stateHash = createHash("sha256");
  for (const file of inventory.files || []) stateHash.update(JSON.stringify({ scope: scopeLabel(cwd, file.root), file: relative(file.root, file.path).replace(/\\/g, "/"), bytes: file.bytes, mode: file.mode, mtimeMs: file.mtimeMs }));
  const stateFingerprint = `sha256:${stateHash.digest("hex")}`;
  const all = [];
  const coverage = stateInventory.scanTextInventory(inventory, (file, api) => {
    const result = scanFile(file.path, Boolean(options.includeIgnored), api.deadlineAt);
    all.push(result);
    return result;
  }, { maxFiles: options.maxFiles, maxBytes: options.maxBytes, deadlineMs: options.deadlineMs });
  const findings = all.flatMap((x) => x.findings || []);
  const ignoredFindings = all.flatMap((x) => x.ignored || []);
  const sessionRoot = resolve(options.sessionRoot || join(process.env.HOME || ".", ".pi", "agent", "sessions"));
  const contentReadFromRawSessions = coverage.scanned.some((row) => isWithin(sessionRoot, row.path));
  const wantsPermissionPosture = Boolean(options.rawSessionPermissions);
  const permissionPosture = wantsPermissionPosture ? sessionPermissionPosture({ root: sessionRoot }) : null;
  if (permissionPosture && !permissionPosture.compliant) findings.push({ file: "global-state:raw-sessions", pattern: "unsafe-session-permissions", severity: "high", bytes: 0, reason: "raw session files/directories are not fully private or the metadata-only scan was incomplete" });
  const publicFindings = findings.slice(0, 200).map((item) => item.file === "global-state:raw-sessions" ? item : publicFinding(item, cwd));
  const publicIgnored = ignoredFindings.slice(0, 200).map((item) => publicFinding(item, cwd));
  const bySeverity = findings.reduce((m, finding) => (m[finding.severity] = (m[finding.severity] || 0) + 1, m), {});
  const renderedTruncated = findings.length > 200 || (options.includeIgnored && ignoredFindings.length > 200);
  const absentRoots = rootStatus.filter((row) => !row.exists).length;
  const scopeComplete = !explicitRoots || absentRoots === 0;
  const coverageSummary = { ...coverage.summary, stateFingerprint, configuredRoots: rootStatus.length, availableRoots: rootStatus.length - absentRoots, absentRoots, scopeComplete, complete: coverage.summary.complete && scopeComplete };
  return {
    ok: findings.length === 0 && coverageSummary.complete,
    scope: { projectState: true, source: Boolean(options.includeSource), rawSessionPermissions: wantsPermissionPosture, contentReadFromRawSessions },
    roots: rootStatus.map((row) => row.scope), rootStatus, permissionPosture, coverage: coverageSummary,
    summary: { actionable: findings.length, ignored: ignoredFindings.length, bySeverity, complete: coverageSummary.complete, discoveredFiles: coverageSummary.discoveredFiles, scannedFiles: coverageSummary.scannedFiles, skippedFiles: coverageSummary.skippedFiles, erroredFiles: coverageSummary.erroredFiles },
    findings: publicFindings.slice(0, 200), ignoredFindings: options.includeIgnored ? publicIgnored.slice(0, 200) : undefined,
    truncated: renderedTruncated || !coverageSummary.complete, resultTruncated: renderedTruncated,
  };
}
function reviewCandidate(handle) { return reviewIndex.get(String(handle || "").trim()) || null; }

module.exports = { SECRET_PATTERNS, lineFor, isSourceLike, isRuntimeState, classify, scanText, scanFile, defaultRoots, scopeLabel, scan, reviewCandidate };
