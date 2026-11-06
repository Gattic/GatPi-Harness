# Pi trace observability subsystem

This repo contains a project-local Pi extension at `.pi/extensions/trace-observability/index.ts`.
It adds an append-only, replayable event trace for agent cycles without requiring changes to Pi core.

## Architecture

- **Typed event bus**: `TypedTraceBus` normalizes every event with `timestamp`, `correlation_id`, `parent_event_id`, `session_id`, `agent_id`, `subsystem`, `severity`, `payload`, and `duration_ms`.
- **Instrumentation adapters**: Pi extension lifecycle hooks map Pi events into trace categories: prompt assembly, context injection, model request/response, token accounting, tool exposure, file edits, shell execution, compaction, branching, cancellation/failure states.
- **Storage**: `TraceStorage` writes newline-delimited JSON to `<repo>/.pi/traces/<session>.jsonl` by default, rotates large files, and gzip+base64 compresses large payloads. Set `PI_TRACE_DIR` to override the root explicitly.
- **Prompt snapshots**: `before_agent_start` persists the rendered system prompt, developer/custom prompt pieces, user prompt, context files/memory-like documents, exposed tools, and hidden runtime instruction structures as hashable snapshots.
- **Diff tracking**: tool hooks capture git filesystem diffs around `edit`, `write`, and `bash`; file edits include pre/post hashes plus semantic line/char deltas and lightweight AST-like symbol deltas for TS/JS/JSON-family files.
- **Metrics**: in-memory aggregations track latency per subsystem, token events, retry counts, tool failure rates, and context usage snapshots.
- **Failure analysis**: the analyzer emits derived `failure_state` events for retry loops, recursive failures, hallucinated tools, exploding context windows, and patch reversions.
- **Replay**: trace files are deterministic JSONL event streams. `/trace-replay` inspects summaries or individual steps offline from the persisted log.

## Commands

```text
/trace-status             show trace file and metrics
/trace-live [filter]      live recent event view with optional text filter
/trace-timeline           timeline view for current session
/trace-errors             error/failure focused view
/trace-export [corr]      export JSON for all events or one correlation id
/trace-replay summary     summarize replay steps
/trace-replay step <n>    inspect a single persisted event
```

## Environment knobs

```text
PI_TRACE_ENABLED=0                    disable subsystem entirely
PI_TRACE_DIR=<repo>/.pi/traces        override trace root
PI_TRACE_ROTATE_BYTES=26214400        JSONL rotation threshold
PI_TRACE_MAX_TOTAL_BYTES=134217728    total trace dir cap; oldest rotated files pruned
PI_TRACE_HEADROOM_RATIO=0.25          prune down to 25% below the cap so the
                                      next session has room instead of sitting
                                      pinned at the ceiling
PI_TRACE_COMPRESS_PAYLOAD_BYTES=32768 compress large payloads
PI_TRACE_CAPTURE_PAYLOADS=0           metadata-only mode
PI_TRACE_SQLITE=1                     mirror to sqlite3 backend
PI_TRACE_RECENT=500                   in-memory recent event ring
PI_TRACE_LIVE_WIDGET=1                use TUI widget for /trace-live when UI exists
```

## Migration strategy

1. Enable project-local extension only for this repo and keep `PI_TRACE_ENABLED=1`.
2. Run normal smoke sessions and validate `/trace-status`, `/trace-timeline`, and `/trace-export`.
3. Review trace size and payload sensitivity; set `PI_TRACE_CAPTURE_PAYLOADS=0` for metadata-only operation if required.
4. Enable `PI_TRACE_SQLITE=1` only after JSONL traces are validated.
5. If later moved into Pi core, keep the event schema stable and replace extension hook adapters with core emitters.

## Benchmark plan

Use `scripts/benchmark-trace-observability.sh` to measure disabled/enabled command overhead and trace write throughput. The target is near-zero overhead when disabled and sub-millisecond append overhead for ordinary events.

## Replay contract

A replay consumer must treat each JSONL line as immutable. The order of lines is the execution order. `correlation_id` groups one user agent cycle; `parent_event_id` creates intra-cycle spans. Compressed payloads include SHA-256 of the original uncompressed JSON.
