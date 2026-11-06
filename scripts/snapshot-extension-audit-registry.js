#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { scanExtensionRegistry } = require("../src/extension-registry");

function gitRevision(cwd) {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 5000 }).trim(); }
  catch { return "unknown"; }
}
function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}
function snapshotExtensionAuditRegistry({ cwd = process.cwd(), output } = {}) {
  const root = path.resolve(cwd);
  const registry = scanExtensionRegistry({ cwd: root, runtime: { available: false, tools: [], commands: [] } });
  const result = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    sourceVersion: gitRevision(root),
    roots: registry.configuredRoots.map((item) => ({ scope: item.scope, exists: item.exists })),
    extensions: registry.extensions.map((item) => ({
      name: item.name,
      scope: item.scope,
      bytes: item.bytes,
      sha256: item.sha256,
      commands: item.commands,
      tools: item.tools,
      events: item.events,
      env: item.env,
      childOnly: item.childOnly,
    })),
    conflicts: registry.conflicts,
    summary: registry.summary,
  };
  const file = path.resolve(output || path.join(root, ".pi", "session-audit", "registry.json"));
  writePrivate(file, result);
  return { file, result };
}

if (require.main === module) {
  try {
    const arg = process.argv.find((value) => value.startsWith("--output="));
    const { file, result } = snapshotExtensionAuditRegistry({ output: arg?.slice("--output=".length) });
    process.stdout.write(`${JSON.stringify({ output: file, sourceVersion: result.sourceVersion, extensions: result.summary.extensions, commands: result.summary.commands, tools: result.summary.tools, conflicts: result.summary.conflicts })}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { snapshotExtensionAuditRegistry };
