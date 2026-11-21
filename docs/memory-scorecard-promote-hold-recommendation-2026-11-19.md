> **Superseded (2026-11-21).** Artifact-based promotion is retired. Stages now advance only on
> passive telemetry (`docs/memory-rollout-gates-passive-telemetry.md`); the reviewed-gold module,
> signing key, review/collector CLIs, privacy-evidence CLI, and exact-version cohort attestation
> are deleted, and the scorecard is reporting-only. This document is retained as decision history.

# Memory-effectiveness scorecard refresh and promote/hold recommendation

**Date:** 2026-11-19
**Scope:** project-memory rollout stages M0–M5 (`src/project-memory-rollout.js`)
**Mode:** read-only evidence collection. The scorecard refresh was attempted and was refused
by the fail-closed generator. No scorecard, privacy artifact, reviewed-gold artifact, memory
store, decision log, configuration or credential was modified.

## 1. Verdict

**HOLD at M1 (operator opt-in). Do not request M2.**

The refresh cannot be produced from current evidence, and every remaining gate is either
blocked by a human-action prerequisite or structurally unreachable under the present
evidence model. Two findings drive the verdict:

1. **Privacy regressed at the current source.** A read-only re-scan now reports 190 actionable
   findings (18 high, 172 medium) with zero reviews bound to the current candidate set, plus a
   permission-posture violation. The bound 2026-08-14 artifact claimed 0 unresolved
   high-severity findings and `qualified: true`. Promotion of any kind fails while
   `unresolvedHighSeverity > 0`.
2. **The exact-version field gate has no attribution channel.** Not merely "not enough data" —
   there is no artifact that binds a session or memory operation to an implementation revision,
   so `exactVersionUses`, `exactVersionSessions` and `observedDays` cannot accumulate no matter
   how long the harness runs.

## 2. Live M1 runtime state

| Signal | Value |
|---|---|
| Requested / effective stage | `M1` / `M1` |
| Evidence-eligible stage | `M0` |
| Stage authority | `operator-opt-in` |
| Field effectiveness | `unproven` |
| Promotion decision | `no-go-deferred` |
| Controls enabled | reads, explicitWrites, taskRecall, automaticCapture, diagnosticCapture |
| Controls disabled | candidateCapture (M3), reviewQueueWrites/HermesCuration (M4), automaticVerifiedUpserts (M5), cognitiveConsolidation, retentionApply |

Source identity at refresh time: `revision content:7cb3df7f…`, `configHash sha256:7cb3df7f…`
(content hash over 42 implementation files). The revision was born 2026-11-18T08:56:39Z
(newest commit touching a covered file, `.pi/extensions/reasoning-runtime/index.ts`).

## 3. Scorecard refresh attempt — refused, fail-closed

| Command | Result |
|---|---|
| `node scripts/report-memory-effectiveness.js` | refused: `privacy rollout evidence invalid: source-revision-mismatch,config-hash-mismatch,evidence-expired,scan-id-mismatch,evidence-id-mismatch` |
| `node scripts/report-reviewed-gold-evidence.js` | refused: `reviewed-gold signing key must contain at least 32 bytes` |
| in-memory `buildScorecard` at current source, empty privacy/reviewed-gold | `decision no-go-deferred`, `highestAuthorizedStage M0`, `privacyBoundary fail` |

The bound artifacts on disk remain unchanged and stale:

- `.pi/memory-effectiveness/scorecard.json` — `generatedAt 2026-08-14T14:09:16.772Z`,
  `source.revision content:5c0dfac7…`, `highestAuthorizedStage M0`, `decision no-go-deferred`,
  `reviewedGoldQualified false`, `realCurationQualified false`, `exactVersionFieldQualified false`.
- `.pi/privacy-guard/rollout-evidence.json` — `generatedAt 2026-08-14T14:09:16.719Z`, bound to the
  same superseded revision.
- `docs/memory-effectiveness-scorecard.json` — identical to the private copy.
- Reviewed-gold review/evidence artifacts: none exist anywhere under `.pi/`.

Writing a refreshed scorecard was therefore not possible without fabricating inputs, and was
not attempted. Regenerating the scorecard is downstream of items 4 and 5 below.

## 4. Privacy re-scan at current source (read-only, no `--write`)

| Metric | Value |
|---|---|
| Coverage | 6,807 files / 469 MB, `complete: true`, `identityHolds: true` |
| Roots | 30 configured (23 available, 7 absent), `scopeComplete: true` |
| Findings | 190 actionable — 18 high, 172 medium; 22 ignored |
| Reviewed against current candidate set | 0 (`privacy-candidates:7056894a…`) |
| Qualified | `false` |
| Permission posture | `compliant: false` — 2 non-private files (mode 0644) of 2,130 raw-session files; 285 directories at 0700 |
| Backup coverage | unqualified in this run (no `--backup-root` supplied; expected) |

The eight human-confirmed dispositions from 2026-08-14 are bound to two earlier candidate-set
IDs and do not carry over. Every current candidate needs fresh human disposition, and the two
0644 files need remediation before `permissionCompliant` can pass.

## 5. Field evidence for the insufficient-data gates

| Gate | Bar | Observed | Scorecard status |
|---|---|---|---|
| `exactVersionUses` | ≥ 30 | **0 qualified** (absent from input entirely) | insufficient-data |
| `exactVersionSessions` | ≥ 10 | **0 qualified** | insufficient-data |
| `observedDays` | ≥ 14 | **≤ 1.31 days** attributable to the current revision | insufficient-data |
| `realCuration` | ≥ 20 attempts with `fixtureVault: true` provenance | **4 declared, 0 qualified** | insufficient-data |
| `automaticSavePrecision` | ≥ 0.98 over non-applying shadow decisions | **0 qualified samples** | blocked |

### 5.1 Exact-version uses, sessions and observed days

- `.pi/project-memory/diagnostics.jsonl`: 385 settle rows (M0 144, M1 241) spanning
  2026-10-21T18:59Z → 2026-11-19T16:15Z (29.9 days). Only **5 of 390 rows carry any
  `sourceHash`** (kinds: history ×3, procedure, decision), across five older digests
  (`94db4de2…`, `6f5cfd18…`, `f760e806…`, `9e29ec86…`, `076daa40…`). **None match the current
  revision.**
- Session store: 21 interactive session files for this project, 2026-11-07 → 2026-11-19.
  Session headers record only `{type, version: 3, id, timestamp, cwd}` — no implementation
  revision, so no session can be attributed to an exact source revision.
- `decisions.jsonl` rows carry `sourceFingerprints` of the memory note source, not the
  implementation revision.
- Ceiling on `observedDays`: 1.31 days since the current revision was created, versus a 14-day
  bar — a 12.69-day shortfall that grows with every memory-source commit.

### 5.2 Real fixture-vault curation

`input.json` declares `curation.attempts: 4, successRate: 1, timeoutRate: 0, p95Ms: 2000,
conflictReviewPassed: true`, but with no `evidenceClass: real-fixture-vault-curation` and no
`fixtureVault: true` provenance. No curation artifact exists anywhere under `.pi/`:
`.pi/obsidian/state.json` holds only `{version, events, lastEvent, updatedAt}` (2026-10-26) and
`.pi/hermes/readiness.json` holds identities only. Qualified attempts: **0 of 20**; the declared
four are unqualified metadata in a bare private input file.

### 5.3 Automatic-save precision and M1 automatic behavior

`decisions.jsonl` (23 rows, span 2026-08-09 → 2026-10-26, all `verification: unverified`):

| Action | Count | Note |
|---|---|---|
| saved | 14 | explicit saves |
| shadowed | 7 | all at one timestamp `2026-10-25T22:54:47Z`, zero `evidenceIds`, no `noteRevision` |
| rejected | 1 | reason `invalid` |
| superseded | 1 | reason `explicit-save` |

The seven shadow rows are implementation-test records from a single run, not field shadow
decisions with ground truth; precision cannot be computed from them. Independently,
`automaticSavePrecision` is `blocked` unless `exactVersionFieldQualified` is true, which it is
not.

The M1 automatic path itself is **inert** over the whole observation window:

- 0 `capture-attempt` rows (the observability fix landed 2026-11-02; nothing to report since).
- All 385 settles are `diagnosticOnly: true` — no promotion was ever attempted.
- 146 candidate-bearing settles each report the **same single candidate**
  `sha256:44d746aa…`, none after 2026-10-26. `candidate-state.json` still holds one seen
  fingerprint, last updated 2026-10-26T11:01:38Z.
- Aggregate settle `reasonCounts`: `verified-durable` 385, `transient` 355,350, `policy` 385.
- Last successful write: one explicit save, 2026-10-26T13:07:56Z.

Net: automatic capture has produced **0 new durable facts and 0 promotions in ~30 days**. This
is a behavioral finding worth its own diagnosis thread; it is not itself a promotion blocker.

## 6. Structural finding: the exact-version gate is unreachable today

`source.revision` is a content hash over 42 implementation files, so it resets on every commit
that touches memory code. The current revision is 1.31 days old. No artifact binds a session or
a memory operation to that hash, so a 30-use / 10-session / 14-day cohort cannot accrue:

1. session headers carry no revision;
2. diagnostics carry a revision on 5 of 401 rows and never for the current revision;
3. decisions carry note-source fingerprints, not the implementation revision.

Reaching M5 therefore requires an evidence-model change — a per-session revision stamp or a
frozen implementation cohort — before any M5 attempt is meaningful. This is a harness gap, not
an observation gap, and it should be decided explicitly rather than accumulated by waiting.

## 7. Gate reconciliation

| Gate | Status | Blocker class |
|---|---|---|
| Deterministic (privacy boundary, contamination, recall p95 14.49 ms, migration rollback) | pass at current HEAD (11 focused suites rc=0) | — |
| Bound scorecard identity/freshness | fail (revision/config mismatch, expired) | human: needs fresh privacy + gold artifacts |
| Privacy (18 unresolved high severity, 2 non-private files, 0 current reviews) | fail | human: review + remediation |
| Reviewed gold (12 signed cases) | absent | human: personal review + signing key |
| realCuration (0 of 20 qualified) | insufficient-data | operator: 20 real fixture-vault attempts |
| exactVersionUses/Sessions/observedDays | insufficient-data | structural: no attribution channel |
| automaticSavePrecision | blocked | structural + depends on M3 shadow operation, which is unauthorized |

Note the ordering consequence: `highestAuthorizedStage` becomes **M2** once privacy and
reviewed gold are qualified, *without* any of the field gates. M3 needs the curation cohort; M5
needs the exact-version cohort. The field gates gathered here are therefore not the binding
constraint on the next stage — privacy and reviewed gold are.

## 8. Ranked next actions

1. **Privacy re-bind (human + remediation).** Two distinct operations, in this order:
   first **eliminate** the 18 high-severity findings from the scanned state — reviews cannot
   clear them (`unresolvedHighSeverity` counts every high finding in primary and backup
   regardless of disposition) — then bind the candidate set and review every remaining
   actionable handle. Remediation changes the candidate set, so it must precede the review
   loop. Require `qualified: true` with `unresolvedHighSeverity: 0` and
   `unresolvedActionable: 0`. Exact commands are in section 11.
2. **Reviewed gold (human).** Personally review all 12 manifest cases (4 retrieval, 8 save) and
   sign each with `PI_REVIEWED_GOLD_SIGNING_KEY`, then write the aggregate and require
   `reviewedCases: 12, unresolvedCases: 0, qualified: true`.
3. **Regenerate the scorecard** once 1 and 2 pass, and verify `validateScorecardSource` returns
   no reasons. Expect `highestAuthorizedStage: M2`, `decision: no-go-deferred`.
4. **Request M2 in a fresh process** with automatic save off, per the conservative sequence in
   `docs/privacy-rollout-remediation-report-2026-08-14.md`.
5. **Decide the exact-version evidence model** before any M5 attempt (per-session revision stamp
   or frozen cohort), and bank 20 real fixture-vault curation attempts before M3.

## 9. What would change this verdict

- Privacy returning `qualified: true` with zero unresolved high severity at the current
  candidate set.
- A signed reviewed-gold artifact covering all 12 cases at the current manifest hash.
- A fresh scorecard whose `source.revision` matches HEAD and which validates without reasons.

Absent all three, requesting M2 resolves back to M1 (`promotionBlocked` semantics), which is the
intended fail-closed behavior.

## 10. Limitations

- The privacy re-scan ran without `--backup-root`, so backup coverage is unqualified here by
  construction; primary coverage was complete and identity-held.
- Findings were counted by severity only; no matched values, paths, prompts or transcripts were
  read out or recorded.
- `observedDays` is bounded by commit timestamps of covered files, not by a recorded cohort
  start; it is an upper bound.
- No provider-backed or live curation probes were run in this pass.
- `diagnostics.jsonl` is live-appended and trimmed by maintenance; the row counts above are a
  snapshot at 2026-11-19T16:15Z (390 rows, 385 settles). An earlier read during the same pass
  saw 401 rows, so counts move under concurrent session activity; the ratio of attributable rows
  did not.

## 11. Exact regeneration runbook for valid privacy rollout evidence

All commands run from the repository root. Nothing here weakens a gate: no max-age override,
no hand-edited counts, no synthetic relabelling.

### Binding rules that dictate the order

| Rule | Consequence |
|---|---|
| `candidateSetId = hash(source revision + configHash, roots, findings)` | Any remediation or new finding changes the set and voids **all** prior reviews. Remediate first, review second. |
| `unresolvedHighSeverity` = count of high findings in primary **and** backup, not review-adjusted | High findings must be **eliminated from the scanned state**; a review disposition cannot clear them. |
| `qualified` requires `primaryCoverageQualified && backupCoverageQualified && backupClean && unresolvedHighSeverity === 0 && unresolved.length === 0` | Coverage must be complete, untruncated, permission-compliant; the backup must scan clean. |
| Evidence is bound to `source.revision` + `configHash` (42 covered files) | No commit touching those files between collection and scorecard generation. |
| Privacy evidence max age **24 h**; gold evidence and scorecard **7 d** | Collect gold first, privacy last, scorecard immediately after. |

### Phase 0 — freeze and record identity

```bash
cd <repository-root>
git status --porcelain            # only the intended artifacts may appear
node - <<'NODE'
const { currentMemorySourceEvidence } = require('./src/memory-effectiveness-source');
console.log(currentMemorySourceEvidence({ implementationRoot: process.cwd() }));
NODE
```

Record `revision` (currently `content:7cb3df7f…`). Every later artifact must carry exactly this
value. Do not commit changes to `src/project-memory*`, `src/memory-effectiveness*`,
`src/memory-state*`, `src/state-*`, `src/managed-state*`, `src/session-storage*`,
`src/cognitive-memory*`, `src/fix-recall*`, `src/integration-boundary*`, `src/obsidian-adapter*`,
`src/hermes-*`, `src/privacy-guard-scan.js`, the four covered scripts, the gold/review scripts,
`tests/fixtures/memory-effectiveness/manifest.json`, or
`.pi/extensions/{privacy-guard,memory-explorer,reasoning-runtime,obsidian}/index.ts` and
`extensions/hermes-advisory/index.ts` until the scorecard is regenerated.

### Phase 1 — eliminate high-severity findings

**1a. Raw-session permissions** (the `unsafe-session-permissions` high finding).

The plan is state-driven: every currently non-private file or directory is planned, whether or
not the one-time migration marker has already been written. The marker remains an audit record
(`permissionMigration=v2 status=already-applied`); it no longer suppresses planning.

```bash
node scripts/session-hygiene.js --write-manifest --yes   # persists the private preview manifest (fingerprint)
node scripts/session-hygiene.js --apply --yes            # applies chmod using the matching preview
```

Read the preview line `permissionMigration=v2 status=… permissionChanges=N`. `N` must equal the
number of non-private entries the gate scan reports below. On 2026-11-19 the store held 2,130
session files with 2 files at 0644, so the expected value is `permissionChanges=2`.

`--apply` refuses with `preview-mismatch` unless the persisted fingerprint matches the current
plan, and refuses entirely on truncated or unsafe plans. Each entry carries its inode identity,
so an apply also refuses entries swapped after the preview (`path-changed-since-preview`).

If `permissionChanges = 0` while the gate scan still reports `nonPrivateFiles > 0`, treat it as a
planner regression, not as a reason to chmod by hand. Cross-check by mode only (no file content
is read) and stop to fix the planner:

```bash
find ~/.pi/agent/sessions -type f -perm 0644
```

Gate:

```bash
node -e "const {scan}=require('./src/privacy-guard-scan');const s=scan(process.cwd(),undefined,{rawSessionPermissions:true});console.log(JSON.stringify(s.permissionPosture))"
```

Require `nonPrivateFiles: 0`, `nonPrivateDirectories: 0`, `unsafeEntries: 0`, `scanErrors: 0`,
`compliant: true`.

**1b. Managed-state secret findings** (the remaining high findings):

```bash
node scripts/remediate-managed-state-privacy.js                       # preview; prints manifest id
node scripts/remediate-managed-state-privacy.js --apply --yes --manifest=<id>
```

Preview writes `.pi/privacy-guard/remediation-previews/<id>.json`; apply writes the identity-checked
private backup under `$TMPDIR/pi-managed-state-remediation-backups/…` plus a result record. Gate:

```bash
node -e "const {scan}=require('./src/privacy-guard-scan');const s=scan(process.cwd(),undefined,{rawSessionPermissions:true});console.log(JSON.stringify(s.summary))"
```

Repeat preview→apply→rescan until `bySeverity.high === 0`. Do not substitute reviews for
remediation.

**1c. Backup root** (needed for `backupClean`): apply the same identity-checked redaction to the
private remediation backup root, then confirm it scans clean:

```bash
node scripts/report-privacy-rollout-evidence.mjs --backup-root=<private-backup-root>
```

Require `backupCoverageQualified: true` and `backupClean: true`. The root must exist and scan
completely (`absentRoots: 0`, `skippedFiles: 0`, `erroredFiles: 0`, `truncated: false`).

### Phase 2 — bind the candidate set (fresh `scan-id`)

Run only after Phase 1 is complete:

```bash
node scripts/report-privacy-rollout-evidence.mjs --backup-root=<private-backup-root> --write --yes
```

Expect `ok: false` here (no reviews yet), `summary.unresolvedHighSeverity: 0`,
`actionable ≈ 172`, and `permissionCompliant: true`. Record the printed `candidateSetId` and
`scanId`; these replace the stale `privacy-candidates:7056894a…` set. The artifact is written to
`.pi/privacy-guard/rollout-evidence.json` (0600).

### Phase 3 — review every remaining actionable handle

List the handles (metadata only — handles are hashes, no paths or values):

```bash
node -e "const fs=require('fs');const e=JSON.parse(fs.readFileSync('.pi/privacy-guard/rollout-evidence.json','utf8'));console.log(e.candidateSetId);for(const f of e.primary.findings)console.log(f.severity,f.pattern,f.reviewHandle)"
```

Resolve each locally inside Pi. `/privacy-review` only resolves handles registered by a scan in
**that** process, and handles are deterministic (`privacy_<sha256(absolute path:pattern:line)[:16]>`),
so scan first in the same session:

```text
/privacy-scan
/privacy-review privacy_<handle>
```

Then record one disposition per case — never in a loop, never automated:

```bash
export PI_PRIVACY_REVIEWER_ID=<local-reviewer-id>
node scripts/review-privacy-rollout-evidence.js --handle=privacy_<handle> --disposition=<false-positive-structured|retained-bounded|remediated> --human-confirmed --write --yes
```

Caveat: `/privacy-scan` rewrites `.pi/privacy-guard/latest-scan.json`, which sits inside a scanned
root. That does not change `candidateSetId` unless it creates a new finding — re-print
`candidateSetId` after the loop and re-review the delta if it changed.

### Phase 4 — finalize privacy evidence

```bash
node scripts/report-privacy-rollout-evidence.mjs --backup-root=<private-backup-root> --write --yes
```

Require all of: `ok: true`, `summary.qualified: true`, `unresolvedHighSeverity: 0`,
`unresolvedActionable: 0`, `reviewedCandidates === actionable`, `primaryCoverageQualified: true`,
`backupCoverageQualified: true`, `backupClean: true`, `permissionCompliant: true`, and the same
`candidateSetId` recorded in Phase 2.

### Phase 5 — 32-byte gold key and 12 signed reviews

Do this **before** Phase 4 in wall-clock terms if you need margin: gold evidence lives 7 days,
privacy evidence only 24 hours.

Create the key. The requirement is ≥32 bytes of the environment string, not ≥32 bytes of entropy
after decoding:

```bash
read -rs PI_REVIEWED_GOLD_SIGNING_KEY && export PI_REVIEWED_GOLD_SIGNING_KEY   # paste ≥32 chars, no echo
```

Generate once with `openssl rand -base64 48` and paste it at the prompt. Keep it out of files,
shell history, command arguments, logs and artifacts; store it in the operator's secret manager.
The same key is required when regenerating the scorecard while the artifact exists — losing it
means re-reviewing all 12 cases.

Freeze the result set first: `input.json.retrievalResults` and `saveResults` must cover all 12
manifest cases (4 retrieval, 8 save), duplicate-free, and must not change afterwards.

```bash
export PI_REVIEWED_GOLD_REVIEWER_ID=<local-reviewer-id>
node scripts/review-reviewed-gold-evidence.js --case=retrieval:<case-id> --human-confirmed --write --yes
node scripts/review-reviewed-gold-evidence.js --case=save:<case-id> --human-confirmed --write --yes
node scripts/report-reviewed-gold-evidence.js                 # preview
node scripts/report-reviewed-gold-evidence.js --write --yes   # writes .pi/memory-effectiveness/reviewed-gold-evidence.json (0600)
```

Require `summary.reviewedCases: 12`, `unresolvedCases: 0`, `qualified: true`. Each review is
signed over `source.revision` + `configHash`, so a covered-file commit invalidates all 12.

### Phase 6 — regenerate the scorecard

```bash
node scripts/report-memory-effectiveness.js --public
```

Require `ok: true`, `reviewedGoldQualified: true`, `highestAuthorizedStage: M2`,
`decision: no-go-deferred`. Then verify identity and runtime:

```bash
node - <<'NODE'
const fs = require('node:fs');
const { currentMemorySourceEvidence, validateScorecardSource } = require('./src/memory-effectiveness-source');
const { projectMemoryRuntimeConfig } = require('./src/project-memory-runtime');
const card = JSON.parse(fs.readFileSync('.pi/memory-effectiveness/scorecard.json', 'utf8'));
const current = currentMemorySourceEvidence({ implementationRoot: process.cwd() });
console.log('reasons:', validateScorecardSource(card, current).reasons);
const runtime = projectMemoryRuntimeConfig(process.cwd(), process.env);
console.log(JSON.stringify({ decision: card.decision, highestAuthorizedStage: card.highestAuthorizedStage, evidenceEligibleStage: runtime.rollout.evidenceEligibleStage, effectiveStage: runtime.rollout.effectiveStage }, null, 2));
NODE
```

Expect empty reasons and `evidenceEligibleStage: M2`.

### Phase 7 — request M2 (separate step, fresh process)

```bash
export PI_PROJECT_MEMORY_STAGE=M2
export PI_PROJECT_MEMORY_WRITES=1
export PI_PROJECT_MEMORY_AUTOMATIC=0
export PI_PROJECT_MEMORY_AUTO_SAVE=0
```

Start a fresh Pi process, then `/obsidian-project-memory-status`. Require `effectiveStage: M2`,
`stageAuthority: scorecard`, `taskRecall: true`, `automaticCapture: false`,
`automaticVerifiedUpserts: false`, `fieldEffectiveness: unproven`.

### Freshness budget

| Artifact | Default max age | Override (do not use to force a pass) |
|---|---|---|
| Privacy rollout evidence | 24 h | `PI_PROJECT_MEMORY_PRIVACY_EVIDENCE_MAX_AGE_MS` |
| Reviewed-gold evidence | 7 d | `PI_PROJECT_MEMORY_REVIEWED_GOLD_EVIDENCE_MAX_AGE_MS` |
| Scorecard | 7 d | `PI_PROJECT_MEMORY_SCORECARD_MAX_AGE_MS` |

### Failure modes

| Reason code | Cause | Correct response |
|---|---|---|
| `source-revision-mismatch` / `config-hash-mismatch` | a covered file changed after collection | redo Phases 1–6 from a frozen tree |
| `scan-id-mismatch` / `evidence-id-mismatch` on an old artifact | artifact was built by an older builder (the current `scan()` ignores `includeGlobal`, the August artifact lists global roots) | regenerate with current code; never patch the file |
| `candidate-set-id-mismatch` after reviews | a finding was added or removed | re-review handles in the new set |
| `summary-mismatch` | evidence edited by hand | regenerate |
| `unresolvedHighSeverity > 0` despite reviews | reviews do not clear high findings | remediate the underlying state (Phase 1) |
| `changed=0` from session-hygiene while `nonPrivateFiles > 0` | planner regression: planning must be state-driven, not marker-gated | fix the planner; do not chmod by hand |
| `backupCoverageQualified: false` / `backupClean: false` | backup root absent, incomplete, or unredacted | redact and rescan the backup |
| `result-set-id-mismatch` | `input.json` results changed after gold reviews | freeze the result set, redo Phase 5 |
| `missing-or-invalid-signing-key` | key absent or under 32 bytes | re-export the same key |
| `absolute-path` / `forbidden-field` | a collector wrote a path or forbidden field | fix the collector, regenerate |

### What this runbook does not do

It does not qualify `realCuration` (still 0 of 20 real fixture-vault attempts), `exactVersionUses`
/ `exactVersionSessions` / `observedDays` (no attribution channel exists), or
`automaticSavePrecision` (needs M3 shadow operation, which stays unauthorized). Those remain
blocked after M2; they gate M3 and M5, not M2.
