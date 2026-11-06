"use strict";

// Session mining (2026-07): in 549 mined git invocations there was exactly
// one commit - work accumulates in big uncommitted trees and gets batch
// committed later, by hand-chunking files into logical groups. This proposes
// those groups (source+test pairs, docs, scripts, config) with starter
// messages; the model refines messages and applies group by group.

const path = require("node:path");
const { spawnSync } = require("node:child_process");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 10_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${String(result.stderr || "").trim() || result.status}`);
  return String(result.stdout || "");
}

function isHarnessRuntimeState(file) {
  const normalized = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
  return (normalized === ".pi" || normalized.startsWith(".pi/")) && !normalized.startsWith(".pi/extensions/");
}

function changedFiles(cwd) {
  return git(cwd, ["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ state: line.slice(0, 2).trim(), file: line.slice(3).trim().replace(/^"|"$/g, "") }))
    // Project extension source is committable; other .pi paths are managed
    // harness/runtime state and must never be staged by this tool.
    .filter((entry) => !isHarnessRuntimeState(entry.file));
}

function stem(file) {
  return path.basename(file).replace(/\.(test|spec)\./, ".").replace(/\.[^.]+$/, "").toLowerCase();
}

function isDoc(file) {
  if (/(^|\/)CMakeLists\.txt$/.test(file)) return false; // build config, not docs
  return /\.(md|rst|txt)$/i.test(file) || file.startsWith("docs/");
}

function isTest(file) {
  return /(^|\/)(tests?|__tests__|spec)\//.test(file) || /\.(test|spec)\.[^.]+$/.test(file);
}

function isScript(file) {
  return /^scripts?\//.test(file) || /\.(sh|ps1)$/.test(file);
}

function isConfig(file) {
  return /^\./.test(path.basename(file)) || /\.(json|ya?ml|toml|ini)$/i.test(file) && !file.includes("/");
}

function groupChanges(entries) {
  const files = entries.map((entry) => entry.file);
  const used = new Set();
  const groups = [];

  // 1. Source files, each pulling in tests that share their stem.
  const sources = files.filter((file) => !isDoc(file) && !isScript(file) && !isConfig(file) && !isTest(file));
  if (sources.length) {
    const tests = files.filter((file) => isTest(file));
    const members = [...sources];
    for (const test of tests) if (sources.some((source) => stem(source) === stem(test))) members.push(test);
    members.forEach((file) => used.add(file));
    const topDirs = [...new Set(sources.map((file) => file.split("/")[0]))];
    groups.push({ title: `source changes (${topDirs.join(", ")})`, files: members, suggestedMessage: `Update ${topDirs.join(", ")}` });
  }

  // 2. Remaining tests (no matching source in this change set).
  const looseTests = files.filter((file) => isTest(file) && !used.has(file));
  if (looseTests.length) {
    looseTests.forEach((file) => used.add(file));
    groups.push({ title: "test-only changes", files: looseTests, suggestedMessage: "Update tests" });
  }

  // 3. Docs.
  const docs = files.filter((file) => isDoc(file) && !used.has(file));
  if (docs.length) {
    docs.forEach((file) => used.add(file));
    groups.push({ title: "documentation", files: docs, suggestedMessage: "Update documentation" });
  }

  // 4. Scripts and config, one group each.
  const scripts = files.filter((file) => isScript(file) && !used.has(file));
  if (scripts.length) {
    scripts.forEach((file) => used.add(file));
    groups.push({ title: "scripts", files: scripts, suggestedMessage: "Update scripts" });
  }
  const rest = files.filter((file) => !used.has(file));
  if (rest.length) groups.push({ title: "other changes", files: rest, suggestedMessage: "Update project files" });

  return groups;
}

function proposeCommitPlan(cwd = process.cwd()) {
  const entries = changedFiles(cwd);
  if (!entries.length) return { cwd, groups: [], guidance: "Working tree is clean; nothing to commit." };
  return { cwd, entries, groups: groupChanges(entries), guidance: null };
}

function applyCommitGroup(cwd, files, message) {
  if (!Array.isArray(files) || !files.length) throw new Error("applyCommitGroup requires a non-empty files list returned by operation=plan");
  if (!String(message || "").trim()) throw new Error("applyCommitGroup requires a refined commit message");
  const root = path.resolve(cwd);
  const normalized = [...new Set(files.map((file) => {
    const raw = String(file || "").replace(/^@/, "").trim();
    const absolute = path.resolve(root, raw);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    if (!raw || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`commit_plan file must stay inside the repository: ${raw || "<empty>"}`);
    if (isHarnessRuntimeState(relative)) throw new Error(`commit_plan refuses harness runtime state: ${relative}. Select files returned by operation=plan.`);
    return relative;
  }))];
  const available = new Set(changedFiles(root).map((entry) => entry.file));
  const invalid = normalized.filter((file) => !available.has(file));
  if (invalid.length) throw new Error(`commit_plan files are not current committable changes: ${invalid.join(", ")}. Run operation=plan again and apply exactly one returned group.`);
  git(root, ["add", "--", ...normalized]);
  git(root, ["commit", "-m", String(message).trim(), "--", ...normalized]);
  const head = git(root, ["log", "--oneline", "-1"]).trim();
  return { ok: true, head, files: normalized };
}

function formatCommitPlan(plan) {
  if (!plan.groups.length) return plan.guidance || "Nothing to commit.";
  return plan.groups
    .map((group, index) => `Group ${index + 1}: ${group.title}\n  message: ${group.suggestedMessage} (refine before applying)\n${group.files.map((file) => `  - ${file}`).join("\n")}`)
    .join("\n\n");
}

module.exports = { proposeCommitPlan, applyCommitGroup, formatCommitPlan, isHarnessRuntimeState };
