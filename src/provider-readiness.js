"use strict";

const KNOWN_OPTIONAL_PROVIDERS = new Set(["codegraph", "semgrep", "visual"]);

function normalizeRequiredProviders(value) {
  const rows = Array.isArray(value) ? value : value == null ? [] : String(value).split(",");
  const normalized = rows.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
  const unknown = Array.from(new Set(normalized.filter((item) => !KNOWN_OPTIONAL_PROVIDERS.has(item)))).sort();
  if (unknown.length) throw new Error(`Unknown required provider(s): ${unknown.join(", ")}. Use codegraph, semgrep, and/or visual.`);
  return Array.from(new Set(normalized)).sort();
}

function providerReadiness(provider, input = {}) {
  const name = String(provider || "provider").trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-") || "provider";
  const applicable = input.applicable !== false;
  const ready = Boolean(input.ready);
  const required = Boolean(input.required);
  const reason = String(input.reason || (ready ? "ready" : applicable ? "provider-unavailable" : "not-applicable")).slice(0, 160);
  if (!applicable) {
    return { provider: name, required, applicable: false, ready: false, advisory: !required, blocking: false, degraded: false, status: "not-applicable", outcome: "not-applicable", reason, errorCode: input.errorCode || null, gatingSafe: false };
  }
  if (ready) {
    return { provider: name, required, applicable: true, ready: true, advisory: !required, blocking: false, degraded: false, status: "ready", outcome: "succeeded", reason, errorCode: null, gatingSafe: required };
  }
  return {
    provider: name,
    required,
    applicable: true,
    ready: false,
    advisory: !required,
    blocking: required,
    degraded: !required,
    status: required ? "required-unavailable" : "degraded",
    outcome: required ? "infrastructure-failed" : "not-applicable",
    reason,
    errorCode: input.errorCode || null,
    gatingSafe: false,
  };
}

function providerGateViolations(states = []) {
  return states.filter((state) => state?.blocking).map((state) => ({
    policy: "required-provider-readiness",
    provider: state.provider,
    reason: `${state.provider} is required but unavailable (${state.reason})`,
    errorCode: state.errorCode || null,
  }));
}

module.exports = { KNOWN_OPTIONAL_PROVIDERS, normalizeRequiredProviders, providerReadiness, providerGateViolations };
