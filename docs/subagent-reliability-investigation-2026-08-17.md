# Subagent Reliability Investigation — 2026-08-17

Status: the full-plan candidate and provider investigation are complete; the 14-run provider-error wave was external Codex exhaustion, but the authorized candidate rerun missed latency and strict typed-field gates, so the candidate was archived as reproducibility evidence rather than retained

## Scope and privacy boundary

This report evaluates subagent execution recorded under `~/.pi/agent/sessions/` and the project-local role state under `.pi/subagents/`. The aggregate analysis excludes prompt bodies, transcript bodies, tool arguments/results, private reasoning, secrets, and source-file bodies. The active Pi session was excluded from the canonical role-runtime audit.

Repository baseline:

- revision: `285b5e9e9cc95093909e89c48963ff44651d70ba`
- branch/upstream: `main`, equal to `origin/main`
- working tree before report creation: clean
- implementation under evaluation: `feat(subagents): enforce role-specific inference profiles`

## Historical corpus integrity

The privacy-bounded role-runtime audit scanned the full bounded corpus without truncation:

| Metric | Value |
|---|---:|
| Session files seen | 1,560 |
| Session files scanned | 1,559 |
| Active session files excluded | 1 |
| Bytes read | 2,491,738,247 |
| Parent parse errors | 0 |
| Child-session parse errors | 0 |
| Session files mode `0600` | 1,560/1,560 |
| Session directories mode `0700` | 117/117 |
| Referenced child sessions read | 270/270 |
| Referenced child sessions missing | 0 |

Evidence: read-only invocation of `scripts/audit-role-runtime.js` through its exported `auditRoleRuntime()` function, with `maxFiles=2000`, `maxBytes=4 GiB`, and exact `PI_SESSION_FILE` exclusion.

All 1,560 session headers use Pi session schema version 3. That header does not distinguish subagent runtime generations, so cohort boundaries below use typed record markers and implementation dates.

## Historical reliability baseline

### Execution-tool view

Across 514 observed `create_subagent operation=run` calls, 510 had matched tool results and four did not.

| Outcome | Count | Rate of 510 matched results |
|---|---:|---:|
| Succeeded | 147 | 28.8% |
| Failed | 139 | 27.3% |
| Timed out | 157 | 30.8% |
| Tool-level error without terminal record | 31 | 6.1% |
| Unclassified legacy result | 36 | 7.1% |

### Role-v2 direct-run cohort

| Outcome | Count | Rate of 273 role-v2 results |
|---|---:|---:|
| Succeeded | 99 | 36.3% |
| Failed | 139 | 50.9% |
| Timed out | 35 | 12.8% |

The role-v2 aggregate is highly task/role skewed: `lebanese-draft-author` accounts for 74 of 99 successes. Historical direct-run results for core labels were reviewer 11/52, researcher 4/46, planner 0/10, and coder 0/4. These are not matched tasks and mostly predate later fixes, so they are evidence of historical behavior, not a current-source prediction.

### Canonical parent `role-run` cohort

| Outcome | Count | Rate of 290 role-run records |
|---|---:|---:|
| Succeeded | 100 | 34.5% |
| Failed | 139 | 47.9% |
| Timed out | 51 | 17.6% |

Of these records, 274 carry role-v2 contract markers and 16 are legacy. All 290 predate the current schema-v4 exact-cohort provenance contract and are excluded from current field eligibility as `missing-cohort-metadata`.

### Retained project-local state

The project-local `.pi/subagents/` state contains 57 records and 56 settled result envelopes:

| Outcome | Count | Rate of 56 settled results |
|---|---:|---:|
| Succeeded | 30 | 53.6% |
| Failed | 25 | 44.6% |
| Timed out | 1 | 1.8% |

One reviewer record created on 2026-07-27 remains `running` without a result or termination and appears abandoned.

## Historical role-v2 failure causes

Among 174 structured role-v2 non-success results:

| Termination category | Count | Share |
|---|---:|---:|
| `budget_model_calls` | 65 | 37.4% |
| `invalid_result` | 40 | 23.0% |
| `wall_clock` | 26 | 14.9% |
| `budget_tool_calls` | 22 | 12.6% |
| generic `failed` | 10 | 5.7% |
| `queue_wait` | 9 | 5.2% |
| `provider_error` | 2 | 1.1% |

Budget exhaustion accounts for 50.0% of structured role-v2 failures. Wall-clock plus queue timeouts account for 20.1%. Current retained-state error objects classify all 16 `invalid_result` failures as role-envelope validation failures.

## Historical error-logging assessment

Legacy parent-session logging was weak: all 237 legacy/unmarked results lacked structured termination codes, including 153 explicit failures/non-success tool results.

Role-v2 logging is substantially stronger:

- 174/174 structured failures include a termination code and diagnostics;
- 164/174 older parent tool results are marked `isError=true`;
- 270/270 referenced child sessions are readable;
- all 56 settled retained results include a termination code/message, diagnostics errors, and model/tool accounting.

The parent packet intentionally omits most free-text failure messages for privacy. Durable private records and child sessions retain the actionable message. Historical audit findings include one legacy false success, 87 budget overruns, 36 tool-accounting mismatches, and one legacy timed-out mutating run. Resolved debug-ledger evidence attributes these to pre-fix terminal validation, budget enforcement, accounting, submission-reserve, workspace-isolation, module-cache, and shared-capacity defects.

## Runtime generation boundaries

- 2026-05-20: branch-backed subagents introduced.
- 2026-05-22 through 2026-05-24: RPC sidecars, responsiveness, fan-out, result compaction, and concurrency changes.
- 2026-07-17: terminal/lifecycle hardening.
- 2026-07-22: Roles v2 typed contracts and rollout gates.
- 2026-07-26: outcome/privacy hardening.
- 2026-08-12: global worker, RSS, and OOM guards.
- 2026-08-17: deterministic role-specific model and thinking profiles.

No normal session in the scanned corpus contains a post-commit August 17 `create_subagent operation=run` result. Old session records are not migrated to the newer telemetry shape.

## Current controls and unpromoted features

Enabled: role runtime v2, role sidecar, typed terminal envelopes, read-only R0 field pilot, role-specific model/thinking profiles, `create_subagent`, `run_topology`, and RPC concurrency two.

Not enabled or not promoted:

- role mutation (`PI_ROLE_MUTATION=off`);
- rollout above R0;
- automatic shadow/delegate execution (`suggest` only);
- automatic parallel-evidence synthesis (E3 is null-result, 0/30 candidate runs);
- the later consolidated plan-fanout and topology-recipe operations inside `create_subagent`/`run_topology` remain explicit-only; the standalone model tools were retired;
- subagent/topology Hermes final-summary sync;
- output-limit continuation (default zero);
- full branch snapshots (metadata-only is the default);
- nested role sidecars and normal extension/skill loading in role-v2 children;
- Luna verifier/benchmark live rollout.

Runtime Doctor currently reports deterministic benchmark evidence as `runtime-source-hash-mismatch`, field evidence as failed/insufficient sample, and zero eligible current-source live field runs.

## Separate August 17 worker pilot

The closed `exp-task-specific-luna-subagent-inference` experiment recorded 30/30 live worker/Luna-low successes, 100% typed validity, accounting parity, profile parity, and expected-answer coverage; zero unsupported accepted claims or mutation violations; unchanged parent tree; and p95 duration 26.181 seconds. Run Deck ID: `run-task-specific-luna-worker-live-70d9`.

This evidence is specific to the bounded worker role. It does not establish current-source researcher, reviewer, planner, multi-role, or topology reliability. Run Deck currently labels its terminal tree evidence stale relative to the present revision.

## Current-source clean trial

Experiment: `exp-august-17-current-source-multi`

The candidate ran once, directly in the foreground with no `bg_run`, Run Deck, or other outer managed-worker slot. It pinned:

- Git HEAD: `285b5e9e9cc95093909e89c48963ff44651d70ba`
- runtime source hash: `8e6d5d371a594f80582c03fb5e64f086e770df8585b24420c2e320d902ddd49e`
- role runtime: v2, R0, mutation off, read-only pilot on
- RPC concurrency: 2
- user-wide managed worker limit: 2
- live workload: 30 independent role-v2 runs, issued as 15 pairs
- roles: worker 8, researcher 8, planner 6, reviewer 4, evidence-auditor 4

The parent working-tree status was identical before and after the trial. No run remained created, queued, or running.

### Preregistered gate results

| Gate | Verdict | Exact result |
|---|---|---|
| E0 provenance/unwrapped execution | PASS | HEAD/source pinned; direct foreground; no outer manager; parent tree unchanged |
| E1 reliability | **FAIL** | 14/30 succeeded (46.7% versus >=90%); 16 failed; 0 timed out; p95 103.595 s |
| E2 typed quality/truth | **FAIL** | typed validity 46.7% versus >=95%; expected-answer/evidence coverage 46.7% versus >=90%; zero unsupported accepted claims, false successes, or mutations |
| E3 telemetry | **FAIL** | field presence 100%; accounting parity 96.7%; actual child profile parity 100%, but parent failure packets preserved effective profile for only 14/30 total runs; exact schema-v4 cohort 30/30 but aggregate field gate failed |
| E4 concurrency/logging | PASS | deterministic probe started exactly 2/4 children before release; 4/4 completed; all 15 live pairs overlapped; 16/16 failures had status, termination code/message, diagnostic error, and resolvable child session; zero nonterminal records |

### Outcomes by role

| Role | Succeeded | Rate | p95 duration |
|---|---:|---:|---:|
| worker | 8/8 | 100% | 9.189 s |
| researcher | 4/8 | 50% | 40.189 s |
| planner | 0/6 | 0% | 42.842 s |
| reviewer | 2/4 | 50% | 112.398 s |
| evidence-auditor | 0/4 | 0% | 38.850 s |
| **Total** | **14/30** | **46.7%** | **103.595 s** |

### Failure analysis

| Failure cause | Count | Share of 16 failures |
|---|---:|---:|
| `invalid_result` | 8 | 50.0% |
| `budget_model_calls` | 7 | 43.8% |
| `budget_tool_calls` | 1 | 6.2% |

All eight invalid results reached an apparently successful `submit_role_result` tool result in the child, then failed strict parent validation. The sidecar's model-visible tool schema uses `Type.Any()` for nested claims, evidence, audit, gap, and coverage fields and performs only shallow required-field validation before terminating. The parent later applies the strict canonical schema. Observed mismatches were:

- four evidence-auditor envelopes using plausible but noncanonical nested names such as `text`, `type`, `path`, `evidenceRefIds`, or incomplete coverage/decision objects;
- two optional `claims` arrays from researcher/reviewer using noncanonical item fields;
- two optional `unresolvedGaps` arrays using noncanonical item fields.

Budget failures were exact and fail-closed:

- six planner runs exceeded a four-model-call budget or the 24-tool-call budget;
- one researcher made 7 model calls against a limit of 6;
- one reviewer made 9 model calls against a limit of 8.

The planner tool-budget failure emitted 25 calls but only 20 correlated results, lowering cohort accounting parity to 96.7%. This is consistent with a parallel/blocking overshoot path and requires an explicit blocked-call accounting contract.

### Concurrency and telemetry findings

Concurrency itself worked:

- deterministic probe: exactly two starts before release at configured limit two; all four children completed;
- live model workload: all 15 pairs had overlapping child-session intervals;
- no outer managed job consumed a worker slot.

All 30 child sessions were readable with zero parse errors, and their session model/thinking events matched the configured profiles 30/30. However, failed parent result diagnostics retained selected model/thinking but omitted effective model/thinking and `piSessionFile`; they retained a resolvable `rpcSessionDir`. Therefore:

- actual child profile parity: 30/30;
- parent result selected/effective profile completeness: 14/30;
- child-session provenance after resolving either file or directory: 30/30;
- failure logging completeness: 16/16;
- privacy forbidden-field findings: 0;
- mutation violations: 0.

The original private report counted only `piSessionFile`, so it underreported failure child provenance and produced invalid overlap values for failed pairs. A separate immutable-hash-linked `analysis.json` corrects those derived metrics without rerunning or overwriting the settled cohort.

### Exact evidence

Private, mode-`0600` evidence under `.pi/role-runtime/pilots/aug17-multirole-1786968069730/`:

| Artifact | SHA-256 |
|---|---|
| `report.json` | `e22d35dfed58023fd98a2c80b4ecaaf72524f0b28154bc97214d4786e7cc1b38` |
| `role-runs.jsonl` | `4cc704e46af9200a7e8e7c8c7e945bb57344d500c9ce4460a07ec48d5cbc19e7` |
| `analysis.json` | `665b61a53d270d396f226cca7c84bc3cf0a93e7426c0d9420134f4b438806832` |
| trial driver `.pi/role-runtime/pilots/aug17-multirole-reliability-trial.js` | `0cf680d05e07a36b648201b18d77c4102df3573ff9af7befbe35b3987725473e` |

`analysis.json` records the source `report.json` hash, corrected 30/30 child resolution, 30/30 child profile parity, 15/15 live overlap, and 16/16 failure logging. Trial directories are mode `0700`; files were hardened to `0600` after collection.

## Minimal root-cause fix and preregistered rerun

### Root cause

The private child sessions made the two original failure classes deterministic:

1. **Auditor typed-result mismatch:** all 4/4 auditors called `submit_role_result` within budget. The model-visible tool accepted nested `Type.Any()` values and performed only shallow required-field checks, then terminated successfully. The parent subsequently rejected noncanonical claims, evidence references, audit decisions, rejected claims, gaps, or coverage against `contract.outputSchema`.
2. **Planner completion starvation:** all 6/6 planners spent their four allowed model turns on inspection and never called `submit_role_result`. The sidecar's completion reserve applied only to reviewer/evidence-auditor. Five planners reached a fifth counted provider turn and one emitted a parallel 25th tool call against a limit of 24.

The common boundary defect was in `extensions/role-sidecar/index.ts`: the child was not given the same schema/completion contract that the parent enforced.

### Retained implementation

The smallest retained patch:

- publishes `contract.outputSchema` directly through `Type.Unsafe()` instead of maintaining handwritten `Type.Any()` nested fields;
- rejects incomplete role contracts that do not contain a full object output schema;
- applies a role-independent submission phase after `maxModelCalls - 2`, leaving one submit turn and one correction turn;
- switches the active child tools to `submit_role_result` during that phase;
- does **not** increase role budgets or accept obsolete nested field names.

Tracked implementation and regression files:

| File | SHA-256 in retained working tree |
|---|---|
| `extensions/role-sidecar/index.ts` | `355324e37f015627c09ce5274252cfa8e9ee7cd38559630f77fcc00a6edb8a7f` |
| `tests/role-sidecar.test.js` | `c076f235ad3baa166682ffcd9b1750f841b120fc2ac9adcec1a506c874ab3a85` |
| `tests/extension-load.test.js` | `f918037def50ece2834c2625023d4f2dfe1e110f50567a8b458926f0b276bea3` |

The regression tests prove that an observed noncanonical auditor claim is rejected by the model-visible schema, a canonical auditor packet is accepted, and the child enters submit-only mode while two provider turns remain. The live cohort separately established zero mutation violations. Focused checks and the full `scripts/check-all.sh` suite passed against this exact retained source state.

### Fix1 preregistered 30-run result

Experiment: `exp-schema-reserve-fix1-august-17`

Runtime source hash: `0da460971d0a8b6ba2220fe56fbfc6e08720c420d7269e456e2cc824cad5069e`

The same 30 tasks, roles, profiles, role budgets, pair ordering, R0 containment, and mutation-off settings ran once in direct foreground. No outer managed worker wrapped the trial.

| Role | Pre-fix success | Fix1 success | Fix1 expected-answer rate |
|---|---:|---:|---:|
| worker | 8/8 | 8/8 | 100% |
| researcher | 4/8 | 8/8 | 100% |
| planner | 0/6 | 6/6 | 16.7% |
| reviewer | 2/4 | 4/4 | 75% |
| evidence-auditor | 0/4 | 4/4 | 100% |
| **Total** | **14/30** | **30/30** | **80%** |

| Gate | Verdict | Fix1 evidence |
|---|---|---|
| E0 provenance | PASS | HEAD pinned; exact runtime hash; direct foreground; parent tree unchanged |
| E1 terminal reliability | PASS | 30/30 succeeded; zero failures/timeouts; every role 100%; p95 51.469 s |
| E2 typed truth/quality | **FAIL** | typed validity 100%, but expected-answer/evidence coverage 80% versus >=90%; zero unsupported accepted claims, false successes, or mutations |
| E3 telemetry | PASS | accounting, field presence, selected/effective profile, child resolution, and schema-v4 eligibility all 30/30; forbidden privacy fields 0 |
| E4 concurrency/logging | PASS | deterministic two-start probe passed; 4/4 completed; all 15 live pairs overlapped; zero failures/nonterminal records |

The root-cause patch therefore eliminated the reported planner/auditor **terminal** failures without budget expansion: planner improved from 0/6 to 6/6 and evidence-auditor from 0/4 to 4/4. It did not establish planner answer quality. Only one planner result both cited the required sources and included the requested executable `roadmapPlan`; the reviewer cohort met its 75% per-role quality floor, while overall expected-answer coverage remained ten percentage points below the ship bar.

### Exact Fix1 evidence

Private evidence under `.pi/role-runtime/pilots/aug17-multirole-fix1-1786970338612/`, with files mode `0600`, directories mode `0700`, and 30/30 child sessions:

| Artifact | SHA-256 |
|---|---|
| `report.json` | `24ab5bc19a590b826aaec05944c647ab82f9e955029ed02d13702bec8b61fce2` |
| `role-runs.jsonl` | `22ffa2d13eea26483ce07e78b9f540752c2c7f73aaf1e9b3fc79b947b8a7dcea` |

The report itself records `verdict=fail` because the preregistered expected-answer bar failed; it is not reclassified as a passing rollout merely because terminal reliability reached 100%.

### Follow-up diagnostics and rollback boundary

Four changed-source follow-ups tested whether stricter planner-quality enforcement should join the minimal patch. None was retained:

| Cohort | Scope | Outcome | Evidence |
|---|---|---|---|
| Fix2 | full 30 | 30/30 terminal, 76.7% expected, one non-null read-only `proposedPatch` | `aug17-multirole-fix2-1786971000203/report.json`, SHA `4a30f2d09aef8d8fe0514a1f36d21a8db6e73eeec8f44fb955536fc36afb126c` |
| Fix3 | 2-run pilot | 2/2 terminal, but planner used structurally valid placeholder citations | `aug17-multirole-fix3-1786972263947/report.json`, SHA `6cf3132debaed0642940632151f05300535530feb6dd95b19d9ab4811e8e3d1d` |
| Fix4 | full 30 | 26/30; strict placeholder correction caused four model-budget failures; expected 80%; mutation 0 | `aug17-multirole-fix4-1786972681821/report.json`, SHA `e4dd43a60b5887460f832e3fe11ac65ddbd52565a219625f258f161277f4a897` |
| Fix5 | 8-run pilot | 5/8 after planner/reviewer one-turn budget increases; two model-budget failures and one wall-clock timeout | `aug17-multirole-fix5-1786973841896/report.json`, SHA `a19f2b41288235a82fb20b6f623a910c850965320c929946d6692f5f9cc4a947` |

These experiments were preregistered, recorded as no-go, and rolled back with the working tree restored to the exact Fix1 runtime hash. They show that planner semantic quality is not solved safely by simply making more fields required, rejecting placeholders, or adding one model call.

## Full reliability plan candidate and retention boundary

The post-Fix1 plan was implemented and evaluated without restoring the failed Fix2-Fix5 approaches, raising role budgets, or accepting obsolete result aliases.

| Phase | Candidate result |
|---|---|
| Canonical role contracts | Each role exposed only its intended fields with `additionalProperties=false`; planner required a nonempty typed repository-path citation and `roadmapPlan`; reviewer could not emit `proposedPatch`; child and parent derived from the same contract schema; observed legacy nested auditor/reviewer shapes failed closed. |
| Completion/accounting | Every model-backed role reserved two provider turns, saw only `submit_role_result`, and received the exact required-field list plus remaining capacity. Every emitted call was classified as success, error, or explicit block. |
| Failure telemetry | Candidate records distinguished `effectiveProfileObserved`, persisted effective model/thinking and child provenance, and recovered metadata from a private child session when timeout prevented `get_state`. |
| Interrupted lifecycle | Candidate inspection reported stale active records without automatic deletion and required explicit review before persisting interrupted termination. |
| Verification/evidence | Focused schema, budget, accounting, provenance, privacy, lifecycle, cleanup, topology, extension, concurrency, compiler, integration, and Semgrep checks passed before the live gates. |

The candidate is **not retained in the active source tree**. Its final runtime source hash was `5f09855c8fc8dcc1afd8b8894ddf89d18486c47378bda315b655bc5b04d7ee93`; the retained Fix1 tree is `0da460971d0a8b6ba2220fe56fbfc6e08720c420d7269e456e2cc824cad5069e`. The candidate missed rollout gates, so its source changes and ancillary tests/docs were restored to `HEAD` after review. Only this investigation report and the exact reproduction artifacts remain.

### Reproducibility artifacts

Starting from `7d2d6a25ae12a397da9a0f3ca2aac99c2d844158`, `gzip -dc docs/reproducibility/subagent-reliability-full-plan-2026-08-20.patch.gz | git apply` reconstructs the candidate runtime source hash `5f09855c8fc8dcc1afd8b8894ddf89d18486c47378bda315b655bc5b04d7ee93`. The deterministic gzip artifact SHA-256 is `400068b7b2e9b9d7b635c087e6e905a1a2b8cc0479c04b46f8dcf6332f67b09c`.

`docs/reproducibility/aug17-multirole-reliability-trial.js` is the exact trial driver, SHA-256 `4855a2fe4a58a331214242297f62499ae52d1b5314a7797cfc6d954b6c711ed5`. To preserve its original relative-root behavior, copy it to `.pi/role-runtime/pilots/aug17-multirole-reliability-trial.js`, set `PI_AUG17_EXPECTED_HEAD` to the base revision, and run it directly in the foreground. The driver forces R0, mutation off, suggest-only routing, RPC/managed concurrency 2, and the unchanged 30-task ordering. Live execution still depends on current provider entitlement and is not authorized merely by possessing the artifact.

### Verification status

The archived candidate had focused and broad deterministic evidence, but its last full `scripts/check-all.sh` remained partial after repository tests and 48 RPC smokes because the external model probe reached the Codex usage limit. Exact Luna/low and Sol/xhigh recovery preflights later passed, and the authorized candidate rerun contained zero provider errors. Final retention verification is documentation/evidence-only: candidate patch reconstruction, driver/source hashes, report metrics, permissions/privacy, diff checks, and git-aware verification must pass; the discarded candidate source is not represented as shipped code.

### Staged and provider-recovery evidence

| Cohort | Source hash | Result | Disposition |
|---|---|---|---|
| Full-plan P0, 10 role-focused tasks | `d0ab873b80c87295c88df96fce4fe3d43374f94b66484eb8c4fead9c29e0c94e` | 10/10 terminal and expected; every role 2/2; accounting/profile/child/telemetry 100%; p95 104.875 s | PASS; authorized one 30-task cohort |
| Full-plan first 30 | `d0ab873b80c87295c88df96fce4fe3d43374f94b66484eb8c4fead9c29e0c94e` | 29/30 terminal; timeout 3.3%; typed 96.7%; expected 93.3%; E1/E2/E4 passed; profile parity 96.7% because one timeout preceded `get_state` | NO-GO at E3; preserved |
| Timeout-provenance P1, 2 planner tasks plus synthetic timeout | `6470abe12e1e751474fac0ffe5ead9ee25f7d631f339c4e2fdd025c710663655` | synthetic timeout preserved metadata-only profile/child provenance; live planner 2/2 terminal and expected; all telemetry 100%; p95 100.518 s | PASS; authorized one final cohort |
| Final full-plan 30 | `6470abe12e1e751474fac0ffe5ead9ee25f7d631f339c4e2fdd025c710663655` | first 16/16 worker/researcher tasks succeeded; the remaining 14 tasks returned `provider_error`; overall 16/30, typed 53.3%, expected 50%; accounting/profile/child/telemetry and failure logging 100%; concurrency 15/15; no safety violation | **NO-GO** at E1/E2; settled evidence |
| Provider recovery Luna preflight, 2 worker tasks | `5f09855c8fc8dcc1afd8b8894ddf89d18486c47378bda315b655bc5b04d7ee93` | 2/2 terminal and expected; 100% typed/accounting/profile/child/telemetry; no provider errors | PARTIAL availability evidence; affected Sol/xhigh still untested |
| Affected-profile preflight, 2 planner tasks | `5f09855c8fc8dcc1afd8b8894ddf89d18486c47378bda315b655bc5b04d7ee93` | 2/2 Sol/xhigh terminal and expected; no provider errors; p95 113.474 s; all containment bars pass | PASS; confirmed entitlement recovery and authorized the full rerun |
| Authorized unchanged-task candidate 30 | `5f09855c8fc8dcc1afd8b8894ddf89d18486c47378bda315b655bc5b04d7ee93` | 29/30 terminal; one reviewer wall-clock timeout; zero provider errors; timeout 3.3%; typed and expected 96.7%; all roles >=75%; accounting/profile/child/telemetry/failure logging 100%; concurrency 15/15; no safety violation; p95 123.543 s | **NO-GO**: p95 exceeded 120 s and the field gate requires 100% typed validity; candidate not retained |

The first 30-task cohort demonstrates that the stricter role schema raised expected-answer coverage from Fix1's 80% to 93.3% while staying inside unchanged budgets and reliability bars. It also exposed the timeout provenance gap. The metadata-only fallback then passed its deterministic and live P1 gates. The settled final August 17 cohort validates complete failure-path telemetry across 14 provider failures but remains failed evidence.

The August 20 investigation inspected all 14 private child sessions. Every failed terminal call had the identical zero-token message `Codex error: The usage limit has been reached`. The first two planners reached it on model call four after fully correlated tool work; all subsequent planner, reviewer, and auditor tasks reached it on model call one with zero tool calls in roughly two seconds. This excludes schema rejection, role budget, driver sequencing, accounting, and concurrency as the cause of the consecutive wave. The confirmed root cause was exhausted external Codex usage entitlement. No additional repository, role-profile, budget, task, or driver change was justified for that provider failure. Fresh exact Luna/low and affected Sol/xhigh gates proved entitlement availability before the explicitly authorized one-time full rerun.

The rerun eliminated the failure class: 0/30 provider errors versus 14/30 previously. It nevertheless does not qualify for rollout. `review-telemetry-a` reached its existing 180 s wall clock after six model calls and eleven fully accounted tool calls; this yielded 29/30 typed terminals and raised cohort p95 to 123.543 s. No retry, timeout increase, budget change, or post-hoc bar change was made.

### Exact full-plan evidence

The local cohort reports and role-run packets below remain private mode `0600` under mode-`0700` directories; their public summaries contain no prompt/transcript/tool-output/private-reasoning fields. The tracked reproduction patch and driver are source artifacts at ordinary repository permissions and contain no credentials, session transcripts, private reasoning, or absolute home paths.

| Cohort artifact | SHA-256 |
|---|---|
| P0 `aug17-multirole-full-plan-1786979053286/report.json` | `ba4884fe14a493a3b35cb29d3ef21d6bee435fdc8c043c9e46ef12eda82f7340` |
| P0 `role-runs.jsonl` | `1416e81a0b9b0c79dd19bcb4a671be17e45ce9f3ebd1a1f3885c1aae2661bf20` |
| First full `aug17-multirole-full-plan-1786979401445/report.json` | `c6f7ef565ba434bac12a5ecf51babbdcc2c0198b3b01a0acea3e3fc6bfa0a50d` |
| First full `role-runs.jsonl` | `874d87a3f2a6bb3994bbba51e631e69559b7ae745fffc07b7612f9a9a4fdab55` |
| P1 `aug17-multirole-full-plan-1786980323893/report.json` | `24c1d5cb55d46ed560ae96d3d05d9382b1901c19315da9469637ca00aff261c9` |
| P1 `role-runs.jsonl` | `7341dfc43d99624b789d895ca2e90dca2181cd322d9ec384b553e6b252174072` |
| Final full `aug17-multirole-full-plan-1786980484711/report.json` | `0e5e58a1bbe25fd3c3f0426233d7d8ac499d5693e3538e192e1386ef3e744d36` |
| Final full `role-runs.jsonl` | `ec7ee1cc9fa25d800d4f9fc389d31f894ba4008202118dfc8bb078e5fa98b5c6` |
| Luna preflight `aug17-multirole-full-plan-1787205367119/report.json` | `82a8c689f7718a4665b4bfd7a9844a6499297335e43193f9813c0d77ced183bc` |
| Luna preflight `role-runs.jsonl` | `86e8f7daebaa2607772ec3b49d4d91c6653a8663e8c1f093ed055bbdb16d3544` |
| Sol/xhigh preflight `aug17-multirole-full-plan-1787205417171/report.json` | `cce05c7d0e00c677cb059d33e0049fc99e1558c3660bd98da1836e676dc1ead4` |
| Sol/xhigh preflight `role-runs.jsonl` | `54b866b638bca215d919f357ffecace0763271f4a1cde29847962cd78e632b77` |
| Authorized rerun `aug17-multirole-full-plan-1787205560987/report.json` | `411327b5a4b2ff6b019874ee8bcbd1b6a7356647bddfef99cb94dee76386ecd2` |
| Authorized rerun `role-runs.jsonl` | `c47ea53e7d11fbf0d08ec18d661d002349c6690cbe1b508a46e04f1633eeaf41` |
| Tracked candidate patch (deterministic gzip) | `400068b7b2e9b9d7b635c087e6e905a1a2b8cc0479c04b46f8dcf6332f67b09c` |
| Tracked trial driver | `4855a2fe4a58a331214242297f62499ae52d1b5314a7797cfc6d954b6c711ed5` |

## Comparison and verdict

| Metric | Historical direct role-v2, n=273 | Pre-fix exact cohort, n=30 | Retained Fix1 exact cohort, n=30 | Authorized candidate rerun, n=30 |
|---|---:|---:|---:|---:|
| Success | 36.3% | 46.7% | **100%** | 96.7% |
| Failed | 50.9% | 53.3% | 0% | 0% |
| Timed out | 12.8% | 0% | 0% | 3.3% |
| Typed validity | not comparable | 46.7% | **100%** | 96.7% |
| Expected-answer/evidence coverage | not comparable | 46.7% | **80%** | **96.7%** |
| Planner success | historical core 0/10 | 0/6 | **6/6** | **6/6** |
| Evidence-auditor success | insufficient matched history | 0/4 | **4/4** | **4/4** |
| Accounting parity | mixed legacy cohorts | 96.7% | **100%** | **100%** |
| Parent selected/effective profile parity | unavailable historically | 46.7% | **100%** | **100%** |
| p95 duration | heterogeneous | 103.595 s | **51.469 s** | 123.543 s |
| Provider errors | not comparable | mixed | 0 | **0** |
| False success / mutation violation | historical audit found 1 / 1 legacy | 0 / 0 | 0 / 0 | 0 / 0 |

Fix1 was a large matched-task terminal improvement but not the end state. The completed schema plan subsequently raised expected-answer coverage to 93.3% in the first full-plan 30-task cohort while retaining 96.7% terminal success and unchanged budgets. The same cohort exposed the last failure-profile provenance gap, which the changed-source timeout fallback then resolved in deterministic and P1 evidence.

The provider-error investigation is **resolved**: the 14-run wave was exhausted external Codex usage entitlement, not a harness defect, and the authorized candidate rerun observed zero provider errors without an additional code or configuration change. The settled failed cohort remains evidence rather than being reclassified.

The broader rollout verdict remains **NO-GO**. The candidate rerun passed success, timeout-rate, per-role, typed-validity, expected-answer, accounting, profile, child-session, privacy, mutation, concurrency, and failure-logging bars, but cohort p95 was **123.543 s** against the preregistered <=120 s limit. Its one timeout also left the stricter schema-v4 field gate at 96.7% typed validity rather than the required 100%.

**Disposition:** retain the already-committed minimal Fix1 schema/submission-reserve repair at runtime hash `0da460971d0a8b6ba2220fe56fbfc6e08720c420d7269e456e2cc824cad5069e`; archive the full-plan candidate only as the exact patch and trial driver above; keep R0, mutation off, and suggest-only routing. Do not apply the candidate patch for rollout, retry the unchanged cohort, increase timeout/budgets, or alter bars based on this result.

## Original evidence-based plan

### Phase 1 — Unify the model-visible and canonical result schema

1. Make `submit_role_result` expose the exact role-specific nested contract instead of `Type.Any()` arrays/objects.
2. Derive the sidecar tool parameters and validation from the single canonical schema in `src/role-result-schemas.js`; do not maintain a second handwritten nested schema.
3. Run strict role-envelope validation inside the sidecar before returning `terminate: true`, so invalid submissions produce an actionable tool error while budget remains rather than an apparent child success rejected only by the parent.
4. Narrow each role's exposed optional fields to those it is expected to use, especially researcher/reviewer versus evidence-auditor evidence packets.
5. Add deterministic fixtures reproducing all observed noncanonical shapes without adding compatibility acceptance for obsolete field names.

**Exit bar:** every observed invalid envelope fails at the child tool boundary with a bounded schema error; canonical planner/researcher/reviewer/evidence-auditor submissions validate identically in child and parent.

### Phase 2 — Reserve completion capacity for every model-backed role

1. Generalize the reviewer's submission reserve into a role-aware completion reserve for planner, researcher, reviewer, and evidence-auditor.
2. At the final permitted model turn, expose only `submit_role_result` and provide the exact remaining required fields; do not merely block another inspection tool and allow another provider turn.
3. Measure task-call distributions before changing budgets. Raise a budget only when the fixed completion controller still cannot complete a representative task.
4. Define how parallel tool batches at the limit terminate: each emitted call must receive a correlated success, error, or blocked result.

**Exit bar:** deterministic boundary tests show no unreported model/tool overshoot, no unmatched blocked calls, and a reserved terminating submission within each registered role budget.

### Phase 3 — Complete failure-path telemetry

1. When `get_state` succeeds but terminal validation fails, persist effective model, effective thinking level, and authoritative child session file alongside the selected profile and RPC directory.
2. Distinguish `effective-profile-observed=false` for failures before state retrieval rather than silently omitting fields.
3. Require profile-provenance completeness and child-session resolution in the schema-v4 field gate; eligibility alone must not imply telemetry completeness.
4. Preserve the current bounded termination message and diagnostic error behavior.

**Exit bar:** synthetic provider, schema, budget, queue, and timeout failures all retain complete selected/effective profile and child provenance, with zero prompt/transcript/provider payload fields.

### Phase 4 — Report interrupted lifecycle state

1. Add a read-only stale-active diagnostic that identifies old `created`/`queued`/`running` records whose owning process/session no longer exists.
2. Surface these in Runtime Doctor and cleanup preview without deleting or silently finalizing evidence.
3. Add an explicit operator action to mark a reviewed stale record failed/interrupted with a structured termination record.

**Exit bar:** the July 27-style abandoned record is visible and actionable without being counted as active or removed automatically.

### Phase 5 — Verification and staged field evidence

1. Pass focused deterministic tests for role schemas, sidecar submission, budgets, accounting, failure provenance, privacy, and concurrency.
2. Pass the role-runtime fixture benchmark and full repository/TUI checks against one runtime source hash.
3. Open a new experiment only after source changes. Start with one or two labeled tasks for each previously failing role; do not repeat the settled 30-run cohort unchanged.
4. Advance to a new >=30 exact-source read-only cohort only if the cheap role-specific gate passes.
5. Require >=90% overall and >=75% per-role success, >=95% typed validity, 100% accounting/profile/child-provenance parity, zero false success, zero privacy/mutation violations, and p95 <=120 seconds.
6. Regenerate deterministic and field reports, then reconsider R1 read-only promotion. Keep mutation and automatic delegation independently blocked until their own experiments pass.

### Final plan disposition

- Phases 1-4 were implemented and tested in the archived full-plan candidate; they are not active in the retained source tree.
- Phase 5 was executed with deterministic, P0, P1, and full field gates. The original final field gate failed during provider exhaustion; the later explicitly authorized candidate rerun eliminated provider errors but missed p95 and the 100% typed field gate.
- The candidate source and ancillary tests/docs were discarded after the no-go. The exact runtime patch and driver were retained solely for audit and reproduction.

**Plan decision:** retain the proven minimal Fix1 repair and continue R0 containment. The archived candidate is not a rollout artifact, and the provider-investigation rerun does not authorize another unchanged retry or promotion.
