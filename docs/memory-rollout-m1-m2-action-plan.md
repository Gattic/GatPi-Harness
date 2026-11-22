# M1 → M2 action plan — project memory rollout

Status: effective stage **M1** (operator opt-in; passive candidate M1). M2 requires
`M1 && S1 && R`; M3 additionally requires `SD`. This plan closes the three behavioral
gates and records where the evidence lives.

## Current evidence (2026-11-22, `emit:false`)

| Predicate | Observed | Threshold | Status |
|---|---|---|---|
| S1 explicit saves | 0 in 14d; 14 saves / 3 days / 0 verified in 90d | ≥20 / ≥7 days / ≥0.95 | insufficient |
| R recall quality | 0 `recall.completed` | ≥30 / ≥10 sessions / ≥14 days | insufficient |
| SD shadow agreement | 0 `shadow.outcome` | ≥20 / ≥5 sessions / ≥7 days / ≥0.90 | insufficient |
| D / P / B | passing | — | pass |

## Workstreams

### W1 — Make recall and shadow telemetry reachable (blocks R and SD)

Owner: **Platform/telemetry**. Steps:

1. **F1 — lifecycle-safe subscription.** Call `subscribeRetrieval(ctx)` idempotently from
   `before_agent_start` in `.pi/extensions/trace-observability/index.ts`; today it only
   runs in the `session_start` handler, and the live session's trace has 0
   `session_start` events.
2. **F2 — retain gate payloads under capture=0.** In `src/trace-observability.js`
   `materializeRecord()`, keep the sanitized `payload` for `memory_retrieval`,
   `memory_decision` and `memory_curation` events only. These carry hashes, counts,
   latency and booleans; the privacy posture is unchanged.
3. **F3 — restart and retention.** Restart Pi so the merged modules load; raise
   `PI_TRACE_MAX_TOTAL_BYTES` (`.pi/traces` is ~153 MB against a 128 MB cap, ≈96 MiB
   effective with 0.25 headroom) or reduce `maxAgeDays`.
4. Add tests: memory payload survives `capturePayloads:false` while non-memory payloads
   stay stripped; the retrieval listener attaches without `session_start`.

Acceptance: an ordinary interactive session writes `recall.completed` with
`durationMs`, `returnedHashes`, `outOfScopeCount`, `injected`; the gate reports
`recall-samples-below-minimum` instead of `recall-samples-missing`.

### W2 — Accrue explicit saves (S1)

Owner: **Operator (memory owner)**; verifier checks precision.

1. Use `memory_curator save` (`apply:true`, `explicit:true`) for verified entries only.
   The store already stamps `automatic:false`, `sessionIdHash` and the candidate's
   `verification`; no code change is required.
2. Target ≥21 saves across ≥7 distinct days inside the 14-day window (≈3 per active day),
   every one `verification:"verified"`.
3. Keep precision ≥0.95: a single unverified save in 20 drops precision to 0.95, two
   fail the bar.

Acceptance: S1 pass (≥20 saves, ≥7 days, ≥0.95) — legacy rows are counted by
`automatic !== true`, but they are out of window and unverified.

### W3 — Accrue recall samples (R)

Owner: **Operator** (ordinary sessions) + **Platform** (telemetry).

1. Run ordinary interactive sessions with task recall enabled and payload capture
   retained; do not use headless probes against `/tmp` trace dirs as rollout evidence.
2. Target ≥30 `recall.completed` across ≥10 distinct sessions and ≥14 distinct days,
   all inside the 14-day window.
3. Keep p95 ≤50 ms, citation rate ≥0.40, stale rate ≤0.05, out-of-scope 0, incomplete 0.

Acceptance: R pass. This is the longest lead item (≥14 distinct days), so start on day 1.

### W4 — Enable shadow measurement (SD, M3 prerequisite)

Owner: **Platform**.

1. Shadow outcomes are emitted only when a `shadowed` decision is resolved by a real
   decision on the same `candidateHash`. At M1 with `PI_PROJECT_MEMORY_AUTOMATIC=1`,
   `shadowRecall:false` (shadow authorization requires `!recallAuthorized`), so no
   proposals exist; the last shadowed row is `2026-10-25`.
2. Enable shadow recall at M2, or run an M1 posture without operator auto-recall, so
   proposals and resolutions are recorded.
3. Target ≥20 outcomes across ≥5 sessions / ≥7 days, agreement ≥0.90, 0 invalid payloads.

Acceptance: SD pass (M3 gate).

## Sequencing

| Window | Work |
|---|---|
| Day 0 | Land F1/F2 with tests; restart Pi; raise trace cap; verify one real `recall.completed` with payload |
| Days 1–7 | Operator explicit saves (≥21 verified over ≥7 days); start recall accrual |
| Days 1–14 | Ordinary sessions for recall (≥30 over ≥10 sessions/≥14 days) |
| Day 14 | Re-evaluate with `emit:false`; require S1 **and** R pass → passive M2 candidate |
| After M2 | Operator decides the config change to M2; enable shadow measurement for SD |

M2 is earned passively when `S1` and `R` pass; the config change to M2 is a separate,
explicit operator decision. `C` and `A` remain M4/M5 prerequisites (curation instability
and the verified-precision bar) and are tracked separately.

## Verification commands

```bash
# Gate evaluation (read-only; emit:false)
node -e "
const {projectMemoryRuntimeConfig}=require('./src/project-memory-runtime');
const r=projectMemoryRuntimeConfig(process.cwd(), process.env, {emit:false});
console.log(r.rolloutEvaluation.candidateStage, JSON.stringify(r.rolloutEvaluation.insufficient));
for (const k of ['D','P','B','S1','R','SD','C','A'])
  console.log(k, r.rolloutEvaluation.predicates[k].status, JSON.stringify(r.rolloutEvaluation.predicates[k].reasons));
"

# Focused telemetry tests
node --test tests/memory-rollout-telemetry.test.js tests/project-memory-rollout-passive.test.js \
  tests/memory-effectiveness-report.test.js tests/project-memory-recall-telemetry.test.js \
  tests/project-memory-telemetry-events.test.js tests/project-memory-decision-provenance.test.js

# Full deterministic suite (needed for D)
bash scripts/check-all.sh
```

The soak fixture (`node scripts/soak-memory-telemetry.js`) checks tooling end-to-end and
is labeled soak evidence; it never substitutes for rollout evidence.

## Where to record

- **This plan:** `docs/memory-rollout-m1-m2-action-plan.md` (canonical).
- **Follow-up tracker:** `docs/memory-rollout-followups-2026-11-22.md` (F1–F7 status,
  weekly updates).
- **Gate definitions/thresholds:** `docs/memory-rollout-gates-passive-telemetry.md`
  §5.4 (S1), §5.5 (R), §5.6 (SD).
- **Runtime evidence (gitignored):** `.pi/project-memory/decisions.jsonl`,
  `.pi/traces/`, `.pi/test-runner/full-latest.json`,
  `.pi/privacy-guard/privacy-baseline.json`, `.pi/memory-effectiveness/*.json`.
- **Cadence:** update the tracker weekly with the `emit:false` evaluation output; record
  the final sign-off in the tracker's status table when S1 and R pass.

## Owners and risks

| Role | Responsibility |
|---|---|
| Operator (memory owner) | explicit saves, env/config changes, final stage decision |
| Platform/telemetry | F1/F2/F3, restart, trace retention, tests |
| Verifier | runs the evaluation, checks thresholds, records evidence |

Risks: the running process predates the recall emitter (restart required); capture=0
strips payloads (F2); trace retention prunes evidence at the current cap (F3); shadow
measurement is inert at M1 with auto-recall (W4); the 14-day window means S1/R cannot be
rushed once accrual starts.
