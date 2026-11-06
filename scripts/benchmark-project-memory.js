#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ProjectMemoryIndex } = require("../src/project-memory-index");
const { ProjectMemoryRecall, formatProjectMemoryContext } = require("../src/project-memory-recall");
const { percentile } = require("../src/memory-effectiveness");
const { dedupeInjectedContext } = require("../src/reasoning-injection");

const now = Date.now();
const entries = Array.from({ length: 10_000 }, (_, index) => ({ id: index === 7777 ? "prior-memory-audit" : `synthetic-${index}`, kind: index === 7777 ? "decision" : "history", title: index === 7777 ? "Session memory Obsidian effectiveness audit" : `Synthetic bounded note ${index}`, content: index === 7777 ? "Prior investigation of canonical memory, recall precision, Privacy Guard, and cognitive retention." : "Synthetic non-sensitive fixture content.", verification: index === 7777 ? "verified" : "inferred", updatedAt: new Date(now - index * 1000).toISOString(), source: { note: index === 7777 ? "Memory/Projects/fixture/Decisions.md" : `synthetic/${index}.md` } }));
const scaleIndex = new ProjectMemoryIndex({ entries, now: () => now }); const scaleDurations = []; let scaleRanked;
for (let run = 0; run < 50; run++) { scaleRanked = scaleIndex.search("session memory Obsidian effectiveness", { limit: 5 }); scaleDurations.push(scaleRanked.durationMs); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-prompt-benchmark-"));
let promptResult; const promptDurations = [];
try {
  execFileSync("git", ["init", "-q"], { cwd: tmp, stdio: "ignore" }); fs.writeFileSync(path.join(tmp, "README.md"), "benchmark fixture\n"); execFileSync("git", ["add", "README.md"], { cwd: tmp, stdio: "ignore" }); execFileSync("git", ["-c", "user.name=Pi Benchmark", "-c", "user.email=benchmark@example.invalid", "commit", "-qm", "fixture"], { cwd: tmp, stdio: "ignore" });
  const stateDir = path.join(tmp, ".pi", "project-memory"); const sourceDecisionId = "memdec_benchmark"; const relevant = entries.find((entry) => entry.id === "prior-memory-audit"); const cacheEntries = [relevant, ...entries.filter((entry) => entry.id !== relevant.id).slice(0, 99)];
  const store = {
    identity: { projectKey: "pi:benchmark:fixture" },
    decisions: { status: () => ({ lastSuccessful: { decisionId: sourceDecisionId } }) },
    list: () => cacheEntries,
    status: () => ({ kinds: Object.fromEntries(["decision", "history"].map((kind) => [kind, { exists: true, integrity: { ok: true }, revision: `benchmark-${kind}-revision` }])) }),
  };
  const recaller = new ProjectMemoryRecall({ cwd: tmp, store, stateDir, now: () => now });
  recaller.compile({ apply: true });
  for (let warmup = 0; warmup < 5; warmup++) recaller.recall("session memory Obsidian effectiveness", { limit: 5, cacheOnly: true });
  for (let run = 0; run < 50; run++) { const started = process.hrtime.bigint(); promptResult = recaller.recall("session memory Obsidian effectiveness", { limit: 5, cacheOnly: true }); promptDurations.push(Number(process.hrtime.bigint() - started) / 1e6); }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
const first = formatProjectMemoryContext(promptResult, { maxChars: 2500 }); const unchanged = dedupeInjectedContext(undefined, first, { maxChars: 2500 }); const repeated = dedupeInjectedContext(first, first, { maxChars: 2500 }); const changed = dedupeInjectedContext(first, `${first}\n- Changed reviewed risk`, { maxChars: 2500 });
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  fixture: { canonicalNotes: entries.length, compiledCacheNotes: 100, syntheticOnly: true },
  recall: { scope: "full-prompt-path-cache-read-git-ranking-format", samples: promptDurations.length, p50Ms: percentile(promptDurations, 0.5), p95Ms: percentile(promptDurations, 0.95), p99Ms: percentile(promptDurations, 0.99), topIds: promptResult.items.map((item) => item.id), priorAuditTop3: promptResult.items.slice(0, 3).some((item) => item.id === "prior-memory-audit") },
  scaleRanking: { scope: "10k-entry-deterministic-ranking", samples: scaleDurations.length, p50Ms: percentile(scaleDurations, 0.5), p95Ms: percentile(scaleDurations, 0.95), p99Ms: percentile(scaleDurations, 0.99), priorAuditTop3: scaleRanked.items.slice(0, 3).some((item) => item.id === "prior-memory-audit") },
  injection: { firstChars: unchanged.inject?.length || 0, unchangedFollowupChars: repeated.inject?.length || 0, changedFollowupChars: changed.inject?.length || 0, changedReason: changed.reason },
  bars: { localRecallP95Ms: 50, scaleRankingP95Ms: 50, firstInjectionMaxChars: 2500, unchangedFollowupChars: 0 },
};
report.pass = report.recall.p95Ms <= report.bars.localRecallP95Ms && report.scaleRanking.p95Ms <= report.bars.scaleRankingP95Ms && report.recall.priorAuditTop3 && report.scaleRanking.priorAuditTop3 && report.injection.firstChars <= report.bars.firstInjectionMaxChars && report.injection.unchangedFollowupChars === 0;
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.pass) process.exitCode = 1;
