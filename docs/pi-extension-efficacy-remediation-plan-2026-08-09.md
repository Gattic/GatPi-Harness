# Pi extension efficacy remediation plan

Version: 1
Date: 2026-08-09
Status: deterministic implementation complete; field-effectiveness and retirement decisions remain no-go-deferred
Source: privacy-safe audit of 1,537 local Pi session files through 2026-08-09
Baseline commit: `08284ea`
Decision state: no-go-deferred for field-effectiveness and retirement claims until the required opportunity-aware cohorts mature

## 1. Objective

Repair the measurement and evidence defects found by the August 2026 extension-effectiveness audit without widening model authority or storing private content. The implementation must make telemetry idempotent, reconcile evidence against the current working tree, bound default status output, expose legacy trace privacy debt through safe previews, report provider freshness consistently, measure managed-process usage accurately, and prevent low-use retirement decisions without a mature opportunity-aware cohort.

## 2. Claim boundaries

### Supported after deterministic verification

- duplicate telemetry rows are suppressed on write and deduplicated on read;
- reports expose raw, unique, and duplicate row counts;
- fixed-trigger opportunity records use only reviewed metadata fields;
- evidence freshness is evaluated against the current tree fingerprint and time;
- default evidence/status responses are bounded, with explicit detailed inspection retained;
- payload-bearing legacy traces can be classified and reviewed without reading payload values into reports or deleting files;
- CodeGraph status and doctor consume one freshness verdict;
- managed-process attachment, polling, notification, and terminal-evidence counters follow one event contract;
- portfolio policy refuses low-use retirement authority without a current-session-excluded 30-day opportunity cohort.

### Not supported by this implementation alone

- causal productivity improvement;
- high user value from call volume;
- retirement or merge of any extension;
- promotion of CodeGraph, LSP fallback, Semgrep, role execution, or memory automation;
- field reliability before the specified temporal and sample-size gates mature.

Negative domain results, policy blocks, missing prerequisites, cancellations, and bounded observation timeouts are not infrastructure failures.

## 3. Privacy and safety contract

Telemetry and reports may contain only fixed categories, safe extension/tool/operation/trigger identifiers, coarse session kinds, anonymous local-salt session tokens, counts, sizes, durations, timestamps, hashes, and bounded status metadata.

They must not persist or render prompts, transcript text, private reasoning, tool arguments, raw outputs, credentials, source bodies, payload values, private paths, raw session identifiers, or deletion candidates outside explicit preview metadata.

Legacy trace handling is preview-only by default. No trace is deleted, truncated, archived, or rewritten by classification or review. Any future purge must remain a separate explicit guarded apply against an unchanged preview identity.

## 4. Phase 1 — Telemetry integrity and utility denominators

Primary files:

- `src/extension-telemetry.js`
- `src/extension-portfolio.js`
- `src/harness-metrics.js`
- telemetry, portfolio, and metrics tests

Tasks:

1. Deduplicate events by validated `eventId` on read while preserving deterministic ordering.
2. Prevent an already persisted identical `eventId` from being appended again.
3. Report `rawEventCount`, `uniqueEventCount`, `duplicateEventCount`, and duplicate-ID group count.
4. Preserve schema filtering and current-session exclusion before utility aggregation.
5. Define a reviewed fixed-trigger registry for opportunity emission; do not infer opportunities from prompt text.
6. Report opportunity denominators only from eligible interactive events in the current-session-excluded cohort.
7. Keep adoption and utility separate; absent opportunities remain `unsupported` or `insufficient-data`, never low value.

Acceptance gates:

- repeated identical events produce one persisted row and one summarized event;
- historical duplicate rows are counted but contribute once;
- exclusion of the current session changes both action and opportunity denominators exactly;
- persisted telemetry still passes forbidden-field and private-mode checks.

Rollback:

- `PI_EXTENSION_TELEMETRY=0` remains the no-write control;
- read deduplication can be removed independently without rewriting historical state;
- no legacy schema is reinterpreted as current truth.

## 5. Phase 2 — Evidence truth and bounded context

Primary files:

- `src/evidence-binder.js`
- Verification Center and Evidence Binder extension renderers
- `.pi/extensions/output-compactor/index.ts`
- evidence, verification, and compactor tests

Tasks:

1. Introduce one privacy-safe working-tree fingerprint contract.
2. Persist the fingerprint and capture timestamp in verification-derived evidence packets.
3. Classify packets as current, stale-tree, predating, missing-fingerprint, or invalid rather than selecting the newest artifact blindly.
4. Reconcile Verification Center capture and Evidence Binder status against the current tree.
5. Return bounded packet summaries by default; require an explicit detail option for embedded verifier evidence, command lists, files, artifacts, and recent claims.
6. Extend the Output Compactor canary to evidence-heavy status tools, including `evidence_binder`, `verification_center`, and managed-run status surfaces where eligible.

Acceptance gates:

- a packet captured before a tree change cannot substantiate a current claim;
- a current passing packet remains valid;
- missing fingerprints are explicit insufficient evidence, not silently current;
- default status output stays within the documented item/character limits;
- explicit detailed inspection remains available and is itself bounded.

Rollback:

- existing evidence packet files remain readable but are non-authoritative when freshness cannot be proved;
- compactor canary remains independently disabled with `PI_OUTPUT_COMPACTOR_MODE=off`.

## 6. Phase 3 — Legacy trace privacy and provider truth

Primary files:

- `src/runtime-cleanup.js`
- `src/trace-observability.js`
- `src/codegraph-adapter.js`
- runtime cleanup, trace, CodeGraph, and provider-boundary tests

Tasks:

1. Classify trace files using bounded structural inspection: payload fields, compressed payload references, event count, bytes, age, and active/rotated status.
2. Add a metadata-only legacy payload-trace review/retention preview.
3. Keep all payload-bearing trace actions unsafe/preview-only in this remediation; do not delete by default or by ordinary cleanup apply.
4. Change new trace storage to payload capture off by default while preserving explicit opt-in for controlled debugging.
5. Make CodeGraph status, project snapshot, result metadata, and doctor use the same computed freshness object for the resolved project path.
6. Preserve advisory-only gates for CodeGraph affected tests, degraded CodeGraph, LSP fallback, Semgrep, roles, and memory automation.

Acceptance gates:

- fixtures with `payload` and `payload_ref` are classified without including payload values in output;
- dry-run and ordinary apply leave payload-bearing files unchanged;
- new default traces omit payloads;
- status and doctor report identical freshness status, degradation code, revision ID, and gating safety for the same tree;
- no provider authority is increased.

Rollback:

- explicit `capturePayloads:true` remains available for controlled trace debugging;
- CodeGraph remains disableable with `PI_CODEGRAPH=0` and advisory by default.

## 7. Phase 4 — Managed-process effectiveness

Primary files:

- `src/managed-process-metrics.js`
- `src/bg-jobs.js`
- `src/run-deck.js`
- `src/run-monitor.js`
- run-monitor extension lifecycle handling
- managed process, bg-job, run-deck, and harness-metrics tests

Tasks:

1. Use idempotent event markers for monitor attachment, settlement notification, and terminal evidence.
2. Record monitor terminal edges consistently whether settlement is found immediately or by a later timer check.
3. Keep status/log calls countable while separating model/manual polling from monitor-owned samples.
4. Reconcile start and terminal-evidence recording in both bg-run and Run Deck target state.
5. Surface rates and gaps: attachment rate, notification rate, terminal-evidence rate, and polling triples per eligible start.
6. Retain manual status/log access and recommend `run_monitor` only for explicit periodic observation/notification intent.

Acceptance gates:

- repeated notification/finalization paths increment once;
- immediate and deferred settlements produce the same counters;
- monitor checks do not masquerade as manual status/log calls;
- terminal targets carry one terminal-evidence category;
- aggregate metrics contain no commands, paths, output, or target IDs.

Rollback:

- monitoring can be disabled independently with `PI_RUN_MONITOR` while bg-run, Run Deck, and manual inspection remain usable.

## 8. Phase 5 — Portfolio retirement authority

Primary files:

- `src/extension-portfolio.js`
- generated portfolio docs and tests

Tasks:

1. Require a current-session-excluded interactive cohort with at least 30 observed days and adequate token coverage.
2. Require measured fixed-trigger eligible opportunities for the specific extension.
3. Require the configured minimum sample before utility status can authorize human retirement review.
4. Distinguish `high-use`, `low-use`, `unsupported`, `insufficient-data`, and measured value status.
5. Keep lifecycle mutation human-review-only; implementation may authorize review but never retire automatically.

Acceptance gates:

- 30 days of usage without opportunities remains no-go-deferred;
- opportunities without current-session exclusion remain non-gating;
- mature opportunity-aware evidence may produce `review-required`, never automatic mutation;
- generated records retain rollback controls and state-preservation language.

Rollback:

- no extension, command, tool, or state is removed during this plan.

## 9. Verification ladder

Per subsystem:

1. add a deterministic regression for the reproduced defect;
2. run inferred focused tests;
3. run compiler/LSP diagnostics where relevant;
4. run focused Semgrep for filesystem, privacy, and unsafe rendering changes;
5. inspect serialization for forbidden fields and file modes;
6. inspect the final diff and affected-test hints.

Integrated gate:

- telemetry, portfolio, evidence, verification, cleanup, trace, CodeGraph, bg-run, Run Deck, run-monitor, output-compactor, harness metrics, extension import/load, and provider-boundary tests pass;
- extension/TUI smokes for changed registrations pass;
- Privacy Guard reports no new actionable managed-state finding;
- full repository verification passes through the managed long-run path;
- `gitverify` passes on the final tree.

A deterministic green suite establishes implementation behavior only. Field-effectiveness and retirement claims remain no-go-deferred until their cohorts mature.

## 10. Delivery order and rollback discipline

1. Land telemetry integrity first because every later policy depends on trustworthy counts.
2. Land evidence reconciliation and bounded rendering next.
3. Land trace preview/default privacy and CodeGraph freshness unification.
4. Land managed-process event consistency and metrics.
5. Land portfolio authority enforcement after the denominator contract is stable.
6. Run full verification, update operational documentation, and record residual insufficient-data limits.

Each phase must preserve a working end-to-end product. Do not add compatibility layers or migrate historical content. If a phase regresses focused tests, revert that phase rather than weakening its gate.

## 11. Implementation result

Completed 2026-08-09 against baseline `08284ea`:

- telemetry writes suppress repeated current event IDs; current reads and compatible prompt-policy reads deduplicate historical IDs; reports expose raw, unique, duplicate-row, and duplicate-group counts;
- fixed opportunity triggers are bound to their owning extension and current-session exclusion precedes utility aggregation;
- portfolio schema 3 requires 30 current-session-excluded interactive days, established extension-specific low use, and at least 20 eligible fixed-trigger opportunities before human retirement review; lifecycle mutation remains human-only;
- Verification Center, Evidence Binder, and Run Deck use a shared privacy-safe tree fingerprint and capture time; stale or fingerprint-free proof cannot support ID validation, capture, or lexical claim binding;
- Binder and Verification Center status/evidence views are bounded by default, with bounded explicit detail, and evidence-heavy tools are in the Output Compactor canary;
- trace payload capture is off by default; bounded legacy-trace inspection found 12 payload-bearing files in the current local preview and emitted review-only items; no trace was deleted or rewritten;
- CodeGraph status and doctor now expose one resolved-project adapter freshness verdict and remain advisory under stale/degraded conditions;
- managed-process metrics schema 2 adds lock-protected keyed events, rates/gaps, idempotent terminal evidence, and tree freshness without removing manual status/log access.

Verification evidence:

- focused telemetry, portfolio, evidence, CodeGraph, cleanup, trace, bg-job, Run Deck, run-monitor, harness metrics, extension import/load, provider-readiness, and productization tests passed;
- compiler-backed `node --check` passed for all changed JavaScript tests and libraries; fallback balanced-syntax warnings were contradicted by the Node parser and passing tests;
- focused `p/default` Semgrep completed with zero engine errors and reported five findings on unchanged pre-existing lines (one Windows shell-spawn warning and four dynamic-regex warnings); Semgrep's field reliability cohort remains insufficient-data;
- managed job `job-msma8p9r-5c85` ran `PI_CHECK_TUI=0 bash scripts/check-all.sh` and exited 0 with all tests, 48 isolated RPC probes, full-fleet model smoke, prompt/reasoning/skill TUI checks, setup checks, and local Pi/Hermes regressions passing;
- the default-mutation topology TUI attempt correctly produced no run; the explicit deterministic fixture `PI_ROLE_MUTATION=isolated bash scripts/check-topology-tui.sh` passed in managed job `job-msma70tz-46d7`; production role mutation remains off;
- the current Privacy Guard scan reports historical managed-state debt (54 actionable pattern matches, including payload-bearing traces). This plan deliberately adds review/retention previews rather than deleting or reclassifying that state.

Residual limits:

- no field productivity or causal-value claim is made;
- no extension is authorized for automatic retirement or merge;
- CodeGraph affected-test output, LSP fallback, Semgrep, roles, and memory automation retain their existing advisory/field gates;
- the memory compounding experiment remains insufficient-data, and the parallel evidence synthesis E3 gate remains pending;
- historical payload-bearing traces remain local privacy debt until a separately authorized guarded retention action is reviewed.
