#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { TestEvidenceIndex, percentile } = require("../src/test-evidence-index.js");
const { historicalTestEdgesFromOutcomes } = require("../src/learning-loop.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-test-evidence-");
const index = new TestEvidenceIndex(tmp);
const ingested = index.ingest([
  { test: "tests/a.test.js", entity: "src/a.js", relation: "covered", revision: "r1", configuration: "Debug", durationMs: 100 },
  { test: "tests/a.test.js", entity: "src/a.js", relation: "called", revision: "r1", configuration: "Debug", durationMs: 200 },
  { test: "tests/b.test.js", entity: "src/a.js", relation: "unknown" },
]);
assert.equal(ingested.accepted.length, 2);
assert.equal(ingested.rejected.length, 1);
assert.equal(index.queryEntity("src/a.js", { configuration: "Debug" }).length, 2);
assert(index.queryEntity("src/a.js", { configuration: "Debug", revision: "r1" }).every(row => row.gatingSafe));
assert(index.queryEntity("src/a.js", { configuration: "Debug", revision: "r2" }).every(row => !row.gatingSafe && row.freshness === "stale"));
assert(index.queryEntity("src/a.js", { configuration: "Debug" }).every(row => !row.gatingSafe), "missing revision cannot authorize coverage");
assert.equal(index.queryEntity("src/a.js", { configuration: "Release", revision: "r1" }).length, 0);
assert.equal(index.ingest([{ test: "tests/a.test.js", entity: "../outside.js", relation: "covered" }]).rejected.length, 1);
assert.equal(index.estimatedRuntime("tests/a.test.js"), 100);
assert.deepEqual(index.durationStats("tests/a.test.js"), { count: 2, p50: 100, p95: 100, max: 200 });
assert.equal(percentile([1, 2, 3], 0.95), 2);
const historical = historicalTestEdgesFromOutcomes([{ id: "o1", changedFiles: ["src/a.js"], tests: ["tests/a.test.js"], confidence: 0.9 }]);
assert.equal(historical[0].confidence, 0.49);
assert.equal(historical[0].gatingSafe, false);
index.ingestHistorical(historical);
assert.equal(index.summary().historical, 1);
const file = index.persist();
assert.equal(fs.statSync(file).mode & 0o077, 0);
const restored = new TestEvidenceIndex(tmp);
assert.equal(restored.summary().edges, 3);

const capacityFile = path.join(tmp, "capacity.json");
const full = new TestEvidenceIndex(tmp, { file: capacityFile });
full.ingestHistorical(historical.map(row => ({ ...row, configuration: "Debug" })));
const oldRows = Array.from({ length: 4997 }, (_, i) => ({ test: "tests/old.test.js", entity: `src/old-${i}.js`, relation: "covered", revision: "r1", configuration: "Debug" }));
assert.equal(full.ingest([
  ...oldRows,
  { test: "tests/current.test.js", entity: "src/current.js", relation: "covered", revision: "r2", configuration: "Debug" },
  { test: "tests/release.test.js", entity: "src/release.js", relation: "covered", revision: "release-r1", configuration: "Release" },
]).accepted.length, 4999);
assert.equal(full.summary().edges, 5000);
full.persist();
const capped = new TestEvidenceIndex(tmp, { file: capacityFile });
const next = { test: "tests/new.test.js", entity: "src/new.js", relation: "covered", revision: "r2", configuration: "Debug" };
for (const unqualified of [{ revision: "unknown" }, { freshness: "stale" }, { gatingSafe: false }]) {
  const result = capped.ingest([{ ...next, ...unqualified }]);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reason, "evidence-capacity");
  assert.equal(capped.summary().edges, 5000, "unqualified evidence cannot evict existing observations");
}
assert.equal(capped.ingest([{ ...next, entity: "../outside.js" }]).rejected[0].reason, "outside-repository");
assert.equal(capped.summary().edges, 5000, "invalid input cannot trigger eviction");
const replacement = capped.ingest([next]);
assert.equal(replacement.accepted.length, 1, "a persisted full index must admit current evidence by evicting superseded revisions");
assert.equal(replacement.rejected.length, 0);
assert.equal(capped.summary().edges, 4);
assert.equal(capped.queryEntity("src/old-0.js", { revision: "r1", configuration: "Debug" }).length, 0);
assert.equal(capped.queryEntity("src/current.js", { revision: "r2", configuration: "Debug" })[0].gatingSafe, true, "same-revision evidence survives eviction");
assert.equal(capped.queryEntity("src/release.js", { revision: "release-r1", configuration: "Release" })[0].gatingSafe, true, "other configurations survive eviction");
assert.equal(capped.summary().historical, 1, "historical observations are not disposable runtime coverage");
capped.persist();
const retained = new TestEvidenceIndex(tmp, { file: capacityFile });
assert.equal(retained.summary().edges, 4);
assert.equal(retained.queryEntity("src/new.js", { revision: "r2", configuration: "Debug" })[0].gatingSafe, true);
assert.equal(retained.ingest(oldRows.slice(0, 4996).map(row => ({ ...row, revision: "r2" }))).accepted.length, 4996);
assert.equal(retained.summary().edges, 5000);
assert.equal(retained.ingest([{ ...next, entity: "src/overflow.js" }]).rejected[0].reason, "evidence-capacity", "the hard cap remains when no superseded records can be reclaimed");
assert.equal(retained.summary().edges, 5000);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("test evidence index tests passed");
