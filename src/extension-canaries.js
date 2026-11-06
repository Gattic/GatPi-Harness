"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { createExtensionTelemetry } = require("./extension-telemetry.js");

const CANARY_STAGES = new Set(["planned", "passed", "failed", "not-applicable"]);

function fixedStringValues(schema, out = new Set()) {
  if (!schema || typeof schema !== "object") return out;
  if (typeof schema.const === "string") out.add(schema.const);
  if (Array.isArray(schema.enum)) for (const value of schema.enum) if (typeof value === "string") out.add(value);
  for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(schema[key])) for (const child of schema[key]) fixedStringValues(child, out);
  return out;
}
function extensionFromSourcePath(file) {
  const normalized = String(file || "").replace(/\\/g, "/");
  const match = normalized.match(/\/(?:\.pi\/)?extensions\/([^/]+)\/index\.[cm]?[jt]s$/i);
  return match?.[1] || null;
}
function canaryId(extension, tool, operation, sourceFingerprint) {
  const digest = crypto.createHash("sha256").update(JSON.stringify({ extension, tool, operation, sourceFingerprint })).digest("hex").slice(0, 16);
  return `canary_${digest}`;
}
function operationCanaryPlan(report = {}, runtime = {}) {
  const registryByName = new Map((report.extensions || []).map((extension) => [extension.name, extension]));
  const portfolioByName = new Map((report.portfolio?.records || []).map((record) => [record.extensionId, record]));
  const rows = [];
  for (const tool of runtime.tools || []) {
    if (!tool?.name || ["builtin", "sdk"].includes(tool.sourceInfo?.source)) continue;
    const extension = extensionFromSourcePath(tool.sourceInfo?.path) || "unknown";
    const registry = registryByName.get(extension);
    const sourceFingerprint = registry?.sha256 ? `source_${String(registry.sha256).slice(0, 16)}` : "unavailable";
    const operations = Array.from(fixedStringValues(tool.parameters?.properties?.operation));
    for (const operation of operations.length ? operations : ["default"]) {
      rows.push({
        canaryId: canaryId(extension, String(tool.name), operation, sourceFingerprint),
        extension,
        sourceFingerprint,
        tool: String(tool.name),
        operation,
        stage: "planned",
        active: (runtime.activeTools || []).includes(String(tool.name)),
        mutationClass: portfolioByName.get(extension)?.mutationClass || "unknown",
        executable: false,
      });
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rows: rows.sort((left, right) => left.extension.localeCompare(right.extension) || left.tool.localeCompare(right.tool) || left.operation.localeCompare(right.operation)),
    guidance: "Canary rows are operation-level record templates, not automatic executions. Run the operation through its owning tool, then explicitly record only metadata outcome/duration against the matching canaryId.",
    privacy: { arguments: false, prompts: false, outputs: false, paths: false, sourceFingerprintOnly: true },
  };
}
function recordOperationCanary({ cwd = process.cwd(), plan, record = {}, sessionKind = "unknown", sessionToken = "none", enabled } = {}) {
  const template = (plan?.rows || []).find((row) => row.canaryId === record.canaryId);
  if (!template) throw new Error("Unknown operation canaryId. Refresh extension_ops operation=canaries and use one current planned row.");
  const stage = CANARY_STAGES.has(record.stage) ? record.stage : null;
  if (!stage || stage === "planned") throw new Error("Canary record stage must be passed, failed, or not-applicable after the owning operation settles.");
  const outcome = String(record.outcome || (stage === "passed" ? "succeeded" : stage === "not-applicable" ? "not-applicable" : "infrastructure-failed"));
  const recorder = createExtensionTelemetry({ cwd: path.resolve(cwd), extension: template.extension, version: String(record.version || "operation-canary-v1"), sourceFingerprint: template.sourceFingerprint, enabled });
  return recorder.canary(template.canaryId, template.tool, template.operation, stage, outcome, Number(record.durationMs || 0), sessionKind, sessionToken);
}

module.exports = { CANARY_STAGES, fixedStringValues, extensionFromSourcePath, canaryId, operationCanaryPlan, recordOperationCanary };
