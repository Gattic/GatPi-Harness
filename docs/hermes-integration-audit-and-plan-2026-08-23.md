# Hermes integration audit and improvement plan

**Date:** 2026-08-23
**Scope:** Hermes as an AI assistant, project-memory manager, and automatic skill creator in `pi-harness`
**Current versions:** Hermes Agent 0.20.1, Pi 0.84.1, Node 22.22.2
**Decision:** Keep Hermes, but consolidate it as a typed off-path advisory service. Do not promote automatic memory mutation, skill installation, publishing, or autonomous routing on current evidence.

> **Implementation status (updated 2026-08-27):** The legacy bridge/cache/recall/sync paths identified in this baseline audit have been removed and the typed advisory boundary described below is implemented. Obsidian remains canonical. Goal decisions now use schema v3: every executable typed action carries a complete Hermes-authored prompt that Pi executes verbatim, and the obsolete generic prompt fallback is removed. Prompt refinement and skill drafting default off, and skill candidates remain quarantined until explicit user promotion. Field gates are still unqualified: E3 and C5 remain `NULL-RESULT`, automatic routing and canonical promotion remain disabled, and the scorecard decision remains `NO-GO-DEFERRED` until exact-version field evidence satisfies the stated bars.

## Executive verdict

The integration has strong process controls and a working Hermes runtime, but the three requested capabilities are at very different maturity levels.

| Capability | Rating | Verdict |
|---|---:|---|
| AI assistant/controller | **3/5** | Operational and well guarded in narrow surfaces (`/goal`, prompt refinement, Obsidian curation), with passing live probes. It is fragmented and has almost no field-use evidence. |
| Memory manager | **2/5** | The target authority model is correct—Obsidian is canonical and Hermes is advisory—but production remains read-only M0. A legacy Hermes-conversation path still bypasses the canonical store and parts of the durable-content boundary. |
| Automatic skill creator | **1/5** | Hermes does not create skills in the current integration. The local deterministic skill-synthesis substrate exists, but it has produced no synthesized skills in the inspected state and does not render governed Agent Skills through Hermes. |

The raw Hermes model is healthy: authentication, provider/model selection, synthetic curation, and a typed assistant response all passed during this audit. The principal problem is therefore not model availability; it is product integration, authority clarity, privacy consistency, and lack of field evidence.

## Evidence collected

### Live and runtime evidence

- `obsidian_doctor` authenticated successfully in **4.650 s**.
- Its synthetic curation probe succeeded in **5.403 s**, with `noteWritten=false`.
- A separate read-only Hermes one-shot returned a valid goal-decision schema-v2 object in **5.773 s**.
- The Hermes executable, authentication, and configured provider/model are ready.
- The Obsidian vault filesystem and local Markdown operations are ready. The Obsidian desktop executable is missing, but that affects only desktop/open behavior.
- Canonical project memory is still at **M0**:
  - reads enabled;
  - explicit canonical writes disabled;
  - Hermes canonical curation disabled;
  - automatic behavior unauthorized;
  - public decision `no-go-deferred`.
- The canonical project-memory folder currently contains zero managed entries in every memory kind.
- The legacy Hermes recall cache exists but is about **658 hours** old. Its persisted state reports the last recall on 2026-07-27 and the last sync on 2026-07-25.
- Historical Hermes-memory trace metadata contains 140 events: 54 recall starts, 42 completions, 39 cache hits, and 5 failures.
- No repo-local `/goal` run is recorded, so controller effectiveness has no local adoption sample.
- Prompt-suggestion and Hermes-memory portfolio reports both classify usage as `insufficient-data` with zero trigger-eligible observations.

### Skill evidence

The inspected skill store contains:

- 36 records: 31 native Agent Skills and 5 first-party curated skills;
- **0 synthesized skill records**;
- 4 execution captures, all successful topology-run captures;
- 552 evaluation metric rows, but zero qualified exact-version field uses;
- 1,366 skill events, mostly repeated `skill.updated` events;
- no evidence that Hermes generated any skill body or Agent Skills package.

The implementation confirms the boundary:

- `src/skill-synthesis.js` is deterministic and has no Hermes dependency;
- automatic settlement/topology capture may create execution captures;
- `/skill-synthesize` is explicit and currently permits a one-capture candidate with `minRepeats: 1`;
- synthesis cannot implicitly grant advisory, routing, publishing, or field-proof authority;
- Pi can load standard `SKILL.md` packages, but this synthesis path stores internal skill records rather than creating a reviewed native Agent Skill package.

### Deterministic verification

Fourteen relevant test commands passed, covering:

- the shared Hermes client and readiness state;
- the Hermes-memory lifecycle and subagent contracts;
- Obsidian adapter and readiness behavior;
- goal typed actions, runner, and extension registration;
- prompt-suggestion policy and extension behavior;
- skill synthesis and governance;
- settled execution-to-skill handoff.

One initially requested test path did not exist; the actual `tests/settled-execution-handoff.test.js` was then inferred and passed. This was verifier input error, not a product failure.

Current public memory fixtures also report perfect synthetic retrieval/save behavior and local recall p95 of 14.49 ms, but those fixtures are explicitly not field-gating evidence. Exact-version uses, independent sessions, and observed days remain 0/0/0.

## Findings

### 1. Hermes is a capable narrow assistant, not a unified assistant surface

Current assistant-like entry points are spread across three products:

- `.pi/extensions/goal/goal-runner.js` uses Hermes as a typed adaptive controller;
- `extensions/prompt-suggestions/index.ts` optionally refines deterministic local next-step suggestions;
- `src/obsidian-adapter.js` asks Hermes to synthesize research-memory drafts.

The goal controller has strong schema and safety controls: typed actions, evidence-bound completion, a single repair turn for malformed JSON, unsafe-prompt blocking, bounded prompts, timeouts, and private redacted state. Prompt suggestions preserve a deterministic local result and use Hermes only off-path.

Gaps:

- there is no single explicit “ask Hermes for a plan/review/second opinion” surface;
- the goal path does not consistently use the shared readiness proof/backoff gate used by prompt suggestions and Obsidian;
- `.pi/extensions/goal/index.ts` still invokes `hermes --version` directly even though the documented rule says all Hermes subprocess access uses `src/hermes-client.js`;
- no local goal runs or qualified prompt-suggestion cohort establish usefulness, failure rate, or latency in real work;
- assistant output is operationally healthy but not field-proven.

### 2. The canonical memory architecture is right, but the legacy bridge conflicts with it

The current authority contract is sound:

```text
private Pi sessions -> bounded evidence/candidates -> Hermes advisory curation
                    -> reviewed policy gate -> canonical Obsidian project notes
                    -> provider-free compiled recall
```

However, `extensions/hermes-memory/index.ts` remains a separate legacy conversation/cache memory system. Its manual paths can:

- send user, assistant, tool-result, and tool-call-derived text to Hermes in a `<pi-session-transcript>` block;
- send the full repository path and Git status;
- store `/hermes-note` content without the shared durable-content scanner;
- ask Hermes to “store” facts in a conversation rather than submit a canonical project-memory candidate.

Automatic recall and shutdown sync are off, which limits exposure, but manual commands still bypass the intended authority and provenance model. This is especially misleading because their UI describes the conversation as “durable project memory” while current architecture says it is non-canonical legacy recall.

The Obsidian curation path is safer: it requires current auth/curation proof, bounds source count and bytes, scans generated output, hashes sources, serializes curation by topic, labels output unverified, and supports dry run. Two issues remain:

- provider-bound vault excerpts are not passed through the shared durable-content scanner before being sent to Hermes;
- `obsidian_hermes` treats `dryRun:true` as opt-in, so an ordinary call writes an advisory `Memory/Hermes` note even while canonical-memory status reports Hermes curation as rollout-disabled.

The latter is not a canonical write, but the readiness terminology makes that distinction unclear.

### 3. Readiness and authorization are correctly separate internally but confusing publicly

During this audit:

- `obsidian_doctor` reported Hermes curation technically ready;
- `memory_curator status` reported Hermes curation rollout-disabled.

Both are true: the provider can curate, but canonical-memory policy does not authorize the result. The public surfaces need consistent labels such as:

```text
providerReady=true
advisoryDraftAllowed=true|false
canonicalPromotionAllowed=false
automaticMutationAllowed=false
```

`docs/extension-portfolio/obsidian.md` also says Hermes memory is canonical for automatic project recall, contradicting `README.md`, `docs/project-memory-operations.md`, and the current implementation contract that Obsidian project notes are canonical.

### 4. Hermes does not currently create skills

There is no Hermes call in `src/skill-synthesis.js`, `src/skill-intake.js`, or skill governance. Hermes can indirectly contribute to a successful `/goal` execution whose settled metadata becomes a capture, but synthesis itself is local and explicit.

The current substrate is still valuable:

- normalized public execution captures;
- deterministic scoring and clustering;
- candidate-only synthesis;
- shared durable-content scanning;
- exact-version governance;
- independent advisory/routing/publishing approvals;
- explicit topology rendering and rollback;
- native Agent Skill discovery.

The gap is the last mile: converting repeated verified captures into a high-quality, standard `SKILL.md` candidate, using Hermes as a bounded drafting/review assistant, then validating and promoting it through the existing managed skill workflow.

### 5. Inventory volume is not evidence of compounding

The store has 36 approved imported/curated records but only four execution captures and no synthesized records. There are 552 evaluation rows and 1,330 update events, yet the exact-version field cohort is empty. This makes activity look richer than evidence actually is.

The C5 memory/learning compounding experiment remains `NULL-RESULT`, and the E3 parallel-evidence experiment remains `NULL-RESULT`. This audit did not launch either experiment and does not change their verdicts.

## Target architecture

Add one Hermes advisory adapter behind `src/integration-boundary.js`, backed by the existing shared client and readiness modules:

```text
HermesAdvisoryAdapter
  assistant.plan/review/decide      -> typed, read-only public artifact
  memory.curateCandidate            -> bounded candidate, never direct authority
  skills.draftCandidate             -> quarantined Agent Skill draft

All operations
  -> current binary/provider/model readiness proof
  -> operation-specific timeout/backoff/cancellation
  -> provider-input privacy scan and bounded packet
  -> typed output schema
  -> output safety scan
  -> metadata-only receipt/telemetry
  -> owning subsystem's existing governance gate
```

Hermes should never own canonical project memory, approve a skill, install a skill, publish, apply a patch, or declare completion without harness evidence.

## Prioritized implementation plan

### Phase 0 — Make the boundary truthful and safe

**Priority:** P0
**Goal:** Remove competing memory authority and close provider-input/privacy inconsistencies before adding capabilities.

1. Add a `HermesAdvisoryAdapter` to `src/integration-boundary.js` using `src/hermes-client.js` and `src/hermes-readiness.js`.
2. Route goal, prompt-suggestion, and Obsidian Hermes calls through the adapter.
3. Remove direct Hermes subprocess calls from extensions, including goal diagnostics.
4. Remove the legacy `extensions/hermes-memory` conversation writer/recall authority rather than retaining compatibility shims:
   - remove transcript-based `/hermes-sync`;
   - remove unscanned `/hermes-note`;
   - remove legacy conversation recall injection and its automatic flags;
   - retain no writable fallback cache as a second authority.
5. Apply the shared durable-content scanner to both provider input and model output. Provider packets must exclude full transcripts, prompts, command/tool payloads, secrets, absolute paths, and raw logs.
6. Split technical readiness from advisory-draft and canonical-promotion authorization in every status/doctor response.
7. Correct stale documentation, especially `docs/extension-portfolio/obsidian.md` and command descriptions that call legacy conversation state canonical memory.

**Acceptance bars**

- Zero Hermes subprocess consumers outside the shared adapter/client implementation.
- Zero forbidden fields in deterministic provider-packet fixtures.
- Goal, prompt, Obsidian, cancellation, timeout, backoff, and missing-provider tests pass through one contract.
- Obsidian Doctor, Memory Curator, and Memory Explorer report the same project/vault identity and clearly separated readiness/authority states.
- Removing the legacy bridge leaves canonical local recall and explicit Obsidian operations working end to end.

### Phase 1 — Productize Hermes as an explicit advisory assistant

**Priority:** P1
**Goal:** Expose Hermes' useful reasoning without making it a second primary agent or mutation authority.

1. Add an explicit user-intent-gated assistant surface with typed operations:
   - `plan` — return a bounded public plan;
   - `review` — review supplied evidence/artifacts;
   - `decide` — emit the existing goal action schema;
   - `summarizeEvidence` — summarize evidence references, not raw transcripts.
2. Keep it read-only initially. Do not expose arbitrary shell/tool authority to Hermes.
3. Move `/goal` onto this surface and preserve evidence-ID completion, action authority, cancellation, prompt caps, and policy gates.
4. Keep prompt suggestions local-first. Hermes remains a later refinement only after the existing acceptance/failure policy allows it.
5. Record metadata-only operation, schema validity, latency, timeout/failure category, repair-turn count, user acceptance, and terminal result.

**Acceptance bars**

- Deterministic schema, cancellation, timeout, privacy, and no-mutation fixtures: 100% pass.
- At least 30 exact-version live read-only assistant calls across at least 10 independent sessions and 14 days.
- At least 95% typed terminal validity; zero privacy or mutation violations.
- p95 assistant latency no more than the preregistered product bar and never blocks ordinary Pi prompts.
- Goal completion remains impossible without current harness evidence IDs.
- Automatic/routed use remains off until a preregistered live comparison passes. Existing E3 `NULL-RESULT` is not treated as a pass.

### Phase 2 — Make Hermes a governed canonical-memory curator

**Priority:** P1
**Goal:** Let Hermes improve memory quality while Obsidian and deterministic policy retain authority.

1. Change Hermes curation to emit a typed project-memory candidate packet containing:
   - project key and memory kind;
   - concise candidate content;
   - source hashes/evidence IDs;
   - confidence, verification label, expiry, and conflict hints;
   - no source bodies or full paths.
2. Make curation dry-run by default. A write requires explicit current-user apply intent and the rollout stage that authorizes reviewed Hermes curation.
3. Send only scanner-approved, bounded source extracts to Hermes. Unsafe source notes are skipped with reason codes, never reproduced in receipts.
4. Run deterministic dedupe, conflict, integrity, and shared safety checks after Hermes returns.
5. Submit accepted output to the existing project-memory review/save path; do not write a parallel Hermes memory hierarchy.
6. Compile recall only from canonical Obsidian state and current Git facts.
7. Emit a metadata-only curation receipt linking input source hashes, Hermes identity, output hash, review decision, and canonical revision.

**Acceptance bars**

- Existing deterministic precision/recall/contamination/latency bars continue to pass.
- At least 20 real fixture-vault curation attempts with zero privacy violations and passing idempotency/conflict/concurrency checks.
- At least 30 exact-version uses across 10 sessions and 14 days before any automatic behavior.
- Explicit-save precision at least 0.95; automatic-save precision at least 0.98 before automatic upsert is considered.
- Zero cross-project contamination and zero stale current-fact recalls.
- M0 remains the effective production stage until the existing scorecard authorizes a higher stage.

### Phase 3 — Add Hermes-assisted automatic skill drafting

**Priority:** P2
**Goal:** Automatically create reviewable Agent Skill candidates from repeated verified work, without automatic installation or publication.

1. Keep `src/skill-synthesis.js` as the deterministic capture, clustering, scoring, and governance authority.
2. Raise normal candidate eligibility from one capture to at least three compatible verified captures across at least two independent sessions. Permit one-off generation only as an explicitly labeled insufficient-evidence preview.
3. Feed Hermes a bounded public skill packet only after deterministic eligibility passes:
   - workflow steps and allowed tool names;
   - verifier/evidence references;
   - failure-pattern summaries;
   - environment/compatibility facts;
   - no prompts, transcripts, command arguments, raw output, private reasoning, secrets, or absolute paths.
4. Ask Hermes to draft a standard Agent Skills package:
   - strict lowercase/hyphenated name, maximum 64 characters;
   - specific description, maximum 1,024 characters;
   - `SKILL.md` with clear trigger boundary, workflow, verification, failure handling, and relative references;
   - optional scripts/references only when captures prove they are needed.
5. Write drafts only to a private quarantined candidate area that Pi does not auto-discover.
6. Reuse existing skill intake, shared content scanner, exact-version governance, independent reviewer/verifier, and managed skill installer.
7. Promotion to tracked `skills/<name>/SKILL.md` requires explicit current-user approval. Installation uses the existing validated refresh/install workflow.
8. Never let Hermes approve, install, route, publish, add dependencies, or write executable topology authority.
9. Reduce noisy `skill.updated` writes from advisory retrieval and distinguish inventory activity from qualified field use.

**Acceptance bars**

- 100% Agent Skills schema/frontmatter/relative-link fixtures pass.
- Zero unsafe instructions, forbidden fields, unpinned external sources, or automatic writes to loaded skill locations.
- Every candidate links to exact capture IDs, skill source hash, verifier evidence, and Hermes identity.
- Independent review catches all seeded unsafe, overbroad-trigger, missing-verification, and unsupported-workflow cases.
- Candidate exact-version success rate exceeds control by at least 0.05, or unsupported-claim rate improves by at least 0.05.
- Candidate p95 duration, model calls, tool calls, and context added each remain within 110% of control.
- The existing C5 experiment must pass before automatic candidate drafting is enabled by default. C5 `NULL-RESULT` remains blocking.

### Phase 4 — Consolidate measurement and rollout

**Priority:** P2
**Goal:** Make capability claims depend on measured outcomes rather than feature inventory.

1. Add one Hermes integration scorecard with separate sections for:
   - assistant validity/usefulness/latency;
   - memory precision/recall/staleness/curation decisions;
   - skill candidate quality/adoption/exact-version outcomes;
   - privacy and authority violations.
2. Count explicit user acceptance and settled task outcomes; do not treat retrieval, display, or generated inventory as success.
3. Deduplicate event writes and publish clear denominators: eligible, attempted, succeeded, accepted, promoted, and field-proven.
4. Keep experiments preregistered. Report `insufficient-data` or `NULL-RESULT` when temporal, sample, review, or exact-version requirements are absent.
5. Add an operator dashboard that distinguishes technical readiness, authorized capability, measured efficacy, and current rollback control.

## Verification sequence for implementation

Run checks from narrowest to broadest:

1. Hermes adapter/client/readiness unit tests.
2. Goal, prompt-suggestion, Obsidian, memory-safety, and skill-synthesis focused tests.
3. Extension import-boundary and extension-load tests.
4. Hermes regression and isolated extension RPC/TUI smokes.
5. Project-memory synthetic scorecard and privacy/static checks.
6. Full `scripts/check-all.sh` gate.
7. Bounded live read-only probes.
8. Only then, preregistered exact-version field cohorts.

A failed live provider run is an infrastructure or domain result, not permission to weaken schemas, privacy checks, or authority gates.

## Non-goals

- Making Hermes the canonical memory store.
- Sending full sessions or vault files to Hermes.
- Replacing Pi's primary coding model with nested Hermes calls.
- Automatic skill approval, installation, dependency installation, routing, topology execution, Git commit, or publication.
- Treating deterministic fixtures, imported skill count, generated drafts, or event volume as field efficacy.
- Launching or relabeling the open E3 or C5 experiments from this audit.

## Completion definition

The integration is successful when:

1. every Hermes call uses one readiness/privacy/schema contract;
2. Hermes assistant operations are typed, read-only by default, and field-measured;
3. Hermes memory output enters only the canonical Obsidian candidate/review path;
4. no legacy conversation/cache path competes with canonical memory;
5. repeated verified executions can produce a standard, quarantined Agent Skill candidate;
6. skill promotion remains explicit and exact-version evidence-backed;
7. all three capability dashboards show qualifying field evidence rather than `insufficient-data` or `NULL-RESULT`;
8. privacy, responsiveness, project isolation, rollback, and evidence-bound completion bars remain intact.

## Primary implementation references

- `src/hermes-client.js`
- `src/hermes-readiness.js`
- `extensions/hermes-memory/index.ts`
- `extensions/prompt-suggestions/index.ts`
- `.pi/extensions/goal/goal-runner.js`
- `src/obsidian-adapter.js`
- `src/integration-boundary.js`
- `src/project-memory-store.js`
- `src/skill-synthesis.js`
- `src/skill-intake.js`
- `.pi/extensions/reasoning-runtime/index.ts`
- `docs/project-memory-operations.md`
- `docs/skill-synthesis.md`
- `docs/memory-effectiveness-scorecard.json`
- Pi Agent Skills contract: `$PI_SOURCE_ROOT/packages/coding-agent/docs/skills.md`
