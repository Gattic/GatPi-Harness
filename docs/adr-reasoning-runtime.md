# ADR: Model-side reasoning runtime

Status: accepted

## Context

The harness previously accumulated role-orchestration language that made it look like Pi was implementing reasoning internally. That conflicted with the desired architecture:

```text
model = reasoning engine
harness = cognitive runtime
```

## Decision

`src/reasoning-runtime.js` is the canonical runtime scaffold. It stores public artifacts produced for/by reasoning models:

- plans and task decompositions
- hypotheses and decision records
- executor actions
- verifier evidence and verifier feedback
- reflection checkpoints
- branch comparisons
- failure analyses
- memory updates

`src/cognitive-architecture.js` remains compatibility-only for older imports. It must not reintroduce hard-coded planner/executor/verifier cognition.

## Constraints

- Do not expose private model reasoning or scratchpads.
- Do not depend on hidden reasoning text.
- Do not treat verbose reflection or confidence as proof.
- Verification requires evidence artifacts.
- Hermes durable memory stores summaries/decisions only, never full transcripts or secrets.
- Pi extensions consume cognitive libraries through `src/integration-boundary.js`.

## Compatibility

The active project-local extension still lives at the legacy path:

```text
.pi/extensions/reasoning-runtime/index.ts
```

The TUI status and commands expose `reasoning-runtime`. Legacy `/cognitive-*` commands remain aliases for compatibility. A second project-local `.pi/extensions/reasoning-runtime/index.ts` should not be added until the legacy extension is removed or converted to a non-autoloading shim.

## Consequences

- Runtime scaffolding is explicit and inspectable.
- Model-side reasoning remains private to the model unless summarized as public artifacts.
- Verifier failures create evidence/feedback/failure-analysis artifacts.
- Stale role-orchestration context is pruned on startup and by `/reasoning-clear-stale`.
