"use strict";
const assert = require("node:assert/strict");
const { DEFAULT_ROLE_CONTRACTS } = require("../src/role-contracts");
const { digest } = require("../src/subagent-task-contracts");
const { createDiagnosticEvidenceCollector, validateDiagnosticEvidence, MAX_DIAGNOSTIC_EVIDENCE_BYTES } = require("../src/diagnostic-evidence");
const contract = structuredClone(DEFAULT_ROLE_CONTRACTS.find(role => role.roleId === "reliability-investigator"));
const execution = { target: "workload", sha256: "a".repeat(64), args: ["--crash"], operations: ["gdb-backtrace"], timeoutMs: 30000 };
contract.settings.domainInput = { execution };
const start = { type: "tool_execution_start", toolName: "role_domain", toolCallId: "native-1", args: { operation: "gdb-backtrace", file: "workload" } };
const result = { ok: false, exitCode: 255, signal: null, termination: null, stdout: "SIGABRT\n#0 intentional_crash\n#1 main\n", stderr: "expected abort\n", privateThinking: "NEVER_RETAIN_PRIVATE", diagnosticEvidence: { operation: "gdb-backtrace", target: "workload", targetSha256: execution.sha256, argumentsSha256: digest(JSON.stringify(execution.args)).slice(7), tools: { gdb: { available: true, path: "/usr/bin/gdb", sha256: "b".repeat(64), extra: "NEVER_RETAIN_PRIVATE" } }, gpuDevices: [], timeoutMs: 30000 } };
const end = { type: "tool_execution_end", toolName: "role_domain", toolCallId: start.toolCallId, isError: true, result: { content: [{ type: "text", text: "irrelevant presentation" }], details: result } };
const collector = () => createDiagnosticEvidenceCollector({ subagentId: "producer", contract, now: () => "2026-10-18T00:00:00Z" });
const c = collector();
for (const event of [
  { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "NEVER_RETAIN_PRIVATE" } },
  { ...end, toolName: "submit_role_result" },
  { ...end, toolName: "read" },
]) c.observe(event);
assert.deepEqual(c.snapshot(), [], "only supervised native tool completions are evidence");
c.observe(start); c.observe(end);
const records = c.snapshot();
validateDiagnosticEvidence(records, { subagentId: "producer", execution });
assert.equal(records[0].stdout, result.stdout);
assert.equal(records[0].stderr, result.stderr);
assert.equal(records[0].ok, false);
assert.equal(records[0].exitCode, 255, "an intentional crash is retained, not converted to success");
assert(!JSON.stringify(records).includes("NEVER_RETAIN_PRIVATE"));
records[0].stdout = "tampered";
assert.equal(c.snapshot()[0].stdout, result.stdout, "callers cannot mutate retained originals");
assert.throws(() => validateDiagnosticEvidence(records, { subagentId: "producer", execution }), /DIGEST_INVALID/);
assert.throws(() => validateDiagnosticEvidence(c.snapshot(), { subagentId: "other", execution }), /IDENTITY_INVALID/);
assert.throws(() => validateDiagnosticEvidence([], { subagentId: "producer", execution }), /REQUIRED/);
assert.throws(() => c.observe(end), /UNMATCHED_RESULT/);
assert.throws(() => collector().observe(end), /UNMATCHED_RESULT/);
for (const change of [
  r => { r.diagnosticEvidence.targetSha256 = "c".repeat(64); },
  r => { r.diagnosticEvidence.argumentsSha256 = "c".repeat(64); },
  r => { r.diagnosticEvidence.timeoutMs = 1; },
  r => { r.diagnosticEvidence.gpuDevices = ["/dev/nvidia0"]; },
  r => { r.diagnosticEvidence.operation = "time-profile"; },
]) {
  const malformed = structuredClone(end); change(malformed.result.details);
  const instance = collector(); instance.observe(start);
  assert.throws(() => instance.observe(malformed), /DIAGNOSTIC_EVIDENCE_/);
  assert.deepEqual(instance.snapshot(), []);
}
const huge = structuredClone(end); huge.result.details.stdout = "x".repeat(MAX_DIAGNOSTIC_EVIDENCE_BYTES);
const capped = collector(); capped.observe(start);
assert.throws(() => capped.observe(huge), /LIMIT/);
assert.deepEqual(capped.snapshot(), [], "overflow never silently truncates an original receipt");
const denied = collector(); denied.observe(start); denied.observe({ ...end, result: { content: [{ type: "text", text: "denied" }] } });
assert.deepEqual(denied.snapshot(), []);
console.log("✓ native evidence correlation, exact failed output, authorization/digest binding, privacy and retention bounds");
