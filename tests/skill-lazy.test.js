"use strict";

// The global skill catalog is the largest fixed prompt section. Project skills
// must stay fully described; user-scope skills are replaced by a name index so
// the model can load a body only when a task matches.

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  SECTION_NAME,
  isGlobalSkill,
  buildGlobalIndex,
  reduceSkillsOptions,
  applySkillsReduction,
  rewriteSkillsBlock,
} = require("../src/skill-lazy");

function skill(name, scope, dir, extra = {}) {
  return {
    name,
    description: `${name} description`,
    filePath: `${dir}/${name}/SKILL.md`,
    baseDir: `${dir}/${name}`,
    sourceInfo: { scope },
    disableModelInvocation: false,
    ...extra,
  };
}

function options(skills) {
  return { skills, sections: {}, forceSystemPrompt: undefined };
}

function promptWithSkills(blocks) {
  return [
    "<preamble>base</preamble>",
    "<skills>",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
    ...blocks,
    "</available_skills>",
    "</skills>",
    "<cwd>/work</cwd>",
  ].join("\n");
}

function block(name, dir) {
  return [
    "  <skill>",
    `    <name>${name}</name>`,
    `    <description>${name} description</description>`,
    `    <location>${dir}/${name}/SKILL.md</location>`,
    "  </skill>",
  ].join("\n");
}

// Scope classification
assert.equal(isGlobalSkill(skill("a", "user", "/global")), true);
assert.equal(isGlobalSkill(skill("a", "project", "/work")), false);
assert.equal(isGlobalSkill({ name: "legacy" }), false, "missing source info fails open and keeps the skill visible");

// Reduction
const globalOne = skill("build", "user", "/home/u/.agents/skills");
const globalTwo = skill("long-run", "user", "/home/u/.agents/skills");
const hidden = skill("hidden-skill", "user", "/home/u/.agents/skills", { disableModelInvocation: true });
const project = skill("project-skill", "project", "/work/.agents/skills");
const temporary = skill("cli-skill", "temporary", "/tmp/skills");
const reduced = reduceSkillsOptions(options([globalOne, globalTwo, hidden, project, temporary]), {});
assert.ok(reduced, "user-scope skills trigger the reduction");
assert.deepEqual(
  reduced.localSkills.map((entry) => entry.name),
  ["project-skill", "cli-skill"],
  "project and temporary skills keep their descriptions",
);
assert.deepEqual([...reduced.globalNames].sort(), ["build", "hidden-skill", "long-run"]);
assert.match(reduced.section, /lazy-loaded \(2 names, no descriptions\)/);
assert.match(reduced.section, /- \/home\/u\/\.agents\/skills: build, long-run/);
assert.doesNotMatch(reduced.section, /hidden-skill/, "disable-model-invocation skills are not advertised");

assert.equal(reduceSkillsOptions(options([project]), {}), null, "no user-scope skills means no change");
assert.equal(reduceSkillsOptions(options([]), {}), null);
assert.equal(reduceSkillsOptions(options([globalOne]), { PI_SKILL_LAZY: "0" }), null, "rollback switch disables the hook");
assert.equal(reduceSkillsOptions(undefined, {}), null);

// Mutation
const target = options([globalOne, project]);
const applied = reduceSkillsOptions(target, {});
applySkillsReduction(target, applied);
assert.deepEqual(target.skills.map((entry) => entry.name), ["project-skill"]);
assert.match(target.sections[SECTION_NAME], /build/);
assert.equal(target.sections.global_skills, applied.section);

// Index grouping
assert.equal(buildGlobalIndex([]), "");
assert.match(buildGlobalIndex([skill("a&b", "user", "/dir&x")]), /a&amp;b/, "index values are XML-escaped");

// Forced-prompt rewrite
const fullPrompt = promptWithSkills([block("build", "/home/u/.agents/skills"), block("project-skill", "/work/.agents/skills")]);
const rewritten = rewriteSkillsBlock(fullPrompt, applied);
assert.ok(rewritten.includes("<skills>"), "project skills keep the skills section");
assert.match(rewritten, /<name>project-skill<\/name>/);
assert.doesNotMatch(rewritten, /<name>build<\/name>/);
assert.match(rewritten, new RegExp(`<${SECTION_NAME}>`));
assert.match(rewritten, /build/);
assert.ok(rewritten.endsWith("<cwd>/work</cwd>"), "the rest of the forced prompt is preserved");

const noProject = rewriteSkillsBlock(
  promptWithSkills([block("build", "/home/u/.agents/skills")]),
  applied,
);
assert.doesNotMatch(noProject, /<skills>/, "no project skills means the skills section disappears");
assert.match(noProject, new RegExp(`<${SECTION_NAME}>`));

assert.equal(rewriteSkillsBlock("<preamble>base</preamble>", applied), "<preamble>base</preamble>", "a prompt without skills is left alone");
assert.equal(rewriteSkillsBlock(rewritten, applied), rewritten, "rewriting is idempotent");
assert.equal(rewriteSkillsBlock(undefined, applied), undefined);
assert.equal(rewriteSkillsBlock("<skills>\nunknown format\n</skills>", applied), "<skills>\nunknown format\n</skills>", "unparseable skills blocks fail open");

// Extension hook: mutation without a forced prompt, rewrite with one.
(async () => {
  let piPackageRoot;
  try {
    const candidate = path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
    if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
  } catch {}
  if (!piPackageRoot) {
    console.log("skill-lazy tests skipped extension hook (global pi install not found)");
    console.log("skill lazy tests passed");
    return;
  }
  const jitiModule = require(require.resolve("jiti", { paths: [piPackageRoot] }));
  const createJiti = jitiModule.createJiti || jitiModule;
  const extensionFile = path.resolve(".pi/extensions/skill-lazy/index.ts");
  const jiti = createJiti(extensionFile, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": piPackageRoot } });
  const mod = await jiti.import(extensionFile);
  const handlers = [];
  const commands = [];
  (mod.default || mod)({
    on: (event, handler) => handlers.push({ event, handler }),
    registerCommand: (name, definition) => commands.push({ name, definition }),
  });
  const handler = handlers.find((row) => row.event === "before_agent_start").handler;
  const catalog = commands.find((row) => row.name === "skill-catalog");
  assert.ok(catalog, "the catalog command is registered");
  const logged = [];
  const originalLog = console.log;
  console.log = (value) => logged.push(String(value));
  await catalog.definition.handler("", { getSystemPromptOptions: () => options([globalOne, globalTwo, project]) });
  console.log = originalLog;
  assert.match(logged.join("\n"), /- \/home\/u\/\.agents\/skills: build, long-run/, "the command derives the index before the first turn");

  const eventOptions = options([globalOne, project]);
  assert.equal(await handler({ systemPromptOptions: eventOptions }), undefined);
  assert.deepEqual(eventOptions.skills.map((entry) => entry.name), ["project-skill"]);
  assert.ok(eventOptions.sections.global_skills);

  const forcedOptions = options([globalOne, project]);
  forcedOptions.forceSystemPrompt = fullPrompt;
  const result = await handler({ systemPromptOptions: forcedOptions });
  assert.ok(result && typeof result.systemPrompt === "string", "a stale forced prompt is rewritten");
  assert.doesNotMatch(result.systemPrompt, /<name>build<\/name>/);
  assert.match(result.systemPrompt, /<name>project-skill<\/name>/);
  assert.equal(forcedOptions.forceSystemPrompt, fullPrompt, "the runner replaces the forced text with our result");

  const disabledOptions = options([globalOne]);
  const previous = process.env.PI_SKILL_LAZY;
  process.env.PI_SKILL_LAZY = "0";
  assert.equal(await handler({ systemPromptOptions: disabledOptions }), undefined);
  assert.deepEqual(disabledOptions.skills.map((entry) => entry.name), ["build"]);
  if (previous === undefined) delete process.env.PI_SKILL_LAZY;
  else process.env.PI_SKILL_LAZY = previous;

  console.log("skill lazy tests passed");
})().catch((error) => { console.error(error); process.exit(1); });
