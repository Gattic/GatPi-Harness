#!/usr/bin/env node
"use strict";

// Regression: an explicitly configured vault must win over any discovered
// existing vault, even when the configured vault does not exist yet.
// Previously selectedVault preferred "any existing vault" from discovery,
// so notes silently landed in the user's real vault.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { configFromEnv, createObsidianAdapter } = require("../src/obsidian-adapter.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("pi-obsidian-vault-select-");
const cwd = path.join(tmp, "repo");
fs.mkdirSync(path.join(cwd, "research"), { recursive: true });
fs.writeFileSync(path.join(cwd, "research", "NOTES.md"), "# Notes\n\nPrecedence fixture.\n");

// Decoy: make an existing vault an ancestor of cwd so discovery finds it.
fs.mkdirSync(path.join(tmp, ".obsidian"), { recursive: true });

// Configured vault does not exist yet.
const configuredVault = path.join(tmp, "managed-vault");

assert.equal(configFromEnv({ PI_OBSIDIAN_VAULT: configuredVault }).vault, configuredVault);
assert.equal(configFromEnv({ PI_OBSIDIAN_VAULT: configuredVault }, { vault: null }).vault, null, "explicit null disables environment inheritance");

const adapter = createObsidianAdapter({ vault: configuredVault, allowOutsideCwd: true });
const configuredSelection = adapter.resolveVaultSelection({ cwd });
assert.equal(configuredSelection.source, "configured");
assert.equal(configuredSelection.path, configuredVault);
assert.equal(configuredSelection.exists, false, "configured missing vault remains authoritative");
assert.equal(configuredSelection.configured, true);
assert.match(configuredSelection.selectionId, /^vaultsel_[a-f0-9]{24}$/);
assert.match(configuredSelection.pathHash, /^sha256:[a-f0-9]{64}$/);

const discoveredA = path.join(tmp, "discovered-a");
const discoveredB = path.join(tmp, "discovered-b");
fs.mkdirSync(path.join(discoveredA, ".obsidian"), { recursive: true });
fs.mkdirSync(path.join(discoveredB, ".obsidian"), { recursive: true });
const resolver = createObsidianAdapter({ vault: null, allowOutsideCwd: true, defaultVault: path.join(tmp, "default-managed") });
const single = resolver.resolveVaultSelection({ cwd }, { discoveredCandidates: [{ path: discoveredA, exists: true, isVault: true }] });
assert.equal(single.source, "discovered-single");
assert.equal(single.path, discoveredA);
assert.equal(single.ambiguous, false);
const ambiguous = resolver.resolveVaultSelection({ cwd }, { discoveredCandidates: [{ path: discoveredA, exists: true, isVault: true }, { path: discoveredB, exists: true, isVault: true }] });
assert.equal(ambiguous.source, "ambiguous");
assert.equal(ambiguous.path, null);
assert.equal(ambiguous.candidateCount, 2);
assert.equal(ambiguous.ambiguous, true);
assert(ambiguous.reasons.includes("configure-pi-obsidian-vault"));
const fallback = resolver.resolveVaultSelection({ cwd }, { discoveredCandidates: [] });
assert.equal(fallback.source, "default-managed");
assert.equal(fallback.path, path.join(tmp, "default-managed"));
const denied = createObsidianAdapter({ allowOutsideCwd: false }).resolveVaultSelection({ cwd }, { vault: path.join(tmp, "denied-vault") });
assert.equal(denied.source, "denied");
assert.equal(denied.path, null);

(async () => {
  const note = await adapter.note({ cwd }, { title: "Vault precedence", body: "must land in configured vault" });

  assert.ok(
    note.details.filePath.startsWith(configuredVault + path.sep),
    `note must be written inside the configured vault, got: ${note.details.filePath}`
  );
  assert.ok(fs.existsSync(path.join(configuredVault, ".obsidian")), "configured vault must be initialized");
  assert.ok(
    !fs.existsSync(path.join(tmp, "Inbox")),
    "decoy discovered vault must not receive the note"
  );

  await adapter.importResearch({ cwd }, { project: "precedence", dryRun: false });
  assert.ok(
    fs.existsSync(path.join(configuredVault, "Research", "precedence", "index.md")),
    "import must land in the configured vault"
  );
  assert.ok(
    !fs.existsSync(path.join(tmp, "Research")),
    "decoy discovered vault must not receive imports"
  );

  console.log("obsidian vault selection tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
