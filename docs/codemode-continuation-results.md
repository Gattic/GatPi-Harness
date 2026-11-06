# Matched-control continuation and raw-event timing study

This is a new, explicitly authorized mechanism study, not a replay of the frozen [decision rerun](codemode-decision-rerun.md). All prior evidence, defaults, production code, installed Pi and global settings/credentials remain unchanged. Task work remains in `.worktrees/codemode-default-on` on `feat/codemode-default-on`.

## Frozen design

Once-only command:

```sh
node scripts/benchmark-codemode-continuation.js --live \
  --provider openai-codex --model gpt-6.1-sol --thinking xhigh
```

Exactly **16 serial randomized triplets /48 fresh sessions**, all original task21. Each triplet shares identical read-only fixture bytes and normal task prompts. No forced scripts or artificial fixed answers. The seeded schedule reverses cached/full precedence8:8 and gives each cell each position5 or6 times.

| Cell | Loadout | Session-local transport preference |
| --- | --- | --- |
| direct | Existing direct control, CodeMode excluded | `websocket-cached` |
| cached | Natural hybrid CodeMode on | `websocket-cached` |
| full | Natural hybrid CodeMode on | `websocket` |

The deployed SDK's plain `websocket` mode retains connection reuse but omits the `previous_response_id` continuation. It does **not** disable token-prefix caching. Native counter snapshots and actual send metadata verify mode application. No installed provider code is patched; all settings are in-memory benchmark settings. Native recovery remains observable behavior, not a benchmark retry. Actual cache hits, reconnection/recovery, workflow choices, additional model turns and outputs are retained as mediators, not adjusted away or dropped.

The primary endpoint is any **post-first model turn** with a parsed `response.in_progress`→first `response.output_item.added` interval greater than10s. Compare cached versus full hybrid within each triplet with one predeclared one-sided exact paired McNemar/sign test, alpha.05. Direct is a contemporaneous reference, not a second confirmatory test. Under an illustrative50%→5% stall-risk reduction with independent conditional responses,16 pairs have82.57% power; the2/4 historical cases do not establish those true rates. A null result is not equivalence. The original full-profile p95 gates and their blocked power requirement are unchanged.

Bounds:25 minutes, USD2 SDK/catalog-reported cost (not a billing guarantee),120 seconds per case,4096 metadata entries per case,64MiB shared across all `.pi/codemode*` evidence and128MiB fixtures. Stop at source/history/protected drift, provider error/timeout, storage/time/cost bound, unavailable cost or required timing/correlation failure; retain assignments, partial outcomes and failures. No benchmark retries, sample extensions or warmups discarded after observation. Successful newly owned synthetic fixtures/spills may be cleaned; historical assets are never deleted.

## Raw timing and privacy

A transparent WebSocket subclass is installed **only inside the owned benchmark process**, before native transport use, and restored afterward. Constructor arguments, send data, `binaryType` and framing are unchanged. The first registered message listener timestamps raw message delivery before native decoding/queueing/hooks. It inspects transient JSON only to classify fixed event tags, item kinds, optional numeric sequence numbers and byte counts. It never retains bodies, prompts, scripts, private reasoning, URLs, headers, response IDs or error text. Unsupported encodings and overflow cannot silently pass correlation.

Each model turn retains WebSocket-send entry markers, per-attempt raw receive timestamps, parsed-provider callback timestamps, terminal/trailing-frame metadata, normalized start/delta boundaries, numeric usage/cache/cost/counters, CPU/lag and existing tool/CodeMode intervals. Match each parsed event to its ordered raw-frame tag/kind/sequence. Report listener overhead explicitly. Empty/missing metadata remains unknown.

- A raw receive timestamp is JavaScript message-listener entry, **not kernel packet arrival**.
- A send marker precedes the native send method, **not physical wire egress**.
- Raw→parsed includes observer inspection, native decode/queue and earlier hooks.
- Raw ACK→raw output-item combines server/model/network work and scheduling before JS delivery. It is **not pure server queue time**.
- First output items can be reasoning; item kind and all complete latency/normalized-delta intervals remain available. There is no private reasoning capture.
- No server receipt/compute-start timestamps or unrestricted wire contents are available. If operator-side logs exist, the previous UTC windows can be correlated separately; their availability is not assumed.

Qualification uses the actual native SDK with a synthetic WebSocket and forbidden HTTP networking, verifying both modes reuse sockets, only cached mode sends continuation, raw/parsed identities align and privacy sentinels are absent. Deterministic tests inject a200ms raw→parsed delay to demonstrate separation from interarrival time, and check schedule, missing data, limits, exact contrasts and non-authorization of release acceptance. No paid qualification calls are needed.

## Findings

The owned managed job `job-mvmmqg4c-539d` exited0,2026-10-24 **16:45:03.967–16:52:32.115UTC** (7m28s; controller time443.669s). All **48/48** assignments were measured with exact answer/observed-evidence passes, complete timing/usage/correlation and no tool/provider failures. SDK/catalog-reported cost was **USD0.4574688**. No case was retried or replaced, no sample was extended, and successful owned fixtures/spills were cleaned.

### Contemporary matched controls

| Metric (16 cases each) | Direct cachedWS | Hybrid cachedWS | Hybrid full-context WS |
| --- | ---: | ---: | ---: |
| Mean prompt latency | 7.748s | 9.199s (+18.7% vs direct) | 9.689s (+25.1% vs direct) |
| Median prompt latency | 7.583s | 8.335s | 8.885s |
| Observed maximum | 11.733s | 12.765s | 12.696s |
| Mean model pipeline/case | 7.736s | 9.056s | 9.549s |
| Mean CodeMode outer/case | 0 | 134.044ms | 131.025ms |
| Model turns / underlying reads | 48 /32 | 52 /36 | 54 /38 |
| CodeMode calls / spills | 0 /0 | 20 /4 | 22 /6 |
| Actual total tokens including cache | 110762 | 140061 | 150089 |
| SDK/catalog cost | USD0.1579656 | USD0.1490180 | USD0.1504852 |
| Post-first-turn>10s ACK→item stall cases | 0/16 | 0/16 | 0/16 |

With n16, nearest-rank p95 is the **observed maximum**, not a powered p95/noninferiority estimate. This one-task table does not replace the original equal-class profile. Full-context hybrid mean was5.3% higher than cached hybrid, descriptively, alongside more turns/reads/spills. Token totals increased for this chain task even though catalog cost decreased; do not import the earlier mixed-profile token-saving percentage. All workflow differences remain part of the observed policy effect.

### Primary result and raw-event timing

**No targeted>10s stall recurred in any arm.** Cached-only versus full-only discordant pairs were0 versus0: the predeclared one-sided exact p is **1**, with no evidence for continuation-related stall reduction. This is **inconclusive, not equivalence**. Under independent stationary trials,0/16 still permits approximately17.1% stall risk at a one-sided95% upper bound; temporal correlation/variation further limits extrapolation. Do not change the threshold or continue sampling until a stall appears.

All **154 model turns /154 observed SDK requests** used WebSocket, each session opening one socket then reusing it (48 created,106 reused). No native recovery, failure or SSE fallback was recorded. Direct/cached hybrid sent continuation on32/36 later requests respectively; full-context hybrid sent none on its54 requests while retaining socket reuse. Token-cache reads remained nonzero in **all modes**, including88832 cached-input tokens in the full-context arm. Plain WebSocket does not mean token-cache-off.

All **6144 raw receive events** matched6144 parsed events in ordered tag/kind/sequence metadata. Maximum raw-listener→parsed-provider-hook lag was **2.690ms** (direct),2.684ms (cached),1.632ms (full). Maximum measured raw-observer processing was1.235ms; summed observer intervals were241.209ms across the entire study. These are measured instrumentation intervals, not a claim to account for every instrumentation cost. No overflow, unconsumed tail or missing required timing occurred.

The longest raw post-first-turn ACK→output-item gaps were3.229s direct,2.895s cached and2.662s full. First item kinds were function call, custom tool call or message, not reasoning in this cohort. Raw→parsed processing was small **in this healthy window**. Because the earlier21.8s/23.9s parsed-event stalls did not recur, the new data **cannot retrospectively decide** whether those historical waits were pre-JS delivery/network/server/model work or asynchronous client delay. No server receive/queue/compute timestamps were obtained. Low client CPU/lag is supporting evidence, not a server-side clock or complete exclusion of pre-delivery client scheduling.

### Recommendation and remaining boundary

**HOLD remains; default-on is unchanged.** There is no evidence here for shipping a cached→full-context transport change as a latency fix, nor for clearing the original full-profile tail-latency gates. Ordinary hybrid latency still exceeded direct, with most of the arithmetic mean difference in the model pipeline and small measured CodeMode execution intervals; this is not causal subtraction.

The original360-session acceptance remains **unrun**, blocked by its frozen power prerequisite, not waived by a quiet targeted cohort. The remaining causal question requires observing an actual tail with raw timing under an appropriately fixed representative/mixed-workload protocol or obtaining provider-side timestamp correlation. Neither observation is available from this completed run. No further inference is queued, no post-hoc sample extension is authorized by this protocol, and no production/default/global/installed-Pi change, commit, merge or push was made.

### Evidence and integrity

- Immutable new cohort: `.pi/codemode-continuation-benchmark/live-1792860305312/`,98 files (protocol,summary,48 assignment markers,48 cases).
- Raw-tree SHA256: `f3f61f10af6adabb02b4be08418292367013fd62efae8199e3caf48801860545`.
- Separate reconciliation: `.pi/codemode-continuation-verification/analysis.json`; every assignment/fixture/per-turn-to-case usage/source-at-end/history/protected/default/mode/quality/timing check passed. Source hash identifies the measured snapshot before this findings text.
- Experiment `exp-codemode-continuation-raw-timing-2026`: measurement PASS, continuation contrast null-result, closed no-go for lifting HOLD. Prior decision and phase raw hashes remain unchanged.
- Qualification: new continuation tests and existing decision tests passed, including actual native QuickJS/loadouts and synthetic cached/full transport tests with HTTP forbidden. All8 integration checks passed; canonical Semgrep on5 affected JavaScript files reported0 findings,0 engine errors,0 fixpoint timeouts. Syntax and diff checks passed. No full-suite, field or TUI verification claim.
