# Run monitor

Date: 2026-11-01
Status: implemented

## Purpose

`run_monitor` periodically observes an existing `bg_run` job or `run_deck` run while the owning Pi session is alive. It fills the gap between one-shot `status`, the nine-minute bounded `run_deck watch`, and a Ralph-style automation loop.

Its behavior is bounded:

- it notifies only on an edge: pattern matched, target settled, observation timed out, or checking failed;
- on a terminal edge it runs `scripts/run-monitor-check.js` to probe the target and records the result as `scriptCheck`; it never sends a user message or starts a model turn;
- it never launches, stops, or mutates the target process.

Use `automation_loop` only when model work itself must repeat. Use `run_monitor` when one already-launched process merely needs observation. `bg_run`/`run_deck` point-in-time status and logs remain available, but explicit periodic-notification requests should attach this monitor rather than trigger repeated model polling.

## Model tool

Tool: `run_monitor`

Operations:

- `start {kind,targetId,intervalMs?,timeoutMs?,pattern?}` — validate and sample an existing `bg_run`/`run_deck` target, then start periodic observation if it is still active;
- `status {monitorId?}` — inspect one monitor or list the current session's monitors;
- `check {monitorId}` — sample immediately without waiting for the next timer tick; if the sample reaches a terminal edge, run the script probe and show it;
- `stop {monitorId}` — stop observation only; the target continues running;
- `list` — list monitors owned by the current Pi session.

Kinds are `bg_run` for `job-*` ids and `run_deck` for `run-*` ids.

## Commands

```text
/monitor-start <bg_run|run_deck> <target-id> [interval-seconds] [timeout-seconds] [:: pattern]
/monitor-status [monitor-id]
/monitor-check <monitor-id>
/monitor-stop <monitor-id>
/monitors
```

Example:

```text
/bg scripts/check-all.sh
/monitor-start bg_run job-abc123 30 1800 :: all checks passed
```

The first check happens immediately. The monitor then polls every 30 seconds for at most 30 minutes, stopping when the success pattern appears, the job exits, the deadline is reached, or the target can no longer be inspected.

## Script checks

Terminal monitor edges are checked by a deterministic harness script rather than by waking the model:

```text
node scripts/run-monitor-check.js --monitor <monitor-id> --session <session-id> [--json]
node scripts/run-monitor-check.js --session <session-id> [--json]
node scripts/run-monitor-check.js --all [--json]
node scripts/run-monitor-check.js --monitor <monitor-id> --session <session-id> --watch [--interval-ms 30000] [--timeout-ms 86400000] [--json]
```

`--all` is mutually exclusive with `--monitor` and `--session`. With `--watch`, `--json` emits one JSON document per line (NDJSON) so a long watch can stream results.

The script:

- samples active monitors with the same `checkMonitor` logic the extension uses;
- probes terminal monitors for fresh target evidence (`bg_run` status/exit or `run_deck` status/vitals) and persists it as `scriptCheck`;
- never reads a full log file, never sends a user message, and never starts a Pi turn or model call;
- exits `0` when checks complete, `2` for usage, validation, or check errors, and `3` when a `--watch` deadline is reached.

Because the checker is local and deterministic, it can also run from cron or a shell loop with `--watch` when no agent session is open. Monitor state is repository-local and session-bound; the script accepts `--session` to keep checks scoped to the owning session.

## Notification

Who observed the terminal edge decides how the result is shown:

| Observer | Notification |
|---|---|
| Background timer or session restore | edge notification with `script-check=…` |
| `/monitor-start` (already terminal) or `/monitor-check` | command result with `script-check=…` |
| `run_monitor start`/`check` tool result | tool result with `script-check=…` |
| Print/JSON session (`hasUI` false) | stdout line with `script-check=…` |

No observer sends a user message or starts a model turn. `timed_out`, `error`, and `stopped` edges are notifications only because they say nothing about the work itself.

Repeated checks are safe: terminal monitors are not sampled again, and the script probe only refreshes bounded target metadata. `run_monitor` tool results and slash commands never queue follow-ups.

## Lifecycle and state

State is private and repository-local:

```text
.pi/run-monitor/monitor-*.json
```

Each record is bound to the owning Pi session id. Active monitors survive `/reload` because the new extension instance restores monitors for the same session. `session_shutdown` clears every timer; orderly quit/new/resume/fork marks the old session's monitors stopped without touching their targets. A crash can leave an active record, which resumes only if that same Pi session is reopened.

Timers are `unref()`'d. In print mode, a monitor performs its immediate check but does not keep the process alive. Periodic notifications and script checks are therefore intended for persistent TUI/RPC sessions.

Polls avoid GPU probes and persist only bounded status metadata, never raw log tails. Optional literal patterns are capped at 500 characters and matched against at most the latest 32 KiB of target log text. Monitor state files use mode `0600`; the state directory uses `0700`.

`scriptCheck` records the last script probe:

```json
{ "at": "2026-11-01T00:00:00.000Z", "targetStatus": "exited", "alive": false, "exitCode": 0 }
```

`vitals` is included for `run_deck` probes when available. There is no `wake` claim; older records that still contain one are stripped on read and migrated on the next write.

Managed-process metrics v2 records keyed monitor attachments, one idempotent settlement notification per target, and one terminal-evidence category with capture time and working-tree fingerprint. Together with start and manual status/log counters, `runtime_doctor operation=harnessMetrics` reports attachment/notification/evidence rates, explicit gap counts, polling calls per start, and polling triples without commands, paths, output, or target/session ids. Run Deck status labels terminal evidence `current` or `stale-tree`; later tree changes never silently inherit an older terminal result.

## Effectiveness telemetry

A fixed local classifier treats a turn as eligible only when it combines monitor/watch/notify intent with a managed long-run target category. The classifier retains no text. At `agent_settled`, one opportunity row records whether `run_monitor start` acted on that intent. Direct `/monitor-start` use records an acted opportunity immediately.

Separate feature signals cover `started`, `matched`, `settled`, `timed-out`, `stopped`, `error`, and `settlement-notified`. They contain only target kind, canonical outcome, check count, duration, coarse session kind, and a local-salt HMAC session token. They contain no raw session/target id, pattern, prompt, command, path, log text, or process output. This cohort is measurement-only and cannot authorize automatic attachment.

## Bounds

```text
PI_RUN_MONITOR=0                 disable the extension
PI_RUN_MONITOR_INTERVAL_MS=30000 default poll interval
PI_RUN_MONITOR_TIMEOUT_MS=86400000 default observation deadline (24h)
PI_RUN_MONITOR_MAX_ACTIVE=8      active monitors per Pi session
PI_RUN_MONITOR_INTENT_TELEMETRY=1 metadata-only intent/lifecycle signals; set 0 to disable
```

Per-monitor intervals are clamped to 1 second through 1 hour. Observation deadlines are clamped to 1 second through 7 days. A timeout means only that the requested observation window ended; it does not classify or stop the target.

## Verification

```bash
node tests/run-monitor.test.js
node tests/run-monitor-extension.test.js
node tests/run-monitor-check-script.test.js
node scripts/extension-smoke-runner.js rpc extensions/run-monitor/index.ts
```
