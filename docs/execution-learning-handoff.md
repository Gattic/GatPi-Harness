# Settled execution to learning handoff

Status: Phase 3 settled producers and idempotent learning/skill consumers implemented; field rollout gates remain unchanged.

## Operator taxonomy

The harness uses four distinct loop concepts:

- `/loop` is bounded same-prompt execution. The user-authored task remains canonical and each iteration continues from repository and session state.
- `/goal` is adaptive control. A controller chooses a bounded next action from observations and the goal owns its terminal transition.
- Experiment loops are preregistered evaluations. Their hypotheses, arms, bars, costs, and PASS/FAIL/NULL results belong in Experiment Ledger before rollout decisions.
- `learning_loop` and `skill_synthesis` are capability-learning systems. They consume reviewed public outcomes and evidence; they are not hidden execution controllers.

These systems do not exchange prompts, assistant text, private reasoning, transcripts, command arguments, or raw tool output.

## Canonical packet

`src/execution-outcome.js` defines schema-v1 settled execution packets and `ExecutionOutcomeStore`. Extensions access them only through `ExecutionOutcomeAdapter` from `src/integration-boundary.js`.

```text
.pi/execution-outcomes/
  packets/<packet-id>.json  # private atomic packet
  index.jsonl               # idempotent metadata-only index
  dispatch/<consumer>.jsonl # private metadata-only delivery receipts
```

A packet stores stable source and task hashes, canonical outcome status, bounded workflow/tool names, evidence and artifact references, metrics, producer identity, explicit false privacy assertions, and settlement time. Packet identity is derived from source kind, run ID, source-record hash, and terminal state.

Validation fails closed on:

- forbidden prompt/output/transcript/reasoning/command fields;
- secret-like values and absolute paths;
- unknown packet fields;
- unsafe IDs, tool names, or reason codes;
- invalid hashes or timestamps;
- oversized text, collections, or nesting;
- privacy assertions that claim prohibited content was stored.

The packet store is idempotent. Replaying the same source settlement produces one packet and one index row. Consumer receipts make repeated session-start, `agent_end`, and `agent_settled` drains idempotent as well.

## Canonical outcomes

All producers and consumers reuse `src/outcome-schema.js`:

```text
succeeded
domain-negative
blocked
not-applicable
cancelled
timed-out
infrastructure-failed
unknown
```

Loop and goal terminal-state helpers map their local vocabularies into this set. Domain-negative results remain distinct from infrastructure failures.

## Handoff and authority boundaries

The producer that owns the terminal transition writes the packet. The automation-loop extension emits after its saved `agent_settled` terminal/pause transition. `GoalRunner.onFinalized` runs only after the terminal goal state is saved. Empty cancellations, untouched blocked goals, and pauses without evidence are ignored; provider failures and evidence-bearing instructive states remain observable.

The learning coordinator drains at session start and `agent_end`; the reasoning runtime drains for skills at session start and `agent_settled`. A consumer may lag one event, but correctness does not depend on extension registration order. A packet may support:

1. one public learning outcome;
2. one allowlisted procedural execution capture;
3. a project-memory candidate reference only when rollout policy permits candidate capture.

It cannot synthesize or approve a skill, authorize routing or publishing, save canonical memory, or raise project-memory rollout. Project-memory promotion remains a separate reviewed operation with current evidence.

For a pre-registered compounding experiment, a packet may additionally carry only an evidence class, cohort ID, `control|candidate|unassigned` arm, independent session hash, and measured context-added count. These values never contain a task/session body and do not infer cohort membership. Invalid packet attempts append only a controlled rejection reason code; rejected input is never persisted. See [Compounding effectiveness scorecard](compounding-effectiveness-scorecard.md).

## Rollback

Packet capture, learning ingestion, and skill ingestion have independent default-on rollback flags:

```text
PI_EXECUTION_OUTCOME_CAPTURE=0
PI_EXECUTION_OUTCOME_LEARNING=0
PI_EXECUTION_OUTCOME_SKILLS=0
```

Disabling producers or consumers leaves private packet files untouched for inspection. Goal settlement uses only privacy-safe execution packets; there is no raw Hermes goal-summary sync or aggregate goal-state compatibility path.

## Verification

```bash
node tests/execution-outcome.test.js
node tests/outcome-schema.test.js
node tests/integration-boundary.test.js
node tests/settled-execution-handoff.test.js
node tests/learning-loop.test.js
node tests/skill-synthesis.test.js
```
