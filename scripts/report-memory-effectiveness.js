#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { loadJson, buildScorecard, writePrivateScorecard, validatePrivacyBoundary } = require("../src/memory-effectiveness");
const { currentMemorySourceEvidence } = require("../src/memory-effectiveness-source");

const cwd = process.cwd();
const args = new Set(process.argv.slice(2));
const manifestFile = path.join(cwd, "tests", "fixtures", "memory-effectiveness", "manifest.json");
const inputFile = path.join(cwd, ".pi", "memory-effectiveness", "input.json");
const privateFile = path.join(cwd, ".pi", "memory-effectiveness", "scorecard.json");
const publicFile = path.join(cwd, "docs", "memory-effectiveness-scorecard.json");
function readOptional(file) { try { return loadJson(file); } catch { return {}; } }

const manifest = loadJson(manifestFile);
const input = readOptional(inputFile);
const source = currentMemorySourceEvidence({ implementationRoot: path.resolve(__dirname, "..") });
const scorecard = buildScorecard({ manifest, ...input, source: { ...(input.source || {}), ...source } });
const privacyCheck = validatePrivacyBoundary(scorecard);
if (!privacyCheck.ok) throw new Error(`refusing unsafe scorecard: ${privacyCheck.issues.join(",")}`);
const written = writePrivateScorecard(privateFile, scorecard);
if (args.has("--public")) fs.writeFileSync(publicFile, `${JSON.stringify(scorecard, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, authority: scorecard.authority, decision: scorecard.decision, manifestHash: scorecard.manifestHash, privateHash: written.hash, publicWritten: args.has("--public") }, null, 2)}\n`);
