"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { SubagentWorkspaceManager, repositoryFingerprint } = require("../src/subagent-workspaces");
const { SubagentService, SubagentRunner } = require("../src/subagents");
const { DEFAULT_ROLE_CONTRACTS } = require("../src/role-contracts");
const { createRoleResultEnvelope } = require("../src/role-result-schemas");
const { tmpFixture } = require("./helpers/tmp-fixture");

function git(cwd, args, input) { return execFileSync("git", args, { cwd, input, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Pi Test", GIT_AUTHOR_EMAIL: "pi@example.invalid", GIT_COMMITTER_NAME: "Pi Test", GIT_COMMITTER_EMAIL: "pi@example.invalid" } }).trim(); }
function repo() {
  const cwd = tmpFixture("pi-role-workspace-");
  git(cwd, ["init", "-q"]);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "base\n");
  fs.writeFileSync(path.join(cwd, "staged.txt"), "base staged\n");
  git(cwd, ["add", "."]); git(cwd, ["commit", "-qm", "base"]);
  return cwd;
}
function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

(async () => {
  {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "staged.txt"), "parent staged\n");
    git(cwd, ["add", "staged.txt"]);
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "parent unstaged\n");
    fs.writeFileSync(path.join(cwd, "notes.md"), "parent untracked\n");
    fs.writeFileSync(path.join(cwd, ".env"), "SYNTHETIC_SECRET=redacted\n");
    try { fs.symlinkSync(path.join(cwd, "..", "outside-seed"), path.join(cwd, "outside-link")); } catch {}
    const before = repositoryFingerprint(cwd);
    const manager = new SubagentWorkspaceManager({ cwd });
    const lease = manager.acquire({ subagentId: "sub_seed", parentSessionId: "sess", task: "seed dirty tree" });
    assert.equal(lease.policy, "isolated-worktree");
    assert.deepEqual(new Set(lease.inheritedChangedPaths), new Set(["notes.md", "staged.txt", "tracked.txt"]), "the private lease records only safe inherited dirty paths");
    assert.equal(fs.statSync(lease.workspaceDir).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(lease.cwd, "tracked.txt"), "utf8"), "parent unstaged\n");
    assert.equal(fs.readFileSync(path.join(lease.cwd, "staged.txt"), "utf8"), "parent staged\n");
    assert.equal(fs.readFileSync(path.join(lease.cwd, "notes.md"), "utf8"), "parent untracked\n");
    assert.equal(fs.existsSync(path.join(lease.cwd, ".env")), false, "credential-like untracked files are excluded from workspace seeding");
    assert.throws(() => fs.lstatSync(path.join(lease.cwd, "outside-link")), /ENOENT/, "untracked symlinks are excluded from workspace seeding");
    assert.throws(() => manager.acquire({ subagentId: "sub_duplicate", parentSessionId: "sess", task: "seed dirty tree" }), (error) => error.code === "SUBAGENT_WORKSPACE_LEASE_CONFLICT", "parallel mutable leases for the same parent task fail closed");
    const orderedLease = manager.acquire({ subagentId: "sub_ordered", parentSessionId: "sess", task: "seed dirty tree", allowParallelWorkspace: true, mergeOrder: 1 });
    manager.release(orderedLease, { remove: true });
    assert.deepEqual(repositoryFingerprint(cwd), before, "workspace acquisition leaves parent HEAD/status/source hashes unchanged");

    fs.writeFileSync(path.join(lease.cwd, "tracked.txt"), "child tracked\n");
    fs.writeFileSync(path.join(lease.cwd, "new.bin"), Buffer.from([0, 1, 2, 3]));
    const capture = manager.capture(lease, { status: "succeeded", verification: { status: "unchecked", evidence: [] } });
    assert(capture.patchBytes > 0);
    assert(capture.changedPaths.some((entry) => entry.path === "tracked.txt"));
    assert(capture.changedPaths.some((entry) => entry.path === "new.bin"));
    assert.equal(fs.statSync(capture.patchFile).mode & 0o777, 0o600);
    assert.deepEqual(repositoryFingerprint(cwd), before, "capturing a child patch does not touch the parent tree");
    const verificationLease = manager.acquire({ subagentId: "sub_verify_seed", parentSessionId: "sess", task: "verify seeded proposal", seedPatches: [capture] });
    assert.equal(fs.readFileSync(path.join(verificationLease.cwd, "tracked.txt"), "utf8"), "child tracked\n", "downstream isolated workspaces receive upstream proposed changes");
    assert.equal(fs.readFileSync(path.join(verificationLease.cwd, "new.bin")).length, 4);
    assert.deepEqual(repositoryFingerprint(cwd), before, "seeding a downstream verifier still leaves the parent untouched");
    manager.release(verificationLease, { remove: true });
    fs.writeFileSync(path.join(cwd, "notes.md"), "different untracked contents\n");
    assert.equal(repositoryFingerprint(cwd).statusHash, before.statusHash, "Git status alone cannot detect content drift");
    assert.throws(() => manager.acquire({ subagentId: "sub_stale_contents", parentSessionId: "sess", task: "reject same-status content drift", seedPatches: [capture] }), error => error.code === "SUBAGENT_WORKSPACE_SEED_PATCH_STALE");
    fs.writeFileSync(path.join(cwd, "notes.md"), "parent untracked\n");
    try {
      fs.symlinkSync(path.join(cwd, "..", "outside-secret"), path.join(lease.cwd, "escape-link"));
      assert.throws(() => manager.capture(lease, { status: "failed" }), (error) => error.code === "SUBAGENT_WORKSPACE_SYMLINK_ESCAPE", "captured patches reject symlinks escaping the workspace");
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES" && error?.code !== "SUBAGENT_WORKSPACE_SYMLINK_ESCAPE") throw error;
    }
    manager.release(lease, { remove: true });
  }

  {
    const cwd = repo();
    const nested = path.join(cwd, "packages", "nested");
    fs.mkdirSync(nested, { recursive: true });
    const before = repositoryFingerprint(cwd);
    const manager = new SubagentWorkspaceManager({ cwd: nested });
    const lease = manager.acquire({ subagentId: "sub_nested", parentSessionId: "sess", task: "nested cwd isolation" });
    assert.equal(lease.workspaceDir.startsWith(path.join(cwd, ".pi", "subagents", "workspaces")), true, "workspace state is rooted at the Git toplevel even when Pi starts in a subdirectory");
    assert.deepEqual(repositoryFingerprint(cwd), before);
    manager.release(lease, { remove: true });
  }

  {
    const cwd = tmpFixture("pi-role-nongit-");
    const manager = new SubagentWorkspaceManager({ cwd });
    assert.throws(() => manager.acquire({ subagentId: "sub_no_git", parentSessionId: "sess", task: "mutate" }), (error) => error.code === "SUBAGENT_WORKSPACE_GIT_REQUIRED");
    let executed = false;
    const service = new SubagentService({ cwd, runner: new SubagentRunner({ execute: async () => { executed = true; return { summary: "unsafe", final_response: "unsafe" }; } }) });
    const sub = service.createSubagent({ parentSessionId: "sess_no_git", role: "coder", task: "must not fall back", workspacePolicy: "isolated-worktree", mutationPolicy: "proposed-patch" });
    const result = await service.runSubagent({ subagentId: sub.id });
    assert.equal(result.status, "failed");
    assert.match(result.final_response, /non-Git shared-cwd fallback is forbidden/);
    assert.equal(executed, false, "non-Git mutation is refused before child execution");
  }

  for (const finalState of ["succeeded", "failed", "cancelled", "timed_out"]) {
    const cwd = repo();
    const parentFile = path.join(cwd, "tracked.txt");
    const beforeFingerprint = repositoryFingerprint(cwd);
    const beforeHash = hash(parentFile);
    const controller = new AbortController();
    const runner = new SubagentRunner({ execute: async ({ context }) => {
      fs.writeFileSync(path.join(context.cwd, "tracked.txt"), `${finalState} child write\n`);
      fs.writeFileSync(path.join(context.cwd, `${finalState}.txt`), "recovery artifact\n");
      if (finalState === "failed") throw new Error("synthetic child failure");
      if (finalState === "timed_out") await delay(100);
      if (finalState === "cancelled") { setTimeout(() => controller.abort(), 5); await delay(100, undefined, { signal: context.signal }); }
      return { summary: `${finalState} child`, final_response: `${finalState} child result` };
    } });
    const service = new SubagentService({ cwd, runner, config: { defaultWallClockMs: 20, maxConcurrentPerParent: 4 } });
    const sub = service.createSubagent({ parentSessionId: `sess_${finalState}`, role: "coder", task: `${finalState} after write`, workspacePolicy: "isolated-worktree", mutationPolicy: "proposed-patch", budget: { wallClockMs: finalState === "timed_out" ? 20 : 1000 } });
    const result = await service.runSubagent({ subagentId: sub.id, context: { signal: finalState === "cancelled" ? controller.signal : undefined } });
    assert.equal(result.status, finalState);
    assert.equal(hash(parentFile), beforeHash, `${finalState} child cannot change parent bytes`);
    assert.deepEqual(repositoryFingerprint(cwd), beforeFingerprint, `${finalState} child cannot change parent status fingerprint`);
    assert.equal(result.diagnostics.workspace.policy, "isolated-worktree");
    assert.equal(result.diagnostics.workspace.retained, true, `${finalState} changed workspace is retained for recovery`);
    assert(fs.existsSync(result.diagnostics.workspace.path));
    assert(result.diagnostics.workspace.patchHash, "retained workspace records a bounded patch hash");
  }

  {
    const cwd = repo();
    const parentFile = path.join(cwd, "tracked.txt");
    const before = repositoryFingerprint(cwd);
    const beforeHash = hash(parentFile);
    const fakeRpc = path.join(cwd, "write-then-timeout-rpc.js");
    fs.writeFileSync(fakeRpc, `
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "tracked.txt"), "rpc child write before timeout\\n");
fs.writeFileSync(path.join(process.cwd(), "rpc-recovery.txt"), "recover me\\n");
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`);
    git(cwd, ["add", "write-then-timeout-rpc.js"]); git(cwd, ["commit", "-qm", "add synthetic rpc fixture"]);
    const stableBefore = repositoryFingerprint(cwd);
    const service = new SubagentService({ cwd, config: { defaultWallClockMs: 120 } });
    const sub = service.createSubagent({ parentSessionId: "sess_real_timeout", role: "coder", task: "write then time out in a real subprocess", workspacePolicy: "isolated-worktree", mutationPolicy: "proposed-patch", budget: { wallClockMs: 120 } });
    const result = await service.runSubagent({ subagentId: sub.id, context: { executionMode: "tool-rpc", cwd, rpc: { command: process.execPath, argsPrefix: [fakeRpc], timeoutMs: 120 } } });
    assert.equal(result.status, "timed_out");
    assert.equal(hash(parentFile), beforeHash, "real timed-out RPC writes remain outside parent source bytes");
    assert.deepEqual(repositoryFingerprint(cwd), stableBefore, "real timed-out RPC leaves parent HEAD and status fingerprint unchanged");
    assert(result.diagnostics.workspace.changedPaths.includes("tracked.txt"));
    assert(result.diagnostics.workspace.changedPaths.includes("rpc-recovery.txt"));
    assert.equal(result.diagnostics.workspace.retained, true);
    assert.notDeepEqual(before.head, stableBefore.head, "fixture setup committed before the invariant snapshot");
  }

  {
    const cwd = repo();
    let observedMode;
    const coderContract = DEFAULT_ROLE_CONTRACTS.find((role) => role.roleId === "coder");
    const runner = new SubagentRunner({ execute: async ({ record, context }) => {
      observedMode = context.executionMode;
      const submitted = createRoleResultEnvelope({ contract: coderContract, subagentId: record.id, submission: { summary: "Implementation completed but accidentally produced no workspace patch.", findings: [], evidence: [{ kind: "command", summary: "Inspected the isolated workspace diff." }], artifacts: [], proposedPatch: null, verification: { status: "passed", evidence: ["workspace diff inspected"] } } });
      return {
        summary: submitted.summary,
        final_response: submitted.summary,
        submitted_result: submitted,
        termination: submitted.termination,
        modelCalls: 7,
        toolCalls: 35,
        toolResults: 35,
        toolFailures: 2,
        unmatchedToolCallIds: [],
        unmatchedToolResultIds: [],
        selected_model: "test/coder",
        effective_model: "test/coder",
        fallback_model: "test/coder",
        model_policy_source: "fixture",
        selected_thinking_level: "xhigh",
        effective_thinking_level: "xhigh",
        thinking_policy_source: "fixture",
        rpc_session_dir: "fixture-session",
      };
    } });
    const service = new SubagentService({ cwd, runner });
    const sub = service.createSubagent({ parentSessionId: "sess_typed_empty_patch", role: "coder", task: "implement a required change", roleContract: coderContract });
    const result = await service.runSubagent({ subagentId: sub.id, context: { executionMode: "tool-rpc", model: { provider: "test", id: "fixture" }, thinkingLevel: "high" } });
    assert.equal(observedMode, "tool-rpc", "isolated-worktree roles use the single canonical sidecar execution mode");
    assert.equal(result.status, "failed", "a role-v2 coder cannot report success when the captured workspace has no proposed patch");
    assert.equal(result.termination.code, "empty_patch");
    assert.equal(result.diagnostics.modelCalls, 7, "post-run empty-patch rejection preserves authoritative child model-call accounting");
    assert.equal(result.diagnostics.toolCalls, 35, "post-run empty-patch rejection preserves authoritative child tool-call accounting");
    assert.equal(result.diagnostics.toolFailures, 2);
    assert.equal(result.diagnostics.selectedModel, "test/coder");
    assert.equal(result.diagnostics.effectiveModel, "test/coder");
    assert.equal(result.diagnostics.selectedThinkingLevel, "xhigh");
    assert.equal(result.diagnostics.effectiveThinkingLevel, "xhigh");
    assert.equal(result.diagnostics.rpcSessionDir, "fixture-session");
    assert.equal(result.diagnostics.workspace.changedPaths.length, 0);
    assert.equal(result.diagnostics.workspace.retained, false, "an empty failed proposal leaves no retained workspace");
  }

  {
    const cwd = repo();
    fs.writeFileSync(path.join(cwd, "tracked.txt"), "parent already implemented the requested change\n");
    const before = repositoryFingerprint(cwd);
    const coderContract = DEFAULT_ROLE_CONTRACTS.find((role) => role.roleId === "coder");
    const runner = new SubagentRunner({ execute: async ({ record }) => {
      const submitted = createRoleResultEnvelope({ contract: coderContract, subagentId: record.id, submission: {
        summary: "Inherited parent changes already implement the requested behavior and are ready for independent verification.",
        findings: [],
        evidence: [{ kind: "command", summary: "The focused regression passed against the inherited baseline." }],
        artifacts: [],
        proposedPatch: { disposition: "baseline-satisfied", changedPaths: ["tracked.txt"], reason: "The inherited tracked change already implements the complete delegated assignment." },
        verification: { status: "failed", evidence: ["Focused regression passed; broader verification remains for the verifier."] },
      } });
      return { summary: submitted.summary, final_response: submitted.summary, submitted_result: submitted, termination: submitted.termination };
    } });
    const service = new SubagentService({ cwd, runner });
    const sub = service.createSubagent({ parentSessionId: "sess_baseline_satisfied", role: "coder", task: "implement the inherited tracked change", roleContract: coderContract });
    const result = await service.runSubagent({ subagentId: sub.id, context: { executionMode: "tool-rpc", model: { provider: "test", id: "fixture" }, thinkingLevel: "high" } });
    assert.equal(result.status, "succeeded", "an explicit inherited-baseline disposition advances to independent verification");
    assert.equal(result.proposedPatch, null, "baseline satisfaction never fabricates a child patch");
    assert.deepEqual(result.workspaceDisposition, { status: "baseline-satisfied", reason: "The inherited tracked change already implements the complete delegated assignment.", changedPaths: ["tracked.txt"] });
    assert.equal(result.diagnostics.workspace.disposition, "baseline-satisfied");
    assert.deepEqual(result.diagnostics.workspace.baselineChangedPaths, ["tracked.txt"]);
    assert.equal(result.diagnostics.workspace.retained, false, "an authorized clean child workspace is removed after result persistence");
    assert.deepEqual(repositoryFingerprint(cwd), before, "baseline satisfaction preserves every parent byte and status entry");
  }

  {
    const cwd = repo();
    const coderContract = DEFAULT_ROLE_CONTRACTS.find((role) => role.roleId === "coder");
    const runner = new SubagentRunner({ execute: async ({ record }) => {
      const submitted = createRoleResultEnvelope({ contract: coderContract, subagentId: record.id, submission: {
        summary: "The child incorrectly claims that a clean inherited path already satisfies the requested implementation.",
        findings: [],
        evidence: [{ kind: "runtime", summary: "No inherited dirty path exists for this claim." }],
        artifacts: [],
        proposedPatch: { disposition: "baseline-satisfied", changedPaths: ["tracked.txt"], reason: "This claim names a path that was not dirty in the inherited parent baseline." },
        verification: { status: "passed", evidence: ["Synthetic verification claim"] },
      } });
      return { summary: submitted.summary, final_response: submitted.summary, submitted_result: submitted, termination: submitted.termination };
    } });
    const service = new SubagentService({ cwd, runner });
    const sub = service.createSubagent({ parentSessionId: "sess_false_baseline", role: "coder", task: "implement a required clean-tree change", roleContract: coderContract });
    const result = await service.runSubagent({ subagentId: sub.id, context: { executionMode: "tool-rpc", model: { provider: "test", id: "fixture" }, thinkingLevel: "high" } });
    assert.equal(result.status, "failed", "a fabricated inherited-baseline disposition fails closed");
    assert.equal(result.termination.code, "baseline_satisfaction_invalid");
    assert(result.diagnostics.errors.some((error) => error.code === "SUBAGENT_BASELINE_SATISFACTION_INVALID"));
  }

  console.log("subagent workspace tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
