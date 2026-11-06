#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;
const QUALIFICATION_MAX_BUFFER = 1024 * 1024;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function extensionSmokeEnv(env = process.env, traceDir) {
  return {
    ...env,
    PI_COGNITIVE_AUTO_VERIFY: "0",
    PI_COGNITIVE_AUTO_CHECKPOINT: "0",
    PI_COGNITIVE_ORCHESTRATION_ENABLED: "0",
    PI_PROMPT_SUGGESTIONS_REFINE: "off",
    ...(traceDir ? { PI_TRACE_DIR: traceDir } : {}),
  };
}

function discoverExtensionEntries(cwd = process.cwd(), roots = [".pi/extensions", "extensions"]) {
  const entries = [];
  const seen = new Set();
  for (const relativeRoot of roots) {
    const root = path.resolve(cwd, relativeRoot);
    let children = [];
    try { children = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      let file = null;
      if (child.isDirectory()) file = path.join(root, child.name, "index.ts");
      else if (child.isFile() && /\.[cm]?[jt]s$/.test(child.name)) file = path.join(root, child.name);
      if (!file || !fs.existsSync(file)) continue;
      const absolute = path.resolve(file);
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      entries.push(path.relative(cwd, absolute));
    }
  }
  return entries.sort();
}

function runProcessGroup({ command, args = [], cwd = process.cwd(), env = process.env, input = "", timeoutMs, killGraceMs = DEFAULT_KILL_GRACE_MS, maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let spawnError = null;
    let termTimer;
    let killTimer;
    const detached = process.platform !== "win32";

    const killGroup = (signal) => {
      if (detached && child?.pid) {
        try { process.kill(-child.pid, signal); } catch {}
      }
      try { child?.kill(signal); } catch {}
    };
    const destroyPipes = () => {
      try { child?.stdin?.destroy(); } catch {}
      try { child?.stdout?.destroy(); } catch {}
      try { child?.stderr?.destroy(); } catch {}
    };
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        command,
        args,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        overflow,
        spawnError,
        durationMs: Date.now() - startedAt,
      });
    };

    try {
      child = spawn(command, args, { cwd, env, detached, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      spawnError = error;
      finish(null, null);
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (kind, chunk) => {
      if (kind === "stdout") stdout += chunk;
      else stderr += chunk;
      if (!overflow && Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBuffer) {
        overflow = true;
        killGroup("SIGKILL");
        destroyPipes();
      }
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", (error) => { spawnError = error; });
    child.on("close", finish);

    const bound = positiveInt(timeoutMs, DEFAULT_RPC_TIMEOUT_MS);
    termTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
    }, bound);
    killTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGKILL");
      destroyPipes();
    }, bound + Math.max(0, positiveInt(killGraceMs, DEFAULT_KILL_GRACE_MS)));
    termTimer.unref?.();
    killTimer.unref?.();

    try { child.stdin.end(input); } catch {}
  });
}

function parseJsonLines(text) {
  const events = [];
  const invalid = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); }
    catch { invalid.push(line.slice(0, 500)); }
  }
  return { events, invalid };
}

// Qualifies the raw process capture, not the task's self-reported/artifact result.
function qualifyJsonCapture(result) {
  const rawOutputBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  const parsed = parseJsonLines(result.stdout);
  const reasons = [];
  if (result.spawnError) reasons.push(`spawn error: ${result.spawnError.message || result.spawnError}`);
  if (result.timedOut) reasons.push("process timed out");
  if (result.overflow || rawOutputBytes > QUALIFICATION_MAX_BUFFER) reasons.push("raw output limit exceeded");
  if (result.code !== 0 || result.signal) reasons.push(`exit=${result.code}${result.signal ? ` signal=${result.signal}` : ""}`);
  if (parsed.invalid.length) reasons.push(`${parsed.invalid.length} invalid JSON line(s)`);
  const lifecycle = parsed.events.filter((event) => event?.type === "agent_start" || event?.type === "agent_settled");
  const terminal = lifecycle.at(-1);
  if (terminal?.type !== "agent_settled" || terminal.aborted !== false) {
    reasons.push("missing non-aborted terminal agent_settled");
  }
  for (const event of parsed.events) {
    const message = event?.type === "message_end" ? event.message : null;
    if (message?.role === "assistant" && ["error", "aborted"].includes(message.stopReason)) {
      reasons.push(`assistant stopReason=${message.stopReason}`);
    }
  }
  return { ok: reasons.length === 0, rawOutputBytes, parsed, reasons };
}

function probeFailure(label, result, reasons) {
  const error = new Error(`${label} failed: ${reasons.join("; ")}`);
  error.result = result;
  error.reasons = reasons;
  return error;
}

async function runRpcProbe(extensionFile, options = {}) {
  const timeoutMs = positiveInt(options.timeoutMs ?? process.env.PI_EXTENSION_SMOKE_RPC_TIMEOUT_MS, DEFAULT_RPC_TIMEOUT_MS);
  const command = options.command || process.env.PI_EXTENSION_SMOKE_PI_BIN || "pi";
  const args = [
    ...(options.commandArgsPrefix || []),
    "--mode", "rpc",
    "--no-session",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "-e", extensionFile,
  ];
  const input = `${JSON.stringify({ id: "smoke-state", type: "get_state" })}\n${JSON.stringify({ id: "smoke-commands", type: "get_commands" })}\n`;
  const result = await runProcessGroup({ command, args, cwd: options.cwd, env: options.env, input, timeoutMs, killGraceMs: options.killGraceMs });
  const parsed = parseJsonLines(result.stdout);
  const responses = new Map(parsed.events.filter((event) => event?.type === "response" && event.id).map((event) => [event.id, event]));
  const extensionErrors = parsed.events.filter((event) => event?.type === "extension_error");
  const reasons = [];
  if (result.spawnError) reasons.push(`spawn error: ${result.spawnError.message || result.spawnError}`);
  if (result.timedOut) reasons.push(`timeout after ${timeoutMs}ms`);
  if (result.overflow) reasons.push("output limit exceeded");
  if (result.code !== 0) reasons.push(`exit=${result.code}${result.signal ? ` signal=${result.signal}` : ""}`);
  if (parsed.invalid.length) reasons.push(`${parsed.invalid.length} invalid RPC JSON line(s)`);
  for (const id of ["smoke-state", "smoke-commands"]) {
    const response = responses.get(id);
    if (!response) reasons.push(`missing ${id} response`);
    else if (response.success !== true) reasons.push(`${id} failed: ${response.error || "unknown error"}`);
  }
  if (extensionErrors.length) reasons.push(`${extensionErrors.length} extension_error event(s)`);
  const commandCount = responses.get("smoke-commands")?.data?.commands?.length || 0;
  const details = { ...result, extensionFile, timeoutMs, parsed, extensionErrors, commandCount };
  if (reasons.length) throw probeFailure(`RPC extension probe ${extensionFile}`, details, reasons);
  return details;
}

async function runModelProbe(options = {}) {
  const timeoutMs = positiveInt(options.timeoutMs ?? process.env.PI_EXTENSION_SMOKE_MODEL_TIMEOUT_MS, DEFAULT_MODEL_TIMEOUT_MS);
  const command = options.command || process.env.PI_EXTENSION_SMOKE_PI_BIN || "pi";
  const prompt = options.prompt || "say only ok";
  const args = [...(options.commandArgsPrefix || []), "-p", "--no-session", "--thinking", "off", prompt];
  const result = await runProcessGroup({ command, args, cwd: options.cwd, env: options.env, timeoutMs, killGraceMs: options.killGraceMs });
  const combined = `${result.stdout}\n${result.stderr}`;
  const reasons = [];
  if (result.spawnError) reasons.push(`spawn error: ${result.spawnError.message || result.spawnError}`);
  if (result.timedOut) reasons.push(`timeout after ${timeoutMs}ms`);
  if (result.overflow) reasons.push("output limit exceeded");
  if (result.code !== 0) reasons.push(`exit=${result.code}${result.signal ? ` signal=${result.signal}` : ""}`);
  if (result.stdout.trim() !== "ok") reasons.push(`expected stdout exactly "ok", got ${JSON.stringify(result.stdout.trim().slice(-500))}`);
  if (/Extension error/i.test(combined)) reasons.push("output contained Extension error");
  const details = { ...result, timeoutMs, prompt };
  if (reasons.length) throw probeFailure("full-fleet model probe", details, reasons);
  return details;
}

function printProbeFailure(error) {
  const result = error?.result || {};
  console.error(`SMOKE FAIL ${error.message || error}`);
  if (result.stdout) console.error(`--- stdout ---\n${result.stdout.slice(-8000)}`);
  if (result.stderr) console.error(`--- stderr ---\n${result.stderr.slice(-8000)}`);
  if (result.parsed?.invalid?.length) console.error(`--- invalid RPC lines ---\n${result.parsed.invalid.join("\n")}`);
  if (result.extensionErrors?.length) console.error(`--- extension errors ---\n${JSON.stringify(result.extensionErrors, null, 2)}`);
}

async function main() {
  const cwd = process.cwd();
  const mode = process.argv[2] || "all";
  if (!new Set(["rpc", "model", "all"]).has(mode)) throw new Error("Usage: node scripts/extension-smoke-runner.js [rpc|model|all]");
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-extension-smoke-trace-"));
  const env = extensionSmokeEnv(process.env, traceDir);
  try {
    if (mode === "rpc" || mode === "all") {
      const explicitEntries = process.argv.slice(3).filter(Boolean);
      const entries = explicitEntries.length ? explicitEntries : discoverExtensionEntries(cwd);
      if (!entries.length) throw new Error("No extension entrypoints found");
      const suiteStarted = Date.now();
      for (const extensionFile of entries) {
        const timeoutMs = positiveInt(process.env.PI_EXTENSION_SMOKE_RPC_TIMEOUT_MS, DEFAULT_RPC_TIMEOUT_MS);
        console.log(`SMOKE START mode=rpc extension=${extensionFile} timeoutMs=${timeoutMs}`);
        try {
          const result = await runRpcProbe(extensionFile, { cwd, env, timeoutMs });
          console.log(`SMOKE PASS mode=rpc extension=${extensionFile} durationMs=${result.durationMs} commands=${result.commandCount}`);
        } catch (error) {
          printProbeFailure(error);
          process.exitCode = 1;
          return;
        }
      }
      console.log(`SMOKE SUMMARY mode=rpc probes=${entries.length} durationMs=${Date.now() - suiteStarted}`);
    }

    if (mode === "model" || mode === "all") {
      const timeoutMs = positiveInt(process.env.PI_EXTENSION_SMOKE_MODEL_TIMEOUT_MS, DEFAULT_MODEL_TIMEOUT_MS);
      const modelCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-headless-smoke-"));
      console.log(`SMOKE START mode=model extension=full-fleet timeoutMs=${timeoutMs}`);
      try {
        const result = await runModelProbe({ cwd: modelCwd, env, timeoutMs });
        console.log(`SMOKE PASS mode=model extension=full-fleet durationMs=${result.durationMs}`);
      } catch (error) {
        printProbeFailure(error);
        process.exitCode = 1;
        return;
      } finally {
        try { fs.rmSync(modelCwd, { recursive: true, force: true }); } catch {}
      }
    }
  } finally {
    try { fs.rmSync(traceDir, { recursive: true, force: true }); } catch {}
  }
}

if (require.main === module) {
  main().catch((error) => {
    printProbeFailure(error);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_RPC_TIMEOUT_MS,
  DEFAULT_MODEL_TIMEOUT_MS,
  DEFAULT_KILL_GRACE_MS,
  QUALIFICATION_MAX_BUFFER,
  qualifyJsonCapture,
  extensionSmokeEnv,
  discoverExtensionEntries,
  runProcessGroup,
  parseJsonLines,
  runRpcProbe,
  runModelProbe,
};
