"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const HERMES_READINESS_SCHEMA_VERSION = 1;
const HERMES_READINESS_POLICY_VERSION = "hermes-readiness-v4";
const DEFAULT_HERMES_READINESS_POLICY = Object.freeze({
  promptTimeoutMs: 10_000,
  controllerTimeoutMs: 30_000,
  authProbeTimeoutMs: 30_000,
  curationProbeTimeoutMs: 60_000,
  curationTimeoutMs: 120_000,
  proofTtlMs: 60 * 60 * 1000,
  failureBackoffMs: 60 * 1000,
});
const OUTCOMES = new Set(["succeeded", "failed", "timed-out", "cancelled", "skipped"]);
const CATEGORIES = new Set(["ready", "authentication", "provider-model", "transport", "timeout", "cancelled", "missing-binary", "unavailable", "unexpected-response", "unknown"]);

function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex"); }
function clamp(value, fallback, min = 100, max = 15 * 60 * 1000) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback; }
function policyFromEnv(env = process.env, overrides = {}) {
  return {
    promptTimeoutMs: clamp(overrides.promptTimeoutMs || env.PI_HERMES_PROMPT_TIMEOUT_MS, DEFAULT_HERMES_READINESS_POLICY.promptTimeoutMs, 1000, 60_000),
    controllerTimeoutMs: clamp(overrides.controllerTimeoutMs || env.PI_HERMES_CONTROLLER_TIMEOUT_MS, DEFAULT_HERMES_READINESS_POLICY.controllerTimeoutMs, 1000, 60_000),
    authProbeTimeoutMs: clamp(overrides.authProbeTimeoutMs || env.PI_HERMES_AUTH_PROBE_TIMEOUT_MS, DEFAULT_HERMES_READINESS_POLICY.authProbeTimeoutMs, 1000, 60_000),
    curationProbeTimeoutMs: clamp(overrides.curationProbeTimeoutMs || env.PI_HERMES_CURATION_PROBE_TIMEOUT_MS, DEFAULT_HERMES_READINESS_POLICY.curationProbeTimeoutMs, 1000, 120_000),
    curationTimeoutMs: clamp(overrides.curationTimeoutMs || env.PI_HERMES_CURATION_TIMEOUT_MS, DEFAULT_HERMES_READINESS_POLICY.curationTimeoutMs, 1000, 5 * 60 * 1000),
    proofTtlMs: clamp(overrides.proofTtlMs || env.PI_HERMES_READINESS_TTL_MS, DEFAULT_HERMES_READINESS_POLICY.proofTtlMs, 1000, 24 * 60 * 60 * 1000),
    failureBackoffMs: clamp(overrides.failureBackoffMs || env.PI_HERMES_FAILURE_BACKOFF_MS, DEFAULT_HERMES_READINESS_POLICY.failureBackoffMs, 1000, 24 * 60 * 60 * 1000),
  };
}
function timeoutFor(kind, requested, policy = policyFromEnv()) {
  const field = { prompt: "promptTimeoutMs", advisory: "promptTimeoutMs", controller: "controllerTimeoutMs", auth: "authProbeTimeoutMs", "curation-probe": "curationProbeTimeoutMs", curation: "curationTimeoutMs" }[kind] || "promptTimeoutMs";
  const ceiling = policy[field];
  return clamp(requested, ceiling, 1000, ceiling);
}
function executableInfo(bin = "hermes", env = process.env) {
  const hasSep = String(bin).includes("/") || String(bin).includes("\\") || path.isAbsolute(String(bin));
  const candidates = hasSep ? [path.resolve(String(bin))] : String(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, String(bin)));
  for (const candidate of candidates) { try { fs.accessSync(candidate, fs.constants.X_OK); return { found: true, path: candidate }; } catch {} }
  return { found: false, path: null };
}
function identityFor(options = {}) {
  const executable = executableInfo(options.bin || process.env.PI_HERMES_BIN || "hermes", options.env || process.env);
  let binaryHash = null;
  try { binaryHash = sha256(fs.readFileSync(executable.path)); } catch {}
  const fields = {
    schemaVersion: HERMES_READINESS_SCHEMA_VERSION,
    policyVersion: HERMES_READINESS_POLICY_VERSION,
    binaryHash,
    providerHash: sha256(String(options.provider || "configured-default")).slice(0, 24),
    modelHash: sha256(String(options.model || "configured-default")).slice(0, 24),
  };
  const eligible = Boolean(executable.found && binaryHash);
  return { ...fields, eligible, executableFound: executable.found, identityKey: eligible ? sha256(fields).slice(0, 32) : null };
}
function stateFile(cwd) { return path.join(path.resolve(cwd || process.cwd()), ".pi", "hermes-advisory", "readiness.json"); }
function readState(cwd) { try { return JSON.parse(fs.readFileSync(stateFile(cwd), "utf8")); } catch { return { schemaVersion: HERMES_READINESS_SCHEMA_VERSION, policyVersion: HERMES_READINESS_POLICY_VERSION, identities: {} }; } }
function writeState(cwd, state) {
  const file = stateFile(cwd); const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(dir); if (directory.isSymbolicLink() || !directory.isDirectory()) return false;
  fs.chmodSync(dir, 0o700);
  try { const existing = fs.lstatSync(file); if (existing.isSymbolicLink() || !existing.isFile()) return false; } catch (error) { if (error?.code !== "ENOENT") return false; }
  const temp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`); fs.fchmodSync(fd, 0o600); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file); fs.chmodSync(file, 0o600); return true;
  } catch { try { fs.rmSync(temp, { force: true }); } catch {} return false; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}
function safeTime(value) { const ms = Date.parse(String(value || "")); return Number.isFinite(ms) ? ms : null; }
function readinessStatus(cwd, options = {}) {
  const now = options.now instanceof Date ? options.now.getTime() : Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const policy = policyFromEnv(options.env || process.env, options.policy);
  const identity = options.identity || identityFor(options);
  const row = identity.identityKey ? readState(cwd).identities?.[identity.identityKey] : null;
  const proofCurrent = (proof) => Boolean(proof?.outcome === "succeeded" && safeTime(proof.at) != null && now - safeTime(proof.at) <= policy.proofTtlMs && now >= safeTime(proof.at));
  const authReady = proofCurrent(row?.proofs?.auth);
  const curationReady = authReady && proofCurrent(row?.proofs?.curation);
  const retryAt = safeTime(row?.retryAfter);
  const backoffActive = retryAt != null && retryAt > now;
  const allowed = identity.executableFound && !backoffActive;
  return { schemaVersion: HERMES_READINESS_SCHEMA_VERSION, policyVersion: HERMES_READINESS_POLICY_VERSION, identityKey: identity.identityKey, identityEligible: identity.eligible, executableReady: identity.executableFound, authReady, curationReady, authProof: row?.proofs?.auth || null, curationProof: row?.proofs?.curation || null, allowed, backoffActive, retryAfter: backoffActive ? row.retryAfter : null, lastCategory: row?.lastCategory || null, policy };
}
function shouldAttempt(cwd, options = {}) { const status = readinessStatus(cwd, options); return { ...status, allowed: options.force === true ? status.executableReady : status.allowed, reason: !status.executableReady ? "missing-binary" : status.backoffActive && options.force !== true ? "backoff-active" : "ready" }; }
function recordOutcome(cwd, options = {}, result = {}) {
  const nowDate = options.at instanceof Date ? options.at : options.at ? new Date(options.at) : new Date();
  if (!Number.isFinite(nowDate.getTime())) return readinessStatus(cwd, options);
  const identity = options.identity || identityFor(options);
  if (!identity.identityKey) return readinessStatus(cwd, { ...options, identity });
  const policy = policyFromEnv(options.env || process.env, options.policy);
  const state = readState(cwd); const row = state.identities?.[identity.identityKey] || { identity, proofs: {}, events: [] };
  const operation = ["prompt", "advisory", "auth", "curation-probe", "curation"].includes(result.operation) ? result.operation : "advisory";
  const outcome = OUTCOMES.has(result.outcome) ? result.outcome : "failed";
  const category = CATEGORIES.has(result.category) ? result.category : outcome === "succeeded" ? "ready" : "unknown";
  const previousPromptOutcome = operation === "prompt"
    ? (row.events || []).find((prior) => prior.operation === "prompt" && ["succeeded", "failed", "timed-out"].includes(prior.outcome))
    : null;
  const firstPromptTimeout = operation === "prompt" && outcome === "timed-out" && !["failed", "timed-out"].includes(previousPromptOutcome?.outcome);
  const event = { at: nowDate.toISOString(), operation, outcome, category, durationMs: Number.isFinite(Number(result.durationMs)) ? Math.max(0, Math.round(Number(result.durationMs))) : 0 };
  row.events = [event, ...(row.events || [])].slice(0, 50);
  row.lastCategory = category;
  if (outcome === "succeeded") row.retryAfter = null;
  else if (["failed", "timed-out"].includes(outcome) && !firstPromptTimeout) row.retryAfter = new Date(nowDate.getTime() + policy.failureBackoffMs).toISOString();
  if (operation === "auth") row.proofs.auth = event;
  if (operation === "curation-probe") row.proofs.curation = event;
  state.schemaVersion = HERMES_READINESS_SCHEMA_VERSION; state.policyVersion = HERMES_READINESS_POLICY_VERSION;
  state.identities = { ...(state.identities || {}), [identity.identityKey]: row };
  const keys = Object.keys(state.identities); for (const key of keys.slice(0, Math.max(0, keys.length - 8))) delete state.identities[key];
  writeState(cwd, state);
  return readinessStatus(cwd, { ...options, identity, now: nowDate.getTime() });
}

module.exports = { HERMES_READINESS_SCHEMA_VERSION, HERMES_READINESS_POLICY_VERSION, DEFAULT_HERMES_READINESS_POLICY, policyFromEnv, timeoutFor, executableInfo, identityFor, stateFile, readState, readinessStatus, shouldAttempt, recordOutcome };
