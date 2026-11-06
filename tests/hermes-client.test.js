"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  hermesEnv,
  redactHermesArgs,
  formatHermesCommand,
  runHermes,
} = require("../src/hermes-client.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-hermes-client-");

function fakeBin(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}`);
  fs.chmodSync(file, 0o755);
  return file;
}

const okBin = fakeBin("hermes-ok.js", `
console.log("out-line");
console.error("err-line");
`);
const failBin = fakeBin("hermes-fail.js", `
console.log("partial output");
console.error("boom");
process.exit(2);
`);
const slowBin = fakeBin("hermes-slow.js", `setTimeout(() => {}, 60_000);`);

// hermesEnv defaults HERMES_ACCEPT_HOOKS on, preserves explicit values.
assert.equal(hermesEnv({}).HERMES_ACCEPT_HOOKS, "1");
assert.equal(hermesEnv({ HERMES_ACCEPT_HOOKS: "0" }).HERMES_ACCEPT_HOOKS, "0");
assert.equal(hermesEnv({ OTHER: "x" }).OTHER, "x");

// Commands retain diagnostic shape without exposing query or credential values.
const querySecret = "PRIVATE_QUERY_TEXT_SHOULD_NEVER_APPEAR";
assert.deepEqual(
  redactHermesArgs(["chat", "--quiet", "--query", querySecret, "--token=private-token"]),
  ["chat", "--quiet", "--query", `[REDACTED:${querySecret.length} chars]`, "--token=[REDACTED:13 chars]"],
);
assert.equal(
  formatHermesCommand("hermes", ["chat", "-q", querySecret]),
  `hermes chat -q [REDACTED:${querySecret.length} chars]`,
);
assert.equal(
  formatHermesCommand("hermes", ["-z", querySecret]),
  `hermes -z [REDACTED:${querySecret.length} chars]`,
);
assert.deepEqual(redactHermesArgs([`--oneshot=${querySecret}`]), [`--oneshot=[REDACTED:${querySecret.length} chars]`]);
assert.doesNotMatch(formatHermesCommand("hermes", ["--provider", "private-provider", "--model", "private-model"]), /private-provider|private-model/);

(async () => {
  // runHermes combines stdout+stderr and trims, preserving the historical
  // join semantics of the per-extension implementations (stdout keeps its
  // trailing newline before the join).
  assert.equal(await runHermes([], { bin: okBin }), "out-line\n\nerr-line");

  // runHermes rejects on nonzero exit; output remains accessible on the error.
  await assert.rejects(runHermes([], { bin: failBin }), (error) => {
    assert.equal(error.stdout.trim(), "partial output");
    assert.equal(error.stderr.trim(), "boom");
    return true;
  });
  await assert.rejects(runHermes(["chat", "--query", querySecret], { bin: failBin }), (error) => {
    assert.doesNotMatch(String(error.message), new RegExp(querySecret));
    assert.match(String(error.message), /REDACTED/);
    return true;
  });

  // Zero is an explicit deadline-free call, not an immediate timeout or a
  // fallback to the shared default. Keep termination/overflow controls intact.
  const delayedBin = fakeBin("hermes-delayed.js", `setTimeout(() => console.log("complete suggestion"), 150);`);
  assert.equal(await runHermes([], { bin: delayedBin, timeoutMs: 0, killGraceMs: 10 }), "complete suggestion");
  await assert.rejects(runHermes([], { bin: okBin, timeoutMs: 0, maxBuffer: 2 }), /maxBuffer exceeded/);
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(runHermes([], { bin: slowBin, timeoutMs: 0, signal: preAborted.signal }), /aborted before start/);

  // Finite deadlines still apply to other Hermes consumers.
  await assert.rejects(runHermes([], { bin: slowBin, timeoutMs: 500 }));

  // The dogfooded hang: execFile's timeout only SIGTERMs the direct child.
  // A hermes that ignores SIGTERM and leaves a grandchild holding the stdio
  // pipes kept the promise pending forever, which kept headless pi -p
  // processes alive for 20-90 minutes after their turn finished. The call
  // must settle near its deadline and the whole process group must die.
  const wedgeMarker = "31.41592"; // unique sleep duration to pgrep for
  const wedgeBin = path.join(tmp, "hermes-wedge.sh");
  fs.writeFileSync(wedgeBin, `#!/usr/bin/env bash\ntrap '' TERM\nsleep ${wedgeMarker} &\nsleep ${wedgeMarker}\n`);
  fs.chmodSync(wedgeBin, 0o755);
  const wedgeStarted = Date.now();
  await assert.rejects(runHermes([], { bin: wedgeBin, timeoutMs: 300, killGraceMs: 500 }));
  const wedgeElapsed = Date.now() - wedgeStarted;
  assert.ok(wedgeElapsed < 5000, `wedged call must settle near timeout+grace, took ${wedgeElapsed}ms`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const survivors = (marker) => {
    try {
      return require("node:child_process").execFileSync("pgrep", ["-fx", `sleep ${marker}`], { encoding: "utf8" }).trim();
    } catch { return ""; }
  };
  const leftover = survivors(wedgeMarker);
  assert.equal(leftover, "", `no orphaned grandchildren may survive the deadline, found pids: ${leftover}`);

  // Aborting an in-flight call (headless shutdown path) must also kill the
  // whole group, not just the direct child.
  const abortMarker = "27.18281";
  const abortBin = path.join(tmp, "hermes-abort.sh");
  fs.writeFileSync(abortBin, `#!/usr/bin/env bash\ntrap '' TERM\nsleep ${abortMarker} &\nsleep ${abortMarker}\n`);
  fs.chmodSync(abortBin, 0o755);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const abortStarted = Date.now();
  await assert.rejects(runHermes([], { bin: abortBin, timeoutMs: 0, signal: controller.signal }));
  assert.ok(Date.now() - abortStarted < 5000, "aborted call settles promptly");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const abortLeftover = survivors(abortMarker);
  assert.equal(abortLeftover, "", `no grandchildren may survive an abort, found pids: ${abortLeftover}`);

  // combineStderr: false returns stdout only (prompt-suggestion semantics).
  assert.equal(await runHermes([], { bin: okBin, combineStderr: false }), "out-line");

  console.log("hermes-client tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
