"use strict";

// Behavior of the real verification_center tool: tool calls deliver its free-form
// `input` as a JSON string, which used to be spread as an object, silently
// dropping pinned commands and approved public API removals.
const assert = require("node:assert/strict");
const { execFileSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { tmpFixture } = require("./helpers/tmp-fixture");

// Keep the advisory providers out of this test; they do not affect the input contract.
process.env.PI_CODE_CONTEXT_MODE = "off";
process.env.PI_SEMGREP = "0";
process.env.PI_CODEGRAPH = "0";
process.env.PI_VISUAL_VERIFICATION = "0";

let piPackageRoot;
try {
  const candidate = path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
  if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
} catch {}
if (!piPackageRoot) {
  console.log("verification-center input behavior skipped (global pi install not found)");
  process.exit(0);
}
function runtimePackage(packageName, workspaceName) {
  const installed = path.join(piPackageRoot, "node_modules", "@earendil-works", packageName);
  if (fs.existsSync(path.join(installed, "package.json"))) return fs.realpathSync(installed);
  return fs.realpathSync(path.resolve(piPackageRoot, "..", workspaceName));
}

(async () => {
  const repo = tmpFixture("pi-verification-input-");
  try {
    const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    git("init", "--quiet");
    git("config", "user.email", "test@example.test");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n");
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src/api.js"), "module.exports = { keep, oldApi };\nfunction keep() { return 1; }\nfunction oldApi() { return 2; }\n");
    git("add", ".");
    git("commit", "--quiet", "-m", "base");
    fs.writeFileSync(path.join(repo, "src/api.js"), "module.exports = { keep };\nfunction keep() { return 1; }\n");

    const aiRoot = runtimePackage("pi-ai", "ai");
    const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
    const createJiti = jitiModule.createJiti || jitiModule;
    const extensionFile = path.resolve(".pi/extensions/verification-center/index.ts");
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
    const tool = tools.get("verification_center");
    assert.ok(tool, "verification_center is registered");
    const run = (input) => tool.execute("call", { operation: "run", profile: "changed", input }, undefined, undefined, { cwd: repo });

    const commands = [{ id: "pinned-marker", kind: "unit", command: process.execPath, args: ["-e", ""], timeoutMs: 30_000 }];
    const approval = { file: "src/api.js", symbol: "oldApi", reason: "owner-approved obsolete export" };

    const asString = (await run(JSON.stringify({ commands, acknowledgedPublicApiRemovals: [approval] }))).details;
    assert.deepEqual(asString.commands.map((command) => command.id), ["pinned-marker"], "a JSON-string input's pinned commands replace discovery");
    assert.equal(asString.evidence.ok, true, "the approved removal reaches the policy and the pinned verifier runs");
    assert.deepEqual(asString.evidence.verifiers.map((verifier) => verifier.id), ["pinned-marker"]);
    assert.deepEqual(asString.evidence.acknowledgedPublicApiRemovals, [approval], "the evidence records the approval");

    const asObject = (await run({ commands, acknowledgedPublicApiRemovals: [approval] })).details;
    assert.equal(asObject.evidence.ok, true, "an object input works as before");
    assert.deepEqual(asObject.evidence.verifiers.map((verifier) => verifier.id), ["pinned-marker"]);

    const unapproved = (await run(JSON.stringify({ commands }))).details;
    assert.equal(unapproved.evidence.status, "blocked", "without the approval the removal still blocks");
    assert.deepEqual(unapproved.evidence.verifiers, []);

    await assert.rejects(run("{not json"), /input must be a JSON object; it is not valid JSON/, "unreadable input fails instead of being ignored");
    await assert.rejects(run("[]"), /input must be a JSON object/, "a non-object input fails");
    await assert.rejects(run(42), /input must be a JSON object/);
    console.log("verification-center input tests passed");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
