"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const hermesReadiness = require("./hermes-readiness.js");
const { scanMemoryContent, assertMemoryContentSafe } = require("./memory-content-scanner.js");
const { projectIdentity } = require("./project-identity.js");

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_IMPORT_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_HERMES_INPUT_CHARS = 80 * 1024;
const STATE_DIR = path.join(".pi", "obsidian");
const DEFAULT_VAULT_NAME = "Pi Research";
const DEFAULT_NOTE_FOLDER = "Inbox";
const DEFAULT_IMPORT_FOLDER = "Research";
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".rst", ".org", ".adoc"]);
const CODE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cu", ".cuh", ".h", ".hh", ".hpp", ".py", ".js", ".jsx", ".ts", ".tsx", ".rs", ".go", ".java", ".kt", ".swift", ".sh", ".bash", ".zsh", ".fish", ".lua", ".sql", ".yaml", ".yml", ".json", ".toml", ".ini", ".dot"]);
const SKIP_DIRS = new Set([".git", ".hg", ".svn", ".obsidian", ".pi", "node_modules", "dist", "build", "target", "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache"]);

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function splitList(value) {
  if (value == null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(splitList);
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}

function expandHome(value) {
  const text = String(value || "").trim();
  if (!text) return text;
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function configFromEnv(env = process.env, overrides = {}) {
  const vaultName = overrides.vaultName || env.PI_OBSIDIAN_VAULT_NAME || DEFAULT_VAULT_NAME;
  const defaultRoot = expandHome(overrides.defaultRoot || env.PI_OBSIDIAN_DEFAULT_ROOT || path.join(os.homedir(), "Obsidian"));
  const sharedHermesPolicy = hermesReadiness.policyFromEnv(env, { curationTimeoutMs: overrides.hermesTimeoutMs, authProbeTimeoutMs: overrides.hermesAuthProbeTimeoutMs, curationProbeTimeoutMs: overrides.hermesCurationProbeTimeoutMs, proofTtlMs: overrides.hermesProofTtlMs, failureBackoffMs: overrides.hermesFailureBackoffMs });
  return {
    enabled: env.PI_OBSIDIAN !== "0",
    bin: overrides.bin || env.PI_OBSIDIAN_BIN || "obsidian",
    vault: Object.prototype.hasOwnProperty.call(overrides, "vault") ? overrides.vault || null : env.PI_OBSIDIAN_VAULT || null,
    vaultName,
    defaultRoot,
    defaultVault: overrides.defaultVault || env.PI_OBSIDIAN_DEFAULT_VAULT || path.join(defaultRoot, vaultName),
    researchRoots: splitList(overrides.researchRoots || env.PI_OBSIDIAN_RESEARCH_ROOTS),
    allowOutsideCwd: overrides.allowOutsideCwd != null ? Boolean(overrides.allowOutsideCwd) : env.PI_OBSIDIAN_ALLOW_OUTSIDE === "1",
    outputMaxLines: clampNumber(Number(overrides.outputMaxLines || env.PI_OBSIDIAN_MAX_LINES || DEFAULT_MAX_LINES), 1, DEFAULT_MAX_LINES),
    outputMaxBytes: clampNumber(Number(overrides.outputMaxBytes || env.PI_OBSIDIAN_MAX_BYTES || DEFAULT_MAX_BYTES), 1024, DEFAULT_MAX_BYTES),
    maxFiles: clampNumber(Number(overrides.maxFiles || env.PI_OBSIDIAN_MAX_FILES || DEFAULT_MAX_FILES), 1, 10_000),
    maxImportFileBytes: clampNumber(Number(overrides.maxImportFileBytes || env.PI_OBSIDIAN_MAX_IMPORT_FILE_BYTES || DEFAULT_MAX_IMPORT_FILE_BYTES), 1024, 20 * 1024 * 1024),
    maxHermesInputChars: clampNumber(Number(overrides.maxHermesInputChars || env.PI_OBSIDIAN_MAX_HERMES_INPUT_CHARS || DEFAULT_MAX_HERMES_INPUT_CHARS), 1024, 2 * 1024 * 1024),
    hermesEnabled: env.PI_HERMES_ADVISORY !== "0" && overrides.hermesEnabled !== false,
    hermesBin: overrides.hermesBin || env.PI_HERMES_BIN || "hermes",
    hermesProvider: overrides.hermesProvider || env.PI_HERMES_PROVIDER || null,
    hermesModel: overrides.hermesModel || env.PI_HERMES_MODEL || null,
    hermesTimeoutMs: hermesReadiness.timeoutFor("curation", overrides.hermesTimeoutMs, sharedHermesPolicy),
    hermesAuthProbeTimeoutMs: hermesReadiness.timeoutFor("auth", overrides.hermesAuthProbeTimeoutMs, sharedHermesPolicy),
    hermesCurationProbeTimeoutMs: hermesReadiness.timeoutFor("curation-probe", overrides.hermesCurationProbeTimeoutMs, sharedHermesPolicy),
    hermesKillGraceMs: clampNumber(Number(overrides.hermesKillGraceMs ?? 1000), 0, 10 * 1000),
    sharedHermesPolicy,
  };
}

function stripAt(value) {
  const text = String(value || "").trim();
  return text.startsWith("@") ? text.slice(1) : text;
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isAllowedPath(cwd, absolute, config = configFromEnv()) {
  if (config.allowOutsideCwd) return true;
  const root = path.resolve(cwd || process.cwd());
  const home = path.resolve(os.homedir());
  return isInside(root, absolute) || isInside(home, absolute);
}

function resolveUserPath(ctx, inputPath, config = configFromEnv(), kind = "path") {
  const raw = stripAt(expandHome(inputPath));
  if (!raw) throw new Error(`Obsidian ${kind} must not be empty`);
  const cwd = path.resolve(ctx.cwd || process.cwd());
  const absolute = path.resolve(cwd, raw);
  if (!isAllowedPath(cwd, absolute, config)) {
    throw new Error(`Obsidian ${kind} must stay inside cwd (${cwd}) or home (${os.homedir()}). Set PI_OBSIDIAN_ALLOW_OUTSIDE=1 to allow ${absolute}.`);
  }
  return absolute;
}

function resolveVaultPath(ctx, inputPath, config = configFromEnv()) {
  const configured = inputPath || config.vault || config.defaultVault;
  return resolveUserPath(ctx, configured, config, "vault path");
}

function normalizeVaultRelative(file) {
  const raw = stripAt(file).replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === ".")) throw new Error(`Obsidian note path must stay inside the vault: ${file}`);
  return parts.join("/");
}

function normalizeSourcePath(ctx, inputPath, config = configFromEnv()) {
  return resolveUserPath(ctx, inputPath, config, "source path");
}

function formatSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

function truncateHead(text, options = {}) {
  const maxLines = options.maxLines || DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const value = String(text || "");
  const lines = value.split(/\r?\n/);
  const totalBytes = Buffer.byteLength(value, "utf8");
  const out = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength((out.length ? "\n" : "") + line, "utf8");
    if (out.length >= maxLines || (out.length && bytes + lineBytes > maxBytes)) break;
    if (!out.length && lineBytes > maxBytes) {
      let acc = "";
      for (const ch of line) {
        if (Buffer.byteLength(acc + ch, "utf8") > maxBytes) break;
        acc += ch;
      }
      out.push(acc);
      bytes = Buffer.byteLength(acc, "utf8");
      break;
    }
    out.push(line);
    bytes += lineBytes;
  }
  return { content: out.join("\n"), truncated: out.length < lines.length || bytes < totalBytes, outputLines: out.length, totalLines: lines.length, outputBytes: bytes, totalBytes };
}

async function toolText(text, details = {}, config = configFromEnv(), prefix = "Obsidian") {
  const truncation = truncateHead(String(text || ""), { maxLines: config.outputMaxLines, maxBytes: config.outputMaxBytes });
  let out = truncation.content.trimEnd() || `(${prefix} produced no output)`;
  const nextDetails = { ...details };
  if (truncation.truncated) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-obsidian-"));
    const file = path.join(dir, "output.txt");
    await fsp.writeFile(file, String(text || ""), "utf8");
    nextDetails.truncation = truncation;
    nextDetails.fullOutputPath = file;
    out += `\n\n[${prefix} output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${file}]`;
  }
  return { content: [{ type: "text", text: out }], details: nextDetails };
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
}

function executableInfo(bin = "obsidian", env = process.env) {
  const hasSep = bin.includes("/") || bin.includes("\\") || path.isAbsolute(bin);
  const candidates = hasSep ? [path.resolve(expandHome(bin))] : String(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return { bin, found: true, path: candidate }; } catch {}
  }
  return { bin, found: false, path: hasSep ? path.resolve(expandHome(bin)) : null };
}

function friendlyMissingBinaryMessage(config = configFromEnv()) {
  return `Obsidian desktop is not installed or is not on PATH (tried '${config.bin}'). Local Markdown search/note/import remain usable when the vault filesystem is ready; install Obsidian or set PI_OBSIDIAN_BIN only for desktop/open features.`;
}

function friendlyMissingHermesMessage(config = configFromEnv()) {
  return `Hermes is not installed or is not on PATH (tried '${config.hermesBin}'). Install Hermes, set PI_HERMES_BIN to the executable path, or disable Hermes advisory surfaces with PI_HERMES_ADVISORY=0.`;
}

function envReport(env = process.env) {
  return {
    PI_OBSIDIAN: env.PI_OBSIDIAN ?? null,
    PI_OBSIDIAN_BIN: env.PI_OBSIDIAN_BIN ?? null,
    PI_OBSIDIAN_VAULT: env.PI_OBSIDIAN_VAULT ?? null,
    PI_OBSIDIAN_VAULT_NAME: env.PI_OBSIDIAN_VAULT_NAME ?? null,
    PI_OBSIDIAN_DEFAULT_ROOT: env.PI_OBSIDIAN_DEFAULT_ROOT ?? null,
    PI_OBSIDIAN_DEFAULT_VAULT: env.PI_OBSIDIAN_DEFAULT_VAULT ?? null,
    PI_OBSIDIAN_RESEARCH_ROOTS: env.PI_OBSIDIAN_RESEARCH_ROOTS ?? null,
    PI_OBSIDIAN_ALLOW_OUTSIDE: env.PI_OBSIDIAN_ALLOW_OUTSIDE ?? null,
    PI_OBSIDIAN_MAX_LINES: env.PI_OBSIDIAN_MAX_LINES ?? null,
    PI_OBSIDIAN_MAX_BYTES: env.PI_OBSIDIAN_MAX_BYTES ?? null,
    PI_OBSIDIAN_MAX_FILES: env.PI_OBSIDIAN_MAX_FILES ?? null,
    PI_OBSIDIAN_MAX_IMPORT_FILE_BYTES: env.PI_OBSIDIAN_MAX_IMPORT_FILE_BYTES ?? null,
    PI_OBSIDIAN_MAX_HERMES_INPUT_CHARS: env.PI_OBSIDIAN_MAX_HERMES_INPUT_CHARS ?? null,
    PI_HERMES_ADVISORY: env.PI_HERMES_ADVISORY ?? null,
    PI_HERMES_BIN: env.PI_HERMES_BIN ?? null,
    PI_HERMES_PROVIDER: env.PI_HERMES_PROVIDER ?? null,
    PI_HERMES_MODEL: env.PI_HERMES_MODEL ?? null,
    PI_HERMES_CURATION_TIMEOUT_MS: env.PI_HERMES_CURATION_TIMEOUT_MS ?? null,
    PI_HERMES_AUTH_PROBE_TIMEOUT_MS: env.PI_HERMES_AUTH_PROBE_TIMEOUT_MS ?? null,
    PI_HERMES_CURATION_PROBE_TIMEOUT_MS: env.PI_HERMES_CURATION_PROBE_TIMEOUT_MS ?? null,
    PI_OBSIDIAN_AUTO_AWARE: env.PI_OBSIDIAN_AUTO_AWARE ?? null,
    PI_OBSIDIAN_AUTO_STATUS: env.PI_OBSIDIAN_AUTO_STATUS ?? null,
  };
}

function stateRoot(cwd) { return path.join(cwd, STATE_DIR); }
function stateFile(cwd) { return path.join(stateRoot(cwd), "state.json"); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch {} }
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}
function readState(cwd) { return readJson(stateFile(cwd), { version: 1, events: [] }); }
function writeState(cwd, patch = {}) {
  const previous = readState(cwd);
  const next = { ...previous, ...patch, version: 1, updatedAt: new Date().toISOString() };
  writeJson(stateFile(cwd), next);
  return next;
}
function sanitizeEvent(event = {}, at = new Date().toISOString()) {
  const safe = { at: String(event.at || at).slice(0, 40), operation: String(event.operation || "unknown").slice(0, 48) };
  for (const key of ["outcome", "category", "errorCode", "mode", "curationReceiptId", "advisorySourceVersion"]) if (event[key] != null) safe[key] = String(event[key]).slice(0, 96);
  if (["accept", "reject", "correct"].includes(event.decision)) safe.decision = event.decision;
  for (const key of ["durationMs", "filesIncluded", "count", "written", "skipped"]) if (Number.isFinite(Number(event[key]))) safe[key] = Number(event[key]);
  for (const key of ["dryRun", "noteWritten", "receiptBound"]) if (typeof event[key] === "boolean") safe[key] = event[key];
  return safe;
}
function recordEvent(cwd, event = {}) {
  const state = readState(cwd);
  const events = [sanitizeEvent(event), ...(state.events || []).map((item) => sanitizeEvent(item))].slice(0, 50);
  return writeState(cwd, { events, lastEvent: events[0] });
}

function maybeVault(pathname) {
  try {
    const s = fs.statSync(pathname);
    if (!s.isDirectory()) return false;
    return fs.existsSync(path.join(pathname, ".obsidian"));
  } catch {
    return false;
  }
}

function addCandidate(candidates, seen, candidate, reason) {
  if (!candidate) return;
  const resolved = path.resolve(expandHome(candidate));
  if (seen.has(resolved)) return;
  seen.add(resolved);
  candidates.push({ path: resolved, exists: fs.existsSync(resolved), isVault: maybeVault(resolved), reason });
}

function extractPathStrings(value, out = []) {
  if (typeof value === "string") {
    if (value.includes("/") || value.startsWith("~")) out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) extractPathStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) extractPathStrings(item, out);
  }
  return out;
}

function obsidianConfigVaults() {
  const files = [
    path.join(os.homedir(), ".config", "obsidian", "obsidian.json"),
    path.join(os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json"),
  ];
  const out = [];
  for (const file of files) {
    try {
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      out.push(...extractPathStrings(json));
    } catch {}
  }
  return out;
}

function commonVaultSearchRoots(config = configFromEnv()) {
  return [
    config.defaultRoot,
    path.join(os.homedir(), "Documents"),
    path.join(os.homedir(), "Vaults"),
    path.join(os.homedir(), "Obsidian"),
  ].map(expandHome);
}

function discoverVaultCandidates(cwd = process.cwd(), options = {}) {
  const config = configFromEnv(process.env, options);
  const candidates = [];
  const seen = new Set();
  addCandidate(candidates, seen, config.vault, "configured PI_OBSIDIAN_VAULT");
  addCandidate(candidates, seen, config.defaultVault, "default managed vault");

  let cur = path.resolve(cwd);
  for (;;) {
    if (maybeVault(cur)) addCandidate(candidates, seen, cur, "cwd ancestor");
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  for (const candidate of obsidianConfigVaults()) addCandidate(candidates, seen, candidate, "Obsidian app config");
  for (const root of commonVaultSearchRoots(config)) {
    if (maybeVault(root)) addCandidate(candidates, seen, root, "common vault root");
    try {
      for (const name of fs.readdirSync(root).slice(0, 100)) {
        const full = path.join(root, name);
        if (maybeVault(full)) addCandidate(candidates, seen, full, "common vault child");
      }
    } catch {}
  }
  return candidates;
}

function vaultPathFacts(vaultPath) {
  let exists = false;
  let marker = false;
  let readable = false;
  let writable = false;
  try {
    const stat = fs.lstatSync(vaultPath);
    exists = !stat.isSymbolicLink() && stat.isDirectory();
    marker = exists && maybeVault(vaultPath);
    if (exists) {
      try { fs.accessSync(vaultPath, fs.constants.R_OK); readable = true; } catch {}
      try { fs.accessSync(vaultPath, fs.constants.W_OK); writable = true; } catch {}
    }
  } catch {}
  return { exists, marker, readable, writable };
}
function selectionResult(cwd, input = {}) {
  const identity = projectIdentity(cwd);
  const selectedPath = input.path ? path.resolve(input.path) : null;
  const pathHash = `sha256:${sha256(selectedPath || `${identity.projectKey}:${input.source || "denied"}`)}`;
  const facts = selectedPath ? vaultPathFacts(selectedPath) : { exists: false, marker: false, readable: false, writable: false };
  const reasons = [...new Set([
    ...(input.reasons || []),
    !facts.exists && selectedPath ? "vault-missing" : null,
    facts.exists && !facts.marker ? "vault-marker-missing" : null,
    facts.exists && !facts.readable ? "vault-not-readable" : null,
    facts.exists && !facts.writable ? "vault-not-writable" : null,
  ].filter(Boolean))];
  const stable = { projectKey: identity.projectKey, pathHash, ambiguous: Boolean(input.ambiguous), candidateCount: Number(input.candidateCount || 0) };
  return {
    schemaVersion: 1,
    projectKey: identity.projectKey,
    selectionId: `vaultsel_${sha256(stable).slice(0, 24)}`,
    path: selectedPath,
    pathHash,
    source: input.source,
    configured: Boolean(input.configured),
    ...facts,
    ambiguous: Boolean(input.ambiguous),
    candidateCount: Number(input.candidateCount || 0),
    reasons,
  };
}
function resolveVaultSelection(ctx = {}, params = {}, config = configFromEnv()) {
  const cwd = path.resolve(ctx.cwd || process.cwd());
  const denied = (reason) => selectionResult(cwd, { source: "denied", configured: Boolean(params.vault || params.path || config.vault), reasons: ["vault-path-denied", reason ? "review-vault-configuration" : null].filter(Boolean) });
  try {
    const explicit = params.vault || params.path;
    if (explicit) return selectionResult(cwd, { path: resolveVaultPath({ cwd }, explicit, config), source: "explicit", configured: true, candidateCount: 1 });
    // A configured path remains authoritative even when missing.
    if (config.vault) return selectionResult(cwd, { path: resolveVaultPath({ cwd }, config.vault, config), source: "configured", configured: true, candidateCount: 1 });

    const discovered = Array.isArray(params.discoveredCandidates)
      ? params.discoveredCandidates.map((candidate) => ({ path: path.resolve(expandHome(candidate.path || candidate)), exists: candidate.exists ?? fs.existsSync(candidate.path || candidate), isVault: candidate.isVault ?? maybeVault(candidate.path || candidate), reason: candidate.reason || "injected discovery" }))
      : discoverVaultCandidates(cwd, config);
    const defaultPath = resolveVaultPath({ cwd }, config.defaultVault, config);
    const valid = [];
    const seen = new Set();
    for (const candidate of discovered) {
      const candidatePath = path.resolve(candidate.path);
      if (candidatePath === path.resolve(defaultPath) || candidate.reason === "default managed vault") continue;
      if (!candidate.exists || !candidate.isVault || seen.has(candidatePath)) continue;
      seen.add(candidatePath);
      valid.push(candidatePath);
    }
    if (valid.length > 1) return selectionResult(cwd, { source: "ambiguous", ambiguous: true, candidateCount: valid.length, reasons: ["multiple-discovered-vaults", "configure-pi-obsidian-vault"] });
    if (valid.length === 1) return selectionResult(cwd, { path: valid[0], source: "discovered-single", candidateCount: 1 });
    return selectionResult(cwd, { path: defaultPath, source: "default-managed", candidateCount: 0 });
  } catch (error) {
    return denied(error?.message);
  }
}
function publicSelection(selection) { return selection ? Object.fromEntries(Object.entries(selection).filter(([key]) => key !== "path" && key !== "isVault" && key !== "reason")) : null; }
function selectedVault(ctx, params = {}, config = configFromEnv()) {
  const selection = resolveVaultSelection(ctx, params, config);
  if (selection.ambiguous) { const error = new Error("Multiple valid Obsidian vaults were discovered; set PI_OBSIDIAN_VAULT or pass vault explicitly."); error.code = "OBSIDIAN_VAULT_AMBIGUOUS"; throw error; }
  if (selection.source === "denied" || !selection.path) { const error = new Error("Obsidian vault selection was denied by path policy."); error.code = "OBSIDIAN_VAULT_PATH_DENIED"; throw error; }
  return { ...selection, isVault: selection.marker, reason: selection.source };
}

function sharedHermesOptions(config, extra = {}) { return { bin: config.hermesBin, provider: config.hermesProvider, model: config.hermesModel, policy: config.sharedHermesPolicy, ...extra }; }
function desktopOpenReadiness(binary, options = {}) {
  if (typeof options.desktopOpen === "boolean") return { status: options.desktopOpen ? "open" : "not-running", ready: options.desktopOpen, method: "override" };
  if (!binary?.found) return { status: "unavailable", ready: false, method: "binary-missing" };
  const processName = path.basename(binary.path || binary.bin || "obsidian").replace(/\.(?:appimage|exe)$/i, "");
  const probe = spawnSync("pgrep", ["-x", processName], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] });
  if (probe.error?.code === "ENOENT") return { status: "unknown", ready: false, method: "pgrep-unavailable" };
  return { status: probe.status === 0 ? "open" : "not-running", ready: probe.status === 0, method: "pgrep" };
}
function hermesLocalReadiness(config = configFromEnv(), options = {}) {
  const executable = executableInfo(config.hermesBin);
  const local = options.hermesReadiness || { executable: { ready: Boolean(config.hermesEnabled && executable.found), status: config.hermesEnabled && executable.found ? "ready" : config.hermesEnabled ? "unavailable" : "disabled", binary: executable }, authentication: { ready: false, status: "not-probed" }, providerModel: { ready: false, status: "unknown", provider: null, model: null } };
  return { executable: { ...local.executable, version: null }, authentication: local.authentication, providerModel: local.providerModel, statusProbe: { ok: false, category: "adapter-readiness-only" } };
}
function vaultFilesystemReadiness(vault) {
  const exists = Boolean(vault?.exists);
  const readable = vault?.readable != null ? Boolean(vault.readable) : exists;
  const writable = vault?.writable != null ? Boolean(vault.writable) : exists;
  const marker = Boolean(vault?.marker ?? vault?.isVault);
  const ready = Boolean(exists && readable && writable && !vault?.ambiguous && vault?.source !== "denied");
  const status = vault?.ambiguous ? "ambiguous" : vault?.source === "denied" ? "denied" : !exists ? "missing" : !readable ? "not-readable" : !writable ? "not-writable" : "ready";
  return { ready, status, exists, marker, readable, writable, selectionId: vault?.selectionId || null, projectKey: vault?.projectKey || null, pathHash: vault?.pathHash || null };
}
function buildProjectMemoryReadiness(selection, rollout = {}, { hermesCuration = {}, projectFolderExists = false } = {}) {
  const vaultFilesystem = vaultFilesystemReadiness(selection);
  const controls = rollout.controls || {};
  // A fallback vault selected without an explicit or unique discovery is not a
  // confirmed canonical store. Automatic capture treats it as unconfirmed so a
  // second host cannot silently create a divergent project-memory root.
  const confirmedSource = ["explicit", "configured", "discovered-single"].includes(selection?.source);
  const confirmed = Boolean(selection?.marker && confirmedSource);
  const vaultConfirmation = { confirmed, source: selection?.source || null, status: confirmed ? "confirmed" : "unconfirmed" };
  const canonicalProjectFolder = { ready: Boolean(projectFolderExists), status: projectFolderExists ? "ready" : "missing" };
  return {
    vaultFilesystem,
    vaultConfirmation,
    canonicalProjectFolder,
    projectMemoryReads: { ready: Boolean(vaultFilesystem.ready && controls.reads), status: vaultFilesystem.ready && controls.reads ? "ready" : controls.reads ? vaultFilesystem.status : "rollout-disabled" },
    projectMemoryExplicitWrites: { ready: Boolean(vaultFilesystem.ready && controls.explicitWrites), status: vaultFilesystem.ready && controls.explicitWrites ? "ready" : controls.explicitWrites ? vaultFilesystem.status : "rollout-disabled" },
    hermesCuration: { ready: Boolean(hermesCuration.ready && controls.hermesCuration), status: hermesCuration.ready && controls.hermesCuration ? "ready" : controls.hermesCuration ? hermesCuration.status || "provider-proof-required" : "rollout-disabled" },
    automaticBehaviorAuthorized: { ready: Boolean(controls.automaticVerifiedUpserts || controls.automaticCapture || controls.taskRecall), status: controls.automaticVerifiedUpserts || controls.automaticCapture || controls.taskRecall ? "authorized" : "not-authorized", authority: rollout.operatorAutomatic ? "operator-opt-in" : "scorecard-rollout-only", fieldEffectiveness: rollout.fieldEffectiveness || "not-assessed" },
  };
}
function buildObsidianReadiness(snapshot, config, options = {}) {
  const vaultFilesystem = vaultFilesystemReadiness(snapshot.vault);
  const desktopExecutable = { ready: snapshot.binary.found, status: snapshot.binary.found ? "ready" : "unavailable", binary: snapshot.binary };
  const desktopOpen = desktopOpenReadiness(snapshot.binary, options);
  const hermes = hermesLocalReadiness(config, options);
  const shared = options.sharedHermesReadiness || { authReady: false, curationReady: false, backoffActive: false, retryAfter: null };
  if (shared.authReady) {
    hermes.authentication = { ready: true, status: "ready", category: "current-doctor-proof" };
    if (!hermes.providerModel.ready) {
      hermes.providerModel = { ready: true, status: "ready", provider: "configured-default", model: "configured-default", category: "current-doctor-proof" };
    }
  }
  const localMarkdown = { ready: Boolean(snapshot.enabled && vaultFilesystem.ready), status: snapshot.enabled && vaultFilesystem.ready ? "ready" : "not-ready", requiresDesktop: false, requiresHermes: false };
  const curationEligible = Boolean(localMarkdown.ready && hermes.executable.ready && hermes.authentication.ready && hermes.providerModel.ready);
  const curationReady = Boolean(curationEligible && shared.curationReady);
  const curation = { ready: curationReady, eligible: curationEligible, status: curationReady ? "ready" : curationEligible ? "not-probed" : "not-ready", proofCurrent: Boolean(shared.curationReady), retryAfter: shared.retryAfter || null, reasons: [!localMarkdown.ready ? "vault-filesystem-not-ready" : null, !hermes.executable.ready ? "hermes-executable-not-ready" : null, !hermes.authentication.ready ? `hermes-auth-${hermes.authentication.status}` : null, !hermes.providerModel.ready ? "provider-model-unknown" : null, shared.backoffActive ? "hermes-backoff-active" : null, curationEligible && !shared.curationReady ? "current-curation-smoke-required" : null].filter(Boolean) };
  return { vaultFilesystem, desktopExecutable, desktopOpen, hermesExecutable: hermes.executable, hermesAuthentication: hermes.authentication, providerModel: hermes.providerModel, localMarkdown, curation, hermesCuration: curation, sharedHermes: shared };
}
function obsidianProjectSnapshot(cwd = process.cwd(), options = {}) {
  const config = configFromEnv(process.env, options);
  const binary = executableInfo(config.bin);
  const hermesBinary = executableInfo(config.hermesBin);
  const ctx = { cwd };
  const selection = resolveVaultSelection(ctx, options, config);
  const vault = { ...selection, isVault: selection.marker, reason: selection.source };
  const candidates = discoverVaultCandidates(cwd, config);
  const snapshot = {
    enabled: config.enabled,
    binary,
    hermesEnabled: config.hermesEnabled,
    hermesBinary,
    vault,
    selection,
    candidates,
    statePath: stateFile(cwd),
    readiness: null,
    ready: false,
    curationReady: false,
    errorCode: null,
    guidance: [],
  };
  if (selection.source === "denied") { snapshot.errorCode = "OBSIDIAN_VAULT_PATH_DENIED"; snapshot.guidance.push("Vault configuration is outside the allowed path policy; pass a permitted explicit vault or review PI_OBSIDIAN_ALLOW_OUTSIDE."); }
  if (selection.ambiguous) { snapshot.errorCode = "OBSIDIAN_VAULT_AMBIGUOUS"; snapshot.guidance.push("Multiple valid vaults were discovered. Set PI_OBSIDIAN_VAULT or pass an explicit vault; no writer was selected."); }
  if (!config.enabled) snapshot.guidance.push("Obsidian extension disabled with PI_OBSIDIAN=0.");
  if (config.enabled && !binary.found) { snapshot.errorCode ||= "OBSIDIAN_DESKTOP_NOT_INSTALLED"; snapshot.guidance.push(friendlyMissingBinaryMessage(config)); }
  if (!vault?.exists && vault?.path) snapshot.guidance.push(`Managed vault does not exist yet: ${vault.path}. Run /obsidian-note or /obsidian-import --apply to create it, or set PI_OBSIDIAN_VAULT to an existing vault.`);
  else if (!vault?.isVault) snapshot.guidance.push(`Selected directory exists but has no .obsidian marker: ${vault.path}. The adapter can still write Markdown there; Obsidian will initialize it when opened.`);
  if (config.hermesEnabled && !hermesBinary.found) snapshot.guidance.push(friendlyMissingHermesMessage(config));
  if (!config.allowOutsideCwd) snapshot.guidance.push("Explicit source/vault paths are confined to the current repo or home directory by default; set PI_OBSIDIAN_ALLOW_OUTSIDE=1 only when needed.");
  const sharedHermesStatus = hermesReadiness.readinessStatus(cwd, sharedHermesOptions(config));
  snapshot.readiness = buildObsidianReadiness(snapshot, config, { ...options, cwd, sharedHermesReadiness: sharedHermesStatus });
  snapshot.ready = snapshot.readiness.localMarkdown.ready;
  snapshot.curationReady = snapshot.readiness.curation.ready;
  if (!snapshot.curationReady && config.hermesEnabled) snapshot.guidance.push(`Hermes curation is not ready: ${snapshot.readiness.curation.reasons.join(", ") || "unknown readiness"}. Run obsidian_doctor with probeAuth:true, then probeCuration:true for an end-to-end bounded smoke.`);
  return snapshot;
}

function obsidianDoctor(cwd = process.cwd(), options = {}) {
  const config = configFromEnv(process.env, options);
  const snapshot = obsidianProjectSnapshot(cwd, options);
  const risks = [];
  const recommendations = [];
  if (!snapshot.enabled) recommendations.push("Set PI_OBSIDIAN=1 or unset PI_OBSIDIAN to enable the adapter.");
  if (!snapshot.binary.found) risks.push(friendlyMissingBinaryMessage(config));
  if (snapshot.errorCode === "OBSIDIAN_VAULT_PATH_DENIED") risks.push(...snapshot.guidance.filter((item) => /must stay inside|path/i.test(item)));
  if (!snapshot.vault?.exists) recommendations.push(`Create/open the managed vault at ${snapshot.vault?.path}, or set PI_OBSIDIAN_VAULT to an existing vault.`);
  if (snapshot.vault?.exists && !snapshot.vault?.isVault) recommendations.push("Open the selected directory in Obsidian once so it creates .obsidian metadata.");
  if (config.hermesEnabled && !snapshot.hermesBinary.found) risks.push(friendlyMissingHermesMessage(config));
  recommendations.push("Use /obsidian-import --apply <research-dir> <docs-dir> to copy Markdown research artifacts into the managed vault.");
  if (snapshot.curationReady) recommendations.push("Hermes curation is ready; use /obsidian-hermes <topic> for explicit durable curation.");
  else recommendations.push("Hermes curation is not ready. Run /obsidian-doctor --probe-auth and resolve the reported auth/provider/model category before /obsidian-hermes.");
  recommendations.push("Use /obsidian-search <query> before broad vault reads; adapter results are local-first and truncated.");
  return {
    generatedAt: new Date().toISOString(),
    enabled: config.enabled,
    cwd,
    vault: snapshot.vault,
    selection: snapshot.selection,
    candidates: snapshot.candidates,
    binary: snapshot.binary,
    hermesEnabled: config.hermesEnabled,
    hermesBinary: snapshot.hermesBinary,
    readiness: snapshot.readiness,
    ready: snapshot.ready,
    curationReady: snapshot.curationReady,
    env: envReport(),
    statePath: snapshot.statePath,
    advisoryBoundary: { localFirst: true, nonBlockingByDefault: true, modelReasoning: "Obsidian notes and Hermes summaries are advisory durable context; no private scratchpad storage" },
    risks: Array.from(new Set(risks.filter(Boolean))),
    recommendations: Array.from(new Set(recommendations.filter(Boolean))),
  };
}

function formatDoctor(doctor) {
  const lines = [
    `Obsidian doctor ${doctor.generatedAt}`,
    `enabled: ${doctor.enabled}`,
    `binary: ${doctor.binary?.found ? doctor.binary.path : `missing (${doctor.binary?.bin})`}`,
    `vault: ${doctor.vault?.path || "unresolved"}`,
    `selection: ${doctor.selection?.selectionId || "unresolved"} (${doctor.selection?.source || "unknown"}; project=${doctor.selection?.projectKey || "unknown"})`,
    `vault exists: ${doctor.vault?.exists ? "yes" : "no"}`,
    `vault marker: ${doctor.vault?.isVault ? "yes" : "no"}`,
    `Obsidian desktop: ${doctor.readiness?.desktopExecutable?.status || "unknown"}; open=${doctor.readiness?.desktopOpen?.status || "unknown"}`,
    `Hermes executable: ${doctor.readiness?.hermesExecutable?.status || (doctor.hermesEnabled ? "unknown" : "disabled")}`,
    `Hermes authentication: ${doctor.readiness?.hermesAuthentication?.status || "unknown"}`,
    `Hermes provider/model: ${doctor.readiness?.providerModel?.status || "unknown"}${doctor.readiness?.providerModel?.provider ? ` (${doctor.readiness.providerModel.provider}/${doctor.readiness.providerModel.model || "unknown"})` : ""}`,
    `local Markdown ready: ${Boolean(doctor.readiness?.localMarkdown?.ready)}`,
    `curation ready: ${Boolean(doctor.curationReady)}`,
    `state: ${doctor.statePath}`,
  ];
  if (doctor.authProbe) lines.push(`Auth probe: ${doctor.authProbe.status} (${doctor.authProbe.category}; ${doctor.authProbe.durationMs}ms)`);
  if (doctor.curationProbe) lines.push(`Curation dry-run probe: ${doctor.curationProbe.status} (${doctor.curationProbe.category}; ${doctor.curationProbe.durationMs}ms; noteWritten=${doctor.curationProbe.noteWritten})`);
  if (doctor.candidates?.length) lines.push("", "Vault candidates:", ...doctor.candidates.slice(0, 10).map((c) => `- ${c.path} (${c.reason}; exists=${c.exists}; vault=${c.isVault})`));
  if (doctor.risks?.length) lines.push("", "Risks:", ...doctor.risks.map((r) => `- ${r}`));
  if (doctor.recommendations?.length) lines.push("", "Recommendations:", ...doctor.recommendations.map((r) => `- ${r}`));
  return lines.join("\n");
}

function splitArgs(input) {
  const tokens = [];
  const re = new RegExp("\\\"((?:\\\\.|[^\\\"\\\\])*)\\\"|'((?:\\\\.|[^'\\\\])*)'|(\\S+)", "g");
  const escapedQuote = new RegExp("\\\\([\\\"'\\\\])", "g");
  let match;
  while ((match = re.exec(input || ""))) tokens.push((match[1] ?? match[2] ?? match[3] ?? "").replace(escapedQuote, "$1"));
  return tokens;
}

function parseCliArgs(input) {
  const tokens = splitArgs(input);
  const opts = {};
  const positional = [];
  const pushOpt = (key, value) => { opts[key] = [...splitList(opts[key]), value]; };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = () => tokens[++i];
    if (token === "--vault" || token === "--path" || token === "-p") opts.vault = next();
    else if (token.startsWith("--vault=")) opts.vault = token.slice("--vault=".length);
    else if (token.startsWith("--path=")) opts.vault = token.slice("--path=".length);
    else if (token === "--folder" || token === "-f") opts.folder = next();
    else if (token.startsWith("--folder=")) opts.folder = token.slice("--folder=".length);
    else if (token === "--max-files") opts.maxFiles = next();
    else if (token.startsWith("--max-files=")) opts.maxFiles = token.slice("--max-files=".length);
    else if (token === "--max-bytes") opts.maxImportFileBytes = next();
    else if (token.startsWith("--max-bytes=")) opts.maxImportFileBytes = token.slice("--max-bytes=".length);
    else if (token === "--extension" || token === "--ext") pushOpt("extensions", next());
    else if (token.startsWith("--extension=")) pushOpt("extensions", token.slice("--extension=".length));
    else if (token === "--tag") pushOpt("tags", next());
    else if (token.startsWith("--tag=")) pushOpt("tags", token.slice("--tag=".length));
    else if (token === "--topic") opts.topic = next();
    else if (token.startsWith("--topic=")) opts.topic = token.slice("--topic=".length);
    else if (token === "--mode") opts.mode = next();
    else if (token.startsWith("--mode=")) opts.mode = token.slice("--mode=".length);
    else if (token === "--apply") opts.dryRun = false;
    else if (token === "--dry-run") opts.dryRun = true;
    else if (token === "--include-code") opts.includeCode = true;
    else if (token === "--no-code") opts.includeCode = false;
    else if (token === "--json" || token === "-j") opts.json = true;
    else if (token === "--open") opts.open = true;
    else if (token === "--probe-auth") opts.probeAuth = true;
    else if (token === "--probe-curation" || token === "--dry-run-curation") opts.probeCuration = true;
    else if (token === "--timeout-ms") opts.timeoutMs = next();
    else if (token.startsWith("--timeout-ms=")) opts.timeoutMs = token.slice("--timeout-ms=".length);
    else positional.push(token);
  }
  return { opts, positional };
}

function safeSegment(value, fallback = "untitled") {
  const text = String(value || "").trim().replace(/\.[Mm][Dd]$/, "");
  const slug = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9._ -]+/g, " ").trim().replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 96).replace(/^[-.]+|[-.]+$/g, "");
  return slug || fallback;
}

function safeFolder(value, fallback = DEFAULT_NOTE_FOLDER) {
  const parts = String(value || fallback).split(/[\\/]+/).map((p) => safeSegment(p, "")).filter(Boolean);
  return parts.length ? path.join(...parts) : fallback;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function normalizeTags(tags) {
  const values = Array.from(new Set(["pi", ...splitList(tags)].map((tag) => String(tag || "").trim().replace(/^#/, "").replace(/[^a-zA-Z0-9_/-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()).filter(Boolean)));
  return values;
}

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function frontmatter(fields = {}) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (Array.isArray(value)) lines.push(`${key}: [${value.map(yamlScalar).join(", ")}]`);
    else lines.push(`${key}: ${yamlScalar(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

async function ensureVault(vaultPath) {
  await fsp.mkdir(vaultPath, { recursive: true });
  await fsp.mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
}
async function safeVaultWriteTarget(vaultPath, relativePath) {
  const relative = normalizeVaultRelative(relativePath);
  if (!relative) throw new Error("Obsidian write path must not be empty");
  const root = await fsp.realpath(vaultPath);
  const target = path.resolve(root, relative);
  if (!isInside(root, target)) throw new Error(`Obsidian write must stay inside vault: ${relative}`);
  let current = root;
  const parts = relative.replace(/\\/g, "/").split("/");
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await fsp.lstat(current); }
    catch (error) { if (error?.code === "ENOENT") break; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Obsidian write path must not contain symbolic links: ${relative}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Obsidian write parent is not a directory: ${relative}`);
  }
  return { root, target, relative };
}
async function writeVaultFile(vaultPath, relativePath, content, { append = false } = {}) {
  let checked = await safeVaultWriteTarget(vaultPath, relativePath);
  await fsp.mkdir(path.dirname(checked.target), { recursive: true });
  checked = await safeVaultWriteTarget(vaultPath, relativePath);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | (append ? fs.constants.O_APPEND : fs.constants.O_TRUNC) | (fs.constants.O_NOFOLLOW || 0);
  const handle = await fsp.open(checked.target, flags, 0o600);
  try {
    await handle.writeFile(String(content), "utf8");
    await handle.chmod(0o600);
  } finally { await handle.close(); }
  return checked.target;
}

function noteRelativePath(folder, title) {
  const dir = safeFolder(folder || DEFAULT_NOTE_FOLDER, DEFAULT_NOTE_FOLDER);
  const base = safeSegment(title || "untitled", "untitled");
  return path.join(dir, `${base}.md`);
}

async function writeObsidianNote(ctx, params = {}, config = configFromEnv()) {
  const title = String(params.title || "").trim();
  if (!title) throw new Error("obsidian_note requires a title");
  const vault = selectedVault(ctx, params, config);
  await ensureVault(vault.path);
  const mode = ["append", "overwrite", "create"].includes(params.mode) ? params.mode : "append";
  let relativePath = params.file ? normalizeVaultRelative(params.file) : noteRelativePath(params.folder || DEFAULT_NOTE_FOLDER, title);
  if (!relativePath.toLowerCase().endsWith(".md")) relativePath += ".md";
  let checked = await safeVaultWriteTarget(vault.path, relativePath);
  if (mode === "create" && fs.existsSync(checked.target)) {
    const parsed = path.parse(relativePath);
    relativePath = path.join(parsed.dir, `${parsed.name}-${timestampSlug()}${parsed.ext || ".md"}`);
    checked = await safeVaultWriteTarget(vault.path, relativePath);
  }
  const tags = normalizeTags(params.tags);
  let body = String(params.body ?? params.text ?? "").trimEnd();
  if (!body) body = "(empty note)";
  if (body.length > config.maxHermesInputChars) body = body.slice(0, config.maxHermesInputChars) + `\n\n[Note body truncated at ${config.maxHermesInputChars} chars by Pi Obsidian adapter.]`;
  const created = new Date().toISOString();
  const header = frontmatter({ title, created, updated: created, source: params.source || "pi", tags, ...(params.frontmatterFields || {}) });
  const payload = `${header}# ${title}\n\n${body.trim()}\n`;
  assertMemoryContentSafe(payload, { maxChars: config.maxHermesInputChars + 4096 });
  const append = mode === "append" && fs.existsSync(checked.target);
  const target = await writeVaultFile(vault.path, relativePath, append ? `\n\n---\n\n## ${created}\n\n${body.trim()}\n` : payload, { append });
  recordEvent(ctx.cwd, { operation: "note", vaultPath: vault.path, file: relativePath, mode });
  const details = { generatedAt: created, operation: "note", selection: publicSelection(vault), vaultPath: vault.path, filePath: target, relativePath, mode, tags, sha256: sha256(payload) };
  return toolText(`Wrote Obsidian note: ${relativePath}\nVault: ${vault.path}`, details, config);
}

function languageForExtension(ext) {
  const e = ext.toLowerCase().replace(/^\./, "");
  const map = { cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", h: "cpp", cu: "cuda", cuh: "cuda", py: "python", js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", sh: "bash", bash: "bash", zsh: "zsh", yml: "yaml" };
  return map[e] || e || "text";
}

function shouldIncludeFile(file, params = {}, config = configFromEnv()) {
  const ext = path.extname(file).toLowerCase();
  const custom = splitList(params.extensions).map((e) => e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`);
  const allowed = custom.length ? new Set(custom) : TEXT_EXTENSIONS;
  if (allowed.has(ext)) return true;
  if (params.includeCode && CODE_EXTENSIONS.has(ext)) return true;
  return false;
}

function walkResearchFiles(root, params = {}, config = configFromEnv()) {
  const maxFiles = clampNumber(Number(params.maxFiles || config.maxFiles), 1, 10_000);
  const maxBytes = clampNumber(Number(params.maxImportFileBytes || config.maxImportFileBytes), 1024, 20 * 1024 * 1024);
  const files = [];
  const skipped = [];
  function walk(dir) {
    if (files.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { skipped.push({ path: dir, reason: String(e?.message || e) }); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (!shouldIncludeFile(full, params, config)) { skipped.push({ path: full, reason: "extension" }); continue; }
        const st = fs.statSync(full);
        if (st.size > maxBytes) { skipped.push({ path: full, reason: `too-large (${formatSize(st.size)})` }); continue; }
        files.push({ path: full, size: st.size, mtimeMs: st.mtimeMs, root });
      }
    }
  }
  walk(root);
  return { files, skipped, truncated: files.length >= maxFiles };
}

function commonParent(paths) {
  if (!paths.length) return process.cwd();
  const split = paths.map((p) => path.resolve(p).split(path.sep).filter(Boolean));
  const out = [];
  for (let i = 0; ; i++) {
    const value = split[0]?.[i];
    if (!value || split.some((parts) => parts[i] !== value)) break;
    out.push(value);
  }
  const prefix = path.isAbsolute(paths[0]) ? path.sep : "";
  return prefix + out.join(path.sep);
}

function defaultSourceRoots(ctx, config = configFromEnv()) {
  const roots = config.researchRoots.length ? config.researchRoots : ["research", "docs"].map((name) => path.join(ctx.cwd, name));
  return roots.map((root) => path.resolve(ctx.cwd, expandHome(root))).filter((root) => fs.existsSync(root));
}

function importProjectName(ctx, sourceRoots) {
  if (sourceRoots.length > 1) {
    const parent = commonParent(sourceRoots);
    const base = path.basename(parent);
    if (base) return safeSegment(base, "research");
  }
  if (sourceRoots.length === 1) {
    const base = path.basename(path.dirname(sourceRoots[0])) || path.basename(sourceRoots[0]);
    if (base) return safeSegment(base, "research");
  }
  return safeSegment(path.basename(ctx.cwd || process.cwd()), "research");
}

function importedMarkdownFor(file, sourceRoot, projectName, config) {
  const ext = path.extname(file).toLowerCase();
  const original = fs.readFileSync(file, "utf8");
  const rel = path.relative(sourceRoot, file).replace(/\\/g, "/");
  const title = path.basename(file).replace(/\.[^.]+$/, "");
  const fields = { title, imported: new Date().toISOString(), source: rel, source_hash: `sha256:${sha256(original)}`, project: projectName, tags: ["pi", "research-import"] };
  if (TEXT_EXTENSIONS.has(ext) && (ext === ".md" || ext === ".markdown")) return `${frontmatter(fields)}${original.trimEnd()}\n`;
  const lang = languageForExtension(ext);
  return `${frontmatter(fields)}# ${title}\n\nSource: \`${rel}\`\n\n\`\`\`${lang}\n${original.trimEnd()}\n\`\`\`\n`;
}

async function importResearch(ctx, params = {}, config = configFromEnv()) {
  const rawSources = splitList(params.sources || params.paths || params.files);
  const roots = rawSources.length ? rawSources.map((src) => normalizeSourcePath(ctx, src, config)) : defaultSourceRoots(ctx, config);
  const existingRoots = roots.filter((root) => {
    try { return fs.statSync(root).isDirectory(); } catch { return false; }
  });
  if (!existingRoots.length) {
    const guidance = "No research/docs source directories found. Pass explicit paths, set PI_OBSIDIAN_RESEARCH_ROOTS, or create research/ and docs/ under the current repo.";
    return toolText(guidance, { generatedAt: new Date().toISOString(), operation: "import", sources: roots, imported: [], skipped: [{ reason: guidance }] }, config);
  }
  const vault = selectedVault(ctx, params, config);
  const projectName = safeSegment(params.project || importProjectName(ctx, existingRoots), "research");
  const dryRun = params.dryRun !== false;
  const folder = safeFolder(params.folder || path.join(DEFAULT_IMPORT_FOLDER, projectName), path.join(DEFAULT_IMPORT_FOLDER, projectName));
  const all = [];
  const skipped = [];
  const globalMaxFiles = clampNumber(Number(params.maxFiles || config.maxFiles), 1, 10_000);
  const perRootMaxFiles = Math.max(1, Math.ceil(globalMaxFiles / Math.max(1, existingRoots.length)));
  for (const root of existingRoots) {
    const remaining = globalMaxFiles - all.length;
    if (remaining <= 0) {
      skipped.push({ path: root, reason: `global max-files ${globalMaxFiles} reached` });
      continue;
    }
    const walked = walkResearchFiles(root, { ...params, maxFiles: Math.min(remaining, perRootMaxFiles) }, config);
    all.push(...walked.files);
    skipped.push(...walked.skipped);
    if (walked.truncated) skipped.push({ path: root, reason: `global max-files ${globalMaxFiles} reached` });
  }
  const imported = [];
  if (!dryRun) await ensureVault(vault.path);
  for (const item of all) {
    const sourceRootBase = safeSegment(path.basename(item.root), "source");
    const rel = path.relative(item.root, item.path).replace(/\\/g, "/");
    const targetRelRaw = path.join(folder, "Sources", sourceRootBase, TEXT_EXTENSIONS.has(path.extname(item.path).toLowerCase()) && path.extname(item.path).toLowerCase().startsWith(".md") ? rel : `${rel}.md`);
    const targetRel = normalizeVaultRelative(targetRelRaw);
    const sourceRelative = path.relative(item.root, item.path).replace(/\\/g, "/");
    const markdown = importedMarkdownFor(item.path, item.root, projectName, config);
    const safety = scanMemoryContent(markdown, { maxChars: config.maxImportFileBytes + 4096 });
    if (!safety.safe) { skipped.push({ sourceId: `source_${sha256(item.path).slice(0, 16)}`, relativePath: sourceRelative, reason: `unsafe:${safety.blockingReasons.join(",")}` }); continue; }
    imported.push({ sourceId: `source_${sha256(item.path).slice(0, 16)}`, relativePath: sourceRelative, target: targetRel, bytes: item.size });
    if (!dryRun) await writeVaultFile(vault.path, targetRel, markdown);
  }
  const indexRel = normalizeVaultRelative(path.join(folder, "index.md"));
  const now = new Date().toISOString();
  const indexLines = [
    frontmatter({ title: `${projectName} research index`, created: now, project: projectName, tags: ["pi", "research-index"] }).trimEnd(),
    `# ${projectName} research index`,
    "",
    `Imported by Pi Obsidian adapter at ${now}.`,
    "",
    "## Source roots",
    ...existingRoots.map((root) => `- source-root-${sha256(root).slice(0, 16)}`),
    "",
    "## Imported files",
    ...imported.map((item) => `- [[${item.target.replace(/\.md$/i, "")}]] ← \`${item.relativePath}\` (${formatSize(item.bytes)})`),
    "",
    "## Suggested Hermes curation",
    `Run \`/obsidian-hermes ${projectName}\` to ask Hermes to cluster findings, stable claims, unresolved questions, and next experiments from these notes.`,
  ];
  const indexPayload = `${indexLines.join("\n")}\n`;
  assertMemoryContentSafe(indexPayload, { maxChars: Math.max(20_000, globalMaxFiles * 512) });
  if (!dryRun) {
    await writeVaultFile(vault.path, indexRel, indexPayload);
    recordEvent(ctx.cwd, { operation: "import", vaultPath: vault.path, project: projectName, count: imported.length, index: indexRel });
  }
  const summary = [
    `${dryRun ? "Dry run:" : "Imported"} ${imported.length} file(s) into Obsidian vault`,
    `Vault: ${vault.path}`,
    `Project: ${projectName}`,
    `Index: ${indexRel}`,
    skipped.length ? `Skipped: ${skipped.length} item(s)` : "Skipped: 0",
    dryRun ? "No files were written. Re-run with --apply or dryRun:false to import." : "Files written. Reload/open Obsidian to view notes.",
    "",
    ...imported.slice(0, 80).map((item) => `- ${item.target} ← ${item.relativePath}`),
    imported.length > 80 ? `... ${imported.length - 80} more` : "",
  ].filter(Boolean).join("\n");
  return toolText(summary, { generatedAt: now, operation: "import", dryRun, selection: publicSelection(vault), vaultPath: vault.path, project: projectName, sources: existingRoots, imported, skipped: skipped.slice(0, 500), index: indexRel }, config);
}

function walkMarkdown(vaultPath, params = {}, config = configFromEnv()) {
  const maxFiles = clampNumber(Number(params.maxFiles || config.maxFiles), 1, 10_000);
  const rootFolder = params.folder ? path.join(vaultPath, normalizeVaultRelative(params.folder)) : vaultPath;
  const files = [];
  function walk(dir) {
    if (files.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(full);
    }
  }
  walk(rootFolder);
  return files;
}

function lineSnippets(text, terms, max = 3) {
  const lines = text.split(/\r?\n/);
  const allTerm = []; const partial = [];
  for (let i = 0; i < lines.length; i++) {
    const lower = normalizeSearchText(lines[i]); const snippet = { line: i + 1, text: lines[i].slice(0, 240) };
    if (terms.every((term) => lower.includes(term))) allTerm.push(snippet);
    else if (terms.some((term) => lower.includes(term))) partial.push(snippet);
  }
  return [...allTerm, ...partial].slice(0, max);
}

function normalizeSearchText(value) { return String(value || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }
async function searchVault(ctx, params = {}, config = configFromEnv()) {
  const query = String(params.query || params.search || "").trim();
  if (!query) throw new Error("obsidian_search requires a query");
  const vault = selectedVault(ctx, params, config);
  if (!fs.existsSync(vault.path)) throw new Error(`Obsidian vault does not exist: ${vault.path}`);
  const normalizedQuery = normalizeSearchText(query); const terms = [...new Set(normalizedQuery.split(/\s+/).filter(Boolean))];
  const files = walkMarkdown(vault.path, params, config);
  const candidates = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const relativeFile = path.relative(vault.path, file).replace(/\\/g, "/"); const heading = /^#\s+(.+)$/m.exec(text)?.[1] || path.basename(file, path.extname(file)); const normalizedTitle = normalizeSearchText(heading); const normalizedFile = normalizeSearchText(relativeFile); const normalizedBody = normalizeSearchText(text); const normalizedHaystack = `${normalizedFile} ${normalizedBody}`;
    const matchedTerms = terms.filter((term) => normalizedHaystack.includes(term));
    if (!matchedTerms.length) continue;
    const exactPhrase = normalizedHaystack.includes(normalizedQuery); const titlePhrase = normalizedTitle.includes(normalizedQuery); const titleMatches = matchedTerms.filter((term) => normalizedTitle.includes(term)).length; const fileMatches = matchedTerms.filter((term) => normalizedFile.includes(term)).length; const matchCoverage = matchedTerms.length / terms.length;
    const score = (exactPhrase ? 1000 : 0) + (titlePhrase ? 500 : 0) + titleMatches * 100 + fileMatches * 30 + matchedTerms.length * 20 + Math.round(matchCoverage * 100);
    candidates.push({ file: relativeFile, snippets: lineSnippets(text, terms), bytes: Buffer.byteLength(text, "utf8"), score, exactPhrase, matchedTerms, matchCoverage: Number(matchCoverage.toFixed(3)) });
  }
  candidates.sort((a, b) => b.score - a.score || Number(b.exactPhrase) - Number(a.exactPhrase) || b.matchCoverage - a.matchCoverage || a.file.localeCompare(b.file));
  const matches = candidates.slice(0, clampNumber(Number(params.limit || 20), 1, 200)).map((match, index) => ({ ...match, rank: index + 1, rankingVersion: 1 }));
  const lines = [`Obsidian search: ${query}`, `Vault: ${vault.path}`, `Matches: ${matches.length}`, ""];
  for (const match of matches) {
    lines.push(`## ${match.file} (rank ${match.rank}; score ${match.score})`);
    for (const snippet of match.snippets) lines.push(`L${snippet.line}: ${snippet.text}`);
    if (!match.snippets.length) lines.push("(path match)");
    lines.push("");
  }
  return toolText(lines.join("\n"), { generatedAt: new Date().toISOString(), operation: "search", selection: publicSelection(vault), vaultPath: vault.path, query, rankingVersion: 1, matches }, config);
}

function gitOutput(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 3000 });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function projectInfo(cwd) {
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
  const real = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  const repoName = safeSegment(path.basename(real), "project");
  const hash = sha256(real).slice(0, 12);
  const branch = gitOutput(real, ["branch", "--show-current"]) || "unknown";
  const head = gitOutput(real, ["rev-parse", "--short", "HEAD"]) || "unknown";
  return { root: real, repoName, projectKey: `pi:${repoName}:${hash}`, branch, head };
}

function collectVaultDigest(vaultPath, topic, params = {}, config = configFromEnv()) {
  const files = walkMarkdown(vaultPath, params, config);
  const terms = String(topic || "").toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  const skippedUnsafe = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const noteRef = path.relative(vaultPath, file).replace(/\\/g, "/");
    const lower = `${noteRef}\n${text}`.toLowerCase();
    const score = terms.length ? terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0) : 1;
    if (score > 0) scored.push({ noteRef, text, contentHash: `sha256:${sha256(text)}`, score, mtimeMs: fs.statSync(file).mtimeMs });
  }
  scored.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
  let budget = config.maxHermesInputChars;
  const sources = [];
  for (const item of scored.slice(0, clampNumber(Number(params.maxFiles || 40), 1, 200))) {
    const headings = item.text.split(/\r?\n/).filter((line) => /^#{1,3}\s+/.test(line)).slice(0, 12).join("\n");
    const excerpt = [headings, item.text.slice(0, 2400)].filter(Boolean).join("\n\n");
    const scan = scanMemoryContent(excerpt, { maxChars: 3200 });
    if (!scan.safe) { skippedUnsafe.push({ noteRefHash: `sha256:${sha256(item.noteRef)}`, reasons: scan.blockingReasons }); continue; }
    const bytes = excerpt.length + item.noteRef.length + item.contentHash.length;
    if (budget - bytes < 0) break;
    sources.push({ noteRef: item.noteRef, contentHash: item.contentHash, excerpt });
    budget -= bytes;
  }
  return { filesConsidered: files.length, filesIncluded: sources.length, sources, skippedUnsafe, digestHash: `sha256:${sha256(sources.map((item) => `${item.noteRef}:${item.contentHash}`).join("|"))}` };
}

function classifyHermesFailure(error) {
  const text = `${String(error?.message || error || "")} ${String(error?.code || "")}`.toLowerCase();
  const category = error?.category || (/auth|credential|401|403|login/.test(text) ? "authentication" : /timeout|deadline/.test(text) ? "timeout" : /network|socket|transport|econn|dns/.test(text) ? "transport" : /enoent|not found|executable/.test(text) ? "missing-binary" : /unsafe|privacy|forbidden/.test(text) ? "privacy" : "unknown");
  const codes = { timeout: "OBSIDIAN_HERMES_TIMEOUT", authentication: "OBSIDIAN_HERMES_AUTH", transport: "OBSIDIAN_HERMES_TRANSPORT", "missing-binary": "OBSIDIAN_HERMES_NOT_INSTALLED", privacy: "OBSIDIAN_HERMES_PRIVACY" };
  return { code: codes[category] || "OBSIDIAN_HERMES_FAILED", category };
}
async function probeHermesAuthentication(cwd, config = configFromEnv(), options = {}, signal, hermes) {
  if (!hermes) throw new Error("Hermes advisory adapter must be supplied through the integration boundary");
  const adapter = hermes;
  const result = await adapter.probeAuth({ timeoutMs: options.timeoutMs || config.hermesAuthProbeTimeoutMs, signal });
  return { ...result, errorCode: result.errorCode || null };
}

async function hermesCurateUnlocked(ctx, params = {}, signal, config = configFromEnv(), hermes, projectMemoryFactory) {
  if (!config.hermesEnabled) throw new Error("Hermes-backed Obsidian curation is disabled with PI_HERMES_ADVISORY=0.");
  if (!hermes) throw new Error("Hermes advisory adapter must be supplied through the integration boundary");
  const adapter = hermes;
  const vault = selectedVault(ctx, params, config);
  if (!fs.existsSync(vault.path)) throw new Error(`Obsidian vault does not exist: ${vault.path}`);
  const info = projectInfo(ctx.cwd || process.cwd());
  const topic = String(params.topic || params.query || "research memory").trim();
  const collected = collectVaultDigest(vault.path, topic, params, config);
  const dryRun = params.dryRun !== false;
  if (!dryRun && params.userAuthorized !== true) {
    const error = new Error("Hermes curation apply requires explicit current-user authorization.");
    error.code = "OBSIDIAN_HERMES_USER_AUTHORIZATION_REQUIRED";
    throw error;
  }
  const started = Date.now();
  let result;
  try {
    result = await adapter.curateCandidate({ projectKey: info.projectKey, topic, sources: collected.sources }, { signal, timeoutMs: params.timeoutMs || config.hermesTimeoutMs });
  } catch (error) {
    const failure = classifyHermesFailure(error);
    recordEvent(ctx.cwd, { operation: "hermes", outcome: "failed", category: failure.category, errorCode: failure.code, durationMs: Date.now() - started, dryRun });
    throw error;
  }
  const candidates = result.value.candidates.map((candidate) => ({ ...candidate, sourceFingerprints: candidate.sourceHashes }));
  const applied = [];
  if (!dryRun) {
    if (typeof projectMemoryFactory !== "function") {
      const error = new Error("Canonical project-memory review service is unavailable; Hermes output remains a draft.");
      error.code = "OBSIDIAN_PROJECT_MEMORY_UNAVAILABLE";
      throw error;
    }
    const service = await projectMemoryFactory(ctx, params);
    if (!service?.rollout?.controls?.hermesCuration) {
      const error = new Error("Project-memory Hermes curation is not authorized by the current rollout stage.");
      error.code = "OBSIDIAN_HERMES_ROLLOUT_BLOCKED";
      throw error;
    }
    for (const candidate of candidates) {
      const memoryCandidate = { kind: candidate.kind, title: candidate.title, content: candidate.content, verification: "unverified", sourceFingerprints: [...candidate.sourceFingerprints, `hermes-receipt:${result.receipt.receiptId}`], evidenceIds: candidate.evidenceIds, expiresAt: candidate.expiresAt };
      applied.push(await Promise.resolve(service.adapter.consider(memoryCandidate, { queueReview: true, apply: true, automatic: false })));
    }
  }
  const durationMs = Date.now() - started;
  recordEvent(ctx.cwd, { operation: "hermes", outcome: "succeeded", category: "curation-candidate", durationMs, dryRun, filesIncluded: collected.filesIncluded, candidateCount: candidates.length, receiptId: result.receipt.receiptId });
  const lines = [dryRun ? "Hermes project-memory candidates generated (dry run; no memory was written)." : "Hermes project-memory candidates submitted to the governed review queue.", `Topic: ${topic}`, `Safe source extracts: ${collected.filesIncluded}/${collected.filesConsidered}`, `Unsafe extracts skipped: ${collected.skippedUnsafe.length}`, `Candidates: ${candidates.length}`, `Receipt: ${result.receipt.receiptId}`, "", ...candidates.flatMap((candidate) => [`## [${candidate.kind}] ${candidate.title}`, candidate.content, `Sources: ${candidate.sourceHashes.join(", ")}`, "`verification: unverified`", ""] )];
  return toolText(lines.join("\n"), { generatedAt: new Date().toISOString(), operation: "hermes", selection: publicSelection(vault), topic, projectKey: info.projectKey, digest: { filesConsidered: collected.filesConsidered, filesIncluded: collected.filesIncluded, sourceHashes: collected.sources.map((item) => item.contentHash), digestHash: collected.digestHash, unsafeSkipped: collected.skippedUnsafe.length }, candidates, applied, receipt: result.receipt, dryRun, outcome: "succeeded", durationMs }, config);
}
function recordHermesCurationReview(ctx, params = {}, config = configFromEnv(), hermes) {
  if (params.userAuthorized !== true) { const error = new Error("Hermes curation review requires an explicit current-user command"); error.code = "OBSIDIAN_HERMES_REVIEW_AUTHORIZATION_REQUIRED"; throw error; }
  if (!hermes) throw new Error("Hermes advisory adapter must be supplied through the integration boundary");
  const decision = String(params.decision || "").trim().toLowerCase();
  const receiptId = String(params.receiptId || "").trim();
  const disposition = hermes.recordCurationReview({ receiptId, decision, sessionHash: params.sessionHash });
  recordEvent(ctx.cwd, { operation: "hermes-review-outcome", outcome: "recorded", curationReceiptId: receiptId, decision, receiptBound: true, advisorySourceVersion: disposition.sourceVersion });
  return toolText(`Recorded governed Hermes curation review: ${decision} (${receiptId}).\nThis records review evidence only; it does not promote canonical memory.`, { generatedAt: new Date().toISOString(), operation: "hermes-review", outcome: "recorded", curationReceiptId: receiptId, decision, receiptBound: true, canonicalPromotionApplied: false }, config);
}
const curationQueues = new Map();
async function hermesCurate(ctx, params = {}, signal, config = configFromEnv(), hermes, projectMemoryFactory) {
  const key = `${path.resolve(ctx.cwd || process.cwd())}:${String(params.topic || params.query || "research memory").trim().toLowerCase()}`;
  const prior = curationQueues.get(key) || Promise.resolve();
  const run = prior.catch(() => {}).then(() => hermesCurateUnlocked(ctx, params, signal, config, hermes, projectMemoryFactory));
  curationQueues.set(key, run);
  try { return await run; } finally { if (curationQueues.get(key) === run) curationQueues.delete(key); }
}

async function probeHermesCuration(ctx, params = {}, signal, config = configFromEnv(), hermes) {
  const vault = selectedVault(ctx, params, config);
  if (!vault.exists) return { ready: false, status: "not-ready", category: "vault-filesystem", durationMs: 0, filesIncluded: 0, noteWritten: false };
  if (!hermes) throw new Error("Hermes advisory adapter must be supplied through the integration boundary");
  const adapter = hermes;
  return adapter.probeCuration({ timeoutMs: params.timeoutMs || config.hermesCurationProbeTimeoutMs, signal });
}

async function openObsidian(ctx, params = {}, config = configFromEnv()) {
  if (!executableInfo(config.bin).found) throw new Error(friendlyMissingBinaryMessage(config));
  const vault = selectedVault(ctx, params, config);
  const file = params.file ? normalizeVaultRelative(params.file).replace(/\.md$/i, "") : undefined;
  const vaultName = path.basename(vault.path);
  const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}${file ? `&file=${encodeURIComponent(file)}` : ""}`;
  const child = spawn(config.bin, [uri], { detached: true, stdio: "ignore" });
  child.unref();
  return toolText(`Requested Obsidian open: ${uri}`, { generatedAt: new Date().toISOString(), operation: "open", selection: publicSelection(vault), vaultPath: vault.path, uri }, config);
}

function createObsidianAdapter(overrides = {}) {
  const config = configFromEnv(process.env, overrides);
  const hermesMaybeFor = (ctx) => overrides.hermesAdapterFactory?.(ctx) || overrides.hermesAdapter || null;
  const hermesFor = (ctx) => { const adapter = hermesMaybeFor(ctx); if (!adapter) throw new Error("Hermes advisory adapter must be supplied through the integration boundary"); return adapter; };
  const projectMemoryFactory = overrides.projectMemoryFactory;
  async function status(ctx, params = {}) {
    const hermes = hermesMaybeFor(ctx);
    const snapshot = obsidianProjectSnapshot(ctx.cwd, { ...config, ...params, hermesReadiness: hermes?.localReadiness() });
    const lines = [
      "Obsidian adapter status",
      `enabled: ${snapshot.enabled}`,
      `binary: ${snapshot.binary.found ? snapshot.binary.path : `missing (${snapshot.binary.bin})`}`,
      `vault: ${snapshot.vault?.path || "unresolved"}`,
      `selection: ${snapshot.selection?.selectionId || "unresolved"} (${snapshot.selection?.source || "unknown"}; project=${snapshot.selection?.projectKey || "unknown"})`,
      `vault exists: ${snapshot.vault?.exists ? "yes" : "no"}`,
      `vault marker: ${snapshot.vault?.isVault ? "yes" : "no"}`,
      `Obsidian desktop: ${snapshot.readiness?.desktopExecutable?.status || "unknown"}; open=${snapshot.readiness?.desktopOpen?.status || "unknown"}`,
      `Local Markdown: ${snapshot.readiness?.localMarkdown?.status || "unknown"}`,
      `Hermes executable: ${snapshot.readiness?.hermesExecutable?.status || (snapshot.hermesEnabled ? "unknown" : "disabled")}`,
      `Hermes authentication: ${snapshot.readiness?.hermesAuthentication?.status || "unknown"}`,
      `Provider/model: ${snapshot.readiness?.providerModel?.status || "unknown"}`,
      `Curation: ${snapshot.readiness?.curation?.status || "unknown"}`,
      `state: ${snapshot.statePath}`,
    ];
    if (snapshot.guidance.length) lines.push("", "Guidance:", ...snapshot.guidance.map((g) => `- ${g}`));
    return toolText(lines.join("\n"), { generatedAt: new Date().toISOString(), operation: "status", ...snapshot }, config);
  }
  async function doctor(ctx, params = {}, signal) {
    const wantsAuthProbe = params.probeAuth === true || params.probeCuration === true;
    const hermes = hermesMaybeFor(ctx);
    const details = obsidianDoctor(ctx.cwd, { ...config, ...params, hermesReadiness: hermes?.localReadiness() });
    if (wantsAuthProbe) {
      const authProbe = await probeHermesAuthentication(ctx.cwd, config, { timeoutMs: params.timeoutMs }, signal, hermesFor(ctx));
      details.authProbe = authProbe;
      details.readiness.hermesAuthentication = { ready: authProbe.ready, status: authProbe.status, category: authProbe.category };
      details.readiness.providerModel = authProbe.providerModel;
      const curationEligible = Boolean(details.readiness.localMarkdown.ready && details.readiness.hermesExecutable.ready && authProbe.ready && authProbe.providerModel.ready);
      details.curationReady = false;
      details.readiness.curation = { ready: false, eligible: curationEligible, status: curationEligible ? "not-probed" : "not-ready", reasons: [!details.readiness.localMarkdown.ready ? "vault-filesystem-not-ready" : null, !details.readiness.hermesExecutable.ready ? "hermes-executable-not-ready" : null, !authProbe.ready ? `hermes-auth-${authProbe.category}` : null, !authProbe.providerModel.ready ? "provider-model-not-ready" : null, curationEligible ? "curation-smoke-not-run" : null].filter(Boolean) };
      recordEvent(ctx.cwd, { operation: "hermes-auth-probe", outcome: authProbe.ready ? "succeeded" : "failed", category: authProbe.category, errorCode: authProbe.errorCode || null, durationMs: authProbe.durationMs });
    }
    if (params.probeCuration === true) {
      details.curationProbe = details.readiness.curation.eligible ? await probeHermesCuration(ctx, params, signal, config, hermesFor(ctx)) : { ready: false, status: "not-run", category: "authentication-not-ready", durationMs: 0, filesIncluded: 0, noteWritten: false };
      details.curationReady = Boolean(details.readiness.curation.eligible && details.curationProbe.ready);
      details.readiness.curation = { ready: details.curationReady, status: details.curationReady ? "ready" : "not-ready", reasons: details.curationReady ? [] : [details.curationProbe.category] };
    }
    details.hermesEvidence = hermes?.localReadiness().shared || details.readiness.sharedHermes;
    details.curationReady = Boolean(details.curationReady && details.hermesEvidence.curationReady);
    details.readiness.curation.proofCurrent = details.hermesEvidence.curationReady;
    details.recommendations = (details.recommendations || []).filter((item) => !/Hermes curation is (?:not )?ready/.test(item));
    details.recommendations.push(details.curationReady ? "Hermes curation is ready for explicit dry-run or write requests." : "Hermes curation is not ready; use probeAuth/probeCuration diagnostics and resolve the reported category.");
    return toolText(formatDoctor(details), details, config);
  }
  return {
    config,
    status,
    doctor,
    probeHermesAuthentication: (ctx, params = {}, signal) => probeHermesAuthentication(ctx.cwd, config, params, signal, hermesFor(ctx)),
    probeHermesCuration: (ctx, params = {}, signal) => probeHermesCuration(ctx, params, signal, config, hermesFor(ctx)),
    note: (ctx, params = {}) => writeObsidianNote(ctx, params, config),
    importResearch: (ctx, params = {}) => importResearch(ctx, params, config),
    search: (ctx, params = {}) => searchVault(ctx, params, config),
    hermes: (ctx, params = {}, signal) => hermesCurate(ctx, params, signal, config, hermesFor(ctx), projectMemoryFactory),
    reviewHermesCuration: (ctx, params = {}) => recordHermesCurationReview(ctx, params, config, hermesFor(ctx)),
    open: (ctx, params = {}) => openObsidian(ctx, params, config),
    resolveVaultPath: (ctx, p) => resolveVaultPath(ctx, p, config),
    resolveVaultSelection: (ctx, params = {}) => resolveVaultSelection(ctx, params, config),
    normalizeSourcePath: (ctx, p) => normalizeSourcePath(ctx, p, config),
  };
}

module.exports = {
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_IMPORT_FILE_BYTES,
  STATE_DIR,
  configFromEnv,
  createObsidianAdapter,
  obsidianProjectSnapshot,
  obsidianDoctor,
  buildObsidianReadiness,
  buildProjectMemoryReadiness,
  resolveVaultSelection,
  probeHermesAuthentication,
  probeHermesCuration,
  classifyHermesFailure,
  formatDoctor,
  parseCliArgs,
  splitArgs,
  stripAt,
  truncateHead,
  formatSize,
  executableInfo,
  friendlyMissingBinaryMessage,
  friendlyMissingHermesMessage,
  discoverVaultCandidates,
  normalizeVaultRelative,
  normalizeSourcePath,
  resolveVaultPath,
  safeSegment,
  safeFolder,
};
