# Pi session reliability investigation — 2026-07-14

## Scope and privacy

This investigation analyzed `~/.pi/agent/sessions/**/*.jsonl` locally. It persisted and reports only counts, fixed categories, and anonymized session fingerprints. No session prompts, reasoning, commands, tool arguments, raw outputs, credentials, or session repository paths are included here.

The full on-disk corpus contained:

- 1,387 session files;
- 266,506,575 bytes;
- 57,238 JSONL rows;
- zero malformed JSON rows.

The files themselves are healthy. The evidence does not support session-file corruption as a recurring crash cause.

## Findings

### 1. Provider transport failures dominate crash-like events

There were 513 explicit assistant `error`/`aborted` messages in 65 sessions:

| Fixed category | Messages | Affected sessions |
|---|---:|---:|
| transport (`fetch failed`, WebSocket close/error, termination) | 389 | 62 |
| timeout (primarily 300-second Codex SSE header timeout) | 79 | 10 |
| context limit | 33 | 19 |
| provider server | 7 | 4 |
| credentials | 3 | 2 |
| cancelled | 2 | 2 |

Of the 65 affected sessions, 58 later produced a non-error assistant response. Seven ended on an explicit provider failure. Five additional old sessions ended at a pending user message or tool boundary; those are interruption indicators, not proof that the Pi process crashed.

Failures spiked on July 13–14. A read-only reviewer subagent launched during this investigation also failed to make its first model call before its 300-second RPC budget expired, so the transport problem was still observable during the investigation.

### 2. Retry policy amplifies an outage into 15–20 minute stalls

The default HTTP idle/header timeout is 300,000 ms and Pi permits three agent-level retries after the initial attempt. Repo-local traces from one heavily affected session recorded `agent_end` durations of approximately 892, 925, 1,006, and 1,160 seconds. That is consistent with repeated five-minute provider timeouts plus retry overhead.

Provider-level retries were not configured, which is correct: stacking SDK retries under agent retries would make stalls longer and less visible.

### 3. Auto transport already switches the next request to SSE after a WebSocket failure

Recent assistant diagnostics showed:

- 60 WebSocket failures before the first stream event. Pi activated same-request SSE fallback; SSE recovered 48 and failed 12.
- 59 WebSocket failures after streaming had begun. Same-request fallback is unsafe because partial output was already emitted, so Pi correctly returned an error.

A follow-up source review found that `recordWebSocketFailure()` activates the session-wide SSE marker before returning either kind of WebSocket transport error. The current mid-stream request still fails, but the next request with the same session ID skips WebSocket and uses SSE. A focused linked-fork regression test now verifies:

1. an `auto` WebSocket response emits one event and then times out;
2. the current result remains an error and no same-request SSE call occurs;
3. the next request with the same session ID skips WebSocket and succeeds over SSE.

No provider implementation patch is needed for this behavior. The reliability issue is the underlying transport/SSE instability and the latency cost of bounded retries, not a missing next-request fallback marker.

### 4. Context overflow is noisy and usually self-healing, but compaction transport can fail

At the time of the original scan, all 19 sessions with a context-limit error later wrote a compaction entry and recovered after compaction. One long session eventually ended on a later context-limit error.

A follow-up incident exposed a blind spot: `Context overflow recovery failed: Summarization failed: WebSocket error` and `Auto-compaction failed: Summarization failed: WebSocket error` are transient `compaction_end` UI events and are not appended to session JSONL. Session mining therefore sees the overflow but cannot directly count failed summarization attempts. A missing compaction entry followed by repeated overflow errors is the durable signature.

The requests immediately before overflow were commonly near the 372K context ceiling for `gpt-5.6-sol`. Overflow can occur inside one long tool-use turn because threshold compaction runs when the agent turn settles, while tool calls can continue increasing context before that boundary. Pi 0.80.6 also invokes the compaction summarizer without the agent session ID or explicit transport; a mid-stream summarization WebSocket failure can therefore leave the oversized chat unable to make a normal request.

Mitigation:

- keep `.pi/extensions/context-overflow-recovery/` enabled; it forces SSE for overflow summaries and installs a bounded local fallback if network summarization still fails;
- after an already-failed recovery, run `/reload`, then `/compact-rescue`; successful rescue now continues the interrupted task automatically;
- run `/compact` before another large autonomous/tool-heavy phase when the footer is near the context limit;
- prefer bounded native tools and summarized status calls over large repeated shell output;
- start a fresh session or fork after banking a durable handoff for very long tasks;
- do not disable overflow compaction—the normal path recovers most sessions, and the extension covers its transport-failure gap.

See [`context-overflow-recovery.md`](context-overflow-recovery.md) for the investigation boundary and recovery runbook.

### 5. Most tool errors are workflow friction, not crashes

The full corpus contained 813 tool results marked as errors. Fixed local classification produced:

| Category | Count | Interpretation |
|---|---:|---|
| `command-failure` | 216 | Usually expected diagnostic/test failure |
| `policy-boundary` | 135 | Safety control working as designed |
| `missing-resource` | 115 | Preflight/status problem |
| `edit-match` | 109 | Reread and use unique exact context |
| `invalid-arguments` | 67 | Schema/operation mismatch |
| `timeout` | 52 | Long command used through a blocking tool |
| `parse-syntax-patch` | 31 | Quoting, regex, or stale patch issue |
| `unknown-tool-error` | 23 | Needs local review if it recurs |
| `out-of-range` | 21 | Stale offset or incorrect file assumption |
| `adapter-failure` | 18 | Optional adapter unavailable/failed |
| `automation-contract` | 15 | Completion promise/state misuse |
| `missing-prerequisite` | 11 | Tool called out of order |

High-value avoidances:

- check CodeGraph/Semgrep/Obsidian status before calling optional adapters and fall back when unavailable;
- run verification before `evidence_binder` capture;
- preserve the exact automation-loop completion promise and do not complete a loop without evidence;
- reread a target immediately before `edit`, use a unique `oldText`, and avoid concurrent edits to the same region;
- use `bg_run`, `build_project`, `test_project`, `test_runner`, and `run_deck` instead of blocking shell commands for long work;
- treat policy blocks as expected safety outcomes rather than retries to bypass.

### 6. Runtime state is large but is not the primary failure signature

The runtime audit found roughly 22 MB of cognitive state and 115 MB of traces. This can increase inspection and shutdown overhead, but the longest observed turns correlate directly with provider retries. Export important traces and use the stabilizer's trace-pruning workflow periodically; do not delete session files as a reliability fix.

## Recommended order of action

1. **Keep the linked-fork regression test for next-request SSE fallback after a mid-stream WebSocket failure.** Existing provider code already performs this fallback.
2. **Keep transport `auto` by default.** Pre-stream auto fallback recovered 80% of observed attempts; forcing SSE globally is not clearly better because SSE fetch failures and header timeouts were also frequent.
3. **Do not change global retry/timeout settings without a measured A/B check.** Full-history consecutive-error sequences show that one retry covered 327/387 recoveries (84.5%) and two retries covered 365/387 (94.3%); reducing the default would trade long stalls for lost automatic recoveries. Lowering `httpIdleTimeoutMs` also affects legitimate stream idleness and high-reasoning requests, so test 120–180 seconds in a bounded profile before adopting it globally.
4. **Keep `retry.provider.maxRetries` at `0`** to avoid hidden nested retries.
5. **Keep context-overflow recovery enabled; use proactive manual compaction and bounded tool output** for long tool-use turns. Overflow/threshold pressure is rescued automatically; `/compact-rescue` repairs an already-failed compaction and continues automatically.
6. **Run the privacy-safe session miner regularly** and compare provider-error categories, terminal failures, stale pending states, and tool-failure categories after each mitigation.
7. **Prune exported trace state periodically** using the non-destructive stabilizer workflow.

## Follow-up execution

- Source review confirmed that the linked Pi fork already activates session-wide SSE fallback for the next request after both pre-stream and mid-stream WebSocket failures.
- Linked-fork commit `0311846a` adds the missing regression coverage: the current partial WebSocket request fails, and the next request with the same session ID skips WebSocket and succeeds through SSE.
- Linked-fork commit `1d112987` repairs the static-catalog E2E provider type after the dynamic `radius` provider expanded `KnownProvider`; this was required for the fork's mandated `npm run check` to pass.
- Transport remains `auto`, provider-level retries remain at their default of zero, and no global timeout/retry setting was changed because the evidence does not yet establish a safe latency/recovery tradeoff.
- A runtime-doctor export was captured before cleanup review. Cleanup preview found no policy-eligible trace or state items, so nothing was deleted.
- Follow-up recovery support now lives in `.pi/extensions/context-overflow-recovery/`: overflow and threshold-pressure summaries force SSE and fall back to a bounded local extractive summary. The reproduced manual-rescue failure was caused by a later trace observer returning a truthy trace record and overwriting the recovery hook's compaction result; all trace `session_before_*` observers now return `undefined`. CommonJS helper cache eviction plus a dependency-free fail-closed summary also prevents reload/helper errors from falling through to the default WebSocket summarizer. Pi continues overflow retries itself; over-limit manual compaction and `/compact-rescue` queue continuation automatically without editing session JSONL.

## Monitoring added in this repository

`src/session-miner.js` schema v3 now persists only fixed aggregate categories for:

- Pi provider errors and assistant stop reasons;
- affected, recovered, terminal-failed, and unresolved Pi sessions;
- completed, failed, and pending terminal states, with a one-hour stale view;
- tool-failure categories and per-category tool counts.

It also emits a reviewed-learning candidate when recurring Pi transport/server failures cross the evidence threshold. Raw error text is inspected only in memory and is covered by regression tests that ensure secrets, paths, commands, and error messages are not persisted.
