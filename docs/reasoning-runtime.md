# Model-side reasoning runtime

Decision: **model = reasoning engine; harness = cognitive runtime**.

The harness must not simulate private reasoning, depend on hidden reasoning text, expose model scratchpads unnecessarily, or treat verbose reflection as proof. It should provide durable, inspectable scaffolding around reasoning-model outputs.

## Runtime scaffolding

Library:

```text
src/reasoning-runtime.js
```

Integration adapter:

```text
ReasoningRuntimeAdapter
createPiIntegrationBoundary(...).reasoning
```

Supported explicit artifacts:

- plan artifacts
- task decomposition objects
- hypotheses
- decision records
- executor actions
- verifier evidence
- verifier feedback
- memory updates
- reasoning checkpoints
- branch comparisons
- failure analyses

## Scratchpad/result separation

`ReasoningRuntime.createCheckpoint()` accepts private `scratchpad` data, stores it behind an opaque `scratchpadRef`, and keeps public result packets free of scratchpad text. Public artifacts are sanitized with `stripPrivateReasoning()` to remove common private-reasoning fields.

## Artifact validation

Artifact creation validates required public fields and rejects common private-reasoning fields before persistence. `scratchpad` is accepted only by checkpoint creation, where it is stored behind an opaque `scratchpadRef` and omitted from public exports/replay.

## Verification contract

Reflection and confidence are not proof. Acceptance requires verifier evidence artifacts. Failure paths should produce verifier feedback and failure analysis artifacts that a reasoning model can use for the next revision.

Verifier stdout and stderr are bounded while child processes are running and bounded again when custom verifier results are normalized (`PI_VERIFICATION_MAX_OUTPUT_BYTES`, default 262144 bytes per stream). Durable evidence records truncation and original-size metadata. Reasoning artifacts store a compact proof summary plus the durable evidence-file reference; they never duplicate complete verifier logs inside every `failure_analysis` artifact.

## Cleanup/export workflow

Use the cleanup script to remove stale local role-architecture context/memory:

```bash
node scripts/clean-stale-reasoning-state.js
node scripts/clean-stale-reasoning-state.js --dry-run
```

Use `/reasoning-debug-context` to inspect the source of injected scaffold, memory, layered context, Hermes, trace, and entropy blocks. The full context is injected once per session; later turns render active-objective, decisions/evidence, constraints/safety, warnings/routing, and scaffold sections, then inject only sections whose content changed, so the scaffold is re-sent when the turn's modality changes. Extension-authored prompts keep the last user turn's scaffold. Hot-path selection removes historical user objectives, successful proof history, and exact duplicates. Stable auto-router guidance is emitted once until mode, classification, topology, reason/confidence, or outcome changes. Metadata telemetry retains only rendered/injected/saved character counts and categorical reasons. Use `/reasoning-version` to confirm the running extension version, config flags, template activation, source hash, and reasoning adapter availability after `/reload`. Use `/reasoning-self-test` to verify that scaffold templates, version banner rendering, semantic architecture memory dedupe, stale-text filtering, and scratchpad separation are active in the running TUI process. Use `/reasoning-prune` to remove old automatic `model-scaffold` artifacts while preserving verifier evidence, failure analyses, decision records, memory updates, and user-created artifacts. Use `/reasoning-export` and `/reasoning-replay` in Pi for public artifact debugging without exposing scratchpads.

Opt-in latency instrumentation is available with `PI_COGNITIVE_TIMING=1` or `/cognitive-timing on` for the current process. It records local trace events for session startup and `before_agent_start` substeps (`syncObjective`, scaffold creation, memory retrieval, context packing, skill retrieval, rendering, deferred reasoning persistence, and total time). Inspect recent records with `/cognitive-timing`; disable runtime timing with `/cognitive-timing off`. Timing is off by default and should be used to identify the largest measured contributor before optimizing hot paths. Hot-path memory context excludes episodic memory by default (`PI_COGNITIVE_HOT_MEMORY_TYPES=semantic,procedural,strategic`) to avoid scoring every assistant-turn memory on each prompt; broaden this only when debugging requires episodic recall. Stale reasoning cleanup is marked in local storage after a successful run so process restarts do not repeat it unless the extension/stale pattern changes; use `PI_COGNITIVE_FORCE_STALE_CLEANUP=1` or `/reasoning-clear-stale` for an explicit cleanup. If local cognitive memory grows large, `/cognitive-prune-memory [--assistant-turns=N]` previews low-value assistant-turn retention and `/cognitive-prune-memory --apply [--assistant-turns=N]` snapshots first, then prunes older assistant-turn episodic memories. If automated verifier reasoning artifacts grow large, `/reasoning-prune-automated [--keep=N]` previews old automated verifier evidence/feedback/failure artifacts and `/reasoning-prune-automated --apply [--keep=N]` snapshots first, then prunes older automated verification triples. Automatic retention runs both after verification and off the session-start hot path when automated verifier evidence exceeds `PI_REASONING_AUTO_PRUNE_AUTOMATED_MAX` (default `240`), keeps `PI_REASONING_AUTO_PRUNE_AUTOMATED_KEEP` (default `120`), snapshots first, and can be disabled with `PI_REASONING_AUTO_PRUNE_AUTOMATED=0`. Snapshots use filesystem copies rather than exporting and reserializing the complete artifact graph. If the trace event log grows large, `/cognitive-prune-trace [--keep=N]` previews trace retention and `/cognitive-prune-trace --apply [--keep=N]` snapshots first, then keeps only the latest trace events.

### Branch recovery, export, and retention

Branch snapshots are recoverable local state, not durable memory exports. New snapshots exclude private `.pi`/environment files, remove transcript/prompt/raw fields and message content, redact/cap strings, enforce `PI_BRANCH_SNAPSHOT_MAX_BYTES`, and use `0600` files under `0700` directories. `/branch-export <id>` emits only lineage, IDs, scores, verifier aggregates, and filesystem counts/fingerprint—never source bodies or cognitive recovery state.

Use `/branch-cleanup-preview` before `/branch-cleanup-apply --yes`, or run `node scripts/maintain-branch-snapshots.js` before the same command with `--apply --yes`. Maintenance revalidates file identity/hash, sanitizes legacy snapshots, hardens permissions, protects checkpoints reachable from live branches and ancestors, and removes only old/overflow unreachable snapshots.

## Persistence safety

Filesystem-backed JSON state has a preflight/read ceiling controlled by `PI_INTEGRATION_STORAGE_MAX_JSON_BYTES` (default 67108864). Writes are size-checked before `JSON.stringify`, written to a temporary file, and atomically renamed. A legacy state file larger than the ceiling is not parsed into the JavaScript heap. On the next successful write it is preserved as `*.oversized-<timestamp>.bak` before a fresh bounded state file replaces it. Runtime Doctor and roadmap reasoning import report/refuse oversized state instead of loading it. Raising the ceiling is an explicit recovery choice, not the normal fix for state growth.

## Reload and stale-process symptoms

Project-local extension edits are loaded by the running Pi process only after `/reload` or a process restart. If a prompt context is missing the `### Runtime version` block, shows duplicate `Reasoning runtime architecture` semantic memory, or emits an empty scaffold, reload and then run:

```text
/reasoning-version
/reasoning-self-test
/reasoning-debug-context
```

`/reasoning-self-test` should report `ok: true`, `renderHasVersionBanner: true`, and `architectureSemanticMemoryDeduped: true`.

Model-facing JSON examples live at:

```text
examples/reasoning-artifact-templates.json
```

## Pi commands

The project-local reasoning runtime extension currently lives at the legacy `.pi/extensions/reasoning-runtime/` path and exposes public artifact commands:

```text
/reasoning-plan [objective]
/reasoning-artifacts [type]
/reasoning-checkpoint [summary]
/reasoning-failures
/reasoning-clear-stale
/reasoning-clear-resolved-validation
/reasoning-clear-private-memory
/reasoning-debug-context [query]
/reasoning-version
/reasoning-self-test
/reasoning-prune [maxAutoScaffold]
/reasoning-prune-automated [--apply] [--keep=N]
/reasoning-export
/reasoning-replay [type]
/branch-export <branch-id>
/branch-cleanup-preview
/branch-cleanup-apply --yes
```

Legacy `/cognitive-status`, `/cognitive-timing`, `/cognitive-prune-memory`, `/cognitive-prune-trace`, `/cognitive-context`, `/cognitive-memory`, `/cognitive-verify`, and `/cognitive-branches` remain available, but their descriptions now refer to the reasoning runtime scaffold instead of internal role cognition.

## Compatibility note

The rename from the legacy `cognitive-automation` directory is complete: the extension lives at `.pi/extensions/reasoning-runtime/`. Runtime state stays under `.pi/cognitive-automation/` and the `PI_COGNITIVE_*` env knobs keep their names so existing configurations and persisted state keep working.

`src/cognitive-architecture.js` is now a compatibility facade. It preserves older imports and model-routing helpers but no longer runs hard-coded planner/executor/verifier cognition. Legacy `orchestration.coordinate()` initializes scaffold artifacts only.
