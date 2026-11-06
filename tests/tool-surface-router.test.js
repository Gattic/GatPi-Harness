"use strict";

const assert = require("node:assert/strict");
const {
  MANAGED_TOOL_NAMES,
  classifyTask,
  explicitToolNames,
  routeToolSurface,
  activationCatalog,
  activateManagedTools,
  toolReadiness,
} = require("../src/tool-surface-router.js");

const all = [
  "read", "bash", "edit", "write", "test_runner", "repo_context",
  "debug_ledger", "fix_recall", "safe_try", "evidence_inbox",
  "create_subagent", "run_topology", "skill_synthesis", "automation_loop",
  "codegraph_status", "codegraph_query", "codegraph_context", "codegraph_affected", "codegraph_sync", "codegraph_doctor",
  "semgrep_status", "semgrep_scan", "semgrep_codegraph", "semgrep_doctor",
  "memory_explorer", "memory_curator", "obsidian_status", "obsidian_search", "hermes_advisory",
  "extension_ops", "privacy_guard", "runtime_doctor", "performance_optimizer", "roadmap_update",
  "run_deck", "run_monitor", "ci_pr_companion", "commit_plan", "evidence_binder",
  "pi_queue_status", "pi_queue_list",
];
const initial = [...all];
// After session start only the unmanaged baseline is active.
const fresh = all.filter((name) => !MANAGED_TOOL_NAMES.includes(name));
const route = (prompt, overrides = {}) => routeToolSurface({
  prompt,
  cwd: process.cwd(),
  // Keep this suite on environment precedence; the repository's declared M1
  // posture intentionally exposes memory_curator on every turn and is covered
  // by project-memory-automatic.test.js.
  env: { PI_PROJECT_MEMORY_POSTURE: "env" },
  allToolNames: all,
  initialActiveToolNames: initial,
  currentActiveToolNames: fresh,
  commandAvailable: () => false,
  ...overrides,
});

assert(MANAGED_TOOL_NAMES.includes("run_topology"));
const queueTools = ["pi_queue_list", "pi_queue_status"];
assert.deepEqual(route("How long is the request queue right now?").selectedTools, ["pi_queue_status"], "an intent activates the named tool, not the whole queue group");
assert.deepEqual(route("List the pending requests in the queue").selectedTools, ["pi_queue_list"]);
assert(queueTools.every((name) => !route("Explain this local function").activeTools.includes(name)), "Queue inspection tools are task-routed like other optional capabilities");
const disabledQueue = route("Inspect the queue", { env: { PI_QUEUE: "0" } });
assert(disabledQueue.blockedTools.some((row) => row.tool === "pi_queue_status" && row.reason === "disabled:PI_QUEUE"));
assert(MANAGED_TOOL_NAMES.includes("hermes_advisory"));
assert(!MANAGED_TOOL_NAMES.includes("roadmap_update"), "Roadmap is baseline planning capability, not an explicit-keyword-only tool");
assert.deepEqual(classifyTask("Fix this flaky crash"), ["debug"]);
assert.deepEqual(explicitToolNames("Please use run_topology, not bash.", all), ["bash", "run_topology"]);

const baseline = route("Explain this local function");
assert.deepEqual(baseline.selectedTools, []);
assert(baseline.activeTools.includes("read") && baseline.activeTools.includes("test_runner"));
assert(!baseline.activeTools.includes("run_topology"));
assert(!Object.prototype.hasOwnProperty.call(baseline, "prompt"), "router does not return or persist prompt text");
for (const prompt of ["", "Investigate and fix the flaky cache invalidation", "Review then commit our changes", "Continue", "Explain this local function"]) {
  const routed = route(prompt, { env: { PI_TOPOLOGY_AUTO_ROUTE: "off" } });
  assert(routed.baselineTools.includes("roadmap_update"), "startup and ordinary tasks retain proactive planning without requesting a roadmap");
  assert(!routed.activeTools.includes("run_topology"), "baseline roadmap availability does not enable topology");
}

const debug = route("Use debug_ledger and safe_try for this flaky regression and checkpoint the risky attempt");
assert(debug.intents.includes("debug"));
assert(debug.selectedTools.includes("debug_ledger"));
assert(debug.selectedTools.includes("safe_try"));
assert(!debug.selectedTools.includes("run_topology"));

const explicit = route("Use run_topology operation=recipes for this topology catalog request");
assert(explicit.selectedTools.includes("run_topology"));
assert(explicit.explicitTools.includes("run_topology"));
assert(explicit.opportunities.some((row) => row.trigger === "topology-admin-intent"));
const multiOpportunity = route("Review extension telemetry and a latency regression with captured evidence from a screenshot");
assert.deepEqual(multiOpportunity.opportunities.map((row) => row.trigger), ["extension-ops-intent", "performance-intent", "evidence-artifact-intent"]);

const hermes = route("Use Hermes to review the bounded evidence");
assert(hermes.selectedTools.includes("hermes_advisory"));

const unavailableGraph = route("Use codegraph_query to inspect the dependency graph");
assert.deepEqual(unavailableGraph.selectedTools, [], "only the requested graph tool is selected, so nothing else is activated");
assert(unavailableGraph.blockedTools.some((row) => row.tool === "codegraph_query" && row.reason === "provider-unavailable:codegraph"));
assert(!unavailableGraph.blockedTools.some((row) => row.tool === "codegraph_status" || row.tool === "codegraph_doctor"), "sibling graph tools stay in the activation catalog instead of the blocked list");

const readyGraph = route("Use codegraph_query to inspect the dependency graph", { commandAvailable: (name) => name === "codegraph" });
assert.deepEqual(readyGraph.selectedTools, ["codegraph_query"]);
assert.deepEqual(route("Use codegraph_status to inspect the dependency graph", { commandAvailable: () => true }).selectedTools, ["codegraph_status"], "an exact name does not activate the group's primary too");
assert.deepEqual(route("Run a privacy audit").selectedTools, ["privacy_guard"], "a specialized governance intent does not activate unrelated inventory tools");
assert.deepEqual(route("Show codegraph status", { commandAvailable: (name) => name === "codegraph" }).selectedTools, ["codegraph_status"]);
assert.deepEqual(route("Which affected tests cover this change", { commandAvailable: (name) => name === "codegraph" }).selectedTools, ["codegraph_affected"]);
assert.deepEqual(route("Sync the index", { commandAvailable: (name) => name === "codegraph" }).selectedTools, ["codegraph_sync"]);
assert.deepEqual(route("Run semgrep on the changed files", { env: { PI_PROJECT_MEMORY_POSTURE: "env", PI_SEMGREP: "1" }, commandAvailable: () => true }).selectedTools, ["semgrep_codegraph"], "changed-file scans prefer the combined scan");

const explicitlyDisabled = routeToolSurface({
  prompt: "Use run_topology",
  cwd: process.cwd(),
  env: {},
  allToolNames: all,
  initialActiveToolNames: initial.filter((name) => name !== "run_topology"),
  currentActiveToolNames: initial.filter((name) => name !== "run_topology"),
  commandAvailable: () => true,
});
assert(!explicitlyDisabled.activeTools.includes("run_topology"), "router respects tools disabled before session start");
const noRoadmap = initial.filter((name) => name !== "roadmap_update");
assert(!route("Use roadmap_update to track this plan", { initialActiveToolNames: noRoadmap, currentActiveToolNames: noRoadmap }).activeTools.includes("roadmap_update"), "explicit exclusions remain respected even when Roadmap is named");
assert(!route("Continue implementing the plan", { initialActiveToolNames: ["read"], currentActiveToolNames: ["read"] }).activeTools.includes("roadmap_update"), "restricted child roles do not acquire roadmap mutation authority");

assert.equal(toolReadiness("semgrep_scan", { env: { PI_SEMGREP: "0" }, commandAvailable: () => true }).ready, false);
assert.deepEqual(route("Debug this flaky regression"), route("Debug this flaky regression"), "routing is deterministic");

// Within a session the surface only grows, because every change to the active
// set invalidates the provider's prompt cache; session start resets it.
const debugging = route("Debug this flaky regression").activeTools;
const explained = route("Explain the scoring rules.", { currentActiveToolNames: debugging });
assert.deepEqual([...explained.activeTools].sort(), [...debugging].sort(), "a later turn keeps the active tools even when it needs none of them");
assert.deepEqual(explained.addedTools, []);
const committed = route("Now commit it.", { currentActiveToolNames: debugging });
assert(committed.activeTools.includes("commit_plan") && committed.activeTools.includes("debug_ledger"), "a later turn adds to the active tools");
assert.deepEqual(committed.addedTools, ["commit_plan"], "only the new tools are reported as added");
const keptGraph = route("Explain this.", { currentActiveToolNames: readyGraph.activeTools });
assert(keptGraph.activeTools.includes("codegraph_query"), "an active tool is not removed when a provider check would now block it");
const lateRegistered = route("Explain this.", { currentActiveToolNames: [...fresh, "late_registered_tool"] });
assert(lateRegistered.activeTools.includes("late_registered_tool"), "a tool registered after session start stays active");
const reset = route("", { currentActiveToolNames: initial, reset: true });
assert.deepEqual([...reset.activeTools].sort(), [...fresh].sort(), "session start returns to the unmanaged baseline");

// Explicit activation answers the same eligibility, readiness and configuration
// questions as prompt routing, so a tool the model can name is never refused for
// a reason the router would not also report.
const activationBase = {
  cwd: process.cwd(),
  env: { PI_PROJECT_MEMORY_POSTURE: "env" },
  allToolNames: all,
  initialActiveToolNames: initial,
  currentActiveToolNames: fresh,
  commandAvailable: () => false,
};
const catalog = activationCatalog(activationBase);
assert(catalog.find((group) => group.id === "debug").tools.every((row) => row.state === "inactive"), "eligible optional tools are listed as inactive, not missing");
assert(catalog.find((group) => group.id === "security").tools.some((row) => row.name === "semgrep_scan" && row.state === "blocked" && row.reason === "provider-unavailable:semgrep"));

let activation = activateManagedTools({ ...activationBase, tools: ["debug_ledger", "semgrep_scan", "not_a_tool", "read"] });
assert.deepEqual(activation.activated, ["debug_ledger"]);
assert.deepEqual(activation.blocked, [{ tool: "semgrep_scan", reason: "provider-unavailable:semgrep" }]);
assert.deepEqual(activation.unknown, ["not_a_tool", "read"], "only optional managed tools can be activated by name");
assert(activation.activeTools.includes("read") && activation.activeTools.includes("debug_ledger"), "activation is additive over the current surface");

activation = activateManagedTools({ ...activationBase, tools: ["run_topology"] });
assert.deepEqual(activation.activated, ["run_topology"], "a ready optional tool activates by name without a matching prompt");

activation = activateManagedTools({ ...activationBase, currentActiveToolNames: [...fresh, "debug_ledger"], tools: ["debug_ledger"] });
assert.deepEqual(activation.alreadyActive, ["debug_ledger"]);
assert.deepEqual(activation.activated, []);

activation = activateManagedTools({ ...activationBase, initialActiveToolNames: fresh, tools: ["debug_ledger"] });
assert.deepEqual(activation.ineligible, ["debug_ledger"], "a restricted surface cannot activate what was not initially eligible");
assert(!activation.activeTools.includes("debug_ledger"));

activation = activateManagedTools({ ...activationBase, env: { PI_DEBUG_LEDGER: "0" }, tools: ["debug_ledger"] });
assert.deepEqual(activation.blocked, [{ tool: "debug_ledger", reason: "disabled:PI_DEBUG_LEDGER" }]);
assert(activationCatalog({ ...activationBase, env: { PI_DEBUG_LEDGER: "0" } }).find((group) => group.id === "debug").tools.some((row) => row.name === "debug_ledger" && row.state === "blocked" && row.reason === "disabled:PI_DEBUG_LEDGER"));

// A tool that appeared after session start is not in the catalog snapshot; the
// additive result must not deactivate it.
activation = activateManagedTools({ ...activationBase, currentActiveToolNames: [...fresh, "late_registered_tool"], tools: ["debug_ledger"] });
assert(activation.activeTools.includes("late_registered_tool"), "activation preserves active tools outside the session-start snapshot");
console.log("tool surface router tests passed");
