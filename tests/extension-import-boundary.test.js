"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EXTENSION_IMPORT_ALLOWLIST,
  EXTENSION_ROOTS,
  FORBIDDEN_INTERNAL_MODULES,
  scanExtensionImports,
} = require("../src/extension-import-policy.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const result = scanExtensionImports({ cwd: process.cwd() });
assert.deepEqual(result.offenders, [], "extensions may import only integration boundary surfaces");

for (const root of EXTENSION_ROOTS) {
  if (fs.existsSync(path.join(process.cwd(), root))) {
    assert(result.files.some((file) => file === root || file.startsWith(`${root}/`)), `${root} must be scanned`);
  }
}

assert.equal(new Set(EXTENSION_IMPORT_ALLOWLIST).size, EXTENSION_IMPORT_ALLOWLIST.length, "allowlist entries must be unique");
for (const internal of FORBIDDEN_INTERNAL_MODULES) {
  assert(!EXTENSION_IMPORT_ALLOWLIST.some((allowed) => allowed.endsWith(internal)), `${internal} must not be allowlisted`);
}

const fixture = tmpFixture("pi-import-policy-");
fs.mkdirSync(path.join(fixture, "extensions", "offender"), { recursive: true });
fs.writeFileSync(path.join(fixture, "extensions", "offender", "index.ts"), "import x from '../../../src/not-allowed.js';\nimport y from '../../../src/cognitive-memory.js';\n");
const synthetic = scanExtensionImports({ cwd: fixture, roots: ["extensions"], allowed: ["src/allowed.js", "src/cognitive-memory.js"], forbidden: ["cognitive-memory.js"] });
assert.equal(synthetic.files.length, 1);
assert.equal(synthetic.offenders.length, 2, "an unknown src import and a forbidden internal are both rejected");
assert(synthetic.offenders.some((offender) => offender.specifier.endsWith("src/not-allowed.js") && offender.reason === "not in extension import allowlist"));
assert(synthetic.offenders.some((offender) => offender.specifier === "cognitive-memory.js" && offender.reason === "forbidden subsystem internal"));

fs.writeFileSync(path.join(fixture, "extensions", "offender", "index.ts"), "import x from '../../../src/allowed.js';\n");
const allowedFixture = scanExtensionImports({ cwd: fixture, roots: ["extensions"], allowed: ["src/allowed.js", "src/cognitive-memory.js"], forbidden: ["cognitive-memory.js"] });
assert.deepEqual(allowedFixture.offenders, [], "an allowlisted public surface is accepted");

const docs = fs.readFileSync(path.join(process.cwd(), "docs", "integration-boundary.md"), "utf8");
assert(docs.includes("src/extension-import-policy.js"), "docs must point at the single-source import policy instead of duplicating it");

console.log(`extension-import-boundary tests passed (${result.files.length} files, ${EXTENSION_IMPORT_ALLOWLIST.length} allowed surfaces)`);
