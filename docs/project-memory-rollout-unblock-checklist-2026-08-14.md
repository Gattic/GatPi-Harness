# Project-memory rollout unblock checklist

**Date:** 2026-08-14

**Applies to:** the seven blocked items under roadmap `roadmap_5634b73d5a0a`, scope `1.1.2.3`.

**Safety rule:** collect and bind evidence while production stays at M0. Do not enable Hermes curation, review-queue writes, or automatic verified upserts merely to produce evidence. Synthetic tests and readiness probes prove implementation behavior only; they never become reviewed-gold, real-curation, or field evidence by relabeling.

## 1. Owners

Assign named humans to these roles before starting. One person may hold multiple roles, but the gold/privacy reviewer must personally perform the required reviews.

| Role | Responsibility |
|---|---|
| Rollout owner | Approves stage requests and rollback; keeps M0 until each gate is proven. |
| Harness maintainer | Implements identity-bound evidence ingestion and scorecard validation; never hand-edits passing counts. |
| Privacy reviewer | Reviews all current privacy handles locally without copying matched values. |
| Gold-set reviewer | Reviews every retrieval/save case and signs the exact manifest hash. |
| Curation operator | Runs bounded real fixture-vault curation attempts and records metadata-only outcomes. |
| Experiment owner | Owns the preregistered exact-version cohort and records every null/fail/pass gate. |
| Release verifier | Runs independent focused, privacy, runtime, rollback, and Git-aware verification. |
| Roadmap operator | Changes roadmap status only after the corresponding evidence is current. |

## 2. Mandatory M0 invariant

Run this before and after every evidence-collection or scorecard step:

```bash
node - <<'NODE'
const assert = require('node:assert/strict');
const { projectMemoryRuntimeConfig } = require('./src/project-memory-runtime');
const runtime = projectMemoryRuntimeConfig(process.cwd(), process.env);
assert.equal(runtime.rollout.requestedStage, 'M0');
assert.equal(runtime.rollout.effectiveStage, 'M0');
assert.equal(runtime.rollout.controls.hermesCuration, false);
assert.equal(runtime.rollout.controls.automaticVerifiedUpserts, false);
assert.notEqual(process.env.PI_PROJECT_MEMORY_AUTO_SAVE, '1');
console.log('M0 invariant: PASS');
NODE
```

Stop immediately if it fails. Restore:

```bash
export PI_PROJECT_MEMORY_STAGE=M0
export PI_PROJECT_MEMORY_AUTO_SAVE=0
export PI_PROJECT_MEMORY_RETENTION_APPLY=0
```

Then start a fresh Pi process and rerun the invariant.

## 3. Evidence-binding prerequisite

The current generator reads a bare private input file. That is insufficient for promotion evidence. Before any blocked item is marked done, the harness maintainer must provide a reviewed ingestion path that:

- accepts private metadata-only evidence artifacts with stable IDs and hashes;
- binds every artifact to the current source revision/configuration hash and generation time;
- rejects stale, future-dated, mismatched, incomplete, manually inflated, or unqualified evidence;
- preserves evidence classes rather than converting synthetic observations into stronger classes;
- stores no prompts, transcripts, private reasoning, matched secret values, command arguments, raw outputs, or absolute paths;
- writes private artifacts as `0600` under private `0700` directories;
- makes scorecard regeneration deterministic from the bound artifacts.

The M0 privacy collector is now available:

```bash
node scripts/report-privacy-rollout-evidence.mjs --backup-root=<private-backup-root>
node scripts/report-privacy-rollout-evidence.mjs --backup-root=<private-backup-root> --write --yes
```

It binds current source/config identity, complete project/global/raw-session and backup scan metadata, a scan fingerprint, a source-qualified candidate-set ID, permissions, and current human review records. The scorecard generator rejects missing, stale, mismatched, tampered, or expired privacy evidence and ignores the obsolete bare privacy counts.

The reviewed-gold collector is also available. It records one explicit human confirmation per current retrieval/save case, signs each review and the aggregate artifact with HMAC-SHA256, and binds the exact manifest, result set, source revision/configuration, pseudonymous reviewer identity, and review time. The signing key is local secret material: provide at least 32 bytes through `PI_REVIEWED_GOLD_SIGNING_KEY`; never write it to a file, command argument, review record, or artifact. Scorecard regeneration requires the same key while the artifact exists. The source fixture remains declared `synthetic-readiness`; qualification comes only from the separately signed artifact.

```bash
export PI_REVIEWED_GOLD_REVIEWER_ID=<local-reviewer-id>
read -rs PI_REVIEWED_GOLD_SIGNING_KEY && export PI_REVIEWED_GOLD_SIGNING_KEY
node scripts/review-reviewed-gold-evidence.js --case=<retrieval|save>:<case-id> --human-confirmed --write --yes
node scripts/report-reviewed-gold-evidence.js
node scripts/report-reviewed-gold-evidence.js --write --yes
```

Do not automate the per-case human-confirmation command. Curation and field collectors remain separate prerequisites; do not edit their numbers directly.

## 4. Reusable verification commands

### V1 — current scorecard identity and M0 controls

```bash
node - <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { currentMemorySourceEvidence, validateScorecardSource } = require('./src/memory-effectiveness-source');
const { projectMemoryRuntimeConfig } = require('./src/project-memory-runtime');
const card = JSON.parse(fs.readFileSync('.pi/memory-effectiveness/scorecard.json', 'utf8'));
const current = currentMemorySourceEvidence({ implementationRoot: process.cwd() });
assert.deepEqual(validateScorecardSource(card, current).reasons, []);
const runtime = projectMemoryRuntimeConfig(process.cwd(), process.env);
assert.equal(runtime.rollout.requestedStage, 'M0');
assert.equal(runtime.rollout.effectiveStage, 'M0');
assert.equal(runtime.rollout.controls.hermesCuration, false);
assert.equal(runtime.rollout.controls.automaticVerifiedUpserts, false);
console.log(JSON.stringify({ identity: 'PASS', decision: card.decision, highestAuthorizedStage: card.highestAuthorizedStage, effectiveStage: runtime.rollout.effectiveStage }));
NODE
```

### V2 — focused scorecard/runtime tests

```bash
node tests/memory-effectiveness.test.js
node tests/memory-effectiveness-e2e.test.js
node tests/memory-effectiveness-reviewed-gold.test.js
node tests/memory-effectiveness-report.test.js
node tests/project-memory-runtime.test.js
node tests/project-memory-readiness-consistency.test.js
node tests/project-memory-candidates.test.js
node tests/project-memory.test.js
node tests/project-memory-decisions.test.js
node tests/obsidian-adapter.test.js
node tests/hermes-readiness.test.js
node tests/hermes-client.test.js
```

### V3 — privacy and permission checks

In one Pi process, run:

```text
/privacy-scan --global
/privacy-review privacy_<each-current-handle>
```

Also invoke the Pi `privacy_guard` tool with:

```json
{
  "operation": "scan",
  "input": {
    "includeGlobal": true,
    "rawSessionPermissions": true,
    "write": false
  }
}
```

Acceptance bars:

- complete coverage and identity accounting;
- zero skipped or errored files;
- zero unresolved high-severity findings;
- every medium handle has a current human disposition;
- raw-session and managed-state permission violations are zero.

If retained remediation backups are part of the evidence scope, scan their private root explicitly and persist only a root fingerprint and aggregate counts.

### V4 — Hermes readiness only

```text
/obsidian-doctor --probe-auth --probe-curation
/obsidian-project-memory-status
```

A successful doctor probe is readiness evidence only. It does not count as a real fixture-vault curation attempt and does not authorize a rollout stage.

### V5 — scorecard regeneration

Run only after reviewed artifacts are bound:

```bash
node scripts/benchmark-project-memory.js
node scripts/report-memory-effectiveness.js --public
```

Then rerun V1–V3. While evidence collection is incomplete, `highestAuthorizedStage: M0` and `no-go-deferred` are expected and correct.

### V6 — final repository verification

```bash
git diff --check
```

Then invoke the Pi `gitverify` tool and require `Result: passed`. Do not push or publish as part of this checklist.

## 5. Seven blocked items

### A. `1.1.2.3.1` — Establish canonical authorization state

**Owners:** Harness maintainer, rollout owner, release verifier.

**Required evidence:**

- current source/config identity with zero freshness reasons;
- identity-bound privacy artifact and completed residual review;
- qualified reviewed-gold artifact;
- qualified real fixture-vault curation artifact;
- qualified exact-version field artifact;
- every fixed scorecard bar passing and gate-eligible;
- production still requested/effective M0 while authorization is evaluated.

**Minimum thresholds:** aggregate of sections B, D, and E below. No partial threshold unblocks this parent.

**Verification:** V1–V3, V5, and V6. Before stage activation, require a current scorecard whose decision is `ship`, highest authorized stage is `M5`, and `automaticBehaviorAuthorized` is true while the runtime remains requested/effective M0.

**Unblock condition:** all evidence is current and independently verified; no control has yet been enabled.

---

### B. `1.1.2.3.1.1.2` — Resolve only evidence/configuration gaps that can be proven

**Owners:** Privacy reviewer, gold-set reviewer, curation operator, experiment owner, harness maintainer.

**Required evidence and minimum thresholds:**

1. **Privacy**
   - zero unresolved high-severity findings;
   - all eight current medium handles reviewed by a human;
   - complete project/global/raw-session coverage with zero scan errors/skips;
   - explicit retained-backup scope remains clean;
   - current source/config and scan identity bound in the artifact.
2. **Reviewed gold**
   - all 12 cases reviewed: four retrieval and eight save cases;
   - exact reviewed manifest hash recorded;
   - relevant/forbidden retrieval outcomes and expected save outcomes personally checked;
   - a distinct reviewed artifact or reviewed manifest path; never relabel the existing synthetic-only fixture.
3. **Real curation**
   - at least 20 qualifying attempts;
   - `evidenceClass: real-fixture-vault-curation`;
   - `fixtureVault: true` provenance;
   - success rate at least 0.90;
   - timeout rate at most 0.10;
   - p95 duration at most 120,000 ms;
   - conflict-review evidence passes.
   - Count the existing four attempts only if their required provenance can be independently proven; otherwise collect 20 new qualifying attempts.
4. **Exact-version field cohort**
   - preregistered cohort ID;
   - source revision exactly equals the scored implementation;
   - at least 30 exact-version uses;
   - at least 10 independent sessions;
   - at least 14 observed days;
   - evidence coverage at least 90%;
   - automatic-save precision at least 0.98 from non-applying shadow decisions;
   - explicit-save precision at least 0.95;
   - current-fact stale rate exactly 0;
   - zero unresolved high-severity privacy/policy findings.

**Human-reviewed-gold worksheet command:**

```bash
node - <<'NODE'
const { loadJson, buildScorecard } = require('./src/memory-effectiveness');
const manifest = loadJson('tests/fixtures/memory-effectiveness/manifest.json');
const input = loadJson('.pi/memory-effectiveness/input.json');
const card = buildScorecard({ manifest, ...input });
console.log(JSON.stringify({ manifestHash: card.manifestHash, retrieval: card.aggregates.retrieval.cases, saves: card.aggregates.saves.cases }, null, 2));
NODE
```

This prints IDs and outcomes, not human approval. The reviewer must inspect each current case and result personally. After each inspection, record that one case; never generate confirmations in a loop:

```bash
export PI_REVIEWED_GOLD_REVIEWER_ID=<local-reviewer-id>
read -rs PI_REVIEWED_GOLD_SIGNING_KEY && export PI_REVIEWED_GOLD_SIGNING_KEY
node scripts/review-reviewed-gold-evidence.js --case=retrieval:<reviewed-case-id> --human-confirmed --write --yes
node scripts/review-reviewed-gold-evidence.js --case=save:<reviewed-case-id> --human-confirmed --write --yes
```

After all 12 reviews, preview and then write the aggregate artifact:

```bash
node scripts/report-reviewed-gold-evidence.js
node scripts/report-reviewed-gold-evidence.js --write --yes
```

Require `summary.reviewedCases: 12`, `summary.unresolvedCases: 0`, and `summary.qualified: true`. The private files are `.pi/memory-effectiveness/reviewed-gold-reviews.json` and `.pi/memory-effectiveness/reviewed-gold-evidence.json`, written with mode `0600` under a `0700` directory. The scorecard rejects direct `input.json.evidence` values and any missing-key, stale, future-dated, source/config-mismatched, manifest/result-mismatched, incomplete, or signature-invalid artifact.

For each privacy candidate, first resolve and inspect it locally in the same Pi process:

```text
/privacy-review privacy_<current-handle>
```

Then, only after actual human inspection, bind the disposition without storing the matched value or reviewer name:

```bash
export PI_PRIVACY_REVIEWER_ID=<local-reviewer-id>
node scripts/review-privacy-rollout-evidence.js --handle=privacy_<current-handle> --disposition=<false-positive-structured|retained-bounded|remediated> --human-confirmed --write --yes
```

Rerun the privacy collector after all reviews. Its `qualified` result must be true before privacy can pass.

**Experiment ledger check:**

```json
{
  "operation": "show",
  "experimentId": "exp-memory-learning-compounding-efficacy-field"
}
```

Record every measured gate verdict in that existing experiment. Do not open a replacement cohort or overwrite null results.

**Verification:** V1–V5.

**Unblock condition:** the evidence collector accepts every artifact, scorecard qualification flags are true, and the M0 invariant still passes.

---

### C. `1.1.2.3.2` — Enable rollout controls

**Owners:** Rollout owner and release verifier.

**Required evidence:** completed item A, a reviewed M4 canary plan, tested rollback to M0, and a separate reviewed M5 activation plan.

**Minimum thresholds:** no extra cohort number beyond A/B/D/E. Both child controls must pass independently.

**Verification:** V1–V6 plus the staged status checks in section 6.

**Unblock condition:** M4 curation is enabled and rolled back successfully, then M5 automatic upserts are enabled and verified. Never activate both for the first time in one step.

---

### D. `1.1.2.3.2.1.1` — Apply the canonical Hermes curation stage/configuration

**Owners:** Curation operator, rollout owner, release verifier.

**Required evidence:**

- privacy and reviewed-gold gates pass;
- 20 qualifying real fixture-vault curation attempts meet all B.3 bars;
- provider/model proof is current;
- conflict-review evidence passes;
- the M4 transition semantics are explicitly implemented/documented and covered by fail-closed tests;
- automatic-save opt-in remains `0`.

**Minimum thresholds:** 20 qualifying curation attempts; success ≥0.90; timeout ≤0.10; p95 ≤120,000 ms.

**Evidence-collection command at M0:**

```text
/obsidian-doctor --vault <fixture-vault> --probe-auth --probe-curation
/obsidian-hermes --vault <fixture-vault> --dry-run --topic "curation cohort <attempt-id>"
```

Each qualifying attempt must use a real bounded fixture vault and produce a metadata-only outcome record. The synthetic zero-vault doctor probe does not count.

**M4 canary:** only after item A is complete, start a controlled process with `PI_PROJECT_MEMORY_STAGE=M4` and `PI_PROJECT_MEMORY_AUTO_SAVE=0`, then run:

```text
/obsidian-project-memory-status
/obsidian-doctor --probe-auth --probe-curation
```

Require effective M4, Hermes curation ready, automatic verified upserts false, and no privacy regression. Then roll back to M0 and rerun the M0 invariant before considering M5.

**Verification:** V2–V6 plus explicit M4→M0 rollback evidence.

**Unblock condition:** one bounded M4 canary and rollback pass after the full curation cohort qualifies. The canary is operational verification, not a substitute for the 20-attempt cohort.

---

### E. `1.1.2.3.2.1.2` — Enable automatic verified upserts through the scorecard-authorized path

**Owners:** Experiment owner, rollout owner, release verifier, privacy reviewer.

**Required evidence:**

- fresh M5/`ship` scorecard and completed item D;
- B.4 exact-version cohort with all quality/privacy bars;
- candidate provenance, durable-tag, verification, forbidden-source, dedupe, conflict, rejection, and rollback checks pass;
- a dedicated bounded live canary driver exists. Unit tests alone are insufficient, and an explicit `memory_curator save` is not an automatic-upsert test.

**Minimum thresholds:** 30 uses, 10 sessions, 14 days, ≥0.98 automatic precision, ≥0.95 explicit precision, stale rate 0, zero unresolved high privacy findings.

**Pre-activation verification:** V1–V6 and:

```bash
node tests/project-memory-candidates.test.js
node tests/project-memory.test.js
node tests/project-memory-concurrency.test.js
node tests/project-memory-readiness-consistency.test.js
```

If no bounded live canary driver exists, the harness maintainer must implement and test it before activation. Do not improvise a production candidate.

**Activation:** in a controlled process only after every prerequisite passes, request M5 and set `PI_PROJECT_MEMORY_AUTO_SAVE=1`. Verify effective M5 and narrow verified-upsert behavior, then execute the reviewed rollback procedure and confirm M0 remains available.

**Unblock condition:** current runtime reports effective M5 and automatic verified upserts true, the bounded live positive/negative canaries pass, privacy remains clean, and rollback evidence is captured.

---

### F. `1.1.2.3.4` — Document and close

**Owners:** Release verifier and roadmap operator.

**Required evidence:**

- item C complete;
- final scorecard and runtime status;
- M4 and M5 activation/rollback evidence;
- privacy and permission scans;
- focused/full verification outcomes;
- residual risks and exact claim boundary;
- no secret values, transcripts, raw outputs, or absolute paths in the report.

**Minimum thresholds:** no additional cohort threshold; all prior bars and every final verifier must pass.

**Verification:** V1–V6, plus a privacy scan focused on the final report.

**Unblock condition:** the report describes observed behavior only and all referenced evidence is current.

---

### G. `1.1.2.3.4.1.2` — Complete rollout roadmap items only if evidence proves behavior

**Owners:** Roadmap operator with release-verifier approval.

**Required evidence:**

- all A–F acceptance conditions;
- live evidence for narrow verified upserts, provenance, dedupe/conflict, rejection, privacy, and rollback;
- current Git-aware verification;
- no open gate with fail, null, stale, mismatched, or insufficient-data status.

**Minimum thresholds:** all upstream thresholds; no separate numeric shortcut.

**Verification:** V1–V6 and final roadmap review.

**Unblock condition:** evidence proves production behavior. `allowUnsubstantiated` must not be used.

## 6. Exact roadmap resume order

Do not resume any blocked item while collecting evidence at M0. After all B evidence is bound and a fresh M5-eligible scorecard exists while runtime remains M0, use this exact order.

### Step 1 — resolve evidence leaf

```json
{"action":"set_status","itemId":"1.1.2.3.1.1.2","status":"active","note":"All required artifacts are current and under independent verification."}
```

Run V1–V6. If they pass:

```json
{"action":"set_status","itemId":"1.1.2.3.1.1.2","status":"done","note":"Privacy, reviewed-gold, real-curation, and exact-version field evidence are bound and qualified; runtime remains M0."}
```

### Step 2 — complete canonical authorization

```json
{"action":"set_status","itemId":"1.1.2.3.1","status":"done","note":"Current scorecard is M5-eligible/ship while production remains requested and effective M0."}
```

### Step 3 — run M4 curation canary and rollback

```json
{"action":"set_status","itemId":"1.1.2.3.2.1.1","status":"active","note":"Beginning reviewed M4 canary with automatic upserts off."}
```

After the M4 canary, privacy checks, and M4→M0 rollback pass:

```json
{"action":"set_status","itemId":"1.1.2.3.2.1.1","status":"done","note":"M4 Hermes curation canary and rollback passed; automatic verified upserts remained off."}
```

### Step 4 — run M5 automatic-upsert canary

```json
{"action":"set_status","itemId":"1.1.2.3.2.1.2","status":"active","note":"Beginning scorecard-authorized bounded M5 automatic-upsert canary."}
```

After positive, negative, privacy, provenance, and rollback checks pass:

```json
{"action":"set_status","itemId":"1.1.2.3.2.1.2","status":"done","note":"Bounded M5 verified-upsert canary and rollback verification passed."}
```

### Step 5 — complete control enablement milestone

```json
{"action":"set_status","itemId":"1.1.2.3.2","status":"done","note":"M4 and M5 controls were enabled sequentially through canonical gates and verified."}
```

### Step 6 — update final evidence report

Append final observed results and rerun V1–V6 plus the report privacy scan. Then:

```json
{"action":"set_status","itemId":"1.1.2.3.4.1.2","status":"done","note":"Current live evidence proves narrow verified behavior, privacy, provenance, dedupe/conflict, and rollback."}
```

### Step 7 — close documentation milestone

```json
{"action":"set_status","itemId":"1.1.2.3.4","status":"done","note":"Final rollout evidence and claim boundaries are documented and verified."}
```

### Step 8 — close the two parent roadmap items last

```json
{"action":"set_status","itemId":"1.1.2","status":"done","note":"Hermes curation and automatic verified upserts are canonically authorized and verified."}
```

```json
{"action":"set_status","itemId":"1","status":"done","note":"All rollout controls and evidence gates are complete."}
```

If any check fails or becomes stale, stop, return the affected item to `blocked`, restore M0/auto-save-off, and record the exact bounded failure evidence. Never skip forward in this sequence.
