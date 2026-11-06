"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Fixed argv only. Workload arguments come from the parent's immutable task input,
// never from a tool call; no attach, shell, arbitrary debugger commands or sudo.
const { DIAGNOSTIC_OPERATIONS, PROFILE_OPERATIONS, diagnosticInputSchema, EXECUTION_SCHEMA } = require("./specialist-schemas");
const { validateJsonSchema } = require("./specialist-contracts");
const { validateGpuDevices } = require("./specialist-gpu");

function fail(code) { throw new Error(`SPECIALIST_DIAGNOSTIC_${code}`); }
function sha(file) {
  const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(131072);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 268435456) fail("TARGET_TOO_LARGE");
    let offset = 0;
    while (offset < before.size) {
      const size = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!size) fail("TARGET_CHANGED_DURING_HASH");
      hash.update(buffer.subarray(0, size)); offset += size;
    }
    const after = fs.fstatSync(fd);
    if (["size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key])) fail("TARGET_CHANGED_DURING_HASH");
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}
function toolBinding(name, execution = {}, cwd) {
  const { executableFingerprint, inSystemRuntime } = require("./specialist-primitives");
  const { safeRelative, pathForbidden } = require("./subagent-workspaces");
  if (name === "nsys" && execution.nsysRuntime) {
    const runtime = execution.nsysRuntime;
    if (typeof runtime.root !== "string" || !path.isAbsolute(runtime.root) || path.resolve(runtime.root) !== runtime.root || fs.realpathSync(runtime.root) !== runtime.root || !fs.statSync(runtime.root).isDirectory() || runtime.root === "/" || runtime.root === process.env.HOME || (cwd && (fs.realpathSync(cwd) === runtime.root || fs.realpathSync(cwd).startsWith(`${runtime.root}/`)))) fail("RUNTIME_ROOT_INVALID");
    if (typeof runtime.executable !== "string" || safeRelative(runtime.executable) !== runtime.executable || pathForbidden(runtime.executable) || !/^[a-f0-9]{64}$/.test(runtime.sha256 || "")) fail("RUNTIME_PIN_INVALID");
    const file = path.join(runtime.root, runtime.executable), fingerprint = executableFingerprint(file);
    if (!fingerprint.available || fingerprint.path !== file || !file.startsWith(`${runtime.root}/`) || fingerprint.sha256 !== runtime.sha256) fail("RUNTIME_STALE");
    return { command: `/runtime/${runtime.executable}`, runtimeRoot: runtime.root, fingerprint };
  }
  // Deliberately ignore user PATH shims, local project executables and installers.
  const fingerprint = executableFingerprint(`/usr/bin/${name}`);
  if (!fingerprint.available || !inSystemRuntime(fingerprint.path)) fail(`TOOL_UNAVAILABLE:${name}${name === "nsys" ? ":pinned-nsysRuntime-required-for-private-install" : ""}`);
  return { command: fingerprint.path, fingerprint };
}
function diagnosticCapabilities(execution = {}) {
  const { executable } = require("./specialist-primitives");
  return Object.fromEntries(Object.entries(DIAGNOSTIC_OPERATIONS).map(([operation, info]) => {
    const reasons = [];
    if (!executable("bwrap")) reasons.push("bwrap-unavailable");
    for (const tool of new Set(["python3", ...info.tools])) {
      try { toolBinding(tool, execution); } catch (error) { reasons.push(error.message); }
    }
    return [operation, { available: reasons.length === 0, reasons, purpose: info.purpose, requiresExecutionAuthorization: true, installingProbe: false }];
  }));
}
function diagnosticPlan({ contract, cwd, operation, file }) {
  const { confinedFile } = require("./specialist-primitives");
  const execution = contract.settings?.domainInput?.execution, policy = contract.settings?.taskPolicy;
  if (!DIAGNOSTIC_OPERATIONS[operation] || !contract.settings?.domainOperations?.includes(operation) || !execution?.operations?.includes(operation)) fail("OPERATION_DENIED");
  if (validateJsonSchema(EXECUTION_SCHEMA, execution).length || !execution.authorization.trim() || !/^[a-f0-9]{64}$/.test(execution.sha256) || !Number.isInteger(execution.timeoutMs) || execution.timeoutMs < 1 || execution.timeoutMs > 120000 || execution.args.some(arg => arg.includes("\0")) || new Set(execution.operations).size !== execution.operations.length) fail("INPUT_INVALID");
  if (!policy || !Array.isArray(policy.readZones) || policy.writeZones?.length || file !== execution.target || !policy.readZones.some(zone => file === zone || (zone.endsWith("/") && file.startsWith(zone)))) fail("TARGET_NOT_AUTHORIZED");
  const absolute = confinedFile(cwd, file);
  if (absolute !== path.join(fs.realpathSync(cwd), file) || sha(absolute) !== execution.sha256) fail("TARGET_STALE_OR_ALIASED");
  const devices = validateGpuDevices(execution.gpuDevices);
  if ((devices.length || execution.nsysRuntime) && !execution.operations.includes("nsys-profile")) fail("NSYS_GRANT_UNUSED");
  const bindings = Object.fromEntries([...new Set(["python3", ...DIAGNOSTIC_OPERATIONS[operation].tools])].map(tool => [tool, toolBinding(tool, execution, cwd)]));
  const target = `/workspace/${file}`, workload = [target, ...execution.args];
  const tools = Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name, binding.command]));
  let args, report = null, summarize = null;
  switch (operation) {
    case "gdb-backtrace":
      args = [tools.gdb, "--batch", "--nx", "--quiet", "--return-child-result", "-iex", "set auto-load off", "-iex", "set debuginfod enabled off", "-ex", "set startup-with-shell off", "-ex", "set pagination off", "-ex", "set print frame-arguments none", "-ex", "run", "-ex", "info threads", "-ex", "thread apply all bt 32", "--args", ...workload]; break;
    case "valgrind-memcheck":
      args = [tools.valgrind, "--tool=memcheck", "--vgdb=no", "--enable-debuginfod=no", "--leak-check=full", "--show-leak-kinds=all", "--track-origins=yes", "--error-exitcode=97", "--", ...workload]; break;
    case "valgrind-callgrind":
      report = "/output/callgrind.out";
      args = [tools.valgrind, "--tool=callgrind", "--vgdb=no", "--enable-debuginfod=no", "--cache-sim=yes", `--callgrind-out-file=${report}`, "--", ...workload];
      summarize = [tools.callgrind_annotate, "--auto=no", "--inclusive=yes", report]; break;
    case "valgrind-massif":
      report = "/output/massif.out";
      args = [tools.valgrind, "--tool=massif", "--vgdb=no", "--enable-debuginfod=no", `--massif-out-file=${report}`, "--", ...workload];
      summarize = [tools.ms_print, report]; break;
    case "nsys-profile":
      args = [tools.nsys, "profile", "--sample=none", "--cpuctxsw=none", `--trace=${devices.length ? "cuda,nvtx,osrt" : "nvtx,osrt"}`, "--stats=true", "--export=none", "--force-overwrite=false", "--output=/output/trace", ...workload]; break;
    case "perf-stat":
      args = [tools.perf, "stat", "--no-big-num", "-e", "task-clock,cycles,instructions,context-switches,page-faults", "--", ...workload]; break;
    case "strace-summary": args = [tools.strace, "-f", "-c", "--", ...workload]; break;
    case "time-profile": args = [tools.time, "-v", "--", ...workload]; break;
    case "python-cprofile":
      report = "/output/profile.pstats";
      args = [tools.python3, "-I", "-m", "cProfile", "-o", report, "--", ...workload]; break;
    case "node-cpu-profile":
      report = "/output/profile.cpuprofile";
      args = [tools.node, "--cpu-prof", "--cpu-prof-dir=/output", "--cpu-prof-name=profile.cpuprofile", "--", ...workload]; break;
  }
  const config = { args, report, summarize, operation };
  const script = [
    "import json, pathlib, resource, subprocess, sys",
    "resource.setrlimit(resource.RLIMIT_CORE, (0, 0))",
    "resource.setrlimit(resource.RLIMIT_FSIZE, (16777216, 16777216))",
    `config = json.loads(${JSON.stringify(JSON.stringify(config))})`,
    "code = subprocess.run(config['args'], stdin=subprocess.DEVNULL).returncode",
    "print('PI_DIAGNOSTIC_TARGET_STATUS:' + str(code), flush=True)",
    "report = config['report']",
    "if report:",
    " p = pathlib.Path(report)",
    " if not p.is_file() or p.is_symlink() or p.stat().st_size > 16777216: sys.exit(98)",
    " if config['summarize']:",
    "  summary_code = subprocess.run(config['summarize'], stdin=subprocess.DEVNULL).returncode",
    "  if summary_code and not code: code = summary_code",
    " elif config['operation'] == 'python-cprofile':",
    "  import pstats",
    "  pstats.Stats(report).strip_dirs().sort_stats('cumulative').print_stats(30)",
    " elif config['operation'] == 'node-cpu-profile':",
    "  profile = json.loads(p.read_text())",
    "  hot = sorted(profile['nodes'], key=lambda node: node.get('hitCount', 0), reverse=True)[:30]",
    "  print(json.dumps({'durationMicros': profile['endTime'] - profile['startTime'], 'sampleCount': len(profile.get('samples', [])), 'hotspots': [{'frame': n['callFrame'], 'selfSamples': n.get('hitCount', 0)} for n in hot]}))",
    "sys.exit(code if code >= 0 else 128 - code)",
  ].join("\n");
  return { command: bindings.python3.fingerprint.path, args: ["-I", "-c", script], runtimeRoot: bindings.nsys?.runtimeRoot, gpuDevices: operation === "nsys-profile" ? devices : [], bindings, execution, config, absolute };
}
function diagnosticPreflight(contract, cwd) {
  const execution = contract.settings?.domainInput?.execution;
  if (!execution) return [];
  try {
    if (!Array.isArray(execution.operations) || !execution.operations.length) fail("INPUT_INVALID");
    for (const operation of execution.operations) diagnosticPlan({ contract, cwd, operation, file: execution.target });
    return [];
  } catch (error) { return [error.message]; }
}
async function runDiagnostic(input) {
  const { runContained } = require("./specialist-primitives");
  const plan = diagnosticPlan(input);
  const result = await runContained({ cwd: input.cwd, signal: input.signal, command: plan.command, args: plan.args, runtimeRoot: plan.runtimeRoot, gpuDevices: plan.gpuDevices, hardwareMetadata: ["perf-stat", "nsys-profile"].includes(input.operation), privateShm: input.operation === "nsys-profile", readZones: input.contract.settings.taskPolicy.readZones, writeZones: [], writable: false, timeoutMs: plan.execution.timeoutMs, outputBytes: 16777216, maxOutputBytes: 65536 });
  // Evidence must name the actual tool/target bytes, even when collection failed.
  const after = diagnosticPlan(input);
  if (JSON.stringify(plan.bindings) !== JSON.stringify(after.bindings)) fail("TOOL_CHANGED_DURING_RUN");
  return { ...result, diagnosticEvidence: { operation: input.operation, target: plan.execution.target, targetSha256: plan.execution.sha256, argumentsSha256: crypto.createHash("sha256").update(JSON.stringify(plan.execution.args)).digest("hex"), tools: Object.fromEntries(Object.entries(plan.bindings).map(([name, value]) => [name, value.fingerprint])), gpuDevices: plan.gpuDevices, timeoutMs: plan.execution.timeoutMs, reportRetention: "bounded summary only; raw profiles are disposable sandbox output", acceptance: "observation-not-independent-verification" } };
}
module.exports = { DIAGNOSTIC_OPERATIONS, PROFILE_OPERATIONS, diagnosticInputSchema, diagnosticCapabilities, diagnosticPreflight, diagnosticPlan, runDiagnostic, validateGpuDevices };
