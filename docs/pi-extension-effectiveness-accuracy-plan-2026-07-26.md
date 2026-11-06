# Pi custom extension effectiveness and accuracy improvement plan

Date: 2026-07-26
Status: planned; implementation has not started
Source: privacy-safe audit of `~/.pi/agent/sessions/` completed 2026-07-26
Decision state: no-go-deferred until measurement truth is repaired and a new exact-version cohort matures

## 1. Purpose

This is a new standalone plan based on the most recent session audit, direct runtime cross-checks, extension telemetry, adapter doctors, retrieval benchmarks, role-run evidence, and privacy findings. It does not extend or renumber the earlier phased remediation plan. That earlier plan remains historical context for work already completed.

The objective is to make Pi's custom extensions:

1. **Correct** — results, counts, statuses, freshness, and capability claims agree with ground truth.
2. **Useful** — extensions replace real friction without adding more polling, prompt noise, or workflow state than they remove.
3. **Measurable** — infrastructure faults, correct negative outcomes, safety blocks, and user value are recorded separately.
4. **Private** — raw sessions and durable state are confined; telemetry remains content-free.
5. **Reversible** — every behavior change has a bounded rollout, explicit fallback, and evidence-backed promotion gate.

## 2. Recent evidence baseline

### 2.1 Session corpus

The aggregate-only audit inspected the local Pi session store in memory and persisted no transcript content:

- 1,502 JSONL session files;
- approximately 749 MB;
- date range 2026-05-21 through 2026-07-26;
- 174 heuristically interactive sessions;
- 1,328 test/smoke sessions;
- zero invalid or oversized rows in the full audit;
- 23,137 calls to currently registered custom tools in the heuristic interactive cohort;
- 405 tool results with `isError:true` (1.75%).

`isError` is only an envelope signal. It is not a valid extension-defect rate because several tools use it for expected project failures or guard rejection.

### 2.2 Runtime inventory

- 47 configured extensions;
- 46 loaded in the parent runtime;
- one correctly inactive child-only role-sidecar;
- 382 registered commands;
- 67 declared tools;
- 59 active parent model tools;
- zero runtime/source conflicts or unexplained registrations.

### 2.3 Most-used extensions

| Extension/tool family | Observed use | Recent conclusion |
|---|---:|---|
| `bg_run` | 10,004 calls; 1 error envelope | Operationally excellent, but status/log polling is excessive |
| Roadmap | 1,902 calls; 27 errors | Valuable visible state; scope carryover and generic errors need correction |
| AST Tools | 1,594 calls; 35 errors | Strong; most friction is confinement or malformed pattern input |
| Debug Ledger | 1,495 calls; 8 errors | Strong; 304 opens and 300 resolves indicate high workflow value |
| Git Evidence Courier | 1,309 calls; 0 errors | Strongest truthfulness profile; direct cross-checks were accurate |
| CodeGraph | 864 calls; 41 errors | Mixed; missing resources, stale indexes, and poor affected-test recall |
| Build Runner | 842 calls; 0 error envelopes | Strong; project failures are generally represented as domain outcomes |
| Test Runner | 713 calls; 66 error envelopes | Useful, but outcome semantics are inconsistent with Build Runner |
| Code Context | 474 calls; 14 errors | Useful advisory locator; recall is still below promotion bars |
| Repo Context | 236 calls; 0 errors | Useful, but directly confirmed to under-report changed-file totals |
| LSP | 340 calls; 2 errors | Low transport error, but no live server is installed and fallback relevance is weak |
| Semgrep family | 305 calls; 64 errors | Historically unreliable; current readiness improved but cohort is too small |

### 2.4 Automatic behavior

- 19 reasoning-context injection events;
- 102,941 injected characters total;
- average 5,418 characters per event;
- zero measured character savings in the live telemetry window;
- objective routing was sometimes sensible, but a read-only investigation received a mutation-oriented decomposition and irrelevant skill suggestions;
- prompt suggestions were shown 26 times and accepted 4 times;
- Hermes refinement timed out 10 times versus 7 successful shown refinements;
- auto-router suggestions have no accepted/rejected quality label, so routing precision is unknown.

### 2.5 Role execution

In the rolling aggregate, `create_subagent` recorded:

- 164 calls;
- 26 succeeded;
- 109 timed out;
- 22 failed;
- 7 unknown.

Current deterministic remediation has one successful live role-sidecar pilot, while current topology history contains only two runs with one success. This is not enough field evidence for automatic execution or a broad reliability claim.

### 2.6 Confirmed accuracy defects

1. `src/repo-context.js` caps changed paths at 15 and reports the cap as the total. A direct call said 15 changed while Git Evidence correctly reported 22.
2. `src/session-miner.js` uses file mtime as the rolling-window boundary and then counts the whole file. A one-day scan admitted rows more than one day old.
3. Session-miner trend logic compared one-day and 30-day reports and emitted false new/cleared candidate changes.
4. Generic tool-friction candidates conflate infrastructure defects with correct negative outcomes such as test/build failures, findings, safety blocks, missing prerequisites, and bounded watch timeouts.
5. LSP fallback can return unrelated symbols while reporting operational success; no live language server is installed.
6. CodeGraph can return empty/stale advisory results; affected-test experiments have not demonstrated acceptable recall.
7. Privacy Guard's global mode does not inspect the raw session tree's permission posture.
8. Project-local Privacy Guard success can be mistaken for a clean global state.

### 2.7 Privacy baseline

- 1,440/1,502 session files are mode `0644`;
- 62 session files are mode `0600`;
- 67 session directories are mode `0755`;
- 48 session directories are mode `0700`;
- one medium `full-transcript-hint` exists in Hermes state;
- aggregate audit/session-mining outputs are mode `0600`, valid JSON, and contain no home paths, session UUIDs, prompts, arguments, or outputs.

## 3. Claim boundaries

### 3.1 What the evidence supports

- Runtime registration and conflict detection are trustworthy.
- Several high-use core tools are operationally reliable.
- The listed truthfulness, temporal-comparison, fallback-relevance, and permission defects are directly reproduced.
- Role, prompt, routing, retrieval, and post-fix adapter effectiveness remain insufficient-data.

### 3.2 What the evidence does not support

- It does not establish causal productivity gains from call counts alone.
- It does not prove a tool is broken whenever a command/test/finding result is negative.
- It does not justify removing low-use tools before a same-version 30-day cohort.
- It does not justify automatic role delegation from a single pilot.
- It does not justify treating a fallback lexical query as compiler-backed semantic evidence.

### 3.3 Privacy contract

No implementation, fixture, report, or durable note may store:

- transcript excerpts or reasoning;
- prompts or assistant answers;
- raw shell commands, tool arguments, or tool outputs;
- credentials or secret-like values;
- raw session paths or stable session identifiers;
- repository source bodies in telemetry.

Permitted evidence is limited to counts, fixed categories, safe tool/operation identifiers, durations, source/config hashes, bounded error classes, session-kind categories, and anonymous cohort keys.

## 4. Program success metrics

| Area | Required bar |
|---|---|
| Session storage | 100% of selected historical files `0600` and directories `0700`; zero content-hash drift, deletion, rename, or active-session corruption |
| New-session confinement | Newly active session file and directory are hardened automatically; any unavoidable creation race is documented and bounded |
| Repo Context truth | Total changed paths match `git status --short`; truncation reports total/shown/truncated explicitly |
| Roadmap truth | Nested starts disclose parent/scope; invalid operations have typed categories; no unrelated state is silently replaced |
| Window truth | Every counted timestamped row is inside `[sinceAt, untilAt]`; undated rows are separate |
| Trend truth | Trend comparison requires identical cohort keys; mismatches produce a new baseline and no candidate deltas |
| Outcome truth | Infrastructure, domain-negative, blocked, not-applicable, cancelled, timed-out, and unknown are distinct with 100% fixture agreement |
| Telemetry coverage | At least 95% of eligible same-version model-tool results receive a canonical outcome; unknown <=5% |
| Telemetry privacy | Zero forbidden payload/path/session-ID fields; state files `0600`, directories `0700` |
| Managed-run utility | Every managed job has terminal evidence; repeated `bg_run` polling triples fall >=50% in a comparable cohort |
| Reliable-core non-regression | Git Evidence, Build Runner, Debug Ledger, AST, Roadmap, and bg-run focused/full smokes remain green |
| Reasoning relevance | Read-only tasks receive no mutation steps; objective/constraints preserved 100%; average live injection <=2,500 chars or >=60% below baseline |
| Suggestion relevance | Fixed task-set precision >=0.80; irrelevant suggestions suppressed rather than shown |
| Prompt refinement | At least 20 eligible Hermes attempts, timeout <=10%, accepted/shown >=20%; otherwise remain local-only |
| Role field reliability | >=30 eligible live read-only runs; completion >=90%, timeout <=5%, p95 <=120s, typed/accounting parity 100% |
| Code Context | Recall@5 >=0.95 and MRR >=0.90 on the fixed reviewed cohort before promotion |
| Affected-test selection | Nonzero recall and zero unsafe gating edges before any authority increase |
| LSP fallback | Exact queries return only matching symbols or explicit advisory no-match; no unrelated answer packets |
| Semgrep | Same-version infrastructure-error rate <5% over >=14 days; findings excluded from infrastructure failures |
| Memory/research | Recall facts carry freshness/provenance; Obsidian curation claims require current doctor proof |
| Release evidence | >=14 classified interactive days; 30 days for low-volume retirement; no incompatible lifetime substitution |

## 5. Non-goals

- Do not auto-enable mutating roles or hidden topology execution.
- Do not weaken policy, automation intent, completion-promise, prerequisite, or privacy enforcement.
- Do not delete or archive sessions as part of permission repair.
- Do not turn CodeGraph, LSP fallback, Semgrep, or Code Context into gates while degraded or below semantic bars.
- Do not add more default model tools to improve adoption.
- Do not use prompt pressure as a substitute for improving a tool's trigger or output.
- Do not redesign reliable core tools without a reproduced defect and regression test.
- Do not start the release cohort until all measurement-affecting P0 changes are integrated.

## 6. Phase 0 — Freeze evidence and define comparable cohorts

Priority: P0
Owner: observability maintainer

### Scope

Create a single comparison contract before changing metrics or behavior.

### Primary files

- `scripts/audit-pi-sessions.py`
- `src/session-miner.js`
- `src/extension-telemetry.js`
- `src/outcome-schema.js`
- `src/phase7-release-scorecard.js`
- `scripts/freeze-phase7-release.js`
- `.pi/extensions/learning-loop-coordinator/index.ts`
- `tests/session-miner.test.js`
- `tests/phase7-release.test.js`

### Tasks

- [ ] Preserve the recent aggregate audit under ignored private state with source/config/classifier identifiers.
- [ ] Define a cohort key containing source version, runtime-source hash, config version, classifier version, outcome schema, session-kind policy, `sinceAt`, `untilAt`, and `windowDays`.
- [ ] Require exact cohort-key equality before computing rates, deltas, or candidate changes.
- [ ] On mismatch, return `baseline=true`, a fixed `comparisonReason`, and no new/cleared candidate list.
- [ ] Preserve exact active-session exclusion accounting: requested, matched, unmatched, and excluded.
- [ ] Make scorecard generation fail closed on source/config/classifier drift.
- [ ] Add a regression for one-day versus 30-day reports.

### Gate

- Same-key scans produce stable, reproducible deltas.
- Cross-key scans produce an explicit non-comparable baseline.
- No private content appears in serialized state.

### Rollback

Disable new comparisons and retain aggregate baseline generation; never fall back to comparing incompatible reports.

## 7. Phase 1 — Secure session and memory state

Priority: P0
Owners: privacy and runtime maintainers
Depends on: Phase 0 evidence identifiers only

### Primary files

- `src/session-hygiene.js`
- `.pi/extensions/runtime-doctor/index.ts`
- `.pi/extensions/privacy-guard/index.ts`
- Hermes memory state/cache handling
- `tests/session-hygiene.test.js`
- Privacy Guard, Hermes, and storage-conformance tests

### Tasks

#### 1A. Historical session permissions

- [ ] Extend dry-run output with aggregate mode counts, active-session exclusions, symlink counts, errors, and a manifest fingerprint.
- [ ] Apply only a previously previewed manifest.
- [ ] Use canonical confinement and no-follow operations.
- [ ] Change permissions only: JSONL files to `0600`, directories to `0700`.
- [ ] Never delete, archive, rename, truncate, or rewrite session contents.
- [ ] Exclude the active session unless in-place hardening is proven safe.

#### 1B. New-session permissions

- [ ] Harden the active session directory and file at session start and after session replacement.
- [ ] Determine whether Pi core can create private modes atomically.
- [ ] If not, document the initial race and add the narrowest upstream patch or process-umask solution.

#### 1C. Privacy Guard coverage

- [ ] Add metadata-only session permission posture to global scans without reading session bodies.
- [ ] Include session-audit and session-mining state roots in managed checks.
- [ ] Make project/global/raw-session scope explicit in every result.
- [ ] Review the medium Hermes transcript-hint locally without copying matching text.
- [ ] Fix the writer/migration if genuine; otherwise add a narrow, source-aware false-positive rule with a regression.

### Gate

- Preview and apply counts agree exactly.
- Post-apply selected corpus is 100% `0600`/`0700`.
- File content hashes do not change.
- Global privacy report has zero unreviewed actionable findings.

### Rollback

Permission rollback, if ever required, must be a separate explicit reviewed operation. Startup may tighten but never loosen modes.

## 8. Phase 2 — Make counts, windows, outcomes, and trends truthful

Priority: P0
Owner: observability maintainer
Depends on: Phase 0

### Primary files

- `src/repo-context.js`
- `.pi/extensions/repo-context/index.ts`
- `tests/repo-context.test.js`
- `src/session-miner.js`
- `src/outcome-schema.js`
- `src/extension-telemetry.js`
- `src/pi-extension-kit.js`
- session-miner, outcome, telemetry, and coordinator tests

### Tasks

#### 2A. Repo Context

- [ ] Count every changed path before truncating display rows.
- [ ] Add `totalChanged`, `shownChanged`, and `truncated` fields.
- [ ] Render `22 changed (showing 15)` rather than claiming 15 total.
- [ ] Cover clean, capped, untracked, rename, detached, non-Git, and unborn-branch cases.
- [ ] Cross-check against Git Evidence in an integration fixture.

#### 2B. Row-strict windows

- [ ] Use file mtime only as an opening/cache optimization.
- [ ] Apply `sinceAt` and `untilAt` to every timestamped row before aggregation.
- [ ] Count undated rows separately and exclude them from strict post-fix rates by default.
- [ ] Record earliest/latest counted row and prove both lie inside the requested interval.

#### 2C. Canonical outcome taxonomy

Add and use:

- `succeeded`;
- `domain-negative`;
- `blocked`;
- `not-applicable`;
- `cancelled`;
- `timed-out`;
- `infrastructure-failed`;
- `unknown`.

- [ ] Stop treating every `isError` envelope as transport failure.
- [ ] Let extensions declare expected negative outcomes by operation.
- [ ] Classify failed tests/builds, findings, dirty Git readiness, missing verification evidence, safety blocks, and bounded watch timeouts correctly.
- [ ] Generate generic tool-friction candidates only from infrastructure/contract failures.
- [ ] Keep tool-specific semantic bars separate from infrastructure reliability.

#### 2D. Model-tool and session-kind telemetry

- [ ] Emit metadata-only model-tool lifecycle records using the canonical outcome schema.
- [ ] Join records to a coarse session-kind category without paths or stable session IDs.
- [ ] Preserve command, prompt suggestion, context injection, and router telemetry.
- [ ] Report unknown-rate and eligible denominator explicitly.

### Gate

- Repo Context and Git Evidence totals agree.
- One-day fixtures contain only one-day rows.
- Cross-window trend fixture emits no false candidate changes.
- Canonical outcome fixtures agree 100% across Build Runner, Test Runner, Privacy Guard, Evidence Binder, Automation Loop, Run Deck, Git Evidence, and an injected adapter crash.
- Eligible unknown outcomes <=5% after instrumentation.

### Rollback

Retain old reports as schema-versioned historical evidence; never reinterpret old unknown outcomes as post-fix truth.

## 9. Phase 3 — Improve high-use core efficiency without regressing reliability

Priority: P1
Owners: runtime and workflow maintainers
Depends on: Phase 2 outcomes/telemetry

### Primary files

- `src/bg-jobs.js`
- `src/run-monitor.js`
- `src/run-deck.js`
- `.pi/extensions/bg-run/index.ts`
- `extensions/run-monitor/index.ts`
- `.pi/extensions/run-deck/index.ts`
- `.pi/extensions/roadmap/roadmap-state.js`
- `.pi/extensions/roadmap/index.ts`
- `src/debug-ledger.js`
- `src/fix-recall.js`
- corresponding tests

### Tasks

#### 3A. Managed process utility

- [ ] Add metadata-only per-job counters for start, status, logs, monitor attachment, settlement notification, and final evidence.
- [ ] Recommend `run_monitor` for explicit periodic notification requests.
- [ ] Keep manual status/log access available.
- [ ] Capture settlement once; do not start autonomous model turns.
- [ ] Measure status/log calls per started job and repeated-three-call workflows.

#### 3B. Roadmap scope and error visibility

- [ ] Return parent roadmap ID/title and `nested=true` for nested starts.
- [ ] Classify stale item, invalid operation, missing parent, and persistence failures.
- [ ] Preserve active roadmaps unless the user explicitly requests root replacement.
- [ ] If supported, add an explicit user-confirmed path for an unrelated new root roadmap.

#### 3C. Debug Ledger and Fix Recall value

- [ ] Preserve the current durable attempt/resolution workflow.
- [ ] Attribute Fix Recall retrieval to a later attempt verdict without storing error text.
- [ ] Measure whether recalled fixes reduce repeated no-change/worse attempts.
- [ ] Do not auto-apply recalled changes.

#### 3D. Reliable-core non-regression

- [ ] Keep Git Evidence truthfulness and Build Runner domain semantics unchanged.
- [ ] Keep AST preview/apply checkpoints and confinement.
- [ ] Run focused and full extension smokes before promotion.

### Gate

- 100% managed jobs in fixtures have terminal evidence.
- Repeated polling triples fall >=50% in a comparable 14-day cohort.
- Roadmap errors are 100% typed in fixtures.
- Fix Recall effectiveness is reported as measured, unknown, or insufficient-data rather than assumed.

### Rollback

Disable monitor guidance/telemetry independently while preserving bg-run, run-deck, and manual commands.

## 10. Phase 4 — Improve reasoning, routing, skill, and prompt relevance

Priority: P1
Owner: reasoning/runtime maintainer
Depends on: Phase 2 telemetry

### Primary files

- `src/reasoning-injection.js`
- `.pi/extensions/reasoning-runtime/index.ts`
- role-router and skill-selection libraries
- `src/prompt-suggestion-policy.js`
- `extensions/prompt-suggestions/index.ts`
- reasoning injection, router, skill, prompt, and TUI tests

### Tasks

#### 4A. Task-modality correctness

- [ ] Add fixed fixtures for read-only investigation, planning, implementation, verification-only, publish, credential, and destructive intents.
- [ ] Read-only investigation must never receive apply/change subtasks.
- [ ] Verification-only must not imply repair.
- [ ] Publish and destructive actions remain separately confirmed and blocked from automatic delegation.
- [ ] Preserve objective, constraints, and public evidence without exposing scratchpads.

#### 4B. Context budget

- [ ] Set a live average target of <=2,500 injected characters or >=60% reduction from baseline.
- [ ] Inject unchanged sections zero times.
- [ ] Prefer concise active objective, constraints, decisions, and current warnings.
- [ ] Move historical detail behind explicit inspection tools.
- [ ] Measure first/delta/rendered/injected/saved characters by classified interactive turn.

#### 4C. Router and skill quality

- [ ] Record shown, accepted, dismissed, overridden, and corrected metadata.
- [ ] Calibrate a fixed-task relevance threshold.
- [ ] Suppress suggestions below threshold rather than adding low-confidence prompt noise.
- [ ] Keep auto-router in `suggest` unless explicitly invoked.

#### 4D. Prompt suggestions

- [ ] Preserve immediate deterministic local suggestions.
- [ ] Keep Hermes refinement bounded and asynchronous.
- [ ] Require >=20 eligible attempts, timeout <=10%, and accepted/shown >=20%.
- [ ] If bars fail, default to local-only instead of retrying on the prompt hot path.

### Gate

- Fixed read-only fixtures contain no mutation steps.
- Objective and constraint preservation is 100%.
- Suggestion precision >=0.80 on reviewed fixtures.
- Context budget passes deterministic and 14-day live gates.
- User correction rate does not regress.

### Rollback

Disable router/skill/prompt refinement independently. Static objective and safety context remain available.

## 11. Phase 5 — Establish role/subagent field reliability

Priority: P1, promotion-gated
Owner: role-runtime maintainer
Depends on: Phase 2 outcome truth and Phase 4 routing boundaries

### Primary files

- `src/subagents.js`
- `src/subagent-result-validator.js`
- `src/subagent-workspaces.js`
- `src/role-runtime-rollout.js`
- `.pi/extensions/reasoning-runtime/index.ts`
- `extensions/role-sidecar/index.ts`
- `scripts/benchmark-role-runtime.js`
- role, subagent, topology, budget, and TUI tests

### Tasks

- [ ] Keep top-level routing in `suggest`.
- [ ] Require explicit command/tool invocation for delegation.
- [ ] Keep mutating roles isolated and patch transfer explicit.
- [ ] Define eligible live runs; exclude deliberate invalid fixtures and operator cancellations from completion rates without hiding genuine failures.
- [ ] Record terminal category, model/tool accounting, typed-result validity, duration, runtime/source version, and mutation mode.
- [ ] Require >=30 eligible live read-only runs before field promotion.
- [ ] Keep sample size visible beside every rate.
- [ ] Fail closed to R0 on stale, future, mismatched, or unverifiable benchmark evidence.
- [ ] Keep R5 and hidden automatic mutation unauthorized.

### Gate

- Completion >=90%.
- Timeout <=5%.
- p95 <=120 seconds.
- Typed-result and model/tool accounting parity 100%.
- Terminal errors, malformed results, budget breaches, incomplete tool use, and timed-out mutation are never success.
- Suggest mode starts zero hidden child runs.

### Rollback

`PI_ROLE_ROLLOUT_STAGE=R0` and `PI_ROLE_RUNTIME_VERSION=1` remain immediate state-preserving fallbacks.

## 12. Phase 6 — Raise retrieval and adapter semantic quality

Priority: P1/P2
Owners: retrieval and static-analysis maintainers
Depends on: Phase 0 cohort contract

### Primary files

- `src/code-context-service.js`
- `src/code-context-rollout.js`
- `src/code-context-telemetry.js`
- `src/codegraph-adapter.js`
- `src/lsp-adapter.js`
- `src/lsp-fallback.js`
- `src/lsp-session-manager.js`
- `src/semgrep-adapter.js`
- provider extensions, fixed gold cohorts, benchmarks, and tests

### Tasks

#### 6A. Code Context

- [ ] Keep Code Context as the provider-neutral model surface.
- [ ] Diagnose query generation, candidate generation, ranking, and packing separately.
- [ ] Preserve reviewed fixed cohorts and zero-degradation controls.
- [ ] Do not promote on transport success alone.

#### 6B. CodeGraph

- [ ] Include freshness, revision, pending changes, degradation, and gating safety in every result.
- [ ] Return explicit stale/degraded status rather than a bare empty answer when the index is not authoritative.
- [ ] Keep affected-test output advisory until recall is demonstrated.
- [ ] Sync after relevant edits without blocking ordinary prompt turns.

#### 6C. LSP

- [ ] Make fallback workspace-symbol queries honor the requested symbol.
- [ ] Return only matching results or an explicit advisory no-match.
- [ ] Never imply compiler resolution without a live server/compiler backend.
- [ ] Require live-LSP hashed preview before semantic rename apply.
- [ ] Consider hiding unsupported live capabilities when no server exists.

#### 6D. Semgrep

- [ ] Preserve explicit binary/config/scan readiness.
- [ ] Distinguish findings from infrastructure failure.
- [ ] Run cold-config regression coverage.
- [ ] Keep CodeGraph supplement failure separate from Semgrep scan success.

### Gate

- Code Context Recall@5 >=0.95 and MRR >=0.90.
- Affected-test selection has nonzero recall and zero unsafe gating edges before authority increases.
- LSP exact-symbol fixtures return no unrelated packets.
- Semgrep same-version infrastructure error <5% over >=14 days.
- Stale/degraded providers remain advisory in all integration tests.

### Rollback

Provider-specific integrations can be disabled independently; baseline read/AST/test inference remains available.

## 13. Phase 7 — Improve memory and research usefulness without hidden scope

Priority: P1/P2
Owners: memory and research-memory maintainers
Depends on: Phase 1 privacy and Phase 2 telemetry

### Primary files

- `extensions/hermes-memory/index.ts`
- Hermes client/state handling
- `src/obsidian-adapter.js`
- `.pi/extensions/obsidian/index.ts`
- memory, Hermes, Obsidian, prompt, and privacy tests

### Tasks

#### 7A. Hermes recall

- [ ] Add source/freshness categories to recall metadata.
- [ ] Distinguish current Git facts, durable project memory, and stale prior summaries.
- [ ] Score a fixed set of factual recall assertions without storing user prompts.
- [ ] Report omission/staleness separately from contradiction.
- [ ] Preserve bounded timeouts and cancellation at shutdown.

#### 7B. Obsidian scope

- [ ] Keep local Markdown search/note available without desktop or Hermes.
- [ ] Inject awareness only for explicit research/vault intent or a narrowly measured trigger.
- [ ] Require current doctor evidence before claiming auth/provider/curation readiness.
- [ ] Preserve symlink/canonical confinement and no-follow writes.

#### 7C. Prompt refinement dependency

- [ ] Share one Hermes readiness/timeout policy with Prompt Suggestions.
- [ ] Avoid repeated provider attempts when readiness or live bars fail.

### Gate

- Fixed recall assertions reach >=90% factual correctness with explicit freshness labels.
- Local Obsidian operations pass without desktop/provider dependencies.
- Curation claims require a current bounded synthetic-input dry run.
- No memory path stores transcript bodies or credentials.

### Rollback

Disable automatic recall/refinement/awareness independently; explicit local commands remain.

## 14. Phase 8 — Reassess adoption and portfolio only after truth is fixed

Priority: P2
Owner: extension product maintainer
Depends on: Phases 2-7 telemetry and mature cohort

### Tasks

- [ ] Recompute usage with classified interactive denominators.
- [ ] Measure utility by trigger-eligible opportunities, not raw call count alone.
- [ ] Separate high use from high value and low use from unavailable opportunity.
- [ ] Track reliable-core displacement of shell rituals without treating every shell command as replaceable.
- [ ] Keep experimental command-only surfaces command-only unless unique-trigger and value bars pass.
- [ ] Use 30 days before retire/merge decisions for low-volume tools.
- [ ] Preserve command/state migration and rollback instructions for any lifecycle change.
- [ ] Do not add a new default tool without a unique trigger and non-overlap explanation.

### Gate

Every extension has:

- owner;
- unique trigger;
- canonical/overlap decision;
- dependency readiness;
- privacy/mutation class;
- measurable success metric;
- sample size and observation window;
- lifecycle decision;
- rollback/migration path.

### Rollback

Restore command compatibility and prior exposure from explicit versioned settings; never discard state during lifecycle rollback.

## 15. Phase 9 — Integrated verification, new freeze, observation, and decision

Priority: release gate
Owner: verifier/integrator
Depends on: all P0 work and selected P1 implementation

### Tasks

- [ ] Run focused tests after each workstream.
- [ ] Run extension load and all isolated RPC smokes.
- [ ] Run full-fleet model smoke.
- [ ] Run prompt, reasoning, skill, subagent, topology, and relevant TUI checks.
- [ ] Run Semgrep and Privacy Guard project/global checks.
- [ ] Verify audit/telemetry artifacts contain no forbidden fields.
- [ ] Run `scripts/check-all.sh` on the integrated final tree.
- [ ] Run `gitverify` and inspect the final diff.
- [ ] Freeze source/config/classifier/outcome/session-kind versions only after measurement-affecting changes stop.
- [ ] Collect >=14 classified interactive days.
- [ ] Collect 30 days for low-volume portfolio decisions.
- [ ] Publish pass/fail/insufficient-data with sample sizes and eligible denominators.

### Release decision

**Ship** only when:

- all P0 truth/privacy bars pass;
- reliable core has no regression;
- exact-version cohort is mature;
- field claims meet sample bars;
- provider/retrieval claims meet semantic and infrastructure bars;
- irreversible portfolio decisions have 30-day evidence.

**Partial rollout** when:

- P0 passes but one optional provider or role field bar is insufficient;
- the feature remains explicit/advisory with a documented rollback.

**No-go** when:

- session privacy remains exposed;
- incompatible cohorts are compared;
- correct negative outcomes are still reported as infrastructure defects;
- fallback results overclaim semantic authority;
- role failures can appear successful;
- telemetry persists forbidden content.

**No-go-deferred** when:

- deterministic checks pass but required temporal/sample evidence is incomplete.

## 16. Delivery waves and dependencies

| Wave | Work | Dependencies | Parallelism |
|---|---|---|---|
| A1 | Phase 0 cohort contract and Phase 2 window/trend fixtures | none | parallel with A2/A3 until outcome integration |
| A2 | Phase 1 session permission preview/apply and privacy scope | none | parallel with A1/A3 |
| A3 | Phase 2 Repo Context truth fix | none | parallel with A1/A2 |
| B1 | Canonical outcome schema and model-tool/session-kind telemetry | A1 | shared integrator required |
| B2 | Roadmap and managed-process utility | B1 | parallel with B3/B4 |
| B3 | Reasoning, routing, skills, prompt relevance | B1 | parallel with B2/B4 |
| B4 | Role field instrumentation and explicit-mode checks | B1 | parallel with B2/B3 |
| C1 | Code Context/CodeGraph | A1 | parallel with C2/C3 |
| C2 | LSP fallback/server behavior | A1 | parallel with C1/C3 |
| C3 | Semgrep reliability | A1 | parallel with C1/C2 |
| D | Hermes/Obsidian usefulness and privacy | A2/B1 | parallel with retrieval integration |
| E | Integrated verification and new freeze | all selected implementation | serial |
| F | 14/30-day observation and scorecard | E | no source/config drift |

### Shared conflict zones

One integrator must own changes to:

- `src/session-miner.js`;
- `src/outcome-schema.js`;
- `src/extension-telemetry.js`;
- `src/pi-extension-kit.js`;
- `.pi/extensions/reasoning-runtime/index.ts`;
- session-hygiene/Privacy Guard global roots;
- generated scorecards and runtime/productization docs.

## 17. Verification ladder

### Per-work-item minimum

1. Unit regression for the reproduced defect.
2. Focused extension/library test.
3. Behavioral RPC/TUI smoke where user-visible behavior changes.
4. Privacy serialization check for any state/telemetry change.
5. Static analysis for security/input/filesystem boundaries.
6. Exact metric expected to move and preregistered bar.
7. Rollback control and residual risk.

### Integration gates

- affected focused tests;
- extension import/load tests;
- 47 isolated RPC extension probes;
- full-fleet model smoke;
- TUI checks for changed interactive extensions;
- `scripts/check-all.sh`;
- Privacy Guard project and global scans;
- Semgrep focused scan;
- audit/telemetry content prohibition checks;
- `git diff --check` and `gitverify`.

### Evidence packet

Every completed item records:

- changed files;
- source/config/classifier version;
- test/verifier command and outcome;
- behavioral evidence;
- privacy/static outcome;
- measured metric versus bar;
- rollback;
- residual risk or insufficient-data status.

A green unit suite does not establish field effectiveness. A high call count does not establish value. A negative domain result does not establish extension failure.

## 18. Risk register

| Risk | Mitigation |
|---|---|
| Permission migration affects active sessions | dry-run manifest, active exclusion, permission-only apply, content hashes |
| Telemetry leaks content | fixed schemas, forbidden-field tests, mode `0600`, no stable session IDs |
| Measurement changes reset cohort | complete P0 before freeze; fail on version drift |
| Outcome taxonomy hides genuine failures | explicit infrastructure category and injected crash fixtures |
| Prompt changes increase noise | fixed relevance fixtures, injection budget, acceptance/correction telemetry |
| Role sample is dominated by synthetic invalid cases | explicit eligible-run definition while retaining genuine failures |
| Provider availability changes rates | readiness/freshness dimensions and same-config cohorts |
| Retrieval optimization overfits | reviewed fixed gold cohort plus zero-degradation controls |
| Core-tool tuning regresses reliability | reliable-core regression suite and independent rollback knobs |
| Portfolio decisions remove recovery paths | 30-day minimum, migration docs, state preservation |

## 19. Immediate next actions

1. Implement Phase 0 cohort-key and cross-window trend rejection tests.
2. In parallel, implement Phase 1 permission dry-run enhancements and Phase 2 Repo Context total/truncation fix.
3. Integrate the canonical outcome taxonomy before collecting any new effectiveness rates.
4. Complete P0 privacy/truth verification.
5. Re-freeze source/config/classifier versions.
6. Start P1 effectiveness work and the eligible role/reasoning/retrieval cohorts.
7. Publish a new scorecard only after the exact-version observation bars mature.
