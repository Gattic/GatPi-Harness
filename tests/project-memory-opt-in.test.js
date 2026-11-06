"use strict";
const { tmpFixture } = require("./helpers/tmp-fixture");

// Real extension handlers and Pi SessionManager, without an LLM/provider. Each
// phase runs in a fresh process using harness defaults and isolated vault/state.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const candidate = { kind: "decision", title: "Quartz ledger storage", content: "The Quartz ledger stores durable decisions in managed project notes.", verification: "verified", sourceFingerprints: ["fixture-quartz-v1"] };

async function sessionPhase(phase, root, piRoot) {
  require("../src/harness-environment").applyHarnessEnvironmentDefaults();
  const { createJiti } = require(require.resolve("jiti", { paths: [piRoot] }));
  const { SessionManager } = await import(pathToFileURL(path.join(piRoot, "dist/index.js")).href);
  const jiti = createJiti(__filename, { interopDefault: true, alias: { typebox: require.resolve("typebox", { paths: [piRoot] }) } });
  const extension = await jiti.import(path.resolve(__dirname, "../.pi/extensions/memory-explorer/index.ts"), { default: true });
  const tools = new Map(); const hooks = new Map();
  extension({ registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {}, on(event, handler) { hooks.set(event, handler); } });
  const cwd = path.join(root, phase === "other-project" ? "other-project" : "repo");
  const sessionManager = SessionManager.create(cwd, path.join(root, "sessions"));
  const ctx = { cwd, sessionManager };
  const input = async (text, source = "user") => {
    if (source === "user") sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
    await hooks.get("input")({ text, source }, ctx);
  };
  const call = async (operation, input = {}, query) => (await tools.get("memory_curator").execute(operation, { operation, input, query }, undefined, undefined, ctx)).details;
  const save = (value = candidate, apply = true) => call("save", { apply, candidate: value });
  let result;
  if (phase === "save") {
    assert.equal((await save(candidate, false)).outcome, "preview");
    assert.equal((await save()).reasonCode, "explicit-memory-management-intent-required");
    await input("Save this project memory.", "extension");
    assert.equal((await save()).reasonCode, "explicit-memory-management-intent-required", "extension text is not user consent");
    assert.equal(fs.existsSync(path.join(root, "vault/Memory")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".pi/project-memory/decisions.jsonl")), false);
    await input("Please save this project memory decision.");
    for (const invalid of [
      { content: `Secret ${"sk-" + "A".repeat(32)}` },
      { content: "<pi-session-transcript>[synthetic marker]</pi-session-transcript>" },
      { content: "Current Git branch is main." },
      { kind: "current" }, // Current.md is a projection, never a writable candidate.
      { content: "" },
    ]) assert.equal((await save({ ...candidate, ...invalid })).outcome, "rejected");
    result = await save();
    assert.equal(result.outcome, "saved");
    assert.equal(result.applied, true);
    assert.equal(result.entry.content, undefined, "save receipt does not echo note bodies");
    assert.equal(result.rollout.stageAuthority, "explicit-m1-opt-in");
    assert.equal(result.rollout.evidenceEligibleStage, "M0");
    assert.equal((await save()).outcome, "deduped");
    assert.equal((await call("standing")).items.length, 0, "ordinary saves do not enable standing injection");
    await input("Please review this memory and queue it.");
    assert.equal((await call("reviewQueue", { apply: true, candidate })).reason, "review-queue-not-authorized-at-rollout-stage");
    await input("Explain the architecture.");
    assert.equal((await save()).reasonCode, "explicit-memory-management-intent-required", "an unrelated turn clears consent");
  } else {
    await input("Recall the Quartz ledger storage decision.");
    result = await call("recall", {}, "Quartz ledger");
    if (phase === "other-project") assert.equal(result.items.length, 0, "same vault does not grant cross-project recall");
    else {
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].content, candidate.content);
      assert.equal(result.items[0].standing, false);
      assert.equal(result.items[0].evidence.sourceKind, "canonical-vault");
      assert.equal((await save()).reasonCode, "explicit-memory-management-intent-required", "prior-session consent is not inherited");
      if (phase === "rollback") {
        await input("Please save this project memory decision.");
        assert.equal((await save()).reason, "explicit-writes-not-authorized-at-rollout-stage");
        const status = await call("status");
        assert.equal(status.rollout.effectiveStage, "M0");
        assert.equal(status.readiness.projectMemoryExplicitWrites.ready, false);
      }
    }
  }
  const status = await call("status");
  assert.equal(status.readiness.automaticBehaviorAuthorized.ready, false);
  assert.equal(status.rollout.controls.taskRecall, false);
  assert.equal(status.rollout.controls.automaticVerifiedUpserts, false);
  sessionManager.appendMessage({ role: "toolResult", toolName: "memory_curator", toolCallId: phase, content: [{ type: "text", text: "Isolated memory fixture completed." }], isError: false, timestamp: Date.now() });
  assert(fs.existsSync(sessionManager.getSessionFile()));
  console.log(JSON.stringify({ sessionId: sessionManager.getSessionId(), pid: process.pid, entryId: result.entry?.id || result.items?.[0]?.id || null, outcome: result.outcome || "recalled" }));
}

function vaultSnapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true }).sort().filter((name) => fs.statSync(path.join(dir, name)).isFile()).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]));
}

async function main() {
  if (process.argv[2] === "--session") return sessionPhase(...process.argv.slice(3));
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const piRoot = fs.realpathSync(path.join(globalRoot, "@earendil-works/pi-coding-agent"));
  const root = tmpFixture("pi-memory-opt-in-");
  for (const dir of ["repo/.git", "other-project/.git", "vault/.obsidian"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const env = { ...process.env, PI_PROJECT_MEMORY_POSTURE: "env", PI_OBSIDIAN_VAULT: path.join(root, "vault"), PI_OBSIDIAN_ALLOW_OUTSIDE: "1", PI_PROJECT_MEMORY: "1", PI_PROJECT_MEMORY_READS: "1", PI_MEMORY_EXPLORER: "1", PI_MEMORY_CURATOR: "1", PI_EXTENSION_TELEMETRY: "0", PI_MEMORY_MAINTENANCE_PREVIEW_INTERVAL_HOURS: "0" };
  // Exercise manual-only rollback of the automatic opt-in while retaining canonical M1 defaults.
  // PI_PROJECT_MEMORY_POSTURE=env keeps the repository's declared posture from
  // re-enabling automatic capture behind this rollback.
  env.PI_PROJECT_MEMORY_AUTOMATIC = "0";
  delete env.PI_PROJECT_MEMORY_STAGE;
  delete env.PI_PROJECT_MEMORY_WRITES;
  const run = (phase, overrides = {}) => JSON.parse(execFileSync(process.execPath, [__filename, "--session", phase, root, piRoot], { env: { ...env, ...overrides }, encoding: "utf8", timeout: 30000 }).trim());
  try {
    const saved = run("save");
    const snapshot = vaultSnapshot(path.join(root, "vault"));
    assert(Object.keys(snapshot).some((name) => name.endsWith("Decisions.md")));
    const recalled = run("recall");
    assert.notEqual(saved.pid, recalled.pid);
    assert.notEqual(saved.sessionId, recalled.sessionId);
    assert.equal(saved.entryId, recalled.entryId);
    run("other-project");
    const rollback = run("rollback", { PI_PROJECT_MEMORY_STAGE: "M0", PI_PROJECT_MEMORY_WRITES: "0" });
    assert.equal(rollback.entryId, saved.entryId, "rollback keeps prior memory readable");
    assert.deepEqual(vaultSnapshot(path.join(root, "vault")), snapshot, "recall, project isolation, and rollback do not rewrite canonical notes");
    fs.rmSync(root, { recursive: true, force: true });
    console.log("project memory opt-in tests passed (separate processes and persisted Pi sessions; no provider)");
  } catch (error) {
    console.error(`Failed isolated fixture retained at ${root}`);
    throw error;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
