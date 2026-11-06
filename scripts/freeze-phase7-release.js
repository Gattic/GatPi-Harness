#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { PORTFOLIO_SCHEMA_VERSION } = require("../src/extension-portfolio");
const { TELEMETRY_SCHEMA_VERSION } = require("../src/extension-telemetry");
const { OUTCOME_SCHEMA_VERSION } = require("../src/outcome-schema");
const { SCHEMA_VERSION: SESSION_MINER_SCHEMA_VERSION, CLASSIFIER_VERSION: SESSION_MINER_CLASSIFIER_VERSION, COHORT_CONTRACT_VERSION, SESSION_KIND_POLICY_VERSION } = require("../src/session-miner");
const { sha256, filesUnder, hashFiles, runtimeSourceFingerprint } = require("../src/runtime-source-fingerprint");
const SESSION_AUDIT_SCHEMA_VERSION = 3;
const SESSION_AUDIT_CLASSIFIER_VERSION = "pi-session-audit-v3";
const SESSION_AUDIT_KIND_POLICY_VERSION = "pi-session-audit-kind-v2";
function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}
function freezePhase7({ cwd = process.cwd(), output } = {}) {
  const root = path.resolve(cwd);
  const runtimeSource = runtimeSourceFingerprint(root);
  const settingsFile = process.env.PI_SETTINGS_FILE || path.join(os.homedir(), ".pi", "agent", "settings.json");
  const roleManifest = path.join(root, "tests", "fixtures", "role-runtime", "manifest.json");
  const baseRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 5000 }).trim();
  const runtimeSourceHash = runtimeSource.hash;
  const settingsHash = sha256(fs.readFileSync(settingsFile));
  const roleManifestHash = sha256(fs.readFileSync(roleManifest));
  const frozenAt = new Date().toISOString();
  const value = {
    schemaVersion: 1,
    frozenAt,
    cohortStartAt: frozenAt,
    baseRevision,
    sourceVersion: `${baseRevision.slice(0, 12)}+${runtimeSourceHash.slice(0, 16)}`,
    runtimeSourceHash,
    runtimeFileCount: runtimeSource.fileCount,
    configVersion: `settings-${settingsHash.slice(0, 16)}+portfolio-${PORTFOLIO_SCHEMA_VERSION}+telemetry-${TELEMETRY_SCHEMA_VERSION}+outcome-${OUTCOME_SCHEMA_VERSION}+cohort-${COHORT_CONTRACT_VERSION}`,
    settingsHash,
    roleManifestHash,
    portfolioSchemaVersion: PORTFOLIO_SCHEMA_VERSION,
    telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
    outcomeSchemaVersion: OUTCOME_SCHEMA_VERSION,
    cohortContractVersion: COHORT_CONTRACT_VERSION,
    sessionMinerSchemaVersion: SESSION_MINER_SCHEMA_VERSION,
    sessionMinerClassifierVersion: SESSION_MINER_CLASSIFIER_VERSION,
    sessionKindPolicyVersion: SESSION_KIND_POLICY_VERSION,
    sessionAuditSchemaVersion: SESSION_AUDIT_SCHEMA_VERSION,
    sessionAuditClassifierVersion: SESSION_AUDIT_CLASSIFIER_VERSION,
    sessionAuditKindPolicyVersion: SESSION_AUDIT_KIND_POLICY_VERSION,
    privacy: { containsSourceBodies: false, containsSettingsBodies: false, containsPaths: false },
  };
  const file = path.resolve(output || path.join(root, ".pi", "phase7", "freeze.json"));
  writePrivate(file, value);
  return { file, value };
}

if (require.main === module) {
  try {
    const output = process.argv.find((arg) => arg.startsWith("--output="))?.slice(9);
    const { file, value } = freezePhase7({ output });
    process.stdout.write(`${JSON.stringify({ output: file, frozenAt: value.frozenAt, sourceVersion: value.sourceVersion, configVersion: value.configVersion, runtimeFileCount: value.runtimeFileCount })}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { SESSION_AUDIT_SCHEMA_VERSION, SESSION_AUDIT_CLASSIFIER_VERSION, SESSION_AUDIT_KIND_POLICY_VERSION, filesUnder, hashFiles, freezePhase7 };
