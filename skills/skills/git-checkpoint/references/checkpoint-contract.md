# Git checkpoint contract

Provenance: adapted from the pi-harness `git-checkpoint` skill
(`skills/git-checkpoint/SKILL.md` at commit `5f25692`), archived during the Skill
Foundry migration and restored as a local addition. The workflow below is otherwise
unchanged; only its frontmatter was dropped to fit the bundle standard.

Turn already-completed work into reviewable local commits without absorbing unrelated changes.

## Boundary

This skill performs local Git checkpointing only. It does not implement changes, merge worktrees, write handoffs, amend/rebase history, push, publish, or create a release. Use it only after explicit user authorization to commit or checkpoint.

## Hard rules

- Never branch, stage, or commit without an explicit user request.
- Collect Git evidence before mutation: branch/upstream, HEAD, dirty state, staged state, and diff summary.
- Separate task-owned changes from pre-existing or unrelated changes.
- Never stage everything with `git add .`, `git add -A`, or an equivalent blanket operation.
- Stage only explicit files or reviewed hunks.
- Let commit hooks run. Never bypass a failed hook.
- Do not discard, restore, reset, clean, amend, rebase, force, push, or publish unless separately and explicitly requested.
- A commit is not proof of correctness. Require current verification evidence or clearly report that verification is missing.
- Review the staged diff before each commit and verify repository state afterward.

## Workflow

### 1. Establish evidence and authorization

Prefer `gitevidence` for read-only branch/upstream, SHA, dirty state, and verifier hints. Confirm the user's request covers local commits.

Stop and ask or report if:

- there are unmerged paths;
- task ownership of changed files is unclear;
- a destructive history operation appears necessary;
- the request is only to review or verify, not commit.

### 2. Check verification currency

Use the `change-verify` workflow or inspect existing proof from the final file state. Verification is current only when:

- it ran after the relevant edits;
- it covers the risk of the changed files;
- no later formatter/generator/manual edit invalidated it;
- failed or skipped gates are disclosed and mapped to the outcomes they block.

Reuse current evidence for the identical tested tree. Check isolated candidates when the staged candidate differs materially from that tree; do not claim isolation from working-tree evidence alone. Budget candidate fixtures and logs with explicit ownership and authorized cleanup before running them; never delete historical results or relax caps to force a checkpoint.

If verification is absent or stale, do not describe the commit as verified. Run verification only if the user's request and available time allow it; otherwise report the gap.

### 3. Plan logical commits

Prefer `commit_plan operation=plan`. Group files by one coherent intent, usually:

- source plus its tests;
- schema/config plus required consumers;
- docs/examples tied to the same behavior;
- independent scripts or maintenance as separate commits.

Plan dependency-complete checkpoints before staging: include required uncommitted prerequisites, corresponding callers, migrations, and tests within the authorized file ownership. If a requested fix-only commit cannot build without those prerequisites, explain the dependency and obtain any missing scope authorization before staging; do not rediscover it through repeated isolated failures. Do not split a change so an intermediate commit is knowingly broken. Do not combine unrelated cleanup with a behavior fix.

A commit helper is not the canonical implementation plan. Keep the parent outcome ID and return point; after the checkpoint, resume remaining authorized implementation rather than declaring the entire plan finished.

Refine every starter message to describe the actual change. Use repository commit conventions when evident.

### 4. Review each group

Before applying a group:

1. confirm the exact file list;
2. inspect relevant unstaged and staged hunks;
3. ensure no secrets, generated noise, debug artifacts, or unrelated files are included;
4. confirm source and corresponding tests stay together;
5. state the final commit message.

Use `commit_plan operation=apply` with the exact files and refined message.

Fallback when `commit_plan` is unavailable:

1. stage explicit paths or reviewed hunks;
2. inspect `git diff --cached --stat` and the staged diff;
3. commit with the reviewed message;
4. repeat only for the next planned group.

### 5. Verify the result

After every commit:

- confirm the commit exists and capture its short SHA and subject;
- inspect remaining staged/unstaged changes;
- ensure unrelated changes remain untouched;
- ensure hooks did not modify additional files unexpectedly.

After the final commit, prefer `gitevidence` and `gitverify` before a readiness claim. Do not push; publishing is a separate user-confirmed action.

## Tool failure fallback

- `commit_plan` rejects a file set: re-run the plan from current state and correct exact paths; do not blanket-stage.
- Commit hook fails: preserve its output, leave state inspectable, and stop. Do not use `--no-verify`.
- Commit succeeds but hooks modify files: inspect and verify those files before deciding on another commit.
- Output is ambiguous: use read-only Git evidence to confirm HEAD and status before retrying.

Never repeat a mutating Git command when its outcome is unknown.

## Output contract

```markdown
## Git Checkpoint
Authorization: explicit local commit request
Verification: current pass | partial | missing

| Commit | Message | Files | Verification |
|---|---|---|---|
| `<sha>` | ... | ... | ... |

Parent plan / remaining required outcomes / return point: ...
Remaining changes: ...
Unrelated changes preserved: ...
Hooks: pass/fail/not observed
Push/publish: not performed
```

## Anti-patterns

- Committing because work appears complete without being asked
- Using blanket staging in a dirty tree
- Mixing unrelated changes into one commit
- Splitting source from the test that makes it valid
- Claiming “ready” from commit success alone
- Bypassing hooks or rewriting history to make checkpointing easier
- Pushing as an implicit final step
