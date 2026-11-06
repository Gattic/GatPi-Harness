# Hermes–Obsidian memory investigation — 2026-07-17

## Scope and privacy

This investigation analyzed Pi session metadata and fixed categories from `~/.pi/agent/sessions/**/*.jsonl`, inspected the configured Pi/Hermes/Obsidian implementations, and queried Hermes' local session database with fixed prompt/tool categories.

No raw Pi prompts, assistant reasoning, shell arguments, tool output, credentials, full transcripts, or secret-like values are persisted in this report. Repository-level examples are limited to this repository and version-controlled source paths. Counts may include test, smoke, headless, and temporary sessions unless a narrower cohort is stated. Evidence counts are a fixed snapshot taken before this report's own Obsidian note and Phase-0 edits, so later self-generated session/vault events are intentionally excluded.

## Executive conclusion

The current system has four separate memory-like stores, but no single authority:

1. **Pi session JSONL** is a complete conversation/event log, not curated memory.
2. **Pi cognitive memory** automatically stores objectives, assistant turns, file diffs, and verification records locally.
3. **Hermes project conversations** are queried automatically for recall, but current Pi session summaries are not automatically saved under the default configuration.
4. **Obsidian** is a useful local Markdown research store, but it is explicit/advisory and is not the source used by automatic project recall.

Hermes' own built-in global `MEMORY.md` is currently acting as an accidental cross-project store. It is 99.9% full, contains project facts from several repositories, and is injected into Hermes sessions globally. Obsidian is therefore not yet the brain; it is mostly a research archive beside the actual recall paths.

The target architecture should make **Obsidian the canonical, user-visible durable store**, use **Hermes as the curator and policy engine**, retain **Pi JSONL as raw episodic source**, and treat local caches/cognitive state as rebuildable acceleration layers.

## Evidence snapshot

### Pi session corpus

| Measure | Result |
|---|---:|
| JSONL session files | 1,429 |
| Bytes | 371,680,577 |
| JSONL rows | 78,781 |
| Malformed rows | 0 |
| Median rows per file | 5 |
| Maximum rows in one file | 9,405 |

Entry counts:

| Entry/message kind | Count |
|---|---:|
| Session headers | 1,429 |
| Messages | 72,392 |
| Custom messages | 1,886 |
| Compactions | 93 |
| Branch summaries | 1 |
| Assistant messages | 32,907 |
| Tool results | 36,805 |
| User messages | 2,680 |

This confirms that Pi sessions are healthy tree-structured event logs. They auto-save unless Pi runs with `--no-session`; deletion is separate. A session file is not evidence that durable memory was curated.

### Automatic context injection

Custom-message counts across the corpus:

| Custom type | Messages | Sessions containing it |
|---|---:|---:|
| `cognitive-automation` | 1,398 | — |
| `hermes-project-memory` | 188 | 135 |
| `obsidian-awareness` | 133 | 109 |
| `repo-context` | 107 | — |

For the last 7 days, using a substantive-session filter of at least two user/assistant turns or at least one tool call:

| Measure | Result |
|---|---:|
| Substantive sessions | 55 |
| Sessions with Hermes recall injection | 45 |
| Sessions with Obsidian awareness injection | 48 |

The missing cases are primarily temporary/runtime suites or repositories without a ready cache/project session. Stable interactive repositories show much higher coverage than the corpus-wide rate.

### Obsidian use

Observed model tool calls across Pi sessions:

| Tool | Calls |
|---|---:|
| `obsidian_search` | 33 |
| `obsidian_note` | 30 |
| `obsidian_status` | 7 |
| `obsidian_import` | 3 |
| `obsidian_hermes` | 2 |

The two `obsidian_hermes` calls both ended as errors; one was a timeout. No successful Hermes-curation event was recorded by the adapter.

Configured vault inventory:

| Measure | Result |
|---|---:|
| Markdown notes | 140 |
| Notes under `Research/` | 129 |
| Notes under `Memory/` | 2 |
| Adapter note events | 29 |
| Adapter import events | 1 |
| Adapter Hermes-curation events | 0 |

The missing Obsidian desktop binary only prevents `obsidian://` opening. Local Markdown search, read, write, import, and Hermes-backed curation do not require the desktop executable.

### Hermes project conversations

The Hermes SQLite store contains 14,935 sessions and 16,652 messages. Fixed-category inspection found:

| Hermes user-message category | Messages | Sessions |
|---|---:|---:|
| Current project recall query | 273 | 24 |
| Project-memory bootstrap | 22 | 22 |
| Current session-sync prompt | 0 | 0 |
| Current durable-note prompt | 0 | 0 |
| Obsidian-curation prompt | 0 | 0 |
| Subagent final-sync prompt | 0 | 0 |
| Topology final-sync prompt | 0 | 0 |
| Goal final-sync prompt | 13 | 12 |

Five older write-like prompts occurred inside `pi:*` project sessions on 2026-05-23 through 2026-05-25. No corresponding current-format project-session write was observed afterward. Goal final summaries did run, but under the default isolated Hermes mode rather than the canonical project-memory conversation.

Twenty Hermes sessions have a `pi:*` title. Several project keys have duplicate `#2`/`#3` sessions, consistent with concurrent first-contact bootstrap/rename races. Those project sessions made 207 Hermes tool calls, so a recall response may combine old conversation context, current Git metadata, live repository inspection, and Hermes' global built-in memory. It is not necessarily a replay of a prior Pi session summary.

### Hermes built-in memory

Hermes is configured with:

- built-in memory enabled;
- user profile enabled;
- 2,200-character `MEMORY.md` limit;
- 1,375-character `USER.md` limit;
- a memory review cadence of 10 user turns;
- no external memory provider.

Current state:

| Measure | Result |
|---|---:|
| `MEMORY.md` entries | 9 |
| `MEMORY.md` characters | 2,198 / 2,200 |
| `USER.md` | absent |
| Successful memory operations in Pi-titled Hermes sessions | 10 |
| Failed memory operations in Pi-titled Hermes sessions | 8 |

The global memory contains project facts from multiple repositories. Hermes' memory tool correctly rejects overflow, but the global 2,200-character budget is now saturated and project facts compete with each other. The tool's own policy says not to save task progress or session outcomes and to use session search for those, yet project recall calls still led to project facts being added/replaced in the global store.

## Current save behavior

### Pi session autosave

**Saved:** every normal Pi session entry: user/assistant/tool messages, model changes, custom context messages, compactions, branches, and extension entries.

**Not saved:** sessions run with `--no-session`; transient UI events that no extension appends; some failed compaction events; extension state deliberately kept outside the session.

**Purpose:** exact resumability and branching, not durable knowledge curation.

### Pi cognitive memory

Automatic local writes occur on:

- each non-command user objective;
- each assistant `message_end` (bounded to 1,800 characters, thinking filtered);
- detected file changes;
- automatic verification outcomes;
- selected reasoning/runtime cleanup and topology operations.

The current project store has 530 entries:

| Type | Count |
|---|---:|
| Episodic | 367 |
| Procedural | 162 |
| Semantic | 1 |
| Strategic | 0 |

Hot-path recall defaults to semantic, procedural, and strategic memory. It intentionally excludes episodic assistant turns and file diffs. Consequently, most stored entries are not automatically recalled, while repeated verification records can dominate the recalled procedural set.

A concrete baseline bug explains the zero strategic count: `rememberObjective()` passed the pre-insert objective list into retention pruning. The new objective was absent from the keep set and immediately removed. The layered-context store still carried the active objective, masking the cognitive-memory defect in normal prompts. The accompanying Phase-0 change fixes this by rescanning after insertion.

### Hermes project memory bridge

Automatic recall:

1. On `session_start`, derive `pi:<repo-name>:<root-hash>`.
2. Load a local Markdown recall cache if present.
3. Start a Hermes refresh in the background.
4. On `before_agent_start`, inject cached/refreshed recall once when available.
5. With the default zero wait, a first turn without cache proceeds without recall; a later turn/session can inject the refresh.
6. Light recall first tries to export the latest matching Hermes recall response; the fallback asks Hermes directly.

Durable writes:

- `/hermes-sync` manually snapshots the active branch, redacts/truncates it, and asks Hermes to store stable project context.
- `/hermes-note` manually stores a note.
- shutdown sync exists but requires `PI_HERMES_SHUTDOWN_SYNC=1`.
- default shutdown records `skipped (...; shutdown fast path)` to keep `/new`, `/resume`, `/fork`, and quit responsive.
- reload never syncs.
- subagent and topology final sync are opt-in.
- goal final sync is enabled, but the default goal Hermes mode is isolated rather than the canonical project-memory session.

Therefore `PI_HERMES_AUTO_SYNC` defaults true while the only automatic bridge hook is normally disabled by the separate shutdown-sync flag. The label is operationally misleading.

### Obsidian

Automatic behavior is limited to:

- a per-turn system-prompt reminder that Obsidian tools exist;
- one hidden local status message per Pi session.

All searches, notes, imports, and Hermes curation are explicit model/user actions. No Obsidian operation runs on the prompt hot path, and no automatic Pi/Hermes durable summary is written to the vault.

## Baseline gaps and current status

### 1. No canonical memory authority

The same project can appear in Pi JSONL, cognitive JSON, Hermes project conversations, Hermes global `MEMORY.md`, recall cache Markdown, and Obsidian notes with no authoritative ownership or reconciliation rule.

### 2. Obsidian is not in automatic recall

Automatic project recall uses Hermes conversation/cache output. It does not query the vault or read a canonical project-memory note.

### 3. Default durable save is effectively off

Normal sessions autosave raw JSONL and local cognitive artifacts, but do not update Hermes project memory or Obsidian. Manual `/hermes-sync` is the correctness path and was not observed in the current-format Hermes corpus.

### 4. Hermes global memory is cross-project and full

Project facts are being written to a tiny global file injected into every Hermes session. This risks cross-project contamination and prevents new high-value facts from being stored.

### 5. Local cognitive memory stores too much low-value episodic data

Assistant turns and file diffs are persisted automatically even though they are excluded from default hot recall. Verification artifacts are repetitive. Objective retention was broken in the audited baseline and is fixed by the accompanying Phase-0 change; the broader retention/value imbalance remains.

### 6. Save/skip decisions are not observable

There is no durable decision ledger saying `saved`, `updated`, `deduped`, `rejected-transient`, `rejected-unverified`, `rejected-sensitive`, or `deferred-review`. A skipped shutdown status can overwrite evidence of an earlier successful manual sync.

### 7. Project identity was not fully consistent — fixed in Phase 0

Most paths use root-hash project keys. The audited topology final-sync path constructed a legacy basename-only key, which could fragment memory and collide across same-named repositories. The accompanying change now uses shared `projectIdentity(cwd).projectKey`.

### 8. Failure diagnostics retained prompt content — fixed for new writes in Phase 0

The audited shared Hermes client built errors from command arguments, and the bridge logged joined arguments. Failed `--query` calls could therefore place query text—and, for a failed session sync, redacted transcript text—into local error state/logs. The observed historical log has 271 query argument records and thousands of continuation lines and was mode `0644`. The accompanying change redacts sensitive argument values across command errors and bridge logs and creates/re-permissions touched cache/state/log files as `0600`; it does not delete or migrate historical log content.

## Target architecture

### Store roles

| Store | Role | Authority |
|---|---|---|
| Pi session JSONL | Raw episodic source and resumability | Authoritative transcript, never injected wholesale |
| Pi cognitive state | Fast working memory, reasoning artifacts, verification cache | Rebuildable/local |
| Hermes | Curator, conflict resolver, summarizer, workflow engine | Not the primary storage authority |
| Obsidian | Human-readable semantic, procedural, strategic, and project memory | Canonical durable memory |
| Recall cache | Compiled bounded snapshot of canonical Obsidian memory | Rebuildable cache |
| Hermes `USER.md` | Small global user preferences only | Optional global profile cache |
| Hermes `MEMORY.md` | Global environment/tool facts only | Optional; never project progress |

### Canonical vault layout

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
      History/
  Hermes/
    Review Queue.md
    Conflict Ledger.md
```

Each project note should carry frontmatter such as:

```yaml
memory_schema: 1
project_key: pi:<repo-name>:<root-hash>
updated_at: <ISO timestamp>
content_hash: <sha256>
source_fingerprints: []
verification: mixed
```

Do not store a full local path when the project key/root hash is sufficient.

### Save policy

| Signal | Action |
|---|---|
| Explicit “remember this” project fact | Immediate canonical Obsidian upsert |
| Explicit user preference/correction | Update `Memory/User/Preferences.md`; optionally mirror a compact form to Hermes `USER.md` |
| Verified architecture decision | Upsert project Decisions with evidence/provenance |
| Verified test/build outcome that changes future workflow | Upsert Verification |
| Unresolved blocker/risk/TODO | Upsert Risks-and-TODOs with status and expiry/review date |
| Successful verified goal/topology/subagent result | Curate bounded final summary under the canonical project key |
| Assistant prose, raw tool output, routine Git status | Do not save |
| Transient failure that later recovered | Do not save; save only the reusable recovery rule if verified |
| Unverified hypothesis | Keep local/working or add to review queue, not canonical memory |
| Secret, credential, private key, full transcript | Reject and record only the rejection category |

### Recall policy

1. At session start, inject a small compiled snapshot from the canonical project `Current.md` plus global user preferences.
2. On each substantive prompt, run a bounded local vault search keyed by project key and query terms.
3. Inject only relevant, changed memory blocks; preserve source note links and verification state.
4. Refresh the compiled cache asynchronously. Never wait for Hermes or an LLM on the prompt hot path.
5. Use Hermes off-path to curate, deduplicate, resolve contradictions, expire stale items, and update the Obsidian notes.
6. Treat Hermes output as a proposal until deterministic policy and evidence checks pass.

### Consistency mechanisms

- One shared `projectIdentity()` implementation everywhere.
- One append-only memory-decision ledger with reason categories.
- Idempotent upserts by project key + memory kind + normalized content hash.
- Separate `lastAttempt*` from `lastSuccessful*` status fields.
- Persist the exact Hermes session ID and use a lock for first-contact bootstrap; do not rely only on title matching.
- Track source session fingerprint, evidence IDs, verification, confidence, expiry, and supersession.
- Keep Obsidian writes atomic and serial per target note.
- Compile caches from Obsidian; never make caches a second writable authority.

## Recommended rollout

### Phase 0 — immediate correctness/privacy hardening (completed in this change)

- [x] Fix strategic objective retention.
- [x] Redact Hermes query arguments in shared errors and bridge logs.
- [x] Create memory cache/state/log files with private permissions when written/touched.
- [x] Use the shared root-hash project identity for topology sync.
- [x] Add regression tests.

### Phase 1 — canonical Obsidian project memory

- Add a `project-memory-store` module over local Markdown.
- Define schemas, stable note paths, atomic upserts, hashes, and decision ledger.
- Add explicit `/memory-save`, `/memory-recall`, `/memory-status`, and dry-run review commands.
- Make `/hermes-sync` curate and update Obsidian rather than treating a Hermes conversation as the final authority.

### Phase 2 — incremental off-path capture

- Maintain a small per-session candidate ledger incrementally during the session.
- At `agent_settled`, classify only the delta since the last fingerprint.
- Automatically save only high-confidence, policy-allowed facts; route ambiguous items to `Memory/Hermes/Review Queue.md`.
- Keep shutdown fast: flush the already-small candidate ledger, never walk a huge branch there.

### Phase 3 — query-conditioned recall

- Compile project `Current.md` and user preferences into a local cache on change.
- Add bounded Obsidian search before broad filesystem research reads.
- Inject verified relevant blocks with note provenance and content-hash dedupe.
- Measure recall precision, stale-memory rate, save precision, and prompt latency.

### Phase 4 — Hermes curation and maintenance

- Schedule or explicitly run Hermes review for dedupe, conflicts, stale expiry, and note compaction.
- Keep automatic mutations review-gated until save precision is measured.
- Add dashboards for save/skip reasons, recall hits, stale recalls, conflicts, and review backlog.

## Success criteria

The system is ready to call Obsidian “the brain” when:

- every project has exactly one canonical project key and Obsidian memory root;
- a verified durable fact written in one session is recalled in the next without manual `/hermes-sync`;
- explicit user memory requests are saved or visibly rejected with a reason;
- transient facts and raw transcripts are not promoted;
- cross-project recall tests show zero contamination;
- recall remains non-blocking and bounded;
- all automatic save decisions have provenance and are inspectable in Obsidian;
- Hermes global memory contains only global/user facts and stays below its budget;
- Obsidian/Hermes curation has passing timeout, retry, idempotency, and concurrency tests.
