#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getEventListeners } = require("node:events");
const { Worker } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { LspFallbackRunner } = require("../src/lsp-fallback-runner.js");
const { createLspAdapter } = require("../src/lsp-adapter.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

function setup(t, mode) {
  const root = tmpFixture("pi-lsp-worker-");
  fs.writeFileSync(path.join(root, "main.js"), "function wanted() {}\nwanted();\n");
  const workers = [];
  class TrackedWorker extends Worker {
    constructor(file, options) {
      const ready = new SharedArrayBuffer(4);
      super(mode ? path.join(__dirname, "fixtures/lsp-fallback-worker-fixture.js") : file, { ...options, workerData: { ...options.workerData, mode, ready } });
      this.ready = new Int32Array(ready);
      this.operation = options.workerData.operation;
      workers.push(this);
    }
  }
  const runner = new LspFallbackRunner({ Worker: TrackedWorker, timeoutMs: 2000 });
  t.after(async () => { await runner.closeAll(); await Promise.all(workers.map((w) => w.terminate())); fs.rmSync(root, { recursive: true, force: true }); });
  const clean = (signal) => {
    assert.equal(runner.active.size, 0);
    for (const w of workers) {
      assert.equal(w.threadId, -1, "request must settle after worker termination");
      for (const event of ["message", "error", "exit"]) assert.equal(w.listenerCount(event), 0);
    }
    if (signal) assert.equal(getEventListeners(signal, "abort").length, 0);
  };
  return { root, workers, runner, TrackedWorker, clean };
}
async function ready(worker) {
  const result = Atomics.waitAsync(worker.ready, 0, 0, 1500);
  await result.value;
  assert.equal(Atomics.load(worker.ready, 0), 1, "synthetic worker must enter noncooperative work");
}

test("real fallback success, source errors, and clone errors clean every resource", async (t) => {
  const { root, runner, clean } = setup(t);
  const controller = new AbortController();
  const params = { file: "main.js", symbol: "wanted", queue: () => { throw new Error("mutation queue must never enter worker"); } };
  const result = await runner.request("definition", root, params, controller.signal);
  assert.equal(result.definitions.length, 1);
  assert.equal(result.gatingSafe, false);
  clean(controller.signal);
  await assert.rejects(runner.request("hover", root, { file: "missing.js" }, controller.signal), { code: "ENOENT" });
  clean(controller.signal);
  await assert.rejects(runner.request("symbols", root, { symbol: () => {} }, controller.signal), /clone/i);
  clean(controller.signal);
});

test("parent heartbeat and deadline interrupt noncooperative CPU work", async (t) => {
  const { root, runner, workers, clean } = setup(t, "hang");
  const controller = new AbortController();
  let beats = 0;
  const heartbeat = setInterval(() => beats++, 5);
  t.after(() => clearInterval(heartbeat));
  const started = Date.now();
  const rejected = assert.rejects(runner.request("definition", root, { timeoutMs: 500 }, controller.signal), { code: "LSP_FALLBACK_TIMEOUT" });
  await ready(workers[0]);
  await rejected;
  assert.ok(beats > 2, "parent timers must run while analysis is stuck");
  assert.ok(Date.now() - started < 2000, "deadline must settle promptly");
  clean(controller.signal);
});

test("pre-abort launches no worker; in-flight abort terminates only its own request", async (t) => {
  const { root, runner, workers, clean } = setup(t, "hang");
  const first = new AbortController();
  first.abort();
  await assert.rejects(runner.request("symbols", root, {}, first.signal), { code: "ABORT_ERR" });
  assert.equal(workers.length, 0);
  const cancel = new AbortController();
  const rejected = assert.rejects(runner.request("symbols", root, {}, cancel.signal), { code: "ABORT_ERR" });
  const shutdown = assert.rejects(runner.request("symbols", root), { code: "LSP_FALLBACK_CLOSED" });
  await Promise.all(workers.map(ready));
  cancel.abort();
  await rejected;
  assert.equal(workers[0].threadId, -1);
  assert.notEqual(workers[1].threadId, -1);
  assert.equal(runner.active.size, 1);
  assert.deepEqual(await runner.closeAll(), { closed: 1 });
  await shutdown;
  assert.deepEqual(await runner.closeAll(), { closed: 0 });
  await assert.rejects(runner.request("symbols", root), { code: "LSP_FALLBACK_CLOSED" });
  clean(cancel.signal);
});

for (const [mode, code] of [["error", "LSP_FALLBACK_WORKER_ERROR"], ["exit", "LSP_FALLBACK_WORKER_EXIT"], ["empty-exit", "LSP_FALLBACK_WORKER_EXIT"], ["invalid", "LSP_FALLBACK_PROTOCOL"]]) {
  test(`${mode} settles once and releases worker/listeners`, async (t) => {
    const { root, runner, clean } = setup(t, mode);
    const controller = new AbortController();
    await assert.rejects(runner.request("symbols", root, {}, controller.signal), { code });
    controller.abort();
    clean(controller.signal);
  });
}

test("analysis allowlist excludes mutation and prototype operations", async (t) => {
  const { root, runner, workers } = setup(t);
  for (const op of ["renameApply", "constructor", "toString"]) await assert.rejects(runner.request(op, root), { code: "LSP_FALLBACK_OPERATION" });
  assert.equal(workers.length, 0);
  assert.equal(fs.readFileSync(path.join(root, "main.js"), "utf8"), "function wanted() {}\nwanted();\n");
});

test("every adapter fallback caller uses workers, including failed live requests", async (t) => {
  const { root, TrackedWorker, workers } = setup(t);
  const unavailable = { forLanguage: () => null, status: () => [] };
  const adapter = createLspAdapter({ registry: unavailable, FallbackWorker: TrackedWorker });
  t.after(() => adapter.closeAll());
  for (const method of ["documentSymbols", "definition", "references", "hover", "rename", "workspaceSymbols"]) {
    const before = workers.length;
    const params = { symbol: "wanted", newName: "renamed", ...(method === "workspaceSymbols" ? {} : { file: "main.js", line: 2, column: 2 }) };
    const result = await adapter[method]({ cwd: root }, params);
    assert.equal(result.details.backend, "fallback");
    assert.equal(result.details.gatingSafe, false);
    assert.ok(workers.length > before, `${method} must execute off-thread`);
    assert.ok(workers.every((w) => w.threadId === -1));
  }
  assert.ok(workers.some((w) => w.operation === "listFiles"), "workspace language sampling must also be off-thread");
  const server = { id: "failed" };
  const failed = createLspAdapter({ registry: { ...unavailable, forLanguage: () => server }, FallbackWorker: TrackedWorker, sessionManager: { get: async () => { throw Object.assign(new Error("live failed"), { code: "LSP_TIMEOUT" }); }, closeAll: async () => ({ closed: 0 }) } });
  t.after(() => failed.closeAll());
  for (const method of ["documentSymbols", "definition", "references", "hover", "rename", "workspaceSymbols"]) {
    const before = workers.length;
    const params = { symbol: "wanted", newName: "renamed", ...(method === "workspaceSymbols" ? { language: "javascript" } : { file: "main.js", line: 2, column: 2 }) };
    const result = await failed[method]({ cwd: root }, params);
    assert.equal(result.details.gatingSafe, false);
    assert.ok(workers.length > before);
  }
});

test("adapter forwards pre-abort and per-request deadlines on every fallback path", async (t) => {
  const { root, TrackedWorker, workers } = setup(t, "hang");
  const adapter = createLspAdapter({ live: false, FallbackWorker: TrackedWorker });
  t.after(() => adapter.closeAll());
  const cancelled = new AbortController();
  cancelled.abort();
  for (const method of ["documentSymbols", "definition", "references", "hover", "rename", "workspaceSymbols"]) {
    const params = { file: "main.js", symbol: "wanted", newName: "renamed", timeoutMs: 20 };
    const before = workers.length;
    await assert.rejects(adapter[method]({ cwd: root }, params, cancelled.signal), { code: "ABORT_ERR" });
    assert.equal(workers.length, before);
    await assert.rejects(adapter[method]({ cwd: root }, params), { code: "LSP_FALLBACK_TIMEOUT" });
    assert.equal(workers.length, before + 1);
    assert.equal(workers.at(-1).threadId, -1);
  }
});

test("project-root symlink escape is rejected before workers start", async (t) => {
  const { root, TrackedWorker, workers } = setup(t);
  const outside = tmpFixture("pi-lsp-worker-outside-");
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const adapter = createLspAdapter({ live: false, allowOutsideCwd: false, FallbackWorker: TrackedWorker });
  t.after(() => adapter.closeAll());
  try { fs.symlinkSync(outside, path.join(root, "escape"), "dir"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) { t.skip(`symlinks unavailable: ${error.code}`); return; }
    throw error;
  }
  await assert.rejects(adapter.definition({ cwd: root }, { path: "escape", symbol: "wanted" }), /session project scope/);
  assert.equal(workers.length, 0);
  fs.mkdirSync(path.join(root, "..safe"));
  assert.equal((await adapter.documentSymbols({ cwd: root }, { path: "..safe" })).details.gatingSafe, false);
});

test("adapter shutdown and cancellation reach pending fallback; rename apply stays separate", async (t) => {
  const { root, TrackedWorker, workers } = setup(t, "hang");
  const adapter = createLspAdapter({ live: false, FallbackWorker: TrackedWorker });
  t.after(() => adapter.closeAll());
  const controller = new AbortController();
  const aborted = assert.rejects(adapter.definition({ cwd: root }, { file: "main.js", symbol: "wanted" }, controller.signal), { code: "ABORT_ERR" });
  // liveContext yields first; wait for dispatch, not a timing assumption about startup.
  await new Promise((resolve) => setImmediate(resolve));
  await ready(workers[0]);
  controller.abort();
  await aborted;
  const pending = assert.rejects(adapter.workspaceSymbols({ cwd: root }, {}), { code: "LSP_FALLBACK_CLOSED" });
  await new Promise((resolve) => setImmediate(resolve));
  await ready(workers[1]);
  const closed = await adapter.closeAll();
  await pending;
  assert.equal(closed.fallbackWorkersClosed, 1);
  assert.ok(workers.every((w) => w.threadId === -1));
  const count = workers.length;
  await assert.rejects(adapter.rename({ cwd: root }, { operation: "renameApply", newName: "renamed" }), /live-lsp renamePreview/);
  assert.equal(workers.length, count);
});
