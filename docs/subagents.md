# Subagents

A subagent is a delegated child invocation backed by Pi's existing session branch system (`src/session-branches.js`). It is not a separate agent framework or a parent-assistant identity switch. Roles v2 distinguishes context/trajectory isolation from filesystem policy: read-only roles use the shared repository view without mutating tools; coder/refactorer/verifier-style roles execute in detached Git worktrees and return proposed changes. The parent session remains active, and no role patch changes the parent tree until an explicit hash-checked apply action.

Topology schema v3 can fan out multiple read-only subagents and join them with explicit all/quorum/min-success/best-effort semantics. `parallel-evidence-synthesis` uses four orthogonal workers, an `evidence-auditor`, and a handler-only coordinator. The auditor receives typed evidence-only projections, not worker summaries, transcripts, scratchpads, or sibling trajectories. This does not change subagent record/result formats: role contracts and terminal envelopes remain v2.

## Mapping

- Durable subagent record: `.pi/subagents/records/<id>.json` (`0600`)
- Durable result envelope: `.pi/subagents/results/<id>.json` (`0600`)
- Child RPC session directory: `.pi/subagents/rpc-sessions/<id>/` (`0700`; files hardened after completion/failure)
- Isolated mutation workspace: `.pi/subagents/workspaces/<id>/` (`0700`) with a detached tree, lease metadata, bounded binary patch, path hashes, and recovery capture
- Patch preview/apply metadata: `.pi/subagents/patches/` (`0700`; metadata only, no transcript)
- Child trajectory: a normal `multi-agent` session branch created by `SessionBranchManager.createBranch()`
- Branch provenance: stored in the child branch `metadata` and initial snapshot `contextState.subagent`
- Child steps/results: stored as normal branch checkpoints via `SessionBranchManager.checkpoint()`
- Filesystem payloads: metadata-only by default (`filesystemState.files = {}`) for subagent lifecycle checkpoints so 4-way skill fanout does not synchronously snapshot the repository on the parent TUI thread
- Agent lease: recorded with `assignAgent()` / `completeAgentWork()`

## Execution model

All live subagents use one canonical detached RPC sidecar path (`executionMode: "tool-rpc"`). `/subagent` and `/subagent-run` launch it without replacing the parent session. `create_subagent operation=launch` returns immediately; `operation=run` performs the same detached launch followed by one bounded wait. The removed replacement-session/fork path has no compatibility fallback.

Before process creation, `SubagentService` resolves the role, model/thinking profile, exact child tools, context projection, workspace/mutation policy, budgets, rollout, parent ceiling, and user-wide resource admission. `/subagent-preflight` and `create_subagent operation=preflight` run that resolver without creating a process, session, record, workspace, lock, telemetry row, or cache entry. The effective configuration receives a deterministic launch digest, and launch fails closed if its effective fields cannot be resolved.

The sidecar starts `pi --mode rpc --no-extensions -e <role-sidecar> --no-skills --no-prompt-templates --model <provider/model> --thinking <level>`, monitors stream events against budgets, inspects authoritative state/messages, validates effective inference and the Role v2 envelope, then waits for exact process-group close before terminal receipt, capacity release, or cleanup. No subagent settlement starts background Hermes learning.

## Skill awareness

Role children run with skill discovery disabled, so a delegated role can neither see Pi's skill roster nor load a skill body. Every role-v2 contract therefore carries a bounded skill-awareness block built by `src/skill-awareness.js` from the checked-in `skills/catalog.json`: the full catalog roster grouped by category, the skills whose declared discipline governs that role, and the rule that the child names any applicable skill in its findings and asks the parent for a body when the exact procedure matters. Explicit custom read-only roles and non-contract children receive the roster; role-specific guidance appears only when the role id matches a registered role.

The block is bounded (16000 characters). If the roster ever outgrows that bound the block degrades deterministically instead of failing extension load, and it says so: role-specific skill detail is dropped first, then trailing categories are omitted with an explicit `Roster truncated: N of M skill names are listed` note pointing at `skills/CATALOG.md`. It fails closed on a missing, empty, duplicate or malformed catalog entry. `skills/catalog.json` is the only source of truth, so a retired skill cannot reappear in a child prompt: `tests/skill-awareness.test.js` rejects archived skill names in the awareness text, role prompts, or generated skill bodies. Because children cannot load skills, the parent passes the relevant `SKILL.md` content in the task when a child must follow an exact procedure, and the parent keeps that skill's acceptance gate.

A child receives the block exactly once: role children get it through the contract's system prompt (`--append-system-prompt`), prompt-only children get it inline, and a record resumed with a persisted contract that predates skill awareness receives it at launch. The roster is appended to the prompt only when the prompt does not already carry it.

### Contract revisions and resumability

Skill awareness is part of each role's system prompt, so it participates in `roleRevisionHash`: any prompt or policy change to a role changes that role's revision. A durable typed record created against an older revision has no persisted contract and cannot resolve a builtin contract on continuation, so `continue`/`resume` fail closed with `SUBAGENT_ROLE_CONTRACT_UNAVAILABLE` instead of silently running a different prompt. Persisted specialist task graphs pin `contractRevision` and fail with `TASK_CONTRACT_STALE` when it no longer matches. Recreate the attempt, or rebuild the task graph against the current contracts, after such a change; the failure is the safety property, not a defect. Records that persisted an explicit contract object keep running that contract.

## API

```js
const { SubagentService } = require("./src/subagents");
const service = new SubagentService({ cwd: process.cwd() });

const sub = service.createSubagent({
  parentSessionId: "sess_123",
  parentBranchId: "br_parent",
  branchFrom: { branchId: "br_parent", snapshotId: "snap_abc", messageId: "msg_1" },
  role: "researcher",
  task: "Inspect the implementation options",
  budget: { maxModelCalls: 4, maxToolCalls: 24, wallClockMs: 120000, maxQueueWaitMs: 120000, maxResultChars: 12000 },
  mergePolicy: "none",
});

const preflight = service.preflightSubagent({ ...sub, task: "Inspect the implementation options" }, { inheritedModel: "provider/model", inheritedThinkingLevel: "low" });
const launch = service.launchSubagent({ subagentId: sub.id, context: { cwd: process.cwd(), model, thinkingLevel, executionMode: "tool-rpc" } });
const result = await service.waitSubagent({ subagentId: sub.id, timeoutMs: 30000 });
// Foreground is the same launch followed by a bounded wait:
const foreground = await service.runSubagent({ subagentId: sub.id, context: { cwd: process.cwd(), model, thinkingLevel, executionMode: "tool-rpc" } });
service.steerSubagent({ subagentId: sub.id, message: "Narrow the review to the public contract." });
service.interruptSubagent({ subagentId: sub.id });
await service.cancelSubagent({ subagentId: sub.id });
service.continueSubagent({ subagentId: sub.id, task: "Perform a new bounded follow-up." });
service.listSubagents({ parentSessionId: "sess_123" });
service.getSubagent({ subagentId: sub.id });
service.mergeSubagentResult({ subagentId: sub.id, targetSessionId: "sess_123", mergePolicy: "summary_only" }); // trajectory only
const preview = service.previewSubagentPatch({ subagentId: sub.id });
await service.applySubagentPatch({ subagentId: sub.id, preview, explicit: true, verify });
```

Pi command helpers are registered by the reasoning runtime extension. Direct roles resolve through the topology `AgentRoleRegistry` to validated `RoleContract` v2 objects. Durable records contain policy/profile IDs, role and task/prompt hashes, budgets, lineage, status, accounting, and receipts—not task text or system prompts. Task/prompt bodies remain process-local until passed to the private child session. Unknown role labels fail unless the caller supplies an explicit `systemPrompt`; explicit custom roles are normalized, bounded, schema-valid, and shared-readonly.

Commands:

- `/ask <question>`: ask a side question about the current session in a non-blocking sidecar widget without mutating the parent chat
- `/ask-status`: show recent ask sidecar questions and answers
- `/ask-panel`: focus the scrollable ask sidecar panel
- `/ask-fork [latest|ask_id]`: fork an ask sidecar Q/A into a new Pi session
- `/ask-clear`: clear the ask sidecar widget for this session
- `Ctrl+Shift+A`, `Alt+A`, or `F8`: focus the ask sidecar panel (`Alt+A`/`F8` are fallbacks for screen/tmux/terminal conflicts)
- `/subagent-preflight [--role registered-id] [--merge policy] <task>`
- `/subagent [--role registered-id] [--merge policy] [--no-run] <task>`: create and launch a subagent
- `/subagent-create [--role registered-id] [--merge policy] <task>`
- `/subagent-run <subagent-id|latest>`
- `/subagent-list`
- `/subagent-show <subagent-id|latest>`
- `/subagent-wait <subagent-id|latest> [timeout-ms]`
- `/subagent-steer <subagent-id|latest> <follow-up>`
- `/subagent-interrupt <subagent-id|latest>`
- `/subagent-cancel <subagent-id|latest>`
- `/subagent-continue <subagent-id|latest> <new-task>`
- `/subagent-resume <subagent-id|latest> <new-task>`
- `/subagent-merge <subagent-id|latest> [policy]` — merges trajectory/result data only; never files
- `/subagent-patch-preview <subagent-id|latest>` — validate patch hash, paths, parent revision/status, and conflicts
- `/subagent-patch-apply <subagent-id|latest> --yes` — explicit parent apply followed by `git diff --check`; failed verification rolls files back
- `/subagent-status`
- `/subagent-events [limit]`
- `/subagent-export [file]`
- `/subagent-prune [--keep=N] [--older-than=Nd] [--status=a,b]`

The extension also displays a compact `subagents` status widget while subagents are created/listed/run, showing active/final counts and the latest subagent.

A model-callable tool is also registered:

- `create_subagent`
  - operations: `preflight`, `create`, `launch`, `run`, `list`, `status`, `get`, `wait`, `steer`, `interrupt`, `cancel`, `continue`, `resume`, and `merge`;
  - `launch` returns a stable ID immediately; `run` uses launch plus a bounded wait;
  - continuation/resume creates a new linked attempt and never reopens a settled record;
  - public DTOs and events omit task text, prompts, transcripts, private reasoning, commands/tool payloads, workspace/session paths, and raw child output.

Deterministic TUI validation is available with:

```bash
scripts/check-subagent-tui.sh
PI_CHECK_TUI=1 scripts/check-all.sh
```

A bounded, transcript-free corpus audit is available with:

```bash
node scripts/audit-role-runtime.js --sessions ~/.pi/agent/sessions --output .pi/role-runtime/audits/baseline.json
```

Use `--current-session <file>` (or `PI_SESSION_FILE`) to exclude the active append target. The report contains counts, modes, hashes/provenance checks, exact tool accounting, and synthetic-bug finding totals—not prompt, message, source, or tool-result bodies. Scans stop at `--max-files`/`--max-bytes` and report truncation explicitly.

## Lifecycle states

`created`, `queued`, `running`, `succeeded`, `failed`, `cancelled`, `timed_out`.

Failures, cancellations, and timeouts are persisted as structured result envelopes so the parent session is not crashed. Interruption records an acknowledged control request and yields a resumable cancelled attempt; resume creates a new linked attempt. Settled records are immutable. Final result persistence is idempotent: a late RPC event cannot replace a terminal record. Exact process close precedes the immutable receipt, capacity release, and workspace cleanup.

## Ask command

Use `/ask <question>` for quick read-only questions about the current session, for example:

```text
/ask What did we decide about Hermes advisory latency earlier?
```

`/ask` snapshots the current active session branch as read-only context and calls the currently selected model directly in a background sidecar task. The `ask` widget renders above the editor at full width, so the TUI stacks as main chat, ask sidecar panel, then the prompt editor. The sidecar panel targets 50% of the available chat height (configurable with `PI_ASK_WIDGET_HEIGHT_FRACTION`) and shows recent questions/answers inline; `/ask-status` remains available as a text view. It does not call `ctx.fork()`, `ctx.sendUserMessage()`, or `runSubagent()`, so it avoids visible replacement-session churn and does not add the side question to the parent LLM context. Ask sidecar results are process-local and are not rehydrated on restart/reload; startup removes legacy `.pi/ask/*.json` files from earlier versions. `/ask-clear` and `c` clear and close the in-memory panel.

Use `/ask-panel`, `Ctrl+Shift+A`, `Alt+A`, or `F8` to focus the same scrollable sidecar panel. It is full-width and anchored above the prompt area rather than opening as a right-side window. `Ctrl+Shift+A` may be intercepted by GNU screen because it commonly collapses to `Ctrl+A`, screen's default prefix. Keys inside the panel: `↑/↓` or `j/k` scroll, `PgUp/PgDn` page, `n` submit a new ask question, `f` fork the latest ask Q/A into a new Pi session, `c` clear and close, and `q`/`Esc` close. If the panel was opened from a shortcut, `f` shows the `/ask-fork <id>` command for you to submit from the TUI because Pi session replacement APIs are command-context only.

## Merge policies

- `none`: store the result only; no parent trajectory mutation.
- `summary_only`: append a compact `subagent.summary` checkpoint to the parent branch and a parent-visible Pi custom session entry (`subagent.result`) when invoked through the extension.
- `full_result`: append the full normalized result envelope to the parent branch and parent-visible custom entry.
- `proposed_patch`: append patch metadata/artifacts to the parent trajectory only; `filesystemApplied` remains false.

Trajectory merging and filesystem transfer are separate APIs. `mergePolicy` never applies files. Filesystem transfer requires `previewSubagentPatch()` followed by `applySubagentPatch({ explicit: true, verify })`, or the corresponding preview/`--yes` commands. Preview rejects stale parent state, hash/size mismatches, forbidden/escaping paths, and `git apply --check` conflicts.

## Explicit specialist task graphs

See [Explicit specialist tasks](specialist-tasks.md) for the boundary-backed
`specialist_tasks` tool, reviewed local policy, dependency/artifact gates,
correction/recovery, BlenderAI animation dispatch, domain availability and the
separate field protocol. The task surface defaults on (`PI_SPECIALIST_TASKS_ENABLED=1`).
Specialist producers/reviewers inherit the parent model and thinking effort and
have `budget: null`: no task/run budgets or correction caps. Per-role
`PI_ROLE_MODEL_<ROLE_ID>`/`PI_ROLE_THINKING_<ROLE_ID>` overrides win over that
inherited profile; RPC inference profile overrides do not replace it. Generic role
budgets described elsewhere in this document remain unchanged.

Optional project policy configures checkers; a missing policy supplies dossier
verification. `feedback` records artifact-linked, non-blocking human review.
There is no extra UI confirmation or headless prohibition. This neither enables
automatic routing nor grants implicit application/publish authority. Status
separates accepted proposals from applied outcomes and exposes dependency edges,
artifact/receipt IDs, observed usage and recovery references.

Parent patch application uses a cooperative exclusive lease and drift checks;
rollback preserves observed concurrent edits rather than restoring blindly.
Recovery journals are bounded and retained for explicit reconciliation. This is
not an OS-atomic transaction against arbitrary host writers.

## Configuration

Role rollout/rollback controls are evaluated before typed role creation or topology execution:

- `PI_ROLE_RUNTIME_VERSION=1|2` selects legacy compatibility or v2 without migrating state.
- `PI_ROLE_MUTATION=off|isolated` immediately blocks or permits only isolated proposed-patch mutation.
- `PI_ROLE_SIDECAR=0` disables typed sidecar launches. The canonical parent leaves it unset; only explicit role children receive `1`.
- `PI_ROLE_ROLLOUT_STAGE=R0..R5` is authoritative when explicitly configured. If omitted, fresh deterministic and exact live-field evidence select a stage capped at R4.
- `PI_ROLE_WORKER_SHADOW_CANARY=0|1` controls the R0/suggest/mutation-off bounded worker canary; the disabled-topology canonical configuration sets `0`.
- `PI_ROLE_RUNTIME_BENCHMARK_REPORT` points at the deterministic report. See [Role runtime benchmark and rollout](role-runtime-benchmark.md).
- `PI_ROLE_MODEL_<ROLE_ID>` overrides the role model with a separate `provider/model` value.
- `PI_ROLE_THINKING_<ROLE_ID>` overrides the role thinking level (`off|minimal|low|medium|high|xhigh|max`).

All model-backed delegates default to `local/DeepSeek-V4.1-Flash-1017`, including custom roles and patch-reviewer. Model and effort resolve separately; the canonical `config/harness-defaults.env` pins the role effort levels in the table below. Pinned effort must stay within the delegate model's supported levels: models that do not declare `xhigh` or `max` fail closed at launch when a role pins them. Handler-only roles launch no model. Model values with embedded thinking suffixes are rejected. Start a new Pi process to load changed `config/harness-defaults.env` values; `/reload` retains existing environment values.

### Inference precedence

Model and thinking resolve independently, in this order:

1. `PI_ROLE_MODEL_<ROLE_ID>` / `PI_ROLE_THINKING_<ROLE_ID>` environment override. An invalid thinking value is rejected rather than ignored.
2. The role contract's `modelPolicy`: `fixed` requires a preference, `preferred` uses its preference when declared and otherwise the parent model, and `inherit` uses the parent model. A contract `thinkingLevel` other than `inherit` pins that effort.
3. The parent session profile, used only where the resolved policy is `inherit`. It is read before spawn, so every child receives both `--model` and `--thinking`.

A configured model override switches the effective mode to `preferred` and wins over the contract preference. The recorded `fallbackModel` is provenance only: role children launch with one fixed model and never fail over. The role sidecar verifies the effective profile before provider use, and the parent records selected/effective categorical provenance.

### Canonical role profiles

| Roles | Model | Effort |
|---|---|---|
| planner, reviewer, coder, refactorer, evidence-auditor | `local/DeepSeek-V4.1-Flash-1017` | `high` |
| researcher, benchmark | `local/DeepSeek-V4.1-Flash-1017` | `medium` |
| worker, verifier | `local/DeepSeek-V4.1-Flash-1017` | `low` |
| patch-reviewer, custom roles | `local/DeepSeek-V4.1-Flash-1017` | inherited |
| integrator, mathematical-researcher, reverse-engineer, 3d-critic, reliability-investigator, code-profiler, security-reviewer | inherited | inherited |
| 3d-modeler | inherited | `medium` (canonical pin) |
| coordinator, memory-curator, skill-intake-handler, tool-specialist | none (handler-only) | none |

Specialist contracts set `budget: null` and inherit the parent profile unless a role override is configured; 3d-modeler is the only specialist with a canonical effort pin.

The registered `worker` role declares `autoRoutePolicy=suggest`, `workspacePolicy=shared-readonly`, and `mutationPolicy=forbidden`. The canonical configuration enables explicit manual topology execution but leaves auto-routing off, so matched top-level prompts stay in the parent session unless the parent explicitly delegates or an operator opts into a router mode. The full artifact-gated task workflow additionally requires a reviewed per-project policy; see [normal-session specialist use](specialist-tasks.md#normal-session-use). The older R0/suggest/mutation-off canary remains available as a rollback/field-pilot mode: when explicitly enabled, only a strict bounded read-only lookup can launch one separate DeepSeek-V4.1-Flash/low worker. Broad research, review, verification, benchmark, security, debugging, credential, publish, destructive, and mutation requests are never eligible for that canary. See [Multi-agent topologies](multi-agent-topologies.md#r0-safe-worker-recommendation) for classifier and canary details.

Rollback preserves v2 records, child sessions, workspaces, and patches for diagnosis; it does not require state migration.

Environment variables:

- Nested subagent delegation is disabled; live depth is fixed at one and cannot be widened by configuration.
- `PI_SUBAGENT_MAX_CONCURRENT` default `8`; actual RPC sidecar execution is still throttled by `PI_SUBAGENT_RPC_CONCURRENCY`, so this is headroom for skill fanout records rather than CPU fanout
- `PI_SUBAGENT_DEFAULT_WALL_CLOCK_MS` default `300000`; for RPC children, bounds startup/prompt acceptance first, then independently bounds execution from the matching successful `prompt` response through final result validation. Both phases use the same effective timeout (`rpc.timeoutMs` overrides the record's `wallClockMs`). Duplicate acknowledgements and continuations never renew the execution deadline; missing acceptance terminates as `rpc_startup`.
- `PI_SUBAGENT_DEFAULT_STEP_BUDGET` default `8`; compatibility name enforced as `maxModelCalls`
- `PI_SUBAGENT_DEFAULT_TOOL_CALL_BUDGET` default `64`
- `PI_SUBAGENT_DEFAULT_QUEUE_WAIT_MS` default `300000`
- `PI_SUBAGENT_MAX_LENGTH_CONTINUATIONS` default `0`; a positive value permits only that many bounded continuation turns within the same budgets
- `PI_SUBAGENT_BRANCH_SNAPSHOT_MODE=full` or `PI_SUBAGENT_FULL_BRANCH_SNAPSHOTS=1` opts subagent lifecycle checkpoints back into full filesystem snapshots; default metadata-only checkpoints avoid blocking the TUI during `/skill:code-review-evidence` fanout
- `PI_SUBAGENT_RPC_COMMAND` overrides the sidecar executable; default `pi`
- Role-v2 RPC sidecars disable normal extension, skill, and prompt-template discovery and load only `extensions/role-sidecar/index.ts`. The child sets `PI_ROLE_SIDECAR=1`, receives a base64url contract, and has no nested delegation surface.
- `PI_SUBAGENT_RPC_CONCURRENCY` defaults to `2`, limiting fanout inside one Pi process. Specialist-task RPC, contained-command and build runners additionally share a user-wide two-worker cooperative lease; approved nested tools reuse their sidecar's slot. This is not a limit on arbitrary host processes or every detached `bg_run`/`run_deck` job. Local FIFO delay is included in `queueWaitMs`, bounded separately from child execution, and persisted through the `queued` state
- Each RPC child runs in a harness-owned process group. `PI_MANAGED_PROCESS_MAX_RSS_MB` (default `6144`) caps aggregate child-and-descendant RSS, `PI_MANAGED_PROCESS_RSS_POLL_MS` (default `2000`) controls sampling, and `PI_MANAGED_PROCESS_TERM_GRACE_MS` (default `5000`) bounds `SIGTERM` before group-only `SIGKILL` escalation
- RPC depth is fixed at one: parent → sidecar is allowed and sidecar → sidecar is always rejected.
- `PI_SUBAGENT_EXECUTION_FIXTURE_RESULT` supplies deterministic runner output for TUI tests
- `PI_CHECK_TUI=1` includes subagent TUI validation in `scripts/check-all.sh`
- `PI_CHAT_FOCUS_RECENT_FINAL_SUBAGENTS` defaults to `4` and bounds completed/failed/cancelled/timed-out subagents shown in the Chat Focus strip; active subagents and an older currently focused subagent remain visible. This does not delete durable records; use `/subagent-prune` for storage cleanup.

## Observability and Hermes sync

- Subagent lifecycle events are emitted to the existing trace runtime with `agent_branching`, `failure_state`, and `cancellation` categories.
- The trace extension exposes `/trace-subagents` for focused inspection.
- Diagnostics schema v2 uses `modelCalls`, `toolCalls`, `toolResults`, `toolFailures`, unmatched call/result ID arrays, `queueWaitMs`, `executionDurationMs`, and `totalDurationMs`; snake-case aliases remain readable during migration. `toolCalls` counts unique assistant `toolCall` IDs exactly once—tool results are correlated separately. `queueWaitMs` measures local RPC-concurrency delay; `executionDurationMs` measures the whole child interval, including startup, and `totalDurationMs` is exactly queue plus that child interval. New RPC records also split the child interval into `startupDurationMs` (through prompt acceptance) and `promptDurationMs` (acceptance through completion/failure). The execution deadline applies to the latter, so the whole child interval can exceed one phase's budget without timing out. Historical diagnostics are not rewritten. Child session provenance remains available even on timeout.
- Role-v2 RPC results succeed only through a valid terminating `submit_role_result`; injected deterministic runners may use untyped records only in tests.
- Every completed direct or topology-backed role appends a compact non-context schema-v4 `role-run` entry to the parent Pi session. `src/role-run-provenance.js` allowlists canonical terminal category, typed-result/accounting validity, runtime/contract/result/source versions and source hash, mutation mode, fixed eligibility reason, selected/effective/fallback model IDs, selected/effective thinking levels and their policy sources, timing, child-session provenance, workspace/patch hashes, changed-path hashes, and task/result hashes—never prompts, transcript/messages, diagnostics bodies, termination messages, provider payloads, or file bodies. Aggregate field reports require >=30 exact-cohort live read-only runs; fixtures and operator cancellations are counted exclusions while genuine failures/timeouts stay in the denominator.
- Subagent branch snapshots are metadata-only by default. This preserves durable branch provenance/results while avoiding multi-second synchronous repository reads/writes on every create/start/finish checkpoint; use the full-snapshot opt-in only when rollback/merge workflows need file payloads.
- Subagent settlement never invokes Hermes or writes project memory automatically. Explicit reviewed memory workflows remain separate.

## Guardrails

The service fixes recursion depth at one. Generic budgeted roles enforce active-record, queue-wait, model-call, tool-call, result-size and child wall-clock limits. Unbudgeted specialists retain startup health, cancellation, transport/output and host-protection limits, not inference/correction budgets. `maxSteps` is normalized to `maxModelCalls`. On a budget breach/cancellation it requests RPC abort, sends SIGTERM, then SIGKILL after the grace period. Parent cancellation works while queued or running, and late process events cannot overwrite the final result.

## Retention

Runtime Doctor inventories role records/results, RPC child sessions, retained workspaces, patches, and topology runs separately. Cleanup is dry-run and manifest-first. Explicit cleanup retains active and failed/timed-out/cancelled evidence, unapplied patch recovery state, and paths referenced by an open debug ledger. It never archives or deletes ordinary Pi sessions. Use `/doctor-cleanup-preview` before `/doctor-cleanup-apply`.

## Known limitations

The service records branch-backed trajectories and dispatches only through the tool-side RPC subprocess. RPC start concurrency uses a process-local FIFO queue and persists `queued` while waiting. Parent budget enforcement can detect a parallel tool batch only after starts already emitted by Pi, so diagnostics report bounded overshoot; the child sidecar independently blocks later calls. Token accounting depends on provider/session usage metadata, with estimated fallback usage for injected runners. Mutating roles are Git-only: non-Git mutation is refused until a separately tested copy sandbox exists. Detached worktrees write ordinary Git worktree/object metadata, but parent HEAD, index/status fingerprint, and source bytes remain unchanged until explicit patch application.
