"use strict";

const crypto = require("node:crypto");
function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); return value; }
function manifestHash(manifest) { const payload = { ...manifest }; delete payload.manifestHash; return crypto.createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex"); }
function relativePath(value) { return typeof value === "string" && value.length > 0 && !/^([/\\\\]|[a-z]:)/i.test(value) && !value.split(/[/\\\\]/).includes(".."); }
function validateGoldReviewManifest(manifest, options = {}) {
  const errors = []; const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  if (manifest?.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  if (manifest?.kind !== "code-context-test-selection-gold-review") errors.push("kind is invalid");
  if (!tasks.length) errors.push("tasks must be nonempty");
  if (manifest?.manifestHash !== manifestHash(manifest)) errors.push("manifestHash does not match payload");
  const ids = new Set();
  for (const [index, task] of tasks.entries()) {
    const at = `tasks[${index}]`;
    if (typeof task.prompt !== "string" || !task.prompt.trim()) errors.push(`${at}.prompt is required`);
    if (typeof task.critical !== "boolean") errors.push(`${at}.critical must be reviewed explicitly`);
    if (!task.taskId || ids.has(task.taskId)) errors.push(`${at}.taskId must be unique and nonempty`); ids.add(task.taskId);
    if (!/^[a-f0-9]{40,64}$/.test(task.revision || "")) errors.push(`${at}.revision must pin a Git object ID`);
    if (!Array.isArray(task.sourceFiles) || !task.sourceFiles.length) errors.push(`${at}.sourceFiles must be nonempty`);
    if (!Array.isArray(task.judgments) || !task.judgments.length) errors.push(`${at}.judgments must be nonempty`);
    const paths = new Set();
    for (const [judgmentIndex, judgment] of (task.judgments || []).entries()) {
      const jat = `${at}.judgments[${judgmentIndex}]`;
      if (!relativePath(judgment.path) || paths.has(judgment.path)) errors.push(`${jat}.path must be unique and repository-relative`); paths.add(judgment.path);
      if (!['needs-review', 'relevant', 'not-relevant'].includes(judgment.label)) errors.push(`${jat}.label is invalid`);
      if (judgment.label !== "needs-review" && String(judgment.rationale || "").trim().length < 12) errors.push(`${jat}.rationale is required for a final label`);
    }
    const sourceJudgments = task.sourceJudgments || [];
    if (!sourceJudgments.length) errors.push(`${at}.sourceJudgments must be nonempty`);
    const sourcePaths = new Set();
    for (const judgment of sourceJudgments) {
      if (!relativePath(judgment.path) || sourcePaths.has(judgment.path)) errors.push(`${at}.sourceJudgments path must be unique and repository-relative`);
      sourcePaths.add(judgment.path);
      if (!["needs-review", "relevant", "not-relevant"].includes(judgment.label)) errors.push(`${at}.sourceJudgments label is invalid`);
      if (judgment.label !== "needs-review" && String(judgment.rationale || "").trim().length < 12) errors.push(`${at}.sourceJudgments rationale is required`);
    }
    const approved = task.review?.status === "approved";
    if (options.requireApproved || approved) {
      if (!approved) errors.push(`${at}.review.status must be approved`);
      if (!/^[a-f0-9]{40,64}$/.test(task.parentRevision || "")) errors.push(`${at}.parentRevision must pin a Git object ID`);
      if (!task.taskClasses?.length) errors.push(`${at}.taskClasses require review`);
      if (sourceJudgments.some(j => j.label === "needs-review") || !sourceJudgments.some(j => j.label === "relevant")) errors.push(`${at}.sourceJudgments must be reviewed and retain a relevant source`);
      if (task.review?.reviewer?.kind !== "human" || !String(task.review?.reviewer?.id || "").trim()) errors.push(`${at}.review.reviewer must identify a human`);
      if (!Number.isFinite(Date.parse(task.review?.reviewedAt || ""))) errors.push(`${at}.review.reviewedAt must be an ISO timestamp`);
      if (String(task.review?.rationale || "").trim().length < 20) errors.push(`${at}.review.rationale is required`);
      if (!(task.verifierEvidenceIds || []).length) errors.push(`${at}.verifierEvidenceIds must be nonempty`);
      if ((task.judgments || []).some((judgment) => judgment.label === "needs-review")) errors.push(`${at}.judgments must all have final labels`);
      if (!(task.judgments || []).some((judgment) => judgment.label === "relevant")) errors.push(`${at} must retain at least one relevant test`);
    }
  }
  return { valid: errors.length === 0, errors, tasks: tasks.length, approvedTasks: tasks.filter((task) => task.review?.status === "approved").length };
}
function reviewedGoldByTask(manifest) { const validation = validateGoldReviewManifest(manifest, { requireApproved: true }); if (!validation.valid) { const error = new Error(`gold review manifest is not approved: ${validation.errors.join("; ")}`); error.code = "GOLD_REVIEW_INVALID"; error.validation = validation; throw error; } return new Map(manifest.tasks.map((task) => [task.taskId, { revision: task.revision, parentRevision: task.parentRevision, prompt: task.prompt, critical: task.critical, taskClasses: task.taskClasses, sourceFiles: task.sourceJudgments.filter(j => j.label === "relevant").map(j => j.path).sort(), testFiles: task.judgments.filter((judgment) => judgment.label === "relevant").map((judgment) => judgment.path).sort(), review: task.review, verifierEvidenceIds: task.verifierEvidenceIds }])); }
function applyReviewedGold(tasks, manifest) { const gold = reviewedGoldByTask(manifest); return tasks.map((task) => { const reviewed = gold.get(task.taskId); if (!reviewed) throw new Error(`approved gold missing task ${task.taskId}`); if (reviewed.revision !== task.goldRevision || reviewed.parentRevision !== task.parentRevision) throw new Error(`approved gold revision mismatch for ${task.taskId}`); return { ...task, prompt: reviewed.prompt, critical: reviewed.critical, taskClasses: reviewed.taskClasses, reviewStatus: "approved", gold: { ...task.gold, sourceFiles: reviewed.sourceFiles, testFiles: reviewed.testFiles }, goldReview: reviewed.review, verifierEvidenceIds: reviewed.verifierEvidenceIds }; }); }
module.exports = { stable, manifestHash, validateGoldReviewManifest, reviewedGoldByTask, applyReviewedGold };
