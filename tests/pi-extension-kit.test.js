"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  readJson,
  writeJson,
  envEnabled,
  includeGlobal,
  short,
  boundedContext,
  createContextInjector,
  normalizeOperation,
  normalizeStringList,
  execCapture,
  registerOperationTool,
  createExtensionTelemetry,
  readExtensionTelemetry,
  instrumentExtensionCommands,
  notify,
} = require("../src/pi-extension-kit.js");
const { tmpFixture } = require("./helpers/tmp-fixture");
assert.equal(typeof createExtensionTelemetry, "function");
assert.equal(typeof readExtensionTelemetry, "function");
assert.equal(typeof instrumentExtensionCommands, "function");

// notify: uses ctx.ui when a UI is attached, falls back to stdout in
// headless (-p) runs so command output is never silently dropped.
{
  const uiCalls = [];
  notify({ hasUI: true, ui: { notify: (msg, level) => uiCalls.push([msg, level]) } }, "with-ui", "warning");
  assert.deepEqual(uiCalls, [["with-ui", "warning"]]);

  const logged = [];
  const origLog = console.log;
  console.log = (msg) => logged.push(msg);
  try {
    notify({ hasUI: false, ui: { notify: () => { throw new Error("must not be called"); } } }, "headless-out");
    notify({}, "no-ui-object");
  } finally {
    console.log = origLog;
  }
  assert.deepEqual(logged, ["headless-out", "no-ui-object"]);
}

const tmp = tmpFixture("pi-extension-kit-");

// readJson / writeJson round-trip, fallback on missing/corrupt files, dir creation.
const stateFile = path.join(tmp, "nested", "state.json");
assert.equal(readJson(stateFile, null), null);
assert.deepEqual(readJson(stateFile, { a: 1 }), { a: 1 });
writeJson(stateFile, { hello: "world" });
assert.deepEqual(readJson(stateFile, null), { hello: "world" });
fs.writeFileSync(stateFile, "{corrupt");
assert.deepEqual(readJson(stateFile, { fallback: true }), { fallback: true });

// envEnabled: default on, "0" disables, any other value stays on.
assert.equal(envEnabled("PI_KIT_TEST_FLAG", {}), true);
assert.equal(envEnabled("PI_KIT_TEST_FLAG", { PI_KIT_TEST_FLAG: "0" }), false);
assert.equal(envEnabled("PI_KIT_TEST_FLAG", { PI_KIT_TEST_FLAG: "1" }), true);

// includeGlobal: string args and object args.
assert.equal(includeGlobal("--global"), true);
assert.equal(includeGlobal("--include-global"), true);
assert.equal(includeGlobal("plain query"), false);
assert.equal(includeGlobal({ includeGlobal: true }), true);
assert.equal(includeGlobal({ global: true }), true);
assert.equal(includeGlobal({}), false);
assert.equal(includeGlobal(undefined), false);

// short: identity under limit, slice + ellipsis over limit, null-safe.
assert.equal(short("abc", 10), "abc");
assert.equal(short("abcdef", 3), "abc…");
assert.equal(short(null, 3), "");

// Automatic context injection: hard cap, once-per-session deduplication,
// reset on session changes, and optional changed-content updates.
const bounded = boundedContext("x".repeat(200), 80);
assert.equal(bounded.length, 80);
assert.match(bounded, /context capped at 80 chars/);
const onceInjector = createContextInjector({ customType: "test-context", maxChars: 80 });
const firstInjection = onceInjector.inject("x".repeat(200));
assert.equal(firstInjection.message.customType, "test-context");
assert.equal(firstInjection.message.content.length, 80);
assert.equal(onceInjector.inject("changed"), null, "once-per-session injection suppresses later content");
onceInjector.reset();
assert.equal(onceInjector.inject("changed").message.content, "changed", "new sessions may inject again");
const deltaInjector = createContextInjector({ customType: "changing-context", once: false });
assert(deltaInjector.inject("first"));
assert.equal(deltaInjector.inject("first"), null, "identical content is deduplicated");
assert(deltaInjector.inject("second"), "changed content remains injectable");

// Operation and list normalization accept common model spellings while
// preserving canonical operation names and actionable failures.
assert.equal(normalizeOperation("capture_verification", { toolName: "demo", operations: ["captureVerification"] }), "captureVerification");
assert.equal(normalizeOperation("summary", { toolName: "demo", operations: ["prSummary"], aliases: { summary: "prSummary" } }), "prSummary");
assert.throws(() => normalizeOperation("wat", { toolName: "demo", operations: ["status", "run"] }), /Use one of: status, run/);
assert.deepEqual(normalizeStringList("tests/a.test.js", "files"), ["tests/a.test.js"]);
assert.deepEqual(normalizeStringList(["a", " b "], "files"), ["a", "b"]);
assert.throws(() => normalizeStringList({ file: "a" }, "files"), /string or an array of strings/);

// execCapture: captures stdout/exit code, reports failures without throwing.
const ok = execCapture("node", ["-e", "console.log('kit-out')"], { cwd: tmp });
assert.equal(ok.status, 0);
assert.match(ok.stdout, /kit-out/);
const bad = execCapture("node", ["-e", "process.exit(3)"], { cwd: tmp });
assert.equal(bad.status, 3);
const missing = execCapture("definitely-not-a-real-binary-xyz", [], { cwd: tmp });
assert.notEqual(missing.status, 0);
assert.ok(missing.error, "missing binary reports an error instead of throwing");

// registerOperationTool: registers a tool whose execute dispatches on params.operation
// and wraps handler results in { content, details }.
const registered = [];
const fakePi = { registerTool(def) { registered.push(def); } };
registerOperationTool(fakePi, {
  name: "kit_demo",
  label: "Kit demo",
  description: "demo",
  parameters: { fake: true },
  defaultOperation: "status",
  handlers: {
    status: (ctx, params) => ({ op: "status", cwd: ctx.cwd, echoed: params.query || null }),
    plan: async () => ({ op: "plan" }),
  },
});
assert.equal(registered.length, 1);
assert.equal(registered[0].name, "kit_demo");
assert.deepEqual(registered[0].parameters, { fake: true });

const ctx = { cwd: tmp };
(async () => {
  const statusResult = await registered[0].execute("id", { query: "q" }, null, null, ctx);
  assert.deepEqual(statusResult.details, { op: "status", cwd: tmp, echoed: "q" });
  assert.match(statusResult.content[0].text, /"op": "status"/);

  const planResult = await registered[0].execute("id", { operation: "plan" }, null, null, ctx);
  assert.deepEqual(planResult.details, { op: "plan" });

  const unknown = await registered[0].execute("id", { operation: "nope" }, null, null, ctx);
  assert.deepEqual(unknown.details, { op: "status", cwd: tmp, echoed: null }, "unknown operations fall back to the default");

  // setTurnExitCode: headless failures set the process exit code once;
  // interactive sessions and success paths never touch it.
  const { setTurnExitCode } = require("../src/pi-extension-kit.js");
  const savedExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    assert.equal(setTurnExitCode({ hasUI: true }), false, "interactive sessions are untouched");
    assert.equal(process.exitCode, undefined);
    assert.equal(setTurnExitCode({}), false, "unknown UI state is treated as interactive");
    assert.equal(setTurnExitCode({ hasUI: false }, 0), false, "success codes are not recorded");
    assert.equal(process.exitCode, undefined);
    assert.equal(setTurnExitCode({ hasUI: false }), true, "headless failure sets the exit code");
    assert.equal(process.exitCode, 1);
    assert.equal(setTurnExitCode({ hasUI: false }, 3), true, "a later failure keeps the first nonzero code");
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = savedExitCode;
  }

  console.log("pi-extension-kit tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
