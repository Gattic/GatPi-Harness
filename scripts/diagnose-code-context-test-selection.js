#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { moduleKeys, lexicalRelationship } = require("../src/change-impact.js");

const ROOT = path.resolve(__dirname, "..");
function legacyStem(file) { return path.basename(file).replace(/\.(?:test|spec)?\.[^.]+$/, "").replace(/^test_/, "").replace(/_test$/, "").replace(/[^A-Za-z0-9]+/g, "").toLowerCase(); }
function local(file) { const absolute = path.resolve(ROOT, file); const relative = path.relative(ROOT, absolute); if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`path must stay inside repository: ${file}`); return absolute; }
function atomicJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temporary, file); }
function parseArgs(argv) { const out = { corpus: ".pi/code-context/benchmarks/history-corpus-candidates.json", results: ".pi/code-context/benchmarks/test-selection-runs.json", output: ".pi/code-context/benchmarks/test-selection-failure-taxonomy.json" }; for (let index = 0; index < argv.length; index += 1) { const arg = argv[index]; const next = () => argv[++index]; if (arg === "--corpus") out.corpus = next(); else if (arg.startsWith("--corpus=")) out.corpus = arg.slice(9); else if (arg === "--results") out.results = next(); else if (arg.startsWith("--results=")) out.results = arg.slice(10); else if (arg === "--output") out.output = next(); else if (arg.startsWith("--output=")) out.output = arg.slice(9); else if (arg === "--help" || arg === "-h") out.help = true; else throw new Error(`unknown argument: ${arg}`); } return out; }
function classifyTask(task, row, readText = () => "") {
  const relationships = [];
  for (const source of task.gold?.sourceFiles || []) for (const test of task.gold?.testFiles || []) {
    const relationship = lexicalRelationship(source, test, readText(task.goldRevision, test));
    if (relationship) relationships.push({ source, test, relation: relationship.relation });
  }
  const recoverableTests = new Set(relationships.map((item) => item.test));
  const goldTests = task.gold?.testFiles || [];
  const legacyDefectPairs = relationships.filter((item) => item.relation === "module-name" && legacyStem(item.source) !== legacyStem(item.test));
  const edgeCount = Number(row?.provenance?.mustRun || 0) + Number(row?.provenance?.highConfidence || 0) + Number(row?.provenance?.graphOnly || 0);
  const categories = [];
  if (!(row?.selectedTests || []).length) categories.push("no-selected-tests");
  if (edgeCount === 0) categories.push("no-candidate-edges");
  if (Number(row?.provenance?.graphOnly || 0) === 0) categories.push("no-codegraph-test-edges");
  if (legacyDefectPairs.length) categories.push("stem-normalization-defect");
  if (recoverableTests.size) categories.push("bounded-lexical-recoverable");
  if (recoverableTests.size < goldTests.length) categories.push("relationship-coverage-gap");
  return { taskId: task.taskId, revision: task.goldRevision, categories, goldTestCount: goldTests.length, selectedTestCount: row?.selectedTests?.length || 0, candidateEdgeCount: edgeCount, recoverableGoldTests: recoverableTests.size, uncoveredGoldTests: goldTests.filter((test) => !recoverableTests.has(test)), relationships: relationships.map((item) => item.relation).sort() };
}
function buildTaxonomy(corpus, results, readText) {
  const tasks = new Map((corpus.tasks || []).map((task) => [task.taskId, task]));
  const rows = (results.testSelectionRuns || []).map((row) => { const task = tasks.get(row.taskId); if (!task) throw new Error(`result task missing from corpus: ${row.taskId}`); return classifyTask(task, row, readText); });
  const categoryTasks = {}; for (const row of rows) for (const category of row.categories) categoryTasks[category] = (categoryTasks[category] || 0) + 1;
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), tasks: rows.length, goldTests: rows.reduce((sum, row) => sum + row.goldTestCount, 0), recoverableGoldTests: rows.reduce((sum, row) => sum + row.recoverableGoldTests, 0), categoryTasks, rows };
}
function gitText(revision, file) { try { return execFileSync("git", ["show", `${revision}:${file}`], { cwd: ROOT, encoding: "utf8", timeout: 5000, maxBuffer: 512 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } }
function main() { const options = parseArgs(process.argv.slice(2)); if (options.help) { console.log("usage: node scripts/diagnose-code-context-test-selection.js [--corpus FILE] [--results FILE] [--output FILE]"); return; } const report = buildTaxonomy(JSON.parse(fs.readFileSync(local(options.corpus), "utf8")), JSON.parse(fs.readFileSync(local(options.results), "utf8")), gitText); atomicJson(local(options.output), report); console.log(JSON.stringify({ tasks: report.tasks, goldTests: report.goldTests, recoverableGoldTests: report.recoverableGoldTests, categoryTasks: report.categoryTasks })); }
if (require.main === module) { try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; } }
module.exports = { legacyStem, parseArgs, classifyTask, buildTaxonomy };
