#!/usr/bin/env node
"use strict";

const {
  DAY_MS,
  planSessionHygiene,
  applySessionPermissions,
  archiveSessionCandidates,
  publicSessionHygieneResult,
  formatSessionHygienePlan,
} = require("../src/session-hygiene");

function parseDuration(value) {
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)(ms|h|d)?$/i);
  if (!match) throw new Error(`invalid duration: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] || "ms").toLowerCase();
  return amount * (unit === "d" ? DAY_MS : unit === "h" ? 60 * 60 * 1000 : 1);
}

function parseArgs(argv) {
  const options = { apply: false, archive: false, includeTemporary: true, includeOneShot: false, writeManifest: false, confirmed: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`missing value after ${arg}`); return argv[++i]; };
    if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--archive") options.archive = true;
    else if (arg === "--write-manifest") options.writeManifest = true;
    else if (arg === "--yes") options.confirmed = true;
    else if (arg === "--include-one-shot") options.includeOneShot = true;
    else if (arg === "--no-temporary") options.includeTemporary = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--root") options.root = next();
    else if (arg.startsWith("--root=")) options.root = arg.slice(7);
    else if (arg === "--archive-root") options.archiveRoot = next();
    else if (arg.startsWith("--archive-root=")) options.archiveRoot = arg.slice(15);
    else if (arg === "--migration-marker") options.migrationMarker = next();
    else if (arg.startsWith("--migration-marker=")) options.migrationMarker = arg.slice(19);
    else if (arg === "--preview-file") options.previewPath = next();
    else if (arg.startsWith("--preview-file=")) options.previewPath = arg.slice(15);
    else if (arg === "--project") options.projectCwd = next();
    else if (arg.startsWith("--project=")) options.projectCwd = arg.slice(10);
    else if (arg === "--older-than") options.olderThanMs = parseDuration(next());
    else if (arg.startsWith("--older-than=")) options.olderThanMs = parseDuration(arg.slice(13));
    else if (arg === "--max-files") options.maxFiles = Number(next());
    else if (arg.startsWith("--max-files=")) options.maxFiles = Number(arg.slice(12));
    else if (arg === "--max-entries") options.maxEntries = Number(next());
    else if (arg.startsWith("--max-entries=")) options.maxEntries = Number(arg.slice(14));
    else if (arg === "--max-scan-bytes") options.maxScanBytesPerFile = Number(next());
    else if (arg.startsWith("--max-scan-bytes=")) options.maxScanBytesPerFile = Number(arg.slice(17));
    else if (arg === "--max-one-shot-bytes") options.maxOneShotBytes = Number(next());
    else if (arg.startsWith("--max-one-shot-bytes=")) options.maxOneShotBytes = Number(arg.slice(21));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function validateOptions(options) {
  if (options.writeManifest && !options.confirmed) throw new Error("--write-manifest requires --yes");
  return options;
}

function help() {
  return `Usage: node scripts/session-hygiene.js [options]\n\n` +
    `Default behavior is a bounded preview of the one-time permission migration. --apply is explicit; files move only when both --archive and --apply are supplied.\n\n` +
    `  --dry-run                  Pure preview only (the default; writes no manifest)\n` +
    `  --write-manifest           Persist the private aggregate permission manifest for a later apply (requires --yes)\n` +
    `  --yes                      Confirm an explicit preview-manifest write\n` +
    `  --apply                    Apply permission changes using a previously persisted matching manifest\n` +
    `  --archive                  Include archive operation (temporary cwd sessions by default)\n` +
    `  --include-one-shot         Also select bounded one-shot sessions\n` +
    `  --project PATH             Restrict one-shot selection to this cwd\n` +
    `  --older-than 7d            Minimum inactivity age\n` +
    `  --root PATH                Session root (default ~/.pi/agent/sessions)\n` +
    `  --archive-root PATH        Archive root (default ~/.pi/agent/session-archive)\n` +
    `  --migration-marker PATH    Override one-time migration marker path\n` +
    `  --preview-file PATH        Override private aggregate preview path\n` +
    `  --max-files N              Bound matching session files\n` +
    `  --max-entries N            Bound directory entries visited\n` +
    `  --max-scan-bytes N         Bound bytes parsed per session file\n` +
    `  --json                     Print JSON\n`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(help()); return; }
  validateOptions(options);
  const plan = planSessionHygiene({ ...options, activeSessionFile: process.env.PI_SESSION_FILE || undefined });
  const permissions = applySessionPermissions(plan, { dryRun: !options.apply, writePreview: options.writeManifest === true });
  const archive = options.archive ? archiveSessionCandidates(plan, { dryRun: !options.apply }) : null;
  const result = publicSessionHygieneResult(plan, permissions, archive);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`${formatSessionHygienePlan(plan)}\n`);
    process.stdout.write(`permissions=${options.apply ? "applied" : "preview"} changed=${permissions.changedCount || 0} errors=${permissions.errors.length}\n`);
    if (archive) process.stdout.write(`archive=${options.apply ? "applied" : "preview"} moved=${archive.moved.length} errors=${archive.errors.length}${archive.manifestPath ? ` manifest=${archive.manifestPath}` : ""}\n`);
  }
  if (permissions.errors.length || archive?.errors.length) process.exitCode = 1;
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error?.stack || error?.message || String(error)); process.exitCode = 1; }
}

module.exports = { parseDuration, parseArgs, validateOptions, help };
