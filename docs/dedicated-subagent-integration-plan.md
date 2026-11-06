# Dedicated subagent integration plan

Status: **M0–M4 implemented with provider-free acceptance; M5 live comparison unrun**.

The user revised the specialist workflow: no task/run budgets or correction caps;
inherit the parent model and thinking effort; record human review as non-blocking
artifact-linked feedback; no extra UI confirmation. Schema-v2 graphs/policies
remove obsolete accounting and human-acceptance fields rather than retaining a
compatibility path. Executable acceptance, isolation, cancellation, host/output
limits and separate explicit parent application remain mandatory.

Approved Blender 5.1.2 plus the full-tree-pinned BlenderAI add-on now pass real
contained task acceptance: canonical dispatch, editable native/GLB export,
nonempty CPU preview, three-frame animation agreement and negative cases.
Lean 4.29.1 kernel replay/exact target/axiom/import checks and REA 6.5.0 authorized
static observations/independent reproduction also pass under schema v2. These
provider-free fixtures do not establish live-model quality or arbitrary domain
capability. Human visual sign-off is no longer a blocker.

The topology TUI false-pass repair and its earlier passing evidence remain
retained. Manual topology/task tools are enabled in canonical defaults. Optional
project policy configures checkers only; missing policy supplies dossier checking.
Start a new Pi process for changed defaults; existing process overrides remain
authoritative. Automatic routing stays off; apply and publish remain separate.
Manual use is not contingent on the matched benchmark. Live comparison still
requires frozen tasks, parent inference identities, metrics and retention space,
not a reintroduced inference budget. No live providers were used for this revision.
Current operator reference: [Explicit specialist tasks](specialist-tasks.md#normal-session-use).

### Revised acceptance requirements

R1–R6 retain their original deliverable identities. R2 correction is uncapped;
R4 accepts executable criteria and keeps subjective feedback separate; R5 tracks
observed usage and host resources, not task/run cost ceilings. G4/G7 therefore
check immutable correction lineage, cancellation/recovery and host admission,
not inference-budget exhaustion. G9 includes BlenderAI animation round-trip;
subjective review cannot block or satisfy its executable checks.

The design below preserves the original planning snapshot and proposed gates.
Its budgets, human-approval requirements and bounded-correction wording are
superseded by the revised requirements above; historical availability statements
are not current readiness evidence.
Evidence collected: 2026-10-16. Repository snapshot: `a530e07`, `main`, with 39 pre-existing changed paths. Source findings below describe the inspected working tree, not just HEAD. Revalidate those surfaces before implementation; do not overwrite concurrent work.

## 1. Recommendation and scope

Build a **contract-driven specialist layer on the existing Roles v2 runtime and topology DAG**, not another agent framework. The parent owns scope and deterministic scheduling. Specialists produce bounded artifacts. Independent checks evaluate those exact artifacts. A deterministic acceptance gate—not a model vote—decides whether declared criteria are satisfied.

Start with a working vertical slice: **planner → coder → artifact gate → independent verifier → acceptance**. Then add bounded correction, isolated multi-patch integration, and domain specialists. Preserve manual delegation and disabled automatic routing until separate evidence supports promotion.

Required outcomes for an eventual implementation:

| ID | Outcome |
|---|---|
| R1 | Discoverable, versioned contracts for implementation, independent verification, integration, mathematical research, 3D modeling, and reverse engineering; explicit unavailable status when required tooling is absent. |
| R2 | Explicit dependency DAG and deterministic task/attempt lifecycle, including artifact prerequisites, bounded correction, cancellation and restart reconciliation. |
| R3 | Separate workspaces for independent changes, immutable proposals, read-only review, and separately authorized parent application. |
| R4 | Executable acceptance criteria and current artifact-bound evidence; partial, missing, stale or interrupted evidence cannot pass. |
| R5 | Evidence-preserving context transfer, shared bounded repository orientation, privacy-safe accounting, and run-wide cost/resource budgets. |
| R6 | Session-informed role selection, provider-free conformance tests, and separately approved staged field evaluation with honest limitations. |

Non-goals: recursive delegation; an agent chat room; autonomous role creation or skill installation; automatic memory writes; automatic commit/push/deploy; changing models or global routing merely because a role exists; repairing unrelated failures; broad replacement of the reasoning, roadmap, verification or process-control systems. This plan does not resume the separate I2 work or consume any open experiment's attempts.

## 2. What already exists—and the actual delta

| Inspected evidence | Existing capability | Planned delta |
|---|---|---|
| `src/role-contracts.js`, `src/role-result-schemas.js` | Fourteen source-defined contracts, policies, budgets and typed submissions. Includes `coder`, `verifier`, `reviewer`, `patch-reviewer`, `planner`, `researcher`, `benchmark`, `evidence-auditor`, and handler-only roles. | Add domain contracts and explicit task inputs/artifact/acceptance bindings. Reuse canonical IDs; “implementation engineer” describes `coder`, not a duplicate alias. |
| `src/multi-agent-topologies.js`, `src/role-topologies.js` | DAG execution, dependency projection, all/quorum/min-success joins, node retries, cancellation and typed verifier verdict gating. | Add task-level artifact prerequisites, correction ownership and acceptance receipts. Node retry is not equivalent to returning failed verification to its implementer. Required acceptance must not use voting, degraded joins or a successful advisory fallback. |
| `src/plan-fanout.js` | Bounded worker specs and waves inferred from Markdown verbs, phase headings and exact file tokens. | Treat inference as a proposal. Execute a validated explicit task graph with dependencies and path ownership; text heuristics cannot establish semantic independence or complete scope. Report every omitted item. |
| `src/subagents.js`, `src/subagent-lifecycle.js`, `extensions/role-sidecar/index.ts` | Detached RPC sidecars, preflight, constrained child tools, typed terminal result, depth-one delegation, immutable settled attempts and bounded execution. | Attach stable task/attempt/contract/artifact identities; retain one launch path. Add only narrow, reviewed domain capabilities. |
| `src/subagent-workspaces.js` | Detached worktrees; inherited dirty baseline; hash-checked upstream patch seeding; retained recovery captures. | Explicit task read/write zones, pinned dependency closure, deterministic multi-proposal composition and independent verifier snapshots. Test cumulative patch ancestry/deduplication, not only individual seeds. |
| `src/subagent-patches.js` | Separate preview/apply; stale-parent and hash checks; explicit apply and post-apply verification with rollback. | Bind acceptance to the combined proposal and required post-apply checks, not just patch syntax. Preserve this application boundary. |
| `src/verification-pipeline.js`, `src/verification-oracle.js`, `src/evidence-binder.js`, `src/tree-fingerprint.js` | Verification graphs, proof persistence, frozen command selection, source fingerprints, evidence validation. | Reuse these mechanisms through an adapter for specialist tasks. Do not build a second proof store. Add task/criterion/artifact coverage and domain evidence; do not assume every existing oracle policy fits every task. |
| `src/integration-boundary.js`, `.pi/extensions/reasoning-runtime/index.ts` | Boundary-backed subagents/topologies, role discovery, parent-owned roadmap application/reconciliation. | Expose task planning/status/evidence through these boundaries; library code stays Pi-independent. Keep model-side reasoning canonical. |
| `config/harness-defaults.env` | Roles v2, isolated mutation and explicit R5 configured; topology execution `0`, auto-route `off`, worker canary `0`, local RPC concurrency `2`. | Do not confuse configured stage with measured eligibility. Keep defaults unchanged during development; explicit enablement is a later decision. |

Important qualifications:

- The live `run_topology roles` inspection produced no listing in this session. The inventory above comes from source; it does not prove current live availability.
- The executor already passes upstream workspace patches to downstream roles, and a `verifier` must report `verification.status=passed`. The missing design is a **uniform artifact/criteria/evidence acceptance contract**, not the complete absence of verification or patch transfer.
- `src/verification-oracle.js` supplies useful command/proof checks, but its existing coverage policy is workflow-specific. For this plan, every required criterion needs explicit coverage; one broad command counts only when the frozen manifest declares that coverage.
- Git worktrees isolate changes, **not operating-system capabilities**. Process separation and tool-name allowlists are not a security sandbox for shell commands, repository test scripts or binary parsers.
- Some narrative sections of `docs/multi-agent-topologies.md` describe earlier defaults. Resolve configuration from current code/effective preflight; reconcile affected documentation during implementation.

## 3. Session mining: observations, not invented demand

### Bounded fresh scan

Private local artifacts:

- `.pi/planning/dedicated-subagents/session-demand-scan.py`
- `.pi/planning/dedicated-subagents/session-demand.json`

One read-only scan selected up to four recent eligible files per session-directory group, round-robin, within a 90-day window. Limits were 120 files / 96 MiB total / 16 MiB per file / 1 MiB per JSONL row. It excluded the current session and files modified in the preceding ten minutes. Only user text was lexically classified in memory; assistant tool names were counted against a fixed allowlist. No prompts, excerpts, private reasoning, tool arguments/results, session IDs or project paths were persisted.

Observed: 1,919 discovered files; 392 eligible after age/active/size exclusions; 120 selected across 111 directory groups; 100,143,178 bytes read; 331 user messages and 228 normalized unique user texts. There were 28 explicitly interactive sessions and 92 of unknown kind. Eighty-six oversized files and seven oversized rows were excluded. The report records the regexes, bounds and source-set digest.

| Lexical topic | Sessions with a match | Unique matching user texts |
|---|---:|---:|
| Verification/review | 20 | 74 |
| Documentation/planning | 9 | 18 |
| Integration/migration | 8 | 12 |
| Debugging/reliability | 7 | 11 |
| Security/privacy | 6 | 7 |
| Implementation | 5 | 10 |
| Experiments/performance | 4 | 11 |
| Visual/media | 2 | 4 |
| 3D assets | 1 | 1 |
| Mathematical/formal research | 0 | 0 |
| Reverse engineering | 0 | 0 |

Tool signals include `test_runner` 185 calls across 18 sessions, `gitverify` 99/15, `debug_ledger` 64/7, `bg_run` 431/20 and `create_subagent` 2/2. These are invocation counts, **not independent tasks, successful outcomes, or evidence of delegation benefit**. Multi-label categories overlap. Directory groups are not necessarily distinct human projects. Unknown session kinds may include unmarked synthetic runs. Historical branch entries, repeated requests and unrecognized injected text can bias counts. No representative frequency ranking is claimed; zero matches do not remove requested roles.

### Historical corroboration

The existing aggregate `.pi/session-mining/latest.json` was generated on 2026-08-23, not today: 124 sessions, 434 user turns, 36,797 tool calls. It includes 1,218 `debug_ledger`, 188 `experiment_ledger`, 659 `run_deck`, and 230 `create_subagent` calls. Preserve its canonical outcome distinctions; a failed test or policy block is not automatically a harness defect.

`docs/subagent-reliability-investigation-2026-08-17.md` reports historical budget, typed-result and timeout failures, and a separate successful 30-run worker pilot. Those cohorts predate current source/profile defaults and are not current fleet reliability evidence. They motivate submission reserves, exact provenance, honest time accounting and staged evaluation—not larger budgets by default.

### Candidates justified by this evidence

- **Reliability investigator:** strongest additional distinct workflow; separates diagnosis from code repair, uses prior-attempt evidence and bounded reproductions.
- **Security/privacy reviewer:** narrow independent review rather than another general coder.
- **Experiment/performance analyst:** preregistration, comparable metrics, uncertainty and resource accounting; no automatic reruns.
- **Repository scout:** a cheap bounded orientation role using existing `worker`/`researcher`; avoids every specialist repeating discovery.
- **Documentation/contract maintainer:** initially a scoped `coder` specialization, not a separate runtime role. Promote only if its output/evidence contract is genuinely different.
- **Visual/asset validator:** useful alongside 3D modeling; deterministic asset checks plus explicit human aesthetic acceptance, not a model-only taste vote.

For later promotion, extend the existing `src/session-miner.js` workflow with reviewed task-family labels and session-kind separation. Sample older and oversized real tasks under a new explicit bound; distinguish task intent from topic mentions. Freeze a manually reviewed, privacy-safe task manifest before using counts to enable routing. Repeated tool sequences can warrant a tool or skill, not necessarily another model agent.

## 4. Contract model

Keep **three distinct concepts**: reusable role capability, assigned task, and immutable execution attempt. A display name/personality is not an enforcement mechanism.

### Role contract

Extend the existing validated contract rather than adding a parallel registry:

- Stable role ID, contract/schema revision and complete execution-policy digest.
- Objective, non-goals, accepted task kinds and mandatory input schema.
- Tool/command capabilities; permitted artifact types; workspace, read/write path, network and external-resource policy.
- Model and thinking policy resolved before launch, with no silent substitution.
- Context projection and evidence obligations; output schema and completion conditions.
- Per-attempt budgets plus task/run ceilings; allowed correction policy.
- Availability prerequisites and fixed reasons for unavailable/blocked status.

The digest must cover every execution/acceptance-affecting field, including completion policy, input schema, verifier configuration and pinned guidance. Existing `roleRevisionHash()` coverage must be evaluated and extended accordingly. A task may narrow capabilities; model instructions and graph edges cannot widen them.

### Task specification

Proposed shape, not an existing public API:

```text
TaskSpec
  taskId, requirementIds[], roleId, contractRevision
  objective, exclusions[], taskKind
  dependsOn[{taskId, requiredArtifactKind, readinessCondition}]
  readZones[], writeZones[], baseRevision, baselineFingerprint
  inputs[{artifactId, digest}], contextPacketId
  acceptanceCriteria[{id, kind, verifierId, expected, required}]
  budgets{attempts, modelCalls, toolCalls, wallTime, tokens, cost, storage}
  correctionPolicy{ownerTaskId, maxCorrections}
```

Each criterion specifies executable checks where possible, environment/toolchain identity, and required coverage. Subjective visual or informal research criteria explicitly name human review; they are not silently converted into automated success. Unknown cost/usage is reported as unknown, never zero. If an authorized hard spend ceiling cannot be bounded for a provider, launch is blocked pending a decision.

### Artifact and evidence manifests

Use existing bounded artifact/evidence storage and references:

- Artifact ID/kind; producing task, attempt and contract; content digest/size; dependency digests; baseline; relative-path/content manifest; completeness/disposition.
- Separate artifacts for source patch, integrated patch, research dossier, formal certificate, asset bundle, analysis report and verifier receipt.
- Verifier receipts emitted by trusted execution code, not manufactured by the agent: criterion IDs, artifact digest, source/environment/command fingerprints, start/end, exit code/signal, proof/log reference, result and freshness.
- Model reports reference receipts. `summary`, a typed `passed` string, a zero exit from the agent process, and agreement between reviewers are insufficient acceptance evidence.
- Optional improvements remain separate from required criteria. Changing acceptance criteria creates a reviewed contract revision; it cannot retroactively make a failure pass.

Return useful public assumptions, definitions, reasoning summaries, counterexamples and evidence—not private chain-of-thought. A research dossier must preserve claim → assumption → source/locator → limitation links. A short summary is an index, not the only surviving evidence.

Schema changes require updating every producer/consumer and tests together. Preserve old evidence bytes as historical records; do not add a second live execution path or silently reinterpret old packets as current evidence.

## 5. Deterministic lifecycle and dependency scheduling

Keep existing subagent states as **attempt transport states**. Add a small task-state module consumed by the existing topology executor, not a second scheduling engine.

```text
planned → dependency-blocked / ready → implementing → artifact-ready
                                                      ↓
                                      reviewing + verifying
                                                      ↓
                                     accepted-proposal / correction-needed
                                                              ↓
                                                   new implementation attempt

accepted component proposals → integrating → artifact-ready
                                            → final review + verification
                                            → accepted-proposal
                                            → explicit apply → post-apply checks
                                            → accepted-applied
```

Research/analysis tasks use `producing` in place of `implementing`; they still require a real report/dossier artifact before verification. Verification of an already existing change requires an explicitly pinned baseline artifact. Do not manufacture edits just to satisfy a transition; retain the runtime's validated `baseline-satisfied` disposition with fresh criterion-bound evidence.

### Transition guards

| Transition | Required deterministic guard |
|---|---|
| Planned → ready | Valid acyclic graph; registered available role; complete inputs/criteria; authorization and aggregate budgets; required predecessor conditions satisfied. |
| Ready → implementing | Workspace lease and pinned baseline/dependency closure acquired; no unauthorized overlapping writes; parent roadmap binding exists. |
| Implementing → artifact-ready | Worker settled, process closed, runtime captured and validated the artifact, required files exist, manifest/digests match. A prose claim is insufficient. |
| Artifact-ready → review/verification | Exact immutable artifact snapshot materialized; required checks frozen; complete input manifest. No implementation artifact means no verification launch. |
| Review/verification → accepted-proposal | All required receipts current and passing, required review dispositions resolved, complete criterion coverage, no unresolved blockers or mutation violations. |
| Failed check → correction-needed | Preserve failed receipts and artifact; identify owning producer; allocate only a remaining correction attempt. Infrastructure failures remain distinct. |
| Accepted proposal → application | Separately explicit user/parent authorization; current hash-checked preview and unchanged parent baseline. |
| Application → accepted-applied | Required post-apply checks pass on the actual parent state; otherwise restore owned touched paths and report failure without overwriting concurrent edits. |

Task acceptance and transport success remain separate in UI, metrics and roadmap. For a code change whose requested outcome is application, `accepted-proposal` is not completion. A domain task may legitimately complete as an accepted report or asset proposal when that is its requested outcome.

### Correction, cancellation and recovery

- Proposed default: initial implementation plus **at most two correction attempts per task**, and zero automatic retries for infrastructure/provider failure. These are proposed defaults for approval, not changes to existing experiments.
- Correct the producer, not the verifier. The verifier cannot edit source, alter expectations, weaken tests or consume correction budget by rerunning unchanged output until it passes.
- Model submission-format correction stays within the existing model-call budget and is distinct from product correction. All retries/continuations consume the original task/run ceiling; no reset through a new ID, role or fallback topology.
- Keep the graph acyclic by expanding a new versioned attempt subgraph with fresh IDs after an authorized failure transition; do not insert unrestricted backward conversational edges. Required descendants of changed artifacts become stale and are recomputed; independent valid work remains reusable.
- A correction packet contains failing criterion/receipt IDs, observed facts, artifact identity, scope and remaining budget. It does not transfer a verifier's private trajectory.
- Cancellation stops queue admission and owned child groups; settle once after process close. Resume reconciles persisted events/leases and creates linked attempts. Interrupted or ambiguous work is not success. Acceptance/apply events are idempotent and compare expected state revisions to prevent double settlement.

### What can run in parallel?

Parallelize only nodes whose inputs are ready and whose effects/resources do not conflict. Different files alone do not establish independence: shared interfaces, schemas, generated outputs, dependency locks, fixtures, ports and GPU/DB resources matter.

```text
scope / acceptance manifest
        ├─ API implementation ── artifact ── component checks ─┐
        └─ independent UI change ─ artifact ─ component checks ├─ integrator
                                                             └─ combined artifact
                                                                    ├─ patch-reviewer
                                                                    └─ verifier
                                                                          ↓
                                                               deterministic acceptance
```

If the UI requires the new API, add an explicit API artifact dependency; do not pretend the branches are independent. Review and executable verification can run concurrently on separate snapshots of the same digest. Protected mutation, verification, integration and acceptance joins require **all** mandatory inputs. Partial research can be returned as partial, never promoted to complete acceptance.

## 6. Isolation and integration

- Every coding attempt owns an isolated worktree. Read-only roles have no mutating tools. Reviewers inspect the submitted candidate, not the untouched parent tree; reuse `patch-reviewer` for isolated proposals.
- Workspace acquisition pins the exact inherited dirty baseline. Other workers' proposals become visible only through declared immutable dependencies. Unexpected paths fail capture; unknown write zones block admission until clarified.
- The integrator receives accepted proposals plus their dependency/ancestry manifests, composes them in deterministic order in its own worktree, resolves only declared integration issues and returns **one combined proposal**. It cannot accept itself or silently apply to the parent.
- Do not repeatedly apply individual worker patches to the parent: the first application invalidates other previews. Do not apply a cumulative downstream patch and its ancestor twice. Test shared-base, stacked, duplicate and conflicting patch cases explicitly.
- Content conflicts, contract conflicts and required behavioral failures return to the appropriate producer. A material integration edit invalidates prior evidence for affected criteria; final tests run on the combined result even if all components passed individually.
- Restrict child environment, inherited secrets, filesystem visibility and network according to contract. Use existing containment/resource code where sufficient; fail preflight where enforcement is unavailable. For arbitrary commands or untrusted binaries, require an actual sandbox/contained runner, not a worktree safety claim.
- Continue current hash-checked parent application. Serialize owned applies and recheck baseline under the apply lease. Rollback must not clobber unrelated concurrent edits.
- Git-only mutation remains the initial supported boundary. For 3D files, use existing bounded binary-patch support when practical. Oversized/non-Git asset tasks remain explicitly unavailable until a tested owned asset-workspace/manifest-transfer capability exists; never silently raise caps or copy an entire asset library.

## 7. Role catalog and concrete contracts

“Stage” below means implementation order, not permission to run. Requested domain roles remain required scope even when their tools or evaluation decisions block activation.

| Role / canonical ID | Inputs and deliverable | Capabilities and exclusions | Acceptance / stage |
|---|---|---|---|
| Implementation engineer / existing `coder` | Task, pinned baseline and dependencies → bounded patch, tests, change manifest, residual risks. | Isolated worktree; assigned writes only. No parent application, acceptance, nested delegation or unrelated cleanup. | Actual artifact + independent required checks; core. |
| Independent verifier / existing `verifier` | Frozen candidate/criteria → executable receipts and coverage verdict. | Separate candidate snapshot; approved verifier commands; no edit/write/arbitrary shell or repairs. | Trusted receipts match exact candidate; core. |
| Integration engineer / new `integrator` | Accepted proposals and interface contracts → combined patch, conflict resolutions and integration manifest. | Isolated worktree; integration-only modifications. Cannot waive failures, accept itself, commit/push or apply parent changes. | Independent combined-tree review/tests; core after single-task slice. |
| Mathematical researcher / new `mathematical-researcher` | Precise question, definitions, known results → claim ledger, derivations, assumptions, counterexamples, proof obligations and citations. | Read-only research plus explicitly approved contained math-check tools. Repository/proof writes remain a separate scoped coding task. No claiming numerical evidence is proof. | Machine-check formal certificates when required; informal results explicitly qualified and independently reviewed. Missing proof checker blocks a formal-proof criterion; domain stage. |
| 3D modeling specialist / new `3d-modeler` | Brief, units/axes, formats, scale, topology/poly/texture budgets, approved source assets → editable asset, export, manifest and bounded previews. | Isolated owned asset/Git workspace; narrow DCC runner. No unapproved downloads, plugin installs, external assets or parent writes. | Open/reimport/export checks; required geometry/material/rig metrics; reference views and explicit human aesthetic approval when specified; domain stage. |
| Reverse engineer / new `reverse-engineer` | Authorized target, hash/format, question and permitted techniques → format/interface map, behavioral observations and reproducible fixtures. | Static analysis by default; bounded analyzers in containment. No executing unknown code, network probing, bypass activity or dynamic instrumentation outside separately authorized scope. | Traceable offsets/symbols, reproducible parser/round-trip tests against approved fixtures; hypotheses distinct from observed behavior; domain stage. |
| Planner / existing `planner` | Scope and evidence → explicit graph, criteria and `roadmapPlan`. | Read-only; proposes but never mutates roadmap/authorization. | Parent validation before any implementation; core. |
| Patch reviewer / existing `patch-reviewer` | Exact candidate → severity-ranked findings and criterion-linked dispositions. | Read-only candidate workspace; cannot silently fix implementation. | Findings resolved or explicitly dispositioned; tests still decide executable criteria; core. |
| Repository scout / existing `worker` or `researcher` | Narrow repo question → source map and reusable context packet. | Bounded read-only inspection; no free-form exhaustive audit. | Paths, freshness and uncertainty; select only when saved discovery exceeds dispatch overhead. |
| Reliability investigator / proposed `reliability-investigator` | Reproducer, prior attempts and logs → measured mechanism, hypothesis/attempt ledger and correction recommendation. | Read-only investigation; approved bounded diagnostic commands. Parent records ledger actions; investigator does not repair or retry forbidden attempts. | Reproducible evidence with alternatives and limitations; next evidence-led addition. |
| Security/privacy reviewer / proposed `security-reviewer` | Candidate, trust boundaries and threat scope → exploitability/privacy findings and required checks. | Read-only; approved static checks; no live attack or credential access. | Evidence-backed severity and targeted regressions; next evidence-led addition. |
| Experiment/performance analyst / existing `benchmark` with narrowed specialization | Preregistered protocol, comparable artifacts/environment → metrics, validity analysis and resource costs. | Approved measurements only; no adaptive reruns, budget changes or post-hoc ship bars. | Protocol-complete measurements, including null/failing results; next evidence-led addition. |
| Evidence auditor / existing `evidence-auditor` | Claims and original references → supported/rejected/uncertain decisions. | Evidence-only projection; no hidden worker trajectories. | Traceability and gap coverage; use on research tasks where independent audit justifies cost. |

Handler-only coordinator/acceptance logic performs graph/state decisions without a model. Do not make “integration” and “coordination” synonyms: one may write a candidate, the other enforces control rules.

Domain guidance should reuse reviewed local skills/documentation, pinned by version/hash and projected only when relevant. Current sidecars disable normal skills/extensions; **do not turn global discovery back on**. Implement explicit reviewed guidance/tool loading through the sidecar contract. Availability preflight must discover actual installed DCC/proof/binary-analysis capabilities; their availability was not tested for this plan.

## 8. Communication and overhead controls

- Parent prepares one versioned repository/context packet: scope, requirement IDs, baseline fingerprint, relevant source cards/locators, conventions, test entry points, assumptions and excluded areas. Share immutable references; workers retrieve only their dependency neighborhood.
- Refresh affected cards after changes. A stale CodeGraph/context card remains advisory; do not treat retrieval confidence as acceptance proof.
- Preserve full bounded structured dossiers outside the prompt and return a concise index. Evidence/assumption fields cannot be dropped merely to meet a summary length. Report truncation and missing inputs explicitly.
- The verifier initially sees requirements, candidate and executable checks—not the implementer's persuasive conclusion. It can inspect original evidence through stable references. Different models are optional diversity, not proof of independence.
- Parent-mediated clarification is typed and budgeted. No peer chat, sibling transcript sharing or nested spawn. Questions requiring a scope/authority decision block that task while unrelated ready work continues.
- Select the single-agent path for short or tightly coupled tasks. Dedicated roles are reusable configurations, not always-running processes or a requirement to invoke every specialist.

Approximate elapsed time with enough resources is the **DAG critical path + admission/startup/context/integration/verification overhead**. Only fully independent specialist tasks reduce the compute portion toward the longest specialist duration; serial dependencies and concurrency caps create additional waves. Tokens/cost are closer to the sum of parent, all workers, duplicated context and retries—not the longest task.

Record queue, startup, execution, verification and integration separately; total input/output/cache tokens; provider-reported cost versus unknown; model/tool calls; repeated source reads/context bytes; correction count; human interventions; and acceptance outcome. Do not claim speedup from parallel launch alone.

Reuse current process/RSS/resource guards and default local concurrency two. Freeze run-wide ceilings before launch, including queued/reserved work and all attempts. Process-local concurrency is not a host-wide capacity guarantee: multiple Pi sessions need shared resource admission through the existing guard layer, not competing ad hoc semaphores.

Storage preflight must reserve space for success artifacts, bounded corrections, failures and final verification. Proposed initial text-only pilot cap: 20 run packets / 64 MiB evidence family, with workspace allowance estimated separately before execution. Asset tasks need their own reviewed byte budget. When caps fill, stop; do not evict failures, authored assets, history or open-ledger evidence. Cleanup remains manifest-first and limited to explicitly owned disposable fixtures.

## 9. Implementation milestones and dependencies

No milestone below is executed by creation of this document. Preserve stable R1–R6 and task IDs when an implementation roadmap is authorized. Each phase becomes a roadmap milestone and its deliverables nested goals; completing a phase does not complete the parent plan.

### M0 — Pin scope, task contracts and role capability inventory

Depends on: plan approval.

- Freeze representative task fixtures, required criteria, source/config/contract identities, current known failures and storage limits.
- Specify task/attempt/artifact/receipt schemas and policy-digest coverage; expose role availability independently of execution enablement.
- Resolve phase-local decisions before work reaches them: sandbox capability, domain toolchains, asset limits and field spend. These need not block independent contract development.

Surfaces: `src/role-contracts.js`, `src/role-result-schemas.js`, `src/integration-boundary.js`, relevant docs. Proposed new narrow task-contract module only if existing schema modules would otherwise mix concerns.

Gate: schema/contract fixtures reject unknown roles, privilege broadening, missing inputs, unbound criteria and incomplete execution-policy identities. No provider calls or config enablement.

### M1 — Single-task artifact-to-acceptance vertical slice

Depends on: M0.

- Wire planner → isolated coder → runtime artifact gate → independent verifier → deterministic acceptance using existing topology/sidecar APIs.
- Bind frozen criteria and executable receipts to exact baseline/candidate/environment; support explicitly pinned inherited changes without fake edits.
- Distinguish proposed, accepted-proposal and applied states in boundary/UI/roadmap. Reuse evidence/pipeline APIs rather than adding another proof ledger.

Surfaces: `src/multi-agent-topologies.js`, `src/role-topologies.js`, `src/subagents.js`, `extensions/role-sidecar/index.ts`, verification/evidence modules, boundary adapter. Proposed `src/subagent-task-state.js` owns pure task transitions, not scheduling.

Gate: deterministic end-to-end fixture produces a patch and real local test receipts; missing artifact or merely model-declared success never starts/passes verification. Parent source/index/HEAD unchanged.

### M2 — Bounded correction and lifecycle reliability

Depends on: M1.

- Return verification failures to the correct producer with immutable failure evidence, original ceilings and at most the approved number of corrections.
- Expand versioned attempt DAGs, invalidate affected descendants, retain independent accepted artifacts, reconcile cancellation/restart and duplicate terminal events.
- Surface blocked reason, remaining budget and next owner; do not hide incomplete goals in successful subagent summaries.

Gate: failure→correction→pass, exhausted budget, infrastructure block, interruption, late result, stale dependency and resume fixtures. No test passes by weakening expected output or resetting attempts.

### M3 — Parallel implementation and isolated integration

Depends on: M2.

- Replace heuristic execution authority with reviewed explicit graph/path ownership, leaving Markdown inference as a planning aid.
- Register `integrator`; compose multi-patch dependency closures, then independently review/test the combined candidate.
- Extend containment/shared-resource admission as required by executable role policy. Enforce authorized apply with transactional checks and safe rollback.

Surfaces: `src/plan-fanout.js`, workspace/patch/containment/resource modules, role contracts, topology definitions and extension projections.

Gate: independent branches overlap in time under the configured cap; dependent branches wait; conflicting/stacked/duplicate patches are handled deterministically; reviewer cannot write; parent remains untouched until explicit application. Final combined-tree regression passes before acceptance.

### M4 — Requested domain specialists and evidence-led additions

Depends on: M1 for read-only dossiers; M3 for mutating assets and integration. Independent domain tracks may proceed in parallel once their capabilities are available.

- Mathematical research: register typed claim/assumption/proof-obligation output and checker receipts; test valid certificate, deliberate proof failure, unsupported claim and missing-checker behavior.
- Reverse engineering: register authorized-target manifests and static-analysis tooling; test a small known binary/format fixture, offset/hash provenance, round-trip behavior and blocked unauthorized execution.
- 3D modeling: register asset brief/output schemas and contained DCC operations; test a small editable asset/export/reimport, numeric bounds, missing assets and human-approval-required status. Implement bounded asset transfer if Git patch constraints are insufficient for the approved workload.
- Add reliability/security specializations when reviewed task examples confirm distinct capability/output contracts. Keep documentation/scouting/benchmark workflows on existing roles where sufficient.

Gate: every requested role has a validated contract, positive and negative provider-free fixtures, and an honest available/unavailable preflight. Operational completion also requires an actual authorized end-to-end domain task; a registered but unusable role is not a completed operational capability. An unavailable domain does not block independent roles, but remains a blocked R1 obligation until resolved.

### M5 — Evaluation, documentation and staged activation

Depends on: M1–M4 for their respective activation cohorts; all R1–R6 for full-plan closeout.

- Reconcile current registry/defaults/docs; expose graph, artifact digests, criterion coverage, costs, retries, blocks and recovery references without transcript leakage.
- Complete provider-free conformance/regression gates first. Then propose an explicit limited live evaluation with preregistered tasks, budgets, stopping rules and exact model/thinking/source identities.
- Compare matched single-agent and specialist workflows on independent and tightly coupled workloads. Include total tokens/cost, p50/p95 latency, first-pass and final acceptance, false acceptance, intervention and artifact-reproducibility rates.
- Register a new experiment only after inspecting existing experiments and obtaining live-run/spend authorization. No adaptive reruns; retain failures in assigned denominators; small samples do not establish fleet reliability.
- Proposed pilot decision: zero observed containment/false-acceptance incidents; complete criterion/receipt coverage; no quality regression on the fixed task set; latency or quality benefit within an explicitly approved total-cost ratio. Freeze numeric performance/cost bars and sample size **before** the pilot, not after results. Zero observed incidents is not proof of zero risk.

Activation order: explicit manual core workflow → explicit domain workflows → suggest-only recommendations → optional separately approved automatic routing. Enabling a role never grants parent apply/publish authority. Rollback disables launches/routing while preserving records and evidence.

## 10. Acceptance test matrix

These are proposed new/extended tests, not claims that they currently pass.

| Gate | Required behavior / likely existing suite |
|---|---|
| G1 Contracts and authority | Invalid inputs/tools/roles, stale contract digest, widening refinement and missing toolchain fail before spawn. `tests/role-contracts.test.js`, `tests/role-sidecar.test.js`, `tests/role-consumer-contracts.test.js`. |
| G2 Artifact prerequisite | Missing/empty/forged/stale artifact cannot admit verifier; real inherited baseline can. Extend topology/workspace tests and add task-state tests. |
| G3 DAG semantics | Cycles, dangling dependencies, unmet prerequisites, overlapping writers and omitted required items fail; independent tasks continue when policy permits. `tests/multi-agent-topologies.test.js`, `tests/plan-fanout.test.js`, `tests/topology-policy-conformance.test.js`. |
| G4 Correction bounds | Producer correction, distinct attempt IDs, immutable failures, no budget refresh, exact exhaustion behavior; no retries of external 429 without new authorization. Task-state and lifecycle tests. |
| G5 Isolation/integration | No parent/sibling writes; candidate reviewed rather than parent; shared-base/stacked/duplicate/conflicting patches; apply rollback preserves unrelated edits. `tests/subagent-workspaces.test.js`, `tests/subagent-patch-transfer.test.js`. |
| G6 Evidence acceptance | Agent says passed but command failed; stale/wrong digest; interrupted/cached/unproven receipt; missing criterion; changed expectation; all rejected. Valid complete current receipts accepted. Extend verification-oracle/evidence tests. |
| G7 Lifecycle/resources | Queue/startup/execution deadlines distinct; cancellation, process close, restart and duplicate terminal results settle exactly once; task/run budgets include corrections. Existing lifecycle/budget/RPC suites plus new aggregate-budget fixtures. |
| G8 Communication/privacy | Assumptions, evidence references and uncertainties survive handoff; truncated/missing evidence explicit; no prompts/credentials/private reasoning in telemetry; malicious source instructions cannot widen permissions. |
| G9 Domains | Positive/negative proof, binary-analysis and 3D asset fixtures; unavailable toolchain and subjective approval stay blocked, not passed. |
| G10 Product integration | Boundary source tests, exact enabled/disabled command behavior, roadmap reconciliation, final combined-tree checks and approved field protocol. |

Canonical regression entry point is `scripts/check-all.sh`; extended subagent/topology TUI checks are conditional on `PI_CHECK_TUI=1`. Select affected checks through `test_runner infer`, run narrow tests first, then relevant integration/full gates. Bind final `gitverify` evidence before any implementation readiness/commit claim. Use managed background execution for long suites. No tests were run merely to write this plan.

### Existing failures and experiments are constraints on interpretation

Do not rerun or “fix” these during planning:

- `full-fleet-model-smoke-blocked`: external HTTP 429; no provider switch or repeated smoke to manufacture a pass.
- `full-suite-skill-retrieval-exceeded`: preserve the original bound/assertions and partial attempt history.
- `extended-subagent-and-topology-tui`: disabled current topology configuration is part of the observed failure context. Future tests must separately assert honest disabled behavior and explicitly enabled behavior; do not silently change global defaults to pass.
- `rpc-terminal-status-fixture-expires`: preserve original failing record; no unchanged rerun.
- The two subagent deadline diagnostics have exact 20-run protocols and retained failures. Planning does not authorize a twenty-first execution or change their budgets.
- Machine-verification and retrieval experiments retain their own cohorts, ship bars and authorization. Reusing a library is not permission to alter an experiment.

If future implementation needs to address one of these, open/read its debug thread, consult prior fixes and record only a materially new evidence-backed attempt. Baseline unrelated failures remain visible; scoped checks may pass without implying the full repository passed. Full-release readiness remains blocked by any applicable unresolved required gate.

## 11. Decisions and next step

Recommended defaults for approval: reuse Roles v2 and the current DAG; manual activation; concurrency two; two product corrections maximum; separate reviewer/verifier/integrator authority; exact artifact-bound executable acceptance; no nested agents; no implicit parent apply; preserve all six requested role categories.

Before the relevant phase executes, decide:

- Which installed mathematical/DCC/binary toolchains and representative tasks define domain acceptance?
- Which containment backend can enforce filesystem/network policy for shell/DCC/analyzer execution?
- What storage, token and monetary budgets are authorized for asset tasks and live evaluation?
- Which human approval criteria apply to informal proofs and visual quality?
- Is delivery a proposal only or explicitly authorized parent application? Commit/publish remain separate.

**Next action after approval:** M0, then the M1 vertical slice. Do not start by launching a fleet or globally enabling automatic routing. Full implementation closeout must reconcile R1–R6 individually as implemented, verified, blocked or unrun; a successful first slice is progress, not completion.
