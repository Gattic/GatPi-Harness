# Phase 5 context/privacy benchmark

Date: 2026-07-26
Status: Phase 5 acceptance gates passed

## Scope and privacy boundary

This benchmark records aggregate counts, byte/character totals, categorical outcomes, modes, and pass/fail bars only. It does not persist prompts, suggestions, transcripts, raw branch state, commands, outputs, credentials, or absolute paths.

## Pre-change cognitive-injection baseline

The frozen audit baseline in `.pi/session-audit/REPORT.md` found 1,643 `cognitive-automation` injections across 269 sessions, approximately 10.36 million characters total, mean approximately 6.3k characters, and p95 at the 7,001-character cap. The reasoning-injection source investigation also recorded a concentrated session with 237 of 245 byte-identical approximately 6.7k-character blocks.

The metadata-only post-telemetry cohort immediately before Phase 5 contained:

| Metric | Baseline |
|---|---:|
| Context-injection events | 5 |
| Total injected characters | 30,735 |
| Mean characters per event/interactive turn | 6,147 |
| First/full injections | 1 |
| Delta injections | 4 |
| Suppressed/identical injections | 0 |
| Events marked changed | 5/5 |

Although section-level deduplication existed, every observed turn still injected a large changed payload. Volatile scaffold IDs/timestamps, broad memory retrieval, repeated objective/proof history, and repeated stable auto-router guidance were the identified causes.

### Ship bar

The deterministic post-change benchmark must average at most **2,459 injected characters per interactive turn**, a reduction of at least 60% from 6,147, while preserving the current objective, constraints, runtime version, and explicit safety boundary in deterministic retention checks.

## Pre-change prompt-suggestion baseline

The available metadata-only cohort contained 10 prompt-suggestion events:

| Source/action | Count |
|---|---:|
| Local shown | 5 |
| Hermes shown | 2 |
| Hermes timed out | 2 |
| Hermes accepted | 1 |

Generation/refinement latency and successful generation outcomes were not separately recorded, so end-to-end cost and value could not yet be calculated. The observed automatic Hermes sample was also too small and had two timeouts; it does not justify default automatic refinement.

### Reviewed rollout policy

- Keep deterministic local suggestions enabled and immediate by default.
- Keep Hermes refinement available and enabled by default through the typed advisory boundary; `auto` remains an opt-in evidence-gated mode.
- In `auto` mode before the evidence bar is met, Hermes runs only after an explicit retry or a bounded bootstrap opportunity.
- Automatic Hermes refinement requires a minimum measured sample, acceptable failure/timeout rate, and demonstrated acceptance value. Repeated refinement for the same unchanged session state remains suppressed.
- Telemetry may record source, fixed action/outcome, latency, and counts only; suggestion text and session excerpts are forbidden.

## Snapshot finding classification

The two audit findings are legacy cognitive branch recovery snapshots, each approximately 3.82 MB and mode `0644`. Aggregate inspection found that their size came from filesystem recovery payloads which recursively captured `.pi` runtime state, including older cognitive snapshots/memory. They are not approved durable-memory exports: private runtime paths in recoverable snapshots, public file modes, recursive capture, and missing retention/cleanup make them actionable policy violations.

Phase 5 must sanitize private paths, harden files/directories, cap new state, expose only redacted metadata exports, and provide preview-first lineage-aware cleanup before the findings can be closed.

## Post-change deterministic results

`node scripts/benchmark-phase5-context.js` simulates six interactive turns with volatile scaffold IDs/timestamps, one unchanged turn, changing objectives, repeated objective/proof memories, stable constraints, and one stable router classification.

| Metric | Result |
|---|---:|
| Turns | 6 |
| Total injected characters | 3,042 |
| Mean characters per turn | 507 |
| Reduction from 6,147 baseline | **91.75%** |
| Full injections | 1 |
| Delta injections | 4 |
| Suppressed identical turns | 1 |
| Stable router advisories | 1 |

Deterministic checks passed for current-objective retention, runtime version retention, constraint/safety retention, stable router guidance, and duplicate-turn suppression. The result exceeds the >=60% ship bar.

## Prompt-suggestion policy result

The baseline's four inferred automatic Hermes attempts do not meet the current minimum 20-attempt sample and have a 50% timeout rate, above the 10% maximum. Automatic refinement therefore defaults off under `auto`; local suggestions remain immediate and manual retry remains available. Retention now requires accepted/shown >=20% as well as the general failure bar. Deterministic policy tests cover insufficient/unreliable history, an eligible measured cohort, timeout failure, forced on/off, and unrelated-event exclusion. Metadata events measure local generation and Hermes refinement/skip/failure latency and outcomes without text.

Follow-up repair (2026-07-29): default `auto` no longer deadlocks an incomplete current-schema cohort. It may launch one abortable evidence-bootstrap attempt per 15-minute interval until 20 terminal attempts exist; a complete unreliable cohort remains disabled. Strict schema-v1 prompt rows continue this prompt-only cohort, while general legacy telemetry remains excluded. The asynchronous prompt deadline now defaults to 30 seconds and is configurable up to 60 seconds; deterministic local guidance still renders first.

## Snapshot remediation result

Preview found 21 cognitive-store and 6 direct-store snapshots requiring sanitization, 199 recursively captured private paths, 99 non-private file modes, and 21 non-private directory modes. The reviewed apply completed without errors; no lineage-protected snapshots were deleted. A second preview reported zero rewrites, private paths, removals, oversized protected snapshots, or permission changes. The two largest legacy findings fell from approximately 3.82 MB each to approximately 1.11 MB each and are mode `0600`.

A fresh Pi RPC process loaded the modified Privacy Guard and scanned cognitive state (including traces/branch snapshots), goal/semantic/verification state, direct session branches, and extension telemetry. It reported `actionable: 0`, `ignored: 0`; the report is mode `0600` under a mode-`0700` directory.

## Final verification

- Focused Phase 5 tests: 14/14 passed.
- Reasoning and prompt-suggestion TUI smokes: passed.
- Fresh changed-extension RPC smokes: 3/3 passed.
- Focused `p/default` Semgrep: zero findings and zero errors.
- Fresh Privacy Guard RPC scan: zero actionable and zero ignored findings.
- `bash scripts/check-all.sh`: passed, including all tests, 47 RPC extension smokes, full-fleet model/TUI checks, project setup, Pi drift, and local Pi/Hermes regressions.

Live post-change cohort confirmation remains a Phase 7 rollout gate; this Phase 5 result is deterministic and version-bounded, not a claim about future user acceptance.
