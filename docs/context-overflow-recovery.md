# Context-overflow compaction recovery

## Incident finding

A privacy-bounded scan of `~/.pi/agent/sessions/**/*.jsonl` found actual Codex context-window failures as assistant messages with `stopReason: "error"` and zero usage. Most are immediately followed by a `compaction` entry and a successful post-compaction assistant response.

The two reported lines

```text
Context overflow recovery failed: Summarization failed: WebSocket error
Auto-compaction failed: Summarization failed: WebSocket error
```

are different: Pi emits them as transient `compaction_end` UI errors. It does **not** append failed compaction events to the session JSONL. Consequently, searching session files for the full strings only finds prompts that quote the errors, not the original event. A missing `compaction` entry after an overflow, followed by repeated overflow errors, is the durable failure signature.

One inspected `pi-harness` session had a context-window error at JSONL line 749 and a successful compaction at line 750. That session demonstrates the normal recovery path; it does not persist the later UI-only compaction failure text.

A separate output-limit example had an assistant message with `stopReason: "length"`, followed by a successful extension threshold compaction with `willRetry: false`, and then a manually entered `Continue`. The compaction succeeded, but Pi correctly treated threshold compaction as non-retry work and therefore had no queued turn to resume. This left the compacted session idle even though the assistant response was incomplete.

A later manual attempt reported `Session compacted 5 times`, followed by both default and rescue summarization WebSocket failures. Five prior compactions are not a Pi limit. The sequence means `/compact-rescue` was registered, but its custom `session_before_compact` result was lost, so Pi fell through to the default network summarizer.

The fleet-level cause was an observer composition bug in `.pi/extensions/trace-observability/index.ts`: its `session_before_compact` handler returned the trace record from `emit()`. Pi treats every truthy `session_before_*` return as control protocol, so the later-loaded trace observer overwrote the recovery extension's `{ compaction: ... }` result. Trace `session_before_switch`, `session_before_fork`, `session_before_compact`, and `session_before_tree` observers now use block bodies and return `undefined`.

A second reload hazard was also fixed: jiti reloads TypeScript extension source without module caching, while Node can retain an older CommonJS `src/context-overflow-recovery.js` export object. Recovery now evicts that helper on every extension load.

## Root cause

In Pi 0.80.6, overflow recovery calls the normal LLM summarizer from `_runAutoCompaction()`. The summarization request uses the active stream function but does not include the agent session ID or selected transport. Codex therefore defaults the summarization request to `auto` transport. If that summarization stream fails after WebSocket output has started:

1. Pi cannot safely replay the same partial stream as SSE inside the provider call;
2. `compact()` throws `Summarization failed: WebSocket error`;
3. `_runAutoCompaction()` emits a UI error and returns without writing a compaction entry;
4. the still-oversized conversation cannot make another normal model request.

The session file remains valid and retains full history. Deleting or hand-editing JSONL is not required.

## Recovery extension

The globally loaded extension at

```text
.pi/extensions/context-overflow-recovery/index.ts
```

intercepts compaction whenever Pi is at context pressure:

- automatic compaction with `reason: "overflow"`;
- automatic threshold compaction, before a too-large summarization request can strand the session;
- pre-model-call compaction inside long tool-use chains when active usage reaches 80% or bounded active structured context exceeds 8 MiB, with `agent_settled` retaining the same decision as a fallback;
- ordinary manual `/compact` when the latest assistant error is a context-limit error or token usage is at the model's compaction boundary; and
- explicit `/compact-rescue` as a forced recovery path.

It first asks the active model for a summary over forced **SSE**, with the real Pi session ID, no nested provider retries, and a bounded timeout. If SSE, authentication, or the provider still fails, it installs a bounded local extractive summary from Pi's prepared compaction messages. The local summary preserves:

- the previous compaction summary;
- recent user requests and constraints;
- recent assistant progress;
- tool/provider blockers;
- tool names;
- cumulative read and modified file lists; and
- split-turn continuation state.

The local fallback performs no network call and therefore gives recovery a compaction result even during a provider transport outage or when the summarization request itself exceeds the model input limit. On every extension load, the extension evicts its CommonJS helper from `require.cache`, so `/reload` cannot combine fresh hook code with stale helper exports. The hook is also fail-closed for known overflow/rescue events: if structured local recovery itself throws, it returns a minimal dependency-free summary rather than allowing Pi to fall through to network summarization. A fleet regression test verifies that the later trace observer returns `undefined` and cannot replace this result.

Continuation is automatic:

- for provider overflow with `willRetry: true`, Pi's own post-run loop calls `agent.continue()` after the extension returns a valid compaction; the extension deliberately does not inject a duplicate prompt;
- for an already-stuck session repaired by over-limit manual `/compact` or `/compact-rescue`, the extension schedules a continuation message after manual compaction has fully reconnected the AgentSession;
- after Pi reaches `agent_settled`, an assistant `stopReason: "length"` (or the equivalent maximum-output-token error) receives an automatic continuation, including when a threshold compaction was inserted after that assistant message; and
- ordinary threshold compaction that did not follow an output-limit stop preserves Pi's existing behavior.

Output-limit continuation is bounded to three consecutive injected turns by default. The bound resets after a normally completed assistant response. If another extension has already started or queued a turn, recovery suppresses its own injection so automation loops and goal controllers remain the single continuation owner.

Manual `/compact` below context pressure keeps Pi's default summarizer.

During a tool-use chain, the extension's `before_model_call` guard reuses the same bounded decision and returns `{ compact: true }` without aborting the run or draining queued messages. The source-backed Pi fork performs threshold compaction after the completed tool batch and replaces the next-turn context with the rebuilt checkpoint before polling steering messages or making another provider request. Assistant tool calls, finalized tool results, and queued steering/follow-up messages therefore remain ordered and available to the continuation. The settled fallback still uses Pi's documented `ctx.compact()` lifecycle.

Both paths append a normal compaction checkpoint and rebuild only the active model context; the existing session JSONL remains append-only and no session file is truncated, deleted, or migrated. A bounded object traversal estimates only the provider-visible messages and fields from Pi's active session context, without serializing the entire branch into another heap-sized string. Extension-only custom state, tool details, usage metadata, and raw base64 image payloads are excluded; image pressure continues to participate in the model's token-usage threshold. Requests are de-duplicated by active leaf, and both proactive paths honor Pi's `compaction.enabled` setting.

## Recovery runbook

The harness extension directory is already listed in `~/.pi/agent/settings.json`, so activate a newly installed version with:

```text
/reload
```

For a chat that is already stuck after failed auto-compaction:

```text
/compact-rescue Preserve the interrupted task, completed work, blockers, and exact next steps.
```

`/compact-rescue` now sends the continuation automatically after compaction succeeds. Do not send a second `continue` unless you intentionally want another turn. Future overflow retries continue through Pi's normal post-compaction loop. If a model instead stops at its maximum output-token limit, the extension sends a bounded continuation at `agent_settled`, after any threshold compaction has completed.

If the old implementation already produced `Rescue compaction failed ... WebSocket error`, run `/reload` once to load the cache-evicting version, then retry `/compact-rescue`. The repaired command should install either the structured local summary or the minimal fail-closed summary even if both WebSocket and SSE are unavailable.

Inspect configuration and in-process counters with:

```text
/compaction-recovery-status
```

## Configuration

```text
PI_COMPACTION_RECOVERY=0                    disable the extension
PI_COMPACTION_RECOVERY_NETWORK=0            skip forced-SSE summarization and use local recovery immediately
PI_COMPACTION_RECOVERY_TIMEOUT_MS=60000      forced-SSE timeout (minimum 5000 ms)
PI_COMPACTION_RECOVERY_MAX_INPUT_CHARS=600000 serialized summarization input cap
PI_COMPACTION_RECOVERY_MAX_SUMMARY_CHARS=24000 installed summary cap
PI_COMPACTION_RECOVERY_AUTO_CONTINUE_OUTPUT_LIMIT=0 disable automatic continuation after output truncation
PI_COMPACTION_RECOVERY_MAX_OUTPUT_LIMIT_CONTINUATIONS=3 consecutive automatic-continuation bound
PI_COMPACTION_PROACTIVE=0                    disable proactive settled-context compaction
PI_COMPACTION_PROACTIVE_PERCENT=80           context-usage trigger percentage
PI_COMPACTION_PROACTIVE_MAX_CHARS=8388608    bounded active structured-context trigger
```

## Claim boundary

The forced-SSE path preserves normal LLM summary quality when transport recovers. The local path is deliberately extractive and less complete than a successful LLM summary, but it is bounded, deterministic, and sufficient to make the session requestable again. Full pre-compaction history remains in the JSONL tree and can still be inspected through `/tree`; proactive compaction does not delete any existing session files.
