"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { ANALYSIS_ASSIGNMENTS_MAX, CLAIMS_MAX, EVIDENCE_ID_MAX_LENGTH, EVIDENCE_ITEMS_MAX, EVIDENCE_TEXT_MAX_LENGTH, ROADMAP_GOAL_MAX_LENGTH, SYNTHESIS_ITEMS_MAX } = require("../role-result-schemas");

function writePrivateExport(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirBefore = fs.lstatSync(dir);
  if (dirBefore.isSymbolicLink() || !dirBefore.isDirectory()) throw new Error(`topology export directory is unsafe: ${dir}`);
  const dirFd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
  try { const opened = fs.fstatSync(dirFd); if (!opened.isDirectory() || Number(opened.dev) !== Number(dirBefore.dev) || Number(opened.ino) !== Number(dirBefore.ino)) throw new Error(`topology export directory changed while opening: ${dir}`); fs.fchmodSync(dirFd, 0o700); const after = fs.lstatSync(dir); if (after.isSymbolicLink() || Number(after.dev) !== Number(opened.dev) || Number(after.ino) !== Number(opened.ino)) throw new Error(`topology export directory changed while hardening: ${dir}`); }
  finally { fs.closeSync(dirFd); }
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600); created = true;
    const opened = fs.fstatSync(fd); if (!opened.isFile()) throw new Error(`topology export temporary path is unsafe: ${temporary}`);
    const current = fs.lstatSync(temporary); if (current.isSymbolicLink() || Number(current.dev) !== Number(opened.dev) || Number(current.ino) !== Number(opened.ino)) throw new Error("topology export temporary path changed while open");
    fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.closeSync(fd); fd = undefined;
    try { const existing = fs.lstatSync(file); if (existing.isSymbolicLink() || !existing.isFile()) throw new Error(`topology export path is unsafe: ${file}`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    fs.renameSync(temporary, file);
    const installed = fs.lstatSync(file); if (installed.isSymbolicLink() || Number(installed.dev) !== Number(opened.dev) || Number(installed.ino) !== Number(opened.ino)) throw new Error("topology export path changed while installing");
  } catch (error) { if (created) try { fs.rmSync(temporary, { force: true }); } catch {} throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

class MemoryJsonStorage {
  constructor(seed = {}) { this.map = new Map(Object.entries(seed)); this.appended = new Map(); }
  readJson(key, fallback = null) { return this.map.has(key) ? clone(this.map.get(key)) : fallback; }
  writeJson(key, value) { this.map.set(key, clone(value)); return key; }
  appendJsonl(key, value) { const xs = this.appended.get(key) || []; xs.push(clone(value)); this.appended.set(key, xs); return key; }
  writeJsonl(key, rows) { this.appended.set(key, clone(rows || [])); return key; }
  readJsonl(key) { return clone(this.appended.get(key) || []); }
  deleteJson(key) { this.map.delete(key); return true; }
}

class NullSink {
  emit(_event) {}
  info(message, data) { this.emit({ level: "info", message, data }); }
  warn(message, data) { this.emit({ level: "warn", message, data }); }
  error(message, data) { this.emit({ level: "error", message, data }); }
}

class RecordingSink extends NullSink {
  constructor() { super(); this.events = []; }
  emit(event) { this.events.push({ at: Date.now(), ...event }); }
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function roleResultContractLimits() {
  return {
    roadmapGoalMaxLength: ROADMAP_GOAL_MAX_LENGTH,
    evidenceTextMaxLength: EVIDENCE_TEXT_MAX_LENGTH,
    evidenceIdMaxLength: EVIDENCE_ID_MAX_LENGTH,
    evidenceItemsMax: EVIDENCE_ITEMS_MAX,
    claimsMax: CLAIMS_MAX,
    analysisAssignmentsMax: ANALYSIS_ASSIGNMENTS_MAX,
    synthesisItemsMax: SYNTHESIS_ITEMS_MAX,
  };
}

function noopResult(kind) { return { enabled: false, kind, skipped: true }; }

function safe(fn, sink, fallback) { try { return fn(); } catch (error) { sink?.error?.("adapter failure", { error: error.message }); return fallback; } }

module.exports = {
  writePrivateExport,
  MemoryJsonStorage,
  NullSink,
  RecordingSink,
  clone,
  roleResultContractLimits,
  noopResult,
  safe,
};
