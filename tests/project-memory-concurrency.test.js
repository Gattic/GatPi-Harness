"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { ProjectMemoryStore } = require("../src/project-memory-store");
const { tmpFixture } = require("./helpers/tmp-fixture");
const tmp = tmpFixture("project-memory-concurrency-"); const cwd = path.join(tmp, "repo"); const vault = path.join(tmp, "vault"); fs.mkdirSync(cwd); fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true }); const worker = path.join(__dirname, "fixtures", "project-memory-concurrent-writer.fixture"); const startAt = Date.now() + 500;
function run(title) { return new Promise((resolve, reject) => { const child = spawn(process.execPath, [worker, cwd, vault, title, String(startAt)], { stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => stdout += chunk); child.stderr.on("data", (chunk) => stderr += chunk); child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `writer exited ${code}`))); }); }
Promise.all([run("Concurrent A"), run("Concurrent B")]).then((outcomes) => { assert.deepEqual(outcomes.sort(), ["saved", "saved"]); const store = new ProjectMemoryStore({ cwd, vault, writeEnabled: false }); const entries = store.readKind("decision").entries; assert.equal(entries.length, 2, "serial project lock prevents lost concurrent note updates"); assert.deepEqual(entries.map((entry) => entry.title).sort(), ["Concurrent A", "Concurrent B"]); assert.equal(store.readKind("current").entries.length, 2); const lockDir = path.join(cwd, ".pi", "project-memory", "locks"); assert.equal(fs.existsSync(lockDir) ? fs.readdirSync(lockDir).length : 0, 0, "locks are released after writes"); console.log("project memory concurrency tests passed"); }).catch((error) => { console.error(error); process.exit(1); });
