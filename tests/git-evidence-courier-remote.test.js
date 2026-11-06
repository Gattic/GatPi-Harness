"use strict";
const { tmpFixture } = require("./helpers/tmp-fixture");

// gitevidence against real git and a real (local, bare) remote. The stubbed
// behavior test cannot see how the report relates its live remote SHA to its
// ahead/behind counts, nor whether a report is point-in-time rather than cached.

const assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { before, test } = require("node:test");

process.env.PI_EXTENSION_TELEMETRY = "0";
// Never let a developer's git configuration (signing, hooks, default branch) shape the fixture.
process.env.GIT_CONFIG_GLOBAL = os.devNull;
process.env.GIT_CONFIG_NOSYSTEM = "1";
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" });

let gitevidence;
before(async () => {
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const piRoot = fs.realpathSync(path.join(globalRoot, "@earendil-works", "pi-coding-agent"));
  const { createJiti } = require(require.resolve("jiti", { paths: [piRoot] }));
  const file = path.resolve(__dirname, "../extensions/git-evidence-courier/index.ts");
  const jiti = createJiti(file, { interopDefault: true, alias: { typebox: require.resolve("typebox", { paths: [piRoot] }) } });
  const mod = await jiti.import(file);
  const tools = new Map();
  (mod.default || mod)({
    on() {},
    registerCommand() {},
    sendMessage() {},
    registerTool(definition) { tools.set(definition.name, definition); },
    exec: (command, args, options) => new Promise((resolve) => execFile(command, args, { cwd: options.cwd, timeout: options.timeout }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, code: error ? (typeof error.code === "number" ? error.code : 1) : 0, killed: Boolean(error?.killed) });
    })),
  });
  gitevidence = tools.get("gitevidence");
});

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixture(t) {
  const root = tmpFixture("pi-gitevidence-remote-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bare = path.join(root, "remote.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(root, "clone", "-q", bare, work);
  commit(work, "f", "1");
  git(work, "push", "-q", "origin", "HEAD:main");
  git(work, "branch", "-u", "origin/main");
  git(root, "clone", "-q", bare, other);
  return { bare, work, other };
}

function commit(repo, file, content) {
  fs.writeFileSync(path.join(repo, file), `${content}\n`);
  git(repo, "add", file);
  git(repo, "commit", "-qm", `${file}=${content}`);
}

async function evidence(cwd) {
  const result = await gitevidence.execute("call", {}, undefined, undefined, { cwd });
  return { details: result.details, text: result.content.map((item) => item.text).join("\n") };
}

const liveRemote = (cwd) => git(cwd, "ls-remote", "origin", "refs/heads/main").split(/\s+/)[0];

test("each report reflects the remote at the moment it runs, never an earlier snapshot", async (t) => {
  const { work } = fixture(t);

  let report = await evidence(work);
  assert.equal(report.details.remoteSha, liveRemote(work));
  assert.equal(`${report.details.ahead}/${report.details.behind}`, "0/0");

  // A report taken after a commit but before its push (as when a read-only
  // call overlaps a publish) correctly shows the pre-push remote.
  const remoteBeforePush = liveRemote(work);
  commit(work, "f", "2");
  report = await evidence(work);
  assert.equal(report.details.localSha, git(work, "rev-parse", "HEAD"));
  assert.equal(report.details.remoteSha, remoteBeforePush);
  assert.equal(`${report.details.ahead}/${report.details.behind}`, "1/0");

  git(work, "push", "-q", "origin", "HEAD:main");
  report = await evidence(work);
  assert.equal(report.details.remoteSha, report.details.localSha, "the same extension instance sees the push immediately");
  assert.equal(report.details.remoteSha, liveRemote(work));
  assert.equal(`${report.details.ahead}/${report.details.behind}`, "0/0");
});

test("a remote commit this clone has not fetched is never reported as in sync", async (t) => {
  const { work, other } = fixture(t);
  commit(other, "g", "from another actor");
  git(other, "push", "-q", "origin", "HEAD:main");

  let report = await evidence(work);
  assert.equal(report.details.remoteSha, liveRemote(work));
  assert.notEqual(report.details.remoteSha, report.details.localSha);
  assert.equal(report.details.ahead, undefined, "counts against a stale tracking ref would read 0/0 here");
  assert.equal(report.details.behind, undefined);
  assert.match(report.text, /Ahead\/behind:\n\(unavailable: remote commit [0-9a-f]{7} is not in the local repository; run git fetch\)/);

  git(work, "fetch", "-q");
  report = await evidence(work);
  assert.equal(`${report.details.ahead}/${report.details.behind}`, "0/1");
  assert.match(report.text, /Ahead\/behind:\n0 ahead \/ 1 behind\n/);
});

test("a diverged branch is counted against the live remote once its commit is known", async (t) => {
  const { work, other } = fixture(t);
  commit(work, "f", "local only");
  commit(other, "g", "remote only");
  git(other, "push", "-q", "origin", "HEAD:main");
  git(work, "fetch", "-q");

  const report = await evidence(work);
  assert.equal(report.details.remoteSha, liveRemote(work));
  assert.equal(`${report.details.ahead}/${report.details.behind}`, "1/1");
});

test("a detached HEAD has no remote branch to count against", async (t) => {
  const { work } = fixture(t);
  git(work, "checkout", "-q", "-b", "other");
  commit(work, "f", "on another branch");
  git(work, "push", "-q", "origin", "other");
  git(work, "checkout", "-q", "--detach", "main");

  const report = await evidence(work);
  assert.equal(report.details.remoteSha, "unavailable", "an empty branch name must not match every remote head");
  assert.equal(report.details.ahead, undefined);
  assert.equal(report.details.behind, undefined);
});

test("a remote branch that no longer exists is not described as an unreachable remote", async (t) => {
  const { work, other } = fixture(t);
  git(work, "checkout", "-q", "-b", "topic");
  commit(work, "f", "topic work");
  git(work, "push", "-q", "-u", "origin", "topic");
  git(other, "push", "-q", "origin", "--delete", "topic");

  const report = await evidence(work);
  assert.equal(report.details.remoteSha, "unavailable");
  assert.equal(`${report.details.ahead}/${report.details.behind}`, "0/0");
  assert.match(report.text, /Ahead\/behind:\n0 ahead \/ 0 behind \(last-fetched origin\/topic; remote SHA unavailable\)\n/);
  assert.doesNotMatch(report.text, /unreachable/, "ls-remote succeeded; only the branch is gone");
});

test("an unreachable remote falls back to the last-fetched ref and says so", async (t) => {
  const { work } = fixture(t);
  commit(work, "f", "unpushed");
  git(work, "remote", "set-url", "origin", path.join(os.tmpdir(), "pi-gitevidence-no-such-remote.git"));

  const report = await evidence(work);
  assert.equal(report.details.remoteSha, "unavailable");
  assert.equal(`${report.details.ahead}/${report.details.behind}`, "1/0");
  assert.match(report.text, /Ahead\/behind:\n1 ahead \/ 0 behind \(last-fetched origin\/main; remote SHA unavailable\)\n/);
});
