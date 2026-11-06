"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(process.cwd(), ".pi", "extensions", "reasoning-runtime", "index.ts"), "utf8");
assert(source.includes("function ensureReasoningArchitectureMemory"), "startup must use idempotent architecture memory helper");
assert(source.includes("dedupe reasoning architecture memory"), "duplicate reasoning architecture memories should be removed");
const clearBody = source.slice(source.indexOf("function clearStaleReasoningState"), source.indexOf("function makeBoundary"));
assert(!clearBody.includes("boundary.memory.remember({ type: \"semantic\", title: \"Reasoning runtime architecture\""), "clearStaleReasoningState must not blindly append architecture memory every startup");
console.log("reasoning-memory-dedupe-policy tests passed");
