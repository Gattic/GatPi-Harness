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

## Evidence tooling

Three read-only helpers report the window; none writes rows or backdates time:

| Script | Purpose |
|---|---|
| `scripts/memory-evidence-status.js` | Authoritative predicate verdicts, counts, and the stage-ceiling note |
| `scripts/memory-evidence-window.js` | 14-day UTC grid per criterion; `--json` for scripts, `--strict` to exit 1 and print the failing keys |
| `scripts/check-memory-evidence.sh` | Strict gate wrapper for CI or pre-commit |

`--strict` fails when `count < need` or `days < daysNeed` for S1/R/SD/C/A and prints
`strict: incomplete criteria: …` to stderr, leaving `--json` stdout parseable. Wire the
gate into a promotion job with `scripts/check-memory-evidence.sh`, or set
`PI_MEMORY_EVIDENCE_STRICT=1` when running `scripts/check-all.sh`. It is opt-in so the
deterministic suite (and the `D` predicate that reads its record) stays green while the
window accrues. Soak output under `.pi/soak/**` is never counted as rollout evidence.

### Gate runs (2026-11-23)

Both runs were executed from the canonical checkout at `ea269d6` (332 test files).

| Run | Command | Exit | Result |
|---|---|---|---|
| Default (gate off) | `scripts/check-all.sh` | 0 | `all deterministic checks passed (332 test files)` in 406s |
| Opt-in (gate on) | `PI_MEMORY_EVIDENCE_STRICT=1 scripts/check-all.sh` | 1 | suite green (332 files); gate printed `strict: incomplete criteria: S1, R, SD, C, A`; total 448s |
| Re-run after remediation doc (`da3fac6`) | `PI_MEMORY_EVIDENCE_STRICT=1 scripts/check-all.sh` | 1 | suite green (332 files); same gate failure; total 391s |

The opt-in run fails only on the evidence gate, as intended: the suite itself passes and
the failure names the five incomplete criteria. The default run stays green because the
gate is off, so the `D` predicate that reads the full-suite record is unaffected.

The remediation-doc re-run confirms the gate still fails on the same five criteria. One
intermediate re-run (420s) also hit a transient benchmark timing spike
(`tests/project-memory-benchmark.test.js`: recall p95 50.8 ms against the 50 ms bar;
standalone runs measure ~28 ms), which cleared on the clean re-run — treat that test as
load-sensitive rather than a code regression.

The first default run exposed one stale test: `tests/project-memory-automatic.test.js`
assumed automatic capture was enabled by ambient defaults, but the operator posture now
declares `automatic:false`. It was fixed in `ea269d6` by pinning
`PI_PROJECT_MEMORY_POSTURE=env` and `PI_PROJECT_MEMORY_AUTOMATIC=1` in the test fixture,
so the enabled path is exercised without depending on the live posture file.

## Remediation path for the strict gate

The strict gate (`scripts/check-memory-evidence.sh`, `--strict`, or
`PI_MEMORY_EVIDENCE_STRICT=1`) fails while any criterion is short on count or distinct UTC
days. Evidence is append-only and real: never seed, backdate, or count `.pi/soak/**` rows,
and headless `pi -p` fails closed to M0 without recording recall.

A qualifying day is the UTC date of at least one qualifying event for that criterion. The
window is rolling 14×24h, so an event drops out after 14 days and a skipped day moves the
earliest floor forward. Check daily with `node scripts/memory-evidence-window.js` (per-day
grid and floors) and `node scripts/memory-evidence-status.js` (authoritative predicate
verdicts).

| Criterion | Requirement | Qualifying event | How to record it |
|---|---|---|---|
| S1 | ≥20 explicit saves, ≥7 days, precision ≥0.95 | decisions row `action:"saved"`, `automatic` absent/false, `verification:"verified"` | 3 verified explicit saves per day via `memory_curator` save with `apply:true`, `explicit:true`, `verification:"verified"`; 7 days yields 21 |
| R | ≥30 `recall.completed`, ≥10 sessions, ≥14 days, p95 ≤50 ms, out-of-scope 0, citation ≥0.40, stale ≤0.05 | trace `memory_retrieval`/`recall.completed` with `durationMs`, `returnedHashes`, `outOfScopeCount`, `injected` | 3 recall-triggering prompts per day in an interactive session (shadow at M1); later decisions in the same session must cite returned hashes through `evidenceIds` |
| SD | ≥20 `shadow.outcome` with `applied:false`, ≥5 sessions, ≥7 days, agreement ≥0.90 | trace `memory_decision`/`shadow.outcome`, emitted when a real save/update resolves a `shadowed` candidate with the same `candidateHash` | requires `candidateCapture` (effective M3+): shadow recall at M1 emits only `recall.completed`; candidate capture records `shadowed` proposals, and real saves/updates resolve them. Not recordable from an M1 session |
| C | ≥14 `kind:"settle"` previews, ≥14 days, stable consecutive `candidateHashes`, accounting ≥0.95, `diagnosticOnly`+`vaultReady` | diagnostics `kind:"settle"`, written on `agent_settled` | complete at least one agent turn each UTC day; keep the candidate set stable between settles (avoid new durable entries that change `candidateHashes`) |
| A | ≥30 automatic saves, ≥10 sessions, ≥14 days, verified ≥0.98, curation success ≥0.90, timeout ≤0.10 | decisions row `action:"saved"`, `automatic:true`, `applied:true`, plus `curation.completed` outcomes | requires `automaticCapture` (`PI_PROJECT_MEMORY_AUTOMATIC=1` under the explicit M1 opt-in) or M5 automatic verified upserts; not recordable under the current M1 posture (`automatic:false`) |

Current standing (window ending 2026-11-23): S1 0/20 (0/7 days), R 6/30 (1/14), SD 0/20
(0/7), C 186/14 (9/14, days-bound), A 0/30 (0/14). C needs five more elapsed days; the
others need both volume and days.

Ordering matters: S1 and R unlock M2 eligibility, SD unlocks M3, C unlocks M4, and A
unlocks M5. Raise the requested stage only after S1 and R pass — requesting M2 during
accrual drops the explicit M1 opt-in and fails closed to M0. The ceiling is
`min(requested, eligible, hold)`.

### Missing rows at M1 (2026-11-23)

| Gate | Expected row | Present |
|---|---|---|
| S1 | `decisions.jsonl`: `action:"saved"`, `automatic` absent/false, `verification:"verified"`, `at` inside the window | 0; the 14 existing `saved` rows are all `unverified` and dated 2026-10-23…26 (outside the window) |
| SD | traces: `category:"memory_decision"`, `name:"shadow.outcome"`, `payload.applied:false`; prerequisite `shadowed` decisions and `shadow.proposed` events | 0 outcomes, 0 proposals; the 7 existing `shadowed` rows date to 2026-10-25 and carry only hashes, no content to resolve |
| A | `decisions.jsonl`: `action:"saved"`, `automatic:true`, `applied:true`, plus `curation.completed` outcomes | 0 automatic saves, 0 `curation.completed` |

At M1 only S1 and R can accrue: shadow recall emits `recall.completed` (R) but never
`shadowed` proposals, and `candidateCapture` requires M3+. SD and A are therefore
downstream measurements whose zero counts are structural, not operator inaction. R holds
6–7 completions on 1/14 days from this session's own turns.

## Tracking

These follow-ups are documentation only. A GitHub issue could not be opened from this
environment (`gh` is not installed and no `GH_TOKEN`/`GITHUB_TOKEN` is set); the text
above is ready to paste into an issue or to split into one issue per follow-up.
