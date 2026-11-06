"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { ProjectMemoryAdapter } = require("../src/integration-boundary");
const { ProjectMemoryIndex } = require("../src/project-memory-index");
const { tmpFixture } = require("./helpers/tmp-fixture");

function fixture(run) {
  const root = tmpFixture("project-memory-recall-exclusions-");
  const cwd = path.join(root, "repo");
  const vault = path.join(root, "vault");
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
  let now = Date.parse("2030-01-01T00:00:00Z");
  const adapter = new ProjectMemoryAdapter({ enabled: true, cwd, vault, writeEnabled: true, clock: () => new Date(now) });
  const save = (candidate) => {
    const result = adapter.save({ verification: "verified", ...candidate }, { explicit: true, apply: true });
    assert.equal(result.applied, true);
    return result.entry;
  };
  try {
    run({ adapter, save, now: () => now, advance: () => { now += 2000; } });
    fs.rmSync(root, { recursive: true, force: true });
  } catch (error) {
    console.error(`Failed recall fixture retained at ${root}`);
    throw error;
  }
}

for (const relation of ["supersedes", "contradicts"]) {
  for (const expired of [false, true]) {
    test(`${relation}: ${expired ? "expired" : "current"} corrections exclude claims before kind/query/cache limits`, () => fixture(({ adapter, save, now, advance }) => {
      const old = save({ kind: "decision", title: "Orion transport", content: "Orion transport uses protocol Alpha.", updatedAt: "2030-01-01T00:00:00Z" });
      const independent = save({ kind: "decision", title: "Orion transport checksums", content: "Orion transport retains checksums.", updatedAt: "2029-12-31T23:59:59Z" });
      // A differently titled, older, cross-kind correction falls outside a
      // one-item cache and the task's kind/query filters unless exclusions run first.
      const correction = save({ kind: "risk", title: "Compatibility policy", content: "Use protocol Beta for compatibility.", [relation]: [old.id], expiresAt: expired ? "2020-01-01T00:00:00Z" : "2030-01-01T00:00:01Z", updatedAt: "2029-12-31T23:59:58Z" });
      const query = "Orion transport";
      const options = { taskConditioned: true, kinds: ["decision"] };
      const ids = (result) => result.items.map((entry) => entry.id);
      assert.deepEqual(ids(adapter.recall(query, options)), [independent.id], "canonical recall must not revive the excluded claim");
      const index = new ProjectMemoryIndex({ store: adapter.store, now });
      assert.deepEqual(ids(index.search(query, options)), [independent.id], "store-backed indexes retain expired exclusion relationships");

      for (const limit of [100, 1]) {
        const cache = adapter.compile({ apply: true, limit });
        assert(!cache.items.some((entry) => entry.id === old.id), "compilation excludes claims before truncation");
        assert.equal(cache.items.some((entry) => entry.id === correction.id), !expired && relation === "supersedes" && limit > 1);
        assert(cache.items.some((entry) => entry.id === independent.id), "unrelated eligible memory survives");
        const recalled = adapter.recall(query, { ...options, cacheOnly: true });
        assert.equal(recalled.cacheSourceMatch, true);
        assert.deepEqual(ids(recalled), [independent.id]);
      }

      adapter.compile({ apply: true });
      advance();
      for (const cacheOnly of [false, true]) {
        assert.deepEqual(ids(adapter.recall(query, { ...options, cacheOnly })), [independent.id], "expiry after compilation cannot reinstate a predecessor");
        assert.equal(adapter.recall("protocol Beta", { cacheOnly }).items.length, 0, "expired corrections themselves cannot be returned");
      }
      const recompiled = adapter.compile({ apply: true, limit: 1 });
      assert.deepEqual(recompiled.items.map((entry) => entry.id), [independent.id], "recompilation after expiry preserves exclusions");
      assert.deepEqual(ids(adapter.recall(query, { ...options, cacheOnly: true })), [independent.id]);
    }));
  }
}

test("cache expiry is checked at recall time without a canonical mutation", () => fixture(({ adapter, save, advance }) => {
  const entry = save({ kind: "decision", title: "Orion transport lease", content: "Orion transport uses a bounded lease.", expiresAt: "2030-01-01T00:00:01Z" });
  assert.equal(adapter.recall("Orion transport", { cacheOnly: true }).items[0].id, entry.id);
  advance();
  const result = adapter.recall("Orion transport", { cacheOnly: true });
  assert.equal(result.cacheSourceMatch, true);
  assert.deepEqual(result.items, []);
}));

test("legacy caches without exclusion guarantees fail closed until recompiled", () => fixture(({ adapter, save }) => {
  const old = save({ kind: "decision", title: "Orion transport", content: "Orion transport uses protocol Alpha." });
  save({ kind: "risk", title: "Compatibility policy", content: "Use protocol Beta for compatibility.", supersedes: [old.id], expiresAt: "2020-01-01T00:00:00Z" });
  const legacy = { ...adapter.compile(), schemaVersion: 1, items: [{ ...old, note: "legacy-fixture.md" }] };
  fs.writeFileSync(adapter.recaller.cacheFile, JSON.stringify(legacy), { mode: 0o600 });
  const stale = adapter.recall("Orion transport", { cacheOnly: true });
  assert.equal(stale.reason, "stale-cache");
  assert.equal(stale.cacheSourceMatch, false);
  assert.deepEqual(stale.items, []);
  adapter.compile({ apply: true });
  const rebuilt = adapter.recall("Orion transport", { cacheOnly: true });
  assert.equal(rebuilt.cacheSourceMatch, true);
  assert.deepEqual(rebuilt.items, []);
}));
