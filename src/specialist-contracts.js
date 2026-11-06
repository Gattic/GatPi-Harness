"use strict";

// Shared leaf contracts for specialist and role modules.
//
// These helpers used to live in role-result-schemas.js and
// subagent-task-contracts.js, which forced specialist modules into require
// cycles: schemas -> specialist roles -> diagnostics -> tools -> rea ->
// subagent contracts -> role contracts -> schemas. Moving the pure helpers here
// gives every consumer a single acyclic dependency.

const crypto = require("node:crypto");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest("hex")}`;
}

function inZone(file, zone) {
  return file === zone || (zone.endsWith("/") && file.startsWith(zone));
}

function overlaps(a, b) {
  return inZone(a, b) || inZone(b, a);
}

function typeMatches(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return !!value && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateJsonSchema(schema, value, at = "$", errors = []) {
  if (!schema) return errors;
  if (Array.isArray(schema.anyOf)) {
    const alternatives = schema.anyOf.map((candidate) => validateJsonSchema(candidate, value, at, []));
    if (!alternatives.some((candidate) => candidate.length === 0)) errors.push(`${at} does not match any allowed schema`);
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at} expected one of ${schema.enum.join(", ")}`);
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(`${at} expected ${schema.type}`);
    return errors;
  }
  if (schema.type === "string") {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) errors.push(`${at} must contain at least ${schema.minLength} characters`);
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) errors.push(`${at} exceeds ${schema.maxLength} characters`);
  }
  if (schema.type === "array") {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) errors.push(`${at} must contain at least ${schema.minItems} items`);
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) errors.push(`${at} exceeds ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => validateJsonSchema(schema.items, item, `${at}[${index}]`, errors));
  }
  if (schema.type === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${at} must be >= ${schema.minimum}`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${at} must be <= ${schema.maximum}`);
  }
  if (schema.type === "object") {
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) errors.push(`${at}.${key} missing required property`);
    for (const [key, child] of Object.entries(schema.properties || {})) if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) validateJsonSchema(child, value[key], `${at}.${key}`, errors);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) errors.push(`${at}.${key} is not allowed`);
  }
  return errors;
}

module.exports = {
  canonical,
  digest,
  inZone,
  overlaps,
  typeMatches,
  validateJsonSchema,
};
