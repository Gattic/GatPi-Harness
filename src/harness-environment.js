"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS_FILE = path.join("config", "harness-defaults.env");
const KEY_PATTERN = /^PI_[A-Z0-9_]+$/;
const VALUE_PATTERN = /^[A-Za-z0-9_./:+,-]+$/;
// Conflict records are persisted in .pi/harness-defaults/posture.json, so an
// inherited override is only shown when it is a simple, non-secret token.
const SECRET_KEY_PATTERN = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/;
const DISPLAY_SAFE_VALUE = /^[A-Za-z0-9_.:/+-]{1,120}$/;
const REDACTED = "<redacted>";

function conflictOverride(key, value) {
  if (SECRET_KEY_PATTERN.test(key) || !DISPLAY_SAFE_VALUE.test(value) || value.startsWith("/")) return REDACTED;
  return value;
}

function parseHarnessEnvironment(text) {
  const values = {};
  for (const [index, rawLine] of String(text || "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || !KEY_PATTERN.test(match[1]) || !VALUE_PATTERN.test(match[2])) {
      const error = new Error(`invalid harness environment entry at line ${index + 1}`);
      error.code = "HARNESS_ENV_INVALID";
      throw error;
    }
    if (Object.prototype.hasOwnProperty.call(values, match[1])) {
      const error = new Error(`duplicate harness environment key: ${match[1]}`);
      error.code = "HARNESS_ENV_DUPLICATE";
      throw error;
    }
    values[match[1]] = match[2];
  }
  return values;
}

function readHarnessEnvironment(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, ".."));
  const file = path.resolve(options.file || path.join(root, DEFAULTS_FILE));
  const values = parseHarnessEnvironment(fs.readFileSync(file, "utf8"));
  return { root, file, values };
}

function applyHarnessEnvironmentDefaults(options = {}) {
  const env = options.env || process.env;
  const loaded = readHarnessEnvironment(options);
  const applied = [];
  const preserved = [];
  const conflicts = [];
  for (const [key, value] of Object.entries(loaded.values)) {
    if (env[key] === undefined) {
      env[key] = value;
      applied.push(key);
    } else {
      preserved.push(key);
      // A preserved value that disagrees with the canonical default is an
      // inherited override, not a recorded operator decision. Reporting it is
      // what makes the resulting rollout posture explicit instead of implicit.
      if (env[key] !== value) conflicts.push({ key, canonical: value, override: conflictOverride(key, env[key]) });
    }
  }
  return {
    source: path.relative(loaded.root, loaded.file).replace(/\\/g, "/"),
    defaults: loaded.values,
    applied,
    preserved,
    conflicts,
  };
}

module.exports = {
  DEFAULTS_FILE,
  REDACTED,
  conflictOverride,
  parseHarnessEnvironment,
  readHarnessEnvironment,
  applyHarnessEnvironmentDefaults,
};
