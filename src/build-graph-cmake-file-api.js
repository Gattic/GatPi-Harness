"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function inside(root, value) { const relative = path.relative(root, value); return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative); }
function repositoryPath(root, value, base = root) { const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value); return inside(root, absolute) ? path.relative(root, absolute).replace(/\\/g, "/") : `external:${hash(absolute).slice(0, 12)}`; }
function discoverCmakeReplies(root, options = {}) {
  const replies = [];
  for (const buildDir of options.buildDirs || ["build", "out", "cmake-build-debug", "cmake-build-release"]) {
    const absolute = path.resolve(root, buildDir);
    if (!inside(root, absolute)) continue;
    const direct = path.join(absolute, ".cmake", "api", "v1", "reply");
    try { if (fs.statSync(direct).isDirectory()) replies.push(direct); } catch {}
    try {
      for (const child of fs.readdirSync(absolute).slice(0, 50)) {
        const nested = path.join(absolute, child, ".cmake", "api", "v1", "reply");
        try { if (fs.statSync(nested).isDirectory()) replies.push(nested); } catch {}
      }
    } catch {}
  }
  return Array.from(new Set(replies)).sort();
}
function latestIndex(replyDir) { try { return fs.readdirSync(replyDir).filter((name) => /^index-.*\.json$/.test(name)).sort().at(-1) || null; } catch { return null; } }
function codemodelReference(index) {
  if (index?.reply?.codemodel?.jsonFile) return index.reply.codemodel.jsonFile;
  for (const value of Object.values(index?.reply || {})) if (value?.kind === "codemodel" && value.jsonFile) return value.jsonFile;
  for (const object of index?.objects || []) if (object.kind === "codemodel" && object.jsonFile) return object.jsonFile;
  return null;
}
function parseTarget(root, replyDir, configuration, targetRef) {
  const target = readJson(path.join(replyDir, targetRef.jsonFile || ""));
  if (!target) return { facts: [], targets: [], degradation: { code: "malformed_cmake_target", message: `Cannot read ${targetRef.jsonFile}`, retryable: false } };
  const name = target.name || targetRef.name || target.id;
  const targetId = `cmake-target:${name}`;
  const common = { provider: "cmake-file-api", configuration, freshness: "fresh", gatingSafe: true, provenance: [{ provider: "cmake-file-api", operation: "codemodel" }] };
  const facts = [];
  for (const dependency of target.dependencies || []) facts.push({ ...common, subject: targetId, predicate: "depends-on", object: `cmake-target:${dependency.id || dependency.name}` });
  for (const artifact of target.artifacts || []) facts.push({ ...common, subject: targetId, predicate: "produces", object: repositoryPath(root, artifact.path, replyDir) });
  const compileGroups = target.compileGroups || [];
  for (const source of target.sources || []) {
    const file = repositoryPath(root, source.path, root);
    facts.push({ ...common, subject: file, predicate: "owned-by-target", object: targetId, path: file, contentHash: hash({ targetId, file, configuration }) });
    if (source.isGenerated) facts.push({ ...common, subject: targetId, predicate: "generates", object: file, path: file, contentHash: hash({ targetId, file, generated: true }) });
    const group = Number.isInteger(source.compileGroupIndex) ? compileGroups[source.compileGroupIndex] : null;
    if (group) facts.push({ ...common, subject: `translation-unit:${file}`, predicate: "compiled-with", object: `configuration:${configuration}:${group.language || "unknown"}`, path: file, contentHash: hash(group) });
  }
  const targetSummary = { id: targetId, name, type: target.type, configuration, sources: (target.sources || []).map((source) => repositoryPath(root, source.path, root)), artifacts: (target.artifacts || []).map((artifact) => repositoryPath(root, artifact.path, replyDir)), dependencies: (target.dependencies || []).map((dependency) => `cmake-target:${dependency.id || dependency.name}`), compileGroups: compileGroups.map((group) => ({ language: group.language, defines: (group.defines || []).map((item) => item.define).filter((define) => !/secret|token|password|credential|key=/i.test(define || "")), includes: (group.includes || []).map((item) => repositoryPath(root, item.path, root)), fragmentHash: hash(group.compileCommandFragments || []).slice(0, 16) })) };
  return { facts, targets: [targetSummary], degradation: null };
}
function parseCmakeReply(root, replyDir) {
  const indexName = latestIndex(replyDir);
  if (!indexName) return { provider: "cmake-file-api", replyDir, facts: [], targets: [], degradation: { code: "missing_cmake_index", message: "No CMake File API index reply found", retryable: false } };
  const index = readJson(path.join(replyDir, indexName));
  const modelFile = codemodelReference(index);
  const model = modelFile ? readJson(path.join(replyDir, modelFile)) : null;
  if (!model) return { provider: "cmake-file-api", replyDir, facts: [], targets: [], degradation: { code: "missing_codemodel", message: "CMake reply has no readable codemodel", retryable: false } };
  const facts = [], targets = [], degradations = [];
  for (const config of model.configurations || []) {
    const configuration = String(config.name || "default");
    for (const targetRef of config.targets || []) {
      const result = parseTarget(root, replyDir, configuration, targetRef);
      facts.push(...result.facts); targets.push(...result.targets); if (result.degradation) degradations.push(result.degradation);
    }
  }
  return { provider: "cmake-file-api", replyDir: path.relative(root, replyDir).replace(/\\/g, "/"), index: indexName, facts, targets, degradation: degradations[0] || null };
}
function loadCmakeFileApi(root, options = {}) { const replies = discoverCmakeReplies(root, options); const results = replies.map((reply) => parseCmakeReply(root, reply)); return { provider: "cmake-file-api", available: replies.length > 0, replies: replies.map((reply) => path.relative(root, reply).replace(/\\/g, "/")), facts: results.flatMap((result) => result.facts), targets: results.flatMap((result) => result.targets), degradation: results.find((result) => result.degradation)?.degradation || (!replies.length ? { code: "not_configured", message: "No existing CMake File API reply found", retryable: false } : null) }; }

module.exports = { discoverCmakeReplies, latestIndex, codemodelReference, parseCmakeReply, loadCmakeFileApi, repositoryPath };
