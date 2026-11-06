# Full-profile acceptance feasibility audit — 2026-10-24

> **Current conclusion: no supported80%-power design within USD6/90minutes.** Correct whole-task resampling independently reconfirms9.17% for the originalN180 plan, coincidentally the same count as the defective sampler. The corrected historical upper bound is **2.023227**, not the archived1.891. The latter and its original method remain preserved, not qualifying evidence. Trial2's point-latency failure is unaffected. The corrected sizing study and concrete conditional budget options below supersede earlier planning conclusions; HOLD/defaults remain unchanged.

## Scope and unchanged release criteria

This follows the user's request to inspect the blocked full-profile acceptance and execute missing checks where feasible. All work stays on `feat/codemode-default-on` in `.worktrees/codemode-default-on`. HOLD and `PI_CODEMODE=1` remain unchanged unless actual acceptance is demonstrated; this audit does not authorize a default/configuration change, historical replay, merge or push.

The frozen [decision protocol](codemode-decision-rerun.md#b-power-qualified-acceptance), not the selected task21 study, defines the missing acceptance:

- **180 matched pairs /360 fresh sessions**, two90-pair trials, three time blocks per trial. Each block contains all30 manifest tasks:10 simple,10 batch,10 chain, both arms. Keep AB/BA balance across six blocks.
- Before inference: fixed-data planning clearance probability **>=80%**,120 simulated studies,300 bootstrap resamples per study, seed20261027; report a Wilson95% Monte Carlo interval. This is a planning model, not observed treatment power or a field guarantee.
- Every exact answer/observed-file/authority/integrity gate; zero tool/provider failures; complete numeric context, timing and reconciled usage; unchanged measured source, historical files, protected settings/credentials, native Pi/provider identity and relevant environment.
- **Both trial AND pooled prompt p95 ratios<=1.10**. Do not substitute a pooled pass for a failed repetition.
- **Pooled one-sided95% upper p95-ratio bound<=1.10**,5000 matched-task-cluster bootstrap resamples, stratified by trial/class and retaining repeated time blocks (seed20261026 in the implementation).
- Pooled composed (batch+chain) character-estimated context ratio<=.75 and reported catalog-cost ratio<=1.10. Character estimates are not actual provider-token counts.
- Existing bounds:90 minutes,USD6 reported cost,120s/case,64MiB shared evidence and128MiB fixtures. No retries, adaptive sample extensions, selected-case replacement or discarded unfavorable outcomes. No credential refresh/write or installed-Pi change.

The original once-only decision launcher correctly refuses to replay its completed diagnostic. A future authorized acceptance continuation must not bypass that guard or silently repeat56 sessions.

## Feasible offline work

```sh
node scripts/audit-codemode-acceptance.js
```

The offline-only command rejects live/override arguments and never constructs an inference session. Before computation it freezes source/protected/native/cohort hashes and an additive audit protocol. It validates the exact120-case full-profile archive, reproduces the original planning result, computes the previously absent5000-resample confidence bound on those60 historical pairs, and checks numerical sensitivity using the **same120 simulated studies with5000 resamples**. That sensitivity does not replace the frozen300-resample prerequisite, select a new N or turn retrospective evidence into new acceptance.

Audit bounds:8 minutes,1MiB new evidence within the shared64MiB cap, no generated fixtures, no paid requests or credential activity. Preserve all old data and partial checkpoints; do not rerun completed computation merely to seek a favorable result. Available disk and projected original360-session time/cost are checked, but resource headroom is not statistical adequacy.

## Acceptance-gate correctness regression

Inspection found a confirmed synthetic false-positive: `acceptanceGates` summed missing candidate context (`null`) as zero, accepted the<=.75 context bar, marked measurement complete and returned `supportsLiftingHold:true` for an otherwise passing360-case synthetic input. This is a gate bug, not a newly observed live performance result.

The calculator now requires finite positive context for every case and treats any missing/invalid composed sample as an unknown aggregate. Missing simple-case context still blocks measurement even though simple controls are excluded from the composed target. Regression coverage includes null,undefined,NaN,infinity,zero,negative and single missing samples in either arm. Heterogeneous paired-latency coverage additionally checks that the confidence resampling preserves matched/repeated observations. No threshold was relaxed.

The failing regression was observed before repair, then passed via the latest-failure rerun. Durable worktree thread: `.pi/debug-ledger/codemode-acceptance-missing-context-falsely.json`; baseline reproduction: `.pi/codemode-acceptance-audit/missing-context-before.json`. Historical records are not rewritten by this fix; their actual context coverage is checked separately.

## Findings and gate inventory

The single offline job `job-mvmoddyb-0a1c` exited0,2026-10-24 **17:30:53.857–17:31:37.311UTC**. Computation took42.258s, peak owned RSS~162MiB, with **zero live requests, zero new provider cost and no fixtures**. All archive/source/protected/Pi/provider/default/bounds checks passed.

### Reconciled gates

| Gate | Existing full-profile evidence (120 historical cases) | Missing360-case acceptance |
| --- | --- | --- |
| Exact coverage/quality/evidence | 60 pairs, both trials and all30 tasks;120/120 passes, matched fixture hashes | **NOT RUN**,0/360 |
| Numeric case timing/context/reconciled usage | PASS; every retained context value finite positive | **NOT RUN** |
| Detailed new per-turn UTC/usage/event metadata | Not retained by the older protocol; do not retrofit or call its original measurement gate failed | **NOT RUN** |
| Trial1 prompt p95 ratio<=1.10 | **0.872824 — PASS** | **NOT RUN** |
| Trial2 prompt p95 ratio<=1.10 | **1.514423 — FAIL** | **NOT RUN** |
| Pooled prompt p95 ratio<=1.10 | **1.002822 — PASS** | **NOT RUN** |
| Pooled95% upper p95-ratio bound<=1.10 | **1.891008 — FAIL**, newly computed retrospectively,5000 resamples | **NOT RUN** |
| Pooled composed character-estimated context<=.75 | **0.734111 — PASS** | **NOT RUN** |
| Pooled reported cost ratio<=1.10 | **0.694204 — PASS** | **NOT RUN** |
| Frozen/protected/native integrity | Original attestations plus unchanged raw hashes now PASS | No new measured source/assignment/observation stamps exist |

The confidence bound is an upper endpoint, **not an observed89.1% regression**. It is conditional on the specified matched-task/trial/class bootstrap, not a field guarantee. It was computed after seeing historical data and cannot become a preregistered acceptance observation. Even a favorable retrospective bound would not replace the missing360 fresh sessions; this one fails anyway. No historical record or summary was rewritten or reclassified.

### Planning and practical feasibility

The exact original planning calculation reproduced **11/120 =9.1667%** (Wilson Monte Carlo95% interval **5.1957–15.6710%**), far below80%. The fixed higher-resolution sensitivity, same120 studies with **5000 instead of300** bootstrap resamples, also yielded **11/120**. Thus coarse bootstrap count did not explain this failed prerequisite. This is planning clearance probability under an exchangeable-arm latency-neutral model, not a probability that CodeMode is neutral, an observed treatment effect or a guarantee of real-world power.

Resource checks found~446GiB free and~5.4MB retained evidence against64MiB. Linear projection from the120 archived cases gives~**63.2 minutes /USD3.9643 reported** for360 sessions, within the90-minute/USD6 caps in typical conditions; this is not a worst-case guarantee. **Capacity is not the blocker. Statistical adequacy is.** The power prerequisite still fails, so the missing live acceptance was not launched. No selected quiet cohort was substituted, N/threshold changed, completed diagnostic replayed or source guard bypassed.

### Decision and remaining work

**HOLD remains; defaults are unchanged.** No full-profile acceptance or latency fix is demonstrated. All feasible offline missing computations are complete, but live acceptance remains **unrun/blocked**, not passed and not an observed new live failure.

The next prerequisite is a separately fixed adequately powered full-profile design/budget decision before fresh inference—not another small selected rerun or a waiver disguised as verification. This audit does not choose a larger N after results, alter the original release bars, or claim a new design is already authorized/qualified. New current-telemetry acceptance would also need an acceptance-only entrypoint that preserves the original diagnostic's once-only guard. No such entrypoint is needed or used while its statistical prerequisite fails.

Stable canonical outcomes remain **2/3 complete,1 blocked** on full-profile acceptance. The audit and regression fix are completed increments, not completion of that missing outcome. No further job/inference is queued; task worktree is retained for review, with no commit, merge, push, global credential/settings change or installed-Pi edit.

## Evidence and current-source verification

- Additive audit: `.pi/codemode-acceptance-audit/audit-1792863054919/` — frozen `protocol.json`, exact `planning-reproduction.json`, `historical-confidence.json` checkpoint and `result.json`.
- Audit protocol digest: `673eff1f6c8b03f3615d4020421e1313e05adff5eb90d804c3427006e78e6f97`. Its source hash identifies the computed snapshot before this findings text and the later test-only ternary spelling correction.
- All original phase/decision/continuation raw hashes match their frozen values; audit writes are additive. There were no assigned live cases, credential refreshes or created model sessions.
- **PASS:20 changed-profile commands**, including new audit/gate regressions, native QuickJS/authority behavior, types, manifest/oracles, phase/decision/continuation collectors and native synthetic cached/full WebSocket conformance. One helper-module load among these commands is not a separate behavioral assertion. Evidence: `.pi/codemode-acceptance-audit/regression-tests.json` and `.pi/test-runner/raw/`.
- **PASS:all8 integration-boundary checks**, `.pi/codemode-acceptance-audit/integration-boundary.log`.
- Initial canonical Semgrep scan had0 findings but one PartialParsing warning for a compact numeric ternary in the new test. The spelling was corrected, not suppressed; the affected test passed again and its focused rescan returned0 findings/errors/timeouts. Both original warning and correction evidence are retained in `semgrep.json` and `semgrep-test-fix.json` in the audit evidence root.
- Final worktree-scoped registered Git/static verification is recorded separately at `.pi/codemode-acceptance-audit/gitverify-final.json`; it must not be confused with session-root/main verification. No full repository/TUI or new live performance acceptance is claimed.

## Corrected offline sizing and concrete unblock plan

The user now authorizes **sample-size and study-design planning only**, with no paid requests and no HOLD/default change. This is not authorization to launch a redesigned cohort or retroactively alter the original study.

The cluster-sampler defect was exposed by an independent weighted-count implementation checked against explicit repeated-pair samples. A synthetic seeded case produced an old passing upper bound1.0 where correct whole-task sampling yields1.117647. The reference now samples one ID per draw and retains every block of that task. Red→green regression and the existing decision/native-conformance suite pass; the original records and pre-fix reproducer remain preserved.

Current command:

```sh
node scripts/plan-codemode-acceptance.js
```

Before computation the once-only, network-disabled planner freezes a52-design grid and all source/data/protected hashes. It screens120 simulated studies/300 bootstrap draws per design, then uses an independent seed and240 studies/1000 draws to confirm all budget-boundary allocations plus the first two screened>=80% choices in each source/design family. It reports both the unchanged point>=80% criterion and, separately, whether the Monte Carlo95% lower bound reaches80%; the latter is extra planning assurance, not a changed acceptance bar.

Candidate families retain two trials and equal simple/batch/chain proportions:

- Repeat10 task clusters per trial/class for1,2,3,4,6,8,12,16,24,32,48,64 or96 blocks:60–5760 matched pairs.
- Use20,30,40,60,80,120,160,240,320,480,640 or960 independent variant clusters per trial/class, one observation each:120–5760 pairs. A20-cluster/two-block design adds a third allocation at240 pairs. New seeds do not turn the three synthetic templates into broad field coverage.
- Preserve the original six trial/class latency cells, or prospectively **interleave both trials within each time block** and model a common per-class mixture of the two historical windows. The latter requires future temporal-mixture stationarity; it is a new, explicit model/design assumption, not permission to select only the healthy task21 data.

The planner also records unvalidated shared-latency coupling, real-latency-improvement and persistent-task-shape sensitivities. These cannot qualify a viable budget plan: synchronization does not itself prove shared provider tails, and no genuine product latency reduction is assumed achieved. Marginal p95, confidence/context/cost margins, quality and authority gates remain unchanged. No trimming, winsorizing, tail removal, VM subtraction or relaxed quantile target is used.

Computational bounds:15 minutes,2MiB new additive evidence within64MiB shared retention, no fixtures, no credentials/SDK inference and zero paid requests. Every screen/confirmation checkpoint is retained, including unfavorable designs. Finite empirical CDF gaps around p95 can make power nonmonotone; a lowest passing grid point is not proof of the global minimum sample size or arbitrary-time field power.

### Results: size, design and budget

All52 screen designs,10 independently seeded confirmations,20 sensitivity rows and four deterministic budget-ceiling confirmations are retained. The original sampler correction does **not** make the oldN180 design adequate: the correct reference and independently optimized engine both yield11/120=9.17%. The corrected retrospective5000-resample historical upper bound is **2.023227>1.10**. The historical Trial2 point ratio remains1.514423; no live result or frozen artifact was changed.

| Proposed design | Matched pairs / fresh sessions | Confirmed modeled latency-clearance power (Wilson MC95%) | Typical time / reported cost |
| --- | ---: | --- | --- |
| Original trial-stratified,10 task clusters/class/trial×4 repeats | 240 /480 | 20/240 = **8.33%** (5.46–12.52%) | 84.3min /USD5.29 |
| Interleaved trials, independent variants/class | 240 /480 | 20/240 = **8.33%** (5.46–12.52%) | 84.3min /USD5.29 |
| Best screened budget-ceiling confirmation: interleaved,21 clusters/class/trial×2 repeats | 252 /504 | 33/240 = **13.75%** (9.96–18.68%) | 88.5min /USD5.55 |
| Interleaved,640 independent variants/class/trial | 3840 /7680 | 201/240 = **83.75%** (78.56–87.92%) | 22.48h /USD84.57 |
| Interleaved,960 independent variants/class/trial | 5760 /11520 | 229/240 = **95.42%** (91.98–97.42%) | 33.72h /USD126.86 |

The last design additionally passed the separately seeded **120-study/5000-resample check:112/120=93.33%**, MC95%87.39–96.58%. These are model-conditional latency-clearance probabilities under a neutral future alternative, **not actual neutrality or joint probability of passing quality/context/cost/every other release gate**. Confidence intervals quantify Monte Carlo error conditional on the pilot, not uncertainty about the pilot's rare-tail distribution.

**Within the current budget:** linear projections permit at most256 arbitrary pairs,252 with equal trial/class counts, or240 when completing whole30-task manifest cycles. A10% time/cost reserve lowers the equal-class ceiling to228 pairs. All four252-pair boundary allocations yielded only6.67–13.75%, with MC upper bounds<=18.69%. Therefore no examined equal-profile design supports spending the acceptance budget. This is not a theorem excluding every conceivable future variance-reduction method.

**Smallest tested conditional80% option:**3840 pairs. It clears the original point>=80% rule, but its MC lower bound does not reach80%;2880-pair screens did not clear the point rule, and the grid does not identify a global exact minimum. **Conservative planning option:**5760 pairs, whose independent1000- and5000-resample checks have MC lower bounds above80%.

Neither larger option fits the existing budget. Keeping the original separate historical trial distributions, no tested repeat or independent-variant design reached80% even at5760 pairs. Pooling the two historical windows is justified only as a new planning model for trials deliberately interleaved over the **same future temporal mixture**. Finite empirical CDF gaps at p95 can make size/power curves nonmonotone; do not use simple inverse-square scaling to assert a smaller N.

### Concrete prospective unblock plan — decision required, not a launch

1. **If USD6/90minutes is fixed: do not launch acceptance.** More repetitions within that cap do not solve the observed uncertainty. First demonstrate a genuine latency/stability improvement or obtain representative information that validates a lower-variance model, then freeze a new power calculation. No such improvement is claimed here. A hypothetical30% uniform latency improvement screened at77.5–85% for240 pairs;10–20% improvements were insufficient. Even forcing95% of simulated pairs to share identical latency yielded only54–57%. These unvalidated sensitivities are not an accepted within-budget design or a promise that parallel requests remove tails.
2. **If expanding the budget is acceptable:** a new owner-approved protocol could use either3840 pairs with approximately **USD95/25hours** allocation, accepting its MC uncertainty, or the more conservative5760-pair option with **USD140/38hours** allocation. These rounded allocations include approximately10% overhead reserve, not a billing/time guarantee. Neither allocation is authorized or spent by this planning request.
3. **Use independent paired variants and interleaved trials, not repeated identical fixtures as a substitute for independence.** For5760 pairs, use two trials of2880 pairs, each with960 simple,960 batch and960 chain pairs. Arrange96 master time blocks; each block contains30 pairs from each trial (10 per class), both trial labels randomly interleaved. Within each trial/class/block, balance5 direct-first/5 hybrid-first pairs. Each pair shares identical read-only bytes and normal prompts, uses two fresh sessions, and preserves natural hybrid choices. Freeze every variant seed, fixture hash, ordering seed, timestamp/window and assignment before inference. The3840-pair option has64 analogous master blocks and640 variants/class/trial.
4. **Approve the expanded manifest explicitly.** This proposal preserves equal class weights and three fixture families, but replaces repeated fixed parameters with a broader variant manifest; it is not literal completion of the original frozenN180 protocol. Retain the original30 anchors in each trial's prespecified coverage and validate all new seeds/oracles. The existing builder can generate variants, but there are still only three template families—not thousands of independent developer-task families. Independent episodes and future common temporal-mixture assumptions remain unverified. A persistent-task-shape sensitivity reduced large repeated-manifest designs to~19% power, so their superficially favorable repeat counts are not a robust recommendation.
5. **Qualify an acceptance-only runner before any live call.** Do not replay the settled diagnostic or remove its once-only guard. Freeze new source/native/model/effort/loadout/settings/environment fingerprints; run provider-free oracles, actual native authority/error/cancellation and telemetry conformance; enforce strict finite context/usage and corrected cluster resampling. Preserve both-trial and pooledp95<=1.10, pooled5000-resample upper<=1.10, composed estimated context<=.75, catalog cost<=1.10 and all zero-failure/quality/integrity bars. Use fixedN, no retries, no extensions, retain all assignments/outcomes. Any prespecified early stop on an irreversible hard-gate failure must record failed/incomplete acceptance, never restart/discard it.
6. **Validate operational capacity before approval.** The longer study needs model/account consistency and read-only credentials valid throughout its scheduled horizon; this request authorizes neither refresh nor global writes. Recheck current pricing/time estimates and set hard source/integrity/storage/time and soft reported-cost stops. Changed provider conditions, temporal dependence and a large cohort's increased chance of any quality/provider failure can reduce actual joint clearance well below the modeled latency component.
7. **Keep the shared64MiB evidence limit without deleting history.** Current-telemetry case+assignment records measured across all48 decision cases average10925 raw /2284 gzip bytes; p95 is15142 raw /2771 gzip bytes. At11520 sessions, raw p95-size records plus10% allowance alone exceed190MB; losslessly gzipped complete metadata is about35.1MB plus existing evidence (~6MB), below64MiB. The smaller option projects~23.4MB compressed plus history. Future reader/writer, exact decompression/contents/hash equivalence, logical and physical allocation, failure/spill headroom and128MiB fixture retention must be qualified. This is a proposed lossless format, not permission to drop required fields or optional-clean historical data. Per-packet diagnostic arrays are not required by the original acceptance contract and are not included in this estimate.

**Decision:** no supported plan meets80% inside the current budget. A larger, model-conditional study needs budget, expanded-manifest and operational/model-assumption decisions first; otherwise the unblock route is a demonstrated real variance/latency improvement, not weaker gates. **No paid requests were made, HOLD/defaults stay unchanged, and the original live acceptance remains unrun.** Stable root outcomes remain2/3 complete,1 blocked.

### Evidence, failed-stage handling and current verification

- `.pi/codemode-acceptance-design/plan-1792865086215/` contains the immutable protocol,52 `screen-*`,10 `confirm-*`, corrected-reference checkpoint, explicit continuation/source bridge, `sensitivities-after-continuation.json` and `result-after-continuation.json`.
- Main job `job-mvmpkxx0-accd` exited1 **after all52 screens and10 confirmations**, due to array-valued sensitivity grids mistakenly passed as scalar kernel parameters. A direct regression now covers scalar extraction. Only the previously uncomputed sensitivities/final aggregation/5000-resample qualification were continued in `job-mvmq11p7-85a8`, which exited0. No completed numerical arm was repeated or unfavorable result removed. Original checksums, source-at-computation and protected state reconcile across the explicit source bridge.
- Deterministic resource-ceiling supplement: `budget-ceiling-protocol.json` and `budget-ceiling-result.json` in the design evidence root, job `job-mvmpvr66-2fc0` exited0. It checks the maximum equal-class capacity derived from cost/time, not a new N chosen for favorable power.
- `numeric-qualification.json` and `storage-projection.json` there retain the extra numerical precision check and in-memory compression-size estimates. No existing record was compressed in place, edited or deleted.
- Durable bug threads: `.pi/debug-ledger/codemode-task-cluster-bootstrap-draws.json` and `codemode-planner-sensitivity-options-array.json`; the original failing weighted/reference test and sampler counterexample are preserved. Corrected reference/weighted ranks, repeated-pair retention, deterministic seeds, CLI no-live guard, scalar sensitivity and budget checks pass; existing decision/native-conformance tests pass. All8 integration checks passed; current scoped Git/static proof is separate in the design evidence root. No live acceptance, full repository/TUI pass, global edit or commit is claimed.
