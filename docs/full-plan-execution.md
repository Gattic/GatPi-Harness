# Completing finite, authorized plans

This is the execution contract for the existing roadmap and workflow skills, not a new planning system. The global instruction installation is tracked separately in [external application history and current reconciliation](full-plan-execution-external-changes.json).

## Canonical scope

Read the whole named plan before implementing. Resolve material ambiguity once: required outcomes, finite quantities, non-goals, dependencies, acceptance gates, and real authorization boundaries. “Implement in full” authorizes continuation through dependency-ready outcomes, not extra repositories, deletion, commits, publication, or deployment. A phase/batch passing is a progress update, not the endpoint of a larger authorized plan.

Use one canonical plan and one roadmap root with stable outcome IDs. Root items represent required deliverables; one goal layer is normally enough. Resume existing IDs after continuation or compaction. `start` with the same root title and unchanged inventory is idempotent; differing scope must use explicit item updates or authorized replacement. A shelved/closed root still needs `resume`; an active blocked root needs the actual blocker resolved. Never flatten or discard historical trees silently.

Ordinary inspect/change/build/test activity belongs in outcome notes and linked evidence. A separately tracked helper uses `add_subtask` with an explicit parent when needed. Close it after reporting, then resume the unfinished parent. Helper success does not complete that parent. Recursively completed workflow items are not a product completion percentage: report **required outcomes complete/total**, blocked outcomes, and workflow counts separately. Skipped required outcomes remain incomplete unless an explicit scope decision removes them from the contract.

## Short current-state section for the canonical plan

```markdown
## Current state
Canonical plan: <path / title> | Roadmap root: <ID>
Authorized scope: <required result, finite quantities>
Non-goals / permissions not granted: <boundaries>

| Outcome ID | Required result and exit gate IDs | Dependencies | Implementation | Evidence |
|---|---|---|---|---|
| O1 | <observable result; G1> | none | pending/in progress/implemented | pass/fail/unrun + reference |
| O2 | <observable result; G2,G3> | O1 | ... | ... |

| Gate ID | Exact repository command or observation | Outcomes covered | Required boundary |
|---|---|---|---|
| G1 | <focused verifier> | O1 | before dependent work |
| G2 | <integration/release gate> | O2 | before acceptance |
| G3 | <human/hardware/time-dependent observation> | O2 | acceptance, not code completion |

Blockers: <issue -> outcome IDs; evidence; missing decision/dependency>
Next dependency-ready action: <existing outcome ID + concrete action>
Resource/evidence budget: <RAM/disk/job limits, estimated full-delivery growth>
Artifact lifecycle: <owned paths; age/count/size retention; authorized cleanup; failures/history retained>
Scope changes: <date, explicit user decision, affected IDs; otherwise none>
```

Do not list indefinite “polish,” “content expansion,” or field observation as if it had a finite software exit criterion. Establish quantities and acceptance conditions. Keep implementation and observed acceptance separate. Historical qualification logs and experiments are references, not competing active plans.

## Finite checks and detours

- Map required gates to outcomes before running. Keep stricter repository gates; broaden for a demonstrated new regression or risk. Optional review suggestions are not silent additions to the contract.
- Reviews classify **acceptance blockers**, **required regressions**, and **optional improvements**, with requirement/gate IDs and evidence. Reopen settled work only for new relevant evidence or an explicit request.
- For each detour record: **issue; affected requirement; dependency evidence; bounded next diagnostic; parent return point**. Park it if it does not block the next authorized deliverable. Do not retry a settled failed attempt without a changed hypothesis/input.
- A verification-only helper reports failures without repairs. Its parent implementation workflow retains existing repair authority. Continue independent authorized work, preserving failures and withholding any broad acceptance claim they invalidate.
- Run the narrowest credible checks, then required broader gates and one final diff review. Reuse still-current evidence; rerun only what subsequent changes invalidate. No weakened assertions, suppressed warnings, automatic retries, or changed thresholds to manufacture a pass.
- If commits are requested, identify dependency-complete groups before staging. Include authorized prerequisites/callers/tests; obtain missing scope permission rather than constructing a knowingly broken fix-only commit. Materially different isolated candidates require their own checks. A checkpoint returns to the parent plan and never implies publish permission.

## Resources and stopping

Before storage-heavy work, check capacity and estimate the complete delivery's fixtures, logs, failures, and final checks. Define ownership, bounded age/count/size retention across runs, and permitted disposal of successful-test fixtures. Preserve historical evidence, authored assets, saves, and unique/uncommitted work. If the budget is insufficient, request an explicit decision; do not delete history, raise caps, or weaken RAM admission.

Stop early only for a concrete authorization/decision boundary, unavailable dependency or required observation, exhausted resource/execution limit, unresolved failure blocking all remaining authorized progress, or explicit user pause. Report the exact reason, affected outcomes, independent work completed, and next resumable action. Do not promise automatic continuation without a registered job/monitor.

At closeout reconcile **all** outcomes as implemented, verified, blocked, or unrun. Required deferred work remains incomplete. A fully passing increment, commit, or helper is not full-plan completion.

## Lightweight follow-up: next three real large-plan executions

No synthetic sessions, historical relabeling, efficacy claim, or new experiment framework. Record these observations only after actual executions; preserve links to their canonical plans and closeouts. Unobserved results must not be counted as completed observations.

For each real execution record its canonical plan, session and dates, then assess:

- Continuation past ordinary phase boundaries without another “implement the rest” prompt.
- A stable required-outcome denominator except explicit scope changes.
- Shallow tracking and helper return to the parent.
- Real early-stop reasons mapped to affected outcomes.
- Separation of nonblocking discoveries from acceptance gates.
- Final reporting against the entire plan rather than the latest helper.

Current evidence: [2026-10-17 follow-up](full-plan-execution-followup-2026-10-17.md). Three real execution-window reviews are recorded, including negative observations and explicit evidence limits. This completes the lightweight follow-up, not independent certification of those implementations. Exact runtime/skill exposure across the other sessions is not established, so no causal efficacy claim follows.

A negative observation is information, not permission to force endless execution, delete evidence, repeat failures until green, weaken gates, or automatically publish.
