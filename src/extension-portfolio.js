"use strict";

const { OPPORTUNITY_TRIGGER_EXTENSIONS } = require("./extension-telemetry.js");

const PORTFOLIO_SCHEMA_VERSION = 4;
const OBSERVATION_MIN_DAYS = 30;
const OPPORTUNITY_MIN_SAMPLE = 20;
const DISPLACEMENT_POLICY_VERSION = "reliable-core-displacement-v1";
const GLOBAL_EXPERIMENTAL_OPT_IN = "PI_PORTFOLIO_EXPERIMENTAL_TOOLS";

function entry(owner, problem, trigger, canonical, overlap, mutationClass, privacyClass, successMetric, dependencies, lifecycle, modelExposure, tools, rollbackEnv = null) {
  return { owner, problem, trigger, canonical, overlap, mutationClass, privacyClass, successMetric, dependencies, lifecycle, modelExposure, tools, rollbackEnv };
}

const EXTENSIONS = Object.freeze({
  "00-harness-defaults": entry("runtime maintainer", "Apply canonical guarded harness environment defaults before other extensions load", "Harness extension startup", "config/harness-defaults.env", "Explicit process environment values always win", "startup configuration", "fixed non-secret environment values only", "Every harness extension observes the same reviewed defaults and rollback overrides", [], "core", "none", [], "config/harness-defaults.env"),
  "ast-tools": entry("code tooling maintainer", "Lexical declaration search and checkpointed replacements", "Focused declaration search or broad lexical refactor", "ast_search/ast_refactor", "Use read/edit for localized changes; LSP for semantic rename", "preview-apply", "local source; no durable bodies", "Refactors preview before apply and changed tests pass", [], "core", "default", ["ast_search", "ast_refactor"], "PI_AST_TOOLS"),
  "automation-loop": entry("workflow tooling maintainer", "Bounded repeated same-prompt autonomous work", "Explicit current-user loop/autonomy request", "automation_loop", "run_monitor observes one process without repeating model work", "bounded orchestration", "private metadata-only lifecycle telemetry", "Eligible loops terminate with evidence/promise and no safety bypass", [], "enabled", "default", ["automation_loop"], "PI_AUTOMATION_LOOP"),
  "bg-run": entry("runtime maintainer", "Detached long build/test/server process ownership", "One long one-off command", "bg_run", "run_deck is canonical for durable training/download metrics", "process control", "local logs; bounded output", "Owned jobs have terminal exit evidence", [], "core", "default", ["bg_run"], "PI_BG_RUN"),
  "build-runner": entry("build tooling maintainer", "Repository-pinned build and test execution", "Build or native project test request", "build_project/test_project", "test_runner is canonical for inferred focused commands", "process control", "local command evidence; bounded output", "Pinned builds/tests return structured terminal status", ["flock (util-linux)"], "core", "default", ["build_project", "test_project"], "PI_BUILD_RUNNER"),
  "chat-focus": entry("TUI maintainer", "Navigate and focus conversation branches", "Explicit chat-focus command", "chat-focus commands", "Roadmap tracks work, not chat navigation", "command UI", "local session metadata", "Command use completes without session loss", [], "enabled", "none", [], null),
  "ci-pr-companion": entry("CI tooling maintainer", "Read-only CI and pull-request triage", "Explicit CI/PR inspection", "ci_pr_companion", "gitevidence is canonical for local Git state", "read-only", "provider metadata; no credentials persisted", "CI findings map to actionable local verification", ["gh when available"], "enabled", "default", ["ci_pr_companion"], "PI_CI_PR_COMPANION"),
  "codemode": entry("runtime maintainer", "Compose deterministic tool chains and filter intermediate results outside model turns", "Independent read batches or dependent read/filter workflows", "native Pi codemode in hybrid on mode", "Direct tools remain available; scripts do not replace reasoning or verification authority", "bounded read-oriented tool composition", "models and persistent store disabled; metadata-only lifecycle telemetry", "Native conformance passes and paired benefit is measured without fabricated evidence", ["Pi public createCodemodeExtension and QuickJS runtime"], "core", "default", ["codemode"], "PI_CODEMODE"),
  "code-context": entry("retrieval maintainer", "Progressive task-focused repository context", "Unfamiliar code localization", "code_context", "CodeGraph/LSP remain provider diagnostics", "read-only", "source returned on demand; telemetry metadata-only", "Relevant symbols localized within budget", [], "enabled", "default", ["code_context"], null),
  "codegraph": entry("retrieval maintainer", "Dependency-aware symbol and affected-test queries", "Explicit graph query when index is ready", "codegraph_* tools; /codegraph-files for explicit file-tree inspection", "code_context is the canonical provider-neutral facade", "read-only/index update", "local index metadata", "Fresh queries return useful symbols/tests or explicit degradation", ["CodeGraph binary/index"], "enabled", "default", ["codegraph_status", "codegraph_query", "codegraph_context", "codegraph_affected", "codegraph_sync", "codegraph_doctor"], "PI_CODEGRAPH"),
  "commit-plan": entry("Git workflow maintainer", "Exact-file logical local commits", "Explicit user commit request", "commit_plan", "gitevidence/gitverify supply read-only proof", "mutating Git", "Git metadata only", "Task-owned files commit in coherent groups", ["Git repository"], "enabled", "default", ["commit_plan"], "PI_COMMIT_PLAN"),
  "completion-enforcement": entry("runtime maintainer", "Continue authorized implementation turns that stop on an unevidenced limit or partial progress", "Settled implementation turn whose final message stops without an evidenced blocker or user decision", "completion-enforcement agent_settled hook", "AGENTS.md completion discipline governs intent; roadmap tracks required outcomes", "prompt hook with bounded continuation", "decision reasons and counters only; no transcript text persisted", "Implementation turns continue to completion or stop on evidenced blockers without invented budgets", [], "enabled", "none", [], "PI_COMPLETION_ENFORCEMENT"),
  "context-overflow-recovery": entry("runtime maintainer", "Recover useful public context after compaction/overflow", "Compaction lifecycle or explicit rescue", "context recovery commands", "Reasoning runtime owns normal context injection", "command/runtime hook", "redacted bounded summaries", "Recovery resumes without transcript leakage", [], "enabled", "none", [], "PI_COMPACTION_RECOVERY"),
  "debug-ledger": entry("debug tooling maintainer", "Durable hypothesis/change/observation bug threads", "Bug investigation", "debug_ledger", "fix_recall retrieves prior resolved threads", "local state", "bounded public evidence only", "Every attempt receives a verdict and confirmed resolution", [], "core", "default", ["debug_ledger"], "PI_DEBUG_LEDGER"),
  "docs-lookup": entry("documentation tooling maintainer", "Version-matched local/project/package documentation", "API question with local docs", "docs_lookup", "read accesses Pi framework docs outside project confinement", "read-only", "local docs returned on demand", "Answer cites installed/local documentation", [], "enabled", "default", ["docs_lookup"], "PI_DOCS_LOOKUP"),
  "evidence-binder": entry("verification maintainer", "Bind completion claims to concrete verifier evidence", "Verification or handoff claim", "evidence_binder", "verification_center produces project proof", "local state", "metadata/proof references only", "Unsupported claims are rejected or marked not-applicable", [], "enabled", "default", ["evidence_binder"], "PI_EVIDENCE_BINDER"),
  "evidence-inbox": entry("verification maintainer", "Find recent external screenshots/logs/profiles", "User says evidence was captured", "evidence_inbox", "evidence_binder binds proof packets", "read-only", "opaque artifact references; paths resolved only in memory", "Relevant fresh artifact is located without broad copying", [], "enabled", "default", ["evidence_inbox"], "PI_EVIDENCE_INBOX"),
  "experiment-ledger": entry("experiment maintainer", "Pre-register and close measured experiment gates", "Explicit experiment/A-B arc", "experiment_ledger", "run_deck executes long arms", "local state", "metrics and references; no raw payloads", "Every gate and decision is recorded once", [], "enabled", "default", ["experiment_ledger"], "PI_EXPERIMENT_LEDGER"),
  "extension-ops-center": entry("extension product maintainer", "Reconcile extension inventory, lifecycle, telemetry, and conflicts", "Extension operations or portfolio review", "extension_ops", "project_intelligence profiles the wider repository", "read-only/docs generation", "metadata-only inventory/telemetry", "Zero unexplained runtime/source discrepancies", [], "enabled", "default", ["extension_ops"], "PI_EXTENSION_OPS"),
  "fix-recall": entry("debug tooling maintainer", "Retrieve confirmed fixes for similar failures", "Non-obvious command/test failure", "fix_recall", "debug_ledger owns the current attempt thread", "metadata-write by default; pure read with record:false", "redacted resolved summaries plus privacy-safe attribution metadata", "Prior fix reduces repeated failed attempts", [], "enabled", "default", ["fix_recall"], "PI_FIX_RECALL"),
  "git-evidence-courier": entry("Git workflow maintainer", "Read-only Git proof and explicit publish command", "Git readiness or user-confirmed publish", "gitevidence/gitverify", "commit_plan owns local commits", "read-only plus explicit command publish", "Git metadata only", "Local/remote SHA and tree state reconcile", ["Git repository"], "core", "default", ["gitevidence", "gitverify"], null),
  "goal": entry("workflow tooling maintainer", "User-controlled durable goal execution", "Explicit goal commands", "goal commands", "automation_loop is canonical for bounded model-driven repetition", "command orchestration", "private local goal metadata", "Goals stop/resume/archive without unsafe implicit mutation", [], "enabled", "none", [], null),
  "harness-awareness": entry("runtime maintainer", "Concise discoverability for harness capabilities", "Session prompt setup", "harness awareness hook bound to the declared tool surface", "Portfolio records own lifecycle detail", "prompt hook", "static guidance only", "Guidance names only tools that are declared and points at activation for the rest", [], "enabled", "none", [], "PI_HARNESS_AWARE"),
  "hermes-advisory": entry("advisory planner/reviewer/curator/drafter", "Typed off-path advice with no memory, approval, install, publish, or mutation authority", "Explicit current-user Hermes intent or field-gated advisory refinement", "Hermes advisory commands and intent-gated read-only tool", "Obsidian project notes are canonical; Pi governs skills and completion", "bounded one-shot provider packets", "scanner-approved public fields; metadata-only receipts", "Qualified exact-version scorecard bars pass", ["Hermes executable/provider", "current auth proof"], "enabled", "intent-gated", ["hermes_advisory"], "PI_HERMES_ADVISORY (default on); automatic routing/drafting off"),
  "learning-loop-coordinator": entry("learning maintainer", "Reviewed aggregate outcome mining and proposals", "Explicit learning review or configured ingest", "learning_loop", "session miner supplies aggregate evidence", "preview/review/apply record", "aggregate metadata only", "Proposals pass review and verification before apply records", [], "enabled", "default", ["learning_loop"], "PI_LEARNING_LOOP"),
  "lsp": entry("code tooling maintainer", "Compiler-backed definitions, references, diagnostics, and rename", "Compiler-sensitive symbol task", "lsp", "ast_refactor handles lexical/mechanical changes", "read-only plus preview-apply rename", "local source on demand", "Server-backed facts or explicit advisory fallback", ["language server when available"], "core", "default", ["lsp"], "PI_LSP"),
  "memory-explorer": entry("memory maintainer", "Inspect and govern local memory-like state", "Explicit memory inspection or lifecycle-management request", "memory_explorer for inspection; memory_curator for governed lifecycle", "Obsidian project notes own canonical durable memory", "read-only plus checkpointed lifecycle records", "sensitive local state; previews and metadata-only exports", "Mutating lifecycle records require explicit user intent and preserve checkpoints", [], "enabled-explicit", "default", ["memory_explorer", "memory_curator"], "PI_MEMORY_EXPLORER"),
  "multi-login": entry("runtime maintainer", "Multiple logins per provider with prioritized account failover and per-directory model selection", "Model selection, session start, account usage-limit or auth failure, or /multi-login", "model_select/session_start persistence and message_end failover with pi.setModel", "Sole multi-login provider; Pi auth stores each alias login", "provider registration, cooldown state and directory model preferences", "provider/model ids, directory hashes and cooldown timestamps only; credentials stay in Pi auth storage", "Usage-limited turns continue on the next signed-in account without re-prompting", [], "enabled", "none", []),
  "pi-queue": entry("runtime maintainer", "Shared concurrency limit and durable history for DeepSeek requests from every harness machine", "Every local model request; explicit queue inspection", "local streamSimple wrapper plus pi_queue_status/pi_queue_list", "No consumer processes: each requester waits for its own slot; Redis is the only queue service", "model request gating", "private host credentials; request metadata and token counts only, no prompts or responses", "Requests beyond the limit wait in FIFO order and every request is recorded", ["installed src/pi-queue client", "private queue client configuration", "Redis broker"], "enabled", "default", ["pi_queue_status", "pi_queue_list"], "PI_QUEUE"),
  "obsidian": entry("research-memory maintainer", "Local Markdown research and explicit Hermes curation", "Explicit research/vault request", "obsidian_*", "Obsidian project notes are canonical; Hermes only drafts unverified candidates", "read/write/provider explicit", "vault-local; bounded explicit provider input", "Local operations work independently and curation proves readiness", ["vault; optional desktop/Hermes"], "enabled", "default", ["obsidian_status", "obsidian_search", "obsidian_note", "obsidian_import", "obsidian_hermes", "obsidian_doctor"], "PI_OBSIDIAN"),
  "output-compactor": entry("runtime maintainer", "Compact oversized structured results before model/TUI consumption", "Oversized selected structured result or explicit command", "tool-specific result rendering plus measured canary hook", "Manual model resend duplicates payload already in context", "command/runtime hook", "metadata-only size and latency counters; no input/output persistence", "Canary results shrink without reliability or context regressions", [], "experimental-canary", "command-only", ["output_compactor"], "PI_OUTPUT_COMPACTOR_MODE=off"),
  "policy-enforcer": entry("safety maintainer", "Central policy checks and approval grants", "Risky path/command/tool action", "policy_gate/policy_enforcer", "safe_try snapshots state but does not authorize actions", "policy/approval state", "metadata-only grants", "Unsafe actions block unless narrowly approved", [], "enabled", "default", ["policy_gate", "policy_enforcer"], "PI_POLICY_ENFORCER"),
  "privacy-guard": entry("privacy maintainer", "Detect secrets, transcripts, and unsafe runtime state", "Privacy audit or pre-export gate", "privacy_guard", "Semgrep covers code patterns, not runtime-state policy", "read-only plus purge preview", "findings metadata only", "Zero actionable findings in managed state", [], "enabled", "default", ["privacy_guard"], "PI_PRIVACY_GUARD"),
  "project-intelligence": entry("project tooling maintainer", "Repository topology, verifier, and safe-config profiling", "Repository onboarding or test-impact planning", "project_intelligence/project_profiler", "code_context localizes source; build runner executes", "read-only plus explicit config write", "repository metadata", "Profiles map real repository evidence to safe recommendations", [], "enabled", "default", ["project_intelligence", "project_profiler"], "PI_PROJECT_INTELLIGENCE"),
  "prompt-suggestions": entry("TUI maintainer", "Immediate deterministic editor suggestions with evidence-gated refinement", "Interactive editor session", "prompt suggestion UI", "No model tool; local suggestion is canonical", "command/UI hook", "metadata-only actions and latency", "Acceptance/failure bars justify optional refinement", ["optional Hermes"], "enabled", "none", [], "PI_PROMPT_SUGGESTIONS"),
  "reasoning-runtime": entry("reasoning runtime maintainer", "Reasoning context, typed roles, artifact-bound specialist tasks, plan fan-out, topology recipes, and skill synthesis", "Complex reasoning, explicit delegation/topology, or task graphs with executable acceptance", "create_subagent for plan fan-out/delegation; specialist_tasks for artifact-bound task graphs and transactional application; run_topology for recipe administration/execution", "Roadmap owns visible plan state; role-sidecar executes child contracts", "orchestration/preview-apply", "redacted artifacts and metadata-only telemetry", "Typed outcomes, bounded context, and verifier parity", [], "enabled", "default", ["create_subagent", "specialist_tasks", "auto_role_router", "run_topology", "skill_synthesis"], "PI_REASONING_RUNTIME_ENABLED"),
  "repo-context": entry("Git workflow maintainer", "One-call current repository orientation", "Session start or repository switch", "repo_context", "gitevidence is canonical for publish/readiness proof", "read-only", "Git metadata and instruction digest", "Avoids repeated shell status/log/layout rituals", ["Git optional"], "core", "default", ["repo_context"], "PI_REPO_CONTEXT"),
  "rollout-center": entry("release governance maintainer", "Unify technical readiness, policy authority, field proof, rollback controls, and provenance", "Explicit rollout/evidence inspection", "rollout-center command", "extension_ops remains inventory and portfolio authority", "read-only command UI", "typed metadata, hashes, bounded metrics, and evidence references only", "Every capability preserves source truth and exposes only the next permitted observation", [], "enabled", "none", [], "PI_ROLLOUT_CENTER"),
  "roadmap": entry("workflow tooling maintainer", "Visible recursive task and verification checklist", "Multi-step work or explicit tracking", "roadmap_update", "create_subagent fan-out consumes reviewed plans but does not own plan state", "local state", "task titles/status/evidence references", "Plan progress and verification remain visible", [], "core", "default", ["roadmap_update"], "PI_ROADMAP"),
  "role-sidecar": entry("role-runtime maintainer", "Fail-closed typed child role execution", "Isolated role-v2 child only", "role-sidecar tools", "Parent reasoning runtime creates/runs subagents", "child-only bounded tools", "typed public result plus bounded model/thinking provenance; no task/transcript/provider payload", "Allowed tools, exact model/thinking parity before provider use, and submit_role_result termination", ["PI_ROLE_SIDECAR=1 contract", "resolved expected model/thinking profile"], "child-only", "child-only", ["bash", "role_domain", "role_diff", "role_verify", "submit_role_result"], "PI_ROLE_SIDECAR"),
  "run-deck": entry("runtime maintainer", "Durable tracking for training/download/generation runs", "Long recurring-metric process", "run_deck", "bg_run is canonical for one-off build/test/server commands", "process control/local registry", "bounded logs and parsed metrics", "Run reaches recorded terminal verdict", [], "core", "default", ["run_deck"], "PI_RUN_DECK"),
  "run-monitor": entry("runtime maintainer", "Periodic observation of one managed long-running target", "Explicit request to monitor/notify", "run_monitor", "run_deck/bg_run own execution; automation_loop must not babysit", "monitor control", "target IDs and bounded literal milestone only", "Monitor notifies once on milestone/settlement/deadline", ["bg_run or run_deck target"], "enabled-observation-pending", "default", ["run_monitor"], "PI_RUN_MONITOR"),
  "runtime-doctor": entry("runtime maintainer", "Runtime health, stabilization, and performance diagnostics", "Explicit health/latency/state request", "runtime_doctor/session_stabilizer/performance_optimizer", "project_profiler covers repository configuration", "preview-apply", "aggregate runtime metadata", "Diagnostics identify risk and safe actions without deletion by default", [], "enabled", "default", ["runtime_doctor", "session_stabilizer", "performance_optimizer"], "PI_RUNTIME_DOCTOR"),
  "safe-try": entry("safety maintainer", "Checkpoint and rollback risky working-tree attempts", "Before an explicitly risky edit", "safe_try", "ast_refactor owns its narrower mechanical-edit checkpoints", "preview-apply rollback", "working-tree hashes/paths", "Worse attempts restore tracked state without deletion", ["Git repository"], "enabled", "default", ["safe_try"], "PI_SAFE_TRY"),
  "semgrep": entry("static analysis maintainer", "Pattern and security analysis with explicit readiness", "Security/pattern check", "semgrep_*", "CodeGraph supplements affected tests only", "read-only scan", "local source to configured scanner; metadata cache", "Reproducible config scan or precise degradation", ["Semgrep binary/config"], "enabled", "default", ["semgrep_status", "semgrep_scan", "semgrep_codegraph", "semgrep_doctor"], "PI_SEMGREP"),
  "test-gap-planner": entry("verification maintainer", "Identify changed behavior without adequate tests", "Coverage planning after edits", "test_gap_planner", "test_runner executes inferred commands", "read-only/preview skeleton", "source paths and test provenance", "High-risk gaps receive focused test plans", [], "enabled", "default", ["test_gap_planner"], "PI_TEST_GAP_PLANNER"),
  "test-runner": entry("verification maintainer", "Infer and execute repository-defined focused tests", "After code edits", "test_runner", "build/test_project handle pinned native project suites", "process control", "captured command evidence; bounded logs", "Real commands pass/fail and no-command is not-applicable", [], "enabled", "default", ["test_runner"], "PI_TEST_RUNNER"),
  "tool-churn-guard": entry("runtime maintainer", "Detect repeated low-value tool polling and retries", "Repeated status, policy, roadmap, Git, or identical failed calls", "metadata-only lifecycle hook", "Tool descriptions prevent first-order mistakes; guard intervenes only after repetition", "advisory hook", "tool/operation/count/reason only; no arguments or result bodies", "Repeated calls receive one actionable suggestion without blocking work", [], "enabled", "none", [], "PI_TOOL_CHURN_GUARD"),
  "tool-surface-router": entry("runtime maintainer", "Expose a task- and readiness-appropriate model tool subset", "Every submitted user task", "deterministic input hook plus activate_tools for explicit mid-session activation; within a session tools are only added, so the provider prompt cache survives", "All tools remain registered and commands remain available", "prompt/tool-surface hook", "fixed intent labels and tool names only; no prompt persistence", "Sessions start on a smaller deterministic surface and every optional tool is reachable by name without widening a restricted surface", [], "core", "default", ["activate_tools"], "PI_TOOL_SURFACE_ROUTER"),
  "trace-observability": entry("observability maintainer", "Runtime trace inspection and replay", "Explicit trace command or runtime instrumentation", "trace commands", "runtime_doctor summarizes health", "command/runtime hook", "payload capture off/redacted by policy", "Trace explains failures without sensitive payloads", [], "enabled", "none", [], "PI_TRACE_ENABLED"),
  "verification-center": entry("verification maintainer", "Proof-producing multi-verifier project gate", "Completion/publish/release verification", "verification_center", "test_runner supplies focused command execution; visual baselines are separately governed", "process control/local evidence", "proof metadata, visual hashes/metrics, and bounded outputs; no captured image bodies", "Evidence reflects all verifier/provider gates truthfully", [], "enabled", "default", ["verification_center"], "PI_VERIFICATION_CENTER"),
});

const PORTFOLIO_NOTES = Object.freeze({
  "fix-recall": [
    "## Retrieval telemetry",
    "",
    "By default each lookup appends one private attribution row under `.pi/fix-recall/`. The row contains an opaque retrieval ID, timestamp, result counts, source classes, and a hash of the returned match set. It never stores the query, error text, prompt, transcript, private reasoning, raw tool output, or local paths. Pass `record:false` to the `fix_recall` tool, or use `/fix-recall --no-record`, for a pure read that creates no retrieval ID or telemetry state. Fix Recall never applies a retrieved change automatically.",
    "",
    "## Comparative evidence boundary",
    "",
    "Synthetic matches and unit tests establish deterministic behavior only; they do not establish comparative efficacy. The open exact-version field experiment remains insufficient data, so no ship, retire, merge, or rollout decision is authorized before its preregistered cohort and observation window are complete.",
  ],
  "privacy-guard": [
    "## Scan scope",
    "",
    "The default local scan covers all available memory-adjacent runtime roots, including traces, learning-loop state, debug and experiment ledgers, canonical project-memory metadata, curator/maintenance state, evidence, Fix Recall attribution, run-deck state, provenance/execution records, session audit/mining/branches, runtime doctor state, and the roadmap. Results list every configured root by a privacy-safe scope label and mark it available or absent. Missing optional default roots are reported rather than silently omitted; an absent explicitly requested root makes scope completeness false. Raw session bodies remain outside the default content scan, while permission posture is a separate metadata-only scope.",
  ],
  "roadmap": [
    "## Read-only viewers",
    "",
    "The `roadmap:changed` event includes a display-only `viewer` snapshot for pi-dash's TUI",
    "(`o`) and Android (**Roadmap → Open roadmap** in session detail). It contains nested item",
    "and subroadmap paths, statuses, recent notes, an update time, and root-outcome counts",
    "separate from recursive workflow totals. It does not expose private reasoning or change",
    "plan state. The payload includes the first 500 entries / 64 KiB, 500-character titles,",
    "and the latest three notes of 200 characters each. `totalEntries` lets clients disclose",
    "omissions rather than imply a complete tree. Reload sessions after updating the publisher.",
  ],
});

const COMMAND_ONLY_MODEL_TOOLS = Object.freeze({
  output_compactor: { extensionId: "output-compactor", optInEnv: "PI_OUTPUT_COMPACTOR_MODEL_TOOL", decision: "experimental-command-only", canonical: "tool-specific result rendering plus measured automatic canary", trigger: "manual compatibility testing only; automatic canary is independently governed" },
});

const TOOL_OVERRIDES = Object.freeze({
  memory_curator: { decision: "keep-explicit", canonical: "memory_curator", trigger: "explicit user memory-management intent", evidence: "governed preview/checkpoint behavior; post-fix adoption insufficient" },
  run_monitor: { decision: "keep-observation-pending", canonical: "run_monitor", trigger: "explicit monitoring request for an existing managed target", evidence: "excluded from early pruning until eligible long-run cohort exists" },
});

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function portfolioRecord(extensionId) {
  const value = EXTENSIONS[extensionId];
  return value ? { schemaVersion: PORTFOLIO_SCHEMA_VERSION, extensionId, ...clone(value) } : null;
}
function portfolioRecords() { return Object.keys(EXTENSIONS).sort().map(portfolioRecord); }
function modelToolEnabled(extensionId, env = process.env) {
  const record = EXTENSIONS[extensionId];
  if (!record) throw new Error(`Unknown extension portfolio id: ${extensionId}`);
  if (record.modelExposure !== "command-only") return record.modelExposure === "default";
  const tool = record.tools.map((name) => COMMAND_ONLY_MODEL_TOOLS[name]).find(Boolean);
  return env[GLOBAL_EXPERIMENTAL_OPT_IN] === "1" || Boolean(tool?.optInEnv && env[tool.optInEnv] === "1");
}
function toolDecisions() {
  const rows = [];
  for (const record of portfolioRecords()) {
    for (const tool of record.tools) {
      const commandOnly = COMMAND_ONLY_MODEL_TOOLS[tool];
      const override = TOOL_OVERRIDES[tool];
      const decision = commandOnly?.decision || override?.decision || (record.modelExposure === "child-only" ? "keep-child-only" : "keep");
      rows.push({
        tool,
        extensionId: record.extensionId,
        decision,
        canonical: commandOnly?.canonical || override?.canonical || record.canonical,
        trigger: commandOnly?.trigger || override?.trigger || record.trigger,
        lifecycle: record.lifecycle,
        modelExposure: record.modelExposure,
        optInEnv: commandOnly?.optInEnv || null,
        evidence: override?.evidence || (record.lifecycle.includes("experimental") ? "post-fix observation window insufficient; command surface retained" : "unique trigger documented and regression coverage retained"),
      });
    }
  }
  return rows.sort((a, b) => a.tool.localeCompare(b.tool));
}
function observationWindow(telemetry = {}) {
  const firstMs = Date.parse(String(telemetry.firstAt || ""));
  const lastMs = Date.parse(String(telemetry.lastAt || ""));
  const observedHours = Number.isFinite(firstMs) && Number.isFinite(lastMs) && lastMs >= firstMs ? Number(((lastMs - firstMs) / 3_600_000).toFixed(2)) : 0;
  return { source: "telemetry-event-span", requiredDays: OBSERVATION_MIN_DAYS, observedHours, observedDays: Number((observedHours / 24).toFixed(2)), sufficient: observedHours >= OBSERVATION_MIN_DAYS * 24, gatingSafe: false, firstAt: telemetry.firstAt || null, lastAt: telemetry.lastAt || null, eventCount: Number(telemetry.eventCount || 0) };
}
function classifiedObservation(audit = {}, telemetry = {}) {
  const direct = telemetry?.interactiveCohort || {};
  if (direct.currentSessionExcluded === true && Number(direct.sessions || 0) > 0) {
    const observedDays = Number(direct.observedDays || 0);
    const gatingSafe = direct.gatingSafe === true && observedDays >= OBSERVATION_MIN_DAYS;
    return {
      source: "privacy-tokenized-extension-telemetry",
      requiredDays: OBSERVATION_MIN_DAYS,
      observedHours: Number((observedDays * 24).toFixed(2)),
      observedDays,
      sufficient: gatingSafe,
      gatingSafe,
      firstAt: direct.firstAt || null,
      lastAt: direct.lastAt || null,
      eventCount: Number(telemetry.eventCount || 0),
      classifiedInteractiveSessions: Number(direct.sessions || 0),
      classifiedInteractiveTurns: null,
      tokenCoverage: Number(direct.tokenCoverage || 0),
      cohort: { schemaVersion: telemetry.schemaVersion, currentSessionExcluded: true, sessionTokenPolicy: "HMAC-SHA256 local-salt tokens" },
    };
  }
  const cohort = audit?.cohort || {}; const sessions = audit?.sessions || {};
  const interactiveSessions = Number(sessions.classifications?.interactive || 0);
  const observedDays = Number(cohort.observedInteractiveDays || 0);
  const valid = Boolean(audit?.privacy?.aggregateOnly && cohort.sinceAt && cohort.sourceVersion && cohort.configVersion && cohort.classifierVersion && cohort.sessionKindPolicyVersion && cohort.currentSessionExcluded === true);
  if (!valid) return { ...observationWindow(telemetry), source: "classified-interactive-audit-unavailable", classifiedInteractiveSessions: interactiveSessions, classifiedInteractiveTurns: Number(sessions.interactiveUserTurns || 0), sufficient: false, gatingSafe: false, reason: "missing-exact-private-interactive-cohort" };
  return { source: "classified-interactive-audit", requiredDays: OBSERVATION_MIN_DAYS, observedHours: Number((observedDays * 24).toFixed(2)), observedDays, sufficient: observedDays >= OBSERVATION_MIN_DAYS, gatingSafe: observedDays >= OBSERVATION_MIN_DAYS, firstAt: sessions.earliestAt || null, lastAt: sessions.latestAt || null, eventCount: Number(telemetry.eventCount || 0), classifiedInteractiveSessions: interactiveSessions, classifiedInteractiveTurns: Number(sessions.interactiveUserTurns || 0), cohort: { sourceVersion: cohort.sourceVersion, configVersion: cohort.configVersion, classifierVersion: cohort.classifierVersion, sessionKindPolicyVersion: cohort.sessionKindPolicyVersion, sinceAt: cohort.sinceAt, currentSessionExcluded: true } };
}
function adoptionRows(records, audit = {}, telemetry = {}) {
  const direct = telemetry?.interactiveCohort || {};
  const directRows = new Map((direct.rows || []).map((row) => [row.extension, row]));
  const directCompatible = direct.currentSessionExcluded === true && Number(direct.sessions || 0) > 0 && Number(direct.tokenCoverage || 0) >= 0.95;
  const byId = new Map((audit.extensions || []).map((row) => [row.name, row]));
  return records.map((record) => {
    if (directCompatible) {
      const row = directRows.get(record.extensionId) || {};
      const denominator = Number(direct.sessions || 0);
      const numerator = Number(row.sessions || 0);
      return { extensionId: record.extensionId, status: "measured", eligibleInteractiveSessions: denominator, adoptedInteractiveSessions: numerator, interactiveActions: Number(row.actions || 0), adoptionRate: denominator ? Number((numerator / denominator).toFixed(4)) : null, denominator: "privacy-tokenized-interactive-sessions-in-telemetry-cohort", includes: ["model-tools", "commands", "automatic-evidence"] };
    }
    const row = byId.get(record.extensionId); const denominator = Number(row?.eligibleInteractiveSessionsSinceBirth || 0); const numerator = Number(row?.interactiveAdoptionSessions);
    const compatible = Number.isFinite(numerator) && audit?.privacy?.aggregateOnly === true && audit?.cohort?.currentSessionExcluded === true;
    return { extensionId: record.extensionId, status: compatible ? "measured" : "insufficient-data", eligibleInteractiveSessions: denominator, adoptedInteractiveSessions: compatible ? numerator : null, interactiveActions: compatible ? Number(row?.interactiveActions || 0) : null, adoptionRate: compatible && denominator ? Number((numerator / denominator).toFixed(4)) : null, denominator: "classified-interactive-sessions-since-extension-birth", includes: ["model-tools", "commands", "automatic-evidence"] };
  });
}
function opportunityRows(records, telemetry = {}) {
  const rows = telemetry.opportunities?.rows || [];
  const currentSessionExcluded = telemetry.interactiveCohort?.currentSessionExcluded === true;
  return records.map((record) => {
    const own = rows.filter((row) => row.extension === record.extensionId && row.sessionKind === "interactive" && OPPORTUNITY_TRIGGER_EXTENSIONS[row.triggerId] === record.extensionId);
    const eligible = own.filter((row) => row.eligibility === "eligible").reduce((sum, row) => sum + Number(row.count || 0), 0);
    const acted = own.filter((row) => row.eligibility === "eligible" && row.acted === true).reduce((sum, row) => sum + Number(row.count || 0), 0);
    const helpful = own.filter((row) => row.reviewed === true && row.value === "helpful").reduce((sum, row) => sum + Number(row.count || 0), 0);
    const valued = own.filter((row) => row.reviewed === true && ["helpful", "not-helpful"].includes(row.value)).reduce((sum, row) => sum + Number(row.count || 0), 0);
    const identities = new Set(own.map(row => `${row.version}:${row.sourceFingerprint}`));
    const exactSource = identities.size === 1 && own.every(row => /^source_[a-f0-9]{16}$/.test(row.sourceFingerprint || ""));
    return { extensionId: record.extensionId, status: eligible > 0 ? "measured" : own.length ? "no-eligible-opportunities" : "unsupported", eligible, acted, actionRate: eligible ? Number((acted / eligible).toFixed(4)) : null, valued, helpful, valueRate: valued ? Number((helpful / valued).toFixed(4)) : null, valueStatus: valued >= OPPORTUNITY_MIN_SAMPLE ? (helpful / valued >= 0.8 ? "high-value" : "value-bar-not-met") : "insufficient-data", currentSessionExcluded, sampleSufficient: eligible >= OPPORTUNITY_MIN_SAMPLE, gatingSafe: currentSessionExcluded && exactSource && eligible >= OPPORTUNITY_MIN_SAMPLE, exactSource, denominator: "fixed-trigger-eligible-interactive-opportunities" };
  });
}
const RELIABLE_CORE_SIGNALS = Object.freeze(["gitevidence:git-diff", "run_deck:polling-ritual", "repo_context:git-status-log", "commit_plan:git-add-commit", "build_project:direct-build", "test_runner:direct-test"]);
function reliableCoreDisplacement(baseline = {}, candidate = {}) {
  const fields = ["classifierVersion", "sessionKindPolicyVersion", "windowDays", "fixtureHash", "policyVersion"];
  const mismatch = fields.filter((field) => !baseline.cohort?.[field] || baseline.cohort?.[field] !== candidate.cohort?.[field]);
  const baselineTurns = Number(baseline.interactiveUserTurns || 0); const candidateTurns = Number(candidate.interactiveUserTurns || 0);
  if (mismatch.length || !baselineTurns || !candidateTurns || baseline.cohort?.strategyId === candidate.cohort?.strategyId) return { status: "insufficient-data", gatingSafe: false, mismatchFields: mismatch, signals: RELIABLE_CORE_SIGNALS, reason: mismatch.length ? "incompatible-cohort" : "missing-denominator-or-distinct-strategy" };
  const rows = RELIABLE_CORE_SIGNALS.map((signal) => { const before = Number(baseline.signals?.[signal] || 0) / baselineTurns; const after = Number(candidate.signals?.[signal] || 0) / candidateTurns; return { signal, baselinePerTurn: Number(before.toFixed(6)), candidatePerTurn: Number(after.toFixed(6)), reductionRate: before ? Number(((before - after) / before).toFixed(4)) : null }; });
  return { status: "measured", gatingSafe: false, policyVersion: DISPLACEMENT_POLICY_VERSION, baselineStrategyId: baseline.cohort.strategyId, candidateStrategyId: candidate.cohort.strategyId, rows, note: "Only fixed reviewed shell-ritual families are eligible; arbitrary shell commands are excluded." };
}
function portfolioReport(inventory = {}, telemetry = {}, audit = {}, options = {}) {
  const baseRecords = portfolioRecords();
  const tools = toolDecisions();
  const inventoryExtensions = new Set((inventory.extensions || []).map((item) => item.name));
  const inventoryTools = new Set((inventory.extensions || []).flatMap((item) => item.tools || []));
  const recordIds = new Set(baseRecords.map((item) => item.extensionId));
  const decidedTools = new Set(tools.map((item) => item.tool));
  const suppressedTools = tools.filter((item) => item.modelExposure === "command-only").map((item) => item.tool);
  const activeTools = new Set(inventory.runtime?.tools?.filter((item) => item.active).map((item) => item.name) || []);
  const parentDeclaredTools = new Set((inventory.extensions || []).filter((item) => !item.childOnly).flatMap((item) => item.tools || []));
  const defaultActiveToolsBefore = parentDeclaredTools.size || Number(inventory.summary?.activeTools || 0);
  const defaultActiveToolsAfter = defaultActiveToolsBefore ? defaultActiveToolsBefore - suppressedTools.filter((tool) => parentDeclaredTools.size === 0 || parentDeclaredTools.has(tool)).length : activeTools.size;
  const activeAfterPolicy = Array.from(activeTools).filter((tool) => !suppressedTools.includes(tool));
  const observation = classifiedObservation(audit, telemetry);
  const adoption = adoptionRows(baseRecords, audit, telemetry); const opportunities = opportunityRows(baseRecords, telemetry);
  const adoptionById = new Map(adoption.map((row) => [row.extensionId, row])); const opportunitiesById = new Map(opportunities.map((row) => [row.extensionId, row]));
  const records = baseRecords.map((record) => {
    const usage = adoptionById.get(record.extensionId); const utility = opportunitiesById.get(record.extensionId);
    const usageStatus = usage.status === "measured" && usage.eligibleInteractiveSessions > 0 ? (usage.interactiveActions >= OPPORTUNITY_MIN_SAMPLE || usage.adoptionRate >= 0.2 ? "high-use" : "low-use") : "insufficient-data";
    const retirementReviewEligible = observation.gatingSafe && usageStatus === "low-use" && utility.gatingSafe === true;
    const reason = !observation.gatingSafe ? "30-day-current-session-excluded-cohort-required" : usageStatus !== "low-use" ? "low-use-not-established" : utility.currentSessionExcluded !== true ? "current-session-excluded-opportunities-required" : !utility.sampleSufficient ? "fixed-trigger-opportunity-sample-required" : "opportunity-aware-low-use-review-only";
    return { ...record, measurement: { sampleSize: usage.eligibleInteractiveSessions, observedDays: observation.observedDays, observationSource: observation.source, usage: { ...usage, usageStatus }, utility, retirementEvidence: { eligible: retirementReviewEligible, requiredDays: OBSERVATION_MIN_DAYS, requiredOpportunities: OPPORTUNITY_MIN_SAMPLE, currentSessionExcluded: utility.currentSessionExcluded === true }, usageAndValueSeparated: true }, decision: { lifecycle: record.lifecycle, authority: retirementReviewEligible ? "review-required" : "no-go-deferred", reason }, rollbackMigration: { rollbackControl: record.rollbackEnv || "retain-current-settings", commandCompatibilityRetained: true, existingStatePreserved: true, migrationPath: record.modelExposure === "command-only" ? "keep command and state; restore model exposure only through the documented opt-in" : "no destructive migration; restore prior exposure through the documented control" } };
  });
  const reconciliation = {
    missingRecords: Array.from(inventoryExtensions).filter((id) => !recordIds.has(id)).sort(),
    staleRecords: Array.from(recordIds).filter((id) => inventoryExtensions.size && !inventoryExtensions.has(id)).sort(),
    missingToolDecisions: Array.from(inventoryTools).filter((tool) => !decidedTools.has(tool)).sort(),
    staleToolDecisions: Array.from(decidedTools).filter((tool) => inventoryTools.size && !inventoryTools.has(tool)).sort(),
  };
  const displacement = options.baselineDisplacement && options.candidateDisplacement ? reliableCoreDisplacement(options.baselineDisplacement, options.candidateDisplacement) : { status: "insufficient-data", gatingSafe: false, reason: "paired-exact-strategy-cohorts-required", signals: RELIABLE_CORE_SIGNALS };
  return {
    schemaVersion: PORTFOLIO_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    observation,
    measurement: { adoption, opportunities, reliableCoreDisplacement: displacement, adoptionDenominator: adoption[0]?.denominator || "classified-interactive-sessions-since-extension-birth", utilityDenominator: "fixed-trigger-eligible-interactive-opportunities" },
    summary: {
      extensions: records.length,
      tools: tools.length,
      commandOnlyExperimentalTools: suppressedTools.length,
      defaultActiveToolsBefore,
      defaultActiveToolsAfter: Math.max(0, defaultActiveToolsAfter),
      observedActiveToolsAfterPolicy: activeAfterPolicy.length,
      defaultSurfaceReduction: Math.max(0, defaultActiveToolsBefore - defaultActiveToolsAfter),
      measuredAdoptionRecords: adoption.filter((row) => row.status === "measured").length,
      measuredOpportunityRecords: opportunities.filter((row) => row.status === "measured").length,
      observationStatus: observation.sufficient ? "sufficient" : "insufficient-data",
      lifecycleAuthority: records.some((record) => record.decision.authority === "review-required") ? "review-required" : "no-go-deferred",
      retirementReviewRecords: records.filter((record) => record.decision.authority === "review-required").length,
      reconciled: Object.values(reconciliation).every((rows) => rows.length === 0),
    },
    reconciliation,
    decisions: tools,
    records,
    policy: {
      noNewDefaultToolWithoutUniqueTrigger: true,
      overlapCanonicalRequired: true,
      experimentalPromptGuidance: "none",
      lowUseIsNotLowValue: true,
      lowUseWithoutEligibleOpportunities: "insufficient-data",
      removalPolicy: "No retire/merge review before 30 current-session-excluded interactive days and at least 20 fixed-trigger eligible opportunities for the specific low-use extension; command compatibility and state are retained.",
      retirementRequiresOpportunityEvidence: true,
      retirementMinimumEligibleOpportunities: OPPORTUNITY_MIN_SAMPLE,
      lifecycleMutationAuthority: "human-review-only",
      globalExperimentalOptIn: GLOBAL_EXPERIMENTAL_OPT_IN,
    },
  };
}
function renderPortfolioRecordMarkdown(record) {
  const decisions = toolDecisions().filter((item) => item.extensionId === record.extensionId); const notes = PORTFOLIO_NOTES[record.extensionId] || [];
  const decisionLines = decisions.length ? decisions.map((item) => {
    const optIn = item.optInEnv ? `; opt-in=\`${item.optInEnv}=1\`` : "";
    return `- \`${item.tool}\`: **${item.decision}**; canonical=${item.canonical}; trigger=${item.trigger}; evidence=${item.evidence}${optIn}`;
  }) : ["- No model tools; command/UI/runtime-hook lifecycle is measured separately."];
  return [
    `# ${record.extensionId}`,
    "",
    `- **Schema:** ${record.schemaVersion}`,
    `- **Owner:** ${record.owner}`,
    `- **User problem:** ${record.problem}`,
    `- **Unique trigger:** ${record.trigger}`,
    `- **Canonical surface:** ${record.canonical}`,
    `- **Overlap decision:** ${record.overlap}`,
    `- **Mutation class:** ${record.mutationClass}`,
    `- **Privacy class:** ${record.privacyClass}`,
    `- **Success metric:** ${record.successMetric}`,
    `- **Dependency readiness:** ${record.dependencies.length ? record.dependencies.join(", ") : "none"}`,
    `- **Lifecycle:** ${record.lifecycle}`,
    `- **Default model exposure:** ${record.modelExposure}`,
    `- **Rollback/control:** ${record.rollbackMigration?.rollbackControl || record.rollbackEnv || "retain-current-settings"}`,
    `- **Migration path:** ${record.rollbackMigration?.migrationPath || "No destructive migration; preserve commands and state."}`,
    "",
    "## Tool decisions",
    "",
    ...decisionLines,
    "",
    ...notes,
    ...(notes.length ? [""] : []),
    "## Evidence boundary",
    "",
    `- Classified interactive sample: ${record.measurement?.sampleSize ?? 0} sessions`,
    `- Classified observation: ${record.measurement?.observedDays ?? 0}/30 days`,
    `- Usage: ${record.measurement?.usage?.usageStatus || "insufficient-data"}; adoption=${record.measurement?.usage?.adoptionRate ?? "n/a"}`,
    `- Trigger-eligible utility: ${record.measurement?.utility?.valueStatus || "insufficient-data"}; eligible=${record.measurement?.utility?.eligible ?? 0}; valued=${record.measurement?.utility?.valued ?? 0}`,
    `- Lifecycle authority: ${record.decision?.authority || "no-go-deferred"}`,
    "",
    "Usage and value are reported separately. Low use with no measured trigger-eligible opportunities is insufficient data, not evidence of low value. No retire/merge decision is authorized before 30 classified interactive days.",
    "",
  ].join("\n");
}
function renderPortfolioIndex(report) {
  const counts = report.decisions.reduce((map, item) => { map[item.decision] = (map[item.decision] || 0) + 1; return map; }, {});
  return [
    "# Extension portfolio registry",
    "",
    `Generated from portfolio schema ${report.schemaVersion}.`,
    "",
    `- Extensions: ${report.summary.extensions}`,
    `- Tool decisions: ${report.summary.tools}`,
    `- Default active model tools: ${report.summary.defaultActiveToolsBefore} -> ${report.summary.defaultActiveToolsAfter} (reduction ${report.summary.defaultSurfaceReduction})`,
    `- Observation: ${report.observation.observedDays} days / ${report.observation.requiredDays} required (${report.summary.observationStatus}; source=${report.observation.source})`,
    `- Measured adoption/opportunity records: ${report.summary.measuredAdoptionRecords}/${report.summary.measuredOpportunityRecords}`,
    `- Lifecycle authority: ${report.summary.lifecycleAuthority}`,
    `- Reconciled: ${report.summary.reconciled}`,
    `- Decisions: ${Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(", ")}`,
    "",
    "## Records",
    "",
    ...report.records.map((record) => `- [${record.extensionId}](./${record.extensionId}.md) — ${record.lifecycle}; model exposure=${record.modelExposure}`),
    "",
    "## Conservative policy",
    "",
    "Command-only model tools remain opt-in until both unique-trigger utility evidence and the 30-day classified cohort pass. Their commands, state, parsers, and underlying libraries remain available. `memory_curator` remains available only for explicit memory-management intent. `run_monitor` is retained pending an eligible long-run cohort. Low use without measured opportunities is never treated as low value.",
    "",
  ].join("\n");
}

module.exports = {
  PORTFOLIO_SCHEMA_VERSION,
  OBSERVATION_MIN_DAYS,
  OPPORTUNITY_MIN_SAMPLE,
  DISPLACEMENT_POLICY_VERSION,
  GLOBAL_EXPERIMENTAL_OPT_IN,
  EXTENSIONS,
  COMMAND_ONLY_MODEL_TOOLS,
  portfolioRecord,
  portfolioRecords,
  modelToolEnabled,
  toolDecisions,
  observationWindow,
  classifiedObservation,
  adoptionRows,
  opportunityRows,
  reliableCoreDisplacement,
  portfolioReport,
  renderPortfolioRecordMarkdown,
  renderPortfolioIndex,
};
