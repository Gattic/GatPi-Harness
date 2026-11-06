# Roadmap remediation release scorecard

**Generated:** 2026-07-27T10:22:37.015Z
**Source cohort:** `roadmap-v3-2026-07-27-e78415c0fb9b35c1`
**Fixture SHA-256:** `c9f1e997091d46a722056766777d62826846bb86b9501cf44869ab9ea2873bd8`
**Decision:** **no-go-deferred**

## Claim boundary

Historical evidence remains design/regression evidence. It is not merged into the exact-version field cohort and cannot authorize rollout. Raw session content is not read or stored by this report.

## Deterministic gates

- Status: **pass**
- Invariant violations: 0
- Successful-operation application violations: 0
- Mutation character reduction: 88.50%
- Mutation p99 characters: 1268
- Privacy forbidden-value findings: 0

## Exact-version field cohort

- Independent interactive sessions: **0/30**
- Interactive operations: 0
- Error rate: n/a
- Valid add-subtask attempts: 0
- Invalid add-subtask requests excluded: 0
- Valid add-subtask success rate: n/a
- Mutation result p99: n/a
- Active-session exclusion: not requested for this offline report

## Historical baseline (separate)

- Eligible interactive sessions: 91
- Adoption: 67.00%
- Tool error rate: 1.46%
- Historical result characters: 2,770,000
- Large-roadmap median mutation result: 21,618 characters

## Gates

- Deterministic: **pass**
- Independent field sample: **blocked-insufficient-sample**
- Field reliability: **blocked-insufficient-sample**
- Active-session exclusion: **blocked-insufficient-sample**
- Telemetry privacy: **pass**

## Blockers

- exact-version cohort has 0/30 independent interactive sessions

Rollback remains available through `PI_ROADMAP=0`, schema-compatible archived state, and bounded explicit show/export.
