#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { tmpFixture } = require("./helpers/tmp-fixture");

function fixture(t) {
  const root = tmpFixture("pi-lsp-fallback-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (name, text) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  return { root, put };
}
// Never execute untrusted/pathological scanner input on the test runner thread.
async function probe(root, operation, params = {}) {
  const worker = new Worker(`
    const { parentPort, workerData: d } = require('node:worker_threads');
    try { parentPort.postMessage({ result: require(d.module).createFallbackProvider()[d.operation](d.root, d.params) }); }
    catch (error) { parentPort.postMessage({ error: { message: error.message, code: error.code } }); }
  `, { eval: true, workerData: { module: path.resolve(__dirname, "../src/lsp-fallback.js"), root, operation, params } });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Fallback probe exceeded 2000ms watchdog")), 2000);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Probe exited without result: ${code}`)));
      worker.once("message", ({ result, error }) => error ? reject(Object.assign(new Error(error.message), { code: error.code })) : resolve(result));
    });
  } finally { clearTimeout(timer); await worker.terminate(); }
}

test("long ambiguous declaration-like nonmatches finish under an external watchdog", async (t) => {
  const { root, put } = fixture(t);
  put("trigger.py", `${"ambiguous declaration ".repeat(500)}!\n${" ".repeat(10000)}\n`);
  const result = await probe(root, "definition", { file: "trigger.py", symbol: "missing" });
  assert.deepEqual(result.definitions, []);
  assert.equal(result.gatingSafe, false);
});

test("requested file precedes saturated workspace and explicit files caps", async (t) => {
  const { root, put } = fixture(t);
  for (let i = 0; i < 4; i++) put(`a${i}.js`, "const unrelated = 0;\n");
  put("z/requested.js", "const wanted = 1;\nwanted();\n");
  for (const files of [undefined, ["a0.js", "a1.js"]]) {
    const params = { file: "z/requested.js", symbol: "wanted", maxFiles: 2, files };
    assert.equal((await probe(root, "definition", params)).definitions[0]?.file, "z/requested.js");
    assert.equal((await probe(root, "references", params)).references[0]?.file, "z/requested.js");
    assert.equal((await probe(root, "renamePreview", { ...params, newName: "renamed" })).changes[0]?.file, "z/requested.js");
    assert.equal((await probe(root, "hover", { ...params, line: 2, column: 2 })).definitions[0]?.file, "z/requested.js");
  }
});

test("cache trees and wrong languages do not consume admission caps", async (t) => {
  const { root, put } = fixture(t);
  for (const dir of [".cache", ".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__", "nested/.cache"]) put(`${dir}/cached.js`, "const cached = 1;\n");
  put("a.py", "def python_only(): pass\n");
  put("z.js", "const wanted = 1;\n");
  assert.deepEqual(await probe(root, "listFiles", { language: "javascript", maxFiles: 1 }), ["z.js"]);
  assert.deepEqual((await probe(root, "symbols", {})).symbols.map((s) => s.name).sort(), ["python_only", "wanted"]);
});

test("explicit paths and symlink ancestors remain confined", async (t) => {
  const { root, put } = fixture(t);
  put("safe.js", "const wanted = 1;\n");
  put("..safe/ok.js", "const wanted = 1;\n");
  const outside = tmpFixture("pi-lsp-outside-");
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "outside.js"), "const wanted = 2;\n");
  for (const file of ["../outside.js", path.join(outside, "outside.js")]) {
    await assert.rejects(probe(root, "definition", { file, symbol: "wanted" }), /inside project/);
  }
  assert.equal((await probe(root, "symbols", { file: "@..safe/ok.js" })).symbols[0]?.name, "wanted");
  try {
    fs.symlinkSync(outside, path.join(root, "linked"), "dir");
    fs.symlinkSync(path.join(root, "safe.js"), path.join(root, "alias.js"), "file");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) { t.diagnostic(`symlink checks unavailable: ${error.code}`); return; }
    throw error;
  }
  for (const file of ["linked/outside.js", "alias.js"]) {
    for (const operation of ["symbols", "definition", "references", "hover", "renamePreview"]) {
      await assert.rejects(probe(root, operation, { file, symbol: "wanted", newName: "renamed" }), /symlink/i);
    }
  }
  assert.ok((await probe(root, "symbols")).symbols.every((s) => !s.file.startsWith("linked/") && s.file !== "alias.js"));
});

test("explicit file lists deduplicate, respect caps and size limits, and reject directories", async (t) => {
  const { root, put } = fixture(t);
  put("a.js", "const wanted = 1;\n");
  put("b.js", "const wanted = 2;\n");
  put("large.js", "x".repeat(2_000_001));
  assert.deepEqual(await probe(root, "listFiles", { files: ["a.js", "a.js", "b.js"], maxFiles: 1 }), ["a.js"]);
  assert.deepEqual(await probe(root, "listFiles", { files: ["large.js", "a.js"] }), ["a.js"]);
  await assert.rejects(probe(root, "hover", { file: "large.js" }), /at most 2000000 bytes/);
  fs.mkdirSync(path.join(root, "dir.js"));
  assert.deepEqual(await probe(root, "listFiles", { file: "dir.js" }), []);
  await assert.rejects(probe(root, "hover", { file: "dir.js" }), /regular file/);
  assert.equal((await probe(root, "references", { symbol: "wanted", maxResults: 1 })).references.length, 1);
});

test("normal declarations, exact names, CRLF and UTF-16 positions stay advisory", async (t) => {
  const { root, put } = fixture(t);
  const text = 'export async function wanted() {}\r\nstatic const Thing* typed(int x);\r\nexports.member = 1;\r\nconst s = "😀"; wanted(); // wanted\r\nconst wantedMore = 2;\r\n';
  put("normal.js", text);
  const definition = await probe(root, "definition", { file: "normal.js", symbol: "wanted" });
  assert.equal(definition.definitions.length, 1);
  assert.deepEqual(definition.definitions[0].loc.start, { line: 1, column: 1 });
  assert.equal(definition.gatingSafe, false);
  assert.equal((await probe(root, "definition", { symbol: "typed" })).definitions.length, 1);
  assert.equal((await probe(root, "definition", { symbol: "member" })).definitions.length, 1);
  const refs = await probe(root, "references", { symbol: "wanted" });
  assert.equal(refs.references.length, 2);
  const call = refs.references[1];
  assert.equal(text.slice(call.range.start, call.range.end), "wanted");
  assert.deepEqual(call.loc.start, { line: 4, column: 17 });
  const inferred = await probe(root, "definition", { file: "normal.js", line: 4, column: 18 });
  assert.equal(inferred.symbol, "wanted");
});
