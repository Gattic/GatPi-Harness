"use strict";

// A Redis-backed waiting line for model requests. There is no consumer process:
// each requester enqueues itself, waits until it is within the shared concurrency
// limit, sends its own model request, then records the outcome. Leases free the
// slot of a requester that dies without finishing.
const Redis = require("ioredis");
const { setTimeout: sleep } = require("node:timers/promises");

const STATES = ["waiting", "running", "completed", "failed", "cancelled", "abandoned"];
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

// Every script receives ARGV[1]=key base and ARGV[2]=record retention in seconds.
// Server time keeps leases consistent across machines with different clocks.
const prelude = `
local p = ARGV[1]
local retention = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local function reap()
  for _, id in ipairs(redis.call('ZRANGEBYSCORE', p .. ':lease', '-inf', now)) do
    local h = p .. ':req:' .. id
    redis.call('ZREM', p .. ':lease', id)
    redis.call('ZREM', p .. ':waiting', id)
    redis.call('ZREM', p .. ':running', id)
    local state = redis.call('HGET', h, 'state')
    if state == 'waiting' or state == 'running' then
      redis.call('HSET', h, 'state', 'abandoned', 'finishedAt', now, 'error', 'Requester stopped renewing its queue lease')
      redis.call('EXPIRE', h, retention)
      redis.call('HINCRBY', p .. ':counts', 'abandoned', 1)
    end
  end
end
local function setPairs(h, first)
  for i = first, #ARGV, 2 do
    if ARGV[i + 1] ~= '' then redis.call('HSET', h, ARGV[i], ARGV[i + 1]) end
  end
end
`;

const scripts = {
  // ARGV[3]=lease ms, ARGV[4..]=field/value pairs
  pqEnqueue: `${prelude}
reap()
local seq = redis.call('INCR', p .. ':seq')
local id = 'r' .. seq
local h = p .. ':req:' .. id
redis.call('HSET', h, 'id', id, 'seq', seq, 'state', 'waiting', 'enqueuedAt', now)
setPairs(h, 4)
redis.call('ZADD', p .. ':waiting', seq, id)
redis.call('ZADD', p .. ':lease', now + tonumber(ARGV[3]), id)
redis.call('ZADD', p .. ':all', seq, id)
return id`,
  // ARGV[3]=id, ARGV[4]=lease ms, ARGV[5]=default limit. Returns {state, position}.
  pqAcquire: `${prelude}
reap()
local id = ARGV[3]
local h = p .. ':req:' .. id
local state = redis.call('HGET', h, 'state')
local rank = redis.call('ZRANK', p .. ':waiting', id)
if state ~= 'waiting' or not rank then return {state or 'missing', 0} end
redis.call('ZADD', p .. ':lease', 'XX', now + tonumber(ARGV[4]), id)
local limit = tonumber(redis.call('GET', p .. ':limit') or ARGV[5])
if rank < limit - redis.call('ZCARD', p .. ':running') then
  redis.call('ZREM', p .. ':waiting', id)
  redis.call('ZADD', p .. ':running', now, id)
  redis.call('HSET', h, 'state', 'running', 'startedAt', now, 'waitMs', now - tonumber(redis.call('HGET', h, 'enqueuedAt')))
  return {'running', 0}
end
return {'waiting', rank + 1}`,
  // ARGV[3]=id, ARGV[4]=lease ms
  pqHeartbeat: `${prelude}
reap()
redis.call('ZADD', p .. ':lease', 'XX', now + tonumber(ARGV[4]), ARGV[3])
return redis.call('HGET', p .. ':req:' .. ARGV[3], 'state') or 'missing'`,
  // ARGV[3]=id, ARGV[4]=final state, ARGV[5]=max records, ARGV[6..]=field/value pairs
  pqFinish: `${prelude}
local id = ARGV[3]
local h = p .. ':req:' .. id
local prior = redis.call('HGET', h, 'state')
if prior ~= 'waiting' and prior ~= 'running' and prior ~= 'abandoned' then return 0 end
redis.call('ZREM', p .. ':lease', id)
redis.call('ZREM', p .. ':waiting', id)
redis.call('ZREM', p .. ':running', id)
redis.call('HDEL', h, 'error')
redis.call('HSET', h, 'state', ARGV[4], 'finishedAt', now)
local started = redis.call('HGET', h, 'startedAt')
if started then redis.call('HSET', h, 'runMs', now - tonumber(started)) end
setPairs(h, 6)
if prior == 'abandoned' then redis.call('HINCRBY', p .. ':counts', 'abandoned', -1) end
redis.call('HINCRBY', p .. ':counts', ARGV[4], 1)
redis.call('EXPIRE', h, retention)
local excess = redis.call('ZCARD', p .. ':all') - tonumber(ARGV[5])
if excess > 0 then
  for _, old in ipairs(redis.call('ZRANGE', p .. ':all', 0, excess - 1)) do
    local s = redis.call('HGET', p .. ':req:' .. old, 'state')
    if s ~= 'waiting' and s ~= 'running' then
      redis.call('ZREM', p .. ':all', old)
      redis.call('DEL', p .. ':req:' .. old)
    end
  end
end
return 1`,
  // ARGV[3]=default limit. Returns {limit, running ids, waiting ids, counts}.
  pqStatus: `${prelude}
reap()
return {redis.call('GET', p .. ':limit') or ARGV[3], redis.call('ZRANGE', p .. ':running', 0, -1),
  redis.call('ZRANGE', p .. ':waiting', 0, -1), redis.call('HGETALL', p .. ':counts')}`,
};

const numeric = new Set(["seq", "enqueuedAt", "startedAt", "finishedAt", "waitMs", "runMs", "pid", "inputTokens", "outputTokens", "totalTokens"]);
function record(hash) {
  if (!hash || !hash.id) return null;
  const out = {};
  for (const [key, value] of Object.entries(hash)) out[key] = numeric.has(key) ? Number(value) : value;
  for (const key of ["enqueuedAt", "startedAt", "finishedAt"]) if (out[key]) out[key] = new Date(out[key]).toISOString();
  return out;
}

function pairs(fields) {
  const out = [];
  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined || value === null) continue;
    out.push(key, String(value).slice(0, 500));
  }
  return out;
}

function abortError() {
  return Object.assign(new Error("Queued model request was cancelled"), { name: "AbortError" });
}

function createRequestQueue(redisOptions, options = {}) {
  const base = `${options.prefix || "piq"}:rq`;
  const leaseMs = options.leaseMs ?? 30_000;
  const heartbeatMs = options.heartbeatMs ?? 5_000;
  const pollMs = options.pollMs ?? 250;
  const retention = Math.round((options.retentionDays ?? 30) * 86400);
  const maxRecords = options.maxRecords ?? 10_000;
  const defaultLimit = options.defaultLimit ?? 4;
  const redis = new Redis({ maxRetriesPerRequest: 1, connectTimeout: 5_000, ...redisOptions });
  // Command promises carry connection failures to callers; without a listener
  // ioredis would also print every reconnect error to the terminal.
  redis.on("error", () => {});
  for (const [name, lua] of Object.entries(scripts)) redis.defineCommand(name, { numberOfKeys: 0, lua });

  const finishRequest = (id, state, fields) => {
    if (!TERMINAL.has(state)) throw new Error(`Invalid final request state ${state}`);
    return redis.pqFinish(base, retention, id, state, maxRecords, ...pairs(fields));
  };

  async function acquire(meta, { signal, onWaiting } = {}) {
    if (signal?.aborted) throw abortError();
    const id = await redis.pqEnqueue(base, retention, leaseMs, ...pairs(meta));
    try {
      let reported;
      for (;;) {
        if (signal?.aborted) throw abortError();
        const [state, position] = await redis.pqAcquire(base, retention, id, leaseMs, defaultLimit);
        if (state === "running") break;
        if (state !== "waiting") throw new Error(`Queued model request ${id} is ${state}`);
        if (position !== reported) onWaiting?.({ id, position: (reported = position) });
        await sleep(pollMs, undefined, { signal }).catch(() => {});
      }
    } catch (error) {
      const state = error.name === "AbortError" ? "cancelled" : "failed";
      await finishRequest(id, state, { error: error.message }).catch(() => {});
      throw error;
    }
    const heartbeat = setInterval(() => { redis.pqHeartbeat(base, retention, id, leaseMs).catch(() => {}); }, heartbeatMs);
    heartbeat.unref();
    let finished = false;
    return {
      id,
      async finish(state, fields) {
        if (finished) return;
        finished = true;
        clearInterval(heartbeat);
        await finishRequest(id, state, fields);
      },
    };
  }

  async function hashes(ids) {
    if (!ids.length) return [];
    const pipeline = redis.pipeline();
    for (const id of ids) pipeline.hgetall(`${base}:req:${id}`);
    return (await pipeline.exec()).map(([error, hash]) => (error ? null : record(hash)));
  }

  async function status() {
    const [limit, running, waiting, counts] = await redis.pqStatus(base, retention, defaultLimit);
    const totals = Object.fromEntries(STATES.filter((state) => !["waiting", "running"].includes(state)).map((state) => [state, 0]));
    for (let i = 0; i < counts.length; i += 2) totals[counts[i]] = Number(counts[i + 1]);
    return {
      limit: Number(limit),
      running: (await hashes(running.slice(0, 100))).filter(Boolean),
      waiting: (await hashes(waiting.slice(0, 100))).filter(Boolean).map((entry, index) => ({ position: index + 1, ...entry })),
      counts: { running: running.length, waiting: waiting.length, ...totals },
    };
  }

  async function list({ limit = 20, state } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("List limit must be 1..500");
    if (state !== undefined && !STATES.includes(state)) throw new Error(`State must be one of ${STATES.join(", ")}`);
    const ids = await redis.zrevrange(`${base}:all`, 0, state ? 1999 : limit - 1);
    const rows = await hashes(ids);
    const expired = ids.filter((_, index) => !rows[index]);
    if (expired.length) await redis.zrem(`${base}:all`, ...expired);
    return rows.filter((row) => row && (!state || row.state === state)).slice(0, limit);
  }

  async function show(id) {
    if (typeof id !== "string" || !/^r[0-9]{1,15}$/.test(id)) throw new Error("Request IDs look like r123");
    return record(await redis.hgetall(`${base}:req:${id}`));
  }

  async function setLimit(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("Concurrency limit must be an integer 1..64");
    await redis.set(`${base}:limit`, String(limit));
    return limit;
  }

  return { acquire, status, list, show, setLimit, close: () => redis.quit().catch(() => redis.disconnect()) };
}

module.exports = { createRequestQueue, STATES };
