"use strict";

const assert = require("node:assert/strict");
const { MemoryJsonStorage, RecordingSink, NullSink } = require("../src/integration-boundary");
const { FileIntegrationStorage } = require("../src/file-integration-storage");
const { tmpFixture } = require("./helpers/tmp-fixture");

function storageConformance(name, storage) {
  assert.deepEqual(storage.readJson(`${name}/missing`, { fallback: true }), { fallback: true });
  const jsonKey = `${name}/json`;
  const jsonValue = { ok: true, nested: { n: 1 } };
  storage.writeJson(jsonKey, jsonValue);
  assert.deepEqual(storage.readJson(jsonKey), jsonValue, `${name}: readJson/writeJson round trip`);

  const logKey = `${name}/events`;
  storage.appendJsonl(logKey, { n: 1 });
  storage.appendJsonl(logKey, { n: 2 });
  assert.deepEqual(storage.readJsonl(logKey), [{ n: 1 }, { n: 2 }], `${name}: appendJsonl/readJsonl round trip`);
}

storageConformance("memory", new MemoryJsonStorage());
storageConformance("file", new FileIntegrationStorage(tmpFixture("pi-storage-conformance-")));

const recording = new RecordingSink();
recording.info("hello", { a: 1 });
recording.warn("careful");
recording.error("boom", { code: "E" });
assert.equal(recording.events.length, 3, "RecordingSink captures log events");
assert.equal(recording.events[0].level, "info");

const nullSink = new NullSink();
assert.doesNotThrow(() => {
  nullSink.emit({ type: "ignored" });
  nullSink.info("ignored");
  nullSink.warn("ignored");
  nullSink.error("ignored");
});

console.log("storage-sink-conformance tests passed");
