"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { readChangeSet } = require("./code-context-revision.js");
const { normalizeTestResult } = require("./test-result-normalizer.js");
const { isTestPath: centralizedTestPath, testCommandsForPaths } = require("./test-paths.js");
const { buildImportGraph, affectedTestFiles } = require("./test-selection.js");
const { normalizeOperation, normalizeStringList } = require("./extension-args.js");
const { withNodeTestCoverage } = require("./node-test-coverage.js");

const TEST_RUNNER_OPERATIONS = ["status", "listProfiles", "infer", "run", "rerunFailures"];
const TEST_RUNNER_PROFILES = ["quick", "changed", "full", "live", "unit", "integration", "lint", "typecheck"];
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const STATE_DIR = path.join(".pi", "test-runner");
// .worktrees holds linked checkouts of the same repository on other branches;
// walking them would select another tree's tests. A walk started inside a
// worktree still covers that worktree because its root is never name-checked.
const DEFAULT_IGNORE = new Set([".git", ".claude", ".worktrees", "node_modules", ".pi", "dist", "build", "coverage", ".next", "target", "vendor", "__pycache__", ".venv", "venv"]);

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
function configFromEnv(env = process.env, overrides = {}) {
  return {
    enabled: env.PI_TEST_RUNNER !== "0",
    timeoutMs: clampNumber(Number(overrides.timeoutMs || env.PI_TEST_RUNNER_TIMEOUT_MS || 120000), 1000, 30 * 60 * 1000),
    // The deterministic suite alone measured 267s on this repo; a 120s default
    // made the full profile unreachable. Live probes are slower and opt-in.
    fullTimeoutMs: clampNumber(Number(overrides.fullTimeoutMs || env.PI_TEST_RUNNER_FULL_TIMEOUT_MS || 20 * 60 * 1000), 1000, 60 * 60 * 1000),
    liveTimeoutMs: clampNumber(Number(overrides.liveTimeoutMs || env.PI_TEST_RUNNER_LIVE_TIMEOUT_MS || 45 * 60 * 1000), 1000, 60 * 60 * 1000),
    maxBuffer: clampNumber(Number(overrides.maxBuffer || env.PI_TEST_RUNNER_MAX_BUFFER || 20 * 1024 * 1024), 1024 * 1024, 250 * 1024 * 1024),
    outputMaxLines: clampNumber(Number(overrides.outputMaxLines || env.PI_TEST_RUNNER_MAX_LINES || DEFAULT_MAX_LINES), 1, DEFAULT_MAX_LINES),
    outputMaxBytes: clampNumber(Number(overrides.outputMaxBytes || env.PI_TEST_RUNNER_MAX_BYTES || DEFAULT_MAX_BYTES), 1024, DEFAULT_MAX_BYTES),
    maxCommands: clampNumber(Number(overrides.maxCommands || env.PI_TEST_RUNNER_MAX_COMMANDS || 20), 1, 200),
    maxFiles: clampNumber(Number(overrides.maxFiles || env.PI_TEST_RUNNER_MAX_FILES || 2500), 1, 20000),
    allowCustom: overrides.allowCustom != null ? Boolean(overrides.allowCustom) : env.PI_TEST_RUNNER_ALLOW_CUSTOM === "1",
  };
}
function normalizeTestRunnerParams(params = {}) {
  const nested = params?.input && typeof params.input === "object" && !Array.isArray(params.input) ? params.input : {};
  const merged = { ...nested, ...(params || {}) };
  const normalized = {
    ...merged,
    operation: normalizeOperation(merged.operation, {
      toolName: "test_runner",
      defaultOperation: "infer",
      operations: TEST_RUNNER_OPERATIONS,
      aliases: { profiles: "listProfiles", list: "listProfiles", rerun: "rerunFailures" },
    }),
  };
  if (merged.profile != null) {
    normalized.profile = normalizeOperation(merged.profile, {
      toolName: "test_runner profile",
      operations: TEST_RUNNER_PROFILES,
      aliases: { focused: "changed", all: "full", tests: "unit" },
    });
  }
  if (merged.files != null) normalized.files = normalizeStringList(merged.files, "test_runner files");
  return normalized;
}
function stripAt(value) {
  const text = String(value || "").trim();
  return text.startsWith("@") ? text.slice(1) : text;
}
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
function resolveProjectPath(ctx, inputPath) {
  const raw = stripAt(inputPath) || ".";
  const cwd = path.resolve(ctx.cwd || process.cwd());
  const absolute = path.resolve(cwd, raw);
  if (!isInside(cwd, absolute)) throw new Error(`test_runner project path must stay inside cwd (${cwd}).`);
  return absolute;
}
function normalizeProjectFile(projectPath, file) {
  const raw = stripAt(file);
  if (!raw) throw new Error("test_runner file path must not be empty");
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectPath, raw);
  if (!isInside(projectPath, absolute)) throw new Error(`test_runner file must stay inside project path: ${file}`);
  return path.relative(projectPath, absolute).replace(/\\/g, "/");
}
function stripAnsi(text) { return String(text || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, ""); }
function formatSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}
function truncateTail(text, options = {}) {
  const maxLines = options.maxLines || DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const value = String(text || "");
  const lines = value.split(/\r?\n/);
  const totalBytes = Buffer.byteLength(value, "utf8");
  const out = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength((out.length ? "\n" : "") + line, "utf8");
    if (out.length >= maxLines || (out.length && bytes + lineBytes > maxBytes)) break;
    if (!out.length && lineBytes > maxBytes) {
      let acc = "";
      for (let j = line.length - 1; j >= 0; j--) {
        const next = line[j] + acc;
        if (Buffer.byteLength(next, "utf8") > maxBytes) break;
        acc = next;
      }
      out.push(acc);
      bytes = Buffer.byteLength(acc, "utf8");
      break;
    }
    out.push(line);
    bytes += lineBytes;
  }
  out.reverse();
  return { content: out.join("\n"), truncated: out.length < lines.length || bytes < totalBytes, outputLines: out.length, totalLines: lines.length, outputBytes: bytes, totalBytes };
}
function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex"); }
function shellQuote(arg) {
  const text = String(arg);
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}
function commandText(command, args = []) { return [command, ...(args || [])].map(shellQuote).join(" "); }
function fileExists(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function dirExists(file) { try { return fs.statSync(file).isDirectory(); } catch { return false; } }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function writeJson(file, data) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); }
function stateRoot(cwd) { const root = path.join(cwd, STATE_DIR); ensureDir(root); return root; }
function latestFile(cwd) { return path.join(stateRoot(cwd), "latest.json"); }
function executableInfo(bin, env = process.env) {
  const candidates = String(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return { bin, found: true, path: candidate }; } catch {}
  }
  return { bin, found: false, path: null };
}
function envReport(env = process.env) {
  return {
    PI_TEST_RUNNER: env.PI_TEST_RUNNER ?? null,
    PI_TEST_RUNNER_TIMEOUT_MS: env.PI_TEST_RUNNER_TIMEOUT_MS ?? null,
    PI_TEST_RUNNER_MAX_BUFFER: env.PI_TEST_RUNNER_MAX_BUFFER ?? null,
    PI_TEST_RUNNER_MAX_LINES: env.PI_TEST_RUNNER_MAX_LINES ?? null,
    PI_TEST_RUNNER_MAX_BYTES: env.PI_TEST_RUNNER_MAX_BYTES ?? null,
    PI_TEST_RUNNER_MAX_COMMANDS: env.PI_TEST_RUNNER_MAX_COMMANDS ?? null,
    PI_TEST_RUNNER_ALLOW_CUSTOM: env.PI_TEST_RUNNER_ALLOW_CUSTOM ?? null,
  };
}
function walkFiles(cwd, options = {}) {
  const out = [];
  const maxFiles = options.maxFiles || configFromEnv().maxFiles;
  const ignore = new Set([...(options.ignore || []), ...DEFAULT_IGNORE]);
  function walk(relDir) {
    if (out.length >= maxFiles) return;
    let names = [];
    try { names = fs.readdirSync(path.join(cwd, relDir)); } catch { return; }
    for (const name of names) {
      if (ignore.has(name)) continue;
      const rel = relDir ? `${relDir}/${name}` : name;
      const full = path.join(cwd, rel);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(rel);
      else if (st.isFile()) out.push({ path: rel, bytes: st.size, ext: path.extname(name).toLowerCase() });
      if (out.length >= maxFiles) break;
    }
  }
  walk("");
  return out;
}
function isTestPath(file) { return centralizedTestPath(file); }
function gitChangedFiles(cwd) {
  return readChangeSet(cwd).changedPaths;
}
function packageScripts(cwd) { return readJson(path.join(cwd, "package.json"), {}).scripts || {}; }
function spec(id, label, command, args, reason, profile = "quick", kind = "test", files = []) {
  return { id, label, command, args, commandLine: commandText(command, args), reason, profile, kind, files };
}
function directTestCommands(cwd, files, profile = "changed") {
  return testCommandsForPaths(files).filter((command) => command.command !== "pytest" || executableInfo("pytest").found).map((command) => spec(command.id, command.label, command.command, command.args, "direct changed test", profile, command.kind, command.files));
}
const MAX_QUICK_TEST_FILES = 5;
const MAX_UNIT_TEST_FILES = 50;

function profileTimeoutMs(profile, config = {}, params = {}) {
  const explicit = Number(params.timeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (profile === "full") return config.fullTimeoutMs || config.timeoutMs;
  if (profile === "live") return config.liveTimeoutMs || config.timeoutMs;
  return config.timeoutMs;
}

function selectionReason(selection, test) {
  if (selection.direct.includes(test)) return "changed test file";
  if (selection.importGraph.includes(test)) return "imports changed file";
  if (selection.lexical.includes(test)) return "lexically related";
  return "affected test";
}

function inferCommands(cwd, params = {}) {
  params = normalizeTestRunnerParams(params);
  const config = configFromEnv(process.env, params);
  const files = walkFiles(cwd, { maxFiles: config.maxFiles });
  const tests = files.filter((f) => isTestPath(f.path));
  const scripts = packageScripts(cwd);
  const profiles = { quick: [], changed: [], full: [], live: [], unit: [], integration: [], lint: [], typecheck: [] };

  if (scripts.test) profiles.quick.push(spec("npm:test", "npm test", "npm", ["test"], "package.json test script", "quick", "unit"));
  if (scripts["check:static"]) profiles.quick.push(spec("npm:check-static", "npm run check:static", "npm", ["run", "check:static"], "package.json static gate script", "quick", "lint"));
  if (scripts.lint) profiles.lint.push(spec("npm:lint", "npm run lint", "npm", ["run", "lint"], "package.json lint script", "lint", "lint"));
  if (scripts.typecheck) profiles.typecheck.push(spec("npm:typecheck", "npm run typecheck", "npm", ["run", "typecheck"], "package.json typecheck script", "typecheck", "compile"));
  if (scripts.test) profiles.unit.push(spec("npm:test", "npm test", "npm", ["test"], "package.json test script", "unit", "unit"));

  if (fileExists(path.join(cwd, "scripts", "check-integration-boundary.sh"))) profiles.quick.push(spec("script:check-integration-boundary", "check integration boundary", "bash", ["scripts/check-integration-boundary.sh"], "repo quick integration script", "quick", "integration"));
  if (fileExists(path.join(cwd, "scripts", "check-all.sh"))) profiles.full.push(spec("script:check-all", "deterministic full suite", "bash", ["scripts/check-all.sh"], "repo deterministic verification script", "full", "integration"));
  if (fileExists(path.join(cwd, "scripts", "check-live.sh"))) profiles.live.push(spec("script:check-live", "live provider and TUI checks", "bash", ["scripts/check-live.sh"], "repo live verification script (requires configured providers)", "live", "integration"));

  const nodeTests = tests.filter((t) => /\.test\.js$/.test(t.path));
  for (const test of nodeTests.slice(0, MAX_QUICK_TEST_FILES)) profiles.quick.push(spec(`node:${test.path}`, `node ${test.path}`, "node", [test.path], "discovered node test", "quick", "unit", [test.path]));
  for (const test of nodeTests.slice(0, MAX_UNIT_TEST_FILES)) profiles.unit.push(spec(`node:${test.path}`, `node ${test.path}`, "node", [test.path], "discovered node test", "unit", "unit", [test.path]));

  if (fileExists(path.join(cwd, "pyproject.toml")) || fileExists(path.join(cwd, "pytest.ini")) || dirExists(path.join(cwd, "tests"))) {
    if (tests.some((t) => /\.py$/.test(t.path)) && executableInfo("pytest").found) profiles.quick.push(spec("pytest", "pytest -q", "pytest", ["-q"], "python test discovery", "quick", "unit"));
  }
  if (fileExists(path.join(cwd, "go.mod")) && executableInfo("go").found) profiles.quick.push(spec("go:test", "go test ./...", "go", ["test", "./..."], "go module tests", "quick", "unit"));
  if (fileExists(path.join(cwd, "Cargo.toml")) && executableInfo("cargo").found) profiles.quick.push(spec("cargo:test", "cargo test", "cargo", ["test"], "cargo tests", "quick", "unit"));

  const changed = params.files?.length ? params.files.map((f) => normalizeProjectFile(cwd, f)) : gitChangedFiles(cwd);
  const testPaths = tests.map((t) => t.path);
  const graph = buildImportGraph(cwd, { maxFiles: config.maxFiles });
  const selection = affectedTestFiles({ cwd, changedFiles: changed, testFiles: testPaths, graph: graph.graph });
  selection.graph = { files: graph.graph.size, complete: graph.complete, truncated: graph.truncated };
  profiles.changed.push(...directTestCommands(cwd, changed, "changed"));
  for (const related of selection.testFiles) {
    if (/\.test\.js$/.test(related)) profiles.changed.push(spec(`node:${related}`, `node ${related}`, "node", [related], selectionReason(selection, related), "changed", "unit", [related]));
    else if (/\.py$/.test(related) && executableInfo("pytest").found) profiles.changed.push(spec(`pytest:${related}`, `pytest ${related}`, "pytest", ["-q", related], selectionReason(selection, related), "changed", "unit", [related]));
  }
  // No fallback to arbitrary quick commands: an unrelated green test is not
  // verification of the change. selectCommands reports the empty selection.
  if (!profiles.quick.length && nodeTests.length) profiles.quick.push(...profiles.unit.slice(0, 3).map((s) => ({ ...s, profile: "quick" })));

  for (const key of Object.keys(profiles)) profiles[key] = dedupeSpecs(profiles[key]);
  const selectionSummary = {
    ...selection,
    quickCap: MAX_QUICK_TEST_FILES,
    unitCap: MAX_UNIT_TEST_FILES,
    maxCommands: config.maxCommands,
    truncatedProfiles: {
      quick: nodeTests.length > MAX_QUICK_TEST_FILES,
      unit: nodeTests.length > MAX_UNIT_TEST_FILES,
      changed: profiles.changed.length > config.maxCommands,
    },
  };
  return { generatedAt: new Date().toISOString(), cwd, changedFiles: changed, testFiles: testPaths.slice(0, 500), scripts, profiles, selection: selectionSummary, summary: Object.fromEntries(Object.entries(profiles).map(([k, v]) => [k, v.length])) };
}
function dedupeSpecs(specs) {
  const seen = new Set();
  const out = [];
  for (const s of specs) {
    const key = s.commandLine;
    if (!seen.has(key)) { seen.add(key); out.push(s); }
  }
  return out;
}
function selectCommands(cwd, params = {}) {
  params = normalizeTestRunnerParams(params);
  const inferred = inferCommands(cwd, params);
  const profile = params.profile || "changed";
  let commands = [];
  if (params.commandId) {
    const all = Object.values(inferred.profiles).flat();
    commands = all.filter((s) => s.id === params.commandId || s.commandLine === params.commandId);
  } else if (params.command && configFromEnv(process.env, params).allowCustom) {
    const tokens = splitArgs(params.command);
    if (!tokens.length) throw new Error("custom command is empty");
    commands = [spec("custom", params.command, tokens[0], tokens.slice(1), "custom command allowed by PI_TEST_RUNNER_ALLOW_CUSTOM=1", profile, "custom")];
  } else if (params.files?.length) {
    commands = inferred.profiles.changed;
  } else {
    commands = inferred.profiles[profile] || [];
  }
  if (!commands.length && params.commandId) {
    const availableCommandIds = Array.from(new Set(Object.values(inferred.profiles).flat().map((item) => item.id))).slice(0, 12);
    return {
      inferred,
      commands: [],
      notApplicable: true,
      reasonCode: "stale-command-id",
      requestedCommandId: params.commandId,
      availableCommandIds,
      reason: `The requested commandId is not part of the current inferred profile set. Refresh with operation=infer, then select one of the returned ids${availableCommandIds.length ? `: ${availableCommandIds.join(", ")}` : "."}`,
    };
  }
  if (params.command && !configFromEnv(process.env, params).allowCustom) {
    throw new Error("test_runner custom commands are disabled. Use commandId from operation=infer, or intentionally set PI_TEST_RUNNER_ALLOW_CUSTOM=1.");
  }
  const config = configFromEnv(process.env, params);
  const selected = dedupeSpecs(commands).slice(0, config.maxCommands);
  const availableCommands = dedupeSpecs(commands).length;
  const noRelated = profile === "changed" && availableCommands === 0 && inferred.changedFiles.some((file) => !isTestPath(file));
  const liveUnavailable = profile === "live" && availableCommands === 0;
  return {
    inferred,
    commands: selected,
    availableCommands,
    selectedCommands: selected.length,
    truncated: availableCommands > selected.length,
    selection: inferred.selection,
    notApplicable: selected.length === 0,
    reasonCode: noRelated ? "no-related-test-found" : liveUnavailable ? "live-profile-unavailable" : undefined,
    suggestedProfiles: noRelated ? ["full"] : liveUnavailable ? ["full"] : undefined,
    reason: selected.length
      ? null
      : noRelated
        ? "No test file imports or names the changed files. This is not verification; run profile=full for the deterministic suite."
        : liveUnavailable
          ? "No live verification script is configured; live provider/TUI checks are opt-in."
          : `No repository-defined test commands apply to profile '${profile}'. Add a package script/repository verifier or select a command returned by operation=infer.`,
  };
}
function splitArgs(input) {
  const tokens = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  let match;
  while ((match = re.exec(input || ""))) tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(["'\\])/g, "$1"));
  return tokens;
}
function parseCliArgs(input) {
  const tokens = splitArgs(input);
  const opts = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = () => tokens[++i];
    if (token === "--profile") opts.profile = next();
    else if (token.startsWith("--profile=")) opts.profile = token.slice("--profile=".length);
    else if (token === "--path" || token === "-p") opts.path = next();
    else if (token.startsWith("--path=")) opts.path = token.slice("--path=".length);
    else if (token === "--command-id") opts.commandId = next();
    else if (token.startsWith("--command-id=")) opts.commandId = token.slice("--command-id=".length);
    else if (token === "--timeout-ms") opts.timeoutMs = Number(next());
    else if (token.startsWith("--timeout-ms=")) opts.timeoutMs = Number(token.slice("--timeout-ms=".length));
    else if (token === "--coverage") opts.coverage = true;
    else if (token === "--json") opts.json = true;
    else positional.push(token);
  }
  return { opts, positional };
}
function runCommandSpec(cwd, commandSpec, config, signal, timeoutMs) {
  return withNodeTestCoverage(cwd, commandSpec, (environment) => executeCommandSpec(cwd, commandSpec, config, signal, timeoutMs, environment), config);
}
function executeCommandSpec(cwd, commandSpec, config, signal, timeoutMs, environment) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(commandSpec.command, commandSpec.args || [], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs || config.timeoutMs,
      maxBuffer: config.maxBuffer,
      signal,
      env: { ...process.env, CI: process.env.CI || "1", NO_COLOR: "1", FORCE_COLOR: "0", ...environment },
    }, (error, stdout = "", stderr = "") => {
      const durationMs = Date.now() - startedAt;
      const output = stripAnsi(`${stdout || ""}${stderr ? `\n${stderr}` : ""}`);
      resolve({
        ...commandSpec,
        ok: !error,
        exitCode: error ? (typeof error.code === "number" ? error.code : error.status || 1) : 0,
        signal: error?.signal || null,
        durationMs,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        output,
        outputHash: sha256(output).slice(0, 16),
        failureHints: parseFailureHints(output),
        error: error ? String(error.message || error) : null,
      });
    });
  });
}
function parseFailureHints(output) {
  const lines = String(output || "").split(/\r?\n/);
  const picked = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\b(AssertionError|Error:|TypeError|ReferenceError|SyntaxError|FAIL|failed|not ok|ERR_ASSERTION)\b/i.test(lines[i])) {
      picked.push(...lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 8)));
      if (picked.length > 80) break;
    }
  }
  if (!picked.length && lines.length) picked.push(...lines.slice(-40));
  return Array.from(new Set(picked)).slice(0, 120).join("\n");
}
async function saveFullOutput(text) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-test-runner-"));
  const file = path.join(dir, "output.txt");
  await fsp.writeFile(file, text, "utf8");
  return file;
}
async function compactRunForContent(run, config) {
  const output = run.output || `${run.stdout || ""}\n${run.stderr || ""}`;
  const normalized = normalizeTestResult(run, { root: config.projectPath, maxLines: Math.min(200, config.outputMaxLines) });
  const truncation = truncateTail(normalized.output, { maxLines: config.outputMaxLines, maxBytes: config.outputMaxBytes });
  const compact = { ...run, stdout: undefined, stderr: undefined, output: truncation.content, normalized: { ...normalized, output: undefined }, fullOutputPath: normalized.outputRef?.path };
  if (truncation.truncated) compact.truncation = truncation;
  return compact;
}
function summarizeRuns(runs) {
  return { commands: runs.length, passed: runs.filter((r) => r.ok).length, failed: runs.filter((r) => !r.ok).length, durationMs: runs.reduce((n, r) => n + (r.durationMs || 0), 0), failedCommandIds: runs.filter((r) => !r.ok).map((r) => r.id) };
}
function notApplicableDetails(projectPath, operation, profile, reason, extra = {}) {
  return {
    generatedAt: new Date().toISOString(),
    projectPath,
    operation,
    profile,
    outcome: "not-applicable",
    status: "not-applicable",
    ok: null,
    notApplicable: true,
    reason,
    selected: [],
    summary: summarizeRuns([]),
    runs: [],
    ...extra,
  };
}
async function formatRunResult(details, config) {
  const lines = details.outcome === "not-applicable"
    ? [`test_runner not-applicable: ${details.reason}`]
    : [`test_runner ${details.summary.failed ? "failed" : "passed"}: ${details.summary.passed}/${details.summary.commands} command(s) passed in ${details.summary.durationMs}ms`];
  for (const run of details.runs) {
    lines.push(`${run.ok ? "PASS" : "FAIL"} ${run.commandLine} (${run.durationMs}ms)`);
    if (!run.ok && run.failureHints) lines.push(run.failureHints.split(/\r?\n/).slice(0, 40).map((l) => `  ${l}`).join("\n"));
    if (run.fullOutputPath) lines.push(`  full output: ${run.fullOutputPath}`);
    if (run.coverage) lines.push(`  coverage: ${run.coverage.status}; ${run.coverage.accepted || 0} observed source relationships; gatingSafe=${run.coverage.gatingSafe}${run.coverage.reason ? ` (${run.coverage.reason})` : ""}`);
  }
  let text = lines.join("\n");
  if (details.selection) {
    const strategies = details.selection.strategies?.length ? details.selection.strategies.join("+") : "none";
    lines.push(`selection: ${strategies}; ${details.selection.testFiles?.length ?? 0} of ${details.selection.discoveredTestFiles ?? 0} discovered test file(s) matched`);
  }
  if (details.truncated) lines.push(`truncated: selected ${details.selectedCommands} of ${details.availableCommands} available command(s); the remaining commands were not run`);
  if (details.timeoutMs) lines.push(`timeout: ${details.timeoutMs}ms`);
  text = lines.join("\n");
  const truncation = truncateTail(text, { maxLines: config.outputMaxLines, maxBytes: config.outputMaxBytes });
  text = truncation.content;
  if (truncation.truncated) {
    const file = await saveFullOutput(lines.join("\n"));
    text += `\n\n[test_runner summary truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${file}]`;
    details.truncation = { ...truncation, fullOutputPath: file };
  }
  return { content: [{ type: "text", text }], details };
}
function doctor(cwd, config = configFromEnv()) {
  const inferred = inferCommands(cwd, config);
  const risks = [];
  const recommendations = [];
  if (!Object.values(inferred.profiles).flat().length) risks.push("No test commands inferred from repo files.");
  if (!config.allowCustom) recommendations.push("Custom shell commands are disabled by default; use inferred command ids or set PI_TEST_RUNNER_ALLOW_CUSTOM=1 intentionally.");
  recommendations.push("Use test_runner operation=infer before run when selecting a focused verifier.");
  return { generatedAt: new Date().toISOString(), enabled: config.enabled, cwd, stateDir: path.join(cwd, STATE_DIR), profiles: inferred.summary, env: envReport(), risks, recommendations };
}
function createTestRunner(overrides = {}) {
  const config = configFromEnv(process.env, overrides);
  async function status(ctx, params = {}) {
    params = normalizeTestRunnerParams(params);
    const projectPath = resolveProjectPath(ctx, params.path);
    return { content: [{ type: "text", text: JSON.stringify(doctor(projectPath, { ...config, ...params }), null, 2) }], details: doctor(projectPath, { ...config, ...params }) };
  }
  async function listProfiles(ctx, params = {}) {
    params = normalizeTestRunnerParams(params);
    const projectPath = resolveProjectPath(ctx, params.path);
    const details = inferCommands(projectPath, params);
    return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
  }
  async function infer(ctx, params = {}) {
    params = normalizeTestRunnerParams(params);
    const projectPath = resolveProjectPath(ctx, params.path);
    const selected = selectCommands(projectPath, params);
    const details = selected.notApplicable
      ? notApplicableDetails(projectPath, "infer", params.profile || "changed", selected.reason, { reasonCode: selected.reasonCode || "no-applicable-command", requestedCommandId: selected.requestedCommandId, availableCommandIds: selected.availableCommandIds || [], suggestedProfiles: selected.suggestedProfiles || [], nextOperation: "infer", profiles: selected.inferred.summary, changedFiles: selected.inferred.changedFiles, selection: selected.selection, availableCommands: selected.availableCommands, selectedCommands: 0, truncated: false })
      : { generatedAt: new Date().toISOString(), projectPath, operation: "infer", profile: params.profile || "changed", outcome: "succeeded", status: "succeeded", ok: true, selected: selected.commands, profiles: selected.inferred.summary, changedFiles: selected.inferred.changedFiles, selection: selected.selection, availableCommands: selected.availableCommands, selectedCommands: selected.commands.length, truncated: Boolean(selected.truncated), limits: { maxCommands: selected.selection?.maxCommands ?? null, fullTimeoutMs: config.fullTimeoutMs, liveTimeoutMs: config.liveTimeoutMs } };
    return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
  }
  async function run(ctx, params = {}, signal) {
    params = normalizeTestRunnerParams(params);
    const projectPath = resolveProjectPath(ctx, params.path);
    const selected = selectCommands(projectPath, params);
    if (selected.notApplicable) {
      const details = notApplicableDetails(projectPath, "run", params.profile || "changed", selected.reason, { reasonCode: selected.reasonCode || "no-applicable-command", requestedCommandId: selected.requestedCommandId, availableCommandIds: selected.availableCommandIds || [], suggestedProfiles: selected.suggestedProfiles || [], nextOperation: "infer", profiles: selected.inferred.summary, changedFiles: selected.inferred.changedFiles, selection: selected.selection, availableCommands: selected.availableCommands, selectedCommands: 0, truncated: false });
      writeJson(latestFile(projectPath), details);
      return formatRunResult(details, { ...config, ...params });
    }
    const runs = [];
    const timeoutMs = profileTimeoutMs(params.profile || "changed", { ...config, ...params }, params);
    for (const command of selected.commands) {
      const raw = await runCommandSpec(projectPath, command, { ...config, ...params }, signal, timeoutMs);
      runs.push(await compactRunForContent(raw, { ...config, ...params, projectPath }));
      if (signal?.aborted) break;
      if (params.stopOnFailure !== false && !raw.ok) break;
    }
    const summary = summarizeRuns(runs);
    const details = { generatedAt: new Date().toISOString(), projectPath, operation: "run", profile: params.profile || "changed", outcome: summary.failed ? "domain-negative" : "succeeded", status: summary.failed ? "failed" : "succeeded", ok: summary.failed === 0, selected: selected.commands, availableCommands: selected.availableCommands, selectedCommands: selected.commands.length, truncated: Boolean(selected.truncated), selection: selected.selection, timeoutMs, summary, runs };
    writeJson(latestFile(projectPath), details);
    return formatRunResult(details, { ...config, ...params });
  }
  async function rerunFailures(ctx, params = {}, signal) {
    params = normalizeTestRunnerParams(params);
    const projectPath = resolveProjectPath(ctx, params.path);
    const latest = readJson(latestFile(projectPath), null);
    if (!latest) {
      const details = notApplicableDetails(projectPath, "rerunFailures", "rerunFailures", "No previous test_runner result exists, so there are no prior failures to rerun.", { reasonCode: "no-prior-result" });
      return formatRunResult(details, { ...config, ...params });
    }
    const failed = (latest.runs || []).filter((r) => !r.ok).map((r) => ({ id: r.id, label: r.label, command: r.command, args: r.args, commandLine: r.commandLine, reason: "rerun previous failure", profile: latest.profile, kind: r.kind, files: r.files || [] }));
    if (!failed.length) {
      const details = notApplicableDetails(projectPath, "rerunFailures", "rerunFailures", "The previous test_runner result contains no failed commands.", { reasonCode: "no-prior-failures", previousGeneratedAt: latest.generatedAt });
      return formatRunResult(details, { ...config, ...params });
    }
    const runs = [];
    const timeoutMs = profileTimeoutMs(latest.profile, { ...config, ...params }, params);
    for (const command of failed.slice(0, config.maxCommands)) runs.push(await compactRunForContent(await runCommandSpec(projectPath, command, { ...config, ...params }, signal, timeoutMs), { ...config, ...params, projectPath }));
    const summary = summarizeRuns(runs);
    const details = { generatedAt: new Date().toISOString(), projectPath, operation: "rerunFailures", profile: "rerunFailures", outcome: summary.failed ? "domain-negative" : "succeeded", status: summary.failed ? "failed" : "succeeded", ok: summary.failed === 0, selected: failed.slice(0, config.maxCommands), availableCommands: failed.length, selectedCommands: Math.min(failed.length, config.maxCommands), truncated: failed.length > config.maxCommands, timeoutMs, summary, runs, previousGeneratedAt: latest.generatedAt };
    writeJson(latestFile(projectPath), details);
    return formatRunResult(details, { ...config, ...params });
  }
  return { config, status, listProfiles, infer, run, rerunFailures, inferCommands, selectCommands, parseCliArgs };
}

module.exports = {
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  STATE_DIR,
  configFromEnv,
  createTestRunner,
  inferCommands,
  selectCommands,
  parseCliArgs,
  splitArgs,
  isTestPath,
  testCommandsForPaths,
  gitChangedFiles,
  truncateTail,
  formatSize,
  normalizeTestRunnerParams,
  TEST_RUNNER_OPERATIONS,
  TEST_RUNNER_PROFILES,
  profileTimeoutMs,
  MAX_QUICK_TEST_FILES,
  MAX_UNIT_TEST_FILES,
};
