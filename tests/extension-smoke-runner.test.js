"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const {
  discoverExtensionEntries,
  runProcessGroup,
  parseJsonLines,
  QUALIFICATION_MAX_BUFFER,
  qualifyJsonCapture,
  runRpcProbe,
  runModelProbe,
} = require("../scripts/extension-smoke-runner");
const { tmpFixture } = require("./helpers/tmp-fixture");

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

(async () => {
  const tmp = tmpFixture("pi-extension-smoke-runner-");
  fs.mkdirSync(path.join(tmp, ".pi", "extensions", "alpha"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "extensions", "beta"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".pi", "extensions", "alpha", "index.ts"), "export default function() {}\n");
  fs.writeFileSync(path.join(tmp, "extensions", "beta", "index.ts"), "export default function() {}\n");
  fs.writeFileSync(path.join(tmp, "extensions", "top-level.ts"), "export default function() {}\n");
  assert.deepEqual(discoverExtensionEntries(tmp), [
    ".pi/extensions/alpha/index.ts",
    "extensions/beta/index.ts",
    "extensions/top-level.ts",
  ]);

  const fake = path.join(tmp, "fake-pi.js");
  const pidFile = path.join(tmp, "pids.json");
  fs.writeFileSync(fake, `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
if (process.argv.includes("-p")) {
  process.stdout.write((process.env.FAKE_MODEL_OUTPUT || "ok") + "\\n");
  process.exit(0);
}
if (process.env.FAKE_RPC_MODE === "hang") {
  process.on("SIGTERM", () => {});
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: "ignore" });
  fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
  setInterval(() => {}, 1000);
} else {
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk.toString("utf8"); });
  process.stdin.on("end", () => {
    if (process.env.FAKE_RPC_MODE === "invalid") process.stdout.write("not-json\\n");
    for (const line of input.trim().split(/\\n/)) {
      if (!line) continue;
      const request = JSON.parse(line);
      const data = request.type === "get_commands" ? { commands: [{ name: "fake" }] } : { isStreaming: false };
      process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data }) + "\\n");
    }
    if (process.env.FAKE_RPC_MODE === "extension-error") process.stdout.write(JSON.stringify({ type: "extension_error", extensionPath: "fake", event: "session_start", error: "boom" }) + "\\n");
  });
}
`);

  const common = { command: process.execPath, commandArgsPrefix: [fake], cwd: tmp, timeoutMs: 2000, killGraceMs: 100 };
  const success = await runRpcProbe("extensions/beta/index.ts", { ...common, env: { ...process.env, FAKE_RPC_MODE: "success" } });
  assert.equal(success.code, 0);
  assert.equal(success.commandCount, 1);
  assert.equal(success.extensionErrors.length, 0);

  await assert.rejects(
    runRpcProbe("extensions/beta/index.ts", { ...common, env: { ...process.env, FAKE_RPC_MODE: "extension-error" } }),
    /extension_error event/,
  );
  await assert.rejects(
    runRpcProbe("extensions/beta/index.ts", { ...common, env: { ...process.env, FAKE_RPC_MODE: "invalid" } }),
    /invalid RPC JSON/,
  );

  await assert.rejects(
    runRpcProbe("extensions/beta/index.ts", { ...common, env: { ...process.env, FAKE_RPC_MODE: "hang" }, timeoutMs: 500 }),
    /timeout after 500ms/,
  );
  const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
  await delay(150);
  assert.equal(alive(pids.parent), false, "timed-out RPC parent must be killed");
  assert.equal(alive(pids.grandchild), false, "timed-out RPC grandchild must be killed with the process group");

  assert.equal(typeof qualifyJsonCapture, "function", "native JSON capture needs an explicit terminal qualification gate");
  const rawLimit = 1024 * 1024;
  assert.equal(QUALIFICATION_MAX_BUFFER, rawLimit, "qualification must retain the frozen 1 MiB raw limit");
  const captureChild = path.join(tmp, "capture-child.js");
  fs.writeFileSync(captureChild, String.raw`
const { setTimeout: delay } = require("node:timers/promises");
const mode = process.argv[2];
const cap = Number(process.argv[3]);
const encode = (events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const base = (note = "synthetic") => [
  { type: "session", id: "synthetic-capture" },
  { type: "agent_start" },
  { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ status: "PASS", note }) }] } },
  { type: "agent_end", willRetry: false },
];
const completed = (note) => encode([...base(note), { type: "agent_settled", aborted: false }]);
const write = (stream, data) => new Promise((resolve) => stream.write(data, resolve));
function padded(bytes) {
  const prefix = completed() + '{"type":"capture_noise","text":"';
  const suffix = '"}\n';
  const count = bytes - Buffer.byteLength(prefix + suffix);
  return prefix + "界".repeat(Math.floor(count / 3)) + "x".repeat(count % 3) + suffix;
}
(async () => {
  if (mode === "split-utf8") {
    const wire = Buffer.from(completed("🙂€\u2028\u2029終"));
    const emoji = wire.indexOf(Buffer.from("🙂"));
    const euro = wire.indexOf(Buffer.from("€"));
    const boundaries = [emoji + 1, emoji + 3, euro + 1, wire.length];
    let start = 0;
    for (const end of boundaries) {
      await write(process.stdout, wire.subarray(start, end));
      start = end;
      await delay(25);
    }
  } else if (mode === "exact-limit" || mode === "overflow-combined") {
    await write(process.stdout, padded(cap / 2));
    await write(process.stderr, Buffer.alloc(cap / 2 + (mode === "overflow-combined" ? 1 : 0), "s"));
  } else if (mode === "overflow-stdout") {
    await write(process.stdout, padded(cap + 1));
  } else if (mode === "pass-without-settlement") {
    await write(process.stdout, encode(base()));
  } else if (mode === "truncated-settlement") {
    await write(process.stdout, encode(base()) + '{"type":"agent_settled","aborted":');
  } else if (mode === "truncated-trailer") {
    await write(process.stdout, completed() + '{"type":"capture_noise"');
  } else if (mode === "aborted") {
    await write(process.stdout, encode([...base(), { type: "agent_settled", aborted: true }]));
  } else if (mode === "resumed") {
    await write(process.stdout, completed() + encode([{ type: "agent_start" }]));
  } else if (mode === "assistant-error") {
    const events = base();
    events[2].message.stopReason = "error";
    await write(process.stdout, encode([...events, { type: "agent_settled", aborted: false }]));
  } else if (mode === "nonzero") {
    await write(process.stdout, completed());
    process.exitCode = 7;
  } else if (mode === "complete") {
    await write(process.stdout, completed());
  } else {
    throw new Error("unknown synthetic mode");
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
`);
  let captureCases = 0;
  async function capture(mode) {
    captureCases += 1;
    return runProcessGroup({ command: process.execPath, args: [captureChild, mode, String(rawLimit)], cwd: tmp,
      timeoutMs: 5000, killGraceMs: 100, maxBuffer: rawLimit });
  }
  function qualifies(result, expected, reason) {
    const verdict = qualifyJsonCapture(result);
    assert.equal(verdict.ok, expected, verdict.reasons.join("; "));
    if (reason) assert.match(verdict.reasons.join("; "), reason);
    return verdict;
  }
  const completedCapture = await capture("complete");
  assert.equal(completedCapture.code, 0);
  qualifies(completedCapture, true);

  const passOnly = await capture("pass-without-settlement");
  assert.equal(passOnly.code, 0);
  assert.match(passOnly.stdout, /PASS/);
  assert.ok(parseJsonLines(passOnly.stdout).events.some((event) => event.type === "agent_end"));
  qualifies(passOnly, false, /agent_settled/);

  for (const mode of ["truncated-settlement", "truncated-trailer"]) {
    const result = await capture(mode);
    assert.equal(result.code, 0);
    assert.equal(parseJsonLines(result.stdout).invalid.length, 1, "a valid prefix must not hide the unfinished record");
    qualifies(result, false, /invalid JSON/);
  }
  const split = await capture("split-utf8");
  const splitVerdict = qualifies(split, true);
  const message = splitVerdict.parsed.events.find((event) => event.type === "message_end").message;
  assert.equal(JSON.parse(message.content[0].text).note, "🙂€\u2028\u2029終");
  assert.equal(split.stdout.includes("\ufffd"), false, "UTF-8 fragments must not be replaced or lost");
  assert.equal(splitVerdict.rawOutputBytes, Buffer.byteLength(split.stdout), "count bytes, not UTF-16 string length");

  const atLimit = await capture("exact-limit");
  assert.equal(atLimit.code, 0);
  assert.equal(atLimit.overflow, false);
  assert.equal(qualifies(atLimit, true).rawOutputBytes, rawLimit);
  assert.ok(atLimit.stdout.length < Buffer.byteLength(atLimit.stdout), "the boundary fixture must include multibyte data");

  const stdoutOverflow = await capture("overflow-stdout");
  assert.equal(stdoutOverflow.overflow, true);
  assert.equal(stdoutOverflow.timedOut, false);
  assert.ok(parseJsonLines(stdoutOverflow.stdout).events.some((event) => event.type === "agent_settled"));
  qualifies(stdoutOverflow, false, /output limit/);

  const combinedOverflow = await capture("overflow-combined");
  assert.equal(combinedOverflow.overflow, true, "stdout and stderr share one budget");
  assert.equal(combinedOverflow.timedOut, false);
  assert.ok(Buffer.byteLength(combinedOverflow.stdout) < rawLimit);
  assert.ok(Buffer.byteLength(combinedOverflow.stderr) < rawLimit);
  qualifies(combinedOverflow, false, /output limit/);

  qualifies(await capture("aborted"), false, /agent_settled/);
  qualifies(await capture("resumed"), false, /agent_settled/);
  qualifies(await capture("assistant-error"), false, /assistant.*error/);
  qualifies(await capture("nonzero"), false, /exit=7/);
  console.log(`offline capture qualification passed: ${captureCases} synthetic scenarios; raw stdout+stderr limit=${rawLimit}`);

  const model = await runModelProbe({ command: process.execPath, commandArgsPrefix: [fake], cwd: tmp, env: process.env, timeoutMs: 2000, killGraceMs: 100 });
  assert.equal(model.stdout.trim(), "ok");
  await assert.rejects(
    runModelProbe({ command: process.execPath, commandArgsPrefix: [fake], cwd: tmp, env: { ...process.env, FAKE_MODEL_OUTPUT: "wrong" }, timeoutMs: 2000 }),
    /expected stdout exactly "ok"/,
  );

  const shellSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "check-extensions-smoke.sh"), "utf8");
  const skillSmokeSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "check-skill-synthesis-tui.sh"), "utf8");
  const runnerSource = fs.readFileSync(path.join(__dirname, "..", "scripts", "extension-smoke-runner.js"), "utf8");
  assert(shellSource.includes("node scripts/extension-smoke-runner.js all"));
  assert(!shellSource.includes("pi -p --no-extensions -e"), "per-extension model turns should be removed");
  assert(skillSmokeSource.includes("extension-smoke-runner.js rpc .pi/extensions/reasoning-runtime/index.ts"));
  assert(!skillSmokeSource.includes("say only ok"), "focused skill smoke should not add a second model turn");
  assert(runnerSource.includes("SMOKE START mode=rpc"));
  assert(runnerSource.includes("SMOKE PASS mode=rpc"));
  assert(runnerSource.includes('"--thinking", "off"'));
  assert(runnerSource.includes('"-p", "--no-session"'), "model smoke probes must not pollute global Pi session history");
  assert(runnerSource.includes('process.kill(-child.pid, signal)'), "timeouts should kill detached process groups");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("extension smoke runner tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
