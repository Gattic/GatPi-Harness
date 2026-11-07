# Productization extensions

This repo now includes project-local Pi extensions that turn existing cognitive libraries into focused workflows.

## Lifecycle portfolio policy

The schema-3 source/runtime inventory is `src/extension-registry.js`; the schema-4 lifecycle registry is `src/extension-portfolio.js`. Generated one-page records for all 46 extensions live under [`docs/extension-portfolio/`](./extension-portfolio/README.md). Extension Ops reconciles declared/runtime surfaces and reports metadata-only adoption, utility, reliable-core displacement, lifecycle authority, exact-source cohorts, operation canaries, and portfolio decisions through `/extensions-portfolio` or `extension_ops`.

Telemetry schema 6 adds an exact SHA-256 source fingerprint to every current event. `versionCohorts` bound evidence to `(extension, version, sourceFingerprint)`, `sourceTransitions` show adjacent cohorts, and `extension_ops operation=compare` compares operation counts and negative rates without reading prompts, arguments, paths, or outputs. Current-session-excluded local-HMAC interactive sessions remain the adoption denominator; RPC/JSON/print/test/smoke sessions are excluded. Fixed opportunity triggers now cover delegation, topology, CodeGraph, CI/PR, extension operations, performance, security, memory, evidence, research-vault, and managed-monitor intent.

The 30-day evidence gate still grants no automatic retirement authority. The 2026-08 product review nevertheless made an explicit human product decision to remove four zero/near-zero overlapping extension surfaces rather than preserve compatibility layers: Semantic Patch Workbench and Workflow Conductor were retired; plan fan-out moved into `create_subagent`; topology recipe administration moved into `run_topology`. `codegraph_files` remains available as `/codegraph-files` but is no longer a model tool. The reusable semantic editor and plan parser remain where canonical consumers use them.

The consolidated portfolio declares 62 tools: 59 parent-visible before model-exposure policy, 58 after the manual `output_compactor` compatibility surface remains command-only, plus three child-only role-sidecar tools. Tool Surface Router then selects a smaller task/readiness-specific subset per user input while preserving built-ins, configured inactive tools, and exact explicit tool requests. New default tools require a documented unique trigger, canonical overlap decision, measured value bar, and human review.

## Phase 7 release gate

[`docs/phase7-release-scorecard.md`](./phase7-release-scorecard.md) is the public aggregate scorecard; the adjacent JSON is the machine-readable schema-1 artifact. `scripts/freeze-phase7-release.js` freezes source/config hashes, `scripts/snapshot-extension-audit-registry.js` refreshes the inventory input, `scripts/audit-pi-sessions.py` excludes exact matched current-session IDs and separately reports requested/matched/unmatched aggregate counts, and `scripts/generate-phase7-scorecard.js` refuses runtime-source drift before rendering. Automatic R4 selection requires both fresh deterministic benchmark evidence and a fresh passing aggregate field report with at least 30 exact-cohort live read-only runs; either source alone fails closed to R0. All local evidence inputs under `.pi/phase7/`, `.pi/session-audit/`, and `.pi/role-runtime/` are private ignored state.

The current scorecard records 9 PASS, 0 FAIL, and 2 INSUFFICIENT DATA results. The frozen view has 0 observed interactive days; available post-freeze metadata events cannot be joined to interactive versus smoke/test sessions without weakening privacy, so they are explicitly not a rate denominator. Semgrep's post-fix infrastructure-error rate and live cognitive-context reduction therefore lack the mandatory classified 14-day cohort, and the release decision is **no-go-deferred** despite green deterministic/smoke/privacy/full-suite gates. Lifetime rates and calls before the frozen source/config identifiers are excluded from post-fix conclusions. No irreversible portfolio retirement is authorized.

Automatic evidence-selected role rollout remains capped at R4 and falls back to R0 when evidence is missing. Separately, the canonical reviewed environment explicitly selects R5 and isolated mutation as operator authority with explicit manual topology execution enabled and auto-routing still disabled by default. Specialist tasks inherit parent inference, with per-role environment overrides honored, without task/run budgets or correction caps. Optional project policies configure executable checkers; artifact-linked feedback is non-blocking, with no extra UI confirmation. See [normal-session use](specialist-tasks.md#normal-session-use). Runtime provenance reports that configured stage separately from the lower evidence-authorized stage; it does not relabel the scorecard. If explicitly enabled for a reviewed session, delegate mode automatically executes matched topologies and injects bounded typed results; parent patch application remains reviewed and explicit. `PI_MULTI_AGENT_TOPOLOGIES_ENABLED=0`, `PI_TOPOLOGY_AUTO_ROUTE=off`, `PI_ROLE_ROLLOUT_STAGE=R0`, `PI_ROLE_MUTATION=off`, and `PI_ROLE_RUNTIME_VERSION=1` are immediate state-preserving rollbacks.

## Verification Center

Path: `.pi/extensions/verification-center/index.ts`

Purpose: make proof-producing verification a first-class workflow over `src/verification-pipeline.js`.

Commands:

```text
/verify-status
/verify-plan [quick|changed|full|learning]
/verify-run [quick|changed|full|learning]
/verify-evidence
/verify-baseline
/verify-doctor
/verify-policy
/verify-watch
```

Model tool: `verification_center` with operations `status`, `plan`, `run`, `evidence`, `doctor`, and `policy`.

State/evidence: `.pi/verification-center/`.

Profiles are local-first and discovered from repo files. `full` prefers `scripts/check-all.sh`; quick/changed prefer smaller checks when available; `learning` runs the learning-loop self-benchmark profile. The extension stays manual by default so correctness can be raised without adding hot-path prompt latency.

Evidence statuses (2026-07-11): `pass`/`fail`/`blocked` behave as before; an empty change set now yields `ok: null` with `status: "not-applicable"` (nothing to verify is not a failure), and a real change with no matching/discovered verifiers stays fail-closed but carries `status: "no-verifiers"`. Learning-loop ingestion skips not-applicable evidence and records no-verifier evidence as a `verification-coverage-gap` outcome instead of a `verification-failure` — mined state showed 23 of 33 recorded proofs (and 4 of 4 learning outcomes) were empty-change false FAILs before this.

Headless exit codes (2026-07-11): in `pi -p` runs, `/verify-run` sets the process exit code to 1 on FAIL (PASS and not-applicable stay 0), so scripted/CI use can trust rc. `/build` and `/test` do the same. The mechanism is `setTurnExitCode(ctx)` from `src/pi-extension-kit.js` — headless-only, first nonzero code wins — and any command extension can adopt it.

Optional-provider policy (2026-07-26): CodeGraph and Semgrep readiness is normalized through `src/provider-readiness.js`. Missing, uninitialized, or degraded optional providers produce explicit advisory `not-applicable` state and cannot fail proof, suppress repository-defined verifiers, or become gating-safe. A `verification_center plan|run` tool call may explicitly supply `input.requiredProviders: ["codegraph", "semgrep"]`; only then does an applicable unavailable provider add a blocking `required-provider-readiness` policy violation. Unknown provider names are rejected rather than silently ignored.

## Canonical semantic editing

The standalone Semantic Patch Workbench and its `.pi/semantic-patches/` state path are retired. Localized mutations use `edit`; broad mechanical changes use `ast_refactor` preview/apply/rollback with checkpoints under `.pi/ast-refactor/`; compiler-sensitive renames use `lsp` preview/apply. `src/semantic-editor.js` remains an internal reusable library for LSP workspace edits, integration-boundary anchoring, and verification diffs, not a duplicate model/command surface.

## Runtime Doctor

Path: `.pi/extensions/runtime-doctor/index.ts`

Purpose: unify runtime health, latency, trace, memory/state size, extension inventory, and hot-path risk inspection.

Commands:

```text
/doctor
/doctor-latency
/doctor-memory
/doctor-context
/doctor-extensions
/doctor-hot-path
/doctor-export
/doctor-cleanup-preview
/doctor-cleanup-apply
/doctor-cleanup-policy
/doctor-cleanup-history
/doctor-sessions-preview [--archive] [--include-one-shot --project=current] [--older-than=7d]
/doctor-sessions-apply --yes [--archive] [--include-one-shot --project=current] [--older-than=7d]
/harness-metrics [--json]
```

Model tool: `runtime_doctor` with operations `summary`, `latency`, `memory`, `context`, `extensions`, `hotPath`, `export`, `cleanupPreview`, `cleanupApply`, `cleanupPolicy`, `cleanupHistory`, `sessionHygiene`, `sessionPermissionsApply`, and `harnessMetrics`. Session archive moves remain manual-command/script only.

`/harness-metrics` (backed by `src/harness-metrics.js`) aggregates the harness's own effectiveness signals from repo-local state: goal success rate from `.pi/goal-state/`, verification run/catch rate from `.pi/verification-center/`, semantic patch outcomes, recall/failure/slow-event activity from recent traces, and learning-loop outcome/pattern/decision accumulation. It is the measurement baseline for deciding which harness features earn further investment.

Exports: `.pi/runtime-doctor/doctor-*.json`.

The doctor reads recent trace JSONL files, project/global extension inventory, selected Pi environment toggles, cognitive runtime state sizes, and git status. It reports likely risks such as synchronous provider work on prompt paths, automatic consolidation, expensive auto verification, large cognitive state, or slow trace events. It also hardens the active Pi session to private file/directory modes and exposes preview-first historical permission/retention operations backed by `src/session-hygiene.js`; archives preserve JSONL plus a private SHA-256 manifest and never delete sessions.

## Chat Focus

Path: `.pi/extensions/chat-focus/index.ts` (library: `src/chat-focus.js`).

Commands: `/chat-focus [number|main|target-id]`, `/chat-back`, `/chat-list`. Shortcut: `F6` (`Ctrl+Shift+F` is reserved for Pi's built-in alternate-screen search).

Purpose: make the root chat, branch-backed subagents, forked session files, and alternate in-file tree branches visible as one compact chat strip below the editor. From the bottom of the message editor, press Down once more to focus the compact strip; Up and Down then move between chats, Up on the first chat returns focus to the message editor, and `Enter` opens the selected chat in the full focus panel. Press `F6` to open that panel directly. Within the panel, Down scrolls the current transcript and advances to the next chat at its end; Up scrolls back and returns to the previous chat at its start. `Tab` and `Shift+Tab` jump directly between chats, and `Esc` returns to the normal chat. When Pi is idle, `Enter` can switch the actual editable session or tree leaf; while the parent is working, or while a subagent still owns its RPC session file, the panel stays live and read-only so focus changes never abort work or introduce concurrent session writers. Completed subagents retain their Pi session path, allowing direct editing and `/chat-back` navigation afterward. To keep long-running parent sessions compact, the strip retains every active subagent plus the four most recent final subagents; an older final subagent also remains visible while its session is focused. `PI_CHAT_FOCUS_RECENT_FINAL_SUBAGENTS` changes the recent-final limit (including `0` to hide final subagents unless focused). This only bounds the focus UI and does not delete durable records; use `/subagent-prune` for storage cleanup. Poll and layout bounds are configurable with `PI_CHAT_FOCUS_POLL_MS`, `PI_CHAT_FOCUS_SESSION_SCAN_MS`, and `PI_CHAT_FOCUS_WIDGET_ROWS`.

## Session-mining-driven extensions (2026-07)

The extensions in this section were built from statistical mining of real session corpora (`~/.claude/projects`, `~/.codex/sessions`, `~/.pi/agent/sessions`); the evidence is recorded in `docs/harness-field-notes.md`.

### Recurring cross-agent session miner

Path: `src/session-miner.js` (operator script: `scripts/mine-agent-sessions.js`; exposed through the Learning Loop Coordinator).

Commands: `/learning-scan-sessions [--since-days=N] [--full] [--no-record]`, `/learning-session-report`.

Model tool operations: `learning_loop operation=sessionScan|sessionReport`.

Purpose: replace one-off corpus studies with a privacy-safe feedback cycle. Format adapters scan Claude, Codex, and Pi JSONL, but persist only aggregate tool/outcome/command-family/skill/correction/workflow counts, salted prompt-repeat fingerprints, stable candidate IDs, and trends. File mtime is only an opening optimization: every dated row is checked against the inclusive `sinceAt`/`untilAt` interval before aggregation, undated rows are counted separately and excluded by default, and cache reuse is bound to the exact cohort key. Reports publish the earliest/latest counted timestamps and whether both remain inside the requested interval. The bounded scan reads at most the selected 1 GiB and writes ignored local state under `.pi/session-mining/`. Candidate outcomes enter the existing reviewed learning pipeline; no transcript text, reasoning, raw commands/arguments/output, paths, prompts, automatic proposal approval, or direct mutation is allowed. See `docs/session-mining-loop.md`.

### Ralph-style Automation Loop

Path: `.pi/extensions/automation-loop/index.ts` (library: `src/automation-loop.js`).

Commands: `/loop`, `/ralph-loop`, `/loop-status`, `/loop-list`, `/loop-log`, `/loop-pause`, `/loop-resume`, `/loop-stop`, `/cancel-ralph`, `/loop-help`.

Model tool: `automation_loop` (`start`, `status`, `checkpoint`, `pause`, `complete`).

Purpose: repeat the same user-authored task from Pi's post-retry `agent_settled` boundary until an exact completion promise or evidence-backed completion, with a default 20-iteration budget, repeated-output/workspace stall detection, session isolation, prompt-file confinement, pause/resume/cancel controls, and compact PASS/FAIL/NULL checkpoint history. Automatic continuations are token-bound to one loop/iteration and dropped at input time if delayed, stale, or inactive; terminal provider failures pause without consuming useful budget. Model-tool starts require explicit current-user loop/autonomy intent. Missing intent/prompt, promise misuse, and evidence-free completion return structured `blocked` domain outcomes; controls with no active loop are `not-applicable`, so neither class is miscounted as a tool/runtime failure. Fixed-field lifecycle telemetry records eligibility, starts, checkpoints, transitions, and terminal outcomes in private `.pi/automation-loop/telemetry.jsonl`; it never stores prompts, checkpoint summaries, or evidence text. It is intentionally distinct from the Hermes-controlled `/goal`: `/loop` keeps the prompt fixed and lets files/git/ledgers carry progress. The design incorporates the successful Claude Ralph research pattern (Gate-0 probes, one focused change per iteration, explicit null/failure publication) and its closure lesson (pause for long waits, credentials, strategic choices, or costly resource authorization). State is ignored under `.pi/automation-loop/`. See `docs/automation-loop.md`.

### Build Runner

Path: `.pi/extensions/build-runner/index.ts` (library: `src/build-runner.js`)

Commands: `/build [target] [--configure]`, `/test [filter]`, `/build-config`.

Model tools: `build_project`, `test_project`.

Purpose: give the build → filtered-test ritual (`cmake --build` hand-typed 858x/month, project test binaries 1,043x/month) a one-token fast path. Command resolution prefers pinned config in `.pi/project.json` (`build`/`test`/`configure` keys), then detects CMake (`CMakeLists.txt`, `configure.sh`, test binaries under `build/`) or npm scripts. Build-length timeouts (`PI_BUILD_TIMEOUT_MS` default 15m, `PI_TEST_TIMEOUT_MS` default 10m) replace the 2-minute default that killed 35 builds/month, and native test crashes (SIGABRT/exit 134) automatically capture a gdb batch backtrace. Disable with `PI_BUILD_RUNNER=0`.

Builds, tests, detached jobs, and RPC sidecars do not share a job-count admission limit. Build Runner samples cgroup/host available RAM before launch and monitors each owned build/test process group plus descendants against the common RSS ceiling while running. Builds require at least 4096 MiB (4 GiB) of available RAM to start by default, independently of repository size or build tool. Non-native builds report an estimated 1 GiB working set, raised to 4 GiB when the repository exceeds 500 relevant source files; this estimate does not raise the start minimum. Native builds additionally combine available CPUs, a per-compiler-job allowance, and translation-unit count: large repositories default to at most four jobs, and bare flags such as CMake `--parallel` or Make `-j` are rewritten to a finite count; an explicitly lower project limit stays lower. Critically low-memory builds are deferred instead of risking the Pi process. Tune native execution with `PI_BUILD_MAX_JOBS`, `PI_BUILD_MEMORY_PER_JOB_MB`, or `build.maxJobs`; `PI_BUILD_RESERVE_MEMORY_MB` adjusts the reserve used for native job planning, `PI_MANAGED_PROCESS_*` controls live RSS supervision, and `PI_BUILD_ALLOW_LOW_MEMORY=1` forces only the safe-start gate.

Projects can raise or lower the build-start minimum in `.pi/project.json` without pinning a command or disabling build detection. For example, require 8 GiB of available RAM:

```json
{
  "build": { "minimumStartMemoryMb": 8192 }
}
```

`build.minimumStartMemoryMb` must be a positive integer in MiB; invalid values block the build before any command starts. This project value replaces the 4096 MiB default. The start check runs before configure scripts, canonical full-build scripts, and direct/targeted commands. Project settings are read on each build and do not mutate the process environment. `PI_BUILD_ALLOW_LOW_MEMORY=1` explicitly bypasses this start check. Neither the project minimum nor this bypass changes the separate live process-memory (RSS) cap, which remains 6144 MiB by default.

For a custom build tool or method, pin its command and arguments alongside the minimum, for example `"build": { "command": "pnpm", "args": ["run", "build"], "minimumStartMemoryMb": 8192 }`. Existing `build.maxJobs`, `build.timeoutMs`, and `configure` settings remain available for repository-specific execution.

Configure scripts are inspected for build steps. For a full build, a script that builds the project is treated as canonical and is not followed by a duplicate `cmake --build`; a requested target still gets a memory-capped direct target check after the script. Arguments are repository-owned: `configure.args` supplies that repository's defaults, `configure.argsByTarget` adds arguments for an exact target, an explicit `build_project.configureArgs` call overrides both, and otherwise the script runs with no arguments so its own defaults apply. For example, a repository may pin `configure: { "script": "configure.sh", "args": ["<repo-default>"], "argsByTarget": { "<target>": ["<target-option>"] } }`; Build Runner does not contain global project-specific flags. The same finite job plan is exported through `CMAKE_BUILD_PARALLEL_LEVEL`, `MAKEFLAGS`, and `PI_BUILD_JOBS`; an `nproc` PATH shim makes common `make -j$(nproc)` scripts observe the cap (`PI_BUILD_NPROC_SHIM=0` opts out).

### Debug Ledger

Path: `.pi/extensions/debug-ledger/index.ts` (library: `src/debug-ledger.js`)

Commands: `/debug-open <title>`, `/debug-attempt <id> <hypothesis> :: <change> :: <observation> :: <verdict>`, `/debug-list [open|resolved]`, `/debug-show <id>`, `/debug-resolve <id> [note]`.

Model tool: `debug_ledger` (open/attempt/list/show/resolve).

Purpose: kill the non-converging "the issue still persists" bug loop (worst human friction in the mined corpora: 40 recent occurrences, the same message 9x in one day, failed knob toggles retried across sessions). Each bug gets one durable thread of hypothesis → change → observation → verdict under private `.pi/debug-ledger/` state; open threads with their already-tried changes are injected once per session so dead ends are not retried. Attempts may carry an opaque Fix Recall `recallId`, enabling later fixed/partial/no-change/worse attribution without storing the recalled error text. Disable with `PI_DEBUG_LEDGER=0`; disable injection only with `PI_DEBUG_LEDGER_INJECT=0`.

### Background Jobs (bg-run)

Path: `.pi/extensions/bg-run/index.ts` (library: `src/bg-jobs.js`). Commands: `/bg <command>`, `/bg-status [id]`, `/bg-logs <id>`, `/bg-stop <id>`. Model tool: `bg_run` (start/status/logs/stop). Long commands run beneath a detached harness-owned supervisor with private state/logs under `.pi/jobs/`, so RSS monitoring, exit evidence, and stop escalation survive the spawning Pi turn. `run_deck launch` reuses this same path. Detached jobs and RPC sidecars have no shared job-count admission limit. Each owned command process group is sampled every 2 seconds and capped at 6144 MiB RSS; a breach or explicit stop sends `SIGTERM`, waits 5 seconds, then sends `SIGKILL` only to that owned group if needed. Tune with `PI_MANAGED_PROCESS_MAX_RSS_MB`, `PI_MANAGED_PROCESS_RSS_POLL_MS`, or `PI_MANAGED_PROCESS_TERM_GRACE_MS`; explicit environment values override canonical defaults. Attached external `run_deck` processes are status-only and are never killed because the harness does not own them. Per-target fixed counters track starts, explicit status/log calls, monitor attachments, one settlement notification, and one terminal-evidence record; public Harness Metrics exposes aggregates only. Point-in-time status/log access remains available, while explicit periodic-notification requests are routed to `run_monitor`. Evidence: 35 builds/month killed by 2-minute timeouts and re-run by hand. Disable with `PI_BG_RUN=0`.

### Commit Planner (commit-plan)

Path: `.pi/extensions/commit-plan/index.ts` (library: `src/commit-plan.js`). Command: `/commit-plan`. Model tool: `commit_plan` (plan/apply). Groups the working tree into logical commits (source+test stems pair; docs, scripts, config separate; `.pi/` state always excluded; `CMakeLists.txt` is build config, not docs) with starter messages the model refines; apply commits exactly the listed files. Evidence: 1 commit per 549 mined git invocations — trees hand-chunked into commits later. Disable with `PI_COMMIT_PLAN=0`.

### Fix Recall (fix-recall)

Path: `.pi/extensions/fix-recall/index.ts` (library: `src/fix-recall.js`). Command: `/fix-recall <error>`. Model tool: `fix_recall`. Fingerprints an error in memory (paths/numbers stripped, stopworded token overlap) and searches resolved debug-ledger threads plus successful learning-loop outcomes for what worked before. Private retrieval telemetry stores only an opaque retrieval id, timestamp, match count/source enums, and match-set hash—never error/query text. Passing that id as `debug_ledger recallId` attributes a later verdict; aggregate reporting compares linked versus unlinked no-change/worse rates as measured, insufficient-data, or unknown. Fix Recall never auto-applies a change. Disable with `PI_FIX_RECALL=0`.

### Safe Try (safe-try)

Path: `.pi/extensions/safe-try/index.ts` (library: `src/safe-try.js`). Commands: `/try [label]`, `/try-revert <id>`, `/try-list`. Model tool: `safe_try` (checkpoint/revert/list). Snapshots the working tree before a risky attempt (`git stash create` for tracked state via `refs/safe-try/*`, copies for untracked files under `.pi/safe-try/`), restores in one call; files created after the checkpoint are reported, never deleted. Evidence: 31 reverts and "made it worse" loops. Pairs with `debug_ledger` verdicts. Disable with `PI_SAFE_TRY=0`.

### Evidence Inbox (evidence-inbox)

Path: `.pi/extensions/evidence-inbox/index.ts` (library: `src/evidence-inbox.js`). Command: `/evidence [minutes]`. Model tool: `evidence_inbox`. Lists opaque references for the newest screenshots/videos/logs/profiles/traces from configured roots (`PI_EVIDENCE_ROOTS`, default repo + ~/Pictures + ~/Downloads) so debug and visual workflows can resolve artifacts in trusted memory without exposing filenames or paths. Evidence: 92 image attachments and perf.data/log ferrying per bug loop. Disable with `PI_EVIDENCE_INBOX=0`.

Build Runner addendum: plain test failures are retried once and classified (`ok (FLAKY...)`) — 44 immediate identical retries in the mined corpora were manual flake detection; disable per call with `retryFlaky: false`.

### Repo Context

Path: `.pi/extensions/repo-context/index.ts` (library: `src/repo-context.js`)

Commands: `/repo-context`. Model tool: `repo_context`.

Purpose: kill the universal session-opening ritual (git status ×180, git diff ×290, CLAUDE.md re-reads ×75 in the mined corpora). Builds a compact local snapshot — branch (including unborn and detached states), changed files, recent commits, top-level layout, CLAUDE.md/AGENTS.md digest — and injects it once per session at `before_agent_start`; the tool refreshes it on demand. Changed-path accounting is computed before the 15-row display cap and exposes `totalChanged`, `shownChanged`, and `truncated`; capped output says, for example, `22 changed (showing 15)`. The complete total is fixture-checked against Git Evidence. Works in any repo, no network, ~3s git timeouts, graceful in non-git dirs. Disable with `PI_REPO_CONTEXT=0`; injection only with `PI_REPO_CONTEXT_INJECT=0`.

### Plan fan-out in `create_subagent`

Path: `.pi/extensions/reasoning-runtime/index.ts` (parser: `src/plan-fanout.js`)

Command: `/subagent-fanout <plan-file> [--max=N]`. Model operation: `create_subagent operation=fanout` with repository-confined `planFile` or inline `planText`. No separate extension, state owner, or compatibility tool remains.

The operation turns reviewed Markdown checklist/numbered items into bounded typed worker specifications. Each specification contains a registered role ID, role-contract version, workspace/mutation policy, task/file zones, compact context, model/tool/time budget, merge policy, expected output schema, dependencies, handled terminal outcomes, and verification requirements. Conflict-free work is scheduled in waves at RPC concurrency 2; one fan-out contains at most 8 workers by default and 16 at the hard cap. Fan-out only prepares specs; delegation and patch transfer remain explicit.

### Run Deck

Path: `.pi/extensions/run-deck/index.ts` (library: `src/run-deck.js`)

Commands: `/run-status [id]`, `/runs [status]`, `/run-launch <command> [:: name [:: log pattern]]`, `/run-attach <log path or pattern> [:: name [:: pgrep pattern]]`, `/run-finish <id> <status> [verdict]`.

Model tool: `run_deck` (launch/attach/status/watch/note/finish/list).

Purpose: collapse the training-run babysitting ritual that owns the fresh ML corpus (59% of 423 human turns; "Give a status report on the current run" 69x verbatim, 154x as a family; the live logdir re-derived 116x with `ls -td logs/*` plus ~150 scratch-file pointer reads/writes; bespoke until-grep poll loops rebuilt ~126x with the naive sleep-poll form sandbox-blocked 8x). One private durable record per long-running run under `.pi/run-deck/` — launched detached via the bg-jobs library or attached to an externally-started process by log path/pattern (`logs/x_*/run.log`, newest match wins) — with a log-vitals parser, pid/pgrep checks, optional GPU digest, bounded milestone watch, and final verdict/banked metrics. Fixed per-target counters measure point-in-time status/watch calls, monitor attachment, settlement notification, polling triples, and idempotent terminal evidence without exposing commands, paths, output, or target ids in aggregate reports. Manual status/watch remains available; explicit periodic-notification requests should attach `run_monitor`. Registered runs inject a one-line-per-run digest at session start. Disable with `PI_RUN_DECK=0`; injection only with `PI_RUN_DECK_INJECT=0`.

### Run Monitor

Path: `extensions/run-monitor/index.ts` (library: `src/run-monitor.js`)

Commands: `/monitor-start`, `/monitor-status`, `/monitor-check`, `/monitor-stop`, `/monitors`.

Model tool: `run_monitor` (`start`, `status`, `check`, `stop`, `list`). It is retained with lifecycle `enabled-observation-pending`; it is excluded from early pruning until enough eligible managed long-run sessions exist.

Purpose: provide session-idle periodic observation after a process has already been registered with `bg_run` or `run_deck`. Each monitor performs an immediate sample, then checks on a bounded interval until optional literal milestone text appears, the target settles, the observation deadline expires, checking errors, or the user stops the monitor. Notifications are edge-triggered: unchanged active polls stay silent, and target settlement notification is counted exactly once. A terminal edge runs `scripts/run-monitor-check.js`, which probes the target and records `scriptCheck` on the monitor without sending a user message or starting a model turn; background timers, session restore, slash commands, tool results, and print/JSON sessions all show the script probe inline. It never repeats model work or stops the target process, so it does not bypass the explicit-user boundary on `automation_loop`.

State is private under `.pi/run-monitor/` and scoped to the owning Pi session. Active records survive `/reload`; orderly session replacement/quit stops the monitor while leaving the job/run intact. Timers are cleared on `session_shutdown` and `unref()`'d, so print mode is not held open. Poll intervals are clamped from 1 second to 1 hour, deadlines from 1 second to 7 days, literal patterns to 500 characters, and inspected log tails to 32 KiB. A fixed local classifier plus privacy-tokenized metadata records eligible/acted monitor intent and started/terminal/notification signals without text, raw session/target ids, patterns, paths, logs, or output. This measures explicit adoption but never auto-attaches a monitor. Disable with `PI_RUN_MONITOR=0`; defaults are configured by `PI_RUN_MONITOR_INTERVAL_MS`, `PI_RUN_MONITOR_TIMEOUT_MS`, `PI_RUN_MONITOR_MAX_ACTIVE`, and `PI_RUN_MONITOR_INTENT_TELEMETRY`. See `docs/run-monitor.md`.

### Experiment Ledger

Path: `.pi/extensions/experiment-ledger/index.ts` (library: `src/experiment-ledger.js`)

Commands: `/exp-open <title> :: <hypothesis> :: <bars> :: <arms>`, `/exp-gate <id> <gate> <verdict> [note]`, `/exp-list [open|closed]`, `/exp-show <id>`, `/exp-close <id> <ship|no-go|shelved> [note]`.

Model tool: `experiment_ledger` (open/gate/close/list/show).

Purpose: the debug ledger is bug-shaped; research work in the mined ML corpus is experiment-shaped — every idea runs a pre-registered gate ladder (E0 bit-parity → E1 units → E3 cheap-gate → E4 ship decision) with PASS/FAIL/NULL verdicts, GPU-hour budgets, and ship/no-go closure, tracked by hand in ~170 memory files. One durable thread per experiment under `.pi/experiment-ledger/`: hypothesis, pre-registered bars and arms (written before anything runs), gate verdicts with metrics and GPU-hours, linked `run_deck` run ids and commits, and a closure decision. Open experiments inject their bars and last gate at session start, so fresh sessions neither re-run settled gates nor drift from the registered protocol (the observed friction: redundant baselines, wrong-arm A/B runs, "are you running the multi-seed anyways despite what I said?"). Disable with `PI_EXPERIMENT_LEDGER=0`; injection only with `PI_EXPERIMENT_LEDGER_INJECT=0`.

## Next-tier workflow extensions

The repo also includes four complementary workflow extensions.

### Topology recipe administration in `run_topology`

Path: `.pi/extensions/reasoning-runtime/index.ts` (library: `src/topology-recipes.js`)

Commands: `/topology-recipes`, `/topology-install`, `/topology-recommend`, `/topology-lint`, `/topology-upgrade`. Model operations: `run_topology recipes|installed|recommend|install|lint|upgrade` alongside the existing execution/inspection operations. No standalone catalog surface remains.

The library exposes canonical role-aware defaults from `src/role-topologies.js`, validates installed and built-in packets, and writes explicitly installed copies under `.pi/topologies/`. Every node carries role-contract, workspace/mutation, budget, and output-schema metadata. Topology success never transfers files: mutating results still require explicit patch preview and apply.

### Session Stabilizer

Path: `.pi/extensions/runtime-doctor/index.ts` (merged into the Runtime Doctor extension; all runtime-health surfaces now live together)

Commands: `/stabilize`, `/stabilize-plan`, `/stabilize-context`, `/stabilize-memory`, `/stabilize-branches`, `/stabilize-reset-noise`, `/stabilize-cleanup-preview`, `/stabilize-cleanup-apply`.

Model tool: `session_stabilizer`. Disable just the stabilizer surfaces with `PI_SESSION_STABILIZER=0`; `PI_RUNTIME_DOCTOR=0` and `PI_PERFORMANCE_OPTIMIZER=0` gate the other surfaces independently.

Purpose: turn entropy/runtime-state observations into a conservative recovery/checkpoint plan. Cleanup preview/apply uses `src/runtime-cleanup.js`; safe trace/entropy actions can be applied explicitly, while branch/reasoning snapshot deletion remains preview-only. State stays under `.pi/session-stabilizer/`.

### Privacy Guard

Path: `.pi/extensions/privacy-guard/index.ts`

Commands: `/privacy-status`, `/privacy-scan`, `/privacy-trace-audit`, `/privacy-memory-audit`, `/privacy-redaction-test`, `/privacy-policy`, `/privacy-purge`.

Model tool: `privacy_guard`.

Purpose: audit repo-local runtime state for likely secrets, full-transcript hints, and risky privacy settings. Purge is preview-only. Source/docs matches for transcript vocabulary are ignored by default to avoid false positives; use `/privacy-scan --include-ignored --include-source` or tool input `{ includeIgnored: true, includeSource: true }` for a full audit trail. Global Hermes caches are excluded unless `--global` / `{ includeGlobal: true }` is supplied.

### Memory Explorer

Path: `.pi/extensions/memory-explorer/index.ts`

Commands: `/memory-map`, `/memory-search`, `/memory-lineage`, `/memory-conflicts`, `/memory-prune-preview`, `/memory-forget`, `/memory-export-safe`, `/memory-promote`, `/memory-demote`.

Model tool: `memory_explorer`.

Purpose: map/search repo-local Pi/Hermes memory-like state and preview cleanup without deleting state. Global caches are excluded unless `--global` / `{ includeGlobal: true }` is supplied.

## Highest-priority workflow extensions

The repo also includes the first set of high-priority extensions that compose the lower-level primitives into complete repo workflows.

### Project Profiler

Path: `.pi/extensions/project-intelligence/index.ts` (merged into the Project Intelligence extension; both always wrapped the same `src/project-intelligence.js` library)

Commands: `/project-profile`, `/project-init-pi`, `/project-recommend`, `/project-safe-commands`, `/project-write-config`.

Model tool: `project_profiler`. Disable just the profiler surfaces with `PI_PROJECT_PROFILER=0`; `PI_PROJECT_INTELLIGENCE=0` disables the index/symbols/tests/deps surfaces independently.

Purpose: inspect an arbitrary repository and recommend Pi verifier profiles, topology recipes, safe commands, and privacy defaults. `/project-init-pi` writes `.pi/project.json` so new repos can be onboarded without hand-assembling conventions. It uses `src/project-intelligence.js` so extension/source-only repos without `package.json` are still detected from file extensions, symbols, tests, dependency manifests, and CI files.

### Test Gap Planner

Path: `.pi/extensions/test-gap-planner/index.ts`

Commands: `/test-gaps`, `/test-plan`, `/test-impact`, `/test-generate-skeletons`, `/test-risk`.

Model tool: `test_gap_planner`.

Purpose: map changed files to likely tests, score verification risk, recommend commands, and preview or write focused test skeletons. It complements Verification Center by identifying what evidence is still missing before a correctness claim. Test mapping now shares the deeper project intelligence index with Project Profiler and Verification Center.

### Memory Curator

Path: `.pi/extensions/memory-explorer/index.ts` (merged into the Memory Explorer extension; explorer surfaces stay read-only, curator surfaces stay governed lifecycle reviews)

Commands: `/memory-review`, `/memory-curate-plan`, `/memory-apply-forget`, `/memory-dedupe`, `/memory-promote-architecture`, `/memory-expire-stale`.

Model tool: `memory_curator`, retained for explicit user memory-management intent rather than automatic/default workflow selection. Disable just the curator surfaces with `PI_MEMORY_CURATOR=0`; `PI_MEMORY_EXPLORER=0` disables the explorer surfaces independently.

Purpose: provide governed memory lifecycle management over repo-local Pi/Hermes state. It creates checkpoint backups and ledgers for forget/expire actions, records architecture promotion candidates, and keeps destructive deletion intentionally explicit/manual or delegated to runtime cleanup. Global caches are excluded unless `--global` / `{ includeGlobal: true }` is supplied. State stays under `.pi/memory-curator/`.

### Policy Gate

Path: `.pi/extensions/policy-enforcer/index.ts` (merged into the Policy Enforcer extension: gate surfaces are advisory checks over `src/runtime-policy.js`, enforcer surfaces actively gate tool calls through `src/policy-enforcement.js`)

Commands: `/policy-status`, `/policy-check`, `/policy-denylist`, `/policy-allowlist`, `/policy-simulate`, `/policy-enforce`.

Model tool: `policy_gate`. Disable just the gate surfaces with `PI_POLICY_GATE=0`; `PI_POLICY_ENFORCER=0` disables the enforcement hook and its commands independently.

Purpose: centralize local safety policy for shell commands, tool grants, path writes, privacy-sensitive trace settings, and approval-required automation. It is advisory/manual by default and produces durable check ledgers. State stays under `.pi/policy-gate/`.

### Performance Optimizer

Path: `.pi/extensions/runtime-doctor/index.ts` (merged into the Runtime Doctor extension; all runtime-health surfaces now live together)

Commands: `/perf-profile`, `/perf-hot-path`, `/perf-regression`, `/perf-compare`, `/perf-baseline`, `/perf-after`, `/perf-report`, `/perf-fix-plan`, `/perf-apply-safe`.

Model tool: `performance_optimizer`. Disable just the perf surfaces with `PI_PERFORMANCE_OPTIMIZER=0`; `PI_RUNTIME_DOCTOR=0` and `PI_SESSION_STABILIZER=0` gate the other surfaces independently.

Purpose: close the loop from Runtime Doctor and trace observability by profiling recent repo-local trace events, identifying hot paths, comparing against a local baseline, and writing safe environment recommendations for manual adoption. Global traces are excluded unless `--global` / `{ includeGlobal: true }` is supplied. State stays under `.pi/performance-optimizer/`.

### CI / PR Companion

Path: `.pi/extensions/ci-pr-companion/index.ts`

Commands: `/ci-status`, `/ci-failures`, `/pr-summary`, `/pr-review`, `/pr-risk`, `/pr-verify`.

Model tool: `ci_pr_companion`.

Purpose: inspect optional GitHub CLI CI/PR context, summarize failures and PR risk, and recommend local verification actions. It remains credential-safe and optional: if `gh` is unavailable, commands report local git/workflow context and guidance instead of failing.

## Operational glue extensions

### CodeGraph Adapter

Path: `.pi/extensions/codegraph/index.ts`

Commands: `/codegraph-status`, `/codegraph-sync`, `/codegraph-query`, `/codegraph-context`, `/codegraph-affected`, `/codegraph-files`, `/codegraph-doctor`.

Model tools: `codegraph_status`, `codegraph_query`, `codegraph_context`, `codegraph_affected`, `codegraph_sync`, `codegraph_files`, `codegraph_doctor`.

Purpose: expose the local `codegraph` CLI inside Pi as safe, structured commands and model tools for symbol search, task context, affected-test selection, index status, doctor diagnostics, and sync/index refreshes. Shared behavior lives in `src/codegraph-adapter.js`, keeping the extension registration layer thin and making graph context reusable by Project Intelligence, Test Gap Planner, Verification Center, Code Context, and Runtime Doctor. `/codegraph-files` remains an explicit command, not a model tool. The adapter defaults to the active Pi cwd, uses argument arrays instead of shell interpolation, and requires `PI_CODEGRAPH_ALLOW_OUTSIDE=1` before explicit project paths may escape the current cwd. Query, context, and affected results are validated into the shared retrieval envelope and rendered within a token budget (`budgetTokens`), with the complete provider record kept in tool-result `details` and the raw text behind `verbose=true`; `codegraph_context` omits the verbatim source section unless `includeSource=true`, and status/sync/file reports are line-bounded instead of dumped. Freshness state is recorded under `.pi/codegraph/`; edit/write/modifying bash tool results mark the graph stale, while `PI_CODEGRAPH_AUTO_SYNC=1` opts into debounced background sync. CodeGraph is advisory, local-first, reversible, and non-blocking by default; it must not store private reasoning or become required for goal/verification completion.

Retrieval queries and affected-test calls always request structured provider data. The former `json`/`quiet` tool switches and `/codegraph-* --json/--quiet` options are removed: use `verbose=true` (CLI `--verbose`) for raw JSON. CLI `--budget-tokens` controls the compact view, and `--include-source` expands context source.

### Semgrep Adapter

`gitverify` and Verification Center run a shared risk-sensitive checkpoint using configured or checked-in rules even when background enrichment is off. Reports separate findings from unavailable scans and preserve baseline tests. See [Risk-focused code analysis](code-analysis-workflow.md) for the exact selection and authority boundaries.

Path: `.pi/extensions/semgrep/index.ts`

Commands: `/semgrep-status`, `/semgrep-scan`, `/semgrep-changed`, `/semgrep-codegraph`, `/semgrep-doctor`.

Model tools: `semgrep_status`, `semgrep_scan`, `semgrep_codegraph`, `semgrep_doctor`.

Purpose: expose the local `semgrep` CLI or Docker-backed wrapper inside Pi as optional static-analysis context for security, injection, auth, secret-handling, and pattern-based bug checks. Shared behavior lives in `src/semgrep-adapter.js`; the extension layer only registers commands/tools. The adapter uses argument arrays, disables Semgrep metrics by default, normalizes JSON findings, and reports binary readiness separately from bounded config readiness. Scan results are validated into the shared retrieval envelope: findings render highest-severity first within a token budget (`budgetTokens`) with severity and per-rule counts plus a readiness footer, while the complete provider output stays in tool-result `details.raw` and `verbose=true` returns it directly. `p/default` is the unpinned registry default; `auto` is rejected before launch while metrics are off, and unavailable packs are negative-cached after config validation. `semgrep_codegraph` intentionally bridges to `src/codegraph-adapter.js`: Semgrep identifies suspicious changed/finding files, while CodeGraph maps those files to likely affected tests and remains available as degraded advisory context when Semgrep cannot run.

Native scan tools always request JSON from Semgrep so plain-text findings cannot be misclassified as an empty clean scan. The former `json` tool switch and `--json`/`--text` command options are removed; use `verbose=true` (CLI `--verbose`) for the raw provider record, or `--budget-tokens` to adjust the compact view.

### Obsidian Adapter

Path: `.pi/extensions/obsidian/index.ts`

Commands: `/obsidian-status`, `/obsidian-doctor`, `/obsidian-search`, `/obsidian-note`, `/obsidian-import`, `/obsidian-hermes`, `/obsidian-open`.

Model tools: `obsidian_status`, `obsidian_search`, `obsidian_note`, `obsidian_import`, `obsidian_hermes`, `obsidian_doctor`.

Purpose: expose a local Obsidian vault as optional Markdown-backed research and durable-memory context. Shared behavior lives in `src/obsidian-adapter.js`; the extension layer registers commands/tools and injects lightweight model awareness. The automatic per-session status is local and non-authenticated. Readiness is layered across vault filesystem, desktop executable/open state, Hermes executable, authentication, provider/model, local Markdown operations, and end-to-end curation; a missing desktop never blocks filesystem-backed search/note/import. `/obsidian-doctor --probe-auth` performs a bounded active model check, while `--probe-curation` adds a bounded synthetic-input dry-run smoke that reads no vault bodies, writes no note, and reports authentication/provider/transport/timeout failures distinctly. `obsidian_hermes` remains explicit requested work. All note/import/index writes are confined to the real vault root and reject symlink components rather than following them. Readiness telemetry is metadata-only (operation, outcome/category, duration, counts), with no credentials, prompts, raw provider output, vault contents, or source bodies.

### Git Evidence Courier

Path: `extensions/git-evidence-courier/index.ts`

Commands: `/git:evidence`, `/git:verify`, `/git:publish`.

Model tools: `gitevidence`, `gitverify`.

Purpose: make git claims evidence-backed. `/git:evidence` reports repository root, branch/upstream, local and remote SHA, clean-tree status, diff stats, last commit, ahead/behind counts, and inferred verifier hints. `/git:verify [command && command]` runs explicit `&&`/newline-separated shell commands, or inferred verifiers when no arguments are supplied; inferred mode always includes `git diff --check` and `git diff --cached --check`, then picks a profile from repo files (`lakefile.lean`/`lakefile.toml` → `lake build`, `Cargo.toml` → `cargo test`, `go.mod` → `go test ./...`, `pyproject.toml`/`pytest.ini` → `pytest`, `package.json` → `npm run lint/typecheck/test --if-present`). For inferred verification of a Prisma/PostgreSQL repository, the extension starts a uniquely named, pinned PostgreSQL 16 container with random credentials, a uniquely named ownership-labelled local disk-backed data volume, resource limits, and a loopback-only dynamic port; it overrides `TEST_DATABASE_URL`, `DATABASE_URL`, and `DIRECT_DATABASE_URL` for every verifier command, then verifies the `pi.gitverify=isolated` ownership label on both container and volume before removing them and confirming their absence. Partial provisioning and already-removed containers do not skip volume cleanup. Provisioning or cleanup failures fail closed, generated credentials are omitted from reports, and repository Compose services are never invoked. Explicit `/git:verify <commands>` remains user-controlled and does not provision infrastructure. `/git:publish [--verify] [remote] [branch]` refuses dirty trees and detached HEAD, optionally runs inferred verification first, checks the remote branch is an ancestor of local `HEAD`, requires explicit interactive user confirmation (and refuses to push in non-interactive contexts), pushes `HEAD:<branch>` without force, and then confirms the remote SHA matches local `HEAD` plus post-push clean-tree status. The model tools are deliberately constrained: `gitevidence` is read-only and never pushes, `gitverify` runs only inferred verification and never accepts arbitrary shell commands, and there is intentionally no model-callable publish tool. Reports are also persisted as `git-evidence-courier` session messages. The extension has no environment knobs.

### Code Context

Path: `.pi/extensions/code-context/index.ts`

Model tool: `code_context` with `repoMap`, `search`, `symbolGet`, `symbolRelations`, `buildQuery`, `changeImpact`, and `diagnostics` operations.

Purpose: expose one provider-neutral, read-oriented facade for progressive codebase retrieval. Shared behavior lives in `src/code-context-service.js`; lexical search, repository-map ranking, LSP, CodeGraph, project/build facts, and impact providers stay behind that service. Level 1 maps contain architecture/signature/relationship cards rather than bodies and are packed against an explicit token budget. Source bodies require an explicit `symbolGet detail=body` request. Every result reports freshness/degradation/provenance and whether it is gating-safe. The default mode is advisory, no source context is injected automatically, and existing provider tools remain available for diagnostics and compatibility.

The service emits privacy-bounded retrieval events on `code-context:retrieval`; the trace extension owns the only subscriber/runtime and unregisters it at shutdown. `select-tests` and `on` are evidence-gated by the saved benchmark report and are demoted to advisory without authorization. Even when promoted, selected tests augment rather than replace baseline verification.

### General Coding Workflow Tools

Paths:

```text
.pi/extensions/lsp/index.ts
.pi/extensions/test-runner/index.ts
.pi/extensions/ast-tools/index.ts
.pi/extensions/docs-lookup/index.ts
```

Model tools: `lsp`, `test_runner`, `ast_search`, `ast_refactor`, and `docs_lookup`.

Purpose: provide general model-callable coding primitives that reduce ad-hoc shell usage. `lsp` exposes lazy live language-server semantics when available, compiler diagnostics, and an explicitly advisory lexical fallback; only hash-validated live-LSP rename previews may be applied. `test_runner` infers focused/quick/full/unit profiles from repo files and runs them with structured command evidence and failure hints; no inferred repository command, no prior run, and no failed command to rerun return canonical `not-applicable` outcomes rather than false pass/fail results. Explicit empty integration/lint/typecheck profiles do not fall back to quick tests. `ast_search` and `ast_refactor` provide regex-backed declaration/lexical matching and checkpointed replacements, not parsed structural search or scope-aware rename; comments/strings can match and complex syntax can be missed. `docs_lookup` searches only current-repository docs and installed `node_modules` package docs without network access. Pi framework/extension docs outside cwd must instead be read directly from the configured Pi source checkout (`$PI_SOURCE_ROOT/packages/coding-agent/` or the default sibling `../pi`); confinement is not weakened.

These tools are manual/model-callable only: they do not run on the prompt hot path. Mutating operations require explicit apply modes, AST refactors checkpoint under `.pi/ast-refactor/`, and test evidence is written under `.pi/test-runner/`. `ast_search` collects 50 matches by default and renders them within a token budget, reporting the match limit and a refinement hint instead of dumping every hit; `verbose=true` returns the raw match list.

### Output Compactor

Path: `.pi/extensions/output-compactor/index.ts`

Commands: `/output-compact`, `/output-compactor-status`.

Model tool: `output_compactor`, experimental and command-only by default. Tool-specific result rendering is canonical because a manual model call would resend the oversized payload already in context. Temporarily restore model exposure with `PI_OUTPUT_COMPACTOR_MODEL_TOOL=1`.

Purpose: compact verbose JSON/tool payloads into concise summaries using `src/result-rendering.js`. `PI_OUTPUT_COMPACTOR_MODE=canary` is the guarded default and modifies only oversized results from `evidence_binder`, `extension_ops`, `learning_loop`, `run_deck`, `run_topology`, `runtime_doctor`, and `verification_center`; `off` disables compaction but keeps observation, and `all` is an explicit broad trial. `PI_OUTPUT_COMPACTOR_CANARY_TOOLS` changes the reviewed canary set, while `/output-compact` remains available. Privacy-tokenized feature signals record only tool identifier, input/output/saved character counts, duration, session kind, and canonical outcome. Full details remain in result `details` and persisted traces when available; no result body enters telemetry.

The compactor is a backstop, not the primary mechanism: CodeGraph, Semgrep, and AST tools already return bounded retrieval views from `src/provider-result-rendering.js`, and `compactToolPayload` dispatches those envelopes to the same provider renderers. Already-budgeted native views and explicit `verbose=true` requests are not compacted again. Budgets use the conservative UTF-8-bytes/4 token estimate, not a provider tokenizer; footer text, omission notices and optional source count toward the budget.

A central observer records every top-level final result at `tool_execution_end`, after result transformers finish. It records only the producing `tool`, raw-provider, pre-backstop and final model-visible character counts, and the native token budget; nested tool results are excluded to prevent double-counting. `/harness-metrics` reports native plus backstop savings from these observations once, with per-tool totals. Separate compacted/bypassed signals attribute large unhandled results, including in `MODE=off`; `PI_OUTPUT_COMPACTOR=0` disables the extension and its observer entirely. No result bodies or arguments enter telemetry, and runtime call identifiers are hashed only into event identities.

### Context Overflow Recovery

Path: `.pi/extensions/context-overflow-recovery/index.ts`

Commands: `/compact-rescue`, `/compaction-recovery-status`.

Purpose: keep an oversized chat recoverable when Pi's network-backed summarizer fails or its own summary input exceeds the model limit. At `agent_settled`, active context is proactively compacted when usage reaches 80% or a bounded traversal finds more than 8 MiB of active structured context. This uses `ctx.compact()`, which appends a normal compaction checkpoint; it never truncates or deletes session JSONL. Overflow and threshold compactions, over-limit manual `/compact`, proactive compaction, and explicit rescue compactions first summarize over forced SSE with a bounded timeout and the real session ID. If that request fails, `src/context-overflow-recovery.js` creates a bounded local extractive summary and cumulative file list. Extension load evicts that CommonJS helper from `require.cache` so `/reload` cannot retain stale exports; known rescue events also have a dependency-free minimal summary if structured recovery throws. Trace observability's `session_before_*` hooks explicitly return `undefined`, preventing the later observer from overwriting recovery control results and causing fall-through to Pi's default WebSocket summarizer. Pi's overflow loop then continues automatically; rescued manual compaction schedules a continuation after AgentSession reconnects. Output-token-limited assistants continue at `agent_settled` after any required proactive/threshold compaction, bounded to three consecutive injections and suppressed when another extension already owns continuation. Set `PI_COMPACTION_PROACTIVE=0` to disable proactive triggering; tune thresholds with `PI_COMPACTION_PROACTIVE_PERCENT` and `PI_COMPACTION_PROACTIVE_MAX_CHARS`. Manual compaction below pressure remains unchanged. See `docs/context-overflow-recovery.md`.

### Policy Enforcer

Path: `.pi/extensions/policy-enforcer/index.ts`

Commands: `/policy-enforcer-status`, `/policy-mode`, `/policy-approvals`, `/policy-approve`, `/policy-approve-directory`, `/policy-revoke`.

Model tool: `policy_enforcer`.

Purpose: turn the advisory policy model into active `tool_call` enforcement with file-backed approval grants under `.pi/policy-enforcer/`. Modes are `advisory`, `warn`, `block`, and `approval`; default `block` refuses deny-level shell/path/tool requests without an approval. In `approval` mode a request is offered to the desktop dialog and, when pi-dash has a dashboard or phone connected, to its Approvals card through the `approval:request` bridge event; the first answer from either surface wins, the phone card is withdrawn once the desktop answers (`approval:settle`), and a request nobody answers blocks the call. Active enforcement uses the project policy in `.pi/policy-gate/policy.json`, while allowing currently registered tools.

`/policy-approve-directory <directory>` creates a **permanent recursive write grant**, scoped to the current source project and an existing canonical destination directory. It covers structured write/edit path requests, including new descendants, without approving shell commands or overriding protected path prefixes. Grants are directional, are not transitive, and are listed/revoked with the existing approval commands. Directory grants are created by the slash command, not the model approval tool. See [Directory write approvals](policy-directory-approvals.md) for setup, limits, and revocation.

### Project Intelligence

Path: `.pi/extensions/project-intelligence/index.ts`

Commands: `/project-index`, `/project-symbols`, `/project-tests-map`, `/project-deps`.

Model tool: `project_intelligence`.

Purpose: build a reusable repo index over languages, source/test files, symbols, dependency manifests, CI files, verifier profiles, and topology recommendations. The shared library is `src/project-intelligence.js` and now feeds Project Profiler, Test Gap Planner, and Verification Center. Project indexes and test-impact reports also expose normalized CodeGraph/Semgrep readiness so optional provider absence remains visible but degraded-advisory by default.

### Evidence Binder

Path: `.pi/extensions/evidence-binder/index.ts`

Commands: `/evidence-status`, `/evidence-capture-verification`, `/claim-check`, `/evidence-report`.

Model tool: `evidence_binder`.

Purpose: capture proof packets and check completion/verification claims against captured evidence using `src/evidence-binder.js`. It can import the latest Verification Center evidence, including metadata-only visual comparison identities and opaque artifact references, and warns when assistant completion claims lack supporting proof packets. If Verification Center has not run, capture returns `ready: false`, canonical `not-applicable` status, the fixed `verification-prerequisite-missing` reason code, and an actionable `verification_center plan|run` next step instead of an ambiguous tool failure.

### Extension Ops Center

Path: `.pi/extensions/extension-ops-center/index.ts`

Commands: `/extensions-report`, `/extensions-inventory`, `/extensions-portfolio`, `/extensions-conflicts`, `/extensions-smoke-plan`, `/extensions-canaries`, `/extensions-docs`.

Model tool: `extension_ops`, including `portfolio`, `telemetry`, `compare`, and `canaries`.

Purpose: inventory project/global extensions, command/tool registrations, event hooks, environment knobs, exact source hashes, smoke plans, operation-level canary templates/evidence, conflicts, versioned lifecycle records, model-exposure decisions, and post-fix observation sufficiency. `canaries` never executes owning operations; it records only explicit settled metadata against a current canary ID. Shared libraries are `src/extension-registry.js`, `src/extension-portfolio.js`, `src/extension-telemetry.js`, and `src/extension-canaries.js`.

### Rollout Center

Path: `.pi/extensions/rollout-center/index.ts`

Command: `/rollout-center [all|attention|stale]`. No model tool.

Purpose: render one read-only, privacy-bounded view of technical readiness, policy authority, field proof, rollback controls, next permitted observations, and provenance for extension, role, project-memory, compounding, Phase-7, Verification Center, and Visual Verification capabilities. It uses `RolloutCenterAdapter` through `src/integration-boundary.js`, creates no cache, and cannot launch, record, apply, promote, or mutate anything. Extension Ops remains the inventory/portfolio authority.

Visual Verification is configured in `.pi/project.json` and runs through Verification Center as an optional `visual` verifier. TUI baselines retain hashes rather than frame bodies; image/Graphviz/external captures are temporary; baseline updates use the separate command-only `scripts/manage-visual-baselines.js` workflow.

### Tool Surface Router

Path: `extensions/tool-surface-router/index.ts` (library: `src/tool-surface-router.js`). Command: `/tool-surface`. Model tool: `activate_tools` (baseline; lists the optional catalog or activates named tools under the router's eligibility and readiness gates).

On `session_start` it captures the configured eligible set and removes optional managed tools from the baseline. On each raw `input` it deterministically classifies the task into delegation, automation, memory/research, CodeGraph, security, extension/runtime governance, long runs, debugging, CI, commits, and evidence, then activates only the tool that intent names rather than the whole capability group: each group has a primary tool plus narrow selectors (`codegraph_status`, `codegraph_affected`, `codegraph_sync`, `semgrep_codegraph`, `run_monitor`, `safe_try`, and so on). Activating a whole group would add schemas this turn does not need, and an activated tool schema is resent on every later turn for the rest of the session; the unactivated siblings stay reachable through `activate_tools`. Roadmap remains in the initially allowed baseline so ordinary multi-step tasks and follow-ups can use it without explicit planning keywords; explicit exclusions and child-role restrictions still apply. Exact tool names in the task are explicit overrides only when the tool was initially eligible and its provider is ready. Missing CodeGraph/Semgrep binaries and missing Obsidian vaults fail closed for provider operations while status/doctor commands remain available. When a task shifts mid-session (a discovered bug, a run just launched), `activate_tools` reaches the same optional tools by name instead of waiting for a later user prompt to mention them; it reports inactive, blocked and ineligible tools rather than guessing. Prompts and tool arguments are never persisted.

### Tool Churn Guard

Path: `extensions/tool-churn-guard/index.ts` (library: `src/tool-churn-guard.js`). Command: `/tool-churn-status`. No model tool.

The `tool_call`/`tool_result` hook adds one concise result advisory after repeated process polling, unchanged Git checks, Roadmap status churn, policy approval churn, or an identical failed request. It never blocks a tool. Persisted entries contain only timestamp, tool, operation, count, and a fixed reason; argument fingerprints are ephemeral and result bodies are never stored.

### Roadmap

Path: `.pi/extensions/roadmap/index.ts`

Commands: `/roadmap`, `/roadmap-panel`, `/roadmap-start`, `/roadmap-subtask`, `/roadmap-replace`, `/roadmap-add`, `/roadmap-active`, `/roadmap-adopt`, `/roadmap-done`, `/roadmap-verify`, `/roadmap-block`, `/roadmap-skip`, `/roadmap-close`, `/roadmap-shelve`, `/roadmap-resume`, `/roadmap-archive`, `/roadmap-link`, `/roadmap-next`, `/roadmap-import-reasoning`, `/roadmap-report`, `/roadmap-export`, `/roadmap-clear`.

Model tool: `roadmap_update`.

Purpose: provide a persistent visual checklist/status layer for long-running plans and multi-session work. Roadmap v3 stores atomic private state, a last-known-good packet, retained root archives, and metadata-only telemetry under `.pi/roadmap/`, with one store per session (`sessions/<session-id>/`) beneath the Git worktree or project root so concurrent sessions in one directory keep independent roadmaps. A session without a roadmap lists the directory's roadmaps and can adopt one explicitly. It compiles executable milestone/goal hierarchies atomically, emits compact bounded mutation envelopes, settles several items (and nested goals with `cascade`) in one call, reserves focused/paged full state for explicit show/export, distinguishes actionable from blocked/paused/shelved scope, and requires current fingerprint-bound evidence for substantiated verification. Whole-root replacement remains explicit. Typed failures cover stale items/evidence, invalid operations, missing or nonactionable parents, lifecycle conflicts, and persistence. Historical and exact-version evidence remain separate; rollout stays sample-size-aware and `PI_ROADMAP=0` remains the rollback switch.

### Learning Loop Coordinator

Path: `.pi/extensions/learning-loop-coordinator/index.ts`

Commands: `/learning-status`, `/learning-record-outcome`, `/learning-ingest`, `/learning-outcomes`, `/learning-rate-outcome`, `/learning-patterns`, `/learning-propose`, `/learning-inbox`, `/learning-show`, `/learning-review`, `/learning-approve`, `/learning-dismiss`, `/learning-apply`, `/learning-verify`, `/learning-benchmark`, `/learning-context-attribution`, `/learning-model-router`, `/learning-experiment`, `/learning-refactor-propose`, `/learning-memory-summary`, `/learning-export`, `/learning-doctor`.

Model tool: `learning_loop`.

Purpose: expose the reviewed self-improvement learning-store MVP from `src/learning-loop.js`. It records redacted outcomes, ingests compact local evidence from verification/topology/skill/trace/evidence/goal/runtime/memory/policy/privacy sources, explicitly scans privacy-safe cross-agent aggregates through `src/session-miner.js`, persists mined patterns to `patterns.jsonl`, creates actionable reviewed proposals for skills/tests/prompts/config, and supports approve/dismiss/verify/delegated-apply-plan flows. `/learning-rate-outcome` exposes the outcome-rater preview, `/learning-patterns --failures` exposes the failure-pattern miner, `/learning-context-attribution` and `/learning-model-router` provide advisory-only optimization recommendations, `/learning-experiment` creates branch/topology experiment plans and can capture benchmark evidence with `--run-benchmark`, and `/learning-refactor-propose` writes dry-run `edit`/`ast_refactor` proposal packets under learning-loop state without applying source changes. `/learning-verify` runs safe shell commands from a proposal verification plan when present, captures Evidence Binder packets, can capture latest Verification Center evidence, and records a verification outcome. `/learning-apply` remains non-mutating: it either shows a delegated plan or records an already-delegated apply only with evidence refs. `/learning-memory-summary` writes reviewed Hermes/Memory Curator summary candidates under both learning-loop and memory-curator state. `/learning-benchmark` plans or runs a small learning-loop self-benchmark. It is manual by default: no hot-path ingestion and no direct file/config/prompt/skill mutation. Optional background ingestion is disabled unless `PI_LEARNING_AUTO_INGEST=1` is set; it records only safe compact sources and still never auto-proposes or auto-applies.

Review gates: `/learning-review` uses Evidence Binder packets when available, Privacy Guard latest-scan state plus redaction/secret checks, runtime policy evaluation, and Test Gap Planner/project-intelligence impact mapping.

State: `.pi/learning-loop/` (ignored runtime state), including `outcomes.jsonl`, `patterns.jsonl`, proposals, decisions, and exports.

### Expanded Topology Workflow Pack

Paths: `.pi/extensions/reasoning-runtime/index.ts`, `src/topology-recipes.js`, and `src/role-topologies.js`.

`run_topology` recipe administration includes these workflows: `refactor-with-safety-net`, `dependency-upgrade`, `failing-ci-triage`, `performance-regression`, and `release-prep`, in addition to the original planner/coder/verifier, review, bug, docs, and security recipes. Every implementation-capable recipe now carries a typed `roadmapPlanGate`; the parent runtime persists the planner hierarchy before any coder or refactorer node starts.

## Context-efficiency and prompt-suggestion policy

Paths: `.pi/extensions/reasoning-runtime/index.ts`, `src/reasoning-injection.js`, `extensions/prompt-suggestions/index.ts`, `src/prompt-suggestion-policy.js`, and `src/prompt-suggestion-model.js`.

The reasoning runtime classifies investigation, planning, implementation, verification-only, publish, credential, destructive, and answer modalities before building public scaffolds. Read-only modes contain no mutation/repair subtask; protected actions require a separate confirmation step and remain blocked from automatic routing. The active objective and explicit constraints are preserved without scratchpad content. Full context is injected once with a default 2,500-character hard cap; later turns cross the boundary only for changed semantic sections. Hot-path memory removes prior objectives, successful proof history, and duplicates. Telemetry stores first/delta/identical rendered, injected, and saved character counts with coarse session kind only. Router and skill recommendation events store shown/accepted/dismissed/overridden/corrected metadata, candidate configuration ids, and confidence bands—never prompt text.

Prompt Suggestions keeps deterministic local generation synchronous. Metadata-only events distinguish generated/refined/skipped/shown/accepted/dismissed/retried/timed-out/failed outcomes, latency, and a fixed categorical reason code. The configured model stays content-bounded, abortable, and asynchronous, with no request deadline. The model is chosen machine-wide with `/prompt-suggestions-model` and saved in `<agent-dir>/prompt-suggestions.json`, independent of the session model; the extension does not invoke Hermes. Incomplete non-timeout evidence allows one bootstrap attempt per new idle state without a timed interval. Unrestricted `auto` requires >=20 non-timeout attempts, accepted/shown >=20%, and the non-timeout failure bar; historical/upstream timeouts cannot poison or complete that cohort. A completed cohort failing those non-timeout quality bars remains local-only. Explicit retry gathers evidence immediately at user request; `PI_PROMPT_SUGGESTIONS_REFINE=1` forces automatic refinement on, and `=0` disables it.

## Branch snapshot privacy and maintenance

Paths: `src/session-branches.js`, `src/integration-boundary.js`, `.pi/extensions/privacy-guard/index.ts`, and `scripts/maintain-branch-snapshots.js`.

Branch recovery state is local-only. Direct and integration-backed stores share canonical repository-relative path validation, traversal/duplicate-alias rejection, symlink-component refusal, private-path/transcript/prompt/raw-state sanitization, secret redaction and string caps, an 8 MiB configurable snapshot cap, atomic no-follow `0600` writes, and `0700` directories. Exports are metadata-only lineage/aggregate packets. Cleanup is preview-first, identity/hash revalidated, and lineage-aware: live and ancestor checkpoints are protected; only unreachable age/count overflow may be removed. Privacy Guard parses branch snapshots structurally so embedded ordinary source recovery is not mistaken for a transcript, while private snapshot paths or transcript-shaped cognitive state remain actionable findings.

## Runtime cleanup automation

Shared cleanup engine: `src/runtime-cleanup.js`.

It inspects project trace, global trace, entropy JSONL, branch snapshots, and reasoning snapshots; builds a manifest-first cleanup plan; truncates project trace and entropy JSONL with gzip archives; and deletes old global trace files according to age/count policy. Branch snapshot sanitization/permission hardening and lineage-aware retention are handled by the dedicated preview/apply workflow above; reasoning snapshot cleanup remains preview-only.

Useful commands:

```text
/doctor-cleanup-preview
/doctor-cleanup-apply
/stabilize-cleanup-preview
/stabilize-cleanup-apply
```

Environment knobs:

```text
PI_CLEANUP_AUTOMATION=0
PI_CLEANUP_DRY_RUN=1
PI_CLEANUP_GLOBAL_TRACE=0
PI_CLEANUP_MAX_GLOBAL_TRACE_MB=250
PI_CLEANUP_KEEP_GLOBAL_TRACE_FILES=10
PI_CLEANUP_KEEP_TRACE_EVENTS=2000
PI_CLEANUP_MIN_TRACE_AGE_HOURS=6
PI_CLEANUP_ENTROPY_MAX_MB=10
```

Manifests and archives are stored under `.pi/runtime-cleanup/` and contain file metadata/action summaries, not trace payload contents.

## Validation

Extension smoke checks auto-discover all project and version-controlled global extension entrypoints. Each gets a bounded model-free Pi RPC lifecycle probe; one full-fleet model-backed turn covers provider/agent interaction without multiplying provider latency by the extension count:

```bash
scripts/check-extensions-smoke.sh
```

Focused Obsidian adapter checks:

```bash
node tests/obsidian-adapter.test.js
node tests/obsidian-extension.test.js
```

Focused run-monitor checks:

```bash
node tests/run-monitor.test.js
node tests/run-monitor-extension.test.js
node tests/run-monitor-check-script.test.js
node scripts/extension-smoke-runner.js rpc extensions/run-monitor/index.ts
```

Focused Git Evidence Courier checks:

```bash
node tests/git-evidence-courier.test.js
```

Static command/tool registration checks live in:

```bash
node tests/productization-extensions.test.js
```
