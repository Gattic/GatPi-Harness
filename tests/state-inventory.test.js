"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { inventoryState, scanTextInventory } = require("../src/state-inventory");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = tmpFixture("state-inventory-");
fs.mkdirSync(path.join(root, "nested"));
for (let i = 0; i < 1005; i++) fs.writeFileSync(path.join(root, "nested", `${String(i).padStart(4, "0")}.json`), JSON.stringify({ i }));
const large = path.join(root, "large.json");
const marker = "sk-" + "A".repeat(32);
fs.writeFileSync(large, `${"x".repeat(2_100_000)}${marker}\n`);
fs.symlinkSync(path.join(root, "nested", "0000.json"), path.join(root, "linked.json"));

const inventory = inventoryState([root], { includeFile: (file) => file.endsWith(".json") });
assert.equal(inventory.summary.discoveredFiles, 1006, "metadata inventory has no 1000-file cap");
assert.ok(inventory.summary.discoveredBytes > 2_000_000, "metadata inventory includes large files");
assert.equal(inventory.summary.skippedReasons.symlink, 1, "symlinks are accounted and never followed");

let found = 0;
const full = scanTextInventory(inventory, (file, api) => api.scanTextFile(file.path, ({ text }) => { if (text.includes(marker)) found++; }, { overlapChars: 128 }));
assert.equal(full.summary.discoveredFiles, full.summary.scannedFiles + full.summary.skippedFiles + full.summary.erroredFiles);
assert.equal(full.summary.identityHolds, true);
assert.equal(full.summary.complete, true);
assert.ok(found >= 1, "stream scan reads candidate content beyond the old 2 MB cutoff");

const bounded = scanTextInventory(inventory, (file, api) => api.scanTextFile(file.path, () => {}), { maxFiles: 10 });
assert.equal(bounded.summary.scannedFiles, 10);
assert.equal(bounded.summary.skippedFiles, 996);
assert.equal(bounded.summary.skippedReasons["file-limit"], 996);
assert.equal(bounded.summary.complete, false, "bounded scan never overclaims completeness");
assert.equal(bounded.summary.identityHolds, true);

for (const count of [10, 800, 1000, 1500, 5000]) {
  const fixture = tmpFixture(`state-inventory-${count}-`);
  for (let index = 0; index < count; index++) fs.writeFileSync(path.join(fixture, `${String(index).padStart(5, "0")}.json`), "{}\n");
  const counted = inventoryState([fixture]);
  assert.equal(counted.summary.discoveredFiles, count, `independent metadata count matches ${count}-file fixture`);
  assert.equal(counted.summary.discoveredBytes, count * 3);
}

const sizes = tmpFixture("state-inventory-sizes-");
fs.writeFileSync(path.join(sizes, "zero.json"), "");
fs.writeFileSync(path.join(sizes, "1.9mb.json"), "a".repeat(1_900_000));
fs.writeFileSync(path.join(sizes, "2mb.json"), "b".repeat(2_000_000));
const huge = path.join(sizes, "100mb.json"); const hugeBytes = 100 * 1024 * 1024; const fd = fs.openSync(huge, "w"); fs.ftruncateSync(fd, hugeBytes); fs.writeSync(fd, Buffer.from(marker), 0, Buffer.byteLength(marker), hugeBytes - Buffer.byteLength(marker)); fs.closeSync(fd);
const sized = inventoryState([sizes]);
assert.equal(sized.summary.discoveredFiles, 4);
assert.equal(sized.summary.discoveredBytes, 0 + 1_900_000 + 2_000_000 + hugeBytes);
let hugeFound = false;
const hugeScan = scanTextInventory(inventoryState([huge]), (file, api) => api.scanTextFile(file.path, ({ text }) => { if (text.includes(marker)) hugeFound = true; }));
assert.equal(hugeScan.summary.complete, true);
assert.equal(hugeFound, true, "100 MB fixture is streamed without a hidden size exclusion");
const byteBounded = scanTextInventory(sized, (file, api) => api.scanTextFile(file.path, () => {}), { maxBytes: 1 });
assert.equal(byteBounded.summary.complete, false);
assert.ok(byteBounded.summary.skippedReasons["byte-limit"] >= 1);
const denied = scanTextInventory(sized, (file) => file.path.endsWith("2mb.json") ? { ok: false, reason: "read-error", code: "EACCES" } : { ok: true, bytesRead: file.bytes });
assert.equal(denied.summary.complete, false);
assert.equal(denied.summary.errorReasons["read-error"], 1);
let delayed = false; const deadline = scanTextInventory(sized, (file) => { if (!delayed) { delayed = true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } return { ok: true, bytesRead: file.bytes }; }, { deadlineMs: 1 });
assert.equal(deadline.summary.complete, false);
assert.ok(deadline.summary.skippedReasons.deadline >= 1);
assert.equal(deadline.summary.identityHolds, true);

console.log("state inventory tests passed");
