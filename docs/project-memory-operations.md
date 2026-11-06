# Canonical project memory operations

**Authority:** Obsidian project notes are canonical durable memory. Pi sessions remain private episodic evidence. Cognitive memory and compiled recall caches are rebuildable. Hermes is an off-path advisory curator.

## Layout and schema

Canonical notes live under:

```text
Memory/Projects/<repo-name>-<root-hash>/
  Current.md
  Decisions.md
  Constraints.md
  Risks-and-TODOs.md
  Verification.md
  Procedures.md
  History/History.md
```

Every managed note has `memory_schema`, root-hash `project_key`, `memory_kind`, update time, content hash, verification, source fingerprints, evidence IDs, expiry, and supersession metadata. Every load validates the note schema, project identity, note kind, body hash, entry markers, candidate/title hashes, deterministic entry IDs, verification state, and forbidden-content boundary. Any mismatch fails closed: no canonical entry is recalled or compiled, and the invalid note is not overwritten. `Current.md` is generated from verified/corroborated canonical entries; it is not a second editable authority.

Forbidden content includes credentials, secret-like values, full transcripts, prompts, private reasoning, commands/tool output, large raw logs, and full local paths. Managed notes and state files are `0600`; managed directories are `0700`.

### Legacy layout migration

Pre-schema notes in `Memory/<project>/` are not canonical and are not recalled. `scripts/migrate-legacy-project-memory.js` is an explicit operator migration, not a runtime capture path:

```text
node scripts/migrate-legacy-project-memory.js \
  --vault=<vault> \
  --project=<legacy-name>=<repo-path> [--project=...] \
  [--apply]
```

Without `--apply` it prints the planned entries and writes nothing. With `--apply` it writes managed notes under `Memory/Projects/<name>-<rootHash>/`, records metadata-only decisions and a report at `<repo>/.pi/project-memory/legacy-migration-report.json`, and leaves every legacy note byte-identical. Sections are split by heading, classified by heading (constraint/risk/decision/procedure/verification/history), and stored `unverified` because legacy prose is not evidence-qualified. Volatile git state (branch/HEAD/dirty/staged, including `main`/`master` at a SHA) is dropped; commit references are kept as structured `ref-<sha>` evidence IDs and rewritten out of the prose so canonical notes do not pin transient state. Evidence IDs survive even when the prose line that carried them is dropped, preserving provenance. Absolute home paths are rewritten to repo-relative or `$HOME` form, and any section that still fails the forbidden-content scan is skipped and reported. Re-running is idempotent: identical candidates dedupe under the write lock. If a corrected legacy note changes an entry this migration owns (same legacy source fingerprint, still unverified and non-standing), the entry is superseded in place; any other same-title collision goes to the review queue rather than overwriting an operator edit.

## Explicit save, recall, and review

The governed `memory_curator` surface separates pure reads/previews from mutations. `status`, `recall`, `plan`, `review`, and preview operations need no mutation authorization and write no state by default. Mutations require a matching explicit current-user request in the current turn; authorization is scoped independently to canonical saves, review decisions, lifecycle changes, maintenance reports, retention applies, and permission applies.

- `save` — structured candidate with `kind`, `title`, `content`, `verification`, optional source/evidence IDs, and `apply:true`; requires canonical-save intent and an eligible rollout stage;
- `reviewQueue` — queue ambiguity without canonical overwrite; requires review intent and is disabled at M0 rather than writing a rejected decision row;
- `reviewResolution` — record a metadata-only resolution row for diagnostic review requests that will never reach the review queue at the current stage; requires review intent and is refused only by the `PI_PROJECT_MEMORY=0` kill switch, because settling an already-recorded request is not capture. It appends to `.pi/project-memory/diagnostics.jsonl` without touching the vault, a canonical note, or the decision ledger. Requests are keyed by producer, kind and timestamp, so a resolution survives log rotation; `status` reports `rows`/`resolved`/`unresolved` and the oldest unresolved request instead of a backlog that only grows;
- `consolidate` — distil episodic evidence into semantic invariants (dedupe, contradiction resolution, invariant extraction, cross-links, per-type compaction). Preview runs the same decisions against a throwaway copy of the hydrated store and writes nothing; persisting requires lifecycle intent plus `apply:true`, and "consolidate" grants that lifecycle scope. Apply is additionally refused unless the rollout is enabled and `cognitiveConsolidation` is granted (`PI_PROJECT_MEMORY_COGNITIVE_CONSOLIDATION=1`); otherwise it returns `cognitive-consolidation-not-authorized-at-rollout-stage` without hydrating or writing the store. It stays explicit because the declared posture does not authorize automatic consolidation. Applying while a reasoning-runtime session holds its own hydrated copy of `.pi/cognitive-automation/cognitive-memory.json` is last-writer-wins: that session's next debounced persist can overwrite the consolidated store. Apply at a point where no reasoning session is holding state, or reload the runtime afterwards;
- `standing`, `pin`, and `unpin` — inspect or explicitly change the bounded standing projection; mutation requires canonical-save intent, `apply:true`, and eligible rollout;
- `correction` — derive a bounded unverified candidate from an explicit correction; defaults to preview and may enter only the governed review queue;
- `reject` — return a bounded explicit-review rejection result without writing a ledger row;
- `status` — pure status read;
- `recall` — bounded local ranked recall;
- `plan`, `review`, and maintenance/retention/permission previews — pure unless their documented explicit write/apply flag is supplied.

Learning-loop memory summaries follow the same boundary: `memorySummary` is a pure preview unless `input.write=true`; `/learning-memory-summary` persists only with `--write --yes`. Runtime Doctor session hygiene is a pure preview unless `/doctor-sessions-preview --write-manifest --yes` explicitly persists the private aggregate manifest needed by a later apply.

Useful commands:

```text
/memory-durable-status
/memory-recall <query>
/memory-session-search <query>
/memory-session-get <opaque-anchor>
/memory-standing
/memory-pin <canonical-entry-id> [--apply]
/memory-unpin <canonical-entry-id> [--apply]
/memory-correction <explicit-correction> [--apply]
/memory-review
/memory-curate-plan
/obsidian-project-memory-status
/obsidian-project-memory-recall <query>
/obsidian-project-memory-compile [--apply]
```

Saves return `saved`, `saved-labeled`, `deduped`, `review-queued`, or `rejected`. The existing evidence-gated candidate/shadow pipeline remains separate from operator-authorized conversation capture.

### Operator-authorized automatic memory is the harness default

`config/harness-defaults.env` supplies:

```text
PI_PROJECT_MEMORY_STAGE=M1
PI_PROJECT_MEMORY_WRITES=1
PI_PROJECT_MEMORY_AUTOMATIC=1
PI_PROJECT_MEMORY_AUTO_SAVE=1
```

Start a new Pi process to pick up changed defaults; `/reload` does not replace already-populated environment values. Explicit launch overrides still win. Check `/harness-defaults-status` and `/obsidian-project-memory-status`; inherited `M0` or `AUTO_SAVE=0` overrides prevent capture.

Status reports `stageAuthority: operator-opt-in`, `fieldEffectiveness: unproven`, and the unchanged `evidenceEligibleStage`. This is operator permission, **not evidence-qualified promotion**. M2–M5, verified automatic upserts, Hermes curation, retention and standing-instruction promotion retain their independent gates.

The parent model selectively proposes short durable decisions, constraints/preferences, procedures and lasting risks via `memory_curator operation=capture`. Each proposal must quote current-turn user text or already-emitted public assistant text. Private reasoning, tool output, raw transcripts, secrets, personal/sensitive details, speculation, temporary progress and routine test successes are excluded. The shared scanner rejects blocking and review findings. Selection and summarization remain model judgments; source binding is not proof of semantic entailment or truth.

Capture needs no additional per-save consent in this mode, but always stores **unverified, non-standing** entries in the configured current project's canonical vault. Sources are held in bounded turn-local memory; persistence retains the concise fact and a source hash, not the source message. Model-supplied vault, verification and supersession overrides cannot redirect or elevate a capture. Limits are three attempts per turn, 500 characters per fact, 24,000 characters per source class, and 250 canonical entries per project before capture stops. Exact normalized content deduplicates under the write lock; same-topic/title conflicts create metadata-only review records instead of overwriting. Say “do not remember this” to disable capture for that turn. Manual `save`, pin, cleanup and other mutations still require their own current-turn user intent and apply/write controls.

Automatic capture also requires a **confirmed canonical vault** (`explicit`, `configured`, or `discovered-single`). A fallback `default-managed` vault is refused as `canonical-vault-unconfirmed` until an explicit save provisions `Memory/Projects/<name>-<rootHash>`; this prevents a second host with a different home vault from silently creating a divergent project-memory root. Reads remain available, and explicit save can provision the folder.

Every capture attempt, including a rejection before any save, appends one bounded metadata-only row to `.pi/project-memory/diagnostics.jsonl` (`kind: capture-attempt`, with outcome, reason, source, candidate kind, and quote/content hashes only). `status` and `memory_explorer map` report `captureAttempts` counts by outcome and reason. Diagnostic settlement keeps its own seen-fingerprint set (`diagnosticSeenFingerprints`), so a diagnostic-only scan reports a durable candidate once without consuming the fingerprint a later M3 candidate-capture stage needs to promote.

Rollback controls (saved notes are preserved):

- `PI_PROJECT_MEMORY_AUTO_SAVE=0`: stop captures, retain automatic recall.
- `PI_PROJECT_MEMORY_AUTOMATIC=0`: return to manual M1 save/recall; status reports `explicit-m1-opt-in` when no qualifying scorecard exists.
- `PI_PROJECT_MEMORY_RECALL=0`: stop task-conditioned injection.
- `PI_PROJECT_MEMORY_STAGE=M0` or `PI_PROJECT_MEMORY_WRITES=0`: disable operator automatic mode and writes; explicit reads remain available.
- `PI_PROJECT_MEMORY=0`: disable project-memory reads and writes.

No new field cohort, reviewed-gold record, or curation evidence is created by enabling these defaults.

## Recall behavior

Task-conditioned recall runs after each substantive prompt is known. It reads validated canonical notes directly, so a fresh session needs no compiled cache. At most five matching items are formatted within the existing 1,200-character advisory budget; unverified entries are visibly labeled as claims, not facts or authority. Stopword-only and unmatched queries inject no memory. Expired, contradicted and superseded entries are excluded, and canonical integrity mismatches fail closed. Relevance is deterministic lexical matching, not semantic retrieval; production precision/effectiveness remains unproven. Optional cache-only callers still require matching source decision identity. Current Git branch/HEAD/dirty facts are inspected at recall time and labeled `current-git`; durable items are labeled `canonical-vault` or `compiled-cache` with note and content hashes.

Supersession and contradiction exclusions are resolved from all canonical entries before expiry, query/kind filtering or cache limits. Expiring a correction never reinstates its predecessor. Cache compilation stores only eligible entries, and recall checks their expiry again. Legacy compiled caches are rejected as `stale-cache`; rebuild them with `/obsidian-project-memory-compile --apply` (canonical notes are unchanged).

General `obsidian_search` results are ranked deterministically rather than returned in file order. Ranking exposes bounded factors for normalized phrase match, title/path relevance, matched-term coverage, a numeric score, rank, and lexical tie-break. This improves vault discovery but does not turn arbitrary Research notes into canonical project memory.

Hermes does not provide project-memory recall or shutdown sync. Local canonical recall is provider-free. Explicit `/obsidian-hermes <topic>` produces scanner-approved, typed, unverified candidates in dry-run mode. Only `/obsidian-hermes --apply <topic>` may submit them to the governed review queue, and only when the M4 Hermes-curation control is authorized. After human review, `/obsidian-hermes-review <receipt-id> <accept|reject|correct>` records a receipt-bound field disposition without writing or promoting memory. Hermes never writes a competing `Memory/Hermes` note or promotes a candidate to canonical memory.

## Shared durable-content safety

`MemoryContentSafetyAdapter` is the one durable-content scanner exposed through `src/integration-boundary.js`. Canonical candidates, Obsidian note writes/imports, Hermes provider inputs and typed candidate outputs, learning memory summaries, and governed skill candidates use the same implementation. Blocking checks cover credential/private-key forms, transcript payloads, absolute user paths, oversize content, invisible/bidirectional controls, stored instruction override, exfiltration instructions, and embedded data URIs. Encoded/high-entropy indicators are review findings unless corroborated. Reports contain reason codes, counts, and a content hash only—never the matched text.

## Historical session search

`memory_explorer sessionSearch` and `/memory-session-search` perform an explicit bounded direct scan of private Pi JSONL. Search is partitioned by the current root-hash project identity, excludes the active append target by default, excludes thinking/private reasoning, tool arguments/results, images, commands, and non-user/assistant records before matching, then redacts and bounds any returned excerpt. Results use opaque session/anchor IDs rather than filesystem paths. `/memory-session-get` resolves one opaque anchor under the same limits.

Discovery prioritizes the current project's encoded Pi session directory (then descendant directories) before bounded file/session caps, preferring newest timestamp-named files. Directory names are only hints: session headers still enforce project identity, and incomplete scans report truncation. Typed-memory ranking requires an actual query match; verification bonuses cannot return unrelated records.

Search writes no query, excerpt, index, candidate, telemetry content, or canonical note. It returns query hashes and aggregate duration/byte/result/truncation metadata only. `PI_SESSION_SEARCH_ROOTS` may select private source roots. There is no persistent content index; adding one remains conditional on a separately preregistered benchmark.

## Standing instructions

Standing state is a flag on an existing canonical constraint, procedure, or decision—not a second store. Only non-expired verified/corroborated entries with valid managed-note integrity are eligible. The reasoning runtime injects the deterministic bounded standing projection independently of task-conditioned similarity recall. Ordering, item/character limits, supersession, contradiction, and project identity fail closed. Pin/unpin preview is byte-identical and writes no decision; apply requires explicit current-user intent and rollout authorization.

## Correction proposals

Input observation stores only a correction source hash and category. The governed correction operation derives a concise candidate, runs shared content safety, labels it unverified, and defaults to preview. An explicitly authorized apply can write only a review-queue decision; it cannot directly save canonical memory or mark an entry standing. Background correction learning remains disabled.

## Session-storage pressure

Runtime Doctor `sessionStorage` and `/doctor-session-storage` report aggregate logical bytes, inode-deduplicated bytes, allocated bytes, large-file concentration, largest/top-ten file share, and filesystem capacity. A caller may supply a previous metadata-only snapshot to obtain observed daily and normalized 14-day growth plus warning/critical days-to-capacity. Without a prior snapshot the result is explicitly `point-in-time-only`; it is not presented as a field cohort. The operation reads filesystem metadata only, does not read or store session row bodies or paths, and never rewrites, compresses, externalizes, archives, or deletes a session.

## Privacy-candidate review

Privacy Guard findings expose only a severity, pattern name, hashed state path, and ephemeral `privacy_*` handle. Resolve one locally in the same Pi process:

```text
/privacy-review privacy_<handle>
```

The command displays the local file/line and pattern but never the matched value. Inspect the exact value locally. Do not paste it into a report, note, issue, test fixture, or model prompt. Candidate review is complete only when every current actionable handle has a human disposition; unresolved findings keep rollout blocked.

### M0 rollout privacy evidence

Generate a metadata-only preview that combines the current project/global/raw-session scan with the retained private-backup scan:

```bash
node scripts/report-privacy-rollout-evidence.mjs --backup-root=<private-backup-root>
```

Persist the reviewed scan identity explicitly:

```bash
node scripts/report-privacy-rollout-evidence.mjs --backup-root=<private-backup-root> --write --yes
```

The private `0600` artifact binds current source/config identity, scan and source-qualified candidate-set IDs, aggregate coverage, permission posture, hashed state references, and human review records. It excludes matched values and absolute paths. Unrelated state growth may change the scan ID, while reviews remain bound to the same source-qualified candidate set; source or candidate changes invalidate them.

After resolving and inspecting a current handle locally with `/privacy-review`, a human may record only its bounded disposition:

```bash
export PI_PRIVACY_REVIEWER_ID=<local-reviewer-id>
node scripts/review-privacy-rollout-evidence.js --handle=privacy_<current-handle> --disposition=<false-positive-structured|retained-bounded|remediated> --human-confirmed --write --yes
```

The local reviewer identity is hashed before persistence. The review command rejects absent/stale handles, invalid dispositions, and calls without explicit human confirmation. Rerun the evidence report after reviews. Scorecard generation rejects missing, stale, mismatched, tampered, expired, incomplete-coverage, or unreviewed privacy evidence; it no longer trusts bare privacy counts in the general input file.

## Retention and permissions

Preview subsystem retention:

```bash
node scripts/project-memory-retention.js
```

Apply one reviewed class only, then verify and retain the rollback manifest:

```bash
node scripts/project-memory-retention.js --manifest=<reviewed-preview-id> --class=trace --apply --yes
node scripts/project-memory-retention.js --rollback <manifest-id> --apply --yes
```

Raw sessions and canonical memory are never retention candidates. Debug-referenced evidence is protected. Session archive output is preview-only until exact resume/export/restore compatibility is proven.

Preview managed-state modes, then explicitly apply:

```bash
node scripts/harden-managed-memory-state.js
node scripts/harden-managed-memory-state.js --manifest=<reviewed-preview-id> --apply --yes
```

This never chmods the entire vault or unrelated `Research/` notes.

## Unified maintenance preview

Generate one private preview report without applying any operation:

```bash
node scripts/report-memory-maintenance.js --preview
node scripts/report-memory-maintenance.js --preview --no-write
```

The same workflow is available as `/memory-maintenance-preview`, `memory_explorer operation=maintenancePreview` (no report write), and authorized `memory_curator operation=maintenancePreview` (`input.write=true` writes only the report). Reports live under `.pi/memory-maintenance/previews/` with mode `0600`; the root and index are project-private. They include stable candidate IDs/fingerprints, category counts, provider coverage, truncation, source-decision identity, and new/persistent/resolved accounting. They exclude source bodies and full paths.

The periodic due check is disabled by default. Set `PI_MEMORY_MAINTENANCE_PREVIEW_INTERVAL_HOURS` to a positive interval to opt in. Even when opted in, session start performs only a due check and computes a non-writing preview; it writes no report or cleanup state. There is no automatic retention, permission apply, deletion, note rewrite, candidate promotion, or memory rollout change. External schedulers may invoke the explicit report script separately.

Read-only provenance inspection is available through `/memory-provenance [seed]`, `/memory-lineage <id>`, and `memory_explorer operation=provenance`. `/memory-provenance-export [seed]` is the only explicit graph export command and writes under `.pi/provenance-graph/exports/` with private permissions.

## Canonical vault selection and readiness

Every Obsidian and project-memory surface uses `resolveVaultSelection()` from `src/obsidian-adapter.js`. Precedence is an explicit operation argument, configured `PI_OBSIDIAN_VAULT`, exactly one valid discovered vault, then the managed default. A configured missing vault remains authoritative. Multiple valid discovered vaults fail closed until an operator configures one; no writer guesses.

The stable `selectionId`, `projectKey`, and `pathHash` appear in status, doctor, Memory Explorer/Curator status, and recall results. Full vault paths remain runtime-only and are omitted from persisted readiness metadata. Readiness is layered:

- `vaultFilesystem` describes local marker/read/write facts;
- `projectMemoryReads` combines vault readiness with rollout read authority;
- `projectMemoryExplicitWrites` combines vault readiness with explicit-write authority;
- `hermesCuration` requires separate current provider proof and rollout authority;
- `automaticBehaviorAuthorized` reports operator-authorized capture/recall separately from scorecard-qualified behavior, including the field-effectiveness label.

A writable vault never raises rollout stage. The harness explicitly supplies the operator M1 controls above; standalone consumers without these defaults or evidence authority remain at M0. Obsidian desktop is optional for filesystem saves/recall; desktop/open features need a working executable on `PATH` or `PI_OBSIDIAN_BIN`. Hermes authentication/provider readiness alone does not establish curation readiness: a bounded current curation smoke and separate M4 authority are required.

## Rollout and evidence

Independent controls are derived from `PI_PROJECT_MEMORY_STAGE`, the operator flags above and the current private scorecard. Requested stages are capped at the highest evidence-eligible stage, except that exact M1 + `PI_PROJECT_MEMORY_WRITES=1` grants M1. Adding `PI_PROJECT_MEMORY_AUTOMATIC=1` grants selective unverified capture and task recall, not M2–M5 promotion. The evidence ladder remains:

- M0 read-only characterization;
- M1 explicit save/recall/status;
- M2 task-conditioned local recall;
- M3 candidate capture (shadow-only until M5 verified automatic upsert);
- M4 review queue and reviewed Hermes curation;
- M5 narrow verified automatic upsert.

After a gold-set reviewer has personally inspected each current retrieval/save case, record one signed review at a time and collect the private reviewed-gold artifact:

```bash
export PI_REVIEWED_GOLD_REVIEWER_ID=<local-reviewer-id>
read -rs PI_REVIEWED_GOLD_SIGNING_KEY && export PI_REVIEWED_GOLD_SIGNING_KEY
node scripts/review-reviewed-gold-evidence.js --case=<retrieval|save>:<case-id> --human-confirmed --write --yes
node scripts/report-reviewed-gold-evidence.js
node scripts/report-reviewed-gold-evidence.js --write --yes
```

Do not automate the human-confirmation command. The HMAC key must contain at least 32 bytes, remains local secret material, and is never persisted. The reviews and aggregate evidence are private under `.pi/memory-effectiveness/`; the source manifest remains `synthetic-readiness` and is not relabeled. Generate the aggregate scorecard, with the same signing key available whenever the reviewed-gold artifact exists, using:

```bash
node scripts/benchmark-project-memory.js
node scripts/report-memory-effectiveness.js --public
```

The current public scorecard is `docs/memory-effectiveness-scorecard.json`. Runtime authorization recomputes the harness implementation fingerprint, requires an exact source/config match, and rejects scorecards older than `PI_PROJECT_MEMORY_SCORECARD_MAX_AGE_MS` (default seven days). Evidence-qualified automatic release remains `no-go-deferred` until privacy review, at least 20 real fixture-vault curation attempts, at least 30 exact-version uses across 10 independent sessions over 14 days, and every fixed bar pass. Missing or stale evidence fails closed for evidence-based promotion; it does not revoke a separately explicit M1 operator opt-in. Operator permission does not change those evidence labels or the `no-go-deferred` promotion decision.

Synthetic retrieval/save fixtures remain `synthetic-readiness`: passing metrics are informative but have `gateEligible:false`. A `user-reviewed-gold` classification requires the separate signed artifact to cover every current retrieval/save case and match the exact manifest hash, result-set ID, source revision/configuration, and freshness window. Missing signing keys and tampered, stale, future-dated, incomplete, mismatched, or manually supplied `input.json.evidence` values fail closed. Exact-version field input qualifies only when it carries `evidenceClass: "exact-version-field"`, a preregistered `cohortId`, at least 30 exact-version uses across 10 independent sessions over 14 days, and a `sourceRevision` equal to the scored implementation revision. Real curation additionally requires fixture-vault provenance and 20 attempts. The open `exp-memory-learning-compounding-efficacy-field` experiment remains insufficient data; this documentation does not launch a cohort, change its C0–C5 gates, promote rollout, or substitute synthetic observations for field evidence.
