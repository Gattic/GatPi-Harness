"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { SemanticEditEngine, semanticDiff, parseStructuralNodes, sha256, previewWorkspaceEdit, applyWorkspaceEdit } = require("../src/semantic-editor");

const original = `"use strict";
const fs = require("node:fs");

function alpha(input) {
  const value = String(input || "").trim();
  return value.toUpperCase();
}

function beta(items) {
  return items.map((x) => alpha(x));
}

module.exports = { alpha, beta };
`;

const engine = new SemanticEditEngine();
const start = original.indexOf("function alpha");
const end = original.indexOf("\n\nfunction beta");
const replacement = `function alpha(input) {
  const value = String(input || "").trim();
  if (!value) return "";
  return value.toLocaleUpperCase("en-US");
}`;
const patch = engine.createPatch({ filePath: "sample.js", content: original, start, end, replacement });

const drifted = original.replace("const fs = require(\"node:fs\");", "const path = require(\"node:path\");\nconst fs = require(\"node:fs\");");
const { tmpFixture } = require("./helpers/tmp-fixture");
const applied = engine.apply(drifted, [patch], { filePath: "sample.js" });
assert.equal(applied.ok, true, "AST/semantic anchor survives unrelated drift");
assert(applied.content.includes("toLocaleUpperCase"));
assert(applied.validation.resolved[0].resolution.drifted, "content hash drift is detected");
assert(applied.validation.resolved[0].resolution.confidence >= 0.78, "confidence is exposed");

const rolled = engine.rollback(applied.content, applied.checkpoint);
assert.equal(rolled.ok, true, "inverse patch chain is reversible");
assert(rolled.content.includes("return value.toUpperCase();"), "rollback restores original region");

const duplicate = engine.apply(original, [patch, engine.createPatch({ filePath: "sample.js", content: original, start, end, replacement })]);
assert.equal(duplicate.ok, false, "duplicate generated code is rejected");
assert(duplicate.validation.rejections.some((r) => r.reason === "overlapping-edit" || r.reason === "duplicate-generated-code"));

const stalePatch = { ...patch, anchor: { ...patch.anchor, semanticRegionId: "function:missing", astNodeIdentity: "function:missing:deadbeef", tokenSignature: ["totally", "absent", "tokens"] } };
const staleContent = original.replace(original.slice(start, end), "function gamma(value) {\n  return value;\n}");
const stale = engine.apply(staleContent, [stalePatch]);
assert.equal(stale.ok, false, "stale low-confidence patch is rejected");

const bad = engine.createPatch({ filePath: "sample.js", content: original, start, end, replacement: "function alpha(input) {\n  return (input;\n}" });
assert.equal(engine.apply(original, [bad]).ok, false, "malformed partial rewrite is rejected before commit");

const diff = semanticDiff(original, applied.content, "sample.js");
assert(diff.changes.some((c) => c.type === "modify" && c.semanticId === "function:alpha"), "semantic diff reports modified function");
assert(diff.dependencyImpact.unchanged.includes("node:fs"), "dependency impact is reported");

const nodes = parseStructuralNodes(original, "sample.js");
assert(nodes.some((n) => n.semanticId === "function:alpha" && n.sourceHash), "AST-like node identities include hashes");
assert.equal(typeof sha256(original), "string");
assert(engine.metrics().attempted >= 4, "integrity metrics are tracked");

(async () => {
  const tmp = tmpFixture("pi-workspace-edit-");
  const file = path.join(tmp, "sample.js");
  fs.writeFileSync(file, "alpha();\n");
  const uri = pathToFileURL(file).href;
  const preview = previewWorkspaceEdit(tmp, { changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "beta" }] } });
  assert.equal(preview.changes[0].expectedHash, sha256("alpha();\n"));
  let queued = 0;
  const result = await applyWorkspaceEdit(tmp, preview, { queue: async (_file, fn) => { queued++; return fn(); } });
  assert.equal(result.applied, true);
  assert.equal(queued, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "beta();\n");
  await assert.rejects(applyWorkspaceEdit(tmp, preview), (error) => error.code === "STALE_WORKSPACE_EDIT");
  assert.throws(() => previewWorkspaceEdit(tmp, { changes: { [pathToFileURL(path.join(tmp, "..", "outside.js")).href]: [] } }), (error) => error.code === "WORKSPACE_EDIT_OUTSIDE_ROOT");
  fs.writeFileSync(file, "abcdef\n");
  assert.throws(() => previewWorkspaceEdit(tmp, { changes: { [uri]: [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "x" },
    { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, newText: "y" }
  ] } }), (error) => error.code === "OVERLAPPING_WORKSPACE_EDITS");
  assert.throws(() => previewWorkspaceEdit(tmp, { documentChanges: [{ kind: "rename", oldUri: uri, newUri: uri }] }), (error) => error.code === "UNSUPPORTED_WORKSPACE_RESOURCE_OPERATION");
  console.log("semantic-editor tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
