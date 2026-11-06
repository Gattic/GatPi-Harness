"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ProjectMemoryStore } = require("../src/project-memory-store");
const { ProjectMemoryRecall } = require("../src/project-memory-recall");
const { ProjectMemoryIndex } = require("../src/project-memory-index");
const { ProjectMemoryAdapter } = require("../src/integration-boundary");
const { resolveProjectMemoryRollout } = require("../src/project-memory-rollout");
const { sha256, parseFrontmatter } = require("../src/project-memory-schema");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("project-memory-");
const cwd = path.join(tmp, "repo"); const vault = path.join(tmp, "vault");
fs.mkdirSync(cwd); fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
let now = Date.parse("2026-07-27T00:00:00Z"); const clock = () => new Date(now);
const store = new ProjectMemoryStore({ cwd, vault, writeEnabled: true, clock });
const lockDir = path.join(store.decisions.dir, "locks"); fs.mkdirSync(lockDir, { recursive: true }); const staleLock = path.join(lockDir, `${sha256(store.identity.projectKey).slice(0, 24)}.lock`); fs.writeFileSync(staleLock, JSON.stringify({ pid: 99999999, at: "2020-01-01T00:00:00Z" }), { mode: 0o600 });

const saved = store.upsert({ kind: "decision", title: "Canonical project memory", content: "Obsidian project notes are authoritative; Hermes curates off path.", verification: "verified", sourceFingerprints: ["source-v1"], evidenceIds: ["proof-1"] }, { apply: true, explicit: true });
assert.equal(saved.outcome, "saved");
assert.equal(fs.existsSync(staleLock), false, "orphaned process locks are recovered without weakening live-lock exclusion");
assert.equal(saved.applied, true);
assert.equal(fs.statSync(store.notePath("decision")).mode & 0o777, 0o600);
assert.equal(fs.statSync(path.dirname(store.notePath("decision"))).mode & 0o777, 0o700);
assert.equal(store.readKind("decision").entries.length, 1);
assert.equal(store.readKind("current").entries.length, 1, "Current.md is a generated projection");

const duplicate = store.upsert({ kind: "decision", title: "Canonical project memory", content: "Obsidian project notes are authoritative; Hermes curates off path.", verification: "verified", sourceFingerprints: ["source-v1"], evidenceIds: ["proof-1"] }, { apply: true, explicit: true });
assert.equal(duplicate.outcome, "deduped");
assert.equal(store.readKind("decision").entries.length, 1);

const conflict = store.upsert({ kind: "decision", title: "Canonical project memory", content: "A conflicting unreviewed authority claim.", verification: "inferred" }, { apply: true, explicit: true });
assert.equal(conflict.outcome, "review-queued");
assert.equal(store.readKind("decision").entries.length, 1, "conflicts never silently overwrite canonical memory");
assert.ok(fs.existsSync(path.join(store.reviewDir, "Conflict Ledger.md")));
assert.equal(fs.existsSync(path.join(vault, "Memory", "Hermes")), false, "governed review state stays inside the canonical project directory");

now += 1000;
const replacement = store.upsert({ kind: "decision", title: "Canonical project memory", content: "Obsidian remains authoritative and cache projections are rebuildable.", verification: "verified", supersedes: [saved.entry.id], sourceFingerprints: ["source-v2"], evidenceIds: ["proof-2"] }, { apply: true, explicit: true, forceSupersede: true });
assert.equal(replacement.outcome, "superseded");
assert.equal(store.readKind("decision").entries.length, 1);
assert.ok(store.readKind("decision").entries[0].supersedes.includes(saved.entry.id));

const secret = store.upsert({ kind: "history", title: "Unsafe", content: `token = ${"A".repeat(30)}`, verification: "verified" }, { apply: true, explicit: true });
assert.equal(secret.outcome, "rejected");
assert.equal(secret.reason, "sensitive");
const localPath = store.upsert({ kind: "history", title: "Path", content: "Use /home/example/private/file", verification: "verified" }, { apply: true, explicit: true });
assert.equal(localPath.reason, "local-path");
const invalidExpiry = store.upsert({ kind: "risk", title: "Bad expiry", content: "This expiry cannot be parsed.", verification: "verified", expiresAt: "not-a-date" }, { apply: true, explicit: true });
assert.equal(invalidExpiry.reason, "invalid-expiry");
const transientGit = store.upsert({ kind: "history", title: "Current branch", content: "Current Git branch is temporary-feature.", verification: "verified" }, { apply: true, explicit: true });
assert.equal(transientGit.reason, "transient");
const labeled = store.upsert({ kind: "constraint", title: "User preference", content: "Prefer concise memory summaries.", verification: "unverified" }, { apply: true, explicit: true });
assert.equal(labeled.outcome, "saved-labeled");
const contradictedAuto = store.consider({ kind: "constraint", title: "Contradicted automatic fact", content: "Never promote this automatically.", verification: "contradicted", contradicts: [replacement.entry.id] }, { automatic: true, apply: true });
assert.equal(contradictedAuto.outcome, "review-queued");

const recaller = new ProjectMemoryRecall({ cwd, store, now: () => now });
assert.equal(recaller.recall("canonical authoritative Obsidian", { cacheOnly: true }).reason, "cache-missing", "an explicit cache-only request requires a compiled projection");
const recalled = recaller.recall("canonical authoritative Obsidian", { limit: 3, taskConditioned: true });
assert.equal(fs.existsSync(recaller.cacheFile), false, "default task-conditioned recall neither requires nor creates a compiled cache");
assert.equal(recalled.items[0].kind, "decision");
assert.equal(recalled.items[0].evidence.sourceKind, "canonical-vault");
assert.equal(recalled.git.sourceKind, "current-git");
const compiler = new ProjectMemoryRecall({ cwd, store, now: () => now });
const cache = compiler.compile({ apply: true });
assert.equal(cache.sourceKind, "compiled-cache");
assert.equal(fs.statSync(path.join(cwd, ".pi", "project-memory", "compiled-cache.json")).mode & 0o777, 0o600);
const cachedRecall = compiler.recall("canonical authoritative Obsidian", { limit: 3, cacheOnly: true });
assert.equal(cachedRecall.sourceKind, "compiled-cache");
assert.equal(cachedRecall.cacheSourceMatch, true);
assert.equal(cachedRecall.items[0].evidence.canonicalSourceHash, cachedRecall.items[0].evidence.contentHash);

const restarted = new ProjectMemoryStore({ cwd, vault, writeEnabled: true, clock });
assert.equal(restarted.readKind("decision").entries[0].content, replacement.entry.content, "canonical memory survives restart");

function assertIntegrityFailure(label, mutate, expectedIssue) {
  const fixtureCwd = path.join(tmp, `integrity-${label}-repo`); const fixtureVault = path.join(tmp, `integrity-${label}-vault`);
  fs.mkdirSync(fixtureCwd); fs.mkdirSync(path.join(fixtureVault, ".obsidian"), { recursive: true });
  const fixtureStore = new ProjectMemoryStore({ cwd: fixtureCwd, vault: fixtureVault, writeEnabled: true, clock });
  const seeded = fixtureStore.upsert({ kind: "decision", title: `Integrity ${label}`, content: "Reviewed canonical content.", verification: "verified", sourceFingerprints: ["fixture-v1"] }, { apply: true, explicit: true });
  assert.equal(seeded.outcome, "saved");
  const noteFile = fixtureStore.notePath("decision"); const tampered = mutate(fs.readFileSync(noteFile, "utf8"));
  fs.writeFileSync(noteFile, tampered, { mode: 0o600 });
  const read = fixtureStore.readKind("decision");
  assert.equal(read.integrity.ok, false);
  assert.ok(read.integrity.issues.includes(expectedIssue), `${label} mismatch is reported`);
  assert.equal(read.entries.length, 0, "invalid canonical note entries never load");
  const recalledInvalid = new ProjectMemoryRecall({ cwd: fixtureCwd, store: fixtureStore, now: () => now }).recall("reviewed canonical");
  assert.equal(recalledInvalid.reason, "canonical-integrity-failed");
  assert.equal(fixtureStore.compileCurrent({ apply: true }).reason, "integrity", "invalid canonical sources cannot regenerate Current.md");
  const before = fs.readFileSync(noteFile, "utf8");
  const blocked = fixtureStore.upsert({ kind: "decision", title: `Replacement ${label}`, content: "Do not overwrite an invalid note.", verification: "verified" }, { apply: true, explicit: true });
  assert.equal(blocked.reason, "integrity");
  assert.equal(fs.readFileSync(noteFile, "utf8"), before, "invalid canonical note is never overwritten");
}
function refreshBodyHash(text) { const parsed = parseFrontmatter(text); return text.replace(/content_hash: "sha256:[^"]+"/, `content_hash: "${sha256(parsed.body)}"`); }
assertIntegrityFailure("schema", (text) => text.replace("memory_schema: 1", "memory_schema: 2"), "schema-mismatch");
assertIntegrityFailure("identity", (text) => text.replace(/project_key: "[^"]+"/, 'project_key: "wrong-project"'), "project-key-mismatch");
assertIntegrityFailure("kind", (text) => text.replace('memory_kind: "decision"', 'memory_kind: "risk"'), "memory-kind-mismatch");
assertIntegrityFailure("body", (text) => text.replace("Reviewed canonical content.", "Tampered canonical content."), "content-hash-mismatch");
assertIntegrityFailure("marker", (text) => refreshBodyHash(text.replace("pi-memory-entry:{", "pi-memory-entry:{invalid")), "malformed-entry-marker");
assertIntegrityFailure("unsafe", (text) => refreshBodyHash(text.replace("Reviewed canonical content.", `sk-${"A".repeat(32)}`)), "entry-content-unsafe");
assertIntegrityFailure("entry", (text) => refreshBodyHash(text.replace(/"candidateHash":"[^"]+"/, '"candidateHash":"sha256:wrong"')), "entry-candidate-hash-mismatch");
const ledgerText = fs.readFileSync(path.join(cwd, ".pi", "project-memory", "decisions.jsonl"), "utf8");
assert.doesNotMatch(ledgerText, /Obsidian remains authoritative|conflicting unreviewed|\/home\/example/, "decision ledger stores metadata only");

const adapter = new ProjectMemoryAdapter({ enabled: true, cwd, vault, writeEnabled: true, clock });
assert.equal(adapter.status().projectKey, store.identity.projectKey);
assert.ok(adapter.recall("authoritative", { limit: 1 }).items.length);
const successfulBeforeDuplicate = adapter.status().decisionState.lastSuccessful.decisionId;
const adapterDuplicate = adapter.save({ kind: "decision", title: "Canonical project memory", content: "Obsidian remains authoritative and cache projections are rebuildable.", verification: "verified", supersedes: [saved.entry.id], sourceFingerprints: ["source-v2"], evidenceIds: ["proof-2"] }, { apply: true, explicit: true });
assert.equal(adapterDuplicate.outcome, "deduped");
assert.equal(adapter.status().decisionState.lastAttempt.action, "deduped");
assert.equal(adapter.status().decisionState.lastSuccessful.decisionId, successfulBeforeDuplicate, "an idempotent no-op does not replace the latest successful canonical save");
assert.equal(adapter.recall("canonical project memory", { cacheOnly: true }).cacheSourceMatch, true, "idempotent duplicate saves keep the compiled cache valid");
const unsafeCwd = path.join(tmp, "unsafe-cache-repo"); const unsafeCacheVault = path.join(tmp, "unsafe-cache-vault"); fs.mkdirSync(unsafeCwd); fs.mkdirSync(path.join(unsafeCacheVault, ".obsidian"), { recursive: true }); const unsafeCacheStore = new ProjectMemoryStore({ cwd: unsafeCwd, vault: unsafeCacheVault, writeEnabled: true, clock }); unsafeCacheStore.upsert({ kind: "decision", title: "Safe before edit", content: "Reviewed safe content.", verification: "verified" }, { apply: true, explicit: true }); fs.appendFileSync(unsafeCacheStore.notePath("decision"), `\nsk-${"A".repeat(32)}\n`); const unsafeCompiler = new ProjectMemoryRecall({ cwd: unsafeCwd, store: unsafeCacheStore, now: () => now }); assert.equal(unsafeCompiler.compile({ apply: true }).reason, "canonical-integrity-failed", "manually altered canonical content cannot enter a compiled cache");

const sameNameA = path.join(tmp, "roots", "a", "repo"); const sameNameB = path.join(tmp, "roots", "b", "repo"); fs.mkdirSync(sameNameA, { recursive: true }); fs.mkdirSync(sameNameB, { recursive: true });
const isolatedA = new ProjectMemoryStore({ cwd: sameNameA, vault, writeEnabled: false }); const isolatedB = new ProjectMemoryStore({ cwd: sameNameB, vault, writeEnabled: false });
assert.notEqual(isolatedA.identity.projectKey, isolatedB.identity.projectKey);
assert.notEqual(isolatedA.projectDir, isolatedB.projectDir, "same-basename roots remain isolated by canonical root hash");
const lazyVault = path.join(tmp, "lazy-vault"); fs.mkdirSync(path.join(lazyVault, ".obsidian"), { recursive: true });
const lazyStore = new ProjectMemoryStore({ cwd: sameNameA, vault: lazyVault, writeEnabled: false }); fs.mkdirSync(lazyStore.projectDir, { recursive: true });
const outsideLazy = path.join(tmp, "outside-lazy.md"); fs.writeFileSync(outsideLazy, "must not be read\n"); fs.symlinkSync(outsideLazy, lazyStore.notePath("decision"));
const lazyAdapter = new ProjectMemoryAdapter({ enabled: true, cwd: sameNameA, vault: lazyVault, writeEnabled: false });
assert.equal(lazyAdapter.recall("anything", { cacheOnly: true }).reason, "cache-missing", "an explicit missing-cache lookup does not read vault note bodies or follow note symlinks");

const outside = path.join(tmp, "outside"); fs.mkdirSync(outside);
const isolatedVault = path.join(tmp, "isolated-vault"); fs.mkdirSync(path.join(isolatedVault, ".obsidian"), { recursive: true });
const unsafeStore = new ProjectMemoryStore({ cwd, vault: isolatedVault, writeEnabled: true, clock });
fs.mkdirSync(path.join(isolatedVault, "Memory", "Projects"), { recursive: true });
fs.symlinkSync(outside, unsafeStore.projectDir, "dir");
assert.throws(() => unsafeStore.upsert({ kind: "decision", title: "Escape", content: "Must remain in vault", verification: "verified" }, { apply: true, explicit: true }), /unsafe project-memory directory/);
assert.equal(fs.readdirSync(outside).length, 0);

const entries = Array.from({ length: 10_000 }, (_, index) => ({ id: `e${index}`, kind: index === 7777 ? "decision" : "history", title: index === 7777 ? "Repeated memory audit" : `Unrelated ${index}`, content: index === 7777 ? "Prior Obsidian Hermes memory investigation" : "ordinary bounded memory", verification: index === 7777 ? "verified" : "inferred", updatedAt: new Date(now - index).toISOString(), source: { note: `n${index}.md` } }));
const index = new ProjectMemoryIndex({ entries, now: () => now });
const perf = index.search("repeated memory audit Obsidian", { limit: 5 });
assert.equal(perf.items[0].id, "e7777");
// A single sample measures the scheduler as much as the index. The bar stays at
// 50 ms; take the median of repeated runs so an unrelated build running beside
// this test cannot fail the memory-latency contract.
const samples = [perf.durationMs];
for (let run = 0; run < 4; run++) samples.push(index.search("repeated memory audit Obsidian", { limit: 5 }).durationMs);
samples.sort((a, b) => a - b);
const medianMs = samples[Math.floor(samples.length / 2)];
assert.ok(medianMs < 50, `10k-note local ranked recall must stay below the fixed 50 ms bar (median ${medianMs}ms of ${samples.join(",")})`);

const rollout = resolveProjectMemoryRollout({ PI_PROJECT_MEMORY_STAGE: "M5" }, { deterministicPassed: true, privacyPassed: true, rollbackPassed: true, reviewedGoldQualified: true, recallPrecisionAt5: 0.95, recallAt5: 0.95, localRecallP95Ms: 20, crossProjectContamination: 0, currentFactStaleRate: 0, shadowDecisionPassed: true });
assert.equal(rollout.eligibleStage, "M3");
assert.equal(rollout.effectiveStage, "M3", "rollout fails closed below requested stage when field/curation evidence is missing");
assert.equal(rollout.controls.automaticVerifiedUpserts, false);

console.log("project memory tests passed");
