# Memory rollout follow-ups — 2026-11-22

Status: effective stage **M1** (operator opt-in; passive candidate M1). `D`, `P`, `B`
pass; `S1`, `R`, `SD`, `C`, `A` remain insufficient, so the passive candidate cannot
advance to M2. The soak fixture passes `D/P/B/S1/R/SD` (41 explicit saves over 28 days,
21 shadow outcomes over 7 sessions, agreement 1.0), but that is synthetic soak evidence
inside `.pi/soak/**`, not rollout evidence.

Production telemetry at `2026-11-22` (90-day window, `emit:false`):

| Predicate | Observed | Threshold | Status |
|---|---|---|---|
| S1 explicit saves | 14 saves / 3 days / precision 0 (0 in the 14d window) | ≥20 / ≥7 days / ≥0.95 | insufficient |
| R recall quality | 0 `recall.completed`, 0 sessions, 0 days | ≥30 / ≥10 sessions / ≥14 days | insufficient |
| SD shadow agreement | 0 `shadow.outcome` | ≥20 / ≥5 sessions / ≥7 days / ≥0.90 | insufficient |
| C curation | 419 previews / 24 days, but 1 unstable candidate set | ≥14 previews / ≥14 days / 0 unstable | fail |
| A automatic saves | 0 | ≥30 / ≥10 sessions / ≥14 days / ≥0.98 | insufficient |

## Why `recall.completed` is still zero

The recall chain is: reasoning-runtime `before_agent_start` → `recallTelemetryPayload()`
→ `pi.events.emit("code-context:retrieval")` → trace-observability listener →
`FileTraceStorage`. It works in a fresh process (a headless probe with
`PI_TRACE_DIR=/tmp/...` produced 1 `session_start` and 1 `recall.completed`), but the
live process cannot reach it:

1. **The running process predates the emitter.** The interactive session file starts at
   `2026-11-19T15:50:10Z`; the emitter (`recallTelemetryPayload` call, commit `8d92502`)
   landed `2026-11-21T15:26:35Z` UTC. Modules are loaded once at process start, so the
   live reasoning-runtime has no recall emitter until Pi restarts.
2. **The retrieval listener is only subscribed on `session_start`.** The live trace
   `7c15fe8f…--d52d044769376b5d.jsonl` contains **0 `session_start`** events and no
   `memory_retrieval`/`memory_decision` categories. `subscribeRetrieval()` runs only in
   the `session_start` handler, so no `code-context:retrieval` subscription exists in
   this process.
3. **Payload capture is off.** `PI_TRACE_CAPTURE_PAYLOADS=0`, and `materializeRecord()`
   strips `payload` from every event. The capture=0 probe wrote `recall.completed` with
   **0 payload keys**, so even a landed event would fail `R` with
   `recall-payload-incomplete` (`durationMs`, `returnedHashes`, `outOfScopeCount`,
   `injected` are required).
4. **Other sources do not count.** Headless probes wrote to `/tmp` trace dirs, not
   `.pi/traces`. The 42 `recall.completed` events in `.pi/traces` are Hermes-memory rows
   from `2026-07-09 … 2026-07-27`, outside the 90-day window and payload-less.

## Why `shadow.outcome` is still zero

`shadow.outcome` is emitted by `ProjectMemoryAdapter.emitDecision()` only when a
`shadowed` decision is resolved by a real decision recorded for the same
`candidateHash`:

1. **No shadow proposals exist.** The ledger's last `shadowed` row is
   `2026-10-25T22:54:47Z`; no decision of any action has been recorded since
   `2026-10-26T13:07:56Z`. Without a shadowed proposal there is no outcome to emit.
2. **Shadow recall is not authorized at this stage.** With
   `PI_PROJECT_MEMORY_AUTOMATIC=1` task recall is authorized at M1
   (`taskRecall:true`), and `shadowRecallAuthorized` requires `!recallAuthorized`;
   controls report `shadowRecall:false`, `candidateCapture:false`. Shadow measurement is
   therefore inert until M2 or until an M1 posture without operator auto-recall.
3. **Same telemetry gaps as R.** The `project-memory:telemetry` listener is registered
   only on `session_start`, and payload capture strips `agreed`/`applied`/`proposalHash`,
   which `SD` requires.

## Follow-ups

The sequenced M1 → M2 plan — steps, owners, success thresholds and evidence locations —
lives in [`memory-rollout-m1-m2-action-plan.md`](./memory-rollout-m1-m2-action-plan.md).
The items below are the individual follow-ups it schedules.

### F1 — Make the retrieval/telemetry subscription lifecycle-safe
`subscribeRetrieval(ctx)` is only called from `session_start`
(`.pi/extensions/trace-observability/index.ts`). Call it idempotently from
`before_agent_start` (it already unsubscribes first) so resumed or long-lived sessions
attach without depending on that event.

### F2 — Retain gate payloads when capture is off
`src/trace-observability.js` `materializeRecord()` drops `payload` for every event when
`capturePayloads` is false. Retain the sanitized payload for `memory_retrieval`,
`memory_decision` and `memory_curation` only; those fields are hashes, counts, latency
and booleans, so the privacy posture is unchanged while `R`/`SD` become measurable.

### F3 — Restart the Pi process and raise the trace cap
The live process must be restarted to load the merged modules. `.pi/traces` is ~153 MB
against `PI_TRACE_MAX_TOTAL_BYTES=134217728` (≈96 MiB effective with 0.25 headroom), so
retention prunes old evidence; raise the cap (or shorten `maxAgeDays`) before accrual.

### F4 — Accrue real explicit saves for S1
No code change is required: the store already stamps `automatic:false`,
`sessionIdHash` and the candidate's `verification`. S1 needs ≥20 **verified** explicit
saves across ≥7 days from ordinary sessions; the 14 legacy rows are out of the 14-day
window and all `unverified`.

### F5 — Enable shadow measurement for SD
Record shadowed proposals and their resolutions (M2, or an M1 posture without operator
auto-recall) so ≥20 outcomes across ≥5 sessions/≥7 days can accumulate with agreement
≥0.90. Depends on F1/F2 for delivery.

### F6 — Fix curation instability for C
The 90-day window fails on one unstable candidate set between
`2026-10-26T11:01Z` and `11:38Z` (hash set 1→0). Fix the settle path, then accrue 14
distinct preview days.

### F7 — Revisit the A precision bar
`A` requires ≥0.98 verified precision, but operator capture forces
`verification:"unverified"`, so the bar is unreachable before M5. Decide whether the
automatic-capture path can produce verified entries or whether the bar must be
redefined for M5.

## Tracking

These follow-ups are documentation only. A GitHub issue could not be opened from this
environment (`gh` is not installed and no `GH_TOKEN`/`GITHUB_TOKEN` is set); the text
above is ready to paste into an issue or to split into one issue per follow-up.
