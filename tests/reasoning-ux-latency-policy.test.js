"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(process.cwd(), ".pi", "extensions", "reasoning-runtime", "index.ts"), "utf8");
const messageEnd = source.slice(source.indexOf('pi.on("message_end"'), source.indexOf('pi.on("tool_call"'));
assert(!messageEnd.includes("consolidate({ force: true })"), "message_end must not force synchronous memory consolidation");
assert(messageEnd.includes("scheduleMemoryConsolidation(runtime)"), "message_end should schedule debounced consolidation");
assert(source.includes("function clearPrivateAssistantMemory"), "private/encrypted assistant memory cleanup must exist");
assert(source.includes('type.includes("thinking") || type.includes("reasoning")'), "assistant message capture must ignore thinking/reasoning blocks");
assert(source.includes('AUTO_CONSOLIDATE = process.env.PI_COGNITIVE_AUTO_CONSOLIDATE === "1"'), "auto consolidation should be opt-in for prompt latency");
assert(source.includes("CONSOLIDATE_DEBOUNCE_MS"), "consolidation should be debounce-configurable");
assert(source.includes("rt.consolidateTimer?.unref?.()"), "background consolidation timer should not keep process active");
console.log("reasoning-ux-latency-policy tests passed");
