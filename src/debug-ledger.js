"use strict";

// Session mining (2026-07): the single worst human friction across Claude
// Code and Codex history is the non-converging visual/behavior bug loop -
// "The issue still persists" appeared 40x recently (148x historically, the
// same message 9x in one day), with failed knob toggles retried across
// sessions because nothing durable recorded what was already attempted.
// This ledger keeps one thread per bug: hypothesis -> change -> observation
// -> verdict, so sessions stop retrying known-dead ends.

const fs = require("node:fs");
const path = require("node:path");
const { sanitizeManagedStateValue } = require("./managed-state-sanitizer");

const STATE_DIR = ".pi/debug-ledger";
const MAX_SUMMARY_THREADS = 10;
const MAX_SUMMARY_ATTEMPTS = 6;

function ledgerDir(cwd) {
  return path.join(cwd, STATE_DIR);
}

function slugify(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 5)
    .join("-") || "bug";
}

function threadFile(cwd, threadId) {
  return path.join(ledgerDir(cwd), `${threadId}.json`);
}

function readThread(cwd, threadId) {
  try {
    return JSON.parse(fs.readFileSync(threadFile(cwd, threadId), "utf8"));
  } catch {
    return null;
  }
}

function writeThread(cwd, thread) {
  fs.mkdirSync(ledgerDir(cwd), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(ledgerDir(cwd), 0o700); } catch {}
  const sanitized = sanitizeManagedStateValue({ ...thread, updatedAt: new Date().toISOString() });
  fs.writeFileSync(threadFile(cwd, sanitized.threadId), `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(threadFile(cwd, sanitized.threadId), 0o600); } catch {}
  return sanitized;
}

function openThread(cwd, title) {
  const threadId = slugify(title);
  const existing = readThread(cwd, threadId);
  if (existing) return { ...existing, duplicate: true };
  return writeThread(cwd, {
    threadId,
    title: String(title || "").trim(),
    status: "open",
    createdAt: new Date().toISOString(),
    attempts: [],
    resolution: null,
  });
}

function requireThread(cwd, threadId) {
  const thread = readThread(cwd, String(threadId || "").trim());
  if (!thread) throw new Error(`debug thread not found: ${threadId}. Use listThreads/debug-list to see ids.`);
  return thread;
}

function recordAttempt(cwd, threadId, attempt = {}) {
  const thread = requireThread(cwd, threadId);
  thread.attempts.push({
    at: new Date().toISOString(),
    hypothesis: attempt.hypothesis || null,
    change: attempt.change || null,
    observation: attempt.observation || null,
    verdict: ["fixed", "partial", "no-change", "worse"].includes(attempt.verdict) ? attempt.verdict : "unverified",
    evidence: Array.isArray(attempt.evidence) ? attempt.evidence : attempt.evidence ? [String(attempt.evidence)] : [],
    fixRecallId: /^fix_recall_[a-z0-9_]+$/.test(String(attempt.recallId || attempt.fixRecallId || "")) ? String(attempt.recallId || attempt.fixRecallId) : null,
  });
  return writeThread(cwd, thread);
}

function linkExperiment(cwd, threadId, experimentId) {
  const thread = requireThread(cwd, threadId);
  const id = String(experimentId || "").trim();
  if (!/^exp-[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(id)) throw new Error(`invalid experiment id: ${experimentId}`);
  thread.experimentIds = Array.from(new Set([...(Array.isArray(thread.experimentIds) ? thread.experimentIds : []), id]));
  return writeThread(cwd, thread);
}

function resolveThread(cwd, threadId, note = "") {
  const thread = requireThread(cwd, threadId);
  thread.status = "resolved";
  thread.resolution = { at: new Date().toISOString(), note: String(note || "").trim() || null };
  return writeThread(cwd, thread);
}

function listThreads(cwd, options = {}) {
  let names = [];
  try {
    names = fs.readdirSync(ledgerDir(cwd)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const threads = names.map((name) => readThread(cwd, name.replace(/\.json$/, ""))).filter(Boolean);
  const filtered = options.status ? threads.filter((thread) => thread.status === options.status) : threads;
  return filtered.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function showThread(cwd, threadId) {
  return requireThread(cwd, threadId);
}

function listThreadSummaries(cwd, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 25));
  return listThreads(cwd, options).slice(0, limit).map((thread) => {
    const lastAttempt = thread.attempts.at(-1) || null;
    const verdictCounts = Object.fromEntries(["fixed", "partial", "no-change", "worse", "unverified"].map((verdict) => [verdict, thread.attempts.filter((attempt) => attempt.verdict === verdict).length]));
    return {
      threadId: thread.threadId,
      status: thread.status,
      createdAt: thread.createdAt || null,
      updatedAt: thread.updatedAt || null,
      attemptCount: thread.attempts.length,
      verdictCounts,
      lastAttempt: lastAttempt ? { at: lastAttempt.at || null, verdict: lastAttempt.verdict || "unverified", evidenceCount: Array.isArray(lastAttempt.evidence) ? lastAttempt.evidence.length : 0, fixRecallId: lastAttempt.fixRecallId || null } : null,
      resolvedAt: thread.resolution?.at || null,
    };
  });
}

function formatAttempt(attempt, index) {
  const parts = [
    `#${index + 1} [${attempt.verdict}]`,
    attempt.hypothesis ? `hypothesis: ${attempt.hypothesis}` : null,
    attempt.change ? `change: ${attempt.change}` : null,
    attempt.observation ? `observed: ${attempt.observation}` : null,
    attempt.evidence?.length ? `evidence: ${attempt.evidence.join(", ")}` : null,
    attempt.fixRecallId ? `fix recall: ${attempt.fixRecallId}` : null,
  ].filter(Boolean);
  return parts.join(" | ");
}

function formatThread(thread) {
  const lines = [`Debug thread ${thread.threadId} [${thread.status}]: ${thread.title}`];
  for (const [index, attempt] of thread.attempts.entries()) lines.push(formatAttempt(attempt, index));
  if (!thread.attempts.length) lines.push("(no attempts recorded yet)");
  if (thread.resolution?.note) lines.push(`resolved: ${thread.resolution.note}`);
  return lines.join("\n");
}

function openThreadsSummary(cwd) {
  const allOpen = listThreads(cwd, { status: "open" });
  if (!allOpen.length) return "";
  const open = allOpen.slice(0, MAX_SUMMARY_THREADS);
  const lines = ["Open debug threads (do not retry changes already tried; record new attempts with debug_ledger - if it is not in your tool list, activate it with activate_tools or use /debug-attempt):"];
  for (const thread of open) {
    lines.push(`- ${thread.threadId}: ${thread.title} (${thread.attempts.length} attempts)`);
    const tried = thread.attempts.filter((attempt) => attempt.change && attempt.verdict !== "fixed").slice(-MAX_SUMMARY_ATTEMPTS);
    if (tried.length) lines.push(`  already tried: ${tried.map((attempt) => `${attempt.change} (${attempt.verdict})`).join("; ")}`);
  }
  if (allOpen.length > MAX_SUMMARY_THREADS) lines.push(`(+${allOpen.length - MAX_SUMMARY_THREADS} more open threads: use debug-list with status=open)`);
  return lines.join("\n");
}

module.exports = { openThread, recordAttempt, linkExperiment, resolveThread, listThreads, listThreadSummaries, showThread, formatThread, openThreadsSummary, STATE_DIR };
