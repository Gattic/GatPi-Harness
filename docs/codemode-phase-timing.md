# CodeMode phase-timed follow-up

Default-on hybrid CodeMode remains unchanged. This is a newly authorized comparison, not a continuation, retry or replacement of the frozen 60-case cohort. No original protocol, case, summary or diagnostic verdict is rewritten.

## Fixed protocol

Recorded once-only command (the runner now refuses a replay):

```sh
node scripts/benchmark-codemode-phases.js --live \
  --provider openai-codex --model gpt-6.1-sol --thinking xhigh
```

The selected provider/model/thinking identity must match the intended comparison. The command has no implicit paid mode, fallback, resume or retry. Credentials are read-only; refresh/writes/deletion and stored credential commands are refused. No global settings are modified.

- Two trials of the original 30-task manifest: **60 matched pairs / 120 fresh sessions**. Prompts, fixture bytes, tools, router, compactor, policy hooks and SDK setup are identical within each pair; only CodeMode availability changes. These are new observations of the same workload, not replayed historical result files.
- Trial 0 uses the original order; trial 1 rotates the first stratum to the end and reverses arm order for every task. Both use hybrid `on`, retry/compaction disabled, and the same read-oriented loadout. Direct controls locally exclude CodeMode, without changing its default configuration.
- Freeze source, manifest, installed Pi, selected inference identity, relevant environment, global settings/credentials, historical artifact trees and existing primary/worktree experiment/debug records. Stop at provider error, timeout or integrity drift; retain all attempted assignments and mark remaining cases unrun.
- Primary latency is `prompt()` start-to-resolution, excluding setup and integrity/accounting. Also report setup, postprocessing, cleanup, and the legacy-comparable prompt-plus-accounting wall time.
- Existing p95 targets stay fixed: **both trials and pooled prompt p95 ratios <=1.10**, pooled composed estimated-context ratio <=0.75 and SDK-reported cost ratio <=1.10. Positive bounded-merge evidence additionally requires all 120 exact answer/evidence passes, zero failed tool/provider calls, complete timing/token coverage and unchanged integrity stamps. Default enablement is not automatically changed by any verdict.

Before the first model request, the runner writes its exact `protocol.json` and registers `CodeMode phase timing 2026-10-24` in the worktree experiment ledger. A second live directory or matching open experiment is refused.

## Phase definitions

| Measurement | Meaning / caveat |
| --- | --- |
| Model pipeline | `context_with_system` to finalized assistant message, per request; includes conversion/auth/request preparation, provider wait and stream consumption |
| Context-to-request | Context event to `before_provider_request`; includes the observer's character-count work |
| Request-to-response | Request event to response headers; nullable for providers/transports without that hook, overlaps other provider measures |
| Request-to-first delta | Request event to first normalized text/thinking/tool-call delta; no delta contents are retained |
| First-delta-to-end | First normalized delta to finalized message; includes stream consumption and final normalization |
| Top-level tools | Union of lifecycle intervals, so parallel reads are not counted twice |
| Nested tools | Union of actual nested lifecycle intervals; not added again to outer CodeMode wall time |
| CodeMode non-nested | Outer CodeMode union minus nested-tool union: runtime startup, JS/filtering, discovery, serialization, hooks and scheduling; **not pure VM time** |
| Other harness | Prompt wall minus union of model/top-level-tool intervals; overlap reported separately |

Per-turn and per-tool metadata permit tail-case inspection rather than subtracting unrelated p95 quantiles. Phase means and observed tail cases support attribution, not a causal VM/model ablation. The runner does not change prompts to force scripting, change the model's thinking level, patch native Pi, or add a second executor.

## Real tokens versus estimates

Provider-reported normalized counters are recorded separately:

- **Input including cache** = uncached input + cache reads + cache writes.
- **Output includes reasoning**; reasoning is reported as a subset, never added twice. Non-reasoning output is derived only when the breakdown exists.
- **Total** = input including cache + output; cross-check against SDK `totalTokens`.
- Report direct/treatment totals, absolute differences and ratios per trial, stratum and pooled cohort. Missing fields remain null, not zero.
- Character/4 transcript and provider-payload estimates remain separate, labeled estimates. Token counts and reported price are different: cache reuse can lower reported cost without a proportional reduction in total input tokens.

## Evidence and bounds

Artifacts live only under `.pi/codemode-phase-benchmark/live-*`, in private files/directories. Retain timestamp/count/name/usage metadata, not provider payloads, headers, generated scripts, raw output or private reasoning. Existing native spill files are validated; successful newly owned spills/fixtures are removed, failed owned data retained. No historical artifacts are deleted.

Across old/new owned benchmark evidence roots the cap is 64 MiB; new fixtures are capped at 128 MiB. The run stops before the next case at USD 5 **reported** cost or 45 minutes, with a 120-second per-case limit. These are observational budget checks, not a provider billing guarantee. Expected duration is approximately 20 minutes from the preceding cohort, not a completion promise.

`tests/codemode-phase-benchmark.test.js` checks interval union/decomposition, token/cache/reasoning accounting, missing data, unique assignment completeness, both-trial gating, import/credential safety, and real SDK/QuickJS event conformance for all three task kinds and both arms with synthetic provider messages. Those tests are not live performance evidence.

The completed [phase results and token differences](codemode-phase-results.md) and [updated verification/merge recommendation](codemode-verification.md) are now recorded. Neither a single pilot nor two repetitions of three synthetic templates establish field-wide or statistical noninferiority.
