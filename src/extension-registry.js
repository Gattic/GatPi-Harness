"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const REGISTRY_SCHEMA_VERSION = 3;
const SOURCE_EXTENSIONS = /\.(?:ts|js|mts|mjs|cts|cjs)$/i;

function sha256(text) { return crypto.createHash("sha256").update(String(text || "")).digest("hex"); }
function exists(file) { try { fs.accessSync(file); return true; } catch { return false; } }
function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } }
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function stat(file) { try { return fs.statSync(file); } catch { return null; } }
function canonical(file) { try { return fs.realpathSync(file); } catch { return path.resolve(file); } }
function normalizePath(file) { return path.resolve(String(file || "").replace(/^~(?=$|[\\/])/, os.homedir())); }
function uniq(values) { return Array.from(new Set(values.filter(Boolean))); }
function matches(text, re, group = 1) { const out = []; let match; while ((match = re.exec(text))) out.push(match[group]); return uniq(out); }
function sum(items, key) { return items.reduce((total, item) => total + (item[key]?.length || 0), 0); }

function extensionFiles(root) {
  if (!exists(root)) return [];
  const rootStat = stat(root);
  if (rootStat?.isFile() && SOURCE_EXTENSIONS.test(root)) {
    const stem = path.basename(root).replace(SOURCE_EXTENSIONS, "");
    return [{ name: stem === "index" ? path.basename(path.dirname(root)) : stem, file: root }];
  }
  if (!rootStat?.isDirectory()) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    const itemStat = stat(full);
    if (!itemStat) continue;
    if (itemStat.isFile() && SOURCE_EXTENSIONS.test(name)) out.push({ name: name.replace(SOURCE_EXTENSIONS, ""), file: full });
    if (itemStat.isDirectory()) {
      for (const entry of ["index.ts", "index.js", "index.mts", "index.mjs", "index.cts", "index.cjs"]) {
        if (exists(path.join(full, entry))) { out.push({ name, file: path.join(full, entry) }); break; }
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
}

function configuredExtensionRoots({ cwd = process.cwd(), settingsPath, settings, extensionPaths, globalDir, env = process.env } = {}) {
  const effectiveSettingsPath = settingsPath || env.PI_SETTINGS_FILE || path.join(os.homedir(), ".pi", "agent", "settings.json");
  const config = settings === false ? null : settings || readJson(effectiveSettingsPath, null);
  const configured = extensionPaths || config?.extensions || config?.extensionPaths || config?.extension_paths || [];
  const entries = Array.isArray(configured) ? configured : [configured];
  if (!entries.length) entries.push(path.join(cwd, ".pi", "extensions"), globalDir || path.join(os.homedir(), ".pi", "agent", "extensions"));
  const roots = [];
  const seen = new Set();
  for (const entry of entries) {
    const raw = typeof entry === "string" ? entry : entry?.path || entry?.file || entry?.directory;
    if (!raw) continue;
    const resolved = normalizePath(path.isAbsolute(raw) ? raw : path.resolve(path.dirname(effectiveSettingsPath), raw));
    const key = canonical(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    const itemStat = stat(resolved);
    const insideProject = key === canonical(cwd) || key.startsWith(`${canonical(cwd)}${path.sep}`);
    roots.push({
      configuredPath: resolved,
      scope: insideProject ? "project" : "user",
      enabled: typeof entry === "object" ? entry.enabled !== false : true,
      exists: Boolean(itemStat),
      kind: itemStat?.isDirectory() ? "directory" : itemStat?.isFile() ? "file" : "missing",
      reason: itemStat ? null : "configured-path-missing",
    });
  }
  return { settingsPath: effectiveSettingsPath, roots };
}

function envGateRecords(text, env = process.env) {
  const gates = [];
  const add = (name, mode, expected) => {
    const current = env[name];
    const enabled = mode === "equals" ? current === expected : mode === "not-equals" ? current !== expected : null;
    gates.push({ name, mode, expected, state: enabled === true ? "enabled" : enabled === false ? "disabled" : "unknown" });
  };
  // Guard clauses invert their comparison: `if (X !== "1") return` means
  // the extension is eligible only when X equals "1".
  for (const match of text.matchAll(/if\s*\(\s*process\.env\.([A-Z0-9_]+)\s*!={1,2}\s*["'`]([^"'`]+)["'`]\s*\)\s*(?:\{[^}]{0,300}\breturn\b|return\b)/g)) add(match[1], "equals", match[2]);
  for (const match of text.matchAll(/if\s*\(\s*process\.env\.([A-Z0-9_]+)\s*={2,3}\s*["'`]([^"'`]+)["'`]\s*\)\s*(?:\{[^}]{0,300}\breturn\b|return\b)/g)) add(match[1], "not-equals", match[2]);
  // ENABLED-style declarations use the comparison directly.
  for (const match of text.matchAll(/(?:const|let|var)\s+[A-Z0-9_]*ENABLED[A-Z0-9_]*\s*=\s*process\.env\.([A-Z0-9_]+)\s*!={1,2}\s*["'`]([^"'`]+)["'`]/g)) add(match[1], "not-equals", match[2]);
  for (const match of text.matchAll(/(?:const|let|var)\s+[A-Z0-9_]*ENABLED[A-Z0-9_]*\s*=\s*process\.env\.([A-Z0-9_]+)\s*={2,3}\s*["'`]([^"'`]+)["'`]/g)) add(match[1], "equals", match[2]);
  return Array.from(new Map(gates.map((gate) => [`${gate.name}:${gate.mode}:${gate.expected}`, gate])).values()).sort((a, b) => a.name.localeCompare(b.name));
}

function staticSurfaceInventory(text) {
  const commands = matches(text, /(?:\bpi|\bcommandPi)\.registerCommand\(\s*["'`]([^"'`]+)["'`]/g);
  const directTools = matches(text, /(?:\bpi|\bcommandPi)\.registerTool\(\s*\{[\s\S]{0,2000}?\bname:\s*["'`]([^"'`]+)["'`]/g);
  const helperTools = matches(text, /registerOperationTool\(\s*(?:pi|commandPi)\s*,\s*\{[\s\S]{0,2000}?\bname:\s*["'`]([^"'`]+)["'`]/g);
  return { commands, tools: uniq([...directTools, ...helperTools]), helperTools };
}

function inspectExtension(item, scope, cwd = process.cwd(), options = {}) {
  const text = readText(item.file);
  const surfaces = staticSurfaceInventory(text);
  const env = uniq([
    ...matches(text, /process\.env\.([A-Z0-9_]+)/g),
    ...matches(text, /process\.env\[["'`]([A-Z0-9_]+)["'`]\]/g),
  ]).sort();
  const envGates = envGateRecords(text, options.env || process.env);
  const disabledGate = envGates.find((gate) => gate.state === "disabled");
  const childOnly = item.name === "role-sidecar" || env.includes("PI_ROLE_SIDECAR") || /child[- ]only/i.test(text);
  return {
    name: item.name,
    scope,
    file: path.resolve(item.file),
    relativeFile: path.relative(cwd, item.file).replace(/\\/g, "/"),
    bytes: Buffer.byteLength(text),
    sha256: sha256(text).slice(0, 16),
    declared: { commands: surfaces.commands, tools: surfaces.tools, helperTools: surfaces.helperTools },
    commands: surfaces.commands,
    tools: surfaces.tools,
    events: matches(text, /pi\.on\(\s*["'`]([^"'`]+)["'`]/g),
    env,
    envGates,
    childOnly,
    eligibility: disabledGate ? "ineligible" : envGates.length ? "eligible" : "unconditional",
    eligibilityReason: disabledGate ? `env-gate-disabled:${disabledGate.name}` : childOnly ? "child-only-extension" : envGates.length ? "env-gates-satisfied" : "no-static-env-gate",
    imports: uniq([
      ...matches(text, /from\s+["'`]([^"'`]+)["'`]/g),
      ...matches(text, /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g),
    ]).sort(),
  };
}

function runtimeSurfaces(runtime = {}) {
  const active = new Set((runtime.activeTools || []).map(String));
  const tools = (runtime.tools || []).filter((tool) => tool?.name && !["builtin", "sdk"].includes(tool.sourceInfo?.source)).map((tool) => ({
    kind: "tool",
    name: String(tool.name),
    active: active.has(String(tool.name)),
    source: String(tool.sourceInfo?.source || "unknown"),
    scope: String(tool.sourceInfo?.scope || "unknown"),
    path: tool.sourceInfo?.path ? path.resolve(String(tool.sourceInfo.path)) : null,
  }));
  const commands = (runtime.commands || []).filter((command) => command?.name && (!command.source || command.source === "extension")).map((command) => ({
    kind: "command",
    name: String(command.name),
    baseName: String(command.name).replace(/:\d+$/, ""),
    active: true,
    source: String(command.sourceInfo?.source || command.source || "extension"),
    scope: String(command.sourceInfo?.scope || "unknown"),
    path: command.sourceInfo?.path ? path.resolve(String(command.sourceInfo.path)) : null,
  }));
  return { available: runtime.available !== false && (Array.isArray(runtime.tools) || Array.isArray(runtime.commands)), tools, commands, errors: runtime.errors || [] };
}

function sourceMatches(extension, surface) {
  if (!surface.path) return false;
  const source = canonical(surface.path);
  const file = canonical(extension.file);
  return source === file || source === canonical(path.dirname(file));
}

function reconcileExtensions(extensions, runtime) {
  const allSurfaces = [...runtime.tools, ...runtime.commands];
  const unmatched = new Set(allSurfaces);
  for (const extension of extensions) {
    const observed = allSurfaces.filter((surface) => sourceMatches(extension, surface));
    for (const surface of observed) unmatched.delete(surface);
    const registeredCommands = observed.filter((surface) => surface.kind === "command").map((surface) => surface.name);
    const registeredTools = observed.filter((surface) => surface.kind === "tool").map((surface) => surface.name);
    const activeTools = observed.filter((surface) => surface.kind === "tool" && surface.active).map((surface) => surface.name);
    let status = "unknown"; let reason = "runtime-metadata-unavailable";
    if (extension.eligibility === "ineligible") { status = "inactive"; reason = extension.eligibilityReason; }
    else if (!runtime.available) { status = "unknown"; reason = "runtime-metadata-unavailable"; }
    else if (observed.length) { status = "loaded"; reason = "runtime-registration-observed"; }
    else if (extension.commands.length || extension.tools.length) { status = "degraded"; reason = extension.childOnly ? "child-only-not-loaded-in-parent" : "declared-surfaces-not-registered"; }
    else { status = "unknown"; reason = "no-runtime-registration-surface"; }
    extension.runtime = { status, reason, registeredCommands, registeredTools, activeTools };
  }
  const unexplained = Array.from(unmatched).filter((surface) => !["builtin", "sdk"].includes(surface.source)).map((surface) => ({ kind: surface.kind, name: surface.name, reason: "runtime-source-not-configured", source: surface.source }));
  return { unexplained, unmatchedRuntimeSurfaces: unexplained.length };
}

function conflictReport(extensions, runtime = { commands: [], tools: [] }) {
  const collect = (pairs) => Array.from(pairs.entries()).filter(([, owners]) => owners.length > 1).map(([name, owners]) => ({ name, owners: uniq(owners) }));
  const byCommand = new Map(); const byTool = new Map();
  for (const extension of extensions) {
    for (const command of extension.commands) { const owners = byCommand.get(command) || []; owners.push(extension.name); byCommand.set(command, owners); }
    for (const tool of extension.tools) { const owners = byTool.get(tool) || []; owners.push(extension.name); byTool.set(tool, owners); }
  }
  const runtimeCommands = new Map(); const runtimeTools = new Map();
  for (const command of runtime.commands || []) { const owners = runtimeCommands.get(command.baseName) || []; owners.push(command.path || command.source); runtimeCommands.set(command.baseName, owners); }
  for (const tool of runtime.tools || []) { const owners = runtimeTools.get(tool.name) || []; owners.push(tool.path || tool.source); runtimeTools.set(tool.name, owners); }
  return {
    commandConflicts: collect(byCommand),
    toolConflicts: collect(byTool),
    runtimeCommandConflicts: collect(runtimeCommands),
    runtimeToolConflicts: collect(runtimeTools),
  };
}

function scanExtensionRegistry(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const configured = configuredExtensionRoots({ ...options, cwd });
  const extensions = [];
  const seenFiles = new Set();
  for (const root of configured.roots) {
    if (!root.enabled || !root.exists) continue;
    for (const item of extensionFiles(root.configuredPath)) {
      const file = canonical(item.file);
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      const inspected = inspectExtension(item, root.scope, cwd, options);
      inspected.configuredRoot = root.configuredPath;
      extensions.push(inspected);
    }
  }
  extensions.sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
  const runtime = runtimeSurfaces(options.runtime || {});
  const reconciliation = reconcileExtensions(extensions, runtime);
  const conflicts = conflictReport(extensions, runtime);
  const conflictCount = Object.values(conflicts).reduce((total, rows) => total + rows.length, 0);
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    cwd,
    settingsPath: configured.settingsPath,
    configuredRoots: configured.roots,
    extensions,
    runtime,
    reconciliation,
    conflicts,
    summary: {
      configuredRoots: configured.roots.length,
      missingRoots: configured.roots.filter((root) => !root.exists).length,
      extensions: extensions.length,
      loaded: extensions.filter((extension) => extension.runtime.status === "loaded").length,
      degraded: extensions.filter((extension) => extension.runtime.status === "degraded").length,
      conditional: extensions.filter((extension) => extension.envGates.length || extension.childOnly).length,
      commands: sum(extensions, "commands"),
      tools: sum(extensions, "tools"),
      registeredCommands: runtime.commands.length,
      registeredTools: runtime.tools.length,
      activeTools: runtime.tools.filter((tool) => tool.active).length,
      events: sum(extensions, "events"),
      envKnobs: uniq(extensions.flatMap((extension) => extension.env)).length,
      conflicts: conflictCount,
      unexplainedDiscrepancies: reconciliation.unexplained.length,
    },
  };
}

function smokePlan(registry) {
  return registry.extensions.map((extension) => ({ extension: extension.name, scope: extension.scope, status: extension.runtime.status, command: extension.scope === "project" ? `pi -p --no-extensions -e ${extension.relativeFile} 'say only ok'` : `pi -p --no-extensions -e ${extension.file} 'say only ok'`, commands: extension.commands.length, tools: extension.tools.length }));
}

function renderRegistryMarkdown(registry) {
  const lines = ["# Pi extension inventory", "", `Generated: ${registry.generatedAt}`, `Schema: ${registry.schemaVersion}`, "", `Configured roots: ${registry.summary.configuredRoots}`, `Extensions: ${registry.summary.extensions}`, `Loaded (runtime observed): ${registry.summary.loaded}`, `Declared commands/tools: ${registry.summary.commands}/${registry.summary.tools}`, `Registered commands/tools: ${registry.summary.registeredCommands}/${registry.summary.registeredTools}`, `Active tools: ${registry.summary.activeTools}`, `Unexplained discrepancies: ${registry.summary.unexplainedDiscrepancies}`, `Conflicts: ${registry.summary.conflicts}`, "", "## Extensions", ""];
  for (const extension of registry.extensions) {
    lines.push(`### ${extension.name} (${extension.scope})`, "", `- File: \`${extension.relativeFile || extension.file}\``, `- SHA-256: \`${extension.sha256}\``, `- Runtime: ${extension.runtime.status} (${extension.runtime.reason})`, `- Commands: ${extension.commands.length ? extension.commands.map((command) => `\`/${command}\``).join(", ") : "none"}`, `- Tools: ${extension.tools.length ? extension.tools.map((tool) => `\`${tool}\``).join(", ") : "none"}`, `- Active tools: ${extension.runtime.activeTools.length ? extension.runtime.activeTools.map((tool) => `\`${tool}\``).join(", ") : "none"}`, `- Env gates: ${extension.envGates.length ? extension.envGates.map((gate) => `\`${gate.name}:${gate.state}\``).join(", ") : "none"}`, "");
  }
  return lines.join("\n");
}

module.exports = {
  REGISTRY_SCHEMA_VERSION,
  extensionFiles,
  configuredExtensionRoots,
  staticSurfaceInventory,
  inspectExtension,
  runtimeSurfaces,
  scanExtensionRegistry,
  conflictReport,
  smokePlan,
  renderRegistryMarkdown,
};
