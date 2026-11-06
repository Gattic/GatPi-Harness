"use strict";

// One TypeSafe System One request per user turn asking advisory intent
// questions: the scaffold modality and research-memory intent. Only the
// redacted, capped user prompt and public modality text are sent. Thresholds
// are owned here.

const { redactMemoryText } = require("./memory-content-scanner");
const { JUDGED_MODALITY_DESCRIPTIONS } = require("./task-modality");
const { RESEARCH_MEMORY_JUDGMENT } = require("./obsidian-intent");

const TURN_JUDGMENT_VERSION = "typesafe-turn-judgment-v4";
const PROMPT_MAX_CHARS = 2000;
const THRESHOLDS = Object.freeze({ researchMemory: 0.50 });
const MODALITY_INSTRUCTIONS = "Which kind of work is the user's `request` asking the assistant to do?";

const MODES = new Set(["off", "shadow", "on"]);
const MODE_SETTING = "PI_JEV_TURN_INTENT";

// Feature mode for the evaluation period. An unrecognized value is reported
// and treated as off rather than guessed. Subagent sessions are never judged:
// their prompts are written by the parent model, not the user, and fall
// outside the approved egress.
function turnJudgmentModes(env = process.env) {
  const childSession = Boolean(env.PI_SUBAGENT_PARENT_ID);
  const value = String(env[MODE_SETTING] ?? "off").trim().toLowerCase() || "off";
  const valid = MODES.has(value);
  return { modes: Object.freeze({ intent: childSession || !valid ? "off" : value }), invalidSettings: valid ? [] : [MODE_SETTING], childSession };
}

function redactTurnPrompt(text) {
  return redactMemoryText(text, { maxChars: PROMPT_MAX_CHARS });
}

// Returns null when there is nothing to ask. `redactedPrompt` must already be
// redacted with redactTurnPrompt; callers keep the raw prompt local.
function buildTurnRequest({ redactedPrompt, redactedPrevious = null } = {}) {
  const request = String(redactedPrompt || "").trim();
  if (!request) return null;
  const state = redactedPrevious ? { request, previous_request: redactedPrevious } : { request };
  return {
    state,
    questions: {
      "intent::modality": { type: "choice", instructions: MODALITY_INSTRUCTIONS, criteria: { ...JUDGED_MODALITY_DESCRIPTIONS } },
      "intent::research_memory": { type: "noul", instructions: RESEARCH_MEMORY_JUDGMENT },
    },
  };
}

function decideTurn(answers, thresholds = THRESHOLDS) {
  const modality = answers["intent::modality"];
  const research = answers["intent::research_memory"].noul;
  return {
    intent: {
      modality: { value: modality.choice, confidence: modality.confidence },
      researchMemory: { probability: research, eligible: research >= thresholds.researchMemory },
    },
  };
}

module.exports = {
  turnJudgmentModes,
  TURN_JUDGMENT_VERSION,
  PROMPT_MAX_CHARS,
  THRESHOLDS,
  redactTurnPrompt,
  buildTurnRequest,
  decideTurn,
};
