# Change verification contract

Provenance: adapted from the pi-harness `change-verify` skill
(`skills/change-verify/SKILL.md` at commit `5f25692`), archived during the Skill
Foundry migration and restored as a local addition. The workflow below is otherwise
unchanged; only its frontmatter was dropped to fit the bundle standard.

Prove what the current change does and does not establish.

## Boundary

This skill verifies an existing change. It does not implement fixes, design a new test strategy, troubleshoot build infrastructure, stage files, commit, push, or publish. If a check fails, this verification-only helper reports it and returns control without repairing it. When invoked inside an already-authorized implementation plan, the parent retains authority for in-scope repairs and independent work; do not request that implementation permission again or redefine the parent as verification-only.

## Hard rules

- Inspect the working-tree and staged diff before selecting checks.
- Distinguish task-owned changes from pre-existing or unrelated changes.
- Derive commands from repository instructions, manifests, CI, or verifier profiles; never invent a likely command.
- Run the cheapest relevant check first, then broaden according to risk.
- Record the verifier, affected required-outcome IDs, scope, outcome, and meaningful failure summary. Separate implementation status from acceptance evidence; an unrun observation is not an implementation failure or a pass.
- Establish finite required gates before running; classify new findings as acceptance blockers, required regressions, or optional improvements. Do not silently promote optional suggestions to mandatory gates.
- Budget fixtures, logs, failures, and final checks before expensive runs; establish ownership and authorized retention/cleanup. Respect existing caps and preserve historical evidence.
- A partial pass is not an overall pass. Use `passed`, `failed`, and `not run` explicitly.
- Do not bypass hooks, disable checks, weaken assertions, or silently update snapshots.
- Do not repeatedly rerun an unexplained failure.
- Before saying “verified,” “ready to commit,” or “ready to publish,” collect final Git-aware verification evidence.

## Workflow

### 1. Define the change set

Prefer `gitevidence` for branch, upstream, dirty state, and diff statistics. Inspect the actual changed paths and relevant diff hunks. Record:

- source, tests, docs, config, generated, or dependency changes;
- public API, schema, build, security, concurrency, or persistence boundaries;
- files that appear unrelated to the task.

If task ownership is ambiguous, verify only the identified scope and state the limitation.

### 2. Select checks

Prefer dependency-aware and repository-native selection:

1. `codegraph_affected` for likely affected tests;
2. `test_gap_planner` when changed behavior lacks clear coverage;
3. `test_runner infer` for repository-defined focused commands;
4. `lsp diagnostics` or the repository typechecker for compiler-sensitive changes;
5. manifest/CI commands as a fallback.

Treat stale or degraded graph/LSP results as advisory. Conservative uncertainty means broader verification, not fewer tests.

### 3. Apply the risk ladder

| Change class | Minimum credible checks |
|---|---|
| Docs/examples only | source/example validation plus diff review |
| Local implementation with direct tests | diagnostics where relevant plus targeted tests |
| Cross-module or public API | targeted tests, affected integration tests, build/typecheck |
| Build/config/dependency | configure/build plus representative tests |
| Security/auth/input boundary | targeted tests plus focused Semgrep/static analysis |
| Concurrency/persistence/schema | targeted tests plus broader regression/integration gate |
| Broad refactor or uncertain impact | targeted checks, build, then repository full/changed profile |

Repository instructions override this table when stricter.

### 4. Run targeted checks

Use `test_runner run`, `test_project`, or the repository's focused command. Use `build_project` for project builds rather than reconstructing build invocations in shell.

On failure:

1. capture the first actionable failure;
2. classify whether it is in scope, pre-existing, environmental, or unknown;
3. do not rerun unchanged merely hoping it passes;
4. report the failed gate, affected outcomes, dependency evidence, bounded next diagnostic if needed, parent return point, and checks not reached; identify independent work it does not block.

### 5. Run broader gates

If targeted checks pass, run the broader checks required by the risk ladder and repository policy. Prefer `verification_center` when it has an applicable profile. Do not launch a costly full suite for a low-risk change unless instructions or uncertainty require it.

For long checks, follow the managed background workflow from `long-run`; do not build a `sleep`/`tail` polling loop.

### 6. Inspect final state

Run `gitverify` before a readiness claim. Re-read the changed-file list after verification so generated or formatter changes are not missed. Confirm:

- intended files only;
- no conflict markers or accidental artifacts;
- tests/build correspond to the final file state;
- unrun checks and residual risk are explicit.

## Tool failure fallback

- If test inference is unavailable, use commands cited by repository docs, CI, or manifests.
- If affected-test graph data is unavailable, use lexical import/caller evidence and choose conservatively.
- If output is truncated, consume the tool's spill file or request a bounded rerun only when safe.
- If a verifier times out, inspect the existing process before deciding whether the result is failed or incomplete.

Never convert unavailable evidence into a pass.

## Output contract

```markdown
## Verification Result: PASS | FAIL | PARTIAL

Change scope: ...
Risk class: ...

| Gate | Scope/command | Result | Evidence |
|---|---|---|---|
| targeted tests | ... | pass/fail/not run | ... |
| build/typecheck | ... | ... | ... |
| broader/static | ... | ... | ... |
| final Git check | `gitverify` or fallback | ... | ... |

Unrelated/pre-existing changes: ...
Not run: ...
Residual risk: ...
Parent return point / next dependency-ready action: ...
```

Only `PASS` supports a verified/readiness claim.

## Anti-patterns

- Running the full suite before a cheap targeted check
- Choosing only tests that are convenient rather than affected
- Claiming success from a build without behavior checks
- Treating stale graph output as authoritative
- Repairing code while supposedly performing independent verification
- Omitting failed or skipped commands from the final report
