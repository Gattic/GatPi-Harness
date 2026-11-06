# Pi Memory and Continuous-Learning Compounding Implementation Plan

> **Status:** Proposed from `docs/memory-and-learning-loop-architecture-comparison.md` and current source localization on 2026-07-31.
>
> **Execution note:** This is a program-level plan across `pi-harness` and, only if an evidence gate justifies it, the source-backed Pi fork at `~/pi`. Implement and verify one phase at a time. Do not execute Phases 0-7 as one change set, and do not raise any automatic rollout stage merely because deterministic tests pass.

**Goal:** Make the existing memory and learning systems form one visible, privacy-safe compounding path:

```text
explicit source or settled /loop|/goal execution
  -> normalized public outcome/evidence packet
  -> learning outcome and procedural capture
  -> governed candidate
  -> independent review and proof
  -> explicit routing/publishing approval
  -> bounded reuse
  -> exact-version outcome measurement
```

**Architectural rule:** Model-side reasoning remains canonical. The harness may persist public plans, typed actions, identifiers, hashes, bounded metrics, evidence references, decisions, and rollback records. It must not persist private reasoning, repeated prompts, raw assistant output, full transcripts, command arguments, raw tool output, secrets, or unrestricted local paths in learning captures.

**Canonical boundary:** Pi core and extensions consume cognitive libraries through `src/integration-boundary.js`. New extension code must use adapters exported there rather than importing new cognitive stores directly.

**Repository verification:** Focused harness tests run with `node tests/<name>.test.js`; the full harness gate is `bash scripts/check-all.sh`. Optional Pi fork work uses the scripts pinned in `~/pi/packages/coding-agent/package.json`: focused Vitest, package build/test, then harness fork setup and drift checks.

---

## 1. Claim Boundary and Current Baseline

The plan closes the nine gaps identified in the comparison as follows:

| Gap | Implementation phase | Required repository |
|---|---|---|
| Canonical vault readiness disagreement | Phase 1 | `pi-harness` |
| Skill trust conflated with empirical validation | Phase 2 | `pi-harness` |
| Loop taxonomy and missing outcome handoff | Phases 0 and 3 | `pi-harness` |
| No governed external skill-intake recipe | Phase 5 | `pi-harness` |
| `/loop` and `/goal` are not first-class learning captures | Phase 3 | `pi-harness` |
| `/goal` decisions and completion proof are weakly typed | Phase 4 | `pi-harness`; optional Pi API only after a gate |
| No recurring unified maintenance preview | Phase 6A | `pi-harness` |
| No unified provenance graph | Phase 6B | `pi-harness` |
| Compounding effectiveness is not measured | Phase 7 | `pi-harness` |

Point-in-time baseline that must remain visible in reports rather than being silently rewritten:

- canonical project-memory decision: `no-go-deferred`, highest authorized stage M0;
- deterministic memory checks pass, but field sessions/days are 0/0 and 102 high-severity privacy candidates remain unreviewed;
- 33 skills are labelled approved, but only four execution captures and no failure patterns were observed;
- 101 learning outcomes, three patterns, and three proposals exist;
- `parallel-evidence-synthesis` remains suggest-only because its live E3 cohort is still open.

### 1.1 Mandatory versus optional Pi work

No Pi-core change is required for Phases 0-7:

- `/loop` already receives `agent_settled` and can derive the stable assistant entry ID and stop reason from the read-only session branch.
- `/goal` already owns a stable goal ID and its exact terminal transition in `GoalRunner`.
- Both extensions can emit outcome packets at the transition they own without scanning transcripts or depending on event-order guesses.

Do **not** enrich `AgentSettledEvent` merely for this program. The existing branch facts are sufficient and already exercised by `.pi/extensions/automation-loop/index.ts`.

Pi currently has no extension API for invoking another registered tool directly. Phase 4 therefore ships typed, allowlisted goal intents using deterministic prompt-backed dispatch and labels that mode honestly. Section 12 defines a separate, evidence-gated Pi `ctx.invokeTool` proposal; it is not a dependency for the harness phases and must not be started without the stated field evidence.

---

## 2. Non-Negotiable Invariants

1. **One canonical memory selection.** Obsidian status, project-memory runtime, Memory Explorer, and Memory Curator use one vault-selection result and one project identity.
2. **Rollout truth is independent of filesystem readiness.** A writable vault does not raise M0, authorize automatic saves, or satisfy field evidence.
3. **Trust is multidimensional.** Source trust, schema validity, sandbox review, local verification, field evidence, routing approval, and publishing approval are separate facts.
4. **No prompt-to-learning leakage.** Outcome packets store a task hash and allowlisted workflow metadata, never the repeated `/loop` prompt or `/goal` controller text.
5. **Settlement is producer-owned and idempotent.** The extension that owns the terminal state writes one packet keyed by source kind, run ID, source-record hash, and terminal state.
6. **Canonical outcome vocabulary.** New packets reuse `src/outcome-schema.js`; no competing success/failure enum is introduced.
7. **Completion requires current proof.** A completed goal cites valid, passing Evidence Binder packets created for or after the goal run; confidence words and observation keywords are not proof.
8. **Intake is local, pinned, bounded, and read-only through review.** No always-on repository scout, arbitrary network fetch, dependency installation, push, publish, or hidden routing is added.
9. **Maintenance is preview-only by default.** Scheduled work may write a private metadata report; it may not change notes, delete state, or alter permissions.
10. **Provenance graphs contain references, not source bodies.** Nodes and edges carry IDs, hashes, status, timestamps, and bounded labels only.
11. **Approval remains a human action.** Model tools may prepare and review candidates but cannot silently approve routing, write executable skill topologies, or publish.
12. **Every rollout is reversible.** New schemas are additive, readers migrate old records in memory first, feature flags disable new behavior, and destructive migration is not part of this plan.

---

## 3. Target Contracts

### 3.1 Authoritative vault selection

Add one result shape returned by `src/obsidian-adapter.js` and consumed by `src/project-memory-runtime.js`:

```js
{
  schemaVersion: 1,
  projectKey: "pi:<name>:<root-hash>",
  selectionId: "vaultsel_<hash>",
  path: "/resolved/path",       // local runtime only; never copied into learning packets
  pathHash: "sha256:<hash>",
  source: "explicit|configured|discovered-single|default-managed|ambiguous|denied",
  configured: true,
  exists: true,
  marker: true,
  readable: true,
  writable: true,
  ambiguous: false,
  candidateCount: 1,
  reasons: []
}
```

Precedence is explicit argument, configured `PI_OBSIDIAN_VAULT`, exactly one valid discovered vault, then the managed default. An explicitly configured missing vault remains authoritative. Multiple discovered valid vaults without configuration fail closed as `ambiguous`; no writer guesses.

Readiness is layered and shared:

- `vaultFilesystem`: local Markdown readiness;
- `projectMemoryReads`: rollout plus vault readiness;
- `projectMemoryExplicitWrites`: rollout plus write readiness;
- `hermesCuration`: separate provider proof;
- `automaticBehaviorAuthorized`: scorecard decision only.

### 3.2 Settled execution outcome packet

Create schema v1 in `src/execution-outcome.js`:

```js
{
  schemaVersion: 1,
  packetId: "execout_<hash>",
  source: {
    kind: "automation-loop|goal",
    runId: "loop_...|goal_...",
    sourceSchemaVersion: 3,
    sourceRecordHash: "sha256:<hash>"
  },
  task: { hash: "sha256:<hash>", class: "implementation|verification|research|unknown" },
  outcome: "succeeded|domain-negative|blocked|not-applicable|cancelled|timed-out|infrastructure-failed|unknown",
  reasonCodes: ["maximum-iterations"],
  workflow: {
    steps: [{ index: 0, kind: "iteration|tool|checkpoint|typed-action", role: null, status: "succeeded" }],
    toolNames: ["verification_center"],
    retries: 0
  },
  evidenceRefs: ["evidence_..."],
  artifactRefs: [{ kind: "verification", id: "proof_...", hash: "sha256:<hash>" }],
  metrics: { iterations: 2, toolCalls: 4, toolErrors: 0, modelCalls: 2, durationMs: 1000 },
  provenance: { producerVersion: "...", projectKeyHash: "sha256:<hash>" },
  privacy: {
    promptStored: false,
    assistantOutputStored: false,
    transcriptStored: false,
    commandArgumentsStored: false,
    privateReasoningStored: false
  },
  settledAt: "..."
}
```

The validator recursively rejects forbidden fields such as `prompt`, `nextPrompt`, `rawHermesOutput`, `assistantText`, `transcript`, `reasoning`, `commandArgs`, and `toolOutput`; rejects absolute paths; bounds every list; and accepts only safe identifier/tool-name syntax.

### 3.3 Skill evidence and approval dimensions

Keep lifecycle `status` for backward compatibility, but add `evidenceState` and `approvals`:

```js
{
  evidenceState: {
    sourceTrust: { status: "trusted|reviewed|untrusted|unknown", sourceHash: "sha256:..." },
    schema: { status: "valid|invalid|unknown", schemaVersion: 2 },
    sandbox: { status: "passed|failed|not-run", evidenceIds: [] },
    localVerification: { status: "passed|failed|insufficient-data", captureCount: 0, evidenceIds: [] },
    field: { status: "field-proven|failed|insufficient-data", exactVersionUses: 0, observedDays: 0 }
  },
  approvals: {
    advisoryRetrieval: "allowed|blocked",
    routing: "approved|not-approved|revoked",
    publishing: "approved|not-approved|revoked"
  }
}
```

`approved` must never imply `field-proven`. Exact-version measurements use `(skillId, version, sourceHash)`; uses against another version do not count.

### 3.4 Goal decision v2

```json
{
  "schemaVersion": 2,
  "status": "running",
  "action": {
    "kind": "run_topology",
    "topologyId": "reviewer-verifier-gate",
    "inputRef": "goal_<id>"
  },
  "reasonCode": "verification-needed",
  "requiresUserInput": false,
  "completionEvidenceIds": []
}
```

Allowlisted actions are `run_topology`, `run_verifier`, `inspect`, `ask_user`, and `compat_prompt`. `compat_prompt` retains the current free-form path but is marked lower-authority in history and metrics. `completed` requires `action: null` and at least one current passing evidence ID.

### 3.5 Skill-intake manifest

The topology accepts a local staged source only:

```js
{
  schemaVersion: 1,
  intakeId: "intake_<id>",
  sourceUri: "https://example.invalid/repository",
  pinnedRevision: "<immutable revision>",
  contentHash: "sha256:<tree hash>",
  localRoot: ".pi/skill-intake/sources/<id>/<revision>",
  requestedSkillPaths: ["skills/example"],
  license: { spdx: "MIT", fileHash: "sha256:<hash>" }
}
```

No stage may fetch `sourceUri`; it is provenance metadata only. Missing pin, hash mismatch, symlink escape, path/size limit, unknown license, suspicious instructions, or dependency/supply-chain risk blocks candidate finalization.

### 3.6 Provenance graph

Use node types `evidence`, `execution`, `learning-outcome`, `capture`, `failure-pattern`, `skill-version`, `proposal`, and `memory-entry`. Use edge types `produced`, `supports`, `derived-from`, `evaluated-by`, `accepted`, `rejected`, and `supersedes`. Graph generation reads known bounded indexes only and never scans raw sessions or arbitrary repository files.

---

## 4. Phase 0 — Contracts, Loop Taxonomy, and Safe Packet Substrate

**Goal:** Establish shared vocabulary and a privacy-enforcing packet/store before wiring any automatic producer or consumer.

**Files:**

- Create: `src/execution-outcome.js`
- Modify: `src/outcome-schema.js`
- Modify: `src/integration-boundary.js`
- Create: `tests/execution-outcome.test.js`
- Create: `tests/outcome-schema.test.js`
- Modify: `tests/integration-boundary.test.js`
- Create: `docs/execution-learning-handoff.md`
- Modify: `docs/automation-loop.md`
- Modify: `docs/extension-portfolio/goal.md`
- Modify: `docs/self-improving-learning-loop.md`
- Modify: `docs/skill-synthesis.md`
- Modify: `docs/operational-model.md`

### Tasks

- [ ] Add `ExecutionOutcomeStore` with atomic private writes under `.pi/execution-outcomes/packets/` and an idempotent metadata-only JSONL index.
- [ ] Add `ExecutionOutcomeAdapter` to `src/integration-boundary.js`; extensions receive only this adapter, not direct store imports.
- [ ] Add canonical source-status mappings for loop and goal terminal states using `normalizeOutcome()`.
- [ ] Implement recursive field/path validation, list and text bounds, stable packet IDs, source-record hashing, and duplicate detection.
- [ ] Add pure builders for loop and goal fixtures, but do not register lifecycle hooks in this phase.
- [ ] Document the operator taxonomy: `/loop` is same-prompt execution, `/goal` is adaptive control, experiment loops are preregistered evaluations, and `learning_loop`/`skill_synthesis` are capability learning.
- [ ] Document the one handoff contract and identify project-memory promotion as a separate reviewed operation.

### Verification

```bash
node tests/execution-outcome.test.js
node tests/outcome-schema.test.js
node tests/integration-boundary.test.js
```

### Acceptance and stop conditions

- A packet containing any forbidden field, secret-like fixture, absolute path, or oversized collection is rejected before persistence.
- Replaying the same source record produces one packet/index row.
- Packet creation does not create a learning outcome, skill capture, or memory candidate yet.
- Rollback is additive: disable/remove the adapter and retain unread packet files for inspection; do not rewrite existing loop/goal state.

---

## 5. Phase 1 — Unified Canonical Vault Selection and Readiness

**Goal:** Make every memory surface choose and describe the same canonical vault without changing the authorized M0 rollout.

**Files:**

- Modify: `src/obsidian-adapter.js`
- Modify: `src/project-memory-runtime.js`
- Modify: `src/integration-boundary.js`
- Modify: `.pi/extensions/obsidian/index.ts`
- Modify: `.pi/extensions/memory-explorer/index.ts`
- Modify: `tests/obsidian-vault-selection.test.js`
- Modify: `tests/obsidian-readiness.test.js`
- Modify: `tests/obsidian-adapter.test.js`
- Modify: `tests/project-memory-runtime.test.js`
- Create: `tests/project-memory-readiness-consistency.test.js`
- Modify: `tests/memory-context-adapters.test.js`
- Modify: `docs/project-memory-operations.md`
- Modify: `docs/runtime-configuration.md`
- Modify: `docs/cognitive-memory-architecture.md`

### Tasks

- [ ] Export `resolveVaultSelection()` from `src/obsidian-adapter.js` and make all note/search/import/status paths use it.
- [ ] Replace `projectMemoryRuntimeConfig()`'s direct `resolveVaultPath()` check with that authoritative selection.
- [ ] Preserve the existing configured-vault precedence regression: a configured missing vault cannot redirect to a discovered real vault.
- [ ] Fail closed on ambiguous unconfigured discovery; report candidate count and remediation without selecting a writer.
- [ ] Add `selectionId`, `pathHash`, `projectKey`, and layered readiness to project-memory runtime status.
- [ ] Make `obsidian_status`, `obsidian_doctor`, `memory_explorer map`, `memory_curator status`, and project-memory recall return the same selection identity and readiness booleans.
- [ ] Add an integration fixture that performs an explicitly authorized save, confirms the managed canonical note, rebuilds/reads the same-decision cache, and recalls the entry.
- [ ] Keep full vault paths out of persisted readiness telemetry; use path hashes and safe reason codes.

### Migration and rollback

- Existing explicit `PI_OBSIDIAN_VAULT` behavior is unchanged.
- Unconfigured projects with one discovered vault begin reporting that vault consistently; they do not gain write authority.
- Unconfigured projects with several valid vaults become blocked until configured.
- Do not modify `docs/memory-effectiveness-scorecard.json`, the stored scorecard decision, or the requested/effective project-memory stage in this phase.
- A rollback restores the previous selector while leaving canonical note files untouched; no note migration is automatic.

### Verification

```bash
node tests/obsidian-vault-selection.test.js
node tests/obsidian-readiness.test.js
node tests/obsidian-adapter.test.js
node tests/project-memory-runtime.test.js
node tests/project-memory-readiness-consistency.test.js
node tests/memory-context-adapters.test.js
node tests/project-memory-policy.test.js
```

### Acceptance bar

For configured, single-discovered, missing, ambiguous, and denied fixtures, all four operator surfaces report the same `selectionId`, `projectKey`, and readiness. Explicit save/recall succeeds only when the fixture rollout authorizes it. Production M0 remains M0, and automatic behavior remains unauthorized.

---

## 6. Phase 2 — Skill Trust, Verification, Field Evidence, and Human Approval

**Goal:** Stop using one `approved` label as a proxy for source trust, local verification, field proof, routing, and publishing permission.

**Files:**

- Create: `src/skill-governance.js`
- Modify: `src/skill-synthesis.js`
- Modify: `src/skill-packs.js`
- Modify: `src/integration-boundary.js`
- Modify: `.pi/extensions/reasoning-runtime/index.ts`
- Create: `tests/skill-governance.test.js`
- Modify: `tests/skill-synthesis.test.js`
- Modify: `tests/skill-extension-source.test.js`
- Modify: `tests/skill-retrieval-benchmark.test.js`
- Modify: `tests/skill-performance.test.js`
- Modify: `docs/skill-synthesis.md`
- Modify: `docs/runtime-configuration.md`
- Modify: `docs/operational-model.md`

### Tasks

- [ ] Add schema-v2 skill governance normalization and in-memory migration for v1 records.
- [ ] Mark curated/native skills as source-trusted and schema-valid, but sandbox-not-run, locally insufficient, and not field-proven unless evidence exists.
- [ ] Mark synthesized skills with their exact capture count and evidence IDs; a successful fixture alone does not make them field-proven.
- [ ] Record every evaluation with `skillId`, `version`, source hash, capture/outcome ID, routing mode, result, evidence IDs, latency, tool/model calls, and privacy-safe task hash.
- [ ] Split `approve()` into explicit scopes: advisory retrieval, routing, and publishing. Publishing remains command/human-only.
- [ ] Add current-user intent authorization around model-tool operations that approve, import providers, or write a skill-derived topology. Keep inspection, suggestion, synthesis, and review available without mutation authority.
- [ ] Remove low-threshold implicit promotion (`minConfidence: 0.1`) from normal commands; show failed gate reasons instead.
- [ ] Keep explicit native `/skill:<name>` invocation available even when field evidence is insufficient, but label it explicit and do not count it as field proof until its exact-version outcome settles.
- [ ] Make `/skill-status`, `/skill-show`, `skill_synthesis status`, and metrics render every evidence/approval dimension.
- [ ] Preserve snapshots and rollback; include governance schema/version in exported packets.

### Migration and rollback

- Migrate on read and write v2 only when the skill is next changed; do not bulk rewrite the catalog.
- A legacy `approved` record maps to `approvals.advisoryRetrieval=allowed` and `routing=not-approved` unless a prior explicit routing approval can be proven.
- Keep a pre-migration skill snapshot before any bulk administrative migration.
- Feature flag `PI_SKILL_GOVERNANCE_V2=0` may restore legacy ranking during rollback, but status must still expose that legacy evidence is incomplete.

### Verification

```bash
node tests/skill-governance.test.js
node tests/skill-synthesis.test.js
node tests/skill-extension-source.test.js
node tests/skill-retrieval-benchmark.test.js
node tests/skill-performance.test.js
node tests/integration-boundary.test.js
```

### Acceptance bar

- Zero native, curated, imported, or synthesized skills become `field-proven` from migration or deterministic fixtures.
- Routing/publishing approvals are independently queryable and revocable.
- An untrusted, invalid, unsafe, or unverified imported skill cannot produce an executable topology.
- Existing retrieval benchmark precision stays at or above 0.80 and p95 behavior on the 500-skill fixture remains under the current 250 ms test bar.

---

## 7. Phase 3 — First-Class Settled `/loop` and `/goal` Outcome Capture

**Goal:** Emit one privacy-safe packet at the exact terminal transition and feed it idempotently to learning and skill evidence without auto-approval.

**Files:**

- Modify: `src/execution-outcome.js`
- Modify: `src/automation-loop.js`
- Modify: `.pi/extensions/automation-loop/index.ts`
- Modify: `.pi/extensions/goal/goal-runner.js`
- Modify: `.pi/extensions/goal/goal-store.js`
- Modify: `.pi/extensions/goal/index.ts`
- Modify: `src/learning-loop.js`
- Modify: `src/skill-synthesis.js`
- Modify: `src/integration-boundary.js`
- Modify: `.pi/extensions/learning-loop-coordinator/index.ts`
- Modify: `.pi/extensions/reasoning-runtime/index.ts`
- Modify: `tests/automation-loop.test.js`
- Modify: `tests/goal-store-runner.test.js`
- Modify: `tests/goal-extension-registration.test.js`
- Modify: `tests/learning-loop.test.js`
- Modify: `tests/learning-loop-coordinator.test.js`
- Modify: `tests/skill-synthesis.test.js`
- Create: `tests/settled-execution-handoff.test.js`
- Modify: `docs/execution-learning-handoff.md`
- Modify: `docs/runtime-configuration.md`

### Tasks

- [ ] In the automation-loop `agent_settled` handler, emit only after `store.save()` confirms `completed`, `max_iterations`, or an evidence-bearing instructive terminal/pause state.
- [ ] Use loop ID, prompt hash, assistant entry ID, state hash, checkpoint verdicts/evidence IDs, tool-name counts, retries/stalls, and bounded metrics. Never read or copy assistant text after completion detection.
- [ ] Add an `onFinalized` callback to `GoalRunner` and call it after the terminal goal state is saved. Do not infer goal completion from another extension's event ordering.
- [ ] Capture completed goals and instructive failed/blocked goals that executed at least one action or cite failure evidence. Ignore empty cancellation and untouched blocked records.
- [ ] Add `execution` to safe learning-ingest sources. Prefer packet ingestion over the legacy aggregate goal-state snapshot; retain legacy ingestion as compatibility-only and label it aggregate.
- [ ] Add a lazy `LearningLoopAdapter` to `src/integration-boundary.js` and move the coordinator's new packet-ingest path behind it, avoiding a top-level `learning-loop.js`/integration-boundary cycle.
- [ ] Have the learning coordinator drain the packet index at session start and `agent_end`; have the reasoning runtime drain it at session start and settlement. Consumers may lag one event, but correctness must not depend on extension registration order.
- [ ] Convert packet outcomes to `LearningStore.recordOutcome()` using task hashes, source/run IDs, evidence references, and canonical outcome status.
- [ ] Add `captureExecutionOutcome()` to the skill adapter. It builds an `ExecutionCapture` from allowlisted packet workflow/tool metadata only.
- [ ] Make capture and dispatch idempotent across reload, duplicate settlement, `agent_end`, and `agent_settled`.
- [ ] Set packet capture on by default after focused tests. Keep independent rollback flags: `PI_EXECUTION_OUTCOME_CAPTURE`, `PI_EXECUTION_OUTCOME_LEARNING`, and `PI_EXECUTION_OUTCOME_SKILLS`.
- [ ] Never auto-synthesize or approve a skill from a newly captured packet. Synthesis remains explicit/reviewed.
- [ ] Generate only a project-memory **candidate reference** when rollout candidate capture is authorized; never directly save a loop/goal summary.
- [ ] Change default goal final sync away from raw Hermes history. Keep legacy `PI_GOAL_SYNC_FINAL=1` as an explicit compatibility opt-in and document that it is not canonical memory.

### Verification

```bash
node tests/automation-loop.test.js
node tests/goal-store-runner.test.js
node tests/goal-extension-registration.test.js
node tests/execution-outcome.test.js
node tests/settled-execution-handoff.test.js
node tests/learning-loop.test.js
node tests/learning-loop-coordinator.test.js
node tests/skill-synthesis.test.js
```

### Acceptance bar

- Success, max-iteration, blocked-with-evidence, provider failure, empty cancellation, reload, and duplicate-settlement fixtures produce the expected zero-or-one packet.
- Serialized packets and downstream learning/skill records contain none of the source prompts, controller prompts, raw output fixtures, command arguments, secrets, or absolute paths.
- One packet creates at most one learning outcome and one skill capture after repeated ingestion.
- No resulting skill is approved, routed, published, or written into canonical memory automatically.

---

## 8. Phase 4 — Typed Goal Actions and Evidence-Backed Completion

**Goal:** Replace unconstrained controller decisions with an allowlisted action envelope while preserving a clearly labelled compatibility path.

**Files:**

- Create: `src/goal-controller-actions.js`
- Modify: `src/evidence-binder.js`
- Modify: `src/integration-boundary.js`
- Modify: `.pi/extensions/goal/goal-runner.js`
- Modify: `.pi/extensions/goal/goal-store.js`
- Modify: `.pi/extensions/goal/index.ts`
- Modify: `tests/goal-store-runner.test.js`
- Modify: `tests/goal-extension-registration.test.js`
- Create: `tests/goal-controller-actions.test.js`
- Modify: `tests/evidence-binder.test.js`
- Modify: `docs/extension-portfolio/goal.md`
- Modify: `docs/runtime-configuration.md`
- Modify: `docs/execution-learning-handoff.md`

### Tasks

- [ ] Version the controller response and validate action-specific required/forbidden fields.
- [ ] Translate legacy `{nextPrompt,...}` decisions to `compat_prompt` in memory; count and report them separately.
- [ ] Add deterministic prompt-backed dispatchers:
  - `run_topology`: allowlisted topology ID plus goal-state `inputRef`; reject automatic mutation-capable topology unless current user approval is present;
  - `run_verifier`: allowlisted `quick|changed|full` profile;
  - `inspect`: bounded target kind/reference with read-only wording;
  - `ask_user`: block the run and present a bounded question;
  - `compat_prompt`: current safety/policy checks and lower authority.
- [ ] Record the typed action, dispatch mode, action result code, evidence IDs, and latency. Persist raw Hermes output only in existing private diagnostic state, never in settled packets.
- [ ] Add a narrow `GoalEvidenceAdapter` to `src/integration-boundary.js`; goal extension code receives only ID-validation results and does not import Evidence Binder storage directly.
- [ ] Extend Evidence Binder validation to support `createdAt >= goal.createdAt`, registered fingerprint equality, and `ok=true` checks without returning evidence bodies.
- [ ] Require `completionEvidenceIds` for `completed`; reject stale, missing, mismatched, non-passing, or pre-goal packets.
- [ ] Remove `hasObjectiveCompletionEvidence()` keyword heuristics from the v2 path. Keep them only for legacy fixtures until compatibility removal.
- [ ] Add `/goal-plan` output that shows the typed action and its dispatch authority without executing it.
- [ ] Add metrics for action kind, compatibility use, dispatch mismatch, proof rejection reason, and extra controller turns.

### Migration and rollback

- Read both decision v1 and v2. New controller prompts request v2; malformed v2 gets one bounded repair attempt as today.
- `PI_GOAL_DECISION_V2=0` restores the legacy parser, but completed legacy goals still require Evidence Binder IDs once `PI_GOAL_REQUIRE_EVIDENCE_IDS=1` becomes the default.
- Prompt-backed typed dispatch remains honest: history and metrics say `dispatchMode=prompt-backed`, not direct tool execution.
- Do not begin optional Pi API work solely to remove that label.

### Verification

```bash
node tests/goal-controller-actions.test.js
node tests/goal-store-runner.test.js
node tests/goal-extension-registration.test.js
node tests/evidence-binder.test.js
node tests/settled-execution-handoff.test.js
```

### Acceptance bar

- Unknown actions and excess fields fail closed.
- A `completed` decision without a current passing evidence packet becomes blocked.
- A typed read-only action cannot select a mutating topology without explicit current-user approval.
- Legacy prompt use is visible and measurable; it cannot bypass proof requirements.

---

## 9. Phase 5 — Explicit `governed-skill-intake` Topology

**Goal:** Encode the useful discover/filter/read/extract/score/generate/review pipeline without adding autonomous discovery or publication.

**Files:**

- Create: `src/skill-intake.js`
- Modify: `src/role-result-schemas.js`
- Modify: `src/role-contracts.js`
- Modify: `src/role-topologies.js`
- Modify: `src/multi-agent-topologies.js`
- Modify: `src/integration-boundary.js`
- Modify: `.pi/extensions/reasoning-runtime/index.ts`
- Modify: `.pi/extensions/topology-catalog/index.ts`
- Create: `tests/skill-intake.test.js`
- Modify: `tests/multi-agent-topologies.test.js`
- Modify: `tests/topology-policy-conformance.test.js`
- Modify: `tests/topology-extension-source.test.js`
- Modify: `tests/skill-synthesis.test.js`
- Modify: `docs/multi-agent-topologies.md`
- Modify: `docs/topology-cookbook.md`
- Modify: `docs/skill-synthesis.md`
- Modify: `docs/runtime-configuration.md`

### Topology recipe

```text
manifest-validate (deterministic handler)
  -> deterministic-filter
  -> bounded-read (researcher)
  -> workflow-extract (researcher)
  -> objective-score (deterministic handler)
  -> candidate-generate (planner, output only)
  -> independent-review + security/privacy/license checks
  -> evidence-audit (all join)
  -> candidate-finalize (deterministic private state write only)
```

### Tasks

- [ ] Validate manifest schema, immutable revision, content/tree hash, license hash, local-root confinement, symlink safety, requested paths, maximum files, maximum bytes, and file types before any model node runs.
- [ ] Require sources to be staged under `.pi/skill-intake/sources/`; do not add `git clone`, HTTP, package installation, or repository search.
- [ ] Add deterministic suspicious-instruction and dependency/supply-chain findings. Unknown license or unresolved high-severity finding blocks finalization.
- [ ] Add `SkillIntakeAdapter` to `src/integration-boundary.js` and an injected topology `handlerRegistry` in `src/multi-agent-topologies.js`. Built-in intake nodes reference allowlisted `handlerId` values; they do not embed unserializable functions or bypass topology context/join policy.
- [ ] Add a handler-only `skill-intake-handler` role with zero model calls, no child tools, mutation forbidden, and stage-specific typed output. Runtime handlers receive bounded topology input/dependency projections and may write only the final private candidate packet.
- [ ] Use custom typed node output schemas for extracted workflow, objective score, candidate package, review decision, and final audit.
- [ ] Keep every model node `shared-readonly`, mutation forbidden, bounded context, and evidence-referenced.
- [ ] Use an `all` join for review/audit/finalization and `partialPolicy=forbid`.
- [ ] Mark topology metadata `explicitOnly: true`, `autoRoutePolicy: never`, `publishCapable: false`, and `sourceTrust: untrusted-until-reviewed`.
- [ ] Finalize only a private candidate packet under `.pi/skill-intake/candidates/`; importing it creates a skill `candidate` with source trust/review dimensions, never an approved or field-proven skill.
- [ ] Add explicit commands/tool operations to validate, run, and inspect intake. Do not register a publish/push operation.
- [ ] Ensure topology recommendation and automatic routing never select this recipe without explicit invocation.

### Verification

```bash
node tests/skill-intake.test.js
node tests/multi-agent-topologies.test.js
node tests/topology-policy-conformance.test.js
node tests/topology-extension-source.test.js
node tests/skill-synthesis.test.js
```

### Acceptance bar

- Valid local pinned fixtures reach candidate status with complete provenance.
- Hash drift, missing pin, symlink escape, oversized source, unsupported license, malicious instruction, dependency risk, failed reviewer, and partial join all fail closed.
- Parent working tree and staged source are byte-identical before/after review.
- No test or live invocation can publish, push, install dependencies, or approve routing.

---

## 10. Phase 6 — Recurring Maintenance Preview and Unified Provenance

### Phase 6A — One maintenance preview workflow

**Files:**

- Create: `src/memory-maintenance.js`
- Modify: `src/integration-boundary.js`
- Modify: `.pi/extensions/memory-explorer/index.ts`
- Create: `scripts/report-memory-maintenance.js`
- Create: `tests/memory-maintenance.test.js`
- Modify: `tests/memory-state-catalog.test.js`
- Modify: `tests/state-retention.test.js`
- Modify: `tests/managed-state-permissions.test.js`
- Modify: `docs/project-memory-operations.md`
- Modify: `docs/runtime-configuration.md`

**Tasks:**

- [x] Add `MemoryMaintenanceAdapter.preview()` that combines typed stale/conflict/supersession candidates, canonical review decisions, duplicate candidates, orphan evidence/backlinks, retention preview, permissions preview, and cache/source-decision consistency.
- [x] Read only known bounded state roots and indexes. Do not scan raw sessions, vault bodies, arbitrary home directories, or the full repository.
- [x] Write private reports under `.pi/memory-maintenance/previews/` with candidate IDs/hashes, counts, coverage, truncation, and source decision identity; omit source bodies and full paths.
- [x] Compare against the previous preview to report new, persistent, and resolved candidate IDs.
- [x] Add `memory_curator operation=maintenancePreview` and a command/script suitable for an external scheduler.
- [x] Keep scheduling opt-in with `PI_MEMORY_MAINTENANCE_PREVIEW_INTERVAL_HOURS`; default is `0`/off. A session-start timer may run at most once per configured interval and must be unreferenced/off-path.
- [x] Do not call retention apply, permission apply, project-memory save, note write, or delete from the scheduled path.

**Verification:**

```bash
node tests/memory-maintenance.test.js
node tests/memory-state-catalog.test.js
node tests/state-retention.test.js
node tests/managed-state-permissions.test.js
node scripts/report-memory-maintenance.js --preview
```

**Acceptance bar:** Repeated unchanged previews are stable; a resolved fixture moves from persistent to resolved; incomplete coverage is explicit; zero source files, notes, permissions, and retention candidates are mutated.

### Phase 6B — Read-only provenance graph

**Files:**

- Create: `src/provenance-graph.js`
- Modify: `src/integration-boundary.js`
- Modify: `.pi/extensions/memory-explorer/index.ts`
- Create: `tests/provenance-graph.test.js`
- Modify: `tests/memory-context-adapters.test.js`
- Modify: `docs/cognitive-memory-architecture.md`
- Modify: `docs/skill-synthesis.md`
- Modify: `docs/self-improving-learning-loop.md`

**Tasks:**

- [x] Build graph adapters for project-memory entries/decisions, settled execution packets, learning outcomes/proposals, skill captures/failure patterns/versions, and Evidence Binder packets.
- [x] Normalize IDs and edge types; preserve source-specific provenance rather than copying records into a second authority.
- [x] Bound by seed IDs, depth, node count, edge count, per-store tail limits, and elapsed time. Report truncation and unavailable providers.
- [x] Add dangling-edge, conflicting-support, rejected/superseded, and exact-version lineage diagnostics.
- [x] Expose `memory_explorer operation=provenance` and `operation=lineage` enhancement; keep the graph read-only and metadata-only.
- [x] Export only with explicit user request to a private file.

**Verification:**

```bash
node tests/provenance-graph.test.js
node tests/memory-context-adapters.test.js
node tests/execution-outcome.test.js
node tests/skill-synthesis.test.js
node tests/learning-loop.test.js
```

**Acceptance bar:** A synthetic end-to-end chain answers which evidence supported a skill/memory fact, which run produced it, which proposal accepted/rejected it, and what superseded it. The graph contains no prompt, transcript, reasoning, command argument, raw tool output, secret, or absolute path fields.

---

## 11. Phase 7 — Compounding Scorecard, Field Experiments, and Rollout

**Goal:** Measure whether later work improves; do not use inventory growth as a success proxy.

**Files:**

- Create: `src/compounding-effectiveness.js`
- Create: `scripts/report-compounding-effectiveness.js`
- Create: `tests/compounding-effectiveness.test.js`
- Modify: `src/skill-synthesis.js`
- Modify: `src/learning-loop.js`
- Modify: `src/execution-outcome.js`
- Modify: `src/memory-maintenance.js`
- Modify: `.pi/extensions/reasoning-runtime/index.ts`
- Modify: `.pi/extensions/learning-loop-coordinator/index.ts`
- Create: `docs/compounding-effectiveness-scorecard.md`
- Modify: `docs/operational-model.md`
- Modify: `docs/self-improving-learning-loop.md`
- Modify: `docs/runtime-configuration.md`

### Metrics

Track at least:

- verified captures per skill and exact skill version;
- accepted/rejected uses by source provenance, source hash, version, and routing mode;
- failure-pattern discovery, later match, mitigation reuse, and post-mitigation result;
- learning outcome -> pattern -> proposal -> approved -> applied -> field-proven conversion;
- evidence coverage and unsupported-claim rate;
- canonical recall precision, stale rate, and cross-project contamination from the existing memory scorecard;
- p50/p95 model calls, duration, tool calls, and context added for packet, goal action, intake, and maintenance stages;
- maintenance candidates new, persistent, resolved, applied, and ignored;
- privacy rejections and provenance dangling-edge rate.

### Tasks

- [x] Generate a private scorecard under `.pi/learning-loop/scorecards/`; public docs contain schema/bars, not task bodies or local paths.
- [x] Distinguish deterministic, synthetic, migration, exact-version field, and user-reviewed-gold evidence classes.
- [x] Refuse to compute success deltas when control/candidate cohorts or exact-version IDs are absent.
- [x] Pre-register a new experiment before any field cohort. Record hypothesis, arms, bars, run IDs, commit IDs, GPU-hours when relevant, and every PASS/FAIL/NULL verdict in `experiment_ledger`.
- [x] Keep the existing `parallel-evidence-synthesis` experiment separate and suggest-only until its own E3 passes.
- [x] Add dashboards/status output that says `insufficient-data` rather than zero or pass when field evidence is missing.

### Pre-registered rollout gates

| Gate | Required evidence | Bar | Effect of pass |
|---|---|---|---|
| C0 contract/privacy | deterministic fixtures | 0 forbidden fields, secrets, absolute paths, duplicate packets, or invalid provenance edges | packet capture may ship shadow-only |
| C1 cross-surface integration | fixture + local smoke | 100% vault-selection agreement; 100% packet handoff idempotence; no automatic memory write | learning dispatch may enable locally |
| C2 shadow cohort | at least 20 settled loop/goal packets | 0 privacy violations; >=90% evidence-link validity; <=5% classification corrections | skill captures may be included in explicit synthesis |
| C3 exact-version skill cohort | at least 30 exact-version uses across at least 10 independent sessions and 14 days | >=90% evidence coverage; no unresolved high-severity policy/privacy finding; lower-bound quality non-regression versus control | mark that exact version field-proven after review |
| C4 maintenance cohort | at least 4 preview cycles across at least 14 days | 0 mutations from scheduler; stable candidate IDs; resolution accounting >=95% | retain scheduled preview; still no automatic apply |
| C5 compounding efficacy | preregistered control/candidate comparison | improved verified-success or reduced unsupported-claim rate without p95 cost/latency bar breach | candidate for human-reviewed routing change |

No gate authorizes automatic publishing, push, project-memory stage promotion, retention apply, permission apply, or unbounded source discovery.

### Implementation outcome — 2026-07-31

The scorecard implementation is complete and the experiment remains pre-registered without a field run. The latest private report is `compound_2f9d55d17dddb591e532681d`: C0-C5 and the cohort comparison are `insufficient-data`, the decision is `no-go-deferred`, and project memory remains M0. This is the expected gate result before exact-version field cohorts and reviewed policy evidence exist; it is not a failed rollout and does not authorize automatic behavior.

### Verification

```bash
node tests/compounding-effectiveness.test.js
node tests/skill-synthesis.test.js
node tests/learning-loop.test.js
node tests/memory-effectiveness.test.js
node tests/memory-effectiveness-e2e.test.js
bash scripts/check-all.sh
```

### Rollback

- Feature flags return packet dispatch, goal decision v2, skill governance v2 ranking, maintenance schedule, and intake registration to off/legacy modes independently.
- Preserve scorecards and packets as private evidence; do not delete negative outcomes.
- Revoke routing approvals by exact version/source hash, not by mutable skill name.
- Restore skill snapshots or retention manifests only through existing explicit rollback operations.

---

## 12. Optional Pi Core/API Track — Only After a Field Gate

**Current decision:** deferred; no Pi changes are needed for settled capture.

Open a separate upstream design only if at least 20 typed goal actions show either:

- more than 5% prompt-backed dispatch mismatch, or
- a material preregistered latency/model-call regression attributable to the extra dispatch turn.

The proposed API would be a narrow, policy-preserving extension-context action, not a generic registry escape hatch:

```ts
await ctx.invokeTool(name, input, {
  signal,
  source: "extension",
  requireActive: true
});
```

**Potential Pi files, only after the gate:**

- Modify: `~/pi/packages/coding-agent/src/core/extensions/types.ts`
- Modify: `~/pi/packages/coding-agent/src/core/extensions/runner.ts`
- Modify: `~/pi/packages/coding-agent/src/core/agent-session.ts`
- Modify: `~/pi/packages/coding-agent/docs/extensions.md`
- Modify: `~/pi/packages/coding-agent/test/extensions-runner.test.ts`
- Create: `~/pi/packages/coding-agent/test/suite/regressions/extension-invoke-tool-policy.test.ts`

Required semantics:

- only currently registered and active tools;
- normal input schema validation;
- normal `tool_call`, `tool_result`, `tool_execution_*`, cancellation, policy, error, and accounting paths;
- no invocation while unsafe/reentrant streaming state is active;
- caller identity/source in public metadata;
- no implicit model turn, session transcript copy, or bypass of project trust;
- harness initially permits only read-only typed goal actions through this API.

After a Pi release contains the API, feature-detect it in `.pi/extensions/goal/index.ts`; retain prompt-backed fallback until a separate compatibility-removal decision. Do not change `AgentSettledEvent` unless a new, independently reproduced failure proves branch-derived settlement identity is insufficient.

---

## 13. Dependency Order and Change-Set Boundaries

```text
Phase 0 packet contract
  ├─> Phase 1 vault consistency
  ├─> Phase 2 skill governance
  └─> Phase 3 settled handoff
          └─> Phase 4 typed goal actions/proof

Phase 2 + topology runtime
  └─> Phase 5 governed skill intake

Phases 0-5
  └─> Phase 6A maintenance preview
  └─> Phase 6B provenance graph
          └─> Phase 7 scorecard and field rollout
```

Use one reviewed change set per phase or smaller subphase. Pair source and focused tests in the same change set. Documentation for a behavior changes with that behavior, not at the end of the entire program. Do not mix optional Pi work with a harness phase.

Before each mutating phase:

1. inspect the current roadmap and create a phase subroadmap;
2. record baseline status/scorecards and relevant feature flags;
3. use `safe_try` before risky migrations;
4. open `debug_ledger` threads for reproduced defects;
5. pre-register experiments before field runs;
6. verify focused tests, inspect the diff, then run `bash scripts/check-all.sh` before handoff or commit.

---

## 14. Program Completion Criteria

The program is complete only when all of the following are evidenced:

- [ ] All memory surfaces agree on one project key, vault selection, and layered readiness, while production rollout remains at its evidence-authorized stage.
- [ ] Skill status exposes source trust, schema, sandbox, local verification, exact-version field proof, routing approval, and publishing approval separately.
- [ ] `/loop` and `/goal` terminal transitions create idempotent, privacy-valid packets and downstream learning/skill records without prompt or transcript leakage.
- [ ] Goal v2 rejects unknown actions and completion without current passing evidence IDs.
- [ ] `governed-skill-intake` accepts only pinned local manifests, remains read-only through review, and ends at candidate status.
- [ ] Maintenance can run repeatedly in preview mode with stable new/persistent/resolved accounting and zero mutations.
- [ ] The provenance graph traces evidence -> execution -> outcome/capture -> proposal/skill/memory and preserves rejection/supersession.
- [ ] The compounding scorecard reports exact-version field evidence and `insufficient-data` honestly.
- [ ] No automatic publish, push, stage promotion, retention apply, permission apply, or unbounded discovery path exists.
- [ ] `parallel-evidence-synthesis` remains suggest-only until its existing E3 is closed independently.
- [ ] Focused tests and `bash scripts/check-all.sh` pass for the final phase, and the final diff contains only intended source, tests, and documentation.
