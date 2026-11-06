"use strict";

const crypto = require("node:crypto");
const {
  getProgress,
  loadRoadmap,
  roadmapMutationMetadata,
  saveRoadmap,
  setRoadmapLifecycle,
  setStatus,
  startRoadmap,
} = require("../.pi/extensions/roadmap/roadmap-state.js");

function planFingerprint(plan) {
  return crypto.createHash("sha256").update(JSON.stringify(plan || null)).digest("hex").slice(0, 20);
}

function roadmapFingerprint(roadmap) {
  return crypto.createHash("sha256").update(JSON.stringify(roadmap || null)).digest("hex").slice(0, 20);
}

function applyRoadmapPlan({ cwd = process.cwd(), roadmapPlan, parentId, runId } = {}) {
  if (!roadmapPlan || typeof roadmapPlan !== "object" || Array.isArray(roadmapPlan)) throw new Error("topology planner did not return a roadmapPlan object");
  const current = loadRoadmap(cwd);
  const next = startRoadmap(current, roadmapPlan.title, [], {
    source: "topology-planner-plan",
    sourceArtifactId: runId,
    parentId,
    milestones: roadmapPlan.milestones,
  });
  const saved = saveRoadmap(cwd, next);
  const changed = roadmapMutationMetadata(current, saved);
  const progress = getProgress(saved);
  const roadmapId = changed.roadmapId || saved.id;
  const appliedRoadmap = findRoadmapById(saved, roadmapId);
  return {
    applied: true,
    planFingerprint: planFingerprint(roadmapPlan),
    roadmapFingerprint: roadmapFingerprint(appliedRoadmap),
    roadmapId,
    nested: changed.nested === true,
    parentRoadmapId: changed.parentRoadmapId || null,
    parentItemId: changed.parentItemId || null,
    itemCount: progress.total,
  };
}

function findRoadmapById(roadmap, roadmapId) {
  if (!roadmap) return null;
  if (roadmap.id === roadmapId) return roadmap;
  for (const item of roadmap.items || []) {
    for (const subtask of item.subtasks || []) {
      const found = findRoadmapById(subtask, roadmapId);
      if (found) return found;
    }
  }
  return null;
}

function postOrderItems(roadmap, output = []) {
  for (const item of roadmap?.items || []) {
    for (const subtask of item.subtasks || []) postOrderItems(subtask, output);
    output.push({ id: item.id, status: item.status });
  }
  return output;
}

function reconciliationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function reconcileRoadmapPlan({ cwd = process.cwd(), application, runId, status, reason } = {}) {
  if (!application?.applied || !application.roadmapId) throw reconciliationError("TOPOLOGY_ROADMAP_RECONCILIATION_INVALID", "topology roadmap reconciliation requires an applied roadmap binding");
  const current = loadRoadmap(cwd);
  const target = findRoadmapById(current, application.roadmapId);
  if (!target || target.source !== "topology-planner-plan" || target.sourceArtifactId !== runId) {
    throw reconciliationError("TOPOLOGY_ROADMAP_RECONCILIATION_STALE", `applied topology roadmap is stale or unrelated: ${application.roadmapId}`);
  }
  const progress = getProgress(target);
  if (status === "succeeded") {
    if (progress.total > 0 && progress.complete === progress.total) return { reconciled: true, changed: false, outcome: "already-completed", roadmapId: target.id, parentRoadmapId: application.parentRoadmapId || null, parentItemId: application.parentItemId || null, itemCount: progress.total, parentItemAdvanced: false };
    if (progress.unresolved === 0) throw reconciliationError("TOPOLOGY_ROADMAP_RECONCILIATION_CONFLICT", `successful topology roadmap was previously settled without completion: ${target.id}`);
    if (application.roadmapFingerprint && roadmapFingerprint(target) !== application.roadmapFingerprint) throw reconciliationError("TOPOLOGY_ROADMAP_RECONCILIATION_STALE", `applied topology roadmap changed before settlement: ${target.id}`);
    if (target.lifecycle?.status !== "active") throw reconciliationError("TOPOLOGY_ROADMAP_RECONCILIATION_CONFLICT", `successful topology roadmap is not active: ${target.id}`);
    let next = current;
    for (const item of postOrderItems(target)) {
      if (["done", "verified", "verified-unsubstantiated", "skipped", "archived"].includes(item.status)) continue;
      next = setStatus(next, item.id, "done", { artifactId: runId, provenance: "batch" });
    }
    const saved = saveRoadmap(cwd, next);
    const settled = findRoadmapById(saved, target.id);
    return { reconciled: true, changed: true, outcome: "completed", roadmapId: target.id, parentRoadmapId: application.parentRoadmapId || null, parentItemId: application.parentItemId || null, itemCount: getProgress(settled).total, parentItemAdvanced: false };
  }
  if (target.lifecycle?.status === "shelved" && progress.unresolved === 0) return { reconciled: true, changed: false, outcome: "already-shelved", roadmapId: target.id, parentRoadmapId: application.parentRoadmapId || null, parentItemId: application.parentItemId || null, itemCount: progress.total, parentItemAdvanced: false };
  if (application.roadmapFingerprint && roadmapFingerprint(target) !== application.roadmapFingerprint) throw reconciliationError("TOPOLOGY_ROADMAP_RECONCILIATION_STALE", `applied topology roadmap changed before settlement: ${target.id}`);
  let next = current;
  for (const item of postOrderItems(target)) {
    if (["done", "verified", "verified-unsubstantiated", "skipped", "archived"].includes(item.status)) continue;
    next = setStatus(next, item.id, "skipped", { artifactId: runId, provenance: "batch" });
  }
  next = setRoadmapLifecycle(next, "shelved", { roadmapId: target.id, reason: reason || `topology-${String(status || "failed")}` });
  const saved = saveRoadmap(cwd, next);
  const shelved = findRoadmapById(saved, target.id);
  return { reconciled: true, changed: true, outcome: "shelved", roadmapId: target.id, parentRoadmapId: application.parentRoadmapId || null, parentItemId: application.parentItemId || null, itemCount: getProgress(shelved).total, parentItemAdvanced: false };
}

module.exports = { applyRoadmapPlan, reconcileRoadmapPlan, planFingerprint };
