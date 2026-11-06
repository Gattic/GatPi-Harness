"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const hermesClient = require("./hermes-client.js");
const hermesReadiness = require("./hermes-readiness.js");
const { scanMemoryContent } = require("./memory-content-scanner.js");
const { FileIntegrationStorage } = require("./file-integration-storage.js");

const HERMES_ADVISORY_SCHEMA_VERSION = 1;
const HERMES_ADVISORY_VERSION = "hermes-advisory-2026-09-06.1";
const OPERATIONS = new Set(["plan", "review", "decide", "summarizeEvidence", "promptSuggestion", "curateCandidate", "draftSkillCandidate"]);
const JSON_OPERATIONS = new Set(["plan", "review", "decide", "summarizeEvidence", "curateCandidate", "draftSkillCandidate"]);

function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function cleanId(value, fallback = null) { const text = String(value || "").trim(); return /^[A-Za-z0-9_.:@+-]{1,200}$/.test(text) ? text : fallback; }
function cleanText(value, max = 4000) { const text = String(value || "").normalize("NFC").replace(/\u0000/g, "").trim(); return text.length > max ? text.slice(0, max) : text; }
function uniq(values, limit = 64) { return [...new Set((values || []).map((value) => cleanText(value, 240)).filter(Boolean))].slice(0, limit); }
function percentile(values, p) { const xs = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b); if (!xs.length) return null; return xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(xs.length * p) - 1))]; }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function errorWith(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }
function packetPrivacyViolations(value, at = "packet", rows = []) {
  if (Array.isArray(value)) { value.forEach((item, index) => packetPrivacyViolations(item, `${at}[${index}]`, rows)); return rows; }
  if (value && typeof value === "object") { for (const [key, item] of Object.entries(value)) { if (/^(?:transcript|messages|privateReasoning|reasoning|rawToolOutput|toolOutput|command|commandArgs|arguments|args|absolutePath)$/i.test(key)) rows.push({ path: `${at}.${key}`, reason: "forbidden-provider-field" }); packetPrivacyViolations(item, `${at}.${key}`, rows); } return rows; }
  if (typeof value === "string" && /(?:^|\n)\s*(?:\$\s*)?(?:sudo|git|npm|pnpm|yarn|node|python\d*|bash|sh|rm|cp|mv|curl|wget|chmod|chown)\s+(?:--?\S+|[^\s]+\s+--?\S+)/i.test(value)) rows.push({ path: at, reason: "command-arguments" });
  return rows;
}

function extractJsonObject(text) {
  const source = String(text || "");
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0; let quoted = false; let escaped = false;
    for (let index = start; index < source.length; index++) {
      const char = source[index];
      if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try { return JSON.parse(source.slice(start, index + 1)); } catch { break; }
      }
    }
  }
  throw errorWith("HERMES_ADVISORY_INVALID_JSON", "Hermes advisory response did not contain one valid JSON object");
}

function requireObject(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw errorWith("HERMES_ADVISORY_SCHEMA", `${label} must be an object`); return value; }
function stringArray(value, label, { min = 0, max = 32, itemMax = 1000 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw errorWith("HERMES_ADVISORY_SCHEMA", `${label} must contain ${min}-${max} items`);
  return value.map((item) => { if (typeof item !== "string" || !item.trim()) throw errorWith("HERMES_ADVISORY_SCHEMA", `${label} items must be non-empty strings`); return cleanText(item, itemMax); });
}
function validatePlan(value) {
  const row = requireObject(value, "plan");
  if (Number(row.schemaVersion) !== 1) throw errorWith("HERMES_ADVISORY_SCHEMA", "plan schemaVersion must be 1");
  if (!Array.isArray(row.steps) || !row.steps.length || row.steps.length > 20) throw errorWith("HERMES_ADVISORY_SCHEMA", "plan steps must contain 1-20 items");
  const steps = row.steps.map((step, index) => { requireObject(step, `plan step ${index + 1}`); return { id: cleanId(step.id, `step-${index + 1}`), action: cleanText(step.action, 1200), evidenceNeeded: uniq(step.evidenceNeeded, 16) }; });
  if (steps.some((step) => !step.action)) throw errorWith("HERMES_ADVISORY_SCHEMA", "every plan step requires an action");
  return { schemaVersion: 1, summary: cleanText(row.summary, 2000), steps, risks: stringArray(row.risks || [], "plan risks", { max: 20 }), completionEvidence: stringArray(row.completionEvidence || [], "completion evidence", { max: 20 }) };
}
function validateReview(value) {
  const row = requireObject(value, "review");
  if (Number(row.schemaVersion) !== 1 || !["pass", "concerns", "blocked"].includes(row.verdict)) throw errorWith("HERMES_ADVISORY_SCHEMA", "review requires schemaVersion 1 and verdict pass|concerns|blocked");
  return { schemaVersion: 1, verdict: row.verdict, summary: cleanText(row.summary, 2000), findings: stringArray(row.findings || [], "review findings", { max: 32 }), evidenceGaps: stringArray(row.evidenceGaps || [], "evidence gaps", { max: 32 }), nextActions: stringArray(row.nextActions || [], "review next actions", { max: 20 }) };
}
function validateEvidenceSummary(value) {
  const row = requireObject(value, "evidence summary");
  if (Number(row.schemaVersion) !== 1) throw errorWith("HERMES_ADVISORY_SCHEMA", "evidence summary schemaVersion must be 1");
  return { schemaVersion: 1, summary: cleanText(row.summary, 2400), supported: stringArray(row.supported || [], "supported claims", { max: 32 }), unsupported: stringArray(row.unsupported || [], "unsupported claims", { max: 32 }), nextActions: stringArray(row.nextActions || [], "evidence next actions", { max: 20 }) };
}
function validatePromptSuggestionPacket(value) {
  const row = requireObject(value, "prompt suggestion input");
  const allowed = new Set(["publicRecentContext", "skillContext"]);
  const extra = Object.keys(row).filter((key) => !allowed.has(key));
  if (extra.length) throw errorWith("HERMES_ADVISORY_SCHEMA", `prompt suggestion input has unsupported fields: ${extra.join(",")}`);
  const bounded = (field, max) => {
    const input = row[field];
    if (input == null) return null;
    if (typeof input !== "string" || !input.trim() || input.length > max) throw errorWith("HERMES_ADVISORY_SCHEMA", `${field} must be null or a non-empty string of at most ${max} characters`);
    return cleanText(input, max);
  };
  return {
    publicRecentContext: bounded("publicRecentContext", 12000),
    skillContext: bounded("skillContext", 800),
  };
}

function normalizeMemoryKind(value) { return ["current", "decision", "constraint", "risk", "verification", "procedure", "history"].includes(value) ? value : null; }
function validateCuration(value, input = {}) {
  const row = requireObject(value, "curation");
  if (Number(row.schemaVersion) !== 1 || !Array.isArray(row.candidates) || row.candidates.length > 8) throw errorWith("HERMES_ADVISORY_SCHEMA", "curation requires schemaVersion 1 and at most 8 candidates");
  const allowedHashes = new Set((input.sources || []).map((source) => source.contentHash));
  const candidates = row.candidates.map((candidate, index) => {
    requireObject(candidate, `curation candidate ${index + 1}`);
    const kind = normalizeMemoryKind(candidate.kind);
    if (!kind) throw errorWith("HERMES_ADVISORY_SCHEMA", `curation candidate ${index + 1} has an invalid kind`);
    const sourceHashes = uniq(candidate.sourceHashes, 64).filter((hash) => allowedHashes.has(hash));
    const confidence = Number(candidate.confidence);
    return { kind, title: cleanText(candidate.title, 160), content: cleanText(candidate.content, 2400), verification: "unverified", sourceHashes, evidenceIds: uniq(candidate.evidenceIds, 64), confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5, expiresAt: /^\d{4}-\d{2}-\d{2}T/.test(String(candidate.expiresAt || "")) ? String(candidate.expiresAt).slice(0, 40) : null, conflicts: stringArray(candidate.conflicts || [], "candidate conflicts", { max: 16, itemMax: 500 }) };
  });
  if (candidates.some((candidate) => !candidate.title || !candidate.content || !candidate.sourceHashes.length)) throw errorWith("HERMES_ADVISORY_SCHEMA", "every curation candidate requires title, content, and an allowed source hash");
  return { schemaVersion: 1, projectKey: cleanId(input.projectKey, "unknown"), candidates };
}
function validateSkillDraft(value) {
  const row = requireObject(value, "skill draft");
  if (Number(row.schemaVersion) !== 1) throw errorWith("HERMES_ADVISORY_SCHEMA", "skill draft schemaVersion must be 1");
  const name = String(row.name || "").trim();
  const description = String(row.description || "").trim();
  const skillMarkdown = String(row.skillMarkdown || "").normalize("NFC").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw errorWith("HERMES_ADVISORY_SCHEMA", "skill name must be 1-64 lowercase letters/numbers/hyphens");
  if (!description || description.length > 1024) throw errorWith("HERMES_ADVISORY_SCHEMA", "skill description must be 1-1024 characters");
  if (!skillMarkdown || skillMarkdown.length > 20_000) throw errorWith("HERMES_ADVISORY_SCHEMA", "skillMarkdown must be 1-20000 characters");
  const frontmatter = skillMarkdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter || !new RegExp(`(?:^|\\n)name:\\s*["']?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*(?:\\n|$)`).test(frontmatter[1]) || !/(?:^|\n)description:\s*.+(?:\n|$)/.test(frontmatter[1])) throw errorWith("HERMES_ADVISORY_SCHEMA", "skillMarkdown requires matching name and description frontmatter");
  if (/\]\((?:\/|[A-Za-z]:\\|\.\.\/)/.test(skillMarkdown)) throw errorWith("HERMES_ADVISORY_SCHEMA", "skillMarkdown links must remain relative to the skill directory");
  return { schemaVersion: 1, name, description, skillMarkdown: `${skillMarkdown}\n`, files: [] };
}

const RENDERERS = {
  plan: (packet) => `You are Hermes acting as a read-only planning advisor inside Pi. Return one JSON object only with schemaVersion:1, summary, steps:[{id,action,evidenceNeeded:[]}], risks:[], completionEvidence:[]. Do not claim completion, request mutation, or include private reasoning.\n\n<public-task-packet>\n${JSON.stringify(packet)}\n</public-task-packet>`,
  review: (packet) => `You are Hermes acting as a read-only evidence reviewer inside Pi. Return one JSON object only with schemaVersion:1, verdict:"pass"|"concerns"|"blocked", summary, findings:[], evidenceGaps:[], nextActions:[]. Accept only claims supported by the supplied public evidence references.\n\n<public-review-packet>\n${JSON.stringify(packet)}\n</public-review-packet>`,
  decide: (packet) => `You are Hermes acting as a typed goal controller. Return one strict goal-decision schema-v3 JSON object only with exactly: schemaVersion, status, action, reasonCode, requiresUserInput, completionEvidenceIds. A running decision requires exactly one action: run_topology {kind,topologyId,inputRef,prompt}, run_verifier {kind,profile,inputRef,prompt}, inspect {kind,targetKind,targetRef,prompt}, or ask_user {kind,question}. For every executable action, write a complete prompt yourself in action.prompt; Pi will execute that prompt verbatim, so do not use placeholders or rely on harness-generated instructions. The prompt must match only the declared typed intent. For run_topology and run_verifier, action.inputRef must exactly equal packet.goalId. The packet executionContext identifies the target current project and all actions execute from that workspace. Do not ask the user for the repository path, current engine/version, or other local facts that an inspect or approved topology action can determine. Use ask_user only for a missing user preference or authorization that no allowed action can resolve. Terminal blocked or failed decisions require a concrete blocker in recentActions that leaves no allowed action able to advance the goal. Uncertainty, incomplete work, open investigations, warnings, resource or thermal observations, and existing implementation state are not blockers; inspect or act instead. Terminal states require action:null. Completed requires supplied current completion evidence IDs. Never invent evidence or request unapproved mutation.\n\n<public-goal-packet>\n${JSON.stringify(packet)}\n</public-goal-packet>`,
  summarizeEvidence: (packet) => `You are Hermes summarizing bounded public evidence references. Return one JSON object only with schemaVersion:1, summary, supported:[], unsupported:[], nextActions:[]. Do not infer missing evidence.\n\n<public-evidence-packet>\n${JSON.stringify(packet)}\n</public-evidence-packet>`,
  promptSuggestion: (packet) => `You are suggesting the user's next prompt in a command-line coding assistant. Return ONLY one concise, complete prompt for the best next step. It may be multiple lines when a structured prompt is genuinely more useful. Do not quote it. Aim for at most 240 characters, but always finish the prompt and never end it with an ellipsis. If there is no useful next step, return an empty string.\n\nRecent chat context:\n${packet.publicRecentContext || "(none)"}${packet.skillContext ? `\n\n${packet.skillContext}` : ""}`,
  curateCandidate: (packet) => `You are Hermes drafting unverified project-memory candidates from scanner-approved source extracts. Return one JSON object only with schemaVersion:1 and candidates:[{kind,title,content,sourceHashes,evidenceIds,confidence,expiresAt,conflicts}]. Kinds: current,decision,constraint,risk,verification,procedure,history. Every candidate must cite supplied source hashes. Do not include source bodies, paths, prompts, commands, secrets, or unsupported claims.\n\n<public-curation-packet>\n${JSON.stringify(packet)}\n</public-curation-packet>`,
  draftSkillCandidate: (packet) => `You are Hermes drafting a quarantined Agent Skills candidate from repeated verified public execution captures. Return one JSON object only with schemaVersion:1, name, description, skillMarkdown, files:[]. The markdown must have matching name/description frontmatter, a narrow trigger boundary, workflow, verification, failure handling, and only relative references. Do not add dependencies, publishing, installation, mutation authority, or unsupported steps.\n\n<public-skill-packet>\n${JSON.stringify(packet)}\n</public-skill-packet>`,
};

function categoryForError(error) {
  const text = `${String(error?.message || error || "")} ${String(error?.stderr || "")}`.toLowerCase();
  if (/auth|credential|401|403|login/.test(text)) return "authentication";
  if (/timeout|timed out|deadline/.test(text)) return "timeout";
  if (/abort|cancel/.test(text)) return "cancelled";
  if (/provider|model.*(?:not found|missing|unavailable|invalid)/.test(text)) return "provider-model";
  if (/enoent|not found|executable/.test(text)) return "missing-binary";
  if (/network|socket|transport|econn|dns/.test(text)) return "transport";
  if (/schema|json|unexpected response/.test(text)) return "unexpected-response";
  if (/unsafe|privacy|forbidden/.test(text)) return "privacy";
  return "unknown";
}

class HermesAdvisoryAdapter {
  constructor({ enabled, cwd = process.cwd(), storage = null, prefix = "", trace = null, run = hermesClient.runHermes, readiness = hermesReadiness, env = process.env, bin, provider, model, policy, sourceVersion = HERMES_ADVISORY_VERSION, authority = {} } = {}) {
    this.enabled = enabled === undefined ? !["0", "false", "off", "disabled"].includes(String(env.PI_HERMES_ADVISORY || "1").toLowerCase()) : enabled !== false; this.cwd = path.resolve(cwd || process.cwd()); this.storage = storage; this.storageRoot = path.join(this.cwd, ".pi", "hermes-advisory"); this.prefix = String(prefix || "").replace(/\/$/, ""); this.trace = trace; this.run = run; this.readiness = readiness; this.env = env; this.bin = bin || env.PI_HERMES_BIN || "hermes"; this.provider = provider || env.PI_HERMES_PROVIDER || ""; this.model = model || env.PI_HERMES_MODEL || ""; this.policy = readiness.policyFromEnv(env, policy || {}); this.sourceVersion = sourceVersion; this.authority = { advisoryDraftAllowed: authority.advisoryDraftAllowed !== false, canonicalPromotionAllowed: authority.canonicalPromotionAllowed === true, automaticMutationAllowed: authority.automaticMutationAllowed === true };
  }
  key(name) { return this.prefix ? `${this.prefix}/${name}` : name; }
  writableStorage() { if (!this.storage) this.storage = new FileIntegrationStorage(this.storageRoot); return this.storage; }
  events({ limit = 1000 } = {}) { let rows = this.storage?.readJsonl?.(this.key("events")); if (!rows) { try { rows = fs.readFileSync(path.join(this.storageRoot, "events.jsonl"), "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)); } catch { rows = []; } } return rows.slice(-Math.max(0, Number(limit) || 0)); }
  record(event = {}) {
    const row = { schemaVersion: HERMES_ADVISORY_SCHEMA_VERSION, receiptId: event.receiptId || `hermes_${sha256(`${Date.now()}:${Math.random()}`).slice(0, 16)}`, at: event.at || new Date().toISOString(), sourceVersion: this.sourceVersion, operation: event.operation || "unknown", outcome: event.outcome || "unknown", category: event.category || "unknown", durationMs: Math.max(0, Math.round(Number(event.durationMs || 0))), schemaValid: event.schemaValid === true, repairTurns: Math.max(0, Math.round(Number(event.repairTurns || 0))), privacyViolations: Math.max(0, Math.round(Number(event.privacyViolations || 0))), mutation: "none", sessionHash: event.sessionHash ? `sha256:${sha256(event.sessionHash)}` : null, identityKey: event.identityKey || null, accepted: typeof event.accepted === "boolean" ? event.accepted : null };
    this.writableStorage().appendJsonl?.(this.key("events"), row);
    try { this.trace?.emit?.({ category: "hermes_advisory", name: `hermes.${row.operation}.${row.outcome}`, subsystem: "hermes-advisory", payload: { receiptId: row.receiptId, category: row.category, schemaValid: row.schemaValid, repairTurns: row.repairTurns, privacyViolations: row.privacyViolations }, duration_ms: row.durationMs }); } catch {}
    return row;
  }
  identity() { return this.readiness.identityFor({ bin: this.bin, provider: this.provider, model: this.model, env: this.env }); }
  localReadiness() {
    const executable = this.readiness.executableInfo(this.bin, this.env);
    const shared = this.readiness.readinessStatus(this.cwd, { bin: this.bin, provider: this.provider, model: this.model, policy: this.policy, env: this.env });
    return { enabled: this.enabled, executable: { ready: Boolean(this.enabled && executable.found), status: !this.enabled ? "disabled" : executable.found ? "ready" : "unavailable", binary: executable }, authentication: { ready: shared.authReady, status: shared.authReady ? "ready" : "not-probed" }, providerModel: { ready: shared.authReady, status: shared.authReady ? "ready" : "unknown", provider: cleanId(this.provider, this.provider ? "configured" : "configured-default"), model: cleanId(this.model, this.model ? "configured" : "configured-default") }, shared };
  }
  status() {
    const local = this.localReadiness(); const events = this.events({ limit: 10_000 }); const terminal = events.filter((event) => ["succeeded", "failed", "timed-out", "cancelled", "blocked"].includes(event.outcome)); const valid = terminal.filter((event) => event.schemaValid); const durations = terminal.map((event) => event.durationMs); const privacyViolations = events.reduce((sum, event) => sum + Number(event.privacyViolations || 0), 0);
    return { schemaVersion: HERMES_ADVISORY_SCHEMA_VERSION, sourceVersion: this.sourceVersion, providerReady: local.authentication.ready && local.providerModel.ready, advisoryDraftAllowed: Boolean(this.enabled && this.authority.advisoryDraftAllowed && local.authentication.ready), canonicalPromotionAllowed: Boolean(this.authority.canonicalPromotionAllowed), automaticMutationAllowed: false, readiness: local, metrics: { eligible: events.filter((event) => event.outcome === "eligible").length, attempted: terminal.length, succeeded: terminal.filter((event) => event.outcome === "succeeded").length, accepted: events.filter((event) => event.accepted === true).length, schemaValidity: terminal.length ? valid.length / terminal.length : null, p95DurationMs: percentile(durations, 0.95), privacyViolations, byOperation: events.reduce((out, event) => { const row = out[event.operation] ||= { eligible: 0, attempted: 0, succeeded: 0, failed: 0 }; if (event.outcome === "eligible") row.eligible += 1; if (terminal.includes(event)) row.attempted += 1; if (event.outcome === "succeeded") row.succeeded += 1; if (["failed", "timed-out", "blocked"].includes(event.outcome)) row.failed += 1; return out; }, {}) } };
  }
  async version(options = {}) {
    if (!this.enabled) return "disabled";
    const output = await this.run(["--version"], { bin: this.bin, cwd: options.cwd || this.cwd, timeoutMs: Math.min(5000, this.policy.authProbeTimeoutMs), maxBuffer: 64 * 1024, combineStderr: false, signal: options.signal, env: this.env });
    return cleanText(output, 160).split(/\r?\n/)[0] || "available";
  }
  providerArgs() { const args = []; if (this.provider) args.push("--provider", this.provider); if (this.model) args.push("--model", this.model); return args; }
  async probeAuth(options = {}) {
    const started = Date.now(); const identity = this.identity();
    if (!this.enabled || !identity.executableFound) return { ready: false, status: this.enabled ? "unavailable" : "disabled", category: this.enabled ? "missing-binary" : "disabled", durationMs: 0, providerModel: { ready: false, status: "unknown", provider: null, model: null } };
    try {
      const timeoutMs = options.timeoutMs === 0 ? 0 : this.readiness.timeoutFor("auth", options.timeoutMs, this.policy);
      const output = await this.run(["-z", "Reply with exactly HERMES_ADVISORY_AUTH_OK.", "--ignore-rules", ...this.providerArgs()], { bin: this.bin, cwd: options.cwd || this.cwd, timeoutMs, maxBuffer: 64 * 1024, combineStderr: false, signal: options.signal, env: this.env });
      const ready = /\bHERMES_ADVISORY_AUTH_OK\b/.test(String(output || "")); const durationMs = Date.now() - started;
      this.readiness.recordOutcome(this.cwd, { bin: this.bin, provider: this.provider, model: this.model, policy: this.policy, env: this.env }, { operation: "auth", outcome: ready ? "succeeded" : "failed", category: ready ? "ready" : "unexpected-response", durationMs });
      this.record({ operation: "auth", outcome: ready ? "succeeded" : "failed", category: ready ? "ready" : "unexpected-response", durationMs, schemaValid: ready, identityKey: identity.identityKey, sessionHash: options.sessionHash });
      return { ready, status: ready ? "ready" : "not-ready", category: ready ? "authenticated-model-response" : "unexpected-response", durationMs, providerModel: { ready, status: ready ? "ready" : "unknown", provider: cleanId(this.provider, "configured-default"), model: cleanId(this.model, "configured-default") } };
    } catch (error) { const durationMs = Date.now() - started; const category = categoryForError(error); this.readiness.recordOutcome(this.cwd, { bin: this.bin, provider: this.provider, model: this.model, policy: this.policy, env: this.env }, { operation: "auth", outcome: category === "timeout" ? "timed-out" : "failed", category: ["authentication", "provider-model", "transport", "timeout", "cancelled", "missing-binary", "unavailable", "unexpected-response"].includes(category) ? category : "unknown", durationMs }); this.record({ operation: "auth", outcome: category === "timeout" ? "timed-out" : "failed", category, durationMs, identityKey: identity.identityKey, sessionHash: options.sessionHash }); return { ready: false, status: "not-ready", category, errorCode: cleanId(error?.code, "HERMES_ADVISORY_AUTH_FAILED"), durationMs, providerModel: { ready: false, status: "unknown", provider: cleanId(this.provider), model: cleanId(this.model) } }; }
  }
  async probeCuration(options = {}) {
    const started = Date.now(); const auth = this.localReadiness();
    if (!auth.authentication.ready) return { ready: false, status: "not-ready", category: "authentication", durationMs: 0, filesIncluded: 0, noteWritten: false };
    try { const timeoutMs = this.readiness.timeoutFor("curation-probe", options.timeoutMs, this.policy); const output = await this.run(["-z", "This is a bounded synthetic curation readiness smoke. Reply with exactly HERMES_ADVISORY_CURATION_OK.", "--ignore-rules", ...this.providerArgs()], { bin: this.bin, cwd: options.cwd || this.cwd, timeoutMs, maxBuffer: 64 * 1024, combineStderr: false, signal: options.signal, env: this.env }); const ready = /\bHERMES_ADVISORY_CURATION_OK\b/.test(String(output || "")); const durationMs = Date.now() - started; this.readiness.recordOutcome(this.cwd, { bin: this.bin, provider: this.provider, model: this.model, policy: this.policy, env: this.env }, { operation: "curation-probe", outcome: ready ? "succeeded" : "failed", category: ready ? "ready" : "unexpected-response", durationMs }); this.record({ operation: "curation-probe", outcome: ready ? "succeeded" : "failed", category: ready ? "ready" : "unexpected-response", durationMs, schemaValid: ready, identityKey: this.identity().identityKey, sessionHash: options.sessionHash }); return { ready, status: ready ? "ready" : "not-ready", category: ready ? "dry-run-succeeded" : "unexpected-response", durationMs, filesIncluded: 0, noteWritten: false }; }
    catch (error) { const durationMs = Date.now() - started; const category = categoryForError(error); this.readiness.recordOutcome(this.cwd, { bin: this.bin, provider: this.provider, model: this.model, policy: this.policy, env: this.env }, { operation: "curation-probe", outcome: category === "timeout" ? "timed-out" : "failed", category: ["authentication", "provider-model", "transport", "timeout", "cancelled", "missing-binary", "unavailable", "unexpected-response"].includes(category) ? category : "unknown", durationMs }); this.record({ operation: "curation-probe", outcome: category === "timeout" ? "timed-out" : "failed", category, durationMs, identityKey: this.identity().identityKey, sessionHash: options.sessionHash }); return { ready: false, status: "not-ready", category, errorCode: cleanId(error?.code, "HERMES_ADVISORY_CURATION_FAILED"), durationMs, filesIncluded: 0, noteWritten: false }; }
  }
  validateInput(operation, input, options = {}) {
    if (!OPERATIONS.has(operation)) throw errorWith("HERMES_ADVISORY_OPERATION", `Unsupported Hermes advisory operation: ${operation}`);
    const rawPacket = clone(requireObject(input || {}, `${operation} input`));
    const packet = operation === "promptSuggestion" ? validatePromptSuggestionPacket(rawPacket) : rawPacket;
    const serialized = JSON.stringify(packet); const violations = packetPrivacyViolations(packet); const scan = scanMemoryContent(serialized, { maxChars: options.maxInputChars || (operation === "curateCandidate" ? 80_000 : 20_000) });
    if (violations.length || !scan.safe) { const reasons = [...new Set([...scan.blockingReasons, ...violations.map((finding) => finding.reason)])]; throw errorWith("HERMES_ADVISORY_INPUT_UNSAFE", `Hermes advisory input rejected: ${reasons.join(",")}`, { category: "privacy", reasonCode: "privacy", reasons, scan, violations }); }
    return { packet, scan };
  }
  validator(operation, input, custom) { if (custom) return custom; if (operation === "plan") return validatePlan; if (operation === "review") return validateReview; if (operation === "summarizeEvidence") return validateEvidenceSummary; if (operation === "curateCandidate") return (value) => validateCuration(value, input); if (operation === "draftSkillCandidate") return validateSkillDraft; return (value) => value; }
  async request(operation, input = {}, options = {}) {
    if (!this.enabled) throw errorWith("HERMES_ADVISORY_DISABLED", "Hermes advisory adapter is disabled", { category: "disabled", reasonCode: "disabled" });
    let packet;
    try { ({ packet } = this.validateInput(operation, input, options)); }
    catch (error) { if (error?.code === "HERMES_ADVISORY_INPUT_UNSAFE") this.record({ operation, outcome: "blocked", category: "privacy", privacyViolations: 1, identityKey: this.identity().identityKey, sessionHash: options.sessionHash }); throw error; }
    // Suggestions are cancellable background work, never deadline-driven. Apply
    // this at the typed operation boundary so callers cannot restore a timeout
    // or inherit a cooldown from another Hermes operation.
    const isPromptSuggestion = operation === "promptSuggestion";
    let status = this.localReadiness();
    if (!status.authentication.ready && options.probeAuth === true) { const probe = await this.probeAuth(isPromptSuggestion ? { ...options, timeoutMs: 0 } : options); if (!probe.ready) throw errorWith("HERMES_ADVISORY_AUTH_REQUIRED", `Hermes advisory authentication proof is not ready: ${probe.category}`, { category: probe.category, reasonCode: probe.category }); status = this.localReadiness(); }
    if (options.requireAuthProof !== false && !status.authentication.ready) throw errorWith("HERMES_ADVISORY_AUTH_REQUIRED", "Hermes advisory operations require a current passing authentication proof", { category: "authentication", reasonCode: "authentication-proof-missing" });
    if (options.requireCurationProof && !status.shared.curationReady) throw errorWith("HERMES_ADVISORY_CURATION_PROOF_REQUIRED", "Hermes curation requires a current passing curation proof", { category: "authentication", reasonCode: "authentication-proof-missing" });
    const attempt = this.readiness.shouldAttempt(this.cwd, { bin: this.bin, provider: this.provider, model: this.model, policy: this.policy, env: this.env, force: isPromptSuggestion || options.force === true });
    if (!attempt.allowed) throw errorWith("HERMES_ADVISORY_NOT_READY", `Hermes advisory request blocked: ${attempt.reason}`, { category: attempt.reason, reasonCode: attempt.reason, retryAfter: attempt.retryAfter });
    const started = Date.now(); const identity = this.identity(); this.record({ operation, outcome: "eligible", category: "qualified-case", durationMs: 0, identityKey: identity.identityKey, sessionHash: options.sessionHash }); const timeoutKind = operation === "curateCandidate" ? "curation" : operation === "decide" ? "controller" : "advisory"; const timeoutMs = isPromptSuggestion ? 0 : this.readiness.timeoutFor(timeoutKind, options.timeoutMs, this.policy); const maxOutputChars = options.maxOutputChars || (operation === "draftSkillCandidate" ? 24_000 : operation === "curateCandidate" ? 20_000 : 12_000); let repairTurns = 0; let raw = "";
    try {
      raw = await this.run(["-z", RENDERERS[operation](packet), "--ignore-rules", ...this.providerArgs()], { bin: this.bin, cwd: options.cwd || this.cwd, timeoutMs, maxBuffer: Math.max(64 * 1024, maxOutputChars * 4), combineStderr: false, signal: options.signal, env: this.env });
      const outputScan = scanMemoryContent(raw, { maxChars: maxOutputChars });
      if (!outputScan.safe) throw errorWith("HERMES_ADVISORY_OUTPUT_UNSAFE", `Hermes advisory output rejected: ${outputScan.blockingReasons.join(",")}`, { reasons: outputScan.blockingReasons, scan: outputScan });
      let value;
      if (JSON_OPERATIONS.has(operation)) {
        const validate = this.validator(operation, packet, options.validate);
        try { value = validate(extractJsonObject(raw)); }
        catch (firstError) {
          if (options.repair === false) throw firstError;
          repairTurns = 1;
          const repairPacket = { operation, errorCode: cleanId(firstError?.code, "schema-invalid"), errorMessage: cleanText(firstError?.message, 800), response: cleanText(raw, maxOutputChars) };
          const repairScan = scanMemoryContent(JSON.stringify(repairPacket), { maxChars: maxOutputChars + 2000 });
          if (!repairScan.safe) throw firstError;
          raw = await this.run(["-z", `Repair the following Hermes ${operation} response. Return only one JSON object satisfying the original schema; do not add facts.\n\n${JSON.stringify(repairPacket)}`, "--ignore-rules", ...this.providerArgs()], { bin: this.bin, cwd: options.cwd || this.cwd, timeoutMs, maxBuffer: Math.max(64 * 1024, maxOutputChars * 4), combineStderr: false, signal: options.signal, env: this.env });
          const repairedScan = scanMemoryContent(raw, { maxChars: maxOutputChars }); if (!repairedScan.safe) throw errorWith("HERMES_ADVISORY_OUTPUT_UNSAFE", `Hermes repaired output rejected: ${repairedScan.blockingReasons.join(",")}`, { reasons: repairedScan.blockingReasons, scan: repairedScan }); value = validate(extractJsonObject(raw));
        }
      } else { value = cleanText(raw, maxOutputChars); if (!value) throw errorWith("HERMES_ADVISORY_EMPTY", "Hermes advisory response was empty"); }
      const durationMs = Date.now() - started; this.readiness.recordOutcome(this.cwd, { bin: this.bin, provider: this.provider, model: this.model, policy: this.policy, env: this.env }, { operation: operation === "curateCandidate" ? "curation" : "prompt", outcome: "succeeded", category: "ready", durationMs }); const receipt = this.record({ operation, outcome: "succeeded", category: "ready", durationMs, schemaValid: true, repairTurns, identityKey: identity.identityKey, sessionHash: options.sessionHash }); return { operation, value, receipt, outputHash: `sha256:${sha256(raw)}` };
    } catch (error) {
      const durationMs = Date.now() - started;
      const category = categoryForError(error);
      const outcome = category === "timeout" ? "timed-out" : category === "cancelled" ? "cancelled" : "failed";
      const privacyViolations = category === "privacy" || /UNSAFE/.test(String(error?.code || "")) ? 1 : 0;
      const readiness = this.readiness.recordOutcome(this.cwd, { bin: this.bin, provider: this.provider, model: this.model, policy: this.policy, env: this.env }, { operation: operation === "curateCandidate" ? "curation" : "prompt", outcome, category: ["authentication", "provider-model", "transport", "timeout", "cancelled", "missing-binary", "unavailable", "unexpected-response"].includes(category) ? category : "unknown", durationMs });
      this.record({ operation, outcome, category, durationMs, schemaValid: false, repairTurns, privacyViolations, identityKey: identity.identityKey, sessionHash: options.sessionHash });
      throw errorWith(cleanId(error?.code, "HERMES_ADVISORY_REQUEST_FAILED"), `Hermes advisory ${operation} failed: ${category}`, { category, reasonCode: category, retryAfter: readiness.retryAfter });
    }
  }
  plan(input, options) { return this.request("plan", input, options); }
  review(input, options) { return this.request("review", input, options); }
  decide(input, options) { return this.request("decide", input, options); }
  summarizeEvidence(input, options) { return this.request("summarizeEvidence", input, options); }
  promptSuggestion(input, options) { return this.request("promptSuggestion", input, options); }
  curateCandidate(input, options) { return this.request("curateCandidate", input, { ...options, requireCurationProof: true }); }
  draftSkillCandidate(input, options) { return this.request("draftSkillCandidate", input, options); }
  recordAcceptance({ receiptId, accepted, sessionHash } = {}) {
    const id = cleanId(receiptId);
    if (!id) throw errorWith("HERMES_ADVISORY_FEEDBACK_RECEIPT", "Hermes feedback requires a valid receipt ID");
    const source = [...this.events({ limit: 10_000 })].reverse().find((event) => event.receiptId === id && event.outcome === "succeeded" && ["plan", "review", "decide", "summarizeEvidence", "promptSuggestion"].includes(event.operation));
    if (!source) throw errorWith("HERMES_ADVISORY_FEEDBACK_RECEIPT", "Hermes feedback receipt does not identify a successful assistant advisory");
    return this.record({ operation: source.operation, receiptId: id, outcome: accepted ? "accepted" : "rejected", category: "user-disposition", schemaValid: true, accepted: Boolean(accepted), sessionHash });
  }
  recordCurationReview({ receiptId, decision, sessionHash } = {}) {
    const id = cleanId(receiptId); const normalized = cleanId(decision);
    if (!id || !["accept", "reject", "correct"].includes(normalized)) throw errorWith("HERMES_ADVISORY_CURATION_REVIEW_INVALID", "Curation review requires a valid receipt ID and accept, reject, or correct decision");
    const source = [...this.events({ limit: 10_000 })].reverse().find((event) => event.receiptId === id && event.operation === "curateCandidate" && event.outcome === "succeeded");
    if (!source) throw errorWith("HERMES_ADVISORY_CURATION_RECEIPT", "Curation review receipt does not identify a successful curation advisory");
    return this.record({ operation: source.operation, receiptId: id, outcome: normalized === "accept" ? "accepted" : "rejected", category: `curation-review-${normalized}`, schemaValid: true, accepted: normalized === "accept", sessionHash });
  }
}

module.exports = { HERMES_ADVISORY_SCHEMA_VERSION, HERMES_ADVISORY_VERSION, HermesAdvisoryAdapter, extractJsonObject, validatePlan, validateReview, validateEvidenceSummary, validatePromptSuggestionPacket, validateCuration, validateSkillDraft };
