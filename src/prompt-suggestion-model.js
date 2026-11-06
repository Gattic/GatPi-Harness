"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { redactMemoryText, scanMemoryContent } = require("./memory-content-scanner.js");

const CONFIG_SCHEMA_VERSION = 1;
const CONFIG_FILENAME = "prompt-suggestions.json";
const MAX_MODEL_REF_CHARS = 240;
const MAX_CONTEXT_CHARS = 12000;
const DEFAULT_CONTEXT_CHARS = 6000;
const MAX_OUTPUT_CHARS = 12000;
const MAX_SKILL_CONTEXT_CHARS = 800;
const PUBLIC_MESSAGE_CHARS = 900;

const SYSTEM_PROMPT = `You are suggesting the user's next prompt in a command-line coding assistant. Return ONLY one concise, complete prompt for the best next step. It may be multiple lines when a structured prompt is genuinely more useful. Do not quote it. Aim for at most 240 characters, but always finish the prompt and never end it with an ellipsis. If there is no useful next step, return an empty string.`;

const PROVIDER_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9_.:/@+-]{1,200}$/;

function agentDir(env = process.env) {
  return path.resolve(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
}

function configPath(env = process.env) {
  return path.resolve(env.PI_PROMPT_SUGGESTIONS_CONFIG || path.join(agentDir(env), CONFIG_FILENAME));
}

function modelError(reasonCode, message, extra = {}) {
  return Object.assign(new Error(message), { code: `PROMPT_SUGGESTION_${reasonCode.replace(/-/g, "_").toUpperCase()}`, reasonCode, ...extra });
}

function parseModelRef(value) {
  const text = String(value || "").trim();
  if (!text || text.length > MAX_MODEL_REF_CHARS) return null;
  const separator = text.indexOf("/");
  if (separator <= 0 || separator === text.length - 1) return null;
  const provider = text.slice(0, separator);
  const modelId = text.slice(separator + 1);
  if (!PROVIDER_PATTERN.test(provider) || !MODEL_ID_PATTERN.test(modelId)) return null;
  return { provider, modelId };
}

function formatModelRef(config) {
  return config ? `${config.provider}/${config.modelId}` : null;
}

function normalizeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Number(value.schemaVersion) !== CONFIG_SCHEMA_VERSION) return null;
  const provider = String(value.provider || "").trim();
  const modelId = String(value.modelId || "").trim();
  if (!PROVIDER_PATTERN.test(provider) || !MODEL_ID_PATTERN.test(modelId)) return null;
  if (`${provider}/${modelId}`.length > MAX_MODEL_REF_CHARS) return null;
  return { provider, modelId };
}

function readModelConfig({ env = process.env } = {}) {
  const file = configPath(env);
  const override = String(env.PI_PROMPT_SUGGESTIONS_MODEL || "").trim();
  if (override) {
    const parsed = parseModelRef(override);
    if (!parsed) return { ok: false, reasonCode: "invalid-config", file: null, source: "environment", error: "PI_PROMPT_SUGGESTIONS_MODEL must be provider/modelId" };
    return { ok: true, config: parsed, file: null, source: "environment" };
  }
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return { ok: false, reasonCode: "model-not-configured", file, error: "no prompt suggestion model is configured" };
    return { ok: false, reasonCode: "invalid-config", file, error: `cannot read prompt suggestion model config: ${error?.code || "unknown"}` };
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, reasonCode: "invalid-config", file, error: "prompt suggestion model config is not valid JSON" }; }
  const config = normalizeConfig(parsed);
  if (!config) return { ok: false, reasonCode: "invalid-config", file, error: "prompt suggestion model config requires schemaVersion 1 and valid provider/modelId" };
  return { ok: true, config, file, source: "file" };
}

function writeModelConfig(input, { env = process.env } = {}) {
  const config = normalizeConfig({ schemaVersion: CONFIG_SCHEMA_VERSION, provider: input?.provider, modelId: input?.modelId });
  if (!config) throw modelError("invalid-config", "prompt suggestion model requires a valid provider and modelId");
  const file = configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const row = { schemaVersion: CONFIG_SCHEMA_VERSION, ...config, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(row, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
  return { ok: true, config, file };
}

function inspectModelConfig(registry, { env = process.env } = {}) {
  const loaded = readModelConfig({ env });
  if (!loaded.ok) return { ...loaded, modelRef: null, available: false, authConfigured: false };
  const model = registry?.find?.(loaded.config.provider, loaded.config.modelId);
  return {
    ...loaded,
    modelRef: formatModelRef(loaded.config),
    available: Boolean(model),
    authConfigured: Boolean(model && registry.hasConfiguredAuth?.(model)),
  };
}

function validatePacket(packet, maxContextChars = MAX_CONTEXT_CHARS) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw modelError("invalid-packet", "prompt suggestion packet must be an object");
  const allowed = new Set(["publicRecentContext", "skillContext"]);
  const extra = Object.keys(packet).filter((key) => !allowed.has(key));
  if (extra.length) throw modelError("invalid-packet", `prompt suggestion packet has unsupported fields: ${extra.join(",")}`);
  const bounded = (field, max) => {
    const value = packet[field];
    if (value == null) return null;
    if (typeof value !== "string" || !value.trim() || value.length > max) throw modelError("invalid-packet", `${field} must be null or a non-empty string of at most ${max} characters`);
    return value;
  };
  const contextMax = Math.max(1000, Math.min(MAX_CONTEXT_CHARS, Number(maxContextChars) || DEFAULT_CONTEXT_CHARS));
  return {
    publicRecentContext: bounded("publicRecentContext", contextMax),
    skillContext: bounded("skillContext", MAX_SKILL_CONTEXT_CHARS),
  };
}

function scanPromptText(text, maxChars) {
  const scan = scanMemoryContent(text, { maxChars });
  if (!scan.safe) throw modelError("privacy", `prompt suggestion content rejected: ${scan.blockingReasons.join(",")}`, { scan });
  return text;
}

function promptTextIsSafe(text, maxChars) {
  return scanMemoryContent(text, { maxChars }).safe;
}

function redactPromptText(text, maxChars = PUBLIC_MESSAGE_CHARS) {
  return redactMemoryText(text, { maxChars });
}

function classifyRequestError(error) {
  const text = `${String(error?.message || error || "")} ${String(error?.code || "")}`.toLowerCase();
  if (/auth|credential|401|403|login|api key/.test(text)) return "authentication";
  if (/timeout|timed out|deadline/.test(text)) return "timeout";
  if (/abort|cancel/.test(text)) return "cancelled";
  if (/provider|model.*(?:not found|missing|unavailable|invalid)/.test(text)) return "provider-model";
  if (/network|socket|transport|econn|dns|fetch/.test(text)) return "transport";
  if (/unsafe|privacy|forbidden/.test(text)) return "privacy";
  return "unknown";
}

function responseText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && block.type === "text")
    .map((block) => String(block.text || ""))
    .join("\n");
}

async function requestModelSuggestion({ registry, config, packet, signal, maxContextChars = DEFAULT_CONTEXT_CHARS } = {}) {
  if (!registry || typeof registry.complete !== "function" || typeof registry.find !== "function") {
    throw modelError("model-unavailable", "Pi's model registry is unavailable for prompt suggestions");
  }
  if (!config) throw modelError("model-not-configured", "no prompt suggestion model is configured");
  const bounded = validatePacket(packet, maxContextChars);
  if (bounded.publicRecentContext) scanPromptText(bounded.publicRecentContext, MAX_CONTEXT_CHARS);
  if (bounded.skillContext) scanPromptText(bounded.skillContext, MAX_SKILL_CONTEXT_CHARS);

  const model = registry.find(config.provider, config.modelId);
  if (!model) throw modelError("model-unavailable", `configured prompt suggestion model is not available: ${formatModelRef(config)}`);

  const userText = `Recent chat context:\n${bounded.publicRecentContext || "(none)"}${bounded.skillContext ? `\n\n${bounded.skillContext}` : ""}`;
  let response;
  try {
    response = await registry.complete(model, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
    }, { signal });
  } catch (error) {
    const reasonCode = classifyRequestError(error);
    throw modelError(reasonCode, `prompt suggestion model request failed: ${reasonCode}`, { cause: error });
  }

  if (response?.stopReason === "aborted") throw modelError("cancelled", "prompt suggestion model request was cancelled");
  if (response?.stopReason === "error") {
    const reasonCode = classifyRequestError(response.errorMessage);
    throw modelError(reasonCode, `prompt suggestion model request failed: ${reasonCode}`);
  }
  const value = responseText(response?.content);
  if (!value.trim()) throw modelError("invalid-suggestion", "prompt suggestion model returned an empty response");
  scanPromptText(value, MAX_OUTPUT_CHARS);
  return { value };
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  CONFIG_FILENAME,
  DEFAULT_CONTEXT_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_OUTPUT_CHARS,
  MAX_SKILL_CONTEXT_CHARS,
  PUBLIC_MESSAGE_CHARS,
  SYSTEM_PROMPT,
  agentDir,
  configPath,
  formatModelRef,
  inspectModelConfig,
  parseModelRef,
  readModelConfig,
  promptTextIsSafe,
  redactPromptText,
  requestModelSuggestion,
  scanPromptText,
  writeModelConfig,
};
