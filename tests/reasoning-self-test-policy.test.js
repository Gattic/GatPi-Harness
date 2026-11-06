"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(process.cwd(), ".pi", "extensions", "reasoning-runtime", "index.ts"), "utf8");
assert(source.includes("function architectureMemoryStats"), "self-test must inspect architecture semantic memory");
assert(source.includes("architectureSemanticMemoryDeduped"), "self-test must report architecture memory dedupe status");
assert(source.includes("renderHasVersionBanner"), "self-test must validate rendered runtime version banner");
assert(source.includes("renderDoesNotExposeScratchpad"), "self-test must validate scratchpad non-exposure");
console.log("reasoning-self-test-policy tests passed");
