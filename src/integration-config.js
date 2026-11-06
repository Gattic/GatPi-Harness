"use strict";

/** Configuration schema/defaults for Pi integration adapters. */

const DEFAULT_INTEGRATION_CONFIG = Object.freeze({
  enabled: true,
  trace: { enabled: true },
  memory: { enabled: true },
  context: { enabled: true },
  anchoring: { enabled: true },
  verification: { enabled: false },
  visualVerification: { enabled: true },
  rolloutCenter: { enabled: true },
  entropy: { enabled: true },
  reasoning: { enabled: true },
  orchestration: { enabled: false },
  branching: { enabled: false },
  topologies: { enabled: false },
  hermes: { enabled: true },
  skills: { enabled: true },
  skillIntake: { enabled: true },
  memoryMaintenance: { enabled: true },
  provenance: { enabled: true },
  compounding: { enabled: true },
});

function boolEnv(name, fallback, env = process.env) {
  if (env[name] == null) return fallback;
  return !["0", "false", "no", "off"].includes(String(env[name]).toLowerCase());
}

function deepMerge(base, override = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object") out[key] = deepMerge(base[key], value);
    else out[key] = value;
  }
  return out;
}

function normalizeIntegrationConfig(input = {}, env = process.env) {
  const envConfig = {
    enabled: boolEnv("PI_COGNITIVE_AUTOMATION", DEFAULT_INTEGRATION_CONFIG.enabled, env),
    trace: { enabled: boolEnv("PI_TRACE_ENABLED", DEFAULT_INTEGRATION_CONFIG.trace.enabled, env) },
    memory: { enabled: boolEnv("PI_COGNITIVE_MEMORY_ENABLED", DEFAULT_INTEGRATION_CONFIG.memory.enabled, env) },
    context: { enabled: boolEnv("PI_COGNITIVE_CONTEXT_ENABLED", DEFAULT_INTEGRATION_CONFIG.context.enabled, env) },
    anchoring: { enabled: boolEnv("PI_COGNITIVE_ANCHORING_ENABLED", DEFAULT_INTEGRATION_CONFIG.anchoring.enabled, env) },
    verification: { enabled: boolEnv("PI_COGNITIVE_AUTO_VERIFY", DEFAULT_INTEGRATION_CONFIG.verification.enabled, env) },
    visualVerification: { enabled: boolEnv("PI_VISUAL_VERIFICATION", DEFAULT_INTEGRATION_CONFIG.visualVerification.enabled, env) },
    rolloutCenter: { enabled: boolEnv("PI_ROLLOUT_CENTER", DEFAULT_INTEGRATION_CONFIG.rolloutCenter.enabled, env) },
    entropy: { enabled: boolEnv("PI_COGNITIVE_ENTROPY_ENABLED", DEFAULT_INTEGRATION_CONFIG.entropy.enabled, env) },
    reasoning: { enabled: boolEnv("PI_REASONING_RUNTIME_ENABLED", DEFAULT_INTEGRATION_CONFIG.reasoning.enabled, env) },
    orchestration: { enabled: boolEnv("PI_COGNITIVE_ORCHESTRATION_ENABLED", DEFAULT_INTEGRATION_CONFIG.orchestration.enabled, env) },
    branching: { enabled: boolEnv("PI_COGNITIVE_AUTO_BRANCH", DEFAULT_INTEGRATION_CONFIG.branching.enabled, env) },
    topologies: { enabled: boolEnv("PI_MULTI_AGENT_TOPOLOGIES_ENABLED", DEFAULT_INTEGRATION_CONFIG.topologies.enabled, env) },
    hermes: { enabled: boolEnv("PI_HERMES_ADVISORY", DEFAULT_INTEGRATION_CONFIG.hermes.enabled, env) },
    skills: { enabled: boolEnv("PI_SKILL_SYNTHESIS_ENABLED", DEFAULT_INTEGRATION_CONFIG.skills.enabled, env) },
    skillIntake: { enabled: boolEnv("PI_SKILL_INTAKE_ENABLED", DEFAULT_INTEGRATION_CONFIG.skillIntake.enabled, env) },
    memoryMaintenance: { enabled: boolEnv("PI_MEMORY_MAINTENANCE_ENABLED", DEFAULT_INTEGRATION_CONFIG.memoryMaintenance.enabled, env) },
    provenance: { enabled: boolEnv("PI_PROVENANCE_GRAPH_ENABLED", DEFAULT_INTEGRATION_CONFIG.provenance.enabled, env) },
    compounding: { enabled: boolEnv("PI_COMPOUNDING_EFFECTIVENESS_ENABLED", DEFAULT_INTEGRATION_CONFIG.compounding.enabled, env) },
  };
  return deepMerge(deepMerge(DEFAULT_INTEGRATION_CONFIG, envConfig), input);
}

function adapterConfig(config) {
  const c = normalizeIntegrationConfig(config);
  return {
    enabled: c.enabled,
    trace: c.trace,
    memory: c.memory,
    context: c.context,
    anchoring: c.anchoring,
    verification: c.verification,
    visualVerification: c.visualVerification,
    rolloutCenter: c.rolloutCenter,
    entropy: c.entropy,
    reasoning: c.reasoning,
    orchestration: c.orchestration,
    branching: c.branching,
    topologies: c.topologies,
    hermes: c.hermes,
    skills: c.skills,
    skillIntake: c.skillIntake,
    memoryMaintenance: c.memoryMaintenance,
    provenance: c.provenance,
    compounding: c.compounding,
  };
}

module.exports = { DEFAULT_INTEGRATION_CONFIG, normalizeIntegrationConfig, adapterConfig, deepMerge };
