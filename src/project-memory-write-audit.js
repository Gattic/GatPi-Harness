"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { sanitizeManagedStateValue } = require("./managed-state-sanitizer");
const { DIAGNOSTIC_POLICIES, appendBoundedJsonl } = require("./file-integration-storage");

const RECORD_PATTERN = /\.(json|jsonl)$/i;

function fileHash(name) { return `sha256:${crypto.createHash("sha256").update(String(name)).digest("hex").slice(0, 16)}`; }
function parseRecords(file) {
  let text; try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  if (/\.jsonl$/i.test(file)) return text.split(/\n+/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  try { return [JSON.parse(text)]; } catch { return []; }
}
/**
 * A record written through the sanitizer is already clean, so sanitizing it
 * again changes nothing. Anything the state sanitizer still has to redact proves
 * the write bypassed that path, which is the signal the rollout gate reads.
 * The diagnostic sanitizer is deliberately not used here: it summarises
 * payload-shaped fields, so ordinary cached content would look like a bypass.
 */
function isSanitized(value) {
  return JSON.stringify(sanitizeManagedStateValue(value)) === JSON.stringify(value);
}
function auditRecordWrites({ stateDir, since = null, maxFiles = 200 } = {}) {
  const dir = path.resolve(stateDir);
  const sinceMs = since == null ? null : Date.parse(since);
  const audit = { inspected: 0, records: 0, bypassedRecords: 0, bypassedFiles: 0, files: [] };
  if (!fs.existsSync(dir)) return audit;
  const names = fs.readdirSync(dir).filter((name) => RECORD_PATTERN.test(name)).sort().slice(0, Math.max(0, maxFiles));
  for (const name of names) {
    const file = path.join(dir, name);
    let stat; try { stat = fs.lstatSync(file); } catch { continue; }
    if (!stat.isFile() || (sinceMs != null && stat.mtimeMs < sinceMs)) continue;
    audit.inspected += 1;
    const records = parseRecords(file);
    audit.records += records.length;
    const bypassed = records.filter((record) => !isSanitized(record)).length;
    // Only a name hash is reported: the diagnostic must never carry state paths.
    if (bypassed) { audit.bypassedRecords += bypassed; audit.bypassedFiles += 1; audit.files.push({ fileHash: fileHash(name), bypassedRecords: bypassed }); }
  }
  return audit;
}
function recordWriteAudit({ cwd = process.cwd(), stateDir = path.join(cwd, ".pi", "project-memory"), since = null, clock = () => new Date(), maxFiles = 200 } = {}) {
  const dir = path.resolve(stateDir);
  const audit = auditRecordWrites({ stateDir: dir, since, maxFiles });
  const row = {
    schemaVersion: 1,
    sourceVersion: "project-memory-diagnostics-v1",
    at: new Date(clock()).toISOString(),
    kind: "write",
    scope: "project-memory-state",
    sanitized: audit.bypassedRecords === 0,
    inspected: audit.inspected,
    records: audit.records,
    bypassedRecords: audit.bypassedRecords,
    bypassedFiles: audit.bypassedFiles,
    files: audit.files,
  };
  appendBoundedJsonl(path.join(dir, "diagnostics.jsonl"), row, DIAGNOSTIC_POLICIES.memory);
  return { row, audit };
}

module.exports = { RECORD_PATTERN, auditRecordWrites, isSanitized, recordWriteAudit };
