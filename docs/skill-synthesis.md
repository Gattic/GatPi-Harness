# Self-improving skill synthesis

`src/skill-synthesis.js` adds a local-first procedural intelligence layer on top of the existing Pi/Hermes integration boundary. It does not replace reasoning, memory, topologies, subagents, or verification; it normalizes their public artifacts into reusable, governed skills.

## Design constraints

- Use public artifacts and traces only; do not store private reasoning or full transcripts.
- Keep autonomous mutation gated. Synthesized skills start as `candidate`/`draft`; approval is explicit.
- Reuse existing storage, trace, procedural memory, topology, and verification systems.
- Keep deterministic local scoring and retrieval so tests are stable.

## Core objects

### ExecutionCapture

A normalized execution record containing:

- privacy-safe task reference (settled `/loop`/`/goal` captures use only a task hash)
- bounded repository/project identity metadata
- topology/agent shape
- workflow steps
- tool sequence
- verification result
- failures/retries
- latency/tool/model metrics
- outcome score
- replay/provenance references

Captures can be created manually or from topology runs/traces:

```js
const capture = boundary.skills.captureTopologyRun(topologyRun, {
  repository: { path: process.cwd() },
  verification: { ok: true, commands: ["scripts/check-all.sh"] },
});
```

### Skill

A skill is reusable procedural intelligence, not just a prompt. It includes:

- ID, version, status, confidence
- name/description/category
- trigger conditions and domain tags
- applicable repositories and required tools
- workflow steps and execution graph
- expected outputs and validation strategy
- success metrics and historical effectiveness
- failure patterns
- provenance and examples
- governance and rollback metadata

### FailurePattern

Failed captures are converted into anti-pattern signatures with symptoms, likely causes, bad tool sequences, mitigations, and linked capture IDs.

## Pipeline

1. Capture successful/failed executions.
2. Score captures using verification success, retry/failure density, latency, and tool efficiency.
3. Cluster captures by workflow signature. Normal synthesis requires at least 3 repeats, at least 80% success, at least 2 independent execution references, and at least 2 verified successes.
4. Extract workflow steps, tools, validation strategies, examples, and provenance.
5. Store candidate skills and procedural memory entries.
6. Retrieve skills for future tasks using task/repo/tool/effectiveness/status scoring.
7. Inject advisory skill packets into model context.
8. Replay captures or compare skills for deterministic review.
9. Sandbox/A-B score a skill against a baseline before use.
10. Evaluate explicitly invoked skills after the full agent task settles and update confidence/effectiveness; advisory retrieval alone remains neutral.
11. Approve, rollback, or synthesize topology templates under explicit governance.

## Integration boundary

The adapter is exposed as:

```js
const boundary = createPiIntegrationBoundary();
boundary.skills.capture(...);
boundary.skills.synthesize(...);
boundary.skills.suggest("fix failing tests");
```

Governed external/local intake is a separate adapter:

```js
boundary.skillIntake.validateSource("staged-source-id");
boundary.skillIntake.listCandidates();
boundary.skillIntake.importCandidate("skillcand_...");
```

It accepts only root-confined, immutable revision/hash-pinned sources already staged under `.pi/skill-intake/sources/`. A successful topology creates a private candidate packet only. Explicit import creates a skill with `status=candidate`, `sourceTrust=untrusted`, and advisory/routing/publishing approvals blocked. Intake never calls `approve()`, publishes, installs dependencies, discovers repositories, or writes canonical memory.

Storage keys use the existing storage abstraction:

```text
skills/captures/<captureId>.json
skills/captures.jsonl
skills/records/<skillId>.json
skills/versions/<skillId>/<version>.json
skills/failure-patterns/<patternId>.json
skills/events.jsonl
skills/metrics.jsonl
```

## Pi commands

The cognitive automation extension exposes:

```text
/skill-intake-validate <source-id>
/skill-intake <source-id>
/skill-intake-status
/skill-intake-list
/skill-intake-show <candidate-id>
/skill-intake-import <candidate-id>   # candidate import only; no approval
/skill-status
/skill-doctor
/skill-review
/skill-list
/skill-show <skill-id|latest>
/skill-suggest <task>
/skill-synthesize
/skill-draft-hermes <skill-id>                # explicit, quarantined Agent Skill draft
/skill-candidate-promote <candidate-id> [--apply --yes]
/skill-capture-topology <run-id|latest>
/skill-approve <skill-id|latest> [advisory|routing|publishing] [approve|revoke]
/skill-promote <skill-id|latest>             # routing approval
/skill-deprecate <skill-id|latest>
/skill-evaluate <skill-id|latest> [ok|fail]
/skill-rollback <skill-id|latest> <version>
/skill-topology-template <skill-id|latest>
/skill-topology-write <skill-id|latest> [topology-id]
/skill-replay <capture-id>
/skill-compare <left-skill-id> <right-skill-id>
/skill-ab-test <skill-id|latest> <task>
/skill-topology-suggest <task>
/skill-export [file]
/skill-import <file>
/skill-prune [--keep-skills=N] [--keep-captures=N]
/skill-snapshot [note|--list]
/skill-compact
/skill-restore <snapshot-id>
/skill-metrics
```

Model-callable tool:

```text
skill_synthesis
```

Operations include `list`, `show`, `suggest`, `synthesize`, `captureTopology`, `evaluate`, `approve`, `rollback`, `topologyTemplate`, `topologyWrite`, `snapshot`, `compact`, `restore`, and `metrics`. Model-callable synthesis cannot lower the normal eligibility thresholds. Hermes drafting and candidate promotion are current-user command-only.

## Hermes Agent Skill drafting

After deterministic eligibility succeeds, an explicit `/skill-draft-hermes` request sends only categorical workflow/tool/evidence metadata through `HermesAdvisoryAdapter`. It never sends task bodies, transcripts, command arguments, or raw tool output. The typed response must be a standard Agent Skills package with valid `name`/`description` frontmatter, bounded `SKILL.md`, relative references, verification, and failure handling.

Validated packages are written with private permissions under:

```text
.pi/hermes-skill-candidates/<candidate-id>/
```

That directory is not an Agent Skill discovery root. Drafting does not install, approve, route, or publish anything. Promotion previews by default and requires the explicit `/skill-candidate-promote <id> --apply --yes` command; it then copies the validated package plus provenance to `.agents/skills/<name>/`. Automatic drafting additionally requires `PI_HERMES_SKILL_AUTO_DRAFT=1` **and** a passing field authorization. C5 remains `NULL-RESULT`, so the automatic gate is closed.

## Automatic capture

Successful topology runs are automatically captured when `PI_SKILL_AUTO_CAPTURE` is not `0`. The capture is local, non-blocking relative to model execution, and records only normalized public run metadata. The library also supports normalized captures from subagent results, compatibility goal states, reasoning artifact replays, trace exports, and canonical settled execution packets through the boundary adapter. Disable topology auto-capture with:

```bash
PI_SKILL_AUTO_CAPTURE=0 pi
```

## Status, pruning, replay, comparison, and A/B scoring

- `boundary.skills.status()` returns dashboard data: top skills, candidates needing review, recent captures, and aggregate metrics.
- `boundary.skills.prune()` enforces capture/skill retention and removes stale low-confidence drafts.

- `boundary.skills.replay(captureId)` returns a deterministic workflow/tool timeline for a capture.
- `boundary.skills.compare(leftSkillId, rightSkillId)` compares confidence, effectiveness, tools, status, and workflow similarity.
- `boundary.skills.abTest(skillId, task, baseline)` performs sandbox advisory scoring; it does not mutate files or run tools.
- Relevant failure patterns are injected as short `[L2:skill-failures]` advisory context so agents avoid known bad workflows.

## Native Agent Skills importer

Native Pi Agent Skills remain separate from synthesized procedural skills and are still invoked with `/skill:<name>`. The synthesis adapter now scans these locations and registers advisory provider records that point back to the native command:

```text
~/.agents/skills/<name>/SKILL.md
~/.pi/agent/skills/<name>/SKILL.md
.agents/skills/<name>/SKILL.md
.pi/skills/<name>/SKILL.md
```

Frontmatter `name` and `description` are used when present. Disable native provider loading with:

```js
createPiIntegrationBoundary({ skills: { options: { loadNative: false } } })
```

## Curated skill pack and skill providers

The integration boundary loads a first-party curated pack by default (`src/skill-packs.js`) with legacy-lifecycle `approved` baseline skills for debugging, safe refactoring, planner-coder-verifier coordination, documentation/example validation, and failure investigation. Governance v2 marks these source-trusted and schema-valid with advisory retrieval allowed, but sandbox/local/field evidence and routing/publishing approval remain independent and are not inferred. Disable it for tests/custom stores with:

```js
createPiIntegrationBoundary({ skills: { options: { loadCurated: false } } })
```

Extensions or project code can register additional curated skills without bypassing governance:

```js
boundary.skills.registerProvider({
  providerId: "repo-skills",
  skills: [{
    name: "Docs verification workflow",
    category: "documentation",
    triggerConditions: ["docs change"],
    workflowSteps: [{ description: "Edit docs" }, { description: "Verify docs evidence" }],
    validationStrategy: { kind: "evidence", requiredEvidence: ["review"] },
    confidenceScore: 0.9,
  }],
});
```

## Context injection

On `before_agent_start`, the cognitive extension retrieves relevant skills and injects a short advisory `[L2:skills]` block through the existing layered context path. This is advisory only; it does not execute or mutate anything without explicit command/tool invocation. Tuning knobs:

```bash
PI_SKILL_INJECT_MAX=1
PI_SKILL_INJECT_MIN_SCORE=0.5
PI_SKILL_META_INJECT_MAX=0   # suppress meta prompts like "what next?" by default
```

Retrieved/injected skills remain advisory and neutral. Automatic confidence/effectiveness updates occur only for a native skill explicitly invoked with `/skill:<name>`, after Pi reaches `agent_settled` with no queued continuation. Steering/follow-up messages preserve that invocation until final settlement. Provider errors, user aborts, and output truncation remain neutral because they are not evidence about skill quality. Manual `/skill-evaluate` and `skill_synthesis evaluate` operations are also explicit evaluations. This prevents unrelated failures from penalizing skills that were merely recommended.

## Import/export, snapshots, and storage doctor

Use `/skill-export [file]` and `/skill-import <file>` for backup, portability, and sharing skill packs. Use `/skill-snapshot [note]` before risky maintenance, `/skill-compact` to remove duplicate event-log index entries, and `/skill-restore <snapshot-id>` for corruption recovery. Use `/skill-doctor` to inspect dangling capture references, invalid categories/statuses, duplicate event indexes, and unsafe approved skills.

## Settled execution captures

The metadata-only packet described in [Settled execution to learning handoff](execution-learning-handoff.md) is the sole automatic bridge from settled `/loop` or `/goal` execution. The reasoning runtime drains it at session start and `agent_settled`, converting one packet into at most one allowlisted execution capture with `PI_EXECUTION_OUTCOME_SKILLS=1` (default). Set the flag to `0` to leave packets pending. The capture cannot copy prompts, output, transcripts, reasoning, command arguments, or unrestricted paths, and it cannot synthesize, approve, route, or publish a skill automatically.

`/memory-provenance <skill-id@version>` exposes a read-only metadata chain from exact source hash and evidence IDs through settled execution and capture to a specific skill version. It reads bounded normalized fields through `SkillSynthesisAdapter.provenanceRecords()`; it does not duplicate skill bodies or become a skill registry. Missing capture/source hashes and superseded versions appear as diagnostics. Export remains an explicit separate command.

## Governance v2

Every skill exposes separate `evidenceState` dimensions for source trust, schema validity, sandbox review, local verification, and exact-version field proof, plus independent advisory-retrieval, routing, and publishing approvals. The legacy lifecycle `status` remains readable, but `approved` never means `field-proven` or routing/publishing authorization. Exact-version evaluation identity is `(skillId, version, sourceHash)`.

Legacy records migrate in memory. A legacy `approved` record maps only to `approvals.advisoryRetrieval=allowed`; it remains `routing=not-approved`, `publishing=not-approved`, and `field=insufficient-data`. Records are written as schema v2 only when next changed; no bulk rewrite occurs. Set `PI_SKILL_GOVERNANCE_V2=0` only to restore legacy ranking during rollback—status still reports incomplete evidence.

`/skill-approve <id> [advisory|routing|publishing] [approve|revoke]` changes one scope. `/skill-promote` requests routing approval. Publishing is command/human-only and also requires reviewed exact-version field proof. Model-tool approval, provider registration/import, and topology write require explicit current-user governance intent in the current turn. Normal commands use the 0.65 threshold; low-threshold implicit promotion is disabled.

- Skills are not silently approved or marked field-proven.
- Approval checks confidence, source/schema/local evidence, requested scope, and unsafe patterns.
- Unsafe detection flags destructive shell patterns and missing validation strategies.
- Rollback restores a prior version as a new `rolled_back` version.
- Executable topology templates require exact-record routing approval, reviewed/trusted source, valid schema, passed local verification, and no failed safety gate. Templates include skill ID, version, source hash, evidence state, and approvals.
- Captured cosmetic or unknown step labels are mapped conservatively to registered role IDs; they never become executable free-form roles.
- Handler-only roles remain handlers. Read-only roles use `shared-readonly`; mutating `coder`/`refactorer` roles use `isolated-worktree` with explicit budgets and typed output schemas.
- Every generated `ok`/`no_errors` edge requires a validated typed upstream result.
- Topology success and trajectory merge do not apply files. A synthesized mutating run yields proposed-patch metadata for explicit parent preview/apply and verification.
- Skill evaluation updates confidence and historical effectiveness without editing old provenance.
- Field evaluations may carry a pre-registered `cohortId`, `control|candidate` arm, independent `sessionIdHash`, and measured context added. These metadata are accepted only alongside exact skill ID/version/source identity; scorecard code refuses deltas when any identity is absent.
- Failure-pattern storage records first discovery, later signature matches, explicit mitigation reuse, and post-mitigation outcomes as metadata-only metrics. Missing reuse/outcome observations remain `insufficient-data`.

The private compounding scorecard groups verified captures and accepted/rejected uses by exact version, source hash, routing mode, and evidence class. It cannot mark a skill field-proven or change routing/publishing approval. See [Compounding effectiveness scorecard](compounding-effectiveness-scorecard.md).

## Tests and example

```bash
node tests/skill-governance.test.js
node tests/skill-synthesis.test.js
node tests/skill-retrieval-benchmark.test.js
node tests/skill-performance.test.js
node examples/skill-synthesis-example.js
node examples/skill-synthesis-workflows-example.js
scripts/check-skill-synthesis-tui.sh
scripts/check-all.sh
```
