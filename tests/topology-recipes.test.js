"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { recipes, listInstalled, recommendRecipes, installRecipe, lintRecipes, recipeSummary, upgradePreview } = require("../src/topology-recipes.js");
const { tmpFixture } = require("./helpers/tmp-fixture");

const tmp = tmpFixture("topology-recipes-");
assert(recipes().length > 5);
assert(!recommendRecipes("review code").some((recipe) => recipe.metadata?.explicitOnly === true));
assert.equal(recommendRecipes("debug a bug")[0].topologyId, "bug-investigation");
assert.throws(() => installRecipe(tmp, "missing-recipe"), /Available recipes/);
const installed = installRecipe(tmp, "bug-investigation");
assert.equal(installed.topologyId, "bug-investigation");
assert(fs.existsSync(path.join(tmp, installed.file)));
assert.deepEqual(listInstalled(tmp)[0].topologies, ["bug-investigation"]);
assert.equal(lintRecipes(tmp).ok, true);
assert(recipeSummary(tmp).recipes.some((recipe) => recipe.topologyId === "bug-investigation"));
assert.equal(upgradePreview(tmp).preview, true);
console.log("topology recipe tests passed");
