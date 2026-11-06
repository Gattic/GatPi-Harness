"use strict";

const DEFAULT_SUMMARY_MAX_CHARS = 24_000;
const DEFAULT_ITEM_MAX_CHARS = 1_200;
const DEFAULT_ITEMS_PER_SECTION = 8;
const DEFAULT_MAX_FILE_PATHS = 200;
const DEFAULT_MAX_FILE_CHARS = 12_000;
const DEFAULT_PROACTIVE_MAX_CHARS = 8 * 1024 * 1024;
const DEFAULT_PROACTIVE_USAGE_PERCENT = 80;

function positiveInt(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
}

function truncateMiddle(value, maxChars = DEFAULT_ITEM_MAX_CHARS) {
  const text = String(value || "").replace(/\u0000/g, "").trim();
  if (text.length <= maxChars) return text;
  const marker = `\n[… ${text.length - maxChars} chars omitted …]\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available * 0.65);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (available - head))}`;
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function assistantToolNames(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content
    .filter((block) => block && block.type === "toolCall" && typeof block.name === "string")
    .map((block) => block.name);
}

function uniqueRecent(items, limit) {
  const out = [];
  const seen = new Set();
  for (let index = items.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const item = String(items[index] || "").trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.reverse();
}

function valuesFromSet(value) {
  if (value instanceof Set) return [...value];
  if (Array.isArray(value)) return value;
  return [];
}

function collectFileLists(preparation = {}, branchEntries = [], options = {}) {
  const maxFiles = positiveInt(options.maxFiles, DEFAULT_MAX_FILE_PATHS);
  const maxFileChars = positiveInt(options.maxFileChars, DEFAULT_MAX_FILE_CHARS, 1_000);
  const read = new Set();
  const modified = new Set();
  const addPaths = (target, values) => {
    for (const value of values || []) {
      if (typeof value === "string" && value.trim()) target.add(value.trim());
    }
  };

  for (const entry of branchEntries || []) {
    if (entry?.type !== "compaction" || !entry.details || typeof entry.details !== "object") continue;
    addPaths(read, entry.details.readFiles);
    addPaths(modified, entry.details.modifiedFiles);
  }

  const fileOps = preparation.fileOps || {};
  addPaths(read, valuesFromSet(fileOps.read));
  addPaths(modified, valuesFromSet(fileOps.edited));
  addPaths(modified, valuesFromSet(fileOps.written));
  for (const file of modified) read.delete(file);

  const bounded = (values) => {
    const out = [];
    let chars = 0;
    for (const value of [...values].sort()) {
      if (out.length >= maxFiles || chars + value.length + 1 > maxFileChars) break;
      out.push(value);
      chars += value.length + 1;
    }
    return out;
  };

  return {
    readFiles: bounded(read),
    modifiedFiles: bounded(modified),
  };
}

function formatFileSections(readFiles = [], modifiedFiles = []) {
  const sections = [];
  if (readFiles.length) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length ? `\n\n${sections.join("\n\n")}` : "";
}

function appendFileSections(summary, files) {
  const clean = String(summary || "").trim();
  return `${clean}${formatFileSections(files?.readFiles, files?.modifiedFiles)}`;
}

function buildLocalRecoverySummary(preparation = {}, options = {}) {
  const maxChars = positiveInt(options.maxChars, DEFAULT_SUMMARY_MAX_CHARS, 2_000);
  const itemMaxChars = positiveInt(options.itemMaxChars, DEFAULT_ITEM_MAX_CHARS, 200);
  const itemLimit = positiveInt(options.itemLimit, DEFAULT_ITEMS_PER_SECTION);
  const messages = [
    ...(Array.isArray(preparation.messagesToSummarize) ? preparation.messagesToSummarize : []),
    ...(Array.isArray(preparation.turnPrefixMessages) ? preparation.turnPrefixMessages : []),
  ];
  const requests = [];
  const progress = [];
  const blockers = [];
  const toolNames = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = message.role;
    if (role === "user" || role === "custom") {
      const text = truncateMiddle(textContent(message.content), itemMaxChars);
      if (text) requests.push(text);
      continue;
    }
    if (role === "assistant") {
      const text = truncateMiddle(textContent(message.content), itemMaxChars);
      if (text) progress.push(text);
      toolNames.push(...assistantToolNames(message));
      if (message.stopReason === "error" && message.errorMessage) {
        blockers.push(truncateMiddle(message.errorMessage, Math.min(itemMaxChars, 600)));
      }
      continue;
    }
    if (role === "toolResult") {
      if (message.toolName) toolNames.push(message.toolName);
      if (message.isError) {
        const text = truncateMiddle(textContent(message.content), Math.min(itemMaxChars, 600));
        blockers.push(text || `${message.toolName || "Tool"} failed`);
      }
      continue;
    }
    if (role === "branchSummary" || role === "compactionSummary") {
      const text = truncateMiddle(message.summary, itemMaxChars);
      if (text) progress.push(text);
    }
  }

  const sections = [
    "## Emergency Compaction Recovery",
    "This bounded summary was generated locally because network-backed summarization was unavailable. The recent conversation suffix remains in context.",
  ];
  if (preparation.previousSummary) {
    sections.push("## Previous Summary", truncateMiddle(preparation.previousSummary, Math.max(2_000, Math.floor(maxChars * 0.45))));
  }
  if (options.customInstructions) {
    sections.push("## Recovery Focus", truncateMiddle(options.customInstructions, itemMaxChars));
  }

  const addList = (heading, values) => {
    const selected = uniqueRecent(values, itemLimit);
    if (!selected.length) return;
    sections.push(heading, selected.map((value) => `- ${value.replace(/\n+/g, "\n  ")}`).join("\n"));
  };
  addList("## Recent Requests and Constraints", requests);
  addList("## Recent Assistant Progress", progress);
  addList("## Errors and Blockers", blockers);
  const tools = uniqueRecent(toolNames, Math.max(itemLimit, 16));
  if (tools.length) sections.push("## Tool Activity", `- Tools used: ${tools.join(", ")}`);

  sections.push(
    "## Continuation State",
    `- Pre-compaction context estimate: ${Number(preparation.tokensBefore || 0).toLocaleString()} tokens.`,
    `- Split-turn recovery: ${preparation.isSplitTurn ? "yes; the retained suffix continues the interrupted turn" : "no; recent complete turns are retained"}.`,
    "- Continue from the retained suffix. Re-check repository/runtime state before repeating side effects, and do not redo work already recorded above.",
  );

  return truncateMiddle(sections.join("\n\n"), maxChars);
}

function isWebSocketSummarizationFailure(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /summari[sz]ation failed:.*websocket|websocket (?:error|closed|timeout)/i.test(message);
}

function isContextLimitError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /input exceeds (?:the )?context window|context window.*exceed|maximum context length|too many input tokens|prompt (?:is )?too (?:large|long)|request too large/i.test(message);
}

function isOutputTokenLimitError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /maximum output token limit|max(?:imum)? output tokens?|output token (?:limit|budget)/i.test(message);
}

function latestAssistantOutputLimit(branchEntries = []) {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (entry?.type !== "message") continue;
    if (entry.message?.role === "user") return undefined;
    if (entry.message?.role !== "assistant") continue;
    return entry.message.stopReason === "length" ||
      (entry.message.stopReason === "error" && isOutputTokenLimitError(entry.message.errorMessage))
      ? entry
      : undefined;
  }
  return undefined;
}

function latestAssistantContextLimit(branchEntries = []) {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (entry?.type === "compaction") return false;
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    return entry.message.stopReason === "error" && isContextLimitError(entry.message.errorMessage);
  }
  return false;
}

function isBase64ImageDataUrl(value) {
  if (typeof value !== "string") return false;
  const header = value.slice(0, 256).toLowerCase();
  return header.startsWith("data:image/") && header.includes(";base64,");
}

function boundedContextChars(value, maxChars = DEFAULT_PROACTIVE_MAX_CHARS) {
  const limit = positiveInt(maxChars, DEFAULT_PROACTIVE_MAX_CHARS, 1_000);
  const stack = [value];
  const seen = new WeakSet();
  const imagePayloadContainers = new WeakSet();
  let chars = 0;
  let nodes = 0;
  while (stack.length && chars <= limit) {
    const current = stack.pop();
    nodes += 1;
    if (typeof current === "string") { chars += current.length; continue; }
    if (current == null || typeof current === "boolean") { chars += 4; continue; }
    if (typeof current === "number" || typeof current === "bigint") { chars += String(current).length; continue; }
    if (typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Buffer.isBuffer(current)) { chars += current.length; continue; }
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    const isImageContainer = current.type === "image" || current.type === "image_url" || imagePayloadContainers.has(current);
    for (const [key, item] of Object.entries(current)) {
      chars += key.length;
      if (isImageContainer && typeof item === "string" && (key === "data" || (key === "url" && isBase64ImageDataUrl(item)))) {
        continue;
      }
      if (isImageContainer && item && typeof item === "object" && (key === "source" || key === "image_url")) {
        imagePayloadContainers.add(item);
      }
      stack.push(item);
    }
  }
  return { chars, nodes, exceeded: chars > limit, limit };
}

function proactiveCompactionDecision({
  enabled = true,
  usage,
  activeEntries,
  usagePercent = DEFAULT_PROACTIVE_USAGE_PERCENT,
  maxChars = DEFAULT_PROACTIVE_MAX_CHARS,
} = {}) {
  if (!enabled) return undefined;
  const percent = Number(usage?.percent);
  const percentThreshold = Number(usagePercent);
  if (Number.isFinite(percent) && Number.isFinite(percentThreshold) && percentThreshold > 0 && percent >= percentThreshold) return "usage-percent";
  if (activeEntries) {
    const estimate = boundedContextChars(activeEntries, maxChars);
    if (estimate.exceeded) return "active-context-size";
  }
  return undefined;
}

function compactionRecoveryDetection({
  reason,
  manualRescue = false,
  tokensBefore = 0,
  reserveTokens = 0,
  contextWindow = 0,
  usagePercent,
  branchEntries = [],
} = {}) {
  if (manualRescue) return "manual-rescue";
  if (reason === "overflow") return "provider-overflow";
  // Pi emits threshold only after its own context-pressure calculation. Handle
  // it before the default summarizer so a too-large summary request cannot
  // strand the session.
  if (reason === "threshold") return "automatic-threshold";
  if (latestAssistantContextLimit(branchEntries)) return "recent-context-error";
  if (Number.isFinite(usagePercent) && usagePercent >= 100) return "usage-over-limit";
  const window = Number(contextWindow);
  const tokens = Number(tokensBefore);
  const reserve = Math.max(0, Number(reserveTokens) || 0);
  if (window > 0 && tokens >= Math.max(1, window - reserve)) return "token-pressure";
  return undefined;
}

module.exports = {
  DEFAULT_SUMMARY_MAX_CHARS,
  DEFAULT_ITEM_MAX_CHARS,
  DEFAULT_ITEMS_PER_SECTION,
  DEFAULT_PROACTIVE_MAX_CHARS,
  DEFAULT_PROACTIVE_USAGE_PERCENT,
  appendFileSections,
  boundedContextChars,
  buildLocalRecoverySummary,
  collectFileLists,
  compactionRecoveryDetection,
  formatFileSections,
  isContextLimitError,
  isOutputTokenLimitError,
  isWebSocketSummarizationFailure,
  latestAssistantContextLimit,
  latestAssistantOutputLimit,
  proactiveCompactionDecision,
  textContent,
  truncateMiddle,
};
