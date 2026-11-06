#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = path.resolve(__dirname, "..");
const sourceScript = path.join(root, "scripts", "pi-harness-refresh.sh");
const bootstrapScript = path.join(root, "scripts", "bootstrap-new-machine.sh");
const tmp = tmpFixture("pi-harness-refresh-");

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, `${commandName} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function makeFixture(name) {
  const fixtureRoot = path.join(tmp, name, "pi-harness");
  const remote = path.join(tmp, name, "pi-harness.git");
  const scriptsDir = path.join(fixtureRoot, "scripts");
  const agentDir = path.join(tmp, name, "agent");
  const claudeSkills = path.join(tmp, name, "claude-skills");
  const agentSkills = path.join(tmp, name, "agent-skills");
  const log = path.join(tmp, name, "helpers.log");

  fs.mkdirSync(path.join(fixtureRoot, ".pi", "extensions", "fixture"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "extensions", "hermes-advisory"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "skills", "skills", "fixture-skill"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "config"), { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "extensions", "hermes-advisory", "index.ts"), "export default function () {}\n");
  fs.writeFileSync(path.join(fixtureRoot, "skills", "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: fixture\n---\n");
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
  fs.copyFileSync(sourceScript, path.join(scriptsDir, "pi-harness-refresh.sh"));
  fs.chmodSync(path.join(scriptsDir, "pi-harness-refresh.sh"), 0o755);

  const helper = `#!/usr/bin/env bash
set -euo pipefail
name="$(basename -- "$0")"
printf '%s' "$name" >> "$PI_REFRESH_TEST_LOG"
if (($#)); then printf ' %s' "$*" >> "$PI_REFRESH_TEST_LOG"; fi
printf '\\n' >> "$PI_REFRESH_TEST_LOG"
if [[ "$name" == "check-pi-drift.sh" ]]; then
  if [[ "\${PI_REFRESH_TEST_DRIFT_STATUS:-0}" != "0" ]]; then
    echo "fixture drift detected" >&2
    exit "$PI_REFRESH_TEST_DRIFT_STATUS"
  fi
fi
if [[ "$name" == "setup-pi-fork.sh" && "\${PI_REFRESH_TEST_ADVANCE_HARNESS:-0}" == "1" ]]; then
  printf 'updated\\n' > refresh-self-update.txt
  git add refresh-self-update.txt
  git -c user.name='Pi Test' -c user.email='pi@example.invalid' commit -m 'fixture harness update' >/dev/null
fi
`;
  for (const helperName of [
    "install-project-extensions.sh",
    "install-agent-skills.sh",
    "setup-pi-fork.sh",
    "check-all.sh",
    "check-pi-drift.sh",
  ]) {
    const helperPath = path.join(scriptsDir, helperName);
    fs.writeFileSync(helperPath, helper);
    fs.chmodSync(helperPath, 0o755);
  }

  fs.writeFileSync(
    path.join(fixtureRoot, "config", "pi-fork.env"),
    [
      `PI_HARNESS_URL="${remote}"`,
      'PI_HARNESS_BRANCH="main"',
      `PI_FORK_URL="${path.join(tmp, name, "pi.git")}"`,
      'PI_FORK_BRANCH="main"',
      'PI_FORK_PATCH_COMMIT="fixture"',
      `PI_UPSTREAM_URL="${path.join(tmp, name, "upstream.git")}"`,
      'PI_SOURCE_ROOT_DEFAULT="../pi"',
      'PI_MIN_NODE_VERSION="22.19.0"',
      "",
    ].join("\n"),
  );

  command("git", ["init", "-b", "main"], { cwd: fixtureRoot });
  command("git", ["add", "."], { cwd: fixtureRoot });
  command("git", ["-c", "user.name=Pi Test", "-c", "user.email=pi@example.invalid", "commit", "-m", "fixture"], { cwd: fixtureRoot });
  command("git", ["clone", "--bare", fixtureRoot, remote]);
  command("git", ["remote", "add", "origin", remote], { cwd: fixtureRoot });
  command("git", ["fetch", "origin", "main"], { cwd: fixtureRoot });

  const env = {
    ...process.env,
    HOME: path.join(tmp, name, "home"),
    PI_CODING_AGENT_DIR: agentDir,
    CLAUDE_SKILLS_DIR: claudeSkills,
    AGENT_SKILLS_DIR: agentSkills,
    PI_REFRESH_TEST_LOG: log,
  };
  return {
    root: fixtureRoot,
    script: path.join(scriptsDir, "pi-harness-refresh.sh"),
    agentDir,
    log,
    env,
    run(args = [], extraEnv = {}) {
      return spawnSync("bash", [path.join(scriptsDir, "pi-harness-refresh.sh"), ...args], {
        cwd: fixtureRoot,
        env: { ...env, ...extraEnv },
        encoding: "utf8",
      });
    },
    lines() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, "utf8").trim().split(/\r?\n/).filter(Boolean);
    },
  };
}

try {
  const syntax = spawnSync("bash", ["-n", sourceScript, bootstrapScript], { cwd: root, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr || "refresh and bootstrap scripts should pass Bash syntax validation");
  const bootstrapSource = fs.readFileSync(bootstrapScript, "utf8");
  assert.match(bootstrapSource, /pi-harness-refresh\.sh --extensions --skills --no-check/, "new-machine bootstrap delegates resource installation to the unified refresh workflow");
  assert.match(bootstrapSource, /pi-harness-refresh\.sh --check-only/, "new-machine bootstrap recommends the unified verification entry point");
  const help = spawnSync("bash", [sourceScript, "--help"], { cwd: root, encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  for (const flag of ["--extensions", "--skills", "--pi", "--all", "--check-only", "--no-check", "--dry-run", "--skip-pi-deps"]) {
    assert.match(help.stdout, new RegExp(flag.replaceAll("-", "\\-")), `help should document ${flag}`);
  }

  const routine = makeFixture("routine");
  const routineResult = routine.run();
  assert.equal(routineResult.status, 0, routineResult.stderr);
  assert.deepEqual(routine.lines(), [
    "check-pi-drift.sh",
    "install-project-extensions.sh",
    "check-all.sh",
    "install-agent-skills.sh",
  ], "default workflow validates Pi first, reconciles extension settings, verifies, then deploys skills");
  assert.match(routineResult.stdout, /Pi harness refresh complete/);

  const extensions = makeFixture("extensions");
  const extensionsResult = extensions.run(["--extensions", "--no-check"]);
  assert.equal(extensionsResult.status, 0, extensionsResult.stderr);
  assert.deepEqual(extensions.lines(), ["install-project-extensions.sh"]);

  const checkOnly = makeFixture("check-only");
  const checkOnlyResult = checkOnly.run(["--check-only"]);
  assert.equal(checkOnlyResult.status, 0, checkOnlyResult.stderr);
  assert.deepEqual(checkOnly.lines(), ["check-pi-drift.sh", "check-all.sh"]);

  const all = makeFixture("all");
  const allResult = all.run(["--all", "--no-check", "--skip-pi-deps"]);
  assert.equal(allResult.status, 0, allResult.stderr);
  assert.deepEqual(all.lines(), [
    "setup-pi-fork.sh --skip-deps",
    "install-project-extensions.sh",
    "install-agent-skills.sh",
  ], "a Node runtime with native TypeScript support reaches the Pi setup helper");

  const incompatibleNode = makeFixture("incompatible-node");
  const incompatibleNodeBin = path.join(tmp, "incompatible-node", "bin");
  const fakeNode = path.join(incompatibleNodeBin, "node");
  fs.mkdirSync(incompatibleNodeBin, { recursive: true });
  fs.writeFileSync(
    fakeNode,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  echo "v23.5.0"
  exit 0
fi
echo "Unknown file extension .ts" >&2
exit 1
`,
  );
  fs.chmodSync(fakeNode, 0o755);
  const incompatibleNodePath = `${incompatibleNodeBin}:${incompatibleNode.env.PATH}`;
  const incompatibleNodeResult = incompatibleNode.run(["--pi", "--no-check"], { PATH: incompatibleNodePath });
  assert.equal(incompatibleNodeResult.status, 1);
  assert.match(incompatibleNodeResult.stderr, /Node v23\.5\.0 cannot execute \.ts scripts directly/);
  assert.match(incompatibleNodeResult.stderr, /Node 22 LTS/);
  assert.match(incompatibleNodeResult.stderr, /nvm install 22\.22\.2 && nvm use 22\.22\.2/);
  assert.match(incompatibleNodeResult.stderr, /without --skip-pi-deps/);
  assert.deepEqual(incompatibleNode.lines(), [], "an incompatible Node runtime is rejected before Pi setup");

  const zstdIncompatibleNode = makeFixture("zstd-incompatible-node");
  const zstdIncompatibleNodeBin = path.join(tmp, "zstd-incompatible-node", "bin");
  const fakeNodeWithoutZstd = path.join(zstdIncompatibleNodeBin, "node");
  fs.mkdirSync(zstdIncompatibleNodeBin, { recursive: true });
  fs.writeFileSync(
    fakeNodeWithoutZstd,
    `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then
  echo "v23.7.0"
  exit 0
fi
if [[ "\${1:-}" == *.ts ]]; then
  exit 0
fi
exit 1
`,
  );
  fs.chmodSync(fakeNodeWithoutZstd, 0o755);
  const zstdIncompatibleNodePath = `${zstdIncompatibleNodeBin}:${zstdIncompatibleNode.env.PATH}`;
  const zstdIncompatibleNodeResult = zstdIncompatibleNode.run(["--pi", "--no-check"], { PATH: zstdIncompatibleNodePath });
  assert.equal(zstdIncompatibleNodeResult.status, 1);
  assert.match(zstdIncompatibleNodeResult.stderr, /Node v23\.7\.0 lacks zlib\.createZstdDecompress required by Pi/);
  assert.match(zstdIncompatibleNodeResult.stderr, /nvm install 22\.22\.2 && nvm use 22\.22\.2/);
  assert.deepEqual(zstdIncompatibleNode.lines(), [], "a Node runtime without zstd support is rejected before Pi setup");

  const nonPiResult = incompatibleNode.run(["--skills", "--no-check"], { PATH: incompatibleNodePath });
  assert.equal(nonPiResult.status, 0, nonPiResult.stderr);
  assert.deepEqual(incompatibleNode.lines(), ["install-agent-skills.sh"], "non-Pi refreshes do not require TypeScript execution");

  const selfUpdate = makeFixture("self-update");
  const selfUpdateResult = selfUpdate.run(["--all", "--no-check"], { PI_REFRESH_TEST_ADVANCE_HARNESS: "1" });
  assert.equal(selfUpdateResult.status, 0, selfUpdateResult.stderr);
  assert.deepEqual(selfUpdate.lines(), [
    "setup-pi-fork.sh",
    "install-project-extensions.sh",
    "install-agent-skills.sh",
  ], "a harness fast-forward restarts the wrapper without running Pi setup twice");
  assert.match(selfUpdateResult.stdout, /restarting the updated refresh script/i);
  assert.match(selfUpdateResult.stdout, /resumed from updated harness HEAD/);

  const dirty = makeFixture("dirty");
  fs.writeFileSync(path.join(dirty.root, "dirty.txt"), "dirty\n");
  const dirtyResult = dirty.run(["--pi", "--no-check"]);
  assert.equal(dirtyResult.status, 1);
  assert.match(dirtyResult.stderr, /--pi requires a clean pi-harness worktree/);
  assert.deepEqual(dirty.lines(), [], "dirty Pi refresh is rejected before invoking helpers");

  const drift = makeFixture("drift");
  const driftResult = drift.run(["--extensions"], { PI_REFRESH_TEST_DRIFT_STATUS: "1" });
  assert.equal(driftResult.status, 1);
  assert.match(driftResult.stderr, /rerun with --pi to reconcile it/);
  assert.deepEqual(drift.lines(), ["check-pi-drift.sh"], "drift is detected before mutating extension settings");

  const invalidSettings = makeFixture("invalid-settings");
  fs.writeFileSync(path.join(invalidSettings.agentDir, "settings.json"), "{ invalid\n");
  const invalidSettingsResult = invalidSettings.run(["--extensions", "--no-check"]);
  assert.equal(invalidSettingsResult.status, 1);
  assert.match(invalidSettingsResult.stderr, /settings file is not valid JSON/);
  assert.deepEqual(invalidSettings.lines(), [], "invalid settings are rejected before the lower-level installer can replace them");

  const missingSkills = makeFixture("missing-skills");
  fs.rmSync(path.join(missingSkills.root, "skills", "skills", "fixture-skill"), { recursive: true, force: true });
  const missingSkillsResult = missingSkills.run(["--skills", "--no-check"]);
  assert.equal(missingSkillsResult.status, 1);
  assert.match(missingSkillsResult.stderr, /no immediate skill directories containing SKILL.md/);
  assert.deepEqual(missingSkills.lines(), []);

  const dryRun = makeFixture("dry-run");
  const dryRunResult = dryRun.run(["--extensions", "--skills", "--no-check", "--dry-run"]);
  assert.equal(dryRunResult.status, 0, dryRunResult.stderr);
  assert.deepEqual(dryRun.lines(), [], "dry-run does not invoke refresh helpers");
  assert.match(dryRunResult.stdout, /dry-run - Refresh harness extension settings/);
  assert.match(dryRunResult.stdout, /Dry run complete/);

  const invalidFlags = spawnSync("bash", [sourceScript, "--skip-pi-deps", "--no-check"], { cwd: root, encoding: "utf8" });
  assert.equal(invalidFlags.status, 2);
  assert.match(invalidFlags.stderr, /--skip-pi-deps requires --pi or --all/);
  const contradictoryFlags = spawnSync("bash", [sourceScript, "--no-check", "--check-only"], { cwd: root, encoding: "utf8" });
  assert.equal(contradictoryFlags.status, 2);
  assert.match(contradictoryFlags.stderr, /--check-only cannot be combined with --no-check/);

  console.log("pi-harness-refresh-script tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
