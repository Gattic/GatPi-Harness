"use strict";

const { digest, invariant, clone } = require("./subagent-task-contracts");

// A retention/transport bound, not a model-call or correction budget.
const MAX_DIAGNOSTIC_EVIDENCE_BYTES = 262144;
const SOURCE = "supervised-role-domain";
const nativeRole = role => ["reliability-investigator", "code-profiler"].includes(role);
const bytes = value => Buffer.byteLength(JSON.stringify(value));

function validateRecord(record, { subagentId, execution }) {
  invariant(record.source === SOURCE && record.schemaVersion === 1 && record.subagentId === subagentId && typeof record.toolCallId === "string" && record.toolCallId.length > 0, "DIAGNOSTIC_EVIDENCE_IDENTITY_INVALID");
  invariant(execution?.operations.includes(record.operation) && record.target === execution.target && record.targetSha256 === execution.sha256 && record.argumentsSha256 === digest(JSON.stringify(execution.args)).slice(7), "DIAGNOSTIC_EVIDENCE_AUTHORIZATION_MISMATCH");
  invariant(record.timeoutMs === execution.timeoutMs && digest(record.gpuDevices) === digest(record.operation === "nsys-profile" ? execution.gpuDevices || [] : []), "DIAGNOSTIC_EVIDENCE_GRANT_MISMATCH");
  invariant(typeof record.stdout === "string" && typeof record.stderr === "string" && typeof record.ok === "boolean" && (record.exitCode === null || Number.isInteger(record.exitCode)) && (record.signal === null || typeof record.signal === "string") && (record.termination === null || typeof record.termination === "string"), "DIAGNOSTIC_EVIDENCE_RESULT_INVALID");
  invariant(record.tools && Object.keys(record.tools).length > 0 && Object.values(record.tools).every(tool => tool.available === true && typeof tool.path === "string" && /^[a-f0-9]{64}$/.test(tool.sha256)), "DIAGNOSTIC_EVIDENCE_TOOLS_INVALID");
}

function validateDiagnosticEvidence(records, { subagentId, execution }) {
  invariant(Array.isArray(records) && records.length > 0, "DIAGNOSTIC_EVIDENCE_REQUIRED");
  invariant(bytes(records) <= MAX_DIAGNOSTIC_EVIDENCE_BYTES, "DIAGNOSTIC_EVIDENCE_LIMIT");
  const ids = new Set();
  for (const record of records) {
    const { id, digest: hash, ...body } = record;
    validateRecord(body, { subagentId, execution });
    invariant(hash === digest(body) && id === `diagnostic-${hash.slice(7, 31)}` && !ids.has(record.toolCallId), "DIAGNOSTIC_EVIDENCE_DIGEST_INVALID");
    ids.add(record.toolCallId);
  }
  return records;
}

function createDiagnosticEvidenceCollector({ subagentId, contract, now = () => new Date().toISOString() }) {
  const execution = nativeRole(contract?.roleId) && contract.settings?.domainInput?.execution;
  const pending = new Map(), completed = new Set(), records = [];
  return {
    observe(event) {
      if (!execution || event.toolName !== "role_domain") return;
      if (event.type === "tool_execution_start") {
        invariant(typeof event.toolCallId === "string" && !pending.has(event.toolCallId) && !completed.has(event.toolCallId), "DIAGNOSTIC_EVIDENCE_DUPLICATE_CALL");
        pending.set(event.toolCallId, { operation: event.args?.operation, file: event.args?.file });
        invariant(bytes([...pending]) <= MAX_DIAGNOSTIC_EVIDENCE_BYTES, "DIAGNOSTIC_EVIDENCE_LIMIT");
      }
      if (event.type !== "tool_execution_end") return;
      const call = pending.get(event.toolCallId);
      // Never accept an orphan result or producer-authored submission as evidence.
      invariant(call && !completed.has(event.toolCallId), "DIAGNOSTIC_EVIDENCE_UNMATCHED_RESULT");
      pending.delete(event.toolCallId); completed.add(event.toolCallId);
      const result = event.result?.details, metadata = result?.diagnosticEvidence;
      if (!metadata) return; // A denied call / launch failure is not native evidence.
      invariant(call.operation === metadata.operation && call.file === metadata.target && contract.settings.domainOperations.includes(metadata.operation), "DIAGNOSTIC_EVIDENCE_CALL_MISMATCH");
      const tools = Object.fromEntries(Object.entries(metadata.tools || {}).map(([name, tool]) => [name, { available: tool.available, path: tool.path, sha256: tool.sha256 }]));
      const body = {
        schemaVersion: 1, source: SOURCE, subagentId, toolCallId: event.toolCallId, observedAt: now(),
        operation: metadata.operation, target: metadata.target, targetSha256: metadata.targetSha256,
        argumentsSha256: metadata.argumentsSha256, tools, gpuDevices: metadata.gpuDevices,
        timeoutMs: metadata.timeoutMs, ok: result.ok, exitCode: result.exitCode,
        signal: result.signal ?? null, termination: result.termination ?? null,
        stdout: result.stdout, stderr: result.stderr,
      };
      validateRecord(body, { subagentId, execution });
      const hash = digest(body), receipt = { ...body, id: `diagnostic-${hash.slice(7, 31)}`, digest: hash };
      invariant(bytes([...records, receipt]) <= MAX_DIAGNOSTIC_EVIDENCE_BYTES, "DIAGNOSTIC_EVIDENCE_LIMIT");
      records.push(receipt);
    },
    snapshot: () => clone(records),
  };
}

module.exports = { MAX_DIAGNOSTIC_EVIDENCE_BYTES, createDiagnosticEvidenceCollector, validateDiagnosticEvidence };
