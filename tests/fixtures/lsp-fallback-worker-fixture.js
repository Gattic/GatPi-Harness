"use strict";

const { workerData, parentPort } = require("node:worker_threads");
if (workerData.mode === "error") throw new Error("synthetic fallback worker crash");
if (workerData.mode === "exit") process.exit(17);
if (workerData.mode === "empty-exit") process.exit(0);
if (workerData.mode === "invalid") parentPort.postMessage({ invalid: true });
if (workerData.mode === "hang") {
  const ready = new Int32Array(workerData.ready);
  Atomics.store(ready, 0, 1);
  Atomics.notify(ready, 0);
  // Deliberately noncooperative CPU work; only the owning parent may terminate it.
  for (;;) {}
}
