"use strict";

// Runs against an exclusively owned, loopback-only Redis container with the same
// persistence settings as the broker. Never discovers production credentials.
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { setTimeout: sleep } = require("node:timers/promises");
const { QUEUE_USER_PERMISSIONS } = require("../acl.js");

// The queue module needs an installed Redis client. Report the whole file as
// skipped when that optional dependency is missing, but never swallow a real
// load failure: a syntax error or broken module must still fail the suite.
let createRequestQueue = null;
try {
  ({ createRequestQueue } = require("../request-queue.js"));
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND" || !/ioredis/.test(String(error?.message || ""))) throw error;
}

const image = "redis@sha256:0bf6577d7774e592b29d093e3ac9390eb91e13d72c21e506afce736de5e0eeb0";
const name = `pi-queue-test-${randomBytes(4).toString("hex")}`;
const dockerAvailable = !createRequestQueue ? false : (() => { try { execFileSync("docker", ["version"], { stdio: "ignore", timeout: 10000 }); return true; } catch { return false; } })();
const skipReason = !createRequestQueue
  ? "redis client dependency (ioredis) is not installed: pi-queue integration tests are skipped"
  : !dockerAvailable
    ? "docker unavailable: pi-queue integration tests require a local docker daemon"
    : null;
const testCase = skipReason ? (title, fn) => test(title, { skip: skipReason }, fn) : test;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let port;
const queues = [];
// Clients authenticate as a user with the broker's exact queue ACL.
const password = randomBytes(16).toString("hex");
const connection = () => ({ host: "127.0.0.1", port, username: "queue", password });
const open = (options = {}) => {
  const queue = createRequestQueue(connection(), { prefix: "piq:test", pollMs: 20, ...options });
  queues.push(queue);
  return queue;
};
async function waitForRedis() {
  // A restart can publish the container on a different ephemeral host port.
  port = Number(docker("port", name, "6379/tcp").split(":").pop());
  for (let i = 0; i < 100; i++) {
    try { if (docker("exec", name, "redis-cli", "ping") === "PONG") return; } catch {}
    await sleep(100);
  }
  throw new Error("Redis test container did not become ready");
}

test.before(async () => {
  if (!createRequestQueue || !dockerAvailable) return;
  docker("run", "-d", "--name", name, "--label", "pi-queue-test=1", "-p", "127.0.0.1::6379", "--entrypoint", "redis-server", image,
    "--appendonly", "yes", "--appendfsync", "always", "--save", "", "--user", "queue", "on", `>${password}`, ...QUEUE_USER_PERMISSIONS.split(" "));
  await waitForRedis();
});

test.after(async () => {
  if (!createRequestQueue || !dockerAvailable) return;
  await Promise.all(queues.map((queue) => queue.close()));
  try { docker("container", "stop", name); } finally { docker("container", "rm", name); }
});

testCase("requests beyond the limit wait in FIFO order and start as slots free", async () => {
  const queue = open();
  await queue.setLimit(1);
  const first = await queue.acquire({ host: "a", model: "m" });
  const order = [];
  const second = queue.acquire({ host: "b" }).then((ticket) => { order.push("second"); return ticket; });
  await sleep(60);
  const third = queue.acquire({ host: "c" }).then((ticket) => { order.push("third"); return ticket; });
  await sleep(100);
  let status = await queue.status();
  assert.equal(status.counts.running, 1);
  assert.deepEqual(status.waiting.map((entry) => [entry.position, entry.host]), [[1, "b"], [2, "c"]]);
  await first.finish("completed", { inputTokens: 10, outputTokens: 5 });
  const secondTicket = await second;
  await sleep(100);
  assert.deepEqual(order, ["second"], "only one request runs at limit 1");
  await secondTicket.finish("completed");
  await (await third).finish("failed", { error: "model error" });
  assert.deepEqual(order, ["second", "third"]);
  status = await queue.status();
  assert.equal(status.counts.running + status.counts.waiting, 0);
  const done = await queue.show(first.id);
  assert.equal(done.state, "completed");
  assert.equal(done.inputTokens, 10);
  assert.ok(done.runMs >= 0 && done.waitMs >= 0);
  assert.equal((await queue.show(secondTicket.id)).waitMs > 0, true, "the queued request recorded its wait");
});

testCase("a higher limit runs requests concurrently", async () => {
  const queue = open();
  await queue.setLimit(3);
  const tickets = await Promise.all([1, 2, 3].map(() => queue.acquire({})));
  assert.equal((await queue.status()).counts.running, 3);
  await Promise.all(tickets.map((ticket) => ticket.finish("completed")));
});

testCase("cancelling while waiting removes the request and records it", async () => {
  const queue = open();
  await queue.setLimit(1);
  const holder = await queue.acquire({});
  const controller = new AbortController();
  const waiting = queue.acquire({ host: "cancel-me" }, { signal: controller.signal });
  await sleep(80);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  const [cancelled] = await queue.list({ limit: 1, state: "cancelled" });
  assert.equal(cancelled.host, "cancel-me");
  assert.equal((await queue.status()).counts.waiting, 0);
  await holder.finish("completed");
});

testCase("a requester that stops renewing its lease frees its slot", async () => {
  const dying = createRequestQueue(connection(), { prefix: "piq:test", leaseMs: 300, heartbeatMs: 60_000 });
  const survivor = open();
  await survivor.setLimit(1);
  const lost = await dying.acquire({ host: "dead" });
  dying.close(); // disconnect without finishing, like a killed Pi process
  const ticket = await survivor.acquire({ host: "next" });
  assert.equal((await survivor.show(lost.id)).state, "abandoned");
  await ticket.finish("completed");
  assert.ok((await survivor.status()).counts.abandoned >= 1);
});

testCase("records and totals persist across a Redis restart", async () => {
  const queue = open();
  const before = await queue.list({ limit: 50 });
  const totals = (await queue.status()).counts;
  await queue.close();
  docker("restart", name);
  await waitForRedis();
  const reopened = open();
  assert.deepEqual(await reopened.list({ limit: 50 }), before);
  assert.deepEqual((await reopened.status()).counts, totals);
  assert.equal((await reopened.status()).limit, 1);
});

testCase("retention caps the number of stored records", async () => {
  const queue = open({ prefix: "piq:cap", maxRecords: 3 });
  for (let i = 0; i < 5; i++) await (await queue.acquire({ n: i })).finish("completed");
  assert.deepEqual((await queue.list({ limit: 10 })).map((row) => row.n), ["4", "3", "2"]);
});
