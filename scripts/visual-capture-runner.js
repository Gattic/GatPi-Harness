#!/usr/bin/env node
"use strict";

// Isolated helper for configured visual fixtures. It writes only to the
// caller-allocated private temporary manifest and never prints fixture data.

const fs = require("node:fs");
const path = require("node:path");

function fail(code) {
  try { process.stderr.write(`${code}\n`); } catch {}
  process.exitCode = 1;
}

async function main() {
  const requestFile = process.argv[2];
  if (!requestFile || path.isAbsolute(requestFile) === false) return fail("invalid-request-file");
  let request;
  try { request = JSON.parse(fs.readFileSync(requestFile, "utf8")); }
  catch { return fail("invalid-request"); }
  if (request?.schemaVersion !== 1 || typeof request.moduleFile !== "string" || typeof request.outputFile !== "string") return fail("invalid-request-schema");
  try {
    const loaded = require(request.moduleFile);
    const capture = loaded?.[request.exportName] || (request.exportName === "default" ? loaded?.default : null);
    if (typeof capture !== "function") return fail("capture-export-missing");
    const value = await capture(request.input || {});
    let manifest;
    if (request.kind === "tui-frame") manifest = { schemaVersion: 1, lines: Array.isArray(value) ? value : value?.lines, width: value?.width || request.input?.width };
    else if (request.kind === "graphviz") manifest = { schemaVersion: 1, dot: typeof value === "string" ? value : value?.dot };
    else return fail("unsupported-capture-kind");
    fs.writeFileSync(request.outputFile, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: "wx" });
  } catch { return fail("capture-failed"); }
}

main();
