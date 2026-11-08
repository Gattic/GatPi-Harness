# Extension and command reference

The harness registers a large extension surface in Pi. This page is the full command reference; the main README lists the capability families only. Every command below is available inside a Pi session after the harness is installed and `/reload` has run. Optional adapters (Hermes, CodeGraph, Semgrep, Obsidian, LSP servers) degrade to explicit guidance when their binaries are missing.

## Command reference

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

Model tools are registered as `code_context`, `lsp`, `test_runner`, `ast_search`, `ast_refactor`, and `docs_lookup`. `code_context` is the preferred read-oriented facade for progressive localization: start with `repoMap`/`search`, inspect symbol cards, and request `symbolGet detail=body` only after localization. Existing provider tools remain available for diagnostics. Retrieval is explicit and advisory by default; stale/degraded cards are never gating-safe and no source map is injected automatically. Promoted `select-tests`/`on` modes require a saved benchmark report and only augment baseline verification. Optional scale-out providers remain blocked unless `node scripts/probe-code-context-scale-gates.js` records actual local pressure for an isolated pilot. `test_runner` reports empty inference/no-prior-failures as `not-applicable`, not pass or fail. `docs_lookup` remains cwd-confined; read Pi framework docs directly from `$PI_SOURCE_ROOT/packages/coding-agent/` (or the default sibling `../pi`) instead of weakening confinement. `ast_*` is regex-backed, not parser/scope-aware. Risk-sensitive Semgrep checks now run inside `gitverify` and Verification Center; Node coverage ingestion is opt-in. See [`docs/code-analysis-workflow.md`](../docs/code-analysis-workflow.md) for routing, limitations, outcome reviews and recommended LSP installations, and [`docs/code-context-benchmark.md`](../docs/code-context-benchmark.md) for benchmark boundaries.

Sectioned document writes are provided by `extensions/write-chunking/`:

```text
model tool: append_file                        Append a section to a file without rewriting it
```

`write` creates the file with the first section and `append_file` adds each later section, so a large document never needs one oversized payload. `append_file` creates missing files and parent directories, and inserts a separating newline when the existing file does not end with one. Any `write` or `append_file` payload over `PI_WRITE_CHUNK_LIMIT` (default 16384 characters) is blocked with sectioned-write guidance instead of being sent; the same rule is appended to the `write` tool description so the model sees it before composing. `PI_WRITE_CHUNK_LIMIT=0` stops enforcing the limit and `PI_WRITE_CHUNKING=0` disables the extension. See [configuration](configuration.md) for the canonical defaults.

Context-overflow recovery is provided by `.pi/extensions/context-overflow-recovery/`:

```text
/compact-rescue [focus]            Force SSE compaction with a bounded local fallback
/compaction-recovery-status        Show recovery configuration and in-process counters
```

Overflow and threshold-pressure compactions use the recovery path automatically. A summarization WebSocket or input-limit failure falls back to a local extractive summary and writes a real compaction entry instead of leaving the chat permanently over its context window. Pi's overflow retry then continues the interrupted turn; over-limit manual `/compact` and `/compact-rescue` schedule continuation automatically after compaction reconnects. If an assistant instead stops at its maximum output-token limit, the extension continues at `agent_settled` after compaction and queued work finish, bounded to three consecutive injections and suppressed when another extension already owns continuation. Manual compaction below pressure keeps Pi's default behavior. See [`docs/context-overflow-recovery.md`](../docs/context-overflow-recovery.md).

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

---

[Back to the README](../README.md) · [Wiki index](README.md)
