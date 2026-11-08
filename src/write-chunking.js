"use strict";

// One oversized tool payload makes a single model turn spend minutes generating
// document text; those are the turns whose provider streams stall and end in
// `terminated`. Document writes therefore happen one section per turn: `write`
// creates the file with the first section, `append_file` adds each later
// section, and no single payload may exceed the limit.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SINGLE_PAYLOAD_LIMIT = 16_384;
const SINGLE_PAYLOAD_TOOLS = Object.freeze(["write", "append_file"]);

/** A limit of 0 disables enforcement; invalid values fall back to the default. */
function normalizePayloadLimit(value) {
  if (value === null || value === undefined) return DEFAULT_SINGLE_PAYLOAD_LIMIT;
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "") return DEFAULT_SINGLE_PAYLOAD_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SINGLE_PAYLOAD_LIMIT;
  return Math.floor(parsed);
}

/** The single wording of the sectioned-write rule, shared by tool guidance and the write description. */
function sectionedWriteRule(limit) {
  const normalized = normalizePayloadLimit(limit);
  if (normalized === 0) return "";
  return [
    "Write large documents in sections: create the file with write (first section),",
    `then add each later section with append_file. Keep every write or append_file payload within ${normalized} characters;`,
    "a larger payload is rejected.",
  ].join(" ");
}

function blockedPayloadReason(tool, length, limit) {
  return [
    `${tool} payload is ${length} characters, over the ${limit}-character single-payload limit.`,
    `Write the file in sections: call write once with the first section, then append_file for each later section, keeping every payload within ${limit} characters.`,
    "Do not resend the same oversized payload.",
  ].join(" ");
}

/**
 * Decide whether a tool call would send one oversized document payload.
 * Only document-writing tools are inspected; other tools pass through untouched.
 */
function evaluateSinglePayload(event = {}, options = {}) {
  const limit = normalizePayloadLimit(options.limit);
  if (limit === 0) return { ok: true, skipped: "disabled" };
  const tool = String(event.toolName || event.name || "");
  if (!SINGLE_PAYLOAD_TOOLS.includes(tool)) return { ok: true, skipped: "tool" };
  const content = (event.input || event.args || {}).content;
  if (typeof content !== "string") return { ok: true, skipped: "content" };
  if (content.length <= limit) return { ok: true, tool, length: content.length, limit };
  return {
    ok: false,
    blocked: true,
    tool,
    length: content.length,
    limit,
    reason: blockedPayloadReason(tool, content.length, limit),
  };
}

function resolveTargetPath(target, cwd) {
  const value = String(target || "").trim();
  if (!value) throw new Error("append_file requires a path");
  return path.isAbsolute(value) ? value : path.resolve(cwd || process.cwd(), value);
}

/** Read only the final byte so large files are never loaded just to check separation. */
function fileEndsWithNewline(file) {
  const size = fs.statSync(file).size;
  if (size === 0) return true;
  const fd = fs.openSync(file, "r");
  try {
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Append one section to a file, creating it and its parent directories when missing.
 * A newline separates the existing content from the new section so repeated appends
 * cannot run sections together.
 */
function appendFileSection({ path: target, content, cwd } = {}) {
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("append_file requires non-empty content");
  }
  const absolutePath = resolveTargetPath(target, cwd);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const created = !fs.existsSync(absolutePath);
  let text = content;
  if (!created && !fileEndsWithNewline(absolutePath)) text = `\n${text}`;
  if (!text.endsWith("\n")) text += "\n";
  fs.appendFileSync(absolutePath, text, "utf8");
  return { path: absolutePath, created, appendedChars: text.length };
}

module.exports = {
  DEFAULT_SINGLE_PAYLOAD_LIMIT,
  SINGLE_PAYLOAD_TOOLS,
  normalizePayloadLimit,
  sectionedWriteRule,
  evaluateSinglePayload,
  appendFileSection,
};
