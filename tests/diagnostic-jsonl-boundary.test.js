"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { appendBoundedJsonl, pruneDiagnosticJsonl } = require("../src/file-integration-storage");
const { tmpFixture } = require("./helpers/tmp-fixture");
const root = tmpFixture("pi-jsonl-boundary-");
const now = Date.now();
const policy = { maxBytes: 128, maxRecords: 10, maxAgeMs: 86400000 };
const serialize = row => JSON.stringify(row) + "\n";
const exact = { at: now, n: 2, text: "ü" };
exact.text += "x".repeat(policy.maxBytes - Buffer.byteLength(serialize(exact)));
assert.equal(Buffer.byteLength(serialize(exact)), policy.maxBytes);
try {
  for (const mode of ["append", "maintenance"]) {
    const file = path.join(root, `${mode}.jsonl`);
    if (mode === "append") {
      appendBoundedJsonl(file, { at: now, n: 1 }, policy, now);
      appendBoundedJsonl(file, exact, policy, now);
    } else {
      fs.writeFileSync(file, serialize({ at: now, n: 1 }) + serialize(exact));
      pruneDiagnosticJsonl(file, policy, { now });
    }
    assert.equal(fs.readFileSync(file, "utf8"), serialize(exact), `${mode} retains a complete exact-cap suffix`);
    assert.equal(pruneDiagnosticJsonl(file, policy, { now }).records, 1);
  }
  // A suffix starting inside a multibyte character must still drop the partial row.
  const partial = path.join(root, "partial.jsonl");
  const newest = { at: now, n: 3 };
  const prefix = serialize({ at: now, text: "ü".repeat(100) });
  const maxBytes = Buffer.byteLength(serialize(newest)) + 4;
  const content = Buffer.from(prefix + serialize(newest));
  assert.equal(content[content.length - maxBytes], 0xbc);
  fs.writeFileSync(partial, content);
  pruneDiagnosticJsonl(partial, { ...policy, maxBytes }, { now });
  assert.equal(fs.readFileSync(partial, "utf8"), serialize(newest));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("diagnostic JSONL boundary tests passed");
