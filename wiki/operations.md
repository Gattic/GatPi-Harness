# Operations, refresh, and checks

Routine maintenance goes through one state-aware entry point. This page keeps the operational detail and the documentation map that the main README only links to.

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

The default Pi checkout is the sibling directory `../GatPi` (pinned in `config/pi-fork.env`); set `PI_SOURCE_ROOT` to override it. `scripts/check-pi-drift.sh` performs only the final linked-runtime verification and also runs inside `check-all.sh`.

Build/link and legacy rollback details are in [`docs/pi-global-patches.md`](../docs/pi-global-patches.md); repository identities, minimum Node version, and the migrated-patch commit are pinned in [`config/pi-fork.env`](../config/pi-fork.env).

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

---

[Back to the README](../README.md) · [Wiki index](README.md)
