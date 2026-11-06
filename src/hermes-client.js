"use strict";

// Single low-level Hermes CLI client. Active harness consumers call it only
// through src/hermes-advisory.js, which owns typed/privacy-safe operations.
// Keep subprocess timeout, environment, and process-group handling here.

const { spawn } = require("node:child_process");

const HERMES_DEFAULT_TIMEOUT_MS = 60_000;
const HERMES_DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;
const HERMES_DEFAULT_KILL_GRACE_MS = 5_000;

function hermesEnv(env = process.env) {
  return { ...env, HERMES_ACCEPT_HOOKS: env.HERMES_ACCEPT_HOOKS || "1" };
}

const HERMES_SENSITIVE_VALUE_FLAGS = new Set(["--query", "-q", "--oneshot", "-z", "--api-key", "--token", "--password", "--provider", "--model"]);

function redactHermesArgs(args = []) {
  const redacted = [];
  let redactNext = false;
  for (const raw of args) {
    const value = String(raw);
    if (redactNext) {
      redacted.push(`[REDACTED:${value.length} chars]`);
      redactNext = false;
      continue;
    }
    const assignment = value.match(/^(--(?:query|oneshot|api-key|token|password|provider|model))=(.*)$/s);
    if (assignment) {
      redacted.push(`${assignment[1]}=[REDACTED:${assignment[2].length} chars]`);
      continue;
    }
    redacted.push(value);
    if (HERMES_SENSITIVE_VALUE_FLAGS.has(value)) redactNext = true;
  }
  return redacted;
}

function formatHermesCommand(bin, args = []) {
  return [String(bin || "hermes"), ...redactHermesArgs(args)].join(" ");
}

async function runHermes(args, options = {}) {
  const {
    bin = process.env.PI_HERMES_BIN || "hermes",
    cwd,
    timeoutMs = HERMES_DEFAULT_TIMEOUT_MS,
    maxBuffer = HERMES_DEFAULT_MAX_BUFFER,
    signal,
    env,
    unref = false,
    combineStderr = true,
    killGraceMs = HERMES_DEFAULT_KILL_GRACE_MS,
  } = options;
  // Built on spawn, not execFile: execFile silently drops the `detached`
  // option, so its timeout SIGTERM was advisory - a hermes that ignored it
  // mid-LLM-call ran to completion and RESOLVED as success 30+ minutes later,
  // and grandchildren inheriting the stdio pipes could keep the promise
  // pending forever. Both kept headless pi -p processes alive long after
  // their turn ended (the dogfooded 20-90 minute hang). detached gives the
  // child its own process group; an enabled deadline SIGKILLs that whole group
  // and destroys the pipes by timeoutMs + killGraceMs. timeoutMs: 0 disables
  // deadline timers; explicit abort and output limits still kill the group.
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error(`aborted before start: ${bin}`), { killed: true }));
      return;
    }
    let child;
    try {
      // Abort handling is ours, not spawn's: spawn's internal abort listener
      // SIGTERMs only the direct child and emits 'error' synchronously during
      // the abort dispatch, which would settle us and skip the group kill.
      child = spawn(bin, args, { cwd, env: hermesEnv(env), detached: true });
    } catch (error) {
      reject(error);
      return;
    }
    if (unref) child.unref?.();
    // Hermes must never wait on stdin; some subcommands block until EOF.
    child.stdin?.end();

    let out = "";
    let err = "";
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let aborted = false;
    const timers = [];
    const clearTimers = () => { for (const timer of timers) clearTimeout(timer); };
    const commandLine = formatHermesCommand(bin, args);

    const killGroup = (sig) => {
      if (child.pid) {
        try { process.kill(-child.pid, sig); } catch { /* group already gone */ }
      }
      try { child.kill(sig); } catch { /* already gone */ }
    };
    const destroyPipes = () => {
      try { child.stdout?.destroy(); } catch { /* already closed */ }
      try { child.stderr?.destroy(); } catch { /* already closed */ }
    };
    // An aborted call must die like a deadline: group-kill so grandchildren
    // cannot outlive the abort and wedge the pipes.
    const onAbort = () => { aborted = true; killGroup("SIGKILL"); destroyPipes(); };
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimers();
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const failure = (message, extra = {}) =>
      Object.assign(new Error(`${message}: ${commandLine.slice(0, 300)}`), { stdout: out, stderr: err, ...extra });

    const armTimer = (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      timers.push(timer);
    };
    if (timeoutMs !== 0) {
      armTimer(() => { timedOut = true; killGroup("SIGTERM"); }, timeoutMs);
      armTimer(() => { timedOut = true; killGroup("SIGKILL"); destroyPipes(); }, timeoutMs + Math.max(0, killGraceMs));
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });

    const collect = (setter) => (chunk) => {
      const updated = setter(chunk);
      if (updated > maxBuffer && !overflow) {
        overflow = true;
        killGroup("SIGKILL");
        destroyPipes();
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", collect((chunk) => (out += chunk).length));
    child.stderr?.on("data", collect((chunk) => (err += chunk).length));

    child.on("error", (error) => settle(Object.assign(error, { stdout: out, stderr: err })));
    child.on("exit", () => {
      // The process result is known; pipes normally close right after. If a
      // grandchild inherited them, force-close after a short flush window
      // instead of wedging until the deadline.
      armTimer(destroyPipes, Math.min(1_000, Math.max(0, killGraceMs)));
    });
    child.on("close", (code, sig) => {
      if (aborted) settle(failure("aborted", { code, signal: sig, killed: true }));
      else if (overflow) settle(failure("maxBuffer exceeded", { code, signal: sig, killed: true }));
      else if (timedOut) settle(failure(`timed out after ${timeoutMs}ms`, { code, signal: sig, killed: true }));
      else if (code === 0) settle(null, { stdout: out, stderr: err });
      else settle(failure("Command failed", { code, signal: sig, killed: Boolean(sig) }));
    });
  });
  return [stdout, combineStderr ? stderr : ""].filter(Boolean).join("\n").trim();
}

module.exports = {
  HERMES_DEFAULT_TIMEOUT_MS,
  HERMES_DEFAULT_MAX_BUFFER,
  hermesEnv,
  redactHermesArgs,
  formatHermesCommand,
  runHermes,
};
