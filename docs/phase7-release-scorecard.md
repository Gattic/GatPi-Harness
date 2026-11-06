# Phase 7 post-fix release scorecard

Generated: 2026-07-30T12:14:02.372Z
Scorecard: `phase7_ff33511ad87774e9`

## Release decision

**NO-GO-DEFERRED** — The mandatory versioned 14-day cohort is incomplete; irreversible release/promotion decisions remain blocked.

- Source version: `c81778753195+c304d682f772924d`
- Runtime source hash: `c304d682f772924df029b217ce5ed7fdf57da237c9b44ce8776082a64cc6bf33`
- Config version: `settings-2d0f65e6ac93a12a+portfolio-2+telemetry-4+outcome-2+cohort-1`
- Cohort: 0/14 days; raw metadata events=1; rate-denominator eligible=false; sufficient=false
- Aggregate audit: current session excluded=true; session kinds={"other":1}; observed interactive days=0; eligible=false
- Metrics: pass=9, fail=0, insufficient-data=2
- Role rollout: requested=R0; eligible=R0; effective=R0; source=containment-default

## Ship bars

| Area | Status | Measured | Bar |
|---|---|---|---|
| Role sidecar launch | **PASS** | `{"status":"finished","modelCalls":2,"toolCalls":3,"toolResults":3,"toolFailures":0,"totalDurationMs":21776,"typedTermination":true,"sample":1}` | 0 load failures; >=1 model call; typed submit_role_result termination |
| Read-only role reliability | **PASS** | `{"deterministicEligibleStage":"R4","pilot":{"completionRate":1,"timeoutRate":0,"p95Ms":21776,"sample":1}}` | deterministic pass; pilot completion >=90%; timeout <=5%; p95 <=120s |
| Semantic outcome truth | **PASS** | `{"parity":true,"postFixRoleRuns":1,"postFixFindings":{"falseSuccessTerminalErrors":0,"modelBudgetOverruns":0,"toolAccountingMismatches":0,"timedOutMutatingRuns":0}}` | 100% canonical status/termination agreement |
| Extension inventory | **PASS** | `{"capturedAt":"2026-07-26T09:50:40.200Z","extensions":47,"loaded":46,"degraded":0,"declaredCommands":382,"declaredTools":67,"registeredCommands":382,"registeredTools":59,"activeTools":59,"conflicts":0,"unexplained":0,"portfolioRecords":47,"toolDecisions":67,"portfolioReconciled":true,"observationStatus":"insufficient-data","evidence":["full-fleet RPC extensions-inventory"]}` | 47 records; runtime/source reconciliation; 0 unexplained discrepancies |
| Semgrep reliability | **INSUFFICIENT DATA** | `{"smokePassed":true,"infrastructureErrorRate":null,"coldConfigReady":true,"findings":0,"evidence":["focused p/default scan: 0 findings/errors; one non-fatal Python taint fixpoint warning","Semgrep+CodeGraph bridge ready"],"cohortDays":0}` | cold/default scan works; post-fix infrastructure error rate <5% over >=14 days |
| Obsidian Hermes readiness | **PASS** | `{"capturedAt":"2026-07-26T09:52:36.465Z","localMarkdownReady":true,"desktopReady":false,"authReady":true,"authStatus":"ready","providerModelReady":true,"curationReady":true,"dryRunPassed":true,"curationStatus":"ready","category":"dry-run-succeeded","durationMs":5412,"filesIncluded":0,"noteWritten":false,"evidence":["bounded live auth probe","synthetic-input dry-run; filesIncluded=0; noteWritten=false"]}` | layered readiness truthful; bounded authenticated dry-run passes |
| Test Runner semantics | **PASS** | `{"notApplicableSemantics":true}` | no-command/no-prior-failure are not-applicable |
| Cognitive context efficiency | **INSUFFICIENT DATA** | `{"deterministicReductionPct":91.75,"correctnessPassed":true,"liveRateAvailable":false,"evidence":["phase5 deterministic benchmark","reasoning context/injection regressions"],"cohortDays":0}` | >=60% live reduction with objective/constraint correctness over >=14 days |
| Prompt/UI telemetry | **PASS** | `{"metadataOnly":true,"events":30,"shown":20,"accepted":3,"timedOut":6,"retried":1,"evidence":["metadata-only prompt suggestion structural evidence; pre-freeze events excluded from post-fix rates"]}` | shown/accepted/dismissed/failed metadata exists without text |
| Privacy | **PASS** | `{"actionable":0,"ignored":1,"telemetryRedactionPassed":true,"evidence":["fresh current Privacy Guard scan: 0 actionable, 1 ignored policy match","extension telemetry/session-miner/phase7 privacy tests"]}` | 0 actionable findings; telemetry redaction tests pass |
| Extension portfolio | **PASS** | `{"records":47,"toolDecisions":67,"activeTools":59}` | every custom tool has owner/trigger/overlap/metric/lifecycle decision |

## Exact telemetry versions after the freeze (unjoined metadata; not a rate denominator)

| Extension | Version | Events | First | Last |
|---|---|---:|---|---|
| ast-tools | extension-telemetry-v2 | 1 | 2026-07-30T12:13:46.962Z | 2026-07-30T12:13:46.962Z |

## Claim boundary

Deterministic, focused, smoke, privacy, and full-suite evidence may pass while the release decision remains deferred. Calls before the frozen source/config boundary and lifetime audit rates are not used as post-fix success evidence. Test/smoke sessions remain separate from interactive sessions. No prompt, transcript, reasoning, raw command, raw tool output, credential, source body, or session path is included in this scorecard.

R4 is the deterministic advisory ceiling. Missing benchmark evidence falls back to R0; `PI_ROLE_ROLLOUT_STAGE=R0` or `PI_ROLE_RUNTIME_VERSION=1` is the immediate rollback. R5 and hidden automatic mutation remain unauthorized without a separate bounded real-project pilot.
