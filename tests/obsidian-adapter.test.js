#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  createObsidianAdapter,
  obsidianDoctor,
  normalizeVaultRelative,
  normalizeSourcePath,
  parseCliArgs,
} = require("../src/obsidian-adapter.js");
const { HermesAdvisoryAdapter } = require("../src/integration-boundary.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-obsidian-test-");
const cwd = path.join(tmp, "repo");
const vault = path.join(tmp, "vault");
fs.mkdirSync(path.join(cwd, "research"), { recursive: true });
fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
fs.writeFileSync(path.join(cwd, "research", "CHIRON_PROGRESS.md"), "# CHIRON Progress\n\nFACE and MFIO validated.\n");
fs.writeFileSync(path.join(cwd, "docs", "architecture.md"), "# Architecture\n\nCHIRON reversible blocks.\n");
fs.writeFileSync(path.join(cwd, "research", "prototype.cpp"), "int main() { return 0; }\n");

const fakeObsidian = path.join(tmp, "fake-obsidian.js");
fs.writeFileSync(fakeObsidian, "#!/usr/bin/env node\nconsole.log('fake obsidian');\n");
fs.chmodSync(fakeObsidian, 0o755);
const fakeHermes = path.join(tmp, "fake-hermes.js");
const hermesCalls = path.join(tmp, "hermes-calls.jsonl");
fs.writeFileSync(fakeHermes, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(hermesCalls)}, JSON.stringify(args) + '\\n');
const prompt = String(args[1] || '');
if (args.includes('--version')) console.log('fake-hermes 1.0.0');
else if (prompt.includes('HERMES_ADVISORY_AUTH_OK')) console.log('HERMES_ADVISORY_AUTH_OK');
else if (prompt.includes('HERMES_ADVISORY_CURATION_OK')) console.log('HERMES_ADVISORY_CURATION_OK');
else {
  const hash = prompt.match(/"contentHash":"(sha256:[a-f0-9]+)"/)?.[1];
  console.log(JSON.stringify({ schemaVersion: 1, candidates: [{ kind: 'decision', title: 'CHIRON validation', content: 'CHIRON notes report FACE and MFIO validation.', sourceHashes: [hash], evidenceIds: [], confidence: 0.8, expiresAt: null, conflicts: [] }] }));
}
`);
fs.chmodSync(fakeHermes, 0o755);

assert.equal(normalizeVaultRelative("Research/foo.md"), "Research/foo.md");
assert.throws(() => normalizeVaultRelative("../secret.md"), /inside the vault/);
assert.equal(normalizeSourcePath({ cwd }, "research/CHIRON_PROGRESS.md", { allowOutsideCwd: false }), path.join(cwd, "research", "CHIRON_PROGRESS.md"));
assert.equal(parseCliArgs("--apply --include-code --max-files 5 research docs").opts.dryRun, false);
assert.equal(parseCliArgs("--apply --include-code --max-files 5 research docs").opts.includeCode, true);

const missing = obsidianDoctor(cwd, { bin: path.join(tmp, "missing-obsidian"), vault, hermesBin: fakeHermes });
assert.equal(missing.binary.found, false);
assert.ok(missing.risks.some((risk) => /not installed|not on PATH/.test(risk)));

const queuedCandidates = [];
const adapter = createObsidianAdapter({ bin: fakeObsidian, hermesBin: fakeHermes, vault, allowOutsideCwd: true, maxFiles: 20, hermesAdapter: new HermesAdvisoryAdapter({ cwd, bin: fakeHermes }), projectMemoryFactory: async () => ({ rollout: { controls: { hermesCuration: true } }, adapter: { consider: (candidate, options) => { queuedCandidates.push({ candidate, options }); return { applied: true, queued: true }; } } }) });
const ctx = { cwd };

(async () => {
  const status = await adapter.status(ctx, {});
  assert.match(status.content[0].text, /Obsidian adapter status/);
  assert.equal(status.details.binary.found, true);
  assert.match(status.details.selection.selectionId, /^vaultsel_/);

  const note = await adapter.note(ctx, { title: "Research inbox", body: "Remember FACE validation.", tags: ["research"] });
  assert.equal(note.details.relativePath, path.join("Inbox", "Research-inbox.md"));
  assert.equal(note.details.selection.selectionId, status.details.selection.selectionId);
  assert.ok(fs.existsSync(note.details.filePath));
  const unsafeFrontmatterToken = ["sk", "-", "F".repeat(24)].join("");
  await assert.rejects(() => adapter.note(ctx, { title: "Unsafe metadata", body: "Safe body.", frontmatterFields: { external_token: unsafeFrontmatterToken } }), (error) => error.code === "MEMORY_CONTENT_UNSAFE", "the shared scanner covers the complete durable note payload, including frontmatter");
  assert.equal(fs.existsSync(path.join(vault, "Inbox", "Unsafe-metadata.md")), false);
  assert.ok(fs.existsSync(path.join(vault, ".obsidian")));
  const outsideVault = path.join(tmp, "outside-vault");
  fs.mkdirSync(outsideVault);
  fs.symlinkSync(outsideVault, path.join(vault, "linked"), "dir");
  await assert.rejects(() => adapter.note(ctx, { title: "Escaped", file: "linked/escaped.md", body: "MUST_NOT_ESCAPE", mode: "overwrite" }), /symbolic links/);
  assert.equal(fs.existsSync(path.join(outsideVault, "escaped.md")), false, "note writes cannot follow a vault symlink");
  await assert.rejects(() => adapter.importResearch(ctx, { project: "escape", folder: "linked", dryRun: false }), /symbolic links/);
  assert.equal(fs.readdirSync(outsideVault).length, 0, "research import cannot follow a vault symlink");
  const outsideFile = path.join(tmp, "outside-note.md");
  fs.writeFileSync(outsideFile, "UNCHANGED\n");
  fs.symlinkSync(outsideFile, path.join(vault, "linked-note.md"), "file");
  await assert.rejects(() => adapter.note(ctx, { title: "Escaped file", file: "linked-note.md", body: "MUST_NOT_ESCAPE", mode: "overwrite" }), /symbolic links/);
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "UNCHANGED\n", "note writes cannot follow a final-file symlink");

  const dry = await adapter.importResearch(ctx, { project: "glades-ml", dryRun: true });
  assert.equal(dry.details.dryRun, true);
  assert.equal(dry.details.selection.selectionId, status.details.selection.selectionId);
  assert.equal(dry.details.imported.length, 2);
  assert.ok(!fs.existsSync(path.join(vault, "Research", "glades-ml", "index.md")));

  const applied = await adapter.importResearch(ctx, { project: "glades-ml", dryRun: false, includeCode: true });
  assert.equal(applied.details.dryRun, false);
  assert.equal(applied.details.imported.length, 3);
  assert.ok(fs.existsSync(path.join(vault, "Research", "glades-ml", "index.md")));

  const search = await adapter.search(ctx, { query: "CHIRON FACE" });
  assert.equal(search.details.selection.selectionId, status.details.selection.selectionId);
  assert.ok(search.details.matches.some((match) => /CHIRON_PROGRESS/.test(match.file)));
  const rankingDir = path.join(vault, "Ranking"); fs.mkdirSync(rankingDir, { recursive: true });
  fs.writeFileSync(path.join(rankingDir, "z-exact.md"), "# Canonical durable authority\n\nExact project memory fixture.\n");
  fs.writeFileSync(path.join(rankingDir, "a-partial.md"), "# Canonical note\n\nDurable details appear separately from authority.\n");
  fs.writeFileSync(path.join(rankingDir, "a-tie.md"), "# Tie note\n\nranking-tie-token\n");
  fs.writeFileSync(path.join(rankingDir, "b-tie.md"), "# Tie note\n\nranking-tie-token\n");
  fs.writeFileSync(path.join(rankingDir, "snippet-priority.md"), "# Snippet fixture\n\ncanonical appears first\n\ncanonical durable authority appears together later\n");
  const ranked = await adapter.search(ctx, { query: "canonical durable authority", limit: 10 });
  assert.equal(ranked.details.rankingVersion, 1);
  assert.equal(ranked.details.matches[0].file, "Ranking/z-exact.md", "exact phrase and title relevance outrank alphabetical file order");
  assert.equal(ranked.details.matches[0].exactPhrase, true);
  assert.deepEqual(ranked.details.matches[0].matchedTerms, ["canonical", "durable", "authority"]);
  assert(ranked.details.matches[0].score > ranked.details.matches[1].score);
  const snippetPriority = ranked.details.matches.find((match) => match.file === "Ranking/snippet-priority.md");
  assert.match(snippetPriority.snippets[0].text, /canonical durable authority/, "all-term snippets rank before earlier partial-term lines");
  const tiedA = await adapter.search(ctx, { query: "ranking tie token", limit: 10 });
  const tiedB = await adapter.search(ctx, { query: "ranking tie token", limit: 10 });
  assert.deepEqual(tiedA.details.matches.map((match) => [match.file, match.score, match.rank]), tiedB.details.matches.map((match) => [match.file, match.score, match.rank]), "rank order and scores are deterministic");
  assert.deepEqual(tiedA.details.matches.slice(0, 2).map((match) => match.file), ["Ranking/a-tie.md", "Ranking/b-tie.md"], "lexical file order breaks exact score ties deterministically");

  await assert.rejects(() => adapter.hermes(ctx, { topic: "CHIRON", dryRun: false }), (error) => error.code === "OBSIDIAN_HERMES_USER_AUTHORIZATION_REQUIRED");
  const proof = await adapter.doctor(ctx, { probeCuration: true, timeoutMs: 2000 });
  assert.equal(proof.details.hermesEvidence.curationReady, true);
  fs.writeFileSync(path.join(vault, "Ranking", "unsafe.md"), `# Unsafe CHIRON\n\nsecret=${"sk-" + "Z".repeat(24)}\n`);
  const hermesDry = await adapter.hermes(ctx, { topic: "CHIRON", dryRun: true });
  assert.equal(hermesDry.details.dryRun, true);
  assert.ok(hermesDry.details.digest.filesIncluded >= 1, "scanner-approved fixture-vault extracts participate in curation");
  assert.ok(hermesDry.details.digest.sourceHashes.every((value) => /^sha256:/.test(value)));
  assert.equal(hermesDry.details.digest.unsafeSkipped >= 1, true, "unsafe source extracts are excluded before provider transmission");
  assert.equal(hermesDry.details.candidates[0].verification, "unverified");
  assert.equal(hermesDry.details.note, undefined, "dry run writes no note");
  await assert.rejects(() => adapter.hermes(ctx, { topic: "CHIRON", dryRun: false, userAuthorized: false }), (error) => error.code === "OBSIDIAN_HERMES_USER_AUTHORIZATION_REQUIRED");
  const hermes = await adapter.hermes(ctx, { topic: "CHIRON", dryRun: false, userAuthorized: true });
  assert.match(hermes.content[0].text, /submitted to the governed review queue/);
  assert.match(hermes.content[0].text, /CHIRON notes report FACE and MFIO validation/);
  assert.equal(queuedCandidates.length, 1);
  assert.equal(queuedCandidates[0].candidate.verification, "unverified");
  assert.deepEqual(queuedCandidates[0].options, { queueReview: true, apply: true, automatic: false });
  assert.throws(() => adapter.reviewHermesCuration(ctx, { receiptId: hermes.details.receipt.receiptId, decision: "accept" }), (error) => error.code === "OBSIDIAN_HERMES_REVIEW_AUTHORIZATION_REQUIRED");
  const review = await adapter.reviewHermesCuration(ctx, { receiptId: hermes.details.receipt.receiptId, decision: "accept", userAuthorized: true });
  assert.equal(review.details.receiptBound, true);
  assert.equal(review.details.canonicalPromotionApplied, false);
  const reviewEvent = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "obsidian", "state.json"), "utf8")).events.find((event) => event.operation === "hermes-review-outcome");
  assert.equal(reviewEvent.curationReceiptId, hermes.details.receipt.receiptId);
  assert.equal(fs.existsSync(path.join(vault, "Memory", "Hermes")), false, "Hermes never writes a competing canonical memory note");
  const sentPrompts = fs.readFileSync(hermesCalls, "utf8").trim().split(/\n+/).map(JSON.parse).flat().filter((arg) => arg.includes("public-curation-packet"));
  assert.equal(sentPrompts.some((prompt) => prompt.includes("sk-" + "Z".repeat(24))), false, "unsafe source bodies never reach Hermes");
  assert.equal(sentPrompts.some((prompt) => prompt.includes(vault)), false, "provider packets contain no absolute vault path");

  console.log("obsidian adapter checks passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
