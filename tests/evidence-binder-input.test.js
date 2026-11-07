"use strict";

// Behavior of the real evidence_binder tool: tool calls deliver its free-form
// `input` as a JSON string, which used to be read as a packet with no fields,
// saved as empty evidence, and reported current.
const assert = require("node:assert/strict");
const { execFileSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { EvidenceStore } = require("../src/evidence-binder");
const { tmpFixture } = require("./helpers/tmp-fixture");

let piPackageRoot;
try {
  const candidate = path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
  if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
} catch {}
if (!piPackageRoot) {
  console.log("evidence-binder input behavior skipped (global pi install not found)");
  process.exit(0);
}
function runtimePackage(packageName, workspaceName) {
  const installed = path.join(piPackageRoot, "node_modules", "@earendil-works", packageName);
  if (fs.existsSync(path.join(installed, "package.json"))) return fs.realpathSync(installed);
  return fs.realpathSync(path.resolve(piPackageRoot, "..", workspaceName));
}

(async () => {
  const repo = tmpFixture("pi-evidence-binder-input-");
  try {
    const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "--quiet");
    git("config", "user.email", "test@example.test");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n");
    fs.writeFileSync(path.join(repo, "foo.js"), "module.exports = 1;\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");

    const aiRoot = runtimePackage("pi-ai", "ai");
    const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
    const createJiti = jitiModule.createJiti || jitiModule;
    const extensionFile = path.resolve(".pi/extensions/evidence-binder/index.ts");
    const jiti = createJiti(extensionFile, {
      interopDefault: true,
      alias: {
        typebox: require.resolve("typebox", { paths: [piPackageRoot] }),
        "@earendil-works/pi-coding-agent": piPackageRoot,
        "@earendil-works/pi-ai/compat": path.join(aiRoot, "dist", "compat.js"),
        "@earendil-works/pi-ai": aiRoot,
      },
    });
    const mod = await jiti.import(extensionFile);
    const tools = new Map();
    (mod.default || mod)({ on() {}, registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); }, events: { on() { return () => {}; }, emit() {} } });
    const tool = tools.get("evidence_binder");
    assert.ok(tool, "evidence_binder is registered");
    const call = async (params) => (await tool.execute("call", params, undefined, undefined, { cwd: repo })).details;
    const store = new EvidenceStore({ cwd: repo });
    const ledgerRows = () => store.status().evidenceCount;

    const inputSchema = tool.parameters.properties.input;
    assert.deepEqual(inputSchema.anyOf.map((schema) => schema.type), ["object", "string"], "input is declared as an object or a JSON string");
    assert.equal((tool.parameters.required || []).includes("input"), false);

    const packet = { source: "fixture", ok: true, confidence: 0.9, summary: "tests passed for foo", commands: ["node tests/foo.test.js"], files: ["foo.js"], artifacts: ["log#sha256:abc"], metadata: { item: "1" } };
    const fromString = await call({ operation: "capture", input: JSON.stringify(packet) });
    assert.equal(fromString.ok, true, "a JSON-string capture keeps its fields");
    assert.equal(fromString.summary, "tests passed for foo");
    assert.deepEqual([fromString.commandCount, fromString.fileCount, fromString.artifactCount], [1, 1, 1]);
    assert.equal(fromString.freshness.status, "current");
    assert.equal(store.validateEvidenceId(fromString.id).reason, "current-evidence-packet", "the captured packet can substantiate verification");
    const fromObject = await call({ operation: "capture", input: packet });
    assert.equal(fromObject.ok, true, "an object capture works as before");
    assert.equal(fromObject.commandCount, 1);

    const before = ledgerRows();
    await assert.rejects(call({ operation: "capture" }), /Evidence packet has no content/, "a capture without input is refused");
    await assert.rejects(call({ operation: "capture", input: {} }), /no content/);
    await assert.rejects(call({ operation: "capture", input: "{}" }), /no content/);
    await assert.rejects(call({ operation: "capture", input: JSON.stringify({ source: "fixture", ok: true, confidence: 1 }) }), /no content/, "ok and confidence alone are not evidence");
    await assert.rejects(call({ operation: "capture", input: "{not json" }), /evidence_binder input must be a JSON object; it is not valid JSON/, "unreadable input fails instead of being ignored");
    await assert.rejects(call({ operation: "capture", input: "[]" }), /evidence_binder input must be a JSON object/, "a non-object input fails");
    await assert.rejects(call({ operation: "status", input: 42 }), /evidence_binder input must be a JSON object/, "every operation parses its input");
    assert.equal(ledgerRows(), before, "rejected captures register nothing");

    const claim = await call({ operation: "check", input: JSON.stringify({ text: "Tests passed for foo." }) });
    assert.equal(claim.claims.length, 1, "check reads its text from a JSON-string input");
    assert.equal(claim.ok, true);
    const status = await call({ operation: "status", input: JSON.stringify({ detail: true }) });
    assert.ok(status.latestDetail, "status reads its options from a JSON-string input");
    console.log("evidence-binder input tests passed");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
