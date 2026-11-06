"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../.pi/extensions/reasoning-runtime/index.ts"), "utf8");
assert.match(source, /managed-state-sanitizer\.js/);
assert.match(source, /title:\s*"Assistant turn",\s*content:\s*diagnosticTextMetadata\(text,\s*"Assistant response"\)/);
assert.doesNotMatch(source, /title:\s*"Assistant turn",\s*content:\s*text\b/);

console.log("reasoning transcript privacy policy tests passed");
