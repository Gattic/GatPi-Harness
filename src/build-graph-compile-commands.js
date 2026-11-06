"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function splitCommand(command) { const out = []; const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g; let match; while ((match = re.exec(command || ""))) out.push((match[1] ?? match[2] ?? match[3]).replace(/\\(["'\\ ])/g, "$1")); return out; }
function inside(root, value) { const relative = path.relative(root, value); return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative); }
function relativePath(root, value, directory = root) { const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(directory, value); return inside(root, absolute) ? path.relative(root, absolute).replace(/\\/g, "/") : null; }
function discoverCompilationDatabases(root, options = {}) {
  const candidates = [path.join(root, "compile_commands.json")];
  for (const buildDir of options.buildDirs || ["build", "out", "cmake-build-debug", "cmake-build-release"]) {
    const absolute = path.resolve(root, buildDir);
    if (!inside(root, absolute)) continue;
    candidates.push(path.join(absolute, "compile_commands.json"));
    try { for (const child of fs.readdirSync(absolute).slice(0, 50)) candidates.push(path.join(absolute, child, "compile_commands.json")); } catch {}
  }
  return Array.from(new Set(candidates.filter((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } }))).sort();
}
function redactDefine(value) {
  const match = String(value).match(/^-D([^=]+)(?:=(.*))?$/);
  if (!match) return value;
  if (/secret|token|password|passwd|credential|api[_-]?key|private[_-]?key/i.test(match[1])) return `-D${match[1]}=<redacted>`;
  return value.length > 240 ? `${value.slice(0, 220)}…` : value;
}
function summarizeFlags(args, root, directory) {
  const defines = [], includes = [], flags = [];
  let output = null, language = null;
  for (let i = 1; i < args.length; i++) {
    const arg = String(args[i]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) continue;
    if (arg === "-o" && args[i + 1]) { output = relativePath(root, args[++i], directory) || `external:${hash(args[i]).slice(0, 12)}`; continue; }
    if (arg.startsWith("-o") && arg.length > 2) { output = relativePath(root, arg.slice(2), directory) || `external:${hash(arg.slice(2)).slice(0, 12)}`; continue; }
    if (arg === "-I" && args[i + 1]) { const include = relativePath(root, args[++i], directory); includes.push(include || `external:${hash(args[i]).slice(0, 12)}`); continue; }
    if (arg.startsWith("-I") && arg.length > 2) { const include = relativePath(root, arg.slice(2), directory); includes.push(include || `external:${hash(arg.slice(2)).slice(0, 12)}`); continue; }
    if (arg === "-isystem" && args[i + 1]) { const include = relativePath(root, args[++i], directory); includes.push(include || `external:${hash(args[i]).slice(0, 12)}`); continue; }
    if (arg === "-D" && args[i + 1]) { defines.push(redactDefine(`-D${args[++i]}`)); continue; }
    if (arg.startsWith("-D")) { defines.push(redactDefine(arg)); continue; }
    if (arg === "-x" && args[i + 1]) { language = String(args[++i]); flags.push(`-x=${language}`); continue; }
    if (/^(?:-std=|-O[0-9sg]?|-g\d*|-f(?:no-)?[A-Za-z0-9_-]+|--target=|-m(?:arch|cpu)=|-pthread$)/.test(arg)) flags.push(arg.slice(0, 240));
  }
  return { defines: Array.from(new Set(defines)).sort(), includes: Array.from(new Set(includes)).sort(), flags: Array.from(new Set(flags)).sort(), output, language };
}
function inferLanguage(file, explicit) { if (explicit) return explicit; const ext = path.extname(file).toLowerCase(); if ([".c"].includes(ext)) return "c"; if ([".cu", ".cuh"].includes(ext)) return "cuda"; return "cpp"; }
function parseCompilationDatabase(root, file) {
  let entries;
  try { entries = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { return { provider: "compile-commands", source: file, facts: [], commands: [], degradation: { code: "malformed_compile_commands", message: error.message, retryable: false } }; }
  if (!Array.isArray(entries)) return { provider: "compile-commands", source: file, facts: [], commands: [], degradation: { code: "malformed_compile_commands", message: "compile_commands.json must contain an array", retryable: false } };
  const facts = [], commands = [];
  for (const entry of entries) {
    const directory = path.isAbsolute(entry.directory || "") ? path.resolve(entry.directory) : path.resolve(root, entry.directory || ".");
    const source = relativePath(root, entry.file, directory);
    if (!source) continue;
    const args = Array.isArray(entry.arguments) ? entry.arguments.map(String) : splitCommand(entry.command);
    if (!args.length) continue;
    const summary = summarizeFlags(args, root, directory);
    const commandHash = hash({ directory: inside(root, directory) ? path.relative(root, directory).replace(/\\/g, "/") : `external:${hash(directory).slice(0, 12)}`, compiler: path.basename(args[0]), args: summary, source });
    const configuration = hash({ defines: summary.defines, includes: summary.includes, flags: summary.flags, compiler: path.basename(args[0]) }).slice(0, 16);
    const translationUnit = `translation-unit:${source}:${commandHash.slice(0, 12)}`;
    const target = `compile-target:${summary.output || source}`;
    const common = { provider: "compile-commands", configuration, freshness: "fresh", gatingSafe: true, provenance: [{ provider: "compile-commands", operation: "parse" }] };
    facts.push({ ...common, subject: source, predicate: "owned-by-target", object: target, path: source, contentHash: commandHash });
    facts.push({ ...common, subject: source, predicate: "included-in", object: translationUnit, path: source, contentHash: commandHash });
    facts.push({ ...common, subject: translationUnit, predicate: "compiled-with", object: `configuration:${configuration}`, path: source, contentHash: commandHash });
    if (summary.output) facts.push({ ...common, subject: target, predicate: "produces", object: summary.output, path: source, contentHash: commandHash });
    commands.push({ source, translationUnit, target, configuration, compiler: path.basename(args[0]), language: inferLanguage(source, summary.language), defines: summary.defines, includes: summary.includes, flags: summary.flags, output: summary.output, commandHash });
  }
  return { provider: "compile-commands", source: path.relative(root, file).replace(/\\/g, "/"), facts, commands, degradation: null };
}
function loadCompilationDatabases(root, options = {}) { const files = discoverCompilationDatabases(root, options); const results = files.map((file) => parseCompilationDatabase(root, file)); return { provider: "compile-commands", available: files.length > 0, files: files.map((file) => path.relative(root, file).replace(/\\/g, "/")), facts: results.flatMap((result) => result.facts), commands: results.flatMap((result) => result.commands), degradation: results.find((result) => result.degradation)?.degradation || (!files.length ? { code: "not_configured", message: "No existing compile_commands.json found", retryable: false } : null) }; }

module.exports = { splitCommand, discoverCompilationDatabases, summarizeFlags, parseCompilationDatabase, loadCompilationDatabases, relativePath };
