"use strict";

// Structural shell policy. Raw command strings are tokenized into simple
// commands so a dangerous word inside a quoted argument or heredoc does not
// trigger a denial, while executed binaries, nested shells, command
// substitutions, and redirects still do.

const path = require("node:path");

const DEFAULT_DENY_SHELL = [
  /\brm\s+-[^\n]*r[f]?\b|\brm\s+-[^\n]*f[^\n]*r\b|\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\b(?:curl|wget)\b[^\n]*(?:\||>)/i,
  /\b(?:chmod|chown)\s+-R\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
];
const DEFAULT_WARN_SHELL = [
  /\b(?:npm|pnpm|yarn)\s+(?:install|add)\b/i,
  /\bpip\s+install\b/i,
  /\bbrew\s+install\b/i,
  /\bapt(?:-get)?\s+install\b/i,
];

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "nice", "stdbuf", "timeout"]);
const MAX_NESTING = 6;

function emptyCommand(start) {
  return { argv: [], redirects: [], substitutions: [], start, incomplete: false };
}

function skipSingle(text, index) {
  const end = text.indexOf("'", index);
  return end < 0 ? text.length : end + 1;
}

function skipDouble(text, index) {
  let i = index;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === '"') return i + 1;
    i++;
  }
  return text.length;
}

function captureParenthesis(text, index) {
  let depth = 1;
  let i = index;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "'") { i = skipSingle(text, i + 1); continue; }
    if (ch === '"') { i = skipDouble(text, i + 1); continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (!depth) return { inner: text.slice(index, i), end: i + 1, complete: true }; }
    i++;
  }
  return { inner: text.slice(index), end: text.length, complete: false };
}

function captureBacktick(text, index) {
  let i = index;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === "`") return { inner: text.slice(index, i), end: i + 1, complete: true };
    i++;
  }
  return { inner: text.slice(index), end: text.length, complete: false };
}

function parseShellCommands(command) {
  const text = String(command || "");
  const commands = [];
  let current = emptyCommand(0);
  let token = "";
  let tokenStarted = false;
  let quote = null;
  let pending = null;
  let operatorBefore = null;
  let heredocs = [];
  let complete = true;
  let i = 0;

  function resetToken() { token = ""; tokenStarted = false; }
  function pushToken() {
    if (!tokenStarted) return;
    if (pending) {
      const redirect = { op: pending.op, fd: pending.fd, target: token };
      current.redirects.push(redirect);
      if (redirect.op === "<<" || redirect.op === "<<-") heredocs.push({ delimiter: token, stripTabs: redirect.op === "<<-" });
      pending = null;
    } else {
      current.argv.push(token);
    }
    resetToken();
  }
  function endCommand(op) {
    pushToken();
    if (pending) { current.incomplete = true; complete = false; pending = null; }
    if (current.argv.length || current.redirects.length || current.substitutions.length) {
      commands.push({ argv: current.argv, redirects: current.redirects, substitutions: current.substitutions, operatorBefore, text: text.slice(current.start, i).trim(), incomplete: current.incomplete });
    }
    current = emptyCommand(i);
    operatorBefore = op;
  }
  function skipHeredocs() {
    for (const doc of heredocs) {
      while (i <= text.length) {
        let lineEnd = text.indexOf("\n", i);
        if (lineEnd < 0) lineEnd = text.length;
        let line = text.slice(i, lineEnd);
        if (doc.stripTabs) line = line.replace(/^\t+/, "");
        i = lineEnd < text.length ? lineEnd + 1 : lineEnd;
        if (line === doc.delimiter || lineEnd >= text.length) break;
      }
    }
    heredocs = [];
  }
  function appendSubstitution(inner, isComplete) {
    token += inner;
    tokenStarted = true;
    current.substitutions.push(inner);
    if (!isComplete) { complete = false; current.incomplete = true; }
  }

  while (i < text.length) {
    const ch = text[i];

    if (quote === "'") {
      if (ch === "'") quote = null;
      else { token += ch; tokenStarted = true; }
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        const next = text[i + 1];
        if (next === "\n") { i += 2; continue; }
        if (next === '"' || next === "\\" || next === "$" || next === "`") { token += next; tokenStarted = true; i += 2; continue; }
        token += ch; tokenStarted = true; i++; continue;
      }
      if (ch === '"') { quote = null; i++; continue; }
      if (ch === "$" && text[i + 1] === "(") {
        const captured = captureParenthesis(text, i + 2);
        appendSubstitution(captured.inner, captured.complete);
        i = captured.end;
        continue;
      }
      if (ch === "`") {
        const captured = captureBacktick(text, i + 1);
        appendSubstitution(captured.inner, captured.complete);
        i = captured.end;
        continue;
      }
      token += ch; tokenStarted = true; i++;
      continue;
    }

    if (ch === "'" || ch === '"') { quote = ch; tokenStarted = true; i++; continue; }
    if (ch === "\\") {
      if (text[i + 1] === "\n") { i += 2; continue; }
      if (i + 1 < text.length) { token += text[i + 1]; tokenStarted = true; i += 2; continue; }
      i++; continue;
    }
    if (ch === "$" && text[i + 1] === "(") {
      const captured = captureParenthesis(text, i + 2);
      appendSubstitution(captured.inner, captured.complete);
      i = captured.end;
      continue;
    }
    if (ch === "`") {
      const captured = captureBacktick(text, i + 1);
      appendSubstitution(captured.inner, captured.complete);
      i = captured.end;
      continue;
    }
    if (ch === "#" && !tokenStarted) {
      const lineEnd = text.indexOf("\n", i);
      i = lineEnd < 0 ? text.length : lineEnd;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") { pushToken(); i++; continue; }
    if (ch === "\n") {
      endCommand("\n");
      if (heredocs.length) skipHeredocs();
      else i++;
      continue;
    }
    if (ch === ";") { endCommand(";"); i++; continue; }
    if (ch === "&") {
      if (text[i + 1] === "&") { endCommand("&&"); i += 2; continue; }
      if (text[i + 1] === ">") {
        pushToken();
        const op = text[i + 2] === ">" ? "&>>" : "&>";
        pending = { op, fd: null };
        i += op.length;
        continue;
      }
      endCommand("&"); i++; continue;
    }
    if (ch === "|") {
      if (text[i + 1] === "|") { endCommand("||"); i += 2; continue; }
      endCommand("|"); i++; continue;
    }
    if ((ch === "<" || ch === ">") && text[i + 1] === "(") {
      const captured = captureParenthesis(text, i + 2);
      appendSubstitution(captured.inner, captured.complete);
      i = captured.end;
      continue;
    }
    if (ch === ">" || ch === "<") {
      let fd = null;
      if (tokenStarted && /^\d+$/.test(token)) { fd = Number(token); resetToken(); }
      else pushToken();
      let op;
      if (ch === ">" && text[i + 1] === ">") op = ">>";
      else if (ch === ">" && text[i + 1] === "|") op = ">|";
      else if (ch === "<" && text[i + 1] === "<") op = text[i + 2] === "-" ? "<<-" : "<<";
      else if (text[i + 1] === "&") op = ch === ">" ? ">&" : "<&";
      else op = ch;
      pending = { op: op === ">&" || op === "<&" ? "dup" : op, fd };
      i += (op === "<<-" ? 3 : op === ">>" || op === "<<" || op === ">|" || op === ">&" || op === "<&" ? 2 : 1);
      continue;
    }
    token += ch; tokenStarted = true; i++;
  }

  if (quote) { complete = false; current.incomplete = true; }
  if (pending) { complete = false; current.incomplete = true; }
  endCommand(null);
  return { commands, complete };
}

function optionArgs(args) {
  const end = args.indexOf("--");
  return end >= 0 ? args.slice(0, end) : args;
}
function hasRecursiveFlag(args) {
  return optionArgs(args).some((arg) => arg === "--recursive" || (/^-[A-Za-z]+$/.test(arg) && arg.includes("r")) || (/^-[A-Za-z]+$/.test(arg) && arg.includes("R")));
}
function hasRecursiveUpper(args) {
  return optionArgs(args).some((arg) => arg === "--recursive" || (/^-[A-Za-z]+$/.test(arg) && arg.includes("R")));
}
function packageInstallWarning(bin, args) {
  if (["npm", "pnpm", "yarn"].includes(bin) && ["install", "add"].includes(args[0])) return true;
  if (bin === "pip" && args[0] === "install") return true;
  if (bin === "brew" && args[0] === "install") return true;
  if (["apt", "apt-get"].includes(bin) && args[0] === "install") return true;
  return false;
}
function isDeniedPath(target, cwd, denyPathPrefixes) {
  if (typeof target !== "string" || !target || target === "-") return null;
  if (/^&?\d+$/.test(target)) return null;
  const normalized = target === "~" ? (process.env.HOME || target) : target.startsWith("~/") && process.env.HOME ? path.join(process.env.HOME, target.slice(2)) : target;
  const absolute = path.resolve(cwd, normalized);
  for (const prefix of denyPathPrefixes || []) {
    const homeExpanded = prefix === "~" ? (process.env.HOME || prefix) : prefix.startsWith("~/") && process.env.HOME ? path.join(process.env.HOME, prefix.slice(2)) : prefix;
    const root = path.resolve(homeExpanded);
    const relative = path.relative(root, absolute);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return prefix;
  }
  return null;
}

function nestedCommands(command, depth) {
  const nested = [];
  if (depth >= MAX_NESTING) return nested;
  for (const substitution of command.substitutions) {
    nested.push(...parseShellCommands(substitution).commands);
  }
  const argv = command.argv;
  const bin = path.basename(argv[0] || "");
  if (SHELLS.has(bin)) {
    let cIndex = -1;
    for (let index = 1; index < argv.length; index++) {
      if (argv[index] === "--") break;
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(argv[index])) { cIndex = index; break; }
    }
    if (cIndex >= 0 && argv[cIndex + 1]) nested.push(...parseShellCommands(argv[cIndex + 1]).commands);
  }
  if (bin === "eval") nested.push(...parseShellCommands(argv.slice(1).join(" ")).commands);
  if (bin === "xargs") {
    const start = argv.findIndex((arg, index) => index > 0 && !arg.startsWith("-"));
    if (start > 0) nested.push(...parseShellCommands(argv.slice(start).join(" ")).commands);
  }
  if (bin === "find") {
    for (let index = 0; index < argv.length; index++) {
      if (argv[index] !== "-exec" && argv[index] !== "-execdir") continue;
      const end = argv.findIndex((arg, next) => next > index && (arg === "+" || arg === ";"));
      const slice = argv.slice(index + 1, end < 0 ? argv.length : end);
      if (slice.length) nested.push(...parseShellCommands(slice.join(" ")).commands);
    }
  }
  if (WRAPPERS.has(bin)) {
    let index = 1;
    while (index < argv.length) {
      const arg = argv[index];
      if (arg === "--") { index++; continue; }
      if (bin === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { index++; continue; }
      if (bin === "env" && ["-u", "--unset", "-C", "--chdir"].includes(arg)) { index += 2; continue; }
      if (bin === "timeout" && ["-s", "-k"].includes(arg)) { index += 2; continue; }
      if (bin === "timeout" && /^\d+(?:\.\d+)?[smhd]?$/.test(arg)) { index++; continue; }
      if (bin === "exec" && arg === "-a") { index += 2; continue; }
      if (bin === "nice" && arg === "-n") { index += 2; continue; }
      if (arg.startsWith("-")) { index++; continue; }
      break;
    }
    if (index < argv.length) nested.push(...parseShellCommands(argv.slice(index).join(" ")).commands);
  }
  return nested;
}

function collectCommands(parsed) {
  const all = [];
  const queue = parsed.commands.map((command) => ({ command, depth: 0 }));
  while (queue.length) {
    const { command, depth } = queue.shift();
    all.push(command);
    for (const nested of nestedCommands(command, depth)) queue.push({ command: nested, depth: depth + 1 });
  }
  return all;
}

function compilePolicyPattern(pattern) {
  if (pattern instanceof RegExp) return pattern;
  if (pattern && typeof pattern === "object" && typeof pattern.source === "string") return new RegExp(pattern.source, pattern.flags || "");
  const text = String(pattern);
  const delimited = /^\/(.*)\/([a-z]*)$/s.exec(text);
  return delimited ? new RegExp(delimited[1], delimited[2]) : new RegExp(text);
}

function evaluateShellCommand(command, { cwd = process.cwd(), denyPathPrefixes = [], customDenyShell = [], customWarnShell = [] } = {}) {
  const parsed = parseShellCommands(command);
  const commands = collectCommands(parsed);
  const denials = [];
  const warnings = [];
  const seen = new Set();
  const deny = (code, reason) => { const key = `${code}:${reason}`; if (!seen.has(key)) { seen.add(key); denials.push({ code, reason }); } };
  const warn = (reason) => { const key = `warn:${reason}`; if (!seen.has(key)) { seen.add(key); warnings.push({ reason }); } };

  for (let index = 0; index < commands.length; index++) {
    const item = commands[index];
    const argv = item.argv;
    if (!argv.length) continue;
    const bin = path.basename(argv[0]);
    const args = argv.slice(1);
    if (bin === "sudo") deny("denied-shell", "denied shell binary: sudo");
    if (bin === "rm" && hasRecursiveFlag(args)) deny("denied-shell", "denied recursive rm");
    if (["chmod", "chown"].includes(bin) && hasRecursiveUpper(args)) deny("denied-shell", `denied recursive ${bin}`);
    if (bin === "mkfs" || bin.startsWith("mkfs.")) deny("denied-shell", "denied filesystem creation binary");
    if (bin === "dd" && args.some((arg) => arg.startsWith("if="))) deny("denied-shell", "denied raw disk copy");
    if (["curl", "wget"].includes(bin)) {
      const piped = commands[index + 1]?.operatorBefore === "|";
      if (piped || item.redirects.length) deny("denied-shell", `denied ${bin} pipeline/redirect`);
    }
    if (packageInstallWarning(bin, args)) warn(`approval recommended for package/install command: ${bin} ${args[0]}`);
    for (const redirect of item.redirects) {
      if (redirect.op === "dup") continue;
      const prefix = isDeniedPath(redirect.target, cwd, denyPathPrefixes);
      if (prefix) deny("denied-path", `denied redirect target prefix: ${prefix}`);
    }
  }

  for (const pattern of customDenyShell || []) {
    let regex;
    try { regex = compilePolicyPattern(pattern); } catch { continue; }
    for (const item of commands) if (regex.test(item.text || item.argv.join(" "))) deny("denied-shell", `deny shell pattern: ${String(pattern)}`);
  }
  for (const pattern of customWarnShell || []) {
    let regex;
    try { regex = compilePolicyPattern(pattern); } catch { continue; }
    for (const item of commands) if (regex.test(item.text || item.argv.join(" "))) warn(`approval recommended for package/install command: ${String(pattern)}`);
  }

  if (!parsed.complete) warn("shell command could not be parsed completely; policy applied to the parsed prefix");

  return { ok: denials.length === 0, complete: parsed.complete, commands, denials, warnings };
}

module.exports = { DEFAULT_DENY_SHELL, DEFAULT_WARN_SHELL, parseShellCommands, evaluateShellCommand };
