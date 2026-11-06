"use strict";

// Completion enforcement for authorized implementation turns.
//
// Field evidence (2026-10-21 GatticLang session): an implementation request
// ended with "Stopping at this execution-budget checkpoint" although pi has no
// execution budget, and when challenged the model stated the limit was "an
// unsupported justification I introduced for stopping". The same session ended
// 45 turns after partial increments while required roadmap outcomes were still
// open, and proactive compaction summaries reframed the work as "completed /
// next steps", which made an early stop look settled.
//
// This module decides, from the final assistant text of a settled turn, whether
// the harness should continue an implementation turn instead of accepting the
// stop. It is deliberately inert for read-only modalities (investigation,
// planning, verification, answer) so those requests stay read-only, and it
// always yields to real blockers, explicit user decisions, user-stated scope
// limits, clarification questions, and other continuation owners.

const COMPLETION_ENFORCEMENT_VERSION = "completion-enforcement-2026-10-25.3";
const ENFORCED_MODALITIES = new Set(["implementation"]);
const DEFAULT_MAX_CONTINUATIONS = 8;

// Vocabulary that names a limit pi does not impose on a turn. Context/turn
// exhaustion is not a reason to end a task: compaction and the next turn
// continue it.
const UNSUPPORTED_LIMIT_RE = new RegExp(
  [
    "\\b(?:execution|turn|context|token|task)[ -]?budget\\b",
    "\\bbudget (?:limit|boundary|checkpoint|exhausted|reached)\\b",
    "\\b(?:stopping|pausing|paused) (?:at|for|due to) (?:this|the) (?:turn|context|execution|token)[ -]?(?:budget|limit|checkpoint)\\b",
    "\\b(?:hit|reached) (?:the|this) (?:turn|context|execution|token)[ -]?(?:limit|budget)\\b",
    "\\b(?:context|context window) (?:limit|budget) (?:reached|exhausted)\\b",
    "\\bout of (?:execution |turn )?budget\\b",
  ].join("|"),
  "i",
);

// Language that reports unfinished required work. This is the signal that an
// implementation turn ended after a partial increment. A claim that one
// increment, milestone, phase, or step is finished counts as partial work: it
// says nothing about the remaining required outcomes.
const PARTIAL_WORK_RE = new RegExp(
  [
    "\\bnot (?:yet )?(?:complete|completed|done|finished)\\b",
    "\\bremains? (?:incomplete|open|pending|active|unfinished)\\b",
    "\\bstill (?:required|needed|pending|to (?:do|be done|implement|finish|verify))\\b",
    "\\bremaining (?:\\d+ )?(?:work|outcomes?|requirements?|items?|milestones?|increments?)\\b",
    "\\b(?:is|are|remains?) (?:still )?incomplete\\b",
    "\\bincomplete (?:work|outcomes?|items?|requirements?|implementation)\\b",
    "\\bnot fully (?:implemented|complete|completed)\\b",
    "\\b(?:done|complete|completed|finished)\\s+(?:with\\s+)?(?:the\\s+)?(?:first|next|current|initial|this)\\s+(?:increment|milestone|phase|step|batch)\\b",
    "\\b(?:the\\s+)?(?:first|next|current|initial|this)\\s+(?:increment|milestone|phase|step|batch)\\s+(?:is\\s+|was\\s+)?(?:complete|completed|done|finished)\\b",
    "\\b(?:M\\d+|milestone\\s+[\\w.-]+|phase\\s+\\d+|step\\s+\\d+)\\s+(?:is\\s+|was\\s+)?(?:complete|completed|done|finished)\\b",
    "\\bnext(?: step| steps)?:",
  ].join("|"),
  "i",
);

const COMPLETION_CLAIM_RE = new RegExp(
  [
    "\\ball (?:required |authorized )?(?:outcomes?|requirements?|items?|milestones?|steps?) (?:are |is )?(?:now )?(?:complete|completed|done|verified)\\b",
    "\\bevery (?:required |authorized )?(?:outcome|requirement|item|milestone|step)s? (?:is|are|has been|have been) (?:now )?(?:complete|completed|done|verified)\\b",
    "\\bnothing (?:left|remains|else remains|else is left) (?:to do|to be done|pending|outstanding)\\b",
    "\\bnothing (?:in|within) (?:the )?(?:authorized |current |remaining |requested )?scope (?:remains|remains open|remains outstanding|is left|left)\\b",
    "\\bno (?:required|remaining|incomplete|open|pending) (?:work|outcomes?|items?|requirements?) (?:remain|left)\\b",
    "\\bno (?:further|more|additional|remaining|outstanding) (?:required |authorized )?(?:work|outcomes?|items?|requirements?) (?:exists?|remains?|is left|are left)\\b",
    "\\b(?:remaining (?:work|outcomes?|items?|milestones?)|next(?: steps?)?)\\s*:?\\s*(?:none|nothing|n/a|zero|0)\\b",
    "\\b(?:everything|all (?:work|tasks?|outcomes?|items?))(?:\\s+(?:is|are))?\\s+(?:now )?(?:done|complete|completed|verified)\\b",
    "\\b(?:the )?(?:task|work|implementation|requested work|authorized work) (?:is|has been) (?:now )?(?:complete|completed|done|verified)\\b",
  ].join("|"),
  "i",
);

// A stop that asks the user for a protected action is a real authorization
// boundary: deleting, pausing, committing, publishing, or widening a resource
// allowance needs the user's decision, so enforcement must not continue past it.
const PROTECTED_ACTION_RE = new RegExp(
  [
    "\\b(?:delete|remove|destroy|wipe|reset|discard|purge|drop)\\b",
    "\\b(?:pause|kill|stop (?:the )?(?:process|job|pid))\\b",
    "\\b(?:commit|push|publish|deploy|release|tag)\\b",
    "\\b(?:approve|authori[sz]e|grant|rotate|revoke|increase|raise|spend|install|run (?:the )?live)\\b",
  ].join("|"),
  "i",
);

const ASK_MARKER_RE = /\b(?:may i|shall i|should i|do you want me to|would you like me to|please confirm|need (?:your )?(?:approval|confirmation|decision)|awaiting (?:your )?(?:approval|confirmation|decision)|is it (?:ok|okay|acceptable|fine|alright)|is that (?:ok|okay|acceptable|fine|alright)|do you approve|can you confirm|would you approve)\b/i;

// Asking permission to keep going is not a decision boundary: the user already
// authorized the implementation, so the harness continues instead of stalling.
const PROCEED_REQUEST_RE = /\b(?:should|shall|may|can) i (?:continue|proceed|carry on|keep going|resume)\b|\b(?:want|like) me to (?:continue|proceed|carry on|keep going|resume)\b/i;

// A clarification question (which option, is this acceptable, any objections)
// is a decision boundary the harness must not answer on the user's behalf.
const QUESTION_RE = /\?/;

// A user-stated pause or scope limit is authoritative even when the request
// itself is an implementation request ("Implement M1 only; stop after M1").
const BOUNDARY_STOP_RE = /\b(?:stop|pause|halt|end)\s+(?:here|now|after|at|when|once|before|there|then)\b|\bthen\s+(?:stop|pause|halt|end)\b|\b(?:stop|pause|halt|end)\s*$/i;
const BOUNDARY_LIMIT_RE = new RegExp(
  [
    "\\b(?:do not|don't|must not|never)\\s+(?:continue|proceed|go\\s+(?:further|beyond|past)|implement\\s+(?:beyond|past|the\\s+rest))\\b",
    "\\b(?:only|just)\\s+(?:this|that|one)\\s+(?:step|increment|milestone|phase|task)\\b",
    "\\b(?:only|just)\\s+(?:do|implement|complete|work\\s+on)\\s+(?:M\\d+|milestone\\s+\\w+|phase\\s+\\d+|step\\s+\\d+)\\b",
    "\\b(?:M\\d+|milestone\\s+\\w+|phase\\s+\\d+|step\\s+\\d+)\\s+only\\b",
    "\\b(?:up\\s+to|through|until)\\s+(?:M\\d+|milestone\\s+\\w+|phase\\s+\\d+)\\b",
    "\\bnot\\s+(?:M\\d+|milestone\\s+\\w+|phase\\s+\\d+|step\\s+\\d+)\\b",
    "\\bnothing\\s+else\\b",
    "\\bno\\s+(?:further|more)\\b",
    "\\bleave\\s+(?:the\\s+)?rest\\b",
    "\\bfor\\s+now\\b",
  ].join("|"),
  "i",
);

// A stop that waits on managed work (a background job, run, or subagent) is
// legitimate: continuing immediately would busy-loop the same check. The
// explicit "monitor will notify/wake" phrases were removed because run_monitor
// no longer wakes the agent; a generic "wait for" still settles.
const WAITING_ON_MANAGED_WORK_RE = /\b(?:waiting? (?:for|on|until)|(?:i'll|i will) (?:wait|hold)|(?:job|build|suite|run) (?:is |still )?(?:running|building|in progress)|pending (?:job|build|run)|bg_run|run_deck)\b/i;

// A blocker is only accepted when the turn names both the blocker and the
// evidence it rests on; an unevidenced "blocked" claim is the same unsupported
// justification as a fabricated budget.
const BLOCKER_RE = /\b(?:blocked|cannot (?:proceed|continue)|unavailable|requires? (?:access|credentials?|a decision|approval)|missing (?:dependency|credential|access|toolchain)|external (?:service|provider|dependency)|rate[- ]limit|HTTP \d{3}|\b429\b|build (?:fails?|failed|broken)|tests? (?:fail|failed)|compilation (?:error|failed)|integrity (?:failure|violation))\b/i;
const EVIDENCE_REF_RE = /\b(?:evidence|receipt|log|error|stderr|stdout|exit (?:code|status)|\.json|\.log|job-[a-z0-9]+|pid \d+|line \d+)\b/i;

// Progress counters ("root outcomes: 1/6", "workflow 150/167") report partial
// work only when fewer items are done than planned; a complete counter such as
// "6/6" is a completion claim, not unfinished work. A ratio counts only when a
// counter label names it in the same clause, and never when it belongs to a
// slash-separated identifier: a host list ("node-2/3/4/5/1") or a version
// pair ("relay v5/v5") is not a progress counter, and a counter word elsewhere
// in the message must not turn one into a partial-work signal.
const COUNTER_LABEL_SOURCE = "(?:outcomes?|requirements?|items?|milestones?|workflow|roadmap|steps?|increments?)";
const COUNTER_LABEL_RE = new RegExp(`\\b${COUNTER_LABEL_SOURCE}\\b`, "i");
// One ratio between two numbers, not a member of a slash-separated chain.
const COUNTER_RATIO_SOURCE = "(?<![/\\w.])(\\d{1,9})\\s*\\/\\s*(\\d{1,9})(?![/\\w])";
const COUNTER_RATIO_RES = [
  new RegExp(`\\b${COUNTER_LABEL_SOURCE}\\b[^\\n.;!?]{0,40}?${COUNTER_RATIO_SOURCE}`, "gi"),
  new RegExp(`${COUNTER_RATIO_SOURCE}[^\\n.;!?]{0,40}?\\b${COUNTER_LABEL_SOURCE}\\b`, "gi"),
];

/** Partial and complete counters that a counter label names in its own clause. */
function counterRatios(text) {
  const status = { partial: false, complete: false };
  if (!COUNTER_LABEL_RE.test(text)) return status;
  for (const ratio of COUNTER_RATIO_RES) {
    for (const match of text.matchAll(ratio)) {
      const done = Number(match[1]);
      const total = Number(match[2]);
      if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) continue;
      if (done < total) status.partial = true;
      else status.complete = true;
    }
  }
  return status;
}

// A stop that is conditioned on a verification criterion ("stop when the
// tests pass", "do not continue until the build is green") is a completion
// instruction, not a scope limit: the turn should keep going until it passes.
const COMPLETION_CONDITION_RE = /\b(?:tests?|build|checks?|suite|lint|typecheck|verification)\b[^.;!?\n]*\b(?:pass|passes|passing|green|clean|succeed|succeeds|successful)\b/i;
const COMPLETION_WHEN_RE = /\b(?:when|once|after)\s+(?:done|finished|complete|completed|everything)\b/i;
const STOP_MARKER_RE = /\b(?:stop|pause|halt|end)\b/i;
const CONTINUATION_REFUSAL_RE = /\b(?:do not|don't|must not|never)\s+(?:continue|proceed|go\s+(?:further|beyond|past)|implement\s+(?:beyond|past|the\s+rest))\b/i;
const NEGATED_STOP_RE = /\b(?:do not|don't|never|must not)\s+(?:stop|pause|halt|end)\b/i;

// Detect an explicit user pause or scope limit. A negated stop ("do not stop
// until all tests pass") and a stop conditioned on a verification criterion
// ("stop when the tests pass") are instructions to keep going, not boundaries.
function detectUserBoundary(text) {
  const value = typeof text === "string" ? text : "";
  if (!value.trim()) return false;
  for (const clause of value.split(/[.;!?\n]+/)) {
    if (!clause.trim()) continue;
    if (NEGATED_STOP_RE.test(clause)) continue;
    const stopLike = STOP_MARKER_RE.test(clause) || CONTINUATION_REFUSAL_RE.test(clause);
    if (stopLike && (COMPLETION_CONDITION_RE.test(clause) || COMPLETION_WHEN_RE.test(clause))) continue;
    if (BOUNDARY_STOP_RE.test(clause) || BOUNDARY_LIMIT_RE.test(clause)) return true;
  }
  return false;
}

function classifyStopClaim(text) {
  const value = typeof text === "string" ? text : "";
  const trimmed = value.trim();
  const ratios = counterRatios(value);
  return {
    empty: trimmed.length === 0,
    unsupportedLimit: UNSUPPORTED_LIMIT_RE.test(value),
    partialWork: PARTIAL_WORK_RE.test(value) || ratios.partial,
    // A complete counter settles only when no counter in the message still
    // reports unfinished work; an open root counter wins over a finished
    // increment counter.
    completionClaim: COMPLETION_CLAIM_RE.test(value) || (ratios.complete && !ratios.partial),
    asksForAuthorization: PROTECTED_ACTION_RE.test(value) && (ASK_MARKER_RE.test(value) || /\?\s*$/.test(trimmed)),
    asksToProceed: PROCEED_REQUEST_RE.test(value),
    asksQuestion: QUESTION_RE.test(value),
    waitingOnManagedWork: WAITING_ON_MANAGED_WORK_RE.test(value),
    evidencedBlocker: BLOCKER_RE.test(value) && EVIDENCE_REF_RE.test(value),
  };
}

// 0 means "no continuations" (enforcement disabled). Negative, non-numeric,
// null, and empty values fall back to the default: an unset or blank control
// must not silently disable enforcement the way a numeric 0 does.
function normalizeMaxContinuations(value) {
  if (value === null || value === undefined) return DEFAULT_MAX_CONTINUATIONS;
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "") return DEFAULT_MAX_CONTINUATIONS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_CONTINUATIONS;
  return Math.floor(parsed);
}

// Decision order matters. Real boundaries win over enforcement so the harness
// never overrides the user's authority, a stated scope limit, a clarification
// question, or another continuation owner; only then does an unevidenced stop
// claim get continued.
function decideContinuation({
  modality,
  text,
  continuationCount = 0,
  maxContinuations = DEFAULT_MAX_CONTINUATIONS,
  userBoundary = false,
} = {}) {
  const signals = classifyStopClaim(text);
  const settle = (reason) => ({ action: "settle", reason, signals });
  const proceed = (reason) => ({ action: "continue", reason, signals });

  if (!ENFORCED_MODALITIES.has(modality)) return settle("read-only-or-non-implementation");
  if (signals.empty) return settle("empty-final-message");
  if (continuationCount >= normalizeMaxContinuations(maxContinuations)) return settle("continuation-cap");
  if (userBoundary) return settle("user-boundary");
  if (signals.asksForAuthorization) return settle("authorization-boundary");
  if (signals.waitingOnManagedWork) return settle("waiting-on-managed-work");
  if (signals.asksToProceed) return proceed("proceed-request");
  if (signals.asksQuestion) return settle("user-question");
  if (signals.unsupportedLimit) return proceed("unsupported-limit-claim");
  if (signals.evidencedBlocker) return settle("evidenced-blocker");
  if (signals.partialWork && !signals.completionClaim) return proceed("partial-completion");
  if (signals.completionClaim) return settle("completion-claim");
  return settle("no-stop-signal");
}

function buildContinuationPrompt(objective) {
  const scope = typeof objective === "string" ? objective.trim().slice(0, 400) : "";
  const target = scope ? `Continue the authorized implementation of: ${scope}` : "Continue the authorized implementation.";
  return [
    "Continue implementing the authorized task until every required outcome is complete.",
    target,
    "There is no harness execution budget; stopping requires an evidenced blocker or an explicit user decision.",
    "Re-check the current state, complete the remaining required outcomes, and verify the affected behavior.",
  ].join(" ");
}

module.exports = {
  COMPLETION_ENFORCEMENT_VERSION,
  DEFAULT_MAX_CONTINUATIONS,
  buildContinuationPrompt,
  classifyStopClaim,
  decideContinuation,
  detectUserBoundary,
  normalizeMaxContinuations,
};
