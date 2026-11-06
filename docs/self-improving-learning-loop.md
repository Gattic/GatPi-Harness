# Pi/Hermes self-improving learning loop architecture

Date: 2026-05-21
Repo: `~/GatPi-Harness`
Status: implemented architecture and operating model

This document is the durable architecture and operations record for the reviewed Pi/Hermes learning loop. It explains why the loop exists, what invariants it must preserve, which components implement it, how operators should use it, and which future changes remain intentionally advisory. It is no longer a one-off implementation plan; keep it current when the learning-loop contract, command surface, state model, or safety policy changes.

## Operating constraints

The learning loop must follow the existing Pi/Hermes contract:

- **Model-side reasoning remains canonical.** Pi stores public scaffolds, evidence, decisions, and summaries; it must not simulate or expose private reasoning.
- **Hermes is advisory only.** It receives bounded typed packets, returns typed suggestions with metadata-only receipts, and owns no durable memory, recall, approval, or mutation authority.
- **Hot-path behavior stays fast.** Learning ingestion/proposal generation must not block `before_agent_start` or prompt submission.
- **Changes are reviewed.** The loop may observe and propose automatically, but code/config/prompt/skill mutations require approval plus verifier evidence.
- **Everything is local-first and reversible.** Store proposal ledgers, checkpoints, rollback metadata, and evidence refs under `.pi/`.
- **Use the integration boundary.** New libraries/extensions should consume existing subsystems through `src/integration-boundary.js` and public libraries, not scattered internals.

## Historical motivation and baseline review

### Existing strengths

Pi already has most low-level primitives for adaptation:

- Durable memory and recall: canonical Obsidian project memory, cognitive memory, layered context, memory curator/explorer.
- Reasoning scaffolding: model-side reasoning runtime with plan/decomposition/evidence artifacts.
- Execution learning: skill synthesis, topology runs, branch-backed subagents, autonomous goal runner.
- Verification and proof: Verification Center, Evidence Binder, Test Gap Planner, semantic patch workbench.
- Observability: trace observability, runtime doctor, performance optimizer.
- Governance: policy gate/enforcer, privacy guard, extension ops center.

### Evidence collected during review

- Extension inventory found **24 extensions**, **233 commands**, **22 model-callable tools**, and **0 command/tool conflicts**.
- Runtime Doctor reported a clean git tree during review, project/global extension inventory, about **57.8 MB trace state**, about **19.7 MB cognitive state**, and a slow `agent_end` event.
- Performance Optimizer saw about **5000 trace events**, provider response timings averaging roughly **1.55s** in sampled data, and one large `agent_end` duration outlier.
- Skill synthesis metrics showed **27 approved skills**, only **2 captures**, and **0 failure patterns**.
- Topology metrics showed **2 succeeded topology runs** and no recorded topology failures/tool denials.

### Original gap

The review found that the harness observed a lot, but did not yet reliably answer:

> What did this session teach Pi, and what should Pi safely change next?

The implemented learning loop closes that gap by normalizing outcomes, mining repeated success/failure patterns, creating explicit proposals, and routing those proposals through review, policy, privacy, semantic patching, verification, and feedback records.

Since 2026-07-11, `src/session-miner.js` also provides the recurring evidence source that the original one-off Claude/Codex/Pi corpus studies lacked. It incrementally scans the three agent session roots, persists aggregate-only reports under `.pi/session-mining/`, converts stable candidates into redacted learning outcomes, and uses later scans to measure candidate/adoption trends. See `docs/session-mining-loop.md`.

## Capability map

The original roadmap is now implemented as a single reviewed learning-loop capability with explicit, review-gated subfunctions:

1. **Learning Loop Coordinator — implemented**
   - Central dashboard and proposal queue in `.pi/extensions/learning-loop-coordinator/index.ts`.
   - Reads compact public artifacts from verification, topology, skill, trace, Evidence Binder, settled execution, legacy aggregate goal, runtime/perf, memory, policy, and privacy sources.
   - Explicitly scans aggregate-only Claude/Codex/Pi session evidence through `/learning-scan-sessions` or `learning_loop operation=sessionScan`.
   - Produces reviewed proposals for skills, tests, prompts, and config.

2. **Outcome Rater — implemented**
   - `outcomeRater()` and `/learning-rate-outcome` normalize and score evidence-backed outcome packets.
   - Labels include verified success, failed verification, latency risk, missing test, policy block, privacy risk, and user correction.

3. **Failure Pattern Miner — implemented**
   - `mineFailurePatterns()` and `/learning-patterns --failures` persist repeated or severe failure patterns to `patterns.jsonl`.

4. **Context Attribution Optimizer — advisory implemented**
   - `/learning-context-attribution` summarizes whether Hermes advisory/cognitive/skill/topology/verification context correlates with success or failure.

5. **Experiment Runner — advisory implemented**
   - `/learning-experiment` creates branch/topology experiment plans and can capture benchmark evidence. Deeper automatic A/B execution remains gated on sufficient reviewed outcomes.

6. **Self-Benchmark Suite — implemented**
   - `/learning-benchmark` and Verification Center profile `learning` run or plan repeatable learning-loop checks.

7. **Patch Proposer — implemented, review-gated**
   - `/learning-refactor-propose` writes dry-run `edit`/`ast_refactor` proposal packets without applying source changes.

8. **Adaptive Model Router — advisory implemented**
   - `/learning-model-router` recommends task-type thinking/tool presets with minimum-evidence/readiness thresholds. It never changes routing automatically.

## Architecture and operating model

### Library and extension shape

Library:

```text
src/learning-loop.js
```

Extension:

```text
.pi/extensions/learning-loop-coordinator/index.ts
```

Runtime state:

```text
.pi/learning-loop/
  outcomes.jsonl
  proposals/
    <proposal-id>.json
  decisions.jsonl
  patterns.jsonl
  experiments/
  exports/
```

The library is deterministic and testable without Pi. The extension is the Pi hook/command adapter and must keep storage relative to the target repository `cwd` while resolving library imports through the extension install root.

### Command surface

```text
/learning-status
/learning-ingest [verification|topology|skill|trace|evidence|execution|goal|runtime|memory|policy|privacy|all]
/learning-scan-sessions [--since-days=N] [--full] [--no-record]
/learning-session-report
/learning-outcomes [--limit=N] [--kind=...]
/learning-rate-outcome <json-or-summary>
/learning-patterns [--mine] [--failures] [--min=N]
/learning-propose [--kind=skill|test|prompt|config|all]
/learning-inbox [--status=draft|ready|approved|applied|dismissed]
/learning-show <proposal-id|latest>
/learning-review <proposal-id|latest>
/learning-approve <proposal-id|latest>
/learning-dismiss <proposal-id|latest> [reason]
/learning-apply <proposal-id|latest> [--dry-run|--record-applied --evidence=id,id]
/learning-verify <proposal-id|latest>
/learning-benchmark [--run]
/learning-context-attribution
/learning-model-router
/learning-experiment <proposal-id|latest>
/learning-refactor-propose <proposal-id|latest>
/learning-memory-summary <proposal-id|latest>
/learning-export [file]
/learning-doctor
```

Model-callable tool:

```text
learning_loop
```

Operations:

```text
status, ingest, sessionScan, sessionReport, outcomes, rateOutcome, patterns, minePatterns, propose, inbox, show, review, approve, dismiss, apply, verify, benchmark, contextAttribution, modelRouter, experiment, patchPropose, memorySummary, export, doctor
```

Proposal generation, approval, and apply remain manual/explicit. Privacy-safe execution packets drain idempotently at session start and `agent_end` by default; other optional aggregate ingestion can run after `agent_end`. None of these paths runs proposal generation or apply on the prompt hot path.

## Data model

### Outcome packet

Each outcome should be small, public, redacted, and evidence-linked:

```json
{
  "outcomeId": "outcome_...",
  "createdAt": "2026-05-21T00:00:00.000Z",
  "source": "execution|topology|goal|verification|manual",
  "task": {
    "summary": "short task summary",
    "repo": "sha256:<project-key-hash for execution packets; legacy sources may be redacted>",
    "sessionId": "optional",
    "traceCorrelationId": "optional"
  },
  "signals": {
    "status": "succeeded|failed|blocked|unknown",
    "evidenceLevel": "none|claim|tool-output|verification|full-check",
    "verificationOk": true,
    "commands": ["bash scripts/check-all.sh"],
    "toolErrors": 0,
    "policyBlocks": 0,
    "privacyFindings": 0,
    "latencyMs": 0,
    "stateGrowthBytes": 0,
    "userCorrectionDetected": false
  },
  "artifacts": {
    "traceRefs": [],
    "evidenceRefs": [],
    "reasoningArtifactIds": [],
    "topologyRunIds": [],
    "skillIds": [],
    "changedFiles": []
  },
  "classifications": ["verified-success", "missing-test", "latency-risk"],
  "summary": "What happened and why it matters.",
  "privacy": {
    "redacted": true,
    "containsTranscript": false,
    "containsSecret": false
  }
}
```

### Proposal packet

Proposals are reviewable artifacts, not direct mutations:

```json
{
  "proposalId": "proposal_...",
  "createdAt": "2026-05-21T00:00:00.000Z",
  "kind": "skill|test|prompt|config",
  "status": "draft|ready_for_review|approved|applied|dismissed|superseded",
  "title": "Short proposal title",
  "problemStatement": "Evidence-backed problem or opportunity.",
  "evidenceRefs": ["outcome_...", "proof_...", "trace:..."],
  "affectedFiles": [],
  "suggestedChange": {
    "summary": "What should change.",
    "patchPlan": [],
    "skillDraft": null,
    "testDraft": null,
    "promptDraft": null,
    "configDraft": null
  },
  "expectedBenefit": {
    "quality": "high|medium|low",
    "latency": "high|medium|low|none",
    "safety": "high|medium|low|none"
  },
  "risk": {
    "level": "low|medium|high",
    "reasons": [],
    "requiresUserApproval": true
  },
  "reviewChecklist": [
    "Evidence supports the problem statement",
    "No secrets or full transcripts are included",
    "Change is reversible",
    "Verification plan is sufficient"
  ],
  "applicationPlan": {
    "mode": "manual|ast_refactor|skill_synthesis|config_write",
    "rollback": "checkpoint or restore path"
  },
  "verificationPlan": {
    "commands": [],
    "evidenceRequired": ["targeted check", "claim-check"]
  },
  "review": {
    "reviewedBy": null,
    "approvedAt": null,
    "notes": []
  }
}
```

## Pipeline

### 1. Ingest public artifacts

Inputs:

- Privacy-safe aggregate reports from `~/.claude/projects`, `~/.codex/sessions`, and `~/.pi/agent/sessions` via `src/session-miner.js` (explicit only; no transcript persistence).
- Trace observability JSONL and trace runtime summaries.
- Verification Center latest evidence.
- Evidence Binder proof packets and claim checks.
- Skill synthesis captures/metrics/evaluations.
- Topology run packets and topology metrics.
- Goal state/history summaries.
- Runtime Doctor and Performance Optimizer reports.
- Memory Curator promote/forget candidates.
- Policy/Privacy findings.

Rules:

- Read only summaries, IDs, hashes, command names, timestamps, small redacted snippets.
- Never copy full transcripts into outcomes.
- Ingestion can run on command or off the hot path after `agent_end`.

### 2. Normalize and rate outcomes

`outcome-rater` assigns:

- `status`: succeeded, failed, blocked, unknown.
- `evidenceLevel`: none, claim, tool-output, verification, full-check.
- `qualityScore`: combines verification, evidence, retry depth, tool failures, and user correction.
- `learningValue`: high when an outcome has repeated pattern potential, new failure mode, or strong reusable workflow evidence.

Suggested scoring baseline:

```text
full-check evidence:      +1.00
verification command:     +0.85
tool/file evidence:       +0.60
assistant claim only:     +0.20
no evidence:              +0.00
policy/privacy issue:     cap at 0.50 until reviewed
tool/verifier failure:    subtract by severity
user correction:          mark learningValue high
```

### 3. Mine patterns

Pattern classes:

- repeated verified-success workflow
- repeated verifier failure
- missing or weak test evidence
- stale/noisy memory injection
- policy block or unsafe autonomous action
- output verbosity/context bloat
- latency regression
- prompt instruction failure
- topology/skill underperformance

Patterns should require either:

- at least 2 similar outcomes, or
- 1 severe outcome with high evidence and low ambiguity.

### 4. Generate proposal candidates

#### Skill proposals

Create when:

- a successful workflow repeats with verification evidence;
- a failed workflow has a reusable mitigation;
- a native/synthesized skill has repeated good or bad outcome labels.

Actions:

- create a candidate skill;
- update skill evaluation confidence;
- create a failure pattern entry;
- suggest a skill-derived topology only after review.

#### Test proposals

Create when:

- fixes succeed without a focused test;
- repeated bugs touch the same area;
- Test Gap Planner identifies changed files with weak test mapping;
- verifier evidence relies only on broad smoke checks.

Actions:

- propose test skeletons;
- attach changed files and likely test commands;
- optionally create semantic patch packets after approval.

#### Prompt proposals

Create when:

- completion claims lack evidence;
- the agent repeatedly overuses verbose JSON/tool outputs;
- the model ignores existing tools/workflows;
- prompt/context injection includes stale or noisy guidance.

Actions:

- propose changes to prompt templates, tool guidelines, or docs;
- require self-benchmark and privacy/policy review before apply.

#### Config proposals

Create when:

- Runtime Doctor/Performance Optimizer finds blocking or expensive defaults;
- trace/cognitive state grows past policy thresholds;
- privacy settings are risky;
- a project needs verifier/topology defaults.

Actions:

- write recommended settings to a review file first;
- apply only after approval;
- verify via Runtime Doctor and targeted smoke tests.

### 5. Review gate

Every proposal must pass:

1. **Evidence review**: Evidence Binder confirms the proposal references supporting outcomes/proofs.
2. **Privacy review**: Privacy Guard confirms no secrets/full transcripts.
3. **Policy review**: Policy Gate checks paths, shell commands, tool grants, unsafe topology/skill changes.
4. **Impact review**: Test Gap Planner maps affected files to tests.
5. **Human or explicit approval**: `/learning-approve <id>`.

High-risk proposals require manual approval even if all automated checks pass:

- prompt/system behavior changes;
- auto-execution/config changes;
- safety-policy changes;
- memory deletion;
- executable topology/skill approval;
- provider/model routing changes.

### 6. Apply through existing safe mechanisms

Preferred application path by kind:

| Kind | Apply mechanism | Required verification |
| --- | --- | --- |
| skill | `skill_synthesis` candidate/approve flow | skill doctor + optional A/B score |
| test | `edit`/`ast_refactor` or Test Gap Planner skeleton | targeted test + changed/full verify as needed |
| prompt | semantic patch to prompt/doc/template | self-benchmark + prompt policy tests |
| config | reviewed `.pi` config or safe-env recommendation | runtime doctor/perf compare + smoke |

No proposal should edit files directly from the learning loop. Use semantic patch/checkpoint workflows where files change.

### 7. Verify and bind evidence

After apply:

- run the proposal `verificationPlan`;
- capture Verification Center evidence;
- run Evidence Binder claim check;
- update proposal status to `applied` only with supporting evidence;
- submit a concise candidate to governed canonical project-memory review only for durable facts.

### 8. Feedback into learning state

After verification:

- create a new outcome packet for the proposal application;
- update skill confidence/effectiveness;
- update failure patterns;
- record dismissed or failed proposals as negative examples;
- schedule memory curator review for durable architecture/procedural facts.

## Integration with existing extensions

### Verification Center

Used to plan/run proof commands and persist verifier evidence.

### Evidence Binder

Used to bind proposal claims to evidence and reject unsupported completion claims.

### Skill Synthesis

Receives successful workflow captures, failed workflow patterns, candidate skills, evaluations, and approved topology templates.

### Test Gap Planner

Maps proposal affected files to missing tests and suggests skeletons.

### Edit and AST Refactor

Approved test/prompt/config edits use localized `edit` or reviewed `ast_refactor` preview/apply. Broad refactors retain rollback checkpoints under `.pi/ast-refactor/`.

### Runtime Doctor / Performance Optimizer

Provide config and latency proposal signals. Verify that applied config improves or at least does not regress runtime behavior.

### Memory Curator / Hermes advisory

Promote only stable summary facts after verification through canonical project-memory review. Hermes may draft scanner-approved unverified candidates from bounded extracts, but it never receives raw outcome payloads or transcripts and never promotes memory.

### Policy Gate / Policy Enforcer / Privacy Guard

Reject unsafe proposal applications, secret-bearing payloads, full transcript storage, and unapproved auto-execution config.

### Topologies and Subagents

Use isolated branch-backed execution for experiments, proposal review, and optional reviewer/verifier gates.

## Safety and privacy rules

- Store hashes/IDs/summaries, not full traces or transcripts.
- Redact shell outputs before storing outcome summaries.
- Never auto-approve a skill, prompt, topology, policy, or config change.
- Treat prompt/system changes as high-risk.
- Treat model routing changes as advisory until enough evidence exists.
- Keep all deletes preview-only unless a dedicated explicit approval path exists.
- Keep background work non-blocking and abort-safe.

## Implementation status and operations

### Implemented library surface

Implementation lives in `src/learning-loop.js` and is intentionally deterministic/testable without Pi. Important public helpers include:

- `createOutcome(input)`, `outcomeRater(input)`, and `rateOutcome(outcome)`
- `minePatterns(outcomes)` and `mineFailurePatterns(outcomes)`
- `proposeImprovements(patterns, context)`
- `reviewProposal(proposal, checks)` and `reviewProposalWithLocalChecks(proposal, options)`
- `delegatedApplyPlan(proposal)`, `applyProposalDryRun(proposal)`, and `LearningStore.applyProposal(...)`
- `verifyProposalWithEvidence(proposal, options)` and `LearningStore.verifyProposal(...)`
- `learningSelfBenchmarkPlan(cwd)` and benchmark execution helpers
- context attribution, adaptive model-router, experiment plan, refactor-proposer, and durable memory-summary helpers
- `ingestLearningSources(cwd, source, options)` for compact verification/topology/skill/trace/evidence/goal/runtime/memory/policy/privacy sources
- `LearningStore` for redacted `outcomes.jsonl`, `patterns.jsonl`, proposal JSON files, experiments, exports, and decision ledgers under `.pi/learning-loop/`
- `src/session-miner.js` for bounded incremental cross-agent scanning, aggregate reports, candidate trend IDs, and learning-outcome conversion; operator script `scripts/mine-agent-sessions.js`

Core tests:

```text
tests/learning-loop.test.js
tests/learning-loop-coordinator.test.js
tests/session-miner.test.js
tests/productization-extensions.test.js
tests/tool-surface-router.test.js
```

### Implemented extension surface

Implementation lives in `.pi/extensions/learning-loop-coordinator/index.ts` with manual commands and the `learning_loop` model tool.

The extension:

- ingests compact local files from verification, topology, skill, trace, Evidence Binder, goal state, runtime/perf reports, memory curator/explorer, policy, and privacy sources;
- persists mined patterns;
- exposes outcome-rater and failure-pattern-miner commands;
- creates proposal JSON;
- supports approve/dismiss decisions;
- captures verification evidence with `/learning-verify`;
- records delegated apply completion only with evidence refs;
- provides benchmark, context attribution, model-router, experiment, refactor proposal, and memory summary commands.

It is manual by default. Optional non-blocking background ingestion can be enabled with `PI_LEARNING_AUTO_INGEST=1` and defaults to verification-only sources. It performs no direct mutations and never auto-proposes or auto-applies.

### Review/apply integration status

Proposal review uses real local advisory gates:

- Evidence Binder-backed claim/evidence inspection when packets are available;
- Privacy Guard latest-scan state plus redaction/secret/transcript detectors;
- Policy Gate/runtime-policy evaluation for verification commands, affected files, and delegated apply mode;
- Test Gap Planner/project-intelligence impact mapping for affected files.

Apply remains delegated rather than direct:

- `/learning-apply --dry-run` renders the required edit/ast-refactor, skill-synthesis, or config workflow;
- `/learning-apply --record-applied --evidence=...` records completion only after external delegated apply plus verification evidence refs;
- Edit/AST Refactor, Verification Center, and Skill Synthesis remain the mutation/proof tools.

### Experiments, benchmarks, and routing status

- `/learning-benchmark` and Verification Center profile `learning` plan or run a small self-benchmark over learning-loop tests, coordinator behavior, productization registration, and extension smoke checks.
- `/learning-experiment` writes branch/topology experiment plans and can capture benchmark evidence.
- `/learning-model-router` recommends task-type thinking/tool presets with minimum-evidence/readiness thresholds and never changes routing automatically.
- Deeper automatic A/B execution remains future work until enough reviewed outcomes exist.

## Operating policies

Default thresholds:

```json
{
  "minOutcomesForPattern": 2,
  "minEvidenceForSkillProposal": "verification",
  "minEvidenceForTestProposal": "tool-output",
  "promptProposalRisk": "high",
  "configProposalRisk": "medium",
  "autoApply": false,
  "autoIngest": false,
  "autoPropose": false
}
```

Operational guidance:

- Keep proposal generation explicit unless dogfooding with reviewed runtime state.
- Keep apply records evidence-backed; never mark a proposal `applied` from a claim alone.
- Treat model-routing recommendations as advisory until enough verified outcomes make a route `ready_for_review`.
- Promote canonical memory candidates only after review and only as concise durable facts; Hermes has no promotion authority.
- Keep generated productization runtime state ignored/untracked.

## Validation and acceptance status

The first useful version is complete when the following remain true:

- `/learning-ingest` creates redacted outcome packets from existing local evidence.
- `/learning-propose` creates at least one proposal each for skill/test/prompt/config when matching evidence exists.
- `/learning-review` shows evidence, risk, policy/privacy checks, and verification plan.
- `/learning-approve` and `/learning-dismiss` persist reviewed decisions.
- `/learning-verify` captures Evidence Binder proof packets and records a proposal verification outcome.
- `/learning-patterns --mine` persists mined patterns to `patterns.jsonl`.
- `/learning-apply --dry-run` explains the exact delegated action without mutating files, and `--record-applied` only records completion with evidence refs.
- Tests prove proposal state transitions, redaction, evidence scoring, and pattern mining are deterministic.
- Extension smoke checks pass and no command/tool conflicts are introduced.

Current expected verification:

```text
node tests/learning-loop.test.js
node tests/learning-loop-coordinator.test.js
node tests/productization-extensions.test.js
node tests/tool-surface-router.test.js
scripts/check-extensions-smoke.sh
bash scripts/check-all.sh
```

## Historical proposal seeds

These were the first proposal themes generated from the original review. They are retained as historical context and regression examples, not open implementation gaps:

1. **Outcome capture gap**: skill synthesis had many skills but few captures. Implemented through broad ingestion and outcome-rater support.
2. **Failure pattern gap**: verifier/runtime history had few mined failures. Implemented through `mineFailurePatterns()` and `/learning-patterns --failures`.
3. **Runtime state growth**: large trace/cognitive state needed conservative cleanup/review workflow and config recommendations. Implemented as runtime ingestion/config proposals plus cleanup tooling integration.
4. **Latency attribution**: provider and agent-end timing needed outcome attribution. Implemented as context attribution and runtime/performance ingestion, with deeper A/B evidence left advisory until enough outcomes exist.

## Settled execution inputs

`/loop` and `/goal` are execution producers, not learning stores. Their common metadata-only packet contract is documented in [Settled execution to learning handoff](execution-learning-handoff.md). Learning ingestion must reuse the canonical outcome vocabulary, remain idempotent, and preserve evidence references without copying prompts, assistant output, transcripts, private reasoning, command arguments, or raw tool output. Packet capture alone never approves a proposal or promotes project memory.

The read-only graph in `src/provenance-graph.js` connects bounded outcome, pattern, proposal, verification, and decision metadata to the originating execution/evidence and downstream captures, skills, or memory references. Proposal acceptance, dismissal, rejection, and supersession remain source-ledger statuses; graph edges never make or apply those decisions. `/memory-provenance [seed]` inspects the chain, while explicit `/memory-provenance-export [seed]` writes only private metadata.

## Compounding effectiveness

`src/compounding-effectiveness.js` aggregates metadata-only exact-version skill uses, failure-pattern reuse, learning funnel conversion, evidence coverage, memory quality, p50/p95 stage costs, maintenance transitions, privacy rejections, and provenance diagnostics. `/learning-scorecard` writes a private scorecard; `learning_loop operation=scorecard` is no-write. The implementation refuses control/candidate deltas unless one pre-registered cohort has both arms and every evaluation includes exact skill/version/source identity and an independent session hash.

Evidence classes remain separate: deterministic, synthetic, migration, exact-version field, and user-reviewed gold. Missing field cohorts, unmeasured applied/ignored maintenance decisions, or absent quality bounds are `insufficient-data`. A scorecard never marks a skill field-proven, approves routing/publishing, applies a proposal, or promotes project memory. See [Compounding effectiveness scorecard](compounding-effectiveness-scorecard.md).

## Remaining future work

The learning loop should not gain more autonomous mutation surface until it has more reviewed outcomes. Future changes should focus on:

- dogfooding the Roadmap-backed learning workflow on real small proposals;
- accumulating enough reviewed outcomes for model-router recommendations to reach `ready_for_review`;
- deeper branch/subagent-backed A/B execution only after privacy, policy, and verification evidence demonstrate safety;
- periodically refreshing this document when command contracts, state layout, or safety invariants change.
