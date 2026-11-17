"use strict";

// Pi advertises every discovered skill by name, description and path in the
// system prompt on every turn. With a large user-scope skill library installed
// globally, those descriptions dominate the fixed prompt. This module keeps
// project-scoped skills (which belong to the current repository) fully
// described and replaces the user-scope catalog with a compact name index that
// points at each skill's SKILL.md. The model loads a body only when a task
// matches a name, so the catalog stays available without paying for every
// description up front.

const path = require("node:path");

const SECTION_NAME = "global_skills";

function isGlobalSkill(skill) {
  // Pi marks user-scope resources (agent dir skills, ~/.agents/skills and
  // package-provided skills) with scope "user". Project and temporary skills
  // stay visible with their full routing descriptions.
  return skill?.sourceInfo?.scope === "user";
}

function skillRoot(skill) {
  // baseDir is the directory containing SKILL.md; its parent is the directory
  // whose <name>/SKILL.md pattern the model can follow.
  if (typeof skill?.baseDir === "string" && skill.baseDir) return path.dirname(skill.baseDir);
  if (typeof skill?.filePath === "string" && skill.filePath) return path.dirname(path.dirname(skill.filePath));
  return "";
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render the lazy index for user-scope skills. Only model-visible skills are
 * listed: Pi hides `disable-model-invocation` skills from automatic selection,
 * so naming them here would contradict that contract.
 */
function buildGlobalIndex(globalSkills) {
  const byDir = new Map();
  let visible = 0;
  for (const skill of globalSkills) {
    if (!skill || skill.disableModelInvocation || typeof skill.name !== "string" || !skill.name) continue;
    const dir = skillRoot(skill);
    if (!dir) continue;
    visible += 1;
    const names = byDir.get(dir) ?? [];
    names.push(skill.name);
    byDir.set(dir, names);
  }
  if (visible === 0) return "";

  const groups = Array.from(byDir.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dir, names]) => `- ${escapeXml(dir)}: ${names.sort().map(escapeXml).join(", ")}`);
  const intro =
    `Global skills are lazy-loaded (${visible} ${visible === 1 ? "name" : "names"}, no descriptions) to keep this prompt small. ` +
    "Read <dir>/<name>/SKILL.md when a task matches a name; if a name is unclear, grep the skill files for keywords.";
  return [intro, ...groups].join("\n");
}

/**
 * Compute the prompt reduction for mutable system prompt options.
 * Returns null when the feature is disabled or no user-scope skill exists.
 */
function reduceSkillsOptions(options, env = process.env) {
  if (env?.PI_SKILL_LAZY === "0") return null;
  const skills = Array.isArray(options?.skills) ? options.skills : [];
  const global = skills.filter(isGlobalSkill);
  if (global.length === 0) return null;
  const section = buildGlobalIndex(global);
  if (!section) return null;
  return {
    localSkills: skills.filter((skill) => !isGlobalSkill(skill)),
    globalNames: new Set(global.map((skill) => skill.name).filter(Boolean)),
    section,
  };
}

/** Mutate the prompt options so both rendering and persisted sections shrink. */
function applySkillsReduction(options, reduction) {
  options.skills = reduction.localSkills;
  options.sections = { ...(options.sections ?? {}), [SECTION_NAME]: reduction.section };
}

/**
 * A before_agent_start handler that ran earlier may have forced an exact
 * prompt text built before this reduction. Rewrite that text so the request
 * carries the same reduced skills the persisted sections describe. The
 * original `<skills>` block is kept for project skills; user-scope blocks are
 * dropped and replaced by the lazy index.
 */
function rewriteSkillsBlock(text, reduction) {
  if (typeof text !== "string" || !text) return text;
  if (text.includes(`<${SECTION_NAME}>`)) return text;
  const start = text.indexOf("<skills>");
  if (start === -1) return text;
  const end = text.indexOf("</skills>", start);
  if (end === -1) return text;

  const inner = text.slice(start + "<skills>".length, end);
  const availableAt = inner.indexOf("<available_skills>");
  const blocks = Array.from(inner.matchAll(/ {2}<skill>\n([\s\S]*?)\n {2}<\/skill>/g), (match) => match[0]);
  // Unknown formatting: leave the forced text alone rather than risk dropping
  // project skills we cannot parse.
  if (availableAt === -1 || blocks.length === 0) return text;
  const preamble = inner.slice(0, availableAt).trim();
  const kept = blocks.filter((block) => {
    const name = /<name>(.*?)<\/name>/.exec(block)?.[1];
    return Boolean(name) && !reduction.globalNames.has(name);
  });

  const skillsPart = kept.length
    ? `<skills>\n${preamble}\n\n<available_skills>\n${kept.join("\n")}\n</available_skills>\n</skills>`
    : "";
  const globalPart = `<${SECTION_NAME}>\n${reduction.section}\n</${SECTION_NAME}>`;
  const replacement = [skillsPart, globalPart].filter(Boolean).join("\n\n");
  return `${text.slice(0, start)}${replacement}${text.slice(end + "</skills>".length)}`;
}

module.exports = {
  SECTION_NAME,
  isGlobalSkill,
  buildGlobalIndex,
  reduceSkillsOptions,
  applySkillsReduction,
  rewriteSkillsBlock,
};
