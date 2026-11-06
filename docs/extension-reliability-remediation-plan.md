# Pi extension reliability and adoption remediation plan

Status: release held — Phase 7 no-go-deferred (insufficient exact-version cohort)
Source baseline: `.pi/session-audit/REPORT.md` (2026-07-25)
Current scorecard: `docs/phase7-release-scorecard.md` (2026-07-26)

## Objective

Restore correctness in the broken extension paths, make runtime and usage telemetry truthful, reduce automatic context cost, and consolidate low-value overlap without weakening the reliable core.

The plan is gate-driven. A phase is complete only when its acceptance evidence is recorded; source availability or a green unit test alone is not enough to promote a runtime feature.

## Baseline

The audit found:

- 1,500 Pi JSONL sessions (~707 MB), with 171 likely interactive sessions after excluding the active audit session;
- 47 configured extension source files and 377 commands;
- 67 declared or conditional custom tools, approximately 64 active in a normal parent session;
- 10/10 role-v2 RPC launches since 2026-07-22 failed before the first model call;
- `semgrep_scan` at 19.2% and `semgrep_codegraph` at 42.9% historical `isError` rates;
- `obsidian_hermes` at 0/2 successful calls, while local Obsidian search/note operations were healthy;
- six nearly unused overlapping tools: `semantic_patch`, `topology_catalog`, `workflow_conductor`, `output_compactor`, `memory_curator`, and `plan_fanout`;
- ~10.36 million characters of `cognitive-automation` injections;
- incomplete inventory, command/UI telemetry, and semantic outcome accounting;
- two medium Privacy Guard findings in cognitive branch snapshots.

These are the comparison values for the post-fix cohort. Lifetime rates must not be used to judge a newly fixed implementation.

## Non-goals

- Do not auto-enable mutating role topologies.
- Do not weaken automation-loop intent or completion-promise enforcement.
- Do not treat policy blocks, not-applicable verification, or missing optional providers as crashes.
- Do not persist prompts, transcripts, reasoning, raw commands, raw tool output, credentials, or source bodies for telemetry.
- Do not remove a low-use extension solely from the historical baseline; instrument it first or document why measurement is impossible.
- Do not redesign the reliable core (`bg_run`, Git evidence, Build Runner, Roadmap, Debug Ledger, LSP, Repo Context) unless a regression test requires it.

## Success metrics

| Area | Ship bar |
|---|---|
| Role sidecar launch | 0 extension-load failures; child reaches at least one model call in live smoke; valid `submit_role_result` termination |
| Read-only role reliability | Deterministic gate passes; explicit pilot completion >=90%, timeout <=5%, p95 <=120s as required by `docs/role-runtime-benchmark.md` |
| Semantic outcome truth | 100% agreement between tool envelope status, persisted role result, `role-run`, and session-miner classification |
| Extension inventory | Configured roots, active runtime tools, conditional tools, commands, and conflicts reconcile with zero unexplained discrepancy |
| Semgrep | Default focused scan and CodeGraph supplement work from a cold config state; post-fix infrastructure error rate <5% excluding findings and policy blocks |
| Obsidian Hermes | Doctor distinguishes filesystem, desktop, Hermes binary, authentication, and curation readiness; one bounded authenticated dry run passes |
| Test Runner | No-command and no-prior-failure cases are `not-applicable`, not tool errors |
| Cognitive context | Automatic injected characters per interactive user turn fall >=60% without losing current objective/constraints or failing reasoning self-tests |
| Prompt/UI telemetry | Shown/accepted/dismissed/failed counts exist without prompt text; slash-command counts exist without arguments |
| Privacy | 0 actionable transcript/secret findings in the new snapshot and telemetry paths |
| Portfolio | Every custom tool has an owner, trigger, overlap decision, success metric, and enabled/experimental/deprecated status |

## Delivery sequence

```text
Phase 0 containment
  -> Phase 1 role-sidecar correctness
  -> Phase 2 measurement truth
  -> Phase 3 adapter reliability
  -> Phase 4 workflow semantics
  -> Phase 5 context/privacy efficiency
  -> Phase 6 portfolio consolidation
  -> Phase 7 post-fix cohort and promotion
```

Phase 2 can begin in parallel with Phase 1 after the baseline artifacts are frozen. Semgrep and Obsidian work can run in parallel once the semantic outcome schema is agreed. Portfolio removal decisions wait for Phase 2 telemetry and an observation window.

## Audit recommendation coverage

| Audit feedback | Planned response | Completion evidence |
|---|---|---|
| Broken role-sidecar lifecycle | Phases 0–1 | RPC load smoke, typed termination, role benchmark and R1 pilot |
| Semantic child failures hidden by `isError:false` | Phases 1–2 | Canonical outcome parity across tool/result/session/trace records |
| Semgrep config and doctor mismatch | Phase 3A | Cold-cache config smoke and post-fix infrastructure error rate |
| Obsidian Hermes auth/timeout blind spot | Phase 3B | Layered readiness report and bounded authenticated dry run |
| Incomplete extension inventory | Phase 2A | Settings-aware runtime/source reconciliation with zero unexplained delta |
| Missing command/UI/adoption telemetry | Phases 2B–2C | Privacy-safe command, suggestion, injection, routing, and outcome counters |
| Test Runner/automation/prerequisite misclassification | Phase 4 | `not-applicable`/`blocked` semantics and unchanged safety gates |
| Excessive cognitive injection and low router conversion | Phase 5 | >=60% character reduction plus objective/router regression tests |
| Snapshot privacy findings | Phase 5 | Privacy Guard clean scan and retention/export tests |
| Low-use overlapping tools | Phase 6 | Evidence-backed keep/merge/experimental/deprecate decision per tool |
| Need a clean post-fix comparison | Phase 7 | Versioned 14/30-day cohort scorecard |
| Reliable core should not regress | All phases/Phase 7 | Focused checks plus final full, extension-smoke, TUI/RPC, and Git gates |

---

## Phase 0 — Contain known failures and freeze evidence

Owner role: runtime maintainer
Priority: P0

- [ ] Preserve the audit report and aggregate baseline as immutable evidence references; do not copy raw sessions into the repository.
- [ ] Keep effective role rollout at R0 until a corrected role-sidecar passes deterministic and live read-only gates.
- [ ] Prevent repeated broken RPC launches during remediation: fail fast with actionable diagnostics. Do not route role-v2 commands to a “manual” path that still launches the same RPC sidecar; permit a legacy non-contract compatibility path only when its reduced guarantees are explicit and tested.
- [ ] Add the exact role-sidecar load failure to the regression fixture without storing the originating task text.
- [ ] Record source/runtime versions and configuration used for every later pilot.

Acceptance gate:

- New attempts cannot silently return a failed child as a successful tool result.
- The broken path is either repaired or explicitly unavailable with one actionable reason.
- Existing failed/timed-out role evidence and retained workspaces remain available for diagnosis.

## Phase 1 — Repair role-sidecar and subagent outcome propagation

Owner role: role-runtime maintainer
Priority: P0
Primary files:

- `extensions/role-sidecar/index.ts`
- `src/subagents.js`
- `.pi/extensions/reasoning-runtime/index.ts`
- `src/role-run-provenance.js`
- `src/role-runtime-rollout.js`

Tasks:

- [ ] Move `pi.getAllTools()` and `pi.setActiveTools()` from extension-load time to a Pi lifecycle point where action methods are legal, before provider execution.
- [ ] Verify role policy resolution still occurs before the first model request and cannot expose denied tools during the transition.
- [ ] Make child terminal status authoritative: `failed`, `timed_out`, `cancelled`, invalid output, and budget breaches must be machine-readable non-success.
- [ ] Ensure the model tool result, durable result envelope, `role-run` entry, topology node result, and trace event carry the same canonical status and termination code.
- [ ] Preserve concise public diagnostics while omitting task text, transcript, and raw child output from provenance records.
- [ ] Add a real RPC child smoke that loads only role-sidecar, reaches the provider boundary, calls allowed tools, and terminates through `submit_role_result`.
- [ ] Add negative smokes for denied tools, malformed contracts, missing required tools, cancellation, timeout, and child load failure.
- [ ] Run the deterministic role-runtime benchmark; do not advance rollout from R0 based only on source tests.
- [ ] Preregister and run a bounded explicit R1 read-only pilot after deterministic gates pass.

Targeted verification:

- `tests/role-sidecar.test.js`
- `tests/subagent-rpc-terminal-status.test.js`
- `tests/subagent-budget-enforcement.test.js`
- `tests/subagents.test.js`
- `tests/role-runtime-containment.test.js`
- `tests/role-runtime-benchmark.test.js`
- `tests/role-runtime-audit.test.js`
- `scripts/check-subagent-tui.sh`
- `node scripts/benchmark-role-runtime.js --fixture-only`

Acceptance gate:

- No action-method-during-load error.
- Exact call/result accounting and no unavailable-tool launch.
- A succeeded role-v2 run has a valid typed result and `submit_role_result` termination.
- A failed child is never counted as tool success.
- Promotion follows the bars in `docs/role-runtime-benchmark.md`; otherwise remain at R0.

## Phase 2 — Make inventory and telemetry truthful

Status: completed 2026-07-25
Owner role: observability maintainer
Priority: P1
Primary files:

- `src/extension-registry.js`
- `.pi/extensions/extension-ops-center/index.ts`
- `src/session-miner.js`
- `.pi/extensions/learning-loop-coordinator/index.ts`
- shared extension helper/event code under `src/pi-extension-kit.js`

### 2A. Runtime-backed extension inventory

- [x] Read every configured extension path from Pi settings, including explicit directories outside `<cwd>/.pi/extensions`.
- [x] Distinguish source-declared, conditionally eligible, loaded, registered, and active tools/commands.
- [x] Replace fragile registration regex as the source of truth. Prefer runtime registration metadata; retain static inspection only as advisory source inventory.
- [x] Include helper registrations such as `registerOperationTool`.
- [x] Represent env gates and child-only tools such as role-sidecar explicitly.
- [x] Report why a configured extension is inactive or degraded.
- [x] Add reconciliation tests for the two configured harness roots, helper tools, conditional sidecar tools, and duplicate detection.

### 2B. Semantic outcome schema

- [x] Define canonical outcome values: `succeeded`, `failed`, `blocked`, `not-applicable`, `cancelled`, `timed-out`, and `unknown`.
- [x] Keep transport/tool execution errors separate from valid domain outcomes.
- [x] Teach session mining to consume structured status/details in addition to `isError`.
- [x] Deduplicate tool results by call ID and flag call/result mismatches.
- [x] Separate interactive, headless smoke, deterministic fixture, and unknown sessions.
- [x] Version the classifier and record enough aggregate provenance to compare cohorts safely.

### 2C. Privacy-safe command/UI telemetry

- [x] Emit metadata-only command invocation records: extension, command ID, timestamp, success category, and version—never arguments.
- [x] Emit prompt-suggestion counters for local/Hermes shown, accepted, dismissed, retried, timed out, and failed—never suggestion text or editor contents.
- [x] Record automatic injection characters, reason, version, and whether content changed since the previous injection.
- [x] Record auto-router suggestion, user/model acceptance, execution, rejection, and final outcome links.
- [x] Add redaction and schema tests proving no prompts, paths, commands, outputs, secrets, or transcript excerpts persist.

Targeted verification:

- `tests/extension-registry.test.js`
- `tests/session-miner.test.js`
- `tests/learning-loop-coordinator.test.js`
- `tests/prompt-suggestions.test.js`
- `tests/pi-extension-kit.test.js`
- `tests/extension-telemetry.test.js`, plus existing privacy/runtime tests

Acceptance gate:

- Inventory reconciles expected configured and active surfaces with zero unexplained difference.
- Synthetic semantic failures are counted even when transport succeeded.
- Command/UI metrics contain identifiers and counts only.
- Existing session-miner privacy tests remain green.

### Phase 2 completion evidence

1. **Changed files and versions.** Base commit `d2d834e`; registry schema 2, outcome schema 1, telemetry schema 1, and session classifier `session-miner-v4`. Runtime-backed inventory, outcome classification, telemetry storage, extension command instrumentation, prompt/injection/router events, and tests changed in this phase.
2. **Focused checks.** Phase-specific unit/source checks passed, including extension registry, telemetry, session miner, learning loop/coordinator, prompt suggestions, extension kit, reasoning injection, extension loading, and productization registration coverage. The final `bash scripts/check-all.sh` gate exited 0, including all 47 RPC extension smokes, the full-fleet model smoke, prompt-suggestion TUI smoke, reasoning TUI injection smoke, and local Pi/Hermes regressions.
3. **Behavioral smoke.** A fresh full-fleet Pi process reconciled 47 configured extensions and 377 commands: 46 runtime-observed extensions, 377 registered commands, 64 registered/active extension tools, role-sidecar explicitly inactive behind `PI_ROLE_SIDECAR`, and zero degraded, conflicting, or unexplained surfaces. Fresh `/extensions-report` and `/repo-context` invocations emitted successful metadata-only records with resolved extension IDs.
4. **Privacy/static evidence.** Privacy Guard reported zero actionable or ignored findings for `.pi/extension-telemetry`; the journal is mode `0600` and contains no forbidden prompt/argument/path/output fields. Focused Semgrep over the Phase 2 implementation reported zero findings. A broad scan of all newly instrumented command files also surfaced two unchanged pre-existing findings in Roadmap and Verification Center outside the inserted one-line wrappers.
5. **Expected metric movement and bar.** Inventory achieved the preregistered zero-unexplained-difference bar. Synthetic `isError:false` domain failures are counted as semantic failures while transport errors remain separate. Command/UI telemetry is now available across all 45 command-bearing configured extension files; post-fix rates require the Phase 7 cohort window.
6. **Rollback control.** `PI_EXTENSION_TELEMETRY=0` disables telemetry writes without disabling extension behavior. When runtime metadata is unavailable, inventory degrades to explicit `unknown` rather than falling back to static claims.
7. **Residual risk.** Static env-gate discovery remains advisory for arbitrary control flow; runtime registration metadata is canonical. Prompt/router value and portfolio decisions remain insufficient-data until the required observation window, and no rollout or portfolio promotion is implied by this phase.

## Phase 3 — Repair external adapter readiness

Owners: static-analysis maintainer and research-memory maintainer
Priority: P1
Parallel workstreams: Semgrep and Obsidian

### 3A. Semgrep

Primary files:

- `src/semgrep-adapter.js`
- `.pi/extensions/semgrep/index.ts`

Tasks:

- [x] Align tool schema, prompt text, docs, and runtime default on `p/default` or another tested reproducible config.
- [x] If `auto` is requested while metrics are off, reject it before launch with an actionable alternative or translate it under a documented policy.
- [x] Validate configured registry packs and handle unavailable packs such as `p/cpp` without repeated retries.
- [x] Make doctor report binary readiness and config readiness separately.
- [x] Add a bounded cold-cache config-resolution smoke; avoid claiming `ready:true` from version output alone.
- [x] Preserve local-first metrics/privacy behavior.
- [x] Ensure `semgrep_codegraph` can return a degraded Semgrep result plus CodeGraph advisory information when safe, rather than losing all context.

Verification:

- `tests/semgrep-adapter.test.js`
- `tests/semgrep-extension.test.js`
- focused cold-cache fixture with no network-secret state

### 3B. Obsidian/Hermes

Primary files:

- `src/obsidian-adapter.js`
- `.pi/extensions/obsidian/index.ts`
- `src/hermes-client.js`

Tasks:

- [x] Split readiness into vault filesystem, Obsidian desktop/open, Hermes executable, Hermes authentication, provider/model, and curation readiness.
- [x] Add a bounded authentication probe that does not expose credentials.
- [x] Add a dry-run curation smoke with a strict timeout and concise diagnostics.
- [x] Avoid telling the model that curation is ready when only the binary exists.
- [x] Keep local Markdown search/note/import usable when desktop Obsidian or Hermes curation is unavailable.
- [x] Record timeout/auth failure categories in metadata-only telemetry.

Verification:

- `tests/obsidian-adapter.test.js`
- `tests/obsidian-extension.test.js`
- `tests/obsidian-vault-selection.test.js`
- fake-Hermes success/auth-failure/timeout fixtures

Acceptance gate for Phase 3:

- Default Semgrep focused scans pass in a cold test environment or return a precise preflight result without spawning a doomed scan.
- Obsidian doctor cannot report curation-ready when auth is missing.
- Optional provider degradation never blocks unrelated coding work.

### Phase 3 completion evidence

1. **Semgrep readiness contract.** The runtime, tool schema, prompts, and docs now use `p/default`. Binary, config, and scan readiness are distinct. `auto` with metrics off and missing local YAML are blocked before launch; configured packs receive a bounded `--validate` preflight with separate 24-hour success and 15-minute failure TTLs. The private persisted cache stores only a hashed config identity, timestamps, readiness/category, and error code.
2. **Cold/degraded Semgrep evidence.** Fake-CLI fixtures cover valid config, unavailable `p/cpp`, missing local config, timeout, in-process negative cache, cold module reload, and no scan after failed preflight. A live forced cold probe against Semgrep `1.163.0` reported `binaryReady=true`, `configReady=true`, and `scanReady=true`; the following focused source scan reused that readiness and returned zero findings. Both synchronous and tool-level CodeGraph bridges retained affected-test guidance when Semgrep config readiness failed.
3. **Layered Obsidian/Hermes contract.** Status and doctor report vault filesystem, desktop executable/open state, Hermes executable, authentication, provider/model, local Markdown, and curation separately. Local Markdown remains ready without the desktop. Local status never marks end-to-end curation ready; only an explicit authenticated probe followed by the synthetic-input dry-run curation smoke can do so.
4. **Provider and timeout evidence.** Fake desktop/Hermes fixtures cover missing desktop, missing Hermes, authenticated success, unauthenticated provider, invalid provider/model, transport failure, auth timeout, and curation timeout. The two genuine timeout fixtures confirm the owned provider PIDs are gone after the deadline. The curation smoke reads no vault bodies and writes no note. On this host, the desktop remains unavailable, the vault/local Markdown and Hermes executable are ready, the bounded live auth probe succeeded, and the bounded live curation smoke succeeded with `noteWritten=false` and `filesIncluded=0`.
5. **Privacy/static evidence.** Readiness events are allowlisted to operation/outcome/category/error code/duration/count/boolean metadata. Obsidian and Semgrep state are mode `0600` (Obsidian state directory `0700`) and contain no forbidden prompt/query/output/credential/path/topic/digest keys, probe prompts, or home paths. Privacy Guard reported zero actionable/ignored findings in its managed roots. A final focused `p/default` scan over both adapters, Hermes client, extensions, and readiness tests reported zero findings/errors.
6. **Regression gates.** Nine focused adapter/extension/Hermes/import/load tests passed, including the new cold-cache and fake-provider suite. `bash scripts/check-all.sh` exited 0 and included all unit/source checks, 47 RPC extension smokes, the full-fleet model smoke, TUI smokes, and local Pi/Hermes regressions. Post-suite extension/import checks also passed after documentation-only wording updates, and final `gitverify` passed both staged and unstaged diff checks.
7. **Rollback and residual risk.** Existing `PI_SEMGREP=0`, `PI_SEMGREP_ADVISORY=0`, `PI_OBSIDIAN=0`, `PI_OBSIDIAN_HERMES=0`, and auto-awareness/status knobs remain rollback controls. Live desktop-open success cannot be demonstrated on this host because Obsidian desktop is absent; fake-executable/open-state coverage verifies that branch, while local filesystem functionality is live-ready. Registry readiness can expire or change remotely, so it remains bounded, cached, and advisory rather than a permanent proof.

## Phase 4 — Correct workflow semantics and routing

Owner role: workflow/tooling maintainer
Priority: P2

### Test Runner

- [x] Return `not-applicable` for no inferred commands and no prior failures.
- [x] Keep actual test-command failures distinct and evidence-bearing.
- [x] Improve profile inference only from repository evidence; do not invent generic commands.
- [x] Update learning/session mining so not-applicable outcomes do not create tool-failure candidates.

### Automation Loop

- [x] Keep strict explicit-user intent and promise enforcement.
- [x] Count safety rejections as `blocked`, not runtime failures.
- [x] Verify current model guidance prevents autonomous starts and invalid completion calls.
- [x] Add telemetry for start eligibility, rejection reason, checkpoints, and terminal outcome.

### Evidence, docs, and optional providers

- [x] Keep Evidence Binder missing prerequisites as actionable not-ready outcomes.
- [x] Route Pi installation docs outside the active repository through the documented read path rather than weakening `docs_lookup` confinement.
- [x] Treat CodeGraph/Semgrep/provider absence as degraded advisory state unless the user selected a gate that requires it.

Verification:

- `tests/test-runner.test.js`
- `tests/automation-loop-extension.test.js`
- `tests/session-miner.test.js`
- evidence/docs/codegraph focused tests selected by affected-file analysis

Acceptance gate:

- No-prerequisite and not-applicable cases no longer inflate tool-error rates.
- Safety boundaries remain unchanged and tested.

### Phase 4 completion evidence (2026-07-26)

1. **Test Runner outcome contract.** `infer`, `run`, and `rerunFailures` now return canonical `outcome/status: "not-applicable"` with `ok: null` when no repository-defined command applies, no previous result exists, or no previous failures exist. Real commands retain succeeded/failed outcomes, command IDs, exit evidence, captured output, and failure hints. Inference still comes only from repository manifests, changed test paths, pinned build config, and discovered repository verifiers.
2. **Downstream semantic truth.** Learning classification removes stale tool/verification failure labels from not-applicable outcomes. Session mining subtracts not-applicable calls from tool-friction denominators and records their semantic count without creating failure candidates. Regression fixtures cover stale counters/classifications as well as a Pi tool-result envelope.
3. **Automation safety and guidance.** Explicit current-user loop intent, bounded prompt parsing, prompt-file confinement, loop/goal exclusion, completion promises, and objective completion evidence remain enforced. Expected rejections return structured `blocked` details with fixed reason codes; controls without a current loop return `not-applicable`. Current prompt guidance explicitly forbids autonomous starts and invalid promise/evidence completion.
4. **Private lifecycle telemetry.** Start eligibility/acceptance, rejections, checkpoints, status transitions, and terminal outcomes are written to private `.pi/automation-loop/telemetry.jsonl`. Tests prove a fixed metadata-only key allowlist, `0600` file mode, `0700` directory mode, and absence of prompt, summary, evidence, and dummy-secret text. A targeted Privacy Guard scan of the runtime telemetry root reported zero actionable findings; an optional source-wide scan reported one pre-existing false positive at the unchanged opaque continuation-token assignment, not persisted telemetry or credential material.
5. **Evidence and docs routing.** Missing Verification Center evidence now returns `ready: false`, `ok: null`, canonical not-applicable status, fixed `verification-prerequisite-missing`, and an actionable `verification_center run changed` next step. `docs_lookup` remains cwd-confined; model guidance routes Pi framework docs through direct `read` access to `$PI_SOURCE_ROOT/packages/coding-agent/` or sibling `../pi`. A path-escape regression confirms confinement was not relaxed.
6. **Optional provider policy.** `src/provider-readiness.js` normalizes CodeGraph/Semgrep state across Verification Center and Project Intelligence. Applicable optional absence is explicit degraded advisory `not-applicable`, non-blocking, and never gating-safe. Only `input.requiredProviders` makes applicable absence a failed `required-provider-readiness` gate; unknown provider names are rejected and non-applicable operations do not fail.
7. **Focused and live evidence.** Fifteen focused workflow/library/extension/import tests passed (15/15, 37.0s). Fresh Pi RPC lifecycle probes passed for all six touched extension entrypoints (6/6, 6.49s), including Test Runner, Automation Loop, Evidence Binder, Docs Lookup, Project Intelligence, and Verification Center.
8. **Static and full-suite evidence.** Node syntax checks passed for all seven changed/new CommonJS modules. Focused `p/default` Semgrep analysis completed with zero changed-line findings; its sole low-confidence finding is an unchanged pre-existing Windows-only `spawn(..., { shell: true })` line. `bash scripts/check-all.sh` exited 0, including every unit/source check, 47 RPC extension smokes, the full-fleet model smoke, TUI smokes, project setup, Pi drift, and local Pi/Hermes regressions. Final `gitverify` passed both unstaged and staged diff checks after the evidence-only documentation update.
9. **Residual risk.** CodeGraph affected-test lookup returned no graph dependents, so focused selection also used repository lexical mappings and direct changed tests before the full suite. LSP fallback syntax heuristics emitted known delimiter false positives, while their authoritative `node --check` commands all exited 0. CodeGraph/Semgrep remain environment-dependent and therefore advisory unless explicitly required.

## Phase 5 — Reduce context cost and close privacy gaps

Owners: reasoning-runtime maintainer and privacy maintainer
Priority: P2
Primary files:

- `.pi/extensions/reasoning-runtime/index.ts`
- `src/reasoning-runtime.js`
- cognitive branch/snapshot storage
- `extensions/prompt-suggestions/index.ts`
- `.pi/extensions/privacy-guard/index.ts`

### Cognitive injection

- [x] Measure current characters per user turn and repeated unchanged sections with the new telemetry.
- [x] Inject the full scaffold once per objective/session, then inject only changed objective, decision, evidence, or warning sections.
- [x] Deduplicate repeated strategic objective memory and unrelated procedural proof history.
- [x] Emit auto-router guidance once per stable classification unless confidence/mode/outcome changes.
- [x] Preserve current objective, constraints, runtime version, and explicit safety boundaries.
- [x] Add a benchmark comparing token/character cost, prompt latency, objective retention, and router precision before/after.

### Prompt suggestions

- [x] Instrument local and Hermes suggestion latency/outcomes and user actions without text.
- [x] Keep the deterministic local suggestion immediate.
- [x] Start Hermes refinement only when measured value justifies its cost; suppress repeated refinement for unchanged state.
- [x] Establish a reviewed keep/disable/default policy after the observation window.

### Snapshot privacy

- [x] Inspect the two Privacy Guard findings and determine whether they are legitimate branch recovery payloads or policy violations.
- [x] Separate recoverable local branch state from exportable/durable memory.
- [x] Add retention, size caps, private permissions, export redaction, and lineage-aware cleanup where missing.
- [x] Run Privacy Guard over new telemetry, snapshots, traces, and export packets.

Verification:

- `tests/reasoning-runtime.test.js`
- `tests/reasoning-memory-dedupe-policy.test.js`
- `tests/cognitive-extension-persistence.test.js`
- `tests/prompt-suggestions.test.js`
- `tests/session-branches.test.js`
- `tests/session-hygiene.test.js`
- reasoning self-test and TUI injection smoke

Acceptance gate:

- >=60% reduction in automatic injected characters per interactive turn.
- No loss of required objective/constraint context in deterministic tests.
- No actionable Privacy Guard findings in new state.
- Prompt-suggestion value can be measured without storing suggestion text.

### Phase 5 completion evidence (2026-07-26)

1. **Frozen baseline and bars.** `docs/phase5-context-privacy-benchmark.md` records only aggregate metadata. The immediate pre-change cohort contained 5/5 changed injections, 30,735 characters, and a 6,147-character mean; the ship bar was <=2,459. The audit baseline remains 1,643 injections/~10.36M characters, mean ~6.3k, p95 7,001. Prompt metadata showed local shown=5, Hermes shown=2/timed-out=2/accepted=1, with generation/refinement latency previously unmeasured.
2. **Context-efficiency result.** The complete public scaffold/runtime is injected once; later turns render active objective, decisions/evidence, constraints/safety, and warnings/routing, then transmit changed sections only. `scripts/benchmark-phase5-context.js` passed at 3,042 characters over six turns, mean 507, a **91.75% reduction** from the frozen 6,147 baseline. One turn was fully suppressed and stable router guidance appeared once.
3. **Context correctness.** Hot-path memory removes prior `User objective` records, successful proof-history records, and exact duplicates. Layered active-objective duplication is removed. Auto-router guidance is keyed by mode/match/intent/topology/reason/confidence/outcome. Deterministic checks passed for every current objective, runtime version, constraints, explicit safety boundary, stable routing, and duplicate suppression.
4. **Prompt-suggestion policy and telemetry.** Local deterministic generation remains synchronous before provider work. Fixed metadata actions now cover generated/refined/skipped/shown/accepted/dismissed/retried/timed-out/failed with source, outcome, and latency only. `src/prompt-suggestion-policy.js` defaults Hermes to evidence-gated `auto`: minimum 6 attempts, acceptance >=0.15, failure <=0.25. The current 4-attempt/50%-failure baseline does not qualify, so automatic Hermes is gated while explicit retry remains available; explicit on/off are rollback controls. Policy tests cover insufficient, eligible, forced, disabled, and unrelated cohorts.
5. **Finding classification.** Aggregate-only inspection confirmed the two audit findings were legitimate local recovery snapshots implemented unsafely: each was ~3.82MB/mode `0644`, with ~3.80MB filesystem payloads and recursively captured `.pi` snapshots/memory. Private inclusion, recursive growth, public permissions, and absent retention/export boundaries were actionable policy violations; no raw payload was copied into evidence.
6. **Snapshot boundary and migration.** Both direct and integration-backed stores now exclude private paths, remove transcript/prompt/raw/message content, redact/cap strings, enforce an 8MiB configurable cap, and use atomic `0600` files in `0700` directories. Branch export is metadata-only. Preview-first cleanup revalidates inode/hash, protects live and ancestor lineage, and applies age/count retention only to unreachable state. Reviewed local apply rewrote 21+6 snapshots, removed 199 private paths, hardened 99 files/21 directories, deleted no protected snapshots, and finished with zero errors; repeat preview was clean. The two largest files are now ~1.11MB and `0600`.
7. **Privacy evidence.** A fresh Pi RPC process loaded the changed Privacy Guard and structurally scanned cognitive state (including traces and branch snapshots), goal/semantic/verification state, direct session branches, and extension telemetry. It reported `actionable: 0`, `ignored: 0`; its report is `0600` under `0700`. Export tests prove recovery payload fields/text do not enter packets. Focused `p/default` Semgrep completed with zero findings/errors.
8. **Focused/live/full gates.** Fourteen focused reasoning, benchmark, prompt-policy/telemetry, branch/integration, hygiene, productization, and extension-load tests passed (14/14). Dedicated reasoning and prompt-suggestion TUI smokes passed. Fresh RPC lifecycle smokes passed all three touched extensions (3/3). Authoritative Node syntax checks passed all seven changed/new CommonJS scripts/modules; extension-load/RPC checks compiled TypeScript entrypoints. `bash scripts/check-all.sh` exited 0, including all tests, 47 RPC extension smokes, full-fleet model smoke, TUI smokes, project setup, Pi drift, and local Pi/Hermes regressions.
9. **Residual risk and rollout.** The 91.75% result is a deterministic benchmark anchored to a small five-event immediate cohort; Phase 7 must confirm the reduction over the versioned 14/30-day live cohort. Hermes auto-refinement remains gated until enough metadata-only evidence accrues. Legacy lineage-protected snapshots were sanitized rather than deleted. CodeGraph returned no dependency hints, so lexical/direct test selection was broadened to the full suite. LSP delimiter heuristics emitted false positives, while every authoritative `node --check`, extension load, and RPC gate passed.

## Phase 6 — Consolidate the long-tail portfolio

Owner role: extension product maintainer
Priority: P2/P3
Dependency: Phase 2 telemetry and a minimum 14-day instrumented observation window

For every extension, create a one-page registry record containing owner, user problem, trigger, overlap, mutation/privacy class, success metric, dependency readiness, and lifecycle status.

### Decision candidates

- [x] `semantic_patch`: either integrate anchored validation/checkpoint behavior into `edit`/`ast_refactor`, or mark the model tool experimental/disabled by default. Keep the underlying semantic editor if it has direct consumers.
- [x] `topology_catalog`: fold list/recommend/lint into `run_topology` or keep installation as an explicit command-only administration surface.
- [x] `workflow_conductor`: translate workflow packs into Roadmap templates or skills, then deprecate duplicate active state.
- [x] `output_compactor`: integrate compaction into result rendering for selected tools or remove the manual model tool; do not require the model to resend a verbose payload.
- [x] `memory_curator`: retain explicit governed lifecycle operations, but expose them only for explicit memory-management intent and clarify overlap with Hermes/Obsidian.
- [x] `plan_fanout`: retain as a niche explicit-delegation tool only if the repaired subagent path and telemetry demonstrate successful fan-out; otherwise keep parser/command functionality without default model exposure.
- [x] `run_monitor`: exclude from early pruning; evaluate only after sufficient eligible long-run sessions.
- [x] Command/UI extensions (`chat-focus`, `goal`, trace, context recovery, prompt suggestions): decide using command/UI/outcome metrics, never tool-call count alone.

Portfolio rules:

- [x] No new default-active model tool without a unique trigger and measurable outcome.
- [x] Overlapping tools must state which one is canonical and when the other is selected.
- [x] Experimental/deprecated tools must not add broad prompt guidance.
- [x] Removing a tool requires migration notes for commands/state and one release of deprecation warning unless it is unsafe.

Acceptance gate:

- [x] Each tool has an explicit keep/merge/experimental/deprecate decision with evidence.
- [x] The default model tool surface is smaller or has a documented justification for remaining unchanged.
- [x] No reliable-core regression.

### Phase 6 completion evidence (2026-07-26)

1. **Evidence boundary and lifecycle version.** `src/extension-portfolio.js` defines schema 1 and a 14-day minimum. The frozen decision cohort contains 90 metadata-only events from `2026-07-25T20:58:38.186Z` through `2026-07-26T08:30:45.132Z`—11.54 hours/0.48 days—so every removal/promotion conclusion is explicitly `insufficient-data`. The older schema-3 session audit remains baseline context only. No extension, command, parser, state, or implementation library was removed on this evidence.
2. **Complete registry.** The source registry reconciles exactly 47 extension records and 67 declared tool decisions with no missing/stale records or decisions. Each record includes owner, problem, unique trigger, canonical/overlap decision, mutation/privacy class, success metric, dependency readiness, lifecycle, exposure, and rollback/control. `scripts/render-extension-portfolio.js --check` validates the generated index plus 47 one-page records under `docs/extension-portfolio/`.
3. **Candidate decisions.** `semantic_patch`, `topology_catalog`, `workflow_conductor`, `output_compactor`, and `plan_fanout` are experimental command-only model surfaces; narrow per-tool and fleet-wide compatibility opt-ins remain. `memory_curator` is retained and now rejects model calls without explicit current-user memory-management intent. `run_monitor` is retained as `enabled-observation-pending`. Command/UI extensions have separate non-tool lifecycle records.
4. **Smaller default surface.** A fresh full-fleet RPC report showed 382/67 declared commands/tools, 382/59 registered commands/tools, **59 active parent model tools versus the frozen 64-tool baseline**, 46 parent-loaded extensions plus child-only `role-sidecar`, zero degraded/conflicting/unexplained surfaces, and a reconciled portfolio. The two new commands are lifecycle/migration surfaces (`/extensions-portfolio` and `/workflow-migrate`), not new model tools.
5. **Canonical overlap and migration.** Normal prompt guidance no longer advertises `plan_fanout` or the manual `output_compactor`; learning proposals use `edit`/`ast_refactor` or explicit patch commands rather than hidden model tools. Workflow Conductor now emits stateless Roadmap templates. Legacy active-state writes warn and require `PI_WORKFLOW_CONDUCTOR_LEGACY_STATE=1`; `/workflow-migrate` previews completed/pending Roadmap statuses and retains the old state until confirmation.
6. **Privacy/static evidence.** Focused `p/default` Semgrep over changed source/extensions/scripts/tests completed with zero findings/errors. A fresh isolated RPC process loaded the current Privacy Guard and scanned cognitive, goal, semantic-patch, verification, session-branch, and extension-telemetry state with `actionable: 0`, `ignored: 0`. Portfolio reports contain metadata/decisions only and tests assert they contain no repository path or telemetry payload body.
7. **Focused and behavioral evidence.** Fourteen focused registry, extension-load, workflow, learning, fan-out, result-rendering, role-contract, run-monitor, prompt-policy, and productization tests passed 14/14. Extension load behavior pins exactly 59 default parent tools, confirms all five experimental tools are absent by default, and tests the explicit `memory_curator` gate. A dedicated fresh RPC sweep passed all 47 extension entrypoints; a full-fleet model smoke and prompt/reasoning/skill TUI smokes also passed through `scripts/check-all.sh`.
8. **Full gate and residual risk.** `scripts/check-all.sh` exited 0, including the repository test fleet, 47 RPC smokes, full-fleet model smoke, TUI smokes, project setup, Pi drift, and Pi/Hermes regression checks. The 14-day dependency remains unmet, so Phase 6 closes only the conservative default-surface and migration work; Phase 7 must confirm live outcomes over the versioned 14/30-day cohort before any irreversible retirement or promotion.

## Phase 7 — Post-fix cohort, release gate, and rollout

Owners: verifier and observability maintainer
Priority: release gate

- [x] Freeze source/config versions for the cohort.
- [x] Run focused tests after each workstream, then the repository full gate on the final combined tree.
- [x] Run extension load/smoke checks and Pi TUI/RPC checks.
- [x] Run Privacy Guard and verify telemetry redaction.
- [ ] Collect at least 14 days of instrumented use; use 30 days for portfolio removal decisions where volume is low. **BLOCKED:** the exact-version cohort has 0 observed interactive days and 7 unjoined metadata events; status is insufficient-data, not pass.
- [x] Re-run the aggregate session audit with current session excluded and test/smoke sessions separated.
- [x] Compare post-fix rates only for calls after the relevant source/config version.
- [x] Publish a scorecard with pass/fail/insufficient-data for every success metric.
- [x] Promote role runtime only to the benchmark-authorized stage; keep an immediate configuration rollback path.
- [x] Update `docs/productization-extensions.md`, adapter docs, runtime configuration, and changelog with final lifecycle decisions.

Final verification candidates:

- affected focused tests from each phase;
- `tests/extension-load.test.js`;
- `tests/extension-smoke-runner.test.js`;
- `tests/productization-extensions.test.js`;
- `tests/topology-policy-conformance.test.js`;
- `scripts/check-subagent-tui.sh`;
- reasoning TUI injection smoke;
- `scripts/check-all.sh`;
- `gitverify` and final diff review.

Release decision:

- **Ship** only if P0/P1 gates pass, privacy has zero actionable findings, and no reliable-core regression exists.
- **Partial rollout** if adapter/portfolio work passes but role runtime remains at R0; document unavailable functionality.
- **No-go** if subagent failures can be reported as success, telemetry persists sensitive content, or Semgrep/Obsidian readiness still overclaims functionality.

**Current decision: NO-GO-DEFERRED.** No ship-blocking correctness or privacy failure was observed, but the mandatory exact-version 14-day cohort is incomplete. The 9 PASS / 0 FAIL / 2 INSUFFICIENT DATA scorecard therefore blocks release shipment and irreversible portfolio decisions. The evidence-authorized R4 advisory role rollout is separately bounded and rollback-safe; it does not override the release hold.

### Phase 7 execution evidence (2026-07-26)

1. **Frozen versions.** Private freeze schema 1 records source `3bbc700d2648+3e6911d8d2401e72`, runtime hash `3e6911d8d2401e7287deb0eeedbcb5bd71c7101f0c3b0220199c500669c53587`, config `settings-2d0f65e6ac93a12a+portfolio-1+telemetry-1`, and cohort start `2026-07-26T13:33:32.197Z`. It stores hashes/versions only. Scorecard generation refuses runtime-source drift.
2. **Focused gates.** Forty-five applicable tests passed across role/subagent truth, inventory/telemetry/session mining, Semgrep/Obsidian readiness, workflow semantics, context/privacy efficiency, portfolio decisions, and Phase 7 scorecard/audit behavior. A stale inferred path `tests/docs-lookup.test.js` produced `MODULE_NOT_FOUND`; it is not a repository test and was replaced by the actual `tests/coding-workflow-tools.test.js`, which passed.
3. **Behavioral gates.** All 47 isolated extension RPC probes, the full-fleet model smoke, extension-load behavior, and prompt-suggestion/reasoning/skill/subagent/topology TUI checks passed. Live inventory reconciled 47 extensions, 382 registered commands, 59 registered/active parent tools, 46 parent-loaded plus child-only sidecar, and zero degraded/conflicting/unexplained surfaces.
4. **Privacy and adapters.** A fresh current-source Privacy Guard scan reported actionable=0, ignored=0, and no findings. Focused `p/default` Semgrep returned zero findings/errors with one non-fatal Python taint fixpoint warning; the post-fix infrastructure rate therefore remains insufficient-data. Live Obsidian auth and provider/model readiness passed; the synthetic-input curation dry-run completed in 5,412ms with zero vault files included and no note written. Test/miner/scorecard fixtures prove telemetry, audit registries, audits, and public scorecards omit content, arguments, outputs, credentials, source bodies, repository/session paths, and session identifiers.
5. **Aggregate audit.** The tracked schema-2/classifier-v2 audit requested one exact active-session exclusion, matched/excluded one file, recorded zero unmatched IDs, and therefore truthfully reported the current session excluded. The full view analyzed 1,500 sessions as 172 interactive and 1,328 test/smoke with zero invalid rows and current 47/67/382 inventory. The version-frozen view analyzed one post-freeze `other` session and no interactive or test/smoke session; lifetime rates are not reused as post-fix rates.
6. **Cohort and scorecard.** Exact-version telemetry after the final freeze currently contains 0 metadata-only events; even when such events accrue, privacy-preserving telemetry cannot join them to interactive versus smoke/test sessions, so they remain ineligible as a rate denominator. The aggregate post-freeze audit has 0 observed interactive days. `docs/phase7-release-scorecard.{md,json}` records 9 PASS, 0 FAIL, and 2 INSUFFICIENT DATA metrics. Semgrep's live infrastructure-error rate and cognitive-context live reduction cannot meet their 14-day bars yet.
7. **Role rollout.** A fresh private deterministic report passed all twelve deterministic gates and authorizes R4 with manifest hash `7513e2cc8abb82d8fa116a9d92e064a1f6807e5f417686304aeaa6ce4a6bf22f` and current runtime-source hash `3e6911d8d2401e7287deb0eeedbcb5bd71c7101f0c3b0220199c500669c53587`. Automatic eligibility now also requires a valid timestamp no older than seven days by default; stale/future/mismatched/unverifiable reports fail closed to R0. The prior bounded live reviewer pilot completed 1/1 with two model calls, exact 3/3 tool parity, valid typed submission, and 21,776ms total latency. Valid evidence now selects R4 by default, capped at R4; missing evidence remains R0. `PI_ROLE_ROLLOUT_STAGE=R0` and `PI_ROLE_RUNTIME_VERSION=1` are immediate state-preserving rollbacks. R5 and hidden automatic mutation remain blocked.
8. **Final verification and residual gate.** `PI_CHECK_TUI=1 scripts/check-all.sh` exited 0 on the final review tree, including the repository test fleet, all 47 RPC probes, full-fleet model smoke, prompt/reasoning/skill/subagent/topology TUI checks, project setup, Pi drift, and Pi/Hermes regressions. Post-edit focused regressions also passed for branch snapshots, Obsidian, Test Runner, role benchmark/rollout, and Phase 7 audit/scorecard behavior; focused Semgrep reported zero findings/errors. The temporal cohort requirement remains blocked and the release decision stays no-go-deferred until a later exact-version scorecard has at least 14 observed interactive days and a classified rate denominator (30 days for low-volume portfolio retirement).

## Work waves and conflict zones

| Wave | Work item | File zone | Depends on | Can parallelize with |
|---|---|---|---|---|
| 0 | Containment and baseline freeze | runtime config, audit fixtures | none | inventory design |
| 1A | Role-sidecar lifecycle | role-sidecar, subagents, role runtime tests | Wave 0 | 1B |
| 1B | Outcome schema and inventory | extension registry, session miner, extension kit | Wave 0 | 1A |
| 2A | Semgrep readiness | Semgrep adapter/extension/tests | outcome schema | 2B |
| 2B | Obsidian/Hermes readiness | Obsidian/Hermes adapter/tests | outcome schema | 2A |
| 3A | Test/automation semantics | Test Runner, Automation Loop, miner | outcome schema | 3B |
| 3B | Context/privacy efficiency | reasoning runtime, snapshots, prompt suggestions | telemetry schema | 3A |
| 4 | Portfolio consolidation | extension registrations/docs | 14-day telemetry | none across overlapping registrations |
| 5 | Cohort and release gate | tests, docs, scorecard | all shipping work | none |

Shared conflict zones requiring one integrator:

- `src/pi-extension-kit.js` telemetry/event helpers;
- `src/session-miner.js` outcome and cohort classification;
- `.pi/extensions/reasoning-runtime/index.ts` role and context integration;
- `docs/productization-extensions.md` lifecycle documentation;
- global extension settings or active-tool selection.

## Evidence packet required for each completed work item

Every implementation checklist item should close with:

1. changed files and source/config version;
2. focused test command and result;
3. behavioral smoke evidence where applicable;
4. privacy/static findings;
5. metric expected to move and its preregistered comparison bar;
6. rollback control;
7. residual risk or insufficient-data note.

A green build without the relevant runtime or cohort evidence does not close the work item.
