#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runtimeSourceFingerprint } = require("../src/runtime-source-fingerprint.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-runtime-fingerprint-");
function write(file, text) {
  const full = path.join(tmp, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

write("src/a.js", "module.exports = 1;\n");
write("src/node_modules/vendor/index.js", "module.exports = 'vendored';\n");
write(".pi/extensions/demo/index.ts", "export const demo = 1;\n");
write(".pi/extensions/demo/node_modules/dep/index.js", "module.exports = 'dep';\n");
write("config/harness-defaults.env", "PI_HARNESS=1\n");

const first = runtimeSourceFingerprint(tmp);
assert(first.files.includes("src/a.js"));
assert(first.files.includes(".pi/extensions/demo/index.ts"), "project extension sources are runtime source");
assert(first.files.includes("config/harness-defaults.env"));
assert(!first.files.some((file) => file.includes("node_modules/")), "vendored packages must not affect the runtime revision");
assert.equal(first.fileCount, 3);

write("src/node_modules/vendor/index.js", "module.exports = 'changed vendored';\n");
const afterVendorChange = runtimeSourceFingerprint(tmp);
assert.equal(afterVendorChange.hash, first.hash, "editing a vendored package does not change the project runtime revision");

write("src/a.js", "module.exports = 2;\n");
const afterSourceChange = runtimeSourceFingerprint(tmp);
assert.notEqual(afterSourceChange.hash, first.hash, "editing project source changes the runtime revision");
assert.equal(afterSourceChange.files.length, first.files.length);

console.log("runtime-source-fingerprint tests passed");
