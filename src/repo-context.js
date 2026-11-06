"use strict";

// Session mining (2026-07): every session re-ran the same opening ritual by
// hand — git status x180, git diff x290, re-reading CLAUDE.md x75 and skill
// files x137 across the Codex corpus, with the same shape in Claude sessions.
// This builds that opening context once, locally and fast, for injection at
// session start in any repo.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const GIT_TIMEOUT_MS = 3000;
const DOC_FILES = ["CLAUDE.md", "AGENTS.md", "README.md"];
const DOC_DIGEST_LINES = 12;
const MAX_CHANGED_FILES = 15;
const MAX_COMMITS = 5;

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: GIT_TIMEOUT_MS });
  return result.status === 0 ? String(result.stdout || "").trim() : null;
}

function docsDigest(cwd) {
  const docs = [];
  for (const file of DOC_FILES) {
    try {
      const text = fs.readFileSync(path.join(cwd, file), "utf8");
      const digest = text.split("\n").slice(0, DOC_DIGEST_LINES).join("\n").trim();
      if (digest) docs.push({ file, digest });
    } catch {}
    if (docs.length >= 2) break;
  }
  return docs;
}

function topLevelLayout(cwd) {
  try {
    return fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => entry.name)
      .slice(0, 12);
  } catch {
    return [];
  }
}

function buildRepoContext(cwd = process.cwd()) {
  const isGit = git(cwd, ["rev-parse", "--git-dir"]) != null;
  // symbolic-ref resolves unborn branches (fresh init, no commits) too.
  const branchName = isGit ? git(cwd, ["symbolic-ref", "--short", "HEAD"]) || git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) : null;
  const branch = isGit ? (!branchName || branchName === "HEAD" ? "(detached)" : branchName) : null;
  const status = isGit ? git(cwd, ["status", "--short"]) || "" : "";
  const changedRows = status.split("\n").filter(Boolean);
  const changed = changedRows.slice(0, MAX_CHANGED_FILES);
  const totalChanged = changedRows.length;
  const recentCommits = isGit ? (git(cwd, ["log", "--oneline", `-${MAX_COMMITS}`]) || "").split("\n").filter(Boolean) : [];
  return {
    generatedAt: new Date().toISOString(),
    cwd,
    git: { isGit, branch: branch || "", changed, totalChanged, shownChanged: changed.length, truncated: changed.length < totalChanged, recentCommits },
    docs: docsDigest(cwd),
    layout: topLevelLayout(cwd),
  };
}

function formatRepoContext(ctx) {
  const lines = [`Repo context (${ctx.cwd})`];
  if (ctx.git.isGit) {
    const totalChanged = Number.isInteger(ctx.git.totalChanged) ? ctx.git.totalChanged : ctx.git.changed.length;
    const shownChanged = Number.isInteger(ctx.git.shownChanged) ? ctx.git.shownChanged : ctx.git.changed.length;
    const changeSummary = totalChanged ? `${totalChanged} changed${shownChanged < totalChanged ? ` (showing ${shownChanged})` : ""}` : "clean";
    lines.push(`branch: ${ctx.git.branch}; working tree: ${changeSummary}`);
    if (ctx.git.changed.length) lines.push(...ctx.git.changed.map((line) => `  ${line}`));
    if (ctx.git.recentCommits.length) lines.push("recent commits:", ...ctx.git.recentCommits.map((line) => `  ${line}`));
  } else {
    lines.push("not a git repo");
  }
  if (ctx.layout.length) lines.push(`top-level dirs: ${ctx.layout.join(", ")}`);
  for (const doc of ctx.docs) lines.push(`--- ${doc.file} (head) ---`, doc.digest);
  const text = lines.join("\n");
  return text.length > 3800 ? `${text.slice(0, 3800)}\n[...trimmed...]` : text;
}

module.exports = { buildRepoContext, formatRepoContext };
