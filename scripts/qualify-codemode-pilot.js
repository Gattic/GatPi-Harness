#!/usr/bin/env node
"use strict";

// Deliberately no SDK, credentials, transport, or live benchmark import.
const fs = require("node:fs");
const path = require("node:path");
const { exerciseOfflinePilot, checkStorage } = require("../src/codemode-pilot");

function bytesUnder(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw Object.assign(new Error("STORAGE_BOUND"), { code: "STORAGE_BOUND" });
  if (stat.isDirectory()) return Math.max(stat.size, stat.blocks * 512) + fs.readdirSync(file).reduce((n, name) => n + bytesUnder(path.join(file, name)), 0);
  if (!stat.isFile()) throw Object.assign(new Error("STORAGE_BOUND"), { code: "STORAGE_BOUND" });
  return Math.max(stat.size, stat.blocks * 512);
}
async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== "--offline") throw Object.assign(new Error("Only --offline is supported; no live execution is authorized"), { code: "OFFLINE_ONLY" });
  const state = path.resolve(__dirname, "../.pi");
  const existing = fs.existsSync(state) ? fs.readdirSync(state).filter(name => name.startsWith("codemode")).reduce((n, name) => n + bytesUnder(path.join(state, name)), 0) : 0;
  checkStorage({ newMetadataBytes: 0, sharedEvidenceBytes: existing, fixtureBytes: 0 });
  const result = await exerciseOfflinePilot();
  const text = `${JSON.stringify(result, null, 2)}\n`, bytes = Buffer.byteLength(text);
  checkStorage({ newMetadataBytes: bytes, sharedEvidenceBytes: existing + bytes, fixtureBytes: 0 });
  process.stdout.write(text);
  if (!result.simulatedScreen.screenPass) process.exitCode = 1;
}
module.exports = { main, bytesUnder };
if (require.main === module) main().catch(error => {
  console.error(error.code === "OFFLINE_ONLY" ? error.message : "Offline qualification failed; no paid execution available");
  process.exitCode = 1;
});
