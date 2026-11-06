#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { tmpFixture } = require("./helpers/tmp-fixture");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "scripts", "install-agent-skills.sh");
const tmp = tmpFixture("pi-install-agent-skills-");

function run(args, env) {
  return spawnSync("bash", [script, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

try {
  const syntax = spawnSync("bash", ["-n", script], { cwd: root, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr || "installer should pass bash syntax validation");

  const canonicalSource = path.join(root, "skills", "skills");
  const canonicalNames = fs.readFileSync(path.join(canonicalSource, "managed-skills.txt"), "utf8").trim().split(/\r?\n/);
  const localizedList = run(["--list"], {
    PI_SKILLS_SOURCE_DIR: canonicalSource,
    PI_SKILLS_MANIFEST_FILE: path.join(canonicalSource, "managed-skills.txt"),
    LC_ALL: "en_US.UTF-8",
  });
  assert.equal(localizedList.status, 0, localizedList.stderr);
  assert.deepEqual(localizedList.stdout.trim().split(/\r?\n/), canonicalNames,
    "catalog order must be byte-sorted even in a locale that ignores hyphens");

  const source = path.join(tmp, "skills");
  const claudeDest = path.join(tmp, "claude-skills");
  const agentDest = path.join(tmp, "agent-skills");
  const sourceManifest = path.join(source, "managed-skills.txt");
  for (const name of ["zeta-skill", "alpha-skill"]) {
    fs.mkdirSync(path.join(source, name, "examples"), { recursive: true });
    fs.writeFileSync(path.join(source, name, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture skill for installer tests\n---\n# ${name}\n`);
    fs.writeFileSync(path.join(source, name, "examples", "example.txt"), `${name}\n`);
  }
  fs.writeFileSync(sourceManifest, "zeta-skill\nalpha-skill\n");
  fs.mkdirSync(path.join(source, "not-a-skill"), { recursive: true });
  fs.writeFileSync(path.join(source, "not-a-skill", "README.md"), "ignored\n");

  const env = {
    PI_SKILLS_SOURCE_DIR: source,
    CLAUDE_SKILLS_DIR: claudeDest,
    AGENT_SKILLS_DIR: agentDest,
    PI_USER_SKILLS_DIR: path.join(tmp, "no-pi-user-skills"),
  };
  const listed = run(["--list"], env);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split(/\r?\n/), ["alpha-skill", "zeta-skill"], "--list returns the exact manifest in deterministic order");

  const dryRun = run(["--dry-run"], env);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Would reconcile 2 managed skills in/);
  assert.match(dryRun.stdout, /would install: alpha-skill/);
  assert.equal(fs.existsSync(claudeDest), false, "--dry-run must not create the Claude destination");
  assert.equal(fs.existsSync(agentDest), false, "--dry-run must not create the agent destination");

  fs.mkdirSync(path.join(claudeDest, "alpha-skill"), { recursive: true });
  fs.writeFileSync(path.join(claudeDest, "alpha-skill", "stale.txt"), "stale\n");
  const installed = run([], env);
  assert.equal(installed.status, 0, installed.stderr);
  for (const destination of [claudeDest, agentDest]) {
    for (const name of ["alpha-skill", "zeta-skill"]) {
      assert.equal(fs.readFileSync(path.join(destination, name, "SKILL.md"), "utf8"), `---\nname: ${name}\ndescription: Fixture skill for installer tests\n---\n# ${name}\n`);
      assert.equal(fs.readFileSync(path.join(destination, name, "examples", "example.txt"), "utf8"), `${name}\n`);
    }
    assert.deepEqual(fs.readFileSync(path.join(destination, ".pi-harness-managed-skills"), "utf8").trim().split(/\r?\n/), ["alpha-skill", "zeta-skill"]);
  }
  assert.equal(fs.existsSync(path.join(claudeDest, "alpha-skill", "stale.txt")), false, "installation replaces stale skill contents");

  for (const destination of [claudeDest, agentDest]) {
    fs.mkdirSync(path.join(destination, "user-owned-skill"), { recursive: true });
    fs.writeFileSync(path.join(destination, "user-owned-skill", "SKILL.md"), "# user owned\n");
  }
  fs.rmSync(path.join(source, "zeta-skill"), { recursive: true });
  fs.writeFileSync(sourceManifest, "alpha-skill\n");

  const pruneDryRun = run(["--dry-run"], env);
  assert.equal(pruneDryRun.status, 0, pruneDryRun.stderr);
  assert.match(pruneDryRun.stdout, /would prune managed skill: zeta-skill/);
  assert.equal(fs.existsSync(path.join(claudeDest, "zeta-skill")), true, "prune dry-run does not mutate destinations");

  const pruned = run([], env);
  assert.equal(pruned.status, 0, pruned.stderr);
  for (const destination of [claudeDest, agentDest]) {
    assert.equal(fs.existsSync(path.join(destination, "zeta-skill")), false, "removed managed skills are pruned");
    assert.equal(fs.existsSync(path.join(destination, "user-owned-skill", "SKILL.md")), true, "unmanaged skills are preserved");
    assert.equal(fs.readFileSync(path.join(destination, ".pi-harness-managed-skills"), "utf8"), "alpha-skill\n");
  }

  fs.mkdirSync(path.join(source, "unlisted-skill"), { recursive: true });
  fs.writeFileSync(path.join(source, "unlisted-skill", "SKILL.md"), "# unlisted\n");
  const mismatch = run(["--list"], env);
  assert.notEqual(mismatch.status, 0, "manifest/discovery drift fails closed");
  assert.match(mismatch.stderr, /manifest does not match discovered skills/i);

  // Pi's user skill root shadows a managed name: Pi keys skills by declared name
  // and loads ~/.pi/agent/skills ahead of the shared catalog, so the managed copy
  // is installed but never loaded. The installer must displace the shadowing copy.
  const shadowSource = path.join(tmp, "shadow-source");
  const shadowManifest = path.join(shadowSource, "managed-skills.txt");
  const managedBody = (name) => `---\nname: ${name}\ndescription: Managed fixture skill for shadowing tests\n---\n# managed ${name}\n`;
  const shadowNames = ["alias-skill", "collide-skill", "nested-skill", "noname-skill", "quoted-skill", "renamed-skill"];
  for (const name of shadowNames) {
    fs.mkdirSync(path.join(shadowSource, name), { recursive: true });
    fs.writeFileSync(path.join(shadowSource, name, "SKILL.md"), managedBody(name));
  }
  fs.writeFileSync(shadowManifest, `${shadowNames.join("\n")}\n`);

  const shadowAgentDest = path.join(tmp, "shadow-agent-skills");
  const shadowClaudeDest = path.join(tmp, "shadow-claude-skills");
  const shadowBackups = path.join(tmp, "shadow-backups");
  const piUserSkills = path.join(tmp, "pi-agent-skills");
  const staleBody = "---\nname: collide-skill\ndescription: Stale local copy that must not shadow the managed skill\n---\n# stale\n";
  const quotedBody = '---\nname: "quoted-skill"\ndescription: Quoted declared name that still collides with quoted-skill\n---\n# stale quoted\n';
  const nonameBody = "---\ndescription: No name field, so Pi falls back to the directory name\n---\n# stale noname\n";
  const renamedBody = "---\nname: renamed-skill\ndescription: Declared name differs from its directory name\n---\n# stale renamed\n";
  const nestedBody = "---\nname: nested-skill\ndescription: Nested group layout that Pi also discovers\n---\n# stale nested\n";
  fs.mkdirSync(path.join(piUserSkills, "collide-skill"), { recursive: true });
  fs.writeFileSync(path.join(piUserSkills, "collide-skill", "SKILL.md"), staleBody);
  fs.writeFileSync(path.join(piUserSkills, "collide-skill", "stale.txt"), "stale local content\n");
  fs.mkdirSync(path.join(piUserSkills, "quoted-skill"), { recursive: true });
  fs.writeFileSync(path.join(piUserSkills, "quoted-skill", "SKILL.md"), quotedBody);
  fs.mkdirSync(path.join(piUserSkills, "noname-skill"), { recursive: true });
  fs.writeFileSync(path.join(piUserSkills, "noname-skill", "SKILL.md"), nonameBody);
  fs.mkdirSync(path.join(piUserSkills, "renamed-dir"), { recursive: true });
  fs.writeFileSync(path.join(piUserSkills, "renamed-dir", "SKILL.md"), renamedBody);
  fs.mkdirSync(path.join(piUserSkills, "group", "nested-skill"), { recursive: true });
  fs.writeFileSync(path.join(piUserSkills, "group", "nested-skill", "SKILL.md"), nestedBody);
  fs.mkdirSync(path.join(piUserSkills, "alias-skill"), { recursive: true });
  fs.writeFileSync(path.join(piUserSkills, "alias-skill", "SKILL.md"), "---\nname: alias-skill-local\ndescription: Declares a different name so it does not collide with alias-skill\n---\n# local alias\n");
  fs.mkdirSync(path.join(piUserSkills, "user-local-skill"), { recursive: true });
  fs.writeFileSync(path.join(piUserSkills, "user-local-skill", "SKILL.md"), "---\nname: user-local-skill\ndescription: Unrelated user skill that must never be touched\n---\n# unrelated\n");

  const shadowEnv = {
    PI_SKILLS_SOURCE_DIR: shadowSource,
    PI_SKILLS_MANIFEST_FILE: shadowManifest,
    CLAUDE_SKILLS_DIR: shadowClaudeDest,
    AGENT_SKILLS_DIR: shadowAgentDest,
    PI_USER_SKILLS_DIR: piUserSkills,
    PI_SKILLS_SHADOW_BACKUP_DIR: shadowBackups,
  };

  const shadowDryRun = run(["--agents-only", "--dry-run"], shadowEnv);
  assert.equal(shadowDryRun.status, 0, shadowDryRun.stderr);
  for (const rel of ["collide-skill", "group/nested-skill", "noname-skill", "quoted-skill", "renamed-dir"]) {
    assert.match(shadowDryRun.stdout, new RegExp(`would shadow: ${rel} -> `), `${rel} is detected from a plain, quoted, missing or renamed declaration`);
  }
  assert.equal(fs.existsSync(path.join(piUserSkills, "collide-skill", "SKILL.md")), true, "shadow dry-run does not move the user copy");
  assert.equal(fs.existsSync(shadowClaudeDest), false, "--agents-only skips the Claude destination");

  const shadowInstall = run(["--agents-only"], shadowEnv);
  assert.equal(shadowInstall.status, 0, shadowInstall.stderr);
  for (const rel of ["collide-skill", "group/nested-skill", "noname-skill", "quoted-skill", "renamed-dir"]) {
    assert.match(shadowInstall.stdout, new RegExp(`shadowed: ${rel} -> `));
    assert.equal(fs.existsSync(path.join(piUserSkills, rel)), false, `${rel} is displaced`);
  }
  for (const name of shadowNames) {
    assert.equal(fs.readFileSync(path.join(shadowAgentDest, name, "SKILL.md"), "utf8"), managedBody(name), `${name} managed copy is installed`);
  }
  assert.equal(fs.existsSync(path.join(piUserSkills, "group")), true, "an emptied grouping directory is left in place");
  assert.equal(fs.existsSync(shadowClaudeDest), false, "--agents-only never creates the Claude destination");
  assert.equal(fs.existsSync(path.join(piUserSkills, "user-local-skill", "SKILL.md")), true, "unrelated user skills are preserved");
  assert.equal(fs.existsSync(path.join(piUserSkills, "alias-skill", "SKILL.md")), true, "a directory with a different declared name is not displaced");

  const backupDirs = fs.readdirSync(shadowBackups);
  assert.equal(backupDirs.length, 1, "exactly one timestamped backup directory is created");
  const backupPath = path.join(shadowBackups, backupDirs[0]);
  assert.deepEqual(fs.readdirSync(backupPath).sort(), ["collide-skill", "group", "noname-skill", "quoted-skill", "renamed-dir"], "only the shadowing copies are archived, preserving their relative paths");
  assert.equal(fs.readFileSync(path.join(backupPath, "collide-skill", "SKILL.md"), "utf8"), staleBody, "the displaced copy is preserved intact");
  assert.equal(fs.readFileSync(path.join(backupPath, "collide-skill", "stale.txt"), "utf8"), "stale local content\n");
  assert.equal(fs.readFileSync(path.join(backupPath, "quoted-skill", "SKILL.md"), "utf8"), quotedBody, "a quoted declared name is archived unchanged");
  assert.equal(fs.readFileSync(path.join(backupPath, "noname-skill", "SKILL.md"), "utf8"), nonameBody, "a name-less skill is archived unchanged");
  assert.equal(fs.readFileSync(path.join(backupPath, "renamed-dir", "SKILL.md"), "utf8"), renamedBody, "a renamed directory is archived under its own path");
  assert.equal(fs.readFileSync(path.join(backupPath, "group", "nested-skill", "SKILL.md"), "utf8"), nestedBody, "a nested skill is archived under its relative path");

  const shadowRepeat = run(["--agents-only"], shadowEnv);
  assert.equal(shadowRepeat.status, 0, shadowRepeat.stderr);
  assert.equal(fs.readdirSync(shadowBackups).length, 1, "a second run creates no further backup");
  assert.equal(fs.existsSync(path.join(piUserSkills, "alias-skill", "SKILL.md")), true, "repeat runs leave the non-colliding alias untouched");

  const samePath = run(["--agents-only"], { ...shadowEnv, PI_USER_SKILLS_DIR: shadowAgentDest });
  assert.notEqual(samePath.status, 0, "refuses when the Pi user skill root is the managed destination");
  assert.match(samePath.stderr, /same path/i);

  const rootSkillDir = path.join(tmp, "pi-root-skill");
  fs.mkdirSync(rootSkillDir, { recursive: true });
  fs.writeFileSync(path.join(rootSkillDir, "SKILL.md"), managedBody("collide-skill"));
  const rootIsSkill = run(["--agents-only"], { ...shadowEnv, PI_USER_SKILLS_DIR: rootSkillDir, PI_SKILLS_SHADOW_BACKUP_DIR: path.join(tmp, "root-skill-backups") });
  assert.notEqual(rootIsSkill.status, 0, "refuses when the Pi user skill root is itself a skill directory");
  assert.match(rootIsSkill.stderr, /is itself a skill directory/i);

  const insideBackup = run(["--agents-only"], { ...shadowEnv, PI_SKILLS_SHADOW_BACKUP_DIR: path.join(piUserSkills, "backups") });
  assert.notEqual(insideBackup.status, 0, "refuses a shadow backup directory inside a skill root");
  assert.match(insideBackup.stderr, /must be outside skill roots/i);

  console.log("install-agent-skills tests passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
