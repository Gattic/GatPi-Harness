#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { createTypeSafeClient, DEFAULT_MODEL } = require("../src/typesafe-client.js");

const KEY = "ts-test-key-0123456789abcdef";
const QUESTIONS = {
  urgent: { type: "noul", instructions: "Is this urgent?" },
  team: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", technical: "Bugs" } },
};
const GOOD_ANSWERS = {
  urgent: { type: "noul", noul: 0.9 },
  team: { type: "choice", choice: "technical", probabilities: { billing: 0.2, technical: 0.8 }, confidence: 0.6 },
};

async function withServer(handler, fn) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
const json = (res, status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof value === "string" ? value : JSON.stringify(value)); };
const client = (baseUrl, extra = {}) => createTypeSafeClient({ env: {}, apiKey: KEY, baseUrl, ...extra });
const noKey = (value) => assert.equal(JSON.stringify(value).includes(KEY), false, "API key must never appear in results");

(async () => {
  await withServer((_req, res) => json(res, 200, { model: "jev-1.13.0", answers: GOOD_ANSWERS, usage: { input_tokens: 321, output_tokens: 20 } }), async (baseUrl, requests) => {
    const result = await client(baseUrl).systemOne({ state: { request: "hello" }, questions: QUESTIONS });
    assert.equal(result.ok, true);
    assert.equal(result.model, "jev-1.13.0");
    assert.equal(result.inputTokens, 321);
    assert.equal(result.answers.team.choice, "technical");
    assert.equal(requests[0].url, "/v1/systemone");
    assert.equal(requests[0].authorization, `Bearer ${KEY}`);
    assert.equal(requests[0].body.model, DEFAULT_MODEL, "requests pin the versioned default model");
    assert.deepEqual(requests[0].body.state, { request: "hello" });
    noKey(result);
  });

  for (const [status, reason] of [[401, "unauthorized"], [422, "invalid-request"], [429, "rate-limited"], [529, "overloaded"], [500, "http-error"]]) {
    await withServer((_req, res) => json(res, status, { detail: `echo ${KEY} state=secret prompt` }), async (baseUrl) => {
      const result = await client(baseUrl).systemOne({ state: "x", questions: QUESTIONS });
      assert.deepEqual({ ok: result.ok, reason: result.reason, status: result.status }, { ok: false, reason, status });
      assert.equal(JSON.stringify(result).includes("secret prompt"), false, "response bodies never leak into failures");
      noKey(result);
    });
  }

  for (const body of ["not json", { model: "jev-1.13.0" }, { model: "jev-1.13.0", answers: { urgent: GOOD_ANSWERS.urgent } }, { model: "jev-1.13.0", answers: { ...GOOD_ANSWERS, urgent: { type: "choice", choice: "x" } } }, { model: "jev-1.13.0", answers: { ...GOOD_ANSWERS, team: { ...GOOD_ANSWERS.team, choice: "sales" } } }]) {
    await withServer((_req, res) => json(res, 200, body), async (baseUrl) => {
      const result = await client(baseUrl).systemOne({ state: "x", questions: QUESTIONS });
      assert.equal(result.reason, "malformed-response", `malformed body ${JSON.stringify(body)}`);
    });
  }

  await withServer((_req, res) => setTimeout(() => json(res, 200, { model: "jev-1.13.0", answers: GOOD_ANSWERS }), 400), async (baseUrl) => {
    const result = await client(baseUrl, { timeoutMs: 50 }).systemOne({ state: "x", questions: QUESTIONS });
    assert.equal(result.reason, "timeout");
    const controller = new AbortController();
    const pending = client(baseUrl).systemOne({ state: "x", questions: QUESTIONS, signal: controller.signal });
    controller.abort();
    assert.equal((await pending).reason, "aborted");
  });

  const closed = await withServer(() => {}, async (baseUrl) => baseUrl);
  assert.equal((await client(closed).systemOne({ state: "x", questions: QUESTIONS })).reason, "network-error");

  let called = false;
  const missing = await createTypeSafeClient({ env: {}, fetchImpl: () => { called = true; } }).systemOne({ state: "x", questions: QUESTIONS });
  assert.deepEqual({ ok: missing.ok, reason: missing.reason }, { ok: false, reason: "missing-key" });
  assert.equal(called, false, "no request is attempted without a key");
  assert.equal(createTypeSafeClient({ env: { TYPESAFE_API_KEY: KEY } }).keyPresent, true);
  await assert.rejects(() => client("http://127.0.0.1:9").systemOne({ state: "x", questions: {} }), TypeError, "empty question maps are programmer errors");
  await assert.rejects(() => client("http://127.0.0.1:9").systemOne({ state: "x", questions: { a: { type: "free-text", instructions: "x" } } }), TypeError);

  await withServer((_req, res) => json(res, 200, { models: [{ name: "jev-latest", description: "d", release_date: "2026-09-01" }] }), async (baseUrl, requests) => {
    const result = await client(baseUrl).listModels();
    assert.deepEqual({ ok: result.ok, models: result.models }, { ok: true, models: ["jev-latest"] });
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].url, "/v1/models");
  });
  await withServer((_req, res) => json(res, 401, {}), async (baseUrl) => {
    assert.equal((await client(baseUrl).listModels()).reason, "unauthorized");
  });

  console.log("typesafe client tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
