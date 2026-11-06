# Pi workflow pack

This guide composes the project-local extensions into end-to-end workflows. Roadmap is the only active plan-state owner: for a genuinely new objective, start a visible plan with `/roadmap-start <title>` and stable required outcomes, and update material transitions. For continuation or compaction, show and resume existing IDs instead of starting another wrapper. The workflow entrypoints below are examples for new roots; inside an existing implementation plan, use notes/evidence or an explicitly owned temporary helper and return to the parent. Passing a phase is progress, not completion of the full authorized plan. Follow the [finite execution contract](full-plan-execution.md) for acceptance scope, blocker mapping, resource lifecycle, and closeout. For reviewed Markdown plans that should become bounded worker specifications, use `/subagent-fanout <plan-file>` or `create_subagent operation=fanout`.

## Onboard a new repository

Roadmap entrypoint: `/roadmap-start Onboard repository`.

1. `/project-profile` to inspect language, scripts, CI, docs, and test layout.
2. `/codegraph-doctor` and `/semgrep-doctor` to inspect optional provider readiness.
3. `/project-index` for symbols, tests, dependencies, CI, and verifier profiles.
4. `/project-recommend` to review safe commands, topology recipes, and privacy defaults.
5. `/project-init-pi` to write `.pi/project.json` only after review.
6. `/topology-recommend <task>` then `/topology-install <recipe>` when multi-agent execution is explicitly useful.
7. `/verify-plan changed` to confirm repository-defined verification.

## Make a risky edit

Roadmap entrypoint: `/roadmap-start Risky edit`.

1. `/policy-check <planned command or path>` and `/policy-enforcer-status`.
2. `/try <label>` before an attempt that may make the tree worse.
3. Use `code_context` first; use `/codegraph-context`, `/codegraph-affected`, or `/semgrep-codegraph` only when provider-specific context is relevant and ready.
4. Use `edit` for localized changes. For broad lexical work, run `/ast-refactor-preview`, review it, then `/ast-refactor-apply`; rollback remains available. This is regex-backed replacement, not semantic rename; use live LSP for that.
5. `/test-gaps` and `test_runner operation=infer` to select focused checks.
6. `/verify-run changed` after edits. It and `gitverify` include risk-triggered Semgrep checkpoints; inspect their results rather than duplicating scans. [Code analysis workflow](code-analysis-workflow.md) documents the limits, opt-in Node coverage and LSP installations.
7. `/evidence-capture-verification` then `/claim-check <final claim>` before a verified completion claim.
8. `/learning-ingest verification` and `/learning-propose --min=1` may queue reviewed follow-up proposals; they do not apply changes.

## Run a bounded autonomous task loop

Use `/loop` only when the same well-specified task should repeat until objective completion:

1. Put substantial acceptance criteria in a repository file when useful, then start `/loop --prompt-file=TASK.md --max=20`.
2. Add `--promise=TEXT` only when it has an objective meaning. With a promise, finish with the exact final-response tag; without one, completion requires evidence.
3. Checkpoint material PASS/FAIL/NULL findings so later iterations do not repeat settled attempts.
4. Pause for credentials, destructive actions, long unmanaged waits, or strategic user input.
5. Use `run_deck` for one long process and `run_monitor` for requested periodic settlement notification; do not use an automation loop to poll it.

## Debug failing CI

Roadmap entrypoint: `/roadmap-start CI triage`.

1. `/ci-status` and `/ci-failures` when GitHub CLI is ready.
2. Open a durable debug thread and check Fix Recall before changing code.
3. `/topology-install failing-ci-triage` then `/topology-run failing-ci-triage <task>` only for explicit delegation.
4. `/test-impact`, `test_runner operation=infer`, and `/verify-run changed` to prove the repair.
5. Record every attempted hypothesis verdict; resolve only with evidence.

## Improve latency

Roadmap entrypoint: `/roadmap-start Latency improvement`.

1. `/doctor-hot-path` for current risks.
2. `/perf-baseline` before changes.
3. Make one measured optimization.
4. `/perf-after` and `/perf-report` after changes.
5. Keep Hermes advisory calls explicit and off-path, consolidation manual, and trace payload capture off in normal use.

## Curate stale memory

Roadmap entrypoint: `/roadmap-start Memory curation`.

1. `/memory-map` and `/memory-review`.
2. `/memory-curate-plan` for the governed plan.
3. Promote only reviewed durable architecture/procedural candidates.
4. Preview forget/dedupe/expiry operations and inspect checkpoints before explicit apply.
5. Never store secrets, transcripts, or raw logs in durable notes.

## Release prep

Roadmap entrypoint: `/roadmap-start Release prep`.

1. `/extensions-report`, `/extensions-portfolio`, and `/extensions-canaries` for inventory, lifecycle, exact-source evidence, and operation templates.
2. `/topology-install release-prep` when explicit multi-agent review is useful.
3. `/verify-run full` or the repository full verifier.
4. `/privacy-scan` and `/topology-lint`.
5. `/evidence-report` before final claims.
6. Update docs/changelog and commit only product files, never `.pi` runtime state.

## Dogfood the learning loop

Roadmap entrypoint: `/roadmap-start Learning loop dogfood`.

1. `/learning-scan-sessions --since-days=30` to mine aggregate-only workflow evidence.
2. `/learning-ingest all` and `/learning-patterns --mine --failures --min=1`.
3. `/learning-propose --min=1`, `/learning-review latest`, then `/learning-approve latest` after inspection.
4. `/learning-refactor-propose latest` and `/learning-experiment latest` create delegated plans only.
5. `/verify-run learning` and `/learning-verify latest --latest` bind evidence.
6. Record applied status only after delegated mutation actually occurred with evidence IDs.
7. `/learning-memory-summary latest` creates a reviewed memory candidate.

## Change Pi extensions or libraries

Roadmap entrypoint: `/roadmap-start Extension change`.

1. `/extensions-conflicts` before adding commands or tools.
2. `/tool-surface` to inspect task-aware exposure; `/tool-churn-status` to inspect repeated-call guard state.
3. `/codegraph-doctor` and `/semgrep-doctor` for optional provider readiness.
4. `/test-gaps` and `/extensions-smoke-plan` for impacted checks.
5. `extension_ops operation=compare` for exact-source pre/post cohorts; `operation=canaries` for non-executing operation templates and explicit settled records.
6. `/verify-run changed`, then full verification when feasible.
7. `/learning-benchmark` or `/verify-plan learning` for the learning-loop self-benchmark profile.
