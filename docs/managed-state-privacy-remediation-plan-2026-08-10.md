# Managed-state privacy remediation plan (2026-08-10)

## Objective

Remove the five high-severity privacy findings from durable managed state without deleting useful records or disabling diagnostics. Prevent recurrence at producer write boundaries, then sanitize affected historical artifacts with a preview-first, identity-checked rewrite.

## Audit boundary

- No matched value is rendered in this document, logs, manifests, or test output.
- Findings are correlated by opaque file identity, JSON field path, detector class, value digest, and exact-match presence in tracked fixtures.
- A detector match in tracked fixture text is not evidence of a live credential. Once copied into runtime state, however, it remains disallowed durable payload and must be redacted.
- Trace provider fields such as `thinkingSignature` are private replay payload even when a credential-shaped substring is a detector false positive.

## Classification of the five findings

| Finding | Durable location and field | Classification | Write path | Decision |
|---|---|---|---|---|
| `project-state:a6c5c3908c27`, `api-key-assignment` | `.pi/cognitive-automation/cognitive-memory.json`, two `Assistant turn` entry `content` fields | Historical sensitive payload; exact fixture-derived token, not a confirmed live credential | reasoning-runtime `message_end` -> `CognitiveMemoryAdapter.remember` -> `CognitiveMemory.persist` | Redact secret-shaped text at memory ingestion and sanitize both historical entries. |
| `project-state:1e1ad6229a38`, `openai-key` | `.pi/cognitive-automation/entropy/events.jsonl`, event `text` | Historical sensitive payload; exact fixture-derived token, not a confirmed live credential | reasoning-runtime `message_end` and other observations -> `EntropyMonitor.observe` -> `EntropyPersistenceAdapter.recordEvent` | Sanitize entropy events and snapshots at persistence, then rewrite all affected historical rows. |
| `project-state:1e1ad6229a38`, `api-key-assignment` | `.pi/cognitive-automation/entropy/events.jsonl`, event/tool/progress `text` | Historical sensitive payload; first reported value is fixture-derived, not a confirmed live credential | same entropy persistence path | Same producer and historical remediation. Also redact every other matching value in the file, including one unmatched to tracked source that remains unconfirmed rather than inspected in plaintext. |
| `project-state:0837a12b679d`, `openai-key` | `.pi/traces/2d9e28c906e33a3b.jsonl`, `payload.assistantMessageEvent.partial.content[0].thinkingSignature` in repeated model update events | Credential-detector false positive, but historical sensitive provider payload | trace-observability `message_update` -> `TraceRuntime.emit` -> `FileTraceStorage.materialize` | Treat sensitive field names as private independent of lexical detector results; replace their values while preserving event metadata. |
| `project-state:6a9ee2bfe502`, `api-key-assignment` | `.pi/debug-ledger/phase-9-integrated-verification-reasoning.json`, `attempts[0].observation` | Historical sensitive payload; exact fixture-derived token, not a confirmed live credential | `recordAttempt` -> `writeThread` | Sanitize all debug-ledger free text at the write boundary and rewrite the historical field. |

**Audit verdict:** none of the five findings is confirmed to contain a live credential. Four are fixture/source snippets copied into durable free text. The trace match is not an OpenAI credential, but is provider-originated private metadata and therefore still violates the managed-state payload boundary.

## Design

### 1. Shared sanitizer

Add one dependency-free module under `src/` that:

- redacts private-key blocks, OpenAI-style keys, GitHub-style tokens, and credential assignments in strings;
- recursively sanitizes arrays and plain objects;
- always redacts values under explicitly sensitive field names such as authorization credentials, API keys, passwords, `thinkingSignature`, and encrypted reasoning payload fields;
- preserves object shape, non-sensitive text, timestamps, counters, IDs, and trace metadata;
- returns bounded metadata counts by rule, never original or replacement-adjacent payload text.

Redaction markers must not themselves match the privacy scanner.

### 2. Producer boundaries

Apply the shared sanitizer before durable writes in:

- `CognitiveMemory` entry construction, including structured metadata;
- `EntropyPersistenceAdapter` and standalone entropy `MetricsPersistence` event/snapshot writes;
- debug-ledger `writeThread`;
- `FileTraceStorage.materialize`, before inline or compressed payload storage.

The in-memory analytical behavior remains available. Only credential-shaped substrings and explicitly private fields are removed.

### 3. Historical remediation

Add a dedicated remediation module/script with these properties:

- default operation is preview only;
- candidates are the cognitive-memory JSON document, entropy JSONL rows, debug-ledger JSON documents, and project trace JSONL files;
- JSON/JSONL record structure is preserved;
- compressed `gzip+base64` trace payload refs are decoded, sanitized, recompressed, and have their digest/byte metadata recomputed;
- previews report paths, byte counts, changed record counts, and redaction-rule counts only;
- apply validates the previewed file identity before an atomic private-mode replacement;
- no root or record is deleted;
- the apply manifest is metadata-only and private.

The first apply targets only artifacts reported as changed by preview. Rollback is by the pre-apply private backup directory produced by the script; backups are retained until verification completes, then reported as a residual sensitive-state risk requiring explicit deletion authorization.

## Regression coverage

Add focused tests for:

1. each lexical secret class and an ordinary non-secret string;
2. sensitive trace fields that are credential-detector false positives;
3. cognitive-memory persistence preserving entry utility while redacting content/metadata;
4. entropy adapter and standalone entropy persistence;
5. debug-ledger write/read/format behavior after redaction;
6. inline and compressed trace payload sanitation;
7. historical remediation preview immutability, apply identity checks, structure preservation, private permissions, metadata-only manifests, and idempotence.

Tests must use generated fixture strings and must not log them.

## Verification gates

1. Run focused sanitizer, memory, entropy/integration-boundary, debug-ledger, trace, remediation, and extension-load tests.
2. Run language/compiler diagnostics for changed JavaScript and TypeScript integration points.
3. Run focused Semgrep/CodeGraph analysis when available; optional-provider degradation is advisory.
4. Run the managed-state privacy scan and require all five original high findings to disappear with complete scan coverage.
5. Run repository-defined changed/full verification and inspect the final diff.
6. Confirm the pre-existing three evidence-collection changes remain intact and logically separate.

## Rollback and risk controls

- Source rollback: revert only privacy-remediation files; do not touch the three pre-existing modified files.
- State rollback: restore exact private backups only if sanitation damages JSON/JSONL structure or diagnostics.
- Symlinks, non-regular files, identity changes between preview and apply, malformed JSON, and unsupported compressed payloads block mutation.
- Backups can still contain historical payloads. They are private, excluded from ordinary scans only if intentionally placed outside managed roots, and must be explicitly destroyed after successful verification.
- The scanner currently reports one finding per pattern per file. Regression work should ensure remediation counts every occurrence even when the scanner summary is coarser.

## Execution record

The targeted preview `privacy-remediation-20260809221505-785e673b` inspected the four affected files with no malformed or unsupported records. It identified 1,654 changed JSON/JSONL records. Apply sanitized entropy, trace, and debug-ledger state; the cognitive-memory file was correctly blocked after a concurrent inode replacement. A fresh same-process identity check then sanitized the cognitive-memory document.

The complete managed-state scan subsequently reduced high-severity findings from five to one:

- entropy `openai-key`: removed;
- entropy `api-key-assignment`: removed;
- trace `openai-key`: removed;
- debug-ledger `api-key-assignment`: removed;
- cognitive-memory `api-key-assignment`: restored by this already-running session's pre-fix in-memory boundary before each tool call.

The remaining cognitive-memory finding was a hot-runtime settlement issue, not a missing historical transformation. After Pi restarted into the updated hydration boundary, the targeted sanitation settled without blocked files. A complete post-restart scan then covered 2,755 files and 712,792,868 bytes with zero skipped or errored files and zero high-severity findings (`evidence_7bc17304f954e8ce`). Subsequent transcript-payload remediation retained that zero-high result.

Private rollback copies are retained outside managed roots under `/tmp/pi-managed-state-remediation-backups/cebc5fcaa033a04a/`, partitioned by preview ID. They remain a residual sensitive-state risk and require explicit deletion authorization; no backup deletion is part of this commit.
