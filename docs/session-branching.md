# Session branching and trajectory management

`src/session-branches.js` implements cognitive trajectory management for Pi sessions. It is not a git wrapper: each branch stores a complete cognitive checkpoint plus a filesystem checkpoint so unstable reasoning, risky tool use, verifier runs, and multi-agent work can be isolated and rolled back.

## Architecture

- **SessionBranchManager**: high-level API for branch creation, checkpoints, rollback, merge, scoring, quarantine, replay, pruning, agent leases, and visualization.
- **SnapshotStore**: local persistence under `.pi/session-branches/` with JSON snapshots, branch metadata, lineage, checkpoints, and append-only event history.
- **Snapshot model**: persists `memoryState`, `contextState`, `toolState`, `filesystemState`, and `verifierState`.
- **MergeEngine**: three-way semantic merge over filesystem and cognitive state; detects concurrent conflicts and runs invariants before accepting merged work.
- **BranchScorer**: evaluates verifier success, entropy/stability, architectural consistency, token efficiency, and benchmark impact.
- **ExplorationPolicyEngine**: automatically isolates high-entropy, risky, verification, speculative, and multi-agent work; prunes low-value branches.
- **BranchVisualizer**: renders branch trees, divergence summaries, merge history, and rollback navigation.

## Branch types

- `experimental`: unstable exploration or high-entropy work.
- `verification`: isolated verifier/proof generation.
- `rollback`: risky operations that need immediate restoration points.
- `speculative`: parallel candidate solutions.
- `multi-agent`: isolated workspaces for independent agents.

## Persistence layout

```text
.pi/session-branches/
  branches/<branch-id>.json
  snapshots/<snapshot-id>/snapshot.json
  events.jsonl
```

Snapshots include text file contents and base64-encoded binary contents for bounded local files, plus cognitive states supplied by the caller.

## Merge and invariants

Merges use a common base snapshot. Non-overlapping edits are accepted, identical edits coalesce, and concurrent incompatible file edits become explicit conflicts. Cognitive state is merged structurally: arrays are unioned, unchanged sides are fast-forwarded, and nested objects are recursively merged. Custom invariants can reject a merge before it is applied.

## Pi commands

Manual Pi commands are available for guarded branch operations:

- `/branch-list` lists branches.
- `/branch-show <branch-id>` shows branch metadata and checkpoints.
- `/branch-diff <left-branch-id> <right-branch-id>` compares branch file/cognitive deltas.
- `/branch-merge <left-branch-id> <right-branch-id> [--apply] [--force]` dry-runs by default; `--apply` creates the merged branch and restores merged files. Risky/quarantined/verifier-failed branches require `--force`.
- `/branch-rollback <branch-id> [snapshot-id] [--apply|--yes]` dry-runs by default; applying creates a pre-rollback checkpoint before restoring the target snapshot.

Automatic branch creation remains opt-in with `PI_COGNITIVE_AUTO_BRANCH=1`.

## Recovery

- `rollback(branchId, snapshotId)` restores a branch to a checkpoint.
- `instantRollback(snapshotId)` restores a checkpoint without branch mutation.
- `quarantine(branchId, reason)` isolates failed/corrupt work.
- `recoverCorruption(branchId)` selects the latest valid checkpoint.
- `replay(branchId)` returns checkpoint sequence for deterministic replay/navigation.

## Multi-agent isolation

Agents receive explicit leases with `assignAgent`. Work is marked complete with verifier evidence via `completeAgentWork`; callers should merge only branches whose verifier state passed. Quarantine prevents known-bad work from being selected for rollback navigation or merge policy.

## Example

```js
const { SessionBranchManager } = require("./src/session-branches");
const mgr = new SessionBranchManager({ cwd: process.cwd() });
const base = mgr.createBranch({ type: "verification", name: "main" });
const risky = mgr.autoBranch({ text: "rm -rf generated", entropyScore: 0.2 });
const snap = mgr.checkpoint(risky.id, { verifierState: { ok: true } });
mgr.rollback(risky.id, snap.id);
console.log(mgr.visualizeTree());
```

Run tests:

```bash
node tests/session-branches.test.js
```
