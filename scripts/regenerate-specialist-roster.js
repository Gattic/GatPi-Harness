#!/usr/bin/env node
"use strict";

// Regenerates the skills-side specialist roster from the authoritative role
// contracts. skills/tools/regenerate.py renders this file into every SKILL.md,
// and tests/skill-awareness.test.js fails when the checked-in file drifts.
const fs = require("node:fs");
const path = require("node:path");
const { renderSpecialistRoster } = require("../src/role-contracts");

const target = path.resolve(__dirname, "..", "skills", "specialists.json");
const text = renderSpecialistRoster();
const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
if (current === text) {
  process.stdout.write(`specialists roster unchanged: ${path.relative(process.cwd(), target)}\n`);
} else {
  fs.writeFileSync(target, text);
  process.stdout.write(`wrote ${path.relative(process.cwd(), target)}\n`);
}
