# Session memory and Obsidian corrective execution plan

**Date:** 2026-08-09
**Status:** Implementation complete; external evidence gates remain open
**Authority:** Corrective follow-up to the 2026-08-09 read-only audit; the broader 2026-07-27 remediation architecture remains authoritative where this plan does not replace a contract.
**Roadmap:** `roadmap_318b16151c54`

## 1. Objective

Make the session-backed memory system truthful, safely operable, and measurably useful without promoting rollout beyond its evidence:

1. preserve Pi JSONL as private resumable episodic evidence;
2. make every read, preview, telemetry write, candidate write, and canonical write accurately described and independently gated;
3. make Privacy Guard cover every memory-adjacent runtime root and report unavailable roots explicitly;
4. fail closed when canonical Obsidian project notes have invalid identity, hashes, schema, or entry metadata;
5. rank Obsidian search results by relevance instead of alphabetical any-term truncation;
6. keep cognitive hot recall free of verifier/file-anchor/assistant-turn noise and prevent new exact duplicates;
7. expose session-storage pressure without rewriting, deleting, or externalizing resumable content;
8. distinguish synthetic fixtures from user-reviewed gold and exact-version field evidence;
9. prepare the existing preregistered field cohort without fabricating temporal or human-review results.

## 2. Claim boundary

This plan can complete implementation and deterministic verification now. It cannot complete these external gates in one coding session:

- local human resolution of every redacted high-severity privacy candidate;
- at least 20 eligible real fixture-vault curation attempts;
- at least 30 exact-version uses across at least 10 independent sessions and 14 observed days;
- reviewed control/candidate outcome labels for the C5 comparison.

Those remain `insufficient-data` or `NULL-RESULT`. No code, fixture, or backfill may convert them into a pass. Requested/effective rollout remains M0 unless independently current evidence authorizes a higher stage.

## 3. Frozen contracts

### 3.1 Mutation classes

| Class | Examples | Default behavior |
|---|---|---|
| Pure read | status, recall, search, map, conflicts | no filesystem write |
| Pure preview | maintenance, retention, permissions, session hygiene | return a stable manifest; no filesystem write |
| Declared telemetry | Fix Recall retrieval attribution | explicitly documented metadata-only append; opt-out supported |
| Candidate/decision write | memory review queue, learning memory-summary candidate | explicit write flag plus operation-specific authorization |
| Canonical mutation | project-memory save/supersede, reviewed curation | rollout control plus explicit apply |
| Destructive mutation | retention/permission apply, deletion | manifest match plus explicit apply; never implied by preview |

A session-wide intent bit must not silently authorize unrelated mutation classes. M0 must not write project-memory decisions, review candidates, canonical notes, or rollout state.

### 3.2 Canonical note integrity

A managed note is recallable only when all of these hold:

- `memory_schema: 1`;
- exact root-hash `project_key`;
- frontmatter `memory_kind` matches its managed file;
- frontmatter `content_hash` matches the parsed body;
- every writable entry has a deterministic ID, candidate hash, title hash, valid verification state, and safe content;
- malformed markers or hash mismatches are reported and yield zero recall items.

There is no legacy fallback for malformed managed notes.

### 3.3 Evidence classes

Synthetic fixtures may establish deterministic behavior and performance only. They must not be labeled `user-reviewed-gold`. Precision/recall/save promotion bars remain insufficient until reviewed gold results are supplied. Exact-version field gates require the preregistered cohort identity and remain temporal.

## 4. Execution phases

### Phase A — Mutation and rollout correctness

**Targets**

- `.pi/extensions/memory-explorer/index.ts`
- `.pi/extensions/learning-loop-coordinator/index.ts`
- `.pi/extensions/runtime-doctor/index.ts`
- `.pi/extensions/fix-recall/index.ts`
- `src/learning-loop.js`
- `src/session-hygiene.js`
- `src/fix-recall.js`

**Work**

1. Split Memory Curator read operations from mutating operations and authorize per operation.
2. Block review/decision recording when the corresponding M0/M3/M4 control is disabled.
3. Make learning memory summaries preview-only unless `write:true` is explicit.
4. Make Runtime Doctor session hygiene a non-writing preview; reserve preview persistence for an explicitly named write/apply workflow.
5. Document Fix Recall as a metadata-telemetry mutation and add an explicit no-record option without weakening later attribution.
6. Add regression tests proving preview/read operations leave state byte-identical.

**Exit gate**

Focused extension and lifecycle tests show zero unexpected files or ledger rows from read/preview operations; explicitly requested telemetry remains bounded and private.

### Phase B — Privacy coverage and canonical integrity

**Targets**

- `.pi/extensions/privacy-guard/index.ts`
- `src/state-inventory.js`
- `src/project-memory-store.js`
- `src/project-memory-recall.js`
- `src/project-memory-schema.js`

**Work**

1. Add traces, learning, debug, project-memory, maintenance, evidence, Fix Recall, run, and experiment state to default privacy scope.
2. Treat those roots as runtime state for transcript-hint classification.
3. Report configured, available, and absent roots; do not hide metadata-root errors behind a generic incomplete flag.
4. Validate canonical frontmatter/body/entry integrity before list, recall, compile, or upsert.
5. Fail closed with bounded issue codes and no note body in reports.

**Exit gate**

Fixed fixtures prove full default-root coverage, truthful absent-root accounting, large-file scanning, valid-note recall, and rejection of wrong project keys, kinds, hashes, IDs, malformed markers, and unsafe entries.

### Phase C — Retrieval, cognitive value, and storage pressure

**Targets**

- `src/obsidian-adapter.js`
- `src/cognitive-memory.js`
- `.pi/extensions/reasoning-runtime/index.ts`
- `src/session-hygiene.js`
- `src/session-storage-attribution.js`

**Work**

1. Rank Obsidian results by title/path phrase, content phrase, all-term match, term coverage, and deterministic tie-breakers.
2. Prefer all-term snippets and expose bounded score factors.
3. Preserve existing hot-path provenance exclusions and insertion-time exact dedupe; add regressions so verifier, anchor, and assistant-turn records cannot re-enter automatic hot recall.
4. Add metadata-only session pressure metrics: large-file counts/bytes, largest-file share, concentration, and pressure status.
5. Keep raw-session rewrite, deletion, compression, and blob externalization unsupported until exact resume/export/restore compatibility is separately proven.

**Exit gate**

The prior memory audit ranks above generic vault hubs; hot recall excludes forbidden provenance; exact duplicates dedupe on insertion; session preview reports pressure without changing session bytes.

### Phase D — Evidence and field boundaries

**Targets**

- `src/memory-effectiveness.js`
- `src/project-memory-runtime.js`
- `tests/fixtures/memory-effectiveness/manifest.json`
- `docs/memory-effectiveness-scorecard.json`
- `docs/extension-portfolio/fix-recall.md`
- `docs/project-memory-operations.md`

**Work**

1. Derive retrieval/save evidence classes from manifest provenance.
2. Make synthetic precision/recall/save metrics informative but insufficient for reviewed-gold gates.
3. Derive `highestAuthorizedStage` from passed stage prerequisites rather than the absence of a failure.
4. Refresh public scorecard and Fix Recall documentation without claiming field efficacy.
5. Document exact-version cohort capture for `exp-memory-learning-compounding-efficacy-field`; no automatic launch, routing, promotion, or mutation is authorized.

**Exit gate**

Synthetic fixtures no longer appear as reviewed gold; scorecard remains `no-go-deferred`; runtime remains M0 with stale/missing evidence; open experiment gates remain unchanged unless new preregistered evidence actually exists.

### Phase E — Verification

1. Run focused tests for every changed subsystem.
2. Run extension load/TUI or RPC smokes for changed tools.
3. Run changed-code Semgrep plus affected-test analysis.
4. Run the full repository verifier.
5. Run Privacy Guard over the expanded default scope and report redacted candidates only.
6. Inspect final diff and Git evidence.

## 5. Stop conditions

Stop and preserve evidence if any change:

- writes a canonical note or decision during M0 read/preview behavior;
- rewrites, deletes, archives, compresses, or re-permissions raw sessions;
- copies a candidate secret, prompt, transcript, reasoning body, command, or tool output into tests/docs/reports;
- labels synthetic evidence as reviewed gold or exact-version field evidence;
- promotes rollout, starts automatic saving, or changes experiment gates without qualifying evidence;
- accepts a canonical note whose identity or hashes do not validate;
- makes a privacy scan look complete while configured existing roots are omitted.

## 6. Completion definition

Immediate execution is complete when Phases A–E pass on the final tree and the repository remains at evidence-authorized M0. The overall memory program remains temporally open until the preregistered human/privacy/curation/field bars settle. That open gate is an evidence boundary, not an implementation failure and not permission to synthesize a pass.
