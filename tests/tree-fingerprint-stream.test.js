#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { captureTreeFingerprint } = require("../src/tree-fingerprint.js");
const {
  fingerprintStatusStream,
} = require("../src/tree-fingerprint-worker.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

function statusStream(count) {
  return (async function* generate() {
    const padding = "segment/".repeat(70);
    for (let index = 0; index < count; index++) yield Buffer.from(`? generated/${padding}${String(index).padStart(5, "0")}.txt\0`);
  })();
}

(async () => {
  const count = 20_000;
  const identity = async (file) => `sha256:${file.endsWith("19999.txt") ? "b" : "a"}`;
  const first = await fingerprintStatusStream(statusStream(count), { contentIdentity: identity });
  const second = await fingerprintStatusStream(statusStream(count), { contentIdentity: identity });
  assert.equal(first.available, true);
  assert.equal(first.fileCount, count);
  assert(first.statusBytes > 10 * 1024 * 1024, "the synthetic status exceeds the old spawnSync maxBuffer");
  assert.match(first.statusFingerprint, /^[a-f0-9]{24}$/);
  assert.equal(second.statusFingerprint, first.statusFingerprint, "streamed status fingerprints are deterministic");

  const changed = await fingerprintStatusStream(statusStream(count), {
    contentIdentity: async (file) => `sha256:${file.endsWith("19998.txt") ? "changed" : file.endsWith("19999.txt") ? "b" : "a"}`,
  });
  assert.notEqual(changed.statusFingerprint, first.statusFingerprint, "one working-file identity changes the tree fingerprint");

  const tmp = tmpFixture("pi-tree-fingerprint-stream-");
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: tmp, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" } });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "-q"]);
  fs.writeFileSync(path.join(tmp, "file.txt"), "before\n");
  git(["add", "."]); git(["commit", "-qm", "fixture"]);
  fs.writeFileSync(path.join(tmp, "file.txt"), "after\n");
  const captured = captureTreeFingerprint(tmp);
  assert.equal(captured.gatingSafe, true);
  assert.equal(captured.schemaVersion, 2);
  assert.equal(captured.revision.source, "git-status-stream-v2");
  fs.writeFileSync(path.join(tmp, "file.txt"), "after again\n");
  const recaptured = captureTreeFingerprint(tmp);
  assert.notEqual(recaptured.fingerprint, captured.fingerprint, "content changes alter the fingerprint even when porcelain status text is unchanged");

  console.log("tree fingerprint stream tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
