#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLspAdapter } = require("../src/lsp-adapter.js");
const { inferLanguage, serverRegistry } = require("../src/lsp-server-registry.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const tmp = tmpFixture("pi-lsp-adapter-");
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "main.js"), "foo = 1;\r\nfunction foo() { return foo; }\r\nfunction foobar() { return 2; }\r\n// foo comment\r\nconst text = 'foo string';\r\n");
  try { fs.symlinkSync(path.join(os.tmpdir(), "outside.js"), path.join(tmp, "src", "outside.js")); } catch {}
  const unavailable = { forLanguage() { return null; }, candidates() { return []; }, status() { return []; } };
  const fallback = createLspAdapter({ registry: unavailable, live: true, maxResults: 20 });
  const fallbackStatus = await fallback.status({ cwd: tmp }, {});
  assert.equal(fallbackStatus.details.backend, "facade");
  assert.equal(fallbackStatus.details.liveCapabilitiesAvailable, false);
  assert.deepEqual(fallbackStatus.details.supportedOperations.liveSemantic, []);
  const exactSymbols = await fallback.workspaceSymbols({ cwd: tmp }, { symbol: "foo" });
  assert.deepEqual(exactSymbols.details.symbols.map((row) => row.name), ["foo"]);
  assert.equal(exactSymbols.details.matchPolicy, "exact-symbol");
  assert.equal(exactSymbols.details.backend, "fallback");
  assert.equal(exactSymbols.details.gatingSafe, false);
  assert.match(exactSymbols.details.degradation.message, /not compiler-resolved/);
  const absentSymbols = await fallback.workspaceSymbols({ cwd: tmp }, { symbol: "missingSymbol" });
  assert.deepEqual(absentSymbols.details.symbols, []);
  assert.equal(absentSymbols.details.degradation.code, "advisory_no_match");
  const definition = await fallback.definition({ cwd: tmp }, { file: "src/main.js", line: 2, column: 10 });
  assert.equal(definition.details.backend, "fallback");
  assert.equal(definition.details.gatingSafe, false);
  assert.equal(definition.details.degradation.code, "lexical_fallback");
  const references = await fallback.references({ cwd: tmp }, { file: "src/main.js", line: 2, column: 10 });
  assert.equal(references.details.backend, "fallback");
  assert.ok(references.details.references.length >= 2);
  assert.ok(references.details.references.every((ref) => !/comment|string/.test(ref.preview)), "comments and strings must not masquerade as references");
  const previewOnly = await fallback.rename({ cwd: tmp }, { file: "src/main.js", line: 2, column: 10, newName: "bar", apply: false });
  assert.equal(previewOnly.details.degradation.code, "fallback_preview_only");
  await assert.rejects(fallback.rename({ cwd: tmp }, { file: "src/main.js", line: 2, column: 10, newName: "bar", apply: true }), /live-lsp renamePreview/);
  const symbols = await fallback.documentSymbols({ cwd: tmp }, {});
  assert.ok(symbols.details.symbols.every((symbol) => symbol.file !== "src/outside.js"), "symlinks must not be traversed");

  assert.equal(inferLanguage("a.cpp"), "cpp");
  assert.equal(inferLanguage("a.cu"), "cuda");
  assert.equal(inferLanguage("a.cuh"), "cuda");
  assert.ok(serverRegistry().candidates("cpp").some((server) => server.id === "clangd"));

  fs.writeFileSync(path.join(tmp, "src", "live.js"), "foo();\n");
  const fake = path.resolve(__dirname, "fixtures", "fake-lsp-server.js");
  const server = { id: "fake", languages: ["javascript"], command: process.execPath, args: [fake], executable: { found: true, path: process.execPath } };
  const registry = { forLanguage(language) { return language === "javascript" ? server : null; }, candidates() { return [server]; }, status() { return [server]; } };
  const live = createLspAdapter({ registry, timeoutMs: 1000 });
  assert.equal(live.sessionManager.sessions.size, 0);
  const resolved = await live.definition({ cwd: tmp }, { file: "src/live.js", line: 1, column: 2 });
  assert.equal(resolved.details.backend, "live-lsp");
  assert.equal(resolved.details.gatingSafe, true);
  assert.equal(resolved.details.definitions[0].file, "src/live.js");
  const rename = await live.rename({ cwd: tmp }, { file: "src/live.js", line: 1, column: 2, newName: "bar" });
  assert.equal(rename.details.backend, "live-lsp");
  assert.equal(rename.details.changes[0].expectedHash.length, 64);
  assert.equal(rename.details.preview.previewHash.length, 64);
  const tampered = { ...rename.details.preview, expectedHashes: { ...rename.details.preview.expectedHashes, "src/live.js": "0".repeat(64) } };
  await assert.rejects(live.rename({ cwd: tmp }, { file: "src/live.js", line: 1, column: 2, newName: "bar", apply: true, preview: tampered }), (error) => error.code === "LSP_RENAME_PREVIEW_HASH_MISMATCH");
  const otherAdapter = createLspAdapter({ registry, timeoutMs: 1000 });
  await assert.rejects(otherAdapter.rename({ cwd: tmp }, { file: "src/live.js", line: 1, column: 2, newName: "bar", apply: true, preview: rename.details.preview }), (error) => error.code === "LSP_RENAME_PREVIEW_UNTRUSTED");
  await otherAdapter.closeAll();
  fs.writeFileSync(path.join(tmp, "src", "live.js"), "changed();\n");
  await assert.rejects(live.rename({ cwd: tmp }, { file: "src/live.js", line: 1, column: 2, newName: "bar", apply: true, preview: rename.details.preview }), (error) => error.code === "STALE_WORKSPACE_EDIT");
  fs.writeFileSync(path.join(tmp, "src", "live.js"), "foo();\n");
  const freshRename = await live.rename({ cwd: tmp }, { file: "src/live.js", line: 1, column: 2, newName: "bar" });
  const applied = await live.rename({ cwd: tmp }, { file: "src/live.js", line: 1, column: 2, newName: "bar", apply: true, preview: freshRename.details.preview });
  assert.equal(applied.details.applied, true);
  assert.equal(fs.readFileSync(path.join(tmp, "src", "live.js"), "utf8"), "bar();\n");
  await live.closeAll();

  console.log("lsp adapter tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
