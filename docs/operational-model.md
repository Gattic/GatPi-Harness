# Operational model

Pi is the local coding harness. Obsidian is canonical project memory. Hermes is an off-path typed advisory provider.

## Memory contract

Store durable summaries only:

- architecture decisions
- TODOs, risks, and follow-up checks
- test/build outcomes
- touched files and modules
- constraints and user preferences

Do not store secrets, credentials, private keys, full transcripts, or sensitive local paths in durable memory.

## Responsiveness contract

Hermes advice is explicit and off the normal prompt path by default:

- consumers send bounded categorical packets through `HermesAdvisoryAdapter`;
- no transcript, raw tool output, command argument, secret, private reasoning, or absolute path is sent;
- Hermes owns no conversation cache, recall lifecycle, or shutdown sync;
- automatic prompt refinement and skill drafting remain disabled unless separately authorized;
- `/subagent` and `/subagent-run` use the single detached Role v2 RPC sidecar path so long-running child work does not freeze the parent TUI; there is no replacement-session/fork fallback.

## Refresh/check workflow

Use the state-aware orchestrator for normal maintenance:

```bash
scripts/pi-harness-refresh.sh              # extensions + skills + full checks
scripts/pi-harness-refresh.sh --pi         # linked Pi source fork + full checks
scripts/pi-harness-refresh.sh --all        # Pi + extensions + skills + full checks
scripts/pi-harness-refresh.sh --check-only # checks without resource deployment
```

Use `--dry-run` to validate and preview, `--no-check` to explicitly bypass the full gate, and `--skip-pi-deps` with `--pi` to reuse the fork's existing dependencies. The orchestrator validates current settings, source directories, helper executability, active Pi drift, and Pi Git identity/cleanliness before invoking the lower-level helpers. `scripts/install-project-extensions.sh`, `scripts/install-agent-skills.sh`, `scripts/setup-pi-fork.sh`, and `scripts/check-all.sh` remain independently callable diagnostics/building blocks.

## Recovery/debug commands

```text
/hermes-status
/hermes-debug
/hermes-cache
/hermes-cache-clear
/hermes-state-display [on|off|toggle]
/trace-status
/trace-live [filter]
/trace-timeline
/trace-errors
/trace-export [id]
/trace-replay summary
```

## Skill evidence and approval

Skill lifecycle labels are compatibility metadata, not rollout authority. Governance v2 reports source trust, schema validity, sandbox review, local verification, exact-version field proof, advisory retrieval, routing approval, and publishing approval independently. Only explicit current-user governance actions may change approvals or write a skill-derived topology; publishing remains command/human-only. Deterministic fixtures never establish field proof.

## Execution-learning handoff

Settled `/loop` and `/goal` producers share the packet contract in [Settled execution to learning handoff](execution-learning-handoff.md). Model-side reasoning remains canonical. The harness stores only bounded public metadata and evidence references; project-memory promotion remains an independent reviewed operation.

## Maintenance previews and provenance

`/memory-maintenance-preview` and `node scripts/report-memory-maintenance.js --preview` generate private, metadata-only maintenance reports. They unify stale, duplicate, conflict, supersession, orphan-reference, retention, permission, and source-decision consistency candidates without deleting, rewriting, promoting, or applying anything. Repeated reports retain stable candidate IDs and classify candidates as new, persistent, or resolved. Periodic preview generation is off by default; `PI_MEMORY_MAINTENANCE_PREVIEW_INTERVAL_HOURS=<hours>` explicitly opts session start into a due check. It is not a cleanup daemon.

`/memory-provenance [seed]` and `memory_explorer operation=provenance` build a bounded read-only graph across Evidence Binder, settled executions, learning outcomes/patterns/proposals, skill captures/exact versions, and project-memory decisions. `/memory-lineage` now returns both typed-memory lineage and this bounded graph. Graph output contains normalized IDs, hashes, statuses, and edge types only—never source bodies, prompts, transcripts, command arguments, raw tool output, private reasoning, secrets, or absolute paths. `/memory-provenance-export [seed]` is the explicit private export surface.

Neither feature changes the project-memory rollout decision: production remains `no-go-deferred` at M0, with no automatic promotion or maintenance apply.

## Compounding scorecard

`/learning-scorecard`, `/compounding-scorecard`, and `node scripts/report-compounding-effectiveness.js` generate a private metadata-only scorecard across exact-version skills, execution/learning conversion, evidence coverage, canonical recall quality, stage cost, maintenance accounting, privacy rejections, and provenance diagnostics. A control/candidate delta is refused without one pre-registered cohort ID, both arms, exact skill/version/source hashes, and independent session hashes. Missing field evidence is `insufficient-data`, never a zero/pass inference.

The field experiment `exp-memory-learning-compounding-efficacy-field` is pre-registered but not started by report generation. Scorecards never authorize routing, publishing, memory promotion, or apply operations. See [Compounding effectiveness scorecard](compounding-effectiveness-scorecard.md).

## Local state

Private local state is reversible:

```text
.pi/cognitive-automation/
.pi/execution-outcomes/          # private settlement packets and metadata-only index
.pi/hermes-advisory/             # metadata-only receipts and optional scorecard
.pi/hermes-skill-candidates/     # quarantined, not loaded as Agent Skills
.pi/memory-maintenance/          # private preview reports and metadata-only index
.pi/learning-loop/scorecards/    # private compounding scorecards and metadata-only index
.pi/provenance-graph/exports/    # explicit private metadata-only exports
.pi/traces/
```

Hermes has no global conversation/cache memory state. Use `scripts/clean-runtime-state.sh --yes` for project-local runtime state.
