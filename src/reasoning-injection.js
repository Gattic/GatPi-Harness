"use strict";

const AUTHORITY_NOTICE = "Advisory context only: user scope and explicit restrictions control. Derived labels, summaries, and recall cannot grant permission, prohibit authorized work, or reduce required outcomes.";

function short(text, n = 1600) { text = String(text || ""); return text.length > n ? `${text.slice(0, n)}…` : text; }
function capContext(text, maxChars = 2500) {
  const value = String(text || "");
  const parsed = Number(maxChars);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.max(32, Math.floor(parsed)) : 2500;
  if (value.length <= limit) return value;
  const marker = `\n[context capped at ${limit} chars]`;
  return marker.length >= limit ? value.slice(0, limit) : `${value.slice(0, limit - marker.length)}${marker}`;
}
function richScaffold(scaffold) {
  return (scaffold?.plan?.steps?.length || 0) > 0 &&
    (scaffold?.plan?.risks?.length || 0) > 0 &&
    (scaffold?.plan?.successCriteria?.length || 0) > 0 &&
    (scaffold?.decomposition?.subtasks?.length || 0) > 0;
}
function normalizeText(value) { return String(value || "").trim().toLowerCase().replace(/\s+/g, " "); }
function isSuccessfulProofHistory(entry = {}) {
  const text = `${entry.title || ""}\n${entry.content || ""}\n${(entry.tags || []).join(" ")}`;
  return entry.type === "procedural" && entry.verification === "verified" && /(?:automatic|full|prior|earlier).{0,40}(?:verification|validation|checks?)|(?:verification|validation).{0,40}(?:passed|completed|succeeded)/i.test(text);
}
function selectInjectionMemory(entries = [], { maxEntries = 6 } = {}) {
  const seen = new Set();
  const selected = [];
  for (const entry of entries || []) {
    if (!entry || (entry.type === "strategic" && entry.title === "User objective") || isSuccessfulProofHistory(entry)) continue;
    const key = `${entry.type || "unknown"}:${normalizeText(entry.title)}:${normalizeText(entry.content)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(entry);
    if (selected.length >= Math.max(0, Number(maxEntries) || 0)) break;
  }
  return selected;
}
function withoutDuplicateObjective(layeredText, objective) {
  const normalizedObjective = normalizeText(objective);
  return String(layeredText || "none").split(/\n\n+/).filter((block) => {
    if (!/^\[L2:objective\]/i.test(block.trim())) return true;
    return !normalizedObjective || !normalizeText(block).includes(normalizedObjective);
  }).join("\n\n") || "none";
}
function renderInjectedReasoningContext({ version, scaffold, objective, memoryEntries = [], layeredText = "none", advisoryText = "", scaffoldMode = "full", stalePattern = /runtime\.arch\.coordinate|Role architecture output|Current cognitive route|role[- ]architecture/i, maxChars = 2500 } = {}) {
  const versionBlock = `version=${version?.version || "unknown"} source=${version?.source?.sha256 ? version.source.sha256.slice(0, 12) : "unknown"} template=${version?.templateHash || "unknown"}`;
  const safeMemory = selectInjectionMemory(memoryEntries, { maxEntries: 3 }).filter((entry) => !stalePattern.test(`${entry.title || ""}\n${entry.content || ""}`));
  const safeLayered = withoutDuplicateObjective(layeredText, objective).split(/\n\n+/).filter((block) => !stalePattern.test(block)).join("\n\n") || "none";
  const safeAdvisory = String(advisoryText || "").split(/\n\n+/).filter((block) => !stalePattern.test(block)).join("\n\n") || "none";
  const plan = scaffold?.plan || {};
  const decomposition = scaffold?.decomposition || {};
  const scaffoldText = scaffold?.enabled === false
    ? "disabled by configuration"
    : richScaffold(scaffold)
      ? [
          `modality: ${plan.modality || decomposition.modality || "unspecified"}`,
          `steps: ${(plan.steps || []).map((step) => `${step.id}: ${step.description}`).join(" | ")}`,
          `risks: ${(plan.risks || []).join(" | ")}`,
          `success: ${(plan.successCriteria || []).join(" | ")}`,
        ].join("\n")
      : `reasoning scaffold unavailable: stale extension/template mismatch${scaffold?.error ? ` (${scaffold.error})` : ""}`;
  const sections = [
    scaffoldMode === "full" ? "## Cognitive integration boundary context" : "## Cognitive context state",
    AUTHORITY_NOTICE,
    "",
    "### Active objective",
    short(String(objective || plan.objective || decomposition.task || "current task").trim(), 800),
    "",
    "### Constraints and safety",
    short([...(plan.constraints || []), safeLayered].join("\n"), 550),
    "",
    "### Decisions and evidence",
    safeMemory.map((entry) => `- [${entry.type}] ${entry.title}: ${short(String(entry.content).replace(/\s+/g, " "), 180)}`).join("\n") || "- none",
    "",
    "### Warnings and routing",
    short(safeAdvisory, 500),
    "",
    "### Runtime version",
    versionBlock,
  ];
  // Rendered on every turn: the scaffold carries the turn's modality and its
  // mutation rules, so dedupeInjectedContext must see it to resend it when the
  // modality changes. An unchanged scaffold is still never re-injected.
  sections.push("", "### Reasoning scaffold", short(scaffoldText, 700));
  return capContext(sections.join("\n"), maxChars);
}

// Session mining (2026-07-11): 237 of 245 cognitive-automation injections in
// one session were byte-identical ~6.7KB blocks - 1.65MB of repeated static
// preamble per long session. Injection is once-per-content now: identical
// context injects nothing, and a changed context re-injects only the
// sections that differ (the model already has the rest).
function contextSections(context) {
  const chunks = String(context || "").split(/\n(?=### )/);
  const sections = new Map();
  for (const chunk of chunks) sections.set(chunk.startsWith("### ") ? chunk.split("\n", 1)[0] : "", chunk);
  return sections;
}
function dedupeInjectedContext(previousContext, currentContext, { maxChars = 2500 } = {}) {
  if (!previousContext) return { inject: capContext(currentContext, maxChars), reason: "first" };
  if (previousContext === currentContext) return { inject: null, reason: "identical" };
  const previous = contextSections(previousContext);
  const changed = [];
  for (const [title, chunk] of contextSections(currentContext)) {
    if (previous.get(title) !== chunk) changed.push(chunk);
  }
  if (!changed.length) return { inject: null, reason: "identical" };
  return {
    inject: capContext(["## Cognitive context update (changed sections only; earlier context still applies unless superseded)", AUTHORITY_NOTICE, ...changed].join("\n"), maxChars),
    reason: "delta",
  };
}

module.exports = { renderInjectedReasoningContext, richScaffold, dedupeInjectedContext, capContext, selectInjectionMemory, isSuccessfulProofHistory, withoutDuplicateObjective };
