# Pi-Harness Memory-Update Health Report — Local + host-home

Generated: 2026-11-01 (evidence window 2026-07-11 → 2026-11-01)
Updated: 2026-11-02 (post-fix status appended)
Scope: recent pi-harness memory updates on this machine (local) and `host-home` (home-server)
Mode: read-only investigation for the original findings. A follow-up code fix
(commit `d7a033a`) was merged after this report; the post-fix section records its
effect. No memory data was modified.

## 1. Executive summary

| Verdict | Finding |
|---|---|
| **Healthy** | Diagnostics pipeline runs on every settle, `vaultReady: true`, privacy boundary passes, canonical project notes exist locally, Hermes advisory is actively producing succeeded events. |
| **Degraded** | Pre-fix, automatic M1 save scanned only the oldest 500 entries and produced **0 new candidates** (last real candidate 2026-10-26T11:01:38Z). That scan-window defect is now fixed (commit `d7a033a`): the settle scan reads the newest `maxScan` (2,000) entries. Candidate production is still 0 because no new durable entry exists (the sole eligible entry is already seen). Episodic memory is not draining: ~234k `transient` reasons accumulate, `lastConsolidatedAt = 0` on both hosts. |
| **Blocked** | Memory-effectiveness scorecard (2026-08-14) is `no-go-deferred`, `highestAuthorizedStage: M0`, `automaticBehaviorAuthorized: false`; M2–M5 promotion, verified upserts, review-queue writes, Hermes curation, and maintenance are gated. |
| **Divergent** | host-home has no repo-local `.pi/project-memory` data, no canonical pi-harness vault project folder, and a thinner/stale Hermes log. Its memory writes and recall are non-canonical. |

**Headline:** the local pipeline is running and honest. The candidate-scan defect is fixed: the settle scan now reads the newest entries instead of a fixed oldest-500 window. The remaining zero-candidate result reflects an absence of new durable entries, not a blind scan. Promotion remains gated by a stale scorecard. host-home is effectively a read-only, non-canonical mirror and still runs the pre-fix code.

## 1a. Post-fix status (2026-11-02)

The candidate-production defect described below was diagnosed and fixed after the original evidence window.

- **Root cause:** `CognitiveMemoryAdapter.findWhere(predicate, 500)` returned the first 500 matching entries in insertion order. `CognitiveMemory.remember` appends, so this was the *oldest* 500 non-episodic entries. The surface is dominated by 1,500 `verification-adapter` procedural records, which `FORBIDDEN_SOURCES` deliberately rejects ("typed verifier evidence; excluded from durable promotion"). Any newly appended durable entry fell outside the window and was never scanned. The single eligible entry (`mem_semantic_eb2c4930`, fingerprint `44d746aacc8863e7…`) was already seen, so the settle reported 0 candidates.
- **Fix (merged, commit `d7a033a`):** added `CognitiveMemoryAdapter.findRecent(predicate, limit)` (newest matches in stored order); the reasoning-runtime settle now uses it with `projectMemoryCandidates.maxScan`; the pipeline bounds its diagnostic scan to the newest `maxScan` (default 2,000) entries.
- **Post-fix behavior (read-only check against the real store):** the settle scans all 1,510 non-episodic entries (within the 2,000 bound), `candidateHashes: []`, `alreadySeen: 1`, `reasonCounts {verified-durable: 1, transient: 1508, policy: 1}`. Still 0 new candidates, correctly: there is no new durable entry to report.
- **Regression coverage:** head-window miss vs newest-window detection (501 non-promotable + 1 appended durable), the `maxScan` bound, adapter ordering/limits, and an extension wiring guard. Lint and typecheck pass.
- **Not yet applied on host-home:** host-home remains at `f078133`, which predates `d7a033a`, so its settle scan still uses the old head window.
- **Running session:** the currently running session loaded the pre-fix extension code at startup, so its settle rows still show `scanned: 500` until a fresh session loads `d7a033a`.
- **No memory data changed:** the fix is code-only. `candidate-state.json` remains at `2026-10-26T11:01:38Z` with one seen fingerprint.

## 1b. Correctness follow-up (2026-11-02)

A read-only M1 audit found five issues; the code fixes are in the `fix/m1-memory-correctness` branch. No canonical memory, diagnostic history, scorecard, or host-home data was modified; the rebuildable compiled cache was regenerated from unchanged canonical notes.

1. **Capture attempts are now observable.** Field transcripts showed 1,383 sessions and zero `capture` calls, and rejected attempts left no trace. Every attempt now appends one bounded metadata-only `kind: capture-attempt` row (outcome, reason, source, candidate kind, quote/content hashes) to `.pi/project-memory/diagnostics.jsonl`; `status`/`map` report `captureAttempts` by outcome and reason. No quote, title, or content body is persisted.
2. **Diagnostic settlement no longer consumes promotion fingerprints.** `candidate-state.json` now keeps `diagnosticSeenFingerprints` separate from `seenFingerprints`, so a diagnostic-only settle reports a durable candidate once without preventing a later M3 candidate-capture stage from promoting it. This removes the latent M3 starvation bug; it does not authorize M3.
3. **`cognitiveConsolidation` is enforced.** `memory_curator operation=consolidate` with `apply:true` now returns `cognitive-consolidation-not-authorized-at-rollout-stage` unless the rollout is enabled and `PI_PROJECT_MEMORY_COGNITIVE_CONSOLIDATION=1`. Preview remains read-only. The unused `shadowDecisions` status flag was removed; `candidateCapture` remains the M3 authority.
4. **Fallback-vault divergence is fail-closed.** Automatic capture now requires a confirmed canonical vault (`explicit`, `configured`, or `discovered-single`). A `default-managed` fallback is refused as `canonical-vault-unconfirmed` until an explicit save provisions the project folder. This directly addresses the local/host-home split where the same project key resolved to `~/Obsidian/Pi Research` on host-home and `~/Documents/Obsidian Vault` locally. The host-home code upgrade and vault-root reconciliation remain separate operator actions; host-home still runs `f078133`.
5. **State inconsistencies were reconciled or documented.** `.pi/project-memory/compiled-cache.json` was rebuilt from the canonical notes (`ProjectMemoryAdapter.compile({apply:true})`): it is now schema 2 with 14 items, and cache-only recall reports `cacheSourceMatch: true`. Canonical notes were unchanged. `lastConsolidatedAt: 0` remains intentional while consolidation is not authorized; episodic growth is bounded by the configured caps (4,051/5,000 at audit time). The 17 unresolved diagnostic-review rows remain metadata-only and were not resolved without review intent.

Verification for the follow-up: focused candidate, automatic-capture, runtime, posture, readiness, diagnostics, and integration-boundary tests, plus `npm run check:static`. Field effectiveness remains unproven; the scorecard remains stale, so M2–M5 stay blocked.

## 2. Posture and configuration

`config/memory-posture.json` is identical on both hosts:

```json
{ "stage": "M1", "writes": true, "automatic": true, "autoSave": true,
  "recordedAt": "2026-10-25",
  "rationale": "Operator-authorized selective source-bound capture and task-conditioned recall.
    M2-M5 evidence promotion, verified upserts, review-queue writes, Hermes curation,
    and maintenance remain blocked by the stale memory-effectiveness scorecard." }
```

The rationale is accurate but self-reinforcing: the stale scorecard blocks the very maintenance that would let evidence qualify for a refreshed scorecard.

## 3. Local evidence (this machine)

### 3.1 Project-memory diagnostics (pre-fix evidence, 2026-11-01)
Source: `.pi/project-memory/diagnostics.jsonl`

- **497 rows**, all `kind: settle`, `stage: M1`, `automaticSave: true`, `diagnosticOnly: true`.
- Window: `2026-10-09T09:52:14Z` → `2026-11-01T18:55:18Z`.
- `vaultReady: true` in all 480 rows that record it.
- **`candidateHashes` is empty in every recent settle.** 415 of 497 rows ever carried a hash, but only one distinct fingerprint exists: `sha256:44d746aacc8863e7…`.
- Last non-empty candidate: `2026-10-26T11:01:38Z`. Last actual write: `candidate-state.json` updated `2026-10-26T11:01:38Z` with `newCandidates: 1`.
- Latest pre-fix settle (2026-11-01T18:55:18Z): `scanned: 500`, `truncated: false`, `candidateHashes: []`, `alreadySeen: 1`, `reasonCounts {verified-durable: 1, transient: 498, policy: 1}`.
- Cumulative reason totals: **transient 234,079**, verified-durable 480, policy 467.
- Scan window was pinned at 500 (466 of 497 settles), so the candidate surface was a fixed-size *head* (oldest entries), not the full memory. This is the defect fixed by `d7a033a`; post-fix diagnostics report up to the newest `maxScan` (2,000) entries once a fresh session loads the fix. The current running session still reports the pre-fix window.

### 3.2 Candidate pipeline
- `candidate-state.json` holds exactly one seen fingerprint (`44d746aacc8863e7…`), no `pendingExplicit`, no `pendingCorrections`.
- That fingerprint appears in repo-local diagnostics and smoke/worktree diagnostics directories, but **not in the Obsidian vault** — provenance is repo-local only.
- `state.json`: `reviewBacklog: 0`, last decision `memdec_a4bb0cbb4d4a47a5` (`superseded`, `explicit-save`) at `2026-10-26T13:07:56Z`.
- `decisions.jsonl`: 23 decisions.

### 3.3 Maintenance and retention backlog
From `memory_explorer maintenancePreview` / `retentionPreview` (preview only, nothing applied):

- Retention candidates: **487**
- Duplicates: **12**
- Rejected: **1**
- Candidate count previewed: **500** of **5,978** total.
- Manifest `retention_c52daebb61ad2280`; coverage partial across trace/entropy/snapshot/verification/run/reasoning/subagents/planning/evidence/toolchain classes.
- `memory_curator reviewQueue` preview: candidate `null` — nothing staged for review.

### 3.4 Vault
- Canonical vault: `~/Documents/Obsidian Vault`.
- Project folder `Memory/Projects/pi-harness-cebc5fcaa033/` contains **7 notes**: `Current.md` (335 B), `Constraints.md`, `Decisions.md`, `History.md`, `Procedures.md`, `Risks-and-TODOs.md`, `Verification.md` — all updated 2026-10-23/26.
- `History.md` records one entry (`mem_032940a4f751eda7`, `verification: unverified`, updated 2026-08-05) about Pi VPN fetch failures. It is stale relative to current diagnostics.
- `Research/Projects/pi-harness-cebc5fcaa033/Project.md` (2,927 B, "Second-brain pilot") is a navigation note; it explicitly says it "does not own task state."

### 3.5 Hermes advisory
Source: `.pi/hermes-advisory/events.jsonl` (673,676 B), `readiness.json` (42,540 B)

- **1,739 events**: succeeded 890, eligible 750, cancelled 45, failed 28, timed-out 22, blocked 4.
- Latest event: `2026-11-01T18:55:38Z` — actively producing.
- Readiness policy `hermes-readiness-v4`; identity `fcd7101b9fcd9b4e…`, eligible, executable found, auth proof succeeded.

### 3.6 Cognitive hygiene
Source: `.pi/cognitive-automation/`

- `cognitive-memory.json`: **5,417 entries** (snapshot at 2026-11-01; episodic entries grow with each turn) — episodic 3,907, procedural 1,501, strategic 8, semantic 1. Verification: inferred 3,522, corroborated 1,681, verified 214.
- **`lastConsolidatedAt: 0`** — consolidation has never run.
- `entropy/stats.json`: `count: 129,587` events; latest snapshot entropyScore ≈ 0.18, stabilityScore ≈ 0.86.
- `maintenance/stale-reasoning-cleanup.json` (2026-10-27): ran with **no removals** (`contextRemoved: []`, `memoryRemoved: []`).

### 3.7 Memory-effectiveness scorecard
Source: `.pi/memory-effectiveness/scorecard.json`, generated `2026-08-14T14:09:16Z`

- `decision: "no-go-deferred"`, `highestAuthorizedStage: "M0"`, `automaticBehaviorAuthorized: false`.
- Evidence class: `synthetic-readiness` only. `reviewedGoldQualified: false`, `realCurationQualified: false`, `exactVersionFieldQualified: false`; expected reviewed cases 12, present 0.
- Retrieval scores pass numerically (precision@5 1.0, recall@5 1.0) but are `gateEligible: false` because they rest on synthetic fixtures.
- Privacy boundary and cross-project contamination pass on deterministic evidence.

### 3.8 Sessions and tool adoption
Source: `~/.pi/agent/sessions/--home-user-pi-harness--/`

- **1,379 sessions**; 42 modified in the last 14 days.
- Memory-tool calls: `memory_explorer` 128, `memory_curator` 165 (293 total).
- Canonical-memory injections present in **24** sessions.
- 0 memory-tool errors observed.

### 3.9 Host hygiene
- `/tmp`: 1% inodes used (1,042,138 free), 7.4 GB free. The previously reported ENOSPC **is not currently reproducing**.
- `/`: 54% used, 440 GB available.

## 4. host-home evidence (home-server)

### 4.1 Repo and posture
- `~/pi-harness` at `f07813318d59dbb7345595b44b92bfe1eaea01cf` (2026-10-31), **clean tree**.
- `config/memory-posture.json` identical to local (M1).

### 4.2 Project-memory
- Repo-local `~/pi-harness/.pi/project-memory/` is **empty** — no `state.json`, no decisions, no diagnostics.
- Global `~/.pi/project-memory/diagnostics.jsonl`: **12 rows**, `2026-10-14T17:23:49Z` → `2026-10-29T07:33:22Z`.
- Latest settle (2026-10-29T07:33:22Z): `scanned: 9`, `candidateHashes: []`, `alreadySeen: 1`, `reasonCounts {verified-durable: 1, transient: 8}`, `vaultReady: true`.
- 11 of 12 rows ever carried a hash; no candidates produced in the latest cycle.

### 4.3 Vault
- Vault root: `~/Obsidian/Pi Research`.
- **No `Memory/Projects/pi-harness-*` folder.** `Memory/Projects/` holds only `glades-ml-agent-guidance.md` and `glades-trainer-agent-guidance.md`.
- `Memory/Hermes/` has two CHIRON notes (2026-07-25).
- `Research/pi-harness/` has two 2026-07-11 notes (Ralph-style automation loop, cross-agent session mining).
- Net: host-home cannot resolve the canonical project key → writes/recall are non-canonical.

### 4.4 Hermes advisory
- Repo-local `.pi/hermes-advisory/` has **no files**.
- Global `~/.pi/hermes-advisory/events.jsonl` (12,325 B): **32 events** — succeeded 16, eligible 11, cancelled 4, failed 1; latest `2026-10-27T09:50:26Z`.
- `readiness.json` policy `hermes-readiness-v4`, identity `bb2cf9187dada5d3…`, eligible, auth proof succeeded 2026-10-27.
- Coverage is ~2% of local volume and 5 days stale.
- `~/dev/.pi/hermes-advisory/events.jsonl` (4,269 B, 2026-10-11) is a separate stale checkout.

### 4.5 Cognitive hygiene
- `cognitive-memory.json`: **325 entries** — episodic 184, procedural 138, strategic 2, semantic 1. Verification: inferred 141, corroborated 142, verified 42.
- `lastConsolidatedAt: 0` — consolidation never run.
- Entropy files frozen at 2026-07-23 (stats count 20; events 2.2 MB, snapshots 3.5 MB).
- `maintenance/stale-reasoning-cleanup.json` (2026-10-27) ran with no removals.
- `memory-effectiveness/` **absent** (only a test fixture exists in the repo).

### 4.6 Sessions and tool adoption
- 526 sessions in `--home-user-pi-harness--`; 616 total.
- **0 memory-tool calls**, **0 canonical-memory injections**, 0 sessions modified in the last 14 days.

## 5. Local vs host-home comparison

| Signal | Local | host-home | Assessment |
|---|---|---|---|
| Repo commit | `d7a033a` (fix merged) | `f078133` (pre-fix) | **divergent** |
| Posture | M1, autoSave on | M1, autoSave on | aligned |
| Project-memory data | 497 settles, 23 decisions | empty repo-local; 12 global settles | **divergent** |
| Candidate production | scan fixed; 0 new durable entries | 0; head-window bug remains | **local fixed, host-home stale** |
| Vault canonical folder | 7 notes present | **missing** | **divergent** |
| `vaultReady` | true | true | aligned (but host-home path is wrong) |
| Hermes events | 1,739, latest today | 32, latest 2026-10-27 | **thin/stale** |
| Cognitive entries | 5,417 | 325 | divergent volume |
| Consolidation | never (`0`) | never (`0`) | **both broken** |
| Scorecard | present, `no-go-deferred` | absent | **host-home ungated/unknown** |
| Memory-tool calls | 293 | 0 | **adoption gap** |
| Canonical injections | 24 sessions | 0 | **adoption gap** |

## 6. Findings, ranked

1. **Candidate production was stalled by a head-limited scan (fixed).** M1 autoSave used `findWhere(..., 500)`, which returned the *oldest* 500 non-episodic entries. Those are dominated by 1,500 `verification-adapter` records that are intentionally non-promotable, so newly appended durable entries were never scanned. Commit `d7a033a` switches the settle scan to `findRecent` with `maxScan` (2,000). The remaining 0-candidate result is correct: the sole eligible entry is already seen and no new durable entry exists. **Status: fixed.**
2. **Episodic memory never consolidates (critical).** `lastConsolidatedAt = 0` on both hosts; 234k transient classifications accumulate. No retention/consolidation loop drains episodic entries.
3. **Promotion is blocked by a stale scorecard (high).** Scorecard from 2026-08-14 is `no-go-deferred` at M0 with synthetic-only evidence. M2–M5, verified upserts, review-queue writes, Hermes curation, and maintenance are all gated.
4. **Maintenance backlog is large and unaddressed (high).** 487 retention candidates, 12 duplicates, 1 rejected; only 500 of 5,978 previewed. Review queue is empty.
5. **host-home is non-canonical (high).** Empty repo-local project-memory, missing vault project folder, no scorecard. Writes/recall cannot resolve the project key.
6. **host-home Hermes is thin and stale (medium).** 32 events vs 1,739; latest 2026-10-27; repo-local dir empty.
7. **Memory-tool adoption is low (medium).** 293 calls across 1,379 local sessions; 24 injection sessions; host-home 0/0.
8. **Vault history is stale (low).** `History.md` last updated 2026-08-05 with one unverified VPN finding.
9. **`/tmp` ENOSPC is not currently reproducing (resolved/observe).** 1% inodes, 7.4 GB free.
10. **Entropy telemetry diverges (low).** Local 129,587 events vs host-home frozen at 20 since 2026-07-23.

## 7. Recommended next actions

**Do first (unblocks the pipeline):**
1. ~~Diagnose why transient classification swallows everything.~~ **Done.** The classifier is correct: `verification-adapter` (and `anchoring-adapter`, `pi-message`, `pi-input`) are intentionally non-promotable. The defect was the oldest-first scan window, fixed by `d7a033a`. Remaining action: confirm a new durable entry is detected on the next settle after a fresh session loads the fix; no further classifier change is needed.
2. **Run a bounded consolidation/retention pass** for episodic entries (preview first; the 487/12/1 backlog is the natural starting set). Set `lastConsolidatedAt` and a retention cap.
3. **Refresh the memory-effectiveness scorecard** using real (non-synthetic) reviewed cases so `highestAuthorizedStage` can move past M0. Without this, M2–M5 stay gated indefinitely.

**Then:**
4. **Reconcile host-home paths:** create the canonical vault project folder (or point host-home at the correct vault) and initialize repo-local `.pi/project-memory` so writes/recall resolve.
5. **Refresh host-home Hermes:** repo-local `.pi/hermes-advisory` is empty; decide whether host-home should use global events or be provisioned locally. Address the 2026-10-27 staleness.
6. **Close the maintenance backlog** in bounded batches (487 retention → 12 duplicates → 1 rejected), recording each batch as evidence.
7. **Improve adoption:** memory tools are used in ~21% of recent local sessions and 0% on host-home. Confirm the tools are surfaced and that host-home sessions can reach them.
8. **Refresh `History.md`** with current findings, or mark the VPN entry superseded.
9. **Re-check `/tmp`** on the next heavy run; the earlier exhaustion is not reproducing but was not root-caused.

**Do not:**
- Do not promote to M2–M5 before the scorecard is refreshed with real evidence.
- Do not apply retention/consolidation without a preview and explicit authorization.
- Do not copy local vault notes into host-home automatically; reconcile the vault root first.

## 8. Evidence sources and limits

- Local: `.pi/project-memory/{diagnostics.jsonl,candidate-state.json,state.json,decisions.jsonl,compiled-cache.json}`, `.pi/hermes-advisory/*`, `.pi/cognitive-automation/*`, `.pi/memory-effectiveness/*`, `config/memory-posture.json`, `~/.pi/agent/sessions/--home-user-pi-harness--/*`, Obsidian vault project folder.
- host-home: same paths under `~/pi-harness` and `~/.pi`, plus `~/Obsidian/Pi Research`.
- Read-only: all maintenance, retention, review-queue, and curator operations were previews only; nothing was applied.
- Limits: pre-fix diagnostics covered the oldest 500 entries; post-fix diagnostics cover the newest `maxScan` (2,000). Retention preview covered 500 of 5,978 candidates; host-home counts reflect whatever is reachable over SSH at collection time. Session tool-call counts are lexical regex matches over JSONL, not semantic traces.
- No credential values, prompt/output bodies, or private reasoning were captured.
