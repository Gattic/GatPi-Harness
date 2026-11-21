"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { configFromEnv, resolveVaultSelection, buildProjectMemoryReadiness } = require("./obsidian-adapter");
const { projectIdentity } = require("./project-identity");
const { projectFolderName } = require("./project-memory-schema");
const { resolveProjectMemoryRollout } = require("./project-memory-rollout");
const { evaluateProjectMemoryRollout } = require("./memory-rollout-telemetry");
const { applyProjectMemoryPosture } = require("./project-memory-posture");
const { DEFAULT_SCORECARD_MAX_AGE_MS, currentMemorySourceEvidence, validateScorecardSource } = require("./memory-effectiveness-source");
function readJson(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function projectMemoryRuntimeConfig(cwd, env = process.env, options = {}) {
  // A declared posture outranks inherited stage exports; PI_PROJECT_MEMORY=0
  // still disables every control below.
  const posture = applyProjectMemoryPosture(env, options);
  const effectiveEnv = posture.env;
  const scorecard = readJson(path.join(cwd, ".pi", "memory-effectiveness", "scorecard.json"), {});
  const currentSource = currentMemorySourceEvidence({ implementationRoot: path.resolve(__dirname, "..") });
  const configuredMaxAge = Number(effectiveEnv.PI_PROJECT_MEMORY_SCORECARD_MAX_AGE_MS);
  const maxAgeMs = Number.isFinite(configuredMaxAge) && configuredMaxAge >= 0 ? configuredMaxAge : DEFAULT_SCORECARD_MAX_AGE_MS;
  const freshness = validateScorecardSource(scorecard, currentSource, { maxAgeMs });
  // Eligibility comes from passive telemetry only. The scorecard is still read
  // for reporting, but it no longer selects a requested or eligible stage.
  const evaluation = evaluateProjectMemoryRollout({ cwd, env: effectiveEnv, now: options.now, refresh: options.refreshRollout, emit: options.emit });
  const requested = effectiveEnv.PI_PROJECT_MEMORY_STAGE || "M0";
  const rollout = resolveProjectMemoryRollout({ ...effectiveEnv, PI_PROJECT_MEMORY_STAGE: requested }, evaluation);
  const selection = resolveVaultSelection({ cwd }, { vault: options.vault, discoveredCandidates: options.discoveredCandidates }, configFromEnv(effectiveEnv));
  const projectFolder = projectFolderName(projectIdentity(cwd));
  const canonicalProjectFolderPath = selection.exists && selection.path ? path.join(selection.path, "Memory", "Projects", projectFolder) : null;
  const projectFolderExists = Boolean(canonicalProjectFolderPath && fs.existsSync(canonicalProjectFolderPath));
  const readiness = buildProjectMemoryReadiness(selection, rollout, { projectFolderExists });
  const vault = selection.exists && selection.readable && !selection.ambiguous && selection.source !== "denied" ? selection.path : null;
  return {
    rollout,
    rolloutEvaluation: {
      evaluatedAt: evaluation.evaluatedAt,
      candidateStage: evaluation.candidateStage,
      previousStage: evaluation.previousStage,
      decidedStage: evaluation.decidedStage,
      effectiveStage: evaluation.effectiveStage,
      promoted: evaluation.promoted,
      demoted: evaluation.demoted,
      consecutiveFailures: evaluation.consecutiveFailures,
      held: evaluation.held,
      hold: evaluation.hold,
      emission: evaluation.emission,
      insufficient: evaluation.insufficient,
      predicates: Object.fromEntries(Object.entries(evaluation.predicates).map(([name, value]) => [name, { status: value.status, reasons: value.reasons }])),
    },
    posture: { present: posture.posture.present, invalid: Boolean(posture.posture.invalid), reason: posture.posture.reason || null, recordedAt: posture.posture.recordedAt || null, rationale: posture.posture.rationale || null, declared: posture.posture.overrides },
    selection,
    canonicalProjectFolder: { name: projectFolder, exists: projectFolderExists, path: canonicalProjectFolderPath },
    readiness,
    scorecard: { schemaVersion: scorecard.schemaVersion || null, decision: scorecard.decision || "unknown", manifestHash: scorecard.manifestHash || null, fresh: freshness.ok, freshnessReasons: freshness.reasons, sourceRevision: scorecard.source?.revision || null, currentRevision: currentSource.revision },
    adapter: { enabled: Boolean(vault && readiness.projectMemoryReads.ready), cwd, vault, writeEnabled: Boolean(vault && readiness.projectMemoryExplicitWrites.ready), stateDir: path.join(cwd, ".pi", "project-memory"), selection, readiness },
  };
}
module.exports = { projectMemoryRuntimeConfig };
