#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TELEMETRY_SCHEMA_VERSION, readTelemetryEvents } = require("../src/extension-telemetry");
const { OUTCOME_SCHEMA_VERSION } = require("../src/outcome-schema");
const { SCHEMA_VERSION: SESSION_MINER_SCHEMA_VERSION, CLASSIFIER_VERSION: SESSION_MINER_CLASSIFIER_VERSION, COHORT_CONTRACT_VERSION, SESSION_KIND_POLICY_VERSION } = require("../src/session-miner");
const { resolveRoleRuntimeConfig } = require("../src/role-runtime-rollout");
const { sha256 } = require("../src/runtime-source-fingerprint");
const { evaluatePhase7Scorecard, renderPhase7Markdown } = require("../src/phase7-release-scorecard");
const { SESSION_AUDIT_SCHEMA_VERSION, SESSION_AUDIT_CLASSIFIER_VERSION, SESSION_AUDIT_KIND_POLICY_VERSION, filesUnder, hashFiles } = require("./freeze-phase7-release");

function readJson(file, required = true) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (!required) return null; throw new Error(`cannot read ${file}: ${error?.message || String(error)}`); }
}
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function validatePhase7Freeze({ freeze, currentRuntimeHash, currentSettingsHash, sessionAudit } = {}) {
  const mismatches = [];
  const expect = (field, actual, expected) => { if (actual !== expected) mismatches.push(field); };
  expect("freeze.schemaVersion", freeze?.schemaVersion, 1);
  expect("runtimeSourceHash", freeze?.runtimeSourceHash, currentRuntimeHash);
  expect("settingsHash", freeze?.settingsHash, currentSettingsHash);
  expect("telemetrySchemaVersion", freeze?.telemetrySchemaVersion, TELEMETRY_SCHEMA_VERSION);
  expect("outcomeSchemaVersion", freeze?.outcomeSchemaVersion, OUTCOME_SCHEMA_VERSION);
  expect("cohortContractVersion", freeze?.cohortContractVersion, COHORT_CONTRACT_VERSION);
  expect("sessionMinerSchemaVersion", freeze?.sessionMinerSchemaVersion, SESSION_MINER_SCHEMA_VERSION);
  expect("sessionMinerClassifierVersion", freeze?.sessionMinerClassifierVersion, SESSION_MINER_CLASSIFIER_VERSION);
  expect("sessionKindPolicyVersion", freeze?.sessionKindPolicyVersion, SESSION_KIND_POLICY_VERSION);
  expect("sessionAuditSchemaVersion", freeze?.sessionAuditSchemaVersion, SESSION_AUDIT_SCHEMA_VERSION);
  expect("sessionAuditClassifierVersion", freeze?.sessionAuditClassifierVersion, SESSION_AUDIT_CLASSIFIER_VERSION);
  expect("sessionAuditKindPolicyVersion", freeze?.sessionAuditKindPolicyVersion, SESSION_AUDIT_KIND_POLICY_VERSION);
  expect("audit.schemaVersion", sessionAudit?.schemaVersion, freeze?.sessionAuditSchemaVersion);
  expect("audit.classifierVersion", sessionAudit?.classifierVersion, freeze?.sessionAuditClassifierVersion);
  expect("audit.sessionKindPolicyVersion", sessionAudit?.sessionKindPolicyVersion, freeze?.sessionAuditKindPolicyVersion);
  expect("audit.cohort.sourceVersion", sessionAudit?.cohort?.sourceVersion, freeze?.sourceVersion);
  expect("audit.cohort.configVersion", sessionAudit?.cohort?.configVersion, freeze?.configVersion);
  expect("audit.cohort.classifierVersion", sessionAudit?.cohort?.classifierVersion, freeze?.sessionAuditClassifierVersion);
  expect("audit.cohort.sessionKindPolicyVersion", sessionAudit?.cohort?.sessionKindPolicyVersion, freeze?.sessionAuditKindPolicyVersion);
  if (mismatches.length) throw new Error(`Phase 7 evidence drifted after the freeze (${mismatches.join(", ")}); create a new freeze and restart the cohort`);
  return { valid: true, checkedFields: 18 };
}
function generatePhase7Scorecard({ cwd = process.cwd(), freezeFile, evidenceFile, auditFile, benchmarkFile, pilotFile, settingsFile, jsonFile, markdownFile } = {}) {
  const root = path.resolve(cwd);
  const freeze = readJson(path.resolve(freezeFile || path.join(root, ".pi", "phase7", "freeze.json")));
  const runtimeFiles = ["src", ".pi/extensions", "extensions"].flatMap((dir) => filesUnder(root, dir));
  const currentRuntimeHash = hashFiles(root, runtimeFiles);
  const currentSettingsHash = sha256(fs.readFileSync(path.resolve(settingsFile || process.env.PI_SETTINGS_FILE || path.join(os.homedir(), ".pi", "agent", "settings.json"))));
  const evidence = readJson(path.resolve(evidenceFile || path.join(root, ".pi", "phase7", "evidence.json")));
  const sessionAudit = readJson(path.resolve(auditFile || path.join(root, ".pi", "session-audit", "phase7-cohort.json")));
  validatePhase7Freeze({ freeze, currentRuntimeHash, currentSettingsHash, sessionAudit });
  const roleBenchmark = readJson(path.resolve(benchmarkFile || path.join(root, ".pi", "role-runtime", "benchmarks", "latest.json")));
  const pilotRaw = readJson(path.resolve(pilotFile || path.join(root, ".pi", "run-deck", "run-phase1-live-role-sidecar-pilot-e2fb.json")));
  const rolePilot = {
    status: pilotRaw.status,
    verdict: /^PASS\b/.test(String(pilotRaw.verdict || "")) ? "pass" : "fail",
    metrics: { ...(pilotRaw.banked || {}), typedTermination: /valid typed result|submit/i.test(String(pilotRaw.verdict || "")), sample: 1 },
    evidence: ["run-deck:phase1-live-role-sidecar-pilot"],
  };
  const roleRollout = resolveRoleRuntimeConfig({ PI_ROLE_RUNTIME_VERSION: "2", PI_ROLE_MUTATION: "isolated", PI_TOPOLOGY_AUTO_ROUTE: "suggest", PI_ROLE_SIDECAR: "1" }, { cwd: root, benchmarkReport: roleBenchmark });
  const report = evaluatePhase7Scorecard({ ...evidence, freeze, sessionAudit, roleBenchmark, rolePilot, roleRollout, telemetryEvents: readTelemetryEvents({ cwd: root }), generatedAt: new Date().toISOString() });
  const outputJson = path.resolve(jsonFile || path.join(root, "docs", "phase7-release-scorecard.json"));
  const outputMarkdown = path.resolve(markdownFile || path.join(root, "docs", "phase7-release-scorecard.md"));
  write(outputJson, `${JSON.stringify(report, null, 2)}\n`);
  write(outputMarkdown, `${renderPhase7Markdown(report).trimEnd()}\n`);
  return { report, jsonFile: outputJson, markdownFile: outputMarkdown };
}

if (require.main === module) {
  try {
    const { report, jsonFile, markdownFile } = generatePhase7Scorecard();
    process.stdout.write(`${JSON.stringify({ scorecardId: report.scorecardId, decision: report.summary.decision, pass: report.summary.pass, fail: report.summary.fail, insufficientData: report.summary.insufficientData, jsonFile, markdownFile })}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { validatePhase7Freeze, generatePhase7Scorecard };
