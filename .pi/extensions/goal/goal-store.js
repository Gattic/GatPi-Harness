"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const GOAL_STATE_SCHEMA_VERSION = 1;
const FINAL_STATUSES = new Set(["completed", "blocked", "failed", "cancelled"]);

function safeName(name) {
  return String(name || "repo").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function defaultStateDir(cwd) {
  return path.join(cwd, ".pi", "goal-state");
}

function makeGoalId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `goal_${stamp}_${random}`;
}

class GoalStore {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.file = options.file || path.join(defaultStateDir(this.cwd), `${safeName(path.basename(this.cwd))}.json`);
    this.archiveFile = options.archiveFile || this.file.replace(/\.json$/, ".archive.json");
  }

  async readAll() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
      return Array.isArray(parsed.goals) ? parsed.goals : [];
    } catch (error) {
      if (error && error.code === "ENOENT") return [];
      if (error instanceof SyntaxError) throw new Error(`Goal store is malformed: ${this.file}`);
      throw error;
    }
  }

  async writeAll(goals) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ goals }, null, 2) + "\n", "utf8");
    await fs.rename(tmp, this.file);
  }

  async readArchive() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.archiveFile, "utf8"));
      return Array.isArray(parsed.goals) ? parsed.goals : [];
    } catch (error) {
      if (error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async appendArchive(goals) {
    if (!goals.length) return;
    let archived = [];
    try {
      archived = await this.readArchive();
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
    await fs.mkdir(path.dirname(this.archiveFile), { recursive: true });
    const tmp = `${this.archiveFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ goals: [...archived, ...goals] }, null, 2) + "\n", "utf8");
    await fs.rename(tmp, this.archiveFile);
  }

  async create(goal, options = {}) {
    const now = new Date().toISOString();
    const approvedTopologyIds = [...new Set((options.approvedTopologyIds || []).map((id) => String(id || "").trim()).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)))];
    const state = {
      schemaVersion: GOAL_STATE_SCHEMA_VERSION,
      id: options.id || makeGoalId(),
      goal,
      status: "running",
      iteration: 0,
      maxIterations: Number.isFinite(options.maxIterations) ? options.maxIterations : 50,
      completionEvidenceIds: [],
      evidenceFingerprints: {},
      actionAuthority: { approvedTopologyIds, source: approvedTopologyIds.length ? "current-user-command" : "none" },
      controllerRepairTurns: 0,
      observations: [],
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    const goals = await this.readAll();
    goals.push(state);
    await this.writeAll(goals);
    return state;
  }

  async save(state) {
    const goals = await this.readAll();
    const next = { ...state, schemaVersion: GOAL_STATE_SCHEMA_VERSION, observations: state.observations || [], history: state.history || [], updatedAt: new Date().toISOString() };
    const index = goals.findIndex((goal) => goal.id === next.id);
    if (index >= 0) goals[index] = next;
    else goals.push(next);
    await this.writeAll(goals);
    return next;
  }

  async get(id) {
    return (await this.readAll()).find((goal) => goal.id === id);
  }

  async getActive() {
    const goals = await this.readAll();
    return [...goals].reverse().find((goal) => goal.status === "running");
  }

  async getMostRecentUnfinished() {
    const goals = await this.readAll();
    return [...goals].reverse().find((goal) => !FINAL_STATUSES.has(goal.status) || ["running", "blocked"].includes(goal.status));
  }

  async getMostRecent() {
    return (await this.readAll()).at(-1);
  }

  async cancelActive(reason = "Cancelled by user") {
    const active = await this.getActive();
    if (!active) return undefined;
    active.status = "cancelled";
    active.observations = [...(active.observations || []), `[${new Date().toISOString()}] ${reason}`];
    return this.save(active);
  }

  async archiveFinalStatuses(statuses = [...FINAL_STATUSES], options = {}) {
    const statusSet = new Set(statuses);
    const olderThanMs = options.olderThanMs;
    const cutoff = Number.isFinite(olderThanMs) ? Date.now() - olderThanMs : undefined;
    const goals = await this.readAll();
    const shouldArchive = (goal) => {
      if (!statusSet.has(goal.status)) return false;
      if (!cutoff) return true;
      const updated = Date.parse(goal.updatedAt || goal.createdAt || 0);
      return Number.isFinite(updated) && updated <= cutoff;
    };
    const archive = goals.filter(shouldArchive);
    const keep = goals.filter((goal) => !shouldArchive(goal));
    await this.appendArchive(archive);
    await this.writeAll(keep);
    return { archived: archive.length, remaining: keep.length, archiveFile: this.archiveFile };
  }

  async pruneFinalGoals(keepRecent = 20) {
    const goals = await this.readAll();
    const final = goals.filter((goal) => FINAL_STATUSES.has(goal.status));
    const unfinished = goals.filter((goal) => !FINAL_STATUSES.has(goal.status));
    const sortedFinal = final.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
    const keepFinal = sortedFinal.slice(0, Math.max(0, keepRecent));
    const archive = sortedFinal.slice(Math.max(0, keepRecent));
    await this.appendArchive(archive);
    await this.writeAll([...unfinished, ...keepFinal].sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0)));
    return { archived: archive.length, remaining: unfinished.length + keepFinal.length, archiveFile: this.archiveFile };
  }

  async clearAll() {
    const goals = await this.readAll();
    await this.appendArchive(goals);
    await this.writeAll([]);
    return { archived: goals.length, remaining: 0, archiveFile: this.archiveFile };
  }

  async getMetrics({ includeArchive = true } = {}) {
    const goals = await this.readAll();
    const archived = includeArchive ? await this.readArchive() : [];
    const all = [...goals, ...archived];
    const byStatus = {};
    let totalIterations = 0;
    const blockedReasons = new Map();
    const actionKinds = {};
    const proofRejections = {};
    const actionLatencies = [];
    let dispatchMismatches = 0;
    let extraControllerTurns = 0;
    for (const goal of all) {
      byStatus[goal.status] = (byStatus[goal.status] || 0) + 1;
      totalIterations += Number(goal.iteration || 0);
      extraControllerTurns += Number(goal.controllerRepairTurns || 0);
      for (const record of goal.history || []) {
        const kind = record?.action?.kind || record?.attemptedActionKind;
        if (kind) actionKinds[kind] = (actionKinds[kind] || 0) + 1;
        if (record?.actionResultCode === "dispatch-mismatch" || /mismatch/.test(record?.reasonCode || "")) dispatchMismatches += 1;
        if (record?.proofRejectionReason) proofRejections[record.proofRejectionReason] = (proofRejections[record.proofRejectionReason] || 0) + 1;
        if (Number.isFinite(Number(record?.actionLatencyMs))) actionLatencies.push(Number(record.actionLatencyMs));
      }
      if (goal.status === "blocked") {
        const last = [...(goal.history || [])].reverse().find((record) => record?.reasonCode || record?.reason || record?.error);
        const reason = last?.reasonCode || last?.reason || last?.error || (goal.observations || []).at(-1) || "unknown";
        const key = String(reason).slice(0, 160);
        blockedReasons.set(key, (blockedReasons.get(key) || 0) + 1);
      }
    }
    return {
      total: all.length,
      activeStore: goals.length,
      archived: archived.length,
      byStatus,
      averageIterations: all.length ? totalIterations / all.length : 0,
      actionKinds,
      dispatchMismatches,
      proofRejections,
      extraControllerTurns,
      actionLatencyMs: { count: actionLatencies.length, average: actionLatencies.length ? actionLatencies.reduce((sum, value) => sum + value, 0) / actionLatencies.length : 0, max: actionLatencies.length ? Math.max(...actionLatencies) : 0 },
      commonBlockedReasons: [...blockedReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count })),
    };
  }
}

module.exports = { GoalStore, GOAL_STATE_SCHEMA_VERSION, FINAL_STATUSES, makeGoalId };
