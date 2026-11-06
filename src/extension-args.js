"use strict";

// Shared argument normalization for extensions and the test runner. Extracted
// from pi-extension-kit so test-runner does not import the kit (which imports
// codemode-policy, which lazily imports test-runner).

function operationKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeOperation(value, { toolName = "tool", defaultOperation, operations = [], aliases = {} } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return defaultOperation;
  const lookup = new Map(operations.map((operation) => [operationKey(operation), operation]));
  for (const [alias, operation] of Object.entries(aliases)) lookup.set(operationKey(alias), operation);
  const normalized = lookup.get(operationKey(raw));
  if (normalized && operations.includes(normalized)) return normalized;
  throw new Error(`${toolName} operation '${raw}' is not supported. Use one of: ${operations.join(", ")}.`);
}

function normalizeStringList(value, fieldName = "value") {
  if (value == null) return undefined;
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${fieldName} must be a string or an array of strings.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

module.exports = { operationKey, normalizeOperation, normalizeStringList };
