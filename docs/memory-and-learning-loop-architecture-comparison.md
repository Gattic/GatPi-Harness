# Pi harness compared with reference memory and continuous-learning architectures

**Date:** 2026-07-31

**Repository:** `pi-harness`

**Reference architectures:** a generic persistent-memory cycle and an eight-stage skill-acquisition pipeline, summarized in section 1.

**Scope:** Pi harness, topology runtime, project/cognitive memory, Hermes, `/loop`, `/goal`, learning loop, and skill synthesis.

## Executive conclusion

The harness already implements most of the reference architectures' useful ideas, with stronger privacy, verification, isolation, provenance, and rollback controls. The reference architectures are easier to understand because each shows one obvious compounding cycle. Our equivalent behavior is more capable but spread across several subsystems.

The most important terminology distinction is:

- **`/loop` is an execution loop:** it repeats the same user-authored task until bounded completion.
- **`/goal` is a controller loop:** Hermes selects a new `nextPrompt` after each observation.
- **`learning_loop` plus `skill_synthesis` is the closest equivalent to the skill-acquisition pipeline:** it turns outcomes into reviewed improvement proposals and reusable skills.
- **The topology runtime is the execution substrate:** it can express specialized sequential or DAG pipelines, but it is not itself a continuous learner.

The highest-value lessons are to make the full compounding path visible, unify canonical-memory readiness, turn successful and failed `/loop` and `/goal` runs into privacy-safe learning captures, strengthen empirical skill-promotion states, and add an explicit governed skill-intake topology. We should **not** copy the references' implied unbounded scanning, automatic publishing, or mixed identity/memory file.

## 1. What the reference architectures propose

### Persistent-memory cycle

The memory reference presents a simple persistent-context cycle:

```text
RAW source material
  -> WIKI structured linked knowledge
  -> RETRIEVED context
  -> USE in conversations
  -> OUTPUT artifacts
  -> AGENTS.md identity/preferences/goals/project context
  -> UPDATE insights
  -> RAW/WIKI again
```

It separates directories for raw inputs, linked knowledge, generated output, interaction context, and identity/system memory. Its maintenance cycle is ingest, write, manage, review, and prune/deduplicate. Its main claim is compounding value through persistent, connected, automatically retrieved context.

### Skill-acquisition pipeline

The learning reference presents a fixed eight-stage skill-acquisition pipeline:

```text
Discover -> Filter -> Read -> Extract -> Score -> Generate -> Review -> Publish
      ^                                                              |
      +---------------------- Skill library --------------------------+
```

It emphasizes specialized agents, deterministic filtering, objective scoring, standardized skill packages, separate generation and review, human approval, and a persistent skill library that improves later discovery.

Neither reference specifies production-grade privacy, source trust, rollback, partial-result truth, field validation, or safe handling of untrusted repositories. Those omissions matter in our environment.

## 2. Current Pi architecture in one view

```text
Pi core: minimal interactive/print/JSON/RPC coding harness
  -> trusted TypeScript extensions and model tools
  -> src/integration-boundary.js adapters
       -> reasoning runtime (public scaffold; model remains the reasoning engine)
       -> topology/subagent runtime (typed roles, joins, isolated worktrees)
       -> verification/evidence/policy/privacy controls
       -> cognitive and layered context stores
       -> canonical project-memory adapter
       -> learning-loop and skill-synthesis stores

Private episodic evidence                 Canonical durable memory
Pi session JSONL, traces, checkpoints      Obsidian Memory/Projects/<project-key>/
        |                                               |
        +-> redacted/provenance-backed candidates ------+
                                                        |
                                      compiled local recall cache
                                                        |
                                      bounded task-conditioned recall

/loop or /goal -> workspace observations -> verification evidence
                                         -> learning outcomes
                                         -> candidate skill/proposal
                                         -> review/policy/privacy/verification
                                         -> explicit approval
                                         -> reusable skill/topology
```

Model-side reasoning is canonical. The harness stores only public plans, decisions, evidence, checkpoints, branch comparisons, failure analyses, and memory updates; it does not depend on or expose private model reasoning.

## 3. Element-by-element comparison

| Requested element | Current Pi behavior | Reference analogue | Assessment |
|---|---|---|---|
| **Pi harness** | Minimal Pi core plus 47 inventoried extensions (46 loaded in the runtime snapshot), lifecycle hooks, tools, traces, evidence, policy gates, and persistent state. | The overall runtime surrounding both references. | More operationally complete, but less visually unified. |
| **Topology** | Generic schema-v3 sequential/DAG engine with typed Roles v2 contracts, explicit joins, truthful partial status, context projection, tool/memory policy, and isolated worktrees. | The eight specialized agents in the skill-acquisition pipeline. | A strict superset as an execution substrate; no default always-on skill-intake pipeline. |
| **Memory management** | Private episodic sessions; canonical Obsidian project notes; rebuildable compiled recall and cognitive stores; explicit save/review/retention controls. | RAW, WIKI, RETRIEVED, AGENTS.md, and UPDATE in the persistent-memory cycle. | Safer authority model and provenance; more layers and current readiness friction. |
| **Hermes** | Off-path advisory curator and optional legacy-conversation recall provider; also the adaptive controller for `/goal`. It is not canonical storage. | The review/update intelligence implicit in both references. | Correctly separated from storage authority, but its memory and controller duties should remain clearly distinct. |
| **`/loop`** | Repeats the same prompt at `agent_settled`, bounded by iteration/stall limits, checkpoints, managed-work waits, and evidence/promise completion. | Only the circular shape of the skill-acquisition reference, not its learning pipeline. | Strong bounded execution loop; it does not itself create or approve skills. |
| **`/goal`** | Hermes emits strict JSON decisions and a changing `nextPrompt`; Pi executes it, records redacted observations, applies safety checks, and rejects unsupported completion. | A dynamic coordinator around the learning pipeline. | More adaptive than `/loop`, but currently prompt-oriented rather than typed-action/proof-oriented. |
| **Learning loop** | Mines public/aggregate outcomes, patterns, and proposals; application is review-gated and delegated to safe mechanisms. | Discover/filter/score/review feedback loop. | Closest conceptual match, but primarily learns from local outcomes rather than external discovery. |
| **Skill synthesis** | Captures executions/topology runs, scores and clusters them, creates governed candidate skills, retrieves advisory skills, and supports review/approval/rollback. | Extract/generate/publish plus the persistent skill library. | Stronger schema and governance; empirical capture depth is currently limited. |

## 4. Memory architecture comparison

| Persistent-memory concept | Pi equivalent | Important difference |
|---|---|---|
| **RAW immutable source** | Pi session JSONL, repository files/Git state, trace/checkpoint evidence, and external research notes. | Raw sessions stay private and are never injected wholesale or copied into canonical memory. Source fingerprints and evidence IDs are preferred to duplication. |
| **WIKI linked knowledge** | Canonical Obsidian notes: `Current`, `Decisions`, `Constraints`, `Risks-and-TODOs`, `Verification`, `Procedures`, and `History`. | Notes have project-key, hash, verification, evidence, expiry, and supersession metadata. `Current.md` is generated, not a second authority. |
| **RETRIEVED** | Provider-free compiled-cache recall, current-Git facts, cognitive retrieval, layered-context packing, Memory Explorer, and explicit Obsidian search. | Cache reads fail closed when source decision identity is stale. Provider-backed Hermes recall is optional and labeled advisory. |
| **USE** | `before_agent_start` context injection and model-tool retrieval. | Context is query-conditioned, bounded, deduplicated, and split into L0-L4 layers rather than loading one large wiki. |
| **OUTPUT** | Normal repository files, docs, reports, proposed patches, verifier packets, topology results, and reasoning artifacts. | Outputs remain with their owning workflow; there is no required central `output/` directory. |
| **AGENTS.md identity/preferences/goals** | Pi `AGENTS.md` instructions, project constraints, roadmap, canonical memory kinds, and optional user preferences. | Pi deliberately separates instructions, active goals, project memory, and user identity rather than allowing one self-updating file to mix authorities. |
| **UPDATE** | Explicit `memory_curator` save/review, verified topology curation, decision ledger, learning proposals, and optional Hermes curation. | Automatic durable mutation is evidence-gated and currently unauthorized; updates are not accepted merely because the model generated them. |
| **Maintain/prune** | Preview-first retention, permissions hardening, conflict/lineage inspection, snapshots, rollback manifests, and bounded cache rebuilds. | Deletion/application requires explicit review; raw sessions and canonical memory are excluded from normal retention candidates. |

### Where Pi is stronger

1. **Authority is explicit.** Obsidian project notes are canonical; caches, cognitive state, and Hermes output are not.
2. **Privacy is structural.** Full transcripts, prompts, private reasoning, secrets, full paths, and raw tool output are forbidden in durable notes.
3. **Recall is bounded and provenance-labeled.** Canonical vault, compiled cache, and current-Git facts remain distinguishable.
4. **Writes are governed.** Verification state, evidence IDs, deduplication, conflict review, expiry, and supersession are part of the record.
5. **Retention is reversible.** Preview, manifest, checkpoint, apply, and rollback are separate operations.
6. **Reasoning and memory are not conflated.** The model reasons; the harness records public artifacts and proof.

### Where the reference is better

1. The source-to-knowledge-to-use-to-update path is immediately understandable.
2. Raw evidence, structured knowledge, generated artifacts, and identity are visibly separated.
3. Maintenance is presented as a first-class recurring workflow rather than a collection of commands.
4. The compounding-value story is explicit.

Our documentation should preserve the richer implementation while presenting one similarly simple top-level flow.

## 5. Continuous-learning architecture comparison

| Pipeline stage | Current Pi capability | Gap or qualification |
|---|---|---|
| **1. Discover** | Explicit repository research, Code Context/CodeGraph, docs lookup, session mining, skill providers, and topology research roles. | No always-on GitHub scout, intentionally. External discovery has no single governed intake manifest/pipeline. |
| **2. Filter** | Role routing, policy gates, source/path confinement, deterministic proposal checks, privacy checks, and review queues. | There is no consolidated external-skill filter for license, pinned revision, provenance, malicious instructions, and supply-chain risk. |
| **3. Read** | `researcher` roles, task/dependency context projection, local docs, code cards, and branch-backed read-only subagents. | Better bounded context than reading every repository, but no canonical read-order contract for external skill intake. |
| **4. Extract** | Skill-synthesis execution captures, topology capture, learning outcome normalization, and pattern mining. | `/loop` and `/goal` are not yet obvious first-class capture sources in the end-to-end operator workflow. |
| **5. Score** | Verification evidence, capture scoring, historical effectiveness, deterministic benchmarks, Evidence Binder, and preregistered experiment gates. | Imported/curated skills can be `approved` without enough local execution captures to mean field-proven. |
| **6. Generate** | Candidate skill synthesis, learning proposals, test/prompt/config drafts, and topology-template rendering. | Generation is spread across two subsystems rather than one visible pipeline. |
| **7. Review** | Human approval, reviewer/verifier roles, privacy/policy gates, impact review, typed results, and rollback metadata. | Stronger than the reference; keep generation and review independent. |
| **8. Publish** | Explicit local skill approval, provider registration, topology-template write, export, or separately confirmed Git workflow. | No automatic push/publish model tool, intentionally. Publication must remain explicit and provenance-backed. |
| **Skill library feedback** | Advisory skill retrieval, context injection, effectiveness updates, failure patterns, learning outcomes, and topology suggestions. | The feedback loop exists, but the small capture/failure-pattern corpus limits evidence of compounding from synthesized executions. |

### Topology comparison

The pipeline reference hard-codes eight single-responsibility agents. Pi instead supplies a reusable graph runtime:

- sequential, fan-out/fan-in, and DAG modes;
- typed role and result contracts;
- `all`, `quorum`, `min-success`, and `best-effort` joins;
- explicit failed/skipped/blocked node states;
- read-only partial results that never count as success;
- `task-only`, `summarized`, `dependency-neighborhood`, and `evidence-only` projections;
- tool and memory policies per role;
- shared-readonly workspaces for research and isolated worktrees for mutation;
- explicit patch preview/apply instead of implicit merge;
- parent-owned roadmap mutation after a planner proposes a public hierarchy.

This is a better substrate than a fixed eight-agent implementation. The lesson is to add the reference's **pipeline recipe**, not replace the generic topology engine.

The `parallel-evidence-synthesis` topology is a good example of Pi's stronger controls: four independent read-only workers, evidence-only audit, deterministic reduction, and truthful partial status. Its E0, E1, and ship gates passed, but the preregistered E3 live cohort remains pending; routing must therefore remain suggest-only.

## 6. `/loop`, `/goal`, and learning-loop semantics

| Property | `/loop` | `/goal` | `learning_loop` / `skill_synthesis` |
|---|---|---|---|
| Trigger | Explicit user loop/autonomy intent | Explicit `/goal` command | Explicit learning/skill operations or narrowly configured off-path ingest |
| Decision policy | Same task every iteration | Hermes chooses a new prompt | Deterministic outcome/pattern/proposal logic plus reviewed model assistance where configured |
| State | Session-scoped loop record and workspace fingerprints | `.pi/goal-state/` observations/history | `.pi/learning-loop/` and integration-boundary skill records |
| Default bound | 20 iterations | 50 iterations | No autonomous run loop; proposal transitions are explicit |
| Completion | Exact promise or objective evidence | Hermes completion decision plus harness evidence check | Verification evidence plus review/approval state |
| Managed waits | Automatically waits for iteration-owned `bg_run`/`run_deck` work | Executes/observes through normal Pi turns | Consumes settled outcome artifacts rather than babysitting jobs |
| Durable memory | Does not auto-store summaries in Hermes | Final summary sync is enabled unless disabled, but default Hermes goal mode is isolated | Durable summary promotion is separately reviewed |
| Learning effect | Workspace/session progress only | Adaptive task progress only | Produces reusable outcomes, patterns, proposals, and skills |

### `/loop` compared with the skill-acquisition pipeline

`/loop` already adopts useful loop discipline absent from the reference: bounded budgets, stall detection, PASS/FAIL/NULL checkpoints, pre-registered experiment gates, objective completion, managed-work attribution, stale continuation-token rejection, and policy enforcement on every iteration.

It intentionally does **not** discover, generate, approve, or publish skills. A completed loop becomes durable capability only if its public execution evidence is later captured by the learning/skill systems.

### `/goal` compared with the skill-acquisition pipeline

`/goal` resembles a coordinator more than any of the eight agents. Hermes receives goal state and recent observations, then returns strict JSON with status, `nextPrompt`, reason, completion check, and user-input requirement. The harness executes the prompt, blocks common unsafe actions, and rejects completion without prior evidence.

Two design gaps are worth addressing:

1. The controller still returns a free-form executable prompt rather than a typed action such as `run_topology`, `run_verifier`, `inspect`, or `ask_user`.
2. Completion proof is partly inferred from bounded observation text and keywords rather than requiring a typed current verifier/Evidence Binder reference.

Also, the default Hermes goal mode is `isolated`, so final-summary sync is not the same as a canonical Obsidian project-memory update. Verified goal outcomes should flow through the project-memory candidate/review boundary instead of making an isolated Hermes conversation look authoritative.

## 7. Current operational snapshot

This snapshot is point-in-time evidence from 2026-07-31, not a permanent architectural guarantee.

| Surface | Observed state |
|---|---|
| Extension fleet | 47 inventoried extensions, 46 loaded; 59 active parent model tools; zero conflicts or degraded extensions reported. |
| Canonical project-memory rollout | Requested/effective **M0**; project-memory adapter reported disabled with `vault-unavailable`; automatic behavior unauthorized and public decision `no-go-deferred`. |
| Obsidian adapter | Vault filesystem and local Markdown ready at the discovered vault; desktop executable unavailable; Hermes executable/provider-model ready; authentication unknown; end-to-end curation not ready. |
| Readiness consistency | `obsidian_status` reports a usable local vault while `memory_curator` reports canonical project memory unavailable. This cross-surface disagreement should be treated as a configuration/integration defect, not as evidence that canonical recall works. |
| Memory-state inventory | 1,876 files and about 145 MB across the inspected repo-local cognitive/verification roots. |
| Memory scorecard | Deterministic retrieval/save tests pass, but 102 high-severity privacy candidates are unreviewed, field sessions/days are 0/0, and real curation has only 4 attempts; highest authorized stage remains M0. |
| Skill synthesis | 33 approved skills, 4 execution captures, 0 failure patterns, mean confidence about 0.373. |
| Learning loop | 101 outcomes, 3 patterns, and 3 proposals; one proposal approved and two dismissed. |
| Automation loop | No current loop. |
| Goal state | No repo-local `.pi/goal-state` was present in the inspected inventory. |
| Parallel evidence experiment | E0 PASS, E1 PASS, ship gate PASS; E3 live cohort still pending, so the experiment remains open. |

The most important operational signal is the mismatch between a ready Obsidian filesystem and a disabled canonical project-memory adapter. The second is that the skill catalog is much larger than the empirical execution-capture corpus.

## 8. Lessons to apply

### P0 — Resolve before broadening automation

#### 1. Unify canonical-memory vault resolution and health reporting

Make the Obsidian adapter, project-memory runtime, Memory Curator, and Memory Explorer resolve the same authoritative vault configuration and report the same readiness layers.

Acceptance criteria:

- one project key and one canonical vault root;
- `obsidian_status`, `memory_curator status`, and project-memory recall agree;
- a verified explicit save is visible in the canonical note and recalled from a same-decision cache;
- no automatic stage increase beyond the scorecard-authorized M0;
- no raw prompt, transcript, secret, or full path crosses the boundary.

#### 2. Separate skill trust from empirical validation

The single label `approved` currently covers native/curated trust and synthesized workflow governance, while only four execution captures exist. Introduce or expose distinct dimensions:

```text
source-trusted -> schema-valid -> sandbox-checked -> locally-verified
               -> field-proven -> approved-for-routing/publishing
```

A trusted native skill need not be treated as field-proven. Promotion dashboards should show capture count, failure-pattern coverage, verification quality, and exact-version cohort size.

#### 3. Publish one loop taxonomy and handoff contract

Document one operator-facing lifecycle:

```text
/loop or /goal
  -> verified/failed public outcome packet
  -> learning_loop pattern/proposal
  -> skill_synthesis candidate
  -> independent review and proof
  -> explicit approval
  -> advisory retrieval or explicit topology use
```

This prevents “loop” from ambiguously meaning task repetition, controller planning, experiment iteration, or capability learning.

### P1 — Add governed compounding paths

#### 4. Create an explicit `governed-skill-intake` topology

Use the existing generic topology runtime to encode the pipeline reference's strongest idea without enabling blind continuous scanning:

```text
source-manifest
  -> deterministic-filter
  -> bounded-read
  -> workflow-extract
  -> objective-score
  -> candidate-generate
  -> independent-review + security/privacy/license checks
  -> explicit human publish/PR step
```

Required controls:

- explicit invocation or reviewed schedule, never hidden prompt routing;
- pinned source revision and content hash;
- license and provenance checks;
- untrusted-instruction and dependency/supply-chain review;
- read-only workspaces through review;
- evidence-only fan-in;
- `all` join before any publish candidate;
- no model-callable push/publish action;
- candidate status only until human approval and verification.

#### 5. Capture `/loop` and `/goal` outcomes after settlement

On successful or instructive failed completion, create a normalized public capture containing IDs/hashes, workflow steps, tool names, verifier references, retries, outcome, and bounded metrics. Never capture the repeated prompt, raw assistant output, command arguments, transcript, private reasoning, or secrets.

Route the capture to:

- `learning_loop` for pattern and proposal mining;
- `skill_synthesis` for candidate extraction and failure patterns;
- project memory only when a stable verified fact passes explicit curation policy.

Do not auto-approve the resulting skill.

#### 6. Make `/goal` actions and completion proof typed

Evolve Hermes decisions from a free-form `nextPrompt` toward an allowlisted action envelope, for example:

```json
{
  "status": "running",
  "action": {
    "kind": "run_topology",
    "id": "project-reviewer-verifier-gate",
    "inputRef": "artifact-or-goal-state-id"
  },
  "completionEvidenceIds": []
}
```

Retain a compatibility prompt action, but give it lower authority. Require current verifier/Evidence Binder IDs for `completed`; textual confidence, keywords, or reflection must not count as proof.

#### 7. Run maintenance automatically only as a preview

The memory reference is right that review, deduplication, linking, and pruning need a cadence. In Pi, a scheduled off-path job may safely generate:

- stale/conflicting/superseded memory report;
- orphaned evidence/backlink report;
- duplicate candidate report;
- retention and permissions preview;
- cache/source-decision consistency report.

Applying writes or deletions should remain explicit and rollback-backed until field gates authorize otherwise.

### P2 — Improve visibility and measured compounding

#### 8. Expose one provenance graph across memory and skills

The underlying records already carry evidence IDs, source fingerprints, lineage, supersession, topology run IDs, and capture IDs. Render a compact project graph that answers:

- Which evidence supports this durable fact or skill?
- Which fact/skill superseded it?
- Which loop/goal/topology produced the evidence?
- Was it source-trusted, locally verified, or field-proven?
- What later outcome accepted or rejected it?

This captures the memory reference's “everything is linked” benefit without copying raw source bodies into a wiki.

#### 9. Measure the feedback loop, not just inventory size

Track at least:

- verified captures per approved skill;
- accepted/rejected uses by skill provenance and exact version;
- failure-pattern discovery and reuse;
- proposal-to-approved-to-field-proven conversion;
- unsupported-claim rate and evidence coverage;
- canonical recall precision, stale rate, and cross-project contamination;
- p50/p95 model calls, duration, and context added per stage;
- maintenance previews resolved versus ignored.

A growing library is not evidence of learning unless later work measurably improves.

## 9. What not to copy from the references

1. **Do not run an unbounded “never stops” agent.** Keep `/loop`, `/goal`, topologies, experiments, and monitors bounded and semantically separate.
2. **Do not continuously fetch arbitrary GitHub repositories by default.** External sources are untrusted code/instructions and a supply-chain boundary.
3. **Do not publish generated skills automatically.** Preserve human approval, verification, provenance, and the absence of a model-callable publish tool.
4. **Do not make Hermes or an LLM response the storage authority.** Hermes should curate proposals; canonical Obsidian notes and deterministic policy decide acceptance.
5. **Do not mix identity, preferences, goals, project facts, and generated output in one self-updating `AGENTS.md`.** Keep instruction, roadmap, memory, and user-profile authorities separate.
6. **Do not copy raw sessions or source collections into durable memory or every prompt.** Keep raw evidence private and reference it through bounded fingerprints/evidence IDs.
7. **Do not force eight agents onto routine work.** Use the specialized pipeline only when its expected evidence gain justifies cost; retain sequential and single-worker fallbacks.
8. **Do not promote from deterministic fixtures alone.** Keep exact-version live cohorts and preregistered bars, as the open parallel-evidence experiment already requires.

## 10. Recommended target workflow

```text
EXPLICIT SOURCE OR SETTLED EXECUTION
  external pinned source     /loop result     /goal result     topology result
             \                  |                 |                 /
              +------ normalized public evidence/capture ---------+
                                      |
                         deterministic filter + score
                                      |
                   candidate skill / test / prompt / config
                                      |
          independent review + policy + privacy + impact + verifier
                                      |
                          explicit human approval
                                      |
               approved skill / topology / canonical memory fact
                                      |
              bounded advisory retrieval for the next relevant task
                                      |
                  measured outcome feeds the next review cycle
```

This preserves the references' compounding value while retaining Pi's strongest properties: local-first operation, explicit authority, privacy boundaries, typed truth, verification gates, rollback, and user control.

## 11. Sources and evidence boundary

Primary repository sources:

- `README.md`
- `docs/project-memory-operations.md`
- `docs/cognitive-memory-architecture.md`
- `docs/layered-context-architecture.md`
- `docs/integration-boundary.md`
- `docs/adr-reasoning-runtime.md`
- `docs/multi-agent-topologies.md`
- `docs/topology-cookbook.md`
- `docs/adr-parallel-evidence-topology.md`
- `docs/automation-loop.md`
- `docs/self-improving-learning-loop.md`
- `docs/skill-synthesis.md`
- `docs/memory-effectiveness-scorecard.json`
- `extensions/hermes-memory/index.ts`
- `.pi/extensions/goal/index.ts`
- `.pi/extensions/goal/goal-runner.js`
- `.pi/extensions/goal/goal-store.js`
- `src/integration-boundary.js`
- `src/project-memory-runtime.js`

Pi framework sources:

- `~/pi/packages/coding-agent/README.md`
- `~/pi/packages/coding-agent/docs/extensions.md`

Point-in-time runtime evidence came from `extension_ops`, `run_topology`, `memory_curator`, `memory_explorer`, `obsidian_status`/`obsidian_doctor`, `skill_synthesis`, `learning_loop`, `automation_loop`, `privacy_guard`, and `experiment_ledger` on 2026-07-31.

`docs/hermes-obsidian-memory-investigation-2026-07-17.md` was used only as historical context; current authority is the implemented project-memory operations contract, current source, scorecard, and runtime status. No experiment or autonomous loop was launched for this comparison.
