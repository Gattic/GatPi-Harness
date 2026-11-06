"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Verifier } = require("../src/verification-pipeline");
const { MemoryJsonStorage, FileAnchoringAdapter, VerificationAdapter } = require("../src/integration-boundary");
const { tmpFixture } = require("./helpers/tmp-fixture");

(async () => {
  const anchoring = new FileAnchoringAdapter();
  const diff = anchoring.diff("const x = 1;\n", "const x = 2;\n", "x.js");
  assert(diff.changes.length > 0);
  assert(anchoring.metrics().attempted >= 0);

  const tmp = tmpFixture("pi-adapter-verify-");
  fs.writeFileSync(path.join(tmp, "x.js"), "const x = 2;\n");
  const verifier = new Verifier({ id: "unit", kind: "unit", files: ["**/*"], run: async () => ({ ok: true, output: "ok" }) });
  const verification = new VerificationAdapter({ storage: new MemoryJsonStorage(), verifiers: [verifier], options: { requiredKinds: ["unit"] } });
  const result = await verification.verify({ cwd: tmp, patchSet: { id: "p", files: ["x.js"] }, changeSet: { changedFiles: ["x.js"], before: { "x.js": "1" }, after: { "x.js": "2" } } });
  assert.equal(result.ok, true);
  assert(result.evidenceFile.startsWith("memory://"));
  console.log("anchoring-verification-adapters tests passed");
})();
