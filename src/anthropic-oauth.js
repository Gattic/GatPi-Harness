"use strict";

// Anthropic OAuth payload shaping, originally ported from
// gotgenes/pi-anthropic-auth. Keep the native Pi OAuth flow and transport.
/*
MIT License

Copyright (c) 2026 pi-multi-account contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

const { createHash } = require("node:crypto");

const PI_PROMPT_PREFIX = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const PI_PROMPT_TERMINATOR = "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
const OAUTH_PROMPT_PREFIX = "You are an expert coding assistant.";
const OAUTH_PROMPT = [
  OAUTH_PROMPT_PREFIX,
  "Be concise and helpful.",
  "Use the available tools to answer the user's request.",
  "Show file paths clearly when working with files.",
].join("\n");
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI";
// Pinned request contract, not a configurable account setting.
const CLAUDE_CODE_VERSION = "2.1.288";
const BILLING_HEADER_SALT = "59cf53e54c78";
const BILLING_HEADER_POSITIONS = [4, 7, 20];
const PARAGRAPH_REMOVAL_ANCHORS = [
  "operating inside pi, a coding agent harness",
  "In addition to the tools above",
  "Pi documentation (read only when the user asks about pi itself",
];

function billingHeader(messages) {
  const firstUser = messages.find((message) => message.role === "user");
  const text = typeof firstUser?.content === "string"
    ? firstUser.content
    : firstUser?.content?.find((block) => block.type === "text" && typeof block.text === "string")?.text;
  if (!text) return undefined;
  const cch = createHash("sha256").update(text).digest("hex").slice(0, 5);
  const sampled = BILLING_HEADER_POSITIONS.map((index) => text[index] || "0").join("");
  const suffix = createHash("sha256").update(`${BILLING_HEADER_SALT}${sampled}${CLAUDE_CODE_VERSION}`).digest("hex").slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${suffix}; cc_entrypoint=sdk-cli; cch=${cch};`;
}

function normalizeSystemPrompt(text) {
  const start = text.indexOf(PI_PROMPT_PREFIX);
  if (start === -1) return text;
  const terminator = text.indexOf(PI_PROMPT_TERMINATOR, start);
  if (terminator !== -1) {
    const end = terminator + PI_PROMPT_TERMINATOR.length;
    const sanitized = text.slice(start, end).split(/\n\n+/)
      .filter((paragraph) => !PARAGRAPH_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor)))
      .join("\n\n")
      .replaceAll("Here is some useful information about the environment you are running in:", "Environment context you are running in:")
      .trim();
    const preamble = sanitized ? `${OAUTH_PROMPT}\n\n${sanitized}` : OAUTH_PROMPT;
    return text.slice(0, start) + preamble + text.slice(end);
  }
  // Preserve the old shaper's project-context boundary when the Pi preamble changes.
  const projectContext = text.indexOf("\n\n# Project Context\n\n");
  return projectContext === -1 ? OAUTH_PROMPT : OAUTH_PROMPT + text.slice(projectContext);
}

function splitTrailingToolContent(messages) {
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return [message];
    const firstTool = message.content.findIndex((block) => block.type === "tool_use");
    if (firstTool === -1 || !message.content.slice(firstTool).some((block) => block.type !== "tool_use")) return [message];
    return [
      { ...message, content: message.content.filter((block) => block.type !== "tool_use") },
      { ...message, content: message.content.filter((block) => block.type === "tool_use") },
    ];
  });
}

function shapeAnthropicOAuthPayload(payload) {
  if (!payload || typeof payload.model !== "string" || !Array.isArray(payload.messages) || typeof payload.stream !== "boolean") return payload;
  if (!Array.isArray(payload.system) || !payload.system.some((block) =>
    block?.type === "text" && typeof block.text === "string" && (
      block.text.includes(CLAUDE_CODE_IDENTITY) ||
      block.text.includes("x-anthropic-billing-header:") ||
      block.text.startsWith(OAUTH_PROMPT_PREFIX)
    ))) return payload;

  const messages = splitTrailingToolContent(payload.messages);
  const system = payload.system.map((block) =>
    block?.type === "text" && typeof block.text === "string"
      ? { ...block, text: normalizeSystemPrompt(block.text) }
      : block,
  );
  const header = billingHeader(messages);
  if (header && !system.some((block) => typeof block?.text === "string" && block.text.includes("x-anthropic-billing-header:"))) {
    system.unshift({ type: "text", text: header });
  }
  return { ...payload, messages, system };
}

/** Decorate the native provider before creating aliases, so both accounts and both stream APIs agree. */
function withAnthropicOAuth(provider) {
  const optionsFor = (options) => {
    // Match Pi's OAuth transport detection; API-key requests must remain untouched even if
    // their system prompt happens to mention Claude Code or a billing marker.
    if (!options?.apiKey?.includes("sk-ant-oat")) return options;
    return {
      ...options,
      onPayload: async (payload, model) => {
        const replacement = await options.onPayload?.(payload, model);
        return shapeAnthropicOAuthPayload(replacement === undefined ? payload : replacement);
      },
    };
  };
  return {
    ...provider,
    stream: (model, context, options) => provider.stream(model, context, optionsFor(options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, optionsFor(options)),
  };
}

module.exports = { shapeAnthropicOAuthPayload, withAnthropicOAuth };
