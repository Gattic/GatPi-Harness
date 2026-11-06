#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { FileIntegrationStorage } = require("../src/file-integration-storage.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = tmpFixture("pi-chunk-storage-");
const storage = new FileIntegrationStorage(root, { chunkBytes: 1024, maxJsonBytes: 64 * 1024 });
const key = "cognitive/state";
const value = { schemaVersion: 1, entries: Array.from({ length: 40 }, (_, index) => ({ id: index, text: `entry-${index}-${"x".repeat(80)}` })) };

const written = storage.writeJson(key, value);
assert.equal(written, storage.chunkManifestPath(key));
assert.equal(fs.existsSync(storage.jsonPath(key)), false, "a chunked write must not leave a duplicate single JSON file");
const manifest = JSON.parse(fs.readFileSync(storage.chunkManifestPath(key), "utf8"));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.key, key);
assert(manifest.chunks.length > 1);
assert.equal(manifest.bytes, Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`));
assert.deepEqual(storage.readJson(key), value);

const migrated = { ...value, entries: value.entries.slice(0, 2) };
const migratedPath = storage.writeJson(key, migrated);
assert.equal(migratedPath, storage.jsonPath(key), "a small write migrates back to a single JSON file");
assert.equal(fs.existsSync(storage.chunkManifestPath(key)), false);
assert.equal(fs.existsSync(storage.chunkDirPath(key)), false);
assert.deepEqual(storage.readJson(key), migrated);

const legacyKey = "legacy/state";
fs.mkdirSync(path.dirname(storage.jsonPath(legacyKey)), { recursive: true });
fs.writeFileSync(storage.jsonPath(legacyKey), `${JSON.stringify({ legacy: true, pad: "y".repeat(3000) }, null, 2)}\n`);
assert.equal(storage.writeJson(legacyKey, value), storage.chunkManifestPath(legacyKey));
assert.equal(fs.existsSync(storage.jsonPath(legacyKey)), false, "legacy single JSON is migrated into chunks");
assert.deepEqual(storage.readJson(legacyKey), value);

const copied = storage.copyJson(key, "snapshots/copy");
assert(copied && fs.existsSync(copied), "copying a chunked store produces a readable target");
assert.deepEqual(storage.readJson("snapshots/copy"), migrated);
const smallCopyTarget = "snapshots/small-target";
storage.writeJson(smallCopyTarget, value);
storage.writeJson("snapshots/small-source", { small: true });
assert(storage.copyJson("snapshots/small-source", smallCopyTarget));
assert.deepEqual(storage.readJson(smallCopyTarget), { small: true }, "a small copy clears a stale chunk manifest on the target");

const corruptKey = "corrupt/state";
storage.writeJson(corruptKey, value);
const chunkDir = storage.chunkDirPath(corruptKey);
fs.writeFileSync(path.join(chunkDir, manifest.chunks[0]), "corrupt");
assert.deepEqual(storage.readJson(corruptKey, { fallback: true }), { fallback: true }, "chunk integrity failures fail closed to the fallback");

const collisionKey = "collision/state";
const collisionValue = { ...value, marker: "chunked" };
storage.writeJson(collisionKey, collisionValue);
storage.writeJson(`${collisionKey}.chunks`, { small: true });
assert.deepEqual(storage.readJson(collisionKey), collisionValue, "a JSON key ending in .chunks must not overwrite a chunk manifest");
assert.deepEqual(storage.readJson(`${collisionKey}.chunks`), { small: true });
storage.writeJson("!chunks/state", { reserved: true });
storage.writeJson("state", value);
assert.deepEqual(storage.readJson("!chunks/state"), { reserved: true }, "a key containing the reserved chunk path is encoded safely");
assert.deepEqual(storage.readJson("state"), value);

const rollbackRoot = tmpFixture("pi-chunk-rollback-");
const rollbackStorage = new FileIntegrationStorage(rollbackRoot, { chunkBytes: 1024, maxJsonBytes: 64 * 1024 });
const rollbackKey = "rollback/state";
const oldValue = { ...value, marker: "old" };
const newValue = { ...value, marker: "new" };
rollbackStorage.writeJson(rollbackKey, oldValue);
const realRenameSync = fs.renameSync;
let injectedManifestFailure = false;
fs.renameSync = (from, to) => {
  if (String(from).includes(".tmp") && String(to).endsWith(".json")) {
    injectedManifestFailure = true;
    throw new Error("injected manifest rename failure");
  }
  return realRenameSync(from, to);
};
try {
  assert.throws(() => rollbackStorage.writeJson(rollbackKey, newValue), /injected manifest rename failure/);
} finally {
  fs.renameSync = realRenameSync;
}
assert.equal(injectedManifestFailure, true);
assert.deepEqual(rollbackStorage.readJson(rollbackKey), oldValue, "a failed manifest install restores the previous chunk directory");

const dirRollbackRoot = tmpFixture("pi-chunk-dir-rollback-");
const dirRollbackStorage = new FileIntegrationStorage(dirRollbackRoot, { chunkBytes: 1024, maxJsonBytes: 64 * 1024 });
const dirRollbackKey = "rollback/dir";
dirRollbackStorage.writeJson(dirRollbackKey, oldValue);
fs.renameSync = (from, to) => {
  if (String(from).includes(".tmp") && !String(from).includes(".json") && String(to).endsWith("rollback/dir")) {
    throw new Error("injected directory rename failure");
  }
  return realRenameSync(from, to);
};
try {
  assert.throws(() => dirRollbackStorage.writeJson(dirRollbackKey, newValue), /injected directory rename failure/);
} finally {
  fs.renameSync = realRenameSync;
}
assert.deepEqual(dirRollbackStorage.readJson(dirRollbackKey), oldValue, "a failed directory install restores the previous chunk directory");

const smallRollbackRoot = tmpFixture("pi-chunk-small-rollback-");
const smallRollbackStorage = new FileIntegrationStorage(smallRollbackRoot, { chunkBytes: 1024, maxJsonBytes: 64 * 1024 });
const smallRollbackKey = "rollback/small";
smallRollbackStorage.writeJson(smallRollbackKey, oldValue);
fs.renameSync = (from, to) => {
  if (!String(from).includes("!chunks") && String(from).includes(".tmp") && String(to).endsWith(".json")) {
    throw new Error("injected small write rename failure");
  }
  return realRenameSync(from, to);
};
try {
  assert.throws(() => smallRollbackStorage.writeJson(smallRollbackKey, { small: true }), /injected small write rename failure/);
} finally {
  fs.renameSync = realRenameSync;
}
assert.deepEqual(smallRollbackStorage.readJson(smallRollbackKey), oldValue, "a failed small write leaves the previous chunked value readable");

storage.deleteJson(legacyKey);
assert.equal(fs.existsSync(storage.chunkManifestPath(legacyKey)), false);
assert.equal(fs.existsSync(storage.chunkDirPath(legacyKey)), false);
assert.equal(storage.readJson(legacyKey, null), null);

console.log("json chunk storage tests passed");
