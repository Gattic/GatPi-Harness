#!/usr/bin/env node
"use strict";
const { tmpFixture } = require("./helpers/tmp-fixture");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  buildChangeSetFromEntries,
  captureWorkingTreeChangeSet,
  fingerprintChangeSet,
} = require("../src/verification-change-set.js");

function state(content) {
  if (content == null) return { kind: "missing", bytes: 0, digest: null, content: null };
  const value = Buffer.from(content);
  const crypto = require("node:crypto");
  return { kind: "file", bytes: value.length, digest: crypto.createHash("sha256").update(value).digest("hex"), content: value };
}

async function virtualEntries(count, mutateAt = -1) {
  return (async function* generate() {
    for (let index = 0; index < count; index++) {
      const file = `src/generated-${String(index).padStart(5, "0")}.js`;
      yield {
        path: file,
        before: state(`module.exports.value = ${index};\n`),
        after: state(`module.exports.value = ${index === mutateAt ? index + 1 : index};\n`),
      };
    }
  })();
}

(async () => {
  const large = await buildChangeSetFromEntries(await virtualEntries(5_265, 5_264));
  assert.equal(large.changedFiles.length, 5_265);
  assert.match(large.fingerprint, /^change-set-v2:sha256:[a-f0-9]{64}$/);
  assert.equal(large.before, undefined, "streamed change sets must not retain aggregate before content");
  assert.equal(large.after, undefined, "streamed change sets must not retain aggregate after content");
  assert(large.impact.semantic.length <= 100, "semantic evidence is a bounded sample");
  assert.equal(large.impact.semanticCount, 1);

  const same = await buildChangeSetFromEntries(await virtualEntries(5_265, 5_264));
  const changed = await buildChangeSetFromEntries(await virtualEntries(5_265, 5_263));
  assert.equal(same.fingerprint, large.fingerprint, "the streamed digest is deterministic");
  assert.notEqual(changed.fingerprint, large.fingerprint, "one changed file changes the digest");

  const raw = {
    changedFiles: ["b.js", "a.js"],
    before: { "a.js": "old-a", "b.js": "old-b" },
    after: { "a.js": "new-a", "b.js": "new-b" },
  };
  const reordered = {
    changedFiles: ["a.js", "b.js"],
    before: { "b.js": "old-b", "a.js": "old-a" },
    after: { "b.js": "new-b", "a.js": "new-a" },
  };
  assert.equal(fingerprintChangeSet(raw), fingerprintChangeSet(reordered), "path enumeration order does not affect the fingerprint");

  const tmp = tmpFixture("pi-verification-change-set-");
  const git = (args) => {
    const result = spawnSync("git", args, {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
    });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "-q"]);
  fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "src", "sample.js"), "module.exports = { alpha };\nfunction alpha() { return 1; }\n");
  fs.writeFileSync(path.join(tmp, "src", "deleted.js"), "export const removed = true;\n");
  fs.writeFileSync(path.join(tmp, "src", "binary.js"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(tmp, "src", "large.js"), `export const large = "${"a".repeat(100)}";\n`);
  git(["add", "."]); git(["commit", "-qm", "fixture"]);
  fs.writeFileSync(path.join(tmp, "src", "sample.js"), "module.exports = { alpha };\nfunction alpha() { return 2; }\n");
  fs.writeFileSync(path.join(tmp, "src", "new.js"), "export const added = true;\n");
  fs.rmSync(path.join(tmp, "src", "deleted.js"));
  fs.writeFileSync(path.join(tmp, "src", "binary.js"), Buffer.from([0, 3, 4]));
  fs.writeFileSync(path.join(tmp, "src", "large.js"), `export const large = "${"b".repeat(100)}";\n`);

  const captured = await captureWorkingTreeChangeSet({ cwd: tmp, files: ["src/sample.js", "src/new.js"] });
  assert.deepEqual(captured.changedFiles, ["src/new.js", "src/sample.js"]);
  assert.match(captured.fingerprint, /^change-set-v2:sha256:[a-f0-9]{64}$/);
  assert.equal(captured.before, undefined);
  assert.equal(captured.after, undefined);
  assert(captured.impact.categories.includes("semantic"));
  const edgeCases = await captureWorkingTreeChangeSet({
    cwd: tmp,
    files: ["src/deleted.js", "src/binary.js", "src/large.js"],
    maxAnalysisFileBytes: 32,
  });
  assert.deepEqual(edgeCases.changedFiles, ["src/binary.js", "src/deleted.js", "src/large.js"]);
  assert.equal(edgeCases.impact.analysisIncompleteCount, 2, "binary and oversized source files fail closed");
  assert(edgeCases.impact.publicApiChanges.some((change) => change.file === "src/deleted.js" && change.type === "removed" && change.symbol === "removed"), "deleted source files retain before-content analysis");

  const discovered = await captureWorkingTreeChangeSet({ cwd: tmp });
  assert.deepEqual(discovered.changedFiles, ["src/binary.js", "src/deleted.js", "src/large.js", "src/new.js", "src/sample.js"], "capture discovers tracked, untracked, deleted, binary, and oversized changes");

  console.log("verification change-set tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
