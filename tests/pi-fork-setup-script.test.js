import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpFixture } from "./helpers/tmp-fixture.js";

const setupScript = fileURLToPath(new URL("../scripts/setup-pi-fork.sh", import.meta.url));
const driftScript = fileURLToPath(new URL("../scripts/check-pi-drift.sh", import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

const syntax = spawnSync("bash", ["-n", setupScript], { encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);
const help = spawnSync("bash", [setupScript, "--help"], { encoding: "utf8" });
assert.equal(help.status, 0, help.stderr || help.stdout);
assert.match(help.stdout, /--check/);
assert.match(help.stdout, /--skip-deps/);

const tmp = tmpFixture("pi-fork-setup-");
try {
  const sourceSeed = path.join(tmp, "source-seed");
  const sourceRemote = path.join(tmp, "pi.git");
  const harnessRoot = path.join(tmp, "pi-harness");
  const harnessRemote = path.join(tmp, "pi-standard.git");
  const sourceRoot = path.join(tmp, "pi");
  const fakeBin = path.join(tmp, "bin");
  const fakeNpmPrefix = path.join(tmp, "npm-prefix");
  const fakeNpmLog = path.join(tmp, "npm.log");
  fs.mkdirSync(path.join(sourceSeed, "packages", "coding-agent"), { recursive: true });
  for (const packageName of ["tui", "ai", "agent"]) {
    fs.mkdirSync(path.join(sourceSeed, "packages", packageName), { recursive: true });
  }
  fs.writeFileSync(path.join(sourceSeed, ".gitignore"), "node_modules/\ndist/\n");
  fs.writeFileSync(path.join(sourceSeed, "package.json"), JSON.stringify({ private: true }));
  fs.writeFileSync(path.join(sourceSeed, "packages", "coding-agent", "package.json"), JSON.stringify({ version: "0.80.6", bin: { pi: "dist/bundle/cli.js" } }));
  run("git", ["init", "-b", "main"], { cwd: sourceSeed });
  run("git", ["add", "."], { cwd: sourceSeed });
  run("git", ["-c", "user.name=Pi Test", "-c", "user.email=pi@example.invalid", "commit", "-m", "fixture"], {
    cwd: sourceSeed,
  });
  const patchCommit = run("git", ["rev-parse", "HEAD"], { cwd: sourceSeed }).stdout.trim();
  run("git", ["clone", "--bare", sourceSeed, sourceRemote]);

  fs.mkdirSync(path.join(harnessRoot, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(harnessRoot, "config"), { recursive: true });
  fs.copyFileSync(setupScript, path.join(harnessRoot, "scripts", "setup-pi-fork.sh"));
  fs.copyFileSync(driftScript, path.join(harnessRoot, "scripts", "check-pi-drift.sh"));
  fs.chmodSync(path.join(harnessRoot, "scripts", "setup-pi-fork.sh"), 0o755);
  fs.chmodSync(path.join(harnessRoot, "scripts", "check-pi-drift.sh"), 0o755);
  fs.writeFileSync(
    path.join(harnessRoot, "config", "pi-fork.env"),
    [
      `PI_HARNESS_URL="${harnessRemote}"`,
      'PI_HARNESS_BRANCH="main"',
      `PI_FORK_URL="${sourceRemote}"`,
      'PI_FORK_BRANCH="main"',
      `PI_FORK_PATCH_COMMIT="${patchCommit}"`,
      `PI_UPSTREAM_URL="${sourceRemote}-upstream"`,
      'PI_SOURCE_ROOT_DEFAULT="../pi"',
      'PI_MIN_NODE_VERSION="22.19.0"',
      "",
    ].join("\n"),
  );
  run("git", ["init", "-b", "main"], { cwd: harnessRoot });
  run("git", ["add", "."], { cwd: harnessRoot });
  run("git", ["-c", "user.name=Pi Test", "-c", "user.email=pi@example.invalid", "commit", "-m", "fixture"], {
    cwd: harnessRoot,
  });
  run("git", ["clone", "--bare", harnessRoot, harnessRemote]);
  run("git", ["remote", "add", "origin", harnessRemote], { cwd: harnessRoot });
  run("git", ["fetch", "origin", "main"], { cwd: harnessRoot });

  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(fakeNpmPrefix, { recursive: true });
  const fakeNpm = path.join(fakeBin, "npm");
  fs.writeFileSync(
    fakeNpm,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
if [[ "\${1:-}" == "--version" ]]; then echo 10.9.7; exit 0; fi
if [[ "\${1:-}" == "prefix" && "\${2:-}" == "-g" ]]; then echo "$FAKE_NPM_PREFIX"; exit 0; fi
if [[ "\${1:-}" == "ci" ]]; then
  mkdir -p node_modules/.bin
  for tool in tsc shx; do
    printf '#!/usr/bin/env bash\\nexit 0\\n' > "node_modules/.bin/$tool"
    chmod +x "node_modules/.bin/$tool"
  done
  exit 0
fi
if [[ "\${1:-}" == "--prefix" && "\${3:-}" == "run" && "\${4:-}" == "hydrate:model-data" ]]; then
  if [[ "\${FAKE_NPM_FAIL_HYDRATE:-0}" == "1" ]]; then
    echo "simulated model-data hydration failure" >&2
    exit 42
  fi
  exit 0
fi
if [[ "\${1:-}" == "--prefix" && "\${2:-}" == "$FAKE_SOURCE_ROOT" && "\${3:-}" == "run" && "\${4:-}" == "build:offline" ]]; then
  coding_agent_root="$FAKE_SOURCE_ROOT/packages/coding-agent"
  mkdir -p "$coding_agent_root/dist/bundle"
  printf '#!/usr/bin/env node\\nconsole.log("0.80.6");\\n' > "$coding_agent_root/dist/bundle/cli.js"
  chmod +x "$coding_agent_root/dist/bundle/cli.js"
  exit 0
fi
if [[ "\${1:-}" == "link" ]]; then
  ln -sfn "$PWD/dist/bundle/cli.js" "$FAKE_PI_BIN"
  exit 0
fi
echo "unexpected fake npm invocation: $*" >&2
exit 2
`,
  );
  fs.chmodSync(fakeNpm, 0o755);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    FAKE_NPM_PREFIX: fakeNpmPrefix,
    FAKE_NPM_LOG: fakeNpmLog,
    FAKE_PI_BIN: path.join(fakeBin, "pi"),
    FAKE_SOURCE_ROOT: sourceRoot,
    PI_SOURCE_ROOT: "",
    PI_SETUP_CONFIG_FILE: "",
  };
  const script = path.join(harnessRoot, "scripts", "setup-pi-fork.sh");
  const nodeWithoutZstdBin = path.join(tmp, "node-without-zstd", "bin");
  const nodeWithoutZstd = path.join(nodeWithoutZstdBin, "node");
  fs.mkdirSync(nodeWithoutZstdBin, { recursive: true });
  fs.writeFileSync(
    nodeWithoutZstd,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  echo "v23.7.0"
  exit 0
fi
if [[ "\${1:-}" == "-e" && "\${2:-}" == *"process.versions.node"* ]]; then
  exit 0
fi
exit 1
`,
  );
  fs.chmodSync(nodeWithoutZstd, 0o755);
  const zstdPreflight = spawnSync("bash", [script, "--check"], {
    cwd: harnessRoot,
    env: { ...env, PATH: `${nodeWithoutZstdBin}:${env.PATH}` },
    encoding: "utf8",
  });
  assert.equal(zstdPreflight.status, 1);
  assert.match(zstdPreflight.stderr, /Node v23\.7\.0 lacks zlib\.createZstdDecompress required by Pi/);

  const hydrationFailure = spawnSync("bash", [script], {
    cwd: harnessRoot,
    env: { ...env, FAKE_NPM_FAIL_HYDRATE: "1" },
    encoding: "utf8",
  });
  assert.equal(
    hydrationFailure.status,
    42,
    `model-data hydration failure should stop setup:\n${hydrationFailure.stdout}\n${hydrationFailure.stderr}`,
  );
  assert.match(hydrationFailure.stderr, /simulated model-data hydration failure/);
  const failedCalls = fs.readFileSync(fakeNpmLog, "utf8");
  assert.match(failedCalls, /run hydrate:model-data/);
  assert.doesNotMatch(failedCalls, /run build:offline/);

  fs.writeFileSync(fakeNpmLog, "");
  const apply = spawnSync("bash", [script], { cwd: harnessRoot, env, encoding: "utf8" });
  assert.equal(apply.status, 0, `setup should succeed:\n${apply.stdout}\n${apply.stderr}`);
  assert.match(apply.stdout, /Hydrating generated Pi model data/);
  assert.match(apply.stdout, /Pi fork setup complete/);
  const successfulCalls = fs.readFileSync(fakeNpmLog, "utf8").trim().split("\n");
  const hydrateCall = `--prefix ${sourceRoot} run hydrate:model-data`;
  const buildCall = `--prefix ${sourceRoot} run build:offline`;
  assert.ok(successfulCalls.includes(hydrateCall), `missing npm call: ${hydrateCall}`);
  assert.ok(successfulCalls.includes(buildCall), `missing npm call: ${buildCall}`);
  assert.ok(successfulCalls.indexOf(hydrateCall) < successfulCalls.indexOf(buildCall), "model data must precede build");
  assert.doesNotMatch(successfulCalls.join("\n"), /packages\/orchestrator/);
  assert.equal(fs.realpathSync(path.join(fakeBin, "pi")), path.join(sourceRoot, "packages", "coding-agent", "dist", "bundle", "cli.js"));
  assert.equal(run("git", ["remote", "get-url", "origin"], { cwd: sourceRoot }).stdout.trim(), sourceRemote);
  assert.equal(run("git", ["remote", "get-url", "upstream"], { cwd: sourceRoot }).stdout.trim(), `${sourceRemote}-upstream`);

  run("git", ["remote", "add", "origin", sourceRemote], { cwd: sourceSeed });
  fs.writeFileSync(path.join(sourceSeed, "fork-update.txt"), "updated\n");
  run("git", ["add", "fork-update.txt"], { cwd: sourceSeed });
  run("git", ["-c", "user.name=Pi Test", "-c", "user.email=pi@example.invalid", "commit", "-m", "fork update"], {
    cwd: sourceSeed,
  });
  run("git", ["push", "origin", "main"], { cwd: sourceSeed });

  const harnessUpdater = path.join(tmp, "harness-updater");
  run("git", ["clone", harnessRemote, harnessUpdater]);
  fs.writeFileSync(path.join(harnessUpdater, "harness-update.txt"), "updated\n");
  run("git", ["add", "harness-update.txt"], { cwd: harnessUpdater });
  run("git", ["-c", "user.name=Pi Test", "-c", "user.email=pi@example.invalid", "commit", "-m", "harness update"], {
    cwd: harnessUpdater,
  });
  run("git", ["push", "origin", "main"], { cwd: harnessUpdater });

  const update = spawnSync("bash", [script, "--skip-deps"], { cwd: harnessRoot, env, encoding: "utf8" });
  assert.equal(update.status, 0, `update should succeed:\n${update.stdout}\n${update.stderr}`);
  assert.match(update.stdout, /Fast-forwarding pi-harness/);
  assert.match(update.stdout, /Restarting the updated setup script/);
  assert.match(update.stdout, /Fast-forwarding Pi fork/);
  assert.equal(fs.existsSync(path.join(harnessRoot, "harness-update.txt")), true);
  assert.equal(fs.existsSync(path.join(sourceRoot, "fork-update.txt")), true);

  const skipDepsTool = path.join(sourceRoot, "node_modules", ".bin", "tsc");
  const skipDepsToolBody = fs.readFileSync(skipDepsTool);
  fs.rmSync(skipDepsTool);
  const missingDeps = spawnSync("bash", [script, "--skip-deps"], { cwd: harnessRoot, env, encoding: "utf8" });
  assert.equal(missingDeps.status, 1, `missing dependencies should be rejected:\n${missingDeps.stdout}\n${missingDeps.stderr}`);
  assert.match(missingDeps.stderr, /--skip-deps requested but Pi dependencies are missing: node_modules\/\.bin\/tsc/);
  fs.writeFileSync(skipDepsTool, skipDepsToolBody);
  fs.chmodSync(skipDepsTool, 0o755);

  const check = spawnSync("bash", [script, "--check"], { cwd: harnessRoot, env, encoding: "utf8" });
  assert.equal(check.status, 0, `check should succeed:\n${check.stdout}\n${check.stderr}`);
  assert.match(check.stdout, /Pi fork setup check passed/);

  fs.writeFileSync(path.join(sourceRoot, "dirty.txt"), "dirty\n");
  const dirty = spawnSync("bash", [script, "--check"], { cwd: harnessRoot, env, encoding: "utf8" });
  assert.equal(dirty.status, 1, `dirty checkout should be rejected:\n${dirty.stdout}\n${dirty.stderr}`);
  assert.match(dirty.stderr, /Pi fork has uncommitted files/);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("pi-fork-setup-script tests passed");
