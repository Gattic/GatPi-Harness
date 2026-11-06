"use strict";

// Harness boundary for the Redis request queue. Loading this module or its
// extension never connects; the first queued model request or query opens one
// shared connection for the Pi process.
const fs = require("node:fs");
const path = require("node:path");
const { clientConfiguration, connectionOptions } = require("./pi-queue/config.js");

const runtimeRoot = path.join(__dirname, "pi-queue");
const bypass = "set PI_QUEUE=0 to call the model directly";
let shared;

function queueReadiness({ env = process.env } = {}) {
  if (env.PI_QUEUE === "0") return { outcome: "disabled", ready: false, reason: "PI_QUEUE=0" };
  if (!fs.existsSync(path.join(runtimeRoot, "node_modules", "ioredis", "package.json"))) {
    return { outcome: "not-installed", ready: false, reason: "Run scripts/setup-pi-queue.sh in pi-harness" };
  }
  try {
    clientConfiguration(env);
    return { outcome: "ready", ready: true, scope: "local configuration only; Redis reachability is checked by a request" };
  } catch (error) {
    if (error.code === "ENOENT") return { outcome: "not-configured", ready: false, reason: "Provision ~/.config/pi-queue/client.env (mode 600) or set PI_QUEUE_ENV" };
    // Never include file contents, parser diagnostics or credential values.
    return { outcome: "invalid-config", ready: false, reason: "Queue connection configuration is invalid; check absolute paths, required fields, ownership and mode 600 privately" };
  }
}

function queueFor(env) {
  const readiness = queueReadiness({ env });
  if (!readiness.ready) throw new Error(`Pi request queue is ${readiness.outcome}: ${readiness.reason}`);
  const { file, values } = clientConfiguration(env);
  if (!shared || shared.file !== file) {
    shared?.queue.close();
    const { createRequestQueue } = require("./pi-queue/request-queue.js");
    shared = { file, queue: createRequestQueue(connectionOptions(values), { prefix: values.QUEUE_PREFIX }) };
  }
  return shared.queue;
}

// Joins the shared queue and resolves once this request may be sent to the model.
// The returned ticket must be finished with the request's outcome.
async function acquireModelSlot(meta, { signal, onWaiting, env = process.env } = {}) {
  let queue;
  try {
    queue = queueFor(env);
  } catch (error) {
    throw new Error(`${error.message}. Model requests are routed through the Pi request queue; ${bypass}.`);
  }
  try {
    return await queue.acquire(meta, { signal, onWaiting });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error(`Pi request queue request failed (${error.message}); the model request was not sent. Check the broker, or ${bypass}.`);
  }
}

async function queueQuery(operation, input = {}, { env = process.env } = {}) {
  if (operation === "status" && input.id === undefined) {
    const readiness = queueReadiness({ env });
    if (!readiness.ready) return readiness;
  }
  const queue = queueFor(env);
  if (operation === "status") {
    if (input.id === undefined) return queue.status();
    const found = await queue.show(input.id);
    if (!found) throw new Error(`Unknown queued request ${input.id}`);
    return found;
  }
  if (operation === "list") return queue.list({ limit: input.limit ?? 20, state: input.state });
  throw new Error("Unsupported queue operation");
}

async function closeQueue() {
  const current = shared;
  shared = undefined;
  await current?.queue.close();
}

module.exports = { queueReadiness, acquireModelSlot, queueQuery, closeQueue };
