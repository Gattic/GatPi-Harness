"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { scanEvidence, resolveEvidenceArtifact, formatEvidence } = require("../src/evidence-inbox.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = tmpFixture("pi-evidence-");
const shots = path.join(root, "shots");
const repo = path.join(root, "repo");
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(repo, { recursive: true });

fs.writeFileSync(path.join(shots, "screenshot-1.png"), "png");
fs.writeFileSync(path.join(repo, "perf.data"), "perf");
fs.writeFileSync(path.join(repo, "run.log"), "log line\n");
fs.writeFileSync(path.join(repo, "capture.visual-evidence.json"), JSON.stringify({ schemaVersion: 1 }));
fs.writeFileSync(path.join(repo, "code.cpp"), "int x;");
fs.writeFileSync(path.join(shots, "ancient.png"), "old");
const old = (Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000;
fs.utimesSync(path.join(shots, "ancient.png"), old, old);

const found = scanEvidence(repo, { roots: [shots, repo], sinceMinutes: 60 });
assert.deepEqual(found.entries.map((entry) => entry.kind).sort(), ["image", "log", "profile", "visual-manifest"]);
assert(found.entries.every((entry) => !Object.hasOwn(entry, "displayName")), "public entries omit filenames");
assert.equal(found.rootCount, 2);
assert.equal(Object.hasOwn(found, "roots"), false, "public result omits configured paths");
assert(found.entries.every((entry) => /^artifact_[a-f0-9]{32}$/.test(entry.artifactRef)));
assert(found.entries.every((entry) => !Object.hasOwn(entry, "file")), "public entries omit absolute paths");

const shot = found.entries.find((entry) => entry.kind === "image");
assert.equal(shot.kind, "image");
const resolved = resolveEvidenceArtifact(repo, shot.artifactRef, { roots: [shots, repo] });
assert.equal(resolved.file, path.join(shots, "screenshot-1.png"), "trusted resolver returns the path only in memory");
assert.equal(resolveEvidenceArtifact(repo, "artifact_invalid", { roots: [shots] }), null);

const text = formatEvidence(found);
assert.doesNotMatch(text, /screenshot-1\.png|perf\.data|run\.log|capture\.visual-evidence\.json/);
assert.match(text, /artifact_/);
assert(!text.includes(root), "formatted evidence is path-free");

const none = scanEvidence(repo, { roots: [shots], sinceMinutes: 60, kinds: ["video"] });
assert.equal(none.entries.length, 0);
assert.match(formatEvidence(none), /no recent evidence/i);

console.log("evidence-inbox tests passed");
