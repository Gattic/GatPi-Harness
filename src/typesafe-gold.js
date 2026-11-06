"use strict";

// Reviewed-gold set for the TypeSafe turn judgment. Candidate user turns are
// extracted from Pi session files, redacted locally, and must be reviewed
// (modality labels) before any row is sent to TypeSafe. Evaluation judges the
// pre-registered modality bar on the test split.

const crypto = require("node:crypto");
const { JUDGED_MODALITY_DESCRIPTIONS } = require("./task-modality");
const { redactTurnPrompt, decideTurn } = require("./typesafe-turn-judgment");
const { accuracy, evaluateIntentBars } = require("./typesafe-evaluation");

const GOLD_SCHEMA_VERSION = 2;
const MIN_PROMPT_CHARS = 8;
const MIN_REVIEWED = Object.freeze({ modalityLabels: 30 });
const REVIEW_STATUSES = new Set(["pending", "approved", "rejected"]);

function sha(value, length = 12) { return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length); }
function userText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => part.text).join("") : "";
}

// entries: parsed session JSONL rows. Returns one turn per user message.
function extractSessionTurns(entries, { sessionId = "session" } = {}) {
  const turns = [];
  let previousText = null;
  for (const entry of entries) {
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = userText(entry.message).trim();
    turns.push({ id: sha(`${sessionId}:${entry.id}`), text, previousText });
    previousText = text;
  }
  return turns;
}

// Turns become candidates only when the prompt was typed by a person (not an
// explicit /skill or command invocation).
function candidateFromTurn(turn) {
  if (!turn.text || turn.text.startsWith("/") || turn.text.startsWith("<skill")) return { excluded: "explicit-invocation" };
  const prompt = redactTurnPrompt(turn.text);
  if (prompt.length < MIN_PROMPT_CHARS) return { excluded: "too-short" };
  return {
    candidate: {
      schemaVersion: GOLD_SCHEMA_VERSION,
      id: turn.id,
      dedupeKey: sha(turn.text.replace(/\s+/g, " ").toLowerCase(), 16),
      split: parseInt(sha(`split:${turn.id}`, 8), 16) % 2 === 0 ? "dev" : "test",
      prompt,
      previous: turn.previousText ? redactTurnPrompt(turn.previousText) : null,
      labels: { modality: null },
      review: { status: "pending", note: null },
    },
  };
}

// Deterministic sample: unique prompts in hash order.
function sampleCandidates(candidates, { count = 300 } = {}) {
  const seen = new Set();
  const unique = [];
  for (const row of [...candidates].sort((a, b) => sha(a.id).localeCompare(sha(b.id)))) if (!seen.has(row.dedupeKey)) { seen.add(row.dedupeKey); unique.push(row); }
  return unique.slice(0, count);
}

function applyReview(row, update = {}) {
  const labels = { ...row.labels };
  if (update.modality !== undefined) {
    const modality = update.modality === "none" ? null : update.modality;
    if (modality && !Object.hasOwn(JUDGED_MODALITY_DESCRIPTIONS, modality)) throw new Error(`modality must be one of ${Object.keys(JUDGED_MODALITY_DESCRIPTIONS).join(", ")}`);
    labels.modality = modality;
  }
  const status = update.status || row.review.status;
  if (!REVIEW_STATUSES.has(status)) throw new Error(`unknown review status: ${status}`);
  return { ...row, labels, review: { status, note: update.note === undefined ? row.review.note : String(update.note).slice(0, 200) || null } };
}

function reviewSummary(rows) {
  const approved = rows.filter((row) => row.review.status === "approved");
  return {
    total: rows.length,
    pending: rows.filter((row) => row.review.status === "pending").length,
    rejected: rows.filter((row) => row.review.status === "rejected").length,
    approved: approved.length,
    approvedModalityLabels: approved.filter((row) => row.labels.modality).length,
  };
}

// Evaluation may send rows only when the whole set is reviewed and large enough.
function evaluationReadiness(rows) {
  const summary = reviewSummary(rows);
  const reasons = [];
  if (!rows.length) reasons.push("no-candidates");
  if (summary.pending) reasons.push(`${summary.pending}-rows-pending-review`);
  if (summary.approvedModalityLabels < MIN_REVIEWED.modalityLabels) reasons.push(`approved-modality-labels-below-${MIN_REVIEWED.modalityLabels}`);
  return { ready: reasons.length === 0, reasons, summary };
}

// predictions: { regexModality: Map(id -> modality) }. Nothing is tuned, so the
// dev split is unused; the bar is judged on the test split as pre-registered.
function evaluateGold(rows, answersById, predictions) {
  const approved = rows.filter((row) => row.review.status === "approved" && answersById.has(row.id));
  const modalityRows = approved.filter((row) => row.split === "test" && row.labels.modality);
  const enoughModality = approved.filter((row) => row.labels.modality).length >= MIN_REVIEWED.modalityLabels;
  const regexModality = enoughModality ? accuracy(modalityRows.map((row) => ({ label: row.labels.modality, predicted: predictions.regexModality.get(row.id) }))) : null;
  const typesafeModality = enoughModality ? accuracy(modalityRows.map((row) => ({ label: row.labels.modality, predicted: decideTurn(answersById.get(row.id)).intent.modality.value }))) : null;
  return {
    schemaVersion: GOLD_SCHEMA_VERSION,
    rows: { approved: approved.length, testModalityLabels: modalityRows.length },
    intent: { regexModality, typesafeModality, bars: evaluateIntentBars({ localModality: regexModality, typesafeModality }) },
  };
}

module.exports = {
  GOLD_SCHEMA_VERSION,
  MIN_REVIEWED,
  extractSessionTurns,
  candidateFromTurn,
  sampleCandidates,
  applyReview,
  reviewSummary,
  evaluationReadiness,
  evaluateGold,
};
