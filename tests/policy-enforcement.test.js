"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { FileApprovalStore, enforceToolCall, toolRequests } = require("../src/policy-enforcement");
const { serializablePolicy } = require("../src/runtime-policy");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-policy-enforce-");
assert.ok(toolRequests("bash", { command: "rm -rf ." }).some((r) => r.command));
const denied = enforceToolCall("bash", { command: "rm -rf ." }, { cwd: tmp, mode: "block", approvalStore: new FileApprovalStore({ cwd: tmp }) });
assert.equal(denied.allow, false);
assert.equal(denied.action, "block");
const store = new FileApprovalStore({ cwd: tmp });
for (const item of denied.missingApprovals) store.approve(item.request, { ttlMs: 10000 });
const approved = enforceToolCall("bash", { command: "rm -rf ." }, { cwd: tmp, mode: "block", approvalStore: store });
assert.equal(approved.allow, true);
assert.equal(approved.action, "approved");
const warn = enforceToolCall("bash", { command: "npm install left-pad" }, { cwd: tmp, mode: "block", approvalStore: store });
assert.equal(warn.allow, true);
assert.equal(warn.action, "warn");
const unknownExtensionTool = enforceToolCall("some_future_extension_tool", {}, { cwd: tmp, mode: "approval", approvalStore: store });
assert.equal(unknownExtensionTool.allow, true, "allowlist-only warnings must not block extension tools");
assert.equal(unknownExtensionTool.action, "allow");
const readOnlyPatternSearch = enforceToolCall("bash", { command: "rg -n 'rm -rf' tests" }, { cwd: tmp, mode: "block", approvalStore: store });
assert.equal(readOnlyPatternSearch.allow, true, "dangerous words in quoted search arguments are not executed commands");
const serializedPolicy = serializablePolicy({});
const serializedApprovals = new FileApprovalStore({ cwd: tmpFixture("pi-policy-serialized-") });
const serializedReadOnly = enforceToolCall("bash", { command: "rg -n 'rm -rf' tests" }, { cwd: tmp, mode: "block", policy: serializedPolicy, approvalStore: serializedApprovals });
assert.equal(serializedReadOnly.allow, true, "serialized default policy still applies structural shell parsing");
const serializedDenied = enforceToolCall("bash", { command: "rm -rf ." }, { cwd: tmp, mode: "block", policy: serializedPolicy, approvalStore: serializedApprovals });
assert.equal(serializedDenied.allow, false, "serialized default policy retains recursive removal denial");
const customPolicy = serializablePolicy({ denyShell: [/custom-deny-token/i] });
const customDenied = enforceToolCall("bash", { command: "echo custom-deny-token" }, { cwd: tmp, mode: "block", policy: customPolicy, approvalStore: serializedApprovals });
assert.equal(customDenied.allow, false, "serialized custom regex patterns retain their flags and source");

const previousHome = process.env.HOME;
try {
  const fakeHome = tmpFixture("pi-policy-home-");
  process.env.HOME = fakeHome;
  const tildePath = "~/dev/mathproblem.md";
  const fullPath = path.join(fakeHome, "dev", "mathproblem.md");
  const tildeWrite = toolRequests("write", { path: tildePath }).find((request) => request.kind === "write");
  const fullWrite = toolRequests("write", { path: fullPath }).find((request) => request.kind === "write");
  assert.deepEqual(tildeWrite, fullWrite, "~ paths and absolute home paths produce the same approval request");

  const tildeStore = new FileApprovalStore({ cwd: tmp });
  const tildeDenied = enforceToolCall("write", { path: tildePath }, { cwd: tmp, mode: "block", approvalStore: tildeStore });
  assert.equal(tildeDenied.allow, false);
  assert(!tildeDenied.reasons.includes("no policy violations detected"), "deny output should not mix in successful request reasons");
  for (const item of tildeDenied.missingApprovals) tildeStore.approve(item.request, { ttlMs: 10000 });
  const fullApproved = enforceToolCall("write", { path: fullPath }, { cwd: tmp, mode: "block", approvalStore: tildeStore });
  assert.equal(fullApproved.allow, true, "approval granted for ~/path also covers the equivalent absolute home path");
  const manualTildeStore = new FileApprovalStore({ cwd: tmp });
  manualTildeStore.approve({ kind: "write", path: tildePath }, { ttlMs: 10000 });
  const manualFullApproved = enforceToolCall("write", { path: fullPath }, { cwd: tmp, mode: "block", approvalStore: manualTildeStore });
  assert.equal(manualFullApproved.allow, true, "manual approvals normalize ~/path before computing approval keys");
} finally {
  process.env.HOME = previousHome;
}

console.log("policy-enforcement tests passed");
