#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { mock } = require("node:test");
const { freshness, recordSyncState, toolMutationSnapshot, createCodegraphAdapter, codegraphProjectSnapshot, codegraphAffectedTests } = require("../src/codegraph-adapter.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const sandbox = tmpFixture("pi-codegraph-worktrees-");
const repo = path.join(sandbox, "repo");
const a = path.join(repo, ".worktrees", "task a");
const b = path.join(repo, ".worktrees", "task-b");
const outside = path.join(sandbox, "outside");
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function source(project) { return path.join(project, "src", "foo.js"); }
function state(project) { return fs.readFileSync(path.join(project, ".pi", "codegraph", "state.json"), "utf8"); }
function syncs(project) {
  const file = path.join(project, ".pi", "syncs.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}

(async () => {
  let passed = false;
  try {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(source(repo), "module.exports = 1;\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/\n.codegraph/\n.worktrees/\n");
    fs.mkdirSync(path.join(repo, ".codegraph"));
    fs.writeFileSync(path.join(repo, ".codegraph", "codegraph.db"), "fixture index\n");
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "user.name", "Fixture");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "fixture");
    for (const project of [a, b, outside]) git(repo, "worktree", "add", "--detach", project, "HEAD");
    for (const project of [repo, a, b]) recordSyncState(project, "sync", { command: "fixture baseline", stdout: "ok" });
    const parentState = state(repo);
    const parentHead = git(repo, "rev-parse", "HEAD");

    const fake = path.join(repo, ".pi", "fake-codegraph.js");
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [operation, project] = process.argv.slice(2);
if (operation === 'status') console.log('initialized');
else if (operation === 'sync') {
  if (process.env.GIT_OPTIONAL_LOCKS !== '0') throw new Error('optional Git locks enabled');
  if (fs.existsSync(path.join(project, '.pi', 'fail-sync'))) { console.error('fixture sync failed'); process.exitCode = 1; }
  else {
    fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
    fs.appendFileSync(path.join(project, '.pi', 'syncs.jsonl'), JSON.stringify({ cwd: process.cwd(), project }) + '\\n');
    console.log('synced');
  }
} else if (operation === 'query') console.log(JSON.stringify([{ name: 'foo', filePath: 'src/foo.js', startLine: 1, kind: 'function' }]));
else if (operation === 'affected') console.log(JSON.stringify({ tests: ['tests/foo.test.js'] }));
else if (operation === '--version' || operation === 'version') console.log('fixture-codegraph');
else throw new Error('unexpected operation: ' + operation);
`);
    fs.chmodSync(fake, 0o755);
    process.env.PI_CODEGRAPH = "1";
    process.env.PI_CODEGRAPH_AUTO_SYNC = "1";
    process.env.PI_CODEGRAPH_ALLOW_OUTSIDE = "0";
    process.env.PI_CODEGRAPH_AUTO_SYNC_DEBOUNCE_MS = "100";
    process.env.PI_CODEGRAPH_BIN = fake;

    const piRoot = fs.realpathSync(path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent"));
    const { createJiti } = require(require.resolve("jiti", { paths: [piRoot] }));
    const extensionFile = path.resolve(__dirname, "..", ".pi", "extensions", "codegraph", "index.ts");
    const jiti = createJiti(extensionFile, {
      interopDefault: true,
      alias: { typebox: require.resolve("typebox", { paths: [piRoot] }), "@earendil-works/pi-coding-agent": piRoot },
    });
    const extension = await jiti.import(extensionFile);
    const hooks = new Map();
    const tools = new Map();
    (extension.default || extension)({
      on: (event, handler) => hooks.set(event, handler),
      registerCommand() {}, registerTool: tool => tools.set(tool.name, tool),
    });
    const adapter = createCodegraphAdapter({ bin: fake, timeoutMs: 1000 });
    const timers = new Map();
    let nextTimer = 0;
    mock.method(global, "setTimeout", (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    });
    mock.method(global, "clearTimeout", id => timers.delete(id));
    const ctx = { cwd: repo };
    async function start(id, toolName, input) {
      await hooks.get("tool_call")({ toolCallId: id, toolName, input }, ctx);
    }
    async function finish(id, extra = {}) {
      // Real tool_result events need not repeat the original input.
      await hooks.get("tool_result")({ toolCallId: id, ...extra }, ctx);
    }
    async function mutate(id, toolName, input, action, extra) {
      await start(id, toolName, input);
      action();
      await finish(id, extra);
    }
    async function flushOne() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      assert.equal(timer.delay, 100);
      await timer.callback();
    }
    async function flush() { while (timers.size) await flushOne(); }
    function parentUnchanged() {
      assert.equal(state(repo), parentState, "nested checkout mutations must not write the parent's freshness state");
      assert.equal(freshness(repo).freshness, "fresh");
      assert.deepEqual(syncs(repo), []);
    }

    // Overlapping calls, absolute/relative paths, and out-of-order results.
    await start("a", "edit", { path: path.relative(repo, source(a)) });
    await start("b", "write", { path: source(b) });
    fs.writeFileSync(source(a), "module.exports = 2;\n");
    fs.writeFileSync(source(b), "module.exports = 3;\n");
    await finish("b");
    await finish("a");
    assert.equal(timers.size, 2, "one checkout must not cancel another's pending sync");
    for (const project of [a, b]) {
      assert.equal(freshness(project).freshness, "stale");
      assert.deepEqual(JSON.parse(state(project)).events[0].changedFiles, ["src/foo.js"]);
    }
    parentUnchanged();
    await flushOne();
    assert.equal(freshness(b).freshness, "fresh");
    assert.equal(freshness(a).freshness, "stale", "syncing b must not clear a's stale state");
    await flush();
    assert.equal(freshness(a).freshness, "fresh");
    for (const project of [a, b]) assert.deepEqual(syncs(project), [{ cwd: project, project }]);
    parentUnchanged();

    // Already-dirty content changes must be detected, and coalescing is per checkout.
    for (const value of [4, 5]) await mutate(`repeat-${value}`, "edit", { path: source(a) }, () => fs.writeFileSync(source(a), `module.exports = ${value};\n`));
    assert.equal(timers.size, 1);
    await flush();
    assert.equal(syncs(a).length, 2, "repeated edits to one checkout share one debounce timer");
    assert.equal(syncs(b).length, 1);

    // Observe shell effects rather than attempting to parse cd, git -C, or scripts.
    const bState = state(b);
    await mutate("shell-a", "bash", { command: `git -C ${JSON.stringify(a)} status --short` }, () => {
      git(a, "status", "--short");
    });
    assert.equal(timers.size, 0, "a read-only shell call must not schedule dirty checkouts");
    await mutate("shell-both", "bash", { command: "node .pi/fixture-script.js" }, () => {
      // This command has no modifying-keyword hint: effects are still observable.
      const result = spawnSync(process.execPath, ["-e", "const fs=require('node:fs'); for(const p of process.argv.slice(1)) fs.appendFileSync(p, '// shell edit\\n');", source(a), source(b)], { cwd: repo });
      assert.equal(result.status, 0);
    });
    assert.equal(timers.size, 2, "one shell tool call can affect multiple worktrees");
    assert.notEqual(state(b), bState);
    await flush();
    parentUnchanged();

    const cdCommand = `cd ${JSON.stringify(a)} && printf '// cd edit\\n' >> src/foo.js`;
    await mutate("shell-cd", "bash", { command: cdCommand }, () => {
      assert.equal(spawnSync("bash", ["-c", cdCommand], { cwd: repo }).status, 0);
    });
    assert.equal(timers.size, 1);
    await flush();
    parentUnchanged();

    const untouchedB = state(b);
    await mutate("commit-a", "bash", { command: `git -C ${JSON.stringify(a)} commit -am fixture` }, () => git(a, "commit", "-qam", "worktree-only commit"));
    assert.equal(timers.size, 1);
    assert.equal(freshness(a).freshness, "stale", "a checkout's changed HEAD invalidates only its own graph");
    assert.equal(state(b), untouchedB);
    assert.equal(git(repo, "rev-parse", "HEAD"), parentHead);
    await flush();
    parentUnchanged();

    // Bulk refactors/rollback have project paths rather than individual file inputs.
    await mutate("preview", "ast_refactor", { path: a, mode: "preview" }, () => {});
    assert.equal(timers.size, 0);
    await mutate("apply", "ast_refactor", { path: a, mode: "apply" }, () => fs.appendFileSync(source(a), "// refactor\n"), { details: { summary: { files: 1 } } });
    assert.equal(timers.size, 1);
    await flush();
    await mutate("rollback", "ast_refactor", { operation: "rollback", checkpointId: "fixture" }, () => fs.appendFileSync(source(b), "// rollback\n"), { details: { restored: [{ ok: true }] } });
    assert.equal(timers.size, 1);
    await flush();
    parentUnchanged();

    // Missing/deleted paths still belong to the deepest checkout.
    const added = path.join(a, "src", "new", "new.js");
    await mutate("new-file", "write", { path: added }, () => {
      fs.mkdirSync(path.dirname(added), { recursive: true });
      fs.writeFileSync(added, "new file\n");
    });
    assert.equal(timers.size, 1);
    await flush();
    await mutate("delete-file", "edit", { path: added }, () => fs.unlinkSync(added));
    assert.equal(timers.size, 1);
    await flush();

    // Do not cross confinement through the worktree registry or a symlink.
    const link = path.join(repo, ".pi", "outside-link");
    fs.symlinkSync(outside, link, "dir");
    assert.equal((await toolMutationSnapshot(repo, "write", { path: path.join(link, "src", "foo.js") })).size, 0);
    assert.deepEqual([...(await toolMutationSnapshot(repo, "write", { path: source(outside) }, { allowOutsideCwd: true })).keys()], [outside]);
    await mutate("outside", "bash", { command: "external script" }, () => fs.appendFileSync(source(outside), "// outside\n"));
    assert.equal(timers.size, 0);
    assert.equal(fs.existsSync(path.join(outside, ".pi", "codegraph")), false);

    // Git subdirectory sessions share the checkout's state and debounce timer,
    // even when only the containing parent checkout has an initialized index.
    const siblingState = state(b);
    const aSyncCount = syncs(a).length;
    ctx.cwd = a;
    await mutate("root-session", "edit", { path: "src/foo.js" }, () => fs.appendFileSync(source(a), "// root session\n"));
    ctx.cwd = path.join(a, "src");
    assert.deepEqual([...(await toolMutationSnapshot(ctx.cwd, "bash", { command: "git status" })).keys()], [a]);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      assert.deepEqual([...(await toolMutationSnapshot(ctx.cwd, "bash", { command: "custom-script" })).keys()], [a], "a .git boundary must prevent borrowing an ancestor's index when Git is unavailable");
    } finally { process.env.PATH = originalPath; }
    await mutate("subdir-session", "edit", { path: "foo.js" }, () => fs.appendFileSync(source(a), "// subdir session\n"));
    assert.equal(timers.size, 1, "root and subdirectory sessions must share one checkout timer");
    assert.equal(freshness(a).freshness, "stale");
    await flush();
    assert.equal(freshness(a).freshness, "fresh");
    assert.equal(syncs(a).length, aSyncCount + 1);
    assert.deepEqual(syncs(a).at(-1), { cwd: a, project: a });
    assert.equal(fs.existsSync(path.join(a, "src", ".pi")), false, "do not create subdirectory freshness records");
    assert.deepEqual(JSON.parse(state(a)).events[0].changedFiles, ["src/foo.js"]);
    assert.equal(state(b), siblingState);
    for (const name of ["codegraph_status", "codegraph_query"]) {
      const result = await tools.get(name).execute("read-after-sync", { search: "foo" }, undefined, undefined, ctx);
      assert.equal(result.details.projectPath, a);
      assert.equal(result.details.freshness, "fresh", `${name} must read the same state written by auto-sync`);
      assert.equal(result.details.degradation, null);
      assert.equal(result.details.gatingSafe, true);
    }
    const structured = await adapter.queryStructured(ctx, { search: "foo" });
    assert.equal(structured.projectPath, a);
    assert.equal(structured.freshness.freshness, "fresh");
    assert.equal(structured.degradation, null);
    assert.equal(freshness(ctx.cwd).freshness, "fresh");
    assert.equal(codegraphProjectSnapshot(ctx.cwd, { bin: fake }).projectPath, a);
    assert.equal((await adapter.doctor(ctx)).details.freshness.freshness, "fresh");
    const affected = await adapter.affected(ctx, { files: ["foo.js"] });
    assert.equal(affected.details.args.at(-1), "src/foo.js", "file arguments remain relative to the requested directory");
    const advisory = codegraphAffectedTests(ctx.cwd, ["foo.js"], { bin: fake, advisory: true });
    assert.equal(advisory.run.args.at(-1), "src/foo.js");
    ctx.cwd = repo;
    parentUnchanged();

    // Non-Git projects still observe real edits and bulk-tool effects. A sync
    // cannot establish Git freshness when no Git revision exists.
    const plain = path.join(sandbox, "plain-project");
    fs.mkdirSync(path.join(plain, "src"), { recursive: true });
    fs.mkdirSync(path.join(plain, ".codegraph"));
    fs.writeFileSync(path.join(plain, ".codegraph", "codegraph.db"), "fixture index\n");
    fs.writeFileSync(source(plain), "module.exports = 1;\n");
    ctx.cwd = plain;
    await mutate("plain-write", "write", { path: "src/foo.js" }, () => fs.writeFileSync(source(plain), "module.exports = 2;\n"));
    assert.equal(timers.size, 1, "Git availability must not gate file mutation tracking");
    assert.equal(freshness(plain).stale, true);
    await flush();
    assert.equal(freshness(plain).stale, false);
    assert.equal(freshness(plain).freshness, "unknown");
    assert.equal(freshness(plain).gatingSafe, false);
    assert.deepEqual(syncs(plain), [{ cwd: plain, project: plain }]);
    await mutate("plain-noop", "edit", { path: "src/foo.js" }, () => {});
    assert.equal(timers.size, 0);
    await mutate("plain-shell", "bash", { command: "custom-script" }, () => fs.appendFileSync(source(plain), "// shell\n"));
    assert.equal(timers.size, 1);
    await flush();
    await mutate("plain-readonly", "bash", { command: "read-only script" }, () => {});
    assert.equal(timers.size, 0);
    const unreadable = path.join(plain, "unreadable");
    fs.mkdirSync(unreadable);
    fs.chmodSync(unreadable, 0);
    try {
      await mutate("plain-unreadable", "bash", { command: "read-only script" }, () => {});
      assert.equal(timers.size, 0, "advisory observation must not block read-only tools on unreadable directories");
    } finally { fs.chmodSync(unreadable, 0o700); }
    await mutate("plain-runtime", "bash", { command: "write runtime state" }, () => fs.writeFileSync(path.join(plain, ".pi", "runtime.json"), "{}\n"));
    assert.equal(timers.size, 0, "runtime state is not source mutation evidence");
    fs.symlinkSync(b, path.join(plain, "external"), "dir");
    await mutate("plain-symlink", "bash", { command: "read-only script" }, () => {});
    assert.equal(timers.size, 0, "snapshot traversal must not follow symlink directories");
    await mutate("plain-refactor", "ast_refactor", { path: plain, mode: "apply" }, () => fs.appendFileSync(source(plain), "// refactor\n"), { details: { summary: { files: 1 } } });
    assert.equal(timers.size, 1);
    await flush();
    ctx.cwd = path.join(plain, "src");
    await mutate("plain-subdir", "edit", { path: "foo.js" }, () => fs.appendFileSync(source(plain), "// subdirectory\n"));
    assert.equal(timers.size, 1);
    await flush();
    assert.deepEqual(syncs(plain).at(-1), { cwd: plain, project: plain });
    assert.equal(fs.existsSync(path.join(plain, "src", ".pi")), false);
    assert.equal(state(b), siblingState);
    ctx.cwd = repo;
    parentUnchanged();

    // An initialized project nested in a Git checkout owns its index even
    // without a repository-root index. Already-dirty edits need real hashes.
    const monorepo = path.join(sandbox, "monorepo");
    const app = path.join(monorepo, "packages", "app");
    fs.mkdirSync(path.join(app, "src"), { recursive: true });
    fs.mkdirSync(path.join(app, ".codegraph"));
    fs.mkdirSync(path.join(monorepo, "packages", "other"));
    fs.writeFileSync(path.join(app, ".codegraph", "codegraph.db"), "fixture index\n");
    fs.writeFileSync(source(app), "module.exports = 1;\n");
    fs.writeFileSync(path.join(monorepo, "packages", "other", "other.js"), "module.exports = 1;\n");
    fs.writeFileSync(path.join(monorepo, ".gitignore"), ".pi/\n.codegraph/\n");
    git(monorepo, "init", "-q");
    git(monorepo, "config", "user.email", "fixture@example.invalid");
    git(monorepo, "config", "user.name", "Fixture");
    git(monorepo, "add", ".");
    git(monorepo, "commit", "-qm", "nested-index fixture");
    recordSyncState(app, "sync", { command: "fixture nested baseline" });
    ctx.cwd = path.join(app, "src");
    for (const value of [2, 3]) {
      await mutate(`nested-${value}`, "edit", { path: "foo.js" }, () => fs.writeFileSync(source(app), `module.exports = ${value};\n`));
      assert.equal(timers.size, 1);
      await flush();
      assert.deepEqual(syncs(app).at(-1), { cwd: app, project: app });
      const status = await adapter.status(ctx);
      assert.equal(status.details.projectPath, app);
      assert.equal(status.details.freshness, "fresh");
      assert.deepEqual(status.details.pendingChanges.paths, ["src/foo.js"]);
    }
    assert.equal(syncs(app).length, 2, "an already-dirty nested file must still trigger another sync");
    fs.appendFileSync(path.join(monorepo, "packages", "other", "other.js"), "// unrelated dirty sibling\n");
    assert.equal(freshness(app).freshness, "fresh", "nested project revisions exclude siblings");
    assert.equal((await adapter.queryStructured(ctx, { search: "foo" })).degradation, null);
    ctx.cwd = monorepo;
    await mutate("parent-session-nested-write", "write", { path: "packages/app/src/foo.js" }, () => fs.appendFileSync(source(app), "// parent-session write\n"));
    assert.equal(timers.size, 1);
    await flush();
    assert.deepEqual(syncs(app).at(-1), { cwd: app, project: app });
    assert.equal(fs.existsSync(path.join(monorepo, ".pi")), false, "do not redirect nested-index state to an uninitialized parent");
    assert.equal(fs.existsSync(path.join(app, "src", ".pi")), false);
    ctx.cwd = repo;
    parentUnchanged();

    // An errored tool may have written data; an errored no-op has not.
    await mutate("failed-noop", "edit", { path: source(b) }, () => {}, { isError: true });
    assert.equal(timers.size, 0);
    await mutate("partial-error", "bash", { command: "fixture-script" }, () => fs.appendFileSync(source(b), "// partial write\n"), { isError: true });
    assert.equal(timers.size, 1);
    fs.writeFileSync(path.join(b, ".pi", "fail-sync"), "fail\n");
    await flush();
    assert.equal(freshness(b).freshness, "stale");
    assert.equal(freshness(b).lastError.source, "auto-sync");
    assert.equal(freshness(a).freshness, "fresh");
    parentUnchanged();

    const failedB = state(b);
    await mutate("main-write", "write", { path: "src/foo.js" }, () => fs.appendFileSync(source(repo), "// main edit\n"));
    assert.equal(timers.size, 1);
    assert.equal(freshness(repo).freshness, "stale");
    assert.equal(freshness(a).freshness, "fresh");
    await flush();
    assert.equal(freshness(repo).freshness, "fresh");
    assert.deepEqual(syncs(repo), [{ cwd: repo, project: repo }]);
    assert.equal(state(b), failedB);

    await mutate("shutdown", "write", { path: source(a) }, () => fs.appendFileSync(source(a), "// pending shutdown\n"));
    assert.equal(timers.size, 1);
    hooks.get("session_shutdown")({}, ctx);
    assert.equal(timers.size, 0, "shutdown cancels all pending checkout timers");
    assert.equal(freshness(a).freshness, "stale");
    assert.equal(freshness(repo).freshness, "fresh");
    assert.equal(state(b), failedB);
    passed = true;
    console.log("codegraph worktree auto-sync checks passed");
  } finally {
    mock.restoreAll();
    if (passed) fs.rmSync(sandbox, { recursive: true, force: true });
    else console.error(`Preserved failing worktree fixture: ${sandbox}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
