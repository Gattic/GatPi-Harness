"use strict";

// Behavioral script-check tests for the run-monitor extension: loads index.ts
// through Pi's jiti loader against a stub Pi API and drives the real timer,
// session-restore, slash-command, and tool paths over repository-local jobs.

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// The extension imports execFile at module load. Wrap it so a test can
// simulate a script failure without renaming the shared checker file.
const realExecFile = childProcess.execFile;
let failScriptChecks = false;
let scriptCalls = 0;
let scriptDelayMs = 0;
childProcess.execFile = (...args) => {
  scriptCalls += 1;
  if (failScriptChecks) {
    const callback = args[args.length - 1];
    if (typeof callback === "function") process.nextTick(() => callback(new Error("simulated script check failure"), "", ""));
    return undefined;
  }
  const invoke = () => realExecFile(...args);
  if (scriptDelayMs > 0) {
    setTimeout(invoke, scriptDelayMs);
    return undefined;
  }
  return invoke();
};

process.env.PI_EXTENSION_TELEMETRY = "0";
process.env.PI_RUN_MONITOR_INTENT_TELEMETRY = "0";

let piPackageRoot;
try {
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  const candidate = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
  if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
} catch {}
if (!piPackageRoot) {
  console.log("run-monitor extension behavior skipped (global pi install not found)");
  process.exit(0);
}

function runtimePackage(packageName, workspaceName) {
  const installed = path.join(piPackageRoot, "node_modules", "@earendil-works", packageName);
  if (fs.existsSync(path.join(installed, "package.json"))) return fs.realpathSync(installed);
  return fs.realpathSync(path.resolve(piPackageRoot, "..", workspaceName));
}

const { readMonitor, listMonitors } = require("../src/run-monitor.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const SESSION_ID = "session-run-monitor-script";
const fixtureDirs = [];

function writeJob(cwd, jobId, options = {}) {
  const dir = path.join(cwd, ".pi", "jobs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${jobId}.json`), JSON.stringify({
    jobId,
    name: "script check test job",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    managedUsage: { eligible: true, starts: 1 },
  }));
  if (options.log) fs.writeFileSync(path.join(dir, `${jobId}.log`), options.log);
  if (options.exitCode !== undefined) settleJob(cwd, jobId, options.exitCode);
}

function settleJob(cwd, jobId, exitCode = 0) {
  fs.writeFileSync(path.join(cwd, ".pi", "jobs", `${jobId}.exit`), `${exitCode}\n`);
}

function setup(options = {}) {
  const cwd = tmpFixture("pi-run-monitor-ext-");
  fixtureDirs.push(cwd);
  const notifications = [];
  const ctx = {
    cwd,
    hasUI: options.hasUI !== false,
    mode: options.hasUI === false ? "print" : "tui",
    ui: { notify(message, level) { notifications.push({ message, level }); }, setStatus() {} },
    sessionManager: { getSessionId: () => SESSION_ID },
  };
  return { cwd, ctx, notifications };
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

(async () => {
  const aiRoot = runtimePackage("pi-ai", "ai");
  const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
  const createJiti = jitiModule.createJiti || jitiModule;
  const extensionFile = path.resolve("extensions/run-monitor/index.ts");
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
  const factory = mod.default || mod;

  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const sent = [];
  factory({
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    sendUserMessage(content, options) { sent.push({ content, options }); },
  });
  const tool = (ctx, params) => tools.get("run_monitor").execute("call", params, undefined, undefined, ctx);
  const command = (ctx, name, args) => commands.get(name).handler(args, ctx);
  const restore = (ctx) => handlers.get("session_start")({ reason: "reload" }, ctx);
  const shutdown = (ctx) => handlers.get("session_shutdown")({ reason: "quit" }, ctx);

  // A background timer observes settlement, runs the script checker, and shows
  // the fresh probe. No user message or model turn is sent.
  {
    const { cwd, ctx, notifications } = setup();
    writeJob(cwd, "job-timer");
    const started = await tool(ctx, { operation: "start", kind: "bg_run", targetId: "job-timer", intervalMs: 1_000 });
    assert.equal(started.details.status, "active");
    assert.equal(sent.length, 0, "an active monitor stays quiet");
    settleJob(cwd, "job-timer", 0);
    await waitFor(
      () => notifications.some((item) => item.message.includes(`${started.details.monitorId} [settled]`)),
      "the settlement script check",
    );
    assert.equal(sent.length, 0, "the timer edge never sends a user message");
    const edge = notifications.find((item) => item.message.includes(`${started.details.monitorId} [settled]`));
    assert.equal(edge.level, "info");
    assert.match(edge.message, /script-check=exited \(exit 0\)/);
    assert.equal(readMonitor(cwd, started.details.monitorId).scriptCheck.exitCode, 0);
    assert.equal(readMonitor(cwd, started.details.monitorId).wake, undefined, "no wake claim is recorded");

    await command(ctx, "monitor-check", started.details.monitorId);
    await restore(ctx);
    await tool(ctx, { operation: "check", monitorId: started.details.monitorId });
    assert.equal(sent.length, 0, "later checks and session restore never send");
    await shutdown(ctx);
  }

  // Session restore polls every active monitor; each terminal monitor gets its
  // own script probe, and no monitor sends a user message.
  {
    const { cwd, ctx, notifications } = setup();
    writeJob(cwd, "job-shared");
    const first = await tool(ctx, { operation: "start", kind: "bg_run", targetId: "job-shared" });
    const second = await tool(ctx, { operation: "start", kind: "bg_run", targetId: "job-shared" });
    settleJob(cwd, "job-shared", 3);
    await restore(ctx);
    await waitFor(
      () => notifications.some((item) => item.message.includes(`${first.details.monitorId} [settled]`))
        && notifications.some((item) => item.message.includes(`${second.details.monitorId} [settled]`)),
      "both settlement script checks",
    );
    assert.equal(sent.length, 0);
    const monitors = listMonitors(cwd, { ownerSessionId: SESSION_ID });
    assert.equal(monitors.length, 2);
    for (const monitor of monitors) {
      assert.equal(monitor.scriptCheck.exitCode, 3);
      assert.equal(monitor.wake, undefined);
    }
    await shutdown(ctx);
  }

  // Tool results carry the script probe directly; immediate terminal starts are
  // checked before the tool returns.
  {
    const { cwd, ctx } = setup();
    writeJob(cwd, "job-tool-check");
    const started = await tool(ctx, { operation: "start", kind: "bg_run", targetId: "job-tool-check" });
    settleJob(cwd, "job-tool-check", 0);
    const checked = await tool(ctx, { operation: "check", monitorId: started.details.monitorId });
    assert.equal(checked.details.status, "settled");
    assert.match(checked.content[0].text, /script-check=exited \(exit 0\)/);
    writeJob(cwd, "job-tool-done", { exitCode: 0 });
    const immediate = await tool(ctx, { operation: "start", kind: "bg_run", targetId: "job-tool-done" });
    assert.equal(immediate.details.status, "settled");
    assert.match(immediate.content[0].text, /script-check=exited \(exit 0\)/);
    assert.equal(sent.length, 0, "run_monitor tool results never send");
    await shutdown(ctx);
  }

  // Slash commands report to the user and run the same script check.
  {
    const { cwd, ctx, notifications } = setup();
    writeJob(cwd, "job-command-done", { exitCode: 0 });
    await command(ctx, "monitor-start", "bg_run job-command-done");
    assert(notifications.some((item) => /\[settled\] bg_run:job-command-done.*script-check=exited \(exit 0\)/.test(item.message)));
    assert.equal(sent.length, 0);

    writeJob(cwd, "job-pattern", { log: "warming up\n" });
    const started = await tool(ctx, { operation: "start", kind: "bg_run", targetId: "job-pattern", pattern: "READY" });
    fs.appendFileSync(path.join(cwd, ".pi", "jobs", "job-pattern.log"), "READY\n");
    await command(ctx, "monitor-check", started.details.monitorId);
    assert(notifications.some((item) => /\[matched\] bg_run:job-pattern.*script-check=running/.test(item.message)));
    assert.equal(sent.length, 0, "a command-observed milestone never sends a user message");
    await shutdown(ctx);
  }

  // Headless runs print the script-backed edge and never send a user message.
  {
    const { cwd, ctx } = setup({ hasUI: false });
    writeJob(cwd, "job-headless");
    const started = await tool(ctx, { operation: "start", kind: "bg_run", targetId: "job-headless" });
    settleJob(cwd, "job-headless", 0);
    const log = console.log;
    const printed = [];
    console.log = (message) => printed.push(String(message));
    try { await restore(ctx); } finally { console.log = log; }
    assert.equal(sent.length, 0);
    assert(printed.some((line) => line.includes(`${started.details.monitorId} [settled]`) && line.includes("script-check=exited")), "headless notification falls back to stdout");
    assert.equal(readMonitor(cwd, started.details.monitorId).scriptCheck.exitCode, 0);
    await shutdown(ctx);
  }

  // Overlapping checks for one monitor share a single script run instead of
  // starting concurrent probes.
  {
    const { cwd, ctx } = setup();
    writeJob(cwd, "job-overlap");
    const started = await tool(ctx, { operation: "start", kind: "bg_run", targetId: "job-overlap" });
    settleJob(cwd, "job-overlap", 0);
    scriptCalls = 0;
    scriptDelayMs = 200;
    try {
      const [first, second] = await Promise.all([
        tool(ctx, { operation: "check", monitorId: started.details.monitorId }),
        tool(ctx, { operation: "check", monitorId: started.details.monitorId }),
      ]);
      assert.equal(first.details.status, "settled");
      assert.equal(second.details.status, "settled");
      assert.equal(scriptCalls, 1, "overlapping checks share one script run");
      assert.equal(readMonitor(cwd, started.details.monitorId).scriptCheck.exitCode, 0);
    } finally {
      scriptDelayMs = 0;
    }
    await shutdown(ctx);
  }

  // A script failure is reported as a warning; the terminal monitor still
  // notifies and no user message is sent.
  {
    const { cwd, ctx, notifications } = setup();
    writeJob(cwd, "job-script-failure", { exitCode: 0 });
    failScriptChecks = true;
    try {
      await command(ctx, "monitor-start", "bg_run job-script-failure");
      assert(notifications.some((item) => item.message.includes("script check failed")), "a script failure is reported as a warning");
      assert.equal(sent.length, 0);
    } finally {
      failScriptChecks = false;
    }
    await shutdown(ctx);
  }

  // Failures keep their fixtures for inspection; successful runs leave none.
  for (const dir of fixtureDirs) fs.rmSync(dir, { recursive: true, force: true });
  console.log("run-monitor extension script-check checks passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
