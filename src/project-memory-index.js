"use strict";

const { normalizeKey, VERIFICATION_RANK } = require("./project-memory-schema");
function tokens(value) { return new Set(normalizeKey(value).split(/[^a-z0-9_.:-]+/).filter((term) => term.length > 1)); }
function ageScore(updatedAt, now = Date.now()) { const timestamp = typeof updatedAt === "number" ? updatedAt : Date.parse(String(updatedAt || 0)); const age = Math.max(0, now - timestamp); if (!Number.isFinite(age)) return 0; return Math.exp(-age / (90 * 24 * 60 * 60 * 1000)); }
function prepareEntry(entry) { const title = normalizeKey(entry.title); const content = normalizeKey(entry.content); const haystack = `${title} ${content} ${normalizeKey(entry.kind)} ${normalizeKey(entry.verification)}`; return { entry, title, haystack, hayTokens: tokens(haystack), updatedMs: Date.parse(String(entry.updatedAt || 0)) }; }
const TASK_STOP_WORDS = new Set("a an and are as at be been but by can could did do does for from had has have help how i if in into is it its let lets me my of on or our please should so some that the their them then there these they this those to use using was we were what when where which while who why will with would you your".split(" "));
function prepareQuery(query, taskConditioned = false) { const normalized = normalizeKey(query); return { normalized, terms: [...tokens(normalized)].filter((term) => !taskConditioned || !TASK_STOP_WORDS.has(term)) }; }
function scorePrepared(row, query, options = {}) {
  let hits = 0; for (const term of query.terms) if (row.hayTokens.has(term)) hits++;
  const phrase = query.normalized && row.haystack.includes(query.normalized) ? 1 : 0; const titlePhrase = query.normalized && row.title.includes(query.normalized) ? 1 : 0; const allTerms = query.terms.length > 0 && hits === query.terms.length ? 1 : 0; const coverage = query.terms.length ? hits / query.terms.length : 0; const verification = (VERIFICATION_RANK[row.entry.verification] || 0) / 4; const recency = ageScore(row.updatedMs, options.now || Date.now()); const kindBoost = options.kinds?.includes(row.entry.kind) ? 0.5 : 0; const score = titlePhrase * 4 + phrase * 3 + allTerms * 2 + coverage * 2 + verification * 0.75 + recency * 0.35 + kindBoost;
  return { total: score, factors: { titlePhrase: Boolean(titlePhrase), phrase: Boolean(phrase), allTerms: Boolean(allTerms), termCoverage: coverage, verification, recency, kindBoost } };
}
function scoreEntry(entry, query, options = {}) { return scorePrepared(prepareEntry(entry), prepareQuery(query), options); }
function recallableEntries(entries, now = Date.now()) {
  // Expiry ends a claim's eligibility, not its correction of an earlier claim.
  // Build exclusions before expiry, kind/query filtering or cache truncation.
  const excluded = new Set(entries.flatMap((entry) => [...(entry.supersedes || []), ...(entry.contradicts || [])]));
  return entries.filter((entry) => entry.verification !== "contradicted" && !excluded.has(entry.id) && !entry.contradicts?.length && (!entry.expiresAt || Date.parse(entry.expiresAt) >= now));
}
class ProjectMemoryIndex {
  constructor({ store = null, entries = [], now = () => Date.now() } = {}) { this.store = store; this.seedEntries = entries; this.now = now; this.entries = []; this.rows = []; this.refresh(); }
  refresh() { const entries = this.store ? this.store.list({ includeExpired: true, limit: Infinity }) : [...this.seedEntries]; const signature = entries.map((entry) => `${entry.id}:${entry.updatedAt}:${entry.candidateHash || ""}`).join("|"); if (signature !== this.signature) { this.entries = entries; this.rows = entries.map(prepareEntry); this.signature = signature; } return this.entries.length; }
  search(query, { limit = 5, kinds, minTermCoverage, taskConditioned = false } = {}) {
    const started = process.hrtime.bigint(); const rows = []; const preparedQuery = prepareQuery(query, taskConditioned); const now = this.now(); const minimumCoverage = minTermCoverage == null ? (taskConditioned ? 0 : preparedQuery.terms.length >= 2 ? 0.6 : 0) : Math.max(0, Math.min(1, Number(minTermCoverage)));
    const eligible = new Set(recallableEntries(this.entries, now));
    for (const row of this.rows) {
      if (!preparedQuery.terms.length || !eligible.has(row.entry) || (kinds?.length && !kinds.includes(row.entry.kind))) continue;
      const score = scorePrepared(row, preparedQuery, { now, kinds });
      // Verification/recency bonuses must never manufacture a relevance match.
      if (score.factors.termCoverage <= 0 || score.factors.termCoverage < minimumCoverage) continue;
      rows.push({ entry: row.entry, score });
    }
    rows.sort((a, b) => b.score.total - a.score.total || String(b.entry.updatedAt).localeCompare(String(a.entry.updatedAt)) || String(a.entry.id).localeCompare(String(b.entry.id))); const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    return { schemaVersion: 1, query: preparedQuery.normalized, items: rows.slice(0, Math.max(0, Number(limit) || 0)).map(({ entry, score }) => ({ ...entry, score: Number(score.total.toFixed(6)), why: score.factors })), candidates: rows.length, durationMs };
  }
}
module.exports = { tokens, ageScore, prepareEntry, prepareQuery, scorePrepared, scoreEntry, recallableEntries, ProjectMemoryIndex };
