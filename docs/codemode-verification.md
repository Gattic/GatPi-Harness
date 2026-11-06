# CodeMode implementation and verification — 2026-10-24

## Latest offline powered-design plan — HOLD remains

The [corrected sizing study and concrete unblock plan](codemode-acceptance-audit.md#corrected-offline-sizing-and-concrete-unblock-plan) tested52 designs plus independent confirmations and the exact projected budget ceiling. No supported80%-power design fitsUSD6/90min: at252 pairs(504 sessions), confirmed estimates were6.67–13.75%. The lowest tested conditional point>=80% option was3840 pairs(~USD84.57/22.48h);5760 independent paired variants reached95.42% in confirmation and93.33% in a separately seeded5000-resample check(~USD126.86/33.72h). Neither is within budget or authorized to run; a conservative allocation would beUSD140/38h, conditional on an explicitly approved interleaved-trial/expanded-manifest model and qualified operational/storage plan.

Validation also found and repaired the reference bootstrap's per-row random-ID bug; it now selects each task cluster once per draw and retains all repeated blocks. The corrected originalN180 power count coincidentally remains11/120=9.17%, while the corrected retrospective upper bound is **2.023227**, superseding1.891 as current inference. A seeded synthetic old bound1.0 becomes1.117647 under correct resampling. Existing raw cohorts are untouched; Trial2's observed point failure is unchanged. **Zero paid requests; HOLD/defaults unchanged; root outcomes2/3 complete,1 blocked.**

## Prior full-profile acceptance audit — before cluster-sampler correction

The [acceptance feasibility audit](codemode-acceptance-audit.md#findings-and-gate-inventory) completed all feasible offline checks with **zero paid requests**. Original planning power reproduced11/120=**9.17%**, below80%;5000-resample numerical sensitivity gave the same11/120. A newly computed retrospective pooled95% upper p95-ratio bound on the120-case full-profile archive is **1.891**, above1.10; Trial2's point ratio remains **1.514**. Composed estimated context0.734 and cost0.694 pass historically, but cannot waive latency/precision. Typical360-case resource projections fit90min/USD6; statistical adequacy, not disk/cost, blocks live acceptance.

The audit also repaired a synthetic false-acceptance bug: missing candidate context could sum as zero and pass. Finite-positive context is now required, missing aggregates remain unknown, and red→green regressions plus20 changed-profile commands and8 integration checks passed. Historical context values were valid, so no observed verdict changed. **Full-profile acceptance remains NOT RUN; HOLD and defaults are unchanged.** Stable parent outcomes2/3 complete,1 blocked; see the audit for gate-by-gate scope and retained evidence.

## Latest matched raw-event/control study — HOLD remains

The [48-session continuation study](codemode-continuation-results.md#findings) completed16 randomized task21 triplets (direct cachedWS, hybrid cachedWS, hybrid full-context WS) with all quality/timing/mode checks passing. No>10s post-ACK stall recurred: the exact paired test had0 discordant pairs,p1, **inconclusive rather than equivalence**. All6144 raw/parsed events aligned over154 turns; maximum raw→parsed-provider-hook lag was2.690ms in this healthy window, not a retrospective diagnosis of the earlier uncaptured raw waits.

Mean latency was7.748s direct,9.199s cached hybrid,9.689s full-context hybrid. The full-context preference retained socket reuse and token-prefix cache hits; it is not supported as a latency fix. Cost was USD0.4574688 reported for all48 sessions; the managed job exited0 in7m28s. New/previous benchmark tests,8 integration checks and focused canonical Semgrep passed. Original raw evidence and defaults are unchanged. **HOLD remains; the full-profile acceptance is still unrun/blocked by its power prerequisite.** No extra sampling, commit, merge, push, global installation or production change followed this null result.

## Phase-timed follow-up — HOLD remains; default-on unchanged

A separately preregistered follow-up completed **120/120** exact answer/evidence checks across two comparable trials, with complete timing/token coverage, no tool/provider failures and unchanged historical/settings/credential/source fingerprints. Full [phase results and token differences](codemode-phase-results.md) and [fixed protocol](codemode-phase-timing.md) are recorded separately; the original frozen cohort below is untouched.

- **Latency:** Trial 1 p95 improved 12.7%, Trial 2 regressed **51.4%**, pooled p95 was +0.3%. The preregistered *both trials plus pooled* <=10% regression bar **failed**; the pool is not a substitute for the failed repetition. Mean latency increased **11.6%**.
- **Attribution:** 92.4% of the mean penalty is in model/provider time. Treatment CodeMode non-nested overhead averaged **85.6 ms** (199 ms p95); it is not pure VM time. Mean first-delta-to-end time rose 1.092 -> 2.146 s, alongside more output and read calls. This localizes the dominant measured phase without claiming a causal server/decoder diagnosis.
- **Actual tokens including cache:** **480259 -> 454782**, a reduction of **25477 / 5.3%**. Input fell 6.1%, output rose 53.8%. Batches saved 38.9% total tokens; simple controls used 31.8% more and chains 27.1% more. Do not substitute the 26.6% composed character-estimate reduction for actual token savings.
- **Cost:** SDK-reported catalog-priced USD 0.7799676 -> 0.5414568 (-30.6%), not an invoice. Cache reuse increased substantially.
- **Integrity:** both old and new raw cohort files remain byte-preserved; no measured case was retried. A post-run small-cost rounding defect was repaired and regression-tested using a synthetic counterexample; exact separate analysis changes no observed cohort verdict and does not overwrite the raw summary.
- **Current-source checks:** four focused commands plus all eight integration-boundary checks passed; the phase suite passed again after the precision fix. Scoped registered `gitverify` passed both Git checks and canonical Semgrep on 23 changed source/test files with zero findings, engine errors or fixpoint timeouts (`.pi/codemode-phase-verification/gitverify-final.json`); raw/derived measurement evidence is under `.pi/codemode-phase-benchmark/live-1792848822532/` and `.pi/codemode-phase-verification/`.

**Recommendation remains HOLD for an unconditional default-on merge.** Quality and measurement gates pass, but consistent tail-latency neutrality does not. Default-on is unchanged as requested. No general-field/statistical noninferiority, latency fix, global installation or merge is claimed.

## Prior release review — before phase-timed follow-up

The implementation milestones below are not merge approval. **Current evidence does not justify recommending an unconditional default-on merge.** The frozen comparison passed quality/evidence checks and saved context/cost in aggregate, but missed its latency target. Earlier user authorization establishes the requested policy, not proof of a favorable performance trade-off. `PI_CODEMODE=1` remains unchanged; this review does not silently convert the feature to opt-in.

A cost/context-prioritized deployment could explicitly accept the measured latency trade-off. Otherwise, latency needs a separately authorized, preregistered follow-up with phase timing and representative workloads before recommending default-on. Do not waive the failed target by calling implementation complete, change its threshold, replay the frozen cases, or infer a speed fix from passing correctness tests. This is a release recommendation, not a new automatic enablement gate.

### Latency assessment: descriptive reanalysis, not a rerun

| Stratum | Direct mean / median / p95 | CodeMode mean / median / p95 |
| --- | --- | --- |
| All 30 tasks | 8.107 / 8.038 / 12.691 s | 9.131 / 8.269 / 14.785 s |
| 10 simple controls | 5.975 / 5.290 / 8.421 s | 5.607 / 5.067 / 7.553 s |
| 10 batches | 9.784 / 9.122 / 12.691 s | 12.598 / 11.593 / 20.956 s |
| 10 dependent chains | 8.563 / 7.648 / 15.555 s | 9.188 / 8.269 / 12.812 s |

- Overall p95 regressed **2.094 seconds / 16.5%**, above the proposed 10% bar; mean latency also regressed **12.6%**. This is not just an unfavorable p95 statistic with otherwise uniformly faster requests.
- Batch mean regressed **28.8%** and median **27.1%**. Eight baseline batch tasks already needed only two model turns; the treatment did not reduce total turns (22 -> 24) and made more underlying calls (40 -> 56). Its overall turn count also increased (72 -> 76), as did provider-reported output tokens (3175 -> 4717).
- The aggregate composed-context reduction hides different outcomes: batch estimated context fell 200853 -> 102945, but dependent-chain context increased 109747 -> 119171 (**8.6%**), and simple-control context increased 77363 -> 94017 (**21.5%**). Mere availability has declaration overhead even when no script is used. The overall reported cost saving remains an observation, not a guarantee under different cache conditions.
- Thirty pairs are three repeated task templates, not broad field coverage. Nearest-rank p95 is the second-slowest observation for n=30 and the maximum for each n=10 stratum. Stratum statistics are exploratory descriptions, not new preregistered gates or statistical noninferiority results.
- Generated-code size, turns and extra calls suggest model-generation/execution-choice overhead, but do **not** isolate causality. Records contain neither generated scripts nor provider/tool/VM phase timing. `wallMs` also includes post-prompt fixture/integrity/accounting work, so it is not a pure provider or VM latency measurement. Do not attribute the regression to QuickJS, add speculative prompt/timing patches, or dismiss it as noise.

Reanalysis: `.pi/codemode-release-review/analysis.json`. All frozen protocol, summary and 60 case records remain untouched. No new provider requests or measured-case retries were made. The measured source snapshot predates the correctness fix below; no post-fix performance pass is claimed.

### P1 correctness blocker — fixed

`src/codemode-policy.js` previously passed native `isError` into `inferOutcome`, whose explicit structured status takes precedence. A real failed child carrying `{outcome:"succeeded", ok:true}` could therefore be ignored/caught by a script and become outer `isError:false, outcome:"succeeded"`. A provider-free native reproduction confirmed the contradiction: the child event was an error while the outer result was success.

The CodeMode boundary now makes native errors authoritative over nonnegative structured status, classifying that contradiction as `infrastructure-failed`. Genuine domain-negative, blocked, cancelled and timed-out outcomes remain intact. Seven native regression cases in `tests/codemode.test.js` cover the positive/not-applicable/unknown contradictions and preserved negative states, including canonical child error status. The fix does not alter the shared outcome inference contract for unrelated tools.

### Current-source review verification

- **PASS: 8 focused commands:** CodeMode native regressions, benchmark manifest/oracles, affected extension typecheck, full extension-load registration, extension telemetry, outcome schema, policy enforcement and router-extension tests.
- **PASS: all 8 integration-boundary checks:** `.pi/codemode-release-review/integration-boundary.log`.
- **PASS: scoped `gitverify`**, both Git diff checks, and canonical Semgrep on 20 changed source/test files with zero findings, engine errors or fixpoint timeouts. Evidence: `.pi/codemode-release-review/gitverify.json`; this is separate from the historical implementation Git reports below.
- Frozen cohort file digest before/after review verification: recorded in `.pi/codemode-release-review/analysis.json`; the 60-case data is historical evidence, not a new benchmark of this fix.
- No full `check-all.sh`, live provider/TUI checks, broad-pack Semgrep replay or statistical study was run. No commit, merge, push, global settings/credential change or default-mode change was performed.

**Recommendation: HOLD the default-on merge on performance/trade-off grounds; the confirmed correctness blocker has been repaired.** Current correctness/static passes do not resolve the failed latency target. An explicit owner acceptance of this cost/latency trade-off, or new independent evidence, is needed for a positive default-on merge recommendation.

## Original implementation delivery

Implemented in branch `feat/codemode-default-on`, worktree `.worktrees/codemode-default-on`, from `5f25692f29501249fe3d95726a15a99e22ccbbee`.

At implementation closeout, all four required outcomes were complete: saved plan, governed default-on integration/typed contracts, acceptance plus comparative evaluation, and documentation/reconciliation. That milestone accounting was not release approval. This does **not** mean every proposed performance target passed: the live latency target failed and remains failed; the subsequent release review above recommends holding the default-on merge.

- Native Pi CodeMode is default-active in hybrid `on` mode; explicit native presentation preferences are respected. `PI_CODEMODE=0` or `--exclude-tools codemode` opts out. Explicit allowlists and no-tools sessions remain respected.
- Native execution/validation/policy hooks are retained. Reviewed read operations alone are exposed; shell, mutations, verification execution, approval management, specialists and supervision remain direct.
- Host limits: 60 seconds, 32 nested calls, four in flight, 2000 returned tokens, 131072 source characters. Native QuickJS heap limit remains 256 MiB. Extra model APIs and persistent script-store writes are disabled.
- `code_context`, `docs_lookup` and `test_runner` return validated canonical structured data. Nested compaction preserves post-hook results. A body fetched only inside a script no longer becomes falsely model-visible in the retrieval ledger.
- Nested negative outcomes cannot be erased by catching errors or printing success. Existing canonical verifier/evidence stores remain authoritative.

The plan is `docs/superpowers/plans/2026-10-24-codemode-default-on.md`; operational instructions are `docs/codemode.md`. The main checkout and global configuration were not edited. No commit, merge, push or global installation was performed. The source-linked worktree is retained for review; default behavior applies when this implementation is loaded, not retroactively to an already-running session using main.

## Provider-free acceptance: 30 distinct checks passed

Commands were selected through `test_runner infer` and run with its worktree path, plus the canonical worktree-scoped integration script. Native tests use the installed SDK, real QuickJS executor and real harness hooks, with synthetic provider messages rather than paid/provider-dependent test responses.

| Area | Passing checks |
| --- | --- |
| Native CodeMode (3) | `tests/codemode.test.js`, `tests/codemode-types.test.js`, `tests/codemode-benchmark.test.js` |
| Retrieval and typed tool surface (6) | `tests/code-context-service.test.js`, `tests/code-context-contracts.test.js`, `tests/code-context-ledger.test.js`, `tests/coding-workflow-tools.test.js`, `tests/test-runner.test.js`, `tests/result-rendering.test.js` |
| Fleet/defaults/router (7) | `tests/extension-load.test.js`, `tests/extension-portfolio.test.js`, `tests/extension-telemetry.test.js`, `tests/harness-environment.test.js`, `tests/tool-surface-router.test.js`, `tests/tool-surface-router-extension.test.js`, `tests/productization-extensions.test.js` |
| Evidence/outcomes/policy/privacy (6) | `tests/evidence-binder.test.js`, `tests/test-evidence-index.test.js`, `tests/outcome-schema.test.js`, `tests/policy-enforcement.test.js`, `tests/policy-directory-approvals.test.js`, `tests/reasoning-transcript-privacy-policy.test.js` |
| Integration boundary (8) | `scripts/check-integration-boundary.sh`: integration-boundary, integration-config-storage, storage-sink-conformance, extension-import-boundary, disabled-side-effects, adapter-lifecycle, cognitive-extension-persistence and cognitive-orchestration-config tests |

Native regression coverage includes default-on/opt-out and explicit restrictions, an unsupported-public-API failure, typed results/provenance, hidden-source visibility, native argument validation, real policy denial, semantic negatives, caught failures, actual nested counts, hard deadline, queued cancellation, concurrency, unavailable host globals, private native spills, refused persistent store writes, hidden old store entries after session recovery, and metadata-only fleet telemetry. The typecheck resolves the installed Pi/TypeBox/Node declarations instead of relying on an absent worktree node_modules tree.

Initial failed checks are retained in `.pi/test-runner/raw/` and task-owned debug threads, not erased: a native context Proxy invariant was repaired with a neutral-target facade; fixture assumptions about search ordering, native spill location and SDK no-tools spelling were corrected from source evidence. Fresh-worktree queue dependencies were installed only through `scripts/setup-pi-queue.sh`. An incorrectly selected nonexistent docs test was replaced by the existing `coding-workflow-tools` verifier. TypeScript's installed version-only package has no compiler JS API, so the typecheck uses the actual `tsc` CLI. Exact fleet-count assertions were updated for the one new tool/extension, not weakened.

## Git-aware and static verification

The actual registered `gitverify` tool was invoked through an isolated native SDK session with `cwd` set explicitly to this worktree. This avoids presenting session-root-only verification as worktree evidence. The synthetic provider only requested that verifier; it did not supply its result.

- `.pi/codemode-gitverify-final.json`: `ok: true`, correct worktree `repoRoot`, both `git diff --check` and `git diff --cached --check` exit 0.
- Canonical `.semgrep.yml` security checkpoint: 20 changed source/test files scanned, zero findings, zero engine errors and no fixpoint timeout. CodeGraph affected-test hints remain advisory, not an instruction to rerun unrelated experiments.
- Separate earlier `p/default` scan: zero findings, but its raw profiling output reported one taint-analysis fixpoint timeout on benchmark code. `.pi/codemode-semgrep.json` retains the compact adapter summary, which omits profiling timings; empty adapter diagnostics do not erase the observed coverage warning. This was not a complete broad-pack proof. The canonical repository-rule checkpoint above is a separate gate.
- No Prisma PostgreSQL datasource was detected, so isolated PostgreSQL was not applicable.
- The task tree is intentionally dirty/uncommitted. Native `gitverify` inferred Git/static checks here, not the 30 behavior tests; those have separate execution evidence above. The initial successful verification is preserved separately as `.pi/codemode-gitverify.json`.

The repository-wide `scripts/check-all.sh` and unrelated live fleet/TUI/deadline diagnostics were not run. Existing open threads, frozen cohorts and historical evidence in the primary checkout were not repaired, retried or rewritten.

## Fixed live comparison: complete, quality parity passed, latency target failed

Provider/model/thinking: **`openai-codex/gpt-6.1-sol`, `xhigh`**, matching the selected session identity. Thirty fixed paired tasks, 60 fresh sessions; ten single-file controls, ten four-file batches, ten dependent route/catalog tasks. Arm order was counterbalanced. No measured case was retried, no provider/model/account fallback was used, and the read-only credential store prohibited refresh/writes.

| Metric | Direct baseline | Hybrid CodeMode | Observation |
| --- | ---: | ---: | --- |
| Cases / exact answer + observed-file evidence passes | 30 / 30 | 30 / 30 | **PASS: 60/60** |
| Tool/provider failures | 0 / 0 | 0 / 0 | **PASS** |
| Model turns | 72 | 76 | More, not fewer |
| Underlying tool attempts / successful completions | 70 / 70 | 88 / 88 | More, not fewer |
| Full-transcript estimated context, all tasks | 387963 | 316133 | 18.5% lower |
| Estimated context, composed tasks | 310600 | 222116 | **28.5% lower; target passed** |
| Reported total cost (USD) | 0.4077728 | 0.3033984 | **25.6% lower; target passed** |
| p95 case latency | 12.691 s | 14.785 s | **16.5% slower; <=10% regression target FAILED** |

Twenty treatment cases actually generated CodeMode scripts; the ten simple controls used direct tools, as hybrid mode permits. Total reported cohort cost was USD 0.7111712. Source and protected settings/credential/history fingerprints were unchanged throughout the live comparison. There were zero unrun cases. Successful owned fixtures were removed; retained benchmark artifacts total approximately 504 KiB, below the 64 MiB evidence / 128 MiB fixture caps.

**Interpretation:** this cohort supports lower context and reported cost for composed tasks, not a general latency improvement or fewer model/tool calls. The all-benefit-bars verdict is **FAIL / no-go for that claim**. The user independently authorized default-on hybrid behavior, so this does not turn it into an opt-in rollout or automatically disable it.

### Exact evidence and limitations

- Live protocol: `.pi/codemode-benchmark/live-1792842134388/protocol-02.json`.
- Live summary: `.pi/codemode-benchmark/live-1792842134388/summary-02.json`; all 60 per-arm case records remain alongside it.
- Manifest SHA-256: `0e96ee5a653c01cb37e84de396470fe032852fcc7dc539b6f4a279fb00c13ade`.
- Frozen source SHA-256: `745bd1c1c6624d328db3067a1a91f84c68ea1538e907cb4f0d5290ba47c62c9e`.
- Installed Pi version: `1.1.0`; entry SHA-256: `5482298b995db935f7b96f5d6056fa1c36ac6fc80456be594ef65b83c62b0d30`.
- Owned ledger: `exp-native-codemode-v2-live-paired`, quality comparison PASS and benefit-targets FAIL, closed without claiming every benefit bar passed. Default enablement is separate authority.

At original implementation closeout, post-cohort changes were documentation, additional unsupported-version/session-recovery regression assertions, and removal of a redundant settings fallback. The affected native/type/fleet checks were rerun successfully. The release review additionally repaired the transport-error precedence bug described above and reran affected checks. The digest above identifies the measured snapshot, not these later changes. No performance case was repeated or tuned to erase a failed bar.

The original managed launch lacked inherited model selectors and stopped before model-runtime construction, requests or cases. Its zero-case `protocol.json`/`summary.json` remain unchanged. A one-time explicit CLI identity continuation wrote additive version-02 records and a separate preregistration before the first actual inference. It did not repeat assigned cases. The launcher now validates identity before registration; attempted cases/provider failures cannot use this continuation path.

The earlier `.pi/codemode-benchmark/synthetic-1792841826865/` run validated all 60 runner cases using synthetic final answers; it is not live quality or performance evidence. Its missing provider-payload context measurement remains in the original record. Provider-neutral full-transcript measurement was subsequently proven through native regression assertions and used in the live protocol; providers that do not build an HTTP payload now report that separate metric as null.

These are synthetic fixture tasks, not representative developer sessions or a statistically powered noninferiority study. Character/4 context is an estimate, not provider tokenization. The tool subset is the selected read-oriented loadout with current router/compactor hooks, not an all-tools fleet benchmark. Cache, task ordering, shared host conditions, model behavior and provider-reported pricing limit generalization. No private reasoning, credential values or raw provider payloads were persisted. No further optimization or comparison rerun was used to erase the failed latency target.

## Subsequent phase and decision reruns

The [120-case phase results](codemode-phase-results.md) retain their original verdicts. The separately authorized [decision-producing rerun](codemode-decision-rerun.md#findings) completed48 targeted diagnostic sessions plus8 probes, all quality/timing/token passes. Its selected direct/hybrid p95 values were10.608s/28.603s; two22–24s pre-delta stalls were isolated from~86ms CodeMode execution with per-turn usage, parsed-event categories, client lag and native WebSocket counters. Those observations do not identify pure server queue time or establish profile noninferiority. The proposed180-pair acceptance cohort failed its pre-inference power prerequisite and was not run. **HOLD remains; default-on is unchanged.** No historical result was overwritten, discarded or reclassified.
