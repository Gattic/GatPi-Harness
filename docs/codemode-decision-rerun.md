# CodeMode decision-producing rerun

This newly authorized study follows the frozen phase findings. It does not resume, replace, retry or reinterpret the historical cohorts. Default-on hybrid CodeMode, global settings/credentials, model identity and production behavior remain unchanged. All task work stays on `feat/codemode-default-on` in `.worktrees/codemode-default-on`.

## Command and fixed scope

```sh
node scripts/benchmark-codemode-decision.js --live \
  --provider openai-codex --model gpt-6.1-sol --thinking xhigh
```

The once-only runner refuses an existing decision cohort. Before the first paid request it writes a private protocol, complete deterministic randomized schedules, power assessment, source/history/protected/SDK/provider-module hashes, and a new experiment-ledger entry. Every measured case gets an exclusive pre-prompt assignment marker; no assigned case can retry. Partial outcomes and unmeasured assignments are retained explicitly. No new global installation, credential refresh, credential command or configuration write is authorized.

### A: targeted diagnosis

Six anchors (11,21,15,19,08,05), four randomized blocks and both arms: **48 fresh sessions**, plus **eight fixed short no-tool probes** at block boundaries. Task order is shuffled; each task's first arm is randomized and reversed on alternate blocks, giving exact AB/BA balance. Both arms share byte-identical, read-only synthetic fixtures and ordinary task prompts. Direct controls locally exclude CodeMode; treatment retains natural hybrid choice, not forced scripts. Probes have no tools and are diagnostic-only, not warmups silently discarded or workload acceptance observations.

Cap: 25 minutes, USD2 SDK-reported/catalog cost,120 seconds per case. The deadline also respects remaining stage time. This is a soft between-case reported-cost stop, not a billing guarantee. All newly owned evidence shares the64MiB retention cap with all existing `.pi/codemode*` evidence; fixtures are separately limited to128MiB. Only successful newly owned fixtures/spills are disposable; failures and all old data remain preserved.

### B: power-qualified acceptance

The proposed budget is **180 matched pairs/360 fresh sessions**, in two90-pair trials, each split into three time blocks. Each block contains all30 original manifest tasks, randomized across strata, with AB/BA balance across all six blocks. Cap:90 minutes/USD6 reported cost. This stage is conditional on a frozen-data power check; it is not automatically run after a favorable diagnostic.

Planning simulation:120 simulated studies,300 bootstrap resamples per study, deterministic seed20261027. Sample matched historical latency shapes within six trial/class cells, with random arm swaps under an exchangeable, latency-neutral null. Simulate three future blocks of10 task slots per cell. Compute the same per-trial/pooled point bars and a task-cluster stratified percentile-bootstrap upper bound. Require estimated power>=80% before spending the acceptance budget; report a Wilson95% Monte Carlo interval. This is a sensitivity model, not a proof about the provider or actual treatment effect. Inadequate power leaves acceptance **unrun/inconclusive**, never passed. Do not increase N or change gates after seeing new observations.

Release evidence requires all exact answer/observed-evidence/authority gates, zero tool/provider failures, complete numeric timing/token metadata, unchanged frozen/protected/source stamps, original both-trial and pooled p95 ratios<=1.10, pooled composed character-estimated context ratio<=.75, reported cost ratio<=1.10, and a predeclared one-sided95% upper bootstrap p95-ratio bound<=1.10 (5000 resamples). Resampling retains each matched task's block repetitions within fixed trial/class strata. This conditional synthetic-profile interval is not a population or arbitrary-time guarantee. A favorable selected diagnostic or pooled point estimate cannot lift HOLD.

## Measurement qualification and privacy

`tests/codemode-decision-benchmark.test.js` covers assignments, missing metrics, exact completeness, statistical gates, privacy sentinels and actual native SDK/QuickJS conformance for all three task classes and both arms. Its owned child process (`tests/helpers/codemode-decision-websocket.js`) substitutes a synthetic WebSocket and forbids HTTP networking. It verifies native SDK/provider-module identity, numeric counter observation, connection reuse, parsed event categories, finalized per-turn usage and tool-free probes. These are not live performance observations.

Retain only fixed event categories, counts, UTC/relative monotonic timestamps, normalized numeric per-turn token/cache/reasoning usage and cost, CPU time, event-loop lag, numeric WebSocket counter differences, HTTP status codes, hashes, and existing tool lifecycle intervals. Unknown event names map to `other`. Never retain prompts, text deltas, generated scripts, arguments, private reasoning, complete headers, raw request/response IDs or error strings.

Report independently:

- Model pipeline: context event to finalized assistant message.
- Request-to-first parsed provider event, first parsed-to-first normalized delta, first normalized start/delta, and delta-to-end.
- Per-turn tokens/cache mix and whether raw reasoning usage was reported, rather than assuming SDK zero means no hidden work.
- SDK-observed WS attempts/connections/reuse/full-versus-delta context/failure/fallback counts. One payload hook is not one wire attempt. Absent WS counters stay unknown; HTTP header/status hooks can also be absent.
- Main-process CPU and event-loop lag during each model interval.
- Top-level/nested tool interval unions, CodeMode outer/non-nested time, residual harness time, setup/accounting/cleanup and spills. CodeMode non-nested time includes startup/JS/discovery/serialization/hooks, **not pure VM time**.

A silent provider interval can include server scheduling, hidden planning/generation, transport buffering/recovery and client processing; do not call it pure server queue time. Counter associations do not establish root-cause causality. Extra model turns, output, reads and spills are treatment mediators: retain them in primary prompt latency. Benchmarks run serially; external provider/account traffic is unknown and no unrelated process is stopped.

## Findings

The owned job `job-mvmjqobz-04f2` exited0,2026-10-24 15:21:15–15:29:38UTC (~8m23s). It completed all **48 diagnostic sessions plus8 probes**. Every oracle/evidence and timing/token check passed; zero tool/provider errors, missing results or retries. Catalog-reported total cost was **USD0.648964**, not an invoice or subscription marginal charge. Successful owned fixtures/spills were cleaned; all metadata and historical evidence remain.

### Direct-control comparison (selected diagnostic,24 cases per arm)

| Metric | Direct | Hybrid CodeMode |
| --- | ---: | ---: |
| Mean prompt latency | 8.030s | 10.892s (+35.7%) |
| Median prompt latency | 8.057s | 9.698s (+20.4%) |
| p95 prompt latency | 10.608s | 28.603s (**+169.6%**) |
| Mean model pipeline per case | 8.019s | 10.786s |
| Mean request-to-first-delta sum per case | 6.814s | 8.303s |
| Mean first-delta-to-end sum per case | 1.204s | 2.480s |
| Mean top-level tool wall per case | 5.519ms | 100.676ms |
| Mean CodeMode outer / non-nested per case | 0 /0 | 99.208 /95.801ms |
| Model turns / underlying reads | 53 /64 | 61 /97 |
| CodeMode calls / spills | 0 /0 | 25 /9 |
| Input tokens including cache | 201018 | 183597 (-8.7%) |
| Output tokens, including reasoning | 3017 | 4510 (+49.5%) |
| Total tokens | 204035 | 188107 (-7.8%) |
| SDK/catalog-reported cost | USD0.3709196 | USD0.2464316 (-33.6%) |

The eight separate no-tool probes all passed: mean2.949s, maximum3.705s; no10s normalized-delta wait. This is not proof that the provider was uniformly healthy between probes. The diagnostic intentionally overweights selected batch/chain tail anchors; its p95 is not an acceptance estimate for the original equal-class profile. Per-block descriptive p95 ratios were1.368,2.159,1.071,3.369. No unfavorable cases were excluded.

Arithmetic phase attribution puts **96.6% of the mean latency difference in the model pipeline**. This is not a causal subtraction experiment. More turns/reads/output and spills remain real policy-mediated costs. Also, some direct tool turns exposed parsed argument completion without argument deltas, whereas CodeMode exposed custom-input deltas: first-normalized-delta is not a uniform wire-TTFT boundary or a clean prefill/decode split.

### Reproduced stalls, separated from execution

Both long waits occurred in treatment task21, with **three model turns and two underlying reads**, matching each adjacent direct control's counts. Both treatment cases were second within their pair; four repetitions cannot establish an order effect, and the old Trial2 task21 stall occurred treatment-first.

| Observation | Block1, final-answer turn | Block3, script-generation turn |
| --- | ---: | ---: |
| Treatment whole case / matched direct | 28.603 /8.193s | 35.744 /8.384s |
| Request to first normalized delta | **22.690s** | **24.401s** |
| Request to first parsed event | 0.796s | 0.481s |
| Request to parsed `response.in_progress` | 0.882s | 0.515s |
| Parsed-event to first-delta gap | 21.894s | 23.920s |
| Turn input / cache-read / uncached tokens | 2668 /2560 /108 | 2491 /2304 /187 |
| Turn output / reported reasoning subset | 22 /0 | 88 /0 |
| Whole-case CodeMode execution | 85.594ms, already finished | 85.479ms, starts after this model turn |
| Client CPU during model turn | 76.063ms | 108.641ms |
| Maximum client event-loop lag | 14.746ms | 12.820ms |

Every one of the122 model turns (53 direct,61 hybrid,8 probe) had one observed SDK WebSocket request, a matching numeric transport snapshot, zero recorded failures/fallbacks/multiple attempts, and no HTTP-header hook. Both slow turns reused existing connections and delta context. These observations substantially narrow the delay away from VM execution, connection establishment and a20s main-thread pause. They **do not exclude TCP buffering/retransmission or opaque backend retries**, and cannot split server scheduling from hidden generation/planning. Reported zero reasoning tokens is not proof of zero hidden computation. No assertion of a provider outage or pure server queue time is supported.

### Acceptance and recommendation

The frozen-data power preflight, before new observations, yielded **11/120=9.17%** simulated clearance probability under the latency-neutral planning assumptions (Monte Carlo95% interval5.20–15.67%), below the preregistered80% adequacy target. The proposed **360-session acceptance cohort was not run**. This is inadequate planning precision, not a live performance-gate failure; no new sample-size or threshold was selected after the diagnostic. It requires a new adequately powered design/budget decision, not repeated selected cases until they look favorable.

**HOLD remains.** Host CodeMode overhead is small, but observed end-to-end latency is not neutral; the selected diagnostic does not certify the original workload profile, and required release acceptance remains unrun. Neither cost/token savings nor attributing delay to the broader model/provider/transport interval makes it legitimate to lift HOLD. Default-on remains unchanged; no merge, commit, push or deployment is authorized or performed.

### Evidence and integrity

- New immutable raw cohort: `.pi/codemode-decision-benchmark/live-1792855279662/` (`protocol.json`, `summary.json`,56 exclusive assignment markers and56 case records).
- Raw-tree SHA256: `c80215bc630b20c9ac9e8aac61160ae8a8b0df1a29843b69e7b8bc7e5d3df24e`.
- Separate exact reconciliation/analysis: `.pi/codemode-decision-verification/analysis.json`.
- Experiment `exp-codemode-decision-rerun-2026-10`: diagnosis PASS, planning/acceptance insufficient/unrun, closed no-go for lifting HOLD.
- Original phase raw SHA256 remains `1775c8ebe8d4ecd43d9d1d00173b58829b9481e9cd3ba4d9739dd71b69277823`; protocol-listed original history remains `47efddf913bdbfb915ef3f2df2571aa4fd6505f2c523dd4996abe52741e15c7b`.
- Pair fixture hashes, assignment-before-context timestamps, exact per-turn-to-case token totals, measured source, frozen historical files, protected settings/credentials/primary ledgers, Pi entry, provider modules and relevant environment checks all passed. The protocol's source hash identifies the measured snapshot; this results text was added afterward.
- Qualification: focused decision benchmark tests (including native QuickJS and synthetic WebSocket/no-network conformance) passed; all8 integration-boundary checks passed; canonical Semgrep on4 newJS files and the final runner revision returned0 findings/errors. No full repository/live/TUI regression suite is claimed.

### Subsequent targeted raw-event/control study

The separately authorized [48-session matched continuation study](codemode-continuation-results.md#findings) completed16 randomized direct/cached-hybrid/full-context-hybrid triplets for task21. All oracle, timing, transport and privacy checks passed. No>10s post-ACK stall recurred in any arm; the primary exact paired test had no discordant pairs,p1, an **inconclusive** result rather than equivalence. Raw→parsed delivery was<=2.690ms over154 turns in that window, but the historical raw arrivals were not captured, so this cannot retrospectively assign the earlier21.8/23.9s waits to server/model/network versus asynchronous client work. Full-context hybrid was not faster overall. **HOLD remains**, the original acceptance cohort stays unrun/blocked, and no production/default change or additional sample extension was made. The original findings and artifacts above are unchanged.

### Subsequent full-profile acceptance audit

The [offline acceptance audit](codemode-acceptance-audit.md#findings-and-gate-inventory) reproduced the frozen9.17% planning result exactly; using5000 bootstrap resamples instead of300 gave the same11/120 simulated clearances. The newly computed retrospective pooled95% upper bound on the original60 full-profile pairs is1.891>1.10, alongside the existing failedTrial2 point ratio1.514. No selected observations were substituted and no thresholds/N changed. A null-context false acceptance in the calculator was fixed and regression-tested; all historical context values were valid, so no historical result changed. Resource headroom is adequate but the unchanged statistical prerequisite is not: **360-session acceptance stays unrun, HOLD/defaults unchanged, zero new paid calls**.

### Corrected sizing plan and budget decision

The later [offline sizing study](codemode-acceptance-audit.md#corrected-offline-sizing-and-concrete-unblock-plan) exposed a cluster-sampler defect: drawing a random cluster ID inside a per-row filter did not retain repeated blocks. Corrected whole-task sampling and an independently checked weighted-rank engine are now used. The originalN180 power count remains9.17% by coincidence, but the corrected historical upper bound is2.023227, superseding the earlier1.891 calculation without changing any raw record or Trial2's point failure.

No examined design reaches80% withinUSD6/90min; the exact projected equal-class ceiling is252 pairs, with confirmed power6.67–13.75%. Interleaving both future trials and broadening independent task variants gives conditional planning options at3840 pairs(~USD84.57/22.48h) or more conservatively5760 pairs(~USD126.86/33.72h;93.33% in a5000-resample check). The report fixes prospective scheduling, compressed complete-metadata storage, model/credential/runner prerequisites and explicit budget/manifest decisions. These are proposals, not approval or acceptance evidence. **No paid requests were made; HOLD/defaults stay unchanged.**
