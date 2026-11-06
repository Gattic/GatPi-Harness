"use strict";
const { tmpFixture } = require("./helpers/tmp-fixture");

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

process.env.PI_COMPACTION_RECOVERY_NETWORK = "0";
process.env.PI_COMPACTION_RECOVERY_AUTO_CONTINUE_OUTPUT_LIMIT = "1";
process.env.PI_COMPACTION_RECOVERY_MAX_OUTPUT_LIMIT_CONTINUATIONS = "3";
process.env.PI_COMPACTION_PROACTIVE_MAX_CHARS = "1000";
process.env.PI_COMPACTION_PROACTIVE_PERCENT = "80";

let piPackageRoot;
try {
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  const candidate = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
  if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
} catch {}
if (!piPackageRoot) {
  console.log("context-overflow-recovery extension behavior skipped (global pi install not found)");
  process.exit(0);
}

function runtimePackage(packageName, workspaceName) {
  const installed = path.join(piPackageRoot, "node_modules", "@earendil-works", packageName);
  if (fs.existsSync(path.join(installed, "package.json"))) return fs.realpathSync(installed);
  return fs.realpathSync(path.resolve(piPackageRoot, "..", workspaceName));
}

(async () => {
  const aiRoot = runtimePackage("pi-ai", "ai");
  const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
  const createJiti = jitiModule.createJiti || jitiModule;
  const extensionFile = path.resolve(".pi/extensions/context-overflow-recovery/index.ts");
  const recoveryFile = require.resolve(path.resolve("src/context-overflow-recovery.js"));
  // Reproduce /reload pairing fresh extension source with a stale CommonJS
  // helper. The extension must evict this entry before requiring the helper.
  require.cache[recoveryFile] = {
    id: recoveryFile,
    filename: recoveryFile,
    loaded: true,
    exports: { stale: true },
    children: [],
    paths: [],
  };
  assert.equal(require.cache[recoveryFile].exports.stale, true);
  const jiti = createJiti(extensionFile, {
    interopDefault: true,
    alias: {
      typebox: require.resolve("typebox", { paths: [piPackageRoot] }),
      "@earendil-works/pi-coding-agent": piPackageRoot,
      "@earendil-works/pi-ai/compat": path.join(aiRoot, "dist", "compat.js"),
      "@earendil-works/pi-ai": aiRoot,
    },
  });
  const mod = await jiti.import(extensionFile);
  const factory = mod.default || mod;
  assert.equal(typeof require(recoveryFile).compactionRecoveryDetection, "function", "extension reload must evict stale helper exports");
  const traceFile = path.resolve(".pi/extensions/trace-observability/index.ts");
  const traceMod = await jiti.import(traceFile);
  const traceFactory = traceMod.default || traceMod;
  const traceHandlers = new Map();
  traceFactory({
    on(name, handler) { traceHandlers.set(name, handler); },
    registerCommand() {},
    registerTool() {},
    events: { on() { return () => {}; } },
  });
  const handlers = new Map();
  const commands = new Map();
  const sentMessages = [];
  factory({
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, definition) { commands.set(name, definition); },
    sendUserMessage(content, options) { sentMessages.push({ content, options }); },
  });

  const beforeModelCallHook = handlers.get("before_model_call");
  const compactHook = handlers.get("session_before_compact");
  assert.equal(typeof beforeModelCallHook, "function");
  assert.equal(typeof compactHook, "function");
  assert.ok(commands.has("compact-rescue"));
  assert.ok(commands.has("compaction-recovery-status"));

  const preparation = {
    firstKeptEntryId: "kept-entry",
    tokensBefore: 372_500,
    previousSummary: "Keep the verified checkpoint.",
    isSplitTurn: true,
    messagesToSummarize: [{ role: "user", content: "Recover this interrupted task." }],
    turnPrefixMessages: [{ role: "assistant", content: [{ type: "text", text: "Work was in progress." }] }],
    fileOps: { read: new Set(["README.md"]), edited: new Set(), written: new Set() },
    settings: { reserveTokens: 16_384 },
  };
  const hookContext = {
    model: undefined,
    modelRegistry: {},
    hasUI: false,
    ui: { notify() {} },
    isIdle: () => true,
    getAutoCompactionEnabled: () => true,
    getContextUsage: () => undefined,
    sessionManager: { getSessionId: () => "session-1", buildSessionContext: () => ({ messages: [] }) },
  };
  const overflowEvent = {
    reason: "overflow",
    willRetry: true,
    preparation,
    branchEntries: [],
    signal: new AbortController().signal,
  };
  const overflow = await compactHook(overflowEvent, hookContext);
  assert.equal(overflow.compaction.firstKeptEntryId, "kept-entry");
  assert.equal(overflow.compaction.tokensBefore, 372_500);
  assert.equal(overflow.compaction.details.recovery.mode, "local");
  assert.match(overflow.compaction.summary, /Emergency Compaction Recovery/);
  assert.match(overflow.compaction.summary, /<read-files>[\s\S]*README\.md/);

  const traceDir = tmpFixture("pi-overflow-trace-");
  const oldTraceDir = process.env.PI_TRACE_DIR;
  process.env.PI_TRACE_DIR = traceDir;
  const traceResult = await traceHandlers.get("session_before_compact")(overflowEvent, {
    ...hookContext,
    cwd: process.cwd(),
    sessionManager: {
      ...hookContext.sessionManager,
      getSessionFile: () => undefined,
    },
  });
  if (oldTraceDir === undefined) delete process.env.PI_TRACE_DIR;
  else process.env.PI_TRACE_DIR = oldTraceDir;
  fs.rmSync(traceDir, { recursive: true, force: true });
  assert.equal(traceResult, undefined, "trace observers must not overwrite session_before_compact control results");
  const mergedResult = traceResult || overflow;
  assert.ok(mergedResult.compaction, "recovery compaction must survive later trace observers");

  const helper = require(recoveryFile);
  const originalCollectFileLists = helper.collectFileLists;
  helper.collectFileLists = () => { throw new Error("synthetic structured recovery failure"); };
  const failClosed = await compactHook({
    reason: "overflow",
    willRetry: true,
    preparation,
    branchEntries: [],
    signal: new AbortController().signal,
  }, hookContext);
  helper.collectFileLists = originalCollectFileLists;
  assert.equal(failClosed.compaction.details.recovery.mode, "minimal-local");
  assert.equal(failClosed.compaction.firstKeptEntryId, "kept-entry");

  await handlers.get("session_compact")({
    reason: "overflow",
    willRetry: true,
    fromExtension: true,
    compactionEntry: {},
  }, hookContext);
  assert.equal(sentMessages.length, 0, "Pi core continues overflow retries; the extension must not inject a duplicate prompt");

  const threshold = await compactHook({
    reason: "threshold",
    willRetry: false,
    preparation,
    branchEntries: [],
    signal: new AbortController().signal,
  }, hookContext);
  assert.equal(threshold.compaction.details.recovery.detection, "automatic-threshold");
  assert.equal(threshold.compaction.details.recovery.mode, "local");

  const ordinaryManual = await compactHook({
    reason: "manual",
    willRetry: false,
    preparation: { ...preparation, tokensBefore: 20 },
    branchEntries: [],
    signal: new AbortController().signal,
  }, hookContext);
  assert.equal(ordinaryManual, undefined, "manual compaction below pressure keeps Pi's default summary path");

  const overflowBranch = [{
    type: "message",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex error: Your input exceeds the context window of this model.",
    },
  }];
  const detectedManual = await compactHook({
    reason: "manual",
    willRetry: false,
    preparation,
    branchEntries: overflowBranch,
    signal: new AbortController().signal,
  }, hookContext);
  assert.equal(detectedManual.compaction.details.recovery.detection, "recent-context-error");
  await handlers.get("session_compact")({
    reason: "manual",
    willRetry: false,
    fromExtension: true,
    compactionEntry: {},
  }, hookContext);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].content, /Continue the interrupted task/);

  let compactOptions;
  await commands.get("compact-rescue").handler("preserve blockers", {
    ...hookContext,
    compact(options) { compactOptions = options; },
  });
  assert.equal(compactOptions.customInstructions, "preserve blockers");
  const manual = await compactHook({
    reason: "manual",
    willRetry: false,
    preparation,
    branchEntries: [],
    signal: new AbortController().signal,
  }, hookContext);
  assert.equal(manual.compaction.details.recovery.detection, "manual-rescue");
  compactOptions.onComplete({ tokensBefore: preparation.tokensBefore });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sentMessages.length, 2, "explicit rescue also continues without another user message");

  const settledHook = handlers.get("agent_settled");
  assert.equal(typeof settledHook, "function");
  const settledContext = (branch, overrides = {}) => ({
    ...hookContext,
    hasPendingMessages: () => false,
    sessionManager: {
      ...hookContext.sessionManager,
      getBranch: () => branch,
      buildSessionContext: () => ({
        messages: branch.flatMap((entry) => entry?.type === "message" && entry.message ? [entry.message] : []),
      }),
    },
    ...overrides,
  });
  const lengthBranch = (id, stopReason = "length", errorMessage) => [{
    type: "message",
    id,
    message: { role: "assistant", stopReason, errorMessage, content: [] },
  }, {
    type: "compaction",
    id: `compaction-${id}`,
  }];

  // Oversized active context is compacted proactively through Pi's append-only
  // API. The extension never truncates or deletes the backing session JSONL.
  const preservedSessionDir = tmpFixture("pi-proactive-compaction-");
  const preservedSessionFile = path.join(preservedSessionDir, "session.jsonl");
  const preservedSession = '{"type":"session","version":3}\n{"type":"message","id":"old"}\n';
  fs.writeFileSync(preservedSessionFile, preservedSession);
  let proactiveOptions;
  const proactiveBranch = [{
    type: "message",
    id: "large-complete",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "x".repeat(2_000) }] },
  }];
  const proactiveContext = settledContext(proactiveBranch, {
    getContextUsage: () => ({ tokens: 100, percent: 20, contextWindow: 1_000 }),
    compact(options) { proactiveOptions = options; },
  });
  proactiveContext.sessionManager = {
    ...proactiveContext.sessionManager,
    buildSessionContext: () => ({ messages: proactiveBranch.map((entry) => entry.message) }),
    getSessionFile: () => preservedSessionFile,
  };
  await settledHook({}, proactiveContext);
  assert.equal(typeof proactiveOptions?.onComplete, "function", "oversized active context should request proactive compaction");
  const proactive = await compactHook({
    reason: "manual",
    willRetry: false,
    preparation,
    branchEntries: proactiveBranch,
    signal: new AbortController().signal,
  }, proactiveContext);
  assert.equal(proactive.compaction.details.recovery.detection, "proactive-active-context-size");
  proactiveOptions.onComplete({ tokensBefore: preparation.tokensBefore });
  assert.equal(fs.readFileSync(preservedSessionFile, "utf8"), preservedSession, "proactive compaction must preserve existing session bytes");
  fs.rmSync(preservedSessionDir, { recursive: true, force: true });

  let hiddenStateCompacted = false;
  const hiddenStateBranch = [{
    type: "message",
    id: "small-visible-message",
    message: {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: "small visible result" }],
      details: { privateState: "x".repeat(4_000) },
      isError: false,
    },
  }, {
    type: "custom",
    id: "large-hidden-state",
    data: { cache: "y".repeat(4_000) },
  }];
  await settledHook({}, settledContext(hiddenStateBranch, {
    getContextUsage: () => ({ tokens: 20, percent: 2, contextWindow: 1_000 }),
    compact() { hiddenStateCompacted = true; },
  }));
  assert.equal(hiddenStateCompacted, false, "non-model-visible custom state and tool metadata must not trigger compaction");

  let disabledCompacted = false;
  const disabledBranch = [{
    type: "message",
    id: "disabled-large-leaf",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "z".repeat(2_000) }] },
  }];
  const disabledContext = settledContext(disabledBranch, {
    getAutoCompactionEnabled: () => false,
    getContextUsage: () => ({ tokens: 900, percent: 90, contextWindow: 1_000 }),
    compact() { disabledCompacted = true; },
  });
  disabledContext.sessionManager = {
    ...disabledContext.sessionManager,
    getLeafId: () => "disabled-large-leaf",
  };
  assert.equal(await beforeModelCallHook({}, disabledContext), undefined);
  await settledHook({}, disabledContext);
  assert.equal(disabledCompacted, false, "Pi's disabled auto-compaction setting must suppress all proactive hooks");

  // Long tool chains ask Pi core to compact before the next provider call. The
  // hook reuses the same 80%/8 MiB decision and never drains queued messages.
  const preModelBranch = [{
    type: "message",
    id: "pre-model-leaf",
    message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "queued result" }] },
  }];
  const preModelContext = settledContext(preModelBranch, {
    getContextUsage: () => ({ tokens: 810, percent: 81, contextWindow: 1_000 }),
  });
  preModelContext.sessionManager = {
    ...preModelContext.sessionManager,
    buildSessionContext: () => ({ messages: preModelBranch.map((entry) => entry.message) }),
    getLeafId: () => "pre-model-leaf",
  };
  const preModelDecision = await beforeModelCallHook({}, preModelContext);
  assert.deepEqual(preModelDecision, { compact: true });
  assert.equal(preModelContext.hasPendingMessages(), false, "the guard must only inspect queued state");
  const preModelRecovery = await compactHook({
    reason: "threshold",
    willRetry: false,
    preparation,
    branchEntries: preModelBranch,
    signal: new AbortController().signal,
  }, preModelContext);
  assert.equal(preModelRecovery.compaction.details.recovery.detection, "pre-model-usage-percent");
  await handlers.get("session_compact")({
    reason: "threshold",
    willRetry: false,
    fromExtension: true,
    compactionEntry: {},
  }, preModelContext);
  assert.equal(await beforeModelCallHook({}, preModelContext), undefined, "the same leaf must not request compaction twice");

  const stalePreModelBranch = [{
    type: "message",
    id: "stale-pre-model-leaf",
    message: { role: "toolResult", toolCallId: "stale", toolName: "read", content: [{ type: "text", text: "stale" }] },
  }];
  const stalePreModelContext = settledContext(stalePreModelBranch, {
    getContextUsage: () => ({ tokens: 850, percent: 85, contextWindow: 1_000 }),
  });
  stalePreModelContext.sessionManager = {
    ...stalePreModelContext.sessionManager,
    getLeafId: () => "stale-pre-model-leaf",
  };
  assert.deepEqual(await beforeModelCallHook({}, stalePreModelContext), { compact: true });
  await compactHook({
    reason: "threshold",
    willRetry: false,
    preparation,
    branchEntries: stalePreModelBranch,
    signal: new AbortController().signal,
  }, stalePreModelContext);
  const laterManual = await compactHook({
    reason: "manual",
    willRetry: false,
    preparation: { ...preparation, tokensBefore: 20, settings: { reserveTokens: 0 } },
    branchEntries: [],
    signal: new AbortController().signal,
  }, stalePreModelContext);
  assert.equal(laterManual, undefined);
  await handlers.get("session_compact")({
    reason: "manual",
    willRetry: false,
    fromExtension: true,
    compactionEntry: {},
  }, stalePreModelContext);
  let recoveryStatus;
  await commands.get("compaction-recovery-status").handler("", {
    ...hookContext,
    ui: { notify(text) { recoveryStatus = JSON.parse(text); } },
  });
  assert.equal(recoveryStatus.preModelCompactions, 1, "a failed pre-model marker must not count a later manual compaction");

  const preModelImageBranch = [{
    type: "message",
    id: "pre-model-image-leaf",
    message: {
      role: "toolResult",
      content: Array.from({ length: 6 }, (_, index) => index % 2 === 0
        ? { type: "image", data: "x".repeat(2_000), mimeType: "image/png", label: `direct-${index}` }
        : {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "y".repeat(2_000) },
            label: `nested-${index}`,
          }),
    },
  }];
  const preModelImageContext = settledContext(preModelImageBranch, {
    getContextUsage: () => ({ tokens: 200, percent: 20, contextWindow: 1_000 }),
  });
  preModelImageContext.sessionManager = {
    ...preModelImageContext.sessionManager,
    buildSessionContext: () => ({ messages: preModelImageBranch.map((entry) => entry.message) }),
    getLeafId: () => "pre-model-image-leaf",
  };
  assert.equal(
    await beforeModelCallHook({}, preModelImageContext),
    undefined,
    "image-heavy tool results must ignore raw base64 payload size",
  );

  const preModelSizeBranch = [{
    type: "message",
    id: "pre-model-size-leaf",
    message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(2_000) }] },
  }];
  const preModelSizeContext = settledContext(preModelSizeBranch, {
    getContextUsage: () => ({ tokens: 200, percent: 20, contextWindow: 1_000 }),
  });
  preModelSizeContext.sessionManager = {
    ...preModelSizeContext.sessionManager,
    buildSessionContext: () => ({ messages: preModelSizeBranch.map((entry) => entry.message) }),
    getLeafId: () => "pre-model-size-leaf",
  };
  assert.deepEqual(await beforeModelCallHook({}, preModelSizeContext), { compact: true });

  await settledHook({}, settledContext(lengthBranch("length-1")));
  assert.equal(sentMessages.length, 3, "a settled output-limit stop should continue after threshold compaction");
  assert.match(sentMessages.at(-1).content, /Continue the interrupted task/);
  assert.equal(sentMessages.at(-1).options, undefined, "idle output-limit continuation should start immediately");
  await settledHook({}, settledContext(lengthBranch("length-1")));
  assert.equal(sentMessages.length, 3, "the same assistant entry must never be continued twice");

  await settledHook({}, settledContext(lengthBranch(
    "length-2",
    "error",
    "Model stopped because it reached the maximum output token limit.",
  )));
  await settledHook({}, settledContext(lengthBranch("length-3")));
  assert.equal(sentMessages.length, 5, "distinct consecutive output-limit stops may continue up to the bound");
  await settledHook({}, settledContext(lengthBranch("length-4")));
  assert.equal(sentMessages.length, 5, "automatic output-limit continuation must stop at the configured bound");

  await settledHook({}, settledContext([{
    type: "message",
    id: "complete-1",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] },
  }]));
  await settledHook({}, settledContext(lengthBranch("length-after-complete")));
  assert.equal(sentMessages.length, 6, "a completed assistant response resets the consecutive continuation bound");

  await settledHook({}, settledContext(lengthBranch("length-with-pending"), {
    hasPendingMessages: () => true,
  }));
  assert.equal(sentMessages.length, 6, "an existing queued continuation must remain the single owner");

  console.log("context-overflow-recovery extension behavior tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
