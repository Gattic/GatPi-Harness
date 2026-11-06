# Compounding effectiveness scorecard

## Purpose

`src/compounding-effectiveness.js` measures whether evidence-backed execution, learning, skills, maintenance, and provenance improve later work. Inventory growth is not a success metric. The generated scorecard is private and metadata-only under `.pi/learning-loop/scorecards/`; this document publishes only the schema, bars, and authority boundary.

The field experiment was pre-registered as `exp-memory-learning-compounding-efficacy-field` before any new cohort run. The current runtime report says `pre-registered`, all C0-C5 gates are `insufficient-data`, the control/candidate comparison is `insufficient-data`, and project memory remains `no-go-deferred` at M0. No field run was started by implementing the scorecard.

## Evidence classes

Every observed record is classified independently:

- `deterministic` — contract/unit/static evidence;
- `synthetic` — bounded integration fixtures or smoke probes;
- `migration` — compatibility and rollback evidence;
- `exact-version-field` — real use tied to skill ID, version, source hash, session hash, and timestamp;
- `user-reviewed-gold` — explicitly reviewed labels or claim judgments.

Deterministic and synthetic evidence cannot establish field proof. Missing evidence is rendered as `insufficient-data`, never as zero or pass.

## Private schema

The schema-v1 report contains only IDs, hashes, counts, statuses, percentiles, evidence classes, provider coverage, and false privacy/mutation assertions:

```text
schemaVersion, scorecardId, generatedAt
experiment { experimentId, status, fieldRunStarted }
evidenceClasses, evidenceClassCounts
metrics {
  skills { verifiedCapturesByExactVersion, usesByExactVersionSourceAndRouting, failureLearning }
  learningFunnel
  evidence
  memory
  stagePerformance { packet, goalAction, intake, maintenance }
  maintenance
  privacy
  provenance
}
cohorts { exactVersionField, comparison }
gates { C0, C1, C2, C3, C4, C5 }
decision, highestAuthorizedProjectMemoryStage, boundaries
```

It excludes task/source bodies, prompts, transcripts, private reasoning, command arguments, raw tool output, secrets, and absolute paths. Source records remain authoritative in their existing stores.

## Metrics

The report tracks:

- verified captures for each exact skill `(skillId, version, sourceHash)`;
- accepted/rejected evaluations grouped by exact version, source hash, routing mode, and evidence class;
- failure-pattern discovery, later matches, mitigation reuse, and post-mitigation success;
- outcome → pattern → proposal → approved → applied → field-proven conversion;
- evidence-link coverage and unsupported-claim rate only from explicit user-reviewed-gold boolean labels with evidence IDs; missing labels remain `insufficient-data`;
- canonical recall precision, stale rate, and cross-project contamination from the existing memory scorecard;
- p50/p95 duration, model calls, tool calls, and measured context added for packet, goal-action, intake, and maintenance stages;
- maintenance new/persistent/resolved candidates, identity stability, resolution accounting, and scheduled mutation violations; applied/ignored remain `insufficient-data` because preview has no apply/ignore authority;
- privacy rejections, evidence-backed user-reviewed high-severity policy findings, and provenance dangling-edge rate. Raw policy inputs, commands, and reasons are never ingested; absent review evidence remains `insufficient-data`.

A control/candidate delta is refused unless both arms have records under one explicit cohort ID and every row has exact skill/version/source identity plus an independent session hash. No implicit cohort inference is permitted.

## Pre-registered gates

| Gate | Minimum evidence and bar |
| --- | --- |
| C0 contract/privacy | Deterministic evidence; zero forbidden fields, secrets, absolute paths, duplicate packets, or invalid provenance edges. |
| C1 cross-surface integration | Fixture/smoke evidence; 100% vault identity agreement, 100% idempotent handoff, zero automatic memory writes. |
| C2 shadow cohort | At least 20 settled packets; zero privacy violations, at least 90% evidence-link validity, at most 5% classification corrections. |
| C3 exact-version skill cohort | At least 30 uses of one exact candidate `(skillId, version, sourceHash)`, 10 independent sessions, and a 14-day observation span; at least 90% evidence coverage, zero unresolved high-severity findings, non-regression of the candidate versus control 95% Wilson lower bound for verified success. |
| C4 maintenance cohort | At least four previews across 14 days; zero scheduled mutations, stable shared candidate IDs, at least 95% transition accounting. |
| C5 compounding efficacy | Pre-registered control/candidate comparison; verified-success improves by at least 0.05 or unsupported-claim rate drops by at least 0.05, while measured p95 duration/model/tool/context cost stays within 110% of control and privacy violations remain zero. |

Passing a gate records evidence for human review. It never authorizes publishing, push, project-memory stage promotion, routing changes, retention/permission apply, source discovery, or any other mutation.

## Operator surfaces

```bash
node scripts/report-compounding-effectiveness.js
node scripts/report-compounding-effectiveness.js --no-write
node scripts/report-compounding-effectiveness.js --cohort=<pre-registered-id>
```

Commands:

```text
/learning-scorecard [--cohort=id] [--no-write]
/learning-scorecard-status
/compounding-scorecard [--cohort=id] [--no-write]
/compounding-status
```

`learning_loop operation=scorecard` is no-write. `learning_loop operation=compoundingStatus` reads the latest status. `PI_COMPOUNDING_EFFECTIVENESS_ENABLED=0` disables scorecard generation without deleting prior private evidence.
