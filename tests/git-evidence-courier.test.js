#!/usr/bin/env node
"use strict";

// Source-shape checks for the git-evidence-courier extension: command/tool
// registration, inferred verifier profiles, and publish safety invariants.
// tests/extension-load.test.js already load-tests the extension through jiti,
// so this file intentionally does not duplicate that.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
function text(file) { return fs.readFileSync(path.join(root, file), "utf8"); }
function assertContains(file, needle, why) { assert.ok(text(file).includes(needle), `${file} should include ${needle}${why ? ` (${why})` : ""}`); }

try {
  const ext = "extensions/git-evidence-courier/index.ts";
  const source = text(ext);

  // Slash commands.
  for (const command of ["git:evidence", "git:verify", "git:publish"]) {
    assertContains(ext, `pi.registerCommand("${command}"`);
  }
  assert.equal((source.match(/pi\.registerCommand\(/g) || []).length, 3, "exactly three slash commands are registered");

  // Model tools.
  for (const tool of ["gitevidence", "gitverify"]) {
    assertContains(ext, `name: "${tool}"`);
  }
  assert.equal((source.match(/pi\.registerTool\(/g) || []).length, 2, "exactly two model tools are registered");
  assert.ok(!source.includes('name: "gitpublish"'), "publishing must stay behind /git:publish, never a model tool");

  // Model tools are read-only/inferred-only: empty schemas, no caller-supplied shell.
  assertContains(ext, "const EMPTY_PARAMS = Type.Object({})", "model tools take no parameters, so no arbitrary shell input");
  assert.equal((source.match(/parameters: EMPTY_PARAMS/g) || []).length, 2, "both model tools use the empty parameter schema");
  assertContains(ext, "gitevidence is read-only and never pushes");
  assertContains(ext, "gitverify never pushes and never runs arbitrary shell commands");
  assertContains(ext, 'buildVerifyReport(pi, ctx.cwd, "")', "gitverify tool always uses inferred commands, never caller-supplied ones");

  // Publish safety invariants.
  assertContains(ext, "Usage: /git:publish [--verify] [remote] [branch]");
  assertContains(ext, "Detached HEAD; cannot infer branch to publish.");
  assertContains(ext, "Working tree is not clean. Commit or stash changes first.");
  assertContains(ext, '"merge-base", "--is-ancestor"', "remote branch must be an ancestor of local HEAD before push");
  assertContains(ext, "requires interactive user confirmation before pushing");
  assertContains(ext, "if (!ctx.hasUI)", "publish refuses to push in non-interactive contexts");
  assertContains(ext, "await ctx.ui.confirm(", "publish requires explicit user confirmation");
  assertContains(ext, '["push", parsed.remote, `HEAD:${parsed.branch}`]', "push uses an argument array and publishes HEAD:<branch>");
  assert.ok(!/--force|push -f|"-f"/.test(source), "publish must never force push");

  // Post-push evidence: remote SHA vs local HEAD plus clean-tree confirmation.
  for (const needle of ["remote SHA after", "local SHA after", "status after", "SHA match"]) {
    assertContains(ext, needle);
  }

  // Inferred verifier profiles and their trigger files.
  for (const needle of [
    "git diff --check",
    "git diff --cached --check",
    "lakefile.lean",
    "lakefile.toml",
    "lake build",
    "Cargo.toml",
    "cargo test",
    "go.mod",
    "go test ./...",
    "pyproject.toml",
    "pytest.ini",
    "pytest",
    "package.json",
    "npm run lint --if-present",
    "npm run typecheck --if-present",
    "npm test --if-present",
  ]) {
    assertContains(ext, needle);
  }

  // Prisma/PostgreSQL verification uses a disposable, loopback-only database
  // and never targets repository Compose services. Runtime probes use each
  // engine's own version field so a working Podman installation is detected.
  assertContains(ext, 'candidate === "docker" ? "{{.ServerVersion}}" : "{{.Version.Version}}"');

  // All common Prisma URLs are overridden, cleanup verifies ownership, and
  // reports omit the credential.
  for (const needle of [
    'provider\\s*=\\s*["\']postgresql["\']',
    '"127.0.0.1::5432"',
    '"pi.gitverify=isolated"',
    "TEST_DATABASE_URL: isolation.connectionString",
    "DATABASE_URL: isolation.connectionString",
    "DIRECT_DATABASE_URL: isolation.connectionString",
    "redactIsolationSecrets(",
    "refusing to run inferred verifiers without database isolation",
    '"volume", "create", "--driver", "local", "--label", "pi.gitverify=isolated", isolation.volumeName',
    '`${isolation.volumeName}:/var/lib/postgresql/data`',
    '["inspect", "--type", "container", "--format",',
    'const container = await removeOwned("container", containerName);',
    'const volume = await removeOwned("volume", volumeName);',
    'return absent(confirmation) ? "removed"',
    "isolatedPostgres: publicIsolation(verification.isolation)",
  ]) {
    assertContains(ext, needle);
  }
  assert.ok(!source.includes('"--tmpfs"'), "migration data and temporary files must use disposable disk-backed storage");
  assert.ok(!source.includes("docker compose"), "isolated verification must never target repository Compose services");
  const renderedLaunch = source.match(/launch\.command = ([^\n]+)/)?.[1] ?? "";
  assert.ok(renderedLaunch && !renderedLaunch.includes("POSTGRES_PASSWORD"), "the generated database credential must not enter the rendered report command");

  // Timeouts and the persisted message channel.
  for (const needle of ["GIT_TIMEOUT_MS = 30_000", "VERIFY_TIMEOUT_MS = 120 * 60_000", "PUSH_TIMEOUT_MS = 2 * 60_000", 'customType: "git-evidence-courier"']) {
    assertContains(ext, needle);
  }

  // The extension deliberately has no environment knobs today; adding one
  // should update this test plus README/docs env documentation.
  assert.ok(!source.includes("process.env"), "extension has no env knobs; document any new knob before adding it");

  // Extension README documents the full command/tool surface.
  const readme = "extensions/git-evidence-courier/README.md";
  for (const needle of ["/git:evidence", "/git:verify", "/git:publish", "gitevidence", "gitverify", "isolated PostgreSQL", "no model-callable publish tool"]) {
    assertContains(readme, needle);
  }

  // Harness docs cover the extension.
  assertContains("docs/productization-extensions.md", "Git Evidence Courier");
  assertContains("docs/productization-extensions.md", "extensions/git-evidence-courier/index.ts");
  assertContains("wiki/extensions-and-commands.md", "extensions/git-evidence-courier");

  console.log("git-evidence-courier tests passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
