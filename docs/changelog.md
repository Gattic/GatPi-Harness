# Changelog

## delegation-model-and-tool-aliases - 2026-11-05

- Delegation resolves to `local/DeepSeek-V4.1-Flash-1017` instead of
`openai-codex/gpt-6-astra`: `DEFAULT_DELEGATE_MODEL`, the canonical
`PI_ROLE_MODEL_*` pins, and the worker shadow canary profile. Role children
launch with a fixed model and deliberately do not fail over, so an exhausted
Codex quota blocked every delegation while the parent session kept working on a
different provider. Planner, reviewer, coder, refactorer and evidence-auditor
move from `xhigh` to `high`: the delegate model does not declare `xhigh`, and a
pin above the supported range fails closed before the provider call.
Researcher/benchmark stay at `medium`, worker/verifier at `low`. Changing the
model matrix invalidates runtime-fingerprinted benchmark and field evidence.
Role children still load only the approved provider registration and the role
sidecar, so child requests to a queued provider bypass the shared `pi-queue`
Redis slot.
- `create_subagent` accepts case, snake_case, and kebab-case operation variants
plus `queue` (launch), `inspect`/`trace` (get), and `mergePolicy: "manual"`
(none) through the shared `normalizeOperation` helper instead of a literal-only
enum. Invalid values still fail with the supported list. Recent session audits
showed about 15 calls rejected by the enum before any subagent work happened.
- `tests/subagent-tool-source.test.js` asserts the alias normalization, and the
role-inference tests derive the canonical delegate model from
`DEFAULT_DELEGATE_MODEL` instead of duplicating the provider string.
- `docs/subagents.md` now records the inference precedence chain (environment
override, then the role contract, then the parent session for explicit
`inherit`) and the canonical role profile table, including specialist roles
that inherit the parent profile and the 3d-modeler effort pin.
`docs/multi-agent-topologies.md` links to that section instead of duplicating
the table.

## run-monitor-script-checks - 2026-11-01

- `run_monitor` terminal edges now run `scripts/run-monitor-check.js` instead of queuing a `pi.sendUserMessage` wake-up. The script samples active monitors, probes terminal `bg_run`/`run_deck` targets, and persists bounded target evidence as `scriptCheck`; it never reads full logs, sends messages, or starts model turns. The checker is also runnable directly (including `--watch`) for cron or shell use.
- Removed the persisted `wake` claim, first-claim-wins duplicate settlement logic, headless/automation-loop wake skips, and `formatMonitorWake`. Background timers, session restore, slash commands, tool results, and headless sessions now show the script probe inline. `tests/run-monitor.test.js`, `tests/run-monitor-extension.test.js`, and the new `tests/run-monitor-check-script.test.js` cover the script path and assert that no user message is sent.

## apply-large-asset-patch - 2026-10-30

- Applying an accepted asset patch no longer aborts with
`SUBAGENT_PATCH_RECOVERY_BUDGET` when the patch is larger than the parent's
recovery budget. The budget bounds durable recovery data — backups of paths that
already exist plus the journal — but the post-apply snapshot reused it as a read
limit for the files the patch had just written. An add-only patch backs nothing
up, so in a small repository the budget stayed far below a multi-megabyte GLB:
the files were written and then flagged `reconciliation-required` instead of
completing, with the run task blocked and no application receipts. The snapshot
is now bounded by the captured path bytes, so the application completes, re-runs
the required criteria on the parent tree and records application receipts.
Overwriting an existing file still requires a budget that can hold its backup,
and a parent that changed underneath the patch still rolls back or is preserved
for reconciliation.
- `tests/subagent-patch-transfer.test.js` covers both sides: an add-only 512 KiB
patch applies under a 64 KiB recovery budget and journals `status: "applied"`
with no backup for the new path, while overwriting an existing 512 KiB file under
the same budget still fails with `SUBAGENT_PATCH_RECOVERY_BUDGET` and leaves the
parent byte-for-byte unchanged.

## measured-asset-acceptance - 2026-10-30

- `3d-modeler` tasks may declare `acceptanceMode: "measured"`. Measured acceptance
replaces the `3d-critic` contact-sheet verdict with the pinned executable checkers
that read the exported artifact; the native asset checker stays bound for the
runtime, unit/axis round-trip and budgets, and the independent `patch-reviewer`
still runs. Preflight rejects the mode unless a required criterion is bound to a
non-`blender-asset` verifier (`measured-acceptance-needs-measured-checker`), and any
mode value other than `"measured"` is `TASK_ACCEPTANCE_MODE_INVALID`. Receipts from
measured tasks carry no `visualReview`, so the two acceptance paths stay
distinguishable in retained evidence. Refinement, attempt, resume and correction
semantics are unchanged.
- The critic packet now carries `previewCoverage` from the native checker receipt.
`0c5ccf4` made the fixture assert that the rendered views frame the subject but
never sent the measurement to the critic, so `tests/specialist-blender.test.js`
failed with `visual-critic-execution-failed` before this change.
- `acceptanceMode` is restricted to the `3d-modeler` role
(`TASK_ACCEPTANCE_MODE_UNSUPPORTED` elsewhere) and the mode's preflight requirement
counts only registered non-`blender-asset` verifiers, so an unregistered verifier id
cannot satisfy it. `specialist_tasks context` reports the mode vocabulary under
`execution.assetAcceptance`.
- `tests/specialist-blender.test.js` gains four measured negatives, including the
unavailable-checker paths: an unregistered verifier id is refused by preflight and
`run` throws before any producer attempt, and a checker edited after its pin fails
preflight with `TASK_ORACLE_SOURCE_DRIFT` until the file matches its digest again.
The fixture also records which reviewer roles ran, so the critic path must invoke
exactly `3d-critic` and no measured run may invoke it. A pinned checker
that measures a property the cube lacks keeps the native receipt passing while the
measured criterion fails with exit 1 on all three attempts, and a reviewer reporting
a failed verification turns both zero-exit checks into failed receipts. Both runs
end failed and unapplied, so measured acceptance cannot pass on checkers alone or
bypass the independent review. The fixture now creates `assets/` idempotently so a
correction attempt seeded with the prior patch can rerun the producer.
- Measured acceptance receipts carry `acceptanceMode: "measured"` in place of
`visualReview`, so retained evidence names the acceptance path instead of inferring
it from an absent field. Measured acceptance certifies only the properties its pinned
checkers measure on that artifact digest; it is not visual approval, a critique or a
human sign-off, and the critic path remains the visual-judgment path.
- The `3d-modeler` completion contract states the default critic path and the
measured alternative, so the revision changes and task graphs pinning the previous
revision must be re-issued.

## 3d-modeler-blender-mcp - 2026-10-29

- The `3d-modeler` contract allowlists `mcp__blender__*` alongside `role_domain`, so
the producer can drive a live Blender scene through pi's MCP client: execute Python,
inspect objects, render a check view, then save the `.blend` and export the GLB from
the same session instead of writing blind stage scripts.
- The role declares `settings.blenderMcp` (`server: blender`, `localhost:9876`) and
preflight now reports `blender-mcp:server-not-configured:<name>` when no matching MCP
server is registered, or `blender-mcp:listener-unreachable:<host>:<port>` when nothing
listens on that port. The listener check reads `/proc/net/tcp`, is skipped where that
socket table is unavailable, and never starts Blender or contacts a provider.
- `resolveRequiredTools` treats a `*` entry as a pattern over the child's live tool set:
it expands to its matches and never marks a role unavailable on its own, so the launch
guard does not reject the allowlist while MCP readiness is checked by capabilityStatus.
- Containment note: MCP tool calls run in a host Blender process outside `bwrap`, so
the contract restricts writes to the task workspace and forbids using MCP tools to
reach the network or the parent checkout. Acceptance is unchanged.
- The contract revision changes, so task graphs pinning the previous revision must be
re-issued; graph `dog-photoreal-7` no longer matches.

## specialist-3d-producer-profile - 2026-10-29

- The canonical defaults pin the specialist 3D producer's effort to `medium`
  (`PI_ROLE_THINKING_3D_MODELER=medium`) and leave its model unset, so the
  producer inherits the parent session model. Pinning a concrete model was tried
  and reverted: the configured `anthropic` account answered every request with
  `429 rate_limit_error` and `openai-codex` has no credentials, so a hard model
  pin made the 3D task fail at launch with `SUBAGENT_PROVIDER_ERROR` after 1.6 s.
  An explicit launch override (`PI_ROLE_MODEL_3D_MODELER=<provider/model>`) still
  wins over this default.
- Procedural Blender asset work previously inherited the parent's effort along
  with its model, and repeated task lineages spent their output budget on
  reasoning before producing geometry the independent 3d-critic rejected.
- `tests/role-reasoning-policy.test.js` now derives each model role's expected
  RPC model and effort from the configured role environment, so a newly
  configured specialist profile is asserted instead of silently assumed to
  inherit the parent.
- `config/harness-defaults.env` participates in the runtime source fingerprint,
  so role benchmark evidence collected before this change does not describe this
  build.

## retrieval-token-budget - 2026-10-28

- Retrieval tools now return bounded model-facing views instead of raw provider
  payloads. `codegraph_query`, `codegraph_context`, `codegraph_affected`,
  `semgrep_scan`, `semgrep_codegraph` and `ast_search` validate their results
  into the shared retrieval envelope from `src/provider-result-rendering.js` and
  render it within a token budget (`budgetTokens`), dropping the lowest-ranked
  cards and stating how many were omitted plus how to widen the view. The
  complete provider record stays in tool-result `details`; `verbose=true`
  returns the raw text. CodeGraph status/sync/file reports are line-bounded.
- Native retrieval always requests structured provider data; the obsolete
  `json`/`quiet` tool switches and `--json`/`--quiet`/`--text` command options
  are removed. Format switches can no longer bypass the retrieval envelope or
  turn unparsed Semgrep findings into a clean scan. Use `verbose=true` (CLI
  `--verbose`) to expand the raw JSON, or CLI `--budget-tokens` for the compact
  view.
- `codegraph_context` omits the verbatim `**Source Code**` section unless
  `includeSource=true`, so an explore costs signatures and relationship counts
  rather than whole files. Semgrep findings are ordered by severity so the
  budget keeps the actionable ones, with severity and per-rule counts still
  describing the whole scan. `ast_search` collects 50 matches by default and
  reports the match limit with a refinement hint.
- `compactToolPayload` dispatches retrieval envelopes to the same provider
  renderers, so the output compactor is a backstop that agrees with the tool's
  own view instead of a second rendering path.
- Task routing activates only the tool an intent names. Each capability group
  now has a primary tool plus narrow selectors, so "show codegraph status"
  activates `codegraph_status` rather than all six CodeGraph tools; siblings
  stay reachable through `activate_tools`. This matters because an activated
  tool schema is resent on every later turn for the rest of the session.
- A central observer measures top-level final results after all result
  transformers run: raw-provider, pre-backstop and final model-visible
  character counts plus the native token budget, attributed to the producing
  `tool`. Nested results are excluded, and `/harness-metrics` counts native
  and backstop savings once. Bypass signals retain tool attribution even in
  compactor `off` mode; fully disabling the extension disables observation too.
  Explicit verbose requests and already-budgeted native views are not
  compacted again. Counts are metadata-only; no bodies or arguments are stored.
- Budgets include footers and omission notices, including single-card, empty,
  unstructured and Unicode results. Token counts are UTF-8-bytes/4 estimates,
  not measured provider token usage.
## specialist-role-inference-overrides - 2026-10-28

- Specialist (`budget: null`) task roles no longer suppress per-role inference
  configuration. `budget: null` now means only "no task/run budget"; it no longer
  forces an inherit-only profile that discarded `PI_ROLE_MODEL_<ROLE_ID>` and
  `PI_ROLE_THINKING_<ROLE_ID>`. Specialists still inherit the parent model/effort
  when no override is configured, and RPC profile overrides remain ignored.
- Removed the `inheritOnly` parameter from `selectRoleInferenceProfile` and its
  two call sites (`resolveSubagentPreflight`, `SubagentRunner.rpcArgs`) instead
  of keeping a parallel suppression path.
- Regression coverage asserts both directions: a specialist task role inherits
  `provider/parent`/`high` with no configuration, and resolves
  `provider/specialist-override`/`low` through both the RPC launch and preflight
  paths when the role environment is set.
- `src/role-contracts.js`, `src/subagent-lifecycle.js` and `src/subagents.js`
  participate in the runtime source fingerprint, so role benchmark evidence
  collected before this fix does not describe this build.

## skills-pack-2.0 - 2026-10-27

- Replaced the Skill Foundry payload in `skills/` with the supplied 2026-10-27
  pack: 20 new skills, 21 revised skills and 80 preserved skill entrypoints,
  for 129 managed skills (121 supplied + the 8 local restorations).
- `skills/tools/regenerate.py` now renders the pack's new catalog fields:
  `revision` (frontmatter version), `special_rules` (**Specialist protocol and
  proof boundaries**), `source_inspiration` (**Provenance notes**),
  `domain_tests` (`evals[].domain`) and hand-authored `routing_tests` overrides,
  so the catalog remains the single editable source for every generated byte.
- `skills/catalog.json`, `skills/skills/managed-skills.txt`, `CATALOG.md`,
  `manifest.json`, `evals/` and every `SKILL.md` were regenerated; the eight
  local skills keep their hand-maintained `references/` contracts.
- Disclosed deviations are recorded in `docs/skill-bundle-migration.md`: plain
  relative `refs` rendering instead of markdown links, one missing trailing
  period carried from the supplied `catalog.json`, retention of this
  repository's valueless-attribute fix in the SEO helper, and authoring-side
  files the supplied ZIP omitted.
- The fleet update gate compared the total skill-directory count before and
  after the refresh, so a grown managed catalog failed every host after the
  skills were already installed. It now compares the digest of user-owned
  (non-managed) skill directories, and `tests/fleet-skill-gate.test.js` guards
  that invariant.

## memory-health-fixes - 2026-10-26

- Trace retention now prunes to a headroom target below the byte cap instead of
  stopping exactly at it. Retention that only fires once the store is already at
  the ceiling left no room for the next session, so `.pi/traces` sat pinned at
  133.96 MB of a 134.2 MB budget. `PI_TRACE_HEADROOM_RATIO` (default `0.25`)
  sets the fraction of the cap kept free, and both `FileTraceStorage` and
  `TraceRuntime` validate the ratio as `[0, 1)` rather than silently accepting a
  value that would prune everything.
- Pre-prune reasoning snapshots are bounded. Every automated retention pass wrote
  a full pre-prune backup and nothing removed them, which is how 127 MB of
  snapshots accumulated against artifacts that were themselves already bounded.
  The runtime now rotates the backups it writes in the current process, keeping
  only the newest `PI_REASONING_SNAPSHOT_KEEP` (default `3`). Rotation only ever
  drops a backup this process created: the 18 snapshots already on disk, and
  legacy non-prefixed trace files, are left in place, because reclamation of
  already-written evidence is an explicit operator decision rather than a side
  effect of a growth bound.
- The advisory skill pilot now resolves the same configuration the runtime does.
  It was constructed with the raw process environment, so a declared
  `config/memory-posture.json` stage was ignored and the pilot resolved `M0`
  while the rollout resolved `M1`. The integration boundary applies
  `applyProjectMemoryPosture()` once and passes that resolved environment to the
  pilot, so the stage that gates it is the stage the operator authorized.
  `PI_PROJECT_MEMORY_POSTURE=env` still restores environment precedence.
- Context-injection and opportunity telemetry now carry a derived `outcome`.
  These two kinds previously recorded no terminal state at all, so a reader
  could not distinguish a delivered injection from one with nothing to deliver,
  or an opportunity the operator declined from an unmeasured one. Both use the
  canonical outcome vocabulary and fall back to `not-applicable` rather than
  claiming success.
- Diagnostic review requests gained resolution accounting. Review rows are
  append-only and were only ever counted, so the backlog could only grow: 17
  requests dating back to 2026-10-09 were reported with `actionable=false` and no
  way to settle them. `diagnosticReviewSummary()` now reports `rows`, `resolved`,
  `unresolved`, per-kind unresolved counts and the oldest/newest unresolved
  request, keyed by producer rather than line number so a key survives log
  rotation. `memory_curator operation=reviewResolution` appends a metadata-only
  resolution row under review intent; it writes no vault, canonical note or
  decision-ledger row.
- `memory_curator operation=consolidate` makes consolidation an explicit,
  preview-first action. The declared posture does not authorize automatic
  consolidation, and no `consolidate` entry had ever appeared in the cognitive
  audit, so 5,748 entries sat with a single semantic memory and
  `lastConsolidatedAt=0`. Preview runs dedupe, contradiction resolution,
  invariant extraction, cross-linking and compaction against a throwaway copy of
  the hydrated store and writes nothing; persisting requires lifecycle intent
  plus `apply:true`, and "consolidate" now grants that lifecycle scope. Both
  paths report per-action decision counts and a 20-decision sample instead of
  returning thousands of rows to the tool surface.
- The 10k-note recall latency test samples five runs and asserts on the median.
  The 50 ms bar is unchanged; a single sample measured the scheduler as much as
  the index and failed roughly one run in five on otherwise idle code.

## managed-tool-activation - 2026-10-26

- The task-aware tool router now registers `activate_tools`, one baseline model
  tool that lists every optional harness tool with its state and activates
  named tools for the session. It reuses the router's eligibility, `PI_*=0`
  configuration gates and provider readiness, so activation cannot widen a
  restricted child-role surface or bypass a disabled capability. This closes
  the gap where an optional tool became necessary mid-session (a discovered
  bug, a run just launched) but only a later user prompt could declare it.
- Advisory context no longer claims tools the surface does not have. The
  harness-awareness block is built from the active tool set, advertises a
  workflow family only when every tool it names is declared, and points at
  `activate_tools` for the rest. The debug, experiment and run-deck summaries
  keep their durable state but name the activation path instead of asserting a
  tool that may be absent.
- CodeMode guidance now states that `ALL_TOOLS`, `searchTools()` and
  `describeTool()` cover only the policy-allowed CodeMode subset, never the
  session's declared tool surface, so a failed discovery search is not read as
  proof that a tool does not exist.
- The default parent fleet grows by exactly one tool (`activate_tools`, 63 to
  64); extension portfolio records and runtime documentation were regenerated
  from the same sources.

## skill-specialist-awareness - 2026-10-26

- Delegated role children now receive a bounded skill-awareness block built by
  `src/skill-awareness.js` from `skills/catalog.json`: the full 109-skill roster
  by category plus the skills whose declared discipline governs that role. It
  reaches the child exactly once (through the contract's appended system prompt,
  inline for prompt-only children, and at launch for records resumed with a
  persisted contract that predates awareness), and it names the rule that a
  child asks the parent for a skill body instead of claiming a procedure it
  cannot load.
- The block is bounded at 16000 characters and degrades deterministically
  instead of failing extension load: role detail is dropped first, then trailing
  categories are omitted with an explicit `Roster truncated` note pointing at
  `skills/CATALOG.md`. Missing, empty, duplicate or malformed catalog entries
  still fail closed.
- Every `SKILL.md` now carries a **Harness delegation** section that
  lists the 22 registered roles and the tools that run them, states that role
  children have skill discovery disabled, and tells a harness without those
  roles or tools to do the work inline under the same acceptance gate.
  `skills/specialists.json` is generated from `src/role-contracts.js` by
  `scripts/regenerate-specialist-roster.js`, and `tests/skill-awareness.test.js`
  fails when the checked-in roster drifts from the role contracts.
- Skill awareness is part of each role's system prompt, so every
  `roleRevisionHash` changes. A typed record created against an older revision
  still fails closed with `SUBAGENT_ROLE_CONTRACT_UNAVAILABLE` on continuation,
  and persisted specialist task graphs fail with `TASK_CONTRACT_STALE`; recreate
  the attempt or rebuild the graph against the current contracts.
- Active documentation and generated skill bodies no longer cite retired skills:
  `/skill:audit` becomes `/skill:code-review-evidence`, `change-verify`,
  `long-run` and `git-checkpoint` are restored as current session-derived
  skills, `repo-orient` is marked superseded, and the topology role list names
  `3d-critic` and `code-profiler`. The migration record, dated session records
  and historical superpowers specs keep their original wording deliberately.

## roadmap-session-scoped-store - 2026-10-26

- Roadmap state is bound to the session that owns it and stored beneath the Git
  worktree (or project) root at `.pi/roadmap/sessions/<session-id>/`, so
  concurrent sessions in one directory keep independent roadmaps instead of
  overwriting each other. Unscoped callers such as scripts and topology
  appliers outside a session keep the directory-level `.pi/roadmap/active.json`,
  and nested working directories share their project's store.
- A session without a roadmap discovers the directory's roadmaps through
  `show` and continues one explicitly with `action=adopt` or `/roadmap-adopt`,
  which copies the packet into the current session's store without touching the
  owning session's state. Adoption is refused while the session already holds a
  roadmap, and a session id that cannot name a directory gets a stable hashed
  store instead of silently sharing the directory-level one.
- `set_status` and `link` accept `itemIds`, and `cascade=true` settles pending or
  active nested descendants deepest-first in the same call, so a finished
  milestone and its goals complete in one mutation. `add` accepts several
  titles, `/roadmap-done` accepts several items, and mutation envelopes report
  applied ids. The tool result now shows root outcomes separately from workflow
  counts.

## memory-m1-posture - 2026-10-26

- Project-memory posture is now explicit and observable. `config/memory-posture.json`
  records the operator decision (M1, writes, automatic capture, auto-save) and
  outranks inherited `PI_PROJECT_MEMORY_STAGE`, `PI_PROJECT_MEMORY_WRITES`,
  `PI_PROJECT_MEMORY_AUTOMATIC`, and `PI_PROJECT_MEMORY_AUTO_SAVE` exports, so a
  stale export in a launching shell can no longer silently pin the harness below
  its recorded posture. `PI_PROJECT_MEMORY=0` remains the unconditional kill
  switch, and `PI_PROJECT_MEMORY_POSTURE=env` restores environment precedence for
  a session that deliberately overrides one stage key. An absent posture file
  leaves the environment untouched; an invalid one is reported and never applied.
- `applyHarnessEnvironmentDefaults()` reports preserved overrides that disagree
  with canonical defaults, and the harness-defaults extension records the
  declared and resolved posture in `.pi/harness-defaults/posture.json` (keys and
  redacted conflict values only, written atomically with mode `0600`) and
  surfaces it in `harness-defaults-status`.
- Project-memory status reports recorded curator-review diagnostic requests
  (`diagnosticReview`, counted by kind with oldest/newest timestamps). The rows
  are append-only, so the count is a request history rather than a resolved
  backlog. Candidate settlement persists seen fingerprints even when candidate
  capture is off, so repeat observations are reported instead of silently
  re-queued; repeats no longer consume the per-settle new-candidate budget.
- Manual `memory_curator` recall is task-conditioned by default with an explicit
  opt-out, and `memoryMap` reports whether diagnostic review rows are actionable
  at the effective stage.
- Cognitive memory now enforces retention on save: exact-duplicate collapse
  (case/punctuation-insensitive per type) plus per-type caps (episodic 5000,
  procedural 3000, semantic 1000, strategic 300) that always preserve verified
  entries. `ReasoningRuntime.pruneAutomatedVerification()` also bounds automated
  executor actions (default 2000) in addition to verifier evidence (120), and the
  reasoning extension auto-prunes when either bound is exceeded. A new
  `scripts/maintain-memory-stores.js` previews and applies both bounds with
  private `0600` backups and a metadata-only receipt. Malformed or negative
  retention bounds fall back to the documented defaults instead of pruning every
  artifact, feedback that targets a pruned action is removed with it, and
  cognitive-memory persistence now writes atomically through a `0600` temporary
  file. Conflict values recorded in `.pi/harness-defaults/posture.json` are
  redacted when they are paths, secret-shaped keys, or free-form text.
- Seeded the pi-harness project-memory vault with real architecture, decision,
  constraint, procedure, and risk entries saved through the governed store as
  `unverified`; no stage promotion or field-effectiveness claim is implied.
- The pi-queue Redis integration tests skip with an explicit reason when the
  queue client or docker is unavailable instead of failing the unit profile.

## legacy-project-memory-migration - 2026-10-23

- Added an explicit operator migration from legacy `Memory/<project>/` notes
  into managed `Memory/Projects/<name>-<rootHash>/` notes. It is dry-run by
  default, leaves legacy notes byte-identical, drops transient git state and
  retains commit references as evidence IDs.
- Re-running dedupes identical entries; corrected migration-owned entries are
  superseded in place, while other title collisions go to the review queue.
- Retention now covers reasoning snapshots, diagnostics report the effective
  automatic-save control, and the affected tests are umask-independent.

## source-bound-project-memory-capture - 2026-10-18

- Added `memory_curator operation=capture` for operator-authorized,
  source-bound capture: one fact per call, grounded in an exact current-turn
  quote, bounded attempts, privacy scanning, transient/speculative rejection,
  and dedupe under the project write lock. Capture stores unverified,
  non-standing entries and grants no recall or promotion authority by itself.
- Recall now reads validated canonical `Memory/Projects/<name>-<rootHash>/`
  notes directly and resolves supersession/contradiction exclusions before
  expiry and cache limits; legacy compiled caches fail closed.
- Harness defaults now request manual M1 with `PI_PROJECT_MEMORY_WRITES=1`,
  `PI_PROJECT_MEMORY_AUTOMATIC=1` and `PI_PROJECT_MEMORY_AUTO_SAVE=1`.
  Explicit process environment still wins; an inherited
  `PI_PROJECT_MEMORY_STAGE=M0` keeps capture, recall and manual saves disabled.
- No evidence-based stage promotion, Hermes curation, automatic verified upsert
  or retention apply is authorized. Field effectiveness remains unproven.

## specialist-task-v2 - 2026-10-18

- Removed specialist task/run budgets, accounting approval and correction caps;
  producers/reviewers inherit parent model and thinking effort. Generic roles
  retain their existing budget behavior. Startup health, cancellation, containment,
  output and host-retention limits remain enforced.
- Replaced blocking human acceptance with artifact-linked `feedback`. Removed
  extra UI confirmations and headless restrictions; application remains a
  separate explicit parent action with executable rechecks. Optional schema-v2
  policy defines checkers only; legacy graph/policy fields are rejected.
- Added hash-pinned, networkless BlenderAI canonical dispatch, editable native/GLB
  export and independent named-object animation round-trip acceptance. Native
  positive/negative BlenderAI, Lean and REA fixtures pass without providers.
- Automatic routing remains off. Live comparative effectiveness is not established.
  The older enablement requirements below are historical and superseded.

## manual-subagent-session-enablement - 2026-10-18

- Enabled explicit manual topology/task tools in canonical defaults for normal
  sessions; automatic routing, field-pilot mode and worker canary remain off.
  Explicit `0` overrides still win. Start a new Pi process for changed defaults.
- Specialist task launches still fail closed without a reviewed per-project model,
  reservation and checker policy, and require interactive confirmation. No policy,
  provider spend, human acceptance or parent application is approved by startup.
- Added read-only `specialist_tasks context` for current baseline/role identities,
  approved accounting and checker metadata. Ordinary manual use is distinct from
  the separately approved matched evaluation and does not establish live benefit.

## run-monitor-auto-resume - 2026-10-01

- `run_monitor` now wakes the agent when monitored work reaches a milestone match or settles: the extension queues one `pi.sendUserMessage` follow-up (`deliverAs: "followUp"`) naming the monitor, target, outcome, and exit reason without log text. Edge notifications are unchanged; timeouts, errors, and stops only notify.
- Duplicate wake-ups are prevented by a persisted per-monitor `wake` claim written before sending and by first-claim-wins target settlement within a session. `run_monitor` tool results, print/JSON sessions, and sessions with an active `automation_loop` record a skipped claim instead of waking the agent.

## topology-disabled-by-default - 2026-09-09

- Disabled topology execution and auto-routing by default through the guarded harness environment, the integration adapter default, and the reasoning-runtime adapter gate. Reviewed sessions must explicitly set `PI_MULTI_AGENT_TOPOLOGIES_ENABLED=1` for topology execution, and choose a non-off router mode only when they also want auto-routing.
- Changed missing or invalid auto-route configuration to fail closed to `off`.

## r5-planner-runtime-repair - 2026-08-31

- Planner completion now requires a meaningful evidence-backed summary, rejects placeholder/no-op roadmap labels, and reserves a final correction call. Coder/refactorer completion requires evidence and an explicit verification verdict; authoritative workspace capture rejects successful proposed-patch roles that changed no files.
- Role sidecars accept at most one submission attempt per model response and one successful result overall. Parent RPC validation rejects duplicate successful submissions, while topology packets deduplicate causal errors, retain child termination details, and record canonical terminal auto-router outcomes.
- Auto-router intent and topology hints ignore pasted auto-role warning reports, so diagnostic node labels such as `optimize` and `performance-regression` cannot turn an investigation request into delegated mutation.
- Canonical-shaped but completion-invalid submissions now reach the sidecar's per-response admission gate before semantic rejection, preventing parallel placeholder probes from bypassing duplicate protection. Planner correction retains a bounded 240-second wall clock, and subagent nodes own their timeout lifecycle instead of racing a duplicate topology timer.
- Proposed-patch roles can report an explicit `baseline-satisfied` disposition when task-relevant dirty parent paths are already present in the isolated baseline. The runtime authoritatively matches every claimed path and forwards the disposition to the verifier; absent, fabricated, and accidental empty patches still fail closed. Researcher, coder, and verifier wall-clock budgets allow five, eight, and nine bounded minutes, respectively, and `role_verify` publishes stable IDs for the parallel-evidence regression and repository-wide check, and launches them without leaking sidecar-only environment state, so verification can finish before disposition handoff. The reasoning TUI smoke explicitly loads only its target extension, preventing nested isolated worktrees from double-discovering ancestor project extensions during `check-all`; project-setup checks likewise resolve the canonical harness root through Git's common directory instead of expecting global settings to point at an ephemeral worktree.

## r5-delegation-follow-through-and-gates - 2026-08-30

- Changed `delegate` mode from model guidance to runtime-owned follow-through: matched top-level prompts execute the selected topology, wait for settlement, and inject a bounded typed result into the parent turn. Child routing remains off, cooldown/cancellation remain active, and isolated patches still require explicit parent application.
- Reviewer and verifier completion now reject placeholder summaries, missing evidence, and unchecked successful verdicts at both sidecar submission and parent envelope validation.
- Verifier nodes satisfy topology gates only with `verification.status=passed`; failed or unchecked verdicts produce a failed topology result. Role-specific public fields such as coverage and unresolved gaps are promoted for aggregation.

## fully-enabled-role-delegation - 2026-08-28

- Enabled canonical role v2 execution at explicitly configured R5 with isolated mutation, typed sidecars, delegate routing, and role-specific model/thinking profiles. The R0 field pilot and worker shadow canary are disabled in this mode.
- Made an explicitly configured rollout stage and router mode authoritative while retaining separate evidence eligibility/status. Omitting the stage still uses fail-closed evidence selection capped at R4; configured overrides never relabel benchmark or field evidence.
- Initially added delegate-mode model guidance requiring `auto_role_router operation=run` for matched tasks. This guidance-only behavior was superseded by the 2026-08-30 runtime-owned follow-through above.

## worker-shadow-canary - 2026-08-25

- Added the enabled-by-default `PI_ROLE_WORKER_SHADOW_CANARY` R0 field-pilot path. Only strict bounded read-only worker matches with the exact Luna/low profile may start one provider-backed sidecar; mutation, child/headless execution, generic topology routing, unsafe profiles, and excluded intents remain blocked.
- Kept the normal parent turn independent and displayed worker outcomes separately. Compact canary lifecycle telemetry contains hashes, profile/policy metadata, run links, and outcomes rather than task or result text; `PI_ROLE_WORKER_SHADOW_CANARY=0` restores recommendation-only routing immediately.
- Added explicit classified/matched/execution booleans to compact router decisions and a deterministic interactive TUI smoke for the input-hook → worker-canary topology path, preventing automatic routing from being mistaken for absent model tool calls.
- Wired topology workers through the integration boundary's injected subagent service, so isolated state roots apply consistently to direct and topology-launched workers.

## guarded-defaults-and-uncertainty-telemetry - 2026-08-08

- Added `config/harness-defaults.env` plus a first-loaded defaults extension. Explicit process environment values still win; guarded defaults keep policy enforcement in block mode, trace/telemetry metadata-only, role runtime at read-only R0/suggest, automatic mutation/sync/scans off, and execution capture advisory-only.
- Updated the global settings installer to order the defaults loader first and pin bounded Pi compaction/agent-retry settings while preserving provider, model, theme, provider timeout, and unrelated extensions.
- Enabled a selected-tool output-compactor canary without exposing its compatibility model tool. Schema-v5 feature signals measure only input/output/saved characters, duration, fixed tool/action categories, and privacy-tokenized sessions.
- Added run-monitor intent, acted-opportunity, lifecycle, terminal, and settlement-notification signals without storing prompts, raw session/target IDs, patterns, paths, logs, commands, or output.
- Replaced the stale zero-session portfolio fallback with a current-session-excluded HMAC-tokenized interactive cohort. RPC/JSON/print calls no longer count as interactive, and lifecycle authority still requires 30 observed days with at least 95% token coverage.
- Expanded the reconciled portfolio to 48 extensions while retaining 59 active parent model tools and five command-only compatibility tools.

## extension-reliability-phase7 - 2026-07-26 (no-go-deferred)

- Added source/config freeze manifests, a tracked aggregate-only Pi session auditor, exact-version telemetry cohorting, and machine-readable/Markdown Phase 7 scorecards.
- Hardened final-review boundaries: branch snapshots now reject traversal/private aliases and symlink components; Obsidian writes reject vault symlinks; explicit empty test profiles stay not-applicable; audit exclusions require exact matches; generated scorecards end with one newline.
- Reconciled the live fleet at 47 extensions, 382 registered commands, and 59 active parent model tools with zero degraded/conflicting/unexplained surfaces.
- Re-ran exact active-session exclusion for the newly frozen source cohort; one matched active session was excluded, one post-freeze `other` session was analyzed, and the cohort remains below 14 observed interactive days.
- Promoted role runtime to the valid benchmark-authorized advisory ceiling R4 only when a private report passes its bars, matches the current fixture-manifest/runtime-source hashes, and is fresh (seven days by default). Missing, stale, future-dated, mismatched, or unverifiable evidence stays at R0; explicit R0/version-1 rollback preserves v2 state; R5 and hidden mutation remain unauthorized.
- Recorded 9 PASS, 0 FAIL, and 2 INSUFFICIENT DATA ship bars. Semgrep's post-fix rate and live context-reduction rate remain unqualified, so no irreversible portfolio retirement or release shipment is authorized.
- Passed the final combined-tree `scripts/check-all.sh` gate: repository tests, 47 isolated RPC probes, full-fleet model smoke, required TUI checks, project setup, Pi drift, and Pi/Hermes regressions.

## goal-runner-v1 - 2026-05-20

- Added Hermes-backed autonomous `/goal` commands as a project-local Pi extension.
- Added persistent goal state and archive storage under `.pi/goal-state/`.
- Added strict JSON Hermes controller parsing, repair retry, objective completion guardrails, max-iteration blocking, cancellation, final Hermes summary sync, trace emission, export/prune/archive/metrics/doctor commands, and conservative safety policy.
- Added optional deterministic TUI regression script: `scripts/check-goal-tui.sh`.
- Added fixture controller/execution environment knobs for deterministic validation and persisted goal trace querying via `/goal-trace`.
- Validated with unit tests, extension smoke checks, full `scripts/check-all.sh`, print-mode checks, and script-driven TUI validation in `~/test-repo/`.

Tag: `goal-runner-v1`.
