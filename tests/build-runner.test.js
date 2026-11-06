"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  resolveBuildConfig,
  pinnedBuildFacts,
  inspectBuildScript,
  resolveConfigureArguments,
  inspectNativeRepoScale,
  inspectNonNativeRepoScale,
  planBuildParallelism,
  applyBuildParallelism,
  runBuild,
  runTests,
  formatRunProgress,
  formatRunResult,
} = require("../src/build-runner.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

function mkRepo(setup) {
  const dir = tmpFixture("pi-build-runner-");
  setup(dir);
  return dir;
}

function mkCommandRepo(args, build = {}) {
  return mkRepo((dir) => {
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".pi", "project.json"), JSON.stringify({
      build: { command: process.execPath, args, ...build },
    }));
  });
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const buildRunnerSource = fs.readFileSync(path.join(__dirname, "..", "src", "build-runner.js"), "utf8");
assert.equal(buildRunnerSource.includes("spawnSync"), false, "build and test subprocesses must not block Pi's event loop");
const buildRunnerExtensionSource = fs.readFileSync(path.join(__dirname, "..", ".pi", "extensions", "build-runner", "index.ts"), "utf8");
assert.match(buildRunnerExtensionSource, /signal,\s*onProgress:/, "the tool AbortSignal must reach runBuild/runTests");
assert.match(buildRunnerExtensionSource, /formatRunProgress\(progress\)/, "tool updates must render build progress");

// Pinned config in .pi/project.json wins over detection.
const pinned = mkRepo((dir) => {
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi", "project.json"), JSON.stringify({
    build: { command: "make", args: ["-j4"], targets: ["engine", "tests"], timeoutMs: 60_000 },
    test: { command: "./run-tests.sh", filterArg: true },
  }));
});
const pinnedCfg = resolveBuildConfig(pinned);
assert.equal(pinnedCfg.build.command, "make");
assert.deepEqual(pinnedCfg.build.targets, ["engine", "tests"]);
assert.equal(pinnedCfg.source, "pinned");
const pinnedFacts = pinnedBuildFacts(pinned);
assert.equal(pinnedFacts.provider, "project-config");
assert.ok(pinnedFacts.facts.some((fact) => fact.object === "build-target:engine"));
assert.ok(pinnedFacts.facts.every((fact) => !JSON.stringify(fact).includes("make -j4")), "raw commands must not be exposed as facts");

// CMake detection: CMakeLists + build dir => cmake --build; test binaries under build/.
const cmake = mkRepo((dir) => {
  fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "project(demo)\n");
  fs.writeFileSync(path.join(dir, "configure.sh"), "#!/bin/sh\n");
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  fs.writeFileSync(path.join(dir, "build", "demo-unit-tests"), "#!/bin/sh\necho ok\n");
  fs.chmodSync(path.join(dir, "build", "demo-unit-tests"), 0o755);
});
const cmakeCfg = resolveBuildConfig(cmake);
assert.equal(cmakeCfg.source, "detected");
assert.equal(cmakeCfg.build.command, "cmake");
assert.deepEqual(cmakeCfg.build.args.slice(0, 2), ["--build", "build"]);
assert.ok(cmakeCfg.configure && /configure\.sh$/.test(cmakeCfg.configure.script), "configure.sh is detected");
assert.deepEqual(cmakeCfg.test.binaries, ["build/demo-unit-tests"], "detected test binaries are repository-relative");
const cmakeTestFact = pinnedBuildFacts(cmake).facts.find((fact) => fact.predicate === "tests");
assert.equal(cmakeTestFact.path, "build/demo-unit-tests", "build facts preserve the repository-relative path contract");
assert.equal(path.isAbsolute(cmakeTestFact.path), false);

// A repository-local configure-only pin augments CMake detection instead of
// suppressing the detected build command.
const configureOnly = mkRepo((dir) => {
  fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "project(configure_only)\n");
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  fs.mkdirSync(path.join(dir, "build"));
  fs.writeFileSync(path.join(dir, "repo-configure.sh"), "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(path.join(dir, ".pi", "project.json"), JSON.stringify({
    configure: { script: "repo-configure.sh", args: ["repo-mode"] },
  }));
});
const configureOnlyCfg = resolveBuildConfig(configureOnly);
assert.equal(configureOnlyCfg.source, "detected");
assert.equal(configureOnlyCfg.build.command, "cmake");
assert.deepEqual(configureOnlyCfg.configure.args, ["repo-mode"]);

// npm detection fallback.
const npmRepo = mkRepo((dir) => {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }));
});
const npmCfg = resolveBuildConfig(npmRepo);
assert.equal(npmCfg.build.command, "npm");
assert.deepEqual(npmCfg.build.args, ["run", "build"]);

// A memory-only build setting preserves CMake/npm detection and does not
// invent a build command for an unknown build system.
for (const system of ["cmake", "npm", "none"]) {
  const memoryOnly = mkRepo((dir) => {
    fs.mkdirSync(path.join(dir, ".pi"));
    fs.writeFileSync(path.join(dir, ".pi", "project.json"), JSON.stringify({ build: { minimumStartMemoryMb: 8192 } }));
    if (system === "cmake") fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "project(memory_only)\n");
    if (system === "npm") fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
  });
  const config = resolveBuildConfig(memoryOnly);
  assert.equal(config.minimumStartMemoryMb, 8192);
  assert.equal(config.build?.command ?? null, system === "none" ? null : system);
  assert.equal(config.source, system === "none" ? "none" : "detected");
}
for (const minimumStartMemoryMb of [0, -1, 1.5, "8192", null, false, {}, Number.MAX_SAFE_INTEGER + 1]) {
  const invalid = mkCommandRepo(["-e", "process.exit(0)"], { minimumStartMemoryMb });
  assert.throws(() => resolveBuildConfig(invalid), /build\.minimumStartMemoryMb: expected a positive integer/);
}

// A hybrid repository's pinned non-native command is not treated as a native
// build merely because the repository also contains CMake sources.
const hybridRepo = mkRepo((dir) => {
  fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "project(native_component)\n");
  fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".pi", "project.json"), JSON.stringify({ build: { command: "npm", args: ["run", "build"] } }));
});
const hybridCfg = resolveBuildConfig(hybridRepo);
assert.equal(planBuildParallelism(hybridRepo, hybridCfg).managed, false);

// Nothing detected => null config with guidance.
const empty = mkRepo(() => {});
const emptyCfg = resolveBuildConfig(empty);
assert.equal(emptyCfg.build, null);
assert.match(emptyCfg.guidance, /pin/i);

// Bare or excessive native parallel flags are always converted to a finite,
// memory-planned job count. Explicitly lower limits remain lower.
assert.deepEqual(
  applyBuildParallelism("cmake", ["--build", "build", "--parallel", "--target", "demo"], 2),
  ["--build", "build", "--parallel", "2", "--target", "demo"],
);
assert.deepEqual(applyBuildParallelism("cmake", ["--build", "build", "--parallel=16"], 3), ["--build", "build", "--parallel=3"]);
assert.deepEqual(applyBuildParallelism("cmake", ["--build", "build", "-j1"], 3), ["--build", "build", "-j1"]);
assert.deepEqual(applyBuildParallelism("make", ["all", "-j"], 2), ["all", "-j2"]);
assert.deepEqual(
  applyBuildParallelism("cmake", ["--build", "build", "--", "VERBOSE=1"], 2),
  ["--build", "build", "--parallel", "2", "--", "VERBOSE=1"],
);

// The planner is RAM-, CPU-, repository-size-, and cgroup-input aware. A
// large native repo on a 16 GiB host is capped below all 8 CPUs.
const planned = planBuildParallelism(cmake, cmakeCfg, {
  cpuCount: 8,
  memory: { totalMb: 16 * 1024, availableMb: 9 * 1024 },
  scale: { large: true, translationUnits: 301, capped: true },
  env: {},
});
assert.equal(planned.jobs, 2);
assert.equal(planned.largeRepo, true);
assert.equal(planned.memoryPerJobMb, 2048);
const lowMemoryPlan = planBuildParallelism(cmake, cmakeCfg, {
  cpuCount: 8,
  memory: { totalMb: 16 * 1024, availableMb: 1500 },
  scale: { large: true, translationUnits: 301, capped: true },
  env: {},
});
assert.equal(lowMemoryPlan.jobs, 1);
assert.equal(lowMemoryPlan.allowed, false, "critically low-memory native builds are deferred instead of risking an OOM");

// Large non-native builds use the same 4 GiB start minimum. Their working-set
// estimate does not implicitly raise that threshold.
const lowMemoryNonNativePlan = planBuildParallelism(npmRepo, npmCfg, {
  memory: { totalMb: 16 * 1024, availableMb: 3 * 1024 },
  scale: { large: true, sourceFiles: 501, capped: true },
  env: {},
});
assert.equal(lowMemoryNonNativePlan.managed, false);
assert.equal(lowMemoryNonNativePlan.largeRepo, true);
assert.equal(lowMemoryNonNativePlan.estimatedBuildMemoryMb, 4096);
assert.equal(lowMemoryNonNativePlan.minimumStartMemoryMb, 4096);
assert.equal(lowMemoryNonNativePlan.allowed, false, "large non-native builds are also deferred under memory pressure");

// Start admission is exactly 4 GiB, independent of tool, repo size, and the
// reserve/per-job estimates that still control native build parallelism.
for (const [cwd, config] of [[cmake, cmakeCfg], [npmRepo, npmCfg]]) {
  for (const large of [false, true]) {
    const inputs = { cpuCount: 8, scale: { large }, env: {} };
    for (const availableMb of [0, 4095, 4096, 6144]) {
      const plan = planBuildParallelism(cwd, config, { ...inputs, memory: { totalMb: 16 * 1024, availableMb } });
      assert.equal(plan.minimumStartMemoryMb, 4096);
      assert.equal(plan.allowed, availableMb >= 4096, `default build-start boundary: ${availableMb} MiB`);
      assert.equal(plan.memoryAvailableMb, availableMb, "zero available RAM remains observable");
    }
    for (const minimumStartMemoryMb of [2048, 8192]) {
      const projectConfig = { ...config, minimumStartMemoryMb };
      for (const availableMb of [minimumStartMemoryMb - 1, minimumStartMemoryMb]) {
        const plan = planBuildParallelism(cwd, projectConfig, { ...inputs, memory: { totalMb: 16 * 1024, availableMb } });
        assert.equal(plan.minimumStartMemoryMb, minimumStartMemoryMb);
        assert.equal(plan.allowed, availableMb >= minimumStartMemoryMb, "project overrides can lower or raise the start minimum");
      }
    }
    const forced = planBuildParallelism(cwd, config, { ...inputs, memory: { totalMb: 16 * 1024, availableMb: 0 }, env: { PI_BUILD_ALLOW_LOW_MEMORY: "1" } });
    assert.equal(forced.allowed, true, "explicit force still bypasses only start admission");
  }
}

// Generated build trees do not make a small source repository look large.
const scaleRepo = mkRepo((dir) => {
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "build"));
  for (let i = 0; i < 2; i += 1) fs.writeFileSync(path.join(dir, "src", `unit-${i}.cpp`), "");
  for (let i = 0; i < 10; i += 1) fs.writeFileSync(path.join(dir, "build", `generated-${i}.cpp`), "");
});
assert.deepEqual(inspectNativeRepoScale(scaleRepo, 3), { large: false, translationUnits: 2, capped: false });
const scriptScaleRepo = mkRepo((dir) => {
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, ".next"));
  for (let i = 0; i < 2; i += 1) fs.writeFileSync(path.join(dir, "src", `unit-${i}.ts`), "");
  for (let i = 0; i < 10; i += 1) fs.writeFileSync(path.join(dir, ".next", `generated-${i}.js`), "");
});
assert.deepEqual(inspectNonNativeRepoScale(scriptScaleRepo, 3), { large: false, sourceFiles: 2, capped: false });

const previousSuiteAllowLowMemory = process.env.PI_BUILD_ALLOW_LOW_MEMORY;
process.env.PI_BUILD_ALLOW_LOW_MEMORY = "1";
(async () => {
  // A project start minimum is enforced before direct commands, configure
  // steps, and canonical build scripts. A huge threshold keeps this fixture
  // deterministic without depending on the host's current free RAM.
  const previousForce = process.env.PI_BUILD_ALLOW_LOW_MEMORY;
  try {
    delete process.env.PI_BUILD_ALLOW_LOW_MEMORY;
    for (const buildsProject of [undefined, false, true]) {
      const project = {
        build: { command: "sh", args: ["-c", "touch build-started"], minimumStartMemoryMb: Number.MAX_SAFE_INTEGER },
        test: { command: "sh", args: ["-c", "echo test-ok"] },
        ...(buildsProject === undefined ? {} : { configure: { script: "configure.sh", buildsProject } }),
      };
      const memoryOverrideRepo = mkRepo((dir) => {
        fs.mkdirSync(path.join(dir, ".pi"));
        fs.writeFileSync(path.join(dir, ".pi", "project.json"), JSON.stringify(project));
        fs.writeFileSync(path.join(dir, "configure.sh"), "#!/bin/sh\ntouch configure-started\n");
      });
      const blocked = await runBuild(memoryOverrideRepo, { configure: true });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.skipped, true);
      assert.equal(blocked.parallelism.minimumStartMemoryMb, Number.MAX_SAFE_INTEGER);
      assert.match(blocked.guidance, /build-start minimum/);
      assert.match(blocked.guidance, /build\.minimumStartMemoryMb/);
      assert.equal(fs.existsSync(path.join(memoryOverrideRepo, "build-started")), false);
      assert.equal(fs.existsSync(path.join(memoryOverrideRepo, "configure-started")), false);
      assert.equal((await runTests(memoryOverrideRepo)).ok, true, "build start minimum does not gate tests");

      project.build.minimumStartMemoryMb = 1;
      fs.writeFileSync(path.join(memoryOverrideRepo, ".pi", "project.json"), JSON.stringify(project));
      const allowed = await runBuild(memoryOverrideRepo, { configure: true });
      assert.equal(allowed.ok, true);
      assert.equal(allowed.parallelism.minimumStartMemoryMb, 1, "project edits are picked up on the next build");
      assert.equal(fs.existsSync(path.join(memoryOverrideRepo, buildsProject === undefined ? "build-started" : "configure-started")), true);
    }
  } finally {
    if (previousForce === undefined) delete process.env.PI_BUILD_ALLOW_LOW_MEMORY;
    else process.env.PI_BUILD_ALLOW_LOW_MEMORY = previousForce;
  }

  const invalidMemoryRepo = mkCommandRepo(["-e", "require('node:fs').writeFileSync('started', 'yes')"], { minimumStartMemoryMb: 0 });
  const invalidMemoryRun = await runBuild(invalidMemoryRepo);
  assert.equal(invalidMemoryRun.ok, false);
  assert.equal(invalidMemoryRun.phase, "configuration");
  assert.match(invalidMemoryRun.guidance, /build\.minimumStartMemoryMb/);
  assert.equal(fs.existsSync(path.join(invalidMemoryRepo, "started")), false, "invalid memory configuration never launches a child");

  // Regression: runBuild must yield to Pi's event loop while a child is
  // active. The old spawnSync implementation delayed this 20ms timer until
  // after the build returned.
  const responsivenessRepo = mkCommandRepo(["-e", "setTimeout(() => {}, 150)"]);
  let timerFiredDuringBuild = false;
  const responsivenessTimer = setTimeout(() => { timerFiredDuringBuild = true; }, 20);
  const responsiveRun = await runBuild(responsivenessRepo);
  clearTimeout(responsivenessTimer);
  assert.equal(responsiveRun.ok, true);
  assert.equal(timerFiredDuringBuild, true, "the event loop remains responsive during a build");

  // Progress includes bounded recent output plus heartbeat updates while the
  // process remains active.
  const progressRepo = mkCommandRepo([
    "-e",
    "process.stdout.write('phase-one\\n'); setTimeout(() => process.stderr.write('phase-two\\n'), 80)",
  ]);
  const progressUpdates = [];
  const progressRun = await runBuild(progressRepo, {
    progressIntervalMs: 10,
    onProgress: (progress) => progressUpdates.push(progress),
  });
  assert.equal(progressRun.ok, true);
  assert.ok(progressUpdates.length >= 2, "long-running builds emit progress heartbeats");
  assert.ok(progressUpdates.some((update) => update.stdoutTail.includes("phase-one")), "stdout reaches progress updates");
  assert.ok(progressUpdates.every((update) => update.stdoutTail.length <= 2_000 && update.stderrTail.length <= 2_000));
  assert.match(formatRunProgress(progressUpdates.at(-1)), /running build/);

  const rssGuardedRepo = mkCommandRepo(["-e", "Buffer.alloc(24 * 1024 * 1024, 1); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"]);
  const rssGuarded = await runBuild(rssGuardedRepo, {
    resourceGuard: { rssLimitMb: 1, rssPollMs: 10, termGraceMs: 25 },
  });
  assert.equal(rssGuarded.ok, false);
  assert.equal(rssGuarded.resourceLimitExceeded, true, "build descendants are guarded by aggregate owned-group RSS");
  assert.ok(rssGuarded.peakRssBytes > rssGuarded.rssLimitBytes);

  // Escape/tool cancellation reaches the process group and settles promptly,
  // even when the direct child ignores SIGTERM.
  const cancellationRepo = mkCommandRepo([
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
  ]);
  const controller = new AbortController();
  const cancelTimer = setTimeout(() => controller.abort(), 40);
  const cancelledRun = await runBuild(cancellationRepo, { signal: controller.signal, killGraceMs: 25 });
  clearTimeout(cancelTimer);
  assert.equal(cancelledRun.ok, false);
  assert.equal(cancelledRun.cancelled, true);
  assert.equal(cancelledRun.timedOut, false);
  assert.ok(cancelledRun.durationMs < 2_000, "cancelled builds settle within the kill grace bound");
  assert.match(formatRunResult(cancelledRun), /CANCELLED/);

  // Preserve the old hard timeout and maxBuffer protections under async
  // spawning. Test-only overrides keep these regressions cheap.
  const timeoutRepo = mkCommandRepo([
    "-e",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
  ]);
  const timedOutRun = await runBuild(timeoutRepo, { timeoutMs: 40, killGraceMs: 25 });
  assert.equal(timedOutRun.ok, false);
  assert.equal(timedOutRun.timedOut, true);
  assert.equal(timedOutRun.cancelled, false);
  assert.ok(timedOutRun.durationMs < 2_000, "timed-out builds settle within the hard deadline");
  assert.match(formatRunResult(timedOutRun), /TIMED OUT/);

  const overflowRepo = mkCommandRepo(["-e", "process.stdout.write('x'.repeat(4096))"]);
  const overflowRun = await runBuild(overflowRepo, { maxBuffer: 512, killGraceMs: 25 });
  assert.equal(overflowRun.ok, false);
  assert.equal(overflowRun.outputLimitExceeded, true);
  assert.match(overflowRun.error, /stdout maxBuffer length exceeded/);

  // runTests executes a detected binary with a filter argument and captures output.
  const t = await runTests(cmake, { filter: "ragdoll" });
  assert.equal(t.ok, true);
  assert.match(t.runs[0].stdout, /ok/);
  assert.deepEqual(t.runs[0].args, ["ragdoll"]);

  // Crash capture: exit code 134 (SIGABRT) marks crashed and requests a backtrace.
  const crash = mkRepo((dir) => {
    fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "project(x)\n");
    fs.mkdirSync(path.join(dir, "build"), { recursive: true });
    fs.writeFileSync(path.join(dir, "build", "x-unit-tests"), "#!/bin/sh\necho boom >&2\nexit 134\n");
    fs.chmodSync(path.join(dir, "build", "x-unit-tests"), 0o755);
  });
  const c = await runTests(crash, {});
  assert.equal(c.ok, false);
  assert.equal(c.runs[0].crashed, true, "exit 134 is flagged as a native crash");
  assert.match(formatRunResult(c), /crash/i);

  // Pinned binaries that are not built yet are skipped with a note instead of
  // failing the whole run (root build/ dirs come and go on big repos).
  const partial = mkRepo((dir) => {
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.mkdirSync(path.join(dir, "present"), { recursive: true });
    fs.writeFileSync(path.join(dir, "present", "ok-tests"), "#!/bin/sh\necho fine\n");
    fs.chmodSync(path.join(dir, "present", "ok-tests"), 0o755);
    fs.writeFileSync(path.join(dir, ".pi", "project.json"), JSON.stringify({
      test: { binaries: ["present/ok-tests", "missing/not-built-tests"] },
    }));
  });
  const partialRun = await runTests(partial, {});
  assert.equal(partialRun.ok, true, "missing pinned binaries do not fail the run");
  assert.equal(partialRun.runs.length, 1);
  assert.deepEqual(partialRun.skippedBinaries, ["missing/not-built-tests"]);
  assert.match(formatRunResult(partialRun), /not built/i);

  // Flake classification: a test that fails once then passes is retried and
  // marked flaky, with the overall result ok.
  const flaky = mkRepo((dir) => {
    fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "project(f)\n");
    fs.mkdirSync(path.join(dir, "build"), { recursive: true });
    fs.writeFileSync(path.join(dir, "build", "f-unit-tests"), `#!/bin/sh
marker="$(dirname "$0")/first-run"
if [ ! -f "$marker" ]; then touch "$marker"; echo "intermittent failure" >&2; exit 1; fi
echo "passed on retry"
`);
    fs.chmodSync(path.join(dir, "build", "f-unit-tests"), 0o755);
  });
  const f = await runTests(flaky, {});
  assert.equal(f.ok, true, "flaky test passes after auto-retry");
  assert.equal(f.runs[0].flaky, true, "retried-then-passing run is marked flaky");
  assert.match(formatRunResult(f), /flaky/i);

  // retryFlaky: false disables the retry.
  const flaky2 = mkRepo((dir) => {
    fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "project(f2)\n");
    fs.mkdirSync(path.join(dir, "build"), { recursive: true });
    fs.writeFileSync(path.join(dir, "build", "f2-unit-tests"), "#!/bin/sh\nexit 1\n");
    fs.chmodSync(path.join(dir, "build", "f2-unit-tests"), 0o755);
  });
  const f2 = await runTests(flaky2, { retryFlaky: false });
  assert.equal(f2.ok, false);
  assert.ok(!f2.runs[0].flaky);

  // Script arguments belong to repository configuration, not Build Runner.
  // Defaults apply to full builds, exact-target additions trigger the script
  // for that target, explicit call arguments override both, and nproc still
  // observes the memory-safe cap.
  const scriptedBuild = mkRepo((dir) => {
    fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "project(scripted)\n");
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".configure.sh"), `#!/bin/sh
printf '%s|%s|%s|%s\\n' "$#" "$1" "$2" "$(nproc)" > script-run.txt
printf '%s\\n' "$MAKEFLAGS" > script-makeflags.txt
if false; then
  make -j$(nproc)
fi
`);
    fs.writeFileSync(path.join(dir, ".pi", "project.json"), JSON.stringify({
      configure: {
        script: ".configure.sh",
        args: ["repo-default"],
        argsByTarget: { demo: ["repo-demo-option"] },
      },
      build: { command: "sh", args: ["-c", "touch targeted-check.txt"], maxJobs: 1, minimumStartMemoryMb: 8192 },
    }));
  });
  assert.equal(inspectBuildScript(path.join(scriptedBuild, ".configure.sh")).buildsProject, true);
  const scriptedConfig = resolveBuildConfig(scriptedBuild);
  assert.equal(scriptedConfig.configure.buildsProject, true);
  assert.deepEqual(resolveConfigureArguments(scriptedConfig, {}), { args: ["repo-default"], source: "project", targetArgsApplied: false });
  assert.deepEqual(resolveConfigureArguments(scriptedConfig, { target: "demo" }), { args: ["repo-default", "repo-demo-option"], source: "project+target", targetArgsApplied: true });
  assert.deepEqual(resolveConfigureArguments(scriptedConfig, { target: "demo", configureArgs: ["call-override"] }), { args: ["call-override"], source: "call", targetArgsApplied: false });

  const scriptOnlyMemoryRepo = mkRepo((dir) => {
    fs.mkdirSync(path.join(dir, ".pi"));
    fs.writeFileSync(path.join(dir, "build.sh"), "#!/bin/sh\necho script-only\n");
    fs.writeFileSync(path.join(dir, ".pi", "project.json"), JSON.stringify({
      configure: { script: "build.sh", buildsProject: true },
      build: { minimumStartMemoryMb: 8192 },
    }));
  });
  const scriptOnlyMemoryRun = await runBuild(scriptOnlyMemoryRepo);
  assert.equal(scriptOnlyMemoryRun.ok, true);
  assert.equal(scriptOnlyMemoryRun.phase, "build-script");
  assert.equal(scriptOnlyMemoryRun.parallelism.minimumStartMemoryMb, 8192);
  assert.equal(resolveBuildConfig(scriptOnlyMemoryRepo).build, null, "a script-only memory override does not invent a direct build command");

  const scriptDefaultsBuild = mkRepo((dir) => {
    fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "project(defaults)\n");
    fs.writeFileSync(path.join(dir, "configure.sh"), `#!/bin/sh
printf '%s\\n' "$#" > script-arg-count.txt
if false; then
  make -j$(nproc)
fi
`);
  });

  const previousAllowLowMemory = process.env.PI_BUILD_ALLOW_LOW_MEMORY;
  const previousMakeFlags = process.env.MAKEFLAGS;
  process.env.PI_BUILD_ALLOW_LOW_MEMORY = "1";
  process.env.MAKEFLAGS = "-k -j 8 --output-sync=target --jobserver-auth=3,4";
  let scripted;
  let targetedScripted;
  let fullScriptArgs;
  let defaultedScripted;
  try {
    scripted = await runBuild(scriptedBuild, {});
    fullScriptArgs = fs.readFileSync(path.join(scriptedBuild, "script-run.txt"), "utf8").trim();
    targetedScripted = await runBuild(scriptedBuild, { target: "demo" });
    defaultedScripted = await runBuild(scriptDefaultsBuild, {});
  } finally {
    if (previousAllowLowMemory === undefined) delete process.env.PI_BUILD_ALLOW_LOW_MEMORY;
    else process.env.PI_BUILD_ALLOW_LOW_MEMORY = previousAllowLowMemory;
    if (previousMakeFlags === undefined) delete process.env.MAKEFLAGS;
    else process.env.MAKEFLAGS = previousMakeFlags;
  }
  assert.equal(scripted.ok, true);
  assert.equal(scripted.phase, "build-script");
  assert.equal(scripted.parallelism.minimumStartMemoryMb, 8192);
  assert.equal(scripted.configureArgsSource, "project");
  assert.equal(scripted.configureArgsCount, 1);
  assert.equal(fullScriptArgs, "1|repo-default||1");
  assert.equal(fs.readFileSync(path.join(scriptedBuild, "script-makeflags.txt"), "utf8").trim(), "-k --output-sync=target -j1", "split job counts and stale jobserver flags are removed from MAKEFLAGS");
  assert.match(formatRunResult(scripted), /jobs 1/);
  assert.equal(targetedScripted.ok, true);
  assert.equal(targetedScripted.parallelism.minimumStartMemoryMb, 8192);
  assert.equal(targetedScripted.configureArgsSource, "project+target");
  assert.equal(targetedScripted.configureArgsCount, 2);
  assert.equal(fs.readFileSync(path.join(scriptedBuild, "script-run.txt"), "utf8").trim(), "2|repo-default|repo-demo-option|1");
  assert.equal(fs.existsSync(path.join(scriptedBuild, "targeted-check.txt")), true, "targeted builds retain their direct target check");
  assert.equal(defaultedScripted.ok, true);
  assert.equal(defaultedScripted.configureArgsSource, "script-default");
  assert.equal(fs.readFileSync(path.join(scriptDefaultsBuild, "script-arg-count.txt"), "utf8").trim(), "0", "another repository receives no global script arguments");

  // End-to-end regression for the original bare-parallel shape: a
  // `cmake --build ... --parallel` becomes finite before execution.
  const cappedCmake = mkRepo((dir) => {
    fs.writeFileSync(path.join(dir, "CMakeLists.txt"), "project(capped)\n");
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.mkdirSync(path.join(dir, "build"));
    const fakeCmake = path.join(dir, "cmake");
    fs.writeFileSync(fakeCmake, "#!/bin/sh\nprintf '%s\\n' \"$@\" > invoked-args.txt\n");
    fs.chmodSync(fakeCmake, 0o755);
    fs.writeFileSync(path.join(dir, ".pi", "project.json"), JSON.stringify({
      build: { command: fakeCmake, args: ["--build", "build", "--parallel"], targetArg: "--target", maxJobs: 1 },
    }));
  });
  const previousAllowCapped = process.env.PI_BUILD_ALLOW_LOW_MEMORY;
  process.env.PI_BUILD_ALLOW_LOW_MEMORY = "1";
  let cappedRun;
  try {
    cappedRun = await runBuild(cappedCmake, { target: "demo", configure: false });
  } finally {
    if (previousAllowCapped === undefined) delete process.env.PI_BUILD_ALLOW_LOW_MEMORY;
    else process.env.PI_BUILD_ALLOW_LOW_MEMORY = previousAllowCapped;
  }
  assert.equal(cappedRun.ok, true);
  assert.deepEqual(cappedRun.args.slice(0), ["--build", "build", "--parallel", "1", "--target", "demo"]);
  assert.deepEqual(fs.readFileSync(path.join(cappedCmake, "invoked-args.txt"), "utf8").trim().split("\n"), cappedRun.args);

  // runBuild uses the pinned command.
  const pinnedBuild = mkRepo((dir) => {
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".pi", "project.json"), JSON.stringify({
      build: { command: "sh", args: ["-c", "echo built-$1", "sh"], targets: [] },
    }));
  });
  const b = await runBuild(pinnedBuild, { target: "demo" });
  assert.equal(b.ok, true);
  assert.match(b.stdout, /built-demo/);

  console.log("build-runner tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  if (previousSuiteAllowLowMemory === undefined) delete process.env.PI_BUILD_ALLOW_LOW_MEMORY;
  else process.env.PI_BUILD_ALLOW_LOW_MEMORY = previousSuiteAllowLowMemory;
});
