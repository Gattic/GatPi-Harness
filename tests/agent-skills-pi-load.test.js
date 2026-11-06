"use strict";

// Loads every managed catalog skill with Pi's own skill loader. Pi parses the
// frontmatter as YAML and skips a skill whose header does not parse, so a
// description with an unquoted ": " (as an early edit of handoff had) silently
// removes the skill. The line-based checks in generic-agent-skills.test.js
// cannot see that.

const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let piPackageRoot;
try {
  const candidate = path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
  if (fs.existsSync(candidate)) piPackageRoot = fs.realpathSync(candidate);
} catch {}
if (!piPackageRoot) {
  console.log("agent skills Pi load tests skipped (global pi install not found)");
  process.exit(0);
}

(async () => {
  const { loadSkillsFromDir } = await import(pathToFileURL(path.join(piPackageRoot, "dist", "index.js")).href);
  const catalog = path.resolve(__dirname, "..", "skills", "skills");
  const names = fs.readFileSync(path.join(catalog, "managed-skills.txt"), "utf8").split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#"));
  assert.ok(names.length > 0, "the managed catalog is not empty");
  for (const name of names) {
    const { skills, diagnostics } = loadSkillsFromDir({ dir: path.join(catalog, name), source: "test" });
    assert.deepEqual(diagnostics.map((row) => row.message), [], `${name} loads without diagnostics`);
    assert.deepEqual(skills.map((skill) => skill.name), [name], `${name} loads as exactly one skill`);
    assert.ok(skills[0].description.length > 20, `${name} keeps its description`);
  }
  console.log(`agent skills Pi load tests passed (${names.length} skills)`);
})().catch((error) => { console.error(error); process.exit(1); });
