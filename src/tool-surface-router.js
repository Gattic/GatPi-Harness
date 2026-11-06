"use strict";

const { resolveProjectMemoryRollout } = require("./project-memory-rollout");
const { applyProjectMemoryPosture } = require("./project-memory-posture");

const fs = require("node:fs");
const path = require("node:path");

// A matching intent activates the tool the request actually names, not the whole
// capability group: an activated tool schema is resent on every later turn for
// the rest of the session (the surface only grows, to keep the provider prompt
// cache warm). The remaining tools stay reachable through activationCatalog, and
// naming a tool explicitly still activates it.
const GROUPS = Object.freeze([
  {
    id: "queue",
    pattern: /\b(pi[-_ ]queue|request queue|queue(?:d|ing)?|redis)\b/i,
    primary: "pi_queue_status",
    selectors: [
      { tool: "pi_queue_list", pattern: /\b(?:list|show|pending|waiting|which|entries)\b[^.?!]*\b(?:queue|requests?)\b/i },
    ],
    tools: ["pi_queue_status", "pi_queue_list"],
  },
  {
    id: "delegation",
    pattern: /\b(subagents?|delegate|delegation|fan[ -]?out|parallel agents?|multi[ -]?agent|roles?|topolog(?:y|ies)|skill synthesis)\b/i,
    primary: "create_subagent",
    selectors: [
      { tool: "run_topology", pattern: /\b(topolog(?:y|ies)|recipe catalog)\b/i },
      { tool: "auto_role_router", pattern: /\b(role router|auto[- ]?role)\b/i },
      { tool: "skill_synthesis", pattern: /\bskill synthesis\b/i },
      { tool: "role_diff", pattern: /\brole diff\b/i },
      { tool: "role_verify", pattern: /\brole verify\b/i },
    ],
    tools: ["create_subagent", "auto_role_router", "run_topology", "skill_synthesis", "role_diff", "role_verify", "submit_role_result"],
  },
  {
    id: "automation",
    pattern: /\b(automation loop|ralph|repeat(?:edly)?|iterate until|work until complete|autonomous(?:ly)?)\b/i,
    primary: "automation_loop",
    selectors: [],
    tools: ["automation_loop"],
  },
  {
    id: "memory",
    pattern: /\b(memory|remember|forget|recall|obsidian|vault|hermes|research notes?|curat(?:e|ion)|learning loop)\b/i,
    primary: "memory_explorer",
    selectors: [
      { tool: "memory_curator", pattern: /\b(remember|forget|curat(?:e|ion)|memory (?:governance|lifecycle))\b/i },
      { tool: "obsidian_search", pattern: /\bobsidian (?:search|find|look)/i },
      { tool: "obsidian_note", pattern: /\bobsidian note\b/i },
      { tool: "obsidian_import", pattern: /\bobsidian import\b/i },
      { tool: "obsidian_doctor", pattern: /\bobsidian doctor\b/i },
      { tool: "obsidian_hermes", pattern: /\bobsidian hermes\b/i },
      { tool: "hermes_advisory", pattern: /\bhermes\b/i },
      { tool: "learning_loop", pattern: /\blearning loop\b/i },
    ],
    tools: ["memory_explorer", "memory_curator", "obsidian_status", "obsidian_search", "obsidian_note", "obsidian_import", "obsidian_hermes", "obsidian_doctor", "hermes_advisory", "learning_loop"],
  },
  {
    id: "code-index",
    pattern: /\b(codegraph|dependency graph|affected tests?|index (?:status|health|sync)|symbol graph)\b|\b(?:sync|re-?index|refresh)\b[^.?!]*\bindex\b/i,
    primary: "codegraph_query",
    selectors: [
      { tool: "codegraph_status", pattern: /\b(?:codegraph|index) (?:status|health|stats|statistics)\b/i },
      { tool: "codegraph_sync", pattern: /\b(sync|re-?index|full index|refresh the index)\b/i },
      { tool: "codegraph_affected", pattern: /\baffected (?:tests?|files?)\b/i },
      { tool: "codegraph_context", pattern: /\bcodegraph context\b|\btask context\b/i },
      { tool: "codegraph_doctor", pattern: /\bcodegraph doctor\b|\bcodegraph diagnos/i },
    ],
    tools: ["codegraph_status", "codegraph_query", "codegraph_context", "codegraph_affected", "codegraph_sync", "codegraph_doctor"],
  },
  {
    id: "security",
    pattern: /\b(semgrep|security (?:scan|audit|review)|static analysis|injection|secret handling|auth(?:entication|orization)? bug)\b/i,
    primary: "semgrep_scan",
    selectors: [
      { tool: "semgrep_codegraph", pattern: /\b(affected (?:tests?|files?)|codegraph|changed files)\b/i },
      { tool: "semgrep_status", pattern: /\bsemgrep status\b/i },
      { tool: "semgrep_doctor", pattern: /\bsemgrep doctor\b|\bsemgrep diagnos/i },
    ],
    tools: ["semgrep_status", "semgrep_scan", "semgrep_codegraph", "semgrep_doctor"],
  },
  {
    id: "governance",
    pattern: /\b(extension (?:usage|inventory|portfolio|telemetry|operations?|review)|runtime (?:health|latency|memory|performance)|performance (?:profile|regression)|privacy (?:audit|scan)|policy (?:check|approval|grant)|project profil(?:e|ing)|project intelligence|session stabil)\b/i,
    primary: "extension_ops",
    selectors: [
      { tool: "runtime_doctor", pattern: /\bruntime (?:doctor|health)\b|\blatency (?:regression|spike)\b/i },
      { tool: "performance_optimizer", pattern: /\bperformance (?:profile|regression)\b|\bhot path\b/i },
      { tool: "privacy_guard", pattern: /\bprivacy (?:audit|scan)\b/i },
      { tool: "policy_gate", pattern: /\bpolicy (?:check|approval|grant)\b/i },
      { tool: "policy_enforcer", pattern: /\bpolicy enforc/i },
      { tool: "project_intelligence", pattern: /\bproject intelligence\b/i },
      { tool: "project_profiler", pattern: /\bproject profil/i },
      { tool: "session_stabilizer", pattern: /\bsession stabil/i },
    ],
    tools: ["extension_ops", "privacy_guard", "policy_gate", "policy_enforcer", "project_intelligence", "project_profiler", "runtime_doctor", "session_stabilizer", "performance_optimizer"],
  },
  {
    id: "long-run",
    pattern: /\b(long[ -]?running|training run|download|pretokeni[sz]|generation run|run deck|monitor|notify (?:me )?(?:when|on)|watch (?:the )?(?:run|job|process)|server readiness)\b/i,
    primary: "run_deck",
    selectors: [
      { tool: "run_monitor", pattern: /\bmonitor\b|\bnotify (?:me )?(?:when|on)\b|\bwatch (?:the )?(?:run|job|process)\b/i },
      { tool: "experiment_ledger", pattern: /\bexperiment\b|\ba\/b\b/i },
    ],
    tools: ["run_deck", "run_monitor", "experiment_ledger"],
  },
  {
    id: "debug",
    pattern: /\b(bug|crash|regression|flaky|debug|unexpected behavior|root cause|failed fix|failure investigation)\b/i,
    primary: "debug_ledger",
    selectors: [
      { tool: "safe_try", pattern: /\b(safe try|risky|speculative|isolated attempt)\b/i },
      { tool: "fix_recall", pattern: /\b(prior fix|similar failure|recall|seen before)\b/i },
      { tool: "evidence_inbox", pattern: /\b(evidence inbox|captured evidence)\b/i },
    ],
    tools: ["debug_ledger", "fix_recall", "safe_try", "evidence_inbox"],
  },
  {
    id: "ci",
    pattern: /\b(CI|pull request|PR (?:status|review|risk|summary|verification)|github actions?)\b/i,
    primary: "ci_pr_companion",
    selectors: [],
    tools: ["ci_pr_companion"],
  },
  {
    id: "commit",
    pattern: /\b(commit|checkpoint|prepare local commits?|git checkpoint)\b/i,
    primary: "commit_plan",
    selectors: [],
    tools: ["commit_plan"],
  },
  {
    id: "evidence",
    pattern: /\b(evidence|proof packet|verification claim|screenshot|screen recording|profile artifact|test gap|coverage gap)\b/i,
    primary: "evidence_binder",
    selectors: [
      { tool: "evidence_inbox", pattern: /\b(evidence inbox|captured evidence)\b/i },
      { tool: "test_gap_planner", pattern: /\b(test gap|coverage gap)\b/i },
      { tool: "verification_center", pattern: /\bverification center\b/i },
    ],
    tools: ["evidence_binder", "evidence_inbox", "test_gap_planner", "verification_center"],
  },
]);

const MANAGED_TOOL_NAMES = Object.freeze(Array.from(new Set(GROUPS.flatMap((group) => group.tools))).sort());
const PROVIDER_QUERY_TOOLS = new Set(["codegraph_query", "codegraph_context", "codegraph_affected", "codegraph_sync"]);
const SEMGREP_SCAN_TOOLS = new Set(["semgrep_scan", "semgrep_codegraph"]);
const OBSIDIAN_VAULT_TOOLS = new Set(["obsidian_search", "obsidian_note", "obsidian_import", "obsidian_hermes"]);
const ENV_GATES = Object.freeze({
  automation_loop: "PI_AUTOMATION_LOOP",
  pi_queue_status: "PI_QUEUE",
  pi_queue_list: "PI_QUEUE",
  ci_pr_companion: "PI_CI_PR_COMPANION",
  codegraph_status: "PI_CODEGRAPH",
  codegraph_query: "PI_CODEGRAPH",
  codegraph_context: "PI_CODEGRAPH",
  codegraph_affected: "PI_CODEGRAPH",
  codegraph_sync: "PI_CODEGRAPH",
  codegraph_doctor: "PI_CODEGRAPH",
  commit_plan: "PI_COMMIT_PLAN",
  debug_ledger: "PI_DEBUG_LEDGER",
  extension_ops: "PI_EXTENSION_OPS",
  hermes_advisory: "PI_HERMES_ADVISORY",
  memory_explorer: "PI_MEMORY_EXPLORER",
  memory_curator: "PI_MEMORY_CURATOR",
  privacy_guard: "PI_PRIVACY_GUARD",
  run_deck: "PI_RUN_DECK",
  run_monitor: "PI_RUN_MONITOR",
  semgrep_status: "PI_SEMGREP",
  semgrep_scan: "PI_SEMGREP",
  semgrep_codegraph: "PI_SEMGREP",
  semgrep_doctor: "PI_SEMGREP",
});

const OPPORTUNITY_SPECS = Object.freeze([
  { pattern: /\b(structural (?:edit|refactor)|mechanical refactor|rename (?:a )?symbol|ast_refactor)\b/i, trigger: "semantic-edit-intent", extension: "ast-tools", tools: ["ast_refactor"] },
  { pattern: /\b(roadmap|track (?:this|the) plan|multi[ -]?step plan|checklist progress)\b/i, trigger: "workflow-plan-intent", extension: "roadmap", tools: ["roadmap_update"] },
  { pattern: /\b(topology (?:recipe|catalog|install|lint|recommend|upgrade))\b/i, trigger: "topology-admin-intent", extension: "reasoning-runtime", tools: ["run_topology"] },
  { pattern: /\b(fan[ -]?out|parallel agents?|delegate (?:this )?plan|plan delegation)\b/i, trigger: "plan-fanout-intent", extension: "reasoning-runtime", tools: ["create_subagent"] },
  { pattern: /\b(codegraph|dependency graph|affected tests?|symbol graph)\b/i, trigger: "codegraph-query-intent", extension: "codegraph", tools: ["codegraph_query", "codegraph_context", "codegraph_affected", "codegraph_sync"] },
  { pattern: /\b(CI|pull request|PR (?:status|review|risk|summary|verification)|github actions?)\b/i, trigger: "ci-pr-intent", extension: "ci-pr-companion", tools: ["ci_pr_companion"] },
  { pattern: /\b(extension (?:usage|inventory|portfolio|telemetry|operations?|review))\b/i, trigger: "extension-ops-intent", extension: "extension-ops-center", tools: ["extension_ops"] },
  { pattern: /\b(performance (?:profile|regression)|runtime (?:latency|performance)|hot path|latency regression)\b/i, trigger: "performance-intent", extension: "runtime-doctor", tools: ["runtime_doctor", "performance_optimizer"] },
  { pattern: /\b(semgrep|security (?:scan|audit|review)|static analysis|injection|secret handling|auth(?:entication|orization)? bug)\b/i, trigger: "security-scan-intent", extension: "semgrep", tools: ["semgrep_scan", "semgrep_codegraph"] },
  { pattern: /\b(memory (?:governance|curation|lifecycle)|remember|forget|memory curator)\b/i, trigger: "memory-governance-intent", extension: "memory-explorer", tools: ["memory_explorer", "memory_curator"] },
  { pattern: /\b(screenshot|screen recording|profile artifact|captured evidence|evidence inbox)\b/i, trigger: "evidence-artifact-intent", extension: "evidence-inbox", tools: ["evidence_inbox"] },
]);

function uniq(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function defaultCommandAvailable(command, env = process.env) {
  const raw = String(command || "").trim();
  if (!raw) return false;
  if (path.isAbsolute(raw)) {
    try { fs.accessSync(raw, fs.constants.X_OK); return true; } catch { return false; }
  }
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    try { fs.accessSync(path.join(directory, raw), fs.constants.X_OK); return true; } catch {}
  }
  return false;
}

function detectedVault(cwd, env = process.env) {
  const candidates = [
    env.PI_OBSIDIAN_VAULT,
    path.join(cwd || process.cwd(), ".obsidian"),
    path.join(env.HOME || "", "Obsidian", "Pi Research"),
  ].filter(Boolean);
  return candidates.some((candidate) => {
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  });
}

function toolReadiness(tool, options = {}) {
  const env = options.env || process.env;
  const gate = ENV_GATES[tool];
  if (gate && env[gate] === "0") return { ready: false, reason: `disabled:${gate}` };
  const commandAvailable = options.commandAvailable || ((command) => defaultCommandAvailable(command, env));
  if (PROVIDER_QUERY_TOOLS.has(tool)) {
    const binary = env.PI_CODEGRAPH_BIN || "codegraph";
    if (!commandAvailable(binary)) return { ready: false, reason: "provider-unavailable:codegraph" };
  }
  if (SEMGREP_SCAN_TOOLS.has(tool)) {
    const binary = env.PI_SEMGREP_BIN || "semgrep";
    if (!commandAvailable(binary)) return { ready: false, reason: "provider-unavailable:semgrep" };
  }
  if (OBSIDIAN_VAULT_TOOLS.has(tool) && !detectedVault(options.cwd || process.cwd(), env)) {
    return { ready: false, reason: "provider-unavailable:obsidian-vault" };
  }
  return { ready: true, reason: null };
}

function explicitToolNames(prompt, allToolNames) {
  const tokens = new Set(String(prompt || "").toLowerCase().match(/[a-z0-9_]+/g) || []);
  return (allToolNames || []).filter((name) => tokens.has(String(name).toLowerCase()));
}

// Activate what the request actually asks for: every selector that matches, else
// the group's primary tool. Activating the whole group would add schemas this
// turn does not need, and an activated tool stays active for the whole session.
function selectIntentTools(intents, prompt) {
  const text = String(prompt || "");
  const selected = new Set();
  for (const group of GROUPS) {
    if (!intents.includes(group.id)) continue;
    const explicit = explicitToolNames(text, group.tools);
    const matched = explicit.length ? explicit : (group.selectors || []).filter((selector) => selector.pattern.test(text)).map((selector) => selector.tool);
    for (const tool of matched.length ? matched : [group.primary]) selected.add(tool);
  }
  return Array.from(selected).sort();
}

function classifyTask(prompt) {
  const text = String(prompt || "");
  const intents = GROUPS.filter((group) => group.pattern.test(text)).map((group) => group.id);
  if (/\b(topology (?:recipe|catalog|install|lint|recommend|upgrade))\b/i.test(text) && !intents.includes("delegation")) intents.push("delegation");
  return intents;
}

function routeToolSurface(options = {}) {
  const all = uniq(options.allToolNames).sort();
  const allSet = new Set(all);
  const initialActive = uniq(options.initialActiveToolNames).filter((name) => allSet.has(name));
  // The live set can contain a tool registered after session start (a provider
  // or MCP surface that appeared later). It is absent from this snapshot, so it
  // must stay in the baseline instead of being silently deactivated.
  const currentActive = uniq(options.currentActiveToolNames);
  const managed = new Set(MANAGED_TOOL_NAMES.filter((name) => allSet.has(name)));
  const eligible = new Set(initialActive.filter((name) => managed.has(name)));
  const baseline = uniq([...initialActive, ...currentActive]).filter((name) => !managed.has(name));
  const intents = classifyTask(options.prompt);
  // Within a session the surface only grows. Any change to the active set
  // rebuilds Pi's system prompt and tool list, which invalidates the provider's
  // whole prompt cache (Anthropic re-writes the full context), so a tool once
  // activated stays until options.reset (session start) returns to the baseline.
  const kept = options.reset ? [] : currentActive.filter((name) => managed.has(name));
  const keptSet = new Set(kept);
  const requested = uniq([
    ...(resolveProjectMemoryRollout(applyProjectMemoryPosture(options.env || process.env).env).controls.automaticCapture ? ["memory_curator"] : []),
    ...selectIntentTools(intents, options.prompt),
    ...explicitToolNames(options.prompt, all),
  ]).filter((name) => managed.has(name) && eligible.has(name) && !keptSet.has(name));
  const addedTools = [];
  const blockedTools = [];
  for (const tool of requested.sort()) {
    const readiness = toolReadiness(tool, options);
    if (readiness.ready) addedTools.push(tool);
    else blockedTools.push({ tool, reason: readiness.reason });
  }
  const selectedTools = uniq([...kept, ...addedTools]).sort();
  const opportunities = OPPORTUNITY_SPECS.filter((spec) => spec.pattern.test(String(options.prompt || ""))).map(({ pattern: _pattern, ...row }) => ({ ...row }));
  return {
    activeTools: uniq([...baseline, ...selectedTools]),
    baselineTools: baseline,
    selectedTools,
    addedTools,
    blockedTools,
    intents,
    explicitTools: explicitToolNames(options.prompt, all).filter((name) => managed.has(name)),
    opportunities,
    managedCount: managed.size,
    eligibleManagedCount: eligible.size,
  };
}

// The router is the only component that knows which optional tools exist, are
// eligible in this session, and are blocked by configuration or a missing
// provider. Activation by name and catalog rendering share that answer so a
// tool cannot be reported as available in one surface and absent in another.
function activationCatalog(options = {}) {
  const all = uniq(options.allToolNames).sort();
  const allSet = new Set(all);
  const initialActive = uniq(options.initialActiveToolNames).filter((name) => allSet.has(name));
  const active = new Set(uniq(options.currentActiveToolNames).filter((name) => allSet.has(name)));
  const eligible = new Set(initialActive.filter((name) => MANAGED_TOOL_NAMES.includes(name)));
  return GROUPS.map((group) => ({
    id: group.id,
    tools: group.tools.filter((name) => allSet.has(name)).map((name) => {
      if (active.has(name)) return { name, state: "active", reason: null };
      if (!eligible.has(name)) return { name, state: "ineligible", reason: "not-eligible-in-session" };
      const readiness = toolReadiness(name, options);
      return readiness.ready ? { name, state: "inactive", reason: null } : { name, state: "blocked", reason: readiness.reason };
    }),
  })).filter((group) => group.tools.length);
}

function activateManagedTools(options = {}) {
  const all = uniq(options.allToolNames).sort();
  const allSet = new Set(all);
  const initialActive = uniq(options.initialActiveToolNames).filter((name) => allSet.has(name));
  // Keep the caller's live set intact: a tool registered after session start
  // (a provider or MCP surface that appeared later) is not in this snapshot and
  // must not be dropped by the additive activation result.
  const currentActive = uniq(options.currentActiveToolNames);
  const managed = new Set(MANAGED_TOOL_NAMES.filter((name) => allSet.has(name)));
  const eligible = new Set(initialActive.filter((name) => managed.has(name)));
  const requested = uniq((options.tools || []).map((name) => String(name).trim()).filter(Boolean));
  const activated = [];
  const alreadyActive = [];
  const blocked = [];
  const ineligible = [];
  const unknown = [];
  for (const name of requested.sort()) {
    if (!managed.has(name)) unknown.push(name);
    else if (currentActive.includes(name)) alreadyActive.push(name);
    else if (!eligible.has(name)) ineligible.push(name);
    else {
      const readiness = toolReadiness(name, options);
      if (readiness.ready) activated.push(name);
      else blocked.push({ tool: name, reason: readiness.reason });
    }
  }
  // Activation is additive: the caller applies this list so baseline tools and
  // anything a previous turn activated survive.
  return { activeTools: uniq([...currentActive, ...activated]).sort(), activated, alreadyActive, blocked, ineligible, unknown };
}

module.exports = {
  GROUPS,
  MANAGED_TOOL_NAMES,
  OPPORTUNITY_SPECS,
  classifyTask,
  explicitToolNames,
  selectIntentTools,
  toolReadiness,
  routeToolSurface,
  activationCatalog,
  activateManagedTools,
  defaultCommandAvailable,
  detectedVault,
};
