"use strict";

// Privacy-safe, incremental mining of Claude, Codex, and Pi session JSONL.
// Raw prompts, reasoning, tool arguments/output, commands, repository paths,
// and transcript excerpts are inspected only in memory and never persisted.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { OUTCOME_SCHEMA_VERSION, CANONICAL_OUTCOMES, inferOutcome, isFailureOutcome } = require("./outcome-schema");
const { readExtensionTelemetry } = require("./extension-telemetry");
const { runtimeSourceFingerprint } = require("./runtime-source-fingerprint");

const SCHEMA_VERSION = 5;
const CLASSIFIER_VERSION = "session-miner-v5";
const COHORT_CONTRACT_VERSION = 1;
const SESSION_KIND_POLICY_VERSION = "session-kind-policy-v2";
const ROW_WINDOW_POLICY_VERSION = "row-window-policy-v1";
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_JSON_LINE_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY = 100;
const STANDARD_TOOL_NAMES = new Set([
  "Agent", "AskUserQuestion", "Bash", "Edit", "Read", "Skill", "TaskCreate", "TaskList", "TaskStop", "TaskUpdate", "ToolSearch", "Write",
  "apply_patch", "close_agent", "exec_command", "list_mcp_resources", "read_mcp_resource", "send_input", "spawn_agent", "update_plan", "view_image", "wait_agent", "write_stdin",
  "ast_search", "bash", "bg_run", "build_project", "ci_pr_companion", "codegraph_affected", "codegraph_context", "codegraph_query", "codegraph_status", "codegraph_sync", "commit_plan", "create_subagent", "debug_ledger", "docs_lookup", "edit", "evidence_binder", "evidence_inbox", "experiment_ledger", "fix_recall", "gitevidence", "gitverify", "learning_loop", "lsp", "obsidian_import", "obsidian_note", "obsidian_search", "obsidian_status", "output_compactor", "policy_enforcer", "policy_gate", "privacy_guard", "read", "repo_context", "roadmap_update", "run_deck", "run_monitor", "safe_try", "semgrep_codegraph", "semgrep_doctor", "semgrep_scan", "semgrep_status", "test_project", "test_runner", "verification_center", "write",
]);
const CORRECTION_PATTERNS = {
  persistence: /\b(still (?:persists?|happening|broken|failing)|same (?:issue|error|problem)|did(?: not|n't) work|does(?: not|n't) work|again)\b/i,
  instruction_miss: /\b(despite what i (?:said|asked)|i (?:said|asked|told you)|why did you|you (?:ignored|missed|did not follow|didn't follow))\b/i,
  correction: /(?:^|\n)\s*(?:no[,.:;!]|actually[,.:;!]|instead[,.:;!])|\bthat(?:'s| is) not what i (?:asked|meant)\b/i,
};
const NATIVE_EQUIVALENTS = {
  "cmake --build": "build_project",
  "npm build": "build_project",
  "pnpm build": "build_project",
  "yarn build": "build_project",
  make: "build_project",
  ninja: "build_project",
  ctest: "test_project",
  pytest: "test_runner",
  "npm test": "test_runner",
  "pnpm test": "test_runner",
  "yarn test": "test_runner",
  "node test": "test_runner",
  "git status": "repo_context",
  "git log": "repo_context",
  "git diff": "gitevidence",
  tail: "run_deck",
  pgrep: "run_deck",
  "nvidia-smi": "run_deck",
  sleep: "run_monitor",
};

function nowIso() { return new Date().toISOString(); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function positiveNumber(value, fallback, label) {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive number`);
  return number;
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch {} }
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
function sha(value, n = 16) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex").slice(0, n); }
function hmac(salt, value, n = 20) { return crypto.createHmac("sha256", salt).update(String(value)).digest("hex").slice(0, n); }
function inc(target, key, amount = 1) { if (!key) return; target[key] = (target[key] || 0) + amount; }
function mergeCounts(target, source) { for (const [key, value] of Object.entries(source || {})) inc(target, key, Number(value) || 0); return target; }
function mergeNestedCounts(target, source) { for (const [key, counts] of Object.entries(source || {})) mergeCounts(target[key] ||= {}, counts); return target; }
function sortedCounts(counts, limit = 50) { return Object.entries(counts || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([name, count]) => ({ name, count })); }
function safeRate(numerator, denominator) { return denominator ? Number((numerator / denominator).toFixed(4)) : 0; }
function privacySafeVersion(value, fallback) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_.:+-]{1,160}$/.test(text) ? text : fallback;
}
function isoBoundary(value, label) {
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}
function settingsVersion(env = process.env, home = os.homedir()) {
  const file = env.PI_SETTINGS_FILE || path.join(home, ".pi", "agent", "settings.json");
  try { return `settings-${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16)}`; }
  catch { return "settings-unavailable"; }
}
function buildCohortContract(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  const windowDays = clamp(positiveNumber(options.sinceDays, DEFAULT_WINDOW_DAYS, "sinceDays"), 1, 3650);
  const untilAt = isoBoundary(options.untilAt || options.now || Date.now(), "untilAt");
  const untilMs = Date.parse(untilAt);
  const sinceAt = options.sinceAt
    ? isoBoundary(options.sinceAt, "sinceAt")
    : new Date(untilMs - windowDays * 24 * 60 * 60 * 1000).toISOString();
  if (Date.parse(sinceAt) > untilMs) throw new Error("sinceAt must not be after untilAt");
  const runtimeSourceHash = privacySafeVersion(options.runtimeSourceHash || runtimeSourceFingerprint(cwd).hash, "runtime-unavailable");
  const contract = {
    schemaVersion: COHORT_CONTRACT_VERSION,
    sourceVersion: privacySafeVersion(options.sourceVersion || env.PI_SESSION_MINING_SOURCE_VERSION || `runtime-${runtimeSourceHash.slice(0, 16)}`, "unversioned-source"),
    runtimeSourceHash,
    configVersion: privacySafeVersion(options.configVersion || env.PI_SESSION_MINING_CONFIG_VERSION || settingsVersion(env, options.home || os.homedir()), "unversioned-config"),
    classifierVersion: CLASSIFIER_VERSION,
    outcomeSchemaVersion: OUTCOME_SCHEMA_VERSION,
    sessionKindPolicyVersion: SESSION_KIND_POLICY_VERSION,
    rowWindowPolicyVersion: ROW_WINDOW_POLICY_VERSION,
    undatedRowPolicy: options.includeUndatedRows === true ? "include" : "exclude",
    sinceAt,
    untilAt,
    windowDays,
  };
  return { ...contract, key: `session_cohort_${sha(contract, 24)}` };
}
function compareCohortContracts(previous, current) {
  if (!previous?.key) return { compatible: false, reason: "missing-previous-cohort", changedFields: [] };
  if (!current?.key) return { compatible: false, reason: "missing-current-cohort", changedFields: [] };
  if (previous.key === current.key) return { compatible: true, reason: "comparable-cohort", changedFields: [] };
  const fields = ["schemaVersion", "sourceVersion", "runtimeSourceHash", "configVersion", "classifierVersion", "outcomeSchemaVersion", "sessionKindPolicyVersion", "rowWindowPolicyVersion", "undatedRowPolicy", "sinceAt", "untilAt", "windowDays"];
  return { compatible: false, reason: "incompatible-cohort-key", changedFields: fields.filter((field) => previous[field] !== current[field]) };
}

function defaultSessionRoots(env = process.env, home = os.homedir()) {
  return {
    claude: env.PI_SESSION_MINING_CLAUDE_ROOT || path.join(home, ".claude", "projects"),
    codex: env.PI_SESSION_MINING_CODEX_ROOT || path.join(home, ".codex", "sessions"),
    pi: env.PI_SESSION_MINING_PI_ROOT || path.join(home, ".pi", "agent", "sessions"),
  };
}

function safeLabel(value, salt, kind = "label") {
  const text = String(value || "").trim();
  if (!text) return "";
  if (STANDARD_TOOL_NAMES.has(text)) return text;
  if (/^[A-Za-z][A-Za-z0-9_.:+-]{0,79}$/.test(text) && !/(?:secret|token|password|passwd|api[_-]?key|authorization)/i.test(text)) return text;
  return `private-${kind}:${hmac(salt, text, 12)}`;
}

function normalizePromptForHash(text) {
  return String(text || "").toLowerCase().replace(/\b\d+(?:\.\d+)?\b/g, "#").replace(/\s+/g, " ").trim().slice(0, 4000);
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && typeof part === "object" && ["text", "input_text"].includes(part.type)).map((part) => part.text || "").join("\n");
}

function errorText(value) {
  if (typeof value === "string") return value.slice(0, 100_000);
  if (Array.isArray(value)) return value.map((part) => errorText(part)).filter(Boolean).join("\n").slice(0, 100_000);
  if (!value || typeof value !== "object") return String(value || "");
  if (typeof value.text === "string") return value.text.slice(0, 100_000);
  try { return JSON.stringify(value).slice(0, 100_000); } catch { return ""; }
}

function classifyProviderError(value) {
  const text = errorText(value).toLowerCase();
  if (/context.{0,30}(?:length|window)|context_length_exceeded|input exceeds|too many tokens|token limit/.test(text)) return "context-limit";
  if (/usage limit|quota exceeded|insufficient_quota|out of budget|billing/.test(text)) return "usage-limit";
  if (/rate.?limit|too many requests|\b429\b/.test(text)) return "rate-limit";
  if (/no api key|invalid api key|unauthori[sz]ed|authentication|\b401\b|forbidden|\b403\b/.test(text)) return "credentials";
  if (/timed? ?out|timeout|deadline exceeded/.test(text)) return "timeout";
  if (/fetch failed|websocket|terminated|econn|connection (?:closed|refused|reset|lost)|network|socket hang up|stream ended/.test(text)) return "transport";
  if (/server_error|internal server|bad gateway|service unavailable|provider returned error|an error occurred while processing|\b5\d\d\b/.test(text)) return "provider-server";
  if (/cancel|abort|interrupt/.test(text)) return "cancelled";
  return "unknown-provider-error";
}

function classifyToolError(value) {
  const text = errorText(value).toLowerCase();
  if (/policy-enforcer block|write-like path outside repo|must stay inside cwd|approval keys?/.test(text)) return "policy-boundary";
  if (/could not find .{0,80}(?:exact text|oldtext)|old ?text must match exactly|found \d+ occurrences|text must be unique|each oldtext must be unique/.test(text)) return "edit-match";
  if (/command timed out|timed out after|timeout/.test(text)) return "timeout";
  if (/enoent|no such file|cannot find module|module not found|not found on path|not installed|not initialized/.test(text)) return "missing-resource";
  if (/validation failed|requires task|must be equal to constant|source path must|invalid tool arguments?/.test(text)) return "invalid-arguments";
  if (/no verification-center latest evidence|run \/verify-run first|prerequisite/.test(text)) return "missing-prerequisite";
  if (/requires the exact completion promise|no active or paused automation loop/.test(text)) return "automation-contract";
  if (/offset .{0,40} beyond end of file|row index out of bounds/.test(text)) return "out-of-range";
  if (/semgrep command failed|codegraph command failed|adapter command failed/.test(text)) return "adapter-failure";
  if (/invalid regular expression|syntaxerror|unexpected eof|assertionerror|patch hunk does not apply/.test(text)) return "parse-syntax-patch";
  if (/command exited with code|"status":"failed"|"exit_code":[1-9]|tests? failed/.test(text)) return "command-failure";
  return "unknown-tool-error";
}

function parseToolArguments(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || value.length > MAX_JSON_LINE_BYTES) return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : {}; }
  catch { return {}; }
}

function structuredToolDetails(details, content) {
  if (details && typeof details === "object" && !Array.isArray(details)) return details;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.find((part) => part?.type === "text" && typeof part.text === "string")?.text : "";
  if (typeof text !== "string" || text.length > MAX_JSON_LINE_BYTES || !/^\s*[{[]/.test(text)) return {};
  try { const parsed = JSON.parse(text); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
}

const SESSION_KINDS = new Set(["interactive", "headless-smoke", "deterministic-fixture", "unknown"]);
function explicitSessionKind(row) {
  const candidates = [row?.sessionType, row?.session_type, row?.mode, row?.metadata?.sessionType, row?.metadata?.session_type, row?.metadata?.kind, row?.data?.sessionType, row?.data?.session_type, row?.data?.kind];
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim().toLowerCase().replace(/_/g, "-");
    if (["fixture", "deterministic", "deterministic-fixture", "test-fixture"].includes(normalized)) return "deterministic-fixture";
    if (["headless", "print", "json", "smoke", "headless-smoke"].includes(normalized)) return "headless-smoke";
    if (["interactive", "tui"].includes(normalized)) return "interactive";
  }
  if (row?.fixture === true || row?.metadata?.fixture === true || row?.data?.fixture === true) return "deterministic-fixture";
  if (row?.hasUI === false || row?.interactive === false || row?.metadata?.headless === true || row?.data?.headless === true) return "headless-smoke";
  if (row?.hasUI === true || row?.interactive === true) return "interactive";
  return "unknown";
}
function recordSessionKind(summary, row) {
  const kind = explicitSessionKind(row);
  if (!SESSION_KINDS.has(kind) || kind === "unknown") return;
  const precedence = { unknown: 0, interactive: 1, "headless-smoke": 2, "deterministic-fixture": 3 };
  if ((precedence[kind] || 0) >= (precedence[summary.sessionKind] || 0)) summary.sessionKind = kind;
}

function commandFromArguments(value) {
  const input = parseToolArguments(value);
  const command = input.command ?? input.cmd ?? input.shell_command;
  if (Array.isArray(command)) return command.filter((part) => typeof part === "string").join(" ");
  return typeof command === "string" ? command : "";
}

function executableToken(segment) {
  let text = String(segment || "").trim().replace(/^\(+|\)+$/g, "");
  text = text.replace(/^(?:sudo\s+|env\s+|command\s+|builtin\s+)+/i, "");
  text = text.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "");
  text = text.replace(/^timeout\s+(?:--?\S+\s+)*\d+(?:\.\d+)?[smhd]?\s+/i, "");
  const match = text.match(/^(?:["']?)([^\s"']+)/);
  if (!match) return { executable: "", rest: "" };
  return { executable: match[1], rest: text.slice(match[0].length).trim() };
}

function commandFamilies(command) {
  const families = [];
  const segments = String(command || "").slice(0, 100_000).split(/&&|\|\||[;|\n]/);
  for (const segment of segments) {
    const { executable, rest } = executableToken(segment);
    if (!executable) continue;
    const base = path.posix.basename(executable).toLowerCase();
    const words = rest.match(/[^\s"']+/g) || [];
    let family = "";
    if (/^(?:\.\.?\/|\/)/.test(executable)) family = "local-executable";
    else if (base === "git") {
      const sub = words.find((word) => !word.startsWith("-"));
      family = sub && /^(status|diff|log|show|add|commit|restore|checkout|switch|worktree|rev-parse|fetch|pull|push)$/.test(sub) ? `git ${sub}` : "git";
    } else if (base === "cmake") family = words.includes("--build") ? "cmake --build" : "cmake configure";
    else if (["npm", "pnpm", "yarn", "bun"].includes(base)) {
      const sub = words.find((word) => !word.startsWith("-"));
      family = sub && /^(test|build|install|run|lint|typecheck)$/.test(sub) ? `${base} ${sub}` : base;
    } else if (base === "node") family = /(?:^|\/)(?:tests?|spec)(?:\/|[-_.])|\.test\.[cm]?[jt]s|--test\b/i.test(rest) ? "node test" : "node";
    else if (["python", "python3"].includes(base)) family = /(?:^|\s)(?:-m\s+)?pytest\b/i.test(rest) ? "pytest" : "python";
    else if (["pytest", "ctest", "make", "ninja", "rg", "grep", "tail", "head", "find", "ls", "pgrep", "nvidia-smi", "gdb", "curl", "wget", "sleep", "cat", "cargo", "go", "docker"].includes(base)) family = base;
    else if (["bash", "sh", "zsh"].includes(base)) family = "shell script";
    else family = /^[a-z][a-z0-9+_.-]{0,40}$/.test(base) ? base : "other-command";
    families.push(family);
  }
  return families.filter(Boolean);
}

function createFileSummary(source, fileId, stat) {
  return {
    schemaVersion: SCHEMA_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    outcomeSchemaVersion: OUTCOME_SCHEMA_VERSION,
    source,
    sessionKind: "unknown",
    fileId,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    earliestAt: null,
    latestAt: null,
    rows: 0,
    rowsRead: 0,
    timestampedRows: 0,
    undatedRows: 0,
    countedUndatedRows: 0,
    rowsBeforeWindow: 0,
    rowsAfterWindow: 0,
    invalidRows: 0,
    oversizedRows: 0,
    userTurns: 0,
    assistantTurns: 0,
    assistantStopReasons: {},
    providerErrors: {},
    providerErrorPending: false,
    lastMessageRole: "",
    lastAssistantStopReason: "",
    terminalState: "no-message",
    toolCalls: 0,
    toolResults: 0,
    toolErrors: 0,
    toolSemanticFailures: 0,
    toolOutcomes: Object.fromEntries(CANONICAL_OUTCOMES.map((outcome) => [outcome, 0])),
    toolOutcomesByName: {},
    resultIntegrity: { duplicateCalls: 0, duplicateResults: 0, unmatchedCalls: 0, unmatchedResults: 0 },
    tools: {},
    toolErrorsByName: {},
    toolErrorCategories: {},
    toolErrorCategoriesByName: {},
    shellFamilies: {},
    skills: {},
    skillAttributions: {},
    corrections: {},
    promptHashes: {},
    workflows: {},
  };
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value > 0 && value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function rowTimestampMs(row) {
  const value = row?.timestamp ?? row?.message?.timestamp ?? row?.payload?.timestamp ?? row?.data?.timestamp ?? row?.createdAt ?? row?.created_at;
  return timestampMs(value);
}

function recordTimestamp(summary, value) {
  const ms = timestampMs(value);
  if (!Number.isFinite(ms)) return;
  const iso = new Date(ms).toISOString();
  if (!summary.earliestAt || iso < summary.earliestAt) summary.earliestAt = iso;
  if (!summary.latestAt || iso > summary.latestAt) summary.latestAt = iso;
}

function analyzeUserText(summary, text, salt) {
  const value = String(text || "");
  if (!value.trim()) return;
  summary.userTurns++;
  for (const [kind, regex] of Object.entries(CORRECTION_PATTERNS)) if (regex.test(value)) inc(summary.corrections, kind);
  const normalized = normalizePromptForHash(value);
  if (normalized) inc(summary.promptHashes, hmac(salt, normalized, 24));
}

function createToolRecorder(summary, salt) {
  const calls = new Map();
  const results = new Map();
  const recent = [];
  const outcomeRank = { unknown: 0, succeeded: 1, "not-applicable": 2, "domain-negative": 3, blocked: 4, cancelled: 5, "timed-out": 6, "infrastructure-failed": 7 };
  const recordError = (name, content) => {
    const category = classifyToolError(content);
    inc(summary.toolErrorCategories, category);
    const byName = summary.toolErrorCategoriesByName[name] ||= {};
    inc(byName, category);
  };
  const recordOutcome = (name, outcome, amount = 1) => {
    inc(summary.toolOutcomes, outcome, amount);
    const byName = summary.toolOutcomesByName[name] ||= {};
    inc(byName, outcome, amount);
    if (isFailureOutcome(outcome)) summary.toolSemanticFailures += amount;
  };
  return {
    call(id, rawName, args) {
      const name = safeLabel(rawName, salt, "tool") || "unknown-tool";
      summary.toolCalls++;
      inc(summary.tools, name);
      const input = parseToolArguments(args);
      const operation = safeLabel(input.operation, salt, "operation") || "default";
      if (id) {
        const callId = String(id);
        if (calls.has(callId)) summary.resultIntegrity.duplicateCalls++;
        else calls.set(callId, { name, operation });
      }
      const command = /^(?:Bash|bash|exec_command)$/.test(name) ? commandFromArguments(args) : "";
      for (const family of commandFamilies(command)) inc(summary.shellFamilies, family);
      recent.push(name);
      if (recent.length > 3) recent.shift();
      if (recent.length === 3) inc(summary.workflows, recent.join(" → "));
      if (name === "Skill") {
        const skill = safeLabel(input.skill || input.name || input.command, salt, "skill");
        if (skill) inc(summary.skills, skill);
      }
    },
    result(id, rawName, isError, content, details) {
      const resultId = id ? String(id) : "";
      const mapped = resultId ? calls.get(resultId) : null;
      const name = mapped?.name || safeLabel(rawName, salt, "tool") || "unknown-tool";
      const operation = mapped?.operation || "default";
      const errorCategory = isError ? classifyToolError(content) : "";
      const outcome = inferOutcome(structuredToolDetails(details, content), { isError, toolName: name, operation, errorCategory });
      if (resultId && results.has(resultId)) {
        summary.resultIntegrity.duplicateResults++;
        const previous = results.get(resultId);
        if (isError && !previous.isError) {
          previous.isError = true;
          summary.toolErrors++;
          inc(summary.toolErrorsByName, name);
          recordError(name, content);
        }
        if ((outcomeRank[outcome] || 0) > (outcomeRank[previous.outcome] || 0)) {
          recordOutcome(name, previous.outcome, -1);
          recordOutcome(name, outcome, 1);
          previous.outcome = outcome;
        }
        return;
      }
      summary.toolResults++;
      if (!mapped) summary.resultIntegrity.unmatchedResults++;
      if (resultId) results.set(resultId, { isError: Boolean(isError), outcome });
      recordOutcome(name, outcome);
      if (isError) {
        summary.toolErrors++;
        inc(summary.toolErrorsByName, name);
        recordError(name, content);
      }
    },
    finalize() {
      for (const callId of calls.keys()) if (!results.has(callId)) summary.resultIntegrity.unmatchedCalls++;
    },
  };
}

function analyzeClaudeRow(row, summary, recorder, salt) {
  const message = row?.message;
  recordTimestamp(summary, row?.timestamp || message?.timestamp);
  const role = message?.role || (row?.type === "assistant" || row?.type === "user" ? row.type : "");
  if (role === "assistant") summary.assistantTurns++;
  if (role === "user") {
    const text = textFromContent(message?.content);
    if (text) analyzeUserText(summary, text, salt);
  }
  const parts = Array.isArray(message?.content) ? message.content : [];
  for (const part of parts) {
    if (part?.type === "tool_use") recorder.call(part.id, part.name, part.input);
    if (part?.type === "tool_result") recorder.result(part.tool_use_id, "", part.is_error === true, part.content, part.details);
  }
  const attributedSkill = safeLabel(row?.attributionSkill, salt, "skill");
  if (attributedSkill) inc(summary.skillAttributions, attributedSkill);
}

function analyzeCodexRow(row, summary, recorder, salt) {
  const payload = row?.payload || {};
  recordTimestamp(summary, row?.timestamp || payload?.timestamp);
  if (row?.type === "response_item" && payload.type === "message") {
    if (payload.role === "assistant") summary.assistantTurns++;
    if (payload.role === "user") analyzeUserText(summary, textFromContent(payload.content), salt);
  }
  if (row?.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload.type)) recorder.call(payload.call_id, payload.name, payload.arguments ?? payload.input);
  if (row?.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(payload.type)) recorder.result(payload.call_id, "", false, payload.output, payload.details);
  if (row?.type === "event_msg" && payload.type === "exec_command_end") recorder.result(payload.call_id, "exec_command", Number(payload.exit_code) !== 0 || payload.status === "failed", payload, payload);
  if (row?.type === "event_msg" && payload.type === "patch_apply_end") recorder.result(payload.call_id, "apply_patch", payload.success === false || payload.status === "failed", payload, payload);
  if (row?.type === "event_msg" && /(?:collab|web_search).*_end$/.test(String(payload.type || "")) && payload.status === "failed") recorder.result(payload.call_id, "", true, payload, payload);
}

function analyzePiRow(row, summary, recorder, salt) {
  const message = row?.message;
  recordTimestamp(summary, row?.timestamp || message?.timestamp);
  if (row?.type !== "message" || !message) return;
  summary.lastMessageRole = String(message.role || "unknown");
  if (message.role === "assistant") {
    summary.assistantTurns++;
    const stopReason = String(message.stopReason || "missing");
    summary.lastAssistantStopReason = stopReason;
    inc(summary.assistantStopReasons, stopReason);
    if (["error", "aborted"].includes(stopReason)) {
      inc(summary.providerErrors, classifyProviderError(message.errorMessage));
      summary.providerErrorPending = true;
    } else if (summary.providerErrorPending) {
      summary.providerErrorPending = false;
    }
  }
  if (message.role === "user") analyzeUserText(summary, textFromContent(message.content), salt);
  if (message.role === "toolResult") recorder.result(message.toolCallId, message.toolName, message.isError === true, message.content, message.details);
  const parts = Array.isArray(message.content) ? message.content : [];
  for (const part of parts) if (part?.type === "toolCall") recorder.call(part.id, part.name, part.arguments);
}

function forEachJsonLine(file, callback) {
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let pending = "";
  try {
    while (true) {
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!bytes) break;
      pending += chunk.toString("utf8", 0, bytes);
      let start = 0;
      while (true) {
        const end = pending.indexOf("\n", start);
        if (end < 0) break;
        callback(pending.slice(start, end));
        start = end + 1;
      }
      pending = pending.slice(start);
      if (Buffer.byteLength(pending) > MAX_JSON_LINE_BYTES) { callback(null); pending = ""; }
    }
    if (pending) callback(pending);
  } finally { fs.closeSync(fd); }
}

function analyzeSessionFile(source, file, fileId, stat, salt, options = {}) {
  const summary = createFileSummary(source, fileId, stat);
  const recorder = createToolRecorder(summary, salt);
  const sinceMs = options.sinceAt == null ? -Infinity : Date.parse(options.sinceAt);
  const untilMs = options.untilAt == null ? Infinity : Date.parse(options.untilAt);
  const includeUndatedRows = options.includeUndatedRows === true;
  forEachJsonLine(file, (line) => {
    if (line === null) { summary.oversizedRows++; return; }
    if (!line.trim()) return;
    summary.rowsRead++;
    let row;
    try { row = JSON.parse(line); } catch { summary.invalidRows++; return; }
    if (!row || typeof row !== "object") { summary.undatedRows++; return; }
    const at = rowTimestampMs(row);
    if (Number.isFinite(at)) {
      if (at < sinceMs) { summary.rowsBeforeWindow++; return; }
      if (at > untilMs) { summary.rowsAfterWindow++; return; }
      summary.timestampedRows++;
    } else {
      summary.undatedRows++;
      if (!includeUndatedRows) return;
      summary.countedUndatedRows++;
    }
    summary.rows++;
    recordSessionKind(summary, row);
    if (source === "claude") analyzeClaudeRow(row, summary, recorder, salt);
    else if (source === "codex") analyzeCodexRow(row, summary, recorder, salt);
    else analyzePiRow(row, summary, recorder, salt);
  });
  recorder.finalize();
  if (source === "pi") {
    if (summary.lastMessageRole === "assistant") {
      if (["error", "aborted"].includes(summary.lastAssistantStopReason)) summary.terminalState = "provider-failure";
      else if (summary.lastAssistantStopReason === "toolUse") summary.terminalState = "tool-call-pending";
      else if (summary.lastAssistantStopReason === "length") summary.terminalState = "length-limited";
      else if (summary.lastAssistantStopReason === "stop") summary.terminalState = "completed";
      else summary.terminalState = "assistant-other";
    } else if (summary.lastMessageRole === "toolResult") summary.terminalState = "tool-result-pending";
    else if (summary.lastMessageRole === "user") summary.terminalState = "user-pending";
    else if (summary.lastMessageRole) summary.terminalState = "other-message";
  }
  return summary;
}

function listJsonlFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
    }
  }
  return files;
}

function aggregateSummaries(summaries, options = {}) {
  const corpus = {};
  const tools = {};
  const toolErrors = {};
  const toolSources = {};
  const toolOutcomes = Object.fromEntries(CANONICAL_OUTCOMES.map((outcome) => [outcome, 0]));
  const toolOutcomesByName = {};
  const resultIntegrity = { duplicateCalls: 0, duplicateResults: 0, unmatchedCalls: 0, unmatchedResults: 0 };
  const sessionKinds = {};
  const toolErrorCategories = {};
  const toolErrorCategoryTools = {};
  const shellFamilies = {};
  const skills = {};
  const skillAttributions = {};
  const corrections = {};
  const promptHashes = {};
  const workflows = {};
  const workflowSessions = {};
  const assistantStopReasons = {};
  const providerErrors = {};
  const providerErrorSessions = {};
  const terminalStates = {};
  const staleTerminalStates = {};
  const nowMs = new Date(options.now || Date.now()).getTime();
  const terminalStaleMs = Math.max(0, Number(options.terminalStaleMs ?? 60 * 60_000));
  let providerAffectedSessions = 0;
  let providerRecoveredSessions = 0;
  let providerTerminalFailedSessions = 0;
  let providerUnresolvedSessions = 0;
  let earliestAt = null;
  let latestAt = null;
  const windowRows = { read: 0, counted: 0, timestamped: 0, undated: 0, countedUndated: 0, beforeWindow: 0, afterWindow: 0, invalid: 0, oversized: 0, filesWithoutCountedRows: 0 };
  for (const summary of summaries) {
    windowRows.read += Number(summary.rowsRead || 0);
    windowRows.counted += Number(summary.rows || 0);
    windowRows.timestamped += Number(summary.timestampedRows || 0);
    windowRows.undated += Number(summary.undatedRows || 0);
    windowRows.countedUndated += Number(summary.countedUndatedRows || 0);
    windowRows.beforeWindow += Number(summary.rowsBeforeWindow || 0);
    windowRows.afterWindow += Number(summary.rowsAfterWindow || 0);
    windowRows.invalid += Number(summary.invalidRows || 0);
    windowRows.oversized += Number(summary.oversizedRows || 0);
    if (!Number(summary.rows || 0)) { windowRows.filesWithoutCountedRows++; continue; }
    const providerErrorCount = Object.values(summary.providerErrors || {}).reduce((sum, value) => sum + Number(value || 0), 0);
    const bucket = corpus[summary.source] ||= { sessions: 0, bytes: 0, rows: 0, invalidRows: 0, userTurns: 0, assistantTurns: 0, providerErrors: 0, toolCalls: 0, toolResults: 0, toolErrors: 0, toolSemanticFailures: 0 };
    bucket.sessions++;
    inc(sessionKinds, summary.sessionKind || "unknown");
    for (const key of ["size", "rows", "invalidRows", "userTurns", "assistantTurns", "toolCalls", "toolResults", "toolErrors", "toolSemanticFailures"]) bucket[key === "size" ? "bytes" : key] += Number(summary[key] || 0);
    bucket.providerErrors += providerErrorCount;
    if (summary.earliestAt && (!earliestAt || summary.earliestAt < earliestAt)) earliestAt = summary.earliestAt;
    if (summary.latestAt && (!latestAt || summary.latestAt > latestAt)) latestAt = summary.latestAt;
    mergeCounts(tools, summary.tools); mergeCounts(toolErrors, summary.toolErrorsByName); mergeCounts(toolOutcomes, summary.toolOutcomes); mergeNestedCounts(toolOutcomesByName, summary.toolOutcomesByName); mergeCounts(resultIntegrity, summary.resultIntegrity); mergeCounts(toolErrorCategories, summary.toolErrorCategories); mergeCounts(shellFamilies, summary.shellFamilies); mergeCounts(skills, summary.skills); mergeCounts(skillAttributions, summary.skillAttributions); mergeCounts(corrections, summary.corrections); mergeCounts(promptHashes, summary.promptHashes); mergeCounts(workflows, summary.workflows);
    for (const name of Object.keys(summary.tools || {})) { const bySource = toolSources[name] ||= {}; inc(bySource, summary.source, summary.tools[name]); }
    for (const [tool, categories] of Object.entries(summary.toolErrorCategoriesByName || {})) {
      for (const [category, count] of Object.entries(categories || {})) {
        const byTool = toolErrorCategoryTools[category] ||= {};
        inc(byTool, tool, Number(count) || 0);
      }
    }
    for (const name of Object.keys(summary.workflows || {})) inc(workflowSessions, name);
    if (summary.source === "pi") {
      mergeCounts(assistantStopReasons, summary.assistantStopReasons);
      mergeCounts(providerErrors, summary.providerErrors);
      for (const category of Object.keys(summary.providerErrors || {})) inc(providerErrorSessions, category);
      inc(terminalStates, summary.terminalState);
      const stale = Number.isFinite(nowMs) && nowMs - Number(summary.mtimeMs || 0) >= terminalStaleMs;
      if (stale && !["completed", "length-limited"].includes(summary.terminalState)) inc(staleTerminalStates, summary.terminalState);
      if (providerErrorCount > 0) {
        providerAffectedSessions++;
        if (!summary.providerErrorPending) providerRecoveredSessions++;
        else if (summary.terminalState === "provider-failure") providerTerminalFailedSessions++;
        else providerUnresolvedSessions++;
      }
    }
  }
  for (const bucket of Object.values(corpus)) {
    bucket.toolErrorRate = safeRate(bucket.toolErrors, bucket.toolResults || bucket.toolCalls);
    bucket.toolSemanticFailureRate = safeRate(bucket.toolSemanticFailures, bucket.toolResults || bucket.toolCalls);
  }
  const total = Object.values(corpus).reduce((acc, item) => { for (const key of ["sessions", "bytes", "rows", "invalidRows", "userTurns", "assistantTurns", "providerErrors", "toolCalls", "toolResults", "toolErrors", "toolSemanticFailures"]) acc[key] += item[key] || 0; return acc; }, { sessions: 0, bytes: 0, rows: 0, invalidRows: 0, userTurns: 0, assistantTurns: 0, providerErrors: 0, toolCalls: 0, toolResults: 0, toolErrors: 0, toolSemanticFailures: 0 });
  total.toolErrorRate = safeRate(total.toolErrors, total.toolResults || total.toolCalls);
  total.toolSemanticFailureRate = safeRate(total.toolSemanticFailures, total.toolResults || total.toolCalls);
  const toolRows = Object.entries(tools).map(([name, count]) => ({ name, count, errors: toolErrors[name] || 0, errorRate: safeRate(toolErrors[name] || 0, count), outcomes: toolOutcomesByName[name] || {}, per100UserTurns: Number((100 * count / Math.max(1, total.userTurns)).toFixed(2)), sources: toolSources[name] || {} })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, options.toolLimit || 100);
  const repeated = Object.values(promptHashes).filter((count) => count >= 2);
  return {
    corpus,
    total,
    earliestAt,
    latestAt,
    window: {
      sinceAt: options.sinceAt || null,
      untilAt: options.untilAt || null,
      includeUndatedRows: options.includeUndatedRows === true,
      ...windowRows,
      earliestCountedAt: earliestAt,
      latestCountedAt: latestAt,
      countedTimestampsInsideWindow: (!earliestAt || !options.sinceAt || earliestAt >= options.sinceAt) && (!latestAt || !options.untilAt || latestAt <= options.untilAt),
    },
    tools: toolRows,
    semanticOutcomes: { schemaVersion: OUTCOME_SCHEMA_VERSION, counts: toolOutcomes, reliabilityFailures: total.toolSemanticFailures, domainNegatives: toolOutcomes["domain-negative"] || 0 },
    resultIntegrity,
    sessionKinds: sortedCounts(sessionKinds, 10),
    toolFailureCategories: sortedCounts(toolErrorCategories, options.toolErrorCategoryLimit || 30).map((row) => ({ ...row, tools: sortedCounts(toolErrorCategoryTools[row.name], 10) })),
    providerReliability: {
      messages: Object.values(providerErrors).reduce((sum, value) => sum + value, 0),
      affectedSessions: providerAffectedSessions,
      recoveredSessions: providerRecoveredSessions,
      terminalFailedSessions: providerTerminalFailedSessions,
      unresolvedSessions: providerUnresolvedSessions,
      categories: sortedCounts(providerErrors, 30).map((row) => ({ ...row, sessions: providerErrorSessions[row.name] || 0 })),
      assistantStopReasons: sortedCounts(assistantStopReasons, 20),
      terminalStates: sortedCounts(terminalStates, 20),
      staleTerminalStates: sortedCounts(staleTerminalStates, 20),
    },
    shellFamilies: sortedCounts(shellFamilies, options.shellLimit || 60).map((row) => ({ ...row, per100UserTurns: Number((100 * row.count / Math.max(1, total.userTurns)).toFixed(2)) })),
    skills: sortedCounts(skills, options.skillLimit || 60),
    skillAttributions: sortedCounts(skillAttributions, options.skillLimit || 60),
    correctionSignals: { ...corrections, total: Object.values(corrections).reduce((sum, value) => sum + value, 0), per100UserTurns: Number((100 * Object.values(corrections).reduce((sum, value) => sum + value, 0) / Math.max(1, total.userTurns)).toFixed(2)) },
    repeatedPrompts: { groups: repeated.length, occurrences: repeated.reduce((sum, count) => sum + count, 0), maxRepeat: repeated.length ? Math.max(...repeated) : 0 },
    workflows: Object.entries(workflows).map(([sequence, count]) => ({ sequence, count, sessions: workflowSessions[sequence] || 0 })).sort((a, b) => b.count - a.count || a.sequence.localeCompare(b.sequence)).slice(0, options.workflowLimit || 40),
  };
}

function candidate(idInput, input) { return { candidateId: `session_candidate_${sha(idInput, 16)}`, ...input }; }
function deriveCandidates(aggregate, options = {}) {
  const candidates = [];
  const minToolCalls = clamp(options.minToolCalls ?? 10, 1, 1_000_000);
  const minToolErrors = clamp(options.minToolErrors ?? 3, 1, 1_000_000);
  const minToolErrorRate = clamp(options.minToolErrorRate ?? 0.08, 0, 1);
  const minShellCount = clamp(options.minShellCount ?? 12, 1, 1_000_000);
  const minWorkflowCount = clamp(options.minWorkflowCount ?? 20, 1, 1_000_000);
  for (const tool of aggregate.tools) {
    const notApplicable = Number(tool.outcomes?.["not-applicable"] || 0);
    const applicableCalls = Math.max(0, Number(tool.count || 0) - notApplicable);
    const reliabilityFailures = (tool.outcomes?.["infrastructure-failed"] || 0) + (tool.outcomes?.["timed-out"] || 0);
    const failures = reliabilityFailures;
    const failureRate = safeRate(failures, applicableCalls);
    if (applicableCalls >= minToolCalls && failures >= minToolErrors && failureRate >= minToolErrorRate) candidates.push(candidate(`tool-failure:${tool.name}`, {
      kind: "tool-friction", classification: "tool-failure", severity: failureRate >= 0.25 ? "high" : "medium",
      title: `Reduce repeated ${tool.name} failures`, evidence: { tool: tool.name, calls: applicableCalls, totalCalls: tool.count, notApplicable, reliabilityFailures, failureRate, sources: tool.sources },
      suggestedAction: "Inspect redacted failure categories, harden the tool or workflow, then verify the failure rate falls in a later scan.",
    }));
  }
  const providerCounts = Object.fromEntries((aggregate.providerReliability?.categories || []).map((row) => [row.name, row.count]));
  const transientProviderErrors = (providerCounts.transport || 0) + (providerCounts.timeout || 0) + (providerCounts["provider-server"] || 0);
  if (transientProviderErrors >= 3 && (aggregate.providerReliability?.affectedSessions || 0) >= 2) candidates.push(candidate("provider-instability:pi", {
    kind: "provider-instability", classification: "provider-failure", severity: transientProviderErrors >= 20 || aggregate.providerReliability.terminalFailedSessions >= 3 ? "high" : "medium",
    title: "Reduce recurring Pi provider transport failures",
    evidence: { transientErrors: transientProviderErrors, affectedSessions: aggregate.providerReliability.affectedSessions, recoveredSessions: aggregate.providerReliability.recoveredSessions, terminalFailedSessions: aggregate.providerReliability.terminalFailedSessions, unresolvedSessions: aggregate.providerReliability.unresolvedSessions, categories: aggregate.providerReliability.categories },
    suggestedAction: "Review transport fallback and bounded retry behavior, then compare provider-error and stale-terminal rates in the next scan.",
  }));
  const toolCounts = Object.fromEntries(aggregate.tools.map((row) => [row.name, row.count]));
  const shellCounts = Object.fromEntries(aggregate.shellFamilies.map((row) => [row.name, row.count]));
  const mapped = new Map();
  for (const [family, nativeTool] of Object.entries(NATIVE_EQUIVALENTS)) {
    const count = shellCounts[family] || 0;
    if (count < minShellCount) continue;
    const row = mapped.get(nativeTool) || { families: [], legacyCalls: 0 };
    row.families.push({ family, count }); row.legacyCalls += count; mapped.set(nativeTool, row);
  }
  for (const [nativeTool, evidence] of mapped) {
    const nativeCalls = toolCounts[nativeTool] || 0;
    if (nativeCalls * 2 >= evidence.legacyCalls) continue;
    candidates.push(candidate(`native-adoption:${nativeTool}`, {
      kind: "automation-adoption", classification: "workflow-repetition", severity: evidence.legacyCalls >= minShellCount * 4 ? "high" : "medium",
      title: `Prefer ${nativeTool} over repeated shell rituals`, evidence: { ...evidence, nativeTool, nativeCalls },
      suggestedAction: `Improve model guidance or the ${nativeTool} fast path, then compare legacy/native call rates in the next scan.`,
    }));
  }
  if (aggregate.repeatedPrompts.maxRepeat >= 5) candidates.push(candidate("repeated-prompts", {
    kind: "workflow-repetition", classification: "workflow-repetition", severity: aggregate.repeatedPrompts.maxRepeat >= 20 ? "high" : "medium",
    title: "Automate a repeatedly requested workflow", evidence: aggregate.repeatedPrompts,
    suggestedAction: "Inspect the repeated prompt family locally, build a tool-first fast path, and verify adoption without storing prompt text.",
  }));
  const correctionTotal = aggregate.correctionSignals.total || 0;
  if (correctionTotal >= 5 && aggregate.correctionSignals.per100UserTurns >= 1) candidates.push(candidate("user-corrections", {
    kind: "instruction-friction", classification: "user-correction", severity: aggregate.correctionSignals.per100UserTurns >= 5 ? "high" : "medium",
    title: "Reduce repeated user corrections and instruction misses", evidence: aggregate.correctionSignals,
    suggestedAction: "Review correction categories against workflow guidance, make the smallest reviewed prompt/tool change, and compare the next window.",
  }));
  const explicitSkillUses = aggregate.skills.reduce((sum, row) => sum + row.count, 0);
  if (aggregate.total.userTurns >= 100 && explicitSkillUses < aggregate.total.userTurns * 0.01) candidates.push(candidate("skill-adoption", {
    kind: "skill-adoption", classification: "skill-adoption-gap", severity: "medium",
    title: "Measure and improve explicit skill adoption", evidence: { userTurns: aggregate.total.userTurns, explicitSkillUses, usesPer100UserTurns: Number((100 * explicitSkillUses / aggregate.total.userTurns).toFixed(2)) },
    suggestedAction: "Review selector relevance and skill telemetry before changing prompts; prefer fewer high-precision skill suggestions over more noise.",
  }));
  const workflow = aggregate.workflows.find((row) => row.count >= minWorkflowCount && row.sessions >= 2);
  if (workflow) candidates.push(candidate(`workflow:${workflow.sequence}`, {
    kind: "workflow-repetition", classification: "workflow-repetition", severity: workflow.count >= minWorkflowCount * 4 ? "high" : "medium",
    title: "Compress a repeated three-tool workflow", evidence: workflow,
    suggestedAction: "Determine whether a project tool or reusable skill can replace this repeated sequence, then verify with an adoption trend.",
  }));
  const severityOrder = { high: 0, medium: 1, low: 2 };
  return candidates.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9) || a.title.localeCompare(b.title));
}

function trendFrom(previous, aggregate, candidates, cohort) {
  if (!previous) return { baseline: true, comparisonReason: "no-previous-report", previousGeneratedAt: null, changedCohortFields: [], candidateChanges: [] };
  if (previous.schemaVersion !== SCHEMA_VERSION || !previous.aggregate?.total) return { baseline: true, comparisonReason: "schema-version-mismatch", previousGeneratedAt: previous.generatedAt || null, changedCohortFields: [], candidateChanges: [] };
  const comparison = compareCohortContracts(previous.cohort, cohort);
  if (!comparison.compatible) return { baseline: true, comparisonReason: comparison.reason, previousGeneratedAt: previous.generatedAt || null, changedCohortFields: comparison.changedFields, candidateChanges: [] };
  const before = previous.aggregate.total;
  const candidateBefore = new Set((previous.candidates || []).map((row) => row.candidateId));
  const candidateNow = new Set(candidates.map((row) => row.candidateId));
  return {
    baseline: false,
    comparisonReason: comparison.reason,
    previousGeneratedAt: previous.generatedAt,
    changedCohortFields: [],
    userTurnsDelta: aggregate.total.userTurns - (before.userTurns || 0),
    toolErrorRateDelta: Number((aggregate.total.toolErrorRate - (before.toolErrorRate || 0)).toFixed(4)),
    correctionRateDelta: Number((aggregate.correctionSignals.per100UserTurns - (previous.aggregate.correctionSignals?.per100UserTurns || 0)).toFixed(2)),
    candidateChanges: [
      ...Array.from(candidateNow).filter((id) => !candidateBefore.has(id)).map((candidateId) => ({ candidateId, status: "new" })),
      ...Array.from(candidateBefore).filter((id) => !candidateNow.has(id)).map((candidateId) => ({ candidateId, status: "cleared" })),
    ],
  };
}

function compactHistoryEntry(report) {
  return { schemaVersion: report.schemaVersion, classifier: report.classifier, cohort: report.cohort, reportId: report.reportId, generatedAt: report.generatedAt, windowDays: report.windowDays, total: report.aggregate.total, semanticOutcomes: report.aggregate.semanticOutcomes, resultIntegrity: report.aggregate.resultIntegrity, sessionKinds: report.aggregate.sessionKinds, extensionTelemetry: report.extensionTelemetry, providerReliability: report.aggregate.providerReliability, toolFailureCategories: report.aggregate.toolFailureCategories, correctionSignals: report.aggregate.correctionSignals, repeatedPrompts: report.aggregate.repeatedPrompts, candidates: report.candidates.map(({ candidateId, kind, classification, severity, title }) => ({ candidateId, kind, classification, severity, title })), trend: report.trend };
}

function writeHistory(file, entry) {
  let rows = [];
  try { rows = fs.readFileSync(file, "utf8").split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)); } catch {}
  rows.push(entry);
  rows = rows.slice(-MAX_HISTORY);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function acquireLock(file, staleMs = 15 * 60_000) {
  ensureDir(path.dirname(file));
  try { const fd = fs.openSync(file, "wx", 0o600); fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`); fs.closeSync(fd); return true; }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    try { if (Date.now() - fs.statSync(file).mtimeMs > staleMs) { fs.unlinkSync(file); return acquireLock(file, staleMs); } } catch {}
    return false;
  }
}

function mineAgentSessions(options = {}) {
  const started = Date.now();
  const cwd = path.resolve(options.cwd || process.cwd());
  const stateDir = path.resolve(options.stateDir || path.join(cwd, ".pi", "session-mining"));
  const stateFile = path.join(stateDir, "state.json");
  const latestFile = path.join(stateDir, "latest.json");
  const historyFile = path.join(stateDir, "history.jsonl");
  const lockFile = path.join(stateDir, "scan.lock");
  if (!acquireLock(lockFile)) throw new Error("session mining scan already in progress");
  try {
    const previous = readJson(latestFile, null);
    const state = readJson(stateFile, { schemaVersion: SCHEMA_VERSION, salt: crypto.randomBytes(32).toString("hex"), files: {} });
    if (!state.salt) state.salt = crypto.randomBytes(32).toString("hex");
    if (state.schemaVersion !== SCHEMA_VERSION) { state.schemaVersion = SCHEMA_VERSION; state.files = {}; }
    const roots = options.roots || defaultSessionRoots(options.env || process.env, options.home || os.homedir());
    const cohort = buildCohortContract({ ...options, cwd });
    const windowDays = cohort.windowDays;
    const scanNowMs = Date.parse(cohort.untilAt);
    const cutoffMs = Date.parse(cohort.sinceAt);
    const maxBytes = clamp(positiveNumber(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes"), 1024, Number.MAX_SAFE_INTEGER);
    const discovered = [];
    const rootsStatus = {};
    for (const source of ["claude", "codex", "pi"]) {
      const root = roots[source];
      const files = root && fs.existsSync(root) ? listJsonlFiles(root) : [];
      rootsStatus[source] = { available: Boolean(root && fs.existsSync(root)), discoveredFiles: files.length };
      for (const file of files) {
        let stat; try { stat = fs.statSync(file); } catch { continue; }
        if (stat.mtimeMs < cutoffMs) continue;
        discovered.push({ source, file, stat, fileId: hmac(state.salt, `${source}:${path.resolve(file)}`, 24) });
      }
    }
    discovered.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.fileId.localeCompare(b.fileId));
    const selected = [];
    let selectedBytes = 0;
    for (const item of discovered) {
      if (selected.length && selectedBytes + item.stat.size > maxBytes) continue;
      selected.push(item); selectedBytes += item.stat.size;
    }
    const nextFiles = {};
    const summaries = [];
    let scannedFiles = 0; let reusedFiles = 0; let bytesRead = 0;
    for (const item of selected) {
      const cached = !options.force ? state.files[item.fileId] : null;
      const reusable = cached?.summary?.schemaVersion === SCHEMA_VERSION && cached.cohortKey === cohort.key && cached.size === item.stat.size && cached.mtimeMs === Math.round(item.stat.mtimeMs) && (item.source !== "pi" || typeof cached.summary.providerErrorPending === "boolean");
      const summary = reusable ? cached.summary : analyzeSessionFile(item.source, item.file, item.fileId, item.stat, state.salt, { sinceAt: cohort.sinceAt, untilAt: cohort.untilAt, includeUndatedRows: options.includeUndatedRows === true });
      if (reusable) reusedFiles++; else { scannedFiles++; bytesRead += item.stat.size; }
      summaries.push(summary);
      nextFiles[item.fileId] = { source: item.source, size: item.stat.size, mtimeMs: Math.round(item.stat.mtimeMs), cohortKey: cohort.key, summary };
    }
    state.files = nextFiles;
    state.lastScanAt = options.now ? new Date(options.now).toISOString() : nowIso();
    const aggregate = aggregateSummaries(summaries, { ...options, sinceAt: cohort.sinceAt, untilAt: cohort.untilAt });
    const extensionTelemetry = readExtensionTelemetry({ cwd, stateDir: options.telemetryStateDir, file: options.telemetryFile, sinceAt: new Date(cutoffMs).toISOString(), untilAt: new Date(scanNowMs).toISOString() });
    const candidates = deriveCandidates(aggregate, options.thresholds || {});
    const generatedAt = state.lastScanAt;
    const reportId = `session_report_${sha({ cohortKey: cohort.key, classifierVersion: CLASSIFIER_VERSION, windowDays, total: aggregate.total, semanticOutcomes: aggregate.semanticOutcomes, resultIntegrity: aggregate.resultIntegrity, sessionKinds: aggregate.sessionKinds, extensionTelemetry, tools: aggregate.tools, toolFailureCategories: aggregate.toolFailureCategories, providerReliability: aggregate.providerReliability, shellFamilies: aggregate.shellFamilies, skills: aggregate.skills, skillAttributions: aggregate.skillAttributions, corrections: aggregate.correctionSignals, candidates: candidates.map((row) => row.candidateId) }, 16)}`;
    const report = {
      schemaVersion: SCHEMA_VERSION,
      classifier: { version: CLASSIFIER_VERSION, outcomeSchemaVersion: OUTCOME_SCHEMA_VERSION, sessionKindPolicyVersion: SESSION_KIND_POLICY_VERSION, sources: ["structured-tool-details", "transport-isError", "explicit-session-markers"] },
      cohort,
      reportId,
      generatedAt,
      windowDays,
      scan: { roots: rootsStatus, mtimeEligibleFiles: discovered.length, selectedFiles: selected.length, scannedFiles, reusedFiles, skippedByBudget: discovered.length - selected.length, selectedBytes, bytesRead, durationMs: Date.now() - started, rowWindowApplied: true },
      privacy: { redacted: true, containsTranscript: false, containsPaths: false, containsCommands: false, promptFingerprints: "HMAC-SHA256 with a local non-exported salt", persistedFields: "aggregate counts, canonical outcomes, result-integrity counters, session categories, fixed error/terminal categories, identifiers, hashes, candidate summaries" },
      aggregate,
      extensionTelemetry,
      candidates,
      trend: trendFrom(previous, aggregate, candidates, cohort),
    };
    writeJsonAtomic(stateFile, state);
    writeJsonAtomic(latestFile, report);
    writeHistory(historyFile, compactHistoryEntry(report));
    return report;
  } finally { try { fs.unlinkSync(lockFile); } catch {} }
}

function readSessionMiningReport(cwd = process.cwd(), stateDir) { return readJson(path.join(stateDir || path.join(cwd, ".pi", "session-mining"), "latest.json"), null); }

function sessionMiningOutcomes(report) {
  if (!report) return [];
  const dayBucket = String(report.generatedAt || "unknown-day").slice(0, 10);
  return (report.candidates || []).map((item) => ({
    outcomeId: `outcome_session_${sha(`${item.candidateId}:${dayBucket}`, 16)}`,
    source: "session-mining",
    task: { summary: item.title },
    summary: `${item.title}. ${item.suggestedAction}`,
    signals: { status: "unknown", evidenceLevel: "tool-output" },
    artifacts: { evidenceRefs: [`session-mining:${report.reportId}`, item.candidateId] },
    classifications: [`session-candidate:${item.candidateId}:${item.classification}`],
  }));
}

function formatSessionMiningReport(report) {
  if (!report) return "No session-mining report. Run /learning-scan-sessions first.";
  const t = report.aggregate.total;
  const reliability = report.aggregate.providerReliability || {};
  const staleTerminals = (reliability.staleTerminalStates || []).reduce((sum, row) => sum + row.count, 0);
  const lines = [
    `Session mining ${report.reportId} (${report.windowDays}d window)`,
    `sessions=${t.sessions}; user turns=${t.userTurns}; tool calls=${t.toolCalls}; isError envelopes=${t.toolErrors} (${(100 * t.toolErrorRate).toFixed(1)}%); infrastructure failures=${t.toolSemanticFailures} (${(100 * t.toolSemanticFailureRate).toFixed(1)}%)`,
    `Pi provider errors=${reliability.messages || 0}; affected sessions=${reliability.affectedSessions || 0}; recovered=${reliability.recoveredSessions || 0}; terminal failures=${reliability.terminalFailedSessions || 0}; unresolved=${reliability.unresolvedSessions || 0}; stale pending/failed=${staleTerminals}`,
    `scan: selected=${report.scan.selectedFiles}; rescanned=${report.scan.scannedFiles}; cache hits=${report.scan.reusedFiles}; bytes read=${report.scan.bytesRead}`,
    `strict rows: counted=${report.aggregate.window?.counted || 0}; undated excluded=${(report.aggregate.window?.undated || 0) - (report.aggregate.window?.countedUndated || 0)}; before=${report.aggregate.window?.beforeWindow || 0}; after=${report.aggregate.window?.afterWindow || 0}; earliest=${report.aggregate.window?.earliestCountedAt || "none"}; latest=${report.aggregate.window?.latestCountedAt || "none"}`,
    `session kinds=${report.aggregate.sessionKinds.map((row) => `${row.name}:${row.count}`).join(",") || "none"}; result mismatches=${Object.values(report.aggregate.resultIntegrity || {}).reduce((sum, value) => sum + Number(value || 0), 0)}`,
    `extension telemetry events=${report.extensionTelemetry?.eventCount || 0}; model-tool eligible=${report.extensionTelemetry?.modelTools?.eligible || 0}; unknown=${report.extensionTelemetry?.modelTools?.unknown || 0} (${(100 * (report.extensionTelemetry?.modelTools?.unknownRate || 0)).toFixed(1)}%); injected chars=${report.extensionTelemetry?.contextInjections?.chars || 0}`,
    `skills=${report.aggregate.skills.reduce((sum, row) => sum + row.count, 0)}; repeated prompt groups=${report.aggregate.repeatedPrompts.groups}; correction signals=${report.aggregate.correctionSignals.total}`,
    `privacy: aggregate-only; no transcript text, paths, commands, arguments, outputs, or reasoning persisted`,
  ];
  if (report.candidates.length) lines.push("", "Improvement candidates:", ...report.candidates.map((item) => `- [${item.severity}] ${item.candidateId}: ${item.title}`));
  else lines.push("", "No candidate crossed the configured evidence thresholds.");
  if (!report.trend.baseline) lines.push("", `Trend vs ${report.trend.previousGeneratedAt}: tool-error-rate Δ=${report.trend.toolErrorRateDelta}; correction-rate Δ=${report.trend.correctionRateDelta}`);
  else lines.push("", `Trend baseline: ${report.trend.comparisonReason || "not-comparable"}${report.trend.changedCohortFields?.length ? ` (${report.trend.changedCohortFields.join(",")})` : ""}`);
  return lines.join("\n");
}

module.exports = {
  SCHEMA_VERSION,
  CLASSIFIER_VERSION,
  COHORT_CONTRACT_VERSION,
  SESSION_KIND_POLICY_VERSION,
  ROW_WINDOW_POLICY_VERSION,
  buildCohortContract,
  compareCohortContracts,
  defaultSessionRoots,
  commandFamilies,
  classifyProviderError,
  classifyToolError,
  structuredToolDetails,
  mineAgentSessions,
  readSessionMiningReport,
  sessionMiningOutcomes,
  formatSessionMiningReport,
  deriveCandidates,
};
