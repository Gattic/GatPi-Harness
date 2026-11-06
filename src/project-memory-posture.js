"use strict";

const fs = require("node:fs");
const path = require("node:path");

const POSTURE_FILE = path.join("config", "memory-posture.json");
const STAGES = new Set(["M0", "M1", "M2", "M3", "M4", "M5"]);
const MAX_RATIONALE_CHARS = 400;
// The file is read on every runtime-config and tool-surface resolution, so an
// oversized or corrupt file must be rejected without being parsed into memory.
const MAX_POSTURE_BYTES = 64 * 1024;

function readProjectMemoryPosture({ root = path.resolve(__dirname, "..") } = {}) {
  const file = path.join(path.resolve(root), POSTURE_FILE);
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, file, overrides: {} };
    return { present: true, file, invalid: true, reason: `read-failed:${error?.code || "unknown"}`, overrides: {} };
  }
  if (size > MAX_POSTURE_BYTES) return { present: true, file, invalid: true, reason: "oversized", overrides: {} };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { present: true, file, invalid: true, reason: `read-failed:${error?.code || "unknown"}`, overrides: {} };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { present: true, file, invalid: true, reason: "invalid-json", overrides: {} };
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) return { present: true, file, invalid: true, reason: "invalid-schema", overrides: {} };
  if (!STAGES.has(value.stage)) return { present: true, file, invalid: true, reason: "invalid-stage", overrides: {} };
  // A declared field with the wrong type is a malformed declaration, not an
  // absent one: report it instead of silently falling back to the environment.
  for (const [field, reason] of [["writes", "invalid-writes"], ["automatic", "invalid-automatic"], ["autoSave", "invalid-auto-save"]]) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") return { present: true, file, invalid: true, reason, overrides: {} };
  }
  const overrides = { PI_PROJECT_MEMORY_STAGE: value.stage };
  if (typeof value.writes === "boolean") overrides.PI_PROJECT_MEMORY_WRITES = value.writes ? "1" : "0";
  if (typeof value.automatic === "boolean") overrides.PI_PROJECT_MEMORY_AUTOMATIC = value.automatic ? "1" : "0";
  if (typeof value.autoSave === "boolean") overrides.PI_PROJECT_MEMORY_AUTO_SAVE = value.autoSave ? "1" : "0";
  return {
    present: true,
    file,
    invalid: false,
    recordedAt: typeof value.recordedAt === "string" ? value.recordedAt : null,
    rationale: typeof value.rationale === "string" ? value.rationale.slice(0, MAX_RATIONALE_CHARS) : null,
    overrides,
  };
}

// A declared posture is the single source of truth for the project-memory stage
// keys. Inherited shell exports are not recorded decisions, so they must not
// silently outrank an explicit posture declaration. `PI_PROJECT_MEMORY=0`
// remains an unconditional kill switch because posture never declares it, and
// `PI_PROJECT_MEMORY_POSTURE=env` restores environment precedence for a session
// that deliberately overrides a single stage key.
function applyProjectMemoryPosture(env = process.env, options = {}) {
  const posture = readProjectMemoryPosture(options);
  if (String(env.PI_PROJECT_MEMORY_POSTURE || "").trim().toLowerCase() === "env") return { env, posture: { ...posture, envPrecedence: true } };
  if (!posture.present || posture.invalid) return { env, posture };
  return { env: { ...env, ...posture.overrides }, posture };
}

module.exports = { POSTURE_FILE, MAX_POSTURE_BYTES, readProjectMemoryPosture, applyProjectMemoryPosture };
