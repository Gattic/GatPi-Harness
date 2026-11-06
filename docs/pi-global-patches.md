# Fork-backed Pi runtime and legacy dist patches

## Current source of truth

The active Pi runtime patches now live in TypeScript source on the [`Gattic/GatPi`](https://github.com/Gattic/GatPi) fork. The expected local checkout and Git configuration are:

```text
~/pi
origin   git@github.com:Gattic/GatPi.git
upstream git@github.com:earendil-works/pi.git
```

`config/pi-fork.env` records both repository identities and branches, the canonical upstream URL, sibling-checkout default, minimum Node version, and the commit that introduced the migrated patches. Override only the checkout location with `PI_SOURCE_ROOT` when needed.

On a machine that already has this harness, pull once to obtain the unified refresh script, then run it:

```bash
cd /path/to/pi-harness
git pull --ff-only origin main
scripts/pi-harness-refresh.sh --pi
```

For a complete Pi, extension, and skill refresh use `scripts/pi-harness-refresh.sh --all`; add `--dry-run` to validate and preview or `--skip-pi-deps` to reuse an already-current Pi `node_modules`. The wrapper validates the configured Git roots, branches, remotes, and clean worktrees before delegating to `scripts/setup-pi-fork.sh`, then runs the full harness gate. If the Pi helper fast-forwards the harness, the wrapper restarts itself at the updated HEAD before continuing.

The lower-level Pi setup script checks required commands, Node/npm and the user-writable global prefix, free disk, repository remotes/branches/cleanliness, remote synchronization, patch ancestry, build outputs, and the active global link. Missing fork checkouts are cloned; existing repositories are fast-forwarded only. Dirty, locally ahead, diverged, misidentified, or detached repositories are refused without stashing or resetting.

The build first runs Pi's `hydrate:model-data` workflow to create the ignored provider JSON required by a fresh checkout, then runs the canonical `build:offline` workflow. This compiles the committed AI catalog sources without rewriting them, validates and copies the hydrated data, and follows Pi's current workspace build order. Hydration requires access to the model-catalog endpoints. Use `scripts/setup-pi-fork.sh --check` for a Pi-only read-only diagnostic. The active `pi` executable must resolve to the fork's `packages/coding-agent/dist/cli.js`, and both checkouts must remain clean and match cached `origin/main`.

The patch files below are retained as a rollback and migration archive for old published npm installs. Direct edits under `$(npm root -g)` are no longer the normal runtime-management workflow because `pi update`, `npm install -g`, or a new dev box can overwrite them.

## Private session source baseline

The fork source now hardens default and custom session directories to `0700` and persisted session files to `0600` across create, rewrite, resume, migration, branch, import, and fork flows. Existing paths are opened without following symlinks, checked as regular files/directories, identity-revalidated, and hardened through the opened descriptor before writes.

The harness retains Runtime Doctor's active-session hardening as a compatibility fallback and provides a bounded one-time historical migration (`scripts/session-hygiene.js --dry-run`, then explicit `--apply`). The migration excludes the active file and refuses truncated or changed-since-preview plans. Ordinary sessions are never automatically deleted or archived.

`PI_FORK_PATCH_COMMIT` in `config/pi-fork.env` pins the verified fork commit that includes the private-session source baseline. Setup and drift checks require the configured source HEAD to contain this commit; never advance the pin to an uncommitted working-tree state.

## Captured patches

The current portable patches are stored in:

- `patches/pi-coding-agent-0.74.1-local.patch`
- `patches/pi-coding-agent-0.74.1-history-upgrade.patch` (incremental upgrade for installs that already had the earlier session/prompt-history hunks applied; also carries guarded post-compaction continuation)
- `patches/pi-tui-0.74.1-local.patch`
- `patches/pi-tui-0.74.1-idle-answer-resize.patch` (incremental upgrade for installs that already had the earlier resize hunk applied)

They capture the local runtime changes found by comparing the global install with the published npm packages for version `0.74.1`.

Summary of captured patch-only changes:

- Disable OSC 133 zone markers around user/assistant messages because some terminals misinterpret them.
- Disable terminal title OSC writes locally because they can break rendering in some terminals.
- Use screen/tmux-safe terminal color detection: do not trust inherited `COLORTERM=truecolor` inside multiplexers; fall back to 256-color or ANSI 16-color escapes unless `PI_COLOR_MODE=truecolor` is set.
- Render markdown code blocks with boxed borders and wrapping.
- Repaint only the visible TUI viewport on terminal resize instead of replaying the full chat history; when Pi is idle, replay from the latest assistant answer through the prompt/footer if that suffix is taller than the viewport, keeping the answer contiguous in scrollback after a resize.
- Keep visible chat scrollback intact when compaction completes; append a compaction marker instead of clearing/rebuilding the active chat view from compacted context.
- Do not silently drop post-compaction auto-continuation: overflow recovery and queued-message continuation now route through a guarded continuation helper that reports failures and falls back to an explicit continuation prompt when the compacted transcript no longer has a valid continuation anchor.
- Rebuild visible chat from the full active session branch on reload/resume/session navigation, while keeping compacted context only for model prompts.
- Rebuild editor prompt history from recent repo sessions plus the full active session branch after chat rebuilds (including `/compact`), preserving pre-compaction prompts, `!`/`!!` bash command history, and in-memory history across session switches.
- Add `/clear` as an alias for `/new` and `/exit` as an alias for `/quit`.
- During prompt history navigation, place the cursor at the start for older/up entries and at the end for newer/down entries so multiline prompts do not require traversing every visual line.

Prompt suggestions/autocomplete is now implemented as a normal extension in `extensions/prompt-suggestions/`, not as a runtime patch.

No local differences were found in `@earendil-works/pi-agent-core` or `@earendil-works/pi-ai` at the time of capture.

## Legacy fallback: apply after installing/updating published Pi

Use this only when the fork checkout cannot be built or linked. From this repo:

```bash
scripts/apply-pi-global-patches.sh
```

The script:

1. Locates the global `@earendil-works/pi-coding-agent` through `npm root -g`.
2. Verifies it is version `0.74.1`.
3. Applies the coding-agent and bundled pi-tui patches idempotently.
4. Detects already-upgraded installs before testing the older all-in-one patch, so idempotent reruns stay quiet; clean installs apply the base local patch and then the history upgrade.
5. If an install is in a mixed state where some files or individual hunks are already patched and others are not, safely reconciles the patch file-by-file and then hunk-by-hunk.
6. If an older install already has the previous pi-tui resize hunk, applies the idle-answer resize upgrade hunk and then verifies the full current pi-tui patch is present.

If Pi is installed somewhere nonstandard:

```bash
PI_ROOT=/path/to/@earendil-works/pi-coding-agent scripts/apply-pi-global-patches.sh
```

Restart Pi or run `/reload` after applying.

## Audit a legacy published global install

To compare a non-linked npm installation against the matching npm tarballs:

```bash
scripts/audit-pi-global-install.sh
```

Diffs are written under:

```text
.pi/audit/global-pi/
```

Use this after future manual experiments to see what changed before deciding whether to update the portable patches.

## Prompt suggestions extension

The prompt suggestion feature runs as a normal Pi extension without patching core runtime files:

```text
extensions/prompt-suggestions/
```

Enable it by adding the extension directory to Pi settings or by symlinking it into an auto-discovered extension location:

```bash
scripts/install-prompt-suggestions-extension.sh
```

Manual equivalent:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/extensions/prompt-suggestions" ~/.pi/agent/extensions/prompt-suggestions
```

Then restart Pi or run `/reload`. The extension replaces the default editor with a `CustomEditor` subclass, shows suggestions adjacent to the prompt area, accepts with Tab, retries/retriggers the empty-prompt suggestion with Ctrl+R, and dismisses with Escape. It shows a deterministic local empty-prompt suggestion first, then optionally asks a separately configured machine-wide Pi model for a background refinement for the same empty-prompt state, with a small `suggesting…` indicator while that request is in flight. Default `auto` mode rate-limits evidence bootstrap and requires the full acceptance/reliability cohort before unrestricted refinement. Ctrl+R starts an explicit fresh attempt while refinement is enabled; status and metadata-only telemetry retain the fixed categorical failure reason. Prompt-suggestion context is capped before regex/render work, and automatic model refinement is skipped after subagent-heavy tool results so critique/research fanout cannot trigger expensive next-step suggestions on the hot path. It can be disabled with:

```bash
PI_PROMPT_SUGGESTIONS=0 pi
```

Model refinement can be disabled while keeping local suggestions with:

```bash
PI_PROMPT_SUGGESTIONS_REFINE=off pi
```

Choose the machine-wide suggestion model with:

```bash
/prompt-suggestions-model provider/modelId
```

Use `/prompt-suggestions` to inspect the active accept/retry keys, refinement policy, configured model, and cached suggestion source.

## Source migration status

The former longer-term recommendation is complete: terminal, renderer, compaction, history, and alias behavior now lives in source commits `0fad388c` and `a11ddb44` on `Gattic/GatPi`. Prompt suggestions remain a normal harness extension. Version-pinned dist patches stay in this repository only as rollback evidence and for machines that cannot use the fork build.

## Sidecar viewport anchoring (2026-07-10)

The combined `pi-tui-0.80.5-local.patch` bottom-anchors short active buffers in `renderVisibleViewport`: when a resize or forced redraw fires while the managed buffer is shorter than the window (tall sidecar terminals during streaming, where completed turns live in scrollback), the repaint previously pinned the conversation to the top rows, blanked the lower half, and erased the visible history. The patch now pads blank rows above the content and models them as a negative viewport top so differential renders stay consistent. Regression-tested by `tests/pi-tui-viewport-anchor.test.js`, which drives the installed engine with a fake terminal and asserts bottom anchoring through resize plus continued streaming.

## Legacy dist-patch port status and readiness check

Check how the patch set fares against a newer Pi release without touching the live install:

```bash
scripts/check-pi-port-readiness.sh [version]   # default: latest
```

It fetches the requested `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` tarballs into a temp dir, runs `git apply --check` for every patch file, and exits with the number of stale patch files.

Archived status from 2026-07-10: **the 0.80.5 dist port was completed and validated offline.** `patches/pi-coding-agent-0.80.5-local.patch`, `patches/pi-coding-agent-0.80.5-history-upgrade.patch` (stacks on local), and `patches/pi-tui-0.80.5-local.patch` (combined — includes the idle-answer-resize behavior, so there is no separate idle patch for 0.80.5+) all apply cleanly to pristine 0.80.5 dists, and the fully patched build passed `--version` plus a real headless model turn from an extracted copy. The apply script derives patch filenames from `PI_PATCH_VERSION` (default pinned at `DEFAULT_EXPECTED_VERSION`).

Legacy fallback runbook (run while Pi is not in use):

```bash
npm install -g @earendil-works/pi-coding-agent@0.80.5
PI_PATCH_VERSION=0.80.5 scripts/apply-pi-global-patches.sh
pi --version
```

`check-pi-drift.sh` intentionally fails in this fallback mode because the harness now requires the linked `Gattic/GatPi` source build as its normal runtime.

Rollback from the linked fork to the last published patched runtime: `npm install -g @earendil-works/pi-coding-agent@0.80.5 && PI_PATCH_VERSION=0.80.5 scripts/apply-pi-global-patches.sh`.
