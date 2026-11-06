# Pi project-memory and extension harness

This repo includes a privacy-bounded project-memory architecture: Pi sessions remain episodic evidence, Obsidian project notes are canonical durable memory, local compiled caches serve task-conditioned recall, and Hermes is an off-path advisory curator.

Version-controlled Hermes advisory extension source:

```text
extensions/hermes-advisory/index.ts
```

Always-on global extension settings:

```text
~/.pi/agent/settings.json extensions = [
  "~/GatPi-Harness/extensions/00-harness-defaults/index.ts",
  "~/GatPi-Harness/.pi/extensions",
  "~/GatPi-Harness/extensions",
  "-builtin:codemode",
  ...unmanaged existing extensions
]
```

`-builtin:codemode` disables Pi's built-in CodeMode so only `extensions/codemode` (the governed policy facade over the same native tool) registers `codemode`; without it Pi warns about the replacement on every start.

Multiple logins and account failover (`extensions/multi-login`):

- `config/multi-login.json` is the default; `~/.pi/agent/multi-login.json` replaces it when present. Entries use their provider's own login: for example, Codex models use the `openai-codex` login, not the separate `openai` provider. `config/multi-login.json` ships an example `accounts` and `priority`; replace them with your own logins and model order.
- `accounts` sets logins per built-in provider. Login 1 is the provider itself; logins 2..N are `<provider>-account-N` (sign in with `/login anthropic-account-2`).
- Anthropic OAuth requests on the base provider and every alias apply a billing marker, prompt normalization, and tool-message ordering repair (`src/anthropic-oauth.js`). Both streaming APIs keep Pi's native login/refresh, authentication headers, and transport; API-key requests are unchanged. Offline regression tests cover the payload and OAuth handshake; live provider acceptance is not established by those tests.
- `priority` lists models in failover order. Choose any model as usual; when its account explicitly reports exhausted usage/quota or an authentication failure, that account cools down for `cooldownMinutes` (shared across sessions in `~/.pi/agent/multi-login-state.json`), the session switches to the next usable entry below it (each model on login 1, then logins 2..N), and the turn is retried. A model outside the list falls back to the top; the list never wraps upward. Thinking level carries over, clamped to the new model. A 429 only triggers failover when its message says usage is exhausted (for example, "You're out of extra usage"); generic rate limits/"try again later" errors do not switch models or create/extend a cooldown. Pi's normal retry behavior is unchanged. Cooldowns are local timers, not provider quota resets or remaining-usage telemetry.
- Model selections (including the account alias and automatic failover) are remembered per absolute working directory in `~/.pi/agent/multi-login-models/` (`PI_CODING_AGENT_DIR` overrides the agent directory). Fresh sessions and `/new` restore that directory's last selection; the first visit remembers Pi's current model. `/model` and model cycling update it. Explicit CLI model/provider/scope flags, resumed/forked sessions, and `/reload` keep their own model without replacing the saved choice. Unavailable saved models leave Pi's current model and the saved choice intact. Records contain only provider/model IDs, keyed by a directory hash; project files and global defaults are unchanged.
- `/multi-login` shows the order and status; `/multi-login reset` clears cooldowns, not remembered models.

Private Hermes advisory receipts and scorecards:

```text
.pi/hermes-advisory/events.jsonl
.pi/hermes-advisory/scorecard.json
.pi/hermes-skill-candidates/<candidate-id>/
```

Hermes uses independent one-shot advisory requests. It has no durable project conversation, recall cache, or canonical-memory namespace.

## Operational contract

Pi remains the fast coding harness. Canonical project memory lives under `Memory/Projects/<repo>-<root-hash>/` in the managed Obsidian vault. Hermes is a typed, off-path advisor only. Automatic runtime state is repo-local by default; every project identity uses the canonical root hash. Durable notes may contain only reviewed bounded summaries such as:

- decisions
- TODOs/risks
- test/build outcomes
- touched files/modules
- constraints/preferences

Provider packets must not contain transcript arrays or full history, private reasoning, unredacted tool output, secrets, command arguments, or absolute paths. Prompt refinement may include only a scanner-redacted, text-only excerpt of the eight most recent public messages plus bounded public skill telemetry; local task recall remains provider-free and bounded. Hermes can draft plans, reviews, evidence summaries, unverified project-memory candidates, and quarantined Agent Skills; it cannot approve, install, publish, promote canonical memory, or mutate automatically.

See `docs/project-memory-operations.md` for explicit save, recall, privacy review, retention, rollback, and rollout procedures.

`config/harness-defaults.env` is the canonical non-secret environment policy. The first extension applies only missing values, so explicit launch/session environment values remain authoritative. Managed builds, tests, detached jobs, and RPC sidecars have no shared job-count admission limit; each owned process group retains a 6144 MiB RSS ceiling with `SIGTERM` followed by bounded group-only `SIGKILL`. Active context is proactively compacted at 80% usage or 8 MiB of structured context through Pi's append-only compaction API. Existing session JSONL files are never deleted or truncated. See `docs/runtime-configuration.md` for `PI_MANAGED_PROCESS_*` and `PI_COMPACTION_PROACTIVE_*` overrides. `scripts/install-project-extensions.sh` installs the pinned request-queue client, the ordered extension paths, and bounded compaction/retry defaults, applied only where the settings file has no value so existing user preferences (including `retry.enabled`) are preserved; it does not change provider, model, theme, or unrelated packages or extensions.

After editing configured extension source, reload Pi with `/reload`. After editing `config/harness-defaults.env`, start a new Pi process because already-populated process environment values remain authoritative.

## Roles v2 topology defaults and evidence

Typed roles use validated contracts, RPC sidecars, isolated proposed-patch mutation, and transcript-free parent-session provenance. The canonical environment enables explicit manual topology/task tools with `PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1` and `PI_SPECIALIST_TASKS_ENABLED=1`, while automatic routing stays `PI_TOPOLOGY_AUTO_ROUTE=off`. Specialist tasks inherit the parent model/effort unless a per-role `PI_ROLE_MODEL_<ROLE_ID>`/`PI_ROLE_THINKING_<ROLE_ID>` override is configured, with no task/run budgets or correction cap. Optional project policy configures executable checkers; missing policy supplies dossier verification. Artifact-linked human feedback is non-blocking, and no extra UI confirmation is required. See [normal-session specialist use](docs/specialist-tasks.md#normal-session-use). Child routing remains disabled to prevent recursion, and isolated role patches never reach the parent tree automatically. Independent evidence-selected promotion remains gated by the deterministic fixture benchmark:

```bash
node tests/role-runtime-benchmark.test.js
node scripts/benchmark-role-runtime.js --fixture-only
```

Runtime selection and rollback use `PI_ROLE_RUNTIME_VERSION`, `PI_ROLE_MUTATION`, `PI_MULTI_AGENT_TOPOLOGIES_ENABLED`, `PI_TOPOLOGY_AUTO_ROUTE`, `PI_ROLE_SIDECAR`, and `PI_ROLE_ROLLOUT_STAGE`. Role v2 contracts and profiles remain configured at explicitly selected R5 with isolated mutation for reviewed operator use, with manual topology execution available in new sessions and the auto-router inactive. Separately opting into `delegate` mode automatically executes matched topologies, waits for settlement, and injects their typed results into the parent turn. Mutating roles return isolated proposed patches, and applying one to the parent remains an explicit hash/conflict/verification-checked action. Automatic evidence-based promotion remains capped at R4 when no stage is configured; the explicit configured stage is reported separately from evidence eligibility. Set `PI_MULTI_AGENT_TOPOLOGIES_ENABLED=0`, `PI_TOPOLOGY_AUTO_ROUTE=off`, `PI_ROLE_ROLLOUT_STAGE=R0`, `PI_ROLE_MUTATION=off`, or `PI_ROLE_RUNTIME_VERSION=1` for immediate state-preserving rollback. `/doctor-role-runtime` reports stage authority, evidence eligibility, mutation mode, router mode, and legacy/current state split. See [Role runtime benchmark and rollout](docs/role-runtime-benchmark.md), [Phase 7 release scorecard](docs/phase7-release-scorecard.md), [Subagents](docs/subagents.md), and [Topology cookbook](docs/topology-cookbook.md).

Session/role state is private by default. Historical Pi session permissions are migrated only through a bounded dry-run-first explicit apply; ordinary sessions are never automatically archived or deleted. Role cleanup is manifest-first and preserves active/failure/recovery/debug-referenced evidence.

## Commands

Hermes advisory commands:

```text
/hermes-status                  Separate provider readiness from advisory/mutation authority
/hermes-doctor [--curation]     Run bounded current authentication/curation probes
/hermes-plan <public task>      Request a typed read-only plan
/hermes-review <evidence refs>  Request a typed evidence review
/hermes-evidence <refs>         Summarize bounded evidence references
/hermes-feedback <receipt> accept|reject
/hermes-scorecard [--write]     Preview or persist the qualified field scorecard
```

The `hermes_advisory` tool is current-user-intent-gated and read-only. Automatic routing, canonical promotion, and automatic skill drafting remain disabled until the documented field bars pass.

Autonomous goal commands, provided by `.pi/extensions/goal/`:

```text
/goal <task> [--max=50] Start a Hermes-controlled autonomous goal loop
/goal-status            Show active/recent goal state and observations
/goal-stop              Cancel the active goal
/goal-resume            Resume the most recent unfinished goal
/goal-log [count] [--compact|--json]
                       Show recent loop history
/goal-doctor            Show Hermes/store/trace diagnostics
/goal-metrics           Show aggregate goal counts/iterations/blocked reasons
/goal-plan <task>       Preview Hermes' first decision without execution
/goal-export [json|md] [file]
                       Export active/recent goal
/goal-trace             Show recent in-memory trace events for the goal
/goal-prune [--keep=20] Archive older final goals
/goal-archive [status] [--older-than=7d]
                       Archive final goals, optionally filtered
/goal-clear [--all]     Archive+clear final goals, or all goals with --all
```

Goal state persists under `.pi/goal-state/`. The goal runner requires Hermes, asks for strict JSON decisions each loop, and executes each validated Hermes-authored action prompt verbatim through Pi; it never substitutes a generic executable prompt. It records redacted observations/history, blocks on malformed controller output, and refuses completion claims until a previous harness-executed step produced objective evidence such as tests, builds, linting, file inspection, command output, or explicit task evidence. Goal events are also emitted to the trace runtime when available, and `/goal-trace` can query persisted goal trace events by goal/correlation. A conservative safety policy blocks risky autonomous prompts such as `rm -rf`, `sudo`, package installs, download pipes, recursive chmod/chown, and write-like actions outside the repo unless `PI_GOAL_ALLOW_UNSAFE=1` is set. Running goals auto-resume after agent turns by default so queued action output can be captured without repeated `/goal-resume`; set `PI_GOAL_AUTO_RESUME=0` to restore manual resume-only behavior. `/goal-stop` requests cancellation; an already-running Pi turn may finish before the goal stops. The optional TUI regression script uses `PI_GOAL_CONTROLLER_FIXTURE` and `PI_GOAL_EXECUTION_FIXTURE_RESULT` for deterministic validation. The extension is included in the always-on harness extension settings; identical project-local paths are deduplicated when running inside this repo.

Roadmap commands, provided by `.pi/extensions/roadmap/`:

```text
/roadmap                         Show the active visual checklist
/roadmap-panel                   Open the scrollable roadmap overlay
/roadmap-start <title> [:: a | b] Start a root roadmap, or safely nest under active work
/roadmap-subtask <title> [:: a | b]
                                  Explicitly nest a roadmap under an item
/roadmap-replace <title> [:: a | b]
                                  Explicitly discard and replace the root roadmap
/roadmap-add <step>              Add an item to the deepest active roadmap
/roadmap-active <item>           Mark an item active (supports paths such as 2.1.3)
/roadmap-adopt <roadmap-id>      Continue an earlier roadmap from this directory
/roadmap-done <item> [<item>...] [--cascade]
                                  Mark items done and advance
/roadmap-verify <item> [evidence] Mark an item verified with evidence
/roadmap-block <item> <reason>   Mark an item blocked
/roadmap-link <item> <artifact>  Link reasoning/evidence ids
/roadmap-import-reasoning        Seed from latest reasoning plan/decomposition
/roadmap-export                  Show state path and summary
/roadmap-clear                   Clear active roadmap state
```

Model tool: `roadmap_update`. Roadmap state persists under `.pi/roadmap/sessions/<session-id>/active.json` beneath the Git worktree (or project) root, so concurrent sessions in one directory keep independent roadmaps while unscoped writers keep the directory-level `.pi/roadmap/active.json`. When a session has no roadmap, `show` lists the roadmaps in that directory and `action=adopt roadmapId=<id>` continues one without touching the owning session's packet. `set_status` accepts `itemIds` and `cascade=true` so a finished milestone and its nested goals settle in one call. State uses the recursive v3 schema and renders a compact checklist widget plus footer status for long-running plans. Each item can own any number of nested subtask roadmaps, recursively. Starting or importing work while a roadmap is active nests it under the active leaf instead of overwriting the parent; `replace`/`/roadmap-replace` is the explicit destructive alternative. Nested items are addressable by numeric paths such as `2.1.3`, and completing a nested roadmap resumes its parent item. Once every item is done/verified, the completed checklist clears automatically only when the user sends the next non-command message (interactive or RPC), not when an extension injects a follow-up. Items can link to public reasoning artifacts and verifier evidence ids without storing private reasoning.

CodeGraph commands, provided by `.pi/extensions/codegraph/`:

```text
/codegraph-status [path]      Show CodeGraph index health/statistics
/codegraph-sync [--full] [path]
                              Sync changes or run a full index
/codegraph-query [--kind k] [--limit n] <search>
                              Search indexed symbols/nodes
/codegraph-context [--max-files n] <task>
                              Build task-focused graph context
/codegraph-affected [files...]
                              Find tests affected by source changes
/codegraph-files [--path path]
                              Show indexed project file structure
/codegraph-doctor [path]
                              Diagnose binary/index/freshness/env state
```

Model tools are also registered as `codegraph_status`, `codegraph_query`, `codegraph_context`, `codegraph_affected`, `codegraph_sync`, `codegraph_files`, and `codegraph_doctor`. The adapter shells out to the local `codegraph` CLI, truncates large output, defaults to the current Pi working directory, and blocks explicit project paths outside the current cwd unless `PI_CODEGRAPH_ALLOW_OUTSIDE=1` is set. Shared behavior lives in `src/codegraph-adapter.js`; other harness workflows consume CodeGraph only as optional advisory context for project indexing, affected-test selection, verification planning, semantic patch impact, workflow guidance, and runtime diagnostics. If the CLI is missing or the target repo has not been initialized/indexed, tools fail with friendly guidance instead of raw `ENOENT` or uninitialized-index output.

Semgrep commands, provided by `.pi/extensions/semgrep/`:

```text
/semgrep-status [path]      Show Semgrep availability/version/config
/semgrep-scan [--config c] [--severity s] [files...]
                            Run a focused or project-wide Semgrep scan
/semgrep-changed [files...] Scan changed files and add CodeGraph test hints
/semgrep-codegraph [files...] Combine Semgrep findings with CodeGraph affected tests
/semgrep-doctor [path]      Diagnose binary/Docker-wrapper/config/env state
```

Model tools are also registered as `semgrep_status`, `semgrep_scan`, `semgrep_codegraph`, and `semgrep_doctor`. Shared behavior lives in `src/semgrep-adapter.js`; Semgrep remains optional like CodeGraph, supports a normal local binary or Docker wrapper, disables Semgrep metrics by default, truncates large output, and reports binary/config/scan readiness separately. `p/default` is the registry default (upstream contents are not pinned); `auto` is rejected before launch while metrics are off, unavailable packs are negative-cached after bounded validation, and `semgrep_codegraph` still returns CodeGraph affected-test guidance when Semgrep is degraded.

Obsidian commands, provided by `.pi/extensions/obsidian/`:

```text
/obsidian-status [vault]          Show local layered vault/desktop/Hermes readiness
/obsidian-doctor [--probe-auth] [--probe-curation] [vault]
                                  Run local diagnostics or bounded active/dry-run probes
/obsidian-search <query>          Search local Markdown notes in the managed vault
/obsidian-note <title> :: <body>  Write a concise durable note to Obsidian
/obsidian-import [--apply] [paths...]
                                  Preview/apply research/docs import into the vault
/obsidian-hermes <topic>          Draft unverified candidates from safe vault extracts
/obsidian-hermes-review <receipt> <accept|reject|correct>
                                  Record governed review evidence; never promote memory
/obsidian-open [note.md]          Open Obsidian to the managed vault or note
```

Model tools are registered as `obsidian_status`, `obsidian_search`, `obsidian_note`, `obsidian_import`, `obsidian_hermes`, and `obsidian_doctor`. Shared behavior lives in `src/obsidian-adapter.js`; Obsidian remains optional like CodeGraph/Semgrep. Readiness is reported separately for the vault filesystem, desktop executable/open state, Hermes executable, authentication, provider/model, local Markdown operations, and curation. The automatic status probe is local-only; active auth and dry-run curation probes are explicit, bounded, and metadata-only. A missing desktop does not block filesystem-backed search/note/import.

General coding workflow tools, provided by `.pi/extensions/code-context/`, `.pi/extensions/lsp/`, `.pi/extensions/test-runner/`, `.pi/extensions/ast-tools/`, and `.pi/extensions/docs-lookup/`:

```text
model tool: code_context                       Retrieve ranked repo maps/search/symbol cards
/lsp-diagnostics [--file f] [files...]        Run compiler/LSP-style diagnostics
/test-runner-run [--profile changed] [files...] Run inferred tests with structured evidence
/ast-search [--kind call|function|class] <pattern>
/ast-refactor-preview|apply ...               Preview/apply checkpointed lexical replacements
/docs-lookup [--package pkg] <query>          Search local and installed package docs
```

Model tools are registered as `code_context`, `lsp`, `test_runner`, `ast_search`, `ast_refactor`, and `docs_lookup`. `code_context` is the preferred read-oriented facade for progressive localization: start with `repoMap`/`search`, inspect symbol cards, and request `symbolGet detail=body` only after localization. Existing provider tools remain available for diagnostics. Retrieval is explicit and advisory by default; stale/degraded cards are never gating-safe and no source map is injected automatically. Promoted `select-tests`/`on` modes require a saved benchmark report and only augment baseline verification. Optional scale-out providers remain blocked unless `node scripts/probe-code-context-scale-gates.js` records actual local pressure for an isolated pilot. `test_runner` reports empty inference/no-prior-failures as `not-applicable`, not pass or fail. `docs_lookup` remains cwd-confined; read Pi framework docs directly from `$PI_SOURCE_ROOT/packages/coding-agent/` (or the default sibling `../pi`) instead of weakening confinement. `ast_*` is regex-backed, not parser/scope-aware. Risk-sensitive Semgrep checks now run inside `gitverify` and Verification Center; Node coverage ingestion is opt-in. See [`docs/code-analysis-workflow.md`](docs/code-analysis-workflow.md) for routing, limitations, outcome reviews and recommended LSP installations, and [`docs/code-context-benchmark.md`](docs/code-context-benchmark.md) for benchmark boundaries.

Context-overflow recovery is provided by `.pi/extensions/context-overflow-recovery/`:

```text
/compact-rescue [focus]            Force SSE compaction with a bounded local fallback
/compaction-recovery-status        Show recovery configuration and in-process counters
```

Overflow and threshold-pressure compactions use the recovery path automatically. A summarization WebSocket or input-limit failure falls back to a local extractive summary and writes a real compaction entry instead of leaving the chat permanently over its context window. Pi's overflow retry then continues the interrupted turn; over-limit manual `/compact` and `/compact-rescue` schedule continuation automatically after compaction reconnects. If an assistant instead stops at its maximum output-token limit, the extension continues at `agent_settled` after compaction and queued work finish, bounded to three consecutive injections and suppressed when another extension already owns continuation. Manual compaction below pressure keeps Pi's default behavior. See [`docs/context-overflow-recovery.md`](docs/context-overflow-recovery.md).

Ralph-style bounded task automation is provided by `.pi/extensions/automation-loop/`:

```text
/loop <task> [--max=N] [--promise=TEXT] [--max-stalls=N]
/loop --prompt-file=TASK.md
/loop-status  /loop-log  /loop-pause  /loop-resume  /loop-stop
```

The `automation_loop` model tool starts or controls the same-prompt loop and records PASS/FAIL/NULL checkpoints. Model-tool starts require explicit current-user loop/autonomy intent. Safety rejections are structured `blocked` outcomes, while controls with no current loop are `not-applicable`; neither is a transport/runtime failure. Iterations advance only at Pi's post-retry `agent_settled` boundary; terminal provider failures pause without consuming budget. Before starting the next iteration it automatically waits for `bg_run`/`run_deck` work launched during the current iteration, while unrelated pre-existing runs do not block it. Token-bound continuation prompts are dropped if delayed, stale, cross-session, or inactive. It pauses for repeated no-progress output, unmanaged waits, or human/resource decisions, and completes only through an exact final-response `<promise>…</promise>` or, when no promise is configured, evidence-backed tool completion. Private fixed-field lifecycle telemetry excludes prompts, summaries, and evidence text. See `docs/automation-loop.md`.

Periodic long-run observation is provided separately by `extensions/run-monitor/`:

```text
/monitor-start <bg_run|run_deck> <target-id> [interval-seconds] [timeout-seconds] [:: pattern]
/monitor-status [monitor-id]  /monitor-check <monitor-id>  /monitor-stop <monitor-id>  /monitors
```

The `run_monitor` model tool periodically samples an existing `bg_run` or `run_deck` target while the owning Pi session is alive. It never stops the target; it notifies only when optional literal milestone text appears, the process settles, the observation deadline expires, or checking fails. Terminal edges run `scripts/run-monitor-check.js`, which probes the target and records the result without sending a user message or starting a model turn. Use it instead of `automation_loop` merely to babysit one process. See `docs/run-monitor.md`.

Git evidence commands, provided by `extensions/git-evidence-courier/`:

```text
/git:evidence               Show git status/diff evidence, remote SHA, and verifier hints
/git:verify [cmd && cmd]    Run explicit or inferred verification with clean-tree evidence
/git:publish [--verify] [remote] [branch]
                            Push after clean-tree/ancestor checks, user confirmation,
                            and remote-SHA-matches-local-HEAD confirmation
```

Model tools are registered as `gitevidence` (read-only evidence) and `gitverify` (inferred verification only; no arbitrary shell commands). For Prisma/PostgreSQL repositories, inferred verification automatically provisions a disposable loopback-only PostgreSQL container, injects isolated Prisma/test database URLs, and verifies ownership before cleanup without invoking repository Compose services. There is intentionally no model-callable publish tool: `/git:publish` refuses dirty trees and detached HEAD, never force pushes, and requires interactive user confirmation. See `docs/productization-extensions.md` for details.

## Environment knobs

```text
PI_HERMES_ADVISORY=1             Enable explicit typed Hermes advisory surfaces
PI_HERMES_BIN=hermes             Override Hermes executable
PI_HERMES_PROVIDER=<optional>    Explicit provider override
PI_HERMES_MODEL=<optional>       Explicit model override
PI_HERMES_PROMPT_TIMEOUT_MS=10000
PI_HERMES_CONTROLLER_TIMEOUT_MS=30000
PI_HERMES_AUTH_PROBE_TIMEOUT_MS=30000
PI_HERMES_CURATION_PROBE_TIMEOUT_MS=60000
PI_HERMES_CURATION_TIMEOUT_MS=120000
PI_HERMES_SKILL_AUTO_DRAFT=0     Automatic drafting stays field-gated and off
PI_PROMPT_SUGGESTIONS_REFINE=auto Evidence-gated automatic model refinement (use 1 to force on)
PI_PROMPT_SUGGESTIONS_MODEL=<provider/modelId> Process override for the machine-wide suggestion model
PI_CODEGRAPH=0                    Disable CodeGraph extension
PI_CODEGRAPH_BIN=codegraph         Override codegraph executable
PI_CODEGRAPH_TIMEOUT_MS=120000     Default CLI timeout
PI_CODEGRAPH_ALLOW_OUTSIDE=1       Permit explicit project paths outside cwd
PI_CODEGRAPH_MAX_LINES=2000        Output truncation line cap
PI_CODEGRAPH_MAX_BYTES=51200       Output truncation byte cap
PI_CODEGRAPH_AUTO_SYNC=1           Opt into debounced background sync after edits
PI_CODEGRAPH_AUTO_SYNC_DEBOUNCE_MS=1500 Auto-sync debounce window
PI_CODEGRAPH_ADVISORY=0            Disable advisory enrichment in other workflows
PI_CODEGRAPH_ADVISORY_TIMEOUT_MS=1500 Advisory probe timeout
PI_SEMGREP=0                       Disable Semgrep extension
PI_SEMGREP_BIN=semgrep             Override semgrep executable or Docker wrapper
PI_SEMGREP_CONFIG=p/default        Reproducible default scan config (`auto` conflicts with metrics=off)
PI_SEMGREP_TIMEOUT_MS=120000       Default CLI timeout
PI_SEMGREP_ALLOW_OUTSIDE=1         Permit explicit project paths outside cwd
PI_SEMGREP_MAX_LINES=2000          Output truncation line cap
PI_SEMGREP_MAX_BYTES=51200         Output truncation byte cap
PI_SEMGREP_ADVISORY=0              Disable advisory Semgrep enrichment
PI_SEMGREP_ADVISORY_TIMEOUT_MS=8000 Advisory scan/status timeout
PI_SEMGREP_VERIFY_TIMEOUT_MS=8000  Verification-center advisory timeout
PI_SEMGREP_PATCH_TIMEOUT_MS=8000   Semantic-patch advisory timeout
PI_SEMGREP_METRICS=off             Disable Semgrep metrics by default
PI_SEMGREP_CONFIG_PROBE_TIMEOUT_MS=30000  Bound config validation before scan readiness
PI_OBSIDIAN=0                       Disable Obsidian extension
PI_OBSIDIAN_BIN=obsidian            Override Obsidian executable
PI_OBSIDIAN_VAULT="~/Obsidian/Pi Research" Managed vault path
PI_OBSIDIAN_RESEARCH_ROOTS=...      Comma-separated default import roots
PI_OBSIDIAN_ALLOW_OUTSIDE=1         Permit explicit paths outside cwd/home
PI_OBSIDIAN_AUTO_AWARE=0            Disable automatic model awareness prompt
PI_OBSIDIAN_AUTO_STATUS=0           Disable one-time automatic status probe
PI_ROADMAP=0                        Disable the roadmap checklist extension
PI_ROADMAP_WIDGET_ITEMS=6           Max roadmap items in compact widget
PI_AUTOMATION_LOOP=0                 Disable Ralph-style task loops
PI_AUTOMATION_LOOP_MAX_ITERATIONS=20 Default bounded iteration budget
PI_AUTOMATION_LOOP_MAX_STALLS=3      Pause after repeated identical no-progress turns
PI_AUTOMATION_LOOP_BACKGROUND_POLL_MS=2000 Poll managed work before continuing
PI_AUTOMATION_LOOP_ALLOW_UNBOUNDED=1 Permit explicit --max=0
PI_RUN_MONITOR=0                    Disable periodic long-run monitoring
PI_RUN_MONITOR_INTERVAL_MS=30000    Default monitor polling interval
PI_RUN_MONITOR_TIMEOUT_MS=86400000  Default observation deadline (24h)
PI_RUN_MONITOR_MAX_ACTIVE=8         Active monitors per Pi session
PI_RUN_MONITOR_INTENT_TELEMETRY=1   Metadata-only eligible/acted/terminal cohort
PI_OUTPUT_COMPACTOR_MODE=off|canary|all Selected oversized-result policy (default canary)
PI_OUTPUT_COMPACTOR_CANARY_TOOLS=evidence_binder,extension_ops,learning_loop,run_deck,run_topology,runtime_doctor,verification_center
PI_OUTPUT_COMPACTOR_MODEL_TOOL=0    Keep manual compatibility tool out of the model surface
PI_COMPACTION_RECOVERY_AUTO_CONTINUE_OUTPUT_LIMIT=0 Disable automatic output-limit continuation
PI_COMPACTION_RECOVERY_MAX_OUTPUT_LIMIT_CONTINUATIONS=3 Bound consecutive output-limit continuations
PI_CODE_CONTEXT_MODE=off|shadow|advisory|select-tests|on Progressive retrieval mode (default advisory)
PI_CODE_CONTEXT_RG_BIN=rg             Override the structured lexical search binary
PI_CODE_CONTEXT_SEARCH_LIMIT=15       Default compact search-card page size
PI_CODE_CONTEXT_BENCHMARK_REPORT=.pi/code-context/benchmarks/latest.json Promotion evidence report
PI_CODE_CONTEXT_TELEMETRY_SNIPPETS=0   Keep source snippets out of telemetry by default
PI_LSP=0                            Disable the LSP-style coding tool
PI_LSP_LIVE=0                       Disable lazy live language servers and retain compiler/fallback behavior
PI_TEST_RUNNER=0                    Disable test_runner
PI_TEST_RUNNER_ALLOW_CUSTOM=1       Allow custom command execution; inferred only by default
PI_AST_TOOLS=0                      Disable ast_search/ast_refactor
PI_DOCS_LOOKUP=0                    Disable docs_lookup
PI_PORTFOLIO_EXPERIMENTAL_TOOLS=1  Expose command-only experimental model tools (currently output_compactor)
PI_CODEMODE=0                       Opt out of default-on native hybrid CodeMode
PI_TOOL_SURFACE_ROUTER=0            Disable task/readiness-aware model tool selection
PI_TOOL_CHURN_GUARD=0               Disable repeated-call advisories
```

Canonical behavior is local-first and guarded: model prompt refinement and skill drafting are off, Hermes owns no recall or shutdown lifecycle, CodeGraph auto-sync is on but advisory, Semgrep automatic advisory scans are off, role mutation is off, role routing is suggest-only, the model tool surface is task/readiness-routed, repeated-call churn is advisory, and selected oversized structured outputs use the measured canary. See `config/harness-defaults.env` for the complete applied environment.

## Agent skill library

The Skill Foundry catalog now holds 129 skills under `skills/`, with invocable directories in `skills/skills/`: 121 supplied by the 2026-10-27 pack plus eight legacy skills restored and adapted to the pack standard because the pack does not cover their workflows: `handoff`, `git-checkpoint`, `change-verify`, `long-run`, `durable-bug-hunt`, `experiment-gate-lifecycle`, `build` and the third-party MIT `typesafe-ai`. See [`skills/CATALOG.md`](skills/CATALOG.md) for the catalog, [`skills/README.md`](skills/README.md) for authoring/evaluation tools, and [the migration record](docs/skill-bundle-migration.md) for legacy backups, the 2.0 adaptation and disclosed deviations. Validate the harness and refresh the local copies with the unified entry point:

```bash
scripts/pi-harness-refresh.sh --skills
```

The lower-level `scripts/install-agent-skills.sh` validates the exact catalog in `skills/skills/managed-skills.txt`, installs hash-identical copies, and records `.pi-harness-managed-skills` in each destination. Later runs prune only names recorded in that destination manifest and removed from the source catalog; unrelated user-owned skills are preserved. Use `--list` or `--dry-run` to inspect the reconciliation.

Awareness runs in both directions. Every generated `SKILL.md` carries a **Harness delegation** section listing the registered specialist/subagent roles rendered from `skills/specialists.json`, which is generated from `src/role-contracts.js` by `scripts/regenerate-specialist-roster.js`, plus the delegation tools and an inline fallback for harnesses without them. Every role-v2 contract carries a bounded skill roster built from `skills/catalog.json` by `src/skill-awareness.js`: children see every current skill and the ones governing their role, while skill discovery stays disabled, so the parent passes the relevant body when exact procedure matters. The roster reaches a child once, and an oversized roster degrades with an explicit truncation marker instead of failing extension load. Retired skills are absent from both surfaces and `tests/skill-awareness.test.js` fails if one reappears. See [Subagents](docs/subagents.md#skill-awareness).

## Skill synthesis substrate

A self-improving procedural skill synthesis layer is available at:

```text
src/skill-synthesis.js
```

It captures public execution traces/topology runs, scores outcomes, extracts reusable procedural skills, stores failure patterns, retrieves relevant skills for new tasks, injects advisory skill context, replays captures, compares skills, sandbox/A-B scores skill use, evaluates effectiveness, supports provider-registered curated skills, enforces approval/rollback governance, and can render topology templates from skills. It is exposed through `createPiIntegrationBoundary(...).skills` and `/skill-*` commands in the cognitive automation extension.

Docs, tests, and example:

```bash
node tests/skill-synthesis.test.js
node examples/skill-synthesis-example.js
```

See `docs/skill-synthesis.md` for the architecture, governance, commands, and lifecycle.

## Cognitive memory substrate

A true four-system cognitive memory substrate is available at:

```text
src/cognitive-memory.js
```

It implements independent episodic, semantic, procedural, and strategic memory systems with separate retrieval, decay, compaction, relevance ranking, consolidation, contradiction handling, cross-memory linking, intelligent forgetting, provenance/verification tracking, persistence, metrics, and retrieval/consolidation observability.

Docs, tests, and example:

```bash
node tests/cognitive-memory.test.js
node examples/cognitive-memory-example.js
```

See `docs/cognitive-memory-architecture.md` for the architecture and API.

## Operational docs

- `docs/phase7-release-scorecard.md`: version-frozen schema-v4 post-fix scorecard and historical **no-go-deferred** decision. The canonical environment explicitly selects R5 with manual topology execution enabled and auto-routing off; lower historical/evidence eligibility remains separate provenance, and the live schema-v4 portfolio and schema-v6 telemetry cohort are governed separately below.
- `docs/codemode.md`: default-on native CodeMode in hybrid `on` mode, explicit `PI_CODEMODE=0` opt-out, reviewed callable operations, typed results, limits, and paired evaluation.
- `docs/extension-portfolio/README.md`: versioned lifecycle registry for all 50 extensions, per-tool keep/command-only decisions, evidence sufficiency, canonical overlap guidance, and rollback controls. The consolidated fleet declares 64 parent tools before model-exposure policy and 63 after Output Compactor suppression; Tool Surface Router selects a smaller per-task subset.
- `docs/productization-extensions.md`: Verification Center, Visual Verification, the read-only Rollout Center, canonical semantic editing, Runtime Doctor, CodeGraph/Semgrep adapters, task-aware tool exposure, churn protection, exact-source telemetry/canaries, and operational glue extensions built on reusable local libraries.
- `docs/rollout-center.md`: unified technical/policy/field/rollback snapshots and provenance without another rollout authority.
- `docs/visual-verification.md`: configured TUI/image/Graphviz/external provider contracts, metadata-only evidence, and separately governed baseline updates.
- `docs/subagents.md`: branch-backed subagents, registered direct-role resolution, lifecycle, merge policies, command/tool API, private state, queue/execution diagnostics, and `PI_CHECK_TUI=1` TUI regression validation.
- `docs/multi-agent-topologies.md`: fail-closed Roles v2 registry and topology schema-v3 DAG execution, explicit joins/partial truth, evidence-only auditing, enforced context/memory/tool policies, subagent-backed production configs, persisted runs, traces/replay, and examples.
- `docs/topology-cookbook.md`: production recipes for parallel evidence synthesis and sequential planner/executor/reviewer work, verification/join gates, tool restrictions, memory curation, fallback topology, and run maintenance.
- `docs/adr-parallel-evidence-topology.md`: accepted compatibility, safety, privacy, partial-result, and rollout boundaries for the read-only fan-out/fan-in design.
- `docs/topology-field-notes.md`: live external-repo field notes from using Pi topologies in `~/dev/test-repo`, including friction found and fixes applied.
- `docs/workflow-pack.md`: Roadmap-backed end-to-end workflows for onboarding repos, risky edits, CI triage, latency optimization, memory curation, release prep, learning, and extension changes.
- `docs/operational-model.md`: Pi/Hermes/trace runtime contract, install/check workflow, recovery commands, and privacy boundaries.
- `docs/runtime-configuration.md`: environment variables, command reference, and state-clearing instructions.
- `docs/interactive-validation.md`: real TUI validation log for Hermes lifecycle and trace commands.

## Semantic layered context architecture

A structured cognitive context engine is available at:

```text
src/layered-context.js
```

It implements L0-L4 memory layers with independent TTL/retention policies, semantic decay, budget-aware context packing, protected architecture memory, compaction, integrity checks, metrics, and inclusion/removal observability.

Docs and runnable example:

```text
docs/layered-context-architecture.md
examples/layered-context-example.js
```

Run checks:

```bash
node tests/cognitive-memory.test.js
node tests/layered-context.test.js
node tests/semantic-editor.test.js
node tests/verification-pipeline.test.js
node tests/entropy-monitor.test.js
node tests/cognitive-architecture.test.js
node tests/session-branches.test.js
node examples/layered-context-example.js
node examples/cognitive-memory-example.js
node examples/verification-pipeline-example.js
node examples/entropy-monitor-example.js
node examples/session-branching-example.js
node scripts/benchmark-semantic-editor.js
node scripts/benchmark-verification-pipeline.js
node scripts/simulate-entropy-monitor.js
```

## Deterministic semantic editing

A semantic patching engine is available at:

```text
src/semantic-editor.js
```

It replaces stale line-number patching and naive search/replace with content hashes, semantic region identities, AST-like node identities, structural neighbourhood signatures, token/dependency anchoring, transactional rollback, optimistic concurrency checks, semantic diffing, dependency impact analysis, and integrity metrics.

Docs, tests, and benchmark/corruption simulation:

```bash
node tests/semantic-editor.test.js
node scripts/benchmark-semantic-editor.js
```

See `docs/semantic-editing.md` for migration and compatibility guidance.

## Model-side reasoning runtime

Reasoning belongs to the model. The harness provides cognitive runtime scaffolding at:

```text
src/reasoning-runtime.js
```

It records explicit plan artifacts, task decompositions, hypotheses, decision records, executor actions, verifier evidence, feedback loops, memory updates, branch comparisons, reflection checkpoints, and failure analyses. It separates private scratchpad references from public result artifacts and does not treat reflection as proof. Automatic context injection sends the full scaffold once, then only changed objective/evidence/constraint/warning sections; repeated objectives, successful proof history, and stable router guidance are deduplicated. Metadata telemetry records rendered/injected/saved character counts without context text.

Docs and tests:

```bash
node tests/reasoning-runtime.test.js
node tests/cognitive-architecture.test.js
```

See `docs/reasoning-runtime.md` for the runtime contract, artifact validation, cleanup workflow, debug/export/replay support, model-facing templates, and `/reasoning-*` command reference. See `docs/adr-reasoning-runtime.md` for the architecture decision record and `docs/reasoning-runtime-stabilization.md` for the 2026-05-19 stabilization checkpoint covering the runtime banner, self-test, TUI smoke, memory dedupe, and validation workflow. `src/cognitive-architecture.js` remains only as a compatibility facade for older imports.

## Verification-gated execution pipeline

A proof-producing execution pipeline is available at:

```text
src/verification-pipeline.js
```

It makes verification a mandatory execution primitive: patch application is followed by differential impact analysis, dependency-aware verifier graph scheduling, result caching, policy enforcement, proof evidence emission, rollback/retry, benchmark and coverage deltas, confidence metrics, and feedback hooks for planner/coder/memory agents.

Docs, test, example, and benchmark:

```bash
node tests/verification-pipeline.test.js
node examples/verification-pipeline-example.js
node scripts/benchmark-verification-pipeline.js
```

See `docs/verification-pipeline.md` for the architecture and API.

## Entropy monitoring and session stability

A full entropy-monitoring subsystem is available at:

```text
src/entropy-monitor.js
```

It tracks context growth, retry depth, contradiction frequency, patch instability/reversion, hallucinated tool calls, verifier failure density, semantic drift, branch divergence and token inefficiency. It continuously produces entropy, stability, coherence and confidence scores; detects conflicting assumptions/plans/architecture/objectives; recommends auto-stabilization actions; sanitizes context; persists long-term metrics; and renders ASCII/HTML diagnostics.

Docs, tests, examples and simulation:

```bash
node tests/entropy-monitor.test.js
node examples/entropy-monitor-example.js
node scripts/simulate-entropy-monitor.js
```

See `docs/entropy-monitoring.md` for the architecture and API.

## Session branching and trajectory management

A cognitive trajectory management subsystem is available at:

```text
src/session-branches.js
```

It supports branchable sessions, experimental/verification/rollback/speculative/multi-agent branch types, full cognitive snapshots (memory/context/tool/filesystem/verifier state), semantic three-way merges, conflict detection, invariant gates, scoring, automatic risky-operation isolation, pruning, rollback/quarantine/replay recovery, agent leases, and ASCII visualization.

Docs, test, and runnable example:

```bash
node tests/session-branches.test.js
node examples/session-branching-example.js
```

See `docs/session-branching.md` for the architecture and API.

## Pi request queue

Every DeepSeek (`local`) model request joins a shared Redis queue before it is
sent, so at most a configured number run at once across all machines; the rest
wait in FIFO order, and every request is recorded (metadata and token counts, no
prompts). There are no worker processes: each Pi waits for its own slot and sends
its own request. The auto-loaded `extensions/pi-queue/` wraps the provider and
adds `pi_queue_status`, `pi_queue_list` and `/queue-status`; `scripts/pi-queue`
shows status/history and sets the limit. The queue fails closed when unavailable;
set `PI_QUEUE=0` to call DeepSeek directly. See [Pi request queue](docs/pi-queue.md).

## Shared extension kit

Common extension helpers live in:

```text
src/pi-extension-kit.js
```

It provides `readJson`/`writeJson`, `short` truncation, `envEnabled`, `includeGlobal`, `execCapture`, and `registerOperationTool` so extension `index.ts` files stop copy-pasting the same scaffolding. Extensions under `.pi/extensions/` import it through the same allowlisted boundary as other `src/` facades (`tests/extension-import-boundary.test.js`), and `tests/extension-load.test.js` loads every extension through Pi's own TS loader against a stub API to catch broken imports or registration at test time — no model call required.

All Hermes consumers use the typed advisory adapter behind the integration boundary:

```text
src/integration-boundary.js → src/hermes-advisory.js → src/hermes-client.js
```

Only the adapter invokes the shared client. It owns bounded one-shot requests, readiness proofs, typed schemas, privacy scanning, repair limits, and metadata-only receipts. Goal control, Obsidian candidate curation, and Agent Skill drafting do not call Hermes subprocesses directly. Prompt suggestions use the configured Pi model through the provider-neutral model registry and do not depend on Hermes.

## Pi core integration boundary

A clean adapter boundary for the cognitive libraries is available at:

```text
src/integration-boundary.js
src/integration-config.js
src/file-integration-storage.js
src/trace-observability.js
```

Pi core should depend on adapters, not scattered direct imports from subsystem internals. The boundary includes injectable storage, logging/tracing sinks, per-subsystem disable switches, filesystem-backed storage, reusable trace runtime/storage/replay, and in-memory reference implementations for independent tests.

Docs and test:

```text
docs/integration-boundary.md
docs/runtime-configuration.md
docs/interactive-validation.md
tests/integration-boundary.test.js
tests/*adapter*.test.js
tests/disabled-side-effects.test.js
tests/extension-import-boundary.test.js
```

## Cognitive automation extension

A project-local automation extension is available at:

```text
.pi/extensions/reasoning-runtime/index.ts
```

It wires the repo subsystems into Pi automatically: cognitive memory recall/consolidation, layered context injection, semantic edit observation, model-side reasoning scaffold artifacts, verification debounce after mutations, entropy/stability monitoring, and cognitive session checkpoints/branches. Branch merge and rollback are explicit guarded commands: merge is dry-run by default, rollback is dry-run by default and creates a pre-rollback checkpoint before applying. Recovery snapshots exclude private runtime paths/transcript-shaped state, are size-capped and private, and remain local; exports contain lineage and aggregate metadata only. Cleanup is preview-first and protects snapshots reachable from live branch lineage.

Useful commands inside Pi:

```text
/cognitive-status
/cognitive-context [query]
/cognitive-memory [query]
/cognitive-verify
/cognitive-branches
/cognitive-entropy
/branch-list
/branch-show <branch-id>
/branch-export <branch-id>
/branch-cleanup-preview
/branch-cleanup-apply --yes
/branch-diff <left-branch-id> <right-branch-id>
/branch-merge <left-branch-id> <right-branch-id> [--apply] [--force]
/branch-rollback <branch-id> [snapshot-id] [--apply|--yes]
```

Runtime state is stored under:

```text
.pi/cognitive-automation/
```

Environment knobs:

```text
PI_COGNITIVE_AUTOMATION=0
PI_COGNITIVE_AUTO_INJECT=0
PI_COGNITIVE_AUTO_VERIFY=0
PI_COGNITIVE_BRANCHING_ENABLED=0
PI_COGNITIVE_AUTO_BRANCH=0
PI_COGNITIVE_AUTO_CHECKPOINT=0
PI_COGNITIVE_VERIFY_DEBOUNCE_MS=1500
PI_COGNITIVE_CHECKPOINT_DEBOUNCE_MS=2500
PI_COGNITIVE_CONTEXT_BUDGET_TOKENS=1800
PI_COGNITIVE_INJECT_MAX_CHARS=2500
PI_BRANCH_SNAPSHOT_MAX_BYTES=8388608
PI_BRANCH_MAX_SNAPSHOTS=200
PI_BRANCH_RETENTION_DAYS=30
```

Prompt suggestions wait for Pi's post-retry `agent_settled` boundary and keep the original deterministic local guidance immediate. A separately configured machine-wide Pi model restores the original best-next-prompt instruction and eight-message recent-context shape; context is text-only, scanner-redacted, capped per message, and bounded to 6,000 characters by default. The model is chosen with `/prompt-suggestions-model` and remembered in `<agent-dir>/prompt-suggestions.json`; it is independent of the session model. Refinement defaults to evidence-gated `auto`; `=1` is an explicit force-on override and `=0` disables refinement. Explicit `Ctrl+R` retry always requests a fresh attempt. Telemetry records only source/action/outcome/latency and a fixed categorical reason code, never suggestion, errors, or session text.

## Trace observability extension

A project-local tracing extension is available at:

```text
.pi/extensions/trace-observability/index.ts
```

It provides structured event tracing, prompt snapshots, diff tracking, metrics, replay inspection, JSON export, live/timeline/error views, append-only rotated JSONL storage, optional SQLite mirroring, and automatic failure-analysis events.

Docs:

```text
docs/trace-observability.md
examples/trace-workflow.md
```

Useful commands inside Pi:

```text
/trace-status
/trace-live [filter]
/trace-timeline
/trace-errors
/trace-export [correlation_id]
/trace-replay summary
/trace-replay step <index>
```

Trace storage rotates the active JSONL at `PI_TRACE_ROTATE_BYTES` (default 25MB) and prunes the oldest rotated files whenever the per-project trace directory exceeds `PI_TRACE_MAX_TOTAL_BYTES` (default 128MB). Active session files are never pruned.

Benchmark append overhead:

```bash
scripts/benchmark-trace-observability.sh
```

## Refresh and repeatable checks

Use the state-aware refresh entry point for routine extension and skill updates:

```bash
scripts/pi-harness-refresh.sh                  # extensions + skills + full checks
scripts/pi-harness-refresh.sh --pi             # Pi source fork + full checks
scripts/pi-harness-refresh.sh --all            # Pi + extensions + skills + full checks
scripts/pi-harness-refresh.sh --check-only     # full checks without deployment
scripts/pi-harness-refresh.sh --all --dry-run  # validate state and preview the workflow
```

Workflow flags can be combined. `--no-check` explicitly skips `scripts/check-all.sh`, and `--skip-pi-deps` passes `--skip-deps` to the Pi setup helper. Before invoking helpers, the wrapper validates selected source directories, skill destinations, settings JSON, helper executability, active Pi drift, and—for `--pi`—repository roots, configured branches/remotes, and clean worktrees. If Pi setup fast-forwards this harness, the wrapper restarts itself at the new HEAD before continuing. Skills are copied only after the full gate passes unless `--no-check` was requested. Restart Pi after `--pi`; use `/reload` or restart after extension/skill changes.

Run the full gate directly when orchestration is not needed:

```bash
scripts/check-all.sh
```

Run only integration-boundary checks:

```bash
scripts/check-integration-boundary.sh
```

Run only extension smoke checks:

```bash
scripts/check-extensions-smoke.sh
```

The suite auto-discovers extension entrypoints, runs a bounded model-free Pi RPC lifecycle probe (`get_state` and `get_commands`) for each, then runs one full-fleet model-backed print turn with thinking disabled. Every probe logs its duration. Override the defaults with `PI_EXTENSION_SMOKE_RPC_TIMEOUT_MS` (15s) and `PI_EXTENSION_SMOKE_MODEL_TIMEOUT_MS` (120s).

The unified script delegates Pi work to `scripts/setup-pi-fork.sh`, extension settings to `scripts/install-project-extensions.sh`, managed skill reconciliation to `scripts/install-agent-skills.sh`, and verification to `scripts/check-all.sh`. These lower-level helpers remain independently callable for debugging and specialized operations. The Pi setup helper refuses local/diverged work rather than stashing or resetting it; use its `--check` mode for a Pi-only read-only diagnostic.

The default Pi checkout is the sibling directory `../pi`; set `PI_SOURCE_ROOT` to override it. `scripts/check-pi-drift.sh` performs only the final linked-runtime verification and also runs inside `check-all.sh`.

Build/link and legacy rollback details are in [`docs/pi-global-patches.md`](docs/pi-global-patches.md); repository identities, minimum Node version, and the migrated-patch commit are pinned in [`config/pi-fork.env`](config/pi-fork.env).

Clean project-local runtime state:

```bash
scripts/clean-runtime-state.sh --yes
```

Run Hermes regression checks:

```bash
scripts/regression-hermes-advisory.sh
```

Open the manual smoke-test checklist:

```bash
scripts/smoke-hermes-advisory.sh
```

Launch Pi in the tested isolated extension mode:

```bash
scripts/smoke-hermes-advisory.sh --run
```
