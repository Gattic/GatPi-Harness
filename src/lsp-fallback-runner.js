"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

const CAPABILITIES = ["symbols", "definition", "references", "hover", "renamePreview"];
const OPERATIONS = new Set([...CAPABILITIES, "listFiles"]);
const ANALYSIS_FIELDS = ["file", "files", "symbol", "query", "newName", "language", "line", "column", "maxFiles", "maxResults"];
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function deadline(value, fallback = 30000) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(600000, Math.floor(n))) : fallback;
}

// Each request owns one disposable worker. Timers and AbortSignal handling live
// here, not on the thread doing synchronous filesystem/scanner work.
class LspFallbackRunner {
  constructor(options = {}) {
    this.Worker = options.Worker || Worker;
    this.options = { maxFiles: options.maxFiles, maxResults: options.maxResults };
    this.timeoutMs = deadline(options.timeoutMs);
    this.capabilities = CAPABILITIES.slice();
    this.active = new Set();
    this.closed = false;
  }
  async request(operation, root, params = {}, signal) {
    if (signal?.aborted) throw failure("ABORT_ERR", "LSP fallback cancelled");
    if (this.closed) throw failure("LSP_FALLBACK_CLOSED", "LSP fallback is shut down");
    if (!OPERATIONS.has(operation)) throw failure("LSP_FALLBACK_OPERATION", `Unsupported fallback analysis: ${operation}`);
    // Do not transfer mutation queues, authorization previews, signals or arbitrary input.
    const input = Object.fromEntries(ANALYSIS_FIELDS.filter((key) => params[key] !== undefined).map((key) => [key, params[key]]));
    const timeoutMs = deadline(params.timeoutMs, this.timeoutMs);
    return new Promise((resolve, reject) => {
      let worker, timer, settled = false;
      const record = { stop: () => settle(failure("LSP_FALLBACK_CLOSED", "LSP fallback shut down during analysis")) };
      const cleanup = () => {
        worker?.removeListener("message", onMessage);
        worker?.removeListener("error", onError);
        worker?.removeListener("exit", onExit);
        this.active.delete(record);
      };
      const settle = (error, result) => {
        if (settled) return record.done;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        // Settle only after termination: callers/shutdown never observe success
        // while their worker is still running. Keep error/exit listeners until then.
        record.done = Promise.resolve().then(() => worker?.terminate()).then(() => {
          cleanup();
          if (error) reject(error); else resolve(result);
        }, (terminationError) => { cleanup(); reject(terminationError); });
        return record.done;
      };
      const onAbort = () => settle(failure("ABORT_ERR", "LSP fallback cancelled"));
      const onError = (error) => settle(failure("LSP_FALLBACK_WORKER_ERROR", `LSP fallback worker failed: ${error.message}`));
      const onExit = (code) => settle(failure("LSP_FALLBACK_WORKER_EXIT", `LSP fallback worker exited without a result (${code})`));
      const onMessage = (message) => {
        if (message?.ok === true) settle(null, message.result);
        else if (message?.ok === false && message.error) settle(failure(message.error.code || "LSP_FALLBACK_ERROR", message.error.message));
        else settle(failure("LSP_FALLBACK_PROTOCOL", "Invalid LSP fallback worker response"));
      };
      this.active.add(record);
      timer = setTimeout(() => settle(failure("LSP_FALLBACK_TIMEOUT", `LSP fallback exceeded ${timeoutMs}ms deadline`)), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        worker = new this.Worker(path.join(__dirname, "lsp-fallback-worker.js"), { workerData: { operation, root, params: input, options: this.options } });
        worker.once("message", onMessage);
        worker.once("error", onError);
        worker.once("exit", onExit);
        if (signal?.aborted) onAbort();
      } catch (error) { settle(error); }
    });
  }
  async closeAll() {
    this.closed = true;
    const records = [...this.active];
    await Promise.all(records.map((record) => record.stop()));
    return { closed: records.length };
  }
}

module.exports = { LspFallbackRunner, OPERATIONS };
