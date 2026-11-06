#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { CodeContentCache, contentIdentity } = require("../src/code-content-cache.js");
const { CodeContextLedger } = require("../src/code-context-ledger.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-code-context-ledger-");
function git(args) { const result = spawnSync("git", args, { cwd: tmp, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } }); assert.equal(result.status, 0, result.stderr); }
git(["init", "-q"]);
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.writeFileSync(path.join(tmp, "src", "a.js"), "function a() { return 1; }\n");
git(["add", "."]); git(["commit", "-qm", "fixture"]);
const clean = contentIdentity(tmp, "src/a.js");
assert.equal(clean.scheme, "git");
fs.appendFileSync(path.join(tmp, "src", "a.js"), "// changed\n");
const dirty = contentIdentity(tmp, "src/a.js");
assert.equal(dirty.scheme, "sha256");

const cache = new CodeContentCache(tmp, { maxExtractBytes: 512, maxObjectBytes: 1024 });
const cached = cache.put({ projectId: "project", revision: "r1", configuration: "Debug", path: "src/a.js", range: { startLine: 1, endLine: 1 }, detail: "body", contentHash: dirty.contentHash, extract: "x".repeat(800), explicitBody: false });
assert.equal(cached.truncated, true);
assert.ok(cached.bytes <= 512);
assert.equal(fs.statSync(cache.objectFile(cached.contentRef)).mode & 0o077, 0);

const ledger = new CodeContextLedger(tmp, { projectId: "project", sessionId: "session-1", stateRoot: cache.root });
const scope = { revision: "r1", configuration: "Debug", path: "src/a.js", range: { startLine: 1, endLine: 1 }, symbolId: "a", detail: "body", contentHash: dirty.contentHash };
ledger.record({ ...scope, contentRef: cached.contentRef, sessionEntryId: "entry-1", visible: true });
assert.equal(ledger.lookup(scope).reusable, true);
ledger.clearVisibility();
const hidden = ledger.lookup(scope);
assert.equal(hidden.known, true);
assert.equal(hidden.reusable, false, "known cache content must be resent when no longer visible");
ledger.reconstruct([{ id: "entry-2", details: { queryId: "q1", items: [{ path: "src/a.js", symbolId: "a", contentRef: cached.contentRef }] } }]);
assert.equal(ledger.lookup(scope).reusable, true);
ledger.compact([]);
assert.equal(ledger.lookup(scope).reusable, false, "compaction without source-bearing results clears visibility");
ledger.reconstruct([{ id: "entry-3", details: { queryId: "q2", items: [{ path: "src/a.js", symbolId: "a", contentRef: cached.contentRef }] } }]);
ledger.invalidate(["src/a.js"]);
assert.equal(ledger.lookup(scope).reusable, false);
ledger.persist();
const restored = new CodeContextLedger(tmp, { projectId: "project", sessionId: "session-1", stateRoot: cache.root });
assert.equal(restored.summary().stale, 1);
const fork = new CodeContextLedger(tmp, { projectId: "project", sessionId: "fork", stateRoot: cache.root });
assert.equal(fork.lookup(scope).known, false, "fork visibility/state is session scoped until active details are reconstructed");

const orphan = cache.put({ projectId: "project", revision: "old", path: "src/a.js", detail: "card", contentHash: "sha256:old", extract: "old" });
const oldTime = new Date(Date.now() - 20 * 86400000);
fs.utimesSync(cache.objectFile(orphan.contentRef), oldTime, oldTime);
const preview = cache.garbageCollect({ maxBytes: 1, maxAgeMs: 1, protectedRefs: [cached.contentRef] });
assert.ok(preview.candidates.some((item) => item.contentRef === orphan.contentRef));
assert.ok(preview.candidates.every((item) => item.contentRef !== cached.contentRef));
const applied = cache.garbageCollect({ maxBytes: 1, maxAgeMs: 1, protectedRefs: [cached.contentRef], apply: true });
assert.ok(applied.afterBytes > 0);
console.log("code-context ledger tests passed");
