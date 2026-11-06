"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  appendFileSections,
  boundedContextChars,
  buildLocalRecoverySummary,
  collectFileLists,
  compactionRecoveryDetection,
  isContextLimitError,
  isOutputTokenLimitError,
  isWebSocketSummarizationFailure,
  latestAssistantContextLimit,
  latestAssistantOutputLimit,
  proactiveCompactionDecision,
  truncateMiddle,
} = require("../src/context-overflow-recovery.js");

const preparation = {
  previousSummary: "Earlier architecture decision: preserve the durable ledger and continue from the verified checkpoint.",
  tokensBefore: 376510,
  isSplitTurn: true,
  firstKeptEntryId: "kept-1",
  fileOps: {
    read: new Set(["src/read-only.js", "src/changed.js"]),
    edited: new Set(["src/changed.js"]),
    written: new Set(["tests/new.test.js"]),
  },
  messagesToSummarize: [
    { role: "user", content: "Implement overflow recovery without deleting session history." },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Inspected the session format and localized the failure." },
        { type: "toolCall", name: "read", arguments: { path: "session.jsonl" } },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "Temporary read failure" }],
    },
  ],
  turnPrefixMessages: [
    { role: "user", content: [{ type: "text", text: "Keep the latest work and continue automatically." }] },
    {
      role: "assistant",
      content: [{ type: "toolCall", name: "edit", arguments: { path: "src/changed.js" } }],
      stopReason: "error",
      errorMessage: "Codex context window exceeded",
    },
  ],
};

const files = collectFileLists(preparation, [
  {
    type: "compaction",
    details: {
      readFiles: ["docs/old.md", "src/changed.js"],
      modifiedFiles: ["src/prior.js"],
    },
  },
]);
assert.deepEqual(files, {
  readFiles: ["docs/old.md", "src/read-only.js"],
  modifiedFiles: ["src/changed.js", "src/prior.js", "tests/new.test.js"],
});

const summary = buildLocalRecoverySummary(preparation, {
  maxChars: 8_000,
  customInstructions: "Preserve the exact blocker and next verifier.",
});
assert.match(summary, /Emergency Compaction Recovery/);
assert.match(summary, /Preserve the exact blocker and next verifier/);
assert.match(summary, /Earlier architecture decision/);
assert.match(summary, /Implement overflow recovery/);
assert.match(summary, /Keep the latest work/);
assert.match(summary, /Temporary read failure/);
assert.match(summary, /Codex context window exceeded/);
assert.match(summary, /Tools used: read, edit/);
assert.match(summary, /376,510 tokens/);
assert.match(summary, /Split-turn recovery: yes/);
assert.ok(summary.length <= 8_000, "local recovery summary must stay bounded");

const withFiles = appendFileSections(summary, files);
assert.match(withFiles, /<read-files>[\s\S]*docs\/old\.md[\s\S]*<\/read-files>/);
assert.match(withFiles, /<modified-files>[\s\S]*tests\/new\.test\.js[\s\S]*<\/modified-files>/);

const clipped = truncateMiddle("a".repeat(2_000), 300);
assert.ok(clipped.length <= 300);
assert.match(clipped, /chars omitted/);
assert.equal(isWebSocketSummarizationFailure(new Error("Summarization failed: WebSocket error")), true);
assert.equal(isWebSocketSummarizationFailure(new Error("Summarization failed: fetch failed")), false);
assert.equal(isContextLimitError("Codex error: Your input exceeds the context window of this model."), true);
assert.equal(isContextLimitError("Summarization failed: WebSocket error"), false);
assert.equal(isOutputTokenLimitError("Model stopped because it reached the maximum output token limit."), true);
assert.equal(isOutputTokenLimitError("Your input exceeds the context window of this model."), false);
const outputLimitEntry = {
  type: "message",
  id: "assistant-length",
  message: { role: "assistant", stopReason: "length", content: [] },
};
assert.equal(latestAssistantOutputLimit([
  outputLimitEntry,
  { type: "compaction", id: "compaction-after-length" },
]), outputLimitEntry, "post-length compaction metadata must not hide the interrupted assistant");
assert.equal(latestAssistantOutputLimit([
  outputLimitEntry,
  { type: "compaction", id: "compaction-after-length" },
  { type: "message", id: "manual-continuation", message: { role: "user", content: "Continue" } },
]), undefined, "a newer user continuation owns the next turn");
assert.equal(latestAssistantOutputLimit([{
  type: "message",
  id: "assistant-output-error",
  message: {
    role: "assistant",
    stopReason: "error",
    errorMessage: "Model stopped because it reached the maximum output token limit.",
  },
}]).id, "assistant-output-error");
assert.equal(latestAssistantOutputLimit([{
  type: "message",
  id: "assistant-complete",
  message: { role: "assistant", stopReason: "stop", content: [] },
}]), undefined);
const overflowBranch = [{
  type: "message",
  message: {
    role: "assistant",
    stopReason: "error",
    errorMessage: "Codex error: Your input exceeds the context window of this model.",
  },
}];
assert.equal(latestAssistantContextLimit(overflowBranch), true);
assert.equal(compactionRecoveryDetection({ reason: "overflow" }), "provider-overflow");
assert.equal(compactionRecoveryDetection({ reason: "threshold" }), "automatic-threshold");
assert.equal(compactionRecoveryDetection({ reason: "manual", branchEntries: overflowBranch }), "recent-context-error");
assert.equal(compactionRecoveryDetection({ reason: "manual", tokensBefore: 90, contextWindow: 100, reserveTokens: 10 }), "token-pressure");
assert.equal(compactionRecoveryDetection({ reason: "manual", tokensBefore: 20, contextWindow: 100, reserveTokens: 10 }), undefined);
assert.equal(proactiveCompactionDecision({ usage: { percent: 81 }, usagePercent: 80 }), "usage-percent");
assert.equal(proactiveCompactionDecision({ usage: { percent: 20 }, activeEntries: [{ message: { content: "x".repeat(2_000) } }], maxChars: 1_000 }), "active-context-size");
assert.equal(proactiveCompactionDecision({ usage: { percent: 20 }, activeEntries: [{ message: { content: "small" } }], maxChars: 1_000 }), undefined);

const imageHeavyEntries = [{
  message: {
    role: "toolResult",
    content: [
      { type: "image", data: "a".repeat(4_000), mimeType: "image/png", label: "direct image" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "b".repeat(4_000) },
        label: "nested source image",
      },
      {
        type: "image_url",
        image_url: { url: `data:image/webp;base64,${"c".repeat(4_000)}`, detail: "high" },
        label: "data URL image",
      },
    ],
  },
}];
const imageHeavyEstimate = boundedContextChars(imageHeavyEntries, 1_000);
assert.equal(imageHeavyEstimate.exceeded, false, "raw base64 image payloads must not consume the structured-context budget");
assert.ok(imageHeavyEstimate.chars > 0, "image MIME types, labels, and other textual metadata must remain counted");
assert.equal(proactiveCompactionDecision({
  usage: { percent: 20 },
  activeEntries: imageHeavyEntries,
  maxChars: 1_000,
}), undefined, "image-heavy context below the token threshold must not compact on raw base64 size");
assert.equal(proactiveCompactionDecision({
  usage: { percent: 20 },
  activeEntries: [{
    message: {
      content: [{ type: "image", data: "x".repeat(20_000), mimeType: "image/png", caption: "m".repeat(2_000) }],
    },
  }],
  maxChars: 1_000,
}), "active-context-size", "large textual image metadata must still trigger the structured-context guard");

const extension = fs.readFileSync(".pi/extensions/context-overflow-recovery/index.ts", "utf8");
for (const expected of [
  '"before_model_call"',
  'pi.on("session_before_compact"',
  'pi.on("session_compact"',
  'pi.on("agent_settled"',
  "recovery.compactionRecoveryDetection",
  "delete require.cache",
  "minimalRecoveryCompaction",
  'transport: "sse"',
  "recovery.buildLocalRecoverySummary",
  "CONTINUATION_PROMPT",
  "recovery.latestAssistantOutputLimit",
  "recovery.proactiveCompactionDecision",
  "PI_COMPACTION_PROACTIVE_MAX_CHARS",
  "PI_COMPACTION_RECOVERY_MAX_OUTPUT_LIMIT_CONTINUATIONS",
  'pi.registerCommand("compact-rescue"',
  'pi.registerCommand("compaction-recovery-status"',
]) assert.ok(extension.includes(expected), `extension should include ${expected}`);

console.log("context-overflow-recovery tests passed");
