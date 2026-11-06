# Session memory, Obsidian, and recall effectiveness remediation plan

**Date:** 2026-07-27
**Status:** Implemented through deterministic and fixture gates; release remains `no-go-deferred` on human privacy review and temporal/independent field bars
**Scope:** Pi session evidence, Privacy Guard, Memory Explorer/Curator, cognitive memory, Hermes project memory, Obsidian research memory, Fix Recall, retention, telemetry, migration, and rollout
**Canonical roadmap:** `roadmap_6f51d3bd1bad`

## Implementation result (2026-07-27)

The shared inventory/stream scanner, truthful Privacy Guard, typed Memory Explorer/Curator, canonical Obsidian project-memory schema/store/decision ledger, ranked cache-backed recall, explicit/shadow save pipeline, cognitive store separation, Fix Recall field scoring, fixture-vault Hermes curation, preview-first migration/retention/permission workflows, rollout controls, benchmarks, and aggregate scorecard are implemented.

The program is not authorized for reviewed automatic release. The current scorecard is `docs/memory-effectiveness-scorecard.json` and intentionally reports `no-go-deferred`: 102 baseline high-severity candidates still require local human review, real fixture-vault reliability has fewer than 20 eligible attempts, and the exact-version field cohort has not reached 30 independent sessions over 14 days. No temporal or human-review gate is treated as completed by deterministic tests.

Operational procedures are in `docs/project-memory-operations.md`.

## 1. Purpose and authority

This is a new standalone plan based on the 2026-07-27 read-only investigation of `~/.pi/agent/sessions/`, current project runtime state, Hermes caches/state, the managed Obsidian vault, cognitive-memory contents, management-tool behavior, and existing release evidence.

It does not extend or renumber the earlier plans. For the scope above, this document is the new planning authority. The following remain historical evidence and useful design input, but they are not current execution plans:

- `docs/hermes-obsidian-memory-investigation-2026-07-17.md`;
- `docs/pi-extension-effectiveness-accuracy-plan-2026-07-26.md`;
- the memory/Obsidian sections of `docs/extension-reliability-remediation-plan.md`.

This plan does not reopen unrelated completed extension, role-runtime, or Roadmap work. It preserves the integration-boundary contract: Pi core and extensions consume cognitive and project-memory capabilities through `src/integration-boundary.js` adapters rather than scattered internal imports.

## 2. Objective

Build a memory system that is demonstrably correct and useful:

1. **Pi sessions** remain the private, authoritative resumable event source.
2. **Obsidian** becomes the canonical human-readable durable project-memory store.
3. **Hermes** becomes an off-path curator, conflict resolver, and summarizer rather than an opaque storage authority.
4. **Cognitive memory** becomes bounded working memory, not a duplicate transcript/verifier warehouse.
5. **Recall** becomes task-conditioned, project-scoped, ranked, provenance-bearing, fresh, and non-blocking.
6. **Saving** becomes explicit or policy-governed, observable, idempotent, and reviewable.
7. **Management and privacy tools** report complete scope and honest truncation instead of silently omitting state.
8. **Effectiveness claims** require reviewed gold tasks and a sufficient exact-version field cohort.

## 3. Evidence baseline

The active investigation session was identified and excluded from aggregate content metrics. The store was changing while the investigation ran, so byte totals are snapshot values rather than immutable constants.

### 3.1 Raw Pi sessions

| Measure | Current evidence |
|---|---:|
| Session JSONL files | 1,503 |
| Total bytes | approximately 826.7 MB |
| Parsed rows excluding active session | 146,579 |
| Malformed rows | 0 |
| Heuristically interactive sessions | 174 |
| Test/smoke sessions | 1,328 |
| File modes | 1,503/1,503 at `0600` |
| Directory modes | 115/115 at `0700` |
| Files over 1 MiB | 109 |
| Files over 10 MiB | 15 |
| Largest observed file | approximately 91.6 MB |

The session-permission migration is effective. Structural integrity is high. Storage growth is not controlled: the corpus grew by roughly 455 MB between the July 17 and July 27 snapshots.

Approximate persisted-byte contributors, excluding the active session:

- tool-result messages: 588 MB;
- `read` tool results: 280 MB;
- persisted images: 186 MB;
- assistant thinking parts: 131 MB;
- `bash` tool results: 64 MB.

Raw sessions are therefore strong forensic evidence but poor direct memory. They must never be injected wholesale or treated as curated knowledge.

### 3.2 Automatic context and recall

Lifetime/current observed interactive coverage:

| Injection | Lifetime | Recent seven-day cohort |
|---|---:|---:|
| Hermes project recall | 158/174 (90.8%) | 31/32 (96.9%) |
| Cognitive context | 167/174 (96.0%) | 32/32 (100%) |
| Obsidian awareness | 92/174 (52.9%) | 32/32 (100%) |

Hermes trace evidence contains 42 completed live recalls, 5 failed recalls, 39 cache hits, a 34.1-second mean live completion, and a 55.1-second p95. The non-blocking cache design is useful, but live refresh is too slow for prompt-path authority.

The current Hermes recall was accurate for checked current Git facts and module paths. It nevertheless omitted the directly relevant July 17 memory investigation even though the same objective text occurred in seven sessions over ten days. The response was generic session-start context rather than task-conditioned recall.

### 3.3 Hermes storage state

- 20 recall-cache files and 24 project-state files exist; all are `0600` under `0700` directories.
- Canonical root-hash keys coexist with legacy basename-only keys for several projects.
- The current Pi Harness state reports `lastRecallStatus: ok` and current HEAD, but `lastSyncStatus: skipped (quit; shutdown fast path)`.
- Default `PI_HERMES_AUTO_SYNC` does not produce normal durable shutdown writes unless the independent `PI_HERMES_SHUTDOWN_SYNC=1` flag is enabled.
- A live recall marked `durable-memory/fresh` proves response generation mode and current Git capture, not item-level durable provenance or factual verification.

### 3.4 Obsidian state

| Measure | Current evidence |
|---|---:|
| Markdown notes | 141 |
| Vault bytes | approximately 2.47 MB |
| Notes under `Research/` | 129 |
| Notes under `Memory/` | 3 |
| Notes under `Memory/Projects/` | 0 |
| Newest note timestamp | 2026-07-17 |

Observed model-tool behavior:

- `obsidian_search`: 50 calls/results, zero error envelopes;
- `obsidian_note`: 31 calls, 30 results, zero explicit error envelopes;
- `obsidian_import`: 3/3 results;
- `obsidian_hermes`: 2/2 errors;
- actual successful vault-body Hermes curation events: 0.

Local Markdown is ready. Obsidian desktop/open support is unavailable. Prior bounded auth and synthetic curation probes passed, but they included zero vault files and wrote no note; current curation proof has expired and the adapter correctly fails closed.

The ExampleGame durable note retained useful architecture paths, but its branch and HEAD were stale. General Obsidian search uses unranked any-term matching and result-order truncation, which produced poor precision for a multi-term current-project query.

### 3.5 Cognitive memory and runtime state

Current cognitive memory contains 3,450 entries:

- 1,942 episodic;
- 1,499 procedural;
- 8 strategic;
- 1 semantic.

The default hot-memory set contains 1,508 entries, of which 1,499 are procedural. It has average confidence 0.144, 1,294 inferred entries, 183 exact duplicate-content entries, zero active links, and no active contradiction relationships. Of 1,498 verification-adapter entries, 1,327 were never accessed. Of 1,680 anchoring-adapter entries, 1,513 were never accessed.

Project cognitive state is approximately 131 MB across 1,776 files. Session Stabilizer reports large cognitive and trace state and `stable: false`. The recent injection rewrite is promising: the 18 observed post-freeze cognitive injections averaged 950 characters with p95 2,035, compared with the historical 6.1-6.7K baseline. This sample is too small for rollout authority.

### 3.6 Management and privacy-tool defects

- Memory Explorer reported 1,000 cognitive files and 6.59 MB while exact metadata showed 1,776 files and 130.97 MB. It silently omitted 44% of files and about 95% of bytes.
- Memory Curator classified 887/1,000 inspected files as promotion candidates, including trace, entropy, snapshot, verification, and failed-run state, because classification is based on broad whole-file keywords.
- Privacy Guard caps each root at 800 files, ignores files at or above 2 MB, and does not expose those omissions as scan truncation.
- An explicit session-root content scan reported `contentReadFromRawSessions: false` even though the supplied root was read as generic state.
- Privacy Guard reported 26 high session candidates; a complete same-pattern, value-redacted pass found 98 non-placeholder candidates across 77 files, including 69 findings in files the adapter never opens because of size. These are unresolved candidates, not confirmed credentials.
- A complete same-pattern check found four unresolved candidates in large cognitive/trace files skipped by the normal scan.

### 3.7 Fix Recall and learning evidence

Fix Recall currently reports eight retrievals, ten attributed later attempts, six useful fixed/partial attempts, zero linked no-change/worse attempts, and a 10% unlinked bad-attempt rate. This is promising conditional evidence, not recall-coverage evidence.

An almost exact query for a known resolved Hermes timeout thread returned no result because the exact title score was diluted to 0.2195 by the long combined attempt history, just below the 0.22 threshold. A known E2BIG incident in docs/sessions was also outside the indexed sources.

## 4. Confirmed root causes

| Failure | Root cause |
|---|---|
| Privacy scans overclaim completeness | Fixed file-count and file-size exclusions are not represented in result coverage/truncation |
| Raw-session scan scope is mislabeled | Generic explicit roots and dedicated raw-session posture are modeled as unrelated code paths |
| Memory maps severely undercount state | Content-reading traversal caps and size filters are reused for metadata inventory |
| Curator over-promotes runtime files | Whole-file keyword classification ignores typed record role and storage authority |
| Obsidian is stale and sparse | Writes/import/curation are explicit; no canonical project-memory save pipeline updates the vault |
| Hermes recall is generic | Recall starts at session start before a substantive task query is known |
| Hermes provenance is ambiguous | Current Git, conversation history, global memory, live inspection, and cache output are merged into one response label |
| Durable saving is normally absent | Shutdown sync is independently disabled; no incremental settled-turn candidate pipeline exists |
| Cognitive hot memory is verifier-heavy | Verification outcomes are persisted as procedural memory, while automatic consolidation is off |
| Cognitive state grows despite pruning | Trace/entropy/snapshot/proof stores have independent retention and historical private-mode drift |
| Fix Recall misses exact incidents | One normalized score over a large combined haystack dilutes title/resolution matches; coverage misses are not measured |
| Existing readiness evidence is misread as effectiveness | Synthetic zero-file probes prove connectivity and response shape, not useful real curation |

## 5. Target architecture

### 5.1 Store authority

| Store | Role | Authority |
|---|---|---|
| Pi session JSONL | Exact resumable episodic source | Authoritative transcript/event source; never direct prompt memory |
| Typed artifact/evidence stores | Verifier, file-change, trace, branch, and recovery records | Authoritative for their own typed evidence only |
| Cognitive working memory | Current objective, bounded episodes, selected reusable rules | Rebuildable project-local acceleration layer |
| Obsidian project memory | Human-readable semantic, procedural, strategic, decisions, risks, and verified workflow memory | Canonical durable project-memory authority |
| Compiled recall cache | Bounded deterministic projection of canonical notes | Rebuildable, read-only cache |
| Hermes | Off-path curation, conflict proposals, compaction, and review assistance | Advisory processor; not primary authority |
| Hermes global memory | User/global environment preferences only | Never project progress or project-specific decisions |

### 5.2 Canonical vault layout

```text
Memory/
  User/
    Preferences.md
  Global/
    Environment.md
    Tooling.md
  Projects/
    <repo-name>-<root-hash>/
      Current.md
      Decisions.md
      Constraints.md
      Risks-and-TODOs.md
      Verification.md
      Procedures.md
      History/
  Hermes/
    Review Queue.md
    Conflict Ledger.md
```

A project-memory note must carry bounded machine-readable frontmatter:

```yaml
memory_schema: 1
project_key: pi:<repo-name>:<root-hash>
memory_kind: current|decision|constraint|risk|verification|procedure|history
updated_at: <ISO-8601>
content_hash: <sha256>
verification: verified|corroborated|inferred|unverified|contradicted
source_fingerprints: []
evidence_ids: []
expires_at: null
supersedes: []
```

Full local paths, prompts, transcript bodies, reasoning, commands, tool outputs, credentials, and secret-like values are forbidden. Root-hash project identity replaces full paths in durable metadata.

### 5.3 Save-decision ledger

Every candidate produces exactly one append-only metadata decision:

```json
{
  "schemaVersion": 1,
  "decisionId": "memdec_*",
  "projectKey": "pi:<repo>:<hash>",
  "kind": "decision",
  "action": "saved|updated|deduped|review-queued|rejected|superseded",
  "reason": "verified-durable|duplicate|transient|unverified|sensitive|stale|policy",
  "candidateHash": "sha256:*",
  "sourceFingerprints": [],
  "evidenceIds": [],
  "verification": "verified",
  "at": "<ISO-8601>"
}
```

The ledger stores no candidate body. `lastAttempt*`, `lastSuccessful*`, and canonical note revision fields remain separate.

### 5.4 Recall evidence

Each recalled item carries its own source and freshness:

- `current-git` — generated from the current repository at recall time;
- `canonical-vault` — exact note path/hash/revision;
- `compiled-cache` — cache hash plus canonical source hash match;
- `hermes-curation` — advisory proposal with source note hashes;
- `live-inspection` — current external inspection, never mislabeled durable memory;
- `legacy-conversation` — historical Hermes conversation pending migration/review.

A response-level “fresh” label is insufficient. Stale branch/HEAD values may appear only as explicitly historical facts; current Git state must always come from `current-git`.

## 6. Non-negotiable boundaries

1. No raw session, prompt, assistant answer, private reasoning, command, tool argument/output, credential, or large log is written to durable memory, telemetry, fixtures, or public reports.
2. No scan may report complete/untruncated unless every discovered item is accounted for as scanned, skipped with reason, errored, or explicitly out of scope.
3. No automatic durable mutation is enabled from deterministic or synthetic evidence alone.
4. Obsidian/Hermes output remains advisory until deterministic policy, evidence, schema, and conflict checks pass.
5. Current Git facts are never sourced from stale durable notes.
6. Project identity uses one shared root-hash implementation everywhere.
7. Extensions consume the new store/index/decision services through `src/integration-boundary.js`.
8. Prompt-path recall is local and bounded; Hermes/provider calls never block the first substantive model turn.
9. Raw-session deletion, rewriting, recompression, or archival is never automatic.
10. Existing user-managed Obsidian notes are not rewritten or re-permissioned without explicit preview/apply approval.
11. Historical and exact-version evidence remain separate.
12. Missing, stale, mismatched, or insufficient evidence fails closed.

## 7. Fixed success bars

### 7.1 Audit and inventory truth

- 100% identity: `discovered = scanned + skipped + errored`, with no unclassified files.
- File-count and byte totals match an independent metadata walk exactly on fixed 10/800/1,000/1,500/5,000-file fixtures.
- Size-limited, count-limited, deadline-limited, and permission-denied scans report explicit reason counts and `complete: false`.
- Explicit raw-session content scans report `contentReadFromRawSessions: true`; permission-only scans report false and never open bodies.
- Zero hidden file-size exclusions.

### 7.2 Privacy and confinement

- Zero confirmed credentials, full transcripts, or private reasoning in canonical notes, caches, ledgers, telemetry, or fixtures.
- Zero unresolved high-severity candidates before release; unresolved values are reviewed locally without being copied into reports.
- Managed project-memory, cognitive, trace, learning, verification, Hermes cache/state/log, and decision-ledger files use `0600`; managed directories use `0700`.
- User-managed vault-wide permission changes remain opt-in; every adapter-created managed memory note is `0600`.

### 7.3 Save quality

- 100% of explicit “remember/save this” requests produce a visible saved, review-queued, or rejected result with a fixed reason.
- Explicit-save precision at least 95% on a reviewed gold set; automatic-save precision at least 98% before any reviewed automatic stage.
- Zero automatic saves of transient Git state, routine success prose, recovered failures, unverified hypotheses, secrets, or transcript excerpts.
- 100% idempotency by project key + kind + normalized content hash.
- Shutdown-path p95 overhead below 50 ms; provider curation remains off-path.

### 7.4 Recall quality

- Precision@5 at least 0.90 and Recall@5 at least 0.90 on a reviewed repeated-task/project-memory cohort.
- The directly relevant prior investigation appears in the top three for the repeated memory-audit task.
- Zero cross-project contamination in fixed same-name and different-root fixtures.
- Current-fact stale rate 0%; general durable-item stale rate at most 2%, always visibly labeled.
- Local ranked recall p95 below 50 ms on a 10,000-note fixture.
- Total first cognitive/project-memory injection p95 at most 2,500 characters; unchanged follow-up injection is zero; changed follow-up injection is delta-only.

### 7.5 Hermes/Obsidian curation

- Real non-sensitive fixture-vault curation includes at least one source note and writes the expected schema-valid note in apply mode.
- Dry run includes source hashes but writes no note.
- Idempotent rerun produces no duplicate note/section.
- Curation success at least 90%, timeout at most 10%, and p95 at most 120 seconds over at least 20 eligible real fixture-vault attempts before advisory promotion.
- Conflicting source notes produce a review-queue/conflict result, never silent overwrite.

### 7.6 Cognitive and storage quality

- Routine verifier results and file-change anchors do not enter default hot memory.
- Every hot-memory item has typed provenance, verification, and freshness/expiry semantics.
- Exact duplicate hot-memory content below 1%.
- Objective retention remains bounded to the latest eight unique objectives and survives restart.
- Migration reduces current cognitive/trace/snapshot bytes by at least 50% without deleting lineage-protected evidence or raw sessions.
- Thirty-day steady-state project cognitive state remains below 64 MB unless an explicit retained-evidence manifest explains the excess.

### 7.7 Fix Recall

- Exact or near-exact title/resolution queries return the known thread at rank 1.
- Recall@5 at least 0.90 on a reviewed resolved-thread cohort.
- Zero-match and missed-known-thread rates are measured, not omitted from effectiveness.
- At least 30 attributed attempts before making comparative bad-attempt claims.

### 7.8 Field authority

- All deterministic, migration, privacy, and restart gates pass.
- At least 30 independent exact-version interactive sessions over at least 14 observed days for recall/save reliability.
- At least 30 observed days before low-volume retirement or reviewed automatic-save promotion.
- User correction, stale recall, and privacy rates do not regress.

## 8. Execution topology and dependencies

```text
Phase 0 evidence/contracts
  -> Phase 1 audit truth
  -> Phase 2 canonical store
       -> Phase 3 saving pipeline
       -> Phase 4 recall pipeline
  -> Phase 5 cognitive/retention governance
  -> Phase 6 end-to-end effectiveness
  -> Phase 7 migration and rollout
```

Phase 1 can start after Phase 0 without waiting for canonical-memory implementation. Phase 5 characterization can run in parallel with Phase 2 after the schemas and authority boundaries are frozen. Phase 6 requires Phases 1-5 integrated. Phase 7 requires every earlier deterministic gate.

## 9. Phase 0 — Freeze evidence and truth contracts

**Priority:** P0
**Owners:** memory architecture, privacy, and observability maintainers
**Depends on:** none

### Goals

1. Publish current baselines with exact claim boundaries.
2. Define fixed metrics and acceptance bars.
3. Create privacy-safe gold cohorts and active-session exclusion evidence.

### Primary files

- this plan;
- a new private ignored baseline under `.pi/memory-effectiveness/`;
- public aggregate report/schema generator under `src/` and `scripts/`;
- `scripts/audit-pi-sessions.py` only where shared session classification/exclusion is required;
- new reviewed aggregate fixtures under `tests/fixtures/memory-effectiveness/`.

### Tasks

- [ ] Freeze source/config/schema/classifier identifiers and current aggregate counts.
- [ ] Record exact active-session requested/matched/excluded/unmatched counts.
- [ ] Define evidence classes: lifetime, deterministic, migration, exact-version field, synthetic readiness, real fixture-vault curation, and user-reviewed gold.
- [ ] Create hashed gold manifests for repeated-task recall, stale/current facts, same-name cross-project isolation, save/reject policy, conflict handling, and Fix Recall.
- [ ] Preserve labels and expected note/thread identifiers without storing prompts, transcript excerpts, secret-like values, or local paths.
- [ ] Publish one machine-readable scorecard schema with `pass`, `fail`, `blocked`, and `insufficient-data`.

### Exit gate

A reproducible baseline and gold-manifest report contains all sample sizes, hashes, source/config versions, privacy boundaries, and fixed bars. It grants no automatic behavior authority.

### Rollback

None required; Phase 0 adds evidence/contracts only. Private baseline artifacts can be regenerated from raw sources.

## 10. Phase 1 — Make audits complete and truthful

**Priority:** P0
**Owners:** privacy and memory-management maintainers
**Depends on:** Phase 0

### Primary files

- `.pi/extensions/privacy-guard/index.ts`;
- `.pi/extensions/memory-explorer/index.ts`;
- `src/session-hygiene.js`;
- new shared metadata inventory/stream scanner through `src/integration-boundary.js`;
- Privacy Guard, Memory Explorer/Curator, extension-load, and large-corpus tests.

### Workstream 1A — Shared inventory and scan accounting

- [ ] Separate metadata inventory from content scanning.
- [ ] Walk all metadata regardless of file size; make count/deadline limits explicit.
- [ ] Stream content in bounded chunks/lines instead of dropping large files.
- [ ] Return discovered/scanned/skipped/errored files and bytes, reason counts, deadlines, and completeness.
- [ ] Add deterministic traversal ordering and root identity without exposing paths publicly.

### Workstream 1B — Privacy Guard

- [ ] Separate `rawSessionPermissionAudit` from explicit `rawSessionContentAudit`.
- [ ] Correct `contentReadFromRawSessions` and global/project/explicit-root labels.
- [ ] Remove the silent 800-file and 2 MB authority gap.
- [ ] Keep findings value-redacted and path-hashed.
- [ ] Add local review handles that can re-open the exact candidate without storing its value.
- [ ] Review the 98 session and four cognitive/trace candidates using the new non-persisting local workflow.

### Workstream 1C — Memory Explorer/Curator

- [ ] Make map totals exact and include explicit omitted-content statistics.
- [ ] Search typed records and canonical notes with ranking; retain exact-string mode separately.
- [ ] Make lineage traverse IDs/relationships rather than call text search.
- [ ] Replace marker-based conflict output with typed conflict/supersession/verification state.
- [ ] Exclude trace, entropy, snapshots, raw proof packets, and run records from durable promotion.
- [ ] Classify individual candidate records, never entire multi-record files.
- [ ] Keep every mutation preview-first, checkpointed, and explicitly authorized.

### Exit gate

Fixed and live metadata inventories match independent filesystem counts/bytes exactly. Every incomplete scan says so. Curator reviewed-fixture precision is at least 0.90 and no forbidden runtime-file class is promoted.

### Rollback

Keep the old tools available only behind a compatibility flag and label every compatibility result `legacy-incomplete`; never silently fall back.

## 11. Phase 2 — Establish canonical durable memory

**Priority:** P0
**Owners:** memory architecture and Obsidian maintainers
**Depends on:** Phase 0; integrates after Phase 1 shared inventory contracts

### Primary files

- new `src/project-memory-store.js`;
- new `src/project-memory-schema.js`;
- new `src/project-memory-decisions.js`;
- shared `src/project-identity.js` or the existing canonical identity facade;
- `src/integration-boundary.js`;
- `src/obsidian-adapter.js`;
- `.pi/extensions/obsidian/index.ts`;
- schema, no-follow write, atomicity, concurrency, and identity tests.

### Tasks

- [ ] Implement the canonical vault layout and frontmatter schema.
- [ ] Resolve all project identities through one root-hash service.
- [ ] Implement no-follow atomic writes, serial per-note queues, content-hash compare, and idempotent section upserts.
- [ ] Add bounded typed read/list/query APIs through the integration boundary.
- [ ] Implement metadata-only save-decision and conflict ledgers.
- [ ] Define source fingerprint, evidence, verification, expiry, supersession, and contradiction transitions.
- [ ] Ensure `Current.md` is a projection, not an independently editable second authority.
- [ ] Create a migration manifest for legacy basename Hermes keys, canonical caches, existing `Memory/Hermes` notes, and project durable notes.
- [ ] Never automatically rewrite unrelated Research notes.

### Exit gate

Store tests prove schema validation, project isolation, atomicity under interruption, no symlink escape, idempotency, deterministic hashes, conflict preservation, and exact integration-boundary use.

### Rollback

The store starts read-only. Writes are enabled only for explicit operations after a passing migration preview. Disabling the store leaves original notes/caches untouched.

## 12. Phase 3 — Build a precise saving pipeline

**Priority:** P1
**Owners:** memory policy, reasoning-runtime, Hermes, and Obsidian maintainers
**Depends on:** Phase 2

### Primary files

- project-memory store/policy modules;
- `.pi/extensions/reasoning-runtime/index.ts`;
- `extensions/hermes-memory/index.ts`;
- `.pi/extensions/memory-explorer/index.ts` for explicit governed mutation;
- `.pi/extensions/obsidian/index.ts`;
- save-policy, candidate-ledger, settled-turn, restart, and shutdown tests.

### Tasks

- [ ] Add explicit save/reject/review/status operations to the existing governed `memory_curator` surface rather than adding another default model tool.
- [ ] Add clear command/UI surfaces for explicit save, recall status, review queue, and last successful durable revision.
- [ ] Capture bounded candidate metadata incrementally from explicit user requests, verified decisions, unresolved durable risks, and reusable verified procedures.
- [ ] Do not rescan the full session branch at shutdown.
- [ ] At `agent_settled`, classify only the delta since the last candidate fingerprint.
- [ ] Reject transient Git state, routine prose, recovered failures, raw tool output, and unverified hypotheses.
- [ ] Route ambiguous items to the review queue with no automatic canonical write.
- [ ] Keep automatic write mode shadow-only until Phase 6/7 field bars pass.
- [ ] Separate `lastAttempt*`, `lastSuccessful*`, canonical note revision, and review backlog state.
- [ ] Rename or correct `AUTO_SYNC` semantics so status agrees with actual durable behavior.

### Exit gate

Gold save-policy fixtures meet explicit and automatic precision bars, every decision is observable, shutdown overhead passes, restarts preserve candidate/decision state, and no forbidden content reaches notes or ledgers.

### Rollback

Independent controls disable candidate capture, classification, review-queue writes, and canonical writes. Explicit local note operations remain available. No rollback deletes notes; supersession restores prior revisions by hash.

## 13. Phase 4 — Build task-conditioned recall

**Priority:** P1
**Owners:** retrieval, Obsidian, Hermes, and Fix Recall maintainers
**Depends on:** Phase 2; save-derived tests also use Phase 3

### Primary files

- new `src/project-memory-index.js`;
- new `src/project-memory-recall.js`;
- `src/obsidian-adapter.js`;
- `src/reasoning-injection.js`;
- `.pi/extensions/reasoning-runtime/index.ts`;
- `extensions/hermes-memory/index.ts`;
- `src/hermes-recall-evidence.js`;
- `src/fix-recall.js`;
- retrieval benchmarks and integration tests.

### Workstream 4A — Local project-memory recall

- [ ] Build a deterministic project-scoped index over canonical notes.
- [ ] Rank phrase, all-term, field, tag, memory-kind, recency, verification, and source matches; do not use unranked OR traversal.
- [ ] Run local recall only after the substantive prompt is known.
- [ ] Inject top relevant changed blocks with note/hash/verification/freshness provenance.
- [ ] Compile `Current.md` and stable user/global memory into a bounded startup cache.
- [ ] Preserve a no-provider, no-vault-body hot path.

### Workstream 4B — Hermes provenance and curation

- [ ] Replace one response-level source label with per-item source evidence.
- [ ] Label live Git and live repository inspection separately from durable memory.
- [ ] Use Hermes only off-path for review, conflict proposals, compaction, and note-draft generation.
- [ ] Require current readiness proof for provider work without requiring it for local recall.
- [ ] Persist source note hashes and the exact Hermes session ID under a lock.

### Workstream 4C — Fix Recall

- [ ] Score title, resolution, symptom, change, and observation fields separately and use calibrated field weights/maxima.
- [ ] Add exact-title and exact-resolution fast paths.
- [ ] Index reviewed session-derived incident summaries/docs through privacy-safe stable signatures, not raw error text.
- [ ] Measure zero-match known-thread misses and retrieval coverage.
- [ ] Keep recalled fixes advisory and require the later attempt verdict linkage.

### Exit gate

The repeated-task prior audit ranks top three; reviewed Recall@5/Precision@5 and latency bars pass; cross-project contamination is zero; current/stale labels are exact; Fix Recall meets its gold cohort.

### Rollback

Disable prompt-conditioned injection independently while retaining explicit local search. Fall back to a same-revision compiled canonical cache, not opaque legacy conversation output.

## 14. Phase 5 — Govern cognitive state, raw-session growth, and retention

**Priority:** P1
**Owners:** reasoning-runtime, runtime, privacy, and evidence maintainers
**Depends on:** Phase 0; final migration semantics depend on Phase 2

### Primary files

- `.pi/extensions/reasoning-runtime/index.ts`;
- `src/cognitive-memory.js`;
- `src/reasoning-injection.js`;
- typed artifact/evidence adapters through `src/integration-boundary.js`;
- `src/session-hygiene.js`;
- Runtime Doctor/Session Stabilizer;
- retention, migration, permission, and no-loss tests.

### Workstream 5A — Store separation

- [ ] Stop inserting routine automatic verifier outcomes into general procedural hot memory.
- [ ] Keep file-change diffs in typed anchoring/artifact storage, not durable recall memory.
- [ ] Keep assistant turns episodic, bounded, and excluded from hot recall by default.
- [ ] Promote only verified reusable procedures/invariants with source evidence.
- [ ] Preserve the latest eight unique objectives and current layered objective.

### Workstream 5B — Consolidation and retention

- [ ] Run bounded dedupe/expiry/consolidation off the prompt hot path.
- [ ] Deduplicate by normalized content hash before insertion.
- [ ] Retain latest-per-fingerprint automated verifier evidence plus explicitly protected failures.
- [ ] Bound trace, entropy, snapshot, branch, and generated proof retention independently.
- [ ] Snapshot before cleanup; preserve lineage-protected and debug-referenced evidence.

### Workstream 5C — Raw-session storage

- [ ] Add exact aggregate storage attribution and growth-rate reporting without payload persistence.
- [ ] Characterize whether images and repeated tool results can use content-addressed external blobs without weakening exact resume/export semantics; do not implement until compatibility is proven.
- [ ] Extend manifest-first archive preview for closed test/smoke and one-shot sessions.
- [ ] Keep interactive/raw-session rewrite, compression, archival, or deletion explicit-only.
- [ ] Preserve content hashes and restore tests for every archive proposal.

### Workstream 5D — Historical confinement

- [ ] Preview and harden historical cognitive, verification, learning, debug, trace, and managed vault-memory modes.
- [ ] Do not chmod the entire user-managed vault automatically.
- [ ] Make all new state private at creation.

### Exit gate

Hot memory contains no routine verifier/file-change noise, objective/reusable-rule recall remains correct, duplicate and size bars pass, no protected evidence is lost, raw sessions remain byte-identical, and all managed state permissions comply.

### Rollback

Keep pre-migration snapshots and manifests. Restore cognitive/runtime state by exact checkpoint. Never roll back by loosening file modes or rewriting raw sessions.

## 15. Phase 6 — Prove end-to-end effectiveness

**Priority:** P0 release gate
**Owners:** independent verifier, memory/retrieval evaluator, and privacy reviewer
**Depends on:** Phases 1-5

### Primary evidence

- unit and property tests;
- extension RPC/load tests;
- restart and concurrency integration tests;
- reviewed retrieval/save gold cohorts;
- fixture-vault curation runs;
- private migration dry runs;
- exact-version field telemetry;
- Privacy Guard plus an independent complete inventory cross-check;
- `scripts/check-all.sh`, Semgrep, and `gitverify`.

### Test matrix

1. **Audit completeness:** 10/800/1,000/1,500/5,000 files; 0-byte, 1.9 MB, 2 MB, 100 MB; unreadable; symlink; deadline; active-file exclusion.
2. **Project isolation:** same basename/different root; moved worktree; detached branch; non-Git directory; legacy key collision.
3. **Save policy:** explicit preference, verified decision, reusable procedure, transient Git status, recovered failure, hypothesis, secret-like input, duplicate, supersession.
4. **Recall:** repeated prior audit, exact decision, stale branch/HEAD, conflicting note, current Git override, empty cache, stale cache, no Hermes, no desktop.
5. **Curation:** real fixture note bodies, dry run, apply, idempotent rerun, timeout, retry, auth expiry, provider mismatch, conflict, concurrent requests.
6. **Cognitive retention:** restart, duplicate insertion, objective rollover, verified rule promotion, automated verifier churn, protected failure, cleanup rollback.
7. **Fix Recall:** exact title, paraphrase, verbose thread, short thread, doc-derived stable incident, no match, cross-project false match.
8. **Privacy:** all large state files, raw sessions, generated caches, ledgers, notes, traces, reports, exports, and migration artifacts.
9. **Performance:** local recall p50/p95/p99, prompt injection characters, session-start/settled/shutdown overhead, index rebuild time, Hermes off-path latency.

### Required independent review

- Privacy reviewer confirms scan coverage and locally resolves every high candidate without copying values.
- Retrieval reviewer approves gold labels and failure analysis.
- Memory reviewer inspects save decisions and canonical notes for precision/staleness.
- Verifier confirms deterministic bars and exact-version cohort boundaries.

### Exit gate

Every fixed bar is `pass` or the program remains blocked. Synthetic readiness cannot satisfy real curation or user-value gates. Lifetime usage cannot satisfy current-version reliability.

### Rollback

Verification mutates only dedicated fixtures/private evidence. Any live pilot uses disposable fixture notes or review-queued proposals until rollout authorization.

## 16. Phase 7 — Migrate and roll out safely

**Priority:** P0 release/operations gate
**Owners:** integrator, release verifier, and memory maintainer
**Depends on:** Phase 6

### Migration order

1. Freeze source/config and stop automatic memory writes.
2. Export metadata-only manifests and hash every migration input.
3. Preview legacy Hermes key/cache/state reconciliation.
4. Preview existing durable-note mapping into canonical project roots.
5. Preview cognitive/artifact retention and permission hardening.
6. Apply one independently reversible migration class at a time.
7. Re-index canonical notes and compare compiled caches.
8. Run restart, recall, curation, privacy, and rollback checks.
9. Start a new exact-version field cohort.

### Rollout stages

| Stage | Behavior | Authority |
|---|---|---|
| M0 | Legacy behavior; new store read-only | deterministic characterization only |
| M1 | Explicit canonical save/recall/status | user-confirmed writes only |
| M2 | Task-conditioned local recall | read-only automatic injection |
| M3 | Candidate capture and shadow save decisions | no canonical automatic writes |
| M4 | Review-queue proposals and reviewed Hermes curation | human approval required |
| M5 | Narrow verified-fact automatic upsert | requires all field bars and independent approval |

Automatic preference writes, destructive cleanup, cross-project memory, and hidden provider curation are not authorized by M5.

### Independent controls

Provide separate rollback controls for:

- canonical store reads;
- explicit writes;
- task-conditioned injection;
- candidate capture;
- shadow decisions;
- review-queue writes;
- Hermes curation;
- automatic verified-fact upserts;
- cognitive consolidation;
- retention cleanup.

### Release gate

Ship only when:

- deterministic, migration, privacy, restart, and rollback checks pass;
- no unresolved high privacy candidates remain;
- exact-version recall/save cohort meets sample and temporal bars;
- real fixture-vault curation meets reliability and idempotency bars;
- no cross-project contamination or current-fact staleness occurs;
- local recall and context budgets pass;
- the final scorecard, docs, state schema, and operational runbooks agree.

Otherwise the decision is `no-go-deferred`, with the highest passing stage retained.

## 17. Deliverables

### Source and adapters

- canonical project-memory store/schema/decision/index/recall modules;
- integration-boundary adapters;
- truthful shared inventory/stream scanner;
- repaired Privacy Guard and Memory Explorer/Curator;
- task-conditioned recall and per-item evidence;
- bounded save candidate pipeline;
- cognitive/artifact store separation and retention;
- calibrated Fix Recall retrieval.

### Tests and benchmarks

- complete scan/accounting fixtures;
- project-memory schema/atomicity/concurrency tests;
- save/reject and recall gold cohorts;
- fixture-vault curation E2E tests;
- restart/migration/rollback tests;
- cognitive retention/no-loss tests;
- privacy and permission tests;
- field scorecard generator.

### Documentation and operations

- canonical memory architecture and schema;
- explicit save/recall/review workflows;
- Obsidian/Hermes readiness versus effectiveness boundaries;
- migration preview/apply/rollback runbook;
- privacy-candidate local review runbook;
- raw-session retention/archive policy;
- synchronized scorecard and lifecycle decision.

## 18. Conflict zones and implementation ownership

The following files are shared integration zones and should have one parent integrator at a time:

- `src/integration-boundary.js`;
- `.pi/extensions/reasoning-runtime/index.ts`;
- `src/reasoning-injection.js`;
- `src/obsidian-adapter.js`;
- `extensions/hermes-memory/index.ts`;
- `.pi/extensions/memory-explorer/index.ts`;
- `.pi/extensions/privacy-guard/index.ts`;
- `src/session-hygiene.js`;
- public memory/runtime documentation and scorecards.

Independent work may proceed in parallel for scanner fixtures, canonical-store schema tests, retrieval gold labeling, retention characterization, and curation fixture design, provided those workers remain read-only until contracts are frozen.

## 19. Stop conditions

Stop implementation and preserve evidence if any of the following occurs:

- a migration changes raw-session or canonical-note content outside its reviewed manifest;
- a scan reports complete while independent inventory disagrees;
- a secret-like value is copied into a report, fixture, log, or model prompt;
- current Git facts are presented from stale durable memory;
- cross-project memory appears;
- Hermes/provider work blocks the first substantive turn;
- automatic saving begins without the required field cohort;
- cleanup removes lineage-protected/debug-referenced evidence;
- rollback cannot restore the exact pre-stage state;
- source/config drift invalidates the cohort.

## 20. Final completion definition

This program is complete only when a verified durable fact saved in one session is recalled in a later relevant session without manual Hermes sync; irrelevant and stale facts are suppressed; Obsidian visibly contains the authoritative source-linked memory; every save/skip/conflict decision is inspectable; audits account for every file and byte; cognitive/runtime state remains bounded; raw sessions remain private and resumable; and all claims are supported by a sufficient exact-version field cohort.
