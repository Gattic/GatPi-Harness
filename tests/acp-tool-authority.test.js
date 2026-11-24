"use strict";

// ACP tool authority: Antigravity's permission requests are decided by Pi's own
// policy. These tests pin the tool-call mapping, the auto-approve/deny/approval
// decisions, the ACP option selection and the non-blocking gate.

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
  assert.equal(execute.missing, undefined);

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

  // An ACP tool Pi has no rule for is judged like an unknown Pi tool, not
  // forced through an approval prompt.
  const fetch = acpToolRequest({ kind: "fetch", rawInput: { Url: "https://example.com" } });
  assert.equal(fetch.toolName, "acp_fetch");
  assert.equal(fetch.missing, undefined);

  const pathless = acpToolRequest({ kind: "edit", rawInput: { CodeContent: "x" } });
  assert.equal(pathless.missing, "path", "a write without a path cannot be judged by policy");

  const commandless = acpToolRequest({ kind: "execute", rawInput: {} });
  assert.equal(commandless.missing, "command");
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

  // A conforming fetch is approved from policy: no dialog, no approval key.
  const fetch = decideAcpPermission(
    permission({ kind: "fetch", rawInput: { Url: "https://example.com" } }),
    { cwd, mode: "block", approvalStore: store },
  );
  assert.equal(fetch.allow, true, "an ACP tool without a path or command is not a violation");
  assert.equal(fetch.optionId, "allow");
  assert.equal(fetch.missingApprovals.length, 0);

  const denied = decideAcpPermission(
    permission({ kind: "execute", rawInput: { CommandLine: "rm -rf .", Cwd: cwd } }),
    { cwd, mode: "block", approvalStore: store },
  );
  assert.equal(denied.allow, false);
  assert.equal(denied.optionId, "deny");
  assert.equal(denied.missingApprovals.length, 1, "a refused call carries the key that would allow it");
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

// --- requests Pi cannot judge are refused, never prompted -------------------
{
  const store = new FileApprovalStore({ cwd });
  const pathless = decideAcpPermission(
    permission({ kind: "delete", rawInput: { CodeContent: "x" } }),
    { cwd, mode: "block", approvalStore: store },
  );
  assert.equal(pathless.allow, false);
  assert.equal(pathless.action, "block");
  assert.equal(pathless.optionId, "deny");
  assert.match(pathless.reasons[0], /carries no path/u);
  assert.equal(pathless.missingApprovals.length, 0, "there is no request shape to grant");

  const commandless = decideAcpPermission(
    permission({ kind: "execute", rawInput: { WaitMsBeforeAsync: 5000 } }),
    { cwd, mode: "approval", approvalStore: store },
  );
  assert.equal(commandless.allow, false, "approval mode cannot approve a command it cannot see");
  assert.equal(commandless.optionId, "deny");
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

// --- the gate answers immediately and never opens a dialog ------------------
async function gateTests() {
  const gateCwd = tmpFixture("pi-acp-authority-gate-");
  const store = new FileApprovalStore({ cwd: gateCwd });
  const notifications = [];
  const ctx = {
    hasUI: true,
    ui: {
      confirm: () => assert.fail("the ACP gate must never open a dialog mid-stream"),
      notify: (message, type) => notifications.push({ message, type }),
    },
  };
  const gate = createAcpPermissionGate({
    cwd: gateCwd,
    getContext: () => ctx,
    approvalStore: store,
  });

  // A conforming call is approved silently.
  const allowed = await gate.request(permission({ kind: "fetch", rawInput: { Url: "https://example.com" } }));
  assert.deepEqual(allowed.outcome, { outcome: "selected", optionId: "allow" });
  assert.equal(notifications.length, 0, "an approved call does not notify");

  // A violation is refused at once, with the reason and the grant command.
  const denied = await gate.request(permission({ kind: "execute", rawInput: { CommandLine: "rm -rf ." } }));
  assert.deepEqual(denied.outcome, { outcome: "selected", optionId: "deny" });
  const warning = notifications.find((item) => item.type === "warning");
  assert(warning);
  assert.match(warning.message, /acp-permission block bash/u);
  assert.match(warning.message, /Approve once with: \/policy-approve approval_[a-f0-9]+/u);

  // Granting that key makes the next identical call conform.
  const key = denied.outcome.optionId === "deny" ? warning.message.match(/\/policy-approve (approval_[a-f0-9]+)/u)[1] : undefined;
  const blocked = decideAcpPermission(
    permission({ kind: "execute", rawInput: { CommandLine: "rm -rf ." } }),
    { cwd: gateCwd, mode: "block", approvalStore: store },
  );
  for (const item of blocked.missingApprovals) assert.equal(item.key, key);
  store.approve({ ...blocked.missingApprovals[0].request }, { ttlMs: 60_000, key });
  const regranted = await gate.request(permission({ kind: "execute", rawInput: { CommandLine: "rm -rf ." } }));
  assert.deepEqual(regranted.outcome, { outcome: "selected", optionId: "allow" });

  // Without a UI the decision is identical: nothing depends on a prompt.
  const headless = createAcpPermissionGate({
    cwd: gateCwd,
    getContext: () => ({ hasUI: false, ui: {} }),
    approvalStore: new FileApprovalStore({ cwd: tmpFixture("pi-acp-authority-headless-") }),
  });
  const headlessDenied = await headless.request(permission({ kind: "execute", rawInput: { CommandLine: "sudo -n true" } }));
  assert.deepEqual(headlessDenied.outcome, { outcome: "selected", optionId: "deny" });

  // --- the gate reads the project policy file and the shared mode ------------
  const policyCwd = tmpFixture("pi-acp-authority-policy-");
  fs.mkdirSync(path.join(policyCwd, ".pi", "policy-gate"), { recursive: true });
  fs.writeFileSync(
    path.join(policyCwd, ".pi", "policy-gate", "policy.json"),
    JSON.stringify({ denyPathPrefixes: [path.join(policyCwd, "secrets")] }),
  );
  assert.deepEqual(gatePolicy(policyCwd).denyPathPrefixes, [path.join(policyCwd, "secrets")]);
  const policyGate = createAcpPermissionGate({ cwd: policyCwd });
  const blockedWrite = await policyGate.request(
    permission({ kind: "edit", rawInput: { TargetFile: path.join(policyCwd, "secrets", "key.txt") } }),
  );
  assert.deepEqual(blockedWrite.outcome, { outcome: "selected", optionId: "deny" });

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
