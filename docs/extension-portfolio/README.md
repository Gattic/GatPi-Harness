# Extension portfolio registry

Generated from portfolio schema 4.

- Extensions: 51
- Tool decisions: 70
- Default active model tools: 65 -> 64 (reduction 1)
- Observation: 0.48 days / 30 required (insufficient-data; source=classified-interactive-audit-unavailable)
- Measured adoption/opportunity records: 0/0
- Lifecycle authority: no-go-deferred
- Reconciled: true
- Decisions: keep=62, keep-child-only=5, keep-explicit=1, experimental-command-only=1, keep-observation-pending=1

## Records

- [00-harness-defaults](./00-harness-defaults.md) — core; model exposure=none
- [ast-tools](./ast-tools.md) — core; model exposure=default
- [automation-loop](./automation-loop.md) — enabled; model exposure=default
- [bg-run](./bg-run.md) — core; model exposure=default
- [build-runner](./build-runner.md) — core; model exposure=default
- [chat-focus](./chat-focus.md) — enabled; model exposure=none
- [ci-pr-companion](./ci-pr-companion.md) — enabled; model exposure=default
- [code-context](./code-context.md) — enabled; model exposure=default
- [codegraph](./codegraph.md) — enabled; model exposure=default
- [codemode](./codemode.md) — core; model exposure=default
- [commit-plan](./commit-plan.md) — enabled; model exposure=default
- [completion-enforcement](./completion-enforcement.md) — enabled; model exposure=none
- [context-overflow-recovery](./context-overflow-recovery.md) — enabled; model exposure=none
- [debug-ledger](./debug-ledger.md) — core; model exposure=default
- [docs-lookup](./docs-lookup.md) — enabled; model exposure=default
- [evidence-binder](./evidence-binder.md) — enabled; model exposure=default
- [evidence-inbox](./evidence-inbox.md) — enabled; model exposure=default
- [experiment-ledger](./experiment-ledger.md) — enabled; model exposure=default
- [extension-ops-center](./extension-ops-center.md) — enabled; model exposure=default
- [fix-recall](./fix-recall.md) — enabled; model exposure=default
- [git-evidence-courier](./git-evidence-courier.md) — core; model exposure=default
- [goal](./goal.md) — enabled; model exposure=none
- [harness-awareness](./harness-awareness.md) — enabled; model exposure=none
- [hermes-advisory](./hermes-advisory.md) — enabled; model exposure=intent-gated
- [learning-loop-coordinator](./learning-loop-coordinator.md) — enabled; model exposure=default
- [lsp](./lsp.md) — core; model exposure=default
- [memory-explorer](./memory-explorer.md) — enabled-explicit; model exposure=default
- [multi-login](./multi-login.md) — enabled; model exposure=none
- [obsidian](./obsidian.md) — enabled; model exposure=default
- [output-compactor](./output-compactor.md) — experimental-canary; model exposure=command-only
- [pi-queue](./pi-queue.md) — enabled; model exposure=default
- [policy-enforcer](./policy-enforcer.md) — enabled; model exposure=default
- [privacy-guard](./privacy-guard.md) — enabled; model exposure=default
- [project-intelligence](./project-intelligence.md) — enabled; model exposure=default
- [prompt-suggestions](./prompt-suggestions.md) — enabled; model exposure=none
- [reasoning-runtime](./reasoning-runtime.md) — enabled; model exposure=default
- [repo-context](./repo-context.md) — core; model exposure=default
- [roadmap](./roadmap.md) — core; model exposure=default
- [role-sidecar](./role-sidecar.md) — child-only; model exposure=child-only
- [rollout-center](./rollout-center.md) — enabled; model exposure=none
- [run-deck](./run-deck.md) — core; model exposure=default
- [run-monitor](./run-monitor.md) — enabled-observation-pending; model exposure=default
- [runtime-doctor](./runtime-doctor.md) — enabled; model exposure=default
- [safe-try](./safe-try.md) — enabled; model exposure=default
- [semgrep](./semgrep.md) — enabled; model exposure=default
- [test-gap-planner](./test-gap-planner.md) — enabled; model exposure=default
- [test-runner](./test-runner.md) — enabled; model exposure=default
- [tool-churn-guard](./tool-churn-guard.md) — enabled; model exposure=none
- [tool-surface-router](./tool-surface-router.md) — core; model exposure=default
- [trace-observability](./trace-observability.md) — enabled; model exposure=none
- [verification-center](./verification-center.md) — enabled; model exposure=default

## Conservative policy

Command-only model tools remain opt-in until both unique-trigger utility evidence and the 30-day classified cohort pass. Their commands, state, parsers, and underlying libraries remain available. `memory_curator` remains available only for explicit memory-management intent. `run_monitor` is retained pending an eligible long-run cohort. Low use without measured opportunities is never treated as low value.
