# Privacy triage and project-memory rollout remediation report

**Date:** 2026-08-14

**Scope:** project managed state, global Hermes memory roots, raw-session permission metadata, historical remediation evidence, private remediation backups, and the M0–M5 project-memory scorecard path.

No matched secret, transcript text, private reasoning, command payload, or absolute local path is reproduced in this report. Findings are described only by counts, pattern classes, state classes, and bounded metadata.

## Executive finding

The obsolete `102` high-severity scalar has been removed from scorecard input and superseded by a current private identity-bound privacy artifact. The artifact validates against current source/config identity and records complete project/global/raw-session and retained-backup coverage, zero high-severity findings, eight current medium candidates, eight human-confirmed structural dispositions, and `qualified:true`. The scorecard now passes the privacy boundary truthfully on metric `0` with `gateEligible:true` rather than treating 102 unidentifiable candidates as current evidence.

A fresh project-plus-global scan found:

- **0 high-severity findings** in configured project state and global Hermes memory roots;
- **8 medium `full-transcript-hint` findings**, consistent with the previously audited lexical residual set;
- complete coverage of **2,875/2,875 files** and **392,656,816 bytes**, with zero skipped or errored files;
- raw-session metadata fully private: **1,552 files at `0600`**, **117 directories at `0700`**, and zero unsafe entries.

The raw lexical scan remains `ok:false` because it reports the eight medium candidates before disposition. All eight now have current identity-bound human-confirmed `false-positive-structured` reviews, and the bound rollout artifact is `qualified:true`.

The baseline explicit scan of the private pre-remediation rollback backups found a separate issue outside the configured scan roots: 85 files/664,524,782 bytes, seven high-severity findings across five files, and 48 medium transcript hints. The authorized redaction completed on 2026-08-14 without deleting a backup or rotating a credential. The final explicit scan covered all 85 remaining backup files/200,356,480 bytes and found **zero actionable or ignored findings**, with zero skipped or errored files.

## Triage disposition

| Inventory | Current count | Classification | Disposition |
|---|---:|---|---|
| Scorecard privacy evidence | 0 high, 8/8 reviewed medium | **Current identity-bound and human-qualified** | Preserve the qualified artifact and rerun after source/config or candidate-set changes. |
| Configured project/global roots | 0 high | **Current complete scan** | Preserve as gate evidence with current residual reviews and scorecard binding. |
| Configured project/global roots | 8 medium | **Human-confirmed structured lexical false positives** | Preserve identity-bound classifications without storing matched values. |
| Private remediation backups (baseline) | 7 high, 48 medium | **Historical secret/transcript-bearing payloads** | Remediated by structure-preserving in-place redaction; no deletion or credential rotation. |
| Private remediation backups (current) | 0 findings | **Complete explicit post-redaction scan** | Retain private modes and lifecycle controls; deletion still requires separate confirmation. |
| Raw-session permissions | 0 unsafe | **Compliant** | Keep metadata-only permission checks in every release gate. |

### Current eight medium residuals

The fresh eight-medium set matches the structural classes documented after the 2026-08-10 remediation:

| State class | Count | Existing structural classification | Required current action |
|---|---:|---|---|
| Tracked-source branch recovery snapshots | 2 | Source text with role/content vocabulary; not transcript state | Human-reviewed `false-positive-structured`; retain recovery content while private-path/runtime-message exclusions hold. |
| Resolved debug ledgers | 5 | Bounded diagnostic fields; no message array or transcript payload | Human-reviewed `false-positive-structured`; retain bounded failed-attempt evidence. |
| Closed experiment ledger | 1 | Bounded gate note; no message array or transcript payload | Human-reviewed `false-positive-structured`; retain preregistered verdict history. |

A safe long-term fix is schema-aware suppression for these exact structured cases, with false-positive regression fixtures. A path-wide ignore would be unsafe.

## Prioritized remediation

### P0 — close real secret-bearing backup exposure — completed

Execution evidence:

- preview `backup-redaction-20260814094125-67a6976e` inspected 85 files/664,524,782 bytes, selected 85 candidates and 136,368 changed records, and reported zero blocked files;
- the identity-checked atomic apply redacted all 85 files with zero blocked files;
- bounded rule totals were 654 assistant-turn payloads, 58 credential assignments, 233,681 diagnostic payloads, 216 API-key-shaped values, one private-key block, and 90,131 sensitive fields;
- no unsanitized rollback copy was created, no backup was deleted, and no credential was rotated;
- the final explicit scan covered 85/85 files and 200,356,480 bytes with zero findings, skips, or errors;
- idempotence preview `backup-redaction-20260814094259-4f53cda1` selected zero files and zero records.

A bounded lifecycle for future remediation backups remains advisable. Any future deletion or credential rotation still requires separate confirmation.

### P0 — replace the stale scorecard privacy input with bound evidence — completed

The canonical collector now generates a private `0600` artifact containing current source/config identity, full scan and source-qualified candidate-set IDs, project/global/raw-session and retained-backup coverage, permission posture, hashed candidate references, and human-review records. The scorecard generator rejects missing, stale, mismatched, tampered, expired, incomplete, or unreviewed evidence and no longer consumes the obsolete bare privacy counts.

Current artifact result:

- primary and backup coverage qualified;
- retained backup clean;
- zero unresolved high-severity findings;
- eight actionable medium candidates;
- eight bound human-confirmed dispositions;
- zero unresolved actionable candidates;
- `qualified:true`.

The human-review P0 action is complete. Any future source/config or candidate-set change must trigger fresh local review before the artifact can qualify again. No matched value or reviewer name may enter the artifact.

### P1 — finish current residual review and permission hardening

Permission hardening is complete:

- exact manifest `permissions_d7555c332b66b2f4` covered 2,527 managed files and 61 managed directories with zero preview errors;
- 430 files were changed to `0600` and 41 directories to `0700`, with zero apply errors;
- the post-apply preview reported zero noncompliant files and zero noncompliant directories;
- the operation excluded the entire vault and unrelated Research notes.

Residual review is complete: all eight current medium handles have identity-bound human-confirmed structural dispositions without matched values. Schema-aware false-positive tests or suppression remain advisable so a complete raw scan can become `ok:true` without ignoring arbitrary debug, experiment, or snapshot paths.

### P1 — qualify deterministic and user-reviewed-gold evidence

The fixed manifest contains four retrieval and eight save cases. Synthetic success does not authorize rollout.

1. Human-review all **12** expected retrieval/save cases against their labels and forbidden outcomes.
2. Declare `user-reviewed-gold` only after review, bind it to the exact current manifest hash, and record at least 12 reviewed cases.
3. Re-run deterministic privacy, contamination, local-recall performance, and migration/rollback checks.
4. Regenerate a fresh scorecard and verify the runtime authorization result.

With current deterministic metrics, a privacy-only correction still remains **M0**. A correctly bound reviewed-gold result is the first configuration that authorizes **M2**. For conservative rollout, request **M1** first, verify explicit save/recall/status with no automatic writes, then request M2 and verify task-conditioned local recall.

### P2 — qualify M3 and resolve the M4 stage mismatch

Current curation evidence has four attempts. Qualification requires:

- at least **20** attempts, so at least **16 additional qualifying attempts**;
- `evidenceClass: real-fixture-vault-curation`;
- `fixtureVault: true` provenance;
- success rate at least **0.90**;
- timeout rate at most **0.10**;
- p95 duration at most **120 seconds**;
- conflict-review evidence.

Hermes authentication, provider/model readiness, and a bounded dry-run curation probe are currently ready. That readiness is necessary but is not rollout evidence.

The current scorecard implementation has a stage-progression mismatch:

- privacy plus reviewed gold authorizes M2;
- qualifying real curation authorizes M3;
- qualifying exact-version field evidence plus every bar authorizes M5;
- it never independently emits M4.

Therefore M4 can currently be selected only as a requested cap **after M5 eligibility already exists**. If M4 is intended to precede M5, the minimum code correction is to make the scorecard authorize M4 only after M3 shadow-decision evidence and qualifying real curation pass, then add stage-transition and fail-closed tests. Otherwise the M3-to-M5 skip must be explicitly documented and M4 treated only as a post-eligibility canary cap.

### P3 — collect M5 field evidence without enabling writes

Use the existing preregistered field experiment; do not create a replacement cohort or reinterpret its current null results.

Minimum M5 bars include:

- at least **30 exact-version uses**;
- at least **10 independent sessions**;
- at least **14 observed days**;
- a preregistered cohort ID and source revision exactly matching the scored implementation;
- automatic-save precision at least **0.98**, measured from shadow decisions before apply authority;
- current-fact stale rate **0**;
- explicit-save precision at least **0.95**;
- curation success/timeout bars and every deterministic/reviewed-gold score passing;
- zero unresolved high-severity privacy findings and no policy/privacy regression.

The open field experiment currently has null results for C2/C3/C5 and no qualifying exact-version cohort. Synthetic fixtures, readiness probes, and the present dry run cannot substitute for this evidence.

Only after a fresh M5-eligible scorecard should operators:

1. request M4 as a canary cap and verify reviewed Hermes curation with automatic upserts still off;
2. run full repository, extension/TUI, privacy, static, and runtime verification;
3. request M5 and set the explicit automatic-save opt-in;
4. verify narrow verified upserts, rollback, dedupe/conflict behavior, provenance, and zero privacy regressions before leaving it enabled.

## Deterministic stage simulation

A no-write simulation against the current scorecard implementation produced:

| Evidence supplied | Highest authorized stage |
|---|---|
| Fresh privacy count only | M0 |
| Privacy plus correctly bound user-reviewed gold | M2 |
| Above plus qualifying real fixture-vault curation | M3 |
| Above plus qualifying exact-version field evidence and all bars | M5 |

This confirms both that the stale privacy count is not the only blocker and that M4 has no independent scorecard transition today.

## Minimum verified sequence

1. **Contain backups — complete:** identity-checked redaction applied; explicit scan and idempotence preview are clean; no deletion or rotation occurred.
2. **Close active scan review — complete:** all eight medium residual classifications are human-confirmed and identity-bound; the project/global/raw-session scan has zero high findings and complete coverage.
3. **Harden permissions — complete:** exact managed-state mode manifest applied and post-apply preview has zero noncompliant entries.
4. **Bind privacy evidence — complete:** current scan/backup/permission evidence and all eight human dispositions are source-bound, fail-closed, and regenerated as `qualified:true`.
5. **Qualify reviewed gold:** review and hash-bind all 12 fixed cases; stage M1 then M2 with no automatic behavior.
6. **Qualify curation:** bank at least 20 real fixture-vault attempts and all fixed bars; verify M3 shadow operation.
7. **Resolve M4 semantics:** implement/test a real M4 transition or document/use M4 only as an M5-eligible canary cap.
8. **Complete the existing field cohort:** meet exact-version, session, duration, quality, cost, and privacy bars; do not promote on null results.
9. **Enable narrowly:** M4 canary, full verification, then explicit M5 automatic-save opt-in and post-enable evidence.

## Authorized rollout execution check

A subsequent explicit user request supplied mutation intent but did not replace the scorecard’s evidence authority. A no-write evaluation with requested stage `M5` and automatic save enabled resolved to:

- eligible and effective stage `M0`;
- `promotionBlocked: true` and decision `no-go-deferred`;
- Hermes curation disabled;
- automatic verified upserts disabled;
- automatic behavior status `not-authorized` with authority `scorecard-rollout-only`.

At this check, the private scorecard was rejected for both source-revision and configuration-hash mismatch. The identity-only defect was subsequently repaired as documented below. The later M0 evidence-binding pass also replaced the stale privacy scalar with the current fail-closed artifact; all eight human dispositions are now bound and privacy is qualified. Independently, user-reviewed gold is absent, real fixture-vault curation has 4/20 attempts, and exact-version field evidence has 0/30 uses, 0/10 independent sessions, and 0/14 observed days. These facts cannot be repaired by changing environment variables or relabeling synthetic fixtures.

Provider readiness is not the blocker: bounded live probes confirmed Hermes authentication and provider/model readiness, and a synthetic curation dry run succeeded without writing a note. Ten focused tests passed across rollout resolution, candidate filtering, readiness consistency, decision/provenance handling, dedupe/conflict/integrity/rollback behavior, concurrency, adapter behavior, Hermes readiness, and Hermes client boundaries. This proves the implementation’s guarded fixture behavior; it does not substitute for reviewed-gold, real-curation, or temporal field evidence.

The latest bound project/global scan covered 2,875/2,875 files and 392,656,816 bytes with zero high findings, the same eight human-reviewed medium residuals, and zero skips or errors. Raw-session permissions remained fully private, managed-state permission preview remained at zero violations, and the report/source scan had zero actionable findings.

Accordingly, the canonical configuration remains `PI_PROJECT_MEMORY_STAGE=M0` and `PI_PROJECT_MEMORY_AUTO_SAVE=0`. Enabling either production control or marking the rollout roadmap complete would bypass the fail-closed scorecard and make an unsupported claim.

## Scorecard identity repair at M0

The source/config mismatch was expected drift, not a validator defect: seven of the 31 identity-bearing implementation files changed after the prior public scorecard commit. A read-only in-memory build first proved that canonical regeneration from the unchanged manifest and private input would match the current source identity while preserving every evidence class, count, and rollout decision.

After a working-tree checkpoint, the canonical report generator refreshed the private and public scorecards. Verification established:

- source/config validation passes with zero freshness reasons;
- private and public scorecard content is identical;
- the public diff changes only `generatedAt`, source revision, and configuration hash;
- the private scorecard remains mode `0600`;
- decision remains `no-go-deferred`, highest authorized stage remains `M0`, and `automaticBehaviorAuthorized` remains false;
- runtime requested and effective stages are `M0`; production remained capped at M0 throughout evidence collection;
- Hermes curation and automatic verified upserts remain disabled;
- the manifest remains `synthetic-readiness`; no fixture or evidence was relabeled.

Privacy review has since completed with 8/8 identity-bound human dispositions and `qualified:true`. The remaining real-evidence requirements are:

1. Human-review all 12 retrieval/save cases and bind `user-reviewed-gold` to the exact manifest hash; synthetic fixture success is not a substitute.
2. Bank at least 20 qualifying `real-fixture-vault-curation` attempts with fixture-vault provenance, at least 90% success, at most 10% timeout, p95 at most 120 seconds, and conflict-review evidence.
3. Complete the preregistered exact-version field cohort with at least 30 uses across 10 independent sessions and 14 observed days, matching source revision, automatic-save precision at least 98%, explicit-save precision at least 95%, stale-current-fact rate zero, and no unresolved high-severity privacy findings.
4. Resolve and test the independent M4 transition semantics before treating M4 as an ordinary pre-M5 stage.

Until those requirements are observed and bound, M0 is the correct production stage.

## Claim boundary

This remediation used previewed, identity-checked atomic rewriting to sanitize the existing private rollback backups and applied an exact managed-state permission manifest. It reran explicit backup, project/global, raw-session permission, and managed-state permission scans, then updated this report. The subsequent scorecard repair regenerated private/public scorecards from the existing manifest and input solely to bind current source/config identity. The M0 evidence pass then replaced the obsolete bare privacy input with a private source-bound scan/review artifact and regenerated the scorecard at M0. It did **not** expose matched values, delete backups, create unsanitized rollback copies, rotate credentials, invent human dispositions, relabel fixtures, fabricate observations, start a field cohort, change rollout stages, enable Hermes curation, or enable automatic verified upserts.
