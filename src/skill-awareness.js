"use strict";

// Role children run with Pi skill discovery disabled (`--no-skills`), so a
// delegated role can never see or load a skill body. Awareness therefore comes
// from the checked-in catalog: children learn which procedural skills exist,
// which ones govern their own role, and that the parent must pass a body when
// the exact procedure is needed. `skills/catalog.json` is the only source of
// truth; tests/skill-awareness.test.js fails if this module or a role prompt
// names a skill that is not in it.

const fs = require("node:fs");
const path = require("node:path");

const CATALOG_PATH = path.resolve(__dirname, "..", "skills", "catalog.json");
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The roster grows with the library. This bound keeps the block small relative
// to a role contract while leaving headroom; overflow degrades deterministically
// (role detail dropped, then categories dropped) instead of failing extension
// load, and every degraded block says so explicitly.
const MAX_PROMPT_CHARS = 16000;
const SKILL_AWARENESS_MARKER = "Harness skill awareness:";
const CITATION_RULE = "Work within those skills' declared discipline and acceptance gates, name in your findings any skill your task falls under, and ask the parent to pass a skill body when you need its exact procedure. Never cite a skill that is not in this list.";
const GOALS_OMITTED_NOTE = "Role-specific skill detail was omitted to keep this awareness block bounded; the skill names above are complete.";

// Skills whose declared discipline governs each registered role's work. Every
// name must exist in skills/catalog.json. Handler-only roles have no model and
// therefore no skill guidance.
const ROLE_SKILLS = Object.freeze({
  planner: ["implementation-plan", "requirements-to-roadmap", "technical-specification", "multi-agent-delegation"],
  researcher: ["evidence-led-research", "technical-documentation-investigation", "codebase-onboarding", "systematic-literature-review"],
  reviewer: ["code-review-evidence", "secure-code-review", "change-verify"],
  "patch-reviewer": ["code-review-evidence", "secure-code-review"],
  coder: ["test-driven-implementation", "build", "api-contract-engineering", "python-production-engineering", "cpp-modern-systems", "frontend-state-architecture", "safe-database-migrations", "git-checkpoint"],
  verifier: ["change-verify", "build", "test-driven-implementation"],
  refactorer: ["test-driven-implementation", "code-review-evidence", "build"],
  benchmark: ["performance-profiling", "experiment-design-analysis", "experiment-gate-lifecycle"],
  "evidence-auditor": ["evidence-led-research", "change-verify", "data-quality-audit"],
  integrator: ["git-checkpoint", "code-review-evidence"],
  "mathematical-researcher": ["quantitative-modeling", "evidence-led-research"],
  "reverse-engineer": ["secure-code-review", "codebase-onboarding", "dependency-supply-chain-security"],
  "3d-modeler": ["procedural-3d-blender", "3d-modeling-topology", "pbr-material-lookdev", "lighting-render-optimization"],
  "3d-critic": ["design-critique", "3d-modeling-topology"],
  "reliability-investigator": ["systematic-debugging", "durable-bug-hunt", "performance-profiling"],
  "code-profiler": ["performance-profiling", "observability-slo-design", "web-performance-core-vitals"],
  "security-reviewer": ["secure-code-review", "security-threat-model", "secrets-iam-hardening", "web-security-headers"],
});

let cached = null;

function buildCatalog(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("SKILL_CATALOG_EMPTY");
  const byName = new Map();
  for (const entry of entries) {
    const name = String(entry?.name || "");
    if (!NAME_PATTERN.test(name)) throw new Error(`SKILL_CATALOG_INVALID_NAME: ${name}`);
    if (byName.has(name)) throw new Error(`SKILL_CATALOG_DUPLICATE_NAME: ${name}`);
    byName.set(name, { name, category: String(entry?.category || "uncategorized"), goal: String(entry?.goal || "").trim() });
  }
  const categories = new Map();
  for (const skill of byName.values()) {
    if (!categories.has(skill.category)) categories.set(skill.category, []);
    categories.get(skill.category).push(skill.name);
  }
  for (const names of categories.values()) names.sort();
  return { byName, categories, names: [...byName.keys()].sort() };
}

function readCatalog(catalogPath = CATALOG_PATH) {
  return buildCatalog(JSON.parse(fs.readFileSync(catalogPath, "utf8")));
}

function loadCatalog() {
  if (!cached) cached = readCatalog();
  return cached;
}

function skillNames() { return [...loadCatalog().names]; }

function roleSkillNames(roleId) {
  const names = ROLE_SKILLS[String(roleId || "")] || [];
  const catalog = loadCatalog();
  for (const name of names) if (!catalog.byName.has(name)) throw new Error(`SKILL_AWARENESS_UNKNOWN_SKILL: ${name} for role ${roleId}`);
  return [...names];
}

function renderAwareness({ catalog, roleId, includeGoals, categories, omittedCategories = [] }) {
  const selected = categories || [...catalog.categories.keys()].sort();
  const lines = [
    `${SKILL_AWARENESS_MARKER} this harness ships a procedural skill library, but delegated role children run with skill discovery disabled, so you cannot load or invoke a skill body yourself.`,
    `Available skills (${catalog.names.length}), by category:`,
  ];
  for (const category of selected) lines.push(`- ${category}: ${catalog.categories.get(category).join(", ")}`);
  const relevant = roleSkillNames(roleId);
  if (includeGoals && relevant.length) {
    lines.push("Skills governing this role's work:");
    for (const name of relevant) {
      const skill = catalog.byName.get(name);
      lines.push(`- ${name} (${skill.category}): ${skill.goal}`);
    }
  }
  if (!includeGoals && relevant.length) lines.push(GOALS_OMITTED_NOTE);
  if (omittedCategories.length) {
    const shown = selected.reduce((total, category) => total + catalog.categories.get(category).length, 0);
    lines.push(`Roster truncated: ${shown} of ${catalog.names.length} skill names are listed; the omitted names are in skills/CATALOG.md (categories omitted: ${omittedCategories.join(", ")}).`);
  }
  lines.push(CITATION_RULE);
  return lines.join("\n");
}

function skillAwarenessPrompt({ roleId = null, maxChars = MAX_PROMPT_CHARS } = {}) {
  const catalog = loadCatalog();
  const full = renderAwareness({ catalog, roleId, includeGoals: true });
  if (full.length <= maxChars) return full;
  const namesOnly = renderAwareness({ catalog, roleId, includeGoals: false });
  if (namesOnly.length <= maxChars) return namesOnly;
  const categories = [...catalog.categories.keys()].sort();
  let minimal = null;
  for (let kept = categories.length - 1; kept >= 0; kept -= 1) {
    const text = renderAwareness({
      catalog,
      roleId,
      includeGoals: false,
      categories: categories.slice(0, kept),
      omittedCategories: categories.slice(kept),
    });
    if (kept === 0) minimal = text;
    if (text.length <= maxChars) return text;
  }
  throw new Error(`SKILL_AWARENESS_PROMPT_TOO_LARGE: ${minimal.length} > ${maxChars}`);
}

module.exports = {
  CATALOG_PATH,
  MAX_PROMPT_CHARS,
  SKILL_AWARENESS_MARKER,
  ROLE_SKILLS,
  buildCatalog,
  readCatalog,
  loadCatalog,
  skillNames,
  roleSkillNames,
  skillAwarenessPrompt,
};
