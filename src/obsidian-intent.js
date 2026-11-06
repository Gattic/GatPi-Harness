"use strict";

const RULES = Object.freeze([
  { category: "explicit-obsidian", confidence: 1, re: /\bobsidian\b/i },
  { category: "explicit-vault", confidence: 0.98, re: /\b(?:note|research|knowledge)\s+vault\b|\bvault\s+(?:note|search|research|memory)\b/i },
  { category: "literature", confidence: 0.95, re: /\b(?:literature review|bibliograph(?:y|ic)|citation(?:s)?|paper notes?|research notes?)\b/i },
  { category: "durable-note", confidence: 0.92, re: /\b(?:save|store|write|record|capture)\b[^\n]{0,50}\b(?:durable|research|memory)\s+note\b/i },
  { category: "research-memory", confidence: 0.90, re: /\b(?:research memory|durable research context|curate (?:my |the )?(?:research|notes)|remember this research decision)\b/i },
]);
// TypeSafe judgment that replaces RULES when PI_JEV_TURN_INTENT=on.
const RESEARCH_MEMORY_JUDGMENT = "Does the user's `request` ask to search, consult, save, or curate notes in their Obsidian research vault or durable research memory, such as literature reviews, citations, or research notes?";
function publicText(value, maxChars = 2000) {
  if (typeof value === "string") return value.slice(0, maxChars);
  if (Array.isArray(value)) return value.map((item) => publicText(item, maxChars)).filter(Boolean).join("\n").slice(0, maxChars);
  if (!value || typeof value !== "object") return "";
  if (String(value.type || "").toLowerCase().includes("thinking") || String(value.type || "").toLowerCase().includes("reasoning")) return "";
  return publicText(value.text ?? value.content ?? value.prompt ?? "", maxChars);
}
function eventText(event = {}) {
  if (typeof event.prompt === "string") return event.prompt.slice(0, 2000);
  if (typeof event.userPrompt === "string") return event.userPrompt.slice(0, 2000);
  const messages = Array.isArray(event.messages) ? event.messages : [];
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  return publicText(lastUser?.content, 2000);
}
function classifyObsidianIntent(value, options = {}) {
  const text = publicText(value, options.maxChars || 2000);
  for (const rule of RULES) if (rule.re.test(text)) return { eligible: true, category: rule.category, confidence: rule.confidence };
  return { eligible: false, category: "none", confidence: 0 };
}
function judgedObsidianIntent(researchMemory) {
  if (!researchMemory) return { eligible: false, category: "judgment-unavailable", confidence: 0 };
  return { eligible: researchMemory.eligible === true, category: researchMemory.eligible ? "typesafe-judgment" : "none", confidence: Number(researchMemory.probability) || 0 };
}
function obsidianAutomaticContextPolicy(intent, options = {}) {
  const eligible = Boolean(intent?.eligible);
  return {
    eligible,
    injectAwareness: eligible && Boolean(options.autoAware),
    probeStatus: eligible && Boolean(options.autoStatus) && !options.statusInjected,
  };
}
module.exports = { RULES, RESEARCH_MEMORY_JUDGMENT, publicText, eventText, classifyObsidianIntent, judgedObsidianIntent, obsidianAutomaticContextPolicy };
