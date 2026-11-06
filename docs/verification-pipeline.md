# Verification-gated execution pipeline

Pi harness verification is a core execution primitive, not a post-processing step. The `VerifiedExecutionPipeline` owns patch application, computes differential impact, schedules only impacted validators, enforces policy, writes proof evidence, rolls back failed edits, and feeds results to agents or memory systems.

## Architecture

```text
patch candidate
  -> apply under pipeline control
  -> differential impact analysis
  -> dependency-aware verification graph
  -> policy engine
  -> proof/evidence store + metrics
  -> feedback sinks (planner/coder/memory)
```

Core pieces live in `src/verification-pipeline.js`:

- `Verifier`: abstraction for compile, lint, unit, integration, static analysis, security, benchmark, formatting, and configured visual validators.
- `VerificationGraph`: dependency-aware graph that selects impacted validators and runs safe levels in parallel.
- `VerificationCache`: validator-result cache keyed by verifier config, change fingerprint, impacted files, impact categories, and API changes.
- `PolicyEngine`: rejects unverified edits, benchmark regressions, public API/architecture violations, and unsafe patterns.
- `EvidenceStore`: durable proof artifacts under `.pi/verification-evidence` by default.
- `VerificationMetrics`: pass rates, retry rates, flaky validators, regression frequency, and proof confidence inputs.
- `VerifiedExecutionPipeline`: mandatory gate that applies, verifies, rolls back, retries alternatives, and emits feedback.

## Mandatory gates

A production pipeline should register at least one verifier for each kind:

- `compile`
- `lint`
- `unit`
- `integration`
- `static-analysis`
- `security`
- `benchmark`
- `format`

If any required kind is missing, the pipeline rejects the edit before verification. `visual` is a valid verifier kind but is not part of the default mandatory-kind set; it becomes applicable through configured cases and becomes a provider gate only when explicitly required.

## Visual provider

Verification Center plans configured visual cases before execution. Ready cases run as a `visual` verifier. Missing optional backends remain degraded advisory; `requiredProviders: ["visual"]` fails before running verifiers when no applicable ready provider exists. A mismatch, stale baseline, malformed artifact, provider failure, or baseline/tree mutation fails the proof.

Visual proof records contain hashes, artifact references, dimensions, provider/config/source identity, thresholds, and bounded metrics. Captured images, frame lines, DOM/accessibility bodies, selectors, URLs, and raw provider output are excluded. See [Visual Verification Provider](visual-verification.md).

## Differential verification

The built-in impact analyzer reports:

- changed files
- semantic changes
- dependency graph impact
- public API additions/removals
- security/performance/architecture categories
- behavioral risk score

Validators declare `files`, `impacts`, and `dependsOn`; only relevant validators and their dependencies are rerun.

A public API removal fails the architecture policy unless the change owner approved it. `verify({ acknowledgedPublicApiRemovals })` (Verification Center: `input.acknowledgedPublicApiRemovals`) takes `{ file, symbol, reason }` entries; `reviewPublicApiRemovals` matches each to a listed removal by exact file and symbol. A removal without an approval, or beyond the bounded impact details, still fails, and so does an approval that is blank, duplicated or matches no listed removal, so approvals cannot outlive their change or pre-approve another. The matched approvals are recorded in the evidence as `acknowledgedPublicApiRemovals`; every other policy is unaffected. Verification Center accepts its `input` as an object or as a JSON-object string (tool calls deliver it as a string) and rejects any other input rather than ignoring its overrides (`tests/verification-center-input.test.js`).

## Failure handling

`execute()` snapshots touched files before applying. On verification or policy failure it calls the supplied rollback callback, or restores the snapshot. Alternative patch branches can be supplied for safe retry.

## Evidence

Every successful run emits a proof document containing:

- bounded verifier outputs and artifact references
- metadata-only visual comparisons when configured
- benchmark deltas
- coverage deltas
- impact analysis
- policy decisions
- confidence metric
- metrics snapshot

The same evidence object is sent to feedback sinks for planner agents, coder agents, and memory systems.
