# CodeMode phase-timed results — 2026-10-24

## Recommendation: HOLD default-on merge; keep default-on unchanged

The newly preregistered cohort completed **120/120 exact answer/evidence checks**, with zero tool/provider failures, no unrun assignments, complete required phase/token coverage and unchanged source/historical/settings/credential/environment/Pi-entry fingerprints. Default-on was not changed.

The data localizes most extra time to the model/provider pipeline, not host runtime. It does **not** establish repeatable p95 neutrality: one trial improved and the other regressed substantially. A near-flat pooled p95 does not erase the failing repetition.

## Comparable trials and latency

Run: **2026-10-24, 13:33:41–13:55:00 UTC**. Two trials of the original manifest, 60 matched pairs / 120 fresh sessions, `openai-codex/gpt-6.1-sol`, `xhigh`, counterbalanced order, same within-pair prompts/fixtures/loadout/hooks. See [fixed protocol and phase definitions](codemode-phase-timing.md).

| Cohort | Direct prompt p95 | Hybrid prompt p95 | Change | <=10% regression bar |
| --- | ---: | ---: | ---: | --- |
| Trial 1 | 18.999 s | 16.583 s | -12.7% | PASS |
| Trial 2 | 22.089 s | 33.452 s | **+51.4%** | **FAIL** |
| Pooled, 60 cases/arm | 21.951 s | 22.013 s | +0.3% | PASS |

The preregistered requirement was **both trials and pooled** p95 <=1.10, so latency **failed**. Pooled mean worsened **9.726 -> 10.855 s (+11.6%)**, and median **8.569 -> 9.869 s (+15.2%)**. The older +16.5% pilot result remains unchanged; this follow-up demonstrates variability, not that its regression was repaired. There were no discarded warmups, retries or post-hoc arm changes.

## Where the time goes

Means below are per case, including simple controls that did not run scripts. These are measured intervals, not differences between unrelated p95 quantiles.

| Phase | Direct | Hybrid | Difference |
| --- | ---: | ---: | ---: |
| Model/provider pipeline | 9716.726 ms | 10760.442 ms | **+1043.716 ms** |
| Request to first normalized delta | 8622.463 ms | 8611.848 ms | -10.615 ms |
| First delta to finalized message | 1091.729 ms | 2146.360 ms | **+1054.631 ms** |
| Top-level tool pipeline, unioned | 4.753 ms | 89.544 ms | +84.791 ms |
| Other harness | 4.585 ms | 5.442 ms | +0.857 ms |
| CodeMode non-nested, included in tools | 0 | **85.611 ms** | Not an additional additive phase |

**92.4% of the 1129.4 ms mean penalty lies in the model/provider pipeline.** The after-first-delta interval roughly doubled. CodeMode non-nested p95 was **199 ms** across treatment cases; its mean among the 40 scripted cases was 128 ms. It includes startup, JS, discovery, serialization and hooks, not just QuickJS. HTTP-header timing was unavailable on this transport and remains null. Phase overlap was zero.

The slowest treatment case took **35.130 s**: **34.956 s** model/provider pipeline and **168 ms** top-level tools. Arithmetically subtracting *all* measured CodeMode non-nested time still leaves Trial 2's treatment p95 at **33.291 s**, versus direct 22.089 s. This is a bookkeeping diagnostic, not a new execution or causal counterfactual; it rules out seconds of measured host runtime as the dominant explanation here.

Model turns rose **146 -> 154**, actual reads **140 -> 181**, with **54 CodeMode invocations across 40 scripted cases** and 22518 generated-code characters. Fifteen native output spills were produced and removed after successful cases. These observations are consistent with extra generated output/round trips and imperfect filtering, not a large VM bottleneck. They do not distinguish decoding, provider scheduling, network stalls or normalization causally. Private scripts/stream contents were not retained, so exact repeated-read decisions cannot be reconstructed.

Prompt time excludes setup and postprocessing; both were measured separately. Mean setup was 163 ms for direct sessions; mean postprocessing was 84 ms. Legacy-comparable prompt-plus-accounting wall is retained in the summary, rather than silently comparing the historical integrity-inclusive timer to the new prompt-only timer.

## Actual token difference, including cache

These are **SDK-normalized provider usage counters**, not character estimates. Input includes cache reads/writes; output already includes the reasoning subset. Every total was cross-checked against SDK `totalTokens`.

| Counter, pooled | Direct | Hybrid | Difference |
| --- | ---: | ---: | ---: |
| Uncached input | 352031 | 209973 | -142058 (-40.4%) |
| Cache reads | 121856 | 235008 | +113152 (+92.9%) |
| Input including cache | 473887 | 444981 | **-28906 (-6.1%)** |
| Output including reasoning | 6372 | 9801 | **+3429 (+53.8%)** |
| Reasoning subset, not added again | 523 | 277 | -246 |
| **Total input + output** | **480259** | **454782** | **-25477 (-5.3%)** |

Cache writes were zero. Non-reasoning output increased 5849 -> 9524 (+62.8%). Reasoning counts are the SDK's reported breakdown, not private thinking time or proof that a zero means no internal reasoning. Trial-level total-token reductions were **8.3%** and **2.2%**.

| Workload, 20 cases/arm | Direct total tokens | Hybrid total tokens | Change |
| --- | ---: | ---: | ---: |
| Simple controls | 98642 | 130000 | **+31.8%** |
| Four-file batches | 242867 | 148451 | **-38.9%** |
| Dependent chains | 138750 | 176331 | **+27.1%** |
| All composed tasks | 381617 | 324782 | **-14.9%** |

The character/4 context estimate fell **26.6%** on composed tasks and **17.1%** overall. Those are not actual token reductions. Separate read-only historical reanalysis finds **6.3%** overall / **16.4%** composed total-token savings in the older cohort, not its 18.5% / 28.5% character-estimate reductions. Its original files remain untouched; its SDK total/reasoning breakdown was not retained.

SDK-reported catalog-priced cost fell **USD 0.7799676 -> 0.5414568 (-30.6%)**, total **USD 1.3214244**. This is not an invoice or a marginal subscription charge. Increased cache reuse helps explain why cost savings exceed token savings; a different cache mix need not reproduce them.

## Verdict and limits

Quality, measurement, composed estimated-context and reported-cost bars passed; repeatable p95 neutrality **failed**. **HOLD an unconditional default-on merge recommendation.** The next investigation target is model/output/tool-selection efficiency, not VM startup. This is not authorization to switch off CodeMode, force scripting or change provider/thinking level; default-on remains as requested.

These remain repeated synthetic templates under a shared host/provider, not representative field sessions, a causal model/runtime ablation or statistical noninferiority proof. No private reasoning, prompts, provider payloads, headers or generated scripts were persisted.

## Evidence and verification

- Immutable new evidence: `.pi/codemode-phase-benchmark/live-1792848822532/{protocol,summary}.json`, 120 case records and 120 pre-prompt assignment markers.
- Measured source SHA-256: `a0778b4905cd62958f2466b271bb7d23af7d762c42c8c48e1f03ef053f3dcf51`; original manifest digest unchanged.
- New raw cohort file-tree SHA-256: `1775c8ebe8d4ecd43d9d1d00173b58829b9481e9cd3ba4d9739dd71b69277823`.
- Historical file-tree digest before/after: `47efddf913bdbfb915ef3f2df2571aa4fd6505f2c523dd4996abe52741e15c7b`.
- Separate exact analysis: `.pi/codemode-phase-verification/analysis.json`; historical token reanalysis: `historical-tokens.json` there. Neither replaces a measured case or summary.
- After the run, a synthetic arithmetic counterexample exposed premature three-decimal cost aggregation: 0.003 -> 0.0034 could falsely pass a 10% bar. Aggregation now retains full monetary precision with regression coverage. **Every actual cohort gate verdict is unchanged.** The original summary with rounded display totals is preserved; separate analysis uses exact per-case costs. Timing/token instrumentation and all paid records were unchanged, with no rerun.
- Twelve distinct relevant preflight checks passed, including six native arm-by-kind conformance sessions inside the phase unit command. The phase suite passed again after the precision fix. Scoped Git/static evidence and final checks are recorded in [CodeMode verification](codemode-verification.md); no broad live/TUI suite was substituted.
- New artifacts were approximately 1.1 MiB, below the 64 MiB cap across owned evidence roots. Successful fixtures and 15 owned native spills were cleaned; historical/failure evidence was not deleted. Managed-job peak RSS was about 238 MiB.

No default change, global installation/settings/credential edit, commit, merge or push was performed.
