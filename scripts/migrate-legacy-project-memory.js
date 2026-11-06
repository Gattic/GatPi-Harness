"use strict";

// Explicit operator migration from the pre-schema `Memory/<project>/` vault
// layout into managed `Memory/Projects/<name>-<rootHash>/` notes.
//
// This is not a runtime capture path. It requires an explicit vault, an
// explicit project mapping and `--apply`; legacy notes are never modified or
// deleted. Transient git state (branch/HEAD/dirty/staged) is dropped because
// canonical durable notes must not pin volatile state; fix/regression commit
// references are preserved as structured evidence ids instead.

const fs = require("node:fs");
const path = require("node:path");
const { projectIdentity } = require("../src/project-identity");
const { ProjectMemoryStore } = require("../src/project-memory-store");
const { parseFrontmatter, normalizeCandidate, normalizeText, validateCandidate, forbiddenReasons, projectFolderName, sha256 } = require("../src/project-memory-schema");
const { classifyProjectMemoryCandidate, TRANSIENT_GIT } = require("../src/project-memory-policy");

const ENTRY_MAX_CHARS = 4000;
const KIND_RULES = [
  [/\b(?:guardrails?|invariants?|contract|decision rules?)\b/i, "constraint"],
  [/\b(?:risks?|todos?|caveat|deferred|claim boundar(?:y|ies)|product work)\b/i, "risk"],
  [/\b(?:final decision|no-go|rejected|mitigations?)\b/i, "decision"],
  [/\b(?:fix|prevention|procedure|build|verification areas|regression check|retained work|subsystem locations|evidence pointers?)\b/i, "procedure"],
  [/\b(?:symptom|root cause|evidence|completed results|what happened|diagnostic|bottleneck|objective)\b/i, "verification"],
  [/\b(?:current|repository state|modules|context)\b/i, "history"],
];
const TRANSIENT_LINE = /\b(?:branch|head|git|sha|commit|working tree|dirty|staged|unstaged|revision)\b|\b(?:main|master)\b[^\n]{0,12}\bat\b[^\n]{0,12}\b[0-9a-f]{7,40}\b/i;

function usage() {
  return "usage: node scripts/migrate-legacy-project-memory.js --vault=<vault> --project=<legacy-name>=<repo-path> [--project=...] [--apply]";
}

function parseArgs(argv) {
  const options = { vault: null, projects: [], apply: false };
  for (const arg of argv) {
    if (arg === "--apply") { options.apply = true; continue; }
    const vault = arg.match(/^--vault=(.+)$/); if (vault) { options.vault = vault[1]; continue; }
    const project = arg.match(/^--project=([^=]+)=(.+)$/); if (project) { options.projects.push({ name: project[1], path: project[2] }); continue; }
    throw new Error(`unknown argument: ${arg}\n${usage()}`);
  }
  if (!options.vault) throw new Error(`--vault is required\n${usage()}`);
  if (!options.projects.length) throw new Error(`at least one --project is required\n${usage()}`);
  return options;
}

function kindFor(heading, text) {
  for (const [pattern, kind] of KIND_RULES) if (pattern.test(heading)) return kind;
  if (/\bconclusion\b/i.test(heading)) return /\b(?:no-go|final decision)\b/i.test(text) ? "decision" : "verification";
  return "history";
}

function stripLeadingHeadings(body) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim() || /^#\s+/.test(line)) { index++; continue; }
    break;
  }
  return lines.slice(index).join("\n");
}

function sections(body) {
  const lines = String(body || "").split("\n");
  const rows = [];
  let heading = "Overview";
  let buffer = [];
  const flush = () => { const text = buffer.join("\n").trim(); if (text) rows.push({ heading, text }); };
  for (const line of lines) {
    const match = line.match(/^##\s+(.+)$/);
    if (match) { flush(); heading = match[1].trim(); buffer = []; continue; }
    buffer.push(line);
  }
  flush();
  return rows;
}

function dropTransient(value, dropped) {
  const kept = [];
  for (const line of String(value).split("\n")) {
    if (TRANSIENT_LINE.test(line)) { dropped.push(line.trim().slice(0, 120)); continue; }
    kept.push(line);
  }
  return normalizeText(kept.join("\n"));
}

// Only entries created by this migration (same legacy source fingerprint, still
// unverified and non-standing) may be refreshed in place. Anything else with a
// colliding title goes to the review queue instead of being overwritten.
function migrationOwned(existing, candidate) {
  const fingerprints = new Set(existing.sourceFingerprints || []);
  return (candidate.sourceFingerprints || []).some((fingerprint) => fingerprints.has(fingerprint))
    && existing.verification === "unverified"
    && existing.standing !== true
    && (existing.contradicts || []).length === 0;
}

function sanitize(text, { projectRoot }) {
  const evidenceIds = new Set();
  const dropped = [];
  const rewrites = [];
  let value = normalizeText(text);
  const escapedRoot = String(projectRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rootPattern = new RegExp(`${escapedRoot}(?=[/\\s\`'"(),;:]|$)`, "g");
  const beforeRoot = value; value = value.replace(rootPattern, "."); if (value !== beforeRoot) rewrites.push("repo-root-relative");
  if (/\/home\//.test(value)) { value = value.replace(/\/home\/[A-Za-z0-9._-]+/g, "$HOME"); rewrites.push("home-path-redacted"); }
  value = value.replace(/`([0-9a-f]{7,40})`/g, (match, sha) => { evidenceIds.add(`ref-${sha}`); return match; });
  value = value.replace(/\b((?:proof|evidence)_[a-f0-9]{8,})\b/g, (match, id) => { evidenceIds.add(id); return match; });
  if (/\b(?:Fix\s+)?[Cc]ommit\b/.test(value)) {
    value = value.replace(/\bFix\s+[Cc]ommit\b\s*:\s*/g, "Fix: ").replace(/\b[Cc]ommit\b\s*:\s*/g, "Change: ").replace(/\b[Cc]ommit\b\s+/g, "Change ");
    rewrites.push("commit-reference-kept-as-evidence");
  }
  if (/\bSHA-?256\b/.test(value)) { value = value.replace(/\bSHA-?256\b/g, "digest"); rewrites.push("digest-label"); }
  if (/\bhead-on\b/i.test(value)) { value = value.replace(/\bhead-on\b/gi, "front-facing"); rewrites.push("head-on-rewritten"); }
  value = dropTransient(value, dropped);
  value = normalizeText(value);
  if (TRANSIENT_GIT.test(value)) {
    // Defensive: the sentence filter above should already remove these.
    const sentences = value.split(/(?<=[.!?])\s+/).filter((sentence) => { if (TRANSIENT_GIT.test(sentence)) { dropped.push(sentence.trim().slice(0, 120)); return false; } return true; });
    value = normalizeText(sentences.join(" "));
    rewrites.push("transient-sentence-dropped");
  }
  const issues = forbiddenReasons(value);
  return { text: value, evidenceIds: [...evidenceIds].sort(), dropped, rewrites, issues };
}

function chunk(text, maxChars = ENTRY_MAX_CHARS) {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= maxChars) { current = next; continue; }
    if (current) chunks.push(current);
    if (paragraph.length <= maxChars) { current = paragraph; continue; }
    for (let index = 0; index < paragraph.length; index += maxChars) chunks.push(paragraph.slice(index, index + maxChars));
    current = "";
  }
  if (current) chunks.push(current);
  return chunks;
}

function legacyNotes(legacyDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "Projects" || entry.name === "Reviews") continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(legacyDir);
  return files.sort();
}

function planProject({ vault, project, apply, now }) {
  const identity = projectIdentity(project.path);
  if (identity.name !== project.name) throw new Error(`project name ${project.name} does not match repository basename ${identity.name}`);
  const legacyDir = path.join(vault, "Memory", project.name);
  const managedDir = path.join(vault, "Memory", "Projects", projectFolderName(identity));
  const store = new ProjectMemoryStore({ cwd: project.path, vault, writeEnabled: apply, clock: () => now });
  const report = { projectKey: identity.projectKey, projectFolder: projectFolderName(identity), repoRoot: identity.root, legacyDir, managedDir, notes: [], totals: { notes: 0, planned: 0, saved: 0, deduped: 0, superseded: 0, rejected: 0, reviewQueued: 0, skipped: 0, droppedTransient: 0 } };
  if (!fs.existsSync(legacyDir)) { report.status = "no-legacy-layout"; return report; }
  report.status = "migrated";
  const usedTitles = new Set();
  for (const file of legacyNotes(legacyDir)) {
    const relative = path.relative(legacyDir, file).replace(/\\/g, "/");
    const raw = fs.readFileSync(file, "utf8");
    const parsed = parseFrontmatter(raw);
    if (String(parsed.fields.memory_schema) === "1") continue;
    const noteTitle = String(parsed.fields.title || (parsed.body.match(/^#\s+(.+)$/m) || [])[1] || path.basename(file, ".md")).trim();
    const updatedAt = String(parsed.fields.updated || parsed.fields.created || fs.statSync(file).mtime.toISOString());
    const body = stripLeadingHeadings(parsed.body);
    const noteReport = { path: relative, sha256: sha256(raw), title: noteTitle, updatedAt, entries: [], skipped: [] };
    report.totals.notes++;
    for (const section of sections(body)) {
      const sanitized = sanitize(section.text, { projectRoot: identity.root });
      if (!sanitized.text) { report.totals.skipped++; noteReport.skipped.push({ heading: section.heading, reason: "empty-after-sanitize" }); continue; }
      if (sanitized.issues.length) { report.totals.skipped++; noteReport.skipped.push({ heading: section.heading, reason: `blocked:${sanitized.issues.join(",")}` }); continue; }
      const kind = kindFor(section.heading, sanitized.text);
      const parts = chunk(sanitized.text);
      const droppedTransient = sanitized.dropped.length;
      report.totals.droppedTransient += droppedTransient;
      parts.forEach((content, index) => {
        const baseTitle = `${noteTitle} — ${section.heading}${parts.length > 1 ? ` (${index + 1}/${parts.length})` : ""}`.slice(0, 160);
        let title = baseTitle; let suffix = 2;
        while (usedTitles.has(`${kind}\n${title}`)) title = `${baseTitle.slice(0, 150)} (${suffix++})`;
        usedTitles.add(`${kind}\n${title}`);
        const candidate = normalizeCandidate({ kind, title, content, verification: "unverified", updatedAt, sourceFingerprints: [`legacy-note-${sha256(relative).slice(0, 16)}`], evidenceIds: sanitized.evidenceIds });
        const validation = validateCandidate(candidate);
        const policy = classifyProjectMemoryCandidate(candidate, { explicit: true });
        const candidateHash = `sha256:${candidate.candidateHash}`;
        let outcome;
        if (!validation.ok) outcome = `rejected:${validation.issues[0]}`;
        else if (policy.action === "reject") outcome = `rejected:${policy.reason}`;
        else {
          const existing = store.readKind(kind).entries;
          const duplicate = existing.find((entry) => entry.candidateHash === candidate.candidateHash);
          const sameTitle = existing.find((entry) => entry.titleHash === candidate.titleHash);
          if (duplicate) outcome = "deduped";
          else if (sameTitle) outcome = migrationOwned(sameTitle, candidate) ? "supersede" : "review-queued";
          else outcome = "save";
        }
        let result = null;
        if (apply && outcome === "save") result = store.upsert(candidate, { explicit: true, apply: true });
        else if (apply && outcome === "supersede") result = store.upsert(candidate, { explicit: true, apply: true, forceSupersede: true });
        else if (apply && outcome === "review-queued") result = store.upsert(candidate, { explicit: true, apply: true });
        if (result) outcome = result.outcome === "saved-labeled" ? "saved" : result.outcome;
        if (outcome === "saved") report.totals.saved++;
        else if (outcome === "deduped") report.totals.deduped++;
        else if (outcome === "superseded" || outcome === "supersede") report.totals.superseded++;
        else if (outcome === "review-queued") report.totals.reviewQueued++;
        else if (String(outcome).startsWith("rejected")) report.totals.rejected++;
        report.totals.planned++;
        noteReport.entries.push({ heading: section.heading, title, kind, outcome, candidateHash, evidenceIds: sanitized.evidenceIds, rewrites: sanitized.rewrites, droppedTransient: index === 0 ? droppedTransient : 0, applied: Boolean(result?.applied) });
      });
    }
    report.notes.push(noteReport);
  }
  return report;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const vault = path.resolve(options.vault);
  if (!fs.existsSync(vault)) throw new Error(`vault does not exist: ${vault}`);
  const now = new Date();
  const reports = [];
  for (const project of options.projects) {
    const resolved = path.resolve(project.path);
    if (!fs.existsSync(resolved)) throw new Error(`project path does not exist: ${resolved}`);
    reports.push(planProject({ vault, project: { ...project, path: resolved }, apply: options.apply, now }));
  }
  const output = { schemaVersion: 1, generatedAt: now.toISOString(), vault, apply: options.apply, projects: reports };
  if (options.apply) {
    for (const report of reports) {
      const stateDir = path.join(report.repoRoot, ".pi", "project-memory");
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(stateDir, 0o700);
      const reportPath = path.join(stateDir, "legacy-migration-report.json");
      fs.writeFileSync(reportPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(reportPath, 0o600);
    }
  }
  for (const report of reports) {
    console.log(`${report.projectKey} ${report.status} legacy=${path.relative(vault, report.legacyDir)} managed=${path.relative(vault, report.managedDir)} notes=${report.totals.notes} entries=${report.totals.planned} saved=${report.totals.saved} deduped=${report.totals.deduped} superseded=${report.totals.superseded} rejected=${report.totals.rejected} skipped=${report.totals.skipped} review=${report.totals.reviewQueued} droppedTransient=${report.totals.droppedTransient}`);
    for (const note of report.notes) for (const entry of note.entries) console.log(`  ${entry.outcome.padEnd(12)} ${entry.kind.padEnd(12)} ${entry.title}`);
  }
  console.log(options.apply ? "applied" : "dry-run (no writes; pass --apply to migrate)");
}

if (require.main === module) main();
module.exports = { sanitize, sections, kindFor, chunk, planProject };
