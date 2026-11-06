# Ralph-style automation loop

Date: 2026-07-11
Updated: 2026-07-26
Status: implemented, retry-safe, bounded by default

## Purpose

`/loop` repeatedly gives Pi the same task after each fully settled agent run. Work persists in files, git history, ledgers, test output, and the current Pi session, so each iteration can improve on the previous one.

```text
/loop task
  -> iteration 1 works
  -> agent_settled runs only after provider retries/compaction/queued work settle
  -> inspect promise, progress, errors, and stalls
  -> await bg_run/run_deck work started by iteration 1, if any
  -> queue a token-bound copy of the same task as iteration 2
  -> validate the token when Pi delivers it; drop it if stale
  -> repeat until completed, paused, cancelled, stalled, or budget exhausted
```

This is the Pi equivalent of the Ralph Wiggum technique, with additional safety learned from the long Claude research loops.

## When to use it

Good fits:

- getting a focused test suite green;
- iterative implementation against explicit acceptance criteria;
- bounded cleanup/refactoring passes;
- repeated benchmark/probe/fix cycles;
- research programs with pre-registered PASS/FAIL/NULL gates.

Poor fits:

- unclear requirements or subjective design decisions;
- production incidents requiring human judgment;
- tasks needing credentials or destructive/resource authorization;
- a single long-running job with no iterative work around it, which should instead use `run_deck` plus `run_monitor` when periodic notification is requested;
- experimentation without pre-registered bars, which should use `experiment_ledger` first.

## Commands

```text
/loop <prompt> [options]
/ralph-loop <prompt> [options]          alias
/loop-status
/loop-list
/loop-log [count]
/loop-pause [reason]
/loop-resume                             resume paused/interrupted session loop
/loop-stop [reason]
/cancel-ralph [reason]                  alias
/loop-help
```

Options:

```text
--max=N | --max-iterations=N            default 20, maximum 500
--promise=TEXT | --completion-promise=TEXT | --until=TEXT
--max-stalls=N                          default 3; 0 disables identical-output stall pause
--prompt-file=PATH | --file=PATH        repository-confined prompt file
--                                       treat remaining --words as prompt text
```

Examples:

```text
/loop "Fix the parser regression. Run focused tests after each change." --max=10 --promise=FIXED
/loop --prompt-file=TASK.md --max=20 --max-stalls=3
/loop "Complete every unchecked item in docs/plan.md; verify each item" --max=30
```

With a completion promise, Pi stops only when the final assistant text ends with the exact normalized tag:

```xml
<promise>FIXED</promise>
```

Without a promise, the model must call `automation_loop operation=complete` and provide at least one concrete evidence reference.

## Model tool

Tool: `automation_loop`

Operations:

- `start` — start a loop when the current user input explicitly requests a Ralph/automation loop, autonomous repeated iteration, or work-until-complete behavior; model-tool starts are rejected otherwise (`/loop` remains an explicit human command);
- `status` — inspect current/recent loop state and the required completion action;
- `checkpoint` — record a `pass`, `fail`, `null`, `partial`, or informational result with evidence;
- `pause` — stop iteration before an unmanaged/external wait, missing credential, resource decision, or strategic user choice;
- `complete` — evidence-backed completion when no exact promise is configured.

Missing current-user intent, a missing prompt, promise-mode tool completion, and completion without objective evidence return successful tool transport with canonical `outcome: "blocked"` plus a fixed reason code and corrective guidance. Status/checkpoint/pause/complete calls with no current loop return `outcome: "not-applicable"`. These valid workflow-domain outcomes are not tool/runtime failures; promise-mode completion still requires the exact final-response tag.

Only human commands resume or cancel paused loops. This prevents the model from silently overriding a user/resource pause.

## Iteration contract

Every repeated prompt tells the model to:

1. Continue from current files, git history, ledgers, and evidence rather than restarting.
2. Choose one smallest unmet criterion or highest-value bottleneck.
3. Treat failed/null results as evidence and avoid repeating settled dead ends.
4. Verify material changes.
5. Checkpoint important PASS/FAIL/NULL/PARTIAL results.
6. Let the harness await `bg_run`/`run_deck` work started in the iteration; pause before unmanaged external waits or when human/resource authorization is needed.
7. Complete only when the promise is genuinely true or objective evidence is supplied.

This contract comes directly from the successful Claude research-loop pattern: cheap Gate-0 probes before implementation, one targeted change per iteration, explicit negative-result publication, cumulative verified wins, and autonomous closure when further work requires strategic or GPU-time authorization.

## Safety boundaries

- Default budget is 20 iterations; unlimited mode is disabled.
- Set `PI_AUTOMATION_LOOP_ALLOW_UNBOUNDED=1` to allow `--max=0` intentionally.
- Repeated identical assistant output with no workspace fingerprint change pauses after three iterations by default.
- Iterations settle on Pi's `agent_settled` lifecycle boundary, never low-level `agent_end` retry failures. A terminal provider `error`/`aborted` result pauses without consuming an iteration.
- Prompt files must be inside the repository, and symlinks resolving outside are rejected.
- Prompt/state files are capped by `PI_AUTOMATION_LOOP_MAX_PROMPT_CHARS` (default 100,000).
- Policy Enforcer and normal tool policies remain active on every iteration.
- Max-budget or automatic-stall termination sets a nonzero exit code in headless print mode.
- Loop state is isolated by Pi session ID, so another session in the same repository cannot continue or stop it accidentally.
- `/loop` and the Hermes-controlled `/goal` are mutually exclusive in one Pi session; each start command rejects the other runner's open state.
- A next iteration is not queued while `bg_run` or `run_deck` work started during the settling iteration remains active. Pre-existing unrelated repository jobs are excluded by a per-iteration baseline.
- Every automatic continuation carries loop ID, expected iteration, prompt hash, and an opaque token. An `input` gate drops delivery if the loop is inactive, belongs to another session, has advanced, or no longer owns that token. Legacy command/resume prompts are accepted only for the current active iteration.
- A deck launch and its underlying background job are treated as one dependency. Attached decks without PID evidence remain active until explicitly finished.
- `/loop-resume` cannot bypass an automatic managed-background wait; `/loop-stop` cancels the loop while it waits. A persisted wait is reattached when the Pi session starts again.
- The loop does not auto-commit, auto-push, grant policy permissions, authorize expensive runs, or store summaries in Hermes.

A prompt may contain sensitive task context because it must be replayed exactly. State is therefore local, mode `0600`, ignored by git, and must not be exported casually. Lifecycle telemetry is written separately to `.pi/automation-loop/telemetry.jsonl` with file mode `0600` in a mode-`0700` directory. Its allowlist contains only timestamps, fixed event/operation/outcome/reason/status codes, loop ID, source, eligibility, iteration, verdict, and completion mode—never prompts, summaries, evidence, raw output, commands, or paths.

## Progress and stall detection

At each `agent_settled`, the extension records only compact iteration metadata and queues the next prompt with `deliverAs: "followUp"`:

- assistant-output hash, never assistant text;
- fixed assistant stop reason and `agent_settled` boundary;
- git workspace fingerprint, never raw status paths;
- tool call/error counts and tool names;
- completion/stall decision;
- continuation queued/delivered/dropped timestamps, iteration, token hash, and fixed reason (never prompt text or the raw token);
- explicit checkpoint summaries/evidence, redacted and bounded.

Pi emits `agent_settled` once after automatic retries, auto-compaction retries, and already queued continuations finish. A final provider failure pauses the loop without adding history or decrementing its useful budget. Before queueing, the extension compares repository-local `bg_run`/`run_deck` liveness with the iteration-start baseline. If new managed work is active, the lifecycle handler polls that specific dependency set; the follow-up is queued only after all of it settles. Delivery validation stays synchronous; `agent_start` refreshes branch, workspace, and managed-work baselines so delayed work is attributed to the iteration that actually ran. Command and continuation senders keep their handler alive only until Pi reports the nested agent run started, preventing non-interactive teardown without a detached stale-context message timer.

## State

```text
.pi/automation-loop/loops/<loop-id>.json
```

Schema v3 fields include session ID, prompt, status, iteration/max budget, completion promise, stall counter, checkpoints, bounded iteration history, fixed lifecycle events, pending/last continuation telemetry, the iteration-start managed-work baseline, and any active/last background wait. Only token hashes, job/run identifiers, fixed reasons, and timestamps are exposed in summaries—never raw continuation tokens, commands, or logs. Schema-v2 state remains readable and is upgraded on its next write.

Statuses:

```text
active, paused, completed, cancelled, max_iterations, failed
```

## Environment

```text
PI_AUTOMATION_LOOP=0                     disable extension
PI_AUTOMATION_LOOP_MAX_ITERATIONS=20     default iteration budget
PI_AUTOMATION_LOOP_MAX_STALLS=3          default repeated-output stall budget
PI_AUTOMATION_LOOP_MAX_PROMPT_CHARS=100000
PI_AUTOMATION_LOOP_BACKGROUND_POLL_MS=2000
PI_AUTOMATION_LOOP_ALLOW_UNBOUNDED=1     allow --max=0
PI_EXECUTION_OUTCOME_CAPTURE=0            disable privacy-safe terminal packet emission
```

## Difference from `/goal`

- `/loop` is Ralph-style: the same user-authored task repeats, and progress lives in the workspace/session.
- `/goal` is controller-style: Hermes evaluates observations and chooses a new next prompt each iteration.

Use `/loop` when the acceptance criteria and iteration discipline are already in the prompt. Use `/goal` when the harness should dynamically plan the next action.

Experiment loops are separate preregistered evaluations, while `learning_loop` and `skill_synthesis` learn capabilities from reviewed outcomes. The shared privacy-safe settlement contract is documented in [Settled execution to learning handoff](execution-learning-handoff.md). The owning `agent_settled` handler now emits an idempotent metadata-only packet after a saved completion, max-iteration stop, provider failure, or evidence-bearing instructive pause; it never copies the repeated loop prompt or assistant text.

## Verification

```bash
node tests/automation-loop.test.js
node tests/automation-loop-lifecycle.test.js
node tests/automation-loop-background.test.js
node tests/automation-loop-extension.test.js
pi -p --no-extensions -e .pi/extensions/automation-loop/index.ts '/loop-status'
```
