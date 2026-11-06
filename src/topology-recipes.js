"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readJson, writeJson } = require("./pi-extension-kit.js");
const { listBuiltInRoleTopologies, validateRoleAwareTopology } = require("./role-topologies.js");

const RECIPE_DIR = path.join(".pi", "topologies");

function recipes() {
  return listBuiltInRoleTopologies();
}

function listInstalled(cwd = process.cwd()) {
  const directory = path.join(cwd, RECIPE_DIR);
  try {
    return fs.readdirSync(directory)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => ({
        file: path.join(RECIPE_DIR, file).replace(/\\/g, "/"),
        topologies: (readJson(path.join(directory, file), {}).topologies || [])
          .map((topology) => topology?.topologyId)
          .filter(Boolean),
      }));
  } catch {
    return [];
  }
}

function recommendRecipes(task = "") {
  const query = String(task).toLowerCase();
  return recipes()
    .filter((recipe) => recipe.metadata?.explicitOnly !== true && recipe.metadata?.autoRoutePolicy !== "never")
    .map((recipe) => {
      const tags = recipe.tags || [];
      const score = tags.reduce((total, tag) => total + (query.includes(String(tag).toLowerCase()) ? 2 : 0), 0)
        + (query.includes("bug") && recipe.topologyId === "bug-investigation" ? 4 : 0)
        + (query.includes("doc") && recipe.topologyId === "docs-update" ? 4 : 0)
        + (query.includes("security") && recipe.topologyId === "security-review" ? 4 : 0)
        + (query.includes("refactor") && recipe.topologyId === "refactor-with-safety-net" ? 4 : 0)
        + (query.includes("dependency") && recipe.topologyId === "dependency-upgrade" ? 4 : 0)
        + (query.includes("ci") && recipe.topologyId === "failing-ci-triage" ? 4 : 0)
        + ((query.includes("perf") || query.includes("latency")) && recipe.topologyId === "performance-regression" ? 4 : 0)
        + (query.includes("release") && recipe.topologyId === "release-prep" ? 4 : 0);
      return { ...recipe, score };
    })
    .sort((left, right) => right.score - left.score || left.topologyId.localeCompare(right.topologyId));
}

function installRecipe(cwd, topologyId) {
  const recipe = recipes().find((item) => item.topologyId === topologyId);
  if (!recipe) {
    const available = recipes().map((item) => item.topologyId).sort();
    throw new Error(`Unknown topology recipe '${topologyId}'. Available recipes: ${available.join(", ")}.`);
  }
  const validation = validateRoleAwareTopology(recipe);
  if (!validation.ok) throw new Error(`Invalid built-in topology ${topologyId}: ${validation.issues.join("; ")}`);
  const file = path.join(cwd, RECIPE_DIR, `${topologyId}.json`);
  writeJson(file, { topologies: [recipe] });
  return { file: path.relative(cwd, file).replace(/\\/g, "/"), topologyId, provenance: recipe.metadata?.provenance || null };
}

function lintRecipes(cwd = process.cwd()) {
  const issues = [];
  for (const item of listInstalled(cwd)) {
    const parsed = readJson(path.join(cwd, item.file), {});
    const topologies = Array.isArray(parsed.topologies) ? parsed.topologies : [];
    if (!Array.isArray(parsed.topologies)) issues.push({ file: item.file, issue: "topologies must be an array" });
    for (const topology of topologies) {
      const validation = validateRoleAwareTopology(topology);
      for (const issue of validation.issues) issues.push({ file: item.file, topologyId: topology?.topologyId || null, issue });
    }
  }
  for (const recipe of recipes()) {
    for (const issue of validateRoleAwareTopology(recipe).issues) issues.push({ topologyId: recipe.topologyId, issue });
  }
  return { ok: issues.length === 0, issues, installed: listInstalled(cwd), builtInCount: recipes().length };
}

function recipeSummary(cwd = process.cwd()) {
  return {
    recipes: recipes().map(({ topologyId, name, description, tags, metadata }) => ({
      topologyId,
      name,
      description,
      tags: tags || [],
      provenance: metadata?.provenance || null,
    })),
    installed: listInstalled(cwd),
  };
}

function upgradePreview(cwd = process.cwd()) {
  return { preview: true, installed: listInstalled(cwd), available: recipes().map((recipe) => recipe.topologyId).sort() };
}

module.exports = {
  RECIPE_DIR,
  recipes,
  listInstalled,
  recommendRecipes,
  installRecipe,
  lintRecipes,
  recipeSummary,
  upgradePreview,
};
