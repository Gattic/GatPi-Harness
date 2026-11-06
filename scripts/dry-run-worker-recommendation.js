#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { applyHarnessEnvironmentDefaults } = require("../src/harness-environment");
const { MultiAgentTopologyAdapter, MemoryJsonStorage, NullSink } = require("../src/integration-boundary");
const { decideRoleRoute } = require("../src/role-router");

const HARNESS_ROOT = path.resolve(__dirname, "..");

function gitOutput(project, args) { return execFileSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function statusFingerprint(project) { return crypto.createHash("sha256").update(gitOutput(project, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).digest("hex"); }
function recommendationEnvironment(overrides = {}) {
  const env = {
    PI_ROLE_ROLLOUT_STAGE: "R0",
    PI_TOPOLOGY_AUTO_ROUTE: "suggest",
    PI_ROLE_MUTATION: "off",
    PI_ROLE_WORKER_SHADOW_CANARY: "0",
    ...overrides,
  };
  applyHarnessEnvironmentDefaults({ root: HARNESS_ROOT, env });
  return env;
}
function dryRunWorkerRecommendation({ project, task, env: environment = {} } = {}) {
  const requestedProject = path.resolve(project || process.cwd());
  const projectRoot = gitOutput(requestedProject, ["rev-parse", "--show-toplevel"]).trim();
  const beforeStatusHash = statusFingerprint(projectRoot);
  const env = recommendationEnvironment(environment);
  if (env.PI_ROLE_ROLLOUT_STAGE !== "R0" || env.PI_TOPOLOGY_AUTO_ROUTE !== "suggest" || env.PI_ROLE_MUTATION !== "off") throw new Error("worker recommendation dry-run requires explicit R0/suggest/mutation-off controls");
  const decision = decideRoleRoute(task, { mode: "suggest" });
  if (decision.recommendedRoleId !== "worker" || decision.execute !== false) throw new Error(`task is not eligible for a safe worker recommendation: ${decision.reasonCode || "unmatched"}`);
  const topologies = new MultiAgentTopologyAdapter({ storage: new MemoryJsonStorage(), sink: new NullSink() });
  const recommendation = topologies.recommendRole(decision.recommendedRoleId, { env });
  const afterStatusHash = statusFingerprint(projectRoot);
  return {
    schemaVersion: 1,
    project: path.basename(projectRoot),
    taskHash: crypto.createHash("sha256").update(String(task || "")).digest("hex"),
    controls: { rolloutStage: env.PI_ROLE_ROLLOUT_STAGE, routerMode: env.PI_TOPOLOGY_AUTO_ROUTE, roleMutation: env.PI_ROLE_MUTATION },
    decision: { mode: "suggest", intent: decision.intent, reasonCode: decision.reasonCode, execute: decision.execute, topologyId: decision.topologyId },
    recommendation,
    effects: { providerCalls: 0, subagentsStarted: 0, topologiesStarted: 0, roleMutations: 0, filesMutated: 0, worktreeStatusUnchanged: beforeStatusHash === afterStatusHash },
  };
}
function parseArgs(argv) {
  const args = { project: process.cwd(), task: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--project") args.project = argv[++index];
    else if (token === "--task") args.task = argv[++index];
    else throw new Error(`unknown argument: ${token}`);
  }
  if (!args.task) throw new Error("usage: dry-run-worker-recommendation.js --project <git-project> --task <bounded-readonly-task>");
  return args;
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(dryRunWorkerRecommendation(parseArgs(process.argv.slice(2))), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error?.message || String(error)}\n`); process.exitCode = 1; }
}

module.exports = { recommendationEnvironment, dryRunWorkerRecommendation, statusFingerprint };
