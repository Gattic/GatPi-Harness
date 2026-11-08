# Runtime configuration

This repo has fifteen runtime integration families:

- a read-only unified evidence and rollout center
- configured metadata-only visual verification providers
- typed, off-path Hermes advisory operations
- proof-carrying goals with typed Hermes controller advice
- bounded Ralph-style same-prompt automation loops
- non-autonomous periodic long-run monitoring
- visual roadmap/checklist tracking
- trace observability
- cognitive integration adapters
- CodeGraph CLI integration
- Semgrep CLI integration
- Obsidian research/memory notebook integration
- progressive codebase retrieval (`code_context`)
- general coding workflow tools (`lsp`, `test_runner`, `ast_search`/`ast_refactor`, `docs_lookup`)
- bounded completion enforcement for authorized implementation turns

## Recommended defaults

Recommended day-to-day defaults for this repo:

```text
canonical environment (`config/harness-defaults.env`): loaded first; explicit process overrides win
project-local reasoning runtime extension (`.pi/extensions/reasoning-runtime/`): on
trace: on, metadata-only payload capture
extension telemetry: on, metadata-only with privacy-tokenized interactive cohorts
privacy guard: on
policy enforcer: on, block mode
memory/context/anchoring/entropy: on
verification/orchestration/automatic branching/automatic consolidation: off; timing metadata on
role runtime: v2, explicitly configured R5, isolated mutation, topology adapter off, auto-router off
managed processes: no shared job-count limit; owned process groups capped at 6144 MiB RSS with TERM then bounded KILL
active context: proactive append-only compaction at 80% usage or 8 MiB structured context
execution outcome capture/learning/skill intake: on, advisory only; safe-source learning ingest on
project-memory diagnostics: on, metadata-only at M0; no writes or recall injection
Code Context: advisory; CodeGraph auto-sync on for local index freshness; Semgrep automatic advisory scans off
run monitor: on for explicit monitor/notify intent; automatic attachment off
output compactor: selected-tool canary on; model tool command-only
Model automatic prompt refinement and Hermes skill drafting: off; one-time intent-gated Obsidian status on
```

`scripts/install-project-extensions.sh` makes the defaults loader the first configured extension and supplies Pi's built-in compaction and bounded agent-level retry values only for settings that are unset, so an existing user preference (including `retry.enabled`) is preserved across reinstalls. Provider/model/theme and unrelated extension settings are preserved. The defaults loader fills only missing environment values, so an explicit launch environment remains the rollback/override authority.

### Manual topologies enabled; automatic routing off

The canonical defaults enable manual topology/task tools with `PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1` and `PI_SPECIALIST_TASKS_ENABLED=1`, retaining `PI_ROLE_MUTATION=isolated`, `PI_ROLE_ROLLOUT_STAGE=R5` and automatic routing `off`. Specialist graphs inherit parent model/effort unless a per-role `PI_ROLE_MODEL_<ROLE_ID>`/`PI_ROLE_THINKING_<ROLE_ID>` override is configured, without task/run budgets or correction caps; optional policy configures checkers, feedback is non-blocking, and no extra UI confirmation is required. Generic direct subagent contracts retain their role budgets. Leaving `PI_ROLE_SIDECAR` unset keeps parent-side typed launches available; child processes receive `PI_ROLE_SIDECAR=1`. If a reviewed session separately chooses `delegate`, matched top-level tasks execute the selected topology in the input lifecycle, settle, and inject a bounded typed result before the parent model turn. Role patches remain isolated until the parent explicitly previews and applies them.

The configured R5 stage is explicit operator authority, not fabricated benchmark promotion. Runtime status continues to report deterministic/live evidence eligibility and marks when the configured stage exceeds it. If `PI_ROLE_ROLLOUT_STAGE` is omitted, automatic evidence-based selection remains fail-closed and capped at R4. Explicit process environment values remain rollback controls. Start a new Pi process after changing the canonical defaults because values already populated in a running process are preserved.

The project-local reasoning runtime extension defaults on for `pi-harness`. The rename from the legacy `cognitive-automation` directory is complete: the extension lives at `.pi/extensions/reasoning-runtime/`, while runtime state stays under `.pi/cognitive-automation/` and the `PI_COGNITIVE_*` env knobs keep their names for compatibility. Verification, automatic branching, automatic memory consolidation, topology execution, and automatic Hermes advisory routing remain opt-in. The pure versioned classifier distinguishes answer, research, plan, review, implement, verify, publish, destructive, and no-route intents before selecting a topology when routing is explicitly enabled. `shadow` may execute only read-only advisory contracts while the normal parent turn continues. `delegate` automatically follows through for matched top-level prompts only in sessions that opt in; `/auto-roles once`, `auto_role_router run`, and `/topology-run` also require the topology adapter to be explicitly enabled. Legacy `run` warns and maps to read-only `shadow`. Publish, package-install, credential, and destructive intents never execute through the router. Keep `PI_MULTI_AGENT_TOPOLOGIES_ENABLED=0` and `PI_TOPOLOGY_AUTO_ROUTE=off`, or run `/auto-roles off`, to disable classification/injection entirely. Manual branch inspection/merge/rollback commands remain dry-run/guarded unless explicitly applied. Hermes has no shutdown sync or conversation-memory lifecycle; settled execution packets and governed Obsidian project memory are the durable handoff.

### Parallel evidence topology

`parallel-evidence-synthesis` is a built-in schema-v3 read-only DAG for explicit research/review use. It schedules four orthogonal workers after a public decomposition, audits typed evidence with a three-of-four minimum-success join, and reduces audited fields through a handler-only coordinator. Topology concurrency is four, while `PI_SUBAGENT_RPC_CONCURRENCY` remains the effective live sidecar capacity control and defaults to two. A degraded sufficient join returns `partial`, which never counts as a successful reliability run. Fewer than three successful workers blocks the auditor and fails the run.

The recipe remains catalog-visible and `suggest-only`; ordinary prompts do not execute it automatically. `shadow` and explicit invocation remain read-only. Mutation, verifier/benchmark, roadmap, memory-write, and patch-producing paths require all-success joins. No environment variable enables partial mutation.

### Managed process memory guard

`build_project`, `test_project`, detached `bg_run` jobs, `run_deck launch`, and RPC sidecars do not share a job-count admission limit. RPC fanout still obeys `PI_SUBAGENT_RPC_CONCURRENCY`. Every launched command or sidecar gets a separate owned process group whose RSS includes all descendants. Limit breaches and explicit stops send `SIGTERM`, wait the grace period, and then send `SIGKILL` only to that owned group. Attached external runs remain status-only and are never monitored or signalled because the harness does not own them.

```text
PI_MANAGED_PROCESS_MAX_RSS_MB=6144        aggregate RSS ceiling per owned process group
PI_MANAGED_PROCESS_RSS_POLL_MS=2000       owned-group sampling interval
PI_MANAGED_PROCESS_TERM_GRACE_MS=5000     TERM-to-KILL grace period
```

These are canonical missing-value defaults. An explicit process environment value wins. Raising the RSS limit increases OOM risk; lowering it may terminate workloads that legitimately need more memory.

The separate build-start guard requires at least **4096 MiB (4 GiB) of available RAM** by default. Projects can raise or lower this minimum with `"build": { "minimumStartMemoryMb": 8192 }` in `.pi/project.json`; the value must be a positive integer in MiB. This works for detected or custom build commands and configure/build scripts. `PI_BUILD_ALLOW_LOW_MEMORY=1` bypasses only the start check. The live RSS cap above remains unchanged. `PI_BUILD_RESERVE_MEMORY_MB` controls the native job-planning reserve, not the start minimum. See [Build Runner](productization-extensions.md#build-runner) for examples.

### Governed skill intake

`governed-skill-intake` is command-only and excluded from catalog recommendations, automatic role routing, model `run_topology` execution, automatic skill capture, and Hermes topology sync. It reads only manifest-listed files already staged below `.pi/skill-intake/sources/<source-id>/`, performs deterministic validation before model work, requires all independent review/audit branches, and writes only a private candidate under `.pi/skill-intake/candidates/`.

```text
PI_SKILL_INTAKE_ENABLED=1       default; set 0 to disable validation/runs
/skill-intake-validate <source-id> deterministic validation; no model call
/skill-intake <source-id>       explicit current-user run
/skill-intake-status
/skill-intake-list
/skill-intake-show <candidate-id>
/skill-intake-import <candidate-id>  explicit candidate import; no approval
```

There is no intake publish/push/install/discovery operation. Import preserves `candidate` and untrusted status; `/skill-approve` is a later separate governance action. Project memory rollout remains M0 `no-go-deferred`.

### Memory maintenance preview and provenance graph

Both adapters default enabled for explicit use and are independently reversible:

```text
PI_MEMORY_MAINTENANCE_ENABLED=1                    set 0 to disable the adapter
PI_PROVENANCE_GRAPH_ENABLED=1                      set 0 to disable the graph
PI_MEMORY_MAINTENANCE_PREVIEW_INTERVAL_HOURS=0     default/off; positive hours opt in to due reports
```

Operator surfaces:

```text
/memory-maintenance-preview                 write one private report; no apply
memory_explorer operation=maintenancePreview  return a no-write preview
memory_curator operation=maintenancePreview   explicit memory-management path; input.write=true writes only the report
node scripts/report-memory-maintenance.js --preview [--no-write]
/memory-provenance [seed]                   bounded metadata-only graph
/memory-lineage <id>                        typed lineage plus bounded unified provenance
/memory-provenance-export [seed]            explicit private graph export
memory_explorer operation=provenance
```

Preview scheduling runs only at session start when explicitly configured and due; it is not a background cleanup daemon. Reports never invoke retention apply, permission apply, deletion, note writes, candidate promotion, or memory mutation. Provenance is read-only, preserves source-specific records by normalized reference, and omits source bodies, prompts, transcripts, command arguments, raw tool output, private reasoning, secrets, and absolute paths. Missing providers and all node/edge/time bounds are explicit. These controls do not raise project-memory rollout: production remains M0 `no-go-deferred`.

### Compounding effectiveness scorecard

```text
PI_COMPOUNDING_EFFECTIVENESS_ENABLED=1    default explicit-report adapter; set 0 to disable
/learning-scorecard [--cohort=id] [--no-write]
/learning-scorecard-status
/compounding-scorecard [--cohort=id] [--no-write]
/compounding-status
learning_loop operation=scorecard          always no-write
learning_loop operation=compoundingStatus
node scripts/report-compounding-effectiveness.js [--cohort=id] [--no-write]
```

Scorecards are private under `.pi/learning-loop/scorecards/` and contain only IDs, hashes, counts, evidence classes, percentiles, gate statuses, provider coverage, and privacy/mutation assertions. They distinguish deterministic, synthetic, migration, exact-version field, and user-reviewed-gold evidence. A comparison remains `insufficient-data` unless an explicit pre-registered cohort contains both control and candidate arms with exact `(skillId, version, sourceHash)` and independent session hashes. Missing field proof, context-cost observations, maintenance apply/ignore decisions, and quality bounds remain `insufficient-data`.

The pre-registered experiment is `exp-memory-learning-compounding-efficacy-field`; generating a report does not launch or advance it. C0-C5 and their bars are documented in [Compounding effectiveness scorecard](compounding-effectiveness-scorecard.md). A passing gate remains advisory for human review and cannot authorize routing, publishing, push, project-memory stage promotion, proposal apply, retention/permission apply, or discovery. Production remains M0 `no-go-deferred`.

### Diagnostic collection and historical ledger migration

`PI_PROJECT_MEMORY_DIAGNOSTICS=1` enables bounded local diagnostics independently of the M0–M5 promotion ladder. Settled turns record candidate hashes, classification/rejection counts, zero-opportunity turns, and vault readiness in `.pi/project-memory/diagnostics.jsonl`. Explicit save/correction signals and execution references are metadata-only. This switch does **not** enable candidate application, task-recall injection, review-queue writes, Hermes calls, or canonical saves. Set it to `0` to stop collection. Start a new Pi process after changing defaults; loaded extensions do not retroactively change authority.

`node scripts/collect-memory-diagnostics.js` records one diagnostic-only baseline from existing typed records, even when the requested memory stage is higher. Diagnostics retain at most 2 MiB / 2,000 records / 30 days; collection does not manufacture reviewed gold or qualified field uses.

The rollout snapshot reports excluded experiment-schema counts rather than silently hiding old registrations. To migrate structurally valid historical registrations exactly once:

```text
node scripts/migrate-experiment-ledger.js          preview
node scripts/migrate-experiment-ledger.js --apply  preserve original records and convert to schema 2
```

Original timestamps, gates, decisions, and open/closed status are preserved. Private hash-addressed originals remain in `.pi/experiment-ledger/migration-originals/`; readers consume only the current schema. Migration never requalifies old evidence, launches a run, or changes a verdict. Unrecognized contracts are blocked, not guessed. Hermes reads C5 from the canonical compounding scorecard at `.pi/learning-loop/scorecards/latest.json`.

## Unified rollout and visual verification

The command-only Rollout Center composes existing rollout/evidence authorities into an ephemeral metadata-only snapshot:

```text
PI_ROLLOUT_CENTER=1                   enable `/rollout-center` (default)
/rollout-center [all|attention|stale] read-only interactive/headless view
```

It cannot launch work, record a gate, promote a stage, authorize mutation, or update a baseline. Extension Ops remains the inventory/portfolio authority. See [Unified Evidence and Rollout Center](rollout-center.md).

Visual Verification is an optional Verification Center provider configured under `.pi/project.json.visualVerification`:

```text
PI_VISUAL_VERIFICATION=1              enable configured visual cases (default)
PI_VISUAL_IMAGEMAGICK_BIN=magick      optional image metadata/pixel comparison binary
PI_VISUAL_GRAPHVIZ_BIN=dot            optional constrained Graphviz renderer
```

Configured cases are advisory unless a call explicitly includes `input.requiredProviders: ["visual"]`. Generated captures and diffs are temporary; evidence persists only artifact references, hashes, dimensions, provider/config/source identity, and bounded metrics. Browser readiness remains unavailable until a local Playwright package/browser is installed and separately authorized.

Baseline administration is intentionally outside Verification Center:

```text
node scripts/manage-visual-baselines.js preview <case-id>
node scripts/manage-visual-baselines.js apply <case-id> --yes --approval-ref=<safe-id>
```

See [Visual Verification Provider](visual-verification.md).

## Extension portfolio and model exposure

`src/extension-portfolio.js` is the versioned source of lifecycle, ownership, trigger, overlap, mutation/privacy, dependency, success-metric, and rollback records. [`docs/extension-portfolio/`](./extension-portfolio/README.md) contains one generated page per extension. `/extensions-portfolio` and `extension_ops operation=portfolio` reconcile those records with the runtime inventory and metadata-only telemetry.

Telemetry schema 6 stores an exact extension source fingerprint on every current event, suppresses duplicate `eventId` writes, and reports version/source cohorts plus operation-level transitions. Opportunity rows accept only reviewed fixed extension/trigger pairs; no prompt-derived trigger or user text is persisted. Retirement review still requires 30 current-session-excluded classified interactive days, at least 95% token coverage, extension-specific low-use evidence, and at least 20 eligible opportunities. Usage without opportunities remains insufficient data.

An explicit 2026-08 product review retired Semantic Patch Workbench and Workflow Conductor, merged plan fan-out into `create_subagent`, merged topology recipe administration into `run_topology`, and made CodeGraph file-tree inspection command-only. These surfaces have no compatibility gates or legacy state migrations. The only remaining experimental command-only model surface is manual Output Compactor compatibility:

```text
PI_OUTPUT_COMPACTOR_MODEL_TOOL=1     temporarily expose output_compactor for manual testing
PI_PORTFOLIO_EXPERIMENTAL_TOOLS=1   fleet opt-in for command-only portfolio tools
PI_TOOL_SURFACE_ROUTER=0             disable task/readiness-based model tool selection
PI_TOOL_CHURN_GUARD=0                disable repeated-call advisories
```

The consolidated portfolio has 65 parent-visible tool decisions before model-exposure policy and 64 after Output Compactor suppression; five role-sidecar tool decisions remain child-only. Tool Surface Router normally exposes a smaller task-specific subset. All commands remain directly available even while their model tools are inactive.

### Default-on native CodeMode

`extensions/codemode/index.ts` enables native Pi CodeMode by default in hybrid `codemode.mode: "on"`; direct tools remain available. `PI_CODEMODE=0`, `--exclude-tools codemode`, and explicit tool allowlists/no-tools sessions opt out without global settings writes. Native dispatch retains policy/result hooks and existing router eligibility; only reviewed read operations are script-callable. Host limits are 60 seconds, 32 nested calls, four in flight, and 2000 output tokens. Extra `models.*` calls and persistent script-store writes are disabled. CodeMode's `ALL_TOOLS`, `searchTools()` and `describeTool()` cover only those policy-allowed tools, never the session's declared tool surface; optional harness tools stay direct and are reached through `activate_tools` or an explicit request. See [Native CodeMode](codemode.md) for structured contracts, failure/evidence semantics, privacy and the fixed paired comparison. Benchmark benefit does not gate default enablement.

### Task-aware tool surface and churn guard

`extensions/tool-surface-router/index.ts` keeps every tool registered but removes reviewed optional groups from the initial model surface. `roadmap_update` remains in the initially allowed baseline, including for ordinary tasks and follow-ups without planning keywords; explicit tool exclusions and restricted child-role allowlists remain respected. Before each agent turn, the raw input is classified into fixed intents and matching tools are activated only when they were initially eligible and their provider is ready. Within a session the surface only grows: a turn adds the tools it needs and keeps every tool already active, and only session start returns to the baseline. Any change to the active set rebuilds Pi's system prompt and tool list, which invalidates the provider's whole prompt cache; replaying the Anthropic sessions from 2026-09-20 to 2026-10-03, per-turn rerouting caused 20 avoidable full-context cache rewrites (3.3M tokens, about $16) that keeping the tools avoids for about $1.40 of cached tool tokens. Prompts sent by extensions (a post-compaction "carry on", a loop iteration) are classified like any other prompt. Exact tool-name requests are honored under the same readiness/configuration boundary. CodeGraph/Semgrep status and doctor tools can explain unavailable providers while query/scan operations fail closed. `/tool-surface` reports only fixed intent labels and tool names; no prompt is stored.

The same extension registers `activate_tools`, one baseline model tool that answers what prompt routing alone cannot: which optional tools exist, which are blocked by configuration or a missing provider, and which are ineligible in a restricted session. Activation is additive and session-scoped, and it applies the router's eligibility and readiness gates, so it cannot widen a child-role surface or bypass `PI_*=0`/provider checks. Advisory context follows the same rule: the harness-awareness block names only tools that are declared and points at `activate_tools` for the rest, while the debug, experiment and run-deck summaries keep their durable state but name the activation path instead of claiming a tool the model may not have. This matters because the router strips optional groups at session start: a prompt that does not match any task group (for example a fleet migration request) previously left injected text naming `debug_ledger`, `experiment_ledger` and `run_deck` while none of them was declared.

`extensions/tool-churn-guard/index.ts` observes tool lifecycle metadata and appends one result advisory after repeated process polls, unchanged Git checks, Roadmap status churn, policy approval churn, or identical failed calls. Persisted entries contain tool, operation, count, timestamp, and fixed reason only. Disable either hook with `PI_TOOL_SURFACE_ROUTER=0` or `PI_TOOL_CHURN_GUARD=0`.

### Exact-source telemetry and operation canaries

`extension_ops operation=telemetry` includes `versionCohorts`, `sourceTransitions`, and operation rows bounded by exact source fingerprints. `extension_ops operation=compare` accepts an extension and optional before/after fingerprint or version selectors. `extension_ops operation=canaries` returns non-executable operation templates plus recorded metadata evidence; `input.record` requires a current canary ID and settled `passed|failed|not-applicable` stage. Canary telemetry stores no operation arguments or outputs.

### Output-compactor canary

Automatic bounding now defaults to the reviewed policy tool set while the manual compatibility model tool remains command-only:

```text
PI_OUTPUT_COMPACTOR_MODE=off|canary|all       default: canary
PI_OUTPUT_COMPACTOR_CANARY_TOOLS=ast_refactor,ast_search,bash,bg_run,code_context,codegraph_context,codegraph_query,create_subagent,debug_ledger,docs_lookup,lsp,memory_curator,memory_explorer,read,roadmap_update,semgrep_codegraph,specialist_tasks,test_gap_planner,test_runner
PI_OUTPUT_COMPACTOR_MAX_CHARS=2400            manual tool / bypass-observation threshold; per-tool caps come from src/tool-output-bounds.js
PI_OUTPUT_COMPACTOR_MODEL_TOOL=0              default; set 1 only for manual compatibility testing
```

Only results above their tool's cap are eligible. `canary` bounds results from the reviewed tool set; other oversized results produce a bypass observation. Head caps keep the start plus a continuation pointer (`read offset=`, docs/debug/roadmap paging); tail caps keep the end so failures and pi's truncation footer survive; structured caps compact JSON field-first. `verbose=true`, caller `maxChars`, already-budgeted native views, and results carrying image blocks are never rewritten. Metadata-only feature signals store tool identifier, input/output/saved character counts, duration, coarse session kind, and a local-salt HMAC session token—never result content, details, paths, prompts, or arguments. `off` disables the hook without removing `/output-compact`; `all` is an explicit broad trial, not the default.

## Automation loop

The Ralph-style loop is bounded by default and keeps its local replay state under `.pi/automation-loop/`:

```text
PI_AUTOMATION_LOOP=0                     disable the extension
PI_AUTOMATION_LOOP_MAX_ITERATIONS=20     default iteration budget
PI_AUTOMATION_LOOP_MAX_STALLS=3          pause after repeated identical no-progress settlements
PI_AUTOMATION_LOOP_MAX_PROMPT_CHARS=100000
PI_AUTOMATION_LOOP_BACKGROUND_POLL_MS=2000 poll bg_run/run_deck work started in an iteration
PI_AUTOMATION_LOOP_ALLOW_UNBOUNDED=1     explicitly permit --max=0
```

Use `/loop-help` for commands and `docs/automation-loop.md` for the post-retry settlement, token-bound stale-delivery rejection, completion, managed-background wait, pause, session-isolation, and safety contract.

## Settled execution handoff

Settled `/loop` and `/goal` transitions write privacy-valid packets under `.pi/execution-outcomes/`. Learning and skill consumers drain the metadata index with independent receipts; no extension ordering assumption is required. Defaults and immediate rollback controls:

```text
PI_EXECUTION_OUTCOME_CAPTURE=1   default-on producer; set 0 to stop new packets
PI_EXECUTION_OUTCOME_LEARNING=1  default-on packet-to-learning consumer; set 0 to leave packets pending
PI_EXECUTION_OUTCOME_SKILLS=1    default-on packet-to-skill-capture consumer; set 0 to leave packets pending
```

Packets contain hashes, canonical outcomes, bounded workflow/tool names, evidence/artifact references, metrics, and false privacy assertions. They contain no prompt, assistant/controller output, transcript, command arguments, private reasoning, secrets, or absolute paths. Packet ingestion creates at most one learning outcome and one procedural capture; it never synthesizes or approves a skill. A project-memory candidate **reference** is written only if the existing rollout authorizes candidate capture, and it still requires explicit curator review. Production project memory remains `no-go-deferred` at M0.

Aggregate goal-state ingestion is not the canonical execution handoff. See `docs/execution-learning-handoff.md`.

## Run monitor

The run monitor observes an existing `bg_run` job or `run_deck` run without controlling the target process; a milestone match or settlement runs `scripts/run-monitor-check.js` and shows its target probe without sending a user message or starting a model turn. It is session-scoped, edge-triggered, and intended for persistent TUI/RPC sessions:

```text
PI_RUN_MONITOR=0                    disable the extension
PI_RUN_MONITOR_INTERVAL_MS=30000    default poll interval
PI_RUN_MONITOR_TIMEOUT_MS=86400000  default observation deadline (24h)
PI_RUN_MONITOR_MAX_ACTIVE=8         active monitors per Pi session
PI_RUN_MONITOR_INTENT_TELEMETRY=1   metadata-only eligible/acted/settlement cohort; set 0 to disable
```

Use `/monitor-start`, `/monitor-status`, `/monitor-check`, `/monitor-stop`, and `/monitors`, or the `run_monitor` model tool. Terminal edges run `scripts/run-monitor-check.js` and record a fresh target probe as `scriptCheck`; no monitor check sends a user message or starts a model turn. A fixed local classifier records one privacy-tokenized opportunity at `agent_settled` when an interactive request combines monitor/notify intent with a managed long-run target; it stores no prompt text or target ID. Managed-process metrics v2 record idempotent starts, manual status/log calls, monitor attachments, settlement notifications, polling triples, and terminal evidence. Aggregate reports add attachment/notification/evidence rates and gap counts. Terminal evidence carries capture time and a privacy-safe working-tree fingerprint so Run Deck can report `current`, `stale-tree`, or missing evidence without exposing commands or target IDs. See `docs/run-monitor.md` for lifecycle, literal milestone matching, privacy, bounds, and the distinction from `automation_loop`.

## Evidence freshness and bounded status

Verification Center records a shared working-tree fingerprint after verifier execution. Change-set identity is computed from sorted per-file before/after digests without constructing an aggregate source string, and impact analysis retains only bounded samples. Shared-tree identity is computed by a streaming Git-status worker whose parent-process output is fixed-size, so large working trees do not exceed child-process or V8 string limits. Evidence Binder captures only Verification Center evidence whose fingerprint still matches the current tree; changed or legacy fingerprint-free evidence returns an actionable `not-applicable` result and must be rerun rather than recaptured with a newer timestamp. Binder ID validation also requires current-tree equality in addition to packet registration, packet-fingerprint integrity, passing status, and any caller-supplied minimum creation time.

`verification_center` status/evidence and `evidence_binder` status return bounded summaries by default: counts, IDs, timestamps, outcomes, confidence, tree freshness, and fixed item limits. Explicit `input.detail=true` retains bounded command/file/verifier inspection without returning raw verifier stdout or embedded proof bodies. Evidence-heavy tools are also in the Output Compactor canary as a second context-size guard.

## Cognitive integration

The cognitive extension uses the adapter boundary:

```text
src/integration-boundary.js
src/integration-config.js
src/file-integration-storage.js
```

Runtime state is persisted under:

```text
.pi/cognitive-automation/
```

Environment variables:

```text
PI_COGNITIVE_AUTOMATION=0              disable the reasoning runtime extension compatibility wrapper
PI_COGNITIVE_STORAGE_ROOT=/tmp/pi-state override the runtime-state root (primarily for isolated smoke tests)
PI_COGNITIVE_MEMORY_ENABLED=0          disable cognitive memory adapter
PI_COGNITIVE_CONTEXT_ENABLED=0         disable layered context adapter
PI_COGNITIVE_ANCHORING_ENABLED=0       disable semantic anchoring/diff adapter
PI_COGNITIVE_ENTROPY_ENABLED=0         disable entropy adapter
PI_COGNITIVE_AUTO_VERIFY=1             enable automatic verification
PI_COGNITIVE_AUTO_INJECT=0             disable per-turn cognitive context injection entirely
PI_COGNITIVE_INJECT_MAX_CHARS=2500      hard cap for first/full and later delta public context
PI_COGNITIVE_HEADLESS_INJECT=1         re-enable cognitive context injection in headless (pi -p) sessions; default off there
PI_REASONING_RUNTIME_ENABLED=0         disable reasoning scaffold artifacts
PI_COGNITIVE_ORCHESTRATION_ENABLED=1   enable legacy orchestration compatibility command
PI_COGNITIVE_BRANCHING_ENABLED=0       disable manual branch inspection/merge/rollback commands
PI_COGNITIVE_AUTO_BRANCH=1             enable automatic branch/checkpoint decisions
PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1    manual topology adapter; set 0 for launch rollback
PI_SPECIALIST_TASKS_ENABLED=1          explicit task surface; optional checker policy, no extra UI confirmation
PI_TOPOLOGY_AUTO_ROUTE=off             router mode: off, suggest, shadow, or delegate; legacy run warns and maps to shadow
PI_AUTO_ROLES=off                      alias for PI_TOPOLOGY_AUTO_ROUTE
PI_TOPOLOGY_AUTO_ROUTE_SUBAGENTS=1     force subagent mode on auto-routed model roles; when 0, the base topology config decides
PI_TOPOLOGY_AUTO_ROUTE_TOPOLOGY=project-planner-coder-verifier preferred implementation route
PI_TOPOLOGY_AUTO_ROUTE_MIN_CHARS=24    skip very short prompts unless manually routed
PI_TOPOLOGY_AUTO_ROUTE_COOLDOWN_MS=5000 debounce automatic run starts
PI_SKILL_INTAKE_ENABLED=0               disable explicit local governed skill intake
PI_SKILL_INJECT_MAX=1                   maximum hot-path skill suggestion count
PI_SKILL_INJECT_MIN_SCORE=0.5           fixed relevance floor; lower-scoring skills stay out of prompt context
PI_SKILL_GOVERNANCE_V2=0               rollback ranking only; v2 evidence/approval status remains visible
PI_SUBAGENT_STATE_ROOT=/tmp/pi-subagents override direct role-state storage (primarily for isolated smoke tests)
# Nested delegation is fixed off; live subagent depth is one.
PI_SUBAGENT_MAX_CONCURRENT=8           maximum active subagent records per parent session
PI_SUBAGENT_DEFAULT_WALL_CLOCK_MS=300000 default child execution wall-clock budget (queue time excluded)
PI_SUBAGENT_DEFAULT_STEP_BUDGET=8      compatibility name enforced as maxModelCalls
PI_SUBAGENT_DEFAULT_TOOL_CALL_BUDGET=64 default enforced tool-call budget
PI_SUBAGENT_DEFAULT_QUEUE_WAIT_MS=300000 default enforced RPC queue-wait budget
PI_SUBAGENT_MAX_LENGTH_CONTINUATIONS=0 bounded output-limit continuations; disabled by default
PI_SUBAGENT_FINAL_RESPONSE_CHARS=12000 cap and enforce rendered/durable subagent final response text
PI_SUBAGENT_BRANCH_SNAPSHOT_MODE=full  opt subagent checkpoints into full filesystem snapshots; default metadata-only
PI_BRANCH_SNAPSHOT_MAX_BYTES=8388608    maximum serialized branch recovery snapshot
PI_BRANCH_MAX_SNAPSHOTS=200             retention ceiling for unprotected snapshots
PI_BRANCH_RETENTION_DAYS=30             age gate for unreachable/pruned snapshots
PI_SUBAGENT_FULL_BRANCH_SNAPSHOTS=1    opt subagent checkpoints into full filesystem snapshots
PI_SUBAGENT_RPC_COMMAND=pi              executable for the single canonical rpc sidecar runner
PI_SUBAGENT_RPC_CONCURRENCY=2           maximum concurrent rpc sidecars; queue time is separately bounded/reported
# RPC depth is fixed at one. Ambient extensions, skills, and prompt templates are always disabled.
PI_ROLE_RUNTIME_VERSION=1|2             immediate compatibility rollback; default 2
PI_ROLE_MUTATION=off|isolated            disable role mutation or require isolated worktrees
PI_ROLE_SIDECAR=0|1                      parent rollback gate; explicit role child sets 1 internally
PI_ROLE_ROLLOUT_STAGE=R0|R1|R2|R3|R4|R5 explicit configured stage; omit it for evidence-selected rollout capped at R4
PI_ROLE_RUNTIME_BENCHMARK_REPORT=.pi/role-runtime/benchmarks/latest.json
PI_ROLE_RUNTIME_BENCHMARK_MAX_AGE_MS=604800000 maximum deterministic benchmark age
PI_ROLE_RUNTIME_FIELD_REPORT=.pi/role-runtime/audits/latest.json live aggregate field-evidence report
PI_ROLE_RUNTIME_FIELD_MAX_AGE_MS=86400000 maximum live field-evidence age
PI_ROLE_FIELD_PILOT=0|1                 read-only R0 cohort collection; never permits mutation
PI_ROLE_WORKER_SHADOW_CANARY=0|1        R0/suggest/mutation-off canary only; canonical manual-only default sets 0
PI_ROLE_MODEL_<ROLE_ID>=provider/model  per-role model override; canonical defaults are task-specific
PI_ROLE_THINKING_<ROLE_ID>=level        per-role off|minimal|low|medium|high|xhigh|max override
PI_ROLE_STATE_MAX_MB=512                final role-state cleanup size threshold
PI_ROLE_STATE_MAX_AGE_DAYS=30           final successful role-state retention age
PI_ROLE_STATE_KEEP_RECENT=100           newest final files retained per role-state inventory
PI_SUBAGENT_WORKSPACE_MAX_MB=512        retained isolated-worktree cleanup size threshold
PI_SUBAGENT_WORKSPACE_MAX_AGE_DAYS=7    retained isolated-worktree cleanup age threshold
PI_SUBAGENT_EXECUTION_FIXTURE_RESULT=... deterministic TUI subagent runner output
PI_CHECK_TUI=1                         include optional TUI checks in scripts/check-all.sh
PI_COGNITIVE_CONTEXT_BUDGET_TOKENS=1800
PI_COGNITIVE_VERIFY_DEBOUNCE_MS=1500
PI_VERIFICATION_MAX_OUTPUT_BYTES=262144       per-stream verifier capture/normalization ceiling
PI_INTEGRATION_STORAGE_MAX_JSON_BYTES=67108864 JSON state read/write ceiling with oversized-file preservation
PI_REASONING_AUTO_PRUNE_AUTOMATED=1           continuously retain bounded automatic verifier artifacts
PI_REASONING_AUTO_PRUNE_AUTOMATED_MAX=240      prune when automatic verifier evidence exceeds this count
PI_REASONING_AUTO_PRUNE_AUTOMATED_KEEP=120     automatic verifier evidence triples kept after pruning
PI_REASONING_SNAPSHOT_KEEP=3                  pre-prune snapshots retained per process
```

When `PI_ROLE_ROLLOUT_STAGE` is omitted, automatic rollout requires both a valid deterministic benchmark and a fresh passing live field report with >=30 exact-cohort read-only runs; missing or invalid evidence remains R0 and the combined evidence-selected default is capped at R4. An explicitly configured stage is authoritative operator selection and is reported with `evidenceOverride=true` when it exceeds current evidence eligibility. The canonical configuration explicitly selects R5 and isolated mutation, enabling manual topology execution while keeping automatic delegate follow-through disabled. See [normal-session specialist use](specialist-tasks.md#normal-session-use) for task policy and acceptance boundaries. Set `PI_MULTI_AGENT_TOPOLOGIES_ENABLED=0`, `PI_TOPOLOGY_AUTO_ROUTE=off`, `PI_ROLE_ROLLOUT_STAGE=R0`, `PI_ROLE_MUTATION=off`, or `PI_ROLE_RUNTIME_VERSION=1` for immediate state-preserving rollback. Evidence scorecards retain their own claim boundaries and are not relabeled by an operator override. See `docs/role-runtime-benchmark.md`.

Verifier evidence records original-size/truncation metadata while keeping stdout and stderr bounded. Failed verification reasoning stores compact proof summaries and evidence-file references rather than full logs. JSON writes are preflighted and atomic; legacy files above the JSON ceiling are not parsed, and the next successful write renames the old file to `*.oversized-<timestamp>.bak`. Reasoning snapshots use file copies so pruning cannot require another heap-sized serialization. Runtime Doctor and roadmap reasoning import report oversized state without loading it.

Registered direct roles are validated `RoleContract` v2 objects with workspace/mutation policy, actual child tools, model/thinking policy, typed output and completion policy. Generic roles have enforced budgets; specialists use `budget: null` and inherit parent inference by default, while `PI_ROLE_MODEL_<ROLE_ID>`/`PI_ROLE_THINKING_<ROLE_ID>` still win over that default and RPC profile overrides remain ignored. Specialist task/run budgets and correction caps are absent; host retention, containment, cancellation and output limits remain. Role children launch with `--no-extensions -e <role-sidecar> --no-skills --no-prompt-templates --model <provider/model> --thinking <level>`; missing tools or inference-profile mismatches fail before provider use. Because skill discovery is disabled for children, every role prompt carries a bounded skill-awareness block built from `skills/catalog.json`: the full roster by category plus the skills governing that role, with an explicit degradation note if the roster outgrows its bound. That block is part of the system prompt and therefore part of `roleRevisionHash`, so changing a role's prompt changes its revision and older typed records fail closed with `SUBAGENT_ROLE_CONTRACT_UNAVAILABLE` on continuation instead of silently running a stale prompt. Successful v2 execution requires a schema-valid terminating `submit_role_result`. Diagnostics count calls/results/failures separately and record selected/effective models and thinking levels. Mutating roles run in detached Git worktrees seeded from the exact dirty parent state and return bounded patch metadata. Parent files change only through explicit hash/conflict-checked patch apply plus verification. Unknown labels without an explicit `systemPrompt` fail closed; explicit custom roles are bounded shared-readonly contracts that default to `local/DeepSeek-V4.1-Flash-1017` and inherit the parent's effort level.

All model-backed delegates default to `local/DeepSeek-V4.1-Flash-1017`. Effort remains role-specific: planner/reviewer/coder/refactorer/evidence-auditor use `high`, researcher and benchmark use `medium`, worker and verifier use `low`, and patch-reviewer and custom roles inherit parent effort. Handler-only roles launch no model. The canonical defaults also pin the specialist 3D producer to `medium` effort while leaving its model unset, so it inherits the parent session model; procedural Blender geometry work is bounded by effort here, and a model pin would fail whenever the pinned provider is rate-limited or unauthenticated. An explicit launch override still wins. Model and thinking are separate policy fields: environment overrides win over the role contract, then explicit `inherit` resolves from the parent session before spawn. A model value with a trailing thinking suffix is rejected. Start a new Pi process after changing `config/harness-defaults.env`; `/reload` does not replace already-populated environment defaults. The new model matrix invalidates prior runtime-fingerprinted benchmark and field evidence; historical Luna/Sol/Astra cohorts do not establish DeepSeek-V4.1-Flash quality. Role children load only the approved provider registration and the role sidecar, so they do not load `pi-queue`: when the canonical delegate model belongs to a queued provider, child requests bypass the shared Redis queue.

Skill governance schema v2 keeps source trust, schema validity, sandbox review, local verification, exact-version field proof, advisory retrieval, routing approval, and publishing approval separate. Legacy `approved` records migrate in memory to advisory-only authority. Model-tool approval/provider import/topology write require current-user intent; publishing approval is command/human-only. A successful fixture cannot create field proof or routing/publishing authority.

Commands:

```text
/cognitive-status
/cognitive-memory [query]
/cognitive-context [query]
/cognitive-entropy
/cognitive-branches
/branch-list
/branch-show <branch-id>
/branch-export <branch-id>                         metadata-only; never recovery payload
/branch-cleanup-preview
/branch-cleanup-apply --yes                        preview-first lineage-aware maintenance
/branch-diff <left-branch-id> <right-branch-id>
/branch-merge <left-branch-id> <right-branch-id> [--apply] [--force]
/branch-rollback <branch-id> [snapshot-id] [--apply|--yes]
/auto-roles [off|suggest|shadow|delegate|status|route <task>|once <task>|cancel]
/subagent [--role registered-id] [--merge policy] [--no-run] <task>
/subagent-create [--role registered-id] [--merge policy] <task>
/subagent-run <subagent-id|latest>
/subagent-list
/subagent-show <subagent-id|latest>
/subagent-cancel <subagent-id|latest>
/subagent-merge <subagent-id|latest> [policy]  trajectory/result only; never applies files
/subagent-patch-preview <subagent-id|latest>
/subagent-patch-apply <subagent-id|latest> --yes
/subagent-status
/subagent-events [limit]
/subagent-export [file]
/subagent-prune [--keep=N] [--older-than=Nd] [--status=a,b]
/model tool: create_subagent              create/list/get/cancel/merge; run uses the contract workspace and explicit role sidecar; unknown roles require systemPrompt and are shared-readonly
/model tool: auto_role_router            status/classify/setMode/run/cancel; automatic mutating run remains blocked
/cognitive-verify
/reasoning-plan [objective]
/reasoning-artifacts [type]
/reasoning-checkpoint [summary]
/reasoning-failures
/reasoning-clear-stale
/reasoning-debug-context [query]
/reasoning-version
/reasoning-self-test
/reasoning-prune [maxAutoScaffold]
/reasoning-export
/reasoning-replay [type]
```

Cognitive context injection now emits the full runtime/scaffold once per session, then only changed `### Active objective`, `### Decisions and evidence`, `### Constraints and safety`, `### Warnings and routing`, and `### Reasoning scaffold` sections; the scaffold is re-sent whenever the turn's modality changes. Extension-authored prompts (such as a post-compaction continuation) keep the last user turn's scaffold. Repeated strategic objective memories, successful proof history, exact duplicates, and stable auto-router guidance are omitted. An unchanged state injects nothing. Metadata-only telemetry records rendered, injected, and saved character counts; it never stores the context. The deterministic Phase 5 benchmark is documented in `docs/phase5-context-privacy-benchmark.md`. Headless `pi -p` sessions remain injection-free unless `PI_COGNITIVE_HEADLESS_INJECT=1` is set.

Branch recovery snapshots are local-only, private (`0700` directories/`0600` files), canonicalize every relative path inside the repository, reject absolute/traversal/duplicate aliases and symlink components, exclude `.pi` and environment paths, remove transcript/prompt/raw fields, redact/cap recovery strings, and enforce the snapshot byte limit. `/branch-export` emits lineage and aggregate state only. Cleanup sanitizes legacy files and removes only old/overflow snapshots unreachable from live or ancestor lineage; `scripts/maintain-branch-snapshots.js` and the commands above require preview before apply.

## Prompt suggestions

Deterministic local suggestions remain synchronous and default-on. After Pi reaches the post-retry `agent_settled` boundary, the local selector uses the original labelled-next-step and categorical fallback behavior. A separately configured machine-wide Pi model restores the original best-next-prompt instruction and recent-context shape through the provider-neutral model registry; it is chosen with `/prompt-suggestions-model` and saved in `<agent-dir>/prompt-suggestions.json`, independently of the session model. Refinement defaults to the evidence-gated `auto` cohort. Suggestions are cancellable background work without request deadlines. While the non-timeout quality cohort is incomplete, one background bootstrap attempt is allowed per new idle state, without a timed cooldown. Explicit `1` force-enables automatic refinement and explicit off disables it. If no model is configured, local suggestions remain available and refinement is skipped.

```text
PI_PROMPT_SUGGESTIONS=0                         disable all prompt suggestions
PI_PROMPT_SUGGESTIONS_REFINE=off|auto|1         off, evidence-gated (default), or force-on
PI_PROMPT_SUGGESTIONS_MODEL=<provider/modelId>  process override for the saved machine-wide model
PI_PROMPT_SUGGESTIONS_CONFIG=<path>             override the config file path
PI_PROMPT_SUGGESTIONS_REFINE_MIN_ATTEMPTS=20
PI_PROMPT_SUGGESTIONS_REFINE_MIN_ACCEPTANCE_RATE=0.20
PI_PROMPT_SUGGESTIONS_REFINE_MAX_FAILURE_RATE=0.25
PI_PROMPT_SUGGESTIONS_REFINE_WINDOW_DAYS=30
PI_PROMPT_SUGGESTIONS_CONTEXT_CHARS=6000 # scanner-redacted recent-context cap
```

Suggestion telemetry contains only source, fixed action/outcome, latency, and a fixed categorical reason code. It records local generation, model refinement/skip/failure, and shown/accepted/dismissed/retried actions without suggestion, provider error text, or session text. Ctrl+R cancels the prior request and starts a fresh attempt immediately. Unrestricted `auto` refinement requires at least 20 non-timeout attempts, non-timeout failure rate <=25%, and accepted/shown >=20%; before then it permits bootstrap attempts per new idle state while local guidance remains immediate. Timeouts remain observable but cannot complete or poison the quality cohort. The timeout-rate and bootstrap-interval settings have been removed. Typing, acceptance, dismissal, a new agent turn, and shutdown/reload cancel in-flight refinement. The provider packet carries a scanner-redacted excerpt of at most eight recent public messages (900 characters each and 6,000 characters total by default) plus bounded public skill telemetry. It never contains raw session objects, unredacted tool output, private reasoning, secrets, command arguments, or absolute paths. Model input and output are scanned before use, and the extension does not invoke Hermes.

## Progressive codebase retrieval

The read-oriented `code_context` facade is provided by `.pi/extensions/code-context/`; provider/ranking logic stays in `src/code-context-service.js`. It is explicit, local-first, and non-blocking by default. Existing `lsp`, `codegraph_*`, and `semgrep_*` tools remain available for provider diagnostics.

```text
PI_CODE_CONTEXT_MODE=off|shadow|advisory|select-tests|on
PI_CODE_CONTEXT_RG_BIN=rg
PI_CODE_CONTEXT_RG_TIMEOUT_MS=30000
PI_CODE_CONTEXT_RG_INTERNAL_LIMIT=2000
PI_CODE_CONTEXT_SEARCH_LIMIT=15
PI_CODE_CONTEXT_MAX_EXTRACT_BYTES=16384
PI_CODE_CONTEXT_MAX_OBJECT_BYTES=65536
PI_CODE_CONTEXT_CACHE_MAX_MB=64
PI_CODE_CONTEXT_CACHE_MAX_AGE_DAYS=14
PI_CODE_CONTEXT_BENCHMARK_REPORT=.pi/code-context/benchmarks/latest.json
PI_CODE_CONTEXT_TELEMETRY_SNIPPETS=0   opt in only for bounded retrieval snippets
PI_LSP_LIVE=0                       disable lazy live servers while retaining compiler/fallback results
```

The current default is `advisory`. No `before_agent_start` source-map injection occurs. `shadow` may collect bounded telemetry but must not change model-visible context. `select-tests` requires a saved report whose `promotion.selectTestsEligible` is true; `on` requires `promotion.onEligible`. Without that evidence the effective mode is demoted to `advisory`, even when the environment requests a promoted mode. Impact-selected tests only augment discovered baseline commands.

Missing CodeGraph, ripgrep, compiler, or language-server providers return explicit degradation, and `freshness=stale`, degradation, or `gatingSafe=false` can never suppress baseline verification or authorize an edit. Retrieval events use the namespaced `code-context:retrieval` channel and the existing trace runtime. They contain bounded IDs, counts, paths, latency, rollout mode, and evidence links—not source bodies or transcripts. Snippet capture is off by default.

## Trace observability

Reusable trace runtime lives at:

```text
src/trace-observability.js
```

Project-local Pi adapter:

```text
.pi/extensions/trace-observability/index.ts
```

Trace storage defaults to repo-local state:

```text
<repo>/.pi/traces/<session>.jsonl
```

Environment variables:

```text
PI_TRACE_ENABLED=0                    disable tracing
PI_TRACE_DIR=<repo>/.pi/traces        override trace root
PI_TRACE_ROTATE_BYTES=26214400        JSONL rotation threshold
PI_TRACE_MAX_TOTAL_BYTES=134217728    aggregate retained trace-byte budget per root
PI_TRACE_HEADROOM_RATIO=0.25          prune down to this fraction below the byte budget
PI_TRACE_MAX_FILES=200                aggregate retained file-count budget per root
PI_TRACE_MAX_AGE_DAYS=14              maximum age for disposable trace history
PI_TRACE_HEADROOM_RATIO=0.25          prune down to this fraction below the byte budget
PI_TRACE_COMPRESS_PAYLOAD_BYTES=32768 compress large payloads
PI_TRACE_CAPTURE_PAYLOADS=0           metadata-only payload mode
PI_TRACE_RECENT=500                   recent in-memory event ring
PI_TRACE_LIVE_WIDGET=1                use TUI widget for /trace-live when UI exists
```

`FileTraceStorage` itself now defaults `capturePayloads` to false, so direct library consumers are metadata-only even without the extension environment. Explicit `capturePayloads:true`/`PI_TRACE_CAPTURE_PAYLOADS=1` is reserved for controlled debugging; legacy payload-bearing files remain preview-only in runtime cleanup.

Trace retention includes closed session files and rotations owned by the current project. Filenames use `<canonical-project-path-sha256>--<session-id>.jsonl`, so ownership survives closure/rotation without sidecars and session IDs cannot collide across projects. New writes never claim unattributed historical filenames. In shared roots (including `--global`), foreign-project and unattributed traces remain protected: run maintenance from the owning project, rather than treating missing local debug references as deletion authority. Live process leases, explicit `<trace-file>.keep` pins, debug references, and payload-bearing or unclassifiable history are protected. Owned files without a live lease have a 24-hour inactivity grace unless a final shutdown event proves settlement. Whole-file privacy classification uses bounded streaming reads; sampling cannot authorize deletion. Retention checks run on startup/close, rotation, and every 256 KiB appended. Concurrent writers release their leases on shutdown. Protected overflow is reported as `overBudget`, not described as a successfully enforced cap. Files/directories are hardened to `0600`/`0700`, without following symlinks.

Both the live integration-boundary entropy collector and standalone monitor retain at most **4 MiB / 2,000 records / 14 days per stream** (events and snapshots). Compaction reads a bounded suffix plus one preceding byte to distinguish complete boundary records from partial lines, uses interprocess locking and atomic replacement, and does not scan unbounded history on each event. Core session JSONL, evidence packets, research results, and canonical notes are not managed by these limits.

```text
node scripts/maintain-diagnostics.js                  preview project trace cleanup and entropy limits
node scripts/maintain-diagnostics.js --global         include the global trace root
node scripts/maintain-diagnostics.js --global --apply apply the reviewed scope; write a metadata-only receipt
```

Commands:

```text
/trace-status
/trace-live [filter]
/trace-timeline
/trace-errors
/trace-subagents
/trace-export [correlation_id]
/trace-replay summary
/trace-replay step <index>
```

## CodeGraph CLI adapter

Project-local source:

```text
.pi/extensions/codegraph/index.ts
```

The CodeGraph adapter exposes the local `codegraph` binary through Pi commands and focused model tools. The extension is intentionally thin; shared behavior lives in `src/codegraph-adapter.js` so Project Intelligence, Test Gap Planner, Verification Center, Code Context, and Runtime Doctor can consume graph context as advisory local data. `/codegraph-files` remains command-only to avoid a redundant low-value model surface. It defaults to the current Pi cwd, executes with argument arrays rather than shell interpolation, truncates large output, and writes full truncated output to a temp file. Explicit project paths outside the current cwd are blocked unless enabled by environment. Missing binaries and uninitialized repos are detected before graph-dependent operations and reported with install/init/index guidance. `codegraph_status`, project snapshots, result metadata, and `codegraph_doctor` use the same resolved-project adapter freshness verdict; status prepends that verdict so raw provider text cannot imply greater freshness. CodeGraph remains optional and non-blocking by default; it must not become a private-reasoning store or a mandatory completion gate. Verification Center makes it a gate only for an applicable `plan`/`run` tool call with `input.requiredProviders: ["codegraph"]`; otherwise absence is explicit degraded-advisory `not-applicable` state.

Environment variables:

```text
PI_CODEGRAPH=0                    disable the CodeGraph extension
PI_CODEGRAPH_BIN=codegraph         override the executable path/name
PI_CODEGRAPH_TIMEOUT_MS=120000     default command timeout
PI_CODEGRAPH_MAX_BUFFER=20971520   child-process capture buffer
PI_CODEGRAPH_MAX_LINES=2000        output truncation line cap
PI_CODEGRAPH_MAX_BYTES=51200       output truncation byte cap
PI_CODEGRAPH_ALLOW_OUTSIDE=1       permit explicit project paths outside cwd
PI_CODEGRAPH_AUTO_SYNC=1           opt into per-checkout debounced sync after observed tool mutations
PI_CODEGRAPH_AUTO_SYNC_DEBOUNCE_MS=1500 debounce window for optional auto-sync
PI_CODEGRAPH_ADVISORY=0            disable CodeGraph advisory enrichment in other harness workflows
PI_CODEGRAPH_ADVISORY_TIMEOUT_MS=1500 timeout for advisory doctor/affected-test probes
```

Mutation tracking, sync, status/query reads, snapshots, and diagnostics share one project-root resolver. The nearest initialized `.codegraph/codegraph.db` at or above the requested directory wins, including a project-local index nested inside a Git checkout. Resolution stops at that checkout's `.git` boundary rather than borrowing an ancestor worktree's index; without a local index, the checkout root is the fallback. This also works when Git is unavailable. The owning root may sit above cwd, but explicitly requested outside-cwd paths and symlink escapes remain excluded unless enabled. File edits/writes select the nearest owning index for their target, including nested indexes edited from a parent session. Affected-file arguments remain relative to the requested directory and are rebased to the selected index root for the CLI.

Shell calls and applied/rolled-back refactors compare before/after HEAD and content fingerprints across permitted worktrees. Without Git metadata, file tools fingerprint their explicit files; bulk tools fingerprint project files without traversing symlink directories, runtime state, caches, or non-first-party directories. This detects shell `cd`, `git -C`, scripts, and changes to already-dirty files without guessing shell semantics. Unchanged projects are not scheduled; partial writes from failed tools are still observed. Non-Git projects can sync, but their Git-based freshness remains `unknown` and `gatingSafe: false` rather than claiming an unproven revision.

Each selected index project has its own debounce timer and freshness/error state; syncing one does not refresh another. Sessions selecting the same index, whether at its root or in a subdirectory, share its state and timer instead of creating a second record under the subdirectory. Git revisions for nested projects scope status to their files and rebase porcelain paths before hashing, so repeated dirty-file edits are detected while uncommitted sibling edits do not invalidate the project. Shutdown cancels pending timers. Worktree indexes still require their own CodeGraph initialization.

Commands:

```text
/codegraph-status [path]
/codegraph-sync [--full] [path]
/codegraph-query [--kind kind] [--limit n] <search>
/codegraph-context [--max-files n] <task>
/codegraph-affected [--depth n] [--filter glob] [files...]
/codegraph-files [--path path]
/codegraph-doctor [path]
/model tools: codegraph_status, codegraph_query, codegraph_context, codegraph_affected, codegraph_sync, codegraph_files, codegraph_doctor
```

## Semgrep CLI adapter

Project-local source:

```text
.pi/extensions/semgrep/index.ts
```

The Semgrep adapter exposes the local `semgrep` binary, including a Docker-backed wrapper, through Pi commands and model tools. Shared behavior lives in `src/semgrep-adapter.js` so Project Intelligence, Test Gap Planner, Verification Center, Code Context, and Runtime Doctor can consume static-analysis context as optional advisory data. It defaults to the active Pi cwd, executes with argument arrays rather than shell interpolation, disables Semgrep metrics by default, truncates large output, and blocks explicit project paths outside the cwd unless enabled by environment. Binary, config, and scan readiness are reported separately; `p/default` is the unpinned registry default, `auto` is rejected before launch while metrics are off, and unavailable packs are negative-cached after a bounded `--validate` preflight. `semgrep_codegraph` combines Semgrep findings with CodeGraph affected-test lookup and still returns CodeGraph advisory hints when Semgrep is degraded. Verification Center makes Semgrep a gate only for an applicable `plan`/`run` tool call with `input.requiredProviders: ["semgrep"]`; `src/provider-readiness.js` keeps all other absence degraded-advisory and non-blocking.

Environment variables:

```text
PI_SEMGREP=0                       disable the Semgrep extension
PI_SEMGREP_BIN=semgrep             override the executable path/name
PI_SEMGREP_CONFIG=p/default        reproducible default Semgrep registry pack; `auto` is rejected while metrics are off
PI_SEMGREP_TIMEOUT_MS=120000       default command timeout
PI_SEMGREP_MAX_BUFFER=20971520     child-process capture buffer
PI_SEMGREP_MAX_LINES=2000          output truncation line cap
PI_SEMGREP_MAX_BYTES=51200         output truncation byte cap
PI_SEMGREP_ALLOW_OUTSIDE=1         permit explicit project paths outside cwd
PI_SEMGREP_ADVISORY=0              disable background enrichment, not explicit risk-focused verification checkpoints
PI_SEMGREP_ADVISORY_TIMEOUT_MS=8000 timeout for advisory scans/status probes
PI_SEMGREP_VERIFY_TIMEOUT_MS=30000 verification-center security-checkpoint scan timeout
PI_SEMGREP_PATCH_TIMEOUT_MS=8000   semantic-patch Semgrep advisory timeout
PI_SEMGREP_METRICS=off             disable Semgrep metrics by default
PI_SEMGREP_CONFIG_PROBE_TIMEOUT_MS=30000 bounded config-resolution preflight before scan readiness
PI_SEMGREP_CONFIG_READY_TTL_MS=86400000 cache successful config readiness
PI_SEMGREP_CONFIG_FAILURE_TTL_MS=900000 negative-cache unavailable/invalid packs to prevent repeated doomed retries
PI_SEMGREP_MAX_FINDINGS=200        finding cap stored in tool-result details
```

Commands:

```text
/semgrep-status [path]
/semgrep-scan [--config config] [--severity severity] [--include glob] [--exclude glob] [files...]
/semgrep-changed [files...]
/semgrep-codegraph [--scan-all] [--depth n] [files...]
/semgrep-doctor [path]
/model tools: semgrep_status, semgrep_scan, semgrep_codegraph, semgrep_doctor
```

## Obsidian research/memory notebook adapter

Project-local source:

```text
.pi/extensions/obsidian/index.ts
```

The Obsidian adapter exposes a local Markdown vault through Pi commands and model tools. Shared behavior lives in `src/obsidian-adapter.js`; the extension remains optional and local-first like CodeGraph/Semgrep. `resolveVaultSelection()` is authoritative for Obsidian status/doctor/note/search/import, project-memory runtime, Memory Explorer, and Memory Curator. It reports a stable `selectionId`, `projectKey`, and `pathHash` plus separate readiness for vault filesystem, rollout-authorized reads, rollout-authorized explicit writes, Hermes curation, desktop executable/open state, and scorecard-only automatic behavior. Full paths remain runtime-only and do not enter persisted readiness metadata. A missing or closed desktop does not block local search/note/import when the vault filesystem is ready. An explicitly configured vault (`PI_OBSIDIAN_VAULT` or adapter options) is always authoritative, even when it does not exist yet; exactly one valid discovered vault may be selected only when none is configured, while multiple valid discoveries fail closed, so writes can never be redirected by a guess. Note, import, and index writes resolve against the real vault root, reject intermediate/final symlinks, and use no-follow file opens where supported. Automatic awareness/status is injected only for a fixed narrow Obsidian/vault/literature/research-note intent, never on ordinary coding prompts. Hermes-backed curation is explicit: `/obsidian-doctor --probe-auth` runs a bounded model probe, `--probe-curation` adds a synthetic-input dry-run smoke that never reads vault bodies or writes a note, and `/obsidian-hermes` requires current same-binary/provider/model proof from both probes before requested curation.

Environment variables:

```text
PI_OBSIDIAN=0                         disable the Obsidian extension
PI_OBSIDIAN_BIN=obsidian              override the Obsidian executable path/name
PI_OBSIDIAN_VAULT="~/Obsidian/Pi Research" managed vault path
PI_OBSIDIAN_VAULT_NAME="Pi Research" default managed vault name
PI_OBSIDIAN_DEFAULT_ROOT=~/Obsidian   default parent directory for managed vaults
PI_OBSIDIAN_RESEARCH_ROOTS=...        comma-separated default import roots
PI_OBSIDIAN_ALLOW_OUTSIDE=1           permit explicit paths outside cwd/home
PI_OBSIDIAN_MAX_LINES=2000            output truncation line cap
PI_OBSIDIAN_MAX_BYTES=51200           output truncation byte cap
PI_OBSIDIAN_MAX_FILES=200             max vault/import files to scan by default
PI_OBSIDIAN_MAX_IMPORT_FILE_BYTES=524288 skip larger import sources by default
PI_HERMES_ADVISORY=0                  disable all Hermes advisory surfaces
PI_HERMES_BIN=hermes                  override Hermes executable
PI_HERMES_PROVIDER=...                optional explicit provider identifier
PI_HERMES_MODEL=...                   optional explicit model identifier
PI_HERMES_CURATION_TIMEOUT_MS=120000  Hermes curation timeout
PI_HERMES_AUTH_PROBE_TIMEOUT_MS=30000 bounded authenticated model-probe timeout
PI_HERMES_CURATION_PROBE_TIMEOUT_MS=60000 bounded dry-run curation-smoke timeout
PI_OBSIDIAN_AUTO_AWARE=0              disable automatic model awareness prompt
PI_OBSIDIAN_AUTO_STATUS=0             disable one-time automatic status probe
```

Commands:

```text
/obsidian-status [vault]
/obsidian-doctor [--probe-auth] [--probe-curation] [--timeout-ms n] [vault]
/obsidian-search <query>
/obsidian-note <title> :: <markdown body>
/obsidian-import [--apply] [--include-code] [--max-files n] [paths...]
/obsidian-hermes <topic>
/obsidian-hermes-review <receipt-id> <accept|reject|correct>
/obsidian-open [note.md]
/model tools: obsidian_status, obsidian_search, obsidian_note, obsidian_import, obsidian_hermes, obsidian_doctor
```

Runtime state:

```text
.pi/obsidian/    private 0700/0600 metadata-only events (operation/outcome/category/duration/counts); no prompts, provider output, credentials, paths, vault contents, or source bodies
.pi/hermes-advisory/  shared private metadata-only readiness, receipts, and scorecard state
```

For the current `~/dev/glades-ml` research corpus, preview first:

```text
/obsidian-import --max-files 50 ~/dev/glades-ml/research ~/dev/glades-ml/docs
```

Then apply when the preview looks right:

```text
/obsidian-import --apply --max-files 500 ~/dev/glades-ml/research ~/dev/glades-ml/docs
/obsidian-hermes glades-ml CHIRON FACE MFIO flagship
# After reviewing a returned candidate:
/obsidian-hermes-review <receipt-id> accept
```

## General coding workflow tools

See [Risk-focused code analysis](code-analysis-workflow.md) for the non-duplicating tool workflow, explicit security checkpoints, opt-in Node coverage evidence, observational outcome review and specific optional LSP installations. `ast_*` is regex-backed lexical tooling, not a parser or scope-aware rename engine.

Project-local sources:

```text
.pi/extensions/lsp/index.ts
.pi/extensions/test-runner/index.ts
.pi/extensions/ast-tools/index.ts
.pi/extensions/docs-lookup/index.ts
```

These tools are model-callable/manual workflows for normal coding tasks and do not run automatically on the prompt hot path. Shared behavior lives in `src/lsp-adapter.js`, `src/test-runner.js`, `src/ast-tools.js`, and `src/docs-lookup.js`. Test Runner returns `outcome=not-applicable` when no repository-defined command applies or no prior failures exist; this is neither a passing verification nor a tool failure. An explicitly requested empty integration, lint, or typecheck profile stays not-applicable and never substitutes quick-profile commands.

LSP lexical navigation (`symbols`, `workspaceSymbols`, `definition`, `references`, `hover`, and `renamePreview`) runs in a disposable worker per fallback analysis, including workspace language sampling. The parent enforces `timeoutMs` (default `PI_LSP_TIMEOUT_MS`, 30 seconds; positive overrides capped at 10 minutes), including worker startup. Live requests and each fallback analysis have separate budgets. Abort, deadline expiry, worker error/exit, and session shutdown initiate termination of the owned worker. Request settlement and shutdown wait for worker termination and cleanup, so `timeoutMs` is not a strict end-to-end wall-clock limit. Timeout/cancellation/failure throws an explicit error rather than returning a successful empty lookup. No worker starts at extension load.

Fallback declarations use bounded per-line lexical scanning, not compiler resolution. Workspace enumeration prunes caches (`.cache`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `__pycache__`) and existing dependency/build exclusions. An explicit requested file is admitted before the workspace/file-list cap, subject to language, source-extension, regular-file and 2 MB limits; explicit files may intentionally target an excluded directory. Symlink files and symlink ancestors below the project root are rejected, and project-root symlink escapes cannot bypass the cwd guard. Fallback results remain `advisory: true`, `gatingSafe: false`; rename analysis is preview-only. Rename apply stays on the separate live-LSP, same-instance hash/queue authorization path. These disk changes eliminate the known declaration-regex hang and make fallback navigation interruptible; they cannot interrupt a regex already executing in an existing session. Compiler-diagnostic subprocess timeouts and status sampling are separate from this navigation worker boundary.

`docs_lookup` remains confined to the active project by default. Pi framework installation/API documentation outside the active repository is routed through the `read` tool at `$PI_SOURCE_ROOT/packages/coding-agent/README.md`, `docs/`, and `examples/` (the configured source checkout defaults to sibling `../pi`). Follow Markdown cross-references there; do not set `PI_DOCS_ALLOW_OUTSIDE=1` merely to read Pi's own installation docs.

Environment variables:

```text
PI_LSP=0                         disable the LSP-style coding tool
PI_LSP_TIMEOUT_MS=30000           default LSP helper timeout
PI_LSP_DIAGNOSTIC_TIMEOUT_MS=30000 diagnostics command timeout
PI_LSP_ALLOW_OUTSIDE=1            permit explicit project paths outside cwd
PI_LSP_MAX_LINES=2000             output truncation line cap
PI_LSP_MAX_BYTES=51200            output truncation byte cap
PI_TEST_RUNNER=0                  disable test_runner
PI_TEST_RUNNER_TIMEOUT_MS=120000   per-command timeout
PI_TEST_RUNNER_ALLOW_CUSTOM=1      allow custom command execution; default is inferred commands only
PI_AST_TOOLS=0                    disable AST search/refactor tools
PI_AST_ALLOW_OUTSIDE=1             permit explicit project paths outside cwd
PI_AST_MAX_RESULTS=500             AST search result cap
PI_AST_MAX_CHANGES=1000            AST refactor change cap
PI_DOCS_LOOKUP=0                  disable docs_lookup
PI_DOCS_ALLOW_OUTSIDE=1            permit explicit project paths outside cwd
PI_DOCS_MAX_RESULTS=20             docs search result cap
```

Commands:

```text
/lsp-status
/lsp-diagnostics [--file f] [files...]
/lsp-symbols [--file f] [--language lang]
/lsp-definition <symbol>|--file f --line n --column n
/lsp-references <symbol>|--file f --line n --column n
/lsp-hover --file f --line n --column n
/lsp-rename-preview <symbol> <newName>
/lsp-rename-apply <symbol> <newName>
/test-runner-status
/test-runner-profiles
/test-runner-infer [--profile changed|quick|full] [files...]
/test-runner-run [--profile changed|quick|full] [--coverage] [files...]
/test-runner-rerun-failures
/ast-status
/ast-search [--kind call|function|class|identifier|regex|text] <pattern>
/ast-refactor-preview [--kind identifier|text|regex|call] <pattern> --replacement <text>
/ast-refactor-apply [--kind identifier|text|regex|call] <pattern> --replacement <text>
/ast-refactor-rollback [checkpoint-id]
/docs-status
/docs-lookup [--package pkg] [--source local|node_modules|all] <query>
/docs-read <path> [--offset n] [--limit n]
/docs-package <package-name>
/model tools: lsp, test_runner, ast_search, ast_refactor, docs_lookup
```

Runtime state:

```text
.pi/test-runner/    latest structured test evidence
.pi/ast-refactor/   checkpointed AST refactor applies
```

## Context-overflow compaction recovery

Project-local source:

```text
.pi/extensions/context-overflow-recovery/index.ts
```

Overflow and threshold recovery, over-limit manual `/compact`, and `/compact-rescue` force the summarization request to SSE with the active Pi session ID. If network summarization fails, is disabled, or itself exceeds the input limit, the extension returns a bounded local summary from `src/context-overflow-recovery.js`; if structured recovery also throws, a minimal dependency-free summary prevents fall-through to the default network summarizer. Extension load evicts the CommonJS helper cache so `/reload` always uses matching helper exports. Trace observability's `session_before_*` observer hooks return `undefined` so they cannot overwrite the recovery extension's control result. Pi then writes a normal compaction entry. Overflow retry continues through Pi's post-run loop, while rescued manual compaction queues a continuation after AgentSession reconnects. At `agent_settled`, an output-token-limited assistant is also continued after any threshold compaction, with a consecutive-injection bound and suppression when another extension already queued work. Manual compaction below pressure remains on Pi's default path.

Environment variables:

```text
PI_COMPACTION_RECOVERY=0                     disable recovery interception
PI_COMPACTION_RECOVERY_NETWORK=0             use local recovery without an SSE attempt
PI_COMPACTION_RECOVERY_TIMEOUT_MS=60000       forced-SSE timeout
PI_COMPACTION_RECOVERY_MAX_INPUT_CHARS=600000 serialized input cap
PI_COMPACTION_RECOVERY_MAX_SUMMARY_CHARS=24000 local/LLM summary cap
PI_COMPACTION_RECOVERY_AUTO_CONTINUE_OUTPUT_LIMIT=0 disable automatic output-limit continuation
PI_COMPACTION_RECOVERY_MAX_OUTPUT_LIMIT_CONTINUATIONS=3 consecutive automatic-continuation bound
PI_COMPACTION_PROACTIVE=0                     disable proactive settled-context compaction
PI_COMPACTION_PROACTIVE_PERCENT=80            context-usage trigger percentage
PI_COMPACTION_PROACTIVE_MAX_CHARS=8388608     bounded active structured-context trigger
```

Commands:

```text
/compact-rescue [focus]
/compaction-recovery-status
```

See `docs/context-overflow-recovery.md` for the session-file finding and stuck-chat runbook.

## Completion enforcement

Project-local source:

```text
.pi/extensions/completion-enforcement/index.ts
src/completion-enforcement.js
```

A settled implementation turn is continued when its final message stops on a limit pi does not impose ("execution-budget checkpoint", "turn limit", "context budget") or reports unfinished required work ("root outcomes: 1/6 complete", "next: …", "remaining milestones") without an evidenced blocker or an explicit user decision. A progress ratio counts only when a counter label names it in the same clause, so slash-separated identifiers such as a host list (`node-2/3/4/5/1`) or a version pair (`relay v5/v5`) are not counters. A complete counter (`root outcomes: 6/6 complete`) or an explicit completion claim ("every required outcome is complete", "nothing in the authorized scope remains") settles instead of continuing. A turn that reports only one increment, milestone, phase, or step as finished ("I am done with the first increment", "M1 complete") counts as partial work unless it also claims all required outcomes. The continuation restates the user's authorized objective and that no harness execution budget exists. `AGENTS.md` governs intent; the roadmap records required outcomes; this extension only refuses to accept an unevidenced early stop. It reads the final message's vocabulary and does not consult roadmap state, so a stop with no progress or limit language settles normally.

Read-only modalities are never enforced. `src/task-modality.js` classifies the user's request, and investigation, planning, verification, and answer turns settle normally without a continuation, so read-only requests stay read-only. A report-style request that still asks for tests to pass ("review the parser and make all tests pass") is classified as implementation rather than investigation.

Enforcement yields to real boundaries: an aborted turn (the user stopped it), an explicit user pause or scope limit stated in the request ("implement M1 only", "stop after M1", "leave the rest"), a clarification or approval question ("which database should I use?", "is it acceptable to delete…?"), an authorization request (delete, pause, commit, push, deploy, approve an allowance), an evidenced blocker (blocker plus log/error/exit evidence), waiting on managed work (`bg_run`/`run_deck`), another queued continuation owner, and a completion claim. A question mark anywhere in the final message is a decision boundary; "should I continue?" is still a proceed request and is continued. A stop conditioned on completion ("stop when done", "stop when the tests pass") is a completion instruction, not a boundary. A bounded continuation count keeps an unsatisfiable task from looping, and reaching the bound is reported once as a warning instead of silently stopping enforcement. A queued continuation is re-checked on the next tick so another settled handler (compaction rescue, automation loop) can win. A slash-command or skill turn is not enforced under the previous objective; enforcement resumes on the next real instruction.

```text
PI_COMPLETION_ENFORCEMENT=0        disable the extension
PI_COMPLETION_MAX_CONTINUATIONS=8  continuation bound per user request (0 disables continuations; blank or invalid keeps 8)
```

The gate and bound are read when the extension loads, including on `/reload`.

`/completion-enforcement-status` reports the tracked modality, continuation count, user-boundary state, and bounded decision reasons (metadata only; no transcript text).

## Roadmap checklist

Project-local source:

```text
.pi/extensions/roadmap/index.ts
.pi/extensions/roadmap/roadmap-state.js
```

The roadmap extension provides a persistent visual checklist/status layer for long-running plans, multi-step implementations, and multi-session work. It renders a compact widget above the editor, a footer status indicator, and a scrollable overlay panel. State is explicit and public; the model can update it through the `roadmap_update` tool instead of relying on prose inference. The v3 state schema is recursive and adds explicit lifecycle/actionability, current-item evidence bindings, transition provenance, compact mutation envelopes, and recovery metadata.

Private state defaults to a per-session store beneath the Git worktree (or project) root, so concurrent sessions in one directory keep independent roadmaps:

```text
.pi/roadmap/sessions/<session-id>/active.json           atomic current state
.pi/roadmap/sessions/<session-id>/last-known-good.json  bounded recovery packet
.pi/roadmap/sessions/<session-id>/archive/*.json        retained archived roots
.pi/roadmap/sessions/<session-id>/archive-index.jsonl   metadata-only archive index
.pi/roadmap/active.json                                directory-level state for unscoped writers (scripts, topology appliers outside a session)
.pi/roadmap/telemetry/events.jsonl                     metadata-only exact-version cohort shared by the directory
```

The store root resolves through `git rev-parse --show-toplevel`, so a nested working directory shares its repository's roadmap while each Git worktree keeps its own. When a session has no roadmap, `roadmap_update action=show` lists the roadmaps in that directory and `action=adopt roadmapId=<id>` copies one into the current session's store without touching the owning session's packet. `set_status` accepts `itemIds` plus `cascade=true` to settle several items, and a milestone's nested goals, in a single call.

All files use mode `0600` beneath mode-`0700` directories. Writes use exclusive no-follow temporary files plus atomic rename; malformed active state can recover from the last-known-good packet.

Environment variables:

```text
PI_ROADMAP=0                 disable the roadmap extension and retain rollback control
PI_ROADMAP_WIDGET_ITEMS=6    max checklist items in the compact widget
PI_ROADMAP_TELEMETRY=0       disable dedicated metadata-only roadmap telemetry
```

Commands:

```text
/roadmap
/roadmap-panel
/roadmap-start <title> [:: step one | step two] [--parent=item]
/roadmap-subtask <title> [:: step one | step two] [--parent=item]
/roadmap-replace <title> [:: step one | step two]
/roadmap-add <step> [--roadmap=id]
/roadmap-active <item-id|numeric-path>
/roadmap-adopt <roadmap-id>
/roadmap-done <item> [<item>...] [--evidence=id] [--cascade]
/roadmap-verify <item-id|number> <evidence-id|--evidence=id> [--unsubstantiated]
/roadmap-block <item-id|number> <reason>
/roadmap-skip <item-id|number> [reason]
/roadmap-close [reason]
/roadmap-shelve [reason]
/roadmap-resume
/roadmap-archive [reason]
/roadmap-link <item-id|number> [artifact-id] [--evidence=id]
/roadmap-next
/roadmap-import-reasoning
/roadmap-report
/roadmap-export [--focus=id] [--offset=n] [--limit=n]
/roadmap-clear
/model tool: roadmap_update
```

For continuation, show the canonical root and resume existing IDs with `active`/`resume`; do not start another implementation wrapper. Roadmaps are bound to the session that owns them and stored beneath the worktree/project root, so concurrent sessions in one directory keep independent plans. When a session has no roadmap, `show` lists the roadmaps in that directory and `action=adopt roadmapId=<id>` (or `/roadmap-adopt`) continues one without touching the owning session's packet. A manual `start` with the same root title and unchanged inventory is idempotent; conflicting inventory is rejected instead of silently redefining scope. `/roadmap-start` and tool action `start` for genuinely new work create a root only when no roadmap is active, the previous roadmap is settled, or its lifecycle is closed/shelved. Otherwise they nest beneath the actionable active leaf. When no actionable leaf exists, automatic nesting returns `ROADMAP_PARENT_REQUIRED`; blocked or stale fallback scope is never selected. `/roadmap-replace` and tool action `replace` are the only direct whole-root replacement surfaces. Replaced, cleared, and explicitly archived roots are retained in the private archive. Nested item references use alternating item/subroadmap numeric paths, for example `#2.1.3`; nested roadmap references use `@2.1`.

Statuses distinguish actionable `pending`/`active`, nonactionable `blocked`/`paused`/`shelved`, and terminal states. A parent whose only unresolved descendants are nonactionable has no active pointer. Roadmap lifecycle actions `close`, `shelve`, `resume`, and `archive` make blocked-only decisions explicit without deleting history. Input disposition separately identifies complete, still-actionable, and unresolved-nonactionable roots.

Roadmap activation is independent of topology routing. The Tool Surface Router keeps an initially allowed `roadmap_update` in the baseline rather than requiring an explicit planning keyword. With `roadmap_update` active, the parent model is instructed to proactively track substantive multi-step investigation, implementation, and verification without waiting for an explicit tracking request; simple answers and one-step tasks are exempt. Roadmap's own `before_agent_start` hook adds a read-only, bounded snapshot of persisted state (focused on the active item) and reminds the parent to reuse continuing scope and update statuses before its final response. This works with `PI_TOPOLOGY_AUTO_ROUTE=off`, without the reasoning extension, and after session reloads. Inactive tools/restricted child roles receive no reminder. The hook neither creates plans nor changes statuses, including in headless sessions: plan authorship and progress decisions remain model-side, not a deterministic execution gate.

The [full-plan execution contract](full-plan-execution.md) defines finite gates, blocker mapping, resource lifecycle, and exact closeout. Passing an increment does not end an authorized full-plan implementation; continue independent dependency-ready outcomes. Derived task labels, summaries, and recall are advisory; explicit actions/restrictions outrank TypeSafe modality suggestions. Bare continuation resolves from the previous concrete user task, including its restrictions, or stays unclassified when none is known. Session startup and tree navigation recover that task from `reasoning-runtime.user-task` records on the active branch, captured by the input hook only for non-extension user input. Transcript `user` roles alone cannot establish provenance because Pi also uses that role for extension-authored prompts. Sessions without these records leave a bare continuation unclassified; recalled summaries never supply authority. No classification grants cross-repository, destructive, or publish permission.

Executable plans can pass `milestones: [{ title, goals[] }]` to `roadmap_update` `start`, explicitly authorized `replace`, or `add_subtask`. The compiler creates each phase/milestone as a roadmap task and one nested goals roadmap beneath it in a single state mutation. Planner roles emit this public `roadmapPlan` hierarchy but remain read-only. Typed implementation topologies declare a `roadmapPlanGate`; the parent runtime validates and persists the hierarchy before downstream coder/refactorer nodes can start, and fails closed if application is unavailable. Legacy flat `items` calls and advisory planner results without `roadmapPlan` remain valid.

Root items are the stable required-outcome inventory; plan authors must make them deliverables, not transient process steps. Keep permanent tracking at milestone/goal depth and routine checks in notes/evidence. Separately tracked helpers close and return to their unfinished parent; they never complete it automatically. Summaries and mutation/report packets expose root `outcomes` (total, complete, verified, blocked) separately from recursive workflow counts. A nested blocker counts against its root outcome once. Skipped root outcomes cannot support a completion claim, and `done` alone cannot support a verification claim. Historical trees are not silently reinterpreted, flattened, or deleted; explicit scope decisions own consolidation.

Ordinary model-tool mutations return a versioned envelope containing only the changed item/subroadmap sample, applied ids, counts, progress, and active path; they never duplicate full state in `content` and `details`. `set_status` accepts `itemIds` and `cascade=true`, which marks pending/active nested descendants deepest-first in the same call so a finished milestone and its goals settle together; a rejected reference leaves state untouched. Explicit `show`/`export` supports `focusId`, `offset`, `limit` (maximum 200 entries), and `maxChars` (maximum 20,000). The fixed 10/50/100/500-item corpus is `tests/fixtures/roadmap/large-roadmap-manifest.json`.

`verified` requires a current evidence binding to the item's content fingerprint. Bindings retain the verifier packet fingerprint and are revalidated against EvidenceStore whenever state is loaded or saved; missing, replaced, failed, or invalid packets downgrade the item to `verified-unsubstantiated`. Missing and stale proof return typed evidence errors. Explicit overrides remain separate from substantiated evidence counts and block verified completion claims. Transition provenance distinguishes work-backed, batch, backfill, override, migration, and manual changes. `/roadmap-report` exposes claim-consistency counts and a historical-versus-exact-version aggregate field report.

`/roadmap-import-reasoning` seeds the checklist from the latest public reasoning-runtime `plan` or `task_decomposition` artifact in `.pi/cognitive-automation/reasoning-runtime.json`, preferring non-scaffold artifacts when available. An active roadmap receives the import as a nested subtask rather than being overwritten. The importer refuses files above `PI_INTEGRATION_STORAGE_MAX_JSON_BYTES` instead of parsing an oversized state into the Pi heap. Roadmap items can link to reasoning artifact ids and verifier evidence ids without storing private scratchpads. Dedicated telemetry stores only fixed metadata fields and random per-runtime session tokens—never titles, notes, prompts, paths, evidence values, arguments, or results. Generate the aggregate report and sample-size-aware scorecard with `node scripts/generate-roadmap-release-scorecard.js`; a field cohort can never authorize `ship` unless the active session token was supplied for exact exclusion.

## Extension refresh and project-memory rollout

Use the unified state-aware refresh workflow for extension settings and Agent Skills:

```bash
scripts/pi-harness-refresh.sh              # extensions + skills + full checks
scripts/pi-harness-refresh.sh --extensions # extension settings + full checks
scripts/pi-harness-refresh.sh --skills     # managed skill reconciliation + full checks
scripts/pi-harness-refresh.sh --all        # include the linked Pi source fork
```

Lower-level diagnostics remain `scripts/install-project-extensions.sh`, `scripts/install-agent-skills.sh`, `scripts/check-project-setup.sh`, and `scripts/check-all.sh`. Extension smoke timeout controls are `PI_EXTENSION_SMOKE_RPC_TIMEOUT_MS=15000` and `PI_EXTENSION_SMOKE_MODEL_TIMEOUT_MS=120000`.

Global settings load both repository extension roots:

```text
<pi-harness>/.pi/extensions
<pi-harness>/extensions
```

Canonical project-memory rollout variables:

```text
PI_PROJECT_MEMORY_STAGE=M1
PI_PROJECT_MEMORY_WRITES=1
PI_PROJECT_MEMORY_AUTOMATIC=1
PI_PROJECT_MEMORY_AUTO_SAVE=1
# Manual-only rollback: PI_PROJECT_MEMORY_AUTOMATIC=0
# Capture-only kill switch: PI_PROJECT_MEMORY_AUTO_SAVE=0
# Read-only rollback: PI_PROJECT_MEMORY_STAGE=M0
# Write kill switch (also overrides evidence-authorized stages): PI_PROJECT_MEMORY_WRITES=0
PI_PROJECT_MEMORY_SCORECARD_MAX_AGE_MS=604800000
PI_PROJECT_MEMORY_PRIVACY_EVIDENCE_MAX_AGE_MS=86400000
PI_PROJECT_MEMORY_REVIEWED_GOLD_EVIDENCE_MAX_AGE_MS=604800000
PI_REVIEWED_GOLD_REVIEWER_ID=<local-reviewer-id>
PI_REVIEWED_GOLD_SIGNING_KEY=<32-byte-minimum-secret>
PI_PROJECT_MEMORY_RETENTION_APPLY=0
PI_SESSION_SEARCH_ROOTS=~/.pi/agent/sessions
```

The harness defaults supply operator-authorized automatic project memory at M1. Start a new Pi process after changing defaults; existing values (including inherited M0 or AUTO_SAVE=0) remain authoritative. The runtime accepts a private scorecard only when its source identity and age are current. Missing, mismatched, future-dated, or expired evidence resolves to M0 unless exactly `M1` with `PI_PROJECT_MEMORY_WRITES=1` is configured. With `PI_PROJECT_MEMORY_AUTOMATIC=1`, selective source-bound capture stores unverified facts without per-save consent and task-conditioned recall injects relevant canonical notes. This grants no M2–M5 promotion, verified upsert, Hermes or maintenance authority. Manual mutations still require matching current-turn consent and apply/write. Vault isolation, scanning, conflict handling and limits apply; see [project-memory operations](project-memory-operations.md). Status separates `stageAuthority: operator-opt-in`, unchanged `evidenceEligibleStage`, and `fieldEffectiveness: unproven`. Reviewed-gold collection uses signed evidence; keep the signing key outside repository files, shell history, command arguments, logs, and generated artifacts.

### Declared project-memory posture

`config/memory-posture.json` is the recorded operator decision for the project-memory stage keys. When it is present and valid, its `stage`, `writes`, `automatic`, and `autoSave` values outrank inherited shell exports for exactly those four keys; every other environment value keeps its documented precedence. This is what makes the posture explicit: a stale `PI_PROJECT_MEMORY_STAGE=M0` or `PI_PROJECT_MEMORY_AUTO_SAVE=0` left in a launching shell can no longer silently pin the harness below its recorded posture. `PI_PROJECT_MEMORY=0` remains an unconditional kill switch because the posture never declares it.

```json
{
  "schemaVersion": 1,
  "stage": "M1",
  "writes": true,
  "automatic": true,
  "autoSave": true,
  "recordedAt": "2026-10-25",
  "rationale": "operator-authorized selective capture/recall; evidence promotion remains blocked"
}
```

An absent file leaves the environment untouched, so launch overrides keep their previous authority. A malformed, unreadable, or oversized (over 64 KiB) file is reported as `posture.invalid` with a reason and is never applied; a declared `writes`, `automatic`, or `autoSave` that is not a boolean invalidates the whole declaration instead of being silently ignored. A file that exists but cannot be read is reported as `present` with a read-failure reason rather than as an absent declaration. Roll back by editing `stage`/`autoSave` in the file or deleting it; `PI_PROJECT_MEMORY=0` disables every control immediately, including the separately opted-in `cognitiveConsolidation` and `retentionApply` controls. `cognitiveConsolidation` is enforced: `memory_curator operation=consolidate` with `apply:true` is refused unless the rollout is enabled and the control is granted. `PI_PROJECT_MEMORY_POSTURE=env` restores environment precedence for one session, which is the supported way to run with a deliberate per-key override such as `PI_PROJECT_MEMORY_AUTOMATIC=0` without editing the recorded posture. Automatic capture also requires a confirmed canonical vault: a fallback `default-managed` vault is refused as `canonical-vault-unconfirmed` until an explicit save provisions the project folder. `/harness-defaults-status` prints the declared posture, the preserved overrides that disagree with canonical defaults, and the recorded rollout posture. `.pi/harness-defaults/posture.json` records the observed posture at startup (keys and redacted conflict values only; no credentials, prompts, transcripts, or absolute paths).

## Hermes advisory

Version-controlled source:

```text
extensions/hermes-advisory/index.ts
src/hermes-advisory.js
src/hermes-integration-scorecard.js
```

All active consumers use `HermesAdvisoryAdapter` through `src/integration-boundary.js`. Only the adapter calls `src/hermes-client.js`. Requests are independent bounded one-shots; there is no project conversation, recall cache, shutdown sync, or final-summary writer.

Provider and gate variables:

```text
PI_HERMES_ADVISORY=1
PI_HERMES_BIN=hermes
PI_HERMES_PROVIDER=<optional>
PI_HERMES_MODEL=<optional>
PI_HERMES_PROMPT_TIMEOUT_MS=10000
PI_HERMES_CONTROLLER_TIMEOUT_MS=30000
PI_HERMES_AUTH_PROBE_TIMEOUT_MS=30000
PI_HERMES_CURATION_PROBE_TIMEOUT_MS=60000
PI_HERMES_CURATION_TIMEOUT_MS=120000
PI_HERMES_READINESS_TTL_MS=3600000
PI_HERMES_FAILURE_BACKOFF_MS=60000
PI_PROMPT_SUGGESTIONS_REFINE=auto
PI_HERMES_SKILL_AUTO_DRAFT=0
```

Prompt refinement is a read-only advisory surface and defaults to evidence-gated `auto`; `PI_PROMPT_SUGGESTIONS_REFINE=1` force-enables it and `=off` disables it explicitly. The suggestion model is configured separately with `/prompt-suggestions-model` and is independent of the session model. `PI_HERMES_SKILL_AUTO_DRAFT=0` keeps automatic drafting closed. Setting the latter to `1` is still insufficient: the compounding field gate must authorize it. Logging volume, migrated historical registrations, and missing or insufficient C5 evidence are not authorization.

Commands:

```text
/hermes-status
/hermes-doctor [--curation]
/hermes-plan <bounded public task>
/hermes-review <bounded evidence references>
/hermes-evidence <bounded evidence references>
/hermes-feedback <receipt-id> accept|reject
/hermes-scorecard [--write]
```

The `hermes_advisory` model tool requires explicit current-user Hermes intent and is read-only. Status reports provider readiness, advisory authorization, canonical-promotion authority, and automatic-mutation authority separately. Provider packets are scanned and cannot contain transcripts, private reasoning, raw tool output, secrets, command arguments, or absolute paths. Receipts store category, duration, schema validity, repair turns, version identity, and disposition only.

Obsidian curation is dry-run by default and emits typed unverified project-memory candidates. The model tool cannot apply them. Explicit `/obsidian-hermes --apply` can only submit to the governed review queue when M4 authorizes Hermes curation; it cannot promote canonical memory. Agent Skill drafts require the deterministic 3-repeat/80%-success/2-independent-run/2-verified-success gate and stay under `.pi/hermes-skill-candidates/` until explicit `--apply --yes` promotion.

Use `node scripts/report-hermes-integration.js` for a preview or `--write --yes` to persist the private qualified-denominator scorecard. E3 remains `NULL-RESULT`; C5 reports the canonical compounding scorecard's actual status. Missing field evidence is `insufficient-data`, never pass or zero. Run `scripts/regression-hermes-advisory.sh` and `scripts/smoke-hermes-advisory.sh` for regression and manual checks.

## TypeSafe Jev turn judgment

Plan and evidence: `docs/jev-integration-plan-2026-10-02.md`. The skill-suggestion and tool-group questions were removed on 2026-10-03 after failing their reviewed-gold gates; the request now asks only for the scaffold modality and research-memory intent. Version-controlled source:

```text
src/typesafe-client.js            # only HTTP caller of api.typesafe.ai
src/typesafe-turn-judgment.js     # request builder, code-owned thresholds, mode
src/typesafe-evaluation.js        # metric definitions, pre-registered bars, turn records
src/typesafe-gold.js              # reviewed-gold extraction, review, evaluation
scripts/typesafe-gold.js          # gold workflow CLI
scripts/report-typesafe-field.js  # field report and field-gate recording
scripts/smoke-typesafe.sh         # manual key-gated live check (not in check-all)
```

Extensions use `SystemOneAdapter` as `boundary.typesafe`. reasoning-runtime starts at most one System One request per idle user submission at `input` and publishes the adapter's read-only service on the `typesafe:service` event bus channel; obsidian reads the same pending result. Steering and follow-up messages, `/` commands, extension-authored prompts, and subagent sessions (`PI_SUBAGENT_PARENT_ID` set, so the mode is `off`) are not judged.

Settings (evaluation period; the flag is removed when the feature passes or is removed):

```text
TYPESAFE_API_KEY=<user shell env>   # ~/.bashrc.d/typesafe.sh, mode 600; never in settings or chat
PI_JEV_TURN_INTENT=off|shadow|on    # default off: scaffold modality and research-memory intent
PI_JEV_MODEL=jev-1.13.0             # pinned versioned model; thresholds are tuned against it
```

- `off` sends nothing and records nothing.
- `shadow` sends the request and records the judgment beside the local decision; nothing the agent sees changes and no turn waits for it.
- `on` waits for the judgment and uses it: scaffold text uses the judged modality, and Obsidian automatic context uses the judged research-memory intent.
- There is no speed target. A request fails only after 10 s (TypeSafe's SDK default timeout); that bound remains because Pi cannot cancel a turn while it waits before the agent starts. Latency is reported in the field report but not gated. Requests are not retried.
- Failure means absence: a missing key, 401/422/429/529, timeout, or network error omits the judgment for that turn, and the scaffold uses the neutral `unclassified` template.
- Unrecognized mode values are treated as `off` and listed under `invalidSettings` in `/cognitive-status`.

Privacy decision (approved by the user on 2026-10-02):

- Sent to TypeSafe: the current user prompt after `redactMemoryText` (secrets, home paths, and code blocks removed) capped at 2,000 characters; the modality and research-memory question text from source.
- Never sent: tool output, file contents, transcripts, earlier turns, memory, private reasoning, environment values, or the API key outside the `Authorization` header.
- TypeSafe does not train on requests; zero data retention is enterprise-only, so every request is treated as retained.
- Safety, privacy, policy, approval, credential, destructive, and publish decisions never use a judgment. Protected task modalities are decided locally before any judged modality applies.

Local state (private 0700/0600):

```text
~/.pi/agent/typesafe/turns.jsonl         # metadata-only turn records from every project; newest 5,000 kept (pruned at session start)
.pi/typesafe/gold/candidates.jsonl       # redacted gold candidates and review labels
.pi/typesafe/gold/responses.jsonl        # cached evaluation answers (after review approval only)
.pi/typesafe/gold/evaluation-*.json      # evaluation reports
```

Field records from every project go to the one shared file in Pi's agent directory (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`), so the field report covers sessions launched anywhere; the gold files stay in this repository's ignored `.pi/typesafe/`, which the privacy-guard scan covers. Turn records contain fixed labels, numbers, and the answering model; never prompt text, paths, or project names. `report-typesafe-field.js --record` records verdicts in this repository's experiment ledger and exits non-zero when there is nothing to judge or no open experiment. The field report and field gates count only `interactive` sessions; RPC, print, smoke, and fixture sessions are listed as `excludedNonInteractive`. `/cognitive-status` shows adapter readiness and outcome counts.

Evaluation workflow (bars pre-registered in `exp-typesafe-jev-turn-intent-v5`; field gates count only records made under the current judgment version, `typesafe-turn-judgment-v4`):

```text
node scripts/typesafe-gold.js status
node scripts/typesafe-gold.js show [--status pending] [--offset N] [--limit N]
node scripts/typesafe-gold.js approve <id>... [modality=<m|none>] [note=<text>]
node scripts/typesafe-gold.js reject <id>...
node scripts/typesafe-gold.js label <id>... <assignments>
node scripts/typesafe-gold.js evaluate --record [--reviewer <who>]   # refused until every row is reviewed
node scripts/report-typesafe-field.js [--record field-shadow|field-on]
```

## Autonomous goals

Project-local source:

```text
.pi/extensions/goal/index.ts
.pi/extensions/goal/goal-runner.js
.pi/extensions/goal/goal-store.js
```

The goal extension uses Hermes as a strict-JSON goal controller. Each iteration requests goal-decision schema v3 and validates one allowlisted typed action. Every executable action must contain a complete Hermes-authored prompt, which the harness sends to Pi verbatim rather than replacing it with a generic prompt. The runner records the action kind, Hermes prompt source, dispatch mode, result, and latency, then continues until the goal is completed, blocked, failed, cancelled, or reaches the max iteration limit. Unknown or malformed actions, missing prompts, excess fields, goal-input reference mismatches, and unauthorized mutation-capable topologies fail closed. Completion is proof-carrying: every evidence ID must be registered, untampered, passing, and created no earlier than the goal.

Persistent state defaults to:

```text
.pi/goal-state/<repo-name>.json
```

Commands:

```text
/goal <task> [--max=50] [--allow-topology=<id>]
                           Start a goal; explicitly approve a named mutation-capable topology
/goal-status                Show active/recent goal status
/goal-stop                  Cancel the active goal
/goal-resume                Resume the most recent unfinished goal
/goal-log [count] [--compact|--json]
                           Show recent loop history
/goal-doctor                Show Hermes/store/trace diagnostics
/goal-metrics               Show aggregate goal counts/iterations/blocked reasons
/goal-plan <task>           Preview Hermes' first decision without execution
/goal-export [json|md] [file]
                           Export active/recent goal
/goal-trace                 Show recent in-memory trace events for the goal
/goal-prune [--keep=20]     Archive older final goals
/goal-archive [status] [--older-than=7d]
                           Archive final goals, optionally filtered
/goal-clear [--all]         Archive+clear final goals, or all goals with --all
```

Operational notes:

- Default max iterations: 50.
- Hermes goal-controller decisions use the independent `PI_HERMES_CONTROLLER_TIMEOUT_MS` budget (default 30 seconds, maximum 60 seconds). Only iteration 1 receives one timeout retry, so raising this budget does not add attempts or change later-iteration failure behavior.
- Use `/goal-stop` before switching sessions if a long run is active; session shutdown also requests cancellation defensively. Cancellation takes effect at iteration/current-turn boundaries, so an already-running Pi turn may finish first.
- Raw final goal-summary sync and durable Hermes goal conversations are removed. Execution outcome packets are the canonical privacy-safe handoff.
- Goal decisions always use exact schema-v3 fields and one action from `run_topology`, `run_verifier`, `inspect`, or `ask_user`. Executable actions require a complete `prompt` authored by Hermes; `ask_user` carries Hermes' bounded `question` instead. For topology and verifier actions, `inputRef` must exactly equal the packet `goalId`; a mismatch enters the bounded advisory repair path before dispatch.
- Nonempty Evidence Binder IDs are always required for completion. The adapter verifies registration/packet fingerprint equality, `createdAt >= goal.createdAt`, and `ok=true` without returning evidence bodies.
- Typed actions remain prompt-dispatched in this Pi version; no direct tool invocation is assumed. The harness executes the validated Hermes prompt verbatim and never synthesizes a generic executable prompt. History records action kind, prompt source, dispatch mode, result code, latency, and proof rejection reason.
- `run_topology` accepts built-in allowlisted IDs plus the current goal-state `inputRef`. Topologies with `proposed-patch` roles require current-user `--allow-topology=<id>` approval; the approval is stored as a bounded ID, not inferred from model text.
- `/goal-plan` displays the typed action and authority without executing it. `ask_user` blocks with the bounded question.
- Stored observations/history are private local state, best-effort redacted, and truncated.
- Goal events are emitted to the trace runtime when available. Set `PI_GOAL_TRACE_ENABLED=0` to disable goal trace emission. `/goal-trace [correlation_id]` queries persisted goal trace events as well as in-memory events.
- Running goals auto-resume after agent turns by default, capturing queued typed-action output before asking Hermes for the next decision. Set `PI_GOAL_AUTO_RESUME=0` to require manual `/goal-resume` again.
- Conservative safety policy blocks risky autonomous prompts (`rm -rf`, `sudo`, package installs, download pipes, recursive chmod/chown, write-like actions outside repo). Set `PI_GOAL_ALLOW_UNSAFE=1` only for explicitly trusted runs.
- Hermes receives a bounded public goal packet containing goal intent, iteration, approved topology IDs, action result codes, and evidence IDs. It never receives observations, transcripts, raw action output, or provider output.
- Optional deterministic TUI regression: `scripts/check-goal-tui.sh ~/test-repo`. It uses `PI_GOAL_CONTROLLER_FIXTURE` and `PI_GOAL_EXECUTION_FIXTURE_RESULT` to avoid live Hermes/model dependence.
- The goal extension is included in the global harness settings via the `.pi/extensions` directory. When Pi is launched from this repo, Pi deduplicates the identical absolute project-local path, avoiding duplicate command registration.

## Session hygiene and raw-history retention

The Pi fork now creates default/custom session directories as `0700` and session files as `0600` across create, rewrite, resume, migration, branch, import, and fork paths, while refusing symlink/type swaps. Runtime Doctor keeps active-session hardening on `session_start` as a compatibility fallback for machines not yet running that source fix. Subagent records, results, events, RPC session directories, retained-workspace metadata/patches, and topology-run storage use the same private modes.

Historical permission migration is bounded and one-time: preview first, exclude the active session file, revalidate path type and identity at apply time, then write a private `~/.pi/agent/session-permissions-v1.json` completion marker only after an untruncated error-free explicit apply:

```text
/doctor-sessions-preview [--archive] [--include-one-shot --project=current] [--older-than=7d]
/doctor-sessions-apply --yes [--archive] [--include-one-shot --project=current] [--older-than=7d]
node scripts/session-hygiene.js --dry-run
node scripts/session-hygiene.js --apply [--archive] [--include-one-shot --project PATH] [--older-than=7d]
```

Permission scans bound matching files, visited directory entries, and bytes parsed per file (`--max-files`, `--max-entries`, and `--max-scan-bytes`). Truncated plans cannot be applied or marked complete. Applying permissions does not move files. Ordinary sessions are never automatically archived or deleted. Temporary-session archive selection runs only with `--archive`; one-shot selection additionally requires explicit opt-in and project scope. Archive moves require explicit apply/`--yes`, changed-since-preview candidates are refused, and files move to `~/.pi/agent/session-archive/<batch>/` with a private hash/provenance manifest. Nothing is deleted.

Runtime cleanup separately inventories role records/results, child RPC sessions, retained workspaces, patches, topology runs, and bounded structural trace-privacy metadata by size, age, and mode. `/doctor-cleanup-preview` produces a metadata-only manifest. Trace inspection samples bounded head/tail segments and reports only counts for `payload`/`payload_ref`, malformed rows, bytes, age, and active/rotated state. Payload-bearing or inconclusive traces receive `review-retention` preview items and are never deleted, truncated, archived, or rewritten by ordinary cleanup apply. Explicit apply may remove old final successful non-trace state and fully observed metadata-only trace state, but retains active runs, failed/timed-out/cancelled recovery evidence, unapplied patches, anything referenced by an open debug ledger, and all payload-bearing/unknown traces. It never manages ordinary Pi sessions.

All automated print/RPC/TUI smoke probes use `--no-session`, preventing disposable checks from polluting `~/.pi/agent/sessions/`. See [Role runtime benchmark and rollout](role-runtime-benchmark.md) for promotion and rollback controls.

## Privacy and state clearing

Persisted state locations:

```text
.pi/cognitive-automation/
.pi/subagents/                     # private records/results, child RPC sessions, retained workspaces, patch previews
.pi/role-runtime/audits/            # bounded transcript-free role audit reports
.pi/roadmap/
.pi/traces/
.pi/obsidian/                      # adapter state only; Obsidian vault is user-configured
.pi/hermes-advisory/               # metadata-only receipts and scorecard
.pi/hermes-skill-candidates/       # private quarantine; not an Agent Skill discovery root
.pi/typesafe/                      # private TypeSafe gold set (field records: ~/.pi/agent/typesafe/)
~/.pi/agent/sessions/               # authoritative raw Pi episodic history; private, not canonical memory
~/.pi/agent/session-archive/        # optional preview/apply retention archive
```

To minimize persisted payloads:

```text
PI_TRACE_CAPTURE_PAYLOADS=0
PI_COGNITIVE_AUTOMATION=0
PI_PROMPT_SUGGESTIONS_REFINE=off
PI_HERMES_SKILL_AUTO_DRAFT=0
```

To clear local project cognitive state:

```bash
scripts/clean-runtime-state.sh --yes
node scripts/clean-stale-reasoning-state.js
```

To clear local trace files:

```bash
rm -rf .pi/traces
```

Hermes advisory receipts and quarantined drafts are project-local and covered by `scripts/clean-runtime-state.sh --yes`. Diagnostics and memory/performance explorers are repo-local by default; `--global` applies only to unrelated global trace/session state.

Do not persist secrets, full transcripts, credentials, tokens, private keys, or sensitive local paths in durable memory notes.
