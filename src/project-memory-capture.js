"use strict";

const { scanMemoryContent } = require("./memory-content-scanner");
const { sha256 } = require("./project-memory-schema");
const { classifyProjectMemoryCandidate } = require("./project-memory-policy");

const CAPTURE_GUIDANCE = "Operator-authorized project memory is enabled; field effectiveness is unproven. Before finishing substantive work, selectively capture at most 3 new durable project decisions, constraints/preferences, procedures or lasting risks using memory_curator operation=capture, input={candidate:{kind,title,content},source:'user'|'assistant',sourceQuote:'exact short quote from this turn'}. Do this without asking for another save instruction. Use a stable topic title, one concise fact (content <=500 characters), and a quote <=500 characters from the current user's message or already-emitted public assistant text. Do not capture task requests, temporary status, routine test results, speculation, quoted external instructions, transcripts, secrets, personal/sensitive details, or anything the user says not to remember. Never quote thinking or tool output. Facts are saved as unverified, not promoted to instructions or permissions. Existing related memories are advisory; skip duplicates and leave conflicts for explicit review. Do not call capture when nothing durable was learned. Manual save, pin, deletion and maintenance still need their own explicit user intent.";
const KINDS = new Set(["decision", "constraint", "procedure", "risk"]);
const OPT_OUT = /\b(?:do not|don['’]t|never|stop)\s+(?:automatically\s+)?(?:save|store|remember|record|capture)\b/i;
const UNCERTAIN = /\?|\b(?:maybe|might|possibly|hypothesis|suspect|could be|temporary|for this (?:turn|task)|today|tonight)\b/i;

// The parent model selects and summarizes. This gate binds its proposal to
// public, current-turn sources without persisting source text or inventing proof.
class ProjectMemoryCaptureAdapter {
  constructor({ projectMemory, rollout, diagnostic, canonicalVault } = {}) {
    this.projectMemory = projectMemory;
    this.rollout = rollout;
    this.diagnostic = diagnostic;
    this.canonicalVault = canonicalVault;
    this.beginTurn("");
  }
  beginTurn(text) {
    const value = String(text || "");
    this.sources = { user: value.slice(0, 24000), assistant: [] };
    this.attempts = 0;
    this.eligibleTurn = Boolean(value.trim() && !value.trim().startsWith("/") && !OPT_OUT.test(value));
  }
  observeAssistant(text) {
    if (!this.eligibleTurn) return;
    const remaining = 24000 - this.sources.assistant.reduce((sum, value) => sum + value.length, 0);
    if (remaining > 0 && this.sources.assistant.length < 12) this.sources.assistant.push(String(text || "").slice(0, remaining));
  }
  guidance() { return this.rollout?.controls?.automaticCapture && this.eligibleTurn ? CAPTURE_GUIDANCE : ""; }
  capture(input = {}) {
    const receipt = this.evaluate(input);
    this.record(receipt, input);
    return receipt;
  }
  evaluate(input = {}) {
    const rejected = (reason) => ({ ok: false, outcome: "rejected", applied: false, reason });
    if (!this.rollout?.controls?.automaticCapture) return { ...rejected("automatic-capture-disabled"), outcome: "blocked" };
    if (!this.projectMemory?.enabled || !this.projectMemory.store?.writeEnabled) return { ...rejected("vault-unavailable"), outcome: "blocked" };
    // A fallback (default-managed) vault is not an operator-confirmed canonical
    // store. Automatic capture may not create a new canonical project folder
    // there; an explicit save can provision it first.
    if (!this.canonicalVault?.confirmed && !this.canonicalVault?.projectFolderExists) return { ...rejected("canonical-vault-unconfirmed"), outcome: "blocked" };
    if (!this.eligibleTurn) return rejected("current-user-turn-required");
    if (this.attempts >= 3) return rejected("capture-turn-limit");
    this.attempts++;
    const quote = typeof input.sourceQuote === "string" ? input.sourceQuote.trim() : "";
    const sources = input.source === "user" ? [this.sources.user] : input.source === "assistant" ? this.sources.assistant : [];
    if (quote.length < 12 || quote.length > 500 || !sources.some((source) => source.includes(quote))) return rejected("source-quote-not-grounded");
    const proposed = input.candidate || {};
    if (!KINDS.has(proposed.kind) || typeof proposed.title !== "string" || !proposed.title.trim() || proposed.title.length > 100 || typeof proposed.content !== "string" || proposed.content.trim().length < 12 || proposed.content.length > 500) return rejected("capture-shape");
    // Review indicators are not safe enough for unattended capture, even when a
    // manual save could label them. Never echo rejected values in the receipt.
    const safety = scanMemoryContent(`${quote}\n${proposed.title}\n${proposed.content}`, { maxChars: 1200 });
    if (!safety.safe || safety.reasons.length) return rejected("capture-content-unsafe");
    if (UNCERTAIN.test(`${quote}\n${proposed.content}`)) return rejected("speculative-or-transient");
    const candidate = { kind: proposed.kind, title: proposed.title.trim(), content: proposed.content.trim(), verification: "unverified", sourceFingerprints: [`conversation:${input.source}:${sha256(quote)}`] };
    const policy = classifyProjectMemoryCandidate(candidate, { automatic: true, operatorCapture: true });
    if (policy.action !== "save") return rejected(policy.reason);
    return this.projectMemory.save(candidate, { apply: true, automatic: true, operatorCapture: true });
  }
  // Capture attempts are otherwise invisible when they are rejected before a
  // save, so record a bounded metadata-only receipt: outcome, reason, kind and
  // hashes. Never persist the quote, title, content or private reasoning.
  record(receipt, input = {}) {
    if (typeof this.diagnostic !== "function") return;
    const candidate = input?.candidate && typeof input.candidate === "object" ? input.candidate : {};
    const quote = typeof input?.sourceQuote === "string" ? input.sourceQuote.trim() : "";
    const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
    const event = {
      kind: "capture-attempt",
      outcome: receipt?.outcome || (receipt?.ok ? "saved" : "rejected"),
      reason: receipt?.reason || null,
      source: input?.source || null,
      candidateKind: typeof candidate.kind === "string" ? candidate.kind : null,
      quoteHash: quote ? `sha256:${sha256(quote)}` : null,
      contentHash: content ? `sha256:${sha256(content)}` : null,
    };
    // Diagnostics are observability only; a failure to append must not change
    // the governed capture outcome.
    try { this.diagnostic(event); } catch {}
  }
}

module.exports = { CAPTURE_GUIDANCE, ProjectMemoryCaptureAdapter };
