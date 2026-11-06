"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { tmpFixture } = require("./helpers/tmp-fixture");
const root = path.resolve(__dirname, ".."); const tmp = tmpFixture("project-memory-ops-scripts-"); const cwd = path.join(tmp, "repo"); fs.mkdirSync(cwd); const env = { ...process.env };
function run(script, args = []) { return execFileSync(process.execPath, [path.join(root, "scripts", script), ...args], { cwd, env, encoding: "utf8", timeout: 30000 }); }
function blocked(script, args, pattern) { const result = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], { cwd, env, encoding: "utf8", timeout: 30000 }); assert.notEqual(result.status, 0); assert.match(`${result.stdout}\n${result.stderr}`, pattern); }

const managed = path.join(cwd, ".pi", "cognitive-automation"); fs.mkdirSync(managed, { recursive: true, mode: 0o755 }); fs.chmodSync(managed, 0o755); const managedFile = path.join(managed, "state.json"); fs.writeFileSync(managedFile, "{}\n", { mode: 0o644 }); fs.chmodSync(managedFile, 0o644);
blocked("harden-managed-memory-state.js", ["--apply", "--yes"], /--manifest=<preview-id>/); assert.equal(fs.statSync(managedFile).mode & 0o777, 0o644);
const permissionPreview = JSON.parse(run("harden-managed-memory-state.js")); const permissionApplied = JSON.parse(run("harden-managed-memory-state.js", [`--manifest=${permissionPreview.manifestId}`, "--apply", "--yes"])); assert.equal(permissionApplied.ok, true); assert.equal(fs.statSync(managedFile).mode & 0o777, 0o600);

blocked("project-memory-retention.js", ["--class=trace", "--apply", "--yes"], /--manifest=<preview-id>/); const retentionPreview = JSON.parse(run("project-memory-retention.js")); const retentionApplied = JSON.parse(run("project-memory-retention.js", [`--manifest=${retentionPreview.manifestId}`, "--class=trace", "--apply", "--yes"])); assert.equal(retentionApplied.ok, true);

console.log("project memory operations script tests passed");
