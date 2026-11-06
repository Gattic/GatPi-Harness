"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tmpFixture } = require("./helpers/tmp-fixture");
const fixture = tmpFixture("pi-directory-approvals-");
const previousHome = process.env.HOME;
try {
  process.env.HOME = fixture;
  const { FileApprovalStore, enforceToolCall } = require("../src/policy-enforcement");
  const [a, b, c, unrelated, sibling] = ["ExampleGame", "ExampleUniverse", "ExamplePal", "unrelated", "ExampleUniverse-extra"]
    .map((name) => path.join(fixture, name));
  for (const dir of [a, b, c, unrelated, sibling, path.join(b, "nested"), path.join(fixture, ".ssh")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(b, "nested", "existing.txt"), "before\n");
  fs.writeFileSync(path.join(unrelated, "existing.txt"), "unrelated\n");
  const store = new FileApprovalStore({ cwd: a });
  const check = (target, options = {}) => enforceToolCall("write", { path: target }, { cwd: a, approvalStore: store, ...options });
  const child = path.join(b, "new", "deep", "file.txt");
  assert.equal(check(child).allow, false);
  store.approve({ kind: "write", path: b }, { ttlMs: 0 });
  assert.equal(check(child).allow, false, "an exact directory path request is not recursive authority");

  const grant = store.approveDirectory("~/ExampleUniverse/");
  assert.equal(grant.expiresAt, null, "directory grants are permanent by default");
  assert.deepEqual(grant.request, { kind: "directory-write", sourceRoot: fs.realpathSync(a), path: fs.realpathSync(b) });
  assert.equal(check(child).allow, true, "new descendants with nonexistent parents are approved");
  assert.equal(check(child).action, "approved");
  assert.equal(check(child, { mode: "approval" }).allow, true, "approval mode needs no repeated confirmation");
  assert.equal(check("../ExampleUniverse/new.txt").allow, true);
  assert.equal(check("@~/ExampleUniverse/new.txt").allow, true);
  assert.equal(check(path.join(b, "..valid-name")).allow, true, "dot-prefixed names are not parent traversal");
  assert.equal(check(path.join(b, "nested", "existing.txt")).allow, true);
  for (const edits of [[], [{ oldText: "before", newText: "after" }], [{}, {}]]) {
    assert.equal(enforceToolCall("edit", { path: child, edits }, { cwd: a, approvalStore: store }).allow, true,
      "both write and edit-count requests are covered");
  }
  assert.equal(new FileApprovalStore({ cwd: a }).list().find((item) => item.key === grant.key).expiresAt, null);
  assert.equal(check(child, { approvalStore: new FileApprovalStore({ cwd: a }) }).allow, true, "survives a fresh store/session");
  assert.equal(store.approveDirectory(b).key, grant.key, "repeated approval is idempotent");
  assert.equal(store.list().filter((item) => item.key === grant.key).length, 1);

  for (const target of [path.join(c, "x"), path.join(sibling, "x"), path.join(b, "..", "unrelated", "x"), fixture]) {
    assert.equal(check(target).allow, false, `no parent, sibling-prefix, or traversal approval: ${target}`);
  }
  assert.equal(enforceToolCall("write", { path: path.join(a, "x") }, { cwd: b, approvalStore: new FileApprovalStore({ cwd: b }) }).allow, false,
    "friendship is not implicitly reciprocal");
  store.approveDirectory(c);
  assert.equal(check(path.join(c, "x")).allow, true, "one source can have multiple friends");
  const bStore = new FileApprovalStore({ cwd: b });
  const cStore = new FileApprovalStore({ cwd: c });
  bStore.approveDirectory(a);
  cStore.approveDirectory(a);
  for (const [source, sourceStore, other] of [[b, bStore, c], [c, cStore, b]]) {
    assert.equal(enforceToolCall("write", { path: path.join(a, "x") }, { cwd: source, approvalStore: sourceStore }).allow, true);
    assert.equal(enforceToolCall("write", { path: path.join(other, "x") }, { cwd: source, approvalStore: sourceStore }).allow, false,
      "the two friends do not acquire authority over each other");
  }
  const copiedStore = new FileApprovalStore({ cwd: unrelated });
  copiedStore.save(store.packet());
  assert.equal(enforceToolCall("write", { path: child }, { cwd: unrelated, approvalStore: copiedStore }).allow, false,
    "copying approval state to another project does not transfer directory authority");

  fs.symlinkSync(unrelated, path.join(b, "escape"));
  fs.symlinkSync(path.join(unrelated, "existing.txt"), path.join(b, "file-link"));
  fs.symlinkSync(path.join(unrelated, "missing"), path.join(b, "dangling"));
  fs.symlinkSync("loop", path.join(b, "loop"));
  for (const target of ["escape/existing.txt", "escape/new/deep.txt", "file-link", "dangling/new.txt", "loop/new.txt", "nested/existing.txt/child"]) {
    assert.equal(check(path.join(b, target)).allow, false, `unsafe/unresolvable path fails closed: ${target}`);
  }
  fs.symlinkSync(path.join(b, "nested"), path.join(b, "internal"));
  assert.equal(check(path.join(b, "internal", "new.txt")).allow, true, "links staying inside the approved directory are allowed");
  const alias = path.join(fixture, "robot-alias");
  fs.symlinkSync(b, alias);
  assert.equal(store.approveDirectory(alias).key, grant.key, "grants pin the canonical destination, not a symlink spelling");
  assert.equal(check(path.join(alias, "new.txt")).allow, true);
  fs.unlinkSync(alias);
  fs.symlinkSync(unrelated, alias);
  assert.equal(check(path.join(alias, "new.txt")).allow, false, "retargeted aliases do not carry authority");

  const protectedDir = path.join(b, "private");
  fs.mkdirSync(protectedDir);
  const policy = { denyPathPrefixes: [protectedDir] };
  assert.equal(check(path.join(protectedDir, "new.txt"), { policy }).allow, false, "lexical deny prefixes still win");
  assert.equal(check(path.join(protectedDir, "..secret"), { policy }).allow, false, "protected dot-prefixed files remain protected");
  fs.symlinkSync(protectedDir, path.join(b, "private-alias"));
  assert.equal(check(path.join(b, "private-alias", "new.txt"), { policy }).allow, false, "canonical deny prefixes still win");
  assert.throws(() => store.approveDirectory(protectedDir, { policy }), /denied path prefix/);
  assert.throws(() => store.approveDirectory(path.join(b, "private-alias"), { policy }), /denied path prefix/);
  store.approveDirectory(fixture);
  assert.equal(check(path.join(fixture, ".ssh", "..secret")).allow, false, "default protected paths survive a parent grant");
  assert.throws(() => store.approveDirectory("~/.ssh"), /denied path prefix/);
  const homeGrant = store.list().find((item) => item.request?.kind === "directory-write" && item.request.path === fixture);
  store.revoke(homeGrant.key);

  assert.equal(enforceToolCall("bash", { command: `rm -rf ${b}`, path: b }, { cwd: a, approvalStore: store }).allow, false,
    "directory grants do not approve dangerous commands");
  assert.equal(enforceToolCall("bash", { command: `npm install --prefix ${b}`, path: b }, { cwd: a, approvalStore: store, mode: "approval" }).allow, false,
    "directory grants do not waive install warnings");
  assert.equal(enforceToolCall("future_write_tool", { path: child }, { cwd: a, approvalStore: store, mode: "approval", approveWarnings: true }).allow, false,
    "a granted path does not approve a separate tool warning");

  const moved = `${b}-moved`;
  fs.renameSync(b, moved);
  assert.equal(check(path.join(c, "x")).allow, true, "a missing grant root does not disable other valid grants");
  fs.symlinkSync(unrelated, b);
  assert.equal(check(path.join(b, "new.txt")).allow, false, "replacing the canonical grant root with a link cannot redirect authority");
  fs.unlinkSync(b);
  fs.renameSync(moved, b);
  assert.equal(check(child).allow, true);

  assert.equal(store.revoke(grant.key).revoked, 1);
  assert.equal(check(child).allow, false, "revocation is effective without restarting");
  store.approveDirectory(b, { ttlMs: -1 });
  assert.equal(check(child).allow, false, "expired directory grants cannot authorize writes");
  assert.equal(store.list({ includeExpired: true }).some((item) => item.key === grant.key), true);
  store.prune();
  assert.equal(store.list({ includeExpired: true }).some((item) => item.key === grant.key), false);
  assert.throws(() => store.approveDirectory(""), /Directory path is required/);
  assert.throws(() => store.approveDirectory(path.join(b, "missing")), /ENOENT/);
  assert.throws(() => store.approveDirectory(path.join(b, "nested", "existing.txt")), /Not a directory/);
  assert.throws(() => store.approve(grant.request), /Use \/policy-approve-directory/, "ordinary model grants cannot create directory authority");
} finally {
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log("policy-directory-approvals tests passed");
