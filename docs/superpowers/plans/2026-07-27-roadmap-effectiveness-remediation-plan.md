# Roadmap effectiveness and plan-execution remediation plan

**Date:** 2026-07-27
**Status:** Implemented through deterministic gates; rollout is `no-go-deferred` pending the independent 30-session exact-version cohort
**Scope:** Pi roadmap state, model tool, planning-role contract, topology prompts, telemetry, tests, and rollout evidence
**Canonical roadmap:** `roadmap_0d58d387877e`

## Objective

Make Roadmap remain correct and useful while becoming evidence-backed, action-oriented, and cheap enough for large multi-session plans. Every executable plan must compile into one predictable recursive roadmap shape:

- each phase or milestone is a root roadmap task;
- each phase/milestone owns one nested subtask roadmap;
- the nested roadmap contains that phase's goals;
- temporary workflows such as commit or verification nest beneath an explicitly actionable goal;
- planner roles emit the public hierarchy, but only the parent session mutates roadmap state.

This plan replaces the previous extension-effectiveness roadmap. Historical roadmap state remains recoverable from session evidence; no old state is silently reinterpreted as current-version field evidence.

## Evidence baseline

The privacy-safe lifetime investigation excluded the active investigation session and found:

- 1,502 Pi session JSONL files (779,486,656 bytes; 0.726 GiB), with zero invalid or oversized rows;
- every session file mode `0600` and every session directory mode `0700`;
- 91 classified interactive sessions eligible since Roadmap's birth;
- 61 Roadmap-adopting sessions (`67.0%` adoption);
- 1,923 `roadmap_update` calls, 1,922 results, and 28 errors (`1.46%`); every error recovered on the next roadmap call;
- 275 unique observed root snapshots, 252 complete (`91.6%`) and 259 settled (`94.2%`);
- zero independently detected state-invariant or successful-operation application violations;
- only `2.47%` of verified transitions supplied an evidence id, and only `3.5%` of final verified items retained linked evidence;
- 2.77 million historical roadmap-result characters (roughly 693k tokens at four characters/token), with 82% p90 line overlap between adjacent results;
- one current 100-item roadmap emitted 3.20 million cumulative result characters (roughly 799k tokens), with a 21,618-character median mutation result;
- the active pointer selected a phase whose only unresolved child was blocked, causing an unrelated commit workflow to nest under stale scope;
- 28 historical `add_subtask` attempts produced only 5 successes during the schema/runtime transition, although all failures recovered and every success preserved the root.

The exact current-version cohort is still insufficient for lifecycle authority. Lifetime evidence is useful for design and regression selection, not for silently promoting the new runtime.

## Non-negotiable boundaries

1. Roadmap state remains public task/progress state, never private reasoning.
2. Telemetry stores no titles, notes, prompts, paths, evidence bodies, raw arguments, or raw results.
3. Planner roles remain read-only and cannot mutate the parent's roadmap.
4. `done` and `verified` remain distinct.
5. A new exact-version cohort starts whenever measurement-affecting source or configuration changes.
6. Historical and exact-version metrics are reported separately.
7. Blocked or insufficient-data gates are never relabeled as passing.
8. Existing roadmap state is migrated or archived without destructive deletion.

## Plan execution contract

A planner may return the following bounded public field in its typed role result:

```json
{
  "roadmapPlan": {
    "title": "Roadmap effectiveness remediation",
    "milestones": [
      {
        "title": "Phase 0 — Baseline",
        "goals": ["Freeze evidence", "Set acceptance bars"]
      }
    ]
  }
}
```

The parent session applies this hierarchy through one `roadmap_update` `start` call, or an explicitly authorized `replace` call. Milestones become root tasks and goals become items in one nested roadmap per milestone. The parent confirms the resulting hierarchy before implementation. A child planner never receives roadmap mutation authority.

If a plan lacks phases/milestones, the parent may treat its ordered top-level work packages as milestones, but it must still provide at least one goal per milestone. Temporary commit, repair, and verification workflows use `add_subtask` with an explicit actionable parent.

## Success bars

### Structural correctness

- zero state-invariant violations in unit, behavioral RPC, migration, and fixed field replay fixtures;
- zero successful-operation application mismatches;
- 100% parent-root preservation for non-replacement plan starts and nested workflows;
- 100% milestone-to-task and goal-to-nested-item parity.

### Operational reliability

- roadmap tool infrastructure/domain error rate below `1%` over at least 30 independent exact-version interactive sessions;
- `add_subtask` success at least `99%` when its parent is current and actionable;
- every stale, invalid, missing-parent, persistence, and evidence failure is typed;
- every error outcome remains recoverable without state loss.

### Actionability

- zero active pointers whose only unresolved descendants are blocked, paused, shelved, or otherwise nonactionable;
- unrelated objectives never auto-nest beneath stale or blocked scope;
- blocked-only roadmaps have an explicit close, shelve, or resume decision;
- final reports expose unresolved actionable and nonactionable counts.

### Evidence accuracy

- `verified` requires current linked verifier evidence, or an explicit unsubstantiated override that is not counted as verified evidence;
- 100% of substantiated verified items retain a valid evidence binding;
- stale evidence cannot verify changed item content;
- batch/backfill transitions are visible separately from work-backed transitions;
- zero completion claims that hide unresolved actionable work in fixed report-consistency fixtures.

### Context efficiency

- normal mutation results remain at or below 2,500 characters at p99 on the fixed large-roadmap corpus;
- at least 80% reduction in total mutation-result characters versus the frozen baseline;
- zero exact full-state repeats after ordinary mutations;
- full output appears only on explicit show/export/paged requests;
- compact widget and status rendering remain unchanged or improve.

### Privacy and persistence

- state directory/file modes remain `0700`/`0600`;
- atomic no-follow writes preserve the previous valid state on interruption;
- telemetry serialization contains none of the forbidden content classes;
- active-session exclusion is exact and proven for field reports.

## Phase 0 — Freeze evidence and success contracts

### Goals

1. Publish lifetime and exact-version baselines with explicit claim boundaries.
2. Define correctness, usefulness, accuracy, context-cost, and actionability metrics.
3. Freeze the bars above and require minimum independent samples.
4. Preserve aggregate-only raw-session analysis and exact active-session exclusion.

### Work

- Add a dedicated aggregate roadmap field report rather than deriving lifecycle authority from generic tool counts alone.
- Record the baseline corpus/version identifiers and the current fixed large-roadmap fixture hash.
- Preserve the exact repeated-task cohort as a diagnostic fixture without storing prompts.
- Define historical, current-version, deterministic, and live-field evidence classes.

### Exit gate

A reproducible baseline report states sample sizes, source/config versions, privacy guarantees, and all frozen bars. It does not grant rollout authority.

## Phase 1 — Compile plans into roadmap milestones and goals

### Goals

1. Define one public `roadmapPlan` schema with ordered milestones and bounded goals.
2. Teach the planner role to emit it while remaining read-only.
3. Add one atomic roadmap operation that maps milestones to tasks and goals to nested items.
4. Update built-in and project topology prompts while preserving legacy role results.
5. Instantiate every newly executed plan with this hierarchy before implementation starts.

### Work

- Extend `src/role-result-schemas.js` with optional bounded `roadmapPlan` normalization and validation.
- Update `src/role-contracts.js` so executable planner results carry the hierarchy; advisory legacy results remain valid.
- Update primary planning topology prompts.
- Add `milestones` input to `roadmap_update` `start`, `replace`, and `add_subtask` operations.
- Compile the complete hierarchy atomically in `.pi/extensions/roadmap/roadmap-state.js`.
- Update docs and behavioral tests.

### Exit gate

Fixed role and roadmap tests prove one-call milestone/goal parity, parent-only mutation, bounded schema validation, backward compatibility, and explicit replacement safety.

## Phase 2 — Make roadmap mutations compact and bounded

### Goals

1. Return only the changed item/subroadmap, progress summary, and active path after mutations.
2. Reserve full roadmap rendering for explicit show/export operations.
3. Add character/item bounds and focused or paged output.
4. Measure result size directly.
5. Meet the 80% reduction and 2,500-character p99 bars.

### Work

- Introduce a schema-versioned mutation delta envelope.
- Keep complete state in tool `details` only when bounded and explicitly requested; otherwise return identifiers and counts.
- Add focused subtree and pagination parameters to show/export.
- Prevent duplicate full-state text in both `content` and `details`.
- Add 10-, 50-, 100-, and 500-item regression fixtures.

### Exit gate

Large-roadmap tests meet all compactness bars without losing the changed item, active scope, blockers, or linked evidence.

## Phase 3 — Make lifecycle and active scope actionable

### Goals

1. Separate actionable from blocked, paused, shelved, and terminal state.
2. Never call a nonactionable umbrella item active.
3. Add close, shelve, resume, and archive transitions without deleting history.
4. Require explicit parent selection when automatic nesting is ambiguous or stale.
5. Detach a nonactionable project roadmap before unrelated objectives begin.

### Work

- Define lifecycle/actionability semantics independently from completion counts.
- Replace the fallback that nests under the last blocked item.
- Return a typed `ROADMAP_PARENT_REQUIRED` result when no actionable parent exists.
- Add project-root close/shelve metadata and a private archive index.
- Make next-user-input behavior distinguish complete, nonactionable, and still-actionable roadmaps.

### Exit gate

Blocked-only and stale-scope fixtures produce no false active pointer and cannot capture unrelated temporary work.

## Phase 4 — Make completion and verification evidence-backed

### Goals

1. Require linked current evidence for substantiated verification.
2. Keep done distinct from verified and report unsupported claims.
3. Bind evidence to current item identity/content.
4. Surface batch/backfill updates separately.
5. Check final-report claims against unresolved roadmap state.

### Work

- Add evidence-binding schema and current-item fingerprint.
- Reject stale or absent proof for ordinary `verified` transitions.
- Add an explicit `verified-unsubstantiated`/override outcome without treating it as proof.
- Record transition provenance categories without content.
- Add a final-report roadmap summary helper for completion handoffs.

### Exit gate

All substantiated verified fixtures carry current evidence; unsupported verification is visible and never enters the verified-evidence numerator.

## Phase 5 — Harden persistence and privacy-safe telemetry

### Goals

1. Make persistence atomic, private, no-follow, and recoverable.
2. Emit metadata-only operation/delta/depth/actionability/evidence/error counters.
3. Separate lifetime and exact-version evidence.
4. Measure opportunity, adoption, completion, context cost, and correction rates.
5. Prove forbidden content never enters telemetry.

### Work

- Write state through a private temporary file plus atomic rename after identity/confinement checks.
- Preserve a bounded last-known-good state packet.
- Add schema-versioned roadmap telemetry with fixed enums and aggregate reports.
- Add explicit eligible-opportunity denominators.
- Extend Privacy Guard and storage conformance tests.

### Exit gate

Crash/persistence fixtures retain one valid state, permissions remain private, and telemetry/privacy scans report zero forbidden fields or values.

## Phase 6 — Verify, pilot, and decide rollout

### Goals

1. Run unit, behavioral RPC, integration, privacy, and large-roadmap regressions.
2. Prove zero invariant and application violations.
3. Meet compactness, actionability, evidence, and reliability bars.
4. Collect at least 30 independent exact-version interactive sessions.
5. Publish a sample-size-aware scorecard and preserve rollback controls.

### Work

- Run focused checks after every phase and the integrated suite after source changes stop.
- Freeze source/config/schema versions.
- Exclude the active audit session exactly.
- Compare deterministic and live evidence without mixing cohorts.
- Keep `PI_ROADMAP=0` and schema-compatible state rollback available.

### Exit gate

Ship only when every deterministic/privacy gate passes and the independent field sample meets the frozen bars. Otherwise publish `partial`, `no-go`, or `no-go-deferred` with exact blockers.

## Verification matrix

| Surface | Required verification |
|---|---|
| Plan compiler | milestone/goal parity, bounds, invalid-shape rejection, nested parent preservation |
| Planner role | typed optional hierarchy, legacy compatibility, read-only policy, topology prompt coverage |
| Mutation protocol | delta completeness, p99 size, no repeated full state |
| Lifecycle | blocked-only, shelved, resumed, stale-parent, unrelated-objective cases |
| Evidence | valid, missing, stale, override, batch/backfill, report consistency |
| Persistence | atomicity, no-follow, permission, malformed/interrupt recovery |
| Telemetry | aggregate accuracy, exact cohort, active exclusion, forbidden-content serialization |
| Integration | extension load, isolated RPC, full suite, Privacy Guard, final diff and Git verification |

## Rollback

- `PI_ROADMAP=0` disables the extension.
- State migrations retain the previous version and last-known-good packet until verified.
- Compact mutation envelopes keep explicit show/export compatibility.
- `roadmapPlan` remains optional for direct/advisory planner results; primary executable implementation topologies require it, and legacy advisory results continue to validate.
- No automatic planner role or topology execution is introduced.

## Claim boundary

This plan, implementation, and deterministic verification establish the remediation contract and fixed regression evidence. They do not prove the new runtime effective in independent field use. The lifetime corpus supports the need and gives regression targets; only the later exact-version independent cohort may authorize lifecycle or default-behavior changes. Until at least 30 independent interactive sessions satisfy the frozen reliability bars, the rollout decision remains `no-go-deferred` rather than silently treating deterministic or historical evidence as live authority.

## Implementation outcome — 2026-07-27

- Roadmap schema v3, mutation-envelope schema v1, and telemetry schema v1 are implemented.
- The fixed 10/50/100/500-item corpus hash is `c9f1e997091d46a722056766777d62826846bb86b9501cf44869ab9ea2873bd8`.
- Deterministic fixtures observed zero invariant/application violations, an `88.78%` mutation-character reduction, a `1,237`-character mutation p99, and zero forbidden telemetry-value findings.
- The complete repository check, 47 isolated extension RPC probes, full-fleet model smoke, focused Semgrep security/default configs, and project-local Roadmap Privacy Guard scan passed.
- The exact source cohort is `roadmap-v3-2026-07-27-92134b46a13351b3`.
- The independent exact-version cohort is `0/30`; field reliability therefore remains blocked and the rollout decision is `no-go-deferred`.
- Reproducible artifacts: `docs/roadmap-deterministic-verification.json`, `docs/roadmap-field-report.json`, `docs/roadmap-release-scorecard.json`, and `docs/roadmap-release-scorecard.md`.
