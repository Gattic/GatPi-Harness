"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { createFallbackProvider } = require("./lsp-fallback.js");
const { OPERATIONS } = require("./lsp-fallback-runner.js");

// Analysis only. In particular, never dispatch renameApply or accept code/module
// paths from a request. The parent owns cancellation, deadlines and termination.
try {
  const { operation, root, params, options } = workerData;
  if (!OPERATIONS.has(operation)) throw new Error(`Unsupported fallback analysis: ${operation}`);
  const result = createFallbackProvider(options)[operation](root, params);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, error: { code: error.code, message: error.message } });
}
