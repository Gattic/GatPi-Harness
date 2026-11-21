# Memory rollout gates — passive telemetry specification

**Status:** approved design, not yet implemented
**Supersedes:** artifact gates in `src/memory-effectiveness.js`, `src/memory-effectiveness-privacy.js`,
`src/memory-effectiveness-reviewed-gold.js`, and the exact-version cohort clause in
`src/project-memory-rollout.js`.

## 1. Purpose and principles

Stages M0→M5 advance only on evidence the harness emits while working: traces, decision
logs, diagnostics, and recall events. No signing keys, no per-case human attestations, no
reviewed-gold artifacts, no backup-provenance evidence.

Principles:

1. **Passive only.** Every input is a file the runtime already writes during normal sessions.
2. **Fail closed.** Missing data, missing fields, or malformed events yield `insufficient`,
   never a pass.
3. **Content-addressed privacy baseline.** Pre-instrumentation findings are grandfathered once;
   only *new* record-format highs can block.
4. **Shadow first.** Each stage is measured while inactive, then promoted. No stage requires
   evidence that can only exist after it is enabled.
5. **Monotonic with hysteresis.** Promotion is immediate on the first passing evaluation;
   demotion requires two consecutive failing evaluations.
6. **Operator control is a hold, not a proof.** `PI_PROJECT_MEMORY_HOLD=<stage>` pins a ceiling.
   It can only lower the effective stage, never raise it.

## 2. Data sources

| Source | Path | Fields used |
|---|---|---|
| Traces | `.pi/traces/*.jsonl` | `category`, `name`, `session_id`, `timestamp`, `payload`, `implementationRevision` |
| Recall events | trace `category:"memory_retrieval"` | `name` ∈ `recall.started`/`recall.completed`/`recall.cache_hit`/`recall.failed`; payload per §3 |
| Shadow decisions | trace `category:"memory_decision"` | `name` ∈ `shadow.proposed`/`shadow.outcome`; payload `agreed`, `applied`, `proposalHash` |
| Curation | trace `category:"memory_curation"` | `name:"curation.completed"`; payload `outcome` ∈ `success`/`timeout`/`error` |
| Decisions | `.pi/project-memory/decisions.jsonl` | `action`, `verification`, `automatic`, `sessionIdHash`, `evidenceIds`, `at`, `decisionId` |
| Diagnostics | `.pi/project-memory/diagnostics.jsonl` | `kind`, `at`, `stage`, `scanned`, `candidateHashes`, `reasonCounts`, `vaultReady`, `diagnosticOnly`, `sanitized` |
| Tests | `.pi/test-runner/latest.json` | `ok`, `status`, `runs[].exitCode`, `generatedAt`, `selection.sourceRevision` |
| Privacy scan | in-process `scan()` | `findings[]` (`file` hash, `severity`, `pattern`), `permissionPosture.compliant` |

Retention: all windows are **trailing 14 days**; records older than 30 days are ignored.

## 3. Instrumentation contract

These fields must exist for the corresponding stage to be evaluable. Absence is
`insufficient`, not a pass.

| Field | Emitted by | Required for |
|---|---|---|
| `implementationRevision` on every trace event and session header | trace writer | all stages |
| `payload.durationMs`, `payload.candidateCount`, `payload.returnedCount`, `payload.returnedHashes[]`, `payload.outOfScopeCount`, `payload.injected` on `recall.completed` | recall path | M2 |
| `payload.agreed`, `payload.applied`, `payload.proposalHash` on `shadow.outcome` | candidate path | M3 |
| `payload.outcome` on `curation.completed` | curation path | M4, M5 |
| `automatic` (boolean) and `sessionIdHash` (sha256 prefix) on each decision record | decision writer | M2, M5 |
| `sanitized` (boolean) on record-format write diagnostics | write path | M0 |
| `evidenceIds` populated with recalled handle hashes actually cited | decision writer | M2 |

`implementationRevision` must be the same content hash produced by
`currentMemorySourceEvidence()` so trace attribution and scorecard identity cannot drift.

## 4. Common evaluation model

- **Window:** trailing 14 days ending at `evaluatedAt`. Records outside the window are ignored.
- **Cadence:** once at session end, and nightly. Each run appends one `rollout.evaluated` trace
  event with `stage`, `predicates`, and `insufficient[]` for auditability.
- **Sample minimums** are per stage and must be met inside the window; below minimum the stage
  is `insufficient`.
- **Hysteresis:** a stage is demoted only after **two consecutive** evaluations fail the same
  predicate. A single failing evaluation logs a warning and changes nothing.
- **Effective stage** = the highest stage whose predicate and all lower predicates pass, capped
  by `PI_PROJECT_MEMORY_HOLD` if set.

## 5. Metric definitions

Let `W` be the 14-day window, `now` the evaluation time.

### 5.1 Deterministic `D`
From the full-suite record `.pi/test-runner/full-latest.json` (written by the full profile only;
`.pi/test-runner/latest.json` is a focused run and is not admissible):

```
D = ok === true
    && status === "succeeded"
    && failed === 0
    && testFiles >= discoveredTestFiles
    && now - Date.parse(generatedAt) <= 7 days
    && sourceRevision === implementationRevision
```

Stale test evidence (older than 7 days), a partial run, or a revision mismatch is
`insufficient`.

### 5.2 Permissions `P`
```
P = scan().permissionPosture.compliant === true
```

### 5.3 Privacy baseline `B`
Baseline file `.pi/privacy-guard/privacy-baseline.json` (§6) stores `baselineAt`,
`recordFileHashes[]` (sha256 of every `.json`/`.jsonl` file flagged at baseline),
`codeHighHandles[]`, and `counts`.

```
RECORD = /\.(json|jsonl)$/i
newRecordHighs = findings.filter(f =>
    f.severity === "high"
    && RECORD.test(f.file)
    && !baseline.recordFileHashes.includes(sha256(f.file))
).length

sanitizerBypasses = diagnostics
    .filter(d => d.kind === "write" && d.at >= baseline.baselineAt && d.sanitized === false)
    .length

B = newRecordHighs === 0 && sanitizerBypasses === 0
```

Code-file highs (`.js`, `.md`, `.diff`, …) are **never** part of `B`. They are reported as an
advisory backlog with provenance (`high-provenance-*.json`) and cannot block promotion.

### 5.4 Explicit save precision `S1`
```
saves   = decisions in W where action === "saved" && automatic === false
S1 = saves.length >= 20
     && observedDays(saves) >= 7
     && verified(saves) / saves.length >= 0.95
```
`verified(save)` means `verification === "verified"`.

### 5.5 Recall quality `R` (shadow or injected)
From `recall.completed` events in `W`:

```
completions = events where payload.injected === false   // shadow at M1
              (payload.injected === true at M2+)
sessions    = distinct session_id with >= 1 completion
days        = distinct UTC dates among completions

R1 latency:     p95(completions.payload.durationMs) <= 50
R2 scope:       completions.every(c => c.payload.outOfScopeCount === 0)
R3 citation:    citedSessions / sessions >= 0.40
R4 staleness:   supersededWithin7d(returnedHashes) / totalReturnedHashes <= 0.05
R  = completions.length >= 30 && sessions >= 10 && days >= 14 && R1 && R2 && R3 && R4
```

Definitions:

- `citedSessions` = sessions where a `recall.completed` occurred and a **later** decision in
  the same `sessionIdHash` has `evidenceIds ∩ returnedHashes ≠ ∅`.
- `supersededWithin7d` = returned handles whose store entry was superseded (a decision with
  `action:"superseded"` referencing the same handle) within 7 days after the recall.

Adoption bar is **0.40**: recall frequently informs work without producing a save, so a
citation rate near 1.0 would be unachievable and would reward recall that manufactures
decisions. 0.40 is high enough that random injection cannot reach it.

### 5.6 Shadow decision agreement `SD`
```
outcomes = shadow.outcome events in W with payload.applied === false
SD = outcomes.length >= 20
     && distinct sessions >= 5
     && observedDays(outcomes) >= 7
     && agreed(outcomes) / outcomes.length >= 0.90
```

### 5.7 Curation `C`
From diagnostics `kind === "settle"` in `W`:

```
previews = settles in W
C1 volume:      previews.length >= 4 && observedDays(previews) >= 14
C2 stability:   consecutivePreviews.every((prev, cur) =>
                    sortedJson(prev.candidateHashes) === sortedJson(cur.candidateHashes))
C3 accounting:  fraction of previews where sum(reasonCounts.values()) === scanned >= 0.95
C4 diagnostic:  previews.every(p => p.diagnosticOnly === true && p.vaultReady === true)
C  = C1 && C2 && C3 && C4
```

### 5.8 Automatic save precision `A`
```
autos = decisions in W where action === "saved" && automatic === true && applied === true
A1 volume:      autos.length >= 30 && sessions >= 10 && days >= 14
A2 precision:   verified(autos) / autos.length >= 0.98
A3 curation:    curationSuccessRate >= 0.90
A4 timeout:     curationTimeoutRate <= 0.10
A  = A1 && A2 && A3 && A4
```
`curationSuccessRate` and `curationTimeoutRate` come from `curation.completed` events in `W`
(`outcome:"success"` / `outcome:"timeout"` over all curation outcomes).

## 6. Stage definitions

Each stage lists its **shadow measurement** (what accrues while the stage is inactive) and its
**promotion predicate** (exact pass criteria). A stage is promoted only when its predicate and
every lower predicate pass in the same evaluation.

### M0 — baseline reads and diagnostics

| | |
|---|---|
| Active controls | reads, diagnostics |
| Shadow measurement | none needed |
| Promotion predicate | `D && P && B` |
| Insufficient behavior | any missing input → stage stays M0 |

M0 is the only stage that can be entered without runtime history. It requires a passing
deterministic suite, compliant permissions, and zero new record-format highs since baseline.

### M1 — explicit saves

| | |
|---|---|
| Active controls | explicit writes (`PI_PROJECT_MEMORY_WRITES=1`) |
| Shadow measurement | explicit save quality accumulates |
| Promotion predicate | `M0 && explicit writes enabled` |
| Operator authority | `PI_PROJECT_MEMORY_STAGE=M1` + `PI_PROJECT_MEMORY_WRITES=1` (today's opt-in) |

M1 carries no telemetry bar beyond M0. It is the operator-consented stage where the first real
memory data exists. Save *quality* is not an M1 bar; it is a prerequisite of M2.

### M2 — task recall injection

| | |
|---|---|
| Active controls | recall injection (`payload.injected === true`) |
| Shadow measurement | `recall.completed` with `injected === false`, plus explicit saves |
| Promotion predicate | `M1 && S1 && R` |
| Required samples | ≥ 30 recall completions, ≥ 10 sessions, ≥ 14 days; ≥ 20 explicit saves over ≥ 7 days |
| Bars | p95 ≤ 50 ms · out-of-scope 0 · citation rate ≥ 0.40 · stale rate ≤ 0.05 · explicit save precision ≥ 0.95 |

Shadow recall runs at M1: the recall path computes and logs candidates but injects nothing.
This is what makes M2 reachable from ordinary sessions rather than from a signed gold artifact.

### M3 — candidate capture (shadow decisions)

| | |
|---|---|
| Active controls | candidate capture written to the review queue |
| Shadow measurement | `shadow.outcome` with `applied === false` at M2 |
| Promotion predicate | `M2 && SD` |
| Required samples | ≥ 20 shadow outcomes, ≥ 5 sessions, ≥ 7 days |
| Bars | agreement ≥ 0.90 |

### M4 — curation and review queue

| | |
|---|---|
| Active controls | curation writes, review-queue writes, Hermes curation |
| Shadow measurement | diagnostic-only curation previews at M3 |
| Promotion predicate | `M3 && C` |
| Required samples | ≥ 4 previews over ≥ 14 days |
| Bars | candidate stability 1.0 · resolution accounting ≥ 0.95 · 0 scheduled mutations · vault ready |

### M5 — automatic verified upserts

| | |
|---|---|
| Active controls | automatic verified upserts |
| Shadow measurement | proposed-but-not-applied automatic saves at M4 (`automatic:true, applied:false`) |
| Promotion predicate | `M4 && A && B` |
| Required samples | ≥ 30 automatic saves, ≥ 10 sessions, ≥ 14 days |
| Bars | auto precision ≥ 0.98 · curation success ≥ 0.90 · timeout ≤ 0.10 · zero new record-format highs |

## 7. Grandfather baseline

Written once, at implementation time, to `.pi/privacy-guard/privacy-baseline.json`:

```json
{
  "schemaVersion": 1,
  "kind": "privacy-baseline",
  "baselineAt": "2026-11-21T…Z",
  "sourceRevision": "content:…",
  "counts": { "actionable": 191, "high": 17, "medium": 174 },
  "recordFileHashes": ["sha256:…"],
  "codeHighHandles": ["privacy_…"],
  "permissionPostureCompliant": true,
  "note": "Pre-instrumentation findings are grandfathered; only new record-format highs gate."
}
```

Rules:

- A finding is **new** only if its file is a record format and that file's sha256 is absent from
  `recordFileHashes`.
- Grandfathered findings are never re-reviewed to satisfy a gate.
- The advisory backlog is reported separately and may be burned down at any time without
  affecting stage eligibility.
- The baseline is rewritten only when the grandfather list changes, with `baselineAt` advancing
  and the old file retained as `privacy-baseline-<timestamp>.json`.

## 8. Promotion and demotion algorithm

```
evaluate(now):
  window = [now - 14d, now]
  D  = deterministic(window)
  P  = permissions()
  B  = privacyBaseline()
  S1 = explicitSavePrecision(window)
  R  = recallQuality(window)
  SD = shadowAgreement(window)
  C  = curation(window)
  A  = automaticSavePrecision(window)

  predicates = { M0: D && P && B,
                 M1: D && P && B,
                 M2: D && P && B && S1 && R,
                 M3: D && P && B && S1 && R && SD,
                 M4: D && P && B && S1 && R && SD && C,
                 M5: D && P && B && S1 && R && SD && C && A }

  candidate = highest stage whose predicate and all lower predicates are true

  if candidate > effective:                 # promotion: immediate
      effective = candidate; consecutiveFailures = 0
  else if candidate < effective:            # demotion: hysteresis
      consecutiveFailures += 1
      if consecutiveFailures >= 2: effective = candidate; consecutiveFailures = 0
  else:
      consecutiveFailures = 0

  effective = min(effective, stageIndex(PI_PROJECT_MEMORY_HOLD))
  emit trace "rollout.evaluated" { stage: effective, predicates, insufficient: [...] }
```

Rules:

- `insufficient` metrics are `false` predicates, never `true`.
- A stage never promotes on data that lacks its required instrumentation fields.
- `PI_PROJECT_MEMORY_HOLD` may only lower the effective stage.
- Every evaluation is appended to the trace log so stage history is auditable from telemetry
  alone.

## 9. What this removes

| Removed | Replaced by |
|---|---|
| `src/memory-effectiveness-reviewed-gold.js` + signing key + 12 per-case reviews | production recall metrics (`R`) |
| `.pi/privacy-guard/rollout-evidence.json` regeneration, `--backup-root`, backup coverage | `B` (content-addressed baseline + sanitizer bypass count) |
| Human review of the 191-candidate backlog | grandfathered baseline; advisory backlog only |
| `exactVersionFieldQualified` cohort attestation (`cohortId`, `evidenceClass`) | `implementationRevision` stamped on trace events, aggregated from traces |
| `realFixtureCurationQualified` declared evidence class | `C` from diagnostic-only curation previews |
| `PI_REVIEWED_GOLD_*` environment contract | none |
| `.pi/roadmap/active.json` as an apply blocker | removed from the remediation path; repair or delete independently |

Kept: `tests/fixtures/memory-effectiveness/manifest.json` as a deterministic smoke test only
(12/12 passing, not a gate).

## 10. Projection from current telemetry

Measured at 2026-11-21T04:27Z, 14-day window starting 2026-11-07:

| Metric | Current | Verdict |
|---|---|---|
| `D` | `.pi/test-runner/latest.json` is a 2-file focused run from 2026-11-18 with no revision field | **insufficient** — needs a full-suite, revision-bound record |
| `P` | permissions compliant | pass |
| `B` | no baseline file written | **insufficient** |
| `S1` | 23 decisions, all `verification:"unverified"` | **fail** (precision 0.0, below 0.95) |
| `R` | 140 `memory_retrieval` events, payloads empty | **insufficient** |
| `SD` | no `memory_decision` shadow events | **insufficient** |
| `C` | 147 settles in window: accounting 1.00, stability 1.00, all diagnostic-only, vault ready; but 9 distinct days | **fail on volume** (needs 14 distinct days) |
| `A` | no automatic saves | **insufficient** |

So today: M0 is not yet promotable (needs instrumentation + baseline), M4 has the strongest
existing signal and will meet its volume bar within ~5 days, and M2/M3/M5 need the new event
fields before they can be evaluated at all. No stage requires a signature at any point.

## 11. Acceptance

The design is satisfied when:

1. Two weeks of ordinary sessions produce a promotion from M0→M1→M2 with **zero** manual
   commands, signatures, or review attestations.
2. Every stage transition is explainable from a `rollout.evaluated` trace event alone.
3. Deleting `.pi/privacy-guard/rollout-evidence.json`, `reviewed-gold-*.json`, and the signing
   key changes no gate outcome.
