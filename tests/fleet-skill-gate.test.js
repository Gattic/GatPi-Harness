#!/usr/bin/env node
"use strict";

// Guards the fleet update gate's skill-directory invariant. The managed catalog
// grows between releases, so the total skill-directory count is not constant;
// what must stay unchanged is the set of user-owned (non-managed) directories.
// The gate lives in scripts/fleet-host-update.sh, which runs only over SSH, so
// this exercises its unmanaged_digest helper directly.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = path.resolve(__dirname, "..");
const payload = fs.readFileSync(path.join(root, "scripts", "fleet-host-update.sh"), "utf8");
const helper = payload.match(/^unmanaged_digest\(\) \{[\s\S]*?^\}/m);
assert.ok(helper, "fleet-host-update.sh must define unmanaged_digest");

const tmp = tmpFixture("fleet-skill-gate-");

function writeSkill(dir, name) {
  const target = path.join(dir, name);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

function digest(dir, managed) {
  const script = [helper[0], 'dir="$1"; shift; unmanaged_digest "$dir" "$@"'].join("\n");
  const result = spawnSync("bash", ["-c", script, "bash", dir, ...managed], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

try {
  const skills = path.join(tmp, "skills");
  for (const name of ["alpha", "beta", "user-one"]) writeSkill(skills, name);

  const before = digest(skills, ["alpha", "beta"]);
  assert.match(before, /^[0-9a-f]{64}$/);

  // A managed name added by a later catalog must not change the digest.
  writeSkill(skills, "gamma");
  assert.equal(digest(skills, ["alpha", "beta", "gamma"]), before,
    "adding a managed skill must not change the user-owned directory digest");

  // An unmanaged directory that appears or disappears must change it.
  writeSkill(skills, "other");
  const withOther = digest(skills, ["alpha", "beta", "gamma"]);
  assert.notEqual(withOther, before, "a new user-owned skill directory must be detected");
  fs.renameSync(path.join(skills, "other", "SKILL.md"), path.join(skills, "other", "SKILL.md.bak"));
  assert.notEqual(digest(skills, ["alpha", "beta", "gamma"]), withOther,
    "a removed user-owned skill directory must be detected");
  assert.equal(digest(skills, ["alpha", "beta", "gamma"]), before,
    "removing the added directory returns the original digest");

  // A directory without SKILL.md is not a skill directory.
  fs.mkdirSync(path.join(skills, "notes"));
  assert.equal(digest(skills, ["alpha", "beta", "gamma"]), before,
    "a non-skill directory must be ignored");

  // A missing destination is an empty set, not an error.
  const empty = path.join(tmp, "empty-skills");
  fs.mkdirSync(empty);
  assert.equal(digest(path.join(tmp, "missing"), ["alpha"]), digest(empty, ["alpha"]),
    "a missing destination must hash the empty set");

  console.log("fleet skill-directory gate tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
