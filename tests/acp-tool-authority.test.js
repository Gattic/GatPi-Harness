"use strict";

// ACP tool authority: Antigravity's permission requests are decided by Pi's own
// policy. These tests pin the tool-call mapping, the allow/deny/approval
// decisions, the ACP option selection and the interactive grant flow.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { FileApprovalStore } = require("../src/policy-enforcement");
const { setPolicyMode, policyMode } = require("../src/policy-mode");
const {
  acpToolRequest,
  decideAcpPermission,
  acpPermissionResponse,
  formatAcpPermissionDecision,
  selectOption,
} = require("../src/acp-permission-policy");
const { createAcpPermissionGate, gatePolicy } = require("../src/acp-permission-gate");
const { tmpFixture } = require("./helpers/tmp-fixture");

const cwd = tmpFixture("pi-acp-authority-");
const other = tmpFixture("pi-acp-authority-other-");
fs.mkdirSync(path.join(cwd, "src"), { recursive: true });

const OPTIONS = [
  { optionId: "allow_always", name: "Allow Always (risky)", kind: "allow_always" },
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

function permission(toolCall, options = OPTIONS) {
  return { sessionId: "session-1", toolCall, options };
}

// --- tool-call mapping -------------------------------------------------------
{
  const execute = acpToolRequest({ kind: "execute", rawInput: { CommandLine: "git worktree add ../x" } });
  assert.equal(execute.toolName, "bash");
  assert.equal(execute.input.command, "git worktree add ../x");
  assert.equal(execute.unmapped, false);

  const snake = acpToolRequest({ kind: "execute", rawInput: { command_line: "ls -1", working_dir: "/tmp" } });
  assert.equal(snake.input.command, "ls -1", "snake_case raw input is read too");

  const edit = acpToolRequest({
    kind: "edit",
    title: "Run create_file?",
    rawInput: { TargetFile: path.join(cwd, "src/app.js"), CodeContent: "x" },
  });
  assert.equal(edit.toolName, "edit");
  assert.equal(edit.input.path, path.join(cwd, "src/app.js"));

  const read = acpToolRequest({ kind: "read", rawInput: { file_path: path.join(cwd, "src/app.js") } });
  assert.equal(read.toolName, "read");
  assert.equal(read.input.path, path.join(cwd, "src/app.js"));

  const unknown = acpToolRequest({ kind: "fetch", rawInput: { Url: "https://example.com" } });
  assert.equal(unknown.unmapped, true);
  assert.equal(unknown.toolName, "acp_fetch");

  const pathless = acpToolRequest({ kind: "edit", rawInput: { CodeContent: "x" } });
  assert.equal(pathless.unmapped, true, "a write without a path cannot be judged by policy");

  const commandless = acpToolRequest({ kind: "execute", rawInput: {} });
  assert.equal(commandless.unmapped, true);
}

// --- decisions ---------------------------------------------------------------
{
  const store = new FileApprovalStore({ cwd });
  const allowed = decideAcpPermission(
    permission({ kind: "execute", rawInput: { CommandLine: "git status --short", Cwd: cwd } }),
    { cwd, mode: "block", approvalStore: store },
  );
  assert.equal(allowed.allow, true);
  assert.equal(allowed.optionId, "allow");
  assert.equal(acpPermissionResponse(permission({ kind: "execute" }), allowed).outcome.outcome, "selected");

  const denied = decideAcpPermission(
    permission({ kind: "execute", rawInput: { CommandLine: "rm -rf .", Cwd: cwd } }),
    { cwd, mode: "block", approvalStore: store },
  );
  assert.equal(denied.allow, false);
  assert.equal(denied.optionId, "deny");
  assert.match(formatAcpPermissionDecision(denied), /acp-permission block bash/u);

  const outsideWrite = decideAcpPermission(
    permission({ kind: "edit", rawInput: { TargetFile: path.join(other, "notes.txt") } }),
    { cwd, mode: "block", approvalStore: store },
  );
  assert.equal(outsideWrite.allow, false, "writes outside the session project are refused");
  assert.equal(outsideWrite.optionId, "deny");
  assert(outsideWrite.reasons.some((reason) => /outside repo/u.test(reason)));

  const insideWrite = decideAcpPermission(
    permission({ kind: "edit", rawInput: { TargetFile: path.join(cwd, "src/app.js") } }),
    { cwd, mode: "block", approvalStore: store },
  );
  assert.equal(insideWrite.allow, true);

  const readOutside = decideAcpPermission(
    permission({ kind: "read", rawInput: { file_path: path.join(other, "notes.txt") } }),
    { cwd, mode: "block", approvalStore: store },
  );
  assert.equal(readOutside.allow, true, "reads are not write-gated");

  // Advisory mode never blocks, exactly like Pi's own tool gate.
  const advisory = decideAcpPermission(
    permission({ kind: "execute", rawInput: { CommandLine: "rm -rf ." } }),
    { cwd, mode: "advisory", approvalStore: store },
  );
  assert.equal(advisory.allow, true);
}

// --- approval store and directory grants ------------------------------------
{
  const store = new FileApprovalStore({ cwd });
  const denied = decideAcpPermission(
    permission({ kind: "execute", rawInput: { CommandLine: "rm -rf ." } }),
    { cwd, mode: "block", approvalStore: store },
  );
  for (const item of denied.missingApprovals) store.approve(item.request, { ttlMs: 60_000 });
  const granted = decideAcpPermission(
    permission({ kind: "execute", rawInput: { CommandLine: "rm -rf ." } }),
    { cwd, mode: "block", approvalStore: store },
  );
  assert.equal(granted.allow, true, "a stored approval authorizes the same request");
  assert.equal(granted.action, "approved");

  store.approveDirectory(other, { reason: "test grant", policy: {} });
  const grantedDirectory = decideAcpPermission(
    permission({ kind: "edit", rawInput: { TargetFile: path.join(other, "notes.txt") } }),
    { cwd, mode: "block", approvalStore: store },
  );
  assert.equal(grantedDirectory.allow, true, "a directory grant extends write authority");
}

// --- unmapped requests need an explicit grant --------------------------------
{
  const store = new FileApprovalStore({ cwd: tmpFixture("pi-acp-authority-grant-") });
  const unmapped = decideAcpPermission(
    permission({ kind: "fetch", rawInput: { Url: "https://example.com" } }),
    { cwd, mode: "block", approvalStore: store },
  );
  assert.equal(unmapped.allow, false);
  assert.equal(unmapped.action, "approval-required", "an ACP tool Pi cannot judge needs a person");
  assert.equal(unmapped.optionId, "deny");
  assert.equal(unmapped.missingApprovals.length, 1);
  for (const item of unmapped.missingApprovals) store.approve(item.request, { ttlMs: 60_000 });
  const approved = decideAcpPermission(
    permission({ kind: "fetch", rawInput: { Url: "https://elsewhere.example" } }),
    { cwd, mode: "block", approvalStore: store },
  );
  assert.equal(approved.allow, true, "one grant covers every call of that ACP tool");
  assert.equal(approved.action, "approved");
}

// --- option selection --------------------------------------------------------
{
  const allow = { allow: true, action: "allow", evaluations: [] };
  assert.equal(selectOption(OPTIONS, allow), "allow", "Pi grants one call, not a standing server grant");
  assert.equal(selectOption([{ optionId: "allow_always", kind: "allow_always" }], allow), undefined);
  assert.equal(
    selectOption([{ optionId: "allow_always", kind: "allow_always" }], allow, { persistentApproved: true }),
    "allow_always",
    "a persistent server grant is only acceptable when Pi already holds the grant",
  );
  const deny = { allow: false, action: "block", evaluations: [] };
  assert.equal(selectOption(OPTIONS, deny), "deny");
  assert.equal(selectOption([], deny), undefined, "no matching option means cancelled");
  assert.deepEqual(acpPermissionResponse({ options: [] }, deny), { outcome: { outcome: "cancelled" } });
}

// --- the gate asks a person and records the grant ----------------------------
async function gateTests() {
  const gateCwd = tmpFixture("pi-acp-authority-gate-");
  const store = new FileApprovalStore({ cwd: gateCwd });
  const asked = [];
  const notifications = [];
  const pi = { events: { emit: () => {} } };
  const ctx = {
    hasUI: true,
    ui: {
      confirm: async (title, message) => {
        asked.push({ title, message });
        return true;
      },
      notify: (message, type) => notifications.push({ message, type }),
    },
  };
  const gate = createAcpPermissionGate({
    cwd: gateCwd,
    pi,
    getContext: () => ctx,
    approvalStore: store,
  });
  const unmapped = permission({ kind: "fetch", rawInput: { Url: "https://example.com" } });
  const response = await gate.request(unmapped);
  assert.equal(asked.length, 1);
  assert.match(asked[0].message, /acp-permission approval-required acp_fetch/u);
  assert.deepEqual(response.outcome, { outcome: "selected", optionId: "allow" });
  assert.equal(store.list().length, 1, "the interactive answer becomes a Pi approval grant");

  // A denied decision never reaches the dialog and always explains itself.
  const deniedGate = createAcpPermissionGate({
    cwd: gateCwd,
    pi,
    getContext: () => ({ hasUI: true, ui: { confirm: async () => assert.fail("must not ask"), notify: (m, t) => notifications.push({ message: m, type: t }) } }),
    approvalStore: store,
  });
  const deniedResponse = await deniedGate.request(
    permission({ kind: "execute", rawInput: { CommandLine: "rm -rf ." } }),
  );
  assert.deepEqual(deniedResponse.outcome, { outcome: "selected", optionId: "deny" });
  assert(notifications.some((item) => item.type === "warning" && /rm -rf/u.test(item.message)));

  // Without a UI an approval-required request is denied instead of hanging.
  const headless = createAcpPermissionGate({
    cwd: gateCwd,
    pi,
    getContext: () => ({ hasUI: false, ui: { notify: () => {} } }),
    approvalStore: new FileApprovalStore({ cwd: tmpFixture("pi-acp-authority-headless-") }),
  });
  const headlessResponse = await headless.request(
    permission({ kind: "fetch", rawInput: { Url: "https://example.com" } }),
  );
  assert.deepEqual(headlessResponse.outcome, { outcome: "selected", optionId: "deny" });

  // --- the gate reads the project policy file and the shared mode ------------
  const policyCwd = tmpFixture("pi-acp-authority-policy-");
  fs.mkdirSync(path.join(policyCwd, ".pi", "policy-gate"), { recursive: true });
  fs.writeFileSync(
    path.join(policyCwd, ".pi", "policy-gate", "policy.json"),
    JSON.stringify({ denyPathPrefixes: [path.join(policyCwd, "secrets")] }),
  );
  assert.deepEqual(gatePolicy(policyCwd).denyPathPrefixes, [path.join(policyCwd, "secrets")]);
  const policyGate = createAcpPermissionGate({ cwd: policyCwd });
  const blocked = await policyGate.request(
    permission({ kind: "edit", rawInput: { TargetFile: path.join(policyCwd, "secrets", "key.txt") } }),
  );
  assert.deepEqual(blocked.outcome, { outcome: "selected", optionId: "deny" });

  const previous = policyMode();
  try {
    setPolicyMode("approval");
    assert.equal(policyMode(), "approval", "Pi tool calls and ACP calls share one mode");
    assert.throws(() => setPolicyMode("yolo"), /unknown policy mode/u);
  } finally {
    setPolicyMode(previous);
  }
}

gateTests()
  .then(() => console.log("acp tool authority tests passed"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
