#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pack = path.join(root, "skills");
const source = path.join(pack, "skills");
const catalog = JSON.parse(fs.readFileSync(path.join(pack, "catalog.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(pack, "manifest.json"), "utf8"));
const expected = catalog.map((item) => item.name).sort();
const discovered = fs.readdirSync(source, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(source, entry.name, "SKILL.md")))
  .map((entry) => entry.name).sort();
const managed = fs.readFileSync(path.join(source, "managed-skills.txt"), "utf8").trim().split(/\r?\n/);

// The 121 supplied pack skills plus eight legacy skills restored and adapted to
// the pack standard because no supplied skill covers their workflows.
const restored = {
  handoff: "handoff-contract.md",
  "git-checkpoint": "checkpoint-contract.md",
  "change-verify": "verification-contract.md",
  "long-run": "long-run-contract.md",
  "durable-bug-hunt": "bug-hunt-contract.md",
  "experiment-gate-lifecycle": "experiment-gate-contract.md",
  build: "build-contract.md",
  "typesafe-ai": "typesafe-guide.md",
};
assert.equal(expected.length, 121 + Object.keys(restored).length, "catalog holds the 121-skill pack plus the restored legacy skills");
for (const name of Object.keys(restored)) assert.ok(expected.includes(name), `restored skill must be in the catalog: ${name}`);
assert.equal(new Set(expected).size, expected.length, "catalog names must be unique");
assert.deepEqual(discovered, expected, "no missing bundle skills or retained legacy skills");
assert.deepEqual(managed, expected, "installer manifest must exactly match the sorted catalog");
assert.equal(manifest.skill_count, expected.length);
assert.deepEqual(manifest.skills.map((item) => item.name), expected);
for (const entry of manifest.skills) {
  assert.equal(entry.path, `skills/${entry.name}/SKILL.md`);
  assert.equal(entry.eval, `evals/${entry.name}.json`);
  assert.ok(fs.existsSync(path.join(pack, entry.path)), `missing skill: ${entry.name}`);
  assert.ok(fs.existsSync(path.join(pack, entry.eval)), `missing eval: ${entry.name}`);
}

// Use the bundle's own contract checker and offline integration tests. This does
// not execute the designed model-level eval prompts or access a provider.
const generatedFiles = ["CATALOG.md", "manifest.json", ...expected.flatMap((name) => [
  `skills/${name}/SKILL.md`, `evals/${name}.json`,
])];
const fingerprints = () => generatedFiles.map((file) => [file, crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(pack, file))).digest("hex")]);
const before = fingerprints();
const options = { cwd: pack, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdio: "inherit" };
execFileSync("python3", ["tools/validate_skills.py"], options);
execFileSync("python3", ["-m", "unittest", "discover", "-s", "tests", "-v"], options);
assert.deepEqual(fingerprints(), before, "regeneration must preserve every skill, eval and inventory byte");

// The restored handoff must keep its durable whole-session continuation
// contract, not just the bundle's generic per-artifact handoff section.
const handoffEntry = catalog.find((item) => item.name === "handoff");
assert.deepEqual(handoffEntry.refs, ["references/handoff-contract.md"]);
const handoffSkill = fs.readFileSync(path.join(source, "handoff", "SKILL.md"), "utf8");
const handoffContract = fs.readFileSync(path.join(source, "handoff", "references", "handoff-contract.md"), "utf8");
const handoffDescription = JSON.parse(handoffSkill.match(/^description: (".*")$/m)[1]);
// Routing regression from fcbd76b: saving a plan or notes to a project file is not a handoff.
assert.match(handoffDescription, /Do not use when [^.]*\bplan\b[^.]*\bnotes\b/);
for (const text of [handoffSkill, handoffContract]) {
  assert.match(text, /[Ww]rite the (?:handoff )?file before responding/);
}
assert.match(handoffSkill, /references\/handoff-contract\.md/);
const order = (text, items, label) => {
  const positions = items.map((item) => text.indexOf(item));
  assert.ok(positions.every((position) => position >= 0), `${label}: missing ${items[positions.indexOf(-1)]}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, `${label} must keep its order`);
};
order(handoffContract, ["`handoffs/`", "`.codex/handoffs/`", "`/tmp/agent-handoffs/<YYYY-MM-DD>-<slug>.md`"], "destination precedence");
order(handoffContract, ["## Resume Prompt", "## Current Goal", "## Current State", "## User Requests And Constraints",
  "## Work Completed", "## Work In Progress", "## Changed Files", "## Verification", "## Known Issues Or Blockers",
  "## Next Actions", "## Context Notes"], "handoff file sections");
for (const required of [
  "From the repository root, read `<repo-relative handoff path>` first, verify the current repository state, then continue from the Next Actions section without relying on prior chat history.",
  "git status --short", "git diff --cached --name-only", "background commands, subagents, worktrees",
  "Original absolute handoff path", "Do not claim verification that was not run", "Absolute path to the handoff file",
]) {
  assert.ok(handoffContract.includes(required), `handoff contract must keep: ${required}`);
}

// Each restored skill routes through its catalog entry to a preserved legacy contract.
const skillText = (name) => fs.readFileSync(path.join(source, name, "SKILL.md"), "utf8");
const contract = (name) => fs.readFileSync(path.join(source, name, "references", restored[name]), "utf8");
for (const name of Object.keys(restored)) {
  const entry = catalog.find((item) => item.name === name);
  assert.equal(entry.refs[0], `references/${restored[name]}`, `${name} must list its contract first`);
  assert.ok(entry.steps[0].startsWith(`Read \`references/${restored[name]}\``), `${name} must load its contract first`);
  if (name === "handoff") continue;
  const [, provenance, body] = contract(name).match(/^# [^\n]+\n\n(Provenance[\s\S]*?)\n\n([\s\S]*)$/) || [];
  assert.ok(provenance && body, `${name} contract needs a provenance header`);
  // Skill references in a preserved body must resolve to current catalog skills.
  const nonSkills = new Set(["nvidia-smi", "no-change", "no-go"]);
  for (const [, token] of body.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)) {
    if (!nonSkills.has(token)) assert.ok(expected.includes(token), `${name} contract references missing skill ${token}`);
  }
}
const keeps = (name, phrases) => {
  const text = contract(name);
  for (const phrase of phrases) assert.ok(text.includes(phrase), `${name} contract must keep: ${phrase}`);
};
const description = (name) => JSON.parse(skillText(name).match(/^description: (".*")$/m)[1]);
assert.match(description("git-checkpoint"), /^Use when the user explicitly asks to commit/);
assert.match(description("git-checkpoint"), /Do not use when [^.]*\bpush\b/);
keeps("git-checkpoint", ["Never branch, stage, or commit without an explicit user request.",
  "Never stage everything with `git add .`, `git add -A`", "Do not use `--no-verify`.",
  "Never repeat a mutating Git command when its outcome is unknown.", "Push/publish: not performed"]);
// 688dd46: a verification helper reports failures but does not revoke the parent plan's repair authority.
keeps("change-verify", ["this verification-only helper reports it and returns control without repairing it",
  "the parent retains authority for in-scope repairs", "never invent a likely command",
  "Do not repeatedly rerun an unexplained failure.", "Run `gitverify` before a readiness claim.",
  "Only `PASS` supports a verified/readiness claim."]);
// run_monitor terminal checks are script-backed and never start a model turn.
keeps("long-run", ["Use managed background tools instead of blocking shell calls or `sleep`/`tail` loops.",
  "A timeout means \u201cnot observed within the bound,\u201d not necessarily \u201cprocess failed.\u201d",
  "terminal checks are script-backed and never start a model turn", "Never use a broad process-kill pattern."]);
keeps("durable-bug-hunt", ["Open or inspect the matching `debug_ledger` thread before changing anything.",
  "Never retry a change already recorded with `no-change`, `worse`", "Use `safe_try` before risky or broad attempts",
  "Deep mode requires at least three materially different hypotheses."]);
keeps("experiment-gate-lifecycle", ["Inspect open `experiment_ledger` records before launching anything.",
  "Do not weaken bars after observing results.", "Record PASS, FAIL, and NULL-RESULT.",
  "A long-running process settling is not a successful experiment."]);
keeps("build", ["Detect the repository-defined build path before running commands.",
  "Do not suppress warnings, disable tests, pin arbitrary old versions, or add fallback toolchains",
  "A provider or resource failure is not a source failure.", "CI parity: confirmed | gap"]);
// typesafe-ai is third-party MIT material: its license must travel with the skill.
const typesafeEntry = catalog.find((item) => item.name === "typesafe-ai");
assert.ok(typesafeEntry.refs.includes("LICENSE"), "typesafe-ai must list its LICENSE");
const typesafeLicense = fs.readFileSync(path.join(source, "typesafe-ai", "LICENSE"), "utf8");
assert.ok(typesafeLicense.startsWith("MIT License\n\nCopyright (c) 2026 TypeSafe AI\n"), "typesafe-ai LICENSE must keep its copyright");
assert.match(contract("typesafe-ai"), /Copyright \(c\) 2026 TypeSafe AI[\s\S]*`\.\.\/LICENSE`/);
keeps("typesafe-ai", ["https://docs.typesafe.ai/llms.txt", "The live TypeSafe docs are the source of truth.",
  "Keep API credentials server-side in web apps."]);
assert.match(skillText("typesafe-ai"), /^# TypeSafe AI$/m);

const migration = fs.readFileSync(path.join(root, "docs", "skill-bundle-migration.md"), "utf8");
for (const required of ["legacy-skills.tar.gz", "manifest.json", "Coverage decisions", "NOT TESTED"]) {
  assert.ok(migration.includes(required), `migration record must include ${required}`);
}
const report = fs.readFileSync(path.join(root, "docs", "session-derived-skills.md"), "utf8");
assert.ok(report.includes("Historical report:"), "legacy study must not advertise retired skills");
assert.ok(report.includes("No prompts, assistant responses, reasoning, raw commands, tool output, credentials, or transcript excerpts"));
assert.ok(report.includes("## Limitations"));
console.log(`generic agent skills tests passed (121 pack skills + ${Object.keys(restored).length} restored; static/offline validation only)`);
