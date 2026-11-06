"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { projectIdentity } = require("../src/project-identity");
const { projectFolderName, parseFrontmatter, sha256 } = require("../src/project-memory-schema");
const { planProject, chunk } = require("../scripts/migrate-legacy-project-memory");
const { tmpFixture } = require("./helpers/tmp-fixture");
const root = path.resolve(__dirname, "..");

function entriesOf(text) {
  const { body } = parseFrontmatter(text);
  const entries = [];
  const marker = /<!-- pi-memory-entry:(\{[^\n]+\}) -->\n## ([^\n]+)\n\n/g;
  const matches = [...body.matchAll(marker)];
  for (let index = 0; index < matches.length; index++) {
    const start = matches[index].index + matches[index][0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : body.length;
    entries.push({ meta: JSON.parse(matches[index][1]), title: matches[index][2].trim(), content: body.slice(start, end).trim() });
  }
  return entries;
}

function revisionOf(file) { return sha256(fs.readFileSync(file)); }

const tmp = tmpFixture("legacy-memory-migration-");
try {
  const repo = path.join(tmp, "demo-repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  const vault = path.join(tmp, "vault");
  const legacy = path.join(vault, "Memory", "demo-repo");
  fs.mkdirSync(legacy, { recursive: true });
  const legacyFile = path.join(legacy, "Legacy.md");
  const legacyText = [
    "---",
    'title: "Demo legacy memory"',
    'created: "2026-07-01T00:00:00.000Z"',
    'updated: "2026-07-02T00:00:00.000Z"',
    'source: "pi"',
    'tags: ["pi", "demo-repo"]',
    "---",
    "# Demo legacy memory",
    "",
    "## Architecture guardrails",
    "- Do not couple game and engine modules.",
    "- Branch remembered by Hermes: `oldbranch`.",
    "",
    "## Fix and prevention",
    "Canonical fix: commit `abc1234` in `/home/tester/demo-repo/src/a.js`. Verified with head-on captures.",
    "",
    "## Evidence",
    "- Proof `proof_deadbeef12345678`.",
    "",
    "## Repository state",
    "- `main` at `deadbeef12345678`.",
    "- Durable fact: bump generated-resource cache versions when bake semantics change.",
    "",
    "## Unsafe",
    "api_key = sk-live-abcdefghijklmnopqrstuvwxyz",
    "",
  ].join("\n");
  fs.writeFileSync(legacyFile, legacyText, { mode: 0o600 });
  const legacyHash = sha256(fs.readFileSync(legacyFile));
  const managedNote = path.join(legacy, "Managed.md");
  fs.writeFileSync(managedNote, "---\nmemory_schema: 1\nproject_key: \"pi:demo-repo:deadbeef\"\nmemory_kind: \"decision\"\n---\n# Decisions\n", { mode: 0o600 });

  const args = [`--vault=${vault}`, `--project=demo-repo=${repo}`];
  const dry = execFileSync(process.execPath, [path.join(root, "scripts", "migrate-legacy-project-memory.js"), ...args], { encoding: "utf8", timeout: 30000 });
  assert.match(dry, /dry-run/);
  assert.equal(fs.existsSync(path.join(vault, "Memory", "Projects")), false, "dry run must not create managed notes");
  assert.equal(fs.existsSync(path.join(repo, ".pi", "project-memory", "legacy-migration-report.json")), false, "dry run writes no report");

  const applied = execFileSync(process.execPath, [path.join(root, "scripts", "migrate-legacy-project-memory.js"), ...args, "--apply"], { encoding: "utf8", timeout: 30000 });
  assert.match(applied, /applied/);
  const identity = projectIdentity(repo);
  const managedDir = path.join(vault, "Memory", "Projects", projectFolderName(identity));
  assert.equal(fs.existsSync(managedDir), true);
  const constraintsFile = path.join(managedDir, "Constraints.md");
  const proceduresFile = path.join(managedDir, "Procedures.md");
  const verificationFile = path.join(managedDir, "Verification.md");
  const historyFile = path.join(managedDir, "History", "History.md");
  const constraints = parseFrontmatter(fs.readFileSync(constraintsFile, "utf8"));
  const procedures = parseFrontmatter(fs.readFileSync(proceduresFile, "utf8"));
  const verification = parseFrontmatter(fs.readFileSync(verificationFile, "utf8"));
  const history = parseFrontmatter(fs.readFileSync(historyFile, "utf8"));
  assert.equal(constraints.fields.project_key, identity.projectKey);
  assert.match(constraints.body, /Do not couple game and engine modules/);
  assert.doesNotMatch(constraints.body, /oldbranch/, "volatile branch state is not durable memory");
  assert.match(procedures.body, /abc1234/);
  assert.doesNotMatch(procedures.body, /\/home\//, "absolute local paths are not stored");
  assert.doesNotMatch(procedures.body, /\bcommit\b/i, "commit phrasing is converted to a change reference");
  assert.match(procedures.body, /front-facing/, "head-on phrasing is rewritten before the transient filter");
  assert.match(verification.body, /proof_deadbeef12345678/);
  assert.match(history.body, /Durable fact: bump generated-resource cache versions/);
  const historyEntry = entriesOf(fs.readFileSync(historyFile, "utf8")).find((entry) => /Repository state/.test(entry.title));
  assert.ok(historyEntry);
  assert.doesNotMatch(historyEntry.content, /main\b.*\bat\b.*deadbeef/i, "volatile main-at-sha state is dropped");
  assert.doesNotMatch(historyEntry.content, /deadbeef12345678/, "dropped git state does not leak into durable prose");
  assert.ok(historyEntry.meta.evidenceIds.includes("ref-deadbeef12345678"), "git references remain as structured evidence");
  assert.equal(sha256(fs.readFileSync(legacyFile)), legacyHash, "legacy notes are never modified");
  assert.equal(fs.existsSync(path.join(managedDir, "Decisions.md")), false, "already-managed notes are skipped");

  const reportFile = path.join(repo, ".pi", "project-memory", "legacy-migration-report.json");
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.equal(report.apply, true);
  assert.equal(report.projects[0].projectKey, identity.projectKey);
  assert.equal(report.projects[0].totals.saved, 4);
  assert.equal(report.projects[0].totals.skipped, 1, "secret-bearing section is rejected");
  assert.equal(report.projects[0].totals.droppedTransient, 2);
  assert.equal(fs.statSync(reportFile).mode & 0o777, 0o600);

  const beforeRerun = {
    constraints: revisionOf(constraintsFile),
    procedures: revisionOf(proceduresFile),
    verification: revisionOf(verificationFile),
    history: revisionOf(historyFile),
  };
  const rerun = planProject({ vault, project: { name: "demo-repo", path: repo }, apply: true, now: new Date() });
  assert.equal(rerun.totals.saved, 0);
  assert.equal(rerun.totals.deduped, 4);
  assert.equal(rerun.totals.superseded, 0);
  assert.deepEqual({
    constraints: revisionOf(constraintsFile),
    procedures: revisionOf(proceduresFile),
    verification: revisionOf(verificationFile),
    history: revisionOf(historyFile),
  }, beforeRerun, "rerun dedupes without rewriting notes");
  assert.equal(sha256(fs.readFileSync(legacyFile)), legacyHash, "rerun leaves legacy notes intact");

  // A corrected legacy note must refresh the migration-owned entry, not queue a
  // title conflict or silently leave stale canonical content.
  const refreshedText = legacyText.replace(
    "Verified with head-on captures.",
    "Verified with head-on captures. Additional durable fact: keep the BRDF cache version aligned.",
  );
  fs.writeFileSync(legacyFile, refreshedText, { mode: 0o600 });
  const refreshed = planProject({ vault, project: { name: "demo-repo", path: repo }, apply: true, now: new Date() });
  assert.equal(refreshed.totals.saved, 0);
  assert.equal(refreshed.totals.deduped, 3);
  assert.equal(refreshed.totals.superseded, 1);
  assert.equal(revisionOf(constraintsFile), beforeRerun.constraints, "unaffected notes are not rewritten");
  assert.equal(revisionOf(verificationFile), beforeRerun.verification, "unaffected notes are not rewritten");
  assert.equal(revisionOf(historyFile), beforeRerun.history, "unaffected notes are not rewritten");
  assert.match(parseFrontmatter(fs.readFileSync(proceduresFile, "utf8")).body, /Additional durable fact: keep the BRDF cache version aligned/);
  const procedureEntry = entriesOf(fs.readFileSync(proceduresFile, "utf8")).find((entry) => /Fix and prevention/.test(entry.title));
  assert.equal(procedureEntry.meta.supersedes.length, 1, "refresh records the superseded migration entry");

  const afterRefresh = revisionOf(proceduresFile);
  const rerunAfterRefresh = planProject({ vault, project: { name: "demo-repo", path: repo }, apply: true, now: new Date() });
  assert.equal(rerunAfterRefresh.totals.deduped, 4);
  assert.equal(rerunAfterRefresh.totals.superseded, 0);
  assert.equal(revisionOf(proceduresFile), afterRefresh, "refreshed note is idempotent");

  assert.throws(
    () => planProject({ vault, project: { name: "wrong-name", path: repo }, apply: false, now: new Date() }),
    /does not match/,
  );

  const emptyRepo = path.join(tmp, "empty-repo");
  fs.mkdirSync(emptyRepo);
  execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "ignore" });
  const noLegacy = planProject({ vault, project: { name: "empty-repo", path: emptyRepo }, apply: false, now: new Date() });
  assert.equal(noLegacy.status, "no-legacy-layout");
  assert.equal(noLegacy.totals.notes, 0);

  const chunkLegacy = path.join(vault, "Memory", "empty-repo");
  fs.mkdirSync(chunkLegacy, { recursive: true });
  fs.writeFileSync(path.join(chunkLegacy, "Chunk.md"), [
    "---",
    'title: "Chunk note"',
    "---",
    "# Chunk note",
    "",
    "## Long history",
    "- Branch remembered: `oldbranch`.",
    "Durable detail. ".repeat(400),
    "",
  ].join("\n"), { mode: 0o600 });
  const chunked = planProject({ vault, project: { name: "empty-repo", path: emptyRepo }, apply: false, now: new Date() });
  assert.equal(chunked.totals.planned, 2, "long sections are chunked");
  assert.equal(chunked.totals.droppedTransient, 1, "dropped lines are counted once per section, not per chunk");
  assert.equal(chunked.totals.saved, 0, "dry run reports plans without saving");
  assert.deepEqual(chunked.notes[0].entries.map((entry) => entry.droppedTransient), [1, 0]);

  // A same-title collision with an operator-authored entry must persist a
  // review record, not overwrite the canonical entry or silently drop it.
  const conflictRepo = path.join(tmp, "conflict-repo");
  fs.mkdirSync(conflictRepo);
  execFileSync("git", ["init"], { cwd: conflictRepo, stdio: "ignore" });
  const conflictLegacy = path.join(vault, "Memory", "conflict-repo");
  fs.mkdirSync(conflictLegacy, { recursive: true });
  fs.writeFileSync(path.join(conflictLegacy, "Legacy.md"), [
    "---",
    'title: "Conflict legacy"',
    "---",
    "# Conflict legacy",
    "",
    "## Evidence",
    "Durable evidence fact from the legacy note.",
    "",
  ].join("\n"), { mode: 0o600 });
  const { ProjectMemoryStore } = require("../src/project-memory-store");
  const conflictStore = new ProjectMemoryStore({ cwd: conflictRepo, vault, writeEnabled: true });
  const operatorSave = conflictStore.upsert({ kind: "verification", title: "Conflict legacy — Evidence", content: "Operator-authored replacement.", verification: "unverified", sourceFingerprints: ["operator-note"] }, { explicit: true, apply: true });
  assert.ok(["saved", "saved-labeled"].includes(operatorSave.outcome));
  const conflict = planProject({ vault, project: { name: "conflict-repo", path: conflictRepo }, apply: true, now: new Date() });
  assert.equal(conflict.totals.reviewQueued, 1);
  assert.equal(conflict.totals.saved, 0);
  const conflictVerification = path.join(vault, "Memory", "Projects", projectFolderName(projectIdentity(conflictRepo)), "Verification.md");
  assert.match(fs.readFileSync(conflictVerification, "utf8"), /Operator-authored replacement/, "canonical operator entry is not overwritten");
  const conflictLedger = path.join(vault, "Memory", "Projects", projectFolderName(projectIdentity(conflictRepo)), "Reviews", "Conflict Ledger.md");
  assert.equal(fs.existsSync(conflictLedger), true, "same-title collision is recorded in the review queue");
  assert.match(fs.readFileSync(conflictLedger, "utf8"), /Conflict legacy — Evidence|titleHash/);

  const chunks = chunk("word ".repeat(2000));
  assert.equal(chunks.length, 3);
  for (const part of chunks) assert.ok(part.length <= 4000);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("legacy project memory migration tests passed");
