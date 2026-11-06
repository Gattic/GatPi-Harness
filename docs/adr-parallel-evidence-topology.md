# ADR: Parallel evidence synthesis and topology execution schema v3

Status: accepted for implementation; routing promotion remains evidence-gated

## Context

Pi's topology engine already supported DAG scheduling, typed Roles v2 results, isolated subagents, and explicit aggregation, but every shipped built-in and project recipe was sequential. Fan-in also had only implicit all-edge readiness: an exploratory reducer could not state a quorum, retain failed-worker envelopes, or return a truthful partial result. Normal run rendering hid node and join state behind a large packet.

The desired read-only research pattern is explicit decomposition, orthogonal evidence workers, an independent auditor, and deterministic synthesis. This must not reintroduce hidden planner cognition or weaken mutation, verification, privacy, and rollout boundaries.

## Decision

1. **Model-side reasoning remains canonical.** Models emit public `analysisPlan`, `claims`, `evidenceRefs`, and `auditDecisions`. The harness validates, projects, schedules, records, and reduces those artifacts; it never stores or requests private reasoning.
2. **Topology execution packets use schema v3.** Role contracts and role results remain `role-v2`/schema v2. Existing topology schema-v2 definitions normalize to v3 with `joinPolicy: all`, `partialPolicy: forbid`, and explicit compatibility provenance.
3. **Join policy is node-local.** Supported modes are `all`, `quorum`, `min-success`, and `best-effort`, each normalized to an exact successful-input threshold. All incoming nodes settle before a fan-in decision so dissent and failures cannot race out of the packet.
4. **Partial is not success.** A read-only exploratory topology may use `partialPolicy: report`. A satisfied degraded join marks the run partial. Partial runs remain reliability-ineligible as passes. Unmet joins persist blocked/skipped states and fail the run.
5. **Protected paths require all-success joins.** Mutation, verifier/benchmark, roadmap-gated, memory-writing, and patch-producing nodes reject non-`all` joins. A topology that can mutate cannot enable partial reporting.
6. **Evidence-only context is first class.** It forwards typed plans, claims, evidence references, audit decisions, gaps, actions, coverage, status, and bounded errors. It excludes summaries/pre-merged conclusions, transcripts, scratchpads, private reasoning, and sibling trajectories.
7. **The canonical recipe is manual and read-only.** `parallel-evidence-synthesis` uses one scope planner, four orthogonal workers, one evidence auditor, and a handler-only deterministic coordinator. Topology concurrency is four; live RPC concurrency remains two. The auditor requires three successful workers and receives explicit failed-worker envelopes.
8. **Rendering is metadata-first.** Compact topology/run views show edges, joins, node status, policy, duration, evidence counts, and blocked reasons. Full packets remain available through explicit get/export operations.

## Non-goals

- No four-agent default for routine prompts.
- No hidden or automatic decomposition.
- No majority vote as truth.
- No automatic mutation, patch application, publishing, install, credential, or destructive routing.
- No treating a partial, fallback, confidence score, or reflection as proof.
- No durable storage of prompts, transcripts, private reasoning, secrets, or full file bodies in topology telemetry.

## Compatibility

- Topology schema-v2 definitions and runs remain readable and reliability-eligible when they carry current Roles v2 provenance.
- New definitions are materialized as topology schema v3.
- Role contract/result versions remain unchanged.
- Existing sequential topologies retain `joinPolicy: all` and `partialPolicy: forbid` behavior.
- Rollback is immediate: keep auto-routing in `suggest`, stop invoking the new recipe, and use existing sequential topologies. No persisted-state migration is required.

## Evaluation boundary

Deterministic fixtures establish schema, scheduling, safety, partial truth, and reducer parity only. A preregistered independent cohort of at least 30 exact-version read-only runs is required before any routing-default change. Mutation and publishing remain excluded regardless of research-topology results.
