"use strict";

// Single HTTP client for TypeSafe's System One API (POST /v1/systemone,
// GET /v1/models). Expected failures return { ok: false, reason } with a fixed
// reason code; callers treat them as absence. The API key, request payload, and
// response bodies never appear in returned values or errors.

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-1.13.0";
// TypeSafe's own SDK default per-request timeout (typesafe-sdk-js retry.ts).
// It detects a failed request, not a slow one: Jev gets as long as it needs.
// A bound is still required because Pi cannot cancel a turn that is waiting
// for the judgment before the agent starts.
const REQUEST_TIMEOUT_MS = 10_000;
const QUESTION_TYPES = new Set(["noul", "choice", "score"]);
const STATUS_REASONS = Object.freeze({ 401: "unauthorized", 422: "invalid-request", 429: "rate-limited", 529: "overloaded" });

function failureReason(error, externalSignal) {
  if (externalSignal?.aborted) return "aborted";
  if (error?.name === "TimeoutError") return "timeout";
  if (error?.name === "AbortError") return "aborted";
  return "network-error";
}

function validAnswer(question, answer) {
  if (!answer || answer.type !== question.type) return false;
  if (question.type === "noul") return Number.isFinite(answer.noul);
  const distribution = answer.probabilities && typeof answer.probabilities === "object" && Object.values(answer.probabilities).every(Number.isFinite);
  if (!distribution || !Number.isFinite(answer.confidence)) return false;
  if (question.type === "choice") return typeof answer.choice === "string" && Object.hasOwn(answer.probabilities, answer.choice);
  return Number.isFinite(answer.score);
}

function validateQuestions(questions) {
  const entries = Object.entries(questions || {});
  if (!entries.length) throw new TypeError("systemOne requires at least one question");
  for (const [id, question] of entries) {
    if (!QUESTION_TYPES.has(question?.type)) throw new TypeError(`question ${id} has unsupported type`);
    if (question.instructions == null || question.instructions === "") throw new TypeError(`question ${id} requires instructions`);
  }
  return entries;
}

function createTypeSafeClient(options = {}) {
  const env = options.env || process.env;
  const apiKey = options.apiKey ?? env.TYPESAFE_API_KEY ?? "";
  const baseUrl = String(options.baseUrl || env.TYPESAFE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = String(options.model || DEFAULT_MODEL);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const clock = options.clock || Date.now;

  async function request(path, init, signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(init.headers || {}) },
      signal: combined,
    });
    if (!response.ok) return { status: response.status, reason: STATUS_REASONS[response.status] || "http-error" };
    try { return { status: response.status, body: await response.json() }; }
    catch (error) {
      if (combined.aborted) throw error;
      return { status: response.status, reason: "malformed-response" };
    }
  }

  async function systemOne({ state, questions, model: requestModel, signal } = {}) {
    const entries = validateQuestions(questions);
    if (!apiKey) return { ok: false, reason: "missing-key", latencyMs: 0 };
    const started = clock();
    try {
      const result = await request("/v1/systemone", { method: "POST", body: JSON.stringify({ state, model: requestModel || model, questions }) }, signal);
      const latencyMs = clock() - started;
      if (result.reason) return { ok: false, reason: result.reason, status: result.status, latencyMs };
      const body = result.body;
      const answers = body?.answers;
      if (typeof body?.model !== "string" || !answers || typeof answers !== "object" || !entries.every(([id, question]) => validAnswer(question, answers[id]))) {
        return { ok: false, reason: "malformed-response", status: result.status, latencyMs };
      }
      return { ok: true, model: body.model, answers, inputTokens: Number(body.usage?.input_tokens) || 0, latencyMs };
    } catch (error) {
      return { ok: false, reason: failureReason(error, signal), latencyMs: clock() - started };
    }
  }

  async function listModels({ signal } = {}) {
    if (!apiKey) return { ok: false, reason: "missing-key", latencyMs: 0 };
    const started = clock();
    try {
      const result = await request("/v1/models", { method: "GET" }, signal);
      const latencyMs = clock() - started;
      if (result.reason) return { ok: false, reason: result.reason, status: result.status, latencyMs };
      const rows = Array.isArray(result.body?.models) ? result.body.models : null;
      if (!rows || !rows.every((row) => typeof row?.name === "string")) return { ok: false, reason: "malformed-response", status: result.status, latencyMs };
      return { ok: true, models: rows.map((row) => row.name), latencyMs };
    } catch (error) {
      return { ok: false, reason: failureReason(error, signal), latencyMs: clock() - started };
    }
  }

  return { keyPresent: Boolean(apiKey), baseUrl, model, timeoutMs, systemOne, listModels };
}

module.exports = { DEFAULT_BASE_URL, DEFAULT_MODEL, REQUEST_TIMEOUT_MS, createTypeSafeClient };
