# Durable bug hunt contract

Provenance: adapted from the pi-harness `durable-bug-hunt` skill
(`skills/durable-bug-hunt/SKILL.md` at commit `5f25692`), archived during the Skill
Foundry migration and restored as a local addition. The workflow below is otherwise
unchanged; only its frontmatter was dropped to fit the bundle standard.

Find the mechanism of failure, apply the smallest causal fix, and preserve enough evidence that later sessions do not repeat failed attempts.

## Boundary

Use this skill for an observed defect. Do not use it for feature implementation, broad audits, routine verification, or performance work without a correctness symptom.

Normal mode handles a new reproducible defect. Deep mode applies when the defect is intermittent, confidence is low, the symptom resurfaced, or prior fixes failed.

## Hard rules

- Open or inspect the matching `debug_ledger` thread before changing anything.
- Check `fix_recall` for related failures and record useful retrieval attribution on new attempts.
- Never retry a change already recorded with `no-change`, `worse`, or an unresolved equivalent observation.
- Reproduce or narrow before repair. Mark non-reproduction honestly.
- Separate facts, hypotheses, experiments, and conclusions.
- Change one causal variable per attempt.
- Use `safe_try` before risky or broad attempts; revert if the observation is worse.
- Do not mask defects with retries, sleeps, broad guards, swallowed errors, or compatibility fallbacks.
- Resolve the ledger only after targeted regression evidence confirms the fix.

## Workflow

### 1. Establish the bug contract

Record:

- observed and expected behavior;
- exact failure signature;
- frequency and affected environment;
- smallest known reproduction;
- prior attempts and their observations;
- available logs, traces, screenshots, dumps, or verifier output.

If fresh evidence was captured externally, use `evidence_inbox` and attach its path to the ledger attempt.

### 2. Map the failure path

Use repository-aware context first, then exact source:

1. Locate the failing boundary, callers, invariants, and relevant tests.
2. Check recent changes near the failure surface.
3. Classify likely failure families: logic, state/lifecycle, ownership, concurrency, configuration/environment, dependency/tooling, or measurement.
4. In C++ crash cases, use the repository build/test tools so native crashes capture a backtrace; use sanitizers, GDB, or bisection only when evidence calls for them.

### 3. Generate and disprove hypotheses

Normal mode may begin with one high-signal hypothesis. Deep mode requires at least three materially different hypotheses.

For each hypothesis record:

- causal claim;
- supporting and conflicting evidence;
- a falsification test;
- confidence;
- result after the test.

Prefer cheap discriminating checks. If evidence rejects the hypothesis, record the attempt before moving on.

### 4. Gate the fix

Implement only when:

- one mechanism explains the observed symptom better than alternatives;
- the violated invariant and violation point are identified;
- the proposed change directly removes that mechanism;
- a regression check can prove the relevant behavior.

If these conditions are not met, continue investigation or report the unresolved evidence gap. Do not patch speculatively.

### 5. Apply one bounded attempt

1. Create a `safe_try` checkpoint when the change is risky.
2. Apply the smallest root-cause fix.
3. Run the narrow reproduction or targeted test.
4. Record the exact observation and verdict in `debug_ledger`.
5. Revert on `worse`; do not stack another guess on top.

### 6. Verify and resolve

Run targeted verification first, then the smallest broader regression surface justified by the changed dependency path. Inspect the final diff for defensive masking or unrelated cleanup.

Resolve the thread only when evidence shows:

- original reproduction now passes;
- regression protection exists or the relevant invariant is enforced;
- broader checks did not regress;
- residual uncertainty is stated.

## Tool failure fallback

If durable ledger tools are unavailable, keep an explicit attempt table in the session or repository-approved handoff artifact with hypothesis, change, observation, verdict, and evidence. If indexed context or managed verifiers are unavailable, use focused repository search and canonical test commands. Never treat missing tooling as confirmation of a hypothesis.

## Output contract

```text
Bug: <title>
Mode: normal | deep
Ledger: <thread id>
Reproduction: confirmed | intermittent | unavailable
Root cause: <causal chain or unresolved>
Attempt: <change and verdict>
Evidence: <tests/logs/traces>
Verification: PASS | FAIL | PARTIAL
Residual uncertainty: <none or exact gap>
```

## Anti-patterns

- Repeating an attempt because the previous session forgot it
- Treating a provider/tool failure as evidence about the product defect
- Fixing the crashing line instead of the earlier corruption or invariant violation
- Claiming root cause from one lucky passing run
- Broad refactoring during a bug hunt
- Resolving the ledger without current verification evidence
