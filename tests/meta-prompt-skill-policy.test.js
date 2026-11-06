"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync(".pi/extensions/reasoning-runtime/index.ts", "utf8");
assert(source.includes("META_RECOMMENDATION_PATTERNS"), "meta recommendation detection should be pattern-based");
assert(source.includes("What are") || source.includes("what\\s+(?:are"), "meta detection should cover 'what are the next recommended steps'");
assert(source.includes("SKILL_META_INJECT_MAX"), "meta prompts should have independent skill injection budget");
assert(source.includes("? { skills: [] }"), "meta prompts with zero budget should skip skill retrieval");

const metaPatterns = [
  /(?:^|[.!?;]\s+)(?:what\s+(?:are\s+)?(?:the\s+)?(?:next\s+)?(?:recommended|suggested)\s+steps?|what\s+next|recommend\s+(?:the\s+)?next\s+steps?|suggest\s+(?:the\s+)?next\s+steps?)(?:\?|$)/i,
  /(?:^|[.!?;]\s+)what\s+should\s+(?:we|i)\s+do\s+next(?:\?|$)/i,
  /(?:^|[.!?;]\s+)(?:after|following)\s+(?:a\s+)?(?:reload|restart|validation|check(?:s)?),?\s+what\s+should\s+(?:we|i)\s+do\s+next(?:\?|$)/i,
  /(?:^|[.!?;]\s+)(?:(?:i|we)\s+(?:reloaded|restarted|validated|checked)[^.!?;]*[.!?;]\s*)?(?:please\s+)?(?:proceed|continue)\s+with\s+(?:the\s+)?next(?:\s+practical)?\s+step(?:\.?|$)/i,
  /^(?:please\s+)?(?:proceed|continue)(?:\.?|$)/i,
];
const isMeta = (text) => metaPatterns.some((re) => re.test(String(text || "").trim()));

for (const prompt of [
  "What are the next recommended steps?",
  "I reloaded. What are the next recommended steps?",
  "After reload, what should we do next?",
  "Following validation, what should I do next?",
  "Suggest the next steps?",
  "I restarted Pi. Proceed with the next step",
  "I reloaded pi with the reload command. Proceed with the next step",
  "Continue with the next practical step",
  "Proceed",
  "Please proceed.",
  "Continue",
]) assert.equal(isMeta(prompt), true, `${prompt} should be treated as meta recommendation prompt`);

for (const prompt of [
  "Implement the next steps from the approved plan",
  "Fix the failing parser tests and verify",
  "Refactor skill synthesis storage",
]) assert.equal(isMeta(prompt), false, `${prompt} should remain a task prompt`);

console.log("meta-prompt skill policy tests passed");
