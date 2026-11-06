# Managed-state transcript remediation plan (2026-08-10)

## Objective

Audit the 49 actionable `full-transcript-hint` findings, remove durable transcript/tool payloads without deleting diagnostic records, and verify project managed state plus global Hermes memory with complete coverage.

No matched value is rendered in this plan or in remediation manifests. Classification uses file ownership, JSON field paths, schema metadata, byte/character counts, and opaque digests only.

## Baseline scan

The project-plus-global scan covered 2,803 files and 713,547,273 bytes with zero skipped or errored files. Raw-session permission metadata was also complete and compliant: 1,539 files at `0600`, 117 directories at `0700`, and no unsafe entries. Global Hermes cache/state/log roots added no findings. All 49 actionable medium findings were project-local.

## Finding classification

| State class | Findings | Structural audit | Classification | Action |
|---|---:|---|---|---|
| Trace JSONL | 39 files | Findings originate at `role` plus `content` fields in message events. Across all 92 current trace files, 48,446 records contain raw diagnostic fields. Payloads include cumulative model partials, message content, tool inputs/results, prompts, command text, and provider request structures. | **True privacy risk.** The detector is structurally correct even where the first matching event has empty content, because the same producer persists later payload-bearing events. | Replace transcript/tool fields with deterministic metadata summaries (type, digest, byte/character/line/item counts) while preserving category, name, timing, usage, status, correlation, and file-diff hashes. Sanitize inline and compressed payloads. |
| Entropy events | 1 file | 41,934 records currently contain `text`; 811 rows match the hint directly. Stored text totals about 25.8 million characters and reaches 29,833 characters in one row. Runtime metrics do not reload event text. | **True privacy risk.** Durable raw text is unnecessary for current entropy computation. | Persist metadata summaries for text/content/tool input/output/error-like payload fields while retaining event type, timing, token count, status, metrics, and hashes. Rewrite historical events in place. |
| Cognitive `Assistant turn` memory | 1 file | 329 `pi-message` assistant-turn entries contain about 225,800 characters, up to 1,801 per entry; two currently trigger the detector. These entries are already excluded from automatic hot recall. | **True privacy risk.** They are bounded response mirrors, not durable summaries. | Store deterministic assistant-response metadata rather than response text. Rewrite historical `Assistant turn` content while retaining entry IDs, timestamps, provenance, confidence, tags, and links. Sanitize on hydration so stale state cannot return after restart. |
| Branch recovery snapshots | 2 files | Each finding is inside one of 14 snapshotted `filesystemState.files.*.content` values. All 14 paths are tracked source files; none is `.pi`/`.env`, no snapshot-level `messages` or `transcript` field exists, and the snapshots preserve 159 worktree files for rollback. | **Structural false positive, not transcript state.** Source code happens to contain role/content vocabulary. | Keep unchanged. Preserve recovery functionality and report as an audited residual if the lexical scanner still flags it. |
| Debug ledger | 5 files | Matches occur in bounded one-line hypothesis/change/observation/resolution fields of 119–516 characters in resolved bug threads. No message array or transcript payload is present. | **Bounded diagnostic false positives.** | Keep unchanged. Do not weaken the durable failed-attempt ledger. |
| Experiment ledger | 1 file | Match is a one-line 281-character gate note in a closed experiment record. No message array or transcript payload is present. | **Bounded diagnostic false positive.** | Keep unchanged. Preserve preregistered evidence and verdict history. |

A separate session-audit Markdown report matches the lexical pattern but is already ignored by scanner placeholder/report classification and is not one of the 49 actionable findings.

## Producer changes

1. Add a shared diagnostic-payload sanitizer beside the existing secret sanitizer.
2. Rename raw payload keys such as `content`, `messages`, `text`, `prompt`, `input`, `output`, `result`, `delta`, `partial`, and transcript-like fields to `*Summary` metadata objects.
3. Metadata summaries contain only type, SHA-256 digest, and bounded counts; they never contain snippets or adjacent plaintext.
4. Apply the sanitizer at trace materialization and entropy persistence boundaries.
5. Convert reasoning-runtime `Assistant turn` memory to a fixed metadata string before insertion.
6. Sanitize historical assistant-turn entries during cognitive-memory hydration as a defense against stale state.

## Historical remediation

Extend the existing preview-first remediation engine:

- trace JSONL: sanitize inline payloads and decoded `gzip+base64` payload refs, then recompress and update digest/size metadata;
- entropy JSONL: summarize raw event payload fields;
- cognitive memory JSON: summarize only `Assistant turn` entries from `pi-message` provenance;
- debug and experiment ledgers: inspect but do not mutate;
- branch snapshots: do not target or mutate.

Apply remains identity-checked and atomic. Preview/apply manifests contain paths, counts, sizes, identities, and rule totals only. Private rollback copies remain outside managed roots until post-restart verification.

## Regression and verification gates

- Generated fixtures for raw message content, tool input/result, prompts, compressed trace payloads, entropy text, and assistant-turn hydration.
- Assertions that diagnostic metadata survives and raw payloads do not.
- False-positive fixtures for source snapshots and bounded debug/experiment notes remain unchanged.
- Preview immutability, apply identity checks, idempotence, private modes, and metadata-only manifests.
- Focused tests, static/security checks, repository verification, then a complete scan with global memory enabled.
- Final report separates remediated risks from audited lexical false positives and explicitly reports backup/global/raw-session scope.

## Execution record

Preview `privacy-remediation-20260810060155-d77b7839` inspected 206 files with no malformed or unsupported records and selected 45 candidates. Apply sanitized 44 files and 91,136 records; cognitive memory was correctly blocked after the active pre-change runtime replaced its inode. The transformation reduced the scanned managed/global state footprint by more than 400 MB while preserving event counts and metadata. Decoding compressed trace refs also exposed and removed secret-like values that were not visible to the lexical file scanner.

An interim global-enabled scan reduced actionable medium findings from 49 to 13. Three residual trace findings were localized to tool-call arguments nested in model update events. After adding `args`/`arguments` to diagnostic summarization, preview `privacy-remediation-20260810061846-89af9e0a` sanitized those three files and 102 additional records.

After Pi restarted into the updated producers, preview `privacy-remediation-20260810062329-6228b033` inspected 206 files and selected 33 candidates containing 705 changed records. Applying that exact identity-checked manifest sanitized all 33 files with 1,279 diagnostic-field redactions and zero blocked files. Follow-up preview `privacy-remediation-20260810062355-852e5bbc` inspected the same scope and returned zero candidates, zero changed records, and zero blocked files.

The final project-plus-global scan covered 2,818 files and 306,389,113 bytes with zero skipped or errored files. It reported zero high findings and eight medium lexical findings, all matching the audited false-positive classes: two tracked-source recovery snapshots, five bounded resolved debug ledgers, and one bounded closed experiment ledger. No global Hermes root produced a finding. Raw-session permissions remained compliant across 1,539 files at `0600` and 117 directories at `0700`, with zero unsafe entries or scan errors.

Rollback backups remain under the private temporary remediation backup root. They may contain historical payload values and must remain access-restricted until explicitly deleted; backup deletion was not authorized as part of this remediation.
