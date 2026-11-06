# Code Context Benchmark

The progressive codebase retrieval benchmark compares explicit retrieval strategies with the existing broad-read workflow. It is an evidence harness, not a synthetic score that authorizes rollout by itself.

## Fixture gate

Run:

```bash
node scripts/benchmark-code-context.js --fixture-only
```

The fixture manifest is `tests/fixtures/code-context/manifest.json`. It covers duplicate names and shadowing, source-kind exclusions, working-tree changes, malformed/truncated provider output, positive and negative source-to-test edges, and gold file/symbol/span judgments. Fixture validation makes no task-success claim.

## Run records

Measured input uses this shape:

```json
{
  "runs": [
    {
      "taskId": "locate-public-parse",
      "pairId": "pair-001",
      "revision": "<pinned-revision-id>",
      "mode": "broad-read-control",
      "success": true,
      "evidenceId": "proof_<verifier-evidence-id>",
      "critical": false,
      "metrics": {
        "localization_recall": 1,
        "definition_mrr": 1,
        "file_recall_at_5": 1,
        "relevant_span_ndcg_at_10": 0.9,
        "localization_precision": 0.5,
        "tokens_until_first_relevant_symbol": 1200,
        "tokens_until_correct_edit_location": 1800,
        "duplicate_context_ratio": 0.1,
        "unused_context_ratio": 0.4,
        "tool_calls_until_patch": 5,
        "compile_cycles_until_green": 2,
        "repository_map_budget_overruns": 0,
        "warm_retrieval_ms": 110,
        "shadow_hot_path_overhead_ms": 8,
        "trace_overhead_ratio": 0.01,
        "wall_clock_ms": 30000,
        "cost_per_successful_task": 0.2
      }
    }
  ],
  "testSelectionRuns": [
    {
      "taskId": "locate-public-parse",
      "revision": "<pinned-revision-id>",
      "evidenceId": "selection_<evidence-id>",
      "metrics": {
        "high_risk_affected_test_recall": 1,
        "affected_test_recall": 1,
        "affected_test_precision": 0.75,
        "stale_degraded_gating_count": 0
      }
    }
  ],
  "goldNormalization": 1,
  "privacyPolicyFindings": 0,
  "preregistration": {
    "nonInferiorityMargin": 0.01,
    "alpha": 0.05,
    "power": 0.8
  }
}
```

Create a report with:

```bash
node scripts/benchmark-code-context.js --input runs.json --report .pi/code-context/benchmarks/latest.json
```

Schema version 4 keeps two evidence tracks separate and binds promotion evidence to an exact source/config/fixture/strategy/provider cohort key. `runs` measures paired model retrieval/task outcomes, while `testSelectionRuns` measures impact-selected tests against historical gold tests. Retrieval runs cannot satisfy test-selection recall/precision gates, mixed or incomplete cohorts fail closed, and transport success cannot replace Recall@5, MRR, or zero-degradation evidence.

For historical experiments, first run a small fresh-provider canary, then use clean outputs for the full tracks:

```bash
node scripts/run-code-context-paired-benchmark.js --count 2 --no-resume --output .pi/code-context/benchmarks/paired-canary.json
node scripts/run-code-context-test-selection-benchmark.js --count 30 --no-resume
node scripts/run-code-context-paired-benchmark.js --count 30 --no-resume
```

Candidate worktrees are initialized and fully indexed with a pinned CodeGraph version/status fingerprint before retrieval. The runner aborts immediately unless CodeGraph has zero pending changes and a direct `code_context repoMap` canary is fresh, gating-safe, non-degraded, and nonempty. Never merge results from a failed/degraded canary with a corrected run.

## No-go remediation workflow

Diagnose a failed historical test-selection report without retaining source contents:

```bash
node scripts/diagnose-code-context-test-selection.js
```

The ignored taxonomy report records per-task category counts, candidate-edge counts, and bounded lexical recoverability. `changeImpact` may use fresh deterministic module-name, source-reference, and bounded test-content relationships to augment baseline tests. Fresh directory-wide extension load/import checks use confidence 0.78 as additive contract coverage. A single uncorroborated module mention remains advisory at 0.74; the same test referencing at least two distinct changed sources produces a fresh confidence-0.78 corroborated edge. Gold tests are used only after selection for scoring; they are never passed to `changeImpact`.

Prepare a bounded review packet before preregistering another selection experiment:

```bash
node scripts/prepare-code-context-gold-review.js --count 10
# After the human edits every label/review/evidence field:
node scripts/prepare-code-context-gold-review.js --rehash .pi/code-context/benchmarks/gold-review-10.json
node scripts/prepare-code-context-gold-review.js --validate .pi/code-context/benchmarks/gold-review-10.json
node scripts/prepare-code-context-gold-review.js --validate .pi/code-context/benchmarks/gold-review-10.json --require-approved
```

Generation leaves every judgment as `needs-review`, every review as `candidate`, and every verifier-evidence list empty. Approval validation requires final relevant/not-relevant labels with rationales, a named human reviewer and timestamp, task rationale, verifier evidence, a matching revision, and an unchanged manifest hash. Automation must not fill those human fields. The current private 10-task packet has four critical tasks and 106 judgments; approval correctly remains blocked.

Preregister bars only after approval. E0 is the synthetic relationship fixture, followed by the same strict bars at E1/E2/E3 (5/10/30 distinct historical tasks). The runner stops at the first failed stage and reuses earlier rows rather than rerunning them:

```bash
node scripts/run-code-context-remediation-gates.js --through E3 --gold-manifest .pi/code-context/benchmarks/gold-review-10.json
```

The staircase requires human-reviewed exhaustive gold judgments, at least one critical task, 100% critical-task recall, mean recall at least 95%, mean precision at least 70%, fresh environments, and zero stale/degraded selected edges at every stage. Commit-touched test files may be used for diagnostic runs, but remain `candidate` judgments: bounded history criteria must never relabel them as human-reviewed or authorize promotion. A failure is a no-go, not permission to weaken the bars.

Before any further paid paired-model run, measure prompt-only deterministic localization and classify stage failures:

```bash
node scripts/diagnose-code-context-offline-retrieval.js --count 5
node scripts/run-code-context-offline-retrieval-benchmark.js --count 5
```

The diagnostic captures only bounded paths, providers, queries, scores, and score reasons—never source bodies—and classifies every gold file as a candidate-generation miss, ranking/packing miss, or top-five hit. The benchmark initializes and pins CodeGraph at each parent revision, calls only `code_context repoMap` with the task prompt, and scores gold source paths afterward. Continue to 10 and 30 tasks only after file Recall@5 is at least 95%, file MRR is at least 0.90, and degradation is zero. Offline success is still insufficient for rollout or task-success claims.

The July 2026 remediation evidence stopped at E1. Exact relationships removed the zero-selection failure, but commit-touched tests proved non-exhaustive: semantically affected exact-path tests were counted as precision false positives, while some touched tests had no static relationship. The narrowed five-task run therefore remained a no-go (recall 0.8667, precision 0.3233, unsafe edges zero). Prompt-only retrieval also stopped at five tasks (Recall@5 0.20, MRR 0.2667, degradation zero).

A subsequent `repository-map-v2` experiment split camel/kebab/dot identifiers, issued at most eight deterministic lexical/CodeGraph queries, explicitly searched only tracked `.pi/extensions` source while default hidden-state searches remained excluded, and packed at most one Level-1 card per path. Stage diagnostics found two generation misses and six ranking/packing misses among ten gold files. Safe provider-side distinct-path pagination, multi-query coverage, non-saturating exact-term scores, bounded lexical strength, and implementation-path preference improved the fixed five-task result from Recall@5 0.20/MRR 0.15 to 0.6667/0.6667, with zero degradation; stage counts improved from 2 hits/2 generation/6 ranking misses to 6/1/3. A bounded local-reference expansion was rejected after regressing to 0.40/0.3333. At that checkpoint the strict gate still failed. The strategy remains opt-in through `queryExpansion`; normal `code_context` calls retain `repository-map-v1`.

The follow-up E8 experiment retained the reviewed gold labels, metric calculation, five historical revisions, and zero-degradation requirement. It expanded deterministic queries to 16 with morphological normalization, normalized provider-relative graph scores, preserved bounded path-level query evidence, retained the original top result while diversifying later concepts, and used retrieved local import relationships to reserve bounded interface/call-site coverage. The fixed five-task result reached Recall@5 1.0 and MRR 1.0 with five valid environments and zero degraded calls. Independent stage diagnostics reported 10/10 gold hits, zero generation misses, and zero ranking/packing misses. Nineteen focused Code Context regressions and the full integrated `PI_CHECK_TUI=1 scripts/check-all.sh` gate passed. This clears the fixed five-task semantic metric bar only; expansion to reviewed 10- and 30-task cohorts and all independent affected-test, temporal reliability, privacy, and rollout gates remain required.

The AI-candidate selection diagnostic exposed 17 misses: 14 directory-wide extension checks and three weak commit-touched module references. Selecting fresh directory coverage and multi-changed-source corroboration restored metric-only E1 to recall 0.9778, precision 0.8183, critical recall 1.0, and E2 to recall 0.9556, precision 0.9008, critical recall 1.0, with zero unsafe edges. Formal affected-test gates remain failed because reviewed gold is still absent. The later E8 prompt-only retrieval pass does not retroactively validate candidate-labeled affected-test evidence or authorize rollout.

## Metric vocabulary

A **task success** is a correct patch under the task's pinned verifier with the gold edit location localized, all required high-risk tests retained, and no privacy/policy finding. A **critical-task regression** occurs when the candidate fails a task marked `critical` that its paired control passes, or omits required high-risk verification. **Localization** means returning a normalized repository-relative gold file, symbol, or overlapping gold span before the patch. Duplicate and unused context are measured over model-visible source tokens, not provider-internal candidates.

- `localization_recall`: fraction of gold files/symbols/spans localized.
- `localization_precision`: fraction of localized files/symbols/spans that are gold-relevant.
- `definition_mrr`, `file_recall_at_5`, and `relevant_span_ndcg_at_10`: standard localization ranking quality against normalized gold judgments.
- `tokens_until_first_relevant_symbol`: cumulative model-visible retrieval/context tokens before the first gold symbol.
- `tokens_until_correct_edit_location`: cumulative model-visible tokens before the final gold edit span is localized.
- `duplicate_context_ratio`: duplicate model-visible source tokens divided by source tokens returned.
- `unused_context_ratio`: returned source tokens not cited, edited, or used in a successful verification explanation divided by source tokens returned.
- `tool_calls_until_patch`: completed tool calls before the first patch attempt.
- `compile_cycles_until_green`: build/typecheck/test correction cycles before success.
- `tests_selected_vs_tests_needed`: selected tests divided by the retrospectively required tests; recall and precision must also be reported for rollout.
- `high_risk_affected_test_recall`, `affected_test_recall`, and `affected_test_precision`: impact-selection safety and usefulness.
- `stale_degraded_gating_count` and `repository_map_budget_overruns`: hard safety counts; both must remain zero.
- `warm_retrieval_ms`, `shadow_hot_path_overhead_ms`, and `trace_overhead_ratio`: performance and observability overhead.
- `wall_clock_ms`: monotonic elapsed time for the task attempt.
- `cost_per_successful_task`: provider/model cost divided by successful tasks; unsuccessful tasks are not silently dropped from aggregate cost.

## Promotion gates

The report evaluates every measurable bar from the implementation plan. `select-tests` requires an exact schema-v4 cohort, Code Context Recall@5 at least 95%, MRR at least 0.90, zero stale/degraded retrieval rows, at least 30 distinct valid `testSelectionRuns`, normalized gold judgments, 100% high-risk recall, at least 95% affected-test recall, at least 70% precision, zero stale/degraded gating, zero map-budget overruns, no privacy/policy findings, and at least 30 paired retrieval/task outcomes with no critical regression. Every candidate row must carry one consistent `strategyId` and `providerConfigHash`. The 30-pair pilot is exploratory rather than proof of a one-point non-inferiority margin.

`on` additionally requires all ranking, token, duplication, latency, and trace-overhead bars; a preregistered non-inferiority margin; the computed powered sample size; and a paired 95% confidence-interval lower bound above the negative margin. The saved report records `promotion.selectTestsEligible` and `promotion.onEligible`. Merely setting an environment variable cannot bypass these gates.

## Reproducibility and operational success

- Pin the task manifest, repository revision, build configuration, provider versions, model/provider settings, and strategy ID.
- Use the same `pairId` for control and candidate attempts; preserve failed and corrected attempts.
- Record task success, critical regressions, fallback to broad reading, human corrections, latency, token exposure, compile cycles, and verification evidence IDs.
- Operational success means the patch is correct under the task verifier, the correct edit location was found, required high-risk tests were not omitted, and no privacy/policy finding occurred.
- Reports under `.pi/code-context/benchmarks/` are local, ignored evidence artifacts. Review and retain the exact report used for any rollout decision.

## Optional-provider scale gate

Batch 7 remains optional. Collect local scale/demand evidence with:

```bash
node scripts/probe-code-context-scale-gates.js --iterations 10
```

The ignored report at `.pi/code-context/benchmarks/scale-gate-latest.json` measures the first-party source footprint, warm `rg --json` p95, optional-provider binary availability, repository count, and explicitly supplied semantic/deep-analysis demand. By default it records one repository and zero observed deep-analysis or conceptual-miss events; provide nonzero counts only from actual trace/operations evidence. Supply `--semantic-startup-p95-ms` only from a measured live-LSP startup/indexing run.

The probe authorizes nothing automatically. It returns `block-batch-7` while local lexical latency remains within the two-second bar and no measured semantic, multi-repository, dataflow, or conceptual-retrieval pressure exists. Any eligible result means “review an isolated pilot,” not “install or expose a provider.”

## Evidence boundaries

- Record the broad-read control before enabling candidate routing for a task set.
- Compare the same task and repository revision in paired control/candidate runs. Both arms require boolean task outcomes and verifier evidence IDs.
- Count distinct `taskId` values, not repeated fixture executions: 30 pair IDs for one task still count as one representative task and cannot pass the pilot gate.
- Keep stale or degraded provider outputs advisory.
- Do not suppress baseline tests based on this benchmark until the rollout gates in the implementation plan pass.
- A fixture-only or unpaired report is descriptive and cannot promote a rollout mode.
