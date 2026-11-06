"use strict";

// Parse plans into bounded, conflict-aware Roles v2 worker specifications.
// Workers receive compact scopes rather than the full conversation/plan and
// mutating workers can only propose patches from isolated Git worktrees.

const { DEFAULT_ROLE_CONTRACTS } = require("./role-contracts");

const FILE_TOKEN = /`([^`\s]+\.[A-Za-z0-9]{1,8}|[^`\s]+\/)`/g;
const DEFAULT_RPC_CONCURRENCY = 2;
const DEFAULT_MAX_WORKERS = 8;
const HARD_MAX_WORKERS = 16;
const HANDLED_OUTCOMES = Object.freeze(["succeeded", "timed_out", "invalid_output", "partial_patch", "cancelled", "failed"]);
const CONTRACTS = new Map(DEFAULT_ROLE_CONTRACTS.map((role) => [role.roleId, role]));

function parsePlanItems(text) {
  const items = [];
  let phase = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    if (heading) { phase = heading[1].trim(); continue; }
    const checklist = line.match(/^[-*]\s+\[( |x|X)\]\s+(.+)$/);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (checklist && checklist[1] !== " ") continue;
    const body = checklist ? checklist[2] : numbered ? numbered[1] : null;
    if (!body) continue;
    const files = [...body.matchAll(FILE_TOKEN)].map((match) => match[1]);
    items.push({ id: `item-${items.length + 1}`, phase, text: body.trim(), files: [...new Set(files)] });
  }
  return items;
}
function roleForItem(item) {
  const text = String(item.text || "");
  if (/\b(?:refactor|restructure|cleanup|deduplicate)\b/i.test(text)) return "refactorer";
  if (/\b(?:implement|add|fix|repair|update|change|modify|edit|write|create|remove|delete|document|unify|migrate|integrate)\b/i.test(text)) return "coder";
  if (/\b(?:verify|validate|run\s+tests?|test\s+(?:the|this))\b/i.test(text)) return "verifier";
  if (/\b(?:review|audit|inspect|critique|check)\b/i.test(text)) return "reviewer";
  if (/\b(?:plan|design|outline|propose)\b/i.test(text)) return "planner";
  return "researcher";
}
function dependencyIds(item, index, items) {
  const earlier = items.slice(0, index);
  const files = new Set(item.files);
  const conflicts = earlier.filter((candidate) => candidate.files.some((file) => files.has(file)));
  const phaseBoundary = earlier.length && earlier.at(-1).phase !== item.phase ? earlier.filter((candidate) => candidate.phase !== item.phase) : [];
  return [...new Set([...conflicts, ...phaseBoundary].map((candidate) => candidate.id))];
}
function workerTask(worker, otherFiles, planFile) {
  const lines = [
    `Execute exactly ${worker.id}${planFile ? ` from ${planFile}` : ""}: ${worker.item}`,
    `Registered roleId: ${worker.roleId}. workspacePolicy: ${worker.workspacePolicy}. mutationPolicy: ${worker.mutationPolicy}.`,
    `Primary file zones: ${worker.fileZones.length ? worker.fileZones.join(", ") : "No paths were named; stop and report the exact paths you propose before touching files."}`,
    otherFiles.length ? `Other worker zones: ${otherFiles.join(", ")}. Do not cross them; overlapping zones are serialized by dependencies.` : "",
    worker.dependencies.length ? `Dependencies that must settle first: ${worker.dependencies.join(", ")}.` : "Dependencies: none.",
    `Budget: maxModelCalls=${worker.budget.maxModelCalls}, maxToolCalls=${worker.budget.maxToolCalls}, wallClockMs=${worker.budget.wallClockMs}.`,
    "Return the registered typed result with bounded summary, findings, evidence, changed paths/proposed patch metadata when applicable, uncertainty, and verification outcomes.",
    "Treat timed_out, invalid_output, partial_patch, cancelled, and failed as explicit non-success outcomes. Never claim that a proposed patch changed the parent tree.",
  ].filter(Boolean);
  return lines.join("\n");
}
function scheduleWaves(workers, concurrency) {
  const waveById = new Map();
  const waves = [];
  for (const worker of workers) {
    const dependencyWave = worker.dependencies.reduce((max, id) => Math.max(max, waveById.get(id) ?? -1), -1);
    let index = dependencyWave + 1;
    while ((waves[index]?.length || 0) >= concurrency) index += 1;
    waves[index] ||= [];
    waves[index].push(worker.id);
    waveById.set(worker.id, index);
    worker.wave = index + 1;
  }
  return waves.map((workerIds, index) => ({ wave: index + 1, concurrency: Math.min(concurrency, workerIds.length), workerIds }));
}
function buildFanout(cwd, planText, options = {}) {
  const items = parsePlanItems(planText);
  if (!items.length) return { cwd, items: [], workers: [], waves: [], dropped: [], concurrency: DEFAULT_RPC_CONCURRENCY, maxWorkers: 0, guidance: "No plan items found. Expected markdown checklists (- [ ] item) or numbered lists; file paths in backticks become conflict zones." };
  const requestedMax = Number(options.maxAgents ?? options.maxWorkers);
  const maxWorkers = Math.max(1, Math.min(HARD_MAX_WORKERS, Number.isFinite(requestedMax) && requestedMax > 0 ? Math.floor(requestedMax) : DEFAULT_MAX_WORKERS));
  const concurrency = Math.max(1, Math.min(DEFAULT_RPC_CONCURRENCY, Number(options.concurrency || DEFAULT_RPC_CONCURRENCY)));
  const selected = items.slice(0, maxWorkers);
  const dropped = items.slice(maxWorkers);
  const workers = selected.map((item, index) => {
    const roleId = roleForItem(item);
    const contract = CONTRACTS.get(roleId);
    const others = selected.filter((other) => other.id !== item.id);
    const otherFiles = [...new Set(others.flatMap((other) => other.files))];
    const conflicts = item.files.filter((file) => otherFiles.includes(file));
    const dependencies = dependencyIds(item, index, selected);
    const worker = {
      id: item.id,
      phase: item.phase,
      item: item.text,
      roleId,
      roleContractVersion: contract.contractVersion,
      workspacePolicy: contract.workspacePolicy,
      mutationPolicy: contract.mutationPolicy,
      fileZones: [...item.files],
      files: [...item.files],
      conflicts,
      dependencies,
      budget: { ...contract.budget },
      mergePolicy: contract.mutationPolicy === "forbidden" ? "summary_only" : "proposed_patch",
      expectedOutputSchema: JSON.parse(JSON.stringify(contract.outputSchema)),
      verificationRequirements: contract.mutationPolicy === "forbidden" ? ["cite inspected paths", "report uncertainty", "validate typed result"] : ["run the narrowest applicable check", "report exact command/outcome evidence", "preview proposed patch before parent apply"],
      handledOutcomes: [...HANDLED_OUTCOMES],
      contextPacket: { kind: "role-fanout-context-v2", planFile: options.planFile || null, phase: item.phase, itemId: item.id, task: item.text, fileZones: [...item.files] },
      task: "",
    };
    worker.task = workerTask(worker, otherFiles, options.planFile);
    return worker;
  });
  const waves = scheduleWaves(workers, concurrency);
  return { cwd, planFile: options.planFile || null, items, workers, waves, dropped, concurrency, maxWorkers, guidance: null };
}

module.exports = { FILE_TOKEN, DEFAULT_RPC_CONCURRENCY, DEFAULT_MAX_WORKERS, HARD_MAX_WORKERS, HANDLED_OUTCOMES, parsePlanItems, roleForItem, buildFanout };
