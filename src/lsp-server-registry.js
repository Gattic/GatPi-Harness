"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LANGUAGE_BY_EXTENSION = Object.freeze({
  ".c": "c", ".h": "cpp", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hh": "cpp", ".hpp": "cpp", ".hxx": "cpp", ".cu": "cuda", ".cuh": "cuda",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".py": "python", ".go": "go", ".rs": "rust", ".json": "json", ".java": "java", ".kt": "kotlin",
});
const SERVER_DEFINITIONS = Object.freeze([
  { id: "clangd", languages: ["c", "cpp", "cuda"], command: "clangd", args: ["--background-index=false"] },
  { id: "typescript-language-server", languages: ["javascript", "typescript"], command: "typescript-language-server", args: ["--stdio"] },
  { id: "pyright", languages: ["python"], command: "pyright-langserver", args: ["--stdio"] },
  { id: "pylsp", languages: ["python"], command: "pylsp", args: [] },
  { id: "gopls", languages: ["go"], command: "gopls", args: [] },
  { id: "rust-analyzer", languages: ["rust"], command: "rust-analyzer", args: [] },
]);
function inferLanguage(file) { return LANGUAGE_BY_EXTENSION[path.extname(String(file || "")).toLowerCase()] || "text"; }
function executableInfo(bin, env = process.env) {
  const hasSeparator = String(bin).includes("/") || String(bin).includes("\\") || path.isAbsolute(bin);
  const candidates = hasSeparator ? [path.resolve(bin)] : String(env.PATH || "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return { bin, found: true, path: candidate }; } catch {}
  }
  return { bin, found: false, path: hasSeparator ? path.resolve(bin) : null };
}
function configuredDefinition(definition, env = process.env) {
  const key = `PI_LSP_${definition.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BIN`;
  const command = env[key] || definition.command;
  return { ...definition, command, executable: executableInfo(command, env) };
}
function serverRegistry(env = process.env, overrides = {}) {
  const definitions = (overrides.definitions || SERVER_DEFINITIONS).map((definition) => configuredDefinition(definition, env));
  return {
    definitions,
    forLanguage(language) { return definitions.find((definition) => definition.languages.includes(language) && definition.executable.found) || null; },
    candidates(language) { return definitions.filter((definition) => !language || definition.languages.includes(language)); },
    status() { return definitions.map((definition) => ({ id: definition.id, languages: definition.languages, command: definition.command, args: definition.args, found: definition.executable.found, path: definition.executable.path })); },
  };
}

module.exports = { LANGUAGE_BY_EXTENSION, SERVER_DEFINITIONS, inferLanguage, executableInfo, serverRegistry };
