#!/usr/bin/env node
"use strict";

// Guards both directions of the harness awareness contract:
//   - subagents receive the current skill roster and never cite a retired skill
//   - generated skills name the registered specialist/subagent roles
// Everything is offline: no provider, no model call, no skill discovery.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pack = path.join(root, "skills");
const catalog = JSON.parse(fs.readFileSync(path.join(pack, "catalog.json"), "utf8"));
const specialists = JSON.parse(fs.readFileSync(path.join(pack, "specialists.json"), "utf8"));
const { DEFAULT_ROLE_CONTRACTS, createCustomReadOnlyContract, roleRoster, renderSpecialistRoster } = require("../src/role-contracts");
const { SubagentRunner } = require("../src/subagents");
const { CATALOG_PATH, MAX_PROMPT_CHARS, ROLE_SKILLS, buildCatalog, loadCatalog, readCatalog, skillNames, roleSkillNames, skillAwarenessPrompt } = require("../src/skill-awareness");

// Legacy skills retired by the 101-skill bundle migration. They must never be
// re-added to the catalog or cited by a subagent-facing prompt.
const ARCHIVED = [
  "api-design", "audit", "code-review", "concurrency", "execute-plan",
  "frontier-math-proof-engineering", "networking", "numerics", "observability",
  "perf", "refactor", "repo-orient", "research-framework-design", "security",
  "subsystem-plan", "test-design",
];
const CITATION_RULE = "Never cite a skill that is not in this list.";

// Match skill citations instead of bare words: archived names such as
// "refactor", "audit" or "security" are ordinary prose in objectives and bodies.
function citedSkills(block) {
  const cited = new Set();
  for (const line of block.split("\n")) {
    const categoryList = line.match(/^- ([a-z0-9-]+): (.+)$/);
    if (categoryList) { for (const name of categoryList[2].split(", ")) cited.add(name.trim()); continue; }
    const roleList = line.match(/^- ([a-z0-9-]+) \(([a-z0-9-]+)\): /);
    if (roleList) cited.add(roleList[1]);
  }
  return [...cited].sort();
}

function awarenessBlock(prompt) {
  const start = prompt.indexOf("Harness skill awareness:");
  assert(start >= 0, "role prompts must carry the harness skill-awareness block");
  const end = prompt.indexOf(CITATION_RULE);
  assert(end > start, "the skill-awareness block must close with its citation rule");
  return prompt.slice(start, end + CITATION_RULE.length);
}

function delegationSection(body) {
  const start = body.indexOf("## Harness delegation");
  assert(start >= 0, "generated skills must declare the harness delegation boundary");
  const next = body.indexOf("\n## ", start + 1);
  return next < 0 ? body.slice(start) : body.slice(start, next);
}

async function runnerPrompt(record) {
  const captured = [];
  const runner = new SubagentRunner({ execute: async ({ prompt }) => { captured.push(prompt); return { summary: "ok", final_response: "ok", artifacts: [], proposed_parent_updates: [], model_calls: 0, tool_calls: 0 }; } });
  await runner.run({ id: "sub_test", task: "Inspect the delegated scope.", workspacePolicy: "shared-readonly", ...record }, {});
  return captured.at(-1);
}

(async () => {
  const catalogNames = catalog.map((entry) => entry.name).sort();

  assert.equal(CATALOG_PATH, path.join(pack, "catalog.json"), "skill awareness must read the checked-in catalog");
  assert.deepEqual(skillNames(), catalogNames, "the roster is exactly the checked-in catalog");
  assert.equal(loadCatalog().names.length, catalogNames.length);

  // A retired skill stays retired: it is neither in the catalog nor the roster.
  for (const name of ARCHIVED) {
    assert(!catalogNames.includes(name), `archived skill must not return to the catalog: ${name}`);
    assert(!skillNames().includes(name), `archived skill must not appear in the roster: ${name}`);
  }

  // Role-specific guidance may only name registered roles and current skills.
  const registeredRoleIds = DEFAULT_ROLE_CONTRACTS.map((role) => role.roleId);
  for (const roleId of Object.keys(ROLE_SKILLS)) {
    assert(registeredRoleIds.includes(roleId), `skill guidance names an unregistered role: ${roleId}`);
    for (const name of roleSkillNames(roleId)) assert(catalogNames.includes(name), `skill guidance names an unknown skill: ${name}`);
  }

  for (const contract of DEFAULT_ROLE_CONTRACTS) {
    const block = awarenessBlock(contract.systemPrompt);
    assert.equal(contract.systemPrompt.split("Harness skill awareness:").length - 1, 1, `${contract.roleId} must carry the awareness block exactly once`);
    assert(block.length <= MAX_PROMPT_CHARS, `${contract.roleId} awareness block exceeds the bounded size`);
    const cited = citedSkills(block);
    assert.deepEqual(cited, [...new Set([...catalogNames, ...roleSkillNames(contract.roleId)])].sort(), `${contract.roleId} must be aware of every current skill and nothing else`);
    for (const name of ARCHIVED) assert(!cited.includes(name), `${contract.roleId} must not cite archived skill ${name}`);
    if (contract.workspacePolicy === "handler-only") assert.deepEqual(roleSkillNames(contract.roleId), [], `${contract.roleId} has no model and needs no role-specific skill guidance`);
  }

  // Awareness is additive: the declared role contract text is unchanged.
  const verifier = DEFAULT_ROLE_CONTRACTS.find((role) => role.roleId === "verifier");
  assert.match(verifier.systemPrompt, /Role contract: Verifier \(verifier\), intent=verify\./, "awareness must not disturb the declared role contract text");
  assert.match(verifier.systemPrompt, /- change-verify \(engineering\): /, "the verifier role must know the verification skill");

  // Custom read-only roles get the roster; an unregistered role id gets no
  // role-specific subset, while a registered id inherits that role's guidance.
  const custom = createCustomReadOnlyContract({ roleId: "custom-audit-reader", systemPrompt: "Inspect the declared subsystem and report bounded findings with paths." });
  assert.deepEqual(citedSkills(awarenessBlock(custom.systemPrompt)), catalogNames, "custom roles must see the full current roster");
  assert.match(custom.systemPrompt, /Caller specialization:\nInspect the declared subsystem/, "custom role prompts keep the caller specialization");
  const customPlanner = createCustomReadOnlyContract({ roleId: "planner", systemPrompt: "Inspect the plan." });
  assert.deepEqual(citedSkills(awarenessBlock(customPlanner.systemPrompt)), [...new Set([...catalogNames, ...roleSkillNames("planner")])].sort(), "a custom role reusing a registered role id inherits that role's guidance");

  // Non-contract children (explicit systemPrompt) receive the roster through the
  // runner prompt; contract children already carry it in their system prompt.
  const customPrompt = await runnerPrompt({ role: "custom-audit-reader", systemPrompt: "Caller specialization prompt for a bounded read-only review.", roleContract: null });
  assert.match(customPrompt, /Harness skill awareness:/, "non-contract children must be told which skills exist");
  assert.match(customPrompt, /System: Caller specialization prompt/, "prompt-only children keep their system prompt inline");
  assert.match(customPrompt, /Do not spawn additional subagents, call create_subagent, or invoke slash-command skills/, "skill awareness must not weaken the no-fanout rule");

  // Contract children receive the contract once, through --append-system-prompt;
  // embedding it again in the runner prompt would deliver it twice.
  const contractPrompt = await runnerPrompt({ role: "verifier", roleContract: verifier, systemPrompt: verifier.systemPrompt });
  assert.equal(contractPrompt.split("Harness skill awareness:").length - 1, 0, "contract children receive awareness through the appended system prompt, not again inline");
  assert(!contractPrompt.includes(`System: ${verifier.systemPrompt}`), "the contract system prompt must not be duplicated into the runner prompt");
  const rpcArgs = new SubagentRunner({ execute: async () => ({}) }).rpcArgs({ id: "sub_rpc", task: "Inspect.", workspacePolicy: "shared-readonly", role: "verifier", roleContract: verifier, systemPrompt: verifier.systemPrompt }, { rpc: { noSession: true } }).args;
  assert.equal(rpcArgs.filter((arg) => arg === "--append-system-prompt").length, 1, "the contract is appended exactly once");
  assert.equal(rpcArgs[rpcArgs.indexOf("--append-system-prompt") + 1], verifier.systemPrompt, "the appended system prompt is the contract prompt");

  // A record resumed with a persisted contract that predates skill awareness
  // still learns the roster at launch instead of running unaware.
  const legacyContract = { ...verifier, systemPrompt: verifier.systemPrompt.replace(awarenessBlock(verifier.systemPrompt), "").trim() };
  assert(!legacyContract.systemPrompt.includes("Harness skill awareness:"), "the legacy fixture must predate skill awareness");
  const legacyPrompt = await runnerPrompt({ role: "verifier", roleContract: legacyContract, systemPrompt: legacyContract.systemPrompt });
  assert.equal(legacyPrompt.split("Harness skill awareness:").length - 1, 1, "a legacy persisted contract must still receive the roster");
  assert(!legacyPrompt.includes("System: "), "the legacy contract is not duplicated inline either");

  // Generated skills carry the delegation boundary for the registered roles.
  assert.equal(specialists.schema_version, 1);
  assert.equal(fs.readFileSync(path.join(pack, "specialists.json"), "utf8"), renderSpecialistRoster(), "specialists.json must be generated from the role contracts");
  const rosterIds = specialists.roles.map((role) => role.roleId);
  assert.deepEqual(rosterIds, roleRoster().map((role) => role.roleId), "the roster order must follow the role contracts");
  assert.deepEqual([...rosterIds].sort(), [...registeredRoleIds].sort(), "specialists.json must match the registered role contracts");
  for (const role of specialists.roles) {
    const contract = DEFAULT_ROLE_CONTRACTS.find((candidate) => candidate.roleId === role.roleId);
    assert.equal(role.model, contract.workspacePolicy !== "handler-only", `${role.roleId} model flag must match the contract`);
    assert.equal(role.displayName, contract.displayName, `${role.roleId} display name must match the contract`);
    assert.equal(role.summary, contract.summary, `${role.roleId} summary must match the contract`);
    assert(role.summary.trim().length > 0 && role.summary.length <= 120, `${role.roleId} needs a bounded summary`);
  }

  for (const name of catalogNames) {
    const section = delegationSection(fs.readFileSync(path.join(pack, "skills", name, "SKILL.md"), "utf8"));
    for (const roleId of rosterIds) assert(section.includes(`\`${roleId}\``), `${name} must name specialist role ${roleId}`);
    assert(section.includes("create_subagent") && section.includes("specialist_tasks") && section.includes("run_topology"), `${name} must name the delegation tools`);
    assert(section.includes("skill discovery disabled"), `${name} must state that role children cannot load skills`);
    assert(section.includes("If your harness does not expose these roles or tools"), `${name} must stay usable outside the Pi harness`);
    for (const retired of ARCHIVED) assert(!section.includes(`\`${retired}\``), `${name} must not cite retired skill ${retired}`);
  }

  // The create_subagent description must tell the caller what the child cannot do.
  const extensionSource = fs.readFileSync(path.join(root, ".pi/extensions/reasoning-runtime/index.ts"), "utf8");
  assert.match(extensionSource, /Role children receive the harness skill roster but run with skill discovery disabled/, "create_subagent must document that children cannot load skills");
  assert.match(extensionSource, /pass any required skill guidance in task or systemPrompt/, "create_subagent must tell callers to pass skill guidance");

  // Fail closed on a missing, empty, invalid or duplicate catalog.
  assert.throws(() => buildCatalog([]), /SKILL_CATALOG_EMPTY/);
  assert.throws(() => buildCatalog([{ name: "Bad Name", category: "engineering", goal: "x" }]), /SKILL_CATALOG_INVALID_NAME/);
  assert.throws(() => buildCatalog([{ name: "alpha", category: "engineering", goal: "x" }, { name: "alpha", category: "engineering", goal: "y" }]), /SKILL_CATALOG_DUPLICATE_NAME/);
  assert.throws(() => readCatalog(path.join(pack, "missing-catalog.json")), /ENOENT/);

  // The bound leaves headroom, and overflow degrades deterministically with an
  // explicit marker instead of failing extension load.
  const largestBlock = Math.max(...DEFAULT_ROLE_CONTRACTS.map((contract) => awarenessBlock(contract.systemPrompt).length));
  assert(largestBlock < MAX_PROMPT_CHARS - 1000, "the roster must leave headroom under the awareness bound");
  const truncated = skillAwarenessPrompt({ roleId: "coder", maxChars: 1000 });
  assert(truncated.length <= 1000, "a degraded block must respect the requested bound");
  assert.match(truncated, /Roster truncated: \d+ of \d+ skill names are listed/, "a degraded block must say it is truncated");
  assert(truncated.includes(CITATION_RULE), "a degraded block keeps the citation rule");
  assert.equal(truncated, skillAwarenessPrompt({ roleId: "coder", maxChars: 1000 }), "degradation is deterministic");
  for (const name of citedSkills(truncated)) assert(catalogNames.includes(name), `a degraded block must not invent a skill: ${name}`);
  assert.throws(() => skillAwarenessPrompt({ maxChars: 10 }), /SKILL_AWARENESS_PROMPT_TOO_LARGE/, "an unusably small bound fails closed");

  // Determinism: the awareness block is stable for identical inputs.
  assert.equal(skillAwarenessPrompt({ roleId: "coder" }), skillAwarenessPrompt({ roleId: "coder" }));
  assert.equal(skillAwarenessPrompt({ roleId: null }), skillAwarenessPrompt({}));

  console.log(`skill awareness: ${catalogNames.length} skills, ${rosterIds.length} roles, ${DEFAULT_ROLE_CONTRACTS.length} role prompts checked`);
})();
