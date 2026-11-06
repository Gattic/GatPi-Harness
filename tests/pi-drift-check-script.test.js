import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpFixture } from "./helpers/tmp-fixture.js";

const scriptPath = fileURLToPath(new URL("../scripts/check-pi-drift.sh", import.meta.url));
const forkUrl = "git@github.com:example/pi.git";

const syntax = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function setupLinkedFork() {
  const tmp = tmpFixture("pi-fork-drift-check-");
  const harnessRoot = path.join(tmp, "pi-harness");
  const scriptsDir = path.join(harnessRoot, "scripts");
  const configDir = path.join(harnessRoot, "config");
  const sourceRoot = path.join(tmp, "pi-source");
  const packageRoot = path.join(sourceRoot, "packages", "coding-agent");
  const distDir = path.join(packageRoot, "dist", "bundle");
  const binDir = path.join(tmp, "bin");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(scriptPath, path.join(scriptsDir, "check-pi-drift.sh"));
  fs.chmodSync(path.join(scriptsDir, "check-pi-drift.sh"), 0o755);
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.80.6", bin: { pi: "dist/bundle/cli.js" } }));
  fs.writeFileSync(path.join(distDir, "cli.js"), "#!/usr/bin/env node\nconsole.log('0.80.6');\n");
  fs.chmodSync(path.join(distDir, "cli.js"), 0o755);

  run("git", ["init", "-b", "main"], { cwd: sourceRoot });
  run("git", ["add", "."], { cwd: sourceRoot });
  run("git", ["-c", "user.name=Pi Test", "-c", "user.email=pi@example.invalid", "commit", "-m", "fixture"], {
    cwd: sourceRoot,
  });
  run("git", ["remote", "add", "origin", forkUrl], { cwd: sourceRoot });
  const head = run("git", ["rev-parse", "HEAD"], { cwd: sourceRoot }).stdout.trim();
  run("git", ["update-ref", "refs/remotes/origin/main", head], { cwd: sourceRoot });

  fs.writeFileSync(
    path.join(configDir, "pi-fork.env"),
    [
      `PI_FORK_URL="${forkUrl}"`,
      'PI_FORK_BRANCH="main"',
      `PI_FORK_PATCH_COMMIT="${head}"`,
      'PI_SOURCE_ROOT_DEFAULT="../pi-source"',
      "",
    ].join("\n"),
  );
  fs.symlinkSync(path.join(distDir, "cli.js"), path.join(binDir, "pi"));

  const env = {
    ...process.env,
    PI_SOURCE_ROOT: "",
    PATH: `${binDir}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  };
  const check = (checkoutRoot = harnessRoot) =>
    spawnSync("bash", [path.join(checkoutRoot, "scripts", "check-pi-drift.sh")], {
      encoding: "utf8",
      cwd: checkoutRoot,
      env,
    });
  return { tmp, check, harnessRoot, sourceRoot, binDir };
}

{
  const fixture = setupLinkedFork();
  const clean = fixture.check();
  assert.equal(clean.status, 0, `expected clean fork link:\n${clean.stdout}\n${clean.stderr}`);
  assert.match(clean.stdout, /no drift: active Pi is the clean, current configured fork source build/);
  fs.rmSync(fixture.tmp, { recursive: true, force: true });
}

{
  const fixture = setupLinkedFork();
  run("git", ["init", "-b", "main"], { cwd: fixture.harnessRoot });
  run("git", ["add", "."], { cwd: fixture.harnessRoot });
  run("git", ["-c", "user.name=Pi Test", "-c", "user.email=pi@example.invalid", "commit", "-m", "harness fixture"], { cwd: fixture.harnessRoot });
  const linkedRoot = path.join(fixture.tmp, "nested-worktrees", "pi-harness-child");
  fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
  run("git", ["worktree", "add", "--detach", linkedRoot, "HEAD"], { cwd: fixture.harnessRoot });
  const linked = fixture.check(linkedRoot);
  assert.equal(linked.status, 0, `expected linked-worktree drift check to use the canonical harness root:\n${linked.stdout}\n${linked.stderr}`);
  assert(linked.stdout.includes(`source checkout:   ${fixture.sourceRoot}`), "linked worktrees resolve the default Pi checkout relative to the canonical harness checkout");
  fs.rmSync(fixture.tmp, { recursive: true, force: true });
}

{
  const fixture = setupLinkedFork();
  fs.unlinkSync(path.join(fixture.binDir, "pi"));
  fs.writeFileSync(path.join(fixture.binDir, "pi"), "#!/usr/bin/env bash\necho 0.80.6\n");
  fs.chmodSync(path.join(fixture.binDir, "pi"), 0o755);
  const wrongTarget = fixture.check();
  assert.equal(wrongTarget.status, 1, `expected wrong link drift:\n${wrongTarget.stdout}\n${wrongTarget.stderr}`);
  assert.match(wrongTarget.stderr, /active pi does not resolve/);
  fs.rmSync(fixture.tmp, { recursive: true, force: true });
}

{
  const fixture = setupLinkedFork();
  fs.writeFileSync(path.join(fixture.sourceRoot, "uncommitted.txt"), "drift\n");
  const dirty = fixture.check();
  assert.equal(dirty.status, 1, `expected dirty source drift:\n${dirty.stdout}\n${dirty.stderr}`);
  assert.match(dirty.stderr, /source checkout has uncommitted files/);
  fs.rmSync(fixture.tmp, { recursive: true, force: true });
}

console.log("pi-drift-check-script tests passed");
